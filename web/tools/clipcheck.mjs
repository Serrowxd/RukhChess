// tools/clipcheck.mjs -- count blown-out pixels on the board, the frame and the table in shoot.mjs captures.
//
//   node tools/clipcheck.mjs <dir> [--prefix classic] [--limit 250]
//
// For every `<prefix>-<view>-mask.png` in <dir> (written by `shoot.mjs --mask`) it reads the matching beauty
// shot `<prefix>-<view>.png` and classifies each pixel by the nearest mask colour (PALETTE; the board is the light
// and dark squares plus the frame, the pieces are both armies). Anti-aliased mask edges, far from every palette
// colour, are skipped. A pixel is "clipped" when all of R, G and B are >= --limit (default 250), and
// "hot" when any one channel is (a warm highlight blows out red first: 252,243,193 is hot, not clipped).
// Prints one row per view and class: clipped and hot counts / pixels, the brightest pixel (by its lowest channel)
// and where it is, and the bounding box of the hot pixels. Exit code 1 if any board / frame / table pixel is clipped.
// The PNG decoder is deliberately tiny: 8-bit RGB / RGBA, non-interlaced -- what Chrome's captureScreenshot writes.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** Decode an 8-bit RGB/RGBA non-interlaced PNG -> { width, height, channels, data: Uint8Array }. */
export function decodePng(buf) {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('latin1', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      depth = body[8]; type = body[9]; interlace = body[12];
    } else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const channels = type === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y ? out[dst - stride + x] : 0;
      const c = x >= channels && y ? out[dst - stride + x - channels] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      out[dst + x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

/** The mask colours shoot.mjs paints (older masks: red = the whole board, blue = every piece -- still read). */
export const PALETTE = [
  ['bg', [0, 0, 0]], ['light', [255, 0, 0]], ['dark', [128, 0, 0]], ['frame', [255, 255, 0]], ['table', [0, 255, 0]],
  ['glyphs', [255, 0, 255]], ['white', [0, 0, 255]], ['black', [0, 255, 255]],
];
/** Which clip-report group each mask class belongs to. */
const GROUP = { bg: 'bg', light: 'board', dark: 'board', frame: 'board', table: 'table', glyphs: 'glyphs', white: 'pieces', black: 'pieces' };

/** Mask pixel -> class name (a PALETTE key), or null on an anti-aliased edge. */
export function classOf(r, g, b) {
  let best = null, bestD = 48 * 48;
  for (const [name, [pr, pg, pb]] of PALETTE) {
    const d = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb);
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

/** Luma of an 8-bit sRGB pixel (Rec. 709 weights on the display values): the "luminance 0..255" of the critiques. */
export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Clip statistics for one beauty / mask pair. */
export function clipStats(beautyBuf, maskBuf, limit = 250) {
  const img = decodePng(beautyBuf), mask = decodePng(maskBuf);
  if (img.width !== mask.width || img.height !== mask.height) throw new Error('beauty and mask differ in size');
  const stats = {};
  for (const k of ['board', 'table', 'glyphs', 'pieces', 'bg']) stats[k] = { px: 0, clipped: 0, hot: 0, max: 0, at: null, box: null };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * img.channels, j = (y * mask.width + x) * mask.channels;
      const c = classOf(mask.data[j], mask.data[j + 1], mask.data[j + 2]);
      const k = c && GROUP[c];
      if (!k) continue;
      const s = stats[k];
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      s.px++;
      const lum = Math.min(r, g, b);
      if (lum > s.max) { s.max = lum; s.maxRgb = [r, g, b]; s.at = [x, y]; }
      if (r >= limit && g >= limit && b >= limit) s.clipped++;
      if (r >= limit || g >= limit || b >= limit) {
        s.hot++;
        s.box = s.box ? [Math.min(s.box[0], x), Math.min(s.box[1], y), Math.max(s.box[2], x), Math.max(s.box[3], y)] : [x, y, x, y];
      }
    }
  }
  return stats;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
  const dir = args[0];
  if (!dir) { console.error('usage: node tools/clipcheck.mjs <dir> [--prefix classic] [--limit 250]'); process.exit(2); }
  const prefix = opt('prefix', '');
  const limit = Number(opt('limit', '250'));
  let bad = 0;
  const masks = readdirSync(dir).filter((f) => f.endsWith('-mask.png') && f.startsWith(prefix)).sort();
  for (const m of masks) {
    const beauty = m.replace(/-mask\.png$/, '.png');
    const s = clipStats(readFileSync(join(dir, beauty)), readFileSync(join(dir, m)), limit);
    const cell = (k) => `${k.padEnd(6)} clipped ${s[k].clipped} hot ${s[k].hot} of ${s[k].px}px; brightest ${s[k].maxRgb ? 'rgb(' + s[k].maxRgb.join(',') + ') at ' + s[k].at.join(',') : '-'}${s[k].box ? '; hot box ' + s[k].box.join(',') : ''}`;
    console.log(`${beauty}\n  ${cell('board')}\n  ${cell('table')}\n  ${cell('glyphs')}\n  ${cell('pieces')}`);
    bad += s.board.clipped + s.table.clipped;
  }
  if (!masks.length) console.log('no *-mask.png files found');
  console.log(bad ? `FAIL: ${bad} clipped board/frame/table pixels` : 'OK: no clipped board/frame/table pixels');
  process.exit(bad ? 1 : 0);
}
