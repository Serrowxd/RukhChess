// core/store.js — application state + events + actions (CONTRACT.md "core/store.js").
// Owns: createStore(), the singleton `store`, `actions` bound to it, settings persistence
// (localStorage['chessboard.settings']) and study autosave (localStorage['chessboard.study']).
//
// API added beyond CONTRACT.md:
//   createStore({ storage?, autosaveDelay?, game? })  — tests inject a Map-backed storage; storage
//                                                      defaults to localStorage when it exists (guarded).
//   store.actions, store.dispose()                    — actions bound to that store; dispose clears timers.
//   SETTINGS_DEFAULTS, defaultSettings(), STORAGE_KEYS exported.
//   Event 'study:change' { study }                    — emitted when title / notes / study meta change.
//   load* actions (loadFen/loadPgn/loadStudy/loadYaml) return true/false and toast on failure instead
//     of throwing (main.js calls them unguarded at boot).
//   attemptMove(from, to) positional form also accepted; playMove accepts a UCI string.
//   engineLines(lines, score, depth, bestMove, fen?)  — optional 5th arg: lines for a fen that is not
//     the current one are ignored (stale info after a fast goto). The top line is written to the current
//     node's `eval` (never at a lower depth than what is stored), so exports carry engine evals.
//   Whenever the current NODE changes the engine block is primed from its stored eval (or cleared), and
//     'engine:update' is emitted — navigating an analysed line shows evals instantly. A stored pv is
//     only trusted when it replays in the position; setMode('play') re-primes (cancelled setup).
//   Event order inside one game change: 'game:change' → 'engine:update' → 'position:change' →
//     'selection:change' (the selection is cleared last so a completed promotion is not mistaken for
//     a cancelled one by listeners that watch for a deselect while a promotion is pending).
//   setupPlace / setupClear / setupStart / setupTurn / setupCastling emit 'game:change' with
//     reason 'setup' (the board re-syncs from state.setup.pieces).
//   Setup scratch also carries `epSquare`, `halfmoves`, `fullmoves` read from the current FEN (not
//     surfaced in the UI, passed straight back to Game.fromPieces so a no-op commit is a no-op).
//
// Addendum v1 (2026-09-18) additions:
//   createStore({ now?, tickInterval? })   — `now` supplies the clock's timestamps (default Date.now)
//     and `tickInterval` the ticker period (default 200 ms). Tests inject both and pump store.tickClock().
//   store.tickClock()                      — advance the clock to now(); what the ticker calls.
//   actions.registerEngine(engine|null)    — the integrator hands the store the engine instance so
//     self-play can delegate to `engine.setPlayAs(color)`. Without it the store falls back to
//     actions.engineSetPlayAs (state only), which the engine module does not act on.
//   state.selfPlay carries `playerSide` beyond the contract shape: the colour the person at the board is playing, so
//     the store knows which side the engine / AI opponent owns. Defaults to the orientation at start.
//   Self-play never locks a piece: both sides stay hand-movable in every opponent mode.

import { Game } from './game.js';
import { studyFromJSON, studyFromYaml, studyToJSON, today } from './io.js';
import {
  applyMove as clockApplyMove,
  clockEquals,
  createClock,
  flag as clockFlagPure,
  isRunning as clockIsRunning,
  isUntimed as clockIsUntimed,
  normalizeTimeControl,
  otherColor,
  pause as clockPausePure,
  reset as clockResetPure,
  resume as clockResumePure,
  start as clockStartPure,
  tick as clockTickPure,
} from './clock.js';

/** localStorage keys. */
export const STORAGE_KEYS = { settings: 'chessboard.settings', study: 'chessboard.study' };

/** Settings defaults (CONTRACT.md). Never mutate; use defaultSettings() for a copy. */
export const SETTINGS_DEFAULTS = {
  theme: 'wood',
  palette: null,
  // The modelled Classic set (three/modeledSets.js) for a fresh profile; a saved choice is kept (deepMerge), and
  // main.js boots on Staunton until the GLB is in. 'staunton' stays the fallback if it cannot load.
  pieceSet: 'classic',
  showLegalMoves: true,
  showCoordinates: true,
  showLastMove: true,
  showCheck: true,
  showEngineArrow: true,
  showNotes3D: true,
  showEvalBar: true,
  arrowColors: { green: '#15781B', red: '#882020', blue: '#003088', yellow: '#E68F00' },
  viewMode: '3d',
  pieceSet2d: 'glyph',
  lighting: {
    preset: 'studio',
    on: true,
    exposure: 1.0,
    key: 1.0,
    ambient: 1.0,
    shadows: true,
    contrast: true,
  },
  selfPlay: {
    rotate: true,
    autoFlip: true,
    opponent: 'self',
    aiStyle: 'annotate',
    timeControl: { initial: 300000, increment: 0 },
  },
  uiTheme: 'auto',
  background: 'auto',
  environment: 'room',     // where the board sits: 'room' | 'studio' (HDRI + table) | 'plain' (page colour)
  quality: 'auto',         // 'auto' draws motion more cheaply on a slow machine | 'full' never does (three/scene.js)
  shadows: true,
  animations: true,
  autoRotate: false,
  engine: { enabled: false, multipv: 3, depth: 22, movetime: 0, skill: 20, elo: null, autoAnalyse: true },
  ai: {
    provider: 'packet',
    localUrl: 'http://127.0.0.1:8080/v1',
    localModel: '',
    anthropicModel: 'claude-sonnet-5',
    includeEngine: true,
    includeLegalMoves: false,
  },
};

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function clone(v) {
  if (Array.isArray(v)) return v.map(clone);
  if (isPlainObject(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = clone(x);
    return out;
  }
  return v;
}

function deepMerge(base, over) {
  const out = clone(base);
  if (!isPlainObject(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(out[k])) {
      // The default for this key is a sub-object (settings.engine, settings.ai, settings.arrowColors…).
      // A stored null / scalar / array there would be dereferenced blind by every reader and would take
      // the whole boot down, so a corrupt value falls back to the default for that key.
      if (isPlainObject(v)) out[k] = deepMerge(out[k], v);
    } else {
      out[k] = clone(v);
    }
  }
  return out;
}

/** A fresh copy of the settings defaults. */
export function defaultSettings() {
  return clone(SETTINGS_DEFAULTS);
}

function resolveStorage(opt) {
  if (opt !== undefined) return opt;
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (_) { /* disabled storage */ }
  return null;
}

function storageGet(storage, key) {
  try {
    return storage ? storage.getItem(key) : null;
  } catch (_) {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    if (storage) storage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function storageRemove(storage, key) {
  try {
    if (storage) storage.removeItem(key);
  } catch (_) { /* ignore */ }
}

function loadSettings(storage) {
  const raw = storageGet(storage, STORAGE_KEYS.settings);
  if (!raw) return defaultSettings();
  try {
    const stored = JSON.parse(raw);
    const out = deepMerge(SETTINGS_DEFAULTS, isPlainObject(stored) ? stored : {});
    out.quality = normalizeQuality(out.quality);
    return out;
  } catch (_) {
    return defaultSettings();
  }
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(o[parts[i]])) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

const TOAST_KINDS = new Set(['info', 'error', 'ok']);
// chessops' defaultHeaders() placeholders — a PGN whose headers hold only these carries no information.
const PGN_DEFAULT_HEADER_VALUES = new Set(['?', '*', '????.??.??']);
const PANELS = new Set(['moves', 'engine', 'ai', 'notes', 'io', 'settings']);
const VIEW_MODES = new Set(['2d', '3d']);
const OPPONENTS = new Set(['self', 'engine', 'ai']);

/** What kind of opponent the AI seat is. Addendum v2; the page owns it, the agent obeys it. */
export const AI_STYLES = new Set(['silent', 'annotate', 'coach']);

/**
 * Any input -> a valid style. A settings blob written by an older build, or edited by hand, must never
 * reach the bridge as an unknown style: the agent reads this field to decide what to do.
 */
export function normalizeAiStyle(value) {
  return typeof value === 'string' && AI_STYLES.has(value) ? value : 'annotate';
}
/** settings.quality: 'full' or, for anything else (an older build, a hand edit), 'auto'. */
export function normalizeQuality(value) {
  return value === 'full' ? 'full' : 'auto';
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isColor = c => c === 'white' || c === 'black';
const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1);

/** Create an independent store (state + events + bound actions). */
export function createStore(opts = {}) {
  const storage = resolveStorage(opts.storage);
  const autosaveDelay = Number.isFinite(opts.autosaveDelay) ? opts.autosaveDelay : 300;
  const listeners = new Map();
  const settings = loadSettings(storage);
  // The clock's only source of time. Pure core/clock.js never calls Date.now(); the ticker below
  // supplies every stamp, so tests can drive the whole clock from a fake.
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const tickInterval = Number.isFinite(opts.tickInterval) && opts.tickInterval > 0 ? opts.tickInterval : 200;

  const state = {
    game: opts.game instanceof Game ? opts.game : Game.standard(),
    study: { title: '', created: today(), notes: '' },
    mode: 'play',
    setup: null,
    orientation: 'white',
    selected: null,
    legalTargets: [],
    engine: {
      available: false, enabled: !!settings.engine.enabled, thinking: false, depth: 0, nodes: 0, nps: 0,
      score: null, lines: [], bestMove: null, playAs: null,
    },
    ai: { provider: settings.ai.provider || 'packet', busy: false, messages: [], lastError: null },
    settings,
    ui: { panel: 'moves', collapsed: false },
    viewMode: settings.viewMode === '2d' ? '2d' : '3d',
    selfPlay: {
      on: false,
      opponent: OPPONENTS.has(settings.selfPlay.opponent) ? settings.selfPlay.opponent : 'self',
      awaiting: null,
      playerSide: 'white',
    },
    clock: createClock(settings.selfPlay.timeControl),
  };

  let lastFen = state.game.fen();
  let lastNode = state.game.current;
  let autosaveTimer = null;
  let clockTimer = null;
  let engineController = null;      // set by actions.registerEngine (main.js)
  let engineDelegatedColor = null;  // the colour self-play last handed the engine (null = none)

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (e) {
        console.error(`chessboard: listener for ${event} threw`, e);
      }
    }
  }

  // ───────── internal helpers ─────────

  function toast(text, kind = 'info') {
    emit('toast', { text: String(text), kind: TOAST_KINDS.has(kind) ? kind : 'info' });
  }

  function scheduleAutosave() {
    if (!storage) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      actions.autosave();
    }, autosaveDelay);
    if (autosaveTimer && typeof autosaveTimer.unref === 'function') autosaveTimer.unref();
  }

  // ───────── clock ─────────

  /** Mirror a pure-clock result into state.clock (identity preserved); true when anything changed. */
  function applyClock(next) {
    const changed = !clockEquals(state.clock, next);
    Object.assign(state.clock, next);
    return changed;
  }

  function emitClockChange() {
    emit('clock:change', { clock: state.clock });
  }

  function syncTicker() {
    if (clockIsRunning(state.clock)) startTicker();
    else stopTicker();
  }

  function startTicker() {
    if (clockTimer || typeof setInterval !== 'function') return;
    clockTimer = setInterval(() => tickClock(), tickInterval);
    if (clockTimer && typeof clockTimer.unref === 'function') clockTimer.unref();
  }

  function stopTicker() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  }

  /** Advance the clock to now(); emits 'clock:tick' (or flags). The ticker calls this every 200 ms. */
  function tickClock() {
    if (!clockIsRunning(state.clock)) {
      stopTicker();
      return false;
    }
    const next = clockTickPure(state.clock, now());
    if (next.flagged) {
      actions.clockFlag(next.flagged);
      return true;
    }
    applyClock(next);
    emit('clock:tick', { white: state.clock.white, black: state.clock.black, turn: state.clock.turn, flagged: state.clock.flagged });
    return true;
  }

  /** A move was played: burn, increment, hand over. Never called by navigation. */
  function clockOnMove(mover) {
    const c = state.clock;
    if (clockIsUntimed(c) || c.flagged || !isColor(c.turn)) return;
    const next = clockApplyMove(c, now(), { mover, nextTurn: state.game.turn() });
    if (next.flagged) {
      actions.clockFlag(next.flagged);
      return;
    }
    if (applyClock(next)) {
      emitClockChange();
      syncTicker();
    }
  }

  /** Back to the configured time control (a fresh game); restarts it when self-play is running. */
  function resetClockForNewGame() {
    const next = clockResetPure(state.clock, normalizeTimeControl(state.settings.selfPlay.timeControl));
    const started = state.selfPlay.on ? clockStartPure(next, state.game.turn(), now()) : next;
    if (applyClock(started)) {
      emitClockChange();
      syncTicker();
    }
  }

  // ───────── self-play ─────────

  function gameOver() {
    try {
      const st = state.game.status();
      return !!(st && st.outcome);
    } catch (_) {
      return false;
    }
  }

  function emitSelfPlay() {
    emit('selfplay:change', { selfPlay: state.selfPlay });
  }

  function setAwaiting(color) {
    const next = isColor(color) ? color : null;
    if (state.selfPlay.awaiting === next) return false;
    state.selfPlay.awaiting = next;
    emitSelfPlay();
    return true;
  }

  function setEnginePlayAs(color) {
    const c = isColor(color) ? color : null;
    if (engineController && typeof engineController.setPlayAs === 'function') {
      // The engine module mirrors this back through actions.engineSetPlayAs.
      try {
        engineController.setPlayAs(c);
        return;
      } catch (e) {
        console.error('chessboard: engine.setPlayAs threw', e);
      }
    }
    actions.engineSetPlayAs(c);
  }

  /** Point the opponent (engine / AI) at the side the person is not playing. */
  function applyOpponentDelegation() {
    const sp = state.selfPlay;
    // The engine module decides for itself whether the position is playable (it checks status()), so
    // the delegation only tracks self-play and the flag. Re-sending the same colour would cancel an
    // in-flight search, hence the change check — and a colour we never set is never cleared, so a
    // manual "play as" from the engine panel stays hers.
    const wantEngine = sp.on && sp.opponent === 'engine' && !state.clock.flagged ? otherColor(sp.playerSide) : null;
    if (wantEngine !== engineDelegatedColor) {
      engineDelegatedColor = wantEngine;
      setEnginePlayAs(wantEngine);
    }
    if (sp.on && sp.opponent === 'ai' && !gameOver() && !state.clock.flagged) {
      const turn = state.game.turn();
      setAwaiting(turn !== sp.playerSide ? turn : null);
    } else {
      setAwaiting(null);
    }
  }

  /** After a played move: seat rotation for 'self', a fresh awaiting colour for 'ai'. */
  function afterSelfPlayMove() {
    const sp = state.selfPlay;
    if (!sp.on) return;
    const over = gameOver() || !!state.clock.flagged;
    if (sp.opponent === 'self') {
      if (state.settings.selfPlay.autoFlip && !over) actions.setOrientation(state.game.turn());
      return;
    }
    applyOpponentDelegation();
  }

  function clearSelection() {
    if (state.selected !== null || state.legalTargets.length) {
      state.selected = null;
      state.legalTargets = [];
      emit('selection:change', { selected: null, legalTargets: [] });
    }
  }

  function primeEngineFromNode(node) {
    const e = state.engine;
    const ev = node.eval;
    if (ev && (typeof ev.cp === 'number' || typeof ev.mate === 'number')) {
      const score = typeof ev.mate === 'number' ? { mate: ev.mate } : { cp: ev.cp };
      const pv = Array.isArray(ev.pv) ? [...ev.pv] : [];
      // A stored pv can come from a hand-edited YAML / an AI annotation: only trust it when it replays
      // in this position (pvToSan stops at the first illegal move, so an empty result means pv[0] is bogus).
      const san = pv.length ? state.game.pvToSan(pv) : [];
      e.score = score;
      e.depth = ev.depth || 0;
      e.bestMove = san.length ? pv[0] : null;
      e.lines = san.length ? [{ multipv: 1, score: { ...score }, depth: ev.depth || 0, pv, san }] : [];
    } else {
      e.score = null;
      e.depth = 0;
      e.bestMove = null;
      e.lines = [];
    }
    emit('engine:update', { engine: e });
  }

  function afterGameChange(reason, move) {
    const game = state.game;
    const payload = { game, current: game.current, reason };
    if (move) payload.move = move;
    emit('game:change', payload);
    const fen = game.fen();
    if (game.current !== lastNode) {
      // Prime on the NODE, not on the fen: a same-fen load (loadFen of the current position, a setup
      // commit that changed nothing) swaps in a fresh node whose eval is null, and the engine block
      // must follow it or the eval bar shows a score no export contains.
      lastNode = game.current;
      primeEngineFromNode(game.current);
    }
    if (fen !== lastFen) {
      lastFen = fen;
      emit('position:change', { fen, turn: game.turn(), node: game.current });
    }
    // Clear the selection AFTER the game/position events. Listeners key "deselected while a promotion
    // is pending" on a cancelled promotion picker; completing one must deliver game:change first.
    clearSelection();
    scheduleAutosave();
  }

  function leaveSetup() {
    if (state.mode === 'setup') {
      state.mode = 'play';
      state.setup = null;
      emit('mode:change', { mode: 'play' });
    }
  }

  function resetStudy() {
    state.study = { title: '', created: today(), notes: '' };
    emit('study:change', { study: state.study });
  }

  function applyStudy(st, reason) {
    state.game = st.game;
    state.study = { title: st.title || '', created: st.created || today(), notes: st.notes || '' };
    leaveSetup();
    if (st.orientation && st.orientation !== state.orientation) {
      state.orientation = st.orientation;
      emit('orientation:change', { orientation: state.orientation });
    }
    emit('study:change', { study: state.study });
    afterGameChange(reason);
    resetClockForNewGame();
    if (state.selfPlay.on) applyOpponentDelegation();
    if (st.warnings && st.warnings.length) {
      toast(`${st.warnings.length} move(s) dropped on import: ${st.warnings[0]}`, 'error');
    }
  }

  function navigate(reason, fn) {
    const before = state.game.current;
    const result = fn();
    if (state.game.current !== before) afterGameChange(reason);
    return result;
  }

  function setupFromGame() {
    // Carry the whole FEN state across, not just the board: dropping the en-passant square removes a
    // legal capture and dropping the clocks restarts the move number / fifty-move counter, so
    // setup → commit with no edits would silently change the position.
    const [, , castling, ep, half, full] = state.game.fen().split(' ');
    const halfmoves = Number.parseInt(half, 10);
    const fullmoves = Number.parseInt(full, 10);
    return {
      pieces: state.game.pieces(),
      turn: state.game.turn(),
      castling: castling || '-',
      epSquare: ep && ep !== '-' ? ep : null,
      halfmoves: Number.isInteger(halfmoves) && halfmoves >= 0 ? halfmoves : 0,
      fullmoves: Number.isInteger(fullmoves) && fullmoves >= 1 ? fullmoves : 1,
    };
  }

  function setupChanged() {
    emit('game:change', { game: state.game, current: state.game.current, reason: 'setup' });
  }

  function emitAnnotations() {
    emit('annotations:change', { node: state.game.current });
    scheduleAutosave();
  }

  function syncAiProvider() {
    // state.ai.provider is a mirror of settings.ai.provider (the panel reads one, the chat router the
    // other): the store owns the mirror so a reset cannot leave the two disagreeing.
    const next = (state.settings.ai && state.settings.ai.provider) || 'packet';
    if (state.ai.provider === next) return;
    state.ai.provider = next;
    emit('ai:update', { ai: state.ai });
  }

  function syncViewMode() {
    const next = state.settings.viewMode === '2d' ? '2d' : '3d';
    if (state.viewMode === next) return;
    const previous = state.viewMode;
    state.viewMode = next;
    emit('viewmode:change', { mode: next, previous });
  }

  function syncSelfPlaySettings() {
    const want = state.settings.selfPlay || {};
    const opponent = OPPONENTS.has(want.opponent) ? want.opponent : 'self';
    if (state.selfPlay.opponent !== opponent) {
      state.selfPlay.opponent = opponent;
      emitSelfPlay();
      if (state.selfPlay.on) applyOpponentDelegation();
    }
    // Only adopt a new time control on an idle clock — never wipe a running or half-played one.
    if (clockIsRunning(state.clock) || state.clock.turn || state.clock.flagged) return;
    const tc = normalizeTimeControl(want.timeControl);
    if (tc.initial === state.clock.initial && tc.increment === state.clock.increment) return;
    if (applyClock(createClock(tc))) {
      emitClockChange();
      syncTicker();
    }
  }

  function syncFromSettings() {
    syncAiProvider();
    syncViewMode();
    syncSelfPlaySettings();
  }

  function saveSettings() {
    storageSet(storage, STORAGE_KEYS.settings, JSON.stringify(state.settings));
  }

  function pgnTitle(game) {
    const w = game.headers.get('White');
    const b = game.headers.get('Black');
    const ev = game.headers.get('Event');
    if (w && b && w !== '?' && b !== '?') return `${w} - ${b}`;
    if (ev && ev !== '?') return ev;
    return '';
  }

  // ───────── actions ─────────

  const actions = {
    // game
    /** Fresh standard game and a fresh study. */
    newGame() {
      state.game = Game.standard();
      resetStudy();
      leaveSetup();
      afterGameChange('new');
      resetClockForNewGame();
      if (state.selfPlay.on) applyOpponentDelegation();
    },
    /** Fresh Chess960 game (n in 0..959, undefined = random); returns the number. */
    newChess960(n) {
      state.game = Game.chess960(Number.isInteger(n) ? n : undefined);
      resetStudy();
      leaveSetup();
      afterGameChange('new');
      resetClockForNewGame();
      if (state.selfPlay.on) applyOpponentDelegation();
      return state.game.chess960Number;
    },
    /** Load a FEN as a fresh study; false + toast when invalid. */
    loadFen(fen) {
      let game;
      try {
        game = Game.fromFen(fen);
      } catch (e) {
        toast(`FEN: ${e.message}`, 'error');
        return false;
      }
      applyStudy({ title: '', created: today(), notes: '', orientation: state.orientation, game }, 'load');
      return true;
    },
    /** Load a PGN (first game) as a fresh study; false + toast when invalid. */
    loadPgn(text) {
      let game;
      try {
        game = Game.fromPgn(text);
      } catch (e) {
        toast(`PGN: ${e.message}`, 'error');
        return false;
      }
      // chessops happily parses prose, a bare FEN, JSON or a YAML study into a game with zero moves and
      // nothing but default headers. Loading that would wipe the current study (and the autosave 300 ms
      // later) with no warning, so refuse anything that carries neither a move nor real header data.
      if (!game.hasMoves() && ![...game.headers].some(([, v]) => !PGN_DEFAULT_HEADER_VALUES.has(v))) {
        toast('PGN: no moves or headers found', 'error');
        return false;
      }
      applyStudy({ title: pgnTitle(game), created: today(), notes: '', orientation: state.orientation, game, warnings: game.warnings }, 'load');
      return true;
    },
    /** Load a study object ({ title, created, notes, orientation, game }); `game` may be a Game or its JSON. */
    loadStudy(studyObj) {
      let st;
      try {
        if (!studyObj || typeof studyObj !== 'object') throw new Error('not a study');
        st = studyObj.game instanceof Game ? { ...studyObj, warnings: studyObj.game.warnings } : studyFromJSON(studyObj);
      } catch (e) {
        toast(`Study: ${e.message}`, 'error');
        return false;
      }
      applyStudy(st, 'load');
      return true;
    },
    /** Load a YAML study; false + toast when invalid. */
    loadYaml(text) {
      let st;
      try {
        st = studyFromYaml(text);
      } catch (e) {
        toast(`YAML: ${e.message}`, 'error');
        return false;
      }
      applyStudy(st, 'load');
      return true;
    },
    /** Try a from→to from the board: 'played' | 'promotion' (emits promotion:required) | 'illegal'. */
    attemptMove(a, b) {
      const from = typeof a === 'string' ? a : a && a.from;
      const to = typeof a === 'string' ? b : a && a.to;
      if (state.mode !== 'play' || !from || !to) return 'illegal';
      const game = state.game;
      const piece = game.pieceAt(from);
      if (!piece) return 'illegal';
      const inTargets = game.legalTargets(from).includes(to);
      if (!inTargets && !game.isLegal({ from, to })) return 'illegal';
      const lastRank = to[1] === '8' || to[1] === '1';
      if (piece.role === 'pawn' && lastRank) {
        emit('promotion:required', { from, to });
        return 'promotion';
      }
      return actions.playMove({ from, to }) ? 'played' : 'illegal';
    },
    /** Play a move ({from,to,promotion?} or UCI); null + toast when illegal. */
    playMove(move) {
      if (state.mode !== 'play') {
        toast('Leave setup mode to play moves', 'error');
        return null;
      }
      const mover = state.game.turn();
      let res;
      try {
        res = state.game.play(move);
      } catch (e) {
        const text = typeof move === 'string' ? move : move && `${move.from}${move.to}${move.promotion || ''}`;
        toast(`Illegal move: ${text}`, 'error');
        return null;
      }
      afterGameChange('move', res);
      // Only a played move touches the clock (navigation never does), and only after the game events
      // so a listener that repaints on game:change already has the new position when the clock moves.
      clockOnMove(mover);
      afterSelfPlayMove();
      return res.node;
    },
    /** Play a SAN move; null + toast when illegal. */
    playSan(san) {
      const m = state.game.sanToMove(san);
      if (!m) {
        toast(`Illegal move: ${san}`, 'error');
        return null;
      }
      return actions.playMove(m);
    },
    /** Jump to a node. */
    goto(nodeId) {
      return navigate('goto', () => state.game.goto(nodeId));
    },
    /** One move back. */
    back() {
      return navigate('goto', () => state.game.back());
    },
    /** One move forward along children[0]. */
    forward() {
      return navigate('goto', () => state.game.forward());
    },
    /** To the root. */
    toStart() {
      return navigate('goto', () => state.game.toStart());
    },
    /** To the end of the current line. */
    toEnd() {
      return navigate('goto', () => state.game.toEnd());
    },
    /** Next sibling variation. */
    nextVariation() {
      return navigate('goto', () => state.game.nextVariation());
    },
    /** Previous sibling variation. */
    prevVariation() {
      return navigate('goto', () => state.game.prevVariation());
    },
    /** Make a node children[0] of its parent. */
    promoteVariation(id) {
      state.game.promoteVariation(id);
      afterGameChange('promote');
    },
    /** Promote a node all the way to the main line. */
    makeMainline(id) {
      state.game.makeMainline(id);
      afterGameChange('promote');
    },
    /** Delete a subtree (current moves to the parent). */
    deleteFrom(id) {
      state.game.deleteFrom(id);
      afterGameChange('delete');
    },
    /** Select a square (null clears); legal targets computed for it. */
    select(square) {
      const sq = square || null;
      const targets = sq && state.mode === 'play' ? state.game.legalTargets(sq) : [];
      if (sq === state.selected && sameList(targets, state.legalTargets)) return;
      state.selected = sq;
      state.legalTargets = targets;
      emit('selection:change', { selected: sq, legalTargets: [...targets] });
    },
    /** Switch between 'play' and 'setup' (setup scratch initialised from the current position). */
    setMode(mode) {
      if ((mode !== 'play' && mode !== 'setup') || mode === state.mode) return;
      state.setup = mode === 'setup' ? setupFromGame() : null;
      state.mode = mode;
      clearSelection();
      emit('mode:change', { mode });
      // Cancelling setup (setup → play without a commit) leaves the position untouched, but the engine
      // module blanks its block on mode:change → setup. Re-prime from the node so a stored eval comes back.
      if (mode === 'play') primeEngineFromNode(state.game.current);
    },
    /** Flip the board orientation. */
    flip() {
      actions.setOrientation(state.orientation === 'white' ? 'black' : 'white');
    },
    /** Set the board orientation. */
    setOrientation(c) {
      if ((c !== 'white' && c !== 'black') || c === state.orientation) return;
      state.orientation = c;
      emit('orientation:change', { orientation: c });
      scheduleAutosave();
    },
    // view mode
    /** Switch between the 3D board and the locked top-down 2D board; persists + emits viewmode:change. */
    setViewMode(mode) {
      if (!VIEW_MODES.has(mode) || state.viewMode === mode) return false;
      const previous = state.viewMode;
      state.viewMode = mode;
      // Persist first so a listener that re-reads settings during viewmode:change sees the new value.
      actions.setSetting('viewMode', mode);
      emit('viewmode:change', { mode, previous });
      return true;
    },
    /** 2D <-> 3D. */
    toggleViewMode() {
      return actions.setViewMode(state.viewMode === '2d' ? '3d' : '2d');
    },
    // self-play
    /**
     * Start self-play. opts: { opponent?, timeControl?, rotate?, autoFlip?, playAs? }.
     * Resets and starts the clock (untimed time controls simply never run) and points the chosen
     * opponent at the side the person is not playing. Both sides stay movable by hand, always.
     */
    startSelfPlay(opts) {
      const o = opts && typeof opts === 'object' ? opts : {};
      if (state.mode !== 'play') {
        toast('Leave setup mode to start self-play', 'error');
        return false;
      }
      if (OPPONENTS.has(o.opponent)) actions.setSetting('selfPlay.opponent', o.opponent);
      if (o.timeControl !== undefined) actions.setSetting('selfPlay.timeControl', normalizeTimeControl(o.timeControl));
      if (typeof o.rotate === 'boolean') actions.setSetting('selfPlay.rotate', o.rotate);
      if (typeof o.autoFlip === 'boolean') actions.setSetting('selfPlay.autoFlip', o.autoFlip);
      state.selfPlay.on = true;
      state.selfPlay.opponent = OPPONENTS.has(state.settings.selfPlay.opponent) ? state.settings.selfPlay.opponent : 'self';
      state.selfPlay.playerSide = isColor(o.playAs) ? o.playAs : state.orientation;
      state.selfPlay.awaiting = null;
      const fresh = clockStartPure(createClock(state.settings.selfPlay.timeControl), state.game.turn(), now());
      if (applyClock(fresh)) {
        emitClockChange();
        syncTicker();
      }
      emitSelfPlay();
      applyOpponentDelegation();
      return true;
    },
    /** Stop self-play: the clock pauses, the delegation is dropped, the game and tree are untouched. */
    stopSelfPlay() {
      if (!state.selfPlay.on) return false;
      state.selfPlay.on = false;
      state.selfPlay.awaiting = null;
      const paused = clockPausePure(state.clock, now());
      if (applyClock(paused)) emitClockChange();
      stopTicker();
      emitSelfPlay();
      applyOpponentDelegation();
      return true;
    },
    /** 'self' | 'engine' | 'ai'; persists and re-points the delegation when self-play is running. */
    setSelfPlayOpponent(id) {
      if (!OPPONENTS.has(id)) return false;
      if (state.settings.selfPlay.opponent !== id) actions.setSetting('selfPlay.opponent', id);
      if (state.selfPlay.opponent !== id) {
        state.selfPlay.opponent = id;
        emitSelfPlay();
      }
      if (state.selfPlay.on) applyOpponentDelegation();
      return true;
    },
    /** The MCP bridge / AI answers an awaiting request (or gives up): clears selfPlay.awaiting. */
    clearSelfPlayAwaiting() {
      return setAwaiting(null);
    },
    /** The integrator hands the store the engine instance so self-play can call engine.setPlayAs. */
    registerEngine(engine) {
      engineController = engine && typeof engine.setPlayAs === 'function' ? engine : null;
      if (state.selfPlay.on && engineDelegatedColor) {
        engineDelegatedColor = null;                       // re-send to the newly registered engine
        applyOpponentDelegation();
      }
    },
    // clock
    /** Set { initial, increment } in ms (initial 0 = untimed); refused while the clock runs. */
    setTimeControl(tc) {
      if (clockIsRunning(state.clock)) {
        toast('Pause the clock before changing the time control', 'error');
        return false;
      }
      const next = normalizeTimeControl(tc);
      actions.setSetting('selfPlay.timeControl', next);
      if (applyClock(createClock(next))) {
        emitClockChange();
        syncTicker();
      }
      return true;
    },
    /** Start the clock on `color` (default: the side to move). Untimed clocks never start. */
    clockStart(color) {
      if (clockIsUntimed(state.clock) || state.clock.flagged) return false;
      const turn = isColor(color) ? color : state.game.turn();
      if (applyClock(clockStartPure(state.clock, turn, now()))) {
        emitClockChange();
        syncTicker();
      }
      return clockIsRunning(state.clock);
    },
    /** Stop burning time, keeping both readouts and whose turn it is. */
    clockPause() {
      if (!clockIsRunning(state.clock)) return false;
      applyClock(clockPausePure(state.clock, now()));
      stopTicker();
      emitClockChange();
      return true;
    },
    /** Resume a paused clock for the side it was paused on. */
    clockResume() {
      if (clockIsRunning(state.clock) || clockIsUntimed(state.clock) || state.clock.flagged) return false;
      if (!applyClock(clockResumePure(state.clock, now()))) return false;
      emitClockChange();
      syncTicker();
      return true;
    },
    /** Both sides back to the time control; the flag and the turn are cleared. */
    clockReset(tc) {
      const control = tc === undefined ? { initial: state.clock.initial, increment: state.clock.increment } : normalizeTimeControl(tc);
      if (tc !== undefined) actions.setSetting('selfPlay.timeControl', control);
      stopTicker();
      if (applyClock(clockResetPure(state.clock, control))) {
        emitClockChange();
        syncTicker();
      }
      return true;
    },
    /**
     * `color` ran out of time. Flags once, stops the clock, toasts and ends the self-play delegation.
     * The rules are untouched: game.status() still reports the position, never a fake checkmate.
     */
    clockFlag(color) {
      if (!isColor(color) || state.clock.flagged || clockIsUntimed(state.clock)) return false;
      if (!applyClock(clockFlagPure(state.clock, color))) return false;
      stopTicker();
      emitClockChange();
      toast(`${capitalise(color)} lost on time`, 'info');
      applyOpponentDelegation();
      return true;
    },
    // setup mode
    /** Place (or remove with null) a piece on the setup board. */
    setupPlace(square, piece) {
      if (state.mode !== 'setup' || !state.setup || typeof square !== 'string') return false;
      const list = state.setup.pieces.filter(p => p.square !== square);
      if (piece && piece.role && piece.color) list.push({ square, piece: { color: piece.color, role: piece.role } });
      state.setup.pieces = list;
      setupChanged();
      return true;
    },
    /** Empty the setup board. */
    setupClear() {
      if (state.mode !== 'setup' || !state.setup) return;
      state.setup.pieces = [];
      state.setup.castling = '-';
      setupChanged();
    },
    /** Reset the setup board to the standard start. */
    setupStart() {
      if (state.mode !== 'setup' || !state.setup) return;
      state.setup.pieces = Game.standard().pieces();
      state.setup.turn = 'white';
      state.setup.castling = 'KQkq';
      setupChanged();
    },
    /** Side to move in the setup scratch. */
    setupTurn(color) {
      if (state.mode !== 'setup' || !state.setup || (color !== 'white' && color !== 'black')) return;
      state.setup.turn = color;
      setupChanged();
    },
    /** Castling rights string ('KQkq', 'Kq', '-', or X-FEN letters). */
    setupCastling(str) {
      if (state.mode !== 'setup' || !state.setup) return;
      state.setup.castling = typeof str === 'string' && str.trim() ? str.trim() : '-';
      setupChanged();
    },
    /** Build the game from the setup scratch and return to play mode. Toast + throw when illegal. */
    setupCommit() {
      if (state.mode !== 'setup' || !state.setup) throw new Error('not in setup mode');
      let game;
      try {
        game = Game.fromPieces(state.setup.pieces, {
          turn: state.setup.turn,
          castling: state.setup.castling,
          epSquare: state.setup.epSquare || undefined,
          halfmoves: state.setup.halfmoves,
          fullmoves: state.setup.fullmoves,
        });
      } catch (e) {
        toast(`Setup: ${e.message}`, 'error');
        throw e;
      }
      state.game = game;
      state.setup = null;
      state.mode = 'play';
      emit('mode:change', { mode: 'play' });
      afterGameChange('setup');
      return true;
    },
    // annotations (current node)
    /** Toggle an arrow on the current node; true when added. */
    toggleArrow(arrow) {
      const added = state.game.toggleArrow(state.game.current.id, arrow);
      emitAnnotations();
      return added;
    },
    /** Toggle / recolour a highlight on the current node; true when present afterwards. */
    toggleHighlight(square, color) {
      const on = state.game.toggleHighlight(state.game.current.id, square, color);
      emitAnnotations();
      return on;
    },
    /** Add arrows (same from/to replaces), tagged with a source ('user' | 'engine' | 'ai'). */
    addArrows(arrows, source) {
      const node = state.game.current;
      const incoming = (arrows || []).filter(a => a && a.from && a.to).map(a => ({ ...a, source: source || a.source || 'user' }));
      const kept = node.arrows.filter(x => !incoming.some(a => a.from === x.from && a.to === x.to));
      state.game.setArrows(node.id, [...kept, ...incoming]);
      emitAnnotations();
    },
    /** Replace the highlights of the current node. */
    setHighlights(list) {
      state.game.setHighlights(state.game.current.id, list || []);
      emitAnnotations();
    },
    /** Clear arrows / highlights / notes on the current node (defaults: arrows + highlights). */
    clearAnnotations(what) {
      const o = { arrows: true, highlights: true, notes: false, ...(what || {}) };
      const node = state.game.current;
      if (o.arrows) state.game.setArrows(node.id, []);
      if (o.highlights) state.game.setHighlights(node.id, []);
      if (o.notes) {
        state.game.setNote(node.id, '');
        state.game.setNag(node.id, '');
      }
      emitAnnotations();
      if (o.notes) emit('game:change', { game: state.game, current: node, reason: 'note' });
    },
    /** Note on the current node. */
    setNote(text) {
      const node = state.game.current;
      state.game.setNote(node.id, text);
      emitAnnotations();
      emit('game:change', { game: state.game, current: node, reason: 'note' });
    },
    /** NAG glyph on the current node. */
    setNag(nag) {
      const node = state.game.current;
      state.game.setNag(node.id, nag);
      emitAnnotations();
      emit('game:change', { game: state.game, current: node, reason: 'note' });
    },
    /** Study-level notes. */
    setStudyNotes(text) {
      state.study.notes = typeof text === 'string' ? text : '';
      emit('study:change', { study: state.study });
      scheduleAutosave();
    },
    /** Study title. */
    setStudyTitle(text) {
      state.study.title = typeof text === 'string' ? text : '';
      emit('study:change', { study: state.study });
      scheduleAutosave();
    },
    // settings
    /** Set a setting by dotted path, persist, emit settings:change { path, value, settings }. */
    setSetting(path, value) {
      if (typeof path !== 'string' || !path) return;
      const v = path === 'quality' ? normalizeQuality(value) : clone(value);
      setPath(state.settings, path, v);
      saveSettings();
      emit('settings:change', { path, value: v, settings: state.settings });
      // The mirrors (ai.provider, viewMode, selfPlay.opponent, an idle clock's time control) follow
      // whatever path was written — a panel may set 'selfPlay', 'selfPlay.opponent' or the whole blob.
      syncFromSettings();
    },
    /** Back to defaults (one settings:change per top-level key). */
    resetSettings() {
      state.settings = defaultSettings();
      storageRemove(storage, STORAGE_KEYS.settings);
      for (const key of Object.keys(state.settings)) {
        emit('settings:change', { path: key, value: state.settings[key], settings: state.settings });
      }
      syncFromSettings();
    },
    // engine
    /** Patch engine status fields (available / enabled / thinking / depth / nodes / nps …). */
    engineStatus(patch) {
      Object.assign(state.engine, patch || {});
      emit('engine:update', { engine: state.engine });
    },
    /** New engine lines for the current position (White's view). Stores the top line as the node's eval. */
    engineLines(lines, score, depth, bestMove, fen) {
      const game = state.game;
      if (fen && fen !== game.fen()) return;
      const e = state.engine;
      e.lines = Array.isArray(lines) ? lines : [];
      e.score = score === undefined ? e.score : score;
      if (Number.isFinite(depth)) e.depth = depth;
      e.bestMove = bestMove === undefined ? e.bestMove : bestMove;
      if (state.mode === 'play' && e.lines.length && Number.isFinite(depth) && depth > 0) {
        const node = game.current;
        const top = e.lines[0];
        const prev = node.eval;
        if (!prev || (prev.depth || 0) <= depth) {
          const sc = top.score || score;
          if (sc && (typeof sc.cp === 'number' || typeof sc.mate === 'number')) {
            const ev = { depth, pv: Array.isArray(top.pv) ? [...top.pv] : [] };
            if (typeof sc.mate === 'number') ev.mate = sc.mate;
            else ev.cp = sc.cp;
            const best = (Array.isArray(top.san) && top.san[0]) || (ev.pv[0] ? game.pvToSan([ev.pv[0]])[0] : undefined);
            if (best) ev.best = best;
            game.setEval(node.id, ev);
            // The eval is persisted state like any annotation; without this a crash mid-analysis loses
            // every eval since the last move. scheduleAutosave is debounced, so a stream just resets it.
            scheduleAutosave();
          }
        }
      }
      emit('engine:update', { engine: e });
    },
    /** Which colour the engine plays (null = analysis only). */
    engineSetPlayAs(color) {
      state.engine.playAs = color === 'white' || color === 'black' ? color : null;
      emit('engine:update', { engine: state.engine });
    },
    // ai
    /** Append a chat message { role, text, at }. */
    aiMessage(msg) {
      const m = typeof msg === 'string' ? { role: 'assistant', text: msg } : msg || {};
      state.ai.messages.push({
        role: m.role === 'user' || m.role === 'system' ? m.role : 'assistant',
        text: String(m.text === undefined ? '' : m.text),
        at: m.at || new Date().toISOString(),
      });
      if (state.ai.messages.length > 200) state.ai.messages.splice(0, state.ai.messages.length - 200);
      emit('ai:update', { ai: state.ai });
    },
    /** AI busy flag. */
    aiBusy(bool) {
      state.ai.busy = !!bool;
      emit('ai:update', { ai: state.ai });
    },
    /** AI error text (also clears busy). */
    aiError(text) {
      state.ai.lastError = text ? String(text) : null;
      state.ai.busy = false;
      emit('ai:update', { ai: state.ai });
    },
    /** Clear the chat log and error. */
    aiClear() {
      state.ai.messages = [];
      state.ai.lastError = null;
      emit('ai:update', { ai: state.ai });
    },
    // ui
    /** Active side panel. */
    setPanel(name) {
      if (!PANELS.has(name) || state.ui.panel === name) return;
      state.ui.panel = name;
      emit('ui:change', { ui: state.ui });
    },
    /** Collapse / expand the side panel. */
    toggleCollapsed() {
      state.ui.collapsed = !state.ui.collapsed;
      emit('ui:change', { ui: state.ui });
    },
    // persistence
    /** Write the study to storage now (also runs debounced after every game change). */
    autosave() {
      if (autosaveTimer) {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
      }
      if (!storage) return false;
      try {
        const obj = studyToJSON({ ...state.study, orientation: state.orientation, game: state.game });
        return storageSet(storage, STORAGE_KEYS.study, JSON.stringify(obj));
      } catch (_) {
        return false;
      }
    },
    /** Restore the autosaved study; true when something was restored. */
    restore() {
      const raw = storageGet(storage, STORAGE_KEYS.study);
      if (!raw) return false;
      try {
        const st = studyFromJSON(JSON.parse(raw));
        applyStudy(st, 'load');
        return true;
      } catch (e) {
        console.warn('chessboard: could not restore the autosaved study:', e && e.message);
        return false;
      }
    },
    /** Emit a toast { text, kind }. */
    toast(text, kind) {
      toast(text, kind);
    },
  };

  const store = {
    state,
    on,
    off,
    emit,
    actions,
    /** Advance the clock to now() and emit 'clock:tick' (the 200 ms ticker calls this; tests pump it). */
    tickClock,
    /** Clear pending timers (tests). */
    dispose() {
      if (autosaveTimer) clearTimeout(autosaveTimer);
      autosaveTimer = null;
      stopTicker();
      engineController = null;
      listeners.clear();
    },
  };
  return store;
}

/** The application store. */
export const store = createStore();
/** Actions bound to the singleton store. */
export const actions = store.actions;
