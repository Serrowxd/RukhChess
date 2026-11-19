const LS_W = 'chessboard.ui.panelWidth';
const LS_H = 'chessboard.ui.panelHeight';
const MIN_W = 300, MAX_W = 640, DEF_W = 380;
const MIN_H = 140;
const DRAWER_QUERY = '(max-width: 899px)';

/** Tab descriptors in display order. */
export const PANELS = [
  { id: 'moves', label: 'Moves', icon: 'list' },
  { id: 'engine', label: 'Engine', icon: 'cpu' },
  { id: 'ai', label: 'AI', icon: 'sparkle' },
  { id: 'notes', label: 'Notes', icon: 'pencil' },
  { id: 'io', label: 'I/O', icon: 'swap' },
  { id: 'settings', label: 'Settings', icon: 'gear' },
];

export const PIECE_GLYPHS = {
  white: { king: '♔', queen: '♕', rook: '♖', bishop: '♗', knight: '♘', pawn: '♙' },
  black: { king: '♚', queen: '♛', rook: '♜', bishop: '♝', knight: '♞', pawn: '♟' },
};

const ICONS = {
  list: '<path d="M5.5 4h9M5.5 8h9M5.5 12h9"/><circle cx="2.5" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="2.5" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="2.5" cy="12" r="1" fill="currentColor" stroke="none"/>',
  cpu: '<rect x="4" y="4" width="8" height="8" rx="1.2"/><path d="M6 1.5v2.5M10 1.5v2.5M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5"/>',
  sparkle: '<path d="M8 1.5l1.7 4.6L14.5 8l-4.8 1.9L8 14.5 6.3 9.9 1.5 8l4.8-1.9z"/>',
  pencil: '<path d="M11.2 2.3l2.5 2.5L5.2 13.3 2 14l.7-3.2z"/><path d="M9.8 3.7l2.5 2.5"/>',
  swap: '<path d="M2.5 5h10M10 2l3 3-3 3M13.5 11h-10M6 8l-3 3 3 3"/>',
  gear: '<circle cx="8" cy="8" r="2.3"/><path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.6 1.6M11 11l1.6 1.6M3.4 12.6L5 11M11 5l1.6-1.6"/>',
  left: '<path d="M10 3L5 8l5 5"/>',
  right: '<path d="M6 3l5 5-5 5"/>',
  up: '<path d="M3 10l5-5 5 5"/>',
  down: '<path d="M3 6l5 5 5-5"/>',
  dots: '<circle cx="3" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="8" r="1.3" fill="currentColor" stroke="none"/>',
  close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M3.5 10.5h-1v-8h8v1"/>',
  check: '<path d="M2.5 8.5l3.5 3.5 7.5-8"/>',
  flip: '<path d="M4 6a4.5 4.5 0 0 1 8 0M12 10a4.5 4.5 0 0 1-8 0"/><path d="M12 3v3H9M4 13v-3h3"/>',
};

/** Build an element; see docs/ui.md for how attrs are applied. */
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);

  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;

      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') node.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'open' || k === 'hidden') node[k] = !!v;
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }

  append(node, children);
  return node;
}

/** Strings, nodes and nested arrays; null and false are skipped. */
export function append(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;

    if (Array.isArray(c)) append(node, c);
    else if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }

  return node;
}

export function icon(name) {
  const span = el('span', { class: 'icon', 'aria-hidden': 'true' });
  const d = ICONS[name] || '';
  span.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  return span;
}

/** opts: { class, title, icon, primary, small, danger, disabled, pressed } */
export function button(label, onClick, opts = {}) {
  const cls = ['btn', opts.primary && 'primary', opts.small && 'small', opts.danger && 'danger', opts.class].filter(Boolean).join(' ');

  const b = el('button', {
    type: 'button', class: cls, title: opts.title, disabled: opts.disabled,
    'aria-pressed': opts.pressed == null ? null : String(!!opts.pressed), onclick: onClick,
  }, opts.icon ? icon(opts.icon) : null, label);

  return b;
}

export function field(label, control, opts = {}) {
  return el('div', { class: 'field' + (opts.class ? ' ' + opts.class : '') }, el('span', { class: 'lbl', text: label }), control);
}

/** Label on the left, switch on the right; the checkbox is exposed as row.input. */
export function toggleRow(label, checked, onChange, title) {
  const input = el('input', { type: 'checkbox', checked: !!checked, onchange: e => onChange(e.target.checked) });
  const row = el('label', { class: 'sw', title }, el('span', { text: label }), input);
  row.input = input;
  return row;
}

/** options: [{value, label, title?}]. The element gets .set(value). */
export function segmented(options, value, onChange) {
  const seg = el('div', { class: 'seg', role: 'group' });
  const buttons = new Map();

  for (const o of options) {
    const b = el('button', {
      type: 'button', text: o.label, title: o.title, 'aria-pressed': String(o.value === value),
      onclick: () => {
        seg.set(o.value);
        onChange(o.value);
      }
    });
    buttons.set(o.value, b);
    seg.appendChild(b);
  }

  seg.set = v => {
    for (const [val, b] of buttons) b.setAttribute('aria-pressed', String(val === v));
  };

  return seg;
}

/** The returned fn has .flush() and .cancel(). */
export function debounce(fn, ms) {
  let t = 0, lastArgs = null;

  const run = (...args) => {
    lastArgs = args;
    clearTimeout(t);
    t = setTimeout(() => {
      t = 0;
      lastArgs = null;
      fn(...args);
    }, ms);
  };

  run.flush = () => {
    if (t) {
      clearTimeout(t);
      t = 0;
      const a = lastArgs;
      lastArgs = null;
      fn(...a);
    }
  };

  run.cancel = () => {
    clearTimeout(t);
    t = 0;
    lastArgs = null;
  };

  return run;
}

let openMenuEl = null;
let menuCleanup = null;

export function closeMenu() {
  if (menuCleanup) {
    menuCleanup();
    menuCleanup = null;
  }

  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

export function isMenuOpen() { return !!openMenuEl; }

/** at: viewport {x, y} or an element to anchor under. items: [{ label, onClick, disabled?, sep? }] */
export function openMenu(items, at) {
  closeMenu();

  const menu = el('div', { class: 'menu', role: 'menu' });
  let byKey = false; // the menu is being used from the keyboard

  // Keyboard use gives focus back to the control that opened the menu.
  const focusBack = () => {
    if (byKey && at && typeof at.focus === 'function') at.focus();
  };

  for (const it of items) {
    if (it.sep) {
      menu.appendChild(el('div', { class: 'menu-sep' }));
      continue;
    }

    menu.appendChild(el('button', {
      type: 'button', role: 'menuitem', text: it.label, disabled: it.disabled, title: it.title,
      onclick: () => {
        closeMenu();
        focusBack();
        it.onClick && it.onClick();
      },
    }));
  }

  const choices = () => Array.from(menu.children).filter(b => b.tagName === 'BUTTON' && !b.disabled);

  document.body.appendChild(menu);
  openMenuEl = menu;

  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  } else {
    x = at.x;
    y = at.y;
  }

  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  x = Math.max(8, Math.min(x, window.innerWidth - mw - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - mh - 8));
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const onDown = e => {
    if (!menu.contains(e.target)) closeMenu();
  };

  const onKey = e => {
    byKey = true;

    if (e.key === 'Escape') {
      closeMenu();
      focusBack();
      e.stopPropagation();
      return;
    }

    const all = choices();
    const focused = all.indexOf(document.activeElement);
    let next = -1;

    if (e.key === 'ArrowDown') next = (focused + 1) % all.length;
    else if (e.key === 'ArrowUp') next = focused <= 0 ? all.length - 1 : focused - 1;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next < 0 || !all.length) return;

    e.preventDefault();
    e.stopPropagation();
    all[next].focus();
  };

  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
  }, 0);

  menuCleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', closeMenu);
  };

  const [first] = choices();
  if (first) first.focus();

  return menu;
}

/** Clipboard API, with a textarea fallback for file://. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }

  try {
    const ta = el('textarea', { value: text, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    document.body.appendChild(ta);
    ta.select();

    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** White-view score as '+0.35' / '-1.20' / '#3' / '#-2'. short gives one decimal. */
export function fmtEval(score, short = false) {
  if (!score) return '';

  if (score.mate != null && score.mate !== undefined) {
    const m = score.mate;
    if (m === 0) return '#';
    return m > 0 ? `#${m}` : `#-${Math.abs(m)}`;
  }

  const cp = score.cp || 0;

  // Round on integer centipawns so +35 cp reads "+0.4", not "+0.3".
  const a = Math.abs(cp);
  const s = short ? (Math.round(a / 10) / 10).toFixed(1) : (a / 100).toFixed(2);

  return (cp > 0 ? '+' : cp < 0 ? '-' : '') + s;
}

/** Expected White win percentage 0..100 (lichess sigmoid). */
export function winPct(score) {
  if (!score) return 50;

  // mate 0 means the side to move is mated; score.mated says which side.
  if (score.mate === 0) return score.mated === 'white' ? 0 : score.mated === 'black' ? 100 : 50;
  if (score.mate != null) return score.mate > 0 ? 100 : score.mate < 0 ? 0 : 50;

  const cp = Math.max(-1500, Math.min(1500, score.cp || 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Numbered from the root FEN so games that start mid-way number correctly. */
export function moveNumbering(game, node) {
  const root = game.root;
  const parts = String(root.fen || '').split(' ');
  const turn = parts[1] || 'w';
  const full = parseInt(parts[5], 10) || 1;

  const rootPly = (full - 1) * 2 + (turn === 'b' ? 1 : 0);
  const ply = rootPly + ((node.ply || 0) - (root.ply || 0));

  return { number: Math.floor((ply + 1) / 2), white: ply % 2 === 1, ply };
}

/** '12. Nf3' / '12... Nc6' / 'Start position'. */
export function moveLabel(game, node) {
  if (!node || !node.san) return 'Start position';

  const { number, white } = moveNumbering(game, node);
  return `${number}${white ? '.' : '...'} ${node.san}${node.nag || ''}`;
}

export function nagClass(nag) {
  if (nag === '!' || nag === '!!') return 'nag good';
  if (nag === '!?' || nag === '?!') return 'nag dubious';
  return 'nag';
}

function readNum(key) {
  try {
    const v = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function writeNum(key, v) {
  try {
    localStorage.setItem(key, String(Math.round(v)));
  } catch {
    /* ignore */
  }
}

/** Returns { root, pages, tabs, body, evalBar, clockSlot, setActive, updateEval, update, markDirty, dispose }. */
export function createLayout({ store, actions, view, panelEl }) {
  const root = panelEl || document.getElementById('panel');
  root.textContent = '';
  root.classList.add('panel');

  // Stored sizes are clamped to the current viewport on load and on every resize.
  const clampW = v => Math.max(MIN_W, Math.min(Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - 240)), v));
  const clampH = v => Math.max(MIN_H, Math.min(Math.max(MIN_H, Math.round(window.innerHeight * 0.85)), v));

  function applyStoredSizes() {
    const w = readNum(LS_W);
    if (w) document.documentElement.style.setProperty('--panel-w', clampW(w) + 'px');

    const h = readNum(LS_H);
    if (h) document.documentElement.style.setProperty('--panel-h', clampH(h) + 'px');
  }

  applyStoredSizes();

  const handle = el('div', { class: 'p-handle', title: 'Drag to resize', role: 'separator', 'aria-orientation': 'vertical' });
  let drag = null;

  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;

    const drawer = window.matchMedia(DRAWER_QUERY).matches;
    const r = root.getBoundingClientRect();
    drag = { drawer, x: e.clientX, y: e.clientY, w: r.width, h: r.height };

    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  handle.addEventListener('pointermove', e => {
    if (!drag) return;

    if (drag.drawer) {
      const nh = Math.max(MIN_H, Math.min(window.innerHeight * 0.85, drag.h + (drag.y - e.clientY)));
      document.documentElement.style.setProperty('--panel-h', nh + 'px');
    } else {
      const nw = Math.max(MIN_W, Math.min(Math.min(MAX_W, window.innerWidth - 240), drag.w + (drag.x - e.clientX)));
      document.documentElement.style.setProperty('--panel-w', nw + 'px');
    }

    if (view && view.resize) view.resize();
  });

  const endDrag = () => {
    if (!drag) return;

    const r = root.getBoundingClientRect();
    if (drag.drawer) writeNum(LS_H, r.height);
    else writeNum(LS_W, r.width);

    drag = null;
    handle.classList.remove('dragging');
    document.body.style.userSelect = '';

    if (view && view.resize) requestAnimationFrame(() => view.resize());
  };

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  handle.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--panel-w', DEF_W + 'px');
    document.documentElement.style.removeProperty('--panel-h');

    try {
      localStorage.removeItem(LS_W);
      localStorage.removeItem(LS_H);
    } catch { /* ignore */ }

    if (view && view.resize) requestAnimationFrame(() => view.resize());
  });

  const evalFill = el('div', { class: 'fill' });
  const evalVal = el('div', { class: 'val w', text: '' });
  const evalBar = el('div', { class: 'p-eval', title: 'Engine evaluation (White at the bottom when you sit as White)' }, evalFill, el('div', { class: 'mid' }), evalVal);

  const tabs = new Map();
  const pages = {};
  const body = el('div', { class: 'p-body' });
  const tabStrip = el('div', { class: 'p-tabs', role: 'tablist' });

  for (const p of PANELS) {
    const t = el('button', {
      type: 'button', class: 'tab', role: 'tab', title: p.label, dataset: { panel: p.id },
      onclick: () => {
        const ui = store.state.ui;
        if (ui.collapsed) actions.toggleCollapsed();
        if (ui.panel !== p.id) actions.setPanel(p.id);
      },
    }, icon(p.icon), el('span', { class: 'label', text: p.label }));

    tabs.set(p.id, t);
    tabStrip.appendChild(t);

    const page = el('section', { class: 'page', role: 'tabpanel', dataset: { panel: p.id } });
    pages[p.id] = page;
    body.appendChild(page);
  }

  const collapseBtn = el('button', { type: 'button', class: 'p-collapse', title: 'Collapse panel', onclick: () => actions.toggleCollapsed() }, icon('right'));
  tabStrip.appendChild(collapseBtn);

  // index.js mounts ui/clock.js here.
  const clockSlot = el('div', { class: 'p-clock' });

  const main = el('div', { class: 'p-main' }, clockSlot, tabStrip, body);
  root.append(handle, evalBar, main);

  function setActive(id) {
    for (const [pid, t] of tabs) {
      const on = pid === id;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
      pages[pid].classList.toggle('active', on);
    }
  }

  function updateEval() {
    const s = store.state;
    const eng = s.engine || {};

    const show = !!(s.settings.showEvalBar && eng.enabled && s.mode !== 'setup');
    evalBar.hidden = !show;
    if (!show) return;

    const pct = eng.score ? Math.max(4, Math.min(96, winPct(eng.score))) : 50;
    // Mates run the bar all the way.
    const finalPct = eng.score && eng.score.mate != null ? winPct(eng.score) : pct;

    evalFill.style.height = finalPct + '%';
    evalFill.style.setProperty('--pct', finalPct + '%');
    evalBar.classList.toggle('flip', s.orientation === 'black');

    const txt = eng.score ? fmtEval(eng.score, true) : '';
    evalVal.textContent = txt;
    evalVal.title = eng.score ? `Eval ${fmtEval(eng.score)} (White's view), depth ${eng.depth || 0}` : '';

    // The number sits inside the bigger half.
    const whiteAhead = finalPct >= 50;
    const flip = s.orientation === 'black';
    evalVal.className = 'val ' + (whiteAhead ? 'w' : 'b');

    const atBottom = whiteAhead ? !flip : flip;
    evalVal.style.top = atBottom ? 'auto' : '0';
    evalVal.style.bottom = atBottom ? '0' : 'auto';
  }

  let lastCollapsed = null;

  function update() {
    const ui = store.state.ui;
    const collapsed = !!ui.collapsed;

    root.classList.toggle('collapsed', collapsed);
    collapseBtn.title = collapsed ? 'Expand panel' : 'Collapse panel';
    collapseBtn.replaceChildren(icon(collapsed ? 'left' : 'right'));

    setActive(ui.panel || 'moves');
    updateEval();

    // Resize only when the stage changed size; a resize clears the canvas and would flicker.
    if (lastCollapsed !== null && lastCollapsed !== collapsed && view && view.resize) requestAnimationFrame(() => view.resize());
    lastCollapsed = collapsed;
  }

  const mq = window.matchMedia(DRAWER_QUERY);

  const onMq = () => {
    applyStoredSizes();
    if (view && view.resize) requestAnimationFrame(() => view.resize());
  };

  if (mq.addEventListener) mq.addEventListener('change', onMq);
  else mq.addListener(onMq);

  const onResize = () => {
    if (!drag) applyStoredSizes();
  };

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  /** Small dot on a tab with unseen changes. */
  function markDirty(id, on) {
    const t = tabs.get(id);
    if (t) t.classList.toggle('dirty', !!on);
  }

  return {
    root, pages, tabs, body, evalBar, clockSlot, setActive, updateEval, update, markDirty,
    dispose() {
      closeMenu();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      if (mq.removeEventListener) mq.removeEventListener('change', onMq);
      else mq.removeListener(onMq);
      root.textContent = '';
      root.classList.remove('collapsed');
    },
  };
}
