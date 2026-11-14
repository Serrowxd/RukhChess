# Web board: core, engine, AI and sync

This covers `web/src/core`, `web/src/engine`, `web/src/ai`, `web/src/net`, `web/src/main.js` and `web/build.mjs`. The module boundaries and shared shapes are in [web-contract.md](web-contract.md). This file explains how the pieces work inside and why some choices were made.

## Build

`node build.mjs` bundles `src/main.js` with esbuild into `dist/` (a folder you can host) and also writes `../chessboard.html`, one file you can open by double-click.

- Flags: `--dev` (no minify, inline source map), `--watch` (dev plus rebuild on change), `--no-single`.
- The single file swaps exactly one `<link rel="stylesheet" href="app.css">` and one `<script src="app.js"></script>` in `index.html`. If either tag is missing or doubled, the build fails, so a half-inlined page never ships.
- Stockfish's glue and WASM, the Draco decoder and every modelled piece set go into the single file as `<script type="text/plain">` tags (ids `sf-glue`, `sf-wasm`, `draco-glue`, `draco-wasm`, `set-<name>`). Proxy sets (`*.proxy.glb`) only ship as files in `dist/sets`.
- Inline scripts have `</script` and `<!--` escaped. The escaped bundle is parsed with `node:vm` after escaping, so an escape that lands outside a string literal fails the build instead of corrupting the page.
- `import.meta.url` is defined as `document.baseURI`. An IIFE bundle has no `import.meta`, and DRACOLoader reads it when the module loads.
- Board wood textures ship in the bundle as data URLs and the room HDRI as raw bytes, so the single file needs no extra requests.

### Bundled assets (src/assets/index.js)

The esbuild loaders turn `.jpg` files into data URLs and `.hdr` files into a `Uint8Array`. Only `main.js` imports this module, because the Node test runner cannot import binary files. The modules that use the assets (`scene.js`, `materials.js`) take them through their options and fall back when they are missing.

- `env_study.hdr`: the Room, a study at night rendered in Blender by `blender/room_hdri.py`, 1024x512 RGBE.
- `env_studio.hdr`: the CC0 HDRI "studio_small_01" by Greg Zaal (Poly Haven), as bundled with Blender, 512x256 RGBE.
- `board_*.jpg`: the maple, walnut and frame woods, baked in Blender by `blender/board_textures.py`.

Licences and credits for these files are in `LICENSE-ART.md`.

## Boot order (main.js)

1. Toasts are buffered until the UI is mounted, then replayed.
2. The position comes from a share link first, then the autosave, then a fresh game. A share link is a one-shot import: once it has loaded, the hash is removed, so a reload keeps what was played since. A link pasted into an open tab arrives as `hashchange` and is handled the same way.
3. Three.js: materials, view, board, piece layer. A modelled set loads asynchronously, so the layer starts on Staunton and swaps when the GLB arrives. In 3D the pieces stay hidden for up to 1.5 s waiting for it, then fade in. A failed load falls back to Staunton with a toast.
4. Engine, AI, MCP bridge, UI and `window.chess`. Starting self-play against "AI over MCP" turns the bridge on.
5. Store subscriptions keep the board in step with the state. Any settings change redraws a full frame.
6. `connectRemoteSync` runs last and does nothing unless the page was served by the Rukh program.

`window.__chessboard` is a debug handle and not part of the public API.

## Store (core/store.js)

### Events inside one game change

The order is `game:change`, then `engine:update`, then `position:change`, then `selection:change`. The selection is cleared last because listeners treat "deselected while a promotion is pending" as a cancelled promotion picker. A completed promotion has to deliver its `game:change` first.

### Engine block priming

Whenever the current node changes, the engine block is primed from that node's stored eval, or cleared. Navigating an analysed line shows evals at once. Priming keys on the node, not the FEN: a same-FEN load swaps in a fresh node without an eval, and the eval bar must follow it. A stored PV is only trusted when it replays in the position. Leaving setup without a commit primes again, because the engine blanks its block when setup starts.

`engineLines` writes the top line into the current node's `eval`, never at a lower depth than what is stored, so exports carry engine evals. An optional fifth argument (a FEN) drops lines for a position that is no longer current. Evals schedule an autosave like any annotation.

### Settings

Settings live in `localStorage['chessboard.settings']`, the study in `localStorage['chessboard.study']`. Stored settings are deep-merged over the defaults. A corrupt value (null, a scalar or an array) where the default is a sub-object falls back to that default, because every reader dereferences those sub-objects.

`setSetting` keeps some mirrors in step whatever path was written: `state.ai.provider`, `state.viewMode`, `state.selfPlay.opponent`, and an idle clock's time control. A running or half-played clock never adopts a new time control.

### Loading

`loadFen`, `loadPgn`, `loadStudy` and `loadYaml` return true or false and toast on failure instead of throwing, because `main.js` calls them unguarded at boot. `loadPgn` refuses a "game" with no moves and only placeholder headers: chessops parses prose, a bare FEN or JSON into such a game, and loading it would wipe the study.

### Setup mode

The setup scratch carries the en passant square and both move counters from the current FEN, even though the UI does not show them. Without them, entering setup and committing with no edits would change the position. Every setup edit emits `game:change` with reason `setup`.

### Self-play and the engine

`actions.registerEngine(engine)` hands the store the engine, so self-play can call `engine.setPlayAs(color)`. The store only re-sends the engine's colour when it changes, because re-sending cancels a search in flight. A colour the store never set is never cleared, so a manual "play as" from the engine panel stays. `state.selfPlay.playerSide` is the colour the person is playing; it defaults to the orientation. Both sides stay movable by hand in every opponent mode. For the AI opponent, `selfPlay.awaiting` names the colour that needs a move.

## Clock (core/clock.js)

Pure functions. Each takes `now` in ms and returns a new clock; nothing is mutated and nothing reads the time. The store owns the ticker (200 ms) and mirrors results into `state.clock` so listeners keep a stable object.

- `initial: 0` means untimed: nothing runs, ticks or flags.
- `tick` re-baselines `startedAt` on every call, so a long gap (a throttled background tab) is charged once.
- A move on a paused clock does not burn time but still adds the increment and hands the turn over, or `resume` would charge the wrong player.
- A move that reaches zero flags the mover and earns no increment.
- `start` on a running clock only re-seats the turn.
- Elapsed time is clamped at zero, so a clock that jumps backwards never hands time back.
- A flag stops the clock but leaves the rules alone; `game.status()` still reports the real position.

## Game (core/game.js)

Wraps chessops. chessops square numbers and PGN nodes never leave this file.

### Castling

At the boundary, castling is written king to destination (`e1g1`), in standard and in most of Chess960. Two Chess960 cases cannot be written that way: the king already stands on its destination, or the destination is also a plain one-square king move. There the king-takes-rook form (`e1h1`) is stored instead. `play()` accepts both forms in both variants. chessops only reads king-to-destination when the king moves exactly two squares, so `_parseMove` translates it to king-takes-rook whenever that castling is available.

`engineUci` gives Stockfish what it expects: king to destination in standard, king takes rook with `UCI_Chess960`. `legalMoves` lists plain king moves first, so an ambiguous castling destination dedupes onto them, and in Chess960 also lists the king-takes-rook form.

### Loading

`fromPgn` and `fromJSON` replay every move through the rules. An illegal move is dropped with its subtree and recorded in `game.warnings`; only a bad start position throws. `fromFen` detects Chess960 from the castling rights (a rook off the a or h file, or a king off the e-file) unless a variant is given.

## Study files (core/io.js)

YAML is written through js-yaml's AST (`jsToAst`, `visit`, `present`) so arrows, highlights, evals and bare moves come out in flow style. An optional top-level `headers:` mapping keeps PGN headers such as the players and the result. Placeholder values and the headers `toPgn()` recomputes (SetUp, FEN, Variant) are left out so they cannot drift. The JSON autosave also stores a `cursor` (child indexes from the root) so a restore lands on the same node. `decodeHash` accepts `#fen=`, `#pgn=`, `?`-style pairs and a bare FEN.

## Engine (engine/stockfish.js, engine/uci.js)

Stockfish 19 lite, single-threaded WASM, in a Web Worker. The driver never imports the store; it receives `store` and `actions`.

### Loading the worker

- Single file: the glue and WASM are read from the `sf-glue` and `sf-wasm` tags. A small preamble serves `fetch('inline.wasm')` from the embedded base64 and falls back from `instantiateStreaming` when it fails. The worker URL is `blob:...#inline.wasm`. Never append `,worker`: that marks an Emscripten pthread helper and the single-threaded build then loads nothing.
- Folder build: `vendor/stockfish-19-lite-single.js` with no hash; the glue finds the WASM next to itself.
- Tests pass `opts.createWorker()`.

The worker boots on the next tick so a startup toast reaches a UI mounted right after `createEngine()`. Teardown is one-way: after `dispose()` or a startup failure the worker is terminated and the line router closed, so a late `uciok` or `readyok` can never report a dead engine as available.

### One search at a time

There is at most one `go` in flight. A new request becomes `pending`, replacing any older pending one. A running search is stopped, and the pending one starts when `bestmove` arrives. Two exceptions: a search that is still starting is swapped in `launch()`, and analysis of the same position never interrupts the engine's own move. `ucinewgame` plus `isready` is sent before the first search after a new game, a load, or a mode change.

Analysis requests are debounced by 150 ms, and line pushes to the store are coalesced to every 60 ms; the final push is immediate. Lines for a position the board has left are dropped. Analysis is always full strength; skill and Elo only apply to the engine's own moves.

For a standard game at the board position the engine gets `position fen <start> moves ...`, so it sees repetitions and the fifty-move count. Chess960 and other positions get a bare `position fen`.

### Playing a side

`setPlayAs(color)` makes the engine think whenever it is that colour's turn in Play mode. A request the queue supersedes is retried after 25 ms rather than dropped: being superseded means the queue gave the engine to a newer search, not that the move failed. A move the board rejects is never retried in a loop.

### Scores

Every score the store sees is in White's view. Mate 0 (the side to move is mated) carries `mated: 'white'|'black'`. `parseInfo` truncates a PV at the first token that is not a move rather than filtering, because filtering would splice two different lines into one.

## AI (ai/)

### The packet

`buildPacket` is the text an AI reads about the position; `buildContext` is the same content as an object. Lines beyond the contract appear only when they apply (title, setup mode, recorded continuations, a NAG), so a bare packet matches the contract exactly. Engine lines are included only when their first move is legal in the current position; otherwise they belong to an earlier position. `packet.js` calls the Game only through `state.game`, so it runs against a fake Game in tests.

### Providers

- `packet`: no network. The packet is copied and the reply is pasted into the AI panel.
- `local`: an OpenAI-compatible `POST {localUrl}/chat/completions`, such as llama-server.
- `anthropic`: `POST /v1/messages` straight from the browser, with the `anthropic-dangerous-direct-browser-access` header.

Streaming is on whenever `onToken` is given. `max_tokens` is a ceiling, not a target. Current models think by default and thinking tokens count against it, so a tight cap truncates the visible reply, and the chess block at its end is lost first. The values are 16000 without streaming (to stay under HTTP timeouts) and 64000 with it.

Same-role neighbours in the history are merged and leading assistant turns dropped, because Anthropic wants the first turn to be the user's.

### The chat loop

`ask()` captures the current node when it builds the packet and draws the reply on that node, even if the person moved on while the model was thinking. If that node was deleted, nothing is drawn and a toast says so. The drawing on another node is done by going there and back (`withNodeTarget`), because core only has annotation actions for the current node. The trip restores the selection, but the engine re-primes on each node.

A user turn with no answer after it (cancelled or failed) is dropped from the history. Otherwise it would merge into the next question and be asked again against a different position.

`ask()` returns its own result object, so `window.chess.ask` reports a request dropped because the AI was busy, or cancelled, instead of guessing from state or reporting an older error. `lastError` is cleared at the start of each request for the same reason.

Core's `aiMessage` stores only `{ role, text, at }`. The chat module re-attaches its extra fields (packet, suggested moves, what was applied, provider, model) to the stored message and emits `ai:update` again.

### Reading the chess block

The reply's drawing is the last fenced ` ```chess ` block, or an unclosed one at the end of a truncated reply. Small local models often ignore the tag, so failing that, the last ` ```json ` or untagged block whose body looks like a chess object is used (`tagged: false`). The JSON is read leniently: curly quotes, trailing commas, and `//` or `/* */` comments outside strings are tolerated. Invalid entries are dropped and counted.

### window.chess (ai/api.js)

Every method returns a value or `{ ok: false, error }` and never throws. `help()` lists the methods. Arrows drawn through the API are tagged `source: 'ai'`. `annotate()` reports the entries it rejected; when nothing was applied it returns `ok: false`, so an AI never believes a drawing exists that does not. `goto(n)` resolves a ply on the current path first, then on the main line. The MCP bridge is created on the first `mcp.*` call, so a page that never touches it has no bridge at all.

### MCP bridge (ai/mcpBridge.js)

An optional loopback path: the page posts its position to a separate MCP bridge server (not part of this repo and not shipped; what the page sends and expects is in [web-contract.md](web-contract.md)) on `http://127.0.0.1:8152` and polls it for commands an agent queued. It is a second road to the same actions `window.chess` drives.

- Nothing is created, listened to, fetched or timed until `enable()`, and `disable()` undoes it all.
- It never throws into the app. A dead server is a status (`connected: false`, `lastError`) with exponential backoff from 700 ms to 10 s, not an exception or a stream of toasts.
- A restarted server starts its sequence at 0 again; when the server's sequence goes backwards, the cursor rewinds so new commands are seen.
- Self-play against the AI: the published payload carries `awaiting: 'black'` (or white). That field is the move request. While it is outstanding the position is re-published every 3 s so a late agent still sees it.
- Every ambient dependency (fetch, timers, clock) can be injected, so tests run with no network or timers.
- The bridge emits `mcp:change` on the store.

## Sync with the Rukh program (net/remoteSync.js)

When the page is served by the Rukh program, it follows the program's game. The page keeps its own JS game, this module mirrors the program's game into it, and it sends the moves, navigation and annotation edits made here back to the program. It also carries the match (seats, style) and presence for the play control.

It is active only when `GET api/hello` answers as Rukh. On `file://` nothing is fetched; on any other host one probe is made and nothing follows.

### Wire format (JSON text on api/ws)

Server to page:

```
{"t":"hello","proto":1,"instance":"..","you":"view:3"}
{"t":"state","instance":"..","rev":7,"hint":{..},"state":{"game_id","board_rev","recent",
  "game":<rukh_core::Snapshot>,"study","match":{active,seats,tip,live,to_move,style},"clock"}}
{"t":"ack","id":4,"ok":true,"rev":7} | {"t":"ack","id":4,"ok":false,"error":{"code","message"}}
{"t":"presence","views":2,"ais":[{"name","transport","seat","waiting","idle_s"}]}
```

Page to server:

```
{"t":"intent","id":4,"op":"play","move":"Nf3","from_node":11,"from_fen":".."}
{"t":"intent","id":5,"op":"goto","node":3}
{"t":"intent","id":6,"op":"annotate","node":3,"mode":"replace","note","nag","arrows","highlights"}
{"t":"intent","id":7,"op":"new_game","fen":"<optional>"}
{"t":"intent","id":8,"op":"match_start","seats":{"white","black"},"style":".."}
{"t":"intent","id":9,"op":"match_stop"} | {"op":"set_seats","white","black"} | {"op":"set_style","style"}
```

`from_fen` is still sent beside `from_node`; the program ignores it.

### Remote mode

The program owns the autosave, self-play, the clock and the loopback MCP bridge while connected, so those actions are replaced on the shared actions object. Every caller looks actions up at call time, so the replacement takes.

### Following frames

A frame replaces the last one when it comes from another program start or has a higher rev. The page is brought to the latest frame in the gentlest step that gets there: nothing if the signatures already match, then playing the one move ahead (so it animates), then a plain goto to a node the page already holds, then copying the current node's annotations in place, and only then a full reload of the study.

The tree signature compares positions by FEN rather than UCI, because the page and the program write Chess960 castling differently. Evaluations are left out: the page's own engine writes them and they must not force a reload. The variant is part of the signature, so Chess960 position 518 does not pass for a standard game.

Frames are not applied while our own intents are in flight (their frames would briefly undo the page; the last ack catches up) or while the person is in setup mode.

### The echo guard

Changes this module makes to the store are wrapped in a depth counter. Store events fire synchronously inside the action, so a change made under the guard is never sent back to the program, and two tabs cannot ping-pong.

### Outgoing intents

`intentsForChange(change)` is pure. `onGameChange` builds its `change` argument from the store event:

- `reason`: the `game:change` reason (`move`, `goto`, `new`, `load`, ...).
- `echo`: true while the echo guard is active; nothing is sent.
- `mode`: the store's mode.
- `fromFen`: the FEN before the change.
- `move`: `{ san, uci }` of the move just played, for `move` only.
- `startFen`: the game's start position.
- `mainline`: the main-line moves, for `load` only.
- `fromNode`, `toNode`: the program's node ids for the page's cursor before and after, looked up in the latest frame.
- `tip`: the tip node of a running match, or null.

- A move sends `play`. A move the program already holds (stepping back and replaying it) is sent as `goto` instead, except from the tip of a running match, where it must move the tip.
- Navigation is sent as one `goto` to the node now shown, batched in a microtask, so back, forward, start, end and a move-list click land on the same node in every view.
- Notes and drawings send `annotate` with `mode: 'replace'` for the shown node.
- A loaded game sends `new_game` and the main-line moves. Variations and notes of a loaded game are not shared yet.
- Program node ids are looked up from the page's cursor in the latest frame and must match the FEN, so a page whose tree has drifted names no node rather than a wrong one.

### Acks

At most one refusal is shown per batch of intents in flight. A `stale` refusal is not shown when the page already holds exactly what the program holds. An accepted intent whose parts were left out (too long, too many arrows) is reported too, or the edit would silently disappear on the next frame. Whatever the outcome, the program's latest frame is the truth.

Intents in flight are never resent after a disconnect. Reconnects back off from 250 ms to 15 s.
