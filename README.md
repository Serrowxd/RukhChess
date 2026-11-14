# Rukh

A 3D chessboard you can share with an AI. Play either side by hand, and connect your own AI to the
same board to play against you or coach you.

*Rukh* is the Persian word the rook comes from. It is said like "rook".

**Status: early.** The program runs the game and serves the board; AI clients connect to it over MCP.

| Folder | What it is | State |
|---|---|---|
| `crates/rukh` | The program: holds the game, serves the board on 127.0.0.1 and the MCP endpoint for AI clients. | Working, tested |
| `crates/rukh-core` | The game: chess rules, the move tree with variations, notes and drawings. Rust; builds natively and to WebAssembly. | Working, tested |
| `web/` | The 3D board (Three.js), Stockfish in the page, the UI. | Working, tested; still holds its own copy of the game |
| `blender/` | The piece sets as code: each set is modelled, baked and exported by a script. | Working |
| `docs/` | Design notes. | |

## Build

The program and the core:

```bash
cargo test --workspace
cargo run -p rukh
```

`cargo run -p rukh` prints the board's link and opens it. `--open` says how: `window` (the default)
starts an installed Chromium-based browser (Edge, Chrome, Brave, Vivaldi, Chromium) as a plain
window with its own profile, on the high-performance graphics card where the machine has one, and
falls back to the default browser when none is found; `browser` uses the default browser; `none`
only prints the link. `cargo run -p rukh -- --help` lists every option.

The board:

```bash
cd web
npm ci
node --test
node build.mjs
```

## Licence

- **Code:** GPL v3 or later. See [LICENSE](LICENSE).
- **Art** (the piece sets, board woods and the study): CC BY-NC-SA 4.0, non-commercial. See [LICENSE-ART.md](LICENSE-ART.md).
- **Libraries Rukh builds on:** see [NOTICE.md](NOTICE.md).
