// three/motionQuality.js -- when the picture is in motion and the machine is not keeping up, draw it more cheaply.
//
// scene.js asks this policy which level to draw a motion frame at, and feeds it the time between consecutive drawn
// animation frames (the only speed signal a browser gives without GPU timer extensions). Frames at rest are always
// drawn at level 0; scene.js draws one full frame (the settle) once motion stops. The policy itself is pure: no
// clock, no renderer, so tests drive it with numbers.
//
//   createMotionPolicy(opts?) -> { sample(ms), level, interval, setMode('auto'|'full'), pin(n|null), pinned }
//
// The rules, all in MOTION below:
//   - Step DOWN one level when the last `window` intervals average above `budgetMs` AND at least `slowCount` of them
//     are above it: one slow frame (a garbage collection, a shader compile, a texture upload) never fills that.
//     After any level change the window starts empty, so the next decision is made on frames drawn at the new level.
//   - Step UP (a probe) after `probeAfterMs` of motion whose window average stays at or below `smoothMs`. If the probe
//     steps back down within `probeConfirmMs` of motion, the wait before the next probe doubles (up to
//     `maxBackoff` times); a probe that holds resets it.
//   - A step down has to buy something. When stepping down reaches the last level, its first full window is compared
//     with the averages that stepped each level down: the policy goes back to the lowest level whose average was
//     within `gainMin` of the best one, and stops stepping down until the interval grows by `retryAfter` times. So a
//     display or browser that caps frames near 30 per second (steady 33 ms whatever is drawn) returns to level 0 and
//     stays there, while a slow GPU keeps the level that made it faster. Only the last level is judged: a step that
//     helps the real cost of a frame can leave the vsync-rounded interval unchanged until the next one.
//   - A fast machine (frames at the display's rate) never fills a slow window, so it never leaves level 0.

/** The levels, cheapest last. `blurSamples` caps the key light's VSM blur (null = as configured); `ratio` scales the pixel ratio. */
export const MOTION_LEVELS = [
  { blurSamples: null, ratio: 1 },
  { blurSamples: 4, ratio: 1 },
  { blurSamples: 4, ratio: 0.75 },
  { blurSamples: 4, ratio: 0.5 },
];

/** The policy's numbers (milliseconds). `settleMs` is read by scene.js: how long nothing is owed before the full frame. */
export const MOTION = {
  budgetMs: 24,          // above this a frame interval counts as slow (a healthy 60 Hz display gives 16.7)
  window: 8,             // intervals per decision
  slowCount: 6,          // how many of them must be slow
  smoothMs: 20,          // a window averaging at or below this is smooth
  probeAfterMs: 3000,    // smooth motion before trying one level up
  probeConfirmMs: 1500,  // motion a probe must survive to count as held
  maxBackoff: 64,        // the longest wait before a probe, in multiples of probeAfterMs (about 3 min of motion)
  gainMin: 0.15,         // levels within this share of the best interval seen are not worth their cost
  retryAfter: 1.25,      // after stepping back up for no gain, step down again only once the interval is this much longer
  settleMs: 150,         // no frame owed for this long: draw the full-quality settle frame
};

const MAX_LEVEL = MOTION_LEVELS.length - 1;

export function normalizeQuality(v) { return v === 'full' ? 'full' : 'auto'; }

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
  let judging = false;   // the first full window at the last level, reached by stepping down, is still to be judged
  let blockedAt = null;  // stepping down is off while the interval stays near this (ms); null = on

  const mean = () => (win.length ? win.reduce((a, b) => a + b, 0) / win.length : 0);
  function change(next) {
    level = next;
    win.length = 0;
    smoothMs = 0;
  }

  return {
    /** One interval (ms) between two consecutive drawn motion frames. Returns true when the level changed. */
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
        if (keep < level) { blockedAt = avgs[keep]; probing = false; change(keep); return true; }
      }
      if (blockedAt !== null && avg > blockedAt * M.retryAfter) blockedAt = null;
      const slow = win.filter((x) => x > M.budgetMs).length;
      // a failed probe always steps back down: the level below is known to be needed
      if (avg > M.budgetMs && slow >= M.slowCount && (blockedAt === null || probing)) {
        if (level >= MAX_LEVEL) return false;
        if (probing) { probing = false; backoff = Math.min(backoff * 2, M.maxBackoff); }
        else { seen[level] = avg; judging = level + 1 === MAX_LEVEL; }
        change(level + 1);
        return true;
      }
      if (probing) {
        probeMs += ms;
        if (probeMs >= M.probeConfirmMs) { probing = false; backoff = 1; }
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
    /** 'auto' adapts; 'full' never reduces (the automatic level is kept for a return to 'auto'). */
    setMode(m) {
      const next = normalizeQuality(m);
      if (next !== mode) { mode = next; win.length = 0; smoothMs = 0; judging = false; }   // decide on frames drawn under the new mode
    },
    /** A number pins the level (0..3) for motion frames; null returns to automatic. */
    pin(n) {
      const next = n === null || n === undefined || !Number.isFinite(Number(n)) ? null
        : Math.max(0, Math.min(MAX_LEVEL, Math.round(Number(n))));
      if (next !== pinned) { pinned = next; win.length = 0; smoothMs = 0; judging = false; }   // pinned frames say nothing about the rest
    },
  };
}
