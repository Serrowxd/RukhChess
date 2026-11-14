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
import { QUALITY, normalizeQuality } from '../three/motionQuality.js';

export const STORAGE_KEYS = { settings: 'chessboard.settings', study: 'chessboard.study' };

/** Never mutate; use defaultSettings() for a copy. */
export const SETTINGS_DEFAULTS = {
  theme: 'wood',
  palette: null,
  pieceSet: 'classic', // main.js boots on Staunton until the GLB is in
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
  environment: 'room', // 'room' | 'studio' | 'plain'
  quality: 'auto', // 'auto' | 'high' | 'medium' | 'low'
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
      // A corrupt non-object stored over a sub-object default falls back to the default.
      if (isPlainObject(v)) out[k] = deepMerge(out[k], v);
    } else {
      out[k] = clone(v);
    }
  }

  return out;
}

export function defaultSettings() {
  return clone(SETTINGS_DEFAULTS);
}

function resolveStorage(opt) {
  if (opt !== undefined) return opt;

  try {
    if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  } catch (_) {}

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
  } catch (_) {}
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

// chessops' defaultHeaders() placeholders: headers holding only these carry no information.
const PGN_DEFAULT_HEADER_VALUES = new Set(['?', '*', '????.??.??']);
const PANELS = new Set(['moves', 'engine', 'ai', 'notes', 'io', 'settings']);
const VIEW_MODES = new Set(['2d', '3d']);
const OPPONENTS = new Set(['self', 'engine', 'ai']);

/** What kind of opponent the AI seat is; the page owns it, the agent obeys it. */
export const AI_STYLES = new Set(['silent', 'annotate', 'coach']);

/** Any input to a valid style, so an unknown style never reaches the bridge. */
export function normalizeAiStyle(value) {
  return typeof value === 'string' && AI_STYLES.has(value) ? value : 'annotate';
}

export const QUALITY_LEVELS = Object.keys(QUALITY);
export { normalizeQuality };

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isColor = c => c === 'white' || c === 'black';
const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1);

/** An independent store: state, events and bound actions. */
export function createStore(opts = {}) {
  const storage = resolveStorage(opts.storage);
  const autosaveDelay = Number.isFinite(opts.autosaveDelay) ? opts.autosaveDelay : 300;
  const listeners = new Map();
  const settings = loadSettings(storage);

  // The clock's only source of time, so tests can drive it from a fake.
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
  let engineController = null; // set by actions.registerEngine
  let engineDelegatedColor = null; // the colour self-play last handed the engine

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

  // Internal helpers

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

  // Clock

  /** Mirror a pure-clock result into state.clock, keeping its identity; true when anything changed. */
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

  /** Advance the clock to now(); emits 'clock:tick' or flags. */
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

  /** Back to the configured time control; restarts it when self-play is running. */
  function resetClockForNewGame() {
    const next = clockResetPure(state.clock, normalizeTimeControl(state.settings.selfPlay.timeControl));
    const started = state.selfPlay.on ? clockStartPure(next, state.game.turn(), now()) : next;

    if (applyClock(started)) {
      emitClockChange();
      syncTicker();
    }
  }

  // Self-play

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

  /** Point the opponent at the side the person is not playing. */
  function applyOpponentDelegation() {
    const sp = state.selfPlay;

    // Only on change: re-sending cancels a search, and a manual "play as" we never set stays as the person set it.
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

      // Trust a stored pv only when it replays here.
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

    // Prime on the node, not the fen: a same-fen load swaps in a fresh node without an eval.
    if (game.current !== lastNode) {
      lastNode = game.current;
      primeEngineFromNode(game.current);
    }

    if (fen !== lastFen) {
      lastFen = fen;
      emit('position:change', { fen, turn: game.turn(), node: game.current });
    }

    // Last, so a completed promotion is not read as a cancelled one.
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
    // Carry the whole FEN state, so setup then commit with no edits changes nothing.
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
    // state.ai.provider mirrors settings.ai.provider; owning the mirror keeps a reset consistent.
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

    // Only an idle clock adopts a new time control.
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

  // Actions

  const actions = {
    // Game

    /** Fresh standard game and a fresh study. */
    newGame() {
      state.game = Game.standard();
      resetStudy();
      leaveSetup();
      afterGameChange('new');
      resetClockForNewGame();
      if (state.selfPlay.on) applyOpponentDelegation();
    },

    /** Fresh Chess960 game, n in 0..959 or random; returns the number. */
    newChess960(n) {
      state.game = Game.chess960(Number.isInteger(n) ? n : undefined);
      resetStudy();
      leaveSetup();
      afterGameChange('new');
      resetClockForNewGame();
      if (state.selfPlay.on) applyOpponentDelegation();
      return state.game.chess960Number;
    },

    /** False and a toast when invalid. */
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

    /** False and a toast when invalid. */
    loadPgn(text) {
      let game;

      try {
        game = Game.fromPgn(text);
      } catch (e) {
        toast(`PGN: ${e.message}`, 'error');
        return false;
      }

      // chessops parses almost any text into an empty game; refuse one with no moves and no real headers.
      if (!game.hasMoves() && ![...game.headers].some(([, v]) => !PGN_DEFAULT_HEADER_VALUES.has(v))) {
        toast('PGN: no moves or headers found', 'error');
        return false;
      }

      applyStudy({ title: pgnTitle(game), created: today(), notes: '', orientation: state.orientation, game, warnings: game.warnings }, 'load');
      return true;
    },

    /** `game` may be a Game or its JSON. */
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

    /** False and a toast when invalid. */
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

    /** A from-to from the board: 'played', 'promotion' (emits promotion:required) or 'illegal'. */
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

    /** A move object or UCI; null and a toast when illegal. */
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

      // After the game events, so a repaint on game:change already has the new position.
      clockOnMove(mover);
      afterSelfPlayMove();
      return res.node;
    },

    /** Null and a toast when illegal. */
    playSan(san) {
      const m = state.game.sanToMove(san);

      if (!m) {
        toast(`Illegal move: ${san}`, 'error');
        return null;
      }

      return actions.playMove(m);
    },

    goto(nodeId) {
      return navigate('goto', () => state.game.goto(nodeId));
    },

    back() {
      return navigate('goto', () => state.game.back());
    },

    forward() {
      return navigate('goto', () => state.game.forward());
    },

    toStart() {
      return navigate('goto', () => state.game.toStart());
    },

    toEnd() {
      return navigate('goto', () => state.game.toEnd());
    },

    nextVariation() {
      return navigate('goto', () => state.game.nextVariation());
    },

    prevVariation() {
      return navigate('goto', () => state.game.prevVariation());
    },

    promoteVariation(id) {
      state.game.promoteVariation(id);
      afterGameChange('promote');
    },

    makeMainline(id) {
      state.game.makeMainline(id);
      afterGameChange('promote');
    },

    deleteFrom(id) {
      state.game.deleteFrom(id);
      afterGameChange('delete');
    },

    /** Select a square, or clear with null. */
    select(square) {
      const sq = square || null;
      const targets = sq && state.mode === 'play' ? state.game.legalTargets(sq) : [];
      if (sq === state.selected && sameList(targets, state.legalTargets)) return;

      state.selected = sq;
      state.legalTargets = targets;
      emit('selection:change', { selected: sq, legalTargets: [...targets] });
    },

    /** 'play' or 'setup'; the setup scratch starts from the current position. */
    setMode(mode) {
      if ((mode !== 'play' && mode !== 'setup') || mode === state.mode) return;

      state.setup = mode === 'setup' ? setupFromGame() : null;
      state.mode = mode;
      clearSelection();
      emit('mode:change', { mode });

      // The engine blanks its block on setup; a cancelled setup re-primes the stored eval.
      if (mode === 'play') primeEngineFromNode(state.game.current);
    },

    flip() {
      actions.setOrientation(state.orientation === 'white' ? 'black' : 'white');
    },

    setOrientation(c) {
      if ((c !== 'white' && c !== 'black') || c === state.orientation) return;

      state.orientation = c;
      emit('orientation:change', { orientation: c });
      scheduleAutosave();
    },

    // View mode

    /** The 3D board or the locked top-down 2D board. */
    setViewMode(mode) {
      if (!VIEW_MODES.has(mode) || state.viewMode === mode) return false;

      const previous = state.viewMode;
      state.viewMode = mode;

      // Persist first so a listener that re-reads settings sees the new value.
      actions.setSetting('viewMode', mode);
      emit('viewmode:change', { mode, previous });
      return true;
    },

    toggleViewMode() {
      return actions.setViewMode(state.viewMode === '2d' ? '3d' : '2d');
    },

    // Self-play

    /** opts: { opponent?, timeControl?, rotate?, autoFlip?, playAs? }. Both sides stay hand-movable. */
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

    /** The clock pauses and the delegation drops; the game is untouched. */
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

    /** 'self' | 'engine' | 'ai'. */
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

    clearSelfPlayAwaiting() {
      return setAwaiting(null);
    },

    /** The engine instance self-play delegates to. */
    registerEngine(engine) {
      engineController = engine && typeof engine.setPlayAs === 'function' ? engine : null;

      if (state.selfPlay.on && engineDelegatedColor) {
        engineDelegatedColor = null; // re-send to the newly registered engine
        applyOpponentDelegation();
      }
    },

    // Clock

    /** { initial, increment } in ms, initial 0 untimed; refused while the clock runs. */
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

    /** Start on `color`, default the side to move. */
    clockStart(color) {
      if (clockIsUntimed(state.clock) || state.clock.flagged) return false;

      const turn = isColor(color) ? color : state.game.turn();

      if (applyClock(clockStartPure(state.clock, turn, now()))) {
        emitClockChange();
        syncTicker();
      }

      return clockIsRunning(state.clock);
    },

    clockPause() {
      if (!clockIsRunning(state.clock)) return false;

      applyClock(clockPausePure(state.clock, now()));
      stopTicker();
      emitClockChange();
      return true;
    },

    clockResume() {
      if (clockIsRunning(state.clock) || clockIsUntimed(state.clock) || state.clock.flagged) return false;
      if (!applyClock(clockResumePure(state.clock, now()))) return false;

      emitClockChange();
      syncTicker();
      return true;
    },

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

    /** Flags once; the rules are untouched, so status() never reports a fake checkmate. */
    clockFlag(color) {
      if (!isColor(color) || state.clock.flagged || clockIsUntimed(state.clock)) return false;
      if (!applyClock(clockFlagPure(state.clock, color))) return false;

      stopTicker();
      emitClockChange();
      toast(`${capitalise(color)} lost on time`, 'info');
      applyOpponentDelegation();
      return true;
    },

    // Setup mode

    /** Place a piece, or remove with null. */
    setupPlace(square, piece) {
      if (state.mode !== 'setup' || !state.setup || typeof square !== 'string') return false;

      const list = state.setup.pieces.filter(p => p.square !== square);
      if (piece && piece.role && piece.color) list.push({ square, piece: { color: piece.color, role: piece.role } });

      state.setup.pieces = list;
      setupChanged();
      return true;
    },

    setupClear() {
      if (state.mode !== 'setup' || !state.setup) return;

      state.setup.pieces = [];
      state.setup.castling = '-';
      setupChanged();
    },

    setupStart() {
      if (state.mode !== 'setup' || !state.setup) return;

      state.setup.pieces = Game.standard().pieces();
      state.setup.turn = 'white';
      state.setup.castling = 'KQkq';
      setupChanged();
    },

    setupTurn(color) {
      if (state.mode !== 'setup' || !state.setup || (color !== 'white' && color !== 'black')) return;

      state.setup.turn = color;
      setupChanged();
    },

    /** 'KQkq', 'Kq', '-', or X-FEN letters. */
    setupCastling(str) {
      if (state.mode !== 'setup' || !state.setup) return;

      state.setup.castling = typeof str === 'string' && str.trim() ? str.trim() : '-';
      setupChanged();
    },

    /** Build the game and return to play mode; toasts and throws when illegal. */
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

    // Annotations on the current node

    /** True when added. */
    toggleArrow(arrow) {
      const added = state.game.toggleArrow(state.game.current.id, arrow);
      emitAnnotations();
      return added;
    },

    /** True when present afterwards. */
    toggleHighlight(square, color) {
      const on = state.game.toggleHighlight(state.game.current.id, square, color);
      emitAnnotations();
      return on;
    },

    /** Same from/to replaces; tagged with a source. */
    addArrows(arrows, source) {
      const node = state.game.current;
      const incoming = (arrows || []).filter(a => a && a.from && a.to).map(a => ({ ...a, source: source || a.source || 'user' }));
      const kept = node.arrows.filter(x => !incoming.some(a => a.from === x.from && a.to === x.to));

      state.game.setArrows(node.id, [...kept, ...incoming]);
      emitAnnotations();
    },

    setHighlights(list) {
      state.game.setHighlights(state.game.current.id, list || []);
      emitAnnotations();
    },

    /** Defaults to arrows and highlights. */
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

    setNote(text) {
      const node = state.game.current;
      state.game.setNote(node.id, text);
      emitAnnotations();
      emit('game:change', { game: state.game, current: node, reason: 'note' });
    },

    setNag(nag) {
      const node = state.game.current;
      state.game.setNag(node.id, nag);
      emitAnnotations();
      emit('game:change', { game: state.game, current: node, reason: 'note' });
    },

    setStudyNotes(text) {
      state.study.notes = typeof text === 'string' ? text : '';
      emit('study:change', { study: state.study });
      scheduleAutosave();
    },

    setStudyTitle(text) {
      state.study.title = typeof text === 'string' ? text : '';
      emit('study:change', { study: state.study });
      scheduleAutosave();
    },

    // Settings

    /** Set by dotted path, persist, emit settings:change. */
    setSetting(path, value) {
      if (typeof path !== 'string' || !path) return;

      const v = path === 'quality' ? normalizeQuality(value) : clone(value);
      setPath(state.settings, path, v);
      saveSettings();
      emit('settings:change', { path, value: v, settings: state.settings });

      // The mirrors follow whatever path was written, whole blob or leaf.
      syncFromSettings();
    },

    /** One settings:change per top-level key. */
    resetSettings() {
      state.settings = defaultSettings();
      storageRemove(storage, STORAGE_KEYS.settings);

      for (const key of Object.keys(state.settings)) {
        emit('settings:change', { path: key, value: state.settings[key], settings: state.settings });
      }

      syncFromSettings();
    },

    // Engine

    engineStatus(patch) {
      Object.assign(state.engine, patch || {});
      emit('engine:update', { engine: state.engine });
    },

    /** Lines in White's view; the top line becomes the node's eval, never at a lower depth. */
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

            // Evals are persisted like annotations; the debounce absorbs a stream.
            scheduleAutosave();
          }
        }
      }

      emit('engine:update', { engine: e });
    },

    /** null is analysis only. */
    engineSetPlayAs(color) {
      state.engine.playAs = color === 'white' || color === 'black' ? color : null;
      emit('engine:update', { engine: state.engine });
    },

    // AI

    /** Append { role, text, at }. */
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

    aiBusy(bool) {
      state.ai.busy = !!bool;
      emit('ai:update', { ai: state.ai });
    },

    /** Also clears busy. */
    aiError(text) {
      state.ai.lastError = text ? String(text) : null;
      state.ai.busy = false;
      emit('ai:update', { ai: state.ai });
    },

    aiClear() {
      state.ai.messages = [];
      state.ai.lastError = null;
      emit('ai:update', { ai: state.ai });
    },

    // UI

    setPanel(name) {
      if (!PANELS.has(name) || state.ui.panel === name) return;

      state.ui.panel = name;
      emit('ui:change', { ui: state.ui });
    },

    toggleCollapsed() {
      state.ui.collapsed = !state.ui.collapsed;
      emit('ui:change', { ui: state.ui });
    },

    // Persistence

    /** Write the study now; also runs debounced after every game change. */
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

    /** True when something was restored. */
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

export const store = createStore();
export const actions = store.actions;
