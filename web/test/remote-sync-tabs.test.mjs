// Board tabs in src/net/remoteSync.js: the tab on every intent, the switch path, setup, and the tab intents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTabs, isTabSwitch, gameSignature, snapshotSignature, readPresence, readMatch, aiChip, firstOrientation, TAB_LIMIT_TEXT } from '../src/net/remoteSync.js';
import { deskProgram } from './fake-program.mjs';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const tick = () => new Promise(r => setImmediate(r));

/** Another window makes a board; it is selected and every view gets its frame. */
const otherWindowMakesBoard = pr => pr.view('view:9', { op: 'tab_new', name: null, copy_of: null }).result.tab;

test('readTabs reads the selected tab and the list; junk is dropped or filled in', () => {
  const frame = {
    tab: 't4',
    tabs: [
      { id: 't1', name: 'Board 1', kind: 'free', mark: null },
      { id: 't4', name: 'Italian', kind: 'odd', mark: 'your_move' },
      { id: '', name: 'x' }, 'junk', { id: 't5', mark: 'loud' },
    ],
  };

  assert.deepEqual(readTabs(frame), {
    tab: 't4',
    tabs: [
      { id: 't1', name: 'Board 1', kind: 'free', mark: null },
      { id: 't4', name: 'Italian', kind: 'free', mark: 'your_move' },
      { id: 't5', name: 't5', kind: 'free', mark: null },
    ],
  });

  assert.deepEqual(readTabs(null), { tab: null, tabs: [] });
  assert.equal(isTabSwitch('t1', { tab: 't2' }), true);
  assert.equal(isTabSwitch('t1', { tab: 't1' }), false);
  assert.equal(isTabSwitch(null, { tab: 't1' }), false, 'the first frame is taken as the shown tab');
});

test('a frame for another tab is loaded whole even when it is one legal move ahead of the shown game', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  assert.equal(a.remote.shownTab(), 't1');
  assert.equal(a.st.state.game.fen(), START);
  a.events.length = 0;

  pr.desk.apply('view:9', { op: 'tab_new', name: null, copy_of: null });
  pr.desk.apply('view:9', { op: 'play', tab: 't2', move: 'e4' });
  pr.broadcast();

  assert.equal(a.st.state.game.fen(), AFTER_E4);
  assert.deepEqual(a.events, ['load'], 'loaded, not played as a move');
  assert.equal(a.remote.shownTab(), 't2');
  assert.equal(a.ws.sent.length, 0, 'nothing sent back');

  pr.done();
});

test('a frame for the shown tab one legal move ahead still animates', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  otherWindowMakesBoard(pr);
  a.events.length = 0;

  pr.view('view:9', { op: 'play', tab: 't2', move: 'e4' });

  assert.equal(a.st.state.game.fen(), AFTER_E4);
  assert.deepEqual(a.events, ['move']);

  pr.done();
});

test('a queued goto is dropped on a switch', async () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  a.st.actions.playMove('e2e4');
  pr.pump();
  pr.clearSent();

  a.st.actions.back();
  otherWindowMakesBoard(pr);
  await tick();
  pr.pump();

  assert.deepEqual(pr.sent(), [], 'the goto made on t1 was not sent');
  assert.equal(pr.desk.table('t1').idOf(pr.desk.table('t1').game.current), 1, 't1 still shows e4');
  assert.equal(a.remote.shownTab(), 't2');

  pr.done();
});

test('every outgoing game intent carries the shown tab; tab intents name only their own tab', async () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  otherWindowMakesBoard(pr);
  pr.clearSent();

  a.st.actions.playMove('e2e4');
  pr.pump();
  a.st.actions.back();
  await tick();
  pr.pump();
  a.st.actions.forward();
  await tick();
  pr.pump();
  a.st.actions.toggleArrow({ from: 'g1', to: 'f3', color: 'red' });
  pr.pump();
  a.remote.startMatch({ white: 'human', black: 'ai' }, 'coach');
  a.remote.setStyle('silent');
  a.remote.setSeats({ white: 'ai', black: 'human' });
  a.remote.gotoTip();
  a.remote.stopMatch();
  pr.pump();
  a.st.actions.newGame();
  pr.pump();

  const game = pr.sent();
  assert.deepEqual(game.map(s => s.op), ['play', 'goto', 'goto', 'annotate', 'match_start', 'set_style', 'set_seats', 'goto', 'match_stop', 'new_game']);
  for (const s of game) assert.equal(s.tab, 't2', `${s.op} names the shown tab`);
  assert.deepEqual(a.toasts, []);

  pr.clearSent();
  a.remote.renameTab('t1', 'Italian');
  a.remote.selectTab('t1');
  a.remote.closeTab('t2');
  a.remote.newTab();

  assert.deepEqual(a.ws.sent.map(({ t: _t, id: _id, ...rest }) => rest), [
    { op: 'tab_rename', tab: 't1', name: 'Italian' },
    { op: 'tab_select', tab: 't1' },
    { op: 'tab_close', tab: 't2' },
    { op: 'tab_new', name: null, copy_of: null },
  ]);

  pr.done();
});

test('selecting the tab already shown changes nothing and reloads nothing', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  a.events.length = 0;

  assert.equal(a.remote.selectTab('t1'), true);
  const rev = pr.desk.rev;
  pr.pump();

  assert.equal(pr.desk.rev, rev);
  assert.deepEqual(a.events, []);
  assert.deepEqual(a.toasts, []);

  pr.done();
});

test('intents made on A and sent after the frame for B arrives still say A', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  const send = a.ws.send.bind(a.ws);
  let switched = false;

  // The switch lands between the first intent of the load and the rest.
  a.ws.send = text => {
    send(text);

    if (!switched) {
      switched = true;
      otherWindowMakesBoard(pr);
    }
  };

  a.st.actions.loadPgn('1. e4 e5');
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.tab]), [['new_game', 't1'], ['play', 't1'], ['play', 't1']]);
  assert.equal(a.remote.shownTab(), 't2');

  pr.pump();
  assert.equal(pr.desk.table('t1').game.mainline().length, 3, 'the whole load landed on t1');
  assert.equal(pr.desk.table('t2').game.mainline().length, 1);
  assert.equal(a.st.state.game.fen(), START, 'the page shows t2');

  pr.done();
});

test('a move in flight on A is dropped from the page on a switch and still lands on A', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  a.st.actions.playMove('e2e4');
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.tab]), [['play', 't1']]);

  otherWindowMakesBoard(pr);
  assert.equal(a.st.state.game.fen(), START, 'the page shows t2 at once');

  pr.pump();
  assert.equal(pr.desk.table('t1').game.fen(), AFTER_E4);
  assert.equal(a.st.state.game.fen(), START);
  assert.deepEqual(a.toasts, []);

  pr.done();
});

test('two switches in a row leave the page on the last frame\'s tab', () => {
  const pr = deskProgram(2);
  const [a, b] = pr.pages;

  a.remote.newTab();
  pr.pump();
  a.st.actions.playMove('d2d4');
  pr.pump();
  a.remote.newTab();
  a.remote.selectTab('t1');
  a.remote.selectTab('t2');
  pr.pump();

  for (const p of [a, b]) {
    assert.equal(p.remote.shownTab(), 't2');
    assert.equal(gameSignature(p.st.state.game), snapshotSignature(pr.desk.table('t2').snapshot()));
  }

  assert.equal(pr.desk.selected, 't2');

  pr.done();
});

test('a window in setup stays in setup and its commit goes to the tab it was started on', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  a.st.actions.setMode('setup');
  a.st.actions.setupPlace('h2', null);
  otherWindowMakesBoard(pr);

  assert.equal(a.st.state.mode, 'setup');
  assert.ok(a.st.state.setup.pieces.every(p => p.square !== 'h2'), 'the scratch position is kept');
  assert.equal(a.remote.shownTab(), 't1');

  a.st.actions.setupCommit();
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.tab]), [['new_game', 't1']]);

  pr.pump();
  pr.runSoon();

  assert.match(pr.desk.table('t1').game.startFen, /PPPPPPP1/);
  assert.equal(pr.desk.table('t2').game.startFen, START);
  assert.equal(a.remote.shownTab(), 't2', 'after setup the window follows the selected tab');
  assert.equal(a.st.state.game.fen(), START);

  pr.done();
});

test('leaving setup without a commit follows the tab that was selected meanwhile', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  a.st.actions.setMode('setup');
  otherWindowMakesBoard(pr);
  a.st.actions.setMode('play');
  pr.runSoon();

  assert.equal(a.remote.shownTab(), 't2');
  assert.equal(a.ws.sent.length, 0);

  pr.done();
});

test('a switch puts down a piece in hand', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  a.st.actions.select('e2');
  assert.equal(a.st.state.selected, 'e2');

  otherWindowMakesBoard(pr);
  assert.equal(a.st.state.selected, null);
  assert.equal(a.events.at(-1), 'load', 'the board hears a load, which drops a drag');

  pr.done();
});

test('the page-only title belongs to its tab', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  a.st.actions.setStudyTitle('Italian prep');
  otherWindowMakesBoard(pr);
  assert.equal(a.st.state.study.title, '');

  pr.view('view:9', { op: 'tab_select', tab: 't1' });
  assert.equal(a.st.state.study.title, 'Italian prep');

  pr.done();
});

test('a new board at the limit shows the limit line; other tab refusals show their message', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  for (let i = 0; i < 11; i++) a.remote.newTab();
  pr.pump();
  assert.equal(pr.desk.tabs().length, 12);
  assert.deepEqual(a.toasts, []);

  a.remote.newTab();
  pr.pump();
  assert.deepEqual(a.toasts, [{ text: 'Close a board first.', kind: 'error' }]);
  assert.equal(a.toasts[0].text, TAB_LIMIT_TEXT);

  a.remote.selectTab('t99');
  pr.pump();
  assert.equal(a.toasts.length, 2);
  assert.match(a.toasts[1].text, /There is no open board "t99"/);

  pr.done();
});

test('closing the shown tab elsewhere moves every view to the next tab', () => {
  const pr = deskProgram(2);
  const [a, b] = pr.pages;

  a.remote.newTab();
  pr.pump();
  b.st.actions.playMove('e2e4');
  pr.pump();
  a.remote.selectTab('t1');
  pr.pump();

  b.remote.closeTab('t1');
  pr.pump();

  for (const p of [a, b]) {
    assert.equal(p.remote.shownTab(), 't2');
    assert.equal(p.st.state.game.fen(), AFTER_E4);
    assert.deepEqual(p.remote.tabs().tabs.map(t => t.id), ['t2']);
  }

  pr.done();
});

test('in setup after the selection moved, the match controls act on the tab whose match they show', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  pr.view('view:9', { op: 'match_start', tab: 't1', seats: { white: 'human', black: 'ai' } });
  a.st.actions.setMode('setup');
  const t2 = otherWindowMakesBoard(pr);
  pr.view('view:9', { op: 'match_start', tab: t2, seats: { white: 'human', black: 'ai' } });

  assert.equal(a.remote.shownTab(), 't1');
  assert.equal(a.remote.tabs().tab, t2);

  a.remote.stopMatch();
  a.remote.gotoTip();
  assert.deepEqual(a.ws.sent.map(s => [s.op, s.tab]), [['match_stop', t2], ['goto', t2]]);

  pr.pump();
  assert.equal(pr.desk.table('t1').frame().state.match.active, true, 'the match on the board left behind still runs');
  assert.equal(pr.desk.table(t2).frame().state.match.active, false);
  assert.equal(a.st.state.mode, 'setup');

  pr.done();
});

test('a stale refusal for a tab the page has left is still shown', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  a.st.actions.playMove('e2e4');
  pr.view('view:9', { op: 'play', tab: 't1', move: 'd4' });
  const t2 = otherWindowMakesBoard(pr);
  pr.view('view:9', { op: 'play', tab: t2, move: 'c4' });
  const shown = a.st.state.game.fen();
  a.events.length = 0;

  pr.pump();

  assert.equal(a.toasts.length, 1);
  assert.match(a.toasts[0].text, /^The Rukh program did not take that: /);
  assert.equal(a.st.state.game.fen(), shown, 'the shown board is not rolled back');
  assert.deepEqual(a.events, []);

  pr.done();
});

test('the AI chip counts a seat only on the tab it is on', () => {
  const presence = readPresence({ views: 1, ais: [{ name: 'guest', transport: 'http', seat: 'black', tab: 't1', waiting: true, idle_s: 1 }] });
  const humanTurn = { active: true, live: true, seats: { white: 'human', black: 'ai' }, to_move: 'human', tip: 0 };
  const snap = { nodes: [{ id: 0, fen: START }] };

  assert.equal(presence.ais[0].tab, 't1');
  assert.deepEqual(aiChip(presence, humanTurn, snap, 't1'), { text: 'guest is waiting for your move', state: 'waiting' });
  assert.deepEqual(aiChip(presence, readMatch(null), snap, 't2'), { text: 'guest connected', state: 'connected' });
  assert.deepEqual(aiChip(presence, humanTurn, snap), { text: 'guest is waiting for your move', state: 'waiting' }, 'no tab known: as before');
});

test('the stand-in desk sends no frame for a rename to the same name', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  const rev = pr.desk.rev;

  a.remote.renameTab('t1', ' Board\u200B  1 ');
  pr.pump();

  assert.equal(pr.desk.rev, rev);
  assert.deepEqual(a.toasts, []);

  pr.done();
});

test('a flip on one board is not seen on another and is back on return', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  a.st.actions.flip();
  a.st.actions.setStudyTitle('Board one study');
  assert.equal(a.st.state.orientation, 'black');

  otherWindowMakesBoard(pr);
  assert.equal(a.st.state.orientation, 'white', 'a board not shown before starts from White');
  assert.equal(a.st.state.study.title, '');

  a.st.actions.setStudyTitle('Board two study');
  pr.view('view:9', { op: 'tab_select', tab: 't1' });
  assert.equal(a.st.state.orientation, 'black');
  assert.equal(a.st.state.study.title, 'Board one study');

  pr.view('view:9', { op: 'tab_select', tab: 't2' });
  assert.equal(a.st.state.orientation, 'white');
  assert.equal(a.st.state.study.title, 'Board two study');

  pr.done();
});

test('a coach game not shown before starts on the person\'s side', () => {
  const frame = (kind, seats) => ({ tab: 't5', tabs: [{ id: 't5', name: 'Rook: game 24', kind, mark: null }], state: { match: { active: true, seats } } });

  assert.equal(firstOrientation(frame('game', { white: 'engine', black: 'human' })), 'black');
  assert.equal(firstOrientation(frame('game', { white: 'human', black: 'engine' })), 'white');
  assert.equal(firstOrientation(frame('free', { white: 'ai', black: 'human' })), 'white', 'a free board starts from White');
  assert.equal(firstOrientation(null), 'white');
});

test('setup whose board was closed elsewhere puts the position on a new board', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  otherWindowMakesBoard(pr);
  pr.view('view:9', { op: 'tab_select', tab: 't1' });

  a.st.actions.flip();
  a.st.actions.setMode('setup');
  a.st.actions.setupPlace('h2', null);
  pr.view('view:9', { op: 'tab_close', tab: 't1' });

  assert.equal(a.st.state.mode, 'setup');
  assert.ok(a.st.state.setup.pieces.every(p => p.square !== 'h2'), 'the scratch position is kept');

  a.st.actions.setupCommit();
  assert.deepEqual(a.ws.sent.map(s => s.op), ['tab_new'], 'a new board first');

  pr.pump();
  pr.runSoon();

  assert.deepEqual(pr.sent().map(s => [s.op, s.tab]), [['tab_new', undefined], ['new_game', 't3']]);
  assert.match(pr.desk.table('t3').game.startFen, /PPPPPPP1/);
  assert.equal(pr.desk.table('t2').game.startFen, START, 'the other board is untouched');
  assert.equal(a.remote.shownTab(), 't3');
  assert.match(a.st.state.game.fen(), /PPPPPPP1/);
  assert.equal(a.st.state.orientation, 'black', 'the setup\'s side comes along');
  assert.deepEqual(a.toasts, []);

  pr.done();
});

test('a move played while the new board for a closed setup is being made goes on that board', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;
  otherWindowMakesBoard(pr);
  pr.view('view:9', { op: 'tab_select', tab: 't1' });

  a.st.actions.setMode('setup');
  a.st.actions.setupPlace('h2', null);
  pr.view('view:9', { op: 'tab_close', tab: 't1' });

  a.st.actions.setupCommit();
  a.st.actions.playMove('e2e4');
  assert.deepEqual(a.ws.sent.map(s => s.op), ['tab_new'], 'nothing goes to the closed board');

  pr.pump();
  pr.runSoon();

  assert.deepEqual(pr.sent().map(s => [s.op, s.tab]), [['tab_new', undefined], ['new_game', 't3'], ['play', 't3']]);
  assert.equal(pr.desk.table('t3').game.mainline().length, 2, 'the move is on the new board');
  assert.match(pr.desk.table('t3').game.startFen, /PPPPPPP1/);
  assert.equal(a.remote.shownTab(), 't3');
  assert.deepEqual(a.toasts, []);

  pr.done();
});

test('setup whose board was closed, with no room for a new board, opens setup again with nothing lost', () => {
  const pr = deskProgram(1);
  const [a] = pr.pages;

  a.st.actions.setMode('setup');
  a.st.actions.setupPlace('h2', null);
  for (let i = 0; i < 11; i++) otherWindowMakesBoard(pr);
  pr.view('view:9', { op: 'tab_close', tab: 't1' });
  otherWindowMakesBoard(pr);
  assert.equal(pr.desk.tabs().length, 12);

  a.st.actions.setupCommit();
  pr.pump();
  pr.runSoon();

  assert.deepEqual(a.toasts, [{ text: TAB_LIMIT_TEXT, kind: 'error' }]);
  assert.equal(a.st.state.mode, 'setup', 'back in setup');
  assert.ok(a.st.state.setup.pieces.every(p => p.square !== 'h2'), 'the position is still there');
  assert.equal(a.remote.shownTab(), 't1');
  assert.ok(pr.desk.tabs().every(t => pr.desk.table(t.id).game.startFen === START), 'no board was changed');

  pr.view('view:9', { op: 'tab_close', tab: 't13' });
  a.st.actions.setupCommit();
  pr.pump();
  pr.runSoon();

  const made = pr.desk.tabs().at(-1).id;
  assert.match(pr.desk.table(made).game.startFen, /PPPPPPP1/);
  assert.equal(a.remote.shownTab(), made);
  assert.equal(a.st.state.mode, 'play');

  pr.done();
});

test('the stand-in desk moves tabs and reopens closed ones as the program does', () => {
  const pr = deskProgram(1, { saving: true });
  const [a] = pr.pages;
  otherWindowMakesBoard(pr);
  otherWindowMakesBoard(pr);

  assert.deepEqual(pr.view('view:9', { op: 'tab_move', tab: 't3', to: 0 }), { ok: true, result: { tab: 't3', order: ['t3', 't1', 't2'] } });
  const rev = pr.desk.rev;
  assert.deepEqual(pr.view('view:9', { op: 'tab_move', tab: 't3', to: 0 }).result.order, ['t3', 't1', 't2']);
  assert.equal(pr.desk.rev, rev, 'the same place changes nothing');
  assert.deepEqual(pr.view('view:9', { op: 'tab_move', tab: 't3', to: 3 }).error, { code: 'bad_input', message: 'to must be a place from 0 to 2' });
  assert.equal(pr.view('view:9', { op: 'tab_move', tab: 't9', to: 0 }).error.code, 'unknown_tab');

  const boards = [];
  const receive = a.ws.receive.bind(a.ws);
  a.ws.receive = msg => {
    if (msg.t === 'boards') boards.push(msg);
    receive(msg);
  };

  a.remote.closeTab('t1');
  pr.pump();
  assert.deepEqual(boards, [{ t: 'boards', saving: true, notices: [], closed: 1 }]);
  assert.equal(a.remote.closedBoards(), 1);

  a.remote.reopenTab();
  pr.pump();
  assert.deepEqual(pr.desk.tabs().map(t => t.id), ['t3', 't2', 't1']);
  assert.equal(pr.desk.selected, 't1');
  assert.deepEqual(boards.at(-1), { t: 'boards', saving: true, notices: [], closed: 0 });

  assert.deepEqual(pr.view('view:9', { op: 'tab_reopen' }).error, { code: 'nothing_closed', message: 'There is no closed board to reopen.' });

  pr.done();
});
