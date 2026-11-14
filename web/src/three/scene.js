// The renderer, camera, controls, lights, environment and render loop. See docs/rendering.md.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { makeLacquerTexture, setMaterialUnlit } from './materials.js';
import { createSilhouette } from './silhouette.js';
import { createGlow } from './glow.js';
import { onRedraw } from './redraw.js';
import { standInOf, drawWithStandIns } from './pieces.js';
import { createMotionPolicy, MOTION, MOTION_LEVELS, QUALITY, normalizeQuality } from './motionQuality.js';
import { readGpuName } from './gpuName.js';

/** Where the board sits (settings.environment); the fields are described in docs/rendering.md. */
export const ENVIRONMENTS = {
  room: {
    hdr: 'room', blur: 0.07, bg: 0.35, rot: 5.6,
    env: 1.15, light: 0.35, exposure: 1.79,
    seat: 1, back: 1, under: 0.15,
    tint: [1, 0.85, 0.71], label: 'Room'
  },
  studio: {
    hdr: 'studio', envBlur: 0.8, blur: 0.55, bg: 0.30, bgKnee: 80, floor: 0x6a6d72, rot: 1.57,
    env: 1.0, light: 0.35, exposure: 0.95,
    seat: 1, back: 1, under: 0.27,
    tint: [0.77, 0.92, 1], label: 'Studio'
  },
  plain: {
    hdr: null, envBlur: 0.9, rot: 0.7854,
    env: 0.45, light: 1.15, exposure: 0.9,
    seat: 0.8, back: 0.8,
    tint: [1, 0.97, 0.93], label: 'Plain'
  },
};

const TABLE_Y = -0.322;          // just under the frame's underside (FRAME_TOP - FRAME_DEPTH in board.js)

/** The table below the board, in world units (a square is ~6 cm). */
const TABLE = {
  radius: 7.4, thick: 0.16, edge: 0.06,        // the top, with a quarter-round edge of radius `edge`
  apronR: 6.35, apronH: 0.46,                  // the band under the top, set in from the rim
  height: 12.4,                                // table top to floor
  color: 0xb9aaa0, lift: 2.2, unlit: 0.82,     // unlit: a step below the board's own walnut frame
  grainRepeat: 2.6,                            // the walnut texture's repeat, every part
  pad: { half: 5.0, corner: 0.18, thick: 0.012, color: 0x1d3328 },   // the felt pad under the board
  // no envMapIntensity: with a scene environment three >= r163 overrides it with scene.environmentIntensity
  lacquer: { roughness: 0.5, specularIntensity: 0.12, specularColor: 0xffc080, clearcoat: 0.14, clearcoatRoughness: 0.46, repeat: 5 },
};

/** The table top's plane and rim, for anyone reasoning about reflections on it (tests). */
export const TABLE_TOP = Object.freeze({ y: TABLE_Y, radius: TABLE.radius });

const TABLE_CLEARANCE = 0.25;    // the lowest the 3D camera may sit above the table top
const VIGNETTE = 0.12;           // alpha of black at the corners of the 3D vignette
const SEAT_ELEVATION = 15 * Math.PI / 180;   // the seat fill's height above the horizon

/** Add three's +-0.5/255 dither to its background shader, which has none; patched once, before first use. */
function ditherBackground() {
  const lib = THREE.ShaderLib.backgroundCube;
  if (!lib || lib.fragmentShader.indexOf('cbDither') >= 0) return;

  const noise = [
    'highp float cbDither( const in vec2 uv ) {',
    '  highp float dt = dot( uv, vec2( 12.9898, 78.233 ) );',
    '  return fract( sin( mod( dt, 3.141592653589793 ) ) * 43758.5453 );',
    '}',
    'void main() {',
  ].join('\n');

  lib.fragmentShader = lib.fragmentShader
    .replace('void main() {', noise)
    .replace('#include <colorspace_fragment>', '#include <colorspace_fragment>\n\tgl_FragColor.rgb += ( cbDither( gl_FragCoord.xy ) - 0.5 ) / 255.0;');
}

/** What a glossy piece sees below the horizon: the room, then the table, then the board (degrees down). */
const TABLE_REFLECTION = { table: [0.017, 0.010, 0.006], boardTint: [1.04, 1.0, 0.94], horizon: 3, tableTo: 6, boardFrom: 16 };

const smooth01 = (t) => {
  t = clamp(t, 0, 1);
  return t * t * (3 - 2 * t);
};

/** A copy of an equirect panorama with the table and the board below the horizon (row 0 is the zenith). */
export function tableUnder(eq, boardLum = 0.15) {
  const { data, width: W, height: H } = eq.image;
  const out = new data.constructor(data.length);
  out.set(data);

  const half = data instanceof Uint16Array;
  const read = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
  const write = half ? THREE.DataUtils.toHalfFloat : (v) => v;
  const { table, boardTint, horizon, tableTo, boardFrom } = TABLE_REFLECTION;
  const board = boardTint.map((v) => v * boardLum);

  for (let y = 0; y < H; y++) {
    const below = -(0.5 - (y + 0.5) / H) * 180;          // degrees below the horizon
    if (below <= 0) continue;

    const toTable = smooth01(below / horizon),
      toBoard = smooth01((below - tableTo) / (boardFrom - tableTo));

    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const under = table[c] * (1 - toBoard) + board[c] * toBoard;
        out[i + c] = write(read(data[i + c]) * (1 - toTable) + under * toTable);
      }
    }
  }

  const tex = new THREE.DataTexture(out, W, H, eq.format, eq.type);
  for (const key of ['colorSpace', 'minFilter', 'magFilter', 'generateMipmaps', 'flipY', 'mapping']) tex[key] = eq[key];
  tex.needsUpdate = true;
  return tex;
}

/** A copy of an equirect panorama with highlights above `knee` rolled off toward 2 x knee (background only). */
export function kneeEquirect(eq, knee) {
  const { data, width: W, height: H } = eq.image;
  const out = new data.constructor(data.length);
  out.set(data);

  const half = data instanceof Uint16Array;
  const read = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
  const write = half ? THREE.DataUtils.toHalfFloat : (v) => v;

  for (let i = 0; i < W * H * 4; i += 4) {
    const r = read(data[i]),
      g = read(data[i + 1]),
      b = read(data[i + 2]);
    const l = Math.max(r, g, b);
    if (l <= knee) continue;

    const k = (knee + (l - knee) / (1 + (l - knee) / knee)) / l;
    out[i] = write(r * k);
    out[i + 1] = write(g * k);
    out[i + 2] = write(b * k);
  }

  const tex = new THREE.DataTexture(out, W, H, eq.format, eq.type);
  for (const key of ['colorSpace', 'minFilter', 'magFilter', 'generateMipmaps', 'flipY', 'mapping']) tex[key] = eq[key];
  tex.needsUpdate = true;
  return tex;
}

const BLUR_GRID = [64, 32];

/** A Gaussian blur of an equirect panorama on the sphere, `sigma` radians, into a BLUR_GRID panorama. */
export function blurEquirect(eq, sigma) {
  const { data, width: W, height: H } = eq.image;
  const half = data instanceof Uint16Array;
  const read = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
  const [w, h] = BLUR_GRID;

  // 1. box-average down to the grid
  const src = new Float32Array(w * h * 3);
  const bx = W / w, by = H / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = Math.floor(y * by); yy < Math.floor((y + 1) * by); yy++) {
        for (let xx = Math.floor(x * bx); xx < Math.floor((x + 1) * bx); xx++) {
          const i = (yy * W + xx) * 4;
          r += read(data[i]);
          g += read(data[i + 1]);
          b += read(data[i + 2]);
          n++;
        }
      }

      const o = (y * w + x) * 3;
      src[o] = r / n;
      src[o + 1] = g / n;
      src[o + 2] = b / n;
    }

  // 2. Gaussian of the angle times the texel's solid angle, per latitude pair and longitude step
  const lat = (y) => (0.5 - (y + 0.5) / h) * Math.PI;
  const inv = 1 / (2 * sigma * sigma);
  const wt = new Float32Array(h * h * w);
  for (let yk = 0; yk < h; yk++)
    for (let yj = 0; yj < h; yj++)
      for (let dx = 0; dx < w; dx++) {
        const a1 = lat(yk),
          a2 = lat(yj),
          dl = (dx / w) * 2 * Math.PI;
        const c = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dl);
        const ang = Math.acos(Math.min(1, Math.max(-1, c)));
        wt[(yk * h + yj) * w + dx] = Math.exp(-ang * ang * inv) * Math.cos(a2);
      }

  // 3. the blur
  const out = new Uint16Array(w * h * 4);
  for (let yk = 0; yk < h; yk++)
    for (let xk = 0; xk < w; xk++) {
      let r = 0, g = 0, b = 0, sum = 0;
      for (let yj = 0; yj < h; yj++) {
        const row = (yk * h + yj) * w;
        for (let xj = 0; xj < w; xj++) {
          const f = wt[row + ((xj - xk + w) % w)],
            j = (yj * w + xj) * 3;
          r += src[j] * f;
          g += src[j + 1] * f;
          b += src[j + 2] * f;
          sum += f;
        }
      }

      const o = (yk * w + xk) * 4;
      out[o] = THREE.DataUtils.toHalfFloat(r / sum);
      out[o + 1] = THREE.DataUtils.toHalfFloat(g / sum);
      out[o + 2] = THREE.DataUtils.toHalfFloat(b / sum);
      out[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }

  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  for (const key of ['colorSpace', 'flipY', 'mapping']) tex[key] = eq[key];
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** The reflections' environment for an HDRI room, blurred by `envBlur` first when it has one. */
function hdriEnvironment(pmrem, eq, envBlur, boardLum) {
  if (!envBlur) return pmrem.fromEquirectangular(eq);

  const blurred = blurEquirect(eq, envBlur);
  const under = tableUnder(blurred, boardLum);   // the blur spread the room back below the horizon
  const target = pmrem.fromEquirectangular(under);

  blurred.dispose();
  under.dispose();
  return target;
}

function equirectFromBytes(bytes) {
  const loader = new HDRLoader();
  loader.setDataType(THREE.HalfFloatType);

  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const d = loader.parse(buf);

  const tex = new THREE.DataTexture(d.data, d.width, d.height, THREE.RGBAFormat, d.type);
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.flipY = true;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

// --- the table (browser only: it needs the walnut texture) ---

/** Cubic Bezier in the (radius, height) plane: n points after p0. */
function bezierPts(p0, c0, c1, p1, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u,
      b = 3 * u * u * t,
      c = 3 * u * t * t,
      d = t * t * t;
    out.push(new THREE.Vector2(a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0], a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]));
  }
  return out;
}

/** The top's rim: underside, out, up, then a quarter-round onto the flat top. */
function tableEdgeProfile(y0) {
  const { radius: R, thick, edge: e } = TABLE;
  const pts = [new THREE.Vector2(R - 0.05, y0 - thick), new THREE.Vector2(R, y0 - thick + 0.04), new THREE.Vector2(R, y0 - e)];

  for (let i = 1; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - e + e * Math.cos(a), y0 - e + e * Math.sin(a)));
  }
  return pts;
}

/** The turned pedestal's profile, floor to the underside of the top. */
function pedestalProfile(y0) {
  const F = y0 - TABLE.height, T = y0 - TABLE.thick;
  const pts = [new THREE.Vector2(0, F), new THREE.Vector2(3.35, F)];

  const at = () => {
    const p = pts[pts.length - 1];
    return [p.x, p.y];
  };
  const curve = (c0, c1, p1, n) => pts.push(...bezierPts(at(), c0, c1, p1, n));
  const line = (x, y) => pts.push(new THREE.Vector2(x, y));

  // a half-round bead from the current point: out by `out` and back, over height `h`
  const bead = (h, out, n = 8) => {
    const [x, y] = at();
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI;
      pts.push(new THREE.Vector2(x + out * Math.sin(a), y + h * (1 - Math.cos(a)) / 2));
    }
  };

  line(3.35, F + 0.12);                                                   // the plinth's square edge
  line(3.2, F + 0.14);
  bead(0.24, 0.12);                                                       // torus
  line(3.02, F + 0.4);                                                    // fillet
  curve([2.95, F + 0.55], [2.5, F + 0.6], [2.3, F + 0.62], 6);            // cove
  curve([1.5, F + 0.7], [1.1, F + 0.95], [1.05, F + 1.35], 10);           // ogee up to the column
  line(1.05, F + 1.4);
  bead(0.18, 0.1);                                                        // collar bead
  line(0.98, F + 1.62);
  line(0.9, F + 1.7);
  curve([0.8, F + 2.6], [1.34, F + 3.6], [1.2, F + 4.9], 12);             // baluster
  curve([1.06, F + 6.4], [0.6, F + 7.2], [0.6, F + 8.6], 12);             // neck
  line(0.6, F + 9.3);
  line(0.66, F + 9.32);
  bead(0.14, 0.08, 6);                                                    // a double-bead ring on the shaft
  bead(0.14, 0.08, 6);
  line(0.6, F + 9.62);
  line(0.6, T - 1.5);                                                     // the plain shaft
  line(0.68, T - 1.48);
  bead(0.2, 0.12);                                                        // collar bead
  line(0.62, T - 1.26);
  curve([0.64, T - 1.12], [0.72, T - 1.04], [0.74, T - 1.0], 4);          // cove
  bead(0.28, 0.16, 10);                                                   // torus collar
  line(0.7, T - 0.7);
  curve([0.95, T - 0.5], [1.5, T - 0.26], [1.95, T - 0.12], 10);          // the flare into the bearer
  pts.push(new THREE.Vector2(1.95, T), new THREE.Vector2(0, T));
  return pts;
}

/** UVs for a turned part: grain along the profile by arc length, a whole number of tiles around (no seam). */
export function turnedUVs(geo, profile, segments, unit, tiles, repeat) {
  const s = [0];
  for (let j = 1; j < profile.length; j++) s.push(s[j - 1] + profile[j].distanceTo(profile[j - 1]));

  const uv = geo.attributes.uv;
  for (let i = 0; i <= segments; i++) {
    for (let j = 0; j < profile.length; j++) uv.setXY(i * profile.length + j, s[j] / unit, (i / segments) * tiles / repeat);
  }
  uv.needsUpdate = true;
  return geo;
}

/** Build the table into `group`; returns its materials and textures for the unlit switch and dispose. */
function buildTable(group, tex) {
  const L = TABLE.lacquer;
  const lacquer = makeLacquerTexture(256, 11, L.repeat);

  // the lacquer is the glossy layer; a full-strength base specular reads as a milky haze over the grain
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex, color: new THREE.Color(TABLE.color).multiplyScalar(TABLE.lift), roughness: L.roughness,
    specularIntensity: L.specularIntensity, specularColor: new THREE.Color(L.specularColor),
    clearcoat: L.clearcoat, clearcoatRoughness: L.clearcoatRoughness, clearcoatRoughnessMap: lacquer,
    dithering: true,
  });
  mat.name = 'table.walnut';

  const y0 = TABLE_Y;
  const add = (geo, name, receive = false) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.receiveShadow = receive;
    group.add(m);
    return m;
  };

  const face = new THREE.CircleGeometry(TABLE.radius - TABLE.edge, 160);
  face.rotateX(-Math.PI / 2);
  face.translate(0, y0, 0);
  add(face, 'table-top', true);
  add(new THREE.LatheGeometry(tableEdgeProfile(y0), 160), 'table-rim', true);

  const apron = new THREE.CylinderGeometry(TABLE.apronR, TABLE.apronR, TABLE.apronH, 128, 1, true);
  apron.translate(0, y0 - TABLE.thick - TABLE.apronH / 2, 0);
  add(apron, 'table-apron');

  const bead = new THREE.TorusGeometry(TABLE.apronR, 0.045, 10, 128);
  bead.rotateX(Math.PI / 2);
  bead.translate(0, y0 - TABLE.thick - TABLE.apronH, 0);
  add(bead, 'table-bead');

  // the pedestal's grain at the top's scale (the top's UVs span its diameter), one tile around
  const pedestal = pedestalProfile(y0);
  add(turnedUVs(new THREE.LatheGeometry(pedestal, 96), pedestal, 96, 2 * (TABLE.radius - TABLE.edge), 1, TABLE.grainRepeat),
    'table-pedestal');

  const P = TABLE.pad;
  const padMat = new THREE.MeshStandardMaterial({ color: P.color, roughness: 1, metalness: 0, dithering: true });
  padMat.name = 'table.felt';
  const padGeo = new THREE.ExtrudeGeometry(roundedSquare(P.half, P.corner), { depth: P.thick, bevelEnabled: false, curveSegments: 6 });
  padGeo.rotateX(-Math.PI / 2);
  padGeo.translate(0, y0, 0);
  const pad = new THREE.Mesh(padGeo, padMat);
  pad.name = 'table-pad';
  pad.receiveShadow = true;
  group.add(pad);

  // the table's own shadow on the floor: a soft disc, since the rooms' floors are pictures
  const footTex = radialShadowTexture();
  let footMat = null;
  if (footTex) {
    footMat = new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: footTex, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false,
    });

    const footGeo = new THREE.CircleGeometry(5.2, 64);
    footGeo.rotateX(-Math.PI / 2);
    footGeo.translate(0, y0 - TABLE.height + 0.005, 0);

    const foot = new THREE.Mesh(footGeo, footMat);
    foot.name = 'table-foot-shadow';
    foot.renderOrder = -1;
    group.add(foot);
  }

  return { material: mat, pad: padMat, foot: footMat, textures: [lacquer, footTex].filter(Boolean) };
}

/** A square of half-size `h` with rounded corners of radius `r`, as a THREE.Shape (XY plane). */
function roundedSquare(h, r) {
  const s = new THREE.Shape();
  s.moveTo(-h + r, -h);
  s.lineTo(h - r, -h);
  s.quadraticCurveTo(h, -h, h, -h + r);
  s.lineTo(h, h - r);
  s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h);
  s.quadraticCurveTo(-h, h, -h, h - r);
  s.lineTo(-h, -h + r);
  s.quadraticCurveTo(-h, -h, -h + r, -h);
  return s;
}

/** A soft round shadow as an alpha map (white = dark at the centre), or null without a canvas. */
function radialShadowTexture(size = 128) {
  if (typeof document === 'undefined') return null;

  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext && c.getContext('2d');
  if (!ctx || typeof ctx.createRadialGradient !== 'function' || typeof ctx.fillRect !== 'function') return null;

  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.45, '#9a9a9a');
  g.addColorStop(0.8, '#2a2a2a');
  g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/** A soft square shadow as an alpha map, full strength inside half-size `inner`, or null without a canvas. */
function rectShadowTexture(inner, size = 256) {
  if (typeof document === 'undefined') return null;

  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext && c.getContext('2d');
  if (!ctx || typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') return null;

  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = Math.abs((x + 0.5) / size * 2 - 1),
        v = Math.abs((y + 0.5) / size * 2 - 1);
      const d = Math.hypot(Math.max(0, u - inner), Math.max(0, v - inner)) / (1 - inner);
      const a = Math.max(0, 1 - d);
      const val = Math.round(255 * a * a * (3 - 2 * a));
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = val;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

const PRESETS = {
  white: { pos: [0, 7.5, 9], target: [0, 0, 0] },
  black: { pos: [0, 7.5, -9], target: [0, 0, 0] },
  top: { pos: [0, 13, 0.01], target: [0, 0, 0] },
  side: { pos: [11, 5, 0], target: [0, 0, 0] },
};
const SEAT_THETA = { white: 0, black: Math.PI }; // Spherical theta: 0 = +Z (white seat), PI = -Z (black seat)

const FOV_3D = 40;
const FOV_2D = 12;               // narrow enough to read as orthographic
const MIN_DIST = 2.5;
const MAX_DIST = 24;
const MAX_POLAR = 1.45;
const TOP_EPS = 0.0035;          // the 2D polar angle: "straight down" with a defined roll
const TWEEN_MS = 600;
const MODE_MS = 750;             // 2D <-> 3D transition
const SEAT_MS = 700;             // seat rotation (matches pieceLayer's token spin)
const BOARD_FIT_HALF = 5.0;      // half-width the seat presets must keep on screen (frame is 4.6)
const BOARD_FIT_2D = 4.95;       // 2D frames the frame plus a hair of margin
const ZOOM_2D = [0.42, 1.85];    // how far in / out of the fitted 2D distance the wheel may go
const WASH_CEIL = 2.8;           // top-face illuminance ceiling; above it exposure is pulled back

const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Wrap an angle delta into (-PI, PI]; an exact half-turn goes the positive way. */
const wrapDelta = d => {
  d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  return d <= -Math.PI + 1e-9 ? Math.PI : d;
};

/** Where a directional light at `keyPos` mirrors on the plane y = planeY seen from `cameraPos`; null if below. */
export function keyMirrorPoint(keyPos, cameraPos, planeY = TABLE_Y) {
  const len = Math.hypot(keyPos[0], keyPos[1], keyPos[2]);
  const h = cameraPos[1] - planeY;
  if (!(len > 0) || !(h > 0) || !(keyPos[1] > 0)) return null;

  const t = h / (keyPos[1] / len);      // along the reflected ray, from the plane up to the camera's height
  return { x: cameraPos[0] + t * keyPos[0] / len, z: cameraPos[2] + t * keyPos[2] / len };
}

/** Spherical theta for a seat name. */
export function seatTheta(orientation) {
  return SEAT_THETA[orientation === 'black' ? 'black' : 'white'];
}

/** Distance at which a half-extent of `half` board units exactly fills the tighter screen axis. */
export function fitDistance(half, fovDeg, aspect = 1) {
  const halfV = THREE.MathUtils.degToRad(fovDeg / 2);
  const halfH = Math.atan(Math.tan(halfV) * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1));
  return half / Math.tan(Math.min(halfV, halfH));
}

// --- lighting model (pure: the ui and the tests use it without a renderer) ---

/** Base intensities per preset; the user's `key` / `ambient` are multipliers on top. */
export const LIGHTING_PRESETS = {
  studio: {
    exposure: 1.00, key: 1.50, hemi: 0.55, fill: 0.30, env: 0.70, seat: 1.20, back: 0.40,
    keyPos: [7.4, 7.6, 1.0], shadowRadius: 5
  },
  soft: {
    exposure: 1.05, key: 0.90, hemi: 1.00, fill: 0.50, env: 0.85, seat: 1.10, back: 0.34,
    keyPos: [5.6, 9.5, 0.8], shadowRadius: 8
  },
  bright: {
    exposure: 1.30, key: 1.30, hemi: 1.15, fill: 0.55, env: 0.95, seat: 1.25, back: 0.40,
    keyPos: [7.0, 7.5, 0.8], shadowRadius: 5
  },
  flat: {
    exposure: 1.00, key: 0.00, hemi: 0.00, fill: 0.00, env: 0.00, seat: 0.00, back: 0.00,
    keyPos: [0, 10, 0], shadowRadius: 1
  },
};

/** The key's shadow map size and VSM blur samples as the lighting asks for them (QUALITY may lower them). */
const SHADOW_MAP = 2048;
const SHADOW_BLUR = 16;

export const DEFAULT_LIGHTING = { preset: 'studio', on: true, exposure: 1.0, key: 1.0, ambient: 1.0, shadows: true };

/** Merge a patch onto the lighting and clamp it; a new preset resets the values the patch does not name. */
export function resolveLighting(patch = {}, base = DEFAULT_LIGHTING) {
  const cur = { ...DEFAULT_LIGHTING, ...(base || {}) };
  const p = patch || {};
  const preset = typeof p.preset === 'string' && LIGHTING_PRESETS[p.preset] ? p.preset : cur.preset;
  const switched = preset !== cur.preset;
  const def = LIGHTING_PRESETS[preset] || LIGHTING_PRESETS.studio;

  const out = {
    preset,
    on: typeof p.on === 'boolean' ? p.on : cur.on,
    exposure: clamp(num(p.exposure, switched ? def.exposure : cur.exposure), 0.4, 1.8),
    key: clamp(num(p.key, switched ? 1 : cur.key), 0, 2),
    ambient: clamp(num(p.ambient, switched ? 1 : cur.ambient), 0, 2),
    shadows: typeof p.shadows === 'boolean' ? p.shadows : cur.shadows,
  };
  return out;
}

/** Resolved settings to the numbers the renderer and the lights take. */
export function lightingValues(resolved) {
  const r = { ...DEFAULT_LIGHTING, ...(resolved || {}) };
  const def = LIGHTING_PRESETS[r.preset] || LIGHTING_PRESETS.studio;
  const unlit = !r.on || r.preset === 'flat';

  if (unlit) {
    return {
      unlit: true, exposure: 1, toneMapping: 'none',
      key: 0, hemi: 0, fill: 0, env: 0, seat: 0, back: 0,
      shadows: false, keyPos: def.keyPos.slice(), shadowRadius: def.shadowRadius, wash: 0, washGuard: 1,
    };
  }

  const key = def.key * r.key;
  const hemi = def.hemi * r.ambient;
  const fill = def.fill * r.ambient;
  const env = def.env * r.ambient;
  const seat = def.seat * r.ambient;   // a fill, like the ambient terms
  const back = def.back * r.key;       // a light on the pieces, like the key

  // a rough proxy for the light on a flat white square; the seat fill is too low to count
  const wash = key * 0.5 + hemi * 0.6 + fill * 0.3 + env * 0.5;
  const washGuard = wash * r.exposure > WASH_CEIL ? WASH_CEIL / (wash * r.exposure) : 1;

  return {
    unlit: false, exposure: r.exposure * washGuard, toneMapping: 'aces',
    key, hemi, fill, env, seat, back,
    shadows: !!r.shadows && key > 0.02,
    keyPos: def.keyPos.slice(), shadowRadius: def.shadowRadius,
    wash, washGuard,
  };
}

// --- createView ---

/** A mesh of a piece (under a group with userData role + color), not its contact shadow or a 2D glyph card. */
function isPieceMesh(o) {
  if (!o.isMesh || (o.userData && (o.userData.contactShadow || o.userData.glyphCard))) return false;
  for (let p = o.parent; p; p = p.parent) if (p.userData && p.userData.role && p.userData.color) return true;
  return false;
}

/** Create the Three.js view inside `container`; returns the view handle (see docs/web-contract.md). */
export function createView(container, settings = {}, deps = {}) {
  settings = settings || {};
  deps = deps || {};
  ditherBackground();

  let disposed = false;
  let animations = settings.animations !== false;
  let preset = 'free';
  let mode = '3d';
  let transitioning = false;
  let orientation = settings.orientation === 'black' ? 'black' : 'white';
  let autoRotateWanted = !!settings.autoRotate;
  let fit2d = 40;
  let safe = { top: 0, right: 0, bottom: 0, left: 0 };   // px of the stage the UI floats over (setSafeArea)
  let aim2d = null;             // where the last 2D fit aimed; a target still there has not been panned away

  // --- render on demand ---
  let pending = 'content';      // the frame owed: null, 'camera', or 'content' (also redraws the shadow map)
  const stats = { frames: 0, renders: 0, shadowUpdates: 0 };
  let effects = true;           // view.effects: the edge light and the glow after the frame

  // motion quality: one policy per view mode
  let quality = normalizeQuality(settings.quality);
  const qualitySpec = () => QUALITY[quality];
  const policies = { '3d': createMotionPolicy(), '2d': createMotionPolicy() };
  const policyMode = () => (qualitySpec().adapt ? 'auto' : 'full');
  for (const p of Object.values(policies)) p.setMode(policyMode());

  let drawnRatio = 0;           // the pixel ratio the renderer is set to now
  let ratioScale = 1;           // drawnRatio over the screen's ratio
  let shadowReduced = false;    // the shadow map in use was drawn with fewer blur samples than configured
  let reduced = false;          // the last drawn frame was below full quality
  let settles = 0;

  function invalidate(kind) {
    if (kind === 'content') pending = 'content';
    else if (!pending) pending = 'camera';
  }

  // --- container ---
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
  if (cs && cs.position === 'static') container.style.position = 'relative';
  if (cs && cs.overflow === 'visible') container.style.overflow = 'hidden';

  // --- renderer ---
  const renderer = deps.renderer || new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', stencil: false });
  const screenPixelRatio = () => Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  let pixelRatio = screenPixelRatio();   // re-read on resize: the window may move to another screen
  const restRatio = () => (qualitySpec().ratioCap ? Math.min(pixelRatio, qualitySpec().ratioCap) : pixelRatio);

  drawnRatio = restRatio();
  ratioScale = drawnRatio / pixelRatio;
  renderer.setPixelRatio(drawnRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = settings.shadows !== false;
  renderer.shadowMap.type = THREE.VSMShadowMap;   // smooth penumbras; PCF stippled without TAA
  renderer.setClearColor(0x000000, 0);

  // production skips three's synchronous shader-log reads, which flooded the console with D3D notes on Windows
  if (renderer.debug) renderer.debug.checkShaderErrors = process.env.NODE_ENV !== 'production';

  // the emissive glow and the far army's edge; a stand-in renderer has neither
  const glow = renderer.isWebGLRenderer ? createGlow(renderer) : null;
  const silhouette = renderer.isWebGLRenderer ? createSilhouette(renderer, isPieceMesh, standInOf) : null;

  // triangles per pass (view.stats); renderer.info is reset once per frame in renderOnce
  const tris = renderer.isWebGLRenderer && renderer.info ? { main: 0, shadow: 0, edge: 0, glow: 0 } : null;
  const trisFull = tris ? { ...tris } : null;

  // read again on a restored context, which can be on another adapter
  const readAdapter = () => (renderer.isWebGLRenderer && typeof renderer.getContext === 'function' ? readGpuName(renderer.getContext()) : '');
  let gpuName = readAdapter();
  if (tris) renderer.info.autoReset = false;

  // the shadow map draws the modelled sets' low-detail stand-ins in place of the full meshes
  if (tris) {
    const drawShadowMap = renderer.shadowMap.render;
    renderer.shadowMap.render = function (lights, scn, cam) {
      const due = this.enabled && (this.autoUpdate || this.needsUpdate)
        && lights.some((l) => l.shadow && (l.shadow.autoUpdate || l.shadow.needsUpdate));
      if (!due) return drawShadowMap.call(this, lights, scn, cam);

      const before = renderer.info.render.triangles;
      try {
        return drawWithStandIns(scn, () => drawShadowMap.call(this, lights, scn, cam));
      } finally {
        tris.shadow += renderer.info.render.triangles - before;
      }
    };
  }

  const edgeColor = new THREE.Color(0, 0, 0);   // the edge light: the room's tint x strength (black = off)
  let edgeFocus = 12;                           // view depth of the board's centre (aimSeatLights)

  const canvas = renderer.domElement;
  Object.assign(canvas.style, { display: 'block', position: 'absolute', inset: '0', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });
  if (canvas.setAttribute) canvas.setAttribute('aria-hidden', 'false');
  if (!deps.renderer) container.appendChild(canvas);

  const onContextLost = e => {
    e.preventDefault();
  };
  canvas.addEventListener('webglcontextlost', onContextLost, false);

  // a restored context has lost every render target, the shadow map included
  const onContextRestored = () => {
    gpuName = readAdapter();
    invalidate('content');
  };
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  // --- CSS2D overlay ---
  const labelRenderer = deps.labelRenderer !== undefined ? deps.labelRenderer : new CSS2DRenderer();
  if (labelRenderer && labelRenderer.domElement) {
    Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none', overflow: 'hidden' });
    labelRenderer.domElement.className = 'labels3d';
    if (deps.labelRenderer === undefined) container.appendChild(labelRenderer.domElement);
  }

  // --- scene / camera ---
  const scene = new THREE.Scene();
  scene.background = null;
  const camera = new THREE.PerspectiveCamera(FOV_3D, 1, 0.1, 200);
  camera.position.set(...PRESETS.white.pos);
  camera.lookAt(0, 0, 0);

  // --- controls ---
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;
  controls.panSpeed = 0.9;
  controls.zoomSpeed = 1.0;
  // the right button draws annotations
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.minDistance = MIN_DIST;
  controls.maxDistance = MAX_DIST;
  controls.minPolarAngle = 0;
  controls.maxPolarAngle = MAX_POLAR;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.maxTargetRadius = 8; // the board can be scrolled around, not lost
  controls.autoRotate = autoRotateWanted;
  controls.autoRotateSpeed = 0.8;
  controls.target.set(0, 0, 0);
  controls.update();

  // a real move frees the preset and cancels a camera tween; a plain click or a mode transition does not
  const onUserMove = () => {
    if (transitioning) return;
    preset = 'free';
    cancelCameraTween();
  };
  // buttons & 5: the left or middle button is held
  const onPointerMoveUser = e => {
    if (controls.enabled && (e.buttons & 5)) onUserMove();
  };

  const onWheelUser = () => {
    if (controls.enabled && controls.enableZoom) onUserMove();
  };

  canvas.addEventListener('pointermove', onPointerMoveUser, { passive: true });
  canvas.addEventListener('wheel', onWheelUser, { passive: true });

  const onControlsMove = () => invalidate('camera');
  for (const type of ['start', 'change', 'end']) controls.addEventListener(type, onControlsMove);

  // --- lights ---
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x6b5a4a, 0.55);
  hemi.position.set(0, 10, 0);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.5);   // neutral: a warm key turned boxwood and porcelain beige
  key.position.set(...LIGHTING_PRESETS.studio.keyPos);
  key.target.position.set(0, 0, 0);
  key.castShadow = settings.shadows !== false;
  key.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -6;
  key.shadow.camera.right = 6;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = LIGHTING_PRESETS.studio.shadowRadius;
  key.shadow.blurSamples = SHADOW_BLUR;
  key.shadow.autoUpdate = false;   // redrawn on 'content' frames only: it never depends on the viewpoint
  scene.add(key);
  scene.add(key.target);

  /** The key's map size and blur for the quality level; a new size drops the old map so three builds it again. */
  function applyShadowMap() {
    const spec = qualitySpec();
    key.shadow.blurSamples = spec.blurSamples || SHADOW_BLUR;

    const size = spec.mapSize || SHADOW_MAP;
    const resize = key.shadow.mapSize.x !== size;
    if (resize) key.shadow.mapSize.set(size, size);

    if ((resize || !spec.shadows) && key.shadow.map) disposeShadowMap();
  }

  function disposeShadowMap() {
    if (key.shadow.map.depthTexture) key.shadow.map.depthTexture.dispose();
    key.shadow.dispose();
    key.shadow.map = null;
    key.shadow.mapPass = null;
  }

  const fill = new THREE.DirectionalLight(0xcfd8ff, 0.30);
  fill.position.set(-6, 5, -5);
  scene.add(fill);

  // the seat fill: from the camera's side, re-aimed every frame (aimSeatLights)
  const seat = new THREE.DirectionalLight(0xf4f6ff, 0);
  seat.castShadow = false;
  seat.name = 'seat-fill';
  scene.add(seat);
  scene.add(seat.target);

  // --- environment and table ---
  const assets = deps.assets || null;
  let envTexture = null;       // the PMREM texture materials reflect
  let envBackground = null;    // the equirect shown (blurred) behind the board, HDRI modes only
  let userBackground = null;   // settings.background, honoured in 'plain'
  let envName = 'plain';
  const envCache = new Map();  // name -> { env, bg }
  const hdriAvailable = name => !!(assets && assets.hdr && ENVIRONMENTS[name] && ENVIRONMENTS[name].hdr && assets.hdr[ENVIRONMENTS[name].hdr]);

  function buildEnvironment(name) {
    if (envCache.has(name)) return envCache.get(name);

    const spec = ENVIRONMENTS[name] || ENVIRONMENTS.plain;
    const pmrem = new THREE.PMREMGenerator(renderer);
    let out;
    try {
      if (spec.hdr && hdriAvailable(name)) {
        const eq = equirectFromBytes(assets.hdr[spec.hdr]);
        // the pieces reflect the table below the horizon, not the floor
        const reflected = tableUnder(eq, spec.under);
        const bg = spec.bgKnee ? kneeEquirect(eq, spec.bgKnee) : eq;
        out = { env: hdriEnvironment(pmrem, reflected, spec.envBlur, spec.under).texture, bg };
        reflected.dispose();
        if (bg !== eq) eq.dispose();
      } else {
        const room = new RoomEnvironment();
        out = { env: pmrem.fromScene(room, spec.envBlur || 0.04).texture, bg: null };
        if (typeof room.dispose === 'function') room.dispose();
      }
    } finally {
      pmrem.dispose();
    }

    envCache.set(name, out);
    return out;
  }

  // shown with the HDRI rooms only
  const table = new THREE.Group();
  table.name = 'table';
  table.visible = false;
  scene.add(table);

  let tableParts = null;       // { material, textures } once built
  if (deps.environment !== false && assets && assets.wood && assets.wood.frame && typeof document !== 'undefined') {
    const tex = new THREE.TextureLoader().load(assets.wood.frame, () => invalidate('content'));   // decoded: draw it
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(TABLE.grainRepeat, TABLE.grainRepeat);
    tex.anisotropy = 8;
    tableParts = buildTable(table, tex);
  }

  // a floor for a room without one (ENVIRONMENTS[].floor), fading out at its rim
  const floorTex = radialShadowTexture(256);
  const floorMat = floorTex ? new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.92, metalness: 0, alphaMap: floorTex, transparent: true, depthWrite: false, dithering: true,
  }) : null;
  const floor = floorMat ? new THREE.Mesh(new THREE.CircleGeometry(22, 96), floorMat) : null;
  if (floor) {
    floor.geometry.rotateX(-Math.PI / 2);
    floor.geometry.translate(0, TABLE_Y - TABLE.height, 0);
    floor.name = 'studio-floor';
    floor.renderOrder = -2;
    floor.visible = false;
    scene.add(floor);
  }

  // Plain's drop shadow under the floating board, nudged away from the key
  const dropTex = deps.environment === false ? null : rectShadowTexture(0.8);
  const dropMat = dropTex ? new THREE.MeshBasicMaterial({
    color: 0x000000, alphaMap: dropTex, transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false,
  }) : null;
  const drop = dropMat ? new THREE.Mesh(new THREE.PlaneGeometry(11.6, 11.6), dropMat) : null;
  if (drop) {
    drop.geometry.rotateX(-Math.PI / 2);
    drop.geometry.translate(-0.18, TABLE_Y - 0.02, 0.1);
    drop.name = 'plain-drop-shadow';
    drop.renderOrder = -1;
    drop.visible = false;
    scene.add(drop);
  }

  /** Lighting "off" for the table: the board's unlit switch, then a step darker (TABLE.unlit). */
  function setTableUnlit(on) {
    const m = tableParts && tableParts.material;
    if (!m || !!m.userData.litBackup === on) return;

    setMaterialUnlit(m, on);
    if (on) m.emissive.multiplyScalar(TABLE.unlit);
    if (tableParts.pad) setMaterialUnlit(tableParts.pad, on);
  }

  // --- vignette (3D only; a CSS overlay, never hit-tested, not in the canvas pixels) ---
  const vignette = !deps.renderer && typeof document !== 'undefined' ? document.createElement('div') : null;
  if (vignette) {
    vignette.className = 'vignette3d';
    vignette.setAttribute('aria-hidden', 'true');
    Object.assign(vignette.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', transition: `opacity ${MODE_MS}ms ease`,
      opacity: settings.viewMode === '2d' ? '0' : '1',   // a 2D boot must not fade one out
      background: `radial-gradient(ellipse farthest-corner at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,${VIGNETTE * 0.45}) 78%, rgba(0,0,0,${VIGNETTE}) 100%)`,
    });

    if (canvas.parentNode === container) container.insertBefore(vignette, canvas.nextSibling);
    else container.appendChild(vignette);
  }

  function syncVignette() {
    if (vignette) vignette.style.opacity = mode === '3d' ? '1' : '0';
  }

  function applyEnvironment() {
    if (deps.environment === false) return;
    invalidate('content');

    let e;
    try {
      e = buildEnvironment(envName);
    } catch (err) {
      console.warn('[scene] environment failed; falling back to plain', err);
      envName = 'plain';
      e = buildEnvironment('plain');
    }
    envTexture = e.env;
    envBackground = e.bg;

    const spec = ENVIRONMENTS[envName] || ENVIRONMENTS.plain;
    const rot = spec.rot || 0;
    if (scene.environmentRotation) scene.environmentRotation.set(0, rot, 0);
    if (scene.backgroundRotation) scene.backgroundRotation.set(0, rot, 0);

    const room = !!envBackground && mode !== '2d';
    if (room) {
      scene.background = envBackground;
      scene.backgroundBlurriness = spec.blur;
      scene.backgroundIntensity = spec.bg;
    } else {
      scene.background = userBackground;
      scene.backgroundBlurriness = 0;
      scene.backgroundIntensity = 1;
    }

    table.visible = room;
    if (floor) {
      floor.visible = room && spec.floor !== undefined;
      if (floor.visible) floorMat.color.set(spec.floor);
    }
    if (drop) drop.visible = !envBackground && mode !== '2d';
  }

  // --- resize ---
  function resize() {
    if (disposed) return;

    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;

    invalidate('camera');   // a resized canvas is cleared, and the projection changes with it

    const ratio = screenPixelRatio();
    if (ratio !== pixelRatio) {
      pixelRatio = ratio;
      setDrawnRatio(restRatio());
    }

    renderer.setSize(w, h, false);
    if (labelRenderer) labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (mode === '2d' && !transitioning) refit2d();
  }

  resize();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(container);
  else if (typeof window !== 'undefined') window.addEventListener('resize', resize);

  // a new screen's pixel ratio resizes nothing in CSS pixels: a one-shot media query catches it instead
  let ratioQuery = null;

  function onRatioChange() {
    if (disposed) return;
    resize();
    watchPixelRatio();
  }

  function watchPixelRatio() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    ratioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (ratioQuery && ratioQuery.addEventListener) ratioQuery.addEventListener('change', onRatioChange, { once: true });
  }

  watchPixelRatio();

  // --- tweens ---
  const tweens = new Set();
  const nowMs = typeof deps.now === 'function' ? deps.now
    : () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  /** Run an eased tween; returns cancel(). `kind` is what each step invalidates: 'content' or 'camera'. */
  function tween({ duration = TWEEN_MS, onUpdate, onDone, ease = easeInOutCubic, kind = 'content' } = {}) {
    const entry = { start: nowMs(), duration: Math.max(0, duration), onUpdate, onDone, ease, kind };
    invalidate(kind);

    if (entry.duration === 0) {
      onUpdate && onUpdate(1);
      onDone && onDone();
      return () => {};
    }

    tweens.add(entry);
    return () => tweens.delete(entry);
  }

  function stepTweens(now) {
    for (const t of tweens) {
      invalidate(t.kind);
      const raw = clamp((now - t.start) / t.duration, 0, 1);
      try {
        t.onUpdate && t.onUpdate(t.ease(raw));
      } catch (err) {
        console.error(err);
      }

      if (raw >= 1) {
        tweens.delete(t);
        try {
          t.onDone && t.onDone();
        } catch (err) {
          console.error(err);
        }
      }
    }
  }

  // --- camera tweens (one at a time; a cancelled one resolves false, nothing rejects) ---
  let camTween = null;

  function cancelCameraTween() {
    const t = camTween;
    if (!t) return;

    camTween = null;
    t.cancel();
    t.settle(false);
  }

  function startCameraTween({ duration, onUpdate, onDone, onSettle }) {
    cancelCameraTween();

    let settled = false;
    let resolveFn;
    const promise = new Promise(r => { resolveFn = r; });
    const entry = {
      cancel: () => {},
      settle(ok) {
        if (settled) return;
        settled = true;
        try {
          onSettle && onSettle(ok);
        } catch (err) {
          console.error('[scene] camera tween settle failed', err);
        }
        resolveFn(ok);
      },
    };
    camTween = entry;

    const cancel = tween({
      duration,
      kind: 'camera',
      onUpdate,
      onDone() {
        if (camTween === entry) camTween = null;
        try {
          onDone && onDone();
        } catch (err) {
          console.error('[scene] camera tween finish failed', err);
        }
        entry.settle(true);
      },
    });
    entry.cancel = cancel;
    return promise;
  }

  const UP = new THREE.Vector3(0, 1, 0);
  const BOARD_CENTRE = new THREE.Vector3(0, 0, 0);
  const _sph = new THREE.Spherical();
  const _v = new THREE.Vector3();

  function currentSpherical() {
    _v.copy(camera.position).sub(controls.target);
    _sph.setFromVector3(_v);
    return { radius: _sph.radius, phi: _sph.phi, theta: _sph.theta };
  }

  /** The seat's azimuth: about the board centre in 3D, about the camera's own target in 2D. */
  function boardTheta() {
    const o = mode === '2d' ? controls.target : BOARD_CENTRE;
    return Math.atan2(camera.position.x - o.x, camera.position.z - o.z);
  }

  function applySpherical(target, radius, phi, theta) {
    _sph.set(radius, phi, theta).makeSafe();
    controls.target.copy(target);
    camera.position.copy(target).add(_v.setFromSpherical(_sph));
    camera.lookAt(controls.target);
  }

  // OrbitControls keeps damping momentum in private deltas; clear them so a tween is not fought
  function stillControls() {
    if (controls._sphericalDelta) controls._sphericalDelta.set(0, 0, 0);
    if (controls._panOffset) controls._panOffset.set(0, 0, 0);
  }

  const animateOn = () => animations && settings.animations !== false;

  /** Animate the camera to { target, radius, phi, theta, fov } (each optional). Returns Promise<boolean>. */
  function flyTo({ target, radius, phi, theta, fov, duration = TWEEN_MS, onDone, onSettle } = {}) {
    stillControls();

    const from = currentSpherical();
    const fromTarget = controls.target.clone();
    const toTarget = target ? new THREE.Vector3().copy(target) : fromTarget.clone();
    const loDist = Math.min(controls.minDistance, MIN_DIST);
    const hiDist = Math.max(controls.maxDistance, MAX_DIST);
    const toRadius = clamp(num(radius, from.radius), loDist, hiDist);
    const toPhi = clamp(num(phi, from.phi), 0, Math.PI - 1e-4);
    const fromFov = camera.fov;
    const toFov = num(fov, fromFov);
    const dTheta = theta == null ? 0 : wrapDelta(theta - from.theta);
    const ms = animateOn() ? duration : 0;
    const t0 = fromTarget.clone(), t1 = toTarget.clone();
    const tmp = new THREE.Vector3();

    return startCameraTween({
      duration: ms,
      onUpdate(t) {
        tmp.lerpVectors(t0, t1, t);
        applySpherical(tmp, from.radius + (toRadius - from.radius) * t, from.phi + (toPhi - from.phi) * t, from.theta + dTheta * t);

        if (toFov !== fromFov) {
          camera.fov = fromFov + (toFov - fromFov) * t;
          camera.updateProjectionMatrix();
        }
      },
      onDone,
      onSettle,
    });
  }

  // push a preset back when the pane is narrow so the whole board stays on screen
  function fitScale(pos, target) {
    const d = Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
    const needed = fitDistance(BOARD_FIT_HALF, camera.fov, camera.aspect);
    return clamp(Math.max(1, needed / d), 1, MAX_DIST / d);
  }

  // --- view mode ---
  const modeHooks = new Set();
  let pose3d = null; // the exact 3D pose to restore

  function snapshotPose() {
    return {
      position: camera.position.clone(),
      target: controls.target.clone(),
      up: camera.up.clone(),
      fov: camera.fov, near: camera.near, far: camera.far, zoom: camera.zoom,
      preset,
      minDistance: controls.minDistance, maxDistance: controls.maxDistance,
      minPolarAngle: controls.minPolarAngle, maxPolarAngle: controls.maxPolarAngle,
      enableRotate: controls.enableRotate,
      touches: { ...controls.touches },
      seat: orientation,          // the seat this pose was taken from (see seatPose)
    };
  }

  /** The saved 3D pose turned about the vertical axis to the seat the board is at now (a Flip made in 2D). */
  function seatPose(p) {
    if (!p || p.seat === orientation) return p;

    const turn = seatTheta(orientation) - seatTheta(p.seat);
    const q = { ...p, position: p.position.clone().applyAxisAngle(UP, turn), target: p.target.clone().applyAxisAngle(UP, turn), seat: orientation };
    if (q.preset === 'white' || q.preset === 'black') q.preset = orientation;
    return q;
  }

  /** The lens and the up vector only, for a superseded 2D -> 3D transition: the 2D lens must not survive. */
  function restoreLens(p) {
    camera.up.copy(p.up);
    camera.fov = p.fov;
    camera.near = p.near;
    camera.far = p.far;
    camera.zoom = p.zoom;
    camera.updateProjectionMatrix();
  }

  function restorePose(p) {
    camera.up.copy(p.up);
    camera.position.copy(p.position);
    controls.target.copy(p.target);
    camera.fov = p.fov;
    camera.near = p.near;
    camera.far = p.far;
    camera.zoom = p.zoom;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);

    controls.minDistance = p.minDistance;
    controls.maxDistance = p.maxDistance;
    controls.minPolarAngle = p.minPolarAngle;
    controls.maxPolarAngle = p.maxPolarAngle;
    controls.enableRotate = p.enableRotate;
    controls.touches = { ...p.touches };
    controls.autoRotate = autoRotateWanted;   // loosenLimits parked it for the transition
    stillControls();
    controls.update(0);
  }

  /** Limits that hold while a mode transition is in flight: wide enough not to clamp the path. */
  function loosenLimits() {
    controls.minPolarAngle = 0;
    controls.maxPolarAngle = MAX_POLAR;
    controls.minDistance = 1;
    controls.maxDistance = 1000;
    controls.enableRotate = false;
    controls.autoRotate = false;
  }

  function applyModeLimits() {
    if (mode === '2d') {
      controls.enableRotate = false;
      controls.minPolarAngle = TOP_EPS;
      controls.maxPolarAngle = TOP_EPS;
      controls.minDistance = fit2d * ZOOM_2D[0];
      controls.maxDistance = fit2d * ZOOM_2D[1];
      controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
      controls.autoRotate = false;
    } else {
      controls.enableRotate = true;
      controls.minPolarAngle = 0;
      controls.maxPolarAngle = MAX_POLAR;
      controls.minDistance = MIN_DIST;
      controls.maxDistance = MAX_DIST;
      controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      controls.autoRotate = autoRotateWanted;
    }
    stillControls();
  }

  /** The 2D distance and aim that fit the board inside the part of the stage the floating UI leaves free. */
  function frame2d(theta) {
    const W = container.clientWidth || 1, H = container.clientHeight || 1;
    const fy = Math.max(0.3, (H - safe.top - safe.bottom) / H),
      fx = Math.max(0.3, (W - safe.left - safe.right) / W);
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV_2D / 2));
    const dist = Math.max(BOARD_FIT_2D / (tanV * fy), BOARD_FIT_2D / (tanV * (W / H) * fx));
    const wpp = 2 * dist * tanV / H;                                   // world units per px on the board
    const down = (safe.top - safe.bottom) / 2 * wpp,
      right = (safe.left - safe.right) / 2 * wpp;

    // screen up is away from the seat, screen right is (cos, -sin) of the seat azimuth
    const target = new THREE.Vector3(-Math.sin(theta) * down - Math.cos(theta) * right, 0, -Math.cos(theta) * down + Math.sin(theta) * right);
    return { dist, target };
  }

  /** Re-frame 2D, keeping the zoom ratio; the aim follows the fit unless the player panned away. */
  function refit2d(recentre = false) {
    invalidate('camera');

    const prevFit = fit2d;
    const f = frame2d(boardTheta());
    fit2d = f.dist;

    const dist = camera.position.distanceTo(controls.target);
    const ratio = recentre ? 1 : clamp(prevFit > 0 ? dist / prevFit : 1, ZOOM_2D[0], ZOOM_2D[1]);
    const unpanned = !aim2d || controls.target.distanceTo(aim2d) < 1e-3;
    const target = recentre || unpanned ? f.target : controls.target.clone();
    aim2d = f.target;

    applySpherical(target, fit2d * ratio, TOP_EPS, boardTheta());
    applyModeLimits();
    updateClip(true);
  }

  /** Pull the clip planes in around the 2D distance so the overlay stack does not z-fight the board. */
  function updateClip(force) {
    if (mode !== '3d') {
      const d = camera.position.distanceTo(controls.target);
      const near = Math.max(0.5, d * 0.45);
      const far = d * 1.9 + 20;

      if (force || Math.abs(camera.near - near) > near * 0.02 || Math.abs(camera.far - far) > far * 0.02) {
        camera.near = near;
        camera.far = far;
        camera.updateProjectionMatrix();
      }
    } else if (camera.near !== 0.1 || camera.far !== 200) {
      camera.near = 0.1;
      camera.far = 200;
      camera.updateProjectionMatrix();
    }
  }

  function emitMode(previous) {
    for (const fn of modeHooks) {
      try {
        fn(mode, previous);
      } catch (err) {
        console.error('[scene] view-mode hook failed', err);
      }
    }
  }

  /** '2d' = locked straight overhead, orbit off; '3d' = the pose we left. Returns Promise<boolean>. */
  function setViewMode(next, opts = {}) {
    const want = next === '2d' ? '2d' : '3d';
    const animate = opts.animate !== false && animateOn();
    const duration = animate ? num(opts.duration, MODE_MS) : 0;

    if (want === mode) {
      if (want === '2d') refit2d();
      return Promise.resolve(true);
    }

    const previous = mode;
    cancelCameraTween();
    if (want === '2d') pose3d = snapshotPose();
    mode = want;
    applyEnvironment();      // 2D drops the room and the table: a flat board on the page colour
    applySeatLights();
    syncVignette();
    transitioning = true;
    loosenLimits();
    emitMode(previous);

    if (want === '2d') {
      const f = frame2d(seatTheta(orientation));
      fit2d = f.dist;
      aim2d = f.target;

      return flyTo({
        target: f.target, radius: fit2d, phi: TOP_EPS, theta: seatTheta(orientation), fov: FOV_2D, duration,
        onSettle() {
          if (disposed || mode !== '2d') return;

          transitioning = false;
          applySpherical(controls.target, camera.position.distanceTo(controls.target), TOP_EPS, boardTheta());
          applyModeLimits();
          updateClip(true);
          preset = 'top';
        },
      });
    }

    const p = seatPose(pose3d) || {
      position: new THREE.Vector3(...PRESETS[orientation].pos), target: BOARD_CENTRE.clone(), up: new THREE.Vector3(0, 1, 0),
      fov: FOV_3D, near: 0.1, far: 200, zoom: 1, preset: orientation,
      minDistance: MIN_DIST, maxDistance: MAX_DIST, minPolarAngle: 0, maxPolarAngle: MAX_POLAR,
      enableRotate: true, touches: { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }, seat: orientation,
    };
    _v.copy(p.position).sub(p.target);
    _sph.setFromVector3(_v);

    return flyTo({
      target: p.target, radius: _sph.radius, phi: _sph.phi, theta: _sph.theta, fov: p.fov, duration,
      onSettle(ok) {
        if (disposed || mode !== '3d') return;

        transitioning = false;
        if (ok) {
          restorePose(p);   // bit-for-bit, not "wherever the easing landed"
          preset = p.preset;
        } else {
          restoreLens(p);   // superseded: keep their camera, take back the lens
          applyModeLimits();
        }
      },
    });
  }

  // --- seat rotation ---

  /** Turn the camera and the pan target about the board's vertical axis. Returns Promise<boolean>. */
  function rotateSeat(o, opts = {}) {
    const want = o === 'black' ? 'black' : 'white';
    const animate = opts.animate !== false && animateOn();
    const duration = animate ? num(opts.duration, SEAT_MS) : 0;
    const delta = wrapDelta(seatTheta(want) - boardTheta());

    orientation = want;
    if (preset === 'white' || preset === 'black' || preset === 'free') preset = want;

    if (Math.abs(delta) < 1e-4) {
      cancelCameraTween();
      return Promise.resolve(true);
    }

    const startPos = camera.position.clone();
    const startTarget = controls.target.clone();
    const startAim = aim2d ? aim2d.clone() : null;   // the 2D fit's aim turns with the board (see refit2d)
    const tmpP = new THREE.Vector3(), tmpT = new THREE.Vector3();

    const place = a => {
      tmpP.copy(startPos).applyAxisAngle(UP, a);
      tmpT.copy(startTarget).applyAxisAngle(UP, a);
      camera.position.copy(tmpP);
      controls.target.copy(tmpT);
      camera.lookAt(controls.target);
      if (startAim) aim2d = startAim.clone().applyAxisAngle(UP, a);
    };

    stillControls();
    return startCameraTween({
      duration,
      onUpdate(t) { place(delta * t); },
      onDone() {
        place(delta);
        stillControls();
        controls.update(0);
      },
    });
  }

  // --- lighting ---
  let lighting = resolveLighting(settings.lighting || {}, DEFAULT_LIGHTING);
  if (typeof settings.shadows === 'boolean' && (!settings.lighting || typeof settings.lighting.shadows !== 'boolean')) {
    lighting = resolveLighting({ shadows: settings.shadows }, lighting);
  }

  let applied = lightingValues(lighting);
  let matSet = null;
  const lightHooks = new Set();

  function markMaterialsDirty() {
    scene.traverse(o => {
      const m = o.material;
      if (!m) return;

      if (Array.isArray(m)) m.forEach(x => { x.needsUpdate = true; });
      else m.needsUpdate = true;
    });
  }

  function applyLighting(prevShadows) {
    invalidate('content');

    const v = applied;
    const envSpec = ENVIRONMENTS[envName] || ENVIRONMENTS.plain;

    // the HDRI rooms use PBR Neutral, which keeps base colours true; 'plain' keeps ACES
    renderer.toneMapping = v.toneMapping === 'none' ? THREE.NoToneMapping
      : (envSpec.hdr ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping);
    renderer.toneMappingExposure = v.exposure * (v.toneMapping === 'none' ? 1 : (envSpec.exposure || 1));

    hemi.intensity = v.hemi * envSpec.light;
    key.intensity = v.key;
    fill.intensity = v.fill * envSpec.light;
    key.position.set(v.keyPos[0], v.keyPos[1], v.keyPos[2]);
    key.shadow.radius = v.shadowRadius;
    scene.environment = v.env > 0 ? envTexture : null;
    scene.environmentIntensity = v.env * envSpec.env;

    const shadows = v.shadows && qualitySpec().shadows;
    renderer.shadowMap.enabled = shadows;
    key.castShadow = shadows;
    if (prevShadows !== shadows) markMaterialsDirty();

    if (matSet && typeof matSet.setUnlit === 'function') {
      try {
        matSet.setUnlit(v.unlit);
      } catch (err) {
        console.warn('[scene] matSet.setUnlit failed', err);
      }
    }
    setTableUnlit(v.unlit);
    applySeatLights();

    const payload = view.lighting;
    for (const fn of lightHooks) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[scene] lighting hook failed', err);
      }
    }
  }

  /** The seat fill's and the edge light's strength: lighting times room, in 3D only. */
  function applySeatLights() {
    invalidate('content');

    const v = applied;
    const envSpec = ENVIRONMENTS[envName] || ENVIRONMENTS.plain;
    const on = mode === '3d' ? 1 : 0;
    seat.intensity = v.seat * (envSpec.seat ?? 1) * on;
    edgeColor.setRGB(...(envSpec.tint || [1, 1, 1])).multiplyScalar(v.back * (envSpec.back ?? 1) * on);
  }

  const _aim = new THREE.Vector3();

  /** Aim the seat fill from behind the camera's look direction, and take the board centre's view depth. */
  function aimSeatLights() {
    const c = camera.position, t = controls.target;
    let dx = c.x - t.x,
      dz = c.z - t.z,
      dl = Math.hypot(dx, dz);

    // straight down: aim from the seat
    if (dl < 1e-6) {
      dx = Math.sin(boardTheta());
      dz = Math.cos(boardTheta());
      dl = 1;
    }

    const se = SEAT_ELEVATION;
    seat.position.set(dx / dl * 10 * Math.cos(se), 10 * Math.sin(se), dz / dl * 10 * Math.cos(se));
    seat.target.position.set(0, 0, 0);

    camera.updateMatrixWorld();
    edgeFocus = -_aim.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse).z;
  }

  /** 3D: hold the orbit target on or above the table top, and lift a camera put lower back to TABLE_CLEARANCE. */
  function keepAboveTable() {
    if (mode !== '3d' || transitioning) return;

    if (controls.target.y < TABLE_Y) {
      const d = TABLE_Y - controls.target.y;
      controls.target.y += d;
      camera.position.y += d;
    }

    const floor = TABLE_Y + TABLE_CLEARANCE;
    if (camera.position.y < floor) {
      camera.position.y = floor;
      camera.lookAt(controls.target);
    }
  }

  // --- render loop ---
  const hooks = new Set();
  let raf = 0;
  let lastFrameMs = 0;  // 0 = "first frame after a boot or a tab hide"; dt is 0 for that one
  let elapsed = 0;      // our own accumulator so onFrame hooks see continuous time across tab hides
  let hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';

  function renderOnce() {
    const info = tris ? renderer.info.render : null;
    if (tris) {
      renderer.info.reset();
      tris.shadow = 0;
      tris.edge = 0;
      tris.glow = 0;
    }

    renderer.render(scene, camera);
    let mark = info ? info.triangles : 0;
    if (tris) tris.main = mark - tris.shadow;

    if (view.effects && qualitySpec().effects) {
      // lit 3D only (edgeColor is black otherwise; see applySeatLights)
      if (silhouette) silhouette.render(scene, camera, { color: edgeColor, focus: edgeFocus, pxPerCss: drawnRatio });
      if (tris) {
        tris.edge = info.triangles - mark;
        mark = info.triangles;
      }

      // lit 3D only: unlit parks colour in `emissive`, and 2D's flat tokens have no windows
      if (glow && mode === '3d' && !applied.unlit) glow.render(scene, camera, ratioScale);
      if (tris) tris.glow = info.triangles - mark;
    }

    // a full frame drew every pass: with shadows off there is no map to wait for
    if (tris && (tris.shadow > 0 || !renderer.shadowMap.enabled)) Object.assign(trisFull, tris);
    if (labelRenderer) labelRenderer.render(scene, camera);
  }

  // what the last drawn frame was drawn from
  const SAFETY_NET_MS = 500;
  let lastRenderMs = 0;
  const camSeen = new Float64Array(33);
  const camNow = new Float64Array(33);
  let sceneSeen = [];
  let sceneNow = [];

  /** The camera as drawn: world matrix, projection, and the canvas size (a resize clears the canvas). */
  function readCamera(out) {
    const w = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) {
      out[i] = w[i];
      out[16 + i] = p[i];
    }
    out[32] = canvas.width * 65536 + canvas.height;
    return out;
  }

  /** Every non-light object's place, visibility and material state, flattened. */
  function readScene(out) {
    out.length = 0;
    scene.traverse((o) => {
      if (o.isLight) return;

      const p = o.position, q = o.quaternion, s = o.scale;
      out.push(o.id, o.visible ? 1 : 0, o.children.length, p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z);

      if (!o.matrixAutoUpdate) {
        const e = o.matrix.elements;
        for (let i = 0; i < 16; i++) out.push(e[i]);
      }

      const m = o.material;
      if (m && !Array.isArray(m)) out.push(m.id, m.version, m.opacity, m.visible ? 1 : 0);
    });
    return out;
  }

  const sameArray = (a, b, eps = 0) => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!(Math.abs(a[i] - b[i]) <= eps)) return false;
    return true;
  };

  // below this per-element change the camera counts as stopped: damping never quite reaches zero
  const CAMERA_EPS = 1e-6;
  let cameraMoving = false;     // the last drawn frames followed a moving camera; its stop is still to be drawn
  const held = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), target: new THREE.Vector3() };

  function holdCamera() {
    held.position.copy(camera.position);
    held.quaternion.copy(camera.quaternion);
    held.target.copy(controls.target);
  }

  // OrbitControls' spherical round trip can move a resting camera by an ulp every frame
  function undoCreep() {
    const q = camera.quaternion;
    const h = held.quaternion;
    const drift = camera.position.manhattanDistanceTo(held.position)
      + controls.target.manhattanDistanceTo(held.target)
      + Math.abs(q.x - h.x) + Math.abs(q.y - h.y) + Math.abs(q.z - h.z) + Math.abs(q.w - h.w);
    if (drift === 0 || drift > CAMERA_EPS) return;

    camera.position.copy(held.position);
    camera.quaternion.copy(held.quaternion);
    controls.target.copy(held.target);
    camera.updateMatrixWorld();
  }

  // a 'content' frame owes one more: shaders compiled for it can leave a few pixels unsettled
  let afterContent = false;

  /** Set the renderer's pixel ratio, right before a draw in the same task. */
  function setDrawnRatio(ratio) {
    ratioScale = ratio / pixelRatio;
    if (ratio === drawnRatio) return;

    drawnRatio = ratio;
    renderer.setPixelRatio(ratio);
    // three rounds the viewport but floors the canvas: rebinding the canvas derives the viewport with floor
    if (ratio !== pixelRatio && typeof renderer.setRenderTarget === 'function') renderer.setRenderTarget(null);
  }

  const shadowsInUse = () => !!(renderer.shadowMap.enabled && key.castShadow);

  /** The renderer holds something below full quality that the picture at rest must not keep. */
  const needsSettle = () => drawnRatio !== restRatio() || (shadowReduced && shadowsInUse());

  /** Draw one frame at motion level `level` (0 = full); `restore` also redraws a cheaper-blurred shadow map. */
  function renderFrame(kind, level = 0, restore = false) {
    pending = null;

    const L = MOTION_LEVELS[level] || MOTION_LEVELS[0];
    setDrawnRatio(restRatio() * L.ratio);

    if (kind === 'content' || (!key.shadow.map && renderer.isWebGLRenderer) || (restore && shadowReduced)) key.shadow.needsUpdate = true;
    const shadowDue = shadowsInUse() && key.shadow.needsUpdate;
    const blur = key.shadow.blurSamples;   // the configured count, put back after the draw
    if (shadowDue && L.blurSamples && L.blurSamples < blur) key.shadow.blurSamples = L.blurSamples;
    const drawnBlur = key.shadow.blurSamples;

    try {
      renderOnce();
    } catch (err) {
      invalidate(kind);   // a failed frame stays owed
      throw err;
    } finally {
      key.shadow.blurSamples = blur;
    }

    if (shadowDue) shadowReduced = drawnBlur < blur;
    else if (!shadowsInUse()) shadowReduced = false;   // no map in use; the next one is drawn fresh
    reduced = drawnRatio !== restRatio() || (shadowReduced && shadowsInUse());
    afterContent = kind === 'content';

    stats.renders++;
    if (shadowDue) stats.shadowUpdates++;
    lastRenderMs = nowMs();
    readCamera(camSeen);
    sceneSeen = readScene(sceneSeen);
  }

  // motion bookkeeping for the loop
  let drewLastTick = false;     // the previous animation frame drew a frame that was not a settle or safety-net one
  let lastWasMotion = false;    // the last drawn frame was a motion frame
  let lastDrawTick = -Infinity; // when (the loop's clock) the last drawn frame started

  function frame() {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    stats.frames++;

    const drewPrev = drewLastTick;
    drewLastTick = false;
    if (hidden) return;

    const t = nowMs();
    const dt = lastFrameMs ? Math.min((t - lastFrameMs) / 1000, 0.1) : 0;
    lastFrameMs = t;
    elapsed += dt;
    stepTweens(t);

    const resting = !cameraMoving && !controls.autoRotate;
    if (resting) holdCamera();
    controls.update(dt);
    if (resting) undoCreep();

    keepAboveTable();
    aimSeatLights();
    if (!transitioning) updateClip(false);

    // a hook returns false (nothing changed), 'camera' (only the viewpoint), or anything else (the scene)
    for (const fn of hooks) {
      let r;
      try {
        r = fn(dt, elapsed);
      } catch (err) {
        console.error('[scene] frame hook failed', err);
      }
      if (r !== false) invalidate(r === 'camera' ? 'camera' : 'content');
    }

    if (pending !== 'content') {
      sceneNow = readScene(sceneNow);
      if (!sameArray(sceneNow, sceneSeen)) invalidate('content');
    }

    const owedBefore = pending;
    const followUp = afterContent;
    if (afterContent) {
      afterContent = false;
      invalidate('camera');
    }

    readCamera(camNow);
    let cameraOwes = false;
    if (!sameArray(camNow, camSeen, CAMERA_EPS)) {
      cameraMoving = true;
      cameraOwes = true;
      invalidate('camera');
    } else if (cameraMoving) {
      cameraMoving = false;
      stillControls();
      if (!sameArray(camNow, camSeen)) {
        cameraOwes = true;
        invalidate('camera');
      }
    }

    // nothing owed for settleMs after frames below full quality: one full frame, then idle
    let settle = false;
    if (!pending && needsSettle() && t - lastRenderMs >= MOTION.settleMs) {
      pending = 'camera';
      settle = true;
    }

    let quiet = settle;           // a settle or safety-net frame: the picture at rest, it starts no motion
    if (!pending && t - lastRenderMs >= SAFETY_NET_MS) {
      pending = 'camera';
      quiet = true;
    }
    if (!pending) return;

    // which frames count as motion: docs/rendering.md, Motion quality
    const followUpOnly = followUp && !owedBefore && !cameraOwes;
    const motion = !quiet && (followUpOnly ? lastWasMotion
      : drewPrev || (lastWasMotion && t - lastDrawTick < MOTION.settleMs));

    const policy = policies[mode];
    if (motion && drewPrev && lastWasMotion) policy.sample(t - lastDrawTick);
    lastDrawTick = quiet ? -Infinity : t;
    lastWasMotion = motion;
    drewLastTick = !quiet;

    renderFrame(pending, motion ? policy.level : 0, !motion);
    if (settle) settles++;
  }

  const onVisibility = () => {
    hidden = document.visibilityState === 'hidden';
    lastFrameMs = 0; // do not bill the hidden stretch to the next frame's dt
    drewLastTick = false; // the first frame after a hidden stretch starts no motion
    if (!hidden) invalidate('content');
  };

  const offRedraw = onRedraw(invalidate);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  if (typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);

  // --- pointer helpers ---
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  function setRay(clientX, clientY) {
    const r = container.getBoundingClientRect();
    if (!r.width || !r.height) return false;

    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    return true;
  }

  // --- public API ---
  const view = {
    scene, camera, renderer, labelRenderer, controls, container,
    lights: { hemi, key, fill, seat },

    /** The far army's edge light as it stands: the colour it adds (black = off) and the board centre's view depth. */
    get edgeLight() { return { color: edgeColor.clone(), focus: edgeFocus }; },

    /** false draws the bare frame, without the edge light and the glow (the capture tools' mask passes). */
    get effects() { return effects; },
    set effects(on) {
      effects = on;
      invalidate('camera');   // the post passes' input: draw again
    },

    envTexture,
    get preset() { return preset; },
    get orientation() { return Math.abs(wrapDelta(boardTheta() - Math.PI)) < Math.PI / 2 ? 'black' : 'white'; },
    get viewMode() { return mode; },
    get transitioning() { return transitioning; },
    get controlsEnabled() { return controls.enabled; },
    get disposed() { return disposed; },

    /** The resolved lighting: the user's settings plus `applied`, the numbers the renderer actually got. */
    get lighting() { return { ...lighting, unlit: applied.unlit, applied: { ...applied } }; },

    tween,
    flyTo,

    /** Fly to a named camera preset ('white' | 'black' | 'top' | 'side'); 'free' leaves the camera where it is. */
    setPreset(name) {
      if (mode === '2d') {
        // 2D cannot tilt: a seat preset turns the board, anything else re-frames it
        if (name === 'white' || name === 'black') return rotateSeat(name);
        refit2d(true);
        preset = 'top';
        return Promise.resolve(true);
      }

      if (name === 'free' || !PRESETS[name]) {
        preset = 'free';
        return Promise.resolve(true);
      }

      const p = PRESETS[name];
      const s = fitScale(p.pos, p.target);
      const pos = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]).sub(new THREE.Vector3(...p.target)).multiplyScalar(s);
      _sph.setFromVector3(pos);
      preset = name;
      if (name === 'white' || name === 'black') orientation = name;

      // always re-establish the 3D lens: a preset may have superseded a 2D -> 3D transition
      return flyTo({ target: new THREE.Vector3(...p.target), radius: _sph.radius, phi: _sph.phi, theta: _sph.theta, fov: FOV_3D });
    },

    /** Manual Flip button: the same rotation self-play uses, at the shorter tween length. */
    flipTo(o) { return rotateSeat(o, { duration: TWEEN_MS }); },

    /** Turn the board to the other seat (self-play). Promise resolves true, or false if cancelled. */
    rotateSeat,

    /** '2d' locks the camera straight overhead with orbit off; '3d' restores the exact previous pose. */
    setViewMode,

    /** Subscribe to view-mode changes: fn(mode, previous). Fires as the transition STARTS. */
    onViewModeChange(fn) {
      if (typeof fn !== 'function') return () => {};
      modeHooks.add(fn);
      return () => modeHooks.delete(fn);
    },

    /** Animated look-at: tween the target to a point / object and dolly to `distance` (2D pans instead). */
    focusOn(target, distance = 3) {
      if (!target) return Promise.resolve(true);

      const point = new THREE.Vector3();
      if (target.isVector3) point.copy(target);
      else if (target.isObject3D) {
        target.getWorldPosition(point);
        point.y += 0.4;
      } else if (typeof target.x === 'number') point.set(target.x, target.y || 0, target.z || 0);
      else return Promise.resolve(true);

      if (mode === '2d') {
        // no dolly in 2D, it would break the locked frame: pan over the square, zoom in a little
        const dist = clamp(camera.position.distanceTo(controls.target) * 0.75, fit2d * ZOOM_2D[0], fit2d * ZOOM_2D[1]);
        return flyTo({ target: new THREE.Vector3(point.x, 0, point.z), radius: dist, phi: TOP_EPS, theta: boardTheta() });
      }

      preset = 'free';
      return flyTo({ target: point, radius: distance });
    },

    /** Intersections under a client-space pointer (container-relative), nearest first. */
    raycast(clientX, clientY, objects, recursive = true) {
      if (!setRay(clientX, clientY) || !objects || !objects.length) return [];
      return raycaster.intersectObjects(objects, recursive);
    },

    /** Where the pointer ray meets the horizontal plane at height y (null if it does not). */
    pointerToPlane(clientX, clientY, y = 0) {
      if (!setRay(clientX, clientY)) return null;

      plane.set(plane.normal, -y);
      const out = new THREE.Vector3();
      return raycaster.ray.intersectPlane(plane, out);
    },

    /** Inverse of pointerToPlane: a world point -> client coordinates (null when the container has no size). */
    worldToClient(point) {
      if (!point) return null;

      const r = container.getBoundingClientRect();
      if (!r.width || !r.height) return null;

      camera.updateMatrixWorld();
      const p = new THREE.Vector3(point.x, point.y || 0, point.z).project(camera);
      return { x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height };
    },

    /** Enable / disable orbiting (off while a piece is being dragged). */
    setControlsEnabled(on) {
      controls.enabled = !!on;
      if (!on) stillControls();
    },

    /** Register a per-frame hook fn(dt, elapsed) returning false, 'camera' or anything else; returns unsubscribe. */
    onFrame(fn) {
      if (typeof fn !== 'function') return () => {};
      hooks.add(fn);
      return () => hooks.delete(fn);
    },

    /** Live lighting: { preset, on, exposure, key, ambient, shadows }. Returns the resolved lighting. */
    setLighting(patch) {
      const prevShadows = renderer.shadowMap.enabled;
      lighting = resolveLighting(patch || {}, lighting);
      applied = lightingValues(lighting);
      applyLighting(prevShadows);
      return view.lighting;
    },

    /** Hand the view the material set so "lighting off" can switch it unlit; main.js calls it on every theme. */
    setMaterialSet(next) {
      invalidate('content');
      matSet = next || null;

      if (matSet && typeof matSet.setUnlit === 'function') {
        try {
          matSet.setUnlit(applied.unlit);
        } catch (err) {
          console.warn('[scene] matSet.setUnlit failed', err);
        }
      }
      return matSet;
    },

    /** Subscribe to lighting changes: fn(view.lighting). Returns unsubscribe. */
    onLighting(fn) {
      if (typeof fn !== 'function') return () => {};
      lightHooks.add(fn);
      return () => lightHooks.delete(fn);
    },

    /** Toggle shadows live through setLighting; antialias is fixed at context creation. */
    setQuality({ shadows, antialias } = {}) {
      if (typeof shadows === 'boolean') view.setLighting({ shadows });
      if (typeof antialias === 'boolean') view.antialias = antialias; // recorded only; not switchable live
    },

    /** The margins (px) the floating UI covers; 2D frames the board in what is left, 3D ignores them. */
    setSafeArea(area = {}) {
      const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
      const next = { top: n(area.top), right: n(area.right), bottom: n(area.bottom), left: n(area.left) };
      if (next.top === safe.top && next.right === safe.right && next.bottom === safe.bottom && next.left === safe.left) return;

      safe = next;
      if (mode === '2d' && !transitioning) refit2d();
    },
    get safeArea() { return { ...safe }; },

    /** Scene background colour (hex string or number); null makes the canvas transparent. */
    setBackground(color) {
      if (color == null || color === '' || color === 'auto') userBackground = null;
      else {
        try {
          userBackground = new THREE.Color(color);
        } catch (_) {
          userBackground = null;
        }
      }
      applyEnvironment();     // the HDRI rooms keep their own background; 'plain' and 2D show this one
    },

    /** Where the board sits: 'room' | 'studio' (HDRI + table) | 'plain' (the original look). */
    setEnvironment(name) {
      const want = ENVIRONMENTS[name] ? name : 'room';
      envName = want === 'plain' || hdriAvailable(want) ? want : 'plain';
      applyEnvironment();
      applyLighting(renderer.shadowMap.enabled);
      return envName;
    },
    get environment() { return envName; },
    table,

    /** Slow showcase rotation on/off (ignored while in 2D — it would spin the board under the player). */
    setAutoRotate(on) {
      autoRotateWanted = !!on;
      controls.autoRotate = autoRotateWanted && mode === '3d';
    },

    /** Jump instead of tween when false (settings.animations is also honoured live). */
    setAnimations(on) { animations = !!on; },

    resize,

    /** Render one frame synchronously (a full one: the shadow map is redrawn too). */
    render() {
      controls.update(0);
      keepAboveTable();
      aimSeatLights();
      renderFrame('content');
    },

    /** Ask for a frame: 'camera' (viewpoint or post-effect input) or 'content' (the lit scene). */
    invalidate(kind = 'content') { invalidate(kind === 'camera' ? 'camera' : 'content'); },

    /** Render-on-demand counters, triangles per pass, the GPU name and the motion quality. */
    get stats() {
      const out = { ...stats };
      if (tris) {
        out.triangles = { ...trisFull };
        out.lastTriangles = { ...tris };
      }
      if (gpuName) out.gpu = gpuName;

      // listed only with a real renderer, as `triangles` is
      const motion = {
        level: policies[mode].level, reduced, interval_ms: Math.round(policies[mode].interval * 10) / 10, settles, quality,
      };
      for (const [k, value] of Object.entries(motion)) {
        Object.defineProperty(out, k, { value, enumerable: !!tris, writable: true, configurable: true });
      }
      return out;
    },

    /** The quality level (QUALITY): applied at once, with one 'content' frame. */
    setMotionQuality(q) {
      const next = normalizeQuality(q);
      if (next === quality) return quality;

      const prevShadows = renderer.shadowMap.enabled;
      quality = next;

      for (const [name, old] of Object.entries(policies)) {
        policies[name] = createMotionPolicy();
        policies[name].setMode(policyMode());
        policies[name].pin(old.pinned);
      }

      applyShadowMap();
      applyLighting(prevShadows);
      return quality;
    },
    get motionQuality() { return quality; },

    /** Pin the level motion frames are drawn at (0..MOTION_LEVELS.length - 1; tests, measuring); null = automatic. */
    setMotionLevel(n) {
      for (const p of Object.values(policies)) p.pin(n);
      return policies[mode].level;
    },

    /** Stop the loop, detach observers and DOM nodes, free the GL context. */
    dispose() {
      if (disposed) return;
      disposed = true;

      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      cancelCameraTween();
      tweens.clear();
      hooks.clear();
      modeHooks.clear();
      lightHooks.clear();

      if (ro) ro.disconnect();
      else if (typeof window !== 'undefined') window.removeEventListener('resize', resize);
      if (ratioQuery && ratioQuery.removeEventListener) ratioQuery.removeEventListener('change', onRatioChange);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      offRedraw();
      canvas.removeEventListener('pointermove', onPointerMoveUser);
      canvas.removeEventListener('wheel', onWheelUser);

      controls.dispose();
      if (glow) glow.dispose();
      if (silhouette) silhouette.dispose();

      for (const e of envCache.values()) {
        if (e.env) e.env.dispose();
        if (e.bg) e.bg.dispose();
      }
      envCache.clear();

      table.traverse(o => {
        if (o.isMesh) {
          o.geometry.dispose();
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
      for (const m of [floor, drop])
        if (m) {
          m.geometry.dispose();
          m.material.dispose();
        }
      for (const t of [floorTex, dropTex]) if (t) t.dispose();
      if (tableParts) for (const t of tableParts.textures) t.dispose();

      scene.environment = null;
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      if (vignette && vignette.parentNode) vignette.parentNode.removeChild(vignette);
      if (labelRenderer && labelRenderer.domElement && labelRenderer.domElement.parentNode) {
        labelRenderer.domElement.parentNode.removeChild(labelRenderer.domElement);
      }
    },
  };
  view.antialias = true;

  // --- boot state ---
  envName = hdriAvailable(settings.environment) ? settings.environment
    : (settings.environment === 'plain' || !hdriAvailable('room') ? 'plain' : 'room');
  applyEnvironment();
  applyShadowMap();
  applyLighting(renderer.shadowMap.enabled);
  if (settings.viewMode === '2d') setViewMode('2d', { animate: false });

  return view;
}
