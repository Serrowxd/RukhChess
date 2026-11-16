# Web tests

The web board's tests live in `web/test/`. They use `node:test` and run under plain Node, with no browser.

## Running them

From `web/`:

```
node --test
```

One file at a time:

```
node --test test/core-store.test.mjs
```

The engine tests in `uci.test.mjs` start the real Stockfish build from `web/vendor/` as a child process. If the Stockfish files are missing, those suites are skipped.

## What each file covers

| File | Covers |
| --- | --- |
| `board-mapping.test.mjs` | Square to world coordinates and back (`three/board.js`). |
| `board-tabs.test.mjs` | The board strip (`ui/boardTabs.js`) on a small stand-in DOM. |
| `core-chess960.test.mjs` | Chess960 numbering and castling rights (`core/chess960.js`). |
| `core-clock.test.mjs` | The chess clock arithmetic (`core/clock.js`). |
| `core-game.test.mjs` | Rules, castling forms, the move tree, SAN and UCI (`core/game.js`). |
| `core-io.test.mjs` | YAML, JSON and PGN round trips, the URL hash (`core/io.js`). |
| `core-store.test.mjs` | Store actions, events, settings, autosave, self-play and the clock (`core/store.js`). |
| `gpu-name.test.mjs` | The adapter name in Settings > About (`three/gpuName.js`). |
| `interact.test.mjs` | The pointer state machine (`three/interact.js`). |
| `mcp-bridge.test.mjs` | The optional MCP bridge (`ai/mcpBridge.js`). |
| `motion-quality.test.mjs` | Cheaper frames while a slow machine is moving (`three/motionQuality.js`, `three/scene.js`). |
| `packet.test.mjs` | The AI packet, chess blocks, annotations and the chat loop (`ai/`). |
| `piece-layer.test.mjs` | The piece layer across 2D and 3D (`three/pieceLayer.js`). |
| `pieces-profiles.test.mjs` | Piece shapes, materials, glyphs and the piece layer's reconcile. |
| `quality-levels.test.mjs` | The quality setting and what each level turns on. |
| `remote-sync.test.mjs` | Remote mode: frames, signatures and the socket shell (`net/remoteSync.js`). Its frames carry no `tab`, so it runs the one-unnamed-board path; the tab wire is proven by the tab tests. |
| `remote-sync-step2.test.mjs` | Remote mode with node ids, matches, presence and the AI chip. |
| `remote-sync-tabs.test.mjs` | Remote mode with board tabs: the tab on every intent, the switch path, setup. |
| `render-on-demand.test.mjs` | Drawing only when something visible may have changed (`three/scene.js`). |
| `stand-ins.test.mjs` | Low-detail stand-ins for modelled sets (`three/pieces.js`, `three/silhouette.js`). |
| `stand-ins-view.test.mjs` | The view drawing shadows and the edge mask from the stand-ins. |
| `uci.test.mjs` | UCI parsing and the Stockfish driver (`engine/`). |
| `view-modes.test.mjs` | View mode, seat rotation and lighting (`three/scene.js`), and the 2D board look. |

`fake-table.mjs` and `fake-program.mjs` are helpers, not test files. `node --test` still loads every `.mjs` under `test/`, so each counts as one passing test.

## Running three without a browser

The view tests (`view-modes`, `render-on-demand`, `motion-quality`, `quality-levels`, `stand-ins-view`) build a small DOM before they import three. It holds a canvas with a 2D context, since `board.js` draws its coordinate strips into one, and an element that OrbitControls can attach to. The shim has to be in place first, so three is loaded with `await import()` after it.

Everything that matters is real three: the camera, the controls, the lights, the raycaster and the geometry. Only the renderer is a stand-in. It is handed to `createView` through its third `deps` argument. Each file's stand-in records what that file needs, such as draw counts, pixel ratio, shadow map size or the meshes visible in each pass.

## Driving frames by hand

`requestAnimationFrame` is replaced with a queue. `pump()` runs one animation frame for every callback queued so far, and callbacks queued while it runs wait for the next one. This lets the piece layer's own ticker run alongside the view's loop, as it does in a browser.

Where frame timing matters, the view gets a fake clock through `deps.now`, so frame intervals are exact.

The piece layer finishes a tween at once when `requestAnimationFrame` is absent, which is the case in plain Node. Tests that only check end states rely on that. Tests that need the middle of a transition swap in a hand-driven scheduler (`installRaf()` in `piece-layer.test.mjs`) and restore it before they return.

## Fake clocks and timers

`core/clock.js` takes an explicit `now` in every call, so its tests drive it from a fake epoch. A `Date.now()` anywhere in `clock.js` would show up as a failing test, and one test checks the source for it directly.

The store tests use `timed()`, a store whose clock runs on a fake `now`. `t.at(ms)` moves it forward and `t.pump()` runs one ticker cycle.

The MCP bridge tests inject everything ambient: a stub `fetch` that records every call, and timers that never fire, so the polling loop only runs when a test asks it to. They use a small chessops-backed `MiniGame` instead of `core/game.js`.

## The stand-in program table

`fake-table.mjs` stands in for the Rukh program's table, so the page's remote mode can be tested without the program. It is written on the page's own `Game`. It speaks the step-2 frame and intent shapes: node ids, `from_node`, `goto`, `annotate` (replace only), `new_game`, `match_start`, `match_stop`, `set_seats`, `set_style`, `board_rev` and `recent`, and a computed `match.live` and `match.to_move`.

It is not the program. It has no `claim_seat`, no `wait`, and no validation beyond what the page's tests need.

`createFakeDesk()` in the same file holds several of those tables as tabs, one selected, with one `rev` for all of them. It speaks the tab wire: frames carry `tab` and `tabs`, a view's game intent must name its tab (missing is `bad_input`, an unknown one `unknown_tab`), an AI's intent lands on the selected tab, and it takes `tab_select`, `tab_new` (refused with `tab_limit` at 12), `tab_rename` (names cleaned as the program cleans them; the same name sends no frame) and `tab_close`. Marks are always `null`.

`deskProgram(n)` in `fake-program.mjs` puts `n` pages on a desk over in-memory sockets. `pump()` applies every sent intent, frame first, then the ack, as the program does. The pages' timers wait until a test calls `runSoon()`, which runs the zero-delay ones.

## The interaction fakes

`makeWorld(pieces, opts)` in `interact.test.mjs` builds a fake view, board, piece layer, store and actions. The screen is 800 by 800 pixels, with 100 pixel squares and a8 at the top left.

- `pieces` maps squares to pieces, for example `{ e2: { color: 'white', role: 'pawn' } }`.
- `opts.legal` lists the legal targets for each square, for example `{ e2: ['e3', 'e4'] }`. It drives both `select` and `attemptMove`.
- `opts.reject` lists UCI moves that `attemptMove` refuses even when they are in `legal`.
- `opts.promote` lists UCI moves for which `attemptMove` reports a promotion.
- `opts.viewMode` starts the store in `'2d'` or `'3d'`.

A stand-in for OrbitControls' own `pointerdown` listener is registered before the interaction, so the tests can see whether a press reached the controls.

## Checking piece shapes by number

The pieces cannot be looked at from a test, so "does it look like a bishop" is checked numerically. `radiusProfile()` in `pieces-profiles.test.mjs` walks every triangle edge and records the widest radius in each height band. Every pair of roles must differ by a minimum mean and peak distance between those curves. `asciiSilhouette()` prints a side view of each role to the test log, so a reviewer can read the shapes.

## Chess960 castling onto the rook's square

In Chess960, when the king is already on its castling destination or one empty square from it, core writes the castling move as the king taking its own rook. The move's `to` is then the rook's starting square, which is empty afterwards. The piece layer must keep the king mesh and slide the rook, rather than fade the king out and build a new one. `pieces-profiles.test.mjs` checks every shape of this case.

## The engine tests

The Stockfish glue is CommonJS, but the web package is `"type": "module"`. `uci.test.mjs` copies the glue and its WASM into a folder under the system temp directory with its own `package.json`, and runs it there through Node's CLI mode. A small Worker-like shim passes lines to its stdin and reads its stdout.

`log.events` keeps both directions in one ordered list. `assertQueueSane()` walks it to check the queue invariant: never a second `go` without a `bestmove` in between, and no `position` or `setoption` while a search is still running.
