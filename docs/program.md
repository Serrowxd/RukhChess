# The rukh program

How `crates/rukh` works today. The design and later steps are in `architecture.md`.

## What it is

`rukh` holds the chess games, one per tab. Board pages connect over a WebSocket at `/api/ws`. AI clients connect over MCP at `/mcp` on the same port. Everything listens on `127.0.0.1` only.

The modules:

- `main.rs` parses the command line, binds the port, starts the server, opens the board and waits for Ctrl+C.
- `cli.rs` reads the flags and finds the built board.
- `http.rs` is the router, the Host/Origin guard and the static files.
- `hub.rs` is the one place the games change.
- `ws.rs` is the board page's socket.
- `mcp.rs` is the MCP tools, prompts and instructions.
- `presence.rs` tracks open views and connected AI clients.
- `open.rs` opens the board in a window or the default browser.
- `boards.rs` restores the saved boards at start and runs the saver.
- `safe.rs` is the safe file write and the data folder's lock.

## Finding the built board

When `--web-dir` is not given, the program looks for `web/dist` beside the program, in the current folder, and in their parent folders that are a Rukh checkout. A checkout is a folder that holds `web/build.mjs`. This lets `target/debug/rukh` find the checkout without picking up another project's `web/dist` higher up.

A folder that already holds `index.html` wins. Otherwise the checkout's `web/dist` is used even if it is not built yet, so the hint page at `/` can name the right place to build.

## The hub

Every view and every AI client goes through `Hub`. It holds the desk (the tabs, each with its game, match and counters) behind one lock.

After each change it publishes the full frame on a watch channel. A late or slow reader always ends up on the latest frame. The frame is published before the lock is released, so frames leave in the same order as the changes that made them. Nothing is awaited while the lock is held.

If a thread panics while holding the lock, the lock is taken anyway. This is safe: a refused intent changes nothing, and an applied one is published before the lock is released, so the table is always in a consistent state.

## Tabs

The hub holds a desk of tabs (see `core.md`), each a whole table. One tab is selected, and every view shows it. Views open, select, rename, move and close tabs over the socket. With one tab, the hub, presence and MCP behave as described in the rest of this file. Tabs are saved in the data folder and come back at the next start; see "Saved boards" below.

The hub's entry points:

- `apply`, `read`, `latest` and `subscribe` mean the selected tab. Only the tests call `apply`.
- `apply_on` and `read_on` name a tab, shown or not. MCP uses them.
- `apply_desk` takes tab intents, and game intents for the tab they name. The socket uses it.

A change on any tab raises the one `rev` and republishes the selected tab's frame. Hidden changes cost a resend, but they keep the marks current, and they wake every `wait`, which then looks at its own tab.

### Presence

One AI match is played at a time. Presence remembers the tab it is on, and seat holders belong to that tab. After a change, the hub checks the holders against that tab's table only, so a move on another tab never clears them. Closing the tab clears them.

A seat claim on another tab is refused while the AI match's tab has a held AI seat and its game has no result: "An AI is already playing on «Board 1»." A `play` for an AI seat of a match on another tab gets the same refusal, since moving for a seat holds it. A finished game does not block. Each AI entry in the presence message carries `tab`, the tab of its seat, or `null`.

The check, the claim or move, and the hold are made under one desk lock (`Hub::apply_seated`), so two AIs claiming seats on two tabs at once end with one match and one holder.

A holder that has dropped out of the presence list (an AI silent for longer than the listing time) no longer counts as holding. Its seat can then be taken on its own tab, or by a claim on another tab, which moves the AI match there.

After mate the holder stays listed with its seat and tab, but a game with a result does not count as held for this rule.

### An MCP session's tab

Each session keeps which tab it acts on. The tools have no new arguments.

A seated `wait` binds the session to a tab, and every later call acts there, whichever tab is shown. An unbound session takes a seat in this order:

1. the selected tab, if that seat is an AI seat nobody else holds in a match in progress;
2. otherwise the only tab with such a seat;
3. otherwise the selected tab, if it is a free tab with no active match and no stored game, where the claim starts a match;
4. otherwise no seat is taken. The answer comes from the tab of the last binding: on the selected tab the claim runs there; on a hidden tab the game is only read, so a finished game answers `game_over` again.

The binding ends when the tab is closed, when the match is stopped or replaced or the seat is taken away, or when the game at the tip has a result. The `wait` that reports it is the last call that uses it. A claim refused on the bound tab ends it only when that seat is no longer an AI seat of a match in progress. A seat moved to the other colour keeps it. A `wait` with no seat whose bound tab has no seat for it lets the binding go and looks again.

While bound, asking for the other colour while another tab is shown is refused: "You are playing on «Board 1»; finish it or ask the person to stop it." On the bound tab itself the claim runs there. Once the bound match is no longer in progress, the request for the other colour is not refused: the session is unbound and takes a seat by the order above.

When the bound tab is closed, the wait ends with `{"event":"game_over","stopped":"tab_closed"}` and its own sentence. The session is then marked: rules 1 and 2 still apply, rule 3 does not, and a seated `wait` gets the same answer again. An AI that keeps calling `wait` therefore never starts a match on the board the person happens to be showing.

A session with no seat has a cursor: the tab of the last result it was given. `get_game` reads the selected tab and moves the cursor there. `play` and `annotate` act on the cursor's tab, or on the selected one if the session has read nothing yet. If that tab was closed, they answer "That game was closed." So does `get_game` from a bound session whose tab was closed before a `wait` reported it; the session is then marked as closed and unbound, and its next `get_game` reads the selected tab.

A `wait` with no seat uses the bound tab; unbound, it looks for the one AI seat nobody else holds, on the selected tab first, then on the only tab that has one. It never starts a match.

`wait for=any_change` watches the cursor's tab. When the person selects another tab, it returns `changed` with that tab's position, an empty `since_last` and the line "The person switched to another board." The switch result has an empty `since_last`; the old `since` is not used.

Position bodies carry `tab`. A timeout stays `{event, board_rev}`. When the session's tab is not the one shown and a view is open, the line ends with "The person is looking at another board." An AI learns nothing about other tabs.

## Saved boards

`start()` takes the data folder as an `Option`. `None` keeps the boards in memory and writes nothing anywhere. A real run uses `--data-dir`, or else the default folder that `open.rs` finds.

The layout:

```
<data dir>/
  .lock                     the single-writer lock
  boards/
    README.txt              three lines for a person, written only when missing
    index.json              order, selection and the two counters
    t1.json  t4.json        one file per tab
    closed/t3.<ms>.json     closed boards, the newest 20; <ms> is the time of closing
    broken/                 files that could not be read, moved here whole
```

The file formats are in `core.md`. Times are milliseconds since the epoch.

### At start

The boards are restored before the server accepts a page or an AI. Each tab file goes through the core: read, then replayed move by move. The program then checks that the file's name matches the id inside it.

- A tab file that is not UTF-8 text, is not JSON, has another version, does not replay or names another id is moved whole to `broken/<id>.<ms>.json`. The other tabs load. A file named like a tab file whose number is above `t999999999` goes to `broken/` too.
- A damaged or unreadable `index.json` is moved to `broken/index.<ms>.json` and rebuilt: the tabs that loaded by ascending id, the first selected, `next_tab` above every id in any file name in `boards/`, `closed/` and `broken/`, and `next_game_id` above every loaded `game_id`. A missing index with tab files present is rebuilt the same way.
- A tab file the index does not name is added at the end. An index entry with no file is skipped. A lost selection falls to the first tab. Counters lower than the files show are raised without a notice, since nothing is lost.
- If nothing loads, there is one fresh "Board 1", under an id no file has used.
- A coach game stub is not loaded and its file is left where it is; its id is never reused. A Reps stub comes back as an empty Reps tab.
- `t1.json.pending` is the newer copy a held write left behind. When it loads and is not older than `t1.json`, or `t1.json` is missing or damaged, the tab is loaded from it and written to `t1.json` at once; the write then removes the pending copy. An older pending copy is left until that write. A damaged one goes to `broken/`. `index.json.pending` is read the same way: when it loads and is not older than `index.json`, or `index.json` is missing or damaged, its order and selection are used, and the index write made at every start puts it in place; one that cannot be read at all is left as it is.
- Temp files (`t1.json.tmp-<pid>`) left by a program that was stopped in the middle of a write are moved to `broken/` under their own names. Their ids still count, because an id that reached the disk was handed out.
- A file that cannot be read at all, for a reason other than its contents, is left as it is with a notice.
- If `index.json` cannot be read or moved aside, or `closed/` or `broken/` cannot be made, the boards that load are shown but nothing is saved, and a notice says so. Nothing is written over a file that could not be read.
- Nothing is ever deleted at start. Each of these cases, except the raised counters and the moved temp files, leaves a notice for the page.
- The index is written again at every start, even when nothing changed.
- A hard kill right after `tab_new` and a first move can lose that whole new tab, not only its last move.

A restored program has a new instance id and starts again at `rev` 0.

### When files are written

After every change the hub takes the desk's list of what changed and sends it to the saver task over an unbounded channel, so the hub never waits. The saver copies the saved forms under a brief lock and writes them with no lock held, on a blocking thread.

- Moves, new games, match and seat changes, and tab operations are written at once.
- Notes, evaluations and the shown node are written after one second with no further such change on that tab.
- In one pass the tab files go first, then the index, then closed boards, then the removal of closed tabs' files from `boards/`. A pass where a tab file failed does not write the index; one where the index failed moves nothing to `closed/`.
- A close therefore rewrites the index first and then moves the tab's file to `closed/`. The closed copy is taken from memory, so a note still waiting for quiet is in it. After each new closed file, all but the newest 20 are removed.
- `tab_reopen` is answered by the saver. It first writes what is waiting, then reads the newest file in `closed/` that is not an open tab. A damaged one goes to `broken/` and the next is tried. The tab comes back through the hub, and its closed file is removed once the tab and the index have been written again.
- Changes already queued when the saver wakes are merged, so a burst of moves is written in one pass.
- On stop, the saver writes everything at once, then the program removes the lock, all inside the two-second grace. If the saver has not finished by then, the lock is left; the next start finds it stale and replaces it.
- Closing a tab also removes its `t1.json.pending`, since the closed copy is newer.

A file edited by hand while the program runs is overwritten the next time that tab is saved.

### The safe write

Each file is written to `<name>.tmp-<pid>` in the same folder, flushed, renamed over the target and its length read back. On Windows a rename fails while another program has the target open. The write then tries again after 50, 100, 200 and 400 ms. If it still fails, the temp file is kept as `<name>.pending`, the copy in memory stays the truth, and the next pass tries again. When the rename failed because the file is in use, the page is told "Could not save boards/t1.json: another program has it open."; for any other reason, such as a read-only file, the page is told the system's own words instead. A write that lands removes any `<name>.pending`.

### The lock

`<data dir>/.lock` is made with create-new and holds `{"instance":...,"pid":...,"port":...,"started":<ms>}`. When it already exists, the program sends a GET for `/api/hello` by hand to `127.0.0.1:<recorded port>` with a 500 ms limit. An answer with the recorded instance is a live owner: this program then neither loads nor saves boards, runs them in memory, and says so in a notice. Anything else is a stale lock, which is replaced. At a clean exit the lock is removed only if it still names this program.

The lock is taken before the boards are restored, and the server answers `/api/hello` only after that. So that a second program cannot take the folder from a first one that is still restoring, the owner keeps `.lock` open for as long as it runs. On Windows it is opened so that others may read it but not change or delete it; a second program that cannot remove it treats the owner as live. On other systems the owner reads the lock again once the restore is done and saves nothing if it names another program.

A second Rukh can reach the same folder only with another `--port`, because the default port cannot be bound twice.

### Notices

| Code | When |
| --- | --- |
| `broken` | a tab file, a copy of the index, or a closed file asked for by `tab_reopen`, was moved to `broken/` |
| `index_rebuilt` | "The list of boards was rebuilt; their order may have changed." |
| `missing` | an index entry had no file |
| `added` | a tab file was not in the index |
| `selection_lost` | the selected tab did not load |
| `fresh_board` | nothing loaded |
| `coach_game` | a coach game stub was left on disk |
| `unreadable` | a file could not be read at all and was left as it is |
| `index_unreadable` | `index.json` could not be read or moved aside; boards are shown but not saved |
| `second_program` | another live Rukh holds the folder |
| `folder_failed` | the folder, `closed/` or `broken/` could not be made, or the folder could not be locked; boards are in memory |
| `write_failed` | a save did not land; reported once until that file saves again |

## The guard

Every route, including the WebSocket upgrade and `/mcp`, goes through one guard. A request passes only when its `Host` is exactly `127.0.0.1:<port>` or `localhost:<port>`, and its `Origin` is absent or one of those two origins. This stops other websites, including DNS rebinding tricks, from reading or driving the board.

`Host` must appear exactly once and `Origin` at most once. A repeated header could carry a foreign value behind an allowed one.

## Static files

Files are served from the web folder on disk. `/` is `index.html`; when that file is missing, `/` explains how to build the board.

Request paths are decoded and checked before use. Anything that could step outside the folder is refused: `..`, `.`, empty segments, backslashes, drive letters and NUL. After the file is found, its real path is resolved and must still be inside the web folder, so a symlink in the folder cannot expose files outside it.

## The board page's socket

The server sends `hello`, then the current state frame, then every later frame. A slow socket may skip frames but always ends on the latest.

The hello carries `proto`, which is 2. `/api/hello` carries the same number. A page built for another number stops and asks to be rebuilt.

The hello also carries `boards`: `{"saving":true,"notices":[{"id":1,"code":"broken","text":"..."}],"closed":2}`. `saving` says whether this program writes the boards to its data folder. `notices` are the things a person should be told about the saved boards, oldest first, the last 20. Their ids rise by one and are not reused while the program runs. `closed` is how many boards `tab_reopen` can bring back: the ids in `closed/` that are not open, each counted once. It is 0 when boards are not saved.

When a notice is added or `closed` changes, every open socket gets `{"t":"boards","saving":...,"notices":[...],"closed":...}` with the whole object, so the page shows only the notice ids it has not shown yet.

`closed` is counted at start. The saver counts it again after a pass that wrote or removed a closed board, and after each `tab_reopen`, refused or not. It lists the files on a blocking thread with no lock held.

A close raises the count shortly after its ack, once the closed file is written. After a reopen the new count follows the ack. When the oldest of 20 is dropped the count stays 20 and no message is sent. A closed file that cannot be read is counted until a `tab_reopen` moves it to `broken/`.

The page sends intents and gets one `ack` for each. An intent is the whole message, `{"t":"intent","id":n,"tab":"t1","op":...}`; the table reads `op` and its fields and ignores `t` and `id`. Other message types are ignored, so an older program keeps working with a newer page.

A game intent must name its tab. One with no `tab`, or a `null` one, is refused with `bad_input` before the intent itself is read. One for a tab that is not open is refused with `unknown_tab`. A repeated key is refused. Nothing changes in any of these cases. An intent lands on the tab it names whether or not that tab is shown, so a move sent just as another window switches tabs stays on the game it was made on.

Tab intents (`tab_select`, `tab_new`, `tab_rename`, `tab_close`, `tab_move`, `tab_reopen`) put the tab they act on in `tab`; `tab_new` and `tab_reopen` have none. Their results:

- `tab_select`: `{"selected":"t2"}`
- `tab_new`: `{"tab":"t2"}`; the new tab is selected. At 12 free tabs it is refused with `tab_limit`, "Close a board first."
- `tab_rename`: `{"tab":"t2","name":"..."}`, the name as cleaned. A name with nothing visible is refused with `bad_input`.
- A `tab_new` name with nothing visible is not refused; the tab gets the next default name, as with no name.
- Names are cleaned the same way everywhere: control and invisible characters are dropped, a line break or a tab reads as a space, runs of spaces become one, and the name is cut at 40 characters.
- `tab_close`: `{"closed":"t1","selected":"t2"}`. When boards are saved, the board is kept in `closed/`; otherwise its game is dropped. Closing the last tab leaves a fresh "Board 1". Closing the tab an AI plays on ends its `wait` with `tab_closed`.
- `tab_move`: `{"tab":"t2","order":["t2","t1"]}`
- `tab_reopen`: `{"tab":"t3","selected":"t3"}`. The newest board in `closed/` comes back under its old id, at the end of the strip, selected, with a fresh game id. With nothing in `closed/`, or when boards are not saved, it is refused with `nothing_closed`, "There is no closed board to reopen."

A tab intent that changes nothing, such as selecting the tab already shown, is acknowledged with the current `rev` and sends no frame. An intent that cannot be read is refused with `bad_input`; the parser's message in it is cut at 400 characters, so a long unknown `op` is not sent back whole. Only views send tab intents; an `ai:` actor is refused, and no MCP tool sends one.

Every frame carries `tab`, the selected tab, and `tabs`, the strip in order with each tab's `id`, `name`, `kind` and `mark`. `state` is the selected tab's state.

One loop per socket does all the writing. Before an ack it sends a frame at least as new as the ack, so when the page sees an ack its board already shows the result.

Presence messages are sent after the first frame and whenever presence changes. They are not state and carry no `rev`.

Size limits: a message over 64 KiB but under 1 MiB is read whole and refused with an ack, so the page can say why. Above 1 MiB the socket is closed with code 1009. A page that stops reading for 10 seconds is dropped.

## Presence

Presence is not game state. It never touches `rev` or `board_rev`, and is published on its own watch channel as the `{"t":"presence",...}` message.

An HTTP MCP client counts as present:

- while it is inside a `wait`,
- for 90 seconds after its last request,
- for 300 seconds while it holds the seat the match is waiting for, because a model may think a long time before it plays.

Which client holds which AI seat is kept apart from the expiring client list. The hub re-reads it against the match after every change, so a seat the person took back, or a match the person stopped, is never shown as still held.

Each MCP session acts as `ai:<name>`. A later session with the same name gets `ai:<name>#<session>`, so no session ever acts as another, even one that has gone quiet. Two clients with the same name are shown as `name`, `name (2)` and so on.

Client names are cleaned before they are shown. Control characters and invisible format characters (bidirectional controls, zero-width characters) are dropped, so a name cannot show reversed or pretend to be something else. Whitespace runs become one space, and the name is cut at 64 characters.

A presence message is sent only when something a person would see changes: the number of views, or a client's name, seat or waiting flag. The ticker also resends it every 15 seconds so `idle_s` moves on.

## MCP

Each client acts on the table as `ai:<client name>`, the name it gave in `initialize`. Results are structured content plus one short line of prose. The content holds the prose line and then the full JSON, and the structured value carries the prose as `message`, so a model can read the result whichever half its client passes on. Refusals a model should read are tool errors with readable text.

### Remembered position

Each session remembers the `(game_id, node)` of the last position it was given by `get_game` or `wait`: the tip during a match, the shown node otherwise. When the next `play` gives no `from_node`, that node stands in for it. A move chosen for that position is then refused as stale rather than played somewhere else. Any play, played or refused, clears it.

### Waiting

`wait` subscribes to frames before its first look at the table, so a change between the look and the wait still wakes it. The lock is held only to test the table, never while waiting.

Frames are checked before the deadline, and the deadline does one last look under the lock. A change that lands just as the wait runs out is reported, and the timeout's `board_rev` comes from that same look.

`for: any_change` never takes a seat, even when one is passed, so a coach cannot become the person's opponent. Waiting on a seat counts as holding it.

When a client asked for progress, a long wait sends a notification every 10 seconds. Each send may take at most 2 seconds, so a client that stopped reading cannot hold a wait past its deadline or a cancellation.

The default timeout is 45 seconds, allowed 1 to 240. The MCP session keep-alive (300 seconds) stays above them.

### Protocol version

The newest protocol version served is 2025-11-25. Later versions serve each request on a fresh handler with no session, which would lose who a client is between calls. Until that is built and tested, such clients are asked to fall back to a version with `initialize`.

### Plain schemas

Some clients accept only a plain subset of JSON Schema for tool inputs. The tool router rewrites every input schema once, at start:

- no `$schema`, `$defs` or `$ref`; references are inlined, keeping the field's own description;
- no null alternatives; an optional field is just its type and is never listed as required;
- no integer formats;
- string enums written as `oneOf` of constants become a plain `enum`.

Serde still treats a missing optional field as absent.

`ArrowArg` and `HighlightArg` only describe the input in the published schema. The items arrive as raw JSON, so the table can check them one at a time and report a bad one instead of refusing the whole call.

The doc comments on the argument types become the schema descriptions models read, so they are part of the published interface.

## Opening the board

By default the board opens in its own window: an installed Chromium-based browser started in app mode (no tabs, no address bar), with its own profile folder and the switch that puts it on the high-performance graphics card.

On a machine with two graphics adapters, Chromium runs every page on the integrated one and ignores the page's own WebGL request for the faster adapter. So the switch has to be given to a browser process this program starts itself; a browser that is already running cannot take it. A separate profile folder makes that a new process even while the same browser is open with the person's own profile. The window also runs without the person's extensions, sign-in or sync.

The browser is found from `RUKH_BROWSER` first, when it names a program file, then from the usual install places for the system. If none is found or it cannot be started, the default browser is used and the reason is printed.

The profile lives in the data folder: `%LOCALAPPDATA%\Rukh` on Windows, `~/Library/Application Support/Rukh` on macOS, `$XDG_DATA_HOME/rukh` or `~/.local/share/rukh` on Linux. A relative path is made absolute first, because the browser would resolve it against its own working folder.

The browser is started detached, in its own process group, so Ctrl+C in this console does not reach it. On Windows the program first stops its own standard handles from being inherited. Windows hands every inheritable handle to a child, not only its stdio. When this program's output is a pipe, the browser would hold that pipe open until its window closes, and whatever reads the pipe would wait after this program had exited.

PATH values are split with the separator of the system being looked at, not the one the program was built for, so the tests can check every system from any machine. On Unix they are split as raw bytes, so a folder whose name is not UTF-8 stays the same folder.

Every decision goes through the `System` trait. The tests use a fake that records what would be created or started and never touches the real environment, file system or processes.

## Tests

`src/tests.rs` runs the real server on a free port inside the test process and talks to it over real HTTP and WebSockets. Raw HTTP requests are written by hand so a test controls the exact path and `Host` header.

These tests start the server with no data folder, so they write nothing. `src/tests/saving.rs` gives each test its own fresh folder under the system temp folder and removes it at the end. No test reaches the default data folder.

Some saving tests hold a file open so that others cannot touch it, which only Windows enforces; they run on Windows only. The hub counts file writes, and writes made while its lock is held, only in test builds.
