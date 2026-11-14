// ai/mcpBridge.js - the optional MCP path: the page publishes its position to a loopback bridge
// (mcp/chess_mcp.py on http://127.0.0.1:8152) and polls it for commands an agent queued there.
// This is how "AI over MCP" plays a self-play game, and a second road to the same actions
// window.chess already drives - never a replacement for it.
//
// Owns: createMcpBridge(store, actions, opts) -> { enable, disable, status, publish, poll, applyCommand,
//       isEnabled, dispose } per CONTRACT.md Addendum v1, plus MCP_URL / POLL_MS / MAX_BACKOFF_MS.
//
// Two hard rules:
//   1. OPTIONAL. Nothing is created, listened to, fetched or timed until enable() is called, and disable()
//      puts it all back. The single-file build with the bridge off behaves exactly as it does with this
//      module absent - that is what keeps the app serverless by default.
//   2. IT NEVER THROWS INTO THE APP. Every fetch, every command, every payload build is wrapped. A dead
//      server is a status (`connected:false`, `lastError`) the UI can show, plus exponential backoff
//      (700 ms -> 10 s); it is never an exception and never a toast storm.
//
// Beyond the contract:
//   status() -> { enabled, connected, url, state:'off'|'connecting'|'live'|'offline', lastError, failures,
//                 delay, since, published, applied, awaiting, pending }
//   publish() / poll() are exposed so the UI (and the tests) can force a round trip; both resolve to a
//      result object and never reject.
//   applyCommand(cmd) is pure-ish and synchronous: the ops the server queues are play | annotate | set_fen |
//      new_game | goto | back | forward | refresh | ping. Unknown ops come back as { ok:false, error }.
//   opts = { url, fetch, setTimer, clearTimer, interval, maxBackoff, timeout, onStatus, includeEngine }
//      - every ambient dependency is injectable so the node test runs with a stubbed fetch and no timers.
//   The bridge emits 'mcp:change' { mcp: status() } on the store (a NEW event, not in CONTRACT.md - see
//      the report) and calls opts.onStatus(status) when given, so a panel can render the connection.
//
// Self-play: when state.selfPlay.opponent === 'ai' and state.selfPlay.awaiting names a colour, the published
// packet carries `awaiting: 'black'`. That field IS the request for a move - the agent polls get_position,
// sees it and calls play(). While a request is outstanding the bridge re-publishes every few seconds so an
// agent that connects late still sees it.

import { buildContext, buildPacket, legalSanList } from './packet.js';
import { normalizeAiStyle } from '../core/store.js';
import { applyAnnotation } from './chat.js';

export const MCP_URL = 'http://127.0.0.1:8152';
export const POLL_MS = 700;
export const MAX_BACKOFF_MS = 10000;
export const REQUEST_TIMEOUT_MS = 4000;
export const AWAITING_REPUBLISH_MS = 3000;

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/i;

function errText(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  return e.message ? String(e.message) : String(e);
}

/** A dead loopback server is the normal case (it is opt-in); say so in words a panel can show. */
function friendlyError(e, url) {
  const t = errText(e);
  if (/aborted|timeout|abort/i.test(t)) return `no answer from ${url} (timed out)`;
  if (/fetch|network|refused|failed/i.test(t)) return `cannot reach ${url} - is chess_mcp.py running?`;
  return t;
}

export function createMcpBridge(store, actions, opts = {}) {
  const url = String(opts.url || MCP_URL).replace(/\/+$/, '');
  const interval = Number.isFinite(opts.interval) ? Math.max(50, opts.interval) : POLL_MS;
  const maxBackoff = Number.isFinite(opts.maxBackoff) ? opts.maxBackoff : MAX_BACKOFF_MS;
  const timeoutMs = Number.isFinite(opts.timeout) ? opts.timeout : REQUEST_TIMEOUT_MS;
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;

  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  // An explicit opts.fetch (even null) wins: a test passing null is asking for "no fetch here", not for window's.
  const fetchImpl = Object.prototype.hasOwnProperty.call(opts, 'fetch')
    ? (typeof opts.fetch === 'function' ? opts.fetch : null)
    : (typeof g.fetch === 'function' ? (...a) => g.fetch(...a) : null);
  const setTimer = opts.setTimer || (typeof g.setTimeout === 'function' ? (fn, ms) => g.setTimeout(fn, ms) : null);
  const clearTimer = opts.clearTimer || (typeof g.clearTimeout === 'function' ? (h) => g.clearTimeout(h) : () => {});

  let enabled = false;
  let timer = null;
  let unsubs = [];
  let since = 0;
  let failures = 0;
  let delay = interval;
  let publishing = false;
  let publishQueued = false;
  let polling = false;
  let published = 0;
  let applied = 0;
  let connected = false;
  let lastError = null;
  let lastAwaiting = null;
  let awaitingSince = 0;
  let disposed = false;

  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const st = () => (store && store.state) || {};
  const selfPlay = () => st().selfPlay || {};

  function statusObject() {
    const sp = selfPlay();
    return {
      enabled,
      connected,
      url,
      state: !enabled ? 'off' : (connected ? 'live' : (failures ? 'offline' : 'connecting')),
      lastError,
      failures,
      delay,
      since,
      published,
      applied,
      opponent: sp.opponent || null,
      awaiting: sp.awaiting || null,
    };
  }

  function announce() {
    const s = statusObject();
    if (onStatus) { try { onStatus(s); } catch (_) { /* a listener must not break the bridge */ } }
    if (store && typeof store.emit === 'function') {
      try { store.emit('mcp:change', { mcp: s }); } catch (_) { /* store may not know the event */ }
    }
  }

  function toast(text, kind) {
    try { if (actions && typeof actions.toast === 'function') actions.toast(text, kind); } catch (_) { /* cosmetic */ }
  }

  function noteSuccess() {
    const was = connected;
    connected = true;
    failures = 0;
    delay = interval;
    lastError = null;
    if (!was) announce();
  }

  function noteFailure(e) {
    const was = connected;
    connected = false;
    failures += 1;
    delay = Math.min(maxBackoff, interval * Math.pow(2, Math.min(failures, 6)));
    lastError = friendlyError(e, url);
    if (was) toast('MCP bridge lost: ' + lastError, 'error');
    announce();
  }

  // ---- transport (the only place fetch is touched) ----
  async function request(path, init) {
    if (!fetchImpl) throw new Error('fetch is not available in this environment');
    let ctrl = null;
    let t = null;
    const opt = { ...(init || {}) };
    if (typeof AbortController === 'function' && setTimer) {
      ctrl = new AbortController();
      opt.signal = ctrl.signal;
      t = setTimer(() => { try { ctrl.abort(); } catch (_) { /* done */ } }, timeoutMs);
    }
    try {
      const res = await fetchImpl(url + path, opt);
      if (!res || res.ok === false) throw new Error(`HTTP ${res && res.status ? res.status : '?'} from ${path}`);
      if (typeof res.json === 'function') return await res.json();
      return {};
    } finally {
      if (t != null) { try { clearTimer(t); } catch (_) { /* done */ } }
    }
  }

  const postJson = (path, body) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // ---- what the page publishes ----
  function payload() {
    const state = st();
    const game = state.game;
    const aiSettings = (state.settings && state.settings.ai) || {};
    const ctx = buildContext(state, { includeEngine: aiSettings.includeEngine !== false, includeLegalMoves: false });
    const sp = selfPlay();
    let moves = [];
    try { moves = legalSanList(game); } catch (_) { moves = []; }
    const clock = state.clock && state.clock.initial
      ? { white: state.clock.white, black: state.clock.black, running: !!state.clock.running, flagged: state.clock.flagged || null }
      : null;
    return {
      protocol: 1,
      variant: ctx.variant,
      chess960: ctx.chess960,
      start_fen: ctx.start_fen,
      fen: ctx.fen,
      turn: ctx.turn,
      move_number: ctx.move_number,
      ply: ctx.ply,
      line: ctx.line,
      history: ctx.history_san,
      last_move: ctx.last_move,
      status: ctx.status,
      legal_moves: moves,
      arrows: ctx.arrows,
      highlights: ctx.highlights,
      note: ctx.note,
      title: ctx.title,
      mode: ctx.mode,
      orientation: state.orientation || 'white',
      view_mode: state.viewMode || '3d',
      self_play: !!sp.on,
      opponent: sp.opponent || null,
      // Part of the request, not out-of-band config: the board tells the agent what kind of opponent to be.
      ai_style: normalizeAiStyle(((state.settings || {}).selfPlay || {}).aiStyle),
      awaiting: sp.awaiting || null,
      clock,
      packet: buildPacket(state, {
        includeEngine: aiSettings.includeEngine !== false,
        includeLegalMoves: !!aiSettings.includeLegalMoves,
      }),
      at: new Date().toISOString(),
    };
  }

  /** POST the current position. Resolves to { ok } or { ok:false, error }; never rejects. */
  async function publish() {
    if (!enabled || disposed) return { ok: false, error: 'bridge is disabled' };
    if (publishing) { publishQueued = true; return { ok: true, queued: true }; }
    publishing = true;
    let body;
    try {
      body = payload();
    } catch (e) {
      publishing = false;
      return { ok: false, error: 'could not build the packet: ' + errText(e) };
    }
    try {
      const out = await postJson('/state', body);
      published += 1;
      // The server restarts with seq 0; a cursor from the old process would hide every new command.
      if (out && Number.isFinite(out.since) && out.since < since) since = out.since;
      noteSuccess();
      return { ok: true, since };
    } catch (e) {
      noteFailure(e);
      return { ok: false, error: lastError };
    } finally {
      publishing = false;
      if (publishQueued && enabled) { publishQueued = false; publish(); }
    }
  }

  // ---- applying what the agent queued ----
  function playMove(text) {
    const move = String(text == null ? '' : text).trim().replace(/^\d+\.(\.\.)?\s*/, '').replace(/[!?]+$/, '');
    if (!move) return { ok: false, error: 'play needs a move' };
    const game = st().game;
    let node = null;
    if (UCI_RE.test(move)) {
      const m = game && typeof game.uciToMove === 'function' ? game.uciToMove(move.toLowerCase()) : null;
      if (!m) return { ok: false, error: `cannot read UCI move ${move} in this position` };
      node = actions.playMove(m);
    } else {
      node = actions.playSan(move);
    }
    if (!node) return { ok: false, error: `illegal move: ${move} (${game ? game.turn() : '?'} to move)` };
    let status = null;
    try { status = game.status(); } catch (_) { status = null; }
    return {
      ok: true,
      result: {
        san: node.san, uci: node.uci, fen: node.fen, ply: node.ply, turn: game.turn(),
        status: status ? (status.checkmate ? 'checkmate' : (status.check ? 'check' : (status.outcome ? 'game over' : 'playing'))) : 'playing',
        outcome: status ? status.outcome : null,
      },
    };
  }

  /** One queued command -> one action. Synchronous, self-reporting, never throws. */
  function applyCommand(cmd) {
    const op = cmd && cmd.op ? String(cmd.op) : '';
    const args = (cmd && cmd.args) || {};
    try {
      if (op === 'play') return playMove(args.move);
      if (op === 'annotate') {
        const counts = applyAnnotation(
          { arrows: args.arrows, highlights: args.highlights, note: args.note, nag: args.nag },
          { store, actions, source: 'ai', clearEmpty: false },
        );
        const total = counts.arrows + counts.highlights + (counts.note ? 1 : 0) + (counts.nag ? 1 : 0);
        if (!total) return { ok: false, error: 'nothing was applied (squares must be a1..h8 and colours green|red|blue|yellow)' };
        return { ok: true, result: { applied: counts } };
      }
      if (op === 'set_fen') {
        if (actions.loadFen(String(args.fen || '').trim()) === false) return { ok: false, error: 'the board refused that FEN' };
        return { ok: true, result: { fen: st().game.fen(), turn: st().game.turn() } };
      }
      if (op === 'new_game') {
        actions.newGame();
        return { ok: true, result: { fen: st().game.fen(), turn: st().game.turn() } };
      }
      if (op === 'goto' || op === 'back' || op === 'forward') {
        if (op === 'goto') actions.goto(String(args.node_id || args.id || ''));
        else actions[op]();
        return { ok: true, result: { fen: st().game.fen(), ply: st().game.current ? st().game.current.ply : 0 } };
      }
      if (op === 'refresh' || op === 'ping') return { ok: true, result: { pong: true } };
      return { ok: false, error: `unknown command "${op}"` };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  }

  /** One poll round trip: read commands, apply them, ack them. Resolves to { ok, applied } where `applied`
   *  counts the commands handled (a refused move is handled: the agent gets the reason). Never rejects. */
  async function poll() {
    if (!enabled || disposed) return { ok: false, error: 'bridge is disabled' };
    if (polling) return { ok: true, skipped: true };
    polling = true;
    try {
      const out = await request(`/commands?since=${since}`, { method: 'GET' });
      noteSuccess();
      const cmds = out && Array.isArray(out.commands) ? out.commands : [];
      // Server restarted (its seq went backwards): rewind so its fresh commands are seen.
      if (out && Number.isFinite(out.seq) && out.seq < since) since = out.seq;
      if (!cmds.length) return { ok: true, applied: 0 };
      const acks = [];
      let changed = false;
      for (const cmd of cmds) {
        if (!cmd || !Number.isFinite(cmd.seq)) continue;
        if (cmd.seq <= since) continue;
        const r = applyCommand(cmd);
        since = Math.max(since, cmd.seq);
        if (r.ok) { applied += 1; changed = true; }
        acks.push({ seq: cmd.seq, ok: !!r.ok, result: r.result || null, error: r.ok ? null : r.error });
      }
      if (acks.length) {
        try {
          await postJson('/ack', { acks });
          noteSuccess();
        } catch (e) {
          noteFailure(e);
        }
      }
      // A move through MCP changes the position; position:change republishes, but annotations do not.
      if (changed) publish();
      announce();
      return { ok: true, applied: acks.length };
    } catch (e) {
      noteFailure(e);
      return { ok: false, error: lastError };
    } finally {
      polling = false;
    }
  }

  // ---- self-play: `awaiting` is the request; keep it visible ----
  function checkAwaiting() {
    const sp = selfPlay();
    const want = sp.opponent === 'ai' && sp.awaiting ? sp.awaiting : null;
    if (want !== lastAwaiting) {
      lastAwaiting = want;
      awaitingSince = now();
      if (want) {
        publish();
        toast(`Waiting for the AI to play ${want} over MCP`, 'info');
      }
      announce();
      return;
    }
    // Re-publish while a move is outstanding so an agent that connects late still sees the request.
    if (want && now() - awaitingSince >= AWAITING_REPUBLISH_MS) {
      awaitingSince = now();
      publish();
    }
  }

  function tick() {
    timer = null;
    if (!enabled || disposed) return;
    checkAwaiting();
    poll().then(schedule, schedule);
  }

  function schedule() {
    if (!enabled || disposed || !setTimer) return;
    if (timer != null) return;
    timer = setTimer(tick, delay);
  }

  function listen() {
    if (!store || typeof store.on !== 'function') return;
    const add = (event, fn) => {
      try {
        const off = store.on(event, fn);
        if (typeof off === 'function') unsubs.push(off);
        else unsubs.push(() => { try { store.off(event, fn); } catch (_) { /* no off() */ } });
      } catch (_) { /* unknown event on this store */ }
    };
    add('position:change', () => { publish(); });
    add('selfplay:change', () => { checkAwaiting(); publish(); });
  }

  function unlisten() {
    for (const off of unsubs) { try { off(); } catch (_) { /* already gone */ } }
    unsubs = [];
  }

  /** Turn the bridge on: publish now, then poll. Returns status(); never throws. */
  function enable() {
    if (disposed) return statusObject();
    if (enabled) return statusObject();
    if (!fetchImpl) {
      lastError = 'fetch is not available in this environment';
      announce();
      return statusObject();
    }
    enabled = true;
    connected = false;
    failures = 0;
    delay = interval;
    lastError = null;
    lastAwaiting = null;
    listen();
    announce();
    publish();
    schedule();
    return statusObject();
  }

  /** Turn it off: no listeners, no timer, no further fetch. */
  function disable() {
    if (!enabled) { enabled = false; return statusObject(); }
    enabled = false;
    connected = false;
    publishQueued = false;
    lastAwaiting = null;
    unlisten();
    if (timer != null) { try { clearTimer(timer); } catch (_) { /* gone */ } timer = null; }
    announce();
    return statusObject();
  }

  function dispose() {
    disable();
    disposed = true;
  }

  return {
    enable,
    disable,
    dispose,
    status: statusObject,
    isEnabled: () => enabled,
    publish,
    poll,
    applyCommand,
    url,
  };
}
