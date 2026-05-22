const LICENSE_REQUEST_API = 'https://ycut-license-api.sir8713642.workers.dev/api/request-license';
const LICENSE_STATUS_API = 'https://ycut-license-api.sir8713642.workers.dev/api/license-status';
const PRODUCT_ID = 'listing_compare';
const TRIAL_DAYS = 3;
const TRIAL_STORAGE_KEY = 'trial_started_at_' + PRODUCT_ID;

const QR_LIFETIME_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const LICENSE_CACHE_TTL_MS = 30 * 60 * 1000;

const $ = (id) => document.getElementById(id);

let qrExpireAt = 0;
let qrTimerId = null;
let pollTimerId = null;
let currentRequestId = '';

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

async function getOrCreateInstallId() {
  const stored = await chrome.storage.local.get(['install_id']);
  if (stored.install_id) return stored.install_id;

  const installId = crypto.randomUUID();
  await chrome.storage.local.set({ install_id: installId });
  return installId;
}

async function getTrialInfo() {
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

async function hasFreshLicenseCache(installId) {
  const stored = await chrome.storage.local.get([
    'license_status',
    'qr_licensed_install_id',
    'last_verified_at'
  ]);

  if (stored.license_status !== 'valid' || stored.qr_licensed_install_id !== installId) {
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
    await chrome.storage.local.set({
      license_status: 'valid',
      qr_licensed_install_id: installId,
      last_verified_at: new Date().toISOString()
    });
    return true;
  }

  return false;
}

async function hasAccess() {
  const installId = await getOrCreateInstallId();

  if (await hasFreshLicenseCache(installId)) {
    return true;
  }

  try {
    if (await checkQrLicenseStatus()) return true;
  } catch (e) {
    if (await hasFreshLicenseCache(installId)) {
      return true;
    }
  }

  const trial = await getTrialInfo();
  return trial.active;
}

function setQrImage(approveUrl) {
  const qr = $('licenseQr');
  if (!qr) return;

  qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' + encodeURIComponent(approveUrl);
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

async function createOrRefreshQrCode() {
  const installId = await getOrCreateInstallId();
  const installText = $('installIdText');
  if (installText) installText.textContent = 'Install ID：' + installId;

  setLicenseStatus('正在產生授權 QR Code...', false);

  try {
    const res = await fetch(LICENSE_REQUEST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        install_id: installId,
        product_id: PRODUCT_ID
      })
    });

    const data = await res.json();
    if (!data || !data.success) {
      setLicenseStatus(data?.message || 'QR Code 產生失敗。', false);
      return;
    }

    currentRequestId = data.request_id || '';
    setQrImage(data.telegram_url || data.approve_url);
    qrExpireAt = Date.now() + QR_LIFETIME_MS;
    setLicenseStatus('請截圖/拍照給管理員，或讓管理員掃描後核准。', true);

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
      const ok = await checkQrLicenseStatus();
      if (ok) {
        clearInterval(pollTimerId);
        pollTimerId = null;
        setLicenseStatus('授權成功，已綁定此瀏覽器。', true);
        const startBtn = $('startBtn');
        if (startBtn) startBtn.disabled = false;
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

document.addEventListener('DOMContentLoaded', async () => {
  const startBtn = $('startBtn');
  const refreshQrBtn = $('refreshQrBtn');

  if (refreshQrBtn) {
    refreshQrBtn.addEventListener('click', async () => {
      await createOrRefreshQrCode();
    });
  }

  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      const allowed = await hasAccess();
      if (allowed) {
        openResultPage();
        return;
      }

      startBtn.disabled = false;
      showLicensePanel('請等待管理員核准 QR Code 授權。');
      await createOrRefreshQrCode();
    });
  }

  // 如果已經沒有授權，先準備 QR Code，讓使用者不用多按一次。
  try {
    const allowed = await hasAccess();
    if (!allowed) {
      showLicensePanel('請等待管理員核准 QR Code 授權。');
      await createOrRefreshQrCode();
    }
  } catch (e) {}
});
