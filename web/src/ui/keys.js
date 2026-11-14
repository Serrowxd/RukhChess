import { isMenuOpen, closeMenu } from './layout.js';

/** Cheat-sheet rows used by the Settings panel. */
export const KEY_ROWS = [
  ['← / →', 'Previous / next move'],
  ['↑ / ↓', 'Previous / next variation at this point'],
  ['Home / End', 'Start / end of the line'],
  ['Ctrl+Z', 'Take back'],
  ['F', 'Flip the board'],
  ['V', 'Switch between 2D and 3D'],
  ['L', 'Toggle legal-move dots'],
  ['E', 'Toggle the engine'],
  ['Esc', 'Deselect / close menu'],
];

/** Mirrors three/interact.js. */
export const MOUSE_ROWS = [
  ['Click / drag', 'Move a piece (either side)'],
  ['Right-click', 'Highlight a square'],
  ['Right-drag', 'Draw an arrow (knight moves draw as an L)'],
  ['Shift / Alt / Ctrl', 'Red / blue / yellow instead of green'],
  ['Left-drag on empty', 'Orbit the camera'],
  ['Middle-drag, Shift+drag', 'Pan'],
  ['Wheel', 'Zoom'],
  ['Double-click', 'Focus a piece / reset the view'],
];

function isTyping(target) {
  if (!target || !(target instanceof Element)) return false;

  const tag = target.tagName;

  // Checkboxes and buttons have no native key behaviour, so keys pass through them.
  if (tag === 'INPUT') {
    const t = String(target.type || 'text').toLowerCase();
    return !(t === 'checkbox' || t === 'button' || t === 'submit' || t === 'reset' || t === 'file' || t === 'color');
  }

  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return !!target.closest('[contenteditable=""], [contenteditable="true"]');
}

/** Returns a dispose function. */
export function installKeys({ store, actions, dialogs }) {
  function onKey(e) {
    if (e.defaultPrevented) return;
    if (dialogs && dialogs.isOpen && dialogs.isOpen()) return;
    if (isTyping(e.target)) return;

    const s = store.state;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;

    if (mod && !e.shiftKey && !e.altKey && (key === 'z' || key === 'Z')) actions.back();
    else if (mod || e.altKey) handled = false;
    else if (key === 'ArrowLeft') actions.back();
    else if (key === 'ArrowRight') actions.forward();
    else if (key === 'ArrowUp') actions.prevVariation();
    else if (key === 'ArrowDown') actions.nextVariation();
    else if (key === 'Home') actions.toStart();
    else if (key === 'End') actions.toEnd();
    else if (key === 'f' || key === 'F') actions.flip();
    else if (key === 'v' || key === 'V') {
      if (typeof actions.toggleViewMode === 'function') actions.toggleViewMode();
      else if (typeof actions.setViewMode === 'function') actions.setViewMode(s.viewMode === '2d' ? '3d' : '2d');
      else handled = false;
    }
    else if (key === 'l' || key === 'L') actions.setSetting('showLegalMoves', !s.settings.showLegalMoves);
    else if (key === 'e' || key === 'E') actions.setSetting('engine.enabled', !s.settings.engine.enabled);
    else if (key === 'Escape') {
      if (isMenuOpen()) closeMenu();
      else actions.select(null);
    }
    else handled = false;

    if (handled) e.preventDefault();
  }

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
