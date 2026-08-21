import { getDisclaimerAccepted } from './src/disclaimer.js';
import {
  LICENSE_REQUEST_API,
  LICENSE_STATUS_API,
  PRODUCT_ID,
  TRIAL_DAYS,
  TRIAL_STATUS_API
} from './src/config.js';
import { classifyCoreLicenseStatus } from './src/core-access.js';
import { createQrDataUrl } from './src/local-qr.mjs';
const TRIAL_STORAGE_KEY = 'trial_started_at_' + PRODUCT_ID;

const QR_LIFETIME_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const LICENSE_CACHE_TTL_MS = 30 * 60 * 1000;

const $ = (id) => document.getElementById(id);

let qrExpireAt = 0;
let qrTimerId = null;
let pollTimerId = null;
let currentRequestId = '';
let lastLicenseCheck = null;
let lastAccessMode = 'unknown';
let lastSuspendedMessage = '';

function setLicenseStatus(message, ok = false) {
  const el = $('licenseStatus');
  if (!el) return;
  el.textContent = message;
  el.className = ok ? 'license-status ok' : 'license-status bad';
}

function showLicensePanel(message) {
  const panel = $('licensePanel');
  if (panel) panel.style.display = 'block';
  if (message) setLicenseStatus(message, false);
}

function hideLicenseExpiryInfo() {
  const info = $('licenseExpiryInfo');
  if (info) info.style.display = 'none';
}

// 緊急停止：與「未授權」走不同的畫面。
// 此時掃 QR Code 沒有意義（管理員核准後仍會被擋），所以只顯示停用訊息，
// 並停掉倒數與輪詢，避免使用者白等。
function showSuspendedState(message) {
  const text = message || lastSuspendedMessage ||
    '系統目前處於緊急停止狀態。\n\n請稍後再試。';

  if (qrTimerId) { clearInterval(qrTimerId); qrTimerId = null; }
  if (pollTimerId) { clearInterval(pollTimerId); pollTimerId = null; }

  const startBtn = $('startBtn');
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = '⛔ 已暫停使用';
  }

  hideLicenseExpiryInfo();

  const panel = $('licensePanel');
  if (panel) panel.style.display = 'block';
  const qrBox = document.querySelector('.qr-box');
  if (qrBox) qrBox.style.display = 'none';
  const timer = $('qrTimer');
  if (timer) timer.style.display = 'none';
  const refreshQrBtn = $('refreshQrBtn');
  if (refreshQrBtn) refreshQrBtn.style.display = 'none';

  setLicenseStatus(text, false);
}

function showLicenseExpiryInfo(expiresOn) {
  const info = $('licenseExpiryInfo');
  if (!info) return;
  info.textContent = '授權到期日：' + (expiresOn || '未提供');
  info.style.display = 'block';
}

async function getOrCreateInstallId() {
  const stored = await chrome.storage.local.get(['install_id']);
  if (stored.install_id) return stored.install_id;

  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ install_id: installId });
  return installId;
}

function setInstallIdentityText({ installId, googleEmail = '', licenseKey = '' }) {
  const installText = $('installIdText');
  if (!installText) return;

  if (googleEmail) {
    installText.textContent = 'Install ID：' + installId + '\nGoogle：' + googleEmail;
    return;
  }

  installText.textContent = (licenseKey ? 'License：' + licenseKey + '\n' : '') +
    'Install ID：' + installId;
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
  return '請先在 Chrome 登入 Google 帳號，才能開始試用或產生授權 QR Code。已授權的電腦不受影響。';
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
      return { active: !!data.active };
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
  return { active: expiresAt > now };
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
    'license_expires_on',
    'license_key',
    'license_google_email'
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
  const fresh = Number.isFinite(verifiedAt) && Date.now() - verifiedAt < LICENSE_CACHE_TTL_MS;
  if (fresh) {
    setInstallIdentityText({
      installId,
      googleEmail: stored.license_google_email || '',
      licenseKey: stored.license_key || ''
    });
  }
  return fresh;
}

// 回傳 'licensed' | 'suspended' | 'unlicensed' | 'unavailable'
// 一律走 no-store，確保緊急停止不會被瀏覽器快取延遲。
async function checkQrLicenseStatus() {
  const installId = await getOrCreateInstallId();
  const url = LICENSE_STATUS_API +
    '?product_id=' + encodeURIComponent(PRODUCT_ID) +
    '&install_id=' + encodeURIComponent(installId);

  const res = await fetch(url, { cache: 'no-store' });
  const data = await res.json();
  const status = classifyCoreLicenseStatus(data);

  if (status.decision === 'unavailable') return 'unavailable';

  // 緊急停止是暫時狀態，不要把使用者原本有效的授權標成 invalid，
  // 否則恢復後還得重新掃 QR Code。
  if (status.decision === 'suspended') {
    lastLicenseCheck = data;
    lastSuspendedMessage = status.message;
    return 'suspended';
  }

  if (status.decision === 'licensed') {
    lastLicenseCheck = data;
    await chrome.storage.local.set({
      license_status: 'valid',
      qr_licensed_install_id: installId,
      last_verified_at: new Date().toISOString(),
      license_expires_on: data.expires_on,
      license_key: data.license_key || '',
      license_google_email: data.google_email || ''
    });
    setInstallIdentityText({
      installId,
      googleEmail: data.google_email || '',
      licenseKey: data.license_key || ''
    });
    return 'licensed';
  }

  lastLicenseCheck = data;
  await chrome.storage.local.set({
    license_status: 'invalid',
    license_expires_on: data?.expires_on || null
  });
  return 'unlicensed';
}

async function hasAccess() {
  const installId = await getOrCreateInstallId();

  // 先問伺服器，本機快取只當離線備援。
  // 若沿用「快取優先」，緊急停止最久要等 30 分鐘才會在 popup 生效。
  let statusUnknown = false;
  try {
    const decision = await checkQrLicenseStatus();
    if (decision === 'suspended') {
      lastAccessMode = 'suspended';
      return false;
    }
    if (decision === 'licensed') {
      lastAccessMode = 'license';
      return true;
    }
    if (decision === 'unavailable') statusUnknown = true;
  } catch (e) {
    statusUnknown = true;
  }

  // 只有「問不到」才退回快取；伺服器明確說沒授權時不吃快取。
  if (statusUnknown && await hasFreshLicenseCache(installId)) {
    lastAccessMode = 'license';
    return true;
  }

  const googleAccount = await getChromeGoogleAccount();
  if (googleAccount) {
    await chrome.storage.local.set({ google_account: googleAccount });
  } else {
    await chrome.storage.local.remove('google_account');
  }

  const trial = await getTrialInfo(googleAccount, installId);
  lastAccessMode = trial.active ? 'trial' : 'expired';
  return trial.active;
}

async function setQrImage(approveUrl) {
  const qr = $('licenseQr');
  if (!qr) return;

  qr.src = await createQrDataUrl(approveUrl, 240);
}

function updateQrTimer() {
  const timer = $('qrTimer');
  if (!timer) return;

  const remain = Math.max(0, qrExpireAt - Date.now());
  const sec = Math.floor(remain / 1000);
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  timer.textContent = m + ':' + s;

  if (remain <= 0) {
    createOrRefreshQrCode();
  }
}

async function createOrRefreshQrCode(statusMessage = '') {
  hideLicenseExpiryInfo();
  const installId = await getOrCreateInstallId();
  const googleAccount = await getChromeGoogleAccount();
  setInstallIdentityText({
    installId,
    googleEmail: googleAccount?.google_email || ''
  });

  const licenseRequestBody = {
    install_id: installId,
    product_id: PRODUCT_ID
  };

  if (googleAccount) {
    licenseRequestBody.google_sub = googleAccount.google_sub;
    licenseRequestBody.google_email = googleAccount.google_email;
    await chrome.storage.local.set({ google_account: googleAccount });
  } else {
    await chrome.storage.local.remove('google_account');
  }

  setLicenseStatus('正在產生授權 QR Code...', false);

  try {
    const res = await fetch(LICENSE_REQUEST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(licenseRequestBody)
    });

    const data = await res.json();
    if (!data || !data.success) {
      setLicenseStatus(data?.message || 'QR Code 產生失敗。', false);
      return;
    }

    currentRequestId = data.request_id || '';
    await setQrImage(data.telegram_url || data.approve_url);
    qrExpireAt = Date.now() + QR_LIFETIME_MS;
    setLicenseStatus(statusMessage || '請截圖/拍照給管理員，或讓管理員掃描後輸入備註與到期日核准。', true);

    if (!qrTimerId) {
      qrTimerId = setInterval(updateQrTimer, 1000);
    }
    updateQrTimer();

    startPollingApproval();
  } catch (e) {
    setLicenseStatus('無法連線授權伺服器，請稍後再試。', false);
  }
}

function startPollingApproval() {
  if (pollTimerId) clearInterval(pollTimerId);

  pollTimerId = setInterval(async () => {
    try {
      const decision = await checkQrLicenseStatus();

      // 緊急停止期間再等下去也不會放行，直接停止輪詢並改顯示停用訊息。
      if (decision === 'suspended') {
        clearInterval(pollTimerId);
        pollTimerId = null;
        lastAccessMode = 'suspended';
        showSuspendedState();
        return;
      }

      if (decision === 'licensed') {
        clearInterval(pollTimerId);
        pollTimerId = null;
        setLicenseStatus('授權成功，已綁定此瀏覽器。', true);
        const startBtn = $('startBtn');
        if (startBtn) startBtn.disabled = false;
        lastAccessMode = 'license';
        const panel = $('licensePanel');
        if (panel) setTimeout(() => panel.style.display = 'none', 1200);
      }
    } catch (e) {
      // 保持輪詢，不中斷使用者等待流程
    }
  }, POLL_INTERVAL_MS);
}

function openResultPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });
  window.close();
}

async function openDisclaimerPage() {
  const disclaimerUrl = chrome.runtime.getURL('disclaimer.html');
  const tabs = await chrome.tabs.query({});
  const existingTab = tabs.find((tab) =>
    Number.isInteger(tab.id) && String(tab.url || '').split('?')[0] === disclaimerUrl
  );

  if (existingTab) {
    if (Number.isInteger(existingTab.windowId)) {
      await chrome.windows.update(existingTab.windowId, { focused: true });
    }
    await chrome.tabs.update(existingTab.id, { active: true });
  } else {
    await chrome.tabs.create({ url: disclaimerUrl });
  }

  window.close();
}

async function continueAfterAccessCheck() {
  if (await getDisclaimerAccepted()) {
    openResultPage();
    return;
  }

  await openDisclaimerPage();
}

document.addEventListener('DOMContentLoaded', async () => {
  const appTitle = $('appTitle');
  const startBtn = $('startBtn');
  const refreshQrBtn = $('refreshQrBtn');
  const versionText = $('versionText');
  const initialAccessCheck = hasAccess();

  if (versionText) {
    versionText.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  if (appTitle) {
    appTitle.addEventListener('click', async (event) => {
      if (!(event.ctrlKey && event.shiftKey && event.button === 0)) return;
      event.preventDefault();

      try {
        const allowed = await initialAccessCheck;
        if (lastAccessMode === 'suspended') {
          showSuspendedState();
          return;
        }
        if (allowed && lastAccessMode === 'license') {
          const stored = await chrome.storage.local.get(['license_expires_on']);
          showLicenseExpiryInfo(stored.license_expires_on || lastLicenseCheck?.expires_on || '');
          return;
        }

        showLicensePanel('隱藏授權功能已開啟；產生 QR Code 不會縮短剩餘試用期。');
        await createOrRefreshQrCode('試用仍會照常保留。請讓管理員掃描並核准 QR Code。');
      } catch (e) {
        showLicensePanel('無法確認授權狀態，請稍後再試。');
      }
    });
  }

  if (refreshQrBtn) {
    refreshQrBtn.addEventListener('click', async () => {
      await createOrRefreshQrCode();
    });
  }

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      let allowed = false;
      try {
        allowed = await hasAccess();
      } catch {
        startBtn.disabled = false;
        showLicensePanel('目前無法確認授權狀態，請稍後再試。');
        return;
      }
      if (allowed) {
        await continueAfterAccessCheck();
        return;
      }

      // 緊急停止：不要引導使用者去掃 QR Code，核准了也一樣被擋。
      if (lastAccessMode === 'suspended') {
        showSuspendedState();
        return;
      }

      startBtn.disabled = false;
      const message = lastLicenseCheck?.reason === 'google_required'
        ? googleAccountRequiredMessage()
        : lastLicenseCheck?.reason === 'expired'
        ? `授權已於 ${lastLicenseCheck.expires_on || '設定期限'} 到期，請重新掃描 QR Code 授權。`
        : '請等待管理員核准 QR Code 授權。';
      showLicensePanel(message);
      await createOrRefreshQrCode(message);
    });
  }

  // 如果已經沒有授權，先準備 QR Code，讓使用者不用多按一次。
  try {
    const allowed = await initialAccessCheck;
    if (lastAccessMode === 'suspended') {
      showSuspendedState();
      return;
    }
    if (!allowed) {
      const message = lastLicenseCheck?.reason === 'google_required'
        ? googleAccountRequiredMessage()
        : lastLicenseCheck?.reason === 'expired'
        ? `授權已於 ${lastLicenseCheck.expires_on || '設定期限'} 到期，請重新掃描 QR Code 授權。`
        : '請等待管理員核准 QR Code 授權。';
      showLicensePanel(message);
      await createOrRefreshQrCode(message);
    }
  } catch (e) {}
});
