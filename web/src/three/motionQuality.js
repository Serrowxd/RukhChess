/** The levels, cheapest last; `blurSamples` caps the VSM blur (null: as set), `ratio` scales the pixel ratio. */
export const MOTION_LEVELS = [
  { blurSamples: null, ratio: 1 },
  { blurSamples: 4, ratio: 1 },
  { blurSamples: 4, ratio: 0.75 },
  { blurSamples: 4, ratio: 0.5 },
];

/** The policy's numbers in milliseconds; scene.js reads `settleMs`. */
export const MOTION = {
  budgetMs: 24,          // above this a frame interval counts as slow (a healthy 60 Hz display gives 16.7)
  window: 8,             // intervals per decision
  slowCount: 6,          // how many of them must be slow
  smoothMs: 20,          // a window averaging at or below this is smooth
  probeAfterMs: 3000,    // smooth motion before trying one level up
  probeConfirmMs: 1500,  // motion a probe must survive to count as held
  maxBackoff: 64,        // the longest wait before a probe, in probeAfterMs (about 3 min)
  gainMin: 0.15,         // levels within this share of the best interval seen are not worth their cost
  retryAfter: 1.25,      // after a step up gained nothing, step down only at this much longer intervals
  settleMs: 150,         // no frame owed for this long: draw the full-quality settle frame
};

const MAX_LEVEL = MOTION_LEVELS.length - 1;

/** settings.quality. `adapt`: the motion policy applies on top; null keeps what the lighting asks for. */
export const QUALITY = {
  auto: { adapt: true, mapSize: null, blurSamples: null, ratioCap: null, shadows: true, effects: true },
  high: { adapt: false, mapSize: null, blurSamples: null, ratioCap: null, shadows: true, effects: true },
  medium: { adapt: true, mapSize: 1024, blurSamples: 6, ratioCap: 1, shadows: true, effects: true },
  low: { adapt: true, mapSize: null, blurSamples: null, ratioCap: 1, shadows: false, effects: false },
};

/** 'full' means 'high'; anything unknown is 'auto'. */
export function normalizeQuality(v) {
  if (v === 'full') return 'high';

  return typeof v === 'string' && Object.hasOwn(QUALITY, v) ? v : 'auto';
}

export function createMotionPolicy(opts = {}) {
  const M = { ...MOTION, ...opts };
  let level = 0;
  let mode = 'auto';
  let pinned = null;
  const win = [];
  let smoothMs = 0;      // smooth motion seen since the last level change
  let probing = false;
  let probeMs = 0;       // motion seen since the probe started
  let backoff = 1;
  const seen = [];       // seen[L]: the window average that stepped level L down
  let judging = false;   // the first full window at the last level is still to be judged
  let blockedAt = null;  // stepping down is off while the interval stays near this (ms); null = on

  const mean = () => (win.length ? win.reduce((a, b) => a + b, 0) / win.length : 0);

  function change(next) {
    level = next;
    win.length = 0;
    smoothMs = 0;
  }

  return {
    /** One interval (ms) between two drawn motion frames. Returns true when the level changed. */
    sample(ms) {
      if (!(ms >= 0)) return false;

      win.push(ms);
      if (win.length > M.window) win.shift();

      if (mode === 'full' || pinned !== null || win.length < M.window) return false;

      const avg = mean();

      if (judging) {
        judging = false;

        const avgs = [...Array.from({ length: MAX_LEVEL }, (_, i) => seen[i] ?? Infinity), avg];
        const best = Math.min(...avgs);
        const keep = avgs.findIndex((a) => a * (1 - M.gainMin) <= best);

        if (keep < level) {
          blockedAt = avgs[keep];
          probing = false;
          change(keep);
          return true;
        }
      }

      if (blockedAt !== null && avg > blockedAt * M.retryAfter) blockedAt = null;

      const slow = win.filter((x) => x > M.budgetMs).length;

      // a failed probe always steps back down: the level below is known to be needed
      if (avg > M.budgetMs && slow >= M.slowCount && (blockedAt === null || probing)) {
        if (level >= MAX_LEVEL) return false;

        if (probing) {
          probing = false;
          backoff = Math.min(backoff * 2, M.maxBackoff);
        } else {
          seen[level] = avg;
          judging = level + 1 === MAX_LEVEL;
        }

        change(level + 1);
        return true;
      }

      if (probing) {
        probeMs += ms;

        if (probeMs >= M.probeConfirmMs) {
          probing = false;
          backoff = 1;
        }
      }

      if (avg <= M.smoothMs) smoothMs += ms;
      else smoothMs = 0;

      if (level > 0 && !probing && smoothMs >= M.probeAfterMs * backoff) {
        change(level - 1);
        probing = true;
        probeMs = 0;
        return true;
      }

      return false;
    },

    /** The level motion frames are drawn at now: the pin, else 0 under 'full', else the automatic level. */
    get level() { return pinned !== null ? pinned : (mode === 'full' ? 0 : level); },

    /** The average interval of the current window (ms, 0 when empty). */
    get interval() { return mean(); },

    get backoff() { return backoff; },

    /** The interval (ms) stepping down is held off at after a step bought nothing; null when it is not. */
    get blockedAt() { return blockedAt; },

    get pinned() { return pinned; },

    /** 'auto' adapts; 'full' never reduces. */
    setMode(m) {
      const next = m === 'full' ? 'full' : 'auto';

      // decide on frames drawn under the new mode
      if (next !== mode) {
        mode = next;
        win.length = 0;
        smoothMs = 0;
        judging = false;
      }
    },

    /** A number pins the level (0..3) for motion frames; null returns to automatic. */
    pin(n) {
      const next = n === null || n === undefined || !Number.isFinite(Number(n)) ? null
        : Math.max(0, Math.min(MAX_LEVEL, Math.round(Number(n))));

      // pinned frames say nothing about the rest
      if (next !== pinned) {
        pinned = next;
        win.length = 0;
        smoothMs = 0;
        judging = false;
      }
    },
  };
}
