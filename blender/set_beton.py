"""Beton -- Staunton pieces in board-formed concrete, white cement against charcoal."""
import math
import bpy
import numpy as np
import importlib
import cbkit as K
import set_classic as C
importlib.reload(C)          # cbkit may have been reloaded; C must build its profiles with that same Turn class

SET_ID = 'beton'
COLL = 'set_beton'
SEG_HI = 240           # lathe segments of the bake source (the flutes are displaced per vertex)
LOW_TRIS = {'pawn': 9000, 'rook': 12000, 'knight': 16000, 'bishop': 12000, 'queen': 14000, 'king': 14000}

# the fluted shaft of each turned piece: (z from, z to, number of flutes); the flutes fade out at both ends
FLUTES = {
    'pawn': (0.150, 0.298, 14),
    'rook': (0.172, 0.405, 24),
    'bishop': (0.172, 0.432, 16),
    'queen': (0.202, 0.505, 18),
    'king': (0.218, 0.565, 20),
}


# Shape

def densify(profile, z0, z1, step=0.003):
    """Resample a profile so no segment within z0..z1 is longer than `step` (flutes need the rings)."""
    pts, sharp = profile.done() if hasattr(profile, 'done') else profile     # (a reload makes a new Turn class)
    out, osharp = [pts[0]], ({0} if 0 in sharp else set())

    for i in range(1, len(pts)):
        q, p = pts[i - 1], pts[i]
        n = 1
        if max(q[1], p[1]) >= z0 and min(q[1], p[1]) <= z1:
            n = max(1, int(math.ceil(math.dist(q, p) / step)))

        for k in range(1, n + 1):
            t = k / n
            out.append((q[0] + (p[0] - q[0]) * t, q[1] + (p[1] - q[1]) * t))

        if i in sharp:
            osharp.add(len(out) - 1)

    return out, osharp


def _ss(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def flute(ob, z0, z1, n, depth_frac=0.065, max_depth=0.0042, width=0.62, fade=0.018):
    """Cut n vertical flutes into a turned shaft between z0 and z1, fading out at both ends."""
    me = ob.data
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)

    r = np.hypot(co[:, 0], co[:, 1])
    th = np.arctan2(co[:, 1], co[:, 0])

    ph = (th / (2 * np.pi / n) + 0.5) % 1.0 - 0.5            # -0.5..0.5 across one flute, a rib toward -Y
    g = np.sqrt(np.clip(1.0 - (ph / (width / 2)) ** 2, 0.0, None))
    f = _ss(z0, z0 + fade, co[:, 2]) * (1.0 - _ss(z1 - fade, z1, co[:, 2]))
    dep = np.minimum(max_depth, depth_frac * r) * f * g

    s = np.where(r > 1e-6, (r - dep) / np.maximum(r, 1e-9), 1.0)
    co[:, 0] *= s
    co[:, 1] *= s

    me.vertices.foreach_set('co', co.astype(np.float32).ravel())
    me.update()


def turned(role, profile, coll):
    z0, z1, n = FLUTES[role]
    ob = K.lathe('beton_' + role, densify(profile, z0 - 0.01, z1 + 0.01), SEG_HI, coll)
    flute(ob, z0, z1, n)
    return ob


def face_centers(ob):
    C_ = np.empty(len(ob.data.polygons) * 3, dtype=np.float32)
    ob.data.polygons.foreach_get('center', C_)
    return C_.reshape(-1, 3)


def accent(ob, mask):
    """Weathering steel on these faces (the material reads the per-face `accent`)."""
    K.set_attribute(ob, 'accent', np.asarray(mask, dtype=np.float32), domain='FACE')


def finial_mask(ob, cz, rad):
    """The ball finial: every face within the ball (and the short neck under it)."""
    Ct = face_centers(ob)
    d = np.linalg.norm(Ct - np.array([0.0, 0.0, cz], dtype=np.float32), axis=1)
    return d < rad + 0.004


def rust_attribute(ob, reach=0.11):
    """Per-vertex rust run-off below the weathering steel, fading over `reach`."""
    me = ob.data
    nv = len(me.vertices)

    V = np.empty(nv * 3, dtype=np.float32)
    me.vertices.foreach_get('co', V)
    V = V.reshape(-1, 3)

    acc = np.empty(len(me.polygons), dtype=np.float32)
    me.attributes['accent'].data.foreach_get('value', acc)

    out = np.zeros(nv, dtype=np.float32)
    if acc.max() > 0.5:
        tot = np.empty(len(me.polygons), dtype=np.int64)
        me.polygons.foreach_get('loop_total', tot)
        lv = np.empty(len(me.loops), dtype=np.int64)
        me.loops.foreach_get('vertex_index', lv)

        on = np.repeat(acc > 0.5, tot)
        A = V[np.unique(lv[on])]

        z0 = float(A[:, 2].min())
        ra = float(np.hypot(A[:, 0], A[:, 1]).max())

        rv = np.hypot(V[:, 0], V[:, 1])
        drop = z0 - V[:, 2]
        out = (np.clip(1.0 - drop / reach, 0.0, 1.0) * (drop > -0.002)
               * np.clip(1.0 - (rv - (ra + 0.025)) / 0.03, 0.0, 1.0)).astype(np.float32)

        out[np.unique(lv[on])] = 0.0

    K.set_attribute(ob, 'rust', out, domain='POINT')


def build_piece(role, coll):
    if role == 'pawn':
        ob = turned('pawn', C.pawn_profile(), coll)
        accent(ob, np.zeros(len(ob.data.polygons)))
    elif role == 'rook':
        ob = turned('rook', C.rook_profile(), coll)
        for i in range(6):
            K.boolean(ob, C.notch_cutter('cut', coll, 360 * i / 6 + 30, 0.21, 0.628, 0.72, 0.030))
        accent(ob, np.zeros(len(ob.data.polygons)))
    elif role == 'bishop':
        ob = turned('bishop', C.bishop_profile(), coll)
        slab = K.mesh_object('slit', [(0.0, -0.019, -0.10), (0.20, -0.019, -0.10), (0.20, 0.019, -0.10), (0.0, 0.019, -0.10),
                                      (0.0, -0.019, 0.10), (0.20, -0.019, 0.10), (0.20, 0.019, 0.10), (0.0, 0.019, 0.10)],
                             [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], coll)

        slab.rotation_euler = (math.radians(38), 0.0, 0.0)
        slab.location = (-0.052, 0.0, 0.705)
        K.apply_transform(slab)

        K.boolean(ob, slab)
        accent(ob, finial_mask(ob, C.H['bishop'] - 0.034, 0.034))
    elif role == 'queen':
        qp, zr = C.queen_profile()
        ob = turned('queen', qp, coll)

        for i in range(8):
            K.boolean(ob, C.notch_cutter('cut', coll, 360 * i / 8 + 22.5, 0.23, zr + 0.022, zr + 0.06, 0.036,
                                         v_notch=True, r_in=0.150))

        accent(ob, finial_mask(ob, C.H['queen'] - 0.046, 0.046))
    elif role == 'king':
        kp, ztop = C.king_profile()
        body = turned('king', kp, coll)
        accent(body, np.zeros(len(body.data.polygons)))
        cross = C.cross_pattee('beton_king_cross', coll, C.H['king'] - ztop + 0.012, 0.128, 0.046, ztop - 0.012)
        accent(cross, np.ones(len(cross.data.polygons)))
        ob = K.join([body, cross], 'beton_king')
    else:
        base = K.lathe('beton_knight', C.knight_base_profile(), SEG_HI, coll)
        head = C.knight_head(coll, 0.0024)
        K.decimate(head, target_tris=160000)
        ob = K.join([base, head], 'beton_knight')
        ob.rotation_euler.z = math.radians(-90)       # muzzle +X -> -Y (the board's +Z)
        K.apply_transform(ob)
        accent(ob, np.zeros(len(ob.data.polygons)))

    rust_attribute(ob)
    ob.name = 'beton_' + role
    ob.data.name = ob.name

    return ob


def model(roles=None):
    coll = K.collection(COLL, clear=roles is None)
    out = {}

    for role in roles or K.ROLES:
        for nm in ('beton_' + role, 'beton_' + role + '_hi'):
            old = bpy.data.objects.get(nm)
            if old:
                K.remove(old)

        out[role] = build_piece(role, coll)

    return {r: (K.tri_count(o), [round(float(v), 3) for v in K.bounds(o)[1]]) for r, o in out.items()}


def pieces():
    return [bpy.data.objects['beton_' + r] for r in K.ROLES if bpy.data.objects.get('beton_' + r)]


def preview(path=None):
    """The six shapes in clay, in a row (a shape check before any baking)."""
    K.preview_scene()
    objs = pieces()

    for i, o in enumerate(objs):
        o.location = ((i - 2.5) * 0.62, 0, 0)

    m, N, bsdf, _ = K.new_material('__clay')
    bsdf.inputs['Base Color'].default_value = (0.62, 0.60, 0.57, 1)
    bsdf.inputs['Roughness'].default_value = 0.7

    for o in objs:
        K.assign(o, m)

    path = path or K.WORK + '/beton/preview_shapes.png'
    K.render_preview(path, (0.4, -5.9, 1.9), (0.0, 0.0, 0.5), lens=50, res=(1800, 900), samples=32, only=objs)

    for o in objs:
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


def _m(N, op, a, b=None, clamp=False):
    """Math node on sockets or numbers; returns the output socket."""

    m = N.n('ShaderNodeMath', operation=op, use_clamp=clamp)

    for i, v in enumerate((a, b)):
        if v is None:
            continue

        if isinstance(v, (int, float)):
            m.inputs[i].default_value = v
        else:
            N.link(v, m.inputs[i])

    return m.outputs['Value']


def _r(N, v, a, b, c, d, clamp=True):
    """Map range v from a..b to c..d; returns the output socket."""

    m = N.n('ShaderNodeMapRange', i_From_Min=a, i_From_Max=b, i_To_Min=c, i_To_Max=d, clamp=clamp)
    N.link(v, m.inputs['Value'])
    return m.outputs['Result']


def _periodic_line(N, v, period, width, offset=0.0):
    """1 on a thin line every `period` along v (width in the same units), 0 elsewhere."""
    s = _m(N, 'DIVIDE', _m(N, 'ADD', v, offset), period)
    f = _m(N, 'FRACT', s)
    dist = _m(N, 'ABSOLUTE', _m(N, 'SUBTRACT', f, 0.5))          # 0.5 at the line, 0 mid-cell

    return _r(N, dist, 0.5 - width / period, 0.5, 0.0, 1.0), _m(N, 'FLOOR', s)


def _mixf(N, fac, a, b):
    """Float mix; a / b sockets or numbers; returns the output socket."""

    m = N.n('ShaderNodeMix', data_type='FLOAT')

    for sock, v in ((m.inputs['Factor'], fac), (m.inputs['A'], a), (m.inputs['B'], b)):
        if isinstance(v, (int, float)):
            sock.default_value = v
        else:
            N.link(v, sock)

    return m.outputs['Result']


def _mixc(N, fac, a, b):
    """Colour mix; a / b sockets or (r, g, b) tuples; returns the output socket."""

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


def _concrete(name, base, seam, rough, pits, speckle=None, polish=0.0, row=0.052, chip=0.55):
    """Board-formed concrete on turned pieces, weathering steel where `accent` is 1."""
    m, N, bsdf, out = K.new_material(name)

    tc = N.n('ShaderNodeTexCoord')
    oi = N.n('ShaderNodeObjectInfo')
    sep = N.n('ShaderNodeSeparateXYZ')
    N.link(tc.outputs['Object'], sep.inputs['Vector'])
    X, Y, Z = sep.outputs['X'], sep.outputs['Y'], sep.outputs['Z']

    geo = N.n('ShaderNodeNewGeometry')
    gsep = N.n('ShaderNodeSeparateXYZ')
    N.link(geo.outputs['Normal'], gsep.inputs['Vector'])
    az = _m(N, 'ABSOLUTE', gsep.outputs['Z'])
    wall = _r(N, az, 0.62, 0.30, 0.0, 1.0)                       # 1 on steep faces, 0 on the flats
    rnd = _m(N, 'MULTIPLY', oi.outputs['Random'], 3.7)
    Zr = _m(N, 'ADD', Z, rnd)
    th = _m(N, 'ARCTAN2', Y, X)
    rr = _m(N, 'SQRT', _m(N, 'ADD', _m(N, 'MULTIPLY', X, X), _m(N, 'MULTIPLY', Y, Y)))

    # formwork: plank seams, per-plank tone and depth, grain
    seam_l, rowid = _periodic_line(N, Zr, row, 0.0023)

    gv = N.n('ShaderNodeCombineXYZ')
    N.link(_m(N, 'MULTIPLY', X, 1.4), gv.inputs['X'])
    N.link(_m(N, 'MULTIPLY', Y, 1.4), gv.inputs['Y'])
    N.link(_m(N, 'MULTIPLY', Zr, 150.0), gv.inputs['Z'])

    grain = N.n('ShaderNodeTexNoise', i_Scale=1.0, i_Detail=8.0, i_Roughness=0.62, i_Distortion=0.4)
    N.link(gv.outputs['Vector'], grain.inputs['Vector'])
    grain_f = grain.outputs['Fac']

    # form-tie holes: eight columns round the piece, one in every other plank
    per = 2 * math.pi / 8
    tu = _m(N, 'MULTIPLY', _m(N, 'MULTIPLY', _m(N, 'SUBTRACT', _m(N, 'FRACT', _m(N, 'DIVIDE', _m(N, 'ADD', th, math.pi + per * 0.5), per)), 0.5), per), rr)
    tv = _m(N, 'MULTIPLY', _m(N, 'SUBTRACT', _m(N, 'FRACT', _m(N, 'DIVIDE', _m(N, 'ADD', Zr, row * 0.5), row * 2)), 0.5), row * 2)
    td = _m(N, 'SQRT', _m(N, 'ADD', _m(N, 'MULTIPLY', tu, tu), _m(N, 'MULTIPLY', tv, tv)))

    # each hole its own: about 40% plugged with a paler mortar, flush-ish; the rest open, a coned recess
    hid = N.n('ShaderNodeCombineXYZ')
    N.link(_m(N, 'FLOOR', _m(N, 'DIVIDE', _m(N, 'ADD', th, math.pi + per * 0.5), per)), hid.inputs['X'])
    N.link(_m(N, 'FLOOR', _m(N, 'DIVIDE', _m(N, 'ADD', Zr, row * 0.5), row * 2)), hid.inputs['Y'])

    hn = N.n('ShaderNodeTexWhiteNoise', noise_dimensions='3D')
    N.link(hid.outputs['Vector'], hn.inputs['Vector'])
    plug = _r(N, hn.outputs['Value'], 0.40, 0.41, 1.0, 0.0)
    tie = _m(N, 'MULTIPLY', _r(N, td, 0.0082, 0.0066, 0.0, 1.0), wall)          # the whole hole, rim included
    core = _m(N, 'MULTIPLY', _r(N, td, 0.0044, 0.0034, 0.0, 1.0), wall)         # its dark throat
    cone = _m(N, 'MULTIPLY', _r(N, td, 0.0088, 0.0034, 0.0, 1.0), wall)         # depth profile, rim to throat

    wn = N.n('ShaderNodeTexWhiteNoise', noise_dimensions='1D')
    N.link(rowid, wn.inputs['W'])
    ctone = _r(N, wn.outputs['Value'], 0.0, 1.0, 0.86, 1.07)
    seam_m = _m(N, 'MULTIPLY', seam_l, wall)

    # aggregate, bug holes, mottling
    agg = N.n('ShaderNodeTexVoronoi', feature='F1', i_Scale=125.0, i_Randomness=1.0)
    N.link(tc.outputs['Object'], agg.inputs['Vector'])

    asep = N.n('ShaderNodeSeparateColor')
    N.link(agg.outputs['Color'], asep.inputs['Color'])
    grain_dot = _r(N, agg.outputs['Distance'], 0.0, 0.35, 1.0, 0.0)
    dark_agg = _m(N, 'MULTIPLY', grain_dot, _r(N, asep.outputs['Red'], 0.80, 0.84, 0.0, 1.0))
    light_agg = _m(N, 'MULTIPLY', grain_dot, _r(N, asep.outputs['Green'], 0.84, 0.88, 0.0, 1.0))

    vor = N.n('ShaderNodeTexVoronoi', feature='F1', i_Scale=40.0, i_Randomness=1.0)
    N.link(tc.outputs['Object'], vor.inputs['Vector'])

    pitmask = N.n('ShaderNodeTexNoise', i_Scale=6.0, i_Detail=2.0)
    N.link(tc.outputs['Object'], pitmask.inputs['Vector'])
    pits_f = _m(N, 'MULTIPLY', _r(N, vor.outputs['Distance'], 0.0, pits, 1.0, 0.0), _r(N, pitmask.outputs['Fac'], 0.46, 0.58, 0.0, 1.0))

    mot = N.n('ShaderNodeTexNoise', i_Scale=3.0, i_Detail=4.0, i_Roughness=0.5)
    N.link(tc.outputs['Object'], mot.inputs['Vector'])
    motm = _r(N, mot.outputs['Fac'], 0.30, 0.70, 0.84, 1.08)

    blot = N.n('ShaderNodeTexNoise', i_Scale=9.0, i_Detail=3.0, i_Roughness=0.55)
    N.link(tc.outputs['Object'], blot.inputs['Vector'])
    motm = _m(N, 'MULTIPLY', motm, _r(N, blot.outputs['Fac'], 0.35, 0.65, 0.93, 1.05))

    # rain: the mesh's `stain` (from the rim above), broken into vertical streaks
    st = N.n('ShaderNodeAttribute', attribute_name='stain', attribute_type='GEOMETRY')
    sv = N.n('ShaderNodeCombineXYZ')
    N.link(_m(N, 'MULTIPLY', X, 70.0), sv.inputs['X'])
    N.link(_m(N, 'MULTIPLY', Y, 70.0), sv.inputs['Y'])
    N.link(_m(N, 'MULTIPLY', Z, 3.0), sv.inputs['Z'])

    streak = N.n('ShaderNodeTexNoise', i_Scale=1.0, i_Detail=4.0, i_Roughness=0.6)
    N.link(sv.outputs['Vector'], streak.inputs['Vector'])
    stain = _m(N, 'MULTIPLY', _m(N, 'MULTIPLY', st.outputs['Fac'], _r(N, streak.outputs['Fac'], 0.35, 0.65, 0.25, 1.0)), wall)

    # the foot: a darker band where the piece meets the board
    foot = _r(N, Z, 0.0, 0.018, 0.72, 1.0)

    # colour
    tone = _m(N, 'MULTIPLY', motm, foot)
    tone = _m(N, 'MULTIPLY', tone, _mixf(N, wall, 0.985, ctone))
    tone = _m(N, 'MULTIPLY', tone, _r(N, stain, 0.0, 1.0, 1.0, 0.62))
    tone = _m(N, 'MULTIPLY', tone, _mixf(N, wall, 1.0, _r(N, grain_f, 0.3, 0.7, 0.93, 1.06)))

    col = N.n('ShaderNodeVectorMath', operation='SCALE')
    col.inputs[0].default_value = base
    N.link(tone, col.inputs['Scale'])

    c = col.outputs['Vector']
    c = _mixc(N, seam_m, c, seam)
    c = _mixc(N, pits_f, c, seam)
    c = _mixc(N, _m(N, 'MULTIPLY', dark_agg, 0.95), c, tuple(v * 0.45 for v in base))
    c = _mixc(N, _m(N, 'MULTIPLY', light_agg, 0.8), c, speckle or tuple(min(1.0, v * 1.4) for v in base))

    open_ = _m(N, 'SUBTRACT', 1.0, plug)
    c = _mixc(N, _m(N, 'MULTIPLY', tie, open_), c, tuple(v * 0.55 for v in base))           # the cone
    c = _mixc(N, _m(N, 'MULTIPLY', core, open_), c, tuple(v * 0.22 for v in base))          # the throat
    c = _mixc(N, _m(N, 'MULTIPLY', tie, plug), c, tuple(min(1.0, v * 1.12) for v in base))  # a mortar plug

    # chipped arrises: the convex edges lighter (fresh aggregate), broken by noise
    chip_n = N.n('ShaderNodeTexNoise', i_Scale=90.0, i_Detail=3.0)
    N.link(tc.outputs['Object'], chip_n.inputs['Vector'])
    edge = _r(N, geo.outputs['Pointiness'], 0.515, 0.56, 0.0, 1.0)
    chips = _m(N, 'MULTIPLY', edge, _r(N, chip_n.outputs['Fac'], 0.45, 0.62, 0.0, 1.0))
    c = _mixc(N, _m(N, 'MULTIPLY', chips, chip), c, tuple(min(1.0, v * 1.25) for v in base))

    # rust run-off from the weathering steel, streaked down the concrete
    rs_ = N.n('ShaderNodeAttribute', attribute_name='rust', attribute_type='GEOMETRY')
    rust_k = _m(N, 'MULTIPLY', rs_.outputs['Fac'], _r(N, streak.outputs['Fac'], 0.30, 0.62, 0.15, 1.0))
    c = _mixc(N, _m(N, 'MULTIPLY', rust_k, 0.75), c, lin('#8A4A24'))

    # weathering steel where the mesh says so
    acc = N.n('ShaderNodeAttribute', attribute_name='accent', attribute_type='GEOMETRY')
    rust_n = N.n('ShaderNodeTexNoise', i_Scale=40.0, i_Detail=8.0, i_Roughness=0.65)
    N.link(tc.outputs['Object'], rust_n.inputs['Vector'])

    rust = N.n('ShaderNodeValToRGB')
    el = rust.color_ramp.elements
    el[0].position, el[0].color = 0.30, (*lin('#3A1A0E'), 1)
    el[1].position, el[1].color = 0.72, (*lin('#8A4520'), 1)
    e3 = el.new(0.52)
    e3.color = (*lin('#6B2F14'), 1)
    N.link(rust_n.outputs['Fac'], rust.inputs['Fac'])
    c = _mixc(N, acc.outputs['Fac'], c, rust.outputs['Color'])
    N.link(c, bsdf.inputs['Base Color'])

    # roughness: mottled, stains a touch glossier, pits and tie holes dull, rust rough
    r = _r(N, mot.outputs['Fac'], 0.0, 1.0, rough - 0.08, rough + 0.08)
    r = _m(N, 'ADD', r, _m(N, 'MULTIPLY', stain, -0.10))
    r = _m(N, 'ADD', r, _m(N, 'MULTIPLY', pits_f, 0.10))
    r = _m(N, 'ADD', r, _m(N, 'MULTIPLY', chips, 0.08))
    r = _mixf(N, acc.outputs['Fac'], r, 0.78)
    N.link(_m(N, 'MINIMUM', _m(N, 'MAXIMUM', r, 0.05), 1.0), bsdf.inputs['Roughness'])

    # relief: seams, pits and tie holes recessed, each plank at its own depth, grain and aggregate faint
    h = _m(N, 'MULTIPLY', seam_m, -1.6)
    h = _m(N, 'ADD', h, _m(N, 'MULTIPLY', pits_f, -2.2))
    h = _m(N, 'ADD', h, _m(N, 'MULTIPLY', _m(N, 'MULTIPLY', grain_f, wall), 1.6))
    h = _m(N, 'ADD', h, _m(N, 'MULTIPLY', _m(N, 'SUBTRACT', wn.outputs['Value'], 0.5), _m(N, 'MULTIPLY', wall, 0.9)))
    h = _m(N, 'ADD', h, _m(N, 'MULTIPLY', _m(N, 'MULTIPLY', cone, open_), -5.0))
    h = _m(N, 'ADD', h, _m(N, 'MULTIPLY', _m(N, 'MULTIPLY', tie, plug), -1.2))
    h = _m(N, 'ADD', h, _m(N, 'MULTIPLY', _m(N, 'ADD', dark_agg, light_agg), 0.35))
    h = _m(N, 'ADD', h, _m(N, 'MULTIPLY', chips, -0.8))

    # the steel carries only its own pitting: no formwork seams, tie holes or aggregate on it
    h = _mixf(N, acc.outputs['Fac'], h, _m(N, 'MULTIPLY', rust_n.outputs['Fac'], 1.2))

    bump = N.n('ShaderNodeBump', i_Strength=0.85, i_Distance=0.0012)
    N.link(h, bump.inputs['Height'])
    N.link(bump.outputs['Normal'], bsdf.inputs['Normal'])
    if polish:
        bsdf.inputs['Coat Weight'].default_value = polish
        bsdf.inputs['Coat Roughness'].default_value = 0.35

    return m


def materials():
    white = _concrete('beton_src_white', lin('#C3C6C6'), lin('#A2A6A7'), 0.84, 0.13)
    black = _concrete('beton_src_black', lin('#3B3F42'), lin('#2E3134'), 0.64, 0.12, speckle=lin('#8A8D8F'), polish=0.10)
    return {'white': white, 'black': black}


PARAMS = {
    'white': {'coat': 0.0, 'metallic': 0.0, 'specular': 0.45},
    'black': {'coat': 0.15, 'coat_rough': 0.35, 'metallic': 0.0, 'specular': 0.5},
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
        K.stain_attribute(o, reach=0.10)
        lows.append(K.make_low(o, LOW_TRIS[role], SET_ID + '_' + role))

    for lo in lows:
        K.smart_uv(lo, angle=66.0, margin=0.0)

    K.uv_atlas(lows)
    mats = materials()
    baked = K.bake_set(SET_ID, lows, mats, size=size, ao_distance=0.06, highs=highs, extrusion=0.006, max_ray=0.02)

    for o in highs:
        o.hide_render = True
        o.hide_set(True)

    path = None
    if export:
        path, mw, mb = K.export_set(SET_ID, lows, baked, PARAMS)

    os.makedirs(K.WORK + '/beton', exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=K.WORK + '/beton/beton.blend', copy=True)

    return {'report': report, 'glb': path, 'tris': {o.name: K.tri_count(o) for o in lows}}


def preview_baked(path=None):
    K.preview_scene()
    objs = [bpy.data.objects[SET_ID + '_' + r] for r in K.ROLES]
    mw = bpy.data.materials[SET_ID + '_white']
    mb = bpy.data.materials[SET_ID + '_black']
    blacks = []

    for i, o in enumerate(objs):
        o.location = ((i - 2.5) * 0.62, 0.0, 0.0)
        K.assign(o, mw)
        b = o.copy()
        b.data = o.data.copy()
        K.assign(b, mb)
        b.location = ((i - 2.5) * 0.62, 0.75, 0.0)
        b.rotation_euler.z = math.pi
        K.link(b, o.users_collection[0])
        blacks.append(b)

    path = path or K.WORK + '/beton/preview_baked.png'
    K.render_preview(path, (0.4, -5.6, 2.3), (0.0, 0.3, 0.45), lens=50, res=(1800, 1000), samples=64, only=objs + blacks)

    for b in blacks:
        K.remove(b)

    for o in objs:
        o.location = (0.0, 0.0, 0.0)

    return path
