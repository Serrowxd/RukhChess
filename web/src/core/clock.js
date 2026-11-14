/** Time-control defaults: untimed. */
export const TIME_CONTROL_DEFAULTS = { initial: 0, increment: 0 };

const other = color => (color === 'white' ? 'black' : 'white');
const isColor = c => c === 'white' || c === 'black';

const ms = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
};

/** Sanitise a { initial, increment } pair to non-negative integer ms. */
export function normalizeTimeControl(tc) {
  const src = tc && typeof tc === 'object' ? tc : {};
  return { initial: ms(src.initial, 0), increment: ms(src.increment, 0) };
}

/** A fresh clock for a time control in ms; initial 0 means untimed. */
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

/** A fresh, sanitised copy of a clock. */
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

export function isUntimed(clock) {
  return !clock || ms(clock.initial, 0) <= 0;
}

export function isRunning(clock) {
  return !!(clock && clock.running && isColor(clock.turn) && !clock.flagged && !isUntimed(clock));
}

export function clockEquals(a, b) {
  if (!a || !b) return a === b;

  return a.running === b.running && a.white === b.white && a.black === b.black
    && a.turn === b.turn && a.increment === b.increment && a.initial === b.initial
    && a.flagged === b.flagged && a.startedAt === b.startedAt;
}

/** ms left for `color` as of `now`, live for the burning side. Never negative. */
export function remaining(clock, color, now) {
  const c = cloneClock(clock);
  if (!isColor(color)) return 0;
  if (!isRunning(c) || c.turn !== color) return c[color];
  return Math.max(0, c[color] - elapsed(c, now));
}

/** Read-only view with the live burn applied. */
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

/** Start the clock for `turn`; when already running, burn the previous side and re-seat the turn. */
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

export function pause(clock, now) {
  const c = burn(clock, now);
  if (!c.running) return c;

  c.running = false;
  c.startedAt = null;
  return c;
}

/** Resume a paused clock for the stored turn. */
export function resume(clock, now) {
  const c = cloneClock(clock);
  if (isUntimed(c) || c.flagged || c.running || !isColor(c.turn)) return c;
  if (c[c.turn] <= 0) return c;

  c.running = true;
  c.startedAt = Number.isFinite(now) ? now : null;
  return c;
}

/** Both sides back to `initial`, optionally with a new time control. */
export function reset(clock, tc) {
  const base = cloneClock(clock);
  const next = tc === undefined ? { initial: base.initial, increment: base.increment } : normalizeTimeControl(tc);
  return createClock(next);
}

/** Callers refuse this while the clock is running. */
export function setTimeControl(clock, tc) {
  return reset(clock, tc);
}

export function tick(clock, now) {
  return burn(clock, now);
}

/** Burn the mover's time, add the increment, hand the turn over. A paused clock does not burn. */
export function applyMove(clock, now, opts = {}) {
  const c = cloneClock(clock);
  if (isUntimed(c) || c.flagged || !isColor(c.turn)) return c;

  const mover = isColor(opts.mover) ? opts.mover : c.turn;
  const nextTurn = isColor(opts.nextTurn) ? opts.nextTurn : other(mover);

  const burned = burn(c, now);
  if (burned.flagged) return burned; // ran out with the move in hand

  if (burned.increment > 0 && burned[mover] > 0) burned[mover] += burned.increment;
  burned.turn = nextTurn;
  if (burned.running) burned.startedAt = Number.isFinite(now) ? now : burned.startedAt;
  return burned;
}

export function flag(clock, color) {
  const c = cloneClock(clock);
  if (isUntimed(c) || c.flagged || !isColor(color)) return c;

  c.flagged = color;
  c[color] = 0;
  c.running = false;
  c.startedAt = null;
  return c;
}

export function otherColor(color) {
  return other(color);
}
