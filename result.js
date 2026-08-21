// ============================================================
// 591 vs i智慧 自動比對工具 v6
// ============================================================
// v6 新增：結果頁顯示小提醒列，可隨時重看須知
// v5 已有：
//   ★ 健康檢查：偵測 API 異常並警告
//   ★ 備用模式：API 失敗時自動退回 DOM 抓取
// ============================================================

import {
  LICENSE_STATUS_API,
  PRODUCT_ID,
  TRIAL_DAYS,
  TRIAL_STATUS_API
} from './src/config.js';
import { classifyCoreLicenseStatus } from './src/core-access.js';

const TRIAL_STORAGE_KEY = 'trial_started_at_' + PRODUCT_ID;
const CORE_AUTH_TIMEOUT_MS = 8000;

function $(id) { return document.getElementById(id); }
function setStatus(msg) { const el = $('statusMsg'); if (el) el.textContent = msg; }
function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

// 即時調整統計卡片數字（statOkNum / statWarnNum / statBadNum / statInfoNum）
function bumpStat(id, delta) {
  const el = $(id);
  if (!el) return;
  const cur = parseInt(el.textContent, 10) || 0;
  el.textContent = String(Math.max(0, cur + delta));
}

// 產生「加入 i智慧 關注」單筆按鈕 HTML（給重新變 bad 的 row 使用）
function makeFollowSingleBtnHtml(ad) {
  const dataAttrs = 'data-community="' + (ad.community || '').replace(/"/g, '&quot;') + '"' +
    ' data-price="' + (ad.price || 0) + '"' +
    ' data-area="' + (ad.area || 0) + '"' +
    ' data-floor="' + (ad.floor || 0) + '"' +
    ' data-adcode="' + (ad.code || '') + '"' +
    ' data-island="' + (ad.isLand ? '1' : '0') + '"' +
    ' data-street="' + ((ad.street || '') + '').replace(/"/g, '&quot;') + '"' +
    ' data-title="' + ((ad.title || '') + '').replace(/"/g, '&quot;') + '"';
  return '<button class="follow-single-btn" ' + dataAttrs +
    ' style="margin-top:8px;background:#12805c;color:white;border:0;padding:6px 12px;font-size:12px;border-radius:4px;cursor:pointer;font-weight:bold;">' +
    '🎯 加入 i智慧 關注</button>' +
    '<span class="follow-single-result" style="margin-left:8px;font-size:12px;"></span>';
}

// 從 DOM 掃描目前所有 591 多出（type=bad）的行，回傳可加關注的 ads 陣列
function collectCurrentBadAds() {
  const ads = [];
  document.querySelectorAll('tr[data-type="bad"]').forEach(tr => {
    // 從內部的 follow-single-btn 抓資料（每筆 bad row 應該都有這按鈕）
    const btn = tr.querySelector('.follow-single-btn');
    if (!btn) return; // 沒按鈕就跳過
    ads.push({
      code: btn.dataset.adcode || '',
      community: btn.dataset.community || '',
      price: parseInt(btn.dataset.price) || 0,
      area: parseFloat(btn.dataset.area) || 0,
      floor: parseInt(btn.dataset.floor) || 0,
      isLand: btn.dataset.island === '1',
      street: btn.dataset.street || '',
      title: btn.dataset.title || ''
    });
  });
  return ads;
}

// 根據目前 statBadNum 更新 batch follow 按鈕的外觀
function refreshBatchFollowBtnUi() {
  const btn = $('batchFollowBtn');
  if (!btn) return;
  const count = parseInt(($('statBadNum') || {}).textContent, 10) || 0;
  if (count > 0) {
    btn.style.background = '#12805c';
    btn.style.cursor = 'pointer';
    btn.textContent = '🎯 全部加關注（' + count + ' 筆）';
    btn.disabled = false;
  } else {
    btn.style.background = '#bdbdbd';
    btn.style.cursor = 'not-allowed';
    btn.textContent = '🎯 無需加關注（0 筆）';
    btn.disabled = true;
  }
}

// 為新變成 bad 的 tr 綁定 follow-single-btn 的 click 事件
function bindFollowSingleBtn(btn, userStoreCode) {
  btn.addEventListener('click', async () => {
    const ad = {
      code: btn.dataset.adcode,
      community: btn.dataset.community,
      price: parseInt(btn.dataset.price) || 0,
      area: parseFloat(btn.dataset.area) || 0,
      floor: parseInt(btn.dataset.floor) || 0,
      isLand: btn.dataset.island === '1',
      street: btn.dataset.street || '',
      title: btn.dataset.title || ''
    };
    await runSingleFollow(btn, ad, userStoreCode);
  });
}
// 全域儲存目前的 userStoreCode，讓後加的按鈕能用到
window.__userStoreCode = '';

function showError(title, detail) {
  $('progress').innerHTML =
    '<h2 style="color:#c62828;margin:0 0 12px;">⚠ ' + title + '</h2>' +
    '<div class="error"><div style="white-space:pre-wrap;">' + detail + '</div>' +
    '<button class="retry" id="retryBtnError">🔄 重新比對</button></div>' +
    '<div style="margin-top:18px;font-size:13px;color:#666;text-align:left;">' +
    '<strong>常見原因：</strong><ul>' +
    '<li>還沒登入 i智慧 或 591 → 請先登入兩個網站</li>' +
    '<li>網路慢 → 直接按「重新比對」</li>' +
    '<li>網站改版 → 請通知工具製作者更新</li>' +
    '</ul></div>';
  const retryBtn = $('retryBtnError');
  if (retryBtn) retryBtn.addEventListener('click', () => location.reload());
}

function waitForTabComplete(tabId, timeoutMs) {
  timeoutMs = timeoutMs || 30000;
  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('分頁載入超時'));
    }, timeoutMs);
    function listener(tid, info) {
      if (tid === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(function(t) {
      if (t && t.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }).catch(function() {});
  });
}

// ============ 授權 / 試用 ============

async function getOrCreateInstallId() {
  const stored = await chrome.storage.local.get(['install_id']);
  if (stored.install_id) return stored.install_id;

  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ install_id: installId });
  return installId;
}

async function getChromeGoogleAccount() {
  if (!chrome.identity || !chrome.identity.getProfileUserInfo) {
    return null;
  }

  return await new Promise((resolve) => {
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
      if (chrome.runtime.lastError || !info || !info.id || !info.email) {
        resolve(null);
        return;
      }

      resolve({
        google_sub: info.id,
        google_email: info.email
      });
    });
  });
}

function googleAccountRequiredMessage() {
  return '請先在 Chrome 登入 Google 帳號，才能開始試用或申請授權。已授權的電腦不受影響。';
}

async function getTrialInfo(googleAccount, installId, signal) {
  if (googleAccount || installId) {
    const body = {
      product_id: PRODUCT_ID,
      install_id: installId
    };

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
        startedAt: data.trial_started_at,
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
  const remainingMs = expiresAt - now;

  return {
    startedAt,
    expiresAt,
    remainingMs,
    active: remainingMs > 0
  };
}

async function checkLiveCoreAccess() {
  const installId = await getOrCreateInstallId();
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
      return {
        allowed: false,
        mode: 'emergency_suspended',
        message: status.message
      };
    }
    if (status.decision === 'licensed') {
      return { allowed: true, mode: 'license', message: '授權有效。' };
    }
    const googleAccount = await getChromeGoogleAccount();
    const trial = await getTrialInfo(googleAccount, installId, controller.signal);
    if (trial.active) {
      return { allowed: true, mode: 'trial', message: '' };
    }
    return {
      allowed: false,
      mode: 'expired',
      message: data.reason === 'expired'
        ? `授權已於 ${data.expires_on || '設定期限'} 到期，請回到擴充工具重新產生 QR Code 授權。`
        : '請回到擴充工具視窗，產生 QR Code 並請管理員核准。'
    };
  } catch (e) {
    return {
      allowed: false,
      mode: 'unavailable',
      message: '目前無法確認授權狀態，請稍後再試。'
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// 寫入型操作（加關注／取消關注）前的即時授權閘門。
// 比對只在開頁時驗一次，但這些動作會實際寫入 i智慧，且不可還原，
// 所以每次都重新向伺服器確認，讓緊急停止能立即生效（刻意不做快取）。
async function assertCoreAccess() {
  const access = await checkLiveCoreAccess();
  if (!access.allowed) {
    alert(access.message);
    return false;
  }
  return true;
}

// ============ i智慧 抓取（API + DOM 備用）============

async function scrapeIzhihui_API_in_tab(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: izhihuiApi,
    world: 'MAIN'
  });
  return res && res[0] && res[0].result;
}

function izhihuiApi() {
  return (async function() {
    // 先抓當前使用者的本店碼（不依賴 watchlist 頻率推導）
    let userStoreCode = '';
    try {
      const uRes = await fetch('https://is.ycut.com.tw/api/user', {
        credentials: 'same-origin',
        headers: {'Accept': 'application/json, text/plain, */*', 'websiteName': 'IntegrationService_WS'}
      });
      const uJson = await uRes.json();
      if (uJson.status === 'Success' && uJson.data) {
        userStoreCode = uJson.data.departmentId || '';
      }
    } catch (e) {}

    const all = [];
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
      if (json.status !== 'Success' || !json.data) return { error: 'i智慧 API: ' + (json.status || 'unknown') };
      const list = json.data.caseList || [];
      for (const c of list) {
        const isLand = (c.useCodeName === '土地') || (!c.buiTotPin && !c.buiMPin);
        const area = isLand
          ? (c.landShPin || c.buiTotPin || 0)
          : (c.buiTotPin || c.buiMPin || 0);
        all.push({
          code: c.caseNoNumber,
          caseKey: c.caseKey || '',
          community: c.buildingName || '',
          price: c.totPrice,
          area: area,
          floor: c.floorSt || c.upFloor || 0,
          room: c.rm || 0,
          bath: c.bathRm || 0,
          isLand: isLand,
          useType: c.useCodeName || '',
          storeCode: c.storeCode || ''
        });
      }
      if (list.length < 100) break;
    }
    return { items: all, userStoreCode: userStoreCode };
  })();
}

function izhihuiDom() {
  return (async function() {
    function w(ms) { return new Promise(r => setTimeout(r, ms)); }
    // 設定每頁 30
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '30' || o.text.trim() === '30'));
    if (sel) {
      sel.value = '30';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await w(2500);
    }
    // 等資料載入
    for (let i = 0; i < 30; i++) {
      if (document.body.innerText.includes('共') && document.body.innerText.includes('筆')) break;
      await w(500);
    }
    await w(1500);

    function parseItems() {
      const text = document.body.innerText;
      const items = [];
      const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
      const codeRe = /^\d{7,8}$/;
      const anchors = [];
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '編號' && codeRe.test(lines[i+1] || '')) anchors.push(i);
      }
      for (let idx = 0; idx < anchors.length; idx++) {
        const i = anchors[idx];
        const prev = idx > 0 ? anchors[idx - 1] : -1;
        const code = lines[i+1];
        let community = '';
        for (let j = i - 1; j > Math.max(prev, i - 40); j--) {
          if (lines[j] === '用途') {
            for (let k = j - 1; k > Math.max(prev, j - 8); k--) {
              if (/^(新北市|台北市|桃園市|台中市|高雄市|新竹|基隆|台南)/.test(lines[k])) {
                community = lines[k - 1] || '';
                break;
              }
            }
            break;
          }
        }
        const upper = idx + 1 < anchors.length ? anchors[idx+1] : Math.min(lines.length, i + 12);
        let price = null;
        for (let j = i + 2; j < upper; j++) {
          if (/^[\d,]+$/.test(lines[j]) && lines[j+1] === '萬') {
            price = parseInt(lines[j].replace(/,/g, ''));
            break;
          }
        }
        if (community && price) items.push({ code, community, price, area: 0, floor: 0, room: 0, bath: 0, isLand: false });
      }
      return items;
    }
    return parseItems();
  })();
}

async function scrapeIzhihui() {
  setStatus('開啟 i智慧 背景分頁…');
  const tab = await chrome.tabs.create({
    url: 'https://is.ycut.com.tw/is/case/search/watch-list',
    active: false
  });
  let mode = 'API';
  let items = null;
  let userStoreCode = '';
  try {
    await waitForTabComplete(tab.id);
    await wait(1500);
    setStatus('呼叫 i智慧 API…');
    try {
      const r = await scrapeIzhihui_API_in_tab(tab.id);
      if (r && !r.error && r.items && Array.isArray(r.items)) {
        items = r.items;
        userStoreCode = r.userStoreCode || '';
      } else if (r && !r.error && Array.isArray(r) && r.length > 0) {
        // 向前相容舊格式
        items = r;
      } else {
        throw new Error(r?.error || 'API 回傳空');
      }
    } catch (apiErr) {
      // API 失效，退回 DOM
      setStatus('⚠ i智慧 API 異常，啟用備用 DOM 模式…');
      await chrome.tabs.update(tab.id, { active: true });
      await wait(1500);
      const r = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: izhihuiDom,
        world: 'MAIN'
      });
      items = r && r[0] && r[0].result;
      mode = 'DOM';
    }
    return { items: items || [], mode, userStoreCode: userStoreCode };
  } finally {
    chrome.tabs.remove(tab.id).catch(function() {});
  }
}

// ============ 591 抓取（API + DOM 備用）============

function api591() {
  return (async function() {
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
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'device': 'pc',
          'deviceid': deviceid,
          'access-token': accessToken
        },
        body: JSON.stringify({
          device: 'pc', deviceid: deviceid,
          current_page: page, page_size: 50,
          type: 2
        })
      });
      const json = await res.json();
      if (json.status !== 1) return { error: '591 API: ' + (json.msg || 'unknown') };
      const items = json.data.items || [];
      for (const it of items) {
        let floorStr = it.floor || '';
        let floorNum = 0;
        const fm = floorStr.match(/(-?\d+)/);
        if (fm) floorNum = parseInt(fm[1]);
        const isLand = (it.kind_txt === '土地');
        all.push({
          code: 'S' + it.id,
          postId: it.id,
          title: it.title || '',
          community: (it.community && it.community.name) || '',
          price: parseInt(it.price) || 0,
          area: parseFloat(it.area) || 0,
          floor: floorNum,
          kind: it.kind_txt || '',
          isLand: isLand,
          region: it.regionName || '',
          section: it.sectionName || '',
          street: it.streetName || ''
        });
      }
      if (items.length < 50) break;
    }
    return all;
  })();
}

function dom591() {
  return (async function() {
    function w(ms) { return new Promise(r => setTimeout(r, ms)); }
    for (let i = 0; i < 30; i++) {
      const t = document.body.innerText;
      if (t.indexOf('萬元') >= 0 || (t.indexOf('共') >= 0 && t.indexOf('筆') >= 0)) break;
      await w(500);
    }
    await w(1200);
    const text = document.body.innerText;
    const items = [];
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    const codeRe = /^S\d{7,9}$/;
    for (let i = 0; i < lines.length; i++) {
      if (!codeRe.test(lines[i])) continue;
      const code = lines[i];
      let price = null, community = '', area = 0, floor = 0;
      for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
        if (codeRe.test(lines[j])) break;
        if (!price) {
          const pm = lines[j].match(/^([\d,]+)\s*萬元$/);
          if (pm) price = parseInt(pm[1].replace(/,/g, ''));
        }
        if (!community) {
          const cm = lines[j].match(/^(.+?)(淡水區|三峽區|觀音區|大安區|信義區|中山區|內湖區|文山區|士林區|北投區|松山區|大同區|萬華區|南港區|中正區|板橋區|板橋|新莊區|新莊|中和區|中和|永和區|永和|土城區|土城|新店區|新店|樹林區|樹林|蘆洲區|蘆洲|三重區|三重|林口區|林口|汐止區|汐止|新北市|台北市|桃園市|台中市|高雄市|台南市|新竹|基隆)-/);
          if (cm) community = cm[1].trim();
        }
        if (!area) {
          const am = lines[j].match(/(\d+(?:\.\d+)?)\s*坪/);
          if (am) area = parseFloat(am[1]);
        }
        if (!floor) {
          const fm = lines[j].match(/(\d+)F\/(\d+)F/);
          if (fm) floor = parseInt(fm[1]);
        }
      }
      if (price) items.push({ code, postId: parseInt(code.substring(1)), title: '', community: community || '', price, area, floor, kind: '', isLand: false });
    }
    return items;
  })();
}

async function scrape591() {
  setStatus('開啟 591 背景分頁…');
  const tab = await chrome.tabs.create({
    url: 'https://user.591.com.tw/ware/open',
    active: false
  });
  let mode = 'API';
  let items = null;
  try {
    await waitForTabComplete(tab.id);
    await wait(1500);
    setStatus('呼叫 591 API…');
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: api591,
        world: 'MAIN'
      });
      const result = r && r[0] && r[0].result;
      if (result && !result.error && Array.isArray(result) && result.length > 0) {
        items = result;
      } else {
        throw new Error(result?.error || 'API 回傳空');
      }
    } catch (apiErr) {
      // 退回 DOM 模式：逐頁開啟
      setStatus('⚠ 591 API 異常，啟用備用 DOM 模式（會比較慢）…');
      const allDom = [];
      const seen = new Set();
      await chrome.tabs.update(tab.id, { active: true });
      for (let page = 1; page <= 15; page++) {
        setStatus('⚠ DOM 模式 抓取第 ' + page + ' 頁…');
        if (page > 1) {
          await chrome.tabs.update(tab.id, { url: 'https://user.591.com.tw/ware/open?current=' + page });
        }
        await waitForTabComplete(tab.id);
        await wait(2200);
        const r = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: dom591,
          world: 'MAIN'
        });
        const its = (r && r[0] && r[0].result) || [];
        let newCount = 0;
        for (const it of its) {
          if (!seen.has(it.code)) { seen.add(it.code); allDom.push(it); newCount++; }
        }
        if (newCount === 0) break;
      }
      items = allDom;
      mode = 'DOM';
    }
    return { items: items || [], mode };
  } finally {
    chrome.tabs.remove(tab.id).catch(function() {});
  }
}

// ============ 健康檢查 ============

function healthCheck(watchlist, ads, izhihuiMode, mode591) {
  const warns = [];
  if (!watchlist || watchlist.length === 0) {
    warns.push({ level: 'critical', msg: '⛔ i智慧 抓到 0 筆資料 — 可能未登入或 API 已變更，請通知工具製作者' });
  }
  if (!ads || ads.length === 0) {
    warns.push({ level: 'critical', msg: '⛔ 591 抓到 0 筆資料 — 可能未登入或 API 已變更，請通知工具製作者' });
  }
  // 樣本太小（< 10 筆）時不判「無社區名比例」（避免老公寓等單筆特殊 case 誤報）
  const MIN_SAMPLE = 10;
  if (watchlist && watchlist.length >= MIN_SAMPLE) {
    const withCommunity = watchlist.filter(w => w.community).length;
    const withPrice = watchlist.filter(w => w.price > 0).length;
    if (withCommunity / watchlist.length < 0.3) {
      warns.push({ level: 'high', msg: '⚠ i智慧 有 ' + (watchlist.length - withCommunity) + ' 筆物件沒社區名 — API 結構可能改變' });
    }
    if (withPrice / watchlist.length < 0.9) {
      warns.push({ level: 'high', msg: '⚠ i智慧 有 ' + (watchlist.length - withPrice) + ' 筆物件沒價格 — 結果可能不準' });
    }
  }
  if (ads && ads.length >= MIN_SAMPLE) {
    const withCommunity = ads.filter(a => a.community).length;
    const withPrice = ads.filter(a => a.price > 0).length;
    const withArea = ads.filter(a => a.area > 0).length;
    if (withCommunity / ads.length < 0.3) {
      warns.push({ level: 'high', msg: '⚠ 591 有 ' + (ads.length - withCommunity) + ' 筆廣告沒社區名 — API 結構可能改變' });
    }
    if (withPrice / ads.length < 0.9) {
      warns.push({ level: 'high', msg: '⚠ 591 有 ' + (ads.length - withPrice) + ' 筆廣告沒價格' });
    }
    if (withArea / ads.length < 0.5) {
      warns.push({ level: 'medium', msg: '⚠ 591 有 ' + (ads.length - withArea) + ' 筆廣告沒坪數 — 比對精準度降低' });
    }
  }
  if (izhihuiMode === 'DOM') {
    warns.push({ level: 'medium', msg: '🟡 i智慧 使用備用 DOM 模式（API 失效）— 結果仍可信，但建議通知工具製作者更新' });
  }
  if (mode591 === 'DOM') {
    warns.push({ level: 'medium', msg: '🟡 591 使用備用 DOM 模式（API 失效）— 結果仍可信，但建議通知工具製作者更新' });
  }
  return warns;
}

// ============ 比對邏輯 ============

function normalizeName(s) {
  if (!s) return '';
  let n = s.toUpperCase().replace(/大廈|華廈|社區|\(|\)|（|）|\/|・|·|\s|　/g, '');
  // 削尾（跟 stripCommunitySuffixes 邏輯一致）：北/南/東/西/中/前/後區、期別、NOx、A棟/區、純數字結尾
  n = n
    .replace(/(北|南|東|西|中|前|後)區$/, '')
    .replace(/第?[一二三四五六七八九十0-9]+期$/, '')
    .replace(/NO\.?\d+$/i, '')
    .replace(/[A-Z]棟$/, '')
    .replace(/[A-Z]區$/, '')
    .replace(/\d+$/, '');
  return n;
}

function bestMatch(ad, watchlist) {
  const adN = normalizeName(ad.community);
  let best = null, bestScore = 0;
  for (const w of watchlist) {
    const wN = normalizeName((w.community || '').split('/')[0]);
    let score = 0;
    if (adN && wN) {
      if (adN === wN) score += 100;
      else if (adN.indexOf(wN) >= 0 || wN.indexOf(adN) >= 0) score += 70;
      else {
        let common = 0;
        const seen = {};
        for (let k = 0; k < adN.length; k++) {
          if (!seen[adN[k]] && wN.indexOf(adN[k]) >= 0) { seen[adN[k]] = 1; common++; }
        }
        if (common >= 2) score += common * 5;
      }
    }
    const priceExact = (w.price === ad.price);
    if (priceExact) score += 100;
    else if (Math.abs(w.price - ad.price) <= 2) score += 60;
    else if (Math.abs(w.price - ad.price) / Math.max(w.price, 1) <= 0.05) score += 30;
    const areaDiff = (ad.area && w.area) ? Math.abs(ad.area - w.area) : Infinity;
    if (areaDiff <= 1) score += 60;
    else if (areaDiff <= 3) score += 25;
    // 樓層比對：非土地時，兩邊都有樓層才判斷
    // - 樓層相同：加 40
    // - 樓層不同：分兩級
    //   軟扣（-30）：其他信號極強（社區精確 + 價格精確 + 坪數 ≤ 0.5）→ 可能是其他店 key 錯樓層
    //   硬扣（-100）：其他信號普通 → 真的不同物件（避免 12F 廣告誤配 11F 物件）
    if (!ad.isLand && !w.isLand && ad.floor && w.floor) {
      if (ad.floor === w.floor) {
        score += 40;
      } else {
        const communityExact = (adN && wN && adN === wN);
        const strongOther = communityExact && priceExact && areaDiff <= 0.5;
        score -= strongOther ? 30 : 100;
      }
    }
    if (ad.room && w.room && ad.room === w.room) score += 15;
    if (ad.bath && w.bath && ad.bath === w.bath) score += 10;
    if (score > bestScore) { bestScore = score; best = w; }
  }
  return { match: best, score: bestScore };
}

const MATCH_THRESHOLD = 130;

// 產生 591 廣告的連結（回列表搜尋頁，方便修改廣告）
function build591Link(ad) {
  if (!ad || !ad.code) return '';
  return 'https://user.591.com.tw/ware/open?keywords=' + encodeURIComponent(ad.code);
}

// 產生 i智慧 物件的 detail 連結
function buildIzhihuiLink(w) {
  if (!w) return '';
  if (w.caseKey) {
    return 'https://is.ycut.com.tw/is/case/detail/' + encodeURIComponent(w.caseKey);
  }
  // 沒 caseKey 時退回 watch-list（總比沒有好）
  return 'https://is.ycut.com.tw/is/case/search/watch-list';
}

function renderRow(r) {
  let adCell = '—';
  let adCode = r.ad ? r.ad.code : '';
  if (r.ad) {
    const linkStyle = 'color:#ff7a00;text-decoration:none;font-weight:bold;';
    const codeLink = '<a href="' + build591Link(r.ad) + '" target="_blank" rel="noopener" ' +
      'title="在 591 開啟這筆廣告（列表頁，方便編輯）" style="' + linkStyle + '">' +
      r.ad.code + ' 🔗</a>';
    adCell = codeLink + '<br><b>' + (r.ad.community || (r.ad.title || '').substring(0, 18) || '(無社區)') + '</b><br>' +
      r.ad.price.toLocaleString() + ' 萬 / ' + r.ad.area + '坪 / ' + (r.ad.floor || '-') + 'F' +
      (r.ad.isLand ? ' [土地]' : '');
  }

  let matchCell = '—';
  if (r.match) {
    const linkStyle = 'color:#1565c0;text-decoration:none;font-weight:bold;';
    const codeLink = r.match.caseKey
      ? '<a href="' + buildIzhihuiLink(r.match) + '" target="_blank" rel="noopener" ' +
        'title="在 i智慧 開啟這筆物件詳細頁" style="' + linkStyle + '">' + r.match.code + ' 🔗</a>'
      : r.match.code;
    matchCell = codeLink + '<br><b>' + (r.match.community || '(無社區)') + '</b><br>' +
      r.match.price.toLocaleString() + ' 萬 / ' + r.match.area + '坪 / ' + (r.match.floor || '-') + 'F' +
      (r.match.isLand ? ' [土地]' : '');
  }

  let action = r.action || '<span style="color:#999;">無須動作</span>';

  // 「591 多出」的行加「加入 i智慧 關注」按鈕
  if (r.type === 'bad' && r.ad) {
    const dataAttrs = 'data-community="' + (r.ad.community || '').replace(/"/g, '&quot;') + '"' +
      ' data-price="' + (r.ad.price || 0) + '"' +
      ' data-area="' + (r.ad.area || 0) + '"' +
      ' data-floor="' + (r.ad.floor || 0) + '"' +
      ' data-adcode="' + (r.ad.code || '') + '"' +
      ' data-island="' + (r.ad.isLand ? '1' : '0') + '"' +
      ' data-street="' + ((r.ad.street || '') + '').replace(/"/g, '&quot;') + '"' +
      ' data-title="' + ((r.ad.title || '') + '').replace(/"/g, '&quot;') + '"';
    action = '<div>' + action + '</div>' +
      '<button class="follow-single-btn" ' + dataAttrs +
      ' style="margin-top:8px;background:#12805c;color:white;border:0;padding:6px 12px;font-size:12px;border-radius:4px;cursor:pointer;font-weight:bold;">' +
      '🎯 加入 i智慧 關注</button>' +
      '<span class="follow-single-result" style="margin-left:8px;font-size:12px;"></span>';
  }

  // 「關注沒對應」的行加「取消 i智慧 關注」按鈕
  if (r.type === 'info' && r.match && r.match.caseKey) {
    const dataAttrs = 'data-casekey="' + r.match.caseKey + '"' +
      ' data-code="' + (r.match.code || '') + '"' +
      ' data-community="' + (r.match.community || '').replace(/"/g, '&quot;') + '"';
    action = '<div>' + action + '</div>' +
      '<button class="unfollow-single-btn" ' + dataAttrs +
      ' style="margin-top:8px;background:#c62828;color:white;border:0;padding:6px 12px;font-size:12px;border-radius:4px;cursor:pointer;font-weight:bold;">' +
      '🗑 取消 i智慧 關注</button>' +
      '<span class="unfollow-single-result" style="margin-left:8px;font-size:12px;"></span>';
  }

  let trAttrs = '';
  if (adCode) trAttrs += ' data-adcode="' + adCode + '"';
  if (r.type === 'info' && r.match && r.match.code) trAttrs += ' data-infocode="' + r.match.code + '"';
  if ((r.type === 'ok' || r.type === 'warn') && r.match && r.match.code) trAttrs += ' data-matchcode="' + r.match.code + '"';
  trAttrs += ' data-type="' + r.type + '"';
  return '<tr' + trAttrs + '><td class="status-cell"><span class="badge ' + r.type + '">' + r.label + '</span></td>' +
    '<td class="ad-cell">' + adCell + '</td><td class="izhihui-cell">' + matchCell + '</td><td class="action-cell">' + action + '</td></tr>';
}

// ============ 一鍵補齊關注 - 核心邏輯 ============

// 在 i智慧 分頁內執行：搜尋 + 加關注
async function searchAndFollowInIzhihuiTab(items, userStoreCode) {
  const tab = await chrome.tabs.create({
    url: 'https://is.ycut.com.tw/is/case/search/all-case',
    active: false
  });
  try {
    await waitForTabComplete(tab.id);
    await wait(2000);
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: searchAndFollowInPage,
      args: [items, userStoreCode || ''],
      world: 'MAIN'
    });
    return res && res[0] && res[0].result;
  } finally {
    chrome.tabs.remove(tab.id).catch(function() {});
  }
}

// 注入到 i智慧 頁面：對每一筆 591 多出，搜尋聯賣範圍 + 精準匹配 + 加關注
// userStoreCode: 使用者本店碼（例如 AB117），用於重複委託時優先加自己店的
function searchAndFollowInPage(items, userStoreCode) {
  return (async function() {
    const results = [];

    // 從 591 標題抽出可能的社區名關鍵字
    // 591 標題常見格式：「[emoji]XX社區XX格局特色」「【XX社區】...」「@XX社區-...」
    function extractKeywordsFromTitle(title) {
      if (!title) return [];
      const kws = new Set();
      // 移除 emoji 和常見開頭符號
      let cleaned = title.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/^[@#\[\【★☆♥❤🍎💯🌟✨🔥]+/, '').trim();
      // 抽括號內的 【XXX】
      const bracket = cleaned.match(/[【\[](.+?)[】\]]/g);
      if (bracket) bracket.forEach(b => { const inner = b.slice(1, -1).trim(); if (inner.length >= 2 && inner.length <= 15) kws.add(inner); });
      // 抽開頭連續中英文字（社區名通常在前面）
      // 進一步：抽前 4/6/8 個字，遞減嘗試
      const front = cleaned.match(/^([一-龥A-Za-z0-9]{2,15})/);
      if (front) {
        const f = front[1];
        kws.add(f);
        // 若前綴長度 > 6，也加入前 6/4 字（因社區名通常 2-6 字）
        if (f.length > 6) kws.add(f.substring(0, 6));
        if (f.length > 4) kws.add(f.substring(0, 4));
      }
      return [...kws];
    }

    // 削掉社區名常見尾綴，回傳原名 + 削過後的變體 + 前綴變體
    function stripCommunitySuffixes(name) {
      if (!name) return [];
      const variants = [name];
      // 也先去除中間的「大廈|華廈|社區」再削（處理「日若山莊三期華廈區」這種）
      const normalized = name.replace(/大廈|華廈|社區/g, '');
      if (normalized && normalized !== name && normalized.length >= 2) variants.push(normalized);
      // 一次削一種尾綴（對原名 + normalized 都試）
      const patterns = [
        /(北|南|東|西|中|前|後)區$/,           // 星海別墅北區 → 星海別墅
        /第[一二三四五六七八九十0-9]+期$/,      // 富貴第一期 → 富貴
        /[一二三四五六七八九十]+期$/,            // 富貴一期 → 富貴
        /NO\.?\d+$/i,                            // 星海NO2 → 星海
        /[A-Z]棟$/,                              // 山莊A棟 → 山莊
        /[A-Z]區$/,                              // 山莊A區 → 山莊
        /-.*$/,                                  // 前段-後段 → 前段
        /\(.*\)$/,                               // 前段(附註) → 前段
        /\/.*$/,                                 // A/B → A
        /\d+$/                                   // 星海1 → 星海
      ];
      const bases = [name];
      if (normalized !== name) bases.push(normalized);
      for (const base of bases) {
        for (const p of patterns) {
          const stripped = base.replace(p, '').trim();
          if (stripped && stripped.length >= 2 && !variants.includes(stripped)) {
            variants.push(stripped);
          }
        }
      }
      // 前綴變體：長度 > 4 時加入 前 4/6 字（處理無法削尾的怪社區名）
      const cleanForPrefix = normalized.replace(/大廈|華廈|社區/g, '').trim();
      if (cleanForPrefix.length > 6) {
        const p6 = cleanForPrefix.substring(0, 6);
        if (!variants.includes(p6)) variants.push(p6);
      }
      if (cleanForPrefix.length > 4) {
        const p4 = cleanForPrefix.substring(0, 4);
        if (!variants.includes(p4)) variants.push(p4);
      }
      return variants;
    }

    async function searchCommunity(keyWord) {
      const cond = {
        mode: "C", sellRent: "A", searchType: "U",
        sTeamStores: [], city1: null, district1: null, city2: null, district2: null, city3: null, district3: null,
        useCodes: [], typeCodes: [], totPriceFrom: null, totPriceTo: null, rentFrom: null, rentTo: null,
        rmFrom: null, rmTo: null, isAddRoom: true, keyWord: keyWord,
        mainCaseTags: [], parkingSpace: null, parkingModes: [],
        buiMPinFrom: null, buiMPinTo: null, landShPinFrom: null, landShPinTo: null,
        buiTotPinFrom: null, buiTotPinTo: null, buiMAndPorchPinFrom: null, buiMAndPorchPinTo: null,
        floorSt: null, floorEn: null, isTopFloor: false, isIncludeBasementFloor: false,
        excludeFirstFloor: false, excludeFourthFloor: false, excludeTopFloor: false, excludeTopFloorAddition: false,
        bathRmFrom: null, bathRmTo: null, caseGrp: null, buildingAgeFrom: null, buildingAgeTo: null,
        landTypes: [], positions: [], doorPositions: [], ceilingWinPositions: [],
        housingFeaturesTags: [], surroundingsTags: [], otherCaseTags: [],
        priSchool: null, junSchool: null, mStaff: null
      };
      const res = await fetch('/api/Case/Circulating/List', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'websiteName': 'IntegrationService_WS'},
        body: JSON.stringify({condition: cond, page: {skip: 0, take: 50, descending: false, order: 'A'}})
      });
      const j = await res.json();
      if (j.status !== 'Success') return { error: j.status || 'unknown' };
      return { list: j.data.caseList || [] };
    }

    function matchScore(ad, candidate) {
      const isLandC = (candidate.useCodeName === '土地') || (!candidate.buiTotPin && !candidate.buiMPin);
      const cArea = isLandC ? (candidate.landShPin || candidate.buiTotPin || 0) : (candidate.buiTotPin || candidate.buiMPin || 0);
      const cFloor = candidate.floorSt || candidate.upFloor || 0;
      let s = 0;
      const priceExact = (candidate.totPrice === ad.price);
      if (priceExact) s += 100;
      else if (Math.abs(candidate.totPrice - ad.price) <= 2) s += 60;
      const areaDiff = (ad.area && cArea) ? Math.abs(ad.area - cArea) : Infinity;
      if (areaDiff <= 1) s += 60;
      else if (areaDiff <= 3) s += 25;
      // 樓層：相同 +40；不同時軟/硬扣
      //   軟扣 -30：價格精確 + 坪差 ≤ 0.5 → 高機率是別店 key 錯樓層
      //   硬扣 -100：其他信號普通 → 真的不同物件
      if (!ad.isLand && !isLandC && ad.floor && cFloor) {
        if (ad.floor === cFloor) {
          s += 40;
        } else {
          const strongOther = priceExact && areaDiff <= 0.5;
          s -= strongOther ? 30 : 100;
        }
      }
      return s;
    }

    // 判斷兩個 i智慧 物件是不是同一個實體物件（重複委託）
    // 現實：不同店 key 資料時數字會有小差，任何欄位都可能被 key 錯
    // 改採「主要指標一致」規則，不強求所有欄位都一致
    function isSamePhysicalProperty(a, b) {
      // 削尾正規化社區名比對
      const nameNorm = (s) => {
        if (!s) return '';
        return String(s).toUpperCase()
          .replace(/大廈|華廈|社區|\(|\)|（|）|\/|・|·|\s|　/g, '')
          .replace(/(北|南|東|西|中|前|後)區$/, '')
          .replace(/第?[一二三四五六七八九十0-9]+期$/, '')
          .replace(/NO\.?\d+$/i, '')
          .replace(/[A-Z]棟$/, '')
          .replace(/[A-Z]區$/, '')
          .replace(/\d+$/, '');
      };

      // 必要條件 1：同店不可能同物件多次登記 → 同店碼一定不是重複委託
      if (a.storeCode && b.storeCode && a.storeCode === b.storeCode) return false;

      // 必要條件 2：若兩邊都有 buildingId，必須相同
      if (a.buildingId && b.buildingId && a.buildingId !== b.buildingId) return false;

      // 社區名處理（考慮老公寓沒社區名的情況）
      const nameA = nameNorm(a.buildingName);
      const nameB = nameNorm(b.buildingName);
      const bothHaveName = nameA && nameB;
      const bothMissingName = !nameA && !nameB;
      const oneHasName = (!!nameA) !== (!!nameB);

      if (bothHaveName) {
        // 兩邊都有社區名 → 削尾後必須相同
        if (nameA !== nameB) return false;
      } else if (oneHasName) {
        // 一邊有一邊沒 → 靠 buildingId 匹配（不合就否決）
        if (!a.buildingId || !b.buildingId || a.buildingId !== b.buildingId) return false;
      }
      // bothMissingName（老公寓） → 靠下面的街道+價格+坪數 判斷

      // 必要條件 4：街道相同
      if ((a.streetName || '') !== (b.streetName || '')) return false;

      // 必要條件 5：價格差 ≤ 5%
      const maxPrice = Math.max(a.totPrice || 0, b.totPrice || 0, 1);
      const priceDiffRatio = Math.abs((a.totPrice || 0) - (b.totPrice || 0)) / maxPrice;
      if (priceDiffRatio > 0.05) return false;

      // 必要條件 6：至少一個坪數欄位近似（差 ≤ 2 坪）
      const anyAreaClose =
        (a.buiTotPin && b.buiTotPin && Math.abs(a.buiTotPin - b.buiTotPin) <= 2) ||
        (a.buiMPin && b.buiMPin && Math.abs(a.buiMPin - b.buiMPin) <= 2) ||
        (a.landShPin && b.landShPin && Math.abs(a.landShPin - b.landShPin) <= 2);
      if (!anyAreaClose) return false;

      // 若兩邊都沒社區名（老公寓），加保險避免同街不同戶巧合
      // 房數容忍差 1（實務上同物件有人 key 3房、有人 key 2房，常見加隔戶差異）
      // 衛數必須相同（衛浴數變化少）
      if (bothMissingName) {
        const rmDiff = Math.abs((a.rm || 0) - (b.rm || 0));
        if (rmDiff > 1) return false;
        if ((a.bathRm || 0) !== (b.bathRm || 0)) return false;
      }

      return true;
    }

    // 從候選陣列中挑「最該加關注的一筆」
    // 優先序：本店 > 有地址完整 > 分數高 > 第一筆
    function pickBestDuplicate(candidates, userStoreCode) {
      if (!candidates || candidates.length === 0) return null;
      if (!userStoreCode) return candidates[0]; // 沒指定本店碼就選第一
      // 先找本店的
      const ownStore = candidates.find(x => x.c.storeCode === userStoreCode);
      if (ownStore) return ownStore;
      // 沒本店的，選第一（已按分數排序）
      return candidates[0];
    }

    async function followByCaseKey(caseKey) {
      const res = await fetch('/api/Case/Follow/' + encodeURIComponent(caseKey), {
        method: 'POST', credentials: 'same-origin',
        headers: {'Accept': 'application/json, text/plain, */*', 'websiteName': 'IntegrationService_WS'}
      });
      return res.ok;
    }

    for (const ad of items) {
      // 多層 keyword fallback：社區名（含削尾變體）→ 街道名 → 標題抽關鍵字
      const keywords = [];
      if (ad.community) {
        for (const v of stripCommunitySuffixes(ad.community)) {
          if (!keywords.includes(v)) keywords.push(v);
        }
      }
      if (ad.street && !keywords.includes(ad.street)) keywords.push(ad.street);
      if (ad.title) {
        for (const kw of extractKeywordsFromTitle(ad.title)) {
          if (!keywords.includes(kw)) keywords.push(kw);
        }
      }
      if (keywords.length === 0) {
        results.push({ adCode: ad.code, status: 'no_keyword', message: '591 沒有社區名、街道或可用標題，無法搜尋' });
        continue;
      }

      try {
        // 收集所有 keyword 搜尋的候選（去重）
        let allCandidates = [];
        const seenCaseKey = new Set();
        let usedKeyword = null;
        for (const kw of keywords) {
          const searchRes = await searchCommunity(kw);
          if (searchRes.error) continue;
          for (const c of searchRes.list) {
            if (!c.caseKey || seenCaseKey.has(c.caseKey)) continue;
            seenCaseKey.add(c.caseKey);
            allCandidates.push({ c: c, score: matchScore(ad, c), kw: kw });
          }
          // 這個 keyword 內若已找到高分（>=200），可以早停避免多次 API
          if (allCandidates.some(x => x.score >= 200)) break;
        }
        allCandidates.sort((a, b) => b.score - a.score);
        const top1 = allCandidates[0];

        if (!top1 || top1.score < 130) {
          results.push({
            adCode: ad.code, community: ad.community || '(無社區)',
            status: 'not_found',
            message: '聯賣範圍找不到匹配物件（可能已成交或不在聯賣體系）',
            triedKeywords: keywords,
            candidatesCount: allCandidates.length
          });
          continue;
        }

        // 【捷徑】本店優先：候選中若有本店 storeCode 且分數 >= 130，直接加本店那筆
        // 因為使用者規則「同店只能一個業務接」→ 本店有的就是本店該加的，跳過 ambiguous 判斷
        let chosen = null;
        let isDuplicate = false;
        let ownStoreShortcut = false;
        if (userStoreCode) {
          const ownStoreCandidates = allCandidates.filter(x =>
            x.c.storeCode === userStoreCode && x.score >= 130
          );
          if (ownStoreCandidates.length > 0) {
            chosen = ownStoreCandidates[0]; // 已按分數排序，選最高的
            isDuplicate = allCandidates.filter(x => x.score >= 130).length > 1;
            ownStoreShortcut = true;
          }
        }

        // 沒本店 → 走 duplicate 分析
        if (!chosen) {
          // 檢查 top-N 是否為「不同物件都達門檻」→ 分成兩群：重複委託群 vs 真不同物件群
          const closeRivals = allCandidates.filter((x, i) =>
            i > 0 && x.score >= 130 && x.score >= top1.score - 30
          );
          const duplicateGroup = [top1, ...closeRivals.filter(x => isSamePhysicalProperty(top1.c, x.c))];
          const trulyDifferent = closeRivals.filter(x => !isSamePhysicalProperty(top1.c, x.c));

          if (trulyDifferent.length > 0) {
            results.push({
              adCode: ad.code, community: ad.community || '(無社區)',
              status: 'ambiguous',
              message: '找到 ' + (trulyDifferent.length + 1) + ' 個不同物件都符合條件（本店無此案），請人工確認',
              candidates: [top1.c.caseNoNumber, ...trulyDifferent.map(x => x.c.caseNoNumber)]
            });
            continue;
          }

          // 到這裡 = 只有一組候選（全部都是同一物件的重複委託）
          chosen = pickBestDuplicate(duplicateGroup, userStoreCode);
          isDuplicate = duplicateGroup.length > 1;
        }
        usedKeyword = chosen.kw;
        const isFromOwnStore = userStoreCode && chosen.c.storeCode === userStoreCode;

        const caseKey = chosen.c.caseKey;
        if (!caseKey) {
          results.push({ adCode: ad.code, community: ad.community || '', status: 'no_key', message: '找到物件但沒有 caseKey' });
          continue;
        }
        const ok = await followByCaseKey(caseKey);
        // 訊息細節
        let msg = '';
        if (ok) {
          if (ownStoreShortcut) {
            msg = '已加入關注（本店有此案，直接加入本店那筆' +
              (isDuplicate ? '，聯賣還有其他重複委託' : '') + '）';
          } else if (isDuplicate) {
            msg = '已加入關注（此物件在 i智慧 有重複委託，' +
              (isFromOwnStore ? '已加入本店那筆' : '本店未接，已加入其他店的一筆') + '）';
          } else {
            msg = '已加入關注（用「' + usedKeyword + '」搜尋到）';
          }
        } else {
          msg = '加關注 API 呼叫失敗';
        }
        results.push({
          adCode: ad.code, community: ad.community || '',
          status: ok ? 'followed' : 'follow_failed',
          matchedCode: chosen.c.caseNoNumber,
          matchedCaseKey: chosen.c.caseKey || '',
          matchedName: chosen.c.buildingName || '(無社區)',
          matchedStore: chosen.c.storeCode,
          matchedPrice: chosen.c.totPrice || 0,
          usedKeyword: usedKeyword,
          score: chosen.score,
          message: msg
        });
        // 稍微 delay，避免打太快
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        results.push({ adCode: ad.code, status: 'exception', message: String(e.message || e) });
      }
    }
    return results;
  })();
}

// ============ 取消關注 - 核心邏輯 ============

async function searchAndUnfollowInIzhihuiTab(items) {
  const tab = await chrome.tabs.create({
    url: 'https://is.ycut.com.tw/is/case/search/watch-list',
    active: false
  });
  try {
    await waitForTabComplete(tab.id);
    await wait(2000);
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: unfollowInPage,
      args: [items],
      world: 'MAIN'
    });
    return res && res[0] && res[0].result;
  } finally {
    chrome.tabs.remove(tab.id).catch(function() {});
  }
}

// items 是 watchlist 物件（含 caseKey）
function unfollowInPage(items) {
  return (async function() {
    const results = [];
    for (const w of items) {
      if (!w.caseKey) {
        results.push({ code: w.code, community: w.community, status: 'no_key', message: '沒有 caseKey，無法取消' });
        continue;
      }
      try {
        const res = await fetch('/api/Case/Follow/' + encodeURIComponent(w.caseKey), {
          method: 'DELETE', credentials: 'same-origin',
          headers: { 'Accept': 'application/json, text/plain, */*', 'websiteName': 'IntegrationService_WS' }
        });
        results.push({
          code: w.code, community: w.community || '(無社區)',
          status: res.ok ? 'unfollowed' : 'unfollow_failed',
          message: res.ok ? '已取消關注' : ('取消失敗 HTTP ' + res.status)
        });
        await new Promise(r => setTimeout(r, 400));
      } catch (e) {
        results.push({ code: w.code, community: w.community || '', status: 'exception', message: String(e.message || e) });
      }
    }
    return results;
  })();
}

function showResults(watchlist, ads, warns, modes, apiUserStoreCode) {
  $('progress').style.display = 'none';
  const output = $('output');
  output.style.display = 'block';

  const matchedW = new Set();
  const rows = [];
  let ok = 0, priceMismatch = 0, ad591Only = 0;

  for (const ad of ads) {
    const m = bestMatch(ad, watchlist);
    if (!m.match || m.score < MATCH_THRESHOLD) {
      rows.push({ type: 'bad', label: '✗ 591 多出', ad: ad, match: null,
        action: '此 591 廣告找不到對應的關注物件，請確認是否已成交。若是，須立即下架避免被罰' });
      ad591Only++;
      continue;
    }
    matchedW.add(m.match.code);
    if (m.match.price !== ad.price) {
      rows.push({ type: 'warn', label: '⚠ 價格不一致', ad: ad, match: m.match,
        action: '關注 ' + m.match.price + '萬 ↔ 591 ' + ad.price + '萬，請修改 591 廣告價' });
      priceMismatch++;
    } else {
      rows.push({ type: 'ok', label: '✓ 完美匹配', ad: ad, match: m.match, action: '' });
      ok++;
    }
  }
  let watchOnly = 0;
  for (const w of watchlist) {
    if (!matchedW.has(w.code)) {
      rows.push({ type: 'info', label: 'ℹ 關注沒對應', ad: null, match: w,
        action: '此關注物件在 591 沒有對應廣告（可能漏上架）' });
      watchOnly++;
    }
  }

  const priority = { bad: 0, warn: 1, info: 2, ok: 3 };
  rows.sort(function(a, b) { return priority[a.type] - priority[b.type]; });

  const now = new Date().toLocaleString('zh-TW');
  const rowsHtml = rows.map(renderRow).join('');

  // 健康檢查警告區
  let warnHtml = '';
  if (warns && warns.length > 0) {
    const hasCritical = warns.some(w => w.level === 'critical');
    const bg = hasCritical ? '#ffebee' : '#fff8e1';
    const border = hasCritical ? '#c62828' : '#ff9800';
    warnHtml = '<div style="background:' + bg + '; border-left:4px solid ' + border + '; padding:14px 18px; margin-bottom:16px; border-radius:6px;">' +
      '<strong style="color:' + border + '; font-size:15px;">⚠ 健康檢查警告</strong><ul style="margin:8px 0 0 0; padding-left:20px;">' +
      warns.map(w => '<li style="margin:4px 0;">' + w.msg + '</li>').join('') +
      '</ul>' +
      (hasCritical ? '<div style="margin-top:8px;color:#c62828;font-weight:bold;">⛔ 偵測到嚴重問題，這次的比對結果可能不可信！</div>' : '') +
      '</div>';
  }

  // 模式標示
  const modeBadge = (m, label) => {
    const color = m === 'API' ? '#2e7d32' : '#ef6c00';
    const bg = m === 'API' ? '#e8f5e9' : '#fff3e0';
    return '<span style="background:' + bg + '; color:' + color + '; padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold; margin-left:6px;">' + label + ': ' + m + '</span>';
  };

  // 小提醒列（每次結果都顯示）
  const reminderBar = '<div class="reminder-bar">' +
    '<span>⚠ 比對結果僅供參考，請務必自行人工複核，避免漏判誤判。</span>' +
    '<a id="viewDisclaimerLink">📜 重看使用須知</a>' +
    '</div>';

  output.innerHTML = reminderBar + warnHtml +
    '<div class="summary">' +
    '<div style="display:flex;justify-content:space-between;align-items:start;">' +
    '<div><h2 style="margin:0;color:#ff7a00;">比對結果' +
    modeBadge(modes.izhihui, 'i智慧') + modeBadge(modes.s591, '591') + '</h2>' +
    '<div style="color:#666;margin-top:4px;">關注物件 ' + watchlist.length + ' 筆 ・ 591 廣告 ' + ads.length + ' 筆 ・ ' + now + '</div></div>' +
    '<button class="retry" id="retryBtnResult">🔄 重新比對</button></div>' +
    '<div class="stats">' +
    '<div class="stat ok"><div class="num" id="statOkNum">' + ok + '</div><div class="lbl">完美匹配</div></div>' +
    '<div class="stat warn"><div class="num" id="statWarnNum">' + priceMismatch + '</div><div class="lbl">價格不一致</div></div>' +
    '<div class="stat bad"><div class="num" id="statBadNum">' + ad591Only + '</div><div class="lbl">591 多出</div></div>' +
    '<div class="stat info"><div class="num" id="statInfoNum">' + watchOnly + '</div><div class="lbl">關注沒對應</div></div>' +
    '</div></div>' +
    batchFollowBarHtml(ad591Only) +
    '<div id="followLog" style="display:none;margin-bottom:14px;background:white;padding:14px 18px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);"></div>' +
    batchUnfollowBarHtml(watchOnly) +
    '<div id="unfollowLog" style="display:none;margin-bottom:14px;background:white;padding:14px 18px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);"></div>' +
    '<table><thead><tr><th style="width:110px;">狀態</th><th>591 廣告（編號/社區/價·坪·樓）</th><th>i智慧 關注(編號/社區/價·坪·樓）</th><th>建議動作</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table>' +
    // 逐筆詳細狀態列表放這裡（頁面底部，不擋上方）
    '<div id="followItemLog" style="display:none;margin-top:16px;background:white;padding:14px 18px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);"></div>' +
    '<div id="unfollowItemLog" style="display:none;margin-top:16px;background:white;padding:14px 18px;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.08);"></div>';

  // 綁定「重新比對」按鈕（CSP 禁止 inline onclick）
  const retryBtn = $('retryBtnResult');
  if (retryBtn) retryBtn.addEventListener('click', () => location.reload());

  // 綁定「重看使用須知」連結
  const viewLink = $('viewDisclaimerLink');
  if (viewLink) viewLink.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('disclaimer.html?readonly=1') });
  });

  // 決定使用者本店碼：優先用 API 給的（來自 /api/user 的 departmentId），否則從 watchlist 推導
  let userStoreCode = apiUserStoreCode || '';
  if (!userStoreCode) {
    const storeFreq = {};
    for (const w of watchlist) {
      if (w.storeCode) storeFreq[w.storeCode] = (storeFreq[w.storeCode] || 0) + 1;
    }
    userStoreCode = Object.keys(storeFreq).sort((a, b) => storeFreq[b] - storeFreq[a])[0] || '';
  }

  // 把 userStoreCode 存到 window，供後加的按鈕使用（清空後動態產生的 follow 按鈕）
  window.__userStoreCode = userStoreCode;

  // 綁定「一鍵補齊關注」（batch）與單筆「加關注」按鈕
  const batchBtn = $('batchFollowBtn');
  if (batchBtn) batchBtn.addEventListener('click', () => {
    // 動態掃 DOM 拿當前所有 bad rows（含清空後從 ok/warn 變 bad 的）
    const currentBadAds = collectCurrentBadAds();
    runBatchFollow(currentBadAds, userStoreCode);
  });
  document.querySelectorAll('.follow-single-btn').forEach(btn => {
    bindFollowSingleBtn(btn, userStoreCode);
  });

  // 綁定「一鍵取消關注」（batch）與單筆「取消關注」按鈕
  const infoItems = rows.filter(r => r.type === 'info' && r.match && r.match.caseKey).map(r => r.match);
  const batchUnfollowBtn = $('batchUnfollowBtn');
  if (batchUnfollowBtn) batchUnfollowBtn.addEventListener('click', () => runBatchUnfollow(infoItems));
  document.querySelectorAll('.unfollow-single-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = {
        code: btn.dataset.code,
        community: btn.dataset.community,
        caseKey: btn.dataset.casekey
      };
      await runSingleUnfollow(btn, item);
    });
  });
}

function batchUnfollowBarHtml(watchOnly) {
  if (!watchOnly || watchOnly < 1) return '';
  return '<div style="background:#ffebee;border-left:4px solid #c62828;padding:12px 18px;margin-bottom:14px;border-radius:6px;display:flex;justify-content:space-between;align-items:center;">' +
    '<div><strong style="color:#c62828;">🗑 一鍵取消 i智慧 關注（清理過期）</strong>' +
    '<div style="font-size:12px;color:#555;margin-top:2px;">「關注沒對應」的 ' + watchOnly + ' 筆 = i智慧 有關注但 591 沒對應廣告（廣告可能過期/成交/從沒上架）<br>' +
    '<span style="color:#c62828;">⚠ 執行前請務必確認！這是不可逆操作。</span></div></div>' +
    '<button id="batchUnfollowBtn" style="background:#c62828;color:white;border:0;padding:10px 18px;font-size:14px;border-radius:6px;cursor:pointer;font-weight:bold;">' +
    '🗑 全部取消關注（' + watchOnly + ' 筆）</button></div>';
}

async function runSingleUnfollow(btn, item) {
  const resultSpan = btn.parentElement.querySelector('.unfollow-single-result');
  if (!(await assertCoreAccess())) return;
  if (!confirm('確定要取消 i智慧 關注「' + (item.community || item.code) + '」？此動作不可還原。')) return;
  btn.disabled = true;
  btn.textContent = '⏳ 取消中...';
  try {
    const results = await searchAndUnfollowInIzhihuiTab([item]);
    const r = (results || [])[0];
    if (!r) throw new Error('無回應');
    if (r.status === 'unfollowed') {
      btn.textContent = '✅ 已取消';
      btn.style.background = '#999';
      if (resultSpan) resultSpan.innerHTML = '<span style="color:#2e7d32;">→ 已從 i智慧 關注移除</span>';
      // 即時更新表格 row + 統計
      const infoTr = document.querySelector('tr[data-infocode="' + item.code + '"]');
      if (infoTr && infoTr.getAttribute('data-type') === 'info') {
        const badge = infoTr.querySelector('.badge');
        if (badge) { badge.className = 'badge'; badge.textContent = '✅ 已從 i智慧 移除'; badge.style.background = '#999'; badge.style.color = 'white'; }
        infoTr.style.opacity = '0.5';
        const actionCell = infoTr.querySelector('.action-cell');
        if (actionCell) actionCell.innerHTML = '<span style="color:#666;">已從 i智慧 關注清單移除</span>';
        bumpStat('statInfoNum', -1);
        infoTr.setAttribute('data-type', 'removed');
      }
    } else {
      btn.textContent = '❌ 失敗';
      btn.disabled = false;
      if (resultSpan) resultSpan.innerHTML = '<span style="color:#c62828;">' + r.message + '</span>';
    }
  } catch (e) {
    btn.textContent = '❌ 錯誤';
    btn.disabled = false;
    if (resultSpan) resultSpan.innerHTML = '<span style="color:#c62828;">' + String(e.message || e) + '</span>';
  }
}

async function runBatchUnfollow(items) {
  if (!items || items.length === 0) return;
  if (!(await assertCoreAccess())) return;
  if (!confirm('⚠ 確定要一次取消 ' + items.length + ' 筆 i智慧 關注？\n\n這通常用於清理「591 廣告已過期/成交但 i智慧 還在關注」的情況。\n\n請確認這 ' + items.length + ' 筆真的都是無效物件！此動作不可還原。')) return;

  const batchBtn = $('batchUnfollowBtn');
  const logEl = $('unfollowLog');
  const itemLogEl = $('unfollowItemLog');
  if (batchBtn) { batchBtn.disabled = true; batchBtn.textContent = '⏳ 準備中...'; }

  if (logEl) {
    logEl.style.display = 'block';
    logEl.innerHTML =
      '<div style="background:#e0e0e0;border-radius:6px;height:12px;overflow:hidden;">' +
        '<div id="unfollowProgressFill" style="background:linear-gradient(90deg,#c62828,#e53935);height:100%;width:0%;transition:width 0.3s ease;"></div>' +
      '</div>' +
      '<div id="unfollowProgressText" style="margin-top:8px;font-size:13px;color:#444;font-weight:bold;">準備開始…</div>';
  }
  if (itemLogEl) {
    itemLogEl.style.display = 'block';
    itemLogEl.innerHTML =
      '<h3 style="margin:0 0 10px;color:#c62828;">🗑 批次取消關注 - 逐筆狀態</h3>' +
      '<div id="unfollowLogList" style="font-size:13px;line-height:1.7;max-height:500px;overflow-y:auto;padding:4px;background:#fafafa;border-radius:4px;"></div>';
  }
  const progressFill = $('unfollowProgressFill');
  const progressText = $('unfollowProgressText');
  const listEl = $('unfollowLogList');

  if (listEl) {
    listEl.innerHTML = items.map((w, idx) =>
      '<div id="unfollow-row-' + idx + '" style="color:#999;padding:3px 6px;border-bottom:1px dashed #eee;">' +
      '⏳ <b>' + w.code + '</b>「' + (w.community || '(無社區)') + '」— 待處理…</div>'
    ).join('');
  }

  let ok = 0, failed = 0;
  let tab = null;
  try {
    if (progressText) progressText.textContent = '⏳ 開啟 i智慧 背景分頁…';
    tab = await chrome.tabs.create({ url: 'https://is.ycut.com.tw/is/case/search/watch-list', active: false });
    await waitForTabComplete(tab.id);
    await wait(1500);

    for (let i = 0; i < items.length; i++) {
      const w = items[i];
      const rowEl = document.getElementById('unfollow-row-' + i);
      if (rowEl) {
        rowEl.style.color = '#1565c0';
        rowEl.innerHTML = '⏳ <b>' + w.code + '</b>「' + (w.community || '(無社區)') + '」— <i>取消中…</i>';
      }
      if (progressText) progressText.textContent = '處理中 ' + (i+1) + '/' + items.length + '：' + w.code + '「' + (w.community || '?') + '」';

      let result;
      try {
        const scriptRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: unfollowInPage,
          args: [[w]],
          world: 'MAIN'
        });
        result = (scriptRes && scriptRes[0] && scriptRes[0].result || [])[0] || { status: 'exception', message: '無回應' };
      } catch (e) {
        result = { status: 'exception', message: String(e.message || e) };
      }

      let icon = '❌', color = '#c62828';
      if (result.status === 'unfollowed') { icon = '✅'; color = '#2e7d32'; ok++; }
      else { failed++; }

      if (rowEl) {
        rowEl.style.color = color;
        // i智慧 編號 → 加超連結
        const izCode = w.caseKey
          ? '<a href="https://is.ycut.com.tw/is/case/detail/' + encodeURIComponent(w.caseKey) +
            '" target="_blank" rel="noopener" style="color:#1565c0;text-decoration:none;font-weight:bold;">' + w.code + ' 🔗</a>'
          : '<b>' + w.code + '</b>';
        rowEl.innerHTML = icon + ' ' + izCode + '「' + (w.community || '(無社區)') + '」 <span style="opacity:0.85;">— ' + (result.message || result.status) + '</span>';
      }

      const pct = ((i + 1) / items.length * 100).toFixed(1);
      if (progressFill) progressFill.style.width = pct + '%';
      if (batchBtn) batchBtn.textContent = '⏳ 進行中... (' + (i + 1) + '/' + items.length + ')';

      if (result.status === 'unfollowed') {
        const singleBtn = document.querySelector('.unfollow-single-btn[data-code="' + w.code + '"]');
        if (singleBtn) {
          singleBtn.disabled = true;
          singleBtn.textContent = '✅ 已取消';
          singleBtn.style.background = '#999';
        }
        // 找對應表格 row：先找 info（關注沒對應），再找 matched（完美匹配/價格不一致）
        const infoTr = document.querySelector('tr[data-infocode="' + w.code + '"]');
        const matchTr = document.querySelector('tr[data-matchcode="' + w.code + '"]');
        if (infoTr && infoTr.getAttribute('data-type') === 'info') {
          // 「關注沒對應」行 → 標記已移除
          const badge = infoTr.querySelector('.badge');
          if (badge) { badge.className = 'badge'; badge.textContent = '✅ 已從 i智慧 移除'; badge.style.background = '#999'; badge.style.color = 'white'; }
          infoTr.style.opacity = '0.5';
          const actionCell = infoTr.querySelector('.action-cell');
          if (actionCell) actionCell.innerHTML = '<span style="color:#666;">已從 i智慧 關注清單移除</span>';
          bumpStat('statInfoNum', -1);
          infoTr.setAttribute('data-type', 'removed');
        }
        if (matchTr && (matchTr.getAttribute('data-type') === 'ok' || matchTr.getAttribute('data-type') === 'warn')) {
          // 「完美匹配」或「價格不一致」行 → i智慧 移除後變成「591 多出」
          const oldType = matchTr.getAttribute('data-type');
          const badge = matchTr.querySelector('.badge');
          if (badge) { badge.className = 'badge bad'; badge.textContent = '✗ 591 多出'; badge.style.background = ''; badge.style.color = ''; }
          const izCell = matchTr.querySelector('.izhihui-cell');
          if (izCell) izCell.innerHTML = '<span style="color:#999;">— (剛從 i智慧 移除)</span>';
          matchTr.setAttribute('data-type', 'bad');
          matchTr.removeAttribute('data-matchcode');
          // 補加「加入 i智慧 關注」按鈕（讓下一輪加關注能作用）
          const actionCell = matchTr.querySelector('.action-cell');
          if (actionCell) {
            // 從 ad-cell 抓 591 code
            const adCodeLink = matchTr.querySelector('.ad-cell a');
            const adCode = adCodeLink ? (adCodeLink.textContent || '').replace(/[^S\d]/g, '') : '';
            // 從 ad-cell 抓其他 ad 資料（社區、價、坪、樓）— 從 ad-cell 內解析
            const adCellText = matchTr.querySelector('.ad-cell').innerText;
            // 簡單解析：先看 boldedName
            const boldName = matchTr.querySelector('.ad-cell b');
            const community = boldName ? boldName.textContent : '';
            // 價/坪/樓 從 text 解析
            const priceMatch = adCellText.match(/([\d,]+)\s*萬/);
            const areaMatch = adCellText.match(/([\d.]+)\s*坪/);
            const floorMatch = adCellText.match(/(-?\d+)\s*F/);
            const ad = {
              code: adCode,
              community: community === '(無社區)' ? '' : community,
              price: priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : 0,
              area: areaMatch ? parseFloat(areaMatch[1]) : 0,
              floor: floorMatch ? parseInt(floorMatch[1]) : 0,
              isLand: adCellText.indexOf('[土地]') >= 0,
              street: '',
              title: ''
            };
            actionCell.innerHTML = '<div style="color:#c62828;">此 591 廣告已無 i智慧 對應，請確認是否已成交</div>' +
              makeFollowSingleBtnHtml(ad);
            // 綁定新按鈕
            const newBtn = actionCell.querySelector('.follow-single-btn');
            if (newBtn) bindFollowSingleBtn(newBtn, window.__userStoreCode || '');
          }
          // 統計更新
          if (oldType === 'ok') bumpStat('statOkNum', -1);
          else if (oldType === 'warn') bumpStat('statWarnNum', -1);
          bumpStat('statBadNum', 1);
        }
      }
    }
    // 批次完成後，重新渲染 batch follow 按鈕的文字/顏色
    refreshBatchFollowBtnUi();

    if (progressText) progressText.innerHTML =
      '✅ <b>全部完成！</b>&nbsp;&nbsp;取消成功 <b style="color:#2e7d32;">' + ok + '</b> 筆 ・ 失敗 <b style="color:#c62828;">' + failed + '</b> 筆';
    if (batchBtn) {
      batchBtn.textContent = '✅ 完成（取消 ' + ok + ' / ' + items.length + '）';
      batchBtn.style.background = '#999';
    }
  } catch (e) {
    if (progressText) progressText.textContent = '❌ 執行錯誤：' + String(e.message || e);
    if (batchBtn) { batchBtn.disabled = false; batchBtn.textContent = '🗑 重試'; }
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(function() {});
  }
}

// 上方「一鍵補齊 i智慧 關注」按鈕
function batchFollowBarHtml(ad591Only) {
  const hasItems = ad591Only > 0;
  const bg = hasItems ? '#e8f5e9' : '#f5f5f5';
  const borderColor = hasItems ? '#12805c' : '#bdbdbd';
  const titleColor = hasItems ? '#12805c' : '#757575';
  const subtitle = hasItems
    ? '對「591 多出」的 ' + ad591Only + ' 筆，自動用聯賣範圍搜尋 i智慧 → 精準匹配 → 加入關注'
    : '目前沒有需要加關注的物件';
  const btnBg = hasItems ? '#12805c' : '#bdbdbd';
  const btnText = hasItems ? '🎯 全部加關注（' + ad591Only + ' 筆）' : '🎯 無需加關注（0 筆）';
  const btnCursor = hasItems ? 'pointer' : 'not-allowed';
  const disabledAttr = hasItems ? '' : ' disabled';
  return '<div style="background:' + bg + ';border-left:4px solid ' + borderColor + ';padding:12px 18px;margin-bottom:14px;border-radius:6px;display:flex;justify-content:space-between;align-items:center;">' +
    '<div><strong style="color:' + titleColor + ';">🎯 一鍵補齊 i智慧 關注</strong>' +
    '<div style="font-size:12px;color:#555;margin-top:2px;">' + subtitle + '</div></div>' +
    '<button id="batchFollowBtn"' + disabledAttr + ' style="background:' + btnBg + ';color:white;border:0;padding:10px 18px;font-size:14px;border-radius:6px;cursor:' + btnCursor + ';font-weight:bold;">' +
    btnText + '</button></div>';
}

async function runSingleFollow(btn, ad, userStoreCode) {
  const resultSpan = btn.parentElement.querySelector('.follow-single-result');
  if (!(await assertCoreAccess())) return;
  btn.disabled = true;
  btn.textContent = '⏳ 搜尋中...';
  try {
    const results = await searchAndFollowInIzhihuiTab([ad], userStoreCode);
    const r = (results || [])[0];
    if (!r) throw new Error('無回應');
    if (r.status === 'followed') {
      btn.textContent = '✅ 已加關注';
      btn.style.background = '#4caf50';
      if (resultSpan) resultSpan.innerHTML = '<span style="color:#2e7d32;">→ i智慧 ' + r.matchedCode + ' ' + (r.matchedName || '') + '</span>';
      // 即時更新表格 row + 上方統計
      const tr = document.querySelector('tr[data-adcode="' + ad.code + '"]');
      if (tr && r.matchedCode) {
        const izCell = tr.querySelector('.izhihui-cell');
        if (izCell) {
          const link = r.matchedCaseKey
            ? '<a href="https://is.ycut.com.tw/is/case/detail/' + encodeURIComponent(r.matchedCaseKey) +
              '" target="_blank" rel="noopener" style="color:#1565c0;text-decoration:none;font-weight:bold;" title="剛加入的關注">' +
              r.matchedCode + ' 🔗</a>'
            : r.matchedCode;
          izCell.innerHTML = '<span style="background:#e8f5e9;color:#2e7d32;font-size:11px;padding:2px 6px;border-radius:10px;margin-right:4px;">剛加入</span>' +
            link + '<br><b>' + (r.matchedName || '(無社區)') + '</b>' +
            (r.matchedStore ? '<br><span style="color:#666;font-size:12px;">' + r.matchedStore + '</span>' : '');
        }
        const priceMatch = (r.matchedPrice || 0) === (ad.price || 0);
        const newType = priceMatch ? 'ok' : 'warn';
        const newLabel = priceMatch ? '✓ 完美匹配' : '⚠ 價格不一致';
        const badge = tr.querySelector('.badge');
        if (badge) { badge.className = 'badge ' + newType; badge.textContent = newLabel; }
        tr.setAttribute('data-type', newType);
        bumpStat('statBadNum', -1);
        if (priceMatch) bumpStat('statOkNum', 1);
        else bumpStat('statWarnNum', 1);
      }
    } else if (r.status === 'not_found') {
      btn.textContent = '⚠ 找不到';
      btn.style.background = '#ef6c00';
      btn.disabled = false;
      if (resultSpan) resultSpan.innerHTML = '<span style="color:#ef6c00;">' + r.message + '</span>';
    } else if (r.status === 'ambiguous') {
      btn.textContent = '⚠ 需人工確認';
      btn.style.background = '#8e24aa';
      btn.disabled = false;
      if (resultSpan) resultSpan.innerHTML = '<span style="color:#8e24aa;">' + r.message + (r.candidates ? '（候選：' + r.candidates.join('、') + '）' : '') + '</span>';
    } else {
      btn.textContent = '❌ 失敗';
      btn.style.background = '#c62828';
      btn.disabled = false;
      if (resultSpan) resultSpan.innerHTML = '<span style="color:#c62828;">' + r.message + '</span>';
    }
  } catch (e) {
    btn.textContent = '❌ 錯誤';
    btn.style.background = '#c62828';
    btn.disabled = false;
    if (resultSpan) resultSpan.innerHTML = '<span style="color:#c62828;">' + String(e.message || e) + '</span>';
  }
}

async function runBatchFollow(items, userStoreCode) {
  if (!items || items.length === 0) return;
  if (!(await assertCoreAccess())) return;
  const batchBtn = $('batchFollowBtn');
  const logEl = $('followLog');          // 上方：只放進度條 + summary
  const itemLogEl = $('followItemLog');  // 下方（表格底下）：逐筆詳細狀態
  if (batchBtn) { batchBtn.disabled = true; batchBtn.textContent = '⏳ 準備中...'; }

  // 上方：進度條 + summary
  if (logEl) {
    logEl.style.display = 'block';
    logEl.innerHTML =
      '<div style="background:#e0e0e0;border-radius:6px;height:12px;overflow:hidden;">' +
        '<div id="followProgressFill" style="background:linear-gradient(90deg,#12805c,#2e7d32);height:100%;width:0%;transition:width 0.3s ease;"></div>' +
      '</div>' +
      '<div id="followProgressText" style="margin-top:8px;font-size:13px;color:#444;font-weight:bold;">準備開始…</div>';
  }
  // 下方（頁面底）：逐筆狀態列表
  if (itemLogEl) {
    itemLogEl.style.display = 'block';
    itemLogEl.innerHTML =
      '<h3 style="margin:0 0 10px;color:#12805c;">🎯 批次加關注 - 逐筆狀態</h3>' +
      '<div id="followLogList" style="font-size:13px;line-height:1.7;max-height:500px;overflow-y:auto;padding:4px;background:#fafafa;border-radius:4px;"></div>';
  }
  const progressFill = $('followProgressFill');
  const progressText = $('followProgressText');
  const listEl = $('followLogList');

  // 預先建立每一筆的 slot（顯示 pending）
  if (listEl) {
    listEl.innerHTML = items.map((ad, idx) =>
      '<div id="follow-row-' + idx + '" style="color:#999;padding:3px 6px;border-bottom:1px dashed #eee;">' +
      '⏳ <b>' + ad.code + '</b>「' + (ad.community || '(無社區)') + '」— 待處理…</div>'
    ).join('');
  }

  let ok = 0, notFound = 0, ambiguous = 0, failed = 0;
  let tab = null;
  try {
    if (progressText) progressText.textContent = '⏳ 開啟 i智慧 背景分頁…';
    tab = await chrome.tabs.create({ url: 'https://is.ycut.com.tw/is/case/search/all-case', active: false });
    await waitForTabComplete(tab.id);
    await wait(1500);

    for (let i = 0; i < items.length; i++) {
      const ad = items[i];
      const rowEl = document.getElementById('follow-row-' + i);
      if (rowEl) {
        rowEl.style.color = '#1565c0';
        rowEl.innerHTML = '⏳ <b>' + ad.code + '</b>「' + (ad.community || '(無社區)') + '」— <i>搜尋中…</i>';
      }
      if (progressText) progressText.textContent = '處理中 ' + (i+1) + '/' + items.length + '：' + ad.code + '「' + (ad.community || '?') + '」';

      let result;
      try {
        const scriptRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: searchAndFollowInPage,
          args: [[ad], userStoreCode || ''],
          world: 'MAIN'
        });
        result = (scriptRes && scriptRes[0] && scriptRes[0].result || [])[0] || { status: 'exception', message: '無回應' };
      } catch (e) {
        result = { status: 'exception', message: String(e.message || e) };
      }

      let icon = '❓', color = '#999';
      if (result.status === 'followed') { icon = '✅'; color = '#2e7d32'; ok++; }
      else if (result.status === 'not_found') { icon = '⚠'; color = '#ef6c00'; notFound++; }
      else if (result.status === 'ambiguous') { icon = '⚠'; color = '#8e24aa'; ambiguous++; }
      else { icon = '❌'; color = '#c62828'; failed++; }

      if (rowEl) {
        rowEl.style.color = color;
        // 591 編號 → 591 列表連結
        const adLink = '<a href="https://user.591.com.tw/ware/open?keywords=' + encodeURIComponent(ad.code) +
          '" target="_blank" rel="noopener" style="color:#ff7a00;text-decoration:none;font-weight:bold;">' + ad.code + ' 🔗</a>';
        // i智慧 編號 → i智慧 detail 連結（有 caseKey 才能連）
        let matchedHtml = '';
        if (result.matchedCode) {
          const izCode = result.matchedCaseKey
            ? '<a href="https://is.ycut.com.tw/is/case/detail/' + encodeURIComponent(result.matchedCaseKey) +
              '" target="_blank" rel="noopener" style="color:#1565c0;text-decoration:none;font-weight:bold;">' + result.matchedCode + ' 🔗</a>'
            : '<b>' + result.matchedCode + '</b>';
          matchedHtml = ' → i智慧 ' + izCode + ' ' + (result.matchedName || '') +
            (result.matchedStore ? ' (' + result.matchedStore + ')' : '');
        }
        rowEl.innerHTML = icon + ' ' + adLink + '「' + (ad.community || '(無社區)') + '」' +
          matchedHtml +
          ' <span style="opacity:0.85;">— ' + (result.message || result.status) + '</span>' +
          (result.candidates ? ' <span style="opacity:0.7;">候選：' + result.candidates.join('、') + '</span>' : '');
      }

      // 更新進度條與按鈕文字
      const pct = ((i + 1) / items.length * 100).toFixed(1);
      if (progressFill) progressFill.style.width = pct + '%';
      if (batchBtn) batchBtn.textContent = '⏳ 進行中... (' + (i + 1) + '/' + items.length + ')';

      // 同步更新該筆的單筆按鈕 + 更新表格 i智慧 cell + 即時更新統計
      if (result.status === 'followed') {
        const singleBtn = document.querySelector('.follow-single-btn[data-adcode="' + ad.code + '"]');
        if (singleBtn) {
          singleBtn.disabled = true;
          singleBtn.textContent = '✅ 已加關注';
          singleBtn.style.background = '#4caf50';
        }
        // 更新表格 row
        const tr = document.querySelector('tr[data-adcode="' + ad.code + '"]');
        if (tr && result.matchedCode) {
          const izCell = tr.querySelector('.izhihui-cell');
          if (izCell) {
            const link = result.matchedCaseKey
              ? '<a href="https://is.ycut.com.tw/is/case/detail/' + encodeURIComponent(result.matchedCaseKey) +
                '" target="_blank" rel="noopener" style="color:#1565c0;text-decoration:none;font-weight:bold;" title="剛加入的關注">' +
                result.matchedCode + ' 🔗</a>'
              : result.matchedCode;
            izCell.innerHTML = '<span style="background:#e8f5e9;color:#2e7d32;font-size:11px;padding:2px 6px;border-radius:10px;margin-right:4px;">剛加入</span>' +
              link + '<br><b>' + (result.matchedName || '(無社區)') + '</b>' +
              (result.matchedStore ? '<br><span style="color:#666;font-size:12px;">' + result.matchedStore + '</span>' : '');
          }
          // 判斷是完美匹配還是價格不一致
          const priceMatch = (result.matchedPrice || 0) === (ad.price || 0);
          const newType = priceMatch ? 'ok' : 'warn';
          const newLabel = priceMatch ? '✓ 完美匹配' : '⚠ 價格不一致';
          const badge = tr.querySelector('.badge');
          if (badge) { badge.className = 'badge ' + newType; badge.textContent = newLabel; }
          tr.setAttribute('data-type', newType);
          // 更新 action cell（把加關注按鈕移掉，換成建議動作）
          const actionCell = tr.querySelector('.action-cell');
          if (actionCell) {
            if (priceMatch) {
              actionCell.innerHTML = '<span style="color:#2e7d32;">✓ 已加關注，價格一致</span>';
            } else {
              actionCell.innerHTML = '<span style="color:#ef6c00;">關注 ' + (result.matchedPrice || 0) + '萬 ↔ 591 ' + (ad.price || 0) + '萬，請修改 591 廣告價</span>';
            }
          }
          // 即時更新上方統計
          bumpStat('statBadNum', -1);
          if (priceMatch) bumpStat('statOkNum', 1);
          else bumpStat('statWarnNum', 1);
        }
      } else if (result.status === 'ambiguous') {
        const singleBtn = document.querySelector('.follow-single-btn[data-adcode="' + ad.code + '"]');
        if (singleBtn) {
          singleBtn.textContent = '⚠ 需人工確認';
          singleBtn.style.background = '#8e24aa';
          singleBtn.disabled = false;
        }
      }
    }

    // 完成 summary
    if (progressText) progressText.innerHTML =
      '✅ <b>全部完成！</b>&nbsp;&nbsp;成功 <b style="color:#2e7d32;">' + ok + '</b> 筆 ・ 找不到 <b style="color:#ef6c00;">' + notFound + '</b> 筆 ・ 需人工確認 <b style="color:#8e24aa;">' + ambiguous + '</b> 筆 ・ 失敗 <b style="color:#c62828;">' + failed + '</b> 筆';
    // 完成後根據當前 statBadNum 重新渲染按鈕（讓下一輪能再按）
    setTimeout(() => refreshBatchFollowBtnUi(), 800);
  } catch (e) {
    if (progressText) progressText.textContent = '❌ 執行錯誤：' + String(e.message || e);
    if (batchBtn) { batchBtn.disabled = false; batchBtn.textContent = '🎯 重試'; }
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(function() {});
  }
}

// ============ 主流程 ============

async function main() {
  const t0 = Date.now();
  try {
    const zResult = await scrapeIzhihui();
    const watchlist = zResult.items;
    if (!watchlist || watchlist.length === 0) {
      showError('沒有抓到 i智慧 關注物件',
        '可能你還沒登入 i智慧，或關注清單是空的。\n請打開新分頁 → 進入 https://is.ycut.com.tw/ → 登入 → 然後回來按「重新比對」');
      return;
    }
    setStatus('已抓 ' + watchlist.length + ' 筆 i智慧 關注（' + zResult.mode + ' 模式），開始抓 591…');

    const sResult = await scrape591();
    const ads = sResult.items;
    if (!ads || ads.length === 0) {
      showError('沒有抓到 591 廣告',
        '可能你還沒登入 591 會員中心。\n請打開新分頁 → 進入 https://user.591.com.tw/ → 登入 → 然後回來按「重新比對」');
      return;
    }
    const t1 = Date.now();
    setStatus('已抓 ' + ads.length + ' 筆 591 廣告（' + ((t1-t0)/1000).toFixed(1) + ' 秒），比對中…');
    await wait(200);

    const warns = healthCheck(watchlist, ads, zResult.mode, sResult.mode);
    showResults(watchlist, ads, warns, { izhihui: zResult.mode, s591: sResult.mode }, zResult.userStoreCode);
  } catch (e) {
    showError('比對過程中發生錯誤', e.message || String(e));
    console.error(e);
  }
}

async function startIfAccessAllowed() {
  const access = await checkLiveCoreAccess();

  if (!access.allowed) {
    $('output').style.display = 'none';
    $('progress').style.display = '';
    $('progress').innerHTML =
      '<h2 style="color:#c62828;margin:0 0 12px;">無法開始比對</h2>' +
      '<div class="error">' + access.message + '</div>';
    return;
  }

  $('progress').style.display = '';
  main();
}

startIfAccessAllowed();
