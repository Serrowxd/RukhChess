// ui/notesPanel.js — the Notes tab: study title, study notes, the current move's note (debounced
// 200 ms, re-bound on game:change), NAG picker, annotation counts + "clear arrows/highlights".
// Nothing beyond the contract.

import { el, button, field, debounce, moveLabel } from './layout.js';

const NAGS = ['!!', '!', '!?', '?!', '?', '??'];

/** Mount the notes panel. Returns { el, update, dispose }. */
export function createNotesPanel({ store, actions }) {
  const title = el('input', { type: 'text', class: 'inp', placeholder: 'Untitled study', title: 'Study title (goes into the YAML and PGN headers)' });
  const studyNotes = el('textarea', { class: 'inp', rows: 4, placeholder: 'Study-level notes: the plan, what you are testing, what the AI said…' });
  const moveLbl = el('span', { class: 'sec-h', text: 'Note on this move' });
  const note = el('textarea', { class: 'inp', rows: 4, placeholder: 'Why this move? Shown as a card in 3D and in the AI packet.' });
  const annCount = el('span', { class: 'ann-count', text: '' });

  const saveTitle = debounce(v => actions.setStudyTitle(v), 200);
  const saveStudy = debounce(v => actions.setStudyNotes(v), 200);
  let boundId = null;
  let pending = null;   // { id, text } while a note save is queued — the id is the node it was typed for

  // Write a note to a node that may no longer be current (the engine/API can move under the typing):
  // the same goto → setNote → goto dance ai/api.js noteAt uses, since core has no node-addressed action.
  function writeNoteTo(nodeId, text) {
    const g = store.state.game;
    const target = nodeId && g.node ? g.node(nodeId) : null;
    if (!target) { actions.toast('Position changed while typing — note not saved', 'error'); return; }
    const cur = g.current;
    if (cur.id === target.id) { actions.setNote(text); return; }
    actions.goto(target.id);
    try { actions.setNote(text); } finally { actions.goto(cur.id); }
  }

  const saveNote = debounce(() => {
    const p = pending;
    pending = null;
    if (p) writeNoteTo(p.id, p.text);
  }, 200);
  const queueNote = v => { pending = { id: boundId || store.state.game.current.id, text: v }; saveNote(); };

  title.addEventListener('input', e => saveTitle(e.target.value));
  title.addEventListener('blur', () => saveTitle.flush());
  studyNotes.addEventListener('input', e => saveStudy(e.target.value));
  studyNotes.addEventListener('blur', () => saveStudy.flush());
  note.addEventListener('input', e => queueNote(e.target.value));
  note.addEventListener('blur', () => saveNote.flush());

  const nagButtons = new Map();
  const nagPick = el('div', { class: 'nag-pick' });
  for (const n of NAGS) {
    const b = button(n, () => actions.setNag(store.state.game.current.nag === n ? '' : n), { title: nagTitle(n) });
    nagButtons.set(n, b);
    nagPick.appendChild(b);
  }
  nagPick.appendChild(button('clear', () => actions.setNag(''), { small: true, title: 'Remove the glyph' }));

  const clearAnn = button('Clear arrows & highlights', () => actions.clearAnnotations({ arrows: true, highlights: true }), { small: true, title: 'Remove every arrow and highlight on this position' });

  const root = el('div', {},
    el('div', { class: 'sec' }, field('Study', title), studyNotes),
    el('div', { class: 'sec' }, moveLbl, note),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Glyph' }), nagPick),
    el('div', { class: 'sec' }, el('div', { class: 'sec-h' }, el('span', { text: 'Drawings' }), annCount), clearAnn),
  );

  function nagTitle(n) {
    return { '!!': 'Brilliant', '!': 'Good', '!?': 'Interesting', '?!': 'Dubious', '?': 'Mistake', '??': 'Blunder' }[n] || n;
  }

  const syncIfIdle = (inp, v) => { if (document.activeElement !== inp) inp.value = v == null ? '' : String(v); };

  function update() {
    const s = store.state;
    const g = s.game;
    const cur = g.current;
    syncIfIdle(title, s.study && s.study.title);
    syncIfIdle(studyNotes, s.study && s.study.notes);
    if (cur.id !== boundId) {
      saveNote.flush();     // deliver whatever was typed to the node it was typed for, then rebind
      boundId = cur.id;
      note.value = cur.note || '';
    } else {
      syncIfIdle(note, cur.note);
    }
    moveLbl.textContent = `Note on ${moveLabel(g, cur)}`;
    for (const [n, b] of nagButtons) b.setAttribute('aria-pressed', String(cur.nag === n));
    const a = (cur.arrows || []).length, h = (cur.highlights || []).length;
    annCount.textContent = a || h ? `${a} arrow${a === 1 ? '' : 's'} · ${h} highlight${h === 1 ? '' : 's'}` : 'none';
    clearAnn.disabled = !(a || h);
    const setup = s.mode === 'setup';
    note.disabled = setup; nagPick.querySelectorAll('button').forEach(b => { b.disabled = setup; });
  }

  return {
    el: root, update,
    dispose() { saveTitle.flush(); saveStudy.flush(); saveNote.flush(); root.remove(); },
  };
}
