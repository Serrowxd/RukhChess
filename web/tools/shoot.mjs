// tools/shoot.mjs -- screenshot the board from named camera angles in headless Chrome (GPU, throwaway profile).
//
//   node tools/shoot.mjs --set classic --out ./shots [--views white,low,close-king] [--fen "<FEN>"]
//                        [--theme wood] [--size 1600x1000] [--ui] [--url http://127.0.0.1:8150/]
//
// A fresh --user-data-dir per run, so nothing touches the board you actually play on (its localStorage lives in
// a different profile). The page must be served (preview "chessboard" on 8150 serves app/dist/). Views:
//   white, black, side, top          the board's own presets
//   low                              a low three-quarter view from White's side (the "hero" angle)
//   low-black                        the same from Black's side
//   close-king, close-queen, close-knight, close-bishop, close-rook, close-pawn
//                                    tight shots on White's pieces of that role (e1, d1, g1, c1, h1, e2),
//                                    turned to face the carved side
//   close-black-knight               Black's g8 knight from White's side (its face)
//   close-black-<role>               Black's king/queen/knight/bishop/rook/pawn (e8, d8, b8, f8, a8, d7) from White's side
//   orbit-<deg>                      the low view turned <deg> degrees around the board
//   piece-<square>-<deg>             around one piece, 3 units out and 1 up, <deg> from White's side (0 = from +z)
//   close-coords                     a tight look along White's near edge at the file letters and the inlay
//   under                            far and low from White's right, just over the table top: the rim, the
//                                    apron and the pedestal under it
//   corner-a1                        close on the frame's a1 corner (the mitre joint, the stringing, the gilt)
//   far                              far off White's right and looking down past the table: its foot and the floor
//   2d                               the flat 2D mode (switches back to 3D afterwards)
// Stage-only captures by default (the side panel and toolbar hidden, canvas full-window, the 3D vignette kept);
// --ui keeps the app chrome.
//   --lighting off                   capture with the lighting master switch off (the unlit look)
//   --env room|studio|plain          where the board sits (settings.environment; default: the app's own)
//   --js <file>                      evaluate a snippet in the page after setup, before the views (tuning
//                                    experiments: it can reach everything through window.__chessboard)
//   --flip                           flip the board to Black's seat first (Flip, as the app does it), so the
//                                    black / low-black views see the coordinates and glyphs oriented for Black
//   --mask                           after each view, also write <prefix>-<view>-mask.png from the same camera: an
//                                    object-ID render (light squares red, dark squares dark red, frame + stringing
//                                    yellow, table green, White's pieces blue, Black's cyan, coordinate glyphs
//                                    magenta, everything else black), and <prefix>-<view>-geo.json: every square's
//                                    projected corners and the screen boxes of the back rank farthest from the
//                                    camera. tools/clipcheck.mjs and tools/readability.mjs read them.
//   --normals                        after each view, also write <prefix>-<view>-normals.png: the pieces' world-space
//                                    geometric normals (rgb = n * 0.5 + 0.5, no normal maps), everything else black;
//                                    tools/facecheck.mjs reads it (with --mask) to compare flat tops with side faces
// Prints one line per file written. Exit code 1 if the set never finished loading.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt; };
const flag = (name) => args.includes('--' + name);

const CHROME = opt('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const URL_ = opt('url', 'http://127.0.0.1:8150/');
const SET = opt('set', 'classic');
const THEME = opt('theme', null);
const FEN = opt('fen', null);
const OUT = resolve(opt('out', './shots'));
const [W, H] = opt('size', '1600x1000').split('x').map(Number);
const VIEWS = opt('views', 'white,low,side,close-king,close-knight,close-black-knight').split(',').filter(Boolean);
const PORT = Number(opt('port', String(9300 + Math.floor(Math.random() * 400))));
const KEEP_UI = flag('ui');
const PREFIX = opt('prefix', SET);
const LIGHTING = opt('lighting', 'on');
const MASK = flag('mask');
const NORMALS = flag('normals');
const FLIP = flag('flip');
const ENV = opt('env', null);
const JS = opt('js', null);

// The object-ID pass: flat unlit colours per part of the scene, black background, no vignette. Restored afterwards.
const MASK_ON = `(async () => {
  const cb = window.__chessboard, view = cb.view, scene = view.scene;
  let Basic = null;
  scene.traverse((o) => { if (!Basic && o.material && o.material.isMeshBasicMaterial) Basic = o.material.constructor; });
  const Color = view.lights.key.color.constructor;
  const saved = { meshes: [], bg: scene.background, env: scene.environment };
  const inside = (o, root) => { for (let p = o; p; p = p.parent) if (p === root) return true; return false; };
  const mats = new Map();
  const flat = (hex, extra) => { const k = hex + (extra ? extra.uuid : ''); if (!mats.has(k)) mats.set(k, new Basic({ color: hex, toneMapped: false, ...(extra ? { alphaMap: extra, alphaTest: 0.35 } : {}) })); return mats.get(k); };
  const colorOf = (o) => { for (let p = o; p; p = p.parent) if (p.userData && (p.userData.color === 'white' || p.userData.color === 'black')) return p.userData.color; return null; };
  const darkSq = (sq) => ('abcdefgh'.indexOf(sq[0]) + Number(sq[1]) - 1) % 2 === 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    saved.meshes.push([o, o.material, o.visible]);
    const ud = o.userData || {};
    let m = null;
    if (ud.contactShadow || ud.glyphCard) m = null;
    else if (inside(o, cb.layer.group)) m = flat(colorOf(o) === 'black' ? 0x00ffff : 0x0000ff);
    else if (inside(o, cb.board.labelGroup)) m = o.visible && o.material.map ? flat(0xff00ff, o.material.map) : null;
    else if (inside(o, cb.board.squaresGroup)) m = flat(ud.square && darkSq(ud.square) ? 0x800000 : 0xff0000);
    else if (inside(o, cb.board.frame) || o === cb.board.inlay) m = flat(0xffff00);
    else if (view.table && inside(o, view.table)) m = flat(0x00ff00);
    if (m && o.visible) o.material = m; else o.visible = false;
  });
  scene.background = new Color(0, 0, 0);
  const vig = document.querySelector('.vignette3d');
  saved.vig = vig ? vig.style.visibility : null;
  if (vig) vig.style.visibility = 'hidden';
  window.__maskSaved = { saved, mats };
  view.effects = false;   // no edge light / glow over the flat colours
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  view.render();
  return true;
})()`;
const MASK_OFF = `(async () => {
  const cb = window.__chessboard, view = cb.view, { saved, mats } = window.__maskSaved;
  view.effects = true;
  for (const [o, m, v] of saved.meshes) { o.material = m; o.visible = v; }
  view.scene.background = saved.bg;
  const vig = document.querySelector('.vignette3d');
  if (vig) vig.style.visibility = saved.vig || '';
  for (const m of mats.values()) m.dispose();
  delete window.__maskSaved;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  view.render();
  return true;
})()`;

// The normals pass: every piece drawn with its world-space geometric normal as its colour (after the colour-space
// step, so the bytes are the encoding), everything else hidden. Restored by MASK_OFF (same bookkeeping).
const NORMALS_ON = `(async () => {
  const cb = window.__chessboard, view = cb.view, scene = view.scene;
  let Basic = null;
  scene.traverse((o) => { if (!Basic && o.material && o.material.isMeshBasicMaterial) Basic = o.material.constructor; });
  const Color = view.lights.key.color.constructor;
  const saved = { meshes: [], bg: scene.background, env: scene.environment };
  const inside = (o, root) => { for (let p = o; p; p = p.parent) if (p === root) return true; return false; };
  const nm = new Basic({ toneMapped: false });
  nm.onBeforeCompile = (s) => {
    s.vertexShader = 'varying vec3 vWN;\\n' + s.vertexShader.replace('#include <begin_vertex>',
      '#include <begin_vertex>\\n\\tvWN = normalize( mat3( modelMatrix ) * normal );');
    s.fragmentShader = 'varying vec3 vWN;\\n' + s.fragmentShader.replace('#include <dithering_fragment>',
      'gl_FragColor = vec4( normalize( vWN ) * 0.5 + 0.5, 1.0 );');
  };
  nm.customProgramCacheKey = () => 'shoot-world-normals';
  const mats = new Map([['n', nm]]);
  scene.traverse((o) => {
    if (!o.isMesh) return;
    saved.meshes.push([o, o.material, o.visible]);
    const piece = inside(o, cb.layer.group) && !(o.userData && o.userData.contactShadow);
    if (piece && o.visible) o.material = nm; else o.visible = false;
  });
  scene.background = new Color(0, 0, 0);
  const vig = document.querySelector('.vignette3d');
  saved.vig = vig ? vig.style.visibility : null;
  if (vig) vig.style.visibility = 'hidden';
  window.__maskSaved = { saved, mats };
  view.effects = false;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  view.render();
  return true;
})()`;

// Geometry for the analysis tools, from the camera of the shot: squares as projected quads, and the back rank
// farthest from the camera as screen boxes (the contact decal left out, so the box is the piece).
const GEO = `(() => {
  const cb = window.__chessboard, view = cb.view, cam = view.camera, T = cam.position.constructor;
  const px = (x, y, z) => { const c = view.worldToClient({ x, y, z }); return c ? [Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10] : null; };
  const squares = {};
  for (let f = 0; f < 8; f++) for (let r = 1; r <= 8; r++) {
    const sq = 'abcdefgh'[f] + r, w = cb.board.worldFor(sq);
    squares[sq] = [px(w.x - 0.5, 0, w.z - 0.5), px(w.x + 0.5, 0, w.z - 0.5), px(w.x + 0.5, 0, w.z + 0.5), px(w.x - 0.5, 0, w.z + 0.5)];
  }
  const farRank = cam.position.z > 0 ? 8 : 1;
  const far = [];
  for (let f = 0; f < 8; f++) {
    const sq = 'abcdefgh'[f] + farRank, piece = cb.layer.meshAt(sq);
    if (!piece) continue;
    piece.updateMatrixWorld(true);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const v = new T();
    piece.traverse((o) => {
      if (!o.isMesh || (o.userData && o.userData.contactShadow)) return;
      const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 4000));
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        const c = view.worldToClient(v);
        if (!c) continue;
        x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x); y1 = Math.max(y1, c.y);
      }
    });
    far.push({ square: sq, role: piece.userData.role, color: piece.userData.color, bbox: [x0, y0, x1, y1].map(n => Math.round(n)) });
  }
  const r3 = (v) => v.toArray().map(n => +n.toFixed(3));
  return { camera: r3(cam.position), target: r3(view.controls.target), key: r3(view.lights.key.position.clone().sub(view.lights.key.target.position)),
    orientation: cb.store.state.orientation, farRank, squares, far };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'cbshot-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`,
  '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let ws;
let exitCode = 0;
const logs = [];
try {
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    if (!ws) await sleep(150);
  }
  if (!ws) throw new Error('Chrome did not start');
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
      logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      logs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text);
    return res.result.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 100; i++) { await sleep(100); if (await evaluate('!!window.__chessboard')) break; }

  // Board state: theme, position, set. Everything goes through the app's own actions.
  await evaluate(`(async () => {
    const cb = window.__chessboard;
    ${THEME ? `cb.actions.setSetting('theme', ${JSON.stringify(THEME)});` : ''}
    ${ENV ? `cb.actions.setSetting('environment', ${JSON.stringify(ENV)});` : ''}
    ${FEN ? `cb.actions.loadFen(${JSON.stringify(FEN)});` : ''}
    cb.actions.setSetting('pieceSet', ${JSON.stringify(SET)});
    cb.actions.setSetting('engine.enabled', false);
    ${LIGHTING === 'off' ? `cb.actions.setSetting('lighting.on', false);` : ''}
    ${FLIP ? `if (cb.store.state.orientation !== 'black') cb.actions.flip();` : ''}
    return true;
  })()`);
  let ready = false;
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    if (await evaluate(`window.__chessboard.layer.currentSet() === ${JSON.stringify(SET)} && !window.__chessboard.layer.isAnimating()`)) { ready = true; break; }
  }
  if (!ready) { console.error(`set '${SET}' did not load; current = ${await evaluate('window.__chessboard.layer.currentSet()')}`); exitCode = 1; }
  if (FLIP) await sleep(900);   // let the Flip's seat turn finish before any view places the camera by hand
  if (JS) console.log('js:', JSON.stringify(await evaluate(readFileSync(JS, 'utf8'))));

  if (!KEEP_UI) {
    await evaluate(`(() => {
      const st = document.createElement('style');
      st.textContent = '#panel{display:none!important} #app{display:block!important} #stage{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important}'
        + ' #stage > :not(canvas):not(.labels3d):not(.vignette3d){display:none!important}';
      document.head.appendChild(st);
      window.__chessboard.view.resize();
      return true;
    })()`);
    await sleep(300);
  }

  const ROLE_SQ = { king: 'e1', queen: 'd1', knight: 'g1', bishop: 'c1', rook: 'h1', pawn: 'e2' };
  for (const v of VIEWS) {
    const cam = await evaluate(`(async () => {
      const cb = window.__chessboard, view = cb.view, T = view.camera.position.constructor;
      const at = (sq) => cb.board.worldFor(sq);
      const put = (pos, tgt, fov) => {
        view.controls.target.copy(tgt);
        view.camera.position.copy(pos);
        if (fov) { view.camera.fov = fov; view.camera.updateProjectionMatrix(); }
        view.camera.lookAt(tgt);
        view.controls.update();
      };
      const v = ${JSON.stringify(v)};
      const settle = async () => { for (let i = 0; i < 60 && (view.transitioning || cb.layer.isAnimating()); i++) await new Promise(r => setTimeout(r, 50)); };
      if (v !== '2d' && view.viewMode === '2d') { cb.actions.setViewMode('3d'); await settle(); }
      if (v === '2d') {
        if (view.viewMode !== '2d') cb.actions.setViewMode('2d');
        await settle();
      } else if (['white', 'black', 'side', 'top'].includes(v)) {
        await view.setPreset(v);
      } else if (v === 'close-coords') {
        put(new T(-1.9, 1.55, 6.9), new T(-1.2, 0, 4.25), 35);
      } else if (v === 'far') {
        put(new T(5, 4, 21.5), new T(0, -4.5, 0), 40);
      } else if (v === 'corner-a1') {
        put(new T(-6.0, 1.3, 7.0), new T(-4.45, -0.1, 4.45), 32);
      } else if (v === 'under') {
        put(new T(16, 0.6, 6.5), new T(0, -0.3, 0), 40);
      } else if (v === 'low' || v === 'low-black' || v.startsWith('orbit-')) {
        const deg = v.startsWith('orbit-') ? Number(v.slice(6)) : (v === 'low-black' ? 180 : 0);
        const a = deg * Math.PI / 180, r = 8.6;
        put(new T(Math.sin(a) * r + 1.2 * Math.cos(a), 3.1, Math.cos(a) * r - 1.2 * Math.sin(a)), new T(0, 0.35, 0), 40);
      } else if (/^piece-[a-h][1-8]-[0-9]+$/.test(v)) {
        const [, sq, deg] = v.match(/^piece-([a-h][1-8])-([0-9]+)$/);
        const p = at(sq), a = Number(deg) * Math.PI / 180;
        put(new T(p.x + Math.sin(a) * 3.0, 1.0, p.z + Math.cos(a) * 3.0), new T(p.x, 0.45, p.z), 35);
      } else if (v === 'close-black-knight') {
        const p = at('g8');
        put(new T(p.x + 0.9, 1.0, p.z + 2.1), new T(p.x, 0.45, p.z), 35);
      } else if (v.startsWith('close-black-')) {
        // Black's pieces face White: shoot them from White's side, a little off-axis
        const SQ8 = { king: 'e8', queen: 'd8', knight: 'b8', bishop: 'f8', rook: 'a8', pawn: 'd7' };
        const p = at(SQ8[v.slice(12)] || 'e8');
        put(new T(p.x + 1.1, 1.25, p.z + 1.95), new T(p.x, 0.5, p.z), 35);
      } else if (v.startsWith('close-')) {
        const p = at(${JSON.stringify(ROLE_SQ)}[v.slice(6)] || 'e1');
        put(new T(p.x - 1.3, 1.25, p.z + 1.9), new T(p.x, 0.5, p.z), 35);
      }
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      view.render();
      return [view.camera.position.x, view.camera.position.y, view.camera.position.z].map(n => +n.toFixed(2));
    })()`);
    await sleep(250);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    const file = join(OUT, `${PREFIX}-${v}.png`);
    writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
    console.log(file, JSON.stringify(cam));
    if (MASK) {
      await evaluate(MASK_ON);
      await sleep(150);
      const m = await send('Page.captureScreenshot', { format: 'png' });
      await evaluate(MASK_OFF);
      const mfile = join(OUT, `${PREFIX}-${v}-mask.png`);
      writeFileSync(mfile, Buffer.from(m.result.data, 'base64'));
      writeFileSync(join(OUT, `${PREFIX}-${v}-geo.json`), JSON.stringify(await evaluate(GEO)));
      console.log(mfile);
    }
    if (NORMALS) {
      await evaluate(NORMALS_ON);
      await sleep(150);
      const n = await send('Page.captureScreenshot', { format: 'png' });
      await evaluate(MASK_OFF);
      const nfile = join(OUT, `${PREFIX}-${v}-normals.png`);
      writeFileSync(nfile, Buffer.from(n.result.data, 'base64'));
      console.log(nfile);
    }
  }
  if (logs.length) console.log('page console:\n  ' + logs.slice(0, 12).join('\n  '));
} catch (err) {
  console.error('shoot failed:', err && err.message ? err.message : err);
  if (logs.length) console.error('page console:\n  ' + logs.slice(0, 20).join('\n  '));
  exitCode = 1;
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a lock */ }
  process.exit(exitCode);
}
