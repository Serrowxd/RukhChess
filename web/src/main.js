// Entry point: wires core <-> three <-> ui <-> engine <-> ai. See CONTRACT.md (v0 + Addendum v1).
import './ui/styles.css';
import { store, actions } from './core/store.js';
import { decodeHash } from './core/io.js';
import { createView } from './three/scene.js';
import { createMaterialSet, setWoodTextures } from './three/materials.js';
import { ASSETS } from './assets/index.js';
import { createBoard } from './three/board.js';
import { createPieceLayer } from './three/pieceLayer.js';
import { ensureModeledSet, isModeledSet, setSetsUnlit } from './three/pieces.js';
import { createInteraction } from './three/interact.js';
import { mountUi } from './ui/index.js';
import { createEngine } from './engine/stockfish.js';
import { createAi } from './ai/chat.js';
import { createMcpBridge } from './ai/mcpBridge.js';
import { installApi } from './ai/api.js';
import { connectRemoteSync } from './net/remoteSync.js';
import { mountRemotePlay } from './ui/playPanel.js';

const stage = document.getElementById('stage');
const settings = () => store.state.settings;

/**
 * A share link is a ONE-SHOT import: drop the hash once it has loaded, so a reload (or a phone
 * discarding and restoring the tab) keeps the user's continuation instead of reverting to the
 * shared position and then letting autosave overwrite the continuation with it.
 * replaceState does not fire hashchange, so this cannot loop.
 */
function consumeHash() {
  try {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  } catch (e) { /* file:// or a sandboxed frame: nothing to clean up */ }
}

// 1. Toasts can fire before the UI exists (bad share link, moves dropped on import). Buffer, replay after mount.
const bootToasts = [];
const stopBufferingToasts = store.on('toast', t => { bootToasts.push(t); });

// 2. Position source: share link (once) beats autosave beats a fresh game.
let loaded = false;
try {
  const hash = decodeHash(location.hash);
  if (hash && hash.pgn) loaded = actions.loadPgn(hash.pgn) !== false;
  else if (hash && hash.fen) loaded = actions.loadFen(hash.fen) !== false;
  if (loaded) consumeHash();
} catch (e) {
  console.warn('hash load failed', e);
}
if (!loaded && !actions.restore()) actions.newGame();

// 3. Three.js. Materials first: the view owns the unlit switch and needs the set to drive it.
const bootMode = store.state.viewMode || '3d';
setWoodTextures(ASSETS.wood);     // the baked board woods (Blender); tests run without them
let matSet = createMaterialSet(settings().theme, settings().palette, {
  contrast: settings().lighting ? settings().lighting.contrast !== false : true,
});
const view = createView(stage, settings(), { assets: ASSETS });
view.setMaterialSet(matSet);
const board = createBoard(view.scene, matSet, settings());
// A modelled set (Classic is the default) loads asynchronously, so the layer starts on a set it can build now
// and swaps once the GLB is in (step 8). Started on the modelled id it would build Staunton under Classic's
// name, and the later setSet('classic') would find nothing to change.
const bootSet = settings().pieceSet;
const bootModeled = isModeledSet(bootSet);
const layer = createPieceLayer(view.scene, matSet, bootModeled ? { ...settings(), pieceSet: 'staunton' } : settings());
if (layer.setSquareMapper) layer.setSquareMapper(board.worldFor);
// Lighting "off" must also flatten the modelled sets, whose materials come from their own GLB, and the gilt
// coordinates, which the board owns.
const applyUnlit = on => { setSetsUnlit(on); board.setUnlit(on); };
applyUnlit(!!(view.lighting && view.lighting.unlit));
view.onLighting(l => applyUnlit(!!(l && l.unlit)));

/**
 * Show a piece set. The modelled sets (three/modeledSets.js) load on first use; until they arrive the layer keeps
 * whatever it is showing, and a failed load falls back to Staunton with a toast rather than a blank board.
 * Resolves once the set is showing (or the fallback has been chosen).
 */
function applyPieceSet(id) {
  if (!isModeledSet(id)) { layer.setSet(id); return Promise.resolve(); }
  return ensureModeledSet(id)
    .then(() => { if (settings().pieceSet === id) layer.setSet(id); })
    .catch(err => {
      console.warn('[pieces] could not load set', id, err);
      actions.toast(`Could not load the ${id} piece set`, 'error');
      if (settings().pieceSet === id) actions.setSetting('pieceSet', 'staunton');
    });
}
const interaction = createInteraction({ view, board, layer, store, actions });

// 4. Engine, AI, MCP, UI, public API
const engine = createEngine(store, actions);
actions.registerEngine(engine);              // lets self-play actually delegate to Stockfish
const ai = createAi(store, actions);
const mcp = createMcpBridge(store, actions); // inert until enable(); no listeners, timers or fetch
const ui = mountUi({ store, actions, engine, ai, mcp, view, layer, board });
installApi({ store, actions, engine, ai, mcp, view, board, layer });
// Starting self-play against "AI over MCP" is the switch: the bridge follows the seat, so no console call is
// needed. It is never switched off from here, so a manual mcp.enable() stays on.
store.on('selfplay:change', ({ selfPlay: sp }) => {
  if (sp && sp.on && sp.opponent === 'ai' && !mcp.status().enabled) mcp.enable();
});

// 2D frames the board in the part of the stage the floating toolbar and status chip leave free (scene.js
// frame2d): measured here, where both are known, and again whenever either or the stage changes size.
function syncSafeArea() {
  const st = stage.getBoundingClientRect();
  const PAD = 8;
  const rect = sel => { const el = stage.querySelector(sel); const r = el && el.getBoundingClientRect(); return r && r.height ? r : null; };
  const bar = rect('.topbar'), chip = rect('.chip');
  view.setSafeArea({
    top: bar ? Math.max(0, bar.bottom - st.top + PAD) : 0,
    bottom: chip ? Math.max(0, st.bottom - chip.top + PAD) : 0,
  });
}
syncSafeArea();
if (typeof ResizeObserver === 'function') {
  const safeRo = new ResizeObserver(() => syncSafeArea());
  safeRo.observe(stage);
  for (const el of stage.querySelectorAll('.topbar, .chip')) safeRo.observe(el);
}

// The UI owns the toast listener from here on; replay anything that happened during boot.
stopBufferingToasts();
for (const t of bootToasts.splice(0)) actions.toast(t.text, t.kind);

// 5. Sync helpers
function currentPieces() {
  const s = store.state;
  return s.mode === 'setup' && s.setup ? s.setup.pieces : s.game.pieces();
}

function kingInCheckSquare() {
  const s = store.state;
  const status = s.game.status();
  if (!status.check) return null;
  const turn = s.game.turn();
  const k = s.game.pieces().find(p => p.piece.role === 'king' && p.piece.color === turn);
  return k ? k.square : null;
}

let lastEngineArrow;
function syncEngineArrow() {
  const s = store.state;
  const st = s.settings;
  const uci = s.mode === 'play' && st.showEngineArrow && s.engine.enabled && s.engine.bestMove ? s.engine.bestMove : null;
  if (uci === lastEngineArrow) return;
  lastEngineArrow = uci;
  board.setEngineArrow(uci);
}

function syncAnnotations() {
  const s = store.state;
  const node = s.game.current;
  const st = s.settings;
  if (s.mode === 'setup') {
    board.setLastMove(null, null);
    board.setCheck(null);
    board.setArrows([]);
    board.setHighlights([]);
    board.setNoteLabel(null, '');
    lastEngineArrow = undefined;
    board.setEngineArrow(null);
    return;
  }
  const mv = node.move;
  board.setLastMove(st.showLastMove && mv ? mv.from : null, st.showLastMove && mv ? mv.to : null);
  board.setCheck(st.showCheck ? kingInCheckSquare() : null);
  board.setArrows(node.arrows || []);
  board.setHighlights(node.highlights || []);
  const note = st.showNotes3D ? (node.note || '') : '';
  board.setNoteLabel(note ? (mv ? mv.to : null) : null, note);
  syncEngineArrow();
}

function syncPosition(reason, move) {
  const s = store.state;
  const animate = reason === 'move' && s.settings.animations && move;
  layer.sync(currentPieces(), { animateFrom: animate ? move : null, instant: !animate });
  syncAnnotations();
}

// 6. Store subscriptions
let pendingPromotion = null;
store.on('promotion:required', p => { pendingPromotion = p; });
store.on('game:change', ({ reason, move }) => {
  pendingPromotion = null;
  if (reason === 'note') { syncAnnotations(); return; }   // typing in the note box: pieces unchanged
  syncPosition(reason, move);
});
store.on('selection:change', ({ selected }) => {
  // A promotion picker that was cancelled leaves the pawn sitting on the target square; put it back.
  if (!selected && pendingPromotion) {
    pendingPromotion = null;
    if (layer.settle) layer.settle(); else syncPosition('goto', null);
  }
});
store.on('annotations:change', () => syncAnnotations());
store.on('engine:update', () => syncEngineArrow());
store.on('mode:change', () => { pendingPromotion = null; syncPosition('setup', null); });

store.on('orientation:change', ({ orientation }) => {
  const st = settings();
  const sp = store.state.selfPlay;
  const sps = st.selfPlay || {};
  // In self-play the seat turns as a continuous rotation; the manual Flip button keeps its own feel.
  const selfRotate = !!(sp && sp.on && sps.rotate !== false);
  const animate = st.animations !== false;
  const duration = selfRotate ? 700 : 600;
  board.setOrientation(orientation);
  if (layer.setOrientation) layer.setOrientation(orientation, { animate, duration });
  if (selfRotate && view.rotateSeat) view.rotateSeat(orientation, { duration, animate });
  else view.flipTo(orientation);
});

store.on('viewmode:change', ({ mode }) => {
  view.setViewMode(mode);
  board.setViewMode(mode);
  layer.setViewMode(mode);
  lastEngineArrow = undefined;   // the board rebuilds its overlays for the new mode
  syncAnnotations();
});

store.on('settings:change', ({ path, value, settings: st }) => {
  if (path === 'theme') {
    const next = createMaterialSet(st.theme, st.palette, {
      unlit: !!(view.lighting && view.lighting.unlit),
      contrast: st.lighting ? st.lighting.contrast !== false : true,
    });
    view.setMaterialSet(next);
    board.setMaterials(next);
    layer.setMaterials(next);
    matSet.dispose();
    matSet = next;
  } else if (path === 'palette' || path.startsWith('palette.')) {
    matSet.setPalette(st.palette);
  }
  if (path === 'pieceSet') applyPieceSet(value);
  if (path === 'pieceSet2d' && layer.setSet2d) layer.setSet2d(value);
  if (path === 'showCoordinates') board.setCoordinates(value);
  if (path === 'arrowColors' || path.startsWith('arrowColors.')) { board.setArrowColors(st.arrowColors); syncAnnotations(); }
  if (path === 'autoRotate') view.setAutoRotate(value);
  if (path === 'quality' && view.setMotionQuality) view.setMotionQuality(value);
  if (path === 'environment' && view.setEnvironment) view.setEnvironment(value);
  if (path === 'animations') { if (layer.setAnimations) layer.setAnimations(value); if (view.setAnimations) view.setAnimations(value); }
  if (path === 'background' || path === 'uiTheme') view.setBackground(st.background === 'auto' ? null : st.background);

  // Lighting. `shadows` and `lighting.shadows` are the same knob; both route through setLighting.
  if (path === 'lighting') view.setLighting(st.lighting || {});
  else if (path.startsWith('lighting.')) {
    const key = path.slice('lighting.'.length);
    if (key === 'contrast') matSet.setContrast(value);
    else view.setLighting({ [key]: value });
  }
  if (path === 'shadows') view.setLighting({ shadows: value });

  if (path.startsWith('show') || path === 'engine.enabled') { lastEngineArrow = undefined; syncAnnotations(); }
  // Any setting may change what is drawn (a palette, a contrast aid, a piece set): draw a full frame. Settings change
  // rarely, so one extra shadow-map redraw for a setting that changed nothing visible costs nothing.
  view.invalidate('content');
});

// 7. Never lose a move made just before the tab closes.
window.addEventListener('pagehide', () => { try { actions.autosave(); } catch (e) { /* ignore */ } });

// A share link pasted into an already-open tab only changes the hash; load it without a reload,
// then consume it so the next reload keeps whatever she plays from here.
window.addEventListener('hashchange', () => {
  try {
    const h = decodeHash(location.hash);
    let ok = false;
    if (h && h.pgn) ok = actions.loadPgn(h.pgn) !== false;
    else if (h && h.fen) ok = actions.loadFen(h.fen) !== false;
    if (ok) consumeHash();
  } catch (e) {
    console.warn('hash load failed', e);
  }
});

// 8. First paint
board.setCoordinates(settings().showCoordinates);
board.setOrientation(store.state.orientation);
if (view.viewMode !== bootMode) view.setViewMode(bootMode, { animate: false });
board.setViewMode(bootMode);
if (layer.setViewMode) layer.setViewMode(bootMode, { animate: false });
if (bootMode !== '2d') view.setPreset(store.state.orientation);
view.setBackground(settings().background === 'auto' ? null : settings().background);
if (settings().autoRotate) view.setAutoRotate(true);
syncPosition('load', null);
if (bootModeled) {
  // In 3D the pieces wait for the modelled set rather than flashing Staunton first; a slow host still gets
  // Staunton after BOOT_SET_WAIT_MS, and a failed load shows the fallback at once.
  // When they come, they fade in rather than pop onto the empty board (critique r4).
  const BOOT_SET_WAIT_MS = 1500;
  let hidden = false;
  const reveal = () => {
    if (!hidden) return;
    hidden = false;
    layer.group.visible = true;
    view.invalidate('content');
    if (layer.fadeIn) layer.fadeIn();
  };
  if (bootMode !== '2d') {
    layer.group.visible = false;
    hidden = true;
    setTimeout(reveal, BOOT_SET_WAIT_MS);
  }
  applyPieceSet(bootSet).then(reveal, reveal);
}

// 9. Served by the Rukh program: follow its game. On its own (file:// or a static host) this does nothing.
// Connected, the topbar gains the AI chip and the Engine tab's Self-play block becomes the Play block.
connectRemoteSync({ store, actions, mcp }).then(remote => {
  if (!remote) return;
  try {
    mountRemotePlay({ remote, ui });
  } catch (e) {
    console.warn('[rukh] could not show the play control:', e && e.message);
  }
});

// Debug handle (not part of the public API)
window.__chessboard = { store, actions, view, board, layer, engine, ai, mcp, ui, interaction, matSet: () => matSet };
