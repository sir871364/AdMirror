const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const EXPECTED_VERSION = 2;

async function loadStorageModule(storage) {
  globalThis.chrome = { storage: { local: storage } };
  const source = read('src/disclaimer.js');
  const url = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64') +
    '#' + Math.random();
  return import(url);
}

async function testStorageContract() {
  let values = {};
  const storage = {
    async get(keys) { return Object.fromEntries(keys.map((k) => [k, values[k]])); },
    async set(update) { values = { ...values, ...update }; }
  };
  const module = await loadStorageModule(storage);

  assert.equal(module.DISCLAIMER_VERSION, EXPECTED_VERSION);
  assert.equal(module.DISCLAIMER_STORAGE_KEY, `admirror_disclaimer_accepted_v${EXPECTED_VERSION}`);
  assert.equal(await module.getDisclaimerAccepted(), false);

  values[module.DISCLAIMER_STORAGE_KEY] = { accepted: true };
  assert.equal(await module.getDisclaimerAccepted(), false, '必須帶版本才算數');

  // 舊版同意紀錄不得沿用：新增揭露內容後要重新確認
  values[module.DISCLAIMER_STORAGE_KEY] = { accepted: true, version: EXPECTED_VERSION - 1 };
  assert.equal(await module.getDisclaimerAccepted(), false, '舊版同意紀錄不得通過');

  values[module.DISCLAIMER_STORAGE_KEY] = { accepted: false, version: EXPECTED_VERSION };
  assert.equal(await module.getDisclaimerAccepted(), false, 'accepted 必須為 true');

  const record = await module.saveDisclaimerAccepted();
  assert.equal(record.accepted, true);
  assert.equal(record.version, EXPECTED_VERSION);
  assert.equal(typeof record.timestamp, 'number');
  assert.match(record.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(values[module.DISCLAIMER_STORAGE_KEY], record);
  assert.equal(await module.getDisclaimerAccepted(), true);
}

async function testStorageFailures() {
  const readFail = await loadStorageModule({
    async get() { throw new Error('read failed'); },
    async set() {}
  });
  assert.equal(await readFail.getDisclaimerAccepted(), false, '讀取失敗要當成未同意');

  const writeFail = await loadStorageModule({
    async get() { return {}; },
    async set() { throw new Error('write failed'); }
  });
  await assert.rejects(writeFail.saveDisclaimerAccepted(), /write failed/);
}

function testDisclaimerPage() {
  const html = read('disclaimer.html');
  const js = read('disclaimer.js');

  assert.match(html, /AdMirror 首次使用須知與免責聲明/);
  for (const heading of [
    '一、工具用途', '二、使用權限與合法性', '三、自動化操作風險',
    '四、瀏覽器偵錯工具的使用', '五、資料正確性', '六、使用者責任',
    '七、開發者免責聲明', '八、版本與功能變更', '九、同意聲明'
  ]) {
    assert.ok(html.includes(heading), `缺少章節：${heading}`);
  }
  // 章節編號不得重複（插入新章節時最容易漏掉重排）
  const numbers = [...html.matchAll(/<h2>([一二三四五六七八九十]+)、/g)].map((m) => m[1]);
  assert.equal(new Set(numbers).size, numbers.length, '章節編號重複');

  // debugger 這一節是攔截版新增的行為，必須實際說明而不是只有標題
  const debuggerSection = html.slice(html.indexOf('四、瀏覽器偵錯工具的使用'), html.indexOf('五、資料正確性'));
  assert.match(debuggerSection, /debugger/i);
  assert.match(debuggerSection, /偵錯/);

  // 必須捲到底 + 勾選才能同意
  assert.match(html, /id="agreement-check" type="checkbox" disabled/);
  assert.match(html, /id="accept-button"[^>]*disabled/);
  assert.match(js, /scrollHeight - 5/);
  assert.match(js, /event\.key === 'Enter'/); // 避免 Enter 誤觸同意
  assert.match(js, /params\.get\('readonly'\) === '1'/);
  assert.match(js, /await saveDisclaimerAccepted\(\)/);
  assert.ok(
    js.indexOf('await saveDisclaimerAccepted()') < js.indexOf('await closeCurrentDisclaimerTab()'),
    '必須先存同意紀錄才關閉分頁'
  );
}

function testIntegration() {
  const background = read('background.js');
  const manifest = JSON.parse(read('manifest.json'));

  // 閘門在背景，不在 popup —— popup 關掉也繞不過
  assert.match(background, /import \{ getDisclaimerAccepted \} from '\.\/src\/disclaimer\.js';/);
  assert.match(background, /async function openDisclaimerPage\(\)/);
  // 未同意時要把須知頁打開，不能只丟錯誤訊息
  assert.match(background, /assertDisclaimer[\s\S]{0,400}?await openDisclaimerPage\(\)/);

  for (const permission of ['tabs', 'storage', 'identity', 'identity.email']) {
    assert.ok(manifest.permissions.includes(permission), `缺少權限：${permission}`);
  }
  assert.equal('web_accessible_resources' in manifest, false);
}

// 隱藏授權功能：Ctrl + Shift + 左鍵點標題。
// 這在改版搬移時漏掉過一次，補測試釘住。
function testHiddenLicenseShortcut() {
  const html = read('popup.html');
  const js = read('popup.js');

  assert.match(html, /id="appTitle"/);
  assert.match(html, /id="licenseExpiryInfo"/);
  assert.match(html, /id="versionTag"/);

  assert.match(js, /\$\('appTitle'\)\.addEventListener\('click'/);
  assert.match(js, /event\.ctrlKey && event\.shiftKey && event\.button === 0/);
  assert.match(js, /showLicenseExpiryInfo\(a\.expiresOn\)/);
  // 停用中不得叫出 QR：核准了也一樣被擋，只會白跑一趟
  assert.match(js, /if \(a\.mode === 'emergency_suspended' \|\| a\.mode === 'unavailable'\) \{\s*\n\s*return applyAccess\(a\);/);
  // 版號必須從 manifest 讀，寫死在 HTML 一定會忘記跟著改
  assert.match(js, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.doesNotMatch(read('popup.html'), /v\d+\.\d+\.\d+/, 'popup.html 不應寫死版號');

  // 輪詢只能認 mode === 'license'。
  // 試用中 allowed 也是 true，若用 allowed 判斷，試用期使用者提前產生的
  // QR Code 會在第一次輪詢（5 秒）就被關掉，來不及截圖給管理員。
  const poll = js.slice(js.indexOf('function startPolling'), js.indexOf('function applyAccess'));
  assert.match(poll, /a\.mode === 'license'/, '輪詢必須以 mode === license 判斷核准');
  assert.doesNotMatch(poll, /if \(a\.allowed\)/, '輪詢不得用 a.allowed 判斷（試用中也是 true）');
}

(async () => {
  await testStorageContract();
  await testStorageFailures();
  testDisclaimerPage();
  testIntegration();
  testHiddenLicenseShortcut();
  console.log('AdMirror disclaimer tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
