// three/scene.js — renderer, camera, OrbitControls, lights, environment, CSS2D overlay, render loop,
// camera presets / seat rotations / focus tweens, the 2D<->3D view mode, the lighting rig, and
// pointer -> world helpers (raycast, pointerToPlane).
//
// API beyond CONTRACT.md (all additive):
//   - createView(container, settings, deps)   third argument is for tests / embedding, see DEPS below
//   - view.container, view.lights = { hemi, key, fill }, view.envTexture
//   - view.preset (getter: 'white'|'black'|'top'|'side'|'free' — 'free' once the user orbits away)
//   - view.orientation (getter: the seat the camera is nearest to)
//   - view.viewMode (getter: '2d' | '3d'), view.transitioning (getter)
//   - view.setMaterialSet(matSet)   <-- THE INTEGRATOR MUST CALL THIS (see "Unlit" below)
//   - view.onLighting(fn(lighting)) -> unsubscribe        (fires on every setLighting)
//   - view.onViewModeChange(fn(mode, previous)) -> unsubscribe
//   - view.worldToClient(vec3) -> {x, y} | null           (client-space projection of a world point)
//   - view.tween({ duration, onUpdate(t), onDone }) -> cancel()   (the easing tween used for the camera)
//   - view.setAnimations(bool): jump instead of tween (also read live from settings.animations)
//   - view.flyTo({ target?, radius?, phi?, theta?, fov?, duration? }) -> Promise<boolean>
//   - view.render(): one synchronous frame (useful right after a load, before the next rAF)
//   - view.controlsEnabled (getter), view.disposed (getter)
//   - pure, dependency-free exports for tests / the ui: LIGHTING_PRESETS, DEFAULT_LIGHTING,
//     resolveLighting(patch, base), lightingValues(resolved), seatTheta(o), fitDistance(half, fovDeg, aspect),
//     TABLE_TOP ({ y, radius }), keyMirrorPoint(keyPos, cameraPos, planeY)
//   - view.table (Group): the table, see THE SETTING
//   - view.invalidate('camera' | 'content'), view.stats (getter: { frames, renders, shadowUpdates }), see below;
//     with a real WebGLRenderer it also carries `triangles` (the last frame that redrew the shadow map, or with
//     shadows off simply the last frame drawn) and
//     `lastTriangles` (the last frame drawn), each { main, shadow, edge, glow }: what each pass drew, from
//     renderer.info (reset once per frame here, so the passes add up)
//   - view.stats also carries the motion quality: `level`, `reduced`, `interval_ms`, `settles` (see MOTION QUALITY;
//     enumerable with a real WebGLRenderer, readable but not listed with a stand-in one)
//   - view.setMotionQuality('auto' | 'full'), view.setMotionLevel(n | null), view.motionQuality (getter)
//   - view.stats.gpu: the graphics adapter the board draws on (three/gpuName.js), present only when the browser
//     names it (a real WebGLRenderer with WEBGL_debug_renderer_info)
//
// MOTION QUALITY (settings.quality, three/motionQuality.js).
//   On a slow GPU the cost of a frame is per-pixel work, and the worst single item is the key's VSM blur on frames
//   that redraw the shadow map. While the picture is in motion AND the machine is not keeping up, frames are drawn
//   at a cheaper level (MOTION_LEVELS: fewer blur samples, then a lower pixel ratio); once nothing has been owed for
//   MOTION.settleMs, one settle frame is drawn at full quality (full pixel ratio, the configured blur, and a shadow
//   redraw if the map in use was drawn with the cheaper blur). At rest the picture is exactly what it is without this.
//   - A drawn frame is a motion frame when the animation frame before it also drew (however long apart: on a slow
//     machine, or across one stall, the motion goes on), or when the last drawn frame was a motion frame less than
//     settleMs ago (a short gap in a drag). An afterContent follow-up inherits the frame before it, and settle and
//     safety-net frames start nothing. The first frame after a rest is a full one, so a single change (a click), or
//     changes with idle frames between them, are drawn as before and need no settle.
//   - The policy is fed the time between two consecutive animation frames that both drew a motion frame, and keeps
//     one memory per view mode. 2D redraws the key's shadow map on content frames as 3D does, so its level 1 applies
//     there too; 2D is reduced only if it is slow as well. 'full' never reduces. view.render() always draws at full
//     quality.
//   - Motion that never stops (auto-rotate) stays at its level for as long as it lasts: it is motion, and the settle
//     comes when it stops.
//   - At a reduced pixel ratio the edge light's ring and the glow's blur step are scaled with it, so both keep their
//     width in CSS pixels; a lower ratio only softens them.
//   - The pixel ratio is changed in renderFrame, right before that frame's draw, in the same task: the drawing buffer
//     is resized and cleared and drawn at once. The edge light's mask and frame copy (silhouette.js) and the glow's
//     targets (glow.js) size themselves from renderer.getDrawingBufferSize() inside that same draw; the CSS size of the
//     canvas never changes (setPixelRatio resizes without touching the style), and the camera backstop's canvas
//     size is read after the draw, so a resize does not owe an extra frame.
//
// RENDER ON DEMAND.
//   The loop runs on every animation frame (tweens, controls, damping, hooks: cheap bookkeeping) but draws only
//   when something visible may have changed. `invalidate(kind)` owes a frame: 'camera' (only the viewpoint or a
//   post effect's input changed) or 'content' (the lit scene changed; that frame also redraws the key's shadow map,
//   which is otherwise kept -- key.shadow.autoUpdate is false). Sources: the view's own setters (lighting, the
//   environment, background, view mode, material set, resize, the tab coming back, a restored GL context), every
//   tween (camera tweens as 'camera'), the controls' events, onFrame hooks (see onFrame), and three/redraw.js,
//   through which the board, the piece layer (its ticker included), the materials and the piece sets ask for
//   frames without knowing the view. Two backstops sit under those: a frame is owed whenever the camera's matrices
//   or the canvas size differ from the last drawn frame ('camera'), or any object's place, visibility, child count
//   or material state does ('content'); and with nothing owed a 'camera' frame is still drawn every SAFETY_NET_MS.
//   Every 'content' frame is followed by one 'camera' frame (the settled picture after a material rebuild), and a
//   camera that comes to rest gets its leftover damping cleared and one last frame drawn where it stopped.
//   The shadow map does not depend on the viewpoint: the key is a fixed directional light whose orthographic shadow
//   camera is set from the key alone (DirectionalLightShadow ignores the view camera); aimSeatLights moves only the
//   seat fill, which casts no shadow; updateClip changes only the view camera's near / far.
//
// 2D MODE — how it is projected, and why.
//   The 2D camera is the SAME PerspectiveCamera, narrowed to a 12 deg field of view and pulled back to
//   ~47 units (`fitDistance`). At that focal length the projection is near-orthographic: a 0.35-unit
//   lifted token at the board corner shifts by 0.034 units (3% of a square), which is invisible, while
//   `raycast`, `pointerToPlane`, CSS2D labels and every module that captured `view.camera` keep working
//   exactly as they do in 3D. Swapping in an OrthographicCamera would change the type of `view.camera`
//   mid-session for five other modules; this does not.
//   The polar angle is pinned to TOP_EPS (0.0035 rad = 0.2 deg) rather than exactly 0: at a true 0 the
//   camera's roll is undefined (up is parallel to the view direction) and `lookAt` picks it arbitrarily,
//   so the board could not be rotated to the other seat. The tilt costs 0.0012 units of shear per unit of
//   height — nothing — and makes the azimuth well defined, so `rotateSeat` is the same code in both modes.
//   `controls.enableRotate = false` plus minPolarAngle === maxPolarAngle === TOP_EPS means nothing can
//   tilt it; pan (middle-drag / shift+left-drag / two fingers) and zoom stay on.
//   Near/far are pulled in to [0.45d, 1.9d+20] while in 2D: at a 47-unit distance with near = 0.1 the
//   depth buffer resolves ~2e-3 units, which is the same order as the 0.004-0.020 overlay stack and would
//   z-fight the arrows and dots. With the tight near plane it resolves ~5e-6.
//
// LIGHTING / "off".
//   `setLighting({ on:false })` (or preset 'flat') does NOT dim the lights — it switches the scene to
//   unlit shading: renderer.toneMapping -> NoToneMapping, scene.environment -> null (otherwise metal and
//   glass go black), key/hemi/fill -> 0, shadows off, and `matSet.setUnlit(true)` so materials.js flattens
//   its materials in place (the colour moves into `emissive`; see materials.js setMaterialUnlit). The view
//   owns the lights and the table; it needs the material set to do the rest, so main.js must call
//   `view.setMaterialSet(matSet)` after createMaterialSet and again on every theme change. Anyone else who
//   needs to react (the modelled sets, the board's gilt coordinates) subscribes with `view.onLighting`.
//
// DEPS (third argument, all optional — production passes nothing):
//   { renderer, labelRenderer, environment = true }  — supply a stand-in renderer / CSS2D renderer, or
//   pass environment:false to skip the PMREM pass. Used by test/view-modes.test.mjs to run headless.
//
// THE SETTING (2026-09-24 pass):
//   - The key light stands off White's right, square to the two seats (LIGHTING_PRESETS keyPos). A directional
//     light's mirror image on a flat top lies from the camera's foot toward the light's azimuth
//     (keyMirrorPoint), so a key standing on one seat's side of the table is mirrored in front of the other
//     seat. From the side it lands past the table's rim for both seats' presets and their low three-quarter
//     views (tested).
//   - Soft shadows are VSMShadowMap, blurred by shadow.radius (texels) over shadow.blurSamples. Round 2 used
//     PCFShadowMap + radius, but three's PCF rotates a five-tap Vogel disk per pixel by interleaved-gradient
//     noise -- a pattern meant to be averaged by TAA, which this app has not got -- so every penumbra showed as a
//     regular stipple (critique r2). VSM filters the map itself, so the penumbra is a smooth ramp.
//   - The table is a turned walnut pedestal table (top with a rounded edge, apron, a beaded column on a stepped
//     foot) under the same unlit switch as the board, and its lacquer is soft and uneven (materials.js
//     makeLacquerTexture) so the room's lamp does not clip in it. The board stands on a dark green felt pad, so
//     frame and top no longer meet brown on brown; a soft shadow sits under the foot. view.table is the group;
//     hidden in 2D and in 'plain'. The Studio adds a floor (ENVIRONMENTS[].floor); Plain, which floats the board
//     over the page, gets a drop shadow under it instead (critique r4).
//   - What the pieces reflect below the horizon is the table and the board (tableUnder), not the HDRI's floor:
//     the study's rug swirled across Classic's ebony (critique r4). The HDRI rooms' reflection blur is done on the
//     sphere (blurEquirect), not by PMREM's twenty-sample spiral, which speckled every mirror coat in the Studio.
//   - In 3D the camera never drops below the table top (keepAboveTable: the orbit target stays on or above it,
//     and MAX_POLAR / MIN_DIST keep the camera at least TABLE_CLEARANCE over it).
//   - A CSS vignette (div.vignette3d, between the canvas and the labels / UI, never hit-tested) darkens the
//     corners by VIGNETTE in 3D only; it fades out with the switch to 2D.
//   - Every gradient is dithered +-0.5/255 before its 8-bit write: the lit materials by `dithering`, the room
//     behind by a patch to three's background shader (ditherBackground) -- critique r3 saw the floor band.
//   - What gives off light glows (glow.js, after the frame: Estate's windows and lamps), in lit 3D only; the
//     pass is skipped when nothing emissive is in view, so the other sets draw exactly as without it.
//
// READING THE FAR ARMY (2026-09-24, critique r2: the far crowns sat dark-on-dark from White's seat).
//   Ebony and boxwood are only ~4x apart in display terms, so no single background brightness can sit 3:1 from
//   both under even light: the far army needs light the table does not get. Two camera-relative lights, re-aimed
//   every frame (aimSeatLights), both off in 2D and when unlit:
//   - the seat fill (view.lights.seat): a real DirectionalLight from behind the camera, SEAT_ELEVATION up, no
//     shadow. Low, so it lights the upright faces the player sees (the far army's too) ~4x more than the flat
//     board; on the camera's side, so it can never mirror in anything flat in view.
//   - the edge light (silhouette.js): what a lamp behind the far rank would draw -- a thin line of the room's light
//     on the OUTER silhouette of the pieces in the far half of the board, after the frame, from a mask of the
//     pieces. Not a THREE light (one behind the far army mirrors in the lacquer from every low seat), and no
//     longer a term in the piece shaders: those could not tell an outline from a crease and drew cream lines on
//     flute ridges, crenels and stone joints (critique r4).
//   Measured with tools/readability.mjs (far crowns against what is behind them, frame / checker / clip).
//
// Notes:
//   - setQuality({ antialias }) is accepted but NOT live: WebGL fixes antialias at context creation and a
//     new canvas would orphan the interaction module's listeners. The renderer is created with antialias on.
//   - setQuality({ shadows }) routes through setLighting so the two never disagree.
//   - mouseButtons.RIGHT = null is safe in three 0.186: onMouseDown maps null -> state NONE (verified in source).
//   - In 2D, left-drag does nothing (enableRotate false) but shift+left still pans, because OrbitControls
//     checks the shift modifier before it checks enableRotate.

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
import { createMotionPolicy, MOTION, MOTION_LEVELS, normalizeQuality } from './motionQuality.js';
import { readGpuName } from './gpuName.js';

/**
 * Where the board sits (settings.environment). 'room' is a study at night rendered in Blender (blender/
 * room_hdri.py): books, a fireplace, lamps and one small night window, so the mood holds from every seat.
 * 'studio' is a CC0 HDRI from Poly Haven (Greg Zaal, "studio_small_01", the 1K copy Blender bundles). Both
 * (assets/index.js, handed in as deps.assets) light the reflections and show, blurred, behind the board, which
 * stands on a round walnut table. 'plain' is the original look -- a synthetic RoomEnvironment for reflections and the page
 * colour behind the board -- and what you get when no assets were passed (node tests).
 * `rot` turns the room (radians); `light` scales the direct hemisphere/fill lights, which the HDRI mostly replaces;
 * `seat` / `back` scale the seat fill and the far army's edge light (READING THE FAR ARMY in the header); `envBlur`
 * blurs what the lacquer reflects (the PMREM sigma, radians -- an HDRI room's background keeps its own `blur`);
 * `bgKnee` compresses the background's highlights above that radiance (the Studio's softbox blew out to white from
 * the side, critique r4); `floor` gives a room without one a floor under the table (the Studio stood in a void);
 * `under` is the board's luminance as the pieces reflect it below the horizon (see TABLE_REFLECTION); `tint` the
 * colour of the room's light (the upper hemisphere's average, normalised), which the far army's edge light takes.
 * Plain (2026-09-24): the synthetic room's light panels are far brighter than anything in the HDRIs, and at
 * grazing angles the lacquer mirrored them across half the board (critique r2: the checker washed out to 1:1
 * from Black's low seat). `envBlur` spreads them, `env` dims them, and `rot` turns the room 45 degrees so no
 * seat's grazing reflection runs straight into a wall's panel; the direct lights and a lower exposure make up the
 * diffuse, which also keeps the light squares under ACES's shoulder.
 * Studio (2026-09-24): the same wash on a smaller scale -- the HDRI's softbox mirrored on the a/b files from
 * White's low seat (dark squares at ~210) -- spread by `envBlur` into a sheen (every neighbour pair >= 2:1).
 * The Room (2026-09-24, for the re-rendered study): turned so both seats look into the darker book walls (u ~0.14
 * and ~0.64 of the panorama) and the window, the lamp and the chimney wall stand to the sides -- a light far army
 * reads against them directly and a dark or grey one by its back-lit edge; the room kept dim (bg) so it reads as
 * a room, not as a light source. `exposure` is what brings the board up to a mid-key (light squares ~195, frame
 * ~60) under that dimmer room. Blur 0.07 since the study got a floor (a parquet and a rug; critique r3: the default
 * seat framed a flat mauve void): enough that the book spines stay soft behind the far rank from the low seats, not
 * so much that the floor around the table melts back into a smear from the default one (the far crowns' numbers
 * barely move between 0.07 and 0.12 -- it is the brighter floor, not the focus, that sets them now).
 */
export const ENVIRONMENTS = {
  room: { hdr: 'room', blur: 0.07, bg: 0.35, rot: 5.6, env: 1.15, light: 0.35, exposure: 1.79, seat: 1, back: 1, under: 0.15, tint: [1, 0.85, 0.71], label: 'Room' },
  studio: { hdr: 'studio', envBlur: 0.8, blur: 0.55, bg: 0.30, bgKnee: 80, floor: 0x6a6d72, rot: 1.57, env: 1.0, light: 0.35, exposure: 0.95, seat: 1, back: 1, under: 0.27, tint: [0.77, 0.92, 1], label: 'Studio' },
  plain: { hdr: null, envBlur: 0.9, rot: 0.7854, env: 0.45, light: 1.15, exposure: 0.9, seat: 0.8, back: 0.8, tint: [1, 0.97, 0.93], label: 'Plain' },
};
const TABLE_Y = -0.322;          // just under the frame's underside (FRAME_TOP - FRAME_DEPTH in board.js)
/**
 * The table below the board (world units; a square is ~6 cm, so this is an 85 cm round pedestal table at 74 cm).
 * `unlit` is the tint the walnut takes with the lights off: the board's own walnut frame renders at full
 * texture colour, so the table sits a step below it and the board still reads as the lighter object.
 */
const TABLE = {
  radius: 7.4, thick: 0.16, edge: 0.06,        // the top, with a quarter-round edge of radius `edge`
  apronR: 6.35, apronH: 0.46,                  // the band under the top, set in from the rim
  height: 12.4,                                // table top to floor
  color: 0xb9aaa0, lift: 2.2, unlit: 0.82,     // lift: a mid walnut, so the far army's crowns read against it
  grainRepeat: 2.6,                            // the walnut texture's repeat (its tiles per UV unit), every part
  // the felt pad the board stands on: a board-sized margin of dark green baize between the walnut frame and the
  // walnut top, which otherwise met brown on brown (critique r4)
  pad: { half: 5.0, corner: 0.18, thick: 0.012, color: 0x1d3328 },
  // a thin, warm lacquer: at grazing angles its reflection of the room's cool walls read as a violet cast on the
  // rim (critique r2); what reflection is left is tinted like amber varnish. (No envMapIntensity: with a scene
  // environment three >= r163 overrides it with scene.environmentIntensity.)
  lacquer: { roughness: 0.5, specularIntensity: 0.12, specularColor: 0xffc080, clearcoat: 0.14, clearcoatRoughness: 0.46, repeat: 5 },
};
/** The table top's plane and rim, for anyone reasoning about reflections on it (tests). */
export const TABLE_TOP = Object.freeze({ y: TABLE_Y, radius: TABLE.radius });
const TABLE_CLEARANCE = 0.25;    // the lowest the 3D camera may sit above the table top
const VIGNETTE = 0.12;           // corner darkening of the 3D vignette (alpha of black at the corners)
const SEAT_ELEVATION = 15 * Math.PI / 180;   // the seat fill's height above the horizon (see the header)

/**
 * Dither the room behind the board. Every lit material here sets `dithering`, but three draws scene.background with
 * its own backgroundCube shader, which has no dither chunk, and the dim blurred panorama is exactly the long, slow
 * gradient that bands in 8 bits (critique r3: the floor and the vignette in steps). The same +-0.5/255 noise as
 * three's dithering_fragment is spliced in after the colour-space step. Patches three's shared ShaderLib entry, once,
 * before the first background is drawn (the background material is built on first use).
 */
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

/**
 * What a glossy piece sees below the horizon: the table and the board it stands on, not the room's floor. The HDRIs
 * were rendered without the table, so the ebony mirrored the study's rug through the board as red and blue swirls
 * (critique r4). Seen from a piece, a ray a few degrees down leaves the board and meets the frame and the table (dark
 * walnut); a steeper one meets the board itself, which the room and the key light up to a mid tone -- a silver piece
 * that mirrored only the dark table read as tarnished. So: the room down to `horizon` degrees, the table by
 * `tableTo`, the board from `boardFrom`. `table` is the walnut's radiance (linear, before the room's intensity); the
 * board is ENVIRONMENTS[].under (its luminance, measured off the rendered wood checker) in `boardTint`, all but
 * neutral: the checker's colour depends on the theme and the reflection does not, and any real warmth there turned
 * the metal theme's silver cups brass (their outer walls face down, at the board).
 */
const TABLE_REFLECTION = { table: [0.017, 0.010, 0.006], boardTint: [1.04, 1.0, 0.94], horizon: 3, tableTo: 6, boardFrom: 16 };
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/**
 * A copy of an equirect panorama with everything below the horizon replaced by the table and the board (see
 * TABLE_REFLECTION; `boardLum` is the board's luminance) -- the reflection environment's source; scene.background
 * keeps the whole room. Row 0 is the zenith.
 */
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
    const toTable = smooth01(below / horizon), toBoard = smooth01((below - tableTo) / (boardFrom - tableTo));
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

/**
 * A copy of an equirect panorama with its highlights rolled off above `knee` (they approach 2 x knee): the background
 * only -- the reflections keep the lights at full strength.
 */
export function kneeEquirect(eq, knee) {
  const { data, width: W, height: H } = eq.image;
  const out = new data.constructor(data.length);
  out.set(data);
  const half = data instanceof Uint16Array;
  const read = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
  const write = half ? THREE.DataUtils.toHalfFloat : (v) => v;
  for (let i = 0; i < W * H * 4; i += 4) {
    const r = read(data[i]), g = read(data[i + 1]), b = read(data[i + 2]);
    const l = Math.max(r, g, b);
    if (l <= knee) continue;
    const k = (knee + (l - knee) / (1 + (l - knee) / knee)) / l;
    out[i] = write(r * k); out[i + 1] = write(g * k); out[i + 2] = write(b * k);
  }
  const tex = new THREE.DataTexture(out, W, H, eq.format, eq.type);
  for (const key of ['colorSpace', 'minFilter', 'magFilter', 'generateMipmaps', 'flipY', 'mapping']) tex[key] = eq[key];
  tex.needsUpdate = true;
  return tex;
}

/**
 * A Gaussian blur of an equirect panorama on the sphere, `sigma` radians, into a small panorama (BLUR_GRID texels;
 * a blur this wide has no detail finer than that). Brute force over the downsampled texels, weighted by solid angle.
 * It replaces PMREM's own scene blur for the HDRI rooms: that one importance-samples twenty directions on a golden-
 * angle spiral per pass, and the Studio's small, very bright softboxes came through it as sunflower-shaped speckle
 * in every mirror-smooth coat -- the ebony read as "blue speckled granite" (critique r4).
 */
const BLUR_GRID = [64, 32];
export function blurEquirect(eq, sigma) {
  const { data, width: W, height: H } = eq.image;
  const half = data instanceof Uint16Array;
  const read = half ? THREE.DataUtils.fromHalfFloat : (v) => v;
  const [w, h] = BLUR_GRID;
  // 1. box-average down to the grid
  const src = new Float32Array(w * h * 3);
  const bx = W / w, by = H / h;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = Math.floor(y * by); yy < Math.floor((y + 1) * by); yy++) {
      for (let xx = Math.floor(x * bx); xx < Math.floor((x + 1) * bx); xx++) {
        const i = (yy * W + xx) * 4;
        r += read(data[i]); g += read(data[i + 1]); b += read(data[i + 2]); n++;
      }
    }
    const o = (y * w + x) * 3;
    src[o] = r / n; src[o + 1] = g / n; src[o + 2] = b / n;
  }
  // 2. the weights: the Gaussian on the angle between two texel centres times the source texel's solid angle.
  // They depend only on the two latitudes and the longitude step between them, so they are tabulated once.
  const lat = (y) => (0.5 - (y + 0.5) / h) * Math.PI;
  const inv = 1 / (2 * sigma * sigma);
  const wt = new Float32Array(h * h * w);
  for (let yk = 0; yk < h; yk++) for (let yj = 0; yj < h; yj++) for (let dx = 0; dx < w; dx++) {
    const a1 = lat(yk), a2 = lat(yj), dl = (dx / w) * 2 * Math.PI;
    const c = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dl);
    const ang = Math.acos(Math.min(1, Math.max(-1, c)));
    wt[(yk * h + yj) * w + dx] = Math.exp(-ang * ang * inv) * Math.cos(a2);
  }
  // 3. the blur
  const out = new Uint16Array(w * h * 4);
  for (let yk = 0; yk < h; yk++) for (let xk = 0; xk < w; xk++) {
    let r = 0, g = 0, b = 0, sum = 0;
    for (let yj = 0; yj < h; yj++) {
      const row = (yk * h + yj) * w;
      for (let xj = 0; xj < w; xj++) {
        const f = wt[row + ((xj - xk + w) % w)], j = (yj * w + xj) * 3;
        r += src[j] * f; g += src[j + 1] * f; b += src[j + 2] * f; sum += f;
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

/**
 * The reflections' environment for an HDRI room. `envBlur` (radians, ENVIRONMENTS) blurs the panorama first
 * (blurEquirect), so a small bright light in it spreads into a soft sheen instead of mirroring as a hot patch in
 * the lacquer; the background keeps the sharp panorama.
 */
function hdriEnvironment(pmrem, eq, envBlur, boardLum) {
  if (!envBlur) return pmrem.fromEquirectangular(eq);
  const blurred = blurEquirect(eq, envBlur);
  const under = tableUnder(blurred, boardLum);   // the blur spread the room back below the horizon: the table again
  const target = pmrem.fromEquirectangular(under);
  blurred.dispose(); under.dispose();
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

// ---------------------------------------------------------------------------------------------
// The table (built once, browser only -- it needs the walnut texture)
// ---------------------------------------------------------------------------------------------

/** Cubic Bezier in the (radius, height) plane: n points after p0. */
function bezierPts(p0, c0, c1, p1, n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push(new THREE.Vector2(a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0], a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]));
  }
  return out;
}

/** The top's rim: underside -> out -> up -> a quarter-round onto the flat top (outward normals, like pieces.js). */
function tableEdgeProfile(y0) {
  const { radius: R, thick, edge: e } = TABLE;
  const pts = [new THREE.Vector2(R - 0.05, y0 - thick), new THREE.Vector2(R, y0 - thick + 0.04), new THREE.Vector2(R, y0 - e)];
  for (let i = 1; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    pts.push(new THREE.Vector2(R - e + e * Math.cos(a), y0 - e + e * Math.sin(a)));
  }
  return pts;
}

/**
 * The turned pedestal, floor to the underside of the top: a stepped foot (plinth, torus, cove, ogee), a beaded
 * collar, the baluster, the neck, a double-bead ring on the shaft, a beaded collar and torus under the flare into the
 * bearer plate. Critique r4 read the plain column as "a vase shape": the beads and fillets are what make it turned.
 */
function pedestalProfile(y0) {
  const F = y0 - TABLE.height, T = y0 - TABLE.thick;
  const pts = [new THREE.Vector2(0, F), new THREE.Vector2(3.35, F)];
  const at = () => { const p = pts[pts.length - 1]; return [p.x, p.y]; };
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

/**
 * UVs for a turned part cut from the walnut: the grain (the texture's u -- the direction it runs along the board's
 * frame) follows the profile by arc length, `unit` world units to one texture unit, and the texture wraps a whole
 * number of tiles around (`tiles` at the texture's `repeat`), so there is no seam. LatheGeometry's own v is the
 * point index, so where a profile's points bunch up -- the collar and the flare under the top -- the grain was
 * squeezed into a mirrored chevron (critique r3).
 */
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

/**
 * Build the table into `group` over the walnut texture: flat top + rounded rim, apron with a bead, pedestal.
 * One material for all of it (returned, for the unlit switch and dispose). Only the top receives shadows.
 */
function buildTable(group, tex) {
  const L = TABLE.lacquer;
  const lacquer = makeLacquerTexture(256, 11, L.repeat);
  // The lacquer is the glossy layer; the wood under it keeps only a little specular of its own (a full-strength
  // rough base specular reads as a milky haze over the grain).
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
  // the felt pad under the board (see TABLE.pad), a rounded square on the top, under the frame
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
  // the table's own shadow on the floor, under the foot (a soft disc: the rooms' floors are pictures)
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
  s.lineTo(h - r, -h); s.quadraticCurveTo(h, -h, h, -h + r);
  s.lineTo(h, h - r); s.quadraticCurveTo(h, h, h - r, h);
  s.lineTo(-h + r, h); s.quadraticCurveTo(-h, h, -h, h - r);
  s.lineTo(-h, -h + r); s.quadraticCurveTo(-h, -h, -h + r, -h);
  return s;
}

/** A soft round shadow as an alpha map (white = dark at the centre, fading out), or null without a canvas. */
function radialShadowTexture(size = 128) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext && c.getContext('2d');
  if (!ctx || typeof ctx.createRadialGradient !== 'function' || typeof ctx.fillRect !== 'function') return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, '#ffffff'); g.addColorStop(0.45, '#9a9a9a'); g.addColorStop(0.8, '#2a2a2a'); g.addColorStop(1, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

/**
 * A soft rectangular shadow as an alpha map: a square of half-size `inner` (the texture's half-size is 1) at full
 * strength, fading out to the edge -- the Plain board's drop shadow. Null without a canvas.
 */
function rectShadowTexture(inner, size = 256) {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext && c.getContext('2d');
  if (!ctx || typeof ctx.getImageData !== 'function' || typeof ctx.putImageData !== 'function') return null;
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = Math.abs((x + 0.5) / size * 2 - 1), v = Math.abs((y + 0.5) / size * 2 - 1);
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
const FOV_2D = 12;               // narrow enough to read as orthographic (see header)
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
const WASH_CEIL = 2.8;           // top-face illuminance ceiling; above it exposure is pulled back (see lightingValues)

const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
/** Wrap an angle delta into (-PI, PI]; an exact half-turn goes the positive way. */
const wrapDelta = d => { d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return d <= -Math.PI + 1e-9 ? Math.PI : d; };

/**
 * Where a directional light's mirror image lands on the horizontal plane y = planeY, seen from a camera at
 * `cameraPos` ([x, y, z]); `keyPos` is the light's position (it shines at the origin). Returns { x, z }, or null
 * when the camera or the light is not above the plane. Outside TABLE_TOP.radius means no glare on the table.
 */
export function keyMirrorPoint(keyPos, cameraPos, planeY = TABLE_Y) {
  const len = Math.hypot(keyPos[0], keyPos[1], keyPos[2]);
  const h = cameraPos[1] - planeY;
  if (!(len > 0) || !(h > 0) || !(keyPos[1] > 0)) return null;
  const t = h / (keyPos[1] / len);      // along the reflected ray, from the plane up to the camera's height
  return { x: cameraPos[0] + t * keyPos[0] / len, z: cameraPos[2] + t * keyPos[2] / len };
}

/** Spherical theta for a seat name. */
export function seatTheta(orientation) { return SEAT_THETA[orientation === 'black' ? 'black' : 'white']; }

/** Distance at which a half-extent of `half` board units exactly fills the tighter screen axis. */
export function fitDistance(half, fovDeg, aspect = 1) {
  const halfV = THREE.MathUtils.degToRad(fovDeg / 2);
  const halfH = Math.atan(Math.tan(halfV) * (Number.isFinite(aspect) && aspect > 0 ? aspect : 1));
  return half / Math.tan(Math.min(halfV, halfH));
}

// ---------------------------------------------------------------------------------------------
// Lighting model (pure — exported so the ui and the tests can reason about it without a renderer)
// ---------------------------------------------------------------------------------------------

/**
 * Base intensities per preset. `exposure` is the tone-mapping exposure the preset resets to; the
 * user's `key` / `ambient` are multipliers (0..2) on top of `key` / `hemi`+`fill`+`env`.
 * 'flat' is the unlit look: no lights, no environment, no tone mapping.
 */
export const LIGHTING_PRESETS = {
  // Every key stands off White's right with almost no z, so its mirror image lands past the table's rim from
  // both seats (see THE SETTING in the header). shadowRadius is the VSM blur radius in shadow-map texels (2048
  // over 12 units: 5 texels is a ~0.03-unit penumbra).
  // `seat` is the seat fill and `back` the far army's edge light (see READING THE FAR ARMY in the header).
  //        exposure  key   hemi  fill  env   seat  back  keyPos              shadowRadius
  studio: { exposure: 1.00, key: 1.50, hemi: 0.55, fill: 0.30, env: 0.70, seat: 1.20, back: 0.40, keyPos: [7.4, 7.6, 1.0], shadowRadius: 5 },
  soft: { exposure: 1.05, key: 0.90, hemi: 1.00, fill: 0.50, env: 0.85, seat: 1.10, back: 0.34, keyPos: [5.6, 9.5, 0.8], shadowRadius: 8 },
  bright: { exposure: 1.30, key: 1.30, hemi: 1.15, fill: 0.55, env: 0.95, seat: 1.25, back: 0.40, keyPos: [7.0, 7.5, 0.8], shadowRadius: 5 },
  flat: { exposure: 1.00, key: 0.00, hemi: 0.00, fill: 0.00, env: 0.00, seat: 0.00, back: 0.00, keyPos: [0, 10, 0], shadowRadius: 1 },
};

export const DEFAULT_LIGHTING = { preset: 'studio', on: true, exposure: 1.0, key: 1.0, ambient: 1.0, shadows: true };

/**
 * Merge a patch onto the current lighting settings and clamp it.
 * Naming a NEW preset resets exposure / key / ambient to that preset's defaults unless the same patch
 * also names them — so the segmented control behaves like a preset picker, not a no-op.
 */
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

/**
 * Resolved settings -> the numbers the renderer / lights actually take.
 * `unlit` is true when the master switch is off OR the preset is 'flat'; in that mode every light goes
 * to 0, the environment is dropped and tone mapping is disabled so material colours come through raw.
 * `exposure` is pulled back when the lit result would blow out the board's top faces (WASH_CEIL) — the
 * user's slider value is kept in the settings, `applied.exposure` is what the renderer got.
 */
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
  // A rough proxy for how much light a flat, upward-facing white square receives.
  // (The seat fill is left out: it sits 15 deg up, so a flat square gets a quarter of it.)
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

// ---------------------------------------------------------------------------------------------
// createView
// ---------------------------------------------------------------------------------------------

/** Create the Three.js view inside `container` (renderer + CSS2D overlay + camera + controls + lights); returns the view handle (see CONTRACT.md). */
/** A mesh of a piece (under a group with userData role + color), not its contact shadow or a 2D glyph card. */
function isPieceMesh(o) {
  if (!o.isMesh || (o.userData && (o.userData.contactShadow || o.userData.glyphCard))) return false;
  for (let p = o.parent; p; p = p.parent) if (p.userData && p.userData.role && p.userData.color) return true;
  return false;
}

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

  // --- render on demand (see RENDER ON DEMAND in the header) ----------------------------------------
  // `pending` is the frame owed: null (nothing changed), 'camera' (draw, keep the shadow map) or 'content'
  // (draw and redraw the shadow map). It is declared this early because the setters below invalidate.
  let pending = 'content';
  const stats = { frames: 0, renders: 0, shadowUpdates: 0 };
  let effects = true;           // view.effects: the edge light and the glow after the frame
  // Motion quality (see MOTION QUALITY in the header): one policy per view mode, and what the renderer holds now.
  let quality = normalizeQuality(settings.quality);
  const policies = { '3d': createMotionPolicy(), '2d': createMotionPolicy() };
  for (const p of Object.values(policies)) p.setMode(quality);
  let ratioScale = 1;           // the pixel-ratio factor the renderer is set to now
  let shadowReduced = false;    // the shadow map in use was drawn with fewer blur samples than configured
  let reduced = false;          // the last drawn frame was below full quality
  let settles = 0;
  function invalidate(kind) {
    if (kind === 'content') pending = 'content';
    else if (!pending) pending = 'camera';
  }

  // --- container -------------------------------------------------------------------------------
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
  if (cs && cs.position === 'static') container.style.position = 'relative';
  if (cs && cs.overflow === 'visible') container.style.overflow = 'hidden';

  // --- renderer --------------------------------------------------------------------------------
  const renderer = deps.renderer || new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', stencil: false });
  const screenPixelRatio = () => Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
  let pixelRatio = screenPixelRatio();   // re-read on resize: the window may move to a screen with another ratio
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = settings.shadows !== false;
  renderer.shadowMap.type = THREE.VSMShadowMap;   // smooth soft shadows (see THE SETTING in the header)
  renderer.setClearColor(0x000000, 0);
  // Production builds skip three's shader diagnostics: they read every program's info log back synchronously, and
  // on Windows the D3D compiler's harmless precision notes (X4122, from three's own depth packing) filled the
  // console on every boot (critique r4). Development builds and the tests keep them.
  if (renderer.debug) renderer.debug.checkShaderErrors = process.env.NODE_ENV !== 'production';
  const glow = renderer.isWebGLRenderer ? createGlow(renderer) : null;   // emissive glow (a stand-in renderer has none)
  const silhouette = renderer.isWebGLRenderer ? createSilhouette(renderer, isPieceMesh, standInOf) : null;   // the far army's edge
  // Triangles per pass (view.stats). renderer.info is reset once per frame in renderOnce, not per render() call, so
  // the shadow map, the frame and the passes after it can be told apart.
  const tris = renderer.isWebGLRenderer && renderer.info ? { main: 0, shadow: 0, edge: 0, glow: 0 } : null;
  const trisFull = tris ? { ...tris } : null;
  // The graphics adapter (view.stats.gpu). It does not change while the context lives; it is read again when a lost
  // context comes back, which can be on another adapter.
  const readAdapter = () => (renderer.isWebGLRenderer && typeof renderer.getContext === 'function' ? readGpuName(renderer.getContext()) : '');
  let gpuName = readAdapter();
  if (tris) renderer.info.autoReset = false;
  // The modelled sets' low-detail stand-ins (pieces.js standInOf) draw the shadow map in the full pieces' place.
  // three 0.186 draws the map inside renderer.render after the frame's draw list is built and before that list
  // is drawn (WebGLRenderer.render: projectObject, then shadowMap.render, then renderScene), and the map takes
  // every visible caster -- and, with VSM, every visible receiver (WebGLShadowMap renderObject). So for the length
  // of the map each full mesh is hidden and its stand-in shown, wearing the full mesh's material (the depth
  // material copies its side); the frame's list already holds the full meshes and none of the stand-ins.
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

  const onContextLost = e => { e.preventDefault(); };
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  // A restored context has lost every render target, the shadow map included: draw everything again.
  const onContextRestored = () => { gpuName = readAdapter(); invalidate('content'); };
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);

  // --- CSS2D overlay ---------------------------------------------------------------------------
  const labelRenderer = deps.labelRenderer !== undefined ? deps.labelRenderer : new CSS2DRenderer();
  if (labelRenderer && labelRenderer.domElement) {
    Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none', overflow: 'hidden' });
    labelRenderer.domElement.className = 'labels3d';
    if (deps.labelRenderer === undefined) container.appendChild(labelRenderer.domElement);
  }

  // --- scene / camera --------------------------------------------------------------------------
  const scene = new THREE.Scene();
  scene.background = null;
  const camera = new THREE.PerspectiveCamera(FOV_3D, 1, 0.1, 200);
  camera.position.set(...PRESETS.white.pos);
  camera.lookAt(0, 0, 0);

  // --- controls --------------------------------------------------------------------------------
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.8;
  controls.panSpeed = 0.9;
  controls.zoomSpeed = 1.0;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null }; // right button is the annotation button
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
  // Once the user actually moves the camera (drag with a button down, or wheel) the named preset no
  // longer describes it and any camera tween yields. A plain click (no movement) leaves both alone,
  // so clicking a piece during a 600 ms flip does not strand the camera between seats.
  // A 2D<->3D transition is NOT interruptible: enableRotate is off for its duration anyway, and letting a
  // stray drag cancel it would strand the camera half-way with a 26-degree field of view.
  const onUserMove = () => { if (transitioning) return; preset = 'free'; cancelCameraTween(); };
  const onPointerMoveUser = e => { if (controls.enabled && (e.buttons & 5)) onUserMove(); }; // left or middle button held
  const onWheelUser = () => { if (controls.enabled && controls.enableZoom) onUserMove(); };
  canvas.addEventListener('pointermove', onPointerMoveUser, { passive: true });
  canvas.addEventListener('wheel', onWheelUser, { passive: true });
  // The controls move only the viewpoint ('change' also fires while damping or auto-rotate keep it moving).
  const onControlsMove = () => invalidate('camera');
  for (const type of ['start', 'change', 'end']) controls.addEventListener(type, onControlsMove);

  // --- lights ----------------------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x6b5a4a, 0.55);
  hemi.position.set(0, 10, 0);
  scene.add(hemi);

  // The key sits lower than a pure overhead lamp (about 46 deg) on purpose: seen from straight above,
  // a steep key lights the top faces evenly and a white piece dissolves into a light square. A grazing
  // key throws a contact shadow that gives the piece an edge. It stands off White's right, square to the
  // seats, so neither seat sees it mirrored in the lacquer (see THE SETTING in the header).
  const key = new THREE.DirectionalLight(0xffffff, 1.5);   // neutral: a warm key turned boxwood and porcelain beige
  key.position.set(...LIGHTING_PRESETS.studio.keyPos);
  key.target.position.set(0, 0, 0);
  key.castShadow = settings.shadows !== false;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 40;
  key.shadow.camera.left = -6; key.shadow.camera.right = 6;
  key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = LIGHTING_PRESETS.studio.shadowRadius;
  key.shadow.blurSamples = 16;
  // The key's shadow map depends only on the key and on what casts or (VSM) receives a shadow, never on the
  // viewpoint: it is redrawn on 'content' frames only (renderFrame), not on every frame.
  key.shadow.autoUpdate = false;
  scene.add(key);
  scene.add(key.target);

  const fill = new THREE.DirectionalLight(0xcfd8ff, 0.30);
  fill.position.set(-6, 5, -5);
  scene.add(fill);

  // The seat fill: from the camera's side, SEAT_ELEVATION up, re-aimed every frame (aimSeatLights). It lights
  // the faces of the pieces the player looks at -- the far army's included -- about four times more than it
  // lights the flat board, and a light on the camera's side cannot mirror in anything flat the camera sees.
  const seat = new THREE.DirectionalLight(0xf4f6ff, 0);
  seat.castShadow = false;
  seat.name = 'seat-fill';
  scene.add(seat);
  scene.add(seat.target);

  // --- the setting: environment (reflections + background) and the table (see ENVIRONMENTS) -----------
  const assets = deps.assets || null;
  let envTexture = null;       // the PMREM texture materials reflect
  let envBackground = null;    // the equirect shown (blurred) behind the board, HDRI modes only
  let userBackground = null;   // settings.background -- honoured in 'plain'
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
        const reflected = tableUnder(eq, spec.under);   // the pieces reflect the table below the horizon, not the floor
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

  // The table: a round lacquered walnut pedestal table the board stands on, shown with the HDRI rooms only.
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
  // A floor under the table for a room without one (ENVIRONMENTS[].floor: the Studio), fading out into the backdrop
  // at its rim; the table's own foot shadow (buildTable) sits on it.
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
  // The Plain board's drop shadow: it floats over the page colour with nothing under it (critique r4). A soft square
  // just under the frame, nudged away from the key (which stands off White's right).
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

  /** Lighting "off" for the table: the board's unlit switch, then a step darker (TABLE.unlit) under the board. */
  function setTableUnlit(on) {
    const m = tableParts && tableParts.material;
    if (!m || !!m.userData.litBackup === on) return;
    setMaterialUnlit(m, on);
    if (on) m.emissive.multiplyScalar(TABLE.unlit);
    if (tableParts.pad) setMaterialUnlit(tableParts.pad, on);
  }

  // --- vignette (3D only) --------------------------------------------------------------------------
  // A CSS overlay between the canvas and the labels / UI: cheap, never hit-tested, and it does not touch the
  // pixels anyone reads back from the canvas. setViewMode fades it with the 2D switch.
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
    if (floor) { floor.visible = room && spec.floor !== undefined; if (floor.visible) floorMat.color.set(spec.floor); }
    if (drop) drop.visible = !envBackground && mode !== '2d';
  }

  // --- resize ----------------------------------------------------------------------------------
  function resize() {
    if (disposed) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    invalidate('camera');   // a resized canvas is cleared, and the projection changes with it
    const ratio = screenPixelRatio();
    if (ratio !== pixelRatio) { pixelRatio = ratio; renderer.setPixelRatio(ratio * ratioScale); }
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
  // Moving the window to a screen with another pixel ratio resizes nothing in CSS pixels, so the ResizeObserver stays
  // quiet: a media query on the current ratio fires instead, once, and is set up again for the new ratio.
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

  // --- tweens ----------------------------------------------------------------------------------
  const tweens = new Set();
  // deps.now: a clock for tests; production reads performance.now()
  const nowMs = typeof deps.now === 'function' ? deps.now
    : () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  /**
   * Run an eased tween; onUpdate(t) gets eased t in 0..1; returns cancel(). `kind` is what each step changes, for
   * render on demand: 'content' (the default: a tween may move anything) or 'camera' (the camera tweens below).
   */
  function tween({ duration = TWEEN_MS, onUpdate, onDone, ease = easeInOutCubic, kind = 'content' } = {}) {
    const entry = { start: nowMs(), duration: Math.max(0, duration), onUpdate, onDone, ease, kind };
    invalidate(kind);
    if (entry.duration === 0) { onUpdate && onUpdate(1); onDone && onDone(); return () => {}; }
    tweens.add(entry);
    return () => tweens.delete(entry);
  }
  function stepTweens(now) {
    for (const t of tweens) {
      invalidate(t.kind);
      const raw = clamp((now - t.start) / t.duration, 0, 1);
      try { t.onUpdate && t.onUpdate(t.ease(raw)); } catch (err) { console.error(err); }
      if (raw >= 1) { tweens.delete(t); try { t.onDone && t.onDone(); } catch (err) { console.error(err); } }
    }
  }

  // --- camera tweens ---------------------------------------------------------------------------
  // Exactly one camera tween runs at a time. Starting another, or the user grabbing the camera,
  // cancels the running one; its promise then resolves `false` instead of `true`. Nothing rejects,
  // so callers never need a .catch().
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
        try { onSettle && onSettle(ok); } catch (err) { console.error('[scene] camera tween settle failed', err); }
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
        try { onDone && onDone(); } catch (err) { console.error('[scene] camera tween finish failed', err); }
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
  /**
   * The seat's azimuth. 3D: the camera's azimuth about the BOARD centre (not the pan target) -- which side of the
   * board it is on. 2D: its azimuth about its own target: there the camera leans only TOP_EPS off straight down
   * (~0.2 units at the 2D distance), so any pan or aim shift bigger than that would flip an azimuth measured about
   * the board centre to the other seat, while the lean itself always points at the seat.
   */
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
  function stillControls() {
    // OrbitControls keeps damping momentum in private deltas; clear them so a tween is not fought.
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
        if (toFov !== fromFov) { camera.fov = fromFov + (toFov - fromFov) * t; camera.updateProjectionMatrix(); }
      },
      onDone,
      onSettle,
    });
  }

  function fitScale(pos, target) {
    // push a preset back when the pane is narrow so the whole board stays on screen
    const d = Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
    const needed = fitDistance(BOARD_FIT_HALF, camera.fov, camera.aspect);
    return clamp(Math.max(1, needed / d), 1, MAX_DIST / d);
  }

  // --- view mode -------------------------------------------------------------------------------
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
  /**
   * The 3D pose to come back to, turned to the seat the board is at NOW: a Flip made in 2D turns the seat, and
   * the pose snapshotted on the way into 2D was taken from the other one (critique r2: 2D, Flip, 3D left the
   * orientation black with the camera back at White's seat). The pose is turned about the board's vertical
   * axis, so whatever framing the player had is kept, from the other side.
   */
  function seatPose(p) {
    if (!p || p.seat === orientation) return p;
    const turn = seatTheta(orientation) - seatTheta(p.seat);
    const q = { ...p, position: p.position.clone().applyAxisAngle(UP, turn), target: p.target.clone().applyAxisAngle(UP, turn), seat: orientation };
    if (q.preset === 'white' || q.preset === 'black') q.preset = orientation;
    return q;
  }
  /**
   * The lens and the up vector only — never the camera's place in the world.
   * Used when a 2D -> 3D transition is superseded mid-flight (the user clicks a View preset, or
   * self-play rotates the seat, before the transition settles). Whoever superseded us owns the
   * position and target from here; the 2D lens must NOT survive into 3D, or the board fills the
   * screen at FOV_2D forever.
   */
  function restoreLens(p) {
    camera.up.copy(p.up);
    camera.fov = p.fov; camera.near = p.near; camera.far = p.far; camera.zoom = p.zoom;
    camera.updateProjectionMatrix();
  }
  function restorePose(p) {
    camera.up.copy(p.up);
    camera.position.copy(p.position);
    controls.target.copy(p.target);
    camera.fov = p.fov; camera.near = p.near; camera.far = p.far; camera.zoom = p.zoom;
    camera.updateProjectionMatrix();
    camera.lookAt(controls.target);
    controls.minDistance = p.minDistance; controls.maxDistance = p.maxDistance;
    controls.minPolarAngle = p.minPolarAngle; controls.maxPolarAngle = p.maxPolarAngle;
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
  /**
   * The 2D framing for a seat azimuth: the distance that fits the board (BOARD_FIT_2D) inside the part of the
   * stage the floating UI leaves free (setSafeArea), and the point to aim at so the board sits centred in that
   * part rather than in the whole stage (critique r2: the frame ran under the toolbar). With no insets this is
   * exactly fitDistance() and the board centre.
   */
  function frame2d(theta) {
    const W = container.clientWidth || 1, H = container.clientHeight || 1;
    const fy = Math.max(0.3, (H - safe.top - safe.bottom) / H), fx = Math.max(0.3, (W - safe.left - safe.right) / W);
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOV_2D / 2));
    const dist = Math.max(BOARD_FIT_2D / (tanV * fy), BOARD_FIT_2D / (tanV * (W / H) * fx));
    const wpp = 2 * dist * tanV / H;                                   // world units per px on the board
    const down = (safe.top - safe.bottom) / 2 * wpp, right = (safe.left - safe.right) / 2 * wpp;
    // screen up is away from the seat, screen right is (cos, -sin) of the seat azimuth; aim up / left by the
    // shift so the board lands down / right of the view centre
    const target = new THREE.Vector3(-Math.sin(theta) * down - Math.cos(theta) * right, 0, -Math.cos(theta) * down + Math.sin(theta) * right);
    return { dist, target };
  }
  /**
   * Re-frame 2D after a resize or a safe-area change, keeping whatever zoom ratio the user had. The aim moves with
   * the fit unless the player has panned away from where the last fit put it; `recentre` moves it regardless.
   */
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
  /**
   * 2D sits ~47 units away; with near = 0.1 the depth buffer would not separate the 0.004-0.020
   * overlay stack from the board. Pull the planes in around the actual distance.
   */
  function updateClip(force) {
    if (mode !== '3d') {
      const d = camera.position.distanceTo(controls.target);
      const near = Math.max(0.5, d * 0.45);
      const far = d * 1.9 + 20;
      if (force || Math.abs(camera.near - near) > near * 0.02 || Math.abs(camera.far - far) > far * 0.02) {
        camera.near = near; camera.far = far; camera.updateProjectionMatrix();
      }
    } else if (camera.near !== 0.1 || camera.far !== 200) {
      camera.near = 0.1; camera.far = 200; camera.updateProjectionMatrix();
    }
  }

  function emitMode(previous) {
    for (const fn of modeHooks) { try { fn(mode, previous); } catch (err) { console.error('[scene] view-mode hook failed', err); } }
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
        if (ok) { restorePose(p); preset = p.preset; }  // bit-for-bit, not "wherever the easing landed"
        else { restoreLens(p); applyModeLimits(); }     // superseded: keep their camera, take back the lens
      },
    });
  }

  // --- seat rotation ---------------------------------------------------------------------------
  /**
   * Turn the board: rotate the camera AND the pan target about the vertical axis through the board
   * centre. Works identically in 2D and 3D because it never touches the polar angle, and it reads as
   * the board turning rather than the camera jumping. Returns Promise<boolean> (false when cancelled).
   */
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
      onDone() { place(delta); stillControls(); controls.update(0); },
    });
  }

  // --- lighting --------------------------------------------------------------------------------
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
    invalidate('content');   // lights, the key's place and shadow, tone mapping, the environment
    const v = applied;
    const envSpec = ENVIRONMENTS[envName] || ENVIRONMENTS.plain;
    // The HDRI rooms use Khronos PBR Neutral, which keeps base colours true (boxwood stays boxwood, porcelain
    // stays white); 'plain' keeps the original ACES grade.
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
    renderer.shadowMap.enabled = v.shadows;
    key.castShadow = v.shadows;
    if (prevShadows !== v.shadows) markMaterialsDirty();
    if (matSet && typeof matSet.setUnlit === 'function') {
      try { matSet.setUnlit(v.unlit); } catch (err) { console.warn('[scene] matSet.setUnlit failed', err); }
    }
    setTableUnlit(v.unlit);
    applySeatLights();
    const payload = view.lighting;
    for (const fn of lightHooks) { try { fn(payload); } catch (err) { console.error('[scene] lighting hook failed', err); } }
  }

  /**
   * The seat fill's and the edge light's strength: the lighting's values times the room's, in 3D only (2D keeps
   * its flat, head-on look; the tokens have no crowns to rim). The edge takes the room's tint. Called by
   * applyLighting, on every mode switch and when the room changes.
   */
  function applySeatLights() {
    invalidate('content');
    const v = applied;
    const envSpec = ENVIRONMENTS[envName] || ENVIRONMENTS.plain;
    const on = mode === '3d' ? 1 : 0;
    seat.intensity = v.seat * (envSpec.seat ?? 1) * on;
    edgeColor.setRGB(...(envSpec.tint || [1, 1, 1])).multiplyScalar(v.back * (envSpec.back ?? 1) * on);
  }

  /**
   * Re-aim the camera-relative lights for the current camera (every frame, and before a synchronous render).
   * The seat fill comes from behind the camera -- the look direction reversed, SEAT_ELEVATION up -- so it lights
   * whatever the camera is looking at from the camera's side, a close-up inside the board included (critique r3:
   * aimed from the camera's azimuth about the board centre, a close look at e8 from White's side was lit from
   * Black's). The edge light needs the board centre's view depth (it fades in over the far half of the board).
   */
  const _aim = new THREE.Vector3();
  function aimSeatLights() {
    const c = camera.position, t = controls.target;
    let dx = c.x - t.x, dz = c.z - t.z, dl = Math.hypot(dx, dz);
    if (dl < 1e-6) { dx = Math.sin(boardTheta()); dz = Math.cos(boardTheta()); dl = 1; }   // straight down: the seat
    const se = SEAT_ELEVATION;
    seat.position.set(dx / dl * 10 * Math.cos(se), 10 * Math.sin(se), dz / dl * 10 * Math.cos(se));
    seat.target.position.set(0, 0, 0);
    camera.updateMatrixWorld();
    edgeFocus = -_aim.set(0, 0, 0).applyMatrix4(camera.matrixWorldInverse).z;
  }

  /**
   * 3D: the camera never goes under the table top. The orbit target is held on or above it -- with MAX_POLAR and
   * MIN_DIST that alone keeps the camera >= 0.3 over it -- and a camera put lower anyway (by a pan or a caller
   * placing it) is lifted back to TABLE_CLEARANCE. Transitions own the camera and are left alone.
   */
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

  // --- render loop -----------------------------------------------------------------------------
  const hooks = new Set();
  let raf = 0;
  let lastFrameMs = 0;  // 0 = "first frame after a boot or a tab hide"; dt is 0 for that one
  let elapsed = 0;      // our own accumulator so onFrame hooks see continuous time across tab hides
  let hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  function renderOnce() {
    const info = tris ? renderer.info.render : null;
    if (tris) { renderer.info.reset(); tris.shadow = 0; tris.edge = 0; tris.glow = 0; }
    renderer.render(scene, camera);
    let mark = info ? info.triangles : 0;
    if (tris) tris.main = mark - tris.shadow;
    if (view.effects) {
      // lit 3D only (edgeColor is black otherwise; see applySeatLights)
      if (silhouette) silhouette.render(scene, camera, { color: edgeColor, focus: edgeFocus, scale: ratioScale });
      if (tris) { tris.edge = info.triangles - mark; mark = info.triangles; }
      // lit 3D only: unlit parks colour in `emissive`, and 2D's flat tokens have no windows (see glow.js)
      if (glow && mode === '3d' && !applied.unlit) glow.render(scene, camera, ratioScale);
      if (tris) tris.glow = info.triangles - mark;
    }
    // A full frame is one that drew every pass: with shadows off there is no map to wait for.
    if (tris && (tris.shadow > 0 || !renderer.shadowMap.enabled)) Object.assign(trisFull, tris);
    if (labelRenderer) labelRenderer.render(scene, camera);
  }
  // What the last drawn frame was drawn from, to tell whether anything moved since (see RENDER ON DEMAND).
  const SAFETY_NET_MS = 500;
  let lastRenderMs = 0;
  const camSeen = new Float64Array(33);
  const camNow = new Float64Array(33);
  let sceneSeen = [];
  let sceneNow = [];

  /** The camera as drawn: world matrix, projection, and the canvas size (a resize clears the canvas). */
  function readCamera(out) {
    const w = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
    for (let i = 0; i < 16; i++) { out[i] = w[i]; out[16 + i] = p[i]; }
    out[32] = canvas.width * 65536 + canvas.height;
    return out;
  }
  /**
   * Every object's place, visibility and material state, flattened. A change here between two frames means the
   * lit scene changed even if no caller said so: the backstop under the explicit invalidations. Lights are left
   * out: the seat fill is re-aimed with the camera every frame, and the lights are changed only by the setters.
   */
  function readScene(out) {
    out.length = 0;
    scene.traverse((o) => {
      if (o.isLight) return;
      const p = o.position, q = o.quaternion, s = o.scale;
      out.push(o.id, o.visible ? 1 : 0, o.children.length, p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z);
      if (!o.matrixAutoUpdate) { const e = o.matrix.elements; for (let i = 0; i < 16; i++) out.push(e[i]); }
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
  // OrbitControls' damping decays geometrically and never quite reaches zero: for minutes after a drag the camera
  // creeps by ever smaller amounts. Once the camera has moved less than this since the last drawn frame (1e-6 per
  // matrix element, far below a pixel) it is treated as stopped: the controls' leftover damping is cleared so it
  // really does stop, and one last frame is drawn for exactly where it came to rest.
  const CAMERA_EPS = 1e-6;
  let cameraMoving = false;     // the last drawn frames followed a moving camera; its stop is still to be drawn
  // The first frame after a change that rebuilds materials can differ from the settled picture in a few pixels
  // (shaders compiled for that frame); the frame after it is the settled one. So a 'content' frame always owes one
  // more frame on the next animation frame, as the always-drawing loop gave it.
  let afterContent = false;

  /**
   * Draw one frame. 'content' also redraws the key's shadow map (and so does any frame before the map exists);
   * 'camera' reuses it. A shadow redraw is counted when one was due with shadows on: three draws it then.
   */
  /**
   * Set the renderer's pixel ratio to the screen's times `scale`. Called right before a draw in the same task: the
   * drawing buffer is resized (and so cleared) and drawn straight away.
   */
  function setRatioScale(scale) {
    if (scale === ratioScale) return;
    ratioScale = scale;
    renderer.setPixelRatio(pixelRatio * scale);
    // three rounds the viewport but floors the canvas: at a fractional size the viewport would be one buffer pixel
    // too large. Binding the canvas again derives it with floor, the canvas's own size. (At scale 1 the viewport is
    // left as resize() sets it, as without motion quality.)
    if (scale !== 1 && typeof renderer.setRenderTarget === 'function') renderer.setRenderTarget(null);
  }
  const shadowsInUse = () => !!(renderer.shadowMap.enabled && key.castShadow);
  /** The renderer holds something below full quality that the picture at rest must not keep. */
  const needsSettle = () => ratioScale !== 1 || (shadowReduced && shadowsInUse());

  /**
   * Draw one frame at motion level `level` (0 = full quality; MOTION_LEVELS). `restore` (a frame at rest) also
   * redraws the shadow map if the one in use was drawn with the cheaper blur.
   */
  function renderFrame(kind, level = 0, restore = false) {
    pending = null;
    const L = MOTION_LEVELS[level] || MOTION_LEVELS[0];
    setRatioScale(L.ratio);
    if (kind === 'content' || (!key.shadow.map && renderer.isWebGLRenderer) || (restore && shadowReduced)) key.shadow.needsUpdate = true;
    const shadowDue = shadowsInUse() && key.shadow.needsUpdate;
    const blur = key.shadow.blurSamples;   // the configured count, put back after the draw
    if (shadowDue && L.blurSamples && L.blurSamples < blur) key.shadow.blurSamples = L.blurSamples;
    const drawnBlur = key.shadow.blurSamples;
    try { renderOnce(); } catch (err) { invalidate(kind); throw err; }   // a failed frame stays owed
    finally { key.shadow.blurSamples = blur; }
    if (shadowDue) shadowReduced = drawnBlur < blur;
    else if (!shadowsInUse()) shadowReduced = false;   // no map in use; the next one is drawn fresh
    reduced = ratioScale !== 1 || (shadowReduced && shadowsInUse());
    afterContent = kind === 'content';
    stats.renders++;
    if (shadowDue) stats.shadowUpdates++;
    lastRenderMs = nowMs();
    readCamera(camSeen);
    sceneSeen = readScene(sceneSeen);
  }

  // Motion bookkeeping for the loop (see MOTION QUALITY in the header).
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
    controls.update(dt);
    keepAboveTable();
    aimSeatLights();
    if (!transitioning) updateClip(false);
    // A hook returns false when it changed nothing this frame, 'camera' when it moved only the viewpoint;
    // anything else (an older hook returns nothing) draws a full frame, as every frame used to be.
    for (const fn of hooks) {
      let r;
      try { r = fn(dt, elapsed); } catch (err) { console.error('[scene] frame hook failed', err); }
      if (r !== false) invalidate(r === 'camera' ? 'camera' : 'content');
    }
    if (pending !== 'content') {
      sceneNow = readScene(sceneNow);
      if (!sameArray(sceneNow, sceneSeen)) invalidate('content');
    }
    const owedBefore = pending;
    const followUp = afterContent;
    if (afterContent) { afterContent = false; invalidate('camera'); }
    readCamera(camNow);
    let cameraOwes = false;
    if (!sameArray(camNow, camSeen, CAMERA_EPS)) { cameraMoving = true; cameraOwes = true; invalidate('camera'); }
    else if (cameraMoving) {
      cameraMoving = false;
      stillControls();
      if (!sameArray(camNow, camSeen)) { cameraOwes = true; invalidate('camera'); }
    }
    // Nothing owed for settleMs after frames below full quality: one full frame, then idle.
    let settle = false;
    if (!pending && needsSettle() && t - lastRenderMs >= MOTION.settleMs) { pending = 'camera'; settle = true; }
    let quiet = settle;           // a settle or safety-net frame: the picture at rest, it starts no motion
    if (!pending && t - lastRenderMs >= SAFETY_NET_MS) { pending = 'camera'; quiet = true; }
    if (!pending) return;
    // A motion frame directly follows a drawn frame, or continues a motion after a gap shorter than settleMs; the
    // follow-up that only a content frame owed inherits the frame before it. The policy hears the interval between
    // two consecutive motion frames on consecutive animation frames.
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

  // --- pointer helpers -------------------------------------------------------------------------
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

  // --- public API ------------------------------------------------------------------------------
  const view = {
    scene, camera, renderer, labelRenderer, controls, container,
    lights: { hemi, key, fill, seat },
    /** The far army's edge light as it stands: the colour it adds (black = off) and the board centre's view depth. */
    get edgeLight() { return { color: edgeColor.clone(), focus: edgeFocus }; },
    /** false draws the bare frame, without the edge light and the glow (the capture tools' mask passes). */
    get effects() { return effects; },
    set effects(on) { effects = on; invalidate('camera'); },   // the post passes' input: draw again
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
        // 2D cannot tilt: a seat preset turns the board, anything else re-frames it.
        if (name === 'white' || name === 'black') return rotateSeat(name);
        refit2d(true);
        preset = 'top';
        return Promise.resolve(true);
      }
      if (name === 'free' || !PRESETS[name]) { preset = 'free'; return Promise.resolve(true); }
      const p = PRESETS[name];
      const s = fitScale(p.pos, p.target);
      const pos = new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]).sub(new THREE.Vector3(...p.target)).multiplyScalar(s);
      _sph.setFromVector3(pos);
      preset = name;
      if (name === 'white' || name === 'black') orientation = name;
      // Always re-establish the 3D lens: a preset may be the thing that superseded a 2D -> 3D transition.
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
      else if (target.isObject3D) { target.getWorldPosition(point); point.y += 0.4; }
      else if (typeof target.x === 'number') point.set(target.x, target.y || 0, target.z || 0);
      else return Promise.resolve(true);
      if (mode === '2d') {
        // no dolly-to-3 in 2D: that would break the locked frame. Pan over the square, zoom in a little.
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

    /**
     * Register a per-frame hook fn(dt, elapsed); returns unsubscribe. It runs on every animation frame. Its return
     * value says what it changed: false = nothing (no frame is drawn for it), 'camera' = only the viewpoint,
     * anything else = the scene (a full frame is drawn, as for every hook before render on demand).
     */
    onFrame(fn) {
      if (typeof fn !== 'function') return () => {};
      hooks.add(fn);
      return () => hooks.delete(fn);
    },

    /** Live lighting: { preset, on, exposure, key, ambient, shadows }. Returns the resolved lighting. */
    setLighting(patch) {
      const prevShadows = applied.shadows;
      lighting = resolveLighting(patch || {}, lighting);
      applied = lightingValues(lighting);
      applyLighting(prevShadows);
      return view.lighting;
    },

    /**
     * Hand the view the current material set so "lighting off" can switch it to unlit shading.
     * main.js calls this right after createMaterialSet and again whenever the theme changes.
     */
    setMaterialSet(next) {
      invalidate('content');
      matSet = next || null;
      if (matSet && typeof matSet.setUnlit === 'function') {
        try { matSet.setUnlit(applied.unlit); } catch (err) { console.warn('[scene] matSet.setUnlit failed', err); }
      }
      return matSet;
    },

    /** Subscribe to lighting changes: fn(view.lighting). Returns unsubscribe. */
    onLighting(fn) {
      if (typeof fn !== 'function') return () => {};
      lightHooks.add(fn);
      return () => lightHooks.delete(fn);
    },

    /** Toggle shadows live (antialias is fixed at creation — see header). Routes through setLighting. */
    setQuality({ shadows, antialias } = {}) {
      if (typeof shadows === 'boolean') view.setLighting({ shadows });
      if (typeof antialias === 'boolean') view.antialias = antialias; // recorded only; not switchable live
    },

    /**
     * The margins (px) of the stage that floating UI covers -- the toolbar, the status chip. 2D frames the board in
     * what is left (see frame2d); 3D ignores them. main.js measures and calls this on every resize.
     */
    setSafeArea(area = {}) {
      const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
      const next = { top: n(area.top), right: n(area.right), bottom: n(area.bottom), left: n(area.left) };
      if (next.top === safe.top && next.right === safe.right && next.bottom === safe.bottom && next.left === safe.left) return;
      safe = next;
      if (mode === '2d' && !transitioning) refit2d();
    },
    get safeArea() { return { ...safe }; },

    /** Scene background colour (hex string or number); null makes the canvas transparent so the page background shows. */
    setBackground(color) {
      if (color == null || color === '' || color === 'auto') userBackground = null;
      else { try { userBackground = new THREE.Color(color); } catch (_) { userBackground = null; } }
      applyEnvironment();     // the HDRI rooms keep their own background; 'plain' and 2D show this one
    },

    /** Where the board sits: 'room' | 'studio' (HDRI + table) | 'plain' (the original look). */
    setEnvironment(name) {
      const want = ENVIRONMENTS[name] ? name : 'room';
      envName = want === 'plain' || hdriAvailable(want) ? want : 'plain';
      applyEnvironment();
      applyLighting(applied.shadows);
      return envName;
    },
    get environment() { return envName; },
    table,

    /** Slow showcase rotation on/off (ignored while in 2D — it would spin the board under the player). */
    setAutoRotate(on) { autoRotateWanted = !!on; controls.autoRotate = autoRotateWanted && mode === '3d'; },

    /** Jump instead of tween when false (settings.animations is also honoured live). */
    setAnimations(on) { animations = !!on; },

    resize,

    /** Render one frame synchronously (a full one: the shadow map is redrawn too). */
    render() { controls.update(0); keepAboveTable(); aimSeatLights(); renderFrame('content'); },

    /**
     * Ask for a frame: 'camera' when only the viewpoint or a post effect's input changed, 'content' when anything
     * in the lit scene did (that frame also redraws the shadow map). See RENDER ON DEMAND in the header.
     */
    invalidate(kind = 'content') { invalidate(kind === 'camera' ? 'camera' : 'content'); },

    /**
     * Counters for measuring render on demand: animation frames seen, frames drawn, shadow-map redraws; with a
     * WebGLRenderer also the triangles per pass of the last full frame (`triangles`) and of the last frame
     * (`lastTriangles`), see the header.
     */
    get stats() {
      const out = { ...stats };
      if (tris) { out.triangles = { ...trisFull }; out.lastTriangles = { ...tris }; }
      if (gpuName) out.gpu = gpuName;
      // the motion quality (see MOTION QUALITY in the header); listed with a real renderer, as `triangles` is
      const motion = {
        level: policies[mode].level, reduced, interval_ms: Math.round(policies[mode].interval * 10) / 10, settles,
      };
      for (const [k, value] of Object.entries(motion)) {
        Object.defineProperty(out, k, { value, enumerable: !!tris, writable: true, configurable: true });
      }
      return out;
    },

    /** 'auto' draws motion more cheaply on a machine that is not keeping up; 'full' never does. */
    setMotionQuality(q) {
      quality = normalizeQuality(q);
      for (const p of Object.values(policies)) p.setMode(quality);
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
      for (const e of envCache.values()) { if (e.env) e.env.dispose(); if (e.bg) e.bg.dispose(); }
      envCache.clear();
      table.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      for (const m of [floor, drop]) if (m) { m.geometry.dispose(); m.material.dispose(); }
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

  // --- boot state ------------------------------------------------------------------------------
  envName = hdriAvailable(settings.environment) ? settings.environment
    : (settings.environment === 'plain' || !hdriAvailable('room') ? 'plain' : 'room');
  applyEnvironment();
  applyLighting(applied.shadows);
  if (settings.viewMode === '2d') setViewMode('2d', { animate: false });

  return view;
}
