// three/interact.js — pointer -> actions (OWNER: interaction agent).
//
// Owns every pointer gesture on the canvas: click / drag a piece, click-to-move, right-click
// highlights, right-drag arrows (with a live preview), double-click focus / reset view, hover
// cursor, touch tap-tap + long-press. It talks to the world only through the objects passed in
// (view, board, layer, store, actions) exactly as CONTRACT.md describes them; it imports nothing.
//
// Contract surface:   createInteraction({ view, board, layer, store, actions }) -> { dispose() }
// Added beyond the contract (documented in the final report):
//   .cancel()  — abort any in-progress gesture (snap a lifted piece back, clear the preview
//                arrow, re-enable controls). Safe to call any time, e.g. when a dialog opens.
//   .phase()   — 'idle' | 'pending' | 'dragging' | 'right' for debugging/tests.
// Store events consumed beyond the contract list:
//   'ui:setupBrush' { piece, erase } — the Setup palette selection from ui/ioPanel.js, honoured on
//                clicks on the 3D board (place / erase). No brush picked = clicks do nothing.
//
// Gesture model (one pointer at a time):
//   left down on a movable piece  -> 'piece' gesture (pointer captured, controls disabled)
//        up without moving > 4 px -> click (select / toggle / click-move)
//        moved > 4 px             -> drag: layer.lift, dragTo, drop -> attemptMove or setupPlace
//   left down anywhere else       -> 'soft' gesture (NOT captured, OrbitControls keeps working)
//        up without moving        -> click on that square (move to a legal target, else deselect)
//   right down                    -> 'right' gesture (captured, controls disabled; never orbits)
//        up on the same square    -> toggleHighlight(square, colour)
//        up on another square     -> toggleArrow({from, to, colour})   (preview while dragging)
//   colour from modifiers at release: shift = red, alt = blue, ctrl = yellow, none = green
//   touch: same as mouse for taps/drags (10 px threshold), long-press 500 ms = highlight, no arrows.
//   a SECOND pointer while a gesture runs (pinch / two-finger pan) aborts ours cleanly and hands
//   the pointer to the controls: nothing is played, toggled, selected or left in hand.
//
// View mode (addendum v1): read from store.state.viewMode ('3d' | '2d'), never from the view or the layer.
//   - In 2D the camera is locked straight down and scene.js has turned orbit OFF (pan and zoom stay on), so a
//     left-drag on empty board simply cannot orbit. This module therefore changes NOTHING about that press: it
//     stays the uncaptured 'soft' gesture, the controls are never disabled, and the release still click-moves.
//     Suppressing the press here would cost the two-finger/right-drag pan for no gain.
//   - Double-click on empty board resets the view: view.setPreset(orientation) in 3D, view.setPreset('top') in
//     2D, so the reset cannot tilt the board out of the locked overhead.
//   - 'viewmode:change' aborts any gesture in progress: the piece meshes are rebuilt by the layer's cross-fade,
//     so a drag carried across the switch would be holding a mesh that no longer exists. The lifted piece is
//     re-seated (layer.drop(null), then the layer's own swap re-seats it anyway) and nothing is played.
//   - Hit testing goes through view.raycast / view.pointerToPlane and board.squareAtPoint only, all of which
//     keep their contracts under an orthographic 2D camera, so no projection-specific path exists here.
//
// Setup mode: the board shows the scratch position and main.js clears every overlay, so annotation
// gestures are not available there. Right-click erases the square (the mini board's convention) and
// a plain click places / erases the palette brush broadcast as the store event 'ui:setupBrush'.
//
// Listeners are registered in the capture phase so they run before OrbitControls' own
// pointerdown handler; when a gesture claims the pointer we disable the controls first
// and stopImmediatePropagation so the controls never see that press.

const DRAG_PX = 4;
const TOUCH_DRAG_PX = 10;
const LONG_PRESS_MS = 500;
const FOCUS_DISTANCE = 3;
const RECENT_MOVE_MS = 500; // a dblclick this soon after our own move is the second click of it
const FILES = 'abcdefgh';

function now() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** Annotation colour for the modifier keys held on an event (chess.com convention). */
export function colorFromModifiers(e) {
  if (!e) return 'green';
  if (e.shiftKey) return 'red';
  if (e.altKey) return 'blue';
  if (e.ctrlKey) return 'yellow';
  return 'green';
}

/** True when from->to is knight-jump geometry (files/ranks differ by 1 and 2). */
export function isKnightJump(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string' || from.length < 2 || to.length < 2) return false;
  const df = Math.abs(FILES.indexOf(from[0]) - FILES.indexOf(to[0]));
  const dr = Math.abs(Number(from[1]) - Number(to[1]));
  return (df === 1 && dr === 2) || (df === 2 && dr === 1);
}

function distance(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

function raf(fn) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  return setTimeout(fn, 16);
}

/** Wire pointer handling on view.renderer.domElement. Returns { dispose, cancel, phase }. */
export function createInteraction({ view, board, layer, store, actions }) {
  const el = view.renderer.domElement;
  const win = typeof window !== 'undefined' ? window : null;
  let disposed = false;
  let g = null; // the active gesture, see startPiece/startSoft/startRight
  const downPointers = new Set(); // touch/pen pointers currently down (multi-touch detection)
  let brush; // setup palette brush: undefined = nothing picked, null = eraser, else a Piece
  let lastPlayedAt = 0; // when this module last played a move (dblclick suppression)
  let lastPlayedTo = null;

  // ---------------------------------------------------------------- state helpers

  function state() {
    return store.state;
  }

  /** '2d' while the top-down locked view is on, '3d' otherwise (missing/unknown = '3d'). */
  function viewMode() {
    return state().viewMode === '2d' ? '2d' : '3d';
  }

  function pieceAt(square) {
    if (!square) return null;
    const st = state();
    if (st.mode === 'setup') {
      const list = (st.setup && st.setup.pieces) || [];
      const entry = list.find((p) => p.square === square);
      return entry ? entry.piece : null;
    }
    try {
      return st.game.pieceAt(square) || null;
    } catch {
      return null;
    }
  }

  function isMovable(square) {
    const piece = pieceAt(square);
    if (!piece) return false;
    const st = state();
    if (st.mode === 'setup') return true;
    try {
      return piece.color === st.game.turn();
    } catch {
      return false;
    }
  }

  function legalTargets() {
    const t = state().legalTargets;
    return Array.isArray(t) ? t : [];
  }

  // ---------------------------------------------------------------- hit testing

  function rootOf(obj, roots) {
    const set = new Set(roots);
    let o = obj;
    while (o) {
      if (set.has(o)) return o;
      o = o.parent;
    }
    return obj;
  }

  /** Nearest piece under the pointer: { square, root, piece } or null. */
  function pieceUnder(x, y) {
    let objs;
    try {
      objs = layer.pieceObjects() || [];
    } catch {
      return null;
    }
    if (!objs.length) return null;
    let hits;
    try {
      hits = view.raycast(x, y, objs) || [];
    } catch {
      return null;
    }
    for (const h of hits) {
      if (!h || !h.object) continue;
      let square = null;
      try {
        square = layer.squareOf(h.object);
      } catch {
        square = null;
      }
      if (!square) continue;
      const root = rootOf(h.object, objs);
      const ud = (root && root.userData) || {};
      const piece = pieceAt(square) || (ud.role && ud.color ? { role: ud.role, color: ud.color } : null);
      return { square, root, piece };
    }
    return null;
  }

  let reverseSquares = null;
  let reverseSource = null;
  let reverseSize = 0;
  function squareOfMesh(obj) {
    const map = board.squareMeshes;
    if (!map || typeof map.forEach !== 'function') return null;
    if (!reverseSquares || reverseSource !== map || reverseSize !== map.size) {
      reverseSquares = new Map();
      map.forEach((mesh, square) => reverseSquares.set(mesh, square));
      reverseSource = map;
      reverseSize = map.size;
    }
    let o = obj;
    while (o) {
      const sq = reverseSquares.get(o);
      if (sq) return sq;
      o = o.parent;
    }
    return null;
  }

  function squareFromPlane(x, y) {
    let p = null;
    try {
      p = view.pointerToPlane(x, y, 0);
    } catch {
      p = null;
    }
    if (!p) return null;
    try {
      return board.squareAtPoint(p) || null;
    } catch {
      return null;
    }
  }

  /** Square of the board surface under the pointer (square meshes first, plane fallback). */
  function squareOnBoard(x, y) {
    const map = board.squareMeshes;
    if (map && map.size) {
      let hits = [];
      try {
        hits = view.raycast(x, y, [...map.values()]) || [];
      } catch {
        hits = [];
      }
      for (const h of hits) {
        const sq = h && h.object ? squareOfMesh(h.object) : null;
        if (sq) return sq;
      }
    }
    return squareFromPlane(x, y);
  }

  /** Square under the pointer, preferring the piece that is hit over the board beneath it. */
  function squareUnder(x, y) {
    const hit = pieceUnder(x, y);
    if (hit) return hit.square;
    return squareOnBoard(x, y);
  }

  // ---------------------------------------------------------------- selection visuals

  function captureSquares(from, targets) {
    if (!from || !targets.length) return [];
    const st = state();
    let mover = null;
    try {
      mover = st.game.pieceAt(from);
    } catch {
      mover = null;
    }
    return targets.filter((sq) => {
      let occupied = false;
      try {
        occupied = !!st.game.pieceAt(sq);
      } catch {
        occupied = false;
      }
      if (occupied) return true;
      return !!mover && mover.role === 'pawn' && sq[0] !== from[0];
    });
  }

  function applySelection() {
    const st = state();
    const selected = st.selected || null;
    const show = !st.settings || st.settings.showLegalMoves !== false;
    const targets = selected && show && st.mode !== 'setup' ? legalTargets() : [];
    try {
      board.setSelected(selected);
    } catch {
      /* board may not support it yet */
    }
    try {
      board.setLegalTargets(targets, captureSquares(selected, targets));
    } catch {
      /* ditto */
    }
  }

  // ---------------------------------------------------------------- cursor

  let hoverPending = false;
  let hoverX = 0;
  let hoverY = 0;

  function setCursor(c) {
    if (el.style && el.style.cursor !== c) el.style.cursor = c;
  }

  function updateCursor(x, y) {
    const st = state();
    let cursor = '';
    const hit = pieceUnder(x, y);
    if (hit && isMovable(hit.square)) {
      cursor = 'grab';
    } else if (st.selected && st.mode !== 'setup') {
      const sq = hit ? hit.square : squareOnBoard(x, y);
      if (sq && legalTargets().includes(sq)) cursor = 'pointer';
    }
    setCursor(cursor);
  }

  function scheduleHover(e) {
    hoverX = e.clientX;
    hoverY = e.clientY;
    if (hoverPending) return;
    hoverPending = true;
    raf(() => {
      hoverPending = false;
      if (disposed || g) return;
      updateCursor(hoverX, hoverY);
    });
  }

  // ---------------------------------------------------------------- gesture plumbing

  function capturePointer(id) {
    try {
      if (typeof el.setPointerCapture === 'function') el.setPointerCapture(id);
    } catch {
      /* pointer already gone (or a test shim) */
    }
  }

  function releasePointer(id) {
    try {
      if (typeof el.releasePointerCapture !== 'function') return;
      if (typeof el.hasPointerCapture === 'function' && !el.hasPointerCapture(id)) return;
      el.releasePointerCapture(id);
    } catch {
      /* already released */
    }
  }

  function setControls(enabled) {
    try {
      view.setControlsEnabled(enabled);
    } catch {
      /* view may not expose it in tests */
    }
  }

  function clearTimer(gest) {
    if (gest && gest.timer) {
      clearTimeout(gest.timer);
      gest.timer = null;
    }
  }

  /** Tear a gesture down (idempotent): timers, preview arrow, controls, capture, cursor. */
  function endGesture(gest) {
    if (!gest || gest.ended) return;
    gest.ended = true;
    clearTimer(gest);
    if (g === gest) g = null;
    if (gest.kind === 'right') {
      try {
        board.setPreviewArrow(null);
      } catch {
        /* nothing to clear */
      }
    }
    if (gest.kind !== 'soft') {
      setControls(true);
      releasePointer(gest.pointerId);
    }
    if (gest.kind === 'piece') setCursor('');
  }

  /** Abort the current gesture: a lifted piece snaps back, nothing is played. */
  function cancelGesture() {
    const gest = g;
    if (!gest) return;
    if (gest.kind === 'piece' && gest.phase === 'dragging') {
      gest.phase = 'finishing';
      try {
        layer.drop(null);
      } catch {
        /* layer may already have reconciled */
      }
    }
    endGesture(gest);
  }

  function threshold(gest) {
    return gest.pointerType === 'touch' ? TOUCH_DRAG_PX : DRAG_PX;
  }

  function armLongPress(gest, square) {
    if (!square || state().mode === 'setup') return;
    gest.timer = setTimeout(() => {
      gest.timer = null;
      if (g !== gest || gest.moved || gest.phase === 'consumed' || gest.phase === 'finishing') return;
      gest.phase = 'consumed';
      const st = state();
      if (gest.kind === 'piece' && st.mode !== 'setup' && st.selected !== gest.prevSelected) {
        actions.select(gest.prevSelected || null);
      }
      actions.toggleHighlight(square, 'green');
    }, LONG_PRESS_MS);
  }

  // ---------------------------------------------------------------- gesture starts

  function startPiece(e, hit) {
    const st = state();
    const square = hit.square;
    const prevSelected = st.selected || null;
    const clickMove =
      st.mode !== 'setup' && !!prevSelected && prevSelected !== square && legalTargets().includes(square);
    g = {
      kind: 'piece',
      bit: 1,
      phase: 'pending',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x0: e.clientX,
      y0: e.clientY,
      from: square,
      root: hit.root,
      piece: hit.piece,
      prevSelected,
      clickMove,
      moved: false,
      timer: null,
      ended: false,
    };
    // Claim the pointer before OrbitControls sees the press.
    setControls(false);
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    capturePointer(e.pointerId);
    if (st.mode !== 'setup' && !clickMove && prevSelected !== square) actions.select(square);
    if (e.pointerType === 'touch') armLongPress(g, square);
  }

  function startSoft(e, square) {
    g = {
      kind: 'soft',
      bit: 1,
      phase: 'pending',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x0: e.clientX,
      y0: e.clientY,
      square,
      moved: false,
      timer: null,
      ended: false,
    };
    // No capture, no preventDefault: OrbitControls handles this press.
    if (e.pointerType === 'touch') armLongPress(g, square);
  }

  function startRight(e) {
    const from = squareUnder(e.clientX, e.clientY);
    g = {
      kind: 'right',
      bit: 2,
      phase: 'right',
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      x0: e.clientX,
      y0: e.clientY,
      from,
      hoverSq: from,
      setup: state().mode === 'setup',
      previewKey: '',
      moved: false,
      timer: null,
      ended: false,
    };
    setControls(false);
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    capturePointer(e.pointerId);
  }

  // ---------------------------------------------------------------- gesture ends

  function notePlayed(to) {
    lastPlayedAt = now();
    lastPlayedTo = to || null;
  }

  /**
   * Setup-mode click with the palette brush picked in the I/O panel ('ui:setupBrush').
   * Returns true when it consumed the click. With no brush ever picked nothing happens
   * (the mini board stays the only way to place, exactly as before).
   */
  function setupBrushClick(square) {
    if (!square || brush === undefined || typeof actions.setupPlace !== 'function') return false;
    actions.setupPlace(square, brush);
    return true;
  }

  function afterMove(result, from, to) {
    if (result === 'illegal') {
      if (isMovable(to)) actions.select(to);
      else actions.select(null);
    } else if (result === 'played') {
      notePlayed(to);
      if (state().selected != null) actions.select(null);
    }
    // 'promotion': the picker is open; the store decides the selection when it resolves.
  }

  function finishPiece(e, gest) {
    const phase = gest.phase;
    gest.phase = 'finishing';
    if (phase === 'consumed') return;
    const st = state();
    if (phase === 'dragging') {
      const p = view.pointerToPlane(e.clientX, e.clientY, 0);
      const to = p ? board.squareAtPoint(p) : null;
      if (st.mode === 'setup') {
        if (to && to !== gest.from) {
          actions.setupPlace(to, gest.piece);
          actions.setupPlace(gest.from, null);
          layer.drop(to);
        } else if (!to) {
          layer.drop(null);
          actions.setupPlace(gest.from, null);
        } else {
          layer.drop(null);
        }
        return;
      }
      if (to && to !== gest.from) {
        const r = actions.attemptMove({ from: gest.from, to });
        if (r === 'played' || r === 'promotion') layer.drop(to);
        else layer.drop(null); // illegal: snap back, the piece stays selected
        if (r === 'played') {
          notePlayed(to);
          if (state().selected != null) actions.select(null);
        }
      } else {
        layer.drop(null);
      }
      return;
    }
    // A click on the piece (no drag).
    const sq = gest.from;
    if (st.mode === 'setup') {
      setupBrushClick(sq); // place over / erase the piece that was clicked
      return;
    }
    if (gest.clickMove) {
      const r = actions.attemptMove({ from: gest.prevSelected, to: sq });
      afterMove(r, gest.prevSelected, sq);
      return;
    }
    if (gest.prevSelected === sq) actions.select(null); // click the selected piece again -> deselect
  }

  function finishSoft(e, gest) {
    const phase = gest.phase;
    gest.phase = 'finishing';
    if (phase === 'consumed' || gest.moved) return;
    const st = state();
    if (st.mode === 'setup') {
      setupBrushClick(gest.square);
      return;
    }
    const sel = st.selected;
    if (!sel) return;
    const sq = gest.square;
    if (sq && legalTargets().includes(sq)) {
      const r = actions.attemptMove({ from: sel, to: sq });
      afterMove(r, sel, sq);
    } else {
      actions.select(null);
    }
  }

  function finishRight(e, gest) {
    gest.phase = 'finishing';
    if (!gest.from) return;
    if (gest.setup) {
      // Setup mode: overlays are cleared and the visible position is the scratch one, so an
      // arrow/highlight here would be written invisibly to the hidden play-mode node. Follow the
      // I/O panel's mini board instead — right-click a square removes what is on it; ignore drags.
      const target = squareUnder(e.clientX, e.clientY);
      if (!gest.moved || target === gest.from) {
        if (typeof actions.setupPlace === 'function') actions.setupPlace(gest.from, null);
      }
      return;
    }
    const to = squareUnder(e.clientX, e.clientY);
    const color = colorFromModifiers(e);
    if (to === gest.from || (!to && !gest.moved)) {
      actions.toggleHighlight(gest.from, color);
    } else if (to) {
      actions.toggleArrow({ from: gest.from, to, color, knight: isKnightJump(gest.from, to), source: 'user' });
    }
  }

  function finishGesture(e) {
    const gest = g;
    if (!gest) return;
    try {
      if (gest.kind === 'piece') finishPiece(e, gest);
      else if (gest.kind === 'soft') finishSoft(e, gest);
      else finishRight(e, gest);
    } finally {
      endGesture(gest);
    }
  }

  // ---------------------------------------------------------------- right-drag preview

  function updatePreview(e, gest) {
    if (gest.setup) return; // no arrows in setup mode, so no preview either
    const color = colorFromModifiers(e);
    const to = gest.hoverSq;
    const key = gest.from && to && to !== gest.from ? `${gest.from}${to}${color}` : '';
    if (key === gest.previewKey) return;
    gest.previewKey = key;
    try {
      if (!key) board.setPreviewArrow(null);
      else board.setPreviewArrow({ from: gest.from, to, color, knight: isKnightJump(gest.from, to), source: 'user' });
    } catch {
      /* preview is cosmetic */
    }
  }

  // ---------------------------------------------------------------- DOM handlers

  function onPointerDown(e) {
    if (disposed) return;
    const contact = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (e.isPrimary === true) downPointers.clear(); // first contact of a fresh gesture
    if (contact) downPointers.add(e.pointerId);
    if (g) {
      const same = e.pointerId === g.pointerId;
      // Same pointer: a stale gesture. Different pointer: a second finger, i.e. the start of a
      // pinch / two-finger pan. Either way abort ours cleanly — the lifted piece snaps back, the
      // preview arrow goes, the long-press timer is cleared and the controls come back on — so the
      // resting finger can neither toggle a highlight nor play a move when it lifts.
      cancelGesture();
      if (!same) return; // the second pointer belongs to OrbitControls
    }
    // Still more than one finger down: no gesture of ours starts (a stale id can never block the
    // mouse, only another touch).
    if (contact && downPointers.size > 1) return;
    const isTouch = e.pointerType === 'touch';
    if (e.button === 2 && !isTouch) {
      startRight(e);
      return;
    }
    if (e.button !== 0) return; // middle button etc. -> OrbitControls
    const hit = pieceUnder(e.clientX, e.clientY);
    if (hit && isMovable(hit.square)) {
      startPiece(e, hit);
      return;
    }
    startSoft(e, hit ? hit.square : squareOnBoard(e.clientX, e.clientY));
  }

  function onPointerMove(e) {
    if (disposed) return;
    const gest = g;
    if (!gest || e.pointerId !== gest.pointerId) {
      if (!gest && (e.buttons === 0 || e.buttons === undefined)) scheduleHover(e);
      return;
    }
    // Our button was released while another one is still held (browsers report that as a
    // pointermove, not a pointerup): treat it as the release.
    if (typeof e.buttons === 'number' && (e.buttons & gest.bit) === 0) {
      const wasSoft = gest.kind === 'soft';
      finishGesture(e);
      // Left released while the right button is still held (a chord): hand the pointer to the
      // annotation gesture. OrbitControls' move handler has no buttons check, so without this the
      // right-drag would keep orbiting the camera and never draw its arrow.
      if (wasSoft && !g && e.pointerType !== 'touch' && (e.buttons & 2) !== 0) startRight(e);
      return;
    }
    const moved = distance(e.clientX, e.clientY, gest.x0, gest.y0) > threshold(gest);
    if (gest.kind === 'piece') {
      if (gest.phase === 'consumed' || gest.phase === 'finishing') return;
      if (gest.phase === 'pending') {
        if (!moved) return;
        gest.moved = true;
        clearTimer(gest);
        gest.phase = 'dragging';
        setCursor('grabbing');
        if (state().mode !== 'setup' && state().selected !== gest.from) actions.select(gest.from);
        layer.lift(gest.from);
      }
      let p = null;
      try {
        p = view.pointerToPlane(e.clientX, e.clientY, 0);
      } catch {
        p = null;
      }
      if (p) layer.dragTo(p);
      return;
    }
    if (gest.kind === 'soft') {
      if (moved && !gest.moved) {
        gest.moved = true;
        clearTimer(gest);
      }
      return;
    }
    // right
    if (moved) gest.moved = true;
    const sq = squareUnder(e.clientX, e.clientY);
    gest.hoverSq = sq;
    updatePreview(e, gest);
  }

  function onPointerUp(e) {
    if (disposed) return;
    downPointers.delete(e.pointerId);
    if (!g || e.pointerId !== g.pointerId) return;
    finishGesture(e);
  }

  function onPointerCancel(e) {
    downPointers.delete(e.pointerId);
    if (g && e.pointerId === g.pointerId) cancelGesture();
  }

  function onLostCapture(e) {
    if (g && g.kind !== 'soft' && e.pointerId === g.pointerId) cancelGesture();
  }

  function onPointerLeave() {
    if (!g) setCursor('');
  }

  function onContextMenu(e) {
    if (typeof e.preventDefault === 'function') e.preventDefault();
  }

  function onDblClick(e) {
    if (disposed) return;
    const hit = pieceUnder(e.clientX, e.clientY);
    if (hit) {
      // The second click of a double-click that just played a move onto this square is not a
      // request to fly the camera at the piece that landed there.
      if (hit.square === lastPlayedTo && now() - lastPlayedAt < RECENT_MOVE_MS) return;
      try {
        view.focusOn(hit.root, FOCUS_DISTANCE);
      } catch {
        /* view may not animate in tests */
      }
      const st = state();
      if (st.mode !== 'setup' && isMovable(hit.square) && st.selected !== hit.square) actions.select(hit.square);
      return;
    }
    try {
      // In 2D the camera is pinned overhead; resetting to a seat preset would tilt it out of the locked view.
      view.setPreset(viewMode() === '2d' ? 'top' : state().orientation || 'white');
    } catch {
      /* ignore */
    }
  }

  function onWindowPointerUp(e) {
    // Fallback for a soft gesture whose pointerup never reached the canvas.
    downPointers.delete(e.pointerId);
    if (g && g.kind === 'soft' && e.pointerId === g.pointerId) finishGesture(e);
  }

  function onWindowBlur() {
    downPointers.clear();
    cancelGesture();
  }

  // ---------------------------------------------------------------- store subscriptions

  const unsubs = [];
  function sub(event, fn) {
    const off = store.on(event, fn);
    unsubs.push(typeof off === 'function' ? off : () => store.off && store.off(event, fn));
  }

  sub('selection:change', () => {
    // An external deselect (Escape -> ui/keys.js -> actions.select(null)) while a piece is in hand
    // aborts the pickup: the piece snaps back and the release plays nothing. Our own selection
    // changes happen in the 'consumed'/'finishing' phases, or set a non-null square, so they never
    // trip this.
    if (
      g &&
      g.kind === 'piece' &&
      (g.phase === 'pending' || g.phase === 'dragging') &&
      state().mode !== 'setup' &&
      state().selected == null
    ) {
      cancelGesture();
    }
    applySelection();
  });
  sub('ui:setupBrush', (p) => {
    // ui/ioPanel.js palette: { piece, erase }. erase -> null, nothing picked -> undefined.
    brush = !p ? undefined : p.erase ? null : p.piece || undefined;
  });
  sub('settings:change', (p) => {
    if (p && p.path === 'showLegalMoves') applySelection();
  });
  sub('mode:change', () => {
    cancelGesture();
    if (state().selected != null) actions.select(null);
    applySelection();
  });
  sub('game:change', () => {
    // The position changed under an in-progress press/drag (engine, AI, navigation): abort it.
    if (g && g.kind === 'piece' && (g.phase === 'pending' || g.phase === 'dragging')) cancelGesture();
  });
  sub('viewmode:change', () => {
    // 2D <-> 3D rebuilds every piece mesh (the layer cross-fades the two sets) and moves the camera, so any
    // gesture in hand is holding something that is about to stop existing. Abort it: the lifted piece snaps
    // back, a half-drawn arrow's preview goes, and the release plays / toggles nothing. The selection is not
    // touched -- the mode switch must not deselect.
    cancelGesture();
    applySelection();   // the board rebuilds its overlays for the new mode; re-assert what is selected
  });

  // ---------------------------------------------------------------- listeners

  const CAPTURE = { capture: true };
  const listeners = [
    [el, 'pointerdown', onPointerDown, CAPTURE],
    [el, 'pointermove', onPointerMove, CAPTURE],
    [el, 'pointerup', onPointerUp, CAPTURE],
    [el, 'pointercancel', onPointerCancel, CAPTURE],
    [el, 'lostpointercapture', onLostCapture, CAPTURE],
    [el, 'pointerleave', onPointerLeave, false],
    [el, 'dblclick', onDblClick, false],
    [el, 'contextmenu', onContextMenu, false],
  ];
  if (win && typeof win.addEventListener === 'function') {
    listeners.push([win, 'pointerup', onWindowPointerUp, false]);
    listeners.push([win, 'blur', onWindowBlur, false]);
  }
  for (const [target, type, fn, opts] of listeners) target.addEventListener(type, fn, opts);

  /** Remove every listener and subscription; abort any gesture in progress. */
  function dispose() {
    if (disposed) return;
    cancelGesture();
    downPointers.clear();
    disposed = true;
    for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts);
    listeners.length = 0;
    for (const off of unsubs) {
      try {
        off();
      } catch {
        /* already gone */
      }
    }
    unsubs.length = 0;
    setCursor('');
  }

  /** Current gesture phase: 'idle' | 'pending' | 'dragging' | 'right'. */
  function phase() {
    if (!g) return 'idle';
    if (g.kind === 'right') return 'right';
    return g.phase === 'dragging' ? 'dragging' : 'pending';
  }

  return { dispose, cancel: cancelGesture, phase };
}
