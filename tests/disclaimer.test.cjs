const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

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
    async get(keys) {
      return Object.fromEntries(keys.map((key) => [key, values[key]]));
    },
    async set(update) {
      values = { ...values, ...update };
    }
  };
  const module = await loadStorageModule(storage);

  assert.equal(module.DISCLAIMER_VERSION, 1);
  assert.equal(module.DISCLAIMER_STORAGE_KEY, 'admirror_disclaimer_accepted_v1');
  assert.equal(await module.getDisclaimerAccepted(), false);

  values[module.DISCLAIMER_STORAGE_KEY] = { accepted: true };
  assert.equal(await module.getDisclaimerAccepted(), false, 'version is required');

  values[module.DISCLAIMER_STORAGE_KEY] = { accepted: false, version: 1 };
  assert.equal(await module.getDisclaimerAccepted(), false, 'accepted must be true');

  const record = await module.saveDisclaimerAccepted();
  assert.equal(record.accepted, true);
  assert.equal(record.version, 1);
  assert.equal(typeof record.timestamp, 'number');
  assert.match(record.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(values[module.DISCLAIMER_STORAGE_KEY], record);
  assert.equal(await module.getDisclaimerAccepted(), true);
}

async function testStorageFailures() {
  const readFailureModule = await loadStorageModule({
    async get() { throw new Error('read failed'); },
    async set() {}
  });
  assert.equal(await readFailureModule.getDisclaimerAccepted(), false);

  const writeFailureModule = await loadStorageModule({
    async get() { return {}; },
    async set() { throw new Error('write failed'); }
  });
  await assert.rejects(writeFailureModule.saveDisclaimerAccepted(), /write failed/);
}

function testIntegrationStructure() {
  const popupHtml = read('popup.html');
  const popupJs = read('popup.js');
  const resultHtml = read('result.html');
  const resultJs = read('result.js');
  const disclaimerHtml = read('disclaimer.html');
  const disclaimerJs = read('disclaimer.js');
  const manifest = JSON.parse(read('manifest.json'));

  assert.match(popupHtml, /<script type="module" src="popup\.js"><\/script>/);
  assert.match(popupHtml, /id="appTitle"/);
  assert.match(popupHtml, /id="licenseExpiryInfo"/);
  assert.match(popupHtml, /id="versionText"/);
  assert.match(popupJs, /chrome\.runtime\.getManifest\(\)\.version/);
  assert.equal(popupHtml.includes('id="earlyLicenseBtn"'), false);
  assert.match(popupJs, /lastAccessMode = trial\.active \? 'trial' : 'expired'/);
  assert.match(popupJs, /appTitle\.addEventListener\('click'/);
  assert.match(popupJs, /event\.ctrlKey && event\.shiftKey && event\.button === 0/);
  assert.match(popupJs, /showLicenseExpiryInfo\(stored\.license_expires_on/);
  assert.match(popupJs, /createOrRefreshQrCode\('試用仍會照常保留/);
  assert.match(popupJs, /if \(await getDisclaimerAccepted\(\)\)/);
  assert.match(popupJs, /chrome\.runtime\.getURL\('disclaimer\.html'\)/);
  assert.match(popupJs, /chrome\.runtime\.getURL\('result\.html'\)/);
  assert.ok(
    popupJs.indexOf('const allowed = await hasAccess()') <
      popupJs.indexOf('await continueAfterAccessCheck()'),
    'access check must run before disclaimer routing'
  );

  for (const obsolete of [
    'id="disclaimer"', 'disclaimerModal', 'disclaimer-screen',
    'showDisclaimerScreen', 'checkDisclaimerAndStart', 'agreeBtn', 'disagreeBtn'
  ]) {
    assert.equal(resultHtml.includes(obsolete) || resultJs.includes(obsolete), false,
      `obsolete result disclaimer flow remains: ${obsolete}`);
  }
  assert.match(resultJs, /disclaimer\.html\?readonly=1/);
  assert.match(resultJs, /startIfAccessAllowed\(\);\s*$/);

  assert.match(disclaimerHtml, /AdMirror 首次使用須知與免責聲明/);
  for (const heading of ['一、工具用途', '二、使用權限與合法性', '三、自動化操作風險',
    '四、資料正確性', '五、使用者責任', '六、開發者免責聲明',
    '七、版本與功能變更', '八、同意聲明']) {
    assert.ok(disclaimerHtml.includes(heading), `missing heading: ${heading}`);
  }
  assert.match(disclaimerHtml, /id="agreement-check" type="checkbox" disabled/);
  assert.match(disclaimerHtml, /id="accept-button"[^>]*disabled/);
  assert.match(disclaimerJs, /scrollHeight - 5/);
  assert.match(disclaimerJs, /event\.key === 'Enter'/);
  assert.match(disclaimerJs, /params\.get\('readonly'\) === '1'/);
  assert.match(disclaimerJs, /agreementBox\.hidden = true/);
  assert.match(disclaimerJs, /acceptButton\.hidden = true/);
  assert.match(disclaimerJs, /await saveDisclaimerAccepted\(\)/);
  assert.ok(
    disclaimerJs.indexOf('await saveDisclaimerAccepted()') <
      disclaimerJs.indexOf('await closeCurrentDisclaimerTab()'),
    'acceptance must persist before closing'
  );
  assert.match(disclaimerJs, /await chrome\.tabs\.remove\(currentTab\.id\)/);
  assert.match(disclaimerJs, /window\.close\(\)/);
  assert.match(disclaimerJs, /無法儲存同意紀錄/);

  for (const permission of ['tabs', 'scripting', 'storage', 'identity', 'identity.email']) {
    assert.ok(manifest.permissions.includes(permission), `missing permission: ${permission}`);
  }
  assert.equal('web_accessible_resources' in manifest, false);
}

(async () => {
  await testStorageContract();
  await testStorageFailures();
  testIntegrationStructure();
  console.log('AdMirror disclaimer tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
