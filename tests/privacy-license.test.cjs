const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const textFiles = [];

function collectTextFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectTextFiles(fullPath);
    else if (!/\.(png|jpg|jpeg|gif|zip)$/i.test(entry.name)) textFiles.push(fullPath);
  }
}

collectTextFiles(root);
const forbiddenQrHost = ['api', 'qrserver', 'com'].join('.');
for (const file of textFiles) {
  assert.equal(fs.readFileSync(file, 'utf8').includes(forbiddenQrHost), false, file);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.host_permissions.some((value) => value.includes('qrserver')), false);
assert.equal(manifest.content_security_policy.extension_pages.includes('qrserver'), false);
assert.ok(manifest.content_security_policy.extension_pages.includes("img-src 'self' data:"));
assert.ok(manifest.permissions.includes('identity'));
assert.ok(manifest.permissions.includes('identity.email'));

const config = fs.readFileSync(path.join(root, 'src', 'config.js'), 'utf8');
assert.match(config, /LICENSE_API_BASE_URL/);
assert.match(config, /\/api\/request-license/);
assert.match(config, /\/api\/license-status/);
assert.match(config, /\/api\/trial-status/);

for (const file of ['popup.js', 'result.js']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.doesNotMatch(source, /sir8713642\.workers\.dev/, file);
}

const popup = fs.readFileSync(path.join(root, 'popup.js'), 'utf8');
assert.match(popup, /createQrDataUrl\(approveUrl, 240\)/);

const privacy = fs.readFileSync(path.join(root, 'PRIVACY.md'), 'utf8');
assert.match(privacy, /## 業務比對資料/);
assert.match(privacy, /## 授權驗證/);
assert.match(privacy, /瀏覽器本機/);

(async () => {
  const moduleUrl = pathToFileURL(path.join(root, 'src', 'local-qr.mjs'));
  const { createQrDataUrl } = await import(moduleUrl.href);
  const approvalUrl = 'https://example.test/approve?request_id=exact-value-123';
  const dataUrl = await createQrDataUrl(approvalUrl, 240);
  assert.match(dataUrl, /^data:image\/gif;base64,/);
  assert.ok(dataUrl.length > 100);
  console.log('AdMirror privacy/license checks passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
