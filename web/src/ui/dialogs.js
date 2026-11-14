import { el, PIECE_GLYPHS } from './layout.js';

const TOAST_MS = 3000;

/** Returns { confirm, prompt, toast, isOpen, promotion, dispose }. */
export function createDialogs({ store, actions }) {
  const unsubs = [];
  let modal = null;

  const toastHost = el('div', { class: 'toasts', 'aria-live': 'polite' });
  document.body.appendChild(toastHost);

  function closeModal(result) {
    if (!modal) return;

    const m = modal;
    modal = null;
    document.removeEventListener('keydown', m.onKey, true);
    m.bg.remove();
    m.resolve(result);
  }

  /** Opens one modal at a time; resolves with whatever close() is called with. */
  function openModal(build, { onEscape = null, title = '' } = {}) {
    closeModal(undefined);

    return new Promise(resolve => {
      const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
      if (title) box.appendChild(el('div', { class: 'modal-title', text: title }));

      const bg = el('div', {
        class: 'modal-bg',
        onpointerdown: e => {
          if (e.target === bg) close(onEscape ? onEscape() : null);
        }
      }, box);

      const close = r => closeModal(r);

      const onKey = e => {
        // A focused button or textarea owns Enter itself.
        const tag = e.target && e.target.tagName;

        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          close(onEscape ? onEscape() : null);
        } else if (e.key === 'Enter' && modal && modal.onEnter && tag !== 'TEXTAREA' && tag !== 'BUTTON') {
          e.preventDefault();
          modal.onEnter();
        }
      };

      modal = { bg, box, resolve, onKey, onEnter: null };
      const focusEl = build(box, close, modal);

      document.body.appendChild(bg);
      document.addEventListener('keydown', onKey, true);

      setTimeout(() => {
        (focusEl || box.querySelector('button, input, textarea') || box).focus();
      }, 0);
    });
  }

  /** Resolves true on OK, false on Cancel, Escape or backdrop. */
  function confirm(text, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
    return openModal((box, close, m) => {
      const okBtn = el('button', { type: 'button', class: 'btn' + (danger ? ' danger' : ' primary'), text: ok, onclick: () => close(true) });

      box.append(
        el('div', { class: 'modal-text', text }),
        el('div', { class: 'modal-acts' }, el('button', { type: 'button', class: 'btn', text: cancel, onclick: () => close(false) }), okBtn),
      );

      m.onEnter = () => close(true);
      return okBtn;
    }, { onEscape: () => false }).then(r => !!r);
  }

  /** Resolves the string, or null on Cancel, Escape or backdrop. */
  function prompt(text, def = '', { ok = 'OK', type = 'text', min, max, placeholder } = {}) {
    return openModal((box, close, m) => {
      const input = el('input', { type, class: 'inp', value: def, min, max, placeholder });
      const okBtn = el('button', { type: 'button', class: 'btn primary', text: ok, onclick: () => close(input.value) });

      box.append(
        el('div', { class: 'modal-text', text }),
        input,
        el('div', { class: 'modal-acts' }, el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => close(null) }), okBtn),
      );

      m.onEnter = () => close(input.value);
      setTimeout(() => input.select(), 0);
      return input;
    }, { onEscape: () => null }).then(r => (r == null ? null : String(r)));
  }

  /** kind: 'info' | 'error' | 'ok'. */
  function toast(text, kind = 'info') {
    if (!text) return;

    const t = el('div', { class: 'toast ' + (kind || 'info'), role: 'status', text: String(text) });
    toastHost.appendChild(t);
    while (toastHost.children.length > 4) toastHost.firstChild.remove();

    setTimeout(() => {
      t.classList.add('leaving');
      setTimeout(() => t.remove(), 300);
    }, kind === 'error' ? TOAST_MS + 1500 : TOAST_MS);
  }

  function showPromotion({ from, to }) {
    const color = store.state.game.turn();
    const glyphs = PIECE_GLYPHS[color] || PIECE_GLYPHS.white;
    const roles = [['queen', 'q'], ['rook', 'r'], ['bishop', 'b'], ['knight', 'n']];

    openModal((box, close) => {
      const row = el('div', { class: 'promo' });
      let first = null;

      for (const [role, code] of roles) {
        const b = el('button', { type: 'button', title: role[0].toUpperCase() + role.slice(1), text: glyphs[role], onclick: () => close({ promotion: code }) });
        if (!first) first = b;
        row.appendChild(b);
      }

      box.append(row, el('div', { class: 'modal-acts' }, el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => close(null) })));
      return first;
    }, { title: `Promote ${from}→${to}`, onEscape: () => null }).then(r => {
      if (r && r.promotion) actions.playMove({ from, to, promotion: r.promotion });
      else actions.select(null);
    });
  }

  const onPromo = payload => showPromotion(payload || {});

  const onToast = payload => {
    if (payload) toast(payload.text, payload.kind);
  };

  const sub = (evt, fn) => {
    const off = store.on(evt, fn);
    unsubs.push(typeof off === 'function' ? off : () => store.off(evt, fn));
  };

  sub('promotion:required', onPromo);
  sub('toast', onToast);

  return {
    confirm, prompt, toast,
    isOpen: () => !!modal,
    promotion: { show: showPromotion, cancel: () => closeModal(null) },
    dispose() {
      for (const u of unsubs) u();
      closeModal(undefined);
      toastHost.remove();
    },
  };
}
