# Rukh — the Blender piece sets

The modelled piece sets are code, not hand-sculpted `.blend` files. Each `set_*.py` builds its six pieces in
Blender, bakes its procedural materials into one texture atlas, and exports a GLB to `../web/sets/<id>.glb`.
The board loads those GLBs on first use (`web/src/three/modeledSets.js`).

| File | What it makes |
|---|---|
| `cbkit.py` | **The toolkit.** Modelling: lathe profiles (`Turn`); SDF sculpting (numpy fields meshed with Blender's bundled OpenVDB, region-local evaluation, `sd_inflate` for carved silhouettes, `carve` for V-grooves that follow the surface); hard-surface primitives with angle-limited bevels. Baking: the UV atlas with a coverage check; high-to-low baking (`make_low`, `hard_surface_high`); Cycles bakes (colour through EMIT, AO, roughness, normal, optional metal and emission), filled to full bleed; rain stains traced from ledges (`stain_attribute`). Export: baked materials and Draco GLB. Plus preview renders |
| `set_classic.py` | **Classic**: Jaques Staunton, boxwood/ebony, baize under the feet; the knight head is an SDF glued to a turned base |
| `set_menagerie.py` | **Menagerie**: animal-themed Staunton (hedgehog pawn, bear-cub rook, horse, owl bishop, swan queen, St Hubert's stag king), porcelain/bronze, gilded bands. The animals are turned 35° so both seats see three-quarters |
| `set_cairn.py` | **Cairn**: flat river stones balanced on a slate. Per-stone tone and local coordinates, so banding, grain, pits and veins run inside each stone; the knight is a horse-head found stone |
| `set_beton.py` | **Béton**: Classic's tournament Staunton profiles cast in board-formed concrete: fluted shafts displaced into a dense lathe (the bake source), plank seams and grain, form-tie holes, rain stains, weathering-steel finials and king's cross. Its `_concrete` shader (turned pieces, no projection seams) is shared with Estate |
| `set_estate.py` | **Estate**: Classic's Staunton profiles as round towers. `floors_profile` rebuilds each shaft and crown as floor slabs and recessed glazing; windows are per-face and per-corner data (`glass`, `lit`, `wuv`) drawn by the material, lit floor by floor at night. The knight's neck is cut along its window grid (`knight_facades`) before marking |
| `board_textures.py` | The board woods (maple, walnut, frame walnut) the app bundles in `web/src/assets/` |
| `room_hdri.py` | The Room environment: a study at night (books, fireplace, lamps, one small night window) rendered to an equirectangular HDRI, `web/src/assets/env_study.hdr` |

## Running it

You need Blender 4.5 LTS. The scripts use numpy and OpenVDB, which ship with Blender, and scipy, which official
builds may not include. If `import scipy` fails in Blender's Python Console, install it into Blender's own Python
(the `python` executable under `<blender>/4.5/python/bin/`): `python -m ensurepip`, then `python -m pip install scipy`.

Paths come from two environment variables, both optional:

- `RUKH_REPO` is the checkout. It defaults to the folder above `blender/`, so you only set it when the scripts
  are copied somewhere else.
- `RUKH_WORK` is where the heavy work files go (`.blend` copies, baked PNGs, previews). It defaults to
  `blender/work/`, which git ignores.

GLBs are written to `web/sets/` and the board and room textures to `web/src/assets/`.

The scripts have no command-line entry point. Each module exposes functions you call from Blender's Python: every
set has `build(size=2048, export=True)` and `preview_baked()` (most also have `preview()`), `board_textures` has
`build()`, and `room_hdri` has `build(size=2048, samples=384)`.

Run them from a Blender session with its window open, in the Python Console or the Text Editor. `cbkit` runs some
operators inside a 3D Viewport (`ctx_view3d`), which needs an open window, so `blender --background` does not work
for the set builds. Put `blender/` on the module path first:

```python
import sys
sys.path.insert(0, r"/path/to/Rukh/blender")

import set_classic
set_classic.build(2048)        # model -> atlas -> bake -> web/sets/classic.glb
set_classic.preview_baked()    # after build: both colours, rendered under RUKH_WORK

import board_textures
board_textures.build()

import room_hdri
room_hdri.build()              # renders the study, writes web/src/assets/env_study.hdr
```

Python caches imported modules. After editing a script, reload `cbkit` and then the set module
(`importlib.reload(cbkit)`, then `importlib.reload(set_classic)`) before you call it again.

Then `cd ../web && node build.mjs` copies the new GLBs into `dist/sets/` and, unless you pass `--no-single`,
inlines them into `../chessboard.html`.

## Conventions every set follows

- One Blender unit = one board square. Z up; pieces stand on z = 0, centred on their base. The loader scales
  each set so its king is 1.18 tall.
- A piece with a front faces −Y in Blender (+Z in three.js). The board turns White's pieces to face Black.
- Nodes are named `<id>_<role>`. Every piece carries the WHITE baked material, and a one-triangle node
  `<id>_swatch_black` carries the BLACK one, so the geometry ships once.
- `export_set` resets every piece to the origin before export, so a preview layout can never ride into a GLB.
- **Game meshes stay in budget** (about 12–26k triangles a piece). Sculpted pieces are baked from a dense
  source (`<id>_<role>_hi`) onto a decimated copy. Hard-surface pieces bake colour, stains and roughness from a
  flat-subdivided copy, and take their normals and AO from the game mesh itself.

## Lessons learned

- Never let two sequential EXACT cutters share a plane (the result is a union-like artifact). Never pre-join
  overlapping cutters either.
- Bake base colour through EMIT. Cycles' diffuse-colour pass is scaled by (1 − metallic), so metals bake black.
- A per-face mask on boolean output must test every vertex of the face, not its centre.
- Board-formed seams are a periodic function of height. A Brick texture breaks real faces into short bricks.
- **Pack UVs with a FRACTION margin and check the coverage.** A SCALED margin on thousands of small islands
  left Estate 0.2% of its atlas (Menagerie 4%, Cairn 14%); the bake then spread a few texels into blotches.
- **Bake AO from the game mesh.** A bake source lying on its low sees the low in every AO ray and bakes black.
  Transferring a low's custom normals onto its subdivided copy gave garbage normal maps too.
- **An SDF primitive is only evaluated inside the box you give `Grid.add`.** A pillar stone taller than its
  box was cut off top and bottom, and the stones above it floated. `set_cairn.finish` now refuses a piece that
  is in more than one part.
- **A FLOAT2 attribute on face corners is a UV map** to Blender. Clearing the UV layers before packing deleted
  Estate's per-window coordinates. Keep custom per-corner data in FLOAT_VECTOR.
- **Match the bake cage to the source.** Where the source is a flat copy lying on the game mesh (the
  hard-surface sets), use a 1.5 mm extrusion and a 6 mm max ray. The 12 mm cage made for sculpted sources reached
  across the window reveals and baked Estate's lit panes as triangles.
- Colour bakes run at 32 samples. At 4, an AO node inside a material bakes as speckle (the porcelain's
  "dark specks").
