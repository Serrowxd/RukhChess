import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, classOf, luma, clipStats } from './clipcheck.mjs';

const NON_PIECE = new Set(['bg', 'light', 'dark', 'frame', 'table', 'glyphs']);

function percentile(values, p) {
  if (!values.length) return NaN;

  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

const median = (v) => percentile(v, 0.5);

/** Convex quad (4 points, either winding) contains (x, y). */
function inQuad(q, x, y) {
  let sign = 0;

  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4];
    const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (c !== 0) {
      if (sign === 0) sign = Math.sign(c);
      else if (Math.sign(c) !== sign) return false;
    }
  }

  return true;
}

export function readability(beautyBuf, maskBuf, geo) {
  const img = decodePng(beautyBuf), mask = decodePng(maskBuf);
  const W = img.width, H = img.height;
  const cls = new Array(W * H);
  const Y = new Float32Array(W * H);

  for (let p = 0; p < W * H; p++) {
    const j = p * mask.channels, i = p * img.channels;
    cls[p] = classOf(mask.data[j], mask.data[j + 1], mask.data[j + 2]);
    Y[p] = luma(img.data[i], img.data[i + 1], img.data[i + 2]);
  }

  const clampX = (x) => Math.max(0, Math.min(W - 1, Math.round(x))), clampY = (y) => Math.max(0, Math.min(H - 1, Math.round(y)));

  // far crowns
  const crowns = [];
  for (const f of geo.far || []) {
    const [bx0, by0, bx1, by1] = f.bbox;
    if (!(bx1 > bx0 && by1 > by0)) continue;

    const army = f.color === 'black' ? 'black' : 'white';
    const h = by1 - by0, w = bx1 - bx0, pad = Math.max(6, Math.round(0.35 * w));
    const cy1 = by0 + 0.4 * h;
    const crown = [], back = [];

    for (let y = clampY(by0 - pad); y <= clampY(cy1); y++) {
      for (let x = clampX(bx0 - pad); x <= clampX(bx1 + pad); x++) {
        const p = y * W + x, c = cls[p];
        if (c === army && x >= bx0 && x <= bx1 && y >= by0) crown.push(Y[p]);
        else if (NON_PIECE.has(c)) back.push(Y[p]);
      }
    }

    if (crown.length < 20 || back.length < 20) continue;

    const body = median(crown), rim = percentile(crown, 0.98), bg = median(back);
    const contrast = Math.max(body, bg) / Math.max(1, Math.min(body, bg));
    const rimRatio = rim / Math.max(1, bg);
    crowns.push({ square: f.square, role: f.role, army, body: +body.toFixed(1), rim: +rim.toFixed(1), back: +bg.toFixed(1),
      contrast: +contrast.toFixed(2), rimRatio: +rimRatio.toFixed(2), separation: +Math.max(contrast, rimRatio).toFixed(2) });
  }

  // frame / table / room means
  const sums = {};
  for (let p = 0; p < W * H; p++) {
    const c = cls[p];
    if (!c) continue;
    (sums[c] = sums[c] || [0, 0]);
    sums[c][0] += Y[p];
    sums[c][1]++;
  }

  const mean = (c) => (sums[c] && sums[c][1] ? +(sums[c][0] / sums[c][1]).toFixed(1) : null);

  // checker
  const sqLuma = {};
  for (const [sq, quad] of Object.entries(geo.squares || {})) {
    if (!quad || quad.some((q) => !q)) continue;

    const dark = ('abcdefgh'.indexOf(sq[0]) + Number(sq[1]) - 1) % 2 === 0;
    const want = dark ? 'dark' : 'light';
    const xs = quad.map((q) => q[0]), ys = quad.map((q) => q[1]);
    const vals = [];

    for (let y = clampY(Math.min(...ys)); y <= clampY(Math.max(...ys)); y++) {
      for (let x = clampX(Math.min(...xs)); x <= clampX(Math.max(...xs)); x++) {
        const p = y * W + x;
        if (cls[p] === want && inQuad(quad, x, y)) vals.push(Y[p]);
      }
    }

    if (vals.length >= 30) sqLuma[sq] = { luma: median(vals), dark };
  }

  let worst = null, under2 = 0, pairs = 0;
  const F = 'abcdefgh';

  for (const [sq, a] of Object.entries(sqLuma)) {
    const f = F.indexOf(sq[0]), r = Number(sq[1]);

    for (const [df, dr] of [[1, 0], [0, 1]]) {
      const n = (F[f + df] || '') + (r + dr);
      const b = sqLuma[n];
      if (!b) continue;

      const ratio = Math.max(a.luma, b.luma) / Math.max(1, Math.min(a.luma, b.luma));
      pairs++;
      if (ratio < 2) under2++;
      if (!worst || ratio < worst.ratio) worst = { pair: sq + '/' + n, ratio: +ratio.toFixed(2), lumas: [+a.luma.toFixed(1), +b.luma.toFixed(1)] };
    }
  }

  const lights = Object.values(sqLuma).filter((s) => !s.dark).map((s) => s.luma), darks = Object.values(sqLuma).filter((s) => s.dark).map((s) => s.luma);

  const clip = clipStats(beautyBuf, maskBuf);
  const seps = crowns.map((c) => c.separation);

  return {
    far: {
      rank: geo.farRank, n: crowns.length,
      minSeparation: seps.length ? Math.min(...seps) : null, medianSeparation: seps.length ? +median(seps).toFixed(2) : null,
      pieces: crowns,
    },
    means: { frame: mean('frame'), table: mean('table'), room: mean('bg'), light: mean('light'), dark: mean('dark') },
    checker: {
      squares: Object.keys(sqLuma).length, pairs, under2, worst,
      lightMedian: lights.length ? +median(lights).toFixed(1) : null, darkMedian: darks.length ? +median(darks).toFixed(1) : null,
    },
    clip: { board: clip.board.clipped, table: clip.table.clipped, boardHot: clip.board.hot, tableHot: clip.table.hot },
  };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
  };

  const dir = args[0];
  if (!dir) {
    console.error('usage: node tools/readability.mjs <dir> [--prefix classic] [--json out.json]');
    process.exit(2);
  }

  const prefix = opt('prefix', '');
  const out = {};

  for (const m of readdirSync(dir).filter((f) => f.endsWith('-mask.png') && f.startsWith(prefix)).sort()) {
    const base = m.replace(/-mask\.png$/, '');
    const geoFile = join(dir, base + '-geo.json');
    if (!existsSync(geoFile)) continue;

    const r = readability(readFileSync(join(dir, base + '.png')), readFileSync(join(dir, m)), JSON.parse(readFileSync(geoFile, 'utf8')));
    out[base] = r;

    const f = r.far, c = r.checker;
    const worstPiece = f.pieces.reduce((a, b) => (!a || b.separation < a.separation ? b : a), null);

    console.log(`${base}\n  far rank ${f.rank}: separation min ${f.minSeparation} median ${f.medianSeparation}`
      + (worstPiece ? `  (weakest ${worstPiece.square} ${worstPiece.role}: body ${worstPiece.body} rim ${worstPiece.rim} back ${worstPiece.back})` : ''));
    console.log(`  means: frame ${r.means.frame}  table ${r.means.table}  room ${r.means.room}  squares light ${r.means.light} dark ${r.means.dark}`);
    console.log(`  checker: ${c.squares} squares, weakest neighbours ${c.worst ? c.worst.pair + ' ' + c.worst.ratio + ':1 ' + JSON.stringify(c.worst.lumas) : '-'}, pairs under 2:1 ${c.under2}/${c.pairs}`);
    console.log(`  clip: board ${r.clip.board} (hot ${r.clip.boardHot})  table ${r.clip.table} (hot ${r.clip.tableHot})`);
  }

  const json = opt('json', null);
  if (json) writeFileSync(json, JSON.stringify(out, null, 1));
}
