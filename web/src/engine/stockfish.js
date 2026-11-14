import { parseInfo, parseBestMove, parseOption, parseId, toWhiteView, turnFromFen, fenKey } from './uci.js';

const GLUE_PATH = 'vendor/stockfish-19-lite-single.js';
const DEBOUNCE_MS = 150;
const PUSH_MS = 60; // engineLines cadence; the final push is immediate
const HANDSHAKE_TIMEOUT_MS = 30000;
const RETHINK_MS = 25;
const DEFAULT_PLAY_MOVETIME = 1200;
const MAX_MULTIPV = 16;
const UCI_MOVE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

// Worker construction

/** Single-file worker preamble: serves fetch('inline.wasm') from the embedded base64. */
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

// Undo build.mjs's inline-script escaping.
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

  // Never append ',worker': that marks a pthread helper and this build then loads nothing.
  const worker = new Worker(blobUrl + '#inline.wasm');
  return { worker, blobUrl, mode: 'inline' };
}

function createFolderWorker() {
  const base = (typeof document !== 'undefined' && document.baseURI) ? document.baseURI : self.location.href;
  const url = new URL(GLUE_PATH, base);

  // No hash: the glue finds the .wasm next to itself.
  const worker = new Worker(url.href);
  return { worker, blobUrl: null, mode: 'folder' };
}

// Engine

/** The Stockfish engine; boots on the next tick, `engine.ready` settles after the UCI handshake. */
export function createEngine(store, actions, opts = {}) {
  const state = () => store.state;
  const game = () => state().game;

  const engineSettings = () => {
    const s = state().settings;
    return (s && s.engine) || {};
  };

  const call = (name, ...args) => (actions && typeof actions[name] === 'function' ? actions[name](...args) : undefined);
  const toast = (text, kind) => call('toast', text, kind || 'info');
  const status = (patch) => call('engineStatus', patch);
  const clearLines = () => call('engineLines', [], null, 0, null);

  let worker = null, blobUrl = null, loadMode = null;
  let available = false, failed = false, disposed = false;
  let running = !!engineSettings().enabled;
  let handshakePhase = 'uci';
  let search = null; // the one in-flight search
  let pending = null; // started when the in-flight search reports bestmove
  let needNewGame = true;
  let playAs = null;
  let thinkingFor = null; // fenKey of the engine's own move in progress
  let debounceTimer = null, debounceSpec = null, pushTimer = null, handshakeTimer = null, thinkTimer = null;
  const optionCache = new Map();
  const info = { name: '', author: '', options: new Map() };
  const unsubs = [];

  let resolveReady, rejectReady;

  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  ready.catch(() => {}); // reported through state.engine.available and a toast

  // Transport

  function send(cmd) {
    if (!worker || disposed) return;

    try {
      worker.postMessage(cmd);
    } catch (e) {}
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

    worker = made.worker;
    blobUrl = made.blobUrl;
    loadMode = made.mode;

    worker.onmessage = (e) => {
      const d = e && e.data;
      if (typeof d === 'string') onLine(d);
    };

    worker.onerror = (e) => {
      if (disposed) return; // terminate() can fire this; it is not a crash

      const msg = (e && (e.message || (e.error && e.error.message))) || 'worker error';
      fail(available ? 'Stockfish crashed: ' + msg : 'Stockfish failed to load: ' + msg);
    };

    handshakeTimer = setTimeout(() => {
      if (!available && !failed) fail('Stockfish did not answer the UCI handshake in time.');
    }, opts.handshakeTimeout > 0 ? opts.handshakeTimeout : HANDSHAKE_TIMEOUT_MS);

    send('uci');
  }

  function fail(msg) {
    if (failed || disposed) return;

    failed = true;
    available = false;

    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }

    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }

    if (thinkTimer) {
      clearTimeout(thinkTimer);
      thinkTimer = null;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      debounceSpec = null;
    }

    rejectReady(new Error(msg));

    if (search) {
      cancelSpec(search, msg);
      search = null;
    }

    if (pending) {
      cancelSpec(pending, msg);
      pending = null;
    }

    if (worker) {
      try {
        worker.terminate();
      } catch (e) {}

      worker = null;
    }

    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch (e) {}

      blobUrl = null;
    }

    status({ available: false, enabled: false, thinking: false, depth: 0, nodes: 0, nps: 0 });
    toast(msg, 'error');
  }

  // Line routing

  function onLine(line) {
    // A late uciok/readyok must never revive a torn-down engine.
    if (disposed || failed) return;

    if (!available) {
      handshakeLine(line);
      return;
    }

    if (line.startsWith('info')) {
      const inf = parseInfo(line);
      if (inf) onInfo(inf);
      return;
    }

    if (line.startsWith('bestmove')) {
      const bm = parseBestMove(line);
      if (bm) onBestMove(bm);
      return;
    }

    if (line === 'readyok') onReadyOk();
  }

  function handshakeLine(line) {
    const id = parseId(line);

    if (id) {
      info[id.key] = id.value;
      return;
    }

    const opt = parseOption(line);

    if (opt) {
      info.options.set(opt.name, opt);
      return;
    }

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

      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }

      available = true;
      status({ available: true, enabled: running, thinking: false, depth: 0, nodes: 0, nps: 0 });
      resolveReady();

      if (pending) {
        const p = pending;
        pending = null;
        begin(p);
      } else if (running) analyseCurrent();

      maybeThink();
    }
  }

  // Search specs

  function isChess960() {
    const g = game();
    return !!(g && g.variant === 'chess960');
  }

  function eloBounds() {
    const o = info.options.get('UCI_Elo');
    const lo = o && Number.isFinite(o.min) ? o.min : 1320;
    const hi = o && Number.isFinite(o.max) ? o.max : 3190;
    return [lo, hi];
  }

  // Start fen plus moves lets the engine see repetitions; Chess960 castling UCI differs, so it gets a bare FEN.
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

            if (typeof u !== 'string' || !UCI_MOVE.test(u)) {
              ok = false;
              break;
            }

            moves.push(u);
          }

          if (ok) return 'position fen ' + g.startFen + (moves.length ? ' moves ' + moves.join(' ') : '');
        }
      }
    } catch (e) {}

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

  // The queue: one 'go' in flight, ever.

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
    if (disposed || failed) {
      cancelSpec(spec, disposed ? 'engine disposed' : 'engine unavailable');
      return;
    }

    if (!available) {
      setPending(spec);
      return;
    }

    if (!search) {
      begin(spec);
      return;
    }

    setPending(spec);
    if (search.phase !== 'searching') return; // starting: launch() swaps; stopping: bestmove is on its way
    // let the engine finish its own move
    if (search.kind === 'bestmove' && spec.kind === 'analyse' && search.key === spec.key) return;

    search.phase = 'stopping';
    send('stop');
  }

  function begin(spec) {
    search = spec;
    spec.phase = 'starting';

    if (needNewGame) {
      needNewGame = false;
      send('ucinewgame');
      send('isready'); // launch() runs on readyok
      return;
    }

    launch();
  }

  function onReadyOk() {
    if (search && search.phase === 'starting') launch();
  }

  function launch() {
    if (pending) {
      const p = pending;
      pending = null;
      cancelSpec(search, 'superseded');
      search = p;
      search.phase = 'starting';
    }

    if (search.cancelled) {
      search = null;
      status({ thinking: false });
      return;
    }

    if (needNewGame) {
      needNewGame = false;
      send('ucinewgame');
      send('isready');
      return;
    }

    applyOptions(search);
    send(search.positionCmd);
    send(goCommand(search));
    search.phase = 'searching';
    status({ thinking: true });
  }

  function onInfo(inf) {
    const s = search;
    if (!s || s.phase === 'starting') return;
    if (inf.bound) return; // fail-high/low partials
    if (inf.multipv > s.multipv) return;

    const prev = s.lines.get(inf.multipv);
    if (!prev || inf.depth >= prev.depth) s.lines.set(inf.multipv, inf);
    if (inf.depth > s.depthSeen) s.depthSeen = inf.depth;
    if (inf.seldepth) s.seldepth = inf.seldepth;
    if (inf.nodes) s.nodes = inf.nodes;
    if (inf.nps) s.nps = inf.nps;
    if (inf.time) s.time = inf.time;

    // No legal moves under 'go infinite': upstream waits for 'stop', and an idle 'stop' is ignored.
    if (inf.depth === 0 && s.phase === 'searching' && !s.depth && !s.movetime) {
      s.phase = 'stopping';
      send('stop');
    }

    schedulePush();
  }

  function onBestMove(bm) {
    const s = search;
    if (!s || s.phase === 'starting') return; // no 'go' outstanding: not ours

    search = null;
    s.phase = 'done';
    s.best = bm.bestmove;

    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }

    if (s.kind === 'bestmove') {
      if (!s.cancelled && s.resolve) s.resolve(bm.bestmove);
    } else if (!s.cancelled) {
      pushSnapshot(s, true);
    }

    if (pending) {
      const p = pending;
      pending = null;
      begin(p);
      return;
    }

    status({ thinking: false });
    // resume analysis after the engine's move
    if (s.kind === 'bestmove' && running && autoAnalyse()) analyseCurrent();
  }

  // Pushing into the store

  function schedulePush() {
    if (pushTimer) return;

    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (search && search.phase !== 'starting') pushSnapshot(search, false);
    }, PUSH_MS);
  }

  function pvToSan(g, pv) {
    try {
      if (typeof g.pvToSan === 'function') {
        const r = g.pvToSan(pv);
        return Array.isArray(r) ? r : [];
      }
    } catch (e) {}

    return [];
  }

  function pushSnapshot(s, final) {
    const thinking = final ? !!pending : true;

    if (s.kind !== 'analyse') {
      status({ thinking, depth: s.depthSeen, nodes: s.nodes, nps: s.nps });
      return;
    }

    if (s.cancelled) return;

    const g = game();
    let current = false;

    try {
      current = !!g && state().mode !== 'setup' && fenKey(g.fen()) === s.key;
    } catch (e) {
      current = false;
    }

    if (!current) return; // stale: the board moved on

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

  // Public: analysis

  function autoAnalyse() {
    const v = engineSettings().autoAnalyse;
    return v === undefined ? true : !!v;
  }

  /** Debounced analysis of `fen` (default: the board), streamed while the fen stays current. */
  function analyse(fen, o) {
    if (disposed) return;

    if (typeof fen !== 'string' || !fen.trim()) {
      const g = game();
      if (!g) return;
      fen = g.fen();
    }

    debounceSpec = makeSpec('analyse', fen, o || {});
    if (debounceTimer) clearTimeout(debounceTimer);

    debounceTimer = setTimeout(() => {
      debounceTimer = null;

      const sp = debounceSpec;
      debounceSpec = null;
      if (sp && !disposed) request(sp);
    }, DEBOUNCE_MS);
  }

  function analyseCurrent() {
    const g = game();
    if (!g || state().mode === 'setup') return;

    analyse(g.fen());
  }

  function cancelAnalysis() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      debounceSpec = null;
    }

    if (pending && pending.kind === 'analyse') {
      cancelSpec(pending, 'cancelled');
      pending = null;
    }

    if (search && search.kind === 'analyse' && !search.cancelled) {
      search.cancelled = true;

      if (search.phase === 'searching') {
        search.phase = 'stopping';
        send('stop');
      }
    }

    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }

    clearLines();
    status({ thinking: !!(search && search.kind === 'bestmove'), depth: 0, nodes: 0, nps: 0 });
  }

  function syncEnabledSetting(v) {
    if (!!engineSettings().enabled === v) return;

    try {
      call('setSetting', 'engine.enabled', v);
    } catch (e) {}
  }

  /** Analyse now and on every position change. Idempotent. */
  function start() {
    if (disposed) return;

    running = true;
    syncEnabledSetting(true); // re-enters through settings:change; harmless
    status({ enabled: true, available });
    if (!failed) analyseCurrent();
  }

  /** Stop analysis and clear the lines; play-vs-engine is not affected. */
  function stop() {
    running = false;
    cancelAnalysis();
    syncEnabledSetting(false);
    status({ enabled: false });
  }

  /** The engine move in `fen` (default: the board); null when there is no legal move. */
  function bestMove(fen, o) {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('engine disposed'));
        return;
      }

      if (failed) {
        reject(new Error('engine unavailable'));
        return;
      }

      if (typeof fen !== 'string' || !fen.trim()) {
        const g = game();

        if (!g) {
          reject(new Error('no position'));
          return;
        }

        fen = g.fen();
      }

      const spec = makeSpec('bestmove', fen, o || {});
      spec.resolve = resolve;
      spec.reject = reject;
      request(spec);
    });
  }

  // Public: play vs engine

  /** Let the engine play `color` (or null) in Play mode. */
  function setPlayAs(color) {
    playAs = color === 'white' || color === 'black' ? color : null;
    thinkingFor = null;

    if (thinkTimer) {
      clearTimeout(thinkTimer);
      thinkTimer = null;
    }

    call('engineSetPlayAs', playAs);
    maybeThink();
  }

  // A superseded request is not a failure; without a retry the engine would sit idle.
  function rethink() {
    if (disposed || failed || !playAs || thinkTimer) return;

    thinkTimer = setTimeout(() => {
      thinkTimer = null;
      maybeThink();
    }, RETHINK_MS);
  }

  function maybeThink() {
    if (!playAs || disposed || failed) return;

    const s = state();
    const g = s.game;
    if (!g || s.mode !== 'play') return;

    let turn;

    try {
      turn = g.turn();
    } catch (e) {
      return;
    }

    if (turn !== playAs) return;

    try {
      const st = g.status();
      if (st && st.outcome) return;
    } catch (e) {}

    const fen = g.fen();
    const key = fenKey(fen);
    if (thinkingFor === key) return; // already on it, or a promotion picker is open

    thinkingFor = key;
    const color = playAs;

    bestMove(fen).then((uci) => {
      if (disposed) return;
      if (thinkingFor === key) thinkingFor = null;
      if (!uci || playAs !== color || state().mode !== 'play') return;

      const g2 = game();
      let stillHere = false;

      try {
        stillHere = !!g2 && fenKey(g2.fen()) === key;
      } catch (e) {
        stillHere = false;
      }

      if (!stillHere) return; // the board moved on while we were thinking

      const mv = typeof g2.uciToMove === 'function' ? g2.uciToMove(uci) : null;

      if (!mv) {
        thinkingFor = key;
        toast('Engine suggested an unplayable move: ' + uci, 'error');
        return;
      }

      const node = call('playMove', mv);
      if (!node) thinkingFor = key; // never loop on a rejected move
    }).catch((err) => {
      if (thinkingFor === key) thinkingFor = null;

      const m = err && err.message ? err.message : String(err);

      if (/superseded|cancelled/.test(m)) {
        rethink();
        return;
      }

      if (!/disposed|unavailable/.test(m)) toast('Engine move failed: ' + m, 'error');
    });
  }

  // Store events

  function onPositionChanged() {
    if (disposed) return;

    if (state().mode === 'setup') {
      cancelAnalysis();
      return;
    }

    if (running) {
      if (autoAnalyse()) analyseCurrent();
      else cancelAnalysis();
    }

    maybeThink();
  }

  function onGameChange(ev) {
    const reason = ev && ev.reason;

    if (reason === 'new' || reason === 'load' || reason === 'setup') {
      needNewGame = true;
      onPositionChanged();
    }
  }

  function onModeChange(ev) {
    const mode = ev && ev.mode ? ev.mode : state().mode;

    if (mode === 'setup') {
      cancelAnalysis();
      return;
    }

    needNewGame = true;
    onPositionChanged();
  }

  function onSettingsChange(ev) {
    const path = ev ? ev.path : undefined;

    if (path === undefined || path === null || path === '' || path === 'engine') { // whole settings replaced
      const en = !!engineSettings().enabled;

      if (en !== running) {
        if (en) start();
        else stop();
      } else if (running) analyseCurrent();

      return;
    }

    if (path === 'engine.enabled') {
      if (engineSettings().enabled) start();
      else stop();
      return;
    }

    if (path === 'engine.multipv' || path === 'engine.depth' || path === 'engine.movetime') {
      if (running) analyseCurrent();
      return;
    }

    if (path === 'engine.autoAnalyse') {
      if (running && autoAnalyse()) analyseCurrent();
    }
  }

  function subscribe(ev, fn) {
    if (!store || typeof store.on !== 'function') return;

    const off = store.on(ev, fn);

    unsubs.push(typeof off === 'function' ? off : () => {
      if (typeof store.off === 'function') store.off(ev, fn);
    });
  }

  subscribe('position:change', onPositionChanged);
  subscribe('game:change', onGameChange);
  subscribe('mode:change', onModeChange);
  subscribe('settings:change', onSettingsChange);

  /** Quit the worker, reject anything in flight, drop listeners and the blob URL. */
  function dispose() {
    if (disposed) return;

    disposed = true;

    for (const off of unsubs) {
      try {
        off();
      } catch (e) {}
    }

    unsubs.length = 0;

    if (debounceTimer) clearTimeout(debounceTimer);
    if (pushTimer) clearTimeout(pushTimer);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    if (thinkTimer) clearTimeout(thinkTimer);
    debounceTimer = pushTimer = handshakeTimer = thinkTimer = null;
    debounceSpec = null;

    if (search) {
      cancelSpec(search, 'engine disposed');
      search = null;
    }

    if (pending) {
      cancelSpec(pending, 'engine disposed');
      pending = null;
    }

    if (worker) {
      try {
        worker.postMessage('quit');
      } catch (e) {}

      try {
        worker.terminate();
      } catch (e) {}

      worker = null;
    }

    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch (e) {}

      blobUrl = null;
    }

    if (!available && !failed) {
      failed = true;
      rejectReady(new Error('engine disposed'));
    }

    available = false;
    status({ available: false, enabled: false, thinking: false, depth: 0, nodes: 0, nps: 0 });
  }

  // Boot on the next tick so a startup toast reaches a UI mounted right after createEngine().
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
