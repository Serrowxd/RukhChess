// node --test test/pieces-profiles.test.mjs
// Pure checks on the staunton lathe profiles (no WebGL), geometry-level checks on every built-in set
// (three builds geometry fine under node), the lighting/contrast material switches, and the piece
// layer's reconcile logic (the internal ticker completes tweens synchronously when
// requestAnimationFrame is absent, so end states are testable).
//
// The pieces cannot be eyeballed from here, so "does it look like a bishop" is checked numerically:
//   * radiusProfile() rasterises each piece into max-radius-per-height-band by walking triangle edges;
//     every pair of roles must differ by a minimum L1 and Linf (see 'silhouettes are measurably distinct')
//   * asciiSilhouette() prints the side view of each role so a reviewer can read the shapes in the log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  PROFILES, KNIGHT_BASE_PROFILE, ROOK_CROWN_PROFILE, GLYPH_DISC_PROFILE, GLYPH_BEZEL_PROFILE,
  HEIGHTS, ROLES, BUILTIN_SETS, BUILTIN_SETS_2D, CONTACT_RADIUS,
  listSets, createPiece, applyMaterials, setKind, isDirectional, isFlatSet, isModeledSet, registerGltfSet, unregisterSet,
  bishopCut,
} from '../src/three/pieces.js';
import { MODELED_SETS } from '../src/three/modeledSets.js';
import { createPieceLayer } from '../src/three/pieceLayer.js';
import {
  THEMES, THEME_PALETTES, createMaterialSet, resolvePalette, disposeMaterialCaches, setMaterialUnlit,
  flattenMetalPixels,
} from '../src/three/materials.js';
import { edgeFar, FAR } from '../src/three/silhouette.js';
import { GLYPHS, GLYPH_IDS, glyphId, glyphSvg, glyphDataUrl, glyphPiece } from '../src/three/glyphs.js';
import { getGlyphTexture } from '../src/three/pieces.js';
import { Game } from '../src/core/game.js';

const MAX_RADIUS = 0.4;
const FOOTPRINT = 0.8;

/** Where each open profile's lathe actually stops (the rest of the piece is separate geometry). */
const PROFILE_TOPS = { pawn: 0.58, rook: 0.60, bishop: 0.88, queen: 1.02, king: 1.012 };

function checkProfile(name, profile, expectedTop) {
  assert.ok(Array.isArray(profile) && profile.length >= 3, `${name}: profile is an array of points`);
  for (const p of profile) {
    assert.ok(Array.isArray(p) && p.length === 2, `${name}: point is [radius, height]`);
    assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), `${name}: finite numbers`);
    assert.ok(p[0] >= 0, `${name}: radius >= 0`);
  }
  assert.deepEqual(profile[0], [0, 0], `${name}: starts at radius 0, y 0`);
  const [dx0, dy0] = [profile[1][0] - profile[0][0], profile[1][1] - profile[0][1]];
  assert.ok(dx0 !== 0 || dy0 !== 0, `${name}: first segment must not be zero-length (LatheGeometry normal)`);
  for (let i = 1; i < profile.length; i++) {
    assert.ok(profile[i][1] >= profile[i - 1][1], `${name}: monotonic in y at index ${i} (${profile[i - 1][1]} -> ${profile[i][1]})`);
  }
  const maxR = Math.max(...profile.map((p) => p[0]));
  assert.ok(maxR <= MAX_RADIUS, `${name}: max radius ${maxR} <= ${MAX_RADIUS}`);
  assert.equal(profile[profile.length - 1][0], 0, `${name}: closes on the axis (last radius 0)`);
  const top = profile[profile.length - 1][1];
  if (expectedTop != null) {
    assert.ok(Math.abs(top - expectedTop) <= 1e-3, `${name}: profile top ${top} == ${expectedTop}`);
  }
  return { maxR, top };
}

/** A closed cross-section (revolved into a hollow ring): first point == last, never touches the axis. */
function checkRing(name, profile, minR) {
  assert.ok(profile.length >= 5, `${name}: enough points for a ring`);
  assert.deepEqual(profile[0], profile[profile.length - 1], `${name}: the loop closes`);
  for (const [r, y] of profile) {
    assert.ok(Number.isFinite(r) && Number.isFinite(y), `${name}: finite`);
    assert.ok(r >= minR, `${name}: radius ${r} stays off the axis (>= ${minR})`);
    assert.ok(r <= MAX_RADIUS, `${name}: radius ${r} <= ${MAX_RADIUS}`);
  }
  const ys = profile.map((p) => p[1]);
  return { minY: Math.min(...ys), maxY: Math.max(...ys), maxR: Math.max(...profile.map((p) => p[0])) };
}

// ---------------------------------------------------------------------------------------------
// Silhouette tooling.

const BAND = 0.04;
const BANDS = 30;   // 0 .. 1.20, which covers the tallest piece

/** Max radial extent per height band, sampled along every triangle edge (fills flat cylinder walls). */
function radiusProfile(obj, { includeDecal = false } = {}) {
  obj.updateMatrixWorld(true);
  const bands = new Array(BANDS).fill(0);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), p = new THREE.Vector3();
  const put = (v) => {
    const t = Math.min(BANDS - 1, Math.max(0, Math.floor(v.y / BAND)));
    const r = Math.hypot(v.x, v.z);
    if (r > bands[t]) bands[t] = r;
  };
  obj.traverse((m) => {
    if (!m.isMesh) return;
    if (!includeDecal && (m.userData.contactShadow || m.userData.glyphCard)) return;
    const g = m.geometry, pos = g.attributes.position, idx = g.index;
    const tris = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < tris; t++) {
      const i0 = idx ? idx.getX(t * 3) : t * 3;
      const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(pos, i1).applyMatrix4(m.matrixWorld);
      c.fromBufferAttribute(pos, i2).applyMatrix4(m.matrixWorld);
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        for (let k = 0; k <= 6; k++) { p.lerpVectors(u, v, k / 6); put(p); }
      }
    }
  });
  return bands;
}

function curveDistance(x, y) {
  let l1 = 0, li = 0;
  for (let k = 0; k < BANDS; k++) { const d = Math.abs(x[k] - y[k]); l1 += d; if (d > li) li = d; }
  return { l1: l1 / BANDS, li };
}

/** ASCII side view of one radius profile: a half-silhouette mirrored about the axis. */
function asciiSilhouette(bands, width = 17) {
  const rows = [];
  for (let i = BANDS - 1; i >= 0; i--) {
    const half = Math.round(bands[i] / MAX_RADIUS * ((width - 1) / 2));
    const mid = (width - 1) / 2;
    let row = '';
    for (let x = 0; x < width; x++) row += Math.abs(x - mid) <= half && bands[i] > 0 ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------

test('lathe profiles: start at origin, monotonic, radius <= 0.4, top exactly where the set expects it', () => {
  for (const role of ['pawn', 'rook', 'bishop', 'queen', 'king']) {
    const { top } = checkProfile(role, PROFILES[role], PROFILE_TOPS[role]);
    assert.ok(top <= HEIGHTS[role] + 1e-9, `${role}: the lathe never passes the role height`);
    assert.ok(PROFILES[role].length >= 60, `${role}: ${PROFILES[role].length} profile points (>= 60 keeps the turn smooth)`);
  }
  assert.equal(Object.keys(PROFILES).length, 5);
});

test('knight base and glyph disc profiles keep the same invariants', () => {
  const kb = checkProfile('knight-base', KNIGHT_BASE_PROFILE, null);
  assert.ok(kb.top > 0.2 && kb.top < 0.4, 'knight base platform sits low; the carved head reaches HEIGHTS.knight');
  const gd = checkProfile('glyph-disc', GLYPH_DISC_PROFILE, null);
  assert.ok(gd.top <= 0.09, 'the 2D token is thin');
  assert.ok(gd.maxR >= 0.28, 'and wide enough to read from above');
});

test('ring cross-sections: rook crown is hollow, token bezel surrounds the disc', () => {
  const crown = checkRing('rook-crown', ROOK_CROWN_PROFILE, 0.15);
  assert.ok(crown.maxY < HEIGHTS.rook, 'the crenellations sit above the crown band');
  assert.ok(crown.maxY - crown.minY >= 0.04, 'the band has real height');
  const inner = Math.min(...ROOK_CROWN_PROFILE.map((p) => p[0]));
  assert.ok(crown.maxR - inner >= 0.03, `rook crown wall thickness ${(crown.maxR - inner).toFixed(3)}`);
  assert.ok(inner >= 0.15, 'the rook top is genuinely open (the ring never reaches the axis)');

  const bezel = checkRing('token-bezel', GLYPH_BEZEL_PROFILE, 0.25);
  const bezelInner = Math.min(...GLYPH_BEZEL_PROFILE.map((p) => p[0]));
  const discMaxR = Math.max(...GLYPH_DISC_PROFILE.map((p) => p[0]));
  assert.ok(bezelInner <= discMaxR, 'the bezel overlaps the disc so there is no seam');
  assert.ok(bezel.maxR > discMaxR, 'and stands proud of it, which is the readable rim');
  assert.ok(bezel.maxR * 2 <= FOOTPRINT, 'token still fits the square');
});

test('the height ladder is Staunton-shaped and every step is separable by eye', () => {
  assert.deepEqual(HEIGHTS, { pawn: 0.58, knight: 0.80, bishop: 0.88, rook: 0.70, queen: 1.02, king: 1.18 });
  assert.deepEqual(ROLES.slice().sort(), ['bishop', 'king', 'knight', 'pawn', 'queen', 'rook']);
  const order = ROLES.slice().sort((a, b) => HEIGHTS[a] - HEIGHTS[b]);
  assert.deepEqual(order, ['pawn', 'rook', 'knight', 'bishop', 'queen', 'king'], 'classic ladder');
  for (let i = 1; i < order.length; i++) {
    const gap = HEIGHTS[order[i]] - HEIGHTS[order[i - 1]];
    assert.ok(gap >= 0.05, `${order[i - 1]} -> ${order[i]}: gap ${gap.toFixed(3)} >= 0.05`);
  }
  // relative to the king, within 4 points of a 3.75" tournament set on a 2.25" square
  const want = { pawn: 0.467, rook: 0.560, knight: 0.640, bishop: 0.733, queen: 0.867, king: 1 };
  for (const r of ROLES) {
    const got = HEIGHTS[r] / HEIGHTS.king;
    assert.ok(Math.abs(got - want[r]) <= 0.045, `${r}: ${got.toFixed(3)} vs Staunton ${want[r]}`);
  }
  assert.ok(HEIGHTS.king >= 1.12, 'the king was raised out of its squat v0 proportions');
});

test('every built-in piece: origin at base, exact height, footprint <= 0.8, shadows on, userData set', () => {
  for (const set of BUILTIN_SETS) {
    for (const role of ROLES) {
      for (const color of ['white', 'black']) {
        const obj = createPiece(role, color, set.id, null);
        assert.ok(obj.isGroup, `${set.id}/${role}: a Group`);
        assert.deepEqual({ role: obj.userData.role, color: obj.userData.color, square: obj.userData.square }, { role, color, square: null });
        let meshes = 0, decals = 0;
        obj.traverse((o) => {
          if (!o.isMesh) return;
          meshes++;
          if (o.userData.contactShadow) {
            decals++;
            assert.equal(o.castShadow, false, `${set.id}/${role}: the decal casts nothing`);
            assert.equal(o.receiveShadow, false);
          } else if (!o.userData.glyphCard) {
            assert.equal(o.castShadow, true, `${set.id}/${role}: castShadow`);
            assert.equal(o.receiveShadow, true);
          }
        });
        assert.ok(meshes >= 2, `${set.id}/${role}: has meshes`);
        assert.equal(decals, 1, `${set.id}/${role}: exactly one contact shadow`);
        assert.equal(obj.userData.contactShadow.isMesh, true, `${set.id}/${role}: the decal is reachable from userData`);

        obj.updateMatrixWorld(true);
        const full = new THREE.Box3().setFromObject(obj);
        assert.ok(full.min.y >= -0.03 && full.min.y <= 0.03, `${set.id}/${role}: base on y=0 (min y ${full.min.y.toFixed(3)})`);
        const fw = full.max.x - full.min.x, fd = full.max.z - full.min.z;
        assert.ok(fw <= FOOTPRINT && fd <= FOOTPRINT, `${set.id}/${role}: footprint with decal ${fw.toFixed(3)} x ${fd.toFixed(3)} <= ${FOOTPRINT}`);

        // the piece itself, decal excluded
        const box = new THREE.Box3();
        obj.traverse((o) => { if (o.isMesh && !o.userData.contactShadow) box.expandByObject(o); });
        const w = box.max.x - box.min.x, d = box.max.z - box.min.z;
        assert.ok(w <= FOOTPRINT && d <= FOOTPRINT, `${set.id}/${role}: footprint ${w.toFixed(2)} x ${d.toFixed(2)} <= ${FOOTPRINT}`);
        assert.ok(Math.abs(box.max.x + box.min.x) < 0.06 && Math.abs(box.max.z + box.min.z) < 0.3, `${set.id}/${role}: roughly centred`);
        if (set.id !== 'glyph') {
          const h = box.max.y;
          assert.ok(Math.abs(h - HEIGHTS[role]) <= 0.006, `${set.id}/${role}: height ${h.toFixed(4)} == ${HEIGHTS[role]}`);
          // a Staunton piece is markedly taller than it is wide -- this is the "squat" regression guard
          assert.ok(h / Math.max(w, d) >= 1.28, `${set.id}/${role}: height/width ${(h / Math.max(w, d)).toFixed(2)} >= 1.28`);
        }
      }
    }
  }
});

test('silhouettes are measurably distinct: every pair of roles differs in its radius-at-height curve', () => {
  for (const setId of ['staunton', 'minimal']) {
    const sig = {};
    for (const role of ROLES) sig[role] = radiusProfile(createPiece(role, 'white', setId, null));
    let worstL1 = Infinity, worstLi = Infinity, worstPair = '';
    for (let i = 0; i < ROLES.length; i++) {
      for (let j = i + 1; j < ROLES.length; j++) {
        const { l1, li } = curveDistance(sig[ROLES[i]], sig[ROLES[j]]);
        assert.ok(l1 >= 0.018, `${setId}: ${ROLES[i]} vs ${ROLES[j]} mean radius difference ${l1.toFixed(4)} >= 0.018`);
        assert.ok(li >= 0.07, `${setId}: ${ROLES[i]} vs ${ROLES[j]} peak radius difference ${li.toFixed(4)} >= 0.07`);
        if (l1 < worstL1) { worstL1 = l1; worstPair = `${ROLES[i]}/${ROLES[j]}`; }
        if (li < worstLi) worstLi = li;
      }
    }
    console.log(`  ${setId}: closest pair ${worstPair} (mean ${worstL1.toFixed(4)}, peak ${worstLi.toFixed(4)})`);
  }
});

test('the identifying feature of each staunton piece is where it should be', () => {
  const sig = {};
  for (const role of ROLES) sig[role] = radiusProfile(createPiece(role, 'white', 'staunton', null));
  const bandAt = (y) => Math.min(BANDS - 1, Math.floor(y / BAND));
  const top = (role, frac) => {
    const from = bandAt(HEIGHTS[role] * frac);
    return Math.max(...sig[role].slice(from, bandAt(HEIGHTS[role]) + 1));
  };
  // rook: the crenellated crown is the widest thing in its top third
  assert.ok(top('rook', 0.72) >= 0.20, `rook crown radius ${top('rook', 0.72).toFixed(3)} >= 0.20`);
  // queen: the coronet is wide, but it ends in a small finial
  assert.ok(top('queen', 0.70) >= 0.17, 'queen coronet is broad');
  assert.ok(sig.queen[bandAt(HEIGHTS.queen) ] <= 0.09, 'queen finishes on a small ball');
  // king: the cross is narrow, and it is the only piece with geometry above 1.02
  assert.ok(sig.king[bandAt(1.10)] > 0 && sig.king[bandAt(1.10)] <= 0.10, 'king cross is narrow and high');
  for (const r of ROLES) if (r !== 'king') assert.equal(sig[r][bandAt(1.10)], 0, `${r} has nothing at the king's cross height`);
  // bishop: mitre swells then closes to a small finial
  assert.ok(top('bishop', 0.60) >= 0.13, 'bishop mitre swells');
  assert.ok(sig.bishop[bandAt(HEIGHTS.bishop)] <= 0.07, 'bishop finishes on a small ball');
  // knight: the head is the widest part of the piece above half height (it overhangs the base)
  assert.ok(Math.max(...sig.knight.slice(bandAt(0.45), bandAt(0.70))) >= 0.24, 'knight head overhangs');
  // pawn: nothing above 0.58 and a ball wider than its neck
  assert.equal(sig.pawn[bandAt(0.62)], 0, 'pawn is the shortest piece');
  assert.ok(sig.pawn[bandAt(0.50)] > sig.pawn[bandAt(0.42)], 'pawn ball is wider than the neck below it');

  console.log('  staunton side silhouettes (rows = 0.04 units, widest = 0.40):');
  const plots = ROLES.map((r) => asciiSilhouette(sig[r]));
  console.log('   ' + ROLES.map((r) => r.padEnd(17)).join(' '));
  for (let i = 0; i < BANDS; i++) console.log('   ' + plots.map((p) => p[i]).join(' '));
});

test('listSets / setKind / isDirectional / 2D sets', () => {
  const sets = listSets();
  // the built-ins first, then every modelled set (Blender GLBs, listed before they load)
  assert.deepEqual(sets.map((s) => s.id), ['staunton', 'minimal', 'glyph', ...MODELED_SETS.map((s) => s.id)]);
  assert.ok(sets.slice(0, 3).every((s) => s.kind === 'builtin'));
  assert.ok(sets.slice(3).every((s) => s.kind === 'model' && s.loaded === false));
  assert.equal(setKind('staunton'), 'builtin');
  assert.equal(setKind('nope'), null);
  // a modelled set is not buildable until ensureModeledSet() has loaded it
  for (const s of MODELED_SETS) {
    assert.equal(isModeledSet(s.id), true);
    assert.equal(setKind(s.id), null);
  }
  assert.equal(isModeledSet('staunton'), false);
  assert.equal(isDirectional('staunton'), true);
  assert.equal(isDirectional('glyph'), false);
  // the 2D list must be a subset of the built-ins and every entry must be flat
  assert.ok(BUILTIN_SETS_2D.length >= 1);
  for (const s of BUILTIN_SETS_2D) {
    assert.ok(BUILTIN_SETS.some((b) => b.id === s.id), `${s.id} is a real set`);
    assert.equal(isFlatSet(s.id), true);
    assert.equal(isDirectional(s.id), false, `${s.id} must not be rotated by colour in 2D`);
  }
  assert.equal(isFlatSet('staunton'), false);
});

test('the 2D token: thin, wide, bezelled, and carrying a glyph card', () => {
  for (const color of ['white', 'black']) {
    for (const role of ROLES) {
      const t = createPiece(role, color, 'glyph', null);
      t.updateMatrixWorld(true);
      let bezel = null, card = null, disc = null, decal = null;
      t.traverse((o) => {
        if (!o.isMesh) return;
        if (o.userData.glyphCard) card = o;
        else if (o.userData.contactShadow) decal = o;
        else if (o.userData.accent) bezel = o;
        else disc = o;
      });
      assert.ok(disc && bezel && card && decal, `${color} ${role}: disc + bezel + card + decal`);
      assert.equal(bezel.userData.keepMaterial, true, 'the bezel is not repainted as a piece body');
      assert.equal(card.rotation.x, -Math.PI / 2, 'the card lies flat');
      assert.ok(card.position.y > 0.05, 'the card sits on top of the disc');
      assert.equal(card.material.toneMapped, false, 'the glyph never dims with exposure');
      assert.ok(card.material.transparent && card.material.alphaTest > 0, 'the glyph is cut out, not a square');
      const box = new THREE.Box3();
      t.traverse((o) => { if (o.isMesh && !o.userData.contactShadow) box.expandByObject(o); });
      assert.ok(box.max.y <= 0.10, `token thickness ${box.max.y.toFixed(3)} stays flat`);
      assert.ok(box.max.x - box.min.x >= 0.70, 'the token fills the square');
      assert.ok(box.max.x - box.min.x <= FOOTPRINT);
    }
  }
  // the token bezel must contrast with the disc: the accent tone is far from the piece tone
  const m = createMaterialSet('wood', null);
  const white = createPiece('king', 'white', 'glyph', m);
  let bez = null, body = null;
  white.traverse((o) => { if (o.isMesh) { if (o.userData.accent) bez = o; else if (!o.userData.contactShadow && !o.userData.glyphCard) body = o; } });
  const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  assert.ok(Math.abs(lum(bez.material.color) - lum(body.material.color)) > 0.4,
    'the white token bezel is far darker than the token');
  m.dispose();
});

test('the contact shadow pins itself to the board when the piece is lifted', () => {
  const piece = createPiece('queen', 'white', 'staunton', null);
  const decal = piece.userData.contactShadow;
  const group = new THREE.Group();
  group.add(piece);
  piece.position.set(1.5, 0.35, -2.5);            // layer.lift() raises the piece group
  group.updateMatrixWorld(true);
  assert.ok(decal.matrixWorld.elements[13] > 0.3, 'before the hook it would ride up with the piece');
  decal.onBeforeRender(null, null, null);         // the renderer calls this before deriving modelViewMatrix
  assert.ok(Math.abs(decal.matrixWorld.elements[13] - 0.0045) < 1e-6, 'the shadow stays on the board plane');
  // and its footprint is bigger than the piece base, so it reads as a halo around it
  const pieceBox = new THREE.Box3();
  piece.traverse((o) => { if (o.isMesh && !o.userData.contactShadow) pieceBox.expandByObject(o); });
  assert.ok(CONTACT_RADIUS.queen * 2 > (pieceBox.max.x - pieceBox.min.x) * 0.9, 'the halo shows around the base');
  for (const r of ROLES) assert.ok(CONTACT_RADIUS[r] * 2 <= FOOTPRINT, `${r} decal fits the square`);
});

test('applyMaterials assigns by colour, repaints accents/decals, respects keepMaterial', () => {
  const mats = createMaterialSet('wood', null);
  const w = createPiece('knight', 'white', 'staunton', mats);
  const b = createPiece('bishop', 'black', 'staunton', mats);
  const other = createMaterialSet('metal', null);
  applyMaterials(w, other); applyMaterials(b, other);
  w.traverse((o) => { if (o.isMesh) assert.equal(o.material, o.userData.keepMaterial ? o.material : other.whitePiece); });
  b.traverse((o) => { if (o.isMesh) assert.equal(o.material, o.userData.keepMaterial ? o.material : other.blackPiece); });
  let accents = 0, decals = 0;
  w.traverse((o) => {
    if (!o.isMesh) return;
    if (o.userData.accent) { accents++; assert.equal(o.material, other.whiteAccent, 'accents follow the theme'); }
    if (o.userData.contactShadow) { decals++; assert.equal(o.material, other.contactShadow, 'decals follow the theme'); }
  });
  assert.equal(accents, 4, 'knight eyes + nostrils keep an accent material');
  assert.equal(decals, 1);
  let bAccents = 0;
  b.traverse((o) => { if (o.isMesh && o.userData.accent) { bAccents++; assert.equal(o.material, other.blackAccent); } });
  assert.equal(bAccents, 1, 'the bishop slit');
  mats.dispose(); other.dispose();
});

test('material sets: themes, palettes, setPalette in place, dispose', () => {
  assert.deepEqual(THEMES, ['wood', 'metal', 'glass']);
  for (const t of THEMES) {
    assert.deepEqual(Object.keys(THEME_PALETTES[t]).sort(), ['black', 'dark', 'frame', 'light', 'white']);
    const m = createMaterialSet(t, null);
    assert.equal(m.theme, t);
    for (const k of ['lightSquare', 'darkSquare', 'frame', 'whitePiece', 'blackPiece', 'whiteAccent', 'blackAccent', 'contactShadow']) {
      assert.ok(m[k].isMaterial, `${t}.${k}`);
    }
    const before = m.lightSquare;
    m.setPalette({ light: '#FF0000' });
    assert.equal(m.lightSquare, before, 'no re-creation');
    assert.equal(m.lightSquare.color.getHexString(), 'ff0000');
    assert.equal(m.darkSquare.color.getHexString(), THEME_PALETTES[t].dark.slice(1).toLowerCase(), 'unset keys stay default');
    m.setPalette(null);
    assert.equal(m.lightSquare.color.getHexString(), THEME_PALETTES[t].light.slice(1).toLowerCase());
    m.dispose();
  }
  const g = createMaterialSet('glass', null);
  assert.equal(g.whitePiece.transmission, 1);
  assert.equal(g.lightSquare.transmission, 0, 'glass squares stay opaque so pieces read');
  assert.equal(g.whitePiece.depthWrite, true);
  g.dispose();
  assert.deepEqual(resolvePalette('wood', { dark: 'abcdef', bogus: '#000000', light: 'nope' }).dark, '#abcdef');
});

test('default palettes separate a white piece from a light square in every theme', () => {
  const lum = (hex) => { const c = new THREE.Color(hex).convertLinearToSRGB(); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };
  for (const t of THEMES) {
    const p = THEME_PALETTES[t];
    assert.ok(lum(p.white) - lum(p.light) >= 0.07, `${t}: white piece ${lum(p.white).toFixed(3)} vs light square ${lum(p.light).toFixed(3)}`);
    assert.ok(lum(p.light) - lum(p.dark) >= 0.28, `${t}: square contrast ${(lum(p.light) - lum(p.dark)).toFixed(3)}`);
    assert.ok(lum(p.light) - lum(p.black) >= 0.35, `${t}: black piece reads on a light square`);
  }
});

// ---------------------------------------------------------------------------------------------
// Lighting: the contrast aid and the unlit switch (addendum v1).

test('contrast aid: the rim patch hooks real three shader chunks and toggles without recompiling', () => {
  // if a three upgrade renames these chunks the rim silently stops working -- catch it here
  for (const id of ['standard', 'physical']) {
    assert.ok(THREE.ShaderLib[id].vertexShader.includes('#include <project_vertex>'), `${id}: vertex hook`);
    assert.ok(THREE.ShaderLib[id].fragmentShader.includes('#include <opaque_fragment>'), `${id}: fragment hook`);
  }
  assert.ok(THREE.ShaderChunk.defaultnormal_vertex.includes('vec3 transformedNormal'), 'transformedNormal is in scope');
  assert.ok(THREE.ShaderChunk.project_vertex.includes('vec4 mvPosition'), 'mvPosition is in scope');

  for (const theme of THEMES) {
    const m = createMaterialSet(theme, null);
    const pieceMats = [m.whitePiece, m.blackPiece, m.whiteAccent, m.blackAccent];
    for (const mat of pieceMats) assert.ok(mat.userData.rim, `${theme}: piece material carries rim uniforms`);
    for (const mat of [m.lightSquare, m.darkSquare, m.frame]) assert.equal(mat.userData.rim, undefined, `${theme}: squares are untouched`);
    // one program for all of them
    const keys = new Set(pieceMats.map((mat) => mat.customProgramCacheKey()));
    assert.equal(keys.size, 1, 'all piece materials share a program cache key');

    assert.equal(m.contrast, true, 'contrast defaults on');
    assert.ok(m.whitePiece.userData.rim.uRimAmount.value > 0.4, 'white pieces get a strong dark edge');
    assert.ok(m.blackPiece.userData.rim.uRimAmount.value > 0.2, 'black pieces get one too');
    assert.ok(m.contactShadow.opacity > 0.2, 'and a contact shadow');

    // the rim tone must actually contrast with the piece it edges
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    assert.ok(lum(m.whitePiece.color) - lum(m.whitePiece.userData.rim.uRimColor.value) > 0.3, `${theme}: white rim is darker`);
    assert.ok(lum(m.blackPiece.userData.rim.uRimColor.value) - lum(m.blackPiece.color) > 0.1, `${theme}: black rim is lighter`);

    const prog = m.whitePiece.customProgramCacheKey();
    m.setContrast(false);
    assert.equal(m.contrast, false);
    assert.equal(m.whitePiece.userData.rim.uRimAmount.value, 0, 'off means no rim');
    assert.equal(m.contactShadow.opacity, 0, 'and no decal');
    assert.equal(m.whitePiece.customProgramCacheKey(), prog, 'toggling contrast never changes the program');
    m.setContrast(true);
    assert.ok(m.whitePiece.userData.rim.uRimAmount.value > 0.4, 'back on');
    m.dispose();
  }
});

test('contrast aid: the injected GLSL lands in both stages', () => {
  const m = createMaterialSet('wood', null);
  const shader = {
    uniforms: {},
    vertexShader: '#define STANDARD\nvoid main() {\n#include <defaultnormal_vertex>\n#include <project_vertex>\n}\n',
    fragmentShader: '#define STANDARD\nvoid main() {\n#include <opaque_fragment>\n}\n',
  };
  m.whitePiece.onBeforeCompile.call(m.whitePiece, shader);
  assert.ok(shader.vertexShader.includes('varying vec3 vRimN;'), 'vertex varyings declared');
  assert.ok(shader.vertexShader.includes('vRimN = transformedNormal;'), 'vertex body injected');
  assert.ok(shader.vertexShader.includes('vRimV = - mvPosition.xyz;'));
  assert.ok(shader.fragmentShader.includes('uniform float uRimAmount;'), 'fragment uniforms declared');
  assert.ok(shader.fragmentShader.includes('outgoingLight = mix( outgoingLight, uRimColor,'), 'fragment body injected');
  assert.ok(shader.fragmentShader.indexOf('outgoingLight = mix') < shader.fragmentShader.indexOf('#include <opaque_fragment>'),
    'the rim is applied before the colour is written out');
  assert.equal(shader.uniforms.uRimAmount, m.whitePiece.userData.rim.uRimAmount, 'the uniform object is shared with the material');
  m.dispose();
});

test('contrast aid: a cloned piece material (pieceLayer cross-fades) keeps its rim', () => {
  // pieceLayer.beginFade() clones the shared material, and THREE.Material.copy() drops own-property
  // onBeforeCompile and JSON-flattens userData. A piece must not lose its edge mid cross-fade.
  for (const theme of THEMES) {
    const m = createMaterialSet(theme, null);
    for (const src of [m.whitePiece, m.blackPiece, m.whiteAccent, m.blackAccent]) {
      const clone = src.clone();
      clone.transparent = true; clone.depthWrite = false;      // what the layer does to it
      assert.notEqual(clone.onBeforeCompile, THREE.Material.prototype.onBeforeCompile, `${theme}: clone kept the patch`);
      assert.equal(clone.customProgramCacheKey(), src.customProgramCacheKey(), 'and shares the program');
      const shader = {
        uniforms: {},
        vertexShader: ['void main() {', '#include <defaultnormal_vertex>', '#include <project_vertex>', '}'].join('\n'),
        fragmentShader: ['void main() {', '#include <opaque_fragment>', '}'].join('\n'),
      };
      clone.onBeforeCompile(shader);
      assert.ok(shader.uniforms.uRimColor.value.isColor, 'the JSON-flattened colour was revived');
      assert.equal(shader.uniforms.uRimColor.value.getHexString(), src.userData.rim.uRimColor.value.getHexString(),
        `${theme}: the rim tone survived the clone`);
      assert.equal(shader.uniforms.uRimAmount.value, src.userData.rim.uRimAmount.value);
      assert.equal(shader.uniforms.uRimPower.value, src.userData.rim.uRimPower.value);
      assert.ok(shader.fragmentShader.includes('uRimAmount'), 'and the GLSL still lands');
      clone.dispose();
    }
    m.dispose();
  }
});

test('unlit switch: colours and palette survive, metal and glass do not go black', () => {
  for (const theme of THEMES) {
    const m = createMaterialSet(theme, null);
    const want = m.colors();
    const lit = {
      white: m.whitePiece.color.getHexString(),
      black: m.blackPiece.color.getHexString(),
      light: m.lightSquare.color.getHexString(),
      transmission: m.whitePiece.transmission,
      metalness: m.whitePiece.metalness,
      env: m.whitePiece.envMapIntensity,
      toneMapped: m.whitePiece.toneMapped,
    };
    assert.equal(lit.white, want.white.slice(1).toLowerCase());

    const ids = [m.whitePiece, m.blackPiece, m.lightSquare, m.darkSquare, m.frame].slice();
    m.setUnlit(true);
    assert.equal(m.unlit, true);
    assert.deepEqual([m.whitePiece, m.blackPiece, m.lightSquare, m.darkSquare, m.frame], ids, 'no material was replaced');
    for (const [mat, hex] of [[m.whitePiece, want.white], [m.blackPiece, want.black], [m.lightSquare, want.light],
      [m.darkSquare, want.dark], [m.frame, want.frame]]) {
      assert.equal(mat.emissive.getHexString(), hex.slice(1).toLowerCase(), `${theme}: colour moved into emissive intact`);
      assert.equal(mat.emissiveIntensity, 1);
      assert.equal(mat.color.getHexString(), '000000', 'diffuse off so nothing is lit twice');
      assert.equal(mat.toneMapped, false, 'flat mode is independent of exposure');
      assert.equal(mat.envMapIntensity, 0, 'the environment cannot darken it');
      if (mat.transmission !== undefined) assert.equal(mat.transmission, 0, `${theme}: glass goes flat, not invisible`);
      if (mat.metalness !== undefined) assert.equal(mat.metalness, 0, `${theme}: metal goes flat, not black`);
    }
    if (m.whitePiece.map) assert.equal(m.whitePiece.emissiveMap, m.whitePiece.map, 'maps still show through');
    // the contrast aid is untouched by the lighting mode
    assert.ok(m.whitePiece.userData.rim.uRimAmount.value > 0.4, 'the rim still runs with the lights off');
    assert.ok(m.contactShadow.opacity > 0.2, 'so does the contact shadow');

    // palette edits still work while unlit, and survive coming back
    m.setPalette({ white: '#123456' });
    assert.equal(m.whitePiece.emissive.getHexString(), '123456', 'live palette while unlit');
    m.setUnlit(false);
    assert.equal(m.unlit, false);
    assert.equal(m.whitePiece.color.getHexString(), '123456', 'the palette edit came back with the lights');
    assert.equal(m.whitePiece.emissive.getHexString(), '000000');
    assert.equal(m.whitePiece.transmission, lit.transmission, `${theme}: transmission restored`);
    assert.equal(m.whitePiece.metalness, lit.metalness, `${theme}: metalness restored`);
    assert.equal(m.whitePiece.envMapIntensity, lit.env);
    assert.equal(m.whitePiece.toneMapped, lit.toneMapped);
    m.setPalette(null);
    assert.equal(m.whitePiece.color.getHexString(), lit.white, 'and the defaults come back');
    assert.equal(m.lightSquare.color.getHexString(), lit.light);

    // idempotent both ways
    m.setUnlit(false); m.setUnlit(true); m.setUnlit(true);
    assert.equal(m.whitePiece.emissive.getHexString(), lit.white);
    m.setUnlit(false);
    assert.equal(m.whitePiece.color.getHexString(), lit.white);
    m.dispose();
  }
});

test('unlit switch, shape option (modelled sets): the baked occlusion survives the flat look', () => {
  // a glTF-style material: colour map, ORM texture in the roughness/metalness slots and as the aoMap
  const map = new THREE.Texture(), orm = new THREE.Texture();
  orm.channel = 0;
  const m = new THREE.MeshPhysicalMaterial({
    color: '#E8DCC8', map, roughnessMap: orm, metalnessMap: orm, aoMap: orm, aoMapIntensity: 0.8,
    roughness: 0.4, metalness: 0.1, clearcoat: 0.5, envMapIntensity: 1,
  });
  const colour = m.color.getHex();
  setMaterialUnlit(m, true, { shape: true });
  assert.equal(m.color.getHex(), colour, 'the colour stays in the diffuse slot (so AO can darken it)');
  assert.equal(m.emissive.getHex(), 0x000000, 'nothing is moved into emissive');
  assert.ok(m.lightMap && m.lightMap.image, 'a unit light map feeds the colour back as irradiance');
  assert.equal(m.lightMapIntensity, Math.PI, 'PI cancels the Lambert 1/PI: exactly the flat colour');
  assert.equal(m.aoMap, orm, 'the ORM occlusion, on its own uv channel');
  assert.equal(m.aoMapIntensity, 1);
  assert.equal(m.metalness, 0);
  assert.equal(m.clearcoat, 0);
  assert.equal(m.envMapIntensity, 0);
  assert.equal(m.toneMapped, false);
  setMaterialUnlit(m, false);
  assert.equal(m.lightMap, null, 'the light map goes away with the lights');
  assert.equal(m.aoMapIntensity, 0.8, 'and the authored AO strength comes back');
  assert.equal(m.metalness, 0.1);
  assert.equal(m.clearcoat, 0.5);

  // no occlusion texture at all: the plain emissive route, as for the theme materials
  const plain = new THREE.MeshStandardMaterial({ color: '#336699', map });
  setMaterialUnlit(plain, true, { shape: true });
  assert.equal(plain.lightMap, null);
  assert.equal(plain.emissive.getHexString(), '336699');
  setMaterialUnlit(plain, false);
  // an ORM that only sits in the roughness slot is still found
  const rOnly = new THREE.MeshStandardMaterial({ color: '#ffffff', roughnessMap: orm });
  setMaterialUnlit(rOnly, true, { shape: true });
  assert.equal(rOnly.aoMap, orm);
  setMaterialUnlit(rOnly, false);
  assert.equal(rOnly.aoMap, null);
  for (const x of [m, plain, rOnly]) x.dispose();
});

test('unlit metal: the patina is pulled to its mean, a gilt band and the non-metal are left alone', () => {
  // four bronze blotches (luma ~50..100), one gilt pixel far above them, one verdigris pixel that is not metal
  const px = new Uint8ClampedArray([
    120, 90, 55, 255, 70, 50, 30, 255, 150, 115, 70, 255, 95, 70, 42, 255,
    250, 210, 110, 255,
    40, 120, 110, 255,
  ]);
  const metal = new Uint8ClampedArray([0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 0, 255]);
  const luma = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
  const spread = () => Math.max(...[0, 4, 8, 12].map(luma)) - Math.min(...[0, 4, 8, 12].map(luma));
  const before = spread();
  const mean = flattenMetalPixels(px, metal);
  assert.ok(mean && luma(16) > mean[1] + 60, 'the gilt stays out of the mean');
  assert.ok(spread() < before * 0.3, `the blotches close up (${before.toFixed(0)} -> ${spread().toFixed(0)} luma levels)`);
  assert.deepEqual(Array.from(px.slice(16, 20)), [250, 210, 110, 255], 'the gilt keeps its colour');
  assert.deepEqual(Array.from(px.slice(20, 24)), [40, 120, 110, 255], 'the verdigris is not metal: untouched');
  assert.equal(flattenMetalPixels(new Uint8ClampedArray(8), new Uint8ClampedArray(8)), null, 'no metal, no change');

  // without a DOM the switch cannot build the flattened copy: the map is left as it is and comes back as it was
  const map = new THREE.Texture(), orm = new THREE.Texture();
  const m = new THREE.MeshPhysicalMaterial({ map, metalnessMap: orm, roughnessMap: orm, aoMap: orm, metalness: 1 });
  setMaterialUnlit(m, true, { shape: true, flatMetal: true });
  assert.equal(m.map, map);
  setMaterialUnlit(m, false);
  assert.equal(m.map, map);
  m.dispose();
});

test('the edge light is drawn on the outer silhouette only, fading in over the far half of the board', () => {
  const focus = 12;
  assert.equal(edgeFar(focus - 3, focus), 0, 'the near half: none');
  assert.equal(edgeFar(focus, focus), 0, 'the board centre: none');
  assert.equal(edgeFar(focus + FAR.start + FAR.ramp, focus), 1, 'the far ranks: full');
  const mid = edgeFar(focus + FAR.start + FAR.ramp / 2, focus);
  assert.ok(mid > 0 && mid < 1, 'a ramp between');
  assert.equal(edgeFar(2.5, -1), 0, 'a close-up (the camera inside the board, the piece 2.5 away): none');
  // no piece shader carries a back-light term any more: one could not tell an outline from a crease (critique r4)
  const m = createMaterialSet('wood');
  const shader = {
    uniforms: {},
    vertexShader: ['void main() {', '#include <project_vertex>', '}'].join('\n'),
    fragmentShader: ['void main() {', '#include <opaque_fragment>', '}'].join('\n'),
  };
  m.whitePiece.onBeforeCompile(shader);
  assert.ok(shader.fragmentShader.indexOf('uRimColor') > 0, 'the contrast rim is still patched in');
  assert.equal(shader.fragmentShader.indexOf('uBack'), -1, 'but no back-light term');
  m.dispose();
});

test('createMaterialSet honours the opts third argument', () => {
  const a = createMaterialSet('glass', null, { unlit: true, contrast: false });
  assert.equal(a.unlit, true);
  assert.equal(a.contrast, false);
  assert.equal(a.whitePiece.emissive.getHexString(), THEME_PALETTES.glass.white.slice(1).toLowerCase());
  assert.equal(a.whitePiece.userData.rim.uRimAmount.value, 0);
  assert.equal(a.contactShadow.opacity, 0);
  a.dispose();
  const b = createMaterialSet('wood', null);         // existing two-arg calls unchanged
  assert.equal(b.unlit, false);
  assert.equal(b.contrast, true);
  b.dispose();
});

test('glyphs: 12 cburnett bodies, ids, svg wrapper, data url, viewBox crop', () => {
  assert.equal(GLYPH_IDS.length, 12);
  for (const id of GLYPH_IDS) assert.ok(GLYPHS[id] && GLYPHS[id].includes('<path'), id);
  assert.equal(glyphId('knight', 'black'), 'bN');
  assert.equal(glyphId('king', 'white'), 'wK');
  const svg = glyphSvg('wQ', 128);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45" width="128" height="128">'));
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(glyphDataUrl('bP').startsWith('data:image/svg+xml;charset=utf-8,%3Csvg'));
  assert.ok(glyphSvg('wQ', 128, { viewBox: '4 4 37 37' }).includes('viewBox="4 4 37 37"'), 'the token crop is available');
  assert.deepEqual(glyphPiece('bN'), { role: 'knight', color: 'black' });
  assert.equal(glyphPiece('zz'), null);
  for (const id of GLYPH_IDS) assert.equal(glyphId(glyphPiece(id).role, glyphPiece(id).color), id, id + ' round-trips');
});

// ---------------------------------------------------------------------------------------------
// Piece layer reconcile (end states; tweens complete synchronously under node).

const ROLE_OF = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
function boardFromFen(fenBoard) {
  const out = [];
  const ranks = fenBoard.split('/');
  for (let ri = 0; ri < 8; ri++) {
    let f = 0;
    for (const ch of ranks[ri]) {
      if (/\d/.test(ch)) { f += parseInt(ch, 10); continue; }
      const square = 'abcdefgh'[f] + (8 - ri);
      out.push({ square, piece: { color: ch === ch.toUpperCase() ? 'white' : 'black', role: ROLE_OF[ch.toLowerCase()] } });
      f++;
    }
  }
  return out;
}
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';

function makeLayer() {
  const scene = new THREE.Scene();
  const mats = createMaterialSet('wood', null);
  const layer = createPieceLayer(scene, mats, { pieceSet: 'staunton', animations: true });
  return { scene, mats, layer };
}

test('layer: initial sync, coordinates, squareOf, pieceObjects', () => {
  const { scene, layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  assert.equal(layer.pieceObjects().length, 32);
  assert.equal(scene.children[0], layer.group);
  const k = layer.meshAt('e1');
  assert.deepEqual({ role: k.userData.role, color: k.userData.color, square: k.userData.square }, { role: 'king', color: 'white', square: 'e1' });
  assert.deepEqual(layer.worldFor('a1').toArray(), [-3.5, 0, 3.5]);
  assert.deepEqual(layer.worldFor('h8').toArray(), [3.5, 0, -3.5]);
  assert.deepEqual(k.position.toArray(), [0.5, 0, 3.5]);
  assert.equal(layer.worldFor('z9'), null);
  let child = null;
  k.traverse((o) => { if (o.isMesh && !child) child = o; });
  assert.equal(layer.squareOf(child), 'e1');
  assert.equal(layer.squareOf(layer.group), null);
  assert.equal(layer.meshAt('e4'), null);
  assert.equal(k.rotation.y, Math.PI, 'white pieces face -Z (toward Black)');
  assert.equal(layer.meshAt('e8').rotation.y, 0, 'black pieces face +Z');
  layer.dispose();
});

test('layer: animated move keeps mesh identity; capture removes the taken piece', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const pawn = layer.meshAt('e2');
  layer.sync(boardFromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'), { animateFrom: { from: 'e2', to: 'e4' } });
  assert.equal(layer.meshAt('e4'), pawn, 'same object slid');
  assert.equal(layer.meshAt('e2'), null);
  assert.equal(pawn.userData.square, 'e4');
  assert.deepEqual(pawn.position.toArray(), [0.5, 0, 0.5]);
  assert.equal(layer.pieceObjects().length, 32);
  // ... d5, then exd5
  layer.sync(boardFromFen('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR'), { animateFrom: { from: 'd7', to: 'd5' } });
  const black = layer.meshAt('d5');
  layer.sync(boardFromFen('rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR'), { animateFrom: { from: 'e4', to: 'd5', captured: 'pawn' } });
  assert.equal(layer.meshAt('d5'), pawn);
  assert.equal(black.parent, null, 'captured piece removed after its fade');
  assert.equal(layer.pieceObjects().length, 31);
  assert.equal(layer.isAnimating(), false);
  layer.dispose();
});

test('layer: castling slides the rook, promotion swaps the mesh, en passant clears the taken pawn', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen('r3k2r/8/8/8/8/8/8/R3K2R'), { instant: true });
  const rook = layer.meshAt('h1'), king = layer.meshAt('e1');
  layer.sync(boardFromFen('r3k2r/8/8/8/8/8/8/R4RK1'), { animateFrom: { from: 'e1', to: 'g1', castle: 'king' } });
  assert.equal(layer.meshAt('g1'), king);
  assert.equal(layer.meshAt('f1'), rook, 'rook mesh slid h1 -> f1');
  assert.equal(layer.meshAt('h1'), null);
  assert.deepEqual(rook.position.toArray(), [1.5, 0, 3.5]);

  // Chess960-style swap: king f1 -> g1 while the rook on g1 goes to f1
  layer.sync(boardFromFen('8/8/8/8/8/8/8/5KR1'), { instant: true });
  const k2 = layer.meshAt('f1'), r2 = layer.meshAt('g1');
  layer.sync(boardFromFen('8/8/8/8/8/8/8/5RK1'), { animateFrom: { from: 'f1', to: 'g1', castle: 'king' } });
  assert.equal(layer.meshAt('g1'), k2);
  assert.equal(layer.meshAt('f1'), r2);
  assert.equal(layer.pieceObjects().length, 2);

  // promotion
  layer.sync(boardFromFen('8/4P3/8/8/8/8/8/4K2k'), { instant: true });
  const p = layer.meshAt('e7');
  layer.sync(boardFromFen('4Q3/8/8/8/8/8/8/4K2k'), { animateFrom: { from: 'e7', to: 'e8', promotion: 'queen' } });
  const q = layer.meshAt('e8');
  assert.notEqual(q, p);
  assert.equal(q.userData.role, 'queen');
  assert.equal(p.parent, null);
  assert.equal(layer.pieceObjects().length, 3);

  // en passant: white pawn e5 takes d5 landing on d6
  layer.sync(boardFromFen('8/8/8/3pP3/8/8/8/4K2k'), { instant: true });
  const wp = layer.meshAt('e5'), bp = layer.meshAt('d5');
  layer.sync(boardFromFen('8/8/3P4/8/8/8/8/4K2k'), { animateFrom: { from: 'e5', to: 'd6', captured: 'pawn' } });
  assert.equal(layer.meshAt('d6'), wp);
  assert.equal(layer.meshAt('d5'), null);
  assert.equal(bp.parent, null);
  layer.dispose();
});

test('layer: animateFrom accepts the play() result shape and a UCI string; move right after a promotion', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const pawn = layer.meshAt('e2');
  // main.js passes the play() result: { node: { move }, captured, castle, promotion, ... }
  layer.sync(boardFromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'),
    { animateFrom: { node: { move: { from: 'e2', to: 'e4' } }, san: 'e4', captured: null, castle: null, promotion: null } });
  assert.equal(layer.meshAt('e4'), pawn);
  layer.sync(boardFromFen('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR'), { animateFrom: 'd7d5' });
  assert.equal(layer.meshAt('d5').userData.color, 'black');
  assert.equal(layer.meshAt('d7'), null);
  // promotion followed immediately by a queen move (the promoted mesh must be the one that slides)
  layer.sync(boardFromFen('8/4P3/8/8/8/8/8/4K2k'), { instant: true });
  layer.sync(boardFromFen('4Q3/8/8/8/8/8/8/4K2k'), { animateFrom: 'e7e8q' });
  const q = layer.meshAt('e8');
  assert.equal(q.userData.role, 'queen');
  layer.sync(boardFromFen('8/8/8/8/4Q3/8/8/4K2k'), { animateFrom: 'e8e4' });
  assert.equal(layer.meshAt('e4'), q, 'the queen mesh slid');
  assert.equal(layer.meshAt('e8'), null);
  assert.equal(layer.pieceObjects().length, 3);
  layer.dispose();
});

test('layer: lift / dragTo / drop, settle, setSet, setMaterials, setOrientation', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const n = layer.meshAt('g1');
  layer.lift('g1');
  assert.ok(Math.abs(n.position.y - 0.35) < 1e-9, 'lifted');
  layer.dragTo(new THREE.Vector3(-0.5, 0, 1.5));
  assert.deepEqual([n.position.x, n.position.z], [-0.5, 1.5]);
  layer.drop(null);
  assert.deepEqual(n.position.toArray(), [2.5, 0, 3.5], 'snapped back to g1');
  assert.equal(n.scale.x, 1);
  layer.lift('g1'); layer.dragTo(new THREE.Vector3(-0.5, 0, 1.5)); layer.drop('f3');
  assert.deepEqual(n.position.toArray(), [1.5, 0, 1.5], 'settled visually on f3');
  assert.equal(layer.meshAt('g1'), n, 'still keyed at its origin until sync');
  layer.settle();
  assert.deepEqual(n.position.toArray(), [2.5, 0, 3.5]);
  // drop then the real move arrives
  layer.lift('g1'); layer.drop('f3');
  layer.sync(boardFromFen('rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R'), { animateFrom: { from: 'g1', to: 'f3' } });
  assert.equal(layer.meshAt('f3'), n);
  assert.deepEqual(n.position.toArray(), [1.5, 0, 1.5]);

  layer.setSet('minimal');
  assert.equal(layer.currentSet(), 'minimal');
  assert.equal(layer.pieceObjects().length, 32);
  assert.equal(layer.meshAt('f3').userData.set, 'minimal');
  layer.setSet('does-not-exist');
  assert.equal(layer.currentSet(), 'staunton');

  const metal = createMaterialSet('metal', null);
  layer.setMaterials(metal);
  let ok = true;
  layer.meshAt('e1').traverse((o) => { if (o.isMesh && !o.userData.keepMaterial && o.material !== metal.whitePiece) ok = false; });
  assert.ok(ok, 'materials applied');

  layer.setSet('glyph');
  assert.equal(layer.meshAt('e1').rotation.y, 0, 'glyph cards do not rotate by colour');
  layer.setOrientation('black');
  assert.equal(layer.meshAt('e1').rotation.y, Math.PI, 'glyph cards flip for the black seat');
  layer.setOrientation('white');
  assert.equal(layer.meshAt('e8').rotation.y, 0);

  layer.setSquareMapper((sq) => new THREE.Vector3(0, 0, 0));
  assert.deepEqual(layer.meshAt('e1').position.toArray(), [0, 0, 0]);
  layer.setSquareMapper(null);
  assert.deepEqual(layer.meshAt('e1').position.toArray(), [0.5, 0, 3.5]);
  layer.dispose();
  metal.dispose();
});

// ---------------------------------------------------------------------------------------------
// Reviewed defects, 2026-09-18 (all five reproduced in node before the fix).

test('layer: Chess960 degenerate castling (core writes king -> own rook square) keeps the king mesh', () => {
  const { layer } = makeLayer();
  // Every shape core's _boundaryMove can emit when the king->king-destination form cannot exist:
  // the king is already on its destination, or one empty square away, so `to` is the ROOK's origin
  // and is empty afterwards. Taking `to` at face value faded the king out and popped a new one.
  const cases = [
    // [before, after, move, kingEnd, rookStart, rookEnd]
    ['5k2/8/8/8/8/8/8/5K1R', '5k2/8/8/8/8/8/8/5RK1', { from: 'f1', to: 'h1', castle: 'king' }, 'g1', 'h1', 'f1'],
    ['5k2/8/8/8/8/8/8/4R1KR', '5k2/8/8/8/8/8/8/4RRK1', { from: 'g1', to: 'h1', castle: 'king' }, 'g1', 'h1', 'f1'],
    ['5k2/8/8/8/8/8/8/RK6', '5k2/8/8/8/8/8/8/2KR4', { from: 'b1', to: 'a1', castle: 'queen' }, 'c1', 'a1', 'd1'],
    ['5k2/8/8/8/8/8/8/R2K4', '5k2/8/8/8/8/8/8/2KR4', { from: 'd1', to: 'a1', castle: 'queen' }, 'c1', 'a1', 'd1'],
    ['5k1r/8/8/8/8/8/8/5K2', '5rk1/8/8/8/8/8/8/5K2', { from: 'f8', to: 'h8', castle: 'king' }, 'g8', 'h8', 'f8'],
  ];
  for (const [before, after, mv, kingEnd, rookStart, rookEnd] of cases) {
    const label = mv.from + mv.to;
    layer.sync(boardFromFen(before), { instant: true });
    const king = layer.meshAt(mv.from);
    const rook = layer.meshAt(rookStart);
    const want = boardFromFen(after);
    layer.sync(want, { animateFrom: mv });
    assert.equal(layer.meshAt(kingEnd), king, label + ': the king mesh moved, it was not rebuilt');
    assert.notEqual(king.parent, null, label + ': the king was not faded out');
    assert.equal(layer.meshAt(rookEnd), rook, label + ': the rook mesh slid');
    assert.equal(layer.pieceObjects().length, want.length, label + ': no extra piece');
    assert.equal(layer.group.children.length, want.length, label + ': no orphan mesh left in the group');
    let kings = 0;
    layer.group.traverse((o) => { if (o.userData && o.userData.role === 'king') kings++; });
    assert.equal(kings, 2, label + ': exactly one king per side');
  }
  layer.dispose();
});

test('layer: Chess960 castling driven by the real core play() result', () => {
  // Kf1 / Rh1 with g1 empty: core emits { from:'f1', to:'h1' } because 'f1g1' is also a plain king move.
  const g = Game.fromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQ1K1R w Hh - 0 1', { variant: 'chess960' });
  const { layer } = makeLayer();
  layer.sync(g.pieces(), { instant: true });
  const king = layer.meshAt('f1'), rook = layer.meshAt('h1');
  // in Chess960 legalMoves also lists the king->rook form; 'f1g1' here is an ordinary king step
  const castle = g.legalMoves('f1').find((m) => m.to === 'h1');
  assert.ok(castle, 'the king->rook castling form is offered');
  const res = g.play(castle);
  assert.equal(res.castle, 'king');
  layer.sync(g.pieces(), { animateFrom: res });
  const pieces = g.pieces();
  assert.equal(layer.meshAt('g1'), king, 'king mesh survived the castle');
  assert.equal(layer.meshAt('f1'), rook, 'rook mesh survived the castle');
  assert.equal(layer.group.children.length, pieces.length, 'no orphan meshes');
  for (const { square, piece } of pieces) {
    const m = layer.meshAt(square);
    assert.ok(m && m.userData.role === piece.role && m.userData.color === piece.color,
      square + ' holds ' + piece.color + ' ' + piece.role);
  }
  layer.dispose();
});

test('layer: an animated sync re-seats a lifted NON-mover instead of leaving it hovering', () => {
  const { layer } = makeLayer();
  layer.sync(boardFromFen(START), { instant: true });
  const d2 = layer.meshAt('d2');
  layer.lift('d2');
  layer.dragTo(new THREE.Vector3(-1.2, 0, 0.3));
  // a different piece moves (engine / AI / a caller that syncs before cancelling the gesture)
  layer.sync(boardFromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR'), { animateFrom: { from: 'e2', to: 'e4' } });
  assert.deepEqual(d2.position.toArray(), [-0.5, 0, 2.5], 'the lifted bystander is back on d2');
  assert.equal(d2.scale.x, 1, 'and back to full scale');
  assert.equal(layer.meshAt('d2'), d2);
  layer.drop('d4');   // the gesture was cancelled by the sync: this must not move it
  assert.deepEqual(d2.position.toArray(), [-0.5, 0, 2.5]);
  // the MOVER being dragged is still fine: it slides from wherever the pointer left it
  const e7 = layer.meshAt('e7');
  layer.lift('e7');
  layer.dragTo(new THREE.Vector3(0.4, 0, 0.2));
  layer.sync(boardFromFen('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR'), { animateFrom: { from: 'e7', to: 'e5' } });
  assert.equal(layer.meshAt('e5'), e7);
  assert.deepEqual(e7.position.toArray(), [0.5, 0, -0.5]);
  layer.dispose();
});

test('layer: lift() during a promotion slide grabs the promoted piece, not the doomed pawn', () => {
  const frames = [];
  const hadRaf = 'requestAnimationFrame' in globalThis;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);   // keep tweens in flight
  globalThis.cancelAnimationFrame = () => {};
  try {
    const { layer } = makeLayer();
    layer.sync(boardFromFen('8/2P5/8/8/8/8/8/4K2k'), { instant: true });
    const pawn = layer.meshAt('c7');
    layer.sync(boardFromFen('2Q5/8/8/8/8/8/8/4K2k'), { animateFrom: { from: 'c7', to: 'c8', promotion: 'queen' } });
    assert.equal(layer.meshAt('c8'), pawn, 'mid-slide the square is still keyed to the pawn');
    layer.lift('c8');
    const q = layer.meshAt('c8');
    assert.equal(q.userData.role, 'queen', 'the slide finished and swapped in the queen');
    assert.equal(pawn.parent, null, 'the pawn was disposed');
    layer.dragTo(new THREE.Vector3(1.5, 0, 0.5));
    assert.equal(q.position.x, 1.5, 'the QUEEN follows the pointer');
    assert.equal(q.position.z, 0.5);
    assert.equal(q.position.y, 0.35);
    layer.drop('c8');
    for (const fn of frames.splice(0)) fn(1e6);   // run the drop tween to its end
    assert.deepEqual(q.position.toArray(), [-1.5, 0, -3.5], 'drop settles the queen on c8');
    assert.equal(layer.pieceObjects().length, 3);
    layer.dispose();
  } finally {
    if (!hadRaf) { delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame; }
  }
});

test('pieces: a failed glyph rasterise is not cached -- the next card retries', async () => {
  const savedImage = globalThis.Image, savedDoc = globalThis.document;
  let mode = 'fail';
  globalThis.Image = class {
    set src(_v) { queueMicrotask(() => (mode === 'fail' ? this.onerror(new Error('boom')) : this.onload())); }
  };
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }) };
  const warn = console.warn;
  console.warn = () => {};
  const tick = () => new Promise((r) => setTimeout(r, 5));
  try {
    await assert.rejects(getGlyphTexture('wN'), /failed to rasterise/);
    await tick();
    mode = 'ok';
    // the rejected promise must be gone from the cache, so the same id can succeed afterwards
    const tex = await getGlyphTexture('wN');
    assert.ok(tex && tex.isTexture, 'a later call rasterises successfully');
    // and a card built after a failure picks the texture up (glyphCardMaterial retries when map is null)
    createPiece('bishop', 'black', 'glyph', null);
    await tick();
    let card = null;
    createPiece('bishop', 'black', 'glyph', null).traverse((o) => { if (o.userData && o.userData.glyphCard) card = o; });
    assert.ok(card, 'glyph card present');
    assert.ok(card.material.map, 'the card material got its map');
    assert.equal(card.material.opacity, 1);
  } finally {
    console.warn = warn;
    if (savedImage === undefined) delete globalThis.Image; else globalThis.Image = savedImage;
    if (savedDoc === undefined) delete globalThis.document; else globalThis.document = savedDoc;
  }
});

test('materials: grain canvases are cached, textures stay per-set, setPalette still tints live', () => {
  const savedDoc = globalThis.document;
  const makeCanvas = () => ({
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData() {}, drawImage() {},
    }),
  });
  globalThis.document = { createElement: () => makeCanvas() };
  try {
    disposeMaterialCaches();
    const a = createMaterialSet('wood', null);
    const b = createMaterialSet('wood', { dark: '#123456' });
    assert.ok(a.lightSquare.map && b.lightSquare.map, 'both sets got grain maps');
    assert.notEqual(a.lightSquare.map, b.lightSquare.map, 'each set owns its own CanvasTexture');
    assert.equal(a.lightSquare.map.image, b.lightSquare.map.image, 'the expensive canvas is generated once and shared');
    assert.notEqual(a.lightSquare.map.image, a.darkSquare.map.image, 'different seeds still give different grain');

    // disposing one set must not free a texture the other is still using
    let freed = 0;
    b.lightSquare.map.addEventListener('dispose', () => { freed++; });
    a.dispose();
    assert.equal(freed, 0, 'a.dispose() left the other set texture alone');
    assert.ok(b.lightSquare.map.image, 'b still has its canvas');

    // setPalette recolours in place and keeps the map (the grain is a luminance map times .color)
    const map = b.lightSquare.map;
    b.setPalette({ light: '#FF0000' });
    assert.equal(b.lightSquare.map, map, 'setPalette does not touch the map');
    assert.equal(b.lightSquare.color.getHexString(), 'ff0000');
    b.dispose();
    assert.equal(freed, 1, 'b.dispose() freed its own texture');

    const m1 = createMaterialSet('metal', null), m2 = createMaterialSet('metal', null);
    assert.ok(m1.lightSquare.roughnessMap, 'metal keeps its brushed map');
    assert.notEqual(m1.lightSquare.roughnessMap, m2.lightSquare.roughnessMap);
    assert.equal(m1.lightSquare.roughnessMap.image, m2.lightSquare.roughnessMap.image, 'brushed canvas cached too');
    m1.dispose(); m2.dispose();
  } finally {
    disposeMaterialCaches();
    if (savedDoc === undefined) delete globalThis.document; else globalThis.document = savedDoc;
  }
});

test('geometry is shared across pieces of a set (theme / set switches must stay cheap)', () => {
  const a = createPiece('queen', 'white', 'staunton', null);
  const b = createPiece('queen', 'black', 'staunton', null);
  const geoA = [], geoB = [];
  a.traverse((o) => { if (o.isMesh) geoA.push(o.geometry); });
  b.traverse((o) => { if (o.isMesh) geoB.push(o.geometry); });
  assert.equal(geoA.length, geoB.length);
  for (let i = 0; i < geoA.length; i++) assert.equal(geoA[i], geoB[i], 'both colours share every geometry');
  // building a whole set twice allocates nothing new
  const before = new Set();
  for (const r of ROLES) createPiece(r, 'white', 'staunton', null).traverse((o) => { if (o.isMesh) before.add(o.geometry); });
  const after = new Set();
  for (const r of ROLES) createPiece(r, 'black', 'staunton', null).traverse((o) => { if (o.isMesh) after.add(o.geometry); });
  for (const g of after) assert.ok(before.has(g), 'second build reused the cache');

  const t0 = Date.now();
  for (let i = 0; i < 32; i++) createPiece(ROLES[i % 6], i % 2 ? 'white' : 'black', 'staunton', null);
  const ms = Date.now() - t0;
  console.log(`  rebuilding 32 cached staunton pieces: ${ms} ms`);
  assert.ok(ms < 400, `a full set rebuild stays cheap (${ms} ms)`);
});

test('2D token glyph: the contrast halo is composited when the 2d context supports it', async () => {
  const savedImage = globalThis.Image, savedDoc = globalThis.document;
  const calls = { draws: 0, fills: 0, composites: [], srcs: [] };
  globalThis.Image = class {
    set src(v) { calls.srcs.push(v); queueMicrotask(() => this.onload()); }
  };
  const ctx = () => ({
    _gco: 'source-over',
    get globalCompositeOperation() { return this._gco; },
    set globalCompositeOperation(v) { this._gco = v; calls.composites.push(v); },
    fillStyle: '',
    drawImage() { calls.draws++; },
    fillRect() { calls.fills++; },
    clearRect() {},
  });
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: ctx }) };
  try {
    const t = await getGlyphTexture('wK', 320, { halo: '#141009', haloWidth: 10, viewBox: '4 4 37 37' });
    assert.ok(t.isTexture, 'a token texture came back');
    assert.equal(t.colorSpace, THREE.SRGBColorSpace);
    assert.ok(calls.srcs[0].includes(encodeURIComponent('viewBox="4 4 37 37"')), 'the cropped viewBox reached the SVG');
    assert.ok(calls.composites.includes('source-in'), 'the silhouette was cut from the art');
    assert.equal(calls.fills, 1, 'the silhouette was flooded with the halo colour once');
    assert.equal(calls.draws, 1 + 16 + 1, 'silhouette + 2 rings of 8 offsets + the art on top');
    // a different halo is a different cache entry (white and black tokens must not share one)
    const other = await getGlyphTexture('wK', 320, { halo: '#F6F0E2', haloWidth: 10, viewBox: '4 4 37 37' });
    assert.notEqual(other, t, 'halo colour is part of the cache key');
    const again = await getGlyphTexture('wK', 320, { halo: '#141009', haloWidth: 10, viewBox: '4 4 37 37' });
    assert.equal(again, t, 'and the same request is cached');
  } finally {
    if (savedImage === undefined) delete globalThis.Image; else globalThis.Image = savedImage;
    if (savedDoc === undefined) delete globalThis.document; else globalThis.document = savedDoc;
  }
});

/** A minimal GLB: one tetrahedron per role node plus a black swatch, two materials (the white one emissive). */
function tinyModeledGlb(prefix) {
  const pos = new Float32Array([0, 0, 0, 0.2, 0, 0, 0, 0, 0.2, 0.05, 1, 0.05]);
  const idx = new Uint16Array([0, 1, 2, 0, 1, 3, 1, 2, 3, 2, 0, 3]);
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const names = [...ROLES.map((r) => prefix + r), prefix + 'swatch_black'];
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: names.map((_, i) => i) }],
    nodes: names.map((name, i) => ({ name, mesh: i === names.length - 1 ? 1 : 0, translation: [i * 2, 0, 0] })),
    meshes: [0, 1].map((material) => ({ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material }] })),
    materials: [
      { name: prefix + 'white', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.85, 0.8, 1] }, emissiveFactor: [1, 0.6, 0.3] },
      { name: prefix + 'black', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.1, 0.1, 1] } },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [0.2, 1, 0.2] },
      { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength },
      { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };
  const pad = (n) => (4 - (n % 4)) % 4;
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  jsonBytes = Uint8Array.from([...jsonBytes, ...new Array(pad(jsonBytes.length)).fill(0x20)]);
  const binBytes = Uint8Array.from([...bin, ...new Array(pad(bin.length)).fill(0)]);
  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true); dv.setUint32(16, 0x4E4F534A, true); out.set(jsonBytes, 20);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, binBytes.length, true); dv.setUint32(o + 4, 0x004E4942, true); out.set(binBytes, o + 8);
  return out.buffer;
}

test('modelled sets follow the theme: metal and glass over their own detail, wood gives back the very same materials', async () => {
  const prefix = 'tt_';
  const mapping = {};
  for (const r of ROLES) mapping[r] = prefix + r;
  await registerGltfSet({ id: 'theme-test', data: tinyModeledGlb(prefix), mapping, keepMaterials: true, blackFrom: prefix + 'swatch_black', keepOrigin: true, kind: 'model' });
  const meshOf = (piece) => { let m = null; piece.traverse((o) => { if (!m && o.isMesh && !o.userData.contactShadow) m = o; }); return m; };
  const wood = createMaterialSet('wood'), metal = createMaterialSet('metal'), glass = createMaterialSet('glass');
  try {
    const white = createPiece('king', 'white', 'theme-test', wood), black = createPiece('queen', 'black', 'theme-test', wood);
    const ownWhite = meshOf(white).material, ownBlack = meshOf(black).material;
    assert.equal(ownWhite.name, prefix + 'white', 'wood: the set wears its own baked material');
    assert.equal(ownBlack.name, prefix + 'black');
    ownWhite.normalMap = new THREE.Texture(); ownWhite.aoMap = new THREE.Texture();   // the baked detail to carry

    applyMaterials(white, metal); applyMaterials(black, metal);
    const mw = meshOf(white).material, mb = meshOf(black).material;
    assert.notEqual(mw, ownWhite, 'metal repaints the modelled set');
    assert.equal(mw.metalness, 1);
    assert.ok(mw.roughness > 0.3 && mb.roughness > 0.3, 'satin, not the theme pieces\u2019 mirror');
    assert.equal(mw.normalMap, ownWhite.normalMap, 'the sculpted detail comes along');
    assert.equal(mw.aoMap, ownWhite.aoMap, 'and the baked occlusion');
    assert.equal(mw.emissive.getHex(), 0x000000, 'no emission in the other themes');
    assert.equal(mw.userData.rim, metal.whitePiece.userData.rim, 'the theme piece rim: contrast and palette reach it');
    assert.equal(meshOf(createPiece('rook', 'white', 'theme-test', metal)).material, mw, 'a piece built in metal wears it too, shared');

    metal.setPalette({ white: '#ff0000' });
    assert.ok(mw.color.r > 0.9 && mw.color.g < 0.1, 'palette tints reach the modelled finish');
    metal.setUnlit(true);
    assert.ok(mw.userData.litBackup, 'the unlit switch reaches it');
    assert.equal(mw.aoMap, ownWhite.aoMap, 'keeping the occlusion in the flat look');
    metal.setUnlit(false);
    assert.equal(mw.metalness, 1);

    applyMaterials(white, glass);
    const gw = meshOf(white).material;
    assert.ok(gw.transmission > 0.9, 'glass: real transmission');
    assert.equal(gw.normalMap, ownWhite.normalMap);

    applyMaterials(white, wood); applyMaterials(black, wood);
    assert.equal(meshOf(white).material, ownWhite, 'wood gives back the exact baked material');
    assert.equal(meshOf(black).material, ownBlack);
    assert.equal(ownWhite.emissive.getHex() > 0, true, 'untouched: still its own emission');
  } finally {
    for (const m of [wood, metal, glass]) m.dispose();
    unregisterSet('theme-test');
  }
});

test('bishopCut: where the mitre cut of each set faces, null where there is none to turn', () => {
  assert.equal(bishopCut('staunton'), 0, 'the built-in slit faces +Z');
  for (const id of ['classic', 'beton', 'estate']) assert.equal(bishopCut(id), Math.PI / 2, `${id}: a side-entry cut, +X`);
  for (const id of ['cairn', 'menagerie', 'minimal', 'glyph', 'nope']) assert.equal(bishopCut(id), null, id);
});
