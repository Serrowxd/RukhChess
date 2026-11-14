// core/game.js — rules + variation tree. Pure: no DOM, no three. Wraps chessops 0.15.
// Owns the Game class and the tree Node shape from CONTRACT.md. chessops square numbers and
// chessops pgn Node objects never leave this file.
//
// API added beyond CONTRACT.md (all optional / additive):
//   Game.fromFen(fen, { variant?, chess960Number? })  second arg; without it the variant is
//                                                     auto-detected from the castling rights (rooks
//                                                     off a/h or a king off the e-file => 'chess960').
//   Game.detectVariant(fen) → 'standard' | 'chess960'
//   game.warnings: string[]      import warnings (a move that could not be played was dropped, with its
//                                subtree) collected by fromPgn / fromJSON. Loading never throws on an
//                                illegal move inside the tree; it throws on a bad start position.
//   game.cursor() → number[]     child indexes root→current;  game.gotoCursor(indexes) → Node
//   game.moveToUci(move) → string|null   boundary form (king→king-destination for castling)
//   game.engineUci(move) → string|null   the UCI form Stockfish wants: e1g1 in standard, e1h1
//                                        (king takes own rook) when UCI_Chess960 is on
//   game.posOf(node) / game.position()   read-only chessops Position for a node / current (do not mutate)
//   game.nodeCount(), game.hasMoves()
//   NAG_GLYPHS, nagToNumber(glyph), nagFromNumber(n), ARROW_COLORS, COLORS_SET
//   Castling notes: the king→king-destination form is used everywhere except the two Chess960
//   degeneracies where it cannot be (king already on its destination, or the destination is also a
//   plain one-square king move) — then node.uci / node.move use the king→rook form, which play()
//   accepts in both variants.

import {
  Board,
  Chess,
  charToRole,
  kingCastlesTo,
  makeSquare,
  makeUci,
  parseSquare,
  parseUci,
  roleToChar,
  squareFile,
  squareRank,
} from 'chessops';
import { castlingSide } from 'chessops/chess';
import { INITIAL_FEN, makeFen, parseCastlingFen, parseFen } from 'chessops/fen';
import { makeSan, makeSanAndPlay, parseSan } from 'chessops/san';
import {
  ChildNode as PgnChildNode,
  Node as PgnNode,
  defaultHeaders,
  makeComment,
  makePgn,
  parseComment,
  parsePgn,
  parseVariant,
  startingPosition,
} from 'chessops/pgn';
import { chess960Fen, chess960NumberOf, randomChess960 } from './chess960.js';

export { INITIAL_FEN };

/** NAG glyphs accepted on a node, in PGN numeric order ($1..$6). */
export const NAG_GLYPHS = ['!', '?', '!!', '??', '!?', '?!'];
/** The four annotation colours. */
export const ARROW_COLORS = ['green', 'red', 'blue', 'yellow'];
const COLOR_SET = new Set(ARROW_COLORS);
const ROLES = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const PROMOTIONS = ['q', 'r', 'b', 'n'];

const SETUP_ERRORS = {
  ERR_EMPTY: 'the board is empty',
  ERR_OPPOSITE_CHECK: 'the side not to move is in check',
  ERR_PAWNS_ON_BACKRANK: 'pawns cannot stand on the first or last rank',
  ERR_KINGS: 'each side needs exactly one king',
  ERR_VARIANT: 'unsupported variant',
};
const FEN_ERRORS = {
  ERR_FEN: 'malformed FEN',
  ERR_BOARD: 'bad piece placement',
  ERR_POCKETS: 'unexpected pocket section',
  ERR_TURN: 'side to move must be w or b',
  ERR_CASTLING: 'bad castling rights',
  ERR_EP_SQUARE: 'bad en passant square',
  ERR_REMAINING_CHECKS: 'unexpected remaining-checks field',
  ERR_HALFMOVES: 'bad halfmove clock',
  ERR_FULLMOVES: 'bad move number',
};

const readable = (err, table) => (err && table[err.message]) || (err && err.message) || 'unknown error';

/** PGN NAG number → glyph ('' when not one of the six move glyphs). */
export function nagFromNumber(n) {
  return NAG_GLYPHS[n - 1] || '';
}

/** Glyph → PGN NAG number (0 when empty / unknown). */
export function nagToNumber(glyph) {
  const i = NAG_GLYPHS.indexOf(glyph);
  return i < 0 ? 0 : i + 1;
}

const isSquareName = s => typeof s === 'string' && s.length === 2 && parseSquare(s) !== undefined;

function knightJump(from, to) {
  const a = parseSquare(from);
  const b = parseSquare(to);
  if (a === undefined || b === undefined) return false;
  const dx = Math.abs(squareFile(a) - squareFile(b));
  const dy = Math.abs(squareRank(a) - squareRank(b));
  return (dx === 1 && dy === 2) || (dx === 2 && dy === 1);
}

function cleanArrow(a) {
  if (!a || !isSquareName(a.from) || !isSquareName(a.to) || a.from === a.to) return null;
  const color = COLOR_SET.has(a.color) ? a.color : 'green';
  const out = { from: a.from, to: a.to, color, knight: knightJump(a.from, a.to) };
  if (a.source === 'user' || a.source === 'engine' || a.source === 'ai') out.source = a.source;
  return out;
}

function cleanHighlight(h) {
  if (!h || !isSquareName(h.square)) return null;
  return { square: h.square, color: COLOR_SET.has(h.color) ? h.color : 'green' };
}

function cleanEval(e) {
  if (!e || typeof e !== 'object') return null;
  const out = {};
  if (Number.isFinite(e.mate)) out.mate = e.mate;
  else if (Number.isFinite(e.cp)) out.cp = e.cp;
  else return null;
  out.depth = Number.isFinite(e.depth) ? e.depth : 0;
  out.pv = Array.isArray(e.pv) ? e.pv.filter(x => typeof x === 'string') : [];
  if (typeof e.best === 'string' && e.best) out.best = e.best;
  return out;
}

const fenKey = fen => fen.split(' ').slice(0, 4).join(' ');

function fenPly(setup) {
  return (Math.max(1, setup.fullmoves) - 1) * 2 + (setup.turn === 'black' ? 1 : 0);
}

function loadPosition(fen) {
  const setupRes = parseFen(fen);
  if (setupRes.isErr) throw new Error(`invalid FEN: ${readable(setupRes.error, FEN_ERRORS)}`);
  const posRes = Chess.fromSetup(setupRes.value);
  if (posRes.isErr) throw new Error(`illegal position: ${readable(posRes.error, SETUP_ERRORS)}`);
  return posRes.value;
}

export class Game {
  constructor() {
    this.variant = 'standard';
    this.chess960Number = null;
    this.startFen = INITIAL_FEN;
    this.root = null;
    this.current = null;
    this.headers = new Map();
    this.warnings = [];
    this._seq = 0;
    this._index = new Map();
    this._cache = null;
  }

  // ───────────────────────── construction ─────────────────────────

  /** The classical start position. */
  static standard() {
    return Game.fromFen(INITIAL_FEN, { variant: 'standard' });
  }

  /** A game starting from a FEN. Throws Error with a readable reason on invalid FEN / illegal setup. */
  static fromFen(fen, opts = {}) {
    if (typeof fen !== 'string' || !fen.trim()) throw new Error('invalid FEN: empty');
    const pos = loadPosition(fen.trim());
    const game = new Game();
    game.startFen = makeFen(pos.toSetup());
    game.variant = opts.variant === 'chess960' || opts.variant === 'standard'
      ? opts.variant
      : Game.detectVariant(pos);
    if (Number.isInteger(opts.chess960Number)) game.chess960Number = opts.chess960Number;
    else if (game.variant === 'chess960') game.chess960Number = chess960NumberOf(game.startFen);
    const setup = pos.toSetup();
    game.root = game._newNode({ ply: fenPly(setup), fen: game.startFen, check: pos.isCheck(), checkmate: pos.isCheckmate() });
    game.current = game.root;
    game._cache = { id: game.root.id, pos };
    return game;
  }

  /** A Chess960 game; n in 0..959, undefined = random. */
  static chess960(n) {
    const number = Number.isInteger(n) ? n : randomChess960();
    const game = Game.fromFen(chess960Fen(number), { variant: 'chess960', chess960Number: number });
    return game;
  }

  /** 'chess960' when castling rights involve rooks off the a/h files or a king off the e-file. */
  static detectVariant(fenOrPos) {
    const pos = typeof fenOrPos === 'string' ? loadPosition(fenOrPos) : fenOrPos;
    for (const color of ['white', 'black']) {
      const king = pos.board.kingOf(color);
      for (const side of ['a', 'h']) {
        const rook = pos.castles.rook[color][side];
        if (rook === undefined) continue;
        const file = squareFile(rook);
        if (file !== 0 && file !== 7) return 'chess960';
        if (king !== undefined && squareFile(king) !== 4) return 'chess960';
      }
    }
    return 'standard';
  }

  /** Setup-mode constructor. Throws with a readable reason (no king, pawn on back rank, side not to move in check, …). */
  static fromPieces(pieces, opts = {}) {
    const board = Board.empty();
    for (const entry of pieces || []) {
      const sq = entry && parseSquare(entry.square);
      const piece = entry && entry.piece;
      if (sq === undefined) throw new Error(`bad square ${entry && entry.square}`);
      if (!piece || !ROLES.includes(piece.role) || (piece.color !== 'white' && piece.color !== 'black')) {
        throw new Error(`bad piece on ${entry.square}`);
      }
      board.set(sq, { role: piece.role, color: piece.color });
    }
    const turn = opts.turn === 'black' ? 'black' : 'white';
    const castlingText = opts.castling && opts.castling.trim() ? opts.castling.trim() : '-';
    const castlingRes = parseCastlingFen(board, castlingText);
    if (castlingRes.isErr) throw new Error('bad castling rights');
    let epSquare;
    if (opts.epSquare) {
      epSquare = parseSquare(opts.epSquare);
      if (epSquare === undefined) throw new Error(`bad en passant square ${opts.epSquare}`);
    }
    const setup = {
      board,
      pockets: undefined,
      turn,
      castlingRights: castlingRes.value,
      epSquare,
      remainingChecks: undefined,
      halfmoves: Number.isInteger(opts.halfmoves) ? opts.halfmoves : 0,
      fullmoves: Number.isInteger(opts.fullmoves) ? Math.max(1, opts.fullmoves) : 1,
    };
    const white = board.white.size();
    const black = board.black.size();
    if (white === 0 && black === 0) throw new Error(SETUP_ERRORS.ERR_EMPTY);
    if (board.pieces('white', 'king').size() !== 1 || board.pieces('black', 'king').size() !== 1) {
      throw new Error(SETUP_ERRORS.ERR_KINGS);
    }
    const posRes = Chess.fromSetup(setup);
    if (posRes.isErr) throw new Error(readable(posRes.error, SETUP_ERRORS));
    return Game.fromFen(makeFen(posRes.value.toSetup()), { variant: opts.variant });
  }

  /** Full tree from a PGN (first game in the text). Throws on no game / bad start position. */
  static fromPgn(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('empty PGN');
    const games = parsePgn(text);
    if (!games.length) throw new Error('no game found in the PGN');
    const pg = games[0];
    const variantHeader = pg.headers.get('Variant');
    const rules = parseVariant(variantHeader);
    if (rules !== 'chess') throw new Error(`unsupported variant: ${variantHeader}`);
    const startRes = startingPosition(pg.headers);
    if (startRes.isErr) {
      const e = startRes.error;
      throw new Error(`bad start position: ${readable(e, { ...FEN_ERRORS, ...SETUP_ERRORS })}`);
    }
    const pos = startRes.value;
    const is960 = /960|fischer/i.test(variantHeader || '');
    const game = Game.fromFen(makeFen(pos.toSetup()), is960 ? { variant: 'chess960' } : {});
    game.headers = new Map(pg.headers);
    if (pg.comments && pg.comments.length) applyCommentText(game.root, pg.comments.join('\n'));

    const stack = [{ src: pg.moves, node: game.root }];
    while (stack.length) {
      const { src, node } = stack.pop();
      for (const child of src.children) {
        const data = child.data;
        game.goto(node.id);
        let res;
        try {
          const m = game.sanToMove(data.san);
          if (!m) throw new Error('illegal');
          res = game.play(m);
        } catch (_) {
          game.warnings.push(`dropped illegal move ${data.san} after ply ${node.ply}`);
          continue;
        }
        const target = res.node;
        const parts = [];
        if (data.startingComments && data.startingComments.length) parts.push(data.startingComments.join('\n'));
        if (data.comments && data.comments.length) parts.push(data.comments.join('\n'));
        if (parts.length) applyCommentText(target, parts.join('\n'), true);
        if (data.nags) {
          for (const n of data.nags) {
            const g = nagFromNumber(n);
            if (g) { target.nag = g; break; }
          }
        }
        stack.push({ src: child, node: target });
      }
    }
    game.goto(game.root.id);
    return game;
  }

  /** Inverse of toJSON(). Replays every move through the rules; illegal moves are dropped into game.warnings. */
  static fromJSON(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('not a game object');
    const version = obj.version === undefined ? 1 : obj.version;
    if (version !== 1) throw new Error(`unsupported game version ${version}`);
    const startFen = typeof obj.startFen === 'string' && obj.startFen ? obj.startFen : INITIAL_FEN;
    const game = Game.fromFen(startFen, {
      variant: obj.variant,
      chess960Number: Number.isInteger(obj.chess960Number) ? obj.chess960Number : undefined,
    });
    if (obj.headers && typeof obj.headers === 'object') {
      for (const [k, v] of Object.entries(obj.headers)) if (typeof v === 'string') game.headers.set(k, v);
    }
    const tree = obj.tree && typeof obj.tree === 'object' ? obj.tree : {};
    copyAnnotations(game.root, tree);
    const stack = [{ src: tree, node: game.root }];
    while (stack.length) {
      const { src, node } = stack.pop();
      const children = Array.isArray(src.children) ? src.children : [];
      for (const c of children) {
        if (!c || typeof c !== 'object') continue;
        game.goto(node.id);
        let res = null;
        const candidates = [];
        if (typeof c.uci === 'string' && c.uci) candidates.push(c.uci);
        if (c.move && typeof c.move === 'object') candidates.push(c.move);
        if (typeof c.san === 'string' && c.san) candidates.push({ san: c.san });
        for (const cand of candidates) {
          try {
            const m = cand.san ? game.sanToMove(cand.san) : cand;
            if (!m) continue;
            res = game.play(m);
            break;
          } catch (_) { /* try the next representation */ }
        }
        if (!res) {
          game.warnings.push(`dropped illegal move ${c.san || c.uci || '?'} after ply ${node.ply}`);
          continue;
        }
        copyAnnotations(res.node, c);
        stack.push({ src: c, node: res.node });
      }
    }
    game.goto(game.root.id);
    return game;
  }

  /** True when from→to is a knight jump. */
  static isKnightJump(from, to) {
    return knightJump(from, to);
  }

  // ───────────────────────── internals ─────────────────────────

  _newNode(fields) {
    const id = 'n' + (++this._seq);
    const node = {
      id,
      ply: 0,
      san: null,
      uci: null,
      move: null,
      fen: '',
      check: false,
      checkmate: false,
      captured: null,
      note: '',
      nag: '',
      arrows: [],
      highlights: [],
      eval: null,
      children: [],
      parentId: null,
      ...fields,
    };
    this._index.set(id, node);
    return node;
  }

  /** Read-only chessops Position of a node (cached for the current node). Do not mutate. */
  posOf(node) {
    if (this._cache && this._cache.id === node.id) return this._cache.pos;
    const pos = loadPosition(node.fen);
    if (node === this.current) this._cache = { id: node.id, pos };
    return pos;
  }

  /** Read-only chessops Position of the current node. Do not mutate. */
  position() {
    return this.posOf(this.current);
  }

  _parseMove(move, pos) {
    let from, to, promotion;
    if (typeof move === 'string') {
      const m = parseUci(move.trim());
      if (!m || m.from === undefined) return null;
      from = m.from; to = m.to; promotion = m.promotion;
    } else if (move && typeof move === 'object') {
      from = parseSquare(String(move.from || ''));
      to = parseSquare(String(move.to || ''));
      if (move.promotion) {
        const p = String(move.promotion).toLowerCase();
        promotion = p.length === 1 ? charToRole(p) : (ROLES.includes(p) ? p : undefined);
        if (!promotion) return null;
      }
    } else return null;
    if (from === undefined || to === undefined) return null;
    const out = { from, to };
    if (promotion) out.promotion = promotion;
    else if (pos) {
      const piece = pos.board.get(from);
      if (piece && piece.color === pos.turn) {
        if (piece.role === 'pawn' && (squareRank(to) === 0 || squareRank(to) === 7)) {
          // A pawn reaching the last rank without a stated promotion piece → queen.
          out.promotion = 'queen';
        } else if (piece.role === 'king') {
          // King→king-destination castling (e1g1 / b1g1 …): chessops only understands it when the
          // king travels exactly two squares, so translate it to king→rook whenever castling to that
          // side is available and the destination is not also a plain one-square king move.
          const side = to === kingCastlesTo(pos.turn, 'h') ? 'h' : to === kingCastlesTo(pos.turn, 'a') ? 'a' : null;
          if (side) {
            const rook = pos.castles.rook[pos.turn][side];
            const dests = pos.dests(from);
            const plain = to !== from && dests.has(to) && !pos.board[pos.turn].has(to);
            if (!plain && rook !== undefined && dests.has(rook)) out.to = rook;
          }
        }
      }
    }
    return out;
  }

  /** Boundary form of a chessops move in `pos`: castling as king→king-destination unless degenerate. */
  _boundaryMove(pos, m) {
    const side = castlingSide(pos, m);
    if (!side) {
      const out = { from: makeSquare(m.from), to: makeSquare(m.to) };
      if (m.promotion) out.promotion = roleToChar(m.promotion);
      return out;
    }
    const kingTo = kingCastlesTo(pos.turn, side);
    const rook = pos.castles.rook[pos.turn][side];
    const rookSq = rook === undefined ? m.to : rook;
    const plainKingMove = kingTo !== m.from && pos.dests(m.from).has(kingTo) && !pos.board[pos.turn].has(kingTo);
    if (kingTo === m.from || plainKingMove) return { from: makeSquare(m.from), to: makeSquare(rookSq) };
    return { from: makeSquare(m.from), to: makeSquare(kingTo) };
  }

  _invalidate() {
    this._cache = null;
  }

  // ───────────────────────── reading ─────────────────────────

  /** FEN of the current position. */
  fen() {
    return this.current.fen;
  }

  /** Side to move. */
  turn() {
    return this.position().turn;
  }

  /** All pieces as { square, piece:{color, role} }. */
  pieces() {
    const out = [];
    for (const [sq, piece] of this.position().board) {
      out.push({ square: makeSquare(sq), piece: { color: piece.color, role: piece.role } });
    }
    return out;
  }

  /** Piece on a square, or null. */
  pieceAt(square) {
    const sq = parseSquare(String(square || ''));
    if (sq === undefined) return null;
    const p = this.position().board.get(sq);
    return p ? { color: p.color, role: p.role } : null;
  }

  /** Node by id, or null. */
  node(id) {
    return this._index.get(id) || null;
  }

  /** Nodes root … current. */
  path() {
    const out = [];
    let n = this.current;
    while (n) {
      out.push(n);
      n = n.parentId ? this._index.get(n.parentId) : null;
    }
    return out.reverse();
  }

  /** Nodes root … end of the main line (children[0] all the way). */
  mainline() {
    const out = [this.root];
    let n = this.root;
    while (n.children.length) {
      n = n.children[0];
      out.push(n);
    }
    return out;
  }

  /** True when the node sits on the main line. */
  isOnMainline(nodeId) {
    let n = this.root;
    for (;;) {
      if (n.id === nodeId) return true;
      if (!n.children.length) return false;
      n = n.children[0];
    }
  }

  /** Total nodes in the tree (root included). */
  nodeCount() {
    return this._index.size;
  }

  /** True when at least one move has been played from the root. */
  hasMoves() {
    return this.root.children.length > 0;
  }

  /** Child indexes root→current (for autosave cursors). */
  cursor() {
    const out = [];
    const path = this.path();
    for (let i = 1; i < path.length; i++) out.push(path[i - 1].children.indexOf(path[i]));
    return out;
  }

  /** Move current along child indexes from the root; stops early on a bad index. */
  gotoCursor(indexes) {
    let n = this.root;
    for (const i of indexes || []) {
      const c = n.children[i];
      if (!c) break;
      n = c;
    }
    return this.goto(n.id);
  }

  /** All legal moves, or those from one square. Castling as king→king-destination (+ king→rook in Chess960 when the squares differ). */
  legalMoves(from) {
    const pos = this.position();
    const ctx = pos.ctx();
    const only = from === undefined || from === null ? undefined : parseSquare(String(from));
    if (from !== undefined && from !== null && only === undefined) return [];
    const out = [];
    const seen = new Set();
    const push = m => {
      const key = m.from + m.to + (m.promotion || '');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(m);
    };
    for (const [sq, dests] of pos.allDests(ctx)) {
      if (only !== undefined && sq !== only) continue;
      const piece = pos.board.get(sq);
      if (!piece) continue;
      const fromName = makeSquare(sq);
      // Plain king moves first so that an ambiguous castling king-destination dedupes onto them.
      const castlingTargets = [];
      for (const to of dests) {
        if (piece.role === 'king' && pos.board[pos.turn].has(to)) {
          castlingTargets.push(to);
          continue;
        }
        const toName = makeSquare(to);
        if (piece.role === 'pawn' && (squareRank(to) === 0 || squareRank(to) === 7)) {
          for (const p of PROMOTIONS) push({ from: fromName, to: toName, promotion: p });
        } else push({ from: fromName, to: toName });
      }
      for (const rookSq of castlingTargets) {
        const side = rookSq > sq ? 'h' : 'a';
        const kingTo = kingCastlesTo(pos.turn, side);
        const rookName = makeSquare(rookSq);
        const kingToName = makeSquare(kingTo);
        const plainKingMove = kingTo !== sq && dests.has(kingTo) && !pos.board[pos.turn].has(kingTo);
        if (kingTo === sq || plainKingMove) {
          // Degenerate: only the king→rook form can express this castling.
          push({ from: fromName, to: rookName });
          continue;
        }
        push({ from: fromName, to: kingToName });
        if (this.variant === 'chess960' && rookSq !== kingTo) push({ from: fromName, to: rookName });
      }
    }
    return out;
  }

  /** Unique destination squares from a square (promotions collapsed). */
  legalTargets(from) {
    const seen = new Set();
    const out = [];
    for (const m of this.legalMoves(from)) {
      if (!seen.has(m.to)) {
        seen.add(m.to);
        out.push(m.to);
      }
    }
    return out;
  }

  /** True when the move (object or UCI) is legal here; castling accepted in both forms. */
  isLegal(move) {
    const pos = this.position();
    const m = this._parseMove(move, pos);
    return !!m && pos.isLegal(m);
  }

  /** True when from→to is a knight jump. */
  isKnightJump(from, to) {
    return knightJump(from, to);
  }

  /** Game state of the current position. */
  status() {
    const pos = this.position();
    const ctx = pos.ctx();
    const check = ctx.checkers.nonEmpty();
    const checkmate = pos.isCheckmate(ctx);
    const stalemate = pos.isStalemate(ctx);
    const insufficientMaterial = pos.isInsufficientMaterial();
    const fiftyMoves = !checkmate && pos.halfmoves >= 100;
    const key = fenKey(this.current.fen);
    let repetition = 0;
    for (const n of this.path()) if (fenKey(n.fen) === key) repetition++;
    let outcome = null;
    let reason = 'playing';
    if (checkmate) {
      outcome = pos.turn === 'white' ? '0-1' : '1-0';
      reason = 'checkmate';
    } else if (stalemate) {
      outcome = '1/2-1/2';
      reason = 'stalemate';
    } else if (insufficientMaterial) {
      outcome = '1/2-1/2';
      reason = 'insufficient material';
    } else if (repetition >= 3) {
      outcome = '1/2-1/2';
      reason = 'threefold repetition';
    } else if (fiftyMoves) {
      outcome = '1/2-1/2';
      reason = 'fifty-move rule';
    } else if (check) {
      reason = 'check';
    }
    return { check, checkmate, stalemate, insufficientMaterial, fiftyMoves, repetition, outcome, reason };
  }

  /** SAN → boundary move in the current position, or null. Tolerates 0-0, e8Q, trailing !?/+#. */
  sanToMove(san) {
    if (typeof san !== 'string') return null;
    const pos = this.position();
    const text = san.trim().replace(/[!?]+$/, '').replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O').replace(/[–—]/g, '-');
    const m = parseSan(pos, text);
    return m ? this._boundaryMove(pos, m) : null;
  }

  /** Move → SAN in the current position, or null when illegal. */
  moveToSan(move) {
    const pos = this.position();
    const m = this._parseMove(move, pos);
    if (!m || !pos.isLegal(m)) return null;
    return makeSan(pos, m);
  }

  /** Move → UCI in the boundary form, or null. */
  moveToUci(move) {
    const pos = this.position();
    const m = this._parseMove(move, pos);
    if (!m) return null;
    const b = this._boundaryMove(pos, m);
    return b.from + b.to + (b.promotion || '');
  }

  /** Move → the UCI string Stockfish expects for this variant (king takes rook in Chess960). */
  engineUci(move) {
    const pos = this.position();
    const m = this._parseMove(move, pos);
    if (!m) return null;
    const side = castlingSide(pos, m);
    if (!side) return makeUci(m);
    if (this.variant === 'chess960') {
      const rook = pos.castles.rook[pos.turn][side];
      return makeSquare(m.from) + makeSquare(rook === undefined ? m.to : rook);
    }
    return makeSquare(m.from) + makeSquare(kingCastlesTo(pos.turn, side));
  }

  /** Engine PV (UCI list) → SAN list in the current position; stops at the first illegal move. */
  pvToSan(uciList) {
    const pos = this.position().clone();
    const out = [];
    for (const uci of uciList || []) {
      const m = this._parseMove(uci, pos);
      if (!m || !pos.isLegal(m)) break;
      out.push(makeSanAndPlay(pos, m));
    }
    return out;
  }

  /** UCI → boundary move (castling normalised when it is castling here), or null. */
  uciToMove(uci) {
    if (typeof uci !== 'string') return null;
    const pos = this.position();
    const m = this._parseMove(uci, pos);
    if (!m) return null;
    if (castlingSide(pos, m) && pos.isLegal(m)) return this._boundaryMove(pos, m);
    const out = { from: makeSquare(m.from), to: makeSquare(m.to) };
    if (m.promotion) out.promotion = roleToChar(m.promotion);
    return out;
  }

  // ───────────────────────── playing / navigating ─────────────────────────

  /** Play a move from the current node. Throws Error('illegal move'). Reuses an identical child. */
  play(move) {
    const pos = this.position();
    const m = this._parseMove(move, pos);
    if (!m || !pos.isLegal(m)) throw new Error('illegal move');
    const piece = pos.board.get(m.from);
    const side = castlingSide(pos, m);
    const castle = side === 'h' ? 'king' : side === 'a' ? 'queen' : null;
    let captured = null;
    let enPassant = false;
    if (!castle) {
      const target = pos.board.get(m.to);
      if (target) captured = target.role;
      else if (piece.role === 'pawn' && pos.epSquare === m.to && squareFile(m.from) !== squareFile(m.to)) {
        captured = 'pawn';
        enPassant = true;
      }
    }
    const boundary = this._boundaryMove(pos, m);
    const uci = boundary.from + boundary.to + (boundary.promotion || '');
    const promotion = boundary.promotion || null;
    const existing = this.current.children.find(c => c.uci === uci);
    if (existing) {
      this.current = existing;
      this._invalidate();
      return {
        node: existing, san: existing.san, captured, castle, enPassant, promotion,
        check: existing.check, checkmate: existing.checkmate, reused: true,
      };
    }
    const next = pos.clone();
    const san = makeSanAndPlay(next, m);
    const fen = makeFen(next.toSetup());
    const check = next.isCheck();
    const checkmate = next.isCheckmate();
    const node = this._newNode({
      ply: this.current.ply + 1, san, uci, move: boundary, fen, check, checkmate, captured, parentId: this.current.id,
    });
    this.current.children.push(node);
    this.current = node;
    this._cache = { id: node.id, pos: next };
    return { node, san, captured, castle, enPassant, promotion, check, checkmate, reused: false };
  }

  /** Jump to a node by id (unknown id → stays put). Returns the current node. */
  goto(nodeId) {
    const n = this._index.get(nodeId);
    if (n && n !== this.current) {
      this.current = n;
      this._invalidate();
    }
    return this.current;
  }

  /** Parent of current, or null at the root. */
  back() {
    if (!this.current.parentId) return null;
    return this.goto(this.current.parentId);
  }

  /** children[0] of current, or null at a leaf. */
  forward() {
    const c = this.current.children[0];
    return c ? this.goto(c.id) : null;
  }

  /** Jump to the root. */
  toStart() {
    return this.goto(this.root.id);
  }

  /** Follow children[0] from current to the end of the line. */
  toEnd() {
    let n = this.current;
    while (n.children.length) n = n.children[0];
    return this.goto(n.id);
  }

  _siblings() {
    const p = this.current.parentId ? this._index.get(this.current.parentId) : null;
    return p ? p.children : [this.current];
  }

  /** Next sibling variation of current, or null. */
  nextVariation() {
    const sib = this._siblings();
    const i = sib.indexOf(this.current);
    return i >= 0 && i + 1 < sib.length ? this.goto(sib[i + 1].id) : null;
  }

  /** Previous sibling variation of current, or null. */
  prevVariation() {
    const sib = this._siblings();
    const i = sib.indexOf(this.current);
    return i > 0 ? this.goto(sib[i - 1].id) : null;
  }

  /** Make the node children[0] of its parent (one level). */
  promoteVariation(nodeId) {
    const n = this._index.get(nodeId);
    if (!n || !n.parentId) return;
    const p = this._index.get(n.parentId);
    const i = p.children.indexOf(n);
    if (i > 0) {
      p.children.splice(i, 1);
      p.children.unshift(n);
    }
  }

  /** Promote the node all the way up so it lies on the main line. */
  makeMainline(nodeId) {
    let n = this._index.get(nodeId);
    while (n && n.parentId) {
      this.promoteVariation(n.id);
      n = this._index.get(n.parentId);
    }
  }

  /** Remove a subtree; current moves to its parent. On the root: clears all moves. Returns the new current. */
  deleteFrom(nodeId) {
    const n = this._index.get(nodeId);
    if (!n) return this.current;
    const drop = node => {
      this._index.delete(node.id);
      for (const c of node.children) drop(c);
    };
    if (!n.parentId) {
      for (const c of n.children) drop(c);
      n.children = [];
      return this.goto(n.id);
    }
    const p = this._index.get(n.parentId);
    const inside = this.path().includes(n);
    p.children.splice(p.children.indexOf(n), 1);
    drop(n);
    if (inside) {
      this.current = p;
      this._invalidate();
    }
    return this.current;
  }

  // ───────────────────────── annotations ─────────────────────────

  /** Set the free-text note of a node. */
  setNote(nodeId, text) {
    const n = this._index.get(nodeId);
    if (n) n.note = typeof text === 'string' ? text : '';
  }

  /** Set the NAG glyph ('' clears; unknown glyphs are ignored). */
  setNag(nodeId, nag) {
    const n = this._index.get(nodeId);
    if (!n) return;
    n.nag = !nag ? '' : NAG_GLYPHS.includes(nag) ? nag : n.nag;
  }

  /** Replace the arrows of a node (invalid entries dropped, knight flag recomputed). */
  setArrows(nodeId, arrows) {
    const n = this._index.get(nodeId);
    if (n) n.arrows = (arrows || []).map(cleanArrow).filter(Boolean);
  }

  /** Replace the highlights of a node. */
  setHighlights(nodeId, highlights) {
    const n = this._index.get(nodeId);
    if (n) n.highlights = (highlights || []).map(cleanHighlight).filter(Boolean);
  }

  /** Set (or clear with null) the stored engine evaluation of a node. */
  setEval(nodeId, ev) {
    const n = this._index.get(nodeId);
    if (n) n.eval = cleanEval(ev);
  }

  /** Toggle an arrow: same from/to (any colour) removes it; returns true when added. */
  toggleArrow(nodeId, arrow) {
    const n = this._index.get(nodeId);
    const a = cleanArrow(arrow);
    if (!n || !a) return false;
    const i = n.arrows.findIndex(x => x.from === a.from && x.to === a.to);
    if (i >= 0) {
      n.arrows.splice(i, 1);
      return false;
    }
    n.arrows.push(a);
    return true;
  }

  /** Toggle a highlight: same square+colour removes; same square other colour recolours; returns true when present after. */
  toggleHighlight(nodeId, square, color) {
    const n = this._index.get(nodeId);
    const h = cleanHighlight({ square, color });
    if (!n || !h) return false;
    const i = n.highlights.findIndex(x => x.square === h.square);
    if (i >= 0) {
      if (n.highlights[i].color === h.color) {
        n.highlights.splice(i, 1);
        return false;
      }
      n.highlights[i] = h;
      return true;
    }
    n.highlights.push(h);
    return true;
  }

  // ───────────────────────── export ─────────────────────────

  /** PGN with headers and the full tree; notes as comments, arrows/highlights as %cal/%csl, evals as %eval. */
  toPgn() {
    const headers = defaultHeaders();
    for (const [k, v] of this.headers) headers.set(k, v);
    if (this.startFen !== INITIAL_FEN) {
      headers.set('SetUp', '1');
      headers.set('FEN', this.startFen);
    } else {
      headers.delete('SetUp');
      headers.delete('FEN');
    }
    if (this.variant === 'chess960') headers.set('Variant', 'Chess960');
    else headers.delete('Variant');
    const result = headers.get('Result');
    if (!result || result === '*') {
      const end = this.mainline().at(-1);
      const pos = end === this.current ? this.position() : loadPosition(end.fen);
      const outcome = pos.outcome();
      headers.set('Result', !outcome ? '*' : outcome.winner === 'white' ? '1-0' : outcome.winner === 'black' ? '0-1' : '1/2-1/2');
    }
    const convert = node => {
      const data = { san: node.san };
      const comment = commentOf(node);
      if (comment) data.comments = [comment];
      const nag = nagToNumber(node.nag);
      if (nag) data.nags = [nag];
      const out = new PgnChildNode(data);
      out.children = node.children.map(convert);
      return out;
    };
    const moves = new PgnNode();
    moves.children = this.root.children.map(convert);
    const game = { headers, moves };
    const rootComment = commentOf(this.root);
    if (rootComment) game.comments = [rootComment];
    return makePgn(game);
  }

  /** Plain object: { version:1, variant, chess960Number, startFen, headers:{}, tree } (no ids, no parentId). */
  toJSON() {
    const serialize = node => ({
      ply: node.ply,
      san: node.san,
      uci: node.uci,
      move: node.move ? { ...node.move } : null,
      fen: node.fen,
      check: node.check,
      checkmate: node.checkmate,
      captured: node.captured,
      note: node.note,
      nag: node.nag,
      arrows: node.arrows.map(a => ({ ...a })),
      highlights: node.highlights.map(h => ({ ...h })),
      eval: node.eval ? { ...node.eval, pv: [...node.eval.pv] } : null,
      children: node.children.map(serialize),
    });
    return {
      version: 1,
      variant: this.variant,
      chess960Number: this.chess960Number,
      startFen: this.startFen,
      headers: Object.fromEntries(this.headers),
      tree: serialize(this.root),
    };
  }
}

// ───────────────────────── helpers (module-private) ─────────────────────────

function copyAnnotations(node, src) {
  if (typeof src.note === 'string') node.note = src.note;
  if (typeof src.nag === 'string' && NAG_GLYPHS.includes(src.nag)) node.nag = src.nag;
  if (Array.isArray(src.arrows)) node.arrows = src.arrows.map(cleanArrow).filter(Boolean);
  if (Array.isArray(src.highlights)) node.highlights = src.highlights.map(cleanHighlight).filter(Boolean);
  if (src.eval) node.eval = cleanEval(src.eval);
}

/** Parse a PGN comment into note/arrows/highlights/eval on the node (append=true keeps an existing note). */
function applyCommentText(node, text, append = false) {
  const c = parseComment(text);
  if (c.text) node.note = append && node.note ? node.note + '\n' + c.text : c.text;
  for (const s of c.shapes) {
    const from = makeSquare(s.from);
    const to = makeSquare(s.to);
    if (s.from === s.to) {
      if (!node.highlights.some(h => h.square === from)) node.highlights.push({ square: from, color: s.color });
    } else if (!node.arrows.some(a => a.from === from && a.to === to)) {
      node.arrows.push({ from, to, color: s.color, knight: knightJump(from, to) });
    }
  }
  if (c.evaluation && !node.eval) {
    const ev = c.evaluation;
    node.eval = cleanEval('mate' in ev
      ? { mate: ev.mate, depth: ev.depth || 0, pv: [] }
      : { cp: Math.round(ev.pawns * 100), depth: ev.depth || 0, pv: [] });
  }
}

function commentOf(node) {
  const shapes = [];
  for (const h of node.highlights) {
    const sq = parseSquare(h.square);
    if (sq !== undefined) shapes.push({ color: h.color, from: sq, to: sq });
  }
  for (const a of node.arrows) {
    const from = parseSquare(a.from);
    const to = parseSquare(a.to);
    if (from !== undefined && to !== undefined) shapes.push({ color: a.color, from, to });
  }
  const comment = { text: node.note || undefined, shapes };
  if (node.eval) {
    comment.evaluation = typeof node.eval.mate === 'number'
      ? { mate: node.eval.mate, depth: node.eval.depth || undefined }
      : { pawns: (node.eval.cp || 0) / 100, depth: node.eval.depth || undefined };
  }
  if (!comment.text && !shapes.length && !comment.evaluation) return '';
  return makeComment(comment);
}
