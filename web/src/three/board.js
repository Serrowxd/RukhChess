import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { setMaterialUnlit } from './materials.js';
import { requestRedraw } from './redraw.js';

/** File letters in board order; index = file number 0..7. */
export const FILES = 'abcdefgh';

/** All 64 square names, a1, b1, … h8. */
export const SQUARES = (() => {
  const out = [];
  for (let r = 1; r <= 8; r++) for (let f = 0; f < 8; f++) out.push(FILES[f] + r);
  return out;
})();

/** Square name -> board-plane centre {x, z}; null for anything that is not a square. */
export function squareToWorld(square) {
  if (typeof square !== 'string' || square.length !== 2) return null;

  const f = FILES.indexOf(square[0]);
  const r = square.charCodeAt(1) - 49; // '1' -> 0

  if (f < 0 || r < 0 || r > 7) return null;

  return { x: f - 3.5, z: 3.5 - r };
}

/** Board-plane point (x, z) -> square name, or null when the point is off the 8x8 area. */
export function worldToSquare(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;

  const f = Math.floor(x + 4);
  const r = Math.floor(4 - z);

  if (f < 0 || f > 7 || r < 0 || r > 7) return null;

  return FILES[f] + (r + 1);
}

/** True when from -> to is a knight's move. */
export function isKnightJump(from, to) {
  const a = squareToWorld(from), b = squareToWorld(to);

  if (!a || !b) return false;

  const dx = Math.abs(a.x - b.x), dz = Math.abs(a.z - b.z);

  return (dx === 2 && dz === 1) || (dx === 1 && dz === 2);
}

/** a1 is dark: (file + rank) even -> dark square. */
export function isDarkSquare(square) {
  const w = squareToWorld(square);

  if (!w) return false;

  return ((w.x + 3.5) + (3.5 - w.z)) % 2 === 0;
}

const SQ_H = 0.12;            // square block thickness (top at y = 0)
const FRAME_HALF = 4.6;       // frame top-face half-size (9.2 across)
const FRAME_TOP = -0.02;      // frame top face y — squares sit 0.02 proud of it (inlaid look, no coplanar faces)
const FRAME_DEPTH = 0.30;     // total frame thickness
const FRAME_BEVEL = 0.05;     // chamfer on the frame edges
const LABEL_Y = FRAME_TOP + 0.003;
const LABEL_OFFSET = 4.3;     // strip centre line (between board edge 4.0 and frame edge 4.6)
const LABEL_BAND = 0.5;       // strip width
const INLAY_IN = 4.035;       // the stringing's inner / outer half-size: a 0.03 line, 0.035 off the squares
const INLAY_OUT = 4.065;
const INLAY_Y = FRAME_TOP + 0.0015;

const GILT = { color: '#E3BF74', roughness: 0.3, bumpScale: 2.2, blurPx: 3 };

// overlay height and render order per view mode (higher ro = drawn later)
const LAYERS = {
  '3d': {
    lastMove: { y: 0.004, ro: 2, depthTest: true },
    highlight: { y: 0.006, ro: 3, depthTest: true },
    selected: { y: 0.008, ro: 4, depthTest: true },
    check: { y: 0.010, ro: 5, depthTest: true },
    dots: { y: 0.012, ro: 6, depthTest: true },
    rings: { y: 0.012, ro: 6, depthTest: true },
    arrows: { y: 0.016, ro: 7, depthTest: true },
    preview: { y: 0.018, ro: 8, depthTest: true },
    engine: { y: 0.020, ro: 9, depthTest: true },
  },
  '2d': {
    lastMove: { y: 0.004, ro: 2, depthTest: true },
    highlight: { y: 0.006, ro: 3, depthTest: true },
    selected: { y: 0.008, ro: 4, depthTest: true },
    check: { y: 0.010, ro: 5, depthTest: true },
    dots: { y: 0.012, ro: 6, depthTest: true },
    rings: { y: 0.42, ro: 26, depthTest: false },
    arrows: { y: 0.46, ro: 27, depthTest: false },
    preview: { y: 0.48, ro: 28, depthTest: false },
    engine: { y: 0.50, ro: 29, depthTest: false },
  },
};

const FRAME_FLATTEN_2D = 0.34;   // the frame slab's Y scale in 2D: keeps the border, loses the bevel shading
const NOTE_Y = { '3d': 1.2, '2d': 0.45 };

const DEFAULT_OVERLAY_COLORS = {
  selected: { color: '#2f6b3a', opacity: 0.45 },
  dots: { color: '#0b2f14', opacity: 0.92 },   // the marks' outline ink and overall opacity (see drawMarks)
  lastMove: { color: '#f2c14e', opacity: 0.42 },
  check: { color: '#ff1e1e', opacity: 0.85 },
  engine: { color: '#22b8cf', opacity: 0.7 },
};

const DEFAULT_ARROW_COLORS = { green: '#15781B', red: '#882020', blue: '#003088', yellow: '#E68F00' };

// board units; the 2D set is slimmer and more opaque because it is drawn over the tokens
const ARROW_USER = { width: 0.22, headWidth: 0.55, headLength: 0.5, tipGap: 0.35, opacity: 0.8 };
const ARROW_PREVIEW = { ...ARROW_USER, opacity: 0.45 };
const ARROW_ENGINE = { width: 0.14, headWidth: 0.4, headLength: 0.42, tipGap: 0.35, opacity: 0.7 };
const ARROW_USER_2D = { width: 0.17, headWidth: 0.44, headLength: 0.42, tipGap: 0.30, opacity: 0.88 };
const ARROW_PREVIEW_2D = { ...ARROW_USER_2D, opacity: 0.55 };
const ARROW_ENGINE_2D = { width: 0.11, headWidth: 0.33, headLength: 0.36, tipGap: 0.30, opacity: 0.7 };

const ARROW_SPECS = {
  '3d': { user: ARROW_USER, preview: ARROW_PREVIEW, engine: ARROW_ENGINE },
  '2d': { user: ARROW_USER_2D, preview: ARROW_PREVIEW_2D, engine: ARROW_ENGINE_2D },
};

const HEX_RE = /^#[0-9a-f]{3,8}$/i;

// x = world x, y = -world z, so ShapeGeometry.rotateX(-PI/2) lands on the board
function sq2(square) {
  const w = squareToWorld(square);
  return w ? { x: w.x, y: -w.z } : null;
}

/** Build the closed outline of a polyline arrow with mitred corners and a triangular head. */
function arrowOutline(from, to, knight, spec) {
  const a = sq2(from), b = sq2(to);

  if (!a || !b || (a.x === b.x && a.y === b.y)) return null;

  const pts = [a];

  if (knight) {
    const dx = b.x - a.x, dy = b.y - a.y;

    // first leg along the axis whose |delta| is 2, then the 1-square leg
    pts.push(Math.abs(dx) === 2 ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
  }

  pts.push(b);

  // legs: {p (start), d (unit dir), n (left normal), len}
  const legs = [];

  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const len = Math.hypot(q.x - p.x, q.y - p.y);

    if (len < 1e-6) return null;

    const d = { x: (q.x - p.x) / len, y: (q.y - p.y) / len };
    legs.push({ p, d, n: { x: -d.y, y: d.x }, len });
  }

  const hw = spec.width / 2;
  const last = legs[legs.length - 1];
  let shaft = last.len - spec.tipGap - spec.headLength;
  let headLen = spec.headLength;

  if (shaft < 0.06) {
    headLen = Math.max(0.2, last.len - spec.tipGap - 0.06);
    shaft = last.len - spec.tipGap - headLen;
  }

  if (shaft < 0) return null;

  const add = (p, v, s) => ({ x: p.x + v.x * s, y: p.y + v.y * s });
  const shaftEnd = add(last.p, last.d, shaft);
  const tip = add(last.p, last.d, shaft + headLen);

  // mitre points at each interior corner: P + s * (n1 + n2) / (1 + d1 . d2)
  const mitre = (i, s) => {
    const l1 = legs[i], l2 = legs[i + 1];
    const k = 1 + (l1.d.x * l2.d.x + l1.d.y * l2.d.y);
    const f = Math.abs(k) < 1e-6 ? 1 : s / k;
    return { x: l2.p.x + (l1.n.x + l2.n.x) * f, y: l2.p.y + (l1.n.y + l2.n.y) * f };
  };

  const left = [add(legs[0].p, legs[0].n, hw)];
  for (let i = 0; i < legs.length - 1; i++) left.push(mitre(i, hw));
  left.push(add(shaftEnd, last.n, hw));

  const head = [add(shaftEnd, last.n, spec.headWidth / 2), tip, add(shaftEnd, last.n, -spec.headWidth / 2)];

  const right = [add(shaftEnd, last.n, -hw)];
  for (let i = legs.length - 2; i >= 0; i--) right.push(mitre(i, -hw));
  right.push(add(legs[0].p, legs[0].n, -hw));

  return [...left, ...head, ...right];
}

function outlineToGeometry(outline, y) {
  const shape = new THREE.Shape();

  shape.moveTo(outline[0].x, outline[0].y);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i].x, outline[i].y);
  shape.closePath();

  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);

  return geo;
}

function parseUci(uci) {
  if (uci && typeof uci === 'object') return uci.from && uci.to ? { from: uci.from, to: uci.to } : null;
  if (typeof uci !== 'string' || uci.length < 4) return null;

  const from = uci.slice(0, 2), to = uci.slice(2, 4);

  return squareToWorld(from) && squareToWorld(to) ? { from, to } : null;
}

/** Chamfered frame slab with box-projected UVs, so wood grain tiles at the squares' density. */
function makeFrameGeometry() {
  const h = FRAME_HALF, bevel = FRAME_BEVEL;
  const depth = FRAME_DEPTH - 2 * bevel;

  const shape = new THREE.Shape([
    new THREE.Vector2(-h, -h), new THREE.Vector2(h, -h), new THREE.Vector2(h, h), new THREE.Vector2(-h, h),
  ]);

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: 0, bevelSegments: 3, curveSegments: 1,
  });

  // box projection in shape space (z = extrusion axis) before we lay it flat
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const span = 2 * (h + bevel);
  const uv = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;

    if (nz >= nx && nz >= ny) {
      // mitred like a real frame: the grain runs along each side, meeting on the diagonals at the corners
      if (Math.abs(x) > Math.abs(y)) {
        u = (y + h + bevel) / span;
        v = (x + h + bevel) / span;
      } else {
        u = (x + h + bevel) / span;
        v = (y + h + bevel) / span;
      }
    }
    else if (nx >= ny) {
      u = (y + h + bevel) / span;
      v = (z + bevel) / span;
    }
    else {
      u = (x + h + bevel) / span;
      v = (z + bevel) / span;
    }

    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }

  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.rotateX(-Math.PI / 2);                       // extrusion axis -> +Y; local z range [-bevel, depth+bevel]
  geo.translate(0, FRAME_TOP - (depth + bevel), 0); // top face lands on FRAME_TOP

  return geo;
}

/** A hairline along each frame corner's diagonal, top face and bevel, in the frame's own space. */
function makeMitreGeometry() {
  const h = FRAME_HALF, b = FRAME_BEVEL, W = 0.0035, LIFT = 0.0008;
  const path = [[4.0, FRAME_TOP]];                       // [distance along one axis, height]

  for (let i = 0; i <= 3; i++) {                           // the top's edge, then the bevel's three segments
    const t = i / 3;
    path.push([h + b * Math.sin(t * Math.PI / 2), FRAME_TOP - b * (1 - Math.cos(t * Math.PI / 2))]);
  }

  const pos = [], idx = [];

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const px = -sz * W / Math.SQRT2, pz = sx * W / Math.SQRT2;   // across the diagonal
      const base = pos.length / 3;

      for (const [d, y] of path) {
        const lift = d > h ? LIFT * 1.5 : LIFT;
        pos.push(sx * d + px, y + lift, sz * d + pz, sx * d - px, y + lift, sz * d - pz);
      }

      for (let i = 0; i < path.length - 1; i++) {
        const a0 = base + i * 2;
        idx.push(a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);

  return geo;
}

/** The stringing: a flat square ring just above the frame top, UVs halved to the squares' grain density. */
function makeInlayGeometry() {
  const sq = (h) => [new THREE.Vector2(-h, -h), new THREE.Vector2(h, -h), new THREE.Vector2(h, h), new THREE.Vector2(-h, h)];

  const shape = new THREE.Shape(sq(INLAY_OUT));
  shape.holes.push(new THREE.Path(sq(INLAY_IN).reverse()));

  const geo = new THREE.ShapeGeometry(shape);
  const uv = geo.attributes.uv;

  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5, uv.getY(i) * 0.5);

  geo.rotateX(-Math.PI / 2);
  geo.translate(0, INLAY_Y, 0);

  return geo;
}

/** A square's own geometry looking at a seeded half-size window of the wood texture. */
function squareUvWindow(base, index, keep) {
  let a = (index * 2654435761 + 0x9e3779b9) >>> 0;

  const rnd = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const geo = base.clone();
  const uv = geo.attributes.uv;
  const ox = rnd() * 0.5, oy = rnd() * 0.5, flip = rnd() < 0.5;

  for (let k = 0; k < uv.count; k++) {
    let u = uv.getX(k), v = uv.getY(k);

    if (flip) {
      u = 1 - u;
      v = 1 - v;
    }

    uv.setXY(k, ox + u * 0.5, oy + v * 0.5);
  }

  uv.needsUpdate = true;
  keep.push(geo);

  return geo;
}

// aspect matches the strip plane (8 x 0.5 units = 16:1) so glyphs are not stretched
function makeGlyphCanvas(horizontal) {
  const c = document.createElement('canvas');
  c.width = horizontal ? 2048 : 128;
  c.height = horizontal ? 128 : 2048;
  return c;
}

/** Draw one strip's eight glyphs in style '2d' (bold, flat), '3d' (gilt cut-out) or 'bump' (blurred height). */
function drawGlyphs(canvas, glyphs, horizontal, flipped, style = '3d') {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;

  ctx.clearRect(0, 0, width, height);

  const slot = (horizontal ? width : height) / 8;
  const band = horizontal ? height : width;
  const big = style === '2d';
  const bump = style === 'bump';
  const fontPx = Math.round(Math.min(slot * (big ? 0.54 : 0.40), band * (big ? 0.86 : 0.70)));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  if (big) {
    ctx.font = `700 ${fontPx}px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif`;
    ctx.lineWidth = Math.max(2, fontPx * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.fillStyle = 'rgba(252,249,243,0.98)';
  } else {
    ctx.font = `600 ${fontPx}px "Newsreader", "Georgia", "Times New Roman", serif`;
    ctx.lineWidth = Math.max(1.5, fontPx * 0.05);
    ctx.strokeStyle = 'rgba(52,34,14,0.8)';
    ctx.fillStyle = '#ffffff';
  }

  if (bump) {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.filter = `blur(${GILT.blurPx}px)`;
  }

  for (let i = 0; i < 8; i++) {
    const cx = horizontal ? slot * (i + 0.5) : width / 2;
    const cy = horizontal ? height / 2 : slot * (i + 0.5);

    ctx.save();
    ctx.translate(cx, cy);
    if (flipped) ctx.rotate(Math.PI);
    if (!bump) ctx.strokeText(glyphs[i], 0, 0);
    ctx.fillText(glyphs[i], 0, 0);
    ctx.restore();
  }

  if (bump) ctx.filter = 'none';
}

/** Build the board, frame, coordinate strips and overlay layers inside `scene`; returns the board handle. */
export function createBoard(scene, matSet, settings = {}) {
  let mats = matSet;
  let disposed = false;
  let orientation = 'white';
  let viewMode = settings.viewMode === '2d' ? '2d' : '3d';
  let showCoords = settings.showCoordinates !== false;
  let labelsDirty = true;
  const L = k => LAYERS[viewMode][k];
  const spec = k => ARROW_SPECS[viewMode][k];

  // what the overlays show, so a view-mode switch can rebuild them at the new heights
  const cur = {
    selected: null, targets: [], captures: [], lastMove: null, check: null,
    highlights: [], arrows: [], preview: null, engine: null,
  };

  const arrowColors = { ...DEFAULT_ARROW_COLORS, ...(settings.arrowColors || {}) };
  const overlayColors = JSON.parse(JSON.stringify(DEFAULT_OVERLAY_COLORS));

  const group = new THREE.Group();
  group.name = 'board';
  scene.add(group);

  const squaresGroup = new THREE.Group();
  squaresGroup.name = 'squares';
  group.add(squaresGroup);

  const squareGeo = new THREE.BoxGeometry(1, SQ_H, 1);
  const squareGeos = [];
  const squareMeshes = new Map();

  for (const [i, sq] of SQUARES.entries()) {
    const w = squareToWorld(sq);
    const mesh = new THREE.Mesh(squareUvWindow(squareGeo, i, squareGeos), isDarkSquare(sq) ? mats.darkSquare : mats.lightSquare);

    mesh.position.set(w.x, -SQ_H / 2, w.z);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'square-' + sq;
    mesh.userData.square = sq;

    squaresGroup.add(mesh);
    squareMeshes.set(sq, mesh);
  }

  const frameGeo = makeFrameGeometry();
  const frame = new THREE.Mesh(frameGeo, mats.frame);
  frame.name = 'frame';
  frame.receiveShadow = true;
  frame.castShadow = true;      // onto the table, in the HDRI rooms
  group.add(frame);

  const mitreGeo = makeMitreGeometry();

  const mitreMat = new THREE.MeshBasicMaterial({
    color: '#160c05', transparent: true, opacity: 0.62, depthWrite: false, toneMapped: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });

  const mitres = new THREE.Mesh(mitreGeo, mitreMat);
  mitres.name = 'frame-mitres';
  frame.add(mitres);

  const inlayGeo = makeInlayGeometry();
  const inlay = new THREE.Mesh(inlayGeo, mats.lightSquare);
  inlay.name = 'inlay';
  inlay.receiveShadow = true;
  inlay.visible = viewMode === '3d';   // 2D keeps its plain border (and its frame is flattened over this height)
  group.add(inlay);

  const labelGroup = new THREE.Group();
  labelGroup.name = 'coordinates';
  group.add(labelGroup);

  const fileCanvas = makeGlyphCanvas(true);
  const rankCanvas = makeGlyphCanvas(false);
  const fileBumpCanvas = makeGlyphCanvas(true);
  const rankBumpCanvas = makeGlyphCanvas(false);
  const fileTex = new THREE.CanvasTexture(fileCanvas);
  const rankTex = new THREE.CanvasTexture(rankCanvas);
  const fileBump = new THREE.CanvasTexture(fileBumpCanvas);
  const rankBump = new THREE.CanvasTexture(rankBumpCanvas);

  for (const t of [fileTex, rankTex]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
  }

  for (const t of [fileBump, rankBump]) t.anisotropy = 8;

  const fileMat = new THREE.MeshBasicMaterial({ map: fileTex, transparent: true, depthWrite: false, toneMapped: false });
  const rankMat = new THREE.MeshBasicMaterial({ map: rankTex, transparent: true, depthWrite: false, toneMapped: false });

  const gilt = (map, bumpMap) => new THREE.MeshStandardMaterial({
    color: GILT.color, metalness: 1, roughness: GILT.roughness,
    map, bumpMap, bumpScale: GILT.bumpScale, transparent: true, depthWrite: false,
  });

  const fileGilt = gilt(fileTex, fileBump);
  const rankGilt = gilt(rankTex, rankBump);
  fileGilt.name = 'coordinates.files.gilt';
  rankGilt.name = 'coordinates.ranks.gilt';

  const fileGeo = new THREE.PlaneGeometry(8, LABEL_BAND);
  fileGeo.rotateX(-Math.PI / 2);
  const rankGeo = new THREE.PlaneGeometry(LABEL_BAND, 8);
  rankGeo.rotateX(-Math.PI / 2);

  const stripSpecs = [
    { geo: fileGeo, files: true, pos: [0, LABEL_Y, LABEL_OFFSET] },   // south (white's edge)
    { geo: fileGeo, files: true, pos: [0, LABEL_Y, -LABEL_OFFSET] },  // north
    { geo: rankGeo, files: false, pos: [-LABEL_OFFSET, LABEL_Y, 0] },  // west (a-file side)
    { geo: rankGeo, files: false, pos: [LABEL_OFFSET, LABEL_Y, 0] },   // east
  ];

  const strips = stripSpecs.map((s) => {
    const m = new THREE.Mesh(s.geo, s.files ? fileGilt : rankGilt);
    m.position.set(...s.pos);
    m.renderOrder = 1;
    m.userData.files = s.files;
    labelGroup.add(m);
    return m;
  });

  /** 2D shows all four strips flat; 3D shows gilt files nearest the seat and ranks on the player's left. */
  function applyStrips() {
    const flat = viewMode === '2d';
    const black = orientation === 'black';
    const shown = [!black, black, !black, black];

    strips.forEach((m, i) => {
      m.material = flat ? (m.userData.files ? fileMat : rankMat) : (m.userData.files ? fileGilt : rankGilt);
      m.visible = flat || shown[i];
    });
  }

  function redrawLabels() {
    const flipped = orientation === 'black';
    const ranks = ['8', '7', '6', '5', '4', '3', '2', '1'];   // canvas top = -Z = rank 8

    drawGlyphs(fileCanvas, FILES.split(''), true, flipped, viewMode);
    drawGlyphs(rankCanvas, ranks, false, flipped, viewMode);
    fileTex.needsUpdate = true;
    rankTex.needsUpdate = true;

    if (viewMode === '3d') {
      drawGlyphs(fileBumpCanvas, FILES.split(''), true, flipped, 'bump');
      drawGlyphs(rankBumpCanvas, ranks, false, flipped, 'bump');
      fileBump.needsUpdate = true;
      rankBump.needsUpdate = true;
    }

    labelsDirty = false;
  }

  function syncLabels() {
    labelGroup.visible = showCoords;
    applyStrips();
    if (showCoords && labelsDirty) redrawLabels();
  }

  syncLabels();

  // the page's web font may land after first paint
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (!disposed) {
        labelsDirty = true;
        syncLabels();
        requestRedraw('content');
      }
    }).catch(() => {});
  }

  const overlays = new THREE.Group();
  overlays.name = 'overlays';
  group.add(overlays);

  const flatMat = (color, opacity, extra = {}) => new THREE.MeshBasicMaterial({
    color, opacity, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, ...extra,
  });

  const planeGeo = new THREE.PlaneGeometry(1, 1);
  planeGeo.rotateX(-Math.PI / 2);

  // legal-move marks are textured quads (drawMarks): a 0.34-wide dot, a ring out to 0.46 of the square
  const dotGeo = new THREE.PlaneGeometry(0.34, 0.34);
  dotGeo.rotateX(-Math.PI / 2);
  const ringGeo = new THREE.PlaneGeometry(0.96, 0.96);
  ringGeo.rotateX(-Math.PI / 2);

  // materials whose depthTest follows the view mode
  const layeredMats = [];

  const trackLayer = (mat, key) => {
    mat.depthTest = L(key).depthTest;
    layeredMats.push({ mat, key });
    return mat;
  };

  const placeFlat = (mesh, square, key) => {
    const w = squareToWorld(square);

    if (!w) {
      mesh.visible = false;
      return false;
    }

    const layer = L(key);
    mesh.position.set(w.x, layer.y, w.z);
    mesh.renderOrder = layer.ro;
    mesh.visible = true;

    return true;
  };

  const selectedMat = flatMat(overlayColors.selected.color, overlayColors.selected.opacity);
  const selectedMesh = new THREE.Mesh(planeGeo, selectedMat);
  selectedMesh.name = 'selected';
  selectedMesh.visible = false;
  overlays.add(selectedMesh);

  const lastMoveMat = flatMat(overlayColors.lastMove.color, overlayColors.lastMove.opacity);
  const lastMoveMeshes = [new THREE.Mesh(planeGeo, lastMoveMat), new THREE.Mesh(planeGeo, lastMoveMat)];

  lastMoveMeshes.forEach((m, i) => {
    m.name = 'lastMove-' + i;
    m.visible = false;
    overlays.add(m);
  });

  const checkCanvas = document.createElement('canvas');
  checkCanvas.width = checkCanvas.height = 256;
  const checkTex = new THREE.CanvasTexture(checkCanvas);
  checkTex.colorSpace = THREE.SRGBColorSpace;

  function drawCheckGlow() {
    const c = new THREE.Color(overlayColors.check.color);
    const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
    const a = overlayColors.check.opacity;
    const ctx = checkCanvas.getContext('2d');

    ctx.clearRect(0, 0, 256, 256);

    const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(0.3, `rgba(${rgb},${a * 0.7})`);
    g.addColorStop(0.65, `rgba(${rgb},${a * 0.22})`);
    g.addColorStop(1, `rgba(${rgb},0)`);

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    checkTex.needsUpdate = true;
  }

  drawCheckGlow();

  const checkMat = new THREE.MeshBasicMaterial({ map: checkTex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const checkMesh = new THREE.Mesh(planeGeo, checkMat);
  checkMesh.name = 'check';
  checkMesh.visible = false;
  checkMesh.scale.set(1.15, 1, 1.15);
  overlays.add(checkMesh);

  // two-tone marks: a dark outline for light squares, a pale core for dark ones
  const DOT_PX = 128;
  const dotCanvas = document.createElement('canvas');
  const ringCanvas = document.createElement('canvas');
  dotCanvas.width = dotCanvas.height = ringCanvas.width = ringCanvas.height = DOT_PX;
  const dotTex = new THREE.CanvasTexture(dotCanvas);
  const ringTex = new THREE.CanvasTexture(ringCanvas);

  for (const t of [dotTex, ringTex]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
  }

  function drawMarks() {
    const ink = new THREE.Color(overlayColors.dots.color);
    const core = ink.clone().lerp(new THREE.Color('#f6f4ea'), 0.9);
    const css = (c) => `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
    const S = DOT_PX, c = S / 2;
    const dctx = dotCanvas.getContext('2d'), rctx = ringCanvas.getContext('2d');

    for (const ctx of [dctx, rctx]) if (ctx && ctx.clearRect) ctx.clearRect(0, 0, S, S);

    if (dctx && typeof dctx.arc === 'function') {
      // a dark disc, then the light core
      dctx.fillStyle = css(ink);
      dctx.beginPath();
      dctx.arc(c, c, S * 0.47, 0, Math.PI * 2);
      dctx.fill();

      dctx.fillStyle = css(core);
      dctx.beginPath();
      dctx.arc(c, c, S * 0.34, 0, Math.PI * 2);
      dctx.fill();
    }

    if (rctx && typeof rctx.arc === 'function') {
      // a dark band 0.35..0.46 of the square, a light band 0.37..0.44 inside it (quad units / 0.96)
      const k = S / 0.96;

      rctx.beginPath();
      rctx.arc(c, c, 0.405 * k, 0, Math.PI * 2);

      rctx.lineWidth = 0.11 * k;
      rctx.strokeStyle = css(ink);
      rctx.stroke();

      rctx.lineWidth = 0.07 * k;
      rctx.strokeStyle = css(core);
      rctx.stroke();
    }

    dotTex.needsUpdate = true;
    ringTex.needsUpdate = true;
  }

  drawMarks();

  const dotsMat = trackLayer(flatMat('#ffffff', overlayColors.dots.opacity, { map: dotTex }), 'dots');
  const ringMat = trackLayer(flatMat('#ffffff', overlayColors.dots.opacity, { map: ringTex }), 'rings');
  const dotsGroup = new THREE.Group();
  dotsGroup.name = 'legal';
  overlays.add(dotsGroup);

  // material per colour name, recoloured in place by setArrowColors
  const highlightMats = new Map();
  const highlightsGroup = new THREE.Group();
  highlightsGroup.name = 'highlights';
  overlays.add(highlightsGroup);

  const arrowMats = new Map(); // key 'user:green' | 'preview:green' | 'engine'
  const arrowsGroup = new THREE.Group();
  arrowsGroup.name = 'arrows';
  overlays.add(arrowsGroup);
  const previewGroup = new THREE.Group();
  previewGroup.name = 'previewArrow';
  overlays.add(previewGroup);
  const engineGroup = new THREE.Group();
  engineGroup.name = 'engineArrow';
  overlays.add(engineGroup);

  function resolveColor(name) {
    if (typeof name === 'string' && arrowColors[name]) return arrowColors[name];
    if (typeof name === 'string' && HEX_RE.test(name)) return name;
    return arrowColors.green || DEFAULT_ARROW_COLORS.green;
  }

  function colorKey(name) {
    return (typeof name === 'string' && (arrowColors[name] || HEX_RE.test(name))) ? name : 'green';
  }

  function highlightMat(name) {
    const key = colorKey(name);
    let m = highlightMats.get(key);

    if (!m) {
      m = flatMat(resolveColor(key), 0.5);
      highlightMats.set(key, m);
    }

    return m;
  }

  function arrowMat(kind, name) {
    const key = kind === 'engine' ? 'engine' : `${kind}:${colorKey(name)}`;
    let m = arrowMats.get(key);

    if (!m) {
      if (kind === 'engine') m = flatMat(overlayColors.engine.color, overlayColors.engine.opacity);
      else m = flatMat(resolveColor(name), spec(kind).opacity);

      arrowMats.set(key, m);
      trackLayer(m, kind === 'user' ? 'arrows' : kind);
    }

    m.opacity = kind === 'engine' ? overlayColors.engine.opacity : spec(kind).opacity;

    return m;
  }

  function clearGroup(g, disposeGeo) {
    for (let i = g.children.length - 1; i >= 0; i--) {
      const c = g.children[i];
      g.remove(c);
      if (disposeGeo && c.geometry) c.geometry.dispose();
    }
  }

  function addArrowMesh(target, arrow, kind) {
    if (!arrow) return null;

    const layer = L(kind === 'user' ? 'arrows' : kind);
    const from = arrow.from, to = arrow.to;
    const knight = typeof arrow.knight === 'boolean' ? arrow.knight : isKnightJump(from, to);
    const outline = arrowOutline(from, to, knight, spec(kind));

    if (!outline) return null;

    const mesh = new THREE.Mesh(outlineToGeometry(outline, layer.y), arrowMat(kind, arrow.color));
    mesh.renderOrder = layer.ro;
    mesh.name = `${kind}-arrow-${from}${to}`;
    mesh.userData.arrow = { from, to, color: arrow.color, knight, source: arrow.source || kind };
    target.add(mesh);

    return mesh;
  }

  const noteEl = document.createElement('div');
  noteEl.className = 'note3d';
  const noteLabel = new CSS2DObject(noteEl);
  noteLabel.name = 'note3d';
  noteLabel.center.set(0.5, 1); // anchor at the card's bottom edge so it floats above the point
  noteLabel.visible = false;
  group.add(noteLabel);
  let noteState = { square: null, text: '' };

  function placeNote() {
    if (!noteState.text) {
      noteLabel.visible = false;
      return;
    }

    const y = NOTE_Y[viewMode];
    const w = noteState.square ? squareToWorld(noteState.square) : null;

    if (w) noteLabel.position.set(w.x, y, w.z);
    else noteLabel.position.set(0, y * 0.85, orientation === 'white' ? -FRAME_HALF : FRAME_HALF); // far edge

    noteLabel.visible = true;
  }

  // each applier rebuilds one overlay from `cur` at the current view mode's layer

  function applySelected() {
    if (!cur.selected) {
      selectedMesh.visible = false;
      return;
    }

    placeFlat(selectedMesh, cur.selected, 'selected');
  }

  function applyTargets() {
    clearGroup(dotsGroup, false);

    const captures = new Set(cur.captures);

    for (const sq of cur.targets) {
      const capture = captures.has(sq);
      const m = new THREE.Mesh(capture ? ringGeo : dotGeo, capture ? ringMat : dotsMat);
      m.name = (capture ? 'capture-' : 'target-') + sq;
      if (placeFlat(m, sq, capture ? 'rings' : 'dots')) dotsGroup.add(m);
    }
  }

  function applyLastMove() {
    if (!cur.lastMove) {
      lastMoveMeshes[0].visible = lastMoveMeshes[1].visible = false;
      return;
    }

    placeFlat(lastMoveMeshes[0], cur.lastMove.from, 'lastMove');
    placeFlat(lastMoveMeshes[1], cur.lastMove.to, 'lastMove');
  }

  function applyCheck() {
    if (!cur.check) {
      checkMesh.visible = false;
      return;
    }

    placeFlat(checkMesh, cur.check, 'check');
  }

  function applyHighlights() {
    clearGroup(highlightsGroup, false);

    for (const h of cur.highlights) {
      if (!h || !h.square) continue;

      const m = new THREE.Mesh(planeGeo, highlightMat(h.color));
      m.name = 'highlight-' + h.square;
      m.userData.highlight = { square: h.square, color: h.color };
      if (placeFlat(m, h.square, 'highlight')) highlightsGroup.add(m);
    }
  }

  function applyArrows() {
    clearGroup(arrowsGroup, true);
    for (const a of cur.arrows) addArrowMesh(arrowsGroup, a, 'user');
  }

  function applyPreview() {
    clearGroup(previewGroup, true);
    if (cur.preview) addArrowMesh(previewGroup, cur.preview, 'preview');
  }

  function applyEngine() {
    clearGroup(engineGroup, true);
    if (cur.engine) addArrowMesh(engineGroup, { ...cur.engine, source: 'engine' }, 'engine');
  }

  // the flattened 2D frame top still sits above LABEL_Y, so the strips lift by the same amount
  const LABEL_LIFT_2D = FRAME_TOP * (FRAME_FLATTEN_2D - 1);

  if (viewMode === '2d') {
    frame.scale.y = FRAME_FLATTEN_2D;
    labelGroup.position.y = LABEL_LIFT_2D;
  }

  const board = {
    group,
    squaresGroup,
    overlays,
    labelGroup,
    frame,
    inlay,
    squareMeshes,
    arrowColors,
    get orientation() { return orientation; },
    get viewMode() { return viewMode; },

    /** Square centre as a fresh Vector3 (y = 0); null for anything that is not a square. */
    worldFor(square) {
      const w = squareToWorld(square);
      return w ? new THREE.Vector3(w.x, 0, w.z) : null;
    },

    /** Inverse of worldFor for any point: square under (x, z), or null off the board. */
    squareAtPoint(point) {
      if (!point) return null;
      return worldToSquare(point.x, point.z);
    },

    /** Show / hide the file & rank strips on the frame. */
    setCoordinates(on) {
      showCoords = !!on;
      syncLabels();
    },

    /** Orient the coordinate glyphs for the seated side: which 3D strips show, and the edge note anchor. */
    setOrientation(o) {
      const next = o === 'black' ? 'black' : 'white';

      if (next === orientation) return;

      orientation = next;
      labelsDirty = true;
      syncLabels();
      placeNote();
    },

    /** Tint the picked-up / clicked square (null clears). */
    setSelected(square) {
      cur.selected = square || null;
      applySelected();
    },

    /** Dots on quiet targets, rings on capture targets. */
    setLegalTargets(squares = [], captureSquares = []) {
      cur.targets = Array.isArray(squares) ? squares.slice() : [];
      cur.captures = Array.isArray(captureSquares) ? captureSquares.slice() : [];
      applyTargets();
    },

    /** Warm tint on the two squares of the last move; either null hides both. */
    setLastMove(from, to) {
      cur.lastMove = from && to ? { from, to } : null;
      applyLastMove();
    },

    /** Red radial glow under the king in check (null clears). */
    setCheck(square) {
      cur.check = square || null;
      applyCheck();
    },

    /** Replace all square highlights: [{square, color}]. */
    setHighlights(list = []) {
      cur.highlights = Array.isArray(list) ? list.slice() : [];
      applyHighlights();
    },

    /** Rebuild every user / ai arrow: [{from, to, color, knight?}]. */
    setArrows(list = []) {
      cur.arrows = Array.isArray(list) ? list.slice() : [];
      applyArrows();
    },

    /** One translucent arrow that follows a right-drag; null clears. */
    setPreviewArrow(arrow) {
      cur.preview = arrow && arrow.from && arrow.to && arrow.from !== arrow.to ? arrow : null;
      applyPreview();
    },

    /** Thin accent-coloured arrow for the engine's best move ('g1f3', 'e7e8q' or {from,to}); null clears. */
    setEngineArrow(uci) {
      cur.engine = parseUci(uci);
      applyEngine();
    },

    /** Switch '2d' / '3d'; overlays are rebuilt in place so they survive the switch. */
    setViewMode(m) {
      const next = m === '2d' ? '2d' : '3d';

      if (next === viewMode) return viewMode;

      viewMode = next;

      const flat = viewMode === '2d';
      frame.scale.y = flat ? FRAME_FLATTEN_2D : 1;
      labelGroup.position.y = flat ? LABEL_LIFT_2D : 0;
      inlay.visible = !flat;

      for (const { mat, key } of layeredMats) mat.depthTest = L(key).depthTest;

      labelsDirty = true;
      syncLabels();

      applySelected();
      applyTargets();
      applyLastMove();
      applyCheck();
      applyHighlights();
      applyArrows();
      applyPreview();
      applyEngine();
      placeNote();

      return viewMode;
    },

    /** Floating note card above a square, or above the far board edge when square is null; '' hides. */
    setNoteLabel(square, text) {
      const t = text == null ? '' : String(text);
      noteState = { square: square || null, text: t };
      noteEl.textContent = t;
      placeNote();
    },

    /** Swap the square / frame materials in place (theme change). */
    setMaterials(next) {
      mats = next;
      for (const [sq, mesh] of squareMeshes) mesh.material = isDarkSquare(sq) ? mats.darkSquare : mats.lightSquare;
      frame.material = mats.frame;
      inlay.material = mats.lightSquare;
    },

    /** Lighting "off" for the gilt coordinates (flat gold, not black metal without an environment). */
    setUnlit(on) {
      setMaterialUnlit(fileGilt, !!on);
      setMaterialUnlit(rankGilt, !!on);
    },

    /** Recolour the four annotation colours (arrows + highlights) without rebuilding meshes. */
    setArrowColors(colors = {}) {
      Object.assign(arrowColors, colors || {});

      for (const [key, m] of highlightMats) m.color.set(resolveColor(key));

      for (const [key, m] of arrowMats) {
        if (key === 'engine') continue;
        m.color.set(resolveColor(key.split(':')[1]));
      }
    },

    /** Retune overlay tints: { selected|dots|lastMove|check|engine: { color?, opacity? } }. */
    setOverlayColors(partial = {}) {
      for (const k of Object.keys(partial || {})) {
        if (!overlayColors[k]) continue;
        Object.assign(overlayColors[k], partial[k] || {});
      }

      selectedMat.color.set(overlayColors.selected.color);
      selectedMat.opacity = overlayColors.selected.opacity;

      dotsMat.opacity = overlayColors.dots.opacity;
      ringMat.opacity = overlayColors.dots.opacity;
      if (partial.dots) drawMarks();

      lastMoveMat.color.set(overlayColors.lastMove.color);
      lastMoveMat.opacity = overlayColors.lastMove.opacity;

      const eng = arrowMats.get('engine');

      if (eng) {
        eng.color.set(overlayColors.engine.color);
        eng.opacity = overlayColors.engine.opacity;
      }

      if (partial.check) drawCheckGlow();
    },

    /** Remove everything from the scene and free what this module created. */
    dispose() {
      disposed = true;
      scene.remove(group);

      clearGroup(arrowsGroup, true);
      clearGroup(previewGroup, true);
      clearGroup(engineGroup, true);
      clearGroup(dotsGroup, false);
      clearGroup(highlightsGroup, false);

      for (const g of [squareGeo, ...squareGeos, frameGeo, mitreGeo, inlayGeo, fileGeo, rankGeo, planeGeo, dotGeo, ringGeo]) g.dispose();
      for (const t of [fileTex, rankTex, fileBump, rankBump, checkTex, dotTex, ringTex]) t.dispose();
      for (const m of [fileMat, rankMat, fileGilt, rankGilt, mitreMat, selectedMat, lastMoveMat, checkMat, dotsMat, ringMat]) m.dispose();
      for (const m of highlightMats.values()) m.dispose();
      for (const m of arrowMats.values()) m.dispose();

      highlightMats.clear();
      arrowMats.clear();
      squareMeshes.clear();

      if (noteEl.parentNode) noteEl.parentNode.removeChild(noteEl);
    },
  };

  // every setter changes what is drawn, so each asks for a full frame
  for (const name of ['setCoordinates', 'setOrientation', 'setSelected', 'setLegalTargets', 'setLastMove', 'setCheck',
    'setHighlights', 'setArrows', 'setPreviewArrow', 'setEngineArrow', 'setViewMode', 'setNoteLabel', 'setMaterials',
    'setUnlit', 'setArrowColors', 'setOverlayColors', 'dispose']) {
    const fn = board[name];

    board[name] = function (...args) {
      const out = fn.apply(this, args);
      requestRedraw('content');
      return out;
    };
  }

  return board;
}
