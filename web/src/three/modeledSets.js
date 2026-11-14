// three/modeledSets.js -- the piece sets modelled in Blender (Ideas/Chessboard/blender/set_*.py) and
// shipped as one GLB each. Pure data plus the byte loader; pieces.js turns the bytes into a set.
//
// Every GLB follows one convention (cbkit.export_set):
//   * six mesh nodes named `${prefix}${role}` (pawn .. king), authored at their base centre, facing +Z;
//   * every piece carries the WHITE baked material;
//   * one hidden one-triangle node `${prefix}swatch_black` carries the BLACK material, which the board
//     applies to clones of the same meshes (so the geometry ships once).
//
// Where the bytes come from:
//   * dist/ (hosted or the local preview server): fetched from `sets/<file>` next to index.html, on demand;
//   * the single-file chessboard.html: a `<script type="text/plain" id="set-<id>">` holding the base64
//     GLB, written by build.mjs. Nothing is decoded until the set is chosen.
//
// `proxy` names a second, small GLB beside the set (tools/make-proxies.mjs): the same six mesh nodes simplified to
// 1500 to 6000 triangles each (more where thin features need them to keep their outline), positions only. The board draws the shadow map and the edge-light mask from these stand-ins
// instead of the full pieces. The single-file build carries none; without them the full pieces do both.

/** Menu order. `blurb` is the tooltip in Settings. */
export const MODELED_SETS = [
  { id: 'classic', name: 'Classic', blurb: 'Jaques Staunton in boxwood and ebony', file: 'classic.glb', proxy: 'classic.proxy.glb', prefix: 'classic_' },
  { id: 'menagerie', name: 'Menagerie', blurb: 'Woodland animals in porcelain and bronze, gilded', file: 'menagerie.glb', proxy: 'menagerie.proxy.glb', prefix: 'menagerie_' },
  { id: 'cairn', name: 'Cairn', blurb: 'Balanced river stones, limestone and mossy basalt', file: 'cairn.glb', proxy: 'cairn.proxy.glb', prefix: 'cairn_' },
  { id: 'beton', name: 'Béton', blurb: 'Staunton cast in board-formed concrete, weathering-steel accents', file: 'beton.glb', proxy: 'beton.proxy.glb', prefix: 'beton_' },
  { id: 'estate', name: 'Estate', blurb: 'Staunton as brutalist towers, by day and by night', file: 'estate.glb', proxy: 'estate.proxy.glb', prefix: 'estate_' },
];

/** The modelled set with this id, or null. */
export function modeledSet(id) {
  return MODELED_SETS.find((s) => s.id === id) || null;
}

/** Decode a base64 string to an ArrayBuffer. */
export function base64ToBuffer(b64) {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/**
 * The GLB bytes for a modelled set: the inline copy when this is the single-file build, otherwise a fetch
 * of sets/<file> relative to the page.
 * @returns {Promise<ArrayBuffer>}
 */
export async function loadSetBytes(entry) {
  if (!entry) throw new Error('loadSetBytes: unknown set');
  const tag = typeof document !== 'undefined' ? document.getElementById('set-' + entry.id) : null;
  if (tag && tag.textContent) return base64ToBuffer(tag.textContent);
  const res = await fetch('sets/' + entry.file);
  if (!res.ok) throw new Error(`piece set '${entry.id}': HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * The GLB bytes of a modelled set's stand-ins (sets/<proxy>), or null: the set lists none, this is the single-file
 * build (which carries none), or the fetch failed or took longer than `timeoutMs`. Never throws: without stand-ins
 * the board works as before. The set waits for this, so a stalled request must not hold the set back for long.
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function loadProxyBytes(entry, { timeoutMs = 5000 } = {}) {
  if (!entry || !entry.proxy || typeof fetch !== 'function') return null;
  if (typeof document !== 'undefined' && document.getElementById('set-' + entry.id)) return null;
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => { if (abort) abort.abort(); resolve(null); }, timeoutMs);
  });
  const load = (async () => {
    try {
      const res = await fetch('sets/' + entry.proxy, abort ? { signal: abort.signal } : undefined);
      return res.ok ? await res.arrayBuffer() : null;
    } catch (err) {
      return null;
    }
  })();
  try {
    return await Promise.race([load, late]);
  } finally {
    clearTimeout(timer);
  }
}
