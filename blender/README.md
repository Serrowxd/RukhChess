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

Blender 4.5 with the MCP add-on listening on `127.0.0.1:9876`. The MCP tool wrapper times out on this
machine, so the scripts are sent over the add-on's raw socket. The helpers live in the session scratchpad
(`bl.py` sends code; `blrun.py <module> <function> [args]` reloads `cbkit` plus the module and calls the
function):

```bash
python blrun.py set_classic build 2048      # model -> atlas -> bake -> web/sets/classic.glb
python blrun.py set_classic preview_baked   # studio render of both colours
python blrun.py board_textures build
python blrun.py room_hdri build             # renders the study, writes web/src/assets/env_study.hdr
```

Then `cd ../web && node build.mjs` bundles the new GLBs into `dist/` and into `chessboard.html`.

Heavy work files (`.blend` copies, baked PNGs, previews) go to `blender/work/` (git-ignored), or wherever
the `RUKH_WORK` environment variable points.

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

## Lessons paid for (see Ideas/Chessboard/log.md, 2026-09-24)

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
