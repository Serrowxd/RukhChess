const handlers = new Set();

/** Register fn(kind) to hear redraw requests; returns unsubscribe. */
export function onRedraw(fn) {
  if (typeof fn !== 'function') return () => {};

  handlers.add(fn);

  return () => handlers.delete(fn);
}

/** Ask every live view for a frame: 'content' (default) or 'camera'. */
export function requestRedraw(kind = 'content') {
  for (const fn of handlers) {
    try {
      fn(kind);
    } catch (err) {
      console.error('[redraw] handler failed', err);
    }
  }
}
