// ============================================================
// 591 × i智慧 比對 —— Network 攔截版 v0.1
// ============================================================
// 核心差異（相對 OCR 版）：
//   OCR 版：Page.captureScreenshot → 760MB PaddleOCR → 認字 → 解析
//   本  版：Network.enable → 讀「頁面自己收到的那包 JSON」→ 直接用
//
// 對 i智慧 的行為與 OCR 版完全相同：
//   * 零注入腳本（不用 Runtime.evaluate、不用 content script）
//   * 零主動 API 呼叫（不自己發 request，只讀頁面已收到的 response）
//   * manifest 不含 is.ycut.com.tw 的 host_permission
// 差別只在「資料怎麼從已載入的頁面取出來」，伺服器端看到的流量一模一樣。
// ============================================================

import {
  LICENSE_REQUEST_API,
  LICENSE_STATUS_API,
  PRODUCT_ID,
  TRIAL_DAYS,
  TRIAL_STATUS_API
} from './src/config.js';
import { classifyCoreLicenseStatus, readAccountPolicy, ACCOUNT_REQUIRED_MESSAGE } from './src/core-access.js';
import { getDisclaimerAccepted } from './src/disclaimer.js';

// ============ 取得方式設定 ============
// 兩邊各自都有「攔截」與「API」兩條完整實作，這裡決定實際跑哪一條。
//
// 刻意做成程式碼常數、不做成 UI 勾選：這兩條路的產出會影響「要不要下架廣告」，
// 讓使用者隨手切換只會增加誤判的機會。要換就改這裡，重新載入擴充即可。
//
//   ismart: 'intercept' —— 固定用攔截。API 版程式碼保留但無法啟用，
//                          因為 manifest 沒有 is.ycut.com.tw 的 host_permission
//                          （這是本專案的設計前提，見 captureIsmartViaApi 的說明）。
//   s591:   'api'       —— 固定用 API（快、已長期驗證）。
//                          攔截版程式碼保留且隨時可用，改成 'intercept' 就會生效。
const SOURCE_MODE = {
  ismart: 'intercept',  // 'intercept' | 'api'
  s591: 'api'           // 'api' | 'intercept'
};

const ISMART_RE = /^https:\/\/is\.ycut\.com\.tw\//;
const LIST_API_RE = /\/api\/Case\/Circulating\/List/i;

const NEXT_FROM_RIGHT_IMG = 348; // 「下一頁 ›」中心距內容右緣（截圖影像 px）—— 沿用 OCR 版實測值
const MAX_PAGES = 50;
const RESP_TIMEOUT_MS = 15000;

let busy = false;
let abortFlag = false;
let manualSession = null; // 手動模式進行中的 session

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============ 狀態回報 ============

async function setStatus(text, pct) {
  await chrome.storage.local.set({ capStatus: text, capPct: (pct == null ? null : pct) });
}

// ============ 授權 / 試用 / 緊急停止 ============
//
// 所有閘門都放在 service worker，不放 popup。
// popup 只是顯示層，把判斷放在這裡，關掉 popup 或直接發訊息都繞不過去。
//
// 一律即時向伺服器查詢、不吃本機快取，緊急停止才能立刻生效。

const TRIAL_STORAGE_KEY = 'trial_started_at_' + PRODUCT_ID;
const CORE_AUTH_TIMEOUT_MS = 8000;

async function getOrCreateInstallId() {
  const stored = await chrome.storage.local.get(['install_id']);
  if (stored.install_id) return stored.install_id;
  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ install_id: installId });
  return installId;
}

async function getChromeGoogleAccount() {
  if (!chrome.identity || !chrome.identity.getProfileUserInfo) return null;
  return await new Promise((resolve) => {
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
      if (chrome.runtime.lastError || !info || !info.id || !info.email) return resolve(null);
      resolve({ google_sub: info.id, google_email: info.email });
    });
  });
}

async function getTrialInfo(googleAccount, installId, signal) {
  if (googleAccount || installId) {
    const body = { product_id: PRODUCT_ID, install_id: installId };
    if (googleAccount) {
      body.google_sub = googleAccount.google_sub;
      body.google_email = googleAccount.google_email;
    }
    const res = await fetch(TRIAL_STATUS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) throw new Error('Trial status request failed');
    const data = await res.json();
    if (data && data.success) {
      return {
        expiresAt: data.trial_expires_at,
        remainingMs: new Date(data.trial_expires_at || 0).getTime() - Date.now(),
        active: !!data.active
      };
    }
    throw new Error('Invalid trial status response');
  }

  const now = Date.now();
  const stored = await chrome.storage.local.get([TRIAL_STORAGE_KEY]);
  let startedAt = Number(stored[TRIAL_STORAGE_KEY] || 0);
  if (!startedAt) {
    startedAt = now;
    await chrome.storage.local.set({ [TRIAL_STORAGE_KEY]: startedAt });
  }
  const expiresAt = startedAt + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  return { expiresAt, remainingMs: expiresAt - now, active: expiresAt > now };
}

// 回傳 { allowed, mode, message }
// mode: license | trial | emergency_suspended | expired | unavailable
async function checkLiveCoreAccess() {
  const installId = await getOrCreateInstallId();
  // 帳號先拿（本機、零成本），後面套用伺服器下達的綁定政策時才有得判斷
  const googleAccount = await getChromeGoogleAccount();
  const url = LICENSE_STATUS_API +
    '?product_id=' + encodeURIComponent(PRODUCT_ID) +
    '&install_id=' + encodeURIComponent(installId);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CORE_AUTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error('License status request failed');
    const data = await res.json();
    const status = classifyCoreLicenseStatus(data);
    if (status.decision === 'unavailable') throw new Error('Invalid license status response');
    if (status.decision === 'suspended') {
      return { allowed: false, mode: 'emergency_suspended', message: status.message };
    }

    // 帳號綁定政策：伺服器沒送這個欄位就是全部 optional（＝現況）。
    // 存一份給 requestLicenseQr 用，它不會再打一次 license-status。
    const policy = readAccountPolicy(data);
    await chrome.storage.local.set({ account_policy: policy });

    // license: required → 沒登入瀏覽器帳號就什麼都不能做，連 QR 都不給申請
    if (policy.license === 'required' && !googleAccount) {
      return { allowed: false, mode: 'account_required', qrAllowed: false, message: ACCOUNT_REQUIRED_MESSAGE };
    }

    if (status.decision === 'licensed') {
      await chrome.storage.local.set({ license_expires_on: data.expires_on || null });
      return { allowed: true, mode: 'license', message: '授權有效。' };
    }

    // trial: required → 沒帳號不能自助試用，但正式授權仍可申請（QR 照給）
    if (policy.trial === 'required' && !googleAccount) {
      return {
        allowed: false,
        mode: 'account_required',
        qrAllowed: true,
        message: ACCOUNT_REQUIRED_MESSAGE + '\n\n或直接產生 QR Code 申請正式授權。'
      };
    }

    const trial = await getTrialInfo(googleAccount, installId, controller.signal);
    if (trial.active) {
      const days = Math.max(0, Math.ceil(trial.remainingMs / 86400000));
      return { allowed: true, mode: 'trial', message: `試用中，剩餘約 ${days} 天。` };
    }
    return {
      allowed: false,
      mode: 'expired',
      message: data.reason === 'expired'
        ? `授權已於 ${data.expires_on || '設定期限'} 到期，請重新產生 QR Code 授權。`
        : '請產生 QR Code 並請管理員核准。'
    };
  } catch (e) {
    // fail closed：查不到就擋。網路不穩會誤擋，但總比停用後還能跑好。
    return { allowed: false, mode: 'unavailable', message: '目前無法確認授權狀態，請稍後再試。' };
  } finally {
    clearTimeout(timeoutId);
  }
}

// 核心功能的閘門。每次都重新驗，不做快取。
async function assertCoreAccess() {
  const access = await checkLiveCoreAccess();
  if (!access.allowed) {
    await chrome.storage.local.set({
      capError: access.message,
      capStatus: access.mode === 'emergency_suspended' ? '已被系統管理員停用' : '需要授權'
    });
  }
  return access;
}

// ---- 使用須知 ----
// 與授權閘門一樣放在背景，popup 繞不過去。
// 未同意時直接把須知頁開起來，不是只丟一句錯誤訊息。

async function openDisclaimerPage() {
  const disclaimerUrl = chrome.runtime.getURL('disclaimer.html');
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) =>
    Number.isInteger(t.id) && String(t.url || '').split('?')[0] === disclaimerUrl);

  if (existing) {
    if (Number.isInteger(existing.windowId)) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  await chrome.tabs.create({ url: disclaimerUrl });
}

async function assertDisclaimer() {
  if (await getDisclaimerAccepted()) return true;
  await chrome.storage.local.set({
    capError: '請先閱讀並同意使用須知，才能開始比對。',
    capStatus: '尚未同意使用須知'
  });
  await openDisclaimerPage();
  return false;
}

async function requestLicenseQr() {
  const installId = await getOrCreateInstallId();
  const googleAccount = await getChromeGoogleAccount();

  // 政策要求正式授權必須綁帳號時，沒帳號就不送申請。
  // 政策來自最近一次 license-status（checkLiveCoreAccess 存的）；沒存過＝optional。
  const stored = await chrome.storage.local.get(['account_policy']);
  const policy = readAccountPolicy({ account_policy: stored.account_policy });
  if (policy.license === 'required' && !googleAccount) {
    throw new Error(ACCOUNT_REQUIRED_MESSAGE);
  }

  const body = { install_id: installId, product_id: PRODUCT_ID };
  if (googleAccount) {
    body.google_sub = googleAccount.google_sub;
    body.google_email = googleAccount.google_email;
  }
  const res = await fetch(LICENSE_REQUEST_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!data || !data.success) throw new Error(data?.message || 'QR Code 產生失敗。');
  return {
    ok: true,
    approveUrl: data.telegram_url || data.approve_url,
    requestId: data.request_id || '',
    installId,
    googleEmail: googleAccount?.google_email || ''
  };
}

// ============ CDP 基礎 ============

function sendCmd(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(method + ': ' + err.message));
      resolve(res || {});
    });
  });
}

function attach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error('無法附加偵錯工具：' + err.message));
      resolve();
    });
  });
}

function detach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => { void chrome.runtime.lastError; resolve(); });
  });
}

async function getMetrics(target) {
  const m = await sendCmd(target, 'Page.getLayoutMetrics');
  const c = m.cssContentSize || m.contentSize;
  const v = m.cssVisualViewport || m.visualViewport;
  return { cw: c.width, ch: c.height, vw: v.clientWidth, vh: v.clientHeight, pageY: v.pageY };
}

async function wheelBy(target, x, y, deltaY) {
  await sendCmd(target, 'Input.dispatchMouseEvent',
    { type: 'mouseWheel', x, y, deltaX: 0, deltaY, pointerType: 'mouse' });
}

// 點擊。press 與 release 之間不留間隔，這件事比看起來重要。
//
// 這裡點的是「下一頁」按鈕，按下去會立刻觸發換頁。原本 press 與 release
// 之間隔了 70ms，剛好夾在換頁過程中，造成兩個問題：
//   1. release 落在已經更新的文件上 → 這次點擊不算完整的 click → 頁面沒翻
//   2. 舊文件停在「左鍵還按著」的狀態 → 下一輪的 mouseMoved 變成拖曳
//      → 從上次座標一路選到這次座標，畫面整片反白
// 舊做法點的是頁碼輸入框，點下去不會換頁，所以看不出這個問題。
async function clickAt(target, x, y) {
  // 補一次 release：清掉上一次可能卡住的按鍵狀態。
  // 沒有按下時多送一次放開是無害的。
  await sendCmd(target, 'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
    .catch(() => {});

  await sendCmd(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' });
  await sleep(60);
  await sendCmd(target, 'Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  // 不要 sleep：一旦換頁在這中間發生，這次點擊就廢了
  await sendCmd(target, 'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}

// 註：這裡刻意不提供發送鍵盤事件的工具函式。
// 翻頁一律用滑鼠點「下一頁 ›」，見 clickNextPage() 的說明——
// 送鍵盤組合鍵（尤其 Ctrl+A）在焦點跑掉時會全選整個網頁，破壞翻頁流程。

// ============ 翻頁（沿用 OCR 版已驗證的做法，純 Input 事件，不注入腳本）============

// 直接把 base64 轉成 Blob 解碼。
// 不要用 fetch('data:...')：那會受 manifest 的 connect-src 管制，
// 沒把 data: 列進白名單就會丟出 "Failed to fetch"。
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function decodeShot(b64) {
  const blob = new Blob([b64ToBytes(b64)], { type: 'image/png' });
  return await createImageBitmap(blob);
}

// 在畫面底部那條 74px 的帶狀區找「›」的深色像素叢，用來定位頁碼輸入框。
// 只掃一條細帶，成本遠低於 OCR（毫秒級）。bmp 由呼叫端提供，這裡負責關閉。
async function findNext(bmp, dpr) {
  const iw = bmp.width, ih = bmp.height;
  const yTop = Math.max(0, ih - Math.round(74 * dpr));
  const yBot = ih - Math.round(20 * dpr);
  const bh = Math.max(1, yBot - yTop);
  const cnv = new OffscreenCanvas(iw, bh);
  const ctx = cnv.getContext('2d');
  ctx.drawImage(bmp, 0, yTop, iw, bh, 0, 0, iw, bh);
  bmp.close();
  const d = ctx.getImageData(0, 0, iw, bh).data;
  const x0 = Math.round(iw * 0.60);
  const colCnt = new Float64Array(iw), colY = new Float64Array(iw);
  for (let y = 0; y < bh; y++) {
    for (let x = x0; x < iw; x++) {
      const i = (y * iw + x) * 4;
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (g < 120) { colCnt[x]++; colY[x] += y; }
    }
  }
  const gap = Math.round(10 * dpr);
  const clusters = []; let s = -1, lastX = -1;
  for (let x = x0; x < iw; x++) {
    if (colCnt[x] > 0) { if (s < 0) s = x; lastX = x; }
    else if (s >= 0 && x - lastX > gap) { clusters.push([s, lastX]); s = -1; }
  }
  if (s >= 0) clusters.push([s, lastX]);

  const cxGuess = iw - Math.round(NEXT_FROM_RIGHT_IMG * dpr);
  const tol = Math.round(22 * dpr);
  let best = null, bestD = 1e9;
  for (const [a, b] of clusters) {
    let cnt = 0, ysum = 0, xsum = 0;
    for (let x = a; x <= b; x++) { cnt += colCnt[x]; ysum += colY[x]; xsum += colCnt[x] * x; }
    if (cnt < 3) continue;
    const cx = xsum / cnt, dist = Math.abs(cx - cxGuess);
    if (dist <= tol && dist < bestD) { bestD = dist; best = { cx, cyImg: yTop + ysum / cnt }; }
  }
  if (!best) return { disabled: true };
  return { xCss: best.cx / dpr, yCss: best.cyImg / dpr };
}

// 用 CDP 的 DOM 網域直接問「下一頁」按鈕的位置。
//
// 這是唯讀檢視，等同 DevTools 的 Elements 面板——不會在頁面裡執行任何 JS，
// 所以仍然符合本專案「不注入腳本」的前提（Runtime.evaluate 才是執行程式碼，
// 這裡用的是 DOM.querySelector / DOM.getBoxModel）。
//
// 比像素搜尋可靠得多：不受視窗寬度、縮放比例、版面微調影響。
// 像素法那個寫死的 348px 偏移是從 OCR 版搬來的，只在特定視窗尺寸下成立。
const NEXT_SELECTORS = [
  'button.btn-next',
  '.el-pagination button.btn-next',
  '.el-pagination .btn-next',
  '.pagination .next',
  'li.next > a',
  'a.next',
  '[aria-label="下一頁"]',
  '[title="下一頁"]',
  '[aria-label="Next"]',
  '[aria-label="next page"]'
];

function isDisabledAttrs(attributes) {
  for (let i = 0; i < (attributes || []).length; i += 2) {
    const k = attributes[i];
    const v = String(attributes[i + 1] || '');
    if (k === 'disabled') return true;
    if (k === 'aria-disabled' && v === 'true') return true;
    if (k === 'class' && /(^|\s)(is-disabled|disabled)(\s|$)/.test(v)) return true;
  }
  return false;
}

async function findNextByDom(target) {
  try {
    await sendCmd(target, 'DOM.enable');
    const doc = await sendCmd(target, 'DOM.getDocument', { depth: 1 });
    const rootId = doc && doc.root && doc.root.nodeId;
    if (!rootId) return null;

    const m = await getMetrics(target);

    for (const selector of NEXT_SELECTORS) {
      let nodeId = 0;
      try {
        const r = await sendCmd(target, 'DOM.querySelector', { nodeId: rootId, selector });
        nodeId = (r && r.nodeId) || 0;
      } catch (e) { continue; }
      if (!nodeId) continue;

      let disabled = false;
      try {
        const r = await sendCmd(target, 'DOM.getAttributes', { nodeId });
        disabled = isDisabledAttrs(r && r.attributes);
      } catch (e) {}

      let model = null;
      try {
        const r = await sendCmd(target, 'DOM.getBoxModel', { nodeId });
        model = r && r.model;
      } catch (e) { continue; } // display:none 之類會丟錯，換下一個選擇器
      const q = model && model.content;
      if (!q || q.length < 8 || !(model.width > 0) || !(model.height > 0)) continue;

      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      const cx = Math.round((Math.min(...xs) + Math.max(...xs)) / 2);
      const cyRaw = Math.round((Math.min(...ys) + Math.max(...ys)) / 2);

      // getBoxModel 的座標基準在不同 Chrome 版本有差異（文件座標 vs 視埠座標），
      // 而 Input.dispatchMouseEvent 要的是視埠座標。
      // 用「換算後必須落在視埠內」來判斷要不要扣掉捲動位移，不用猜。
      let cy = cyRaw;
      if (cy < 0 || cy > m.vh) {
        const shifted = cyRaw - (m.pageY || 0);
        if (shifted >= 0 && shifted <= m.vh) cy = shifted;
      }
      if (cx < 0 || cx > m.vw || cy < 0 || cy > m.vh) continue; // 不在畫面上

      return { x: cx, y: cy, disabled, selector };
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function scrollToBottom(target) {
  for (let k = 0; k < 8; k++) {
    if (abortFlag) break;
    const m = await getMetrics(target);
    if (m.pageY >= m.ch - m.vh - 2) break;
    await wheelBy(target, Math.round(m.vw / 2), Math.round(m.vh / 2), m.ch + 6000);
    await sleep(400);
  }
  await sleep(300);
}

// 捲到底 → 找「下一頁 ›」→ 點它。回傳 false 代表「›」已變灰＝最後一頁。
//
// 舊做法是「點頁碼輸入框 → Ctrl+A → 打頁碼 → Enter」，但輸入框的位置是
// 從「›」再往左推 167px 猜出來的，兩層猜測疊在一起。只要點擊偏掉，
// 焦點就留在 document 上，Ctrl+A 於是變成「全選整個網頁」（畫面整片反白），
// 後續打的頁碼沒有落點 → 翻頁其實沒發生，但程式以為翻了 → 資料重複或缺頁。
//
// 直接點「›」可以同時解掉三件事：
//   1. 少一層位置猜測（不再需要那個 167px 的偏移）
//   2. 完全不需要 Ctrl+A，全選整頁的狀況不可能再發生
//   3. 失敗模式變安全：點偏了只是「沒反應」，不會亂改頁面狀態
// 翻頁用了哪一種定位方式，寫進 storage 供診斷用
let lastPagingMethod = '';

async function clickNextPage(target) {
  await scrollToBottom(target);

  // 先問 DOM（精確、與視窗尺寸無關）
  const dom = await findNextByDom(target);
  if (dom) {
    lastPagingMethod = 'DOM ' + dom.selector + (dom.disabled ? '（已停用＝最後一頁）' : '');
    await chrome.storage.local.set({ pagingMethod: lastPagingMethod });
    if (dom.disabled) return false;
    await clickAt(target, dom.x, dom.y);
    return true;
  }

  // DOM 找不到才退回像素搜尋（原本的做法，靠寫死的偏移量猜位置）
  const vp = await sendCmd(target, 'Page.captureScreenshot',
    { format: 'png', captureBeyondViewport: false, fromSurface: true });
  const bmp = await decodeShot(vp.data);
  const m = await getMetrics(target);
  // 截圖是視埠，所以基準要用 clientWidth，不是整份文件的寬度
  const dpr = bmp.width / (m.vw || m.cw);

  const found = await findNext(bmp, dpr); // findNext 會關掉 bmp
  lastPagingMethod = '像素搜尋' + (!found || found.disabled ? '（找不到「›」）' : '');
  await chrome.storage.local.set({ pagingMethod: lastPagingMethod });
  if (!found || found.disabled) return false;

  await clickAt(target, Math.round(found.xCss), Math.round(found.yCss));
  return true;
}

// ============ 核心：Network 攔截 ============

// 明細頁網址用的是 UUID（例：/is/case/detail/03331b9e-2399-4a92-88f8-c9907695ee63）。
// 這顆 UUID 在 i智慧 回應裡的欄位名不一定叫 caseKey，這裡從常見欄位名挑出
// 第一個「長得像 UUID」的值；再退而求其次掃含 case 的欄位；都沒有才回傳 caseKey 原值。
function pickCaseKey(c) {
  const isUuid = (v) => typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const cands = [c.caseKey, c.caseId, c.caseGuid, c.caseUuid, c.caseUid, c.guid, c.uuid, c.hashId, c.encryptId, c.id];
  for (const v of cands) if (isUuid(v)) return v;
  for (const k in c) if (/case/i.test(k) && isUuid(c[k])) return c[k];
  return c.caseKey || '';
}

function mapCase(c) {
  const isLand = (c.useCodeName === '土地') || (!c.buiTotPin && !c.buiMPin);
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  return {
    code: String(c.caseNoNumber || ''),
    caseKey: pickCaseKey(c),
    community: c.buildingName || '',
    price: num(c.totPrice),
    area: num(isLand ? (c.landShPin || c.buiTotPin) : c.buiTotPin),
    area2: num(c.buiMPin),
    floor: num(c.floorSt || c.upFloor),
    rooms: num(c.rm),
    isLand,
    use: c.useCodeName || '',
    status: c.statusName || c.caseStatusName || c.statusDesc || '',
    storeCode: c.storeCode || ''
  };
}

function pickTotal(data) {
  if (!data || typeof data !== 'object') return 0;
  for (const k of ['total', 'totalCount', 'count', 'totalRecords', 'recordCount', 'totalNum']) {
    const v = Number(data[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}

// 建立一個攔截 session：掛上 onEvent，收集 caseList。
// 回傳的物件可查目前進度，並在結束時 stop()。
const ISMART_SPEC = {
  urlRe: LIST_API_RE,
  pickList: (d) => (d && (d.caseList || d.list || d.items)) || [],
  mapRow: mapCase,
  storeKeys: { rows: 'ismartRows', total: 'ismartTotal', raw: 'ismartRaw', envelope: 'ismartEnvelopeKeys' }
};

// ---- 591 攔截用 ----
const S591_PAGE_URL = 'https://user.591.com.tw/ware/open';
const S591_LIST_RE = /bff-user\.591\.com\.tw\/v1\/ware\/open/i;
const S591_MAX_PAGES = 30;

// 與注入版 api591() 的欄位對應完全一致，確保兩種模式產出的資料可直接互比
function map591(it) {
  let fn = 0;
  const fm = String(it.floor || '').match(/(-?\d+)/);
  if (fm) fn = parseInt(fm[1]);
  return {
    code: 'S' + it.id,
    postId: it.id,
    title: it.title || '',
    community: (it.community && it.community.name) || '',
    price: parseInt(it.price) || 0,
    area: parseFloat(it.area) || 0,
    floor: fn,
    kind: it.kind_txt || '',
    isLand: (it.kind_txt === '土地')
  };
}

const S591_SPEC = {
  urlRe: S591_LIST_RE,
  pickList: (d) => (d && (d.items || d.list)) || [],
  mapRow: map591,
  storeKeys: { rows: 's591Rows', total: 's591Total', raw: 's591Raw', envelope: 's591EnvelopeKeys' }
};

// spec = { urlRe, pickList, mapRow, storeKeys }
//   urlRe     哪些回應要收
//   pickList  從 data 取出陣列
//   mapRow    單筆原始物件 → 內部格式
//   storeKeys storage 的欄位名（rows / total / raw / envelope），用來逐頁落地
function createCollector(target, spec) {
  const byCode = new Map();
  const wanted = new Set();
  let total = 0;
  let responses = 0;   // 已成功解析的回應數
  let rawSample = null;
  let envelopeKeys = [];
  let pending = 0;

  async function readBody(requestId) {
    pending++;
    try {
      const r = await sendCmd(target, 'Network.getResponseBody', { requestId });
      let text = r.body;
      if (r.base64Encoded) {
        const bytes = Uint8Array.from(atob(r.body), (ch) => ch.charCodeAt(0));
        text = new TextDecoder('utf-8').decode(bytes);
      }
      const json = JSON.parse(text);
      const data = json && json.data;
      const list = spec.pickList(data) || [];
      if (!rawSample && list.length) {
        // 保留第一筆原始物件 + 外層欄位名，方便核對欄位對應（診斷用）
        rawSample = list[0];
        envelopeKeys = data && typeof data === 'object' ? Object.keys(data) : [];
      }
      const t = pickTotal(data);
      if (t) total = t;
      for (const c of list) {
        const row = spec.mapRow(c);
        if (row && row.code) byCode.set(row.code, row);
      }
      responses++;
      // 逐頁落地：service worker 若在中途被回收，已收到的資料不會消失
      const k = spec.storeKeys;
      chrome.storage.local.set({
        [k.rows]: [...byCode.values()],
        [k.total]: total,
        [k.raw]: rawSample,
        [k.envelope]: envelopeKeys
      });
    } catch (e) {
      // response body 可能已被 buffer 淘汰；記下來但不中斷整場擷取
      console.warn('[capture] 讀取回應失敗', requestId, e && e.message);
    } finally {
      pending--;
    }
  }

  function onEvent(source, method, params) {
    if (!source || source.tabId !== target.tabId) return;
    if (method === 'Network.responseReceived') {
      if (spec.urlRe.test((params.response && params.response.url) || '')) {
        wanted.add(params.requestId);
      }
    } else if (method === 'Network.loadingFinished') {
      if (wanted.has(params.requestId)) {
        wanted.delete(params.requestId);
        readBody(params.requestId);
      }
    } else if (method === 'Network.loadingFailed') {
      wanted.delete(params.requestId);
    }
  }

  chrome.debugger.onEvent.addListener(onEvent);

  return {
    get count() { return byCode.size; },
    get total() { return total; },
    get responses() { return responses; },
    get rows() { return [...byCode.values()]; },
    get rawSample() { return rawSample; },
    get envelopeKeys() { return envelopeKeys; },
    async settle(ms = 1200) {
      // 等仍在讀取中的 body 收完
      const until = Date.now() + ms;
      while (pending > 0 && Date.now() < until) await sleep(80);
    },
    stop() { chrome.debugger.onEvent.removeListener(onEvent); }
  };
}

// 等到 collector 的回應數超過 baseline（代表新的一頁進來了）
async function waitForResponse(col, baseline, timeoutMs = RESP_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (abortFlag) return false;
    if (col.responses > baseline) { await col.settle(600); return true; }
    await sleep(150);
  }
  return false;
}

async function requireIsmartTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !ISMART_RE.test(tab.url || '')) {
    throw new Error('請先切到 i智慧 (is.ycut.com.tw) 的「關注物件」分頁，再按這顆按鈕。');
  }
  return tab;
}

// 自動模式：reload 觸發第 1 頁 → 依 total 逐頁翻，直到收滿
async function captureIsmartAuto() {
  const tab = await requireIsmartTab();
  const target = { tabId: tab.id };
  let col = null;

  await attach(target);
  try {
    await sendCmd(target, 'Page.enable');
    await sendCmd(target, 'Network.enable');
    col = createCollector(target, ISMART_SPEC);

    // 重新載入，確保第 1 頁的請求一定被我們收到
    // （Network.enable 之前發生的請求拿不到 body）
    await setStatus('重新載入頁面，等待第 1 頁資料…');
    await sendCmd(target, 'Page.reload', { ignoreCache: false });

    if (!await waitForResponse(col, 0, 25000)) {
      throw new Error('等不到 i智慧 的關注清單回應。請確認目前停在「關注物件」清單頁且已登入，然後再試一次。');
    }
    await setStatus(`已讀 ${col.count}${col.total ? ' / ' + col.total : ''} 筆…`);

    let page = 1;
    let noGain = 0;
    while (page < MAX_PAGES) {
      if (abortFlag) break;
      if (col.total && col.count >= col.total) break;

      const before = col.count;
      const respBefore = col.responses;
      page++;
      await setStatus(`翻到第 ${page} 頁…（已讀 ${col.count}${col.total ? ' / ' + col.total : ''} 筆）`,
        col.total ? Math.round(col.count / col.total * 100) : null);

      // 翻頁失敗不要把已經攔到的資料一起丟掉：停在這裡收工，
      // 讓使用者可以改用手動模式補齊，或直接看目前這批。
      try {
        const moved = await clickNextPage(target);
        if (!moved) {
          // 「›」變灰通常就是最後一頁；但若筆數還沒收滿，那是找不到按鈕，
          // 兩者結果不同，必須講清楚，否則使用者會以為資料是完整的。
          if (col.total && col.count < col.total) {
            await setStatus(`找不到「下一頁」按鈕，目前只讀到 ${col.count} / ${col.total} 筆。`
              + '請改用「手動擷取」補齊（報表不會出，以免誤判下架）。');
          }
          break;
        }
      } catch (e) {
        await setStatus(`自動翻頁在第 ${page} 頁失敗（${(e && e.message) || e}）。`
          + `已攔到 ${col.count} 筆，請改用「手動擷取」補齊。`);
        break;
      }

      const got = await waitForResponse(col, respBefore);
      if (!got || col.count === before) {
        noGain++;
        if (noGain >= 2) break; // 連兩次沒有新資料 = 已到最後一頁
      } else {
        noGain = 0;
      }
    }

    await col.settle(1500);
    return finishCapture(col);
  } finally {
    if (col) col.stop();
    await detach(target);
  }
}

// 手動模式：只掛攔截，翻頁交給使用者，按「完成」才收工
async function startManualCapture() {
  const tab = await requireIsmartTab();
  const target = { tabId: tab.id };
  await attach(target);
  await sendCmd(target, 'Page.enable');
  await sendCmd(target, 'Network.enable');
  const col = createCollector(target, ISMART_SPEC);

  // MV3 的 service worker 閒置約 30 秒就會被回收，回收後 onEvent 監聽器一併消失，
  // 使用者接下來翻的頁就收不到了。手動模式期間用輕量心跳把它撐住。
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, 20000);
  manualSession = { target, col, keepAlive };

  await setStatus('手動模式：請自己翻頁，每翻一頁就會自動收進來。翻完後按「完成擷取」。');

  // 讓使用者不必先 reload：若目前這頁的資料還沒被收到，提示他重新整理或翻一次頁
  return { ok: true };
}

async function stopManualCapture() {
  if (!manualSession) throw new Error('目前沒有進行中的手動擷取。');
  const { target, col, keepAlive } = manualSession;
  manualSession = null;
  if (keepAlive) clearInterval(keepAlive);
  try {
    await col.settle(1500);
    return finishCapture(col);
  } finally {
    col.stop();
    await detach(target);
  }
}

async function finishCapture(col) {
  const rows = col.rows;
  if (!rows.length) {
    throw new Error('沒有攔截到任何關注物件資料。可能是：(1) 目前不在關注清單頁；(2) 頁面資料在開始攔截前就載入完了 —— 請重新整理該分頁後再試。');
  }
  await chrome.storage.local.set({
    ismartRows: rows,
    ismartTotal: col.total,
    ismartRaw: col.rawSample,
    ismartEnvelopeKeys: col.envelopeKeys,
    lastCaptureAt: Date.now(),
    capStatus: `擷取完成：${rows.length} 筆${col.total ? '（i智慧 共 ' + col.total + '）' : '（未讀到總筆數，無法確認是否收齊）'}`,
    capError: ''
  });
  return { ok: true, count: rows.length, total: col.total };
}

// ============ i智慧 API 路徑（保留但未啟用）============
//
// 這是 AdMirror 原本的做法：注入腳本到 i智慧 分頁，用頁面的 session 直接呼叫
// 內部 API。速度最快（幾秒抓完全部），但這正是伺服器管理員不同意的做法——
// 它會在幾秒內連發約 20 次 take:100 的請求，而前端 UI 根本給不出 take:100，
// 在 server log 上一眼就看得出不是真人操作。
//
// 保留在這裡是為了萬一哪天取得許可、或攔截路徑失效時可以立刻切換。
// ★ 目前無法啟用：manifest 刻意不含 is.ycut.com.tw 的 host_permission，
//   所以 executeScript 會被 Chrome 擋下。要啟用必須同時：
//     1. SOURCE_MODE.ismart 改成 'api'
//     2. manifest.json 的 host_permissions 加入 "https://is.ycut.com.tw/*"
//   兩者缺一不可——這是刻意的，避免有人只改一個地方就悄悄啟用了它。

function ismartApi() {
  return (async function () {
    let userStoreCode = '';
    try {
      const uRes = await fetch('https://is.ycut.com.tw/api/user', {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json, text/plain, */*', 'websiteName': 'IntegrationService_WS' }
      });
      const uJson = await uRes.json();
      if (uJson.status === 'Success' && uJson.data) userStoreCode = uJson.data.departmentId || '';
    } catch (e) {}

    const raw = [];
    let total = 0;
    for (let skip = 0; skip < 2000; skip += 100) {
      const res = await fetch('https://is.ycut.com.tw/api/Case/Circulating/List', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'websiteName': 'IntegrationService_WS'
        },
        body: JSON.stringify({
          condition: { mode: 'F' },
          page: { skip: skip, take: 100, descending: false, order: 'A' }
        })
      });
      const json = await res.json();
      if (json.status !== 'Success' || !json.data) {
        return { error: 'i智慧 API: ' + (json.status || 'unknown') };
      }
      if (json.data.total) total = json.data.total;
      const list = json.data.caseList || [];
      // 回傳原始物件，欄位對應交給背景的 mapCase()，維持單一來源
      for (const c of list) raw.push(c);
      if (list.length < 100) break;
    }
    return { raw, total, userStoreCode };
  })();
}

async function captureIsmartViaApi() {
  await setStatus('開啟 i智慧 背景分頁（API 模式）…');
  const tab = await chrome.tabs.create({
    url: 'https://is.ycut.com.tw/is/case/search/watch-list', active: false
  });
  try {
    await waitTab(tab.id);
    await sleep(1500);
    const r = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: ismartApi, world: 'MAIN'
    });
    const out = r && r[0] && r[0].result;
    if (!out || out.error) throw new Error((out && out.error) || 'i智慧 API 回傳空');

    const rows = [];
    const seen = new Set();
    for (const c of out.raw || []) {
      const row = mapCase(c);
      if (row.code && !seen.has(row.code)) { seen.add(row.code); rows.push(row); }
    }
    if (!rows.length) throw new Error('i智慧 API 沒有回傳任何關注物件。');

    await chrome.storage.local.set({
      ismartRows: rows,
      ismartTotal: out.total || 0,
      ismartRaw: (out.raw || [])[0] || null,
      lastCaptureAt: Date.now(),
      capStatus: `擷取完成（API 模式）：${rows.length} 筆`,
      capError: ''
    });
    return { ok: true, count: rows.length, total: out.total || 0 };
  } finally {
    chrome.tabs.remove(tab.id).catch(function () {});
  }
}

// i智慧 取得方式的分派點
async function captureIsmart() {
  if (SOURCE_MODE.ismart === 'api') return await captureIsmartViaApi();
  return await captureIsmartAuto();
}

// ============ 591（API 為現行路徑，攔截路徑保留備用）============

function api591() {
  return (async function () {
    function getCookie(name) {
      const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
      return m ? m[1] : null;
    }
    const accessToken = getCookie('tw591__access_token');
    const deviceid = getCookie('T591_TOKEN') || getCookie('__one_id__') || 'pc_default_id';
    if (!accessToken) return { error: '591 未登入' };
    const all = [];
    for (let page = 1; page <= 50; page++) {
      const res = await fetch('https://bff-user.591.com.tw/v1/ware/open', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'device': 'pc', 'deviceid': deviceid, 'access-token': accessToken },
        body: JSON.stringify({ device: 'pc', deviceid: deviceid, current_page: page, page_size: 50, type: 2 })
      });
      const json = await res.json();
      if (json.status !== 1) return { error: '591 API: ' + (json.msg || 'unknown') };
      const items = (json.data && json.data.items) || [];
      for (const it of items) {
        let fn = 0; const fm = String(it.floor || '').match(/(-?\d+)/); if (fm) fn = parseInt(fm[1]);
        all.push({
          code: 'S' + it.id, postId: it.id, title: it.title || '',
          community: (it.community && it.community.name) || '',
          price: parseInt(it.price) || 0, area: parseFloat(it.area) || 0, floor: fn,
          kind: it.kind_txt || '', isLand: (it.kind_txt === '土地')
        });
      }
      if (items.length < 50) break;
    }
    return all;
  })();
}

function waitTab(tabId) {
  return new Promise((resolve) => {
    function chk() {
      chrome.tabs.get(tabId, (t) => {
        if (chrome.runtime.lastError) return resolve();
        if (t && t.status === 'complete') resolve(); else setTimeout(chk, 300);
      });
    }
    chk();
  });
}

// 591 攔截模式：不注入腳本、不自己發 request。
// 591 是用網址參數翻頁（?current=N），所以不需要 i智慧 那套像素定位 + 模擬鍵鼠，
// 只要導頁，讓頁面自己去要資料，我們在旁邊抄一份。
async function capture591ViaNetwork() {
  await setStatus('開啟 591 分頁（攔截模式）…');
  const tab = await chrome.tabs.create({ url: S591_PAGE_URL, active: false });
  const target = { tabId: tab.id };
  let col = null;
  try {
    await waitTab(tab.id);
    await attach(target);
    await sendCmd(target, 'Page.enable');
    await sendCmd(target, 'Network.enable');
    col = createCollector(target, S591_SPEC);

    // Network.enable 之前發生的請求拿不到 body → 重新載入，確保第 1 頁被收到
    await sendCmd(target, 'Page.reload', { ignoreCache: false });
    if (!await waitForResponse(col, 0, 25000)) {
      throw new Error('等不到 591 的刊登清單回應。請確認 Chrome 已登入 591 會員中心，然後再試一次。');
    }
    await setStatus(`591 攔截：已讀 ${col.count}${col.total ? ' / ' + col.total : ''} 筆…`);

    let page = 1, noGain = 0;
    while (page < S591_MAX_PAGES) {
      if (abortFlag) break;
      if (col.total && col.count >= col.total) break;

      const before = col.count;
      const respBefore = col.responses;
      page++;

      // 導頁會清掉前一頁的 network buffer，所以一定要先把 body 收完再走
      await col.settle(1500);
      await setStatus(`591 攔截：翻到第 ${page} 頁…（已讀 ${col.count}${col.total ? ' / ' + col.total : ''} 筆）`);
      await chrome.tabs.update(tab.id, { url: S591_PAGE_URL + '?current=' + page });
      await waitTab(tab.id);

      const got = await waitForResponse(col, respBefore);
      if (!got || col.count === before) {
        noGain++;
        if (noGain >= 2) break;
      } else {
        noGain = 0;
      }
    }

    await col.settle(1500);
    const rows = col.rows;
    if (!rows.length) {
      throw new Error('591 攔截不到任何刊登資料。可能是未登入，或 591 換了清單端點。');
    }
    await chrome.storage.local.set({ s591CaptureAt: Date.now() });
    return rows;
  } finally {
    if (col) col.stop();
    await detach(target);
    chrome.tabs.remove(tab.id).catch(function () {});
  }
}

// 591 取得方式的分派點
async function get591Ads() {
  if (SOURCE_MODE.s591 === 'intercept') return await capture591ViaNetwork();
  return await scrape591();
}

async function scrape591() {
  await setStatus('開啟 591 背景分頁抓廣告…');
  const tab = await chrome.tabs.create({ url: 'https://user.591.com.tw/ware/open', active: false });
  try {
    await waitTab(tab.id);
    await sleep(1500);
    const r = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: api591, world: 'MAIN' });
    const result = r && r[0] && r[0].result;
    if (result && !result.error && Array.isArray(result)) return result;
    throw new Error((result && result.error) || '591 回傳異常');
  } finally {
    chrome.tabs.remove(tab.id).catch(function () {});
  }
}

// ============ 配對邏輯（沿用 OCR 版）============

function normalizeName(s) {
  if (!s) return '';
  let n = s.toUpperCase().replace(/大廈|華廈|社區|\(|\)|（|）|\/|・|·|\s|　/g, '');
  n = n.replace(/(北|南|東|西|中|前|後)區$/, '').replace(/第?[一二三四五六七八九十0-9]+期$/, '')
    .replace(/NO\.?\d+$/i, '').replace(/[A-Z]棟$/, '').replace(/[A-Z]區$/, '').replace(/\d+$/, '');
  return n;
}

function extractPhaseKey(s) {
  if (!s) return '';
  const up = String(s).toUpperCase();
  let m = up.match(/NO\.?(\d+)/i); if (m) return 'N' + m[1];
  m = up.match(/第?([一二三四五六七八九十]+)期/);
  if (m) { const mp = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 }; return 'P' + (mp[m[1]] || m[1]); }
  m = up.match(/第?(\d+)期/); if (m) return 'P' + m[1];
  return '';
}

const MATCH_THRESHOLD = 130;

function scorePair(ad, w) {
  const adN = normalizeName(ad.community), adPhase = extractPhaseKey(ad.community);
  const wRaw = (w.community || '').split('/')[0];
  const wN = normalizeName(wRaw), wPhase = extractPhaseKey(wRaw);
  let score = 0;
  if (adN && wN) {
    if (adN === wN) score += 100;
    else if (adN.indexOf(wN) >= 0 || wN.indexOf(adN) >= 0) score += 70;
    else {
      let common = 0; const seen = {};
      for (let k = 0; k < adN.length; k++) { if (!seen[adN[k]] && wN.indexOf(adN[k]) >= 0) { seen[adN[k]] = 1; common++; } }
      if (common >= 2) score += common * 5;
    }
  }
  const priceExact = (w.price === ad.price);
  if (priceExact) score += 100;
  else if (Math.abs(w.price - ad.price) <= 2) score += 60;
  else if (Math.abs(w.price - ad.price) / Math.max(w.price, 1) <= 0.05) score += 30;

  const areaCands = [w.area, w.area2].filter((v) => v);
  let areaDiff = Infinity;
  for (const wa of areaCands) { if (ad.area) areaDiff = Math.min(areaDiff, Math.abs(ad.area - wa)); }
  if (areaDiff <= 1) score += 60; else if (areaDiff <= 3) score += 35;

  const numericIdentical = priceExact && ad.area && areaDiff < 0.01;
  if (numericIdentical) score += 50;

  if (!ad.isLand && !w.isLand && ad.floor && w.floor) {
    if (ad.floor === w.floor) score += 40;
    else { const strongOther = (priceExact && areaDiff <= 1.5) || numericIdentical; score -= strongOther ? 20 : 100; }
  }
  if (adN && wN && adN === wN && (adPhase || wPhase) && adPhase !== wPhase) {
    const veryStrong = (priceExact && areaDiff <= 1.5) && (!ad.floor || !w.floor || ad.floor === w.floor);
    if (!veryStrong) score -= 200;
  }
  return score;
}

function bestMatch(ad, watchlist) {
  let best = null, bestScore = -1e9;
  for (const w of watchlist) { const s = scorePair(ad, w); if (s > bestScore) { bestScore = s; best = w; } }
  return {
    match: bestScore >= MATCH_THRESHOLD ? best : null,
    score: bestScore >= MATCH_THRESHOLD ? bestScore : 0,
    cand: best, candScore: Math.round(bestScore)
  };
}

function compareData(ads, watch, total) {
  const nlAds = ads.filter((a) => !a.isLand);

  // 整體最佳指派：算出所有(廣告,物件)配對分數，高分先成立，每個物件只配一次
  const pairs = [];
  for (let ai = 0; ai < nlAds.length; ai++) {
    for (let wi = 0; wi < watch.length; wi++) {
      if (watch[wi].isLand) continue;
      const s = scorePair(nlAds[ai], watch[wi]);
      if (s >= MATCH_THRESHOLD) pairs.push({ ai, wi, s });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  const adUsed = new Array(nlAds.length).fill(false);
  const wUsed = new Array(watch.length).fill(false);
  const adMatch = {};
  for (const p of pairs) {
    if (adUsed[p.ai] || wUsed[p.wi]) continue;
    adUsed[p.ai] = true; wUsed[p.wi] = true; adMatch[p.ai] = { wi: p.wi, byPrice: false };
  }

  // 唯一價格救援：剩下沒配到的廣告，若此價在兩邊都只出現一次，靠價格配
  const iCnt = {}, aCnt = {};
  watch.forEach((w) => { if (!w.isLand && w.price) iCnt[w.price] = (iCnt[w.price] || 0) + 1; });
  nlAds.forEach((a) => { if (a.price) aCnt[a.price] = (aCnt[a.price] || 0) + 1; });
  for (let ai = 0; ai < nlAds.length; ai++) {
    if (adUsed[ai]) continue;
    const ad = nlAds[ai];
    if (ad.price && iCnt[ad.price] === 1 && aCnt[ad.price] === 1) {
      const wi = watch.findIndex((w, i) => !wUsed[i] && !w.isLand && w.price === ad.price
        && (!(w.area || w.area2) || !ad.area || Math.abs(ad.area - (w.area || w.area2)) <= 5));
      if (wi >= 0) { adUsed[ai] = true; wUsed[wi] = true; adMatch[ai] = { wi, byPrice: true }; }
    }
  }

  const results = [];
  let perfect = 0, priceDiff = 0, extra = 0, check = 0;
  for (let ai = 0; ai < nlAds.length; ai++) {
    const ad = nlAds[ai];
    if (adMatch[ai]) {
      const w = watch[adMatch[ai].wi], byPrice = adMatch[ai].byPrice;
      const iGone = /已成交|已下架/.test(w.status || '');
      if (iGone) { extra++; results.push({ type: '591多出', ad, w, reason: 'i智慧已成交/下架 → 591 應下架' }); }
      else if (w.price && ad.price && w.price !== ad.price) {
        priceDiff++;
        results.push({ type: '價格不一致', ad, w, reason: 'i智慧 ' + w.price + '萬 → 591 應改為 ' + w.price + '萬(目前 ' + ad.price + ')' });
      } else { perfect++; results.push({ type: '完美匹配', ad, w, byPrice }); }
    } else {
      const mm = bestMatch(ad, watch);
      if (mm.candScore >= 100) {
        check++;
        results.push({ type: '需確認', ad, w: null, cand: mm.cand, candScore: mm.candScore, reason: 'i智慧 有很相似的物件（可能是同一個、或你重複刊登了）→ 請人工確認再決定要不要下架' });
      } else {
        extra++;
        results.push({ type: '591多出', ad, w: null, cand: mm.cand, candScore: mm.candScore, reason: 'i智慧 關注找不到對應 → 591 應下架' });
      }
    }
  }
  const noAd = watch.filter((w, i) => !wUsed[i] && !w.isLand && w.community && w.price);
  return {
    results, noAd,
    summary: { perfect, priceDiff, extra, check, noAd: noAd.length },
    at: Date.now(), n591: ads.length, nIsmart: watch.length, ismartTotal: total || 0
  };
}

// ============ 流程編排 ============

async function runCompare() {
  const st = await chrome.storage.local.get(['ismartRows', 'ismartTotal']);
  const watch = st.ismartRows || [];
  if (!watch.length) throw new Error('還沒有 i智慧 資料，請先執行擷取。');

  const ads = await get591Ads();
  await setStatus('比對中…');
  const cmp = compareData(ads, watch, st.ismartTotal);
  cmp.ismartMode = SOURCE_MODE.ismart;
  cmp.s591Mode = SOURCE_MODE.s591;
  if (SOURCE_MODE.s591 === 'intercept') {
    const s = await chrome.storage.local.get(['s591Total']);
    cmp.s591Total = s.s591Total || 0;
  }

  // 完整性防呆：沿用 OCR 版精神，讀到的比「共 N 筆」少太多就不出報表
  if (cmp.ismartTotal && watch.length < Math.floor(cmp.ismartTotal * 0.9)) {
    const em = `i智慧 顯示共 ${cmp.ismartTotal} 筆，但這次只攔截到 ${watch.length} 筆 → 一定有漏頁。`
      + '為避免把有效廣告誤判成下架，這次不出報表。請重新擷取。';
    await chrome.storage.local.set({ capError: em, capStatus: '資料不完整，已中止' });
    throw new Error(em);
  }

  await chrome.storage.local.set({ compareResult: cmp, compareError: '', capStatus: '比對完成' });
  await chrome.tabs.create({ url: chrome.runtime.getURL('report.html') });
  return { ok: true, summary: cmp.summary };
}

async function guarded(fn) {
  if (busy) return { ok: false, error: '目前有工作進行中，請稍候。' };
  busy = true; abortFlag = false;
  try {
    return await fn();
  } catch (e) {
    const msg = String((e && e.message) || e);
    // capStatus（灰底狀態列）與 capError（紅字）在 popup 是兩塊各自顯示的區域，
    // 兩邊都塞同一段訊息會讓同一句話出現兩次。細節留給紅字，狀態列只講結果。
    await chrome.storage.local.set({ capError: msg, capStatus: '執行失敗' });
    return { ok: false, error: msg };
  } finally {
    busy = false;
  }
}

// 使用者按了 Chrome 的「取消偵錯」橫幅、或關掉分頁 → 收拾手動模式的殘留狀態
chrome.debugger.onDetach.addListener((source) => {
  if (!manualSession || source.tabId !== manualSession.target.tabId) return;
  const { col, keepAlive } = manualSession;
  manualSession = null;
  if (keepAlive) clearInterval(keepAlive);
  col.stop();
  setStatus(`手動擷取已中斷（偵錯工具被卸下），目前收到 ${col.count} 筆。可直接按「只比對」使用這批資料。`);
});

// ============ 訊息路由 ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.cmd) {
      case 'captureAuto':
        return sendResponse(await guarded(async () => {
          if (!(await assertDisclaimer())) {
            return { ok: false, error: '請先閱讀並同意使用須知，才能開始比對。', mode: 'disclaimer' };
          }
          const gate = await assertCoreAccess();
          if (!gate.allowed) return { ok: false, error: gate.message, mode: gate.mode };
          await chrome.storage.local.set({ capError: '' });
          return await captureIsmart();
        }));
      case 'captureAutoAndCompare':
        return sendResponse(await guarded(async () => {
          if (!(await assertDisclaimer())) {
            return { ok: false, error: '請先閱讀並同意使用須知，才能開始比對。', mode: 'disclaimer' };
          }
          const gate = await assertCoreAccess();
          if (!gate.allowed) return { ok: false, error: gate.message, mode: gate.mode };
          await chrome.storage.local.set({ capError: '' });
          await captureIsmart();
          if (abortFlag) return { ok: false, error: '已手動停止' };
          return await runCompare();
        }));
      case 'manualStart':
        return sendResponse(await guarded(async () => {
          if (!(await assertDisclaimer())) {
            return { ok: false, error: '請先閱讀並同意使用須知，才能開始比對。', mode: 'disclaimer' };
          }
          const gate = await assertCoreAccess();
          if (!gate.allowed) return { ok: false, error: gate.message, mode: gate.mode };
          await chrome.storage.local.set({ capError: '' });
          const r = await startManualCapture();
          busy = false; // 手動模式期間不佔住 busy，讓使用者能按「完成」
          return r;
        }));
      // manualStop 不設閘門：它是把「已經擷取到的資料」收尾，
      // 中途擋掉只會讓 debugger 卡在附加狀態、資料也白收。
      // 真正的閘門在後面的 compare。
      case 'manualStop':
        return sendResponse(await guarded(async () => await stopManualCapture()));
      case 'manualStatus':
        return sendResponse({
          ok: true,
          active: !!manualSession,
          count: manualSession ? manualSession.col.count : 0,
          total: manualSession ? manualSession.col.total : 0
        });
      case 'compare':
        return sendResponse(await guarded(async () => {
          if (!(await assertDisclaimer())) {
            return { ok: false, error: '請先閱讀並同意使用須知，才能開始比對。', mode: 'disclaimer' };
          }
          const gate = await assertCoreAccess();
          if (!gate.allowed) return { ok: false, error: gate.message, mode: gate.mode };
          return await runCompare();
        }));
      case 'abort':
        abortFlag = true;
        await setStatus('停止中…');
        return sendResponse({ ok: true });

      // ---- 授權相關 ----
      case 'accessStatus': {
        const access = await checkLiveCoreAccess();
        const stored = await chrome.storage.local.get(['install_id', 'license_expires_on']);
        return sendResponse({
          ok: true,
          allowed: access.allowed,
          mode: access.mode,
          message: access.message,
          installId: stored.install_id || '',
          expiresOn: stored.license_expires_on || ''
        });
      }
      case 'requestQr':
        try {
          return sendResponse(await requestLicenseQr());
        } catch (e) {
          return sendResponse({ ok: false, error: String((e && e.message) || e) });
        }

      default:
        return sendResponse({ ok: false, error: '未知指令' });
    }
  })();
  return true; // 非同步回覆
});
