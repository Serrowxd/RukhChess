import { el, icon, openMenu, closeMenu, segmented } from './layout.js';

const LONG_PRESS_MS = 550;

/** Mounts the topbar and status chip into `stage`. Returns { el, chip, update, dispose }. */
export function createTopbar({ store, actions, view, dialogs, stage }) {
  const host = stage || document.getElementById('stage');

  const tb = (label, onClick, title, extra) => el('button', { type: 'button', class: 'tb-btn', title, onclick: onClick }, extra, label);

  const btnNew = tb('New', async () => {
    const g = store.state.game;
    const hasMoves = g && g.root && g.root.children && g.root.children.length > 0;

    if (hasMoves && dialogs) {
      const ok = await dialogs.confirm('Start a new game? The current study is replaced (download it first from I/O if you want to keep it).', { ok: 'New game' });
      if (!ok) return;
    }

    actions.newGame();
  }, 'New game from the standard start position');

  // Click starts a random 960; a long press or right-click asks for a number.
  let pressTimer = 0, longFired = false;

  async function ask960() {
    const cur = store.state.game.chess960Number;
    const v = dialogs ? await dialogs.prompt('Chess960 position number (0–959)', cur != null ? String(cur) : '', { type: 'number', min: 0, max: 959, ok: 'Start' }) : window.prompt('Chess960 position (0-959)');
    if (v == null || v === '') return;

    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 959) {
      actions.toast('Chess960 number must be 0–959', 'error');
      return;
    }

    actions.newChess960(n);
  }

  const btn960 = el('button', {
    type: 'button', class: 'tb-btn', title: 'Random Chess960 start (long-press or right-click to choose a number)',
    onpointerdown: e => {
      if (e.button !== 0) return;

      longFired = false;
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        longFired = true;
        ask960();
      }, LONG_PRESS_MS);
    },
    onpointerup: () => { clearTimeout(pressTimer); },
    onpointerleave: () => { clearTimeout(pressTimer); },
    onpointercancel: () => { clearTimeout(pressTimer); },
    onclick: () => {
      if (longFired) {
        longFired = false;
        return;
      }

      const n = actions.newChess960();
      if (typeof n === 'number') actions.toast(`Chess960 #${n}`, 'info');
    },
    oncontextmenu: e => {
      e.preventDefault();
      clearTimeout(pressTimer);
      ask960();
    },
  }, '960');

  const btnFlip = tb('Flip', () => actions.flip(), 'Flip the board (F)', icon('flip'));

  const viewSeg = segmented(
    [{ value: '2d', label: '2D', title: 'Flat board, locked top-down (V)' }, { value: '3d', label: '3D', title: 'Sculpted pieces, free orbit (V)' }],
    viewMode(),
    v => {
      if (actions && typeof actions.setViewMode === 'function') actions.setViewMode(v);
      else actions.toast('2D / 3D mode is not available in this build', 'error');
    },
  );
  viewSeg.classList.add('tb-seg');
  viewSeg.title = 'Switch between 2D and 3D (V)';

  function viewMode() {
    const m = store.state && store.state.viewMode;
    return m === '2d' ? '2d' : '3d';
  }

  const btnView = tb('View', () => {
    const flat = viewMode() === '2d';

    openMenu([
      { label: 'White seat', onClick: () => view && view.setPreset('white'), disabled: flat, title: flat ? 'Camera seats are locked in 2D' : null },
      { label: 'Black seat', onClick: () => view && view.setPreset('black'), disabled: flat, title: flat ? 'Camera seats are locked in 2D' : null },
      { label: 'Top', onClick: () => view && view.setPreset('top') },
      { label: 'Side', onClick: () => view && view.setPreset('side'), disabled: flat, title: flat ? 'Camera seats are locked in 2D' : null },
    ], btnView);
  }, 'Camera presets', icon('down'));

  const btnMode = tb('Setup', () => {
    if (store.state.mode === 'setup') actions.setMode('play');
    else {
      actions.setMode('setup');
      actions.setPanel('io');
    }
  }, 'Toggle Play / Setup mode (place pieces freely, then Commit in I/O)');

  const btnLegal = tb('Legal', () => actions.setSetting('showLegalMoves', !store.state.settings.showLegalMoves), 'Show legal moves for the selected piece (L)');

  const dot = el('span', { class: 'dot' });
  const btnEngine = tb('Engine', () => actions.setSetting('engine.enabled', !store.state.settings.engine.enabled), 'Toggle Stockfish analysis (E)', dot);

  const btnCollapse = el('button', { type: 'button', class: 'tb-btn', title: 'Collapse / expand the panel', onclick: () => actions.toggleCollapsed() }, icon('right'));

  const bar = el('div', { class: 'topbar', role: 'toolbar', 'aria-label': 'Board controls' },
    el('h1', { text: 'Rukh' }),
    btnNew, btn960, btnFlip,
    el('span', { class: 'sep' }),
    viewSeg, btnView,
    el('span', { class: 'sep' }),
    btnMode, btnLegal, btnEngine,
    el('span', { class: 'sep' }),
    btnCollapse,
  );

  const turnDot = el('span', { class: 'turn' });
  const chipText = el('span', { text: '' });
  const chipTag = el('span', { class: 'tag', text: '', hidden: true });
  const chip = el('div', { class: 'chip', role: 'status' }, turnDot, chipText, chipTag);

  host.append(bar, chip);

  function update() {
    const s = store.state;
    const st = s.settings;

    btnMode.setAttribute('aria-pressed', String(s.mode === 'setup'));
    btnMode.textContent = s.mode === 'setup' ? 'Setup' : 'Play';
    btnMode.title = s.mode === 'setup' ? 'Leave Setup mode (discards the scratch position)' : 'Enter Setup mode (place pieces freely, then Commit in I/O)';
    btnLegal.setAttribute('aria-pressed', String(!!st.showLegalMoves));

    const eng = s.engine || {};
    btnEngine.setAttribute('aria-pressed', String(!!st.engine.enabled));
    dot.className = 'dot ' + (eng.available === false && st.engine.enabled ? 'unavailable' : st.engine.enabled ? (eng.thinking ? 'thinking' : 'on') : 'off');
    btnEngine.title = eng.available === false ? 'Stockfish is not available in this build' : (st.engine.enabled ? 'Stop the engine (E)' : 'Start Stockfish analysis (E)');

    btnCollapse.replaceChildren(icon(s.ui.collapsed ? 'left' : 'right'));
    btnFlip.title = `Flip the board (F) — sitting as ${s.orientation}`;

    const vm = viewMode();
    viewSeg.set(vm);
    viewSeg.title = vm === '2d' ? 'Top-down 2D board — switch back to 3D (V)' : '3D board — switch to the flat top-down 2D board (V)';

    chip.classList.remove('check', 'over');

    if (s.mode === 'setup') {
      turnDot.hidden = true;
      chipText.textContent = 'Setup';
    } else {
      const g = s.game;
      const turn = g.turn();
      turnDot.hidden = false;
      turnDot.className = 'turn ' + turn;

      let text;
      const status = safeStatus(g);
      const cap = c => c[0].toUpperCase() + c.slice(1);

      if (status.checkmate) {
        text = `Checkmate — ${turn === 'white' ? 'Black' : 'White'} wins`;
        chip.classList.add('over');
      } else if (status.outcome === '1/2-1/2') {
        text = 'Draw' + (status.reason ? ` — ${status.reason}` : '');
        chip.classList.add('over');
      } else if (status.outcome) {
        text = `Game over ${status.outcome}`;
        chip.classList.add('over');
      } else if (status.check) {
        text = `${cap(turn)} to move — check`;
        chip.classList.add('check');
      } else text = `${cap(turn)} to move`;

      chipText.textContent = text;
    }

    const g = s.game;
    if (g && g.variant === 'chess960') {
      chipTag.hidden = false;
      chipTag.textContent = `960 #${g.chess960Number != null ? g.chess960Number : '?'}`;
    } else {
      chipTag.hidden = true;
      chipTag.textContent = '';
    }
  }

  function safeStatus(g) {
    try {
      return g.status() || {};
    } catch {
      return {};
    }
  }

  return {
    el: bar, chip, update,
    dispose() {
      closeMenu();
      clearTimeout(pressTimer);
      bar.remove();
      chip.remove();
    },
  };
}
