/**
 * Minimal Chrome DevTools Protocol driver for testing the DSH Web GUI.
 *
 * - mints the same signed browser-session cookie the Harness issues
 *   (secret read from $DSH_HOME/.credentials.yaml, never logged)
 * - launches nothing itself: attach to an already-running Chrome with
 *   --remote-debugging-port=9333
 * - exposes eval / click / type / key / screenshot / console capture helpers
 *
 * Usage (see tools/ui.mjs for the CLI):
 *   const ui = await openApp();  // navigate + wait for the shell
 */

import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';

const DEBUG_PORT = Number(process.env.DSH_CDP_PORT || 9333);
const APP_URL = process.env.DSH_WEB_URL || 'http://127.0.0.1:54898';

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

async function readBrowserSecret() {
  const text = await readFile(join(dshHome(), '.credentials.yaml'), 'utf8');
  const match = /client-connection\/browser-session:\s*\n\s*kind:\s*grant\s*\n\s*payload:\s*\n\s*version:\s*1\s*\n\s*secret:\s*([A-Za-z0-9_-]+)/.exec(text);
  if (!match) throw new Error('browser-session credential record not found in .credentials.yaml');
  return Buffer.from(match[1], 'base64url');
}

/** Mint the HttpOnly signed cookie the Web carrier accepts for this authority. */
export async function mintCookie(url = APP_URL) {
  const parsed = new URL(url);
  const authority = parsed.host; // http: audience is host:port
  const secret = await readBrowserSecret();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  const name = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
  return { name, value: `v1.${body}.${signature}`, url: `${parsed.origin}/`, authority };
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
        else waiter.resolve(message.result);
        return;
      }
      const handlers = this.listeners.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params);
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function fetchJson(path) {
  const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}${path}`);
  if (!response.ok) throw new Error(`CDP endpoint ${path} → HTTP ${response.status}`);
  return response.json();
}

async function connectPage() {
  const targets = await fetchJson('/json/list');
  const page = targets.find((target) => target.type === 'page');
  if (!page) throw new Error('no Chrome page target; launch Chrome with --remote-debugging-port');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')), { once: true });
  });
  const cdp = new CDP(ws);
  // Headless Chrome can drop the first command while the renderer wakes up;
  // probe until it answers before any real work.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true }, 5000);
      break;
    } catch {
      await sleep(700);
      if (attempt === 7) throw new Error('Chrome page target is not responding; relaunch Chrome');
    }
  }
  return cdp;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class App {
  constructor(cdp) {
    this.cdp = cdp;
    this.console = [];
  }

  async evaluate(expression, options = {}) {
    const result = await this.cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: options.awaitPromise !== false,
      returnByValue: options.returnByValue !== false,
      userGesture: options.userGesture === true,
    });
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed';
      throw new Error(text);
    }
    return result.result?.value;
  }

  async click(expression) {
    return this.evaluate(`(() => { const el = ${expression}; if (!el) return false; el.click(); return true; })()`);
  }

  /** Click the first visible element whose text/aria-label/title matches. */
  async clickText(text, selector = 'button,a,[role="button"],li,span,div') {
    const encoded = JSON.stringify(text);
    const sel = JSON.stringify(selector);
    return this.evaluate(`(() => {
      const wanted = ${encoded}.toLowerCase();
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nodes = [...document.querySelectorAll(${sel})].filter(visible);
      const match = nodes.find((el) => {
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().toLowerCase();
        return label === wanted || label.includes(wanted);
      });
      if (!match) return false;
      match.click();
      return true;
    })()`, { userGesture: true });
  }

  async type(selectorExpr, value) {
    const encoded = JSON.stringify(value);
    return this.evaluate(`(() => {
      const el = ${selectorExpr};
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${encoded});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.focus();
      return true;
    })()`, { userGesture: true });
  }

  async key(key, modifiers = 0) {
    const code = { Enter: 13, Escape: 27, Tab: 9 }[key] ?? key.charCodeAt(0);
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers });
  }

  async mouse(type, x, y, button = 'left', clickCount = 1) {
    await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: type === 'mouseReleased' || type === 'mouseMoved' ? (type === 'mouseMoved' ? 0 : 0) : button === 'left' ? 1 : 0 });
  }

  /** Real pointer drag from one point to another using CDP input events. */
  async drag(from, to, steps = 10) {
    await this.mouse('mouseMoved', from.x, from.y);
    await this.mouse('mousePressed', from.x, from.y);
    for (let index = 1; index <= steps; index += 1) {
      const x = from.x + ((to.x - from.x) * index) / steps;
      const y = from.y + ((to.y - from.y) * index) / steps;
      await this.mouse('mouseMoved', x, y, 'left');
      await sleep(16);
    }
    await this.mouse('mouseReleased', to.x, to.y);
  }

  async rect(expression) {
    return this.evaluate(`(() => {
      const el = ${expression};
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top), left: Math.round(r.left) };
    })()`);
  }

  async screenshot(path) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path, Buffer.from(data, 'base64'));
    return path;
  }

  async waitFor(expression, timeoutMs = 15000, label = expression) {
    const started = Date.now();
    let lastError;
    while (Date.now() - started < timeoutMs) {
      try {
        const value = await this.evaluate(`(() => { try { return !!(${expression}); } catch (error) { return false; } })()`);
        if (value) return true;
      } catch (error) {
        lastError = error;
      }
      await sleep(200);
    }
    throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
  }

  async ensureApp({ reload = false } = {}) {
    const cookie = await mintCookie();
    await this.cdp.send('Page.enable');
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Log.enable');
    this.cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error' || params.type === 'warning') {
        const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
        this.console.push({ type: params.type, text });
      }
    });
    this.cdp.on('Runtime.exceptionThrown', (params) => {
      this.console.push({ type: 'exception', text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception' });
    });
    const alreadyLoaded = await this.evaluate(
      `(() => !!document.body && document.body.innerText.includes('New Session') && !document.body.innerText.includes('authentication required'))()`,
    ).catch(() => false);
    if (!reload && alreadyLoaded) {
      await this.evaluate(`(() => {
        if (window.__dshUiErrors) return true;
        window.__dshUiErrors = [];
        window.addEventListener('error', (e) => window.__dshUiErrors.push(String(e.message || e.error || 'error')));
        window.addEventListener('unhandledrejection', (e) => window.__dshUiErrors.push(String((e.reason && e.reason.message) || e.reason || 'rejection')));
        const original = console.error;
        console.error = (...args) => { window.__dshUiErrors.push(args.map(String).join(' ')); original.apply(console, args); };
        return true;
      })()`);
      return cookie;
    }
    // Exchange the signed cookie on the app origin, then reload through the shell.
    // Setting it via document.cookie avoids the flaky Network.setCookie path and
    // behaves identically for the server's verifier.
    await this.cdp.send('Page.navigate', { url: APP_URL + '/' });
    await sleep(500);
    await this.evaluate(
      `(() => { document.cookie = ${JSON.stringify(cookie.name)} + '=' + ${JSON.stringify(cookie.value)} + '; path=/; SameSite=Strict'; return document.cookie.length > 0; })()`,
    ).catch(() => false);
    await this.cdp.send('Page.reload', { ignoreCache: reload });
    await sleep(600);
    await this.waitFor(`document.readyState === 'complete'`, 20000, 'page load');
    await this.waitFor(
      `document.body && document.body.innerText.length > 50 && !document.body.innerText.includes('authentication required')`,
      30000,
      'app shell',
    );
    // Persistent error surface for later steps.
    await this.evaluate(`(() => {
      if (window.__dshUiErrors) return true;
      window.__dshUiErrors = [];
      window.addEventListener('error', (e) => window.__dshUiErrors.push(String(e.message || e.error || 'error')));
      window.addEventListener('unhandledrejection', (e) => window.__dshUiErrors.push(String((e.reason && e.reason.message) || e.reason || 'rejection')));
      const original = console.error;
      console.error = (...args) => { window.__dshUiErrors.push(args.map(String).join(' ')); original.apply(console, args); };
      return true;
    })()`);
    await sleep(1200);
    return cookie;
  }

  async errors() {
    const pageErrors = await this.evaluate('window.__dshUiErrors || []');
    return [...this.console, ...pageErrors.map((text) => ({ type: 'error', text }))];
  }
}

export async function attach() {
  const cdp = await connectPage();
  return new App(cdp);
}

export { APP_URL };
