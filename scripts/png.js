// A very small PNG writer, plus just enough drawing to make the site's icons.
// Everything is drawn at 4x and boxed down, which is where the smooth edges
// come from -- there is no canvas in Node, so antialiasing is our own problem.

import zlib from "node:zlib";

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePNG({ w, h, data }) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4)
      .copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ draw */

export function hex(s) {
  const n = parseInt(s.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function canvas(w, h, fill) {
  const c = { w, h, data: new Uint8Array(w * h * 4) };
  if (fill) rect(c, 0, 0, w, h, fill);
  return c;
}

function put(c, x, y, col) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  c.data[i] = col[0]; c.data[i + 1] = col[1];
  c.data[i + 2] = col[2]; c.data[i + 3] = col[3];
}

export function rect(c, x, y, w, h, col) {
  for (let j = Math.max(0, y | 0); j < Math.min(c.h, (y + h) | 0); j++)
    for (let i = Math.max(0, x | 0); i < Math.min(c.w, (x + w) | 0); i++)
      put(c, i, j, col);
}

export function roundRect(c, x, y, w, h, r, col) {
  r = Math.min(r, w / 2, h / 2);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      // Only the four corner boxes need a distance test.
      const dx = i < r ? r - i - 0.5 : i > w - r - 1 ? i - (w - r) + 0.5 : 0;
      const dy = j < r ? r - j - 0.5 : j > h - r - 1 ? j - (h - r) + 0.5 : 0;
      if (dx * dx + dy * dy <= r * r) put(c, (x + i) | 0, (y + j) | 0, col);
    }
  }
}

export function circle(c, cx, cy, rad, col) {
  for (let j = (cy - rad) | 0; j <= cy + rad; j++)
    for (let i = (cx - rad) | 0; i <= cx + rad; i++) {
      const dx = i + 0.5 - cx, dy = j + 0.5 - cy;
      if (dx * dx + dy * dy <= rad * rad) put(c, i, j, col);
    }
}

export function downsample(c, f) {
  const w = c.w / f, h = c.h / f;
  const out = canvas(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < f; j++)
        for (let i = 0; i < f; i++) {
          const k = ((y * f + j) * c.w + (x * f + i)) * 4;
          r += c.data[k]; g += c.data[k + 1]; b += c.data[k + 2]; a += c.data[k + 3];
        }
      const n = f * f, k = (y * w + x) * 4;
      out.data[k] = r / n; out.data[k + 1] = g / n;
      out.data[k + 2] = b / n; out.data[k + 3] = a / n;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ type */
// A 5x7 bitmap alphabet. Node has no font rasteriser, and the blocky result
// sits well next to the app's IBM Plex Mono.

const FONT = {
  A: "01110 10001 10001 11111 10001 10001 10001",
  B: "11110 10001 10001 11110 10001 10001 11110",
  C: "01110 10001 10000 10000 10000 10001 01110",
  D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111",
  F: "11111 10000 10000 11110 10000 10000 10000",
  G: "01110 10001 10000 10111 10001 10001 01111",
  H: "10001 10001 10001 11111 10001 10001 10001",
  I: "11111 00100 00100 00100 00100 00100 11111",
  J: "00111 00010 00010 00010 00010 10010 01100",
  K: "10001 10010 10100 11000 10100 10010 10001",
  L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001",
  N: "10001 11001 10101 10011 10001 10001 10001",
  O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000",
  Q: "01110 10001 10001 10001 10101 10010 01101",
  R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110",
  T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110",
  V: "10001 10001 10001 10001 10001 01010 00100",
  W: "10001 10001 10001 10101 10101 11011 10001",
  X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100",
  Z: "11111 00001 00010 00100 01000 10000 11111",
  " ": "00000 00000 00000 00000 00000 00000 00000",
  ".": "00000 00000 00000 00000 00000 01100 01100",
  "-": "00000 00000 00000 11111 00000 00000 00000",
};

export function textWidth(s, px, gap) {
  return s.length * (5 * px + gap) - gap;
}

export function text(c, s, x, y, px, col, gap = 0) {
  let cx = x;
  for (const ch of s.toUpperCase()) {
    const rows = (FONT[ch] || FONT[" "]).split(" ");
    rows.forEach((row, j) => {
      [...row].forEach((bit, i) => {
        if (bit === "1") rect(c, cx + i * px, y + j * px, px, px, col);
      });
    });
    cx += 5 * px + gap;
  }
  return cx - gap;
}
