// three/materials.js -- the three themes (wood / metal / glass) as ready-made THREE materials,
// plus the two lighting-independent contrast aids the addendum asks for (rim darkening + contact shadow).
// Owns: THEMES, THEME_PALETTES, createMaterialSet(theme, palette, opts) -> matSet per CONTRACT.md.
//
// Added beyond the contract (all exported / on the matSet):
//   - createMaterialSet(theme, palette, { unlit = false, contrast = true })   (addendum v1)
//   - matSet.setUnlit(bool)      : live flat/unlit switch; colours, palette and maps survive it.
//   - matSet.setContrast(bool)   : the piece-separation aid (rim + contact shadow), independent of lights.
//   - matSet.unlit / matSet.contrast : current state (booleans)
//   - matSet.whiteAccent / blackAccent : the inset/bezel materials pieces.js uses (bishop slit, knight
//                                        eyes, 2D token bezel). Derived from the palette, so they follow it.
//   - matSet.contactShadow       : MeshBasicMaterial for the soft decal pieces.js puts under every piece.
//   - matSet.textures            : the procedural CanvasTextures this set owns (disposed with it)
//   - matSet.colors()            : the effective {light,dark,frame,white,black} hex after palette merge
//   - resolvePalette(theme, palette) : exported helper (theme defaults merged with a partial override)
//   - makeWoodGrainTexture / makeBrushedTexture / makeContactShadowTexture : exported so board.js may reuse them
//   - makeLacquerTexture(size, seed, repeat) : the uneven-polish roughness map the lacquered woods (and the
//                                  table in scene.js) use so a lamp's reflection breaks up instead of mirroring
//   - setMaterialUnlit(m, on, { shape, flatMetal }) : exported for the modelled sets; `shape` keeps the ambient
//                                  occlusion, `flatMetal` evens out a metal's patina (flattenMetalPixels)
//   - matSet.modeledPiece(color, own)        : a modelled set's finish in this theme (null in wood; MODELED_FINISH)
//   - disposeMaterialCaches(): free the module-level canvases (teardown only; see below)
//
// HOW THE CONTRAST AID WORKS (this is the fix for "white pieces vanish on light squares"):
//   1. Rim darkening. Every piece/accent material gets a tiny onBeforeCompile patch that mixes
//      `outgoingLight` toward a rim colour by pow(1 - |N.V|, p). At the silhouette N.V -> 0, so the
//      outline of the piece is darkened (white pieces) or lightened (black pieces) NO MATTER where the
//      camera is -- including straight overhead, which is what 2D mode uses. It touches outgoingLight,
//      not diffuse, so it survives the unlit switch and every lighting preset unchanged.
//      The shader is compiled with the patch ALWAYS; toggling contrast only writes uRimAmount, so
//      switching it costs no recompile. All piece materials share one program (customProgramCacheKey).
//   2. Contact shadow. matSet.contactShadow is a soft radial decal material; pieces.js parents one
//      small plane to every piece at y ~ 0.004. It is a plain textured quad, so it is drawn with
//      settings.shadows off, in unlit mode and in every theme.
//   Both are driven by matSet.setContrast(settings.lighting.contrast).
//
// Texture caching (2026-09-18): the per-pixel grain loops cost ~33 ms per createMaterialSet('wood'),
//   and main.js rebuilds the whole set on every 'theme' event. The generated CANVAS is cached at
//   module level per (kind, size, seed, contrast) and each call wraps it in its OWN CanvasTexture --
//   cheap, and every matSet still owns disposable texture instances, so matSet.dispose() can never
//   free a texture another live set is using and board.js keeps its own .repeat/.offset per instance.
// Notes for other modules:
//   - Wood grain is a near-white luminance map multiplied by material.color, so setPalette() only
//     touches .color and the grain survives. board.js may set map.repeat on frame.map (own instance).
//   - Glass squares / frame are OPAQUE frosted glass (transmission 0): three's transmission pass only
//     sees opaque objects, so transmissive squares would vanish behind glass pieces. Pieces transmit.
//   - Metal and glass need scene.environment (scene.js provides RoomEnvironment through PMREM).
//     In unlit mode envMapIntensity is forced to 0 and the colour is moved to `emissive`, so metal and
//     glass go FLAT, not black -- scene.js may additionally null scene.environment.

import * as THREE from 'three';
import { requestRedraw } from './redraw.js';

/** The three theme ids, in menu order. */
export const THEMES = ['wood', 'metal', 'glass'];

/**
 * Default palette per theme (hex strings). settings.palette overrides any subset of these keys.
 * 2026-09-18: light squares were pulled down and white pieces pushed up so the two never sit within a
 * few percent of each other (the "white piece on a white square" complaint). Still user-overridable.
 */
export const THEME_PALETTES = {
  wood:  { light: '#E0C59B', dark: '#7C4A21', frame: '#4E3119', white: '#F6EEDD', black: '#241B13' },
  metal: { light: '#C4C8CF', dark: '#50565E', frame: '#3A3F46', white: '#EDEFF3', black: '#31343A' },
  glass: { light: '#C7D6E6', dark: '#48596F', frame: '#18202A', white: '#FBFDFF', black: '#232831' },
};

const PALETTE_KEYS = ['light', 'dark', 'frame', 'white', 'black'];

/** Merge a (possibly partial / null) palette over the theme defaults; unknown themes fall back to wood. */
export function resolvePalette(theme, palette) {
  const base = THEME_PALETTES[theme] || THEME_PALETTES.wood;
  const out = { ...base };
  if (palette && typeof palette === 'object') {
    for (const k of PALETTE_KEYS) {
      const v = palette[k];
      if (typeof v === 'string' && /^#?[0-9a-fA-F]{6}$/.test(v)) out[k] = v.startsWith('#') ? v : '#' + v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Derived tones. Accents and rim colours are computed FROM the palette so a user palette keeps the
// separation aid working (a near-black rim on a near-black "white" piece would be useless).

const INK = '#100C07';       // what a light piece's edge / inset is pushed toward
const CHALK = '#FFF6E2';     // what a dark piece's edge / inset is pulled toward

function toward(hex, targetHex, t) {
  return new THREE.Color(hex).lerp(new THREE.Color(targetHex), t);
}

/** Rim + accent tones for one resolved palette. */
function tones(c) {
  return {
    whiteAccent: toward(c.white, INK, 0.86),
    blackAccent: toward(c.black, CHALK, 0.74),
    whiteRim: toward(c.white, INK, 0.80),
    blackRim: toward(c.black, CHALK, 0.52),
  };
}

/** Rim strength per theme: how hard the silhouette is pushed, and how tight the band is. */
const RIM = {
  wood:  { white: 0.66, black: 0.36, power: 2.4 },
  metal: { white: 0.60, black: 0.34, power: 2.6 },
  glass: { white: 0.74, black: 0.40, power: 2.1 },   // glass needs the most: it is see-through
};

/** Contact-shadow strength per theme (opacity of the decal under each piece). */
const CONTACT = {
  wood:  { color: '#2A1B0C', opacity: 0.38 },
  metal: { color: '#0F1216', opacity: 0.34 },
  glass: { color: '#101822', opacity: 0.30 },
};

// ---------------------------------------------------------------------------------------------
// The rim shader patch. One shared onBeforeCompile + one constant cache key so every piece material
// in the app compiles to the SAME program; only the uniform values differ per material.

const RIM_PARS_V = 'varying vec3 vRimN;\nvarying vec3 vRimV;\n';
const RIM_PARS_F = 'varying vec3 vRimN;\nvarying vec3 vRimV;\nuniform vec3 uRimColor;\nuniform float uRimAmount;\nuniform float uRimPower;\n';
const RIM_V_HOOK = '#include <project_vertex>';
const RIM_V_CODE = '#include <project_vertex>\n\tvRimN = transformedNormal;\n\tvRimV = - mvPosition.xyz;\n';
const RIM_F_HOOK = '#include <opaque_fragment>';
const RIM_F_CODE = [
  '{',
  '  float rimNdv = abs( dot( normalize( vRimN ), normalize( vRimV ) ) );',
  '  float rimK = pow( clamp( 1.0 - rimNdv, 0.0, 1.0 ), uRimPower );',
  '  outgoingLight = mix( outgoingLight, uRimColor, clamp( uRimAmount * rimK, 0.0, 1.0 ) );',
  '}',
  '#include <opaque_fragment>',
].join('\n');

const RIM_CACHE_KEY = 'chessboard-rim-5';

function rimOnBeforeCompile(shader) {
  const u = this.userData && this.userData.rim;
  if (!u) return;
  reviveRim(u);
  shader.uniforms.uRimColor = u.uRimColor;
  shader.uniforms.uRimAmount = u.uRimAmount;
  shader.uniforms.uRimPower = u.uRimPower;
  if (shader.vertexShader.indexOf(RIM_V_HOOK) >= 0) {
    shader.vertexShader = RIM_PARS_V + shader.vertexShader.replace(RIM_V_HOOK, RIM_V_CODE);
  }
  if (shader.fragmentShader.indexOf(RIM_F_HOOK) >= 0) {
    shader.fragmentShader = RIM_PARS_F + shader.fragmentShader.replace(RIM_F_HOOK, RIM_F_CODE);
  }
}
/**
 * Material.copy() JSON-clones userData, and Color.toJSON() is a hex NUMBER -- so a cloned piece
 * material arrives with plain values where three expects uniform objects. Put them back before the
 * clone compiles, or the rim uniform upload would throw on a fade clone.
 */
function reviveRim(u) {
  const c = u.uRimColor && u.uRimColor.value;
  if (!c || !c.isColor) {
    const revived = new THREE.Color();
    if (typeof c === 'number') revived.setHex(c);
    else if (c && typeof c === 'object' && typeof c.r === 'number') revived.setRGB(c.r, c.g, c.b);
    u.uRimColor = { value: revived };
  }
  if (!u.uRimAmount || typeof u.uRimAmount.value !== 'number') u.uRimAmount = { value: 0 };
  if (!u.uRimPower || typeof u.uRimPower.value !== 'number') u.uRimPower = { value: 2.4 };
}

/**
 * The patch lives on a PROTOTYPE, not as an own property, because pieceLayer.js clones piece materials
 * to cross-fade them (2D <-> 3D, captures) and THREE.Material.copy() does NOT carry own-property
 * `onBeforeCompile` / `customProgramCacheKey` across. On a subclass the clone keeps both, so a piece
 * never loses its contrast rim mid-animation -- which is exactly the moment 2D mode needs it.
 * `Material.copy()` JSON-clones userData, so the clone's rim uniforms are plain {value:{r,g,b}} /
 * {value:number} objects; three uploads those fine (setValueV3f accepts anything with .r/.g/.b).
 */
class RimStandardMaterial extends THREE.MeshStandardMaterial {
  onBeforeCompile(shader) { rimOnBeforeCompile.call(this, shader); }
  customProgramCacheKey() { return this.userData && this.userData.rim ? RIM_CACHE_KEY : RIM_CACHE_KEY + '-off'; }
}
class RimPhysicalMaterial extends THREE.MeshPhysicalMaterial {
  onBeforeCompile(shader) { rimOnBeforeCompile.call(this, shader); }
  customProgramCacheKey() { return this.userData && this.userData.rim ? RIM_CACHE_KEY : RIM_CACHE_KEY + '-off'; }
}

/**
 * Give a material the silhouette-rim uniforms. `amount` 0 disables the rim without changing the
 * program, so setContrast() never triggers a shader recompile.
 * @returns {THREE.Material} the same material
 */
function attachRim(material, color, amount, power) {
  material.userData.rim = {
    uRimColor: { value: new THREE.Color(color) },
    uRimAmount: { value: amount },
    uRimPower: { value: power },
  };
  return material;
}

function setRimAmount(material, amount) {
  const u = material && material.userData && material.userData.rim;
  if (u) u.uRimAmount.value = amount;
}
function setRimColor(material, color) {
  const u = material && material.userData && material.userData.rim;
  if (u) u.uRimColor.value.copy(color);
}

// ---------------------------------------------------------------------------------------------
// The unlit switch. Implemented by moving the colour into `emissive` and neutralising every shading
// input, rather than by swapping in MeshBasicMaterial: the material identity survives (pieceLayer
// holds references), the maps survive, transmission/metalness come back exactly, and the rim patch
// keeps working because the shader is still meshphysical.

const UNLIT_KEYS = [
  'metalness', 'roughness', 'envMapIntensity', 'toneMapped', 'transmission', 'thickness',
  'clearcoat', 'clearcoatRoughness', 'specularIntensity', 'emissiveIntensity',
  'transparent', 'opacity', 'emissiveMap', 'aoMap', 'aoMapIntensity', 'lightMap', 'lightMapIntensity', 'map',
];

// A metal's base colour is its reflectance: lit, the room's reflections and the key's highlight carry the look and
// the map only tints them; unlit, the map is all that is left, and a patina made to be seen through reflections
// reads as camouflage (2026-09-24, critique r3: Menagerie's bronze in blotches). The unlit copy pulls the metal's
// own tones most of the way to their mean -- a flat, lightly graded bronze -- and leaves a metal far brighter or
// darker than that alone (the gilt bands sit ~110 levels above the bronze, whose blotches span ~50; the verdigris
// is not metal at all). Measured in luma: the blotches differ in lightness, not in hue. Built once per map.
const FLAT_METAL = { size: 1024, pull: 0.8, near: 45, far: 80 };
const flatMetalCache = new Map();   // base-colour map -> its flattened copy (null when it cannot be built)

/**
 * Pull the metallic pixels of an RGBA base-colour buffer toward the metal's mean colour, in place. `metal` is the
 * glTF metallic-roughness texture's pixels (metalness in blue), the same size. The mean is taken twice: over every
 * metallic pixel, then only over those within 1.5 x `near` of its luma (so a gilt band does not tint it). A pixel
 * moves `pull` x its metalness of the way, fading to nothing between `near` and `far` luma levels from the mean.
 * @returns {number[]|null} the mean [r, g, b], or null when nothing is metallic
 */
export function flattenMetalPixels(px, metal, { pull = FLAT_METAL.pull, near = FLAT_METAL.near, far = FLAT_METAL.far } = {}) {
  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const meanOf = (around, within) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (metal[i + 2] < 128 || (around !== null && Math.abs(luma(px[i], px[i + 1], px[i + 2]) - around) > within)) continue;
      r += px[i]; g += px[i + 1]; b += px[i + 2]; n++;
    }
    return n ? [r / n, g / n, b / n] : null;
  };
  const all = meanOf(null, 0);
  if (!all) return null;
  const mean = meanOf(luma(...all), near * 1.5) || all;
  const ml = luma(...mean);
  for (let i = 0; i < px.length; i += 4) {
    const w = metal[i + 2] / 255;
    if (w <= 0) continue;
    const d = Math.abs(luma(px[i], px[i + 1], px[i + 2]) - ml);
    const fade = d <= near ? 1 : d >= far ? 0 : 1 - (d - near) / (far - near);
    const t = pull * w * fade;
    for (let k = 0; k < 3; k++) px[i + k] += (mean[k] - px[i + k]) * t;
  }
  return mean;
}

/** The flattened copy of a metallic material's base-colour map (see FLAT_METAL), or null (no DOM, no metal). */
function flatMetalMap(m) {
  const map = m.map;
  if (!map || !(m.metalness > 0.5) || !m.metalnessMap) return null;
  if (flatMetalCache.has(map)) return flatMetalCache.get(map);
  const img = map.image, mimg = m.metalnessMap.image;
  if (typeof document !== 'undefined' && !(img && mimg && img.width > 0 && img.height > 0)) return null;   // not decoded yet
  let out = null;
  if (typeof document !== 'undefined') {
    const w = Math.min(FLAT_METAL.size, img.width), h = Math.min(FLAT_METAL.size, img.height);
    const read = (src) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      if (!ctx || typeof ctx.getImageData !== 'function') return null;
      ctx.drawImage(src, 0, 0, w, h);
      return { c, ctx, data: ctx.getImageData(0, 0, w, h) };
    };
    const base = read(img), metal = read(mimg);
    if (base && metal && flattenMetalPixels(base.data.data, metal.data.data)) {
      base.ctx.putImageData(base.data, 0, 0);
      out = new THREE.CanvasTexture(base.c);
      for (const k of ['flipY', 'colorSpace', 'wrapS', 'wrapT', 'channel', 'anisotropy', 'rotation']) out[k] = map[k];
      out.offset.copy(map.offset); out.repeat.copy(map.repeat); out.center.copy(map.center);
      out.needsUpdate = true;
    }
  }
  flatMetalCache.set(map, out);
  return out;
}

// A 1x1 white light map. At intensity PI it hands a material exactly its own colour as irradiance (the Lambert
// term divides by PI), and the aoMap then darkens that -- see setMaterialUnlit's `shape` option.
let unitLight = null;
function unitLightMap() {
  if (!unitLight) {
    unitLight = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    unitLight.needsUpdate = true;
  }
  return unitLight;
}

/** The occlusion a material carries: its aoMap, else a glTF ORM texture (R = occlusion) in the roughness slot. */
function occlusionOf(m) {
  return m.aoMap || m.roughnessMap || m.metalnessMap || null;
}

/**
 * Switch one material to / from flat unlit shading (exported for the modelled piece sets).
 * opts.shape: keep the material's ambient occlusion in the flat look (the modelled sets, whose smooth pale
 * forms otherwise read as silhouettes only). The colour stays in the diffuse slot and a unit light map feeds it
 * its own colour back as irradiance, which the aoMap then darkens -- the same pixels MeshBasicMaterial + aoMap
 * would draw, without replacing a material pieceLayer holds references to. The texture's own uv channel is used.
 * Without an occlusion texture it falls back to the plain emissive route below.
 * opts.flatMetal: a metallic material's base colour goes flat for the duration (see FLAT_METAL above).
 */
export function setMaterialUnlit(m, on, opts = {}) {
  if (!m) return;
  if (on) {
    if (m.userData.litBackup) return;
    const b = {};
    for (const k of UNLIT_KEYS) if (m[k] !== undefined) b[k] = m[k];
    b.color = m.color ? m.color.clone() : null;
    b.emissive = m.emissive ? m.emissive.clone() : null;
    m.userData.litBackup = b;
    const flat = opts && opts.flatMetal ? flatMetalMap(m) : null;   // before metalness is zeroed below
    if (flat) m.map = flat;
    const ao = opts && opts.shape && m.lightMap !== undefined ? occlusionOf(m) : null;
    if (ao) {
      m.lightMap = unitLightMap();
      m.lightMapIntensity = Math.PI;
      m.aoMap = ao;
      m.aoMapIntensity = 1;
    } else if (m.emissive) {
      m.emissive.copy(m.color);
      m.emissiveIntensity = 1;
      if (m.emissiveMap !== undefined) m.emissiveMap = m.map || null;  // keep the wood grain visible
      m.color.setRGB(0, 0, 0);
    }
    if (m.metalness !== undefined) m.metalness = 0;
    if (m.roughness !== undefined) m.roughness = 1;
    if (m.envMapIntensity !== undefined) m.envMapIntensity = 0;
    if (m.transmission !== undefined) m.transmission = 0;
    if (m.thickness !== undefined) m.thickness = 0;
    if (m.clearcoat !== undefined) m.clearcoat = 0;
    if (m.specularIntensity !== undefined) m.specularIntensity = 0;
    if (!ao && m.aoMapIntensity !== undefined) m.aoMapIntensity = 0;
    m.toneMapped = false;     // flat mode must not move when exposure does
    m.needsUpdate = true;
  } else {
    const b = m.userData.litBackup;
    if (!b) return;
    for (const k of UNLIT_KEYS) if (k in b) m[k] = b[k];
    if (b.color && m.color) m.color.copy(b.color);
    if (b.emissive && m.emissive) m.emissive.copy(b.emissive);
    delete m.userData.litBackup;
    m.needsUpdate = true;
  }
}

/** Set a material's visible colour, whichever mode it is in (unlit parks the colour in `emissive`). */
function setLiveColor(m, hex) {
  const b = m.userData && m.userData.litBackup;
  if (b && b.color) { m.emissive.set(hex); b.color.set(hex); } else { m.color.set(hex); }
}

// ---------------------------------------------------------------------------------------------
// Procedural textures (CanvasTexture). Guarded so importing this module under node is harmless;
// createMaterialSet() in node simply produces materials without maps.

const hasCanvas = () => typeof document !== 'undefined' && typeof document.createElement === 'function';

// Cache of generated CANVASES (the expensive part). Textures are never cached -- every caller
// gets its own CanvasTexture over the shared canvas, so disposing one set never touches another.
const canvasCache = new Map();   // key -> HTMLCanvasElement | null

function cachedCanvas(key, draw) {
  let c = canvasCache.get(key);
  if (c === undefined) { c = draw(); canvasCache.set(key, c); }
  return c;
}

/** Wrap a cached canvas in a fresh CanvasTexture (cheap: no per-pixel work). */
function textureOver(canvas, { colorSpace, anisotropy }) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  if (anisotropy) tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

/** Drop the module-level canvases and the flattened metal maps (teardown / tests only). */
export function disposeMaterialCaches() {
  canvasCache.clear();
  for (const t of flatMetalCache.values()) if (t) t.dispose();
  flatMetalCache.clear();
}

/** Deterministic tiny PRNG (mulberry32) so a given seed always draws the same grain. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Wood grain as a near-white luminance map (multiply with material.color for the tone).
 * @returns {THREE.CanvasTexture|null}  a fresh texture over the cached canvas (caller owns/disposes it)
 */
export function makeWoodGrainTexture(size = 256, seed = 1, contrast = 0.2) {
  if (!hasCanvas()) return null;
  const canvas = cachedCanvas(`wood:${size}:${seed}:${contrast}`, () => drawWoodGrainCanvas(size, seed, contrast));
  if (!canvas) return null;
  return textureOver(canvas, { colorSpace: THREE.SRGBColorSpace, anisotropy: 4 });
}

function drawWoodGrainCanvas(size, seed, contrast) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx || !ctx.createImageData) return null;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rand = rng(seed * 7919 + 13);
  const s = seed * 1.37;
  const wobble = new Float32Array(size);
  for (let y = 0; y < size; y++) {
    const t = y / size * Math.PI * 2;
    wobble[y] = 7 * Math.sin(t * 1.0 + s) + 3.5 * Math.sin(t * 2.0 + s * 1.7) + 1.5 * Math.sin(t * 5.0 + s * 0.3);
  }
  const bands = [];
  const nb = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < nb; i++) bands.push({ x: rand() * size, w: 3 + rand() * 6, k: 0.5 + rand() * 0.5 });
  for (let y = 0; y < size; y++) {
    const w = wobble[y];
    for (let x = 0; x < size; x++) {
      const t = x + w;
      let v = 0.5 + 0.5 * Math.sin(t * 0.30 + 1.8 * Math.sin(t * 0.035 + s));
      v = v * 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(t * 1.45 + 0.7 * Math.sin(t * 0.21 + s * 2.1)));
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        let dx = Math.abs(((t - b.x) % size + size) % size);
        dx = Math.min(dx, size - dx);
        if (dx < b.w) v += b.k * (1 - dx / b.w) * 0.6;
      }
      v += (rand() - 0.5) * 0.14;
      v = Math.min(1, Math.max(0, v));
      const lum = Math.round(255 * (1 - contrast * v));
      const i4 = (y * size + x) * 4;
      d[i4] = lum; d[i4 + 1] = Math.round(lum * 0.985); d[i4 + 2] = Math.round(lum * 0.955); d[i4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Brushed-metal roughness map: fine horizontal streaks in the green channel (0.78..1.0).
 * @returns {THREE.CanvasTexture|null}  a fresh texture over the cached canvas (caller owns/disposes it)
 */
export function makeBrushedTexture(size = 256, seed = 3) {
  if (!hasCanvas()) return null;
  const canvas = cachedCanvas(`brushed:${size}:${seed}`, () => drawBrushedCanvas(size, seed));
  if (!canvas) return null;
  return textureOver(canvas, { colorSpace: THREE.NoColorSpace, anisotropy: 0 });
}

function drawBrushedCanvas(size, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx || !ctx.createImageData) return null;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rand = rng(seed * 104729 + 7);
  const rows = new Float32Array(size);
  for (let y = 0; y < size; y++) rows[y] = rand();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(x * 0.9 + rows[y] * 20 + Math.sin(y * 0.4) * 1.5));
      v += (rand() - 0.5) * 0.08;
      const g = Math.round(255 * Math.min(1, Math.max(0, v)));
      const i4 = (y * size + x) * 4;
      d[i4] = g; d[i4 + 1] = g; d[i4 + 2] = g; d[i4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Uneven polish: a tileable roughness multiplier (grey, ~0.75..1.0) for a lacquer's clearcoatRoughness
 * map. Soft blotches at three scales plus faint wipe streaks along u, so a lamp mirrored in the lacquer reads as
 * a broken sheen rather than a clipped disc. `repeat` is set on the returned texture (each use keeps its own).
 * @returns {THREE.CanvasTexture|null}  a fresh texture over the cached canvas (caller owns/disposes it)
 */
export function makeLacquerTexture(size = 256, seed = 5, repeat = 1) {
  if (!hasCanvas()) return null;
  const canvas = cachedCanvas(`lacquer:${size}:${seed}`, () => drawLacquerCanvas(size, seed));
  if (!canvas) return null;
  const tex = textureOver(canvas, { colorSpace: THREE.NoColorSpace, anisotropy: 4 });
  tex.repeat.set(repeat, repeat);
  return tex;
}

function drawLacquerCanvas(size, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx || !ctx.createImageData) return null;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const rand = rng(seed * 4099 + 17);
  // periodic value noise: a lattice of cells x cells random values that wraps, so the map tiles seamlessly
  const lattice = (cells) => { const g = new Float32Array(cells * cells); for (let i = 0; i < g.length; i++) g[i] = rand(); return { cells, g }; };
  const octaves = [[lattice(4), 0.5], [lattice(9), 0.32], [lattice(23), 0.18]];
  const fade = (t) => t * t * (3 - 2 * t);
  const noise = ({ cells, g }, u, v) => {
    const x = u * cells, y = v * cells, x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = fade(x - x0), fy = fade(y - y0);
    const at = (i, j) => g[(j % cells) * cells + (i % cells)];
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), e = at(x0 + 1, y0 + 1);
    return (a + (b - a) * fx) * (1 - fy) + (c + (e - c) * fx) * fy;
  };
  const streak = new Float32Array(size);
  for (let y = 0; y < size; y++) streak[y] = rand() - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (const [o, w] of octaves) n += w * noise(o, x / size, y / size);
      const wipe = 0.05 * streak[y] * (0.6 + 0.4 * Math.sin((x / size) * Math.PI * 6 + streak[(y + 7) % size] * 9));
      const v = Math.min(1, Math.max(0.7, 0.88 + (n - 0.5) * 0.5 + wipe));
      const i4 = (y * size + x) * 4;
      const g8 = Math.round(v * 255);
      d[i4] = g8; d[i4 + 1] = g8; d[i4 + 2] = g8; d[i4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Soft round contact shadow (black, alpha falls off to 0 at the edge). Used as a decal under every
 * piece so a light piece always sits in a dark halo, whatever the lights are doing.
 * @returns {THREE.CanvasTexture|null}
 */
export function makeContactShadowTexture(size = 128) {
  if (!hasCanvas()) return null;
  const canvas = cachedCanvas(`contact:${size}`, () => drawContactCanvas(size));
  if (!canvas) return null;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function drawContactCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx || !ctx.createRadialGradient || !ctx.fillRect) return null;
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  // Contact shading. pieces.js sizes the decal to ~1.38x the foot radius, so the foot's edge sits at ~0.73 of
  // this gradient: dense up to there (hidden under the base), then a short falloff -- the dark line where the
  // piece meets the square. (The 2D token's decal is only 1.06x its disc, so there just the faint tail shows.)
  g.addColorStop(0.00, 'rgba(0,0,0,1)');
  g.addColorStop(0.62, 'rgba(0,0,0,1)');
  g.addColorStop(0.70, 'rgba(0,0,0,0.92)');
  g.addColorStop(0.76, 'rgba(0,0,0,0.70)');
  g.addColorStop(0.83, 'rgba(0,0,0,0.40)');
  g.addColorStop(0.90, 'rgba(0,0,0,0.17)');
  g.addColorStop(0.96, 'rgba(0,0,0,0.04)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

// ---------------------------------------------------------------------------------------------
// Theme builders. Each returns { lightSquare, darkSquare, frame, whitePiece, blackPiece, textures }.

// ---------------------------------------------------------------------------------------------
// Baked woods (Blender, ../../blender/board_textures.py): hard maple, black walnut and a frame walnut, handed
// in by main.js through setWoodTextures() because the node tests cannot import image files. When present the
// wood theme uses them (full-colour maps, lacquered); without them it keeps the procedural canvas grain.

let bakedWood = null;          // { maple, walnut, frame } data URLs
const bakedWoodTex = new Map();   // url -> THREE.Texture (shared, never disposed with a matSet)

/** Give the wood theme its baked textures ({ maple, walnut, frame } image URLs). */
export function setWoodTextures(urls) {
  bakedWood = urls && urls.maple && urls.walnut && urls.frame ? { ...urls } : null;
}

function woodTexture(url) {
  let t = bakedWoodTex.get(url);
  if (!t) {
    t = new THREE.TextureLoader().load(url, () => requestRedraw('content'));   // decoded: draw it
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.userData.shared = true;
    bakedWoodTex.set(url, t);
  }
  return t;
}

/** The colour a baked-wood material multiplies its map by: white for the theme's own palette, a ratio tint
 *  when the user has picked another colour for that slot (so the palette sliders still recolour the board). */
function woodTint(hex, refHex) {
  const a = new THREE.Color(hex), r = new THREE.Color(refHex);
  return new THREE.Color(Math.min(2, a.r / Math.max(r.r, 1e-3)), Math.min(2, a.g / Math.max(r.g, 1e-3)), Math.min(2, a.b / Math.max(r.b, 1e-3)));
}

// The lacquer on the baked woods. The clearcoat is what mirrors a lamp, so its roughness is lifted a little and
// varied by the uneven-polish map (makeLacquerTexture): squares see a different half-texture window each (their
// UV windows), the frame spans the whole map in 0..1, hence its higher repeat. Under the lacquer the wood keeps
// only part of its own specular (`specular`): at full strength its broad lobe stacks the lamp on the bright maple.
// `lift` brightens the baked wood itself: the frame walnut is lifted to a mid walnut (2026-09-24, critique r2: a
// 41/255 frame read as a hole around the board); the squares keep their bake, so the checker keeps its contrast.
const LACQUER = {
  squares: { clearcoat: 0.38, clearcoatRoughness: 0.3, specular: 0.5, repeat: 1, lift: 1 },
  frame: { clearcoat: 0.45, clearcoatRoughness: 0.36, specular: 0.5, repeat: 5, lift: 2.0 },
};

function buildBakedWood(c) {
  const ref = THEME_PALETTES.wood;
  const squaresLacquer = makeLacquerTexture(256, 5, LACQUER.squares.repeat);
  const frameLacquer = makeLacquerTexture(256, 5, LACQUER.frame.repeat);
  const sq = (hex, refHex, url, lacquer, coat) => new THREE.MeshPhysicalMaterial({
    color: woodTint(hex, refHex).multiplyScalar(coat.lift), map: woodTexture(url), roughness: 0.42, metalness: 0,
    specularIntensity: coat.specular,
    clearcoat: coat.clearcoat, clearcoatRoughness: coat.clearcoatRoughness, clearcoatRoughnessMap: lacquer,
    envMapIntensity: 0.9,
  });
  const piece = (color, roughness) => new RimStandardMaterial({ color, roughness, metalness: 0, envMapIntensity: 0.5 });
  const m = {
    lightSquare: sq(c.light, ref.light, bakedWood.maple, squaresLacquer, LACQUER.squares),
    darkSquare: sq(c.dark, ref.dark, bakedWood.walnut, squaresLacquer, LACQUER.squares),
    frame: sq(c.frame, ref.frame, bakedWood.frame, frameLacquer, LACQUER.frame),
    whitePiece: piece(c.white, 0.5),
    blackPiece: piece(c.black, 0.42),
    textures: [squaresLacquer, frameLacquer].filter(Boolean),
  };
  m.baked = true;
  return m;
}

function buildWood(c) {
  if (bakedWood && hasCanvas()) return buildBakedWood(c);
  const grainLight = makeWoodGrainTexture(256, 11, 0.16);
  const grainDark = makeWoodGrainTexture(256, 23, 0.26);
  const grainFrame = makeWoodGrainTexture(256, 37, 0.22);
  const sq = (color, map) => new THREE.MeshStandardMaterial({ color, map, roughness: 0.55, metalness: 0, envMapIntensity: 0.6 });
  const piece = (color, roughness) => new RimStandardMaterial({ color, roughness, metalness: 0, envMapIntensity: 0.5 });
  return {
    lightSquare: sq(c.light, grainLight),
    darkSquare: sq(c.dark, grainDark),
    frame: new THREE.MeshStandardMaterial({ color: c.frame, map: grainFrame, roughness: 0.6, metalness: 0, envMapIntensity: 0.5 }),
    whitePiece: piece(c.white, 0.5),   // boxwood
    blackPiece: piece(c.black, 0.42),  // ebony
    textures: [grainLight, grainDark, grainFrame].filter(Boolean),
  };
}

function buildMetal(c) {
  const brushed = makeBrushedTexture(256, 3);
  // Brushed and satin-anodised rather than bare: a fully metallic board shows nothing but its reflection, and in the
  // dim study that put the dark squares at black and the light ones at mid-grey, so ebony and bronze sank into it
  // (critique r4). Half metallic, the squares take the lights as well and sit where the wood checker does.
  const sq = (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.4, roughnessMap: brushed, envMapIntensity: 1.2 });
  const piece = (color, roughness = 0.28) => new RimStandardMaterial({ color, metalness: 1, roughness, envMapIntensity: 1.2 });
  return {
    lightSquare: sq(c.light),   // brushed steel
    darkSquare: sq(c.dark),     // gunmetal
    frame: new THREE.MeshStandardMaterial({ color: c.frame, metalness: 0.6, roughness: 0.45, envMapIntensity: 1.1 }),
    whitePiece: piece(c.white), // polished silver
    blackPiece: piece(c.black), // dark chrome
    // the modelled sets' finish (see MODELED_FINISH): no roughness map -- the brushed streaks follow a square's
    // UVs and would scramble across a set's texture atlas -- and satin rather than mirror (see there)
    modeled: (color, army) => piece(color, MODELED_FINISH.metal[army].roughness),
    textures: [brushed].filter(Boolean),
  };
}

function buildGlass(c) {
  // Pieces: real transmission. Squares/frame: opaque frosted glass (see header note).
  const glassPiece = (color, army) => new RimPhysicalMaterial(army === 'black' ? {
    color, transmission: 0.85, roughness: 0.05, thickness: 0.6, ior: 1.5,
    clearcoat: 1, clearcoatRoughness: 0.04, specularIntensity: 1, envMapIntensity: 1.2,
    attenuationColor: new THREE.Color('#161A21'), attenuationDistance: 0.7,
    transparent: false, depthWrite: true, side: THREE.FrontSide,
  } : {
    color, transmission: 1, roughness: 0.05, thickness: 0.6, ior: 1.5,
    clearcoat: 1, clearcoatRoughness: 0.04, specularIntensity: 1, envMapIntensity: 1.2,
    attenuationColor: new THREE.Color('#D6E6FF'), attenuationDistance: 1.4,
    transparent: false, depthWrite: true, side: THREE.FrontSide,
  });
  const clear = glassPiece(c.white, 'white');
  const smoky = glassPiece(c.black, 'black');
  const frosted = (color) => new THREE.MeshPhysicalMaterial({
    color, transmission: 0, roughness: 0.6, ior: 1.5, clearcoat: 0.7, clearcoatRoughness: 0.35,
    specularIntensity: 0.8, envMapIntensity: 0.9, transparent: false, depthWrite: true, side: THREE.FrontSide,
  });
  return {
    lightSquare: frosted(c.light),
    darkSquare: frosted(c.dark),
    frame: new THREE.MeshPhysicalMaterial({
      color: c.frame, transmission: 0, roughness: 0.18, ior: 1.5, clearcoat: 1, clearcoatRoughness: 0.08,
      envMapIntensity: 1.0, transparent: false, depthWrite: true, side: THREE.FrontSide,
    }),
    whitePiece: clear,
    blackPiece: smoky,
    modeled: (color, army) => {   // the modelled sets' finish (see MODELED_FINISH)
      const m = glassPiece(color, army), f = MODELED_FINISH.glass[army];
      if (f.roughness !== undefined) m.roughness = f.roughness;
      if (f.attenuationDistance !== undefined) m.attenuationDistance = f.attenuationDistance;
      return m;
    },
    textures: [],
  };
}

const BUILDERS = { wood: buildWood, metal: buildMetal, glass: buildGlass };

/**
 * The modelled sets' finish in a theme that is not their own (createMaterialSet: modeledPiece). The sets bake the
 * wood theme's look into their own materials; in metal and glass they take the theme's piece finish, from these
 * builders' `modeled`, over their own normal map and occlusion. `lift` scales the palette colour: a dark chrome at
 * the palette's black is near black once the dim study is all it can reflect. `roughness` (metal) is satin, not
 * the mirror of the theme's own pieces: a satin piece catches the seat fill and the key as a sheen across its
 * whole front, a mirror as one pin-point (critique r3: "the metal theme still reads dark in the study").
 */
const MODELED_FINISH = {
  metal: { white: { lift: 1, roughness: 0.34 }, black: { lift: 1.8, roughness: 0.4 } },
  // the clear glass gets a little body: a touch of frost and a shorter tint, so a clear army on the pale board reads
  // as pale glass from the low seats instead of as outlines
  glass: { white: { lift: 1, roughness: 0.12, attenuationDistance: 0.55 }, black: { lift: 1 } },
};

/** The accent (inset / bezel) materials: same family as the pieces, but the contrasting tone. */
function buildAccents(theme, t) {
  if (theme === 'metal') {
    return {
      whiteAccent: new RimStandardMaterial({ color: t.whiteAccent, metalness: 0.85, roughness: 0.42, envMapIntensity: 0.9 }),
      blackAccent: new RimStandardMaterial({ color: t.blackAccent, metalness: 0.85, roughness: 0.42, envMapIntensity: 0.9 }),
    };
  }
  return {
    whiteAccent: new RimStandardMaterial({ color: t.whiteAccent, metalness: 0, roughness: 0.55, envMapIntensity: 0.4 }),
    blackAccent: new RimStandardMaterial({ color: t.blackAccent, metalness: 0, roughness: 0.55, envMapIntensity: 0.4 }),
  };
}

/**
 * Build the material set for a theme. `palette` may be null (theme defaults) or a partial
 * { light, dark, frame, white, black } of hex strings. Returns the matSet described in CONTRACT.md
 * plus the addendum's unlit / contrast surface.
 *
 * @param {string} theme 'wood' | 'metal' | 'glass'
 * @param {object|null} palette
 * @param {{unlit?: boolean, contrast?: boolean}} [opts]
 */
export function createMaterialSet(theme, palette = null, opts = {}) {
  const id = BUILDERS[theme] ? theme : 'wood';
  const colors = resolvePalette(id, palette);
  const built = BUILDERS[id](colors);
  const tone = tones(colors);
  const accents = buildAccents(id, tone);
  const rim = RIM[id];
  const contactSpec = CONTACT[id];

  const contactTex = makeContactShadowTexture(128);
  const contactShadow = new THREE.MeshBasicMaterial({
    color: new THREE.Color(contactSpec.color),
    map: contactTex || null,
    transparent: true,
    opacity: contactSpec.opacity,
    depthWrite: false,
    toneMapped: false,
    side: THREE.FrontSide,
  });
  contactShadow.name = `${id}.contactShadow`;
  // No canvas (node / a stubbed 2d context) means no radial falloff -- a flat black quad would be worse
  // than nothing, so the decal is simply not rendered there. Its opacity still reports the theme value.
  contactShadow.visible = !!contactTex;

  // Rim patch on everything that is part of a PIECE (never on squares -- the board keeps its own look).
  attachRim(built.whitePiece, tone.whiteRim, 0, rim.power);
  attachRim(built.blackPiece, tone.blackRim, 0, rim.power);
  attachRim(accents.whiteAccent, tone.whiteRim, 0, rim.power);
  attachRim(accents.blackAccent, tone.blackRim, 0, rim.power);

  const mats = [
    built.lightSquare, built.darkSquare, built.frame, built.whitePiece, built.blackPiece,
    accents.whiteAccent, accents.blackAccent, contactShadow,
  ];
  const names = ['lightSquare', 'darkSquare', 'frame', 'whitePiece', 'blackPiece', 'whiteAccent', 'blackAccent', 'contactShadow'];
  names.forEach((n, i) => { mats[i].name = `${id}.${n}`; });
  // +-0.5/255 of noise before the 8-bit write, so the long soft gradients on the board and the pieces do not band
  for (let i = 0; i < 7; i++) mats[i].dithering = true;

  const textures = built.textures.slice();
  if (contactTex) textures.push(contactTex);

  let unlit = !!opts.unlit;
  let contrast = opts.contrast === undefined ? true : !!opts.contrast;

  // The modelled sets' finish in this theme (MODELED_FINISH), one per set material, built on first use: the
  // theme's piece finish over the set's own normal map and occlusion. It shares the theme piece's rim uniforms
  // (so the contrast switch and the palette's rim tone reach it) and follows setPalette / setUnlit / dispose like
  // the rest of the set. The wood theme has none: its finish is the set's own.
  const modeled = new Map();   // the set's own material -> { material, army }
  const modeledColor = (army) => {
    const c = resolvePalette(id, matSet.palette);
    return new THREE.Color(army === 'black' ? c.black : c.white).multiplyScalar(MODELED_FINISH[id][army].lift);
  };

  const matSet = {
    theme: id,
    palette: palette ? { ...palette } : null,
    lightSquare: built.lightSquare,
    darkSquare: built.darkSquare,
    frame: built.frame,
    whitePiece: built.whitePiece,
    blackPiece: built.blackPiece,
    whiteAccent: accents.whiteAccent,
    blackAccent: accents.blackAccent,
    contactShadow,
    textures,
    get unlit() { return unlit; },
    get contrast() { return contrast; },

    /** Effective colours currently applied (theme defaults merged with the palette). */
    colors() { return resolvePalette(id, matSet.palette); },

    /**
     * A modelled set's piece material in this theme: null in wood (the set keeps its own), otherwise the theme's
     * piece finish carrying `own`'s normal map and occlusion (and no emission). Cached per own material.
     * @param {'white'|'black'} color  @param {THREE.Material} own  the set's baked material for that army
     */
    modeledPiece(color, own) {
      if (!built.modeled || !own) return null;
      const hit = modeled.get(own);
      if (hit) return hit.material;
      const army = color === 'black' ? 'black' : 'white';
      const base = army === 'black' ? built.blackPiece : built.whitePiece;
      const m = built.modeled(modeledColor(army), army);
      m.userData.rim = base.userData.rim;
      if (own.normalMap) {
        m.normalMap = own.normalMap;
        m.normalMapType = own.normalMapType;
        m.normalScale.copy(own.normalScale);
      }
      if (own.aoMap) { m.aoMap = own.aoMap; m.aoMapIntensity = 1; }
      m.dithering = true;
      m.name = `${id}.modeled.${army}.${own.name || own.uuid}`;
      if (unlit) setMaterialUnlit(m, true, { shape: true });
      modeled.set(own, { material: m, army });
      return m;
    },

    /** Recolour in place (colour only, maps/params untouched). null restores theme defaults. */
    setPalette(next) {
      requestRedraw('content');
      matSet.palette = next ? { ...next } : null;
      const c = resolvePalette(id, matSet.palette);
      if (built.baked) {
        // baked woods carry their own colour: the palette becomes a tint relative to the theme default
        const ref = THEME_PALETTES.wood;
        const tint = (m, hex, refHex, coat) => {
          const col = woodTint(hex, refHex).multiplyScalar(coat.lift);
          const b = m.userData && m.userData.litBackup;
          if (b && b.color) { m.emissive.copy(col); b.color.copy(col); } else { m.color.copy(col); }
        };
        tint(built.lightSquare, c.light, ref.light, LACQUER.squares);
        tint(built.darkSquare, c.dark, ref.dark, LACQUER.squares);
        tint(built.frame, c.frame, ref.frame, LACQUER.frame);
      } else {
        setLiveColor(built.lightSquare, c.light);
        setLiveColor(built.darkSquare, c.dark);
        setLiveColor(built.frame, c.frame);
      }
      setLiveColor(built.whitePiece, c.white);
      setLiveColor(built.blackPiece, c.black);
      const t = tones(c);
      setLiveColor(accents.whiteAccent, '#' + t.whiteAccent.getHexString());
      setLiveColor(accents.blackAccent, '#' + t.blackAccent.getHexString());
      setRimColor(built.whitePiece, t.whiteRim);
      setRimColor(accents.whiteAccent, t.whiteRim);
      setRimColor(built.blackPiece, t.blackRim);
      setRimColor(accents.blackAccent, t.blackRim);
      for (const { material, army } of modeled.values()) setLiveColor(material, '#' + modeledColor(army).getHexString());
    },

    /**
     * Flat / unlit shading: every material renders its own colour with no light response, so shape
     * reads as pure silhouette. Colours, palette, maps and the contrast aid all survive the switch;
     * metal and glass go flat instead of black. Idempotent.
     */
    setUnlit(on) {
      const next = !!on;
      if (next === unlit) return matSet;
      unlit = next;
      requestRedraw('content');
      for (const m of mats) if (m !== contactShadow) setMaterialUnlit(m, unlit);
      for (const { material } of modeled.values()) setMaterialUnlit(material, unlit, { shape: true });
      return matSet;
    },

    /**
     * settings.lighting.contrast -- the piece-separation aid. Independent of the lights: a rim on the
     * piece silhouette plus the contact-shadow decal under it. No shader recompile either way.
     */
    setContrast(on) {
      requestRedraw('content');
      contrast = !!on;
      setRimAmount(built.whitePiece, contrast ? rim.white : 0);
      setRimAmount(accents.whiteAccent, contrast ? rim.white * 0.6 : 0);
      setRimAmount(built.blackPiece, contrast ? rim.black : 0);
      setRimAmount(accents.blackAccent, contrast ? rim.black * 0.6 : 0);
      contactShadow.opacity = contrast ? contactSpec.opacity : 0;
      contactShadow.visible = contrast && !!contactTex;
      return matSet;
    },

    /** Dispose every material and texture this set created (a modelled set's own maps stay with the set). */
    dispose() {
      for (const m of mats) m.dispose();
      for (const { material } of modeled.values()) material.dispose();
      modeled.clear();
      for (const t of textures) t.dispose();
    },
  };

  matSet.setContrast(contrast);
  if (unlit) { unlit = false; matSet.setUnlit(true); }
  return matSet;
}
