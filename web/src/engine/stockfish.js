// engine/stockfish.js -- Stockfish 19 lite (single-thread WASM) driver: worker loading (folder / inline blob),
// UCI handshake, ONE in-flight search with a stop -> bestmove queue, analysis streamed into the store,
// play-vs-engine. Receives `store` + `actions` (never imports core/store.js); touches the DOM only to read
// #sf-glue / #sf-wasm in the single-file build.
//
// Contract surface (CONTRACT.md "engine/stockfish.js"): createEngine(store, actions) -> engine with
//   ready, start(), stop(), analyse(fen, opts), bestMove(fen, opts) -> Promise<uci>, setPlayAs(color|null), dispose().
//
// Added beyond the contract (all additive, nothing renamed):
//   createEngine(store, actions, opts?)   opts.createWorker() -> Worker-like { postMessage, onmessage, onerror, terminate }
//                                         (tests inject a node child-process shim); opts.handshakeTimeout ms (default 30000).
//   engine.info                           { name, author, options: Map<name, {type, default, min, max, vars}> } from the 'uci' handshake.
//   engine.isAvailable() / isRunning() / isThinking() / getPlayAs() / loadMode ('inline' | 'folder' | 'custom' | null).
//   engine.send(rawUciLine)               debug escape hatch; bypasses the queue, use with care.
//   analyse() / bestMove() with no fen    use the board position.
//   Scores: state.engine.score AND every line.score are in White's view; mate 0 carries `mated: 'white'|'black'`.
//   Each line also carries seldepth, nodes, nps, time (superset of the contract's {multipv, score, depth, pv, san}).
//   settings.engine.playMovetime (ms)     honoured when present for play-vs-engine thinking time (default 1200 ms).
//   settings:change 'engine.skill' / 'engine.elo' take effect on the next engine move; 'engine.autoAnalyse' false
//                                         stops re-analysis on position change (lines are cleared instead).
//   Standard-variant analysis of the board position sends `position fen <startFen> moves ...` (from game.path())
//   so the engine sees repetitions; Chess960 and off-board positions use plain `position fen`.
//   engine.start()/stop() keep settings.engine.enabled in sync (actions.setSetting) so the toggle and the API agree.
//   setPlayAs: an engine-move request that the queue supersedes is retried (RETHINK_MS) instead of being dropped —
//   supersession is the queue reassigning the engine, not a failure, and the colour is still waiting for a move.
//   Teardown is one-way: after dispose() or a startup/handshake failure the worker is terminated AND the line
//   router is closed, so a buffered or late uciok/readyok can never report a dead engine as available again.
import { parseInfo, parseBestMove, parseOption, parseId, toWhiteView, turnFromFen, fenKey } from './uci.js';

const GLUE_PATH = 'vendor/stockfish-19-lite-single.js';
const DEBOUNCE_MS = 150;          // analyse() coalescing
const PUSH_MS = 60;               // engineLines pushes are coalesced to this cadence (the final push is immediate)
const HANDSHAKE_TIMEOUT_MS = 30000;
const RETHINK_MS = 25;            // retry delay after a superseded play-vs-engine move request
const DEFAULT_PLAY_MOVETIME = 1200;
const MAX_MULTIPV = 16;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// ---- worker construction -------------------------------------------------------------------------

/** Worker preamble for the single-file build: routes the glue's fetch('inline.wasm') to the embedded base64 and guards instantiateStreaming. */
function buildPreamble(b64) {
  return [
    '(function(){',
    'var B64=' + JSON.stringify(b64) + ';',
    'var origFetch=self.fetch;',
    'self.fetch=function(input,init){',
    '  var url=typeof input==="string"?input:((input&&input.url)||String(input));',
    '  if(url.indexOf("inline.wasm")!==-1){return origFetch.call(self,"data:application/wasm;base64,"+B64);}',
    '  return origFetch.call(self,input,init);',
    '};',
    'var origIS=WebAssembly.instantiateStreaming;',
    'if(typeof origIS==="function"){',
    '  WebAssembly.instantiateStreaming=function(source,imports){',
    '    return Promise.resolve(source).then(function(resp){',
    '      var probe=(resp&&typeof resp.clone==="function")?resp.clone():resp;',
    '      return origIS.call(WebAssembly,probe,imports).catch(function(){',
    '        return resp.arrayBuffer().then(function(buf){return WebAssembly.instantiate(buf,imports);});',
    '      });',
    '    });',
    '  };',
    '}',
    '})();',
  ].join('\n');
}

// build.mjs escapes the only sequences that could close the inline <script>; undo them (a no-op for the current glue).
function unescapeInline(text) {
  return text.replace(/<\\\/script/gi, '</script').replace(/<\\!--/g, '<!--');
}

function createInlineWorker() {
  if (typeof document === 'undefined') return null;
  const wasmEl = document.getElementById('sf-wasm');
  if (!wasmEl) return null;
  const glueEl = document.getElementById('sf-glue');
  if (!glueEl) throw new Error('single-file build: #sf-glue is missing next to #sf-wasm');
  const b64 = (wasmEl.textContent || '').replace(/\s+/g, '');
  if (!b64) throw new Error('single-file build: #sf-wasm is empty');
  const glue = unescapeInline(glueEl.textContent || '');
  if (!glue) throw new Error('single-file build: #sf-glue is empty');
  const blob = new Blob([buildPreamble(b64), '\n', glue], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  // The glue reads the wasm URL from the first hash token. Do NOT append ',worker': that second token marks an
  // Emscripten pthread helper and makes this single-threaded build load nothing. Worker mode itself is
  // auto-detected (typeof onmessage !== 'undefined' and no window).
  const worker = new Worker(blobUrl + '#inline.wasm');
  return { worker, blobUrl, mode: 'inline' };
}

function createFolderWorker() {
  const base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : self.location.href;
  const url = new URL(GLUE_PATH, base);
  // No hash: the glue derives '<script path>.wasm' next to itself.
  const worker = new Worker(url.href);
  return { worker, blobUrl: null, mode: 'folder' };
}

// ---- engine ---------------------------------------------------------------------------------------

/** Create the Stockfish engine bound to a store + actions. Boots the worker on the next tick; `engine.ready` resolves after the UCI handshake (rejects if the worker cannot start). */
export function createEngine(store, actions, opts = {}) {
  const state = () => store.state;
  const game = () => state().game;
  const engineSettings = () => { const s = state().settings; return (s && s.engine) || {}; };
  const call = (name, ...args) => (actions && typeof actions[name] === 'function' ? actions[name](...args) : undefined);
  const toast = (text, kind) => call('toast', text, kind || 'info');
  const status = (patch) => call('engineStatus', patch);
  const clearLines = () => call('engineLines', [], null, 0, null);

  let worker = null, blobUrl = null, loadMode = null;
  let available = false, failed = false, disposed = false;
  let running = !!engineSettings().enabled;
  let handshakePhase = 'uci';
  let search = null;        // the one in-flight search (phase: starting | searching | stopping)
  let pending = null;       // the next search, started when the in-flight one reports bestmove
  let needNewGame = true;   // send ucinewgame + isready before the next search
  let playAs = null;
  let thinkingFor = null;   // fenKey the engine is working out its own move for
  let debounceTimer = null, debounceSpec = null, pushTimer = null, handshakeTimer = null, thinkTimer = null;
  const optionCache = new Map();
  const info = { name: '', author: '', options: new Map() };
  const unsubs = [];

  let resolveReady, rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {}); // the rejection is reported through state.engine.available + a toast; no unhandled noise

  // ---- transport ----
  function send(cmd) {
    if (!worker || disposed) return;
    try { worker.postMessage(cmd); } catch (e) { /* worker already gone */ }
  }
  function setOption(name, value) {
    const v = String(value);
    if (optionCache.get(name) === v) return;
    optionCache.set(name, v);
    send('setoption name ' + name + ' value ' + v);
  }

  function startupMessage(err) {
    const m = err && err.message ? err.message : String(err);
    const isFile = typeof location !== 'undefined' && location.protocol === 'file:';
    return isFile
      ? 'Stockfish could not start from file:// (browsers block folder workers there). Open the single-file chessboard.html or serve the dist/ folder. ' + m
      : 'Stockfish could not start: ' + m;
  }

  function boot() {
    if (disposed) return;
    let made;
    try {
      if (typeof opts.createWorker === 'function') made = { worker: opts.createWorker(), blobUrl: null, mode: 'custom' };
      else made = createInlineWorker() || createFolderWorker();
    } catch (err) {
      fail(startupMessage(err));
      return;
    }
    worker = made.worker; blobUrl = made.blobUrl; loadMode = made.mode;
    worker.onmessage = (e) => { const d = e && e.data; if (typeof d === 'string') onLine(d); };
    worker.onerror = (e) => {
      if (disposed) return;                                         // terminate() can fire this; it is not a crash
      const msg = (e && (e.message || (e.error && e.error.message))) || 'worker error';
      fail(available ? 'Stockfish crashed: ' + msg : 'Stockfish failed to load: ' + msg);
    };
    handshakeTimer = setTimeout(() => { if (!available && !failed) fail('Stockfish did not answer the UCI handshake in time.'); },
      opts.handshakeTimeout > 0 ? opts.handshakeTimeout : HANDSHAKE_TIMEOUT_MS);
    send('uci');
  }

  function fail(msg) {
    if (failed || disposed) return;
    failed = true; available = false;
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; debounceSpec = null; }
    rejectReady(new Error(msg));
    if (search) { cancelSpec(search, msg); search = null; }
    if (pending) { cancelSpec(pending, msg); pending = null; }
    if (worker) { try { worker.terminate(); } catch (e) { /* ignore */ } worker = null; }
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ } blobUrl = null; }
    status({ available: false, enabled: false, thinking: false, depth: 0, nodes: 0, nps: 0 });
    toast(msg, 'error');
  }

  // ---- line routing ----
  function onLine(line) {
    // A torn-down engine must stay torn down: after dispose()/fail() the worker is already terminated,
    // so a buffered (or very late) uciok/readyok must NOT walk the handshake to `available = true` again —
    // that would report a dead engine as usable and silently swallow every command sent to it.
    if (disposed || failed) return;
    if (!available) { handshakeLine(line); return; }
    if (line.startsWith('info')) { const inf = parseInfo(line); if (inf) onInfo(inf); return; }
    if (line.startsWith('bestmove')) { const bm = parseBestMove(line); if (bm) onBestMove(bm); return; }
    if (line === 'readyok') onReadyOk();
  }

  function handshakeLine(line) {
    const id = parseId(line);
    if (id) { info[id.key] = id.value; return; }
    const opt = parseOption(line);
    if (opt) { info.options.set(opt.name, opt); return; }
    if (line === 'uciok' && handshakePhase === 'uci') {
      handshakePhase = 'isready';
      setOption('Hash', 32);
      setOption('UCI_ShowWDL', 'false');
      setOption('Threads', 1);
      setOption('MultiPV', clampInt(engineSettings().multipv, 1, MAX_MULTIPV, 3));
      send('isready');
      return;
    }
    if (line === 'readyok' && handshakePhase === 'isready') {
      handshakePhase = 'done';
      if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
      available = true;
      status({ available: true, enabled: running, thinking: false, depth: 0, nodes: 0, nps: 0 });
      resolveReady();
      if (pending) { const p = pending; pending = null; begin(p); }
      else if (running) analyseCurrent();
      maybeThink();
    }
  }

  // ---- search specs ----
  function isChess960() { const g = game(); return !!(g && g.variant === 'chess960'); }

  function eloBounds() {
    const o = info.options.get('UCI_Elo');
    const lo = o && Number.isFinite(o.min) ? o.min : 1320;
    const hi = o && Number.isFinite(o.max) ? o.max : 3190;
    return [lo, hi];
  }

  // `position fen <start> moves ...` when the search is the board position in a standard game, so the engine
  // sees repetitions and the fifty-move clock; plain `position fen` otherwise (Chess960 castling UCI differs).
  function positionCommand(fen, chess960) {
    try {
      const g = game();
      if (!chess960 && g && typeof g.path === 'function' && typeof g.startFen === 'string' && g.startFen && fenKey(g.fen()) === fenKey(fen)) {
        const nodes = g.path();
        if (Array.isArray(nodes) && nodes.length) {
          const moves = [];
          let ok = true;
          for (let i = 1; i < nodes.length; i++) {
            const u = nodes[i] && nodes[i].uci;
            if (typeof u !== 'string' || !UCI_MOVE.test(u)) { ok = false; break; }
            moves.push(u);
          }
          if (ok) return 'position fen ' + g.startFen + (moves.length ? ' moves ' + moves.join(' ') : '');
        }
      }
    } catch (e) { /* fall back to the bare FEN */ }
    return 'position fen ' + fen;
  }

  function makeSpec(kind, fen, o) {
    const eng = engineSettings();
    const chess960 = typeof o.chess960 === 'boolean' ? o.chess960 : isChess960();
    const spec = {
      kind, fen, key: fenKey(fen), turn: turnFromFen(fen), chess960,
      multipv: 1, depth: 0, movetime: 0, skill: 20, elo: null,
      positionCmd: positionCommand(fen, chess960),
      phase: 'queued', cancelled: false,
      lines: new Map(), depthSeen: 0, seldepth: 0, nodes: 0, nps: 0, time: 0, best: null,
      resolve: null, reject: null,
    };
    if (kind === 'analyse') {
      spec.multipv = clampInt(o.multipv !== undefined ? o.multipv : eng.multipv, 1, MAX_MULTIPV, 3);
      spec.depth = clampInt(o.depth !== undefined ? o.depth : eng.depth, 0, 99, 22);
      spec.movetime = clampInt(o.movetime !== undefined ? o.movetime : eng.movetime, 0, 3600000, 0);
    } else {
      spec.depth = clampInt(o.depth, 0, 99, 0);
      spec.movetime = clampInt(o.movetime, 0, 3600000, 0);
      if (!spec.depth && !spec.movetime) spec.movetime = clampInt(eng.playMovetime, 50, 3600000, DEFAULT_PLAY_MOVETIME);
      spec.skill = clampInt(o.skill !== undefined ? o.skill : eng.skill, 0, 20, 20);
      const elo = o.elo !== undefined ? o.elo : eng.elo;
      spec.elo = typeof elo === 'number' && Number.isFinite(elo) ? elo : null;
    }
    return spec;
  }

  function goCommand(spec) {
    if (spec.depth > 0) return 'go depth ' + spec.depth;
    if (spec.movetime > 0) return 'go movetime ' + spec.movetime;
    return 'go infinite';
  }

  function applyOptions(spec) {
    setOption('UCI_Chess960', spec.chess960 ? 'true' : 'false');
    setOption('MultiPV', spec.multipv);
    if (spec.kind === 'bestmove') {
      setOption('Skill Level', spec.skill);
      if (spec.elo !== null) {
        const [lo, hi] = eloBounds();
        setOption('UCI_LimitStrength', 'true');
        setOption('UCI_Elo', clampInt(spec.elo, lo, hi, lo));
      } else {
        setOption('UCI_LimitStrength', 'false');
      }
    } else {
      // analysis is always full strength
      setOption('Skill Level', 20);
      setOption('UCI_LimitStrength', 'false');
    }
  }

  // ---- the queue: one 'go' in flight, ever ----
  function cancelSpec(spec, why) {
    if (!spec || spec.cancelled) return;
    spec.cancelled = true;
    if (spec.reject) spec.reject(new Error(why));
  }
  function setPending(spec) {
    if (pending && pending !== spec) cancelSpec(pending, 'superseded');
    pending = spec;
  }

  function request(spec) {
    if (disposed || failed) { cancelSpec(spec, disposed ? 'engine disposed' : 'engine unavailable'); return; }
    if (!available) { setPending(spec); return; }
    if (!search) { begin(spec); return; }
    setPending(spec);
    if (search.phase !== 'searching') return;                     // starting: launch() swaps; stopping: bestmove is on its way
    if (search.kind === 'bestmove' && spec.kind === 'analyse' && search.key === spec.key) return; // let the engine finish its own move
    search.phase = 'stopping';
    send('stop');
  }

  function begin(spec) {
    search = spec;
    spec.phase = 'starting';
    if (needNewGame) { needNewGame = false; send('ucinewgame'); send('isready'); return; } // launch() on readyok
    launch();
  }

  function onReadyOk() {
    if (search && search.phase === 'starting') launch();
  }

  function launch() {
    if (pending) { const p = pending; pending = null; cancelSpec(search, 'superseded'); search = p; search.phase = 'starting'; }
    if (search.cancelled) { search = null; status({ thinking: false }); return; }
    if (needNewGame) { needNewGame = false; send('ucinewgame'); send('isready'); return; }
    applyOptions(search);
    send(search.positionCmd);
    send(goCommand(search));
    search.phase = 'searching';
    status({ thinking: true });
  }

  function onInfo(inf) {
    const s = search;
    if (!s || s.phase === 'starting') return;
    if (inf.bound) return;                                          // fail-high/low partials
    if (inf.multipv > s.multipv) return;
    const prev = s.lines.get(inf.multipv);
    if (!prev || inf.depth >= prev.depth) s.lines.set(inf.multipv, inf);
    if (inf.depth > s.depthSeen) s.depthSeen = inf.depth;
    if (inf.seldepth) s.seldepth = inf.seldepth;
    if (inf.nodes) s.nodes = inf.nodes;
    if (inf.nps) s.nps = inf.nps;
    if (inf.time) s.time = inf.time;
    // No legal moves (depth 0) under 'go infinite': upstream Stockfish waits for 'stop' before bestmove. This build
    // answers at once; an extra 'stop' while idle is ignored, so it is safe either way.
    if (inf.depth === 0 && s.phase === 'searching' && !s.depth && !s.movetime) { s.phase = 'stopping'; send('stop'); }
    schedulePush();
  }

  function onBestMove(bm) {
    const s = search;
    if (!s || s.phase === 'starting') return;                       // no 'go' outstanding: not ours
    search = null;
    s.phase = 'done';
    s.best = bm.bestmove;
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (s.kind === 'bestmove') {
      if (!s.cancelled && s.resolve) s.resolve(bm.bestmove);
    } else if (!s.cancelled) {
      pushSnapshot(s, true);
    }
    if (pending) { const p = pending; pending = null; begin(p); return; }
    status({ thinking: false });
    if (s.kind === 'bestmove' && running && autoAnalyse()) analyseCurrent(); // resume analysis after the engine made its move
  }

  // ---- pushing into the store ----
  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (search && search.phase !== 'starting') pushSnapshot(search, false);
    }, PUSH_MS);
  }

  function pvToSan(g, pv) {
    try {
      if (typeof g.pvToSan === 'function') { const r = g.pvToSan(pv); return Array.isArray(r) ? r : []; }
    } catch (e) { /* SAN is decoration; the pv still stands */ }
    return [];
  }

  function pushSnapshot(s, final) {
    const thinking = final ? !!pending : true;
    if (s.kind !== 'analyse') { status({ thinking, depth: s.depthSeen, nodes: s.nodes, nps: s.nps }); return; }
    if (s.cancelled) return;
    const g = game();
    let current = false;
    try { current = !!g && state().mode !== 'setup' && fenKey(g.fen()) === s.key; } catch (e) { current = false; }
    if (!current) return;                                           // stale: the board moved on -- drop it
    const lines = [];
    for (const l of [...s.lines.values()].sort((a, b) => a.multipv - b.multipv)) {
      if (lines.length >= s.multipv) break;
      lines.push({
        multipv: l.multipv, score: toWhiteView(l.score, s.turn), depth: l.depth, seldepth: l.seldepth,
        nodes: l.nodes, nps: l.nps, time: l.time, pv: l.pv.slice(), san: pvToSan(g, l.pv),
      });
    }
    const first = lines[0] || null;
    const bestMove = (final && s.best) || (first && first.pv[0]) || null;
    status({ thinking, depth: first ? first.depth : s.depthSeen, nodes: s.nodes, nps: s.nps });
    call('engineLines', lines, first ? first.score : null, first ? first.depth : 0, bestMove);
  }

  // ---- public: analysis ----
  function autoAnalyse() { const v = engineSettings().autoAnalyse; return v === undefined ? true : !!v; }

  /** Restart analysis for `fen` (defaults to the board position); debounced 150 ms; streams actions.engineLines while the fen stays current. */
  function analyse(fen, o) {
    if (disposed) return;
    if (typeof fen !== 'string' || !fen.trim()) { const g = game(); if (!g) return; fen = g.fen(); }
    debounceSpec = makeSpec('analyse', fen, o || {});
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const sp = debounceSpec; debounceSpec = null;
      if (sp && !disposed) request(sp);
    }, DEBOUNCE_MS);
  }

  function analyseCurrent() {
    const g = game();
    if (!g || state().mode === 'setup') return;
    analyse(g.fen());
  }

  function cancelAnalysis() {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; debounceSpec = null; }
    if (pending && pending.kind === 'analyse') { cancelSpec(pending, 'cancelled'); pending = null; }
    if (search && search.kind === 'analyse' && !search.cancelled) {
      search.cancelled = true;
      if (search.phase === 'searching') { search.phase = 'stopping'; send('stop'); }
    }
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    clearLines();
    status({ thinking: !!(search && search.kind === 'bestmove'), depth: 0, nodes: 0, nps: 0 });
  }

  function syncEnabledSetting(v) {
    if (!!engineSettings().enabled === v) return;
    try { call('setSetting', 'engine.enabled', v); } catch (e) { /* settings are a convenience here */ }
  }

  /** Turn analysis on: analyses the board position now and again on every position change. Idempotent. */
  function start() {
    if (disposed) return;
    running = true;
    syncEnabledSetting(true);                                       // re-enters via settings:change -> start(); harmless
    status({ enabled: true, available });
    if (!failed) analyseCurrent();
  }

  /** Turn analysis off: stops the running search, clears lines/score/best move. Play-vs-engine thinking is not affected. */
  function stop() {
    running = false;
    cancelAnalysis();
    syncEnabledSetting(false);
    status({ enabled: false });
  }

  /** Ask for the engine move in `fen` (defaults to the board position) -> Promise<uci|null> (null when there is no legal move). Rejects on dispose / when superseded before it started. */
  function bestMove(fen, o) {
    return new Promise((resolve, reject) => {
      if (disposed) { reject(new Error('engine disposed')); return; }
      if (failed) { reject(new Error('engine unavailable')); return; }
      if (typeof fen !== 'string' || !fen.trim()) {
        const g = game();
        if (!g) { reject(new Error('no position')); return; }
        fen = g.fen();
      }
      const spec = makeSpec('bestmove', fen, o || {});
      spec.resolve = resolve; spec.reject = reject;
      request(spec);
    });
  }

  // ---- public: play vs engine ----
  /** Let the engine play `color` ('white' | 'black' | null): it thinks whenever it is that colour's turn in Play mode and plays via actions.playMove. */
  function setPlayAs(color) {
    playAs = color === 'white' || color === 'black' ? color : null;
    thinkingFor = null;
    if (thinkTimer) { clearTimeout(thinkTimer); thinkTimer = null; }
    call('engineSetPlayAs', playAs);
    maybeThink();
  }

  // A superseded / cancelled engine-move request is not a failure: the queue simply gave the engine away
  // to a newer search. Without a retry, setPlayAs would sit dead until some unrelated store event woke it.
  function rethink() {
    if (disposed || failed || !playAs || thinkTimer) return;
    thinkTimer = setTimeout(() => { thinkTimer = null; maybeThink(); }, RETHINK_MS);
  }

  function maybeThink() {
    if (!playAs || disposed || failed) return;
    const s = state();
    const g = s.game;
    if (!g || s.mode !== 'play') return;
    let turn;
    try { turn = g.turn(); } catch (e) { return; }
    if (turn !== playAs) return;
    try { const st = g.status(); if (st && st.outcome) return; } catch (e) { /* no status: let the engine decide */ }
    const fen = g.fen();
    const key = fenKey(fen);
    if (thinkingFor === key) return;                                // already on it (or a promotion picker is pending: fen unchanged)
    thinkingFor = key;
    const color = playAs;
    bestMove(fen).then((uci) => {
      if (disposed) return;
      if (thinkingFor === key) thinkingFor = null;
      if (!uci || playAs !== color || state().mode !== 'play') return;
      const g2 = game();
      let stillHere = false;
      try { stillHere = !!g2 && fenKey(g2.fen()) === key; } catch (e) { stillHere = false; }
      if (!stillHere) return;                                       // the board moved on while we were thinking
      const mv = typeof g2.uciToMove === 'function' ? g2.uciToMove(uci) : null;
      if (!mv) { thinkingFor = key; toast('Engine suggested an unplayable move: ' + uci, 'error'); return; }
      const node = call('playMove', mv);
      if (!node) thinkingFor = key;                                 // never loop on a rejected move
    }).catch((err) => {
      if (thinkingFor === key) thinkingFor = null;
      const m = err && err.message ? err.message : String(err);
      if (/superseded|cancelled/.test(m)) { rethink(); return; }     // the queue took the engine; ask again
      if (!/disposed|unavailable/.test(m)) toast('Engine move failed: ' + m, 'error');
    });
  }

  // ---- store events ----
  function onPositionChanged() {
    if (disposed) return;
    if (state().mode === 'setup') { cancelAnalysis(); return; }
    if (running) { if (autoAnalyse()) analyseCurrent(); else cancelAnalysis(); }
    maybeThink();
  }
  function onGameChange(ev) {
    const reason = ev && ev.reason;
    if (reason === 'new' || reason === 'load' || reason === 'setup') { needNewGame = true; onPositionChanged(); }
  }
  function onModeChange(ev) {
    const mode = ev && ev.mode ? ev.mode : state().mode;
    if (mode === 'setup') { cancelAnalysis(); return; }
    needNewGame = true;
    onPositionChanged();
  }
  function onSettingsChange(ev) {
    const path = ev ? ev.path : undefined;
    if (path === undefined || path === null || path === '' || path === 'engine') {   // whole settings replaced / reset
      const en = !!engineSettings().enabled;
      if (en !== running) { if (en) start(); else stop(); } else if (running) analyseCurrent();
      return;
    }
    if (path === 'engine.enabled') { if (engineSettings().enabled) start(); else stop(); return; }
    if (path === 'engine.multipv' || path === 'engine.depth' || path === 'engine.movetime') { if (running) analyseCurrent(); return; }
    if (path === 'engine.autoAnalyse') { if (running && autoAnalyse()) analyseCurrent(); }
  }

  function subscribe(ev, fn) {
    if (!store || typeof store.on !== 'function') return;
    const off = store.on(ev, fn);
    unsubs.push(typeof off === 'function' ? off : () => { if (typeof store.off === 'function') store.off(ev, fn); });
  }
  subscribe('position:change', onPositionChanged);
  subscribe('game:change', onGameChange);
  subscribe('mode:change', onModeChange);
  subscribe('settings:change', onSettingsChange);

  /** Quit the worker, reject anything in flight, drop listeners and the blob URL. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of unsubs) { try { off(); } catch (e) { /* ignore */ } }
    unsubs.length = 0;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (pushTimer) clearTimeout(pushTimer);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (thinkTimer) clearTimeout(thinkTimer);
    debounceTimer = pushTimer = handshakeTimer = thinkTimer = null; debounceSpec = null;
    if (search) { cancelSpec(search, 'engine disposed'); search = null; }
    if (pending) { cancelSpec(pending, 'engine disposed'); pending = null; }
    if (worker) {
      try { worker.postMessage('quit'); } catch (e) { /* ignore */ }
      try { worker.terminate(); } catch (e) { /* ignore */ }
      worker = null;
    }
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) { /* ignore */ } blobUrl = null; }
    if (!available && !failed) { failed = true; rejectReady(new Error('engine disposed')); }
    available = false;
    status({ available: false, enabled: false, thinking: false, depth: 0, nodes: 0, nps: 0 });
  }

  // Boot on the next tick so a startup failure toast reaches a UI mounted right after createEngine().
  setTimeout(boot, 0);

  return {
    ready,
    start, stop, analyse, bestMove, setPlayAs, dispose,
    info,
    isAvailable: () => available,
    isRunning: () => running,
    isThinking: () => !!search,
    getPlayAs: () => playAs,
    get loadMode() { return loadMode; },
    send: (line) => send(String(line)),
  };
}
