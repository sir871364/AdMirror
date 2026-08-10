const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const scripts = ['popup.js', 'result.js', 'disclaimer.js', 'src/disclaimer.js'];

for (const file of scripts) {
  const source = fs.readFileSync(path.join(root, file), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*/m, '')
    .replace(/^export\s+/gm, '');
  new vm.Script(source, { filename: file });
}

JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
console.log('AdMirror build checks passed.');
