// The board strip (src/ui/boardTabs.js) and what is typed across a switch, on a small stand-in DOM over the stand-in desk.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Just enough DOM for ui/layout.js's el() and the strip's handlers.

// Every node is `width` wide and sits after its siblings; a node shows `view` of its content.
const layout = { width: 0, view: 0 };

function makeNode(tag) {
  const listeners = new Map();
  const attrs = new Map();

  const node = {
    tagName: tag.toUpperCase(), nodeType: 1,
    className: '', style: {}, dataset: {}, value: '', hidden: false, inert: false, scrollLeft: 0, innerHTML: '',
    parentNode: null, childNodes: [],

    get children() { return node.childNodes.filter(c => c.nodeType === 1); },

    get offsetLeft() { return node.parentNode ? node.parentNode.children.indexOf(node) * layout.width : 0; },
    get offsetWidth() { return layout.width; },
    get clientWidth() { return layout.view; },

    get textContent() { return node.childNodes.map(c => c.textContent).join(''); },
    set textContent(v) {
      node.childNodes = [];
      if (v !== '') node.appendChild(document.createTextNode(String(v)));
    },

    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },

    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    fire(type, props = {}) {
      const ev = { type, target: node, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {}, ...props };
      for (const fn of listeners.get(type) || []) fn(ev);
      return ev;
    },

    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      node.childNodes.push(c);
      c.parentNode = node;
      return c;
    },
    append(...cs) { for (const c of cs) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); },
    removeChild(c) {
      node.childNodes = node.childNodes.filter(x => x !== c);
      c.parentNode = null;
      return c;
    },
    insertBefore(c, ref) {
      if (!ref) return node.appendChild(c);
      if (c.parentNode) c.parentNode.removeChild(c);

      node.childNodes.splice(node.childNodes.indexOf(ref), 0, c);
      c.parentNode = node;
      return c;
    },
    closest(sel) {
      const cls = sel.replace(/^\./, '');
      for (let n = node; n; n = n.parentNode) if (typeof n.className === 'string' && n.className.split(' ').includes(cls)) return n;
      return null;
    },
    querySelector() { return null; },
    replaceChild(next, old) {
      const at = node.childNodes.indexOf(old);
      node.childNodes[at] = next;
      next.parentNode = node;
      old.parentNode = null;
      return old;
    },
    remove() { if (node.parentNode) node.parentNode.removeChild(node); },

    querySelectorAll() { return []; },
    focus() { document.activeElement = node; },
    blur() { if (document.activeElement === node) document.activeElement = null; },
    select() { node.selected = true; },
  };

  return node;
}

globalThis.document = {
  activeElement: null,
  createElement: makeNode,
  createTextNode: text => ({ nodeType: 3, textContent: String(text), parentNode: null }),
};

const { stripModel, renderStrip, patchStrip, mountBoardTabs, closeText, tabLabel, setupSwitchedText, setupClosedText, NOT_SAVED_TEXT } = await import('../src/ui/boardTabs.js');
const { TAB_LIMIT_TEXT } = await import('../src/net/remoteSync.js');
const { deskProgram } = await import('./fake-program.mjs');
const { createNotesPanel } = await import('../src/ui/notesPanel.js');

const walk = node => [node, ...(node.childNodes || []).flatMap(walk)];
const byRole = (root, role) => walk(root).filter(n => n.getAttribute && n.getAttribute('role') === role);
const byClass = (root, cls) => walk(root).filter(n => typeof n.className === 'string' && n.className.split(' ').includes(cls));
const tabButton = (root, name) => byRole(root, 'tab').find(b => b.textContent === name);
const tick = () => new Promise(r => setImmediate(r));

// As the program sends it: three tabs, the third selected, a game with one move on it.
const FRAME = {
  t: 'state', instance: 'i1', rev: 9, hint: { reason: 'tab_select', by: 'view:1' },
  tab: 't4',
  tabs: [
    { id: 't1', name: 'Board 1', kind: 'free', mark: null },
    { id: 't2', name: 'Board 2', kind: 'free', mark: 'waiting' },
    { id: 't4', name: 'Italian, the Bc5 line', kind: 'free', mark: 'your_move' },
  ],
  state: { game: { nodes: [{ id: 0 }, { id: 1 }] } },
};

/** The strip on a host element over a desk with one page; `answer` is what the close confirm returns. */
function mounted({ answer = false, saving = false } = {}) {
  const pr = deskProgram(1, { saving });
  const [page] = pr.pages;
  const host = document.createElement('div');
  const asked = [];
  const menus = [];

  const dialogs = { confirm: async (text, opts) => { asked.push({ text, opts }); return answer; } };
  const openMenu = (items, anchor) => { menus.push({ items, anchor }); };
  const strip = mountBoardTabs({ remote: page.remote, host, dialogs, openMenu });

  return { pr, page, host, strip, asked, menus, sent: () => page.ws.sent.map(({ t: _t, id: _id, ...rest }) => rest) };
}

test('stripModel: one entry per tab, the selected one marked, moves known only for the shown tab', () => {
  assert.deepEqual(stripModel(FRAME.tabs, FRAME.tab, FRAME.state), [
    { id: 't1', name: 'Board 1', kind: 'free', mark: null, selected: false, hasMoves: null },
    { id: 't2', name: 'Board 2', kind: 'free', mark: 'waiting', selected: false, hasMoves: null },
    { id: 't4', name: 'Italian, the Bc5 line', kind: 'free', mark: 'your_move', selected: true, hasMoves: true },
  ]);

  const fresh = stripModel(FRAME.tabs, 't1', { game: { nodes: [{ id: 0 }] } });
  assert.equal(fresh[0].hasMoves, false);
  assert.deepEqual(stripModel(null, null, null), []);
});

test('the strip renders from a fixture frame with three tabs and marks the selected one', () => {
  const { el } = renderStrip(stripModel(FRAME.tabs, FRAME.tab, FRAME.state));

  const tabs = byRole(el, 'tab');
  assert.deepEqual(tabs.map(b => b.textContent), ['Board 1', 'Board 2', 'Italian, the Bc5 line']);
  assert.deepEqual(tabs.map(b => b.getAttribute('aria-selected')), ['false', 'false', 'true']);
  assert.deepEqual(tabs.map(b => b.getAttribute('tabindex')), ['-1', '-1', '0'], 'one tab stop, on the selected tab');

  assert.equal(byRole(el, 'tablist').length, 1);
  assert.deepEqual(byClass(el, 'b-tab').map(n => [n.dataset.tab, n.dataset.mark, n.className.includes('sel')]),
    [['t1', '', false], ['t2', 'waiting', false], ['t4', 'your_move', true]]);

  assert.equal(byClass(el, 'b-new').length, 1);
  assert.equal(byClass(el, 'b-tab-menu').length, 3);
  assert.deepEqual(byClass(el, 'b-note').map(n => n.textContent), [NOT_SAVED_TEXT]);
  assert.equal(el.hidden, false);

  assert.equal(renderStrip([]).el.hidden, true, 'no tabs, no strip');
  assert.ok(renderStrip([], { unreachable: true }).el.className.includes('b-off'));
});

test('clicking a tab sends tab_select for that id; clicking the selected tab sends nothing', () => {
  const m = mounted();
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  assert.deepEqual(byRole(m.host, 'tab').map(b => b.textContent), ['Board 1', 'Board 2', 'Board 3']);

  tabButton(m.host, 'Board 3').fire('click');
  assert.deepEqual(m.sent(), []);

  tabButton(m.host, 'Board 1').fire('click');
  assert.deepEqual(m.sent(), [{ op: 'tab_select', tab: 't1' }]);

  m.pr.pump();
  assert.equal(tabButton(m.host, 'Board 1').getAttribute('aria-selected'), 'true');
  assert.equal(m.page.remote.shownTab(), 't1');

  m.pr.done();
});

test('the new-board control sends tab_new and the new tab shows selected', () => {
  const m = mounted();

  byClass(m.host, 'b-new')[0].fire('click');
  assert.deepEqual(m.sent(), [{ op: 'tab_new', name: null, copy_of: null }]);

  m.pr.pump();
  assert.equal(tabButton(m.host, 'Board 2').getAttribute('aria-selected'), 'true');

  m.pr.done();
});

test('close on a tab with moves asks first and sends nothing when declined', async () => {
  const m = mounted({ answer: false });
  m.page.st.actions.playMove('e2e4');
  m.pr.pump();

  byClass(m.host, 'b-tab-menu')[0].fire('click');
  const close = m.menus[0].items.find(i => i.label === 'Close');
  assert.deepEqual(m.menus[0].items.map(i => i.label), ['Rename', 'Close', 'Move left', 'Move right']);

  close.onClick();
  await tick();

  assert.deepEqual(m.asked.map(a => a.text), [closeText('Board 1')]);
  assert.equal(m.asked[0].opts.ok, 'Close');
  assert.doesNotMatch(m.asked[0].text, /reopen|restore|undo|bring back/i, 'the confirm promises no way back');
  assert.deepEqual(m.sent(), []);

  m.pr.done();
});

/** Picks Close in a tab's menu. */
function closeFromMenu(m, name) {
  const tab = byClass(m.host, 'b-tab').find(item => item.childNodes[0].textContent === name);
  tab.childNodes[1].fire('click');
  m.menus.at(-1).items.find(i => i.label === 'Close').onClick();
}

test('close on a tab with moves sends tab_close once confirmed', async () => {
  const m = mounted({ answer: true });
  m.page.st.actions.playMove('e2e4');
  m.pr.pump();

  closeFromMenu(m, 'Board 1');
  await tick();

  assert.equal(m.asked.length, 1);
  assert.deepEqual(m.sent(), [{ op: 'tab_close', tab: 't1' }]);

  m.pr.pump();
  assert.deepEqual(byRole(m.host, 'tab').map(b => b.textContent), ['Board 1'], 'the last tab closed leaves a fresh Board 1');
  assert.equal(m.page.st.state.game.fen().split(' ')[0], 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR');

  m.pr.done();
});

test('a shown tab with no moves closes at once; a tab that is not shown is always asked about', async () => {
  const m = mounted({ answer: false });
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });

  closeFromMenu(m, 'Board 1');
  await tick();
  assert.equal(m.asked.length, 1, 'Board 1 is not shown, so its moves are not known');
  assert.deepEqual(m.sent(), []);

  closeFromMenu(m, 'Board 2');
  await tick();
  assert.equal(m.asked.length, 1, 'the shown tab has no moves');
  assert.deepEqual(m.sent(), [{ op: 'tab_close', tab: 't2' }]);

  m.pr.done();
});

test('rename sends the typed name and shows the name the program kept', () => {
  const m = mounted();

  tabButton(m.host, 'Board 1').fire('dblclick');
  const input = byClass(m.host, 'b-tab-input')[0];
  assert.ok(input, 'an input in place of the name');
  assert.equal(document.activeElement, input);
  assert.equal(input.value, 'Board 1');

  input.value = '  Italian,   the Bc5 line ';
  input.fire('keydown', { key: 'Enter' });
  input.fire('blur');

  assert.deepEqual(m.sent(), [{ op: 'tab_rename', tab: 't1', name: '  Italian,   the Bc5 line ' }], 'sent once');
  assert.equal(byClass(m.host, 'b-tab-input').length, 0);

  m.pr.pump();
  assert.deepEqual(byRole(m.host, 'tab').map(b => b.textContent), ['Italian, the Bc5 line']);
  assert.equal(document.activeElement, tabButton(m.host, 'Italian, the Bc5 line'), 'focus goes back to the tab');

  m.pr.done();
});

test('Escape cancels a rename and an unchanged name sends nothing', () => {
  const m = mounted();

  tabButton(m.host, 'Board 1').fire('keydown', { key: 'F2' });
  let input = byClass(m.host, 'b-tab-input')[0];
  input.value = 'Something else';
  input.fire('keydown', { key: 'Escape' });

  assert.equal(byClass(m.host, 'b-tab-input').length, 0);
  assert.deepEqual(m.sent(), []);

  tabButton(m.host, 'Board 1').fire('keydown', { key: 'Enter' });
  input = byClass(m.host, 'b-tab-input')[0];
  assert.ok(input, 'Enter on the selected tab renames it');
  input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(m.sent(), []);

  m.pr.done();
});

test('a refused new board shows the limit line', () => {
  const m = mounted();
  for (let i = 0; i < 11; i++) m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  assert.equal(byRole(m.host, 'tab').length, 12);

  byClass(m.host, 'b-new')[0].fire('click');
  m.pr.pump();

  assert.deepEqual(m.page.toasts, [{ text: TAB_LIMIT_TEXT, kind: 'error' }]);
  assert.equal(byRole(m.host, 'tab').length, 12);

  m.pr.done();
});

test('keyboard: arrows, Home and End move focus along the tabs without selecting', () => {
  const m = mounted();
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  m.pr.view('view:9', { op: 'tab_select', tab: 't1' });

  const ev = tabButton(m.host, 'Board 1').fire('keydown', { key: 'ArrowRight' });
  assert.equal(ev.defaultPrevented, true, 'the board does not also step through the moves');
  assert.equal(document.activeElement, tabButton(m.host, 'Board 2'));
  assert.equal(tabButton(m.host, 'Board 2').getAttribute('tabindex'), '0');

  tabButton(m.host, 'Board 2').fire('keydown', { key: 'End' });
  assert.equal(document.activeElement, tabButton(m.host, 'Board 3'));
  tabButton(m.host, 'Board 3').fire('keydown', { key: 'ArrowRight' });
  assert.equal(document.activeElement, tabButton(m.host, 'Board 1'), 'wraps around');
  tabButton(m.host, 'Board 1').fire('keydown', { key: 'ArrowLeft' });
  assert.equal(document.activeElement, tabButton(m.host, 'Board 3'));

  assert.deepEqual(m.sent(), []);

  tabButton(m.host, 'Board 3').fire('keydown', { key: 'F10', shiftKey: true });
  assert.equal(m.menus.length, 1);

  m.pr.done();
});

/** The declarations of one rule in the page's stylesheet. */
async function cssRule(sel) {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');

  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `${sel} is styled`);
  return m[1];
}

test('the strip style keeps it one row that scrolls sideways', async () => {
  assert.match(await cssRule('.b-tabs-list'), /overflow-x:\s*auto/);
  assert.doesNotMatch(await cssRule('.topbar .b-tabs'), /flex-wrap:\s*wrap/);
  assert.match(await cssRule('.b-tab-name'), /white-space:\s*nowrap/);
  assert.match(await cssRule('.b-note'), /white-space:\s*nowrap/);
});

/** A rule's declarations, one trimmed string each. */
const declarations = rule => rule.split(';').map(d => d.trim().replace(/\s+/g, ' ')).filter(Boolean);

test('the note gives way before the tabs, and the new-board control never shrinks', async () => {
  const strip = await cssRule('.topbar .b-tabs');
  assert.match(strip, /display:\s*grid/);
  assert.match(strip, /grid-template-columns:\s*minmax\(0, max-content\) max-content minmax\(0, 1fr\);/, 'tabs, then "+" at its full width, then the note in what is left');

  const note = await cssRule('.b-note');
  assert.match(note, /min-width:\s*0/);
  assert.match(note, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(note, /padding/, 'padding would keep a sliver of the note from shrinking');
  assert.doesNotMatch(note, /grid-(row|column)/, 'the not-saved line stays in the tab row');

  assert.match(await cssRule('.b-tabs-list'), /position:\s*relative/, 'tabs are measured from the list');
});

test('the setup line takes a row of its own under the tabs, full width, and wraps', async () => {
  assert.deepEqual(declarations(await cssRule('.b-note.b-setup')), [
    'grid-column: 1 / -1',
    'grid-row: 2',
    'padding: 0 8px 2px',
    'text-indent: 0',
    'white-space: normal',
    'overflow-wrap: anywhere',
    'color: var(--ink-2)',
  ]);

  // The strip's height follows its rows, so overflow: hidden does not clip the second one.
  const strip = await cssRule('.topbar .b-tabs');
  assert.doesNotMatch(strip, /(^|[^-])height:|grid-template-rows|grid-auto-rows/);

  const { el } = renderStrip(stripModel(FRAME.tabs, FRAME.tab, FRAME.state), { setup: setupSwitchedText('Board 1') });
  assert.deepEqual(el.children.map(n => n.className), ['b-tabs-list', 'tb-btn b-new', 'b-note b-setup', 'b-note'], 'a grid item of the strip itself');
});

/** The strip with every tab 100 wide in a list that shows 150. */
function laidOut(run) {
  Object.assign(layout, { width: 100, view: 150 });

  try {
    run();
  } finally {
    Object.assign(layout, { width: 0, view: 0 });
  }
}

const tabList = m => byRole(m.host, 'tablist')[0];

test('a newly selected tab, or a name being typed, is scrolled into the list', () => laidOut(() => {
  const m = mounted();
  assert.equal(tabList(m).scrollLeft, 0);

  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  assert.equal(tabList(m).scrollLeft, 150, 'Board 3 runs from 200 to 300');

  m.pr.view('view:9', { op: 'tab_select', tab: 't1' });
  assert.equal(tabList(m).scrollLeft, 0);

  byClass(m.host, 'b-tab-menu')[2].fire('click');
  m.menus.at(-1).items.find(i => i.label === 'Rename').onClick();
  assert.ok(byClass(m.host, 'b-tab-input')[0]);
  assert.equal(tabList(m).scrollLeft, 150, 'the field being typed in is in view');

  byClass(m.host, 'b-tab-input')[0].fire('keydown', { key: 'Escape' });
  assert.equal(tabList(m).scrollLeft, 150, 'the renamed tab stays where it was');

  m.pr.done();
}));

test('a redraw that keeps the selection keeps where the list was scrolled', () => laidOut(() => {
  const m = mounted();
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  m.pr.view('view:9', { op: 'tab_select', tab: 't1' });

  const before = tabList(m);
  before.scrollLeft = 120;

  m.pr.view('view:9', { op: 'tab_rename', tab: 't2', name: 'Renamed' });
  assert.equal(tabList(m), before, 'the strip was redrawn in place');
  assert.ok(tabButton(m.host, 'Renamed'));
  assert.equal(tabList(m).scrollLeft, 120, 'the selected tab is out of view, and that is left alone');

  m.pr.done();
}));

test('the strip greys out when the program is out of reach', () => {
  const m = mounted();
  assert.equal(m.strip.el.className.includes('b-off'), false);

  m.page.ws.readyState = 3;
  m.page.ws.onclose();

  assert.equal(m.strip.el.className.includes('b-off'), true);
  assert.equal(m.strip.el.inert, true);

  m.pr.done();
});

test('Delete on a focused tab closes nothing', async () => {
  const m = mounted({ answer: true });
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });

  const ev = tabButton(m.host, 'Board 2').fire('keydown', { key: 'Delete' });
  await tick();

  assert.equal(ev.defaultPrevented, false);
  assert.deepEqual(m.asked, []);
  assert.deepEqual(m.sent(), []);

  m.pr.done();
});

test('Close picked twice while its confirm is open asks once', async () => {
  let answer = null;
  const pr = deskProgram(1);
  const [page] = pr.pages;
  const host = document.createElement('div');
  const menus = [];
  const asked = [];

  const dialogs = { confirm: text => { asked.push(text); return new Promise(r => { answer = r; }); } };
  mountBoardTabs({ remote: page.remote, host, dialogs, openMenu: items => menus.push({ items }) });
  page.st.actions.playMove('e2e4');
  pr.pump();
  page.ws.sent.length = 0;

  const m = { host, menus };
  closeFromMenu(m, 'Board 1');
  closeFromMenu(m, 'Board 1');
  await tick();
  assert.equal(asked.length, 1);

  answer(true);
  await tick();
  assert.deepEqual(page.ws.sent.map(s => [s.op, s.tab]), [['tab_close', 't1']]);

  pr.done();
});

test('two quick clicks on the new-board control make one board', () => {
  const m = mounted();

  byClass(m.host, 'b-new')[0].fire('click');
  byClass(m.host, 'b-new')[0].fire('click');
  assert.deepEqual(m.sent(), [{ op: 'tab_new', name: null, copy_of: null }]);

  m.pr.pump();
  assert.equal(m.pr.desk.tabs().length, 2);

  byClass(m.host, 'b-new')[0].fire('click');
  m.pr.pump();
  assert.equal(m.pr.desk.tabs().length, 3, 'once the first is answered, the next click makes a board');

  m.pr.done();
});

test('a tab picked with the mouse gives focus back to the board; one picked with the keyboard keeps it', () => {
  const m = mounted();
  m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });

  const one = tabButton(m.host, 'Board 1');
  one.focus();
  one.fire('click', { detail: 1, target: one });
  assert.equal(document.activeElement, null, 'arrow keys reach the board again');

  m.pr.pump();
  const two = tabButton(m.host, 'Board 2');
  two.focus();
  two.fire('click', { detail: 0, target: two });
  assert.equal(document.activeElement, two);

  m.pr.done();
});

test('the strip needs the dialogs to ask before a close', () => {
  const pr = deskProgram(1);
  const host = document.createElement('div');

  assert.equal(mountBoardTabs({ remote: pr.pages[0].remote, host }), null);
  assert.equal(host.childNodes.length, 0);

  pr.done();
});

/** The notes panel on a page, told before each switch as the page tells it. */
function notesOn(page) {
  const panel = createNotesPanel({ store: page.st, actions: page.st.actions });
  page.remote.beforeSwitch(() => panel.leave());
  panel.update();

  return { panel, title: panel.el.children[0].children[0].children[1], note: panel.el.children[1].children[1] };
}

const rootNote = (pr, id) => pr.desk.table(id).game.root.note || '';

test('a move note still being typed when another window switches boards goes to the board it was typed for', () => {
  const pr = deskProgram(1);
  const [page] = pr.pages;
  const { panel, note } = notesOn(page);

  note.value = 'typed for board 1';
  note.fire('input');

  pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  pr.pump();
  panel.dispose();
  pr.pump();

  assert.equal(rootNote(pr, 't1'), 'typed for board 1');
  assert.equal(rootNote(pr, 't2'), '');
  assert.deepEqual(pr.sent().map(s => [s.op, s.tab]), [['annotate', 't1']]);

  pr.done();
});

test('typing on after the board switched under the note does not reach the new board', () => {
  const pr = deskProgram(1);
  const [page] = pr.pages;
  page.st.actions.setNote('kept on board 1');
  pr.pump();

  const { panel, note } = notesOn(page);
  note.focus();

  pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  note.value = 'kept on board 1, and more';
  note.fire('input');

  panel.update();
  assert.equal(note.value, '', 'the field shows the new board');

  panel.dispose();
  pr.pump();
  assert.equal(rootNote(pr, 't1'), 'kept on board 1');
  assert.equal(rootNote(pr, 't2'), '');

  pr.done();
});

test('a study title still being typed when the board switches stays with its board', () => {
  const pr = deskProgram(1);
  const [page] = pr.pages;
  const { panel, title } = notesOn(page);

  title.value = 'Title of board 1';
  title.fire('input');

  pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  panel.dispose();
  assert.equal(page.st.state.study.title, '');

  pr.view('view:9', { op: 'tab_select', tab: 't1' });
  assert.equal(page.st.state.study.title, 'Title of board 1');

  pr.done();
});

const { startRemoteSync } = await import('../src/net/remoteSync.js');
const { createStore } = await import('../src/core/store.js');
const { createDialogs } = await import('../src/ui/dialogs.js');
const { FakeSocket } = await import('./fake-program.mjs');

const SAVING = { saving: true, notices: [] };

// Longer than any reconnect wait, and as long as the acks' own timeout.
const ACK_TIMEOUT_MS = 60000;

/** One page on its own socket whose hello carries `boards`; `reconnect` drops the socket and says hello again. */
function lonePage(boards) {
  const timers = new Map();
  let nextTimer = 1;
  const setTimeout = (fn, ms) => { timers.set(nextTimer, { fn, ms }); return nextTimer++; };
  const clearTimeout = id => { timers.delete(id); };

  const st = createStore({ storage: null });
  const toasts = [];
  st.actions.toast = (text, kind) => { toasts.push({ text, kind }); };

  const remote = startRemoteSync({ store: st, actions: st.actions, location: { href: 'http://127.0.0.1:47480/' }, WebSocket: FakeSocket, ackTimeoutMs: ACK_TIMEOUT_MS, setTimeout, clearTimeout });
  let ws = FakeSocket.last;

  const hello = (instance, body) => {
    ws.onopen();
    ws.receive({ t: 'hello', proto: 2, instance, you: 'view:1', boards: body });
  };
  hello('i1', boards);

  const reconnect = (body, instance = 'i1') => {
    ws.onclose();

    for (const [id, timer] of [...timers]) {
      if (timer.ms >= ACK_TIMEOUT_MS) continue;

      timers.delete(id);
      timer.fn();
    }

    ws = FakeSocket.last;
    hello(instance, body);
  };

  return {
    remote, toasts, reconnect,
    receive: msg => ws.receive(msg),
    done: () => { remote.stop(); st.dispose(); },
  };
}

const BROKEN = { code: 'broken', id: 1, text: 'The saved board t1.json could not be read: the file is not readable JSON. It was moved to broken/t1.1794890231662.json.' };
const FRESH = { code: 'fresh_board', id: 2, text: 'No saved board could be loaded, so a fresh Board 1 was made.' };
const HELD = { code: 'write_failed', id: 3, text: 'Could not save boards/t1.json: another program has it open.' };

test('the not-saved line is drawn only when boards are not being saved, and takes no room otherwise', () => {
  const model = stripModel(FRAME.tabs, FRAME.tab, FRAME.state);

  const saved = renderStrip(model, { saving: true }).el;
  assert.deepEqual(byClass(saved, 'b-note'), []);
  assert.deepEqual(saved.children.map(n => n.className), ['b-tabs-list', 'tb-btn b-new']);

  const unsaved = renderStrip(model, { saving: false }).el;
  assert.deepEqual(byClass(unsaved, 'b-note').map(n => n.textContent), [NOT_SAVED_TEXT]);
});

test('the strip follows what the program says about saving', () => {
  const plain = mounted();
  assert.deepEqual(byClass(plain.host, 'b-note').map(n => n.textContent), [NOT_SAVED_TEXT], 'no data folder');
  plain.pr.done();

  const m = mounted();
  m.page.ws.receive({ t: 'boards', ...SAVING });
  assert.deepEqual(byClass(m.host, 'b-note'), []);
  assert.deepEqual(m.page.remote.boards(), SAVING);

  const second = { code: 'second_program', id: 1, text: 'Another Rukh (on port 62206) is using this data folder, so these boards are not being saved.' };
  m.page.ws.receive({ t: 'boards', saving: false, notices: [second] });
  assert.deepEqual(byClass(m.host, 'b-note').map(n => n.textContent), [NOT_SAVED_TEXT]);

  m.pr.done();
});

test('a hello without the boards key counts as not saved', () => {
  const st = createStore({ storage: null });
  const remote = startRemoteSync({ store: st, actions: st.actions, location: { href: 'http://127.0.0.1:47480/' }, WebSocket: FakeSocket });
  const ws = FakeSocket.last;

  ws.onopen();
  ws.receive({ t: 'hello', proto: 2, instance: 'i1', you: 'view:1' });
  assert.deepEqual(remote.boards(), { saving: false, notices: [] });

  remote.stop();
  st.dispose();
});

test('each notice is shown once, as the program words it, and not again on a reconnect', () => {
  const page = lonePage({ saving: true, notices: [BROKEN, FRESH] });

  assert.deepEqual(page.toasts, [{ text: BROKEN.text, kind: 'error' }, { text: FRESH.text, kind: 'info' }]);
  assert.deepEqual(page.remote.boards(), { saving: true, notices: [BROKEN, FRESH] });

  page.receive({ t: 'boards', saving: true, notices: [BROKEN, FRESH, HELD] });
  assert.deepEqual(page.toasts.slice(2), [{ text: HELD.text, kind: 'error' }], 'only the new one');

  page.reconnect({ saving: true, notices: [BROKEN, FRESH, HELD] });
  assert.equal(page.toasts.length, 3, 'the same program start says nothing again');
  assert.equal(page.remote.connected(), true);

  page.reconnect({ saving: true, notices: [FRESH] }, 'i2');
  assert.deepEqual(page.toasts.slice(3), [{ text: FRESH.text, kind: 'info' }], 'a restarted program numbers its notices again');

  page.done();
});

test('a notice holding markup is shown as text', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const body = document.createElement('body');
  document.body = body;
  t.after(() => { delete document.body; });

  const st = createStore({ storage: null });
  const dialogs = createDialogs({ store: st, actions: st.actions });
  const remote = startRemoteSync({ store: st, actions: st.actions, location: { href: 'http://127.0.0.1:47480/' }, WebSocket: FakeSocket });
  const ws = FakeSocket.last;

  const text = 'Board t3 («<b>Rook</b>: game 24») <img src=x onerror="alert(1)"> is a coach game.';
  ws.onopen();
  ws.receive({ t: 'hello', proto: 2, instance: 'i1', you: 'view:1', boards: { saving: true, notices: [{ code: 'coach_game', id: 1, text }] } });

  const shown = byClass(body, 'toast');
  assert.equal(shown.length, 1);
  assert.equal(shown[0].textContent, text);
  assert.equal(shown[0].innerHTML, '');
  assert.deepEqual(shown[0].childNodes.map(n => n.nodeType), [3], 'one text node, no elements');

  remote.stop();
  dialogs.dispose();
  st.dispose();
});

const { createMoveList } = await import('../src/ui/moveList.js');

const newBoard = m => m.pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
const names = m => byRole(m.host, 'tab').map(b => b.textContent);
const menuFor = (m, name) => {
  byClass(m.host, 'b-tab').find(item => item.childNodes[0].textContent === name).childNodes[1].fire('click');
  return m.menus.at(-1).items;
};
const item = (items, label) => items.find(i => i.label === label);

test('Move left and Move right send tab_move with the new place', () => {
  const m = mounted();
  newBoard(m);
  newBoard(m);

  item(menuFor(m, 'Board 2'), 'Move left').onClick();
  assert.deepEqual(m.sent(), [{ op: 'tab_move', tab: 't2', to: 0 }]);
  m.pr.pump();
  assert.deepEqual(names(m), ['Board 2', 'Board 1', 'Board 3']);

  m.page.ws.sent.length = 0;
  item(menuFor(m, 'Board 2'), 'Move right').onClick();
  assert.deepEqual(m.sent(), [{ op: 'tab_move', tab: 't2', to: 1 }]);
  m.pr.pump();
  assert.deepEqual(names(m), ['Board 1', 'Board 2', 'Board 3']);
  assert.equal(m.pr.desk.selected, 't3', 'a move keeps the selection');

  m.pr.done();
});

test('Move left is off on the first tab, Move right on the last, and both on a single tab', () => {
  const m = mounted();

  const single = menuFor(m, 'Board 1');
  assert.deepEqual(single.map(i => [i.label, !!i.disabled]), [['Rename', false], ['Close', false], ['Move left', true], ['Move right', true]]);

  newBoard(m);
  newBoard(m);
  assert.deepEqual([item(menuFor(m, 'Board 1'), 'Move left').disabled, item(menuFor(m, 'Board 1'), 'Move right').disabled], [true, false]);
  assert.deepEqual([item(menuFor(m, 'Board 2'), 'Move left').disabled, item(menuFor(m, 'Board 2'), 'Move right').disabled], [false, false]);
  assert.deepEqual([item(menuFor(m, 'Board 3'), 'Move left').disabled, item(menuFor(m, 'Board 3'), 'Move right').disabled], [false, true]);

  m.pr.done();
});

test('the strip follows the order the frame gives', () => {
  const m = mounted();
  newBoard(m);
  newBoard(m);
  const first = tabButton(m.host, 'Board 1');

  m.pr.view('view:9', { op: 'tab_move', tab: 't1', to: 2 });
  assert.deepEqual(names(m), ['Board 2', 'Board 3', 'Board 1']);
  assert.equal(tabButton(m.host, 'Board 1'), first, 'the same button, moved');

  m.pr.done();
});

test('renderStrip draws the tabs in the order of the model', () => {
  const order = renderStrip(stripModel([FRAME.tabs[2], FRAME.tabs[0], FRAME.tabs[1]], 't4', FRAME.state));
  assert.deepEqual(byRole(order.el, 'tab').map(b => b.textContent), ['Italian, the Bc5 line', 'Board 1', 'Board 2']);
});

test('"+" makes a board at once while no closed board waits', () => {
  const m = mounted({ saving: true });
  assert.equal(m.page.remote.closedBoards(), 0);

  const add = byClass(m.host, 'b-new')[0];
  assert.equal(add.getAttribute('aria-haspopup'), null);

  add.fire('click');
  assert.deepEqual(m.menus, []);
  assert.deepEqual(m.sent(), [{ op: 'tab_new', name: null, copy_of: null }]);

  m.pr.done();
});

test('with a closed board waiting, "+" offers New board and Reopen closed board', () => {
  const m = mounted({ saving: true });
  newBoard(m);
  m.pr.view('view:9', { op: 'tab_close', tab: 't1' });
  assert.equal(m.page.remote.closedBoards(), 1);

  const add = byClass(m.host, 'b-new')[0];
  assert.equal(add.getAttribute('aria-haspopup'), 'menu');

  add.fire('click');
  assert.deepEqual(m.menus[0].items.map(i => i.label), ['New board', 'Reopen closed board']);
  assert.equal(m.menus[0].anchor, add);
  assert.deepEqual(m.sent(), [], 'opening the menu sends nothing');

  item(m.menus[0].items, 'Reopen closed board').onClick();
  assert.deepEqual(m.sent(), [{ op: 'tab_reopen' }]);

  m.pr.pump();
  assert.deepEqual(names(m), ['Board 2', 'Board 1'], 'back at the end');
  assert.equal(tabButton(m.host, 'Board 1').getAttribute('aria-selected'), 'true');
  assert.equal(m.page.remote.closedBoards(), 0);

  m.page.ws.sent.length = 0;
  add.fire('click');
  assert.equal(m.menus.length, 1, 'none waits now, so "+" acts at once');
  assert.deepEqual(m.sent(), [{ op: 'tab_new', name: null, copy_of: null }]);

  m.pr.done();
});

test('New board in the "+" menu sends tab_new', () => {
  const m = mounted({ saving: true });
  newBoard(m);
  m.pr.view('view:9', { op: 'tab_close', tab: 't2' });

  byClass(m.host, 'b-new')[0].fire('click');
  item(m.menus[0].items, 'New board').onClick();
  assert.deepEqual(m.sent(), [{ op: 'tab_new', name: null, copy_of: null }]);

  m.pr.done();
});

test('a refused reopen shows the program\'s refusal', () => {
  const m = mounted({ saving: true });
  for (let i = 0; i < 11; i++) newBoard(m);
  m.pr.view('view:9', { op: 'tab_close', tab: 't1' });
  newBoard(m);
  assert.equal(byRole(m.host, 'tab').length, 12);

  byClass(m.host, 'b-new')[0].fire('click');
  item(m.menus[0].items, 'Reopen closed board').onClick();
  m.pr.pump();

  assert.deepEqual(m.page.toasts, [{ text: TAB_LIMIT_TEXT, kind: 'error' }]);
  assert.equal(m.page.remote.closedBoards(), 1, 'the closed board still waits');

  // A count the program has not corrected yet: its own words come back.
  const lone = mounted({ saving: true });
  lone.page.ws.receive({ t: 'boards', saving: true, notices: [], closed: 1 });
  byClass(lone.host, 'b-new')[0].fire('click');
  item(lone.menus[0].items, 'Reopen closed board').onClick();
  lone.pr.pump();

  assert.deepEqual(lone.page.toasts, [{ text: 'The Rukh program did not take that: There is no closed board to reopen.', kind: 'error' }]);

  m.pr.done();
  lone.pr.done();
});

test('the close confirm says the moves are lost only when boards are not saved', async () => {
  const saved = mounted({ saving: true, answer: false });
  saved.page.st.actions.playMove('e2e4');
  saved.pr.pump();
  closeFromMenu(saved, 'Board 1');
  await tick();

  assert.deepEqual(saved.asked.map(a => a.text), ['Close «Board 1»?']);
  assert.equal(closeText('Board 1', true), 'Close «Board 1»?');

  const unsaved = mounted({ answer: false });
  unsaved.page.st.actions.playMove('e2e4');
  unsaved.pr.pump();
  closeFromMenu(unsaved, 'Board 1');
  await tick();

  assert.deepEqual(unsaved.asked.map(a => a.text), ['Close «Board 1»? Its moves and notes will be lost.']);

  saved.pr.done();
  unsaved.pr.done();
});

test('each mark draws its own dot and puts its words in the tab\'s name; no mark draws none', () => {
  const tabs = ['your_move', 'waiting', 'paused', 'over', null].map((mark, i) => ({ id: `t${i + 1}`, name: `Board ${i + 1}`, kind: 'free', mark }));
  const { el } = renderStrip(stripModel(tabs, 't1', null));
  const buttons = byRole(el, 'tab');

  assert.deepEqual(buttons.map(b => byClass(b, 'b-dot').map(d => d.className)), [
    ['b-dot your_move'], ['b-dot waiting'], ['b-dot paused'], ['b-dot over'], [],
  ]);
  assert.deepEqual(buttons.map(b => b.getAttribute('aria-label')), [
    'Board 1, your move', 'Board 2, their move', 'Board 3, paused', 'Board 4, game over', null,
  ]);
  assert.deepEqual(buttons.map(b => b.getAttribute('title')), buttons.map((_, i) => tabLabel(tabs[i])));
  assert.equal(buttons[4].getAttribute('title'), 'Board 5');
  assert.deepEqual(buttons.map(b => b.textContent), tabs.map(t => t.name), 'the dot adds no text');
  assert.ok(byClass(el, 'b-dot').every(d => d.getAttribute('aria-hidden') === 'true'));
});

test('a mark that comes and goes adds and drops the dot on the same tab', () => {
  const m = mounted();
  const button = tabButton(m.host, 'Board 1');

  m.pr.mark('t1', 'your_move');
  assert.equal(tabButton(m.host, 'Board 1'), button);
  assert.deepEqual(byClass(button, 'b-dot').map(d => d.className), ['b-dot your_move']);
  assert.equal(button.getAttribute('aria-label'), 'Board 1, your move');

  m.pr.mark('t1', 'over');
  assert.deepEqual(byClass(button, 'b-dot').map(d => d.className), ['b-dot over']);

  m.pr.mark('t1', null);
  assert.deepEqual(byClass(button, 'b-dot'), []);
  assert.equal(button.getAttribute('aria-label'), null);

  m.pr.done();
});

test('the dot rules use colour tokens and no motion', async () => {
  for (const mark of ['your_move', 'waiting', 'paused', 'over']) {
    const rule = await cssRule(`.b-dot.${mark}`);
    assert.match(rule, /var\(--[a-z-]+\)/, `${mark} uses a token`);
    assert.doesNotMatch(rule, /#[0-9a-f]{3,6}|rgba?\(/i, `${mark} names no colour of its own`);
  }

  assert.deepEqual(declarations(await cssRule('.b-dot.your_move')), ['background: var(--gold)'], 'your move: solid gold');
  assert.deepEqual(declarations(await cssRule('.b-dot.waiting')), ['border: 1.5px solid var(--gold)'], 'their move: a gold ring');
  assert.deepEqual(declarations(await cssRule('.b-dot.paused')), ['border: 1.5px solid var(--mute)'], 'paused: a grey ring');
  assert.deepEqual(declarations(await cssRule('.b-dot.over')), ['background: var(--mute)'], 'over: solid grey');
  assert.doesNotMatch(await cssRule('.b-dot'), /animation|transition/);
});

test('press a tab, redraw from a new frame, release: the select is sent', () => {
  const m = mounted();
  newBoard(m);
  m.pr.view('view:9', { op: 'tab_select', tab: 't1' });

  const pressed = tabButton(m.host, 'Board 2');
  pressed.fire('pointerdown');

  m.page.st.actions.playMove('e2e4');
  m.pr.pump();
  assert.equal(m.pr.desk.table('t1').game.mainline().length, 2, 'the move landed, and the strip redrew');

  assert.equal(tabButton(m.host, 'Board 2'), pressed, 'the pressed button is still the one in the strip');
  assert.ok(walk(m.host).includes(pressed));

  m.page.ws.sent.length = 0;
  pressed.fire('click', { detail: 1 });
  assert.deepEqual(m.sent(), [{ op: 'tab_select', tab: 't2' }]);

  m.pr.done();
});

test('press the menu button or "+", redraw, release: each still acts', () => {
  const m = mounted();
  const menuButton = byClass(m.host, 'b-tab-menu')[0];
  const add = byClass(m.host, 'b-new')[0];

  menuButton.fire('pointerdown');
  add.fire('pointerdown');
  m.page.st.actions.playMove('e2e4');
  m.pr.pump();
  m.pr.mark('t1', 'waiting');

  assert.equal(byClass(m.host, 'b-tab-menu')[0], menuButton);
  assert.equal(byClass(m.host, 'b-new')[0], add);

  menuButton.fire('click');
  assert.equal(m.menus.length, 1);

  m.page.ws.sent.length = 0;
  add.fire('click');
  assert.deepEqual(m.sent(), [{ op: 'tab_new', name: null, copy_of: null }]);

  m.pr.done();
});

test('a rename being typed survives a redraw', () => {
  const m = mounted();
  newBoard(m);

  tabButton(m.host, 'Board 2').fire('dblclick');
  const input = byClass(m.host, 'b-tab-input')[0];
  input.value = 'Half typed';

  m.page.st.actions.playMove('e2e4');
  m.pr.pump();
  m.pr.view('view:9', { op: 'tab_rename', tab: 't1', name: 'Elsewhere' });

  assert.equal(byClass(m.host, 'b-tab-input')[0], input);
  assert.equal(input.value, 'Half typed');
  assert.equal(document.activeElement, input);

  input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(m.sent().filter(s => s.op === 'tab_rename'), [{ op: 'tab_rename', tab: 't2', name: 'Half typed' }]);

  m.pr.pump();
  assert.deepEqual(names(m), ['Elsewhere', 'Half typed']);

  m.pr.done();
});

test('the selected tab is scrolled into view when the strip\'s width changes', () => laidOut(() => {
  const observed = [];

  globalThis.ResizeObserver = class {
    constructor(fn) { this.fn = fn; observed.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.off = true; }
  };

  try {
    const m = mounted();
    newBoard(m);
    newBoard(m);
    assert.equal(tabList(m).scrollLeft, 150);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].node, tabList(m));

    tabList(m).scrollLeft = 0;
    observed[0].fn([]);
    assert.equal(tabList(m).scrollLeft, 0, 'the same width moves nothing');

    layout.view = 120;
    observed[0].fn([]);
    assert.equal(tabList(m).scrollLeft, 180, 'Board 3 runs from 200 to 300');

    m.strip.dispose();
    assert.equal(observed[0].off, true);
    m.pr.done();
  } finally {
    delete globalThis.ResizeObserver;
  }
}));

test('twelve tabs with forty-character names keep "+" beside the list, by the DOM and the stylesheet', async () => {
  const m = mounted();
  for (let i = 0; i < 11; i++) newBoard(m);
  for (let i = 1; i <= 12; i++) m.pr.view('view:9', { op: 'tab_rename', tab: `t${i}`, name: `${String(i).padStart(2, '0')} ${'x'.repeat(37)}` });

  assert.equal(byRole(m.host, 'tab').length, 12);
  assert.ok(names(m).every(n => n.length === 40));

  const root = m.strip.el;
  const add = byClass(root, 'b-new')[0];
  assert.deepEqual(root.children.slice(0, 2), [tabList(m), add], '"+" sits beside the list, not in it');
  assert.equal(walk(tabList(m)).includes(add), false);

  // What follows rests on reading the stylesheet; no browser lays it out here.
  assert.match(await cssRule('.topbar .b-tabs'), /grid-template-columns:\s*minmax\(0, max-content\) max-content/);
  assert.match(await cssRule('.b-tabs-list'), /min-width:\s*0/);
  assert.match(await cssRule('.b-tab-name'), /max-width:\s*24ch/);
  assert.match(await cssRule('.topbar .b-tabs'), /overflow:\s*hidden/);

  m.pr.done();
});

test('a window in setup shows which board was switched to, as text, until setup ends', () => {
  const m = mounted();
  m.page.st.actions.setMode('setup');
  assert.deepEqual(byClass(m.host, 'b-setup'), [], 'nothing switched yet');

  newBoard(m);
  assert.deepEqual(byClass(m.host, 'b-setup').map(n => n.textContent), [setupSwitchedText('Board 2')]);
  assert.equal(setupSwitchedText('Board 2'), 'The board switched to «Board 2». Finish or cancel setup to follow.');

  const loud = '<b>Rook</b> <img src=x onerror=a()>';
  m.pr.view('view:9', { op: 'tab_rename', tab: 't2', name: loud });
  const [line] = byClass(m.host, 'b-setup');
  assert.equal(line.textContent, setupSwitchedText(loud));
  assert.equal(line.innerHTML, '');
  assert.deepEqual(line.childNodes.map(n => n.nodeType), [3], 'one text node, no elements');

  m.pr.view('view:9', { op: 'tab_select', tab: 't1' });
  assert.deepEqual(byClass(m.host, 'b-setup'), [], 'back on the board setup began on');

  m.pr.view('view:9', { op: 'tab_select', tab: 't2' });
  assert.equal(byClass(m.host, 'b-setup').length, 1);

  m.page.st.actions.setMode('play');
  assert.deepEqual(byClass(m.host, 'b-setup'), [], 'setup ended');

  m.pr.done();
});

test('a window in setup whose board was closed elsewhere says so', () => {
  const m = mounted();
  newBoard(m);
  m.pr.view('view:9', { op: 'tab_select', tab: 't1' });

  m.page.st.actions.setMode('setup');
  m.pr.view('view:9', { op: 'tab_close', tab: 't1' });

  assert.deepEqual(byClass(m.host, 'b-setup').map(n => n.textContent), [setupClosedText('Board 1')]);
  assert.equal(setupClosedText('Board 1'), '«Board 1» was closed. Finish setup to put this position on a new board.');
  assert.deepEqual(byClass(m.host, 'b-note').map(n => n.textContent), [setupClosedText('Board 1'), NOT_SAVED_TEXT], 'the setup line comes first');

  m.pr.done();
});

test('patchStrip keeps every element of a tab that stays', () => {
  const model = stripModel(FRAME.tabs, FRAME.tab, FRAME.state);
  const drawn = renderStrip(model);
  const before = byRole(drawn.el, 'tab');

  const next = stripModel([...FRAME.tabs.slice(0, 2), { ...FRAME.tabs[2], name: 'Renamed', mark: null }], 't1', null);
  assert.equal(patchStrip(drawn, next), drawn);

  const after = byRole(drawn.el, 'tab');
  assert.deepEqual(after, before);
  assert.deepEqual(after.map(b => [b.textContent, b.getAttribute('aria-selected')]), [['Board 1', 'true'], ['Board 2', 'false'], ['Renamed', 'false']]);

  patchStrip(drawn, next.slice(0, 1));
  assert.deepEqual(byRole(drawn.el, 'tab'), [before[0]]);
});

test('the move list starts from the top on another board and keeps its place otherwise', () => {
  const pr = deskProgram(1);
  const [page] = pr.pages;
  const body = document.createElement('div');
  body.className = 'p-body';

  const moves = createMoveList({ store: page.st, actions: page.st.actions });
  body.appendChild(moves.el);
  page.remote.beforeSwitch(() => moves.leave());

  page.st.actions.playMove('e2e4');
  pr.pump();
  body.scrollTop = 300;
  moves.update();
  assert.equal(body.scrollTop, 300, 'a move on the same board keeps the scroll');

  pr.view('view:9', { op: 'tab_new', name: null, copy_of: null });
  moves.update();
  assert.equal(body.scrollTop, 0);

  body.scrollTop = 120;
  moves.update();
  assert.equal(body.scrollTop, 120, 'only the first update after a switch resets it');

  moves.dispose();
  pr.done();
});

/** Runs `run` with the list's removeChild logged as tab ids; resolves to what was taken out. */
function takenOut(list, run) {
  const out = [];
  const removeChild = list.removeChild;
  list.removeChild = child => {
    out.push(child.dataset.tab);
    return removeChild(child);
  };

  try {
    run();
  } finally {
    list.removeChild = removeChild;
  }

  return out;
}

test('a reorder from another window takes out only the tab that moved, so a pressed tab still gets its click', () => {
  const m = mounted();
  for (let i = 0; i < 3; i++) newBoard(m);
  m.pr.view('view:9', { op: 'tab_select', tab: 't4' });

  const pressed = tabButton(m.host, 'Board 2');
  pressed.fire('pointerdown');

  assert.deepEqual(takenOut(tabList(m), () => m.pr.view('view:9', { op: 'tab_move', tab: 't1', to: 3 })), ['t1']);
  assert.deepEqual(names(m), ['Board 2', 'Board 3', 'Board 4', 'Board 1']);

  assert.deepEqual(takenOut(tabList(m), () => m.pr.view('view:9', { op: 'tab_move', tab: 't4', to: 0 })), ['t4']);
  assert.deepEqual(names(m), ['Board 4', 'Board 2', 'Board 3', 'Board 1']);

  assert.deepEqual(takenOut(tabList(m), () => m.pr.view('view:9', { op: 'tab_move', tab: 't3', to: 1 })), ['t3']);
  assert.deepEqual(names(m), ['Board 4', 'Board 3', 'Board 2', 'Board 1']);

  m.page.ws.sent.length = 0;
  pressed.fire('click', { detail: 1 });
  assert.deepEqual(m.sent(), [{ op: 'tab_select', tab: 't2' }]);

  m.pr.done();
});

test('Move left and Move right work out the place when chosen, not when the menu opened', () => {
  const m = mounted();
  newBoard(m);
  newBoard(m);

  const stale = menuFor(m, 'Board 3');
  m.pr.view('view:9', { op: 'tab_move', tab: 't3', to: 0 });

  item(stale, 'Move left').onClick();
  assert.deepEqual(m.sent(), [], 'already at the left end');

  item(stale, 'Move right').onClick();
  assert.deepEqual(m.sent(), [{ op: 'tab_move', tab: 't3', to: 1 }]);
  m.pr.pump();
  assert.deepEqual(names(m), ['Board 1', 'Board 3', 'Board 2']);

  m.pr.done();
});

test('two Move rights before the program answers move the tab two places', () => {
  const m = mounted();
  newBoard(m);
  newBoard(m);

  item(menuFor(m, 'Board 1'), 'Move right').onClick();
  const again = menuFor(m, 'Board 1');
  assert.equal(item(again, 'Move right').disabled, false);
  item(again, 'Move right').onClick();

  assert.deepEqual(m.sent(), [{ op: 'tab_move', tab: 't1', to: 1 }, { op: 'tab_move', tab: 't1', to: 2 }]);
  m.pr.pump();
  assert.deepEqual(names(m), ['Board 2', 'Board 3', 'Board 1']);
  assert.deepEqual(m.page.toasts, []);

  item(menuFor(m, 'Board 1'), 'Move left').onClick();
  assert.deepEqual(m.sent().at(-1), { op: 'tab_move', tab: 't1', to: 1 }, 'answered, the frame is the truth again');

  m.pr.done();
});

test('closing a saved board that is not a free board still says it is lost', async () => {
  const host = document.createElement('div');
  const asked = [];
  const tabs = { tab: 't1', tabs: [{ id: 't1', name: 'Rook: game 24', kind: 'game', mark: null }] };

  const remote = {
    tabs: () => tabs,
    state: () => ({ game: { nodes: [{ id: 0 }, { id: 1 }] } }),
    boards: () => ({ saving: true, notices: [] }),
    onChange: () => () => {},
    closeTab() {},
  };

  const dialogs = { confirm: async text => { asked.push(text); return false; } };
  const menus = [];
  const strip = mountBoardTabs({ remote, host, dialogs, openMenu: items => menus.push(items) });

  byClass(host, 'b-tab-menu')[0].fire('click');
  item(menus[0], 'Close').onClick();
  await tick();

  assert.deepEqual(asked, ['Close «Rook: game 24»? Its moves and notes will be lost.']);
  strip.dispose();
});

test('a menu opened from the keyboard takes arrow keys and gives focus back to its control', async () => {
  const { openMenu, closeMenu } = await import('../src/ui/layout.js');
  const keys = [];
  const listening = () => new Promise(r => setTimeout(r, 1));

  globalThis.window = { innerWidth: 400, innerHeight: 300, addEventListener() {}, removeEventListener() {} };
  globalThis.Element = class { static [Symbol.hasInstance](n) { return !!(n && n.getBoundingClientRect); } };
  document.body = document.createElement('body');
  document.addEventListener = (type, fn) => { if (type === 'keydown') keys.push(fn); };
  document.removeEventListener = () => {};

  try {
    const add = document.createElement('button');
    add.getBoundingClientRect = () => ({ left: 300, bottom: 30 });
    add.focus();

    const chosen = [];
    const menu = openMenu([
      { label: 'New board', onClick: () => chosen.push('new') },
      { label: 'Reopen closed board', onClick: () => chosen.push('reopen') },
    ], add);

    const [first, second] = menu.children;
    assert.equal(document.activeElement, first, 'the first item has focus');

    await listening();
    const press = key => {
      const ev = { key, preventDefault() {}, stopPropagation() {} };
      for (const fn of keys) fn(ev);
    };

    press('ArrowDown');
    assert.equal(document.activeElement, second);
    press('ArrowDown');
    assert.equal(document.activeElement, first, 'wraps around');
    press('End');
    assert.equal(document.activeElement, second);

    press('Enter');
    second.fire('click');
    assert.deepEqual(chosen, ['reopen']);
    assert.equal(document.activeElement, add, 'focus is back on "+"');

    keys.length = 0;
    openMenu([{ label: 'New board', onClick: () => {} }], add);
    await listening();
    press('Escape');
    assert.equal(document.activeElement, add, 'Escape gives focus back too');
  } finally {
    closeMenu();
    delete globalThis.window;
    delete globalThis.Element;
    delete document.body;
    delete document.addEventListener;
    delete document.removeEventListener;
    document.activeElement = null;
  }
});
