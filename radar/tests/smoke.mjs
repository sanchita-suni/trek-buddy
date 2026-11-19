// Headless smoke test: serves radar/ on localhost, opens ?demo=1 in headless
// Chrome/Edge over the DevTools protocol (Node 22 built-in WebSocket, no deps),
// and checks the radar renders, the SOS banner comes and goes, the duplicate is
// dropped, the NO_FIX packet doesn't move Trekker 3, and nothing hits the console as an error.
//
//   node tests/smoke.mjs [screenshot-dir]
//   BROWSER=/path/to/chrome node tests/smoke.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.resolve(process.argv[2] || os.tmpdir());
const SPEED = 4; // demo runs 4x: SOS at 5 s real time, clears at 15 s
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- static server ---------- */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ---------- browser ---------- */
function findBrowser() {
  const candidates = [
    process.env.BROWSER,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('No Chrome/Edge found; set BROWSER=/path/to/chrome');
  return found;
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'trek-radar-smoke-'));
const browser = spawn(findBrowser(), [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=412,915', 'about:blank',
], { stdio: 'ignore' });

let exitCode = 1;
const failures = [];
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures.push(msg); };

try {
  // DevToolsActivePort appears once the browser is listening
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(150);
  const dport = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const targets = await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');

  /* ---------- tiny CDP client ---------- */
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(SHOT_DIR, name);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`      screenshot: ${file}`);
  };

  const consoleErrors = [];
  const consoleWarnings = [];
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (m.params.type === 'error' || m.params.type === 'assert') consoleErrors.push(text);
      else if (m.params.type === 'warning') consoleWarnings.push(text);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error') consoleErrors.push(`${e.source}: ${e.text} ${e.url ?? ''}`.trim());
      else if (e.level === 'warning') consoleWarnings.push(`${e.source}: ${e.text}`);
    }
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  const loaded = new Promise((r) => listeners.push((m) => { if (m.method === 'Page.loadEventFired') r(); }));
  await send('Page.navigate', { url: `${base}/?demo=1&speed=${SPEED}` });
  await loaded;
  const t0 = Date.now();
  const at = (demoSeconds) => sleep(Math.max(0, t0 + (demoSeconds / SPEED) * 1000 - Date.now()));

  // ---- shortly after start
  await at(4);
  const early = await evaluate(`(() => {
    const cv = document.getElementById('radar');
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let green = 0, blue = 0;
    for (let i = 0; i < img.length; i += 4) {
      if (img[i + 1] > 200 && img[i] < 120) green++;          // ring colour
      if (img[i + 2] > 200 && img[i + 1] > 180 && img[i] < 140) blue++; // trekker dot
    }
    return {
      cw: cv.width, ch: cv.height, green, blue,
      cards: [...document.querySelectorAll('#cards .card')].map(c => c.querySelector('.name').textContent),
      bannerHidden: document.getElementById('sos-banner').hidden,
      conn: document.getElementById('conn-text').textContent,
      me: document.getElementById('me-text').textContent,
      scrollW: document.documentElement.scrollWidth, vw: innerWidth,
    };
  })()`);
  check(early.cw > 0 && early.cw === early.ch, `radar canvas is square and sized (${early.cw}px)`);
  check(early.green > 500, `radar rings drawn (${early.green} ring pixels)`);
  check(early.blue > 20, `trekker blip drawn (${early.blue} blip pixels)`);
  check(early.cards.includes('Trekker 2') && early.cards.includes('Trekker 3'), `cards for Trekker 2 and 3 (${early.cards.join(', ')})`);
  check(!early.cards.includes('Trekker 1'), 'own pendant (RSSI 0) is not listed as a trekker');
  check(early.bannerHidden, 'no SOS banner before 20 s');
  check(/^Me: pendant GPS/.test(early.me), `my position from own packets ("${early.me}")`);
  check(early.scrollW <= early.vw, `no horizontal scroll (${early.scrollW} <= ${early.vw})`);
  await shot('trek-radar-demo-normal.png');

  // ---- during SOS
  await at(30);
  const sos = await evaluate(`(() => ({
    bannerHidden: document.getElementById('sos-banner').hidden,
    banner: document.getElementById('sos-banner').innerText,
    t2Sos: document.querySelector('#cards .card')?.classList.contains('sos'),
    firstCard: document.querySelector('#cards .card .name')?.textContent,
    t3: [...document.querySelectorAll('#cards .card')].find(c => c.querySelector('.name').textContent === 'Trekker 3')?.querySelector('.dist').textContent,
    stats: window.trekRadar.store.stats,
  }))()`);
  check(!sos.bannerHidden, 'SOS banner visible at 30 s');
  check(/SOS: Trekker 2, \d+ m (N|NE|E|SE|S|SW|W|NW)/.test(sos.banner), `banner text "${sos.banner.split('\n')[0]}"`);
  check(sos.firstCard === 'Trekker 2' && sos.t2Sos, 'Trekker 2 card is first and red');
  check(sos.stats.duplicates === 1, `exactly one duplicate dropped (${sos.stats.duplicates})`);
  check(sos.t3 === '1.2 km', `NO_FIX packet did not move Trekker 3 (${sos.t3})`);
  await shot('trek-radar-demo-sos.png');

  // ---- silence button keeps banner
  await evaluate(`document.querySelector('.sos-silence').click()`);
  await sleep(300);
  const silenced = await evaluate(`({ hidden: document.getElementById('sos-banner').hidden, btn: document.querySelector('.sos-silence').textContent })`);
  check(!silenced.hidden && silenced.btn === 'Silenced', 'Silence keeps the banner and marks it silenced');

  // ---- after SOS clears
  await at(66);
  const after = await evaluate(`(() => ({
    bannerHidden: document.getElementById('sos-banner').hidden,
    anyRed: !!document.querySelector('#cards .card.sos'),
  }))()`);
  check(after.bannerHidden && !after.anyRed, 'SOS banner and red card clear after 60 s');

  // ---- my own SOS: a short press does nothing, a 2 s hold sends, tap + confirm cancels
  const btnBox = await evaluate(`(() => { const r = document.getElementById('my-sos').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const mySosState = () => evaluate(`({ label: document.getElementById('my-sos-label').textContent, ownSos: window.trekRadar.store.own.sos })`);
  const mouse = (type) => send('Input.dispatchMouseEvent', { type, x: btnBox.x, y: btnBox.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await mouse('mousePressed'); await sleep(600); await mouse('mouseReleased'); await sleep(300);
  let mine = await mySosState();
  check(!mine.ownSos && /Hold 2 s/.test(mine.label), `short press does not send SOS ("${mine.label}")`);
  await mouse('mousePressed'); await sleep(2300); await mouse('mouseReleased'); await sleep(400);
  mine = await mySosState();
  check(mine.ownSos && /SOS SENT/.test(mine.label), `2 s hold sends SOS ("${mine.label}")`);
  await shot('trek-radar-demo-my-sos.png');
  // Native dialogs are unreliable in headless mode, so stub confirm() and record what it asked.
  await evaluate(`window.confirm = (m) => { window.__confirmMsg = m; return true; }`);
  await mouse('mousePressed'); await mouse('mouseReleased');
  await sleep(400);
  const dialogMsg = await evaluate('window.__confirmMsg || ""');
  mine = await mySosState();
  check(/Cancel your SOS/.test(dialogMsg) && !mine.ownSos && /Hold 2 s/.test(mine.label), `tap + confirm cancels SOS ("${mine.label}")`);

  check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? ':\n        ' + consoleErrors.join('\n        ') : ''}`);
  if (consoleWarnings.length) console.log(`      (warnings: ${consoleWarnings.join(' | ')})`);

  ws.close();
  exitCode = failures.length ? 1 : 0;
} catch (err) {
  console.error('Smoke test crashed:', err);
} finally {
  browser.kill();
  server.close();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
  console.log(exitCode === 0 ? '\nSmoke test passed.' : `\nSmoke test FAILED (${failures.length} checks).`);
  process.exit(exitCode);
}
