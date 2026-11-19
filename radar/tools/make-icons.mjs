// Generates icons/icon-192.png and icons/icon-512.png with no dependencies.
// Draws a radar: dark background, green range rings, sweep wedge, a few blips.
// Content stays inside the central 80% so the 512 icon also works as "maskable".
//   node tools/make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hexRgb('#03120b');
const RING = hexRgb('#3dff9a');
const DIM = hexRgb('#1f6b47');
const CYAN = hexRgb('#5fd8ff');
const RED = hexRgb('#ff2e2e');
const WHITE = hexRgb('#ffffff');

/** Colour + alpha at a point in [-1, 1]^2 (y down), layered back to front. */
function sample(u, v) {
  const r = Math.hypot(u, v);
  const layers = [[BG, 1]];
  const ang = Math.atan2(u, -v); // 0 = up, clockwise
  // sweep wedge: 0..60 degrees clockwise from north, fading
  if (r < 0.78 && ang > 0 && ang < Math.PI / 3) layers.push([RING, 0.35 * (1 - ang / (Math.PI / 3))]);
  // crosshair
  if ((Math.abs(u) < 0.012 || Math.abs(v) < 0.012) && r < 0.78) layers.push([DIM, 1]);
  // rings
  for (const [rr, w, col] of [[0.27, 0.022, DIM], [0.52, 0.022, DIM], [0.78, 0.04, RING]]) {
    if (Math.abs(r - rr) < w / 2) layers.push([col, 1]);
  }
  // blips
  for (const [bx, by, br, col] of [[0.30, -0.42, 0.085, RED], [-0.44, 0.22, 0.07, CYAN], [0.0, 0.0, 0.06, WHITE]]) {
    if (Math.hypot(u - bx, v - by) < br) layers.push([col, 1]);
  }
  let out = [0, 0, 0];
  for (const [col, a] of layers) out = out.map((c, i) => c * (1 - a) + col[i] * a);
  return out;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 supersampling for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = ((x + (sx + 0.5) / SS) / size) * 2 - 1;
          const v = ((y + (sy + 0.5) / SS) / size) * 2 - 1;
          const c = sample(u, v);
          acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
      }
      const i = (y * size + x) * 4;
      buf[i] = Math.round(acc[0] / (SS * SS));
      buf[i + 1] = Math.round(acc[1] / (SS * SS));
      buf[i + 2] = Math.round(acc[2] / (SS * SS));
      buf[i + 3] = 255;
    }
  }
  return buf;
}

mkdirSync(OUT, { recursive: true });
for (const size of [192, 512]) {
  const file = join(OUT, `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
