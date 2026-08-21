import { qrcode } from '../lib/qrcode-generator.mjs';

export async function createQrDataUrl(value, targetSize = 240) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('QR Code value must be a non-empty string.');
  }

  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();

  const quietZoneModules = 4;
  const cellSize = Math.max(
    1,
    Math.floor(targetSize / (qr.getModuleCount() + quietZoneModules * 2))
  );
  return qr.createDataURL(cellSize, cellSize * quietZoneModules);
}
