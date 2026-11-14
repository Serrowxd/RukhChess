// A small stand-in for the Rukh program's table, written on the page's own Game, for testing the page's remote
// mode without the program. It speaks the step-2 frame and intent shapes: node ids, from_node, goto, annotate
// (replace), new_game, match_start / match_stop / set_seats / set_style, board_rev and recent, and a computed
// match.live / match.to_move. It is not the program: no claim_seat, no wait, no validation beyond what the
// page's tests need. Not a test file itself (it holds no tests).
import { Game } from '../src/core/game.js';

const SEAT = new Set(['human', 'ai', 'engine']);
const STYLE = new Set(['silent', 'annotate', 'coach']);

export function createFakeTable({ instance = 'fake' } = {}) {
  let game = Game.standard();
  let ids = new WeakMap();
  let nextId = 0;
  const idOf = n => {
    if (!ids.has(n)) ids.set(n, nextId++);
    return ids.get(n);
  };
  idOf(game.root);
  let rev = 0;
  let boardRev = 0;
  let gameId = 1;
  const recent = [];
  const match = { active: false, seats: { white: 'human', black: 'human' }, tip: 0, style: 'annotate' };
  let hint = { reason: 'init', by: 'rukh' };

  function all() {
    const out = [];
    const stack = [game.root];
    while (stack.length) {
      const n = stack.pop();
      out.push(n);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
    return out;
  }
  const byId = id => all().find(n => idOf(n) === id) || null;
  const turnOf = n => (n.fen.split(' ')[1] === 'b' ? 'black' : 'white');

  function snapshot() {
    const nodes = all().map(n => ({
      id: idOf(n), parent: n.parentId ? idOf(game.node(n.parentId)) : null, children: n.children.map(idOf), ply: n.ply,
      san: n.san || null, uci: n.uci || null, fen: n.fen, check: false, checkmate: false, captured: null,
      note: n.note || '', nag: n.nag || '',
      arrows: (n.arrows || []).map(a => ({ from: a.from, to: a.to, color: a.color, knight: false, ...(a.source ? { source: a.source } : {}) })),
      highlights: (n.highlights || []).map(h => ({ square: h.square, color: h.color })),
      eval: null,
    }));
    nodes.sort((a, b) => a.id - b.id);
    const path = game.path().map(idOf);
    return {
      variant: game.variant, chess960_number: game.chess960Number, start_fen: game.startFen,
      fen: game.fen(), turn: game.turn(), ply: game.current.ply, current: idOf(game.current), path,
      status: { outcome: null, reason: 'playing' }, legal_moves: [], nodes,
    };
  }

  function matchBody() {
    const live = match.active && idOf(game.current) === match.tip;
    const tip = byId(match.tip);
    const toMove = live && tip ? match.seats[turnOf(tip)] : null;
    return { active: match.active, seats: { ...match.seats }, tip: match.tip, live, to_move: toMove, style: match.style, time_control: null };
  }

  function frame(nowMs = 0) {
    return {
      t: 'state', instance, rev, now_ms: nowMs, hint,
      state: {
        game_id: gameId, board_rev: boardRev, recent: recent.slice(), game: snapshot(),
        study: { title: '', notes: '' }, match: matchBody(), clock: null,
      },
    };
  }

  const fail = (code, message) => ({ ok: false, error: { code, message } });

  function changed(by, reason, boardChange, node, san) {
    rev++;
    hint = { reason, by };
    if (boardChange) {
      boardRev++;
      recent.push({ board_rev: boardRev, by, reason, node, ...(san ? { san } : {}) });
      while (recent.length > 16) recent.shift();
    }
  }

  /** Applies one intent ({ op, ... }) for `by` ("view:N" | "ai:name"). Returns { ok, result } or { ok:false, error }. */
  function apply(by, intent) {
    const isView = by.startsWith('view:');
    const op = intent && intent.op;
    if (op === 'play') {
      const target = !isView && match.active ? byId(match.tip) : game.current;
      if (!isView && match.active && match.seats[turnOf(target)] !== 'ai') return fail('not_your_turn', 'It is not your turn.');
      if (Number.isInteger(intent.from_node) && intent.from_node !== idOf(target)) {
        return fail('stale', `The board has moved on: the move would be played from node ${idOf(target)}, not node ${intent.from_node}.`);
      }
      const saved = game.current;
      game.goto(target.id);
      const mv = game.sanToMove(String(intent.move || '')) || game.uciToMove(String(intent.move || ''));
      let res = null;
      try { res = mv ? game.play(mv) : null; } catch (_) { res = null; }
      if (!res) {
        game.goto(saved.id);
        return fail('illegal', `illegal move: ${intent.move} is not a legal move here.`);
      }
      const node = game.current;
      if (typeof intent.note === 'string' && intent.note) game.setNote(node.id, intent.note);
      if (typeof intent.nag === 'string' && intent.nag) game.setNag(node.id, intent.nag);
      if (Array.isArray(intent.arrows)) game.setArrows(node.id, intent.arrows.map(a => ({ ...a, color: a.color || 'green', source: isView ? 'user' : 'ai' })));
      if (Array.isArray(intent.highlights)) game.setHighlights(node.id, intent.highlights.map(h => ({ ...h, color: h.color || 'green' })));
      if (match.active && idOf(target) === match.tip) match.tip = idOf(node);
      changed(by, 'move', true, idOf(node), node.san);
      return { ok: true, result: { node: idOf(node), san: node.san, uci: node.uci, fen: node.fen, board_rev: boardRev } };
    }
    if (op === 'goto' || op === 'back' || op === 'forward' || op === 'to_start' || op === 'to_end') {
      const before = game.current;
      if (op === 'goto') {
        const n = byId(intent.node);
        if (!n) return fail('bad_input', `no move with id ${intent.node} in this game`);
        game.goto(n.id);
      } else if (op === 'back') game.back();
      else if (op === 'forward') game.forward();
      else if (op === 'to_start') game.toStart();
      else game.toEnd();
      const live = match.active && idOf(game.current) === match.tip;
      if (game.current !== before) changed(by, 'navigate', isView, idOf(game.current));
      return { ok: true, result: { node: idOf(game.current), fen: game.fen(), turn: game.turn(), ply: game.current.ply, live } };
    }
    if (op === 'annotate') {
      const n = Number.isInteger(intent.node) ? byId(intent.node) : game.current;
      if (!n) return fail('bad_input', `no move with id ${intent.node} in this game`);
      if (intent.mode !== 'replace') return fail('bad_input', 'this stand-in only takes mode replace');
      const src = isView ? 'user' : 'ai';
      if (typeof intent.note === 'string') game.setNote(n.id, intent.note);
      if (typeof intent.nag === 'string') game.setNag(n.id, intent.nag);
      if (Array.isArray(intent.arrows)) game.setArrows(n.id, intent.arrows.map(a => ({ from: a.from, to: a.to, color: a.color || 'green', source: src })));
      if (Array.isArray(intent.highlights)) game.setHighlights(n.id, intent.highlights.map(h => ({ square: h.square, color: h.color || 'green' })));
      changed(by, 'annotate', isView, idOf(n));
      return { ok: true, result: { node: idOf(n), applied: {}, rejected: [], board_rev: boardRev } };
    }
    if (op === 'new_game') {
      game = intent.fen ? Game.fromFen(intent.fen) : Game.standard();
      ids = new WeakMap();
      nextId = 0;
      idOf(game.root);
      match.active = false;
      match.tip = 0;
      gameId++;
      changed(by, 'new_game', true, 0);
      return { ok: true, result: { node: 0, fen: game.fen(), turn: game.turn(), variant: game.variant, game_id: gameId } };
    }
    if (op === 'match_start') {
      const s = intent.seats || {};
      if (!SEAT.has(s.white) || !SEAT.has(s.black)) return fail('bad_input', 'the intent could not be read: seats');
      match.active = true;
      match.seats = { white: s.white, black: s.black };
      match.tip = idOf(game.current);
      if (typeof intent.style === 'string') match.style = STYLE.has(intent.style) ? intent.style : 'annotate';
      changed(by, 'match', false);
      return { ok: true, result: { match: matchBody() } };
    }
    if (op === 'match_stop') {
      if (match.active) { match.active = false; changed(by, 'match', false); }
      return { ok: true, result: { match: matchBody() } };
    }
    if (op === 'set_seats') {
      if (!SEAT.has(intent.white) || !SEAT.has(intent.black)) return fail('bad_input', 'the intent could not be read: seats');
      match.seats = { white: intent.white, black: intent.black };
      changed(by, 'seats', false);
      return { ok: true, result: { match: matchBody() } };
    }
    if (op === 'set_style') {
      match.style = STYLE.has(intent.style) ? intent.style : 'annotate';
      changed(by, 'style', false);
      return { ok: true, result: { style: { name: match.style, rule: '' }, match: matchBody() } };
    }
    return fail('bad_input', `the intent could not be read: unknown op ${op}`);
  }

  return {
    apply, frame, snapshot, matchBody,
    get rev() { return rev; },
    get boardRev() { return boardRev; },
    get game() { return game; },
    idOf, byId,
  };
}
