// The browser tools (`browser_open`, `browser_act`, `browser_close`, the
// twins of agent-runtime's routes/browser.ts): one Chromium per sandbox, on
// the sandbox's desktop, driven over the DevTools protocol on 127.0.0.1.
// No library: Node's own WebSocket and fetch speak the protocol.

import { spawn } from 'node:child_process';

import { DISPLAY, HEIGHT, WIDTH, ensureDesktop } from './desktop.mjs';
import { checkUrl } from './fetch.mjs';
import { BadRequest, cap } from './util.mjs';

const DEBUG_PORT = 9222;
const PAGE_TEXT = 8000;
const SHOT_BASE64 = 1_500_000;

/** A DevTools connection: commands by id, events by name. */
export class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.next = 1;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    });
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('The browser closed'));
      this.pending.clear();
    });
  }

  static open(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot reach the browser')), { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(message));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 45_000);
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // closed
    }
  }
}

let state = null;

async function versionUrl() {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
  return (await response.json()).webSocketDebuggerUrl;
}

async function launch() {
  await ensureDesktop();
  const home = process.env.HOME || '/home/sandbox';
  const child = spawn(
    process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    [
      '--no-sandbox', // gVisor is the sandbox; Chromium's own needs privileges the pod hasn't
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${home}/.chromium`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--password-store=basic',
      '--window-position=0,0',
      `--window-size=${WIDTH},${HEIGHT}`,
      'about:blank',
    ],
    { env: { ...process.env, DISPLAY, HOME: home }, stdio: 'ignore' },
  );
  child.on('error', () => undefined);
  let url;
  const deadline = Date.now() + 20_000;
  while (!url) {
    url = await versionUrl().catch(() => undefined);
    if (!url) {
      if (Date.now() > deadline || child.exitCode != null) throw new Error('The browser did not start');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  const cdp = await Cdp.open(url);
  const { targetInfos } = await cdp.send('Target.getTargets');
  let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
  if (!targetId) ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  child.on('exit', () => {
    if (state?.child === child) state = null;
  });
  return { child, cdp, sessionId };
}

async function browser() {
  state ??= await launch();
  return state;
}

async function evaluate(expression) {
  const { cdp, sessionId } = await browser();
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (exceptionDetails) throw new BadRequest(exceptionDetails.exception?.description?.split('\n')[0] ?? 'The page script failed');
  return result?.value;
}

async function settle(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate('document.readyState').catch(() => 'loading');
    if (ready !== 'loading') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function goto(raw) {
  // Public http(s) only, as web_fetch; the network policy holds the rest.
  const url = (await checkUrl(raw)).toString();
  const { cdp, sessionId } = await browser();
  const { errorText } = await cdp.send('Page.navigate', { url }, sessionId);
  if (errorText) throw new BadRequest(`The page could not be opened (${errorText}).`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await settle();
}

async function shot() {
  const { cdp, sessionId } = await browser();
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, sessionId);
  return data.length <= SHOT_BASE64 ? { mime: 'image/jpeg', base64: data } : undefined;
}

async function page({ text = false, screenshot = false } = {}) {
  const info = await evaluate('({ title: document.title, url: location.href })');
  const out = { title: info?.title ?? '', url: info?.url ?? '' };
  if (text) {
    out.text = cap(await evaluate(`document.body ? document.body.innerText.slice(0, ${PAGE_TEXT * 2}) : ''`), PAGE_TEXT).text;
  }
  if (screenshot) out.screenshot = await shot();
  return out;
}

/** The center of the first element matching `selector`, scrolled into view. */
async function locate(selector) {
  const found = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!found) throw new BadRequest(`No element matches ${selector}`);
  return found;
}

const KEYS = {
  Enter: [13, '\r'],
  Tab: [9, '\t'],
  Escape: [27],
  Backspace: [8],
  Delete: [46],
  ArrowUp: [38],
  ArrowDown: [40],
  ArrowLeft: [37],
  ArrowRight: [39],
  Home: [36],
  End: [35],
  PageUp: [33],
  PageDown: [34],
  Space: [32, ' '],
};

async function press(key) {
  const { cdp, sessionId } = await browser();
  const known = KEYS[key];
  if (!known) {
    if ([...key].length === 1) {
      await cdp.send('Input.insertText', { text: key }, sessionId);
      return;
    }
    throw new BadRequest(`Unknown key ${key}; use Enter, Tab, Escape, Backspace, Delete, an arrow, Home, End, PageUp, PageDown or one character`);
  }
  const [code, text] = known;
  const base = { key: key === 'Space' ? ' ' : key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
}

/** `POST /v1/browser/open`. */
export async function open(body) {
  await goto(String(body.url ?? ''));
  return { ok: true, ...(await page({ text: true, screenshot: true })) };
}

/** `POST /v1/browser/act`. */
export async function act(body) {
  const action = String(body.action ?? '');
  const { cdp, sessionId } = await browser();
  switch (action) {
    case 'goto':
      if (!body.url) throw new BadRequest('url required for goto');
      await goto(String(body.url));
      break;
    case 'click': {
      if (!body.selector) throw new BadRequest('selector required for click');
      const { x, y } = await locate(String(body.selector));
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      await settle(10_000);
      break;
    }
    case 'type':
      if (!body.selector || body.text == null) throw new BadRequest('selector and text required for type');
      await locate(String(body.selector));
      await evaluate(`document.querySelector(${JSON.stringify(String(body.selector))}).focus()`);
      await cdp.send('Input.insertText', { text: String(body.text) }, sessionId);
      break;
    case 'press':
      if (!body.key) throw new BadRequest('key required for press');
      await press(String(body.key));
      await settle(10_000);
      break;
    case 'wait':
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(Number(body.waitMs) || 1000, 0), 30_000)));
      break;
    case 'screenshot':
    case 'extract':
      break;
    default:
      throw new BadRequest('Unknown action');
  }
  const withText = action === 'extract' || action === 'goto';
  const withShot = action === 'screenshot' || action === 'goto' || action === 'extract';
  return { ok: true, action, ...(await page({ text: withText, screenshot: withShot })) };
}

/** `POST /v1/browser/close`. */
export async function close() {
  const current = state;
  state = null;
  if (current) {
    await current.cdp.send('Browser.close').catch(() => undefined);
    current.cdp.close();
    try {
      current.child.kill('SIGKILL');
    } catch {
      // gone
    }
  }
  return { ok: true };
}
