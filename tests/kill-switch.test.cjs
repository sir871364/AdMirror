const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const context = {};
const classifierSource = fs.readFileSync(path.join(root, 'src', 'core-access.js'), 'utf8')
  .replace(/^export\s+/gm, '');
vm.runInNewContext(classifierSource, context);

const classify = context.classifyCoreLicenseStatus;
assert.equal(classify({ success: true, active: true, global_suspended: false, product_suspended: false }).decision, 'licensed');
assert.equal(classify({ success: true, active: true, global_suspended: false, product_suspended: true }).decision, 'suspended');
assert.equal(classify({ success: true, active: true, global_suspended: true, product_suspended: false }).decision, 'suspended');
assert.equal(classify({ success: true, active: false, global_suspended: false, product_suspended: false }).decision, 'unlicensed');
assert.equal(classify({ success: true, active: true }).decision, 'unavailable');

const resultJs = fs.readFileSync(path.join(root, 'result.js'), 'utf8');
assert.match(resultJs, /fetch\(url, \{ cache: 'no-store', signal: controller\.signal \}\)/);
assert.match(resultJs, /mode: 'unavailable',[\s\S]*目前無法確認授權狀態/);
assert.match(resultJs, /status\.decision === 'licensed'[\s\S]*getTrialInfo/);
assert.doesNotMatch(resultJs, /checkLiveCoreAccess[\s\S]*hasFreshLicenseCache/);

// 寫入型操作必須每次重新驗，緊急停止才不會被「已開著的結果頁」繞過。
assert.match(resultJs, /async function assertCoreAccess\(\)\s*{\s*const access = await checkLiveCoreAccess\(\);/);
for (const fn of ['runSingleUnfollow', 'runBatchUnfollow', 'runSingleFollow', 'runBatchFollow']) {
  assert.match(
    resultJs,
    new RegExp('async function ' + fn + '\\([^)]*\\)\\s*{[\\s\\S]{0,400}?if \\(!\\(await assertCoreAccess\\(\\)\\)\\) return;'),
    fn + ' 缺少 assertCoreAccess 閘門'
  );
}
// 確認視窗必須在閘門之後，否則使用者會先確認完不可還原的操作才被擋。
assert.match(resultJs, /if \(!\(await assertCoreAccess\(\)\)\) return;\s*if \(!confirm\(/);

const popupJs = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');

// popup 必須共用同一套分類器，不能只看 data.active。
assert.match(popupJs, /import { classifyCoreLicenseStatus } from '\.\/src\/core-access\.js';/);
assert.match(popupJs, /fetch\(url, { cache: 'no-store' }\)/);
assert.match(popupJs, /decision === 'suspended'[\s\S]{0,200}?lastAccessMode = 'suspended'/);
// 緊急停止時不得引導使用者去掃 QR Code（核准了仍會被擋）。
assert.match(popupJs, /function showSuspendedState\(/);
// 必須「先問伺服器，快取只當離線備援」，否則停用最久要 30 分鐘才在 popup 生效。
assert.doesNotMatch(popupJs, /async function hasAccess\(\)\s*{\s*const installId = await getOrCreateInstallId\(\);\s*if \(await hasFreshLicenseCache/);
assert.match(popupJs, /async function hasAccess\(\)[\s\S]{0,400}?await checkQrLicenseStatus\(\)/);
assert.match(popupJs, /statusUnknown && await hasFreshLicenseCache/);
// 輪詢等待核准時，字串回傳值不可被當成 truthy 判斷。
assert.doesNotMatch(popupJs, /const ok = await checkQrLicenseStatus\(\);\s*if \(ok\)/);

console.log('AdMirror kill-switch checks passed.');
