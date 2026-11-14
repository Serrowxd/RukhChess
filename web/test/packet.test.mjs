// test/packet.test.mjs - ai module tests: packet text, eval formatting, history with variations, knight-L marking,
// chess block extraction, annotation application, and the chat loop against a fake store.
// Uses a minimal fake Game (chessops only to derive fixture FENs / SAN, never core/) so it runs before core exists.
// Run from the app root:  node --test test/packet.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen, INITIAL_FEN } from 'chessops/fen';
import { parseSan, makeSan } from 'chessops/san';
import { makeUci, parseUci, parseSquare, makeSquare } from 'chessops/util';

import { buildPacket, buildContext, formatEval, formatHistory, legalSanList } from '../src/ai/packet.js';
import {
  extractChessBlock, stripChessBlock, applyAnnotation, createAi, normalizeArrow, normalizeHighlight,
  rejectedEntries, withNodeTarget, moveNumberOf,
} from '../src/ai/chat.js';
import { createApi } from '../src/ai/api.js';
import { SYSTEM_PROMPT } from '../src/ai/prompt.js';
import { providers, listProviders, MAX_TOKENS, MAX_TOKENS_STREAMING, ANTHROPIC_URL } from '../src/ai/providers.js';

const F = '```';
const PROMO = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
const LETTER = { queen: 'q', rook: 'r', bishop: 'b', knight: 'n' };

function toChessopsMove(m) {
  const mv = { from: parseSquare(m.from), to: parseSquare(m.to) };
  if (m.promotion) mv.promotion = PROMO[m.promotion];
  return mv;
}

function fromChessopsMove(mv) {
  const out = { from: makeSquare(mv.from), to: makeSquare(mv.to) };
  if (mv.promotion) out.promotion = LETTER[mv.promotion];
  return out;
}

/** Minimal Game per CONTRACT.md, enough for packet.js / chat.js. */
class FakeGame {
  static isKnightJump(from, to) {
    const dx = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
    const dy = Math.abs(Number(from[1]) - Number(to[1]));
    return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
  }

  constructor(startFen = INITIAL_FEN) {
    this.variant = 'standard';
    this.chess960Number = null;
    this.startFen = startFen;
    this.headers = new Map();
    this._n = 0;
    this._nodes = new Map();
    this.root = this._node(null, null, startFen, null, null);
    this.current = this.root;
  }

  _node(parent, san, fen, uci, move) {
    const id = 'n' + (this._n++);
    const node = {
      id, ply: parent ? parent.ply + 1 : 0, san, uci, move, fen,
      check: false, checkmate: false, captured: null, note: '', nag: '',
      arrows: [], highlights: [], eval: null, children: [], parentId: parent ? parent.id : null,
    };
    this._nodes.set(id, node);
    return node;
  }

  _pos(fen = this.current.fen) {
    return Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  }

  play(san) {
    const pos = this._pos();
    const mv = parseSan(pos, san);
    if (!mv) throw new Error('illegal move ' + san);
    const sanStr = makeSan(pos, mv);
    pos.play(mv);
    const fen = makeFen(pos.toSetup());
    const existing = this.current.children.find(c => c.san === sanStr);
    if (existing) { this.current = existing; return existing; }
    const node = this._node(this.current, sanStr, fen, makeUci(mv), fromChessopsMove(mv));
    this.current.children.push(node);
    this.current = node;
    return node;
  }

  goto(id) { this.current = this._nodes.get(id); return this.current; }
  node(id) { return this._nodes.get(id) || null; }
  fen() { return this.current.fen; }
  turn() { return this._pos().turn; }
  path() {
    const out = [];
    let n = this.current;
    while (n) { out.unshift(n); n = n.parentId ? this._nodes.get(n.parentId) : null; }
    return out;
  }
  mainline() {
    const out = [this.root];
    let n = this.root;
    while (n.children[0]) { n = n.children[0]; out.push(n); }
    return out;
  }
  isOnMainline(id) { return this.mainline().some(n => n.id === id); }
  pieces() {
    const pos = this._pos();
    const out = [];
    for (const sq of pos.board.occupied) out.push({ square: makeSquare(sq), piece: pos.board.get(sq) });
    return out;
  }
  pieceAt(square) { return this._pos().board.get(parseSquare(square)) || null; }
  status() {
    const pos = this._pos();
    const outcome = pos.outcome();
    return {
      check: pos.isCheck(), checkmate: pos.isCheckmate(), stalemate: pos.isStalemate(),
      insufficientMaterial: false, fiftyMoves: false, repetition: 0,
      outcome: outcome ? (outcome.winner ? (outcome.winner === 'white' ? '1-0' : '0-1') : '1/2-1/2') : null,
      reason: outcome ? (pos.isCheckmate() ? 'checkmate' : pos.isStalemate() ? 'stalemate' : 'draw') : '',
    };
  }
  legalMoves() {
    const pos = this._pos();
    const out = [];
    for (const [from, dests] of pos.allDests()) {
      const piece = pos.board.get(from);
      for (const to of dests) {
        const rank = Math.floor(to / 8);
        if (piece && piece.role === 'pawn' && (rank === 0 || rank === 7)) {
          for (const p of ['q', 'r', 'b', 'n']) out.push({ from: makeSquare(from), to: makeSquare(to), promotion: p });
        } else {
          out.push({ from: makeSquare(from), to: makeSquare(to) });
        }
      }
    }
    return out;
  }
  isLegal(m) { return this._pos().isLegal(toChessopsMove(m)); }
  moveToSan(m) {
    const pos = this._pos();
    const mv = toChessopsMove(m);
    return pos.isLegal(mv) ? makeSan(pos, mv) : null;
  }
  uciToMove(uci) {
    const mv = parseUci(uci);
    if (!mv || !('from' in mv)) return null;
    return fromChessopsMove(mv);
  }
  pvToSan(list) {
    const pos = this._pos();
    const out = [];
    for (const u of list) {
      const mv = parseUci(u);
      if (!mv || !pos.isLegal(mv)) break;
      out.push(makeSan(pos, mv));
      pos.play(mv);
    }
    return out;
  }
  toPgn() { return ''; }
}

function makeState(game, extra = {}) {
  return {
    game,
    study: { title: '', created: '2026-09-17', notes: '' },
    mode: 'play',
    setup: null,
    orientation: 'white',
    selected: null,
    legalTargets: [],
    engine: { available: true, enabled: false, thinking: false, depth: 0, nodes: 0, nps: 0, score: null, lines: [], bestMove: null, playAs: null },
    ai: { provider: 'packet', busy: false, messages: [], lastError: null },
    settings: {
      arrowColors: { green: '#15781B', red: '#882020', blue: '#003088', yellow: '#E68F00' },
      ai: { provider: 'packet', localUrl: 'http://127.0.0.1:8080/v1', localModel: '', anthropicModel: 'claude-sonnet-5', includeEngine: true, includeLegalMoves: false },
    },
    ui: { panel: 'ai', collapsed: false },
    ...extra,
  };
}

// 1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5) 3... a6  -> current = a6
function italianTree() {
  const g = new FakeGame();
  g.play('e4'); g.play('e5'); g.play('Nf3');
  const nc6 = g.play('Nc6');
  g.play('Bb5');
  const a6 = g.play('a6');
  g.goto(nc6.id);
  g.play('Bc4');
  const bc5 = g.play('Bc5');
  g.goto(a6.id);
  return { g, nc6, a6, bc5 };
}

const lines = (packet) => packet.split('\n');
const lineStarting = (packet, key) => lines(packet).find(l => l.startsWith(key));

test('packet: stable header lines on the main line', () => {
  const { g } = italianTree();
  const p = buildPacket(makeState(g));
  const L = lines(p);
  assert.equal(L[0], '== Chessboard ==');
  assert.equal(L[1], 'variant: standard');
  assert.equal(L[2], 'start_fen: ' + INITIAL_FEN);
  assert.equal(L[3], 'fen: ' + g.fen());
  assert.ok(g.fen().endsWith(' w KQkq - 0 4'));
  assert.equal(L[4], 'turn: white');
  assert.equal(L[5], 'move_number: 4  ply: 6  line: main');
  assert.equal(L[6], 'history: 1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5) 3... a6');
  assert.equal(L[7], 'last_move: a6 (a7a6)');
  assert.equal(L[8], 'status: playing');
  assert.equal(L.length, 9, 'empty sections are omitted:\n' + p);
});

test('packet: variation shows the branch point and the mainline in parentheses', () => {
  const { g, bc5 } = italianTree();
  g.goto(bc5.id);
  const p = buildPacket(makeState(g));
  assert.equal(lineStarting(p, 'move_number:'), 'move_number: 4  ply: 6  line: variation (branched at 3. Bc4)');
  assert.equal(lineStarting(p, 'history:'), 'history: 1. e4 e5 2. Nf3 Nc6 3. Bc4 (3. Bb5 a6) 3... Bc5');
  assert.equal(lineStarting(p, 'last_move:'), 'last_move: Bc5 (f8c5)');
  const ctx = buildContext(makeState(g));
  assert.equal(ctx.line, 'variation');
  assert.deepEqual(ctx.branched_at, { ply: 5, label: '3. Bc4' });
});

test('packet: root position prints history (none) and last_move none', () => {
  const g = new FakeGame();
  const p = buildPacket(makeState(g));
  assert.equal(lineStarting(p, 'history:'), 'history: (none)');
  assert.equal(lineStarting(p, 'last_move:'), 'last_move: none');
  assert.equal(lineStarting(p, 'move_number:'), 'move_number: 1  ply: 0  line: main');
});

test('packet: next line lists recorded continuations when stepping back', () => {
  const { g, nc6 } = italianTree();
  g.goto(nc6.id);
  const p = buildPacket(makeState(g));
  assert.equal(lineStarting(p, 'next:'), 'next: Bb5, Bc4');
  assert.equal(lineStarting(p, 'history:'), 'history: 1. e4 e5 2. Nf3 Nc6');
});

test('formatEval: White-view cp and mate formatting', () => {
  assert.equal(formatEval({ cp: 35 }), '+0.35');
  assert.equal(formatEval({ cp: -120 }), '-1.20');
  assert.equal(formatEval({ cp: 0 }), '0.00');
  assert.equal(formatEval({ mate: 3 }), '#3');
  assert.equal(formatEval({ mate: -2 }), '-#2');
  assert.equal(formatEval(null), '?');
});

test('packet: arrows mark knight jumps with (knight L), highlights and notes print, nag on its own line', () => {
  const { g, a6 } = italianTree();
  a6.arrows = [
    { from: 'f3', to: 'd4', color: 'green' },
    { from: 'e4', to: 'e5', color: 'red' },
    { from: 'b5', to: 'c6', color: 'blue', source: 'ai' },
  ];
  a6.highlights = [{ square: 'd5', color: 'red' }, { square: 'e5', color: 'green' }];
  a6.note = 'the "Spanish" bind';
  a6.nag = '!';
  const state = makeState(g);
  state.study.title = 'Ruy test';
  state.study.notes = 'study-level\nnotes';
  const p = buildPacket(state);
  assert.equal(lineStarting(p, 'title:'), 'title: Ruy test');
  assert.equal(lineStarting(p, 'arrows:'), 'arrows: f3->d4 green (knight L), e4->e5 red, b5->c6 blue [ai]');
  assert.equal(lineStarting(p, 'highlights:'), 'highlights: d5 red, e5 green');
  assert.equal(lineStarting(p, 'note:'), 'note: "the \\"Spanish\\" bind"');
  assert.equal(lineStarting(p, 'nag:'), 'nag: !');
  assert.equal(lineStarting(p, 'study_notes:'), 'study_notes: "study-level\\nnotes"');
  const ctx = buildContext(state);
  assert.equal(ctx.arrows[0].knight, true);
  assert.equal(ctx.arrows[1].knight, false);
  assert.equal(ctx.arrows[2].source, 'ai');
});

test('packet: engine section prints depth, eval, best and indented lines; omitted when disabled or stale', () => {
  const { g } = italianTree();
  const state = makeState(g);
  state.engine.lines = [
    { multipv: 1, score: { cp: 35 }, depth: 20, pv: ['b5a4', 'g8f6', 'e1g1'], san: [] },
    { multipv: 2, score: { mate: -2 }, depth: 20, pv: ['b5c6', 'd7c6'], san: ['Bxc6', 'dxc6'] },
  ];
  state.engine.score = { cp: 35 };
  state.engine.depth = 20;
  state.engine.bestMove = 'b5a4';
  const p = buildPacket(state);
  const L = lines(p);
  const i = L.findIndex(l => l.startsWith('engine:'));
  assert.equal(L[i], 'engine: depth 20  eval +0.35 (White)  best Ba4');
  assert.equal(L[i + 1], '  1) +0.35  Ba4 Nf6 O-O');
  assert.equal(L[i + 2], '  2) -#2  Bxc6 dxc6');
  assert.equal(L.length, i + 3);
  const ctx = buildContext(state);
  assert.equal(ctx.engine.best_san, 'Ba4');
  assert.equal(ctx.engine.lines[0].san, 'Ba4 Nf6 O-O');

  const off = buildPacket(state, { includeEngine: false });
  assert.equal(lineStarting(off, 'engine:'), undefined);

  state.engine.lines[0].pv = ['e2e4'];   // lines for a previous position -> not shown
  assert.equal(lineStarting(buildPacket(state), 'engine:'), undefined);
});

test('packet: stored node eval is used when there are no live lines', () => {
  const { g, a6 } = italianTree();
  a6.eval = { cp: -45, depth: 18, best: 'Ba4', pv: ['b5a4', 'g8f6'] };
  const p = buildPacket(makeState(g));
  assert.equal(lineStarting(p, 'engine:'), 'engine: depth 18  eval -0.45 (White)  best Ba4  [stored]');
  assert.equal(lines(p).find(l => l.startsWith('  1)')), '  1) -0.45  Ba4 Nf6');
});

test('packet: legal_moves only when requested, chess960 label', () => {
  const { g } = italianTree();
  const state = makeState(g);
  const p = buildPacket(state, { includeLegalMoves: true });
  const lm = lineStarting(p, 'legal_moves:');
  assert.ok(lm, 'legal_moves line present');
  const moves = lm.slice('legal_moves: '.length).split(', ');
  for (const s of ['Ba4', 'O-O', 'Bxc6', 'd4']) assert.ok(moves.includes(s), s + ' in legal moves');
  assert.equal(new Set(moves).size, moves.length, 'no duplicate SAN');
  assert.deepEqual(legalSanList(g), moves);
  assert.equal(lineStarting(buildPacket(state), 'legal_moves:'), undefined);

  g.variant = 'chess960';
  g.chess960Number = 518;
  assert.equal(lineStarting(buildPacket(state), 'variant:'), 'variant: chess960 #518');
});

test('packet: check and checkmate status', () => {
  const g = new FakeGame();
  for (const s of ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']) g.play(s);
  assert.equal(lineStarting(buildPacket(makeState(g)), 'status:'), 'status: checkmate (1-0)');
  const h = new FakeGame();
  for (const s of ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qe5+']) h.play(s);
  assert.equal(lineStarting(buildPacket(makeState(h)), 'status:'), 'status: check');
});

test('formatHistory: mid-game FEN root numbers moves from the FEN', () => {
  const g = new FakeGame('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  g.play('Bb5'); g.play('a6');
  assert.equal(formatHistory(g), '3. Bb5 a6');
  const b = new FakeGame('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 3 3');
  b.play('a6'); b.play('Ba4');
  assert.equal(formatHistory(b), '3... a6 4. Ba4');
});

test('extractChessBlock: parses the last fenced chess block, tolerates trailing commas, reports bad JSON', () => {
  const reply = [
    'Your knight belongs on d4.',
    F + 'chess',
    '{"arrows":[{"from":"f3","to":"d4","color":"green"}],"highlights":[{"square":"d5","color":"red"}],"note":"pressure on e5","nag":"!","moves":["Nd4","Nxd4"]}',
    F,
  ].join('\n');
  const b = extractChessBlock(reply);
  assert.equal(b.error, undefined);
  assert.deepEqual(b.arrows, [{ from: 'f3', to: 'd4', color: 'green' }]);
  assert.deepEqual(b.highlights, [{ square: 'd5', color: 'red' }]);
  assert.equal(b.note, 'pressure on e5');
  assert.equal(b.nag, '!');
  assert.deepEqual(b.moves, ['Nd4', 'Nxd4']);
  assert.equal(stripChessBlock(reply), 'Your knight belongs on d4.');

  const two = 'first\n' + F + 'chess\n{"moves":["e4"]}\n' + F + '\nsecond\n' + F + 'chess\n{"moves":["d4"],}\n' + F;
  assert.deepEqual(extractChessBlock(two).moves, ['d4']);

  assert.equal(extractChessBlock('no block here, just ' + F + 'js\nx\n' + F), null);
  assert.equal(extractChessBlock(''), null);

  const bad = extractChessBlock(F + 'chess\n{not json\n' + F);
  assert.ok(bad && bad.error, 'error reported');

  const truncated = 'Play Nf3.\n' + F + 'chess\n{"moves":["Nf3"], "arrows":[]}';
  assert.deepEqual(extractChessBlock(truncated).moves, ['Nf3']);

  const messy = F + 'chess\n{"arrows":["g1f3","e2->e4 red","zz"],"highlights":["d5 red","x9"],"nag":"?!","moves":"1. e4 e5 2. Nf3"}\n' + F;
  const m = extractChessBlock(messy);
  assert.deepEqual(m.arrows, [{ from: 'g1', to: 'f3', color: 'green' }, { from: 'e2', to: 'e4', color: 'red' }]);
  assert.deepEqual(m.highlights, [{ square: 'd5', color: 'red' }]);
  assert.equal(m.nag, '?!');
  assert.deepEqual(m.moves, ['e4', 'e5', 'Nf3']);
});

test('normalizeArrow / normalizeHighlight reject bad input and default colours', () => {
  assert.deepEqual(normalizeArrow({ from: 'G1', to: 'f3', color: 'purple' }), { from: 'g1', to: 'f3', color: 'green' });
  assert.equal(normalizeArrow({ from: 'g1', to: 'g1' }), null);
  assert.equal(normalizeArrow('i9j9'), null);
  assert.deepEqual(normalizeHighlight('E5 blue'), { square: 'e5', color: 'blue' });
  assert.equal(normalizeHighlight({ square: 'z1' }), null);
});

function fakeStoreAndActions(game) {
  const state = makeState(game);
  const listeners = {};
  const store = {
    state,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return () => {}; },
    emit(ev, payload) { for (const fn of listeners[ev] || []) fn(payload); },
  };
  const calls = [];
  const actions = {
    goto(id) { calls.push(['goto', id]); game.goto(id); state.selected = null; },
    select(sq) { calls.push(['select', sq]); state.selected = sq; },
    addArrows(list, source) { calls.push(['addArrows', list, source]); game.current.arrows.push(...list); },
    setHighlights(list) { calls.push(['setHighlights', list]); game.current.highlights = list; },
    setNote(t) { calls.push(['setNote', t]); game.current.note = t; },
    setNag(t) { calls.push(['setNag', t]); game.current.nag = t; },
    aiMessage(m) { calls.push(['aiMessage', m]); state.ai.messages.push(m); },
    aiBusy(b) { calls.push(['aiBusy', b]); state.ai.busy = b; },
    aiError(t) { calls.push(['aiError', t]); state.ai.lastError = t; },
    toast(t, k) { calls.push(['toast', t, k]); },
    setSetting(p, v) { calls.push(['setSetting', p, v]); if (p === 'ai.provider') state.settings.ai.provider = v; },
    playSan(san) { calls.push(['playSan', san]); try { return game.play(san); } catch (_) { return null; } },
  };
  return { store, actions, calls, state };
}

test('applyAnnotation: arrows added with source, highlights merged by square, note and nag replaced', () => {
  const { g, a6 } = italianTree();
  a6.highlights = [{ square: 'd5', color: 'red' }, { square: 'f7', color: 'yellow' }];
  const { store, actions, calls } = fakeStoreAndActions(g);
  const applied = applyAnnotation(
    { arrows: [{ from: 'f3', to: 'd4' }], highlights: [{ square: 'd5', color: 'green' }, { square: 'e5', color: 'blue' }], note: 'hold the centre', nag: '!?' },
    { store, actions, source: 'ai' },
  );
  assert.deepEqual(applied, { arrows: 1, highlights: 2, note: true, nag: true });
  const add = calls.find(c => c[0] === 'addArrows');
  assert.deepEqual(add[1], [{ from: 'f3', to: 'd4', color: 'green', source: 'ai' }]);
  assert.equal(add[2], 'ai');
  assert.deepEqual(a6.highlights, [{ square: 'd5', color: 'green' }, { square: 'f7', color: 'yellow' }, { square: 'e5', color: 'blue' }]);
  assert.equal(a6.note, 'hold the centre');
  assert.equal(a6.nag, '!?');

  // an empty note does not clear unless asked to
  applyAnnotation({ note: '' }, { store, actions });
  assert.equal(a6.note, 'hold the centre');
  applyAnnotation({ note: '' }, { store, actions, clearEmpty: true });
  assert.equal(a6.note, '');
});

test('createAi: packet provider attaches the packet to the user turn; applyReply stores suggested moves and draws', async () => {
  const { g, a6 } = italianTree();
  const { store, actions, calls, state } = fakeStoreAndActions(g);
  const ai = createAi(store, actions);
  await ai.ask('What is the plan?');
  assert.equal(state.ai.messages.length, 1);
  const u = state.ai.messages[0];
  assert.equal(u.role, 'user');
  assert.equal(u.text, 'What is the plan?');
  assert.ok(u.packet.startsWith('== Chessboard =='));
  assert.ok(u.packet.includes('history: 1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5) 3... a6'));
  assert.equal(state.ai.busy, false);

  const reply = 'Retreat the bishop.\n' + F + 'chess\n{"arrows":[{"from":"b5","to":"a4","color":"blue"}],"note":"keep the pin","moves":["Ba4!","Nf6"]}\n' + F;
  const r = ai.applyReply(reply);
  assert.deepEqual(r.suggestedMoves, ['Ba4!', 'Nf6']);
  const a = state.ai.messages[1];
  assert.equal(a.role, 'assistant');
  assert.equal(a.text, reply);
  assert.equal(a.body, 'Retreat the bishop.');
  assert.deepEqual(a.suggestedMoves, ['Ba4!', 'Nf6']);
  assert.deepEqual(a.applied, { arrows: 1, highlights: 0, note: true, nag: false });
  assert.deepEqual(a6.arrows, [{ from: 'b5', to: 'a4', color: 'blue', source: 'ai' }]);
  assert.equal(a6.note, 'keep the pin');
  assert.deepEqual(ai.lastSuggestion(), { moves: ['Ba4!', 'Nf6'], index: 1 });

  const played = ai.playSuggested();
  assert.equal(played.ok, true);
  assert.equal(played.san, 'Ba4');
  assert.equal(g.current.san, 'Ba4');

  assert.deepEqual(ai.setProvider('local'), { ok: true, provider: 'local' });
  assert.equal(state.settings.ai.provider, 'local');
  assert.equal(state.ai.provider, 'local');
  assert.equal(ai.getProvider(), 'local');
  assert.equal(ai.setProvider('nope').ok, false);
  ai.dispose();
});

test('createAi: a missing Anthropic key fails cleanly without a network call', async () => {
  const { g } = italianTree();
  const { store, actions, state } = fakeStoreAndActions(g);
  state.settings.ai.provider = 'anthropic';
  const ai = createAi(store, actions);
  await ai.ask('hi');
  assert.equal(state.ai.messages.length, 0);
  assert.match(state.ai.lastError, /API key/);
  assert.equal(state.ai.busy, false);
});

test('providers: shapes and the manual packet provider', async () => {
  assert.deepEqual(listProviders().map(p => p.id), ['packet', 'local', 'anthropic']);
  assert.equal(providers.anthropic.needsKey, true);
  await assert.rejects(() => providers.packet.send({}), /manual provider/);
  assert.ok(SYSTEM_PROMPT.includes(F + 'chess'));
  assert.ok(SYSTEM_PROMPT.includes('"moves"'));
});

// ---------------------------------------------------------------------------
// Reviewed defects (2026-09-18): one test per fix.
// ---------------------------------------------------------------------------

test('extractChessBlock: falls back to a ```json / untagged block and tolerates // and /* */ comments', () => {
  // Small local models emit ```json despite the prompt; that used to apply nothing and say nothing.
  const jsonTagged = 'Develop.\n' + F + 'json\n{"arrows":[{"from":"g1","to":"f3"}],"moves":["Nf3"]}\n' + F;
  const j = extractChessBlock(jsonTagged);
  assert.deepEqual(j.arrows, [{ from: 'g1', to: 'f3', color: 'green' }]);
  assert.deepEqual(j.moves, ['Nf3']);
  assert.equal(j.tagged, false);
  assert.equal(stripChessBlock(jsonTagged), 'Develop.');

  const untagged = F + '\n{"note":"hold the centre"}\n' + F;
  assert.equal(extractChessBlock(untagged).note, 'hold the centre');

  // a fenced block that is not a chess block stays in the body and is not mistaken for one
  const other = 'see:\n' + F + 'json\n{"name":"x","port":8150}\n' + F;
  assert.equal(extractChessBlock(other), null);
  assert.equal(stripChessBlock(other), other.trim());

  // a tagged ```chess block always wins over a later json block
  const both = F + 'chess\n{"moves":["Nf3"]}\n' + F + '\n' + F + 'json\n{"moves":["d4"]}\n' + F;
  assert.deepEqual(extractChessBlock(both).moves, ['Nf3']);

  const commented = F + 'chess\n{\n  // recommend\n  "moves": ["Nf3"], /* and then */\n  "nag": "!"\n}\n' + F;
  const c = extractChessBlock(commented);
  assert.equal(c.error, undefined);
  assert.deepEqual(c.moves, ['Nf3']);
  assert.equal(c.nag, '!');

  // a "//" inside a string must survive the comment stripper
  const url = F + 'chess\n{"note":"see http://example.com/x"}\n' + F;
  assert.equal(extractChessBlock(url).note, 'see http://example.com/x');

  // entries the board cannot use are counted, so applyReply can say so instead of drawing nothing quietly
  const bad = F + 'chess\n{"arrows":[{"from":"z9","to":"f3"}],"nag":"!!!"}\n' + F;
  assert.equal(extractChessBlock(bad).dropped, 2);
});

test('rejectedEntries names what applyAnnotation would silently drop', () => {
  const r = rejectedEntries({ arrows: [{ from: 'g1', to: 'f3' }, { from: 'z9', to: 'f3' }], highlights: ['x9'], nag: '!!!' });
  assert.equal(r.count, 3);
  assert.equal(r.arrows.length, 1);
  assert.equal(r.highlights.length, 1);
  assert.equal(r.nag, '!!!');
  assert.deepEqual(rejectedEntries({ arrows: [{ from: 'g1', to: 'f3' }], nag: '!' }), { arrows: [], highlights: [], nag: null, count: 0 });
  assert.equal(rejectedEntries(null).count, 0);
});

test('moveNumberOf reads the move number from the node fen', () => {
  const { g, nc6 } = italianTree();
  assert.equal(moveNumberOf(g.root), 0);
  assert.equal(moveNumberOf(nc6), 2);
  assert.equal(moveNumberOf({ fen: 'nonsense' }), null);
});

test('withNodeTarget applies on another node and restores the node and the selection', () => {
  const { g, nc6, a6 } = italianTree();
  const { store, actions, state } = fakeStoreAndActions(g);
  state.selected = 'f1';
  const out = withNodeTarget(store, actions, nc6, (node) => {
    actions.setNote('about Nc6');
    return node.id;
  });
  assert.equal(out, nc6.id);
  assert.equal(nc6.note, 'about Nc6');
  assert.equal(a6.note, '');
  assert.equal(g.current.id, a6.id, 'came back to where we were');
  assert.equal(state.selected, 'f1', 'selection restored');
});

test('createAi: the reply lands on the node the packet described, not the node in view when it arrives', async () => {
  const { g, nc6, a6 } = italianTree();
  const { store, actions, state } = fakeStoreAndActions(g);
  state.settings.ai.provider = 'local';
  const ai = createAi(store, actions);

  let release;
  const gate = new Promise(r => { release = r; });
  globalThis.fetch = async () => {
    await gate;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'Keep the pin.\n' + F + 'chess\n{"arrows":[{"from":"b5","to":"a4"}],"note":"about a6","nag":"!"}\n' + F } }] }),
    };
  };
  const pending = ai.ask('plan?');
  await new Promise(r => setTimeout(r, 0));
  g.goto(nc6.id);                       // the user steps away while the model thinks
  release();
  const r = await pending;

  assert.equal(r.ok, true);
  assert.deepEqual(a6.arrows, [{ from: 'b5', to: 'a4', color: 'green', source: 'ai' }]);
  assert.equal(a6.note, 'about a6');
  assert.equal(a6.nag, '!');
  assert.deepEqual(nc6.arrows, [], 'nothing drawn on the position the user walked to');
  assert.equal(nc6.note, '');
  assert.equal(g.current.id, nc6.id, 'the user is left where they were');
  assert.equal(r.appliedTo.nodeId, a6.id);
  assert.equal(r.appliedTo.san, 'a6');
  assert.equal(r.appliedTo.move, 3);
  assert.equal(state.ai.messages.at(-1).appliedTo.san, 'a6');
  ai.dispose();
  delete globalThis.fetch;
});

test('createAi: a reply for a node that is gone draws nothing and says so', async () => {
  const { g, a6 } = italianTree();
  const { store, actions, calls, state } = fakeStoreAndActions(g);
  state.settings.ai.provider = 'local';
  const ai = createAi(store, actions);

  let release;
  const gate = new Promise(r => { release = r; });
  globalThis.fetch = async () => {
    await gate;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: F + 'chess\n{"arrows":[{"from":"b5","to":"a4"}],"note":"gone"}\n' + F } }] }) };
  };
  const pending = ai.ask('plan?');
  await new Promise(r => setTimeout(r, 0));
  g.goto(g.root.id);
  g._nodes.delete(a6.id);               // the branch the packet described was deleted / a new game started
  release();
  const r = await pending;

  assert.equal(r.applied, null, 'nothing applied');
  assert.deepEqual(g.root.arrows, []);
  assert.equal(g.root.note, '');
  assert.equal(state.ai.messages.at(-1).staleNode, true);
  const said = calls.filter(c => c[0] === 'toast').map(c => c[1]).join(' | ');
  assert.match(said, /no longer in the game/);
  ai.dispose();
  delete globalThis.fetch;
});

test('createAi: ask() reports its own outcome and clears a stale lastError', async () => {
  const { g } = italianTree();
  const { store, actions, state } = fakeStoreAndActions(g);
  state.settings.ai.provider = 'local';
  const ai = createAi(store, actions);

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const bad = await ai.ask('q1');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Could not reach/);
  assert.match(state.ai.lastError, /Could not reach/);

  let release;
  const gate = new Promise(r => { release = r; });
  globalThis.fetch = async () => { await gate; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok2' } }] }) }; };
  const inflight = ai.ask('q2');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(state.ai.lastError, null, 'a new ask clears the previous request error');

  const dropped = await ai.ask('q3');
  assert.deepEqual(
    { ok: dropped.ok, dropped: dropped.dropped },
    { ok: false, dropped: 'busy' },
    'a call dropped because the AI is busy is not a success, and not the old error either',
  );

  release();
  const good = await inflight;
  assert.equal(good.ok, true);
  assert.equal(good.reply, 'ok2');
  assert.equal(state.ai.lastError, null);
  ai.dispose();
  delete globalThis.fetch;
});

test('createAi: a cancelled question is not glued in front of the next packet', async () => {
  const { g } = italianTree();
  const { store, actions, state } = fakeStoreAndActions(g);
  state.settings.ai.provider = 'local';
  const ai = createAi(store, actions);

  globalThis.fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const cancelled = ai.ask('cancelled question');
  await new Promise(r => setTimeout(r, 0));
  ai.cancel();
  assert.equal((await cancelled).cancelled, true);

  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  };
  await ai.ask('real question');
  const sent = bodies[0].messages.at(-1).content;
  assert.ok(sent.startsWith('== Chessboard =='), 'the packet is the start of the last user message');
  assert.ok(!sent.includes('cancelled question'), 'the abandoned question is not re-asked');
  ai.dispose();
  delete globalThis.fetch;
});

test('window.chess.annotate reports entries the board rejected instead of a hollow ok:true', () => {
  const { g } = italianTree();
  const { store, actions, state } = fakeStoreAndActions(g);
  const api = createApi({ store, actions });

  assert.equal(api.arrow().ok, false);
  const zz = api.arrow('z9', 'f3');
  assert.equal(zz.ok, false);
  assert.equal(zz.rejected.arrows.length, 1);
  assert.match(zz.error, /rejected/);
  assert.equal(api.annotate({ nag: '!!!' }).ok, false);
  assert.match(api.annotate({}).error, /at least one of/);

  // a partly-valid spec still applies, and still names what it dropped
  const mixed = api.annotate({ arrows: [{ from: 'b5', to: 'a4' }, { from: 'z9', to: 'f3' }] });
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.applied, { arrows: 1, highlights: 0, note: false, nag: false });
  assert.equal(mixed.rejected.arrows.length, 1);
  assert.deepEqual(api.arrow('b5', 'c6', 'red'), { ok: true, applied: { arrows: 1, highlights: 0, note: false, nag: false } });
  assert.equal(state.ai.lastError, null);
});

test('window.chess.noteAt keeps the selection through the goto round trip', () => {
  const { g, nc6 } = italianTree();
  const { store, actions, state } = fakeStoreAndActions(g);
  const api = createApi({ store, actions });
  state.selected = 'f1';
  const before = g.current.id;
  assert.deepEqual(api.noteAt(4, 'after Nc6'), { ok: true });
  assert.equal(nc6.note, 'after Nc6');
  assert.equal(g.current.id, before);
  assert.equal(state.selected, 'f1');
  assert.equal(api.noteAt(99, 'nowhere').ok, false);
});

test('window.chess.ask passes the chat result through', async () => {
  const { g } = italianTree();
  const { store, actions, state } = fakeStoreAndActions(g);
  state.settings.ai.provider = 'local';
  const ai = createAi(store, actions);
  const api = createApi({ store, actions, ai });

  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'go\n' + F + 'chess\n{"moves":["Ba4"]}\n' + F } }] }) });
  const r = await api.ask('what now?');
  assert.equal(r.ok, true);
  assert.match(r.reply, /^go/);
  assert.deepEqual(r.suggestedMoves, ['Ba4']);

  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const bad = await api.ask('again');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Could not reach/);
  ai.dispose();
  delete globalThis.fetch;
});

test('anthropic: max_tokens is a real ceiling, not a cap the thinking budget eats', async () => {
  // claude-sonnet-5 thinks by default when `thinking` is omitted and those tokens count against max_tokens,
  // so a small cap truncates the reply - and the chess block, being last, is the first thing lost.
  assert.ok(MAX_TOKENS >= 16000, 'non-streaming default per the claude-api skill');
  assert.ok(MAX_TOKENS_STREAMING >= MAX_TOKENS);

  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' }) };
  };
  await providers.anthropic.send({ system: 's', messages: [{ role: 'user', content: 'q' }], model: 'claude-sonnet-5', apiKey: 'k' });
  assert.equal(sent[0].url, ANTHROPIC_URL);
  assert.equal(sent[0].body.max_tokens, MAX_TOKENS);
  assert.equal(sent[0].body.stream, false);
  delete globalThis.fetch;
});
