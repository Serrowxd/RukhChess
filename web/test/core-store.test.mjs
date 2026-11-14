// Tests for src/core/store.js — actions, events (payloads), settings persistence, autosave/restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, store as singleton, actions as singletonActions, SETTINGS_DEFAULTS, STORAGE_KEYS, AI_STYLES, normalizeAiStyle } from '../src/core/store.js';
import { Game, INITIAL_FEN } from '../src/core/game.js';
import { studyToYaml } from '../src/core/io.js';

function fakeStorage() {
  const mem = new Map();
  return {
    mem,
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
  };
}

function make(opts = {}) {
  const storage = opts.storage || fakeStorage();
  const st = createStore({ storage, autosaveDelay: 10, ...opts });
  const events = [];
  const all = ['game:change', 'position:change', 'annotations:change', 'selection:change', 'promotion:required', 'mode:change',
    'orientation:change', 'settings:change', 'engine:update', 'ai:update', 'ui:change', 'toast', 'study:change',
    'viewmode:change', 'selfplay:change', 'clock:change', 'clock:tick'];
  for (const ev of all) st.on(ev, payload => events.push({ ev, payload }));
  const names = () => events.map(e => e.ev);
  const of = ev => events.filter(e => e.ev === ev).map(e => e.payload);
  const reset = () => events.splice(0, events.length);
  return { st, actions: st.actions, state: st.state, storage, events, names, of, reset };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

test('singleton store and bound actions exist', () => {
  assert.ok(singleton.state.game instanceof Game);
  assert.equal(typeof singletonActions.newGame, 'function');
  assert.equal(singleton.actions, singletonActions);
  assert.equal(singleton.state.settings.theme, 'wood');
  assert.equal(singleton.state.mode, 'play');
});

test('attemptMove: played / illegal / promotion flow with events', () => {
  const t = make();
  assert.equal(t.actions.attemptMove({ from: 'e2', to: 'e4' }), 'played');
  assert.deepEqual(t.names(), ['game:change', 'engine:update', 'position:change']);
  const gc = t.of('game:change')[0];
  assert.equal(gc.reason, 'move');
  assert.equal(gc.move.san, 'e4');
  assert.equal(gc.current.san, 'e4');
  assert.equal(gc.game, t.state.game);
  const pc = t.of('position:change')[0];
  assert.equal(pc.fen, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
  assert.equal(pc.turn, 'black');
  assert.equal(pc.node, t.state.game.current);
  t.reset();
  assert.equal(t.actions.attemptMove({ from: 'e7', to: 'e4' }), 'illegal');
  assert.equal(t.actions.attemptMove({ from: 'e4', to: 'e5' }), 'illegal', 'not the side to move');
  assert.equal(t.actions.attemptMove({ from: 'd4', to: 'd5' }), 'illegal', 'empty square');
  assert.equal(t.actions.attemptMove('e7', 'e5'), 'played', 'positional form');
  assert.deepEqual(t.names(), ['game:change', 'engine:update', 'position:change']);
  t.reset();
  // promotion
  t.actions.loadFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  t.reset();
  assert.equal(t.actions.attemptMove({ from: 'a7', to: 'a8' }), 'promotion');
  assert.deepEqual(t.names(), ['promotion:required']);
  assert.deepEqual(t.of('promotion:required')[0], { from: 'a7', to: 'a8' });
  assert.equal(t.state.game.current, t.state.game.root, 'nothing played yet');
  t.reset();
  const node = t.actions.playMove({ from: 'a7', to: 'a8', promotion: 'r' });
  assert.equal(node.san, 'a8=R+');
  assert.equal(t.of('game:change')[0].move.promotion, 'r');
  t.st.dispose();
});

test('playMove / playSan: illegal moves toast and return null; castling via rook square is accepted', () => {
  const t = make();
  assert.equal(t.actions.playMove('e2e5'), null);
  assert.deepEqual(t.names(), ['toast']);
  assert.equal(t.of('toast')[0].kind, 'error');
  t.reset();
  assert.equal(t.actions.playSan('Nf6'), null);
  assert.equal(t.of('toast').length, 1);
  t.reset();
  assert.equal(t.actions.playSan('Nf3').san, 'Nf3');
  assert.equal(t.actions.playMove('e7e5').san, 'e5');
  t.reset();
  t.actions.loadFen('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.equal(t.actions.attemptMove({ from: 'e1', to: 'h1' }), 'played', 'king onto own rook castles');
  assert.equal(t.state.game.current.san, 'O-O');
  t.st.dispose();
});

test('navigation emits game:change; position:change only when the fen changes', () => {
  const t = make();
  t.actions.playMove('e2e4');
  const e4 = t.state.game.current;
  t.actions.playMove('e7e5');
  t.actions.back();
  t.actions.playMove('c7c5');
  const c5 = t.state.game.current;
  t.reset();
  t.actions.goto(c5.id);
  assert.deepEqual(t.names(), [], 'goto the current node is a no-op');
  t.actions.promoteVariation(c5.id);
  assert.deepEqual(t.names(), ['game:change'], 'promotion changes the tree, not the position');
  assert.equal(t.of('game:change')[0].reason, 'promote');
  assert.equal(e4.children[0], c5);
  t.reset();
  t.actions.toStart();
  assert.deepEqual(t.names(), ['game:change', 'engine:update', 'position:change']);
  assert.equal(t.of('game:change')[0].reason, 'goto');
  t.reset();
  assert.equal(t.actions.back(), null);
  assert.deepEqual(t.names(), []);
  t.actions.forward();
  t.actions.forward();
  assert.equal(t.state.game.current, c5);
  t.reset();
  t.actions.nextVariation();
  assert.equal(t.state.game.current.san, 'e5');
  t.actions.prevVariation();
  assert.equal(t.state.game.current, c5);
  t.actions.toEnd();
  t.reset();
  t.actions.deleteFrom(c5.id);
  assert.equal(t.of('game:change')[0].reason, 'delete');
  assert.equal(t.state.game.current, e4);
  assert.equal(t.of('position:change').length, 1);
  t.actions.makeMainline(e4.children[0].id);
  t.st.dispose();
});

test('select emits selection:change with legal targets; moving clears the selection', () => {
  const t = make();
  t.actions.select('e2');
  assert.deepEqual(t.of('selection:change')[0], { selected: 'e2', legalTargets: ['e3', 'e4'] });
  t.reset();
  t.actions.select('e2');
  assert.deepEqual(t.names(), [], 'same selection is not re-emitted');
  t.actions.select('g1');
  assert.deepEqual(t.of('selection:change')[0].legalTargets, ['f3', 'h3']);
  t.reset();
  t.actions.playMove('g1f3');
  // The selection is cleared LAST: listeners that read "deselect while a promotion is pending" as a
  // cancelled picker must have seen game:change first.
  assert.deepEqual(t.names(), ['game:change', 'engine:update', 'position:change', 'selection:change']);
  assert.deepEqual(t.of('selection:change')[0], { selected: null, legalTargets: [] });
  assert.equal(t.state.selected, null);
  t.reset();
  t.actions.select('e7');
  t.actions.select(null);
  assert.deepEqual(t.of('selection:change')[1], { selected: null, legalTargets: [] });
  t.st.dispose();
});

test('setup mode: scratch from the position, edits emit game:change reason setup, commit builds the game', () => {
  const t = make();
  t.actions.playMove('e2e4');
  t.reset();
  t.actions.setMode('setup');
  assert.deepEqual(t.names(), ['mode:change']);
  assert.deepEqual(t.of('mode:change')[0], { mode: 'setup' });
  assert.equal(t.state.mode, 'setup');
  assert.equal(t.state.setup.pieces.length, 32);
  assert.equal(t.state.setup.turn, 'black');
  assert.equal(t.state.setup.castling, 'KQkq');
  t.reset();
  assert.equal(t.actions.attemptMove({ from: 'e7', to: 'e5' }), 'illegal', 'no moves in setup mode');
  assert.equal(t.actions.playMove('e7e5'), null);
  t.reset();
  t.actions.setupPlace('e4', null);
  t.actions.setupPlace('d4', { color: 'white', role: 'queen' });
  t.actions.setupTurn('white');
  t.actions.setupCastling('Kq');
  assert.deepEqual(t.names(), ['game:change', 'game:change', 'game:change', 'game:change']);
  assert.ok(t.of('game:change').every(p => p.reason === 'setup'));
  assert.equal(t.state.setup.pieces.find(p => p.square === 'd4').piece.role, 'queen');
  assert.equal(t.state.setup.pieces.some(p => p.square === 'e4'), false);
  t.reset();
  assert.equal(t.actions.setupCommit(), true);
  assert.equal(t.state.mode, 'play');
  assert.equal(t.state.setup, null);
  assert.deepEqual(t.names(), ['mode:change', 'game:change', 'engine:update', 'position:change']);
  assert.equal(t.of('game:change')[0].reason, 'setup');
  assert.equal(t.state.game.fen(), 'rnbqkbnr/pppppppp/8/8/3Q4/8/PPPP1PPP/RNBQKBNR w Kq - 0 1');
  assert.equal(t.state.game.root.children.length, 0);
  // illegal commit: toast + throw, stays in setup mode
  t.actions.setMode('setup');
  t.actions.setupClear();
  assert.equal(t.state.setup.pieces.length, 0);
  t.reset();
  assert.throws(() => t.actions.setupCommit(), /king|empty/);
  assert.equal(t.of('toast')[0].kind, 'error');
  assert.equal(t.state.mode, 'setup');
  t.actions.setupStart();
  assert.equal(t.state.setup.pieces.length, 32);
  assert.equal(t.state.setup.castling, 'KQkq');
  t.reset();
  t.actions.setMode('play');
  assert.deepEqual(t.of('mode:change')[0], { mode: 'play' });
  assert.equal(t.state.setup, null);
  assert.equal(t.state.game.fen(), 'rnbqkbnr/pppppppp/8/8/3Q4/8/PPPP1PPP/RNBQKBNR w Kq - 0 1', 'cancel keeps the game');
  t.st.dispose();
});

test('annotations: toggleArrow / toggleHighlight / addArrows / setHighlights / clearAnnotations / setNote / setNag', () => {
  const t = make();
  t.actions.playMove('e2e4');
  const node = t.state.game.current;
  t.reset();
  assert.equal(t.actions.toggleArrow({ from: 'g1', to: 'f3', color: 'green' }), true);
  assert.deepEqual(t.names(), ['annotations:change']);
  assert.equal(t.of('annotations:change')[0].node, node);
  assert.equal(t.actions.toggleArrow({ from: 'g1', to: 'f3', color: 'red' }), false);
  assert.equal(node.arrows.length, 0);
  assert.equal(t.actions.toggleHighlight('d5', 'red'), true);
  assert.equal(t.actions.toggleHighlight('d5', 'red'), false);
  t.actions.addArrows([{ from: 'e4', to: 'e5', color: 'red' }, { from: 'g1', to: 'f3', color: 'blue' }], 'ai');
  t.actions.addArrows([{ from: 'e4', to: 'e5', color: 'yellow' }], 'user');
  assert.deepEqual(node.arrows.map(a => [a.from, a.to, a.color, a.source]), [['g1', 'f3', 'blue', 'ai'], ['e4', 'e5', 'yellow', 'user']]);
  t.actions.setHighlights([{ square: 'e5', color: 'green' }]);
  assert.deepEqual(node.highlights, [{ square: 'e5', color: 'green' }]);
  t.reset();
  t.actions.setNote('a note');
  assert.deepEqual(t.names(), ['annotations:change', 'game:change']);
  assert.equal(t.of('game:change')[0].reason, 'note');
  assert.equal(node.note, 'a note');
  t.actions.setNag('!!');
  assert.equal(node.nag, '!!');
  t.reset();
  t.actions.clearAnnotations();
  assert.equal(node.arrows.length, 0);
  assert.equal(node.highlights.length, 0);
  assert.equal(node.note, 'a note', 'notes kept by default');
  t.actions.clearAnnotations({ notes: true });
  assert.equal(node.note, '');
  assert.equal(node.nag, '');
  t.reset();
  t.actions.setStudyTitle('Title');
  t.actions.setStudyNotes('Study notes');
  assert.deepEqual(t.names(), ['study:change', 'study:change']);
  assert.equal(t.state.study.title, 'Title');
  assert.equal(t.state.study.notes, 'Study notes');
  t.st.dispose();
});

test('settings: dotted paths, persistence, deep merge over defaults, reset', () => {
  const storage = fakeStorage();
  const t = make({ storage });
  assert.deepEqual(t.state.settings, SETTINGS_DEFAULTS);
  assert.notEqual(t.state.settings, SETTINGS_DEFAULTS, 'a copy, not the constant');
  t.actions.setSetting('engine.multipv', 5);
  assert.deepEqual(t.of('settings:change')[0].path, 'engine.multipv');
  assert.equal(t.of('settings:change')[0].value, 5);
  assert.equal(t.of('settings:change')[0].settings, t.state.settings);
  t.actions.setSetting('theme', 'metal');
  t.actions.setSetting('arrowColors.green', '#00ff00');
  t.actions.setSetting('palette', { light: '#fff', dark: '#000', frame: '#333', white: '#eee', black: '#111' });
  const stored = JSON.parse(storage.getItem(STORAGE_KEYS.settings));
  assert.equal(stored.engine.multipv, 5);
  assert.equal(stored.theme, 'metal');
  // a second store on the same storage sees the stored values merged over the defaults
  storage.setItem(STORAGE_KEYS.settings, JSON.stringify({ theme: 'glass', engine: { multipv: 2 }, arrowColors: { red: '#f00' } }));
  const t2 = make({ storage });
  assert.equal(t2.state.settings.theme, 'glass');
  assert.equal(t2.state.settings.engine.multipv, 2);
  assert.equal(t2.state.settings.engine.depth, 22, 'default kept for missing nested keys');
  assert.equal(t2.state.settings.arrowColors.red, '#f00');
  assert.equal(t2.state.settings.arrowColors.green, '#15781B');
  assert.equal(t2.state.settings.showLegalMoves, true);
  t2.reset();
  t2.actions.resetSettings();
  assert.deepEqual(t2.state.settings, SETTINGS_DEFAULTS);
  assert.equal(storage.getItem(STORAGE_KEYS.settings), null);
  assert.ok(t2.of('settings:change').some(p => p.path === 'theme' && p.value === 'wood'));
  assert.ok(t2.of('settings:change').some(p => p.path === 'engine'));
  // corrupt settings fall back to defaults
  storage.setItem(STORAGE_KEYS.settings, '{not json');
  const t3 = make({ storage });
  assert.deepEqual(t3.state.settings, SETTINGS_DEFAULTS);
  t.st.dispose(); t2.st.dispose(); t3.st.dispose();
});

test('autosave (debounced) and restore land on the same node; restore returns false when empty/corrupt', async () => {
  const storage = fakeStorage();
  const t = make({ storage });
  assert.equal(t.actions.restore(), false);
  t.actions.playMove('e2e4');
  t.actions.playMove('e7e5');
  t.actions.back();
  t.actions.playMove('c7c5');
  t.actions.setNote('sicilian');
  t.actions.setStudyTitle('Autosaved');
  t.actions.flip();
  assert.equal(storage.getItem(STORAGE_KEYS.study), null, 'not written synchronously');
  await wait(40);
  const saved = JSON.parse(storage.getItem(STORAGE_KEYS.study));
  assert.equal(saved.title, 'Autosaved');
  assert.equal(saved.orientation, 'black');
  assert.deepEqual(saved.cursor, [0, 1]);
  const t2 = make({ storage });
  t2.reset();
  assert.equal(t2.actions.restore(), true);
  assert.equal(t2.state.study.title, 'Autosaved');
  assert.equal(t2.state.orientation, 'black');
  assert.equal(t2.state.game.current.san, 'c5');
  assert.equal(t2.state.game.current.note, 'sicilian');
  assert.deepEqual(t2.state.game.root.children[0].children.map(n => n.san), ['e5', 'c5']);
  assert.deepEqual(t2.names(), ['orientation:change', 'study:change', 'game:change', 'engine:update', 'position:change']);
  assert.equal(t2.of('game:change')[0].reason, 'load');
  storage.setItem(STORAGE_KEYS.study, '{"version":1,"game":{"version":1,"startFen":"nonsense"}}');
  const t3 = make({ storage });
  assert.equal(t3.actions.restore(), false);
  assert.equal(t3.actions.autosave(), true, 'explicit autosave writes immediately');
  assert.ok(storage.getItem(STORAGE_KEYS.study).includes('"startFen"'));
  const noStorage = createStore({ storage: null });
  assert.equal(noStorage.actions.autosave(), false);
  assert.equal(noStorage.actions.restore(), false);
  t.st.dispose(); t2.st.dispose(); t3.st.dispose(); noStorage.dispose();
});

test('engine actions: status, lines stored as node eval, stale fen ignored, priming on navigation', () => {
  const t = make();
  t.actions.engineStatus({ available: true, enabled: true, thinking: true });
  assert.equal(t.state.engine.available, true);
  assert.equal(t.of('engine:update').length, 1);
  t.actions.playMove('e2e4');
  const e4 = t.state.game.current;
  t.reset();
  const lines = [
    { multipv: 1, score: { cp: 35 }, depth: 18, pv: ['e7e5', 'g1f3'], san: ['e5', 'Nf3'] },
    { multipv: 2, score: { cp: 20 }, depth: 18, pv: ['c7c5'], san: ['c5'] },
  ];
  t.actions.engineLines(lines, { cp: 35 }, 18, 'e7e5');
  assert.deepEqual(t.names(), ['engine:update']);
  assert.equal(t.state.engine.lines, lines);
  assert.deepEqual(t.state.engine.score, { cp: 35 });
  assert.equal(t.state.engine.depth, 18);
  assert.equal(t.state.engine.bestMove, 'e7e5');
  assert.deepEqual(e4.eval, { cp: 35, depth: 18, pv: ['e7e5', 'g1f3'], best: 'e5' });
  t.actions.engineLines([{ multipv: 1, score: { cp: 10 }, depth: 5, pv: ['d7d5'] }], { cp: 10 }, 5, 'd7d5');
  assert.equal(e4.eval.depth, 18, 'a shallower search does not overwrite');
  t.actions.engineLines([{ multipv: 1, score: { mate: 4 }, depth: 30, pv: ['d7d5'] }], { mate: 4 }, 30, 'd7d5', 'some other fen');
  assert.equal(e4.eval.depth, 18, 'stale fen ignored');
  t.actions.engineLines([{ multipv: 1, score: { mate: 4 }, depth: 30, pv: ['d7d5'] }], { mate: 4 }, 30, 'd7d5', t.state.game.fen());
  assert.deepEqual(e4.eval, { mate: 4, depth: 30, pv: ['d7d5'], best: 'd5' });
  t.reset();
  t.actions.back();
  const primed = t.of('engine:update');
  assert.equal(primed.length, 1);
  assert.equal(primed[0].engine.score, null, 'root has no eval: cleared');
  assert.equal(primed[0].engine.bestMove, null);
  assert.deepEqual(primed[0].engine.lines, []);
  t.reset();
  t.actions.forward();
  const e = t.of('engine:update')[0].engine;
  assert.deepEqual(e.score, { mate: 4 });
  assert.equal(e.depth, 30);
  assert.equal(e.bestMove, 'd7d5');
  assert.deepEqual(e.lines[0].san, ['d5']);
  t.actions.engineSetPlayAs('black');
  assert.equal(t.state.engine.playAs, 'black');
  t.actions.engineSetPlayAs('nope');
  assert.equal(t.state.engine.playAs, null);
  t.st.dispose();
});

test('ai and ui actions', () => {
  const t = make();
  t.actions.aiMessage({ role: 'user', text: 'hi' });
  t.actions.aiMessage('hello');
  assert.equal(t.state.ai.messages.length, 2);
  assert.equal(t.state.ai.messages[0].role, 'user');
  assert.equal(t.state.ai.messages[1].role, 'assistant');
  assert.ok(t.state.ai.messages[1].at);
  t.actions.aiBusy(true);
  assert.equal(t.state.ai.busy, true);
  t.actions.aiError('boom');
  assert.equal(t.state.ai.lastError, 'boom');
  assert.equal(t.state.ai.busy, false);
  t.actions.aiClear();
  assert.deepEqual(t.state.ai.messages, []);
  assert.equal(t.state.ai.lastError, null);
  assert.equal(t.of('ai:update').length, 5);
  t.reset();
  t.actions.setPanel('engine');
  assert.deepEqual(t.of('ui:change')[0].ui, { panel: 'engine', collapsed: false });
  t.actions.setPanel('bogus');
  assert.equal(t.state.ui.panel, 'engine');
  t.actions.toggleCollapsed();
  assert.equal(t.state.ui.collapsed, true);
  t.actions.toast('hey', 'ok');
  assert.deepEqual(t.of('toast')[0], { text: 'hey', kind: 'ok' });
  t.actions.toast('x', 'weird');
  assert.equal(t.of('toast')[1].kind, 'info');
  t.st.dispose();
});

test('new games and loaders: newGame, newChess960, loadFen, loadPgn, loadYaml, loadStudy; failures toast and return false', () => {
  const t = make();
  t.actions.playMove('e2e4');
  t.actions.setStudyTitle('old');
  t.reset();
  t.actions.newGame();
  assert.equal(t.state.game.fen(), INITIAL_FEN);
  assert.equal(t.state.study.title, '');
  assert.equal(t.of('game:change')[0].reason, 'new');
  assert.equal(t.of('position:change').length, 1);
  assert.equal(t.actions.newChess960(5), 5);
  assert.equal(t.state.game.variant, 'chess960');
  assert.equal(t.state.game.chess960Number, 5);
  const rnd = t.actions.newChess960();
  assert.ok(rnd >= 0 && rnd <= 959);
  t.reset();
  assert.equal(t.actions.loadFen('bad fen'), false);
  assert.deepEqual(t.names(), ['toast']);
  assert.match(t.of('toast')[0].text, /FEN/);
  assert.equal(t.actions.loadFen('4k3/8/8/8/8/8/8/4K2R w K - 0 1'), true);
  assert.equal(t.state.game.variant, 'standard');
  t.reset();
  assert.equal(t.actions.loadPgn('[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Nf3 (2. Nc3) 2... Nc6 *'), true);
  assert.equal(t.state.study.title, 'A - B');
  assert.deepEqual(t.state.game.mainline().map(n => n.san), [null, 'e4', 'e5', 'Nf3', 'Nc6']);
  assert.equal(t.state.game.current, t.state.game.root);
  assert.equal(t.actions.loadPgn(''), false);
  t.reset();
  t.actions.loadPgn('1. e4 e5 2. Ke3 *');
  assert.ok(t.of('toast').some(p => /dropped/.test(p.text)), 'import warnings are toasted');
  const yaml = studyToYaml({ title: 'Y', created: '2026-09-17', notes: 'n', orientation: 'black', game: (() => { const g = Game.standard(); g.play('d2d4'); return g; })() });
  t.reset();
  assert.equal(t.actions.loadYaml(yaml), true);
  assert.equal(t.state.study.title, 'Y');
  assert.equal(t.state.orientation, 'black');
  assert.deepEqual(t.of('orientation:change')[0], { orientation: 'black' });
  assert.equal(t.state.game.mainline().at(-1).san, 'd4');
  assert.equal(t.actions.loadYaml('::: not yaml'), false);
  const g = Game.standard();
  g.play('c2c4');
  assert.equal(t.actions.loadStudy({ title: 'S', created: '2026-01-01', notes: '', orientation: 'white', game: g }), true);
  assert.equal(t.state.game, g);
  assert.equal(t.state.orientation, 'white');
  assert.equal(t.actions.loadStudy({ title: 'J', game: g.toJSON() }), true);
  assert.equal(t.state.game.mainline().at(-1).san, 'c4');
  assert.equal(t.actions.loadStudy(null), false);
  // loading while in setup mode leaves setup
  t.actions.setMode('setup');
  t.reset();
  t.actions.loadFen(INITIAL_FEN);
  assert.equal(t.state.mode, 'play');
  assert.deepEqual(t.of('mode:change')[0], { mode: 'play' });
  t.st.dispose();
});

test('flip / setOrientation', () => {
  const t = make();
  t.actions.flip();
  assert.deepEqual(t.of('orientation:change')[0], { orientation: 'black' });
  t.actions.setOrientation('black');
  assert.equal(t.of('orientation:change').length, 1, 'no event when unchanged');
  t.actions.setOrientation('white');
  assert.equal(t.state.orientation, 'white');
  t.st.dispose();
});

// ───────────── regressions (reviewed defects, 2026-09-18) ─────────────

test('loadPgn refuses text that yields no moves and no real headers, leaving the study intact', () => {
  const junk = [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'this is not a pgn at all',
    '{"version":1}',
    'chessboard: 1\nmoves:\n  - {san: e4}',
    '*',
  ];
  for (const text of junk) {
    const t = make();
    t.actions.playMove('e2e4');
    t.actions.setStudyTitle('precious');
    t.reset();
    assert.equal(t.actions.loadPgn(text), false, `should refuse ${JSON.stringify(text.slice(0, 20))}`);
    assert.equal(t.state.game.nodeCount() - 1, 1, 'previous game untouched');
    assert.equal(t.state.study.title, 'precious', 'previous study untouched');
    assert.deepEqual(t.names(), ['toast']);
    assert.equal(t.of('toast')[0].kind, 'error');
    assert.match(t.of('toast')[0].text, /^PGN: /);
    t.st.dispose();
  }
  // Real content still loads: moves, a header-only PGN, a FEN-header PGN.
  const good = [['1. e4 e5 2. Nf3 *', 3], ['[Event "X"]\n\n*', 0], ['[FEN "4k3/8/8/8/8/8/8/4K3 w - - 0 1"]\n[SetUp "1"]\n\n*', 0]];
  for (const [text, moves] of good) {
    const t = make();
    assert.equal(t.actions.loadPgn(text), true, `should load ${JSON.stringify(text.slice(0, 20))}`);
    assert.equal(t.state.game.nodeCount() - 1, moves);
    assert.equal(t.of('toast').length, 0);
    t.st.dispose();
  }
});

test('a corrupt settings sub-object falls back to the default for that key instead of breaking boot', () => {
  for (const blob of [{ theme: 'metal', engine: null }, { ai: null }, { engine: 'yes' }, { arrowColors: null }, { ai: ['nope'] }]) {
    const storage = fakeStorage();
    storage.mem.set(STORAGE_KEYS.settings, JSON.stringify(blob));
    const st = createStore({ storage, autosaveDelay: 10 });
    const s = st.state.settings;
    assert.deepEqual(s.engine, SETTINGS_DEFAULTS.engine, `engine defaults for ${JSON.stringify(blob)}`);
    assert.deepEqual(s.ai, SETTINGS_DEFAULTS.ai, `ai defaults for ${JSON.stringify(blob)}`);
    assert.deepEqual(s.arrowColors, SETTINGS_DEFAULTS.arrowColors);
    assert.equal(st.state.engine.enabled, false);
    assert.equal(st.state.ai.provider, 'packet');
    st.dispose();
  }
  // A well-formed partial sub-object still merges over the defaults.
  const storage = fakeStorage();
  storage.mem.set(STORAGE_KEYS.settings, JSON.stringify({ theme: 'glass', engine: { multipv: 5 } }));
  const st = createStore({ storage, autosaveDelay: 10 });
  assert.equal(st.state.settings.theme, 'glass');
  assert.equal(st.state.settings.engine.multipv, 5);
  assert.equal(st.state.settings.engine.depth, SETTINGS_DEFAULTS.engine.depth);
  st.dispose();
});

test('setup scratch keeps the en-passant square and the clocks; a no-op commit is a no-op', () => {
  const t = make();
  const fen = 'rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3';
  t.actions.loadFen(fen);
  assert.equal(t.state.game.moveToSan({ from: 'e5', to: 'f6' }), 'exf6');
  t.actions.setMode('setup');
  assert.equal(t.state.setup.epSquare, 'f6');
  assert.equal(t.state.setup.halfmoves, 0);
  assert.equal(t.state.setup.fullmoves, 3);
  t.actions.setupCommit();
  assert.equal(t.state.game.fen(), fen, 'committing without edits changes nothing');
  assert.equal(t.state.game.moveToSan({ from: 'e5', to: 'f6' }), 'exf6', 'the e.p. capture survives');
  // Clocks survive too (root.ply follows the fullmove number).
  t.actions.loadFen('8/8/8/4k3/8/8/8/R3K3 w Q - 98 60');
  t.actions.setMode('setup');
  t.actions.setupCommit();
  assert.equal(t.state.game.fen(), '8/8/8/4k3/8/8/8/R3K3 w Q - 98 60');
  assert.equal(t.state.game.root.ply, 118);
  // An edit that removes the double-pushed pawn drops the e.p. square instead of throwing.
  t.actions.loadFen(fen);
  t.actions.setMode('setup');
  t.actions.setupPlace('f5', null);
  t.actions.setupCommit();
  assert.equal(t.state.game.fen(), 'rnbqkbnr/ppp1p1pp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq - 0 3');
  t.st.dispose();
});

test('the engine block follows the current node, not only the fen', () => {
  const line = [{ multipv: 1, score: { cp: 30 }, depth: 20, pv: ['e7e5'], san: ['e5'] }];
  // Cancelling setup mode re-primes from the node (the engine module blanks its block on mode:change).
  const t = make();
  t.actions.playMove('e2e4');
  t.actions.engineLines(line, { cp: 30 }, 20, 'e7e5');
  t.actions.setMode('setup');
  t.actions.engineLines([], null, 0, null);
  t.reset();
  t.actions.setMode('play');
  assert.deepEqual(t.names(), ['mode:change', 'engine:update']);
  assert.deepEqual(t.state.engine.score, { cp: 30 });
  assert.equal(t.state.engine.lines.length, 1);
  assert.equal(t.state.engine.bestMove, 'e7e5');
  // The inverse: loading the fen we are already on swaps in a fresh (eval-less) node.
  t.reset();
  t.actions.loadFen(t.state.game.fen());
  assert.equal(t.state.game.current.eval, null);
  assert.equal(t.state.engine.score, null, 'no stale eval for a node that has none');
  assert.equal(t.state.engine.lines.length, 0);
  assert.ok(t.names().includes('engine:update'));
  t.st.dispose();
});

test('completing a promotion emits game:change before the selection is cleared', () => {
  const t = make();
  t.actions.loadFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  t.actions.select('a7');
  assert.equal(t.actions.attemptMove({ from: 'a7', to: 'a8' }), 'promotion');
  assert.equal(t.state.selected, 'a7', 'the origin stays selected while the picker is open');
  t.reset();
  t.actions.playMove({ from: 'a7', to: 'a8', promotion: 'q' });
  const order = t.names().filter(n => n === 'game:change' || n === 'selection:change');
  assert.deepEqual(order, ['game:change', 'selection:change']);
  assert.equal(t.state.game.current.san, 'a8=Q+');
  t.st.dispose();

  // The integrator's cancel detection ("deselected while a promotion is pending") must not misfire.
  const run = complete => {
    const s = createStore({ storage: fakeStorage(), autosaveDelay: 10 });
    let pending = null;
    let cancels = 0;
    s.on('promotion:required', p => { pending = p; });
    s.on('game:change', () => { pending = null; });
    s.on('selection:change', ({ selected }) => { if (!selected && pending) { pending = null; cancels++; } });
    s.actions.loadFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
    s.actions.select('a7');
    s.actions.attemptMove({ from: 'a7', to: 'a8' });
    if (complete) s.actions.playMove({ from: 'a7', to: 'a8', promotion: 'q' });
    else s.actions.select(null);
    s.dispose();
    return cancels;
  };
  assert.equal(run(true), 0, 'a completed promotion is not read as a cancel');
  assert.equal(run(false), 1, 'a real cancel is still detected');
});

test('state.ai.provider mirrors settings.ai.provider through setSetting and resetSettings', () => {
  const t = make();
  t.reset();
  t.actions.setSetting('ai.provider', 'local');
  assert.equal(t.state.ai.provider, 'local');
  assert.deepEqual(t.of('ai:update').map(p => p.ai.provider), ['local']);
  t.actions.setSetting('ai.provider', 'local');
  assert.equal(t.of('ai:update').length, 1, 'no event when unchanged');
  t.actions.resetSettings();
  assert.equal(t.state.settings.ai.provider, 'packet');
  assert.equal(t.state.ai.provider, 'packet', 'reset cannot leave the panel and the router disagreeing');
  t.actions.setSetting('ai', { ...SETTINGS_DEFAULTS.ai, provider: 'anthropic' });
  assert.equal(t.state.ai.provider, 'anthropic');
  t.st.dispose();
});

test('engineLines schedules an autosave when it writes a node eval', async () => {
  const t = make();
  t.actions.playMove('e2e4');
  await wait(30);
  t.storage.mem.delete(STORAGE_KEYS.study);
  t.actions.engineLines([{ multipv: 1, score: { cp: 30 }, depth: 20, pv: ['e7e5'], san: ['e5'] }], { cp: 30 }, 20, 'e7e5');
  await wait(40);
  assert.ok(t.storage.mem.has(STORAGE_KEYS.study), 'the eval reached storage without another change');
  const saved = JSON.parse(t.storage.mem.get(STORAGE_KEYS.study));
  assert.equal(saved.game.tree.children[0].eval.cp, 30);
  // Lines for another position write nothing and must not trigger a save either.
  t.storage.mem.delete(STORAGE_KEYS.study);
  t.actions.engineLines([{ multipv: 1, score: { cp: 5 }, depth: 30, pv: ['d7d5'], san: ['d5'] }], { cp: 5 }, 30, 'd7d5', 'stale fen');
  await wait(40);
  assert.equal(t.storage.mem.has(STORAGE_KEYS.study), false);
  t.st.dispose();
});

test('a stored pv that is illegal in the position is not shown as a best move', () => {
  const t = make();
  t.actions.playMove('e2e4');
  const n = t.state.game.current;
  t.state.game.setEval(n.id, { cp: 10, depth: 9, pv: ['a1a8', 'e7e5'] });
  t.actions.back();
  t.actions.forward();
  assert.equal(t.state.engine.bestMove, null, 'no arrow for an illegal move');
  assert.deepEqual(t.state.engine.lines, []);
  assert.deepEqual(t.state.engine.score, { cp: 10 }, 'the score itself is still usable');
  assert.equal(t.state.engine.depth, 9);
  // A pv that starts legally is kept, truncated at the first illegal move by pvToSan.
  t.state.game.setEval(t.state.game.current.id, { cp: 10, depth: 9, pv: ['e7e5', 'zzzz'] });
  t.actions.back();
  t.actions.forward();
  assert.equal(t.state.engine.bestMove, 'e7e5');
  assert.deepEqual(t.state.engine.lines[0].san, ['e5']);
  t.st.dispose();
});

test('a malformed-YAML toast carries the YAML prefix exactly once', () => {
  const t = make();
  t.actions.loadYaml('chessboard: 1\nmoves: [');
  t.actions.loadYaml('- a list\n');
  t.actions.loadYaml('chessboard: 1\nstart_fen: nonsense\n');
  const texts = t.of('toast').map(p => p.text);
  assert.equal(texts.length, 3);
  for (const text of texts) {
    assert.match(text, /^YAML: /);
    assert.doesNotMatch(text, /^YAML: YAML: /);
  }
  t.st.dispose();
});

// ───────────── addendum v1: view mode, self-play, clock (2026-09-18) ─────────────

// A store whose clock is driven by a fake `now`: t.at(ms) moves the fake forward, t.pump() runs one
// ticker cycle. Nothing here depends on real time, so the tests are deterministic on any machine.
function timed(opts = {}) {
  let fake = 1_000_000;
  const t = make({ now: () => fake, ...opts });
  t.at = ms => { fake += ms; return fake; };
  t.pump = () => t.st.tickClock();
  t.clock = () => t.state.clock;
  return t;
}

test('the new settings (viewMode, pieceSet2d, lighting, selfPlay) have defaults and survive old or corrupt blobs', () => {
  const t = make();
  assert.equal(t.state.settings.viewMode, '3d');
  assert.equal(t.state.settings.pieceSet2d, 'glyph');
  assert.deepEqual(t.state.settings.lighting, {
    preset: 'studio', on: true, exposure: 1.0, key: 1.0, ambient: 1.0, shadows: true, contrast: true,
  });
  assert.deepEqual(t.state.settings.selfPlay, {
    rotate: true, autoFlip: true, opponent: 'self', aiStyle: 'annotate', timeControl: { initial: 300000, increment: 0 },
  });
  assert.equal(t.state.viewMode, '3d');
  assert.deepEqual(t.state.selfPlay, { on: false, opponent: 'self', awaiting: null, playerSide: 'white' });
  assert.deepEqual(t.state.clock, {
    running: false, white: 300000, black: 300000, turn: null, increment: 0, initial: 300000, flagged: null, startedAt: null,
  });
  t.st.dispose();

  // Settings stored before this round (no viewMode / lighting / selfPlay at all) get the new defaults.
  const old = fakeStorage();
  old.mem.set(STORAGE_KEYS.settings, JSON.stringify({ theme: 'metal', engine: { multipv: 2 } }));
  const t2 = make({ storage: old });
  assert.equal(t2.state.settings.theme, 'metal');
  assert.equal(t2.state.settings.viewMode, '3d');
  assert.equal(t2.state.settings.pieceSet2d, 'glyph');
  assert.deepEqual(t2.state.settings.lighting, SETTINGS_DEFAULTS.lighting);
  assert.deepEqual(t2.state.settings.selfPlay, SETTINGS_DEFAULTS.selfPlay);
  t2.st.dispose();

  // Corrupt values fall back per key instead of breaking boot.
  const blobs = [
    { lighting: null },
    { lighting: 'bright' },
    { selfPlay: null },
    { selfPlay: ['self'] },
    { selfPlay: { timeControl: null, opponent: 'nonsense' } },
    { viewMode: {}, pieceSet2d: null },
  ];
  for (const blob of blobs) {
    const storage = fakeStorage();
    storage.mem.set(STORAGE_KEYS.settings, JSON.stringify(blob));
    const st = createStore({ storage, autosaveDelay: 10 });
    const s = st.state.settings;
    assert.deepEqual(s.lighting, SETTINGS_DEFAULTS.lighting, `lighting for ${JSON.stringify(blob)}`);
    assert.deepEqual(s.selfPlay.timeControl, SETTINGS_DEFAULTS.selfPlay.timeControl, `timeControl for ${JSON.stringify(blob)}`);
    assert.equal(st.state.viewMode, '3d', `viewMode for ${JSON.stringify(blob)}`);
    assert.equal(st.state.selfPlay.opponent, 'self', `opponent for ${JSON.stringify(blob)}`);
    assert.equal(st.state.clock.initial, 300000);
    st.dispose();
  }
  // A partial, well-formed block still merges over the defaults.
  const storage = fakeStorage();
  storage.mem.set(STORAGE_KEYS.settings, JSON.stringify({ viewMode: '2d', lighting: { on: false, exposure: 1.4 }, selfPlay: { opponent: 'engine' } }));
  const st = createStore({ storage, autosaveDelay: 10 });
  assert.equal(st.state.viewMode, '2d', 'viewMode is restored at boot');
  assert.equal(st.state.settings.lighting.on, false);
  assert.equal(st.state.settings.lighting.exposure, 1.4);
  assert.equal(st.state.settings.lighting.preset, 'studio', 'untouched lighting keys keep their default');
  assert.equal(st.state.selfPlay.opponent, 'engine');
  st.dispose();
});

test('a fresh profile gets the modelled Classic set; a saved piece set is kept', () => {
  assert.equal(SETTINGS_DEFAULTS.pieceSet, 'classic');
  const t = make();
  assert.equal(t.state.settings.pieceSet, 'classic', 'nothing stored: Classic');
  t.st.dispose();
  for (const saved of ['staunton', 'minimal', 'cairn', 'gltf-my-set-abc']) {
    const storage = fakeStorage();
    storage.mem.set(STORAGE_KEYS.settings, JSON.stringify({ theme: 'wood', pieceSet: saved }));
    const st = createStore({ storage, autosaveDelay: 10 });
    assert.equal(st.state.settings.pieceSet, saved, `a stored '${saved}' wins over the new default`);
    st.dispose();
  }
  // any settings write persists the whole blob, so the default a profile booted with is its saved choice
  const storage = fakeStorage();
  const t2 = make({ storage });
  t2.actions.setSetting('theme', 'metal');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.settings)).pieceSet, 'classic');
  t2.st.dispose();
});

test('setViewMode / toggleViewMode: state, event, persistence', () => {
  const storage = fakeStorage();
  const t = make({ storage });
  assert.equal(t.actions.setViewMode('4d'), false, 'unknown modes are refused');
  assert.equal(t.actions.setViewMode('3d'), false, 'already there');
  assert.deepEqual(t.names(), []);
  assert.equal(t.actions.setViewMode('2d'), true);
  assert.equal(t.state.viewMode, '2d');
  assert.deepEqual(t.of('viewmode:change'), [{ mode: '2d', previous: '3d' }]);
  assert.equal(t.state.settings.viewMode, '2d');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.settings)).viewMode, '2d');
  assert.ok(t.of('settings:change').some(p => p.path === 'viewMode' && p.value === '2d'));
  t.reset();
  t.actions.toggleViewMode();
  assert.equal(t.state.viewMode, '3d');
  assert.deepEqual(t.of('viewmode:change'), [{ mode: '3d', previous: '2d' }]);
  // Writing the setting directly (a settings panel select) drives the mode too, exactly once.
  t.reset();
  t.actions.setSetting('viewMode', '2d');
  assert.equal(t.state.viewMode, '2d');
  assert.deepEqual(t.of('viewmode:change'), [{ mode: '2d', previous: '3d' }]);
  t.reset();
  t.actions.resetSettings();
  assert.equal(t.state.viewMode, '3d', 'a settings reset takes the view back to 3D');
  assert.deepEqual(t.of('viewmode:change'), [{ mode: '3d', previous: '2d' }]);
  t.st.dispose();
});

test('self-play against yourself: the seat follows the side to move, and nothing is locked', () => {
  const t = timed();
  assert.equal(t.actions.startSelfPlay({ opponent: 'self', timeControl: { initial: 0, increment: 0 } }), true);
  assert.equal(t.state.selfPlay.on, true);
  assert.equal(t.state.selfPlay.opponent, 'self');
  assert.equal(t.state.selfPlay.playerSide, 'white');
  assert.deepEqual(t.of('selfplay:change').at(-1).selfPlay, t.state.selfPlay);
  assert.equal(t.clock().running, false, 'an untimed control never starts the clock');
  t.reset();
  t.actions.playMove('e2e4');
  assert.equal(t.state.orientation, 'black', 'the board turns to the side now to move');
  assert.deepEqual(t.of('orientation:change'), [{ orientation: 'black' }]);
  // Both sides stay movable by hand — self-play adds no ownership lock.
  assert.equal(t.actions.attemptMove({ from: 'e7', to: 'e5' }), 'played');
  assert.equal(t.state.orientation, 'white');
  assert.equal(t.state.game.current.san, 'e5');
  // autoFlip off: the seat stays put.
  t.actions.setSetting('selfPlay.autoFlip', false);
  t.reset();
  t.actions.playMove('g1f3');
  assert.equal(t.state.orientation, 'white');
  assert.deepEqual(t.of('orientation:change'), []);
  // Navigating never rotates the seat either.
  t.actions.setSetting('selfPlay.autoFlip', true);
  t.reset();
  t.actions.back();
  t.actions.toStart();
  t.actions.toEnd();
  assert.deepEqual(t.of('orientation:change'), []);
  t.actions.stopSelfPlay();
  assert.equal(t.state.selfPlay.on, false);
  t.reset();
  t.actions.playMove('b8c6');
  assert.deepEqual(t.of('orientation:change'), [], 'no rotation once self-play is off');
  t.st.dispose();
});

test('self-play against the engine delegates to engine.setPlayAs and gives it back on stop', () => {
  const t = make();
  const calls = [];
  const engine = { setPlayAs(c) { calls.push(c); t.actions.engineSetPlayAs(c); } };
  t.actions.registerEngine(engine);
  t.actions.startSelfPlay({ opponent: 'engine', timeControl: { initial: 0 } });
  assert.deepEqual(calls, ['black'], 'the engine takes the side she is not on');
  assert.equal(t.state.engine.playAs, 'black');
  assert.equal(t.state.selfPlay.awaiting, null, 'awaiting is only for the AI opponent');
  // Flipping the board mid-game does not hand her side to the engine.
  t.actions.flip();
  t.actions.playMove('e2e4');
  assert.deepEqual(calls, ['black']);
  t.actions.setSelfPlayOpponent('self');
  assert.deepEqual(calls, ['black', null], 'switching opponent releases the engine');
  assert.equal(t.state.engine.playAs, null);
  t.actions.setSelfPlayOpponent('engine');
  assert.deepEqual(calls, ['black', null, 'black']);
  t.actions.stopSelfPlay();
  assert.deepEqual(calls, ['black', null, 'black', null]);
  // A manual "play as" from the engine panel is never clobbered by a self-play action she did not aim at it.
  t.actions.engineSetPlayAs('white');
  t.actions.setSelfPlayOpponent('ai');
  assert.equal(t.state.engine.playAs, 'white');
  t.st.dispose();

  // Without registerEngine the store still records the delegation in state (the fallback path).
  const t2 = make();
  t2.actions.startSelfPlay({ opponent: 'engine', playAs: 'black', timeControl: { initial: 0 } });
  assert.equal(t2.state.selfPlay.playerSide, 'black');
  assert.equal(t2.state.engine.playAs, 'white');
  t2.st.dispose();
});

test('self-play against the AI sets selfPlay.awaiting for the MCP bridge', () => {
  const t = make();
  t.actions.startSelfPlay({ opponent: 'ai', timeControl: { initial: 0 } });
  assert.equal(t.state.selfPlay.awaiting, null, 'it is her move');
  t.reset();
  t.actions.playMove('e2e4');
  assert.equal(t.state.selfPlay.awaiting, 'black');
  assert.deepEqual(t.of('selfplay:change').at(-1).selfPlay.awaiting, 'black');
  // The bridge answers with a move through the normal action: awaiting clears by itself.
  t.actions.playMove('e7e5');
  assert.equal(t.state.selfPlay.awaiting, null);
  t.actions.playMove('g1f3');
  assert.equal(t.state.selfPlay.awaiting, 'black');
  assert.equal(t.actions.clearSelfPlayAwaiting(), true, 'the bridge can give up');
  assert.equal(t.state.selfPlay.awaiting, null);
  // Navigation does not ask the AI for a move.
  t.reset();
  t.actions.back();
  t.actions.forward();
  assert.equal(t.state.selfPlay.awaiting, null);
  assert.deepEqual(t.of('selfplay:change'), []);
  // A finished game never leaves a request hanging.
  t.actions.loadFen('rnbqkbnr/ppppp2p/8/5pp1/8/4P3/PPPP1PPP/RNBQKBNR w KQkq - 0 3');
  t.actions.playMove('d1h5');
  assert.equal(t.state.game.status().checkmate, true);
  assert.equal(t.state.selfPlay.awaiting, null, 'checkmate ends the request');
  t.actions.stopSelfPlay();
  assert.equal(t.state.selfPlay.awaiting, null);
  t.st.dispose();
});

test('the clock burns on a played move, takes the increment and is untouched by navigation', () => {
  const t = timed();
  t.actions.startSelfPlay({ opponent: 'self', timeControl: { initial: 10000, increment: 1000 } });
  assert.equal(t.clock().running, true);
  assert.equal(t.clock().turn, 'white');
  assert.deepEqual([t.clock().white, t.clock().black], [10000, 10000]);
  assert.ok(t.of('clock:change').length >= 1);
  t.at(3000);
  t.reset();
  t.actions.playMove('e2e4');
  assert.deepEqual([t.clock().white, t.clock().black], [8000, 10000], '10000 - 3000 + 1000');
  assert.equal(t.clock().turn, 'black');
  assert.deepEqual(t.of('clock:change').map(p => p.clock.turn), ['black']);
  // Navigation burns nothing and emits nothing, however much wall time passes.
  const before = { ...t.clock() };
  t.at(5000);
  t.reset();
  t.actions.back();
  t.actions.toStart();
  t.actions.forward();
  t.actions.goto(t.state.game.root.children[0].id);
  assert.deepEqual({ ...t.clock() }, before, 'navigating the tree never touches the clock');
  assert.deepEqual(t.of('clock:change'), []);
  assert.deepEqual(t.of('clock:tick'), []);
  // A tick charges the side to move only, and emits clock:tick.
  t.at(2000);
  t.reset();
  assert.equal(t.pump(), true);
  assert.deepEqual([t.clock().white, t.clock().black], [8000, 3000], 'black held the move for 7 s');
  assert.deepEqual(t.of('clock:tick'), [{ white: 8000, black: 3000, turn: 'black', flagged: null }]);
  t.at(1000);
  t.actions.playMove('e7e5');
  assert.deepEqual([t.clock().white, t.clock().black], [8000, 3000], '3000 - 1000 + 1000');
  assert.equal(t.clock().turn, 'white');
  t.st.dispose();
});

test('an untimed clock never runs and never ticks', () => {
  const t = timed();
  t.actions.setTimeControl({ initial: 0, increment: 0 });
  t.reset();
  t.actions.startSelfPlay({ opponent: 'self' });
  assert.equal(t.clock().running, false);
  assert.equal(t.clock().initial, 0);
  assert.equal(t.actions.clockStart(), false);
  assert.equal(t.actions.clockResume(), false);
  assert.equal(t.actions.clockPause(), false);
  t.at(60000);
  assert.equal(t.pump(), false, 'the ticker stands down');
  t.actions.playMove('e2e4');
  t.at(60000);
  t.actions.playMove('e7e5');
  assert.deepEqual({ ...t.clock() }, {
    running: false, white: 0, black: 0, turn: null, increment: 0, initial: 0, flagged: null, startedAt: null,
  });
  assert.deepEqual(t.of('clock:tick'), []);
  assert.equal(t.actions.clockFlag('white'), false, 'an untimed clock cannot flag');
  t.st.dispose();
});

test('flagging happens once, stops the clock, toasts, and does not fake a checkmate', () => {
  const t = timed();
  t.actions.startSelfPlay({ opponent: 'self', timeControl: { initial: 4000, increment: 0 } });
  t.actions.playMove('e2e4');            // white -> black, black now burning
  t.reset();
  t.at(9000);
  assert.equal(t.pump(), true);
  assert.equal(t.clock().flagged, 'black');
  assert.equal(t.clock().black, 0);
  assert.equal(t.clock().running, false);
  assert.equal(t.of('clock:change').length, 1);
  assert.deepEqual(t.of('clock:change')[0].clock, t.state.clock);
  assert.deepEqual(t.of('toast'), [{ text: 'Black lost on time', kind: 'info' }]);
  assert.deepEqual(t.of('clock:tick'), [], 'a flag is a structural change, not a tick');
  // The rules are untouched: no fake checkmate, no outcome.
  const status = t.state.game.status();
  assert.equal(status.checkmate, false);
  assert.equal(status.outcome, null);
  // Exactly once: further pumps and an explicit clockFlag change nothing.
  t.reset();
  t.at(9000);
  assert.equal(t.pump(), false);
  assert.equal(t.actions.clockFlag('black'), false);
  assert.equal(t.actions.clockFlag('white'), false);
  assert.deepEqual(t.names(), []);
  // The position is still playable by hand after a flag; the clock stays frozen.
  const frozen = { ...t.clock() };
  t.at(5000);
  assert.equal(t.actions.playMove('e7e5').san, 'e5');
  assert.deepEqual({ ...t.clock() }, frozen);
  // A reset clears the flag and puts both sides back.
  t.actions.clockReset();
  assert.equal(t.clock().flagged, null);
  assert.deepEqual([t.clock().white, t.clock().black], [4000, 4000]);
  t.st.dispose();
});

test('the time control is refused while the clock runs, and accepted once it is paused', () => {
  const t = timed();
  t.actions.startSelfPlay({ opponent: 'self', timeControl: { initial: 60000, increment: 0 } });
  t.at(1000);
  t.reset();
  assert.equal(t.actions.setTimeControl({ initial: 120000, increment: 5000 }), false);
  assert.equal(t.clock().initial, 60000);
  assert.deepEqual(t.of('toast')[0].kind, 'error');
  assert.deepEqual(t.of('clock:change'), []);
  // Pause, change, resume.
  assert.equal(t.actions.clockPause(), true);
  assert.equal(t.clock().white, 59000);
  assert.equal(t.clock().running, false);
  t.at(30000);
  assert.equal(t.pump(), false, 'a paused clock does not tick');
  assert.equal(t.clock().white, 59000, 'time spent paused costs nothing');
  assert.equal(t.actions.setTimeControl({ initial: 120000, increment: 5000 }), true);
  assert.deepEqual([t.clock().white, t.clock().black, t.clock().increment], [120000, 120000, 5000]);
  assert.equal(t.clock().turn, null, 'a new time control resets the clock');
  assert.deepEqual(t.state.settings.selfPlay.timeControl, { initial: 120000, increment: 5000 });
  assert.equal(t.actions.clockResume(), false, 'nothing to resume after a reset');
  assert.equal(t.actions.clockStart(), true);
  assert.equal(t.clock().turn, 'white');
  t.at(2000);
  assert.equal(t.actions.clockPause(), true);
  assert.equal(t.clock().white, 118000);
  assert.equal(t.actions.clockResume(), true);
  t.at(2000);
  t.pump();
  assert.equal(t.clock().white, 116000);
  // Stopping self-play pauses the clock without touching the game.
  const fenBefore = t.state.game.fen();
  t.reset();
  t.actions.stopSelfPlay();
  assert.equal(t.clock().running, false);
  assert.equal(t.clock().white, 116000);
  assert.equal(t.state.game.fen(), fenBefore);
  assert.ok(t.of('clock:change').length >= 1);
  t.st.dispose();
});

test('a new game resets the clock and restarts it while self-play is on', () => {
  const t = timed();
  t.actions.startSelfPlay({ opponent: 'self', timeControl: { initial: 30000, increment: 0 } });
  t.at(5000);
  t.actions.playMove('e2e4');
  assert.equal(t.clock().white, 25000);
  t.actions.newGame();
  assert.deepEqual([t.clock().white, t.clock().black], [30000, 30000]);
  assert.equal(t.clock().turn, 'white');
  assert.equal(t.clock().running, true, 'self-play keeps running on a fresh game');
  t.at(1000);
  t.actions.playMove('d2d4');
  assert.equal(t.clock().white, 29000);
  // Loading a position resets it too.
  t.actions.loadFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1');
  assert.deepEqual([t.clock().white, t.clock().black], [30000, 30000]);
  t.actions.stopSelfPlay();
  t.actions.newGame();
  assert.equal(t.clock().running, false, 'a fresh game does not start the clock on its own');
  assert.equal(t.clock().turn, null);
  t.st.dispose();
});

test('the 200 ms ticker runs on its own while the clock is running', async () => {
  const t = make({ tickInterval: 5 });
  t.actions.startSelfPlay({ opponent: 'self', timeControl: { initial: 60000, increment: 0 } });
  await wait(40);
  const ticks = t.of('clock:tick');
  assert.ok(ticks.length >= 2, `expected the ticker to fire (got ${ticks.length})`);
  assert.ok(ticks.at(-1).white < 60000, 'real time is being burned');
  assert.equal(ticks.at(-1).turn, 'white');
  t.actions.clockPause();
  const after = t.of('clock:tick').length;
  await wait(30);
  assert.equal(t.of('clock:tick').length, after, 'the ticker stops with the clock');
  t.st.dispose();
});

// ---- Addendum v2: the AI opponent's style ----

test('normalizeAiStyle: every valid style survives, everything else lands on annotate', () => {
  for (const good of ['silent', 'annotate', 'coach']) {
    assert.ok(AI_STYLES.has(good), `${good} should be a known style`);
    assert.equal(normalizeAiStyle(good), good);
  }
  // A settings blob from an older build, or hand-edited, must never reach the bridge as an unknown style:
  // the agent reads this field to decide what to do, so "unrecognised" has to mean "the default", not "".
  for (const bad of [undefined, null, '', ' silent', 'SILENT', 'Coach', 'teacher', 0, 1, NaN, [], {}, ['coach'], () => 'coach']) {
    assert.equal(normalizeAiStyle(bad), 'annotate', `${JSON.stringify(String(bad))} should fall back`);
  }
});

test('aiStyle has a default and round-trips through settings', () => {
  assert.equal(SETTINGS_DEFAULTS.selfPlay.aiStyle, 'annotate');
  const storage = fakeStorage();
  const a = make({ storage });
  assert.equal(a.st.state.settings.selfPlay.aiStyle, 'annotate');
  a.actions.setSetting('selfPlay.aiStyle', 'coach');
  assert.equal(a.st.state.settings.selfPlay.aiStyle, 'coach');
  const revived = make({ storage });
  assert.equal(revived.st.state.settings.selfPlay.aiStyle, 'coach', 'the style must survive a reload');
});
