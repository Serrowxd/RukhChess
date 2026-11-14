# Third-party notices

This app bundles the following. Their licenses travel with the build (`dist/` and `chessboard.html`).

- **Stockfish 19** — Stockfish.js build by Chess.com, LLC (https://github.com/nmrugg/stockfish.js), based on Stockfish
  (https://github.com/official-stockfish/Stockfish) by T. Romstad, M. Costalba, J. Kiiski, G. Linscott and contributors.
  Nets by Chris Bao (sscg13). **GNU GPL v3.** Files: `vendor/stockfish-19-lite-single.js`, `vendor/stockfish-19-lite-single.wasm`.
  Source for the exact build: the `stockfish@19.0.0` npm package.
- **chessops** — lichess rules library. **GNU GPL v3.** https://github.com/niklasf/chessops
- **Three.js** — **MIT.** https://github.com/mrdoob/three.js
- **js-yaml** — **MIT.** https://github.com/nodeca/js-yaml
- **cburnett chess piece art** (the "Flat glyph" set) — Colin M.L. Burnett, **CC BY-SA 3.0.**
  https://en.wikipedia.org/wiki/User:Cburnett/GFDL_images/Chess
- Fonts loaded from Google Fonts at runtime (IBM Plex Sans, IBM Plex Mono, Newsreader — SIL Open Font License).

Because Stockfish and chessops are GPL v3, the combined bundle is distributed under GPL v3; the app's own source
(`web/src/`, `crates/`) is in this repository.

Rukh's own art (piece sets, board woods, the study) is licensed separately from the code: CC BY-NC-SA 4.0,
see `LICENSE-ART.md`. Those files ship alongside the program and are not compiled into it.
