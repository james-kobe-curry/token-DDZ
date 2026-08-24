import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const browserCandidates = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const browserPath = browserCandidates.find((candidate) => existsSync(candidate));
if (!browserPath) throw new Error('Set BROWSER_PATH to a Chromium or Edge executable before running smoke:ui');

const baseUrl = process.env.SMOKE_URL || 'http://localhost:5173';
const lanUrl = process.env.SMOKE_LAN_URL || '';
const port = 9337;
const profile = join(tmpdir(), `token-landlords-smoke-${Date.now()}`);
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,900',
  `${baseUrl}/?play=1&demo=result`,
], { stdio: 'ignore' });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let socket;
let serial = 0;
const pending = new Map();

async function findTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === 'page');
      if (page) return page;
    } catch {
      // Browser debugging endpoint is still starting.
    }
    await sleep(100);
  }
  throw new Error('Browser DevTools target did not start');
}

function command(method, params = {}) {
  const id = ++serial;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const response = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

async function waitFor(expression, message, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return;
    await sleep(80);
  }
  throw new Error(message);
}

try {
  const page = await findTarget();
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  await command('Runtime.enable');
  await command('Page.enable');

  await waitFor("Boolean(document.querySelector('.result-actions button'))", 'result actions did not render');
  await evaluate("document.querySelector('.result-actions button').click(); true");
  await waitFor("Boolean(document.querySelector('.app-shell')) && !document.querySelector('.game-room')", 'result exit did not return to lobby');

  await evaluate(`localStorage.setItem('token-landlords:match-settings:v2', JSON.stringify({ soundOn: false, voiceOn: false, vibrationOn: false, smartArrange: true, autoMatch: true, motionOn: false, aiDifficulty: 'elite' })); true`);
  await command('Page.navigate', { url: `${baseUrl}/?play=1&demo=waiting` });
  await waitFor("document.querySelectorAll('.player-hand [data-card-id]').length >= 10 && Boolean(document.querySelector('.preselect-console'))", 'waiting preselect UI did not render');
  await waitFor("Boolean(document.querySelector('.player-hand.preselect-enabled:not(.input-locked)'))", 'waiting hand did not become interactive');
  const points = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('.player-hand [data-card-id]')];
    const start = cards[3].getBoundingClientRect();
    const end = cards[10].getBoundingClientRect();
    const visibleTop = Math.max(0, start.top, end.top);
    const visibleBottom = Math.min(innerHeight, start.bottom, end.bottom);
    const y = visibleTop + Math.min(24, Math.max(6, (visibleBottom - visibleTop) / 3));
    return { ax: start.left + Math.min(8, start.width / 4), ay: y, bx: end.left + Math.min(8, end.width / 4), by: y };
  })()`);
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: points.ax, y: points.ay, button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 12; step += 1) {
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: points.ax + (points.bx - points.ax) * step / 12, y: points.ay, button: 'left', buttons: 1 });
    await sleep(16);
  }
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: points.bx, y: points.by, button: 'left', buttons: 0, clickCount: 1 });
  await waitFor("document.querySelectorAll('.player-hand .selected').length > 0", 'swipe did not select cards');
  const swipeCount = await evaluate("document.querySelectorAll('.player-hand .selected').length");
  await sleep(1800);
  const persistedCount = await evaluate("document.querySelectorAll('.player-hand .selected').length");
  if (!persistedCount) throw new Error('AI turn cleared the player preselection');

  await sleep(250);
  await command('Page.navigate', { url: `${baseUrl}/` });
  await waitFor("Boolean(document.querySelector('.game-room'))", 'saved match did not restore after reload');
  const restoredCount = await evaluate("document.querySelectorAll('.player-hand .selected').length");
  if (restoredCount !== persistedCount) throw new Error(`restored selection mismatch: expected ${persistedCount}, got ${restoredCount}`);

  await command('Page.navigate', { url: `${baseUrl}/?play=1&demo=playing` });
  await waitFor("Boolean(document.querySelector('.hint-action:not(:disabled)'))", 'smart hint did not become available on a lead turn');
  await evaluate("document.querySelector('.hint-action').click(); true");
  await sleep(100);
  const firstHint = await evaluate("[...document.querySelectorAll('.player-hand .selected')].map((card) => card.dataset.cardId).join('|')");
  const optionCount = await evaluate("Number(document.querySelector('.hint-action em')?.textContent?.match(/\\/(\\d+)/)?.[1] || 1)");
  await evaluate("document.querySelector('.hint-action').click(); true");
  await sleep(100);
  const secondHint = await evaluate("[...document.querySelectorAll('.player-hand .selected')].map((card) => card.dataset.cardId).join('|')");
  if (optionCount > 1 && firstHint === secondHint) throw new Error('smart hint did not advance');

  let lanRoom = null;
  if (lanUrl) {
    await evaluate("document.querySelector('.room-brand .icon-btn')?.click(); true");
    await waitFor("Boolean(document.querySelector('.mode-card.friend'))", 'friend room entry did not render');
    await evaluate("document.querySelector('.mode-card.friend').click(); true");
    await waitFor("Boolean(document.querySelector('.lan-lobby'))", 'LAN lobby did not open');
    await evaluate(`(() => { const input = document.querySelector('.lan-field input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, ${JSON.stringify(lanUrl)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await evaluate("document.querySelector('.lan-create-row .btn-primary').click(); true");
    await waitFor("Boolean(document.querySelector('.lan-code b'))", 'LAN room could not be created');
    lanRoom = await evaluate("document.querySelector('.lan-code b').textContent");
  }

  console.log(JSON.stringify({ resultExit: true, swipeCount, persistedCount, restoredCount, hintOptions: optionCount, hintAdvanced: optionCount <= 1 || firstHint !== secondHint, lanRoom }));
} finally {
  socket?.close();
  browser.kill();
}
