# rukh-core

The game behind Rukh, in `crates/rukh-core`.

## What the crate is

One `Game` owns everything a board shows: the rules, the tree of moves with its variations, and the notes and drawings on each move. Every window, and every AI connected over MCP, reads and changes this one game, so they can never disagree about the position.

The crate has no I/O and no clock. It builds natively, inside the Rukh program, and to WebAssembly, inside a web page with no server.

There are three layers:

- `Game` (`lib.rs`) is the rules and the move tree.
- `Session` (`session.rs`) is the game plus the match: who sits in each seat, the tip, and the AI's style.
- `Table` (`table.rs`) is the session plus its counters. It is the one place intents are applied and frames are produced.
- `Desk` (`desk.rs`) is the open boards: several tables, one of them shown.

## The move tree

The root node is always `0`. Node ids are never reused within a game; a deleted node leaves an empty slot.

`children[0]` of a node is the main line. The other children are variations. `promote_variation` moves a child to the front.

Playing a move that is already a continuation of the current node steps onto it instead of adding it. Replaying a line never duplicates it. A different move becomes a new variation.

Deleting a node removes everything after it. If the board was inside the removed part, it moves to the removed node's parent. Deleting from the root clears every move.

`ply` counts half-moves from the start of a standard game, so a game loaded from a FEN at move 10 starts at ply 18.

## Reading moves

`Game::parse_move` accepts UCI (`g1f3`, `e7e8q`) and SAN (`Nf3`, `O-O`, `exd8=Q+`).

- Castling is accepted as king-to-destination (`e1g1`) and as king-to-rook (`e1h1`).
- `0-0` is read as `O-O`.
- A promotion without the equals sign (`e8Q`) is accepted.
- A pawn reaching the last rank with no piece named promotes to a queen.

The table also strips a leading move number (`12.`, `3...`) and trailing `!` or `?` before passing the text on.

Moves are written back in UCI with castling as `e1g1` in standard chess and as king-to-rook (`e1h1`) in Chess960.

`Game::parse_san` and `Game::play_san` read SAN only, the way game text writes it. Check and mate marks and trailing `!` or `?` are ignored, castling may be written with zeros, and a promotion needs the equals sign. UCI is refused, so `B1c3` with a knight on b1 is not read as the move b1c3, and a pawn move written from square to square with no capture (`e2e4`) is refused. A pawn written with its letter (`Pe4`) and a promotion letter in lower case (`e8=q`) are read. A refusal repeats at most 20 characters of the move, printable ASCII only.

## Game text

`pgn::read_each` reads game text (PGN) from bytes, as Lichess and chess.com export it and as people paste it, and hands each game to the caller as soon as it is read: a game, or a game it could not read, each with the byte offsets of its text in the input. The caller may stop the reading after any game. It is given the most plies to replay; a game with more is handed over marked `too_long`, without its moves. `pgn::read_games` collects every game of a text, with no ply limit.

- Many games in one text. Text before the first tag and between games is skipped. Moves with no tags start a game only at `1.` followed by a legal first move.
- Tags: escaped quotes and backslashes are read. At most 64 tags a game are read; the rest are counted and ignored. A value is cut at 255 characters. Only a fixed list of tags is kept (`KeptTags`); the caller cleans names. A comment or a `;` line between two tags stays inside the game.
- Bytes that are not UTF-8 are read as Latin-1, tag value by tag value. A byte-order mark, CRLF, LF and bare CR all read. A line starting with `%` is skipped. A no-break space reads as a space. `pgn::is_utf16` tells a caller that the text starts with a UTF-16 byte-order mark; the reader does not decode it.
- The main line is replayed through the rules. Move numbers may be `1.`, `1...` or joined to the move (`1.e4`). Move numbers are not checked against the ply. Comments, variations, glyphs and every other tag are skipped. Variations are skipped with a depth counter, never recursion, and counted. A `[%...]` command among the moves reads as a comment.
- A clock is taken from `[%clk h:mm:ss]` or `[%clk h:mm:ss.s]` in a comment after a main-line move, the first well-formed one, in milliseconds. Minutes and seconds are two digits, hours at most four. A clock in a variation or before the first move is not taken. Any well-formed clock in the comment counts, also one inside a person's sentence.
- The result is the marker after the moves, else the `Result` tag. `1/2` and `½-½` after the moves are read as a draw. A game with no marker and no tag has none. The result is not checked against the final position.
- `last` reports how the final position stands: mate, stalemate, insufficient material, the fifty-move rule and how many times the position has stood.
- The `Variant` tag decides the rules: missing, blank, `Standard` or `From Position` is standard chess, `Chess960` is Chess960 from the `FEN` tag. Any other name, also one with no ASCII letters, is not replayed and is reported with its name in printable ASCII. A game from a set-up position is read and marked `from_position`; a position with more pieces than a game can reach is read. A standard game whose castling rights only Chess960 castling can hold is replayed with it and marked `chess960_castling`; when that start is one of the 960, the game is Chess960. A Chess960 game is `from_position` when its whole start is not one of the 960, compared position for position.

A game that cannot be read is reported with the reason: an unknown variant, a bad start position, a move that does not replay (with its ply, move number, side and the move in printable ASCII), or text that ends inside a tag, a comment or a variation. The games around it still load.

A brace comment runs to its closing brace. Inside a game, tags and moves written in a comment are never read. A comment after a game's result is outside any game, so tags written there start a new game, as they would anywhere between games.

The reader never panics and its work is linear in the input.

## Chess960

Start positions use Scharnagl numbering, 0 to 959. Number 518 is the classical position. The back rank is built in this order: the light-square bishop, the dark-square bishop, the queen, the two knights (from a table of ten placements), then rook, king, rook in the squares left, so the king always sits between the rooks.

FENs use Shredder castling letters (the rook files), which read the same way in every position.

A FEN loaded with no variant given is Chess960 when its castling rights could not belong to a standard game: a rook off the a or h file, or a king off the e file.

## Intents

An intent is one request to change the table. It is a JSON object tagged by `op` in snake_case. Unknown fields are ignored, so a transport may pass its whole message (for example a WebSocket `{"t":"intent","id":4,...}`) without picking the intent out first.

`play` can carry a note, a glyph, arrows and highlights. They land on the new move in the same change. Arrows and highlights are checked one by one, so a bad item is reported in `rejected` rather than failing the whole intent.

`claim_seat` is for AI clients only. If no match is active it starts one with the other seat human.

## Annotation modes

`annotate` combines what it is given with what the node already holds in one of three modes.

- `add` (the default): a non-empty note replaces the old one, a glyph replaces the old one, arrows are appended (an arrow on the same two squares is replaced), and highlights are merged by square.
- `replace`: every field that is given replaces what the node holds; an empty value clears it. A list where no item could be read keeps what is there, so a typo does not wipe the move. Only an empty list clears.
- `clear`: clears the fields that are given, or all four when none is given. Given arrows or highlights remove only the matching ones, matched by square alone; an empty list removes them all.

When a page sends the whole arrow list back in `replace` mode, an arrow that is unchanged keeps who drew it. A page echoing the list does not re-tag an AI's arrows as its own.

Glyphs are the six PGN glyphs `! ? !! ?? !? ?!`, or their numbers `$1` to `$6`.

## Who made a change

The `by` string names who sent an intent: `view:<k>` for a page, `ai:<name>` for an MCP client. Anything else, such as the program itself, is treated as neither.

Arrows drawn by a view are tagged `user`, arrows drawn by an AI are tagged `ai`.

## Counters

- `rev` goes up by one on every state change of any kind.
- `board_rev` goes up only for a move, a new game, and notes, drawings or navigation made from a view. Engine evaluations, seat and style changes, and an AI's own annotations and navigation leave it alone.
- `recent` keeps the last 16 board changes with who made them. An AI's annotations and navigation are listed there too, at the unchanged `board_rev`, so another reader can be told about them while the AI that made them is not.

Each entry in `recent` also carries the `rev` it was made at, which tells apart changes that share a `board_rev`. It is not sent.

When `recent` is full, the oldest entry that did not bump `board_rev` is dropped first. A run of an AI's own notes can therefore never push the person's moves out.

An intent that is accepted but changes nothing (stepping back at the start, an annotation identical to what is there) does not move `rev`.

## Waiting for changes

`wait(for: my_turn)` is level-triggered: asking again while it is still the AI's turn says so again.

`wait(for: any_change)` takes a `since`, a `board_rev` the caller has seen. With no `since`, or one above the current `board_rev`, it waits from when the wait started.

The table also keeps a log of the last 256 `board_rev` bumps with who made them. That way a wait can tell that someone else changed the board even after `recent` has dropped the entry. The report then wakes, and says `since_last_truncated` when older changes are not listed.

## Matches, seats and the tip

The tip is the end of the game being played. A move played from the tip moves it.

The match is live when it is active and the board shows the tip. While the person browses elsewhere, the match pauses: nobody is to move. An AI's move in the match is still played at the tip, not at the node on screen.

Whose move is owed is never stored. `Session::to_move` computes it from the position each time it is asked: the seat on the side to move at the tip, when the match is live and the game there is not over.

The status at the tip is cached after every change so a waiting AI can be told the game is over without copying the game each time it looks.

## When the person ends a match

A view can end a match that is still in progress with `match_stop`, `new_game`, or `set_seats` that takes the AI out. The table remembers which, until the next `match_start` from a view. While it is remembered, an AI's seat claim does not start a new match, so the person's Stop sticks against an AI that keeps calling `wait`. A waiting AI is told `game_over` with `stopped` set to the reason.

A match that ended on the board (checkmate, a draw) does not set this, so a later new game leaves the seat open.

When a view moves the AI from one colour to the other, a waiting AI is told `seat_changed` with its new seat instead of `game_over`.

A seat the person set for a person in a running match is not taken over by an AI.

## Styles

The style says what kind of opponent an AI is. The board owns it; the AI obeys its rule text.

- `silent`: play the move, nothing else.
- `annotate` (the default): play the move and leave one short note, at most two arrows and two highlights, on that move only.
- `coach`: `annotate`, plus point out a clear mistake in the player's previous move.

The coach rule refers to the annotate rule. `RULE_COACH` alone is only complete next to `RULE_ANNOTATE`, as in the server instructions. `RULE_COACH_IN_FULL` joins both, word for word, for tool results where the annotate rule is not shown. The rule texts are macros so that joined text is built from the same literals at compile time.

Any style text is normalised: case and spaces are ignored, and anything unknown becomes `annotate`.

## Tabs

A desk holds the boards the person has open, as tabs. Each tab is one whole `Table` with an id, a name and a kind. One tab is selected, and every window shows that one. No second board is drawn: selecting a tab changes the game the one board shows.

Tab ids are written `t1`, `t2` and so on. They are handed out in order and never reused, so a late message for a closed tab can never reach a new one. The place of a tab in the list is only its order.

A tab is `free`, `game` or `reps`. The person makes free tabs; the program makes the other two for the coach. A new desk has one free tab, `t1` "Board 1", on the standard position.

The tab intents are `tab_select`, `tab_new` (with an optional `name` and `copy_of`), `tab_rename`, `tab_close` and `tab_move`. They come from views and from the program; an AI is refused. `tab_new` selects the tab it makes. A copy takes the other tab's game and study but not its match. The desk itself refuses `tab_reopen` with `nothing_closed`, because it holds no closed tabs; a program that keeps them reopens one with `Desk::reopen`. `tab_close` accepts `abandon` and ignores it. `tab_move` refuses a `to` outside the list with `bad_input`. A rename to the same name, or a select of the tab already shown, changes nothing and leaves `rev` alone.

A game intent may name its tab with `tab`. With no `tab` it lands on the selected tab. A tab that is not open is refused with `unknown_tab`; the message quotes at most 20 characters of what was sent. An intent that has the key `tab` twice is refused with `bad_input`. An intent for a tab that is not shown is still applied.

Default names are "Board 1", "Board 2" and so on, the lowest number no open tab uses. A name is cleaned the way client names are, control and invisible characters removed and spaces collapsed, and cut to 40 characters. A name with nothing visible is refused. Two tabs may share a name. The program names its own tabs with `Desk::open_tab`, which refuses a name with nothing visible and does not select the tab it makes.

At most 12 free tabs can be open. A thirteenth is refused with `tab_limit`, "Close a board first." The coach's game and Reps tabs are neither counted nor refused. Closing the shown tab shows the tab to its right, or else the one to its left. Closing the last tab leaves a fresh "Board 1" under a new id.

### Counters on a desk

The desk owns one `rev` for all its tabs, because a view drops any frame whose `rev` is not above the last one it took. After every change the desk gives each table its `rev` with `Table::set_rev`, so the next intent on any tab lands on the next program-wide value, and a table's own `rev` and frame always agree with the desk. The desk's `rev` starts at 0 and rises by exactly one for each change, on whichever tab, and for each tab change: a select, a new tab, a rename, a close or a move.

Game ids come from one desk counter too. Each new tab, and each new game on any tab, takes the next one, so no two tabs ever hold the same `game_id`, even after a close. `board_rev` stays per tab. A select raises `rev` and no `board_rev`.

A table used on its own starts `rev` at 0 and `game_id` at 1, and a new game takes the next `game_id`.

### The frame

The desk's frame is the selected tab's frame with two more keys, `tab`, the selected tab's id, and `tabs`, the list in order. Each item of the list has `id`, `name`, `kind` and `mark`.

A mark is computed from the tab's table, never stored. It is `your_move` when a match there waits for a person, `waiting` when an AI or the engine is to move, `over` when the game at the match tip has ended, and `null` with no match. `paused` is kept for a paused coach game; no code produces it.

A change on a tab that is not shown still raises `rev`, so the next frame carries the shown tab again with fresh marks. The frame's hint names the last change, on whichever tab it landed.

## Saved forms

The crate turns a game, a table, a tab and the list of tabs into text and back. It writes no files: the program does all disk work.

### What is saved

`Game::to_saved` keeps only what cannot be recomputed: the variant, the Chess960 number, the start FEN, the node shown, the annotations on the start position, and each move with its id, the node it was played from, its UCI, its SAN and its annotations. `Game::from_saved` rebuilds the game through the rules. It plays each move in ascending id from its `from` node. A move that is illegal, a `from` that does not exist, an id that repeats or does not come out as written, a UCI written in another form, or a SAN that differs from the replay refuses the whole file with a `Damaged` message that names the move. Nothing is half-built. Node ids after a round trip are the same, because ids are handed out in order and no intent deletes a node.

`Table::to_saved` adds `game_id`, `board_rev`, the match (active, seats, tip, style), the study and the person's Stop. `Table::from_saved` recomputes the status at the tip. A restored table gives the same state as the one saved, except for `recent`, the bump log, the seat-moved marker, the hint and `rev`, which are not saved. Its `rev` starts at 0.

A free tab is saved in full. A `game` tab and the Reps tab are saved as stubs with no position. A Reps stub loads as an empty Reps tab. A game stub reads, but `Desk::restore` leaves it out; its id still counts.

### The text

A tab file is one JSON object. The header is printed over a few lines and each move is one line. The writer is written by hand; the reader uses `serde_json`. Every file has `"v": 1`, and any other version is refused. A byte-order mark before the text is ignored, so a file saved by an editor that adds one still reads. Every file ends in a newline.

Fields the reader does not know are kept and written back: at the top level of a tab file, inside `match`, `study` and `root`, in each move and in the index. Unknown fields of a move and of `root` are dropped when a new game replaces the moves. Unknown fields inside an evaluation, an arrow or a highlight are not kept, because those are the core's own shapes. A number too large for 64 bits is read as a float and written back as one.

`stopped` is written only when the person's Stop holds, as `match_stop`, `new_game` or `seats`. `root` holds the start position's annotations and is written only when there are some. `match` and `study` may be left out of a file; they then take their defaults.

The reader refuses numbers a desk could not carry on with:

- A board id above `t999999999`, in a file, a file name or the index.
- A `next_tab` above 1000000000.
- A `game_id`, `board_rev` or `next_game_id` above 2^50. The counters can grow far past that and still be exact in JavaScript, which loses exactness at 2^53.
- A Chess960 number that is not the number of the start position. With no number in the file, the one computed from the start position is used.

A move number in a FEN too large to count plies stops counting at the largest number rather than overflowing.

The index holds the order, the selected tab, `next_tab` and `next_game_id`, on one line.

### Rebuilding a desk

`Desk::restore` takes the index and the tabs that loaded. Tabs come in the index's order. Tabs it does not name follow by ascending id, and ids it names that did not load are skipped. A selected tab that is missing falls back to the first. `next_tab` is raised above every loaded id, and `SavedIndex::note_seen` raises it above any other id the program has seen, such as a file in `closed/`. `next_game_id` is raised above every loaded `game_id`. A stub, a tab whose `game_id` another tab already holds, and a reopened tab take a fresh one. With nothing loaded the desk starts with one fresh "Board 1" under the next id, so it is never empty. When every board number has been used, that one board takes `t999999999` again rather than leave the desk empty. A restored desk takes the program's new instance id.

Some choices are left to the restore:

- Every free tab that loads is kept, even above the limit of 12. New tabs are then refused until enough are closed.
- A second tab with the same id is dropped. The program never passes one, because a file's name must match the id inside it.
- A name is cleaned and cut to 40 characters, and the next save writes the cleaned name.
- Two Reps stubs both load. Keeping only one is left to the coach.
- The seat-moved marker is not restored.

When the board numbers run out, `tab_new`, and `tab_close` of the last tab, are refused with `tab_limit`, "No new board can be made: the board numbers have run out." An id is never handed out twice.

`Desk::reopen` puts a closed free tab back under its old id, at the end of the order, selected, with a fresh `game_id`. It is refused for an AI, for an id that is open, for a game or Reps tab ("Board t2 is not a free board, so it cannot be reopened."), and at the free-tab limit. Its refusal for an open id reads "Board t1 is already open."; the program never reaches it, because it skips open ids.

`Desk::stop_saving` turns recording off for a restored desk the program cannot save after all. `Desk::mark_to_write` asks for a tab to be written at the next save; the program uses it for a tab loaded from a newer pending copy.

### What to write

Only a desk made by `Desk::restore` records changes. `Desk::take_unsaved` hands over what changed since the last call:

- `now`: tabs to write at once, after a move, a new game, a match or seat change, a change to the person's Stop, a new tab or a rename.
- `quiet`: tabs to write after a quiet moment, after a note, an evaluation or navigation. The desk tells these apart by the change's reason (`annotate`, `eval`, `navigate`); any other reason is written at once, which loses nothing.
- `index`: the order, the selection or the counters changed.
- `closed`: the saved form of each free tab closed since the last call.
- `removed`: tabs whose file leaves `boards/`.

`Desk::saved_tab` and `Desk::saved_index` give the saved forms to write.
