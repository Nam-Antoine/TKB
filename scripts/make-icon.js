'use strict';
// Generates assets/icon.png (256), assets/tray.png (32) and assets/icon.ico without any dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255, da = px[i + 3] / 255, oa = sa + da * (1 - sa);
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / (oa || 1));
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / (oa || 1));
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / (oa || 1));
    px[i + 3] = Math.round(oa * 255);
  };
  const rect = (x0, y0, x1, y1, [r, g, b], radius = 0) => {
    for (let y = Math.floor(y0); y < y1; y++) for (let x = Math.floor(x0); x < x1; x++) {
      if (radius) {
        const cx = x < x0 + radius ? x0 + radius : x >= x1 - radius ? x1 - radius - 1 : x;
        const cy = y < y0 + radius ? y0 + radius : y >= y1 - radius ? y1 - radius - 1 : y;
        const d = Math.hypot(x - cx, y - cy);
        if (d > radius) continue;
        const a = d > radius - 1 ? Math.round((radius - d) * 255) : 255;
        put(x, y, r, g, b, a);
      } else put(x, y, r, g, b);
    }
  };
  const s = size / 256;
  rect(0, 0, size, size, [37, 99, 235], 52 * s);           // blue rounded square
  rect(40 * s, 56 * s, 216 * s, 216 * s, [255, 255, 255], 14 * s); // calendar sheet
  rect(40 * s, 56 * s, 216 * s, 96 * s, [30, 64, 175], 0);      // header band
  rect(40 * s, 56 * s, 216 * s, 70 * s, [30, 64, 175], 14 * s);
  rect(72 * s, 36 * s, 88 * s, 84 * s, [255, 255, 255], 6 * s);   // rings
  rect(168 * s, 36 * s, 184 * s, 84 * s, [255, 255, 255], 6 * s);
  const cols = [[16, 185, 129], [245, 158, 11], [239, 68, 68], [59, 130, 246], [139, 92, 246]];
  const cells = [[0, 0], [1, 0], [3, 0], [0, 1], [2, 1], [1, 2], [3, 2]];
  cells.forEach(([cx, cy], i) => {
    const x0 = (56 + cx * 40) * s, y0 = (108 + cy * 34) * s;
    rect(x0, y0, x0 + 30 * s, y0 + 24 * s, cols[i % cols.length], 5 * s);
  });
  return px;
}

function ico(pngBuf, size) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; entry[1] = size >= 256 ? 0 : size; entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6); entry.writeUInt32LE(pngBuf.length, 8); entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

const out = path.join(__dirname, '..', 'assets');
fs.mkdirSync(out, { recursive: true });
const big = encodePng(256, draw(256));
fs.writeFileSync(path.join(out, 'icon.png'), big);
fs.writeFileSync(path.join(out, 'tray.png'), encodePng(32, draw(32)));
fs.writeFileSync(path.join(out, 'icon.ico'), ico(big, 256));
console.log('icons written to', out);
