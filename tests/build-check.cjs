const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const scripts = [
  'popup.js',
  'result.js',
  'disclaimer.js',
  'src/config.js',
  'src/core-access.js',
  'src/disclaimer.js',
  'src/local-qr.mjs'
];

for (const file of scripts) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
    .replace(/^export\s+/gm, '');
  new vm.Script(source, { filename: file });
}

JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

const resultJs = fs.readFileSync(path.join(root, 'result.js'), 'utf8');
assert.match(resultJs, /async function runBatchUnfollow\(items\)\s*{\s*if \(!items \|\| items\.length === 0\) return;\s*if \(!\(await assertCoreAccess\(\)\)\) return;\s*if \(!confirm\(/);
assert.match(resultJs, /btn\.style\.cursor = 'not-allowed';\s*btn\.textContent = '🎯 無需加關注（0 筆）';\s*btn\.disabled = true;/);
assert.match(resultJs, /const disabledAttr = hasItems \? '' : ' disabled';/);
console.log('AdMirror build checks passed.');
