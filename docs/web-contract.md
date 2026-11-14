# Web board — module contract (v0, 2026-09-17)

The module boundaries and shared shapes of `web/src`. The page needs no server of its own. When the `rukh`
program serves it, it follows the program's game ([program.md](program.md), [web.md](web.md)).
`node build.mjs` writes `dist/` (index.html + app.js + app.css + vendor/ + sets/) for hosting and, unless
`--no-single` is passed, `../chessboard.html`: one file with Stockfish, the Draco decoder and the modelled
sets inlined as base64, which opens by double-click from `file://`. Proxy sets ship only in `dist/sets/`.

Stack: Three.js 0.186 (ESM, bundled by esbuild) · chessops 0.15 (rules, FEN, SAN, PGN trees,
Chess960) · js-yaml 5 · Stockfish 19 lite single-thread WASM (`vendor/`) · vanilla JS, no framework.

Everything is plain JavaScript (ESM). No TypeScript. JSDoc where a signature matters.
Each module owns its files. Cross-module calls go through the APIs in this file. A module that needs
something not listed here adds it to its own exported surface and documents it in its file header.

## Coordinates and vocabulary

- Squares are strings `'a1'..'h8'` at every module boundary. chessops square numbers never leave `core/`.
- Moves at the boundary: `{ from:'e2', to:'e4', promotion?: 'q'|'r'|'b'|'n' }`. UCI strings (`'e2e4'`, `'e7e8q'`)
  are accepted by `core` helpers. Castling is written king-from → king-to (`e1g1`) in standard and in most of
  Chess960; `core` also accepts king-takes-own-rook (`e1h1`) and normalises it. **Correction 2026-09-18:** in the
  two Chess960 degeneracies where the king-destination form cannot exist (the king already stands on its
  destination, e.g. `Kg1`+`Rh1`; or that destination is also a legal one-square king move, e.g. `Kb1`+`Ra1`)
  `core` stores the **king→rook** form instead — 1008 of the 2520 possible 960 castling moves. Anything reading
  `node.move` / `node.uci` must tolerate both forms; `three/pieceLayer.js` resolves the real destination from the
  before/after diff rather than trusting `to`.
- Piece: `{ color:'white'|'black', role:'pawn'|'knight'|'bishop'|'rook'|'queen'|'king' }`.
- Arrow: `{ from, to, color:'green'|'red'|'blue'|'yellow', knight?:boolean, source?:'user'|'engine'|'ai' }`.
  `knight` is true when from→to is a knight jump; the renderer draws it as an L (two squares along the
  long axis first, then one). Anyone creating an arrow may leave `knight` undefined; `Game.isKnightJump(from,to)` decides.
- Highlight: `{ square, color }` (same four colours).
- World space (Three.js): one square = 1 unit. File a→h runs along **+X** (a = −3.5, h = +3.5).
  Rank 1→8 runs along **−Z** (rank 1 at z = +3.5, rank 8 at z = −3.5). Y is up; the board's top surface is y = 0.
  So from the default White camera (at +Z looking toward −Z) rank 1 is nearest. `three/board.js` owns the mapping.
- Colours for the four annotation colours live in `settings.arrowColors` (hex strings). Nobody hardcodes them.

## Tree node (core owns the shape; everyone reads it)

```js
{
  id: 'n12',            // stable within a session; regenerated on load
  ply: 23,              // 0 for the root; root.ply may be > 0 when starting from a FEN mid-game
  san: 'Nf3',           // null on root
  uci: 'g1f3',          // null on root
  move: { from, to, promotion? } | null,
  fen: '...',           // position AFTER this move (root: start position)
  check: false, checkmate: false,
  captured: 'pawn' | null,   // role captured by this move
  note: '',             // free text, shown in 3D + notes panel + packet
  nag: '' | '!' | '?' | '!!' | '??' | '!?' | '?!',
  arrows: [],           // Arrow[] attached to this position (user + ai; engine arrow is transient and NOT stored)
  highlights: [],       // Highlight[]
  eval: null | { cp?:number, mate?:number, depth:number, pv:string[] /* uci */, best?:string /* san */ },
  children: [],         // Node[]; children[0] is the main continuation
  parentId: 'n11' | null
}
```

## `core/game.js` — rules + variation tree (pure: no DOM, no three)

```js
export class Game {
  static standard(): Game
  static fromFen(fen: string): Game            // throws Error(message) on invalid FEN or illegal setup
  static chess960(n?: number): Game            // n in 0..959; undefined = random. Sets game.variant='chess960', game.chess960Number=n
  static fromPgn(pgn: string): Game            // full tree, comments → note, %cal → arrows, %csl → highlights, NAGs, [FEN]/[Variant "Chess960"] headers
  static fromJSON(obj): Game                   // inverse of toJSON()
  static fromPieces(pieces: {square, piece}[], opts: {turn:'white'|'black', castling?: string /* 'KQkq' or X-FEN */, epSquare?: string}): Game
                                               // for Setup mode; throws with a readable reason (no king, pawn on back rank, side not to move in check, …)
  static isKnightJump(from, to): boolean

  variant: 'standard' | 'chess960'
  chess960Number: number | null
  startFen: string
  root: Node
  current: Node
  headers: Map<string,string>                  // PGN headers (Event, White, Black, Result, FEN, SetUp, Variant…)

  // reading
  fen(): string                                // current
  turn(): 'white' | 'black'
  pieces(): { square: string, piece: Piece }[]
  pieceAt(square): Piece | null
  node(id): Node | null
  path(): Node[]                               // root … current
  mainline(): Node[]                           // root … end of main line
  isOnMainline(nodeId): boolean
  legalMoves(from?: string): { from, to, promotion? }[]
      // all legal moves (or from one square). Castling appears as king→king-destination (e1→g1 / e1→c1) even in Chess960
      // (plus the king→rook form as a second entry ONLY in Chess960 when the squares differ).
      // Promotions appear once per promotion piece (4 entries).
  legalTargets(from): string[]                 // unique destination squares for the UI (promotions collapsed to one)
  isLegal(move): boolean
  isKnightJump(from, to): boolean
  status(): { check, checkmate, stalemate, insufficientMaterial, fiftyMoves, repetition:number, outcome: null|'1-0'|'0-1'|'1/2-1/2', reason: string }
  sanToMove(san): {from,to,promotion?} | null  // in the current position
  moveToSan(move): string | null               // in the current position
  pvToSan(uciList: string[]): string[]         // engine PV → SAN in the current position (stops at the first illegal)
  uciToMove(uci): {from,to,promotion?} | null

  // playing / navigating (each returns the new current node; all emit nothing — store wraps them)
  play(move): { node: Node, san, captured, castle: null|'king'|'queen', enPassant: boolean, promotion: string|null, check, checkmate, reused: boolean }
      // Illegal → throws Error('illegal move'). If an identical child already exists, it is reused (reused=true), not duplicated.
      // A new move from a non-leaf node becomes a NEW VARIATION (appended to children); the old line is kept.
  goto(nodeId): Node
  back(): Node | null, forward(): Node | null /* children[0] */, toStart(): Node, toEnd(): Node /* follows children[0] */
  nextVariation(): Node | null, prevVariation(): Node | null   // siblings of current
  promoteVariation(nodeId): void               // make it children[0] of its parent (one level)
  makeMainline(nodeId): void                   // promote all the way up
  deleteFrom(nodeId): Node                     // remove the subtree; current moves to parent; returns new current
  setNote(nodeId, text), setNag(nodeId, nag), setArrows(nodeId, arrows[]), setHighlights(nodeId, highlights[]), setEval(nodeId, eval|null)
  toggleArrow(nodeId, arrow): boolean          // same from/to → remove (any colour); returns true if added
  toggleHighlight(nodeId, square, color): boolean   // same square same colour → remove; same square other colour → recolour

  // export
  toPgn(): string                              // headers + full tree; notes as comments; arrows/highlights as %cal/%csl in the comment (chessops makeComment)
  toJSON(): object                             // { version:1, variant, chess960Number, startFen, headers:{}, tree: Node (recursive, no parentId) }
}
```

`core/chess960.js`: `export function chess960Fen(n): string` (Scharnagl numbering; emit X-FEN castling `KQkq` and **verify castling works in chessops after loading** — if not, emit Shredder-FEN file-letter rights) and `export function randomChess960(): number`.

## `core/io.js`

```js
export const STUDY_VERSION = 1
export function studyToYaml(study): string    // study = { title, created, notes, orientation, game: Game }
export function studyFromYaml(text): { title, created, notes, orientation, game: Game }   // throws with a readable reason
export function studyToJSON(study): object / studyFromJSON(obj)                             // for localStorage autosave
export function gameToPgn(game), gameFromPgn(text)  // thin wrappers
export function encodeHash(study): string     // '#fen=<enc>' if only a start position, else '#pgn=<enc>' (encodeURIComponent; keep it simple)
export function decodeHash(hash): { fen?, pgn? } | null
export function download(filename, text, mime)   // browser helper; may live here (guard for non-browser in tests)
```

YAML layout (this is what a person will read and what an AI will annotate — keep it human-first):

```yaml
chessboard: 1
title: Italian, the plan
created: 2026-09-17
variant: standard        # or chess960
chess960: null           # or the number
start_fen: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1
orientation: white
notes: |
  study-level notes
moves:                   # main line from the root; ONE entry per half-move
  - san: e4
    uci: e2e4
    fen: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1
    note: "the plan starts here"
    nag: "!"
    arrows: [{from: g1, to: f3, color: green}]
    highlights: [{square: d5, color: red}]
    eval: {cp: 30, depth: 20, best: Nf3, pv: [g1f3, b8c6]}
    variations:          # each is a list of moves starting from the SAME parent position
      - moves:
          - {san: d4, uci: d2d4, fen: "..."}
```
Omit empty keys (`note: ""`, `arrows: []`, `eval: null`, `variations: []`) on export. Import tolerates missing keys.
The root node's note/arrows/highlights go under a top-level `start:` key with the same shape (omit when empty).

## `core/store.js` — state + events + actions

```js
export const store = createStore()             // singleton; also export createStore for tests
store.state                                    // read-only by convention (mutate only through actions)
store.on(event, fn) → unsubscribe; store.off(event, fn); store.emit(event, payload)
export const actions                           // bound to the singleton store

state = {
  game: Game,
  study: { title: '', created: 'YYYY-MM-DD', notes: '' },
  mode: 'play' | 'setup',
  setup: { pieces: {square, piece}[], turn:'white'|'black', castling:'KQkq' } | null,   // only while mode==='setup'
  orientation: 'white' | 'black',
  selected: null | square,                     // piece picked up / clicked
  legalTargets: string[],                      // for `selected`
  engine: { available:false, enabled:false, thinking:false, depth:0, nodes:0, nps:0, score:null /* {cp}|{mate} from White's view */,
            lines: [ { multipv:1, score:{cp}|{mate}, depth, pv:string[] /*uci*/, san:string[] } ], bestMove:null /*uci*/, playAs:null|'white'|'black' },
  ai: { provider:'packet'|'local'|'anthropic', busy:false, messages:[ {role:'user'|'assistant'|'system', text, at} ], lastError:null },
  settings: { …see below… },
  ui: { panel:'moves'|'engine'|'ai'|'notes'|'io'|'settings', collapsed:false }
}

settings defaults = {
  theme: 'wood',                               // 'wood' | 'metal' | 'glass'
  palette: null,                               // null = theme defaults, else { light, dark, frame, white, black } hex
  pieceSet: 'classic',                         // modelled (loaded on first use): 'classic' | 'menagerie' | 'cairn' |
                                               // 'beton' | 'estate'; built-in: 'staunton' | 'minimal' | 'glyph'; or a user glTF set id
  showLegalMoves: true, showCoordinates: true, showLastMove: true, showCheck: true,
  showEngineArrow: true, showNotes3D: true, showEvalBar: true,
  arrowColors: { green:'#15781B', red:'#882020', blue:'#003088', yellow:'#E68F00' },
  uiTheme: 'auto',                             // 'auto' | 'light' | 'dark'
  background: 'auto',                          // hex or 'auto' (follows uiTheme); shown only in the 'plain' environment
  environment: 'room',                         // 'room' | 'studio' (blurred HDRI rooms with a walnut table) | 'plain'
  shadows: true, animations: true, autoRotate: false,
  engine: { enabled: false, multipv: 3, depth: 22, movetime: 0, skill: 20, elo: null, autoAnalyse: true },
  ai: { provider: 'packet', localUrl: 'http://127.0.0.1:8080/v1', localModel: '', anthropicModel: 'claude-sonnet-5', includeEngine: true, includeLegalMoves: false },
}
// The Anthropic key is NOT in settings; it lives at localStorage['chessboard.anthropicKey'] (ai module owns it).

actions = {
  // game
  newGame(), newChess960(n?) → number, loadFen(fen), loadPgn(text), loadStudy(studyObj), loadYaml(text)
  attemptMove({from,to}) → 'played' | 'promotion' | 'illegal'   // 'promotion' → emits 'promotion:required' {from,to}; UI then calls playMove with promotion
  playMove({from,to,promotion?}) → Node | null                   // also used by engine / ai / window.chess; null + toast when illegal
  playSan(san) → Node | null
  goto(nodeId), back(), forward(), toStart(), toEnd(), nextVariation(), prevVariation(), promoteVariation(id), makeMainline(id), deleteFrom(id)
  select(square|null), setMode('play'|'setup'), flip(), setOrientation(c)
  // setup mode (state.setup is the scratch position; the board renders state.setup.pieces while mode==='setup')
  setupPlace(square, piece|null), setupClear(), setupStart(), setupTurn(color), setupCastling(str), setupCommit() → true | throws Error(reason)
  // annotations (on the current node)
  toggleArrow(arrow) → boolean, toggleHighlight(square,color) → boolean, addArrows(arrows[], source), setHighlights(list), clearAnnotations({arrows,highlights,notes}?)
  setNote(text), setNag(nag), setStudyNotes(text), setStudyTitle(text)
  // settings
  setSetting(path, value)                     // 'engine.multipv' dotted paths ok; persists to localStorage['chessboard.settings']; emits settings:change {path,value}
  resetSettings()
  // engine (called by engine module)
  engineStatus(patch), engineLines(lines, score, depth, bestMove), engineSetPlayAs(color|null)
  // ai (called by ai module)
  aiMessage(msg), aiBusy(bool), aiError(text), aiClear()
  // ui
  setPanel(name), toggleCollapsed()
  // persistence
  autosave(), restore() → boolean            // localStorage['chessboard.study'] (studyToJSON), debounced on every game:change
  toast(text, kind)
}

events (payload) — emitted by actions after state is updated:
  'game:change'      { game, current, reason: 'move'|'goto'|'load'|'delete'|'promote'|'new'|'setup'|'note' , move?: play() result when reason==='move' }
  'position:change'  { fen, turn, node }                                                                // fen actually differs (subset of game:change)
  'annotations:change' { node }                                                                         // arrows/highlights/notes/nag on the current node
  'selection:change' { selected, legalTargets }
  'promotion:required' { from, to }
  'mode:change'      { mode }
  'orientation:change' { orientation }
  'settings:change'  { path, value, settings }
  'engine:update'    { engine }
  'ai:update'        { ai }
  'ui:change'        { ui }
  'toast'            { text, kind:'info'|'error'|'ok' }
```

**Order within one change (fixed 2026-09-18; `main.js` relies on it):** `game:change` → `engine:update` →
`position:change` → `selection:change`. The selection is cleared *after* the game change so a completed promotion
is never mistaken for a cancelled one (a genuine cancel is a `selection:change` with no preceding `game:change`).

Rules: actions mutate state then emit. Listeners never mutate state. `store.state.game` is the live Game
instance (not cloned) — read it, don't call its mutators outside actions.

## `three/scene.js` — renderer / camera / controls

```js
export function createView(container: HTMLElement, settings) → view
view.scene, view.camera (PerspectiveCamera), view.renderer, view.labelRenderer (CSS2DRenderer overlay), view.controls (OrbitControls)
view.setPreset('white' | 'black' | 'top' | 'side' | 'free')     // animated. 'top' is a near-orthographic overhead. 'white'/'black' = player seats.
view.flipTo(orientation)                                          // 'white'|'black' — animate the camera to the other seat, keep elevation
view.focusOn(target: THREE.Vector3 | THREE.Object3D, distance?)  // animated look-at (double-click a piece)
view.raycast(clientX, clientY, objects: Object3D[], recursive=true) → THREE.Intersection[]
view.pointerToPlane(clientX, clientY, y = 0) → THREE.Vector3 | null   // intersection with the horizontal plane at height y
view.setControlsEnabled(bool)                                     // off while dragging a piece
view.onFrame(fn(dt, elapsed)) → unsubscribe                       // render loop hook
view.setQuality({ shadows, antialias })                            // may recreate the renderer
view.setBackground(color | null)                                   // null → transparent / css background
view.setAutoRotate(bool)
view.resize()                                                      // also called by ResizeObserver
view.dispose()
```
Controls mapping (fixed, documented for the user): left-drag on empty space = orbit · middle-drag or shift+left-drag = pan
· wheel = zoom (dolly toward cursor) · right button is **reserved** for annotations (controls must ignore it)
· touch: one finger orbit, two fingers pinch/pan. Damping on. Min/max polar so the camera never goes under the board.
Lighting: hemisphere + key directional (shadows) + `scene.environment` through `PMREMGenerator`: the chosen
environment's HDRI ('room' / 'studio', also the blurred background), or `RoomEnvironment` for 'plain' (metal and glass
need one). Khronos Neutral tone mapping in the HDRI rooms, ACES in 'plain'; sRGB output;
`renderer.shadowMap.type = VSMShadowMap`, softened by `shadow.radius` over `shadow.blurSamples` (16). Two lights help the
far army read: a seat fill (a DirectionalLight from behind the camera, 15 deg up, re-aimed every frame) and the pieces'
back light (a capped silhouette edge in the piece shaders, off on flat faces). Both scale per environment and are off in
2D and unlit.

## `three/materials.js` — themes

```js
export const THEMES = ['wood', 'metal', 'glass']
export const THEME_PALETTES = { wood:{light,dark,frame,white,black}, metal:{…}, glass:{…} }   // hex defaults
export function createMaterialSet(theme, palette /* may be null */) → matSet
matSet = { lightSquare, darkSquare, frame, whitePiece, blackPiece, /* THREE.Material each */ theme, palette, setPalette(palette), dispose() }
```
Wood: MeshStandardMaterial with a procedural CanvasTexture grain (two tones), pieces boxwood / ebony.
Metal: MeshStandardMaterial metalness ≈ 1, roughness ≈ 0.25–0.4, relies on scene.environment; pieces polished silver / gunmetal.
Glass: MeshPhysicalMaterial transmission 1, thickness, ior 1.5, slight tint; the board squares stay opaque-ish frosted so pieces read.
`setPalette` recolours in place (no material re-creation) so the settings sliders are live.

## `three/pieces.js` + `three/pieceLayer.js`

```js
export const BUILTIN_SETS = [ {id:'staunton', name:'Staunton'}, {id:'minimal', name:'Minimal'}, {id:'glyph', name:'Flat glyph'} ]
export function listSets() → [{id, name, kind:'builtin'|'gltf'}]
export function createPiece(role, color, setId, matSet) → THREE.Object3D
     // origin at base centre on y=0, footprint ≤ 0.8 units, heights: pawn .55 knight .75 bishop .8 rook .7 queen .95 king 1.05 (approx, set may vary)
     // userData = { role, color, square:null }; knights face +Z for white and −Z for black (toward the opponent) — pieceLayer rotates by colour.
     // 'glyph' = flat upright card with the cburnett SVG glyph as a texture (inline SVG → CanvasTexture); always faces the camera (billboard) or lies flat; the implementation picks one and documents it.
export async function registerGltfSet({ id, name, url?: string, file?: File, mapping: { pawn:'NodeName', …, king }, scale?: number, keepMaterials?: boolean }) → set descriptor
     // loads with GLTFLoader, clones the named nodes per role; colour by tinting the whitePiece/blackPiece material unless keepMaterials.
export function applyMaterials(pieceObj, matSet)                  // swap materials on theme change

export function createPieceLayer(scene, matSet, settings) → layer
layer.group
layer.sync(pieces: {square, piece}[], opts: { animateFrom?: {from,to,captured?,castle?,promotion?}, instant?: boolean })
     // reconcile meshes to the position. With animateFrom: slide the moved piece (and the rook on castling), fade the captured piece, swap on promotion.
layer.meshAt(square) → Object3D | null
layer.squareOf(obj) → square | null                                // walks up parents to find userData.square
layer.lift(square) / layer.dragTo(worldPoint) / layer.drop(square | null)   // drag visuals: lift ~0.35, follow the pointer, settle (or snap back when null)
layer.setSet(setId), layer.setMaterials(matSet)
layer.pieceObjects() → Object3D[]                                  // raycast targets
layer.dispose()
```

## `three/board.js` — board + overlays (highlights, arrows, labels)

```js
export function createBoard(scene, matSet, settings) → board
board.group
board.worldFor(square) → THREE.Vector3            // square centre, y = 0
board.squareAtPoint(worldPoint) → square | null   // inverse (null off-board)
board.squareMeshes: Map<square, Mesh>            // raycast targets
board.setCoordinates(bool)                        // file/rank labels on the frame (CanvasTexture or CSS2D), flip-aware via setOrientation
board.setOrientation('white'|'black')             // only affects label placement
board.setSelected(square|null), board.setLegalTargets(squares[], captureSquares[])   // dots / rings
board.setLastMove(from, to | null), board.setCheck(square|null)  // soft red glow on the king's square
board.setHighlights(Highlight[]), board.setArrows(Arrow[])         // user/ai arrows; knight arrows drawn as an L; arrow colour = settings.arrowColors[color]
board.setPreviewArrow(Arrow | null)                                // live preview while right-dragging
board.setEngineArrow(uci | null)                                   // distinct look (dashed / thinner / theme accent), never stored
board.setNoteLabel(square | null, text)                            // CSS2D floating card above the square (or above the board edge when square is null); empty text hides it
board.setMaterials(matSet), board.setArrowColors(colors)
board.dispose()
```
Overlays sit just above the board (y ≈ 0.005–0.02) with `depthWrite=false` and a render order so they never z-fight.
Arrows are meshes (shaft + head) built from a 2-D path on the board plane: straight for normal moves, L for knight jumps.

## `three/interact.js` — pointer → actions

```js
export function createInteraction({ view, board, layer, store, actions }) → { dispose() }
```
Behaviour (Play mode):
- Left **click** a piece: select it (actions.select) → legal dots. Click a target → `actions.attemptMove`. Click elsewhere → deselect. Click another own piece → reselect.
- Left **drag** a piece: `layer.lift`, follow the pointer on the board plane, drop → attemptMove(from, squareUnderPointer) ; illegal/off-board → snap back. Disable OrbitControls during the drag (view.setControlsEnabled(false)); re-enable after.
  Drag threshold ~4 px so a click stays a click. Both sides are movable by anyone (no ownership lock). Any piece of the side to move.
- A drag that starts on an empty square, or on a piece of the side NOT to move, orbits the camera (fall through to controls).
  Exception: in Setup mode any piece can be dragged anywhere (actions.setupPlace) and dragging off the board removes it.
- Right **click** (no drag) on a square: `actions.toggleHighlight(square, color)`. Right **drag** square→square: `actions.toggleArrow({from,to,color})`.
  Colour by modifier: none = green · shift = red · alt = blue · ctrl = yellow (chess.com convention). Show a live preview arrow while dragging (board.setPreviewArrow).
- Double-click a piece → `view.focusOn(mesh)`. Double-click empty board → `view.setPreset(orientation)`.
- Hover: cursor changes to grab over a movable piece.
- `contextmenu` is prevented on the canvas. Touch: tap-tap moves; long-press = right-click highlight; no arrows on touch (v0).
- Promotion: `attemptMove` returns 'promotion' → the UI (not this module) shows the picker.
Interaction reads `store.state.mode`, `selected`, `legalTargets`, `settings.showLegalMoves` and listens to `selection:change` to drive `board.setSelected/ setLegalTargets`.

## `engine/stockfish.js`

```js
export function createEngine(store, actions) → engine
engine.ready: Promise<void>
engine.start() / engine.stop()          // analysis on/off; the engine also listens to settings:change 'engine.enabled' and to position:change
engine.analyse(fen, { multipv, depth, movetime, chess960 })   // restarts search for the current position; streams actions.engineLines(...)
engine.bestMove(fen, { movetime|depth, skill, elo, chess960 }) → Promise<uci>   // for play-vs-engine
engine.setPlayAs(color | null)          // when it is that colour's turn in Play mode, think and actions.playMove(); respects settings.engine.skill / elo (UCI_LimitStrength + UCI_Elo)
engine.dispose()
```
Worker loading — two modes, decided at runtime:
1. **Folder / hosted:** `new Worker('vendor/stockfish-19-lite-single.js')` (relative to the page; the glue loads the `.wasm` next to itself).
2. **Single-file:** `build.mjs` inlines the glue as `<script type="text/plain" id="sf-glue">` and the wasm as base64 in
   `<script type="text/plain" id="sf-wasm">`. When `#sf-wasm` exists, build a Blob worker from
   `preamble + glue` and start it as `new Worker(blobUrl + '#inline.wasm')`. (**Correction 2026-09-17:** an earlier draft said
   `'#inline.wasm,worker'`; the `,worker` token marks an Emscripten pthread helper and makes the single-threaded glue load nothing.) The preamble shims `self.fetch` so
   that a request for a URL containing `inline.wasm` returns `fetch('data:application/wasm;base64,' + B64)`; every other URL
   falls through to the original fetch. (The glue reads the wasm URL from `location.hash` and fetches it; `instantiateStreaming` is fine with a data-URL Response.)
   About the glue (`vendor/stockfish-19-lite-single.js`, minified, ~21 KB): worker mode is auto-detected inside a dedicated worker; UCI text goes in with `worker.postMessage('uci')` and comes back as string messages.
Protocol: `uci` → wait `uciok`; `setoption name UCI_Chess960 value true` when the game is 960; `setoption name MultiPV`; `position fen … ` (or `startpos moves …`);
`go depth N` / `go movetime M` / `go infinite`; parse `info depth … multipv k score cp|mate … pv …`, `bestmove`. Always `stop` and wait for `bestmove`
before sending a new position (or use `isready`/`readyok`). Score is reported from the side to move — convert to White's view for the store.
Eval bar / lines / best-move arrow are driven by `actions.engineLines`. Debounce re-analysis on `position:change` (~150 ms).

## `ai/` — packet, window.chess API, providers, chat

`ai/packet.js`:
```js
export function buildPacket(state, opts = { includeEngine:true, includeLegalMoves:false }) → string   // the text an AI reads
export function buildContext(state) → object   // same content as JSON (for providers' structured use and window.chess.getState())
```
Packet (plain text, stable headings; this is what a person pastes into a chat and what an AI reads):
```
== Chessboard ==
variant: standard            (or chess960 #518)
start_fen: …
fen: …
turn: white
move_number: 12  ply: 23  line: main   (or: variation, branched at move 9…)
history: 1. e4 e5 2. Nf3 Nc6 3. Bb5 (3. Bc4 Bc5) 3... a6   ← path root→current; sibling variations shown in parentheses at branch points on the path
last_move: Bb5 (f1b5)
status: check | checkmate | stalemate | draw (…) | playing
legal_moves: (only when requested)
arrows: g1->f3 green (knight L), e2->e4 red
highlights: d5 red, e5 green
note: "…"                     (current node's note; also NAG if any)
study_notes: "…"
engine: depth 20  eval +0.35 (White)  best Nf3
  1) +0.35  Nf3 Nc6 Bb5 …
  2) +0.20  …
```
`ai/api.js` — `window.chess` (installed by main.js; an AI with a browser tool, or a person at the devtools console, drives the board through it):
```js
window.chess = {
  version, getState() → buildContext, getPacket(opts) → string, getFen(), getPgn(), getYaml(), getLegalMoves() → san[],
  move(sanOrUci) → { ok, san, fen } | { ok:false, error },  moves([...]) plays several,
  goto(ply | nodeId) , back(), forward(), toStart(), toEnd(),
  setFen(fen), loadPgn(text), loadYaml(text), newGame(), chess960(n?) → number,
  arrow(from, to, color='green'), arrows([...]), highlight(square, color='green'), highlights([...]), clearAnnotations(),
  note(text) /* current node */, noteAt(ply|nodeId, text), studyNotes(text), title(text),
  annotate({ arrows?, highlights?, note?, nag? })   // one call for an AI reply
  engine: { start(), stop(), lines() → state.engine.lines, playAs(color|null) },
  view: { preset(name), flip(), focus(square) },
  setup: { mode(bool), place(square, 'wP'|'bK'|null), commit() },
  on(event, fn) → unsubscribe  // store events
}
```
`ai/providers.js`:
- `packet` (default): no network. The AI panel shows the packet with a **Copy** button, and a **Paste reply** box: the reply is shown in the chat log and any fenced ```chess block in it is parsed as JSON `{ arrows, highlights, note, nag, moves }` and applied via `annotate`/`moves`.
- `local`: OpenAI-compatible `POST {localUrl}/chat/completions` (llama.cpp on 127.0.0.1:8080, no key). Streaming optional.
- `anthropic`: `POST https://api.anthropic.com/v1/messages` from the browser with headers `x-api-key`, `anthropic-version`, and `anthropic-dangerous-direct-browser-access: true`. Key from localStorage (settings panel field, masked, never exported).
System prompt for local/anthropic: explain the packet, ask for concise coaching, and that any drawing/notes must come as ONE fenced ```chess JSON block: `{"arrows":[{"from":"g1","to":"f3","color":"green"}],"highlights":[{"square":"d5","color":"red"}],"note":"…"}`; suggested moves as SAN in `"moves"` are NOT auto-played unless the user clicked "let the AI move".
Every provider call includes the packet as the user message prefix + the user's question.
`ai/chat.js`: `createAi(store, actions) → { ask(question) → Promise<void>, applyReply(text), setProvider(id), getKey()/setKey(), dispose() }`.

## `ui/` — panels, move list, settings, dialogs

Files: `ui/index.js` (`mountUi({ store, actions, engine?, ai?, view?, pieces? }) → ui` — wires everything below), `ui/layout.js` (shell, tabs, responsive, resize handle),
`ui/topbar.js`, `ui/moveList.js`, `ui/enginePanel.js`, `ui/aiPanel.js`, `ui/notesPanel.js`, `ui/ioPanel.js`, `ui/settingsPanel.js`,
`ui/dialogs.js` (promotion picker, confirm, toast), `ui/keys.js` (← → ↑ ↓ Home End navigate; F flip; L legal toggle; E engine toggle; Esc deselect; Ctrl+Z = back), `styles.css`.
`index.html` holds only the shell skeleton (`#app > #stage(canvas host) + #panel`); the ui module builds panel contents from JS.
Move list: chess.com/lichess look — `1. e4 e5 2. Nf3` … variations inline in parentheses, indented, collapsible; current move highlighted;
click = goto; right-click / … menu = promote / make main / delete from here; NAG glyphs; a small note icon when a node has a note;
eval bar beside the board (vertical, White at the bottom when orientation is white). Engine panel: on/off, MultiPV, depth,
lines (click a move to play it), "play as" selector + strength (skill 0–20 / Elo). AI panel: provider select, packet preview, chat log,
question box, "Ask", "Paste reply", "Copy packet", "Let it move". Notes panel: title, study notes, current-move note, NAG picker.
IO panel: FEN field (live, copy, load), PGN textarea (load/copy/download), YAML (load file / paste / download), Chess960 (number field + random),
Setup mode (piece palette, turn, castling, clear/start, commit), Share link (URL hash). Settings: theme, palette colour inputs
(+ reset), piece set (+ "Add glTF set…" file input with node-name mapping), toggles (legal / coords / last move / engine arrow / 3D notes / eval bar / shadows / animations / auto-rotate),
arrow colours, UI theme, camera presets, keyboard cheat-sheet, About (Stockfish GPLv3 notice, cburnett CC BY-SA 3.0, Three.js MIT, chessops GPLv3).
Design: quiet, modern sans (IBM Plex Sans / Newsreader via Google Fonts with system fallbacks), tokens on `:root`, dark mode via
`prefers-color-scheme` guarded by `:root:not([data-theme="light"])` and `:root[data-theme="dark"]`; 16 px gutters; works at 420 px wide
(panel becomes a bottom drawer under the canvas). No help prose on the page beyond tooltips; the About tab holds the cheat-sheet.
The ui talks to engine/ai only through `actions` + store events, plus the objects passed into `mountUi` for direct calls (e.g. `ai.ask`, `engine.start`).

## `main.js` — wiring

Order: store.restore() or new game → createView → createMaterialSet → createBoard → createPieceLayer → createInteraction →
mountUi → createEngine → createAi + window.chess → decodeHash → first sync. Subscribes to store events and pushes to board/layer/view.


---

# Addendum v1 (2026-09-18) — pieces, 2D/3D modes, self-play, clock, MCP

This addendum records the brief for a change that has since been built: the problems it names are the state before it, and "Addendum v1 — as built" below says what landed.

This addendum covers: (1) the pieces are blocky and hard to read, (2) a **2D mode locked to top-down**
that switches to 3D **in the same scene**, pieces becoming flat tokens, (3) **self-play** with an
animated board rotation instead of a hard flip, a **clock**, and an opponent of *self / Stockfish / AI
over MCP*, (4) **white pieces are hard to see against light squares** — the lighting must be adjustable
and switchable off. It overrides the v0 text where they disagree.

## New vocabulary

- **View mode** — `'3d'` (orbit, sculpted pieces) or `'2d'` (locked top-down, flat tokens). One scene;
  switching is an animated transition, never a reload. The board, the pieces and the camera all react.
- **Seat rotation** — in self-play the board turns to the other player's side as a continuous ~700 ms
  rotation about the board's centre (Y axis). It replaces the instant flip. Optional
  (`settings.selfPlay.rotate`); when off the seat changes instantly, as `flip` does today.
- **Token** — the flat piece used in 2D: a disc carrying the piece glyph, readable from straight above.

## Settings (added to `SETTINGS_DEFAULTS`; core owns them)

```js
viewMode: '3d',                 // persisted; restored at boot
pieceSet2d: 'glyph',            // the set used while viewMode === '2d'
lighting: {
  preset: 'studio',             // 'studio' | 'soft' | 'bright' | 'flat'
  on: true,                     // false = flat/unlit shading (see below)
  exposure: 1.0,                // 0.4 .. 1.8   renderer.toneMappingExposure
  key: 1.0,                     // 0 .. 2       key light multiplier
  ambient: 1.0,                 // 0 .. 2       hemisphere/fill multiplier
  shadows: true,                // mirrors the existing settings.shadows
  contrast: true,               // the piece-separation aid (rim + contact shadow), independent of lights
},
selfPlay: {
  rotate: true,                 // animate the seat rotation after each move
  autoFlip: true,               // change seats at all (false = stay on one side)
  opponent: 'self',             // 'self' | 'engine' | 'ai'
  timeControl: { initial: 300000, increment: 0 },   // ms; initial 0 = untimed
},
```

## `core/store.js` — state, actions, events

```js
state.viewMode : '3d' | '2d'
state.selfPlay : { on:false, opponent:'self'|'engine'|'ai', awaiting:null|'white'|'black' }
state.clock    : { running:false, white:ms, black:ms, turn:'white'|'black'|null,
                   increment:ms, initial:ms, flagged:null|'white'|'black', startedAt:null }
```

```js
actions.setViewMode(mode)            // '2d' | '3d'; persists to settings; emits 'viewmode:change' { mode, previous }
actions.toggleViewMode()
actions.startSelfPlay(opts?)         // { opponent?, timeControl? } -> resets + starts the clock, sets selfPlay.on
actions.stopSelfPlay()               // stops the clock, clears selfPlay.on; the game and tree are untouched
actions.setSelfPlayOpponent(id)
// clock (core/clock.js does the arithmetic; store owns the state)
actions.setTimeControl({ initial, increment })   // resets both sides; refuses while running
actions.clockStart() / clockPause() / clockResume() / clockReset()
actions.clockFlag(color)             // called by the ticker; sets flagged, stops, toasts, ends the game as a loss on time
```

Events: `'viewmode:change' { mode, previous }` · `'selfplay:change' { selfPlay }` ·
`'clock:tick' { white, black, turn, flagged }` (emitted at most every 200 ms while running) ·
`'clock:change' { clock }` (structural: start/pause/reset/time-control/flag).

Clock rules (`core/clock.js`, pure, unit-tested):
- The side to move burns time. A played move adds `increment` to the side that just moved, then switches.
- `initial: 0` means untimed: `running` stays false, nothing ticks, the UI hides the clock.
- Navigating the tree (`goto`/`back`) does **not** touch the clock; only `playMove` does.
- Reaching 0 flags that side once, stops the clock, and ends the game (`status().outcome` is unaffected —
  the clock loss is reported through `state.clock.flagged` and a toast; do not fake a checkmate).
- Time is derived from a monotonic stamp passed *in* (`Date.now` is forbidden in core's pure module —
  `clock.js` takes `now` as a parameter; the store's ticker supplies it).

Self-play rules:
- `selfPlay.on` with `opponent: 'self'` means: after every played move, if `settings.selfPlay.autoFlip`,
  the orientation changes to the side now to move (`actions.setOrientation`), which the view animates.
- `opponent: 'engine'` delegates to the existing `engine.setPlayAs(...)` for the side the player is not playing.
- `opponent: 'ai'` sets `selfPlay.awaiting` to the side the AI must move and lets `ai/mcpBridge.js` answer.
- Self-play never changes the rules: both sides stay movable by hand (no piece locking, per the v0 rule).

## `three/scene.js`

```js
view.setViewMode(mode, { animate = true })   // '2d' locks the camera to straight overhead and disables orbit;
                                             // '3d' restores the previous 3D camera pose. Returns a Promise that
                                             // resolves when the transition ends.
view.viewMode                                // getter
view.rotateSeat(orientation, { duration = 700, animate = true }) -> Promise
    // Continuous rotation about the board centre to the given seat. In 3D it orbits the camera; in 2D it spins
    // to the other side so the player to move reads the board upright. Replaces flipTo for self-play; flipTo stays
    // for the manual Flip button and may delegate here.
```
2D mode specifics: the camera looks straight down (polar 0) at a distance framing the whole board with the
frame visible; **orbit is disabled** (`controls.enableRotate = false`), pan and zoom stay on, and the polar/azimuth
limits are pinned so nothing can tilt it. Use an orthographic projection if the perspective distortion is visible
at the corners, as long as the switch does not break `raycast` / `pointerToPlane` (the interaction module
depends on both, and `board.squareAtPoint` must keep working). Restore the exact 3D pose on the way back.

## Lighting and contrast

**The problem: white pieces are hard to see against the white squares.** Confirmed from a top-down
capture — a white piece on a light square has almost no edge. Fix it from both sides.

`three/scene.js` (lights):
```js
view.setLighting(patch)   // { preset?, on?, exposure?, key?, ambient?, shadows? } — applied live, no reload
view.lighting             // the resolved current values
```
- Presets set sensible groups: `studio` (today's look), `soft` (lower key, higher ambient, gentler shadows),
  `bright` (higher exposure and ambient for a lit room), `flat` (see below).
- **`on: false` / preset `flat` = lighting off**: render pieces and squares at their own colour with no
  shading, so shape reads purely as silhouette and contrast is maximal. Implement it as a material switch
  (`MeshBasicMaterial`-style unlit response) rather than by zeroing the lights, which would just make
  everything black. `scene.environment` must be neutralised in this mode too, or metal and glass go dark.
  `materials.js` exposes the unlit variant; `scene.js` asks for it.
- Every knob is live and persisted through `settings.lighting.*`.

`three/materials.js` (materials):
```js
createMaterialSet(theme, palette, { unlit = false })   // additive third argument; existing calls unchanged
matSet.setUnlit(bool)                                  // live switch, keeps colours and palette
```
- **`settings.lighting.contrast` — the separation aid, and the real fix.** Independent of the lights: give the
  white pieces a subtly darker edge so they never merge into a light square. A rim/edge darkening on the piece
  material plus a soft **contact shadow** under every piece (a small dark radial decal on the square beneath,
  drawn even when `shadows` is off) is the cheapest reliable answer. It must hold in 2D top-down, in the
  `flat` lighting mode and on all three themes — check a white piece on a light square in each.
- Also raise the default contrast between the two square colours slightly if that is what is washing the
  pieces out, but the piece edge is the primary fix: the palette is the user's to change and must keep working.

## `three/board.js`

```js
board.setViewMode(mode)   // 2D: flatten the frame, drop the bevel/thickness shading to a clean 2D look,
                          // put file/rank labels on all four edges, keep overlays legible from above.
```
Overlays (arrows, dots, highlights, the check glow, note cards) must read correctly in both modes; arrows
especially, since in 2D they are seen head-on.

## `three/pieces.js`

The v0 Staunton set reads as blocky from the seat and as featureless blobs from above. Rework it:
- **More profile points and more lathe segments** so the silhouette is smooth, not stepped. Curves where a
  turned piece has curves (the vase of the bishop, the flare of the king's collar, the pawn's neck).
- **Distinct silhouettes.** King clearly tallest with a cross; queen slightly shorter with a proper coronet;
  bishop with a mitre and its slit; rook with real crenellations and a hollow top; knight a carved head with
  a mane, not a slab. Someone must tell them apart at a glance from the seated camera.
- **Proportion pass.** Pieces currently look squat for their squares. Keep the contract's footprint limit
  (≤ 0.8 units) but re-tune heights for a Staunton-like ladder; the king may go to ~1.15.
- Keep the exported names (`createPiece`, `PROFILES`, `HEIGHTS`, …) and the `userData` shape. The existing
  profile tests must still pass (update the expected numbers if a height changes on purpose).
- **The 2D token set** lives here too: make `'glyph'` genuinely good top-down — crisp glyph, a readable rim,
  clear light/dark contrast — because it is what 2D mode uses. Add `BUILTIN_SETS_2D` listing the sets suitable
  for 2D (`glyph` and any other flat set you add).
- Watch the cost: piece geometry is built per set and cached; do not regress the theme-switch time.

## `three/pieceLayer.js`

```js
layer.setViewMode(mode)   // swap to settings.pieceSet2d in 2D and back to settings.pieceSet in 3D,
                          // animated as a short cross-fade; keeps squares, selection and any drag intact.
```
The layer must keep working mid-drag and mid-animation across a mode switch (cancel cleanly rather than
stranding a lifted piece). Tokens lie flat and must stay upright for the **current orientation**, including
during a seat rotation.

## `three/interact.js`

In 2D: left-drag on empty board must **not** orbit (the camera is locked); everything else — click-move,
drag-move, right-drag arrows, right-click highlights, double-click focus — behaves as in 3D. Dragging a piece
still lifts it slightly so it reads above the board. Re-check the raycast path against whatever projection
`scene.js` uses in 2D.

## `ui/`

- **View toggle** in the topbar: `2D / 3D`, showing the current mode, keyboard `V`.
- **Self-play panel** (its own tab or a block in Engine, kept findable): start/stop, opponent
  selector (Yourself / Stockfish / AI over MCP), time-control presets (untimed, 1+0, 3+2, 5+0, 10+0, 15+10,
  custom), `rotate` and `autoFlip` switches.
- **Clock**: two readouts, the side to move highlighted, low time under 30 s in the warning colour, flagged
  state obvious. Visible only when a time control is set. It must be readable in the bottom-drawer layout too.
- Settings: 2D piece set selector, and the self-play switches mirrored.
- **Lighting block in Settings**: preset segmented control (Studio / Soft / Bright / Flat), a master
  **Lighting on/off** switch, sliders for Exposure, Key and Ambient with their numeric values, the Shadows
  toggle moved in beside them, and the **Piece contrast** switch. A "Reset lighting" button. Changing a slider
  writes through `actions.setSetting('lighting.<key>', v)` on `input` (it is a live 3D preview, so immediate
  feedback is the point) but must not thrash: coalesce to animation frames if needed.
- Everything through `actions` + store events, as before.

## `ai/mcpBridge.js` — the optional loopback bridge

The page stays serverless by default. The bridge is **opt-in** and is one way to seat an "AI over MCP"
opponent: it talks to a separate MCP server on `http://127.0.0.1:8152`. That server is not part of this
repository and is not shipped; the built-in way for an AI to connect is the `rukh` program's own MCP
endpoint ([architecture.md](architecture.md), [program.md](program.md)). This section is what the page sends
and expects, so any server that speaks it can drive the board.

`src/ai/mcpBridge.js`: `createMcpBridge(store, actions, { url }) -> { enable(), disable(), dispose(), status(), isEnabled(), publish(), poll(), applyCommand(cmd), url }`.

- `POST /state` — the page publishes on enable, on every `position:change` and `selfplay:change`, after
  any command that changed something, and every 3 s while a move request is outstanding. Body (JSON):
  `protocol: 1`, `variant`, `chess960`, `start_fen`, `fen`, `turn`, `move_number`, `ply`, `line`, `history`
  (SAN), `last_move`, `status`, `legal_moves` (SAN), `arrows`, `highlights`, `note`, `title`, `mode`,
  `orientation`, `view_mode`, `self_play`, `opponent`, `ai_style`, `awaiting`, `clock` (`{ white, black,
  running, flagged }` in ms, or `null` when untimed), `packet` (the text packet) and `at` (ISO time).
  The reply may carry `since`; a value below the page's cursor means the server restarted, and the cursor
  rewinds to it.
- `GET /commands?since=n` — polled about every 700 ms. Reply `{ seq, commands: [{ seq, op, args }] }`.
  Commands with `seq <= since` are skipped; a `seq` below the cursor rewinds it.
- `POST /ack` — `{ acks: [{ seq, ok, result, error }] }`, one per command applied. A refused move is still
  acked, with `ok: false` and the reason.
- Ops the page applies, all through `actions`: `play { move }` (SAN or UCI; leading move numbers and
  trailing `!`/`?` stripped), `annotate { arrows, highlights, note, nag }`, `set_fen { fen }`, `new_game`,
  `goto { node_id }`, `back`, `forward`, `ping`, `refresh`. Anything else is refused as unknown.
- Never throws into the app; a dead server sets a status the UI can show and retries with backoff
  (700 ms doubling to 10 s). Each request times out after 4 s.
- Wired to `selfPlay.opponent === 'ai'`: when `selfPlay.awaiting` names a colour, the published
  `awaiting` field is the request for a move.
- Keep it entirely optional: with the bridge disabled nothing polls, nothing is fetched, and the page
  behaves exactly as it does without it.

## Test and check rules

`node --test` must pass for every changed module. Windows: ASCII console output in node scripts.

## Addendum v1 — as built (2026-09-18)

Where the code differs from, or adds to, the text above:

- **Piece heights changed.** The v0 ladder is superseded: pawn 0.58 · rook 0.70 · knight 0.80 ·
  bishop 0.88 · queen 1.02 · king 1.18, with narrower bases (height/width ≈ 2.03, was ≈ 1.7).
  Anything that frames a camera or sizes a lift from piece height should read `HEIGHTS`, not a constant.
- **`createMaterialSet(theme, palette, { unlit, contrast })`** — third argument is additive; two-argument
  calls are unchanged. The set gained `setUnlit`, `setContrast`, `whiteAccent`, `blackAccent`, `contactShadow`.
- **`main.js` must call `view.setMaterialSet(matSet)`** after `createMaterialSet` and after every theme
  change, or the lighting master switch never reaches the materials.
- **`actions.registerEngine(engine)`** must be called once after `createEngine`, or self-play against
  Stockfish only sets state and the engine never actually moves.
- **The piece layer holds two set slots** (`setSet` for 3D, `setSet2d` for 2D) so a 2D session cannot be
  clobbered by a `pieceSet` change, and `setOrientation(o, { animate, duration })` now animates.
- **2D is a narrowed perspective camera** (fov 12 at a fitted distance), not an orthographic one, so
  `view.camera` stays a `PerspectiveCamera` and raycasting is unchanged. Polar is pinned just off zero
  so the azimuth stays defined and `rotateSeat` is the same code in both modes.
- **A superseded 2D → 3D transition restores the lens** (fov/near/far/zoom/up) even though the superseding
  command keeps the camera's position, and `setPreset` always re-establishes `FOV_3D`. Without both, clicking
  a View preset during the transition would leave the 2D lens in 3D mode permanently.
- **The clock is shown only while a timed game is under way** (running, started, flagged, or self-play on),
  not merely because a time control is configured — the board is an analysis tool most of the time.
- New store event **`mcp:change`**; `window.chess.mcp` added to the public API; `selfPlay.playerSide` added
  to the state; the clock is deliberately **not** persisted (only its time control is).

# Addendum v2 (2026-09-18) — the live seat: real-time play against an AI

**The goal.** The player moves on the board; that act alone prompts the AI, which answers with a move.
No button, no copied packet, no typed turn. The move *is* the prompt.

**What already existed and does not change:** the page publishes on every position change; the published
payload carries `awaiting: 'white'|'black'|null`, which is the request for a move; the page polls
`/commands?since=n` at 700 ms and acks what it did. That loop is untouched.

**What this addendum adds:** a page cannot start an AI's turn, so an AI playing live has to be watching
for requests; and the kind of opponent (silent / annotating / coaching) has to be a property of the board,
not something restated in every conversation.

## New vocabulary

| Term | Meaning |
|---|---|
| Live seat | An AI client watching for `awaiting` requests and answering them as they appear |
| Style | What kind of opponent the AI is: `silent`, `annotate`, `coach`. The page owns it; the AI obeys it |
| Request | One published state with `awaiting` naming a colour. Identified by `(fen, awaiting)` |

## Settings (added to `SETTINGS_DEFAULTS.selfPlay`; core owns them)

| Key | Type | Default | Meaning |
|---|---|---|---|
| `selfPlay.aiStyle` | `'silent' \| 'annotate' \| 'coach'` | `'annotate'` | What the AI opponent does besides move |

`core/store.js` exports `AI_STYLES` (a `Set`) and `normalizeAiStyle(value)`, which returns a valid style for
any input, `'annotate'` for junk. Anything reading the style goes through `normalizeAiStyle` — a stored
settings blob from an older build, or a hand-edited one, must never publish an unknown style.

**Style contract (what the AI must do), normative:**

- `silent` — play the move. Do not annotate, do not note. Nothing on the board but the move.
- `annotate` — play the move, and attach to *that* node one short note (why) plus at most two arrows and
  two highlights. Never annotate any other node.
- `coach` — `annotate`, plus: if the player's previous move was a clear mistake, say so in the note and draw the
  refutation. Judgement call, not an engine verdict; silence is correct when the move was fine.

## `ai/mcpBridge.js`

- The published payload gains **`ai_style`**, always one of the three strings, normalized at publish time.
  It sits next to `opponent` and `awaiting` as part of the request, so the AI needs no out-of-band config.
- No change to publish cadence, backoff, polling, or the command/ack path.

## `ui/`

- The Self-play block gains a **Style** segmented control (Silent / Annotate / Coach) writing
  `selfPlay.aiStyle`. It is shown only when the opponent is `ai` — the setting is meaningless otherwise,
  and the panel stays minimal.
- `readSelfPlaySettings()` returns a normalized `aiStyle`, so the panel is safe against a stale settings blob.
- No on-page explanation of the styles beyond the control's `title` tooltips.

## Addendum v2 — as built

- `settings.selfPlay.aiStyle` is validated by `normalizeAiStyle` at **publish** time, not at write time —
  `setSetting` takes any path, so the guarantee has to sit where the value leaves the page.

## Test rules for this addendum

- `normalizeAiStyle` maps each valid style to itself and every junk input (`undefined`, `''`, `'COACH'`,
  numbers, objects) to `'annotate'`.
- The published payload carries a valid `ai_style` even when `settings.selfPlay.aiStyle` is junk.

---

## Building and checking

- `npm run build` (`node build.mjs`) writes `dist/` and, unless `--no-single` is passed, `../chessboard.html`.
  To check that one module compiles: `npx esbuild src/<dir>/<file>.js --bundle --format=esm --outfile="<temp dir>/check.js" --log-level=warning`.
  For pure modules add `test/<module>.test.mjs`, run with `node --test`.
- Windows consoles are often cp1252: keep any `console.log` in node scripts ASCII.
