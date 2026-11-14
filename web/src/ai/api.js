import { buildContext, buildPacket, formatEval, formatHistory, legalSanList, isSquare } from './packet.js';
import { applyAnnotation, rejectedEntries, withNodeTarget, VALID_NAGS } from './chat.js';
import { createMcpBridge, MCP_URL } from './mcpBridge.js';
import { studyToYaml } from '../core/io.js';

export const API_VERSION = '1.0';

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/i;
const PRESETS = ['white', 'black', 'top', 'side', 'free'];
const ROLES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

const HELP = [
  'window.chess - drive the 3D chessboard. Squares are a1..h8; colours are green | red | blue | yellow.',
  'Every call returns a value, or { ok:false, error } - nothing throws.',
  'Read:   getState() getPacket({includeEngine, includeLegalMoves}) getFen() getPgn() getYaml() getLegalMoves() status() history() eval()',
  "Play:   move('Nf3' | 'g1f3' | {from,to,promotion}) moves(['e4','e5'] | 'e4 e5') goto(ply | nodeId) back() forward() toStart() toEnd()",
  'Load:   setFen(fen) loadPgn(text) loadYaml(text) newGame() chess960(n?) -> { number, fen }',
  "Draw:   arrow(from, to, color) arrows([...]) highlight(square, color) highlights([...]) annotate({arrows, highlights, note, nag}) clearAnnotations()",
  'Notes:  note(text) noteAt(ply | nodeId, text) studyNotes(text) title(text)',
  "Engine: engine.start() engine.stop() engine.lines() engine.playAs('white' | 'black' | null)",
  "View:   view.preset('white' | 'black' | 'top' | 'side' | 'free') view.flip() view.focus('e4')",
  "Setup:  setup.mode(true | false) setup.place('e4', 'wP' | null) setup.turn('white') setup.castling('KQkq') setup.clear() setup.start() setup.commit()",
  'AI:     ask(question) -> Promise<{ ok, reply }> using the provider chosen in Settings',
  'MCP:    mcp.enable() mcp.disable() mcp.status() - opt-in bridge to a separate MCP bridge server on 127.0.0.1:8152 (not shipped)',
  'Events: on(event, fn) -> unsubscribe; events: game:change position:change annotations:change selection:change engine:update ai:update settings:change',
  'Start with getPacket() - it is the same text the AI panel sends.',
].join('\n');

function fail(e) {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

function guard(fn) {
  return function guarded(...args) {
    try {
      return fn.apply(this, args);
    } catch (e) {
      return fail(e);
    }
  };
}

function guardAsync(fn) {
  return async function guarded(...args) {
    try {
      return await fn.apply(this, args);
    } catch (e) {
      return fail(e);
    }
  };
}

function cleanMove(s) {
  return String(s == null ? '' : s).trim().replace(/^\d+\.(\.\.)?\s*/, '').replace(/^\.\.\.\s*/, '').replace(/[!?]+$/, '');
}

function need(x, name) {
  if (!x) throw new Error(name + ' is not available');
  return x;
}

// core's load actions return false (and toast) on unreadable input; undefined is success.
function loaded(result, what) {
  if (result === false) throw new Error(`${what} was rejected (see the toast for the reason)`);
  return true;
}

function pieceFromCode(code) {
  if (code == null || code === '') return null;

  if (typeof code === 'object') {
    if (code.color && code.role) return { color: String(code.color), role: String(code.role) };
    throw new Error('a piece needs { color, role }');
  }

  const s = String(code).trim();

  let m = /^([wb])([pnbrqk])$/i.exec(s);
  if (m) return { color: m[1].toLowerCase() === 'w' ? 'white' : 'black', role: ROLES[m[2].toLowerCase()] };

  if (/^[pnbrqkPNBRQK]$/.test(s)) return { color: s === s.toUpperCase() ? 'white' : 'black', role: ROLES[s.toLowerCase()] };

  m = /^(white|black)\s+(pawn|knight|bishop|rook|queen|king)$/i.exec(s);
  if (m) return { color: m[1].toLowerCase(), role: m[2].toLowerCase() };

  throw new Error(`cannot read piece "${code}" (use wP, bK, or { color, role })`);
}

/** The window.chess object, not installed (tests, or a second board). */
export function createApi({ store, actions, engine, ai, view, board, layer, mcp } = {}) {
  need(store, 'store');
  need(actions, 'actions');

  // Built on first use, so a page that never asks for MCP has no bridge at all.
  let bridge = mcp || null;
  const mcpBridge = () => (bridge || (bridge = createMcpBridge(store, actions, {})));

  const st = () => store.state;
  const game = () => st().game;
  const aiSettings = () => (st().settings && st().settings.ai) || {};

  function okPos() {
    const g = game();
    return { ok: true, fen: g.fen(), ply: g.current ? g.current.ply : 0, turn: g.turn() };
  }

  function okNode(node) {
    return { ok: true, san: node.san, uci: node.uci, fen: node.fen, ply: node.ply, id: node.id };
  }

  function playOne(input) {
    if (input && typeof input === 'object') {
      const move = { from: input.from, to: input.to };
      if (input.promotion) move.promotion = input.promotion;

      const node = actions.playMove(move);
      return node ? okNode(node) : fail(`illegal move: ${move.from}${move.to}`);
    }

    const s = cleanMove(input);
    if (!s) return fail('empty move');

    if (UCI_RE.test(s)) {
      const m = game().uciToMove(s.toLowerCase());
      if (!m) return fail('cannot parse uci move: ' + s);

      const node = actions.playMove(m);
      return node ? okNode(node) : fail(`illegal move: ${s} (${game().turn()} to move)`);
    }

    const node = actions.playSan(s);
    return node ? okNode(node) : fail(`illegal or unknown move: ${s} (${game().turn()} to move)`);
  }

  function resolveNode(ref) {
    const g = game();

    if (typeof ref === 'number' && Number.isFinite(ref)) {
      const n = Math.trunc(ref);
      const inPath = g.path().find(x => x.ply === n);
      if (inPath) return inPath;
      return g.mainline().find(x => x.ply === n) || null;
    }

    if (typeof ref === 'string') {
      if (/^\d+$/.test(ref.trim())) return resolveNode(Number(ref));
      return g.node(ref) || null;
    }

    return null;
  }

  // core only has note/nag actions for the current node, so visit the target and come back.
  function withNode(ref, fn) {
    const target = resolveNode(ref);
    if (!target) return fail('no node for ' + String(ref));
    return withNodeTarget(store, actions, target, fn);
  }

  const count = x => (x == null ? 0 : (Array.isArray(x) ? x.length : 1));

  function describeRejected(r) {
    const parts = [];
    if (r.arrows.length) parts.push(`${r.arrows.length} arrow${r.arrows.length > 1 ? 's' : ''}`);
    if (r.highlights.length) parts.push(`${r.highlights.length} highlight${r.highlights.length > 1 ? 's' : ''}`);
    if (r.nag != null) parts.push(`nag "${String(r.nag).trim()}"`);
    return parts.join(', ');
  }

  // Rejections are reported, or an AI would read ok:true and believe the drawing exists.
  function annotate(spec) {
    if (!spec || typeof spec !== 'object') return fail('annotate needs { arrows?, highlights?, note?, nag? }');

    const asked = count(spec.arrows) + count(spec.highlights)
      + (typeof spec.note === 'string' ? 1 : 0) + (typeof spec.nag === 'string' ? 1 : 0);
    if (!asked) return fail('annotate needs at least one of arrows, highlights, note, nag');

    const rejected = rejectedEntries(spec);
    const applied = applyAnnotation(spec, { store, actions, source: 'ai', clearEmpty: true });
    const total = applied.arrows + applied.highlights + (applied.note ? 1 : 0) + (applied.nag ? 1 : 0);

    if (!total) {
      const why = describeRejected(rejected);

      return {
        ok: false,
        error: why
          ? `nothing was applied: ${why} rejected (squares must be a1..h8, from and to must differ; nag one of ${VALID_NAGS.join(' ')})`
          : 'nothing was applied',
        applied,
        rejected,
      };
    }

    return rejected.count ? { ok: true, applied, rejected } : { ok: true, applied };
  }

  const api = {
    version: API_VERSION,
    help: () => HELP,

    getState: guard((opts) => buildContext(st(), opts || {})),
    getPacket: guard((opts) => buildPacket(st(), {
      includeEngine: aiSettings().includeEngine !== false,
      includeLegalMoves: !!aiSettings().includeLegalMoves,
      ...(opts || {}),
    })),
    getFen: guard(() => game().fen()),
    getPgn: guard(() => game().toPgn()),
    getYaml: guard(() => studyToYaml({ ...(st().study || {}), orientation: st().orientation, game: game() })),
    getLegalMoves: guard(() => legalSanList(game())),
    status: guard(() => game().status()),
    history: guard(() => formatHistory(game())),
    eval: guard(() => {
      const e = st().engine;
      return e && e.score ? formatEval(e.score) : null;
    }),

    move: guard(playOne),
    moves: guard((list) => {
      const items = typeof list === 'string' ? list.split(/\s+/) : (Array.isArray(list) ? list : [list]);
      const played = [];

      for (const it of items) {
        if (typeof it === 'string' && (!it.trim() || /^\d+\.+$/.test(it.trim()))) continue;

        const r = playOne(it);
        if (!r.ok) return { ok: false, error: r.error, played };
        played.push(r.san);
      }

      return { ok: true, played, fen: game().fen() };
    }),
    goto: guard((ref) => {
      const n = resolveNode(ref);
      if (!n) return fail('no node for ' + String(ref));

      actions.goto(n.id);
      return okPos();
    }),
    back: guard(() => {
      actions.back();
      return okPos();
    }),
    forward: guard(() => {
      actions.forward();
      return okPos();
    }),
    toStart: guard(() => {
      actions.toStart();
      return okPos();
    }),
    toEnd: guard(() => {
      actions.toEnd();
      return okPos();
    }),

    setFen: guard((fen) => {
      loaded(actions.loadFen(String(fen == null ? '' : fen).trim()), 'FEN');
      return okPos();
    }),
    loadPgn: guard((text) => {
      loaded(actions.loadPgn(String(text == null ? '' : text)), 'PGN');
      return okPos();
    }),
    loadYaml: guard((text) => {
      loaded(actions.loadYaml(String(text == null ? '' : text)), 'YAML');
      return okPos();
    }),
    newGame: guard(() => {
      actions.newGame();
      return okPos();
    }),
    chess960: guard((n) => {
      const number = actions.newChess960(n == null ? undefined : Number(n));
      return { ok: true, number, fen: game().fen() };
    }),

    arrow: guard((from, to, color = 'green') => annotate({ arrows: [{ from, to, color }] })),
    arrows: guard((list) => annotate({ arrows: list })),
    highlight: guard((square, color = 'green') => annotate({ highlights: [{ square, color }] })),
    highlights: guard((list) => annotate({ highlights: list })),
    clearAnnotations: guard((opts) => {
      actions.clearAnnotations(opts || { arrows: true, highlights: true, notes: false });
      return { ok: true };
    }),
    annotate: guard(annotate),

    note: guard((text) => {
      actions.setNote(String(text == null ? '' : text));
      return { ok: true };
    }),
    noteAt: guard((ref, text) => withNode(ref, () => {
      actions.setNote(String(text == null ? '' : text));
      return { ok: true };
    })),
    studyNotes: guard((text) => {
      actions.setStudyNotes(String(text == null ? '' : text));
      return { ok: true };
    }),
    title: guard((text) => {
      actions.setStudyTitle(String(text == null ? '' : text));
      return { ok: true };
    }),

    engine: {
      start: guard(() => {
        need(engine, 'engine').start();
        return { ok: true };
      }),
      stop: guard(() => {
        need(engine, 'engine').stop();
        return { ok: true };
      }),
      lines: guard(() => (st().engine && st().engine.lines) || []),
      playAs: guard((c) => {
        const color = c == null ? null : String(c);
        if (color !== null && color !== 'white' && color !== 'black') return fail("playAs needs 'white', 'black' or null");

        need(engine, 'engine').setPlayAs(color);
        return { ok: true, playAs: color };
      }),
    },

    view: {
      preset: guard((name) => {
        if (!PRESETS.includes(name)) return fail('preset must be one of ' + PRESETS.join(', '));

        need(view, 'view').setPreset(name);
        return { ok: true, preset: name };
      }),
      flip: guard(() => {
        actions.flip();
        return { ok: true, orientation: st().orientation };
      }),
      focus: guard((square) => {
        if (!isSquare(square)) return fail('focus needs a square like e4');

        const v = need(view, 'view');
        const mesh = layer && typeof layer.meshAt === 'function' ? layer.meshAt(square) : null;

        if (mesh) v.focusOn(mesh);
        else if (board && typeof board.worldFor === 'function') v.focusOn(board.worldFor(square));
        else return fail('nothing to focus on ' + square);

        return { ok: true, square, piece: !!mesh };
      }),
    },

    setup: {
      mode: guard((on) => {
        actions.setMode(on === false ? 'play' : 'setup');
        return { ok: true, mode: st().mode };
      }),
      place: guard((square, code) => {
        if (!isSquare(square)) return fail('place needs a square like e4');

        const piece = pieceFromCode(code);
        if (st().mode !== 'setup') actions.setMode('setup');
        actions.setupPlace(square, piece);
        return { ok: true, square, piece };
      }),
      turn: guard((color) => {
        if (color !== 'white' && color !== 'black') return fail("turn needs 'white' or 'black'");

        actions.setupTurn(color);
        return { ok: true, turn: color };
      }),
      castling: guard((s) => {
        actions.setupCastling(String(s == null ? '' : s));
        return { ok: true };
      }),
      clear: guard(() => {
        actions.setupClear();
        return { ok: true };
      }),
      start: guard(() => {
        actions.setupStart();
        return { ok: true };
      }),
      commit: guard(() => {
        actions.setupCommit();
        return okPos();
      }),
    },

    mcp: {
      enable: guard(() => mcpBridge().enable()),
      disable: guard(() => (bridge ? bridge.disable() : { enabled: false, connected: false, url: MCP_URL, state: 'off' })),
      status: guard(() => (bridge ? bridge.status() : { enabled: false, connected: false, url: MCP_URL, state: 'off' })),
      publish: guardAsync(() => mcpBridge().publish()),
    },

    // Pass chat.ask()'s own result through: state cannot tell "dropped because busy" from "answered nothing".
    ask: guardAsync(async (question) => {
      const r = await need(ai, 'ai').ask(question);
      if (!r || typeof r !== 'object') return { ok: false, error: 'the AI provider reported nothing' };

      return r.ok === false
        ? r
        : { ok: true, reply: r.reply === undefined ? null : r.reply, suggestedMoves: r.suggestedMoves || [], applied: r.applied || null, appliedTo: r.appliedTo || null };
    }),

    on: (event, fn) => store.on(event, fn),
  };

  return api;
}

/** Creates the API and installs it as window.chess. */
export function installApi(deps) {
  const api = createApi(deps);

  try {
    if (typeof window !== 'undefined') window.chess = api;
  } catch (_) {}

  return api;
}
