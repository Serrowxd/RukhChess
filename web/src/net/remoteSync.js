// net/remoteSync.js - keeps this page in step with the Rukh program when the page is served by it.
//
// Temporary (build steps 1 and 2): the page keeps its own JS game, and this file mirrors the program's game into
// it and sends the moves, navigation and annotation edits made here to the program. It also carries the match
// (seats, style) and presence for the play control. A later step replaces it with a real backend.
//
// Active only when GET api/hello answers as Rukh. Opened from a file or a plain static host, the page is
// exactly as before: on file:// nothing is fetched at all, elsewhere one probe is made and nothing follows.
//
// The file has two halves:
//   - pure functions (snapshot -> study, "is this frame one move ahead", tree signatures, the echo guard,
//     which intents a local change produces, reading the frame body and presence, the AI chip's text, seats
//     for the play control), tested with node --test;
//   - a thin connection shell (probe, WebSocket, reconnect, acks) that needs a browser or a fake server.
//
// Wire format (JSON text on api/ws):
//   server -> page  {"t":"hello","proto":1,"instance":"..","you":"view:3"}
//                   {"t":"state","instance":"..","rev":7,"hint":{..},"state":{"game_id","board_rev","recent",
//                     "game":<rukh_core::Snapshot>,"study","match":{active,seats,tip,live,to_move,style},"clock"}}
//                   {"t":"ack","id":4,"ok":true,"rev":7} | {"t":"ack","id":4,"ok":false,"error":{"code","message"}}
//                   {"t":"presence","views":2,"ais":[{"name","transport","seat","waiting","idle_s"}]}
//   page -> server  {"t":"intent","id":4,"op":"play","move":"Nf3","from_node":11,"from_fen":".."}
//                   {"t":"intent","id":5,"op":"goto","node":3}
//                   {"t":"intent","id":6,"op":"annotate","node":3,"mode":"replace","note","nag","arrows","highlights"}
//                   {"t":"intent","id":7,"op":"new_game","fen":"<optional>"}
//                   {"t":"intent","id":8,"op":"match_start","seats":{"white","black"},"style":".."}
//                   {"t":"intent","id":9,"op":"match_stop"} | {"op":"set_seats","white","black"} | {"op":"set_style","style"}
// from_fen is still sent beside from_node; the program ignores it.

/** Protocol version this page speaks. */
export const PROTO = 1;

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PROBE_TIMEOUT_MS = 1500;
const ACK_TIMEOUT_MS = 5000;
const RECONNECT_MIN_MS = 250;
// A program that was closed is retried at most this often; a restart is still picked up within that time.
const RECONNECT_MAX_MS = 15000;

// ───────────────────────── pure: snapshot -> study ─────────────────────────

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Map of node id -> node for a snapshot. Throws with a readable reason when the snapshot is not usable. */
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

/** Child indexes from the root to the snapshot's current node (the page's `cursor`). */
export function cursorOf(snapshot, byId = indexSnapshot(snapshot)) {
  let path = Array.isArray(snapshot.path) ? snapshot.path : [];
  // A path that is missing or does not end at the current node is rebuilt from the parent links.
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

/**
 * A rukh_core::Snapshot -> the page's study object, as accepted by actions.loadStudy (core/io.js
 * studyFromJSON): moves, variations (children order kept), notes, glyphs, arrows, highlights, stored
 * evaluations and the current node (as a cursor). `meta` carries what the snapshot does not hold and the
 * page wants to keep: { title, created, notes, orientation }.
 */
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
  // Iterative, so a very long game cannot overflow the stack; `seen` stops a malformed tree from looping.
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

// ───────────────────────── pure: comparing what is shown ─────────────────────────

/**
 * If the snapshot's current node is one move past a position whose FEN equals `shownFen`, the move to
 * play to get there: { uci, san }. Otherwise null. This is what lets a move from elsewhere animate.
 */
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

/**
 * A string that is equal for two trees exactly when they show the same thing: the same positions in the same
 * order, the same notes, glyphs, arrows and highlights, and the same current node. Positions are compared by
 * FEN rather than UCI because the page and the program spell Chess960 castling differently. Evaluations are
 * left out: the page's own engine writes them and they must not force a reload.
 * `tree` is the page's Game.toJSON().tree shape (or snapshotToStudy(..).game.tree). `variant` is included so a
 * Chess960 game whose start is the standard array (number 518) does not pass for the program's standard game.
 */
export function treeSignature(tree, cursor, variant = 'standard') {
  const parts = [];
  const stack = [tree];
  while (stack.length) {
    const n = stack.pop();
    if (n === ')') { parts.push(')'); continue; }
    const arrows = (n.arrows || []).map(a => `${a.from}${a.to}:${a.color}`).join(',');
    const highlights = (n.highlights || []).map(h => `${h.square}:${h.color}`).join(',');
    parts.push(`(${n.fen}|${n.note || ''}|${n.nag || ''}|${arrows}|${highlights}`);
    stack.push(')');
    const kids = n.children || [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return `${variant === 'chess960' ? 'chess960' : 'standard'}@${(cursor || []).join('.')}#${parts.join('')}`;
}

/** Signature of a snapshot, comparable with gameSignature(). */
export function snapshotSignature(snapshot) {
  const st = snapshotToStudy(snapshot);
  return treeSignature(st.game.tree, st.cursor, st.game.variant);
}

/** Signature of the page's Game (core/game.js), comparable with snapshotSignature(). */
export function gameSignature(game) {
  return treeSignature(game.toJSON().tree, game.cursor(), game.variant);
}

/** True when `frame` should replace what was last seen: another program start, or a higher rev. */
export function isNewerFrame(seen, frame) {
  if (!isObject(frame) || typeof frame.rev !== 'number') return false;
  if (!seen) return true;
  return frame.instance !== seen.instance || frame.rev > seen.rev;
}

// ───────────────────────── pure: the frame body, match and presence ─────────────────────────

const SIDES = ['white', 'black'];
const SEATS = new Set(['human', 'ai', 'engine']);
/** The three AI styles, in the order the page shows them. */
export const STYLES = ['silent', 'annotate', 'coach'];

/** Any value -> one of STYLES; anything unknown is 'annotate', as the program does. */
export function normalizeStyle(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return STYLES.includes(v) ? v : 'annotate';
}

const readSeat = v => (SEATS.has(v) ? v : 'human');

/** state.match of a frame with every field filled in. A frame without one reads as the analysis board. */
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

/** The parts of a state frame this page reads: { game, match, recent, boardRev, gameId }. */
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

/** A presence message -> { views, ais: [{ name, transport, seat, waiting, idle_s }] }. */
export function readPresence(msg) {
  const m = isObject(msg) ? msg : {};
  const ais = (Array.isArray(m.ais) ? m.ais : []).filter(isObject).map(a => ({
    name: typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'An AI',
    transport: typeof a.transport === 'string' ? a.transport : '',
    seat: SIDES.includes(a.seat) ? a.seat : null,
    waiting: a.waiting === true,
    idle_s: Number.isFinite(a.idle_s) ? a.idle_s : 0,
  }));
  return { views: Number.isInteger(m.views) ? m.views : 0, ais };
}

/** Side to move at node `id` of a snapshot ('white' | 'black'), or null when the node is not there. */
export function turnAt(snapshot, id) {
  const nodes = isObject(snapshot) && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  const n = nodes.find(x => isObject(x) && x.id === id);
  if (!n || typeof n.fen !== 'string') return null;
  return n.fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

/**
 * The program's node id at `cursor` (child indexes from the root) of a snapshot, or null. When `fen` is given,
 * the node must also hold that position, so a page whose tree differs from the program's never names a wrong node.
 */
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

/** The page Game's node at `cursor` (child indexes from the root), or null when the page has no such node. */
export function pageNodeAt(game, cursor) {
  let n = game && game.root;
  for (const i of cursor || []) {
    n = n && Array.isArray(n.children) ? n.children[i] : null;
    if (!n) return null;
  }
  return n || null;
}

/** The node of a snapshot with this id, or null. */
export function snapshotNode(snapshot, id) {
  const nodes = isObject(snapshot) && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
  return nodes.find(n => isObject(n) && n.id === id) || null;
}

/** "You play" / "Opponent" as chosen on the page -> match seats. opponent: 'nobody' | 'ai'. */
export function seatsForChoice({ you, opponent } = {}) {
  const me = you === 'black' ? 'black' : 'white';
  const other = me === 'white' ? 'black' : 'white';
  return { [me]: 'human', [other]: opponent === 'ai' ? 'ai' : 'human' };
}

/**
 * Match seats -> { you, opponent } for the play control. Both seats human reads as Nobody and keeps the side
 * from `fallback`; one human seat is the person's side.
 */
export function choiceFromSeats(seats, fallback = {}) {
  const s = readMatch({ seats }).seats;
  const keepYou = fallback.you === 'black' ? 'black' : 'white';
  if (s.white === 'human' && s.black === 'human') return { you: keepYou, opponent: 'nobody' };
  if (s.white === 'human') return { you: 'white', opponent: s.black };
  if (s.black === 'human') return { you: 'black', opponent: s.white };
  return { you: keepYou, opponent: 'ai' };
}

/**
 * The one line the AI chip shows, from the latest presence message, the match and the game snapshot:
 * { text, state: 'none' | 'connected' | 'waiting' | 'to_move' }.
 */
export function aiChip(presence, match, snapshot) {
  const ais = presence && Array.isArray(presence.ais) ? presence.ais : [];
  if (!ais.length) return { text: 'No AI connected', state: 'none' };
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

/** Longest client name the chip shows before cutting it with an ellipsis. */
export const CHIP_NAME_MAX = 18;

function chipName(name) {
  const chars = Array.from(String(name));
  return chars.length > CHIP_NAME_MAX ? `${chars.slice(0, CHIP_NAME_MAX).join('')}…` : chars.join('');
}

/** The intent that makes the program's node `nodeId` carry exactly the note, glyph and drawings of `pageNode`. */
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

/** True when a page node and a snapshot node show the same note, glyph, arrows and highlights. */
export function sameAnnotations(pageNode, snapNode) {
  if (!pageNode || !snapNode) return false;
  const sig = n => treeSignature({ fen: '', note: n.note, nag: n.nag, arrows: cleanArrows(n.arrows), highlights: cleanHighlights(n.highlights), children: [] }, []);
  return sig(pageNode) === sig(snapNode);
}

// ───────────────────────── pure: echo guard and outgoing intents ─────────────────────────

/**
 * Marks the store changes this module makes itself, so that applying a frame is never sent back to the
 * program as a new intent (and two tabs cannot ping-pong). Store events fire synchronously inside the
 * action, so a depth counter around the call is enough.
 */
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

/**
 * The intents (without `t` and `id`) a local game change should send. Pure.
 * change: {
 *   reason,          store game:change reason ('move' | 'new' | 'load' | 'setup' | 'goto' | 'note' | ...)
 *   echo,            true when this module caused the change (then nothing is sent)
 *   mode,            store.state.mode after the change
 *   fromFen,         the FEN the page showed before the change
 *   move,            for 'move': { san, uci }
 *   startFen,        the game's start FEN
 *   mainline,        for 'load': [{ san, uci, fromFen }] along the main line
 *   fromNode,        for 'move': the program's id of the node the move was played from, when known
 *   toNode,          for 'goto' and 'move': the program's id of the node the page now shows, when the program
 *                    holds it
 *   tip,             the match's tip when a match is active, else null
 * }
 * Navigation is shared as one goto to the node now shown, so back, forward, start, end and a click in the move
 * list all land on the same node in every view. Notes and drawings go through annotateIntent, not through here.
 * Variation edits (promote, delete) are not shared in this step; the program's next frame replaces them.
 */
export function intentsForChange(change) {
  const c = change || {};
  if (c.echo) return [];
  const newGame = () => (c.startFen && c.startFen !== INITIAL_FEN ? { op: 'new_game', fen: c.startFen } : { op: 'new_game' });
  if (c.reason === 'move') {
    // The program already holds the node the move leads to (a move stepped back over and played again): the
    // page only moved through the game. Except from the tip of a running match: there the move is a move in
    // the game and must move the tip, which only a play does (the program reuses the node it already has).
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
  // 'setup' also fires for every piece placed while still in setup mode; only the commit is a new game.
  if (c.reason === 'setup') return c.mode === 'play' ? [newGame()] : [];
  if (c.reason === 'load') {
    const plays = (c.mainline || [])
      .filter(m => m && (m.san || m.uci) && m.fromFen)
      .map(m => ({ op: 'play', move: m.san || m.uci, from_fen: m.fromFen }));
    return [newGame(), ...plays];
  }
  return [];
}

/** Main-line moves of a page Game as [{ san, uci, fromFen }], for sharing a loaded game move by move. */
export function mainlineMoves(game) {
  const line = game.mainline();
  const out = [];
  for (let i = 1; i < line.length; i++) out.push({ san: line[i].san, uci: line[i].uci, fromFen: line[i - 1].fen });
  return out;
}

// ───────────────────────── shell: probe ─────────────────────────

/**
 * Asks the server that served this page whether it is Rukh. Resolves to the hello body or null; never throws.
 * Makes no request at all unless the page came over http(s).
 */
export async function probeRukh({ location, fetch, timeoutMs = PROBE_TIMEOUT_MS, setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout } = {}) {
  if (!location || (location.protocol !== 'http:' && location.protocol !== 'https:')) return null;
  if (typeof fetch !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setT(() => { if (controller) controller.abort(); }, timeoutMs);
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

// ───────────────────────── shell: remote mode ─────────────────────────

/**
 * Switches off what the program owns in remote mode: the study autosave, self-play, the clock and the old
 * loopback bridge (ai/mcpBridge.js). The store has no switch for these, so the actions are replaced on the
 * shared actions object; every caller (UI, window.chess) looks them up at call time.
 */
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
    mcp.enable = () => { off(); return typeof mcp.status === 'function' ? mcp.status() : { enabled: false }; };
  }
}

/**
 * Connects to api/ws and keeps the page and the program in step. Returns { stop, status }.
 * deps: { store, actions, location, WebSocket, setTimeout?, clearTimeout?, ackTimeoutMs? }
 */
export function startRemoteSync(deps) {
  const { store, actions, location } = deps;
  const WS = deps.WebSocket;
  const setT = deps.setTimeout || setTimeout;
  const clearT = deps.clearTimeout || clearTimeout;
  const ackTimeoutMs = Number.isFinite(deps.ackTimeoutMs) ? deps.ackTimeoutMs : ACK_TIMEOUT_MS;
  const wsUrl = new URL('api/ws', location.href);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  const guard = createEchoGuard();
  const pending = new Map();     // intent id -> ack timer
  let nextId = 1;
  let sock = null;
  let stopped = false;
  let delay = RECONNECT_MIN_MS;
  let reconnectTimer = null;
  let seen = null;               // { instance, rev } of the newest frame taken
  let latest = null;             // that frame
  let shownFen = store.state.game.fen();
  let warnedBadFrame = false;
  let batchRefusal = null;       // the first refusal among the intents now in flight, shown once they settle

  const isOpen = () => sock && sock.readyState === 1;
  let presence = null;           // the latest presence message, read; null until one arrives
  const listeners = new Set();   // called after a new frame, presence or a connection change

  function notify() {
    for (const fn of [...listeners]) {
      try { fn(); } catch (e) { console.warn('[rukh] a listener failed:', e && e.message); }
    }
  }

  const latestGame = () => (latest && latest.state && latest.state.game) || null;

  /** Copies the note, glyph and drawings of the frame's current node onto the page's current node. */
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

  /** Bring the page to the latest frame. Idempotent: a page already showing it is left alone. */
  function applyLatest() {
    if (stopped || !latest) return;
    // Our own intents are still in flight: their frames would briefly undo what the page shows. The ack
    // of the last one comes after its frame, so the page catches up then.
    if (pending.size) return;
    // Never pull someone out of setup mode; catch up when they leave it.
    if (store.state.mode !== 'play') return;
    const snapshot = latest.state && latest.state.game;
    try {
      const target = snapshotSignature(snapshot);
      if (gameSignature(store.state.game) === target) return;
      const ahead = moveAhead(snapshot, store.state.game.fen());
      if (ahead) {
        guard.run(() => actions.playMove(ahead.uci));
        if (gameSignature(store.state.game) === target) return;
      } else {
        // Someone moved through the game (another view or an AI): follow with a plain goto when the page
        // holds that node, so the move list is not rebuilt.
        const node = pageNodeAt(store.state.game, cursorOf(snapshot));
        const want = snapshotNode(snapshot, snapshot.current);
        if (node && want && node !== store.state.game.current && node.fen === want.fen) {
          guard.run(() => actions.goto(node.id));
          if (gameSignature(store.state.game) === target) return;
        }
      }
      // Only the shown move's note, glyph or drawings differ (an AI annotated it, or a move came with a note):
      // copy them over in place.
      if (copyCurrentAnnotations(snapshot) && gameSignature(store.state.game) === target) return;
      const st = store.state;
      const study = snapshotToStudy(snapshot, {
        title: st.study.title, created: st.study.created, notes: st.study.notes, orientation: st.orientation,
      });
      guard.run(() => actions.loadStudy(study));
    } catch (e) {
      if (!warnedBadFrame) {
        warnedBadFrame = true;
        console.warn('[rukh] could not show the program\'s game:', e && e.message);
        // Said once on the page too: a board left following nothing must not look connected.
        actions.toast('This board cannot read the game the Rukh program sent. Reload the page; if that does not help, rebuild the board or update Rukh.', 'error');
      }
    }
  }

  function settle(id) {
    const timer = pending.get(id);
    if (timer === undefined) return;
    clearT(timer);
    pending.delete(id);
  }

  function failAllPending() {
    for (const id of [...pending.keys()]) settle(id);
    batchRefusal = null;
  }

  const NOT_SHARED = 'Not connected to the Rukh program: this change was not shared and will be replaced when it reconnects';

  /** True when the page already shows exactly the latest frame. */
  function showsLatest() {
    try {
      return !!latest && gameSignature(store.state.game) === snapshotSignature(latest.state && latest.state.game);
    } catch (_) {
      return false;
    }
  }

  /**
   * Called when the last intent in flight has settled: shows at most one refusal for the whole batch, then brings
   * the page to the latest frame. A "stale" refusal is not shown when the page already holds exactly what the
   * program holds (for example after stepping back and replaying the move the program is already on).
   */
  function batchDone() {
    const refusal = batchRefusal;
    batchRefusal = null;
    if (refusal && !(refusal.code === 'stale' && showsLatest())) {
      actions.toast(`The Rukh program did not take that: ${refusal.message}`, 'error');
    }
    applyLatest();
    // The play control redraws from the program's state, so a refused choice does not stay shown.
    notify();
  }

  /** Sends one intent. False when it could not be sent (the caller tells the person once). */
  function send(intent) {
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
    pending.set(id, timer);
    return true;
  }

  function onAck(msg) {
    if (!pending.has(msg.id)) return;
    settle(msg.id);
    if (!msg.ok && !batchRefusal) {
      const error = isObject(msg.error) ? msg.error : {};
      batchRefusal = { code: error.code, message: typeof error.message === 'string' && error.message ? error.message : 'refused' };
    }
    // Accepted, but some of a note or drawing was left out (too long, too many arrows): say why, or the
    // person's edit just disappears when the program's node is copied back.
    const rejected = msg.ok && isObject(msg.result) && Array.isArray(msg.result.rejected) ? msg.result.rejected : [];
    if (rejected.length && !batchRefusal) {
      const first = isObject(rejected[0]) && typeof rejected[0].reason === 'string' ? rejected[0].reason : 'not accepted';
      batchRefusal = { code: 'rejected', message: rejected.length > 1 ? `${first} (and ${rejected.length - 1} more)` : first };
    }
    // Ok or not, the program's latest frame is the truth (a refusal reloads the page from it).
    if (!pending.size) batchDone();
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
      }
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
    // Node ids are the program's: the page's cursor (child indexes) is looked up in the latest frame, and the
    // FEN must match, so a page whose tree has drifted names no node at all rather than a wrong one.
    const cursor = !echo && (reason === 'move' || reason === 'goto') ? game.cursor() : null;
    const intents = intentsForChange({
      reason,
      echo,
      mode: store.state.mode,
      fromFen,
      move: reason === 'move' ? { san: game.current.san, uci: game.current.uci } : null,
      startFen: game.startFen,
      mainline: reason === 'load' ? mainlineMoves(game) : null,
      fromNode: reason === 'move' && cursor ? nodeIdAt(latestGame(), cursor.slice(0, -1), fromFen) : null,
      // Also for a move: one the program already holds (stepping back and replaying it) is navigation.
      toNode: cursor ? nodeIdAt(latestGame(), cursor, game.fen()) : null,
      tip: (() => {
        const m = readMatch(latest && latest.state && latest.state.match);
        return m.active ? m.tip : null;
      })(),
    });
    if (!intents.length) return;
    if (reason === 'goto') {
      // Navigation made in one go (a script, or a note saved on another move and the cursor put back) is sent
      // once, as the node the page ends on.
      queueGoto(intents[0].node);
      return;
    }
    if (reason === 'move' && intents[0].op === 'goto') {
      queuedGoto = intents[0].node;
      flushGoto(true);
      return;
    }
    // Anything else is played where the page now is, so navigation still waiting goes first.
    if (!flushGoto(false)) return;
    if (reason === 'load' && intents.length > 1) {
      actions.toast('Only the main line is shared with the Rukh program in this build; variations and notes of the loaded game are not kept', 'info');
    }
    for (const intent of intents) {
      if (!send(intent)) {
        actions.toast(NOT_SHARED, 'error');
        // Nothing more of this change can reach the program; show what it holds once nothing is in flight.
        if (!pending.size) applyLatest();
        return;
      }
    }
  }

  let queuedGoto = null;         // the program node the page navigated to, not sent yet
  let gotoScheduled = false;

  function queueGoto(id) {
    queuedGoto = id;
    if (gotoScheduled) return;
    gotoScheduled = true;
    Promise.resolve().then(() => {
      gotoScheduled = false;
      flushGoto(false);
    });
  }

  /**
   * Sends the queued goto, if any. Unless `always`, it is skipped when the program already shows that node and
   * nothing of ours is in flight (the page went somewhere and came back). False when it could not be sent.
   */
  function flushGoto(always) {
    const id = queuedGoto;
    queuedGoto = null;
    if (id === null || stopped) return true;
    const snapshot = latestGame();
    if (!always && !pending.size && snapshot && snapshot.current === id) return true;
    if (send({ op: 'goto', node: id })) return true;
    actions.toast(NOT_SHARED, 'error');
    if (!pending.size) applyLatest();
    return false;
  }

  /** A note, glyph, arrow or highlight edited on this page: send the shown node's annotations as they now are. */
  function onAnnotations() {
    if (stopped || guard.active || store.state.mode !== 'play') return;
    const game = store.state.game;
    const snapshot = latestGame();
    const id = nodeIdAt(snapshot, game.cursor(), game.fen());
    // A node the program does not hold yet (a move still in flight): the next frame decides what is shown.
    if (id === null) return;
    if (sameAnnotations(game.current, snapshotNode(snapshot, id))) return;
    if (!send(annotateIntent(id, game.current))) {
      actions.toast(NOT_SHARED, 'error');
      if (!pending.size) applyLatest();
    }
  }

  /** Sends an intent the play control asked for. False (and one message) when the program cannot be reached. */
  function sendControl(intent) {
    if (!stopped && send(intent)) return true;
    actions.toast('Not connected to the Rukh program', 'error');
    return false;
  }

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
      // After a reconnect, whatever frame arrives first is taken.
      seen = null;
      notify();
    };
    ws.onmessage = ev => { if (ws === sock) onMessage(ev.data); };
    ws.onerror = () => { /* a close event follows; reconnecting happens there */ };
    ws.onclose = () => {
      if (ws !== sock) return;
      sock = null;
      // Intents in flight are never resent; the next frame decides what the page shows.
      failAllPending();
      // Who is connected is unknown until the program says so again.
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
    // Leaving setup (commit or cancel) may have a frame waiting. Deferred so a commit's own game:change,
    // which fires right after mode:change, is handled first.
    store.on('mode:change', ({ mode } = {}) => { if (mode === 'play') setT(() => applyLatest(), 0); }),
  ];

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const u of unsubs) u();
    if (reconnectTimer) clearT(reconnectTimer);
    reconnectTimer = null;
    failAllPending();
    // One last call, so the play control can show that it no longer reaches the program.
    notify();
    listeners.clear();
    const ws = sock;
    sock = null;
    if (ws) {
      try { ws.close(); } catch (_) { /* already closed */ }
    }
  }

  connect();
  return {
    stop,
    status: () => ({ connected: isOpen(), instance: seen && seen.instance, rev: seen && seen.rev, pending: pending.size }),
    /** state.match of the latest frame, every field filled in. */
    match: () => readMatch(latest && latest.state && latest.state.match),
    /** The latest frame's game snapshot, or null before the first frame. */
    snapshot: latestGame,
    /** The latest presence message ({ views, ais }), or null when none has arrived on this connection. */
    presence: () => presence,
    connected: () => !!isOpen(),
    /** True once the page has stopped following the program for good (a protocol mismatch). */
    stopped: () => stopped,
    /** Calls fn after every new frame, presence message and connection change. Returns an unsubscribe. */
    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Without a style the match keeps the current one (a set_style sent before it is applied first). */
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

/**
 * Entry point for main.js: probe, and only when the program answers, switch to remote mode and connect.
 * Resolves to the controller from startRemoteSync, or null when the page is on its own. Never rejects.
 */
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
