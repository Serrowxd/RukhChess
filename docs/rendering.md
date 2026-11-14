# The 3D view: rendering

How `web/src/three/scene.js` works. It owns the renderer, the camera and its controls, the lights, the room around the board, and the render loop. The other files in `web/src/three/` are covered in `rendering-parts.md`.

## The view handle

`createView(container, settings, deps)` returns the view described in [web-contract.md](web-contract.md), plus some extras:

- `view.setMaterialSet(matSet)`. `main.js` must call this after `createMaterialSet` and again on every theme change. Without it, "lighting off" cannot flatten the materials.
- `view.onLighting(fn)` and `view.onViewModeChange(fn)` subscribe to changes and return an unsubscribe function.
- `view.tween`, `view.flyTo`, `view.worldToClient`, `view.render()` (one synchronous frame), `view.invalidate(kind)` and `view.stats`.
- `view.setMotionQuality(level)`, `view.setMotionLevel(n | null)` and `view.motionQuality`.
- Pure exports for the ui and the tests: `LIGHTING_PRESETS`, `DEFAULT_LIGHTING`, `resolveLighting`, `lightingValues`, `seatTheta`, `fitDistance`, `TABLE_TOP`, `keyMirrorPoint`, plus the panorama helpers `tableUnder`, `kneeEquirect`, `blurEquirect` and `turnedUVs`.

The third argument is for tests and embedding. Production passes nothing. `deps.renderer` and `deps.labelRenderer` supply stand-ins. `deps.environment: false` skips the PMREM pass. `deps.assets` hands in the HDRIs and the walnut texture. `deps.now` replaces the clock. `test/view-modes.test.mjs` uses these to run the view headless.

## Render on demand

The loop runs on every animation frame. That part is cheap: tweens, controls, damping and frame hooks. It draws only when something visible may have changed.

`invalidate(kind)` says a frame is owed:

- `'camera'`: only the viewpoint, or the input of a post effect, changed. The key's shadow map is kept.
- `'content'`: the lit scene changed. That frame also redraws the shadow map (`key.shadow.autoUpdate` is false).

Frames are asked for by the view's own setters, every tween, the controls' events, the `onFrame` hooks, and `three/redraw.js`. The board, the piece layer, the materials and the piece sets go through `redraw.js`, so they do not need to know the view.

An `onFrame` hook returns `false` when it changed nothing, `'camera'` when it moved only the viewpoint, and anything else when it changed the scene.

Two backstops sit under the explicit calls:

- Each frame the camera's matrices and the canvas size are compared with the last drawn frame (`'camera'`), and so is every object's place, visibility, child count and material state (`'content'`). Lights are left out of that comparison, because the seat fill moves with the camera.
- With nothing owed, a `'camera'` frame is still drawn every `SAFETY_NET_MS` (500 ms).

Every `'content'` frame is followed by one `'camera'` frame. The first frame after a material rebuild can differ from the settled picture by a few pixels.

OrbitControls' damping never quite reaches zero, so a camera can creep for minutes after a drag. Once it moves less than `CAMERA_EPS` between frames it counts as stopped: the leftover damping is cleared and one last frame is drawn where it came to rest. A resting camera is also held in place against the one-ulp drift of OrbitControls' spherical round trip.

The shadow map does not depend on the viewpoint. The key is a fixed directional light whose shadow camera is set from the key alone. `aimSeatLights` moves only the seat fill, which casts no shadow. `updateClip` changes only the view camera's near and far planes.

### Shadow stand-ins

The modelled piece sets have low-detail stand-ins (`pieces.js standInOf`). These are drawn into the shadow map in place of the full meshes. The view wraps `renderer.shadowMap.render` to do this. In three 0.186 the map is drawn inside `renderer.render`, after the frame's draw list is built and before it is drawn, so swapping meshes for the length of the map pass leaves the frame itself untouched.

## Motion quality

On a slow GPU the cost of a frame is per-pixel work. The worst single item is the key's VSM blur on frames that redraw the shadow map.

While the picture is moving and the machine is not keeping up, frames are drawn at a cheaper level (`MOTION_LEVELS` in `motionQuality.js`). The first step uses fewer blur samples. The next step also uses a lower pixel ratio. Once nothing has been owed for `MOTION.settleMs`, one settle frame is drawn at full quality, with a shadow redraw if the map in use was drawn with the cheaper blur. At rest the picture is exactly what it would be without this feature.

Which frames count as motion:

- A drawn frame is a motion frame when the animation frame before it also drew, or when the last drawn frame was a motion frame less than `settleMs` ago (a short gap in a drag).
- The follow-up frame after a `'content'` frame inherits the frame before it. Settle frames and safety-net frames never start motion.
- The first frame after a rest is a full one, so a single click is drawn at full quality and needs no settle.
- Motion that never stops, such as auto-rotate, stays at its level for as long as it lasts.

The policy is fed the time between two consecutive animation frames that both drew a motion frame. It keeps one memory per view mode.

The pixel ratio is changed in `renderFrame`, right before that frame's draw and in the same task. So the drawing buffer is resized, cleared and drawn at once. The edge light and the glow size their targets from the drawing buffer inside that same draw. The canvas's CSS size never changes, so a ratio change does not owe an extra frame. The edge ring is measured in CSS pixels and the glow's blur step follows the pixel ratio, so both keep their width on screen.

`view.stats` reports `level`, `reduced`, `interval_ms` and `settles`. With a real WebGLRenderer it also carries `triangles` and `lastTriangles` (`{ main, shadow, edge, glow }` per pass) and `gpu`, the adapter name when the browser gives it.

## Quality levels

`settings.quality` picks an entry of `QUALITY` in `motionQuality.js`. A level can cap the pixel ratio (`ratioCap`), lower the shadow map size (`mapSize`) and the blur samples (`blurSamples`), turn shadows or the after-frame effects off, and decide whether motion frames adapt at all (`adapt`). `'high'` never reduces.

`setMotionQuality` applies a level at once. It rebuilds both motion policies, keeps any pinned level, resizes or drops the shadow map, and re-applies the lighting. A new map size throws the old map away so three builds it again. The shadow blur radius is the same at every level, so medium's smaller map gives a softer shadow edge.

## The camera

There is one `PerspectiveCamera` for both modes, driven by OrbitControls. Presets are `white`, `black`, `top` and `side`. Once the user orbits away, the preset reads `'free'`. A narrow pane pushes a preset back so the whole board stays on screen (`fitScale`).

Only one camera tween runs at a time. Starting another one, or the user grabbing the camera, cancels the running tween, and its promise resolves `false`. Nothing rejects. A plain click does not count as grabbing, so clicking a piece during a flip does not strand the camera. A 2D/3D transition cannot be interrupted: a stray drag would leave the camera half-way with a wrong field of view.

`rotateSeat` turns the camera and the pan target together about the board's vertical axis. It never touches the polar angle, so the same code works in both modes and reads as the board turning.

In 3D the camera never drops below the table top. The orbit target stays on or above it, and `MAX_POLAR` and `MIN_DIST` keep the camera at least `TABLE_CLEARANCE` over it.

### 2D mode

2D uses the same camera, narrowed to a 12 degree field of view and pulled back to about 47 units (`fitDistance`). At that focal length the projection is nearly orthographic. A lifted token at a board corner shifts by about 3% of a square. Raycasts, CSS2D labels and every module that holds `view.camera` keep working unchanged. Swapping in an OrthographicCamera would change the type of `view.camera` under five other modules.

The polar angle is pinned to `TOP_EPS` (0.2 degrees) rather than exactly 0. At exactly 0 the camera's roll is undefined and `lookAt` picks it arbitrarily, so the board could not be turned to the other seat. With rotate off and the polar limits both at `TOP_EPS`, nothing can tilt it. Pan and zoom stay on. Left-drag does nothing, but shift+left still pans, because OrbitControls checks shift before it checks `enableRotate`.

In 2D the seat's azimuth is measured about the camera's own target, not the board centre. The camera leans only a fraction of a unit off vertical there, so any pan would otherwise flip the azimuth to the other seat.

Near and far are pulled in to about 0.45d and 1.9d + 20 in 2D. With near = 0.1 at 47 units the depth buffer cannot separate the thin overlay stack (arrows and dots, 0.004 to 0.020 units up) from the board.

`setSafeArea` tells the view which margins the floating UI covers. 2D fits the board in what is left and aims so the board is centred there. A refit keeps the user's zoom ratio, and keeps their pan unless `recentre` is asked for.

Going from 2D back to 3D restores the exact pose that was saved on the way in. If the seat was flipped while in 2D, the pose is first turned to the new seat. If the transition is superseded, for example by a preset click, only the lens and the up vector are restored, so the 2D lens never survives into 3D.

## Lighting

Lighting presets live in `LIGHTING_PRESETS`. Each one sets the exposure and the base strength of the key, hemisphere, fill, environment, seat fill and edge light, plus the key's position and the VSM blur radius. The user's `key` and `ambient` values (0 to 2) multiply those. Naming a new preset resets exposure, key and ambient to its defaults unless the same patch also names them.

`lightingValues` turns resolved settings into the numbers the renderer takes. When a lit result would blow out the board's top faces, exposure is pulled back under `WASH_CEIL`. The slider keeps the user's value. `applied.exposure` is what the renderer got.

The HDRI rooms use Khronos PBR Neutral tone mapping, which keeps base colours true. Plain keeps ACES.

### Lighting off

`setLighting({ on: false })`, or the `flat` preset, does not dim the lights. It switches to unlit shading: no tone mapping, no scene environment (metal and glass would go black), all lights at 0, shadows off, and `matSet.setUnlit(true)` so the materials move their colour into `emissive`. The table follows with its own unlit switch, a step darker than the board.

### The key

The key stands off White's right, square to the two seats, at about 46 degrees. A steep key lights the tops evenly and a white piece dissolves into a light square. A lower key throws a contact shadow that gives the piece an edge.

A directional light's mirror image on a flat top lies from the camera's foot toward the light's azimuth (`keyMirrorPoint`). From the side, it lands past the table's rim for both seats.

Shadows use `VSMShadowMap`. Three's PCF rotates a small sample disk per pixel by noise meant to be averaged by TAA, which this app does not have, so every penumbra showed as a stipple. VSM filters the map itself and gives a smooth ramp.

### Reading the far army

Ebony and boxwood are only about 4x apart in display terms, so no single background can sit 3:1 from both under even light. The far army needs light the table does not get. Two camera-relative helpers do this. Both are off in 2D and when unlit.

- The seat fill is a directional light from behind the camera, `SEAT_ELEVATION` (15 degrees) up, with no shadow, re-aimed every frame. Being low, it lights the upright faces of the pieces about four times more than the flat board. Being on the camera's side, it can never mirror in anything flat in view.
- The edge light (`silhouette.js`) draws a thin line of the room's light on the outer silhouette of the pieces in the far half of the board, after the frame. It is not a THREE light, because a light behind the far army mirrors in the lacquer from every low seat.

`tools/readability.mjs` measures the result.

## Environments

`settings.environment` picks where the board sits:

- `room`: a study at night rendered in Blender (`blender/room_hdri.py`).
- `studio`: a CC0 HDRI from Poly Haven.
- `plain`: a synthetic RoomEnvironment for reflections, with the page colour behind the board. This is also what you get when no assets are passed, as in the node tests.

The HDRI rooms light the reflections and show, blurred, behind the board, which stands on a walnut table.

Fields of `ENVIRONMENTS`:

- `rot` turns the room, in radians.
- `light` scales the direct hemisphere and fill lights, which an HDRI mostly replaces.
- `seat` and `back` scale the seat fill and the edge light.
- `env` scales the reflections. `envBlur` blurs what the lacquer reflects, in radians.
- `blur` and `bg` are the background's blur and brightness.
- `bgKnee` rolls off the background's highlights above that radiance, so a softbox seen from the side does not clip to white.
- `floor` gives a room without one a floor under the table.
- `under` is the board's luminance as the pieces see it reflected below the horizon.
- `tint` is the colour of the room's light, which the edge light takes.
- `exposure` is the room's exposure multiplier.

Each room is turned so neither seat's low, grazing view mirrors a bright light panel across the board.

What a glossy piece reflects below the horizon is the table and the board, not the HDRI's floor (`tableUnder`, `TABLE_REFLECTION`). The panoramas were rendered without the table, so the floor's rug showed in the ebony. The board tone is kept nearly neutral, because the checker's colour depends on the theme and the reflection does not.

The HDRI rooms are blurred on the sphere (`blurEquirect`) rather than by PMREM's own blur. PMREM samples a twenty-point spiral, and small bright lights came through it as speckle in every mirror-smooth coat.

Three's background shader has no dither, and the dim blurred panorama bands in 8 bits. `ditherBackground` patches three's shared `backgroundCube` shader once, before the first background is drawn.

## The table and the vignette

The table is a turned walnut pedestal table, about 85 cm across, built once in the browser from the walnut texture: a top with a rounded edge, an apron with a bead, and a beaded column on a stepped foot. The turned parts get UVs by arc length, so the grain does not bunch where profile points crowd. The board stands on a dark green felt pad, so frame and top do not meet brown on brown. A soft disc under the foot stands in for its shadow. `view.table` is the group. It is hidden in 2D and in Plain.

The Studio gets a floor. Plain, which floats the board over the page, gets a soft drop shadow under it instead.

A CSS vignette (`div.vignette3d`) sits between the canvas and the labels. It darkens the corners in 3D only, fades out with the switch to 2D, is never hit-tested, and is not part of the canvas pixels.

## Notes

- `setQuality({ antialias })` is accepted but does not apply live. WebGL fixes antialias when the context is created, and a new canvas would orphan the interaction module's listeners. The renderer is created with antialias on.
- `setQuality({ shadows })` goes through `setLighting`, so the two never disagree.
- `mouseButtons.RIGHT = null` is safe in three 0.186: a null button maps to no action. The right button belongs to annotations.
- Production builds turn off three's shader diagnostics. They read every program's log back synchronously, and on Windows the D3D compiler's harmless precision notes filled the console on every boot.
- A restored WebGL context has lost every render target, so the whole scene is drawn again and the GPU name is read again.
