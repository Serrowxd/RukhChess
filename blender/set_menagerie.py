"""Menagerie -- chess pieces with a woodland in them, porcelain against patinated bronze."""
import math
import bpy
import numpy as np
import cbkit as K
from cbkit import Turn

SET_ID = 'menagerie'
COLL = 'set_menagerie'
SEG = 96
VS = 0.0022           # SDF voxel size
HI_TRIS = 150000      # sculpt density of an animal (it is only baked from)
LOW_TRIS = {'pawn': 14000, 'rook': 20000, 'knight': 24000, 'bishop': 20000, 'queen': 24000, 'king': 26000}
TURN = 35.0           # degrees the animals (not the horse) turn off axis, for a three-quarter view


# SDF shorthands (each evaluated only inside the primitive's own box)

def ell(g, d, c, r, k=0.02, rot=None, op='union'):
    m = max(r)
    return g.add(d, lambda P: K.sd_ellipsoid(P, c, r, rot), [c[i] - m for i in range(3)], [c[i] + m for i in range(3)], k, op)


def sph(g, d, c, r, k=0.02, op='union'):
    return g.add(d, lambda P: K.sd_sphere(P, c, r), [c[i] - r for i in range(3)], [c[i] + r for i in range(3)], k, op)


def cap(g, d, a, b, r1, r2=None, k=0.02, op='union'):
    r2 = r1 if r2 is None else r2
    m = max(r1, r2)
    lo = [min(a[i], b[i]) - m for i in range(3)]
    hi = [max(a[i], b[i]) + m for i in range(3)]

    return g.add(d, lambda P: K.sd_capsule(P, a, b, r1, r2), lo, hi, k, op)


def chain(g, d, pts, radii, k=0.02, op='union', kin=0.0):
    lo, hi = K.chain_box(pts, radii)
    return g.add(d, lambda P: K.sd_chain(P, pts, radii, kin), lo, hi, k, op)


def floor_cut(g, d, z):
    """Flatten the underside at height z (the seat on the turned body)."""
    return np.maximum(d, np.float32(z) - g.Z)


def sdf_mesh(g, d, name, coll, target_tris=None):
    ob = g.to_mesh(d, name, coll)
    K.keep_largest_parts(ob, 0.02)
    K.decimate(ob, target_tris=target_tris or HI_TRIS)
    ob.data.shade_smooth()

    return ob


# Turned bodies: a Regency-flavoured foot (plinth, torus, deep cove), baluster stems, wide collars

def foot(t, R, zf, rs):
    k = zf / 0.18

    t.line(R * 0.55, 0.0).line(R - 0.010, 0.0)
    t.arc(R - 0.010, 0.010, 0.010, -90, 0, 5)
    t.line(R, 0.026 * k).crease()
    t.line(R - 0.008, 0.029 * k).crease()

    b = 0.020 * k
    t.arc(R - 0.008, 0.029 * k + b, b, -90, 90, 10).crease()             # torus
    z1 = 0.029 * k + 2 * b
    t.line(R - 0.020, z1 + 0.004 * k).crease()

    r2 = R * 0.60
    t.curve((R - 0.060, z1 + 0.006 * k), (r2 + 0.010, 0.118 * k), (r2, 0.126 * k), 12).crease()   # cove
    t.arc(r2, 0.126 * k + 0.008 * k, 0.008 * k, -90, 90, 6).crease()     # bead (gilded)
    _BANDS.append((0.126 * k - 0.001, 0.142 * k + 0.001, r2 + 0.0015))

    t.line(rs + 0.010, 0.145 * k).crease()
    t.curve((rs + 0.004, 0.155 * k), (rs, zf - 0.010), (rs, zf), 4)

    return t


def baluster(t, z_top, r_neck, r_top):
    """Slender stem from the current point to z_top with a waist, ending at r_top."""
    r0, z0 = t.at()
    h = z_top - z0
    t.curve((r0 - 0.010, z0 + h * 0.30), (r_neck, z0 + h * 0.55), (r_neck, z0 + h * 0.72), 12)
    t.curve((r_neck, z0 + h * 0.86), (r_top - 0.006, z_top - 0.012), (r_top, z_top), 6)

    return t


def collar(t, z, r_disc, r_bead, s=1.0):
    """A wide rounded disc then a smaller (gilded) bead; returns the height above it."""
    t.crease()
    t.line(r_disc - 0.012 * s, z + 0.004 * s, 2)
    t.arc(r_disc - 0.012 * s, z + 0.016 * s, 0.012 * s, -90, 90, 9).crease()
    z2 = z + 0.028 * s
    t.line(r_bead, z2 + 0.003 * s).crease()
    t.arc(r_bead, z2 + 0.011 * s, 0.008 * s, -90, 90, 7).crease()
    _BANDS.append((z2 + 0.002 * s, z2 + 0.020 * s, r_bead + 0.0015))

    return z2 + 0.019 * s


def seat(t, z, r):
    """A flat seat for an animal to sit on, closing the profile on the axis."""
    t.line(r, z).crease()
    t.line(0.0, z, 5)
    return t


# Pawn: a hedgehog rolled into the pawn's ball

def pawn_body(coll):
    t = Turn()
    foot(t, 0.190, 0.130, 0.095)
    baluster(t, 0.296, 0.056, 0.074)
    zc = collar(t, 0.296, 0.122, 0.086, 0.9)
    t.line(0.070, zc + 0.004).crease()
    seat(t, zc + 0.010, 0.066)

    return K.lathe('menagerie_pawn_turned', t, SEG, coll), zc + 0.010


def fib_dirs(n):
    """n roughly even directions on the unit sphere (Fibonacci lattice)."""
    out = []
    ga = math.pi * (3 - math.sqrt(5))

    for i in range(n):
        z = 1 - 2 * (i + 0.5) / n
        r = math.sqrt(max(0.0, 1 - z * z))
        a = ga * i
        out.append((r * math.cos(a), r * math.sin(a), z))

    return out


def _box(c, pad):
    """lo, hi of an axis-aligned box of half-size pad around c (for carve's sub-grid)."""
    return [c[i] - pad for i in range(3)], [c[i] + pad for i in range(3)]



def hedgehog(coll, z0):
    c = (0.0, 0.010, z0 + 0.118)
    R = (0.114, 0.124, 0.110)
    g = K.Grid((-0.19, -0.21, z0 - 0.02), (0.19, 0.24, z0 + 0.31), VS)
    d = g.empty()
    d = ell(g, d, c, R, 0.0)

    # face: pointed snout tucked down, button nose, tiny ears, eyes; forepaws folded under the chin
    d = ell(g, d, (0, -0.092, z0 + 0.094), (0.046, 0.062, 0.042), 0.030, K.rot_matrix([('X', 14)]))
    d = sph(g, d, (0, -0.152, z0 + 0.084), 0.013, 0.008)

    for s in (-1, 1):
        d = sph(g, d, (s * 0.038, -0.098, z0 + 0.120), 0.0105, 0.003)
        d = ell(g, d, (s * 0.062, -0.066, z0 + 0.150), (0.016, 0.010, 0.016), 0.006)

    FACE_GILT[:] = [((s * 0.038, -0.098, z0 + 0.120), 0.0105) for s in (-1, 1)] + [((0, -0.152, z0 + 0.084), 0.013)]

    for s in (-1, 1):
        d = ell(g, d, (s * 0.034, -0.080, z0 + 0.030), (0.016, 0.022, 0.012), 0.014)

    # quills: chunky and blunt, combed back from the face and carved into the body
    f = (0.0, -0.8, 0.45)
    fl = math.sqrt(sum(v * v for v in f))
    f = tuple(v / fl for v in f)

    for i, (x, y, z) in enumerate(fib_dirs(190)):
        face = -y * 0.93 - z * 0.37
        if face > 0.30 or z < -0.55:
            continue

        base = (c[0] + x * R[0] * 0.88, c[1] + y * R[1] * 0.88, c[2] + z * R[2] * 0.88)
        n = (x / R[0], y / R[1], z / R[2])
        nl = math.sqrt(sum(v * v for v in n))
        n = tuple(v / nl for v in n)

        nf = sum(a * b for a, b in zip(n, f))
        t = tuple(a * nf - b for a, b in zip(n, f))
        tl = math.sqrt(sum(v * v for v in t)) or 1.0
        dvec = tuple(a / tl + 0.18 * b for a, b in zip(t, n))
        dl = math.sqrt(sum(v * v for v in dvec))

        ln = 0.058 + 0.008 * math.sin(i * 12.9898)
        tip = tuple(b + v / dl * ln for b, v in zip(base, dvec))
        d = cap(g, d, base, tip, 0.016, 0.0055, 0.005)

    d = floor_cut(g, d, z0 - 0.004)

    return sdf_mesh(g, d, 'menagerie_pawn_top', coll)


# Rook: a turret, and a bear cub looking over the battlements

ROOK_FLOOR = 0.585
ROOK_TOP = 0.668


def rook_body(coll):
    t = Turn()
    foot(t, 0.228, 0.150, 0.150)

    t.curve((0.146, 0.230), (0.137, 0.330), (0.136, 0.405), 12).crease()

    t.line(0.142, 0.409)
    t.arc(0.142, 0.421, 0.012, -90, 90, 8).crease()
    t.line(0.138, 0.437).crease()

    t.curve((0.150, 0.465), (0.192, 0.505), (0.202, 0.545), 12)
    t.line(0.203, 0.556).crease()
    t.line(0.209, 0.560).crease()

    t.line(0.209, ROOK_TOP).crease()
    t.arc(0.202, ROOK_TOP, 0.007, 0, 90, 4)
    t.line(0.172, ROOK_TOP + 0.007).crease()
    t.arc(0.172, ROOK_TOP, 0.007, 90, 180, 4).crease()

    t.line(0.165, ROOK_FLOOR).crease()
    t.line(0.0, ROOK_FLOOR, 6)

    return K.lathe('menagerie_rook_turned', t, SEG, coll)


def bear(coll):
    g = K.Grid((-0.19, -0.26, ROOK_FLOOR - 0.03), (0.19, 0.17, ROOK_TOP + 0.17), VS)
    d = g.empty()
    hz = ROOK_TOP - 0.004

    # a bigger cub: a broad skull with a domed brow, rising out of the well
    d = ell(g, d, (0, -0.026, hz), (0.104, 0.094, 0.090), 0.0)
    d = ell(g, d, (0, 0.022, hz - 0.090), (0.096, 0.090, 0.090), 0.045)          # shoulders in the well

    # a proper snout: about two fifths of the head, forward and a little down, with a broad nose
    d = ell(g, d, (0, -0.120, hz - 0.026), (0.054, 0.060, 0.042), 0.026)
    d = ell(g, d, (0, -0.172, hz - 0.018), (0.026, 0.017, 0.018), 0.009)         # nose
    FACE_GILT[:] = [((0, -0.172, hz - 0.018), 0.019)]
    d = cap(g, d, (0, -0.176, hz - 0.046), (0, -0.150, hz - 0.058), 0.004, 0.004, 0.003, 'sub')   # mouth

    for s in (-1, 1):
        d = sph(g, d, (s * 0.040, -0.110, hz + 0.024), 0.0095, 0.003)          # eyes, close to the snout
        FACE_GILT.append(((s * 0.040, -0.110, hz + 0.024), 0.0095))

        # round ears on top of the head, a little apart, cupped forward: the silhouette that says 'bear'
        d = ell(g, d, (s * 0.066, 0.004, hz + 0.084), (0.032, 0.019, 0.031), 0.012, K.rot_matrix([('Y', s * -32)]))
        d = sph(g, d, (s * 0.068, -0.013, hz + 0.084), 0.017, 0.004, 'sub')

        # forepaws over the front parapet, arms running back into the well
        d = cap(g, d, (s * 0.074, -0.060, hz - 0.074), (s * 0.082, -0.166, ROOK_TOP + 0.014), 0.034, 0.029, 0.026)
        d = ell(g, d, (s * 0.084, -0.190, ROOK_TOP + 0.014), (0.038, 0.040, 0.022), 0.016)

        for j in (-1, 0, 1):
            d = sph(g, d, (s * 0.084 + j * 0.016, -0.224, ROOK_TOP + 0.016), 0.009, 0.004)

    d = floor_cut(g, d, ROOK_FLOOR - 0.004)

    return sdf_mesh(g, d, 'menagerie_rook_top', coll)


# Knight: a horse with a flowing mane

def knight_body(coll):
    t = Turn()
    foot(t, 0.228, 0.150, 0.130)
    t.curve((0.124, 0.190), (0.116, 0.222), (0.118, 0.238), 6)
    zc = collar(t, 0.238, 0.160, 0.140, 1.0)
    t.line(0.140, zc + 0.004).crease()
    seat(t, zc + 0.008, 0.140)

    return K.lathe('menagerie_knight_turned', t, SEG, coll), zc + 0.008


def horse(coll, z0):
    # side silhouette (x forward, z up) inflated into a volume, then features. Authored facing +X.
    sil = [
        (0.110, z0 - 0.10), (0.114, z0 + 0.010), (0.130, z0 + 0.080), (0.138, z0 + 0.140), (0.132, z0 + 0.180),
        (0.122, z0 + 0.210), (0.124, z0 + 0.230), (0.160, z0 + 0.238), (0.200, z0 + 0.246), (0.236, z0 + 0.256),
        (0.262, z0 + 0.270), (0.280, z0 + 0.292), (0.286, z0 + 0.318), (0.278, z0 + 0.344), (0.258, z0 + 0.360),
        (0.226, z0 + 0.378), (0.188, z0 + 0.400), (0.150, z0 + 0.426), (0.116, z0 + 0.450), (0.092, z0 + 0.470),
        (0.084, z0 + 0.500), (0.070, z0 + 0.534), (0.054, z0 + 0.540), (0.042, z0 + 0.518), (0.028, z0 + 0.494),
        (0.004, z0 + 0.486), (-0.034, z0 + 0.470), (-0.074, z0 + 0.440), (-0.108, z0 + 0.396), (-0.132, z0 + 0.336),
        (-0.146, z0 + 0.270), (-0.150, z0 + 0.200), (-0.146, z0 + 0.120), (-0.138, z0 + 0.040), (-0.132, z0 - 0.10),
    ]

    xs = [p[0] for p in sil]
    zs = [p[1] for p in sil]
    field = K.Field2D(sil, (min(xs), min(zs)), (max(xs), max(zs)), res=0.0008, pad=0.06)

    g = K.Grid((-0.22, -0.15, z0 - 0.02), (0.33, 0.15, z0 + 0.58), VS)
    X, Y, Z = g.P

    head = np.clip((Z - (z0 + 0.19)) / 0.13, 0, 1)
    fwd = np.clip((X - 0.05) / 0.23, 0, 1)
    half = 0.080 * (1 - head) + head * (0.088 - 0.052 * fwd)
    ears = np.clip((Z - (z0 + 0.476)) / 0.03, 0, 1)
    half = (half * (1 - ears) + ears * 0.050).astype(np.float32)

    d = K.sd_inflate(g.P, field, half, depth=0.058, axis='Y')

    zc = z0 + 0.300
    HORSE_BRIDLE.clear()

    for s in (-1, 1):
        d = ell(g, d, (0.088, s * 0.046, zc - 0.012), (0.066, 0.032, 0.056), 0.028)          # jowls
        d = ell(g, d, (0.110, s * 0.050, zc + 0.108), (0.028, 0.016, 0.013), 0.012)          # brows
        d = sph(g, d, (0.113, s * 0.086, zc + 0.090), 0.019, 0.007, 'sub')                   # eye sockets
        d = ell(g, d, (0.113, s * 0.062, zc + 0.090), (0.015, 0.010, 0.012), 0.004)          # eyes
        d = ell(g, d, (0.268, s * 0.023, zc + 0.032), (0.006, 0.010, 0.019), 0.005, K.rot_matrix([('Z', s * 38), ('X', s * -12)]), 'sub')
        d = cap(g, d, (0.284, s * 0.040, zc - 0.006), (0.206, s * 0.052, zc - 0.028), 0.005, 0.005, 0.005, 'sub')

        # a gilded bridle: noseband, cheek strap, the ring where they meet
        for a, b in (((0.196, s * 0.050, zc + 0.014), (0.200, s * 0.004, zc + 0.070)),
                     ((0.128, s * 0.074, zc + 0.012), (0.196, s * 0.052, zc + 0.014)),
                     ((0.128, s * 0.074, zc + 0.012), (0.060, s * 0.058, zc + 0.140))):
            d = cap(g, d, a, b, 0.0060, 0.0060, 0.004)
            HORSE_BRIDLE.append((a, b))

        d = sph(g, d, (0.128, s * 0.078, zc + 0.012), 0.010, 0.004)
        HORSE_BRIDLE.append(((0.128, s * 0.078, zc + 0.012), (0.128, s * 0.078, zc + 0.012)))

    d = K.subtract(d, K.sd_box(g.P, (0.050, 0.0, z0 + 0.525), (0.058, 0.009, 0.050), r=0.004), 0.006)   # two ears

    # mane: a raised band along the crest, cut into locks by V-grooves running down and back
    crest = [(0.010, z0 + 0.488), (-0.034, z0 + 0.472), (-0.074, z0 + 0.442), (-0.108, z0 + 0.398),
             (-0.132, z0 + 0.338), (-0.146, z0 + 0.272), (-0.150, z0 + 0.200), (-0.147, z0 + 0.130)]
    crest3 = [(x, 0.0, z) for x, z in crest]
    tube = lambda P: K.sd_chain(P, crest3, [0.052] * len(crest3))
    band = K.intersect(d - np.float32(0.011), tube(g.P), 0.010)
    d = K.smin(d, band, 0.008)
    L = [0.0]

    for i in range(1, len(crest)):
        L.append(L[-1] + math.dist(crest[i - 1], crest[i]))

    n_locks = 12
    tb = math.tan(math.radians(38))

    for i in range(n_locks):
        sL = (i + 0.5) / n_locks * L[-1]
        j = max(k for k in range(len(L) - 1) if L[k] <= sL)
        f = (sL - L[j]) / (L[j + 1] - L[j])
        cx = crest[j][0] + (crest[j + 1][0] - crest[j][0]) * f
        cz = crest[j][1] + (crest[j + 1][1] - crest[j][1]) * f
        tx, tz = crest[j + 1][0] - crest[j][0], crest[j + 1][1] - crest[j][1]
        tl = math.hypot(tx, tz)
        tx, tz = tx / tl, tz / tl                     # down the crest

        for s in (-1, 1):
            nrm = (tx, -s * tb, tz)
            nl = math.sqrt(sum(v * v for v in nrm))
            nrm = tuple(v / nl for v in nrm)
            lo, hi = _box((cx, 0.0, cz), 0.10)

            def sheet(P, cx=cx, cz=cz, nrm=nrm):
                return (P[0] - np.float32(cx)) * np.float32(nrm[0]) + P[1] * np.float32(nrm[1]) + (P[2] - np.float32(cz)) * np.float32(nrm[2])

            def region(P, s=s):
                return np.maximum(np.float32(-s) * P[1] - np.float32(0.002), tube(P) - np.float32(0.050))

            d = K.carve(g, d, lo, hi, sheet, 0.0042, 0.009, region, 0.002)

    # forelock between the ears
    d = chain(g, d, [(0.040, 0.0, z0 + 0.492), (0.080, -0.010, z0 + 0.470), (0.100, 0.004, z0 + 0.440)], [0.016, 0.012, 0.004], 0.010, kin=0.004)
    d = floor_cut(g, d, z0 - 0.010)

    return sdf_mesh(g, d, 'menagerie_knight_top', coll)


# Bishop: the mitre is an owl

def bishop_body(coll):
    t = Turn()
    foot(t, 0.214, 0.160, 0.110)
    baluster(t, 0.440, 0.066, 0.086)
    zc = collar(t, 0.440, 0.142, 0.108, 0.95)
    t.line(0.094, zc + 0.004).crease()
    seat(t, zc + 0.010, 0.090)

    return K.lathe('menagerie_bishop_turned', t, SEG, coll), zc + 0.010


def owl(coll, z0):
    """The mitre as an owl, its ear tufts making the cleft."""
    g = K.Grid((-0.17, -0.16, z0 - 0.02), (0.17, 0.19, z0 + 0.43), VS)
    d = g.empty()
    d = ell(g, d, (0, 0.008, z0 + 0.125), (0.108, 0.100, 0.130), 0.0)
    d = ell(g, d, (0, -0.014, z0 + 0.090), (0.100, 0.092, 0.090), 0.040)
    d = ell(g, d, (0, 0.000, z0 + 0.255), (0.100, 0.092, 0.086), 0.055)

    for s in (-1, 1):
        d = cap(g, d, (s * 0.056, 0.006, z0 + 0.296), (s * 0.084, 0.024, z0 + 0.404), 0.032, 0.005, 0.024)   # ear tufts

    d = ell(g, d, (0, -0.118, z0 + 0.262), (0.086, 0.040, 0.078), 0.016, None, 'sub')                     # facial disc
    OWL_EYES.clear()

    for s in (-1, 1):
        e = (s * 0.036, -0.074, z0 + 0.276)
        d = sph(g, d, e, 0.027, 0.005)
        d = sph(g, d, (s * 0.036, -0.100, z0 + 0.276), 0.0115, 0.002, 'sub')
        OWL_EYES.append(e)
        d = cap(g, d, (s * 0.070, -0.078, z0 + 0.310), (0.0, -0.092, z0 + 0.286), 0.008, 0.006, 0.008)       # brows

    d = cap(g, d, (0, -0.086, z0 + 0.258), (0, -0.114, z0 + 0.232), 0.013, 0.004, 0.007)                     # beak
    wc, wr = 0.092, (0.036, 0.088, 0.124)
    wrot = {s: K.rot_matrix([('X', -8), ('Y', s * -6)]) for s in (-1, 1)}

    for s in (-1, 1):
        d = ell(g, d, (s * wc, 0.024, z0 + 0.128), wr, 0.012, wrot[s])                                        # wings

        # primaries: long feathers sweeping down the back of the wing and crossing over the tail
        for j in range(3):
            d = ell(g, d, (s * (0.060 - 0.014 * j), 0.098 + 0.006 * j, z0 + 0.068 - 0.010 * j), (0.011, 0.018, 0.064),
                    0.006, K.rot_matrix([('X', 34 + 4 * j), ('Y', s * (10 + 6 * j))]))

    # a short fan of tail feathers under the crossed primaries
    for j in (-1, 0, 1):
        d = ell(g, d, (j * 0.022, 0.110, z0 + 0.024), (0.016, 0.012, 0.046), 0.006, K.rot_matrix([('X', 26), ('Y', j * 12)]))

    # feathers carved, not stuck on: scalloped rows (rounded tips down) on each wing and across the mantle
    for s in (-1, 1):
        wing = lambda P, s=s: K.sd_ellipsoid(P, (s * wc, 0.024, z0 + 0.128), wr, wrot[s])

        for r in range(4):
            zr_ = z0 + 0.214 - r * 0.040
            off = 0.017 * (r % 2)
            lo, hi = [min(s * 0.03, s * 0.16), -0.08, zr_ - 0.03], [max(s * 0.03, s * 0.16), 0.15, zr_ + 0.01]
            d = K.carve(g, d, lo, hi,
                        lambda P, zr_=zr_, off=off: (P[2] - np.float32(zr_)) + np.float32(0.016) * np.abs(np.sin(np.float32(math.pi / 0.034) * (P[1] - np.float32(off)))),
                        0.0030, 0.006, lambda P, s=s, wing=wing: np.maximum(np.float32(0.074) - np.float32(s) * P[0], wing(P) - np.float32(0.004)))

    for r in range(2):
        zr_ = z0 + 0.232 - r * 0.034
        off = 0.017 * (r % 2)
        d = K.carve(g, d, [-0.09, 0.02, zr_ - 0.03], [0.09, 0.16, zr_ + 0.01],
                    lambda P, zr_=zr_, off=off: (P[2] - np.float32(zr_)) + np.float32(0.014) * np.abs(np.sin(np.float32(math.pi / 0.030) * (P[0] - np.float32(off)))),
                    0.0028, 0.005, lambda P: np.maximum(np.float32(0.045) - P[1], np.abs(P[0]) - np.float32(0.072)))

    d = floor_cut(g, d, z0 - 0.004)

    return sdf_mesh(g, d, 'menagerie_bishop_top', coll)


# Queen: the coronet, and a swan rising from it

QUEEN_RIM = None


def queen_body(coll):
    global QUEEN_RIM
    t = Turn()
    foot(t, 0.246, 0.180, 0.122)
    baluster(t, 0.505, 0.078, 0.100)
    zc = collar(t, 0.505, 0.176, 0.140, 1.0)
    t.line(0.104, zc + 0.005).crease()

    # a shallow cup: the swan sits up on the coronet, not down in a bowl
    t.curve((0.118, zc + 0.044), (0.146, zc + 0.080), (0.172, zc + 0.122), 12)
    t.curve((0.186, zc + 0.144), (0.190, zc + 0.151), (0.188, zc + 0.155), 4)

    zr = zc + 0.155
    t.line(0.200, zr + 0.058, 4).crease()
    t.arc(0.194, zr + 0.058, 0.006, 0, 90, 4)
    t.line(0.182, zr + 0.064).crease()
    t.line(0.178, zr + 0.030).crease()
    t.curve((0.150, zr + 0.024), (0.100, zr + 0.030), (0.060, zr + 0.040), 8)
    t.line(0.0, zr + 0.044, 5)

    QUEEN_RIM = zr
    ob = K.lathe('menagerie_queen_turned', t, SEG, coll)

    import set_classic as C

    for i in range(8):
        c = C.notch_cutter('cut', coll, 360 * i / 8 + 22.5, 0.23, zr + 0.024, zr + 0.064, 0.038, v_notch=True, r_in=0.150)
        K.boolean(ob, c)

    return ob, zr


SWAN_WING = [(0.186, 0.122), (0.172, 0.106), (0.170, 0.092), (0.153, 0.079), (0.150, 0.064), (0.133, 0.053),
             (0.124, 0.040), (0.090, 0.028), (0.050, 0.016), (0.000, 0.008), (-0.040, 0.010), (-0.062, 0.022),
             (-0.050, 0.046), (-0.020, 0.070), (0.030, 0.094), (0.090, 0.114), (0.140, 0.126)]

SWAN_NOTCHES = [(0.172, 0.106), (0.153, 0.079), (0.133, 0.053)]



def swan(coll, zr):
    z0 = zr + 0.030
    top = 1.018
    g = K.Grid((-0.17, -0.21, z0 - 0.03), (0.17, 0.25, 1.07), VS)
    d = g.empty()

    # a long boat of a body up on the coronet, breast forward, tail raised
    d = ell(g, d, (0, 0.022, z0 + 0.052), (0.086, 0.132, 0.058), 0.0, K.rot_matrix([('X', -5)]))
    d = ell(g, d, (0, -0.066, z0 + 0.060), (0.074, 0.070, 0.058), 0.030)                                    # breast
    d = ell(g, d, (0, 0.150, z0 + 0.086), (0.036, 0.054, 0.014), 0.020, K.rot_matrix([('X', -30)]))        # tail

    # wings: a carved leaf on each side lifting clear toward the tail, the trailing edge in feather tips
    us = [p[0] for p in SWAN_WING]
    vs_ = [p[1] for p in SWAN_WING]
    wfield = K.Field2D(SWAN_WING, (min(us), min(vs_)), (max(us), max(vs_)), res=0.0007, pad=0.03)
    ca, sa = math.cos(math.radians(20)), math.sin(math.radians(20))

    for s in (-1, 1):
        ox, oy, oz = s * 0.070, -0.010, z0 + 0.030

        def wing_uvw(P, s=s, ox=ox, oy=oy, oz=oz):
            X, Y, Z = P
            px, pz = X - np.float32(ox), Z - np.float32(oz)
            pu = Y - np.float32(oy)
            pv = np.float32(-s * sa) * px + np.float32(ca) * pz
            pw = np.float32(s * ca) * px + np.float32(sa) * pz

            return pu, pv, pw

        def wing(P, wing_uvw=wing_uvw):
            pu, pv, pw = wing_uvw(P)
            return K.sd_inflate((pw, pu, pv), wfield, np.float32(0.013), depth=0.018, axis='X')

        lo = [min(ox - 0.06, ox + 0.06), -0.10, z0]
        hi = [max(ox - 0.06, ox + 0.06), 0.22, z0 + 0.18]
        d = g.add(d, wing, lo, hi, 0.010)

        # the feather tips separated by short carved lines running in from each notch
        for (nu, nv) in SWAN_NOTCHES:
            def sep(P, wing_uvw=wing_uvw, nu=nu, nv=nv):
                pu, pv, pw = wing_uvw(P)

                # distance (in the wing plane) to the segment from the notch, in and down the wing
                au, av = np.float32(nu), np.float32(nv)
                bu, bv = np.float32(nu - 0.034), np.float32(nv - 0.010)
                eu, ev = bu - au, bv - av
                t = np.clip(((pu - au) * eu + (pv - av) * ev) / (eu * eu + ev * ev), 0.0, 1.0)

                return np.sqrt((pu - au - t * eu) ** 2 + (pv - av - t * ev) ** 2)

            def outer(P, wing_uvw=wing_uvw):
                return -wing_uvw(P)[2]

            d = K.carve(g, d, lo, hi, sep, 0.0028, 0.006, outer, 0.0015)

    # the neck: a long S, back then forward, head held level
    pts = K.bezier_pts((0, -0.078, z0 + 0.070), (0, -0.150, z0 + 0.160), (0, 0.050, z0 + 0.190), (0, -0.018, top - 0.050), 18)
    radii = [0.030 - 0.013 * (i / 18) for i in range(19)]
    d = chain(g, d, pts, radii, 0.020, kin=0.004)
    d = ell(g, d, (0.0, -0.040, top - 0.022), (0.022, 0.040, 0.022), 0.012, K.rot_matrix([('X', -14)]))
    a, b = (0, -0.070, top - 0.028), (0, -0.114, top - 0.044)
    d = cap(g, d, a, b, 0.012, 0.0055, 0.007)                                                          # beak
    d = sph(g, d, (0, -0.067, top - 0.014), 0.0085, 0.004)                                             # the knob
    SWAN_BEAK[:] = [(a, b), ((0, -0.067, top - 0.014), (0, -0.067, top - 0.014))]

    for s in (-1, 1):
        d = sph(g, d, (s * 0.0180, -0.052, top - 0.016), 0.005, 0.002)

    d = floor_cut(g, d, zr + 0.016)

    return sdf_mesh(g, d, 'menagerie_queen_top', coll)


# King: St Hubert's stag, the cross between its antlers

def king_body(coll):
    t = Turn()
    foot(t, 0.256, 0.200, 0.132)
    baluster(t, 0.560, 0.086, 0.106)
    zc = collar(t, 0.560, 0.186, 0.150, 1.05)
    t.line(0.108, zc + 0.005).crease()
    t.curve((0.118, zc + 0.020), (0.128, zc + 0.034), (0.124, zc + 0.046), 5)
    seat(t, zc + 0.050, 0.110)

    return K.lathe('menagerie_king_turned', t, SEG, coll), zc + 0.050


def antler(g, d, s, z_base):
    """One antler: a thick beam sweeping up and out, four tines. s = -1 / +1 for left / right."""
    beam = K.bezier_pts((s * 0.034, -0.022, z_base), (s * 0.120, 0.012, z_base + 0.030),
                        (s * 0.200, 0.034, z_base + 0.140), (s * 0.184, -0.004, z_base + 0.286), 18)

    radii = [0.021 - 0.012 * (i / 18) for i in range(19)]
    d = chain(g, d, beam, radii, 0.012, kin=0.005)
    d = sph(g, d, beam[0], 0.026, 0.010)                                             # the burr

    for (ti, dx, dy, dz, L) in ((2, 0.020, -0.090, 0.040, 0.082), (6, 0.010, -0.070, 0.090, 0.092),
                                 (11, -0.040, -0.050, 0.100, 0.090), (15, 0.030, -0.030, 0.090, 0.072)):
        b = beam[ti]
        n = math.sqrt(dx * dx + dy * dy + dz * dz)
        tip = (b[0] + s * dx / n * L, b[1] + dy / n * L, b[2] + dz / n * L)
        mid = ((b[0] + tip[0]) / 2 + s * 0.008, (b[1] + tip[1]) / 2, (b[2] + tip[2]) / 2 - 0.008)
        d = chain(g, d, [b, mid, tip], [radii[ti] * 0.88, radii[ti] * 0.62, 0.0045], 0.010, kin=0.004)

    return d


def stag(coll, z0):
    g = K.Grid((-0.25, -0.23, z0 - 0.02), (0.25, 0.16, 1.205), VS)
    d = g.empty()

    # neck rising from the seat, a ruff at the throat, head held high and a little forward
    d = cap(g, d, (0, 0.028, z0 + 0.010), (0, -0.012, z0 + 0.150), 0.080, 0.058, 0.0)

    STAG_RING[:] = [(0.0, 0.026, z0 + 0.010), 0.084, 0.013]
    d = g.add(d, lambda P: K.sd_torus(P, STAG_RING[0], STAG_RING[1], STAG_RING[2]),
              (-0.11, -0.08, z0 - 0.01), (0.11, 0.13, z0 + 0.03), 0.004)

    d = ell(g, d, (0, -0.030, z0 + 0.070), (0.068, 0.060, 0.072), 0.030)

    hz = z0 + 0.190
    STAG_HZ[0] = hz
    d = ell(g, d, (0, -0.042, hz), (0.058, 0.072, 0.058), 0.034)                                         # skull
    d = cap(g, d, (0, -0.074, hz - 0.006), (0, -0.172, hz - 0.058), 0.044, 0.026, 0.026)                # long muzzle
    d = ell(g, d, (0, -0.094, hz - 0.046), (0.040, 0.058, 0.028), 0.022, K.rot_matrix([('X', -24)]))    # jaw
    d = ell(g, d, (0, -0.186, hz - 0.064), (0.025, 0.018, 0.020), 0.010)                                # nose

    for s in (-1, 1):
        d = sph(g, d, (s * 0.054, -0.070, hz + 0.014), 0.013, 0.004, 'sub')
        d = sph(g, d, (s * 0.049, -0.068, hz + 0.014), 0.010, 0.002)                                     # eyes
        rot = K.rot_matrix([('Y', s * 58), ('X', -12)])
        d = ell(g, d, (s * 0.080, -0.006, hz + 0.034), (0.016, 0.028, 0.050), 0.010, rot)               # ears
        d = ell(g, d, (s * 0.082, -0.016, hz + 0.036), (0.009, 0.013, 0.038), 0.003, rot, 'sub')
        d = antler(g, d, s, hz + 0.044)

    # the back of the neck: a mane of short ruffled locks down the nape, so the view from behind is a stag too
    for i in range(6):
        zz = z0 + 0.170 - i * 0.026
        for s in (-1, 1):
            d = ell(g, d, (s * 0.016, 0.034 + 0.004 * i, zz), (0.020, 0.012, 0.022), 0.006, K.rot_matrix([('X', 24), ('Y', s * 20)]))

    # St Hubert's cross between the antlers: flared ends (pattee), standing on the poll
    cy = -0.028
    d = cap(g, d, (0, cy, hz + 0.046), (0, cy, 1.110), 0.0145, 0.0145, 0.006)
    d = g.add(d, lambda P: K.sd_box(P, (0, cy, 1.100), (0.056, 0.0145, 0.0145), r=0.005), (-0.07, cy - 0.03, 1.07), (0.07, cy + 0.03, 1.13), 0.005)
    d = g.add(d, lambda P: K.sd_box(P, (0, cy, 1.152), (0.0145, 0.0145, 0.040), r=0.005), (-0.03, cy - 0.03, 1.10), (0.03, cy + 0.03, 1.20), 0.004)

    for sx in (-1, 1):
        d = g.add(d, lambda P, sx=sx: K.sd_box(P, (sx * 0.056, cy, 1.100), (0.006, 0.0145, 0.026), r=0.004), (sx * 0.056 - 0.02, cy - 0.03, 1.06), (sx * 0.056 + 0.02, cy + 0.03, 1.14), 0.004)

    d = g.add(d, lambda P: K.sd_box(P, (0, cy, 1.190), (0.026, 0.0145, 0.006), r=0.004), (-0.04, cy - 0.03, 1.17), (0.04, cy + 0.03, 1.205), 0.004)
    d = floor_cut(g, d, z0 - 0.006)

    return sdf_mesh(g, d, 'menagerie_king_top', coll)



def build_piece(role, coll):
    _BANDS.clear()
    if role == 'pawn':
        body, z0 = pawn_body(coll)
        top = hedgehog(coll, z0)
    elif role == 'rook':
        body = rook_body(coll)
        import set_classic as C

        for i in range(6):
            cutter = C.notch_cutter('cut', coll, 360 * i / 6 + 30, 0.22, ROOK_TOP - 0.042, ROOK_TOP + 0.05, 0.030)
            K.boolean(body, cutter)

        top = bear(coll)
    elif role == 'knight':
        body, z0 = knight_body(coll)
        top = horse(coll, z0)

        Ct = face_centers(top)
        set_face_mask(top, np.min([seg_dist(Ct, a, b) for a, b in HORSE_BRIDLE], axis=0) < 0.0105)

        top.rotation_euler.z = math.radians(-90)       # muzzle +X -> -Y (the board's +Z)
        K.apply_transform(top)
    elif role == 'bishop':
        body, z0 = bishop_body(coll)
        top = owl(coll, z0)

        Ct = face_centers(top)
        set_face_mask(top, np.min([np.linalg.norm(Ct - np.array(e), axis=1) for e in OWL_EYES], axis=0) < 0.0285)
    elif role == 'queen':
        body, zr = queen_body(coll)
        top = swan(coll, zr)

        Ct = face_centers(top)
        set_face_mask(top, np.min([seg_dist(Ct, a, b) for a, b in SWAN_BEAK], axis=0) < 0.0135)

        _BANDS.append((zr + 0.036, zr + 0.080, 0.170))           # the coronet's points
    else:
        body, z0 = king_body(coll)
        top = stag(coll, z0)

        Ct = face_centers(top)
        hz = STAG_HZ[0]

        near = np.abs(Ct[:, 1] + 0.028) < 0.024
        cross = near & (Ct[:, 2] > hz + 0.070) & ((np.abs(Ct[:, 0]) < 0.026) | ((Ct[:, 2] > 1.064) & (np.abs(Ct[:, 0]) < 0.07)))

        (rx, ry, rz), R, rr = STAG_RING
        ring = np.abs(np.hypot(np.hypot(Ct[:, 0] - rx, Ct[:, 1] - ry) - R, Ct[:, 2] - rz) - rr) < 0.004

        set_face_mask(top, cross | ring)

    if role in ('pawn', 'rook'):
        Ct = face_centers(top)
        set_face_mask(top, np.min([np.linalg.norm(Ct - np.array(c), axis=1) - r for c, r in FACE_GILT], axis=0) < 0.002)

    set_face_mask(body, gild_bands(body, _BANDS))
    ob = K.join([body, top], 'menagerie_' + role)
    if role != 'knight':
        # the whole piece turns (the turned body is round, the rook's battlements turn with the bear)
        ob.rotation_euler.z = math.radians(TURN)
        K.apply_transform(ob)

    return ob


def model(roles=None):
    coll = K.collection(COLL, clear=roles is None)
    out = {}

    for role in roles or K.ROLES:
        for nm in ('menagerie_' + role, 'menagerie_' + role + '_hi'):
            old = bpy.data.objects.get(nm)
            if old:
                K.remove(old)

        out[role] = build_piece(role, coll)

    return {r: (K.tri_count(o), [round(float(v), 3) for v in K.bounds(o)[1]]) for r, o in out.items()}


def pieces():
    return [bpy.data.objects['menagerie_' + r] for r in K.ROLES if bpy.data.objects.get('menagerie_' + r)]


def preview(path=None, angle=-35):
    K.preview_scene()
    objs = pieces()

    for i, o in enumerate(objs):
        o.location = ((i - (len(objs) - 1) / 2) * 0.62, 0, 0)
        o.rotation_euler.z = math.radians(angle)

    m, N, bsdf, _ = K.new_material('__clay')
    bsdf.inputs['Base Color'].default_value = (0.78, 0.76, 0.72, 1)
    bsdf.inputs['Roughness'].default_value = 0.45

    for o in objs:
        K.assign(o, m)

    path = path or K.WORK + '/menagerie/preview_shapes.png'
    K.render_preview(path, (0.6, -5.4, 1.9), (0.0, 0.0, 0.52), lens=50, res=(1800, 1000), samples=32, only=objs)

    for o in objs:
        o.rotation_euler.z = 0.0

    return path


def closeup(role, path=None, views=(('front', (0.0, -1.9, 0.9)), ('side', (-1.9, -0.25, 0.9)), ('back', (1.3, 1.4, 1.1)))):
    K.preview_scene()
    ob = bpy.data.objects['menagerie_' + role]

    for o in pieces():
        o.location = (0, 30, 0)

    ob.location = (0, 0, 0)
    m, N, bsdf, _ = K.new_material('__clay')
    bsdf.inputs['Base Color'].default_value = (0.78, 0.76, 0.72, 1)
    bsdf.inputs['Roughness'].default_value = 0.45
    K.assign(ob, m)
    h = K.bounds(ob)[1][2]
    paths = []

    for tag, loc in views:
        p = K.WORK + '/menagerie/%s_%s.png' % (role, tag)
        K.render_preview(p, (loc[0], loc[1], loc[2] * h / 1.0), (0, 0, h * 0.62), lens=85, res=(800, 800), samples=24, only=[ob])
        paths.append(p)

    return paths


def closeup_top(role):
    """Tight views of just the animal (upper third of the piece)."""
    K.preview_scene()
    ob = bpy.data.objects['menagerie_' + role]

    for o in pieces():
        o.location = (0, 30, 0)

    ob.location = (0, 0, 0)
    m, N, bsdf, _ = K.new_material('__clay')
    bsdf.inputs['Base Color'].default_value = (0.78, 0.76, 0.72, 1)
    bsdf.inputs['Roughness'].default_value = 0.45
    K.assign(ob, m)
    h = K.bounds(ob)[1][2]
    paths = []

    for tag, loc in (('topfront', (0.5, -1.05, h + 0.05)), ('topside', (-1.1, -0.35, h)), ('topback', (0.8, 0.9, h + 0.1))):
        p = K.WORK + '/menagerie/%s_%s.png' % (role, tag)
        K.render_preview(p, loc, (0, 0, h * 0.78), lens=85, res=(700, 700), samples=24, only=[ob])
        paths.append(p)

    return paths


_BANDS = []


HORSE_BRIDLE = []


OWL_EYES = []


SWAN_BEAK = []


STAG_HZ = [0.0]


STAG_RING = []


FACE_GILT = []


def seg_dist(P, a, b):
    """Distance from points P (n,3) to segment a-b."""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    ab = b - a
    L2 = float(ab @ ab)
    if L2 < 1e-12:
        return np.linalg.norm(P - a, axis=1)

    t = np.clip(((P - a) @ ab) / L2, 0, 1)

    return np.linalg.norm(P - (a + t[:, None] * ab), axis=1)


def set_face_mask(ob, vals):
    me = ob.data
    a = me.attributes.get('accent')
    if a is not None and a.domain != 'FACE':
        me.attributes.remove(a)
        a = None

    if a is None:
        a = me.attributes.new('accent', 'FLOAT', 'FACE')

    a.data.foreach_set('value', np.asarray(vals, dtype=np.float32))


def face_centers(ob):
    me = ob.data
    c = np.empty(len(me.polygons) * 3, dtype=np.float32)
    me.polygons.foreach_get('center', c)
    return c.reshape(-1, 3).astype(np.float64)


def gild_bands(ob, bands):
    C = face_centers(ob)
    r = np.hypot(C[:, 0], C[:, 1])
    m = np.zeros(len(C), dtype=bool)

    for z0, z1, rmin in bands:
        m |= (C[:, 2] >= z0) & (C[:, 2] <= z1) & (r >= rmin)

    return m


def lin(hexstr):
    h = hexstr.lstrip('#')
    out = []

    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)

    return tuple(out)


def _gilded(N, bsdf, base_col, base_rough, base_metal):
    """Blend the gold leaf in wherever the mesh's `accent` mask is set; exposes __metal__ for the bake."""

    acc = N.n('ShaderNodeAttribute', attribute_name='accent', attribute_type='GEOMETRY')
    gold = N.n('ShaderNodeMixRGB', blend_type='MIX')
    N.link(acc.outputs['Fac'], gold.inputs['Fac'])
    N.link(base_col, gold.inputs['Color1'])
    gold.inputs['Color2'].default_value = (*lin('#E9BE62'), 1)
    N.link(gold.outputs['Color'], bsdf.inputs['Base Color'])

    rough = N.n('ShaderNodeMix', data_type='FLOAT')
    N.link(acc.outputs['Fac'], rough.inputs['Factor'])
    N.link(base_rough, rough.inputs['A'])
    rough.inputs['B'].default_value = 0.20
    N.link(rough.outputs['Result'], bsdf.inputs['Roughness'])

    metal = N.n('ShaderNodeMix', data_type='FLOAT')
    metal.name = '__metal__'
    N.link(acc.outputs['Fac'], metal.inputs['Factor'])
    if isinstance(base_metal, float):
        metal.inputs['A'].default_value = base_metal
    else:
        N.link(base_metal, metal.inputs['A'])

    metal.inputs['B'].default_value = 1.0
    N.link(metal.outputs['Result'], bsdf.inputs['Metallic'])

    # __metal__ must expose a single output the EMIT bake can route: use the Mix node's result
    return metal


def porcelain(name):
    m, N, bsdf, out = K.new_material(name)

    ao = N.n('ShaderNodeAmbientOcclusion', samples=16, only_local=True, i_Distance=0.035)
    tint = N.n('ShaderNodeMixRGB', blend_type='MIX')
    inv = N.n('ShaderNodeMath', operation='SUBTRACT')
    inv.inputs[0].default_value = 1.0
    N.link(ao.outputs['AO'], inv.inputs[1])

    k = N.n('ShaderNodeMath', operation='MULTIPLY')
    N.link(inv.outputs['Value'], k.inputs[0])
    k.inputs[1].default_value = 0.32
    N.link(k.outputs['Value'], tint.inputs['Fac'])

    # the body drifts faintly warm and cool over a piece (hand-glazed), and the glaze pools celadon
    tc = N.n('ShaderNodeTexCoord')
    drift = N.n('ShaderNodeTexNoise', i_Scale=2.2, i_Detail=2.0)
    N.link(tc.outputs['Object'], drift.inputs['Vector'])

    dr = N.n('ShaderNodeMapRange', i_From_Min=0.35, i_From_Max=0.65, i_To_Min=0.0, i_To_Max=1.0)
    N.link(drift.outputs['Fac'], dr.inputs['Value'])

    body = N.n('ShaderNodeMixRGB', blend_type='MIX')
    N.link(dr.outputs['Result'], body.inputs['Fac'])
    body.inputs['Color1'].default_value = (*lin('#F4EEE3'), 1)
    body.inputs['Color2'].default_value = (*lin('#EDF0F1'), 1)
    N.link(body.outputs['Color'], tint.inputs['Color1'])
    tint.inputs['Color2'].default_value = (*lin('#AFC1C0'), 1)

    # the faintest glaze pooling variation
    nz = N.n('ShaderNodeTexNoise', i_Scale=18.0, i_Detail=3.0)
    rr = N.n('ShaderNodeMapRange', i_From_Min=0.3, i_From_Max=0.7, i_To_Min=0.10, i_To_Max=0.18)
    N.link(nz.outputs['Fac'], rr.inputs['Value'])
    _gilded(N, bsdf, tint.outputs['Color'], rr.outputs['Result'], 0.0)

    return m


def bronze(name):
    """Cast bronze, polished on the open surfaces, verdigris in the recesses."""
    m, N, bsdf, out = K.new_material(name)

    tc = N.n('ShaderNodeTexCoord')
    ao = N.n('ShaderNodeAmbientOcclusion', samples=16, only_local=True, i_Distance=0.03)
    nz = N.n('ShaderNodeTexNoise', i_Scale=14.0, i_Detail=6.0, i_Roughness=0.6)
    N.link(tc.outputs['Object'], nz.inputs['Vector'])

    nz2 = N.n('ShaderNodeTexNoise', i_Scale=60.0, i_Detail=4.0, i_Roughness=0.6)
    N.link(tc.outputs['Object'], nz2.inputs['Vector'])

    # exposure: 0 deep in a recess, 1 on an open surface
    expo = N.n('ShaderNodeMapRange', i_From_Min=0.45, i_From_Max=0.95, i_To_Min=0.0, i_To_Max=1.0)
    N.link(ao.outputs['AO'], expo.inputs['Value'])

    pol_in = N.n('ShaderNodeMath', operation='MULTIPLY')
    N.link(expo.outputs['Result'], pol_in.inputs[0])
    N.link(nz.outputs['Fac'], pol_in.inputs[1])

    polish = N.n('ShaderNodeMapRange', i_From_Min=0.42, i_From_Max=0.62, i_To_Min=0.0, i_To_Max=1.0)
    N.link(pol_in.outputs['Value'], polish.inputs['Value'])

    inv = N.n('ShaderNodeMath', operation='SUBTRACT')
    inv.inputs[0].default_value = 1.0
    N.link(expo.outputs['Result'], inv.inputs[1])

    pat_in = N.n('ShaderNodeMath', operation='MULTIPLY_ADD')
    N.link(nz.outputs['Fac'], pat_in.inputs[0])
    pat_in.inputs[1].default_value = 0.6
    N.link(inv.outputs['Value'], pat_in.inputs[2])

    pat = N.n('ShaderNodeMapRange', i_From_Min=0.62, i_From_Max=0.95, i_To_Min=0.0, i_To_Max=1.0)
    N.link(pat_in.outputs['Value'], pat.inputs['Value'])

    base0 = N.n('ShaderNodeMixRGB', blend_type='MIX')
    N.link(nz2.outputs['Fac'], base0.inputs['Fac'])
    base0.inputs['Color1'].default_value = (*lin('#3E2B1C'), 1)
    base0.inputs['Color2'].default_value = (*lin('#4A3423'), 1)

    # the animal rises into a golden patina so it separates from the walnut squares
    sep = N.n('ShaderNodeSeparateXYZ')
    N.link(tc.outputs['Object'], sep.inputs['Vector'])

    crown = N.n('ShaderNodeMapRange', i_From_Min=0.42, i_From_Max=0.62, i_To_Min=0.0, i_To_Max=1.0)
    N.link(sep.outputs['Z'], crown.inputs['Value'])

    base = N.n('ShaderNodeMixRGB', blend_type='MIX')
    ck = N.n('ShaderNodeMath', operation='MULTIPLY')
    N.link(crown.outputs['Result'], ck.inputs[0])
    ck.inputs[1].default_value = 0.6
    N.link(ck.outputs['Value'], base.inputs['Fac'])
    N.link(base0.outputs['Color'], base.inputs['Color1'])
    base.inputs['Color2'].default_value = (*lin('#6E4B2A'), 1)

    bright = N.n('ShaderNodeMixRGB', blend_type='MIX')
    pk0 = N.n('ShaderNodeMath', operation='MULTIPLY_ADD')
    N.link(crown.outputs['Result'], pk0.inputs[0])
    pk0.inputs[1].default_value = 0.30
    pk0.inputs[2].default_value = 0.55

    pk = N.n('ShaderNodeMath', operation='MULTIPLY', use_clamp=True)
    N.link(polish.outputs['Result'], pk.inputs[0])
    N.link(pk0.outputs['Value'], pk.inputs[1])
    N.link(pk.outputs['Value'], bright.inputs['Fac'])
    N.link(base.outputs['Color'], bright.inputs['Color1'])
    bright.inputs['Color2'].default_value = (*lin('#A67B4B'), 1)

    verd = N.n('ShaderNodeMixRGB', blend_type='MIX')
    N.link(nz2.outputs['Fac'], verd.inputs['Fac'])
    verd.inputs['Color1'].default_value = (*lin('#3C6A5A'), 1)
    verd.inputs['Color2'].default_value = (*lin('#5E8C74'), 1)

    col = N.n('ShaderNodeMixRGB', blend_type='MIX')
    N.link(pat.outputs['Result'], col.inputs['Fac'])
    N.link(bright.outputs['Color'], col.inputs['Color1'])
    N.link(verd.outputs['Color'], col.inputs['Color2'])

    rough = N.n('ShaderNodeMath', operation='MULTIPLY_ADD')
    N.link(polish.outputs['Result'], rough.inputs[0])
    rough.inputs[1].default_value = -0.14
    rough.inputs[2].default_value = 0.34

    rough2 = N.n('ShaderNodeMath', operation='MULTIPLY_ADD', use_clamp=True)
    N.link(pat.outputs['Result'], rough2.inputs[0])
    rough2.inputs[1].default_value = 0.40
    N.link(rough.outputs['Value'], rough2.inputs[2])

    metal = N.n('ShaderNodeMath', operation='SUBTRACT', use_clamp=True)
    metal.inputs[0].default_value = 1.0
    N.link(pat.outputs['Result'], metal.inputs[1])
    _gilded(N, bsdf, col.outputs['Color'], rough2.outputs['Value'], metal.outputs['Value'])

    bump = N.n('ShaderNodeBump', i_Strength=0.08, i_Distance=0.001)
    N.link(nz2.outputs['Fac'], bump.inputs['Height'])
    N.link(bump.outputs['Normal'], bsdf.inputs['Normal'])

    return m


def materials():
    return {'white': porcelain('menagerie_src_porcelain'), 'black': bronze('menagerie_src_bronze')}


PARAMS = {
    'white': {'coat': 1.0, 'coat_rough': 0.035, 'metallic': None, 'specular': 0.5},
    'black': {'coat': 0.0, 'metallic': None, 'specular': 0.5},
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

    os.makedirs(K.WORK + '/menagerie', exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=K.WORK + '/menagerie/menagerie.blend', copy=True)

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

    path = path or K.WORK + '/menagerie/preview_baked.png'
    K.render_preview(path, (0.4, -5.6, 2.3), (0.0, 0.3, 0.50), lens=50, res=(1800, 1000), samples=64, only=objs + blacks)

    for b in blacks:
        K.remove(b)

    for o in objs:
        o.rotation_euler.z = 0.0

    return path
