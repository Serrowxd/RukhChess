// src/core/game.js: rules, castling forms, tree operations, SAN/UCI helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, INITIAL_FEN, NAG_GLYPHS } from '../src/core/game.js';

const KIWIPETE = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
const uci = m => m.from + m.to + (m.promotion || '');

test('legal move counts: start 20, after 1.e4 20, kiwipete 48', () => {
  const g = Game.standard();
  assert.equal(g.legalMoves().length, 20);

  g.play('e2e4');
  assert.equal(g.legalMoves().length, 20);

  assert.equal(Game.fromFen(KIWIPETE).legalMoves().length, 48);
});

test('fromFen: start fields, ply from a mid-game FEN, invalid input throws readable errors', () => {
  const g = Game.standard();
  assert.equal(g.fen(), INITIAL_FEN);
  assert.equal(g.startFen, INITIAL_FEN);
  assert.equal(g.variant, 'standard');
  assert.equal(g.root.ply, 0);
  assert.equal(g.turn(), 'white');

  const mid = Game.fromFen('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  assert.equal(mid.root.ply, 2);

  const black = Game.fromFen('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2');
  assert.equal(black.root.ply, 3);

  assert.throws(() => Game.fromFen('garbage'), /invalid FEN/);
  assert.throws(() => Game.fromFen('8/8/8/8/8/8/8/8 w - - 0 1'), /illegal position/);
  assert.throws(() => Game.fromFen('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1'), /side not to move is in check/);
});

test('pieces / pieceAt', () => {
  const g = Game.standard();

  assert.equal(g.pieces().length, 32);
  assert.deepEqual(g.pieceAt('e1'), { color: 'white', role: 'king' });
  assert.deepEqual(g.pieceAt('e7'), { color: 'black', role: 'pawn' });
  assert.equal(g.pieceAt('e4'), null);
  assert.equal(g.pieceAt('zz'), null);
});

test('standard castling: king-destination form listed, rook form accepted and normalised', () => {
  const g = Game.fromFen(KIWIPETE);

  const kingMoves = g.legalMoves('e1').map(uci);
  assert.ok(kingMoves.includes('e1g1'));
  assert.ok(kingMoves.includes('e1c1'));
  assert.ok(!kingMoves.includes('e1h1'));
  assert.ok(!kingMoves.includes('e1a1'));
  assert.deepEqual(g.legalTargets('e1').sort(), ['c1', 'd1', 'f1', 'g1'].sort());

  const res = g.play({ from: 'e1', to: 'g1' });
  assert.equal(res.san, 'O-O');
  assert.equal(res.castle, 'king');
  assert.equal(res.captured, null);
  assert.equal(res.node.uci, 'e1g1');
  assert.deepEqual(res.node.move, { from: 'e1', to: 'g1' });
  assert.deepEqual(g.pieceAt('f1'), { color: 'white', role: 'rook' });
  assert.deepEqual(g.pieceAt('g1'), { color: 'white', role: 'king' });

  g.back();
  const again = g.play('e1h1');
  assert.equal(again.reused, true);
  assert.equal(again.node.id, res.node.id);

  g.back();
  const long = g.play('e1a1');
  assert.equal(long.san, 'O-O-O');
  assert.equal(long.castle, 'queen');
  assert.equal(long.node.uci, 'e1c1');
  assert.deepEqual(g.pieceAt('d1'), { color: 'white', role: 'rook' });
  assert.equal(g.isLegal('e1h1'), false); // already castled on this node
});

test('chess960: king and rook adjacent (king already on g1) — only the king-takes-rook form', () => {
  const fen = 'bbqnnrk1/pppppppp/8/8/8/8/PPPPPPPP/BBQNN1KR w Kq - 0 1';
  assert.equal(Game.detectVariant(fen), 'chess960');

  const g = Game.fromFen(fen);
  assert.equal(g.variant, 'chess960');

  const kingMoves = g.legalMoves('g1').map(uci);
  assert.ok(kingMoves.includes('g1h1'), 'castling via king takes rook');
  assert.ok(!kingMoves.includes('g1g1'), 'no null move');
  assert.ok(kingMoves.includes('g1f1'));

  const res = g.play('g1h1');
  assert.equal(res.san, 'O-O');
  assert.equal(res.castle, 'king');
  assert.equal(res.node.uci, 'g1h1');
  assert.deepEqual(g.pieceAt('g1'), { color: 'white', role: 'king' });
  assert.deepEqual(g.pieceAt('f1'), { color: 'white', role: 'rook' });
  assert.equal(g.pieceAt('h1'), null);
});

test('chess960: both castling forms listed when they differ; ambiguous king-destination uses the rook form', () => {
  const g = Game.fromFen('rk5r/pppppppp/8/8/8/8/PPPPPPPP/RK5R w KQkq - 0 1', { variant: 'chess960' });

  const kingMoves = g.legalMoves('b1').map(uci);
  assert.ok(kingMoves.includes('b1g1'), 'h-side castling, king destination form');
  assert.ok(kingMoves.includes('b1h1'), 'h-side castling, rook form');
  assert.ok(kingMoves.includes('b1a1'), 'a-side castling only via the rook (b1c1 is a plain king move)');
  assert.ok(kingMoves.includes('b1c1'));
  assert.equal(kingMoves.filter(m => m === 'b1c1').length, 1);

  const short = g.play('b1g1');
  assert.equal(short.san, 'O-O');
  assert.equal(short.node.uci, 'b1g1');

  g.back();
  assert.equal(g.engineUci('b1g1'), 'b1h1');
  assert.equal(g.engineUci({ from: 'b1', to: 'h1' }), 'b1h1');
  assert.equal(g.play('b1h1').reused, true);

  g.back();
  const long = g.play('b1a1');
  assert.equal(long.san, 'O-O-O');
  assert.equal(long.castle, 'queen');
  assert.equal(long.node.uci, 'b1a1');
  assert.deepEqual(g.pieceAt('c1'), { color: 'white', role: 'king' });
  assert.deepEqual(g.pieceAt('d1'), { color: 'white', role: 'rook' });

  g.back();
  const plain = g.play('b1c1');
  assert.equal(plain.san, 'Kc1');
  assert.equal(plain.castle, null);
  assert.deepEqual(g.pieceAt('a1'), { color: 'white', role: 'rook' });

  const s = Game.fromFen(KIWIPETE);
  assert.equal(s.engineUci('e1h1'), 'e1g1', 'standard: engine wants e1g1');
  assert.equal(s.engineUci('g1h3'), 'g1h3');
});

test('en passant', () => {
  const g = Game.fromFen('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3');
  assert.ok(g.legalTargets('e5').includes('d6'));

  const res = g.play('e5d6');

  assert.equal(res.san, 'exd6');
  assert.equal(res.enPassant, true);
  assert.equal(res.captured, 'pawn');
  assert.equal(g.pieceAt('d5'), null);
  assert.equal(res.node.captured, 'pawn');
});

test('promotions: four entries, collapsed targets, default queen, all four playable', () => {
  const g = Game.fromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');

  const promos = g.legalMoves('a7');
  assert.deepEqual(promos.map(m => m.promotion), ['q', 'r', 'b', 'n']);
  assert.deepEqual(g.legalTargets('a7'), ['a8']);
  assert.equal(g.isLegal({ from: 'a7', to: 'a8' }), true);

  const n = g.play({ from: 'a7', to: 'a8', promotion: 'n' });
  assert.equal(n.san, 'a8=N');
  assert.equal(n.promotion, 'n');
  assert.deepEqual(g.pieceAt('a8'), { color: 'white', role: 'knight' });

  g.back();
  const q = g.play('a7a8q');
  assert.equal(q.san, 'a8=Q+');
  assert.equal(q.check, true);

  g.back();
  assert.equal(g.play({ from: 'a7', to: 'a8' }).reused, true, 'missing promotion defaults to queen');

  g.back();
  g.play('a7a8r');
  g.back();
  g.play({ from: 'a7', to: 'a8', promotion: 'bishop' });
  assert.equal(g.root.children.length, 4);
  assert.deepEqual(g.root.children.map(c => c.uci), ['a7a8n', 'a7a8q', 'a7a8r', 'a7a8b']);
});

test('checkmate, stalemate, insufficient material', () => {
  const g = Game.standard();
  for (const san of ['f3', 'e5', 'g4', 'Qh4#']) g.play(g.sanToMove(san));

  const st = g.status();
  assert.equal(st.checkmate, true);
  assert.equal(st.check, true);
  assert.equal(st.outcome, '0-1');
  assert.equal(st.reason, 'checkmate');
  assert.equal(g.current.san, 'Qh4#');
  assert.equal(g.current.checkmate, true);
  assert.equal(g.legalMoves().length, 0);

  const sm = Game.fromFen('k7/8/1Q6/8/8/8/8/K7 b - - 0 1').status();
  assert.equal(sm.stalemate, true);
  assert.equal(sm.outcome, '1/2-1/2');
  assert.equal(sm.reason, 'stalemate');

  const im = Game.fromFen('k7/8/8/8/8/8/8/K5B1 w - - 0 1').status();
  assert.equal(im.insufficientMaterial, true);
  assert.equal(im.outcome, '1/2-1/2');

  assert.equal(Game.standard().status().reason, 'playing');
});

test('threefold repetition counting and fifty-move rule', () => {
  const g = Game.standard();
  const cycle = ['Nf3', 'Nf6', 'Ng1', 'Ng8'];
  assert.equal(g.status().repetition, 1);

  for (const san of cycle) g.play(g.sanToMove(san));
  assert.equal(g.status().repetition, 2);
  assert.equal(g.status().outcome, null);

  for (const san of cycle) g.play(g.sanToMove(san));
  const st = g.status();
  assert.equal(st.repetition, 3);
  assert.equal(st.outcome, '1/2-1/2');
  assert.equal(st.reason, 'threefold repetition');

  const f = Game.fromFen('k7/8/8/8/8/8/8/K6R w - - 99 80');
  assert.equal(f.status().fiftyMoves, false);

  f.play('h1h2');
  assert.equal(f.status().fiftyMoves, true);
  assert.equal(f.status().outcome, '1/2-1/2');
  assert.equal(f.status().reason, 'fifty-move rule');
});

test('variations: creation, reuse, promote, makeMainline, deleteFrom', () => {
  const g = Game.standard();
  const e4 = g.play('e2e4').node;
  const e5 = g.play('e7e5').node;
  g.back();
  const c5 = g.play('c7c5').node;
  assert.deepEqual(e4.children.map(c => c.san), ['e5', 'c5']);
  assert.equal(c5.parentId, e4.id);
  assert.equal(g.isOnMainline(e5.id), true);
  assert.equal(g.isOnMainline(c5.id), false);

  g.back();
  const again = g.play('e7e5');
  assert.equal(again.reused, true);
  assert.equal(again.node, e5);
  assert.equal(e4.children.length, 2);

  // A deeper line under c5.
  g.goto(c5.id);
  const nf3 = g.play('g1f3').node;
  const d6 = g.play('d7d6').node;

  g.promoteVariation(c5.id);
  assert.deepEqual(e4.children.map(c => c.san), ['c5', 'e5']);
  assert.equal(g.isOnMainline(d6.id), true);

  g.promoteVariation(e5.id);
  assert.deepEqual(e4.children.map(c => c.san), ['e5', 'c5']);

  g.makeMainline(d6.id);
  assert.equal(g.isOnMainline(d6.id), true);
  assert.deepEqual(g.mainline().map(n => n.san), [null, 'e4', 'c5', 'Nf3', 'd6']);
  assert.deepEqual(g.path().map(n => n.san), [null, 'e4', 'c5', 'Nf3', 'd6']);

  // Delete the subtree containing current.
  const cur = g.deleteFrom(nf3.id);
  assert.equal(cur, c5);
  assert.equal(g.current, c5);
  assert.equal(c5.children.length, 0);
  assert.equal(g.node(nf3.id), null);
  assert.equal(g.node(d6.id), null);

  // Delete a sibling not on the path.
  g.deleteFrom(e5.id);
  assert.equal(g.current, c5);
  assert.deepEqual(e4.children.map(c => c.san), ['c5']);

  // Deleting from the root clears everything.
  g.deleteFrom(g.root.id);
  assert.equal(g.root.children.length, 0);
  assert.equal(g.current, g.root);
  assert.equal(g.nodeCount(), 1);
});

test('navigation: goto/back/forward/toStart/toEnd/next/prevVariation, cursor', () => {
  const g = Game.standard();
  const e4 = g.play('e2e4').node;
  const e5 = g.play('e7e5').node;
  const nf3 = g.play('g1f3').node;
  g.goto(e4.id);
  const c5 = g.play('c7c5').node;

  assert.equal(g.back(), e4);
  assert.equal(g.forward(), e5);
  assert.equal(g.nextVariation(), c5);
  assert.equal(g.nextVariation(), null);
  assert.equal(g.prevVariation(), e5);
  assert.equal(g.prevVariation(), null);
  assert.equal(g.toStart(), g.root);
  assert.equal(g.back(), null);
  assert.equal(g.toEnd(), nf3);
  assert.equal(g.forward(), null);
  assert.deepEqual(g.cursor(), [0, 0, 0]);

  g.goto(c5.id);
  assert.deepEqual(g.cursor(), [0, 1]);

  g.toStart();
  assert.equal(g.gotoCursor([0, 1]), c5);
  assert.equal(g.goto('nope'), c5);
  assert.equal(g.gotoCursor([0, 0, 0, 5, 5]), nf3, 'stops early on a bad index');
});

test('sanToMove / moveToSan / pvToSan / uciToMove / moveToUci', () => {
  const g = Game.standard();
  assert.deepEqual(g.sanToMove('Nf3'), { from: 'g1', to: 'f3' });
  assert.deepEqual(g.sanToMove('Nf3!?'), { from: 'g1', to: 'f3' });
  assert.equal(g.sanToMove('Nf6'), null);
  assert.equal(g.sanToMove('xyz'), null);
  assert.equal(g.moveToSan('g1f3'), 'Nf3');
  assert.equal(g.moveToSan({ from: 'e2', to: 'e4' }), 'e4');
  assert.equal(g.moveToSan('e2e5'), null);
  assert.deepEqual(g.pvToSan(['e2e4', 'e7e5', 'g1f3', 'zzzz', 'b8c6']), ['e4', 'e5', 'Nf3']);
  assert.deepEqual(g.pvToSan(['e2e4', 'e7e5', 'e1e3']), ['e4', 'e5']);
  assert.deepEqual(g.uciToMove('e2e4'), { from: 'e2', to: 'e4' });
  assert.equal(g.uciToMove('bad'), null);

  const k = Game.fromFen(KIWIPETE);
  assert.deepEqual(k.sanToMove('O-O'), { from: 'e1', to: 'g1' });
  assert.deepEqual(k.sanToMove('0-0-0'), { from: 'e1', to: 'c1' });
  assert.deepEqual(k.uciToMove('e1h1'), { from: 'e1', to: 'g1' });
  assert.equal(k.moveToSan('e1c1'), 'O-O-O');
  assert.equal(k.moveToUci('e1a1'), 'e1c1');

  const p = Game.fromFen('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  assert.deepEqual(p.sanToMove('a8=Q'), { from: 'a7', to: 'a8', promotion: 'q' });
  assert.deepEqual(p.sanToMove('a8R'), { from: 'a7', to: 'a8', promotion: 'r' });
  assert.deepEqual(p.uciToMove('a7a8n'), { from: 'a7', to: 'a8', promotion: 'n' });
  assert.deepEqual(p.pvToSan(['a7a8q', 'e8d7']), ['a8=Q+', 'Kd7']);
});

test('play: illegal throws; captured role; check flags', () => {
  const g = Game.standard();
  assert.throws(() => g.play('e2e5'), /illegal move/);
  assert.throws(() => g.play({ from: 'e7', to: 'e5' }), /illegal move/);
  assert.throws(() => g.play('junk'), /illegal move/);

  g.play('e2e4');
  g.play('d7d5');
  const cap = g.play('e4d5');
  assert.equal(cap.captured, 'pawn');
  assert.equal(cap.san, 'exd5');

  g.play('d8d5');
  const chk = g.play('b1c3');
  assert.equal(chk.check, false);

  g.play('d5e5');
  assert.equal(g.status().check, true);
  assert.equal(g.current.check, true);
  assert.equal(g.status().reason, 'check');
});

test('isKnightJump', () => {
  assert.equal(Game.isKnightJump('g1', 'f3'), true);
  assert.equal(Game.isKnightJump('b1', 'c3'), true);
  assert.equal(Game.isKnightJump('g1', 'g3'), false);
  assert.equal(Game.isKnightJump('e4', 'e4'), false);
  assert.equal(Game.standard().isKnightJump('a1', 'b3'), true);
});

test('annotations: note, nag, arrows, highlights, eval', () => {
  const g = Game.standard();
  const n = g.play('e2e4').node;

  g.setNote(n.id, 'the plan');
  assert.equal(n.note, 'the plan');

  g.setNag(n.id, '!');
  assert.equal(n.nag, '!');
  g.setNag(n.id, 'bogus');
  assert.equal(n.nag, '!');
  g.setNag(n.id, '');
  assert.equal(n.nag, '');

  for (const glyph of NAG_GLYPHS) {
    g.setNag(n.id, glyph);
    assert.equal(n.nag, glyph);
  }

  assert.equal(g.toggleArrow(n.id, { from: 'g1', to: 'f3', color: 'green' }), true);
  assert.equal(n.arrows[0].knight, true);
  assert.equal(g.toggleArrow(n.id, { from: 'g1', to: 'f3', color: 'red' }), false, 'same from/to removes regardless of colour');
  assert.equal(n.arrows.length, 0);
  assert.equal(g.toggleArrow(n.id, { from: 'e2', to: 'e2' }), false, 'zero-length arrow rejected');

  assert.equal(g.toggleHighlight(n.id, 'd5', 'red'), true);
  assert.equal(g.toggleHighlight(n.id, 'd5', 'blue'), true, 'recolour');
  assert.equal(n.highlights[0].color, 'blue');
  assert.equal(g.toggleHighlight(n.id, 'd5', 'blue'), false, 'same colour removes');
  assert.equal(n.highlights.length, 0);

  g.setArrows(n.id, [{ from: 'a1', to: 'a8', color: 'purple' }, { from: 'zz', to: 'a1' }]);
  assert.equal(n.arrows.length, 1);
  assert.equal(n.arrows[0].color, 'green', 'unknown colour falls back to green');

  g.setHighlights(n.id, [{ square: 'e4', color: 'yellow' }]);
  assert.deepEqual(n.highlights, [{ square: 'e4', color: 'yellow' }]);

  g.setEval(n.id, { cp: 30, depth: 20, pv: ['e7e5', 'g1f3'], best: 'e5' });
  assert.deepEqual(n.eval, { cp: 30, depth: 20, pv: ['e7e5', 'g1f3'], best: 'e5' });
  g.setEval(n.id, { mate: 3, depth: 12 });
  assert.deepEqual(n.eval, { mate: 3, depth: 12, pv: [] });
  g.setEval(n.id, null);
  assert.equal(n.eval, null);
});

test('fromPieces: valid setups and readable errors', () => {
  const pieces = [
    { square: 'e1', piece: { color: 'white', role: 'king' } },
    { square: 'e8', piece: { color: 'black', role: 'king' } },
    { square: 'a1', piece: { color: 'white', role: 'rook' } },
    { square: 'h1', piece: { color: 'white', role: 'rook' } },
  ];

  const g = Game.fromPieces(pieces, { turn: 'white', castling: 'KQkq' });
  assert.equal(g.fen(), '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1');
  assert.ok(g.legalMoves('e1').map(uci).includes('e1g1'));

  const b = Game.fromPieces(pieces, { turn: 'black' });
  assert.equal(b.turn(), 'black');
  assert.equal(b.fen(), '4k3/8/8/8/8/8/8/R3K2R b - - 0 1');

  assert.throws(() => Game.fromPieces([{ square: 'e1', piece: { color: 'white', role: 'king' } }], { turn: 'white' }), /king/);
  assert.throws(() => Game.fromPieces([], { turn: 'white' }), /empty|king/);
  assert.throws(() => Game.fromPieces([
    ...pieces,
    { square: 'a8', piece: { color: 'white', role: 'pawn' } },
  ], { turn: 'white' }), /pawns cannot stand/);
  assert.throws(() => Game.fromPieces([
    { square: 'e1', piece: { color: 'white', role: 'king' } },
    { square: 'e8', piece: { color: 'black', role: 'king' } },
    { square: 'e4', piece: { color: 'white', role: 'rook' } },
  ], { turn: 'white' }), /side not to move is in check/);
  assert.throws(() => Game.fromPieces([{ square: 'j9', piece: { color: 'white', role: 'king' } }], { turn: 'white' }), /bad square/);
});

test('chess960 constructor', () => {
  const g = Game.chess960(518);
  assert.equal(g.variant, 'chess960');
  assert.equal(g.chess960Number, 518);
  assert.equal(g.fen(), INITIAL_FEN);

  const r = Game.chess960();
  assert.ok(r.chess960Number >= 0 && r.chess960Number <= 959);
  assert.equal(r.legalMoves().length > 0, true);
});

test('toPgn / fromPgn: headers, variations, comments, shapes, nags, evals, results', () => {
  const g = Game.standard();
  g.headers.set('White', 'Ada');
  g.headers.set('Black', 'Engine');

  const e4 = g.play('e2e4').node;
  g.setNote(e4.id, 'the plan starts here');
  g.setNag(e4.id, '!');
  g.setArrows(e4.id, [{ from: 'g1', to: 'f3', color: 'green' }, { from: 'e4', to: 'e5', color: 'red' }]);
  g.setHighlights(e4.id, [{ square: 'd5', color: 'red' }]);
  g.setEval(e4.id, { cp: 30, depth: 20, pv: ['e7e5'], best: 'e5' });

  const e5 = g.play('e7e5').node;
  g.back();
  const c5 = g.play('c7c5').node;
  g.setNote(c5.id, 'Sicilian');
  g.goto(e5.id);
  g.play('g1f3');

  const pgn = g.toPgn();
  assert.match(pgn, /\[White "Ada"\]/);
  assert.match(pgn, /\[Result "\*"\]/);
  assert.ok(!pgn.includes('[FEN'));
  assert.match(pgn, /1\. e4 \$1 \{ the plan starts here \[%csl Rd5\] \[%cal Gg1f3,Re4e5\] \[%eval 0\.30,20\] \}/);
  assert.match(pgn, /\( 1\.\.\. c5 \{ Sicilian \} \)/);

  const back = Game.fromPgn(pgn);
  assert.equal(back.headers.get('White'), 'Ada');
  assert.equal(back.variant, 'standard');
  assert.equal(back.current, back.root);

  const be4 = back.root.children[0];
  assert.equal(be4.san, 'e4');
  assert.equal(be4.note, 'the plan starts here');
  assert.equal(be4.nag, '!');
  assert.deepEqual(be4.arrows.map(a => [a.from, a.to, a.color, a.knight]), [['g1', 'f3', 'green', true], ['e4', 'e5', 'red', false]]);
  assert.deepEqual(be4.highlights, [{ square: 'd5', color: 'red' }]);
  assert.deepEqual(be4.eval, { cp: 30, depth: 20, pv: [] });
  assert.deepEqual(be4.children.map(c => c.san), ['e5', 'c5']);
  assert.equal(be4.children[1].note, 'Sicilian');
  assert.equal(be4.children[0].children[0].san, 'Nf3');
  assert.equal(back.warnings.length, 0);
});

test('fromPgn: [FEN]/[SetUp], Chess960 variant, result header, illegal moves dropped with a warning', () => {
  const pgn = '[Variant "Chess960"]\n[SetUp "1"]\n[FEN "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1"]\n\n1. e4 e5 2. Ke2?? *\n';

  const g = Game.fromPgn(pgn);
  assert.equal(g.variant, 'chess960');
  assert.equal(g.chess960Number, 0);
  assert.equal(g.startFen, 'bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1');
  assert.deepEqual(g.mainline().map(n => n.san), [null, 'e4', 'e5']);
  assert.equal(g.warnings.length, 1);
  assert.match(g.warnings[0], /Ke2/);

  const out = g.toPgn();
  assert.match(out, /\[Variant "Chess960"\]/);
  assert.match(out, /\[SetUp "1"\]/);
  assert.match(out, /\[FEN "bbqnnrkr/);

  const mate = Game.fromPgn('1. f3 e5 2. g4 Qh4# 0-1');
  assert.equal(mate.headers.get('Result'), '0-1');
  assert.match(mate.toPgn(), /\[Result "0-1"\]/);

  const noResult = Game.fromPgn('1. f3 e5 2. g4 Qh4#');
  assert.match(noResult.toPgn(), /\[Result "0-1"\]/, 'result derived from the final position');

  assert.throws(() => Game.fromPgn('   '), /empty PGN/);
  assert.throws(() => Game.fromPgn('[Variant "Atomic"]\n\n1. e4 *'), /unsupported variant/);
  assert.throws(() => Game.fromPgn('[FEN "garbage"]\n\n1. e4 *'), /bad start position/);

  const rootComment = Game.fromPgn('{ Opening notes [%cal Ge2e4] } 1. e4 *');
  assert.equal(rootComment.root.note, 'Opening notes');
  assert.deepEqual(rootComment.root.arrows.map(a => a.from + a.to), ['e2e4']);
});

test('toJSON / fromJSON round trip (structure, annotations, ids regenerated)', () => {
  const g = Game.fromFen(KIWIPETE);
  g.headers.set('Event', 'test');
  const a = g.play('e1g1').node;
  g.setNote(a.id, 'castle');
  g.setArrows(a.id, [{ from: 'a8', to: 'a1', color: 'blue', source: 'ai' }]);
  g.play('e8c8');
  g.back();
  g.play('e8g8');

  const json = g.toJSON();
  assert.equal(json.version, 1);
  assert.equal(json.startFen, KIWIPETE);
  assert.equal(json.tree.children[0].parentId, undefined);
  assert.equal(json.tree.children[0].id, undefined);

  const back = Game.fromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back.toJSON(), json);
  assert.equal(back.headers.get('Event'), 'test');
  assert.equal(back.root.children[0].note, 'castle');
  assert.equal(back.root.children[0].arrows[0].source, 'ai');
  assert.deepEqual(back.root.children[0].children.map(c => c.san), ['O-O-O', 'O-O']);

  assert.throws(() => Game.fromJSON(null), /not a game/);
  assert.throws(() => Game.fromJSON({ version: 2 }), /unsupported/);

  const dropped = Game.fromJSON({ version: 1, tree: { children: [{ san: 'e4', children: [{ san: 'Nf3', children: [] }] }] } });
  assert.deepEqual(dropped.mainline().map(n => n.san), [null, 'e4']);
  assert.equal(dropped.warnings.length, 1);

  const bySan = Game.fromJSON({ tree: { children: [{ san: 'e4', children: [{ san: 'e5' }] }] } });
  assert.deepEqual(bySan.mainline().map(n => n.uci), [null, 'e2e4', 'e7e5']);
});
