// three/redraw.js -- the one channel by which modules that change what is drawn tell the view to draw again.
//
// scene.js renders on demand: a frame is drawn only after something visible may have changed. The view owns the
// renderer; the board, the piece layer, the materials and the piece sets do not know the view, so they call
// requestRedraw() here and every live view (scene.js createView registers itself) marks a frame as needed.
//   kind 'content' -- something in the lit scene changed (a mesh moved, appeared, changed material or texture):
//                     the frame is drawn AND the shadow map is redrawn.
//   kind 'camera'  -- only the viewpoint or a post effect's input changed: the frame is drawn, the shadow kept.
// With no view registered (node tests, tools that build a layer alone) a request does nothing.

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
    try { fn(kind); } catch (err) { console.error('[redraw] handler failed', err); }
  }
}
