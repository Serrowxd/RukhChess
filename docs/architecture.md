# Rukh executable: architecture and build path

Status: the original design plan (2026-11-13), since partly built. It is kept as a record of the plan; where it and the code disagree (flag names, file names, steps), the code wins. [program.md](program.md) and [core.md](core.md) describe what exists. Crate versions were compiled in throwaway probes on Windows only. Items nobody has checked are marked UNVERIFIED.

## 0. What this is

One program, `rukh`, owns one chess game. The Three.js board in `web/` is a view of that game. Every browser tab or window shows the same game. Any AI client joins over MCP, served by the same program. The same Rust core, compiled to WebAssembly, runs the board with no server for a hosted demo.

Rules that shape everything else:

- One game, one writer. Views and AI clients send intents and receive full state.
- Nothing about "whose move the AI owes" is ever stored or published. It is computed from the position.
- The non-commercial art never enters the binary. The program runs without it.
- `cargo run -p rukh` needs only Rust. Node is needed only to change the 3D board.

## 1. Workspace

```
crates/rukh-core     exists. Pure: no tokio, no clock reads, no I/O. Native + wasm32-unknown-unknown.
  src/lib.rs         Game (today) + additions in section 4
  src/chess960.rs    exists
  src/intent.rs      NEW  enum Intent  (#[serde(tag = "op", rename_all = "snake_case")])
  src/session.rs     NEW  Session = Game + study meta + match (seats, tip, style, time control) + clock
  src/table.rs       NEW  Table = Session + rev + board_rev + recent. Produces the frame JSON.
  src/clock.rs       NEW  port of web/src/core/clock.js, time passed in
  src/pgn.rs         NEW  export, then import
crates/rukh          NEW  binary "rukh". Everything tokio lives here.
  main.rs            plain fn main: build runtime, spawn server, park main thread on a UiCommand channel
  cli.rs             (none) = run the app; `mcp` = stdio pump; `mcp-config` = print client snippets;
                     flags --port --art-dir --no-open
  hub.rs             Mutex<Table> + watch channel + instance id. The only writer.
  http.rs            axum Router + Host/Origin guard
  ws.rs              /api/ws
  mcp.rs             rmcp handler: tools, prompts, instructions
  pipe.rs            loopback TCP listener for stdio launches; the byte pump used by `rukh mcp`
  instance.rs        instance.json, /api/hello probe, single-instance logic, detached spawn
  engine.rs          broker for engine requests to the engine-host page
  presence.rs        views and AI clients
  assets.rs          embedded web app, art folder lookup
  settings.rs        settings.json, session.json, per-OS paths
  window.rs          wry + tao, behind cargo feature "window"
  build.rs           art guard (section 9)
crates/rukh-wasm     NEW, late. cdylib, depends only on rukh-core. Raw C ABI, no wasm-bindgen:
                     rukh_alloc, rukh_free, rukh_new, rukh_apply(handle, ptr, len, now_ms),
                     rukh_frame(handle, now_ms), rukh_next_deadline(handle). JSON in, JSON out.
```

Core API that both transports call (this is the whole surface):

```rust
Table::apply(&mut self, by: &str, intent_json: &str, now_ms: u64) -> Result<Applied, Error>
    // Applied { frame_json: String, result_json: String }
Table::frame(&self, now_ms: u64) -> String
Table::next_deadline_ms(&self) -> Option<u64>      // when the running clock flags
Table::to_json(&self) -> String / Table::from_json  // saved file, includes rev and board_rev
```

Frame production lives in the core so the program and the WebAssembly page cannot drift apart. `hub.rs` adds only `instance` and presence.

Dependencies of `crates/rukh`: rmcp 3.10.0 features `["server","macros","transport-io","transport-streamable-http-server"]` (never `local`); tokio 1 (rt-multi-thread, macros, net, sync, time, io-std, io-util, signal); axum 0.8.9, default-features off, features `["http1","tokio","ws","json","query"]`; tower-http 0.7.1 feature `fs`; rust-embed 8.14.0 with `interpolate-folder-path`; webbrowser 1.2.7; schemars 1; serde 1; serde_json 1; tokio-util 0.7; optional wry 0.57.2 + tao 0.37.2. MSRV 1.88. Edition 2021. Cargo.lock is committed (rmcp releases weekly).

## 2. Single source of truth

`Hub::apply(by, intent, intent_id)` takes the lock, calls `Table::apply`, sends the new frame into a `tokio::sync::watch`, releases. Nothing is awaited under the lock. Views, MCP tools, the engine broker and the clock timer all go through it.

### Counters

- `rev`: +1 on every state change of any kind. Used only so a receiver can drop old frames. A receiver applies a frame if `instance` differs or `rev` is higher. Frames are full state, so skipping or repeating one is harmless.
- `board_rev`: +1 only for things a person or AI did to the board: a move, new game or load, and notes, arrows, highlights and navigation made from a view. Engine evaluations, clock events, seat changes and an AI's own notes do not bump it. Used only by `wait(for: any_change)`.
- `recent`: the last 16 board changes, `{board_rev, by, reason, node, san?}`. Serves the coach's "what happened since" and the skip-my-own-changes rule.
- `game_id`: +1 on new game, load, setup commit.
- `instance`: random per program start. `rev` and `board_rev` are saved in session.json and continue after a restart.
- Presence is not state and bumps nothing.

Moves are guarded by position, never by `rev`: a play carries `from_node`, and is refused as `stale` only if that is not the node the move would be played from. An evaluation landing between "saw the position" and "played" therefore refuses nothing.

### Server to view (JSON text on /api/ws)

```json
{"t":"hello","proto":1,"instance":"9f2c","you":"view:3",
 "app":{"version":"0.1.0","link":"http://127.0.0.1:47474/","open_in":"browser",
        "art":{"available":true,"sets":["classic","cairn"],"wood":true,"env":true}}}

{"t":"state","instance":"9f2c","rev":42,"now_ms":1731500000000,
 "hint":{"reason":"move","by":"view:3","intent_id":17},
 "state":{
   "game_id":3,"board_rev":18,
   "recent":[{"board_rev":18,"by":"view:3","reason":"move","node":12,"san":"e4"}],
   "game":{ "...rukh_core::Snapshot..." },
   "study":{"title":"","notes":"","created":"..."},
   "match":{"active":true,"seats":{"white":"human","black":"ai"},"tip":12,"live":true,
            "to_move":"ai","style":"annotate","time_control":null},
   "clock":null
 }}

{"t":"ack","id":17,"ok":true,"rev":42,"result":{}}
{"t":"ack","id":17,"ok":false,"error":{"code":"illegal|stale|bad_input|game_over","message":"..."}}
{"t":"presence","views":2,"engine_host":true,
 "ais":[{"name":"claude-code","transport":"stdio","seat":"black","waiting":true,"idle_s":3}]}
{"t":"engine_request","id":5,"node":12,"start_fen":"..","moves":["e2e4"],"chess960":false,
 "depth":18,"movetime_ms":null,"multipv":1}
{"t":"engine_cancel","id":5}
```

`clock` when timed: `{"white_ms":..,"black_ms":..,"running":"white"|null,"as_of_ms":..,"flagged":null}`.

`hint` is only a hint, because `watch` keeps the latest frame and a slow tab may skip some. The page decides what to do by comparing old and new state: `game_id` changed means a new game (engine gets `ucinewgame`); the current node changed to a child of the old current node means "animate this move".

Each socket has one writer loop: write the latest watch frame, then any queued acks whose `rev` is not above that frame. So when a page's promise resolves, its read model already shows the result.

### View to server

```json
{"t":"hello","engine":true}
{"t":"focus","visible":true,"focused":true}
{"t":"intent","id":17,"op":"play","move":"e2e4","from_node":11}
{"t":"engine_result","id":5,"ok":true,"depth":18,"cp":35,"mate":null,"best":"e2e4",
 "lines":[{"cp":35,"pv":["e2e4","e7e5"]}]}
```

Intent ops, the whole vocabulary: `play{move,from_node,note?,nag?,arrows?,highlights?}`, `play_line{moves[],from_node}`, `goto{node}`, `back`, `forward`, `to_start`, `to_end`, `next_variation`, `prev_variation`, `promote_variation{node}`, `make_mainline{node}`, `delete_from{node}`, `annotate{node,note?,nag?,arrows?,highlights?,mode:"add"|"replace"|"clear"}`, `toggle_arrow{node,arrow}`, `toggle_highlight{node,square,color}`, `set_eval{node,eval}`, `new_game{fen?,chess960?}`, `load{format:"fen"|"json"|"pgn",text}` (pgn from step 11), `set_study{title?,notes?}`, `match_start{seats,style?,time_control?}`, `match_stop`, `set_seats{white,black}`, `set_style{style}`, `clock_pause`, `clock_resume`, `clock_reset`, `flag{color}` (program only).

Every annotation op takes a node id and never moves the cursor. A view never resends an intent after a reconnect; pending ones are rejected locally.

### Why an AI cannot be woken by its own move

`match.to_move` is computed inside `Table::frame` from the same locked state as the position: `seats[turn at tip]` when the match is active, no outcome, not flagged; else null. `wait` tests "to_move is ai, and the side to move is my seat" on one frame. The frame made by the AI's own move has the other colour to move, so the test is false in that frame and every later one until the other side moves. There is no second message that could arrive late.

### Persistence

`Table::to_json` is written to `session.json` (temp file + rename) synchronously on every move, new game or load, and debounced 1 s for notes and evaluations. Restored at start.

## 3. The page

### Seam

`web/src/core/backend/`:

- `gameView.js`: `class GameView`, built once per frame from `state.game`. Synchronous read model with the members the readers already use: `fen() turn() status() variant chess960Number startFen headers root current node(id) path() mainline() isOnMainline(id) pieces() pieceAt(sq) legalMoves() legalTargets(from) isLegal(m) uciToMove sanToMove moveToSan pvToSan(pv) hasMoves() toPgn() toJSON()`, and nodes re-linked as `{id,parentId,children:[objects],ply,san,uci,move:{from,to,promotion},fen,check,checkmate,captured,note,nag,arrows,highlights,eval}`. Status is mapped to camelCase. Node ids are numbers; DOM datasets stringify them and actions convert back.
- `remote.js`: `RemoteBackend`. WebSocket to `api/ws`, reconnect backoff 250 ms to 2 s, `apply(intent) -> Promise`, `onFrame`, `onPresence`, engine request relay.
- `wasm.js`: `WasmBackend` (late). Loads `rukh_core.wasm`, same interface; saves to localStorage; drives the clock with `Date.now()` and `rukh_next_deadline`.
- `localJs.js`: temporary `LocalJsBackend` wrapping the existing JS `Game`, emitting frames in the Rust shape. Deleted when `WasmBackend` lands.
- `pv.js`: `pvToSan(fen, uciList, chess960)` on chessops. Live engine lines need SAN many times a second; this is the one place chessops stays in the bundle.

Boot: `fetch("api/hello")` answers as Rukh, use `RemoteBackend`; otherwise the local backend. One bundle serves the program and the static demo.

Until `pgn.rs` exists (step 11), `core/game.js` and `core/io.js` stay as a page-side codec: import parses in JS and sends `load{format:"json"}`; `GameView.toPgn()` is `Game.fromJSON(frame tree).toPgn()`. YAML stays page-side for good: `io.js` keeps `studyToYaml/studyFromYaml`, converting to and from the core's JSON, and js-yaml stays a dependency.

### Files that change

- `core/store.js`: `createStore({backend})`. `state.game` is the `GameView`. One `onFrame` replaces `afterGameChange`. Event mapping, decided by comparing old and new state:
  - current node, FEN or tree shape changed: `game:change` (reason from the diff, hint as tiebreak), then `engine:update`, then `position:change` if the FEN changed, then `selection:change`.
  - only notes, arrows or highlights changed: `annotations:change` (plus `game:change` reason `note` for note and nag, as today).
  - only an evaluation changed: `engine:update` only. Never `game:change`, because `three/interact.js:820` cancels a drag on it.
  - `pendingMove` flag between sending a play and its frame or ack; `attemptMove` returns `'illegal'` while it is set.
  - Removed from the store: study autosave/restore, the clock ticker, self-play awaiting/playerSide/delegation. `state.match`, `state.clock`, `state.presence` mirror the frame. The clock display interpolates from `as_of_ms`.
- `main.js`: boot is "connect, await first frame"; pagehide autosave removed; URL-hash import becomes a load intent; art and environment fetched at run time; mcpBridge wiring removed.
- `engine/stockfish.js`: runs only when this view is the engine host; writes the final result of each search with `set_eval`; answers `engine_request` straight from the `bestmove` handler; plays an `engine` seat.
- `ai/api.js`, `ai/chat.js`: play, goto and load helpers become async and await the ack. `withNodeTarget` deleted. `window.chess` calls now return promises; note it in `docs/AI.md`.
- `ui/selfPlayPanel.js` (seats, style, start/stop), `ui/clock.js`, `ui/topbar.js` (AI chip), `ui/ioPanel.js`, `ui/enginePanel.js` (`play_line`), `ui/notesPanel.js` (node-addressed), `ui/settingsPanel.js` (open-in setting, link, Connect an AI, Quit).
- `three/modeledSets.js:47` fetch path becomes `art/sets/`. `three/scene.js` gets one late setter `view.setAssets` that re-runs the environment choice, and falls back to `studio`, not `plain`, when `room` is unavailable. `assets/index.js` imports no image or HDR.
- `web/build.mjs`: section 9.

Deleted at the end: `ai/mcpBridge.js`, `core/game.js`, `core/chess960.js`, the PGN/JSON half of `core/io.js`.

Unchanged: `three/pieceLayer.js`, `three/board.js`, `three/pieces.js`, `three/materials.js`, `three/interact.js`, `ui/moveList.js`, `ui/layout.js`, `ui/dialogs.js`, `ai/packet.js`, `ai/prompt.js`, `engine/uci.js`.

### Synchronous call sites

- `interact.js:542 attemptMove` stays synchronous: legality from the snapshot's legal moves, returns `'played' | 'promotion' | 'illegal'`, sends the intent. If the program refuses, the next frame puts the piece back and a toast says why.
- `playMove` returns a provisional `{san,uci,fen,ply}` from the matching legal move (the core adds `fen` to `LegalMove`), so truthiness checks keep working. Callers that need the node id await the ack.
- `newChess960`: the page picks the number and sends it, so it can still return it.
- `load*` return `Promise<boolean>`; `setupCommit` rejects instead of throwing. The setup scratch board stays per window and commits as a FEN.
- `playLineUpTo` uses one `play_line` intent.

### Tests

A static count found 318 tests; an earlier count said 322. UNVERIFIED which is right. Rule for every step: `npm test` and `cargo test --workspace` pass before the step is done.

- Unchanged: interact 47, piece-layer 15, view-modes 38, board-mapping 6, pieces-profiles 37 (one Game use becomes a piece list), uci 49, packet 29 (only the createApi cases become async).
- Rewritten: core-store 36, against a fake backend. New: gameView tests on a snapshot fixture written by `cargo test`; "an eval frame during a drag emits no game:change".
- Ported to Rust, then deleted from JS: core-game 21, core-chess960 7, core-clock 13, the PGN/JSON cases of core-io 9. The YAML cases of core-io stay.
- Retired: mcp-bridge 11; its cases become Rust tests of hub and wait.

## 4. What the core still needs, in order

- C1 (step 2): `intent.rs`, `session.rs`, `table.rs`. Seats, tip, style (normalised to silent|annotate|coach, junk becomes annotate), counters, `recent`, annotate with add/replace/clear and validation (squares, colours, the six NAGs, a `rejected` list; arrows appended and tagged with their source, highlights merged by square, a non-empty note replaces).
- C2 (step 5): `Node.from` / `Node.to` (king's start and destination squares for castling in both variants); `LegalMove.fen`; headers; `next_variation`, `prev_variation`, `make_mainline`; `Table::to_json/from_json` keeping node ids; study title and notes.
- C3 (step 9): `Eval.pv_san` and `best_san`, filled in `set_eval` by replaying the PV from the node.
- C4 (step 10): `clock.rs` and the clock intents.
- C5 (step 11): `pgn.rs`, export then import with variations, comments, NAGs and drawings. Parser choice (a crate or hand-written) UNVERIFIED.
- Setup mode needs nothing new: the scratch board commits through `Game::from_fen`.
- Not ported: YAML (page-side), the text packet (the page keeps `ai/packet.js` for its own chat; MCP returns structured positions).

## 5. The engine

Stockfish stays in the page (`stockfish-19-lite-single` in a Worker; single thread, so no special headers).

- The program elects one engine host among views that sent `hello{engine:true}`: the most recently focused visible view, with the dedicated window preferred. It re-elects on focus change and disconnect. Only the host runs Stockfish. Other views show the stored evaluation.
- `evaluate` over MCP: `engine.rs` sends `engine_request` to the host, the page runs `position fen <start> moves ...` and `go`, replies `engine_result`, the hub applies `set_eval` on that node, the tool returns. Bounds: depth at most 24, movetime at most 10 s, tool deadline 30 s, then `engine_cancel`.
- With no page open there is no engine. `evaluate` returns the node's stored evaluation if it has one (`source: "stored"`), otherwise a readable tool error: "No board is open, so there is no engine. Call open_board and try again." This narrows "evaluations available over MCP" to "while a board is open". The way out later is a second provider in `engine.rs` pointing at a UCI binary the person installed; the request shape does not change.
- UNVERIFIED: how hard a hidden browser tab is throttled. Election by focus is the mitigation.

## 6. MCP

### Transports

- HTTP: rmcp `StreamableHttpService` at `Router::nest_service("/mcp", ..)` on the same port. `with_allowed_origins(own origins)` because rmcp's Origin check is off by default. Session keep-alive left at its default (300 s); waits are capped below it.
- stdio: `rukh mcp` is always a byte pump and never the app.
  1. Find the running instance (section 8). If none, start `rukh --no-open` as a detached process (Windows: `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`, trying `CREATE_BREAKAWAY_FROM_JOB` first and retrying without it; Unix: new session), then wait for it to answer.
  2. Connect to `127.0.0.1:<pipe_port>`, send `RUKH-PIPE <token>\n`, then copy stdin to the socket and the socket to stdout. Exit with `std::process::exit` when either side closes.
  3. In the app, `pipe.rs` reads the token line byte by byte (cap 128 bytes, so no buffered bytes are lost), then spawns `handler.serve(stream)` for that connection. Anything without the token is dropped.
  The app itself never writes MCP to its own stdout. On a `proto` mismatch between pump and app, the pump prints a readable error to stderr and exits non-zero.
- UNVERIFIED: whether each client kills the whole process tree of the server it launched. If one does and the breakaway is refused, the app dies with the client; the game is already saved, and the README says to run Rukh yourself first.

### Tools

Failures a model should read are `CallToolResult::error(text)`. Results are `CallToolResult::structured(value)` plus one short prose line. Every game-describing result carries `node`, `board_rev` and `views` (number of open boards; when 0 the prose adds "No board is open; call open_board").

The position body, used by several tools: `{node, fen, turn, ply, move_number, line, last_move{san,uci}, status{text,outcome,reason,check}, legal_moves[san], clock, seats, to_move, your_seat, style{name,rule}, note, nag, arrows, highlights, path[{node,ply,san}], eval?, board_rev, views}`.

| Tool | Parameters | Returns |
|---|---|---|
| `get_game` | `detail?: "position"\|"tree"` | position body, or every node |
| `wait` | `seat?: "white"\|"black"`, `for?: "my_turn"\|"any_change"`, `since?: int`, `timeout_s?: 1..240` (default 45) | `{event, ...}` see below |
| `play` | `move`, `from_node?`, `note?`, `nag?`, `arrows?[{from,to,color}]`, `highlights?[{square,color}]` | `{node, san, uci, fen, turn, status, board_rev, views}` |
| `annotate` | `node?`, `note?`, `nag?`, `arrows?`, `highlights?`, `mode?: "add"\|"replace"\|"clear"` | `{node, applied{arrows,highlights,note,nag}, rejected[]}` |
| `navigate` | `to: "back"\|"forward"\|"start"\|"end"\|"tip"\|node id` | `{node, fen, turn, ply, live}` |
| `evaluate` | `node?`, `depth?`, `movetime_ms?`, `multipv?: 1..5` | `{node, fen, depth, eval, cp\|mate, best{san,uci}, lines[{n,eval,san[],uci[]}], source}` |
| `new_game` | `fen?`, `chess960?: 0..959\|"random"`, `ai_seat?: "white"\|"black"\|"none"`, `confirm?: bool` | `{node, fen, turn, variant, chess960_number}` |
| `open_board` | none | `{url, opened}` |

`wait` behaviour:

- `for: "my_turn"` (default) is level-triggered and ignores `since`. It returns at once if it is the caller's turn now, so an agent that forgot to move is simply told again. Otherwise it blocks on the watch channel.
- Passing `seat` claims that seat if the person has not assigned it. If no match is active, the claim starts one: the other seat is human, tip is the current node, untimed, current style. The result text says so. If the person gave the AI the other colour, `wait` returns an error naming it. With no `seat` and no match, it returns an error saying to pass `seat`.
- `for: "any_change"` returns when `recent` holds a change with `board_rev > since` that was not made by the caller. Without `since`, or with `since` above the current `board_rev`, it waits for the next one from now. The body includes those `recent` entries as `since_last`.
- Events: `your_turn`, `changed`, `game_over`, `flag` (carry the position body), and `timeout`, which is one line: `{event:"timeout", board_rev}`.
- Sends a progress notification every 10 s when the client gave a progress token. Returns on cancellation.

`play` behaviour: SAN or UCI; leading move numbers and trailing `!`/`?` are stripped. During an active match the move is always applied at `match.tip` (the session goes to tip and plays in one apply), and is refused as `not_your_turn` unless the side to move at tip is an AI seat. `from_node`, if given, must equal the node the move is applied to, else `stale` with the current node and last move. With no match, it plays from the current node for either side. Move and annotations land in one state change. Errors: `illegal` (with side to move and legal SAN list), `stale`, `game_over`, `not_your_turn`.

`new_game` needs `confirm: true` when the current game has moves; the error says to ask the person first.

Tool descriptions (the doc comments; this is the text a model is sure to see):

- `get_game`: "Read the game on the Rukh board: position, legal moves, seats, the style rule you must follow, and the notes and arrows on the current move. detail=tree returns every move with its variations."
- `wait`: "Block until it is your turn. To play a game, loop: call wait(seat), then call play, then call wait again. event=timeout is normal and means nobody has moved yet: call wait again. event=game_over or flag means stop and tell the person the result. The result contains the position and style.rule, which you must follow. Use for=any_change with since=<board_rev> to be told about anything the person does (coaching)."
- `play`: "Play a move for the side you hold, in SAN (Nf3) or UCI (g1f3). Optionally attach a note, a glyph and arrows to the move in the same call; follow style.rule for whether to do so. Choose the move by your own judgement."
- `annotate`: "Add a note, glyph, arrows or highlights to a move without moving the board. Defaults to the current move. Everyone looking at the board sees it."
- `navigate`: "Move the board to another point in the game. This changes what every viewer sees and pauses a live game until someone returns with to=tip."
- `evaluate`: "Ask the chess engine for an evaluation of a position (White's point of view). Needs a board to be open."
- `new_game`: "Start a new game, optionally from a FEN or a Chess960 number, optionally taking a seat. Discards the current game: ask the person first and pass confirm=true."
- `open_board`: "Open the board for the person and return its link."

### Prompts and instructions

Prompts (rmcp `#[prompt_router]`, stacked with `#[tool_handler]` on one impl):

- `play {side?}`: the play loop in three sentences.
- `review {level?}`: the same loop with `for=any_change`, plus guidance for annotate, evaluate and navigate. Named `review` so that "coach" means only the style.

Server instructions: the loop in two sentences; "the board owns the style; read style.name and style.rule in each result"; then the three rules verbatim from the style contract in `docs/web-contract.md` (silent, annotate, coach). `style.rule` rides in every `wait` and `get_game` result, so a client that shows neither instructions nor prompts still gets it.

### Presence

Client name comes from `RequestContext<RoleServer>::client_info()` in every tool (rmcp 3.10.0 `src/service.rs:1268`), which works for stateless HTTP and for stdio. Pipe connections are present while their service runs. HTTP clients are present if seen in the last 90 s or inside a `wait`. Each entry: `{name, transport, seat, waiting, idle_s}`.

Every window shows one chip in the top bar: "No AI connected", "<name> connected", "<name> is waiting for your move", or "<name> to move". The play panel shows the same beside the seat control.

## 7. Seats and turns

`match.seats = {white, black}`, each `"human" | "ai" | "engine"`. Default: both human, `active: false`. That is the analysis board: anyone moves anything, no clock.

- From the page: "You play: White / Black", "Opponent: Nobody / AI / Engine", Start. Start sends `match_start`. Board orientation is never read; a window may flip to the person's side as a courtesy.
- From an AI: `wait(seat)` or `new_game(ai_seat)`, as in section 6.
- `match.tip` is the end of the game being played. A move played from tip moves tip. Navigating away makes `live: false` and `to_move: null`, and the page shows "browsing, return to game". Deleting a branch that holds tip moves tip to the branch's parent. New game or load stops the match.
- An MCP `play` is refused out of turn during a match. Views may move either side by hand; a hand move on the AI's side is just a move, and the AI sees it.
- No takeback. The old board never had one; it is added when its rules are defined.

## 8. Opening the board

- Data folder (hand-rolled, no crate): Windows `%LOCALAPPDATA%\Rukh`; macOS `~/Library/Application Support/Rukh`; Linux `$XDG_DATA_HOME/rukh` or `~/.local/share/rukh` (as in [program.md](program.md) and `default_data_dir` in `open.rs`). Files: `settings.json`, `session.json`, `instance.json`. All written temp file + rename.
- `settings.json`: `{"open_in":"browser"|"window","port":47474,"open_on_start":true,"art_dir":null,"page":{...}}`. `page` holds the board's own settings object (theme, piece set, lighting), so the browser, the dedicated window and any other origin look the same. localStorage keeps only the in-page chat key, and everything in the serverless demo. On first connect, if the session is new and the page still holds an old `chessboard.study`, it offers once to load it.
- Routes: `GET /api/hello` -> `{app:"rukh", version, proto, instance, port, pipe_port, link}`; `GET /api/ws`; `GET`/`POST /api/settings`; `POST /api/open {in?}`; `POST /api/quit`; `GET /api/mcp-config`; `/mcp`; `/art/*`; everything else from the embedded app.
- The link is `http://127.0.0.1:<port>/`, no token. It is printed at start, returned by `/api/hello` and `open_board`, and shown in the settings panel with a Copy button.
- Port: default 47474, bound on `127.0.0.1`. (Below the Windows dynamic range; IANA status UNVERIFIED.) If the bind fails and the occupant answers `/api/hello` as Rukh, this launch is a second launch and never starts another app. Only a non-Rukh occupant leads to port 0, with the real port in `instance.json`.
- Start order in the winner: bind HTTP, bind pipe, write `instance.json` (`{port, pipe_port, pid, instance, proto, token}`, 0600 on Unix), then accept. A later launch that sees Rukh on the port retries reading `instance.json` (50 ms backoff, 3 s cap) until its instance id matches hello's.
- Second launch by double-click: asks the running instance to open the board (`POST /api/open`), then exits. Second launch as `rukh mcp`: pump.
- Lifetime, one rule for every mode: the program exits after 10 minutes with no view and no MCP connection, or on Quit in the page, or on Ctrl+C. Nothing is lost.
- Connect an AI: a panel in the page and `rukh mcp-config` on the console show copy-ready snippets built from `std::env::current_exe()`: the Claude Desktop JSON block, `claude mcp add rukh -- <path> mcp`, the Cursor and LM Studio `mcp.json` block, and the HTTP URL. The stdio form is the primary one. (UNVERIFIED: a URL connector added in Claude Desktop's settings may be called from outside the machine and so cannot reach 127.0.0.1.)
- Dedicated window: `main()` always parks the main thread on `std::sync::mpsc<UiCommand>`. The first `OpenWindow` creates the tao event loop on that thread and stays in it; later opens go through `EventLoopProxy`. Closing the window does not exit. This is what lets `open_board` or "Open in a window now" work in a process that started in browser mode on macOS. `window` is an opt-in cargo feature on every OS, turned on for the Windows and macOS release builds. Without it, or if `wry::webview_version()` fails, "window" falls back to the browser and says so. macOS and Linux window behaviour UNVERIFIED.

## 9. Assets and the art split

Embedded (GPL-compatible only):

- `crates/rukh/webdist/` (committed): `index.html`, `app.js`, `app.css`, `env/env_studio.hdr` (CC0), `fonts/*.woff2` + `fonts/OFL.txt` (the three font families the page uses today, replacing the Google Fonts link; OFL status of each UNVERIFIED), `vendor/draco/*`.
- `web/vendor/` embedded from where it lives (second rust-embed folder): Stockfish js, wasm and licence.

Never embedded, a top-level `art/` folder holding everything CC BY-NC-SA:

```
art/sets/{classic,menagerie,cairn,beton,estate}.glb     moved from web/sets
art/wood/{board_maple,board_walnut,board_frame}.jpg     moved from web/src/assets
art/env/env_study.hdr                                   moved from web/src/assets
art/LICENSE-ART.md                                      marker file, plus the CC licence text
```

Served read-only at `/art/` by `tower_http::services::ServeDir`. Lookup order: `--art-dir`, `RUKH_ART_DIR`, `settings.art_dir`, `<exe dir>/art`, `<exe dir>/../Resources/art` (macOS bundle), and in debug builds only, up to three parent folders of the exe (so `target/debug/rukh` finds the checkout). A folder is accepted only if it contains `LICENSE-ART.md`. The result is listed once at start and reported in `hello.app.art`.

The page fetches `env/env_studio.hdr`, then `art/wood/*` and `art/env/env_study.hdr` after first paint. A 404 falls through silently. With no art: the built-in procedural pieces, procedural wood grain, the CC0 studio environment; the set picker lists only sets named in `hello.app.art.sets`; wood and room options are hidden. The static demo uses the same files with `art/` beside `index.html`.

Enforcement, so a local build cannot leak art either:

- `web/build.mjs`: `copySets` stops copying GLBs (Draco files only); `writeSingleFile` is removed from the default and watch paths; `.jpg` and `.hdr` leave the loader map; new `--out <dir>` flag.
- `.gitignore` gains `chessboard.html`.
- `crates/rukh/build.rs` fails the compile if `webdist` holds any file outside the allow-list above, or if `app.js` contains `Z2xURg` (base64 of "glTF"), `Iz9SQURJQU5D` (base64 of "#?RADIANCE"), or `data:image/jpeg`. CI runs the same check.
- Step 4 also updates the paths in `LICENSE-ART.md`, `NOTICE.md` and the README.

Open point, also in section 13: the flat 2D glyphs inside `app.js` are listed in `NOTICE.md` as CC BY-SA 3.0, which is not a licence for material compiled into a GPL program. Whether the source also grants GPL or BSD is UNVERIFIED.

## 10. Security of the local server

- Bind `127.0.0.1` literally. No setting binds anything else in this version.
- One axum middleware on every route, including the WebSocket upgrade and `/mcp`: `Host` must be exactly `127.0.0.1:<port>` or `localhost:<port>`; `Origin` must be absent or one of those two origins; otherwise 403.
- No CORS headers. POST routes require `Content-Type: application/json`. Body limit 1 MiB on `/api`, rmcp's 4 MiB on `/mcp`.
- The pipe port requires the token line; the token exists only in `instance.json`.
- Static lookup is a map; `/art` is `ServeDir`, and only a marked folder.
- No token in the link. Host and Origin checks stop other websites; other local programs can already do worse. A token becomes mandatory only if a "share on my network" option is ever added.
- The in-page chat's API key stays in that page's localStorage and is never sent to the program.
- One Rust test per route asserts 403 for a foreign Origin and a foreign Host.

## 11. Build and release

- `cargo run -p rukh` needs Rust 1.88 or newer and nothing else, on every OS. It opens the board in the browser.
- The built web bundle is committed at `crates/rukh/webdist/`. No build script runs npm. In debug builds rust-embed reads the folder from disk, so `npm run watch -- --out ../crates/rukh/webdist` plus a refresh is the dev loop for the 3D board. Pull requests do not touch `webdist`; the maintainer or the main-branch job refreshes it, and the release job fails if a rebuild differs.
- CI (native, GitHub-hosted; runner labels UNVERIFIED): `cargo fmt --check`; `cargo clippy`; `cargo test --workspace` on Windows, macOS, Ubuntu; `cargo build -p rukh-core -p rukh-wasm --target wasm32-unknown-unknown`; `npm ci && npm test && npm run build`; the frame-parity test (build `rukh_core.wasm`, feed it an intent script under node:test, compare frames with a fixture written by `cargo test`); the art guard; the route security tests; a test that starts five `rukh mcp` at once and sees one instance id.
- Release artefacts: Windows x64, macOS arm64, macOS x64 (with `--features window`), Linux x64 (browser only). Each is an archive: `rukh(.exe)`, `art/`, `LICENSE`, `LICENSE-ART.md`, `NOTICE.md`, `LICENSES/` (Apache-2.0, CC BY-NC-SA 4.0, OFL texts). Windows builds keep the console for now. Size estimate 7 to 12 MB without art, UNVERIFIED.
- The demo: `npm run build:demo` builds `rukh-wasm` and copies the wasm, the bundle and `art/` into `web/dist-demo`.
- Not solved: unsigned binaries (Gatekeeper, SmartScreen).

## 12. Build steps

Each step is one sitting. The board works after each.

1. **Smallest slice.** `crates/rukh` with `hub.rs` (Mutex<Game> + rev + watch), `http.rs` with the guard from day one, `/` served from `web/dist` on disk (no embedding yet: the bundle still holds art), `/api/hello`, `/api/ws` (full frames; intents `play{move,from_fen}` and `new_game`), `/mcp` with one tool, `play{move}`. Page: one throwaway file `web/src/net/remoteSync.js`, active only when `api/hello` answers. On a frame: if the new node's parent FEN equals the local FEN, call `actions.playMove(uci)` (animation keeps working); otherwise convert the snapshot to the JS study shape, notes and arrows included, and call `actions.loadStudy`. On a local move it did not cause: send `play` with `from_fen`; the server refuses a mismatch and the tab reloads from the frame. In remote mode the page clock, self-play and study autosave are switched off.
   Verify: Rust tests (two watch receivers see the same rev; foreign Origin gets 403). By hand: two tabs follow each other; `claude mcp add --transport http rukh http://127.0.0.1:47474/mcp`, ask it to play e5, both tabs show it.
   Still works: the page without the program is exactly as before; JS tests untouched.
2. **Wait, seats, presence, styles.** Core C1. Tools `wait`, `get_game`, `annotate`, and `play` with notes and arrows; all eight descriptions, the instructions text and both prompts; presence message, top-bar chip, "You play / Opponent" control and style control (remote mode).
   Verify, Rust tests: after its own play an AI's wait does not return until the other side moves; a move made between two waits returns at once; browsing away never fires `your_turn`; browse back then AI plays, the new node's parent is the old tip; `set_eval` between wait and play refuses nothing; `set_eval` wakes nobody; a coach's annotate does not wake that coach; a seat claim starts a match; timeout is one line; presence does not bump rev. By hand: a full game against Claude Code and one other client, tools only, in each of the three styles.
3. **stdio and single instance.** `instance.rs`, `pipe.rs`, `rukh mcp` pump with detached spawn, `open_board`, session save and restore, lifetime rule and Quit, Connect an AI panel and `rukh mcp-config`.
   Verify: app running, `rukh mcp` in Claude Desktop: the move appears and the chip names the client. App not running: the client starts it and `open_board` opens a tab. Five simultaneous `rukh mcp` give one instance. Kill the app, restart: the game is back and stale `instance.json` is replaced. Quit the client: note whether the app survives (settles the UNVERIFIED point).
4. **Art split and "cargo run" from a fresh clone.** `git mv` the art into `art/`; `build.mjs` changes; `.gitignore`; `assets/index.js`; run-time fetches and `view.setAssets`; `modeledSets` path; fonts; `build.rs` guard; rust-embed over `webdist` and `web/vendor`; `assets.rs`; `settings.rs` with page settings and the offer to load an old saved study; licence files updated; confirm the glyph licence.
   Verify: a clone on a machine without Node: `cargo run` opens the board. Rename `art/` away: procedural pieces and wood, studio environment, picker hides modelled sets. Put a GLB into `webdist`: the compile fails.
5. **Core catches up (Rust only).** C2. Port the core-game and core-chess960 tests that cover it. Write the snapshot fixture for the web tests.
   Verify: `cargo test`; the wasm32 build of rukh-core still compiles. Page untouched.
6. **GameView as a facade.** `gameView.js` plus a converter from the JS `Game` to the Rust snapshot shape. The store rebuilds the GameView after each `afterGameChange`; reader modules move to it. No behaviour change.
   Verify: `npm test`, including GameView on the fixture (a Chess960 castling node and a variation tree).
7. **Store mutations through a backend.** `createStore({backend})` with `LocalJsBackend`; `onFrame` and its event mapping; provisional returns; `pendingMove`. Rewrite the core-store tests.
   Verify: `npm test`; by hand the standalone page plays, navigates, annotates, promotes and loads PGN as before.
8. **RemoteBackend.** `remote.js`; delete `remoteSync.js` and `mcpBridge.js`; every tree, annotation and navigation intent handled by the program; `api.js` and `chat.js` async; `play_line`; page-side codec for PGN and YAML import and export; tools `navigate` and `new_game`.
   Verify: two tabs mirror variations, notes, arrows, promote, delete; an arrow drawn by hand is visible to `get_game` at once; PGN and YAML import and export work in program mode.
9. **Engine host and evaluate.** C3; `engine.rs`; election by focus; `stockfish.js` gated on host; `evaluate`; the `engine` seat.
   Verify: Rust test with a fake view answering `engine_request`; by hand, evaluate with a tab open, the plain error with none, two tabs and only one Worker.
10. **Clock.** C4; one timer task that sleeps until `next_deadline_ms` and applies `flag`; clock UI reads `state.clock`; `wait` returns `flag`. Clock logic leaves `store.js`; core-clock tests ported.
    Verify: Rust tests with injected time; a 1-minute game flags in both tabs together.
11. **PGN in the core.** C5; `load{format:"pgn"}` and an export query; the page's PGN codec is no longer used in program mode.
    Verify: round-trip tests ported from core-io and core-game.
12. **WebAssembly backend and the demo.** `crates/rukh-wasm`; `wasm.js`; `build:demo`; frame-parity test; delete `LocalJsBackend`, `core/game.js`, `core/chess960.js`, the PGN/JSON half of `io.js` and their tests.
    Verify: `web/dist-demo` on any static server is a full board with no program.
13. **Dedicated window.** `window.rs`, the UiCommand loop, the open-in setting.
    Verify: Windows by hand (window opens, board renders, Stockfish runs, closing the window keeps the game). macOS and Linux when testers exist.
14. **CI and release packaging.**

## 13. Open questions

1. **Coach and the engine.** The coach rule says "judgement call, not an engine verdict", and evaluations are now offered over MCP. Recommendation: keep the sentence and add "the coach may call evaluate to check its own judgement before calling a move a mistake; the note is still in its own words". The final wording is the maintainer's.
2. **The single-file `chessboard.html`.** Today's build inlines every art file into it, which cannot continue. Recommendation: let it go; the hosted demo replaces it. The alternative is an art-free single file (procedural pieces, core wasm inlined), which costs a build path to maintain.
3. **Evaluations need an open board.** Recommendation: accept this for now; add the "path to a UCI engine" setting later if the coach needs it with no board open.
4. **The 2D glyph licence.** Recommendation: confirm the grant in step 4. If it is CC BY-SA only, ship the glyph data as a loose file beside the program (not in `art/`, since it is not non-commercial).

Decided here, not asked: the web bundle is committed; hand moves on the AI's side stay allowed; the port is 47474; the fonts are embedded so the look does not change; YAML stays in the page; Windows keeps a console for the first releases.

## 14. Deliberately not built

Tauri; SSE; a second HTTP server; a local-socket crate; wasm-bindgen; diffs or patches of state; optimistic game state in the page; any stored "awaiting" field; `rukh mcp` acting as the app; a native Stockfish; a Rust text packet; YAML in the core; takeback; non-loopback access and auth tokens; per-window games; several games at once; the single-file HTML as a default output; installer, updater, code signing; MCP tasks; view control over MCP; import and export MCP tools.

## 15. Unverified risks

Client tool-call time limits (the design does not depend on them: 45 s default, timeout is a normal result); whether clients kill a detached child; macOS and Linux builds of rmcp, wry and tao; background-tab throttling; IANA status of port 47474; OFL status of the three fonts; the glyph licence; esbuild output stability for the release freshness check; the PGN parser choice; the 318 or 322 test count; binary size; the raw C ABI of `rukh-wasm` (designed, not compiled).
