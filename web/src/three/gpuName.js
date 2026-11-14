// three/gpuName.js — the name of the graphics adapter a WebGL context draws on, for the About block.
//
//   readGpuName(gl) -> string    the cleaned UNMASKED_RENDERER_WEBGL string, or '' when the browser does not give it
//   cleanGpuName(raw) -> string  the renderer string made readable, e.g.
//     'ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 (0x00002C02) Direct3D11 vs_5_0 ps_5_0, D3D11)' -> 'NVIDIA GeForce RTX 5080'
//
// Chromium wraps the adapter in ANGLE (vendor, device, backend); the device part also carries a PCI id and the
// Direct3D shader model. Firefox gives the plain name, sometimes with '/PCIe/SSE2' after it, or a group of similar
// cards ending in ', or similar'. Firefox also prints a deprecation note in the console when the extension is asked
// for (it prefers gl.RENDERER); gl.RENDERER is not used here because Chromium answers it with 'WebKit WebGL'.

/** Splits on commas that are not inside parentheses. */
function topLevelParts(s) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

/** Renderer strings that stand in for a hidden adapter name; they name no adapter, so nothing is shown. */
const PLACEHOLDERS = new Set(['mozilla', 'generic renderer', 'unknown', 'webkit webgl', 'webkit']);

/** Longer than any real renderer string; after whitespace is collapsed the rest is dropped, so the work stays small. */
const MAX_LENGTH = 256;

export function cleanGpuName(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH).trim();
  // Firefox reports a group of similar cards, not the exact one, and says so; that note is kept.
  let similar = '';
  const bucket = /^(.*\S) ?, ?or similar$/i.exec(s);
  if (bucket) { s = bucket[1]; similar = ', or similar'; }
  const angle = /^ANGLE \((.*)\)$/.exec(s);
  if (angle) {
    const parts = topLevelParts(angle[1]);
    // (vendor, device, backend); with fewer parts take the last that is not the backend
    s = parts.length >= 3 ? parts.slice(1, -1).join(', ') : (parts[1] || parts[0] || '');
  }
  // ANGLE on Vulkan wraps the device once more: 'Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE))'
  const vulkan = /^Vulkan [\d.]+ \((.*)\)$/.exec(s);
  if (vulkan) s = vulkan[1];
  s = s
    .replace(/^ANGLE [A-Za-z]+ Renderer: ?/, '')          // 'ANGLE Metal Renderer: Apple M1 Pro'
    .replace(/ ?\(0x[0-9a-fA-F]+\).*$/, '')               // PCI id and everything after it
    .replace(/ Direct3D\S*( vs_\S+)?( ps_\S+)?$/, '')
    .replace(/\/PCIe\/SSE2$/, '')
    .replace(/^(\S+) \1 /i, '$1 ')                         // 'NVIDIA NVIDIA GeForce' (vendor given twice)
    .trim();
  if (!s || PLACEHOLDERS.has(s.toLowerCase())) return '';
  return s + similar;
}

/** The adapter name of a WebGL context, or '' when it is not available (no extension, a lost context, a stand-in). */
export function readGpuName(gl) {
  try {
    if (!gl || typeof gl.getExtension !== 'function' || typeof gl.getParameter !== 'function') return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) return '';
    return cleanGpuName(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    return '';
  }
}
