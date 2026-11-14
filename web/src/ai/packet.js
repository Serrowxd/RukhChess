const COLORS = ['green', 'red', 'blue', 'yellow'];
const MAX_VARIATION_PLIES = 8;
const MAX_PV_PLIES = 12;

export function isSquare(s) {
  return typeof s === 'string' && /^[a-h][1-8]$/.test(s);
}

/** Knight-jump test on square names, for a Game without a static isKnightJump. */
export function isKnightJump(from, to) {
  if (!isSquare(from) || !isSquare(to)) return false;

  const dx = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
  const dy = Math.abs(Number(from[1]) - Number(to[1]));
  return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
}

function knightJumpVia(game, from, to) {
  try {
    const G = game && game.constructor;
    if (G && typeof G.isKnightJump === 'function') return !!G.isKnightJump(from, to);
    if (game && typeof game.isKnightJump === 'function') return !!game.isKnightJump(from, to);
  } catch (_) {}

  return isKnightJump(from, to);
}

function fenFields(fen) {
  return typeof fen === 'string' ? fen.trim().split(/\s+/) : [];
}

function fenTurn(fen) {
  return fenFields(fen)[1] === 'b' ? 'black' : 'white';
}

function fenFullmove(fen) {
  const n = parseInt(fenFields(fen)[5], 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** '3. Bb5' for a white move, 'Bb5' for a black move, '3... Bb5' when forced. */
function numberedSan(parentFen, san, force) {
  const n = fenFullmove(parentFen);
  if (fenTurn(parentFen) === 'white') return `${n}. ${san}`;
  return force ? `${n}... ${san}` : san;
}

function formatLine(parent, first, maxPlies) {
  const parts = [];
  let prev = parent;
  let node = first;
  let count = 0;
  let force = true;

  while (node && node.san && count < maxPlies) {
    parts.push(numberedSan(prev.fen, node.san, force));
    force = false;
    prev = node;
    node = (node.children || [])[0];
    count += 1;
  }

  if (node && node.san) parts.push('...');
  return parts.join(' ');
}

function safePath(game) {
  try {
    const p = game.path();
    if (Array.isArray(p) && p.length) return p;
  } catch (_) {}

  return game && game.current ? [game.current] : [];
}

/** Numbered SAN of root to current, with sibling variations in parentheses at each branch point. */
export function formatHistory(game, opts = {}) {
  const maxVar = Number.isFinite(opts.variationPlies) ? opts.variationPlies : MAX_VARIATION_PLIES;
  const path = safePath(game);
  if (path.length < 2) return '';

  const out = [];
  let force = true;

  for (let i = 1; i < path.length; i++) {
    const node = path[i];
    const parent = path[i - 1];
    if (!node || !node.san) continue;

    out.push(numberedSan(parent.fen, node.san, force));
    force = false;

    const siblings = (parent.children || []).filter(c => c && c.id !== node.id && c.san);

    for (const sib of siblings) {
      out.push('(' + formatLine(parent, sib, maxVar) + ')');
      force = true;
    }
  }

  return out.join(' ');
}

function branchPoint(path) {
  for (let i = 1; i < path.length; i++) {
    const parent = path[i - 1];
    const node = path[i];
    const main = (parent.children || [])[0];

    if (!main || main.id !== node.id) {
      return { ply: node.ply, label: numberedSan(parent.fen, node.san, true) };
    }
  }

  return null;
}

function statusText(st) {
  if (!st || typeof st !== 'object') return 'playing';
  if (st.checkmate) return 'checkmate' + (st.outcome ? ` (${st.outcome})` : '');
  if (st.stalemate) return 'stalemate (1/2-1/2)';
  if (st.outcome === '1/2-1/2') return `draw (${st.reason || 'draw'})`;
  if (st.outcome) return `game over (${st.outcome}${st.reason ? ', ' + st.reason : ''})`;
  if (st.check) return 'check';

  const flags = [];
  if (Number(st.repetition) >= 2) flags.push(`repetition x${st.repetition}`);
  if (st.fiftyMoves) flags.push('fifty-move rule available');
  if (st.insufficientMaterial) flags.push('insufficient material');
  return flags.length ? `playing (${flags.join(', ')})` : 'playing';
}

/** Unique SAN for every legal move here; promotions appear once per piece. */
export function legalSanList(game) {
  const seen = new Set();
  const out = [];
  let moves = [];

  try {
    moves = game.legalMoves() || [];
  } catch (_) {
    moves = [];
  }

  for (const m of moves) {
    let san = null;

    try {
      san = game.moveToSan(m);
    } catch (_) {
      san = null;
    }

    if (san && !seen.has(san)) {
      seen.add(san);
      out.push(san);
    }
  }

  return out;
}

/** White's view: '+0.35', '-1.20', '#3', '-#2', or '?'. */
export function formatEval(score) {
  if (!score || typeof score !== 'object') return '?';

  if (typeof score.mate === 'number' && Number.isFinite(score.mate)) {
    return (score.mate < 0 ? '-#' : '#') + Math.abs(score.mate);
  }

  if (typeof score.cp === 'number' && Number.isFinite(score.cp)) {
    const v = score.cp / 100;
    if (v > 0) return '+' + v.toFixed(2);
    if (v < 0) return v.toFixed(2);
    return '0.00';
  }

  return '?';
}

function uciToSan(game, uci) {
  if (!uci) return null;

  try {
    const m = game.uciToMove(uci);
    return m ? game.moveToSan(m) : null;
  } catch (_) {
    return null;
  }
}

function safePvToSan(game, pv) {
  if (!Array.isArray(pv) || !pv.length) return [];

  try {
    return game.pvToSan(pv) || [];
  } catch (_) {
    return [];
  }
}

// An illegal first PV move means the lines are still from a previous position.
function engineIsCurrent(game, line) {
  const first = line && Array.isArray(line.pv) ? line.pv[0] : null;
  if (!first) return false;

  try {
    const m = game.uciToMove(first);
    if (!m) return false;
    return typeof game.isLegal === 'function' ? !!game.isLegal(m) : true;
  } catch (_) {
    return false;
  }
}

function engineContext(state, game, node) {
  const eng = state.engine || {};
  const lines = Array.isArray(eng.lines) ? eng.lines.filter(l => l && Array.isArray(l.pv) && l.pv.length) : [];

  if (lines.length && engineIsCurrent(game, lines[0])) {
    const out = lines.map((l, i) => {
      const san = Array.isArray(l.san) && l.san.length ? l.san : safePvToSan(game, l.pv);
      return { n: l.multipv || i + 1, eval: formatEval(l.score), depth: l.depth || 0, san: san.slice(0, MAX_PV_PLIES).join(' ') };
    });

    const top = lines[0];
    const bestUci = eng.bestMove || top.pv[0];
    const best_san = uciToSan(game, bestUci) || (out[0].san.split(' ')[0] || null);

    return {
      source: 'live',
      depth: eng.depth || top.depth || 0,
      eval: formatEval(eng.score || top.score),
      best_san,
      lines: out,
    };
  }

  const ev = node && node.eval;

  if (ev && (typeof ev.cp === 'number' || typeof ev.mate === 'number')) {
    const pvSan = Array.isArray(ev.pv) && ev.pv.length ? safePvToSan(game, ev.pv) : (ev.best ? [ev.best] : []);
    const evalText = formatEval(ev);

    return {
      source: 'stored',
      depth: ev.depth || 0,
      eval: evalText,
      best_san: ev.best || pvSan[0] || null,
      lines: pvSan.length ? [{ n: 1, eval: evalText, depth: ev.depth || 0, san: pvSan.slice(0, MAX_PV_PLIES).join(' ') }] : [],
    };
  }

  return null;
}

function normArrow(game, a) {
  if (!a || !isSquare(a.from) || !isSquare(a.to)) return null;

  const color = COLORS.includes(a.color) ? a.color : 'green';

  return {
    from: a.from,
    to: a.to,
    color,
    knight: a.knight === true || knightJumpVia(game, a.from, a.to),
    source: a.source || 'user',
  };
}

function normHighlight(h) {
  if (!h || !isSquare(h.square)) return null;
  return { square: h.square, color: COLORS.includes(h.color) ? h.color : 'green' };
}

/** The packet's content as a plain object. */
export function buildContext(state, opts = {}) {
  const o = { includeEngine: true, includeLegalMoves: false, ...opts };
  const game = state.game;
  const path = safePath(game);
  const node = path[path.length - 1] || game.current;
  const fen = game.fen();
  const branch = branchPoint(path);

  let status;

  try {
    status = statusText(game.status());
  } catch (_) {
    status = 'playing';
  }

  const last_move = node && node.san ? { san: node.san, uci: node.uci || null } : null;
  const study = state.study || {};

  return {
    variant: game.variant || 'standard',
    chess960: game.variant === 'chess960' ? (Number.isFinite(game.chess960Number) ? game.chess960Number : null) : null,
    start_fen: game.startFen || (path[0] && path[0].fen) || fen,
    fen,
    turn: game.turn(),
    move_number: fenFullmove(fen),
    ply: node && Number.isFinite(node.ply) ? node.ply : 0,
    line: branch ? 'variation' : 'main',
    branched_at: branch,
    history_san: formatHistory(game),
    last_move,
    status,
    legal_moves: o.includeLegalMoves ? legalSanList(game) : undefined,
    next_moves: ((node && node.children) || []).map(c => c && c.san).filter(Boolean),
    arrows: ((node && node.arrows) || []).map(a => normArrow(game, a)).filter(Boolean),
    highlights: ((node && node.highlights) || []).map(normHighlight).filter(Boolean),
    note: (node && node.note) || '',
    nag: (node && node.nag) || '',
    title: study.title || '',
    study_notes: study.notes || '',
    mode: state.mode || 'play',
    engine: o.includeEngine ? engineContext(state, game, node) : null,
  };
}

function arrowText(a) {
  let s = `${a.from}->${a.to} ${a.color}`;
  if (a.knight) s += ' (knight L)';
  if (a.source && a.source !== 'user') s += ` [${a.source}]`;
  return s;
}

/** The text packet an AI reads. */
export function buildPacket(state, opts = {}) {
  const o = { includeEngine: true, includeLegalMoves: false, ...opts };
  const c = buildContext(state, o);
  const L = [];

  L.push('== Chessboard ==');
  if (c.title) L.push('title: ' + c.title);
  if (c.mode === 'setup') L.push('mode: setup (the board shows an uncommitted setup; this packet describes the last committed game)');
  L.push('variant: ' + (c.variant === 'chess960' ? 'chess960' + (c.chess960 != null ? ' #' + c.chess960 : '') : c.variant));
  L.push('start_fen: ' + c.start_fen);
  L.push('fen: ' + c.fen);
  L.push('turn: ' + c.turn);

  const line = c.line === 'main' ? 'main' : `variation (branched at ${c.branched_at ? c.branched_at.label : '?'})`;
  L.push(`move_number: ${c.move_number}  ply: ${c.ply}  line: ${line}`);
  L.push('history: ' + (c.history_san || '(none)'));
  L.push('last_move: ' + (c.last_move ? `${c.last_move.san} (${c.last_move.uci || '?'})` : 'none'));
  L.push('status: ' + c.status);

  if (o.includeLegalMoves) L.push('legal_moves: ' + ((c.legal_moves || []).join(', ') || '(none)'));
  if (c.next_moves.length) L.push('next: ' + c.next_moves.join(', '));
  if (c.arrows.length) L.push('arrows: ' + c.arrows.map(arrowText).join(', '));
  if (c.highlights.length) L.push('highlights: ' + c.highlights.map(h => `${h.square} ${h.color}`).join(', '));
  if (c.note) L.push('note: ' + JSON.stringify(c.note));
  if (c.nag) L.push('nag: ' + c.nag);
  if (c.study_notes) L.push('study_notes: ' + JSON.stringify(c.study_notes));

  if (o.includeEngine && c.engine) {
    const e = c.engine;
    let head = `engine: depth ${e.depth}  eval ${e.eval} (White)`;
    if (e.best_san) head += `  best ${e.best_san}`;
    if (e.source === 'stored') head += '  [stored]';
    L.push(head);

    for (const ln of e.lines) L.push(`  ${ln.n}) ${ln.eval}  ${ln.san}`);
  }

  return L.join('\n');
}
