// core/clock.js — chess-clock arithmetic (CONTRACT.md addendum v1, "Clock rules").
//
// PURE. No Date.now(), no timers, no DOM, no imports. Every function takes the current timestamp
// `now` (ms, monotonic-ish) as a parameter and returns a NEW clock object; nothing is mutated.
// The store owns the ticker (which supplies `now`) and mirrors the returned values into
// `state.clock` so listeners keep a stable object identity.
//
// Clock shape (CONTRACT.md):
//   { running, white, black, turn, increment, initial, flagged, startedAt }
//     white / black : ms remaining, clamped at 0
//     turn          : the side whose clock burns; null before the first start / after reset
//     initial       : 0 means UNTIMED — nothing ever runs, nothing ever ticks, nothing ever flags
//     flagged       : 'white' | 'black' once a side hit 0; a flagged clock is frozen for good
//     startedAt     : the `now` the running side's burn is measured from (null when not running)
//
// Semantics chosen where the addendum was open:
//   * `tick` re-baselines `startedAt` on every call, so a burn is never double-counted and a long
//     gap between ticks (a throttled background tab) is charged exactly once.
//   * A move while the clock is PAUSED does not burn time, but still adds the increment and hands
//     the turn over — otherwise `turn` would go stale and `resume` would charge the wrong player.
//   * A move that lands exactly on/past 0 flags the mover: the increment is NOT awarded (you must
//     complete the move before the flag falls).
//   * `start` on an already-running clock only re-seats the turn; it never re-adds time.
//   * Clock values are integers (ms); elapsed time is clamped at 0 so a clock that jumps backwards
//     (NTP correction) never hands time back.

/** Time-control defaults: untimed. */
export const TIME_CONTROL_DEFAULTS = { initial: 0, increment: 0 };

const other = color => (color === 'white' ? 'black' : 'white');
const isColor = c => c === 'white' || c === 'black';
const ms = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

/** Sanitise a { initial, increment } pair: non-negative integers in ms. */
export function normalizeTimeControl(tc) {
  const src = tc && typeof tc === 'object' ? tc : {};
  return { initial: ms(src.initial, 0), increment: ms(src.increment, 0) };
}

/** A fresh clock for a time control ({ initial, increment } in ms; initial 0 = untimed). */
export function createClock(tc) {
  const { initial, increment } = normalizeTimeControl(tc);
  return {
    running: false,
    white: initial,
    black: initial,
    turn: null,
    increment,
    initial,
    flagged: null,
    startedAt: null,
  };
}

/** Copy a clock (the returned object is always fresh; callers may mirror it into state). */
export function cloneClock(clock) {
  const c = clock || {};
  return {
    running: !!c.running,
    white: ms(c.white, 0),
    black: ms(c.black, 0),
    turn: isColor(c.turn) ? c.turn : null,
    increment: ms(c.increment, 0),
    initial: ms(c.initial, 0),
    flagged: isColor(c.flagged) ? c.flagged : null,
    startedAt: Number.isFinite(c.startedAt) ? c.startedAt : null,
  };
}

/** True when no time control is set (initial === 0): the clock never runs. */
export function isUntimed(clock) {
  return !clock || ms(clock.initial, 0) <= 0;
}

/** True when the clock is currently burning time for a side. */
export function isRunning(clock) {
  return !!(clock && clock.running && isColor(clock.turn) && !clock.flagged && !isUntimed(clock));
}

/** True when both clocks hold the same values (used to decide whether to emit). */
export function clockEquals(a, b) {
  if (!a || !b) return a === b;
  return a.running === b.running && a.white === b.white && a.black === b.black
    && a.turn === b.turn && a.increment === b.increment && a.initial === b.initial
    && a.flagged === b.flagged && a.startedAt === b.startedAt;
}

/** ms left for `color` as of `now` (live for the side that is burning). Never negative. */
export function remaining(clock, color, now) {
  const c = cloneClock(clock);
  if (!isColor(color)) return 0;
  if (!isRunning(c) || c.turn !== color) return c[color];
  return Math.max(0, c[color] - elapsed(c, now));
}

/** Read-only view with the live burn applied: { white, black, turn, running, flagged }. */
export function snapshot(clock, now) {
  const c = cloneClock(clock);
  return {
    white: remaining(c, 'white', now),
    black: remaining(c, 'black', now),
    turn: c.turn,
    running: c.running,
    flagged: c.flagged,
  };
}

function elapsed(clock, now) {
  if (!Number.isFinite(now) || !Number.isFinite(clock.startedAt)) return 0;
  return Math.max(0, Math.round(now - clock.startedAt));
}

/** Burn `now - startedAt` from the running side. Returns the new clock (flagged when it hits 0). */
function burn(clock, now) {
  const c = cloneClock(clock);
  if (!isRunning(c)) return c;
  const left = c[c.turn] - elapsed(c, now);
  if (left <= 0) {
    c[c.turn] = 0;
    c.flagged = c.turn;
    c.running = false;
    c.startedAt = null;
    return c;
  }
  c[c.turn] = left;
  c.startedAt = Number.isFinite(now) ? now : c.startedAt;
  return c;
}

/**
 * Start (or re-seat) the clock for `turn`.
 * Untimed or already flagged → unchanged. Already running → only the turn is re-seated
 * (the elapsed time of the previous side is burned first).
 */
export function start(clock, turn, now) {
  const c = cloneClock(clock);
  if (isUntimed(c) || c.flagged || !isColor(turn)) return c;
  if (isRunning(c)) {
    if (c.turn === turn) return c;
    const burned = burn(c, now);
    if (burned.flagged) return burned;
    burned.turn = turn;
    burned.startedAt = Number.isFinite(now) ? now : burned.startedAt;
    return burned;
  }
  c.turn = turn;
  c.running = true;
  c.startedAt = Number.isFinite(now) ? now : null;
  return c;
}

/** Stop burning, keeping the turn and the time already spent. */
export function pause(clock, now) {
  const c = burn(clock, now);
  if (!c.running) return c;
  c.running = false;
  c.startedAt = null;
  return c;
}

/** Resume a paused clock for the side stored in `turn`. No-op when untimed / flagged / never started. */
export function resume(clock, now) {
  const c = cloneClock(clock);
  if (isUntimed(c) || c.flagged || c.running || !isColor(c.turn)) return c;
  if (c[c.turn] <= 0) return c;
  c.running = true;
  c.startedAt = Number.isFinite(now) ? now : null;
  return c;
}

/** Both sides back to `initial`, turn and flag cleared. An optional new time control may be given. */
export function reset(clock, tc) {
  const base = cloneClock(clock);
  const next = tc === undefined ? { initial: base.initial, increment: base.increment } : normalizeTimeControl(tc);
  return createClock(next);
}

/** Alias of reset with an explicit control — callers refuse this while the clock is running. */
export function setTimeControl(clock, tc) {
  return reset(clock, tc);
}

/** Burn the time spent since the last tick. Returns the new clock; `flagged` is set when it hits 0. */
export function tick(clock, now) {
  return burn(clock, now);
}

/**
 * A move was played: burn the mover's time, add the increment to the mover, hand the turn over.
 * opts: { mover = clock.turn, nextTurn = other(mover) }.
 * Untimed / flagged / never-started clocks are returned unchanged; a paused clock switches the
 * turn and takes the increment without burning.
 */
export function applyMove(clock, now, opts = {}) {
  const c = cloneClock(clock);
  if (isUntimed(c) || c.flagged || !isColor(c.turn)) return c;
  const mover = isColor(opts.mover) ? opts.mover : c.turn;
  const nextTurn = isColor(opts.nextTurn) ? opts.nextTurn : other(mover);
  const burned = burn(c, now);
  if (burned.flagged) return burned;                         // ran out with the move in hand
  if (burned.increment > 0 && burned[mover] > 0) burned[mover] += burned.increment;
  burned.turn = nextTurn;
  if (burned.running) burned.startedAt = Number.isFinite(now) ? now : burned.startedAt;
  return burned;
}

/** Force a flag on `color` (the ticker calls this through the store when time runs out). */
export function flag(clock, color) {
  const c = cloneClock(clock);
  if (isUntimed(c) || c.flagged || !isColor(color)) return c;
  c.flagged = color;
  c[color] = 0;
  c.running = false;
  c.startedAt = null;
  return c;
}

/** 'white' → 'black' and back (exported because the store needs the same rule). */
export function otherColor(color) {
  return other(color);
}
