// Step-2 parts of src/net/remoteSync.js, and the shell against the stand-in table in fake-table.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFrame, readMatch, readPresence, normalizeStyle, turnAt, nodeIdAt, pageNodeAt, intentsForChange, aiChip,
  seatsForChoice, choiceFromSeats, annotateIntent, sameAnnotations, startRemoteSync, gameSignature, snapshotSignature,
} from '../src/net/remoteSync.js';
import { createStore } from '../src/core/store.js';
import { Game } from '../src/core/game.js';
import { createFakeTable } from './fake-table.mjs';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const tick = () => new Promise(r => setImmediate(r));

// Pure.

test('readFrame: the step-2 body, and an older frame reads as the analysis board', () => {
  const t = createFakeTable();
  t.apply('view:1', { op: 'play', move: 'e4' });
  t.apply('view:1', { op: 'match_start', seats: { white: 'human', black: 'ai' }, style: 'coach' });

  const f = readFrame(t.frame());
  assert.equal(f.game.current, 1);
  assert.equal(f.boardRev, 1);
  assert.equal(f.gameId, 1);
  assert.deepEqual(f.recent.map(r => [r.by, r.reason, r.node, r.san]), [['view:1', 'move', 1, 'e4']]);
  assert.deepEqual(f.match, { active: true, seats: { white: 'human', black: 'ai' }, tip: 1, live: true, to_move: 'ai', style: 'coach' });

  const old = readFrame({ t: 'state', rev: 1, state: { game: t.snapshot() } });
  assert.deepEqual(old.match, { active: false, seats: { white: 'human', black: 'human' }, tip: 0, live: false, to_move: null, style: 'annotate' });
  assert.deepEqual(old.recent, []);

  assert.equal(readFrame(null).game, null);
});

test('readMatch and normalizeStyle: junk is filled in, unknown styles are annotate', () => {
  assert.deepEqual(readMatch({ active: 'yes', seats: { white: 'robot', black: 'engine' }, tip: 'x', to_move: 'ghost', style: ' COACH ' }),
    { active: false, seats: { white: 'human', black: 'engine' }, tip: 0, live: false, to_move: null, style: 'coach' });

  for (const [v, want] of [['silent', 'silent'], ['Annotate', 'annotate'], ['loud', 'annotate'], [null, 'annotate'], [3, 'annotate']]) {
    assert.equal(normalizeStyle(v), want);
  }
});

test('readPresence keeps the fields the chip needs and drops junk entries', () => {
  const p = readPresence({ t: 'presence', views: 2, ais: [{ name: 'claude-code', transport: 'http', seat: 'black', waiting: true, idle_s: 3 }, 'x', { name: '', seat: 'red' }] });

  assert.equal(p.views, 2);
  assert.deepEqual(p.ais, [
    { name: 'claude-code', transport: 'http', seat: 'black', waiting: true, idle_s: 3 },
    { name: 'An AI', transport: '', seat: null, waiting: false, idle_s: 0 },
  ]);
  assert.deepEqual(readPresence(undefined), { views: 0, ais: [] });
});

test('nodeIdAt and turnAt: the program id at a page cursor, only when the position matches', () => {
  const t = createFakeTable();
  t.apply('view:1', { op: 'play', move: 'e4' });
  t.apply('view:1', { op: 'play', move: 'e5' });
  t.apply('view:1', { op: 'goto', node: 1 });
  t.apply('view:1', { op: 'play', move: 'c5' });
  const snap = t.snapshot();

  assert.equal(nodeIdAt(snap, []), 0);
  assert.equal(nodeIdAt(snap, [0, 0], AFTER_E5), 2);
  assert.equal(nodeIdAt(snap, [0, 1]), 3);
  assert.equal(nodeIdAt(snap, [0, 0], AFTER_E4), null, 'another position at that cursor names no node');
  assert.equal(nodeIdAt(snap, [0, 5]), null);
  assert.equal(nodeIdAt(null, []), null);

  assert.equal(turnAt(snap, 1), 'black');
  assert.equal(turnAt(snap, 2), 'white');
  assert.equal(turnAt(snap, 99), null);

  const g = Game.standard();
  g.play('e2e4');
  assert.equal(pageNodeAt(g, [0]).fen, AFTER_E4);
  assert.equal(pageNodeAt(g, [1]), null);
});

test('intentsForChange: play carries from_node; navigation is one goto; a replayed move is navigation', () => {
  const move = { san: 'e5', uci: 'e7e5' };

  assert.deepEqual(intentsForChange({ reason: 'move', move, fromFen: AFTER_E4, fromNode: 1 }), [{ op: 'play', move: 'e5', from_fen: AFTER_E4, from_node: 1 }]);
  assert.deepEqual(intentsForChange({ reason: 'move', move, fromFen: AFTER_E4, fromNode: 1, toNode: 2 }), [{ op: 'goto', node: 2 }]);
  assert.deepEqual(intentsForChange({ reason: 'goto', toNode: 0 }), [{ op: 'goto', node: 0 }]);
  assert.deepEqual(intentsForChange({ reason: 'goto', toNode: null }), [], 'a node the program does not hold is not sent');
  assert.deepEqual(intentsForChange({ reason: 'goto', toNode: 3, echo: true }), [], 'a frame that moved the cursor is never sent back');
  assert.deepEqual(intentsForChange({ reason: 'move', move, fromFen: AFTER_E4, fromNode: 1, echo: true }), []);
});

test('aiChip: the four texts', () => {
  const t = createFakeTable();
  t.apply('view:1', { op: 'play', move: 'e4' });
  const snap = t.snapshot();

  const idle = readMatch(null);
  assert.deepEqual(aiChip(null, idle, snap), { text: 'No AI connected', state: 'none' });
  assert.deepEqual(aiChip({ views: 1, ais: [] }, idle, snap), { text: 'No AI connected', state: 'none' });

  const ai = (extra = {}) => ({ views: 1, ais: [{ name: 'claude-code', transport: 'http', seat: null, waiting: false, idle_s: 1, ...extra }] });
  assert.deepEqual(aiChip(ai(), idle, snap), { text: 'claude-code connected', state: 'connected' });

  const blackAi = { active: true, seats: { white: 'human', black: 'ai' }, tip: 1, live: true, to_move: 'ai', style: 'annotate' };
  assert.deepEqual(aiChip(ai({ seat: 'black' }), blackAi, snap), { text: 'claude-code to move', state: 'to_move' });

  const humanTurn = { ...blackAi, to_move: 'human' };
  assert.deepEqual(aiChip(ai({ seat: 'black', waiting: true }), humanTurn, snap), { text: 'claude-code is waiting for your move', state: 'waiting' });
  assert.deepEqual(aiChip(ai({ seat: 'black' }), { ...blackAi, live: false, to_move: null }, snap), { text: 'claude-code connected', state: 'connected' });

  // Two clients: the one holding the side to move is named.
  const two = { views: 1, ais: [{ name: 'coach', seat: null, waiting: true, idle_s: 0 }, { name: 'player', seat: 'black', waiting: false, idle_s: 9 }] };
  assert.equal(aiChip(two, blackAi, snap).text, 'player to move');
  assert.equal(aiChip(two, humanTurn, snap).text, 'coach is waiting for your move');
});

test('aiChip: a long name is cut, the sentence never is', () => {
  const t = createFakeTable();
  t.apply('view:1', { op: 'play', move: 'e4' });
  const snap = t.snapshot();

  const humanTurn = { active: true, seats: { white: 'human', black: 'ai' }, tip: 1, live: true, to_move: 'human', style: 'annotate' };
  const one = name => ({ views: 1, ais: [{ name, seat: 'black', waiting: true, idle_s: 0 }] });
  assert.equal(aiChip(one('claude-code'), humanTurn, snap).text, 'claude-code is waiting for your move');
  assert.equal(aiChip(one('a'.repeat(18)), humanTurn, snap).text, `${'a'.repeat(18)} is waiting for your move`);
  assert.equal(aiChip(one('a'.repeat(40)), humanTurn, snap).text, `${'a'.repeat(18)}… is waiting for your move`);

  const idle = { views: 1, ais: [{ name: 'é'.repeat(30), seat: null, waiting: false, idle_s: 0 }] };
  assert.equal(aiChip(idle, readMatch(null), snap).text, `${'é'.repeat(18)}… connected`);
});

test('the chip text style is wide enough for the longest sentence', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

  const rule = css.match(/\.tb-ai-text\s*\{([^}]*)\}/);
  assert.ok(rule, 'the .tb-ai-text rule is there');

  const width = rule[1].match(/max-width:\s*(\d+)ch/);
  assert.ok(width, 'the guard is given in ch');

  const longest = `${'a'.repeat(18)}… is waiting for your move`.length;
  assert.ok(Number(width[1]) >= longest, `max-width ${width[1]}ch fits ${longest} characters`);
});

test('seatsForChoice and choiceFromSeats', () => {
  assert.deepEqual(seatsForChoice({ you: 'white', opponent: 'ai' }), { white: 'human', black: 'ai' });
  assert.deepEqual(seatsForChoice({ you: 'black', opponent: 'ai' }), { black: 'human', white: 'ai' });
  assert.deepEqual(seatsForChoice({ you: 'black', opponent: 'nobody' }), { black: 'human', white: 'human' });
  assert.deepEqual(seatsForChoice(), { white: 'human', black: 'human' });

  assert.deepEqual(choiceFromSeats({ white: 'human', black: 'ai' }), { you: 'white', opponent: 'ai' });
  assert.deepEqual(choiceFromSeats({ white: 'ai', black: 'human' }), { you: 'black', opponent: 'ai' });
  assert.deepEqual(choiceFromSeats({ white: 'human', black: 'human' }, { you: 'black' }), { you: 'black', opponent: 'nobody' });
  assert.deepEqual(choiceFromSeats({ white: 'ai', black: 'ai' }, { you: 'white' }), { you: 'white', opponent: 'ai' });
});

test('annotateIntent replaces all four fields; sameAnnotations ignores where an arrow came from', () => {
  const node = { note: 'why', nag: '!', arrows: [{ from: 'g1', to: 'f3', color: 'red', source: 'user' }, 'junk'], highlights: [{ square: 'e5', color: 'blue' }] };

  assert.deepEqual(annotateIntent(7, node), {
    op: 'annotate', node: 7, mode: 'replace', note: 'why', nag: '!',
    arrows: [{ from: 'g1', to: 'f3', color: 'red' }], highlights: [{ square: 'e5', color: 'blue' }],
  });
  assert.deepEqual(annotateIntent(0, {}), { op: 'annotate', node: 0, mode: 'replace', note: '', nag: '', arrows: [], highlights: [] });

  const snap = { note: 'why', nag: '!', arrows: [{ from: 'g1', to: 'f3', color: 'red', knight: true, source: 'ai' }], highlights: [{ square: 'e5', color: 'blue' }] };
  assert.equal(sameAnnotations(node, snap), true);
  assert.equal(sameAnnotations({ ...node, note: 'other' }, snap), false);
  assert.equal(sameAnnotations(node, null), false);
});

// The shell, against the stand-in table.

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

/** A program with N pages on it; pump() applies every sent intent, frame first, then the ack. */
function program(n = 1) {
  const table = createFakeTable({ instance: 'i1' });
  const pages = [];

  for (let i = 0; i < n; i++) {
    const st = createStore({ storage: null });
    const remote = startRemoteSync({ store: st, actions: st.actions, location: { href: 'http://127.0.0.1:47480/' }, WebSocket: FakeSocket, ackTimeoutMs: 60000 });

    const ws = FakeSocket.last;
    ws.onopen();
    ws.receive({ t: 'hello', proto: 1, instance: 'i1', you: `view:${i + 1}` });

    const events = [];
    st.on('game:change', p => events.push(p.reason));

    const toasts = [];
    st.actions.toast = (text, kind) => { toasts.push({ text, kind }); };

    pages.push({ st, remote, ws, events, toasts, by: `view:${i + 1}` });
  }

  const broadcast = () => {
    const f = table.frame();
    for (const p of pages) p.ws.receive(f);
  };

  let intents = [];

  const pump = () => {
    let moved = true;

    while (moved) {
      moved = false;

      for (const p of pages) {
        while (p.ws.sent.length) {
          moved = true;
          const msg = p.ws.sent.shift();
          intents.push(msg);

          const { t: _t, id, ...intent } = msg;
          const before = table.rev;
          const res = table.apply(p.by, intent);
          if (table.rev !== before) broadcast();

          p.ws.receive(res.ok ? { t: 'ack', id, ok: true, rev: table.rev, result: res.result } : { t: 'ack', id, ok: false, error: res.error });
        }
      }
    }
  };

  const ai = intent => {
    const before = table.rev;
    const res = table.apply('ai:claude-code', intent);
    if (table.rev !== before) broadcast();
    return res;
  };

  broadcast();

  return {
    table, pages, pump, ai, broadcast,
    sent: () => intents,
    clearSent: () => { intents = []; },
    done: () => {
      for (const p of pages) {
        p.remote.stop();
        p.st.dispose();
      }
    },
  };
}

test('shell: a hand move sends play with from_node (and from_fen), and lands in every view', () => {
  const pr = program(2);
  const [a, b] = pr.pages;

  a.st.actions.playMove('e2e4');
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.move, s.from_node, s.from_fen]), [['play', 'e4', 0, START]]);
  pr.pump();

  b.st.actions.playMove('e7e5');
  assert.equal(b.ws.sent[0].from_node, 1);
  pr.pump();

  for (const p of pr.pages) assert.equal(p.st.state.game.fen(), AFTER_E5);
  assert.deepEqual(pr.sent().map(s => s.op), ['play', 'play'], 'nothing sent back from applied frames');

  pr.done();
});

test('shell: navigation is shared as one goto; the other view follows with a goto, not a reload, and sends nothing', async () => {
  const pr = program(2);
  const [a, b] = pr.pages;
  a.st.actions.playMove('e2e4');
  pr.pump();
  a.st.actions.playMove('e7e5');
  pr.pump();
  pr.clearSent();
  b.events.length = 0;

  a.st.actions.back();
  a.st.actions.back();
  a.st.actions.forward();
  assert.equal(a.ws.sent.length, 0, 'navigation in one go waits for the end of it');

  await tick();
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.node]), [['goto', 1]]);

  pr.pump();
  await tick();
  assert.equal(pr.table.idOf(pr.table.game.current), 1);
  assert.equal(b.st.state.game.fen(), AFTER_E4);
  assert.deepEqual(b.events, ['goto'], 'the other view moved its cursor without rebuilding the game');
  assert.deepEqual(pr.sent().map(s => s.op), ['goto'], 'no ping-pong');

  pr.done();
});

test('shell: going somewhere and back in one go sends nothing', async () => {
  const pr = program(1);
  const [a] = pr.pages;
  a.st.actions.playMove('e2e4');
  pr.pump();
  pr.clearSent();

  a.st.actions.back();
  a.st.actions.forward();
  await tick();

  assert.equal(a.ws.sent.length, 0);

  pr.done();
});

test('shell: stepping back and playing a new move sends the goto first, so the variation is made where it was played', async () => {
  const pr = program(2);
  const [a, b] = pr.pages;
  a.st.actions.playMove('e2e4');
  pr.pump();
  a.st.actions.playMove('e7e5');
  pr.pump();
  pr.clearSent();

  a.st.actions.back();
  a.st.actions.playMove('c7c5');
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.node ?? s.from_node]), [['goto', 1], ['play', 1]]);

  pr.pump();
  assert.deepEqual(a.toasts, []);
  assert.equal(pr.table.game.root.children[0].children.length, 2);
  assert.equal(gameSignature(b.st.state.game), snapshotSignature(pr.table.snapshot()));

  pr.done();
});

test('shell: an arrow drawn and a note written on the page are sent as annotate; the echo is not sent back', () => {
  const pr = program(2);
  const [a, b] = pr.pages;
  a.st.actions.playMove('e2e4');
  pr.pump();
  pr.clearSent();

  a.st.actions.toggleArrow({ from: 'g1', to: 'f3', color: 'red' });
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.node, s.mode, s.arrows.length]), [['annotate', 1, 'replace', 1]]);
  pr.pump();

  a.st.actions.setNote('the centre');
  pr.pump();

  const n = pr.table.byId(1);
  assert.equal(n.note, 'the centre');
  assert.deepEqual(n.arrows.map(x => [x.from, x.to, x.color]), [['g1', 'f3', 'red']]);
  assert.equal(b.st.state.game.current.note, 'the centre');
  assert.equal(b.st.state.game.current.arrows.length, 1);
  assert.deepEqual(pr.sent().map(s => s.op), ['annotate', 'annotate'], 'one per edit, none from the frames');

  pr.done();
});

test('shell: an AI move with a note animates and the note is copied in place (no reload)', () => {
  const pr = program(1);
  const [a] = pr.pages;
  a.st.actions.playMove('e2e4');
  pr.pump();
  a.events.length = 0;

  const res = pr.ai({ op: 'play', move: 'e5', note: 'symmetry', arrows: [{ from: 'e5', to: 'e4', color: 'blue' }] });

  assert.equal(res.ok, true);
  assert.equal(a.st.state.game.fen(), AFTER_E5);
  assert.equal(a.st.state.game.current.note, 'symmetry');
  assert.deepEqual(a.st.state.game.current.arrows.map(x => [x.from, x.to, x.color, x.source]), [['e5', 'e4', 'blue', 'ai']]);
  assert.ok(!a.events.includes('load'), 'the game was not rebuilt');
  assert.equal(a.ws.sent.length, 0);

  pr.done();
});

test('shell: the play control sends match_start, set_style, set_seats and match_stop; onChange fires on frames and presence', () => {
  const pr = program(1);
  const [a] = pr.pages;
  let calls = 0;
  const off = a.remote.onChange(() => { calls++; });
  assert.equal(a.remote.match().active, false);

  assert.equal(a.remote.startMatch({ white: 'human', black: 'ai' }, 'Coach'), true);
  pr.pump();
  assert.deepEqual(a.remote.match(), { active: true, seats: { white: 'human', black: 'ai' }, tip: 0, live: true, to_move: 'human', style: 'coach' });

  a.remote.setStyle('whatever');
  a.remote.setSeats({ white: 'ai', black: 'human' });
  pr.pump();
  assert.equal(a.remote.match().style, 'annotate');
  assert.equal(a.remote.match().to_move, 'ai');

  a.remote.stopMatch();
  pr.pump();
  assert.equal(a.remote.match().active, false);
  assert.deepEqual(pr.sent().map(s => s.op), ['match_start', 'set_style', 'set_seats', 'match_stop']);

  const before = calls;
  a.ws.receive({ t: 'presence', views: 1, ais: [{ name: 'claude-code', transport: 'http', seat: 'black', waiting: true, idle_s: 0 }] });
  assert.equal(calls, before + 1);
  assert.equal(a.remote.presence().ais[0].name, 'claude-code');
  assert.equal(a.remote.match().active, false, 'presence is not state');

  off();
  a.ws.receive({ t: 'presence', views: 1, ais: [] });
  assert.equal(calls, before + 1);

  pr.done();
});

test('shell: browsing away from tip and back during a match; the AI plays from tip and every view follows', async () => {
  const pr = program(1);
  const [a] = pr.pages;
  a.st.actions.playMove('e2e4');
  pr.pump();

  a.remote.startMatch({ white: 'ai', black: 'human' }, 'silent');
  pr.pump();
  assert.equal(a.remote.match().to_move, 'human');

  a.st.actions.playMove('e7e5');
  pr.pump();
  assert.equal(a.remote.match().to_move, 'ai');

  a.st.actions.back();
  await tick();
  pr.pump();
  assert.equal(a.remote.match().live, false);
  assert.equal(a.remote.match().to_move, null);

  a.remote.gotoTip();
  pr.pump();
  assert.equal(a.remote.match().live, true);
  assert.equal(a.st.state.game.fen(), AFTER_E5);

  assert.equal(pr.ai({ op: 'play', move: 'Nf3' }).ok, true);
  assert.equal(a.st.state.game.current.san, 'Nf3');
  assert.equal(a.st.state.game.path().at(-2).fen, AFTER_E5, 'played from the old tip');

  pr.done();
});

test('shell: a disconnect forgets presence; a control sent while disconnected says so once', () => {
  const pr = program(1);
  const [a] = pr.pages;
  a.ws.receive({ t: 'presence', views: 1, ais: [{ name: 'x' }] });

  a.ws.readyState = 3;
  a.ws.onclose();

  assert.equal(a.remote.presence(), null);
  assert.equal(a.remote.connected(), false);
  assert.equal(a.remote.stopMatch(), false);
  assert.equal(a.toasts.filter(t => t.kind === 'error').length, 1);

  pr.done();
});

test('intentsForChange: a move the program already holds, played from the tip of a match, is a play', () => {
  const move = { san: 'e4', uci: 'e2e4' };

  assert.deepEqual(intentsForChange({ reason: 'move', move, fromFen: START, fromNode: 0, toNode: 1, tip: 0 }),
    [{ op: 'play', move: 'e4', from_fen: START, from_node: 0 }]);
  assert.deepEqual(intentsForChange({ reason: 'move', move, fromFen: START, fromNode: 0, toNode: 1, tip: 3 }),
    [{ op: 'goto', node: 1 }], 'away from the tip it is still navigation');
  assert.deepEqual(intentsForChange({ reason: 'move', move, fromFen: START, fromNode: 0, toNode: 1, tip: null }),
    [{ op: 'goto', node: 1 }], 'with no match it is still navigation');
});

test('shell: replaying an existing move from the tip of a match moves the tip, so the match stays live', async () => {
  const pr = program(1);
  const [a] = pr.pages;
  a.st.actions.playMove('e2e4');
  pr.pump();
  a.st.actions.back();
  await tick();
  pr.pump();
  a.remote.startMatch({ white: 'human', black: 'ai' });
  pr.pump();
  assert.equal(a.remote.match().tip, 0);
  pr.clearSent();

  a.st.actions.playMove('e2e4');
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.move, s.from_node]), [['play', 'e4', 0]]);
  pr.pump();

  const m = a.remote.match();
  assert.equal(m.tip, 1);
  assert.equal(m.live, true);
  assert.equal(m.to_move, 'ai');
  assert.equal(pr.table.game.root.children.length, 1, 'the existing node was reused');

  pr.done();
});

test('shell: an accepted edit with parts left out says why', () => {
  const pr = program(1);
  const [a] = pr.pages;

  a.st.actions.setNote('x');
  const sent = a.ws.sent.shift();
  a.ws.receive({ t: 'ack', id: sent.id, ok: true, rev: 1, result: { node: 0, applied: {}, rejected: [{ item: 'note', value: 'x', reason: 'a note can hold at most 10000 characters' }] } });

  assert.deepEqual(a.toasts.map(t => t.kind), ['error']);
  assert.match(a.toasts[0].text, /at most 10000 characters/);

  pr.done();
});

test('shell: a refused control redraws the play control, and stopping tells it once', () => {
  const pr = program(1);
  const [a] = pr.pages;
  let calls = 0;
  a.remote.onChange(() => { calls++; });

  a.remote.setStyle('coach');
  const sent = a.ws.sent.shift();
  const before = calls;
  a.ws.receive({ t: 'ack', id: sent.id, ok: false, error: { code: 'bad_input', message: 'no' } });
  assert.ok(calls > before, 'listeners hear about a refusal');

  a.ws.receive({ t: 'hello', proto: 99, instance: 'i1', you: 'view:1' });
  assert.equal(a.remote.stopped(), true);

  const after = calls;
  assert.equal(a.remote.stopMatch(), false);
  assert.ok(a.toasts.some(t => /Not connected/.test(t.text)), 'a control after stopping says so');
  assert.equal(calls, after);

  pr.done();
});
