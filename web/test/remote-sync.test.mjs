// Tests for src/net/remoteSync.js: the pure parts (snapshot -> study, one-move-ahead, signatures, frame order,
// echo guard, outgoing intents) and the connection shell driven through an in-memory fake socket (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotToStudy, moveAhead, snapshotSignature, gameSignature, isNewerFrame, createEchoGuard,
  intentsForChange, mainlineMoves, cursorOf, probeRukh, startRemoteSync, enterRemoteMode,
} from '../src/net/remoteSync.js';
import { studyFromJSON } from '../src/core/io.js';
import { Game } from '../src/core/game.js';
import { createStore } from '../src/core/store.js';

// Written by rukh_core::Game::snapshot() (serde_json), trimmed to one legal move each.
// 1. e4, then e5 (note "a note", glyph !, a red ai arrow g1f3, a blue e5 highlight) and the variation c5,
//    which is current. e4 holds a stored evaluation.
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const AFTER_C5 = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const node = (id, parent, children, ply, san, uci, fen, extra = {}) => ({
  id, parent, children, ply, san, uci, fen, check: false, checkmate: false, captured: null,
  note: '', nag: '', arrows: [], highlights: [], eval: null, ...extra,
});
const status = { check: false, checkmate: false, stalemate: false, insufficient_material: false, fifty_moves: false, repetition: 1, outcome: null, reason: 'playing' };
const TREE = {
  variant: 'standard', chess960_number: null, start_fen: START, fen: AFTER_C5, turn: 'white', ply: 2, current: 3, path: [0, 1, 3], status,
  legal_moves: [{ san: 'a3', uci: 'a2a3', from: 'a2', to: 'a3', promotion: null }],
  nodes: [
    node(0, null, [1], 0, null, null, START),
    node(1, 0, [2, 3], 1, 'e4', 'e2e4', AFTER_E4, { eval: { cp: 30, depth: 12, pv: ['e7e5'], best: 'e5' } }),
    node(2, 1, [], 2, 'e5', 'e7e5', AFTER_E5, {
      note: 'a note', nag: '!', arrows: [{ from: 'g1', to: 'f3', color: 'red', knight: true, source: 'ai' }],
      highlights: [{ square: 'e5', color: 'blue' }],
    }),
    node(3, 1, [], 2, 'c5', 'c7c5', AFTER_C5),
  ],
};
// 2. Chess960 (rooks on b1/h1): O-O, which the Rust core writes king-to-rook (e1h1).
const C960_START = '1r2k2r/pppppppp/8/8/8/8/PPPPPPPP/1R2K2R w KQkq - 0 1';
const C960_AFTER = '1r2k2r/pppppppp/8/8/8/8/PPPPPPPP/1R3RK1 b kq - 1 1';
const C960 = {
  variant: 'chess960', chess960_number: null, start_fen: C960_START, fen: C960_AFTER, turn: 'black', ply: 1, current: 1, path: [0, 1], status,
  legal_moves: [{ san: 'a6', uci: 'a7a6', from: 'a7', to: 'a6', promotion: null }],
  nodes: [node(0, null, [1], 0, null, null, C960_START), node(1, 0, [], 1, 'O-O', 'e1h1', C960_AFTER)],
};

const clone = v => JSON.parse(JSON.stringify(v));
const loadSnapshot = snap => studyFromJSON(snapshotToStudy(snap)).game;

test('snapshotToStudy keeps moves, variation order, annotations, evals and the current node', () => {
  const study = snapshotToStudy(TREE, { title: 'T', notes: 'N', orientation: 'black' });
  assert.equal(study.title, 'T');
  assert.equal(study.notes, 'N');
  assert.equal(study.orientation, 'black');
  assert.deepEqual(study.cursor, [0, 1]);
  const game = studyFromJSON(study).game;
  assert.equal(game.warnings.length, 0);
  assert.equal(game.fen(), AFTER_C5);
  const e4 = game.root.children[0];
  assert.deepEqual(e4.children.map(c => c.san), ['e5', 'c5']);
  assert.equal(e4.eval.cp, 30);
  const e5 = e4.children[0];
  assert.equal(e5.note, 'a note');
  assert.equal(e5.nag, '!');
  assert.deepEqual(e5.arrows.map(a => [a.from, a.to, a.color, a.source]), [['g1', 'f3', 'red', 'ai']]);
  assert.deepEqual(e5.highlights, [{ square: 'e5', color: 'blue' }]);
});

test('every page FEN equals the program FEN for the same node', () => {
  for (const snap of [TREE, C960]) {
    const game = loadSnapshot(snap);
    const byFen = new Set(snap.nodes.map(n => n.fen));
    const stack = [game.root];
    while (stack.length) {
      const n = stack.pop();
      assert.ok(byFen.has(n.fen), `page FEN ${n.fen} is not in the snapshot`);
      stack.push(...n.children);
    }
  }
});

test('Chess960 castling written king-to-rook loads and replays on the page', () => {
  const game = loadSnapshot(C960);
  assert.equal(game.variant, 'chess960');
  assert.equal(game.fen(), C960_AFTER);
  const fresh = Game.fromFen(C960_START);
  const ahead = moveAhead(C960, fresh.fen());
  assert.deepEqual(ahead, { uci: 'e1h1', san: 'O-O' });
  fresh.play(ahead.uci);
  assert.equal(fresh.fen(), C960_AFTER);
});

test('signatures match after a load and differ on any visible change', () => {
  const game = loadSnapshot(TREE);
  assert.equal(gameSignature(game), snapshotSignature(TREE));
  game.setEval(game.current.id, { cp: 99, depth: 30, pv: [] });   // evaluations never force a reload
  assert.equal(gameSignature(game), snapshotSignature(TREE));
  game.back();
  assert.notEqual(gameSignature(game), snapshotSignature(TREE), 'another current node');
  game.forward();
  game.setNote(game.current.id, 'x');
  assert.notEqual(gameSignature(game), snapshotSignature(TREE), 'a note');
  const swapped = clone(TREE);
  swapped.nodes[1].children = [3, 2];
  assert.notEqual(snapshotSignature(swapped), snapshotSignature(TREE), 'variation order');
});

test('moveAhead: only a child of the shown position counts', () => {
  assert.deepEqual(moveAhead(TREE, AFTER_E4), { uci: 'c7c5', san: 'c5' });
  assert.equal(moveAhead(TREE, START), null);
  assert.equal(moveAhead(TREE, AFTER_C5), null);
  const atRoot = { ...clone(TREE), current: 0, path: [0] };
  assert.equal(moveAhead(atRoot, START), null);
  assert.equal(moveAhead({ nodes: [] }, START), null);
  assert.equal(moveAhead(null, START), null);
});

test('cursorOf follows the path through variations', () => {
  assert.deepEqual(cursorOf(TREE), [0, 1]);
  assert.deepEqual(cursorOf({ ...clone(TREE), current: 2, path: [0, 1, 2] }), [0, 0]);
});

test('snapshotToStudy refuses a frame with no game, readably', () => {
  assert.throws(() => snapshotToStudy({}), /no game/);
  assert.throws(() => snapshotToStudy({ nodes: [{ id: 'a', fen: START }] }), /numeric id/);
});

test('isNewerFrame: higher rev, or another program start', () => {
  assert.equal(isNewerFrame(null, { rev: 0, instance: 'a' }), true);
  assert.equal(isNewerFrame({ instance: 'a', rev: 4 }, { instance: 'a', rev: 5 }), true);
  assert.equal(isNewerFrame({ instance: 'a', rev: 4 }, { instance: 'a', rev: 4 }), false);
  assert.equal(isNewerFrame({ instance: 'a', rev: 4 }, { instance: 'a', rev: 3 }), false);
  assert.equal(isNewerFrame({ instance: 'a', rev: 4 }, { instance: 'b', rev: 1 }), true);
  assert.equal(isNewerFrame(null, { instance: 'a' }), false);
});

test('echo guard: active inside run, nested, and reset after a throw', () => {
  const g = createEchoGuard();
  assert.equal(g.active, false);
  g.run(() => {
    assert.equal(g.active, true);
    g.run(() => assert.equal(g.active, true));
    assert.equal(g.active, true);
  });
  assert.equal(g.active, false);
  assert.throws(() => g.run(() => { throw new Error('boom'); }));
  assert.equal(g.active, false);
});

test('intentsForChange: what a local change sends, and nothing for an echo', () => {
  const move = { san: 'Nf3', uci: 'g1f3' };
  assert.deepEqual(intentsForChange({ reason: 'move', move, fromFen: START }), [{ op: 'play', move: 'Nf3', from_fen: START }]);
  assert.deepEqual(intentsForChange({ reason: 'move', move, fromFen: START, echo: true }), []);
  assert.deepEqual(intentsForChange({ reason: 'new', startFen: START }), [{ op: 'new_game' }]);
  assert.deepEqual(intentsForChange({ reason: 'new', startFen: C960_START }), [{ op: 'new_game', fen: C960_START }]);
  assert.deepEqual(intentsForChange({ reason: 'setup', mode: 'setup', startFen: C960_START }), []);
  assert.deepEqual(intentsForChange({ reason: 'setup', mode: 'play', startFen: C960_START }), [{ op: 'new_game', fen: C960_START }]);
  for (const reason of ['goto', 'note', 'promote', 'delete']) assert.deepEqual(intentsForChange({ reason, fromFen: START }), []);
  const game = Game.standard();
  game.play('e2e4'); game.play('e7e5');
  assert.deepEqual(intentsForChange({ reason: 'load', startFen: START, mainline: mainlineMoves(game) }), [
    { op: 'new_game' },
    { op: 'play', move: 'e4', from_fen: START },
    { op: 'play', move: 'e5', from_fen: AFTER_E4 },
  ]);
});

test('probeRukh makes no request at all on file://', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return { ok: true, json: async () => ({ app: 'rukh' }) }; };
  assert.equal(await probeRukh({ location: { protocol: 'file:', href: 'file:///x/index.html' }, fetch }), null);
  assert.equal(calls, 0);
  const hello = await probeRukh({ location: { protocol: 'http:', href: 'http://127.0.0.1:1/' }, fetch });
  assert.equal(hello.app, 'rukh');
  assert.equal(calls, 1);
  const other = async () => ({ ok: true, json: async () => ({ app: 'other' }) });
  assert.equal(await probeRukh({ location: { protocol: 'http:', href: 'http://h/' }, fetch: other }), null);
  const broken = async () => { throw new Error('offline'); };
  assert.equal(await probeRukh({ location: { protocol: 'http:', href: 'http://h/' }, fetch: broken }), null);
});

// ── the shell, against an in-memory socket ──

class FakeSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeSocket.last = this;
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
  receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
}

function harness() {
  const st = createStore({ storage: null });
  const remote = startRemoteSync({
    store: st, actions: st.actions, location: { href: 'http://127.0.0.1:47480/' }, WebSocket: FakeSocket, ackTimeoutMs: 60000,
  });
  const ws = FakeSocket.last;
  ws.onopen();
  ws.receive({ t: 'hello', proto: 1, instance: 'i1', you: 'view:1' });
  const moves = [];
  st.on('game:change', p => moves.push(p));
  const done = () => { remote.stop(); st.dispose(); };
  return { st, ws, moves, done };
}

const frame = (rev, game) => ({ t: 'state', instance: 'i1', rev, hint: { reason: 'move', by: 'mcp' }, state: { game } });

test('shell: connects to api/ws on the page origin', () => {
  const h = harness();
  assert.equal(h.ws.url, 'ws://127.0.0.1:47480/api/ws');
  h.done();
});

test('shell: a frame one move ahead animates through playMove and is not echoed', () => {
  const h = harness();
  const game = clone(TREE);
  game.nodes = game.nodes.slice(0, 2).map(n => ({ ...n, children: n.id === 1 ? [] : n.children }));
  Object.assign(game, { current: 1, path: [0, 1], fen: AFTER_E4 });
  h.ws.receive(frame(1, game));
  assert.equal(h.st.state.game.fen(), AFTER_E4);
  assert.equal(h.moves.length, 1);
  assert.equal(h.moves[0].reason, 'move');
  assert.ok(h.moves[0].move, 'the move payload is there, so the piece animates');
  assert.equal(h.ws.sent.length, 0, 'nothing sent back');
  h.done();
});

test('shell: a frame that is not one move ahead reloads the study, without echo', () => {
  const h = harness();
  h.ws.receive(frame(1, TREE));
  assert.equal(h.st.state.game.fen(), AFTER_C5);
  assert.equal(h.moves.at(-1).reason, 'load');
  assert.equal(gameSignature(h.st.state.game), snapshotSignature(TREE));
  assert.equal(h.ws.sent.length, 0);
  h.ws.receive(frame(1, TREE));     // same rev again: ignored
  h.ws.receive(frame(2, TREE));     // same content: nothing to do
  assert.equal(h.moves.filter(m => m.reason === 'load').length, 1);
  h.done();
});

test('shell: a local move sends play with the FEN shown before it; a refusal reloads from the latest frame', () => {
  const h = harness();
  const start = clone(C960);
  start.nodes = [{ ...start.nodes[0], children: [] }];
  Object.assign(start, { current: 0, path: [0], fen: C960_START, variant: 'chess960' });
  h.ws.receive(frame(1, start));
  assert.equal(h.st.state.game.fen(), C960_START);
  h.st.actions.playMove('e1g1');    // castling as the page spells it
  assert.equal(h.ws.sent.length, 1);
  const sent = h.ws.sent[0];
  assert.deepEqual({ t: sent.t, op: sent.op, move: sent.move, from_fen: sent.from_fen }, { t: 'intent', op: 'play', move: 'O-O', from_fen: C960_START });
  // The program refuses it as stale: the page goes back to its latest frame.
  h.ws.receive({ t: 'ack', id: sent.id, ok: false, error: { code: 'stale', message: 'the board has moved on' } });
  assert.equal(h.st.state.game.fen(), C960_START);
  assert.equal(h.ws.sent.length, 1, 'the reload is not sent back');
  h.done();
});

test('shell: frames wait while an own intent is in flight, and the ack catches up without flicker', () => {
  const h = harness();
  const start = { ...clone(TREE), current: 0, path: [0], fen: START };
  start.nodes = [{ ...start.nodes[0], children: [] }];
  h.ws.receive(frame(1, start));
  h.st.actions.playMove('e2e4');
  h.st.actions.playMove('e7e5');
  assert.deepEqual(h.ws.sent.map(s => s.from_fen), [START, AFTER_E4]);
  const before = h.moves.length;
  const afterE4 = clone(TREE);
  afterE4.nodes = [afterE4.nodes[0], { ...afterE4.nodes[1], children: [], eval: null }];
  Object.assign(afterE4, { current: 1, path: [0, 1], fen: AFTER_E4 });
  h.ws.receive(frame(2, afterE4));
  h.ws.receive({ t: 'ack', id: h.ws.sent[0].id, ok: true, rev: 2 });
  assert.equal(h.moves.length, before, 'the page is not pulled back to e4 while e5 is in flight');
  const afterE5 = clone(TREE);
  afterE5.nodes = [afterE5.nodes[0], { ...afterE5.nodes[1], children: [2], eval: null }, { ...afterE5.nodes[2], note: '', nag: '', arrows: [], highlights: [] }];
  Object.assign(afterE5, { current: 2, path: [0, 1, 2], fen: AFTER_E5 });
  h.ws.receive(frame(3, afterE5));
  h.ws.receive({ t: 'ack', id: h.ws.sent[1].id, ok: true, rev: 3 });
  assert.equal(h.moves.length, before, 'already in step: nothing reloaded');
  assert.equal(h.st.state.game.fen(), AFTER_E5);
  h.done();
});

test('shell: two pages on one program do not ping-pong', () => {
  // A tiny in-memory program: applies play intents to a page-side Game and broadcasts a frame per change.
  const prog = Game.standard();
  let rev = 0;
  const pages = [];
  const snapshot = () => {
    const nodes = [];
    const ids = new Map();
    let next = 0;
    const walk = (n, parent) => {
      const id = next++;
      ids.set(n, id);
      const out = node(id, parent, [], n.ply, n.san, n.uci, n.fen);
      nodes.push(out);
      for (const c of n.children) out.children.push(walk(c, id));
      return id;
    };
    walk(prog.root, null);
    const path = prog.path().map(n => ids.get(n));
    return { variant: 'standard', chess960_number: null, start_fen: prog.startFen, fen: prog.fen(), current: path.at(-1), path, nodes };
  };
  const broadcast = () => { rev++; for (const p of pages) p.ws.receive(frame(rev, snapshot())); };
  for (let i = 0; i < 2; i++) pages.push(harness());
  let intents = 0;
  const pump = () => {
    for (const p of pages) {
      while (p.ws.sent.length) {
        const msg = p.ws.sent.shift();
        intents++;
        const ok = msg.from_fen === prog.fen();
        if (ok) { prog.play(prog.sanToMove(msg.move)); broadcast(); }
        p.ws.receive(ok ? { t: 'ack', id: msg.id, ok: true, rev } : { t: 'ack', id: msg.id, ok: false, error: { code: 'stale', message: 'stale' } });
      }
    }
  };
  broadcast();
  pages[0].st.actions.playMove('e2e4');
  pump();
  pages[1].st.actions.playMove('e7e5');
  pump();
  pump();
  assert.equal(intents, 2, 'one intent per hand move, none from applied frames');
  for (const p of pages) assert.equal(p.st.state.game.fen(), AFTER_E5);
  for (const p of pages) p.done();
});

test('enterRemoteMode switches off autosave, self-play, the clock and the old bridge', () => {
  const storage = new Map();
  const st = createStore({ storage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) } });
  let disabled = 0;
  const mcp = { disable() { disabled++; }, enable() { throw new Error('must not start'); }, status: () => ({ enabled: false }) };
  st.actions.startSelfPlay({ opponent: 'self', timeControl: { initial: 60000, increment: 0 } });
  enterRemoteMode({ store: st, actions: st.actions, mcp });
  assert.equal(st.state.selfPlay.on, false);
  assert.equal(st.actions.startSelfPlay({}), false);
  assert.equal(st.state.selfPlay.on, false);
  assert.equal(st.actions.clockStart(), false);
  assert.equal(st.state.clock.running, false);
  assert.equal(disabled, 1);
  assert.deepEqual(mcp.enable(), { enabled: false });
  storage.clear();
  st.actions.playMove('e2e4');
  assert.equal(st.actions.autosave(), false);
  assert.equal(storage.size, 0);
  st.dispose();
});

// ── fixes: fewer, truer messages; variant; a frame without a path ──

const startFrame = () => {
  const start = { ...clone(TREE), current: 0, path: [0], fen: START };
  start.nodes = [{ ...start.nodes[0], children: [] }];
  return start;
};
const e4Frame = () => {
  const g = clone(TREE);
  g.nodes = [g.nodes[0], { ...g.nodes[1], children: [], eval: null }];
  return Object.assign(g, { current: 1, path: [0, 1], fen: AFTER_E4 });
};
const catchToasts = h => {
  const toasts = [];
  h.st.actions.toast = (text, kind) => { toasts.push({ text, kind }); };
  return toasts;
};

test('shell: replaying the move the program is already on shows no stale message', () => {
  const h = harness();
  const toasts = catchToasts(h);
  h.ws.receive(frame(1, e4Frame()));
  assert.equal(h.st.state.game.fen(), AFTER_E4);
  h.st.actions.back();
  h.st.actions.playMove('e2e4');
  assert.equal(h.ws.sent.length, 1);
  h.ws.receive({ t: 'ack', id: h.ws.sent[0].id, ok: false, error: { code: 'stale', message: 'stale' } });
  assert.deepEqual(toasts, [], 'the page already shows the program\'s game');
  assert.equal(h.st.state.game.fen(), AFTER_E4);
  h.done();
});

test('shell: several refusals in one batch show one message', () => {
  const h = harness();
  const toasts = catchToasts(h);
  h.ws.receive(frame(1, startFrame()));
  h.st.actions.loadPgn('1. e4 e5 2. Nf3 Nc6');
  const sent = h.ws.sent.splice(0);
  assert.deepEqual(sent.map(s => s.op), ['new_game', 'play', 'play', 'play', 'play']);
  assert.equal(toasts.filter(t => t.kind === 'info').length, 1, 'one note that only the main line is shared');
  for (const s of sent) h.ws.receive({ t: 'ack', id: s.id, ok: false, error: { code: 'stale', message: 'moved on' } });
  assert.equal(toasts.filter(t => t.kind === 'error').length, 1);
  assert.equal(h.st.state.game.fen(), START, 'back on the program\'s game');
  h.done();
});

test('shell: a change made while disconnected is reported once, not once per intent', () => {
  const h = harness();
  const toasts = catchToasts(h);
  h.ws.receive(frame(1, startFrame()));
  h.ws.readyState = 3;
  h.st.actions.loadPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  assert.equal(h.ws.sent.length, 0);
  assert.equal(toasts.filter(t => t.kind === 'error').length, 1);
  h.done();
});

test('shell: a failed send is reported and the page goes back to the program\'s game', () => {
  const h = harness();
  const toasts = catchToasts(h);
  h.ws.receive(frame(1, startFrame()));
  h.ws.send = () => { throw new Error('gone'); };
  h.st.actions.playMove('e2e4');
  assert.equal(toasts.filter(t => t.kind === 'error').length, 1);
  assert.equal(h.st.state.game.fen(), START);
  h.done();
});

test('signatures tell a Chess960 #518 game from the standard game', () => {
  const g960 = Game.chess960(518);
  assert.equal(g960.fen(), START);
  assert.notEqual(gameSignature(g960), snapshotSignature(startFrame()));
  assert.equal(gameSignature(Game.standard()), snapshotSignature(startFrame()));
});

test('shell: starting Chess960 #518 ends on the variant the program holds', () => {
  const h = harness();
  h.ws.receive(frame(1, startFrame()));
  h.st.actions.newChess960(518);
  assert.deepEqual(h.ws.sent.map(s => s.op), ['new_game']);
  h.ws.receive(frame(2, startFrame()));
  h.ws.receive({ t: 'ack', id: h.ws.sent[0].id, ok: true, rev: 2 });
  assert.equal(h.st.state.game.variant, 'standard');
  h.done();
});

test('cursorOf rebuilds a missing or wrong path from the parent links', () => {
  const noPath = clone(TREE);
  delete noPath.path;
  assert.deepEqual(cursorOf(noPath), [0, 1]);
  assert.deepEqual(cursorOf({ ...clone(TREE), path: [0, 1] }), [0, 1]);
});
