// Usage: node build.mjs [--dev] [--watch] [--no-single]
import { build, context } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const root = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const dev = args.has('--dev') || args.has('--watch');
const dist = join(root, 'dist');
const vendor = join(root, 'vendor');
const singleOut = join(root, '..', 'chessboard.html');

const GLUE = 'stockfish-19-lite-single.js';
const WASM = 'stockfish-19-lite-single.wasm';

const SETS = join(root, 'sets');
const DRACO_DIR = join(root, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco', 'gltf');
const DRACO_JS = 'draco_wasm_wrapper.js';
const DRACO_WASM = 'draco_decoder.wasm';
const setFiles = () => (existsSync(SETS) ? readdirSync(SETS).filter(f => f.endsWith('.glb')).sort() : []);

// The single-file build swaps these two exact tags; drift in index.html must fail the build.
const CSS_TAG = '<link rel="stylesheet" href="app.css">';
const JS_TAG = '<script src="app.js"></script>';
const countOf = (hay, needle) => hay.split(needle).length - 1;

const opts = {
  entryPoints: [join(root, 'src', 'main.js')],
  bundle: true,
  format: 'iife',
  outfile: join(dist, 'app.js'),
  target: ['es2022'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  loader: { '.css': 'css', '.svg': 'text', '.glsl': 'text', '.txt': 'text', '.jpg': 'dataurl', '.hdr': 'binary' },
  logLevel: 'info',
  // An IIFE bundle has no import.meta, and DRACOLoader reads import.meta.url at module load.
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"', 'import.meta.url': 'document.baseURI' },
};

function copyVendor() {
  mkdirSync(join(dist, 'vendor'), { recursive: true });

  for (const f of readdirSync(vendor)) {
    const src = join(vendor, f);
    if (statSync(src).isFile()) copyFileSync(src, join(dist, 'vendor', f));
  }
}

function copySets() {
  mkdirSync(join(dist, 'sets'), { recursive: true });
  for (const f of setFiles()) copyFileSync(join(SETS, f), join(dist, 'sets', f));

  mkdirSync(join(dist, 'vendor', 'draco'), { recursive: true });
  for (const f of [DRACO_JS, DRACO_WASM]) copyFileSync(join(DRACO_DIR, f), join(dist, 'vendor', 'draco', f));
}

function escapeInlineScript(s) {
  return s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
}

function writeIndex() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  writeFileSync(join(dist, 'index.html'), html);
}

function writeSingleFile() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const js = readFileSync(join(dist, 'app.js'), 'utf8');
  const cssPath = join(dist, 'app.css');
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  const glue = readFileSync(join(vendor, GLUE), 'utf8');
  const wasmB64 = readFileSync(join(vendor, WASM)).toString('base64');

  const nCss = countOf(html, CSS_TAG);
  const nJs = countOf(html, JS_TAG);

  if (nCss !== 1 || nJs !== 1) {
    throw new Error(`index.html must contain exactly one ${CSS_TAG} and one ${JS_TAG} for the single-file build ` +
      `(found ${nCss} and ${nJs}). Update build.mjs if the shell changed on purpose.`);
  }

  // Parse the escaped bundle so an escape that lands outside a string fails the build.
  const safeJs = escapeInlineScript(js);

  try {
    new Script(safeJs, { filename: 'inlined-app.js' });
  } catch (e) {
    throw new Error('inlining broke app.js (a "</script" or "<!--" sequence outside a string?): ' + e.message);
  }

  const dracoGlue = readFileSync(join(DRACO_DIR, DRACO_JS), 'utf8');
  const dracoB64 = readFileSync(join(DRACO_DIR, DRACO_WASM)).toString('base64');

  // Proxy sets ship only as separate files in dist/sets.
  const setTags = setFiles().filter(f => !f.endsWith('.proxy.glb')).map(f =>
    `<script type="text/plain" id="set-${f.replace(/\.glb$/, '')}">${readFileSync(join(SETS, f)).toString('base64')}</script>\n`).join('');

  const out = html
    .replace(CSS_TAG, () => `<style>\n${css.replace(/<\/style/gi, '<\\/style')}\n</style>`)
    .replace(JS_TAG, () =>
      `<script type="text/plain" id="sf-glue">${escapeInlineScript(glue)}</script>\n` +
      `<script type="text/plain" id="sf-wasm">${wasmB64}</script>\n` +
      `<script type="text/plain" id="draco-glue">${escapeInlineScript(dracoGlue)}</script>\n` +
      `<script type="text/plain" id="draco-wasm">${dracoB64}</script>\n` +
      setTags +
      `<script>${safeJs}</script>`);

  if (out.includes('href="app.css"') || out.includes('src="app.js"')) {
    throw new Error('single-file output still references app.css / app.js');
  }

  writeFileSync(singleOut, out);

  const mb = (statSync(singleOut).size / 1048576).toFixed(2);
  console.log(`single file -> ${singleOut} (${mb} MB)`);
}

async function once() {
  mkdirSync(dist, { recursive: true });
  await build(opts);

  copyVendor();
  copySets();
  writeIndex();
  if (!args.has('--no-single')) writeSingleFile();

  console.log('build ok');
}

if (args.has('--watch')) {
  const ctx = await context({
    ...opts,
    plugins: [{
      name: 'post', setup(b) {
        b.onEnd(r => {
          if (!r.errors.length) {
            copyVendor();
            copySets();
            writeIndex();

            try {
              writeSingleFile();
            } catch (e) {
              console.error(String(e));
            }
          }
        });
      },
    }],
  });

  await ctx.watch();
  console.log('watching...');
} else {
  await once();
}
