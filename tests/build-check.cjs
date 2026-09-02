const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// 全部改成 ES module（背景是 type: module 的 service worker），
// 不能再用 vm.Script 檢查——那是 CJS 語意，遇到 import 會直接報錯。
// 改成複製成 .mjs 後交給 node --check。
const MODULES = [
  'background.js',
  'popup.js',
  'report.js',
  'disclaimer.js',
  'src/config.js',
  'src/core-access.js',
  'src/disclaimer.js',
  'src/local-qr.mjs',
  'lib/qrcode-generator.mjs'
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'admirror-build-'));
try {
  for (const file of MODULES) {
    const target = path.join(tmp, path.basename(file).replace(/\.m?js$/, '') + '.mjs');
    fs.writeFileSync(target, read(file));
    try {
      childProcess.execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`${file} 語法錯誤：\n${error.stderr || error.message}`);
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const manifest = JSON.parse(read('manifest.json'));

// manifest 指到的檔案都要存在
for (const file of [
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  manifest.background.service_worker,
  manifest.action.default_popup
]) {
  assert.ok(fs.existsSync(path.join(root, file)), `manifest 指向不存在的檔案：${file}`);
}

// import 路徑都要解得開（打錯路徑在 Chrome 只會靜默不載入 service worker）
for (const file of ['background.js', 'popup.js', 'report.js', 'disclaimer.js', 'src/local-qr.mjs']) {
  for (const match of read(file).matchAll(/from\s+'([^']+)'/g)) {
    const resolved = path.resolve(root, path.dirname(file), match[1]);
    assert.ok(fs.existsSync(resolved), `${file} 的 import 找不到：${match[1]}`);
  }
}

// HTML 引用的資源
for (const file of ['popup.html', 'report.html', 'disclaimer.html']) {
  for (const match of read(file).matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/.test(match[1])) continue;
    assert.ok(fs.existsSync(path.resolve(root, path.dirname(file), match[1])),
      `${file} 引用不存在的資源：${match[1]}`);
  }
}

// popup 與 disclaimer 都必須以 module 載入，否則 import 會直接失效
assert.match(read('popup.html'), /<script type="module" src="popup\.js"><\/script>/);
assert.match(read('disclaimer.html'), /<script type="module" src="disclaimer\.js"><\/script>/);

// 版號一致性：package.json 與 manifest 不同步過一次（1.3.3 vs 1.5.8），別再發生
const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.version, manifest.version,
  `package.json (${pkg.version}) 與 manifest.json (${manifest.version}) 版號不一致`);

console.log('AdMirror build checks passed.');
