// three/scene.js draws shadows and the edge mask from the stand-ins, the picture from the full meshes.

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
  getElementById: () => null,
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

/** One animation frame: every callback queued so far runs once. */
function pump(n = 1) {
  for (let i = 0; i < n; i++) {
    const now = queue;
    queue = [];
    for (const e of now) e.fn(typeof performance !== 'undefined' ? performance.now() : Date.now());
  }
}

const THREE = await import('three');
const { createView } = await import('../src/three/scene.js');
const { ROLES, createPiece, registerGltfSet, unregisterSet, standInOf } = await import('../src/three/pieces.js');

// A small modelled set.

/** A GLB with one thin-column mesh of `tris` triangles per node name. */
function glb(names, { tris, materials }) {
  const pos = [], idx = [];
  for (let t = 0; t < tris; t++) {
    const y = t / tris;
    const b = pos.length / 3;
    pos.push(0, y, 0, 0.2, y, 0, 0, y + 1 / tris, 0.2);
    idx.push(b, b + 1, b + 2);
  }

  const P = new Float32Array(pos), I = new Uint16Array(idx);
  const bin = new Uint8Array(P.byteLength + I.byteLength);
  bin.set(new Uint8Array(P.buffer), 0);
  bin.set(new Uint8Array(I.buffer), P.byteLength);

  const prim = (m) => (materials ? { attributes: { POSITION: 0 }, indices: 1, material: m } : { attributes: { POSITION: 0 }, indices: 1 });
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: names.map((_, i) => i) }],
    nodes: names.map((name) => ({ name, mesh: materials && name.endsWith('swatch_black') ? 1 : 0 })),
    meshes: [{ primitives: [prim(0)] }, { primitives: [prim(1)] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: P.length / 3, type: 'VEC3', min: [0, 0, 0], max: [0.2, 1, 0.2] },
      { bufferView: 1, componentType: 5123, count: I.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: P.byteLength },
      { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };

  if (materials) {
    json.materials = [
      { name: 'w', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.85, 0.8, 1] } },
      { name: 'b', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.1, 0.1, 1] } },
    ];
  }

  const pad = (n) => (4 - (n % 4)) % 4;
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  jsonBytes = Uint8Array.from([...jsonBytes, ...new Array(pad(jsonBytes.length)).fill(0x20)]);
  const binBytes = Uint8Array.from([...bin, ...new Array(pad(bin.length)).fill(0)]);

  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, 0x46546C67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);

  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4E4F534A, true);
  out.set(jsonBytes, 20);

  const o = 20 + jsonBytes.length;
  dv.setUint32(o, binBytes.length, true);
  dv.setUint32(o + 4, 0x004E4942, true);
  out.set(binBytes, o + 8);

  return out.buffer;
}

const FULL_TRIS = 400, PROXY_TRIS = 8;

async function registerSet(id) {
  const prefix = id + '_';
  const mapping = {};
  for (const r of ROLES) mapping[r] = prefix + r;

  await registerGltfSet({
    id, data: glb([...ROLES.map((r) => prefix + r), prefix + 'swatch_black'], { tris: FULL_TRIS, materials: true }),
    mapping, keepMaterials: true, blackFrom: prefix + 'swatch_black', keepOrigin: true, kind: 'model',
    proxyData: glb(ROLES.map((r) => prefix + r), { tris: PROXY_TRIS, materials: false }),
  });
}

// A renderer that behaves like three's here.

const triangles = (o) => (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;

/** Like WebGLRenderer.render: the shadow pass, then the frame; logs the visible piece meshes per pass. */
function makeRenderer() {
  const canvas = makeElement('canvas');
  const log = [];
  const info = { autoReset: true, render: { triangles: 0 }, reset() { this.render.triangles = 0; } };

  const pieceMeshes = (scene) => {
    const out = [];
    scene.traverseVisible((o) => { if (o.isMesh && (standInOf(o) || o.userData.standIn)) out.push(o); });
    return out;
  };

  let target = null;

  const r = {
    isWebGLRenderer: true, domElement: canvas, info, log,
    toneMapping: null, toneMappingExposure: 1, outputColorSpace: null, autoClear: true,
    shadowMap: {
      enabled: false, type: null, autoUpdate: true, needsUpdate: false,
      render(lights, scene) {
        if (!this.enabled || !(this.autoUpdate || this.needsUpdate)) return;

        const due = lights.filter((l) => l.shadow && (l.shadow.autoUpdate || l.shadow.needsUpdate));
        if (!due.length) return;

        scene.traverseVisible((o) => { if (o.isMesh && (o.castShadow || o.receiveShadow)) info.render.triangles += triangles(o); });
        log.push({ pass: 'shadow', meshes: pieceMeshes(scene) });
        for (const l of due) l.shadow.needsUpdate = false;
      },
    },
    setPixelRatio() {},
    setSize(w, h) {
      canvas.width = w;
      canvas.height = h;
    },
    getDrawingBufferSize: (v) => v.set(canvas.width || 64, canvas.height || 64),
    getRenderTarget: () => target,
    setRenderTarget(t) { target = t; },
    getClearAlpha: () => 0, getClearColor: (c) => c, setClearColor() {}, copyFramebufferToTexture() {},
    render(scene, camera) {
      if (!scene.isScene) return;

      const lights = [];
      scene.traverseVisible((o) => { if (o.isLight && o.castShadow) lights.push(o); });
      if (this.shadowMap.enabled) this.shadowMap.render(lights, scene, camera);

      if (!scene.children.some((c) => c.isMesh && c.geometry && c.geometry.type === 'PlaneGeometry' && scene.children.length === 1)) {
        scene.traverseVisible((o) => { if (o.isMesh) info.render.triangles += triangles(o); });
        log.push({ pass: target ? 'target' : 'frame', meshes: pieceMeshes(scene) });
      }
    },
    dispose() {},
  };
  return r;
}

test('the view draws the shadow map and the edge mask from the stand-ins, and the picture from the full meshes', async () => {
  await registerSet('siv');
  const container = makeElement('div');
  const renderer = makeRenderer();
  const view = createView(container, { animations: true, shadows: true }, { renderer, labelRenderer: null, environment: false });

  try {
    const pieces = ['white', 'black'].map((c) => createPiece('rook', c, 'siv'));
    pieces[0].position.set(-1, 0, 2);
    pieces[1].position.set(1, 0, -3);
    for (const p of pieces) view.scene.add(p);

    const full = [], stand = [];
    for (const p of pieces) p.traverse((o) => {
      if (o.isMesh && standInOf(o)) {
        full.push(o);
        stand.push(standInOf(o));
      }
    });
    assert.equal(full.length, 2);
    assert.ok(view.edgeLight.color.r + view.edgeLight.color.g + view.edgeLight.color.b > 0, 'the edge light is on (lit 3D)');

    view.invalidate('content');
    renderer.log.length = 0;
    pump(2);

    const shadow = renderer.log.filter((e) => e.pass === 'shadow');
    const frame = renderer.log.filter((e) => e.pass === 'frame');
    const mask = renderer.log.filter((e) => e.pass === 'target');
    assert.ok(shadow.length >= 1, 'the shadow map was drawn');
    assert.ok(frame.length >= 1, 'the frame was drawn');
    assert.ok(mask.length >= 1, 'the edge mask was drawn');

    for (const e of shadow) assert.deepEqual(new Set(e.meshes), new Set(stand), 'shadow map: the stand-ins only');
    for (const e of frame) assert.deepEqual(new Set(e.meshes), new Set(full), 'picture: the full meshes only');
    for (const e of mask) assert.deepEqual(new Set(e.meshes), new Set(stand), 'edge mask: the stand-ins only');

    for (const m of full) assert.equal(m.visible, true, 'everything put back after the frame');
    for (const s of stand) assert.equal(s.visible, false);

    const t = view.stats.triangles;
    assert.ok(t.shadow > 0 && t.edge > 0, JSON.stringify(t));
    assert.ok(t.main >= 2 * FULL_TRIS, 'the picture counts the full meshes');
    assert.ok(t.edge < FULL_TRIS, `the mask counts the stand-ins (${t.edge})`);
  } finally {
    view.dispose();
    unregisterSet('siv');
  }
});

test('with shadows off, view.stats.triangles follows the frames drawn', async () => {
  await registerSet('siw');
  const container = makeElement('div');
  const renderer = makeRenderer();
  const view = createView(container, { animations: true, shadows: false }, { renderer, labelRenderer: null, environment: false });

  try {
    const p = createPiece('king', 'white', 'siw');
    view.scene.add(p);

    view.invalidate('content');
    pump(2);

    const t = view.stats.triangles;
    assert.equal(t.shadow, 0);
    assert.ok(t.main >= FULL_TRIS, JSON.stringify(t));
    assert.ok(t.edge > 0 && t.edge < FULL_TRIS, `the edge pass is reported (${t.edge})`);
    assert.deepEqual(view.stats.triangles, view.stats.lastTriangles);
  } finally {
    view.dispose();
    unregisterSet('siw');
  }
});
