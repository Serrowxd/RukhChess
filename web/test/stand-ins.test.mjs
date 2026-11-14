// The modelled sets' low-detail stand-ins: pieces.js standInOf, modeledSets.js loadProxyBytes, silhouette.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { ROLES, createPiece, applyMaterials, registerGltfSet, unregisterSet, standInOf, drawWithStandIns } from '../src/three/pieces.js';
import { MODELED_SETS, loadProxyBytes } from '../src/three/modeledSets.js';
import { createPieceLayer } from '../src/three/pieceLayer.js';
import { createMaterialSet } from '../src/three/materials.js';
import { createSilhouette } from '../src/three/silhouette.js';

/** A GLB with one tetrahedron per node name; `materials` adds the set file's white/black pair. */
function glb(names, { materials = false, height = 1 } = {}) {
  const pos = new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0, 0.2, 0.05, height, 0.05]);
  const idx = new Uint16Array([0, 1, 2, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);

  const prim = (m) => (materials ? { attributes: { POSITION: 0 }, indices: 1, material: m } : { attributes: { POSITION: 0 }, indices: 1 });
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: names.map((_, i) => i) }],
    nodes: names.map((name, i) => ({ name, mesh: materials && name.endsWith('swatch_black') ? 1 : 0 })),
    meshes: [{ primitives: [prim(0)] }, { primitives: [prim(1)] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [0.2, height, 0.2] },
      { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };

  if (materials) {
    json.materials = [
      { name: 'w', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.85, 0.8, 1] }, doubleSided: true },
      { name: 'b', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.1, 0.1, 1] }, doubleSided: true },
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

/** Register a modelled-style set; `proxyData` is the stand-in GLB (or bytes, or null). */
async function registerTestSet(id, proxyData) {
  const prefix = id + '_';
  const mapping = {};
  for (const r of ROLES) mapping[r] = prefix + r;

  await registerGltfSet({
    id, data: glb([...ROLES.map((r) => prefix + r), prefix + 'swatch_black'], { materials: true }), mapping,
    keepMaterials: true, blackFrom: prefix + 'swatch_black', keepOrigin: true, kind: 'model', proxyData,
  });
  return prefix;
}

/** The piece's full (drawn) mesh. */
function fullMesh(piece) {
  let m = null;
  piece.traverse((o) => { if (!m && o.isMesh && !o.userData.contactShadow && !o.userData.standIn) m = o; });
  return m;
}

function quietConsole() {
  const seen = [];
  const keep = { warn: console.warn, error: console.error };

  console.warn = (...a) => seen.push(['warn', a.join(' ')]);
  console.error = (...a) => seen.push(['error', a.join(' ')]);

  return {
    seen,
    restore() {
      console.warn = keep.warn;
      console.error = keep.error;
    }
  };
}

test('a set with a proxy file: every piece carries a hidden stand-in beside its full mesh', async () => {
  const prefix = await registerTestSet('si-a', glb(ROLES.map((r) => 'si-a_' + r), { height: 0.98 }));

  try {
    for (const color of ['white', 'black']) for (const role of ROLES) {
      const piece = createPiece(role, color, 'si-a');
      const full = fullMesh(piece);
      const s = standInOf(full);

      assert.ok(s && s.isMesh, `${color} ${role}: has a stand-in`);
      assert.equal(s.parent, full.parent, 'it sits beside the full mesh, under the same transforms');
      assert.equal(s.name, prefix + role + '.standIn');
      assert.equal(s.visible, false, 'hidden: never in the main picture');
      assert.equal(s.castShadow, true);
      assert.equal(s.userData.standIn, true);
      assert.ok(s.geometry.index.count / 3 < 10, 'the stand-in geometry, not the full one');
      assert.notEqual(s.geometry, full.geometry);
      assert.deepEqual(s.matrix.elements, full.matrix.elements, 'same local transform as the full mesh');
    }

    assert.equal(standInOf(createPiece('king', 'white', 'staunton')), null, 'built-in sets: none');
    assert.equal(standInOf(null), null);
  } finally {
    unregisterSet('si-a');
  }
});

test('the stand-in follows the piece, is never picked, and keeps its own material through a theme change', async () => {
  await registerTestSet('si-b', glb(ROLES.map((r) => 'si-b_' + r)));
  const wood = createMaterialSet('wood'), metal = createMaterialSet('metal');

  try {
    const piece = createPiece('knight', 'white', 'si-b', wood);
    const full = fullMesh(piece), s = standInOf(full);
    const own = s.material;

    piece.position.set(2.5, 0.35, -1.5);
    piece.rotation.y = 1.1;
    piece.updateMatrixWorld(true);
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(s.matrixWorld.elements[i] - full.matrixWorld.elements[i]) < 1e-12);

    const ray = new THREE.Raycaster(new THREE.Vector3(2.5 + 0.06, 5, -1.5 + 0.06), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObject(piece, true);
    assert.ok(hits.length > 0, 'the full mesh is hit');
    assert.ok(hits.every((h) => h.object !== s), 'the stand-in never is');

    applyMaterials(piece, metal);
    assert.equal(s.material, own, 'applyMaterials leaves it alone');
    assert.notEqual(full.material, own);
  } finally {
    wood.dispose();
    metal.dispose();
    unregisterSet('si-b');
  }
});

test('a missing role in the proxy file leaves that piece without a stand-in; the rest keep theirs', async () => {
  await registerTestSet('si-c', glb(['si-c_pawn', 'si-c_rook']));

  try {
    assert.ok(standInOf(fullMesh(createPiece('pawn', 'black', 'si-c'))));
    assert.ok(standInOf(fullMesh(createPiece('rook', 'white', 'si-c'))));
    assert.equal(standInOf(fullMesh(createPiece('queen', 'white', 'si-c'))), null);
  } finally {
    unregisterSet('si-c');
  }
});

test('no proxy file, or one that cannot be read: the set loads as before, quietly, with no stand-ins', async () => {
  const quiet = quietConsole();

  try {
    await registerTestSet('si-d', null);
    await registerTestSet('si-e', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer);

    for (const id of ['si-d', 'si-e']) {
      const piece = createPiece('bishop', 'white', id);
      assert.equal(standInOf(fullMesh(piece)), null, id);

      let n = 0;
      piece.traverse((o) => { if (o.userData.standIn) n++; });
      assert.equal(n, 0, `${id}: nothing extra in the piece`);
    }
  } finally {
    quiet.restore();
    unregisterSet('si-d');
    unregisterSet('si-e');
  }

  assert.deepEqual(quiet.seen, [], 'no warnings or errors');
});

test('the piece layer: lifted, dragged and moved pieces keep their stand-ins exactly on them', async () => {
  await registerTestSet('si-f', glb(ROLES.map((r) => 'si-f_' + r)));
  const scene = new THREE.Scene();
  const mats = createMaterialSet('wood', null);
  const layer = createPieceLayer(scene, mats, { pieceSet: 'si-f', pieceSet2d: 'glyph', animations: true });

  const check = (label) => {
    scene.updateMatrixWorld(true);
    let n = 0;

    for (const obj of layer.pieceObjects()) {
      const full = fullMesh(obj), s = standInOf(full);
      assert.ok(s, `${label}: ${obj.userData.square} has a stand-in`);
      for (let i = 0; i < 16; i++) assert.ok(Math.abs(s.matrixWorld.elements[i] - full.matrixWorld.elements[i]) < 1e-9, label);
      n++;
    }

    return n;
  };

  try {
    layer.sync([
      { square: 'g1', piece: { color: 'white', role: 'knight' } },
      { square: 'e8', piece: { color: 'black', role: 'king' } },
    ], { instant: true });
    assert.equal(check('placed'), 2);

    layer.lift('g1');
    layer.dragTo(new THREE.Vector3(1.2, 0, 0.4));
    check('dragged');

    layer.drop('f3');
    layer.sync([
      { square: 'f3', piece: { color: 'white', role: 'knight' } },
      { square: 'e8', piece: { color: 'black', role: 'king' } },
    ], { animateFrom: { from: 'g1', to: 'f3' } });
    check('moved');
  } finally {
    layer.dispose();
    mats.dispose();
    unregisterSet('si-f');
  }
});

test('edge-light mask: the stand-in draws in the full mesh\'s place with its fade, and everything is put back', async () => {
  await registerTestSet('si-g', glb(ROLES.map((r) => 'si-g_' + r)));

  try {
    const scene = new THREE.Scene();
    const piece = createPiece('queen', 'white', 'si-g');
    scene.add(piece);

    const full = fullMesh(piece), s = standInOf(full);
    const fade = full.material.clone();
    fade.transparent = true;
    fade.opacity = 0.5;
    full.material = fade;

    const before = { fullMat: full.material, fullHook: full.onBeforeRender, sMat: s.material, sHook: s.onBeforeRender };
    let during = null;

    const renderer = {
      shadowMap: { autoUpdate: true },
      autoClear: true,
      getRenderTarget: () => null, setRenderTarget() {}, getClearAlpha: () => 0, getClearColor: (c) => c,
      setClearColor() {}, copyFramebufferToTexture() {},
      getDrawingBufferSize: (v) => v.set(64, 64),
      render(sc) {
        if (sc !== scene) return;

        const mask = s.material;
        s.onBeforeRender();
        during = {
          fullVisible: full.visible, sVisible: s.visible, sIsMask: mask !== before.sMat && mask.isShaderMaterial,
          fullMat: full.material, opacity: mask.uniforms.uOpacity.value,
        };
      },
    };

    const isPiece = (o) => o.isMesh && !o.userData.contactShadow;
    const sil = createSilhouette(renderer, isPiece, standInOf);
    assert.equal(sil.render(scene, new THREE.PerspectiveCamera(), { color: new THREE.Color(1, 1, 1), focus: 10 }), true);

    assert.ok(during, 'the mask was drawn');
    assert.equal(during.fullVisible, false, 'the full mesh is out of the mask');
    assert.equal(during.sVisible, true, 'the stand-in is in it');
    assert.ok(during.sIsMask, 'wearing the mask material');
    assert.equal(during.fullMat, before.fullMat, 'the full mesh is not repainted');
    assert.equal(during.opacity, 0.5, 'the edge still fades with the piece');

    assert.equal(full.visible, true);
    assert.equal(s.visible, false);
    assert.equal(full.material, before.fullMat);
    assert.equal(s.material, before.sMat);
    assert.equal(full.onBeforeRender, before.fullHook);
    assert.equal(s.onBeforeRender, before.sHook);

    sil.dispose();
  } finally {
    unregisterSet('si-g');
  }
});

test('modelled sets: every listed proxy file ships beside its set, and loadProxyBytes never throws', async () => {
  for (const s of MODELED_SETS) {
    if (!s.proxy) continue;
    assert.ok(fs.existsSync(new URL('../sets/' + s.proxy, import.meta.url)), `sets/${s.proxy} exists`);
  }

  const hadFetch = 'fetch' in globalThis, prev = globalThis.fetch;
  const calls = [];

  try {
    assert.equal(await loadProxyBytes(null), null);
    assert.equal(await loadProxyBytes({ id: 'x', file: 'x.glb' }), null, 'no proxy listed: nothing fetched');

    globalThis.fetch = async (url) => {
      calls.push(url);
      throw new TypeError('Failed to fetch');
    };
    assert.equal(await loadProxyBytes({ id: 'x', proxy: 'x.proxy.glb' }), null, 'a failed fetch is null');

    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: false, status: 404 };
    };
    assert.equal(await loadProxyBytes({ id: 'x', proxy: 'x.proxy.glb' }), null, 'a 404 is null');

    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) };
    };
    assert.equal((await loadProxyBytes({ id: 'x', proxy: 'x.proxy.glb' })).byteLength, 4);
    assert.deepEqual(calls, ['sets/x.proxy.glb', 'sets/x.proxy.glb', 'sets/x.proxy.glb']);

    // The single-file build inlines each set as <script id="set-<id>"> with no stand-ins: nothing is fetched.
    const hadDoc = 'document' in globalThis, prevDoc = globalThis.document;
    globalThis.document = { getElementById: (id) => (id === 'set-x' ? { textContent: 'AAAA' } : null) };

    try {
      assert.equal(await loadProxyBytes({ id: 'x', proxy: 'x.proxy.glb' }), null, 'inline set: no stand-ins');
      assert.equal(calls.length, 3, 'and no request');
    } finally {
      if (hadDoc) globalThis.document = prevDoc;
      else delete globalThis.document;
    }
  } finally {
    if (hadFetch) globalThis.fetch = prev;
    else delete globalThis.fetch;
  }
});

test('drawWithStandIns: during the draw each full mesh is hidden and its stand-in shown in its material; all put back, also on a throw', async () => {
  await registerTestSet('si-h', glb(ROLES.map((r) => 'si-h_' + r)));

  try {
    const scene = new THREE.Scene();
    const a = createPiece('rook', 'white', 'si-h'), b = createPiece('pawn', 'black', 'si-h');
    const plain = createPiece('king', 'white', 'staunton');   // no stand-in: left alone
    const gone = createPiece('queen', 'white', 'si-h');
    gone.visible = false;                                    // a hidden piece is not swapped in
    scene.add(a, b, plain, gone);

    const pairs = [a, b, gone].map((p) => {
      const f = fullMesh(p), s = standInOf(f);
      return { f, s, fm: f.material, sm: s.material };
    });
    const plainMesh = fullMesh(plain);

    const check = () => {
      for (const { f, s, fm, sm } of pairs) {
        assert.equal(f.visible, true);
        assert.equal(s.visible, false);
        assert.equal(f.material, fm);
        assert.equal(s.material, sm);
      }
    };

    let seen = null, plainSeen = null;
    const out = drawWithStandIns(scene, () => {
      seen = pairs.map(({ f, s, fm }) => ({ full: f.visible, stand: s.visible, mat: s.material === fm }));
      plainSeen = plainMesh.visible;
      return 'drawn';
    });

    assert.equal(out, 'drawn', 'returns what the draw returns');
    assert.deepEqual(seen[0], { full: false, stand: true, mat: true });
    assert.deepEqual(seen[1], { full: false, stand: true, mat: true });
    assert.deepEqual(seen[2], { full: true, stand: false, mat: false }, 'a hidden piece is not touched');
    assert.equal(plainSeen, true, 'a mesh without a stand-in draws itself');
    check();

    assert.throws(() => drawWithStandIns(scene, () => { throw new Error('lost context'); }), /lost context/);
    check();
  } finally {
    unregisterSet('si-h');
  }
});

test('edge-light mask: a draw that throws still puts every piece and the renderer back', async () => {
  await registerTestSet('si-i', glb(ROLES.map((r) => 'si-i_' + r)));

  try {
    const scene = new THREE.Scene();
    const piece = createPiece('bishop', 'white', 'si-i');
    scene.add(piece);

    const full = fullMesh(piece), s = standInOf(full);
    const before = { fullMat: full.material, sMat: s.material };
    const state = { target: 'frame', autoClear: true, shadows: true, clear: 'frame' };

    const renderer = {
      shadowMap: { get autoUpdate() { return state.shadows; }, set autoUpdate(v) { state.shadows = v; } },
      get autoClear() { return state.autoClear; }, set autoClear(v) { state.autoClear = v; },
      getRenderTarget: () => state.target, setRenderTarget(t) { state.target = t; },
      getClearAlpha: () => 1, getClearColor: (c) => c.set(0.5, 0.5, 0.5),
      setClearColor(c) { state.clear = typeof c === 'number' ? c : 'frame'; }, copyFramebufferToTexture() {},
      getDrawingBufferSize: (v) => v.set(64, 64),
      render() { throw new Error('shader failed'); },
    };

    const sil = createSilhouette(renderer, (o) => o.isMesh && !o.userData.contactShadow, standInOf);
    assert.throws(() => sil.render(scene, new THREE.PerspectiveCamera(), { color: new THREE.Color(1, 1, 1), focus: 10 }), /shader failed/);

    assert.equal(full.visible, true);
    assert.equal(s.visible, false);
    assert.equal(full.material, before.fullMat);
    assert.equal(s.material, before.sMat);
    assert.deepEqual(state, { target: 'frame', autoClear: true, shadows: true, clear: 'frame' }, 'renderer state restored');

    sil.dispose();
  } finally {
    unregisterSet('si-i');
  }
});

test('a fade clones materials for the full meshes only, never for the stand-ins', async () => {
  await registerTestSet('si-j', glb(ROLES.map((r) => 'si-j_' + r)));
  const scene = new THREE.Scene();
  const mats = createMaterialSet('wood', null);
  const layer = createPieceLayer(scene, mats, { pieceSet: 'si-j', pieceSet2d: 'glyph', animations: true });

  // Without requestAnimationFrame every tween lands at once; a queue that never runs holds the fade open.
  const hadRaf = 'requestAnimationFrame' in globalThis, prevRaf = globalThis.requestAnimationFrame;
  const prevCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  try {
    layer.sync([{ square: 'd1', piece: { color: 'white', role: 'queen' } }], { instant: true });
    const [obj] = layer.pieceObjects();
    const full = fullMesh(obj), s = standInOf(full);
    const own = s.material;

    layer.fadeIn(1000);

    assert.equal(full.userData.fadeMaterial, true, 'the full mesh fades');
    assert.equal(s.material, own, 'the stand-in keeps its own material');
    assert.ok(!s.userData.fadeMaterial);
  } finally {
    layer.dispose();

    if (hadRaf) {
      globalThis.requestAnimationFrame = prevRaf;
      globalThis.cancelAnimationFrame = prevCaf;
    } else {
      delete globalThis.requestAnimationFrame;
      delete globalThis.cancelAnimationFrame;
    }

    mats.dispose();
    unregisterSet('si-j');
  }
});

test('loadProxyBytes gives up on a stalled request: null, and the request is aborted', async () => {
  const hadFetch = 'fetch' in globalThis, prev = globalThis.fetch;
  let aborted = false;

  try {
    globalThis.fetch = (url, opts) => new Promise((resolve, reject) => {
      if (opts && opts.signal) opts.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    });

    const t0 = Date.now();
    assert.equal(await loadProxyBytes({ id: 'x', proxy: 'x.proxy.glb' }, { timeoutMs: 30 }), null);
    assert.ok(Date.now() - t0 < 2000, 'resolved at the timeout');
    assert.equal(aborted, true);

    globalThis.fetch = () => new Promise(() => {});   // one that ignores the abort signal entirely
    assert.equal(await loadProxyBytes({ id: 'x', proxy: 'x.proxy.glb' }, { timeoutMs: 30 }), null);
  } finally {
    if (hadFetch) globalThis.fetch = prev;
    else delete globalThis.fetch;
  }
});

/** The JSON chunk of a GLB file. */
function glbJson(url) {
  const b = fs.readFileSync(url);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
}

/** A node's POSITION bounds over its mesh's primitives, from the accessors' min/max. */
function nodeBounds(json, name) {
  const node = json.nodes.find((n) => n.name === name);
  if (!node || node.mesh === undefined) return null;

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of json.meshes[node.mesh].primitives) {
    const acc = json.accessors[p.attributes.POSITION];
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], acc.min[a]);
      max[a] = Math.max(max[a], acc.max[a]);
    }
  }

  const { translation, rotation, scale, matrix } = node;
  return { min, max, transform: { translation, rotation, scale, matrix } };
}

test('every proxy file still matches its set: the six nodes, the same transforms, bounds within 1.5% per axis', () => {
  for (const s of MODELED_SETS) {
    if (!s.proxy) continue;

    const src = glbJson(new URL('../sets/' + s.file, import.meta.url));
    const prx = glbJson(new URL('../sets/' + s.proxy, import.meta.url));

    for (const role of ROLES) {
      const name = s.prefix + role;
      const a = nodeBounds(src, name), b = nodeBounds(prx, name);
      assert.ok(a, `${s.file}: ${name}`);
      assert.ok(b, `${s.proxy}: ${name} is missing (re-run npm run proxies after changing the set)`);
      assert.deepEqual(b.transform, a.transform, `${name}: same node transform`);

      for (let ax = 0; ax < 3; ax++) {
        const size = a.max[ax] - a.min[ax];
        const off = Math.max(Math.abs(a.min[ax] - b.min[ax]), Math.abs(a.max[ax] - b.max[ax])) / size;
        assert.ok(off < 0.015, `${name} axis ${ax}: proxy bounds ${(off * 100).toFixed(2)}% off the set's (re-run npm run proxies)`);
      }
    }
  }
});
