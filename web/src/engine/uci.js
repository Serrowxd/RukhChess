// engine/uci.js -- pure UCI text helpers for the Stockfish driver. No DOM, no worker, no store.
// Contract surface: parseInfo(line), parseBestMove(line).
// Added beyond the contract (all pure, all exported): turnFromFen, toWhiteView, formatScore, fenKey,
// parseOption, parseId. Scores in/out are { cp } | { mate }; toWhiteView adds `mated` only for mate 0.

const NUM_KEYS = new Set(['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'hashfull', 'tbhits', 'time', 'currmovenumber', 'cpuload']);
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/** Parse a UCI `info` line -> { depth, seldepth, multipv, score:{cp}|{mate}|null, nodes, nps, time, pv:[uci], bound?, wdl?, currmove? }; null for anything else (`info string`, currmove-only or node-count-only lines included). */
export function parseInfo(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info') return null;
  const out = { depth: 0, seldepth: 0, multipv: 1, score: null, nodes: 0, nps: 0, time: 0, pv: [] };
  let hasScore = false;
  let i = 1;
  while (i < t.length) {
    const k = t[i++];
    if (k === 'string') return null;
    if (k === 'pv') {
      // Truncate at the first token that is not a move -- never filter, or a stray token in the middle
      // would silently splice two halves of different lines into one "pv" that does not play out.
      const rest = t.slice(i);
      let n = 0;
      while (n < rest.length && UCI_MOVE.test(rest[n])) n++;
      out.pv = rest.slice(0, n);
      break;
    }
    if (k === 'refutation' || k === 'currline') break;
    if (k === 'score') {
      const kind = t[i];
      const v = Number(t[i + 1]);
      if ((kind === 'cp' || kind === 'mate') && Number.isFinite(v)) {
        out.score = kind === 'cp' ? { cp: v } : { mate: v };
        hasScore = true;
        i += 2;
      }
      if (t[i] === 'lowerbound' || t[i] === 'upperbound') { out.bound = t[i] === 'lowerbound' ? 'lower' : 'upper'; i++; }
      continue;
    }
    if (k === 'wdl') {
      const w = t.slice(i, i + 3).map(Number);
      if (w.length === 3 && w.every(Number.isFinite)) { out.wdl = w; i += 3; }
      continue;
    }
    if (k === 'currmove') { out.currmove = t[i++]; continue; }
    if (NUM_KEYS.has(k)) {
      const v = Number(t[i]);
      if (Number.isFinite(v)) { out[k] = v; i++; }
      continue;
    }
    // unknown token: ignore it and keep scanning
  }
  if (!hasScore && out.pv.length === 0) return null;
  return out;
}

/** Parse a `bestmove` line -> { bestmove: uci|null, ponder: uci|null }; `bestmove (none)` gives bestmove null. Null for any other line. */
export function parseBestMove(line) {
  if (typeof line !== 'string') return null;
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'bestmove') return null;
  const mv = (u) => (u && u !== '(none)' && u !== '0000' && u !== 'NULL' ? u : null);
  const bestmove = mv(t[1]);
  const ponder = t[2] === 'ponder' ? mv(t[3]) : null;
  return { bestmove, ponder };
}

/** Side to move from a FEN string: 'white' | 'black' (white when the field is missing or unreadable). */
export function turnFromFen(fen) {
  const f = typeof fen === 'string' ? fen.trim().split(/\s+/)[1] : null;
  return f === 'b' ? 'black' : 'white';
}

/** Convert a score reported from the side to move (`turn`) into White's view. mate 0 (the side to move is checkmated) stays 0 and carries `mated: turn`. Never produces -0. */
export function toWhiteView(score, turn) {
  if (!score || typeof score !== 'object') return null;
  const neg = turn === 'black';
  if (typeof score.mate === 'number' && Number.isFinite(score.mate)) {
    if (score.mate === 0) return { mate: 0, mated: neg ? 'black' : 'white' };
    return { mate: neg ? -score.mate : score.mate };
  }
  if (typeof score.cp === 'number' && Number.isFinite(score.cp)) {
    if (score.cp === 0) return { cp: 0 };
    return { cp: neg ? -score.cp : score.cp };
  }
  return null;
}

/** Human-readable score in White's view: '+0.31', '-1.20', '0.00', '#3' (White mates in 3), '#-3' (Black mates), '#' (checkmate on the board), '--' (none). */
export function formatScore(score) {
  if (!score || typeof score !== 'object') return '--';
  if (typeof score.mate === 'number') {
    if (score.mate === 0) return '#';
    return score.mate > 0 ? '#' + score.mate : '#-' + Math.abs(score.mate);
  }
  if (typeof score.cp === 'number') {
    const p = score.cp / 100;
    if (p === 0) return '0.00';
    return (p > 0 ? '+' : '-') + Math.abs(p).toFixed(2);
  }
  return '--';
}

/** The first four FEN fields (board, turn, castling, en passant) -- the identity of a position for staleness checks. */
export function fenKey(fen) {
  if (typeof fen !== 'string') return '';
  return fen.trim().split(/\s+/).slice(0, 4).join(' ');
}

/** Parse `option name X type spin default 1 min 1 max 256` -> { name, type, default, min, max, vars } or null. */
export function parseOption(line) {
  if (typeof line !== 'string' || !/^option\s/.test(line)) return null;
  const t = line.trim().split(/\s+/);
  const out = { name: '', type: '', default: null, min: null, max: null, vars: [] };
  let key = null;
  const buf = [];
  const flush = () => {
    if (!key) return;
    const v = buf.join(' ');
    if (key === 'name') out.name = v;
    else if (key === 'type') out.type = v;
    else if (key === 'default') out.default = v;
    else if (key === 'min') out.min = Number(v);
    else if (key === 'max') out.max = Number(v);
    else if (key === 'var') out.vars.push(v);
    buf.length = 0;
  };
  for (let i = 1; i < t.length; i++) {
    const w = t[i];
    if (w === 'name' || w === 'type' || w === 'default' || w === 'min' || w === 'max' || w === 'var') { flush(); key = w; }
    else buf.push(w);
  }
  flush();
  return out.name ? out : null;
}

/** Parse `id name ...` / `id author ...` -> { key: 'name'|'author', value } or null. */
export function parseId(line) {
  const m = typeof line === 'string' ? /^id\s+(name|author)\s+(.*)$/.exec(line.trim()) : null;
  return m ? { key: m[1], value: m[2] } : null;
}
