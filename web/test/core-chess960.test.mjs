// Tests for src/core/chess960.js — Scharnagl numbering and chessops castling compatibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chessops';
import { parseFen, makeFen, INITIAL_FEN } from 'chessops/fen';
import { CHESS960_STANDARD, chess960BackRank, chess960Fen, chess960NumberOf, randomChess960 } from '../src/core/chess960.js';
import { Game } from '../src/core/game.js';

test('518 is the classical start; 0 is BBQNNRKR; 959 is RKRNNQBB', () => {
  assert.equal(CHESS960_STANDARD, 518);
  assert.equal(chess960Fen(518), INITIAL_FEN);
  assert.equal(chess960BackRank(0), 'bbqnnrkr');
  assert.equal(chess960BackRank(959), 'rkrnnqbb');
  assert.throws(() => chess960Fen(960), RangeError);
  assert.throws(() => chess960Fen(-1), RangeError);
  assert.throws(() => chess960Fen(1.5), RangeError);
});

test('all 960 positions are unique, well-formed and obey the Chess960 constraints', () => {
  const seen = new Set();
  for (let n = 0; n < 960; n++) {
    const row = chess960BackRank(n);
    assert.equal(row.length, 8);
    assert.ok(!seen.has(row), `duplicate back rank for ${n}`);
    seen.add(row);
    const idx = ch => [...row].map((c, i) => (c === ch ? i : -1)).filter(i => i >= 0);
    const bishops = idx('b');
    assert.equal(bishops.length, 2);
    assert.notEqual(bishops[0] % 2, bishops[1] % 2, `bishops on the same colour for ${n}`);
    const rooks = idx('r');
    const king = idx('k')[0];
    assert.equal(rooks.length, 2);
    assert.ok(rooks[0] < king && king < rooks[1], `king not between rooks for ${n}`);
    assert.equal(idx('q').length, 1);
    assert.equal(idx('n').length, 2);
  }
  assert.equal(seen.size, 960);
});

test('every position loads in chessops with X-FEN KQkq castling resolved to the real rook squares', () => {
  for (let n = 0; n < 960; n++) {
    const fen = chess960Fen(n);
    const setup = parseFen(fen);
    assert.ok(setup.isOk, `FEN ${n} parses`);
    const pos = Chess.fromSetup(setup.value);
    assert.ok(pos.isOk, `position ${n} is legal`);
    const row = chess960BackRank(n);
    const rookFiles = [...row].map((c, i) => (c === 'r' ? i : -1)).filter(i => i >= 0);
    assert.equal(pos.value.castles.rook.white.a, rookFiles[0], `white a-side rook for ${n}`);
    assert.equal(pos.value.castles.rook.white.h, rookFiles[1], `white h-side rook for ${n}`);
    assert.equal(pos.value.castles.rook.black.a, 56 + rookFiles[0], `black a-side rook for ${n}`);
    assert.equal(pos.value.castles.rook.black.h, 56 + rookFiles[1], `black h-side rook for ${n}`);
    assert.equal(makeFen(pos.value.toSetup()), fen, `FEN ${n} round-trips (KQkq kept)`);
  }
});

test('Shredder-FEN option emits file letters that chessops also accepts', () => {
  const fen = chess960Fen(0, { shredder: true });
  assert.match(fen, / w HFhf - 0 1$/);
  const pos = Chess.fromSetup(parseFen(fen).value);
  assert.ok(pos.isOk);
  assert.equal(pos.value.castles.rook.white.a, 5);
  assert.equal(pos.value.castles.rook.white.h, 7);
  assert.equal(chess960Fen(518, { shredder: true }), INITIAL_FEN.replace('KQkq', 'HAha'));
});

test('Game.chess960(n) can castle in a sample of positions (castling rights survive loading)', () => {
  // n=0: BBQNNRKR — clear f1 (rook stays h1) is impossible; use a position with king next to rook and empty path.
  const g = Game.fromFen('bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNN1KR w KQkq - 0 1', { variant: 'chess960' });
  assert.equal(g.variant, 'chess960');
  const kingMoves = g.legalMoves('g1').map(m => m.from + m.to);
  assert.ok(kingMoves.includes('g1h1'), 'h-side castling available via king takes rook');
  for (const n of [0, 1, 100, 300, 518, 700, 959]) {
    const game = Game.chess960(n);
    assert.equal(game.chess960Number, n);
    assert.equal(game.variant, 'chess960');
    assert.equal(game.fen(), chess960Fen(n));
    assert.ok(game.legalMoves().length >= 16, `position ${n} has pawn + knight moves at least`);
  }
});

test('chess960NumberOf is the inverse for all n, null otherwise', () => {
  for (let n = 0; n < 960; n++) assert.equal(chess960NumberOf(chess960Fen(n)), n);
  assert.equal(chess960NumberOf(INITIAL_FEN), 518);
  assert.equal(chess960NumberOf('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'), 518);
  assert.equal(chess960NumberOf('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w KQkq - 0 1'), null);
  assert.equal(chess960NumberOf('garbage'), null);
  assert.equal(chess960NumberOf(42), null);
});

test('randomChess960 stays in range', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const n = randomChess960();
    assert.ok(Number.isInteger(n) && n >= 0 && n <= 959);
    seen.add(n);
  }
  assert.ok(seen.size > 20, 'not stuck on one value');
});
