import * as THREE from 'three';
import { createPiece, applyMaterials, setKind, isDirectional, bishopCut, disposePieceCaches } from './pieces.js';
import { requestRedraw } from './redraw.js';

const FILES = 'abcdefgh';
const MOVE_MS = 220, CAPTURE_MS = 260, LIFT_MS = 110, DROP_MS = 130, SNAP_MS = 160;
const LIFT_Y = 0.35, LIFT_SCALE = 1.06, ARC_Y = 0.18;
// 2D is seen straight down, so the scale carries the "in hand" signal instead of the height
const LIFT_Y_2D = 0.2, LIFT_SCALE_2D = 1.16;
const FADE_MS = 240;            // the 2D <-> 3D cross-fade
const BOOT_FADE_MS = 450;       // the pieces arriving on the board at boot (fadeIn)
const SPIN_MS = 700;            // matches view.rotateSeat's default duration
const DEFAULT_SET_2D = 'glyph';
const KNIGHT_TURN = 25 * Math.PI / 180;   // toward the board's centre line
const BISHOP_TURN = 45 * Math.PI / 180;   // the mitre cut, three-quarter to its owner
const FADE_KEY = { fade: true };   // ticker keys (objects, never a piece group)
const SPIN_KEY = { spin: true };

/** Square centre in world units at y = 0. */
function defaultWorldFor(square) {
  const f = FILES.indexOf(square[0]);
  const r = parseInt(square[1], 10);

  if (f < 0 || !(r >= 1 && r <= 8)) return null;

  return new THREE.Vector3(f - 3.5, 0, 4.5 - r);
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const samePiece = (a, b) => !!a && !!b && a.role === b.role && a.color === b.color;

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

      if (k >= 1) {
        active.delete(key);
        if (tw.done) tw.done();
      }
    }

    if (active.size) schedule();
  }

  return {
    /** Start a tween on `key`; a running tween on the same key is finished first (jumps to its end). */
    start(key, { duration, ease = easeInOut, update, done }) {
      this.finish(key);

      const tw = { start: now(), duration: Math.max(1, duration), ease, update, done };
      active.set(key, tw);

      if (typeof requestAnimationFrame === 'undefined') {
        update(1, 1);
        active.delete(key);
        if (done) done();
        return;
      }

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

/** Create the piece layer: a THREE.Group added to `scene`, reconciled with sync(). */
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

  /** True for a flat token set: it is turned by the seat, not by the piece colour. */
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

  /** A bishop's yaw that shows its cut three-quarter to its owner; null for other pieces or a set without a cut. */
  function bishopYaw(u, square) {
    const cut = u.role === 'bishop' ? bishopCut(currentSet) : null;
    const f = typeof square === 'string' ? FILES.indexOf(square[0]) : -1;

    if (cut === null || f < 0) return null;

    const side = f < 4 ? 1 : -1;
    const target = u.color === 'white' ? side * BISHOP_TURN : Math.PI - side * BISHOP_TURN;   // azimuth, 0 = +Z

    return target - cut;
  }

  /** The y rotation a piece should have on `square`. */
  function yawFor(obj, square = obj.userData.square) {
    if (flatSet()) return spin;

    const bishop = bishopYaw(obj.userData, square);

    if (bishop !== null) return bishop;

    return facingRotation(obj.userData.color) + knightTurn(obj.userData, square);
  }

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

  /** Material.clone() drops own-property shader hooks, so they are copied across. */
  function cloneForFade(m) {
    const c = m.clone();
    if (Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile')) c.onBeforeCompile = m.onBeforeCompile;
    if (Object.prototype.hasOwnProperty.call(m, 'customProgramCacheKey')) c.customProgramCacheKey = m.customProgramCacheKey;
    return c;
  }

  // piece materials are shared per colour, so a fade runs on a clone that endFade gives back
  function beginFade(obj) {
    obj.traverse((o) => {
      // a stand-in borrows the full mesh's material, so it needs no fade clone
      if (!o.isMesh || o.userData.fadeMaterial || o.userData.standIn) return;

      o.userData.fadeOriginal = o.material;
      o.material = cloneForFade(o.material);
      o.material.transparent = true;
      o.material.depthWrite = false;
      o.userData.fadeMaterial = true;
    });
  }

  // relative to each part's own opacity (the contact decal is already translucent)
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

  function slide(obj, toSquare, duration, done) {
    const to = worldFor(toSquare);

    if (!to) {
      if (done) done();
      return;
    }

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
      done() {
        obj.position.copy(to);
        obj.scale.setScalar(1);
        obj.rotation.y = yaw1;
        if (done) done();
      },
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

  function liftY() { return viewMode === '2d' ? LIFT_Y_2D : LIFT_Y; }

  function liftScale() { return viewMode === '2d' ? LIFT_SCALE_2D : LIFT_SCALE; }

  /** Resolve a set id, falling back to the mode's built-in default when the id is unknown. */
  function resolveSet(id, mode) {
    if (setKind(id)) return id;
    return mode === '2d' ? DEFAULT_SET_2D : 'staunton';
  }

  /** Rebuild every piece in `id`'s set on the same squares, cross-fading when `fade`; resolves when done. */
  function swapSet(id, fade) {
    const next = resolveSet(id, viewMode);

    ticker.finishAll();
    drag = null;
    for (const obj of Array.from(dying)) removeNow(obj);

    if (next === currentSet) {
      for (const [sq, obj] of bySquare) {
        place(obj, sq);
        applyFacing(obj);
      }

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

    for (const obj of outgoing) {
      beginFade(obj);
      dying.add(obj);
    }

    for (const obj of incoming) {
      beginFade(obj);
      setOpacity(obj, 0);
    }

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

  function wantMap(pieces) {
    const want = new Map();
    for (const { square, piece } of pieces || []) if (square && piece) want.set(square, piece);
    return want;
  }

  /** Accept {from,to,...}, a play() result, a Node or a UCI string; returns a normalised move or null. */
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

      if (!p || !samePiece(p, pieceOf(obj))) {
        removeNow(obj);
        bySquare.delete(sq);
      }
      else place(obj, sq);   // kept: always re-seat (drag / drop may have moved it)
    }

    for (const [sq, p] of want) if (!bySquare.has(sq)) bySquare.set(sq, build(p, sq));
  }

  function reconcileAnimated(want, mv) {
    const from = mv.from, to = mv.to;

    // a promotion's arrival swaps the mesh, so finish what is in flight before finding the mover
    ticker.finishAll();
    for (const obj of Array.from(dying)) removeNow(obj);

    const mover = bySquare.get(from);

    // a lifted non-mover would keep its lift forever once `drag` is cleared
    if (drag) {
      if (drag.obj !== mover) place(drag.obj, drag.square);
      drag = null;
    }

    if (!mover || !want.size) {
      rebuildInstant(want);
      return;
    }

    // displaced: meshes whose square no longer holds the same piece; landing: wanted squares that need one
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

    bySquare.delete(from);
    for (const d of displaced) bySquare.delete(d.sq);

    // Chess960 castling can name a `to` that ends up empty; resolve the king's square from the diff
    const moverPiece = pieceOf(mover);
    let moverTo = to;

    if (moverPiece.role === 'king' && !samePiece(want.get(to), moverPiece)) {
      const i = landing.findIndex((l) => samePiece(l.piece, moverPiece));
      if (i >= 0) moverTo = landing.splice(i, 1)[0].sq;
      else if (samePiece(want.get(from), moverPiece)) moverTo = from;
    }

    // same-piece displaced -> landing pairs slide (the castling rook)
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

    // the rest were captured (on `to`, or en passant elsewhere)
    for (const d of displaced) {
      if (d.done) continue;
      d.obj.userData.square = null;
      fadeOut(d.obj);
    }

    // landings with nothing to slide from (stale animateFrom) are built in place
    for (const l of landing) if (!bySquare.has(l.sq)) bySquare.set(l.sq, build(l.piece, l.sq));

    const target = want.get(moverTo);

    if (!target) {
      mover.userData.square = null;
      fadeOut(mover);
    }
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

    // anything else out of step (should not happen) is fixed quietly
    for (const [sq, obj] of Array.from(bySquare.entries())) if (!want.has(sq)) {
      removeNow(obj);
      bySquare.delete(sq);
    }

    for (const [sq, p] of want) if (!bySquare.has(sq)) bySquare.set(sq, build(p, sq));
  }

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

      // finishing a tween can swap the mesh (a promotion), so re-read the square
      ticker.finish(first);
      const obj = bySquare.get(square) || first;

      if (!obj.parent) return;

      drag = { obj, square };

      const y0 = obj.position.y, s0 = obj.scale.x;
      const y1 = liftY(), s1 = liftScale();

      ticker.start(obj, {
        duration: LIFT_MS, ease: easeOut,
        update(k) {
          obj.position.y = y0 + (y1 - y0) * k;
          obj.scale.setScalar(s0 + (s1 - s0) * k);
        },
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
        done() {
          obj.position.copy(to);
          obj.scale.setScalar(1);
        },
      });
    },

    /** The 3D slot (settings.pieceSet); applies now only while 3D is showing. */
    setSet(setId) {
      set3d = resolveSet(setId, '3d');
      if (viewMode === '3d') swapSet(set3d, false);
    },

    /** The 2D / token slot (settings.pieceSet2d). Applies now only while 2D is showing. */
    setSet2d(setId) {
      set2d = resolveSet(setId, '2d');
      if (viewMode === '2d') swapSet(set2d, false);
    },

    /** Cross-fade between the 3D and the 2D set; resolves when the fade ends. */
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

    /** Fade every piece in from nothing (the boot); resolves when done. */
    fadeIn(duration = BOOT_FADE_MS) {
      ticker.finish(FADE_KEY);

      const pieces = Array.from(bySquare.values());

      if (!animations || !pieces.length || !(duration > 0)) return Promise.resolve();

      for (const obj of pieces) {
        beginFade(obj);

        // each piece fades as a solid: depth written, front faces only
        obj.traverse((o) => {
          if (o.isMesh && o.userData.fadeMaterial && !o.userData.contactShadow) {
            o.material.depthWrite = true;
            o.material.side = THREE.FrontSide;
          }
        });

        setOpacity(obj, 0);
      }

      return new Promise((resolve) => {
        ticker.start(FADE_KEY, {
          duration, ease: easeOut,
          update(k) { for (const obj of pieces) setOpacity(obj, k); },
          done() {
            for (const obj of pieces) releaseClonedMaterials(obj);
            resolve();
          },
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
      worldFor = typeof fn === 'function'
        ? (sq) => {
          const v = fn(sq);
          return v ? v.clone() : null;
        }
        : defaultWorldFor;

      layer.settle();
    },

    /** Turn the flat tokens upright for this seat, animated by default; resolves when the turn ends. */
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
          update(k) {
            spin = from + (target - from) * k;
            apply();
          },
          done() {
            spin = target;
            apply();
            resolve();
          },
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

      for (const obj of bySquare.values()) {
        group.remove(obj);
        releaseClonedMaterials(obj);
      }

      bySquare.clear();
      if (group.parent) group.parent.remove(group);
      disposePieceCaches();
    },
  };

  // every call that changes the meshes asks for a full frame
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
