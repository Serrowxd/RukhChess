"""cbkit -- the Blender toolkit behind the Rukh piece sets.

Runs inside Blender 4.5 LTS (its bundled numpy, scipy and openvdb). Each set script (set_*.py) models
its six pieces with these helpers, bakes its procedural materials into one texture atlas, and exports a
single GLB that the board loads from web/sets/<id>.glb.

Units: one Blender unit is one board square. Blender is Z-up; the glTF exporter turns that into three's
Y-up. Pieces stand on z = 0 centred on the origin. A piece with a front (the knight) faces -Y here, which
the exporter maps to +Z in three.js -- the direction White's pieces face on the board.

Sections: profiles (lathe) - mesh helpers - SDF modelling (numpy + OpenVDB) - UV atlas - materials -
baking - export - preview renders.
"""
import bpy
import bmesh
import math
import os
import time
import numpy as np
from mathutils import Vector, Matrix

# Paths. REPO is the checkout this file sits in. RUKH_WORK is where the heavy work files go (.blend copies,
# baked PNGs, previews); it defaults to blender/work/ inside the repo, which git ignores.
REPO = os.environ.get('RUKH_REPO') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK = os.environ.get('RUKH_WORK') or os.path.join(REPO, 'blender', 'work')
SETS_OUT = os.path.join(REPO, 'web', 'sets')
ASSETS_OUT = os.path.join(REPO, 'web', 'src', 'assets')
ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king']

# The board's height ladder (web/src/three/pieces.js HEIGHTS). The loader scales every set so its king is
# HEIGHTS['king'] tall, so a set keeps its own proportions below that.
HEIGHTS = {'pawn': 0.58, 'knight': 0.80, 'bishop': 0.88, 'rook': 0.70, 'queen': 1.02, 'king': 1.18}

TAU = math.tau


def log(*a):
    print('[cbkit]', *a)


# =============================================================================================
# Profiles: a turner's pass as (radius, height) points, bottom to top.
# =============================================================================================

class Turn:
    """Fluent profile builder (a port of the board's own turn() in pieces.js).

    move/line/curve/arc append points; crease() marks the last point as a hard edge (its ring gets a sharp
    edge, so the two sides keep their own normals).
    """

    def __init__(self, r=0.0, z=0.0):
        self.pts = [(max(0.0, r), z)]
        self.sharp = set()

    def at(self):
        return self.pts[-1]

    def move(self, r, z):
        self.pts.append((max(0.0, r), z))
        return self

    def crease(self):
        self.sharp.add(len(self.pts) - 1)
        return self

    def line(self, r, z, n=1):
        r0, z0 = self.at()
        for i in range(1, n + 1):
            t = i / n
            self.pts.append((max(0.0, r0 + (r - r0) * t), z0 + (z - z0) * t))
        return self

    def curve(self, c0, c1, p1, n=8):
        """Cubic Bezier from the current point through controls c0, c1 to p1 (all (r, z))."""
        p0 = self.at()
        for i in range(1, n + 1):
            t = i / n
            u = 1 - t
            a, b, c, d = u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t
            self.pts.append((max(0.0, a * p0[0] + b * c0[0] + c * c1[0] + d * p1[0]),
                             a * p0[1] + b * c0[1] + c * c1[1] + d * p1[1]))
        return self

    def arc(self, cr, cz, rad, a0, a1, n=8):
        """Circular arc about centre (cr, cz), angles in degrees (0 = +r, 90 = +z), excluding a0."""
        for i in range(1, n + 1):
            a = math.radians(a0 + (a1 - a0) * i / n)
            self.pts.append((max(0.0, cr + rad * math.cos(a)), cz + rad * math.sin(a)))
        return self

    def bead(self, rad, n=10, up=True):
        """A half-round bead that bulges outward from the current point and returns to the same radius
        `2*rad` higher (or lower)."""
        r0, z0 = self.at()
        s = 1 if up else -1
        return self.arc(r0, z0 + s * rad, rad, -90 * s, 90 * s, n)

    def done(self):
        return self.pts, set(self.sharp)


def profile_length(pts):
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


# =============================================================================================
# Collections / objects
# =============================================================================================

def collection(name, parent=None, clear=False):
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(coll)
    if clear:
        for o in list(coll.objects):
            me = o.data if o.type == 'MESH' else None
            bpy.data.objects.remove(o, do_unlink=True)
            if me is not None and me.users == 0:
                bpy.data.meshes.remove(me)
        for c in list(coll.children):
            collection(c.name, clear=True)
            bpy.data.collections.remove(c)
    return coll


def link(obj, coll=None):
    for c in list(obj.users_collection):
        c.objects.unlink(obj)
    (coll or bpy.context.scene.collection).objects.link(obj)
    return obj


def remove(obj):
    me = obj.data if obj.type == 'MESH' else None
    bpy.data.objects.remove(obj, do_unlink=True)
    if me is not None and me.users == 0:
        bpy.data.meshes.remove(me)


def mesh_object(name, verts, faces, coll=None, uv=None):
    """Object from vertices (n,3) and faces (list of index sequences, or an (m,k) int array).
    uv: optional per-loop (u, v) list in face-corner order."""
    verts = np.asarray(verts, dtype=np.float32).reshape(-1, 3)
    me = bpy.data.meshes.new(name)
    if isinstance(faces, np.ndarray):
        faces = faces.astype(np.int64)
        k = faces.shape[1]
        loop_idx = faces.ravel()
        starts = np.arange(0, len(faces) * k, k, dtype=np.int64)
        me.vertices.add(len(verts))
        me.vertices.foreach_set('co', verts.ravel())
        me.loops.add(len(loop_idx))
        me.loops.foreach_set('vertex_index', loop_idx.astype(np.int32))
        me.polygons.add(len(faces))
        me.polygons.foreach_set('loop_start', starts.astype(np.int32))
    else:
        me.from_pydata(verts.tolist(), [], [list(f) for f in faces])
    me.update(calc_edges=True)
    if uv is not None:
        layer = me.uv_layers.new(name='UVMap')
        layer.data.foreach_set('uv', np.asarray(uv, dtype=np.float32).ravel())
    me.validate(clean_customdata=False)
    obj = bpy.data.objects.new(name, me)
    link(obj, coll)
    return obj


def ctx_view3d():
    """A context override with a VIEW_3D area (for operators that need one)."""
    win = bpy.context.window_manager.windows[0]
    for area in win.screen.areas:
        if area.type == 'VIEW_3D':
            region = next(r for r in area.regions if r.type == 'WINDOW')
            return bpy.context.temp_override(window=win, area=area, region=region, screen=win.screen)
    return bpy.context.temp_override(window=win)


def select_only(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def apply_modifiers(obj):
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=True, depsgraph=dg)
    old = obj.data
    obj.modifiers.clear()
    obj.data = me
    if old.users == 0:
        bpy.data.meshes.remove(old)
    return obj


def apply_transform(obj):
    mw = obj.matrix_basis.copy()
    obj.data.transform(mw)
    obj.matrix_basis = Matrix.Identity(4)
    return obj


def join(objs, name=None):
    objs = [o for o in objs if o is not None]
    if len(objs) == 1:
        if name:
            objs[0].name = name
        return objs[0]
    with ctx_view3d():
        select_only(objs, objs[0])
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    if name:
        o.name = name
        o.data.name = name
    return o


def boolean(target, cutter, op='DIFFERENCE', solver='EXACT', keep_cutter=False):
    """One boolean, applied immediately. Never pre-join overlapping cutters (EXACT empties the result);
    call this once per cutter."""
    n0 = len(target.data.vertices)
    m = target.modifiers.new('bool', 'BOOLEAN')
    m.operation = op
    m.object = cutter
    m.solver = solver
    apply_modifiers(target)
    if not keep_cutter:
        remove(cutter)
    if len(target.data.vertices) == 0:
        raise RuntimeError('boolean emptied %s (had %d verts)' % (target.name, n0))
    return target


def shade(obj, angle_deg=35.0):
    """Smooth shading with sharp edges wherever faces meet at more than angle_deg, plus any edge already
    flagged sharp."""
    me = obj.data
    me.shade_smooth()
    try:
        me.set_sharp_from_angle(angle=math.radians(angle_deg))
    except AttributeError:
        with ctx_view3d():
            select_only([obj])
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg), keep_sharp_edges=True)
    return obj


def weld(obj, dist=1e-5):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=dist)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def recalc_normals(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def keep_largest_parts(obj, min_fraction=0.02):
    """Drop disconnected islands smaller than min_fraction of the largest (SDF noise specks)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    seen = set()
    islands = []
    for v in bm.verts:
        if v.index in seen:
            continue
        stack = [v]
        isl = []
        seen.add(v.index)
        while stack:
            x = stack.pop()
            isl.append(x)
            for e in x.link_edges:
                w = e.other_vert(x)
                if w.index not in seen:
                    seen.add(w.index)
                    stack.append(w)
        islands.append(isl)
    if len(islands) > 1:
        big = max(len(i) for i in islands)
        kill = [v for isl in islands if len(isl) < big * min_fraction for v in isl]
        if kill:
            bmesh.ops.delete(bm, geom=kill, context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def decimate(obj, target_tris=None, ratio=None, symmetry_axis=None):
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if ratio is None:
        if not target_tris or tris <= target_tris:
            return obj
        ratio = target_tris / tris
    m = obj.modifiers.new('dec', 'DECIMATE')
    m.decimate_type = 'COLLAPSE'
    m.ratio = ratio
    m.use_collapse_triangulate = True
    if symmetry_axis:
        m.use_symmetry = True
        m.symmetry_axis = symmetry_axis
    apply_modifiers(obj)
    return obj


def subdivide(obj, levels=3):
    """Simple (flat) subdivision -- same surface, denser mesh: a bake source whose per-vertex attributes can
    carry detail finer than the hard-surface model's big faces."""
    m = obj.modifiers.new('subd', 'SUBSURF')
    m.subdivision_type = 'SIMPLE'
    m.levels = levels
    m.render_levels = levels
    apply_modifiers(obj)
    return obj


def transfer_normals(dst, src):
    """Give dst the shading (custom split normals) of src, which it overlaps exactly: a subdivided bake source
    then shades like the hard-surface model it came from, so the normal map carries only the material's relief."""
    m = dst.modifiers.new('normals', 'DATA_TRANSFER')
    m.object = src
    m.use_loop_data = True
    m.data_types_loops = {'CUSTOM_NORMAL'}
    m.loop_mapping = 'POLYINTERP_NEAREST'
    apply_modifiers(dst)
    return dst


def hard_surface_high(lo, levels=3, stain_reach=0.09):
    """The bake source for a hard-surface piece: a copy, subdivided flat and shaded flat (true face normals,
    so a material that reads the normal -- walls vs tops -- sees the real faces), carrying the rain-stain
    attribute at the finer density. Bake its normal map from the piece itself (bake_set normal_from_low):
    the piece's own bevelled, weighted normals are the shading the map must sit on."""
    hi = lo.copy()
    hi.data = lo.data.copy()
    link(hi, lo.users_collection[0])
    hi.name = lo.name + '_hi'
    hi.data.name = hi.name
    subdivide(hi, levels)
    with ctx_view3d():
        select_only([hi])
        try:
            bpy.ops.mesh.customdata_custom_splitnormals_clear()
        except RuntimeError:
            pass
    hi.data.shade_flat()
    stain_attribute(hi, reach=stain_reach)
    return hi


def stain_attribute(obj, reach=0.08, name='stain', offsets=(0.003, -0.002)):
    """Per-vertex water staining: on every wall (a near-horizontal normal) look straight up for the ledge,
    sill or window head that sheds rain onto it -- a ray from just outside the wall (finds overhangs) and one
    from just inside it (finds the recess of a window above). stain = (1 - distance / reach)^1.5."""
    from mathutils.bvhtree import BVHTree
    me = obj.data
    bvh = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    nor = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get('normal', nor)
    nor = nor.reshape(-1, 3)
    out = np.zeros(n, dtype=np.float32)
    up = Vector((0.0, 0.0, 1.0))
    walls = np.nonzero(np.abs(nor[:, 2]) < 0.35)[0]
    for i in walls:
        best = reach
        for off in offsets:
            p = Vector((co[i, 0] + nor[i, 0] * off, co[i, 1] + nor[i, 1] * off, co[i, 2] + 0.0005))
            hit = bvh.ray_cast(p, up, reach)
            if hit[0] is not None and hit[3] < best:
                best = hit[3]
        out[i] = max(0.0, 1.0 - best / reach) ** 1.5
    set_attribute(obj, name, out)
    return obj


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def bounds(obj):
    co = np.empty(len(obj.data.vertices) * 3, dtype=np.float32)
    obj.data.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    mw = np.array(obj.matrix_world)
    co = co @ mw[:3, :3].T + mw[:3, 3]
    return co.min(0), co.max(0)


def set_attribute(obj, name, values, domain='POINT', kind='FLOAT'):
    me = obj.data
    a = me.attributes.get(name) or me.attributes.new(name, kind, domain)
    a.data.foreach_set('value', np.asarray(values, dtype=np.float32))
    return a


# =============================================================================================
# Lathe
# =============================================================================================

def lathe(name, profile, segments=96, coll=None, seam_angle=90.0, uv=True):
    """Revolve a Turn (or (pts, sharp)) about Z. Points with r == 0 become poles. The ring of every
    creased point is marked sharp. UVs: one cylindrical island (u around, v along the profile) with the
    seam at seam_angle degrees (90 = the +Y side, the back of a White piece)."""
    if isinstance(profile, Turn):
        pts, sharp = profile.done()
    else:
        pts, sharp = profile
    # drop exact consecutive duplicates, carrying their crease flag forward
    clean, cs = [], set()
    for i, p in enumerate(pts):
        if clean and abs(p[0] - clean[-1][0]) < 1e-7 and abs(p[1] - clean[-1][1]) < 1e-7:
            if i in sharp:
                cs.add(len(clean) - 1)
            continue
        if i in sharp:
            cs.add(len(clean))
        clean.append(p)
    pts = clean
    n = segments
    a0 = math.radians(seam_angle)
    verts, rings = [], []
    for (r, z) in pts:
        if r < 1e-6:
            rings.append([len(verts)])
            verts.append((0.0, 0.0, z))
        else:
            idx = []
            for s in range(n):
                a = a0 + TAU * s / n
                idx.append(len(verts))
                verts.append((r * math.cos(a), r * math.sin(a), z))
            rings.append(idx)
    # arc length along the profile for v
    L = [0.0]
    for i in range(1, len(pts)):
        L.append(L[-1] + math.dist(pts[i - 1], pts[i]))
    total = L[-1] or 1.0
    rmax = max(p[0] for p in pts) or 1.0
    circ = TAU * rmax * 0.72    # u extent in the same units as v (a mean radius, roughly)
    faces, uvs = [], []
    for i in range(len(rings) - 1):
        A, B = rings[i], rings[i + 1]
        va, vb = L[i] / total * total, L[i + 1] / total * total
        if len(A) == 1 and len(B) == 1:
            continue
        for s in range(n):
            u0, u1 = s / n * circ, (s + 1) / n * circ
            if len(A) == 1:
                faces.append((A[0], B[(s + 1) % n], B[s]))
                uvs += [((u0 + u1) / 2, va), (u1, vb), (u0, vb)]
            elif len(B) == 1:
                faces.append((A[s], A[(s + 1) % n], B[0]))
                uvs += [(u0, va), (u1, va), ((u0 + u1) / 2, vb)]
            else:
                faces.append((A[s], A[(s + 1) % n], B[(s + 1) % n], B[s]))
                uvs += [(u0, va), (u1, va), (u1, vb), (u0, vb)]
    obj = mesh_object(name, verts, faces, coll, uv=uvs if uv else None)
    # sharp rings
    me = obj.data
    if cs:
        sharp_verts = set()
        for i in cs:
            if len(rings[i]) > 1:
                sharp_verts.update(rings[i])
        attr = me.attributes.get('sharp_edge') or me.attributes.new('sharp_edge', 'BOOLEAN', 'EDGE')
        vals = [bool(e.vertices[0] in sharp_verts and e.vertices[1] in sharp_verts) for e in me.edges]
        attr.data.foreach_set('value', vals)
    me.shade_smooth()
    return obj


# =============================================================================================
# Curves -> meshes (extruded outlines, sweeps)
# =============================================================================================

def extrude_outline(name, outline, depth, bevel=0.0, bevel_res=3, coll=None, plane='XZ', holes=()):
    """Extrude a closed 2D outline (list of (a, b)) symmetrically by `depth` with a rounded bevel.
    plane 'XZ' puts a->X, b->Z and extrudes along Y (a standing profile)."""
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '2D'
    cu.fill_mode = 'BOTH'
    cu.extrude = max(0.0, depth / 2 - bevel)
    cu.bevel_depth = bevel
    cu.bevel_resolution = bevel_res
    cu.resolution_u = 12
    for loop in (outline, *holes):
        sp = cu.splines.new('POLY')
        sp.points.add(len(loop) - 1)
        for p, (a, b) in zip(sp.points, loop):
            p.co = (a, b, 0.0, 1.0)
        sp.use_cyclic_u = True
    ob = bpy.data.objects.new(name, cu)
    link(ob, coll)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    remove_curve = ob.data
    bpy.data.objects.remove(ob, do_unlink=True)
    bpy.data.curves.remove(remove_curve)
    obj = bpy.data.objects.new(name, me)
    link(obj, coll)
    if plane == 'XZ':
        obj.data.transform(Matrix.Rotation(math.pi / 2, 4, 'X'))
    weld(obj, 1e-6)
    return obj


# =============================================================================================
# Hard-surface primitives (bmesh) + bevel / weighted normals, for the architectural sets.
# =============================================================================================

def _bm_object(name, bm, coll=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    link(obj, coll)
    return obj


def box(name, center, size, coll=None, rot_z=0.0, rot=None):
    """Box (full size (sx, sy, sz)) centred at `center`. rot_z turns it about Z; rot = (x, y, z) Euler degrees
    (XYZ order) turns it about its OWN centre -- the object origin stays at the world origin."""
    from mathutils import Euler
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    if rot:
        e = Euler([math.radians(a) for a in rot], 'XYZ')
        bmesh.ops.rotate(bm, verts=bm.verts, cent=Vector((0, 0, 0)), matrix=e.to_matrix())
    if rot_z:
        bmesh.ops.rotate(bm, verts=bm.verts, cent=Vector((0, 0, 0)), matrix=Matrix.Rotation(math.radians(rot_z), 3, 'Z'))
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return _bm_object(name, bm, coll)


def box_z(name, x, y, z0, z1, sx, sy, coll=None, rot_z=0.0):
    """Box standing from z0 to z1, centred on (x, y), footprint sx by sy."""
    return box(name, (x, y, (z0 + z1) / 2), (sx, sy, z1 - z0), coll, rot_z)


def cylinder(name, center, r, h, coll=None, segments=64, r2=None, axis='Z'):
    """Cylinder (or cone frustum with r2) of height h centred at `center`."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=r,
                          radius2=r if r2 is None else r2, depth=h)
    if axis == 'X':
        bmesh.ops.rotate(bm, verts=bm.verts, cent=Vector((0, 0, 0)), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    elif axis == 'Y':
        bmesh.ops.rotate(bm, verts=bm.verts, cent=Vector((0, 0, 0)), matrix=Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return _bm_object(name, bm, coll)


def prism(name, outline, z0, z1, coll=None, plane='XY'):
    """Extrude a closed polygon (CCW (a, b) points) from z0 to z1. plane 'XY' = footprint; 'XZ' = a profile
    in X/Z extruded along Y from z0 to z1 (then z0/z1 are y values)."""
    bm = bmesh.new()
    n = len(outline)
    if plane == 'XY':
        lo = [bm.verts.new((a, b, z0)) for a, b in outline]
        hi = [bm.verts.new((a, b, z1)) for a, b in outline]
    else:
        lo = [bm.verts.new((a, z0, b)) for a, b in outline]
        hi = [bm.verts.new((a, z1, b)) for a, b in outline]
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return _bm_object(name, bm, coll)


def uv_sphere(name, center, r, coll=None, segments=48, rings=24):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=r)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    return _bm_object(name, bm, coll)


def union_all(target, others, solver='EXACT'):
    for o in others:
        boolean(target, o, 'UNION', solver)
    return target


def cut_all(target, cutters, solver='EXACT'):
    for c in cutters:
        boolean(target, c, 'DIFFERENCE', solver)
    return target


def bevel(obj, width=0.006, segments=3, angle_deg=40.0, harden=True, profile=0.5):
    """Bevel every edge sharper than angle_deg (applied), then weighted normals so flat faces stay flat."""
    m = obj.modifiers.new('bevel', 'BEVEL')
    m.width = width
    m.segments = segments
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle_deg)
    m.profile = profile
    m.use_clamp_overlap = True
    m.harden_normals = harden
    m.miter_outer = 'MITER_ARC'
    apply_modifiers(obj)
    obj.data.shade_smooth()
    wn = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
    wn.keep_sharp = True
    wn.weight = 100
    wn.mode = 'FACE_AREA'
    apply_modifiers(obj)
    return obj


# =============================================================================================
# SDF modelling: evaluate a signed distance field on a dense numpy grid, mesh it with OpenVDB.
# =============================================================================================

class Grid:
    """A dense sampling grid. Coordinates X, Y, Z are float32 arrays (ij indexing)."""

    def __init__(self, lo, hi, vs):
        self.lo = np.array(lo, dtype=np.float64)
        self.hi = np.array(hi, dtype=np.float64)
        self.vs = float(vs)
        self.shape = tuple(int(math.ceil((h - l) / vs)) + 1 for l, h in zip(self.lo, self.hi))
        ax = [(self.lo[i] + np.arange(self.shape[i]) * vs).astype(np.float32) for i in range(3)]
        self.ax = ax
        self.X, self.Y, self.Z = np.meshgrid(ax[0], ax[1], ax[2], indexing='ij')

    @property
    def P(self):
        return self.X, self.Y, self.Z

    def sub(self, lo, hi):
        """Index slices + coordinate views for the axis-aligned box lo..hi (clamped to the grid)."""
        sl = []
        for i in range(3):
            a = int(max(0, math.floor((lo[i] - self.lo[i]) / self.vs)))
            b = int(min(self.shape[i], math.ceil((hi[i] - self.lo[i]) / self.vs) + 1))
            sl.append(slice(a, max(a, b)))
        sl = tuple(sl)
        return sl, (self.X[sl], self.Y[sl], self.Z[sl])

    def add(self, d, fn, lo, hi, k=0.0, op='union'):
        """Combine a primitive into d only inside its box (plus the blend margin): `fn(P)` is evaluated on the
        sub-grid. op: 'union' (smooth min), 'sub' (smooth subtract), 'inter' (smooth intersect)."""
        m = k + 2 * self.vs
        sl, P = self.sub([v - m for v in lo], [v + m for v in hi])
        if P[0].size == 0:
            return d
        prim = fn(P)
        if op == 'union':
            d[sl] = smin(d[sl], prim, k)
        elif op == 'sub':
            d[sl] = subtract(d[sl], prim, k)
        else:
            d[sl] = intersect(d[sl], prim, k)
        return d

    def empty(self):
        return np.full(self.shape, 1.0, dtype=np.float32)

    def to_mesh(self, d, name, coll=None, adaptivity=0.0, band=None):
        import openvdb
        d = np.ascontiguousarray(d, dtype=np.float32)
        band = band or 3.0 * self.vs
        np.clip(d, -band * 4, band * 4, out=d)
        g = openvdb.FloatGrid(band * 4)
        g.copyFromArray(d)
        g.transform = openvdb.createLinearTransform(voxelSize=self.vs)
        g.gridClass = openvdb.GridClass.LEVEL_SET
        pts, tris, quads = g.convertToPolygons(isovalue=0.0, adaptivity=adaptivity)
        pts = pts + self.lo.astype(np.float32)
        faces = []
        obj_parts = []
        if len(quads):
            obj_parts.append(quads)
        if len(tris):
            obj_parts.append(tris)
        if not obj_parts:
            raise RuntimeError('SDF %s produced no surface' % name)
        if len(quads) and len(tris):
            # mixed: go through from_pydata
            faces = [tuple(q) for q in quads.tolist()] + [tuple(t) for t in tris.tolist()]
            obj = mesh_object(name, pts, faces, coll)
        else:
            obj = mesh_object(name, pts, obj_parts[0], coll)
        # OpenVDB winds level-set polygons inward-facing for our sign convention; check and fix.
        me = obj.data
        vol = _signed_volume(obj)
        if vol < 0:
            for p in me.polygons:
                p.flip()
            me.update()
        me.shade_smooth()
        return obj


def carve(g, d, lo, hi, curve_fn, w, depth, region=None, k=0.002):
    """Cut a V-groove into the surface along a sheet: wherever curve_fn(P) (a signed distance to the sheet,
    evaluated on the sub-grid lo..hi) is near zero, the groove is 2*w wide at the surface and narrows to
    nothing `depth` below it -- the carver's gouge follows the form, however it curves. region (optional
    sdf, negative inside) limits where it cuts."""
    sl, P = g.sub(lo, hi)
    if P[0].size == 0:
        return d
    dd = d[sl]
    R = np.abs(curve_fn(P)) - np.float32(w) * (1.0 + dd / np.float32(depth))
    if region is not None:
        R = np.maximum(R, region(P))
    d[sl] = subtract(dd, R, k)
    return d


def _signed_volume(obj):
    me = obj.data
    me.calc_loop_triangles()
    co = np.empty(len(me.vertices) * 3, dtype=np.float64)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get('vertices', tri)
    tri = tri.reshape(-1, 3)
    a, b, c = co[tri[:, 0]], co[tri[:, 1]], co[tri[:, 2]]
    return float(np.einsum('ij,ij->i', a, np.cross(b, c)).sum() / 6.0)


# --- primitives (all return distance arrays; p = (X, Y, Z) arrays) ---------------------------

def _sub(p, c):
    return p[0] - np.float32(c[0]), p[1] - np.float32(c[1]), p[2] - np.float32(c[2])


def length(x, y, z=None):
    if z is None:
        return np.sqrt(x * x + y * y)
    return np.sqrt(x * x + y * y + z * z)


def sd_sphere(p, c, r):
    x, y, z = _sub(p, c)
    return length(x, y, z) - np.float32(r)


def sd_ellipsoid(p, c, radii, rot=None):
    """Approximate ellipsoid distance (IQ's bound, good near the surface). rot: 3x3 world->local."""
    x, y, z = _sub(p, c)
    if rot is not None:
        x, y, z = _rot(rot, x, y, z)
    rx, ry, rz = [np.float32(v) for v in radii]
    k0 = length(x / rx, y / ry, z / rz)
    k1 = length(x / (rx * rx), y / (ry * ry), z / (rz * rz))
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def _rot(m, x, y, z):
    m = np.asarray(m, dtype=np.float32)
    return (m[0, 0] * x + m[0, 1] * y + m[0, 2] * z,
            m[1, 0] * x + m[1, 1] * y + m[1, 2] * z,
            m[2, 0] * x + m[2, 1] * y + m[2, 2] * z)


def rot_matrix(axis_angles):
    """World->local rotation from a sequence of (axis, degrees) applied in order (to the SHAPE)."""
    m = Matrix.Identity(3)
    for ax, deg in axis_angles:
        m = Matrix.Rotation(math.radians(deg), 3, ax) @ m
    return np.array(m.transposed(), dtype=np.float32)   # inverse of a rotation = transpose


def sd_capsule(p, a, b, r1, r2=None):
    """Capsule / round cone from a to b with end radii r1 -> r2 (straight-sided cone between spheres,
    exact for r1 == r2, good for modest tapers)."""
    if r2 is None:
        r2 = r1
    ax, ay, az = [np.float32(v) for v in a]
    bx, by, bz = [np.float32(v) for v in b]
    px, py, pz = p[0] - ax, p[1] - ay, p[2] - az
    dx, dy, dz = bx - ax, by - ay, bz - az
    dd = dx * dx + dy * dy + dz * dz
    h = np.clip((px * dx + py * dy + pz * dz) / np.float32(dd), 0.0, 1.0)
    qx, qy, qz = px - dx * h, py - dy * h, pz - dz * h
    return length(qx, qy, qz) - (np.float32(r1) + np.float32(r2 - r1) * h)


def chain_box(pts, radii, pad=0.0):
    """Bounding box of a capsule chain (for Grid.add)."""
    P = np.array(pts, dtype=np.float64)
    r = max(radii) + pad
    return (P.min(0) - r).tolist(), (P.max(0) + r).tolist()


def sd_chain(p, pts, radii, k=0.0):
    """A tapered tube through pts (capsules between consecutive points, radii per point), smoothly joined."""
    d = None
    for i in range(len(pts) - 1):
        c = sd_capsule(p, pts[i], pts[i + 1], radii[i], radii[i + 1])
        d = c if d is None else smin(d, c, k)
    return d


def bezier_pts(p0, p1, p2, p3, n):
    """n+1 points on a cubic Bezier in 3D."""
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append(tuple(u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * e
                         for a, b, c, e in zip(p0, p1, p2, p3)))
    return out


def sd_round_cone(p, a, b, r1, r2):
    """Exact round cone (IQ) between spheres (a, r1) and (b, r2)."""
    a = np.array(a, dtype=np.float64)
    b = np.array(b, dtype=np.float64)
    ba = b - a
    l2 = float(ba @ ba)
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    px, py, pz = p[0] - np.float32(a[0]), p[1] - np.float32(a[1]), p[2] - np.float32(a[2])
    y = px * np.float32(ba[0]) + py * np.float32(ba[1]) + pz * np.float32(ba[2])
    z = y - np.float32(l2)
    wx, wy, wz = px * np.float32(l2) - np.float32(ba[0]) * y, py * np.float32(l2) - np.float32(ba[1]) * y, pz * np.float32(l2) - np.float32(ba[2]) * y
    x2 = wx * wx + wy * wy + wz * wz
    y2 = y * y * np.float32(l2)
    z2 = z * z * np.float32(l2)
    k = np.float32(np.sign(rr) * rr * rr * l2)
    s1 = np.sign(z) * np.float32(a2) * z2 > k
    s2 = np.sign(y) * np.float32(a2) * y2 < k
    d_top = (np.sqrt(x2 + z2) * np.float32(il2)) - np.float32(r2)
    d_bot = (np.sqrt(x2 + y2) * np.float32(il2)) - np.float32(r1)
    d_mid = (np.sqrt(x2 * np.float32(a2) * np.float32(il2)) + y * np.float32(rr)) * np.float32(il2) - np.float32(r1)
    return np.where(s1, d_top, np.where(s2, d_bot, d_mid)).astype(np.float32)


def sd_box(p, c, half, r=0.0, rot=None):
    x, y, z = _sub(p, c)
    if rot is not None:
        x, y, z = _rot(rot, x, y, z)
    hx, hy, hz = [np.float32(v - r) for v in half]
    qx, qy, qz = np.abs(x) - hx, np.abs(y) - hy, np.abs(z) - hz
    out = length(np.maximum(qx, 0), np.maximum(qy, 0), np.maximum(qz, 0))
    inn = np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0)
    return out + inn - np.float32(r)


def sd_cylinder(p, c, r, h, round_r=0.0, axis='Z'):
    """Capped cylinder centred at c, radius r, half-height h, edges rounded by round_r."""
    x, y, z = _sub(p, c)
    if axis == 'X':
        x, z = z, x
    elif axis == 'Y':
        y, z = z, y
    dr = length(x, y) - np.float32(r - round_r)
    dz = np.abs(z) - np.float32(h - round_r)
    return (np.minimum(np.maximum(dr, dz), 0) + length(np.maximum(dr, 0), np.maximum(dz, 0))
            - np.float32(round_r))


def sd_torus(p, c, R, r):
    x, y, z = _sub(p, c)
    q = length(x, y) - np.float32(R)
    return length(q, z) - np.float32(r)


def sd_plane(p, point, normal):
    n = np.array(normal, dtype=np.float64)
    n = n / np.linalg.norm(n)
    x, y, z = _sub(p, point)
    return x * np.float32(n[0]) + y * np.float32(n[1]) + z * np.float32(n[2])


# --- combinators ------------------------------------------------------------------------------

def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    k = np.float32(k)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1 - h) + a * h - k * h * (1 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def union(*ds, k=0.0):
    out = ds[0]
    for d in ds[1:]:
        out = smin(out, d, k)
    return out


def subtract(a, b, k=0.0):
    """a minus b (optionally with a fillet k)."""
    if k <= 0:
        return np.maximum(a, -b)
    return smax(a, -b, k)


def intersect(a, b, k=0.0):
    if k <= 0:
        return np.maximum(a, b)
    return smax(a, b, k)


# --- 2D fields (profiles, silhouettes) ----------------------------------------------------------

def poly_sdf2d(poly, U, V):
    """Exact signed distance to a closed polygon [(u, v), ...] (negative inside)."""
    P = np.asarray(poly, dtype=np.float64)
    U = U.astype(np.float64)
    V = V.astype(np.float64)
    d = np.full(U.shape, np.inf)
    s = np.ones(U.shape)
    n = len(P)
    j = n - 1
    for i in range(n):
        ex, ey = P[j, 0] - P[i, 0], P[j, 1] - P[i, 1]
        wx, wy = U - P[i, 0], V - P[i, 1]
        ee = ex * ex + ey * ey
        t = np.clip((wx * ex + wy * ey) / (ee if ee > 0 else 1.0), 0.0, 1.0)
        bx, by = wx - ex * t, wy - ey * t
        d = np.minimum(d, bx * bx + by * by)
        c1 = V >= P[i, 1]
        c2 = V < P[j, 1]
        c3 = ex * wy > ey * wx
        flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
        s = np.where(flip, -s, s)
        j = i
    return (s * np.sqrt(d)).astype(np.float32)


class Field2D:
    """A 2D SDF baked onto a fine raster, sampled bilinearly (fast to query for millions of points)."""

    def __init__(self, poly, lo, hi, res=0.001, pad=0.05):
        self.lo = np.array(lo, dtype=np.float64) - pad
        self.hi = np.array(hi, dtype=np.float64) + pad
        self.res = res
        nu = int(math.ceil((self.hi[0] - self.lo[0]) / res)) + 1
        nv = int(math.ceil((self.hi[1] - self.lo[1]) / res)) + 1
        u = self.lo[0] + np.arange(nu) * res
        v = self.lo[1] + np.arange(nv) * res
        UU, VV = np.meshgrid(u, v, indexing='ij')
        self.img = poly_sdf2d(poly, UU, VV)

    def sample(self, u, v):
        from scipy.ndimage import map_coordinates
        iu = (u - np.float32(self.lo[0])) / np.float32(self.res)
        iv = (v - np.float32(self.lo[1])) / np.float32(self.res)
        shp = u.shape
        out = map_coordinates(self.img, [iu.ravel(), iv.ravel()], order=1, mode='nearest')
        # outside the raster: distance grows with the overshoot
        du = np.maximum(0, np.maximum(np.float32(self.lo[0]) - u.ravel(), u.ravel() - np.float32(self.hi[0])))
        dv = np.maximum(0, np.maximum(np.float32(self.lo[1]) - v.ravel(), v.ravel() - np.float32(self.hi[1])))
        return (out + np.sqrt(du * du + dv * dv)).reshape(shp).astype(np.float32)


def profile_polygon(pts):
    """A lathe profile (r, z) that starts and ends on the axis -> closed polygon for Field2D; mirrored
    across the axis so the field is symmetric (no seam at r = 0)."""
    right = [(r, z) for r, z in pts]
    left = [(-r, z) for r, z in reversed(pts)]
    return right + left


def sd_revolve(p, field, c=(0, 0, 0)):
    x, y, z = _sub(p, c)
    return field.sample(length(x, y), z)


def sd_inflate(p, field, half, depth, axis='Y', c=(0, 0, 0)):
    """A 2D silhouette 'inflated' into a pillow: full half-thickness `half` once a point is `depth` inside
    the outline, and a quarter-ELLIPSE (semi-axes depth x half) rounding it off toward the outline. Reads
    as a carved volume instead of an extruded slab. The field is the ellipse's normalised radius, so its
    gradient stays bounded and the mesher places vertices cleanly (a sqrt-thinning field terraces)."""
    x, y, z = _sub(p, c)
    if axis == 'Y':
        d2, w = field.sample(x, z), np.abs(y)
    elif axis == 'X':
        d2, w = field.sample(y, z), np.abs(x)
    else:
        d2, w = field.sample(x, y), np.abs(z)
    depth = np.float32(depth)
    u = np.maximum(depth + d2, 0.0) / depth          # 0 deep inside, 1 on the outline, >1 outside
    v = w / half
    scale = np.minimum(half, depth)
    return (np.sqrt(u * u + v * v) - 1.0) * scale


def sd_extrude(p, field, half, round_r=0.0, axis='Y', c=(0, 0, 0)):
    """Extrude a 2D field (defined over the two remaining axes) by half-thickness `half` (scalar or
    array broadcastable to the grid) along `axis`, with rounded edges."""
    x, y, z = _sub(p, c)
    if axis == 'Y':
        d2, w = field.sample(x, z), np.abs(y)
    elif axis == 'X':
        d2, w = field.sample(y, z), np.abs(x)
    else:
        d2, w = field.sample(x, y), np.abs(z)
    dw = w - (half - np.float32(round_r))
    d2 = d2 + np.float32(round_r)
    return (np.minimum(np.maximum(d2, dw), 0) + length(np.maximum(d2, 0), np.maximum(dw, 0))
            - np.float32(round_r))


# --- noise ------------------------------------------------------------------------------------

_noise_cache = {}


def noise3(p, scale=10.0, seed=0, octaves=1, lacunarity=2.0, gain=0.5):
    """Smooth value noise in roughly [-1, 1] (cubic-interpolated random lattice, periodic)."""
    from scipy.ndimage import map_coordinates
    key = seed
    lat = _noise_cache.get(key)
    if lat is None:
        rs = np.random.RandomState(seed)
        lat = rs.uniform(-1, 1, (64, 64, 64)).astype(np.float32)
        from scipy.ndimage import spline_filter
        lat = spline_filter(lat, order=3, mode='grid-wrap')
        _noise_cache[key] = lat
    out = np.zeros(p[0].shape, dtype=np.float32)
    amp, freq, norm = 1.0, scale, 0.0
    for o in range(octaves):
        coords = [(p[i].ravel() * np.float32(freq) + np.float32(17.3 * o + 5.1 * i)) for i in range(3)]
        out += np.float32(amp) * map_coordinates(lat, coords, order=3, mode='grid-wrap', prefilter=False).reshape(out.shape)
        norm += amp
        amp *= gain
        freq *= lacunarity
    return out / np.float32(norm * 0.55)


# =============================================================================================
# UV atlas
# =============================================================================================

def smart_uv(obj, angle=62.0, margin=0.004):
    with ctx_view3d():
        select_only([obj])
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
        bpy.ops.object.mode_set(mode='OBJECT')
    return obj


def uv_coverage(objs):
    """Fraction of the 0..1 UV square the objects' islands cover (a packing check: aim for ~0.5+)."""
    tot = 0.0
    for o in objs:
        me = o.data
        me.calc_loop_triangles()
        uv = np.empty(len(me.loops) * 2, dtype=np.float32)
        me.uv_layers.active.data.foreach_get('uv', uv)
        uv = uv.reshape(-1, 2)
        tri = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
        me.loop_triangles.foreach_get('loops', tri)
        tri = tri.reshape(-1, 3)
        a, b, c = uv[tri[:, 0]], uv[tri[:, 1]], uv[tri[:, 2]]
        tot += float(np.abs(np.cross(b - a, c - a)).sum() / 2)
    return tot


def uv_islands(me):
    """Island id for every face of a mesh's active UV map (faces joined by a shared vertex at the same UV)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    nl, nf = len(me.loops), len(me.polygons)
    uv = np.empty(nl * 2, dtype=np.float32)
    me.uv_layers.active.data.foreach_get('uv', uv)
    uv = uv.reshape(-1, 2)
    vi = np.empty(nl, dtype=np.int64)
    me.loops.foreach_get('vertex_index', vi)
    tot = np.empty(nf, dtype=np.int64)
    me.polygons.foreach_get('loop_total', tot)
    face_of = np.repeat(np.arange(nf), tot)
    q = np.round(uv * 1e5).astype(np.int64)
    _, key = np.unique(np.stack([vi, q[:, 0], q[:, 1]], axis=1), axis=0, return_inverse=True)
    key = key.ravel()
    A = coo_matrix((np.ones(nl), (face_of, key)), shape=(nf, int(key.max()) + 1)).tocsr()
    _, lab = connected_components(A @ A.T, directed=False)
    return lab, face_of, uv


def boost_islands(objs, attr, factor):
    """Scale up (about their own centres) the UV islands holding any face whose face attribute `attr` is set,
    so that detail gets `factor` times the texels once the atlas is packed (small window panes, say)."""
    for o in objs:
        me = o.data
        a = me.attributes.get(attr)
        if a is None or a.domain != 'FACE':
            continue
        fv = np.empty(len(me.polygons), dtype=np.float32)
        a.data.foreach_get('value', fv)
        lab, face_of, uv = uv_islands(me)
        n = int(lab.max()) + 1
        boost = np.zeros(n, dtype=bool)
        boost[np.unique(lab[fv > 0.5])] = True
        li = lab[face_of]
        mins = np.full((n, 2), np.inf, dtype=np.float32)
        maxs = np.full((n, 2), -np.inf, dtype=np.float32)
        np.minimum.at(mins, li, uv)
        np.maximum.at(maxs, li, uv)
        c = ((mins + maxs) / 2)[li]
        f = np.where(boost[li], np.float32(factor), np.float32(1.0))[:, None]
        me.uv_layers.active.data.foreach_set('uv', (c + (uv - c) * f).astype(np.float32).ravel())


def uv_atlas(objs, margin=0.0015, boost=None):
    """Pack the UV islands of every object into one shared 0..1 atlas at equal texel density. The margin is a
    fixed FRACTION of the atlas (about 3 px at 2048): a SCALED margin grows with the islands' own scale and,
    with thousands of small islands, left the islands a sliver of the atlas (0.2% on Estate). The bake fills
    everything outside the islands afterwards (fill_islands), so a thin margin is enough.
    boost=(face_attribute, factor): after levelling the density, enlarge the islands of those faces first."""
    for o in objs:
        if not o.data.uv_layers:
            smart_uv(o)
        o.data.uv_layers.active_index = 0
    with ctx_view3d():
        select_only(objs, objs[0])
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.average_islands_scale()
        if boost:
            bpy.ops.object.mode_set(mode='OBJECT')
            boost_islands(objs, *boost)
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.pack_islands(rotate=True, margin_method='FRACTION', margin=margin, shape_method='CONCAVE')
        bpy.ops.object.mode_set(mode='OBJECT')
    log('uv atlas coverage %.2f' % uv_coverage(objs))
    return objs


# =============================================================================================
# Materials: small node-building helpers
# =============================================================================================

class Nodes:
    """Tiny helper around a material node tree: n('ShaderNodeX', **inputs) and link(a, b)."""

    def __init__(self, mat):
        self.mat = mat
        self.nt = mat.node_tree
        self.x = 0

    def n(self, kind, label=None, **props):
        node = self.nt.nodes.new(kind)
        node.location = (self.x, 0)
        self.x -= 220
        if label:
            node.label = label
        for k, v in props.items():
            if k.startswith('i_'):
                name = k[2:].replace('_', ' ')
                sock = node.inputs.get(name)
                if sock is None:
                    raise KeyError('%s has no input %r (%s)' % (kind, name, [s.name for s in node.inputs]))
                sock.default_value = v
            else:
                setattr(node, k, v)
        return node

    def link(self, out, inp):
        self.nt.links.new(out, inp)


def new_material(name):
    m = bpy.data.materials.get(name)
    if m:
        bpy.data.materials.remove(m)
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for nd in list(nt.nodes):
        nt.nodes.remove(nd)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (400, 0)
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    bsdf.location = (100, 0)
    nt.links.new(bsdf.outputs['BSDF'], out.inputs['Surface'])
    return m, Nodes(m), bsdf, out


def assign(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


# =============================================================================================
# Baking
# =============================================================================================

def setup_cycles(samples=64, device='GPU'):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == 'OPTIX'
        sc.cycles.device = device
    except Exception as e:
        log('GPU setup failed, CPU bake', e)
        sc.cycles.device = 'CPU'
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False


def new_image(name, size, non_color=False, float_buffer=False, color=(0, 0, 0, 1)):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=float_buffer)
    img.generated_color = color
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    return img


def _bake_target(mats, img):
    """Point an (added) image node in every material at img and make it the active node."""
    for m in mats:
        nt = m.node_tree
        node = nt.nodes.get('__bake__')
        if node is None:
            node = nt.nodes.new('ShaderNodeTexImage')
            node.name = '__bake__'
            node.location = (-1200, 400)
        node.image = img
        for nd in nt.nodes:
            nd.select = False
        node.select = True
        nt.nodes.active = node


def _clear_bake_nodes(mats):
    for m in mats:
        nd = m.node_tree.nodes.get('__bake__')
        if nd:
            m.node_tree.nodes.remove(nd)


def bake(objs, img, kind, samples=64, margin=12, pass_filter=None, selected_to_active=None,
         extrusion=0.02, max_ray=0.06):
    """Bake one pass of every object into img (a shared atlas). kind: NORMAL, AO, DIFFUSE, ROUGHNESS,
    EMIT, GLOSSY, COMBINED. For DIFFUSE the default pass filter is colour only."""
    sc = bpy.context.scene
    sc.cycles.samples = samples
    bk = sc.render.bake
    bk.margin = margin
    bk.margin_type = 'EXTEND'
    bk.use_clear = False
    bk.target = 'IMAGE_TEXTURES'
    mats = []
    for o in objs:
        for s in o.material_slots:
            if s.material and s.material not in mats:
                mats.append(s.material)
    _bake_target(mats, img)
    kw = {}
    if kind == 'DIFFUSE':
        kw['pass_filter'] = pass_filter or {'COLOR'}
    elif pass_filter:
        kw['pass_filter'] = pass_filter
    if kind == 'NORMAL':
        kw['normal_space'] = 'TANGENT'
    targets = list(objs)
    if selected_to_active:
        hi = selected_to_active
        select_only(hi + targets, targets[0])
        kw.update(use_selected_to_active=True, cage_extrusion=extrusion, max_ray_distance=max_ray)
    else:
        select_only(targets, targets[0])
        kw['use_selected_to_active'] = False
    t0 = time.time()
    with ctx_view3d():
        bpy.ops.object.bake(type=kind, **kw)
    log('bake %s -> %s %.1fs' % (kind, img.name, time.time() - t0))
    return img


def image_to_np(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def np_to_image(name, arr, non_color=True):
    h, w = arr.shape[:2]
    img = new_image(name, w, non_color=non_color)
    if arr.shape[2] == 3:
        arr = np.concatenate([arr, np.ones((h, w, 1), dtype=np.float32)], axis=2)
    img.pixels.foreach_set(arr.astype(np.float32).ravel())
    img.update()
    return img


def save_image(img, path, fmt='PNG', quality=92):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.filepath_raw = path
    img.file_format = fmt
    sc = bpy.context.scene
    if fmt in ('JPEG', 'WEBP'):
        sc.render.image_settings.quality = quality
    img.save()
    return path


def dilate_uv_islands(arr, mask, iters=16):
    """Push island edge colours outward into empty texels (a second guard on top of the bake margin)."""
    from scipy.ndimage import grey_dilation
    out = arr.copy()
    m = mask.copy()
    for _ in range(iters):
        if m.all():
            break
        grown = np.zeros_like(out)
        cnt = np.zeros(m.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sm = np.roll(m, (dy, dx), axis=(0, 1))
            sa = np.roll(out, (dy, dx), axis=(0, 1))
            grown += sa * sm[..., None]
            cnt += sm
        new = (~m) & (cnt > 0)
        out[new] = grown[new] / cnt[new][:, None]
        m = m | new
    return out


# =============================================================================================
# Export material (baked maps -> Principled) and GLB
# =============================================================================================

def gltf_output_group():
    """The 'glTF Material Output' node group the exporter reads Occlusion from."""
    name = 'glTF Material Output'
    g = bpy.data.node_groups.get(name)
    if g:
        return g
    g = bpy.data.node_groups.new(name, 'ShaderNodeTree')
    try:
        g.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    except Exception:
        g.inputs.new('NodeSocketFloat', 'Occlusion')
    return g


def baked_material(name, color_img, orm_img, normal_img, coat=0.0, coat_rough=0.1, metallic=None,
                   normal_strength=1.0, specular=0.5, sheen=0.0, emit_img=None, emit_strength=1.0):
    """A Principled material fed only by baked images -- exactly what the glTF exporter can carry.
    ORM packs occlusion (R), roughness (G), metalness (B). emit_img (optional) drives the emission."""
    m, N, bsdf, out = new_material(name)
    if emit_img is not None:
        te = N.n('ShaderNodeTexImage', image=emit_img)
        te.location = (-600, 600)
        N.link(te.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = emit_strength
    tc = N.n('ShaderNodeTexImage', image=color_img)
    tc.location = (-600, 300)
    N.link(tc.outputs['Color'], bsdf.inputs['Base Color'])
    to = N.n('ShaderNodeTexImage', image=orm_img)
    to.location = (-600, 0)
    sep = N.n('ShaderNodeSeparateColor')
    sep.location = (-300, 0)
    N.link(to.outputs['Color'], sep.inputs['Color'])
    N.link(sep.outputs['Green'], bsdf.inputs['Roughness'])
    if metallic is None:
        N.link(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    else:
        bsdf.inputs['Metallic'].default_value = metallic
    grp = N.nt.nodes.new('ShaderNodeGroup')
    grp.node_tree = gltf_output_group()
    grp.location = (100, -400)
    N.link(sep.outputs['Red'], grp.inputs['Occlusion'])
    tn = N.n('ShaderNodeTexImage', image=normal_img)
    tn.location = (-600, -300)
    nm = N.n('ShaderNodeNormalMap')
    nm.location = (-300, -300)
    nm.inputs['Strength'].default_value = normal_strength
    N.link(tn.outputs['Color'], nm.inputs['Color'])
    N.link(nm.outputs['Normal'], bsdf.inputs['Normal'])
    bsdf.inputs['Coat Weight'].default_value = coat
    bsdf.inputs['Coat Roughness'].default_value = coat_rough
    try:
        bsdf.inputs['Specular IOR Level'].default_value = specular
    except KeyError:
        pass
    if sheen:
        bsdf.inputs['Sheen Weight'].default_value = sheen
    return m


def triangulate(obj):
    m = obj.modifiers.new('tri', 'TRIANGULATE')
    m.quad_method = 'BEAUTY'
    m.ngon_method = 'BEAUTY'
    m.keep_custom_normals = True
    apply_modifiers(obj)
    return obj


def export_glb(objs, path, draco=True, image_format='WEBP', quality=90, tangents=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    for o in objs:
        if o.type == 'MESH' and any(len(p.vertices) > 4 for p in o.data.polygons):
            triangulate(o)
    select_only(objs, objs[0])
    kw = dict(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
              export_image_format=image_format, export_image_quality=quality, export_materials='EXPORT',
              export_normals=True, export_texcoords=True, export_tangents=tangents, export_extras=False,
              export_cameras=False, export_lights=False, export_animations=False, export_skins=False,
              export_morph=False)
    if draco:
        kw.update(export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6,
                  export_draco_position_quantization=14, export_draco_normal_quantization=10,
                  export_draco_texcoord_quantization=12, export_draco_generic_quantization=12)
    with ctx_view3d():
        bpy.ops.export_scene.gltf(**kw)
    log('exported', path, '%.2f MB' % (os.path.getsize(path) / 1048576))
    return path


# =============================================================================================
# Preview renders (for judging shapes and bakes without leaving Blender)
# =============================================================================================

def preview_scene(name='__preview__'):
    """A neutral studio: grey sweep, big soft key, fill and rim. Returns the collection."""
    coll = collection(name, clear=True)
    sweep = mesh_object('__sweep', [(-8, -8, 0), (8, -8, 0), (8, 8, 0), (-8, 8, 0)], [(0, 1, 2, 3)], coll)
    m, N, bsdf, _ = new_material('__sweep_mat')
    bsdf.inputs['Base Color'].default_value = (0.32, 0.31, 0.30, 1)
    bsdf.inputs['Roughness'].default_value = 0.8
    assign(sweep, m)

    def area(nm, loc, rot, size, energy, color=(1, 1, 1)):
        ld = bpy.data.lights.new(nm, 'AREA')
        ld.shape = 'DISK'
        ld.size = size
        ld.energy = energy
        ld.color = color
        ob = bpy.data.objects.new(nm, ld)
        ob.location = loc
        ob.rotation_euler = rot
        link(ob, coll)
        return ob
    area('__key', (3.0, -3.2, 4.2), (math.radians(48), 0, math.radians(42)), 3.0, 900, (1.0, 0.95, 0.88))
    area('__fill', (-4.0, -2.5, 2.5), (math.radians(62), 0, math.radians(-58)), 5.0, 260, (0.85, 0.9, 1.0))
    area('__rim', (0.5, 4.0, 3.0), (math.radians(-55), 0, math.radians(180)), 2.5, 700, (1.0, 1.0, 1.0))
    w = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes.get('Background')
    # Blender's bundled CC0 studio HDRI, so metals and glazes have something to reflect
    hdr = os.path.join(os.path.dirname(bpy.app.binary_path), '%d.%d' % bpy.app.version[:2], 'datafiles', 'studiolights', 'world', 'interior.exr')
    env = nt.nodes.get('__env__')
    if os.path.exists(hdr):
        if env is None:
            env = nt.nodes.new('ShaderNodeTexEnvironment')
            env.name = '__env__'
        env.image = bpy.data.images.load(hdr, check_existing=True)
        if bg:
            nt.links.new(env.outputs['Color'], bg.inputs['Color'])
            bg.inputs['Strength'].default_value = 0.55
    elif bg:
        bg.inputs['Color'].default_value = (0.05, 0.05, 0.055, 1)
        bg.inputs['Strength'].default_value = 1.0
    return coll


def render_preview(path, cam_loc, cam_target, lens=85, res=(1400, 900), samples=48, engine='CYCLES',
                   hide=(), only=None):
    """Render the scene camera view to path. only=[objects]: hide every other mesh except the preview sweep."""
    if only is not None:
        keep = list(only) + [o for o in bpy.data.objects if o.name.startswith('__')]
        restore = hide_others(keep)
        try:
            return render_preview(path, cam_loc, cam_target, lens, res, samples, engine, hide, None)
        finally:
            restore()
    sc = bpy.context.scene
    cam = bpy.data.objects.get('__cam')
    if cam is None:
        cd = bpy.data.cameras.new('__cam')
        cam = bpy.data.objects.new('__cam', cd)
        link(cam, collection('__preview__'))
    cam.data.lens = lens
    cam.location = cam_loc
    d = Vector(cam_target) - Vector(cam_loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.engine = engine
    if engine == 'CYCLES':
        setup_cycles(samples)
        sc.cycles.use_denoising = True
        try:
            sc.cycles.denoiser = 'OPTIX'
        except Exception:
            pass
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'AgX - Medium High Contrast'
    sc.render.filepath = path
    sc.render.image_settings.file_format = 'PNG'
    hidden = []
    for o in hide:
        if not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    for o in hidden:
        o.hide_render = False
    log('render %s %.1fs' % (path, time.time() - t0))
    return path


# =============================================================================================
# Set pipeline: bake a set's procedural materials into one atlas, build export materials, export.
# =============================================================================================

def layout_row(objs, spacing=1.0):
    """Spread objects along X (so AO bakes do not see their neighbours); returns a restore function."""
    saved = [o.location.copy() for o in objs]
    for i, o in enumerate(objs):
        o.location = (i * spacing, 0.0, 0.0)
    bpy.context.view_layer.update()

    def restore():
        for o, loc in zip(objs, saved):
            o.location = loc
    return restore


def hide_others(keep):
    """Hide every renderable object not in `keep` from render (returns a restore function)."""
    keep = set(keep)
    changed = []
    for o in bpy.context.scene.objects:
        if o not in keep and o.type in ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'VOLUME') and not o.hide_render:
            o.hide_render = True
            changed.append(o)

    def restore():
        for o in changed:
            o.hide_render = False
    return restore


def fill_islands(arr, mask):
    """Fill every texel outside the UV islands with its nearest island texel: a full-bleed margin, so no mip
    level ever averages across into another island or into the empty background."""
    from scipy.ndimage import distance_transform_edt
    if mask.all() or not mask.any():
        return arr
    _, (iy, ix) = distance_transform_edt(~mask, return_indices=True)
    return arr[iy, ix]


def coverage_mask(objs, size):
    """Which atlas texels the objects' UV islands cover (an EMIT bake of plain white, no margin)."""
    m, N, bsdf, out = new_material('__coverage__')
    em = N.n('ShaderNodeEmission', i_Strength=1.0)
    em.inputs['Color'].default_value = (1, 1, 1, 1)
    N.link(em.outputs['Emission'], out.inputs['Surface'])
    saved = [list(o.data.materials) for o in objs]
    for o in objs:
        assign(o, m)
    img = new_image('__coverage__', size, non_color=True, color=(0, 0, 0, 1))
    try:
        bake(objs, img, 'EMIT', samples=1, margin=0)
    finally:
        for o, mats in zip(objs, saved):
            o.data.materials.clear()
            for mm in mats:
                o.data.materials.append(mm)
    mask = image_to_np(img)[..., 0] > 0.5
    bpy.data.images.remove(img)
    return mask


def _fill_image(img, mask):
    arr = fill_islands(image_to_np(img), mask)
    img.pixels.foreach_set(np.ascontiguousarray(arr, dtype=np.float32).ravel())
    img.update()
    return img


def make_low(hi, tris, name):
    """A decimated copy of a sculpted piece, for baking high -> low. The high keeps its materials and
    attributes (the bake reads them there); the low is unwrapped fresh by the atlas."""
    lo = hi.copy()
    lo.data = hi.data.copy()
    lo.data.name = name
    link(lo, hi.users_collection[0])
    lo.name = name
    decimate(lo, target_tris=tris)
    while lo.data.uv_layers:
        lo.data.uv_layers.remove(lo.data.uv_layers[0])
    lo.data.shade_smooth()
    return lo


def bake_set(set_id, objs, materials, size=2048, ao_distance=0.12, samples_ao=192, highs=None,
             extrusion=0.012, max_ray=0.04, normal_from_low=False):
    """Bake a set. materials = {'white': mat, 'black': mat}; every object is baked with each in turn.
    highs (optional, parallel to objs): sculpted sources carrying the materials; each pass then bakes
    high -> low per piece (selected to active), and objs are the decimated lows that get exported.
    normal_from_low: bake the normal map from objs themselves (hard-surface pieces whose highs are only a
    denser copy of the same surface -- the map must carry the material's relief on the piece's own shading).
    Every map is baked without a margin and then filled out from the islands (fill_islands).
    Returns {'normal': img, 'ao': img, 'white': {'color','rough','metal'}, 'black': {...}} (images saved
    under WORK/<set_id>/tex/)."""
    out_dir = '%s/%s/tex' % (WORK, set_id)
    os.makedirs(out_dir, exist_ok=True)
    setup_cycles(64)
    srcs = highs if highs else objs
    restore_row = layout_row(objs, 1.2)
    restore_hi = layout_row(highs, 1.2) if highs else (lambda: None)
    restore_vis = hide_others(list(objs) + list(highs or []))
    w = bpy.context.scene.world or bpy.data.worlds.new('World')
    bpy.context.scene.world = w
    w.light_settings.distance = ao_distance
    mask = coverage_mask(objs, size)
    target = None
    if highs:
        target, _, _, _ = new_material('__bake_target__')
        for o in objs:
            assign(o, target)

    def run(img, kind, samples):
        if highs:
            for lo, hi in zip(objs, highs):
                bake([lo], img, kind, samples=samples, margin=0, selected_to_active=[hi],
                     extrusion=extrusion, max_ray=max_ray)
        else:
            bake(objs, img, kind, samples=samples, margin=0)
        _fill_image(img, mask)

    try:
        res = {}
        for o in srcs:
            assign(o, materials['white'])
        img = new_image(set_id + '_normal', size, non_color=True, color=(0.5, 0.5, 1.0, 1.0))
        if highs and normal_from_low:
            for o in objs:
                assign(o, materials['white'])
            bake(objs, img, 'NORMAL', samples=16, margin=0)
            _fill_image(img, mask)
            for o in objs:
                assign(o, target)
        else:
            run(img, 'NORMAL', 16)
        res['normal'] = img
        img = new_image(set_id + '_ao', size, non_color=True, color=(1, 1, 1, 1))
        if highs:
            # AO from the exported meshes themselves, the highs hidden: a high lying on (or right at) its low
            # sees the low in every AO ray and bakes black -- and the game shades the low anyway
            for h in highs:
                h.hide_render = True
            try:
                bake(objs, img, 'AO', samples=samples_ao, margin=0)
            finally:
                for h in highs:
                    h.hide_render = False
            _fill_image(img, mask)
        else:
            run(img, 'AO', samples_ao)
        res['ao'] = img
        for color in ('white', 'black'):
            for o in srcs:
                assign(o, materials[color])
            col = new_image('%s_%s_color' % (set_id, color), size, color=(0.5, 0.5, 0.5, 1))
            # Base colour goes through EMIT, not the DIFFUSE colour pass: Cycles scales diffuse colour by
            # (1 - metallic), so gilding and bronze would bake to black.
            # 32 samples: materials that shade their colour with an AO node (cavities, moss, glaze pooling)
            # would otherwise bake that AO as speckle
            _bake_emit_socket(materials[color], 'Base Color', lambda: run(col, 'EMIT', 32))
            rough = new_image('%s_%s_rough' % (set_id, color), size, non_color=True, color=(0.5, 0.5, 0.5, 1))
            run(rough, 'ROUGHNESS', 32)
            res[color] = {'color': col, 'rough': rough}
            # real emission (lit windows): bake EMIT as-is when the material declares it with an __emission__ node
            if materials[color].node_tree.nodes.get('__emission__') is not None:
                emit = new_image('%s_%s_emit' % (set_id, color), size, color=(0, 0, 0, 1))
                run(emit, 'EMIT', 16)
                res[color]['emit'] = emit
            # metalness: optional EMIT bake when the material exposes a 'metal' value node
            mnode = materials[color].node_tree.nodes.get('__metal__')
            if mnode is not None:
                metal = new_image('%s_%s_metal' % (set_id, color), size, non_color=True, color=(0, 0, 0, 1))
                _bake_emit_from(materials[color], mnode, lambda: run(metal, 'EMIT', 16))
                res[color]['metal'] = metal
        for o in srcs:
            assign(o, materials['white'])
    finally:
        restore_vis()
        restore_hi()
        restore_row()
        _clear_bake_nodes(list(materials.values()) + ([target] if target else []))
    # pack ORM per colour and save everything
    ao = image_to_np(res['ao'])[..., 0]
    for color in ('white', 'black'):
        rough = image_to_np(res[color]['rough'])[..., 0]
        metal = image_to_np(res[color]['metal'])[..., 0] if 'metal' in res[color] else np.zeros_like(ao)
        orm = np.stack([ao, rough, metal, np.ones_like(ao)], axis=-1)
        res[color]['orm'] = np_to_image('%s_%s_orm' % (set_id, color), orm, non_color=True)
        save_image(res[color]['orm'], '%s/%s_%s_orm.png' % (out_dir, set_id, color))
        save_image(res[color]['color'], '%s/%s_%s_color.png' % (out_dir, set_id, color))
        if 'emit' in res[color]:
            save_image(res[color]['emit'], '%s/%s_%s_emit.png' % (out_dir, set_id, color))
    save_image(res['normal'], '%s/%s_normal.png' % (out_dir, set_id))
    save_image(res['ao'], '%s/%s_ao.png' % (out_dir, set_id))
    return res


def _bake_emit_socket(mat, socket_name, run):
    """Temporarily route whatever feeds the Principled input `socket_name` into Emission (strength 1), bake
    EMIT, then restore the node tree."""
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    src = bsdf.inputs[socket_name]
    feed = src.links[0].from_socket if src.links else None
    em_col, em_str = bsdf.inputs['Emission Color'], bsdf.inputs['Emission Strength']
    old_links = [(l.from_socket, l.to_socket) for l in nt.links if l.to_node == bsdf and l.to_socket in (em_col, em_str)]
    old_col = tuple(em_col.default_value)
    old_str = em_str.default_value
    for l in list(nt.links):
        if l.to_node == bsdf and l.to_socket in (em_col, em_str):
            nt.links.remove(l)
    lk = None
    if feed is not None:
        lk = nt.links.new(feed, em_col)
    else:
        v = src.default_value
        em_col.default_value = tuple(v) if hasattr(v, '__len__') else (v, v, v, 1.0)
    em_str.default_value = 1.0
    try:
        run()
    finally:
        if lk is not None:
            nt.links.remove(lk)
        em_col.default_value = old_col
        em_str.default_value = old_str
        for a, b in old_links:
            nt.links.new(a, b)


def _bake_emit_from(mat, value_node, run):
    """Temporarily route a value into Emission (strength 1) and bake EMIT."""
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED')
    old_links = [(l.from_socket, l.to_socket) for l in nt.links if l.to_node == bsdf and l.to_socket.name in ('Emission Color', 'Emission Strength')]
    old_col = tuple(bsdf.inputs['Emission Color'].default_value)
    old_str = bsdf.inputs['Emission Strength'].default_value
    for l in list(nt.links):
        if l.to_node == bsdf and l.to_socket.name in ('Emission Color', 'Emission Strength'):
            nt.links.remove(l)
    lk = nt.links.new(value_node.outputs[0], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = 1.0
    try:
        run()
    finally:
        nt.links.remove(lk)
        bsdf.inputs['Emission Color'].default_value = old_col
        bsdf.inputs['Emission Strength'].default_value = old_str
        for a, b in old_links:
            nt.links.new(a, b)


def export_set(set_id, objs, baked, params, swatch_name=None, out_path=None, draco=True):
    """Export a set: every piece carries the WHITE baked material; a one-triangle swatch object carries
    the BLACK one (the board clones the piece meshes and applies it). params = {'white': {...}, 'black':
    {...}} passed to baked_material (coat, coat_rough, normal_strength, ...)."""
    mw = baked_material(set_id + '_white', baked['white']['color'], baked['white']['orm'], baked['normal'],
                        emit_img=baked['white'].get('emit'), **params.get('white', {}))
    mb = baked_material(set_id + '_black', baked['black']['color'], baked['black']['orm'], baked['normal'],
                        emit_img=baked['black'].get('emit'), **params.get('black', {}))
    for o in objs:
        assign(o, mw)
        # every piece is authored at its base centre: never let a preview layout ride into the GLB
        o.location = (0.0, 0.0, 0.0)
        o.rotation_euler = (0.0, 0.0, 0.0)
        o.scale = (1.0, 1.0, 1.0)
    swatch_name = swatch_name or (set_id + '_swatch_black')
    sw = bpy.data.objects.get(swatch_name)
    if sw:
        remove(sw)
    sw = mesh_object(swatch_name, [(0, 0, -5), (0.001, 0, -5), (0, 0.001, -5)], [(0, 1, 2)], objs[0].users_collection[0],
                     uv=[(0, 0), (0.001, 0), (0, 0.001)])
    assign(sw, mb)
    out_path = out_path or '%s/%s.glb' % (SETS_OUT, set_id)
    export_glb(list(objs) + [sw], out_path, draco=draco)
    return out_path, mw, mb
