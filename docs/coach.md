# The coach

Games pasted or dropped as text are stored in the coach folder. There is no page for them, no analysis and no AI tool.

Two crates share the work. `crates/rukh-coach` holds the records and the rules as functions on data. It reads no file, has no clock and does not depend on `rukh-core`. `crates/rukh` reads the text with `rukh_core::pgn`, hands each game to `rukh-coach` in a neutral form (`TextGame`), and does all the file work in `src/coach/store.rs`.

## The folder

The folder is `<data dir>/coach/`. It is made by the first import whose text holds a game, or by the first names call. An undo with no coach folder answers `unknown_batch` and makes nothing.

```
coach/
  persona.md                   the steady persona, written only when missing
  soul.md                      the seed lines and an empty "## Learned", written only when missing
  profile.json                 the student, with "my_names"; written only when missing
  state.json                   {"v":1,"next_game":5,"next_batch":3}
  games/g0003.json             one imported game
  imports/b0001/part-001.pgn   the text exactly as it arrived
  imports/b0001/batch.json     what the import did, and its undo
  removed/b0001/g0001.json     the games of an undone import
  derived/keys.json            the duplicate index
  broken/                      files set aside, never overwritten
```

`README.txt` and `meta.json` are not part of this folder.

Only a program that holds the data folder's lock writes here. With no data folder, with another Rukh holding the folder, or when the folder could not be used, every coach route refuses and nothing is written.

Every write goes through `safe.rs`. All file work runs on a blocking thread, one call at a time, and never under the hub lock. One text is received, read and stored at a time: an import waits for its turn before its body is read, so only one import body is in memory however many wait. The games of a text are let go one by one as their records are made. At stop, the program waits for a call in progress before it removes the lock.

Game files and raw texts are written once: the write refuses a path that is already taken, and the next free id is used instead. A file someone put in the way is never replaced. `persona.md` and `soul.md` are written the same way, only when the file is known to be missing.

A folder that cannot be listed, a game file that cannot be read while the key index takes it in, or a `persona.md` or `soul.md` that cannot be looked at, refuses the call with `write_failed` and nothing is written. It never counts as empty, missing or damaged, so the key index never leaves out a stored game and a person's own file is never replaced.

Most of an import's time is the safe writes: every game file is flushed to disk before it is linked in place.

## Damage and versions

Every JSON document carries `"v"`. Unknown fields are kept when the program rewrites `state.json`, `profile.json`, `batch.json`, `keys.json` or a game file.

- A `profile.json`, `state.json`, `keys.json` or `batch.json` that does not parse, or has an older version, is moved to `broken/<name>.<ms>` and a default takes its place. A `state.json` whose counters are above the highest id a file name can hold counts as not parsing.
- When `profile.json`, `state.json`, `keys.json` or a `batch.json` has a newer version than the program knows, nothing in the folder is written and the call answers `newer_version`.
- Temp files left by a stopped program are moved to `broken/` under their own names when the folder opens. Their ids are still never handed out again.
- A game file that does not parse is left alone and skipped. A game file of a newer version is never rewritten.

The next answer of any coach route names each file set aside and counts the game files that could not be read, in `notices`: `[{"code":"set_aside","message":"coach/profile.json could not be read. It was moved to coach/broken/profile.json.1795088081663."}]`. Each notice is given once. The codes are `set_aside`, `temp_files` and `unreadable_games`.

## A game file

```json
{
  "v": 1,
  "id": "g0003",
  "kind": "imported",
  "started": "2026-10-12T19:02:11Z",
  "variant": "standard",
  "start_fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "from_position": false,
  "you": "white",
  "you_rating": 1510,
  "white": {"bot":false,"name":"Maren Holt","rating":1510},
  "black": {"bot":false,"name":"quill_fox","rating":1488},
  "opponent": {"name":"quill_fox","rating":1488,"type":"person"},
  "tc": {"base_s":180,"inc_s":2},
  "result": "0-1",
  "reason": "checkmate",
  "plies": 14,
  "source": {"batch":"b0002","raw":{"end":705,"part":"part-001.pgn","start":0},"site":"lichess","site_key":"lichess:Xq7Lm2Pa","verified":false},
  "move_key": "07fb74e3089982e521e96f486e05afe6",
  "moves": [
    {"uci":"e2e4","san":"e4","clk":180000,"ms":2000},
    {"uci":"e7e5","san":"e5","clk":180000,"ms":2000}
  ]
}
```

The list of moves is cut to two here. One field is written per line and one move per line, so a file reads back to the same bytes.

- `started` comes from `UTCDate` and `UTCTime`. Without them it is `null`, and `date` holds the `Date` tag instead when it is a real date.
- `you`, `you_rating` and `opponent` are `null` until a stored name says which side is the player's own.
- `white` and `black` keep both players, so the side can be given later.
- A name loses control, bidirectional and zero-width characters, its spaces are collapsed, and it is cut to 30 characters. Markup stays as text. A name never becomes part of a file name or a path.
- A rating is kept only when it is a plain number. `bot` is true when the title is `BOT`.
- `tc` is `{"base_s","inc_s"}`, or `{"daily_s"}` for a days-per-move game, or `null`.
- `reason` is one of `checkmate`, `resign`, `flag`, `stalemate`, `repetition`, `fifty_move`, `insufficient`, `agreed`, `abandoned`, or `null`. The `Termination` tag is matched to fixed words only, and its text is never stored. A fixed word that stands wholly inside a player's name is not read, so a name never adds a reason; a name never takes a fixed word away either, however short it is. Lichess's "Normal" is completed from the final position the reader reports: mate, stalemate, insufficient material, threefold repetition or the fifty-move rule; otherwise a decisive game is `resign` and a draw `agreed`. The result is not checked against the final position.
- `clk` is on every move that had a `%clk`. `ms` is the thinking time from that clock, the same player's clock before it and the increment, never below 0. The first move of each side counts from the base time. A days-per-move game has no `ms`. A clock is taken as written; a clock-shaped phrase in a person's comment counts as the clock.
- `source.raw` points into the batch's raw text by byte offsets.
- `variant` is `standard` or `chess960`. A set-up position whose castling rights only Chess960 castling can hold is `standard` with `from_position: true`, its `start_fen` writes those rights in Chess960 form, and its castling moves are written king-to-rook. Such a file carries `"chess960_castling": true` after `from_position`, so it says how to read its own castling moves. Every other file leaves the field out; a Chess960 game always castles king-to-rook.

Comments, side lines, glyphs and every other tag stay only in the raw text, which nothing reads.

## Keys

Every game has two keys.

- The move key is a hash of the start position, the moves, the start time (or the date) and both names without case. It decides whether a game is already here. Two exports of the same game from different sites have the same key.
- The site key is `lichess:<id>`, `chess.com:live:<n>` or `chess.com:daily:<n>`. It is taken by strict pattern from `Link`, then `Site`, then a Lichess `GameId`. Text proves nothing about where a game came from, so it is always marked unverified and never stops another game.

The hash is 128-bit FNV-1a, written out in `rukh-coach`, so it gives the same key on every build and machine. Each field goes in with its length first, and an empty field ends the moves.

`derived/keys.json` maps move keys to game ids and site keys to the games that name them. `covers_below` is the first game number it may be missing. At start the program reads every game file that is numbered from there on or is not in the index, and drops entries whose file is gone. A missing index is rebuilt from the game files.

Two games with the same moves and the same names and no date at all have the same move key, so the second counts as already here. The answer counts these under `already_here_undated`.

## An import

The text is read once, game by game. A game that is skipped is counted and dropped as soon as it is read, and a game's moves are not replayed past 600 plies. A text that would keep more than 50,000 games is refused whole and nothing is stored. A text that starts with a UTF-16 byte-order mark is refused with `utf16_text`.

Games that cannot be stored are counted by reason, each under the first that applies:

1. `variant`: not standard chess, or Chess960 that does not begin at its own start position. The whole start position is compared, not only the back ranks. Chess960 from its own start is imported, also when its start arrives with no `Variant` tag.
2. `unreadable`: a move that does not replay, a bad start position, or text cut off inside a tag, a comment or a side line.
3. `unfinished`: no result, or `*`.
4. `too_short`: fewer than 10 plies.
5. `too_long`: more than 600 plies.

Games from a set-up position are imported with `from_position: true`, also when the position has more pieces than a game can reach.

A game whose move key is stored, or which came earlier in the same text, is already here.

The raw text is kept, under a new batch, when the text holds a new game. It is also kept when nothing is new but the text holds a skipped game or a game matched without a date, since those exist nowhere else, unless an earlier batch kept the very same bytes. Otherwise nothing is written and the answer's `batch` is `null`.

The writes go in this order: the raw text, each game file, `state.json`, `keys.json`, `batch.json`. A kill at any point loses nothing. At the next start the counters are raised above every id on disk (in `games/`, `removed/`, `broken/` and `imports/`, temp files included), the key index takes in the games written after it, and the same import stores only what is missing. An id that reached the disk is never handed out again.

The text is read and stored before the route answers. Every game is replayed once, by the reader.

## Which side is yours

`profile.json` holds `my_names`. A name matches a player without case. When exactly one player matches, that side is the player's own. When neither or both match, the side stays unknown, the game is stored anyway, and the answer lists the players of such games with how many games each is in, at most 20, most games first.

Adding names fills `you`, `you_rating` and `opponent` in every stored game whose side was unknown and is now known. Removing a name clears those fields in every game whose side that name gave, then gives the side again from the names that remain. A side that a remaining name still matches is never changed.

## Undo

Undo moves every game file whose `source.batch` is that batch to `removed/<batch>/`, takes them out of the key index and records the time and the ids now in `removed/<batch>/` in `batch.json`. The raw text stays. Nothing is deleted. A second undo of the same batch moves nothing. An undo that stopped part way finishes when asked again.

After an undo, importing the same text stores the games again under new ids. The moved copies stay in `removed/`.

## Routes

All three are POST, behind the Host and Origin guard, and need the header `X-Rukh: 1` and one `Content-Type`, each exactly once.

| Route | Content type | Body limit | Body |
| --- | --- | --- | --- |
| `/api/coach/import/text` | `text/plain`, `application/x-chess-pgn`, `application/vnd.chess-pgn` or `application/octet-stream` | 32 MiB | the text's bytes, as they are |
| `/api/coach/names` | `application/json` | 64 KiB | `{"names":["Maren Holt"]}` to add, `{"remove":["Maren Holt"]}` to take out, or both; 1 to 100 names in each list |
| `/api/coach/import/undo` | `application/json` | 64 KiB | `{"batch":"b0001"}` |

The checks run in this order: guard, header, content type, declared length, whether the coach may write. Only then is the body read, an import's after it has its turn, and a body without a declared length is cut at the limit.

A body refused by these checks or cut at the limit is answered at once, and the rest of it is read and thrown away in the background, up to 64 MiB and with pauses of at most 5 seconds. Closing a connection with unread bytes resets it, and a reset can throw away the answer before the client reads it. A body over the limit with a declared length always gets its 413. A body sent without one (chunked) gets it up to about 96 MiB, the 32 MiB read and the 64 MiB thrown away; past that the connection may be reset before the answer is read.

A body that pauses for more than 30 seconds, or takes more than 5 minutes in all, while it is read is refused with `broken_body`, and the rest of it is thrown away as above. So no client keeps an import's turn for more than 5 minutes.

Answers:

```
import  200 {"added":2,"already_here":0,"already_here_undated":0,"batch":"b0001","choose":[{"games":2,"name":"Maren Holt"},{"games":2,"name":"quill_fox"}],"set_up":0,"side_unknown":2,"skipped":{"too_long":0,"too_short":1,"unfinished":0,"unreadable":0,"variant":1},"skipped_total":2}
names   200 {"cleared_side":0,"given_side":2,"names":["maren holt"]}
undo    200 {"already_undone":false,"batch":"b0001","moved":2}
```

Any of them may carry `notices`. Refusals are `{"error":{"code":...,"message":...}}`, the shape the socket uses:

| Status | Code | When |
| --- | --- | --- |
| 403 | `no_rukh_header` | the header is missing, repeated or not `1` |
| 415 | `wrong_content_type` | another content type, or more than one |
| 413 | `too_big` | over the limit: "That is too big for one import (32 MB)." or "That is more than 64 KB." |
| 413 | `too_many_games` | the text would keep more than 50,000 games |
| 400 | `broken_body` | the body did not arrive whole |
| 422 | `utf16_text` | the text is UTF-16 |
| 503 | `no_data_folder`, `second_program`, `folder_failed`, `stopping` | the coach writes nothing in this program |
| 409 | `newer_version` | a file in the folder was written by a newer Rukh |
| 422 | `no_games` | the text holds no game; nothing is written |
| 404 | `unknown_batch` | no such batch |
| 400 | `bad_input` | a JSON body of the wrong shape, or no visible name |
| 500 | `write_failed` | a write failed; an import also returns what it stored under `stored` |
| 500 | `stopped` | the work stopped with an error; what was written before it is kept |

A refusal by the Host and Origin guard is the guard's own plain-text 403.
