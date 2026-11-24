/**
 * 生成插件图标（纯 Node + zlib，无任何依赖）
 * 设计：圆角渐变底 + 白色双向箭头（翻译符号），4x 超采样抗锯齿
 * 用法：node scripts/gen-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: None
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 形状定义（0..1 归一化坐标） ---------------- */
const CORNER_R = 0.22;

function inRoundRect(x, y) {
  const cx = 0.5, cy = 0.5, hw = 0.5, hh = 0.5, rr = CORNER_R;
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  if (dx <= hw - rr || dy <= hh - rr) return dx <= hw && dy <= hh;
  const qx = dx - (hw - rr);
  const qy = dy - (hh - rr);
  return qx * qx + qy * qy <= rr * rr;
}

function inArrowRight(x, y) {
  // 横杆
  if (x >= 0.24 && x <= 0.68 && y >= 0.345 && y <= 0.425) return true;
  // 箭头三角（顶点收窄）
  if (x >= 0.68 && x <= 0.84) {
    const t = (x - 0.68) / 0.16;
    const half = 0.115 * (1 - t);
    return Math.abs(y - 0.385) <= half;
  }
  return false;
}

// 左箭头 = 右箭头中心对称（自动落在下半区、指向左侧）
function inArrowLeft(x, y) {
  return inArrowRight(1 - x, 1 - y);
}

/* ---------------- 渲染 ---------------- */
function renderIcon(size) {
  const SS = 4; // 4x 超采样
  const W = size * SS;
  const bgCov = new Float32Array(size * size);
  const glyphCov = new Float32Array(size * size);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let gl = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) / W;
          const y = (py * SS + sy + 0.5) / W;
          if (inRoundRect(x, y)) {
            bg++;
            if (inArrowRight(x, y) || inArrowLeft(x, y)) gl++;
          }
        }
      }
      const i = py * size + px;
      bgCov[i] = bg / (SS * SS);
      glyphCov[i] = gl / (SS * SS);
    }
  }

  const c1 = [91, 108, 255]; // #5b6cff
  const c2 = [56, 189, 248]; // #38bdf8
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = (i % size) / (size - 1);
    const y = Math.floor(i / size) / (size - 1);
    const t = Math.min(1, Math.max(0, (x + y) / 2));
    let r = c1[0] + (c2[0] - c1[0]) * t;
    let g = c1[1] + (c2[1] - c1[1]) * t;
    let b = c1[2] + (c2[2] - c1[2]) * t;
    // 白色双向箭头
    const gl = glyphCov[i];
    r += (255 - r) * gl;
    g += (255 - g) * gl;
    b += (255 - b) * gl;
    rgba[i * 4] = Math.round(r);
    rgba[i * 4 + 1] = Math.round(g);
    rgba[i * 4 + 2] = Math.round(b);
    rgba[i * 4 + 3] = Math.round(bgCov[i] * 255);
  }
  return rgba;
}

/* ---------------- 输出 ---------------- */
const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = encodePNG(size, size, renderIcon(size));
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`written: ${file} (${png.length} bytes)`);
}
