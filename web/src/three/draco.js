// three/draco.js -- one shared DRACOLoader for the modelled piece sets (their GLBs are Draco-compressed).
//
// The decoder is two files: a JS wrapper and a WASM binary (three's `libs/draco/gltf` build).
//   * dist/: build.mjs copies them to vendor/draco/ and they are fetched from there;
//   * the single-file build: build.mjs inlines them as `<script type="text/plain" id="draco-glue">` (text)
//     and `id="draco-wasm"` (base64), and this loader reads those tags instead of fetching -- so the file
//     still works from file:// with no server.

import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { base64ToBuffer } from './modeledSets.js';

const EMBED = 'embedded:';

class InlineDracoLoader extends DRACOLoader {
  _loadLibrary(url, responseType) {
    if (typeof url === 'string' && url.startsWith(EMBED)) {
      const tag = typeof document !== 'undefined' ? document.getElementById(url.slice(EMBED.length)) : null;
      if (!tag || !tag.textContent) return Promise.reject(new Error('Draco decoder missing from this build'));
      return Promise.resolve(responseType === 'arraybuffer' ? base64ToBuffer(tag.textContent) : tag.textContent);
    }
    return super._loadLibrary(url, responseType);
  }
}

let loader = null;

/** The shared loader (created on first use). */
export function getDracoLoader() {
  if (loader) return loader;
  loader = new InlineDracoLoader();
  const inline = typeof document !== 'undefined' && document.getElementById('draco-glue');
  loader.setDecoderPath(inline
    ? { js: EMBED + 'draco-glue', wasm: EMBED + 'draco-wasm' }
    : { js: 'vendor/draco/draco_wasm_wrapper.js', wasm: 'vendor/draco/draco_decoder.wasm' });
  return loader;
}
