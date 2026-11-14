# Rendering parts

How the pieces of `web/src/three/` other than `scene.js` work, and why some of them are built the way they are.

## Redraw on demand

`scene.js` draws a frame only after something visible may have changed. The board, the piece layer, the materials and the piece sets do not know the view, so they call `requestRedraw()` in `redraw.js`. Every live view registers a handler there.

- `'content'` means something in the lit scene changed. The frame is drawn and the shadow map is redrawn.
- `'camera'` means only the viewpoint or a post effect's input changed. The frame is drawn and the shadow map is kept.

With no view registered (node tests, tools that build one layer alone) a request does nothing. The board and the piece layer wrap every setter that changes what is drawn so it asks for a `'content'` frame. Getters do not ask.

## Board (`board.js`)

`board.js` owns the square to world mapping. File a..h runs along +X (a = -3.5, h = +3.5), rank 1..8 along -Z (rank 1 at z = +3.5), and the board top is y = 0. The pure helpers (`squareToWorld`, `worldToSquare`, `isKnightJump`, `isDarkSquare`) have no three or DOM use and are safe in node tests.

Every square gets its own geometry whose UVs look at a different half-size window of the wood texture, half of them turned end for end, so no two squares share a grain. The window is seeded by the square index, so the board looks the same on every load.

The frame is an extruded, chamfered slab with box-projected UVs. On the top face the grain runs along each side and meets on the diagonals, like a mitred frame, and a thin dark hairline marks each mitre joint. The stringing is a thin ring of the light square material between the squares and the frame (3D only).

### Overlays and view mode

Overlays sit at fixed heights with fixed render orders, in two tables (`LAYERS`), one per view mode.

- In 3D everything hugs the board with depth testing on, so a piece hides the tint under it and an arrow passes behind the pieces it runs between.
- In 2D the board is seen head-on from above. An arrow under the tokens cannot be read, so arrows and capture rings lift above token height and turn depth testing off. Square tints stay below the pieces in both modes, because they are the square's colour, not a mark on it.

The board keeps what each overlay shows in `cur`, so a view-mode switch rebuilds every overlay at the new heights without waiting for the next store event. In 2D the frame is flattened, and the coordinate strips are lifted by the same amount so they sit on it.

Legal-move marks are two-tone (a dark outline and a pale core), so a mark reads on both light and dark squares in every theme.

### Coordinates

In 2D all four strips show, flat and bold. In 3D the coordinates are gilt metal inlay with a soft bevel from a bump map (a blurred copy of the glyphs), and only two strips show: the files along the edge nearest the seat and the ranks down the player's left, the way a printed diagram labels a board. A far strip would only peek out from behind the back rank. Labels are redrawn once the page's web font has loaded.

## Interaction (`interact.js`)

One pointer gesture runs at a time.

- Left press on a movable piece starts a captured `'piece'` gesture with the controls off. A release without moving past the threshold is a click (select, deselect or click-move). Moving past it is a drag: `layer.lift`, `dragTo`, then `drop` with `attemptMove` or `setupPlace`.
- Left press anywhere else starts an uncaptured `'soft'` gesture, so OrbitControls keeps working. A release without moving is a click on that square.
- Right press starts a captured `'right'` gesture that never orbits. Release on the same square toggles a highlight, on another square toggles an arrow, with a live preview while dragging. Shift is red, Alt is blue, Ctrl is yellow, none is green.
- Touch works the same for taps and drags with a 10 px threshold. A 500 ms long press is a highlight. There are no touch arrows.
- A second pointer during a gesture (a pinch or two-finger pan) aborts ours cleanly and leaves the pointer to the controls.

Listeners are registered in the capture phase so they run before OrbitControls. A gesture that claims the pointer disables the controls first and stops propagation.

The view mode is read from `store.state.viewMode`. In 2D scene.js has turned orbiting off, so an empty-board press stays a soft gesture and nothing more is needed here. Double-click on empty board resets the view, to the seat preset in 3D and to `'top'` in 2D so the reset cannot tilt the locked overhead camera. A view-mode switch aborts any gesture, because the layer rebuilds every piece mesh.

In setup mode main.js clears the overlays and the board shows the scratch position. Right-click erases the square, and a plain click places or erases the palette brush from `'ui:setupBrush'`.

## Piece layer (`pieceLayer.js`)

The layer keeps one piece group per square and reconciles it to a position with `sync()`. Animation runs on a small internal requestAnimationFrame ticker.

### Facing

Pieces are authored facing +Z. The layer turns white pieces by pi so knights face the opponent. Knights also turn toward the board's centre line, mirrored per colour, so each shows its owner a three-quarter profile. Bishops with a mitre cut turn the cut three-quarter toward their owner. Flat token sets are turned by the seat instead, and `setOrientation` animates that turn alongside the view's seat rotation.

### Animated moves

An animated sync finds the mover, the displaced pieces and the landing squares from a diff of the old and new positions. Same-piece pairs slide (the castling rook), the rest of the displaced pieces fade out as captures, and the mover slides to its square. Chess960 castling can name a destination square that ends up empty, so the king's real square is taken from the diff. A promotion slides the pawn and swaps in the new piece when it lands.

### Dragging

`lift` keys the piece at its origin square until the next sync. `drop(square)` settles the mesh on a square visually, and `drop(null)` snaps it back. A sync can land between `lift` and `drop`, because main.js syncs on the store's change in the middle of a drag. An animated sync re-seats a lifted piece that is not the mover, and a later `drop` on a removed mesh does nothing. `lift` re-reads its square after finishing a running tween, so grabbing a piece mid-promotion takes the new queen.

### Two set slots and fades

The layer holds a 3D set and a 2D set. A view-mode switch builds the new meshes on the same squares and keys them in at once, so raycasting sees the new set from the first frame, while the old meshes fade out beside them. Piece materials are shared by every piece of a colour, so any fade runs on a clone that is given back when the fade ends. Opacity is scaled relative to each part's own opacity, because the contact decal is already translucent.

## Pieces (`pieces.js`)

Every piece is a group with `userData { role, color, square, set }`, its origin at the base centre on y = 0. Geometry is shared through a cache. The built-in sets are a lathe-turned Staunton, a minimal set from primitives, and a flat 2D token (`glyph`).

Mesh flags other modules rely on:

- `keepMaterial`: `applyMaterials()` leaves the material alone.
- `ownFinish`: a modelled set's own baked material. In metal and glass it is swapped for the theme's finish over the same baked detail, and the very same material comes back in wood.
- `accent`: an inset or bezel, pointed at the theme's accent material.
- `contactShadow`: the decal under the piece. It pins itself to the board plane in `onBeforeRender`, so a lifted piece does not carry its shadow up.
- `glyphCard`: the token's glyph quad, never lit.
- `standIn`: a modelled piece's low-detail stand-in, hidden and never picked.

### Turned profiles

Profiles are `[radius, height]` pairs from bottom to top, built from Bezier curves and arcs with a small fluent builder. A repeated point makes a hard crease, because LatheGeometry gives a zero-length segment a zero normal and the neighbours keep their own. The rook crown and the token bezel are closed loops that revolve into hollow rings and never touch the axis. The king carries a double cross so it reads as a cross from the seat and as a plus from above.

### Glyph tokens

The token is a disc in the piece colour, a bezel ring in the accent colour, and the cburnett glyph with a contrasting halo. The bezel is what keeps a white token visible on a light square from straight above. A glyph texture that fails to rasterise is not cached, so the next card retries.

### glTF and modelled sets

`registerGltfSet` scales a set so its white king is the built-in king's height. User files are centred on their bounding box. The modelled sets keep their authored origin, because a knight's bounding box is not its base. The contact decal is sized from the foot's radius so the foot's edge lands on the gradient's shoulder.

Modelled sets ship as one Draco-compressed GLB each (`modeledSets.js`). Every GLB has six mesh nodes named `${prefix}${role}`, authored at their base centre facing +Z with the white material, and one hidden `${prefix}swatch_black` node carrying the black material, which is applied to clones of the same meshes so the geometry ships once. In `dist/` the bytes are fetched from `sets/<file>` on demand. In the single-file build they are inlined as base64 in a `<script type="text/plain" id="set-<id>">` tag and decoded only when the set is chosen.

A set may also have a small proxy GLB with the same node names, simplified to a few thousand triangles. These stand-ins sit beside the full mesh inside the normalised group, so they follow every move, lift, turn and fade without extra code. The view shows them in place of the full mesh only while it draws the shadow map and the edge-light mask. A proxy fetch that fails or stalls just gives no stand-ins. The single-file build carries none.

### Draco decoder

The decoder is a JS wrapper and a WASM binary. In `dist/` they are fetched from `vendor/draco/`. The single-file build inlines them as script tags (`draco-glue` as text, `draco-wasm` as base64) and the shared loader reads those instead, so the file works from `file://` with no server.

## Materials (`materials.js`)

### Contrast aid

Two aids keep pieces separate from the squares whatever the lights do.

- A rim term: every piece and accent material mixes its final colour toward a rim colour by `pow(1 - |N.V|, p)`. At the silhouette the outline darkens on light pieces and lightens on dark ones from any camera angle, including straight overhead. It acts on the outgoing light, so it survives the unlit switch. The patch is always compiled in, and turning contrast off only writes the amount to 0, so the switch never recompiles. All piece materials share one program.
- A contact shadow: a soft radial decal under every piece, drawn as a plain textured quad, so it shows with shadows off and in unlit mode.

The rim patch lives on material subclasses, not as own properties, because `Material.copy()` does not carry own-property `onBeforeCompile` across and the piece layer clones materials to fade them. The clone's rim values arrive JSON-cloned and are turned back into uniforms before it compiles.

### Unlit switch

Unlit mode moves the colour into `emissive` and neutralises every shading input, instead of swapping in a basic material. That keeps the material identity the piece layer holds, keeps the maps, and restores transmission and metalness exactly. Metal and glass go flat rather than black.

For the modelled sets an option keeps their ambient occlusion: the colour stays in the diffuse slot and a 1x1 white light map at intensity pi feeds it its own colour back, which the occlusion map then darkens. Another option flattens a metal's patina, because a patina made to be seen through reflections reads as blotches once only the map is left. The metal's own tones are pulled most of the way to their mean, while much brighter or darker metal (gilt bands) is left alone.

### Textures

The procedural canvases (wood grain, brushed metal, lacquer, contact shadow) are expensive to draw, and main.js rebuilds the set on every theme change. The canvases are cached per kind, size and seed, and each set wraps them in its own textures, so disposing one set never frees a texture another set uses.

Glass squares and the glass frame are opaque frosted glass, because three's transmission pass only sees opaque objects and transmissive squares would vanish behind glass pieces. Only the pieces transmit. Metal and glass need `scene.environment`.

The wood theme uses baked Blender textures when main.js hands them in, and the procedural grain otherwise. The palette then becomes a ratio tint relative to the theme's default. The lacquer's clearcoat roughness is varied by an uneven-polish map so a lamp's reflection breaks up instead of mirroring as a disc. The metal squares are only half metallic, so they take the lights as well as the reflection.

## Glow (`glow.js`)

The glow surrounds only what gives off light (Estate's lit windows and lamps). A plain bloom would also flare every bright highlight, which is far brighter than a window. Instead the scene is drawn a second time, small, with every emissive material replaced by its bare emission and everything else black. That is blurred at a quarter and an eighth of the canvas and added over the finished frame. With nothing emissive in view the pass is skipped.

The glow is added as light: the frame is decoded from display values, the glow added with the frame's exposure, and the sum encoded again and dithered. Added straight onto display values, a faint halo came out too strong in dark areas and a window near white went to white. The blur steps by the motion-quality pixel-ratio factor so the halo keeps its width on screen.

## Edge light (`silhouette.js`)

From White's seat the far black pieces stood dark against a dark room, and no single background brightness sits far enough from both ebony and boxwood. The edge light adds a thin line of the room's light around the outer silhouette of the pieces in the far half of the board, as a lamp behind the far rank would.

It is a pass and not a shader term because a surface cannot tell whether what lies behind it is the room or more of the same piece. Every in-shader version also lit creases inside the piece. Here the pieces are drawn into a mask (coverage, and how far into the far half each pixel lies), and the edge goes only where a piece pixel borders a pixel with no piece at all. A fading piece keeps its full shape in the mask and only its edge is scaled. Pieces close to the camera get no edge, since an outline on them reads as cel shading.

## Motion quality (`motionQuality.js`)

When the picture is moving and the machine is not keeping up, motion frames are drawn more cheaply. scene.js feeds the policy the time between drawn animation frames, the only speed signal a browser gives without GPU timer extensions. Frames at rest are always drawn at full quality, and scene.js draws one full settle frame once motion stops. The policy is pure, so tests drive it with numbers.

- Step down one level when the window's average is over budget and enough of its intervals are slow, so one slow frame (a garbage collection, a shader compile) never triggers it. After any change the window starts empty.
- Step up as a probe after a stretch of smooth motion. A probe that fails soon doubles the wait before the next one; a probe that holds resets it.
- A step down has to buy something. When stepping down reaches the last level, its first full window is compared with the averages that stepped each level down, and the policy goes back to the lowest level within a margin of the best. It then stops stepping down until the interval grows. A display capped near 30 frames a second therefore returns to full quality and stays there, while a slow GPU keeps the level that helped.

## GPU name (`gpuName.js`)

The About block shows the adapter name from `UNMASKED_RENDERER_WEBGL`. Chromium wraps it as `ANGLE (vendor, device, backend)`, with a PCI id and the Direct3D shader model inside the device part. Firefox gives the plain name, sometimes with `/PCIe/SSE2`, or a group of similar cards ending in `, or similar`, which is kept. `gl.RENDERER` is not used because Chromium answers it with `WebKit WebGL`.
