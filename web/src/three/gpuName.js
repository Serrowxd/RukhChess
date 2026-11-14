/** Splits on commas that are not inside parentheses. */
function topLevelParts(s) {
  const parts = [];
  let depth = 0, start = 0;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }

  parts.push(s.slice(start).trim());

  return parts;
}

/** Renderer strings that stand in for a hidden adapter name. */
const PLACEHOLDERS = new Set(['mozilla', 'generic renderer', 'unknown', 'webkit webgl', 'webkit']);

/** Longer than any real renderer string; keeps the work small. */
const MAX_LENGTH = 256;

export function cleanGpuName(raw) {
  if (typeof raw !== 'string') return '';

  let s = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LENGTH).trim();

  // Firefox reports a group of similar cards and says so; that note is kept.
  let similar = '';
  const bucket = /^(.*\S) ?, ?or similar$/i.exec(s);

  if (bucket) {
    s = bucket[1];
    similar = ', or similar';
  }

  const angle = /^ANGLE \((.*)\)$/.exec(s);

  if (angle) {
    const parts = topLevelParts(angle[1]);

    // (vendor, device, backend); with fewer parts take the last that is not the backend
    s = parts.length >= 3 ? parts.slice(1, -1).join(', ') : (parts[1] || parts[0] || '');
  }

  // 'Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE))'
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

/** The adapter name of a WebGL context, or '' when it is not available. */
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
