// Tests for src/core/clock.js — the pure chess-clock arithmetic.
// Every call takes an explicit `now`, so the whole module is driven from a fake clock here; a
// Date.now() anywhere in clock.js would show up as a non-deterministic failure in these tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TIME_CONTROL_DEFAULTS,
  applyMove,
  clockEquals,
  cloneClock,
  createClock,
  flag,
  isRunning,
  isUntimed,
  normalizeTimeControl,
  otherColor,
  pause,
  remaining,
  reset,
  resume,
  setTimeControl,
  snapshot,
  start,
  tick,
} from '../src/core/clock.js';

const T0 = 1_000_000;                       // a fake epoch; nothing in clock.js may read the real one
const blitz = () => createClock({ initial: 180000, increment: 2000 });

test('core/clock.js is pure: no Date.now, no timers, no imports', () => {
  const src = readFileSync(new URL('../src/core/clock.js', import.meta.url), 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const forbidden of ['Date.now', 'new Date', 'performance.now', 'setTimeout', 'setInterval', 'import ', 'require(']) {
    assert.equal(code.includes(forbidden), false, `clock.js must not use ${forbidden}`);
  }
});

test('createClock / normalizeTimeControl sanitise the time control', () => {
  assert.deepEqual(TIME_CONTROL_DEFAULTS, { initial: 0, increment: 0 });
  assert.deepEqual(normalizeTimeControl(undefined), { initial: 0, increment: 0 });
  assert.deepEqual(normalizeTimeControl({ initial: '5000', increment: 1500.4 }), { initial: 5000, increment: 1500 });
  assert.deepEqual(normalizeTimeControl({ initial: -9, increment: NaN }), { initial: 0, increment: 0 });
  assert.deepEqual(normalizeTimeControl('nonsense'), { initial: 0, increment: 0 });
  const c = createClock({ initial: 300000, increment: 5000 });
  assert.deepEqual(c, {
    running: false, white: 300000, black: 300000, turn: null,
    increment: 5000, initial: 300000, flagged: null, startedAt: null,
  });
  assert.equal(isUntimed(c), false);
  assert.equal(isRunning(c), false);
  assert.equal(otherColor('white'), 'black');
  assert.equal(otherColor('black'), 'white');
});

test('start seats the turn and begins burning; tick charges the elapsed time once', () => {
  const c0 = blitz();
  const c1 = start(c0, 'white', T0);
  assert.equal(c1.running, true);
  assert.equal(c1.turn, 'white');
  assert.equal(c1.startedAt, T0);
  assert.equal(isRunning(c1), true);
  assert.equal(c0.running, false, 'start did not mutate the input');

  const c2 = tick(c1, T0 + 1500);
  assert.equal(c2.white, 178500);
  assert.equal(c2.black, 180000, 'only the side to move burns');
  assert.equal(c2.startedAt, T0 + 1500, 're-baselined');
  // Ticking again with no time passing changes nothing, and two ticks never double-charge.
  const c3 = tick(c2, T0 + 1500);
  assert.equal(c3.white, 178500);
  const c4 = tick(tick(c2, T0 + 2000), T0 + 3000);
  assert.equal(c4.white, 177000, 'one charge per elapsed millisecond');
  assert.equal(remaining(c2, 'white', T0 + 2500), 177500, 'remaining is live for the running side');
  assert.equal(remaining(c2, 'black', T0 + 2500), 180000);
  assert.deepEqual(snapshot(c2, T0 + 2500), { white: 177500, black: 180000, turn: 'white', running: true, flagged: null });
});

test('a played move burns, adds the increment to the mover and switches', () => {
  let c = start(blitz(), 'white', T0);
  c = applyMove(c, T0 + 10000);
  assert.equal(c.white, 172000, '180000 - 10000 + 2000 increment');
  assert.equal(c.black, 180000);
  assert.equal(c.turn, 'black');
  assert.equal(c.startedAt, T0 + 10000);
  c = applyMove(c, T0 + 15000);
  assert.equal(c.black, 177000, '180000 - 5000 + 2000');
  assert.equal(c.white, 172000, 'the idle side is untouched');
  assert.equal(c.turn, 'white');
  // An explicit mover / nextTurn pair is honoured (branching into a line where it is the same side again).
  const forced = applyMove(c, T0 + 16000, { mover: 'white', nextTurn: 'white' });
  assert.equal(forced.turn, 'white');
  assert.equal(forced.white, 173000, '172000 - 1000 + 2000');
});

test('an untimed clock never runs, never ticks, never flags', () => {
  const c = createClock({ initial: 0, increment: 5000 });
  assert.equal(isUntimed(c), true);
  assert.deepEqual(start(c, 'white', T0), c);
  assert.deepEqual(tick(start(c, 'white', T0), T0 + 10_000_000), c);
  assert.deepEqual(applyMove(c, T0 + 1000), c);
  assert.deepEqual(resume(c, T0), c);
  assert.deepEqual(pause(c, T0), c);
  assert.deepEqual(flag(c, 'white'), c);
  assert.equal(isRunning(c), false);
});

test('a side flags exactly once and the clock stays frozen afterwards', () => {
  let c = start(createClock({ initial: 5000, increment: 3000 }), 'black', T0);
  c = tick(c, T0 + 4000);
  assert.equal(c.black, 1000);
  assert.equal(c.flagged, null);
  const flagged = tick(c, T0 + 9000);
  assert.equal(flagged.flagged, 'black');
  assert.equal(flagged.black, 0);
  assert.equal(flagged.running, false);
  assert.equal(flagged.startedAt, null);
  assert.equal(flagged.white, 5000, 'the other side keeps its time');
  // Further ticks / moves / starts / resumes change nothing at all.
  assert.ok(clockEquals(tick(flagged, T0 + 30000), flagged));
  assert.ok(clockEquals(applyMove(flagged, T0 + 30000), flagged));
  assert.ok(clockEquals(start(flagged, 'white', T0 + 30000), flagged));
  assert.ok(clockEquals(resume(flagged, T0 + 30000), flagged));
  assert.ok(clockEquals(flag(flagged, 'white'), flagged), 'a second flag cannot overwrite the first');
  // Exactly on zero is a flag, not a survival.
  const exact = tick(start(createClock({ initial: 1000 }), 'white', T0), T0 + 1000);
  assert.equal(exact.flagged, 'white');
  assert.equal(exact.white, 0);
});

test('a move that lands on the flag loses: no increment is awarded', () => {
  const c = start(createClock({ initial: 2000, increment: 10000 }), 'white', T0);
  const out = applyMove(c, T0 + 2500);
  assert.equal(out.flagged, 'white');
  assert.equal(out.white, 0);
  assert.equal(out.turn, 'white', 'the turn does not hand over past a flag');
});

test('pause keeps the spent time; resume re-baselines from the new now', () => {
  let c = start(blitz(), 'white', T0);
  c = pause(c, T0 + 4000);
  assert.equal(c.running, false);
  assert.equal(c.white, 176000);
  assert.equal(c.turn, 'white', 'the turn survives a pause');
  assert.equal(c.startedAt, null);
  assert.equal(isRunning(c), false);
  // Wall-clock time passing while paused costs nothing.
  assert.ok(clockEquals(tick(c, T0 + 600000), c));
  assert.equal(remaining(c, 'white', T0 + 600000), 176000);
  c = resume(c, T0 + 600000);
  assert.equal(c.running, true);
  assert.equal(c.startedAt, T0 + 600000);
  c = tick(c, T0 + 601000);
  assert.equal(c.white, 175000, 'only the second of play after the resume was charged');
  // resume is a no-op on a clock that was never started, and on one already running.
  assert.ok(clockEquals(resume(blitz(), T0), blitz()));
  assert.ok(clockEquals(resume(c, T0 + 602000), c));
  assert.ok(clockEquals(pause(pause(c, T0 + 601000), T0 + 605000), pause(c, T0 + 601000)));
});

test('a move played while the clock is paused takes the increment and hands over, without burning', () => {
  const c = pause(start(blitz(), 'white', T0), T0 + 4000);
  const out = applyMove(c, T0 + 90000);
  assert.equal(out.white, 178000, '176000 + the 2000 increment, nothing burned');
  assert.equal(out.turn, 'black');
  assert.equal(out.running, false, 'the clock is still paused');
  assert.equal(out.startedAt, null);
});

test('reset / setTimeControl return both sides to the control and clear the flag', () => {
  let c = start(blitz(), 'white', T0);
  c = tick(c, T0 + 60000);
  const same = reset(c);
  assert.deepEqual(same, createClock({ initial: 180000, increment: 2000 }));
  const other = setTimeControl(c, { initial: 600000, increment: 0 });
  assert.deepEqual(other, createClock({ initial: 600000, increment: 0 }));
  const flagged = flag(c, 'white');
  assert.equal(reset(flagged).flagged, null);
  assert.equal(reset(flagged).turn, null);
  assert.equal(reset(flagged, { initial: 0, increment: 0 }).initial, 0, 'reset to untimed is allowed');
});

test('a clock that jumps backwards never hands time back, and nothing is mutated in place', () => {
  const started = start(blitz(), 'white', T0);
  const frozen = JSON.parse(JSON.stringify(started));
  const back = tick(started, T0 - 50000);
  assert.equal(back.white, 180000, 'a negative elapsed is clamped to zero');
  assert.equal(remaining(started, 'white', T0 - 50000), 180000);
  const moved = applyMove(started, T0 - 50000);
  assert.equal(moved.white, 182000, 'only the increment');
  assert.deepEqual(started, frozen, 'the input clock was never mutated');
  // cloneClock repairs a half-corrupt blob rather than propagating it.
  const repaired = cloneClock({ white: 'x', turn: 'purple', flagged: 7, initial: 1000 });
  assert.deepEqual(repaired, {
    running: false, white: 0, black: 0, turn: null, increment: 0, initial: 1000, flagged: null, startedAt: null,
  });
});

test('start on a running clock re-seats the turn, burning the previous side first', () => {
  let c = start(blitz(), 'white', T0);
  c = start(c, 'white', T0 + 1000);
  assert.equal(c.white, 180000, 'the same turn is not re-seated and no time is re-added');
  assert.equal(c.startedAt, T0, 'the running baseline is left alone');
  const swapped = start(tick(c, T0 + 1000), 'black', T0 + 1000);
  assert.equal(swapped.turn, 'black');
  assert.equal(swapped.white, 179000, 'white paid for the second it held the move');
  assert.equal(swapped.startedAt, T0 + 1000);
  // Re-seating across a flag flags instead.
  const dying = start(createClock({ initial: 500 }), 'white', T0);
  assert.equal(start(dying, 'black', T0 + 900).flagged, 'white');
});

test('clockEquals compares values, not identity', () => {
  const a = start(blitz(), 'white', T0);
  assert.equal(clockEquals(a, cloneClock(a)), true);
  assert.equal(clockEquals(a, tick(a, T0 + 1)), false);
  assert.equal(clockEquals(null, null), true);
  assert.equal(clockEquals(a, null), false);
});
