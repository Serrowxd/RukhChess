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

/** The shared loader, created on first use. */
export function getDracoLoader() {
  if (loader) return loader;

  loader = new InlineDracoLoader();

  // The single-file build inlines the decoder as script tags instead of vendor files.
  const inline = typeof document !== 'undefined' && document.getElementById('draco-glue');

  loader.setDecoderPath(inline
    ? { js: EMBED + 'draco-glue', wasm: EMBED + 'draco-wasm' }
    : { js: 'vendor/draco/draco_wasm_wrapper.js', wasm: 'vendor/draco/draco_decoder.wasm' });

  return loader;
}
