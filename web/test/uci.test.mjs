// Engine module: the UCI parser helpers, then the driver (src/engine/stockfish.js) against the real engine.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { Chess } from 'chessops/chess';
import { parseFen, makeFen } from 'chessops/fen';
import { makeSan } from 'chessops/san';
import { parseUci, makeUci, makeSquare, parseSquare } from 'chessops/util';
import { parseInfo, parseBestMove, toWhiteView, turnFromFen, formatScore, fenKey, parseOption, parseId } from '../src/engine/uci.js';
import { createEngine } from '../src/engine/stockfish.js';

// Real lines from vendor/stockfish-19-lite-single.js in node CLI mode; `wdl` is synthesised.
const L = {
  mp1: 'info depth 8 seldepth 12 multipv 1 score cp -25 nodes 16754 nps 598357 hashfull 5 time 28 pv e7e6 d2d4 d7d5 b1c3 d5e4 c3e4',
  mp2: 'info depth 8 seldepth 10 multipv 2 score cp -28 nodes 16754 nps 598357 hashfull 5 time 28 pv c7c5 b1c3 e7e6 g1f3 b8c6 d2d4 c5d4 f3d4',
  mp3: 'info depth 8 seldepth 16 multipv 3 score cp -44 nodes 16754 nps 598357 hashfull 5 time 28 pv e7e5 g1f3 b8c6 d2d4 e5d4 f3d4 g8f6 b1c3 f8b4 c1g5',
  d10: 'info depth 10 seldepth 12 multipv 1 score cp 31 nodes 9492 nps 431454 hashfull 2 time 22 pv e2e4 c7c5 g1f3 b8c6 b1c3 e7e6 d2d4 c5d4 f3d4',
  mate1: 'info depth 7 seldepth 2 multipv 1 score mate 1 nodes 1625 nps 1625000 hashfull 0 time 1 pv h5f7',
  mated: 'info depth 0 score mate 0',
  stalemate: 'info depth 0 score cp 0',
  bound: 'info depth 16 seldepth 17 multipv 1 score cp 32 lowerbound nodes 269541 nps 816790 hashfull 86 time 330 pv e2e4 e7e5',
  str1: 'info string NNUE evaluation using nn-61e7af4bb97d.nnue (1MiB, (768, 1024, 32, 32, 1))',
  str2: 'info string Network replica 1: Local memory. Shared memory not supported by the OS. Local allocation fallback.',
  currmove: 'info depth 12 currmove e2e4 currmovenumber 2',
  wdl: 'info depth 10 seldepth 12 multipv 1 score cp 31 wdl 120 850 30 nodes 9492 nps 431454 hashfull 2 time 22 pv e2e4 c7c5',
  bm: 'bestmove e2e4 ponder c7c5',
  bmNone: 'bestmove (none)',
  bm960: 'bestmove b1c3 ponder e8h8',
  optElo: 'option name UCI_Elo type spin default 1320 min 1320 max 3190',
  optClear: 'option name Clear Hash type button',
  optEval: 'option name EvalFile type string default nn-61e7af4bb97d.nnue',
  idName: 'id name Stockfish 19 Lite WASM',
};

describe('parseInfo', () => {
  it('parses MultiPV lines with score, counters and pv', () => {
    const a = parseInfo(L.mp1);
    assert.deepEqual({ depth: a.depth, seldepth: a.seldepth, multipv: a.multipv, score: a.score, nodes: a.nodes, nps: a.nps, time: a.time },
      { depth: 8, seldepth: 12, multipv: 1, score: { cp: -25 }, nodes: 16754, nps: 598357, time: 28 });
    assert.deepEqual(a.pv, ['e7e6', 'd2d4', 'd7d5', 'b1c3', 'd5e4', 'c3e4']);
    assert.equal(a.bound, undefined);

    assert.equal(parseInfo(L.mp2).multipv, 2);
    assert.deepEqual(parseInfo(L.mp2).score, { cp: -28 });
    assert.equal(parseInfo(L.mp3).multipv, 3);
    assert.equal(parseInfo(L.mp3).pv.length, 10);
    assert.equal(parseInfo(L.d10).pv[0], 'e2e4');
  });

  it('parses mate scores', () => {
    const m = parseInfo(L.mate1);

    assert.deepEqual(m.score, { mate: 1 });
    assert.deepEqual(m.pv, ['h5f7']);
    assert.equal(m.depth, 7);
  });

  it('parses terminal positions (depth 0, no pv)', () => {
    assert.deepEqual(parseInfo(L.mated), { depth: 0, seldepth: 0, multipv: 1, score: { mate: 0 }, nodes: 0, nps: 0, time: 0, pv: [] });
    assert.deepEqual(parseInfo(L.stalemate).score, { cp: 0 });
  });

  it('flags lowerbound / upperbound lines', () => {
    assert.equal(parseInfo(L.bound).bound, 'lower');
    assert.equal(parseInfo(L.bound.replace('lowerbound', 'upperbound')).bound, 'upper');
    assert.deepEqual(parseInfo(L.bound).pv, ['e2e4', 'e7e5']);
  });

  it('truncates a pv at the first non-move token instead of splicing around it', () => {
    // A filter would give ['e2e4','e7e5'], a line that never happened.
    assert.deepEqual(parseInfo('info depth 8 score cp 12 pv e2e4 <garbage> e7e5').pv, ['e2e4']);
    assert.deepEqual(parseInfo('info depth 8 score cp 12 pv e2e4 e7e5').pv, ['e2e4', 'e7e5']);
    assert.deepEqual(parseInfo('info depth 8 score cp 12 pv').pv, []);
    assert.deepEqual(parseInfo('info depth 8 score cp 12 pv e1h1 e8a8').pv, ['e1h1', 'e8a8']);  // Chess960 form
  });

  it('ignores info string, currmove and node-count-only lines', () => {
    assert.equal(parseInfo(L.str1), null);
    assert.equal(parseInfo(L.str2), null);
    assert.equal(parseInfo(L.currmove), null);
    assert.equal(parseInfo('info nodes 1000 nps 500 time 2'), null);
    assert.equal(parseInfo('readyok'), null);
    assert.equal(parseInfo(''), null);
    assert.equal(parseInfo(undefined), null);
  });

  it('reads wdl without disturbing the counters', () => {
    const w = parseInfo(L.wdl);

    assert.deepEqual(w.wdl, [120, 850, 30]);
    assert.equal(w.nodes, 9492);
    assert.deepEqual(w.pv, ['e2e4', 'c7c5']);
  });
});

describe('parseBestMove', () => {
  it('reads bestmove + ponder', () => {
    assert.deepEqual(parseBestMove(L.bm), { bestmove: 'e2e4', ponder: 'c7c5' });
    assert.deepEqual(parseBestMove(L.bm960), { bestmove: 'b1c3', ponder: 'e8h8' });
    assert.deepEqual(parseBestMove('bestmove e7e8q'), { bestmove: 'e7e8q', ponder: null });
  });

  it('maps (none) to null and rejects other lines', () => {
    assert.deepEqual(parseBestMove(L.bmNone), { bestmove: null, ponder: null });
    assert.equal(parseBestMove(L.mp1), null);
    assert.equal(parseBestMove('uciok'), null);
    assert.equal(parseBestMove(null), null);
  });
});

describe('score conversion', () => {
  it('negates for black to move, never yields -0', () => {
    assert.deepEqual(toWhiteView({ cp: -25 }, 'black'), { cp: 25 });
    assert.deepEqual(toWhiteView({ cp: 31 }, 'white'), { cp: 31 });
    assert.deepEqual(toWhiteView({ mate: 1 }, 'black'), { mate: -1 });
    assert.deepEqual(toWhiteView({ mate: -3 }, 'black'), { mate: 3 });
    assert.deepEqual(toWhiteView({ mate: 2 }, 'white'), { mate: 2 });

    const z = toWhiteView({ cp: 0 }, 'black');
    assert.ok(Object.is(z.cp, 0), 'cp 0 must not become -0');
    assert.equal(toWhiteView(null, 'white'), null);
  });

  it('marks the mated side on mate 0', () => {
    assert.deepEqual(toWhiteView({ mate: 0 }, 'white'), { mate: 0, mated: 'white' });
    assert.deepEqual(toWhiteView({ mate: 0 }, 'black'), { mate: 0, mated: 'black' });
  });

  it('turnFromFen', () => {
    assert.equal(turnFromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'), 'black');
    assert.equal(turnFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'), 'white');
    assert.equal(turnFromFen('garbage'), 'white');
  });

  it('formatScore', () => {
    assert.equal(formatScore({ cp: 31 }), '+0.31');
    assert.equal(formatScore({ cp: -25 }), '-0.25');
    assert.equal(formatScore({ cp: 0 }), '0.00');
    assert.equal(formatScore({ mate: 3 }), '#3');
    assert.equal(formatScore({ mate: -2 }), '#-2');
    assert.equal(formatScore({ mate: 0, mated: 'white' }), '#');
    assert.equal(formatScore(null), '--');
  });

  it('fenKey drops the move counters', () => {
    assert.equal(fenKey('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -');
    assert.equal(fenKey('  a b c d 5 6  '), 'a b c d');
    assert.equal(fenKey(null), '');
  });
});

describe('handshake helpers', () => {
  it('parseOption', () => {
    assert.deepEqual(parseOption(L.optElo), { name: 'UCI_Elo', type: 'spin', default: '1320', min: 1320, max: 3190, vars: [] });
    assert.deepEqual(parseOption(L.optClear), { name: 'Clear Hash', type: 'button', default: null, min: null, max: null, vars: [] });
    assert.equal(parseOption(L.optEval).default, 'nn-61e7af4bb97d.nnue');
    assert.equal(parseOption('uciok'), null);
  });

  it('parseId', () => {
    assert.deepEqual(parseId(L.idName), { key: 'name', value: 'Stockfish 19 Lite WASM' });
    assert.equal(parseId('option name Hash type spin'), null);
  });
});

// The driver against the real engine.

const here = dirname(fileURLToPath(import.meta.url));
const vendorDir = join(here, '..', 'vendor');
const GLUE = 'stockfish-19-lite-single.js';
const WASM = 'stockfish-19-lite-single.wasm';
const haveEngine = existsSync(join(vendorDir, GLUE)) && existsSync(join(vendorDir, WASM));

// The glue is CommonJS but the app package is "type": "module", so it runs from a staged CommonJS folder.
function stagedGlue() {
  const dir = join(tmpdir(), 'rukh-stockfish-test');
  mkdirSync(dir, { recursive: true });

  for (const f of [GLUE, WASM]) {
    const src = join(vendorDir, f), dst = join(dir, f);
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst);
  }

  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) writeFileSync(pkg, '{"type":"commonjs"}\n');
  return join(dir, GLUE);
}

/** A Worker-like shim over the glue's node CLI mode; `log.events` keeps both directions in one ordered list. */
function makeWorkerFactory(log) {
  return () => {
    const child = spawn(process.execPath, [stagedGlue()], { stdio: ['pipe', 'pipe', 'pipe'] });

    const shim = {
      onmessage: null, onerror: null,
      postMessage(s) {
        log.sent.push(s);
        log.events.push({ dir: '>', line: s });
        try {
          child.stdin.write(s + '\n');
        } catch (e) { /* closed */ }
      },
      terminate() {
        try {
          child.kill();
        } catch (e) { /* already gone */ }
      },
    };

    readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      log.received.push(line);
      log.events.push({ dir: '<', line });
      if (shim.onmessage) shim.onmessage({ data: line });
    });
    child.stderr.on('data', () => {});
    child.on('error', (err) => { if (shim.onerror) shim.onerror({ message: String(err) }); });

    log.workers.push(shim);
    return shim;
  };
}

/** A worker that accepts everything and answers nothing (handshake-timeout / dispose-mid-handshake tests). */
function makeDeafWorkerFactory(log) {
  return () => {
    const shim = {
      onmessage: null, onerror: null,
      postMessage(s) {
        log.sent.push(s);
        log.events.push({ dir: '>', line: s });
      },
      terminate() { log.terminated = (log.terminated || 0) + 1; },
    };
    log.workers.push(shim);
    return shim;
  };
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const SCHOLAR = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';          // Qxf7#
const FOOLS = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';                 // white is mated

// Chess960 mate in 1 by O-O-O, which must come back as b1a1 (b1c1 is a plain king move here).
const C960_MATE = '3k4/p1p1p3/1N3N2/8/8/8/8/RK6 w Q - 0 1';
// Chess960 opening position (Scharnagl #0): castling lives, both rooks off the a/h geometry.
const C960_OPEN = 'bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w KQkq - 0 1';
const STALEMATE = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';           // black to move, stalemated
const BLACK_MATES = 'r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1';   // black to move, mates in 1: Ra1#

/** Minimal Game stand-in with the contract methods the engine touches, backed by chessops. */
function makeGame(fen, variant = 'standard') {
  let pos = Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
  const moves = [];

  const toMove = (u) => {
    const m = parseUci(u);
    return m && pos.isLegal(m) ? m : null;
  };

  return {
    variant, startFen: fen,
    fen: () => makeFen(pos.toSetup()),
    turn: () => pos.turn,
    status: () => ({ outcome: pos.isEnd() ? (pos.isCheckmate() ? (pos.turn === 'white' ? '0-1' : '1-0') : '1/2-1/2') : null }),
    path: () => [{ uci: null }, ...moves.map(u => ({ uci: u }))],
    pvToSan: (pv) => {
      const p = pos.clone();
      const out = [];
      for (const u of pv) {
        const m = parseUci(u);
        if (!m || !p.isLegal(m)) break;
        out.push(makeSan(p, m));
        p.play(m);
      }
      return out;
    },
    uciToMove: (u) => {
      const m = toMove(u);
      return m ? { from: makeSquare(m.from), to: makeSquare(m.to), promotion: m.promotion } : null;
    },
    play(mv) {
      const m = { from: parseSquare(mv.from), to: parseSquare(mv.to), promotion: mv.promotion };
      if (!pos.isLegal(m)) throw new Error('illegal');
      pos.play(m);
      moves.push(makeUci(m));
    },
    moves,
  };
}

function makeHarness(fen, engineSettings = {}, opts = {}) {
  const listeners = new Map();

  const store = {
    state: {
      game: makeGame(fen, opts.variant || 'standard'), mode: 'play',
      settings: { engine: { enabled: false, multipv: 2, depth: 8, movetime: 0, skill: 20, elo: null, autoAnalyse: true, playMovetime: 150, ...engineSettings } },
      engine: { available: false, enabled: false, thinking: false, depth: 0, nodes: 0, nps: 0, score: null, lines: [], bestMove: null, playAs: null },
    },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return () => listeners.get(ev).delete(fn);
    },
    off(ev, fn) { if (listeners.has(ev)) listeners.get(ev).delete(fn); },
    emit(ev, payload) { for (const fn of [...(listeners.get(ev) || [])]) fn(payload); },
  };

  const calls = { lines: [], status: [], toasts: [], playAs: [] };

  const actions = {
    engineStatus(p) {
      calls.status.push(p);
      Object.assign(store.state.engine, p);
    },
    engineLines(lines, score, depth, bestMove) {
      calls.lines.push({ lines, score, depth, bestMove });
      Object.assign(store.state.engine, { lines, score, depth, bestMove });
    },
    engineSetPlayAs(c) {
      calls.playAs.push(c);
      store.state.engine.playAs = c;
    },
    playMove(mv) {
      const g = store.state.game;
      try {
        g.play(mv);
      } catch (e) {
        return null;
      }

      const node = { fen: g.fen(), move: mv };
      store.emit('game:change', { game: g, current: node, reason: 'move', move: { node } });
      store.emit('position:change', { fen: g.fen(), turn: g.turn(), node });
      return node;
    },
    toast(text, kind) { calls.toasts.push({ text, kind }); },
    setSetting(path, value) {
      const parts = path.split('.');
      let o = store.state.settings;
      for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
      o[parts[parts.length - 1]] = value;
      store.emit('settings:change', { path, value, settings: store.state.settings });
    },
  };

  const log = { sent: [], received: [], events: [], workers: [] };
  const factory = opts.deaf ? makeDeafWorkerFactory(log) : makeWorkerFactory(log);
  const engine = createEngine(store, actions, {
    createWorker: factory,
    handshakeTimeout: opts.handshakeTimeout !== undefined ? opts.handshakeTimeout : 20000,
  });

  return { store, actions, calls, log, engine };
}

function waitFor(pred, ms = 15000, every = 15) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();

    (function tick() {
      let v;
      try {
        v = pred();
      } catch (e) {
        reject(e);
        return;
      }

      if (v) {
        resolve(v);
        return;
      }

      if (Date.now() - t0 > ms) {
        reject(new Error('waitFor: timed out'));
        return;
      }

      setTimeout(tick, every);
    })();
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Every 'go' must be answered by a 'bestmove': at most one search is outstanding at any time. */
function assertOneGoInFlight(log) {
  const gos = log.sent.filter(s => s.startsWith('go ')).length;
  const bms = log.received.filter(s => s.startsWith('bestmove')).length;
  assert.ok(gos - bms >= 0 && gos - bms <= 1, 'at most one go without a bestmove (' + gos + ' go / ' + bms + ' bestmove)');
}

/** Strict version over the ordered transcript: no second go, position or setoption while a search runs. */
function assertQueueSane(log) {
  let searching = false;

  for (const e of log.events) {
    if (e.dir === '>' && e.line.startsWith('go')) {
      assert.ok(!searching, 'second "go" with no bestmove in between: ' + e.line + '\n' + transcript(log));
      searching = true;
    } else if (e.dir === '>' && (e.line.startsWith('position ') || e.line.startsWith('setoption '))) {
      assert.ok(!searching, 'sent "' + e.line.slice(0, 40) + '" while a search was still running\n' + transcript(log));
    } else if (e.dir === '<' && e.line.startsWith('bestmove')) {
      searching = false;
    }
  }
}

const transcript = (log) => log.events.filter(e => e.dir === '>' || /^bestmove|^uciok|^readyok/.test(e.line))
  .map(e => e.dir + ' ' + e.line.slice(0, 70)).join('\n');

describe('stockfish driver (real engine in node)', { skip: haveEngine ? false : 'vendor/ Stockfish files missing' }, () => {
  const live = [];
  afterEach(() => { for (const h of live.splice(0)) h.engine.dispose(); });

  it('handshakes, applies base options and reports available', { timeout: 20000 }, async () => {
    const h = makeHarness(START);
    live.push(h);

    await h.engine.ready;

    assert.match(h.engine.info.name, /Stockfish/);
    assert.ok(h.engine.info.options.has('MultiPV'));
    assert.equal(h.store.state.engine.available, true);
    assert.equal(h.engine.isAvailable(), true);
    assert.equal(h.engine.loadMode, 'custom');
    assert.ok(h.log.sent.includes('setoption name Hash value 32'));
    assert.ok(h.log.sent.includes('setoption name Threads value 1'));
    assert.ok(h.log.sent.includes('setoption name UCI_ShowWDL value false'));
    assert.ok(h.log.sent.includes('setoption name MultiPV value 2'));
    assert.equal(h.log.sent[0], 'uci');
  });

  it('start() analyses the board position, streams White-view lines with SAN, then rests idle; stop() clears', { timeout: 30000 }, async () => {
    const h = makeHarness(START);
    live.push(h);
    await h.engine.ready;
    // black to move: the engine reports negative cp, the store wants it positive
    h.actions.playMove({ from: 'e2', to: 'e4' });

    h.engine.start();
    assert.equal(h.store.state.settings.engine.enabled, true, 'start() syncs the setting');
    await waitFor(() => h.store.state.engine.lines.length >= 1 && h.store.state.engine.thinking === false && h.store.state.engine.depth >= 8);

    const e = h.store.state.engine;
    assert.equal(e.enabled, true);
    assert.equal(e.lines.length, 2, 'multipv 2');
    assert.deepEqual(e.lines.map(l => l.multipv), [1, 2]);
    assert.ok(e.lines[0].score.cp > 0, 'White view after 1.e4 is positive, got ' + JSON.stringify(e.lines[0].score));
    assert.ok(e.score.cp > 0);
    assert.ok(e.lines[0].san.length > 0 && /^[a-hNBRQKO]/.test(e.lines[0].san[0]), 'san looks like SAN: ' + e.lines[0].san[0]);
    assert.equal(e.lines[0].san.length, e.lines[0].pv.length, 'every pv move converted to SAN');
    assert.equal(e.bestMove, e.lines[0].pv[0]);
    assert.ok(h.log.sent.some(s => s === 'position fen ' + START + ' moves e2e4'), 'standard games are sent as start + moves');
    assert.ok(h.log.sent.includes('go depth 8'));
    assert.ok(h.log.sent.includes('ucinewgame'));
    assertOneGoInFlight(h.log);

    h.engine.stop();
    assert.equal(h.store.state.engine.lines.length, 0);
    assert.equal(h.store.state.engine.bestMove, null);
    assert.equal(h.store.state.engine.enabled, false);
    assert.equal(h.store.state.settings.engine.enabled, false);
  });

  it('a position change stops the running search, restarts on the new position and never overlaps go/bestmove', { timeout: 30000 }, async () => {
    const h = makeHarness(START, { depth: 0, movetime: 0 });   // go infinite
    live.push(h);
    await h.engine.ready;

    h.engine.start();
    await waitFor(() => h.store.state.engine.lines.length >= 1);
    assert.ok(h.log.sent.includes('go infinite'));

    // Jump to a mate-in-1 position via a fresh game (reason 'load'), then wait for the mate line.
    h.store.state.game = makeGame(SCHOLAR);
    h.store.state.settings.engine.depth = 8;
    h.store.emit('game:change', { game: h.store.state.game, current: null, reason: 'load' });
    h.store.emit('position:change', { fen: SCHOLAR, turn: 'white', node: null });
    await waitFor(() => h.store.state.engine.thinking === false && h.store.state.engine.score && h.store.state.engine.score.mate === 1);

    const e = h.store.state.engine;
    assert.deepEqual(e.lines[0].pv, ['h5f7']);
    assert.deepEqual(e.lines[0].san, ['Qxf7#']);
    assert.equal(e.bestMove, 'h5f7');
    assert.ok(h.log.sent.includes('stop'), 'the infinite search was stopped');
    assert.equal(h.log.sent.filter(s => s === 'ucinewgame').length, 2, 'ucinewgame again for the loaded game');
    assertOneGoInFlight(h.log);

    // No line pushed after the switch may belong to the old position.
    const switched = h.calls.lines.findIndex(c => c.lines[0] && c.lines[0].pv[0] === 'h5f7');
    assert.ok(switched >= 0);
    for (const c of h.calls.lines.slice(switched)) assert.ok(!c.lines[0] || c.lines[0].pv[0] === 'h5f7', 'stale lines dropped');
  });

  it('a checkmated position yields mate 0 with the mated side and finishes', { timeout: 20000 }, async () => {
    const h = makeHarness(FOOLS, { depth: 0, movetime: 0 });
    live.push(h);
    await h.engine.ready;

    h.engine.start();
    await waitFor(() => h.store.state.engine.score && h.store.state.engine.thinking === false);

    assert.deepEqual(h.store.state.engine.score, { mate: 0, mated: 'white' });
    assert.equal(h.store.state.engine.bestMove, null);
    assertOneGoInFlight(h.log);
  });

  it('bestMove() applies skill / elo, returns a legal move and restores full strength', { timeout: 30000 }, async () => {
    const h = makeHarness(START);
    live.push(h);
    await h.engine.ready;

    const u1 = await h.engine.bestMove(START, { movetime: 200, skill: 5, elo: 1500 });
    assert.ok(h.store.state.game.uciToMove(u1), 'legal: ' + u1);
    assert.ok(h.log.sent.includes('setoption name Skill Level value 5'));
    assert.ok(h.log.sent.includes('setoption name UCI_LimitStrength value true'));
    assert.ok(h.log.sent.includes('setoption name UCI_Elo value 1500'));
    assert.ok(h.log.sent.includes('go movetime 200'));

    const before = h.log.sent.length;
    const u2 = await h.engine.bestMove(START, { depth: 6 });
    assert.ok(h.store.state.game.uciToMove(u2));

    const after = h.log.sent.slice(before);
    assert.ok(after.includes('setoption name UCI_LimitStrength value false'));
    assert.ok(after.includes('setoption name Skill Level value 20'));
    assert.ok(after.includes('go depth 6'));
    assert.ok(!after.includes('ucinewgame'), 'ucinewgame only once per game');
    assertOneGoInFlight(h.log);
  });

  it('bestMove() takes over a running analysis and analysis resumes afterwards', { timeout: 30000 }, async () => {
    const h = makeHarness(START, { depth: 0, movetime: 0 });
    live.push(h);
    await h.engine.ready;
    h.engine.start();
    await waitFor(() => h.store.state.engine.lines.length >= 1);

    const u = await h.engine.bestMove(START, { movetime: 150 });

    assert.ok(h.store.state.game.uciToMove(u));
    await waitFor(() => h.log.sent.filter(s => s === 'go infinite').length >= 2, 5000);   // analysis restarted
    assertOneGoInFlight(h.log);
  });

  it('setPlayAs() moves for its colour, on every turn, and stops when cleared', { timeout: 40000 }, async () => {
    const h = makeHarness(START);
    live.push(h);
    await h.engine.ready;

    h.engine.setPlayAs('white');
    assert.deepEqual(h.calls.playAs, ['white']);
    await waitFor(() => h.store.state.game.moves.length === 1);
    assert.equal(h.store.state.game.turn(), 'black');
    assert.ok(h.log.sent.includes('go movetime 150'), 'settings.engine.playMovetime honoured');

    const g1 = h.store.state.game;
    h.actions.playMove(['e7e5', 'e7e6', 'd7d5', 'g8f6'].map(u => g1.uciToMove(u)).find(Boolean));
    await waitFor(() => h.store.state.game.moves.length === 3);
    assert.equal(h.store.state.game.turn(), 'black');

    h.engine.setPlayAs(null);
    assert.equal(h.store.state.engine.playAs, null);

    const g2 = h.store.state.game;
    h.actions.playMove(['b8c6', 'g8f6', 'd7d6', 'a7a6', 'h7h6'].map(u => g2.uciToMove(u)).find(Boolean));
    await sleep(500);
    assert.equal(h.store.state.game.moves.length, 4, 'engine stays quiet once playAs is null');
    assert.equal(h.calls.toasts.length, 0, JSON.stringify(h.calls.toasts));
    assertOneGoInFlight(h.log);
  });

  it('setup mode pauses analysis; leaving it resumes', { timeout: 30000 }, async () => {
    const h = makeHarness(START, { depth: 0, movetime: 0 });
    live.push(h);
    await h.engine.ready;
    h.engine.start();
    await waitFor(() => h.store.state.engine.lines.length >= 1);

    h.store.state.mode = 'setup';
    h.store.emit('mode:change', { mode: 'setup' });
    await waitFor(() => h.store.state.engine.thinking === false);
    assert.equal(h.store.state.engine.lines.length, 0);

    const goCount = h.log.sent.filter(s => s.startsWith('go ')).length;
    await sleep(300);
    assert.equal(h.log.sent.filter(s => s.startsWith('go ')).length, goCount, 'nothing searched while in setup');

    h.store.state.mode = 'play';
    h.store.emit('mode:change', { mode: 'play' });
    await waitFor(() => h.store.state.engine.lines.length >= 1);
    assertOneGoInFlight(h.log);
  });

  it('dispose() rejects an in-flight bestMove and quits the worker', { timeout: 20000 }, async () => {
    const h = makeHarness(START);
    live.push(h);
    await h.engine.ready;
    const p = h.engine.bestMove(START, { movetime: 5000 });
    await waitFor(() => h.log.sent.some(s => s.startsWith('go movetime 5000')));

    h.engine.dispose();

    await assert.rejects(p, /disposed/);
    assert.equal(h.log.sent[h.log.sent.length - 1], 'quit');
    assert.equal(h.store.state.engine.available, false);
    await assert.rejects(h.engine.bestMove(START), /disposed/);
  });
});

// The queue invariant, staleness, Chess960 and play-vs-engine races.

describe('stockfish driver: queue invariant', { skip: haveEngine ? false : 'vendor/ Stockfish files missing' }, () => {
  const live = [];
  afterEach(() => { for (const h of live.splice(0)) h.engine.dispose(); });

  it('bestMove() twice in a row never overlaps two searches', { timeout: 30000 }, async () => {
    const h = makeHarness(START);
    live.push(h);
    await h.engine.ready;

    const a = h.engine.bestMove(START, { movetime: 400 });
    const b = h.engine.bestMove(START, { movetime: 120 });
    const settled = await Promise.allSettled([a, b]);

    // The second may supersede the first before it starts; either way b gives a legal move.
    assert.equal(settled[1].status, 'fulfilled', JSON.stringify(settled[1]));
    assert.ok(h.store.state.game.uciToMove(settled[1].value), 'legal: ' + settled[1].value);
    if (settled[0].status === 'rejected') assert.match(settled[0].reason.message, /superseded/);
    else assert.ok(h.store.state.game.uciToMove(settled[0].value));
    assertQueueSane(h.log);
  });

  it('a burst of bestMove() calls supersedes cleanly -- every promise settles, one search at a time', { timeout: 40000 }, async () => {
    const h = makeHarness(START);
    live.push(h);
    await h.engine.ready;

    const ps = [];
    for (let i = 0; i < 6; i++) ps.push(h.engine.bestMove(START, { movetime: 100 + i * 10 }));
    const settled = await Promise.allSettled(ps);

    assert.equal(settled.filter(s => s.status === 'fulfilled' || /superseded/.test(s.reason && s.reason.message)).length, 6,
      JSON.stringify(settled.map(s => s.status + ':' + (s.reason ? s.reason.message : s.value))));
    assert.equal(settled[settled.length - 1].status, 'fulfilled', 'the last request always wins');
    assertQueueSane(h.log);
  });

  it('analyse() during bestMove() for the same position waits instead of stopping the engine move', { timeout: 30000 }, async () => {
    const h = makeHarness(START, { depth: 6, movetime: 0 });
    live.push(h);
    await h.engine.ready;
    const p = h.engine.bestMove(START, { movetime: 600 });
    await waitFor(() => h.log.sent.some(s => s === 'go movetime 600'));
    const goCount = h.log.sent.filter(s => s.startsWith('go ')).length;

    h.engine.analyse(START);                                   // same position: must NOT stop the engine's own search
    await sleep(250);

    assert.equal(h.log.sent.filter(s => s === 'stop').length, 0, 'the engine move was not interrupted');
    assert.equal(h.log.sent.filter(s => s.startsWith('go ')).length, goCount, 'no second go while it thinks');

    const u = await p;
    assert.ok(h.store.state.game.uciToMove(u));
    await waitFor(() => h.store.state.engine.lines.length >= 1, 8000);   // the queued analysis then runs
    assertQueueSane(h.log);
  });

  it('stop() while a search is still starting never lets a go escape', { timeout: 20000 }, async () => {
    const h = makeHarness(START, { depth: 0, movetime: 0 });
    live.push(h);
    await h.engine.ready;

    h.engine.start();
    h.engine.stop();                    // inside the 150 ms debounce: the spec must die before it launches
    await sleep(500);

    assert.equal(h.log.sent.filter(s => s.startsWith('go ')).length, 0, 'no search was launched: ' + JSON.stringify(h.log.sent));
    assert.equal(h.store.state.engine.thinking, false);
    assert.equal(h.store.state.engine.lines.length, 0);
    assertQueueSane(h.log);
  });

  it('start()/stop() flapping leaves the engine idle and consistent', { timeout: 30000 }, async () => {
    const h = makeHarness(START, { depth: 8, movetime: 0 });
    live.push(h);
    await h.engine.ready;

    for (let i = 0; i < 5; i++) {
      h.engine.start();
      await sleep(40);
      h.engine.stop();
      await sleep(40);
    }

    h.engine.start();
    await waitFor(() => h.store.state.engine.lines.length >= 1 && h.store.state.engine.thinking === false);
    h.engine.stop();
    await sleep(300);

    assert.equal(h.store.state.engine.thinking, false);
    assert.equal(h.store.state.engine.enabled, false);
    assertQueueSane(h.log);
  });

  it('a storm of position changes never overlaps searches and ends on the final position', { timeout: 40000 }, async () => {
    const h = makeHarness(START, { depth: 10, movetime: 0 });
    live.push(h);
    await h.engine.ready;
    h.engine.start();

    const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6'];
    for (const u of line) {
      const g = h.store.state.game;
      h.actions.playMove(g.uciToMove(u));
      await sleep(30);                                   // faster than the 150 ms debounce: most specs are superseded
    }

    const finalFen = h.store.state.game.fen();
    await waitFor(() => h.store.state.engine.lines.length >= 1 && h.store.state.engine.thinking === false, 20000);
    assertQueueSane(h.log);

    // Every line pushed while the board sat on finalFen must be playable in finalFen.
    const g = h.store.state.game;
    assert.equal(g.fen(), finalFen, 'the board did not move on its own');
    for (const l of h.store.state.engine.lines) {
      assert.ok(g.uciToMove(l.pv[0]), 'pv head legal in the final position: ' + l.pv[0]);
      assert.equal(l.san.length, l.pv.length, 'SAN computed against the right position');
    }
    assert.ok(g.uciToMove(h.store.state.engine.bestMove), 'bestMove legal in the final position');
  });

  it('fast back/forward never leaks a line belonging to the other position', { timeout: 40000 }, async () => {
    const h = makeHarness(START, { depth: 12, movetime: 0 });
    live.push(h);
    await h.engine.ready;
    h.engine.start();
    await waitFor(() => h.store.state.engine.lines.length >= 1);

    const games = { a: h.store.state.game, b: makeGame(SCHOLAR) };
    for (let i = 0; i < 6; i++) {
      const g = i % 2 ? games.a : games.b;
      h.store.state.game = g;
      h.store.emit('position:change', { fen: g.fen(), turn: g.turn(), node: null });
      await sleep(i % 2 ? 60 : 200);
    }

    h.store.state.game = games.b;
    h.store.emit('position:change', { fen: games.b.fen(), turn: 'white', node: null });
    await waitFor(() => h.store.state.engine.lines.length >= 1 && h.store.state.engine.thinking === false
      && h.store.state.engine.score && h.store.state.engine.score.mate === 1, 20000);

    assert.deepEqual(h.store.state.engine.lines[0].pv, ['h5f7']);
    assert.deepEqual(h.store.state.engine.lines[0].san, ['Qxf7#']);

    // No push may ever have carried a move that is illegal in the position it was pushed for.
    for (const c of h.calls.lines) {
      for (const l of c.lines) assert.equal(l.san.length, l.pv.length, 'stale SAN leak: ' + JSON.stringify(l));
    }
    assertQueueSane(h.log);
  });
});

describe('stockfish driver: scores, terminal positions and info filtering', { skip: haveEngine ? false : 'vendor/ Stockfish files missing' }, () => {
  const live = [];
  afterEach(() => { for (const h of live.splice(0)) h.engine.dispose(); });

  it('a mate FOR black to move is reported as a negative mate in White view', { timeout: 20000 }, async () => {
    const h = makeHarness(BLACK_MATES, { depth: 8, movetime: 0 });
    live.push(h);
    await h.engine.ready;

    h.engine.start();
    await waitFor(() => h.store.state.engine.score && h.store.state.engine.score.mate !== undefined);

    const s = h.store.state.engine.score;
    assert.ok(s.mate < 0, 'black mating must be a negative mate, got ' + JSON.stringify(s));
    assert.equal(h.store.state.engine.lines[0].score.mate, s.mate);
    assert.ok(h.store.state.engine.lines[0].san[0].endsWith('#'), h.store.state.engine.lines[0].san[0]);
  });

  it('a stalemated position yields cp 0, bestmove (none) and no arrow', { timeout: 20000 }, async () => {
    const h = makeHarness(STALEMATE, { depth: 0, movetime: 0 });
    live.push(h);
    await h.engine.ready;

    h.engine.start();
    await waitFor(() => h.store.state.engine.thinking === false && h.store.state.engine.score !== null);

    assert.deepEqual(h.store.state.engine.score, { cp: 0 });
    assert.equal(h.store.state.engine.bestMove, null);
    assert.ok(h.log.received.some(s => s.startsWith('bestmove (none)')), 'engine really said (none)');
    assertQueueSane(h.log);
  });

  it('bestMove() on a finished position resolves null rather than inventing a move', { timeout: 20000 }, async () => {
    const h = makeHarness(STALEMATE);
    live.push(h);
    await h.engine.ready;

    assert.equal(await h.engine.bestMove(STALEMATE, { movetime: 100 }), null);
    assert.equal(await h.engine.bestMove(FOOLS, { movetime: 100 }), null);
    assertQueueSane(h.log);
  });

  it('info string / currmove chatter from the real engine never becomes a line', { timeout: 30000 }, async () => {
    const h = makeHarness(START, { depth: 14, movetime: 0, multipv: 1 });
    live.push(h);
    await h.engine.ready;

    h.engine.start();
    await waitFor(() => h.store.state.engine.lines.length >= 1 && h.store.state.engine.depth >= 10, 25000);

    assert.ok(h.log.received.some(s => s.startsWith('info string')), 'the engine did emit info string lines');
    for (const c of h.calls.lines) {
      for (const l of c.lines) {
        assert.ok(l.pv.length > 0 || l.score, 'empty line pushed: ' + JSON.stringify(l));
        assert.ok(!l.pv.some(m => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)), 'non-move in pv: ' + JSON.stringify(l.pv));
      }
    }
    assertQueueSane(h.log);
  });
});

describe('stockfish driver: Chess960', { skip: haveEngine ? false : 'vendor/ Stockfish files missing' }, () => {
  const live = [];
  afterEach(() => { for (const h of live.splice(0)) h.engine.dispose(); });

  it('turns UCI_Chess960 on, sends a bare FEN, and reads the king-takes-rook bestmove/pv back', { timeout: 30000 }, async () => {
    const h = makeHarness(C960_MATE, { depth: 6, movetime: 0, multipv: 1 }, { variant: 'chess960' });
    live.push(h);
    await h.engine.ready;

    h.engine.start();
    await waitFor(() => h.store.state.engine.score && h.store.state.engine.score.mate === 1, 20000);

    const opt = h.log.sent.lastIndexOf('setoption name UCI_Chess960 value true');
    const pos = h.log.sent.findIndex(s => s.startsWith('position '));
    assert.ok(opt >= 0, 'UCI_Chess960 was turned on: ' + JSON.stringify(h.log.sent.filter(s => s.includes('Chess960'))));
    assert.ok(opt < pos, 'UCI_Chess960 is set BEFORE the position');
    assert.equal(h.log.sent.filter(s => s.startsWith('position ')).every(s => s === 'position fen ' + C960_MATE), true,
      'Chess960 positions go out as a bare FEN (no "moves" list, whose castling spelling would be ambiguous): '
      + JSON.stringify(h.log.sent.filter(s => s.startsWith('position '))));

    // The engine answers the king-takes-rook form; the driver keeps it intact and renders it as SAN.
    assert.deepEqual(h.store.state.engine.lines[0].pv, ['b1a1']);
    assert.deepEqual(h.store.state.engine.lines[0].san, ['O-O-O#']);
    assert.equal(h.store.state.engine.bestMove, 'b1a1');
    assertQueueSane(h.log);
  });

  it('plays the Chess960 castling move through actions.playMove', { timeout: 30000 }, async () => {
    const h = makeHarness(C960_MATE, {}, { variant: 'chess960' });
    live.push(h);
    await h.engine.ready;

    h.engine.setPlayAs('white');
    await waitFor(() => h.store.state.game.moves.length === 1, 20000);

    assert.equal(h.store.state.game.moves[0], 'b1a1', 'the castling move was applied, not dropped');
    assert.equal(h.calls.toasts.length, 0, JSON.stringify(h.calls.toasts));
    assertQueueSane(h.log);
  });

  it('switching a 960 game back to a standard one turns UCI_Chess960 off again', { timeout: 30000 }, async () => {
    const h = makeHarness(C960_OPEN, { depth: 6, movetime: 0 }, { variant: 'chess960' });
    live.push(h);
    await h.engine.ready;
    h.engine.start();
    await waitFor(() => h.store.state.engine.lines.length >= 1, 20000);
    assert.ok(h.log.sent.includes('setoption name UCI_Chess960 value true'));

    h.store.state.game = makeGame(START, 'standard');
    h.store.emit('game:change', { game: h.store.state.game, current: null, reason: 'load' });
    h.store.emit('position:change', { fen: START, turn: 'white', node: null });
    await waitFor(() => h.log.sent.includes('setoption name UCI_Chess960 value false'), 20000);
    await waitFor(() => h.store.state.engine.lines.length >= 1 && h.store.state.engine.thinking === false, 20000);

    const off = h.log.sent.lastIndexOf('setoption name UCI_Chess960 value false');
    const withMoves = h.log.sent.findIndex((s, i) => i > off && s.startsWith('position fen ' + START));
    assert.ok(withMoves > off, 'the standard position is only sent after Chess960 is switched off');
    assertQueueSane(h.log);
  });
});

describe('stockfish driver: play-vs-engine races and startup failures', { skip: haveEngine ? false : 'vendor/ Stockfish files missing' }, () => {
  const live = [];
  afterEach(() => { for (const h of live.splice(0)) h.engine.dispose(); });

  it('an engine move is never applied to a position it was not computed for', { timeout: 40000 }, async () => {
    const h = makeHarness(START, { playMovetime: 900 });
    live.push(h);
    await h.engine.ready;
    h.engine.setPlayAs('white');
    await waitFor(() => h.log.sent.some(s => s === 'go movetime 900'));

    // The human takes white's move while the engine is still thinking about the same position.
    const g = h.store.state.game;
    h.actions.playMove(g.uciToMove('d2d4'));
    assert.equal(g.moves.length, 1);
    await sleep(1500);

    assert.equal(g.moves[0], 'd2d4', 'the human move stands');
    assert.ok(g.moves.length <= 1 || g.turn() === 'white',
      'the engine did not stack its stale white move on top: ' + JSON.stringify(g.moves));
    assert.equal(g.moves.length, 1, 'engine move for the superseded position was dropped: ' + JSON.stringify(g.moves));
    assert.equal(h.calls.toasts.length, 0, JSON.stringify(h.calls.toasts));
    assertQueueSane(h.log);
  });

  it('setPlayAs(null) mid-think cancels the pending engine move', { timeout: 30000 }, async () => {
    const h = makeHarness(START, { playMovetime: 900 });
    live.push(h);
    await h.engine.ready;
    h.engine.setPlayAs('white');
    await waitFor(() => h.log.sent.some(s => s === 'go movetime 900'));

    h.engine.setPlayAs(null);
    await sleep(1500);

    assert.equal(h.store.state.game.moves.length, 0, 'nothing was played after playAs was cleared');
    assert.equal(h.engine.getPlayAs(), null);
    assert.equal(h.calls.toasts.length, 0, JSON.stringify(h.calls.toasts));
    assertQueueSane(h.log);
  });

  it('setPlayAs on an already-finished game never searches and never toasts', { timeout: 20000 }, async () => {
    const h = makeHarness(FOOLS);          // white is checkmated; white to move
    live.push(h);
    await h.engine.ready;

    h.engine.setPlayAs('white');
    await sleep(600);

    assert.equal(h.log.sent.filter(s => s.startsWith('go ')).length, 0, 'no search on a finished game');
    assert.equal(h.store.state.game.moves.length, 0);
    assert.equal(h.calls.toasts.length, 0, JSON.stringify(h.calls.toasts));
    assert.deepEqual(h.calls.playAs, ['white']);
  });

  it('a handshake that never answers times out, cleans up and leaves no live timer', { timeout: 20000 }, async () => {
    const h = makeHarness(START, {}, { deaf: true, handshakeTimeout: 120 });

    await assert.rejects(h.engine.ready, /handshake/i);

    assert.equal(h.engine.isAvailable(), false);
    assert.equal(h.store.state.engine.available, false);
    assert.equal(h.store.state.engine.enabled, false);
    assert.equal(h.log.terminated, 1, 'the dead worker was terminated');
    assert.equal(h.calls.toasts.length, 1);
    assert.equal(h.calls.toasts[0].kind, 'error');
    await assert.rejects(h.engine.bestMove(START), /unavailable/);

    h.engine.dispose();                                  // must not throw or double-toast
    assert.equal(h.calls.toasts.length, 1);
  });

  it('dispose() during the handshake rejects ready and never starts a search', { timeout: 20000 }, async () => {
    const h = makeHarness(START);
    h.engine.start();                                    // queued: must not survive the dispose

    h.engine.dispose();

    await assert.rejects(h.engine.ready, /disposed/);
    await sleep(400);
    assert.equal(h.log.sent.filter(s => s.startsWith('go ')).length, 0);
    assert.equal(h.store.state.engine.available, false);
    h.engine.dispose();                                  // idempotent
  });

  it('dispose() immediately after createEngine never boots a worker at all', { timeout: 20000 }, async () => {
    const h = makeHarness(START, {}, { deaf: true });

    h.engine.dispose();

    await assert.rejects(h.engine.ready, /disposed/);
    await sleep(200);
    assert.equal(h.log.sent.length, 0, 'boot() was skipped: ' + JSON.stringify(h.log.sent));
    assert.equal(h.engine.loadMode, null);
  });

  // Regression: a superseded engine-move request must not leave setPlayAs silent for good.
  it('setPlayAs survives having its move request superseded by another search', { timeout: 40000 }, async () => {
    const h = makeHarness(START);
    live.push(h);
    await h.engine.ready;                       // needNewGame is still true: the next search waits on readyok

    h.engine.setPlayAs('white');                // queues the engine-move search (phase 'starting')
    const other = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const p = h.engine.bestMove(other, { movetime: 120 });   // same tick: supersedes it before it can launch
    const settled = await p.then(v => ({ ok: v }), e => ({ err: e.message }));
    assert.ok(settled.ok, 'the superseding request itself still works: ' + JSON.stringify(settled));

    await waitFor(() => h.store.state.game.moves.length === 1, 20000);
    assert.equal(h.store.state.game.turn(), 'black', 'the engine eventually made its move');
    assert.equal(h.calls.toasts.length, 0, JSON.stringify(h.calls.toasts));
    assertQueueSane(h.log);
  });

  // Regression: terminate() can fire onerror, which must not toast "Stockfish crashed".
  it('a worker error after dispose() is silent', { timeout: 20000 }, async () => {
    const h = makeHarness(START);
    live.push(h);
    await h.engine.ready;
    const shim = h.log.workers[0];

    h.engine.dispose();
    assert.equal(typeof shim.onerror, 'function');
    shim.onerror({ message: 'child exited' });
    await sleep(50);

    assert.equal(h.calls.toasts.length, 0, 'no toast after an intentional teardown: ' + JSON.stringify(h.calls.toasts));
  });

  // Regression: a late uciok+readyok must not mark a terminated worker's engine available.
  it('a disposed engine cannot be resurrected by a late handshake', { timeout: 20000 }, async () => {
    const h = makeHarness(START, {}, { deaf: true });
    await waitFor(() => h.log.sent.includes('uci'));
    h.engine.ready.catch(() => {});
    h.engine.dispose();

    const shim = h.log.workers[0];
    shim.onmessage({ data: 'uciok' });
    shim.onmessage({ data: 'readyok' });
    await sleep(50);

    assert.equal(h.engine.isAvailable(), false);
    assert.equal(h.store.state.engine.available, false);
  });

  it('a timed-out engine cannot be resurrected by a late handshake', { timeout: 20000 }, async () => {
    const h = makeHarness(START, {}, { deaf: true, handshakeTimeout: 80 });
    await assert.rejects(h.engine.ready, /handshake/i);
    assert.equal(h.log.terminated, 1);

    const shim = h.log.workers[0];
    shim.onmessage({ data: 'uciok' });            // the slow engine finally answers, after we gave up
    shim.onmessage({ data: 'readyok' });
    await sleep(50);

    assert.equal(h.engine.isAvailable(), false, 'a terminated engine must stay unavailable');
    assert.equal(h.store.state.engine.available, false);
    assert.equal(h.calls.toasts.length, 1, 'exactly one failure toast: ' + JSON.stringify(h.calls.toasts));
    await assert.rejects(h.engine.bestMove(START), /unavailable/);

    h.engine.dispose();
  });
});
