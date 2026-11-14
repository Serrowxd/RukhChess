// Render on demand (three/scene.js): draw only when something visible may have changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// DOM shim: must be in place before three is imported.

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
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} };
globalThis.getComputedStyle = () => ({ position: 'relative', overflow: 'hidden' });

let queue = [];
let nextId = 1;

globalThis.requestAnimationFrame = fn => {
  const id = nextId++;
  queue.push({ id, fn });
  return id;
};
globalThis.cancelAnimationFrame = id => { queue = queue.filter(e => e.id !== id); };

/** One animation frame: every callback queued so far runs once; ones queued while running wait. */
function pump(n = 1) {
  for (let i = 0; i < n; i++) {
    const now = queue;
    queue = [];
    for (const e of now) e.fn(typeof performance !== 'undefined' ? performance.now() : Date.now());
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const THREE = await import('three');
const { createView } = await import('../src/three/scene.js');
const { requestRedraw, onRedraw } = await import('../src/three/redraw.js');
const { createBoard } = await import('../src/three/board.js');
const { createPieceLayer } = await import('../src/three/pieceLayer.js');
const { createMaterialSet } = await import('../src/three/materials.js');

// World fakes.

/** A stand-in renderer that, like three's, clears a shadow's needsUpdate when it draws the map. */
function makeRenderer() {
  const canvas = makeElement('canvas');

  return {
    domElement: canvas,
    toneMapping: null, toneMappingExposure: 1, outputColorSpace: null,
    shadowMap: { enabled: false, type: null },
    renders: 0, shadowDraws: 0, pixelRatio: 1, failNext: false,
    setPixelRatio(r) { this.pixelRatio = r; },
    setClearColor() {},
    setSize(w, h) {
      canvas.width = w;
      canvas.height = h;
    },
    render(scene) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('render failed');
      }

      this.renders++;
      if (!this.shadowMap.enabled) return;

      scene.traverse(o => {
        if (o.isLight && o.castShadow && o.shadow && (o.shadow.autoUpdate || o.shadow.needsUpdate)) {
          this.shadowDraws++;
          o.shadow.needsUpdate = false;
        }
      });
    },
    dispose() {},
  };
}

function makeView(settings = {}) {
  const container = makeElement('div');
  const renderer = makeRenderer();
  const view = createView(container, { animations: true, ...settings }, { renderer, labelRenderer: null, environment: false });
  pump(2);   // the boot frame (a full one), then the camera frame every full frame owes
  return { view, container, renderer };
}

/** stats after `fn` and `frames` animation frames, as differences from before. */
function delta(view, fn, frames = 1) {
  const a = view.stats;

  if (fn) fn();
  pump(frames);

  const b = view.stats;
  return { frames: b.frames - a.frames, renders: b.renders - a.renders, shadowUpdates: b.shadowUpdates - a.shadowUpdates };
}

// The loop.

test('the boot frame is a full frame; left alone the view draws nothing more', () => {
  const container = makeElement('div');
  const renderer = makeRenderer();
  const view = createView(container, { animations: true }, { renderer, labelRenderer: null, environment: false });
  assert.equal(view.lights.key.shadow.autoUpdate, false, 'the shadow map is not redrawn every frame');

  pump();

  const s = view.stats;
  assert.equal(s.frames, 1);
  assert.equal(s.renders, 1);
  assert.equal(s.shadowUpdates, 1, 'the first frame draws the shadow map');
  assert.equal(renderer.shadowDraws, 1);
  assert.deepEqual(delta(view, null, 1), { frames: 1, renders: 1, shadowUpdates: 0 }, 'one settling frame follows');

  const d = delta(view, null, 20);
  assert.deepEqual(d, { frames: 20, renders: 0, shadowUpdates: 0 });

  view.dispose();
});

test('view.stats is a read-only snapshot', () => {
  const { view } = makeView();

  const s = view.stats;
  s.renders = 999;

  assert.notEqual(view.stats.renders, 999);
  assert.deepEqual(Object.keys(view.stats).sort(), ['frames', 'renders', 'shadowUpdates']);

  view.dispose();
});

test("invalidate('camera') draws one frame and keeps the shadow map; 'content' redraws it", () => {
  const { view, renderer } = makeView();

  assert.deepEqual(delta(view, () => view.invalidate('camera'), 3), { frames: 3, renders: 1, shadowUpdates: 0 });

  const before = renderer.shadowDraws;
  assert.deepEqual(delta(view, () => view.invalidate('content'), 3), { frames: 3, renders: 2, shadowUpdates: 1 },
    'a content frame is followed by one camera frame');
  assert.equal(renderer.shadowDraws, before + 1);

  assert.deepEqual(delta(view, () => {
    view.invalidate('camera');
    view.invalidate('content');
  }), { frames: 1, renders: 1, shadowUpdates: 1 },
    'the stronger of two requests in one frame wins');

  view.dispose();
});

test('moving the camera draws every frame without touching the shadow map', () => {
  const { view } = makeView();

  for (let i = 0; i < 5; i++) {
    const d = delta(view, () => { view.camera.position.x += 0.2; });
    assert.equal(d.renders, 1, 'a moved camera is drawn on the next frame');
    assert.equal(d.shadowUpdates, 0, 'orbiting does not redraw the shadow map');
  }

  assert.equal(delta(view, null, 5).renders, 0, 'and stops when the camera does');

  view.dispose();
});

test('the controls moving the camera (damping included) draw camera frames only', () => {
  const { view } = makeView();
  view.controls.autoRotate = true;   // the controls move the camera every frame, as damping does after a drag

  const d = delta(view, null, 10);
  assert.equal(d.renders, 10);
  assert.equal(d.shadowUpdates, 0);

  view.controls.autoRotate = false;

  // Damping coasts the camera to rest; count frames until 30 in a row draw nothing.
  let coast = 0, quiet = 0, shadows = 0;
  while (quiet < 30 && coast < 3000) {
    const s = delta(view, null, 1);
    quiet = s.renders ? 0 : quiet + 1;
    shadows += s.shadowUpdates;
    coast++;
  }

  assert.ok(coast < 3000, 'the camera came to rest');
  assert.equal(shadows, 0, 'coasting never redraws the shadow map');
  assert.equal(delta(view, null, 60).renders, 0);

  view.dispose();
});

test('a camera tween draws each step as a camera frame', async () => {
  const { view } = makeView();
  const a = view.stats;
  let done = false;

  view.flyTo({ theta: 1.2, duration: 60 }).then(() => { done = true; });

  const t0 = Date.now();
  while (!done && Date.now() - t0 < 3000) {
    await sleep(5);
    pump();
  }

  assert.ok(done, 'the tween settled');
  const b = view.stats;
  assert.ok(b.renders - a.renders >= 2);
  assert.equal(b.shadowUpdates - a.shadowUpdates, 0);

  view.dispose();
});

test('a change to the scene nobody announced is still drawn, with its shadow', () => {
  const { view } = makeView();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());

  assert.deepEqual(delta(view, () => view.scene.add(mesh)), { frames: 1, renders: 1, shadowUpdates: 1 }, 'added');
  assert.deepEqual(delta(view, () => { mesh.position.x = 1; }), { frames: 1, renders: 1, shadowUpdates: 1 }, 'moved');
  assert.deepEqual(delta(view, () => { mesh.visible = false; }), { frames: 1, renders: 1, shadowUpdates: 1 }, 'hidden');
  assert.deepEqual(delta(view, () => { mesh.material.opacity = 0.5; }), { frames: 1, renders: 1, shadowUpdates: 1 }, 'faded');
  assert.deepEqual(delta(view, null, 5), { frames: 5, renders: 1, shadowUpdates: 0 }, 'one settling frame, then idle again');

  view.dispose();
});

test('requestRedraw (three/redraw.js) reaches the view', () => {
  const { view } = makeView();

  assert.deepEqual(delta(view, () => requestRedraw('content')), { frames: 1, renders: 1, shadowUpdates: 1 });
  assert.deepEqual(delta(view, () => requestRedraw('camera')), { frames: 1, renders: 1, shadowUpdates: 0 });

  view.dispose();
  assert.doesNotThrow(() => requestRedraw('content'), 'a disposed view has unsubscribed');
});

test('the view setters ask for full frames', () => {
  const { view } = makeView();

  assert.equal(delta(view, () => view.setLighting({ exposure: 1.3 })).shadowUpdates, 1, 'lighting');
  assert.equal(delta(view, () => view.setLighting({ shadows: false })).renders, 1, 'shadows off');
  assert.equal(delta(view, () => view.setLighting({ shadows: true })).shadowUpdates, 1, 'shadows back on redraw the map');
  assert.equal(delta(view, () => view.setMaterialSet(null)).shadowUpdates, 1, 'material set');
  assert.equal(delta(view, () => view.resize()).renders, 1, 'resize');

  view.dispose();
});

test('the safety net draws a camera frame every half second when nothing asked', async () => {
  const { view } = makeView();
  assert.equal(delta(view, null, 3).renders, 0);

  await sleep(540);

  assert.deepEqual(delta(view, null, 1), { frames: 1, renders: 1, shadowUpdates: 0 });
  assert.equal(delta(view, null, 3).renders, 0, 'and only one');

  view.dispose();
});

test('onFrame hooks: false draws nothing, a hook that returns nothing draws a full frame', () => {
  const { view } = makeView();

  let off = view.onFrame(() => false);
  assert.equal(delta(view, null, 5).renders, 0);
  off();

  off = view.onFrame(() => 'camera');
  assert.deepEqual(delta(view, null, 3), { frames: 3, renders: 3, shadowUpdates: 0 });
  off();

  off = view.onFrame(() => {});
  assert.deepEqual(delta(view, null, 3), { frames: 3, renders: 3, shadowUpdates: 3 });
  off();

  assert.deepEqual(delta(view, null, 3), { frames: 3, renders: 1, shadowUpdates: 0 }, 'one settling frame, then nothing');

  view.dispose();
});

test('board marks are drawn on the next frame', () => {
  const { view } = makeView();
  const mats = createMaterialSet('wood', null);
  const board = createBoard(view.scene, mats, {});
  pump(2);

  let asked = 0;
  const offAsk = onRedraw(() => { asked++; });

  for (const step of [
    () => board.setSelected('e2'), () => board.setLegalTargets(['e3', 'e4']), () => board.setLastMove('e2', 'e4'),
    () => board.setCheck('e1'), () => board.setArrows([{ from: 'g1', to: 'f3', color: 'green' }]),
    () => board.setHighlights([{ square: 'd4', color: 'red' }]), () => board.setArrowColors({ green: '#00ff00' }),
    () => board.setPreviewArrow({ from: 'a2', to: 'a4', color: 'blue' }), () => board.setCoordinates(false),
  ]) {
    const before = asked;
    assert.deepEqual(delta(view, step), { frames: 1, renders: 1, shadowUpdates: 1 });
    assert.ok(asked > before, 'the board asked for the frame itself');
  }

  offAsk();
  assert.deepEqual(delta(view, null, 3), { frames: 3, renders: 1, shadowUpdates: 0 });

  board.dispose();
  view.dispose();
});

test('a piece animating or dragged is drawn, with its shadow, every frame until it stops', async () => {
  const { view } = makeView();
  const mats = createMaterialSet('wood', null);
  const layer = createPieceLayer(view.scene, mats, { pieceSet: 'staunton', animations: true });
  layer.sync([{ square: 'e2', piece: { role: 'pawn', color: 'white' } }], { instant: true });
  pump(3);
  assert.equal(delta(view, null, 3).renders, 0, 'idle');

  // A move: the ticker steps the slide on its own requestAnimationFrame.
  let asked = 0;
  const offAsk = onRedraw(() => { asked++; });
  layer.sync([{ square: 'e4', piece: { role: 'pawn', color: 'white' } }], { animateFrom: { from: 'e2', to: 'e4' } });
  assert.ok(asked > 0, 'the layer asked for a frame when the move started');

  let frames = 0;
  while (layer.isAnimating() && frames < 500) {
    await sleep(4);

    const before = asked;
    const d = delta(view, null, 1);
    assert.ok(asked > before, 'the ticker asked for each step');
    assert.equal(d.renders, 1, 'every frame of the slide is drawn');
    assert.equal(d.shadowUpdates, 1, 'and its shadow follows');

    frames++;
  }

  assert.ok(!layer.isAnimating(), 'the slide finished');
  const end = delta(view, null, 1);
  assert.equal(end.renders, 1, 'the frame after the last step shows where it landed');
  assert.equal(layer.meshAt('e4').position.x, layer.worldFor('e4').x);
  assert.deepEqual(delta(view, null, 3), { frames: 3, renders: 1, shadowUpdates: 0 }, 'one settling frame, then idle');

  // A drag: the piece follows the pointer.
  layer.lift('e4');
  for (let i = 0; i < 40; i++) {
    await sleep(4);
    pump();
  }

  for (let i = 0; i < 5; i++) {
    const before = asked;
    const d = delta(view, () => layer.dragTo(new THREE.Vector3(0.1 * i, 0, 0.5)));
    assert.deepEqual(d, { frames: 1, renders: 1, shadowUpdates: 1 });
    assert.ok(asked > before, 'the layer asked for each drag step');
  }

  offAsk();
  layer.drop(null);
  for (let i = 0; i < 60; i++) {
    await sleep(4);
    pump();
  }
  assert.equal(delta(view, null, 3).renders, 0);

  layer.dispose();
  view.dispose();
});

test('a hidden tab draws nothing and draws again when it comes back', () => {
  const listeners = [];
  const prev = globalThis.document.addEventListener;
  globalThis.document.addEventListener = (type, fn) => { if (type === 'visibilitychange') listeners.push(fn); };
  const { view } = makeView();
  globalThis.document.addEventListener = prev;

  globalThis.document.visibilityState = 'hidden';
  for (const fn of listeners) fn();
  assert.equal(delta(view, () => view.invalidate('content'), 3).renders, 0);

  globalThis.document.visibilityState = 'visible';
  for (const fn of listeners) fn();
  assert.deepEqual(delta(view, null, 2), { frames: 2, renders: 2, shadowUpdates: 1 });

  view.dispose();
});

test('a content frame is followed by exactly one camera frame, then silence', () => {
  const { view } = makeView();

  assert.deepEqual(delta(view, () => view.invalidate('content')), { frames: 1, renders: 1, shadowUpdates: 1 });
  assert.deepEqual(delta(view, null, 1), { frames: 1, renders: 1, shadowUpdates: 0 }, 'the settling frame');
  assert.deepEqual(delta(view, null, 10), { frames: 10, renders: 0, shadowUpdates: 0 });

  // Content frames in a row owe one camera frame, only after the last of them.
  for (let i = 0; i < 4; i++) assert.deepEqual(delta(view, () => view.invalidate('content')), { frames: 1, renders: 1, shadowUpdates: 1 });
  assert.deepEqual(delta(view, null, 5), { frames: 5, renders: 1, shadowUpdates: 0 });

  view.dispose();
});

/** A view on a test clock, spun by auto-rotate with `spinMs` frames, then left to coast to rest on 1 ms frames. */
function spinToRest(spinMs) {
  let clock = 1000;
  const renderer = makeRenderer();
  const view = createView(makeElement('div'), { animations: true }, { renderer, labelRenderer: null, environment: false, now: () => clock });

  const run = (ms, n = 1) => {
    for (let i = 0; i < n; i++) {
      clock += ms;
      pump();
    }
  };

  run(1, 2);
  view.controls.autoRotate = true;
  run(spinMs, 10);
  view.controls.autoRotate = false;

  let quiet = 0;
  let coast = 0;
  while (quiet < 30 && coast < 3000) {
    const before = view.stats.renders;
    run(1);
    quiet = view.stats.renders === before ? quiet + 1 : 0;
    coast++;
  }

  return { view, run, coast };
}

function cameraMatrix(view) {
  view.camera.updateMatrixWorld();
  return [...view.camera.matrixWorld.elements];
}

test('after damping, the camera really stops and its resting place is drawn', () => {
  const { view, run, coast } = spinToRest(1);
  assert.ok(coast < 3000, 'the camera came to rest');
  assert.equal(view.controls._sphericalDelta.theta, 0, 'leftover damping was cleared');

  const rest = cameraMatrix(view);
  const before = view.stats.renders;
  run(1, 200);

  assert.equal(view.stats.renders - before, 0);
  assert.deepEqual(cameraMatrix(view), rest, 'the camera did not creep after the last drawn frame');

  view.dispose();
});

test('a resting camera holds still whatever frame lengths spun it', () => {
  for (let spinMs = 1; spinMs <= 40; spinMs++) {
    const { view, run } = spinToRest(spinMs);
    const rest = cameraMatrix(view);

    run(1, 200);

    assert.deepEqual(cameraMatrix(view), rest, `the camera crept after a spin on ${spinMs} ms frames`);
    view.dispose();
  }
});

test('a frame that fails to draw stays owed, with its shadow', () => {
  const { view, renderer } = makeView();
  renderer.failNext = true;
  view.invalidate('content');

  assert.throws(() => pump(), /render failed/);
  assert.deepEqual(delta(view, null, 1), { frames: 1, renders: 1, shadowUpdates: 1 }, 'retried on the next frame as content');

  view.dispose();
});

test('a change of screen pixel ratio is picked up by resize', () => {
  const { view, renderer } = makeView();
  globalThis.window.devicePixelRatio = 2;

  try {
    view.resize();
    assert.equal(renderer.pixelRatio, 2);
  } finally {
    globalThis.window.devicePixelRatio = 1;
  }

  view.resize();
  assert.equal(renderer.pixelRatio, 1);

  view.dispose();
});
