// Tests for src/core/io.js — YAML / JSON / PGN round trips, URL hash, download guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, INITIAL_FEN } from '../src/core/game.js';
import {
  STUDY_VERSION, decodeHash, download, encodeHash, gameFromPgn, gameToPgn,
  studyFromJSON, studyFromYaml, studyToJSON, studyToYaml,
} from '../src/core/io.js';

function richGame() {
  const g = Game.standard();
  g.setNote(g.root.id, 'root note');
  g.setArrows(g.root.id, [{ from: 'e2', to: 'e4', color: 'green' }]);
  const e4 = g.play('e2e4').node;
  g.setNote(e4.id, 'the plan starts here');
  g.setNag(e4.id, '!');
  g.setArrows(e4.id, [{ from: 'g1', to: 'f3', color: 'green' }, { from: 'f1', to: 'c4', color: 'blue', source: 'ai' }]);
  g.setHighlights(e4.id, [{ square: 'd5', color: 'red' }]);
  g.setEval(e4.id, { cp: 30, depth: 20, pv: ['g1f3', 'b8c6'], best: 'Nf3' });
  const e5 = g.play('e7e5').node;
  g.setEval(e5.id, { mate: -3, depth: 15, pv: [] });
  g.play('g1f3');
  g.play('b8c6');
  g.goto(e4.id);
  const c5 = g.play('c7c5').node;
  g.setNote(c5.id, 'Sicilian: two\nlines');
  g.setNag(c5.id, '?!');
  g.play('g1f3');
  g.goto(e4.id);
  const e6 = g.play('e7e6').node;
  g.setHighlights(e6.id, [{ square: 'd4', color: 'yellow' }, { square: 'e5', color: 'green' }]);
  g.goto(e5.id);
  g.play('f1c4');
  g.goto(g.root.id);
  return g;
}

function shape(node) {
  return {
    san: node.san,
    uci: node.uci,
    note: node.note,
    nag: node.nag,
    arrows: node.arrows.map(a => [a.from, a.to, a.color]),
    highlights: node.highlights.map(h => [h.square, h.color]),
    children: node.children.map(shape),
  };
}

test('YAML export matches the contract layout', () => {
  const yaml = studyToYaml({ title: 'Italian, the plan', created: '2026-09-17', notes: 'study-level notes', orientation: 'white', game: richGame() });
  assert.match(yaml, /^chessboard: 1\n/);
  assert.match(yaml, /\ntitle: Italian, the plan\n/);
  assert.match(yaml, /\ncreated: '?2026-09-17'?\n/);
  assert.match(yaml, /\nvariant: standard\n/);
  assert.match(yaml, /\nchess960: null\n/);
  assert.match(yaml, /\nstart_fen: rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w KQkq - 0 1\n/);
  assert.match(yaml, /\norientation: white\n/);
  assert.match(yaml, /\nnotes: study-level notes\n/);
  assert.match(yaml, /\nstart:\n  note: root note\n  arrows: \[\{from: e2, to: e4, color: green\}\]\n/);
  assert.match(yaml, /\nmoves:\n  - san: e4\n    uci: e2e4\n    fen: rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b KQkq - 0 1\n    note: the plan starts here\n    nag: '!'\n/);
  assert.match(yaml, /\n    arrows: \[\{from: g1, to: f3, color: green\}, \{from: f1, to: c4, color: blue, source: ai\}\]\n/);
  assert.match(yaml, /\n    highlights: \[\{square: d5, color: red\}\]\n/);
  assert.match(yaml, /\n    eval: \{cp: 30, depth: 20, best: Nf3, pv: \[g1f3, b8c6\]\}\n/);
  assert.match(yaml, /\n    variations:\n      - moves:\n          - san: c5\n/);
  assert.match(yaml, /\n {10}- \{san: Nf3, uci: g1f3, fen: [^}]+\}\n/, 'bare moves are single-line flow mappings');
  assert.match(yaml, /\n  - san: e5\n    uci: e7e5\n    fen: [^\n]+\n    eval: \{mate: -3, depth: 15\}\n/);
  assert.match(yaml, /note: \|-\n\s+Sicilian: two\n\s+lines\n/);
  assert.ok(!yaml.includes('note: ""'));
  assert.ok(!yaml.includes('arrows: []'));
  assert.ok(!yaml.includes('eval: null'));
  assert.ok(!yaml.includes('knight:'));
});

test('YAML round trip is identical (yaml -> game -> yaml)', () => {
  const study = { title: 'Round trip', created: '2026-09-17', notes: 'notes\nmore', orientation: 'black', game: richGame() };
  const yaml = studyToYaml(study);
  const back = studyFromYaml(yaml);
  assert.equal(back.title, 'Round trip');
  assert.equal(back.created, '2026-09-17');
  assert.equal(back.notes, 'notes\nmore');
  assert.equal(back.orientation, 'black');
  assert.equal(back.warnings.length, 0);
  assert.deepEqual(shape(back.game.root), shape(study.game.root));
  assert.deepEqual(back.game.root.children[0].eval, study.game.root.children[0].eval);
  assert.deepEqual(back.game.root.children[0].arrows[1].source, 'ai');
  assert.equal(back.game.root.children[0].arrows[0].knight, true);
  const yaml2 = studyToYaml({ ...back, game: back.game });
  assert.equal(yaml2, yaml);
  assert.equal(back.game.current, back.game.root);
});

test('YAML import tolerates missing keys and hand-written moves (san only)', () => {
  const text = [
    'chessboard: 1',
    'title: hand written',
    'moves:',
    '  - san: e4',
    '    note: "opening"',
    '    variations:',
    '      - moves:',
    '          - san: d4',
    '          - san: Nf6',
    '  - san: c5',
    '  - {san: Nf3}',
    '',
  ].join('\n');
  const st = studyFromYaml(text);
  assert.equal(st.title, 'hand written');
  assert.equal(st.orientation, 'white');
  assert.equal(st.game.startFen, INITIAL_FEN);
  assert.deepEqual(st.game.mainline().map(n => n.san), [null, 'e4', 'c5', 'Nf3']);
  assert.deepEqual(st.game.root.children.map(n => n.san), ['e4', 'd4']);
  assert.deepEqual(st.game.root.children[1].children.map(n => n.san), ['Nf6']);
  assert.equal(st.game.root.children[0].note, 'opening');
  assert.deepEqual(st.game.mainline().map(n => n.uci), [null, 'e2e4', 'c7c5', 'g1f3']);
  const c960 = studyFromYaml('chessboard: 1\nvariant: chess960\nchess960: 0\nstart_fen: bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1\nmoves: []\n');
  assert.equal(c960.game.variant, 'chess960');
  assert.equal(c960.game.chess960Number, 0);
  const minimal = studyFromYaml('moves:\n  - san: e4\n');
  assert.equal(minimal.game.mainline().length, 2);
});

test('YAML import errors are readable; illegal moves become warnings', () => {
  assert.throws(() => studyFromYaml(''), /empty/);
  assert.throws(() => studyFromYaml('- just\n- a list\n'), /mapping/);
  assert.throws(() => studyFromYaml('title: x\n'), /not a chessboard study/);
  assert.throws(() => studyFromYaml('chessboard: 7\nmoves: []\n'), /unsupported chessboard version/);
  assert.throws(() => studyFromYaml('chessboard: 1\nstart_fen: nonsense\nmoves: []\n'), /start_fen/);
  // The raw js-yaml message, with no 'YAML: ' prefix of its own: actions.loadYaml adds exactly one.
  assert.throws(() => studyFromYaml('chessboard: 1\nmoves: [\n'), e => /\(\d+:\d+\)/.test(e.message) && !/^YAML:/.test(e.message));
  assert.throws(() => studyFromYaml('- just\n- a list\n'), e => !/^YAML:/.test(e.message));
  const st = studyFromYaml('chessboard: 1\nmoves:\n  - san: e4\n  - san: Nf3\n  - san: e5\n');
  assert.deepEqual(st.game.mainline().map(n => n.san), [null, 'e4']);
  assert.equal(st.warnings.length, 1);
  assert.match(st.warnings[0], /Nf3/);
});

test('JSON round trip (autosave) with cursor', () => {
  const game = richGame();
  const c5 = game.root.children[0].children[1];
  game.goto(c5.id);
  const obj = studyToJSON({ title: 't', created: '2026-09-17', notes: 'n', orientation: 'white', game });
  assert.equal(obj.version, STUDY_VERSION);
  assert.deepEqual(obj.cursor, [0, 1]);
  const text = JSON.stringify(obj);
  const back = studyFromJSON(JSON.parse(text));
  assert.equal(back.title, 't');
  assert.equal(back.notes, 'n');
  assert.deepEqual(back.game.toJSON(), game.toJSON());
  assert.equal(back.game.current.san, 'c5');
  assert.deepEqual(studyToJSON({ ...back, game: back.game }), obj);
  assert.throws(() => studyFromJSON(null), /not a study/);
  assert.throws(() => studyFromJSON({ version: 99 }), /unsupported/);
  const empty = studyFromJSON({});
  assert.equal(empty.game.fen(), INITIAL_FEN);
});

test('PGN round trip keeps tree structure, san, notes, arrows, highlights, nags', () => {
  const game = richGame();
  const pgn = gameToPgn(game);
  const back = gameFromPgn(pgn);
  assert.deepEqual(shape(back.root), shape(game.root));
  assert.equal(gameToPgn(back), pgn);
  assert.deepEqual(back.root.children[0].eval, { cp: 30, depth: 20, pv: [] }, 'pv/best are not part of PGN');
});

test('encodeHash / decodeHash', () => {
  const g = Game.fromFen('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  const h = encodeHash({ game: g });
  assert.ok(h.startsWith('#fen='));
  assert.deepEqual(decodeHash(h), { fen: '4k3/8/8/8/8/8/8/4K2R w K - 0 1' });
  g.play('e1g1');
  const h2 = encodeHash({ game: g });
  assert.ok(h2.startsWith('#pgn='));
  const d = decodeHash(h2);
  assert.ok(d.pgn.includes('1. O-O'));
  assert.equal(Game.fromPgn(d.pgn).mainline().at(-1).san, 'O-O');
  assert.equal(decodeHash(''), null);
  assert.equal(decodeHash('#'), null);
  assert.equal(decodeHash('#foo=bar'), null);
  assert.deepEqual(decodeHash('#' + encodeURIComponent(INITIAL_FEN)), { fen: INITIAL_FEN }, 'bare FEN accepted');
  assert.deepEqual(decodeHash('?x=1&fen=' + encodeURIComponent(INITIAL_FEN)), { fen: INITIAL_FEN });
  assert.equal(decodeHash('#fen=%E0%A4%A'), null);
});

test('download is a no-op outside the browser', () => {
  assert.equal(download('x.txt', 'hello', 'text/plain'), false);
});

// ───────────── regressions (reviewed defects, 2026-09-18) ─────────────

test('YAML carries the PGN headers, so PGN -> yaml -> PGN keeps the players and the result', () => {
  const pgn = '[Event "Club Championship"]\n[White "Serrow"]\n[Black "Magnus"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 1-0\n';
  const g = gameFromPgn(pgn);
  const text = studyToYaml({ title: 'x', created: '2026-09-17', notes: '', orientation: 'white', game: g });
  assert.match(text, /^headers:$/m);
  assert.match(text, /^ {2}White: Serrow$/m);
  assert.match(text, /^ {2}Result: '?1-0'?$/m);
  assert.doesNotMatch(text, /^ {2}Site:/m, 'placeholder headers are omitted');
  assert.doesNotMatch(text, /^ {2}Date:/m);
  const back = studyFromYaml(text);
  assert.equal(back.game.headers.get('White'), 'Serrow');
  assert.equal(back.game.headers.get('Black'), 'Magnus');
  assert.equal(back.game.headers.get('Event'), 'Club Championship');
  const out = gameToPgn(back.game).split('\n').filter(l => l.startsWith('['));
  assert.ok(out.includes('[White "Serrow"]'), out.join(' '));
  assert.ok(out.includes('[Black "Magnus"]'), out.join(' '));
  assert.ok(out.includes('[Result "1-0"]'), 'a resigned game does not become *');
  // A study with nothing but placeholder headers emits no headers key at all.
  const plain = studyToYaml({ title: '', created: '2026-09-17', notes: '', orientation: 'white', game: gameFromPgn('1. e4 *') });
  assert.doesNotMatch(plain, /^headers:/m);
  // SetUp / FEN / Variant are derived from start_fen + variant and are never written back.
  const fromFen = Game.fromPgn('[FEN "4k3/8/8/8/8/8/8/4K2R w K - 0 1"]\n[SetUp "1"]\n[White "A"]\n\n1. Kf1 *');
  const y2 = studyToYaml({ title: '', created: '2026-09-17', notes: '', orientation: 'white', game: fromFen });
  assert.doesNotMatch(y2, /^ {2}(SetUp|FEN|Variant):/m);
  const back2 = studyFromYaml(y2);
  assert.equal(back2.game.startFen, '4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  assert.equal(back2.game.headers.get('White'), 'A');
  assert.ok(gameToPgn(back2.game).includes('[FEN "4k3/8/8/8/8/8/8/4K2R w K - 0 1"]'));
  // A YAML without a headers key (or with a junk one) still imports.
  assert.equal(studyFromYaml('chessboard: 1\nmoves:\n  - san: e4\n').game.headers.get('White'), undefined);
  assert.ok(studyFromYaml('chessboard: 1\nheaders: nope\nmoves:\n  - san: e4\n').game instanceof Game);
});
