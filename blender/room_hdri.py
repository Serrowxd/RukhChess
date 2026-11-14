"""The Room environment: a study at night, rendered to an equirectangular HDRI."""
import math
import os
import random
import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector
import cbkit as K

COLL = 'room_hdri'
OUT = os.path.join(K.ASSETS_OUT, 'env_study.hdr')
W, D, H = 7.2, 6.6, 3.1        # room width (x), depth (y), height
EYE = 1.05                     # camera height: seated, at the table


def lin(hexstr):
    h = hexstr.lstrip('#')
    return tuple(((int(h[i:i + 2], 16) / 255.0 + 0.055) / 1.055) ** 2.4 if int(h[i:i + 2], 16) / 255.0 > 0.04045
                 else int(h[i:i + 2], 16) / 255.0 / 12.92 for i in (0, 2, 4))


def stone_mat():
    """Dressed stone for the chimney breast: courses of blocks, mottled, the mortar recessed."""
    m, N, bsdf, out = K.new_material('room_stone')

    tc = N.n('ShaderNodeTexCoord')
    br = N.n('ShaderNodeTexBrick', i_Scale=3.2, i_Mortar_Size=0.012, i_Bias=0.0, i_Brick_Width=0.62,
             i_Row_Height=0.22, offset=0.5)
    br.inputs['Color1'].default_value = (*lin('#7A746B'), 1)
    br.inputs['Color2'].default_value = (*lin('#67625A'), 1)
    br.inputs['Mortar'].default_value = (*lin('#3E3A35'), 1)
    N.link(tc.outputs['Object'], br.inputs['Vector'])

    nz = N.n('ShaderNodeTexNoise', i_Scale=14.0, i_Detail=6.0)
    N.link(tc.outputs['Object'], nz.inputs['Vector'])

    mix = N.n('ShaderNodeMixRGB', blend_type='MULTIPLY')
    mix.inputs['Fac'].default_value = 0.35
    N.link(br.outputs['Color'], mix.inputs['Color1'])
    N.link(nz.outputs['Color'], mix.inputs['Color2'])
    N.link(mix.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.85

    bump = N.n('ShaderNodeBump', i_Strength=0.6, i_Distance=0.02)
    N.link(br.outputs['Fac'], bump.inputs['Height'])
    N.link(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return m


def _nm(N, op, a, b=None):
    m = N.n('ShaderNodeMath', operation=op)

    for i, v in enumerate((a, b)):
        if v is None:
            continue

        if isinstance(v, (int, float)):
            m.inputs[i].default_value = v
        else:
            N.link(v, m.inputs[i])

    return m.outputs['Value']


def _nr(N, v, a, b, c, d):
    m = N.n('ShaderNodeMapRange', i_From_Min=a, i_From_Max=b, i_To_Min=c, i_To_Max=d, clamp=True)
    N.link(v, m.inputs['Value'])
    return m.outputs['Result']


def _nmix(N, fac, a, b):
    m = N.n('ShaderNodeMix', data_type='RGBA', blend_type='MIX', clamp_factor=True)
    if isinstance(fac, (int, float)):
        m.inputs['Factor'].default_value = fac
    else:
        N.link(fac, m.inputs['Factor'])

    for sock, v in ((m.inputs[6], a), (m.inputs[7], b)):
        if isinstance(v, tuple):
            sock.default_value = (*v, 1)
        else:
            N.link(v, sock)

    return m.outputs[2]


def parquet_mat():
    """Oak boards: staggered planks (a Brick texture), each its own tone, the grain running along it, satin."""
    m, N, bsdf, out = K.new_material('room_parquet')

    tc = N.n('ShaderNodeTexCoord')
    br = N.n('ShaderNodeTexBrick', i_Scale=1.0, i_Mortar_Size=0.003, i_Bias=0.0, i_Brick_Width=1.15,
             i_Row_Height=0.14, offset=0.37)
    br.inputs['Color1'].default_value = (*lin('#6E4C31'), 1)
    br.inputs['Color2'].default_value = (*lin('#553824'), 1)
    br.inputs['Mortar'].default_value = (*lin('#1C130C'), 1)
    N.link(tc.outputs['Object'], br.inputs['Vector'])

    vm = N.n('ShaderNodeVectorMath', operation='MULTIPLY')
    N.link(tc.outputs['Object'], vm.inputs[0])
    vm.inputs[1].default_value = (1.4, 48.0, 1.4)

    gr = N.n('ShaderNodeTexNoise', i_Scale=1.0, i_Detail=8.0, i_Roughness=0.6, i_Distortion=0.7)
    N.link(vm.outputs['Vector'], gr.inputs['Vector'])

    sc = N.n('ShaderNodeVectorMath', operation='SCALE')
    N.link(br.outputs['Color'], sc.inputs[0])
    N.link(_nr(N, gr.outputs['Fac'], 0.3, 0.7, 0.78, 1.12), sc.inputs['Scale'])
    N.link(sc.outputs['Vector'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.34

    bump = N.n('ShaderNodeBump', i_Strength=0.4, i_Distance=0.004)
    N.link(br.outputs['Fac'], bump.inputs['Height'])
    N.link(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return m


def rug_mat(hx, hy):
    """A Persian-style wool rug: guards, a diamond border, a latticed field and a medallion."""
    m, N, bsdf, out = K.new_material('room_rug')

    tc = N.n('ShaderNodeTexCoord')
    sep = N.n('ShaderNodeSeparateXYZ')
    N.link(tc.outputs['Object'], sep.inputs['Vector'])

    u, v = sep.outputs['X'], sep.outputs['Y']
    au, av = _nm(N, 'ABSOLUTE', u), _nm(N, 'ABSOLUTE', v)

    eu = _nm(N, 'SUBTRACT', hx, au)                      # distance to the short (left/right) edges
    ev = _nm(N, 'SUBTRACT', hy, av)                      # distance to the long edges
    e = _nm(N, 'MINIMUM', eu, ev)
    short = _nr(N, _nm(N, 'SUBTRACT', ev, eu), -0.001, 0.001, 0.0, 1.0)     # 1 nearer a short edge

    along = N.n('ShaderNodeMix', data_type='FLOAT')
    N.link(short, along.inputs['Factor'])
    N.link(u, along.inputs['A'])
    N.link(v, along.inputs['B'])

    ivory, navy, red, gold = lin('#CDBB98'), lin('#1D2740'), lin('#6A1C1A'), lin('#B58B45')

    # field: red under a diagonal navy lattice with gold knots
    d1 = _nm(N, 'ABSOLUTE', _nm(N, 'SUBTRACT', _nm(N, 'FRACT', _nm(N, 'DIVIDE', _nm(N, 'ADD', u, v), 0.30)), 0.5))
    d2 = _nm(N, 'ABSOLUTE', _nm(N, 'SUBTRACT', _nm(N, 'FRACT', _nm(N, 'DIVIDE', _nm(N, 'SUBTRACT', u, v), 0.30)), 0.5))
    lat = _nr(N, _nm(N, 'MINIMUM', d1, d2), 0.050, 0.035, 0.0, 1.0)
    knot = _nr(N, _nm(N, 'ADD', d1, d2), 0.13, 0.10, 0.0, 1.0)
    c = _nmix(N, lat, red, navy)
    c = _nmix(N, knot, c, gold)

    # the medallion: navy, an ivory ring, a red heart
    q = _nm(N, 'SQRT', _nm(N, 'ADD', _nm(N, 'POWER', _nm(N, 'DIVIDE', u, 0.78), 2.0), _nm(N, 'POWER', _nm(N, 'DIVIDE', v, 0.56), 2.0)))
    c = _nmix(N, _nr(N, q, 1.0, 0.98, 0.0, 1.0), c, navy)
    c = _nmix(N, _nr(N, _nm(N, 'ABSOLUTE', _nm(N, 'SUBTRACT', q, 0.62)), 0.035, 0.025, 0.0, 1.0), c, ivory)
    c = _nmix(N, _nr(N, q, 0.46, 0.44, 0.0, 1.0), c, red)
    c = _nmix(N, _nr(N, q, 0.16, 0.14, 0.0, 1.0), c, gold)

    # inner guard, main border with a diamond chain, outer guard
    across = _nm(N, 'SUBTRACT', e, 0.205)
    dia = _nm(N, 'ADD', _nm(N, 'MULTIPLY', _nm(N, 'ABSOLUTE', _nm(N, 'SUBTRACT', _nm(N, 'FRACT', _nm(N, 'DIVIDE', along.outputs['Result'], 0.24)), 0.5)), 0.24),
              _nm(N, 'ABSOLUTE', across))
    border = _nmix(N, _nr(N, dia, 0.095, 0.085, 0.0, 1.0), navy, gold)
    border = _nmix(N, _nr(N, dia, 0.045, 0.037, 0.0, 1.0), border, red)
    c = _nmix(N, _nr(N, e, 0.40, 0.39, 0.0, 1.0), c, ivory)
    c = _nmix(N, _nr(N, e, 0.34, 0.33, 0.0, 1.0), c, border)
    c = _nmix(N, _nr(N, e, 0.07, 0.06, 0.0, 1.0), c, ivory)

    # wool: fibre noise, and an abrash (the dye lot shifting in bands down the length)
    fib = N.n('ShaderNodeTexNoise', i_Scale=160.0, i_Detail=4.0, i_Roughness=0.7)
    N.link(tc.outputs['Object'], fib.inputs['Vector'])

    ab = N.n('ShaderNodeTexNoise', i_Scale=1.6, i_Detail=2.0)
    N.link(tc.outputs['Object'], ab.inputs['Vector'])

    sc = N.n('ShaderNodeVectorMath', operation='SCALE')
    N.link(c, sc.inputs[0])
    N.link(_nm(N, 'MULTIPLY', _nr(N, fib.outputs['Fac'], 0.3, 0.7, 0.86, 1.08), _nr(N, ab.outputs['Fac'], 0.35, 0.65, 0.92, 1.06)),
           sc.inputs['Scale'])
    N.link(sc.outputs['Vector'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.96

    bump = N.n('ShaderNodeBump', i_Strength=0.3, i_Distance=0.003)
    N.link(fib.outputs['Fac'], bump.inputs['Height'])
    N.link(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return m


def mat(name, color, rough=0.6, metal=0.0, emit=None, strength=0.0):
    m, N, bsdf, out = K.new_material('room_' + name)
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metal
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1)
        bsdf.inputs['Emission Strength'].default_value = strength

    return m


def boxm(name, c, size, m, coll, rot_z=0.0):
    o = K.box(name, c, size, coll, rot_z=rot_z)
    K.assign(o, m)
    return o


_BOOKS = {}


def books_material():
    m = _BOOKS.get('mat')
    if m is None or m.name not in bpy.data.materials:
        m, N, bsdf, out = K.new_material('room_books')

        at = N.n('ShaderNodeAttribute', attribute_name='bookcol', attribute_type='GEOMETRY')
        N.link(at.outputs['Color'], bsdf.inputs['Base Color'])
        bsdf.inputs['Roughness'].default_value = 0.55
        _BOOKS['mat'] = m

    return m


def books(coll, x0, x1, y, z_shelves, face, seed, depth=0.24):
    """Rows of books from x0 to x1 at wall y (face -1 faces -y), one mesh with per-face colour."""
    rng = random.Random(seed)
    palette = [lin(h) for h in ('#5B1F1C', '#2E3B2A', '#6B5236', '#1F2A3A', '#8C7B5A', '#3B2A20', '#6E2A22',
                                '#2B2B2B', '#9A8A68', '#44503C', '#4A3524', '#7A6040')]
    bm = bmesh.new()
    cols = []

    for zb in z_shelves:
        x = x0 + rng.uniform(0, 0.03)

        while x < x1 - 0.03:
            w = rng.uniform(0.022, 0.055)
            h = rng.uniform(0.20, 0.31)
            dp = depth * rng.uniform(0.80, 0.98)
            lean = rng.uniform(-3, 3) if rng.random() < 0.08 else 0.0
            if rng.random() < 0.05:              # a gap, then a short stack lying flat
                x += rng.uniform(0.05, 0.12)
                continue

            vs = bmesh.ops.create_cube(bm, size=1.0)['verts']
            bmesh.ops.scale(bm, vec=Vector((w, dp, h)), verts=vs)
            if lean:
                bmesh.ops.rotate(bm, cent=Vector((0, 0, -h / 2)), matrix=Matrix.Rotation(math.radians(lean), 3, 'Y'), verts=vs)

            bmesh.ops.translate(bm, vec=Vector((x + w / 2, y - face * (dp / 2 + 0.02), zb + h / 2)), verts=vs)
            c = palette[rng.randrange(len(palette))]
            k = rng.uniform(0.75, 1.1)
            cols.append(tuple(min(1.0, v * k) for v in c))
            x += w + rng.uniform(0.0, 0.004)

    ob = K._bm_object('books', bm, coll)
    me = ob.data
    a = me.attributes.new('bookcol', 'FLOAT_COLOR', 'FACE')
    per_face = []

    for c in cols:
        per_face += [(*c, 1.0)] * 6

    a.data.foreach_set('color', np.array(per_face, dtype=np.float32).ravel())
    K.assign(ob, books_material())

    return ob


def shelf_unit(coll, x0, x1, y, face, z0, z1, n, wood, seed):
    """A bookcase against a wall: carcass, n shelves, filled with books."""
    t = 0.03
    dp = 0.32
    yc = y - face * dp / 2
    boxm('case_back', ((x0 + x1) / 2, y - face * 0.01, (z0 + z1) / 2), (x1 - x0, 0.02, z1 - z0), wood, coll)

    for x in (x0, x1):
        boxm('case_side', (x, yc, (z0 + z1) / 2), (t, dp, z1 - z0), wood, coll)

    zs = [z0 + (z1 - z0) * i / n for i in range(n + 1)]

    for z in zs:
        boxm('shelf', ((x0 + x1) / 2, yc, z), (x1 - x0, dp, t), wood, coll)

    books(coll, x0 + t, x1 - t, y - face * 0.03, [z + t / 2 for z in zs[:-1]], face, seed, depth=dp - 0.06)


def lamp_shade(coll, c, r0, r1, h, shade_mat, bulb_mat):
    """A drum shade glowing from inside, with the bulb."""
    s = K.cylinder('shade', c, r0, h, coll, 48, r2=r1)
    K.assign(s, shade_mat)
    b = K.uv_sphere('bulb', (c[0], c[1], c[2] - h * 0.1), min(r0, r1) * 0.35, coll, 24, 12)
    K.assign(b, bulb_mat)

    return s


def point(coll, name, loc, energy, color, radius=0.08):
    ld = bpy.data.lights.new(name, 'POINT')
    ld.energy = energy
    ld.color = color
    ld.shadow_soft_size = radius
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    K.link(ob, coll)

    return ob


def build(size=2048, samples=384):
    coll = K.collection(COLL, clear=True)
    _BOOKS.clear()
    hw, hd = W / 2, D / 2

    # materials: mid-value, near-neutral walls; the warmth comes from the lamps
    wall = mat('wall', lin('#454C4A'), 0.85)
    panel = mat('panel', lin('#3A322C'), 0.45)
    wood = mat('wood', lin('#2A1D15'), 0.40)
    floor_m = parquet_mat()
    rug = rug_mat(1.7, 1.4)
    ceil = mat('ceiling', lin('#3A3D3E'), 0.9)
    stone = stone_mat()
    brass = mat('brass', lin('#B08D57'), 0.35, 1.0)
    shade = mat('shade', lin('#E9DCC0'), 0.8, emit=lin('#FFE4C8'), strength=2.2)
    bulb = mat('bulb', (1, 1, 1), 0.5, emit=lin('#FFE6C8'), strength=30.0)
    fire = mat('fire', lin('#000000'), 1.0, emit=lin('#FF7A2A'), strength=14.0)
    embers = mat('embers', lin('#000000'), 1.0, emit=lin('#FF4A10'), strength=6.0)
    night = mat('night', lin('#000000'), 1.0, emit=lin('#3B4C66'), strength=1.0)
    curtain = mat('curtain', lin('#4E1F1F'), 0.9)
    leather = mat('leather', lin('#3A2218'), 0.5)
    canvas = mat('canvas', lin('#5C4A36'), 0.7)
    gilt = mat('gilt', lin('#B8914A'), 0.3, 1.0)

    # shell: floor, rug, beamed ceiling, walls with wainscot and dado rail
    boxm('floor', (0, 0, -0.02), (W, D, 0.04), floor_m, coll)
    boxm('rug', (0, 0, 0.005), (3.4, 2.8, 0.01), rug, coll)
    boxm('ceiling', (0, 0, H + 0.02), (W, D, 0.04), ceil, coll)

    for i in range(-2, 3):
        boxm('beam', (i * 1.5, 0, H - 0.09), (0.16, D, 0.18), wood, coll)

    for (c, s) in (((0, hd, H / 2), (W, 0.04, H)), ((0, -hd, H / 2), (W, 0.04, H)),
                   ((hw, 0, H / 2), (0.04, D, H)), ((-hw, 0, H / 2), (0.04, D, H))):
        boxm('wall', c, s, wall, coll)

    for (c, s) in (((0, hd - 0.03, 0.5), (W, 0.03, 1.0)), ((0, -hd + 0.03, 0.5), (W, 0.03, 1.0)),
                   ((hw - 0.03, 0, 0.5), (0.03, D, 1.0)), ((-hw + 0.03, 0, 0.5), (0.03, D, 1.0))):
        boxm('wainscot', c, s, panel, coll)

    for (c, s) in (((0, hd - 0.05, 1.0), (W, 0.05, 0.05)), ((0, -hd + 0.05, 1.0), (W, 0.05, 0.05)),
                   ((hw - 0.05, 0, 1.0), (0.05, D, 0.05)), ((-hw + 0.05, 0, 1.0), (0.05, D, 0.05))):
        boxm('rail', c, s, wood, coll)

    # north: a wall of books between two brass sconces
    shelf_unit(coll, -2.6, 2.6, hd - 0.02, 1, 0.06, 2.55, 6, wood, 11)

    for sx in (-3.05, 3.05):
        boxm('sconce', (sx, hd - 0.10, 1.9), (0.06, 0.12, 0.30), brass, coll)
        lamp_shade(coll, (sx, hd - 0.24, 2.02), 0.10, 0.07, 0.16, shade, bulb)
        point(coll, 'sconce_light', (sx, hd - 0.26, 2.00), 24.0, lin('#FFE2C4'), 0.06)

    # south: the fireplace, a painting above, short cases either side
    y = -hd + 0.02
    boxm('chimney', (0, y + 0.25, 1.55), (1.9, 0.5, 3.1), stone, coll)
    boxm('mantel', (0, y + 0.56, 1.25), (2.1, 0.22, 0.08), wood, coll)
    boxm('surround', (0, y + 0.52, 0.62), (1.6, 0.12, 1.24), stone, coll)
    boxm('firebox', (0, y + 0.49, 0.46), (0.95, 0.14, 0.78), mat('soot', lin('#0C0A09'), 1.0), coll)
    boxm('fire', (0, y + 0.44, 0.30), (0.62, 0.10, 0.34), fire, coll)
    boxm('embers', (0, y + 0.47, 0.13), (0.75, 0.16, 0.06), embers, coll)
    point(coll, 'fire_light', (0, y + 0.40, 0.30), 80.0, lin('#FF9A55'), 0.3)

    # over the mantel: a landscape in a gilt frame, candlesticks and a clock
    boxm('frame', (0, y + 0.53, 2.02), (1.42, 0.05, 1.06), gilt, coll)
    boxm('painting_land', (0, y + 0.56, 1.86), (1.28, 0.03, 0.60), mat('land', lin('#3E4A3A'), 0.7), coll)
    boxm('painting_sky', (0, y + 0.56, 2.34), (1.28, 0.03, 0.36), mat('sky', lin('#8C9AA2'), 0.7), coll)
    for sx in (-0.78, 0.78):
        boxm('candlestick', (sx, y + 0.58, 1.40), (0.05, 0.05, 0.24), brass, coll)
        boxm('candle', (sx, y + 0.58, 1.58), (0.03, 0.03, 0.12), mat('wax', lin('#E8E0D0'), 0.6), coll)
        boxm('flame', (sx, y + 0.58, 1.66), (0.014, 0.014, 0.03), fire, coll)

    boxm('clock', (0, y + 0.60, 1.40), (0.30, 0.12, 0.22), wood, coll)
    boxm('clock_face', (0, y + 0.66, 1.41), (0.16, 0.01, 0.14), mat('clockface', lin('#E6DDC8'), 0.5), coll)
    shelf_unit(coll, -3.3, -1.25, y, -1, 0.06, 1.65, 4, wood, 12)
    shelf_unit(coll, 1.25, 3.3, y, -1, 0.06, 1.65, 4, wood, 13)

    for sx in (-2.3, 2.3):
        lamp_shade(coll, (sx, y + 0.20, 1.86), 0.14, 0.10, 0.22, shade, bulb)
        boxm('lampbase', (sx, y + 0.20, 1.72), (0.08, 0.08, 0.12), brass, coll)
        point(coll, 'shelf_lamp', (sx, y + 0.32, 1.84), 20.0, lin('#FFE2C4'), 0.08)

    # east: the night window, heavy curtains, a floor lamp
    x = hw - 0.02
    boxm('window', (x - 0.01, 0.3, 1.65), (0.02, 1.4, 2.0), night, coll)

    for (yy, zz, sy, sz) in ((0.3, 1.65, 0.05, 2.0), (0.3, 1.65, 1.4, 0.05)):
        boxm('mullion', (x - 0.03, yy, zz), (0.03, sy, sz), wood, coll)

    boxm('sill', (x - 0.10, 0.3, 0.62), (0.2, 1.6, 0.05), wood, coll)

    for yy in (-0.62, 1.22):
        for k in range(5):
            boxm('curtain', (x - 0.12 + 0.03 * math.sin(k * 2.1), yy + (k - 2) * 0.09, 1.55), (0.08, 0.1, 2.9), curtain, coll)

    boxm('lamp_pole', (x - 0.6, -1.6, 0.8), (0.03, 0.03, 1.6), brass, coll)
    lamp_shade(coll, (x - 0.6, -1.6, 1.62), 0.22, 0.16, 0.30, shade, bulb)
    point(coll, 'floor_lamp', (x - 0.6, -1.6, 1.58), 45.0, lin('#FFE2C4'), 0.1)
    boxm('chair', (x - 0.9, -2.3, 0.42), (0.9, 0.9, 0.84), leather, coll)
    boxm('frame', (x - 0.03, 2.25, 1.75), (0.04, 0.95, 0.72), gilt, coll)
    boxm('painting', (x - 0.05, 2.25, 1.75), (0.03, 0.83, 0.60), mat('canvas2', lin('#34424A'), 0.7), coll)

    # west: books, an armchair, a table lamp
    x = -hw + 0.02
    wall_books_w = []

    for yy0, yy1, seed in ((-2.9, -0.4, 15), (0.4, 2.9, 16)):
        # a bookcase along the west wall (rotated: built along x then turned)
        before = set(o.name for o in coll.objects)
        shelf_unit(coll, yy0, yy1, 0.0, 1, 0.06, 2.3, 5, wood, seed)

        for o in coll.objects:
            if o.name not in before:
                wall_books_w.append(o)

    for o in wall_books_w:
        o.rotation_euler.z = math.radians(90)
        o.location = (x, 0, 0)

    bpy.context.view_layer.update()
    boxm('armchair', (x + 0.7, 0.0, 0.45), (0.85, 0.9, 0.9), leather, coll)
    boxm('frame', (x + 0.03, 0.0, 1.85), (0.04, 0.62, 0.50), gilt, coll)
    boxm('painting', (x + 0.05, 0.0, 1.85), (0.03, 0.52, 0.40), mat('canvas3', lin('#5A3A2C'), 0.7), coll)
    boxm('side_table', (x + 0.6, 0.9, 0.3), (0.45, 0.45, 0.6), wood, coll)
    lamp_shade(coll, (x + 0.6, 0.9, 0.98), 0.16, 0.11, 0.24, shade, bulb)
    boxm('table_lamp', (x + 0.6, 0.9, 0.74), (0.05, 0.05, 0.28), brass, coll)
    point(coll, 'table_lamp_light', (x + 0.6, 0.9, 0.95), 26.0, lin('#FFE2C4'), 0.08)

    # a dim pendant over the table, so the ceiling is not a void
    lamp_shade(coll, (0, 0, H - 0.55), 0.26, 0.20, 0.22, shade, bulb)
    point(coll, 'pendant', (0, 0, H - 0.62), 16.0, lin('#FFE2C4'), 0.12)

    # the soft, cool fill from above that sets every wall at a mid value
    ld = bpy.data.lights.new('ceiling_fill', 'AREA')
    ld.shape = 'RECTANGLE'
    ld.size, ld.size_y = 5.0, 4.6
    ld.energy = 95.0
    ld.color = lin('#F3EEE8')
    fill = bpy.data.objects.new('ceiling_fill', ld)
    fill.location = (0, 0, H - 0.25)
    K.link(fill, coll)

    return render(coll, size, samples)


def render(coll, size=2048, samples=384):
    sc = bpy.context.scene
    cam_d = bpy.data.cameras.get('__room_cam') or bpy.data.cameras.new('__room_cam')
    cam = bpy.data.objects.get('__room_cam') or bpy.data.objects.new('__room_cam', cam_d)
    if cam.name not in coll.objects:
        K.link(cam, coll)

    cam_d.type = 'PANO'
    try:
        cam_d.panorama_type = 'EQUIRECTANGULAR'
    except AttributeError:
        cam_d.cycles.panorama_type = 'EQUIRECTANGULAR'

    cam.location = (0, 0, EYE)
    cam.rotation_euler = (math.radians(90), 0, 0)

    keep = list(coll.objects)
    restore = K.hide_others(keep)

    old = (sc.camera, sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage,
           sc.view_settings.view_transform, sc.view_settings.look, sc.world)
    try:
        sc.camera = cam
        sc.render.resolution_x, sc.render.resolution_y = size, size // 2
        sc.render.resolution_percentage = 100

        K.setup_cycles(samples)
        sc.cycles.use_denoising = True
        sc.view_settings.view_transform = 'Standard'
        sc.view_settings.look = 'None'

        w = bpy.data.worlds.get('__room_world') or bpy.data.worlds.new('__room_world')
        w.use_nodes = True
        bg = w.node_tree.nodes.get('Background')
        bg.inputs['Color'].default_value = (0, 0, 0, 1)
        sc.world = w

        tmp = os.path.join(K.WORK, 'room', 'study_full.hdr')
        os.makedirs(os.path.dirname(tmp), exist_ok=True)
        sc.render.image_settings.file_format = 'HDR'
        sc.render.filepath = tmp
        bpy.ops.render.render(write_still=True)
    finally:
        sc.camera, sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = old[:4]
        sc.view_settings.view_transform, sc.view_settings.look, sc.world = old[4:]
        restore()

    # half size for the app: the board blurs it anyway, and it keeps the single-file build lean
    img = bpy.data.images.load(tmp, check_existing=False)
    a = K.image_to_np(img)
    h2, w2 = a.shape[0] // 2, a.shape[1] // 2
    small = a[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, 4).mean(axis=(1, 3))

    out = bpy.data.images.new('__study_small', w2, h2, alpha=False, float_buffer=True)
    out.pixels.foreach_set(small.astype(np.float32).ravel())
    out.filepath_raw = OUT
    out.file_format = 'HDR'
    out.save()

    bpy.data.images.remove(img)
    bpy.data.images.remove(out)

    lum = small[..., :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)

    return {'full': tmp, 'out': OUT, 'kb': round(os.path.getsize(OUT) / 1024), 'mean': float(lum.mean()),
            'p99': float(np.percentile(lum, 99)), 'max': float(lum.max())}
