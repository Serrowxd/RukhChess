"""Estate -- Staunton pieces as brutalist towers: White by day, Black at night with its windows lit."""
import importlib
import math
import bpy
import numpy as np
import cbkit as K
import set_classic as C
import set_beton as B
importlib.reload(C)          # cbkit may have been reloaded; C and B must use that same Turn class
importlib.reload(B)

SET_ID = 'estate'
COLL = 'set_estate'
SEG_HI = 192           # lathe segments of the bake source; every window count divides it
LOW_TRIS = {'pawn': 10000, 'rook': 16000, 'knight': 18000, 'bishop': 15000, 'queen': 17000, 'king': 18000}

SLAB = 0.0065          # floor slab thickness
LIP = 0.0015           # how far a slab stands proud of the piece's line
RECESS = 0.0025        # how far the glazing sits behind that line
CH = 0.0006            # the chamfer on a slab's edges
WIN_W = 0.048          # the width a window aims for (the count round a band divides SEG_HI)

# storeys on each piece: (z from, z to, floors); a slab at both ends of a zone
ZONES = {
    'pawn': [(0.150, 0.296, 3)],
    'rook': [(0.170, 0.405, 5), (0.450, 0.556, 2)],
    'bishop': [(0.170, 0.426, 6), (0.509, 0.640, 3)],
    'queen': [(0.200, 0.496, 7), (0.586, 0.776, 4)],
    'king': [(0.215, 0.556, 8), (0.650, 0.862, 5)],
}
ROLE_SEED = {'pawn': 1, 'knight': 2, 'bishop': 3, 'rook': 4, 'queen': 5, 'king': 6}


# Shape

def floors_profile(profile, zones):
    """Rebuild a profile inside each zone (za, zb, n) as n storeys between slabs; returns (profile, bands)."""
    pts, sharp = profile.done() if hasattr(profile, 'done') else profile
    dense, _ = B.densify((pts, sharp), -1.0, 99.0, 0.0015)
    D = np.array(dense, dtype=np.float64)
    out, osh, bands = [], set(), []

    def run(za, zb):
        s = int(np.argmax(D[:, 1] >= za))
        e = s

        while e + 1 < len(D) and D[e + 1, 1] <= zb + 0.004:
            e += 1

        seg = D[max(0, s - 1):e + 2]
        assert np.all(np.diff(seg[:, 1]) > -1e-9), ('profile not rising through zone', za, zb)

        return lambda z: float(np.interp(z, seg[:, 1], seg[:, 0]))

    zones = sorted(zones)
    zi = 0
    i = 0

    while i < len(pts):
        r, z = pts[i]
        if zi < len(zones) and z >= zones[zi][0]:
            za, zb, nf = zones[zi]
            rz = run(za, zb)
            h = (zb - za - SLAB) / nf
            out.append((rz(za), za))

            for k in range(nf + 1):
                z0 = za + k * h
                out.append((rz(z0) + LIP, z0 + CH))
                osh.add(len(out) - 1)
                out.append((rz(z0 + SLAB) + LIP, z0 + SLAB - CH))
                osh.add(len(out) - 1)
                if k == nf:
                    out.append((rz(zb), zb))
                    osh.add(len(out) - 1)
                    break

                zg0, zg1 = z0 + SLAB, z0 + h
                out.append((rz(zg0) - RECESS, zg0))
                osh.add(len(out) - 1)
                m = max(2, int(math.ceil((zg1 - zg0) / 0.004)))

                for q in range(1, m + 1):
                    zz = zg0 + (zg1 - zg0) * q / m
                    out.append((rz(zz) - RECESS, zz))

                osh.add(len(out) - 1)
                bands.append((zg0, zg1, rz((zg0 + zg1) / 2) - RECESS))

            while i < len(pts) and pts[i][1] <= zb:
                i += 1

            zi += 1
            continue

        out.append((r, z))
        if i in sharp:
            osh.add(len(out) - 1)

        i += 1

    return (out, osh), bands


def windows_round(r):
    """How many windows round a band of radius r: the divisor of SEG_HI nearest a WIN_W-wide window."""
    target = 2 * math.pi * r / WIN_W
    divs = [d for d in range(8, SEG_HI + 1) if SEG_HI % d == 0]
    return min(divs, key=lambda d: abs(d - target))


def mesh_arrays(ob):
    me = ob.data
    V = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', V)
    V = V.reshape(-1, 3).astype(np.float64)

    nf = len(me.polygons)
    lv = np.empty(len(me.loops), dtype=np.int64)
    me.loops.foreach_get('vertex_index', lv)

    tot = np.empty(nf, dtype=np.int64)
    me.polygons.foreach_get('loop_total', tot)

    starts = np.empty(nf, dtype=np.int64)
    me.polygons.foreach_get('loop_start', starts)

    Cc = np.empty(nf * 3, dtype=np.float32)
    me.polygons.foreach_get('center', Cc)

    Nf = np.empty(nf * 3, dtype=np.float32)
    me.polygons.foreach_get('normal', Nf)

    return V, lv, np.repeat(np.arange(nf), tot), starts, Cc.reshape(-1, 3).astype(np.float64), Nf.reshape(-1, 3).astype(np.float64)


class Windows:
    """Collects the window data of one piece, then writes it as mesh attributes."""

    def __init__(self, ob):
        self.ob = ob
        self.V, self.lv, self.face_of, self.starts, self.C, self.N = mesh_arrays(ob)

        nf = len(self.C)
        self.glass = np.zeros(nf, dtype=bool)
        self.wid = np.full(nf, -1, dtype=np.int64)
        self.wuv = np.full((len(self.lv), 2), 0.5, dtype=np.float32)

        vz = self.V[self.lv, 2]
        self.zmin = np.minimum.reduceat(vz, self.starts)
        self.zmax = np.maximum.reduceat(vz, self.starts)
        self.always = set()

    def band(self, key, zg0, zg1, nw, axis=(0.0, 0.0), faces=None):
        """Faces within zg0..zg1 become glass: nw windows round the axis, wuv their corner coordinates."""
        ax = np.asarray(axis, dtype=np.float64)
        on = (self.zmin >= zg0 - 1e-5) & (self.zmax <= zg1 + 1e-5) & (np.abs(self.N[:, 2]) < 0.8)
        if faces is not None:
            on &= faces

        on &= ~self.glass
        if not on.any():
            return

        dth = 2 * math.pi / nw
        thc = np.arctan2(self.C[:, 1] - ax[1], self.C[:, 0] - ax[0]) % (2 * math.pi)
        win = np.floor(thc / dth).astype(np.int64)

        self.glass |= on
        self.wid[on] = key * 1000 + win[on]

        lo = on[self.face_of]
        P = self.V[self.lv[lo]]
        f = self.face_of[lo]
        thv = np.arctan2(P[:, 1] - ax[1], P[:, 0] - ax[0])
        d = (thv - thc[f] + math.pi) % (2 * math.pi) - math.pi
        self.wuv[lo, 0] = (thc[f] + d - win[f] * dth) / dth
        self.wuv[lo, 1] = np.clip((P[:, 2] - zg0) / (zg1 - zg0), 0.0, 1.0)

    def band_layout(self, key, zg0, zg1, side, ys, n, win_w):
        """Glass on a flat side facing +X (side 1) or -X (side -1): n windows win_w wide from ys."""
        vy = self.V[self.lv, 1]
        ymin = np.minimum.reduceat(vy, self.starts)
        ymax = np.maximum.reduceat(vy, self.starts)
        on = ((self.zmin >= zg0 - 1e-5) & (self.zmax <= zg1 + 1e-5) & (ymin >= ys - 1e-5)
              & (ymax <= ys + n * win_w + 1e-5) & (side * self.N[:, 0] > 0.3) & ~self.glass)
        if not on.any():
            return

        col = np.clip(np.floor((self.C[:, 1] - ys) / win_w).astype(np.int64), 0, n - 1)
        self.glass |= on
        self.wid[on] = key * 1000 + (500 if side > 0 else 0) + col[on]
        lo = on[self.face_of]
        P = self.V[self.lv[lo]]
        f = self.face_of[lo]
        self.wuv[lo, 0] = (P[:, 1] - (ys + col[f] * win_w)) / win_w
        self.wuv[lo, 1] = np.clip((P[:, 2] - zg0) / (zg1 - zg0), 0.0, 1.0)

    def lantern(self, key, faces):
        """Always-lit glazing with no frame (the bishop's slit)."""
        on = faces & ~self.glass
        self.glass |= on
        self.wid[on] = key * 1000
        self.always.add(key * 1000)

    def write(self, role, beacon=None, seed=7):
        me = self.ob.data
        rng = np.random.RandomState(seed + ROLE_SEED[role])
        lit_of, hue_of, var_of = {}, {}, {}

        # dark windows come in runs round each floor, not a random checkerboard
        ids = np.unique(self.wid[self.wid >= 0])
        on_of = {}

        for f in np.unique(ids // 1000):
            row = [i for i in ids if i // 1000 == f]
            n = len(row)
            occ = rng.uniform(0.30, 0.78)
            ph1, ph2 = rng.uniform(0, 2 * math.pi, 2)
            k1, k2 = rng.randint(1, 3), rng.randint(3, 6)
            sig = np.array([math.sin(2 * math.pi * k1 * j / n + ph1) + 0.6 * math.sin(2 * math.pi * k2 * j / n + ph2)
                            + rng.normal(0, 0.3) for j in range(n)])
            thr = np.quantile(sig, 1.0 - occ)

            for j, i in enumerate(row):
                on_of[i] = sig[j] >= thr

        for i in ids:
            on = i in self.always or on_of[i]
            lit_of[i] = (1.0 if i in self.always else rng.uniform(0.72, 1.0)) if on else 0.0
            hue_of[i] = rng.uniform()
            var_of[i] = 0.85 if i in self.always else rng.uniform()

        lit = np.array([lit_of.get(i, 0.0) for i in self.wid], dtype=np.float32) * self.glass
        hue = np.array([hue_of.get(i, 0.0) for i in self.wid], dtype=np.float32)
        var = np.array([var_of.get(i, 0.0) for i in self.wid], dtype=np.float32)
        bc = np.zeros(len(self.C), dtype=np.float32) if beacon is None else beacon.astype(np.float32)
        for name, vals in (('glass', self.glass.astype(np.float32)), ('lit', lit), ('hue', hue), ('var', var),
                           ('beacon', bc)):
            K.set_attribute(self.ob, name, vals, domain='FACE')

        # a 3-vector, not FLOAT2: Blender treats every 2D corner attribute as a UV map (see README)
        a = me.attributes.get('wuv')
        if a is not None:
            me.attributes.remove(a)

        a = me.attributes.new('wuv', 'FLOAT_VECTOR', 'CORNER')
        a.data.foreach_set('vector', np.concatenate([self.wuv, np.zeros((len(self.wuv), 1), dtype=np.float32)], axis=1).ravel())


KNIGHT_WIN = 0.040


def knight_facades(ob):
    """Glazed facades on the flat sides of the knight's neck, the mesh cut along every window edge first."""
    import bmesh
    bands = []
    z = 0.306

    while z + 0.026 < 0.560:
        bands.append((z, z + 0.026))
        z += 0.034

    bm = bmesh.new()
    bm.from_mesh(ob.data)

    def neck_faces(a, b, test):
        return [f for f in bm.faces if a - 1e-6 <= min(v.co.z for v in f.verts) and max(v.co.z for v in f.verts) <= b + 1e-6
                and test(f)]

    def cut(faces, co, no):
        if not faces:
            return

        edges = list({e for f in faces for e in f.edges})
        verts = list({v for f in faces for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=verts + edges + faces, dist=1e-7, plane_co=co, plane_no=no)

    def sides():
        return [f for f in bm.faces if 0.29 < f.calc_center_median().z < 0.57 and abs(f.normal.x) > 0.25]

    bm.normal_update()
    zone = sides()

    for a, b in bands:
        for zc in (a, b):
            cut([f for f in zone if f.is_valid], (0.0, 0.0, zc), (0.0, 0.0, 1.0))
            bm.normal_update()
            zone = sides()

    bm.normal_update()
    layout = []

    for k, (a, b) in enumerate(bands):
        for side in (-1, 1):
            flat = neck_faces(a, b, lambda f: side * f.normal.x > 0.92)
            if len(flat) < 3:
                continue

            ys_ = [v.co.y for f in flat for v in f.verts]
            y0, y1 = min(ys_) + 0.004, max(ys_) - 0.004
            n = int((y1 - y0) // KNIGHT_WIN)
            if n < 1:
                continue

            ys = (y0 + y1) / 2 - n * KNIGHT_WIN / 2

            for c in range(n + 1):
                cut(neck_faces(a, b, lambda f: side * f.normal.x > 0.3), (0.0, ys + c * KNIGHT_WIN, 0.0), (0.0, 1.0, 0.0))

            bm.normal_update()
            layout.append((k, a, b, side, ys, n, KNIGHT_WIN))

    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()

    return layout


def towered(role, profile, coll):
    prof, bands = floors_profile(profile, ZONES[role])
    ob = K.lathe('estate_' + role, prof, SEG_HI, coll)
    return ob, bands


def mark_bands(W, bands):
    for k, (zg0, zg1, rg) in enumerate(bands):
        W.band(k, zg0, zg1, windows_round(rg))


def build_piece(role, coll):
    if role == 'pawn':
        ob, bands = towered('pawn', C.pawn_profile(), coll)
        W = Windows(ob)
        mark_bands(W, bands)
        W.write(role)
    elif role == 'rook':
        ob, bands = towered('rook', C.rook_profile(), coll)

        for i in range(6):
            K.boolean(ob, C.notch_cutter('cut', coll, 360 * i / 6 + 30, 0.21, 0.628, 0.72, 0.030))

        W = Windows(ob)
        mark_bands(W, bands)
        W.write(role)
    elif role == 'bishop':
        ob, bands = towered('bishop', C.bishop_profile(), coll)
        slab = K.mesh_object('slit', [(0.0, -0.0125, -0.10), (0.20, -0.0125, -0.10), (0.20, 0.0125, -0.10), (0.0, 0.0125, -0.10),
                                      (0.0, -0.0125, 0.10), (0.20, -0.0125, 0.10), (0.20, 0.0125, 0.10), (0.0, 0.0125, 0.10)],
                             [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], coll)

        slab.rotation_euler = (math.radians(38), 0.0, 0.0)
        slab.location = (-0.028, 0.0, 0.705)
        K.apply_transform(slab)
        K.boolean(ob, slab)

        W = Windows(ob)

        # the slit's walls, lit from within: faces inside the cutter's slab, on its planes
        t = math.radians(38)
        q = W.C - np.array([-0.028, 0.0, 0.705])
        ly = q[:, 1] * math.cos(t) + q[:, 2] * math.sin(t)          # the slab's thin axis
        mark_bands(W, bands)
        W.write(role)
    elif role == 'queen':
        qp, zr = C.queen_profile()
        ob, bands = towered('queen', qp, coll)

        for i in range(8):
            K.boolean(ob, C.notch_cutter('cut', coll, 360 * i / 8 + 22.5, 0.23, zr + 0.022, zr + 0.06, 0.036,
                                         v_notch=True, r_in=0.150))

        W = Windows(ob)
        mark_bands(W, bands)
        W.write(role)
    elif role == 'king':
        kp, ztop = C.king_profile()
        body, bands = towered('king', kp, coll)
        h = C.H['king'] - ztop + 0.012
        cross = C.cross_pattee('estate_king_cross', coll, h, 0.128, 0.046, ztop - 0.012)

        # aircraft warning lamps on top of the cross and at each arm's end (red glass, lit at night)
        zc = ztop - 0.012 + 0.6 * h
        lamps = [(0.0, 0.0, C.H['king'] + 0.004), (-0.073, 0.0, zc), (0.073, 0.0, zc)]
        bulbs = [K.uv_sphere('lamp', c, 0.0105, coll, 24, 12) for c in lamps]

        for o in [body, cross]:
            K.set_attribute(o, 'beacon', np.zeros(len(o.data.polygons), dtype=np.float32), domain='FACE')

        for o in bulbs:
            K.set_attribute(o, 'beacon', np.ones(len(o.data.polygons), dtype=np.float32), domain='FACE')

        ob = K.join([body, cross] + bulbs, 'estate_king')
        bv = np.empty(len(ob.data.polygons), dtype=np.float32)
        ob.data.attributes['beacon'].data.foreach_get('value', bv)

        W = Windows(ob)
        mark_bands(W, bands)
        W.write(role, beacon=bv > 0.5)
    else:
        base = K.lathe('estate_knight', C.knight_base_profile(), SEG_HI, coll)
        head = C.knight_head(coll, 0.0024)
        K.decimate(head, target_tris=160000)
        ob = K.join([base, head], 'estate_knight')

        ob.rotation_euler.z = math.radians(-90)       # muzzle +X -> -Y (the board's +Z)
        K.apply_transform(ob)

        layout = knight_facades(ob)
        W = Windows(ob)

        for args in layout:
            W.band_layout(*args)

        W.write(role)

        # set the glass back 1.2 mm behind the slabs (the faces round it become the reveals)
        vi = np.unique(W.lv[W.glass[W.face_of]])
        Vn = W.V.copy()
        Vn[vi, 0] -= np.sign(Vn[vi, 0]) * 0.0012
        ob.data.vertices.foreach_set('co', Vn.astype(np.float32).ravel())
        ob.data.update()

    ob.name = 'estate_' + role
    ob.data.name = ob.name

    return ob


def model(roles=None):
    coll = K.collection(COLL, clear=roles is None)
    out = {}

    for role in roles or K.ROLES:
        for nm in ('estate_' + role, 'estate_' + role + '_hi'):
            old = bpy.data.objects.get(nm)
            if old:
                K.remove(old)

        out[role] = build_piece(role, coll)

    return {r: (K.tri_count(o), [round(float(v), 3) for v in K.bounds(o)[1]]) for r, o in out.items()}


def pieces():
    return [bpy.data.objects['estate_' + r] for r in K.ROLES if bpy.data.objects.get('estate_' + r)]


# Materials

def lin(hexstr):
    return B.lin(hexstr)


def _estate(name, conc, seam, rough, night):
    """Beton concrete where there is no glass; framed panes with sky by day and lit interiors at night."""
    m = B._concrete(name, conc, seam, rough, 0.06, chip=0.18)
    nt = m.node_tree
    N = K.Nodes(m)
    N.x = -3600
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    base_link = bsdf.inputs['Base Color'].links[0].from_socket
    rough_link = bsdf.inputs['Roughness'].links[0].from_socket

    gl = N.n('ShaderNodeAttribute', attribute_name='glass', attribute_type='GEOMETRY').outputs['Fac']
    var = N.n('ShaderNodeAttribute', attribute_name='var', attribute_type='GEOMETRY').outputs['Fac']
    uv = N.n('ShaderNodeAttribute', attribute_name='wuv', attribute_type='GEOMETRY').outputs['Vector']
    sp = N.n('ShaderNodeSeparateXYZ')
    N.link(uv, sp.inputs['Vector'])
    U = B._m(N, 'FRACT', sp.outputs['X'])          # a face can run past its window's edge into the next
    Vv = sp.outputs['Y']

    # the frame round every pane
    mw = 0.030 if night else 0.045                 # by day a grey aluminium mullion reads; at night it's thin
    fu = B._m(N, 'MAXIMUM', B._r(N, U, mw + 0.012, mw, 0.0, 1.0), B._r(N, U, 1.0 - mw - 0.012, 1.0 - mw, 0.0, 1.0))
    fv = B._m(N, 'MAXIMUM', B._r(N, Vv, 0.050, 0.036, 0.0, 1.0), B._r(N, Vv, 0.950, 0.964, 0.0, 1.0))
    lantern = B._r(N, var, 0.849, 0.851, 0.0, 1.0)
    lantern = B._m(N, 'MULTIPLY', lantern, B._r(N, var, 0.852, 0.850, 0.0, 1.0))   # var == 0.85: the slit
    fr = B._m(N, 'MULTIPLY', B._m(N, 'MULTIPLY', B._m(N, 'MAXIMUM', fu, fv), gl), B._m(N, 'SUBTRACT', 1.0, lantern))
    pane = B._m(N, 'MULTIPLY', gl, B._m(N, 'SUBTRACT', 1.0, fr))

    # glass and metal keep no concrete relief; the frames stand a little proud of the glass
    bump = next(n for n in nt.nodes if n.type == 'BUMP')
    hsrc = bump.inputs['Height'].links[0].from_socket
    h = B._m(N, 'ADD', B._m(N, 'MULTIPLY', hsrc, B._m(N, 'SUBTRACT', 1.0, gl)), B._m(N, 'MULTIPLY', fr, 1.2))
    N.link(h, bump.inputs['Height'])

    # curtains drawn to the sides (about a third of the windows), by day and by night
    curtained = B._r(N, var, 0.30, 0.29, 0.0, 1.0)
    sides = B._m(N, 'MAXIMUM', B._r(N, U, 0.26, 0.19, 0.0, 1.0), B._r(N, U, 0.74, 0.81, 0.0, 1.0))
    curtain = B._m(N, 'MULTIPLY', curtained, sides)

    # by day: a reflected sky, lighter toward the head of the pane
    sky = B._mixc(N, B._r(N, Vv, 0.25, 1.0, 0.0, 1.0), lin('#3B4D5D'), lin('#A8BCCA'))
    sky = B._mixc(N, B._m(N, 'MULTIPLY', curtain, 0.9), sky, lin('#A89C88'))

    bc = N.n('ShaderNodeAttribute', attribute_name='beacon', attribute_type='GEOMETRY')

    c = B._mixc(N, pane, base_link, sky)
    c = B._mixc(N, fr, c, lin('#2B2F33') if night else lin('#7F888E'))
    c = B._mixc(N, bc.outputs['Fac'], c, lin('#7A140D'))            # the aircraft lamps: red glass
    N.link(c, bsdf.inputs['Base Color'])

    r = B._mixf(N, pane, rough_link, 0.08)
    r = B._mixf(N, fr, r, 0.40)
    r = B._mixf(N, bc.outputs['Fac'], r, 0.12)
    N.link(r, bsdf.inputs['Roughness'])

    if night:
        lit = N.n('ShaderNodeAttribute', attribute_name='lit', attribute_type='GEOMETRY').outputs['Fac']
        hue = N.n('ShaderNodeAttribute', attribute_name='hue', attribute_type='GEOMETRY').outputs['Fac']

        warm = B._mixc(N, B._r(N, hue, 0.0, 0.93, 0.0, 1.0), lin('#FFA858'), lin('#FFD7A4'))
        warm = B._mixc(N, B._r(N, hue, 0.93, 0.95, 0.0, 1.0), warm, lin('#DCE6FF'))    # a rare cool-white room

        # interiors: curtains (dim sides), blinds (soft slats), a lamp (a glow high in the room), or plain
        k_curt = B._r(N, curtain, 0.0, 1.0, 1.0, 0.28)
        blinds = B._m(N, 'MULTIPLY', B._r(N, var, 0.295, 0.305, 0.0, 1.0), B._r(N, var, 0.505, 0.495, 0.0, 1.0))
        slats = B._r(N, B._m(N, 'SINE', B._m(N, 'MULTIPLY', Vv, 37.7)), -1.0, 1.0, 0.55, 1.0)
        k_blind = B._mixf(N, blinds, 1.0, slats)
        lamp = B._m(N, 'MULTIPLY', B._r(N, var, 0.495, 0.505, 0.0, 1.0), B._r(N, var, 0.685, 0.675, 0.0, 1.0))

        du = B._m(N, 'SUBTRACT', U, 0.5)
        dv = B._m(N, 'SUBTRACT', Vv, 0.70)
        rr = B._m(N, 'ADD', B._m(N, 'MULTIPLY', du, du), B._m(N, 'MULTIPLY', dv, dv))
        glow = B._m(N, 'ADD', 0.55, B._m(N, 'MULTIPLY', B._m(N, 'EXPONENT', B._m(N, 'MULTIPLY', rr, -22.0)), 0.9))
        k_lamp = B._mixf(N, lamp, 1.0, glow)

        head = B._r(N, Vv, 0.0, 1.0, 0.80, 1.06)
        k = B._m(N, 'MULTIPLY', B._m(N, 'MULTIPLY', lit, pane), head)
        k = B._m(N, 'MULTIPLY', B._m(N, 'MULTIPLY', B._m(N, 'MULTIPLY', k, k_curt), k_blind), k_lamp)

        ecol = N.n('ShaderNodeMix', data_type='RGBA', blend_type='MULTIPLY', clamp_factor=True)
        ecol.inputs['Factor'].default_value = 1.0
        N.link(warm, ecol.inputs[6])

        cc = N.n('ShaderNodeCombineColor')

        for ch in ('Red', 'Green', 'Blue'):
            N.link(k, cc.inputs[ch])

        N.link(cc.outputs['Color'], ecol.inputs[7])

        red = N.n('ShaderNodeMixRGB', blend_type='MIX')
        N.link(bc.outputs['Fac'], red.inputs['Fac'])
        N.link(ecol.outputs[2], red.inputs['Color1'])
        red.inputs['Color2'].default_value = (1.0, 0.06, 0.03, 1)
        red.name = '__emission__'
        N.link(red.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0

    return m


def materials():
    white = _estate('estate_src_day', lin('#B7B9B7'), lin('#8F918F'), 0.84, night=False)
    black = _estate('estate_src_night', lin('#333639'), lin('#27292B'), 0.72, night=True)
    return {'white': white, 'black': black}


PARAMS = {
    'white': {'coat': 0.0, 'metallic': 0.0, 'specular': 0.5},
    'black': {'coat': 0.0, 'metallic': 0.0, 'specular': 0.5, 'emit_strength': 1.7},
}


def build(size=2048, export=True):
    import os
    report = model()
    highs = pieces()
    lows = []

    for o in highs:
        role = o.name[len(SET_ID) + 1:]
        o.name = o.name + '_hi'
        o.data.name = o.name
        K.stain_attribute(o, reach=0.06)
        lows.append(K.make_low(o, LOW_TRIS[role], SET_ID + '_' + role))

    for lo in lows:
        K.smart_uv(lo, angle=66.0, margin=0.0)

    K.uv_atlas(lows, boost=('glass', 2.5))       # window panes get more texels: crisp frames and interiors
    mats = materials()
    baked = K.bake_set(SET_ID, lows, mats, size=size, ao_distance=0.06, highs=highs, extrusion=0.006, max_ray=0.02)

    for o in highs:
        o.hide_render = True
        o.hide_set(True)

    path = None
    if export:
        path, mw, mb = K.export_set(SET_ID, lows, baked, PARAMS)

    os.makedirs(K.WORK + '/estate', exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=K.WORK + '/estate/estate.blend', copy=True)

    return {'report': report, 'glb': path, 'tris': {o.name: K.tri_count(o) for o in lows}}


def preview_baked(path=None):
    K.preview_scene()
    objs = [bpy.data.objects[SET_ID + '_' + r] for r in K.ROLES]
    mw = bpy.data.materials[SET_ID + '_white']
    mb = bpy.data.materials[SET_ID + '_black']
    blacks = []

    for i, o in enumerate(objs):
        o.location = ((i - 2.5) * 0.62, 0.0, 0.0)
        o.rotation_euler.z = math.radians(-35)
        K.assign(o, mw)

        b = o.copy()
        b.data = o.data.copy()
        K.assign(b, mb)
        b.location = ((i - 2.5) * 0.62, 0.75, 0.0)
        b.rotation_euler.z = math.radians(-35)
        K.link(b, o.users_collection[0])
        blacks.append(b)

    path = path or K.WORK + '/estate/preview_baked.png'
    K.render_preview(path, (0.4, -5.6, 2.3), (0.0, 0.3, 0.50), lens=50, res=(1800, 1000), samples=64, only=objs + blacks)

    for b in blacks:
        K.remove(b)

    for o in objs:
        o.location = (0.0, 0.0, 0.0)
        o.rotation_euler.z = 0.0

    return path
