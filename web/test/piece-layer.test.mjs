// node --test test/piece-layer.test.mjs
// The piece layer's 2D/3D view-mode behaviour (addendum v1): the set cross-fade, the two set slots,
// token facing under a seat rotation, and what happens to a drag or an in-flight tween across a switch.
//
// The layer's ticker is rAF-driven and finishes a tween synchronously when requestAnimationFrame is
// ABSENT (which is the case in plain node) — that gives end-state assertions for free. Where the
// mid-transition state matters, installRaf() swaps in a manual scheduler so frames can be stepped by
// hand; it is always restored before the test returns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPieceLayer } from '../src/three/pieceLayer.js';
import { createMaterialSet } from '../src/three/materials.js';

const ROLE_OF = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

/** Board-part of a FEN -> the contract's { square, piece }[]. */
function boardFromFen(fen) {
  const ranks = fen.split(' ')[0].split('/');
  const out = [];
  for (let ri = 0; ri < 8; ri++) {
    let f = 0;
    for (const ch of ranks[ri]) {
      if (/\d/.test(ch)) { f += parseInt(ch, 10); continue; }
      out.push({
        square: 'abcdefgh'[f] + (8 - ri),
        piece: { color: ch === ch.toUpperCase() ? 'white' : 'black', role: ROLE_OF[ch.toLowerCase()] },
      });
      f++;
    }
  }
  return out;
}

function makeLayer(settings = {}) {
  const scene = new THREE.Scene();
  const mats = createMaterialSet('wood', null);
  const layer = createPieceLayer(scene, mats, { pieceSet: 'staunton', pieceSet2d: 'glyph', animations: true, ...settings });
  return { scene, mats, layer };
}

/** square -> 'color/role/setId' for every piece the layer currently owns. */
function census(layer) {
  const out = {};
  for (const obj of layer.pieceObjects()) {
    const u = obj.userData;
    out[u.square] = `${u.color}/${u.role}/${u.set}`;
  }
  return out;
}

/** Swap in a hand-driven requestAnimationFrame so tweens can be stepped frame by frame. */
function installRaf() {
  const queue = [];
  const hadRaf = 'requestAnimationFrame' in globalThis;
  const hadCancel = 'cancelAnimationFrame' in globalThis;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => queue.push(fn);
  globalThis.cancelAnimationFrame = () => {};
  return {
    t0: performance.now(),
    /** Run every frame callback queued so far with timestamp `t`. */
    step(t) { for (const fn of queue.splice(0)) fn(t); },
    restore() {
      if (hadRaf) globalThis.requestAnimationFrame = prevRaf; else delete globalThis.requestAnimationFrame;
      if (hadCancel) globalThis.cancelAnimationFrame = prevCancel; else delete globalThis.cancelAnimationFrame;
    },
  };
}

/**
 * Lowest opacity found on a piece's body meshes (1 when nothing is transparent). The contact decal and the glyph
 * card are left out: they are translucent in their own right (a ~0.35 decal, a 0 card whose glyph never loads
 * under node), and a fade scales them relative to that -- see the decal assertion in the cross-fade test.
 */
function opacityOf(obj) {
  let min = 1;
  obj.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.transparent || o.userData.contactShadow || o.userData.glyphCard) return;
    min = Math.min(min, o.material.opacity);
  });
  return min;
}

// ---------------------------------------------------------------- set slots

test('layer: knights turn 25 deg toward the centre line, mirrored per colour, and the turn follows the knight', () => {
  const T = 25 * Math.PI / 180, near = (a, b) => Math.abs(a - b) < 1e-9;
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  // White faces -Z (PI): the queenside knight turns toward +X, the kingside one toward -X -- a three-quarter
  // profile to White's seat; Black's mirror that. Nothing else turns.
  assert.ok(near(layer.meshAt('b1').rotation.y, Math.PI - T), 'b1');
  assert.ok(near(layer.meshAt('g1').rotation.y, Math.PI + T), 'g1');
  assert.ok(near(layer.meshAt('b8').rotation.y, T), 'b8');
  assert.ok(near(layer.meshAt('g8').rotation.y, -T), 'g8');
  assert.equal(layer.meshAt('d1').rotation.y, Math.PI, 'a queen keeps its plain facing');
  // the face still points broadly at the opponent: forward (sin y, cos y) keeps most of its -Z / +Z
  assert.ok(Math.cos(layer.meshAt('b1').rotation.y) < -0.85 && Math.cos(layer.meshAt('g8').rotation.y) > 0.85);

  // a move on the same wing keeps the turn; crossing the centre line eases it round the short way
  const raf = installRaf();
  try {
    const at = (fen) => boardFromFen(fen);
    layer.sync(at('rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R'), { animateFrom: { from: 'g1', to: 'f3' } });
    raf.step(raf.t0 + 1000);
    const k = layer.meshAt('f3');
    assert.ok(near(k.rotation.y, Math.PI + T), 'f3: still the kingside turn');
    layer.sync(at('rnbqkbnr/pppppppp/8/8/3N4/8/PPPPPPPP/RNBQKB1R'), { animateFrom: { from: 'f3', to: 'd4' } });
    const t0 = performance.now();
    raf.step(t0 + 110);
    const mid = k.rotation.y;
    assert.ok(mid > Math.PI - T && mid < Math.PI + T, `mid-move the knight is turning (${mid})`);
    raf.step(t0 + 5000);
    assert.equal(layer.meshAt('d4'), k, 'the same knight, moved');
    assert.ok(near(k.rotation.y, Math.PI - T), 'd4: now the queenside turn');
  } finally {
    raf.restore();
  }

  // flat tokens never turn: they are turned by the seat only
  layer.setViewMode('2d', { animate: false });
  assert.equal(layer.meshAt('b8').rotation.y, 0);
  layer.dispose();
});

test('layer: bishops turn their mitre cut three-quarter to their owner, toward the centre, and the turn follows', () => {
  const Q = Math.PI / 4, wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const near = (a, b) => Math.abs(wrap(a - b)) < 1e-9;
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  // the built-in set's slit is authored facing +Z (bishopCut 0): the cut's azimuth is the yaw itself
  assert.ok(near(layer.meshAt('c1').rotation.y, Q), 'c1: toward White (+Z) and the centre (+X)');
  assert.ok(near(layer.meshAt('f1').rotation.y, -Q), 'f1: toward White and the centre (-X)');
  assert.ok(near(layer.meshAt('c8').rotation.y, Math.PI - Q), 'c8: toward Black (-Z) and the centre (+X)');
  assert.ok(near(layer.meshAt('f8').rotation.y, Math.PI + Q), 'f8: toward Black and the centre (-X)');
  // the cut faces its owner's seat more than the opponent's
  assert.ok(Math.cos(layer.meshAt('c1').rotation.y) > 0.7 && Math.cos(layer.meshAt('f8').rotation.y) < -0.7);

  const raf = installRaf();
  try {
    // c1 -> f4 crosses the centre line: the cut swings round to the other side's turn
    layer.sync(boardFromFen('rnbqkbnr/pppppppp/8/8/5B2/3P4/PPP1PPPP/RN1QKBNR'), { animateFrom: { from: 'c1', to: 'f4' } });
    raf.step(raf.t0 + 5000);
    assert.ok(near(layer.meshAt('f4').rotation.y, -Q), 'f4: the kingside turn');
  } finally {
    raf.restore();
  }
  layer.dispose();
});

test('layer: fadeIn brings every piece in from nothing and hands the shared materials back', async () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const k = layer.meshAt('e1');
  const shared = [];
  k.traverse((o) => { if (o.isMesh) shared.push(o.material); });
  const raf = installRaf();
  try {
    const done = layer.fadeIn(200);
    raf.step(raf.t0 + 1);
    assert.ok(opacityOf(k) < 0.2, `starts from (nearly) nothing (${opacityOf(k)})`);
    raf.step(raf.t0 + 120);
    const mid = opacityOf(k);
    assert.ok(mid > 0.2 && mid < 1, `half way (${mid})`);
    raf.step(raf.t0 + 1000);
    await done;
    const after = [];
    k.traverse((o) => { if (o.isMesh) after.push(o.material); });
    assert.deepEqual(after, shared, 'the shared materials are back (the fade ran on clones)');
    assert.equal(opacityOf(k), 1);
  } finally {
    raf.restore();
  }
  // with animations off it is instant
  layer.setAnimations(false);
  await layer.fadeIn();
  assert.equal(opacityOf(k), 1);
  layer.dispose();
});

test('layer: the two set slots are independent; setSet is 3D, setSet2d is 2D', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  assert.equal(layer.viewMode(), '3d');
  assert.equal(layer.currentSet(), 'staunton');
  assert.deepEqual([layer.setFor('3d'), layer.setFor('2d')], ['staunton', 'glyph']);

  // A 2D-set change while 3D is showing is remembered, not applied.
  layer.setSet2d('minimal');
  assert.equal(layer.currentSet(), 'staunton', '3D pieces are untouched');
  assert.equal(layer.setFor('2d'), 'minimal');

  layer.setViewMode('2d', { animate: false });
  assert.equal(layer.currentSet(), 'minimal');
  assert.equal(layer.meshAt('e1').userData.set, 'minimal');

  // ...and now a 3D-set change is the one that is only remembered.
  layer.setSet('glyph');
  assert.equal(layer.currentSet(), 'minimal', '2D pieces are untouched');
  assert.equal(layer.setFor('3d'), 'glyph');
  layer.setViewMode('3d', { animate: false });
  assert.equal(layer.currentSet(), 'glyph');

  // Unknown ids fall back per slot.
  layer.setSet('nope');
  assert.equal(layer.setFor('3d'), 'staunton');
  layer.setSet2d('nope');
  assert.equal(layer.setFor('2d'), 'glyph');
  layer.dispose();
});

test('layer: settings.viewMode "2d" boots straight onto the token set', () => {
  const { layer } = makeLayer({ viewMode: '2d', pieceSet: 'staunton', pieceSet2d: 'glyph' });
  layer.sync(boardFromFen(START), { instant: true });
  assert.equal(layer.viewMode(), '2d');
  assert.equal(layer.currentSet(), 'glyph');
  assert.equal(layer.meshAt('a1').userData.set, 'glyph');
  // main.js's boot call layer.setSet(settings.pieceSet) must not clobber the 2D set.
  layer.setSet('staunton');
  assert.equal(layer.currentSet(), 'glyph');
  layer.dispose();
});

// ---------------------------------------------------------------- the swap

test('layer: setViewMode swaps the set and preserves every square', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const before = census(layer);
  const positions = {};
  for (const obj of layer.pieceObjects()) positions[obj.userData.square] = obj.position.toArray();

  layer.setViewMode('2d', { animate: false });
  assert.equal(layer.viewMode(), '2d');
  assert.equal(layer.currentSet(), 'glyph');
  assert.equal(layer.pieceObjects().length, 32);
  const after = census(layer);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'same squares occupied');
  for (const sq of Object.keys(before)) {
    assert.equal(after[sq].split('/').slice(0, 2).join('/'), before[sq].split('/').slice(0, 2).join('/'), sq);
    assert.equal(after[sq].split('/')[2], 'glyph', `${sq} is a token now`);
    assert.deepEqual(layer.meshAt(sq).position.toArray(), positions[sq], `${sq} did not move`);
  }

  layer.setViewMode('3d', { animate: false });
  assert.deepEqual(census(layer), before, 'and back again, unchanged');
  layer.dispose();
});

test('layer: setViewMode to the same mode is a no-op (meshes keep their identity)', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const k = layer.meshAt('e1');
  layer.setViewMode('3d');
  assert.equal(layer.meshAt('e1'), k, 'nothing was rebuilt');
  layer.setViewMode('2d', { animate: false });
  assert.notEqual(layer.meshAt('e1'), k);
  const t = layer.meshAt('e1');
  layer.setViewMode('2d');
  assert.equal(layer.meshAt('e1'), t);
  layer.dispose();
});

test('layer: the cross-fade runs both sets at once and restores the shared materials', async () => {
  const { scene, mats, layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const disposals = [];
  mats.whitePiece.addEventListener('dispose', () => disposals.push('white'));
  mats.blackPiece.addEventListener('dispose', () => disposals.push('black'));
  const oldKing = layer.meshAt('e1');

  const raf = installRaf();
  try {
    const done = layer.setViewMode('2d');            // animations: true -> fades
    assert.equal(layer.meshAt('e1').userData.set, 'glyph', 'the new set is live from frame zero');
    assert.notEqual(layer.meshAt('e1'), oldKing);
    assert.equal(layer.pieceObjects().length, 32, 'only the incoming set is a raycast target');
    assert.equal(layer.group.children.length, 64, 'both sets are in the scene during the fade');
    assert.ok(layer.isAnimating());

    raf.step(raf.t0 + 100);                          // ~40% through the 240 ms fade
    const inOpacity = opacityOf(layer.meshAt('e1'));
    const outOpacity = opacityOf(oldKing);
    assert.ok(inOpacity > 0 && inOpacity < 1, `incoming mid-fade opacity ${inOpacity}`);
    assert.ok(outOpacity > 0 && outOpacity < 1, `outgoing mid-fade opacity ${outOpacity}`);
    assert.ok(Math.abs(inOpacity + outOpacity - 1) < 1e-6, 'the two sides cross exactly');
    // the translucent contact decal fades from its own opacity, not from a solid disc
    const decal = oldKing.userData.contactShadow;
    assert.ok(Math.abs(decal.material.opacity - outOpacity * mats.contactShadow.opacity) < 1e-6,
      `decal mid-fade ${decal.material.opacity} = ${outOpacity} x ${mats.contactShadow.opacity}`);

    raf.step(raf.t0 + 5000);                         // land it
    await done;
    assert.equal(layer.group.children.length, 32, 'the outgoing set is gone');
    assert.equal(layer.isAnimating(), false);
    assert.equal(oldKing.parent, null);
    let shared = true;
    layer.meshAt('e1').traverse((o) => {
      if (o.isMesh && !o.userData.keepMaterial && o.material !== mats.whitePiece) shared = false;
      if (o.isMesh && o.userData.fadeMaterial) shared = false;
    });
    assert.ok(shared, 'the surviving pieces use the shared material again, not a fade clone');
    assert.deepEqual(disposals, [], 'the shared materials were never disposed by the fade');
  } finally {
    raf.restore();
  }
  assert.equal(scene.children[0], layer.group);
  layer.dispose();
});

test('layer: setMaterials during a cross-fade lands it instead of leaking clones', () => {
  const { mats, layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const disposals = [];
  mats.whitePiece.addEventListener('dispose', () => disposals.push('white'));
  const raf = installRaf();
  let metal;
  try {
    layer.setViewMode('2d');
    assert.equal(layer.group.children.length, 64);
    metal = createMaterialSet('metal', null);
    layer.setMaterials(metal);
    assert.equal(layer.group.children.length, 32, 'the fade was landed first');
    let ok = true;
    layer.meshAt('e1').traverse((o) => {
      if (o.isMesh && !o.userData.keepMaterial && o.material !== metal.whitePiece) ok = false;
    });
    assert.ok(ok, 'the new theme reached every piece');
    assert.deepEqual(disposals, [], 'the old shared material survived');
  } finally {
    raf.restore();
  }
  layer.dispose();
  if (metal) metal.dispose();
});

// ---------------------------------------------------------------- drags and tweens across a switch

test('layer: a mode switch mid-drag cancels cleanly instead of stranding a lifted piece', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const knight = layer.meshAt('g1');
  layer.lift('g1');
  layer.dragTo(new THREE.Vector3(-0.5, 0, 1.5));
  assert.ok(knight.position.y > 0.3, 'lifted and following the pointer');

  layer.setViewMode('2d', { animate: false });
  const token = layer.meshAt('g1');
  assert.notEqual(token, knight);
  assert.equal(token.userData.set, 'glyph');
  assert.deepEqual(token.position.toArray(), [2.5, 0, 3.5], 're-seated on its own square');
  assert.equal(token.scale.x, 1, 'and back to its resting scale');
  assert.equal(knight.parent, null, 'the lifted mesh is gone, not left hovering');
  assert.equal(layer.isAnimating(), false);

  // The drop that interact.js would have sent after the switch must do nothing.
  layer.drop('f3');
  assert.deepEqual(token.position.toArray(), [2.5, 0, 3.5], 'the stale drop is a no-op');
  assert.equal(layer.meshAt('g1'), token);
  assert.equal(layer.meshAt('f3'), null);
  layer.dispose();
});

test('layer: a mode switch mid-animation lands the move first, then swaps', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const raf = installRaf();
  try {
    // A promotion is the hard case: its slide's done() swaps pawn -> queen.
    layer.sync(boardFromFen('4k3/4P3/8/8/8/8/8/4K3'), { instant: true });
    layer.sync(boardFromFen('4Q3/8/8/8/8/8/8/4K3'), { animateFrom: { from: 'e7', to: 'e8', captured: 'king', promotion: 'q' } });
    assert.ok(layer.isAnimating(), 'the slide is in flight');

    layer.setViewMode('2d', { animate: false });
    assert.equal(layer.isAnimating(), false);
    assert.deepEqual(census(layer), { e8: 'white/queen/glyph', e1: 'white/king/glyph' });
    assert.deepEqual(layer.meshAt('e8').position.toArray(), [0.5, 0, -3.5], 'the promoted queen landed');
    assert.equal(layer.group.children.length, 2, 'the captured/outgoing meshes were all cleaned up');
  } finally {
    raf.restore();
  }
  layer.dispose();
});

test('layer: a drag started in 2D lifts less and scales more (top-down readability)', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  layer.lift('g1');
  const n3 = layer.meshAt('g1');
  const y3 = n3.position.y, s3 = n3.scale.x;
  layer.drop(null);

  layer.setViewMode('2d', { animate: false });
  layer.lift('g1');
  const n2 = layer.meshAt('g1');
  assert.ok(n2.position.y > 0, 'the token still lifts off the board');
  assert.ok(n2.position.y < y3, 'but less than a sculpted piece does');
  assert.ok(n2.scale.x > s3, 'and it grows more, which is what reads from straight above');
  layer.dragTo(new THREE.Vector3(1.5, 0, 1.5));
  assert.deepEqual([n2.position.x, n2.position.y, n2.position.z], [1.5, n2.position.y, 1.5]);
  layer.drop('f3');
  assert.deepEqual(n2.position.toArray(), [1.5, 0, 1.5], 'settles flat on the drop square');
  layer.dispose();
});

// ---------------------------------------------------------------- token facing

test('layer: token facing follows the orientation, and sculpted sets still face by colour', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  assert.equal(layer.meshAt('e1').rotation.y, Math.PI, '3D: white faces -Z');
  assert.equal(layer.meshAt('e8').rotation.y, 0, '3D: black faces +Z');

  layer.setViewMode('2d', { animate: false });
  for (const sq of ['e1', 'e8', 'a1', 'h8']) {
    assert.equal(layer.meshAt(sq).rotation.y, 0, `${sq}: tokens read upright from White's seat`);
  }

  layer.setOrientation('black');
  for (const sq of ['e1', 'e8', 'a1', 'h8']) {
    assert.equal(layer.meshAt(sq).rotation.y, Math.PI, `${sq}: and upright from Black's seat`);
  }

  // A piece built while the black seat is showing is born the right way up.
  layer.sync(boardFromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'), { animateFrom: { from: 'e2', to: 'e4' } });
  assert.equal(layer.meshAt('e4').rotation.y, Math.PI);
  layer.sync(boardFromFen(START), { instant: true });
  assert.equal(layer.meshAt('e2').rotation.y, Math.PI, 'a rebuild keeps the seat too');

  // Back to 3D: the seat spin does not apply to a sculpted set, colour facing returns.
  layer.setViewMode('3d', { animate: false });
  assert.equal(layer.meshAt('e1').rotation.y, Math.PI);
  assert.equal(layer.meshAt('e8').rotation.y, 0);
  // ...and switching back into 2D while Black is seated gets the tokens right again.
  layer.setViewMode('2d', { animate: false });
  assert.equal(layer.meshAt('e1').rotation.y, Math.PI);
  layer.setOrientation('white');
  assert.equal(layer.meshAt('e1').rotation.y, 0);
  layer.dispose();
});

test('layer: the seat turn is animated so tokens rotate WITH view.rotateSeat', async () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  layer.setViewMode('2d', { animate: false });
  const raf = installRaf();
  try {
    const done = layer.setOrientation('black', { duration: 700 });
    assert.ok(layer.isAnimating(), 'the turn is a tween, not a jump');
    raf.step(raf.t0 + 350);
    const mid = layer.meshAt('e1').rotation.y;
    assert.ok(mid > 0 && mid < Math.PI, `mid-turn rotation ${mid}`);
    // every token turns together, including one built during the turn
    for (const obj of layer.pieceObjects()) assert.equal(obj.rotation.y, mid);
    layer.sync(boardFromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'), { instant: true });
    assert.equal(layer.meshAt('e4').rotation.y, Math.PI, 'an instant rebuild lands the turn first');
    await done;
    assert.equal(layer.isAnimating(), false);
    for (const obj of layer.pieceObjects()) assert.equal(obj.rotation.y, Math.PI);
  } finally {
    raf.restore();
  }

  // animate: false is still an instant set (and a sculpted set never spins at all).
  layer.setOrientation('white', { animate: false });
  assert.equal(layer.meshAt('e1').rotation.y, 0);
  layer.setViewMode('3d', { animate: false });
  layer.setOrientation('black');
  assert.equal(layer.meshAt('e1').rotation.y, Math.PI, 'staunton white still faces -Z, seat ignored');
  assert.equal(layer.meshAt('e8').rotation.y, 0);
  layer.dispose();
});

test('layer: a switch during the seat turn still ends up upright for the seat', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  layer.setViewMode('2d', { animate: false });
  const raf = installRaf();
  try {
    layer.setOrientation('black', { duration: 700 });
    raf.step(raf.t0 + 200);
    assert.ok(layer.meshAt('e1').rotation.y < Math.PI);
    layer.setViewMode('3d', { animate: false });
    layer.setViewMode('2d', { animate: false });
    for (const obj of layer.pieceObjects()) {
      assert.equal(obj.rotation.y, Math.PI, 'the turn was landed, not left half-way');
    }
  } finally {
    raf.restore();
  }
  layer.dispose();
});
