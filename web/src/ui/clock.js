// ui/clock.js — the two-sided game clock that lives in the panel shell (above the tab strip, so it
// is visible on every tab and in the bottom-drawer layout). Reads state.clock, subscribes to
// 'clock:tick' (up to 5x/s) and 'clock:change'. Hidden while untimed, and while no timed game is under way.
//
// DOM churn rule: the element tree is built exactly once. A tick only writes text-node values and
// only when the formatted string actually changed; class changes are guarded by cached booleans.
// Nothing here ever calls replaceChildren / innerHTML / createElement after mount.

import { el } from './layout.js';

const LOW_MS = 30000;        // warning colour under 30 s (contract)
const TENTHS_MS = 20000;     // show tenths under 20 s

const EMPTY_CLOCK = { running: false, white: 0, black: 0, turn: null, increment: 0, initial: 0, flagged: null, startedAt: null };

/** Read state.clock defensively (core may not have landed it yet). */
export function readClock(store) {
  const c = store && store.state && store.state.clock;
  return c && typeof c === 'object' ? c : EMPTY_CLOCK;
}

/** 'h:mm:ss' / 'm:ss' / '9.8' under 20 s. Never negative. */
export function fmtClock(ms) {
  if (!Number.isFinite(ms)) return '--:--';
  const t = Math.max(0, ms);
  if (t < TENTHS_MS) return (Math.floor(t / 100) / 10).toFixed(1);
  const total = Math.ceil(t / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s < 10 ? '0' + s : String(s);
  if (h) return `${h}:${m < 10 ? '0' + m : m}:${ss}`;
  return `${m}:${ss}`;
}

/** 'untimed' | '5+0' | '15+10' from an {initial, increment} pair in ms. */
export function fmtTimeControl(tc) {
  const initial = tc && Number.isFinite(tc.initial) ? tc.initial : 0;
  const inc = tc && Number.isFinite(tc.increment) ? tc.increment : 0;
  if (!initial) return 'untimed';
  const mins = initial / 60000;
  const label = Number.isInteger(mins) ? String(mins) : String(Math.round(mins * 10) / 10);
  return `${label}+${Math.round(inc / 1000)}`;
}

/**
 * Mount the clock. Returns { el, update, tick, dispose }. It owns its own store subscriptions
 * ('clock:tick' / 'clock:change') and releases them in dispose().
 */
export function createClock({ store }) {
  const make = (color, name) => {
    const time = document.createTextNode('0:00');
    const flag = document.createTextNode('');
    const box = el('div', { class: 'ck', dataset: { color } },
      el('span', { class: 'ck-lbl', text: name }),
      el('span', { class: 'ck-t' }, time),
      el('span', { class: 'ck-flag' }, flag),
    );
    return { box, time, flag, state: { text: '', low: null, active: null, flagged: null } };
  };

  const white = make('white', 'White');
  const black = make('black', 'Black');
  const root = el('div', { class: 'clocks', role: 'timer', 'aria-live': 'off', 'aria-label': 'Game clock', hidden: true }, white.box, black.box);

  function paintSide(side, ms, isTurn, isFlagged) {
    const text = fmtClock(ms);
    if (side.state.text !== text) { side.state.text = text; side.time.nodeValue = text; }
    const low = !isFlagged && Number.isFinite(ms) && ms <= LOW_MS;
    if (side.state.low !== low) { side.state.low = low; side.box.classList.toggle('low', low); }
    if (side.state.active !== isTurn) { side.state.active = isTurn; side.box.classList.toggle('active', isTurn); }
    if (side.state.flagged !== isFlagged) {
      side.state.flagged = isFlagged;
      side.box.classList.toggle('flagged', isFlagged);
      side.flag.nodeValue = isFlagged ? 'flag' : '';
    }
  }

  function paint(c) {
    paintSide(white, c.white, c.turn === 'white', c.flagged === 'white');
    paintSide(black, c.black, c.turn === 'black', c.flagged === 'black');
  }

  /** Cheap path: text nodes + low/active/flag classes only. Safe at 5 Hz. */
  function tick(payload) {
    paint(payload && typeof payload === 'object' && Number.isFinite(payload.white) ? payload : readClock(store));
  }

  let lastVisible = null;
  let lastRunning = null;
  /** Structural path: visibility and the paused marker, plus everything the tick path does. */
  function update() {
    const c = readClock(store);
    // A time control being *configured* is not a game being played. The board is an analysis tool
    // most of the time, so the clock stays out of the way until a timed game is actually under way
    // (self-play running, the clock started, or a side already flagged).
    const sp = store.state && store.state.selfPlay;
    const inPlay = !!(c.running || c.turn || c.flagged || (sp && sp.on));
    const visible = Number.isFinite(c.initial) && c.initial > 0 && inPlay;
    if (lastVisible !== visible) { lastVisible = visible; root.hidden = !visible; }
    if (!visible) return;
    const running = !!c.running;
    if (lastRunning !== running) { lastRunning = running; root.classList.toggle('paused', !running && !c.flagged); }
    paint(c);
  }

  const unsubs = [];
  const sub = (evt, fn) => {
    if (!store || typeof store.on !== 'function') return;
    const off = store.on(evt, fn);
    unsubs.push(typeof off === 'function' ? off : () => store.off(evt, fn));
  };
  sub('clock:tick', tick);
  sub('clock:change', update);

  update();

  return {
    el: root, update, tick,
    dispose() {
      for (const u of unsubs) { try { u(); } catch { /* ignore */ } }
      unsubs.length = 0;
      root.remove();
    },
  };
}
