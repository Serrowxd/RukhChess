// core/io.js — study serialisation: YAML (human-first), JSON (autosave), PGN wrappers, URL hash, download.
// Owns the YAML layout from CONTRACT.md. Uses js-yaml 5's AST (jsToAst → visit → present) so that
// arrows / highlights / eval / bare moves come out in flow style exactly as the contract shows.
//
// API added beyond CONTRACT.md:
//   studyToJSON() includes `cursor: number[]` (child indexes root→current) and `version`; studyFromJSON
//     restores the cursor so an autosave restore lands on the same node.
//   studyFromYaml / studyFromJSON return `warnings: string[]` alongside the study (illegal moves that
//     were dropped by Game.fromJSON); `game.warnings` carries the same list.
//   decodeHash() also accepts a bare FEN after '#' (no key) and '?'-style pairs.
//   yamlTreeFromMoves / movesFromTree exported for tests.
//   YAML carries an optional top-level `headers:` mapping (PGN headers: White / Black / Event / Date /
//     Result …, placeholders and the derived SetUp/FEN/Variant omitted). Additive to the CONTRACT.md
//     layout, which tolerates missing keys; without it PGN -> .yaml -> .pgn lost the players and the result.

import { dump as yamlDump, load as yamlLoad, jsToAst, present, visit, COLLECTION_STYLE, DUMP_SCHEMA } from 'js-yaml';
import { Game, INITIAL_FEN } from './game.js';

/** Version of the study container (YAML `chessboard:` key and JSON `version`). */
export const STUDY_VERSION = 1;

const FLOW_MAPPING_KEYS = new Set(['from', 'to', 'color', 'knight', 'source', 'square', 'cp', 'mate', 'depth', 'best', 'pv', 'san', 'uci', 'fen']);
// PGN headers worth keeping in the YAML: chessops' placeholders carry nothing, and SetUp/FEN/Variant are
// recomputed from start_fen / variant by Game.toPgn(), so writing them back would only let them drift.
const PGN_PLACEHOLDER_HEADERS = new Set(['?', '*', '????.??.??']);
const DERIVED_PGN_HEADERS = new Set(['SetUp', 'FEN', 'Variant']);
const BARE_MOVE_KEYS = new Set(['san', 'uci', 'fen']);
const FLOW_SEQUENCE_KEYS = new Set(['arrows', 'highlights', 'pv']);

/** Today as YYYY-MM-DD (local time). */
export function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ───────────────────────── YAML ─────────────────────────

function annotationsOf(node) {
  const out = {};
  if (node.note) out.note = node.note;
  if (node.nag) out.nag = node.nag;
  if (node.arrows && node.arrows.length) {
    out.arrows = node.arrows.map(a => {
      const e = { from: a.from, to: a.to, color: a.color };
      if (a.source && a.source !== 'user') e.source = a.source;
      return e;
    });
  }
  if (node.highlights && node.highlights.length) {
    out.highlights = node.highlights.map(h => ({ square: h.square, color: h.color }));
  }
  if (node.eval) {
    const ev = {};
    if (typeof node.eval.mate === 'number') ev.mate = node.eval.mate;
    else ev.cp = node.eval.cp;
    ev.depth = node.eval.depth || 0;
    if (node.eval.best) ev.best = node.eval.best;
    if (node.eval.pv && node.eval.pv.length) ev.pv = [...node.eval.pv];
    out.eval = ev;
  }
  return out;
}

/** The PGN headers worth serialising: no placeholders, nothing that toPgn() recomputes. */
function pgnHeadersOf(game) {
  const out = {};
  for (const [k, v] of game.headers) {
    if (typeof v !== 'string' || !v || DERIVED_PGN_HEADERS.has(k)) continue;
    if (PGN_PLACEHOLDER_HEADERS.has(v)) continue;
    out[k] = v;
  }
  return out;
}

function moveEntry(node) {
  return { san: node.san, uci: node.uci, fen: node.fen, ...annotationsOf(node) };
}

/** Main line from `node` (children[0] chain) as YAML move entries; sibling variations attached at branch points. */
export function movesFromTree(node) {
  const out = [];
  let cur = node;
  while (cur.children.length) {
    const main = cur.children[0];
    const entry = moveEntry(main);
    if (cur.children.length > 1) {
      entry.variations = cur.children.slice(1).map(alt => ({ moves: [moveEntry(alt), ...movesFromTree(alt)] }));
    }
    out.push(entry);
    cur = main;
  }
  return out;
}

function nodeFromEntry(e) {
  const node = { children: [] };
  if (typeof e.san === 'string') node.san = e.san;
  if (typeof e.uci === 'string') node.uci = e.uci;
  if (typeof e.note === 'string') node.note = e.note;
  if (typeof e.nag === 'string') node.nag = e.nag;
  if (Array.isArray(e.arrows)) node.arrows = e.arrows;
  if (Array.isArray(e.highlights)) node.highlights = e.highlights;
  if (e.eval && typeof e.eval === 'object') node.eval = e.eval;
  return node;
}

/** YAML move entries → JSON tree children (inverse of movesFromTree). */
export function yamlTreeFromMoves(moves) {
  if (!Array.isArray(moves) || !moves.length) return [];
  const first = moves[0];
  if (!first || typeof first !== 'object') return yamlTreeFromMoves(moves.slice(1));
  const node = nodeFromEntry(first);
  node.children = yamlTreeFromMoves(moves.slice(1));
  const siblings = [];
  for (const v of Array.isArray(first.variations) ? first.variations : []) {
    if (v && typeof v === 'object') siblings.push(...yamlTreeFromMoves(v.moves));
  }
  return [node, ...siblings];
}

function styleAst(docs) {
  visit(docs, (node, ctx) => {
    if (node.kind === 'mapping') {
      const keys = node.items.map(p => (p.key && p.key.kind === 'scalar' ? p.key.value : ''));
      const bare = keys.length > 0 && keys.every(k => BARE_MOVE_KEYS.has(k));
      const annotationObj = keys.length > 0 && keys.every(k => FLOW_MAPPING_KEYS.has(k)) && !keys.includes('san');
      if (bare || annotationObj) node.style = COLLECTION_STYLE.FLOW;
    } else if (node.kind === 'sequence' && ctx.parent && ctx.parent.kind === 'mapping') {
      const pair = ctx.parent.items.find(p => p.value === node);
      if (pair && pair.key.kind === 'scalar' && FLOW_SEQUENCE_KEYS.has(pair.key.value)) node.style = COLLECTION_STYLE.FLOW;
    }
    return undefined;
  });
}

/** Study → human-first YAML (see CONTRACT.md layout). */
export function studyToYaml(study) {
  const game = study.game;
  if (!(game instanceof Game)) throw new Error('study.game must be a Game');
  const doc = { chessboard: STUDY_VERSION };
  if (study.title) doc.title = study.title;
  doc.created = study.created || today();
  doc.variant = game.variant;
  doc.chess960 = game.chess960Number === undefined ? null : game.chess960Number;
  doc.start_fen = game.startFen;
  doc.orientation = study.orientation === 'black' ? 'black' : 'white';
  const headers = pgnHeadersOf(game);
  if (Object.keys(headers).length) doc.headers = headers;
  if (study.notes) doc.notes = study.notes;
  const start = annotationsOf(game.root);
  if (Object.keys(start).length) doc.start = start;
  doc.moves = movesFromTree(game.root);
  const docs = jsToAst(doc, DUMP_SCHEMA, { noRefs: true, skipInvalid: true });
  styleAst(docs);
  return present(docs, { schema: DUMP_SCHEMA, lineWidth: -1 });
}

/** YAML → study { title, created, notes, orientation, game, warnings }. Throws with a readable reason. */
export function studyFromYaml(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty YAML');
  let doc;
  try {
    doc = yamlLoad(text);
  } catch (e) {
    // No 'YAML: ' prefix here — actions.loadYaml adds exactly one, and two read as "YAML: YAML: …".
    throw new Error(e && e.message ? e.message.split('\n')[0] : 'parse error');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('expected a mapping at the top level');
  if (doc.chessboard !== undefined && doc.chessboard !== STUDY_VERSION) {
    throw new Error(`unsupported chessboard version ${doc.chessboard}`);
  }
  if (doc.chessboard === undefined && !Array.isArray(doc.moves) && !doc.start_fen) {
    throw new Error('not a chessboard study (no chessboard:, start_fen: or moves: key)');
  }
  const start = doc.start && typeof doc.start === 'object' ? doc.start : {};
  const tree = { ...nodeFromEntry(start), children: yamlTreeFromMoves(doc.moves) };
  let game;
  try {
    game = Game.fromJSON({
      version: 1,
      variant: doc.variant === 'chess960' ? 'chess960' : doc.variant === 'standard' ? 'standard' : undefined,
      chess960Number: Number.isInteger(doc.chess960) ? doc.chess960 : undefined,
      startFen: typeof doc.start_fen === 'string' && doc.start_fen ? doc.start_fen : INITIAL_FEN,
      headers: doc.headers && typeof doc.headers === 'object' && !Array.isArray(doc.headers) ? doc.headers : {},
      tree,
    });
  } catch (e) {
    throw new Error(`start_fen: ${e.message}`);
  }
  return {
    title: typeof doc.title === 'string' ? doc.title : '',
    created: typeof doc.created === 'string' ? doc.created : doc.created instanceof Date ? doc.created.toISOString().slice(0, 10) : today(),
    notes: typeof doc.notes === 'string' ? doc.notes : '',
    orientation: doc.orientation === 'black' ? 'black' : 'white',
    game,
    warnings: [...game.warnings],
  };
}

// ───────────────────────── JSON (autosave) ─────────────────────────

/** Study → plain object for localStorage. */
export function studyToJSON(study) {
  const game = study.game;
  return {
    version: STUDY_VERSION,
    title: study.title || '',
    created: study.created || today(),
    notes: study.notes || '',
    orientation: study.orientation === 'black' ? 'black' : 'white',
    cursor: game.cursor(),
    game: game.toJSON(),
  };
}

/** Plain object → study { title, created, notes, orientation, game, warnings }. Throws on garbage. */
export function studyFromJSON(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('not a study object');
  if (obj.version !== undefined && obj.version !== STUDY_VERSION) throw new Error(`unsupported study version ${obj.version}`);
  const game = Game.fromJSON(obj.game || { version: 1, startFen: INITIAL_FEN, tree: {} });
  if (Array.isArray(obj.cursor)) game.gotoCursor(obj.cursor);
  return {
    title: typeof obj.title === 'string' ? obj.title : '',
    created: typeof obj.created === 'string' ? obj.created : today(),
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    orientation: obj.orientation === 'black' ? 'black' : 'white',
    game,
    warnings: [...game.warnings],
  };
}

// ───────────────────────── PGN wrappers ─────────────────────────

/** Game → PGN text. */
export function gameToPgn(game) {
  return game.toPgn();
}

/** PGN text → Game (throws on no game / bad start position). */
export function gameFromPgn(text) {
  return Game.fromPgn(text);
}

// ───────────────────────── URL hash ─────────────────────────

/** '#fen=…' when the study has no moves, else '#pgn=…' (encodeURIComponent). */
export function encodeHash(study) {
  const game = study.game;
  if (!game.hasMoves()) return '#fen=' + encodeURIComponent(game.fen());
  return '#pgn=' + encodeURIComponent(game.toPgn());
}

const FEN_LIKE = /^[prnbqkPRNBQK1-8]+(\/[prnbqkPRNBQK1-8]+){7}(\s+[wb](\s+\S+){0,4})?$/;

/** '#fen=…' / '#pgn=…' → { fen } | { pgn } | null. */
export function decodeHash(hash) {
  if (typeof hash !== 'string') return null;
  let text = hash.trim();
  if (text.startsWith('#')) text = text.slice(1);
  if (text.startsWith('?')) text = text.slice(1);
  if (!text) return null;
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).toLowerCase();
    let value;
    try {
      value = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    } catch (_) {
      continue;
    }
    if (key === 'fen' && value.trim()) return { fen: value.trim() };
    if (key === 'pgn' && value.trim()) return { pgn: value };
  }
  let bare;
  try {
    bare = decodeURIComponent(text).trim();
  } catch (_) {
    return null;
  }
  if (FEN_LIKE.test(bare)) return { fen: bare };
  return null;
}

// ───────────────────────── browser helper ─────────────────────────

/** Trigger a file download in the browser; returns false (no-op) outside a browser. */
export function download(filename, text, mime = 'text/plain') {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') return false;
  try {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
    return true;
  } catch (_) {
    return false;
  }
}

// Keep a plain dump available for callers that want default styling (not used by studyToYaml).
export { yamlDump as dumpYaml, yamlLoad as loadYaml };
