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

/** A dead loopback server is the normal case; say so in words a panel can show. */
function friendlyError(e, url) {
  const t = errText(e);
  if (/aborted|timeout|abort/i.test(t)) return `no answer from ${url} (timed out)`;
  if (/fetch|network|refused|failed/i.test(t)) return `cannot reach ${url} - is the MCP bridge server running?`;
  return t;
}

export function createMcpBridge(store, actions, opts = {}) {
  const url = String(opts.url || MCP_URL).replace(/\/+$/, '');
  const interval = Number.isFinite(opts.interval) ? Math.max(50, opts.interval) : POLL_MS;
  const maxBackoff = Number.isFinite(opts.maxBackoff) ? opts.maxBackoff : MAX_BACKOFF_MS;
  const timeoutMs = Number.isFinite(opts.timeout) ? opts.timeout : REQUEST_TIMEOUT_MS;
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : null;

  const g = typeof globalThis !== 'undefined' ? globalThis : {};

  // An explicit opts.fetch, even null, wins over window's.
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

    if (onStatus) {
      try {
        onStatus(s);
      } catch (_) {}
    }

    if (store && typeof store.emit === 'function') {
      try {
        store.emit('mcp:change', { mcp: s });
      } catch (_) {}
    }
  }

  function toast(text, kind) {
    try {
      if (actions && typeof actions.toast === 'function') actions.toast(text, kind);
    } catch (_) {}
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

  // Transport: the only place fetch is touched.

  async function request(path, init) {
    if (!fetchImpl) throw new Error('fetch is not available in this environment');

    let ctrl = null;
    let t = null;
    const opt = { ...(init || {}) };

    if (typeof AbortController === 'function' && setTimer) {
      ctrl = new AbortController();
      opt.signal = ctrl.signal;

      t = setTimer(() => {
        try {
          ctrl.abort();
        } catch (_) {}
      }, timeoutMs);
    }

    try {
      const res = await fetchImpl(url + path, opt);
      if (!res || res.ok === false) throw new Error(`HTTP ${res && res.status ? res.status : '?'} from ${path}`);
      if (typeof res.json === 'function') return await res.json();
      return {};
    } finally {
      if (t != null) {
        try {
          clearTimer(t);
        } catch (_) {}
      }
    }
  }

  const postJson = (path, body) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // What the page publishes.

  function payload() {
    const state = st();
    const game = state.game;
    const aiSettings = (state.settings && state.settings.ai) || {};
    const ctx = buildContext(state, { includeEngine: aiSettings.includeEngine !== false, includeLegalMoves: false });
    const sp = selfPlay();

    let moves = [];

    try {
      moves = legalSanList(game);
    } catch (_) {
      moves = [];
    }

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

  /** POST the current position; never rejects. */
  async function publish() {
    if (!enabled || disposed) return { ok: false, error: 'bridge is disabled' };

    if (publishing) {
      publishQueued = true;
      return { ok: true, queued: true };
    }

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

      // A restarted server starts at seq 0; the old cursor would hide every new command.
      if (out && Number.isFinite(out.since) && out.since < since) since = out.since;

      noteSuccess();
      return { ok: true, since };
    } catch (e) {
      noteFailure(e);
      return { ok: false, error: lastError };
    } finally {
      publishing = false;

      if (publishQueued && enabled) {
        publishQueued = false;
        publish();
      }
    }
  }

  // Applying what the agent queued.

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

    try {
      status = game.status();
    } catch (_) {
      status = null;
    }

    return {
      ok: true,
      result: {
        san: node.san, uci: node.uci, fen: node.fen, ply: node.ply, turn: game.turn(),
        status: status ? (status.checkmate ? 'checkmate' : (status.check ? 'check' : (status.outcome ? 'game over' : 'playing'))) : 'playing',
        outcome: status ? status.outcome : null,
      },
    };
  }

  /** One queued command to one action; synchronous and never throws. */
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

  /** Read, apply and ack queued commands; a refused move still counts as handled. Never rejects. */
  async function poll() {
    if (!enabled || disposed) return { ok: false, error: 'bridge is disabled' };
    if (polling) return { ok: true, skipped: true };

    polling = true;

    try {
      const out = await request(`/commands?since=${since}`, { method: 'GET' });
      noteSuccess();

      const cmds = out && Array.isArray(out.commands) ? out.commands : [];

      // The server restarted (its seq went backwards): rewind to see its fresh commands.
      if (out && Number.isFinite(out.seq) && out.seq < since) since = out.seq;

      if (!cmds.length) return { ok: true, applied: 0 };

      const acks = [];
      let changed = false;

      for (const cmd of cmds) {
        if (!cmd || !Number.isFinite(cmd.seq)) continue;
        if (cmd.seq <= since) continue;

        const r = applyCommand(cmd);
        since = Math.max(since, cmd.seq);

        if (r.ok) {
          applied += 1;
          changed = true;
        }

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

      // position:change republishes moves, but annotations need this.
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

  // Self-play: `awaiting` is the move request, kept visible.

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

    // Re-publish so an agent that connects late still sees the request.
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
        else unsubs.push(() => {
          try {
            store.off(event, fn);
          } catch (_) {}
        });
      } catch (_) {}
    };

    add('position:change', () => {
      publish();
    });

    add('selfplay:change', () => {
      checkAwaiting();
      publish();
    });
  }

  function unlisten() {
    for (const off of unsubs) {
      try {
        off();
      } catch (_) {}
    }

    unsubs = [];
  }

  /** Publish now, then poll. Never throws. */
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

  /** No listeners, no timer, no further fetch. */
  function disable() {
    if (!enabled) {
      enabled = false;
      return statusObject();
    }

    enabled = false;
    connected = false;
    publishQueued = false;
    lastAwaiting = null;
    unlisten();

    if (timer != null) {
      try {
        clearTimer(timer);
      } catch (_) {}

      timer = null;
    }

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
