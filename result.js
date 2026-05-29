// ============================================================
// 591 vs i智慧 自動比對工具 v6
// ============================================================
// v6 新增：
//   ★ 首次使用須顯示使用須知並同意才能用
//   ★ 結果頁顯示小提醒列，可隨時重看須知
// v5 已有：
//   ★ 健康檢查：偵測 API 異常並警告
//   ★ 備用模式：API 失敗時自動退回 DOM 抓取
// ============================================================

const DISCLAIMER_VERSION = 1;
const DISCLAIMER_STORAGE_KEY = 'disclaimerAccepted_v' + DISCLAIMER_VERSION;
const LICENSE_STATUS_API = 'https://ycut-license-api.sir8713642.workers.dev/api/license-status';
const TRIAL_STATUS_API = 'https://ycut-license-api.sir8713642.workers.dev/api/trial-status';
const PRODUCT_ID = 'listing_compare';
const TRIAL_DAYS = 3;
const TRIAL_STORAGE_KEY = 'trial_started_at_' + PRODUCT_ID;
const LICENSE_CACHE_TTL_MS = 30 * 60 * 1000;
let lastLicenseCheck = null;

function $(id) { return document.getElementById(id); }
function setStatus(msg) { const el = $('statusMsg'); if (el) el.textContent = msg; }
function wait(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function showError(title, detail) {
  $('progress').innerHTML =
    '<h2 style="color:#c62828;margin:0 0 12px;">⚠ ' + title + '</h2>' +
    '<div class="error"><div style="white-space:pre-wrap;">' + detail + '</div>' +
    '<button class="retry" onclick="location.reload()">🔄 重新比對</button></div>' +
    '<div style="margin-top:18px;font-size:13px;color:#666;text-align:left;">' +
    '<strong>常見原因：</strong><ul>' +
    '<li>還沒登入 i智慧 或 591 → 請先登入兩個網站</li>' +
    '<li>網路慢 → 直接按「重新比對」</li>' +
    '<li>網站改版 → 請通知工具製作者更新</li>' +
    '</ul></div>';
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

async function getTrialInfo(googleAccount, installId) {
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
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data && data.success) {
      return {
        startedAt: data.trial_started_at,
        expiresAt: data.trial_expires_at,
        remainingMs: new Date(data.trial_expires_at || 0).getTime() - Date.now(),
        active: !!data.active
      };
    }
    return { active: false };
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

function taiwanDateString() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function isExpiredLicenseDate(expiresOn) {
  return !/^\d{4}-\d{2}-\d{2}$/.test(String(expiresOn || '')) || taiwanDateString() > expiresOn;
}

async function hasFreshLicenseCache(installId) {
  const stored = await chrome.storage.local.get([
    'license_status',
    'qr_licensed_install_id',
    'last_verified_at',
    'license_expires_on'
  ]);

  if (stored.license_status !== 'valid' || stored.qr_licensed_install_id !== installId) {
    return false;
  }

  if (isExpiredLicenseDate(stored.license_expires_on)) {
    lastLicenseCheck = { reason: 'expired', expires_on: stored.license_expires_on || null };
    await chrome.storage.local.set({ license_status: 'invalid' });
    return false;
  }

  const verifiedAt = new Date(stored.last_verified_at || 0).getTime();
  return Number.isFinite(verifiedAt) && Date.now() - verifiedAt < LICENSE_CACHE_TTL_MS;
}

async function checkQrLicenseStatus() {
  const installId = await getOrCreateInstallId();
  const url = LICENSE_STATUS_API +
    '?product_id=' + encodeURIComponent(PRODUCT_ID) +
    '&install_id=' + encodeURIComponent(installId);

  const res = await fetch(url);
  const data = await res.json();

  if (data && data.success && data.active) {
    lastLicenseCheck = data;
    await chrome.storage.local.set({
      license_status: 'valid',
      qr_licensed_install_id: installId,
      last_verified_at: new Date().toISOString(),
      license_expires_on: data.expires_on
    });
    return true;
  }

  lastLicenseCheck = data;
  await chrome.storage.local.set({
    license_status: 'invalid',
    license_expires_on: data?.expires_on || null
  });
  return false;
}

async function checkLicenseAccess() {
  const installId = await getOrCreateInstallId();

  if (await hasFreshLicenseCache(installId)) {
    return { allowed: true, mode: 'license', message: '授權快取有效。' };
  }

  try {
    if (await checkQrLicenseStatus()) {
      return { allowed: true, mode: 'license', message: '授權有效。' };
    }
  } catch (e) {
    if (await hasFreshLicenseCache(installId)) {
      return { allowed: true, mode: 'license', message: '授權暫以本機狀態通過，稍後會再驗證。' };
    }
  }

  const googleAccount = await getChromeGoogleAccount();
  if (googleAccount) {
    await chrome.storage.local.set({ google_account: googleAccount });
  } else {
    await chrome.storage.local.remove('google_account');
  }

  const trial = await getTrialInfo(googleAccount, installId);
  if (trial.active) {
    return {
      allowed: true,
      mode: 'trial',
      message: ''
    };
  }

  return {
    allowed: false,
    mode: 'expired',
    message: lastLicenseCheck?.reason === 'expired'
      ? `授權已於 ${lastLicenseCheck.expires_on || '設定期限'} 到期，請回到擴充工具重新產生 QR Code 授權。`
      : '請回到擴充工具視窗，產生 QR Code 並請管理員核准。'
  };
}

async function refreshLicenseUi() {
  return await checkLicenseAccess();
}

async function saveAndVerifyLicenseFromInput() {
  return false;
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
          community: c.buildingName || '',
          price: c.totPrice,
          area: area,
          floor: c.floorSt || c.upFloor || 0,
          room: c.rm || 0,
          bath: c.bathRm || 0,
          isLand: isLand,
          useType: c.useCodeName || ''
        });
      }
      if (list.length < 100) break;
    }
    return all;
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
  try {
    await waitForTabComplete(tab.id);
    await wait(1500);
    setStatus('呼叫 i智慧 API…');
    try {
      const r = await scrapeIzhihui_API_in_tab(tab.id);
      if (r && !r.error && Array.isArray(r) && r.length > 0) {
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
    return { items: items || [], mode };
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
          isLand: isLand
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
  if (watchlist && watchlist.length > 0) {
    const withCommunity = watchlist.filter(w => w.community).length;
    const withPrice = watchlist.filter(w => w.price > 0).length;
    if (withCommunity / watchlist.length < 0.3) {
      warns.push({ level: 'high', msg: '⚠ i智慧 有 ' + (watchlist.length - withCommunity) + ' 筆物件沒社區名 — API 結構可能改變' });
    }
    if (withPrice / watchlist.length < 0.9) {
      warns.push({ level: 'high', msg: '⚠ i智慧 有 ' + (watchlist.length - withPrice) + ' 筆物件沒價格 — 結果可能不準' });
    }
  }
  if (ads && ads.length > 0) {
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
  return s.toUpperCase().replace(/大廈|華廈|社區|\(|\)|（|）|\/|・|·|\s|　/g, '');
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
    if (w.price === ad.price) score += 100;
    else if (Math.abs(w.price - ad.price) <= 2) score += 60;
    else if (Math.abs(w.price - ad.price) / Math.max(w.price, 1) <= 0.05) score += 30;
    if (ad.area && w.area && Math.abs(ad.area - w.area) <= 1) score += 60;
    else if (ad.area && w.area && Math.abs(ad.area - w.area) <= 3) score += 25;
    if (!ad.isLand && !w.isLand && ad.floor === w.floor && ad.floor !== 0) score += 40;
    if (ad.room && w.room && ad.room === w.room) score += 15;
    if (ad.bath && w.bath && ad.bath === w.bath) score += 10;
    if (score > bestScore) { bestScore = score; best = w; }
  }
  return { match: best, score: bestScore };
}

const MATCH_THRESHOLD = 130;

function renderRow(r) {
  const adCell = r.ad
    ? (r.ad.code + '<br><b>' + (r.ad.community || (r.ad.title || '').substring(0, 18) || '(無社區)') + '</b><br>' +
       r.ad.price.toLocaleString() + ' 萬 / ' + r.ad.area + '坪 / ' + (r.ad.floor || '-') + 'F' +
       (r.ad.isLand ? ' [土地]' : ''))
    : '—';
  const matchCell = r.match
    ? (r.match.code + '<br><b>' + (r.match.community || '(無社區)') + '</b><br>' +
       r.match.price.toLocaleString() + ' 萬 / ' + r.match.area + '坪 / ' + (r.match.floor || '-') + 'F' +
       (r.match.isLand ? ' [土地]' : ''))
    : '—';
  const action = r.action || '<span style="color:#999;">無須動作</span>';
  return '<tr><td><span class="badge ' + r.type + '">' + r.label + '</span></td>' +
    '<td>' + adCell + '</td><td>' + matchCell + '</td><td>' + action + '</td></tr>';
}

function showResults(watchlist, ads, warns, modes) {
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
    '<button class="retry" onclick="location.reload()">🔄 重新比對</button></div>' +
    '<div class="stats">' +
    '<div class="stat ok"><div class="num">' + ok + '</div><div class="lbl">完美匹配</div></div>' +
    '<div class="stat warn"><div class="num">' + priceMismatch + '</div><div class="lbl">價格不一致</div></div>' +
    '<div class="stat bad"><div class="num">' + ad591Only + '</div><div class="lbl">591 多出</div></div>' +
    '<div class="stat info"><div class="num">' + watchOnly + '</div><div class="lbl">關注沒對應</div></div>' +
    '</div></div>' +
    '<table><thead><tr><th style="width:110px;">狀態</th><th>591 廣告（編號/社區/價·坪·樓）</th><th>i智慧 關注（編號/社區/價·坪·樓）</th><th>建議動作</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody></table>';

  // 綁定「重看使用須知」連結
  const viewLink = $('viewDisclaimerLink');
  if (viewLink) viewLink.addEventListener('click', showDisclaimerModal);
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
    showResults(watchlist, ads, warns, { izhihui: zResult.mode, s591: sResult.mode });
  } catch (e) {
    showError('比對過程中發生錯誤', e.message || String(e));
    console.error(e);
  }
}

// ============ 使用須知同意流程 ============

function showDisclaimerModal() {
  // 把首次同意畫面內容複製到 modal
  const src = document.querySelector('#disclaimer .disclaimer-scroll');
  const dst = $('disclaimerScrollReadonly');
  if (src && dst) dst.innerHTML = src.innerHTML;
  $('disclaimerModal').classList.add('show');
}

function hideDisclaimerModal() {
  $('disclaimerModal').classList.remove('show');
}

async function startIfAccessAllowed() {
  const access = await checkLicenseAccess();

  if (!access.allowed) {
    $('disclaimer').style.display = 'none';
    $('output').style.display = 'none';
    $('progress').style.display = '';
    $('progress').innerHTML =
      '<h2 style="color:#c62828;margin:0 0 12px;">需要授權</h2>' +
      '<div class="error">' + access.message + '</div>';
    return;
  }

  $('disclaimer').style.display = 'none';
  $('progress').style.display = '';
  main();
}

function showDisclaimerScreen() {
  $('progress').style.display = 'none';
  $('output').style.display = 'none';
  $('disclaimer').style.display = 'block';

  const scroll = $('disclaimerScroll');
  const hint = $('scrollHint');
  const check = $('agreeCheck');
  const agree = $('agreeBtn');
  const verifyBtn = $('verifyLicenseBtn');
  let scrolledToBottom = false;
  let accessAllowed = false;

  function refresh() {
    agree.disabled = !(accessAllowed && scrolledToBottom && check.checked);
  }

  refreshLicenseUi().then((access) => {
    accessAllowed = access.allowed;
    refresh();
  });

  if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
      const ok = await saveAndVerifyLicenseFromInput();
      if (ok) {
        accessAllowed = true;
        refresh();
      }
    });
  }

  scroll.addEventListener('scroll', () => {
    // 容忍 5px 誤差
    if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 5) {
      if (!scrolledToBottom) {
        scrolledToBottom = true;
        hint.textContent = '✓ 已捲動到底，請勾選下方並確認';
        hint.classList.add('done');
        check.disabled = false;
      }
    }
  });
  // 內容很短時，初始就已可見全部
  setTimeout(() => {
    if (scroll.scrollHeight <= scroll.clientHeight + 5) {
      scrolledToBottom = true;
      hint.textContent = '✓ 已顯示全部內容，請勾選下方並確認';
      hint.classList.add('done');
      check.disabled = false;
    }
  }, 100);

  check.addEventListener('change', refresh);

  agree.addEventListener('click', async () => {
    const access = await checkLicenseAccess();
    if (!access.allowed) {
      accessAllowed = false;
      setLicenseStatus(access.message, 'bad');
      refresh();
      return;
    }

    await chrome.storage.local.set({
      [DISCLAIMER_STORAGE_KEY]: {
        accepted: true,
        timestamp: Date.now(),
        date: new Date().toISOString()
      }
    });
    startIfAccessAllowed();
  });

  $('disagreeBtn').addEventListener('click', () => {
    window.close();
  });
}

async function checkDisclaimerAndStart() {
  // 綁定 modal 關閉按鈕（無論首次或非首次都要）
  const modalCloseBtn = $('modalCloseBtn');
  if (modalCloseBtn) modalCloseBtn.addEventListener('click', hideDisclaimerModal);
  const modalBg = $('disclaimerModal');
  if (modalBg) modalBg.addEventListener('click', (e) => {
    if (e.target === modalBg) hideDisclaimerModal();
  });

  const stored = await chrome.storage.local.get(DISCLAIMER_STORAGE_KEY);
  const accepted = stored[DISCLAIMER_STORAGE_KEY] && stored[DISCLAIMER_STORAGE_KEY].accepted;
  if (accepted) {
    // 已同意，仍需通過授權 gate
    startIfAccessAllowed();
  } else {
    // 首次：顯示同意畫面
    showDisclaimerScreen();
  }
}

checkDisclaimerAndStart();
