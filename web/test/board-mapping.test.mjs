// Pure mapping helpers from three/board.js (square <-> world). Run: node --test test/board-mapping.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squareToWorld, worldToSquare, isKnightJump, isDarkSquare, SQUARES, FILES } from '../src/three/board.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('corner and centre squares map to the contract coordinates', () => {
  assert.deepEqual(squareToWorld('a1'), { x: -3.5, z: 3.5 });
  assert.deepEqual(squareToWorld('h8'), { x: 3.5, z: -3.5 });
  assert.deepEqual(squareToWorld('h1'), { x: 3.5, z: 3.5 });
  assert.deepEqual(squareToWorld('a8'), { x: -3.5, z: -3.5 });
  const e4 = squareToWorld('e4');
  assert.ok(near(e4.x, 0.5) && near(e4.z, 0.5), 'e4 sits at (0.5, 0.5)');
  const d5 = squareToWorld('d5');
  assert.ok(near(d5.x, -0.5) && near(d5.z, -0.5), 'd5 sits at (-0.5, -0.5)');
});

test('files run along +X and ranks along -Z', () => {
  for (let f = 1; f < 8; f++) assert.ok(squareToWorld(FILES[f] + '1').x > squareToWorld(FILES[f - 1] + '1').x);
  for (let r = 2; r <= 8; r++) assert.ok(squareToWorld('a' + r).z < squareToWorld('a' + (r - 1)).z);
});

test('all 64 squares round-trip through the inverse', () => {
  assert.equal(SQUARES.length, 64);
  for (const sq of SQUARES) {
    const w = squareToWorld(sq);
    assert.equal(worldToSquare(w.x, w.z), sq);
    // anywhere inside the square (not just the centre) resolves to the same square
    assert.equal(worldToSquare(w.x - 0.49, w.z + 0.49), sq);
    assert.equal(worldToSquare(w.x + 0.49, w.z - 0.49), sq);
  }
});

test('the e4 area resolves to e4', () => {
  assert.equal(worldToSquare(0.5, 0.5), 'e4');
  assert.equal(worldToSquare(0.01, 0.99), 'e4');
  assert.equal(worldToSquare(0.99, 0.01), 'e4');
  assert.equal(worldToSquare(-0.01, 0.5), 'd4');
  assert.equal(worldToSquare(0.5, -0.01), 'e5');
});

test('off-board points and bad squares return null', () => {
  assert.equal(worldToSquare(4.2, 0), null);
  assert.equal(worldToSquare(-4.2, 0), null);
  assert.equal(worldToSquare(0, 4.5), null);
  assert.equal(worldToSquare(0, -4.5), null);
  assert.equal(worldToSquare(4, 0), null);   // exact far edge is off the board
  assert.equal(worldToSquare(0, -4), null);
  assert.equal(worldToSquare(NaN, 0), null);
  assert.equal(worldToSquare(undefined, undefined), null);
  assert.equal(squareToWorld('i1'), null);
  assert.equal(squareToWorld('a9'), null);
  assert.equal(squareToWorld('a0'), null);
  assert.equal(squareToWorld('e44'), null);
  assert.equal(squareToWorld(''), null);
  assert.equal(squareToWorld(null), null);
  assert.equal(squareToWorld(undefined), null);
  assert.equal(squareToWorld(42), null);
});

test('knight jumps and square colours', () => {
  assert.equal(isKnightJump('g1', 'f3'), true);
  assert.equal(isKnightJump('b1', 'c3'), true);
  assert.equal(isKnightJump('e4', 'c5'), true);
  assert.equal(isKnightJump('e4', 'g5'), true);
  assert.equal(isKnightJump('e2', 'e4'), false);
  assert.equal(isKnightJump('e4', 'e4'), false);
  assert.equal(isKnightJump('f1', 'c4'), false);
  assert.equal(isKnightJump('zz', 'a1'), false);
  assert.equal(isDarkSquare('a1'), true);
  assert.equal(isDarkSquare('h1'), false);
  assert.equal(isDarkSquare('h8'), true);
  assert.equal(isDarkSquare('a8'), false);
  assert.equal(isDarkSquare('e4'), false);
  assert.equal(isDarkSquare('d4'), true);
  assert.equal(SQUARES.filter(isDarkSquare).length, 32);
});
