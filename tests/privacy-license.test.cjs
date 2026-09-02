const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ---- QR Code 必須在本機產生 ----
// 曾經用過第三方 QR 服務，那等於把核准網址送給外部。
// 這裡全專案掃描，任何檔案再出現該網域就失敗。
const textFiles = [];
(function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (!/\.(png|jpg|jpeg|gif|zip|ico)$/i.test(entry.name)) textFiles.push(full);
  }
})(root);

const forbiddenQrHost = ['api', 'qrserver', 'com'].join('.');
for (const file of textFiles) {
  assert.equal(fs.readFileSync(file, 'utf8').includes(forbiddenQrHost), false,
    `${path.relative(root, file)} 仍引用第三方 QR 服務`);
}

const manifest = JSON.parse(read('manifest.json'));

// ---- 本專案的核心不變條件 ----
// i智慧 端不注入腳本、不主動呼叫 API，靠的就是「沒有這個 host permission」。
// 一旦有人把它加回 manifest，整個設計前提就沒了，所以在這裡鎖死。
assert.equal(
  manifest.host_permissions.some((v) => v.includes('ycut.com.tw')),
  false,
  'manifest 不得含 is.ycut.com.tw 的 host_permission（i智慧 端必須維持零注入）'
);
assert.ok(manifest.permissions.includes('debugger'), '攔截機制需要 debugger 權限');

// 不得宣告用不到的權限：Chrome 商店會因此退件，
// 而且多要權限本身就會讓使用者安裝時看到不必要的警告。
const USED_PERMISSIONS = new Set([
  'debugger',        // chrome.debugger.attach / sendCommand
  'tabs',            // chrome.tabs.create / update / query，且需要讀 tab.url
  'storage',         // chrome.storage.local
  'scripting',       // executeScript（僅注入 591）
  'identity',        // chrome.identity.getProfileUserInfo
  'identity.email'
]);
for (const p of manifest.permissions) {
  assert.ok(USED_PERMISSIONS.has(p), `宣告了程式碼未使用的權限：${p}`);
}
// 這兩個曾經誤留在 manifest 裡
for (const p of ['activeTab', 'unlimitedStorage']) {
  assert.equal(manifest.permissions.includes(p), false, `${p} 未被使用，不應宣告`);
}

// QR / 圖片來源
assert.equal(manifest.host_permissions.some((v) => v.includes('qrserver')), false);
assert.equal(manifest.content_security_policy.extension_pages.includes('qrserver'), false);
assert.ok(manifest.content_security_policy.extension_pages.includes("img-src 'self' data:"));

// 授權 API 必須可連線，否則 fail-closed 會把所有人擋死
assert.ok(manifest.host_permissions.some((v) => v.includes('ycut-license-api')));
assert.ok(manifest.content_security_policy.extension_pages.includes('ycut-license-api'));

// ---- 設定集中管理 ----
const config = read('src/config.js');
assert.match(config, /LICENSE_API_BASE_URL/);
assert.match(config, /\/api\/request-license/);
assert.match(config, /\/api\/license-status/);
assert.match(config, /\/api\/trial-status/);
// 沿用舊代號：後台的授權與緊急停止都掛在 listing_compare 下
assert.match(config, /PRODUCT_ID = 'listing_compare'/);

// 端點網址不得散落在各處，否則改一個地方會漏
for (const file of ['popup.js', 'background.js']) {
  assert.doesNotMatch(read(file), /sir8713642\.workers\.dev/, `${file} 應改用 src/config.js`);
}

assert.match(read('popup.js'), /createQrDataUrl\(r\.approveUrl, 240\)/);

// ---- 隱私權政策要跟得上實作 ----
const privacy = read('PRIVACY.md');
for (const section of ['## 業務比對資料', '## 授權驗證', '## 本機儲存']) {
  assert.ok(privacy.includes(section), `PRIVACY.md 缺少章節：${section}`);
}
// 實作改用 debugger 攔截後，政策必須說明這件事
assert.match(privacy, /偵錯|debugger/i, 'PRIVACY.md 未說明偵錯工具的使用');
assert.match(privacy, /瀏覽器本機/);

(async () => {
  const { createQrDataUrl } = await import(pathToFileURL(path.join(root, 'src', 'local-qr.mjs')).href);
  const dataUrl = await createQrDataUrl('https://example.test/approve?request_id=exact-value-123', 240);
  assert.match(dataUrl, /^data:image\/gif;base64,/);
  assert.ok(dataUrl.length > 100);
  console.log('AdMirror privacy/license checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
