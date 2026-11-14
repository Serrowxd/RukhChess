// The 2D/3D view: three/scene.js (view mode, seat rotation, lighting) and three/board.js (the 2D look).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// DOM shim: must be in place before three is imported.

function makeCtx2d() {
  const calls = { fillText: 0, strokeText: 0, clearRect: 0, fillRect: 0 };
  return {
    calls,
    font: '', textAlign: '', textBaseline: '',
    lineJoin: '', lineWidth: 0, strokeStyle: '', fillStyle: '',

    clearRect() { calls.clearRect++; },
    fillRect() { calls.fillRect++; },
    save() {}, restore() {}, translate() {}, rotate() {},
    fillText() { calls.fillText++; },
    strokeText() { calls.strokeText++; },
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

let rafCb = null;

globalThis.requestAnimationFrame = fn => {
  rafCb = fn;
  return 1;
};
globalThis.cancelAnimationFrame = () => { rafCb = null; };

/** Run one render-loop frame (the loop re-registers itself, so this can be called repeatedly). */
function pump() {
  const cb = rafCb;
  rafCb = null;
  if (cb) cb();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Drive the render loop until a camera tween's promise settles, then return its value. */
async function finish(promise, timeoutMs = 4000) {
  let done = false, value;
  promise.then(v => {
    done = true;
    value = v;
  });

  const t0 = Date.now();
  while (!done && Date.now() - t0 < timeoutMs) {
    await sleep(4);
    pump();
  }

  if (!done) throw new Error('camera tween never settled');
  return value;
}

const THREE = await import('three');
const { createView, LIGHTING_PRESETS, DEFAULT_LIGHTING, resolveLighting, lightingValues, seatTheta, fitDistance, keyMirrorPoint, TABLE_TOP, ENVIRONMENTS, turnedUVs, tableUnder, blurEquirect, kneeEquirect } =
  await import('../src/three/scene.js');
const { emitsLight } = await import('../src/three/glow.js');
const { createBoard, SQUARES, squareToWorld } = await import('../src/three/board.js');

// World fakes.

function makeRenderer() {
  const canvas = makeElement('canvas');
  return {
    domElement: canvas,
    toneMapping: null, toneMappingExposure: 1, outputColorSpace: null,
    shadowMap: { enabled: false, type: null },
    sizes: [], pixelRatio: 1, renders: 0,
    setPixelRatio(v) { this.pixelRatio = v; },
    setClearColor() {},
    setSize(w, h) { this.sizes.push([w, h]); },
    render() { this.renders++; },
    dispose() {},
  };
}

function makeMatSet() {
  const mk = () => new THREE.MeshBasicMaterial({ color: 0x808080 });
  return {
    lightSquare: mk(), darkSquare: mk(), frame: mk(), whitePiece: mk(), blackPiece: mk(),
    theme: 'wood', palette: null,
    unlit: false, unlitCalls: [],
    setUnlit(on) { this.unlit = !!on; this.unlitCalls.push(!!on); },
    setPalette() {}, dispose() {},
  };
}

function makeView(settings = {}) {
  const container = makeElement('div');
  const renderer = makeRenderer();
  const view = createView(container, { animations: true, ...settings }, { renderer, labelRenderer: null, environment: false });
  return { view, container, renderer };
}

function sphericalOf(view) {
  const off = view.camera.position.clone().sub(view.controls.target);
  return new THREE.Spherical().setFromVector3(off);
}

/** Camera azimuth about the BOARD centre — what "seat" means. */
const boardTheta = view => Math.atan2(view.camera.position.x, view.camera.position.z);
const wrap = d => {
  d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return d;
};

// Pure lighting model.

test('lighting presets resolve to the intensities they advertise', () => {
  for (const name of ['studio', 'soft', 'bright']) {
    const r = resolveLighting({ preset: name }, DEFAULT_LIGHTING);
    const v = lightingValues(r);
    const def = LIGHTING_PRESETS[name];

    assert.equal(r.preset, name);
    assert.equal(r.key, 1, 'a preset switch resets the key multiplier');
    assert.equal(r.ambient, 1, 'a preset switch resets the ambient multiplier');
    assert.equal(r.exposure, def.exposure, 'a preset switch adopts the preset exposure');
    assert.equal(v.unlit, false);
    assert.equal(v.key, def.key);
    assert.equal(v.hemi, def.hemi);
    assert.equal(v.fill, def.fill);
    assert.equal(v.env, def.env);
    assert.equal(v.toneMapping, 'aces');
    assert.equal(v.washGuard, 1, name + ' at its defaults is below the wash ceiling');
    assert.equal(v.exposure, def.exposure);
  }

  // Relative brightness: soft is the gentlest key, bright the most exposed.
  assert.ok(LIGHTING_PRESETS.soft.key < LIGHTING_PRESETS.studio.key);
  assert.ok(LIGHTING_PRESETS.soft.hemi > LIGHTING_PRESETS.studio.hemi);
  assert.ok(LIGHTING_PRESETS.bright.exposure > LIGHTING_PRESETS.studio.exposure);
  assert.ok(LIGHTING_PRESETS.bright.hemi > LIGHTING_PRESETS.studio.hemi);
});

test('flat preset and on:false are the same unlit mode, not a dark one', () => {
  for (const r of [resolveLighting({ preset: 'flat' }), resolveLighting({ on: false })]) {
    const v = lightingValues(r);
    assert.equal(v.unlit, true);
    assert.equal(v.key, 0);
    assert.equal(v.hemi, 0);
    assert.equal(v.fill, 0);
    assert.equal(v.env, 0, 'the environment must be neutralised or metal and glass go black');
    assert.equal(v.shadows, false);
    assert.equal(v.toneMapping, 'none', 'unlit colours must not be run through ACES');
    assert.equal(v.exposure, 1);
  }
});

test('key / ambient are multipliers and every knob is clamped', () => {
  const v = lightingValues(resolveLighting({ preset: 'studio', key: 0.5, ambient: 1.5 }));
  assert.equal(v.key, LIGHTING_PRESETS.studio.key * 0.5);
  assert.equal(v.hemi, LIGHTING_PRESETS.studio.hemi * 1.5);
  assert.equal(v.fill, LIGHTING_PRESETS.studio.fill * 1.5);
  assert.equal(v.env, LIGHTING_PRESETS.studio.env * 1.5);

  const clamped = resolveLighting({ exposure: 99, key: -4, ambient: 7 });
  assert.equal(clamped.exposure, 1.8);
  assert.equal(clamped.key, 0);
  assert.equal(clamped.ambient, 2);

  // A patch that does not name the preset keeps the current multipliers.
  const kept = resolveLighting({ exposure: 1.2 }, { preset: 'soft', on: true, exposure: 1.05, key: 0.4, ambient: 1.9, shadows: false });
  assert.equal(kept.preset, 'soft');
  assert.equal(kept.key, 0.4);
  assert.equal(kept.ambient, 1.9);
  assert.equal(kept.shadows, false);
  assert.equal(kept.exposure, 1.2);
});

test('every lit key is mirrored past the table rim from both seats (no lamp glare on the table)', () => {
  // The seat presets as authored, and shoot.mjs's low three-quarter views from each side.
  const cameras = { white: [0, 7.5, 9], black: [0, 7.5, -9], low: [1.2, 3.1, 8.6], 'low-black': [-1.2, 3.1, -8.6] };

  for (const name of ['studio', 'soft', 'bright']) {
    for (const [seat, cam] of Object.entries(cameras)) {
      const p = keyMirrorPoint(LIGHTING_PRESETS[name].keyPos, cam);
      const r = Math.hypot(p.x, p.z);
      assert.ok(r > TABLE_TOP.radius + 0.75, `${name} key seen from ${seat}: mirror at r=${r.toFixed(2)} (rim ${TABLE_TOP.radius})`);
    }
  }

  // The helper agrees that a front-right key at [5.5, 8, 4.5] glares on the table from Black.
  const old = keyMirrorPoint([5.5, 8.0, 4.5], cameras['low-black']);
  assert.ok(Math.hypot(old.x, old.z) < TABLE_TOP.radius);
  assert.equal(keyMirrorPoint([5, 8, 0], [0, TABLE_TOP.y - 1, 5]), null, 'a camera under the plane sees no mirror');
});

test('the wash guard only bites when the board would blow out', () => {
  const sane = lightingValues(resolveLighting({ preset: 'bright' }));
  assert.equal(sane.washGuard, 1);

  const cranked = lightingValues(resolveLighting({ preset: 'bright', exposure: 1.8, key: 2, ambient: 2 }));
  assert.ok(cranked.washGuard < 1, 'everything at maximum is pulled back');
  assert.ok(cranked.exposure < 1.8 && cranked.exposure > 0.4);
  assert.ok(cranked.key > sane.key, 'the lights themselves still got brighter');
});

test('fitDistance frames the board on the tighter screen axis', () => {
  const square = fitDistance(4.95, 12, 1);
  const wide = fitDistance(4.95, 12, 2);
  const narrow = fitDistance(4.95, 12, 0.5);
  assert.equal(wide, square, 'a wide pane is limited by its height, same as a square one');
  assert.ok(narrow > square, 'a narrow pane must pull back further');

  assert.equal(seatTheta('white'), 0);
  assert.equal(seatTheta('black'), Math.PI);
  assert.equal(seatTheta('nonsense'), 0);
});

// scene.js: view mode.

test('2D locks the camera straight overhead with orbit off, pan and zoom on', async () => {
  const { view } = makeView();
  assert.equal(view.viewMode, '3d');
  await finish(view.setViewMode('2d', { duration: 1 }));
  assert.equal(view.viewMode, '2d');
  assert.equal(view.transitioning, false);

  const sph = sphericalOf(view);
  assert.ok(sph.phi <= 0.004, 'polar angle is straight down (a hair of tilt only, to define the roll): ' + sph.phi);
  const dir = view.controls.target.clone().sub(view.camera.position).normalize();
  assert.ok(Math.abs(dir.y + 1) < 1e-4, 'the view direction points straight down: ' + dir.y);
  assert.ok(Math.abs(view.camera.position.x) < 0.01 && Math.abs(view.camera.position.z) < 0.25);
  assert.ok(view.camera.position.y > 20, 'and it is pulled back far enough to read as orthographic');

  assert.equal(view.controls.enableRotate, false, 'orbit is disabled');
  assert.equal(view.controls.minPolarAngle, view.controls.maxPolarAngle, 'the polar angle is pinned');
  assert.ok(view.controls.maxPolarAngle <= 0.004);
  assert.equal(view.controls.enablePan, true, 'pan stays on');
  assert.equal(view.controls.enableZoom, true, 'zoom stays on');
  assert.ok(view.controls.minDistance < sph.radius && view.controls.maxDistance > sph.radius);
  assert.equal(view.camera.isPerspectiveCamera, true, 'view.camera keeps its documented type');
  assert.ok(view.camera.fov < 20, 'a narrow field of view is what makes it near-orthographic');
  assert.ok(view.camera.near > 1, 'the near plane is pulled in so the overlay stack does not z-fight');

  // A frame must not drag it out of the lock.
  pump();
  pump();
  assert.ok(sphericalOf(view).phi <= 0.004);

  view.dispose();
});

test('a Flip made in 2D brings 3D back at the new seat, both ways (critique r2 repro)', async () => {
  const { view } = makeView();
  await finish(view.setPreset('white'));
  const before = view.camera.position.clone();

  await finish(view.setViewMode('2d'));
  await finish(view.rotateSeat('black'));       // Flip while 2D
  await finish(view.setViewMode('3d'));

  assert.equal(view.orientation, 'black', 'the camera sits at the seat of the current orientation');
  assert.ok(view.camera.position.z < -5, `camera z ${view.camera.position.z.toFixed(2)} is on Black's side`);
  assert.ok(Math.abs(view.camera.position.y - before.y) < 1e-6, 'the same height and framing, from the other side');
  assert.ok(Math.abs(view.camera.position.z + before.z) < 1e-6 && Math.abs(view.camera.position.x + before.x) < 1e-6);
  assert.equal(view.preset, 'black');

  // The reverse sequence: from Black's seat, 2D, Flip back to White, 3D.
  await finish(view.setViewMode('2d'));
  await finish(view.rotateSeat('white'));
  await finish(view.setViewMode('3d'));
  assert.equal(view.orientation, 'white');
  assert.ok(view.camera.position.z > 5, `camera z ${view.camera.position.z.toFixed(2)} is on White's side`);

  // No Flip in between: the pose comes back exactly.
  await finish(view.setViewMode('2d'));
  await finish(view.setViewMode('3d'));
  assert.ok(view.camera.position.distanceTo(before) < 1e-6);

  view.dispose();
});

test('2D frames the whole board inside the stage the toolbar and status chip leave free, from both seats', async () => {
  const { view } = makeView();                        // an 800 x 800 stage
  view.setSafeArea({ top: 90, bottom: 50 });
  await finish(view.setViewMode('2d'));

  const corners = () => [[-4.6, -4.6], [4.6, -4.6], [4.6, 4.6], [-4.6, 4.6]].map(([x, z]) => view.worldToClient({ x, y: 0, z }));
  for (const seat of ['white', 'black']) {
    await finish(view.rotateSeat(seat));

    const c = corners(), ys = c.map(p => p.y), xs = c.map(p => p.x);
    assert.ok(Math.min(...ys) >= 90 - 0.5, `${seat}: the frame's top edge clears the toolbar (${Math.min(...ys).toFixed(1)})`);
    assert.ok(Math.max(...ys) <= 800 - 50 + 0.5, `${seat}: and its bottom edge the chip (${Math.max(...ys).toFixed(1)})`);
    assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - (90 + 750) / 2) < 1, `${seat}: centred in the free band`);
    assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 400) < 1, `${seat}: and across`);
  }

  // Squares still map exactly: the aim moved, the mapping did not.
  const e4 = view.worldToClient({ x: 0.5, y: 0, z: -0.5 });
  const hit = view.pointerToPlane(e4.x, e4.y, 0);
  assert.ok(Math.abs(hit.x - 0.5) < 1e-3 && Math.abs(hit.z + 0.5) < 1e-3);

  // The insets going away re-frames to the whole stage.
  view.setSafeArea({});
  const ys = corners().map(p => p.y);
  assert.ok(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2 - 400) < 1);

  view.dispose();
});

test('going 2D and back restores the 3D pose', async () => {
  const { view } = makeView();
  view.camera.position.set(2, 6, 7.5);
  view.controls.target.set(0.5, 0, -0.5);
  view.camera.fov = 44;
  view.camera.updateProjectionMatrix();
  view.controls.update();

  const snap = {
    pos: view.camera.position.clone(), target: view.controls.target.clone(),
    fov: view.camera.fov, near: view.camera.near, far: view.camera.far,
    minDistance: view.controls.minDistance, maxDistance: view.controls.maxDistance,
    minPolar: view.controls.minPolarAngle, maxPolar: view.controls.maxPolarAngle,
  };

  await finish(view.setViewMode('2d', { duration: 1 }));
  assert.notEqual(view.camera.fov, snap.fov);
  await finish(view.setViewMode('3d', { duration: 1 }));

  assert.equal(view.viewMode, '3d');
  // Copied back exactly; OrbitControls' spherical round trip on the next frame drifts ~1e-16.
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(view.camera.position[axis] - snap.pos[axis]) < 1e-9, 'camera.' + axis);
    assert.ok(Math.abs(view.controls.target[axis] - snap.target[axis]) < 1e-9, 'target.' + axis);
  }
  assert.equal(view.camera.fov, snap.fov);
  assert.equal(view.camera.near, snap.near);
  assert.equal(view.camera.far, snap.far);
  assert.equal(view.controls.minDistance, snap.minDistance);
  assert.equal(view.controls.maxDistance, snap.maxDistance);
  assert.equal(view.controls.minPolarAngle, snap.minPolar);
  assert.equal(view.controls.maxPolarAngle, snap.maxPolar);
  assert.equal(view.controls.enableRotate, true, 'orbit comes back');

  view.dispose();
});

test('setViewMode is idempotent, honours animate:false, and fires its hook', async () => {
  const { view } = makeView();
  const seen = [];
  const off = view.onViewModeChange((m, prev) => seen.push([m, prev]));

  assert.equal(await view.setViewMode('3d'), true, 'already there');
  assert.deepEqual(seen, []);

  assert.equal(await view.setViewMode('2d', { animate: false }), true);
  assert.equal(view.viewMode, '2d');
  assert.equal(view.transitioning, false, 'animate:false finishes synchronously');
  assert.deepEqual(seen, [['2d', '3d']]);

  off();
  await view.setViewMode('3d', { animate: false });
  assert.deepEqual(seen, [['2d', '3d']], 'unsubscribed');

  view.dispose();
});

test('settings.viewMode === "2d" boots straight into 2D', () => {
  const { view } = makeView({ viewMode: '2d' });
  assert.equal(view.viewMode, '2d');
  assert.equal(view.controls.enableRotate, false);
  assert.ok(sphericalOf(view).phi <= 0.004);

  view.dispose();
});

// scene.js: pointer round trip.

/** Project a world point to client coords, cast it back, and name the square it landed on. */
function squareUnder(view, board, world) {
  const c = view.worldToClient(world);
  assert.ok(c, 'worldToClient');
  const p = view.pointerToPlane(c.x, c.y, 0);
  assert.ok(p, 'pointerToPlane');
  return board.squareAtPoint(p);
}

for (const mode of ['3d', '2d']) {
  for (const seat of ['white', 'black']) {
    test(`all 64 squares round-trip through pointerToPlane in ${mode} from the ${seat} seat`, async () => {
      const { view } = makeView();
      const board = createBoard(view.scene, makeMatSet(), {});
      await finish(view.setViewMode(mode, { duration: 1 }));
      board.setViewMode(mode);
      await finish(view.rotateSeat(seat, { duration: 1 }));
      view.scene.updateMatrixWorld(true);

      for (const sq of SQUARES) {
        const w = squareToWorld(sq);
        assert.equal(squareUnder(view, board, new THREE.Vector3(w.x, 0, w.z)), sq, sq + ' centre');
        // Not just the centre: the corners of the square must resolve to it too.
        assert.equal(squareUnder(view, board, new THREE.Vector3(w.x - 0.45, 0, w.z - 0.45)), sq, sq + ' -/-');
        assert.equal(squareUnder(view, board, new THREE.Vector3(w.x + 0.45, 0, w.z + 0.45)), sq, sq + ' +/+');
      }

      board.dispose();
      view.dispose();
    });
  }
}

test('view.raycast still picks the right square mesh in 2D', async () => {
  const { view } = makeView();
  const board = createBoard(view.scene, makeMatSet(), {});
  await finish(view.setViewMode('2d', { duration: 1 }));
  view.scene.updateMatrixWorld(true);
  const targets = [...board.squareMeshes.values()];

  for (const sq of ['a1', 'e4', 'd5', 'h8', 'a8', 'h1', 'c6']) {
    const w = squareToWorld(sq);
    const c = view.worldToClient(new THREE.Vector3(w.x, 0, w.z));
    const hits = view.raycast(c.x, c.y, targets, true);
    assert.ok(hits.length, 'a ray fired at ' + sq + ' must hit something');
    assert.equal(hits[0].object.userData.square, sq);
  }

  board.dispose();
  view.dispose();
});

// scene.js: seat rotation.

for (const mode of ['3d', '2d']) {
  test(`rotateSeat turns the board about its centre in ${mode}`, async () => {
    const { view } = makeView();
    await finish(view.setViewMode(mode, { duration: 1 }));
    const before = sphericalOf(view);

    assert.equal(await finish(view.rotateSeat('black', { duration: 1 })), true);
    assert.ok(Math.abs(wrap(boardTheta(view) - Math.PI)) < 1e-6, 'ends on the black seat');
    assert.equal(view.orientation, 'black');
    const after = sphericalOf(view);
    assert.ok(Math.abs(after.phi - before.phi) < 1e-9, 'a rotation, not a swoop: elevation is unchanged');
    assert.ok(Math.abs(after.radius - before.radius) < 1e-9, 'and so is the distance');

    assert.equal(await finish(view.rotateSeat('white', { duration: 1 })), true);
    assert.ok(Math.abs(wrap(boardTheta(view))) < 1e-6, 'and back');
    assert.equal(view.orientation, 'white');

    // Already seated there: resolves immediately, no tween.
    assert.equal(await view.rotateSeat('white'), true);

    view.dispose();
  });
}

test('rotateSeat rotates the pan target too, so the board turns rather than the camera swinging', async () => {
  const { view } = makeView();
  view.controls.target.set(1.5, 0, 0);
  view.camera.position.set(1.5, 7, 9);
  view.controls.update();
  const r0 = view.camera.position.distanceTo(view.controls.target);
  const targetRadius = Math.hypot(view.controls.target.x, view.controls.target.z);

  await finish(view.rotateSeat('black', { duration: 1 }));

  // The whole view turns rigidly about the board centre, the pan target with it.
  assert.ok(Math.abs(wrap(boardTheta(view) - Math.PI)) < 1e-6);
  assert.ok(view.controls.target.x < 0, 'the target swung to the far side: ' + view.controls.target.x);
  assert.ok(Math.abs(Math.hypot(view.controls.target.x, view.controls.target.z) - targetRadius) < 1e-9);
  assert.ok(Math.abs(view.camera.position.distanceTo(view.controls.target) - r0) < 1e-9);

  view.dispose();
});

test('rotateSeat is cancellable mid-flight', async () => {
  const { view } = makeView();
  const slow = view.rotateSeat('black', { duration: 5000 });
  pump();
  const mid = boardTheta(view);
  assert.ok(Math.abs(wrap(mid - Math.PI)) > 0.5, 'still on the way: ' + mid);

  const fast = view.rotateSeat('white', { duration: 1 });
  assert.equal(await slow, false, 'the superseded rotation resolves false, it does not reject');
  assert.equal(await finish(fast), true);
  assert.ok(Math.abs(wrap(boardTheta(view))) < 1e-6);

  // A mode switch also takes the camera over.
  const slow2 = view.rotateSeat('black', { duration: 5000 });
  pump();
  const modeSwitch = view.setViewMode('2d', { duration: 1 });
  assert.equal(await slow2, false);
  assert.equal(await finish(modeSwitch), true);
  assert.equal(view.viewMode, '2d');

  view.dispose();
});

test('flipTo delegates to rotateSeat and still returns a promise', async () => {
  const { view } = makeView();

  const p = view.flipTo('black');
  assert.ok(p && typeof p.then === 'function');
  await finish(p);

  assert.equal(view.orientation, 'black');
  view.dispose();
});

// scene.js: lighting, live.

test('setLighting drives the real lights, renderer and material set', () => {
  const { view, renderer } = makeView();
  const mats = makeMatSet();
  view.setMaterialSet(mats);
  assert.deepEqual(mats.unlitCalls, [false], 'handing over the material set syncs it immediately');

  view.setLighting({ preset: 'bright' });
  const b = LIGHTING_PRESETS.bright;
  const P = ENVIRONMENTS.plain;   // makeView runs without assets: the 'plain' room, whose multipliers apply
  assert.equal(view.lights.key.intensity, b.key);
  assert.equal(view.lights.hemi.intensity, b.hemi * P.light);
  assert.equal(view.lights.fill.intensity, b.fill * P.light);
  assert.equal(view.scene.environmentIntensity, b.env * P.env);
  assert.equal(renderer.toneMappingExposure, b.exposure * P.exposure);
  assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
  assert.equal(view.lighting.preset, 'bright');
  assert.equal(view.lighting.unlit, false);

  view.setLighting({ key: 0.5, ambient: 1.5 });
  assert.equal(view.lights.key.intensity, b.key * 0.5);
  assert.equal(view.lights.hemi.intensity, b.hemi * 1.5 * P.light);
  assert.equal(view.lights.fill.intensity, b.fill * 1.5 * P.light);
  assert.equal(view.scene.environmentIntensity, b.env * 1.5 * P.env);
  assert.equal(view.lights.seat.intensity, b.seat * 1.5 * P.seat, 'the seat fill is an ambient term');

  view.setLighting({ exposure: 0.7 });
  assert.equal(renderer.toneMappingExposure, 0.7 * P.exposure);
  assert.equal(view.lighting.exposure, 0.7);

  view.dispose();
});

test('the seat fill comes from behind the camera, a close-up inside the board included (critique r3)', () => {
  const { view } = makeView();
  const place = (pos, tgt) => {
    view.controls.target.set(...tgt);
    view.camera.position.set(...pos);
    view.camera.lookAt(view.controls.target);
    view.render();
  };

  // The seats, shoot.mjs's low views, and a close look at Black's e8 king from a camera on Black's half.
  const shots = {
    white: [[0, 7.5, 9], [0, 0, 0]], black: [[0, 7.5, -9], [0, 0, 0]],
    low: [[1.2, 3.1, 8.6], [0, 0.35, 0]], 'low-black': [[-1.2, 3.1, -8.6], [0, 0.35, 0]],
    'close-black-king': [[1.6, 1.25, -1.55], [0.5, 0.5, -3.5]],
  };

  for (const [name, [pos, tgt]] of Object.entries(shots)) {
    place(pos, tgt);

    const seat = view.lights.seat;
    const from = seat.position.clone().sub(seat.target.position).normalize();
    const back = view.camera.position.clone().sub(view.controls.target).setY(0).normalize();
    const along = new THREE.Vector3(from.x, 0, from.z).normalize().dot(back);
    assert.ok(along > 0.999, `${name}: the fill comes from the camera's side (${along.toFixed(3)})`);
    assert.ok(Math.abs(Math.asin(from.y) - 15 * Math.PI / 180) < 1e-6, `${name}: 15 degrees up`);
  }

  view.dispose();
});

test('the room behind the board is dithered: the background shader of three is patched, once', () => {
  const a = makeView(), b = makeView();

  const f = THREE.ShaderLib.backgroundCube.fragmentShader;

  assert.equal(f.split('cbDither(').length - 1, 2, 'one noise function, one use (a second view does not patch again)');
  assert.ok(f.indexOf('#include <colorspace_fragment>') < f.indexOf('+= ( cbDither'), 'after the colour-space step: on the 8-bit values');

  a.view.dispose();
  b.view.dispose();
});

test('the pedestal grain runs along the profile by arc length and wraps whole tiles around', () => {
  // Points bunched at the top, as the pedestal's collar and flare are.
  const profile = [[0.6, 0], [0.6, 2], [0.62, 2.05], [0.66, 2.1], [0.7, 2.12], [1.2, 2.2]].map(([x, y]) => new THREE.Vector2(x, y));
  const segments = 8, unit = 14.68, tiles = 1, repeat = 1.6;

  const geo = turnedUVs(new THREE.LatheGeometry(profile, segments), profile, segments, unit, tiles, repeat);

  const uv = geo.attributes.uv;
  let s = 0;
  for (let j = 0; j < profile.length; j++) {
    if (j) s += profile[j].distanceTo(profile[j - 1]);
    for (const i of [0, 3, segments]) assert.ok(Math.abs(uv.getX(i * profile.length + j) - s / unit) < 1e-6, `u = arc length (${j})`);
  }

  assert.ok(Math.abs(uv.getY(segments * profile.length) * repeat - tiles) < 1e-6, 'a whole tile around: no seam');
  geo.dispose();
});

/** An equirect DataTexture (half floats, row 0 = the zenith) filled by fn(elevationDeg, lonDeg) -> [r, g, b]. */
function panorama(w, h, fn) {
  const data = new Uint16Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    const el = (0.5 - (y + 0.5) / h) * 180;

    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(el, (x + 0.5) / w * 360);
      const i = (y * w + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(r);
      data[i + 1] = THREE.DataUtils.toHalfFloat(g);
      data[i + 2] = THREE.DataUtils.toHalfFloat(b);
      data[i + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }

  return new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
}

const px = (tex, x, y) => {
  const i = (y * tex.image.width + x) * 4, f = THREE.DataUtils.fromHalfFloat;
  return [f(tex.image.data[i]), f(tex.image.data[i + 1]), f(tex.image.data[i + 2])];
};

test('the pieces reflect the table and the board below the horizon, not the room\u2019s floor (critique r4)', () => {
  // A room with a saturated rug below the horizon and a warm wall above.
  const eq = panorama(128, 64, (el) => (el < 0 ? [2, 0, 1.5] : [0.3, 0.2, 0.1]));

  const out = tableUnder(eq, 0.15);

  const rowAt = (el) => Math.floor((0.5 - el / 180) * 64);
  assert.deepEqual(px(out, 5, rowAt(40)).map((v) => +v.toFixed(3)), [0.3, 0.2, 0.1], 'above the horizon: the room, untouched');
  const table = px(out, 5, rowAt(-5)), board = px(out, 5, rowAt(-60));
  for (const [c, name] of [[table, 'just below: the table'], [board, 'steeply down: the board']]) {
    assert.ok(Math.max(...c) - Math.min(...c) < Math.max(...c) * 0.9, `${name}, not the rug's colour`);
    assert.ok(c[0] >= c[1] && c[1] >= c[2], `${name}: warm, not magenta`);
  }

  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(lum(table) < 0.03, 'the walnut table is dark');
  assert.ok(Math.abs(lum(board) - 0.15) < 0.02, 'the board is the given luminance');
  assert.equal(eq.image.data[(rowAt(-60) * 128 + 5) * 4], THREE.DataUtils.toHalfFloat(2), 'the source is left alone (the background keeps it)');
});

test('the reflection blur is a smooth Gaussian on the sphere: no spiral sampling, energy kept', () => {
  // One small, very bright light in a dark room: the case PMREM's twenty-sample spiral blurs into speckle.
  const eq = panorama(128, 64, (el, lon) => (Math.abs(el - 20) < 3 && Math.abs(lon - 90) < 3 ? [400, 400, 400] : [0.02, 0.02, 0.02]));

  const out = blurEquirect(eq, 0.8);
  assert.deepEqual([out.image.width, out.image.height], [64, 32]);

  // Monotonic falloff away from the light along its row: a smooth lobe, not a pattern.
  const row = Math.round((0.5 - 20 / 180) * 32 - 0.5), peak = Math.round(90 / 360 * 64 - 0.5);
  let prev = Infinity;
  for (let d = 0; d <= 12; d++) {
    const v = px(out, (peak + d) % 64, row)[1];
    assert.ok(v <= prev + 1e-3, `falls off smoothly (${d})`);
    prev = v;
  }

  // The total (solid-angle weighted) light is kept.
  const total = (tex, w, h, read) => {
    let sum = 0;
    for (let y = 0; y < h; y++) {
      const c = Math.cos((0.5 - (y + 0.5) / h) * Math.PI);
      for (let x = 0; x < w; x++) sum += read(x, y) * c;
    }
    return sum * (4 * Math.PI * Math.PI / (w * h)) / 2;   // the equirect's solid angle per texel is (2pi/w)(pi/h)cos
  };
  const before = total(eq, 128, 64, (x, y) => px(eq, x, y)[1]), after = total(out, 64, 32, (x, y) => px(out, x, y)[1]);
  assert.ok(Math.abs(after / before - 1) < 0.05, `energy kept (${(after / before).toFixed(3)})`);
});

test('the Studio background rolls its highlights off; the rest of the panorama is untouched', () => {
  const eq = panorama(8, 4, (el, lon) => (lon < 45 ? [534, 400, 300] : [0.4, 0.5, 0.6]));

  const out = kneeEquirect(eq, 80);

  assert.deepEqual(px(out, 3, 1).map((v) => +v.toFixed(2)), [0.4, 0.5, 0.6], 'below the knee: as it was');
  const hot = px(out, 0, 1);
  assert.ok(Math.max(...hot) < 160 && Math.max(...hot) > 80, `the softbox rolled off below twice the knee (${hot[0].toFixed(0)})`);
  assert.ok(Math.abs(hot[1] / hot[0] - 400 / 534) < 0.01, 'its colour kept');
});

test('the glow only takes what gives off light', () => {
  assert.equal(emitsLight(new THREE.MeshStandardMaterial({ emissive: 0xffd9a0, emissiveIntensity: 2.2 })), true, 'a lit window');
  assert.equal(emitsLight(new THREE.MeshStandardMaterial({ color: 0xffffff })), false, 'porcelain under a lamp: not emissive');
  assert.equal(emitsLight(new THREE.MeshStandardMaterial({ emissive: 0xffffff, emissiveIntensity: 0 })), false);
  assert.equal(emitsLight(new THREE.MeshBasicMaterial({ color: 0xffffff })), false, 'overlays and the mask pass');

  const unlit = new THREE.MeshStandardMaterial({ emissive: 0x336699 });
  unlit.userData.litBackup = {};
  assert.equal(emitsLight(unlit), false, 'the unlit look parks its colour in emissive: not a light');
});

test('the edge light: on in lit 3D with the room tint, off in 2D and unlit, fed the board centre depth', async () => {
  const { view } = makeView();
  const lit = () => {
    const c = view.edgeLight.color;
    return c.r + c.g + c.b;
  };

  view.setLighting({ preset: 'studio' });
  view.render();
  assert.ok(lit() > 0, 'on in lit 3D');

  const c = view.edgeLight.color, tint = ENVIRONMENTS.plain.tint;
  assert.ok(Math.abs(c.g / c.r - tint[1] / tint[0]) < 1e-6 && Math.abs(c.b / c.r - tint[2] / tint[0]) < 1e-6, 'the room tint');

  const centre = new THREE.Vector3(0, 0, 0).applyMatrix4(view.camera.matrixWorldInverse);
  assert.ok(Math.abs(view.edgeLight.focus + centre.z) < 1e-6, 'the board centre, in view depth');

  view.setLighting({ on: false });
  assert.equal(lit(), 0, 'off when unlit');

  view.setLighting({ on: true });
  assert.ok(lit() > 0);

  await finish(view.setViewMode('2d', { duration: 1 }));
  assert.equal(lit(), 0, 'off in 2D');

  await finish(view.setViewMode('3d', { duration: 1 }));
  assert.ok(lit() > 0, 'and back on in 3D');

  view.dispose();
});

test('lighting off routes to the unlit materials instead of going dark', () => {
  const { view, renderer } = makeView();
  const mats = makeMatSet();
  view.setMaterialSet(mats);

  view.setLighting({ on: false });
  assert.equal(view.lighting.unlit, true);
  assert.equal(mats.unlit, true, 'materials.js is asked for its unlit variant');
  assert.deepEqual(mats.unlitCalls, [false, true]);
  assert.equal(view.lights.key.intensity, 0);
  assert.equal(view.lights.hemi.intensity, 0);
  assert.equal(view.lights.fill.intensity, 0);
  assert.equal(view.scene.environment, null, 'environment neutralised so metal and glass do not go black');
  assert.equal(view.scene.environmentIntensity, 0);
  assert.equal(renderer.toneMapping, THREE.NoToneMapping);
  assert.equal(renderer.toneMappingExposure, 1);
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(view.lights.key.castShadow, false);

  view.setLighting({ on: true });
  assert.equal(view.lighting.unlit, false);
  assert.equal(mats.unlit, false);
  assert.equal(renderer.toneMapping, THREE.ACESFilmicToneMapping);
  assert.ok(view.lights.key.intensity > 0);

  // The 'flat' preset is the same thing by another name.
  view.setLighting({ preset: 'flat' });
  assert.equal(view.lighting.unlit, true);
  assert.equal(mats.unlit, true);
  assert.equal(view.lights.key.intensity, 0);
  assert.equal(view.scene.environmentIntensity, 0);

  // A material set handed over while unlit arrives unlit.
  const later = makeMatSet();
  view.setMaterialSet(later);
  assert.equal(later.unlit, true);

  view.dispose();
});

test('shadows are one setting, whether they are set through setLighting or setQuality', () => {
  const { view, renderer } = makeView();
  assert.equal(view.lighting.shadows, true);

  view.setLighting({ shadows: false });
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(view.lights.key.castShadow, false);

  view.setQuality({ shadows: true });
  assert.equal(view.lighting.shadows, true);
  assert.equal(renderer.shadowMap.enabled, true);
  assert.equal(view.lights.key.castShadow, true);

  view.dispose();
});

test('onLighting fires with the resolved values', () => {
  const { view } = makeView();
  const seen = [];
  const off = view.onLighting(l => seen.push(l));

  view.setLighting({ preset: 'soft' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].preset, 'soft');
  assert.equal(seen[0].applied.key, LIGHTING_PRESETS.soft.key);

  off();
  view.setLighting({ preset: 'studio' });
  assert.equal(seen.length, 1);

  view.dispose();
});

test('soft shadows are VSMShadowMap blurred by the preset radius (the PCF per-pixel Vogel disk stippled)', () => {
  const { view, renderer } = makeView();
  assert.equal(renderer.shadowMap.type, THREE.VSMShadowMap);
  assert.ok(view.lights.key.shadow.blurSamples >= 12, 'enough blur taps for a smooth ramp');
  assert.equal(view.lights.key.shadow.radius, LIGHTING_PRESETS.studio.shadowRadius);

  view.setLighting({ preset: 'soft' });
  assert.equal(view.lights.key.shadow.radius, LIGHTING_PRESETS.soft.shadowRadius);
  assert.ok(LIGHTING_PRESETS.soft.shadowRadius > LIGHTING_PRESETS.studio.shadowRadius, 'soft is the softer shadow');
  assert.deepEqual(view.lights.key.position.toArray(), LIGHTING_PRESETS.soft.keyPos);

  view.dispose();
});

test('the 3D camera never drops below the table top', async () => {
  const { view } = makeView();
  pump();

  // A pan that dragged the target under the table, and a camera placed below it by hand.
  view.controls.target.set(0.5, -3, 0);
  view.camera.position.set(4, -2, 6);
  pump();
  assert.ok(view.controls.target.y >= TABLE_TOP.y - 1e-9, `target y ${view.controls.target.y}`);
  assert.ok(view.camera.position.y > TABLE_TOP.y + 0.2, `camera y ${view.camera.position.y}`);

  // A synchronous render() holds it too.
  view.camera.position.set(3, TABLE_TOP.y - 0.5, 7);
  view.controls.target.set(0, 0, 0);
  view.render();
  assert.ok(view.camera.position.y > TABLE_TOP.y + 0.2, `camera y after render() ${view.camera.position.y}`);

  // An ordinary low view is left exactly where it was put.
  view.camera.position.set(1.2, 3.1, 8.6);
  view.controls.target.set(0, 0.35, 0);
  view.render();
  assert.deepEqual(view.camera.position.toArray().map(n => +n.toFixed(6)), [1.2, 3.1, 8.6]);

  await finish(view.setViewMode('2d'));
  const top = view.camera.position.y;
  pump();
  assert.equal(view.camera.position.y, top, '2D is left alone');

  view.dispose();
});

test('settings.lighting is honoured at construction', () => {
  const { view, renderer } = makeView({ lighting: { preset: 'soft', exposure: 1.4, shadows: false } });

  assert.equal(view.lighting.preset, 'soft');
  assert.equal(renderer.toneMappingExposure, 1.4 * ENVIRONMENTS.plain.exposure);
  assert.equal(renderer.shadowMap.enabled, false);
  assert.equal(view.lights.key.intensity, LIGHTING_PRESETS.soft.key);

  view.dispose();
});

// board.js: the 2D look.

function overlayByName(board, name) {
  let found = null;
  board.overlays.traverse(o => { if (!found && o.name === name) found = o; });
  return found;
}

const arrowsIn = board => overlayByName(board, 'arrows').children;

test('board.setViewMode lifts arrows and capture rings over the pieces, and puts them back', () => {
  const scene = new THREE.Scene();
  const board = createBoard(scene, makeMatSet(), {});
  assert.equal(board.viewMode, '3d');

  board.setArrows([{ from: 'g1', to: 'f3', color: 'green' }, { from: 'e2', to: 'e4', color: 'red' }]);
  board.setPreviewArrow({ from: 'd2', to: 'd4', color: 'blue' });
  board.setEngineArrow('b1c3');
  board.setLegalTargets(['e4', 'd5'], ['d5']);
  board.setSelected('e2');
  board.setLastMove('g8', 'f6');
  board.setCheck('e1');
  board.setHighlights([{ square: 'c4', color: 'yellow' }]);

  const a3d = arrowsIn(board);
  assert.equal(a3d.length, 2);
  const y3d = a3d[0].geometry.attributes.position.getY(0);
  const ro3d = a3d[0].renderOrder;   // read now: arrowsIn() is the live children array
  assert.ok(Math.abs(y3d - 0.016) < 1e-6, '3D arrows hug the board: ' + y3d);
  assert.equal(a3d[0].material.depthTest, true);

  board.setViewMode('2d');
  assert.equal(board.viewMode, '2d');
  const a2d = arrowsIn(board);
  assert.equal(a2d.length, 2, 'arrows survive the switch');
  const y2d = a2d[0].geometry.attributes.position.getY(0);
  assert.ok(y2d > 0.4, '2D arrows sit above the tokens: ' + y2d);
  assert.equal(a2d[0].material.depthTest, false, 'and always paint over them');
  assert.ok(a2d[0].renderOrder > ro3d, 'and after everything else');

  const legal = overlayByName(board, 'legal').children;
  assert.equal(legal.length, 2);
  const ring = legal.find(m => m.name.startsWith('capture-'));
  const dot = legal.find(m => m.name.startsWith('target-'));
  assert.ok(ring.position.y > 0.4, 'a capture ring must be visible over the token it marks');
  assert.equal(ring.material.depthTest, false);
  assert.ok(dot.position.y < 0.05, 'a legal dot stays on the square');
  assert.equal(dot.material.depthTest, true);

  // Square tints stay under the pieces in both modes.
  const selected = overlayByName(board, 'selected');
  assert.ok(selected.visible && selected.position.y < 0.05);
  assert.equal(overlayByName(board, 'check').visible, true);
  assert.equal(overlayByName(board, 'highlights').children.length, 1);
  assert.equal(overlayByName(board, 'lastMove-0').visible, true);
  assert.equal(overlayByName(board, 'previewArrow').children.length, 1);
  assert.equal(overlayByName(board, 'engineArrow').children.length, 1);

  board.setViewMode('3d');
  const back = arrowsIn(board);
  assert.ok(Math.abs(back[0].geometry.attributes.position.getY(0) - 0.016) < 1e-6);
  assert.equal(back[0].material.depthTest, true);
  assert.equal(overlayByName(board, 'legal').children.find(m => m.name.startsWith('capture-')).material.depthTest, true);

  board.dispose();
});

test('board 2D flattens the frame and redraws the coordinate glyphs', () => {
  const scene = new THREE.Scene();
  const board = createBoard(scene, makeMatSet(), {});
  assert.equal(board.frame.scale.y, 1);

  const canvas = board.labelGroup.children[0].material.map.image;
  const before = canvas.getContext('2d').calls.fillText;
  assert.ok(before >= 8, 'the file strip was drawn once at construction');

  // The strips sit on the frame's top face in both modes.
  board.frame.geometry.computeBoundingBox();
  const frameTop = () => board.frame.geometry.boundingBox.max.y * board.frame.scale.y;
  const stripY = () => board.labelGroup.position.y + board.labelGroup.children[0].position.y;
  assert.ok(stripY() > frameTop(), '3D strips above the frame top');

  board.setViewMode('2d');
  assert.ok(board.frame.scale.y < 0.5, 'the frame slab loses its bevel shading');
  assert.ok(canvas.getContext('2d').calls.fillText > before, 'glyphs redrawn for the head-on read');
  assert.equal(board.labelGroup.children.length, 4, 'labels on all four edges');
  assert.equal(board.labelGroup.visible, true);
  assert.ok(stripY() > frameTop(), '2D strips above the flattened frame top');

  board.setViewMode('3d');
  assert.equal(board.frame.scale.y, 1);
  assert.ok(stripY() > frameTop(), 'back in 3D, still above');

  board.dispose();
});

test("3D coordinates: gilt metal on the near files and the player's left ranks, following Flip", () => {
  const scene = new THREE.Scene();
  const board = createBoard(scene, makeMatSet(), {});
  const strips = board.labelGroup.children;          // south, north, west, east
  const shown = () => strips.map(m => m.visible);
  assert.deepEqual(shown(), [true, false, true, false], "White: files along White's edge, ranks on the a-file side");

  for (const m of strips) {
    assert.ok(m.material.isMeshStandardMaterial, '3D strips are lit metal');
    assert.equal(m.material.metalness, 1);
    assert.ok(m.material.roughness > 0.15 && m.material.roughness < 0.45);
    assert.ok(m.material.bumpMap && m.material.bumpMap !== m.material.map, 'with a bevel from its own bump map');
    assert.ok(m.material.transparent, 'the canvas cuts the letters out');
  }

  board.setOrientation('black');
  assert.deepEqual(shown(), [false, true, false, true], "Black: files along Black's edge, ranks on the h-file side");

  // 2D keeps all four flat strips; back in 3D the seat's two come back, gilt again.
  board.setViewMode('2d');
  assert.deepEqual(shown(), [true, true, true, true]);
  for (const m of strips) assert.ok(m.material.isMeshBasicMaterial, '2D strips are the flat look');

  board.setViewMode('3d');
  assert.deepEqual(shown(), [false, true, false, true]);
  assert.ok(strips[1].material.isMeshStandardMaterial);

  board.dispose();
});

test('the stringing inlay is 3D only and follows the theme; setUnlit flattens the gilt', () => {
  const scene = new THREE.Scene();
  const mats = makeMatSet();
  const board = createBoard(scene, mats, {});
  assert.equal(board.inlay.visible, true);
  assert.equal(board.inlay.material, mats.lightSquare, "light-wood stringing: the light squares' material");

  const box = new THREE.Box3().setFromObject(board.inlay);
  assert.ok(box.max.x > 4.0 && box.max.x < 4.2, `between the squares (4.0) and the labels: ${box.max.x}`);
  assert.ok(box.max.y < 0 && box.max.y > -0.02, 'just above the frame top, below the squares');

  const next = makeMatSet();
  board.setMaterials(next);
  assert.equal(board.inlay.material, next.lightSquare);

  board.setViewMode('2d');
  assert.equal(board.inlay.visible, false);
  board.setViewMode('3d');

  const gilt = board.labelGroup.children[0].material;
  const gold = gilt.color.getHex();

  board.setUnlit(true);
  assert.equal(gilt.emissive.getHex(), gold, 'lights off: the gold moves into emissive');
  assert.equal(gilt.metalness, 0, 'not black metal without an environment');
  assert.equal(gilt.toneMapped, false);

  board.setUnlit(false);
  assert.equal(gilt.color.getHex(), gold);
  assert.equal(gilt.metalness, 1);

  board.dispose();
});

test('board honours settings.viewMode at construction and squareAtPoint is mode-independent', () => {
  const scene = new THREE.Scene();
  const board = createBoard(scene, makeMatSet(), { viewMode: '2d' });
  assert.equal(board.viewMode, '2d');
  assert.ok(board.frame.scale.y < 0.5);

  for (const sq of SQUARES) {
    assert.equal(board.squareAtPoint(board.worldFor(sq)), sq);
  }

  board.setViewMode('3d');
  for (const sq of SQUARES) {
    assert.equal(board.squareAtPoint(board.worldFor(sq)), sq);
  }

  board.dispose();
});
