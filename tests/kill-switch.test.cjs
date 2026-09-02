const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ---- 分類器單元測試 ----

const context = {};
vm.runInNewContext(read('src/core-access.js').replace(/^export\s+/gm, ''), context);
const classify = context.classifyCoreLicenseStatus;

assert.equal(classify({ success: true, active: true, global_suspended: false, product_suspended: false }).decision, 'licensed');
assert.equal(classify({ success: true, active: true, global_suspended: false, product_suspended: true }).decision, 'suspended');
assert.equal(classify({ success: true, active: true, global_suspended: true, product_suspended: false }).decision, 'suspended');
assert.equal(classify({ success: true, active: false, global_suspended: false, product_suspended: false }).decision, 'unlicensed');
// 缺欄位不可當成「沒被停用」——那會讓緊急停止靜默失效
assert.equal(classify({ success: true, active: true }).decision, 'unavailable');
assert.equal(classify({ success: false }).decision, 'unavailable');
assert.equal(classify(null).decision, 'unavailable');

const background = read('background.js');

// ---- 即時查詢，不吃快取 ----
// 授權狀態一旦走本機快取，緊急停止就會延遲到快取過期才生效。
assert.match(background, /fetch\(url, \{ cache: 'no-store', signal: controller\.signal \}\)/);
assert.doesNotMatch(background, /checkLiveCoreAccess[\s\S]*hasFreshLicenseCache/,
  '授權檢查不得退回本機快取');

// ---- fail closed ----
// 查不到狀態時必須擋下，不能放行。
assert.match(background, /catch \(e\) \{[\s\S]{0,300}?mode: 'unavailable'[\s\S]{0,200}?\}/);
assert.doesNotMatch(background, /mode: 'unavailable',\s*\n\s*allowed: true/);
assert.match(background, /allowed: false,\s*\n?\s*mode: 'unavailable'/);

// ---- 閘門覆蓋 ----
// 所有會實際動作的入口都要先過「使用須知」再過「授權」。
const GATED_COMMANDS = ['captureAuto', 'captureAutoAndCompare', 'manualStart', 'compare'];
for (const cmd of GATED_COMMANDS) {
  const at = background.indexOf(`case '${cmd}':`);
  assert.ok(at > 0, `找不到指令 ${cmd}`);
  const block = background.slice(at, at + 700);
  assert.match(block, /if \(!\(await assertDisclaimer\(\)\)\)/, `${cmd} 缺少使用須知閘門`);
  assert.match(block, /const gate = await assertCoreAccess\(\);/, `${cmd} 缺少授權閘門`);
  assert.ok(
    block.indexOf('assertDisclaimer') < block.indexOf('assertCoreAccess'),
    `${cmd} 的使用須知閘門必須排在授權閘門之前`
  );
}

// 閘門的實作本身
assert.match(background, /async function assertCoreAccess\(\)\s*\{\s*const access = await checkLiveCoreAccess\(\);/);
assert.match(background, /async function assertDisclaimer\(\)\s*\{\s*if \(await getDisclaimerAccepted\(\)\) return true;/);

// ---- 閘門必須在背景，不能只靠 popup ----
// popup 只是顯示層；把判斷放在 popup 的話，直接對背景發訊息就能繞過。
const popup = read('popup.js');
assert.doesNotMatch(popup, /classifyCoreLicenseStatus/,
    'popup 不應自行判斷授權，一律問背景');
assert.match(popup, /send\('accessStatus'\)/);

// ---- 取得方式的不變條件 ----
// i智慧 必須走攔截。API 版程式碼可以留著，但不得成為預設。
assert.match(background, /const SOURCE_MODE = \{\s*\n\s*ismart: 'intercept'/,
  'SOURCE_MODE.ismart 必須是 intercept');

console.log('AdMirror kill-switch checks passed.');
