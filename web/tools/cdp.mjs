import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const [W, H] = spec.size || [1400, 900];

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9700 + Math.floor(Math.random() * 200);

const prof = mkdtempSync(join(tmpdir(), 'cbeval-'));
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`,
  '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const p = l.find((t) => t.type === 'page');
    if (p) ws = new WebSocket(p.webSocketDebuggerUrl);
  } catch {}

  if (!ws) await sleep(150);
}

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

let id = 0;
const pend = new Map();
const logs = [];

ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  else if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
});

const send = (method, params = {}) => new Promise((r) => {
  const i = ++id;
  pend.set(i, r);
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: spec.url || 'http://127.0.0.1:8150/' });

for (let i = 0; i < 100; i++) {
  await sleep(100);
  const r = await send('Runtime.evaluate', { expression: '!!window.__chessboard', returnByValue: true });
  if (r.result.result.value) break;
}

for (const st of spec.steps) {
  if (st.wait) await sleep(st.wait);

  if (st.js) {
    const r = await send('Runtime.evaluate', { expression: st.js, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) console.log('ERR', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    else if (r.result.result.value !== undefined) console.log(JSON.stringify(r.result.result.value));
  }

  if (st.shot) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(st.shot, Buffer.from(s.result.data, 'base64'));
    console.log('shot', st.shot);
  }
}

if (logs.length) console.log('console errors:', logs.slice(0, 10));

ws.close();
proc.kill();
await sleep(300);
try {
  rmSync(prof, { recursive: true, force: true });
} catch {}

process.exit(0);
