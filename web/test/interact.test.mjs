// Tests for src/three/interact.js — the pointer state machine, driven by synthetic
// PointerEvent-like objects against fake view / board / layer / store / actions.
// Run: node --test test/interact.test.mjs   (from the app folder)

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createInteraction, colorFromModifiers, isKnightJump } from '../src/three/interact.js';

// Make the hover throttle synchronous in tests.
globalThis.requestAnimationFrame = (fn) => {
  fn();
  return 1;
};

const FILES = 'abcdefgh';

/** Screen coordinates for a square: 100 px cells, a8 at the top-left. */
function xy(square) {
  const f = FILES.indexOf(square[0]);
  const r = Number(square[1]) - 1;
  return [f * 100 + 50, (7 - r) * 100 + 50];
}

function squareAtXY(x, y) {
  if (x < 0 || y < 0 || x >= 800 || y >= 800) return null;
  const f = Math.floor(x / 100);
  const r = 7 - Math.floor(y / 100);
  if (f < 0 || f > 7 || r < 0 || r > 7) return null;
  return FILES[f] + (r + 1);
}

// ---------------------------------------------------------------- DOM shim

function makeElement() {
  const listeners = [];
  const el = {
    style: {},
    captured: new Set(),
    addEventListener(type, fn, opts) {
      listeners.push({ type, fn, capture: !!(opts === true || (opts && opts.capture)) });
    },
    removeEventListener(type, fn, opts) {
      const capture = !!(opts === true || (opts && opts.capture));
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
    setPointerCapture(id) {
      el.captured.add(id);
    },
    releasePointerCapture(id) {
      el.captured.delete(id);
    },
    hasPointerCapture(id) {
      return el.captured.has(id);
    },
    listenerCount() {
      return listeners.length;
    },
    dispatch(type, init = {}) {
      const e = {
        type,
        pointerId: 1,
        pointerType: 'mouse',
        button: 0,
        buttons: 0,
        clientX: 0,
        clientY: 0,
        shiftKey: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        defaultPrevented: false,
        stopped: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopImmediatePropagation() {
          this.stopped = true;
        },
        stopPropagation() {},
        ...init,
      };
      // Capture-phase listeners first, then bubble — like the DOM at the target.
      const ordered = [...listeners.filter((l) => l.type === type && l.capture), ...listeners.filter((l) => l.type === type && !l.capture)];
      for (const l of ordered) {
        if (e.stopped) break;
        l.fn(e);
      }
      return e;
    },
  };
  return el;
}

// ---------------------------------------------------------------- world fakes

/**
 * pieces: { e2: { color:'white', role:'pawn' }, ... }
 * opts.legal: { e2: ['e3','e4'] }   legal targets per square (drives attemptMove + select)
 * opts.reject: ['e2g1']             uci strings that attemptMove refuses even if in legal
 * opts.promote: ['e7e8']            uci strings for which attemptMove returns 'promotion'
 */
function makeWorld(pieces, opts = {}) {
  const el = makeElement();
  const calls = [];
  const rec = (...a) => calls.push(a);
  const roots = new Map();
  const rebuildRoots = () => {
    roots.clear();
    for (const [square, piece] of Object.entries(pieces)) {
      const root = { name: `piece-${square}`, userData: { square, ...piece }, parent: null };
      root.child = { name: `mesh-${square}`, userData: {}, parent: root };
      roots.set(square, root);
    }
  };
  rebuildRoots();
  const squareMeshes = new Map();
  for (const f of FILES) for (let r = 1; r <= 8; r++) squareMeshes.set(`${f}${r}`, { name: `sq-${f}${r}`, parent: null });

  // A stand-in for OrbitControls' own pointerdown listener (registered BEFORE the interaction).
  const orbit = { downs: [] };
  el.addEventListener('pointerdown', (e) => orbit.downs.push(e.button));

  const view = {
    renderer: { domElement: el },
    controlsEnabled: true,
    setControlsEnabled(b) {
      rec('controls', b);
      view.controlsEnabled = b;
    },
    raycast(x, y, objects) {
      const s = squareAtXY(x, y);
      if (!s) return [];
      const root = roots.get(s);
      if (root && objects.includes(root)) return [{ object: root.child, distance: 1 }];
      const sm = squareMeshes.get(s);
      if (sm && objects.includes(sm)) return [{ object: sm, distance: 2 }];
      return [];
    },
    pointerToPlane(x, y) {
      if (x < 0 || y < 0 || x >= 800 || y >= 800) return null;
      return { x: x / 100 - 4, y: 0, z: y / 100 - 4 };
    },
    focusOn(...a) {
      rec('focusOn', ...a);
    },
    setPreset(p) {
      rec('preset', p);
    },
  };
  const board = {
    squareMeshes,
    squareAtPoint(p) {
      if (!p) return null;
      const f = Math.floor(p.x + 4);
      const r = 7 - Math.floor(p.z + 4);
      if (f < 0 || f > 7 || r < 0 || r > 7) return null;
      return FILES[f] + (r + 1);
    },
    setPreviewArrow(a) {
      rec('preview', a);
    },
    setSelected(s) {
      rec('setSelected', s);
    },
    setLegalTargets(t, c) {
      rec('setLegalTargets', t, c);
    },
  };
  const layer = {
    pieceObjects: () => [...roots.values()],
    squareOf(o) {
      let x = o;
      while (x) {
        if (x.userData && x.userData.square) return x.userData.square;
        x = x.parent;
      }
      return null;
    },
    lift(s) {
      rec('lift', s);
    },
    dragTo(p) {
      rec('dragTo', p);
    },
    drop(s) {
      rec('drop', s);
    },
    rootAt: (s) => roots.get(s),
  };
  const handlers = new Map();
  const store = {
    state: {
      mode: 'play',
      setup: null,
      selected: null,
      legalTargets: [],
      orientation: 'white',
      viewMode: opts.viewMode === '2d' ? '2d' : '3d',
      settings: { showLegalMoves: true },
      game: {
        turn: () => opts.turn || 'white',
        pieceAt: (s) => pieces[s] || null,
      },
    },
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev).add(fn);
      return () => handlers.get(ev).delete(fn);
    },
    off(ev, fn) {
      handlers.get(ev)?.delete(fn);
    },
    emit(ev, payload) {
      for (const fn of [...(handlers.get(ev) || [])]) fn(payload);
    },
    listenerCount() {
      let n = 0;
      for (const s of handlers.values()) n += s.size;
      return n;
    },
  };
  const legal = opts.legal || {};
  const actions = {
    select(s) {
      rec('select', s);
      store.state.selected = s;
      store.state.legalTargets = s ? legal[s] || [] : [];
      store.emit('selection:change', { selected: s, legalTargets: store.state.legalTargets });
    },
    attemptMove(m) {
      rec('attemptMove', m);
      const uci = m.from + m.to;
      if (!(legal[m.from] || []).includes(m.to) || (opts.reject || []).includes(uci)) return 'illegal';
      if ((opts.promote || []).includes(uci)) {
        store.emit('promotion:required', m);
        return 'promotion';
      }
      pieces[m.to] = pieces[m.from];
      delete pieces[m.from];
      rebuildRoots();
      store.state.selected = null;
      store.state.legalTargets = [];
      store.emit('game:change', { reason: 'move', move: m });
      store.emit('selection:change', { selected: null, legalTargets: [] });
      return 'played';
    },
    toggleHighlight(s, c) {
      rec('toggleHighlight', s, c);
      return true;
    },
    toggleArrow(a) {
      rec('toggleArrow', a);
      return true;
    },
    setupPlace(s, p) {
      rec('setupPlace', s, p);
    },
  };
  const baseline = el.listenerCount();
  const ix = createInteraction({ view, board, layer, store, actions });
  const only = (name) => calls.filter((c) => c[0] === name);
  const names = () => calls.map((c) => c[0]);
  const press = (square, init = {}) => {
    const [clientX, clientY] = Array.isArray(square) ? square : xy(square);
    return el.dispatch('pointerdown', { clientX, clientY, button: 0, buttons: 1, ...init });
  };
  const move = (square, init = {}) => {
    const [clientX, clientY] = Array.isArray(square) ? square : xy(square);
    return el.dispatch('pointermove', { clientX, clientY, buttons: 1, ...init });
  };
  const release = (square, init = {}) => {
    const [clientX, clientY] = Array.isArray(square) ? square : xy(square);
    return el.dispatch('pointerup', { clientX, clientY, button: 0, buttons: 0, ...init });
  };
  const rpress = (square, init = {}) => press(square, { button: 2, buttons: 2, ...init });
  const rmove = (square, init = {}) => move(square, { buttons: 2, ...init });
  const rrelease = (square, init = {}) => release(square, { button: 2, ...init });
  /** Flip the view mode the way core/store's actions.setViewMode does (state first, then the event). */
  const setViewMode = (mode) => {
    const previous = store.state.viewMode;
    store.state.viewMode = mode;
    store.emit('viewmode:change', { mode, previous });
  };
  return { el, view, board, layer, store, actions, calls, only, names, ix, press, move, release, rpress, rmove, rrelease, setViewMode, orbit, baseline, pieces };
}

const startPieces = () => ({
  e2: { color: 'white', role: 'pawn' },
  g1: { color: 'white', role: 'knight' },
  e1: { color: 'white', role: 'king' },
  d5: { color: 'black', role: 'pawn' },
  e7: { color: 'black', role: 'pawn' },
  e8: { color: 'black', role: 'king' },
});
const startLegal = () => ({ e2: ['e3', 'e4'], g1: ['f3', 'h3'], e1: ['d1', 'f1'] });

// ---------------------------------------------------------------- helpers

test('colorFromModifiers and isKnightJump', () => {
  assert.equal(colorFromModifiers({}), 'green');
  assert.equal(colorFromModifiers({ shiftKey: true }), 'red');
  assert.equal(colorFromModifiers({ altKey: true }), 'blue');
  assert.equal(colorFromModifiers({ ctrlKey: true }), 'yellow');
  assert.equal(colorFromModifiers({ shiftKey: true, ctrlKey: true }), 'red');
  assert.equal(isKnightJump('g1', 'f3'), true);
  assert.equal(isKnightJump('b1', 'd2'), true);
  assert.equal(isKnightJump('e2', 'e4'), false);
  assert.equal(isKnightJump('a1', 'h8'), false);
});

// ---------------------------------------------------------------- click flow

test('click-select then click-move plays the move and clears selection', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const down = w.press('e2');
  assert.equal(down.stopped, true, 'piece press is kept from OrbitControls');
  assert.deepEqual(w.orbit.downs, [], 'orbit never saw the press');
  assert.equal(w.view.controlsEnabled, false, 'controls off while the button is down');
  assert.equal(w.el.hasPointerCapture(1), true);
  w.release('e2');
  assert.equal(w.store.state.selected, 'e2');
  assert.equal(w.view.controlsEnabled, true, 'controls back on after the click');
  assert.equal(w.el.hasPointerCapture(1), false);
  assert.deepEqual(w.only('setSelected').at(-1), ['setSelected', 'e2']);
  assert.deepEqual(w.only('setLegalTargets').at(-1), ['setLegalTargets', ['e3', 'e4'], []]);

  // Click the empty target square: this press falls through to the controls (no capture).
  const down2 = w.press('e4');
  assert.equal(down2.stopped, false);
  assert.deepEqual(w.orbit.downs, [0], 'orbit saw the empty-square press');
  assert.equal(w.el.hasPointerCapture(1), false);
  w.release('e4');
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'e2', to: 'e4' }]]);
  assert.equal(w.store.state.selected, null);
  assert.equal(w.pieces.e4.role, 'pawn');
  assert.deepEqual(w.only('setLegalTargets').at(-1), ['setLegalTargets', [], []]);
  assert.equal(w.ix.phase(), 'idle');
});

test('clicking the selected piece again deselects; clicking elsewhere deselects; clicking another own piece reselects', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.release('e2');
  assert.equal(w.store.state.selected, 'e2');
  w.press('e2');
  w.release('e2');
  assert.equal(w.store.state.selected, null, 'toggle off');

  w.press('e2');
  w.release('e2');
  w.press('g1');
  w.release('g1');
  assert.equal(w.store.state.selected, 'g1', 'reselect another own piece');
  assert.equal(w.only('attemptMove').length, 0);

  w.press('a4');
  w.release('a4');
  assert.equal(w.store.state.selected, null, 'click on a non-target square deselects');
  assert.equal(w.only('attemptMove').length, 0);
});

test('clicking an opponent piece that is a legal target captures it', () => {
  const pieces = startPieces();
  pieces.e4 = { color: 'white', role: 'pawn' };
  delete pieces.e2;
  const w = makeWorld(pieces, { legal: { e4: ['e5', 'd5'] } });
  w.press('e4');
  w.release('e4');
  assert.deepEqual(w.only('setLegalTargets').at(-1), ['setLegalTargets', ['e5', 'd5'], ['d5']], 'd5 marked as a capture');
  const down = w.press('d5');
  assert.equal(down.stopped, false, 'opponent piece press is not claimed');
  w.release('d5');
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'e4', to: 'd5' }]]);
  assert.equal(w.pieces.d5.color, 'white');
});

test('illegal click-move keeps selection on an own piece target, deselects otherwise', () => {
  // g1 is listed as a target of e2 so the click reaches attemptMove, which refuses it.
  const w = makeWorld(startPieces(), { legal: { e2: ['e3', 'e4', 'g1', 'a4'], g1: ['f3'] }, reject: ['e2g1', 'e2a4'] });
  w.press('e2');
  w.release('e2');
  w.press('g1');
  w.release('g1');
  assert.deepEqual(w.only('attemptMove').at(-1), ['attemptMove', { from: 'e2', to: 'g1' }]);
  assert.equal(w.store.state.selected, 'g1', 'own piece -> reselect');

  w.press('e2');
  w.release('e2');
  w.press('a4');
  w.release('a4');
  assert.deepEqual(w.only('attemptMove').at(-1), ['attemptMove', { from: 'e2', to: 'a4' }]);
  assert.equal(w.store.state.selected, null, 'empty square -> deselect');
});

test('an orbit drag on empty board does not touch the selection', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.release('e2');
  w.press('c4');
  w.move([xy('c4')[0] + 60, xy('c4')[1] + 40]);
  w.release([xy('c4')[0] + 60, xy('c4')[1] + 40]);
  assert.equal(w.store.state.selected, 'e2');
  assert.equal(w.only('attemptMove').length, 0);
  assert.equal(w.only('lift').length, 0);
});

test('pressing a piece of the side NOT to move falls through to the controls', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const down = w.press('e7');
  assert.equal(down.stopped, false);
  assert.deepEqual(w.orbit.downs, [0]);
  assert.equal(w.view.controlsEnabled, true);
  w.release('e7');
  assert.equal(w.only('select').length, 0);
});

// ---------------------------------------------------------------- drag flow

test('drag threshold: 4 px keeps a click a click, beyond it lifts the piece', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const [x, y] = xy('e2');
  w.press('e2');
  w.move([x + 2, y + 2]);
  assert.equal(w.only('lift').length, 0);
  assert.equal(w.ix.phase(), 'pending');
  w.move([x + 5, y + 0]);
  assert.deepEqual(w.only('lift'), [['lift', 'e2']]);
  assert.equal(w.ix.phase(), 'dragging');
  assert.equal(w.el.style.cursor, 'grabbing');
  const drag = w.only('dragTo').at(-1);
  assert.ok(drag && typeof drag[1].x === 'number' && drag[1].y === 0, 'dragTo receives the plane point');
});

test('drag-drop to a legal square: controls off during, attemptMove, drop(to), controls back on', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.move('e3');
  w.move('e4');
  assert.equal(w.view.controlsEnabled, false);
  w.release('e4');
  const seq = w.names().filter((n) => ['controls', 'lift', 'attemptMove', 'drop'].includes(n));
  assert.deepEqual(seq, ['controls', 'lift', 'attemptMove', 'drop', 'controls']);
  assert.deepEqual(w.only('controls').map((c) => c[1]), [false, true]);
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'e2', to: 'e4' }]]);
  assert.deepEqual(w.only('drop'), [['drop', 'e4']]);
  assert.equal(w.view.controlsEnabled, true);
  assert.equal(w.el.hasPointerCapture(1), false);
  assert.equal(w.el.style.cursor, '');
  assert.equal(w.store.state.selected, null);
  assert.equal(w.ix.phase(), 'idle');
});

test('drag to an illegal square snaps back and keeps the piece selected', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.move('e5');
  w.release('e5');
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'e2', to: 'e5' }]]);
  assert.deepEqual(w.only('drop'), [['drop', null]]);
  assert.equal(w.store.state.selected, 'e2');
  assert.equal(w.view.controlsEnabled, true);
});

test('drag off the board or back onto its own square snaps back without attemptMove', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.move('e4');
  w.release([-50, -50]);
  assert.deepEqual(w.only('drop'), [['drop', null]]);
  assert.equal(w.only('attemptMove').length, 0);
  w.press('e2');
  w.move('e4');
  w.release('e2');
  assert.deepEqual(w.only('drop'), [['drop', null], ['drop', null]]);
  assert.equal(w.only('attemptMove').length, 0);
});

test('promotion result leaves the piece on the target square', () => {
  const pieces = { e7: { color: 'white', role: 'pawn' }, e1: { color: 'white', role: 'king' }, a8: { color: 'black', role: 'king' } };
  const w = makeWorld(pieces, { legal: { e7: ['e8'] }, promote: ['e7e8'] });
  w.press('e7');
  w.move('e8');
  w.release('e8');
  assert.deepEqual(w.only('drop'), [['drop', 'e8']]);
  assert.equal(w.view.controlsEnabled, true);
});

test('click a piece, then drag a different piece', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.release('e2');
  w.press('g1');
  w.move('f3');
  w.release('f3');
  assert.deepEqual(w.only('lift'), [['lift', 'g1']]);
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'g1', to: 'f3' }]]);
  assert.deepEqual(w.only('drop'), [['drop', 'f3']]);
});

test('pointercancel mid-drag snaps back and re-enables controls', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.move('e4');
  w.el.dispatch('pointercancel', { pointerId: 1 });
  assert.deepEqual(w.only('drop'), [['drop', null]]);
  assert.equal(w.view.controlsEnabled, true);
  assert.equal(w.ix.phase(), 'idle');
  // A later stray pointerup is ignored.
  w.release('e4');
  assert.equal(w.only('attemptMove').length, 0);
});

test('an external game:change during a drag aborts it', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.move('e4');
  w.store.emit('game:change', { reason: 'goto' });
  assert.deepEqual(w.only('drop'), [['drop', null]]);
  assert.equal(w.view.controlsEnabled, true);
  w.release('e4');
  assert.equal(w.only('attemptMove').length, 0);
});

test('mode:change cancels the drag and clears the selection', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.move('e4');
  w.store.state.mode = 'setup';
  w.store.emit('mode:change', { mode: 'setup' });
  assert.deepEqual(w.only('drop'), [['drop', null]]);
  assert.equal(w.store.state.selected, null);
  assert.equal(w.view.controlsEnabled, true);
});

test('setup mode: any piece drags anywhere, off-board removes it, no selection', () => {
  const pieces = startPieces();
  const w = makeWorld(pieces, { legal: startLegal() });
  w.store.state.mode = 'setup';
  w.store.state.setup = { pieces: Object.entries(pieces).map(([square, piece]) => ({ square, piece })), turn: 'white', castling: 'KQkq' };
  w.press('e7'); // black, not the side to move — movable in setup
  assert.equal(w.view.controlsEnabled, false);
  w.move('e5');
  w.release('e5');
  assert.deepEqual(w.only('setupPlace'), [
    ['setupPlace', 'e5', { color: 'black', role: 'pawn' }],
    ['setupPlace', 'e7', null],
  ]);
  assert.deepEqual(w.only('drop'), [['drop', 'e5']]);
  assert.equal(w.only('select').length, 0);
  assert.equal(w.only('attemptMove').length, 0);

  w.press('g1');
  w.move('g4');
  w.release([-10, 400]);
  assert.deepEqual(w.only('setupPlace').at(-1), ['setupPlace', 'g1', null]);
  assert.deepEqual(w.only('drop').at(-1), ['drop', null]);
  assert.equal(w.view.controlsEnabled, true);
});

// ---------------------------------------------------------------- right button

test('right-click toggles a highlight; colour follows the modifiers at release', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const down = w.rpress('d4');
  assert.equal(down.defaultPrevented, true);
  assert.equal(down.stopped, true, 'right press never reaches OrbitControls');
  assert.equal(w.view.controlsEnabled, false);
  w.rrelease('d4');
  assert.deepEqual(w.only('toggleHighlight'), [['toggleHighlight', 'd4', 'green']]);
  assert.equal(w.view.controlsEnabled, true);
  w.rpress('d5'); // on a piece: the piece's square
  w.rrelease('d5', { shiftKey: true });
  assert.deepEqual(w.only('toggleHighlight').at(-1), ['toggleHighlight', 'd5', 'red']);
  w.rpress('a1');
  w.rrelease('a1', { ctrlKey: true });
  assert.deepEqual(w.only('toggleHighlight').at(-1), ['toggleHighlight', 'a1', 'yellow']);
  assert.equal(w.only('toggleArrow').length, 0);
  assert.equal(w.only('select').length, 0);
  assert.equal(w.only('attemptMove').length, 0);
});

test('right-drag draws a preview and toggles an arrow with the modifier colour', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.rpress('g1');
  w.rmove('g2');
  assert.deepEqual(w.only('preview').at(-1), ['preview', { from: 'g1', to: 'g2', color: 'green', knight: false, source: 'user' }]);
  w.rmove('f3', { altKey: true });
  assert.deepEqual(w.only('preview').at(-1), ['preview', { from: 'g1', to: 'f3', color: 'blue', knight: true, source: 'user' }]);
  const previewsBefore = w.only('preview').length;
  w.rmove([xy('f3')[0] + 3, xy('f3')[1] + 3], { altKey: true });
  assert.equal(w.only('preview').length, previewsBefore, 'no preview rebuild while the square and colour are unchanged');
  w.rrelease('f3', { altKey: true });
  assert.deepEqual(w.only('toggleArrow'), [['toggleArrow', { from: 'g1', to: 'f3', color: 'blue', knight: true, source: 'user' }]]);
  assert.deepEqual(w.only('preview').at(-1), ['preview', null], 'preview cleared on release');
  assert.equal(w.only('toggleHighlight').length, 0);
  assert.equal(w.view.controlsEnabled, true);
  assert.equal(w.el.hasPointerCapture(1), false);
  assert.equal(w.ix.phase(), 'idle');
});

test('right-drag back to the start square is a highlight; off-board release is nothing', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.rpress('c3');
  w.rmove('c5');
  w.rmove('c3');
  w.rrelease('c3');
  assert.deepEqual(w.only('toggleHighlight'), [['toggleHighlight', 'c3', 'green']]);
  w.rpress('c3');
  w.rmove('c5');
  w.rrelease([-20, 300]);
  assert.equal(w.only('toggleArrow').length, 0);
  assert.equal(w.only('toggleHighlight').length, 1);
  assert.equal(w.view.controlsEnabled, true);
});

test('right button released while the left is still held (reported as pointermove) still completes the arrow', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.rpress('b1');
  w.rmove('c3');
  w.el.dispatch('pointermove', { clientX: xy('c3')[0], clientY: xy('c3')[1], buttons: 1, button: 2 });
  assert.deepEqual(w.only('toggleArrow'), [['toggleArrow', { from: 'b1', to: 'c3', color: 'green', knight: true, source: 'user' }]]);
  assert.equal(w.ix.phase(), 'idle');
});

test('contextmenu on the canvas is suppressed', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const e = w.el.dispatch('contextmenu', {});
  assert.equal(e.defaultPrevented, true);
});

// ---------------------------------------------------------------- double click, hover

test('dblclick focuses a piece, dblclick on the board resets the preset', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.el.dispatch('dblclick', { clientX: xy('g1')[0], clientY: xy('g1')[1] });
  assert.deepEqual(w.only('focusOn'), [['focusOn', w.layer.rootAt('g1'), 3]]);
  assert.equal(w.store.state.selected, 'g1');
  w.store.state.orientation = 'black';
  w.el.dispatch('dblclick', { clientX: xy('d4')[0], clientY: xy('d4')[1] });
  assert.deepEqual(w.only('preset'), [['preset', 'black']]);
});

test('hover cursor: grab over movable pieces, pointer over legal targets, empty otherwise', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const hover = (sq) => w.el.dispatch('pointermove', { clientX: xy(sq)[0], clientY: xy(sq)[1], buttons: 0 });
  hover('e2');
  assert.equal(w.el.style.cursor, 'grab');
  hover('e7');
  assert.equal(w.el.style.cursor, '');
  hover('e4');
  assert.equal(w.el.style.cursor, '');
  w.press('e2');
  w.release('e2');
  hover('e4');
  assert.equal(w.el.style.cursor, 'pointer');
  hover('e2');
  assert.equal(w.el.style.cursor, 'grab');
  w.el.dispatch('pointerleave', {});
  assert.equal(w.el.style.cursor, '');
});

test('hover raycasts are throttled to one per frame', () => {
  let queued = [];
  globalThis.requestAnimationFrame = (fn) => {
    queued.push(fn);
    return queued.length;
  };
  try {
    const w = makeWorld(startPieces(), { legal: startLegal() });
    let rays = 0;
    const orig = w.view.raycast;
    w.view.raycast = (...a) => {
      rays++;
      return orig(...a);
    };
    for (let i = 0; i < 10; i++) w.el.dispatch('pointermove', { clientX: xy('e2')[0] + i, clientY: xy('e2')[1], buttons: 0 });
    assert.equal(rays, 0);
    assert.equal(queued.length, 1);
    queued[0]();
    assert.ok(rays >= 1);
    assert.equal(w.el.style.cursor, 'grab');
  } finally {
    globalThis.requestAnimationFrame = (fn) => {
      fn();
      return 1;
    };
  }
});

// ---------------------------------------------------------------- selection visuals

test('selection:change drives board.setSelected / setLegalTargets with capture squares incl. en passant', () => {
  const pieces = { e5: { color: 'white', role: 'pawn' }, d5: { color: 'black', role: 'pawn' }, f6: { color: 'black', role: 'knight' }, e1: { color: 'white', role: 'king' }, e8: { color: 'black', role: 'king' } };
  const w = makeWorld(pieces, { legal: { e5: ['e6', 'd6', 'f6'] } });
  w.actions.select('e5');
  assert.deepEqual(w.only('setSelected').at(-1), ['setSelected', 'e5']);
  assert.deepEqual(w.only('setLegalTargets').at(-1), ['setLegalTargets', ['e6', 'd6', 'f6'], ['d6', 'f6']]);
  w.actions.select(null);
  assert.deepEqual(w.only('setSelected').at(-1), ['setSelected', null]);
  assert.deepEqual(w.only('setLegalTargets').at(-1), ['setLegalTargets', [], []]);
});

test('showLegalMoves=false hides the dots but keeps the selection ring', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.store.state.settings.showLegalMoves = false;
  w.actions.select('e2');
  assert.deepEqual(w.only('setSelected').at(-1), ['setSelected', 'e2']);
  assert.deepEqual(w.only('setLegalTargets').at(-1), ['setLegalTargets', [], []]);
  w.store.state.settings.showLegalMoves = true;
  w.store.emit('settings:change', { path: 'showLegalMoves', value: true, settings: w.store.state.settings });
  assert.deepEqual(w.only('setLegalTargets').at(-1), ['setLegalTargets', ['e3', 'e4'], []]);
});

// ---------------------------------------------------------------- touch

test('touch: tap piece then tap target moves; long-press highlights instead', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const touch = { pointerType: 'touch', pointerId: 7 };
  w.press('e2', touch);
  w.release('e2', touch);
  assert.equal(w.store.state.selected, 'e2');
  w.press('e4', touch);
  w.release('e4', touch);
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'e2', to: 'e4' }]]);

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    w.press('d4', touch);
    mock.timers.tick(499);
    assert.equal(w.only('toggleHighlight').length, 0);
    mock.timers.tick(1);
    assert.deepEqual(w.only('toggleHighlight'), [['toggleHighlight', 'd4', 'green']]);
    w.release('d4', touch);
    assert.equal(w.only('attemptMove').length, 1, 'the consumed long-press did not become a click');

    // Long-press on an own piece: highlight, selection restored to what it was.
    w.press('g1', touch);
    assert.equal(w.store.state.selected, 'g1');
    mock.timers.tick(500);
    assert.deepEqual(w.only('toggleHighlight').at(-1), ['toggleHighlight', 'g1', 'green']);
    assert.equal(w.store.state.selected, null);
    w.release('g1', touch);
    assert.equal(w.view.controlsEnabled, true);

    // Moving cancels the long-press and becomes a drag (10 px touch threshold).
    w.press('g1', touch);
    w.move([xy('g1')[0] + 6, xy('g1')[1]], touch);
    assert.equal(w.only('lift').length, 0);
    w.move('f3', touch);
    assert.deepEqual(w.only('lift'), [['lift', 'g1']]);
    mock.timers.tick(600);
    assert.equal(w.only('toggleHighlight').length, 2, 'no highlight once the finger moved');
    w.release('f3', touch);
    assert.deepEqual(w.only('attemptMove').at(-1), ['attemptMove', { from: 'g1', to: 'f3' }]);
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------- dispose

test('dispose removes listeners and store subscriptions and aborts a drag', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  assert.ok(w.store.listenerCount() > 0);
  assert.ok(w.el.listenerCount() > w.baseline);
  w.press('e2');
  w.move('e4');
  w.ix.dispose();
  assert.deepEqual(w.only('drop'), [['drop', null]]);
  assert.equal(w.view.controlsEnabled, true);
  assert.equal(w.el.listenerCount(), w.baseline, 'only the orbit stand-in remains');
  assert.equal(w.store.listenerCount(), 0);
  w.press('g1');
  w.release('g1');
  assert.equal(w.only('select').length, 1, 'no new selections after dispose');
  w.ix.dispose(); // idempotent
});

test('raycast misses and missing board helpers never throw', () => {
  const w = makeWorld({}, {});
  w.view.raycast = () => [];
  w.view.pointerToPlane = () => null;
  assert.doesNotThrow(() => {
    w.press('e2');
    w.move('e4');
    w.release('e4');
    w.rpress('a1');
    w.rmove('b2');
    w.rrelease('b2');
    w.el.dispatch('dblclick', { clientX: 10, clientY: 10 });
    w.el.dispatch('pointermove', { clientX: 10, clientY: 10, buttons: 0 });
  });
  assert.equal(w.only('attemptMove').length, 0);
  assert.equal(w.only('toggleHighlight').length, 0);
  assert.equal(w.only('toggleArrow').length, 0);
  assert.deepEqual(w.only('preset'), [['preset', 'white']]);
});

// ---------------------------------------------------------------- multi-touch

/** Put the world into Setup mode with the current pieces as the scratch position. */
function setSetup(w, pieces) {
  w.store.state.mode = 'setup';
  w.store.state.setup = {
    pieces: Object.entries(pieces).map(([square, piece]) => ({ square, piece })),
    turn: 'white',
    castling: 'KQkq',
  };
}

test('a second touch pointer cancels the pending gesture: a pinch neither highlights nor moves', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const f1 = { pointerType: 'touch', pointerId: 11 };
  const f2 = { pointerType: 'touch', pointerId: 12 };
  const away = [xy('g6')[0] + 80, xy('g6')[1] + 80];

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    w.press('d4', f1); // finger 1 rests on an empty square
    w.press('g6', f2); // finger 2 lands: this is a pinch, not a long-press
    assert.equal(w.ix.phase(), 'idle', 'our gesture stepped aside for the controls');
    w.move(away, f2);
    mock.timers.tick(600);
    assert.equal(w.only('toggleHighlight').length, 0, 'the resting finger toggles nothing');
  } finally {
    mock.timers.reset();
  }
  w.release('d4', f1);
  w.release(away, f2);
  assert.equal(w.only('attemptMove').length, 0);

  // With a piece selected, the resting finger must not play a move when it lifts.
  w.press('e2', f1);
  w.release('e2', f1);
  assert.equal(w.store.state.selected, 'e2');
  w.press('e4', f1); // soft gesture on a legal target
  w.press('h8', f2); // second finger
  w.release('e4', f1);
  assert.equal(w.only('attemptMove').length, 0, 'the pinch did not play e4');
  assert.equal(w.store.state.selected, 'e2', 'and it did not deselect either');
});

test('a second touch pointer during a piece drag snaps the piece back and re-enables the controls', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const f1 = { pointerType: 'touch', pointerId: 21 };
  const f2 = { pointerType: 'touch', pointerId: 22 };
  w.press('e2', f1);
  w.move('e3', f1);
  assert.deepEqual(w.only('lift'), [['lift', 'e2']]);
  assert.equal(w.view.controlsEnabled, false);
  w.press('d6', f2);
  assert.deepEqual(w.only('drop'), [['drop', null]], 'the lifted piece goes home');
  assert.equal(w.view.controlsEnabled, true, 'the controls get the pinch');
  assert.equal(w.ix.phase(), 'idle');
  w.release('e4', f1);
  assert.equal(w.only('attemptMove').length, 0);
});

test('a second pointer during a right-drag clears the preview and draws no arrow', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.rpress('b1');
  w.rmove('c3');
  assert.ok(w.only('preview').at(-1)[1], 'a preview arrow was showing');
  w.el.dispatch('pointerdown', {
    pointerId: 9,
    pointerType: 'touch',
    button: 0,
    buttons: 1,
    clientX: xy('e5')[0],
    clientY: xy('e5')[1],
  });
  assert.deepEqual(w.only('preview').at(-1), ['preview', null], 'the preview is cleared');
  w.rrelease('c3');
  assert.equal(w.only('toggleArrow').length, 0);
  assert.equal(w.only('toggleHighlight').length, 0);
  assert.equal(w.view.controlsEnabled, true);
});

// ---------------------------------------------------------------- setup mode

test('setup mode: the right button never writes annotations; a right-click erases the square', () => {
  const pieces = startPieces();
  const w = makeWorld(pieces, { legal: startLegal() });
  setSetup(w, pieces);

  w.rpress('e2');
  w.rrelease('e2');
  assert.equal(w.only('toggleHighlight').length, 0, 'no hidden highlight on the play node');
  assert.deepEqual(w.only('setupPlace'), [['setupPlace', 'e2', null]], 'right-click removes the piece');

  w.rpress('g1');
  w.rmove('f3');
  w.rrelease('f3');
  assert.equal(w.only('toggleArrow').length, 0, 'no hidden arrow on the play node');
  assert.equal(w.only('preview').filter((c) => c[1]).length, 0, 'no preview arrow in setup');
  assert.equal(w.only('setupPlace').length, 1, 'a right-drag does nothing at all');
  assert.equal(w.view.controlsEnabled, true);
});

test('ui:setupBrush: clicking the 3D board places and erases with the palette brush', () => {
  const pieces = startPieces();
  const w = makeWorld(pieces, { legal: startLegal() });
  setSetup(w, pieces);

  // Nothing picked in the palette yet: a click does nothing, exactly as before.
  w.press('d4');
  w.release('d4');
  assert.equal(w.only('setupPlace').length, 0);

  const queen = { color: 'white', role: 'queen' };
  w.store.emit('ui:setupBrush', { piece: queen, erase: false });
  w.press('d4'); // empty square -> soft gesture
  w.release('d4');
  assert.deepEqual(w.only('setupPlace').at(-1), ['setupPlace', 'd4', queen]);
  w.press('e7'); // occupied square -> piece gesture, click without a drag
  w.release('e7');
  assert.deepEqual(w.only('setupPlace').at(-1), ['setupPlace', 'e7', queen]);

  w.store.emit('ui:setupBrush', { piece: null, erase: true }); // the eraser
  w.press('e2');
  w.release('e2');
  assert.deepEqual(w.only('setupPlace').at(-1), ['setupPlace', 'e2', null]);

  // Palette deselected -> back to doing nothing.
  w.store.emit('ui:setupBrush', { piece: null, erase: false });
  const n = w.only('setupPlace').length;
  w.press('d4');
  w.release('d4');
  assert.equal(w.only('setupPlace').length, n);
  assert.equal(w.only('attemptMove').length, 0);
  assert.equal(w.only('select').length, 0);
});

// ---------------------------------------------------------------- abort paths

test('double-clicking the target square of a click-move does not fly the camera', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.release('e2');
  w.press('e4');
  w.release('e4'); // click 1 of the double click: plays the move
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'e2', to: 'e4' }]]);
  w.press('e4');
  w.release('e4'); // click 2
  w.el.dispatch('dblclick', { clientX: xy('e4')[0], clientY: xy('e4')[1] });
  assert.equal(w.only('focusOn').length, 0, 'no camera swoop onto the piece that just moved');
  // A deliberate double-click elsewhere still focuses.
  w.el.dispatch('dblclick', { clientX: xy('g1')[0], clientY: xy('g1')[1] });
  assert.deepEqual(w.only('focusOn').at(-1), ['focusOn', w.layer.rootAt('g1'), 3]);
});

test('an external deselect (Escape) during a drag aborts the pickup', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.move('e3');
  assert.equal(w.ix.phase(), 'dragging');
  w.actions.select(null); // exactly what ui/keys.js does on Escape
  assert.equal(w.ix.phase(), 'idle');
  assert.deepEqual(w.only('drop'), [['drop', null]], 'the piece snaps back');
  assert.equal(w.view.controlsEnabled, true);
  w.release('e4');
  assert.equal(w.only('attemptMove').length, 0, 'the release plays nothing');
});

test('an external deselect before the drag threshold cancels a pending click-move', () => {
  const pieces = {
    e1: { color: 'white', role: 'king' },
    h1: { color: 'white', role: 'rook' },
    e8: { color: 'black', role: 'king' },
  };
  const w = makeWorld(pieces, { legal: { e1: ['h1'] } }); // castling by king-takes-own-rook
  w.press('e1');
  w.release('e1');
  assert.equal(w.store.state.selected, 'e1');
  w.press('h1'); // pending click-move onto an own piece
  w.actions.select(null);
  assert.equal(w.ix.phase(), 'idle');
  w.release('h1');
  assert.equal(w.only('attemptMove').length, 0);
  assert.equal(w.view.controlsEnabled, true);
});

test('setup-mode drags survive a selection:change with no selection', () => {
  const pieces = startPieces();
  const w = makeWorld(pieces, { legal: startLegal() });
  setSetup(w, pieces);
  w.press('e7');
  w.move('e5');
  assert.equal(w.ix.phase(), 'dragging');
  w.store.emit('selection:change', { selected: null, legalTargets: [] });
  assert.equal(w.ix.phase(), 'dragging', 'setup drags do not depend on the selection');
  w.release('e5');
  assert.deepEqual(w.only('setupPlace').at(-1), ['setupPlace', 'e7', null]);
});

test('chorded left-then-right: releasing the left button hands the pointer to the annotation gesture', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  const [x, y] = xy('d4');
  w.press('d4'); // soft: OrbitControls owns this press
  assert.deepEqual(w.orbit.downs, [0]);
  w.el.dispatch('pointermove', { clientX: x, clientY: y, buttons: 3, button: 2 }); // right pressed too
  w.el.dispatch('pointermove', { clientX: x, clientY: y, buttons: 2, button: 0 }); // left released
  assert.equal(w.ix.phase(), 'right', 'the right button took the pointer over');
  assert.equal(w.view.controlsEnabled, false, 'so the controls stop orbiting');
  w.rmove('f6');
  w.rrelease('f6');
  assert.deepEqual(w.only('toggleArrow'), [
    ['toggleArrow', { from: 'd4', to: 'f6', color: 'green', knight: false, source: 'user' }],
  ]);
  assert.equal(w.view.controlsEnabled, true);
  assert.equal(w.only('attemptMove').length, 0);
});

// ---------------------------------------------------------------- 2D mode (addendum v1)

test('2D: an empty-board left-drag neither disables the controls nor suppresses the orbit press', () => {
  const w = makeWorld(startPieces(), { legal: startLegal(), viewMode: '2d' });
  const down = w.press('d4');
  assert.equal(down.stopped, false, 'the press is not swallowed');
  assert.equal(down.defaultPrevented, false);
  assert.deepEqual(w.orbit.downs, [0], 'the controls still see it (pan / zoom stay live in 2D)');
  assert.equal(w.el.hasPointerCapture(1), false, 'no pointer capture');
  assert.equal(w.view.controlsEnabled, true, 'controls are never disabled for this gesture');
  w.move('f6');
  assert.equal(w.view.controlsEnabled, true);
  assert.deepEqual(w.only('controls'), [], 'setControlsEnabled was never called');
  w.release('f6');
  assert.deepEqual(w.only('attemptMove'), [], 'a drag on empty board plays nothing');
  assert.equal(w.ix.phase(), 'idle');
});

test('2D: click-move, drag-move, arrows, highlights and hover behave exactly as in 3D', () => {
  const w = makeWorld(startPieces(), { legal: startLegal(), viewMode: '2d' });
  // click-select then click an empty legal target (the second press is the uncaptured soft gesture)
  w.press('e2');
  w.release('e2');
  assert.equal(w.store.state.selected, 'e2');
  w.press('e4');
  w.release('e4');
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'e2', to: 'e4' }]]);
  assert.equal(w.pieces.e4.role, 'pawn');

  // drag-move: lift / dragTo / drop, with the controls held off only for the piece gesture
  const w2 = makeWorld(startPieces(), { legal: startLegal(), viewMode: '2d' });
  w2.press('g1');
  assert.equal(w2.view.controlsEnabled, false, 'a PIECE press still claims the pointer in 2D');
  w2.move('f3');
  assert.equal(w2.ix.phase(), 'dragging');
  assert.deepEqual(w2.only('lift'), [['lift', 'g1']]);
  assert.ok(w2.only('dragTo').length > 0, 'the piece follows the pointer');
  w2.release('f3');
  assert.deepEqual(w2.only('attemptMove'), [['attemptMove', { from: 'g1', to: 'f3' }]]);
  assert.deepEqual(w2.only('drop').at(-1), ['drop', 'f3']);
  assert.equal(w2.view.controlsEnabled, true);

  // right-drag arrow + right-click highlight
  const w3 = makeWorld(startPieces(), { legal: startLegal(), viewMode: '2d' });
  w3.rpress('d4');
  w3.rmove('f6');
  assert.deepEqual(w3.only('preview').at(-1)[1].to, 'f6');
  w3.rrelease('f6');
  assert.deepEqual(w3.only('toggleArrow'), [
    ['toggleArrow', { from: 'd4', to: 'f6', color: 'green', knight: false, source: 'user' }],
  ]);
  w3.rpress('d5');
  w3.rrelease('d5', { shiftKey: true });
  assert.deepEqual(w3.only('toggleHighlight'), [['toggleHighlight', 'd5', 'red']]);

  // hover cursor
  const [hx, hy] = xy('e2');
  w3.el.dispatch('pointermove', { clientX: hx, clientY: hy, buttons: 0 });
  assert.equal(w3.el.style.cursor, 'grab');
});

test('2D: double-click focuses a piece, and resets to the locked overhead on empty board', () => {
  const w = makeWorld(startPieces(), { legal: startLegal(), viewMode: '2d' });
  const [px, py] = xy('e2');
  w.el.dispatch('dblclick', { clientX: px, clientY: py });
  assert.equal(w.only('focusOn').length, 1, 'double-click a piece still focuses it');

  const [ex, ey] = xy('d4');
  w.el.dispatch('dblclick', { clientX: ex, clientY: ey });
  assert.deepEqual(w.only('preset').at(-1), ['preset', 'top'], '2D resets overhead, never to a seat');

  w.setViewMode('3d');
  w.el.dispatch('dblclick', { clientX: ex, clientY: ey });
  assert.deepEqual(w.only('preset').at(-1), ['preset', 'white'], '3D resets to the seat again');
});

test("viewmode:change mid-drag cancels the gesture: the piece snaps back and nothing is played", () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.move('e4');
  assert.equal(w.ix.phase(), 'dragging');
  assert.deepEqual(w.only('lift'), [['lift', 'e2']]);

  w.setViewMode('2d');
  assert.equal(w.ix.phase(), 'idle', 'the gesture is gone');
  assert.deepEqual(w.only('drop').at(-1), ['drop', null], 'the lifted piece was snapped back');
  assert.equal(w.view.controlsEnabled, true, 'the controls were handed back');
  assert.equal(w.el.hasPointerCapture(1), false);
  assert.equal(w.store.state.selected, 'e2', 'the selection survives the switch');

  // The release that arrives after the switch must do nothing at all.
  const before = w.only('attemptMove').length;
  w.release('e4');
  assert.equal(w.only('attemptMove').length, before, 'no move is played by the stale release');
  assert.equal(w.pieces.e4, undefined);
});

test('viewmode:change mid-right-drag clears the preview arrow and draws nothing', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.rpress('d4');
  w.rmove('f6');
  assert.equal(w.only('preview').at(-1)[1].to, 'f6');
  w.setViewMode('2d');
  assert.equal(w.ix.phase(), 'idle');
  assert.deepEqual(w.only('preview').at(-1), ['preview', null], 'the preview was cleared');
  w.rrelease('f6');
  assert.deepEqual(w.only('toggleArrow'), [], 'no arrow is committed');
});

test('viewmode:change re-asserts the selection overlays without deselecting', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  w.press('e2');
  w.release('e2');
  assert.equal(w.store.state.selected, 'e2');
  const sels = w.only('setSelected').length;
  w.setViewMode('2d');
  assert.equal(w.store.state.selected, 'e2', 'the mode switch never deselects');
  assert.ok(w.only('setSelected').length > sels, 'the board is told what is selected again');
  assert.deepEqual(w.only('setSelected').at(-1), ['setSelected', 'e2']);
  assert.deepEqual(w.only('setLegalTargets').at(-1), ['setLegalTargets', ['e3', 'e4'], []]);
  // and click-move still works right after the switch
  w.press('e4');
  w.release('e4');
  assert.deepEqual(w.only('attemptMove'), [['attemptMove', { from: 'e2', to: 'e4' }]]);
});

test('a missing store.state.viewMode is treated as 3D', () => {
  const w = makeWorld(startPieces(), { legal: startLegal() });
  delete w.store.state.viewMode;
  const [ex, ey] = xy('d4');
  w.el.dispatch('dblclick', { clientX: ex, clientY: ey });
  assert.deepEqual(w.only('preset').at(-1), ['preset', 'white']);
});
