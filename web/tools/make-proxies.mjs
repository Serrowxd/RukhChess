// Shadow / edge-mask stand-ins for the modelled piece sets.
//
// For every set GLB in web/sets this writes web/sets/<id>.proxy.glb: one low-detail copy of each of the six
// piece meshes, under the same node name and with the same transform, holding positions and indices only
// (no normals, UVs, textures or materials). The board can draw these in the shadow map and the edge mask,
// where full detail is invisible, and keep the full meshes for the main picture.
//
// The proxies are derived from the set art and so are art under the same licence (see ../../LICENSE-ART.md);
// they ship as separate files and must never be bundled into app.js.
//
// Usage: node tools/make-proxies.mjs        (or: npm run proxies)
// Safe to re-run: it only ever writes <id>.proxy.glb and never touches the source GLBs.

import { readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';

const SETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'sets');
const ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
// Triangle budgets tried per piece, smallest first. A piece takes the first budget whose outline matches the
// source to MIN_OVERLAP; thin features (antlers, a swan's neck, crosses) lose shape at the smallest budget and so
// get a larger one, while plain turned pieces stay at the smallest.
const BUDGETS = [1500, 2500, 4000, 6000];
const MIN_OVERLAP = 99;     // percent, silhouette intersection over union, worst of front and side
const MAX_TRIS = 6500;      // hard ceiling per piece
const WELD_TOLERANCE = 1e-5;   // fraction of the piece's bounding-box diagonal
const GRID = 256;           // silhouette check resolution (cells per side)
const TRIANGLES = 4;        // glTF primitive mode

// ---------------------------------------------------------------------------------------------
// Geometry helpers

/** Positions (xyz floats) and triangle indices of every triangle primitive on a mesh, merged. */
function readMesh(mesh) {
  const pos = [];
  const idx = [];
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== TRIANGLES) continue;
    const p = prim.getAttribute('POSITION');
    const base = pos.length / 3;
    const v = [0, 0, 0];
    for (let i = 0; i < p.getCount(); i++) { p.getElement(i, v); pos.push(v[0], v[1], v[2]); }
    const ind = prim.getIndices();
    if (ind) for (let i = 0; i < ind.getCount(); i++) idx.push(base + ind.getScalar(i));
    else for (let i = 0; i < p.getCount(); i++) idx.push(base + i);
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  }
  return { min, max };
}

/**
 * Merge vertices that sit at (nearly) the same place. The source meshes split vertices along UV and normal
 * seams; left split, those seams act as borders the simplifier cannot collapse across.
 */
function weld({ positions, indices }) {
  const { min, max } = bounds(positions);
  const cell = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) * WELD_TOLERANCE;
  const keyToNew = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const out = [];
  for (let i = 0; i < remap.length; i++) {
    const key = `${Math.round(positions[i * 3] / cell)},${Math.round(positions[i * 3 + 1] / cell)},${Math.round(positions[i * 3 + 2] / cell)}`;
    let n = keyToNew.get(key);
    if (n === undefined) {
      n = out.length / 3;
      keyToNew.set(key, n);
      out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    remap[i] = n;
  }
  // Drop triangles that welding made degenerate.
  const tri = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]], b = remap[indices[i + 1]], c = remap[indices[i + 2]];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(tri) };
}

/** Keep only the vertices the index list uses, renumbered in order of first use. */
function compact(positions, indices) {
  const map = new Map();
  const pos = [];
  const idx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) {
    let n = map.get(indices[i]);
    if (n === undefined) {
      n = pos.length / 3;
      map.set(indices[i], n);
      const s = indices[i] * 3;
      pos.push(positions[s], positions[s + 1], positions[s + 2]);
    }
    idx[i] = n;
  }
  return { positions: new Float32Array(pos), indices: idx };
}

/**
 * Simplify a welded mesh to about `budget` triangles. The error bound is left wide open so the triangle budget
 * decides; the simplifier spends its budget on the largest shape changes first, which keeps the outer shape and
 * drops surface detail. If topology stops it well short of the budget, it falls back to the sloppy
 * (vertex-clustering) simplifier, which ignores topology.
 */
function simplify(mesh, budget) {
  const target = budget * 3;
  let [idx] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, target, 1, []);
  let method = 'simplify';
  if (idx.length / 3 > Math.min(MAX_TRIS, Math.ceil(budget * 5 / 3))) {
    [idx] = MeshoptSimplifier.simplifySloppy(mesh.indices, mesh.positions, 3, null, target, 1);
    method = 'sloppy';
  }
  return { ...compact(mesh.positions, idx), method };
}

// ---------------------------------------------------------------------------------------------
// Checks printed per piece

/** Largest distance between matching faces of two bounding boxes, as a fraction of the source's size per axis. */
function boxDiff(src, dst) {
  const out = [];
  for (let a = 0; a < 3; a++) {
    const size = src.max[a] - src.min[a] || 1;
    out.push(Math.max(Math.abs(src.min[a] - dst.min[a]), Math.abs(src.max[a] - dst.max[a])) / size);
  }
  return out;
}

/** Fill the cells of a GRID x GRID mask covered by the mesh projected onto axes (u, v), framed by box. */
function silhouette({ positions, indices }, u, v, box) {
  const mask = new Uint8Array(GRID * GRID);
  const su = (box.max[u] - box.min[u]) || 1;
  const sv = (box.max[v] - box.min[v]) || 1;
  const P = (i) => [((positions[i * 3 + u] - box.min[u]) / su) * GRID, ((positions[i * 3 + v] - box.min[v]) / sv) * GRID];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [P(indices[t]), P(indices[t + 1]), P(indices[t + 2])];
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(GRID - 1, Math.floor(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(GRID - 1, Math.floor(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (area === 0) continue;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area;
        const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) mask[y * GRID + x] = 1;
      }
    }
  }
  return mask;
}

/** Intersection over union of the source and proxy silhouettes, front (x,y) and side (z,y), in percent. */
function overlap(src, dst, box) {
  return [[0, 1], [2, 1]].map(([u, v]) => {
    const a = silhouette(src, u, v, box);
    const b = silhouette(dst, u, v, box);
    let inter = 0, union = 0;
    for (let i = 0; i < a.length; i++) { inter += a[i] & b[i]; union += a[i] | b[i]; }
    return union ? (100 * inter) / union : 100;
  });
}

// ---------------------------------------------------------------------------------------------

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
await MeshoptSimplifier.ready;

const sources = readdirSync(SETS).filter((f) => f.endsWith('.glb') && !f.endsWith('.proxy.glb')).sort();
if (!sources.length) throw new Error(`no set GLBs in ${SETS}`);

let failures = 0;
for (const file of sources) {
  const id = file.replace(/\.glb$/, '');
  const src = await io.read(join(SETS, file));
  const nodes = src.getRoot().listNodes();

  let setFailures = 0;
  const out = new Document();
  out.createBuffer();
  const scene = out.createScene(id + '_proxy');
  for (const role of ROLES) {
    const name = `${id}_${role}`;
    const node = nodes.find((n) => n.getName() === name);
    if (!node || !node.getMesh()) throw new Error(`${file}: mesh node '${name}' not found`);

    const full = readMesh(node.getMesh());
    const welded = weld(full);
    const srcBox = bounds(full.positions);
    // The smallest budget whose outline holds; the largest if none does (the check below then reports it).
    let proxy = null, front = 0, side = 0;
    for (const budget of BUDGETS) {
      proxy = simplify(welded, budget);
      [front, side] = overlap(full, proxy, srcBox);
      if (Math.min(front, side) >= MIN_OVERLAP) break;
    }

    const posAcc = out.createAccessor().setType('VEC3').setArray(proxy.positions);
    const idxAcc = out.createAccessor().setType('SCALAR').setArray(
      proxy.positions.length / 3 <= 65535 ? Uint16Array.from(proxy.indices) : proxy.indices);
    const prim = out.createPrimitive().setAttribute('POSITION', posAcc).setIndices(idxAcc);
    const pnode = out.createNode(name).setMesh(out.createMesh(name).addPrimitive(prim));
    // Same placement as the source: its full world transform, so the proxy lines up even if the source is parented.
    pnode.setMatrix(node.getWorldMatrix());
    scene.addChild(pnode);

    const diff = Math.max(...boxDiff(srcBox, bounds(proxy.positions))) * 100;
    const srcTris = full.indices.length / 3, tris = proxy.indices.length / 3;
    const bad = tris > MAX_TRIS || diff > 1 || Math.min(front, side) < 95;
    if (bad) setFailures++;
    console.log(`${id.padEnd(10)} ${role.padEnd(7)} ${String(srcTris).padStart(6)} -> ${String(tris).padStart(5)} tris` +
      `  bbox max diff ${diff.toFixed(3)}%  silhouette front ${front.toFixed(1)}% side ${side.toFixed(1)}%` +
      `  (${proxy.method})${bad ? '  CHECK FAILED' : ''}`);
  }

  // A set with a piece that failed its check keeps its old proxy file: the build must not ship a bad one.
  if (setFailures) {
    failures += setFailures;
    console.log(`NOT written: sets/${id}.proxy.glb (the old file, if any, is kept)`);
    continue;
  }
  // Write to a temp name, then rename over the old proxy, so a crash never leaves a half-written file.
  const target = join(SETS, `${id}.proxy.glb`);
  const tmp = target + '.tmp';
  writeFileSync(tmp, await io.writeBinary(out));
  renameSync(tmp, target);
  console.log(`wrote sets/${id}.proxy.glb`);
}

if (failures) {
  console.error(`${failures} piece(s) failed a check (over ${MAX_TRIS} tris, bbox off by more than 1%, or silhouette under 95%);` +
    ' their sets were not written');
  process.exit(1);
}
