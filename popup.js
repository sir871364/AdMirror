import { createQrDataUrl } from './src/local-qr.mjs';

const $ = (id) => document.getElementById(id);

const QR_LIFETIME_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
let qrExpireAt = 0;
let qrTimerId = null;
let pollTimerId = null;

function setLicenseStatus(message, ok = false) {
  const el = $('licenseStatus');
  if (!el) return;
  el.textContent = message;
  el.className = ok ? 'license-status ok' : 'license-status bad';
}

function setCoreButtonsEnabled(on) {
  $('btnAuto').disabled = !on;
  $('btnCompare').disabled = !on;
  $('btnManualStart').disabled = !on;
}

function stopQrTimers() {
  if (qrTimerId) { clearInterval(qrTimerId); qrTimerId = null; }
  if (pollTimerId) { clearInterval(pollTimerId); pollTimerId = null; }
}

function updateQrTimer() {
  const timer = $('qrTimer');
  if (!timer) return;
  const remain = Math.max(0, qrExpireAt - Date.now());
  const sec = Math.floor(remain / 1000);
  timer.textContent = String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  if (remain <= 0) createOrRefreshQr();
}

async function createOrRefreshQr(message = '') {
  hideLicenseExpiryInfo();
  setLicenseStatus('正在產生授權 QR Code…', false);
  const r = await send('requestQr');
  if (!r.ok) return setLicenseStatus(r.error || 'QR Code 產生失敗。', false);

  $('licenseQr').src = await createQrDataUrl(r.approveUrl, 240);
  $('installIdText').textContent = 'Install ID：' + r.installId + (r.googleEmail ? '\n' + r.googleEmail : '');
  qrExpireAt = Date.now() + QR_LIFETIME_MS;
  setLicenseStatus(message || '請截圖／拍照給管理員，或讓管理員掃描後核准。', true);

  if (!qrTimerId) qrTimerId = setInterval(updateQrTimer, 1000);
  updateQrTimer();
  startPolling();
}

// 核准後自動解鎖，不用重開 popup
function startPolling() {
  if (pollTimerId) clearInterval(pollTimerId);
  pollTimerId = setInterval(async () => {
    const a = await send('accessStatus');
    if (!a || !a.ok) return;
    // 緊急停止期間再等下去也不會放行，掃 QR 也沒用 → 停止輪詢
    if (a.mode === 'emergency_suspended') { stopQrTimers(); return applyAccess(a); }

    // 只認 mode === 'license'，不能用 a.allowed 判斷。
    // 試用中 allowed 也是 true，用 allowed 的話，試用期使用者按下隱藏授權後
    // QR Code 會在 5 秒後自己消失，根本來不及截圖給管理員。
    if (a.mode === 'license') {
      stopQrTimers();
      setLicenseStatus('授權成功，已綁定此瀏覽器。', true);
      setCoreButtonsEnabled(true);
      showLicenseExpiryInfo(a.expiresOn);
      // 先讓使用者看到成功訊息，再收起面板
      setTimeout(() => { $('licensePanel').style.display = 'none'; }, 1500);
    }
  }, POLL_INTERVAL_MS);
}

// 依授權狀態決定 UI。緊急停止與未授權走不同畫面：
// 停用期間掃 QR 沒有意義（管理員核准了仍會被擋），所以不顯示 QR。
function applyAccess(a) {
  const panel = $('licensePanel');
  if (a.allowed) {
    setCoreButtonsEnabled(true);
    if (panel) panel.style.display = 'none';
    if (a.mode === 'trial') $('status').textContent = a.message;
    return;
  }

  setCoreButtonsEnabled(false);
  if (panel) panel.style.display = 'block';

  if (a.mode === 'emergency_suspended') {
    stopQrTimers();
    $('qrTimer').style.display = 'none';
    document.querySelector('.qr-box').style.display = 'none';
    $('refreshQrBtn').style.display = 'none';
    $('btnAuto').textContent = '⛔ 已暫停使用';
    setLicenseStatus(a.message, false);
    return;
  }

  if (a.mode === 'unavailable') {
    stopQrTimers();
    $('qrTimer').style.display = 'none';
    document.querySelector('.qr-box').style.display = 'none';
    $('refreshQrBtn').style.display = 'none';
    setLicenseStatus(a.message, false);
    return;
  }

  // expired / 未授權 → 直接把 QR 準備好，省一次點擊
  createOrRefreshQr(a.message);
}


function send(cmd) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ cmd }, (r) => {
    void chrome.runtime.lastError;
    resolve(r || { ok: false, error: '背景沒有回應（service worker 可能剛被喚醒，請再按一次）' });
  }));
}

function paint(d) {
  $('status').textContent = d.capStatus || '待命中。';
  $('err').textContent = d.capError || '';

  const pct = d.capPct;
  if (typeof pct === 'number') {
    $('bar').style.display = 'block';
    $('fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  } else {
    $('bar').style.display = 'none';
  }

  // 只要攔到過資料就顯示診斷，不要等 lastCaptureAt。
  // 擷取中途失敗時 lastCaptureAt 不會寫入，但那正是最需要看欄位名的時候。
  const n = (d.ismartRows || []).length;
  if (n) {
    const pad = (x) => String(x).padStart(2, '0');
    let head = `已攔到 ${n} 筆${d.ismartTotal ? ' / 共 ' + d.ismartTotal : ' / 總筆數未讀到'}`;
    if (d.lastCaptureAt) {
      const t = new Date(d.lastCaptureAt);
      head = `上次完成：${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}　` + head;
    } else {
      head = '（上次未跑完）' + head;
    }
    // 攔到的筆數 vs 總筆數是最重要的一行：兩者不等就代表漏頁，
    // 而漏頁會讓漏掉的物件被誤判成「591 多出 → 應下架」。所以這行永遠顯示。
    const complete = d.ismartTotal && n >= d.ismartTotal;
    $('diag').textContent = head + (d.ismartTotal ? (complete ? '　✓ 已收齊' : '　⚠ 未收齊') : '')
      + '\n▸ 欄位明細（回報問題時才需要）';

    // 欄位名單只有在對欄位對應時才用得到，平常收起來。
    const detail = ((d.ismartEnvelopeKeys || []).length ? `外層欄位：${d.ismartEnvelopeKeys.join(', ')}\n` : '')
      + (d.ismartRaw ? `物件欄位：${Object.keys(d.ismartRaw).join(', ')}` : '');
    $('diagDetail').textContent = detail;
  }
}

async function refresh() {
  const d = await chrome.storage.local.get(
    ['capStatus', 'capError', 'capPct', 'lastCaptureAt', 'ismartRows', 'ismartTotal', 'ismartRaw', 'ismartEnvelopeKeys']);
  paint(d);

  const m = await send('manualStatus');
  const active = !!(m && m.active);
  $('btnManualStart').style.display = active ? 'none' : 'block';
  $('btnManualStop').style.display = active ? 'block' : 'none';
  if (active) {
    $('status').textContent = `手動模式進行中：已收 ${m.count}${m.total ? ' / ' + m.total : ''} 筆。\n請自己翻頁，翻完按「完成擷取」。`;
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  chrome.storage.local.get(
    ['capStatus', 'capError', 'capPct', 'lastCaptureAt', 'ismartRows', 'ismartTotal', 'ismartRaw', 'ismartEnvelopeKeys'], paint);
});

function busyUi(on) {
  $('btnAuto').disabled = on;
  $('btnCompare').disabled = on;
  $('btnManualStart').disabled = on;
  $('btnAbort').style.display = on ? 'block' : 'none';
}

$('btnAuto').addEventListener('click', async () => {
  busyUi(true);
  const r = await send('captureAutoAndCompare');
  busyUi(false);
  if (!r.ok && r.error) $('err').textContent = r.error;
  refresh();
});

$('btnManualStart').addEventListener('click', async () => {
  const r = await send('manualStart');
  if (!r.ok && r.error) $('err').textContent = r.error;
  refresh();
  // 手動模式下持續更新計數
  const timer = setInterval(async () => {
    const m = await send('manualStatus');
    if (!m || !m.active) { clearInterval(timer); return refresh(); }
    $('status').textContent = `手動模式進行中：已收 ${m.count}${m.total ? ' / ' + m.total : ''} 筆。\n請自己翻頁，翻完按「完成擷取」。`;
  }, 1000);
});

$('btnManualStop').addEventListener('click', async () => {
  busyUi(true);
  const r = await send('manualStop');
  busyUi(false);
  if (!r.ok && r.error) $('err').textContent = r.error;
  else await send('compare');
  refresh();
});

$('btnCompare').addEventListener('click', async () => {
  busyUi(true);
  const r = await send('compare');
  busyUi(false);
  if (!r.ok && r.error) $('err').textContent = r.error;
  refresh();
});

$('btnAbort').addEventListener('click', async () => {
  await send('abort');
});

$('diag').addEventListener('click', () => {
  const el = $('diagDetail');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
});

$('refreshQrBtn').addEventListener('click', () => createOrRefreshQr());

// 版號從 manifest 讀，不要寫死在 HTML 裡（寫死必定會忘記跟著改）
$('versionTag').textContent = 'AdMirror v' + chrome.runtime.getManifest().version;

function hideLicenseExpiryInfo() {
  $('licenseExpiryInfo').style.display = 'none';
}

function showLicenseExpiryInfo(expiresOn) {
  const el = $('licenseExpiryInfo');
  el.textContent = '授權到期日：' + (expiresOn || '未提供');
  el.style.display = 'block';
}

// 隱藏功能：Ctrl + Shift + 左鍵點標題
//   已授權   → 顯示到期日
//   試用/未授權 → 直接叫出 QR Code（不會縮短剩餘試用期，只是提前產生核准請求）
//   已被停用 → 照常顯示停用訊息，不給 QR（核准了也一樣被擋）
$('appTitle').addEventListener('click', async (event) => {
  if (!(event.ctrlKey && event.shiftKey && event.button === 0)) return;
  event.preventDefault();

  const a = await send('accessStatus');
  if (!a || !a.ok) {
    $('licensePanel').style.display = 'block';
    return setLicenseStatus('無法確認授權狀態，請稍後再試。', false);
  }

  if (a.mode === 'emergency_suspended' || a.mode === 'unavailable') {
    return applyAccess(a);
  }

  if (a.allowed && a.mode === 'license') {
    return showLicenseExpiryInfo(a.expiresOn);
  }

  $('licensePanel').style.display = 'block';
  await createOrRefreshQr('隱藏授權功能已開啟；產生 QR Code 不會縮短剩餘試用期。請讓管理員掃描並核准。');
});

// 開啟 popup 就先確認授權，未通過時核心按鈕維持停用。
// 真正的閘門在 background，這裡只是提早告知，不是防線。
setCoreButtonsEnabled(false);
send('accessStatus').then((a) => {
  if (a && a.ok) applyAccess(a);
  else setCoreButtonsEnabled(true); // 背景沒回應時不要把人鎖死，按下去仍會被 background 擋
});

refresh();
