// The optional MCP bridge (src/ai/mcpBridge.js), with a stub fetch and timers that never fire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen, INITIAL_FEN } from 'chessops/fen';
import { parseSan, makeSan } from 'chessops/san';
import { makeUci, parseUci, makeSquare, parseSquare } from 'chessops/util';

import { createMcpBridge, MCP_URL, POLL_MS, MAX_BACKOFF_MS } from '../src/ai/mcpBridge.js';

const PROMO = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
const LETTER = { queen: 'q', rook: 'r', bishop: 'b', knight: 'n' };

/** Just enough Game for packet.js + the bridge: play, read, navigate one line. */
class MiniGame {
  constructor() {
    this.variant = 'standard';
    this.chess960Number = null;
    this.startFen = INITIAL_FEN;
    this.pos = Chess.fromSetup(parseFen(INITIAL_FEN).unwrap()).unwrap();
    this.root = { id: 'n0', ply: 0, san: null, uci: null, fen: INITIAL_FEN, children: [], arrows: [], highlights: [], note: '', nag: '', parentId: null };
    this.current = this.root;
    this._path = [this.root];
    this._n = 0;
  }

  fen() { return makeFen(this.pos.toSetup()); }

  turn() { return this.pos.turn; }

  pieces() { return []; }

  path() { return this._path.slice(); }

  mainline() { return this._path.slice(); }

  node(id) { return this._path.find(n => n.id === id) || null; }

  status() {
    return {
      check: this.pos.isCheck(), checkmate: this.pos.isCheckmate(), stalemate: this.pos.isStalemate(),
      insufficientMaterial: false, fiftyMoves: false, repetition: 0,
      outcome: this.pos.isCheckmate() ? (this.pos.turn === 'white' ? '0-1' : '1-0') : null, reason: '',
    };
  }

  legalMoves() {
    const out = [];
    for (const [from, targets] of this.pos.allDests()) {
      for (const to of targets) out.push({ from: makeSquare(from), to: makeSquare(to) });
    }
    return out;
  }

  moveToSan(m) {
    const mv = { from: parseSquare(m.from), to: parseSquare(m.to) };
    if (m.promotion) mv.promotion = PROMO[m.promotion];
    return makeSan(this.pos, mv);
  }

  uciToMove(uci) {
    const mv = parseUci(uci);
    if (!mv || !('from' in mv)) return null;

    const out = { from: makeSquare(mv.from), to: makeSquare(mv.to) };
    if (mv.promotion) out.promotion = LETTER[mv.promotion];
    return out;
  }

  sanToMove(san) {
    const mv = parseSan(this.pos, san);
    if (!mv || !('from' in mv)) return null;

    const out = { from: makeSquare(mv.from), to: makeSquare(mv.to) };
    if (mv.promotion) out.promotion = LETTER[mv.promotion];
    return out;
  }

  play(move) {
    const mv = { from: parseSquare(move.from), to: parseSquare(move.to) };
    if (move.promotion) mv.promotion = PROMO[move.promotion];
    if (!this.pos.isLegal(mv)) throw new Error('illegal move');

    const san = makeSan(this.pos, mv);
    this.pos.play(mv);

    const node = {
      id: 'n' + (++this._n), ply: this.current.ply + 1, san, uci: makeUci(mv), move,
      fen: this.fen(), children: [], arrows: [], highlights: [], note: '', nag: '', parentId: this.current.id,
    };
    this.current.children.push(node);
    this.current = node;
    this._path.push(node);
    return node;
  }
}

function makeStore() {
  const listeners = new Map();

  const store = {
    state: {
      game: new MiniGame(),
      study: { title: 'Test study', created: '2026-09-18', notes: '' },
      mode: 'play',
      orientation: 'white',
      viewMode: '3d',
      selected: null,
      legalTargets: [],
      engine: { lines: [], score: null, depth: 0 },
      ai: { provider: 'packet', busy: false, messages: [], lastError: null },
      selfPlay: { on: false, opponent: 'self', awaiting: null },
      clock: { running: false, white: 0, black: 0, turn: null, increment: 0, initial: 0, flagged: null },
      settings: { ai: { provider: 'packet', includeEngine: true, includeLegalMoves: false } },
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    off(event, fn) {
      const s = listeners.get(event);
      if (s) s.delete(fn);
    },
    emit(event, payload) { for (const fn of listeners.get(event) || []) fn(payload); },
    listenerCount(event) { return (listeners.get(event) || new Set()).size; },
  };

  const log = [];

  const actions = {
    playSan(san) {
      try {
        const m = store.state.game.sanToMove(san);
        return m ? store.state.game.play(m) : null;
      } catch (_) {
        return null;
      }
    },
    playMove(move) {
      try {
        return store.state.game.play(move);
      } catch (_) {
        return null;
      }
    },
    loadFen(fen) {
      try {
        const pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
        store.state.game.pos = pos;
        store.state.game.startFen = fen;
        return true;
      } catch (_) {
        return false;
      }
    },
    newGame() { store.state.game = new MiniGame(); },
    addArrows(arrows, source) {
      log.push(['addArrows', arrows, source]);
      store.state.game.current.arrows = arrows;
    },
    setHighlights(list) {
      log.push(['setHighlights', list]);
      store.state.game.current.highlights = list;
    },
    setNote(text) {
      log.push(['setNote', text]);
      store.state.game.current.note = text;
    },
    setNag(nag) {
      log.push(['setNag', nag]);
      store.state.game.current.nag = nag;
    },
    goto(id) { log.push(['goto', id]); },
    back() { log.push(['back']); },
    forward() { log.push(['forward']); },
    toast(text, kind) { log.push(['toast', text, kind]); },
  };

  return { store, actions, log };
}

/** Records every call; `route(path, method, body)` returns the JSON body, or throws to act as a dead server. */
function makeFetch(route) {
  const calls = [];

  const fn = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const path = String(url).slice(MCP_URL.length);

    let body = null;
    try {
      body = init.body ? JSON.parse(init.body) : null;
    } catch (_) {
      body = init.body;
    }

    calls.push({ url: String(url), path, method, body });
    const out = await route(path, method, body);
    return { ok: true, status: 200, json: async () => out };
  };

  return { fn, calls };
}

const frozenTimers = { setTimer: () => 1, clearTimer: () => {} };

function bridgeWith(route, extra = {}) {
  const { store, actions, log } = makeStore();
  const f = makeFetch(route);
  const bridge = createMcpBridge(store, actions, { fetch: f.fn, ...frozenTimers, ...extra });
  return { store, actions, log, bridge, calls: f.calls };
}

const emptyCommands = async (path) => (path.startsWith('/commands') ? { ok: true, commands: [], seq: 0 } : { ok: true, since: 0 });

test('disabled: no listeners, no fetch, status off', async () => {
  const { store, bridge, calls } = bridgeWith(emptyCommands);
  assert.equal(store.listenerCount('position:change'), 0);

  store.emit('position:change', { fen: 'x' });
  store.emit('selfplay:change', { selfPlay: {} });
  const r = await bridge.poll();
  const p = await bridge.publish();

  assert.equal(calls.length, 0, 'a disabled bridge must not touch the network');
  assert.equal(r.ok, false);
  assert.equal(p.ok, false);

  const s = bridge.status();
  assert.equal(s.enabled, false);
  assert.equal(s.state, 'off');
  assert.equal(s.url, MCP_URL);
});

test('enable publishes the position, disable stops everything', async () => {
  const { store, bridge, calls } = bridgeWith(emptyCommands);

  bridge.enable();
  await new Promise(r => setImmediate(r));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/state');
  assert.equal(calls[0].body.fen, INITIAL_FEN);
  assert.equal(calls[0].body.turn, 'white');
  assert.ok(calls[0].body.packet.startsWith('== Chessboard =='));
  assert.ok(calls[0].body.legal_moves.includes('e4'), 'the page publishes the legal moves');
  assert.equal(calls[0].body.awaiting, null);
  assert.equal(store.listenerCount('position:change'), 1);

  const s = bridge.status();
  assert.equal(s.enabled, true);
  assert.equal(s.connected, true);
  assert.equal(s.state, 'live');

  bridge.disable();
  assert.equal(store.listenerCount('position:change'), 0, 'disable unsubscribes');

  store.emit('position:change', { fen: 'x' });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1, 'nothing is fetched after disable');
  assert.equal(bridge.status().state, 'off');
});

test('publishes on position:change', async () => {
  const { store, bridge, calls } = bridgeWith(emptyCommands);
  bridge.enable();
  await new Promise(r => setImmediate(r));
  const before = calls.length;

  store.state.game.play(store.state.game.sanToMove('e4'));
  store.emit('position:change', { fen: store.state.game.fen(), turn: 'black' });
  await new Promise(r => setImmediate(r));

  assert.equal(calls.length, before + 1);
  const last = calls[calls.length - 1];
  assert.equal(last.path, '/state');
  assert.equal(last.body.turn, 'black');
  assert.equal(last.body.last_move.san, 'e4');

  bridge.disable();
});

test('applies a queued play command and acks it', async () => {
  let served = false;
  const { store, bridge, calls } = bridgeWith(async (path, method) => {
    if (path.startsWith('/commands')) {
      if (served) return { ok: true, commands: [], seq: 1 };
      served = true;
      return { ok: true, commands: [{ seq: 1, op: 'play', args: { move: 'e4' } }], seq: 1 };
    }

    if (path === '/ack') return { ok: true, acked: [] };
    return { ok: true, since: 1 };
  });
  bridge.enable();
  await new Promise(r => setImmediate(r));

  const out = await bridge.poll();
  assert.equal(out.ok, true);
  assert.equal(out.applied, 1);
  assert.equal(store.state.game.current.san, 'e4', 'the move reached the board');

  const ack = calls.find(c => c.path === '/ack');
  assert.ok(ack, 'the bridge acks what it applied');
  assert.equal(ack.body.acks.length, 1);
  assert.equal(ack.body.acks[0].seq, 1);
  assert.equal(ack.body.acks[0].ok, true);
  assert.equal(ack.body.acks[0].result.san, 'e4');
  assert.equal(ack.body.acks[0].result.turn, 'black');
  assert.equal(bridge.status().since, 1);

  // A second poll must not replay it.
  const again = await bridge.poll();
  assert.equal(again.applied, 0);

  bridge.disable();
});

test('applies annotate, set_fen and new_game; refuses illegal and unknown commands', async () => {
  const { store, actions, log, bridge } = bridgeWith(emptyCommands);
  bridge.enable();
  await new Promise(r => setImmediate(r));

  const ann = bridge.applyCommand({ seq: 1, op: 'annotate', args: { arrows: [{ from: 'g1', to: 'f3', color: 'green' }], highlights: [{ square: 'd5', color: 'red' }], note: 'develop' } });
  assert.equal(ann.ok, true);
  assert.deepEqual(ann.result.applied, { arrows: 1, highlights: 1, note: true, nag: false });
  assert.equal(log.find(l => l[0] === 'addArrows')[1][0].source, 'ai', 'MCP arrows are tagged ai');
  assert.equal(store.state.game.current.note, 'develop');

  const bad = bridge.applyCommand({ seq: 2, op: 'play', args: { move: 'Kz9' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /illegal move/);

  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  assert.equal(bridge.applyCommand({ op: 'set_fen', args: { fen } }).ok, true);
  assert.equal(bridge.applyCommand({ op: 'set_fen', args: { fen: 'not a fen' } }).ok, false);
  assert.equal(bridge.applyCommand({ op: 'new_game' }).ok, true);
  assert.equal(store.state.game.fen(), INITIAL_FEN);

  const unknown = bridge.applyCommand({ op: 'teleport' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown command/);

  // An action that throws is reported, never raised into the app.
  actions.newGame = () => { throw new Error('boom'); };
  const thrown = bridge.applyCommand({ op: 'new_game' });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.error, 'boom');

  bridge.disable();
});

test('a dead server never throws and backs off', async () => {
  const { store, bridge, calls } = bridgeWith(async () => { throw new Error('fetch failed'); });
  bridge.enable();
  await new Promise(r => setImmediate(r));

  let s = bridge.status();
  assert.equal(s.connected, false);
  assert.equal(s.state, 'offline');
  assert.match(s.lastError, /cannot reach http:\/\/127\.0\.0\.1:8152/);

  const first = s.delay;
  assert.ok(first > POLL_MS, 'the first failure already backs off');

  const r1 = await bridge.poll();
  assert.equal(r1.ok, false);
  const second = bridge.status().delay;
  assert.ok(second > first, `backoff grows (${first} -> ${second})`);

  for (let i = 0; i < 10; i++) await bridge.poll();
  const capped = bridge.status().delay;
  assert.equal(capped, MAX_BACKOFF_MS, 'backoff is capped');

  // Still no exception on the app's own path.
  store.emit('position:change', { fen: 'x' });
  await new Promise(r => setImmediate(r));
  assert.ok(calls.length > 2);
  assert.equal(bridge.status().enabled, true, 'a dead server does not disable the bridge');

  bridge.disable();
});

test('self-play: awaiting names the colour the AI must move', async () => {
  const { store, log, bridge, calls } = bridgeWith(emptyCommands);
  bridge.enable();
  await new Promise(r => setImmediate(r));

  store.state.selfPlay = { on: true, opponent: 'ai', awaiting: 'black' };
  store.emit('selfplay:change', { selfPlay: store.state.selfPlay });
  await new Promise(r => setImmediate(r));

  const last = calls.filter(c => c.path === '/state').pop();
  assert.equal(last.body.awaiting, 'black');
  assert.equal(last.body.opponent, 'ai');
  assert.equal(last.body.self_play, true);
  assert.equal(bridge.status().awaiting, 'black');
  assert.ok(log.some(l => l[0] === 'toast' && /AI to play black/.test(l[1])), 'the user is told the AI was asked');

  bridge.disable();
});

test('a restarted server rewinds the command cursor', async () => {
  let seq = 5;
  const { bridge } = bridgeWith(async (path) => {
    if (path.startsWith('/commands')) return { ok: true, commands: [], seq };
    return { ok: true, since: seq };
  });
  bridge.enable();
  await new Promise(r => setImmediate(r));
  await bridge.poll();
  bridge.applyCommand({ op: 'ping' });

  // The bridge's cursor has advanced, then the python process restarts at 0.
  const served = [{ seq: 1, op: 'ping', args: {} }];
  let first = true;
  const { bridge: b2, calls } = bridgeWith(async (path) => {
    if (path.startsWith('/commands')) {
      const since = Number(path.split('since=')[1]);

      if (first) {
        first = false;
        return { ok: true, commands: [], seq: 9, since };
      }

      return { ok: true, commands: served, seq: 1, since };
    }

    return { ok: true, since: 0 };
  });

  b2.enable();
  await new Promise(r => setImmediate(r));
  await b2.poll();
  const out = await b2.poll();

  assert.equal(out.applied, 1, 'commands from the restarted server are still seen');
  assert.ok(calls.some(c => c.path === '/ack'));

  b2.disable();
});

test('no fetch implementation is a status, not a crash', () => {
  const { store, actions } = makeStore();
  const bridge = createMcpBridge(store, actions, { fetch: null, ...frozenTimers });

  const s = bridge.enable();

  assert.equal(s.enabled, false);
  assert.match(s.lastError, /fetch is not available/);
  assert.equal(store.listenerCount('position:change'), 0);
});

// The style travels with the request.

test('the published payload carries a valid ai_style, whatever settings hold', async () => {
  const { store, bridge, calls } = bridgeWith(emptyCommands);
  bridge.enable();
  await new Promise(r => setImmediate(r));
  assert.equal(calls[0].body.ai_style, 'annotate', 'no setting at all -> the default style, never undefined');

  for (const [stored, want] of [
    ['silent', 'silent'], ['annotate', 'annotate'], ['coach', 'coach'],
    ['COACH', 'annotate'], ['', 'annotate'], [undefined, 'annotate'], [7, 'annotate'], [{}, 'annotate'],
  ]) {
    store.state.settings.selfPlay = { aiStyle: stored };
    const before = calls.length;

    await bridge.publish();

    assert.ok(calls.length > before, 'publish should have posted');
    assert.equal(calls[calls.length - 1].body.ai_style, want, `stored ${JSON.stringify(stored)}`);
  }
});

test('ai_style rides alongside awaiting, so one request says both who and what kind', async () => {
  const { store, bridge, calls } = bridgeWith(emptyCommands);
  store.state.settings.selfPlay = { aiStyle: 'coach' };
  store.state.selfPlay = { on: true, opponent: 'ai', awaiting: 'black' };

  bridge.enable();
  await new Promise(r => setImmediate(r));

  const body = calls[0].body;
  assert.equal(body.awaiting, 'black');
  assert.equal(body.opponent, 'ai');
  assert.equal(body.ai_style, 'coach');
});
