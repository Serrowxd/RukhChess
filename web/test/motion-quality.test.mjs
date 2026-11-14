// Motion quality (three/motionQuality.js + three/scene.js): while the picture moves and the machine is not keeping
// up, frames are drawn more cheaply; once motion stops one full-quality frame is drawn.
//
// Same approach as render-on-demand.test.mjs: a DOM stubbed for three, a stand-in renderer handed in through
// createView's `deps` (this one also records the pixel ratio and the key's blur samples of every draw), and
// requestAnimationFrame driven by hand. The view's clock is a fake (deps.now), so frame intervals are exact.
//
// Run: node --test test/motion-quality.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- DOM shim (must precede three)

function makeCtx2d() {
  return {
    font: '', textAlign: '', textBaseline: '', lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',
    clearRect() {}, fillRect() {}, save() {}, restore() {}, translate() {}, rotate() {}, fillText() {}, strokeText() {},
    beginPath() {}, arc() {}, fill() {}, stroke() {},
    createRadialGradient() { return { addColorStop() {} }; },
  };
}

function makeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    style: {}, className: '', textContent: '',
    width: 0, height: 0,
    clientWidth: 800, clientHeight: 800,
    parentNode: null, children: [],
    _ctx: null,
    get ownerDocument() { return globalThis.document; },
    getRootNode() { return globalThis.document; },
    getContext() { if (!el._ctx) el._ctx = makeCtx2d(); return el._ctx; },
    setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    getBoundingClientRect() { return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight, right: el.clientWidth, bottom: el.clientHeight }; },
  };
  return el;
}

globalThis.document = {
  visibilityState: 'visible',
  createElement: tag => makeElement(tag),
  createElementNS: (_ns, tag) => makeElement(tag),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
globalThis.getComputedStyle = () => ({ position: 'relative', overflow: 'hidden' });

let queue = [];
let nextId = 1;
globalThis.requestAnimationFrame = fn => { const id = nextId++; queue.push({ id, fn }); return id; };
globalThis.cancelAnimationFrame = id => { queue = queue.filter(e => e.id !== id); };
function pump(n = 1) {
  for (let i = 0; i < n; i++) {
    const now = queue;
    queue = [];
    for (const e of now) e.fn(clock);
  }
}

const { createView } = await import('../src/three/scene.js');
const { createMotionPolicy, MOTION, MOTION_LEVELS } = await import('../src/three/motionQuality.js');
const { createStore } = await import('../src/core/store.js');

// ---------------------------------------------------------------- fakes

let clock = 1000;

/** A stand-in renderer like render-on-demand's, recording what each draw was drawn with. */
function makeRenderer() {
  const canvas = makeElement('canvas');
  return {
    domElement: canvas,
    toneMapping: null, toneMappingExposure: 1, outputColorSpace: null,
    shadowMap: { enabled: false, type: null },
    renders: 0, shadowDraws: 0, pixelRatio: 1, ratioChanges: 0,
    draws: [],   // { ratio, shadowBlur (null = map kept) } per draw
    setPixelRatio(r) { if (r !== this.pixelRatio) this.ratioChanges++; this.pixelRatio = r; },
    setClearColor() {},
    setSize(w, h) { canvas.width = w; canvas.height = h; },
    render(scene) {
      this.renders++;
      let shadowBlur = null;
      if (this.shadowMap.enabled) {
        scene.traverse(o => {
          if (o.isLight && o.castShadow && o.shadow && (o.shadow.autoUpdate || o.shadow.needsUpdate)) {
            this.shadowDraws++;
            shadowBlur = o.shadow.blurSamples;
            o.shadow.needsUpdate = false;
          }
        });
      }
      this.draws.push({ ratio: this.pixelRatio, shadowBlur });
    },
    dispose() {},
  };
}

function makeView(settings = {}) {
  const container = makeElement('div');
  const renderer = makeRenderer();
  const view = createView(container, { animations: true, ...settings },
    { renderer, labelRenderer: null, environment: false, now: () => clock });
  pump(2);
  idle(1000);
  return { view, renderer };
}

/** One animation frame `ms` after the last, with `kind` owed first (null: nothing). Returns the draw, or null. */
function tick(view, renderer, ms, kind = null) {
  clock += ms;
  if (kind) view.invalidate(kind);
  const before = renderer.draws.length;
  pump(1);
  return renderer.draws.length > before ? renderer.draws[renderer.draws.length - 1] : null;
}
/** `n` frames of motion, `ms` apart, each owing a `kind` frame. Returns the draws. */
function move(view, renderer, n, ms, kind = 'content') {
  const out = [];
  for (let i = 0; i < n; i++) { const d = tick(view, renderer, ms, kind); if (d) out.push(d); }
  return out;
}
let current = null;
function idle(ms, step = 16) {
  if (!current) { clock += ms; pump(1); return; }
  for (let t = 0; t < ms; t += step) tick(current.view, current.renderer, step);
}
function setup(settings) {
  current = null;
  const v = makeView(settings);
  current = v;
  return v;
}
const BLUR = 16;   // the key's configured blur samples (scene.js)

// ================================================================ the policy alone

test('policy: one slow interval never steps; a sustained slow run does', () => {
  const p = createMotionPolicy();
  for (let i = 0; i < 40; i++) p.sample(16.7);
  p.sample(250);
  for (let i = 0; i < 40; i++) p.sample(16.7);
  assert.equal(p.level, 0);
  for (let i = 0; i < MOTION.slowCount - 1; i++) p.sample(40);
  assert.equal(p.level, 0, 'too few slow frames in the window');
  p.sample(40);
  assert.equal(p.level, 1, `stepped once ${MOTION.slowCount} of the last ${MOTION.window} were slow`);
  assert.equal(p.interval, 0, 'the window starts again after a step');
  for (let i = 0; i < MOTION.window; i++) p.sample(40);
  assert.equal(p.level, 2);
  for (let i = 0; i < MOTION.window; i++) p.sample(40);
  assert.equal(p.level, MOTION_LEVELS.length - 1, 'reached the last level');
  for (let i = 0; i < MOTION.window - 1; i++) p.sample(40);
  assert.equal(p.level, MOTION_LEVELS.length - 1, 'never past the last level');
});

test('policy: steps that buy nothing are undone (a display capped near 30 Hz)', () => {
  const p = createMotionPolicy();
  for (let i = 0; i < 400; i++) p.sample(33.3);   // the same interval whatever is drawn
  assert.equal(p.level, 0, 'back to full quality');
  assert.ok(p.blockedAt > 30, 'and stepping down is held off');
  for (let i = 0; i < 2000; i++) p.sample(33.3);
  assert.equal(p.level, 0, 'stays there');
  for (let i = 0; i < 40; i++) p.sample(60);       // materially slower later: stepping down is on again
  assert.ok(p.level > 0);
});

test('policy: a slow GPU keeps the level that made it faster', () => {
  const cost = [50, 33.3, 33.3, 16.7];   // per level: the shadow blur and then the lower ratio pay off
  const p = createMotionPolicy();
  for (let i = 0; i < 600; i++) p.sample(cost[p.level]);
  assert.equal(p.level, 3);
  const q = createMotionPolicy();
  const cost2 = [50, 33.3, 33.3, 33.3];  // the ratio steps change nothing: keep level 1
  for (let i = 0; i < 600; i++) q.sample(cost2[q.level]);
  assert.equal(q.level, 1);
});

test('policy: failed probes back off up to maxBackoff', () => {
  const p = createMotionPolicy();
  const cost = [50, 50, 16.7, 16.7];     // level 2 is smooth, level 1 is slow
  let motion = 0;
  const probes = [];
  let last = p.level;
  while (motion < 600000) {
    p.sample(cost[p.level]);
    motion += cost[p.level];
    if (p.level < last) probes.push(motion);
    last = p.level;
  }
  const gaps = probes.slice(1).map((t, i) => t - probes[i]);
  assert.ok(Math.max(...gaps) > 8 * MOTION.probeAfterMs, 'waits past the old cap');
  assert.ok(probes.length < 12, `${probes.length} probes in 10 minutes of motion`);
  assert.equal(p.backoff, MOTION.maxBackoff);
});

// ================================================================ the view

test('fast frames never leave full quality', () => {
  const { view, renderer } = setup();
  const draws = [...move(view, renderer, 200, 16.7, 'content'), ...move(view, renderer, 200, 8.3, 'camera')];
  // a few hitches mixed in (a GC pause, a shader compile)
  for (let i = 0; i < 10; i++) { draws.push(...move(view, renderer, 12, 16.7)); draws.push(...move(view, renderer, 1, 90)); }
  assert.ok(draws.length > 500);
  assert.ok(draws.every(d => d.ratio === 1), 'full pixel ratio throughout');
  assert.ok(draws.every(d => d.shadowBlur === null || d.shadowBlur === BLUR), 'configured blur throughout');
  idle(400);
  const s = view.stats;
  assert.equal(s.level, 0);
  assert.equal(s.settles, 0, 'nothing to settle');
  assert.equal(s.reduced, false);
  assert.equal(renderer.ratioChanges, 0);
  view.dispose();
});

test('one slow frame in a run does not step the level', () => {
  const { view, renderer } = setup();
  move(view, renderer, 30, 16.7);
  move(view, renderer, 1, 140);      // a slow frame (still inside the run)
  move(view, renderer, 30, 16.7);
  move(view, renderer, 1, 120);
  move(view, renderer, 3, 16.7);
  move(view, renderer, 1, 130);
  move(view, renderer, 30, 16.7);
  assert.equal(view.stats.level, 0);
  view.dispose();
});

test('a sustained slow run steps down one level at a time, and the first frame after rest is full', () => {
  const { view, renderer } = setup();
  const draws = move(view, renderer, 12, 40, 'content');
  assert.equal(draws[0].shadowBlur, BLUR, 'the first frame of a motion is a full one');
  assert.equal(view.stats.level, 1, 'stepped to level 1');
  assert.equal(draws[draws.length - 1].shadowBlur, 4, 'level 1: the shadow blur uses 4 samples');
  assert.equal(draws[draws.length - 1].ratio, 1, 'level 1 keeps the pixel ratio');
  assert.equal(view.stats.reduced, true);
  assert.equal(view.lights.key.shadow.blurSamples, BLUR, 'the configured count is put back after each draw');
  const more = move(view, renderer, 10, 40, 'content');
  assert.equal(view.stats.level, 2);
  assert.equal(more[more.length - 1].ratio, 0.75, 'level 2: pixel ratio x 0.75');
  assert.ok(view.stats.interval_ms > 24);
  view.dispose();
});

test('settle: after motion one full frame restores the pixel ratio and blur and redraws the shadow', () => {
  const { view, renderer } = setup();
  view.setMotionLevel(3);
  const draws = move(view, renderer, 10, 16.7, 'content');
  assert.equal(draws[0].ratio, 1);
  assert.ok(draws.slice(1).every(d => d.ratio === 0.5 && d.shadowBlur === 4), 'level 3: half ratio, blur 4');
  const follow = tick(view, renderer, 16);   // the last content frame's follow-up, still part of the motion
  assert.equal(follow.ratio, 0.5);
  const shadowsBefore = renderer.shadowDraws;
  const s0 = view.stats;
  // nothing owed: frames go by without drawing until settleMs, then exactly one frame
  let settleDraw = null, at = 0;
  for (let t = 16; t <= 600; t += 16) {
    const d = tick(view, renderer, 16);
    if (d) { assert.equal(settleDraw, null, 'only one frame'); settleDraw = d; at = t; }
  }
  assert.ok(settleDraw, 'a settle frame was drawn');
  assert.ok(at >= MOTION.settleMs && at < MOTION.settleMs + 32, `settled after ~${MOTION.settleMs} ms (${at})`);
  assert.equal(settleDraw.ratio, 1, 'full pixel ratio');
  assert.equal(settleDraw.shadowBlur, BLUR, 'shadow redrawn with the configured blur');
  assert.equal(renderer.shadowDraws, shadowsBefore + 1);
  const s1 = view.stats;
  assert.equal(s1.settles, s0.settles + 1);
  assert.equal(s1.reduced, false);
  assert.equal(s1.shadowUpdates, s0.shadowUpdates + 1);
  view.dispose();
});

test('settle redraws the shadow only when it is owed, and is skipped when nothing was reduced', () => {
  const { view, renderer } = setup();
  view.setMotionLevel(2);
  move(view, renderer, 10, 16.7, 'camera');   // camera motion: the shadow map is kept as it was
  assert.equal(renderer.pixelRatio, 0.75);
  const shadows = renderer.shadowDraws;
  idle(300);
  assert.equal(view.stats.settles, 1);
  assert.equal(renderer.pixelRatio, 1);
  assert.equal(renderer.shadowDraws, shadows, 'no shadow redraw: the map in use was drawn at full blur');

  view.setMotionLevel(1);
  move(view, renderer, 10, 16.7, 'camera');   // level 1 only touches shadow redraws; camera frames have none
  idle(300);
  assert.equal(view.stats.settles, 1, 'nothing was reduced: no settle frame');
  view.dispose();
});

test("quality 'full' never reduces; 'auto' does; unknown values are 'auto'", () => {
  const { view, renderer } = setup({ quality: 'full' });
  assert.equal(view.motionQuality, 'full');
  const draws = move(view, renderer, 60, 45, 'content');
  assert.ok(draws.every(d => d.ratio === 1 && d.shadowBlur === BLUR));
  idle(300);
  assert.equal(view.stats.level, 0);
  assert.equal(view.stats.settles, 0);
  assert.equal(renderer.ratioChanges, 0);
  view.setMotionQuality('auto');
  move(view, renderer, 12, 45, 'content');
  assert.equal(view.stats.level, 1);
  assert.equal(view.setMotionQuality('turbo'), 'auto');
  view.dispose();
  const odd = setup({ quality: 42 });
  assert.equal(odd.view.motionQuality, 'auto');
  odd.view.dispose();
});

test('settings.quality defaults to auto and an unknown stored value loads as auto', () => {
  const mem = new Map([['chessboard.settings', JSON.stringify({ quality: 'turbo' })]]);
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  const s = createStore({ storage, autosaveDelay: 0 });
  assert.equal(s.state.settings.quality, 'auto');
  s.actions.setSetting('quality', 'full');
  assert.equal(s.state.settings.quality, 'full');
  s.actions.setSetting('quality', 'fast');
  assert.equal(s.state.settings.quality, 'auto');
  assert.equal(createStore({ storage: null }).state.settings.quality, 'auto');
});

test('the level is remembered between motions, probed upward, and backs off when a probe fails', () => {
  const { view, renderer } = setup();
  move(view, renderer, 12, 40, 'content');
  assert.equal(view.stats.level, 1);
  idle(400);
  assert.equal(view.stats.settles, 1);

  // the next motion starts at the remembered level (from its second frame; the first is a full one)
  const next = move(view, renderer, 3, 16.7, 'content');
  assert.equal(next[0].shadowBlur, BLUR);
  assert.equal(next[1].shadowBlur, 4, 'remembered level 1');

  // smooth motion: one level up after about MOTION.probeAfterMs
  let n = 0;
  while (view.stats.level === 1 && n < 1000) { move(view, renderer, 1, 16.7); n++; }
  assert.equal(view.stats.level, 0, 'probed up');
  const firstWait = n * 16.7;
  assert.ok(firstWait >= MOTION.probeAfterMs - 200 && firstWait < MOTION.probeAfterMs + 600, `first probe after ${firstWait} ms`);

  // the probe fails at once: back down, and the next probe waits twice as long
  move(view, renderer, 12, 40);
  assert.equal(view.stats.level, 1, 'stepped back down');
  n = 0;
  while (view.stats.level === 1 && n < 2000) { move(view, renderer, 1, 16.7); n++; }
  const secondWait = n * 16.7;
  assert.equal(view.stats.level, 0);
  assert.ok(secondWait >= 2 * MOTION.probeAfterMs - 200, `backed off: second probe after ${secondWait} ms`);

  // a probe that holds resets the back-off
  move(view, renderer, Math.ceil(MOTION.probeConfirmMs / 16.7) + 20, 16.7);
  move(view, renderer, 12, 40);
  assert.equal(view.stats.level, 1);
  n = 0;
  while (view.stats.level === 1 && n < 2000) { move(view, renderer, 1, 16.7); n++; }
  assert.ok(n * 16.7 < MOTION.probeAfterMs + 600, 'held probe: the wait is back to the base');
  view.dispose();
});

test('setMotionLevel pins the level during motion; null returns to automatic; frames at rest stay full', () => {
  const { view, renderer } = setup();
  assert.equal(view.setMotionLevel(3), 3);
  assert.equal(view.stats.level, 3);
  let d = move(view, renderer, 5, 16.7, 'camera');
  assert.ok(d.slice(1).every(x => x.ratio === 0.5));
  idle(300);
  // isolated frames (a click: one content frame and its follow-up) are drawn at full quality, no settle needed
  const settles = view.stats.settles;
  d = move(view, renderer, 1, 16.7, 'content');
  d.push(tick(view, renderer, 16.7));   // its follow-up frame, nothing else owed
  assert.equal(d.length, 2);
  assert.ok(d.every(x => x.ratio === 1 && (x.shadowBlur === null || x.shadowBlur === BLUR)), 'single change at full quality');
  idle(300);
  assert.equal(view.stats.settles, settles);
  assert.equal(view.setMotionLevel(null), 0, 'automatic again (and this machine is fast)');
  view.dispose();
});

test('2D keeps its own memory of the level', async () => {
  const { view, renderer } = setup();
  move(view, renderer, 12, 40, 'content');
  assert.equal(view.stats.level, 1);
  await view.setViewMode('2d', { animate: false });
  idle(400);
  assert.equal(view.stats.level, 0, '2D starts at full quality');
  await view.setViewMode('3d', { animate: false });
  idle(400);
  assert.equal(view.stats.level, 1, '3D remembers its level');
  view.dispose();
});

test('frames 150 ms or more apart are still motion, and step down', () => {
  const { view, renderer } = setup();
  const cost = [160, 120, 80, 50];   // a full frame takes 160 ms; each level is cheaper
  const draws = [];
  for (let i = 0; i < 80; i++) draws.push(...move(view, renderer, 1, cost[view.stats.level], 'content'));
  assert.equal(draws.length, 80, 'every frame drawn');
  assert.equal(view.stats.level, 3);
  assert.ok(draws.slice(0, 9).every(d => d.shadowBlur === BLUR), 'level 0 until the window is full');
  assert.ok(draws.slice(-10).every(d => d.ratio === 0.5 && d.shadowBlur === 4), 'then reduced');
  assert.equal(view.stats.settles, 0);
  view.dispose();
});

test('one long stall in reduced motion does not draw a full frame', () => {
  const { view, renderer } = setup();
  view.setMotionLevel(3);
  move(view, renderer, 10, 16.7, 'content');
  const stall = move(view, renderer, 1, 300, 'content');
  const after = move(view, renderer, 5, 16.7, 'content');
  assert.ok([...stall, ...after].every(d => d.ratio === 0.5 && d.shadowBlur === 4));
  assert.equal(view.stats.settles, 0);
  view.dispose();
});

test('changes with idle frames between them are drawn full and are never sampled', () => {
  const { view, renderer } = setup();
  const draws = [];
  for (let i = 0; i < 100; i++) {
    const d = tick(view, renderer, 16.7, 'content');
    if (d) draws.push(d);
    for (let k = 0; k < 5; k++) { const f = tick(view, renderer, 16.7); if (f) draws.push(f); }   // follow-up, then idle
  }
  assert.ok(draws.length >= 200);
  assert.ok(draws.every(d => d.ratio === 1 && (d.shadowBlur === null || d.shadowBlur === BLUR)));
  assert.equal(view.stats.level, 0);
  assert.equal(view.stats.interval_ms, 0, 'no interval sampled');
  // the same, slow: changes every 100 ms on a machine that takes 100 ms per frame, idle frames between
  for (let i = 0; i < 60; i++) { tick(view, renderer, 50, 'content'); tick(view, renderer, 50); tick(view, renderer, 50); }
  assert.equal(view.stats.level, 0);
  assert.equal(view.stats.interval_ms, 0);
  // safety-net frames at rest are not sampled either
  idle(5000);
  assert.ok(view.stats.renders > 0);
  assert.equal(view.stats.interval_ms, 0);
  assert.equal(view.stats.reduced, false);
  view.dispose();
});

test('view.stats lists the motion fields only with a real renderer, but they are readable', () => {
  const { view } = setup();
  const s = view.stats;
  assert.deepEqual(Object.keys(s).sort(), ['frames', 'renders', 'shadowUpdates']);
  assert.equal(typeof s.level, 'number');
  assert.equal(typeof s.reduced, 'boolean');
  assert.equal(typeof s.interval_ms, 'number');
  assert.equal(typeof s.settles, 'number');
  view.dispose();
});
