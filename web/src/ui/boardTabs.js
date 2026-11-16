import { el, icon, openMenu as showMenu } from './layout.js';

export const NOT_SAVED_TEXT = 'Boards are not being saved.';

/** The close confirm; it promises no way back. */
export const closeText = name => `Close «${name}»? Its moves and notes will be lost.`;

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
export function renderStrip(model, { editing = null, unreachable = false, handlers = {} } = {}) {
  const call = (name, ...args) => {
    if (typeof handlers[name] === 'function') handlers[name](...args);
  };

  const buttons = new Map();
  const items = new Map();
  let input = null;

  const list = el('div', { class: 'b-tabs-list', role: 'tablist', 'aria-label': 'Boards' });

  for (const tab of model) {
    const item = el('div', { class: tab.selected ? 'b-tab sel' : 'b-tab', role: 'presentation', dataset: { tab: tab.id, kind: tab.kind, mark: tab.mark || '' } });

    if (tab.id === editing) {
      input = el('input', {
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

      item.appendChild(input);
    } else {
      const name = el('button', {
        type: 'button', role: 'tab', class: 'b-tab-name', title: tab.name,
        'aria-selected': String(tab.selected), tabindex: tab.selected ? '0' : '-1',
        onclick: e => call('select', tab.id, e),
        ondblclick: () => call('rename', tab.id),
        onkeydown: e => call('key', e, tab.id),
        oncontextmenu: e => {
          e.preventDefault();
          call('menu', tab.id, name);
        },
      }, tab.name);

      const menu = el('button', {
        type: 'button', class: 'b-tab-menu', tabindex: '-1', title: 'Board menu', 'aria-haspopup': 'menu',
        'aria-label': `${tab.name}: board menu`,
        onclick: () => call('menu', tab.id, menu),
      }, icon('dots'));

      buttons.set(tab.id, name);
      item.append(name, menu);
    }

    items.set(tab.id, item);
    list.appendChild(item);
  }

  const add = el('button', { type: 'button', class: 'tb-btn b-new', title: 'New board', 'aria-label': 'New board', onclick: () => call('newTab') }, '+');
  const note = el('span', { class: 'b-note', text: NOT_SAVED_TEXT });

  const root = el('div', { class: unreachable ? 'b-tabs b-off' : 'b-tabs', hidden: !model.length }, list, add, note);
  root.inert = unreachable;

  return { el: root, list, items, buttons, input };
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
  let focusAfter = null;
  const asking = new Set(); // tabs whose close confirm is open

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
        if (!await dialogs.confirm(closeText(tab.name), { ok: 'Close', danger: true })) return;
      } finally {
        asking.delete(id);
      }
    }

    remote.closeTab(id);
  }

  function menu(id, anchor) {
    openMenu([
      { label: 'Rename', onClick: () => startRename(id) },
      { label: 'Close', onClick: () => close(id) },
    ], anchor);
  }

  function focusTab(id) {
    if (!drawn) return;

    for (const [tabId, button] of drawn.buttons) button.setAttribute('tabindex', tabId === id ? '0' : '-1');

    const button = drawn.buttons.get(id);
    if (button && typeof button.focus === 'function') button.focus();
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
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) menu(id, drawn && drawn.buttons.get(id));
    else return;

    e.preventDefault();
  }

  function select(id, e) {
    const tab = find(id);
    if (tab && !tab.selected) remote.selectTab(id);

    // A clicked tab gives focus back, so the arrow keys step through the moves again.
    if (e && e.detail > 0 && e.target && typeof e.target.blur === 'function') e.target.blur();
  }

  function newTab() {
    const status = typeof remote.status === 'function' ? remote.status() : null;
    if (status && status.pending > 0) return;

    remote.newTab();
  }

  const handlers = { select, newTab, rename: startRename, commit, cancel: stopRename, menu, key: onKey };

  function focusedTab() {
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (!drawn || !active) return null;

    for (const [id, button] of drawn.buttons) if (button === active) return id;
    return null;
  }

  function draw() {
    const tabs = model();
    const unreachable = !!(remote.stopped && remote.stopped()) || !!(remote.connected && !remote.connected());

    const key = JSON.stringify([tabs, editing, unreachable]);
    if (key === lastKey) return;
    lastKey = key;

    const keepFocus = focusAfter || focusedTab();
    focusAfter = null;

    const next = renderStrip(tabs, { editing, unreachable, handlers });

    if (drawn) {
      next.list.scrollLeft = drawn.list.scrollLeft;
      bar.replaceChild(next.el, drawn.el);
    } else {
      bar.appendChild(next.el);
    }

    drawn = next;

    const selected = (tabs.find(tab => tab.selected) || {}).id;
    const reveal = selected !== lastSelected || (editing !== null && editing !== lastEditing);
    lastSelected = selected;
    lastEditing = editing;

    const shown = next.items.get(editing !== null ? editing : selected);
    if (reveal && shown) revealTab(next.list, shown);

    if (next.input) {
      next.input.focus();
      next.input.select();
    } else if (keepFocus) {
      focusTab(next.buttons.has(keepFocus) ? keepFocus : (tabs.find(tab => tab.selected) || {}).id);
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
      if (drawn) drawn.el.remove();
      drawn = null;
    },
  };
}
