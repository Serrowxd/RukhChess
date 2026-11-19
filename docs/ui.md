# The web UI (web/src/ui)

The panel, topbar, dialogs and keyboard bindings of the web board. Everything here is plain DOM code with no framework. It reads `store.state`, listens to store events, and changes things only through `actions` (and a few module objects such as `engine` and `ai`).

## Files

- `index.js` exports `mountUi`. It builds the layout, the six tabs, the clock, the topbar, dialogs and keys, and routes store events to panel updates.
- `layout.js` is the panel shell: tab strip, pages, eval bar, resize handle, collapse rail and the bottom drawer under 900 px. It also exports the small DOM and format helpers every other file uses (`el`, `button`, `field`, `toggleRow`, `segmented`, `openMenu`, `copyText`, `fmtEval`, `winPct`, `moveNumbering`, `PIECE_GLYPHS`, `debounce` and more). There is no separate dom.js, so they live here.
- `openMenu` puts focus on the first item that can act. Up, Down, Home and End move between the items, and Escape closes the menu. When the menu was used from the keyboard, focus goes back to the control that opened it.
- `topbar.js` is the floating toolbar over the canvas and the status chip in the bottom-left corner.
- `moveList.js` is the Moves tab.
- `enginePanel.js` is the Engine tab. It mounts the Self-play block from `selfPlayPanel.js` as its first section.
- `selfPlayPanel.js` is the Self-play block: opponent, AI style, time control, clock transport and the rotate / change-seats switches.
- `aiPanel.js` is the AI tab.
- `notesPanel.js` is the Notes tab.
- `ioPanel.js` is the I/O tab, including Setup mode.
- `settingsPanel.js` is the Settings tab.
- `clock.js` is the two-sided game clock.
- `dialogs.js` holds the modal dialogs (confirm, prompt, promotion picker) and the toasts.
- `keys.js` holds the global keyboard bindings and the cheat-sheet rows.
- `playPanel.js` is used only when the page is connected to the Rukh program.
- `boardTabs.js` is the board strip, also used only when connected. In code and CSS the program's tabs are "boards" (`b-tabs`), so they never mix with the panel's own tabs.
- `styles.css` holds all UI styles.

Every panel factory returns an object with at least `el`, `update` and `dispose`.

## Update scheduling

`index.js` maps each store event to the parts of the UI it affects (`EVENT_MAP`). An event only marks those parts dirty. One flush per animation frame then calls `update()` on each dirty part. A panel on a hidden tab stays dirty and is updated when its tab is shown. The first paint updates everything at once.

`clock:tick` is not in the map. The clock fires up to five times a second, and `clock.js` listens to it directly.

## The clock

The clock lives in a slot above the tab strip, so it shows on every tab, in the collapsed rail and in the bottom drawer.

Its element tree is built once. A tick only writes text-node values, and only when the formatted string changed. Class changes are guarded by cached booleans. Nothing replaces children after mount, so a 5 Hz tick costs almost nothing.

The clock is hidden while the game is untimed. It also stays hidden while a time control is only configured: the board is an analysis tool most of the time, so the clock appears only once a timed game is under way (self-play running, the clock started, or a side flagged).

## Engine lines

The engine pushes a snapshot about every 60 ms with fresh node counts but usually the same lines. `enginePanel.js` keys the lines table on everything it draws and skips the rebuild when the key is unchanged. Rebuilding would swap the move spans out from under the pointer between pointerdown and pointerup and eat the click.

## Move list

The main line is drawn as rows of number, white move, black move. Variations are indented blocks in PGN order; short leaf variations (two moves or fewer) are drawn inline in parentheses.

When a move is printed before its alternatives, the next iteration skips it. The "force a move number" flag must survive that skipped iteration, so it is cleared only when a token is actually emitted.

## Notes

Typing in the move note is debounced by 200 ms. The queued save remembers which node the note was typed for, because the engine or the API can move the board while the user types. Core has no action that sets a note on a given node, so the save does goto, setNote, goto back (the same as `noteAt` in ai/api.js). When the current node changes, the pending save is flushed to the old node before the box is rebound.

## AI tab

The provider is Packet (copy and paste), a local llama.cpp server, or the Anthropic API. In packet mode the typed question rides along when the packet is copied. The API key is stored only in this browser and never exported.

If `chat.js` gives up before logging the user's turn (missing key, packet error, already busy), the question is put back in the box instead of being lost.

## I/O tab and Setup mode

Dropped files are read as strict UTF-8 first, then as windows-1252. `File.text()` would turn a cp1252 'Müller' into replacement characters, and many PGN databases are still cp1252. Valid UTF-8 is never valid-looking cp1252 by accident, so the order is safe.

The setup palette selection (the brush) is `undefined` when nothing is picked, `null` for erase, or a piece. It is exposed as `getBrush()` and broadcast as the store event `ui:setupBrush`, so three/interact.js can use it for canvas clicks. The mini board in the tab makes placement work even without that.

## Settings tab

A glTF piece set lives only in the current session, because the file is not saved, but `settings.pieceSet` is. After a reload the stored id is unknown, so the panel falls back to Staunton and says so, instead of leaving the select blank.

Lighting presets are resolved by three/scene.js. After a preset is written, the panel reads the numbers the view ended up with (`view.lighting`) and writes them back into settings. That keeps `settings.lighting` the one source the sliders read.

`settings.shadows` mirrors `lighting.shadows`, so the Shadows switch writes both.

The 2D piece sets are read through a namespace import of three/pieces.js, so an older pieces.js without `BUILTIN_SETS_2D` does not break the bundle.

## Layout sizes

The panel width (side layout) and height (bottom drawer) are stored in localStorage. A size saved in one viewport is clamped on load and on every resize, so a tall drawer saved in portrait cannot leave the canvas 0 px tall in landscape. Double-clicking the handle resets both.

The renderer is resized only when the stage actually changed size, because a resize clears the canvas and would flicker on every move.

## Dialogs and keys

Only one modal is open at a time. In a modal, Enter runs the OK action unless focus is on a button (which must activate itself, so Cancel cancels) or a textarea (which takes a newline).

Global keys are ignored while typing in an input, textarea, select or contenteditable, and while a modal is open. A focused checkbox does not count as typing: every switch leaves one focused after a click, and it has no key behaviour of its own.

## Connected to the program

When the page is connected to the Rukh program, `playPanel.js` adds an AI chip to the topbar and puts a Play block (seats, style, Start / Stop) in place of the Self-play block. Everything is read from the program's frames through the remote controller in net/remoteSync.js. The only local state is the seat choice before Start.

During a match a seat change is sent at once; before Start it is only the choice that Start will send. The program's next frame confirms or undoes it.

Start and Stop share one button. A click while the last control is still unanswered, or within 400 ms of the label changing, is ignored, so a double click cannot start and stop a match at once.

## Board tabs

`boardTabs.js` adds one row to the topbar: a tab per board, a "+" for a new board, and the line "Boards are not being saved." The line is drawn only when the program says boards are not being saved (it has no data folder, another Rukh holds the folder, or part of the folder cannot be used); when they are saved it is left out and takes no room. When the row is narrow the line gives way first, shrinking to an ellipsis and then to nothing; only after that do the tabs scroll sideways. "+" never shrinks, and the row never wraps. The strip is a grid of three columns: the tab list (as wide as its tabs, down to nothing), "+" at its full width, and the not-saved line in what is left. When the selected tab changes, a name is being typed, or the list's width changes, the list scrolls just far enough to show that tab; other redraws keep the scroll where it was. `contain: inline-size` stops a long row from widening the topbar. The setup line, when shown, takes a second row of its own under the tabs, across the full width of the strip, and wraps onto further lines so the whole sentence can be read; the tab row above it is laid out as it is without it. The narrow layout is checked by eye, not by a test; the tests only read the stylesheet's rules.

- `stripModel(tabs, selected, state)` turns a frame into one entry per tab. Whether a tab has moves is known only for the selected tab, since the frame carries only its state.
- `renderStrip(model, opts)` builds the DOM from that model. `patchStrip(drawn, model, opts)` brings a drawn strip to a new model in place, keyed by tab id: a tab that stays keeps its elements. On a reorder the longest run of tabs already in order stays where it is and only the others are taken out and put back, so moving one tab moves only that tab. So a frame that lands between mouse-down and mouse-up never replaces the button being pressed, and the click still arrives. `renderStrip` is `patchStrip` on nothing.
- The controller redraws only when the model, the tab being renamed, the connection, saving, the closed count or the setup line changes, and keeps focus on the same tab.
- A click selects, and gives focus back so the arrow keys step through the moves. A double-click renames. Two quick clicks on "+" make one board. Each tab has a menu (the dots, a right-click, or Shift+F10) with Rename, Close, Move left and Move right. Move left is off on the first tab and Move right on the last; both are off when there is one tab. The new place is worked out when the item is chosen, from the order the program last sent plus any move of that tab still waiting for its answer. There is no dragging.
- "+" makes a board at once while no closed board waits. When the program says one does, "+" opens a menu with New board and Reopen closed board. It is a button, so Enter or Space opens the menu from the keyboard. A refused reopen is shown like any other refusal.
- Rename is in place: Enter commits, Escape cancels, leaving the field commits. The name shown is always the one in the next frame, which is the program's cleaned name.
- Close asks first when the tab has moves. A tab that is not shown is always asked about, because its moves are not known. When boards are saved and the tab is a free board, the confirm is only "Close «name»?", since the board waits in `closed/`. Otherwise it adds "Its moves and notes will be lost.", because a game or Reps tab cannot be reopened.
- Keys: the tabs are a `tablist` with one tab stop on the selected tab. Left, Right, Home and End move focus without selecting, Enter or Space selects, and F2 or Enter on the selected tab renames. Closing and moving are only in the menu.
- A tab with a mark shows a small dot before its name: a solid gold dot for your move, a hollow gold ring for their move, a hollow grey ring for paused, and a solid grey dot for a finished game. Gold means a match in play (solid when it is yours, hollow when it is theirs) and grey means not in play. The dot never stands alone: the tab's title and accessible name add the mark in words, as in "Board 1, your move". The dot does not animate.
- A window in setup shows a line on its own row under the tabs while the selected board is not the one setup began on: "The board switched to «Board 2». Finish or cancel setup to follow." When that board was closed meanwhile, it says "«Board 1» was closed. Finish setup to put this position on a new board." Names are set as text. The line goes when setup ends.
- The selected tab is scrolled into view when it changes and when the list's width changes, which a `ResizeObserver` reports.
- The strip needs the page's dialogs, so it can ask before a close; without them it is not mounted.
- While a name is being typed the strip is not redrawn, so the field keeps its text; other windows' changes show once it is committed.

## Styles

Colours are defined only as tokens in the `:root` blocks, with a dark set under `prefers-color-scheme` and under `data-theme="dark"`.
