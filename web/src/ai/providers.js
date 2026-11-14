// ai/providers.js - the three chat providers behind the AI panel, one send() shape.
//   { id, name, needsKey, send({ system, messages, model, signal, onToken?, settings?, apiKey? }) -> Promise<string> }
//   packet    : no network; send() throws 'manual provider' (chat.js does copy / paste instead)
//   local     : OpenAI-compatible POST {settings.localUrl}/chat/completions (llama-server etc.), no key
//   anthropic : POST https://api.anthropic.com/v1/messages straight from the browser (per the claude-api skill:
//               x-api-key, anthropic-version 2023-06-01, content-type json, and the
//               anthropic-dangerous-direct-browser-access: true header the contract requires for browser calls)
// Beyond the contract: `settings` (state.settings.ai) and `apiKey` are passed into send() so providers stay
// free of the store; streaming happens whenever onToken is supplied (Anthropic SSE / OpenAI SSE) and is
// otherwise off; exports KEY_STORAGE, readStoredKey(), ANTHROPIC_URL, ANTHROPIC_VERSION,
// DEFAULT_ANTHROPIC_MODEL, MAX_TOKENS, MAX_TOKENS_STREAMING, providers (by id), PROVIDERS (ordered list),
// getProvider(id), listProviders(), isAbortError(e).
// Console / UI never see thrown errors directly: chat.js turns them into actions.aiError + a toast.

export const KEY_STORAGE = 'chessboard.anthropicKey';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5';
export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8080/v1';
// max_tokens is a CEILING, not a target - the model stops on its own. It must not be sized to the visible
// reply, because on claude-sonnet-5 (and every current model) thinking runs by default when `thinking` is
// omitted and those tokens count against max_tokens. A tight cap therefore burns the budget on thinking and
// truncates the visible reply - and since the ```chess block is the LAST thing in the reply, the drawing is
// what gets lost first. Per the claude-api skill: default ~16000 for non-streaming requests (keeps them
// under HTTP timeouts) and ~64000 when streaming (timeouts are not a concern there).
export const MAX_TOKENS = 16000;
export const MAX_TOKENS_STREAMING = 64000;

/** Reads the Anthropic key from localStorage ('' when absent or storage is unavailable). */
export function readStoredKey() {
  try { return (globalThis.localStorage && localStorage.getItem(KEY_STORAGE)) || ''; } catch (_) { return ''; }
}

/** True for a fetch aborted through an AbortSignal. */
export function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 20);
}

// Anthropic wants messages to start with a user turn; merging same-role neighbours keeps any history shape valid.
function mergeRoles(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = typeof m.content === 'string' ? m.content : String(m.content ?? '');
    if (!content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + content;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length) throw new Error('Nothing to send: the conversation has no user message.');
  return out;
}

async function bodyText(res) {
  try { return (await res.text()).slice(0, 400); } catch (_) { return ''; }
}

// Server-sent events -> { event, data } objects. Works on a streaming body and on a whole text.
async function* sseEvents(res) {
  let ev = { event: '', data: [] };
  let buf = '';
  const feed = function* (chunk, flush) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (ev.data.length) yield { event: ev.event, data: ev.data.join('\n') };
        ev = { event: '', data: [] };
        continue;
      }
      if (line.startsWith(':')) continue;
      const c = line.indexOf(':');
      const field = c < 0 ? line : line.slice(0, c);
      let val = c < 0 ? '' : line.slice(c + 1);
      if (val.startsWith(' ')) val = val.slice(1);
      if (field === 'event') ev.event = val;
      else if (field === 'data') ev.data.push(val);
    }
    if (flush) {
      if (buf.trim().startsWith('data:')) ev.data.push(buf.trim().slice(5).trim());
      if (ev.data.length) yield { event: ev.event, data: ev.data.join('\n') };
      buf = '';
      ev = { event: '', data: [] };
    }
  };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* feed(dec.decode(value, { stream: true }), false);
    }
    yield* feed('', true);
  } else {
    yield* feed(await res.text(), true);
  }
}

function finishAnthropicText(text, stopReason, stopDetails) {
  if (stopReason === 'refusal' && !text.trim()) {
    const why = stopDetails && stopDetails.explanation ? ': ' + stopDetails.explanation : '.';
    throw new Error('Claude declined this request' + why);
  }
  if (stopReason === 'max_tokens') text += '\n\n[reply cut off: max_tokens reached]';
  return text;
}

function joinAnthropicText(data) {
  const blocks = Array.isArray(data && data.content) ? data.content : [];
  const text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  return finishAnthropicText(text, data && data.stop_reason, data && data.stop_details);
}

async function readAnthropicStream(res, onToken) {
  let text = '';
  let stop = null;
  let details = null;
  for await (const { data } of sseEvents(res)) {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { continue; }
    if (msg.type === 'content_block_delta' && msg.delta && msg.delta.type === 'text_delta') {
      text += msg.delta.text || '';
      try { onToken(msg.delta.text || '', text); } catch (_) { /* a UI hiccup must not kill the reply */ }
    } else if (msg.type === 'error') {
      throw new Error('Anthropic stream error: ' + ((msg.error && msg.error.message) || 'unknown'));
    } else if (msg.type === 'message_delta' && msg.delta) {
      stop = msg.delta.stop_reason || stop;
      if (msg.delta.stop_details) details = msg.delta.stop_details;
    } else if (msg.type === 'message_stop') {
      break;
    }
  }
  return finishAnthropicText(text, stop, details);
}

async function anthropicErrorMessage(res, model) {
  let type = '';
  let message = '';
  try {
    const j = await res.json();
    type = (j && j.error && j.error.type) || '';
    message = (j && j.error && j.error.message) || '';
  } catch (_) {
    message = await bodyText(res);
  }
  const s = res.status;
  const detail = message ? ' - ' + message : '';
  if (s === 401) return `Anthropic rejected the API key (401)${detail}. Check the key in Settings > AI.`;
  if (s === 403) return `Anthropic refused this key (403 ${type})${detail}. Direct-from-browser calls need a key whose organization allows them.`;
  if (s === 404) return `Anthropic: model "${model}" not found (404)${detail}. Change the model in Settings > AI.`;
  if (s === 429) return `Anthropic rate limit hit (429)${detail}. Wait a moment and ask again.`;
  if (s === 529 || s >= 500) return `Anthropic is overloaded or failing (${s} ${type})${detail}. Try again shortly.`;
  return `Anthropic error ${s} ${type}${detail}`;
}

async function readOpenAiStream(res, onToken) {
  let text = '';
  for await (const { data } of sseEvents(res)) {
    if (data === '[DONE]') break;
    let msg;
    try { msg = JSON.parse(data); } catch (_) { continue; }
    if (msg.error) throw new Error('Local model stream error: ' + (msg.error.message || JSON.stringify(msg.error)));
    const delta = msg.choices && msg.choices[0] && msg.choices[0].delta;
    const piece = delta && typeof delta.content === 'string' ? delta.content : '';
    if (piece) {
      text += piece;
      try { onToken(piece, text); } catch (_) { /* ignore UI errors */ }
    }
  }
  return text;
}

const packetProvider = {
  id: 'packet',
  name: 'Packet (copy / paste)',
  needsKey: false,
  /** The packet provider has no network path; chat.js copies the packet and takes a pasted reply instead. */
  async send() {
    throw new Error('manual provider');
  },
};

const localProvider = {
  id: 'local',
  name: 'Local model (OpenAI-compatible)',
  needsKey: false,
  /** POST {localUrl}/chat/completions; resolves to the reply text. */
  async send({ system, messages, model, signal, onToken, settings } = {}) {
    const base = String((settings && settings.localUrl) || DEFAULT_LOCAL_URL).trim().replace(/\/+$/, '');
    const url = base + '/chat/completions';
    const body = {
      model: model || (settings && settings.localModel) || 'default',
      messages: [{ role: 'system', content: system || '' }, ...mergeRoles(messages)],
      temperature: 0.4,
      stream: typeof onToken === 'function',
    };
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new Error(`Could not reach ${url} (${e && e.message ? e.message : e}). Start llama-server (for example: llama-server -m model.gguf --port 8080) and make sure it allows CORS from this page.`);
    }
    if (!res.ok) throw new Error(`Local model returned HTTP ${res.status}: ${(await bodyText(res)) || res.statusText || 'no body'}`);
    if (typeof onToken === 'function') return readOpenAiStream(res, onToken);
    const data = await res.json();
    const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
    const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : null;
    if (text === null) throw new Error('Local model returned no text (unexpected response shape).');
    return text;
  },
};

const anthropicProvider = {
  id: 'anthropic',
  name: 'Anthropic (Claude)',
  needsKey: true,
  /** POST /v1/messages from the browser; resolves to the joined text blocks. */
  async send({ system, messages, model, signal, onToken, apiKey } = {}) {
    const key = (apiKey || readStoredKey() || '').trim();
    if (!key) throw new Error('No Anthropic API key. Add one in Settings > AI (it stays in this browser only).');
    const modelId = model || DEFAULT_ANTHROPIC_MODEL;
    const streaming = typeof onToken === 'function';
    const body = {
      model: modelId,
      max_tokens: streaming ? MAX_TOKENS_STREAMING : MAX_TOKENS,
      system: system || '',
      messages: mergeRoles(messages),
      stream: streaming,
    };
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new Error(`Network error reaching api.anthropic.com (${e && e.message ? e.message : e}). Check the connection; a CORS block here means the browser call was refused before it reached the API.`);
    }
    if (!res.ok) throw new Error(await anthropicErrorMessage(res, modelId));
    if (typeof onToken === 'function') return readAnthropicStream(res, onToken);
    return joinAnthropicText(await res.json());
  },
};

export const providers = { packet: packetProvider, local: localProvider, anthropic: anthropicProvider };
export const PROVIDERS = [packetProvider, localProvider, anthropicProvider];

/** Provider by id; falls back to the packet provider for unknown ids. */
export function getProvider(id) {
  return providers[id] || packetProvider;
}

/** [{ id, name, needsKey }] for a select box. */
export function listProviders() {
  return PROVIDERS.map(p => ({ id: p.id, name: p.name, needsKey: p.needsKey }));
}
