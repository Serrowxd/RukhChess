# Art licence

Rukh's code is GPL v3 or later (see [LICENSE](LICENSE)). Its **art is licensed separately** and is
**not** under the GPL.

The files below are licensed under **Creative Commons Attribution-NonCommercial-ShareAlike 4.0
International (CC BY-NC-SA 4.0)**. The full text is in
[LICENSES/CC-BY-NC-SA-4.0.txt](LICENSES/CC-BY-NC-SA-4.0.txt).

In short: you may copy, share and change this art, as long as you credit Rukh, do not use it
commercially, and share what you make from it under the same licence.

## What this covers

| Files | What they are |
|---|---|
| `web/sets/*.glb` | The modelled piece sets: Classic, Menagerie, Cairn, Béton, Estate |
| `web/sets/*.proxy.glb` | Low-detail stand-ins derived from those sets (made by `web/tools/make-proxies.mjs`), used for shadows and outlines |
| `web/src/assets/board_maple.jpg`, `board_walnut.jpg`, `board_frame.jpg` | The baked board woods |
| `web/src/assets/env_study.hdr` | The rendered study the board sits in |

It also covers any image, model or texture later added to this repository and marked as Rukh art.

Credit as: **"Rukh piece sets and board art, © Serrow, CC BY-NC-SA 4.0"**, with a link to
this repository.

## What this does not cover

- **Code**, including the Blender scripts in `blender/` and the procedural pieces in
  `web/src/three/`: GPL v3 or later.
- **`web/src/assets/env_studio.hdr`**: "studio_small_01" by Greg Zaal, Poly Haven, CC0.
- **The flat 2D piece glyphs**: Colin M.L. Burnett, CC BY-SA 3.0.
- Everything else listed in [NOTICE.md](NOTICE.md).

## How the art ships

The art files are distributed **alongside** the program as separate files. They are not compiled
into it. The program is free software without them and runs with its built-in procedural pieces.
