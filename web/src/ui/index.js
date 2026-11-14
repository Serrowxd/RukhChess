// ui/index.js — mountUi({ store, actions, engine, ai, view, layer, board }) → ui. Builds the panel
// (layout + six tabs), the game clock in the panel shell, the floating topbar and status chip over
// #stage, dialogs, toasts and keys; applies settings.uiTheme to <html data-theme>; routes store
// events to panel updates (coalesced per animation frame; hidden tabs update lazily when shown).
// Beyond the contract: the returned object also exposes { dialogs, layout, topbar, panels, clock,
// getSetupBrush(), refresh() } for the integrator / window.__chessboard debugging.

import { createLayout } from './layout.js';
import { createTopbar } from './topbar.js';
import { createMoveList } from './moveList.js';
import { createEnginePanel } from './enginePanel.js';
import { createAiPanel } from './aiPanel.js';
import { createNotesPanel } from './notesPanel.js';
import { createIoPanel } from './ioPanel.js';
import { createSettingsPanel } from './settingsPanel.js';
import { createDialogs } from './dialogs.js';
import { createClock } from './clock.js';
import { installKeys } from './keys.js';

const EVENT_MAP = {
  'game:change': ['moves', 'notes', 'io', 'ai', 'engine', 'topbar', 'layout'],
  'position:change': ['io', 'ai', 'topbar'],
  'annotations:change': ['moves', 'notes', 'io', 'ai'],
  'engine:update': ['engine', 'layout', 'topbar', 'ai'],
  'ai:update': ['ai'],
  'settings:change': ['settings', 'topbar', 'layout', 'engine', 'ai', 'notes'],
  'mode:change': ['topbar', 'io', 'moves', 'notes', 'engine', 'layout'],
  'ui:change': ['layout', 'topbar'],
  'orientation:change': ['layout', 'topbar', 'io'],
  'study:change': ['notes', 'io', 'ai'],   // emitted by core for title / study-notes edits (not in the contract; harmless if absent)
  // addendum v1. 'clock:tick' is deliberately absent: ui/clock.js listens to it directly and only
  // writes text nodes, so a 5 Hz tick never reaches the per-frame panel rebuild below.
  'viewmode:change': ['topbar', 'settings', 'layout'],
  'selfplay:change': ['engine', 'settings', 'topbar'],
  'clock:change': ['engine'],
};

/** Apply settings.uiTheme ('auto' | 'light' | 'dark') to <html data-theme>. */
export function applyUiTheme(uiTheme) {
  const html = document.documentElement;
  if (uiTheme === 'light' || uiTheme === 'dark') html.setAttribute('data-theme', uiTheme);
  else html.removeAttribute('data-theme');
}

/** Mount the whole UI. Returns { dispose(), ... }. */
export function mountUi({ store, actions, engine, ai, view, layer, board }) {
  const stage = document.getElementById('stage');
  const panelEl = document.getElementById('panel');
  const unsubs = [];
  const sub = (evt, fn) => { const off = store.on(evt, fn); unsubs.push(typeof off === 'function' ? off : () => store.off(evt, fn)); };

  applyUiTheme(store.state.settings.uiTheme);

  const dialogs = createDialogs({ store, actions });
  const layout = createLayout({ store, actions, view, panelEl });
  const topbar = createTopbar({ store, actions, view, dialogs, stage });
  const clock = createClock({ store, actions });
  layout.clockSlot.appendChild(clock.el);

  const panels = {
    moves: createMoveList({ store, actions, dialogs }),
    engine: createEnginePanel({ store, actions, engine }),
    ai: createAiPanel({ store, actions, ai, dialogs }),
    notes: createNotesPanel({ store, actions }),
    io: createIoPanel({ store, actions, dialogs }),
    settings: createSettingsPanel({ store, actions, view, dialogs }),
  };
  for (const [name, p] of Object.entries(panels)) layout.pages[name].appendChild(p.el);

  const disposeKeys = installKeys({ store, actions, dialogs });

  // --- update scheduling: coalesce per frame; hidden tabs stay dirty until shown ---
  const dirty = new Set();
  let raf = 0;
  function target(name) {
    if (name === 'topbar') return topbar;
    if (name === 'layout') return layout;
    return panels[name];
  }
  function flush() {
    raf = 0;
    const active = store.state.ui.panel || 'moves';
    for (const name of Array.from(dirty)) {
      const isPanel = !!panels[name];
      if (isPanel && name !== active) continue;   // wait until shown
      dirty.delete(name);
      const t = target(name);
      if (!t) continue;
      try { t.update(); } catch (e) { console.error(`[ui] ${name}.update failed`, e); }
    }
  }
  function mark(names) {
    for (const n of names) dirty.add(n);
    if (!raf) raf = requestAnimationFrame(flush);
  }
  function refresh() { mark(['layout', 'topbar', ...Object.keys(panels)]); flush(); }

  for (const [evt, names] of Object.entries(EVENT_MAP)) sub(evt, () => mark(names));
  sub('settings:change', ({ path, value }) => { if (path === 'uiTheme') applyUiTheme(value); });
  sub('ui:change', () => { const active = store.state.ui.panel; if (panels[active]) mark([active]); });

  // first paint: everything, synchronously
  layout.update();
  topbar.update();
  clock.update();
  for (const [name, p] of Object.entries(panels)) {
    try { p.update(); } catch (e) { console.error(`[ui] ${name}.update failed`, e); }
  }

  return {
    dialogs, layout, topbar, panels, clock, refresh,
    getSetupBrush: () => panels.io.getBrush(),
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      for (const u of unsubs) { try { u(); } catch { /* ignore */ } }
      disposeKeys();
      for (const p of Object.values(panels)) p.dispose();
      clock.dispose();
      topbar.dispose();
      layout.dispose();
      dialogs.dispose();
    },
  };
}
