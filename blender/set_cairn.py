"""Cairn -- chess pieces balanced out of river stones, limestone against basalt, on slates."""
import math
import random
import bpy
import numpy as np
import cbkit as K

SET_ID = 'cairn'
COLL = 'set_cairn'
VS = 0.0024
TARGET = {'pawn': 0.58, 'rook': 0.72, 'knight': 0.84, 'bishop': 0.90, 'queen': 1.02, 'king': 1.18}
LOW_TRIS = {'pawn': 12000, 'rook': 18000, 'knight': 22000, 'bishop': 16000, 'queen': 20000, 'king': 20000}
SLATE_H = 0.026
WIDEN = 1.10           # the stacks are widened in plan to Staunton footprints (they read faster in a game)


# Stones

def _local(P, c, rot):
    x, y, z = K._sub(P, c)
    return K._rot(rot, x, y, z)


def _wear(P, seed, amp):
    # water-worn: the shape's irregularity is in the outline (harmonics), the surface itself is smooth
    return (K.noise3(P, scale=6.0, seed=seed, octaves=2) * np.float32(0.0016 * amp)
            + K.noise3(P, scale=70.0, seed=seed + 13, octaves=2) * np.float32(0.00025 * amp))


def slab_fn(c, rx, ry, h, rot, seed, edge=0.38, dome=0.18, wob=0.15, amp=1.0, taper=0.0, wedge=None, facet=None,
            rim=None, barrel=0.0):
    """A flat, water-worn stone with an irregular outline; tall and undomed it is a pillar stone."""
    rs = np.random.RandomState(seed)
    harm = [(k, rs.uniform(0.4, 1.0) * wob / k ** 0.7, rs.uniform(0, math.tau)) for k in (2, 3, 4, 5)]
    rmin = np.float32(min(rx, ry))
    e = np.float32(rim if rim is not None else min(edge * h / 2, 0.5 * min(rx, ry)))

    # a stone is rarely even: thicker on one side (wedge), often with a flat broken face (facet)
    wedge = rs.uniform(-0.28, 0.28) if wedge is None else wedge
    wa = rs.uniform(0, math.tau)
    if facet is None:
        facet = rs.uniform() < 0.55

    fa = rs.uniform(0, math.tau)
    fo = rs.uniform(0.72, 0.86)

    # spalls: small flat chips knocked off the rim, top or bottom edge
    chips = []

    for _ in range(0):                  # (tumbled stones carry no fresh spalls)
        a = rs.uniform(0, math.tau)
        t = math.radians(rs.uniform(28, 55))
        sg = 1.0 if rs.uniform() < 0.5 else -1.0
        Ra = 1.0 + sum(amp_k * math.cos(k * a + ph) for k, amp_k, ph in harm)
        pc = (rx * Ra * math.cos(a), ry * Ra * math.sin(a), sg * h / 2 * (1.0 - dome))
        n = (math.cos(a) * math.cos(t), math.sin(a) * math.cos(t), sg * math.sin(t))
        chips.append((n, n[0] * pc[0] + n[1] * pc[1] + n[2] * pc[2] - rs.uniform(0.005, 0.011)))

    def fn(P):
        x, y, z = _local(P, c, rot)
        if taper or barrel:
            zc = np.clip(z / np.float32(h / 2), -1.0, 1.0)
            s = (1.0 - np.float32(taper) * zc) * (1.0 + np.float32(barrel) * (1.0 - zc * zc))
            x, y = x / s, y / s

        u, v = x / np.float32(rx), y / np.float32(ry)
        rho = np.sqrt(u * u + v * v)
        th = np.arctan2(v, u)
        R = np.ones_like(rho)

        for k, a, ph in harm:
            R = R + np.float32(a) * np.cos(np.float32(k) * th + np.float32(ph))

        d2 = (rho - R) * rmin
        t = np.clip(rho / R, 0.0, 1.0)
        half = np.float32(h / 2) * (1.0 - np.float32(dome) * t * t)
        half = half * (1.0 + np.float32(wedge) * (u * np.float32(math.cos(wa)) + v * np.float32(math.sin(wa))))
        ax, az = d2 + e, np.abs(z) - half + e
        d = (np.sqrt(np.maximum(ax, 0) ** 2 + np.maximum(az, 0) ** 2)
             + np.minimum(np.maximum(ax, az), 0) - e)
        if facet:
            cut = (x * np.float32(math.cos(fa)) + y * np.float32(math.sin(fa))) - np.float32(fo * min(rx, ry))
            d = K.smax(d, cut, np.float32(0.006))

        for n, off in chips:
            d = K.smax(d, x * np.float32(n[0]) + y * np.float32(n[1]) + z * np.float32(n[2]) - np.float32(off), np.float32(0.002))

        return d + _wear(P, seed, amp)

    return fn


def pebble_fn(c, radii, rot, seed, amp=1.0, point=0.0):
    """A rounded pebble (ellipsoid), optionally egg-shaped: `point` narrows it toward local +Z."""
    rx, ry, rz = radii

    def fn(P):
        x, y, z = _local(P, c, rot)
        if point:
            s = 1.0 - np.float32(point) * np.clip(z / np.float32(rz), -1.0, 1.0)
            x, y = x / s, y / s

        d = K.sd_ellipsoid((x, y, z), (0, 0, 0), radii)

        return d + _wear(P, seed, amp)

    return fn


def bar_fn(c, half, rot, seed, r=0.008, amp=0.8, taper=0.0):
    """A worn stone bar or block (rounded box); taper narrows it toward local +Z."""
    def fn(P):
        x, y, z = _local(P, c, rot)
        if taper:
            s = 1.0 - np.float32(taper) * np.clip(z / np.float32(half[2]), -1.0, 1.0)
            x, y = x / s, y / s

        d = K.sd_box((x, y, z), (0, 0, 0), half, r=r)

        return d + _wear(P, seed, amp)

    return fn


def slate_fn(rx, ry, h, seed):
    """The flat slate a stack stands on: a broken outline with a thinner upper layer stepped back."""
    rs = np.random.RandomState(seed)

    def outline(scale, n):
        base = rs.uniform(0, math.tau)
        pts = []

        for i in range(n):
            a = base + (i + rs.uniform(-0.38, 0.38)) * math.tau / n
            f = rs.uniform(0.86, 1.03)
            if rs.uniform() < 0.25:
                f *= rs.uniform(0.84, 0.93)          # a bite out of the edge

            pts.append((rx * scale * f * math.cos(a), ry * scale * f * math.sin(a)))

        return pts

    lo, hi = (-rx * 1.1, -ry * 1.1), (rx * 1.1, ry * 1.1)
    layers = [(1.0, 29, 0.40), (0.94, 25, 0.33), (0.87, 23, 0.27)]      # (scale, outline points, share of h)
    fields = [K.Field2D(outline(sc, n), lo, hi, res=0.0007, pad=0.03) for sc, n, _ in layers]

    def fn(P):
        d = None
        z = 0.0

        for f, (_, _, share) in zip(fields, layers):
            t = h * share
            dl = K.sd_extrude(P, f, t / 2 + 0.0012, round_r=0.0018, axis='Z', c=(0, 0, z + t / 2 - 0.0012 * (z > 0)))
            d = dl if d is None else np.minimum(d, dl)
            z += t

        return d + _wear(P, seed, 0.25)

    return fn


class Cairn:
    """A stack built bottom-up; self.z is the top so far."""

    def __init__(self, g, seed):
        self.g = g
        self.d = g.empty()
        self.rng = random.Random(seed)
        self.stones = []          # (fn, centre, rot, kind, tone) -- kind 1.0 marks the slate; tone None = random
        self.z = 0.0

    def add(self, fn, c, rot, reach, kind=0.0, k=0.0, tone=None):
        lo = [c[0] - reach, c[1] - reach, c[2] - reach]
        hi = [c[0] + reach, c[1] + reach, c[2] + reach]
        self.d = self.g.add(self.d, fn, lo, hi, k)
        self.stones.append((fn, c, np.asarray(rot, dtype=np.float32), kind, tone))

    def slate(self, rx, ry):
        self.add(slate_fn(rx, ry, SLATE_H, self.rng.randint(1, 10 ** 6)), (0, 0, SLATE_H / 2), np.eye(3),
                 max(rx, ry) * 1.15, kind=1.0)
        self.z = SLATE_H

    def slab(self, rx, ry, h, tilt=5.0, off=0.017, sink=0.008, **kw):
        rng = self.rng
        rot = K.rot_matrix([('Z', rng.uniform(0, 180)), ('X', rng.uniform(-tilt, tilt)), ('Y', rng.uniform(-tilt, tilt))])
        c = (rng.uniform(-off, off), rng.uniform(-off, off), self.z + h / 2 - sink)
        kw.setdefault('edge', rng.uniform(0.24, 0.55))
        self.add(slab_fn(c, rx, ry, h, rot, rng.randint(1, 10 ** 6), **kw), c, rot, max(max(rx, ry) * 1.3, h * 0.6) + 0.01)
        self.z = c[2] + h / 2

        return c

    def pebble(self, c, radii, tilt=3.0, point=0.0, amp=1.0, rot=None):
        rng = self.rng
        if rot is None:
            rot = K.rot_matrix([('Z', rng.uniform(0, 180)), ('X', rng.uniform(-tilt, tilt)), ('Y', rng.uniform(-tilt, tilt))])

        self.add(pebble_fn(c, radii, rot, rng.randint(1, 10 ** 6), amp, point), c, rot, max(radii) * 1.35 + 0.01)

        return c

    def bar(self, c, half, rot, r=0.008, taper=0.0):
        self.add(bar_fn(c, half, rot, self.rng.randint(1, 10 ** 6), r=r, taper=taper), c, rot,
                 max(half) * 1.5 + 0.01)
        return c

    def body(self, slate, spec, top_h, target):
        """The slate, then body stones sharing the target height left after a top of height top_h."""
        self.slate(*slate)
        sink = 0.008
        avail = target - self.z - top_h + sink * len(spec)
        tot = sum(s[2] for s in spec)

        for s in spec:
            kw = s[3] if len(s) > 3 else {}
            self.slab(s[0], s[1], avail * s[2] / tot, sink=sink, **kw)

        return self.z


def stone_attributes(ob, stones, seed):
    """Per-face 'tone' and 'kind', and per-corner 'lp' in each stone's own frame."""
    me = ob.data
    nf = len(me.polygons)

    C = np.empty(nf * 3, dtype=np.float32)
    me.polygons.foreach_get('center', C)
    C = C.reshape(-1, 3)

    P = (C[:, 0], C[:, 1], C[:, 2])
    D = np.stack([st[0](P) for st in stones], axis=1)
    idx = np.argmin(D, axis=1)

    rs = np.random.RandomState(seed)
    tones = rs.uniform(0, 1, len(stones)).astype(np.float32)

    for j, st in enumerate(stones):
        if st[4] is not None:
            tones[j] = st[4]

    offs = rs.uniform(-40, 40, (len(stones), 3)).astype(np.float32)
    kinds = np.array([s[3] for s in stones], dtype=np.float32)

    K.set_attribute(ob, 'tone', tones[idx], domain='FACE')
    K.set_attribute(ob, 'kind', kinds[idx], domain='FACE')

    nl = len(me.loops)
    vi = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get('vertex_index', vi)

    tot = np.empty(nf, dtype=np.int64)
    me.polygons.foreach_get('loop_total', tot)
    face_of_loop = np.repeat(np.arange(nf), tot)

    V = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', V)
    V = V.reshape(-1, 3)

    lp = np.zeros((nl, 3), dtype=np.float32)
    sid = idx[face_of_loop]

    for j, (fn, c, rot, kind, _t) in enumerate(stones):
        m = sid == j
        if m.any():
            lp[m] = (V[vi[m]] - np.asarray(c, dtype=np.float32)) @ rot.T + offs[j]

    a = me.attributes.get('lp') or me.attributes.new('lp', 'FLOAT_VECTOR', 'CORNER')
    a.data.foreach_set('vector', lp.ravel())


def _assert_one_piece(ob):
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    me = ob.data
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get('vertices', e)
    e = e.reshape(-1, 2)
    n = len(me.vertices)
    k, lab = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)), directed=False)
    if k > 1:
        raise RuntimeError('%s is in %d separate parts (sizes %s): a stone is floating' % (ob.name, k, np.bincount(lab).tolist()))


def finish(g, cn, role, coll, seed):
    d = np.maximum(cn.d, np.float32(0.0) - g.Z)          # flat underside on the board
    ob = g.to_mesh(d, SET_ID + '_' + role, coll)
    K.keep_largest_parts(ob, 0.004)
    _assert_one_piece(ob)
    K.decimate(ob, target_tris=300000)
    stone_attributes(ob, cn.stones, seed)

    # land the top exactly on the chess height (a uniform scale of a few percent at most), and widen the plan
    top = float(K.bounds(ob)[1][2])
    s = TARGET[role] / top

    V = np.empty(len(ob.data.vertices) * 3, dtype=np.float32)
    ob.data.vertices.foreach_get('co', V)
    V = V.reshape(-1, 3) * np.float32(s)
    V[:, :2] *= np.float32(WIDEN)

    ob.data.vertices.foreach_set('co', V.ravel())
    ob.data.update()
    ob.data.shade_smooth()

    ob['fit_scale'] = s

    return ob


# Pieces

TOPSLAB = {'facet': False, 'wedge': 0.0, 'dome': 0.08, 'tilt': 2.0}   # a slab that carries a ring of stones
PILLAR = {'dome': 0.0, 'rim': 0.028, 'wob': 0.16, 'taper': 0.12, 'barrel': 0.08, 'tilt': 2.0, 'wedge': 0.0, 'facet': False}


def pawn(coll):
    g = K.Grid((-0.23, -0.23, -0.01), (0.23, 0.23, 0.64), VS)
    cn = Cairn(g, 21)
    z = cn.body((0.196, 0.182), [(0.152, 0.136, 1.0), (0.116, 0.106, 0.9), (0.098, 0.090, 0.85), (0.124, 0.114, 0.6)],
                0.232, TARGET['pawn'])
    cn.pebble((0.004, -0.003, z + 0.110), (0.121, 0.115, 0.118), tilt=4)

    return finish(g, cn, 'pawn', coll, 1)


def rook(coll):
    g = K.Grid((-0.26, -0.26, -0.01), (0.26, 0.26, 0.78), VS)
    cn = Cairn(g, 22)
    z = cn.body((0.236, 0.220), [(0.196, 0.178, 1.1), (0.160, 0.150, 1.0), (0.150, 0.140, 0.9),
                                 (0.184, 0.174, 0.55, TOPSLAB)],
                0.090, TARGET['rook'])

    # battlements: five upright blocks round the rim of the top slab, each turned to face out, leaning out
    base = cn.rng.uniform(0, 72)

    for i in range(5):
        a = math.radians(base + i * 72 + cn.rng.uniform(-6, 6))
        rr = 0.124 + cn.rng.uniform(-0.006, 0.006)
        h = 0.046 + cn.rng.uniform(-0.004, 0.005)
        rot = K.rot_matrix([('X', cn.rng.uniform(4, 9)), ('Z', math.degrees(a) + 90)])
        cn.bar((rr * math.cos(a), rr * math.sin(a), z + h - 0.012), (0.044, 0.026, h), rot, r=0.010, taper=0.08)

    return finish(g, cn, 'rook', coll, 2)


HORSE = [(-0.108, 0.000), (0.098, 0.000), (0.110, 0.060), (0.106, 0.118), (0.092, 0.160), (0.118, 0.178),
         (0.166, 0.192), (0.204, 0.212), (0.224, 0.240), (0.218, 0.272), (0.184, 0.298), (0.124, 0.334),
         (0.078, 0.364), (0.058, 0.396), (0.044, 0.424), (0.024, 0.398), (-0.018, 0.382), (-0.070, 0.348),
         (-0.114, 0.284), (-0.134, 0.192), (-0.130, 0.090), (-0.120, 0.030)]


def knight(coll):
    g = K.Grid((-0.24, -0.27, -0.01), (0.24, 0.24, 0.90), VS)
    cn = Cairn(g, 23)
    head_h = 0.424
    z = cn.body((0.214, 0.200), [(0.172, 0.158, 1.0), (0.140, 0.128, 0.9), (0.118, 0.108, 0.85), (0.146, 0.134, 0.6)],
                head_h - 0.006, TARGET['knight'])
    z0 = z - 0.006

    # a found stone shaped like a horse's head, authored with the muzzle along -Y
    sil = [(x, z0 + zz) for x, zz in HORSE]
    xs = [p[0] for p in sil]
    zs = [p[1] for p in sil]
    field = K.Field2D(sil, (min(xs), min(zs)), (max(xs), max(zs)), res=0.0008, pad=0.06)
    MANE = [(-0.116, 0, z0 + 0.05), (-0.126, 0, z0 + 0.15), (-0.116, 0, z0 + 0.245), (-0.088, 0, z0 + 0.312),
            (-0.046, 0, z0 + 0.356), (-0.004, 0, z0 + 0.381)]
    locks = []
    mp = [(0.0, -m[0], m[2]) for m in MANE]
    seg = [math.dist(mp[k], mp[k + 1]) for k in range(len(mp) - 1)]

    for i in range(9):
        dist = (0.10 + i * 0.105) * sum(seg)
        k = 0

        while k < len(seg) - 1 and dist > seg[k]:
            dist -= seg[k]
            k += 1

        f = min(dist / seg[k], 1.0)
        a = tuple(mp[k][q] + (mp[k + 1][q] - mp[k][q]) * f for q in range(3))
        tY, tZ = (mp[k + 1][1] - mp[k][1]) / seg[k], (mp[k + 1][2] - mp[k][2]) / seg[k]

        # push each lock out from the back of the neck (the path climbs toward -Y, so (tZ, -tY) points out)
        out = (tZ, -tY)
        side = 0.009 * (1 if i % 2 else -1)
        c = (side, a[1] + 0.008 * out[0], a[2] + 0.008 * out[1])
        rot = K.rot_matrix([('Y', 8 if i % 2 else -8), ('X', math.degrees(math.atan2(-tY, tZ)))])
        locks.append((c, rot, (0.021, 0.016, 0.034)))

    def head(P):
        X, Y, Z = P
        hx, hy = -Y, X
        zr = Z - np.float32(z0)
        up = np.clip((zr - 0.15) / 0.10, 0, 1)
        fwd = np.clip((hx - 0.05) / 0.17, 0, 1)
        half = (0.074 * (1 - up) + up * (0.066 - 0.024 * fwd)).astype(np.float32)
        d = K.sd_inflate((hx, hy, Z), field, half, depth=0.055, axis='Y')

        for s in (-1, 1):
            d = K.smin(d, K.sd_ellipsoid((hx, hy, Z), (0.086, s * 0.040, z0 + 0.212), (0.050, 0.030, 0.046)), 0.02)

        ridge = K.sd_chain((hx, hy, Z), MANE, [0.019, 0.022, 0.022, 0.020, 0.017, 0.014], k=0.01)
        d = K.smin(d, ridge, 0.012)

        for lc, lrot, lr in locks:
            d = K.smin(d, K.sd_ellipsoid(P, lc, lr, lrot), 0.006)

        return d + _wear(P, 91, 1.1)

    hc = (0.0, 0.0, z0 + 0.2)
    cn.add(head, hc, np.eye(3), 0.36, k=0.0015, tone=0.25)

    # the ear notch (seen from behind: two ears), eye dimples, a mouth line -- no nostril holes
    cn.d = g.add(cn.d, lambda P: K.sd_box(P, (0, -0.036, z0 + 0.43), (0.015, 0.034, 0.058), r=0.004),
                 (-0.03, -0.09, z0 + 0.36), (0.03, 0.01, z0 + 0.49), 0.006, 'sub')
    for s in (-1, 1):
        cn.d = g.add(cn.d, lambda P, s=s: K.sd_sphere(P, (s * 0.058, -0.108, z0 + 0.318), 0.017),
                     (s * 0.058 - 0.04, -0.15, z0 + 0.28), (s * 0.058 + 0.04, -0.07, z0 + 0.36), 0.006, 'sub')
        cn.d = g.add(cn.d, lambda P, s=s: K.sd_capsule(P, (s * 0.030, -0.228, z0 + 0.236), (s * 0.042, -0.170, z0 + 0.222), 0.0055),
                     (s * 0.036 - 0.03, -0.25, z0 + 0.2), (s * 0.036 + 0.03, -0.15, z0 + 0.26), 0.003, 'sub')

    return finish(g, cn, 'knight', coll, 3)


def bishop(coll):
    g = K.Grid((-0.23, -0.23, -0.01), (0.23, 0.23, 0.96), VS)
    cn = Cairn(g, 24)
    top_h = 0.372
    z = cn.body((0.206, 0.192), [(0.160, 0.146, 1.0), (0.122, 0.112, 0.85), (0.088, 0.082, 2.1, PILLAR), (0.124, 0.114, 0.6)],
                top_h, TARGET['bishop'])

    # the mitre: a tall egg-stone with a deep cleft worn through it (seen from both sides), a pebble on top
    ez = z + 0.152
    cn.pebble((0.0, 0.0, ez), (0.098, 0.094, 0.158), tilt=2, point=0.22)
    cn.d = g.add(cn.d, lambda P: K.sd_box(P, (0.018, 0.0, ez + 0.070), (0.015, 0.16, 0.090), r=0.005, rot=K.rot_matrix([('Y', 38)])),
                 (-0.12, -0.2, ez - 0.06), (0.16, 0.2, ez + 0.2), 0.005, 'sub')
    cn.pebble((0.0, 0.0, ez + 0.176), (0.036, 0.035, 0.033), tilt=4)

    return finish(g, cn, 'bishop', coll, 4)


def queen(coll):
    g = K.Grid((-0.25, -0.25, -0.01), (0.25, 0.25, 1.08), VS)
    cn = Cairn(g, 25)
    top_h = 0.176
    z = cn.body((0.222, 0.208), [(0.176, 0.160, 1.0), (0.142, 0.130, 0.85), (0.112, 0.104, 0.75), (0.092, 0.086, 2.2, PILLAR),
                                 (0.124, 0.114, 0.5), (0.154, 0.144, 0.42, TOPSLAB)], top_h, TARGET['queen'])

    # the coronet: pointed stones standing round the rim, leaning out, a pebble raised in the middle
    for i in range(8):
        a = i * math.tau / 8 + cn.rng.uniform(-0.08, 0.08)
        rr = 0.112
        rot = K.rot_matrix([('Y', cn.rng.uniform(10, 16)), ('Z', math.degrees(a))])
        cn.pebble((rr * math.cos(a), rr * math.sin(a), z + 0.040), (0.026, 0.024, 0.052), rot=rot, point=0.35, amp=0.6)

    cn.pebble((0.0, 0.0, z + 0.030), (0.064, 0.060, 0.040), tilt=3)
    cn.pebble((0.0, 0.0, z + 0.118), (0.058, 0.056, 0.056), tilt=3)

    return finish(g, cn, 'queen', coll, 5)


def king(coll):
    g = K.Grid((-0.26, -0.26, -0.01), (0.26, 0.26, 1.25), VS)
    cn = Cairn(g, 26)
    top_h = 0.250
    z = cn.body((0.234, 0.218), [(0.184, 0.168, 1.0), (0.148, 0.136, 0.85), (0.118, 0.108, 0.75), (0.098, 0.092, 2.4, PILLAR),
                                 (0.134, 0.124, 0.5), (0.096, 0.090, 0.42)], top_h, TARGET['king'])

    # a cross of two stone bars, the upright bedded into the cap stone, the arm balanced across it
    cz = z - 0.012
    cn.bar((0.0, 0.0, cz + 0.130), (0.026, 0.021, 0.132), K.rot_matrix([('Z', 2), ('Y', 1.5)]), r=0.009, taper=0.06)
    cn.bar((0.0, 0.0, cz + 0.184), (0.090, 0.022, 0.024), K.rot_matrix([('Y', 2.5), ('Z', -1.5)]), r=0.009)

    return finish(g, cn, 'king', coll, 6)


BUILDERS = {'pawn': pawn, 'knight': knight, 'bishop': bishop, 'rook': rook, 'queen': queen, 'king': king}


def model(roles=None):
    coll = K.collection(COLL, clear=roles is None)
    out = {}

    for role in roles or K.ROLES:
        for nm in (SET_ID + '_' + role, SET_ID + '_' + role + '_hi'):
            old = bpy.data.objects.get(nm)
            if old:
                K.remove(old)

        out[role] = BUILDERS[role](coll)

    return {r: (K.tri_count(o), [round(float(v), 3) for v in K.bounds(o)[1]], round(o['fit_scale'], 3))
            for r, o in out.items()}


def pieces():
    return [bpy.data.objects[SET_ID + '_' + r] for r in K.ROLES if bpy.data.objects.get(SET_ID + '_' + r)]


def preview(path=None, angle=-35):
    K.preview_scene()
    objs = pieces()

    for i, o in enumerate(objs):
        o.location = ((i - (len(objs) - 1) / 2) * 0.62, 0, 0)
        o.rotation_euler.z = math.radians(angle)

    m, N, bsdf, _ = K.new_material('__clay')
    bsdf.inputs['Base Color'].default_value = (0.70, 0.68, 0.64, 1)
    bsdf.inputs['Roughness'].default_value = 0.6

    for o in objs:
        K.assign(o, m)

    path = path or K.WORK + '/cairn/preview_shapes.png'
    K.render_preview(path, (0.6, -5.4, 1.9), (0.0, 0.0, 0.56), lens=50, res=(1800, 1000), samples=32, only=objs)

    for o in objs:
        o.rotation_euler.z = 0.0
        o.location = (0, 0, 0)

    return path


def preview_mat(path=None, color='white', angle=-35):
    """The sculpted pieces with the procedural material, before any bake (fast material iteration)."""
    K.preview_scene()
    objs = pieces()
    mats = materials()

    for i, o in enumerate(objs):
        o.location = ((i - (len(objs) - 1) / 2) * 0.62, 0, 0)
        o.rotation_euler.z = math.radians(angle)
        K.assign(o, mats[color])

    path = path or K.WORK + '/cairn/preview_mat_%s.png' % color
    K.render_preview(path, (0.6, -5.4, 1.9), (0.0, 0.0, 0.56), lens=50, res=(1800, 1000), samples=48, only=objs)

    for o in objs:
        o.rotation_euler.z = 0.0
        o.location = (0, 0, 0)

    return path


# Materials

def lin(hexstr):
    h = hexstr.lstrip('#')
    out = []

    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)

    return tuple(out)


def _ramp(N, fac, colors, interpolation='CONSTANT'):
    r = N.n('ShaderNodeValToRGB')
    cr = r.color_ramp
    cr.interpolation = interpolation
    n = len(colors)

    while len(cr.elements) < n:
        cr.elements.new(0.5)

    for i, col in enumerate(colors):
        cr.elements[i].position = i / n
        cr.elements[i].color = (*col, 1)

    N.link(fac, r.inputs['Fac'])

    return r.outputs['Color']


def _math(N, op, a, b=None, clamp=False):
    m = N.n('ShaderNodeMath', operation=op, use_clamp=clamp)

    for i, v in enumerate((a, b)):
        if v is None:
            continue

        if isinstance(v, (int, float)):
            m.inputs[i].default_value = v
        else:
            N.link(v, m.inputs[i])

    return m.outputs['Value']


def _map(N, v, a, b, c, d, clamp=True):
    m = N.n('ShaderNodeMapRange', i_From_Min=a, i_From_Max=b, i_To_Min=c, i_To_Max=d, clamp=clamp)
    N.link(v, m.inputs['Value'])
    return m.outputs['Result']


def _mix(N, fac, a, b):
    m = N.n('ShaderNodeMix', data_type='RGBA', blend_type='MIX', clamp_factor=True)
    if isinstance(fac, (int, float)):
        m.inputs['Factor'].default_value = fac
    else:
        N.link(fac, m.inputs['Factor'])

    for sock, v in ((m.inputs[6], a), (m.inputs[7], b)):
        if isinstance(v, tuple):
            sock.default_value = (*v, 1) if len(v) == 3 else v
        else:
            N.link(v, sock)

    return m.outputs[2]


def _mul(N, col, fac):
    m = N.n('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', clamp_factor=True)
    m.inputs['Factor'].default_value = 1.0
    N.link(col, m.inputs[6])
    if isinstance(fac, tuple):
        m.inputs[7].default_value = (*fac, 1)
    else:
        cc = N.n('ShaderNodeCombineColor')
        for ch in ('Red', 'Green', 'Blue'):
            N.link(fac, cc.inputs[ch])
        N.link(cc.outputs['Color'], m.inputs[7])

    return m.outputs[2]


def _stone(name, palette, slate, grain, grain_amt, pit, vein, vein_amt, stain, stain_amt, moss, moss_amt, lichen,
           lichen_amt, rough, band_amt):
    m, N, bsdf, out = K.new_material(name)

    tone = N.n('ShaderNodeAttribute', attribute_name='tone', attribute_type='GEOMETRY').outputs['Fac']
    kind = N.n('ShaderNodeAttribute', attribute_name='kind', attribute_type='GEOMETRY').outputs['Fac']
    lp = N.n('ShaderNodeAttribute', attribute_name='lp', attribute_type='GEOMETRY').outputs['Vector']
    stone = _map(N, kind, 0.4, 0.6, 1.0, 0.0)

    # every stone its own colour from the palette, mottled inside at two scales
    col = _ramp(N, tone, palette)

    mot = N.n('ShaderNodeTexNoise', i_Scale=3.0, i_Detail=4.0, i_Roughness=0.55)
    N.link(lp, mot.inputs['Vector'])
    col = _mul(N, col, _map(N, mot.outputs['Fac'], 0.32, 0.68, 0.76, 1.18))

    mot2 = N.n('ShaderNodeTexNoise', i_Scale=13.0, i_Detail=6.0, i_Roughness=0.6)
    N.link(lp, mot2.inputs['Vector'])
    col = _mul(N, col, _map(N, mot2.outputs['Fac'], 0.3, 0.7, 0.85, 1.10))

    mot3 = N.n('ShaderNodeTexNoise', i_Scale=38.0, i_Detail=4.0, i_Roughness=0.55)
    N.link(lp, mot3.inputs['Vector'])
    col = _mul(N, col, _map(N, mot3.outputs['Fac'], 0.3, 0.7, 0.95, 1.05))

    # bedding: fine bands through each stone's thickness (its local Z), warped
    wav = N.n('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Z', i_Scale=7.0, i_Distortion=6.0,
              i_Detail=3.0, i_Detail_Scale=0.8)
    N.link(lp, wav.inputs['Vector'])
    col = _mul(N, col, _map(N, wav.outputs['Fac'], 0.0, 1.0, 1.0 - band_amt, 1.0 + band_amt * 0.3))

    # iron staining in soft patches
    stn = N.n('ShaderNodeTexNoise', i_Scale=4.5, i_Detail=5.0, i_Roughness=0.6)
    N.link(lp, stn.inputs['Vector'])
    col = _mix(N, _math(N, 'MULTIPLY', _map(N, stn.outputs['Fac'], 0.56, 0.70, 0.0, 1.0), stain_amt), col, stain)

    # the slate under the stack: its own colour, fine layering
    swav = N.n('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Z', i_Scale=30.0, i_Distortion=3.0, i_Detail=2.0)
    N.link(lp, swav.inputs['Vector'])
    scol = _mul(N, _mul(N, _mix(N, 0.0, slate, slate), _map(N, mot2.outputs['Fac'], 0.3, 0.7, 0.9, 1.08)),
                _map(N, swav.outputs['Fac'], 0.0, 1.0, 0.88, 1.05))
    col = _mix(N, _math(N, 'SUBTRACT', 1.0, stone), col, scol)

    # quartz / calcite veins: Voronoi cell edges, wobbled, on about a third of the stones
    vn = N.n('ShaderNodeTexNoise', i_Scale=9.0, i_Detail=3.0)
    N.link(lp, vn.inputs['Vector'])

    vo = N.n('ShaderNodeVectorMath', operation='SUBTRACT')
    N.link(vn.outputs['Color'], vo.inputs[0])
    vo.inputs[1].default_value = (0.5, 0.5, 0.5)

    vs = N.n('ShaderNodeVectorMath', operation='MULTIPLY_ADD')
    N.link(vo.outputs['Vector'], vs.inputs[0])
    vs.inputs[1].default_value = (0.06, 0.06, 0.06)
    N.link(lp, vs.inputs[2])

    ve = N.n('ShaderNodeTexVoronoi', feature='DISTANCE_TO_EDGE', i_Scale=1.4, i_Randomness=1.0)
    N.link(vs.outputs['Vector'], ve.inputs['Vector'])
    vmask = _map(N, ve.outputs['Distance'], 0.005, 0.0015, 0.0, 1.0)
    vmask = _math(N, 'MULTIPLY', vmask, _math(N, 'MULTIPLY', _map(N, tone, 0.72, 0.73, 0.0, 1.0), _map(N, tone, 0.86, 0.85, 0.0, 1.0)))
    vmask = _math(N, 'MULTIPLY', vmask, _math(N, 'MULTIPLY', stone, vein_amt))
    col = _mix(N, vmask, col, vein)

    # mineral grains: a few crystals of a contrasting colour
    vg = N.n('ShaderNodeTexVoronoi', feature='F1', i_Scale=240.0, i_Randomness=1.0)
    N.link(lp, vg.inputs['Vector'])

    gsep = N.n('ShaderNodeSeparateColor')
    N.link(vg.outputs['Color'], gsep.inputs['Color'])
    gmask = _math(N, 'MULTIPLY', _map(N, gsep.outputs['Red'], 0.80, 0.84, 0.0, 1.0), _map(N, vg.outputs['Distance'], 0.0, 0.4, 1.0, 0.0))
    col = _mix(N, _math(N, 'MULTIPLY', gmask, grain_amt), col, grain)

    fine = N.n('ShaderNodeTexNoise', i_Scale=120.0, i_Detail=6.0, i_Roughness=0.7)
    N.link(lp, fine.inputs['Vector'])
    col = _mul(N, col, _map(N, fine.outputs['Fac'], 0.3, 0.7, 0.92, 1.05))

    # pits (limestone: worn solution pits; basalt: gas vesicles)
    pmask = None

    for sc, keep, r0, r1 in ((22.0, 0.93, 0.04, 0.12),):          # a rare, small pit -- tumbled stone
        vp = N.n('ShaderNodeTexVoronoi', feature='F1', i_Scale=sc, i_Randomness=1.0)
        N.link(lp, vp.inputs['Vector'])

        psep = N.n('ShaderNodeSeparateColor')
        N.link(vp.outputs['Color'], psep.inputs['Color'])
        rad = _map(N, psep.outputs['Blue'], 0.0, 1.0, r0, r1)
        pm = _math(N, 'DIVIDE', _math(N, 'SUBTRACT', rad, vp.outputs['Distance']), _math(N, 'MULTIPLY', rad, 0.45))
        pm = _math(N, 'MINIMUM', _math(N, 'MAXIMUM', pm, 0.0), 1.0)
        pm = _math(N, 'MULTIPLY', pm, _map(N, psep.outputs['Green'], keep, keep + 0.03, 0.0, 1.0))
        pmask = pm if pmask is None else _math(N, 'MAXIMUM', pmask, pm)

    col = _mix(N, _math(N, 'MULTIPLY', pmask, 0.45), col, pit)

    # growth: lichen on the up-facing tops (limestone), moss in the crevices (basalt)
    geo = N.n('ShaderNodeNewGeometry')
    nz = N.n('ShaderNodeSeparateXYZ')
    N.link(geo.outputs['Normal'], nz.inputs['Vector'])
    up = _map(N, nz.outputs['Z'], 0.2, 0.9, 0.0, 1.0)

    ao = N.n('ShaderNodeAmbientOcclusion', samples=16, only_local=True, i_Distance=0.03)
    crev = _map(N, ao.outputs['AO'], 0.85, 0.40, 0.0, 1.0)

    tcw = N.n('ShaderNodeTexCoord')
    mn = N.n('ShaderNodeTexNoise', i_Scale=11.0, i_Detail=4.0, i_Roughness=0.5)
    N.link(tcw.outputs['Object'], mn.inputs['Vector'])
    mpatch = _map(N, mn.outputs['Fac'], 0.46, 0.62, 0.0, 1.0)
    mossm = _math(N, 'MULTIPLY', _math(N, 'ADD', crev, _math(N, 'MULTIPLY', up, 0.25)), mpatch)
    mossm = _math(N, 'MULTIPLY', mossm, moss_amt, clamp=True)
    mcol = _mix(N, mn.outputs['Fac'], moss, tuple(min(1.0, c * 1.8) for c in moss))
    col = _mix(N, mossm, col, mcol)

    lv = N.n('ShaderNodeTexVoronoi', feature='F1', i_Scale=40.0, i_Randomness=1.0)
    N.link(tcw.outputs['Object'], lv.inputs['Vector'])
    lic = _math(N, 'MULTIPLY', _map(N, lv.outputs['Distance'], 0.16, 0.08, 0.0, 1.0), _map(N, mn.outputs['Fac'], 0.52, 0.6, 0.0, 1.0))
    lic = _math(N, 'MULTIPLY', _math(N, 'MULTIPLY', lic, up), lichen_amt, clamp=True)
    col = _mix(N, lic, col, lichen)

    # the seams between stones darken (a contact shadow in the colour, gently)
    col = _mul(N, col, _map(N, ao.outputs['AO'], 0.2, 0.9, 0.25, 1.0))
    N.link(col, bsdf.inputs['Base Color'])

    # roughness: water-polished patches against chalky ones; pits and growth are dull
    rn = N.n('ShaderNodeTexNoise', i_Scale=3.5, i_Detail=3.0)
    N.link(lp, rn.inputs['Vector'])
    r = _map(N, rn.outputs['Fac'], 0.35, 0.65, rough - 0.10, rough + 0.10)
    r = _math(N, 'ADD', r, _math(N, 'MULTIPLY', pmask, 0.2))
    r = _math(N, 'ADD', r, _math(N, 'MULTIPLY', _math(N, 'ADD', mossm, lic), 0.35), clamp=True)
    N.link(r, bsdf.inputs['Roughness'])

    # surface: grains, pits, fine wear, the bedding and the veins, as a bump the bake turns into the normal map
    h = _math(N, 'MULTIPLY', fine.outputs['Fac'], 0.5)
    h = _math(N, 'ADD', h, _math(N, 'MULTIPLY', pmask, -0.8))
    h = _math(N, 'ADD', h, _math(N, 'MULTIPLY', gmask, 0.2))
    h = _math(N, 'ADD', h, _math(N, 'MULTIPLY', wav.outputs['Fac'], 0.06))
    h = _math(N, 'ADD', h, _math(N, 'MULTIPLY', vmask, 0.7))          # quartz is harder: the veins stand proud

    bump = N.n('ShaderNodeBump', i_Strength=0.9, i_Distance=0.0012)
    N.link(h, bump.inputs['Height'])
    N.link(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return m


def materials():
    # tumbled river stones, each its own pale tint, with a low sheen, on a charcoal slate
    white = _stone('cairn_src_limestone',
                   [lin('#DCD2BF'), lin('#C7B393'), lin('#B9B7B0'), lin('#CDB895'), lin('#E3DCCF'), lin('#A9A8A2')],
                   lin('#3C403F'), lin('#6B6254'), 0.35, lin('#9A907D'), lin('#EEEAE1'), 0.30,
                   lin('#A87E52'), 0.22, lin('#55702A'), 0.08, lin('#B9BD9C'), 0.12, 0.50, 0.04)

    # matte charcoal basalts, some warmer, some bluer, pale feldspar grains, a few vesicles
    black = _stone('cairn_src_basalt',
                   [lin('#35393C'), lin('#2D3033'), lin('#3D3B38'), lin('#282C30'), lin('#3A3E40'), lin('#323433')],
                   lin('#3C403F'), lin('#8E9296'), 0.4, lin('#141516'), lin('#9E9A92'), 0.25,
                   lin('#5A4632'), 0.08, lin('#3F5D1E'), 0.30, lin('#6E7A55'), 0.10, 0.58, 0.05)

    return {'white': white, 'black': black}


PARAMS = {
    'white': {'coat': 0.0, 'metallic': 0.0, 'specular': 0.45},
    'black': {'coat': 0.0, 'metallic': 0.0, 'specular': 0.5},
}


# Build: sculpt -> decimate -> atlas -> bake high -> low -> export

def build(size=2048, export=True):
    import os
    report = model()
    highs = pieces()
    lows = []

    for o in highs:
        role = o.name[len(SET_ID) + 1:]
        o.name = o.name + '_hi'
        o.data.name = o.name
        lows.append(K.make_low(o, LOW_TRIS[role], SET_ID + '_' + role))

    for lo in lows:
        K.smart_uv(lo, angle=66.0, margin=0.0)

    K.uv_atlas(lows)
    mats = materials()
    baked = K.bake_set(SET_ID, lows, mats, size=size, ao_distance=0.06, highs=highs)

    for o in highs:
        o.hide_render = True
        o.hide_set(True)

    path = None
    if export:
        path, mw, mb = K.export_set(SET_ID, lows, baked, PARAMS)

    os.makedirs(K.WORK + '/cairn', exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=K.WORK + '/cairn/cairn.blend', copy=True)

    return {'report': report, 'glb': path, 'tris': {o.name: K.tri_count(o) for o in lows}}


def preview_baked(path=None):
    K.preview_scene()
    objs = pieces()
    mw = bpy.data.materials[SET_ID + '_white']
    mb = bpy.data.materials[SET_ID + '_black']
    blacks = []

    for i, o in enumerate(objs):
        o.location = ((i - 2.5) * 0.62, 0.0, 0.0)
        o.rotation_euler.z = math.radians(-30)
        K.assign(o, mw)

        b = o.copy()
        b.data = o.data.copy()
        K.assign(b, mb)
        b.location = ((i - 2.5) * 0.62, 0.75, 0.0)
        b.rotation_euler.z = math.radians(-30)
        K.link(b, o.users_collection[0])
        blacks.append(b)

    path = path or K.WORK + '/cairn/preview_baked.png'
    K.render_preview(path, (0.4, -5.6, 2.3), (0.0, 0.3, 0.55), lens=50, res=(1800, 1000), samples=64, only=objs + blacks)

    for b in blacks:
        K.remove(b)

    for o in objs:
        o.rotation_euler.z = 0.0
        o.location = (0.0, 0.0, 0.0)

    return path
