// three/pieceLayer.js -- the group of piece meshes on the board, reconciled to a position, with move /
// capture / castle / promotion animation and drag visuals. Owns createPieceLayer(scene, matSet, settings)
// per CONTRACT.md. Animation runs on a tiny internal requestAnimationFrame ticker (no scene.js dependency).
// Added beyond the contract (all on the layer object):
//   layer.worldFor(square) -> Vector3       : square centre at y = 0 (contract mapping: a = -3.5 .. h = +3.5 on X,
//                                             rank 1 at z = +3.5 .. rank 8 at z = -3.5). board.js owns the mapping;
//   layer.setSquareMapper(fn)                 lets the integrator hand in board.worldFor to keep one source of truth.
//   layer.setOrientation('white'|'black', opts?) -> Promise
//                                           : rotates the flat token cards so they read upright from that seat
//                                             (no effect on sculpted sets). Call it on 'orientation:change'.
//                                             opts { animate, duration = 700 } -- animated by default while a flat
//                                             set is showing, so the tokens turn WITH view.rotateSeat().
//   layer.setViewMode('2d'|'3d', opts?) -> Promise   : cross-fade between settings.pieceSet (3D, sculpted) and
//                                             settings.pieceSet2d (2D, flat tokens). opts { animate }.
//   layer.setSet2d(setId)                   : the 2D slot (settings.pieceSet2d); applies now only while in 2D.
//                                             layer.setSet(id) is the 3D slot (settings.pieceSet), as before.
//   layer.viewMode() -> '2d'|'3d' · layer.setFor(mode) -> id   : the current mode / the set id of either slot.
//   layer.settle()                          : snap every piece to its nominal square (e.g. a cancelled promotion
//                                             after drop(square) left a piece visually on the target square).
//   layer.setAnimations(bool)               : override settings.animations (main.js also passes instant: per call).
//   layer.fadeIn(ms = BOOT_FADE_MS) -> Promise : fade every piece in from nothing (main.js, when the boot set is in).
//   layer.isAnimating() -> bool             : true while any tween runs.
//   layer.currentSet() -> id                : the active piece set id.
// Facing: pieces are authored facing +Z; the layer rotates WHITE pieces by pi so they face -Z (toward Black)
// and leaves BLACK pieces facing +Z (toward White) -- i.e. knights face the opponent. The contract's literal
// "+Z for white" would face White's own seat under its coordinate system; this follows the stated intent.
// Knights also turn KNIGHT_TURN toward the board's centre line (a-d files one way, e-h the other, mirrored per
// colour), so each shows its owner a three-quarter profile instead of the back of its head; the turn follows
// the knight's square and eases across on a move (built-in and glTF sets alike; flat tokens never turn).
// Bishops with a mitre cut (pieces.js bishopCut) turn the cut BISHOP_TURN off their owner's seat, toward the centre
// line, mirrored per colour: it faced sideways, so from both seats every bishop read as a plain egg (critique r4).
// Drag semantics: lift(square) keys the piece at its origin square until the next sync(); drop(square) settles
// the mesh visually on `square` (the store's game:change -> sync() then owns it); drop(null) snaps it back.
// sync() may land BETWEEN lift() and drop() (interact.js calls attemptMove, main.js syncs on game:change,
// then interact.js calls drop): an animated sync re-seats a lifted non-mover before clearing the gesture,
// and drop() on a mesh that the sync removed is a no-op. lift() re-reads the square after finishing an
// in-flight tween, so grabbing a piece mid-promotion takes the new queen, not the doomed pawn.
// sync() opts.animateFrom accepts the contract shape {from,to,...}, OR the play() result main.js passes
// ({ node: { move: {from,to} }, captured, castle, promotion }), OR a Node, OR a UCI string.
// View mode (addendum v1): the layer holds TWO set slots -- '3d' (settings.pieceSet) and '2d'
// (settings.pieceSet2d, flat tokens). setViewMode() cross-fades between them: the new meshes are built on the
// same squares and keyed into bySquare immediately (so meshAt / pieceObjects / raycasting see the new set from
// the first frame), the old ones fade out beside them and are removed when the fade ends. Nothing about the
// position, the squares or the store's selection is touched. A mode switch CANCELS an in-flight drag and
// finishes any running tween instead of stranding a lifted piece: the outgoing mesh is re-seated on its square
// first, and layer.drop() afterwards is a no-op (interact.js aborts its gesture on 'viewmode:change' too).

import * as THREE from 'three';
import { createPiece, applyMaterials, setKind, isDirectional, bishopCut, disposePieceCaches } from './pieces.js';
import { requestRedraw } from './redraw.js';

const FILES = 'abcdefgh';
const MOVE_MS = 220, CAPTURE_MS = 260, LIFT_MS = 110, DROP_MS = 130, SNAP_MS = 160;
const LIFT_Y = 0.35, LIFT_SCALE = 1.06, ARC_Y = 0.18;
// 2D: straight down onto flat tokens, so height reads as nothing -- the lift is small (just enough to sit in
// front of the other tokens in the depth buffer) and the scale carries the "in hand" signal instead.
const LIFT_Y_2D = 0.2, LIFT_SCALE_2D = 1.16;
const FADE_MS = 240;            // the 2D <-> 3D cross-fade
const BOOT_FADE_MS = 450;       // the pieces arriving on the board at boot (fadeIn)
const SPIN_MS = 700;            // matches view.rotateSeat's default duration
const DEFAULT_SET_2D = 'glyph';
const KNIGHT_TURN = 25 * Math.PI / 180;   // see Facing in the header
const BISHOP_TURN = 45 * Math.PI / 180;   // the cut, three-quarter to its owner (see Facing)
const FADE_KEY = { fade: true };   // ticker keys (objects, never a piece group)
const SPIN_KEY = { spin: true };

/** Square centre in world units at y = 0 (contract mapping). */
function defaultWorldFor(square) {
  const f = FILES.indexOf(square[0]);
  const r = parseInt(square[1], 10);
  if (f < 0 || !(r >= 1 && r <= 8)) return null;
  return new THREE.Vector3(f - 3.5, 0, 4.5 - r);
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const samePiece = (a, b) => !!a && !!b && a.role === b.role && a.color === b.color;

// ---------------------------------------------------------------------------------------------
// Tween ticker (module-private, rAF driven, one per layer).

function createTicker() {
  const active = new Map();   // key (object) -> tween
  let raf = 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const schedule = () => {
    if (raf || typeof requestAnimationFrame === 'undefined') return;
    raf = requestAnimationFrame(tick);
  };
  function tick(t) {
    raf = 0;
    if (active.size) requestRedraw('content');   // the steps below move pieces or fade them: draw the result
    for (const [key, tw] of Array.from(active.entries())) {
      const k = Math.min(1, (t - tw.start) / tw.duration);
      tw.update(tw.ease(k), k);
      if (k >= 1) { active.delete(key); if (tw.done) tw.done(); }
    }
    if (active.size) schedule();
  }
  return {
    /** Start a tween on `key`; a running tween on the same key is finished first (jumps to its end). */
    start(key, { duration, ease = easeInOut, update, done }) {
      this.finish(key);
      const tw = { start: now(), duration: Math.max(1, duration), ease, update, done };
      active.set(key, tw);
      if (typeof requestAnimationFrame === 'undefined') { update(1, 1); active.delete(key); if (done) done(); return; }
      schedule();
    },
    /** Complete the tween on `key` immediately (end state + done callback). */
    finish(key) {
      const tw = active.get(key);
      if (!tw) return;
      active.delete(key);
      tw.update(1, 1);
      if (tw.done) tw.done();
    },
    finishAll() { for (const key of Array.from(active.keys())) this.finish(key); },
    has(key) { return active.has(key); },
    get size() { return active.size; },
    dispose() {
      active.clear();
      if (raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------

/**
 * Create the piece layer: a THREE.Group added to `scene`, reconciled with sync(). See file header for the
 * additions beyond the contract.
 */
export function createPieceLayer(scene, matSet, settings = {}) {
  const group = new THREE.Group();
  group.name = 'pieces';
  scene.add(group);

  let mats = matSet;
  const cfg = settings || {};
  let viewMode = cfg.viewMode === '2d' ? '2d' : '3d';
  let set3d = cfg.pieceSet || 'staunton';
  let set2d = cfg.pieceSet2d || DEFAULT_SET_2D;
  let currentSet = viewMode === '2d' ? set2d : set3d;
  let animations = !(cfg.animations === false);
  let orientation = 'white';
  let spin = 0;                   // live seat rotation applied to flat sets (0 = White's seat, PI = Black's)
  let worldFor = defaultWorldFor;
  const bySquare = new Map();     // square -> piece Group (nominal owner of the square)
  const dying = new Set();        // groups fading out (not raycast targets)
  const ticker = createTicker();
  let drag = null;                // { obj, square }

  // -- piece construction -----------------------------------------------------------------------

  /** True for a flat token set (no front of its own): it is turned by the SEAT, not by the piece colour. */
  function flatSet() {
    return !isDirectional(currentSet);
  }
  function facingRotation(color) {
    return isDirectional(currentSet) && color === 'white' ? Math.PI : 0;
  }
  /** A knight's extra turn on `square`: toward the centre line, mirrored per colour (0 for any other piece). */
  function knightTurn(u, square) {
    const f = u.role === 'knight' && typeof square === 'string' ? FILES.indexOf(square[0]) : -1;
    if (f < 0) return 0;
    return (f < 4 ? -1 : 1) * (u.color === 'white' ? 1 : -1) * KNIGHT_TURN;
  }
  /**
   * A bishop's yaw on `square` that shows its cut three-quarter to its owner, toward the centre line (from the a-d
   * files toward +X), mirrored for Black; null for any other piece or a set whose bishop has no cut (bishopCut).
   */
  function bishopYaw(u, square) {
    const cut = u.role === 'bishop' ? bishopCut(currentSet) : null;
    const f = typeof square === 'string' ? FILES.indexOf(square[0]) : -1;
    if (cut === null || f < 0) return null;
    const side = f < 4 ? 1 : -1;
    const target = u.color === 'white' ? side * BISHOP_TURN : Math.PI - side * BISHOP_TURN;   // azimuth, 0 = +Z
    return target - cut;
  }
  /**
   * The y rotation a piece should have on `square`: colour + knight turn, or the bishop's cut turned to its owner
   * (sculpted sets), or the seat spin (flat sets).
   */
  function yawFor(obj, square = obj.userData.square) {
    if (flatSet()) return spin;
    const bishop = bishopYaw(obj.userData, square);
    if (bishop !== null) return bishop;
    return facingRotation(obj.userData.color) + knightTurn(obj.userData, square);
  }
  /** Write the piece's y rotation for its square (see yawFor). */
  function applyFacing(obj) {
    obj.rotation.y = yawFor(obj);
  }
  function build(piece, square) {
    const obj = createPiece(piece.role, piece.color, currentSet, mats);
    obj.userData.square = square;
    applyFacing(obj);
    place(obj, square);
    group.add(obj);
    return obj;
  }
  function place(obj, square) {
    const p = worldFor(square);
    if (p) obj.position.copy(p);
    obj.scale.setScalar(1);
  }
  function pieceOf(obj) {
    return { role: obj.userData.role, color: obj.userData.color };
  }
  function removeNow(obj) {
    ticker.finish(obj);
    group.remove(obj);
    dying.delete(obj);
    releaseClonedMaterials(obj);
  }
  /**
   * Material.clone() drops own-property shader hooks (onBeforeCompile / customProgramCacheKey set on an instance),
   * so a material patched that way would lose its patch for the length of the fade: they are copied across.
   */
  function cloneForFade(m) {
    const c = m.clone();
    if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) c.onBeforeCompile = m.onBeforeCompile;
    if (Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey')) c.customProgramCacheKey = m.customProgramCacheKey;
    return c;
  }
  // Piece materials are SHARED across every piece of a colour, so anything that fades has to run on a clone.
  // beginFade swaps in the clone (remembering the shared original), endFade disposes it and puts the original
  // back -- a piece that survives the fade (the incoming set) keeps using the shared material afterwards.
  function beginFade(obj) {
    obj.traverse((o) => {
      // a stand-in is never drawn in its own material (it borrows the full mesh's), so it needs no fade clone
      if (!o.isMesh || o.userData.fadeMaterial || o.userData.standIn) return;
      o.userData.fadeOriginal = o.material;
      o.material = cloneForFade(o.material);
      o.material.transparent = true;
      o.material.depthWrite = false;
      o.userData.fadeMaterial = true;
    });
  }
  // Relative to each part's own opacity: the contact decal is a translucent ~0.35 (and a glyph card still
  // loading is 0), so fading them as if they were solid would flash a dark disc (or a blank card) in.
  function setOpacity(obj, v) {
    obj.traverse((o) => {
      if (!o.isMesh || !o.userData.fadeMaterial) return;
      const orig = o.userData.fadeOriginal;
      o.material.opacity = v * (orig && orig.transparent ? orig.opacity : 1);
    });
  }
  function releaseClonedMaterials(obj) {
    obj.traverse((o) => {
      if (o.isMesh && o.userData.fadeMaterial) {
        o.material.dispose();
        if (o.userData.fadeOriginal) o.material = o.userData.fadeOriginal;
        o.userData.fadeOriginal = null;
        o.userData.fadeMaterial = false;
      }
    });
  }

  // -- animation primitives -----------------------------------------------------------------------

  function slide(obj, toSquare, duration, done) {
    const to = worldFor(toSquare);
    if (!to) { if (done) done(); return; }
    const from = obj.position.clone();
    const dist = from.distanceTo(to);
    const arc = Math.min(ARC_Y, ARC_Y * dist / 2);
    const s0 = obj.scale.x;
    // a knight crossing the centre line turns the other way: ease it round the short way as it travels
    const yaw0 = obj.rotation.y, yaw1 = yawFor(obj, toSquare);
    const dYaw = ((yaw1 - yaw0 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    ticker.start(obj, {
      duration, ease: easeInOut,
      update(k, raw) {
        obj.position.x = from.x + (to.x - from.x) * k;
        obj.position.z = from.z + (to.z - from.z) * k;
        obj.position.y = from.y * (1 - k) + Math.sin(raw * Math.PI) * arc;
        obj.scale.setScalar(s0 + (1 - s0) * k);
        obj.rotation.y = yaw0 + dYaw * k;
      },
      done() { obj.position.copy(to); obj.scale.setScalar(1); obj.rotation.y = yaw1; if (done) done(); },
    });
  }

  function fadeOut(obj) {
    beginFade(obj);
    dying.add(obj);
    const y0 = obj.position.y, s0 = obj.scale.x;
    ticker.start(obj, {
      duration: CAPTURE_MS, ease: easeOut,
      update(k) {
        obj.position.y = y0 - 0.45 * k;
        obj.scale.setScalar(s0 * (1 - 0.4 * k));
        setOpacity(obj, 1 - k);
      },
      done() { removeNow(obj); },
    });
  }

  // -- set / view-mode swap ------------------------------------------------------------------------

  function liftY() { return viewMode === '2d' ? LIFT_Y_2D : LIFT_Y; }
  function liftScale() { return viewMode === '2d' ? LIFT_SCALE_2D : LIFT_SCALE; }

  /** Resolve a set id, falling back to the mode's built-in default when the id is unknown. */
  function resolveSet(id, mode) {
    if (setKind(id)) return id;
    return mode === '2d' ? DEFAULT_SET_2D : 'staunton';
  }

  /**
   * Rebuild every piece in `id`'s set on the SAME squares. `fade` cross-fades the two sets (the new meshes are
   * live in bySquare from the first frame); otherwise the old meshes go immediately. Cancels any drag and
   * finishes anything in flight first, so a lifted or sliding piece is re-seated rather than stranded.
   * Returns a Promise that resolves when the swap is visually complete.
   */
  function swapSet(id, fade) {
    const next = resolveSet(id, viewMode);
    ticker.finishAll();
    drag = null;
    for (const obj of Array.from(dying)) removeNow(obj);
    if (next === currentSet) {
      for (const [sq, obj] of bySquare) { place(obj, sq); applyFacing(obj); }
      return Promise.resolve();
    }
    currentSet = next;
    const outgoing = [];
    for (const [sq, obj] of Array.from(bySquare.entries())) {
      place(obj, sq);                     // a cancelled drag left this one lifted / off-square
      outgoing.push(obj);
      bySquare.set(sq, build(pieceOf(obj), sq));
    }
    if (!fade || !outgoing.length) {
      for (const obj of outgoing) removeNow(obj);
      return Promise.resolve();
    }
    const incoming = Array.from(bySquare.values());
    for (const obj of outgoing) { beginFade(obj); dying.add(obj); }
    for (const obj of incoming) { beginFade(obj); setOpacity(obj, 0); }
    return new Promise((resolve) => {
      ticker.start(FADE_KEY, {
        duration: FADE_MS, ease: easeOut,
        update(k) {
          for (const obj of outgoing) setOpacity(obj, 1 - k);
          for (const obj of incoming) setOpacity(obj, k);
        },
        done() {
          for (const obj of outgoing) removeNow(obj);
          for (const obj of incoming) releaseClonedMaterials(obj);
          resolve();
        },
      });
    });
  }

  // -- reconcile ------------------------------------------------------------------------------------

  function wantMap(pieces) {
    const want = new Map();
    for (const { square, piece } of pieces || []) if (square && piece) want.set(square, piece);
    return want;
  }

  /**
   * Accept the contract's {from,to,captured?,castle?,promotion?}, a play() result ({ node: { move } }),
   * a Node ({ move }), or a UCI string ('e7e8q'); returns a normalised move or null.
   */
  function normaliseMove(mv) {
    if (!mv) return null;
    if (typeof mv === 'string') {
      const m = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(mv.trim());
      return m ? { from: m[1], to: m[2], promotion: m[3] || null } : null;
    }
    const inner = mv.from && mv.to ? mv : (mv.move && mv.move.from ? mv.move : (mv.node && mv.node.move && mv.node.move.from ? mv.node.move : null));
    if (!inner) return null;
    return {
      from: inner.from, to: inner.to,
      captured: mv.captured !== undefined ? mv.captured : (mv.node ? mv.node.captured : undefined),
      castle: mv.castle, promotion: mv.promotion || inner.promotion || null,
    };
  }

  function rebuildInstant(want) {
    ticker.finishAll();
    if (drag) drag = null;
    for (const obj of Array.from(dying)) removeNow(obj);
    for (const [sq, obj] of Array.from(bySquare.entries())) {
      const p = want.get(sq);
      if (!p || !samePiece(p, pieceOf(obj))) { removeNow(obj); bySquare.delete(sq); }
      else place(obj, sq);   // kept: always re-seat (drag / drop may have moved it)
    }
    for (const [sq, p] of want) if (!bySquare.has(sq)) bySquare.set(sq, build(p, sq));
  }

  function reconcileAnimated(want, mv) {
    const from = mv.from, to = mv.to;
    // Finish anything still in flight first (a promotion's arrival swaps the mesh), then find the mover.
    ticker.finishAll();
    for (const obj of Array.from(dying)) removeNow(obj);
    const mover = bySquare.get(from);
    // A gesture may still be open (main.js syncs between attemptMove and interact's drop()). The mover
    // is handled below -- slide() starts from its current position -- but a lifted NON-mover would keep
    // its lifted y/scale forever, because clearing `drag` also makes the caller's later drop() a no-op.
    if (drag) {
      if (drag.obj !== mover) place(drag.obj, drag.square);
      drag = null;
    }
    if (!mover || !want.size) { rebuildInstant(want); return; }

    // Displaced: current meshes whose square no longer holds the same piece (excluding the mover's origin).
    // Landing: wanted squares that don't currently hold the same piece (excluding the mover's destination).
    const displaced = [];
    for (const [sq, obj] of bySquare) {
      if (sq === from) continue;
      if (!samePiece(want.get(sq), pieceOf(obj))) displaced.push({ sq, obj });
    }
    const landing = [];
    for (const [sq, p] of want) {
      if (sq === to) continue;
      const cur = bySquare.get(sq);
      if (!cur || !samePiece(p, pieceOf(cur))) landing.push({ sq, piece: p });
    }

    // Detach everyone involved first, then re-key.
    bySquare.delete(from);
    for (const d of displaced) bySquare.delete(d.sq);

    // Where the mover REALLY ends up. core writes Chess960 castling as king->own-rook-square in the
    // degenerate cases (king already on g1/c1, or one empty square away), so `to` can be a square that
    // is empty afterwards. Taking it at face value fades the king out and pops a fresh one at its
    // destination. Resolve it from the diff instead: claim the landing square that wants this king
    // (so it is not rebuilt), or -- when the king never left -- stay on `from`. Gated on the king so a
    // promotion (mover piece deliberately != want.get(to)) keeps its stated destination.
    const moverPiece = pieceOf(mover);
    let moverTo = to;
    if (moverPiece.role === 'king' && !samePiece(want.get(to), moverPiece)) {
      const i = landing.findIndex((l) => samePiece(l.piece, moverPiece));
      if (i >= 0) moverTo = landing.splice(i, 1)[0].sq;
      else if (samePiece(want.get(from), moverPiece)) moverTo = from;
    }

    // Same-piece displaced -> landing pairs slide (the castling rook, incl. Chess960 king/rook swaps).
    for (const d of displaced) {
      const i = landing.findIndex((l) => samePiece(l.piece, pieceOf(d.obj)));
      if (i >= 0) {
        const l = landing.splice(i, 1)[0];
        d.obj.userData.square = l.sq;
        bySquare.set(l.sq, d.obj);
        slide(d.obj, l.sq, MOVE_MS, null);
        d.done = true;
      }
    }
    // Remaining displaced pieces were captured (normal capture on `to`, or en passant on another square).
    for (const d of displaced) {
      if (d.done) continue;
      d.obj.userData.square = null;
      fadeOut(d.obj);
    }
    // Remaining landings have nothing to slide from (stale animateFrom): build them in place.
    for (const l of landing) if (!bySquare.has(l.sq)) bySquare.set(l.sq, build(l.piece, l.sq));

    // The mover.
    const target = want.get(moverTo);
    if (!target) { mover.userData.square = null; fadeOut(mover); }
    else {
      mover.userData.square = moverTo;
      bySquare.set(moverTo, mover);
      const promote = !samePiece(target, moverPiece);
      slide(mover, moverTo, from === moverTo ? 1 : MOVE_MS, () => {
        if (promote && bySquare.get(moverTo) === mover) {
          removeNow(mover);
          bySquare.set(moverTo, build(target, moverTo));
        }
      });
    }
    // Anything else out of step (should not happen) -> fix quietly.
    for (const [sq, obj] of Array.from(bySquare.entries())) if (!want.has(sq)) { removeNow(obj); bySquare.delete(sq); }
    for (const [sq, p] of want) if (!bySquare.has(sq)) bySquare.set(sq, build(p, sq));
  }

  // -- public API -----------------------------------------------------------------------------------

  const layer = {
    group,

    /** Reconcile meshes to `pieces`. animateFrom {from,to,captured?,castle?,promotion?} animates the move. */
    sync(pieces, opts = {}) {
      const want = wantMap(pieces);
      const mv = normaliseMove(opts.animateFrom);
      const animate = animations && !opts.instant && mv && worldFor(mv.from) && worldFor(mv.to);
      if (animate) reconcileAnimated(want, mv);
      else rebuildInstant(want);
    },

    /** The piece group on a square, or null. */
    meshAt(square) { return bySquare.get(square) || null; },

    /** Walk up from any object (a raycast hit) to the piece group's square. */
    squareOf(obj) {
      let o = obj;
      while (o) {
        if (o.userData && typeof o.userData.square === 'string') return o.userData.square;
        if (o === group) return null;
        o = o.parent;
      }
      return null;
    },

    /** Raise the piece on `square` for dragging. */
    lift(square) {
      const first = bySquare.get(square);
      if (!first) return;
      if (drag && drag.obj !== first) layer.drop(null);
      // Finishing an in-flight tween can SWAP the mesh on this square: a promotion slide's done()
      // removes the pawn and builds the queen. Re-read the square afterwards so the drag grabs the
      // live piece and not the one that was just disposed.
      ticker.finish(first);
      const obj = bySquare.get(square) || first;
      if (!obj.parent) return;
      drag = { obj, square };
      const y0 = obj.position.y, s0 = obj.scale.x;
      const y1 = liftY(), s1 = liftScale();
      ticker.start(obj, {
        duration: LIFT_MS, ease: easeOut,
        update(k) { obj.position.y = y0 + (y1 - y0) * k; obj.scale.setScalar(s0 + (s1 - s0) * k); },
      });
    },

    /** Move the lifted piece under the pointer (x/z from the point; the lift is kept). */
    dragTo(worldPoint) {
      if (!drag || !worldPoint) return;
      const obj = drag.obj;
      if (ticker.has(obj)) ticker.finish(obj);
      obj.position.x = worldPoint.x;
      obj.position.z = worldPoint.z;
      obj.position.y = liftY();
      obj.scale.setScalar(liftScale());
    },

    /** Settle the lifted piece onto `square` (visual only; sync() re-keys it), or snap back with null. */
    drop(square) {
      if (!drag) return;
      const { obj, square: origin } = drag;
      drag = null;
      if (!obj.parent) return;   // the mesh was swapped out (promotion) or captured by a sync meanwhile
      const dest = (square && worldFor(square)) ? square : origin;
      const to = worldFor(dest);
      if (!to) return;
      const from = obj.position.clone(), s0 = obj.scale.x;
      const ms = dest === origin && square !== origin ? SNAP_MS : DROP_MS;
      ticker.start(obj, {
        duration: ms, ease: easeOut,
        update(k) {
          obj.position.x = from.x + (to.x - from.x) * k;
          obj.position.z = from.z + (to.z - from.z) * k;
          obj.position.y = from.y * (1 - k);
          obj.scale.setScalar(s0 + (1 - s0) * k);
        },
        done() { obj.position.copy(to); obj.scale.setScalar(1); },
      });
    },

    /**
     * The 3D / sculpted slot (settings.pieceSet). Rebuilds every piece in place when 3D is showing;
     * while 2D is showing it is only remembered for the next switch. Unknown ids fall back to 'staunton'.
     */
    setSet(setId) {
      set3d = resolveSet(setId, '3d');
      if (viewMode === '3d') swapSet(set3d, false);
    },

    /** The 2D / token slot (settings.pieceSet2d). Applies now only while 2D is showing. */
    setSet2d(setId) {
      set2d = resolveSet(setId, '2d');
      if (viewMode === '2d') swapSet(set2d, false);
    },

    /**
     * Swap between the sculpted set (3D) and the flat token set (2D) as a short cross-fade.
     * Squares are untouched; the store's selection is untouched (the layer never writes it). An in-flight
     * drag or tween is cancelled first -- the piece is re-seated on its square rather than left in hand.
     * opts { animate = settings.animations }. Returns a Promise resolved when the fade ends.
     */
    setViewMode(mode, opts = {}) {
      const next = mode === '2d' ? '2d' : '3d';
      if (next === viewMode) return Promise.resolve();
      viewMode = next;
      const fade = opts.animate !== undefined ? !!opts.animate : animations;
      return swapSet(next === '2d' ? set2d : set3d, fade);
    },

    /** '2d' | '3d'. */
    viewMode() { return viewMode; },

    /** The set id stored for a mode ('2d' | '3d'); defaults to the current mode. */
    setFor(mode) {
      if (mode === '2d') return set2d;
      if (mode === '3d') return set3d;
      return currentSet;
    },

    /**
     * Fade every piece in from nothing -- the boot, when the set has arrived: the pieces used to pop onto an empty
     * board (critique r4). Lands any cross-fade first; instant when animations are off. Resolves when done.
     */
    fadeIn(duration = BOOT_FADE_MS) {
      ticker.finish(FADE_KEY);
      const pieces = Array.from(bySquare.values());
      if (!animations || !pieces.length || !(duration > 0)) return Promise.resolve();
      for (const obj of pieces) {
        beginFade(obj);
        // nothing else shares these squares, so each piece can fade as the solid it is: its nearest surface only
        // (depth written, front faces), not every layer of it showing through the others
        obj.traverse((o) => { if (o.isMesh && o.userData.fadeMaterial && !o.userData.contactShadow) { o.material.depthWrite = true; o.material.side = THREE.FrontSide; } });
        setOpacity(obj, 0);
      }
      return new Promise((resolve) => {
        ticker.start(FADE_KEY, {
          duration, ease: easeOut,
          update(k) { for (const obj of pieces) setOpacity(obj, k); },
          done() { for (const obj of pieces) releaseClonedMaterials(obj); resolve(); },
        });
      });
    },

    /** Apply a new material set to every piece (theme change). */
    setMaterials(next) {
      ticker.finish(FADE_KEY);   // a cross-fade is running on CLONED materials; land it before re-assigning
      mats = next;
      for (const obj of bySquare.values()) applyMaterials(obj, mats);
    },

    /** Top-level piece groups (raycast targets). Fading captures are excluded. */
    pieceObjects() { return Array.from(bySquare.values()); },

    /** Square centre (y = 0) for a square, or null off-board. */
    worldFor(square) { return worldFor(square); },

    /** Use another square->Vector3 mapper (e.g. board.worldFor) and re-seat every piece. */
    setSquareMapper(fn) {
      worldFor = typeof fn === 'function' ? (sq) => { const v = fn(sq); return v ? v.clone() : null; } : defaultWorldFor;
      layer.settle();
    },

    /**
     * Turn the flat tokens so they read upright from this seat (no effect on sculpted sets, which are turned
     * by piece colour instead). Animated by default while a token set is showing, so the tokens turn WITH
     * view.rotateSeat()'s board rotation during self-play; opts { animate, duration = 700 }.
     * Returns a Promise resolved when the turn ends.
     */
    setOrientation(o, opts = {}) {
      orientation = o === 'black' ? 'black' : 'white';
      const target = orientation === 'black' ? Math.PI : 0;
      const animate = opts.animate !== undefined ? !!opts.animate : animations;
      ticker.finish(SPIN_KEY);
      const from = spin;
      const apply = () => { for (const obj of bySquare.values()) applyFacing(obj); };
      if (!animate || !flatSet() || Math.abs(target - from) < 1e-6) {
        spin = target;
        apply();
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        ticker.start(SPIN_KEY, {
          duration: Math.max(1, opts.duration || SPIN_MS), ease: easeInOut,
          update(k) { spin = from + (target - from) * k; apply(); },
          done() { spin = target; apply(); resolve(); },
        });
      });
    },

    /** Snap every piece to its nominal square immediately (cancels tweens and any drag). */
    settle() {
      ticker.finishAll();
      drag = null;
      for (const obj of Array.from(dying)) removeNow(obj);
      for (const [sq, obj] of bySquare) place(obj, sq);
    },

    /** Turn move animation on/off (sync() also honours opts.instant). */
    setAnimations(on) { animations = !!on; },

    /** True while a tween is running. */
    isAnimating() { return ticker.size > 0; },

    /** The active set id. */
    currentSet() { return currentSet; },

    /** Remove everything from the scene and free shared caches. */
    dispose() {
      ticker.finishAll();
      ticker.dispose();
      drag = null;
      for (const obj of Array.from(dying)) removeNow(obj);
      for (const obj of bySquare.values()) { group.remove(obj); releaseClonedMaterials(obj); }
      bySquare.clear();
      if (group.parent) group.parent.remove(group);
      disposePieceCaches();
    },
  };

  // Every call that changes the meshes asks the view for a full frame (three/redraw.js); the ticker asks on each
  // step of a tween. The getters (meshAt, squareOf, pieceObjects, worldFor, setFor, ...) do not.
  for (const name of ['sync', 'lift', 'dragTo', 'drop', 'setSet', 'setSet2d', 'setViewMode', 'fadeIn', 'setMaterials',
    'setSquareMapper', 'setOrientation', 'settle', 'dispose']) {
    const fn = layer[name];
    layer[name] = function (...args) {
      const out = fn.apply(this, args);
      requestRedraw('content');
      return out;
    };
  }

  return layer;
}
