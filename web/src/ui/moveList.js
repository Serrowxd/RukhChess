import { el, button, openMenu, moveNumbering, nagClass, fmtEval, copyText } from './layout.js';

/** Returns { el, update, dispose }. */
export function createMoveList({ store, actions, dialogs }) {
  const list = el('div', { class: 'ml', role: 'list' });
  const varHint = el('span', { class: 'var-hint' });
  const menuBtn = button('', () => menuFor(store.state.game.current.id, menuBtn), { icon: 'dots', title: 'Variation menu for the current move' });

  const nav = el('div', { class: 'ml-nav' },
    button('|<', () => actions.toStart(), { title: 'Start of the line (Home)' }),
    button('<', () => actions.back(), { title: 'Back (←)' }),
    button('>', () => actions.forward(), { title: 'Forward (→)' }),
    button('>|', () => actions.toEnd(), { title: 'End of the line (End)' }),
    menuBtn,
    varHint,
  );

  const root = el('div', {}, nav, list);
  let switched = false; // the next update shows another board

  list.addEventListener('click', e => {
    const mv = e.target.closest('.mv[data-id]');
    if (!mv || !list.contains(mv)) return;

    actions.goto(mv.dataset.id);
  });

  list.addEventListener('contextmenu', e => {
    const mv = e.target.closest('.mv[data-id]');
    if (!mv) return;

    e.preventDefault();
    menuFor(mv.dataset.id, { x: e.clientX, y: e.clientY });
  });

  // A long press on touch opens the same menu.
  let pressTimer = 0;

  list.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;

    const mv = e.target.closest('.mv[data-id]');
    if (!mv) return;

    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => menuFor(mv.dataset.id, { x: e.clientX, y: e.clientY }), 550);
  });

  const clearPress = () => clearTimeout(pressTimer);
  list.addEventListener('pointerup', clearPress);
  list.addEventListener('pointercancel', clearPress);
  list.addEventListener('pointermove', clearPress);

  function branchRoot(g, node) {
    let n = node;

    while (n && n.parentId) {
      const p = g.node(n.parentId);
      if (!p) return null;
      if (!p.children[0] || p.children[0].id !== n.id) return n;
      n = p;
    }

    return null;
  }

  function menuFor(id, at) {
    const g = store.state.game;
    const node = g.node(id);
    if (!node) return;

    const isRoot = !node.parentId;
    const br = branchRoot(g, node);
    const onMain = g.isOnMainline(id);

    openMenu([
      { label: 'Go to this move', onClick: () => actions.goto(id) },
      { sep: true },
      { label: 'Promote variation', disabled: !br, title: 'Move this line one step up among its siblings', onClick: () => actions.promoteVariation(br.id) },
      { label: 'Make main line', disabled: isRoot || onMain, onClick: () => actions.makeMainline(id) },
      {
        label: 'Delete from here', disabled: isRoot, onClick: async () => {
          const ok = dialogs ? await dialogs.confirm('Delete this move and everything after it?', { ok: 'Delete', danger: true }) : true;
          if (ok) actions.deleteFrom(id);
        },
      },
      { sep: true },
      {
        label: 'Copy FEN of this position', onClick: async () => {
          const ok = await copyText(node.fen);
          actions.toast(ok ? 'FEN copied' : 'Copy failed', ok ? 'ok' : 'error');
        }
      },
    ], at);
  }

  function token(g, node, { forceNumber = false, noNumber = false } = {}) {
    const { number, white } = moveNumbering(g, node);
    const isCur = node.id === g.current.id;

    const titleBits = [];
    if (node.note) titleBits.push(node.note);
    if (node.eval && (node.eval.cp != null || node.eval.mate != null)) titleBits.push(`eval ${fmtEval(node.eval)} (d${node.eval.depth || '?'})`);

    const span = el('span', {
      class: 'mv' + (isCur ? ' current' : ''), dataset: { id: node.id }, role: 'listitem',
      title: titleBits.join('\n') || null, 'aria-current': isCur ? 'true' : null,
    });

    if (!noNumber && (white || forceNumber)) span.appendChild(el('span', { class: 'num', text: `${number}${white ? '.' : '...'}` }));
    span.appendChild(document.createTextNode(node.san || '?'));
    if (node.nag) span.appendChild(el('span', { class: nagClass(node.nag), text: node.nag }));
    if (node.note) span.appendChild(el('span', { class: 'note-dot', 'aria-label': 'has a note' }));

    return span;
  }

  function isShortLeaf(node) {
    let n = node, len = 0;

    while (n) {
      len++;
      if (n.children.length > 1 || len > 2) return false;
      n = n.children[0];
    }

    return true;
  }

  function renderFlow(g, first, container, depth) {
    let node = first, force = true, emit = true;

    while (node) {
      // A skipped token keeps `force` for the next one that is emitted.
      if (emit) {
        container.appendChild(token(g, node, { forceNumber: force }));
        force = false;
      }

      emit = true;
      if (!node.children.length) break;

      const next = node.children[0];
      const alts = node.children.slice(1);

      if (alts.length) {
        container.appendChild(token(g, next));

        for (const alt of alts) {
          if (isShortLeaf(alt)) {
            const inl = el('span', { class: 'ml-inline' }, el('span', { class: 'paren', text: ' (' }));
            renderFlow(g, alt, inl, depth + 1);
            inl.appendChild(el('span', { class: 'paren', text: ') ' }));
            container.appendChild(inl);
          } else {
            container.appendChild(renderVariation(g, alt, depth + 1));
          }
        }

        force = true;
        emit = false;
      }

      node = next;
    }
  }

  function renderVariation(g, first, depth) {
    const box = el('div', { class: 'ml-var', style: { '--depth': String(Math.min(depth, 5)) } });
    box.appendChild(el('span', { class: 'paren', text: '(' }));
    renderFlow(g, first, box, depth);
    box.appendChild(el('span', { class: 'paren', text: ')' }));
    return box;
  }

  function renderMain(g, container) {
    let p = g.root, row = null;

    while (p && p.children.length) {
      const main = p.children[0];
      const { number, white } = moveNumbering(g, main);

      if (!row || white) {
        row = el('div', { class: 'ml-row' }, el('span', { class: 'ml-num', text: String(number) }));
        if (!white) row.appendChild(el('span', { class: 'mv empty', text: '…' }));
        container.appendChild(row);
      }

      row.appendChild(token(g, main, { noNumber: true }));

      if (p.children.length > 1) {
        for (const alt of p.children.slice(1)) container.appendChild(renderVariation(g, alt, 0));
        row = null;
      } else if (!white) {
        row = null;
      }

      p = main;
    }
  }

  function resultLine(g) {
    const main = g.mainline();
    const end = main[main.length - 1];
    let res = null, reason = '';

    try {
      const h = g.headers && g.headers.get ? g.headers.get('Result') : null;
      if (h && h !== '*') res = h;
    } catch { /* ignore */ }

    if (!res && end && end.checkmate) res = moveNumbering(g, end).white ? '1-0' : '0-1';

    if (!res && end && g.current.id === end.id) {
      try {
        const st = g.status();
        if (st.outcome) {
          res = st.outcome;
          reason = st.reason || '';
        }
      } catch { /* ignore */ }
    }

    if (!res) return null;
    return el('div', { class: 'ml-result' }, res, reason ? el('small', { text: reason }) : null);
  }

  function update() {
    const g = store.state.game;
    list.textContent = '';
    if (!g || !g.root) return;

    if (!g.root.children.length) {
      list.appendChild(el('div', { class: 'ml-empty', text: store.state.mode === 'setup' ? 'Setup mode — commit a position in I/O to start.' : 'No moves yet. Move a piece on the board.' }));
    } else {
      renderMain(g, list);
      const r = resultLine(g);
      if (r) list.appendChild(r);
    }

    const cur = g.current;
    const parent = cur && cur.parentId ? g.node(cur.parentId) : null;

    if (parent && parent.children.length > 1) varHint.textContent = `${parent.children.length} variations · ↑↓`;
    else if (cur && cur.children.length > 1) varHint.textContent = `${cur.children.length} continuations`;
    else varHint.textContent = '';

    // Another board's moves start from the top of the list.
    if (switched) {
      switched = false;
      const scroller = root.closest('.p-body');
      if (scroller) scroller.scrollTop = 0;
    }

    const curEl = list.querySelector('.mv.current');
    if (curEl && curEl.scrollIntoView) curEl.scrollIntoView({ block: 'nearest' });
  }

  return {
    el: root, update,

    /** The page is about to show another board. */
    leave() {
      switched = true;
    },

    dispose() {
      clearTimeout(pressTimer);
      root.remove();
    },
  };
}
