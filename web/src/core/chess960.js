// core/chess960.js — Chess960 (Fischer Random) start positions, Scharnagl numbering.
// Owns: chess960Fen(n), randomChess960(). Pure, no dependencies.
//
// API added beyond CONTRACT.md:
//   CHESS960_STANDARD        = 518 (the classical start position's number)
//   chess960Fen(n, { shredder }) — second optional arg; shredder:true emits Shredder-FEN
//                              castling letters (HAha) instead of X-FEN KQkq. Default KQkq:
//                              verified by test/core-chess960.test.mjs to load correctly in
//                              chessops for all 960 positions (castling rooks resolved by position).
//   chess960NumberOf(fen)    → number | null — inverse lookup from a FEN's back rank (rank 8 / rank 1
//                              must match and both sides must be the same arrangement).
//   chess960BackRank(n)      → 'bbqnnrkr' (lower-case, a→h)

/** The Scharnagl number of the classical start position (RNBQKBNR). */
export const CHESS960_STANDARD = 518;

// Knight placements among the 5 free squares, indexed by the N5N table (Scharnagl).
const KNIGHT_TABLE = [
  [0, 1], [0, 2], [0, 3], [0, 4],
  [1, 2], [1, 3], [1, 4],
  [2, 3], [2, 4],
  [3, 4],
];

function freeSquares(row) {
  const out = [];
  for (let i = 0; i < 8; i++) if (row[i] === null) out.push(i);
  return out;
}

/** Back rank for Scharnagl number n (0..959) as an 8-letter lower-case string, file a first. */
export function chess960BackRank(n) {
  if (!Number.isInteger(n) || n < 0 || n > 959) {
    throw new RangeError(`Chess960 number must be an integer 0..959 (got ${n})`);
  }
  const row = new Array(8).fill(null);
  let k = n;
  // 1. Light-square bishop: files b, d, f, h.
  const lightB = k % 4; k = Math.floor(k / 4);
  row[lightB * 2 + 1] = 'b';
  // 2. Dark-square bishop: files a, c, e, g.
  const darkB = k % 4; k = Math.floor(k / 4);
  row[darkB * 2] = 'b';
  // 3. Queen on the q-th remaining free square.
  const q = k % 6; k = Math.floor(k / 6);
  row[freeSquares(row)[q]] = 'q';
  // 4. Knights: one of the 10 placements among the 5 remaining squares.
  const [n1, n2] = KNIGHT_TABLE[k];
  const free = freeSquares(row);
  row[free[n1]] = 'n';
  row[free[n2]] = 'n';
  // 5. Rook, king, rook fill what is left, in that order (king between rooks).
  const rest = freeSquares(row);
  row[rest[0]] = 'r';
  row[rest[1]] = 'k';
  row[rest[2]] = 'r';
  return row.join('');
}

/** Full FEN for Scharnagl number n. Castling is X-FEN `KQkq` (or Shredder `HAha`-style with { shredder: true }). */
export function chess960Fen(n, opts = {}) {
  const black = chess960BackRank(n);
  const white = black.toUpperCase();
  let castling = 'KQkq';
  if (opts.shredder) {
    const files = 'abcdefgh';
    const rooks = [];
    for (let i = 0; i < 8; i++) if (black[i] === 'r') rooks.push(files[i]);
    // Shredder order: king side first, then queen side (h before a in the classical case).
    const w = rooks[1].toUpperCase() + rooks[0].toUpperCase();
    castling = w + rooks[1] + rooks[0];
  }
  return `${black}/pppppppp/8/8/8/8/PPPPPPPP/${white} w ${castling} - 0 1`;
}

let backRankIndex = null;

/** Inverse lookup: the Scharnagl number whose back rank matches this FEN's ranks 8 and 1, else null. */
export function chess960NumberOf(fen) {
  if (typeof fen !== 'string') return null;
  const board = fen.trim().split(/\s+/)[0] || '';
  const ranks = board.split('/');
  if (ranks.length !== 8) return null;
  const top = ranks[0];
  const bottom = ranks[7];
  if (top.length !== 8 || bottom.length !== 8) return null;
  if (top !== bottom.toLowerCase() || bottom !== bottom.toUpperCase()) return null;
  if (!backRankIndex) {
    backRankIndex = new Map();
    for (let i = 0; i < 960; i++) backRankIndex.set(chess960BackRank(i), i);
  }
  const n = backRankIndex.get(top);
  return n === undefined ? null : n;
}

/** A uniformly random Chess960 number 0..959 (crypto-backed when available). */
export function randomChess960() {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    const limit = 4294967040; // largest multiple of 960 below 2^32 — reject above it for uniformity
    for (let i = 0; i < 64; i++) {
      c.getRandomValues(buf);
      if (buf[0] < limit) return buf[0] % 960;
    }
  }
  return Math.floor(Math.random() * 960);
}
