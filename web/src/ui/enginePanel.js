// ui/enginePanel.js — the Engine tab: the Self-play block (addendum v1 — mounted here rather than as
// a seventh tab, because core's PANELS set is closed), then enable switch, auto-analyse,
// MultiPV / depth / movetime, lines table (click a move to play the line up to it), "Engine plays"
// selector, skill + Elo, thinking indicator with depth / nodes / nps. Reads state.engine +
// state.settings.engine; writes through actions.setSetting and engine.setPlayAs.

import { el, button, field, toggleRow, fmtEval } from './layout.js';
import { createSelfPlayPanel } from './selfPlayPanel.js';

function fmtNodes(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

/** Mount the engine panel. Returns { el, update, dispose }. */
export function createEnginePanel({ store, actions, engine }) {
  const st = () => store.state.settings.engine;

  const numInput = (path, { min, max, step = 1, title, blankNull = false }) => {
    const inp = el('input', {
      type: 'number', class: 'inp mono', min, max, step, title,
      onchange: e => {
        const raw = e.target.value.trim();
        if (blankNull && raw === '') { actions.setSetting(path, null); return; }
        let v = Number(raw);
        if (!Number.isFinite(v)) { e.target.value = String(st()[path.split('.').pop()] ?? ''); return; }
        if (min != null) v = Math.max(min, v);
        if (max != null) v = Math.min(max, v);
        v = Math.round(v);
        e.target.value = String(v);
        actions.setSetting(path, v);
      },
    });
    return inp;
  };

  const enable = toggleRow('Engine on', st().enabled, v => actions.setSetting('engine.enabled', v), 'Run Stockfish on the current position (E)');
  const auto = toggleRow('Auto-analyse after each move', st().autoAnalyse, v => actions.setSetting('engine.autoAnalyse', v), 'Re-analyse whenever the position changes');

  const multipv = numInput('engine.multipv', { min: 1, max: 5, title: 'Number of lines (MultiPV)' });
  const depth = numInput('engine.depth', { min: 0, max: 40, title: 'Search depth (0 = use movetime)' });
  const movetime = numInput('engine.movetime', { min: 0, max: 600000, step: 100, title: 'Time per search in ms (used when depth is 0, and for engine play)' });

  const playAs = el('select', {
    class: 'inp', title: 'Let the engine play one side in Play mode',
    onchange: e => {
      const v = e.target.value || null;
      if (engine && engine.setPlayAs) engine.setPlayAs(v);
      else if (actions.engineSetPlayAs) actions.engineSetPlayAs(v);
    },
  },
    el('option', { value: '', text: 'Off' }),
    el('option', { value: 'white', text: 'White' }),
    el('option', { value: 'black', text: 'Black' }),
  );

  const skillVal = el('span', { class: 'mono', text: String(st().skill) });
  const skill = el('input', {
    type: 'range', min: 0, max: 20, step: 1, value: st().skill, title: 'Stockfish Skill Level 0–20',
    oninput: e => { skillVal.textContent = e.target.value; },
    onchange: e => actions.setSetting('engine.skill', Number(e.target.value)),
  });
  const elo = numInput('engine.elo', { min: 1320, max: 3190, step: 10, title: 'UCI_Elo (blank = full strength)', blankNull: true });
  elo.placeholder = 'full';

  const thinkDot = el('span', { class: 'dot' });
  const thinkText = el('span', { text: 'off' });
  const statDepth = el('b', { text: '0' });
  const statNodes = el('b', { text: '0' });
  const statNps = el('b', { text: '0' });
  const statScore = el('b', { text: '' });
  const stat = el('div', { class: 'stat' },
    el('span', { class: 'thinking-ind' }, thinkDot, thinkText),
    el('span', {}, 'eval ', statScore),
    el('span', {}, 'depth ', statDepth),
    el('span', {}, 'nodes ', statNodes),
    el('span', {}, 'nps ', statNps),
  );

  const linesBody = el('tbody');
  const linesTable = el('table', { class: 'lines' }, linesBody);
  const linesEmpty = el('div', { class: 'hint', text: '' });

  const selfPlay = createSelfPlayPanel({ store, actions });

  const root = el('div', {},
    selfPlay.el,
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Analysis' }), enable, auto, stat),
    el('div', { class: 'sec' },
      el('div', { class: 'sec-h', text: 'Lines' }),
      linesEmpty, linesTable,
    ),
    el('div', { class: 'sec' },
      el('div', { class: 'sec-h', text: 'Search' }),
      el('div', { class: 'grid3' },
        field('Lines', multipv), field('Depth', depth), field('Time ms', movetime),
      ),
    ),
    el('div', { class: 'sec' },
      el('div', { class: 'sec-h', text: 'Engine plays' }),
      el('div', { class: 'grid2' },
        field('Side', playAs),
        field('Elo', elo),
      ),
      el('div', { class: 'field' },
        el('span', { class: 'lbl' }, 'Skill ', skillVal),
        skill,
      ),
    ),
  );

  function playLineUpTo(sanList, k) {
    for (let i = 0; i <= k; i++) {
      const n = actions.playSan(sanList[i]);
      if (!n) { actions.toast(`Could not play ${sanList[i]}`, 'error'); break; }
    }
  }

  // Signature of everything renderLines actually draws. The engine pushes a snapshot every 60 ms with
  // fresh nodes/nps but usually identical lines; rebuilding then would swap the <span class=mv> out
  // from under the pointer between pointerdown and pointerup, eating the click.
  function linesKey(s, eng, lines) {
    if (!s.settings.engine.enabled) return 'off';
    if (s.mode === 'setup') return 'setup';
    if (!lines.length) return 'empty:' + (eng.available === false ? 'na' : eng.thinking ? 'think' : 'none');
    let fen = '';
    try { fen = s.game.fen(); } catch { fen = ''; }
    return fen + '|' + lines.map(l => `${l.multipv}:${l.depth}:${JSON.stringify(l.score || null)}:${(l.pv || []).join(',')}:${(l.san || []).join(',')}`).join('|');
  }
  let renderedKey = null;

  function renderLines() {
    const s = store.state;
    const eng = s.engine || {};
    const lines = Array.isArray(eng.lines) ? eng.lines : [];
    const key = linesKey(s, eng, lines);
    if (key === renderedKey) return;
    renderedKey = key;
    linesBody.textContent = '';
    if (!s.settings.engine.enabled) { linesEmpty.textContent = 'Engine is off.'; linesTable.hidden = true; return; }
    if (s.mode === 'setup') { linesEmpty.textContent = 'Analysis pauses in Setup mode.'; linesTable.hidden = true; return; }
    if (!lines.length) { linesEmpty.textContent = eng.available === false ? 'Stockfish is not available.' : (eng.thinking ? 'Thinking…' : 'No lines yet.'); linesTable.hidden = true; return; }
    linesEmpty.textContent = '';
    linesTable.hidden = false;
    const g = s.game;
    const fen = g.fen();
    const parts = fen.split(' ');
    const turnWhite = (parts[1] || 'w') === 'w';
    const full = parseInt(parts[5], 10) || 1;
    for (const line of lines) {
      const san = line.san && line.san.length ? line.san : (typeof g.pvToSan === 'function' ? g.pvToSan(line.pv || []) : []);
      const ev = el('td', { class: 'ev ' + (scoreSign(line.score) >= 0 ? 'w' : 'b'), text: fmtEval(line.score) || '—' });
      const d = el('td', { class: 'd', text: `d${line.depth || 0}` });
      const pv = el('td', { class: 'pv' });
      san.forEach((m, i) => {
        const white = turnWhite ? i % 2 === 0 : i % 2 === 1;
        const number = full + Math.floor((turnWhite ? i : i + 1) / 2);
        if (white) pv.appendChild(el('span', { class: 'num', text: `${number}. ` }));
        else if (i === 0) pv.appendChild(el('span', { class: 'num', text: `${number}... ` }));
        pv.appendChild(el('span', {
          class: 'mv', text: m, title: `Play the line up to ${m}`,
          onclick: () => playLineUpTo(san, i),
        }));
        pv.appendChild(document.createTextNode(' '));
      });
      linesBody.appendChild(el('tr', { title: (line.pv || []).join(' ') }, ev, d, pv));
    }
  }

  function scoreSign(score) {
    if (!score) return 0;
    if (score.mate === 0 && score.mated) return score.mated === 'white' ? -1 : 1;   // the mated side is losing
    if (score.mate != null) return score.mate >= 0 ? 1 : -1;
    return (score.cp || 0) >= 0 ? 1 : -1;
  }

  const syncIfIdle = (inp, v) => { if (document.activeElement !== inp) inp.value = v == null ? '' : String(v); };

  function update() {
    const s = store.state;
    const cfg = s.settings.engine;
    const eng = s.engine || {};
    selfPlay.update();
    enable.input.checked = !!cfg.enabled;
    auto.input.checked = !!cfg.autoAnalyse;
    syncIfIdle(multipv, cfg.multipv);
    syncIfIdle(depth, cfg.depth);
    syncIfIdle(movetime, cfg.movetime);
    syncIfIdle(elo, cfg.elo);
    if (document.activeElement !== skill) { skill.value = String(cfg.skill ?? 20); skillVal.textContent = String(cfg.skill ?? 20); }
    playAs.value = eng.playAs || '';

    const on = !!cfg.enabled;
    thinkDot.className = 'dot' + (on && eng.thinking ? ' on' : '');
    thinkText.textContent = !on ? 'off' : eng.available === false ? 'unavailable' : eng.thinking ? 'thinking' : 'idle';
    statDepth.textContent = String(eng.depth || 0);
    statNodes.textContent = fmtNodes(eng.nodes || 0);
    statNps.textContent = fmtNodes(eng.nps || 0);
    statScore.textContent = eng.score ? fmtEval(eng.score) : '—';
    renderLines();
  }

  return { el: root, update, selfPlay, dispose() { selfPlay.dispose(); root.remove(); } };
}
