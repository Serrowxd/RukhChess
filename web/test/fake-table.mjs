// A small stand-in for the program's table, for testing the page's remote mode (see docs/testing.md).
import { Game } from '../src/core/game.js';

const SEAT = new Set(['human', 'ai', 'engine']);
const STYLE = new Set(['silent', 'annotate', 'coach']);

export function createFakeTable({ instance = 'fake' } = {}) {
  let game = Game.standard();
  let ids = new WeakMap();
  let nextId = 0;

  const idOf = n => {
    if (!ids.has(n)) ids.set(n, nextId++);
    return ids.get(n);
  };
  idOf(game.root);

  let rev = 0;
  let boardRev = 0;
  let gameId = 1;
  const recent = [];
  const match = { active: false, seats: { white: 'human', black: 'human' }, tip: 0, style: 'annotate' };
  let hint = { reason: 'init', by: 'rukh' };

  function all() {
    const out = [];
    const stack = [game.root];

    while (stack.length) {
      const n = stack.pop();
      out.push(n);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }

    return out;
  }

  const byId = id => all().find(n => idOf(n) === id) || null;
  const turnOf = n => (n.fen.split(' ')[1] === 'b' ? 'black' : 'white');

  function snapshot() {
    const nodes = all().map(n => ({
      id: idOf(n), parent: n.parentId ? idOf(game.node(n.parentId)) : null, children: n.children.map(idOf), ply: n.ply,
      san: n.san || null, uci: n.uci || null, fen: n.fen, check: false, checkmate: false, captured: null,
      note: n.note || '', nag: n.nag || '',
      arrows: (n.arrows || []).map(a => ({ from: a.from, to: a.to, color: a.color, knight: false, ...(a.source ? { source: a.source } : {}) })),
      highlights: (n.highlights || []).map(h => ({ square: h.square, color: h.color })),
      eval: null,
    }));
    nodes.sort((a, b) => a.id - b.id);

    const path = game.path().map(idOf);

    return {
      variant: game.variant, chess960_number: game.chess960Number, start_fen: game.startFen,
      fen: game.fen(), turn: game.turn(), ply: game.current.ply, current: idOf(game.current), path,
      status: { outcome: null, reason: 'playing' }, legal_moves: [], nodes,
    };
  }

  function matchBody() {
    const live = match.active && idOf(game.current) === match.tip;
    const tip = byId(match.tip);
    const toMove = live && tip ? match.seats[turnOf(tip)] : null;

    return { active: match.active, seats: { ...match.seats }, tip: match.tip, live, to_move: toMove, style: match.style, time_control: null };
  }

  function frame(nowMs = 0) {
    return {
      t: 'state', instance, rev, now_ms: nowMs, hint,
      state: {
        game_id: gameId, board_rev: boardRev, recent: recent.slice(), game: snapshot(),
        study: { title: '', notes: '' }, match: matchBody(), clock: null,
      },
    };
  }

  const fail = (code, message) => ({ ok: false, error: { code, message } });

  function changed(by, reason, boardChange, node, san) {
    rev++;
    hint = { reason, by };

    if (boardChange) {
      boardRev++;
      recent.push({ board_rev: boardRev, by, reason, node, ...(san ? { san } : {}) });
      while (recent.length > 16) recent.shift();
    }
  }

  /** Applies one intent for `by` ("view:N" | "ai:name"); returns { ok, result } or { ok:false, error }. */
  function apply(by, intent) {
    const isView = by.startsWith('view:');
    const op = intent && intent.op;

    if (op === 'play') {
      const target = !isView && match.active ? byId(match.tip) : game.current;
      if (!isView && match.active && match.seats[turnOf(target)] !== 'ai') return fail('not_your_turn', 'It is not your turn.');

      if (Number.isInteger(intent.from_node) && intent.from_node !== idOf(target)) {
        return fail('stale', `The board has moved on: the move would be played from node ${idOf(target)}, not node ${intent.from_node}.`);
      }

      const saved = game.current;
      game.goto(target.id);

      const mv = game.sanToMove(String(intent.move || '')) || game.uciToMove(String(intent.move || ''));
      let res = null;
      try {
        res = mv ? game.play(mv) : null;
      } catch (_) {
        res = null;
      }

      if (!res) {
        game.goto(saved.id);
        return fail('illegal', `illegal move: ${intent.move} is not a legal move here.`);
      }

      const node = game.current;
      if (typeof intent.note === 'string' && intent.note) game.setNote(node.id, intent.note);
      if (typeof intent.nag === 'string' && intent.nag) game.setNag(node.id, intent.nag);
      if (Array.isArray(intent.arrows)) game.setArrows(node.id, intent.arrows.map(a => ({ ...a, color: a.color || 'green', source: isView ? 'user' : 'ai' })));
      if (Array.isArray(intent.highlights)) game.setHighlights(node.id, intent.highlights.map(h => ({ ...h, color: h.color || 'green' })));

      if (match.active && idOf(target) === match.tip) match.tip = idOf(node);

      changed(by, 'move', true, idOf(node), node.san);
      return { ok: true, result: { node: idOf(node), san: node.san, uci: node.uci, fen: node.fen, board_rev: boardRev } };
    }

    if (op === 'goto' || op === 'back' || op === 'forward' || op === 'to_start' || op === 'to_end') {
      const before = game.current;

      if (op === 'goto') {
        const n = byId(intent.node);
        if (!n) return fail('bad_input', `no move with id ${intent.node} in this game`);
        game.goto(n.id);
      } else if (op === 'back') game.back();
      else if (op === 'forward') game.forward();
      else if (op === 'to_start') game.toStart();
      else game.toEnd();

      const live = match.active && idOf(game.current) === match.tip;
      if (game.current !== before) changed(by, 'navigate', isView, idOf(game.current));

      return { ok: true, result: { node: idOf(game.current), fen: game.fen(), turn: game.turn(), ply: game.current.ply, live } };
    }

    if (op === 'annotate') {
      const n = Number.isInteger(intent.node) ? byId(intent.node) : game.current;
      if (!n) return fail('bad_input', `no move with id ${intent.node} in this game`);
      if (intent.mode !== 'replace') return fail('bad_input', 'this stand-in only takes mode replace');

      const src = isView ? 'user' : 'ai';
      if (typeof intent.note === 'string') game.setNote(n.id, intent.note);
      if (typeof intent.nag === 'string') game.setNag(n.id, intent.nag);
      if (Array.isArray(intent.arrows)) game.setArrows(n.id, intent.arrows.map(a => ({ from: a.from, to: a.to, color: a.color || 'green', source: src })));
      if (Array.isArray(intent.highlights)) game.setHighlights(n.id, intent.highlights.map(h => ({ square: h.square, color: h.color || 'green' })));

      changed(by, 'annotate', isView, idOf(n));
      return { ok: true, result: { node: idOf(n), applied: {}, rejected: [], board_rev: boardRev } };
    }

    if (op === 'new_game') {
      game = intent.fen ? Game.fromFen(intent.fen) : Game.standard();
      ids = new WeakMap();
      nextId = 0;
      idOf(game.root);

      match.active = false;
      match.tip = 0;
      gameId++;

      changed(by, 'new_game', true, 0);
      return { ok: true, result: { node: 0, fen: game.fen(), turn: game.turn(), variant: game.variant, game_id: gameId } };
    }

    if (op === 'match_start') {
      const s = intent.seats || {};
      if (!SEAT.has(s.white) || !SEAT.has(s.black)) return fail('bad_input', 'the intent could not be read: seats');

      match.active = true;
      match.seats = { white: s.white, black: s.black };
      match.tip = idOf(game.current);
      if (typeof intent.style === 'string') match.style = STYLE.has(intent.style) ? intent.style : 'annotate';

      changed(by, 'match', false);
      return { ok: true, result: { match: matchBody() } };
    }

    if (op === 'match_stop') {
      if (match.active) {
        match.active = false;
        changed(by, 'match', false);
      }

      return { ok: true, result: { match: matchBody() } };
    }

    if (op === 'set_seats') {
      if (!SEAT.has(intent.white) || !SEAT.has(intent.black)) return fail('bad_input', 'the intent could not be read: seats');

      match.seats = { white: intent.white, black: intent.black };

      changed(by, 'seats', false);
      return { ok: true, result: { match: matchBody() } };
    }

    if (op === 'set_style') {
      match.style = STYLE.has(intent.style) ? intent.style : 'annotate';

      changed(by, 'style', false);
      return { ok: true, result: { style: { name: match.style, rule: '' }, match: matchBody() } };
    }

    return fail('bad_input', `the intent could not be read: unknown op ${op}`);
  }

  return {
    apply, frame, snapshot, matchBody,
    get rev() { return rev; },
    get boardRev() { return boardRev; },
    get game() { return game; },
    idOf, byId,
  };
}

const MAX_FREE_TABS = 12;
const NO_TAB = 'The intent must name its board, as in "tab":"t1". Nothing was changed.';

const unknownTab = id => ({ ok: false, error: { code: 'unknown_tab', message: `There is no open board "${id}"; it may have been closed.` } });
const badInput = message => ({ ok: false, error: { code: 'bad_input', message } });

const INVISIBLE = /[\u{AD}\u{34F}\u{61C}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{3164}\u{FE00}-\u{FE0F}\u{FEFF}\u{FFA0}\u{FFF9}-\u{FFFB}\u{E0000}-\u{E007F}]/gu;

/** A name cleaned as the program cleans it. */
export function cleanTabName(raw) {
  const text = String(raw)
    .replace(/[\s\u{85}]/gu, ' ')
    .replace(/\p{Cc}/gu, '')
    .replace(INVISIBLE, '')
    .replace(/ +/g, ' ')
    .trimStart();

  return Array.from(text).slice(0, 40).join('').trimEnd();
}

const MAX_CLOSED = 20;

/** Several stand-in tables as tabs, with one rev for all of them; with `saving`, closed boards wait to be reopened. */
export function createFakeDesk({ instance = 'fake', saving = false } = {}) {
  const tabs = [];
  const closed = []; // oldest first
  const marks = new Map();
  let nextTab = 1;
  let rev = 0;
  let hint = { reason: 'init', by: 'rukh' };

  const find = id => tabs.find(t => t.id === id) || null;

  function freeName() {
    for (let n = 1; ; n++) {
      if (!tabs.some(t => t.name === `Board ${n}`)) return `Board ${n}`;
    }
  }

  function make() {
    const tab = { id: `t${nextTab++}`, name: freeName(), kind: 'free', table: createFakeTable({ instance }) };
    tabs.push(tab);
    return tab;
  }

  let selected = make().id;

  function changed(by, reason) {
    rev++;
    hint = { reason, by };
  }

  function applyTab(by, intent) {
    const op = intent.op;

    if (op === 'tab_new') {
      if (tabs.filter(t => t.kind === 'free').length >= MAX_FREE_TABS) return { ok: false, error: { code: 'tab_limit', message: 'Close a board first.' } };

      selected = make().id;
      changed(by, op);
      return { ok: true, result: { tab: selected } };
    }

    if (op === 'tab_reopen') {
      if (!closed.length) return { ok: false, error: { code: 'nothing_closed', message: 'There is no closed board to reopen.' } };
      if (tabs.filter(t => t.kind === 'free').length >= MAX_FREE_TABS) return { ok: false, error: { code: 'tab_limit', message: 'Close a board first.' } };

      const tab = closed.pop();
      tabs.push(tab);
      selected = tab.id;

      changed(by, op);
      return { ok: true, result: { tab: tab.id, selected } };
    }

    if (typeof intent.tab !== 'string') return badInput('the intent could not be read: missing field `tab`');

    const tab = find(intent.tab);
    if (!tab) return unknownTab(intent.tab);

    if (op === 'tab_select') {
      if (selected !== tab.id) {
        selected = tab.id;
        changed(by, op);
      }

      return { ok: true, result: { selected } };
    }

    if (op === 'tab_rename') {
      const name = cleanTabName(intent.name ?? '');
      if (!name) return badInput('A board needs a name with at least one visible character.');

      if (tab.name !== name) {
        tab.name = name;
        changed(by, op);
      }

      return { ok: true, result: { tab: tab.id, name } };
    }

    if (op === 'tab_close') {
      const at = tabs.indexOf(tab);
      tabs.splice(at, 1);
      if (!tabs.length) make();

      if (selected === tab.id) selected = (tabs[at] || tabs[at - 1]).id;

      if (saving && tab.kind === 'free') {
        closed.push(tab);
        if (closed.length > MAX_CLOSED) closed.shift();
      }

      changed(by, op);
      return { ok: true, result: { closed: tab.id, selected } };
    }

    if (op === 'tab_move') {
      const to = intent.to;
      if (!Number.isInteger(to) || to < 0) return badInput('the intent could not be read: to');
      if (to >= tabs.length) return badInput(`to must be a place from 0 to ${tabs.length - 1}`);

      const at = tabs.indexOf(tab);

      if (at !== to) {
        tabs.splice(at, 1);
        tabs.splice(to, 0, tab);
        changed(by, op);
      }

      return { ok: true, result: { tab: tab.id, order: tabs.map(t => t.id) } };
    }

    return badInput(`the intent could not be read: unknown op ${op}`);
  }

  /** A view's game intent must name its tab; an AI's lands on the selected tab. */
  function apply(by, intent) {
    const isView = by.startsWith('view:');
    const op = intent && intent.op;

    if (typeof op === 'string' && op.startsWith('tab_')) {
      if (!isView) return badInput('only a view can change the boards');
      return applyTab(by, intent);
    }

    let tab = find(selected);

    if (isView) {
      if (intent.tab === undefined || intent.tab === null) return badInput(NO_TAB);
      if (typeof intent.tab !== 'string') return badInput('tab must be a board id such as "t1"');

      tab = find(intent.tab);
      if (!tab) return unknownTab(intent.tab);
    }

    const { tab: _named, ...rest } = intent;
    const before = tab.table.rev;
    const res = tab.table.apply(by, rest);

    if (tab.table.rev !== before) {
      rev++;
      hint = tab.table.frame().hint;
    }

    return res;
  }

  function frame(nowMs = 0) {
    const shown = find(selected);

    return {
      ...shown.table.frame(nowMs), rev, hint,
      tab: shown.id,
      tabs: tabs.map(t => ({ id: t.id, name: t.name, kind: t.kind, mark: marks.get(t.id) || null })),
    };
  }

  /** Gives a tab a mark, as the program computes one; a change raises rev. */
  function setMark(id, mark) {
    if ((marks.get(id) || null) === mark) return;

    marks.set(id, mark);
    changed('rukh', 'mark');
  }

  /** What the program says about saving, as in the hello and the boards message. */
  const boards = () => ({ saving, notices: [], closed: closed.length });

  return {
    apply, frame, boards, setMark,
    get rev() { return rev; },
    get selected() { return selected; },
    table: id => (find(id) || {}).table || null,
    tabs: () => tabs.map(t => ({ id: t.id, name: t.name })),
  };
}
