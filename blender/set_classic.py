"""Classic -- a Jaques-pattern Staunton in boxwood and ebony, with baize under the feet.

Turned pieces are lathe profiles (cbkit.Turn); the knight's head is carved as a signed distance field
and glued to a turned base the way the real ones are. Run from Blender through cbkit (see README).
"""
import math
import numpy as np
import cbkit as K
from cbkit import Turn

SET_ID = 'classic'
COLL = 'set_classic'
SEG = 96

# Height ladder for this set (the loader scales the king to 1.18; the rest keep these ratios).
H = {'pawn': 0.600, 'knight': 0.800, 'bishop': 0.880, 'rook': 0.680, 'queen': 1.020, 'king': 1.180}


def foot(t, R, zf, rs):
    """The shared Staunton foot: rounded plinth, ovolo, fillet + bead, cove up into the stem."""
    k = zf / 0.200
    t.line(R * 0.55, 0.0).line(R - 0.012, 0.0)
    t.arc(R - 0.012, 0.012, 0.012, -90, 0, 5)                       # rounded bottom edge
    t.line(R, 0.012 + 0.022 * k).crease()                            # plinth wall
    t.curve((R, 0.066 * k), (R - 0.030 * k, 0.098 * k), (R - 0.074 * k, 0.104 * k), 10).crease()   # ovolo
    r1 = R - 0.074 * k
    t.line(r1, 0.109 * k).crease()                                   # fillet
    b = 0.0125 * k
    t.arc(r1, 0.109 * k + b, b, -90, 90, 9).crease()                 # bead
    z1 = 0.109 * k + 2 * b
    t.line(r1 - 0.006 * k, z1 + 0.003 * k).crease()
    t.curve((r1 - 0.050 * k, z1 + 0.010 * k), (rs + 0.006, zf - 0.040 * k), (rs, zf), 12)   # cove
    return t


def collar(t, r_in, z, r_disc, r_bead, s=1.0):
    """The double collar under a crown/mitre: a rounded disc then a smaller bead."""
    t.line(r_in, z).crease()
    t.line(r_disc - 0.011 * s, z + 0.005 * s, 2)
    t.arc(r_disc - 0.011 * s, z + 0.016 * s, 0.011 * s, -90, 90, 9).crease()
    z2 = z + 0.027 * s
    t.line(r_bead, z2 + 0.004 * s).crease()
    t.arc(r_bead, z2 + 0.012 * s, 0.008 * s, -90, 90, 7).crease()
    return z2 + 0.020 * s


def pawn_profile():
    t = Turn()
    foot(t, 0.196, 0.140, 0.101)
    t.curve((0.090, 0.200), (0.070, 0.260), (0.066, 0.300), 12)
    t.curve((0.066, 0.312), (0.074, 0.318), (0.082, 0.320), 4).crease()
    t.line(0.118, 0.326, 2)
    t.arc(0.114, 0.334, 0.008, -60, 60, 7)                          # collar lip
    t.line(0.086, 0.350).crease()
    t.curve((0.075, 0.356), (0.064, 0.366), (0.062, 0.378), 5)
    # ball: centre 0.487, radius 0.113 -> top 0.600
    cz, rad = 0.487, 0.113
    a0 = -74
    sx, sz = rad * math.cos(math.radians(a0)), cz + rad * math.sin(math.radians(a0))
    t.curve((0.058, 0.382), (sx + 0.004, sz - 0.004), (sx, sz), 3)
    t.arc(0.0, cz, rad, a0, 90, 26)
    return t


def rook_profile():
    t = Turn()
    foot(t, 0.236, 0.160, 0.150)
    t.curve((0.146, 0.230), (0.136, 0.330), (0.134, 0.410), 12)      # tower, barely tapering
    t.crease()
    t.line(0.140, 0.414)
    t.arc(0.140, 0.426, 0.012, -90, 90, 8).crease()                  # waist bead
    t.line(0.136, 0.442).crease()
    t.curve((0.150, 0.470), (0.192, 0.520), (0.200, 0.560), 12)     # turret flare
    t.line(0.201, 0.572).crease()
    t.line(0.206, 0.576).crease()
    t.line(0.206, 0.672).crease()                                     # parapet wall
    t.arc(0.199, 0.672, 0.007, 0, 90, 4)
    t.line(0.169, 0.679).crease()
    t.arc(0.169, 0.672, 0.007, 90, 180, 4).crease()
    t.line(0.162, 0.612).crease()                                     # inner wall
    t.line(0.0, 0.612, 6)                                             # well floor
    return t


def bishop_profile():
    t = Turn()
    foot(t, 0.224, 0.160, 0.112)
    t.curve((0.100, 0.230), (0.078, 0.360), (0.076, 0.430), 14)      # stem
    t.curve((0.076, 0.442), (0.086, 0.452), (0.098, 0.455), 4)
    zc = collar(t, 0.098, 0.455, 0.142, 0.112, 0.9)
    t.line(0.090, zc + 0.004).crease()
    # mitre: swells to 0.128 then closes to a point under the finial
    t.curve((0.112, zc + 0.030), (0.130, zc + 0.080), (0.129, zc + 0.140), 14)
    t.curve((0.128, zc + 0.200), (0.090, zc + 0.260), (0.030, zc + 0.300), 16)
    t.crease()
    t.curve((0.024, zc + 0.304), (0.020, zc + 0.308), (0.021, zc + 0.312), 3)
    cz = H['bishop'] - 0.034
    rad = 0.034
    a0 = -58
    sx, sz = rad * math.cos(math.radians(a0)), cz + rad * math.sin(math.radians(a0))
    t.curve((0.020, zc + 0.316), (sx, sz - 0.004), (sx, sz), 3)
    t.arc(0.0, cz, rad, a0, 90, 16)
    return t


def queen_profile():
    t = Turn()
    foot(t, 0.254, 0.190, 0.127)
    t.curve((0.112, 0.280), (0.088, 0.420), (0.086, 0.500), 16)      # stem
    t.curve((0.086, 0.512), (0.098, 0.522), (0.112, 0.525), 4)
    zc = collar(t, 0.112, 0.525, 0.178, 0.140, 1.0)
    t.line(0.108, zc + 0.005).crease()
    t.curve((0.122, zc + 0.060), (0.150, zc + 0.110), (0.176, zc + 0.170), 12)   # bowl (tulip)
    t.curve((0.190, zc + 0.200), (0.192, zc + 0.210), (0.190, zc + 0.215), 4)
    zr = zc + 0.215
    t.line(0.200, zr + 0.056, 4).crease()                            # coronet outer wall
    t.arc(0.190, zr + 0.052, 0.006, 0, 90, 4)
    t.line(0.180, zr + 0.058).crease()
    t.line(0.176, zr + 0.030).crease()                               # coronet inner wall
    t.curve((0.150, zr + 0.026), (0.110, zr + 0.040), (0.070, zr + 0.070), 10)   # cushion
    t.curve((0.050, zr + 0.086), (0.036, zr + 0.096), (0.030, zr + 0.104), 5)
    cz = H['queen'] - 0.046
    rad = 0.046
    a0 = -52
    sx, sz = rad * math.cos(math.radians(a0)), cz + rad * math.sin(math.radians(a0))
    t.curve((0.026, zr + 0.110), (sx - 0.002, sz - 0.004), (sx, sz), 3)
    t.arc(0.0, cz, rad, a0, 90, 18)
    return t, zr


def king_profile():
    t = Turn()
    foot(t, 0.264, 0.205, 0.132)
    t.curve((0.118, 0.300), (0.093, 0.450), (0.091, 0.560), 16)      # stem
    t.curve((0.091, 0.574), (0.104, 0.584), (0.118, 0.587), 4)
    zc = collar(t, 0.118, 0.587, 0.190, 0.150, 1.05)
    t.line(0.114, zc + 0.005).crease()
    t.curve((0.128, zc + 0.040), (0.190, zc + 0.150), (0.204, zc + 0.236), 16)   # crown bowl
    zr = zc + 0.236
    t.arc(0.196, zr, 0.008, 0, 90, 5)
    t.line(0.176, zr + 0.008).crease()                               # rim ledge
    t.line(0.170, zr + 0.020).crease()                               # the band
    t.curve((0.150, zr + 0.040), (0.105, zr + 0.052), (0.052, zr + 0.056), 12)   # shallow cap
    t.crease()
    t.curve((0.040, zr + 0.058), (0.036, zr + 0.062), (0.036, zr + 0.068), 3)
    t.arc(0.036, zr + 0.080, 0.012, -90, 90, 7).crease()             # a small bead under the cross
    t.line(0.026, zr + 0.096).crease()
    t.line(0.0, zr + 0.096, 3)
    return t, zr + 0.096


def knight_base_profile():
    t = Turn()
    foot(t, 0.232, 0.160, 0.132)
    t.curve((0.126, 0.200), (0.118, 0.232), (0.120, 0.250), 6)
    t.crease()
    t.line(0.150, 0.254, 2)
    t.arc(0.150, 0.265, 0.011, -90, 90, 8).crease()
    t.line(0.146, 0.280).crease()
    t.line(0.146, 0.288).crease()
    t.curve((0.120, 0.294), (0.060, 0.296), (0.0, 0.296), 6)
    return t


# ---------------------------------------------------------------------------------------------

def cross_pattee(name, coll, height, width, thick, z0):
    """A cross pattee (arms flare toward their ends, concave sides), standing in the XZ plane."""
    w0 = 0.020                         # half width at the centre
    arm_up, arm_side, arm_down = height * 0.40, width / 2, height * 0.60
    flare = 0.030                      # half width at the arm ends

    def arm(dx, dz, L):
        # points along one arm's two sides, from centre-ish to the end and back (concave sides)
        pts = []
        px, pz = -dz, dx               # perpendicular
        n = 8
        side_a, side_b = [], []
        for i in range(n + 1):
            s = i / n
            w = w0 + (flare - w0) * (s ** 1.8)
            cx, cz = dx * (w0 + (L - w0) * s), dz * (w0 + (L - w0) * s)
            side_a.append((cx + px * w, cz + pz * w))
            side_b.append((cx - px * w, cz - pz * w))
        return side_a, side_b

    # build the outline by walking the four arms counter-clockwise
    arms = [((0, 1), arm_up), ((-1, 0), arm_side), ((0, -1), arm_down), ((1, 0), arm_side)]
    outline = []
    for (d, L) in arms:
        a, b = arm(d[0], d[1], L)
        # go out along side b (right-hand side when facing out), across the end, back along side a
        outline += b[1:] + list(reversed(a))[:-1]
    ob = K.extrude_outline(name, outline, thick, bevel=0.007, bevel_res=3, coll=coll, plane='XZ')
    ob.location.z = z0 + arm_down
    K.apply_transform(ob)
    return ob


def notch_cutter(name, coll, angle_deg, r_out, z_bottom, z_top, half_w, v_notch=False, r_in=0.0):
    """A radial cutter for crenels / coronet notches (a box, or a V wedge) spanning radius r_in..r_out+."""
    if v_notch:
        L = r_out - r_in + 0.05
        outline = [(-half_w, z_top + 0.05), (half_w, z_top + 0.05), (0.0, z_bottom)]
        ob = K.extrude_outline(name, outline, L, bevel=0.0, coll=coll, plane='XZ')
        # extrude_outline extrudes along Y symmetric; move so it spans radius r_in..r_out on +Y
        ob.location.y = r_in + L / 2
        K.apply_transform(ob)
    else:
        verts = [(-half_w, 0.0, z_bottom), (half_w, 0.0, z_bottom), (half_w, r_out + 0.06, z_bottom),
                 (-half_w, r_out + 0.06, z_bottom), (-half_w, 0.0, z_top), (half_w, 0.0, z_top),
                 (half_w, r_out + 0.06, z_top), (-half_w, r_out + 0.06, z_top)]
        faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        ob = K.mesh_object(name, verts, faces, coll)
    ob.rotation_euler.z = math.radians(angle_deg)
    K.apply_transform(ob)
    return ob


def knight_head(coll, vs=0.0026):
    """The carved head: a side silhouette inflated into a rounded volume (thin toward its outline, full
    thickness inside), thickness tapering from neck to muzzle, then cheeks, brows, eyes, nostrils, the
    mouth line, split ears and a raised, lock-cut mane."""
    # side silhouette, x forward (muzzle), z up. Extends below the seat so the neck is full-thickness
    # where it is cut flat at z = 0.272 (inside the base collar).
    sil = [
        (0.112, 0.180), (0.114, 0.300), (0.124, 0.360), (0.136, 0.410), (0.136, 0.450),   # chest
        (0.128, 0.484), (0.124, 0.506),                                                   # throat
        (0.146, 0.520), (0.182, 0.532), (0.218, 0.546), (0.248, 0.562),                   # jaw line
        (0.266, 0.580), (0.276, 0.603), (0.280, 0.628), (0.272, 0.652),                   # lips / muzzle
        (0.254, 0.670), (0.224, 0.686), (0.190, 0.704), (0.152, 0.726),                   # nose bridge
        (0.120, 0.747), (0.096, 0.764), (0.082, 0.780),                                   # forehead
        (0.080, 0.808), (0.068, 0.840), (0.054, 0.848), (0.040, 0.828),                   # ear
        (0.028, 0.802), (0.006, 0.794),                                                   # poll
        (-0.030, 0.780), (-0.068, 0.754), (-0.100, 0.718), (-0.124, 0.670),               # crest
        (-0.140, 0.612), (-0.148, 0.550), (-0.150, 0.482), (-0.144, 0.410),
        (-0.134, 0.340), (-0.126, 0.180),
    ]
    xs = [q[0] for q in sil]
    zs = [q[1] for q in sil]
    field = K.Field2D(sil, (min(xs), min(zs)), (max(xs), max(zs)), res=0.0008, pad=0.06)
    g = K.Grid((-0.20, -0.14, 0.25), (0.31, 0.14, 0.88), vs)
    X, Y, Z = g.P
    # half thickness: neck 0.084, jowls 0.094, muzzle 0.054, skull top 0.078, ears 0.050
    head = np.clip((Z - 0.46) / 0.14, 0, 1)
    fwd = np.clip((X - 0.06) / 0.21, 0, 1)
    top = np.clip((Z - 0.70) / 0.08, 0, 1)
    half = 0.084 * (1 - head) + head * (0.094 - 0.040 * fwd)
    half = half * (1 - top * 0.18)
    ears = np.clip((Z - 0.776) / 0.03, 0, 1)
    half = half * (1 - ears) + ears * 0.050
    half = half.astype(np.float32)
    d = K.sd_inflate(g.P, field, half, depth=0.060, axis='Y')
    # cheeks / jaw plates
    for s in (-1, 1):
        d = K.smin(d, K.sd_ellipsoid(g.P, (0.094, s * 0.050, 0.598), (0.068, 0.034, 0.056)), 0.030)
    # brow ridges
    for s in (-1, 1):
        d = K.smin(d, K.sd_ellipsoid(g.P, (0.112, s * 0.054, 0.716), (0.030, 0.018, 0.014)), 0.014)
    # eyes: a shallow socket and a ball that stands a little proud of it
    for s in (-1, 1):
        d = K.subtract(d, K.sd_sphere(g.P, (0.116, s * 0.090, 0.694), 0.021), 0.008)
        d = K.smin(d, K.sd_ellipsoid(g.P, (0.116, s * 0.063, 0.694), (0.016, 0.011, 0.013)), 0.004)
    # nostrils: flared ovals on the front corners of the muzzle
    for s in (-1, 1):
        d = K.subtract(d, K.sd_ellipsoid(g.P, (0.270, s * 0.026, 0.640), (0.010, 0.011, 0.017),
                                         rot=K.rot_matrix([('Z', s * 25)])), 0.006)
    # mouth line on each side
    for s in (-1, 1):
        d = K.subtract(d, K.sd_capsule(g.P, (0.282, s * 0.040, 0.598), (0.200, s * 0.054, 0.574), 0.0055), 0.005)
    # ears: split into two with a slot, and cup each ear
    d = K.subtract(d, K.sd_box(g.P, (0.050, 0.0, 0.846), (0.062, 0.010, 0.062), r=0.004), 0.006)
    for s in (-1, 1):
        d = K.subtract(d, K.sd_ellipsoid(g.P, (0.068, s * 0.030, 0.814), (0.010, 0.010, 0.024)), 0.004)

    # mane: a band standing ~1 mm proud along the crest, cut into diagonal locks
    crest = [(0.004, 0.796), (-0.030, 0.782), (-0.068, 0.756), (-0.100, 0.720), (-0.124, 0.672),
             (-0.140, 0.614), (-0.148, 0.552), (-0.150, 0.484), (-0.144, 0.412), (-0.134, 0.330),
             (-0.128, 0.250)]
    region = None
    for (a, b) in zip(crest[:-1], crest[1:]):
        c = K.sd_capsule(g.P, (a[0], 0.0, a[1]), (b[0], 0.0, b[1]), 0.052)
        region = c if region is None else np.minimum(region, c)
    band = K.intersect(d - 0.009, region, 0.006)
    # locks: slabs across the band, tilted down-and-back, alternating a little in angle
    n_locks = 12
    L = [0.0]
    for i in range(1, len(crest)):
        L.append(L[-1] + math.dist(crest[i - 1], crest[i]))
    cuts = None
    for i in range(n_locks):
        sL = (i + 0.35) / n_locks * L[-1]
        j = max(k for k in range(len(L) - 1) if L[k] <= sL)
        f = (sL - L[j]) / (L[j + 1] - L[j])
        cx = crest[j][0] + (crest[j + 1][0] - crest[j][0]) * f
        cz = crest[j][1] + (crest[j + 1][1] - crest[j][1]) * f
        tx, tz = crest[j + 1][0] - crest[j][0], crest[j + 1][1] - crest[j][1]
        ang = math.degrees(math.atan2(tz, tx))           # crest direction in the XZ plane
        tilt = 38 + (6 if i % 2 else -6)
        rot = K.rot_matrix([('Y', -(ang + tilt))])
        slab = K.sd_box(g.P, (cx, 0.0, cz), (0.075, 0.2, 0.0042), r=0.002, rot=rot)
        cuts = slab if cuts is None else np.minimum(cuts, slab)
    band = K.subtract(band, cuts, 0.004)
    d = K.smin(d, band, 0.003)
    # seat: cut flat inside the base collar
    d = K.intersect(d, K.sd_plane(g.P, (0, 0, 0.272), (0, 0, -1)))
    ob = g.to_mesh(d, 'classic_knight_head', coll, adaptivity=0.0)
    K.keep_largest_parts(ob, 0.05)
    return ob


# ---------------------------------------------------------------------------------------------

def model(knight_vs=0.0028):
    """Build the six pieces (white copies only; black shares the meshes) into collection set_classic."""
    coll = K.collection(COLL, clear=True)
    out = {}

    out['pawn'] = K.lathe('classic_pawn', pawn_profile(), SEG, coll)

    rook = K.lathe('classic_rook', rook_profile(), SEG, coll)
    n = 6
    for i in range(n):
        c = notch_cutter('cut', coll, 360 * i / n + 30, 0.21, 0.628, 0.72, 0.030)
        K.boolean(rook, c)
    out['rook'] = rook

    bishop = K.lathe('classic_bishop', bishop_profile(), 144, coll)
    # the mitre cut: a slab entering from the side and running two-thirds of the way through, tilted like the
    # real cut. Seen from either seat it is a clean notch in the mitre's outline (a front cut is only ever
    # seen by the opponent); a finer lathe and sharp slot edges keep its lips straight
    slab = K.mesh_object('slit', [(0.0, -0.0125, -0.10), (0.20, -0.0125, -0.10), (0.20, 0.0125, -0.10), (0.0, 0.0125, -0.10),
                                  (0.0, -0.0125, 0.10), (0.20, -0.0125, 0.10), (0.20, 0.0125, 0.10), (0.0, 0.0125, 0.10)],
                         [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)], coll)
    slab.rotation_euler = (math.radians(38), 0.0, 0.0)
    slab.location = (-0.028, 0.0, 0.705)
    K.apply_transform(slab)
    K.boolean(bishop, slab)
    K.shade(bishop, 40.0)
    out['bishop'] = bishop

    qp, zr = queen_profile()
    queen = K.lathe('classic_queen', qp, SEG, coll)
    for i in range(8):
        c = notch_cutter('cut', coll, 360 * i / 8 + 22.5, 0.23, zr + 0.022, zr + 0.06, 0.036, v_notch=True, r_in=0.150)
        K.boolean(queen, c)
    out['queen'] = queen

    kp, ztop = king_profile()
    king = K.lathe('classic_king', kp, SEG, coll)
    cross = cross_pattee('classic_king_cross', coll, H['king'] - ztop + 0.012, 0.128, 0.046, ztop - 0.012)
    out['king'] = K.join([king, cross], 'classic_king')

    base = K.lathe('classic_knight', knight_base_profile(), SEG, coll)
    head = knight_head(coll, knight_vs)
    K.decimate(head, target_tris=42000)
    kn = K.join([base, head], 'classic_knight')
    kn.rotation_euler.z = math.radians(-90)       # muzzle +X -> -Y (the board's +Z)
    K.apply_transform(kn)
    out['knight'] = kn

    # lay them out in a row for previews: pawn .. king along +X
    for i, role in enumerate(K.ROLES):
        ob = out[role]
        ob.location = (0, 0, 0)
    report = {r: (K.tri_count(o), [round(float(v), 3) for v in K.bounds(o)[1]]) for r, o in out.items()}
    return report


def preview(path=None, row=True, lens=70):
    """Render the six white pieces in a row on the grey sweep (shape check, no materials)."""
    import bpy
    K.preview_scene()
    objs = [bpy.data.objects['classic_' + r] for r in K.ROLES]
    for i, o in enumerate(objs):
        o.location = ((i - 2.5) * 0.62, 0, 0)
    m, N, bsdf, _ = K.new_material('__clay')
    bsdf.inputs['Base Color'].default_value = (0.75, 0.72, 0.68, 1)
    bsdf.inputs['Roughness'].default_value = 0.45
    for o in objs:
        K.assign(o, m)
    path = path or K.WORK + '/classic/preview_shapes.png'
    K.render_preview(path, (0.0, -6.2, 1.9), (0.0, 0.0, 0.50), lens=50, res=(1800, 800), samples=32, only=objs)
    return path


def preview_knight(path=None):
    import bpy
    K.preview_scene()
    kn = bpy.data.objects['classic_knight']
    for r in K.ROLES:
        bpy.data.objects['classic_' + r].location = (0, 30, 0)
    kn.location = (0, 0, 0)
    paths = []
    for tag, loc in (('front', (0.0, -2.2, 0.62)), ('front34', (-1.6, -1.25, 0.75)), ('back34', (1.4, 1.4, 0.9))):
        p = K.WORK + '/classic/knight_%s.png' % tag
        K.render_preview(p, loc, (0.0, 0.0, 0.50), lens=85, res=(900, 900), samples=32, only=[kn])
        paths.append(p)
    return paths


# ---------------------------------------------------------------------------------------------
# Materials (procedural, baked into the atlas)

def lin(hexstr):
    """sRGB hex -> linear RGB tuple."""
    h = hexstr.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def _wood(name, light, dark, rough, coat, coat_rough, grain_scale, pore_amount, seed_scale=1.0, streak=None,
          late=0.80, glow=None):
    """Turned wood. late: where the late-wood band starts in each ring (higher = finer, fainter grain lines).
    glow (optional colour): the hollows warm toward it instead of greying -- light passing through the thin
    edges of a dense pale wood."""
    m, N, bsdf, out = K.new_material(name)
    tc = N.n('ShaderNodeTexCoord')
    oi = N.n('ShaderNodeObjectInfo')
    # a per-object random offset so no two pieces share a grain
    rnd = N.n('ShaderNodeVectorMath', operation='MULTIPLY')
    N.link(oi.outputs['Random'], rnd.inputs[0])
    rnd.inputs[1].default_value = (7.3 * seed_scale, 3.1 * seed_scale, 5.7 * seed_scale)
    off = N.n('ShaderNodeVectorMath', operation='ADD')
    N.link(tc.outputs['Object'], off.inputs[0])
    N.link(rnd.outputs['Vector'], off.inputs[1])
    # growth rings run as near-vertical planes through a turned blank: bands along Y, warped by noise. (Along Y,
    # not X: the knight's flat flanks face +-X, and planes parallel to a flank drew map-like contour loops on it.)
    warp = N.n('ShaderNodeTexNoise', i_Scale=2.2, i_Detail=3.0, i_Roughness=0.55)
    N.link(off.outputs['Vector'], warp.inputs['Vector'])
    wv = N.n('ShaderNodeVectorMath', operation='SUBTRACT')
    N.link(warp.outputs['Color'], wv.inputs[0])
    wv.inputs[1].default_value = (0.5, 0.5, 0.5)
    wsc = N.n('ShaderNodeVectorMath', operation='SCALE')
    N.link(wv.outputs['Vector'], wsc.inputs[0])
    wsc.inputs['Scale'].default_value = 0.10
    co = N.n('ShaderNodeVectorMath', operation='ADD')
    N.link(off.outputs['Vector'], co.inputs[0])
    N.link(wsc.outputs['Vector'], co.inputs[1])
    wave = N.n('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Y', wave_profile='SAW',
               i_Scale=grain_scale, i_Distortion=2.5, i_Detail=2.0, i_Detail_Scale=1.2)
    N.link(co.outputs['Vector'], wave.inputs['Vector'])
    ramp = N.n('ShaderNodeValToRGB')
    el = ramp.color_ramp.elements
    el[0].position, el[0].color = 0.0, (*light, 1)
    el[1].position, el[1].color = late, (*light, 1)
    e2 = el.new(1.0)
    e2.color = (*dark, 1)
    N.link(wave.outputs['Fac'], ramp.inputs['Fac'])
    # slow colour drift (heart / sap wood)
    drift = N.n('ShaderNodeTexNoise', i_Scale=1.3, i_Detail=2.0)
    N.link(off.outputs['Vector'], drift.inputs['Vector'])
    driftm = N.n('ShaderNodeMapRange', i_From_Min=0.3, i_From_Max=0.7, i_To_Min=0.90, i_To_Max=1.06)
    N.link(drift.outputs['Fac'], driftm.inputs['Value'])
    tint = N.n('ShaderNodeVectorMath', operation='SCALE')
    N.link(ramp.outputs['Color'], tint.inputs[0])
    N.link(driftm.outputs['Result'], tint.inputs['Scale'])
    base_col = tint.outputs['Vector']
    if streak:
        # ebony: sparse lighter streaks along the grain
        sk = N.n('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Y', wave_profile='SIN',
                 i_Scale=grain_scale * 0.35, i_Distortion=8.0, i_Detail=4.0)
        N.link(co.outputs['Vector'], sk.inputs['Vector'])
        skm = N.n('ShaderNodeMapRange', i_From_Min=0.82, i_From_Max=1.0, i_To_Min=0.0, i_To_Max=1.0)
        N.link(sk.outputs['Fac'], skm.inputs['Value'])
        mixs = N.n('ShaderNodeMixRGB', blend_type='MIX')
        N.link(skm.outputs['Result'], mixs.inputs['Fac'])
        N.link(base_col, mixs.inputs['Color1'])
        mixs.inputs['Color2'].default_value = (*streak, 1)
        base_col = mixs.outputs['Color']
    if glow:
        ao = N.n('ShaderNodeAmbientOcclusion', samples=16, only_local=True, i_Distance=0.03)
        gk = N.n('ShaderNodeMapRange', i_From_Min=1.0, i_From_Max=0.55, i_To_Min=0.0, i_To_Max=0.55)
        N.link(ao.outputs['AO'], gk.inputs['Value'])
        gmix = N.n('ShaderNodeMixRGB', blend_type='MIX')
        N.link(gk.outputs['Result'], gmix.inputs['Fac'])
        N.link(base_col, gmix.inputs['Color1'])
        gmix.inputs['Color2'].default_value = (*glow, 1)
        base_col = gmix.outputs['Color']
    pores = N.n('ShaderNodeTexNoise', i_Scale=520.0, i_Detail=1.0)
    N.link(co.outputs['Vector'], pores.inputs['Vector'])
    # baize under the foot: faces pointing straight down
    geo = N.n('ShaderNodeNewGeometry')
    sep = N.n('ShaderNodeSeparateXYZ')
    N.link(geo.outputs['Normal'], sep.inputs['Vector'])
    down = N.n('ShaderNodeMath', operation='LESS_THAN')
    N.link(sep.outputs['Z'], down.inputs[0])
    down.inputs[1].default_value = -0.85
    sepo = N.n('ShaderNodeSeparateXYZ')
    N.link(tc.outputs['Object'], sepo.inputs['Vector'])
    low = N.n('ShaderNodeMath', operation='LESS_THAN')
    N.link(sepo.outputs['Z'], low.inputs[0])
    low.inputs[1].default_value = 0.002
    felt = N.n('ShaderNodeMath', operation='MULTIPLY')
    N.link(down.outputs['Value'], felt.inputs[0])
    N.link(low.outputs['Value'], felt.inputs[1])
    fmix = N.n('ShaderNodeMixRGB', blend_type='MIX')
    N.link(felt.outputs['Value'], fmix.inputs['Fac'])
    N.link(base_col, fmix.inputs['Color1'])
    fmix.inputs['Color2'].default_value = (0.012, 0.052, 0.022, 1)
    N.link(fmix.outputs['Color'], bsdf.inputs['Base Color'])
    # roughness: a touch rougher in the late wood, baize fully rough
    rw = N.n('ShaderNodeMapRange', i_From_Min=0.0, i_From_Max=1.0, i_To_Min=rough - 0.03, i_To_Max=rough + 0.05)
    N.link(wave.outputs['Fac'], rw.inputs['Value'])
    rf = N.n('ShaderNodeMix', data_type='FLOAT')
    N.link(felt.outputs['Value'], rf.inputs['Factor'])
    N.link(rw.outputs['Result'], rf.inputs['A'])
    rf.inputs['B'].default_value = 1.0
    N.link(rf.outputs['Result'], bsdf.inputs['Roughness'])
    # bump: pores plus the faintest grain relief
    bsum = N.n('ShaderNodeMath', operation='MULTIPLY_ADD')
    N.link(pores.outputs['Fac'], bsum.inputs[0])
    bsum.inputs[1].default_value = pore_amount
    N.link(wave.outputs['Fac'], bsum.inputs[2])
    bump = N.n('ShaderNodeBump', i_Strength=0.05, i_Distance=0.0015)
    N.link(bsum.outputs['Value'], bump.inputs['Height'])
    N.link(bump.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Coat Weight'].default_value = coat
    bsdf.inputs['Coat Roughness'].default_value = coat_rough
    return m


def materials():
    white = _wood('classic_src_boxwood', lin('#E9D3A2'), lin('#E1C995'), 0.42, 0.35, 0.18, 12.0, 0.22,
                  late=0.97)
    black = _wood('classic_src_ebony', lin('#15100C'), lin('#0C0908'), 0.28, 0.70, 0.05, 70.0, 0.4,
                  seed_scale=1.7, streak=lin('#1F1712'))
    return {'white': white, 'black': black}


PARAMS = {
    'white': {'coat': 0.35, 'coat_rough': 0.18, 'metallic': 0.0},
    'black': {'coat': 0.70, 'coat_rough': 0.05, 'metallic': 0.0},
}


def pieces():
    import bpy
    return [bpy.data.objects['classic_' + r] for r in K.ROLES]


def build(size=2048, export=True):
    """model -> UV atlas -> bake -> export GLB -> save a copy of the .blend."""
    import bpy
    import os
    report = model()
    objs = pieces()
    for o in objs:
        while o.data.uv_layers:
            o.data.uv_layers.remove(o.data.uv_layers[0])
        K.smart_uv(o, angle=66.0, margin=0.0)
    K.uv_atlas(objs)
    mats = materials()
    baked = K.bake_set(SET_ID, objs, mats, size=size, ao_distance=0.10)
    path = None
    if export:
        path, mw, mb = K.export_set(SET_ID, objs, baked, PARAMS)
    os.makedirs(K.WORK + '/classic', exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=K.WORK + '/classic/classic.blend', copy=True)
    return {'report': report, 'glb': path}


def preview_baked(path=None):
    """Both colours with the baked (export) materials, on the grey sweep."""
    import bpy
    K.preview_scene()
    objs = pieces()
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
    path = path or K.WORK + '/classic/preview_baked.png'
    K.render_preview(path, (0.4, -5.6, 2.3), (0.0, 0.3, 0.45), lens=50, res=(1800, 1000), samples=64, only=objs + blacks)
    for b in blacks:
        K.remove(b)
    return path
