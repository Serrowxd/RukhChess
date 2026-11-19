// Pages on the stand-in desk over in-memory sockets, for the board-tab tests (see docs/testing.md).
import { startRemoteSync } from '../src/net/remoteSync.js';
import { createStore } from '../src/core/store.js';
import { createFakeDesk } from './fake-table.mjs';

export class FakeSocket {
  static last = null;

  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeSocket.last = this;
  }

  send(text) { this.sent.push(JSON.parse(text)); }

  close() { this.readyState = 3; }

  receive(msg) { this.onmessage({ data: JSON.stringify(msg) }); }
}

/** A desk with `n` pages on it; pump() applies every sent intent, frame first, then the ack; with `saving`, the boards message after. */
export function deskProgram(n = 1, { saving = false } = {}) {
  const desk = createFakeDesk({ instance: 'i1', saving });
  const pages = [];

  // The pages' timers wait here until a test runs them.
  const timers = new Map();
  let nextTimer = 1;

  const setTimeout = (fn, ms) => {
    timers.set(nextTimer, { fn, ms });
    return nextTimer++;
  };

  const clearTimeout = id => { timers.delete(id); };

  /** Runs the zero-delay timers, as the event loop would next. */
  const runSoon = () => {
    for (const [id, timer] of [...timers]) {
      if (timer.ms) continue;

      timers.delete(id);
      timer.fn();
    }
  };

  for (let i = 0; i < n; i++) {
    const st = createStore({ storage: null });
    const remote = startRemoteSync({ store: st, actions: st.actions, location: { href: 'http://127.0.0.1:47480/' }, WebSocket: FakeSocket, ackTimeoutMs: 60000, setTimeout, clearTimeout });

    const ws = FakeSocket.last;
    ws.onopen();
    ws.receive({ t: 'hello', proto: 2, instance: 'i1', you: `view:${i + 1}`, boards: desk.boards() });

    const events = [];
    st.on('game:change', p => events.push(p.reason));

    const toasts = [];
    st.actions.toast = (text, kind) => { toasts.push({ text, kind }); };

    pages.push({ st, remote, ws, events, toasts, by: `view:${i + 1}` });
  }

  const broadcast = () => {
    const f = desk.frame();
    for (const p of pages) p.ws.receive(f);
  };

  // As the program does, the boards message goes to every page only when the closed count changes.
  let closedSent = desk.boards().closed;

  const tellBoards = () => {
    const now = desk.boards();
    if (!saving || now.closed === closedSent) return;

    closedSent = now.closed;
    for (const p of pages) p.ws.receive({ t: 'boards', ...now });
  };

  let intents = [];

  /** Applies one intent as the program does: the frame goes out first, then the ack. */
  function deliver(p, msg) {
    intents.push(msg);

    const { t: _t, id, ...intent } = msg;
    const before = desk.rev;
    const res = desk.apply(p.by, intent);
    if (desk.rev !== before) broadcast();

    p.ws.receive(res.ok ? { t: 'ack', id, ok: true, rev: desk.rev, result: res.result } : { t: 'ack', id, ok: false, error: res.error });
    tellBoards();
  }

  const pump = () => {
    let moved = true;

    while (moved) {
      moved = false;

      for (const p of pages) {
        while (p.ws.sent.length) {
          moved = true;
          deliver(p, p.ws.sent.shift());
        }
      }
    }
  };

  /** An intent from another window, applied at once. */
  const view = (by, intent) => {
    const before = desk.rev;
    const res = desk.apply(by, intent);
    if (desk.rev !== before) broadcast();
    tellBoards();
    return res;
  };

  /** The program gives a tab a mark. */
  const mark = (id, value) => {
    const before = desk.rev;
    desk.setMark(id, value);
    if (desk.rev !== before) broadcast();
  };

  broadcast();

  return {
    desk, pages, pump, deliver, view, mark, broadcast, runSoon,
    sent: () => intents,
    clearSent: () => { intents = []; },
    done: () => {
      for (const p of pages) {
        p.remote.stop();
        p.st.dispose();
      }
    },
  };
}
