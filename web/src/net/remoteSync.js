/** Protocol version this page speaks. */
export const PROTO = 2;

/** Shown when the program refuses a new board at the limit. */
export const TAB_LIMIT_TEXT = 'Close a board first.';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PROBE_TIMEOUT_MS = 1500;
const ACK_TIMEOUT_MS = 5000;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 15000;

// Pure: snapshot to study

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Map of node id to node; throws a readable reason when the snapshot is not usable. */
export function indexSnapshot(snapshot) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length) {
    throw new Error('the frame carries no game (state.game.nodes is missing or empty)');
  }

  const byId = new Map();

  for (const n of snapshot.nodes) {
    if (!isObject(n) || typeof n.id !== 'number' || typeof n.fen !== 'string') {
      throw new Error('the frame holds a move without a numeric id or a FEN');
    }

    byId.set(n.id, n);
  }

  return byId;
}

function rootOf(snapshot, byId) {
  const root = snapshot.nodes.find(n => n.parent === null || n.parent === undefined) || byId.get(0);
  if (!root) throw new Error('the frame holds no start position (no node without a parent)');
  return root;
}

/** Child indexes from the root to the snapshot's current node. */
export function cursorOf(snapshot, byId = indexSnapshot(snapshot)) {
  let path = Array.isArray(snapshot.path) ? snapshot.path : [];

  // A path that does not end at the current node is rebuilt from the parent links.
  if (!path.length || path[path.length - 1] !== snapshot.current) {
    path = [];
    const seen = new Set();

    for (let n = byId.get(snapshot.current); n && !seen.has(n.id); n = byId.get(n.parent)) {
      seen.add(n.id);
      path.unshift(n.id);
    }
  }

  const out = [];

  for (let i = 1; i < path.length; i++) {
    const parent = byId.get(path[i - 1]);
    const at = parent && Array.isArray(parent.children) ? parent.children.indexOf(path[i]) : -1;
    if (at < 0) break;
    out.push(at);
  }

  return out;
}

const cleanArrows = list => (Array.isArray(list) ? list : [])
  .filter(a => isObject(a) && typeof a.from === 'string' && typeof a.to === 'string')
  .map(a => {
    const out = { from: a.from, to: a.to, color: typeof a.color === 'string' ? a.color : 'green' };
    if (typeof a.source === 'string') out.source = a.source;
    return out;
  });

const cleanHighlights = list => (Array.isArray(list) ? list : [])
  .filter(h => isObject(h) && typeof h.square === 'string')
  .map(h => ({ square: h.square, color: typeof h.color === 'string' ? h.color : 'green' }));

function cleanEval(e) {
  if (!isObject(e)) return null;

  const out = { depth: Number.isFinite(e.depth) ? e.depth : 0, pv: Array.isArray(e.pv) ? e.pv.filter(x => typeof x === 'string') : [] };
  if (Number.isFinite(e.mate)) out.mate = e.mate;
  else if (Number.isFinite(e.cp)) out.cp = e.cp;
  else return null;

  if (typeof e.best === 'string' && e.best) out.best = e.best;
  return out;
}

/** A rukh_core::Snapshot as the study actions.loadStudy takes; `meta` keeps the page-only fields. */
export function snapshotToStudy(snapshot, meta = {}) {
  const byId = indexSnapshot(snapshot);
  const root = rootOf(snapshot, byId);

  const convert = n => ({
    san: typeof n.san === 'string' ? n.san : null,
    uci: typeof n.uci === 'string' ? n.uci : null,
    fen: n.fen,
    note: typeof n.note === 'string' ? n.note : '',
    nag: typeof n.nag === 'string' ? n.nag : '',
    arrows: cleanArrows(n.arrows),
    highlights: cleanHighlights(n.highlights),
    eval: cleanEval(n.eval),
    children: [],
  });

  // Iterative so a long game cannot overflow the stack; `seen` stops a malformed tree from looping.
  const tree = convert(root);
  const seen = new Set([root.id]);
  const stack = [{ src: root, out: tree }];

  while (stack.length) {
    const { src, out } = stack.pop();

    for (const id of Array.isArray(src.children) ? src.children : []) {
      const child = byId.get(id);
      if (!child || seen.has(id)) continue;

      seen.add(id);
      const c = convert(child);
      out.children.push(c);
      stack.push({ src: child, out: c });
    }
  }

  const startFen = typeof snapshot.start_fen === 'string' && snapshot.start_fen ? snapshot.start_fen : root.fen;

  return {
    version: 1,
    title: typeof meta.title === 'string' ? meta.title : '',
    created: typeof meta.created === 'string' ? meta.created : undefined,
    notes: typeof meta.notes === 'string' ? meta.notes : '',
    orientation: meta.orientation === 'black' ? 'black' : 'white',
    cursor: cursorOf(snapshot, byId),
    game: {
      version: 1,
      variant: snapshot.variant === 'chess960' ? 'chess960' : 'standard',
      chess960Number: Number.isInteger(snapshot.chess960_number) ? snapshot.chess960_number : null,
      startFen,
      headers: {},
      tree,
    },
  };
}

// Pure: comparing what is shown

/** The move from `shownFen` to the snapshot's current node, when it is exactly one move; else null. */
export function moveAhead(snapshot, shownFen) {
  let byId;

  try {
    byId = indexSnapshot(snapshot);
  } catch (_) {
    return null;
  }

  const cur = byId.get(snapshot.current);
  if (!cur || cur.parent === null || cur.parent === undefined || typeof cur.uci !== 'string') return null;

  const parent = byId.get(cur.parent);
  if (!parent || parent.fen !== shownFen) return null;
  return { uci: cur.uci, san: typeof cur.san === 'string' ? cur.san : null };
}

/** Equal for two trees exactly when they show the same thing; evaluations are left out. */
export function treeSignature(tree, cursor, variant = 'standard') {
  const parts = [];
  const stack = [tree];

  while (stack.length) {
    const n = stack.pop();

    if (n === ')') {
      parts.push(')');
      continue;
    }

    const arrows = (n.arrows || []).map(a => `${a.from}${a.to}:${a.color}`).join(',');
    const highlights = (n.highlights || []).map(h => `${h.square}:${h.color}`).join(',');
    parts.push(`(${n.fen}|${n.note || ''}|${n.nag || ''}|${arrows}|${highlights}`);
    stack.push(')');

    const kids = n.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }

  return `${variant === 'chess960' ? 'chess960' : 'standard'}@${(cursor || []).join('.')}#${parts.join('')}`;
}

export function snapshotSignature(snapshot) {
  const st = snapshotToStudy(snapshot);
  return treeSignature(st.game.tree, st.cursor, st.game.variant);
}

export function gameSignature(game) {
  return treeSignature(game.toJSON().tree, game.cursor(), game.variant);
}

/** True for another program start or a higher rev. */
export function isNewerFrame(seen, frame) {
  if (!isObject(frame) || typeof frame.rev !== 'number') return false;
  if (!seen) return true;
  return frame.instance !== seen.instance || frame.rev > seen.rev;
}

// Pure: the frame body, match and presence

const SIDES = ['white', 'black'];
const SEATS = new Set(['human', 'ai', 'engine']);

/** The three AI styles, in the order the page shows them. */
export const STYLES = ['silent', 'annotate', 'coach'];

/** Anything unknown is 'annotate', as the program does. */
export function normalizeStyle(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STYLES.includes(v) ? v : 'annotate';
}

const readSeat = v => (SEATS.has(v) ? v : 'human');

/** state.match with every field filled in; a frame without one reads as the analysis board. */
export function readMatch(match) {
  const m = isObject(match) ? match : {};
  const seats = isObject(m.seats) ? m.seats : {};

  return {
    active: m.active === true,
    seats: { white: readSeat(seats.white), black: readSeat(seats.black) },
    tip: Number.isInteger(m.tip) ? m.tip : 0,
    live: m.live === true,
    to_move: SEATS.has(m.to_move) ? m.to_move : null,
    style: normalizeStyle(m.style),
  };
}

/** The parts of a state frame this page reads. */
export function readFrame(frame) {
  const st = isObject(frame) && isObject(frame.state) ? frame.state : {};

  return {
    game: isObject(st.game) ? st.game : null,
    match: readMatch(st.match),
    recent: Array.isArray(st.recent) ? st.recent.filter(isObject) : [],
    boardRev: Number.isInteger(st.board_rev) ? st.board_rev : null,
    gameId: Number.isInteger(st.game_id) ? st.game_id : null,
  };
}

const TAB_KINDS = new Set(['free', 'game', 'reps']);
const TAB_MARKS = new Set(['your_move', 'waiting', 'paused', 'over']);

/** The frame's selected tab and its tab list. */
export function readTabs(frame) {
  const f = isObject(frame) ? frame : {};

  const tabs = (Array.isArray(f.tabs) ? f.tabs : [])
    .filter(t => isObject(t) && typeof t.id === 'string' && t.id)
    .map(t => ({
      id: t.id,
      name: typeof t.name === 'string' ? t.name : t.id,
      kind: TAB_KINDS.has(t.kind) ? t.kind : 'free',
      mark: TAB_MARKS.has(t.mark) ? t.mark : null,
    }));

  return { tab: typeof f.tab === 'string' && f.tab ? f.tab : null, tabs };
}

/** True when the frame is for another tab than the one the page shows. */
export function isTabSwitch(shownTab, frame) {
  return shownTab !== null && readTabs(frame).tab !== shownTab;
}

export function readPresence(msg) {
  const m = isObject(msg) ? msg : {};

  const ais = (Array.isArray(m.ais) ? m.ais : []).filter(isObject).map(a => ({
    name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'An AI',
    transport: typeof a.transport === 'string' ? a.transport : '',
    seat: SIDES.includes(a.seat) ? a.seat : null,
    waiting: a.waiting === true,
    idle_s: Number.isFinite(a.idle_s) ? a.idle_s : 0,
    ...(typeof a.tab === 'string' && a.tab ? { tab: a.tab } : {}),
  }));

  return { views: Number.isInteger(m.views) ? m.views : 0, ais };
}

/** Side to move at snapshot node `id`, or null when the node is not there. */
export function turnAt(snapshot, id) {
  const nodes = isObject(snapshot) && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const n = nodes.find(x => isObject(x) && x.id === id);
  if (!n || typeof n.fen !== 'string') return null;
  return n.fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/** The program's node id at `cursor`, or null; with `fen`, the node must also hold that position. */
export function nodeIdAt(snapshot, cursor, fen) {
  let byId;

  try {
    byId = indexSnapshot(snapshot);
  } catch (_) {
    return null;
  }

  let n = rootOf(snapshot, byId);

  for (const i of cursor || []) {
    const id = Array.isArray(n.children) ? n.children[i] : undefined;
    n = byId.get(id);
    if (!n) return null;
  }

  if (typeof fen === 'string' && n.fen !== fen) return null;
  return n.id;
}

/** The page Game's node at `cursor`, or null. */
export function pageNodeAt(game, cursor) {
  let n = game && game.root;

  for (const i of cursor || []) {
    n = n && Array.isArray(n.children) ? n.children[i] : null;
    if (!n) return null;
  }

  return n || null;
}

export function snapshotNode(snapshot, id) {
  const nodes = isObject(snapshot) && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  return nodes.find(n => isObject(n) && n.id === id) || null;
}

/** The page's "You play" / "Opponent" choice as match seats. */
export function seatsForChoice({ you, opponent } = {}) {
  const me = you === 'black' ? 'black' : 'white';
  const other = me === 'white' ? 'black' : 'white';
  return { [me]: 'human', [other]: opponent === 'ai' ? 'ai' : 'human' };
}

/** Match seats as { you, opponent }; two human seats read as Nobody and keep the fallback side. */
export function choiceFromSeats(seats, fallback = {}) {
  const s = readMatch({ seats }).seats;
  const keepYou = fallback.you === 'black' ? 'black' : 'white';

  if (s.white === 'human' && s.black === 'human') return { you: keepYou, opponent: 'nobody' };
  if (s.white === 'human') return { you: 'white', opponent: s.black };
  if (s.black === 'human') return { you: 'black', opponent: s.white };
  return { you: keepYou, opponent: 'ai' };
}

/** The AI chip's line: { text, state: 'none' | 'connected' | 'waiting' | 'to_move' }. */
export function aiChip(presence, match, snapshot, tab = null) {
  const all = presence && Array.isArray(presence.ais) ? presence.ais : [];
  if (!all.length) return { text: 'No AI connected', state: 'none' };

  // An AI seated on another board is only connected as far as this board is concerned.
  const elsewhere = a => tab !== null && typeof a.tab === 'string' && a.tab !== tab;
  const ais = all.map(a => (elsewhere(a) ? { ...a, seat: null, waiting: false } : a));

  const m = readMatch(match);
  const seated = ais.filter(a => a.seat);
  const lead = (seated.length ? seated : ais).slice().sort((a, b) => (a.idle_s || 0) - (b.idle_s || 0))[0];

  if (m.active && m.live && m.to_move === 'ai') {
    const side = turnAt(snapshot, m.tip);
    const mover = ais.find(a => a.seat && a.seat === side) || lead;
    return { text: `${chipName(mover.name)} to move`, state: 'to_move' };
  }

  const waiting = ais.find(a => a.waiting && a.seat) || ais.find(a => a.waiting);
  if (waiting) return { text: `${chipName(waiting.name)} is waiting for your move`, state: 'waiting' };
  return { text: `${chipName(lead.name)} connected`, state: 'connected' };
}

/** Longest client name the chip shows before an ellipsis. */
export const CHIP_NAME_MAX = 18;

function chipName(name) {
  const chars = Array.from(String(name));
  return chars.length > CHIP_NAME_MAX ? `${chars.slice(0, CHIP_NAME_MAX).join('')}…` : chars.join('');
}

/** The intent that gives program node `nodeId` exactly the annotations of `pageNode`. */
export function annotateIntent(nodeId, pageNode) {
  const n = pageNode || {};

  return {
    op: 'annotate',
    node: nodeId,
    mode: 'replace',
    note: typeof n.note === 'string' ? n.note : '',
    nag: typeof n.nag === 'string' ? n.nag : '',
    arrows: cleanArrows(n.arrows).map(a => ({ from: a.from, to: a.to, color: a.color })),
    highlights: cleanHighlights(n.highlights),
  };
}

export function sameAnnotations(pageNode, snapNode) {
  if (!pageNode || !snapNode) return false;

  const sig = n => treeSignature({ fen: '', note: n.note, nag: n.nag, arrows: cleanArrows(n.arrows), highlights: cleanHighlights(n.highlights), children: [] }, []);
  return sig(pageNode) === sig(snapNode);
}

// Pure: echo guard and outgoing intents

/** Marks this module's own store changes so a frame is never echoed back as an intent. */
export function createEchoGuard() {
  let depth = 0;

  return {
    run(fn) {
      depth++;

      try {
        return fn();
      } finally {
        depth--;
      }
    },

    get active() {
      return depth > 0;
    },
  };
}

/** The intents, without `t` and `id`, a local game change should send. Pure. */
export function intentsForChange(change) {
  const c = change || {};
  if (c.echo) return [];

  const newGame = () => (c.startFen && c.startFen !== INITIAL_FEN ? { op: 'new_game', fen: c.startFen } : { op: 'new_game' });

  if (c.reason === 'move') {
    // A replayed move the program already holds is navigation, except from a running match's tip.
    const fromTip = Number.isInteger(c.tip) && Number.isInteger(c.fromNode) && c.fromNode === c.tip;
    if (Number.isInteger(c.toNode) && !fromTip) return [{ op: 'goto', node: c.toNode }];

    const move = c.move && (c.move.san || c.move.uci);
    if (!move || !c.fromFen) return [];

    const play = { op: 'play', move, from_fen: c.fromFen };
    if (Number.isInteger(c.fromNode)) play.from_node = c.fromNode;
    return [play];
  }

  if (c.reason === 'goto') return Number.isInteger(c.toNode) ? [{ op: 'goto', node: c.toNode }] : [];
  if (c.reason === 'new') return [newGame()];

  // 'setup' fires for every piece placed; only the commit is a new game.
  if (c.reason === 'setup') return c.mode === 'play' ? [newGame()] : [];

  if (c.reason === 'load') {
    const plays = (c.mainline || [])
      .filter(m => m && (m.san || m.uci) && m.fromFen)
      .map(m => ({ op: 'play', move: m.san || m.uci, from_fen: m.fromFen }));

    return [newGame(), ...plays];
  }

  return [];
}

/** Main-line moves of a page Game as [{ san, uci, fromFen }]. */
export function mainlineMoves(game) {
  const line = game.mainline();
  const out = [];
  for (let i = 1; i < line.length; i++) out.push({ san: line[i].san, uci: line[i].uci, fromFen: line[i - 1].fen });
  return out;
}

/** Notice codes that report a repair rather than a loss. */
const REPAIR_NOTICES = new Set(['index_rebuilt', 'added', 'selection_lost', 'fresh_board']);

/** Whether boards are saved, and the program's notices about them; anything unreadable counts as not saved. */
export function readBoards(body) {
  if (!isObject(body)) return { saving: false, notices: [] };

  const notices = (Array.isArray(body.notices) ? body.notices : [])
    .filter(n => isObject(n) && Number.isFinite(n.id) && typeof n.text === 'string' && n.text)
    .map(n => ({ id: n.id, code: typeof n.code === 'string' ? n.code : '', text: n.text }));

  return { saving: body.saving === true, notices };
}

/** The toast kind a notice is shown with. */
export const noticeKind = code => (REPAIR_NOTICES.has(code) ? 'info' : 'error');

// Shell: probe

/** The hello body when the serving host is Rukh, else null; no request unless served over http(s). */
export async function probeRukh({ location, fetch, timeoutMs = PROBE_TIMEOUT_MS, setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout } = {}) {
  if (!location || (location.protocol !== 'http:' && location.protocol !== 'https:')) return null;
  if (typeof fetch !== 'function') return null;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;

  const timer = setT(() => {
    if (controller) controller.abort();
  }, timeoutMs);

  try {
    const res = await fetch(new URL('api/hello', location.href).href, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller ? controller.signal : undefined,
    });

    if (!res || !res.ok) return null;

    const body = await res.json();
    return isObject(body) && body.app === 'rukh' ? body : null;
  } catch (_) {
    return null;
  } finally {
    clearT(timer);
  }
}

// Shell: remote mode

/** Switches off what the program owns by replacing those actions on the shared actions object. */
export function enterRemoteMode({ store, actions, mcp }) {
  const refuse = what => () => {
    actions.toast(`${what} is off while this board is connected to the Rukh program`, 'info');
    return false;
  };

  if (store.state.selfPlay && store.state.selfPlay.on) actions.stopSelfPlay();
  actions.clockReset();

  actions.startSelfPlay = refuse('Self-play');
  actions.clockStart = () => false;
  actions.clockResume = () => false;
  actions.autosave = () => false;

  if (mcp) {
    if (typeof mcp.disable === 'function') mcp.disable();

    const off = refuse('The MCP bridge');

    mcp.enable = () => {
      off();
      return typeof mcp.status === 'function' ? mcp.status() : { enabled: false };
    };
  }
}

/** Connects to api/ws and keeps the page and the program in step. */
export function startRemoteSync(deps) {
  const { store, actions, location } = deps;
  const WS = deps.WebSocket;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const ackTimeoutMs = Number.isFinite(deps.ackTimeoutMs) ? deps.ackTimeoutMs : ACK_TIMEOUT_MS;

  const wsUrl = new URL('api/ws', location.href);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  const guard = createEchoGuard();
  const pending = new Map(); // intent id -> { timer, game, tab }
  let nextId = 1;
  let sock = null;
  let stopped = false;
  let delay = RECONNECT_MIN_MS;
  let reconnectTimer = null;
  let seen = null; // { instance, rev } of the newest frame taken
  let latest = null;
  let shownFen = store.state.game.fen();
  let warnedBadFrame = false;
  let batchRefusal = null; // first refusal among the intents in flight
  let shownTab = null; // the tab whose game the page shows
  let shownFrame = null; // the newest frame for that tab
  const tabMeta = new Map(); // tab id -> the page-only study fields
  const leaving = new Set(); // called before the page leaves a tab
  let boards = readBoards(null);
  let helloInstance = null;
  const shownNotices = new Set(); // "instance:id" of every notice already shown

  const isOpen = () => sock && sock.readyState === 1;
  let presence = null;
  const listeners = new Set();

  function notify() {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch (e) {
        console.warn('[rukh] a listener failed:', e && e.message);
      }
    }
  }

  const latestGame = () => (latest && latest.state && latest.state.game) || null;
  const shownGame = () => (shownFrame && shownFrame.state && shownFrame.state.game) || null;
  const selectedTab = () => readTabs(latest).tab;

  /** Copies the frame's current-node annotations onto the page's current node. */
  function copyCurrentAnnotations(snapshot) {
    const want = snapshotNode(snapshot, snapshot && snapshot.current);
    const node = store.state.game.current;
    if (!want || !node || node.fen !== want.fen || sameAnnotations(node, want)) return false;

    guard.run(() => {
      if ((node.note || '') !== (want.note || '')) actions.setNote(typeof want.note === 'string' ? want.note : '');
      if ((node.nag || '') !== (want.nag || '')) actions.setNag(typeof want.nag === 'string' ? want.nag : '');
      actions.clearAnnotations({ arrows: true, highlights: true });

      const arrows = cleanArrows(want.arrows);
      if (arrows.length) actions.addArrows(arrows);
      actions.setHighlights(cleanHighlights(want.highlights));
    });

    return true;
  }

  function warnBadFrame(e) {
    if (warnedBadFrame) return;

    warnedBadFrame = true;
    console.warn('[rukh] could not show the program\'s game:', e && e.message);

    // A board left following nothing must not look connected.
    actions.toast('This board cannot read the game the Rukh program sent. Reload the page; if that does not help, rebuild the board or update Rukh.', 'error');
  }

  /** True while a game intent made for `tab` waits for its ack. */
  function pendingFor(tab) {
    for (const p of pending.values()) if (p.game && p.tab === tab) return true;
    return false;
  }

  /** Load another tab's game whole, once the old tab's unsaved edits are sent. */
  function switchTo(tab) {
    for (const fn of [...leaving]) {
      try {
        fn();
      } catch (e) {
        console.warn('[rukh] a listener failed:', e && e.message);
      }
    }

    const st = store.state;
    queuedGoto = null;

    tabMeta.set(shownTab, { title: st.study.title, created: st.study.created, notes: st.study.notes });
    shownTab = tab;
    shownFrame = latest;

    const open = new Set(readTabs(latest).tabs.map(t => t.id));
    for (const id of [...tabMeta.keys()]) if (!open.has(id)) tabMeta.delete(id);

    try {
      const study = snapshotToStudy(latestGame(), { ...(tabMeta.get(tab) || {}), orientation: st.orientation });
      guard.run(() => actions.loadStudy(study));
    } catch (e) {
      warnBadFrame(e);
    }
  }

  /** Bring the page to the latest frame, in the gentlest step that gets there. Idempotent. */
  function applyLatest() {
    if (stopped || !latest) return;

    const frameTab = readTabs(latest).tab;
    if (shownTab === null) shownTab = frameTab;
    if (frameTab === shownTab) shownFrame = latest;

    // Never pull someone out of setup mode; its commit goes to the tab it was started on.
    if (store.state.mode !== 'play') return;

    if (isTabSwitch(shownTab, latest)) {
      switchTo(frameTab);
      return;
    }

    // Our own intents in flight: their frames would briefly undo the page. The last ack catches up.
    if (pendingFor(shownTab)) return;

    const snapshot = latest.state && latest.state.game;

    try {
      const target = snapshotSignature(snapshot);
      if (gameSignature(store.state.game) === target) return;

      const ahead = moveAhead(snapshot, store.state.game.fen());

      if (ahead) {
        guard.run(() => actions.playMove(ahead.uci));
        if (gameSignature(store.state.game) === target) return;
      } else {
        // Someone moved through the game: a plain goto keeps the move list.
        const node = pageNodeAt(store.state.game, cursorOf(snapshot));
        const want = snapshotNode(snapshot, snapshot.current);

        if (node && want && node !== store.state.game.current && node.fen === want.fen) {
          guard.run(() => actions.goto(node.id));
          if (gameSignature(store.state.game) === target) return;
        }
      }

      if (copyCurrentAnnotations(snapshot) && gameSignature(store.state.game) === target) return;

      const st = store.state;

      const study = snapshotToStudy(snapshot, {
        title: st.study.title, created: st.study.created, notes: st.study.notes, orientation: st.orientation,
      });

      guard.run(() => actions.loadStudy(study));
    } catch (e) {
      warnBadFrame(e);
    }
  }

  function settle(id) {
    const entry = pending.get(id);
    if (entry === undefined) return;

    clearT(entry.timer);
    pending.delete(id);
  }

  function failAllPending() {
    for (const id of [...pending.keys()]) settle(id);
    batchRefusal = null;
  }

  const NOT_SHARED = 'Not connected to the Rukh program: this change was not shared and will be replaced when it reconnects';

  function showsShownFrame() {
    try {
      return !!shownFrame && gameSignature(store.state.game) === snapshotSignature(shownGame());
    } catch (_) {
      return false;
    }
  }

  /** The last intent in flight settled: show at most one refusal, then catch up. */
  function batchDone() {
    const refusal = batchRefusal;
    batchRefusal = null;

    // A "stale" refusal is noise when the page already holds what the program holds for that tab.
    const noise = refusal && refusal.code === 'stale' && refusal.tab === shownTab && showsShownFrame();

    if (refusal && refusal.code === 'tab_limit') {
      actions.toast(TAB_LIMIT_TEXT, 'error');
    } else if (refusal && !noise) {
      actions.toast(`The Rukh program did not take that: ${refusal.message}`, 'error');
    }

    applyLatest();

    // The play control redraws, so a refused choice does not stay shown.
    notify();
  }

  /** False when the intent could not be sent. */
  function post(intent, entry) {
    if (!isOpen()) return false;

    const id = nextId++;

    try {
      sock.send(JSON.stringify({ t: 'intent', id, ...intent }));
    } catch (_) {
      return false;
    }

    const timer = setT(() => {
      pending.delete(id);
      if (!pending.size) batchDone();
    }, ackTimeoutMs);

    pending.set(id, { timer, ...entry });
    return true;
  }

  /** A game intent, stamped with the tab it was made for. */
  const sendGame = (intent, tab) => post(tab === null ? intent : { ...intent, tab }, { game: true, tab });

  /** A tab intent, which names its own tab. */
  const sendTab = intent => post(intent, { game: false, tab: null });

  function onAck(msg) {
    const entry = pending.get(msg.id);
    if (!entry) return;

    settle(msg.id);

    if (!msg.ok && !batchRefusal) {
      const error = isObject(msg.error) ? msg.error : {};
      const message = typeof error.message === 'string' && error.message ? error.message : 'refused';
      batchRefusal = { code: error.code, message, tab: entry.game ? entry.tab : null };
    }

    // Accepted with parts left out: say why, or the edit just disappears on the next frame.
    const rejected = msg.ok && isObject(msg.result) && Array.isArray(msg.result.rejected) ? msg.result.rejected : [];

    if (rejected.length && !batchRefusal) {
      const first = isObject(rejected[0]) && typeof rejected[0].reason === 'string' ? rejected[0].reason : 'not accepted';
      batchRefusal = { code: 'rejected', message: rejected.length > 1 ? `${first} (and ${rejected.length - 1} more)` : first, tab: entry.tab };
    }

    // Ok or not, the program's latest frame is the truth.
    if (!pending.size) batchDone();
  }

  /** Each notice is shown once per page load; a new program start numbers its notices from 1 again. */
  function takeBoards(body) {
    boards = readBoards(body);

    for (const notice of boards.notices) {
      const key = `${helloInstance}:${notice.id}`;
      if (shownNotices.has(key)) continue;

      shownNotices.add(key);
      actions.toast(notice.text, noticeKind(notice.code));
    }

    notify();
  }

  function onMessage(raw) {
    let msg;

    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch (_) {
      return;
    }

    if (!isObject(msg)) return;

    if (msg.t === 'hello') {
      if (msg.proto !== PROTO) {
        actions.toast(`The Rukh program speaks protocol ${msg.proto}; this page speaks ${PROTO}. Rebuild the board.`, 'error');
        stop();
        return;
      }

      helloInstance = typeof msg.instance === 'string' ? msg.instance : null;
      takeBoards(msg.boards);
      return;
    }

    if (msg.t === 'boards') {
      takeBoards(msg);
      return;
    }

    if (msg.t === 'state') {
      if (!isNewerFrame(seen, msg)) return;

      seen = { instance: msg.instance, rev: msg.rev };
      latest = msg;
      applyLatest();
      notify();
      return;
    }

    if (msg.t === 'presence') {
      presence = readPresence(msg);
      notify();
      return;
    }

    if (msg.t === 'ack') onAck(msg);
  }

  function onGameChange({ reason } = {}) {
    const game = store.state.game;
    const fromFen = shownFen;
    shownFen = game.fen();
    if (stopped) return;

    const echo = guard.active;
    const tab = shownTab;

    // Node ids are the program's: the page cursor is looked up in the latest frame, FEN-checked.
    const cursor = !echo && (reason === 'move' || reason === 'goto') ? game.cursor() : null;

    const intents = intentsForChange({
      reason,
      echo,
      mode: store.state.mode,
      fromFen,
      move: reason === 'move' ? { san: game.current.san, uci: game.current.uci } : null,
      startFen: game.startFen,
      mainline: reason === 'load' ? mainlineMoves(game) : null,
      fromNode: reason === 'move' && cursor ? nodeIdAt(shownGame(), cursor.slice(0, -1), fromFen) : null,
      toNode: cursor ? nodeIdAt(shownGame(), cursor, game.fen()) : null,
      tip: (() => {
        const m = readMatch(shownFrame && shownFrame.state && shownFrame.state.match);
        return m.active ? m.tip : null;
      })(),
    });

    if (!intents.length) return;

    if (reason === 'goto') {
      // Navigation made in one go is sent once, as the node the page ends on.
      queueGoto(intents[0].node, tab);
      return;
    }

    if (reason === 'move' && intents[0].op === 'goto') {
      queuedGoto = { node: intents[0].node, tab };
      flushGoto(true);
      return;
    }

    // Anything else is played where the page now is, so waiting navigation goes first.
    if (!flushGoto(false)) return;

    if (reason === 'load' && intents.length > 1) {
      actions.toast('Only the main line is shared with the Rukh program in this build; variations and notes of the loaded game are not kept', 'info');
    }

    for (const intent of intents) {
      if (!sendGame(intent, tab)) {
        actions.toast(NOT_SHARED, 'error');
        if (!pending.size) applyLatest();
        return;
      }
    }
  }

  let queuedGoto = null; // { node, tab }
  let gotoScheduled = false;

  function queueGoto(node, tab) {
    queuedGoto = { node, tab };
    if (gotoScheduled) return;

    gotoScheduled = true;

    Promise.resolve().then(() => {
      gotoScheduled = false;
      flushGoto(false);
    });
  }

  /** Send the queued goto; unless `always`, skip it when the program already shows that node. */
  function flushGoto(always) {
    const queued = queuedGoto;
    queuedGoto = null;
    if (queued === null || stopped) return true;

    // Navigation queued on a tab the page has left is dropped.
    if (queued.tab !== shownTab) return true;

    const snapshot = shownGame();
    if (!always && !pendingFor(queued.tab) && snapshot && snapshot.current === queued.node) return true;
    if (sendGame({ op: 'goto', node: queued.node }, queued.tab)) return true;

    actions.toast(NOT_SHARED, 'error');
    if (!pending.size) applyLatest();
    return false;
  }

  /** An annotation edited here: send the shown node's annotations as they now are. */
  function onAnnotations() {
    if (stopped || guard.active || store.state.mode !== 'play') return;

    const game = store.state.game;
    const snapshot = shownGame();
    const id = nodeIdAt(snapshot, game.cursor(), game.fen());

    // A node the program does not hold yet: the next frame decides.
    if (id === null) return;
    if (sameAnnotations(game.current, snapshotNode(snapshot, id))) return;

    if (!sendGame(annotateIntent(id, game.current), shownTab)) {
      actions.toast(NOT_SHARED, 'error');
      if (!pending.size) applyLatest();
    }
  }

  function notConnected() {
    actions.toast('Not connected to the Rukh program', 'error');
    return false;
  }

  /** A match control: it acts on the selected tab, whose match the play control shows. */
  const sendControl = intent => (!stopped && sendGame(intent, selectedTab())) || notConnected();

  const sendTabControl = intent => (!stopped && sendTab(intent)) || notConnected();

  function connect() {
    if (stopped) return;

    let ws;

    try {
      ws = new WS(wsUrl.href);
    } catch (_) {
      scheduleReconnect();
      return;
    }

    sock = ws;

    ws.onopen = () => {
      if (ws !== sock) return;

      delay = RECONNECT_MIN_MS;
      seen = null; // after a reconnect, the first frame is taken
      notify();
    };

    ws.onmessage = ev => {
      if (ws === sock) onMessage(ev.data);
    };

    ws.onerror = () => {}; // a close event follows

    ws.onclose = () => {
      if (ws !== sock) return;

      sock = null;
      failAllPending(); // intents in flight are never resent
      presence = null;
      notify();
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;

    reconnectTimer = setT(() => {
      reconnectTimer = null;
      connect();
    }, delay);

    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  }

  const unsubs = [
    store.on('game:change', onGameChange),
    store.on('annotations:change', onAnnotations),

    // Deferred so a setup commit's own game:change is handled first.
    store.on('mode:change', ({ mode } = {}) => {
      if (mode === 'play') setT(() => applyLatest(), 0);
    }),
  ];

  function stop() {
    if (stopped) return;

    stopped = true;
    for (const u of unsubs) u();
    if (reconnectTimer) clearT(reconnectTimer);
    reconnectTimer = null;
    failAllPending();

    // One last call, so the play control can show it no longer reaches the program.
    notify();
    listeners.clear();
    leaving.clear();

    const ws = sock;
    sock = null;

    if (ws) {
      try {
        ws.close();
      } catch (_) {}
    }
  }

  connect();

  return {
    stop,
    status: () => ({ connected: isOpen(), instance: seen && seen.instance, rev: seen && seen.rev, pending: pending.size }),
    match: () => readMatch(latest && latest.state && latest.state.match),
    snapshot: latestGame,
    state: () => (latest && isObject(latest.state) ? latest.state : null),
    presence: () => presence,

    /** Whether the program saves boards, and its notices about them. */
    boards: () => ({ saving: boards.saving, notices: boards.notices.slice() }),

    /** The selected tab and the list the strip draws. */
    tabs: () => readTabs(latest),

    /** The tab whose game the page shows; in setup, the tab setup began on. */
    shownTab: () => shownTab,

    selectTab: id => sendTabControl({ op: 'tab_select', tab: id }),
    newTab: () => sendTabControl({ op: 'tab_new', name: null, copy_of: null }),
    renameTab: (id, name) => sendTabControl({ op: 'tab_rename', tab: id, name: String(name) }),
    closeTab: id => sendTabControl({ op: 'tab_close', tab: id }),

    /** Calls fn just before the page leaves a tab, while the old tab is still shown. */
    beforeSwitch(fn) {
      if (typeof fn !== 'function') return () => {};

      leaving.add(fn);
      return () => leaving.delete(fn);
    },
    connected: () => !!isOpen(),

    /** True once the page has stopped following the program for good. */
    stopped: () => stopped,

    /** Calls fn after every new frame, presence message and connection change. */
    onChange(fn) {
      if (typeof fn !== 'function') return () => {};

      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Without a style the match keeps the current one. */
    startMatch: (seats, style) => {
      const intent = { op: 'match_start', seats: readMatch({ seats }).seats };
      if (style !== undefined) intent.style = normalizeStyle(style);
      return sendControl(intent);
    },

    stopMatch: () => sendControl({ op: 'match_stop' }),

    setSeats: seats => {
      const s = readMatch({ seats }).seats;
      return sendControl({ op: 'set_seats', white: s.white, black: s.black });
    },

    setStyle: style => sendControl({ op: 'set_style', style: normalizeStyle(style) }),

    /** Every view returns to the end of the game being played. */
    gotoTip: () => sendControl({ op: 'goto', node: readMatch(latest && latest.state && latest.state.match).tip }),
  };
}

/** Probe, and only when the program answers, switch to remote mode and connect. Never rejects. */
export async function connectRemoteSync({ store, actions, mcp, location = globalThis.location, fetch = globalThis.fetch, WebSocket = globalThis.WebSocket } = {}) {
  try {
    const hello = await probeRukh({ location, fetch: typeof fetch === 'function' ? fetch.bind(globalThis) : null });
    if (!hello || typeof WebSocket !== 'function') return null;

    enterRemoteMode({ store, actions, mcp });
    return startRemoteSync({ store, actions, location, WebSocket });
  } catch (e) {
    console.warn('[rukh] could not connect to the program:', e && e.message);
    return null;
  }
}
