// Joystyk's app icons, drawn at build time from one shape list: an arcade joystick (base,
// stick, ball top and a fire button) on the brand's night-purple tile, the same art as the
// masthead logo and the favicon. The SVG is the shape list written out; the PNGs are the same
// shapes rasterized here with 4×4 supersampling and written with a minimal PNG encoder, so the
// build needs no image library.
import { deflateSync } from 'node:zlib';

type Rgba = readonly [number, number, number, number];

type Shape =
  | {
      readonly kind: 'rect';
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly r: number;
      readonly fill: string;
    }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly r: number; readonly fill: string };

/** The brand tile color, also the web manifest's theme and background color. */
export const BRAND_BACKGROUND = '#1b1530';

/** The joystick, in a 32-unit square. */
const JOYSTICK: readonly Shape[] = [
  { kind: 'rect', x: 5, y: 21, w: 22, h: 6, r: 1.5, fill: '#e9e4ff' },
  { kind: 'rect', x: 14.5, y: 9, w: 3, h: 13, r: 0, fill: '#b3a9d9' },
  { kind: 'circle', cx: 16, cy: 9, r: 5, fill: '#ff4fa8' },
  { kind: 'circle', cx: 14.3, cy: 7.3, r: 1.5, fill: '#ffc2e0' },
  { kind: 'circle', cx: 23, cy: 24, r: 1.6, fill: '#4fd8ff' },
];

/**
 * The icon's shapes. `maskable` fills the whole square and shrinks the joystick into the
 * central safe zone (a circle of 40% of the size), as maskable icons require.
 */
export const iconShapes = (maskable: boolean): Shape[] => {
  const tile: Shape = { kind: 'rect', x: 0, y: 0, w: 32, h: 32, r: maskable ? 0 : 7, fill: BRAND_BACKGROUND };
  if (!maskable) return [tile, ...JOYSTICK];
  const k = 0.72;
  const at = (v: number): number => 16 + (v - 16) * k;
  return [
    tile,
    ...JOYSTICK.map((s): Shape =>
      s.kind === 'rect'
        ? { ...s, x: at(s.x), y: at(s.y), w: s.w * k, h: s.h * k, r: s.r * k }
        : { ...s, cx: at(s.cx), cy: at(s.cy), r: s.r * k },
    ),
  ];
};

const num = (n: number): string => String(Math.round(n * 1000) / 1000);

export const iconSvg = (maskable = false): string => {
  const body = iconShapes(maskable)
    .map((s) =>
      s.kind === 'rect'
        ? `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(s.w)}" height="${num(s.h)}"${s.r > 0 ? ` rx="${num(s.r)}"` : ''} fill="${s.fill}"/>`
        : `<circle cx="${num(s.cx)}" cy="${num(s.cy)}" r="${num(s.r)}" fill="${s.fill}"/>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>\n`;
};

const parseHex = (hex: string): Rgba => {
  const v = Number.parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
};

const covers = (s: Shape, x: number, y: number): boolean => {
  if (s.kind === 'circle') return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r;
  if (x < s.x || x > s.x + s.w || y < s.y || y > s.y + s.h) return false;
  if (s.r === 0) return true;
  const dx = Math.max(s.x + s.r - x, 0, x - (s.x + s.w - s.r));
  const dy = Math.max(s.y + s.r - y, 0, y - (s.y + s.h - s.r));
  return dx * dx + dy * dy <= s.r * s.r;
};

/** Rasterizes the shapes to straight (non-premultiplied) RGBA, `size` pixels square. */
export const rasterize = (shapes: readonly Shape[], size: number, samples = 4): Uint8Array => {
  const colors = shapes.map((s) => parseHex(s.fill));
  const out = new Uint8Array(size * size * 4);
  const scale = 32 / size;
  const n = samples * samples;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) * scale;
          const y = (py + (sy + 0.5) / samples) * scale;
          for (let i = shapes.length - 1; i >= 0; i -= 1) {
            const shape = shapes[i];
            const color = colors[i];
            if (shape !== undefined && color !== undefined && covers(shape, x, y)) {
              r += color[0];
              g += color[1];
              b += color[2];
              a += 255;
              break;
            }
          }
        }
      }
      const o = (py * size + px) * 4;
      const covered = a / 255;
      out[o] = covered === 0 ? 0 : Math.round(r / covered);
      out[o + 1] = covered === 0 ? 0 : Math.round(g / covered);
      out[o + 2] = covered === 0 ? 0 : Math.round(b / covered);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** Encodes straight RGBA pixels as an 8-bit RGBA PNG. */
export const encodePng = (rgba: Uint8Array, width: number, height: number): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rows[y * (width * 4 + 1)] = 0; // filter: none
    rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
};

export const iconPng = (size: number, maskable = false): Buffer =>
  encodePng(rasterize(iconShapes(maskable), size), size, size);
