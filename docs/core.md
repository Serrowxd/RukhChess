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

The tab intents are `tab_select`, `tab_new` (with an optional `name` and `copy_of`), `tab_rename`, `tab_close` and `tab_move`. They come from views and from the program; an AI is refused. `tab_new` selects the tab it makes. A copy takes the other tab's game and study but not its match. `tab_reopen` is refused with `nothing_closed`: closed tabs are not stored. `tab_close` accepts `abandon` and ignores it. `tab_move` refuses a `to` outside the list with `bad_input`. A rename to the same name, or a select of the tab already shown, changes nothing and leaves `rev` alone.

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
