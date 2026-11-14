# Tools: web capture checks and the Blender scripts

This covers `web/tools/` (headless captures of the board and the checks run on them) and `blender/` (the scripts that build the piece sets, the board woods and the room). `blender/README.md` has the run commands, the set conventions and the lessons list; this file explains how the pieces fit together.

## Web tools

All the capture tools drive the board in headless Chrome with a fresh `--user-data-dir` per run, so nothing touches the profile the board is played in. The page must already be served. The tools default to `http://127.0.0.1:8150/`, so either serve `web/dist/` there with any static server (for example `python -m http.server 8150 --directory web/dist`), or run `rukh` and point the tools at it (`--url http://127.0.0.1:47474/` for `shoot.mjs`, `"url"` in the steps file for `cdp.mjs`). The page handle is `window.__chessboard` (`store`, `actions`, `view`, `board`, `layer`, ...).

### cdp.mjs

`node tools/cdp.mjs steps.json` runs a script of steps against the board.

```
{ "url": "http://127.0.0.1:8150/", "size": [1400, 900],
  "steps": [ {"js": "<expression, may be async>"}, {"wait": 500}, {"shot": "C:/path/out.png"} ] }
```

Each `js` step prints its JSON result. Console errors and exceptions are printed at the end.

### shoot.mjs

Screenshots the board from named camera angles.

```
node tools/shoot.mjs --set classic --out ./shots [--views white,low,close-king] [--fen "<FEN>"]
                     [--theme wood] [--size 1600x1000] [--ui] [--url http://127.0.0.1:8150/]
```

Views:

| View | What it shows |
|---|---|
| `white`, `black`, `side`, `top` | the board's own presets |
| `low` | a low three-quarter view from White's side (the hero angle) |
| `low-black` | the same from Black's side |
| `close-king`, `close-queen`, `close-knight`, `close-bishop`, `close-rook`, `close-pawn` | tight shots on White's piece of that role (e1, d1, g1, c1, h1, e2), turned to the carved side |
| `close-black-knight` | Black's g8 knight from White's side (its face) |
| `close-black-<role>` | Black's piece of that role (e8, d8, b8, f8, a8, d7) from White's side |
| `orbit-<deg>` | the low view turned `<deg>` degrees round the board |
| `piece-<square>-<deg>` | round one piece, 3 units out and 1 up, `<deg>` from White's side (0 = from +z) |
| `close-coords` | along White's near edge at the file letters and the inlay |
| `under` | far and low from White's right, just over the table top: rim, apron, pedestal |
| `corner-a1` | close on the frame's a1 corner (mitre joint, stringing, gilt) |
| `far` | far off White's right, looking down past the table at its foot and the floor |
| `2d` | the flat 2D mode (switches back to 3D afterwards) |

Captures are stage-only by default: the side panel and toolbar hidden, the canvas full-window, the 3D vignette kept. `--ui` keeps the app chrome.

Options:

- `--lighting off` captures with the lighting master switch off.
- `--env room|studio|plain` sets `settings.environment`.
- `--js <file>` evaluates a snippet in the page after setup, before the views.
- `--flip` flips the board to Black's seat first, so the black views see coordinates and glyphs oriented for Black.
- `--mask` also writes `<prefix>-<view>-mask.png` and `<prefix>-<view>-geo.json` after each view.
- `--normals` also writes `<prefix>-<view>-normals.png` after each view.

The mask is an object-ID render from the same camera: light squares red, dark squares dark red, frame and stringing yellow, table green, White's pieces blue, Black's cyan, coordinate glyphs magenta, everything else black. The geo file holds every square's projected corners and the screen boxes of the back rank farthest from the camera (contact decals left out, so a box is the piece).

The normals render colours each piece by its world-space geometric normal (`rgb = n * 0.5 + 0.5`, no normal maps), with everything else hidden. It is written after the colour-space step, so the bytes are the encoding.

It prints one line per file written. Exit code 1 if the set never finished loading.

### clipcheck.mjs

`node tools/clipcheck.mjs <dir> [--prefix classic] [--limit 250]` counts blown-out pixels on the board, frame and table.

For every `-mask.png` it reads the matching beauty shot and classifies each pixel by the nearest mask colour. The board is the light and dark squares plus the frame. Anti-aliased mask edges, far from every palette colour, are skipped.

A pixel is clipped when R, G and B are all at or above `--limit`, and hot when any one channel is. A warm highlight blows out red first, so 252,243,193 is hot but not clipped.

Each view prints clipped and hot counts, the brightest pixel (by its lowest channel) and where it is, and the box round the hot pixels. Exit code 1 if any board, frame or table pixel is clipped.

The PNG decoder is deliberately tiny: 8-bit RGB or RGBA, non-interlaced, which is what Chrome's `captureScreenshot` writes. Older masks used red for the whole board and blue for every piece; they still read.

### readability.mjs

`node tools/readability.mjs <dir> [--prefix classic] [--json out.json]` measures how well the far army and the checker read. It needs `--mask` output.

- **Far crowns.** For each piece of the back rank farthest from the camera, the crown band (top 40% of its screen box) is compared with the non-piece pixels beside and above it. `body` is the crown's median luma, `rim` its brightest 2% (p98), `back` the background's median. `contrast` is max(body, back) / min(body, back), which catches a dark crown on a light ground or the reverse. `rimRatio` is rim / back, the critic's measure of a highlight standing out. `separation` is the stronger of the two; the summary gives its minimum and median over the rank.
- **Means.** Mean luma of the frame, the table and the room, for context.
- **Checker.** Median luma per visible square, and the weakest light/dark ratio between orthogonal neighbours. A specular wash shows as a pair near 1:1.
- **Clip.** Clipped and hot board, frame and table pixels, as in clipcheck.

Luma everywhere is 0.2126 R + 0.7152 G + 0.0722 B on the 8-bit display values, the "luminance 0..255" of the critiques.

### facecheck.mjs

`node tools/facecheck.mjs <dir> [--prefix estate]` compares the pieces' flat tops with their side faces. It needs `--mask --normals` output.

Per view and army, piece pixels are sorted by world-space normal:

- **top**: facing up (n.y > 0.92), such as plinth tops, roofs and the flat of a crown.
- **key side**: upright (|n.y| < 0.35) and facing the key light across the table.
- **camera side**: upright and facing the camera.

It reports each group's median luma and top / key side. A back or rim light leaking onto the tops shows as a ratio well over 1. It also gives the share of top pixels above 200 (tops gone white).

### make-proxies.mjs

`node tools/make-proxies.mjs` (or `npm run proxies`) writes `web/sets/<id>.proxy.glb` for every set GLB.

A proxy holds one low-detail copy of each of the six piece meshes, under the same node name and world transform, with positions and indices only. The board draws these in the shadow map and the edge mask, where full detail is invisible, and keeps the full meshes for the main picture.

How a proxy is made:

1. Weld the source, because its vertices are split along UV and normal seams, which act as borders the simplifier cannot collapse across.
2. Simplify to a triangle budget with the error bound left wide open, so the budget decides. The simplifier spends it on the largest shape changes first, keeping the outline and dropping surface detail. If topology stops it well short, it falls back to the sloppy (vertex-clustering) simplifier.
3. Try the budgets smallest first and keep the first whose front and side silhouettes match the source to 99% intersection over union. Thin features (antlers, a swan's neck, crosses) need a larger budget; plain turned pieces stay at the smallest.
4. Check every piece: at most 6500 triangles, bounding box within 1%, silhouette at least 95%.

A set with a failed piece keeps its old proxy file, so a bad one never ships. Files are written to a temp name and renamed over the old one. The script never touches the source GLBs.

The proxies are derived from the set art and are art under the same licence (`LICENSE-ART.md`). They ship as separate files and must never be bundled into `app.js`.

## Blender scripts

Everything runs inside Blender 4.5 LTS with its bundled numpy and OpenVDB plus scipy (which may need installing into Blender's Python), from a Blender session with its window open, as `blender/README.md` describes.

### cbkit.py

The shared toolkit. Its sections are profiles (lathe), mesh helpers, SDF modelling, UV atlas, materials, baking, export and preview renders.

`REPO` is the checkout the file sits in. `RUKH_WORK` holds the heavy work files (`.blend` copies, baked PNGs, previews) and defaults to `blender/work/`. `HEIGHTS` mirrors the board's height ladder; the loader scales every set so its king is `HEIGHTS['king']` tall, so a set keeps its own proportions below that.

**Profiles.** `Turn` is a port of the board's `turn()` in `pieces.js`. `move`, `line`, `curve` and `arc` append (radius, height) points, bottom to top. `crease()` marks the last point as a hard edge, so its ring gets a sharp edge and the two sides keep their own normals. `lathe` revolves a profile about Z; points at r = 0 become poles, and the UVs are one cylindrical island with the seam at `seam_angle` (90 is the +Y side, the back of a White piece).

**SDF modelling.** `Grid` is a dense sampling grid. `Grid.add` evaluates a primitive only inside its own box plus the blend margin, so a primitive larger than its box is cut off. `to_mesh` meshes the field with OpenVDB and flips the faces when the volume comes out negative, because OpenVDB winds level-set polygons inward for this sign convention.

- `sd_inflate` inflates a 2D silhouette into a pillow: full half-thickness once a point is `depth` inside the outline, rounded off by a quarter ellipse toward it. It reads as a carved volume, not an extruded slab. The field is the ellipse's normalised radius, so its gradient stays bounded and the mesher places vertices cleanly; a square-root thinning field terraces.
- `carve` cuts a V-groove wherever `curve_fn(P)` (a signed distance to a sheet) is near zero. The groove is `2*w` wide at the surface and narrows to nothing `depth` below it, so the gouge follows the form however it curves. An optional `region` field limits where it cuts.
- `profile_polygon` mirrors a lathe profile across the axis, so the 2D field is symmetric with no seam at r = 0.

**Hard-surface pieces.** `hard_surface_high` makes the bake source: a copy subdivided flat and shaded flat, so a material that reads the normal (walls against tops) sees the real faces, carrying the rain-stain attribute at the finer density. The normal map is baked from the piece itself (`bake_set(normal_from_low=True)`), because the piece's own bevelled, weighted normals are the shading the map sits on.

`stain_attribute` gives every wall vertex (a near-horizontal normal) a water stain from the ledge, sill or window head above it. It casts one ray up from just outside the wall (finds overhangs) and one from just inside (finds the recess of a window above). The stain is (1 - distance / reach) ^ 1.5.

**UV atlas.** `uv_atlas` packs every object's islands into one shared atlas at equal texel density. The margin is a fixed fraction of the atlas (about 3 px at 2048). A scaled margin grows with the islands' own scale and, with thousands of small islands, left Estate 0.2% of the atlas. The bake fills everything outside the islands afterwards, so a thin margin is enough. `boost=(attribute, factor)` enlarges the islands of flagged faces after levelling, so small window panes get more texels.

**Baking.** `bake_set(set_id, objs, materials, ...)` bakes every object with the white and then the black material.

- `highs`, when given, are the sculpted sources carrying the materials; each pass bakes high to low per piece, and `objs` are the decimated lows that get exported.
- AO is baked from the lows with the highs hidden. A high lying on its low sees the low in every AO ray and bakes black, and the game shades the low anyway.
- Base colour goes through an EMIT bake, not the DIFFUSE colour pass, because Cycles scales diffuse colour by (1 - metallic) and gilding or bronze would bake black. Colour bakes use 32 samples, because a material that shades its colour with an AO node bakes that AO as speckle at low counts.
- A material with an `__emission__` node also gets a real emission bake; one with a `__metal__` value node gets a metalness bake.
- Every map is baked without a margin and then filled to full bleed from its nearest island texel, so no mip level averages into another island or the empty background.
- It returns `{'normal', 'ao', 'white': {'color', 'rough', 'orm', ...}, 'black': {...}}`, with the images saved under `WORK/<set_id>/tex/`. ORM packs occlusion, roughness and metalness into R, G and B.

**Export.** `export_set` gives every piece the white baked material and a one-triangle swatch object the black one; the board clones the piece meshes and applies it. It resets every piece to the origin first, so a preview layout never rides into the GLB.

### The sets

#### Classic (`set_classic.py`)

A Jaques-pattern Staunton in boxwood and ebony, with baize under the feet.

- Turned pieces are lathe profiles.
- The knight's head is a side silhouette inflated into a rounded volume, thinner toward its outline and tapering from neck to muzzle. It has cheeks, brows, eyes, nostrils, the mouth line, split ears and a lock-cut mane, and is glued to a turned base the way real ones are.
- The bishop's mitre cut enters from the side and runs two-thirds of the way through, so either seat sees a clean notch. A front cut is only seen by the opponent.
- The wood's growth rings run along Y. Planes parallel to the knight's flat flanks (which face X) drew map-like contour loops on them.

#### Menagerie (`set_menagerie.py`)

Porcelain against patinated bronze. Each piece keeps its turned body, and the animal becomes the part that names it:

- a hedgehog curled into the pawn's ball;
- a bear cub over the rook's battlements;
- a horse with a flowing mane;
- an owl whose ear tufts make the bishop's cleft;
- a swan rising from the queen's coronet;
- St Hubert's stag carrying the king's cross.

The animals are SDFs meshed with OpenVDB and decimated. All but the horse turn 35 degrees off the board's axis, so both players see a three-quarter view. The bronze is polished where hands rub the open surfaces, with verdigris in the recesses.

#### Cairn (`set_cairn.py`)

Pale limestone against dark basalt: each piece is a stack of flat water-worn stones on a split slate.

- Every stone is a little offset and tilted, with a visible seam.
- The top names the piece: a pebble, a slab with upright battlement blocks, a horse-head found stone, a cleft egg-stone, a ring of pointed stones, a cross of two bars.
- Every stone carries its own tone and local coordinates as face and corner attributes, so banding, grain, pits and veins run inside each stone instead of across the stack.

#### Beton (`set_beton.py`)

Classic's profiles and knight cast in board-formed concrete, white cement against charcoal. The surface carries:

- fluted shafts, displaced per vertex into a dense lathe (the bake source);
- plank seams and wood grain, form-tie holes and chipped arrises;
- rain stains under each collar;
- weathering steel on the bishop's and queen's finials and the king's cross.

The concrete shader works on turned pieces with no projection seam (3D noise stretched along Z).

#### Estate (`set_estate.py`)

Classic's profiles as brutalist towers: White by day, and Black at night with its windows lit.

- Every shaft is a round tower over a concrete podium, with a floor slab every storey standing proud of the line and recessed glazing between.
- The king's crown is a glazed penthouse under a cross with red aircraft lights, the queen's bowl an observation deck, the rook's turret a cantilevered top, the pawn's ball a water tank.
- The windows are per-face and per-corner data on the source (`glass`, `lit`, `hue`, `var`, `wuv`). The material draws them as framed panes, with a reflected sky by day and lit interiors at night.
- Dark windows come in runs round each floor, not a random checkerboard.

### board_textures.py

Bakes the board's wood theme: hard maple for the light squares, black walnut for the dark, a darker walnut for the frame. Each is a flat procedural wood with growth-ring bands along U, warped by slow noise, with pores stretched along the grain, mineral streaks and a gentle tone drift. The board samples a different window of the square textures for every square, so no two squares share a grain.

### room_hdri.py

Renders the Room environment, a study at night, to an equirectangular HDRI (`web/src/assets/env_study.hdr`) that the board uses for its blurred background and reflections.

The room is rendered rather than photographed because a photographed interior has one bright window, so the mood changes with the seat. Here every direction holds the same kind of thing: dark panelled walls, books and pools of warm lamplight. The one cool note, the night window, is small and dim. The walls are mid-value and near-neutral so the far army reads against them and the maple is not tinted yellow; the warmth comes from the lamps, and a soft cool ceiling fill keeps the room from turning amber.

Metres, Z up, with the camera (and so the board) at the room's centre at seated table height. North (+Y) is a wall of books between two sconces, south (-Y) the fireplace under a painting, east (+X) the tall night window with curtains and a floor lamp, west (-X) books, an armchair and a table lamp. The render is halved for the app, since the board blurs it anyway.
