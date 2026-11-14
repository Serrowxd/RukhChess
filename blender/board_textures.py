"""Board woods -- baked textures for the board's 'wood' theme: hard maple (light squares), black walnut (dark
squares) and a darker walnut for the frame. Each is a flat procedural wood (grain running along the texture's
U axis) baked from Cycles to a JPEG the app bundles. The board samples a different window of the square
textures for every square, so no two squares share a grain.

Run from Blender through cbkit:  python blrun.py board_textures build
"""
import os
import bpy
import cbkit as K

OUT = K.ASSETS_OUT


def lin(hexstr):
    h = hexstr.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


def plank_wood(name, early, late, streak, scale, figure, pore, span):
    """Flat-sawn wood on a plane: growth-ring bands run along U, warped by a slow noise (the figure), with fine
    pores stretched along the grain and a gentle tone drift. `span` = board units the texture covers."""
    m, N, bsdf, out = K.new_material(name)
    tc = N.n('ShaderNodeTexCoord')
    sc = N.n('ShaderNodeVectorMath', operation='SCALE')
    N.link(tc.outputs['UV'], sc.inputs[0])
    sc.inputs['Scale'].default_value = span
    # the figure: a slow warp of the bands
    warp = N.n('ShaderNodeTexNoise', i_Scale=0.7, i_Detail=2.0, i_Roughness=0.5)
    N.link(sc.outputs['Vector'], warp.inputs['Vector'])
    wsub = N.n('ShaderNodeVectorMath', operation='SUBTRACT')
    N.link(warp.outputs['Color'], wsub.inputs[0])
    wsub.inputs[1].default_value = (0.5, 0.5, 0.5)
    wsc = N.n('ShaderNodeVectorMath', operation='MULTIPLY')
    N.link(wsub.outputs['Vector'], wsc.inputs[0])
    wsc.inputs[1].default_value = (0.05, figure, 0.0)
    co = N.n('ShaderNodeVectorMath', operation='ADD')
    N.link(sc.outputs['Vector'], co.inputs[0])
    N.link(wsc.outputs['Vector'], co.inputs[1])
    wave = N.n('ShaderNodeTexWave', wave_type='BANDS', bands_direction='Y', wave_profile='SAW',
               i_Scale=scale, i_Distortion=0.25, i_Detail=1.0, i_Detail_Scale=1.0, i_Detail_Roughness=0.5)
    N.link(co.outputs['Vector'], wave.inputs['Vector'])
    ramp = N.n('ShaderNodeValToRGB')
    el = ramp.color_ramp.elements
    el[0].position, el[0].color = 0.0, (*early, 1)
    el[1].position, el[1].color = 0.72, (*early, 1)
    e2 = el.new(1.0)
    e2.color = (*late, 1)
    N.link(wave.outputs['Fac'], ramp.inputs['Fac'])
    # pores / fine grain: noise squashed hard along the grain
    pv = N.n('ShaderNodeVectorMath', operation='MULTIPLY')
    N.link(co.outputs['Vector'], pv.inputs[0])
    pv.inputs[1].default_value = (6.0, 160.0, 1.0)
    pn = N.n('ShaderNodeTexNoise', i_Scale=1.0, i_Detail=6.0, i_Roughness=0.6)
    N.link(pv.outputs['Vector'], pn.inputs['Vector'])
    pm = N.n('ShaderNodeMapRange', i_From_Min=0.35, i_From_Max=0.70, i_To_Min=1.0, i_To_Max=1.0 - pore)
    N.link(pn.outputs['Fac'], pm.inputs['Value'])
    # occasional darker streaks (mineral lines) along the grain
    sv = N.n('ShaderNodeVectorMath', operation='MULTIPLY')
    N.link(co.outputs['Vector'], sv.inputs[0])
    sv.inputs[1].default_value = (0.8, 22.0, 1.0)
    sn = N.n('ShaderNodeTexNoise', i_Scale=1.0, i_Detail=3.0)
    N.link(sv.outputs['Vector'], sn.inputs['Vector'])
    sm = N.n('ShaderNodeMapRange', i_From_Min=0.62, i_From_Max=0.78, i_To_Min=0.0, i_To_Max=1.0)
    N.link(sn.outputs['Fac'], sm.inputs['Value'])
    streaked = N.n('ShaderNodeMixRGB', blend_type='MIX')
    N.link(sm.outputs['Result'], streaked.inputs['Fac'])
    N.link(ramp.outputs['Color'], streaked.inputs['Color1'])
    streaked.inputs['Color2'].default_value = (*streak, 1)
    # slow tone drift across the board
    dr = N.n('ShaderNodeTexNoise', i_Scale=0.35, i_Detail=2.0)
    N.link(sc.outputs['Vector'], dr.inputs['Vector'])
    drm = N.n('ShaderNodeMapRange', i_From_Min=0.3, i_From_Max=0.7, i_To_Min=0.92, i_To_Max=1.06)
    N.link(dr.outputs['Fac'], drm.inputs['Value'])
    t1 = N.n('ShaderNodeVectorMath', operation='SCALE')
    N.link(streaked.outputs['Color'], t1.inputs[0])
    N.link(pm.outputs['Result'], t1.inputs['Scale'])
    t2 = N.n('ShaderNodeVectorMath', operation='SCALE')
    N.link(t1.outputs['Vector'], t2.inputs[0])
    N.link(drm.outputs['Result'], t2.inputs['Scale'])
    N.link(t2.outputs['Vector'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.4
    return m


def bake_plane(name, mat, w, h, path):
    coll = K.collection('__boardtex__', clear=True)
    pl = K.mesh_object('__plane', [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], [(0, 1, 2, 3)], coll,
                       uv=[(0, 0), (1, 0), (1, 1), (0, 1)])
    K.assign(pl, mat)
    K.setup_cycles(8)
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, w, h, alpha=False)
    restore = K.hide_others([pl])
    try:
        K._bake_emit_socket(mat, 'Base Color', lambda: K.bake([pl], img, 'EMIT', samples=4, margin=4))
    finally:
        restore()
        K._clear_bake_nodes([mat])
    K.save_image(img, path, fmt='JPEG', quality=90)
    return path


def build():
    os.makedirs(OUT, exist_ok=True)
    maple = plank_wood('board_maple', lin('#EAD8B4'), lin('#D2B68A'), lin('#C4A474'), 30.0, 0.05, 0.07, 2.0)
    walnut = plank_wood('board_walnut', lin('#6E4629'), lin('#3F2616'), lin('#2A180D'), 24.0, 0.07, 0.14, 2.0)
    frame = plank_wood('board_frame', lin('#4F311E'), lin('#26160C'), lin('#180C06'), 18.0, 0.08, 0.16, 9.2)
    out = [
        bake_plane('board_maple', maple, 1024, 1024, OUT + '/board_maple.jpg'),
        bake_plane('board_walnut', walnut, 1024, 1024, OUT + '/board_walnut.jpg'),
        bake_plane('board_frame', frame, 2048, 2048, OUT + '/board_frame.jpg'),
    ]
    K.collection('__boardtex__', clear=True)
    return out
