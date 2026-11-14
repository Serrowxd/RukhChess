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

/** The GLB bytes for a modelled set: the inline copy, else a fetch of sets/<file>. */
export async function loadSetBytes(entry) {
  if (!entry) throw new Error('loadSetBytes: unknown set');

  const tag = typeof document !== 'undefined' ? document.getElementById('set-' + entry.id) : null;

  if (tag && tag.textContent) return base64ToBuffer(tag.textContent);

  const res = await fetch('sets/' + entry.file);

  if (!res.ok) throw new Error(`piece set '${entry.id}': HTTP ${res.status}`);

  return res.arrayBuffer();
}

/** The GLB bytes of a set's stand-ins, or null on any failure or timeout. Never throws. */
export async function loadProxyBytes(entry, { timeoutMs = 5000 } = {}) {
  if (!entry || !entry.proxy || typeof fetch !== 'function') return null;
  if (typeof document !== 'undefined' && document.getElementById('set-' + entry.id)) return null;

  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;

  const late = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (abort) abort.abort();
      resolve(null);
    }, timeoutMs);
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
