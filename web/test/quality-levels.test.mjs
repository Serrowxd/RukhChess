// Quality levels (settings.quality).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// DOM shim (must precede three).

function makeCtx2d() {
  return {
    font: '', textAlign: '', textBaseline: '',
    lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',

    clearRect() {}, fillRect() {},
    save() {}, restore() {}, translate() {}, rotate() {},
    fillText() {}, strokeText() {},
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

    getContext() {
      if (!el._ctx) el._ctx = makeCtx2d();
      return el._ctx;
    },

    setAttribute() {}, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    setPointerCapture() {}, releasePointerCapture() {},
    hasPointerCapture() { return false; },

    appendChild(c) {
      el.children.push(c);
      c.parentNode = el;
      return c;
    },

    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },

    getBoundingClientRect() {
      return { left: 0, top: 0, width: el.clientWidth, height: el.clientHeight, right: el.clientWidth, bottom: el.clientHeight };
    },
  };
  return el;
}

globalThis.document = {
  visibilityState: 'visible',
  createElement: tag => makeElement(tag),
  createElementNS: (_ns, tag) => makeElement(tag),
  addEventListener() {}, removeEventListener() {},
};
globalThis.window = { devicePixelRatio: 1.25, addEventListener() {}, removeEventListener() {} };
globalThis.getComputedStyle = () => ({ position: 'relative', overflow: 'hidden' });

let queue = [];
let nextId = 1;

globalThis.requestAnimationFrame = fn => {
  const id = nextId++;
  queue.push({ id, fn });
  return id;
};
globalThis.cancelAnimationFrame = id => { queue = queue.filter(e => e.id !== id); };

let clock = 1000;

function pump(n = 1) {
  for (let i = 0; i < n; i++) {
    const now = queue;
    queue = [];
    for (const e of now) e.fn(clock);
  }
}

const THREE = await import('three');
const { createView } = await import('../src/three/scene.js');
const { QUALITY, normalizeQuality: normalizeView } = await import('../src/three/motionQuality.js');
const { createStore, normalizeQuality, QUALITY_LEVELS } = await import('../src/core/store.js');
const { RING_CSS, ringTexels, ringWeight } = await import('../src/three/silhouette.js');

// A renderer that keeps a shadow map as three does.

/** A WebGL-like stand-in that builds the key's map at its mapSize, as WebGLShadowMap does. */
function makeRenderer() {
  const canvas = makeElement('canvas');
  const info = { autoReset: true, render: { triangles: 0 }, reset() { this.render.triangles = 0; } };
  let target = null;

  const r = {
    isWebGLRenderer: true, domElement: canvas, info,
    toneMapping: null, toneMappingExposure: 1, outputColorSpace: null, autoClear: true,
    pixelRatio: 1, frames: [], maps: [], rings: [], glowScales: [],
    shadowMap: {
      enabled: false, type: null, autoUpdate: true, needsUpdate: false,
      render(lights) {
        if (!this.enabled) return;

        for (const l of lights) {
          if (!l.shadow || !(l.shadow.autoUpdate || l.shadow.needsUpdate)) continue;

          if (!l.shadow.map) {
            const map = { width: l.shadow.mapSize.x, disposed: false, depthTexture: null, dispose() { this.disposed = true; } };
            l.shadow.map = map;
            r.maps.push(map);
          }

          r.shadowDraw = { size: l.shadow.map.width, blur: l.shadow.blurSamples };
          l.shadow.needsUpdate = false;
        }
      },
    },
    setPixelRatio(v) { this.pixelRatio = v; },
    getPixelRatio() { return this.pixelRatio; },
    setSize(w, h) {
      canvas.width = Math.floor(w * this.pixelRatio);
      canvas.height = Math.floor(h * this.pixelRatio);
    },
    getDrawingBufferSize: (v) => v.set(canvas.width || 64, canvas.height || 64),
    getRenderTarget: () => target,
    setRenderTarget(t) { target = t; },
    getClearAlpha: () => 0, getClearColor: (c) => c, setClearColor() {}, copyFramebufferToTexture() {},
    render(scene, camera) {
      if (!scene.isScene) return;

      const quad = scene.children.length === 1 ? scene.children[0] : null;
      const uniforms = quad && quad.material && quad.material.uniforms;
      if (uniforms && uniforms.uRing) r.rings.push({ ring: uniforms.uRing.value, ratio: r.pixelRatio });
      if (uniforms && uniforms.uDir && uniforms.uDir.value.y === 0 && target) {
        r.glowScales.push(uniforms.uDir.value.x * target.width);
      }

      if (target === null && !quad) {
        r.shadowDraw = null;
        const lights = [];
        scene.traverseVisible((o) => { if (o.isLight && o.castShadow) lights.push(o); });
        if (this.shadowMap.enabled) this.shadowMap.render(lights, scene, camera);
        r.frames.push({ ratio: r.pixelRatio, shadow: r.shadowDraw, passes: 0 });
      } else if (r.frames.length) r.frames[r.frames.length - 1].passes++;
    },
    dispose() {},
  };
  return r;
}

/** A piece the edge light outlines (a mesh under a group with a role and a colour). */
function addPiece(view) {
  const group = new THREE.Group();
  group.userData.role = 'king';
  group.userData.color = 'black';
  group.position.set(0, 0, -3);
  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.6, 0.3), new THREE.MeshStandardMaterial()));
  view.scene.add(group);
}

/** A lamp the glow picks up. */
function addLamp(view) {
  const lamp = new THREE.MeshStandardMaterial({ emissive: 0xffcc88, emissiveIntensity: 2 });
  view.scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), lamp));
}

function setup(settings = {}, ratio = 1.25) {
  globalThis.window.devicePixelRatio = ratio;
  const container = makeElement('div');
  const renderer = makeRenderer();
  const view = createView(container, { animations: true, ...settings },
    { renderer, labelRenderer: null, environment: false, now: () => clock });
  addPiece(view);
  pump(2);
  idle(view, 1000);
  return { view, renderer };
}

/** One animation frame `ms` after the last, with `kind` owed first. Returns the frame drawn, or null. */
function tick(view, renderer, ms, kind = null) {
  clock += ms;
  if (kind) view.invalidate(kind);
  const before = renderer.frames.length;
  pump(1);
  return renderer.frames.length > before ? renderer.frames[renderer.frames.length - 1] : null;
}

function move(view, renderer, n, ms, kind = 'content') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = tick(view, renderer, ms, kind);
    if (d) out.push(d);
  }
  return out;
}

function idle(view, ms) {
  for (let t = 0; t < ms; t += 16) {
    clock += 16;
    pump(1);
  }
}

/** The last full frame: a 'content' frame that redrew the key's map (or drew without shadows). */
function contentFrame(view, renderer) {
  return tick(view, renderer, 16, 'content');
}

// Normalisation.

test('settings.quality: the four levels are kept, the old full is high, anything else is auto', () => {
  for (const n of [normalizeQuality, normalizeView]) {
    for (const v of ['auto', 'high', 'medium', 'low']) assert.equal(n(v), v);
    assert.equal(n('full'), 'high');
    for (const v of ['turbo', 'Full', '', 42, null, undefined, {}, 'constructor', 'toString']) assert.equal(n(v), 'auto', String(v));
  }

  assert.deepEqual(Object.keys(QUALITY).sort(), ['auto', 'high', 'low', 'medium']);
  assert.deepEqual(QUALITY_LEVELS, Object.keys(QUALITY));

  const mem = new Map([['chessboard.settings', JSON.stringify({ quality: 'full' })]]);
  const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) };
  const s = createStore({ storage, autosaveDelay: 0 });
  assert.equal(s.state.settings.quality, 'high', 'a stored full loads as high');

  s.actions.setSetting('quality', 'low');
  assert.equal(s.state.settings.quality, 'low');
  s.actions.setSetting('quality', 'full');
  assert.equal(s.state.settings.quality, 'high');
  s.actions.setSetting('quality', 'ultra');
  assert.equal(s.state.settings.quality, 'auto');

  mem.set('chessboard.settings', JSON.stringify({ quality: 'ultra' }));
  assert.equal(createStore({ storage, autosaveDelay: 0 }).state.settings.quality, 'auto');
  assert.equal(createStore({ storage: null }).state.settings.quality, 'auto', 'the default');
});

// What each level sets.

test('each level sets its map size, blur, pixel ratio cap, shadows and effects (1.25x screen)', () => {
  const want = {
    high: { size: 2048, blur: 16, ratio: 1.25, shadows: true, effects: true },
    auto: { size: 2048, blur: 16, ratio: 1.25, shadows: true, effects: true },
    medium: { size: 1024, blur: 6, ratio: 1, shadows: true, effects: true },
    low: { size: null, blur: null, ratio: 1, shadows: false, effects: false },
  };

  for (const [q, w] of Object.entries(want)) {
    const { view, renderer } = setup({ quality: q });
    assert.equal(view.stats.quality, q);
    assert.equal(view.motionQuality, q);

    const f = contentFrame(view, renderer);
    assert.equal(f.ratio, w.ratio, `${q}: pixel ratio`);
    assert.equal(renderer.shadowMap.enabled, w.shadows, `${q}: shadows`);
    assert.equal(view.lights.key.castShadow, w.shadows, `${q}: the key casts`);
    if (w.shadows) {
      assert.deepEqual(f.shadow, { size: w.size, blur: w.blur }, `${q}: map size and blur`);
      assert.equal(view.lights.key.shadow.mapSize.x, w.size);
    } else assert.equal(f.shadow, null, `${q}: no shadow drawn`);

    assert.equal(f.passes > 0, w.effects, `${q}: edge light and glow`);
    assert.equal(view.lighting.applied.shadows, true, `${q}: the person's lighting is reported as they set it`);

    view.dispose();
  }
});

test('medium uses the same blur radius as high', () => {
  const high = setup({ quality: 'high' });
  const medium = setup({ quality: 'medium' });

  assert.equal(medium.view.lights.key.shadow.radius, high.view.lights.key.shadow.radius);

  high.view.dispose();
  medium.view.dispose();
});

test('on a 1x screen medium and low leave the pixel ratio at 1', () => {
  for (const q of ['high', 'medium', 'low']) {
    const { view, renderer } = setup({ quality: q }, 1);
    assert.equal(contentFrame(view, renderer).ratio, 1, q);
    view.dispose();
  }
});

// The person's own choices.

test("a person's shadows off wins at high; lighting off stays off", () => {
  const { view, renderer } = setup({ quality: 'high', lighting: { shadows: false } });
  const f = contentFrame(view, renderer);
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(f.shadow, null);

  view.setMotionQuality('medium');
  view.setMotionQuality('high');
  contentFrame(view, renderer);
  assert.equal(renderer.shadowMap.enabled, false, 'switching levels does not bring them back');

  view.setLighting({ shadows: true });
  assert.equal(renderer.shadowMap.enabled, true);

  view.setLighting({ on: false });
  assert.equal(renderer.shadowMap.enabled, false, 'lighting off: no shadows');
  view.setMotionQuality('high');
  view.setMotionQuality('auto');
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(view.lighting.unlit, true);
  view.dispose();

  const low = setup({ quality: 'low' });
  low.view.setLighting({ shadows: true });
  assert.equal(low.renderer.shadowMap.enabled, false, 'low has no cast shadows whatever the lighting says');

  low.view.dispose();
});

// Switching.

test('switching levels redraws once at the new level and rebuilds the shadow map at its new size', () => {
  const { view, renderer } = setup({ quality: 'high' });
  contentFrame(view, renderer);
  idle(view, 400);
  const oldMap = view.lights.key.shadow.map;
  assert.equal(oldMap.width, 2048);

  const s0 = view.stats;
  const frames0 = renderer.frames.length;

  assert.equal(view.setMotionQuality('medium'), 'medium');
  assert.equal(oldMap.disposed, true, 'the old map is disposed');
  assert.equal(view.lights.key.shadow.map, null, 'three builds the next one');

  const first = tick(view, renderer, 16);
  assert.ok(first, 'drawn on the next animation frame');
  assert.equal(first.ratio, 1, 'at the new pixel ratio, in the same draw');
  assert.deepEqual(first.shadow, { size: 1024, blur: 6 }, 'a content frame with the new map');
  assert.equal(view.lights.key.shadow.map.width, 1024);

  idle(view, 1000);
  const s1 = view.stats;
  assert.equal(s1.shadowUpdates - s0.shadowUpdates, 1, 'one shadow redraw');
  assert.ok(renderer.frames.slice(frames0).every(f => f.ratio === 1), 'no frame at the old ratio');
  assert.equal(renderer.frames.length - frames0 <= 3, true, 'the content frame, its follow-up, at most one safety net');

  assert.equal(view.setMotionQuality('medium'), 'medium');
  assert.equal(tick(view, renderer, 16), null, 'the same level again changes nothing');

  view.setMotionQuality('low');
  const low = tick(view, renderer, 16);
  assert.equal(low.shadow, null);
  assert.equal(low.passes, 0);
  assert.equal(renderer.maps.at(-1).disposed, true, 'low drops the map it no longer uses');
  assert.equal(view.lights.key.shadow.map, null);

  view.setMotionQuality('high');
  const high = tick(view, renderer, 16);
  assert.equal(high.ratio, 1.25);
  assert.deepEqual(high.shadow, { size: 2048, blur: 16 });
  assert.ok(high.passes > 0);

  view.dispose();
});

test('the store path: setSetting quality reaches the view through settings:change', () => {
  const { view, renderer } = setup({ quality: 'auto' });
  const s = createStore({ storage: null });
  s.on('settings:change', ({ path, value }) => { if (path === 'quality') view.setMotionQuality(value); });

  s.actions.setSetting('quality', 'medium');

  assert.equal(view.stats.quality, 'medium');
  assert.equal(tick(view, renderer, 16).ratio, 1);

  view.dispose();
});

// The motion policy on top.

test('high never reduces under the motion policy; auto, medium and low do', () => {
  const rest = { high: 1.25, auto: 1.25, medium: 1, low: 1 };
  for (const q of ['high', 'auto', 'medium', 'low']) {
    const { view, renderer } = setup({ quality: q });
    const cost = [50, 40, 30, 20];   // each motion level is cheaper
    const draws = [];

    for (let i = 0; i < 60; i++) draws.push(...move(view, renderer, 1, cost[view.stats.level], 'content'));

    if (q === 'high') {
      assert.ok(draws.every(d => d.ratio === 1.25 && d.shadow.blur === 16), 'high: never reduced');
      assert.equal(view.stats.level, 0);
      assert.equal(view.stats.reduced, false);
    } else {
      assert.ok(view.stats.level > 0, `${q}: stepped down`);
      assert.ok(view.stats.reduced, `${q}: reduced while moving`);

      const last = draws[draws.length - 1];
      assert.ok(last.ratio < rest[q], `${q}: a lower pixel ratio at the last level (${last.ratio})`);
      if (q === 'medium') assert.ok(draws.some(d => d.shadow && d.shadow.blur === 4), 'medium: fewer blur samples');

      idle(view, 400);
      assert.equal(view.stats.reduced, false, `${q}: back to the level at rest`);
      assert.equal(renderer.frames[renderer.frames.length - 1].ratio, rest[q], `${q}: settled at its own ratio`);
    }

    view.dispose();
  }
});

// The edge ring.

test('the edge ring is the same width in CSS pixels at ratios 1, 1.25 and 2', () => {
  for (const r of [1, 1.25, 2]) assert.ok(Math.abs(ringTexels(r) / r - RING_CSS) < 1e-12, `ratio ${r}`);

  assert.equal(ringTexels(1.25), 1.5, 'high on a 1.25x screen: 1.5 buffer pixels');
  assert.equal(ringWeight(1.25), 1);
  assert.equal(ringWeight(1), 1, 'a ring of a buffer pixel or more keeps its brightness');
  assert.equal(ringWeight(0.5), RING_CSS * 0.5, 'a smaller one is dimmed to its share');
});

test('the view hands the edge pass its pixel ratio: high and medium draw the same CSS width', () => {
  const widths = [];

  for (const [q, ratio] of [['high', 1.25], ['medium', 1.25], ['high', 2], ['high', 1]]) {
    const { view, renderer } = setup({ quality: q }, ratio);
    contentFrame(view, renderer);

    const last = renderer.rings[renderer.rings.length - 1];
    assert.ok(last, `${q} at ${ratio}: the edge drew`);
    widths.push(last.ring / last.ratio);

    view.dispose();
  }

  for (const w of widths) assert.ok(Math.abs(w - RING_CSS) < 1e-12, `CSS width ${w}`);
});

test('a new screen ratio at medium rescales the glow even when the drawn ratio stays 1', () => {
  const { view, renderer } = setup({ quality: 'medium' }, 1.25);
  addLamp(view);
  contentFrame(view, renderer);
  assert.ok(Math.abs(renderer.glowScales.at(-1) - 0.8) < 1e-9, `at 1.25x: ${renderer.glowScales.at(-1)}`);

  globalThis.window.devicePixelRatio = 2;
  view.resize();
  const f = contentFrame(view, renderer);
  assert.equal(f.ratio, 1);
  assert.ok(Math.abs(renderer.glowScales.at(-1) - 0.5) < 1e-9, `at 2x: ${renderer.glowScales.at(-1)}`);

  view.dispose();
});

test('a level switch starts the motion policy fresh and keeps a pin', () => {
  const { view, renderer } = setup({ quality: 'auto' });
  const cost = [50, 40, 30, 20];

  for (let i = 0; i < 60; i++) move(view, renderer, 1, cost[view.stats.level], 'content');
  assert.ok(view.stats.level > 0, 'auto stepped down');

  idle(view, 400);
  view.setMotionQuality('medium');
  assert.equal(view.stats.level, 0, 'medium starts at level 0');
  assert.equal(view.stats.interval_ms, 0, 'with an empty window');

  view.setMotionLevel(2);
  view.setMotionQuality('low');
  assert.equal(view.stats.level, 2, 'a pin survives the switch');

  view.dispose();
});

test('high to low drops the 2048 map; back at high three builds it again', () => {
  const { view, renderer } = setup({ quality: 'high' });
  contentFrame(view, renderer);
  const map = view.lights.key.shadow.map;
  assert.equal(map.width, 2048);

  view.setMotionQuality('low');
  assert.equal(map.disposed, true);
  assert.equal(view.lights.key.shadow.map, null);
  assert.equal(tick(view, renderer, 16).shadow, null);

  view.setMotionQuality('high');
  assert.deepEqual(tick(view, renderer, 16).shadow, { size: 2048, blur: 16 });

  view.dispose();
});
