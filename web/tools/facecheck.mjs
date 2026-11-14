// tools/facecheck.mjs -- how the pieces' flat tops read against their side faces in shoot.mjs captures.
//
//   node tools/facecheck.mjs <dir> [--prefix estate]
//
// Needs `shoot.mjs --mask --normals` output: <prefix>-<view>.png, -mask.png, -normals.png and -geo.json. Per view
// and army, the piece pixels are sorted by their world-space normal:
//   top        facing up (n.y > 0.92): plinth tops, roofs, the flat of a crown
//   key side   upright (|n.y| < 0.35) and facing the key light across the table (n.xz . key.xz > 0.7)
//   camera     upright and facing the camera (n.xz . camera.xz > 0.7)
// and the report gives each group's median luma, top / key side (a back or rim light that leaks onto the tops
// shows as a ratio well over 1), and the share of top pixels above 200 (tops gone white). Luma as in
// readability.mjs: 0.2126 R + 0.7152 G + 0.0722 B on the 8-bit display values.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, classOf, luma } from './clipcheck.mjs';

const median = (v) => { if (!v.length) return NaN; const s = Float64Array.from(v).sort(); return s[Math.floor((s.length - 1) / 2)]; };
const flat = (v) => { const l = Math.hypot(v[0], v[2]) || 1; return [v[0] / l, v[2] / l]; };

/** The numbers for one capture: { white: {...}, black: {...} } with n / median per group. */
export function faceCheck(beautyBuf, maskBuf, normalsBuf, geo) {
  const img = decodePng(beautyBuf), mask = decodePng(maskBuf), nrm = decodePng(normalsBuf);
  const W = img.width, H = img.height;
  const key = flat(geo.key || [1, 1, 0]);
  const cam = flat([(geo.camera[0] - (geo.target || [0, 0, 0])[0]), 0, (geo.camera[2] - (geo.target || [0, 0, 0])[2])]);
  const out = {};
  for (const army of ['white', 'black']) out[army] = { top: [], key: [], camera: [] };
  for (let p = 0; p < W * H; p++) {
    const j = p * mask.channels, army = classOf(mask.data[j], mask.data[j + 1], mask.data[j + 2]);
    if (army !== 'white' && army !== 'black') continue;
    const k = p * nrm.channels;
    const n = [nrm.data[k] / 127.5 - 1, nrm.data[k + 1] / 127.5 - 1, nrm.data[k + 2] / 127.5 - 1];
    if (Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) > 0.15) continue;   // an anti-aliased edge
    const i = p * img.channels, y = luma(img.data[i], img.data[i + 1], img.data[i + 2]);
    const g = out[army];
    if (n[1] > 0.92) g.top.push(y);
    else if (Math.abs(n[1]) < 0.35) {
      const h = flat(n);
      if (h[0] * key[0] + h[1] * key[1] > 0.7) g.key.push(y);
      if (h[0] * cam[0] + h[1] * cam[1] > 0.7) g.camera.push(y);
    }
  }
  const res = {};
  for (const [army, g] of Object.entries(out)) {
    const top = median(g.top), ks = median(g.key), cs = median(g.camera);
    res[army] = {
      n: { top: g.top.length, key: g.key.length, camera: g.camera.length },
      top: +top.toFixed(1), keySide: +ks.toFixed(1), cameraSide: +cs.toFixed(1),
      topOverKey: +(top / Math.max(1, ks)).toFixed(2),
      whiteTops: g.top.length ? +(g.top.filter((v) => v > 200).length / g.top.length).toFixed(3) : 0,
    };
  }
  return res;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
  const dir = args[0];
  if (!dir) { console.error('usage: node tools/facecheck.mjs <dir> [--prefix estate]'); process.exit(2); }
  const prefix = opt('prefix', '');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('-normals.png') && f.startsWith(prefix)).sort()) {
    const base = f.replace(/-normals\.png$/, '');
    const need = [base + '.png', base + '-mask.png', base + '-geo.json'].map((x) => join(dir, x));
    if (!need.every(existsSync)) continue;
    const r = faceCheck(readFileSync(need[0]), readFileSync(need[1]), readFileSync(join(dir, f)), JSON.parse(readFileSync(need[2], 'utf8')));
    console.log(base);
    for (const [army, a] of Object.entries(r)) {
      if (!a.n.top && !a.n.key) continue;
      console.log(`  ${army}: top ${a.top} (n ${a.n.top})  key side ${a.keySide} (n ${a.n.key})  camera side ${a.cameraSide} (n ${a.n.camera})`
        + `  top/key ${a.topOverKey}  tops > 200: ${(a.whiteTops * 100).toFixed(1)}%`);
    }
  }
}
