import { el, button, field, toggleRow, segmented } from './layout.js';
import { fmtTimeControl } from './clock.js';
import { normalizeAiStyle } from '../core/store.js';

export const OPPONENTS = [
  { value: 'self', label: 'Yourself', title: 'Play both sides by hand; the board turns after each move' },
  { value: 'engine', label: 'Stockfish', title: 'The built-in engine answers for the other side' },
  { value: 'ai', label: 'AI over MCP', title: 'An AI answers through the optional local MCP bridge' },
];

/** The page owns the AI seat's style; the agent reads it and obeys. */
export const AI_STYLES = [
  { value: 'silent', label: 'Silent', title: 'Plays the move and nothing else' },
  { value: 'annotate', label: 'Annotate', title: 'Plays the move and leaves a note and arrows explaining it' },
  { value: 'coach', label: 'Coach', title: 'Annotates, and calls out your mistakes as they happen' },
];

/** Times in ms; `custom` is handled separately. */
export const TIME_PRESETS = [
  { id: 'untimed', label: 'Untimed', initial: 0, increment: 0 },
  { id: '1+0', label: '1+0', initial: 60000, increment: 0 },
  { id: '3+2', label: '3+2', initial: 180000, increment: 2000 },
  { id: '5+0', label: '5+0', initial: 300000, increment: 0 },
  { id: '10+0', label: '10+0', initial: 600000, increment: 0 },
  { id: '15+10', label: '15+10', initial: 900000, increment: 10000 },
];

const DEF_SELFPLAY = { rotate: true, autoFlip: true, opponent: 'self', aiStyle: 'annotate', timeControl: { initial: 300000, increment: 0 } };

/** settings.selfPlay with the defaults filled in. */
export function readSelfPlaySettings(store) {
  const s = (store && store.state && store.state.settings && store.state.settings.selfPlay) || {};
  const tc = s.timeControl || DEF_SELFPLAY.timeControl;

  return {
    rotate: s.rotate === undefined ? DEF_SELFPLAY.rotate : !!s.rotate,
    autoFlip: s.autoFlip === undefined ? DEF_SELFPLAY.autoFlip : !!s.autoFlip,
    opponent: OPPONENTS.some(o => o.value === s.opponent) ? s.opponent : DEF_SELFPLAY.opponent,
    aiStyle: normalizeAiStyle(s.aiStyle),
    timeControl: {
      initial: Number.isFinite(tc.initial) ? tc.initial : DEF_SELFPLAY.timeControl.initial,
      increment: Number.isFinite(tc.increment) ? tc.increment : 0,
    },
  };
}

/** state.selfPlay with defaults. */
export function readSelfPlay(store) {
  const sp = (store && store.state && store.state.selfPlay) || {};
  return { on: !!sp.on, opponent: sp.opponent || readSelfPlaySettings(store).opponent, awaiting: sp.awaiting || null };
}

/** The preset id matching {initial, increment}, or 'custom'. */
export function presetIdFor(tc) {
  const hit = TIME_PRESETS.find(p => p.initial === tc.initial && p.increment === tc.increment);
  return hit ? hit.id : 'custom';
}

/** Returns { el, update, dispose }. */
export function createSelfPlayPanel({ store, actions }) {
  const can = name => !!(actions && typeof actions[name] === 'function');
  const warned = new Set();

  function call(name, ...args) {
    if (can(name)) return actions[name](...args);

    if (!warned.has(name)) {
      warned.add(name);
      console.warn(`[ui] actions.${name} is not available yet`);
    }

    return undefined;
  }

  const oppSeg = segmented(OPPONENTS.map(o => ({ value: o.value, label: o.label, title: o.title })), readSelfPlay(store).opponent, v => {
    if (can('setSelfPlayOpponent')) actions.setSelfPlayOpponent(v);
    else actions.setSetting('selfPlay.opponent', v);
  });

  // Shown only for the AI opponent.
  const styleSeg = segmented(AI_STYLES.map(o => ({ value: o.value, label: o.label, title: o.title })), readSelfPlaySettings(store).aiStyle, v => {
    actions.setSetting('selfPlay.aiStyle', v);
  });
  const styleField = el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'Style' }), styleSeg);

  let customOpen = false;
  const presetRow = el('div', { class: 'row wrap tc-row' });
  const presetBtns = new Map();

  for (const p of TIME_PRESETS) {
    const b = button(p.label, () => {
      customOpen = false;
      applyTimeControl(p.initial, p.increment);
    }, { small: true, title: p.id === 'untimed' ? 'No clock' : `${p.label} (minutes + increment)` });

    presetBtns.set(p.id, b);
    presetRow.appendChild(b);
  }

  const customBtn = button('Custom', () => {
    customOpen = !customOpen;
    update();
    if (customOpen) customMin.focus();
  }, { small: true, title: 'Set your own minutes and increment' });

  presetBtns.set('custom', customBtn);
  presetRow.appendChild(customBtn);

  const numInput = (title, min, max, step) => el('input', {
    type: 'number', class: 'inp mono', min, max, step, title,
    onchange: () => applyCustom(),
  });

  const customMin = numInput('Initial time in minutes', 0, 180, 1);
  const customInc = numInput('Increment in seconds', 0, 180, 1);
  const customBox = el('div', { class: 'grid2 tc-custom', hidden: true }, field('Minutes', customMin), field('Increment s', customInc));

  function applyCustom() {
    const mins = Math.max(0, Math.min(180, Number(customMin.value) || 0));
    const inc = Math.max(0, Math.min(180, Number(customInc.value) || 0));
    applyTimeControl(Math.round(mins * 60000), Math.round(inc * 1000));
  }

  function applyTimeControl(initial, increment) {
    const clock = (store.state && store.state.clock) || {};

    if (clock.running) {
      actions.toast('Stop the clock before changing the time control', 'error');
      update();
      return;
    }

    if (can('setTimeControl')) actions.setTimeControl({ initial, increment });
    actions.setSetting('selfPlay.timeControl', { initial, increment });
    update();
  }

  const rotateSw = toggleRow('Rotate the board', true, v => actions.setSetting('selfPlay.rotate', v), 'Turn the board to the other seat as an animation instead of flipping instantly');
  const autoFlipSw = toggleRow('Change seats after each move', true, v => actions.setSetting('selfPlay.autoFlip', v), 'Off keeps you on one side of the board');

  const startBtn = button('Start self-play', () => {
    const sp = readSelfPlay(store);
    if (sp.on) {
      call('stopSelfPlay');
      return;
    }

    const cfg = readSelfPlaySettings(store);
    call('startSelfPlay', { opponent: cfg.opponent, timeControl: cfg.timeControl });
  }, { primary: true, title: 'Start a self-play game with the settings below' });

  const pauseBtn = button('Pause', () => {
    const clock = (store.state && store.state.clock) || {};
    if (clock.running) call('clockPause');
    else call('clockResume');
  }, { small: true, title: 'Pause or resume the clock' });

  const resetBtn = button('Reset clock', () => call('clockReset'), { small: true, title: 'Put both clocks back to the initial time' });
  const transport = el('div', { class: 'row wrap' }, pauseBtn, resetBtn);

  const statusText = document.createTextNode('');
  const status = el('div', { class: 'hint sp-status' }, statusText);

  const root = el('div', { class: 'sec sp' },
    el('div', { class: 'sec-h', text: 'Self-play' }),
    el('div', { class: 'row' }, startBtn, el('span', { class: 'spacer' })),
    status,
    el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'Opponent' }), oppSeg),
    styleField,
    el('div', { class: 'field' }, el('span', { class: 'lbl', text: 'Time control' }), presetRow, customBox),
    transport,
    rotateSw, autoFlipSw,
  );

  let lastOn = null;

  function update() {
    const cfg = readSelfPlaySettings(store);
    const sp = readSelfPlay(store);
    const clock = (store.state && store.state.clock) || {};

    oppSeg.set(sp.opponent || cfg.opponent);
    styleSeg.set(cfg.aiStyle);
    styleField.hidden = (sp.opponent || cfg.opponent) !== 'ai';

    const pid = presetIdFor(cfg.timeControl);
    for (const [id, b] of presetBtns) b.setAttribute('aria-pressed', String(id === pid || (id === 'custom' && customOpen)));

    const showCustom = customOpen || pid === 'custom';
    customBox.hidden = !showCustom;
    if (document.activeElement !== customMin) customMin.value = String(Math.round((cfg.timeControl.initial / 60000) * 100) / 100);
    if (document.activeElement !== customInc) customInc.value = String(Math.round(cfg.timeControl.increment / 1000));

    rotateSw.input.checked = cfg.rotate;
    autoFlipSw.input.checked = cfg.autoFlip;

    if (lastOn !== sp.on) {
      lastOn = sp.on;
      startBtn.textContent = sp.on ? 'Stop self-play' : 'Start self-play';
      startBtn.classList.toggle('danger', sp.on);
      startBtn.classList.toggle('primary', !sp.on);
    }

    const timed = Number.isFinite(clock.initial) ? clock.initial > 0 : cfg.timeControl.initial > 0;
    transport.hidden = !timed || !sp.on;
    pauseBtn.textContent = clock.running ? 'Pause' : 'Resume';
    pauseBtn.disabled = !timed || !!clock.flagged;
    resetBtn.disabled = !timed;

    const opp = OPPONENTS.find(o => o.value === (sp.opponent || cfg.opponent));
    const style = (sp.opponent || cfg.opponent) === 'ai' ? ` (${cfg.aiStyle})` : '';

    let text;
    if (clock.flagged) text = `${clock.flagged === 'white' ? 'White' : 'Black'} ran out of time.`;
    else if (!sp.on) text = `Off — ${opp ? opp.label : 'Yourself'}${style}, ${fmtTimeControl(cfg.timeControl)}.`;
    else if (sp.awaiting) text = `Waiting for ${opp ? opp.label : 'the opponent'} to move for ${sp.awaiting === 'white' ? 'White' : 'Black'}…`;
    else text = `Running — ${opp ? opp.label : 'Yourself'}${style}, ${fmtTimeControl(cfg.timeControl)}.`;

    if (statusText.nodeValue !== text) statusText.nodeValue = text;
  }

  update();

  return { el: root, update, dispose() { root.remove(); } };
}
