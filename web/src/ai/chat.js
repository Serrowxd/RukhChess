import { buildPacket, isSquare } from './packet.js';
import { providers, getProvider, listProviders, readStoredKey, KEY_STORAGE, DEFAULT_ANTHROPIC_MODEL, isAbortError } from './providers.js';
import { SYSTEM_PROMPT } from './prompt.js';

export const MAX_HISTORY_TURNS = 8;
export const VALID_NAGS = ['!', '?', '!!', '??', '!?', '?!'];
export const DEFAULT_QUESTION = 'Assess this position for the side to move: what is the plan, and which candidate moves would you consider?';
const COLORS = ['green', 'red', 'blue', 'yellow'];
const FENCE = '```';
const BLOCK_RE = /```[ \t]*chess\b[ \t]*\r?\n?([\s\S]*?)```/gi;

// Any fenced block with its tag, for models that emit ```json or no tag.
const ANY_BLOCK_RE = /```[ \t]*([A-Za-z0-9_+-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
const CHESS_KEY_RE = /["“”']\s*(arrows|highlights|note|nag|moves)\s*["“”']\s*:/;

function normColor(c) {
  const s = String(c == null ? 'green' : c).toLowerCase().trim();
  return COLORS.includes(s) ? s : 'green';
}

function toList(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/** Arrow from an object, 'g1f3', 'g1->f3 red' or ['g1','f3','red']; null when unusable. */
export function normalizeArrow(a) {
  if (!a) return null;

  if (typeof a === 'string') {
    const m = /^([a-h][1-8])\s*(?:->|-|>|:)?\s*([a-h][1-8])(?:\s+([a-z]+))?$/i.exec(a.trim());
    if (!m) return null;
    return normalizeArrow({ from: m[1], to: m[2], color: m[3] });
  }

  if (Array.isArray(a)) return normalizeArrow({ from: a[0], to: a[1], color: a[2] });
  if (typeof a !== 'object') return null;

  const from = String(a.from || '').toLowerCase().trim();
  const to = String(a.to || '').toLowerCase().trim();
  if (!isSquare(from) || !isSquare(to) || from === to) return null;

  const out = { from, to, color: normColor(a.color) };
  if (a.knight === true) out.knight = true;
  return out;
}

/** Highlight from an object, 'd5', 'd5 red' or ['d5','red']; null when unusable. */
export function normalizeHighlight(h) {
  if (!h) return null;

  if (typeof h === 'string') {
    const m = /^([a-h][1-8])(?:\s+([a-z]+))?$/i.exec(h.trim());
    if (!m) return null;
    return { square: m[1].toLowerCase(), color: normColor(m[2]) };
  }

  if (Array.isArray(h)) return normalizeHighlight({ square: h[0], color: h[1] });
  if (typeof h !== 'object') return null;

  const square = String(h.square || h.sq || '').toLowerCase().trim();
  if (!isSquare(square)) return null;
  return { square, color: normColor(h.color) };
}

function cleanSan(s) {
  return String(s == null ? '' : s).trim().replace(/^\d+\.(\.\.)?\s*/, '').replace(/^\.\.\.\s*/, '');
}

// Strips // and /* */ comments outside string literals; small models add them anyway.
function stripJsonComments(src) {
  let out = '';
  let i = 0;
  let quote = '';
  let esc = false;

  while (i < src.length) {
    const c = src[i];

    if (quote) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) quote = '';
      i++;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

function parseLenientJson(raw) {
  const attempts = [raw];

  const tidy = raw
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
  attempts.push(tidy);

  const uncommented = stripJsonComments(tidy);
  if (uncommented !== tidy) attempts.push(uncommented, uncommented.replace(/,\s*([}\]])/g, '$1'));

  for (const src of [raw, uncommented]) {
    const first = src.indexOf('{');
    const last = src.lastIndexOf('}');

    if (first >= 0 && last > first) {
      const inner = src.slice(first, last + 1);
      attempts.push(inner, inner.replace(/,\s*([}\]])/g, '$1'));
    }
  }

  let err = 'invalid JSON';

  for (const t of attempts) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v };
      err = 'chess block must be a JSON object';
    } catch (e) {
      err = e && e.message ? e.message : 'invalid JSON';
    }
  }

  return { error: err };
}

/** Pure: the entries of an annotation spec the board cannot use. */
export function rejectedEntries(spec) {
  const out = { arrows: [], highlights: [], nag: null, count: 0 };
  if (!spec || typeof spec !== 'object') return out;

  for (const a of toList(spec.arrows)) if (!normalizeArrow(a)) out.arrows.push(a);
  for (const h of toList(spec.highlights)) if (!normalizeHighlight(h)) out.highlights.push(h);

  if (typeof spec.nag === 'string') {
    const nag = spec.nag.trim();
    if (nag !== '' && !VALID_NAGS.includes(nag)) out.nag = spec.nag;
  }

  out.count = out.arrows.length + out.highlights.length + (out.nag == null ? 0 : 1);
  return out;
}

function normalizeBlock(obj, raw, tagged) {
  const nagText = typeof obj.nag === 'string' ? obj.nag.trim() : '';
  const movesSrc = typeof obj.moves === 'string' ? obj.moves.split(/\s+/) : toList(obj.moves);

  return {
    arrows: toList(obj.arrows).map(normalizeArrow).filter(Boolean),
    highlights: toList(obj.highlights).map(normalizeHighlight).filter(Boolean),
    note: typeof obj.note === 'string' ? obj.note.trim() : null,
    nag: VALID_NAGS.includes(nagText) ? nagText : null,
    moves: movesSrc.map(cleanSan).filter(s => s && !/^\d+\.+$/.test(s)),
    dropped: rejectedEntries(obj).count,
    tagged: tagged !== false,
    raw,
  };
}

/** The reply's drawing block with its span, so strip and extract agree. */
function findChessBlock(text) {
  const re = new RegExp(BLOCK_RE.source, 'gi');
  let last = null;
  let m;
  while ((m = re.exec(text))) last = m;
  if (last) return { raw: last[1].trim(), start: last.index, end: last.index + last[0].length, tagged: true };

  const open = text.search(/```[ \t]*chess\b/i);

  if (open >= 0) {
    const raw = text.slice(open).replace(/^```[ \t]*chess\b[ \t]*\r?\n?/i, '').trim();
    return { raw, start: open, end: text.length, tagged: true };
  }

  const any = new RegExp(ANY_BLOCK_RE.source, 'g');
  let candidate = null;

  while ((m = any.exec(text))) {
    const raw = String(m[2] || '').trim();
    if (!raw.startsWith('{') || !CHESS_KEY_RE.test(raw)) continue;
    candidate = { raw, start: m.index, end: m.index + m[0].length, tagged: false };
  }

  return candidate;
}

/** Pure: the reply's chess block, normalized; null when absent, { error, raw } when unreadable. */
export function extractChessBlock(text) {
  if (typeof text !== 'string' || !text) return null;

  const found = findChessBlock(text);
  if (!found || !found.raw) return null;

  const parsed = parseLenientJson(found.raw);
  if (parsed.error) return { error: parsed.error, raw: found.raw, tagged: found.tagged };
  return normalizeBlock(parsed.value, found.raw, found.tagged);
}

/** The reply text without its chess block, for display. */
export function stripChessBlock(text) {
  if (typeof text !== 'string' || !text) return '';

  const found = findChessBlock(text);
  if (!found) return text.trim();
  return (text.slice(0, found.start) + text.slice(found.end)).trim();
}

/** Applies { arrows, highlights, note, nag } to the current node; returns what was applied. */
export function applyAnnotation(spec, { store, actions, source = 'ai', clearEmpty = false } = {}) {
  const applied = { arrows: 0, highlights: 0, note: false, nag: false };
  if (!spec || typeof spec !== 'object' || !actions) return applied;

  const arrows = toList(spec.arrows).map(normalizeArrow).filter(Boolean);

  if (arrows.length) {
    actions.addArrows(arrows.map(a => ({ ...a, source })), source);
    applied.arrows = arrows.length;
  }

  const hl = toList(spec.highlights).map(normalizeHighlight).filter(Boolean);

  if (hl.length) {
    const node = store && store.state && store.state.game ? store.state.game.current : null;
    const existing = (node && Array.isArray(node.highlights) ? node.highlights : []).map(normalizeHighlight).filter(Boolean);
    const merged = new Map(existing.map(h => [h.square, h]));
    for (const h of hl) merged.set(h.square, h);

    actions.setHighlights([...merged.values()]);
    applied.highlights = hl.length;
  }

  if (typeof spec.note === 'string') {
    const note = spec.note.trim();

    if (note || clearEmpty) {
      actions.setNote(note);
      applied.note = true;
    }
  }

  if (typeof spec.nag === 'string') {
    const nag = spec.nag.trim();

    if (VALID_NAGS.includes(nag) || (nag === '' && clearEmpty)) {
      actions.setNag(nag);
      applied.nag = true;
    }
  }

  return applied;
}

/** Runs fn with `node` as the current node, then restores the previous node and selection. */
export function withNodeTarget(store, actions, node, fn) {
  const game = store && store.state ? store.state.game : null;
  const cur = game && game.current ? game.current : null;
  if (!game || !cur || !node || node.id === cur.id) return fn(node || cur);

  const selected = store.state.selected || null;
  actions.goto(node.id);

  try {
    return fn(node);
  } finally {
    actions.goto(cur.id);

    if (selected && store.state.selected !== selected && typeof actions.select === 'function') {
      try {
        actions.select(selected);
      } catch (_) {}
    }
  }
}

/** The move number a node's move was played on; null when unreadable. */
export function moveNumberOf(node) {
  const f = String((node && node.fen) || '').trim().split(/\s+/);
  const full = Number(f[5]);
  if (!Number.isFinite(full)) return null;
  return f[1] === 'b' ? full : full - 1;
}

export function getKey() {
  return readStoredKey();
}

/** Stores the Anthropic key; '' removes it. False when storage is unavailable. */
export function setKey(key) {
  const k = String(key == null ? '' : key).trim();

  try {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
    return true;
  } catch (_) {
    return false;
  }
}

export function clearKey() {
  return setKey('');
}

async function copyToClipboard(text) {
  try {
    if (globalThis.navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) {}

  try {
    if (typeof document === 'undefined' || !document.body) return false;

    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();

    const ok = !!(document.execCommand && document.execCommand('copy'));
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

/** Ask a provider about the current position and apply its drawings. */
export function createAi(store, actions) {
  let controller = null;
  let disposed = false;

  const aiSettings = () => (store.state && store.state.settings && store.state.settings.ai) || {};

  const providerId = () => {
    const id = aiSettings().provider || (store.state.ai && store.state.ai.provider) || 'packet';
    return providers[id] ? id : 'packet';
  };

  function toast(text, kind) {
    try {
      actions.toast(text, kind);
    } catch (_) {}
  }

  function fail(text) {
    try {
      actions.aiError(text);
    } catch (_) {}

    toast(text, 'error');
  }

  // core's aiMessage keeps only { role, text, at }; re-attach the extras and emit again.
  function push(msg) {
    const full = { at: new Date().toISOString(), ...msg };
    actions.aiMessage(full);

    const list = store.state.ai && Array.isArray(store.state.ai.messages) ? store.state.ai.messages : null;
    const stored = list && list.length ? list[list.length - 1] : null;
    if (!stored || stored === full) return;

    let added = false;

    for (const k of Object.keys(full)) {
      if (!(k in stored)) {
        stored[k] = full[k];
        added = true;
      }
    }

    if (added && typeof store.emit === 'function') {
      try {
        store.emit('ai:update', { ai: store.state.ai });
      } catch (_) {}
    }
  }

  function currentPacket(opts = {}) {
    const s = aiSettings();

    return buildPacket(store.state, {
      includeEngine: s.includeEngine !== false,
      includeLegalMoves: !!s.includeLegalMoves,
      ...(opts || {}),
    });
  }

  // Unanswered user turns are dropped, or mergeRoles would re-ask them against the next position.
  function priorTurns() {
    const msgs = store.state.ai && Array.isArray(store.state.ai.messages) ? store.state.ai.messages : [];
    const usable = m => m && typeof m.text === 'string' && !!m.text.trim();
    const kept = [];

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (!usable(m)) continue;

      if (m.role === 'assistant') {
        kept.push(m);
        continue;
      }

      if (m.role !== 'user') continue;

      let answered = false;

      for (let j = i + 1; j < msgs.length; j++) {
        const n = msgs[j];
        if (!n || (n.role !== 'user' && n.role !== 'assistant')) continue;
        if (n.role === 'user') break;

        if (usable(n)) {
          answered = true;
          break;
        }
      }

      if (answered) kept.push(m);
    }

    const turns = kept.slice(-MAX_HISTORY_TURNS).map(m => ({ role: m.role, content: m.text }));
    while (turns.length && turns[0].role !== 'user') turns.shift();
    return turns;
  }

  /** The node the last unanswered packet described: where a pasted reply belongs. */
  function pendingPacketNode() {
    const msgs = store.state.ai && Array.isArray(store.state.ai.messages) ? store.state.ai.messages : [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    return last && last.role === 'user' && last.nodeId ? last.nodeId : null;
  }

  async function ask(question, opts = {}) {
    if (disposed) return { ok: false, error: 'The AI session is closed.' };

    const q = String(question == null ? '' : question).trim() || DEFAULT_QUESTION;

    if (store.state.ai && store.state.ai.busy) {
      const msg = 'The AI is still answering; wait for it or cancel.';
      toast(msg, 'info');
      return { ok: false, dropped: 'busy', error: msg };
    }

    // lastError must describe this request only.
    try {
      if (store.state.ai && store.state.ai.lastError) actions.aiError(null);
    } catch (_) {}

    const pid = providerId();
    const provider = getProvider(pid);
    let packet;

    try {
      packet = currentPacket(opts.packet);
    } catch (e) {
      const msg = 'Could not build the position packet: ' + (e && e.message ? e.message : e);
      fail(msg);
      return { ok: false, error: msg };
    }

    const content = packet + '\n\nQuestion: ' + q;

    // Capture the node now: the user may step away while the model thinks.
    const node = store.state.game && store.state.game.current ? store.state.game.current : null;
    const nodeId = node ? node.id : null;
    const fen = node ? node.fen : null;

    if (pid === 'packet') {
      push({ role: 'user', text: q, packet, provider: pid, nodeId, fen });

      const copied = await copyToClipboard(content);
      toast(copied ? 'Packet and question copied. Paste the reply into the AI panel.' : 'Packet ready in the AI panel; copy it from there.', copied ? 'ok' : 'info');
      return { ok: true, provider: pid, packet, copied, reply: null, nodeId };
    }

    if (provider.needsKey && !getKey()) {
      const msg = 'No Anthropic API key. Add one in Settings > AI.';
      fail(msg);
      return { ok: false, error: msg };
    }

    const history = priorTurns();
    const model = pid === 'anthropic'
      ? (aiSettings().anthropicModel || DEFAULT_ANTHROPIC_MODEL)
      : (aiSettings().localModel || 'default');

    push({ role: 'user', text: q, packet, provider: pid, model, nodeId, fen });
    actions.aiBusy(true);
    controller = typeof AbortController === 'function' ? new AbortController() : null;

    try {
      const text = await provider.send({
        system: SYSTEM_PROMPT,
        messages: [...history, { role: 'user', content }],
        model,
        signal: controller ? controller.signal : undefined,
        onToken: typeof opts.onToken === 'function' ? opts.onToken : undefined,
        settings: aiSettings(),
        apiKey: getKey(),
      });

      return applyReply(text, { provider: pid, model, nodeId });
    } catch (e) {
      if (isAbortError(e)) {
        toast('AI request cancelled.', 'info');
        return { ok: false, cancelled: true, error: 'AI request cancelled.' };
      }

      const msg = e && e.message ? e.message : String(e);
      fail(msg);
      return { ok: false, error: msg };
    } finally {
      controller = null;

      try {
        actions.aiBusy(false);
      } catch (_) {}
    }
  }

  function applyReply(text, meta = {}) {
    const reply = String(text == null ? '' : text);

    if (!reply.trim()) {
      fail('Empty reply.');
      return { ok: false, error: 'Empty reply.', reply: '', block: null, suggestedMoves: [], applied: null };
    }

    const block = extractChessBlock(reply);
    const good = block && !block.error ? block : null;
    const suggestedMoves = good ? good.moves.slice() : [];

    // The drawing belongs on the node the packet described, not on whatever is current now.
    const wanted = meta.nodeId === undefined ? pendingPacketNode() : meta.nodeId;
    const game = store.state.game;
    const cur = game && game.current ? game.current : null;
    let target = null;
    let gone = false;

    if (wanted && cur && wanted !== cur.id) {
      target = game && typeof game.node === 'function' ? game.node(wanted) : null;
      if (!target) gone = true;
    }

    let applied = null;

    if (good && !gone) {
      try {
        applied = withNodeTarget(store, actions, target, () => applyAnnotation(good, { store, actions, source: 'ai' }));
      } catch (e) {
        toast('Could not apply the AI drawing: ' + (e && e.message ? e.message : e), 'error');
      }
    }

    const where = target ? { nodeId: target.id, san: target.san, move: moveNumberOf(target) } : null;

    push({
      role: 'assistant',
      text: reply,
      body: stripChessBlock(reply),
      suggestedMoves,
      applied,
      appliedTo: applied ? where : null,
      staleNode: gone || null,
      blockError: block && block.error ? block.error : null,
      provider: meta.provider || providerId(),
      model: meta.model || null,
    });

    if (block && block.error) {
      toast(`The reply had an unreadable chess block (${block.error}); nothing was drawn.`, 'error');
    } else if (gone) {
      toast('The position this answer was about is no longer in the game, so nothing was drawn.', 'error');
    } else if (applied) {
      const parts = [];
      if (applied.arrows) parts.push(`${applied.arrows} arrow${applied.arrows > 1 ? 's' : ''}`);
      if (applied.highlights) parts.push(`${applied.highlights} highlight${applied.highlights > 1 ? 's' : ''}`);
      if (applied.note) parts.push('a note');
      if (applied.nag) parts.push('a NAG');

      const on = where && where.san ? ` on ${where.san}${where.move ? ` (move ${where.move})` : ''}, not the current position` : '';
      const skipped = good.dropped ? ` ${good.dropped} entr${good.dropped > 1 ? 'ies were' : 'y was'} invalid and skipped.` : '';
      const tail = suggestedMoves.length ? ` Suggests ${suggestedMoves[0]}.` : '';

      if (parts.length) toast('AI drew ' + parts.join(', ') + on + '.' + skipped + tail, 'ok');
      else if (good.dropped) toast('The AI chess block had nothing the board could use:' + skipped, 'error');
      else if (tail) toast(tail.trim(), 'ok');
    }

    return { ok: true, reply, body: stripChessBlock(reply), block, suggestedMoves, applied, appliedTo: applied ? where : null };
  }

  function lastSuggestion() {
    const msgs = store.state.ai && Array.isArray(store.state.ai.messages) ? store.state.ai.messages : [];

    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];

      if (m && m.role === 'assistant' && Array.isArray(m.suggestedMoves) && m.suggestedMoves.length) {
        return { moves: m.suggestedMoves.slice(), index: i };
      }
    }

    return null;
  }

  function playSuggested(n = 0) {
    const s = lastSuggestion();
    if (!s) return { ok: false, error: 'No suggested move from the AI yet.' };

    const san = String(s.moves[n] || '').replace(/[!?]+$/, '');
    if (!san) return { ok: false, error: 'No suggested move at index ' + n + '.' };

    let node = null;

    try {
      node = actions.playSan(san);
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }

    if (!node) return { ok: false, error: `Suggested move ${san} is not legal here.` };
    return { ok: true, san: node.san, fen: node.fen };
  }

  function setProvider(id) {
    if (!providers[id]) return { ok: false, error: 'Unknown provider: ' + id };

    try {
      actions.setSetting('ai.provider', id);
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }

    if (store.state.ai && store.state.ai.provider !== id) {
      store.state.ai.provider = id;

      try {
        store.emit('ai:update', { ai: store.state.ai });
      } catch (_) {}
    }

    return { ok: true, provider: id };
  }

  function cancel() {
    if (controller) {
      try {
        controller.abort();
      } catch (_) {}
    }
  }

  function dispose() {
    disposed = true;
    cancel();
  }

  return {
    ask,
    applyReply,
    setProvider,
    getProvider: providerId,
    listProviders,
    getKey,
    setKey,
    clearKey,
    currentPacket,
    lastSuggestion,
    playSuggested,
    cancel,
    dispose,
  };
}

export { FENCE as CHESS_FENCE };
