const LICENSE_API = 'https://ycut-license-api.sir8713642.workers.dev/verify-license';
const PRODUCT_ID = 'listing_compare';
const TRIAL_DAYS = 3;
const TRIAL_STORAGE_KEY = 'trial_started_at_' + PRODUCT_ID;

const $ = (id) => document.getElementById(id);

function normalizeLicenseKey(value) {
  return (value || '').trim().toUpperCase();
}

function isValidLicenseKey(value) {
  return /^[A-Z2-9]{5}(-[A-Z2-9]{5}){4}$/.test(value || '');
}

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
  return {
    active: expiresAt > now
  };
}

async function verifyLicenseKey(licenseKey) {
  const installId = await getOrCreateInstallId();
  const url = LICENSE_API +
    '?product_id=' + encodeURIComponent(PRODUCT_ID) +
    '&license_key=' + encodeURIComponent(licenseKey) +
    '&install_id=' + encodeURIComponent(installId);
  const res = await fetch(url);
  return await res.json();
}

async function hasAccess() {
  const stored = await chrome.storage.local.get(['license_key', 'license_status']);
  const licenseKey = normalizeLicenseKey(stored.license_key);

  if (isValidLicenseKey(licenseKey)) {
    try {
      const result = await verifyLicenseKey(licenseKey);
      if (result && result.success) {
        await chrome.storage.local.set({
          license_key: licenseKey,
          license_status: 'valid',
          last_verified_at: new Date().toISOString()
        });
        return true;
      }

      await chrome.storage.local.set({ license_status: 'invalid' });
    } catch (e) {
      if (stored.license_status === 'valid') return true;
    }
  }

  const trial = await getTrialInfo();
  return trial.active;
}

async function saveAndVerifyLicense() {
  const btn = $('verifyLicenseBtn');
  const input = $('licenseKey');
  const licenseKey = normalizeLicenseKey(input && input.value);

  if (!isValidLicenseKey(licenseKey)) {
    setLicenseStatus('序號格式錯誤。', false);
    return false;
  }

  if (btn) btn.disabled = true;
  setLicenseStatus('正在驗證授權...', true);

  try {
    const result = await verifyLicenseKey(licenseKey);
    if (!result || !result.success) {
      await chrome.storage.local.set({ license_status: 'invalid' });
      setLicenseStatus(result?.message || '授權失敗。', false);
      return false;
    }

    await chrome.storage.local.set({
      license_key: licenseKey,
      license_status: 'valid',
      last_verified_at: new Date().toISOString()
    });

    if (input) input.value = licenseKey;
    setLicenseStatus(result.first_bind ? '授權成功，已綁定此瀏覽器。' : '授權有效。', true);
    return true;
  } catch (e) {
    setLicenseStatus('無法連線授權伺服器，請稍後再試。', false);
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openResultPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('result.html') });
  window.close();
}

document.addEventListener('DOMContentLoaded', async () => {
  const startBtn = $('startBtn');
  const verifyBtn = $('verifyLicenseBtn');
  const stored = await chrome.storage.local.get(['license_key']);

  if (stored.license_key && $('licenseKey')) {
    $('licenseKey').value = stored.license_key;
  }

  if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
      const ok = await saveAndVerifyLicense();
      if (ok && startBtn) startBtn.disabled = false;
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
      showLicensePanel('請輸入授權序號後繼續使用。');
    });
  }
});
