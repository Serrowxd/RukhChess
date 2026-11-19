import { el, icon, openMenu as showMenu } from './layout.js';

export const NOT_SAVED_TEXT = 'Boards are not being saved.';

/** The close confirm; only a free board that is saved can be reopened. */
export const closeText = (name, reopenable = false) => (reopenable ? `Close «${name}»?` : `Close «${name}»? Its moves and notes will be lost.`);

/** The plain words each mark adds to a tab's name. */
export const MARK_WORDS = { your_move: 'your move', waiting: 'their move', paused: 'paused', over: 'game over' };

/** A tab's accessible name: its name, then its mark in words. */
export const tabLabel = tab => (MARK_WORDS[tab.mark] ? `${tab.name}, ${MARK_WORDS[tab.mark]}` : tab.name);

export const setupSwitchedText = name => `The board switched to «${name}». Finish or cancel setup to follow.`;
export const setupClosedText = name => `«${name}» was closed. Finish setup to put this position on a new board.`;

/** The line a window in setup shows, or null; `setup` is what the controller's setupBoard() gives. */
export function setupLine(setup, tabs, selected) {
  if (!setup) return null;
  if (!setup.open) return setupClosedText(setup.name);
  if (setup.tab === selected) return null;

  const shown = (Array.isArray(tabs) ? tabs : []).find(tab => tab.id === selected);
  return shown ? setupSwitchedText(shown.name) : null;
}

/** One entry per tab; `hasMoves` is null for a tab that is not shown. */
export function stripModel(tabs, selected, state) {
  const nodes = state && state.game && Array.isArray(state.game.nodes) ? state.game.nodes : null;

  return (Array.isArray(tabs) ? tabs : []).map(tab => ({
    id: tab.id,
    name: tab.name,
    kind: tab.kind,
    mark: tab.mark || null,
    selected: tab.id === selected,
    hasMoves: tab.id === selected && nodes ? nodes.length > 1 : null,
  }));
}

/** The strip's DOM for a model. */
export function renderStrip(model, opts = {}) {
  return patchStrip(null, model, opts);
}

function newTabEntry(id, call) {
  const text = document.createTextNode('');

  const name = el('button', {
    type: 'button', role: 'tab', class: 'b-tab-name',
    onclick: e => call('select', id, e),
    ondblclick: () => call('rename', id),
    onkeydown: e => call('key', e, id),
    oncontextmenu: e => {
      e.preventDefault();
      call('menu', id, name);
    },
  });

  name.appendChild(text);

  const menu = el('button', {
    type: 'button', class: 'b-tab-menu', tabindex: '-1', title: 'Board menu', 'aria-haspopup': 'menu',
    onclick: () => call('menu', id, menu),
  }, icon('dots'));

  const item = el('div', { class: 'b-tab', role: 'presentation', dataset: { tab: id } }, name, menu);
  return { item, name, text, menu, dot: null, input: null };
}

function newInput(tab, call) {
  const input = el('input', {
    type: 'text', class: 'b-tab-input', value: tab.name, 'aria-label': 'Board name', spellcheck: 'false',
    onkeydown: e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        call('commit', tab.id, input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        call('cancel', tab.id);
      }
    },
    onblur: () => call('commit', tab.id, input.value),
  });

  return input;
}

function patchTab(entry, tab, editing, call) {
  const { item, name, text, menu } = entry;

  item.className = tab.selected ? 'b-tab sel' : 'b-tab';
  item.dataset.kind = tab.kind;
  item.dataset.mark = tab.mark || '';

  if (text.textContent !== tab.name) text.textContent = tab.name;

  const label = tabLabel(tab);
  name.setAttribute('title', label);
  if (tab.mark) name.setAttribute('aria-label', label);
  else name.removeAttribute('aria-label');

  name.setAttribute('aria-selected', String(tab.selected));
  name.setAttribute('tabindex', tab.selected ? '0' : '-1');
  menu.setAttribute('aria-label', `${tab.name}: board menu`);

  if (tab.mark && !entry.dot) {
    entry.dot = el('span', { class: 'b-dot', 'aria-hidden': 'true' });
    name.insertBefore(entry.dot, text);
  } else if (!tab.mark && entry.dot) {
    entry.dot.remove();
    entry.dot = null;
  }

  if (entry.dot) entry.dot.className = `b-dot ${tab.mark}`;

  if (editing && !entry.input) {
    entry.input = newInput(tab, call);
    name.remove();
    menu.remove();
    item.appendChild(entry.input);
  } else if (!editing && entry.input) {
    entry.input.remove();
    entry.input = null;
    item.append(name, menu);
  }
}

/** Shows, changes or drops one line after "+"; `before` is the line it must stay in front of. */
function setNote(drawn, key, text, cls, before = null) {
  const shown = drawn[key];

  if (!text) {
    if (shown) shown.remove();
    drawn[key] = null;
    return;
  }

  if (!shown) {
    drawn[key] = el('span', { class: cls });
    drawn.el.insertBefore(drawn[key], before);
  }

  const note = drawn[key];
  if (note.textContent !== text) note.textContent = text;
  note.setAttribute('title', text);
}

/** The indexes of the longest run of `places` that already rises. */
function risingRun(places) {
  const ends = [];
  const before = new Array(places.length).fill(-1);

  places.forEach((place, at) => {
    if (place < 0) return;

    let low = 0;
    let high = ends.length;

    while (low < high) {
      const mid = (low + high) >> 1;
      if (places[ends[mid]] < place) low = mid + 1;
      else high = mid;
    }

    before[at] = low > 0 ? ends[low - 1] : -1;
    ends[low] = at;
  });

  const run = new Set();
  for (let at = ends.length ? ends[ends.length - 1] : -1; at >= 0; at = before[at]) run.add(at);
  return run;
}

/** Puts the items in order, moving only those outside the longest run already in order, so a pressed tab stays put. */
function placeItems(list, items) {
  const drawnOrder = Array.from(list.children);
  const places = items.map(item => drawnOrder.indexOf(item));
  const kept = risingRun(places);

  let next = null;

  for (let at = items.length - 1; at >= 0; at--) {
    if (!kept.has(at)) list.insertBefore(items[at], next);
    next = items[at];
  }
}

/** Brings a drawn strip to a model in place, keyed by tab id; null draws a new one. */
export function patchStrip(drawn, model, { editing = null, unreachable = false, saving = false, closed = 0, setup = null, handlers = {} } = {}) {
  if (!drawn) {
    const strip = { handlers: {} };

    // Elements made once keep calling the handlers of the newest patch.
    strip.call = (name, ...args) => {
      if (typeof strip.handlers[name] === 'function') strip.handlers[name](...args);
    };

    const list = el('div', { class: 'b-tabs-list', role: 'tablist', 'aria-label': 'Boards' });
    const add = el('button', { type: 'button', class: 'tb-btn b-new', title: 'New board', 'aria-label': 'New board', onclick: () => strip.call('newTab', add) }, '+');
    const root = el('div', { class: 'b-tabs' }, list, add);

    drawn = Object.assign(strip, {
      el: root, list, add,
      entries: new Map(),
      input: null, setupNote: null, savedNote: null,
    });
  }

  drawn.handlers = handlers;

  const { list, entries, call } = drawn;
  const ids = new Set(model.map(tab => tab.id));

  for (const [id, entry] of [...entries]) {
    if (ids.has(id)) continue;

    entry.item.remove();
    entries.delete(id);
  }

  drawn.input = null;

  const items = model.map(tab => {
    let entry = entries.get(tab.id);

    if (!entry) {
      entry = newTabEntry(tab.id, call);
      entries.set(tab.id, entry);
    }

    patchTab(entry, tab, tab.id === editing, call);

    if (entry.input) drawn.input = entry.input;
    return entry.item;
  });

  placeItems(list, items);

  if (closed > 0) drawn.add.setAttribute('aria-haspopup', 'menu');
  else drawn.add.removeAttribute('aria-haspopup');

  setNote(drawn, 'savedNote', saving ? null : NOT_SAVED_TEXT, 'b-note');
  setNote(drawn, 'setupNote', setup, 'b-note b-setup', drawn.savedNote);

  drawn.el.className = unreachable ? 'b-tabs b-off' : 'b-tabs';
  drawn.el.hidden = !model.length;
  drawn.el.inert = unreachable;

  return drawn;
}

/** Scrolls the list just far enough that the item lies inside it; its start wins when it is wider. */
export function revealTab(list, item) {
  const start = item.offsetLeft;
  const end = start + item.offsetWidth;
  const width = list.clientWidth;

  if (end > list.scrollLeft + width) list.scrollLeft = end - width;
  if (start < list.scrollLeft) list.scrollLeft = start;
}

/** Mounts the board strip as a row of the topbar; null without a topbar or dialogs. */
export function mountBoardTabs({ remote, ui, host, dialogs = ui && ui.dialogs, openMenu = showMenu }) {
  const bar = host || (ui && ui.topbar && ui.topbar.el);
  if (!bar || !dialogs) return null;

  let editing = null;
  let drawn = null;
  let lastKey = '';
  let lastSelected;
  let lastEditing = null;
  let lastWidth = null;
  let focusAfter = null;
  let resizeObserver = null;
  const asking = new Set(); // tabs whose close confirm is open
  const moving = new Map(); // tab id -> the place its last move asked for, while intents wait

  const fromRemote = (name, fallback) => (typeof remote[name] === 'function' ? remote[name]() : fallback);
  const saving = () => !!(fromRemote('boards', null) || {}).saving;

  const model = () => {
    const { tab, tabs } = remote.tabs();
    return stripModel(tabs, tab, remote.state());
  };

  const find = id => model().find(tab => tab.id === id) || null;

  function startRename(id) {
    if (!find(id)) return;

    editing = id;
    draw();
  }

  function stopRename(id) {
    editing = null;
    focusAfter = id;
    draw();
  }

  function commit(id, value) {
    if (editing !== id) return;

    const tab = find(id);
    stopRename(id);
    if (tab && String(value) !== tab.name) remote.renameTab(id, value);
  }

  async function close(id) {
    const tab = find(id);
    if (!tab || asking.has(id)) return;

    // A tab that is not shown cannot be checked for moves, so it is always asked about.
    if (tab.hasMoves !== false) {
      asking.add(id);

      try {
        if (!await dialogs.confirm(closeText(tab.name, saving() && tab.kind === 'free'), { ok: 'Close', danger: true })) return;
      } finally {
        asking.delete(id);
      }
    }

    remote.closeTab(id);
  }

  /** Where the tab stands, counting a move the program has not answered yet; -1 when it is gone. */
  function placeOf(id) {
    const tabs = model();
    const at = tabs.findIndex(tab => tab.id === id);
    if (at < 0) return -1;

    if (!busy()) moving.clear();
    return moving.has(id) ? moving.get(id) : at;
  }

  /** Moves the tab one place from where it stands when the item is chosen. */
  function step(id, by) {
    const at = placeOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= model().length) return;

    moving.set(id, to);
    remote.moveTab(id, to);
  }

  function menu(id, anchor) {
    const at = placeOf(id);
    if (at < 0) return;

    openMenu([
      { label: 'Rename', onClick: () => startRename(id) },
      { label: 'Close', onClick: () => close(id) },
      { label: 'Move left', disabled: at === 0, onClick: () => step(id, -1) },
      { label: 'Move right', disabled: at === model().length - 1, onClick: () => step(id, 1) },
    ], anchor);
  }

  /** The tab's button, or null while it is being renamed or not drawn. */
  function buttonOf(id) {
    const entry = drawn && drawn.entries.get(id);
    return entry && !entry.input ? entry.name : null;
  }

  function focusTab(id) {
    if (!drawn) return;

    for (const [tabId, entry] of drawn.entries) entry.name.setAttribute('tabindex', tabId === id ? '0' : '-1');

    const button = buttonOf(id);
    if (button && typeof button.focus === 'function' && document.activeElement !== button) button.focus();
  }

  function onKey(e, id) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const tabs = model();
    const ids = tabs.map(tab => tab.id);
    const at = ids.indexOf(id);
    const selected = tabs[at] && tabs[at].selected;

    if (e.key === 'ArrowRight') focusTab(ids[(at + 1) % ids.length]);
    else if (e.key === 'ArrowLeft') focusTab(ids[(at - 1 + ids.length) % ids.length]);
    else if (e.key === 'Home') focusTab(ids[0]);
    else if (e.key === 'End') focusTab(ids[ids.length - 1]);
    else if (e.key === 'F2' || (e.key === 'Enter' && selected)) startRename(id);
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) menu(id, buttonOf(id));
    else return;

    e.preventDefault();
  }

  function select(id, e) {
    const tab = find(id);
    if (tab && !tab.selected) remote.selectTab(id);

    // A clicked tab gives focus back, so the arrow keys step through the moves again.
    if (e && e.detail > 0 && e.target && typeof e.target.blur === 'function') e.target.blur();
  }

  const busy = () => {
    const status = fromRemote('status', null);
    return !!(status && status.pending > 0);
  };

  function makeTab() {
    if (!busy()) remote.newTab();
  }

  function reopenTab() {
    if (!busy()) remote.reopenTab();
  }

  function newTab(anchor) {
    if (fromRemote('closedBoards', 0) > 0) {
      openMenu([
        { label: 'New board', onClick: makeTab },
        { label: 'Reopen closed board', onClick: reopenTab },
      ], anchor);
      return;
    }

    makeTab();
  }

  const handlers = { select, newTab, rename: startRename, commit, cancel: stopRename, menu, key: onKey };

  function focusedTab() {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (!drawn || !active) return null;

    for (const id of drawn.entries.keys()) if (buttonOf(id) === active) return id;
    return null;
  }

  function revealShown() {
    if (!drawn) return;

    const selected = (model().find(tab => tab.selected) || {}).id;
    const shown = drawn.entries.get(editing !== null ? editing : selected);
    if (shown) revealTab(drawn.list, shown.item);
  }

  function onResize() {
    if (!drawn) return;

    const width = drawn.list.clientWidth;
    if (width === lastWidth) return;

    lastWidth = width;
    revealShown();
  }

  function draw() {
    const tabs = model();
    const unreachable = !!(remote.stopped && remote.stopped()) || !!(remote.connected && !remote.connected());
    const closed = fromRemote('closedBoards', 0);
    const setup = setupLine(fromRemote('setupBoard', null), tabs, (tabs.find(tab => tab.selected) || {}).id);

    const key = JSON.stringify([tabs, editing, unreachable, saving(), closed, setup]);
    if (key === lastKey) return;
    lastKey = key;

    const keepFocus = focusAfter || focusedTab();
    focusAfter = null;

    const first = !drawn;
    drawn = patchStrip(drawn, tabs, { editing, unreachable, saving: saving(), closed, setup, handlers });

    if (first) {
      bar.appendChild(drawn.el);

      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(onResize);
        resizeObserver.observe(drawn.list);
      }

      lastWidth = drawn.list.clientWidth;
    }

    const selected = (tabs.find(tab => tab.selected) || {}).id;
    const reveal = selected !== lastSelected || (editing !== null && editing !== lastEditing);
    lastSelected = selected;
    lastEditing = editing;

    if (reveal) revealShown();

    if (drawn.input) {
      if (document.activeElement !== drawn.input) {
        drawn.input.focus();
        drawn.input.select();
      }
    } else if (keepFocus) {
      focusTab(buttonOf(keepFocus) ? keepFocus : selected);
    }
  }

  function update() {
    // A name being typed is kept until it is committed, unless its tab went away.
    if (editing !== null) {
      if (find(editing)) return;
      editing = null;
    }

    draw();
  }

  const unsubscribe = remote.onChange(update);
  update();

  return {
    update,
    get el() { return drawn && drawn.el; },
    dispose() {
      unsubscribe();
      if (resizeObserver) resizeObserver.disconnect();
      if (drawn) drawn.el.remove();
      drawn = null;
    },
  };
}
