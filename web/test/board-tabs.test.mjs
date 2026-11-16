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

const { stripModel, renderStrip, mountBoardTabs, closeText, NOT_SAVED_TEXT } = await import('../src/ui/boardTabs.js');
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
function mounted({ answer = false } = {}) {
  const pr = deskProgram(1);
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
  assert.deepEqual(m.menus[0].items.map(i => i.label), ['Rename', 'Close']);

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

test('the note gives way before the tabs, and the new-board control never shrinks', async () => {
  const note = await cssRule('.b-note');
  assert.match(note, /flex:\s*1 1 0;/, 'the note takes only the room the tabs leave');
  assert.match(note, /min-width:\s*0/);
  assert.match(note, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(note, /padding/, 'padding would keep a sliver of the note from shrinking');

  assert.match(await cssRule('.b-new'), /flex:\s*none/);
  assert.match(await cssRule('.b-tabs-list'), /position:\s*relative/, 'tabs are measured from the list');
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
  assert.notEqual(tabList(m), before, 'the strip was redrawn');
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
