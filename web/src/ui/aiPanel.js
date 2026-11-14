// ui/aiPanel.js — the AI tab: provider select (Packet / Local llama.cpp / Anthropic), provider fields
// (local URL + model; Anthropic key with Save/Clear via ai.setKey/clearKey, model id), include-engine /
// include-legal-moves checkboxes, collapsible packet preview with Copy, chat log (fenced code as
// <pre>, "Play suggested" buttons), question box + Ask, Paste-reply + Apply (packet provider),
// "Let it move" (plays the first suggested move of the last assistant reply), Clear chat, inline error.
// Imports buildPacket from ../ai/packet.js for the preview (pure function). Nothing else beyond the contract.

import { el, button, field, toggleRow, copyText } from './layout.js';
import { buildPacket } from '../ai/packet.js';

const PROVIDERS = [
  { id: 'packet', label: 'Packet (copy / paste)' },
  { id: 'local', label: 'Local llama.cpp' },
  { id: 'anthropic', label: 'Anthropic API' },
];

function fmtTime(at) {
  if (!at) return '';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Split text on ``` fences into [{code:boolean, text, lang}]. */
function segments(text) {
  const out = [];
  const re = /```([\w-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, lang: m[1] || '', text: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

/** Mount the AI panel. Returns { el, update, dispose }. */
export function createAiPanel({ store, actions, ai, dialogs }) {
  const sAi = () => store.state.settings.ai || {};
  const provider = () => (store.state.ai && store.state.ai.provider) || sAi().provider || 'packet';

  const providerSel = el('select', { class: 'inp', title: 'Where questions go', onchange: e => setProvider(e.target.value) },
    ...PROVIDERS.map(p => el('option', { value: p.id, text: p.label })));

  function setProvider(id) {
    // ai.setProvider persists through actions.setSetting('ai.provider') itself; only fall back when no ai object.
    if (ai && ai.setProvider) ai.setProvider(id);
    else actions.setSetting('ai.provider', id);
  }

  // local fields
  const localUrl = el('input', { type: 'text', class: 'inp mono', placeholder: 'http://127.0.0.1:8080/v1', title: 'OpenAI-compatible base URL', onchange: e => actions.setSetting('ai.localUrl', e.target.value.trim()) });
  const localModel = el('input', { type: 'text', class: 'inp mono', placeholder: '(server default)', title: 'Model name sent to the local server', onchange: e => actions.setSetting('ai.localModel', e.target.value.trim()) });
  const localBox = el('div', { class: 'grid2' }, field('Local URL', localUrl), field('Model', localModel));

  // anthropic fields
  const keyInput = el('input', { type: 'password', class: 'inp mono', placeholder: 'sk-ant-…', autocomplete: 'off', title: 'Stored only in this browser (localStorage), never exported' });
  const keyState = el('span', { class: 'key-state', text: '' });
  const keySave = button('Save', () => {
    const v = keyInput.value.trim();
    if (!v) { actions.toast('Paste a key first', 'error'); return; }
    if (ai && ai.setKey) ai.setKey(v);
    keyInput.value = '';
    actions.toast('API key saved in this browser', 'ok');
    update();
  }, { small: true, title: 'Save the key to localStorage' });
  const keyClear = button('Clear', () => { if (ai && ai.clearKey) ai.clearKey(); actions.toast('API key removed', 'info'); update(); }, { small: true, title: 'Forget the saved key' });
  const anthModel = el('input', { type: 'text', class: 'inp mono', placeholder: 'claude-sonnet-5', title: 'Model id', onchange: e => actions.setSetting('ai.anthropicModel', e.target.value.trim()) });
  const anthBox = el('div', {},
    el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'API key ', keyState), el('div', { class: 'row' }, keyInput, keySave, keyClear)),
    field('Model', anthModel),
  );

  const incEngine = toggleRow('Include engine lines', sAi().includeEngine, v => actions.setSetting('ai.includeEngine', v), 'Add Stockfish lines to the packet');
  const incLegal = toggleRow('Include legal moves', sAi().includeLegalMoves, v => actions.setSetting('ai.includeLegalMoves', v), 'List every legal move in the packet');

  // packet preview
  const packetPre = el('pre', { class: 'packet', text: '' });
  const packetDetails = el('details', { class: 'fold', ontoggle: () => { if (packetDetails.open) refreshPacket(); } },
    el('summary', {}, el('span', { class: 'lbl', style: { margin: 0 }, text: 'Packet preview' })),
    packetPre,
  );
  function packetText() {
    try { return buildPacket(store.state, { includeEngine: !!sAi().includeEngine, includeLegalMoves: !!sAi().includeLegalMoves }) || ''; }
    catch (e) { return `(packet unavailable: ${e && e.message ? e.message : e})`; }
  }
  function refreshPacket() { packetPre.textContent = packetText(); }
  // In packet mode the typed question rides along with the copied packet.
  function packetWithQuestion() {
    const q = question.value.trim();
    return packetText() + (q && provider() === 'packet' ? `\n\nquestion: ${q}\n` : '');
  }
  const copyPacket = button('Copy packet', async () => {
    const ok = await copyText(packetWithQuestion());
    actions.toast(ok ? 'Packet copied' : 'Copy failed', ok ? 'ok' : 'error');
  }, { small: true, icon: 'copy', title: 'Copy the position packet (plus your question) for an AI' });

  // chat
  const chat = el('div', { class: 'chat', 'aria-live': 'polite' });
  const errorEl = el('div', { class: 'error' });

  function lastSuggested() {
    const msgs = (store.state.ai && store.state.ai.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'assistant' && Array.isArray(m.suggestedMoves) && m.suggestedMoves.length) return m.suggestedMoves;
    }
    return null;
  }
  const letMove = button('Let it move', () => {
    const sug = lastSuggested();
    if (!sug) { actions.toast('No suggested move in the last reply', 'info'); return; }
    if (!actions.playSan(sug[0])) actions.toast(`${sug[0]} is not legal here`, 'error');
  }, { small: true, title: 'Play the first move the AI suggested' });
  const clearChat = button('Clear', () => actions.aiClear(), { small: true, title: 'Clear the chat log' });

  const question = el('textarea', { class: 'inp', rows: 3, placeholder: 'Ask about the position… (Ctrl+Enter to send)', onkeydown: e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ask(); } } });
  const askBtn = button('Ask', () => ask(), { primary: true, title: 'Send the packet + your question to the provider' });

  const msgCount = () => ((store.state.ai && store.state.ai.messages) || []).length;

  async function ask() {
    const q = question.value.trim();
    if (!q) { question.focus(); return; }
    if (!ai || !ai.ask) { actions.toast('AI module not loaded', 'error'); return; }
    const before = msgCount();
    question.value = '';
    try { await ai.ask(q); }
    catch (e) { const msg = e && e.message ? e.message : String(e); if (actions.aiError) actions.aiError(msg); else actions.toast(msg, 'error'); }
    finally {
      // chat.js can bail (missing key, packet error, already busy) without logging the user turn —
      // give the typed question back instead of losing it.
      if (msgCount() <= before && !question.value.trim()) { question.value = q; question.focus(); question.select(); }
    }
  }

  const reply = el('textarea', { class: 'inp mono', rows: 4, placeholder: 'Paste the AI reply here (a ```chess JSON block is applied to the board)' });
  const applyBtn = button('Apply reply', () => {
    const t = reply.value.trim();
    if (!t) { reply.focus(); return; }
    if (!ai || !ai.applyReply) { actions.toast('AI module not loaded', 'error'); return; }
    try { ai.applyReply(t); reply.value = ''; }
    catch (e) { actions.toast(e && e.message ? e.message : String(e), 'error'); }
  }, { title: 'Show the reply in the log and apply any ```chess block' });
  const pasteBox = el('div', { class: 'sec' }, el('div', { class: 'sec-h', text: 'Paste reply' }), reply, el('div', { class: 'row', style: { marginTop: '6px' } }, el('span', { class: 'spacer' }), applyBtn));

  const root = el('div', {},
    el('div', { class: 'sec' },
      field('Provider', providerSel),
      localBox, anthBox,
      incEngine, incLegal,
    ),
    el('div', { class: 'sec' },
      el('div', { class: 'row' }, packetDetails, el('span', { class: 'spacer' }), copyPacket),
    ),
    el('div', { class: 'sec' },
      el('div', { class: 'sec-h' }, el('span', { text: 'Chat' }), el('span', { class: 'acts' }, letMove, clearChat)),
      chat, errorEl,
    ),
    el('div', { class: 'sec' },
      question,
      el('div', { class: 'row', style: { marginTop: '6px' } }, el('span', { class: 'spacer' }), askBtn),
    ),
    pasteBox,
  );

  function renderMessage(m) {
    const b = el('div', { class: 'bubble ' + (m.role || 'assistant') });
    const text = String(m.text || '');
    if (m.role === 'assistant') {
      for (const seg of segments(text)) {
        if (seg.code) b.appendChild(el('pre', { title: seg.lang ? `\`\`\`${seg.lang}` : null }, el('code', { text: seg.text })));
        else b.appendChild(document.createTextNode(seg.text));
      }
      if (Array.isArray(m.suggestedMoves) && m.suggestedMoves.length) {
        const acts = el('div', { class: 'acts' });
        for (const san of m.suggestedMoves.slice(0, 6)) {
          acts.appendChild(button(`Play suggested: ${san}`, () => { if (!actions.playSan(san)) actions.toast(`${san} is not legal here`, 'error'); }, { small: true }));
        }
        b.appendChild(acts);
      }
    } else {
      b.appendChild(document.createTextNode(text));
    }
    const t = fmtTime(m.at);
    if (t) b.appendChild(el('time', { text: t }));
    return b;
  }

  let renderedCount = -1, renderedKey = '';
  function renderChat() {
    const msgs = (store.state.ai && store.state.ai.messages) || [];
    const key = msgs.length + ':' + (msgs.length ? String(msgs[msgs.length - 1].text || '').length : 0);
    if (msgs.length === renderedCount && key === renderedKey) return;
    renderedCount = msgs.length; renderedKey = key;
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.textContent = '';
    for (const m of msgs) chat.appendChild(renderMessage(m));
    if (nearBottom || msgs.length <= 2) chat.scrollTop = chat.scrollHeight;
  }

  const syncIfIdle = (inp, v) => { if (document.activeElement !== inp) inp.value = v == null ? '' : String(v); };

  function update() {
    const s = store.state;
    const cfg = sAi();
    const p = provider();
    providerSel.value = p;
    localBox.hidden = p !== 'local';
    anthBox.hidden = p !== 'anthropic';
    pasteBox.hidden = p !== 'packet';
    question.placeholder = p === 'packet' ? 'Your question — it rides along when you copy the packet (Ctrl+Enter = Ask)' : 'Ask about the position… (Ctrl+Enter to send)';
    syncIfIdle(localUrl, cfg.localUrl);
    syncIfIdle(localModel, cfg.localModel);
    syncIfIdle(anthModel, cfg.anthropicModel);
    incEngine.input.checked = !!cfg.includeEngine;
    incLegal.input.checked = !!cfg.includeLegalMoves;
    let hasKey = false;
    try { hasKey = !!(ai && ai.getKey && ai.getKey()); } catch { hasKey = false; }
    keyState.textContent = hasKey ? '— saved' : '— none';
    keyState.className = 'key-state' + (hasKey ? ' on' : '');
    keyClear.disabled = !hasKey;
    const busy = !!(s.ai && s.ai.busy);
    askBtn.disabled = busy;
    askBtn.textContent = busy ? 'Thinking…' : 'Ask';
    letMove.disabled = !lastSuggested();
    errorEl.textContent = (s.ai && s.ai.lastError) ? String(s.ai.lastError) : '';
    if (packetDetails.open) refreshPacket();
    renderChat();
  }

  return { el: root, update, refreshPacket, dispose() { root.remove(); } };
}
