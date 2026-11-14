// three/pieces.js -- piece sets: procedural 'staunton' (lathe profiles + extruded knight head),
// 'minimal' (cylinders with role caps), 'glyph' (flat 2D token: disc + contrasting bezel + cburnett
// glyph with a contrast halo), and user glTF sets.
// Owns: BUILTIN_SETS, listSets, createPiece, registerGltfSet, applyMaterials per CONTRACT.md.
//
// 2026-09-18 rework (addendum v1). What changed and why:
//   * The Staunton set was squat and faceted. Profiles are now generated from cubic Beziers and arcs
//     (60-100 points each instead of ~20) and the lathe runs 64 segments, so the silhouettes are smooth
//     and the turned mouldings are real curves. The height ladder was re-cut to Staunton proportions
//     (see HEIGHTS) -- taller relative to the same <= 0.8 footprint, which is what "squat" was.
//   * Silhouettes were made genuinely distinct: king tallest with a DOUBLE cross (reads as a cross from
//     the seat AND as a plus from straight above) over an orb and a domed crown; queen with a nine-point
//     coronet around a cupped rim; bishop with a swelling mitre, a slit and a ball finial; rook with a
//     real hollow top (a revolved ring, not a disc) and four crenellations; knight a carved head with a
//     notched mane, cheeks and a deep bevel instead of a slab; pawn a ball on a collared neck.
//   * Every piece carries a soft contact-shadow decal (matSet.contactShadow) so a light piece never
//     merges into a light square. See materials.js for the other half of the contrast aid.
//   * 'glyph' is now a proper 2D token (bezel + halo'd glyph) because 2D mode uses it: BUILTIN_SETS_2D.
//
// Added beyond the contract (all exported):
//   ROLES, HEIGHTS                      : role list and the height ladder
//   PROFILES, KNIGHT_BASE_PROFILE,
//   ROOK_CROWN_PROFILE, GLYPH_DISC_PROFILE,
//   GLYPH_BEZEL_PROFILE                 : lathe profiles as plain [radius, height] arrays (node-safe, tested).
//                                         PROFILES / KNIGHT_BASE_PROFILE / GLYPH_DISC_PROFILE start on the
//                                         axis and close on the axis. ROOK_CROWN_PROFILE and
//                                         GLYPH_BEZEL_PROFILE are CLOSED LOOPS (first point == last) that
//                                         revolve into a hollow ring -- they never touch the axis.
//   KNIGHT_HEAD_SILHOUETTE              : the horse-head outline as [x, y] points (x = forward)
//   CONTACT_RADIUS                      : radius of the contact-shadow decal per role
//   BUILTIN_SETS_2D                     : the sets that read from straight above (settings.pieceSet2d)
//   isFlatSet(id) -> bool               : true for token sets that lie flat (currently 'glyph')
//   unregisterSet(id)                   : drop a registered glTF set (disposes its geometry)
//   setKind(id) -> 'builtin'|'gltf'|null, isDirectional(id) -> bool (layer rotates by colour when true;
//                                         false for 'glyph', whose tokens read upright from White's seat)
//   getGlyphTexture(glyphId, size, opts) -> Promise<THREE.CanvasTexture>   (cached per key; rasterised
//                                         from the inline SVG. opts { halo, haloWidth, viewBox } draws a
//                                         contrast halo around the art. A FAILED load is not cached: the
//                                         next card of that glyph retries.)
//   disposePieceCaches()                : free the shared geometry / glyph texture caches (layer.dispose calls it)
//   registerGltfSet mapping values may be a node name (used for both colours) OR { white, black } node names.
//   registerGltfSet `scale` multiplies the automatic king-height normalisation (default 1).
//
// Conventions: every piece is a THREE.Group with userData { role, color, square: null, set }, origin at the
// base centre on y = 0, knights/bishops/kings authored facing +Z (the layer rotates by colour). Geometries are
// shared through a cache (never dispose a piece's geometry directly; use disposePieceCaches()).
// Mesh userData flags other modules should know about:
//   keepMaterial   -- applyMaterials() must not overwrite this mesh's material
//   ownFinish      -- a modelled set's own baked material: the wood theme's look. applyMaterials() swaps it for
//                     the theme's finish over the same baked detail in metal and glass (matSet.modeledPiece)
//                     and puts the very same material back in wood
//   accent         -- an inset/bezel; applyMaterials() points it at matSet.white/blackAccent
//   contactShadow  -- the decal under the piece; applyMaterials() points it at matSet.contactShadow.
//                     It pins ITSELF to the board plane in onBeforeRender, so a lifted piece does not
//                     carry its shadow up. `pieceObj.userData.contactShadow` is the mesh, if a caller
//                     wants to hide it.
//   glyphCard      -- the 2D token's glyph quad (own MeshBasicMaterial, never lit)
//   standIn        -- a modelled piece's low-detail stand-in (see standInOf): hidden, never picked; the view shows it
//                     only while it draws the shadow map and the edge-light mask, in the full mesh's place

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glyphId, glyphDataUrl } from './glyphs.js';
import { MODELED_SETS, modeledSet, loadSetBytes, loadProxyBytes } from './modeledSets.js';
import { getDracoLoader } from './draco.js';
import { setMaterialUnlit } from './materials.js';
import { requestRedraw } from './redraw.js';

/** Piece roles in the contract vocabulary. */
export const ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

/**
 * Target heights per role (world units; one square = 1).
 * Staunton proportions: relative to the king these are 1.00 / .864 / .746 / .678 / .593 / .492, which is
 * a real tournament set (3.75" king on a 2.25" square). The v0 ladder topped out at 1.05 with wide bases,
 * which is what read as "squat". Footprint stays inside the contract's 0.8.
 */
export const HEIGHTS = { pawn: 0.58, knight: 0.80, bishop: 0.88, rook: 0.70, queen: 1.02, king: 1.18 };

/** The built-in sets, in menu order. */
export const BUILTIN_SETS = [
  { id: 'staunton', name: 'Staunton' },
  { id: 'minimal', name: 'Minimal' },
  { id: 'glyph', name: 'Flat glyph' },
];

/** The sets that read correctly from straight above -- what settings.pieceSet2d may be. */
export const BUILTIN_SETS_2D = [
  { id: 'glyph', name: 'Flat glyph' },
];

/** True for a set whose pieces are flat tokens lying on the board (no 3D silhouette). */
export function isFlatSet(id) {
  return BUILTIN_SETS_2D.some((s) => s.id === id);
}

const LATHE_SEGMENTS = 64;      // was 48; the stepping was visible on the big pieces
const MAX_PIECE_RADIUS = 0.4;   // contract: footprint <= 0.8 units

/** Radius of the soft contact-shadow decal under each role (world units). */
export const CONTACT_RADIUS = {
  pawn: 0.300, knight: 0.330, bishop: 0.325, rook: 0.340, queen: 0.370, king: 0.392,
};
const CONTACT_Y = 0.0045;
const GLYPH_CONTACT_RADIUS = 0.396;

// ---------------------------------------------------------------------------------------------
// Profile construction. Plain [radius, height] pairs, bottom to top. A repeated point makes a sharp
// crease (LatheGeometry gives a zero-length segment a zero normal, so the neighbours keep their own).

const round = (v) => Math.round(v * 1e4) / 1e4;
const P = (r, y) => [round(Math.max(0, r)), round(y)];

/** Cubic Bezier in the (radius, height) plane. Returns n points EXCLUDING t = 0. */
function bez(p0, c0, c1, p1, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push(P(a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0], a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]));
  }
  return out;
}

/** Tiny fluent builder so a profile reads like the turner's pass it represents. */
function turn() {
  const pts = [];
  const api = {
    at: () => pts[pts.length - 1],
    move(r, y) { pts.push(P(r, y)); return api; },
    /** Repeat the last point: a hard crease (the two sides keep their own normals). */
    crease() { pts.push(api.at().slice()); return api; },
    /** Straight run to (r, y) in n steps. */
    line(r, y, n = 1) {
      const [r0, y0] = api.at();
      for (let i = 1; i <= n; i++) { const t = i / n; pts.push(P(r0 + (r - r0) * t, y0 + (y - y0) * t)); }
      return api;
    },
    /** Cubic curve from the current point through two controls to (r, y). */
    curve(c0, c1, p1, n) { pts.push(...bez(api.at(), c0, c1, p1, n)); return api; },
    /** Circular arc centred on the AXIS at height cy, radius rad, angles in degrees (excludes a0). */
    arc(cy, rad, a0, a1, n) {
      for (let i = 1; i <= n; i++) {
        const a = (a0 + (a1 - a0) * (i / n)) * Math.PI / 180;
        pts.push(P(rad * Math.cos(a), cy + rad * Math.sin(a)));
      }
      return api;
    },
    done: () => pts,
  };
  return api;
}

/** Where an axis-centred ball of radius `rad` at height `cy` meets its stem at angle a0 (degrees). */
function ballStart(cy, rad, a0) {
  const a = a0 * Math.PI / 180;
  return [rad * Math.cos(a), cy + rad * Math.sin(a)];
}

/**
 * A classic turned foot: flat underside, a slightly convex outer wall, then an ogee up to the stem.
 * @param {ReturnType<turn>} b   builder positioned at the origin
 */
function foot(b, rBase, rStem, h) {
  return b
    .line(rBase * 0.42, 0).line(rBase * 0.78, 0).line(rBase, 0).crease()
    .curve([rBase, h * 0.16], [round(rBase * 0.998), h * 0.27], [round(rBase * 0.972), h * 0.37], 5)
    .curve([round(rBase * 0.925), h * 0.52], [round(rStem * 1.36), h * 0.60], [round(rStem * 1.16), h * 0.80], 9)
    .curve([round(rStem * 1.07), h * 0.90], [round(rStem * 1.01), h * 0.96], [rStem, h], 4);
}

// --- pawn: foot -> slim concave neck -> collar -> ball. Top 0.58. -------------------------------
function pawnProfile() {
  const b = turn().move(0, 0);
  foot(b, 0.215, 0.132, 0.100);
  b.curve([0.112, 0.155], [0.079, 0.205], [0.0685, 0.285], 12)     // neck
   .crease()
   .curve([0.086, 0.300], [0.118, 0.306], [0.1205, 0.328], 7)      // collar out
   .curve([0.1225, 0.350], [0.092, 0.356], [0.0665, 0.372], 7);    // collar in
  const s = ballStart(0.475, 0.105, -55);
  b.curve([0.0615, 0.379], [0.0600, 0.385], [round(s[0]), round(s[1])], 3)
   .arc(0.475, 0.105, -55, 90, 18);                                // ball, top 0.580
  return b.done();
}

// --- rook: foot -> straight shaft -> collar -> flared crown, flat cup floor at 0.60. ------------
// The hollow top and the four crenellations are separate geometry (ROOK_CROWN_PROFILE + merlons).
const ROOK_CUP_Y = 0.600;
const ROOK_CROWN_OUTER = 0.2265;
const ROOK_CROWN_INNER = 0.1850;
const ROOK_BAND_TOP = 0.655;

function rookProfile() {
  const b = turn().move(0, 0);
  foot(b, 0.245, 0.166, 0.118);
  b.curve([0.1585, 0.190], [0.1525, 0.300], [0.1525, 0.400], 12)   // shaft, barely concave
   .curve([0.1535, 0.440], [0.1565, 0.470], [0.1600, 0.495], 6)
   .crease()
   .curve([0.1780, 0.505], [0.1960, 0.512], [0.2000, 0.527], 6)    // collar
   .curve([0.2020, 0.540], [0.1970, 0.548], [0.1900, 0.556], 5)
   .crease()
   .curve([0.2060, 0.566], [0.2220, 0.574], [ROOK_CROWN_OUTER, 0.590], 7)   // crown flare
   .line(ROOK_CROWN_OUTER, ROOK_CUP_Y, 2)
   .crease()
   .line(ROOK_CROWN_INNER, ROOK_CUP_Y, 3)                          // the cup floor you see from above
   .line(0, ROOK_CUP_Y, 3);
  return b.done();
}

/**
 * The rook's crown: a CLOSED cross-section (first point == last) revolved into a real hollow ring, so
 * the top of the rook is open, not a disc with bumps. Sits between the cup floor and the merlons.
 */
export const ROOK_CROWN_PROFILE = [
  P(ROOK_CROWN_OUTER, ROOK_CUP_Y),
  P(ROOK_CROWN_OUTER, ROOK_BAND_TOP - 0.014),
  P(ROOK_CROWN_OUTER - 0.003, ROOK_BAND_TOP - 0.005),
  P(ROOK_CROWN_OUTER - 0.010, ROOK_BAND_TOP),
  P(ROOK_CROWN_INNER + 0.007, ROOK_BAND_TOP),
  P(ROOK_CROWN_INNER + 0.001, ROOK_BAND_TOP - 0.005),
  P(ROOK_CROWN_INNER, ROOK_BAND_TOP - 0.013),
  P(ROOK_CROWN_INNER, ROOK_CUP_Y),
  P(ROOK_CROWN_OUTER, ROOK_CUP_Y),
];

// --- bishop: foot -> slim neck -> collar -> swelling mitre -> ball finial. Top 0.88. ------------
function bishopProfile() {
  const b = turn().move(0, 0);
  foot(b, 0.235, 0.156, 0.112);
  b.curve([0.126, 0.175], [0.098, 0.245], [0.0885, 0.330], 13)     // neck
   .crease()
   .curve([0.110, 0.343], [0.134, 0.348], [0.1360, 0.368], 7)      // collar out
   .curve([0.138, 0.388], [0.114, 0.393], [0.0965, 0.408], 7)      // collar in
   .crease()
   .curve([0.118, 0.425], [0.1455, 0.470], [0.1495, 0.545], 13)    // mitre swell
   .curve([0.1495, 0.600], [0.1420, 0.665], [0.1180, 0.712], 13)
   .curve([0.0980, 0.745], [0.0700, 0.762], [0.0460, 0.770], 10)
   .crease();
  const s = ballStart(0.828, 0.052, -60);
  b.curve([0.036, 0.7745], [0.028, 0.778], [round(s[0]), round(s[1])], 4)
   .arc(0.828, 0.052, -60, 90, 14);                                // finial, top 0.880
  return b.done();
}

// --- queen: foot -> long neck -> collar -> flaring bowl -> cupped rim -> finial. Top 1.02. ------
const QUEEN_RIM_Y = 0.838;
const QUEEN_CORONET_R = 0.176;

function queenProfile() {
  const b = turn().move(0, 0);
  foot(b, 0.275, 0.1835, 0.133);
  b.curve([0.148, 0.220], [0.116, 0.340], [0.1045, 0.465], 15)     // neck
   .crease()
   .curve([0.128, 0.482], [0.1545, 0.490], [0.1570, 0.514], 8)     // collar out
   .curve([0.159, 0.537], [0.132, 0.543], [0.1125, 0.560], 8)      // collar in
   .crease()
   .curve([0.132, 0.596], [0.166, 0.660], [0.1805, 0.742], 15)     // bowl
   .curve([0.187, 0.775], [0.194, 0.800], [0.1960, 0.822], 8)
   .crease()
   .line(0.199, QUEEN_RIM_Y, 2)
   .crease()
   .line(0.150, QUEEN_RIM_Y + 0.004, 3)                            // the cupped inner shelf
   .curve([0.110, 0.850], [0.075, 0.852], [0.0585, 0.862], 7)
   .curve([0.052, 0.874], [0.0495, 0.888], [0.0480, 0.903], 6)
   .crease();
  const s = ballStart(0.9615, 0.0585, -50);
  b.curve([0.043, 0.909], [0.0390, 0.913], [round(s[0]), round(s[1])], 3)
   .arc(0.9615, 0.0585, -50, 90, 16);                              // finial, top 1.020
  return b.done();
}

// --- king: foot -> long neck -> collar -> bowl -> crown rim -> dome. Orb + double cross on top. --
const KING_DOME_TOP = 1.012;

function kingProfile() {
  const b = turn().move(0, 0);
  foot(b, 0.290, 0.1945, 0.141);
  b.curve([0.157, 0.245], [0.124, 0.385], [0.1115, 0.520], 16)     // neck
   .crease()
   .curve([0.136, 0.538], [0.164, 0.547], [0.1665, 0.572], 8)      // collar out
   .curve([0.169, 0.596], [0.140, 0.603], [0.1190, 0.621], 8)      // collar in
   .crease()
   .curve([0.140, 0.660], [0.176, 0.735], [0.1915, 0.830], 16)     // bowl
   .curve([0.198, 0.868], [0.205, 0.898], [0.2075, 0.922], 8)
   .crease()
   .line(0.210, 0.938, 2)                                          // crown rim
   .crease()
   .curve([0.196, 0.947], [0.176, 0.952], [0.1600, 0.960], 5)      // step in
   .curve([0.132, 0.976], [0.095, 0.992], [0.0550, 1.002], 10)     // dome
   .curve([0.036, 1.007], [0.018, 1.010], [0, KING_DOME_TOP], 5);
  return b.done();
}

/** Lathe profiles for the five turned pieces (the knight is a base + extruded head, below). */
export const PROFILES = {
  pawn: pawnProfile(),
  rook: rookProfile(),
  bishop: bishopProfile(),
  queen: queenProfile(),
  king: kingProfile(),
};

/** The knight's turned base (top platform at y = 0.30; the carved head reaches 0.80). */
const KNIGHT_BASE_TOP = 0.300;
export const KNIGHT_BASE_PROFILE = (() => {
  const b = turn().move(0, 0);
  foot(b, 0.240, 0.162, 0.113);
  b.curve([0.1565, 0.150], [0.1505, 0.190], [0.1500, 0.225], 9)
   .crease()
   .curve([0.168, 0.238], [0.180, 0.250], [0.1810, 0.266], 6)      // collar
   .curve([0.182, 0.278], [0.178, 0.284], [0.1720, 0.292], 5)
   .crease()
   .line(0.172, KNIGHT_BASE_TOP, 2)
   .line(0, KNIGHT_BASE_TOP, 3);
  return b.done();
})();

/**
 * Horse-head silhouette, [x, y] with x = forward (muzzle) and y up from the neck base. Authored freely
 * and then normalised by knightHeadGeometry() so the finished head is exactly HEIGHTS.knight tall.
 * The `back` run carries the mane notches -- that is what stops it reading as a slab in profile.
 */
export const KNIGHT_HEAD_SILHOUETTE = {
  neckBase: [[-0.155, 0.000], [0.115, 0.000]],
  front: [                              // throat -> jaw -> muzzle -> nose -> forehead
    [0.135, 0.020], [0.168, 0.055], [0.198, 0.095], [0.215, 0.130], [0.222, 0.170],
    [0.238, 0.205], [0.258, 0.245], [0.262, 0.285], [0.246, 0.312], [0.208, 0.325],
    [0.168, 0.332], [0.128, 0.350], [0.098, 0.382], [0.075, 0.415],
  ],
  ears: [                               // front ear, the notch between, back ear
    [0.058, 0.438], [0.052, 0.468], [0.022, 0.434], [-0.012, 0.462], [-0.045, 0.428],
  ],
  back: [                               // mane: four notches down the neck
    [-0.068, 0.408], [-0.062, 0.378], [-0.094, 0.356], [-0.086, 0.322], [-0.118, 0.292],
    [-0.112, 0.252], [-0.144, 0.212], [-0.150, 0.150], [-0.158, 0.085], [-0.155, 0.020],
  ],
};
const KNIGHT_HEAD_DEPTH = 0.170;      // plus 2 x bevelThickness -> ~0.27 across
const KNIGHT_HEAD_CENTRE_X = 0.040;   // where the head's x-centre sits over the base

// --- glyph token: a disc, a contrasting bezel ring around it, and the glyph card on top. ---------
const TOKEN_TOP = 0.072;
const TOKEN_DISC_R = 0.300;
const TOKEN_BEZEL_R = 0.375;

/** The 2D token's inner disc (piece colour). */
export const GLYPH_DISC_PROFILE = (() => {
  const b = turn().move(0, 0);
  b.line(0.10, 0).line(0.20, 0).line(TOKEN_DISC_R, 0).crease()
   .line(TOKEN_DISC_R, 0.050, 3)
   .curve([TOKEN_DISC_R, 0.062], [0.295, 0.070], [0.284, TOKEN_TOP], 5)
   .crease()
   .line(0.19, TOKEN_TOP).line(0.09, TOKEN_TOP).line(0, TOKEN_TOP);
  return b.done();
})();

/**
 * The 2D token's bezel: a CLOSED cross-section (first point == last) revolved into a ring that sits
 * around the disc in the ACCENT colour. This is what makes a white token impossible to lose against a
 * light square from straight above, with or without lights.
 */
export const GLYPH_BEZEL_PROFILE = [
  P(0.298, 0), P(0.352, 0), P(TOKEN_BEZEL_R, 0.006), P(TOKEN_BEZEL_R, 0.052),
  P(0.371, 0.064), P(0.360, 0.073), P(0.330, 0.0755), P(0.308, 0.0745), P(0.298, 0.070),
  P(0.298, 0),
];

// ---------------------------------------------------------------------------------------------
// Geometry cache (shared across every piece of a set).

const geoCache = new Map();
function cached(key, make) {
  let g = geoCache.get(key);
  if (!g) { g = make(); g.name = key; geoCache.set(key, g); }
  return g;
}
function latheGeometry(key, profile, segments = LATHE_SEGMENTS) {
  return cached(key, () => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments));
}

/** Extruded annular sector (rIn..rOut, `span` degrees wide, centred on +X), `h` tall, standing on y = 0. */
function annularSectorGeometry(key, rIn, rOut, span, h, bevel = 0.006) {
  return cached(key, () => {
    const a = (span / 2) * Math.PI / 180;
    const s = new THREE.Shape();
    s.moveTo(rOut * Math.cos(-a), rOut * Math.sin(-a));
    s.absarc(0, 0, rOut, -a, a, false);
    s.absarc(0, 0, rIn, a, -a, true);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, {
      depth: h - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.8,
      bevelSegments: 2, curveSegments: 14,
    });
    g.rotateX(-Math.PI / 2);      // extrude along +Y
    g.translate(0, bevel, 0);     // stand the bevelled bottom on y = 0
    return g;
  });
}

/** A bevelled plus sign, extruded across its own plane (used twice, crossed, for the king). */
function crossGeometry(key, arm, half, thick, depth, bevel = 0.006) {
  return cached(key, () => {
    const s = new THREE.Shape();
    const t = thick / 2;
    s.moveTo(-t, -half);
    s.lineTo(t, -half); s.lineTo(t, -t); s.lineTo(arm, -t); s.lineTo(arm, t);
    s.lineTo(t, t); s.lineTo(t, half); s.lineTo(-t, half); s.lineTo(-t, t);
    s.lineTo(-arm, t); s.lineTo(-arm, -t); s.lineTo(-t, -t);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, {
      depth: depth - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
      bevelSegments: 2, curveSegments: 4,
    });
    g.translate(0, 0, -(depth - 2 * bevel) / 2);
    return g;
  });
}

function knightHeadGeometry() {
  return cached('staunton.knight.head', () => {
    const s = KNIGHT_HEAD_SILHOUETTE;
    const shape = new THREE.Shape();
    shape.moveTo(s.neckBase[0][0], s.neckBase[0][1]);
    shape.lineTo(s.neckBase[1][0], s.neckBase[1][1]);
    shape.splineThru(s.front.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const [x, y] of s.ears) shape.lineTo(x, y);
    shape.splineThru(s.back.map(([x, y]) => new THREE.Vector2(x, y)));
    shape.closePath();
    let g = new THREE.ExtrudeGeometry(shape, {
      // 12/4 is the knee of the curve: 14/5 costs ~20% more triangles and ~11 ms of the one-off cold
      // build for no visible gain (the bevel is 0.03 across). mergeVertices below dominates the cost.
      depth: KNIGHT_HEAD_DEPTH, bevelEnabled: true, bevelThickness: 0.048, bevelSize: 0.030,
      bevelSegments: 4, curveSegments: 12,
    });
    g.translate(0, 0, -(KNIGHT_HEAD_DEPTH / 2));
    g = mergeVertices(g, 1e-4);
    g.computeVertexNormals();
    // Normalise: the bevel expands the authored outline, so measure and fit the head exactly.
    g.computeBoundingBox();
    const bb = g.boundingBox;
    const target = HEIGHTS.knight - KNIGHT_BASE_TOP;
    const k = target / (bb.max.y - bb.min.y);
    g.scale(k, k, k);
    g.computeBoundingBox();
    const b2 = g.boundingBox;
    g.translate(KNIGHT_HEAD_CENTRE_X - (b2.min.x + b2.max.x) / 2, -b2.min.y, 0);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  });
}

// ---------------------------------------------------------------------------------------------
// Materials helpers. matSet (materials.js) owns the real ones; these are the node/test fallbacks.

const FALLBACK = {
  white: new THREE.MeshStandardMaterial({ color: '#F6EEDD', roughness: 0.5 }),
  black: new THREE.MeshStandardMaterial({ color: '#241B13', roughness: 0.45 }),
};
const ACCENT = {
  white: new THREE.MeshStandardMaterial({ color: '#171209', roughness: 0.55, metalness: 0 }),  // dark inset on light pieces
  black: new THREE.MeshStandardMaterial({ color: '#C7B79B', roughness: 0.55, metalness: 0 }),  // light inset on dark pieces
};
const CONTACT_FALLBACK = new THREE.MeshBasicMaterial({
  color: '#1A1208', transparent: true, opacity: 0.34, depthWrite: false, toneMapped: false,
});
FALLBACK.white.name = 'piece.fallback.white'; FALLBACK.black.name = 'piece.fallback.black';
ACCENT.white.name = 'piece.accent.onWhite'; ACCENT.black.name = 'piece.accent.onBlack';
CONTACT_FALLBACK.name = 'piece.contactShadow.fallback';

function pieceMaterial(color, matSet) {
  if (matSet && matSet.whitePiece && matSet.blackPiece) return color === 'black' ? matSet.blackPiece : matSet.whitePiece;
  return FALLBACK[color === 'black' ? 'black' : 'white'];
}
function accentMaterial(color, matSet) {
  if (matSet && matSet.whiteAccent && matSet.blackAccent) return color === 'black' ? matSet.blackAccent : matSet.whiteAccent;
  return ACCENT[color === 'black' ? 'black' : 'white'];
}
function contactMaterial(matSet) {
  return (matSet && matSet.contactShadow) || CONTACT_FALLBACK;
}

function mesh(geometry, material, keep = false) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = true;
  m.receiveShadow = true;
  if (keep) m.userData.keepMaterial = true;
  return m;
}

/** An inset/bezel mesh: keeps its own accent material through applyMaterials(). */
function accentMesh(geometry, color, matSet) {
  const m = mesh(geometry, accentMaterial(color, matSet), true);
  m.userData.accent = true;
  return m;
}

function pieceGroup(role, color, setId) {
  const g = new THREE.Group();
  g.name = `${color}-${role}`;
  g.userData = { role, color, square: null, set: setId };
  return g;
}

/**
 * Pin the decal to the board plane no matter how far its parent has been lifted. onBeforeRender runs
 * BEFORE the renderer derives modelViewMatrix from matrixWorld, so writing the world Y here lands on
 * the same frame. The piece group is only ever translated and rotated about Y, so element 13 is its
 * world height and nothing else has to be touched.
 */
function pinContactShadow(renderer, scene, camera) {
  this.matrixWorld.elements[13] = CONTACT_Y;
}

/** The soft dark decal under a piece: what stops a light piece merging into a light square. */
function contactShadow(radius, matSet) {
  const d = round(radius * 2);
  const m = new THREE.Mesh(cached(`contact.plane.${d}`, () => new THREE.PlaneGeometry(d, d)), contactMaterial(matSet));
  m.rotation.x = -Math.PI / 2;
  m.position.y = CONTACT_Y;
  m.castShadow = false;
  m.receiveShadow = false;
  m.renderOrder = -1;
  m.userData.keepMaterial = true;
  m.userData.contactShadow = true;
  m.onBeforeRender = pinContactShadow;
  return m;
}

function addContactShadow(g, radius, matSet) {
  const m = contactShadow(radius, matSet);
  g.add(m);
  g.userData.contactShadow = m;
  return m;
}

// ---------------------------------------------------------------------------------------------
// 'staunton'

function buildStaunton(role, color, matSet) {
  const g = pieceGroup(role, color, 'staunton');
  const mat = pieceMaterial(color, matSet);
  switch (role) {
    case 'pawn':
      g.add(mesh(latheGeometry('staunton.pawn', PROFILES.pawn), mat));
      break;

    case 'rook': {
      g.add(mesh(latheGeometry('staunton.rook', PROFILES.rook), mat));
      // real hollow crown: a revolved ring, not a capped disc
      g.add(mesh(latheGeometry('staunton.rook.crown', ROOK_CROWN_PROFILE), mat));
      const merlon = annularSectorGeometry(
        'staunton.rook.merlon', ROOK_CROWN_INNER, ROOK_CROWN_OUTER, 56, HEIGHTS.rook - ROOK_BAND_TOP, 0.007,
      );
      for (let i = 0; i < 4; i++) {
        const m = mesh(merlon, mat);
        m.position.y = ROOK_BAND_TOP;
        m.rotation.y = (i / 4) * Math.PI * 2;
        g.add(m);
      }
      break;
    }

    case 'bishop': {
      g.add(mesh(latheGeometry('staunton.bishop', PROFILES.bishop), mat));
      const slit = accentMesh(cached('staunton.bishop.slit', () => new THREE.BoxGeometry(0.019, 0.175, 0.07)), color, matSet);
      slit.position.set(0, 0.632, 0.108);
      slit.rotation.set(-0.30, 0, 0.52);
      g.add(slit);
      break;
    }

    case 'queen': {
      g.add(mesh(latheGeometry('staunton.queen', PROFILES.queen), mat));
      const point = cached('staunton.queen.point', () => {
        const c = new THREE.ConeGeometry(0.0315, 0.075, 12, 1);
        c.translate(0, 0.0375, 0);
        return c;
      });
      const n = 9;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const m = mesh(point, mat);
        m.position.set(Math.sin(a) * QUEEN_CORONET_R, QUEEN_RIM_Y - 0.004, Math.cos(a) * QUEEN_CORONET_R);
        g.add(m);
      }
      break;
    }

    case 'king': {
      g.add(mesh(latheGeometry('staunton.king', PROFILES.king), mat));
      const orb = mesh(cached('staunton.king.orb', () => new THREE.SphereGeometry(0.055, 24, 16)), mat);
      orb.position.y = 1.038;
      g.add(orb);
      // Double cross: reads as a cross from the seat AND as a plus from straight above.
      const cross = crossGeometry('staunton.king.cross', 0.0625, 0.0675, 0.042, 0.042, 0.006);
      for (const ry of [0, Math.PI / 2]) {
        const m = mesh(cross, mat);
        m.position.y = HEIGHTS.king - 0.0735;   // half-height + bevelSize: the tip lands on HEIGHTS.king
        m.rotation.y = ry;
        g.add(m);
      }
      break;
    }

    case 'knight': {
      g.add(mesh(latheGeometry('staunton.knight.base', KNIGHT_BASE_PROFILE), mat));
      const head = mesh(knightHeadGeometry(), mat);
      head.rotation.y = -Math.PI / 2;            // silhouette's +X (muzzle) -> world +Z
      head.position.y = KNIGHT_BASE_TOP;
      // cheeks: two flattened bulges so the carved head is not a slab from the front
      const cheek = cached('staunton.knight.cheek', () => {
        const s = new THREE.SphereGeometry(0.052, 18, 14);
        s.scale(1.55, 1.85, 0.55);
        return s;
      });
      for (const side of [-1, 1]) {
        const c = mesh(cheek, mat);
        c.position.set(0.045, 0.205, side * 0.118);
        head.add(c);
      }
      const eye = cached('staunton.knight.eye', () => new THREE.SphereGeometry(0.0155, 12, 10));
      const nostril = cached('staunton.knight.nostril', () => new THREE.SphereGeometry(0.010, 10, 8));
      for (const side of [-1, 1]) {
        const e = accentMesh(eye, color, matSet);
        e.position.set(0.108, 0.330, side * 0.128);
        head.add(e);
        const nz = accentMesh(nostril, color, matSet);
        nz.position.set(0.242, 0.292, side * 0.055);
        head.add(nz);
      }
      g.add(head);
      break;
    }

    default:
      throw new Error('createPiece: unknown role ' + role);
  }
  addContactShadow(g, CONTACT_RADIUS[role], matSet);
  return g;
}

// ---------------------------------------------------------------------------------------------
// 'minimal' -- same height ladder, honest primitives.

const MIN_SEG = 56;

function minimalBase(g, mat, r, h) {
  const plinth = mesh(cached(`minimal.plinth.${r}`, () => new THREE.CylinderGeometry(r + 0.03, r + 0.09, 0.05, MIN_SEG)), mat);
  plinth.position.y = 0.025;
  const shaft = mesh(cached(`minimal.shaft.${r}.${h}`, () => new THREE.CylinderGeometry(r, r, h, MIN_SEG)), mat);
  shaft.position.y = h / 2;
  g.add(plinth, shaft);
}

function buildMinimal(role, color, matSet) {
  const g = pieceGroup(role, color, 'minimal');
  const mat = pieceMaterial(color, matSet);
  switch (role) {
    case 'pawn': {
      minimalBase(g, mat, 0.125, 0.41);
      const cap = mesh(cached('minimal.pawn.cap', () => new THREE.SphereGeometry(0.17, 40, 26)), mat);
      cap.position.y = 0.41;                              // top 0.58
      g.add(cap);
      break;
    }
    case 'rook': {
      minimalBase(g, mat, 0.155, 0.55);
      const cap = mesh(cached('minimal.rook.cap', () => new THREE.BoxGeometry(0.33, 0.15, 0.33)), mat);
      cap.position.y = 0.625;                             // top 0.70
      g.add(cap);
      break;
    }
    case 'bishop': {
      minimalBase(g, mat, 0.145, 0.55);
      const cap = mesh(cached('minimal.bishop.cap', () => new THREE.ConeGeometry(0.175, 0.33, MIN_SEG)), mat);
      cap.position.y = 0.715;                             // top 0.88
      g.add(cap);
      break;
    }
    case 'knight': {
      minimalBase(g, mat, 0.145, 0.46);
      const wedge = mesh(cached('minimal.knight.wedge', () => {
        const s = new THREE.Shape();
        s.moveTo(-0.17, 0); s.lineTo(0.215, 0); s.lineTo(-0.17, 0.34); s.closePath();
        const geo = new THREE.ExtrudeGeometry(s, { depth: 0.20, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.016, bevelSegments: 3 });
        geo.translate(0, 0, -0.10);
        geo.computeBoundingBox();                       // the bevel overshoots the authored apex
        const bb = geo.boundingBox;
        geo.translate(0, -bb.min.y, 0);
        geo.scale(1, 0.34 / (bb.max.y - bb.min.y), 1);
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
        return geo;
      }), mat);
      wedge.rotation.y = -Math.PI / 2;                    // point of the wedge -> +Z
      wedge.position.y = 0.46;                            // top 0.80
      g.add(wedge);
      break;
    }
    case 'queen': {
      minimalBase(g, mat, 0.155, 0.80);
      const cap = mesh(cached('minimal.queen.cap', () => new THREE.OctahedronGeometry(0.155, 0)), mat);
      cap.position.y = 0.865;                             // top 1.02
      g.add(cap);
      break;
    }
    case 'king': {
      minimalBase(g, mat, 0.165, 0.88);
      const v = mesh(cached('minimal.king.crossV', () => new THREE.BoxGeometry(0.075, 0.30, 0.075)), mat);
      v.position.y = 1.03;                                // top 1.18
      const h = mesh(cached('minimal.king.crossH', () => new THREE.BoxGeometry(0.235, 0.075, 0.075)), mat);
      h.position.y = 1.055;
      g.add(v, h);
      break;
    }
    default:
      throw new Error('createPiece: unknown role ' + role);
  }
  addContactShadow(g, CONTACT_RADIUS[role], matSet);
  return g;
}

// ---------------------------------------------------------------------------------------------
// 'glyph' -- the 2D token. Disc (piece colour) + bezel ring (accent colour) + the cburnett glyph with
// a contrast halo, lying flat. Reads upright from White's seat; the layer flips it for Black.

const glyphTextures = new Map();   // cache key -> Promise<CanvasTexture>
const glyphMaterials = new Map();  // cache key -> MeshBasicMaterial (shared by every card of that glyph)

/** Crops the cburnett margin so the art fills the token. */
const TOKEN_VIEWBOX = '4 4 37 37';
const TOKEN_HALO = { white: '#141009', black: '#F6F0E2' };

function texKey(id, size, opts) {
  if (!opts || !opts.halo) return `${id}|${size}`;
  return `${id}|${size}|${opts.halo}|${opts.haloWidth || ''}|${opts.viewBox || ''}`;
}

function ctxCanDraw(ctx) {
  return !!(ctx && typeof ctx.drawImage === 'function' && typeof ctx.fillRect === 'function'
    && 'globalCompositeOperation' in ctx);
}

/** Paint the glyph with a fat contrasting halo so it reads from straight above on any disc colour. */
function paintHalo(ctx, img, size, halo, width) {
  const pad = Math.ceil(width) + 1;
  const inner = size - 2 * pad;
  const sil = document.createElement('canvas');
  sil.width = sil.height = size;
  const sctx = sil.getContext('2d');
  if (!ctxCanDraw(sctx)) return false;
  sctx.drawImage(img, pad, pad, inner, inner);
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = halo;
  sctx.fillRect(0, 0, size, size);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.71, 0.71], [-0.71, 0.71], [0.71, -0.71], [-0.71, -0.71]];
  for (const r of [width, width * 0.55]) {
    for (const [dx, dy] of dirs) ctx.drawImage(sil, dx * r, dy * r, size, size);
  }
  ctx.drawImage(img, pad, pad, inner, inner);
  return true;
}

/**
 * Rasterise one glyph from its inline SVG into a cached CanvasTexture. Browser only.
 * @param {string} id   glyph id ('wK'..'bP')
 * @param {number} size px
 * @param {{halo?:string, haloWidth?:number, viewBox?:string}|null} opts
 * @returns {Promise<THREE.CanvasTexture>}
 */
export function getGlyphTexture(id, size = 256, opts = null) {
  const key = texKey(id, size, opts);
  let p = glyphTextures.get(key);
  if (p) return p;
  p = new Promise((resolve, reject) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') { reject(new Error('getGlyphTexture: no DOM')); return; }
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        let painted = false;
        if (opts && opts.halo && ctxCanDraw(ctx)) {
          painted = paintHalo(ctx, img, size, opts.halo, opts.haloWidth || Math.max(3, Math.round(size / 26)));
        }
        if (!painted) ctx.drawImage(img, 0, 0, size, size);
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        resolve(tex);
      } catch (err) { fail(err instanceof Error ? err : new Error(String(err))); }
    };
    img.onerror = () => { fail(new Error('getGlyphTexture: failed to rasterise ' + id)); };
    img.src = glyphDataUrl(id, size, opts && opts.viewBox ? { viewBox: opts.viewBox } : undefined);
    function fail(err) {
      // Do NOT keep a rejected promise in the cache: one transient rasterise failure would otherwise
      // leave that piece type as a bare disc for the whole session (nothing else clears the cache).
      if (glyphTextures.get(key) === p) glyphTextures.delete(key);
      reject(err);
    }
  });
  glyphTextures.set(key, p);
  return p;
}

/** Kick off (or retry) the rasterise for a card material that has no map yet. */
function loadGlyphInto(m, id, opts) {
  if (typeof Image === 'undefined' || typeof document === 'undefined') return;
  if (m.userData.glyphLoading) return;
  m.userData.glyphLoading = true;
  getGlyphTexture(id, 320, opts)
    .then((tex) => { m.userData.glyphLoading = false; m.map = tex; m.opacity = 1; m.needsUpdate = true; requestRedraw('content'); })
    .catch((err) => { m.userData.glyphLoading = false; if (typeof console !== 'undefined') console.warn(String(err)); });
}

function glyphCardMaterial(id, color) {
  const opts = { halo: TOKEN_HALO[color === 'black' ? 'black' : 'white'], viewBox: TOKEN_VIEWBOX };
  const key = texKey(id, 320, opts);
  let m = glyphMaterials.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, toneMapped: false, alphaTest: 0.04 });
    m.name = 'glyph.' + id;
    glyphMaterials.set(key, m);
  }
  if (!m.map) loadGlyphInto(m, id, opts);   // first card, or a retry after a previous failure
  return m;
}

function buildGlyph(role, color, matSet) {
  const g = pieceGroup(role, color, 'glyph');
  const mat = pieceMaterial(color, matSet);
  g.add(mesh(latheGeometry('glyph.disc', GLYPH_DISC_PROFILE, 72), mat));
  const bezel = mesh(latheGeometry('glyph.bezel', GLYPH_BEZEL_PROFILE, 72), accentMaterial(color, matSet), true);
  bezel.userData.accent = true;
  g.add(bezel);
  const id = glyphId(role, color);
  const card = new THREE.Mesh(cached('glyph.card', () => new THREE.PlaneGeometry(0.56, 0.56)), glyphCardMaterial(id, color));
  card.rotation.x = -Math.PI / 2;   // lie flat, texture top toward -Z
  card.position.y = TOKEN_TOP + 0.003;
  card.renderOrder = 1;
  card.castShadow = false;
  card.receiveShadow = false;
  card.userData.keepMaterial = true;
  card.userData.glyphCard = true;
  g.add(card);
  addContactShadow(g, GLYPH_CONTACT_RADIUS, matSet);
  return g;
}

// ---------------------------------------------------------------------------------------------
// glTF sets: the ones a user adds from a file, and the modelled sets shipped with the board
// (modeledSets.js -- built in Blender, one Draco-compressed GLB each, loaded on first use).

const gltfSets = new Map();  // id -> { id, name, kind, keepMaterials, protos: { role: { white, black } }, materials }
const modeledLoads = new Map();   // id -> Promise<true> while a modelled set is loading
let setsUnlit = false;       // the lighting master switch reaches set-owned materials too
const UNLIT_SHAPE = { shape: true, flatMetal: true };   // setMaterialUnlit: keep the baked occlusion, flatten metal
const MAP_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'clearcoatNormalMap'];
const SET_ANISOTROPY = 8;

function bakeWorld(node) {
  // Deep-clone a node and bake its world transform (relative to the glTF root) into the clone's local transform.
  const c = node.clone(true);
  c.matrix.copy(node.matrixWorld);
  c.matrix.decompose(c.position, c.quaternion, c.scale);
  return c;
}

/**
 * Decal radius per unit of foot radius. The contact gradient (materials.js) is dense to ~0.73 of the decal and
 * then falls off, so at 1.38x the foot's edge lands on that shoulder -- the same ratio CONTACT_RADIUS gives the
 * built-in pieces.
 */
const CONTACT_SPREAD = 1.38;

/** Radius of the contact-shadow decal for a piece: its foot (what touches the board) times CONTACT_SPREAD. */
function footprintRadius(root) {
  let r = 0;
  const v = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const pos = o.isMesh && o.geometry && o.geometry.attributes.position;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 30000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      if (v.y < 0.03) r = Math.max(r, Math.hypot(v.x, v.z));
    }
  });
  return Math.min(MAX_PIECE_RADIUS - 0.005, Math.max(0.2, r * CONTACT_SPREAD));
}

function normalise(node, s, keepOrigin = false) {
  // Wrap in a group scaled by s and stand the bottom on y = 0. By default the bounding box is also centred in
  // x/z (a user file can put its pieces anywhere). keepOrigin keeps the authored x/z origin instead: the
  // modelled sets author every piece at its base centre, and a knight's bounding box is NOT its base (the
  // head reaches forward), so centring the box would push the foot off the square.
  const inner = new THREE.Group();
  inner.add(node);
  inner.scale.setScalar(s);
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  if (keepOrigin) {
    inner.position.set(0, -box.min.y, 0);
  } else {
    const c = box.getCenter(new THREE.Vector3());
    inner.position.set(-c.x, -box.min.y, -c.z);
  }
  inner.updateMatrixWorld(true);
  inner.userData.contactRadius = keepOrigin ? footprintRadius(inner) : Math.min(
    MAX_PIECE_RADIUS - 0.01,
    Math.max(0.22, 0.62 * Math.max(box.max.x - box.min.x, box.max.z - box.min.z)),
  );
  return inner;
}

function gltfLoader() {
  const loader = new GLTFLoader();
  loader.setDRACOLoader(getDracoLoader());
  return loader;
}

/**
 * Load a glTF/GLB and register it as a piece set. mapping maps each role to a node name, or to
 * { white, black } node names. Pieces are scaled so the king is HEIGHTS.king tall (times `scale`),
 * centred on their base. Colour comes from matSet piece materials unless keepMaterials.
 * Extra options (the modelled sets use them): `data` (an ArrayBuffer instead of url/file), `blackFrom` (a node
 * whose material the black pieces take -- the white pieces keep the file's own), `keepOrigin` (see normalise),
 * `kind` (what listSets reports), `proxyData` (a GLB of low-detail stand-ins with the same node names; see
 * addStandIns).
 * @returns {Promise<{id, name, kind, keepMaterials, roles:string[]}>}
 */
export async function registerGltfSet({
  id, name, url, file, data, mapping, scale = 1, keepMaterials = false, blackFrom = null, keepOrigin = false, kind = 'gltf',
  proxyData = null,
}) {
  if (!id || typeof id !== 'string') throw new Error('registerGltfSet: id is required');
  if (BUILTIN_SETS.some((s) => s.id === id)) throw new Error(`registerGltfSet: '${id}' is a built-in set id`);
  if (!mapping || typeof mapping !== 'object') throw new Error('registerGltfSet: mapping { pawn..king: nodeName } is required');
  for (const role of ROLES) if (!mapping[role]) throw new Error(`registerGltfSet: mapping.${role} is missing`);

  let gltf;
  if (data) {
    gltf = await new Promise((resolve, reject) => gltfLoader().parse(data, '', resolve, reject));
  } else {
    let src = url, objectUrl = null;
    if (file) { objectUrl = URL.createObjectURL(file); src = objectUrl; }
    if (!src) throw new Error('registerGltfSet: url, file or data is required');
    try {
      gltf = await gltfLoader().loadAsync(src);
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  const root = gltf.scene || (gltf.scenes && gltf.scenes[0]);
  if (!root) throw new Error(`registerGltfSet: '${id}' has no scene`);
  root.updateMatrixWorld(true);

  const find = (nm) => {
    const n = root.getObjectByName(nm);
    if (!n) throw new Error(`glTF set '${id}': node '${nm}' not found`);
    return n;
  };
  const nameFor = (role, color) => {
    const m = mapping[role];
    if (typeof m === 'string') return m;
    if (m && typeof m === 'object' && m[color]) return m[color];
    throw new Error(`glTF set '${id}': mapping.${role} needs a node name or { white, black }`);
  };
  let blackMaterial = null;
  if (blackFrom) {
    find(blackFrom).traverse((o) => { if (!blackMaterial && o.isMesh) blackMaterial = o.material; });
    if (!blackMaterial) throw new Error(`glTF set '${id}': node '${blackFrom}' has no material`);
  }

  // Scale from the (white) king's height so the set keeps its own proportions.
  const kingClone = bakeWorld(find(nameFor('king', 'white')));
  const tmp = new THREE.Group(); tmp.add(kingClone); tmp.updateMatrixWorld(true);
  const kingBox = new THREE.Box3().setFromObject(tmp);
  const kingH = kingBox.max.y - kingBox.min.y;
  if (!(kingH > 0)) throw new Error(`glTF set '${id}': the king node has no size`);
  const s = (HEIGHTS.king / kingH) * (scale > 0 ? scale : 1);

  const protos = {};
  for (const role of ROLES) {
    protos[role] = {};
    for (const color of ['white', 'black']) {
      const nm = nameFor(role, color);
      if (color === 'black' && nm === nameFor(role, 'white')) {
        if (!blackMaterial) { protos[role].black = protos[role].white; continue; }   // same node, same look: share
        const c = protos[role].white.clone(true);                                    // same geometry, black finish
        c.traverse((o) => { if (o.isMesh) o.material = blackMaterial; });
        protos[role].black = c;
        continue;
      }
      const clone = bakeWorld(find(nm));
      clone.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true; o.receiveShadow = true;
          if (keepMaterials) { o.userData.keepMaterial = true; o.userData.ownFinish = true; }
          if (color === 'black' && blackMaterial) o.material = blackMaterial;
        }
      });
      protos[role][color] = normalise(clone, s, keepOrigin);
    }
  }
  const materials = new Set();
  for (const role of ROLES) for (const color of ['white', 'black']) {
    protos[role][color].traverse((o) => {
      if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m && materials.add(m));
    });
  }
  const set = { id, name: name || id, kind, keepMaterials: !!keepMaterials, protos, roles: ROLES.slice(), materials: Array.from(materials) };
  // A set that keeps its own materials still takes the dither every lit material in the app gets (no banding in
  // the long soft gradients of a turned piece), and its maps anisotropic filtering: a turned shaft is seen edge-on
  // at its sides, where plain mipmaps smear Estate's window bands into pinstripes (critique r4). three clamps the
  // value to what the GPU offers.
  if (set.keepMaterials) {
    for (const m of set.materials) {
      m.dithering = true;
      for (const k of MAP_KEYS) if (m[k]) m[k].anisotropy = SET_ANISOTROPY;
    }
  }
  // The last await comes before the lighting state is read, so a lighting toggle cannot fall between the two.
  if (proxyData) await addStandIns(set, proxyData, nameFor);
  if (set.keepMaterials && setsUnlit) for (const m of set.materials) setMaterialUnlit(m, true, UNLIT_SHAPE);
  unregisterSet(id);
  gltfSets.set(id, set);
  return { id: set.id, name: set.name, kind: set.kind, keepMaterials: set.keepMaterials, roles: set.roles };
}

// Low-detail stand-ins. The shadow map and the edge-light mask do not need a modelled piece's full detail, so a set
// can bring a second GLB of simplified copies (modeledSets.js `proxy`). Each one sits beside the full mesh inside
// the proto's normalised group, so every clone carries it and it follows every move, lift, turn and fade of the
// piece with no extra code. It is hidden and never picked; the view shows it in the full mesh's place only while
// the shadow map or the mask is drawn (scene.js, silhouette.js).

const STAND_IN_MATERIAL = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });   // never drawn
STAND_IN_MATERIAL.name = 'piece.standIn';
const standIns = new WeakMap();   // a piece's full mesh -> its stand-in
const skipRaycast = () => {};

/** The low-detail stand-in of a piece's mesh, or null when it has none (no proxy file, a built-in set). */
export function standInOf(mesh) {
  return (mesh && standIns.get(mesh)) || null;
}

/**
 * Run `draw` with every visible piece mesh under `root` that has a stand-in swapped for it: the full mesh hidden,
 * its stand-in shown wearing the full mesh's material. Everything is put back afterwards, also when `draw` throws.
 * Returns what `draw` returns. The view draws the shadow map this way (scene.js).
 */
export function drawWithStandIns(root, draw) {
  const swap = [];   // full mesh, stand-in, the stand-in's own material
  root.traverseVisible((o) => {
    const s = o.isMesh && !Array.isArray(o.material) ? standInOf(o) : null;
    if (s) swap.push(o, s, s.material);
  });
  for (let i = 0; i < swap.length; i += 3) {
    swap[i + 1].material = swap[i].material;
    swap[i + 1].visible = true;
    swap[i].visible = false;
  }
  try {
    return draw();
  } finally {
    for (let i = 0; i < swap.length; i += 3) {
      swap[i].visible = true;
      swap[i + 1].visible = false;
      swap[i + 1].material = swap[i + 2];
    }
  }
}

/**
 * Put each proto's stand-in from `proxyData` beside its full mesh: the node of the same name, with its own baked
 * transform, inside the group normalise() made -- so it takes exactly the full mesh's scale and placement. A file
 * that cannot be read gives no stand-ins, and a missing node leaves that piece without one: the full mesh then
 * draws the shadow and the mask, as it always did.
 */
async function addStandIns(set, proxyData, nameFor) {
  let root = null;
  try {
    const gltf = await new Promise((resolve, reject) => gltfLoader().parse(proxyData, '', resolve, reject));
    root = gltf.scene || (gltf.scenes && gltf.scenes[0]) || null;
  } catch (err) {
    return;
  }
  if (!root) return;
  root.updateMatrixWorld(true);
  const done = new Set();
  for (const role of ROLES) for (const color of ['white', 'black']) {
    const proto = set.protos[role][color];
    if (done.has(proto)) continue;
    done.add(proto);
    const full = proto.children[0];
    const node = root.getObjectByName(nameFor(role, color));
    if (!full || !full.isMesh || !node || !node.isMesh) continue;
    const s = bakeWorld(node);
    s.name = full.name + '.standIn';
    s.material = STAND_IN_MATERIAL;
    s.castShadow = true;
    s.receiveShadow = false;
    s.visible = false;
    s.userData = { standIn: true, keepMaterial: true };
    proto.add(s);
  }
}

/** Remove a registered glTF set and dispose its geometry (and its own materials and maps when keepMaterials). */
export function unregisterSet(id) {
  const set = gltfSets.get(id);
  if (!set) return false;
  const seen = new Set();
  for (const role of ROLES) for (const color of ['white', 'black']) {
    const p = set.protos[role][color];
    if (!p || seen.has(p)) continue;
    seen.add(p);
    p.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
  }
  if (set.keepMaterials) {
    for (const m of set.materials) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
        if (m[k] && m[k].dispose) m[k].dispose();
      }
      m.dispose();
    }
  }
  gltfSets.delete(id);
  return true;
}

/** True for an id in the modelled-set catalogue (loaded or not). */
export function isModeledSet(id) {
  return !!modeledSet(id);
}

/**
 * Make sure a modelled set is loaded (a no-op for any other id). Resolves true once createPiece can build
 * it; a failed load is not cached, so choosing the set again retries.
 */
export function ensureModeledSet(id) {
  const entry = modeledSet(id);
  if (!entry || gltfSets.has(id)) return Promise.resolve(true);
  let p = modeledLoads.get(id);
  if (!p) {
    p = Promise.all([loadSetBytes(entry), loadProxyBytes(entry)])   // the stand-ins load alongside; null without
      .then(([data, proxyData]) => {
        const mapping = {};
        for (const role of ROLES) mapping[role] = entry.prefix + role;
        return registerGltfSet({
          id, name: entry.name, data, mapping, keepMaterials: true, blackFrom: entry.prefix + 'swatch_black',
          keepOrigin: true, kind: 'model', proxyData,
        });
      })
      .then(() => { modeledLoads.delete(id); requestRedraw('content'); return true; }, (err) => { modeledLoads.delete(id); throw err; });
    modeledLoads.set(id, p);
  }
  return p;
}

/**
 * Lighting "off": set-owned materials go flat the way the theme's do (materials.js setMaterialUnlit), but keep
 * their baked ambient occlusion (the GLB's ORM texture), so a pale set still shows where one form meets another
 * instead of reading as a milky silhouette; a metal's patina is pulled toward one colour (flatMetal).
 */
export function setSetsUnlit(on) {
  setsUnlit = !!on;
  requestRedraw('content');
  for (const set of gltfSets.values()) {
    if (!set.keepMaterials) continue;
    for (const m of set.materials) setMaterialUnlit(m, setsUnlit, UNLIT_SHAPE);
  }
}

function buildGltf(set, role, color, matSet) {
  const g = pieceGroup(role, color, set.id);
  const proto = set.protos[role][color];
  const obj = proto.clone(true);
  const standIn = obj.children.find((c) => c.userData.standIn);
  if (standIn && obj.children[0].isMesh) {
    standIn.raycast = skipRaycast;   // picking, hover and drag see only the full mesh
    standIns.set(obj.children[0], standIn);
  }
  g.add(obj);
  applyMaterials(g, matSet || { whitePiece: FALLBACK.white, blackPiece: FALLBACK.black });   // the theme's finish
  addContactShadow(g, proto.userData.contactRadius || CONTACT_RADIUS[role], matSet);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Public surface.

/** All sets: the built-ins plus every registered glTF set. */
export function listSets() {
  const out = BUILTIN_SETS.map((s) => ({ id: s.id, name: s.name, kind: 'builtin' }));
  for (const s of MODELED_SETS) out.push({ id: s.id, name: s.name, kind: 'model', blurb: s.blurb, loaded: gltfSets.has(s.id) });
  for (const s of gltfSets.values()) if (!modeledSet(s.id)) out.push({ id: s.id, name: s.name, kind: 'gltf' });
  return out;
}

/** 'builtin' | 'model' | 'gltf' | null (unknown, or a modelled set that has not finished loading). */
export function setKind(id) {
  if (BUILTIN_SETS.some((s) => s.id === id)) return 'builtin';
  const s = gltfSets.get(id);
  if (s) return s.kind === 'model' ? 'model' : 'gltf';
  return null;
}

/** True when pieces of this set have a front (the layer rotates them by colour to face the opponent). */
export function isDirectional(id) {
  return id !== 'glyph';
}

/**
 * Where a set's bishop has its mitre cut, as an azimuth in the piece's own frame (0 = +Z, the side it is authored
 * facing; PI/2 = +X), or null for a bishop without one to show (Cairn's slot runs right through the stone and reads
 * from both seats; Menagerie's is an owl; the minimal set's a plain cone). The layer turns the cut three-quarter
 * toward its owner (pieceLayer.js, Facing). Checked by orbiting a lone bishop of each set (shoot.mjs piece views).
 */
const BISHOP_CUT = { staunton: 0, classic: Math.PI / 2, beton: Math.PI / 2, estate: Math.PI / 2 };
export function bishopCut(id) {
  return Object.prototype.hasOwnProperty.call(BISHOP_CUT, id) ? BISHOP_CUT[id] : null;
}

const warned = new Set();

/**
 * Build one piece as a THREE.Group (origin at base centre, y = 0, userData { role, color, square: null }).
 * Unknown set ids fall back to 'staunton' with a single console warning.
 */
export function createPiece(role, color, setId = 'staunton', matSet = null) {
  if (!ROLES.includes(role)) throw new Error('createPiece: unknown role ' + role);
  if (color !== 'white' && color !== 'black') throw new Error('createPiece: unknown color ' + color);
  const gltf = gltfSets.get(setId);
  if (gltf) return buildGltf(gltf, role, color, matSet);
  let id = setId;
  if (setKind(id) !== 'builtin') {
    if (!warned.has(id) && typeof console !== 'undefined') { console.warn(`createPiece: unknown piece set '${id}', using staunton`); warned.add(id); }
    id = 'staunton';
  }
  if (id === 'minimal') return buildMinimal(role, color, matSet);
  if (id === 'glyph') return buildGlyph(role, color, matSet);
  return buildStaunton(role, color, matSet);
}

/**
 * Point every mesh of a piece at the right material of `matSet`, by userData.color.
 * Insets (`userData.accent`) take the accent material and contact shadows take matSet.contactShadow,
 * so a theme change repaints them too; a modelled set's meshes (`ownFinish`) take the theme's finish over their
 * own detail, or their own material back in wood; anything else flagged `keepMaterial` is left alone.
 */
export function applyMaterials(pieceObj, matSet) {
  if (!pieceObj || !matSet) return;
  const color = pieceObj.userData && pieceObj.userData.color;
  const mat = color === 'black' ? matSet.blackPiece : matSet.whitePiece;
  const accent = accentMaterial(color, matSet);
  const contact = contactMaterial(matSet);
  if (!mat) return;
  pieceObj.traverse((o) => {
    if (!o.isMesh) return;
    const ud = o.userData || {};
    if (ud.contactShadow) { o.material = contact; return; }
    if (ud.accent) { o.material = accent; return; }
    if (ud.ownFinish) { o.material = modeledFinish(o.material, color, matSet); return; }
    if (ud.keepMaterial) return;
    o.material = mat;
  });
}

const ownFinishOf = new WeakMap();   // a theme's finish on a modelled set -> the set's own material under it
/** The material a modelled set's mesh should wear under `matSet` (see the ownFinish flag above). */
function modeledFinish(current, color, matSet) {
  const own = ownFinishOf.get(current) || current;
  const themed = matSet && typeof matSet.modeledPiece === 'function' ? matSet.modeledPiece(color, own) : null;
  if (!themed) return own;
  ownFinishOf.set(themed, own);
  return themed;
}

/** Dispose the shared geometry cache and glyph textures/materials (call once, when the layer is disposed). */
export function disposePieceCaches() {
  for (const g of geoCache.values()) g.dispose();
  geoCache.clear();
  for (const m of glyphMaterials.values()) { if (m.map) m.map.dispose(); m.dispose(); }
  glyphMaterials.clear();
  glyphTextures.clear();
}
