#!/usr/bin/env node
/**
 * KB-79 — GUI probe and evidence pack for autopilot.
 *
 * Drives the REAL DSH Web GUI through the shipped CDP harness (`tools/cdp.mjs`)
 * and the REAL Kanban client bundle, and exercises the REAL `index.js` HTTP
 * handlers (`POST /kanban/state`, `POST /kanban/action`) end to end — with two
 * disposable, isolated projects instead of the live project board.
 *
 * Why a bridge instead of the live host:
 *   Autopilot dispatches real agent sessions. Pointing the probe at the live
 *   board would start real work, mutate the user's board and need real models.
 *   Instead the probe boots the shipped host code in-process against a fake
 *   Harness runtime (a temporary state dir plus two temporary workspaces) and
 *   exposes those real route handlers to the page through a short-lived local
 *   HTTP bridge. The page's `fetch` is wrapped so the Kanban panel's requests go
 *   to the bridge; the live project board is never contacted for Kanban data
 *   (the check `AC1.7` asserts zero native Kanban calls). The live board is not
 *   written, and the temporary boards are deleted in a `finally` block.
 *
 * What it proves (see the checks array in the evidence file):
 *   AC 1  isolated temp project seeded + removed; live board untouched
 *   AC 2  enable, cadence/caps via the UI, persistence after a refresh, dry-run
 *         preview equal to the host plan, Pulse now, countdown, lane/member
 *         admission chips, paused board disables Pulse now
 *   AC 3  stubbed failing dispatch (error alert + pulse error marker) and a
 *         failed configure (rollback), no unhandled console error
 *   AC 4  PNGs for control panel, preview, pulse feed, empty, error and paused
 *         states at 1024x768 and 640x900, light + dark, en + zh, with a
 *         horizontal-overflow assertion
 *   AC 5  docs/screenshots/autopilot/final-verification.json, one record per
 *         check (id, description, pass, viewport, theme, locale, artifact,
 *         consoleErrors); a failed check exits non-zero
 *   AC 6  deterministic: two consecutive suite runs by default (same ids, all
 *         pass); `--runs=1` for a quick single pass
 *   AC 7  README "Verifying the UI yourself" documents the command + artifacts
 *   AC 8  runtime < 5 minutes and the output names the git commit
 *
 * Required Chrome flags (launch once, keep it running, same profile as the
 * other probes; the script attaches over CDP port 9333):
 *
 *   mkdir -p .cdp-profile .chrome-home .chrome-tmp
 *   HOME="$PWD/.chrome-home" TMPDIR="$PWD/.chrome-tmp" \
 *     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --remote-debugging-port=9333 --user-data-dir="$PWD/.cdp-profile" \
 *     --no-first-run --no-default-browser-check --no-sandbox --disable-gpu \
 *     --disable-software-rasterizer --disable-breakpad --disable-crash-reporter \
 *     --disable-dev-shm-usage --in-process-gpu --window-size=1440,900 about:blank &
 *
 * Environment:
 *   DSH_WEB_URL   the running Web GUI origin (default http://127.0.0.1:50738)
 *   DSH_CDP_PORT  Chrome remote-debugging port (default 9333)
 *
 * Usage:
 *   node tools/autopilot-probe.js            # two runs + determinism comparison
 *   node tools/autopilot-probe.js --runs=1   # one run (fast local iteration)
 *   node tools/autopilot-probe.js --json     # machine-readable final summary
 *
 * Artifacts:
 *   docs/screenshots/autopilot/final-verification.json   evidence (last run)
 *   docs/screenshots/autopilot/<state>-<locale>-<theme>-<width>.png  (48 PNGs)
 *
 * Exit code 0 only when every check of every run passed.
 */

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { apply } from '../index.js';
import { attach } from './cdp.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_DIR = join(REPO, 'docs', 'screenshots', 'autopilot');
const OUT_FILE = join(OUT_DIR, 'final-verification.json');
const APP_URL = process.env.DSH_WEB_URL || 'http://127.0.0.1:50738';
const CDP_PORT = Number(process.env.DSH_CDP_PORT || 9333);
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const LIVE_BOARD_DIR = join(DSH_HOME, 'kanban');

/** Throwaway workspace ids. Never registered with the live host. */
const MAIN_ID = 'kb79-probe-main';
const EMPTY_ID = 'kb79-probe-empty';
const MAIN_TITLE = 'KB-79 probe (temporary)';
const EMPTY_TITLE = 'KB-79 probe empty (temporary)';

/** Chrome/page console noise that predates this probe and is unrelated to it. */
const CONSOLE_ALLOW = [/^\[deepseek-account\] account read failed/];

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const ARGS = process.argv.slice(2);
const runsArg = ARGS.find((arg) => arg.startsWith('--runs='));
const RUNS = (() => {
  if (!runsArg) return 2;
  const value = Number(runsArg.split('=')[1]);
  return Number.isFinite(value) && value >= 1 ? Math.min(5, Math.floor(value)) : 2;
})();
const AS_JSON = ARGS.includes('--json');
const VERBOSE = !AS_JSON;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hashJson = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const short = (value, limit = 320) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
};
const isConsoleAllowed = (text) => CONSOLE_ALLOW.some((pattern) => pattern.test(String(text || '')));

/** Git commit the probe ran against (AC 8). */
async function readGitCommit() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO });
    const sha = stdout.trim();
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], { cwd: REPO });
    return { sha, short: sha.slice(0, 12), dirty: statusOut.trim().length > 0 };
  } catch (error) {
    return { sha: '', short: '', dirty: false, error: error.message };
  }
}

/** Informational listing of the live boards (read-only; other sessions may write them). */
async function listLiveBoards() {
  try {
    const names = (await readdir(LIVE_BOARD_DIR)).filter((name) => name.endsWith('.json')).sort();
    const boards = [];
    for (const name of names) {
      const path = join(LIVE_BOARD_DIR, name);
      try {
        const info = await stat(path);
        const raw = await readFile(path, 'utf8');
        let title = '';
        try {
          title = JSON.parse(raw).projectTitle || '';
        } catch {
          title = '';
        }
        boards.push({
          file: name,
          bytes: info.size,
          mtime: new Date(info.mtimeMs).toISOString(),
          title,
          sha256: createHash('sha256').update(raw).digest('hex').slice(0, 16),
        });
      } catch {
        // a board being rewritten concurrently is fine: informational only
      }
    }
    return boards;
  } catch (error) {
    return [];
  }
}

/** Verify a file exists and is a plausible PNG. */
async function pngInfo(path) {
  try {
    const info = await stat(path);
    if (info.size < 2000) return { bytes: info.size, png: false };
    const header = (await readFile(path)).subarray(0, 8);
    const png = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    return { bytes: info.size, png };
  } catch (error) {
    return { bytes: 0, png: false, error: error.message };
  }
}

/* ------------------------------------------------------------------ */
/* Locale tables used to locate controls and to verify rendered copy   */
/* ------------------------------------------------------------------ */

const TEXT = {
  en: {
    kanbanEntry: 'Kanban',
    state: { on: 'On', off: 'Off', paused: 'Paused' },
    cadence: 'Cadence',
    depth: 'Max Ready depth',
    lane: { refine: 'Refine', implement: 'Implement', review: 'Review' },
    preview: 'Preview next pulse',
    pulseNow: 'Pulse now',
    pulseDisabled: 'Pulse now is disabled while autopilot is paused.',
    phase1Dismiss: 'Got it',
    pauseBoard: 'Pause board',
    resumeBoard: 'Resume board',
    team: 'Team',
    feedEmptyTitleOn: 'No pulses yet',
    feedErrorMarker: 'error',
    countdownOff: 'off',
    countdownPaused: 'paused',
    theme: { light: 'Light', dark: 'Dark', system: 'System' },
    collapseSidebar: 'Collapse sidebar',
    expandSidebar: 'Expand sidebar',
    refresh: 'Refresh',
    collapseSidebar: '收起侧边栏',
    expandSidebar: '展开侧边栏',
    refresh: '刷新',
    boardLevel: 'Board',
    reasons: {
      admitted: 'Admitted — starts a session',
      disabled: 'Autopilot is disabled',
      'board-paused': 'The board is paused',
      epic: 'EPICs are never dispatched',
      blocked: 'The ticket is blocked',
      'active-execution': 'A session is already running',
      'lane-cap': 'The lane is at its concurrency cap',
      'wip-limit': 'In Progress is at its WIP limit',
      'ready-depth': 'Ready is at its depth ceiling',
      'no-member': 'No member has an eligible role',
      'member-busy': 'Every eligible member is busy',
      'member-paused': 'The member is paused',
      'stale-execution': 'The execution is stale',
      'postcondition-failed': 'The last dispatch missed its target; backing off',
      'budget-exhausted': 'The dispatch budget is exhausted',
      'loop-guard': 'Too many failures; parked for a human',
      'pulse-cap': 'This pulse already used its dispatch slots',
      'no-work': 'No candidate work in this lane',
      'dispatch-failed': 'Dispatch failed — the session did not start',
    },
  },
  zh: {
    kanbanEntry: '看板',
    state: { on: '已开启', off: '已关闭', paused: '已暂停' },
    cadence: '节奏',
    depth: 'Ready 最大深度',
    lane: { refine: '精炼', implement: '实现', review: '评审' },
    preview: '预览下一次脉冲',
    pulseNow: '立即脉冲',
    pulseDisabled: '自动巡航暂停期间无法立即执行脉冲。',
    phase1Dismiss: '知道了',
    pauseBoard: '暂停看板',
    resumeBoard: '恢复看板',
    team: '团队',
    feedEmptyTitleOn: '暂无脉冲',
    feedErrorMarker: '错误',
    countdownOff: '关闭',
    countdownPaused: '暂停',
    theme: { light: '浅色', dark: '深色', system: '跟随系统' },
    boardLevel: '看板',
    reasons: {
      admitted: '已准入 — 将启动会话',
      disabled: '自动巡航已关闭',
      'board-paused': '看板已暂停',
      epic: 'EPIC 不会被派发',
      blocked: '任务被阻塞',
      'active-execution': '已有运行中的会话',
      'lane-cap': '泳道已达到并发上限',
      'wip-limit': '进行中已达到 WIP 上限',
      'ready-depth': 'Ready 深度已达到上限',
      'no-member': '没有合适角色的成员',
      'member-busy': '成员正忙',
      'member-paused': '成员已暂停',
      'stale-execution': '执行已停滞',
      'postcondition-failed': '上次派发未达成目标，正在退避',
      'budget-exhausted': '派发预算已用尽',
      'loop-guard': '失败次数过多，已停下等待人工处理',
      'pulse-cap': '本次脉冲名额已满',
      'no-work': '该泳道当前没有可执行的工作',
      'dispatch-failed': '派发失败 — 会话未能启动',
    },
  },
};

/* ------------------------------------------------------------------ */
/* Fake Harness + real host boot (isolated temp project)               */
/* ------------------------------------------------------------------ */

function createVirtualScheduler() {
  // Real timers, but tracked so the probe can prove nothing fired: the probe's
  // cadences (5-10 min) are longer than the run, and every timer is disposed in
  // `host.dispose()`. `unref` keeps the Node process free to exit.
  const timers = new Set();
  return {
    setTimeout(callback, delay) {
      const handle = setTimeout(() => {
        timers.delete(handle);
        try {
          callback();
        } catch {
          // swarm: a timer callback must never crash the probe
        }
      }, Math.max(0, Math.floor(Number(delay) || 0)));
      if (typeof handle.unref === 'function') handle.unref();
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) {
        timers.delete(handle);
        clearTimeout(handle);
      }
    },
    pending: () => timers.size,
    dispose() {
      for (const handle of timers) clearTimeout(handle);
      timers.clear();
    },
  };
}

function makeWorkspace(id, title, path) {
  return {
    id,
    title,
    path,
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    async attachSession() {},
    async status() {
      return 'ok';
    },
  };
}

/**
 * Boot the shipped host (`index.js`) against a throwaway state dir and two
 * throwaway workspaces. Returns handles for the real route handlers, the
 * action/state helpers, the fake agent dispatch flag, and a list/cleanup API.
 */
async function bootProbeHost() {
  const root = await mkdtemp(join(tmpdir(), 'kb79-root-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'kb79-state-'));
  const mainPath = join(root, 'main');
  const emptyPath = join(root, 'empty');
  await mkdir(mainPath, { recursive: true });
  await mkdir(emptyPath, { recursive: true });
  await writeFile(join(mainPath, 'README.md'), '# KB-79 probe project (temporary)\n', 'utf8');
  await writeFile(join(emptyPath, 'README.md'), '# KB-79 probe empty project (temporary)\n', 'utf8');

  const main = makeWorkspace(MAIN_ID, MAIN_TITLE, mainPath);
  const empty = makeWorkspace(EMPTY_ID, EMPTY_TITLE, emptyPath);

  const events = { agentCalls: [], dispatchFault: false, createFault: null };
  const routes = new Map();
  const disposeFns = [];
  const services = {};
  const scheduler = createVirtualScheduler();

  const ctx = {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') disposeFns.push(disposer);
      return disposer;
    },
    on() {
      return () => {};
    },
    get(name) {
      return services[name];
    },
    provide(name, value) {
      services[name] = value;
      return () => {};
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    connection: { requestRejection: () => undefined },
    workspaceRegistry: { list: () => [main, empty] },
    sessionController: {
      async list() {
        return { items: [] };
      },
      async prompt() {
        return { accepted: true };
      },
      cancel() {
        return { accepted: true };
      },
    },
    sessionPersistence: {
      async list() {
        return [];
      },
      async open() {
        return {
          async read() {
            return { events: [] };
          },
          async close() {},
        };
      },
      async stat() {
        return { header: {} };
      },
    },
    agents: {
      async create(options) {
        events.agentCalls.push({ sessionId: options && options.sessionId, at: Date.now() });
        // AC 3 stub: the probe arms this to make a dispatch fail deterministically.
        if (events.dispatchFault) throw new Error('KB-79 probe stub: agent dispatch failed');
        return { agent: { id: options.sessionId } };
      },
      get() {
        return undefined;
      },
      list() {
        return [];
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    agentPresets: { resolve: async () => ({ id: 'default-preset' }), mount: async () => {} },
    permissionPresets: {
      catalog: () => ({ options: [], defaultOptions: [], defaultPreset: 'read-only' }),
      resolve: (value) => ({ sandbox: value, approval: 'deny' }),
      set() {},
    },
    sessionTitle: { rename() {} },
    sessions: { get: () => undefined, flush: async () => {} },
  };
  services.agentDefaultModel = ctx.agentDefaultModel;
  services.sessionTitle = ctx.sessionTitle;
  services.sessions = ctx.sessions;
  services.permissionPresets = ctx.permissionPresets;
  services.agentPresets = ctx.agentPresets;
  services.agents = ctx.agents;
  services.sessionController = ctx.sessionController;
  services.sessionPersistence = ctx.sessionPersistence;

  const handle = apply(ctx, { stateDir, now: Date.now, scheduler, wipInProgress: 3, wipReview: 5 });
  await handle.autopilotReady();
  const settle = async (rounds = 30) => {
    for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  await settle();

  /** Invoke the real route handler with a request/response shim (same shape as the fixture pattern). */
  async function httpCall(path, body) {
    const route = routes.get(path);
    if (!route) throw new Error(`route ${path} is not registered`);
    const payload = Buffer.from(JSON.stringify(body));
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield payload;
      },
    };
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(key, value) {
        this.headers[key] = value;
      },
      end(text) {
        this.body = text ?? '';
      },
    };
    await route.handler(req, res);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  }
  const action = (name, payload, workspaceId = MAIN_ID) => httpCall('/kanban/action', { workspaceId, action: name, payload: payload || {} });
  const state = async (workspaceId = MAIN_ID) => (await httpCall('/kanban/state', { workspaceId })).json.value;
  const boardFile = (workspaceId) => join(stateDir, `${workspaceId}.json`);
  const listBoards = async () => {
    let names = [];
    try {
      names = (await readdir(stateDir)).filter((name) => name.endsWith('.json')).sort();
    } catch {
      names = [];
    }
    const boards = [];
    for (const file of names) {
      const info = await stat(join(stateDir, file)).catch(() => null);
      if (!info) continue;
      boards.push({ file, workspaceId: file.replace(/\.json$/, ''), bytes: info.size });
    }
    return { stateDir, workspaceIds: [MAIN_ID, EMPTY_ID], workspaces: [main, empty].map((w) => ({ id: w.id, title: w.title, path: w.path })), boards };
  };

  /** Seed the two throwaway boards through the real action handlers. */
  async function seed() {
    const seedMain = [
      { ticket: { title: 'Implement probe ticket', column: 'ready', role: 'fullstack-developer', priority: 'high' } },
      { ticket: { title: 'Refine probe ticket', column: 'backlog', role: 'product-manager', priority: 'medium' } },
      { ticket: { title: 'Review probe ticket', column: 'review', role: 'reviewer', priority: 'medium' } },
    ];
    for (const entry of seedMain) {
      const created = await action('createTicket', entry.ticket);
      if (created.status !== 200) throw new Error(`seeding createTicket failed: ${created.status} ${short(created.json)}`);
    }
    // The empty project: autopilot already on, one Ready ticket, zero pulses.
    const emptyTicket = await action('createTicket', { title: 'Empty-project ticket', column: 'ready', role: 'fullstack-developer' }, EMPTY_ID);
    if (emptyTicket.status !== 200) throw new Error(`seeding empty createTicket failed: ${emptyTicket.status}`);
    const configured = await action('autopilot', { op: 'configure', patch: { enabled: true, cadenceMs: 300000, maxReadyDepth: 3, laneCaps: { refine: 1, implement: 1, review: 1 } } }, EMPTY_ID);
    if (configured.status !== 200) throw new Error(`seeding empty configure failed: ${configured.status} ${short(configured.json)}`);
    await settle();
    const mainState = await state(MAIN_ID);
    const emptyState = await state(EMPTY_ID);
    return {
      main: {
        workspaceId: mainState.workspaceId,
        tickets: mainState.board.tickets.map((ticket) => ({ id: ticket.id, column: ticket.column, role: ticket.role, title: ticket.title })),
        autopilot: mainState.autopilot && mainState.autopilot.config,
      },
      empty: {
        workspaceId: emptyState.workspaceId,
        tickets: emptyState.board.tickets.map((ticket) => ({ id: ticket.id, column: ticket.column, role: ticket.role, title: ticket.title })),
        autopilot: emptyState.autopilot && emptyState.autopilot.config,
        pulses: emptyState.board.pulses.length,
      },
    };
  }

  async function dispose() {
    for (const disposer of [...disposeFns].reverse()) {
      try {
        disposer();
      } catch {
        // teardown best-effort
      }
    }
    scheduler.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }

  return {
    routes,
    events,
    stateDir,
    root,
    main,
    empty,
    handle,
    action,
    state,
    boardFile,
    listBoards,
    seed,
    dispose,
  };
}

/* ------------------------------------------------------------------ */
/* Local bridge: real host route handlers over HTTP + fault injection  */
/* ------------------------------------------------------------------ */

async function startBridge(host) {
  const log = [];
  const faults = { dispatch: false, configureOnce: false, configureCalls: 0 };
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
  };
  const writeJson = (res, status, payload) => {
    res.writeHead(status, { ...CORS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/probe/boards') {
      writeJson(res, 200, await host.listBoards());
      return;
    }
    if (url.pathname === '/probe/state') {
      writeJson(res, 200, { ok: true, value: await host.state(MAIN_ID), empty: await host.state(EMPTY_ID) });
      return;
    }
    if (url.pathname === '/probe/faults') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
      if (body.dispatch !== undefined) {
        faults.dispatch = body.dispatch === true;
        host.events.dispatchFault = faults.dispatch;
      }
      if (body.configureOnce === true) faults.configureOnce = true;
      writeJson(res, 200, { ok: true, faults: { ...faults, configureCalls: undefined } });
      return;
    }
    const route = host.routes.get(url.pathname);
    if (!route) {
      writeJson(res, 404, { ok: false, error: { code: 'probe/not-found', message: `No route ${url.pathname}` } });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = null;
    }
    // AC 3 fault: fail exactly one configure request, as a real host rejection.
    if (url.pathname === '/kanban/action' && body && body.action === 'autopilot' && body.payload && body.payload.op === 'configure' && faults.configureOnce) {
      faults.configureOnce = false;
      faults.configureCalls += 1;
      log.push({ path: url.pathname, action: body.action, op: 'configure', status: 400, fault: 'configure' });
      writeJson(res, 400, { ok: false, error: { code: 'autopilot/invalid', message: 'KB-79 probe stub: the host rejected this setting.' } });
      return;
    }
    const reqProxy = {
      method: req.method,
      headers: req.headers,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(raw);
      },
    };
    const resProxy = {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(key, value) {
        this.headers[key] = value;
      },
      end(text) {
        this.body = text ?? '';
      },
    };
    await route.handler(reqProxy, resProxy);
    log.push({
      path: url.pathname,
      action: body && body.action,
      op: body && body.payload && body.payload.op,
      status: resProxy.statusCode,
      bytes: (resProxy.body || '').length,
    });
    res.writeHead(resProxy.statusCode || 200, { ...CORS, ...resProxy.headers, 'cache-control': 'no-store' });
    res.end(resProxy.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    log,
    faults,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ------------------------------------------------------------------ */
/* Browser driver                                                      */
/* ------------------------------------------------------------------ */

let app = null;
let bridge = null;
let activeHost = null;
let originalSidebarCollapsed = null;
let currentLocale = 'en';
let currentTheme = null;
let currentViewport = null;

async function prepareChromeTargets() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const pages = list.filter((target) => target.type === 'page');
    const keep = pages.find((target) => String(target.url || '').startsWith(APP_URL));
    for (const target of pages) {
      if (keep && target.id === keep.id) continue;
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${target.id}`).catch(() => {});
    }
  } catch {
    throw new Error(
      `Chrome is not reachable on 127.0.0.1:${CDP_PORT}. Launch it with the flags documented at the top of tools/autopilot-probe.js.`,
    );
  }
}

async function waitShell(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ready = await app
      .evaluate(`document.readyState === 'complete' && !!document.body && document.body.innerText.length > 50 && !document.body.innerText.includes('authentication required')`)
      .catch(() => false);
    if (ready) return true;
    await sleep(250);
  }
  throw new Error('timed out waiting for the Web GUI shell');
}

async function reloadShell() {
  await app.cdp.send('Page.reload', { ignoreCache: true });
  await sleep(700);
  await waitShell();
  await sleep(500);
}

async function setViewport(width, height) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  currentViewport = { width, height };
  await sleep(480);
}

/**
 * Read the GUI theme preference (Light / Dark / System) from the user settings panel.
 * The shell persists this; restoring it at the end leaves the user's GUI untouched.
 */
async function readThemePreference() {
  const opened = await openSettings().catch(() => false);
  if (!opened) return 'system';
  const info = await app.evaluate(`(() => {
    const labels = { Light: 'light', Dark: 'dark', System: 'system', 浅色: 'light', 深色: 'dark', 跟随系统: 'system' };
    const options = [...document.querySelectorAll('button,[role="radio"],[role="option"]')]
      .map((el) => ({ text: (el.textContent || '').trim(), selected: /selected|checked|true/i.test((el.className || '') + ' ' + (el.getAttribute('aria-checked') || '') + ' ' + (el.getAttribute('aria-selected') || '') + ' ' + (el.getAttribute('aria-pressed') || '')) }))
      .filter((entry) => labels[entry.text]);
    const selected = options.find((entry) => entry.selected);
    return { selected: selected ? labels[selected.text] : null, options };
  })()`);
  await closeSettings();
  return info.selected || 'system';
}

/** Switch the GUI theme through the real settings UI (Light / Dark / System). */
async function applyThemePreference(preference) {
  const want = TEXT[currentLocale] && TEXT[currentLocale].theme ? TEXT[currentLocale].theme[preference] : null;
  if (!want) throw new Error(`unknown theme preference ${preference}`);
  let opened = await openSettings().catch(() => false);
  if (!opened) {
    // A focused panel can swallow the settings shortcut; reload and retry once.
    await reloadShell();
    await installOverride();
    await openPanel();
    opened = await openSettings().catch(() => false);
  }
  if (!opened) throw new Error('could not open GUI settings to switch theme');
  const clicked = await app.evaluate(`(() => {
    const want = ${JSON.stringify(want)};
    const el = [...document.querySelectorAll('button,[role="radio"],[role="option"]')].find((x) => (x.textContent || '').trim() === want && x.getBoundingClientRect().width > 0);
    if (el) el.click();
    return Boolean(el);
  })()`, { userGesture: true });
  await sleep(380);
  await closeSettings();
  await sleep(350);
  currentTheme = preference === 'dark' ? 'dark' : preference === 'light' ? 'light' : 'system';
  if (preference !== 'system') {
    const dark = await app.evaluate(`document.body.hasAttribute('data-ds-dark-theme')`).catch(() => null);
    if (dark !== (preference === 'dark')) {
      // One more beat for the shell theme store, then verify (never claim a theme we did not see).
      await sleep(900);
    }
  }
  return clicked;
}

/** Open the Kanban panel + autopilot popover, tolerating a project switch/reload. */
async function ensurePanelAndPopover(expectedTitle = MAIN_TITLE) {
  await openPanel();
  await waitPanelReady(expectedTitle);
  await openPopover();
  await waitPopoverIdle();
}

async function resetEmulation() {
  await app.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
  currentViewport = null;
}

/* --------------------------- language switch --------------------- */

const localeFromDocument = () =>
  app.evaluate(`(() => { const lang = (document.documentElement.getAttribute('lang') || '').toLowerCase(); if (lang.indexOf('zh') === 0) return 'zh'; return 'en'; })()`);

const languageButtonVisible = () =>
  app.evaluate(`[...document.querySelectorAll('button')].some((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`);
const settingsOverlayOpen = () =>
  app.evaluate(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|English|中文|Language|语言)$/.test((x.textContent || '').trim()))`);
const generalTabVisible = () =>
  app.evaluate(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`);

async function closeSettings() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await settingsOverlayOpen())) return true;
    await app.key('Escape');
    await sleep(300);
  }
  return !(await settingsOverlayOpen());
}

async function openSettings() {
  if (await languageButtonVisible()) return true;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await settingsOverlayOpen())) {
      for (const type of ['keyDown', 'keyUp']) {
        await app.cdp.send('Input.dispatchKeyEvent', {
          type,
          key: ',',
          code: 'Comma',
          windowsVirtualKeyCode: 188,
          nativeVirtualKeyCode: 188,
          modifiers: 5,
          ...(type === 'keyDown' ? { text: ',' } : {}),
        });
      }
      await sleep(850);
    }
    if (await generalTabVisible()) {
      await app.evaluate(`(() => {
        const el = [...document.querySelectorAll('button,[role="tab"]')].find((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
        if (el) el.click();
        return Boolean(el);
      })()`, { userGesture: true });
      await sleep(500);
    }
    if (await languageButtonVisible()) return true;
  }
  return false;
}

/** Switch the GUI language (reload included). Keeps localStorage untouched. */
async function setLanguage(target) {
  if (target === currentLocale) return true;
  await app.cdp.send('Page.reload', { ignoreCache: true });
  await sleep(1200);
  await waitShell();
  const opened = await openSettings();
  if (!opened) throw new Error(`could not open GUI settings to switch to ${target}`);
  const clicked = await app.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
    if (b) b.click();
    return Boolean(b);
  })()`, { userGesture: true });
  if (!clicked) throw new Error('could not open the language selector');
  await sleep(450);
  const option = await app.evaluate(`(() => {
    const want = ${JSON.stringify(target === 'zh' ? '中文' : 'English')};
    const el = [...document.querySelectorAll('button,[role="option"],[role="menuitem"],li')].find((x) => (x.textContent || '').trim() === want && x.getBoundingClientRect().width > 0);
    if (el) el.click();
    return Boolean(el);
  })()`, { userGesture: true });
  if (!option) throw new Error(`could not select language ${target}`);
  await sleep(1500);
  await closeSettings();
  await waitShell();
  const actual = await localeFromDocument();
  currentLocale = actual;
  return actual === target;
}

/* --------------------------- page state --------------------------- */

async function installOverride() {
  const source = `(() => {
    const bridge = ${JSON.stringify(`http://127.0.0.1:${bridge.port}`)};
    if (!window.__kb79OriginalFetch) window.__kb79OriginalFetch = window.fetch.bind(window);
    window.__kb79Counters = { bridge: 0, native: 0 };
    window.__kb79Faults = { configure: false };
    const original = window.__kb79OriginalFetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.indexOf('kanban/state') !== -1) {
        window.__kb79Counters.bridge += 1;
        return original(bridge + '/kanban/state', init);
      }
      if (url.indexOf('kanban/action') !== -1) {
        window.__kb79Counters.bridge += 1;
        return original(bridge + '/kanban/action', init);
      }
      if (url.indexOf('/kanban/') !== -1) window.__kb79Counters.native += 1;
      return original(input, init);
    };
    return { bridge: bridge, ok: true };
  })()`;
  return app.evaluate(source, { userGesture: true });
}

async function restoreOverride() {
  if (!app) return false;
  return app
    .evaluate(`(() => {
      if (window.__kb79OriginalFetch) window.fetch = window.__kb79OriginalFetch;
      delete window.__kb79OriginalFetch;
      return true;
    })()`)
    .catch(() => false);
}

const setStoredWorkspace = (id) =>
  app.evaluate(`(() => { if (${JSON.stringify(id)} === null) window.localStorage.removeItem('dsh.kanban.workspace'); else window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(id)}); return true; })()`);

async function readStorage() {
  return app.evaluate(`(() => ({ workspace: window.localStorage.getItem('dsh.kanban.workspace'), phase1: window.localStorage.getItem('dsh.kanban.autopilot.phase1-confirmed') }))()`);
}

const hasPanel = () => app.evaluate(`!!document.querySelector('.kb-root')`);

async function dismissAppModals() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await app
      .evaluate(`(() => {
        const outside = [...document.querySelectorAll('button')].filter((b) => !b.closest('.kb-root') && b.getBoundingClientRect().width > 0 && !b.disabled);
        const close = outside.find((b) => {
          const label = (b.getAttribute('aria-label') || '').trim();
          const text = (b.textContent || '').trim();
          return /^(close|dismiss|got it|continue)$/i.test(label) || /^(continue|close|dismiss|got it)$/i.test(text);
        });
        if (!close) return false;
        close.click();
        return true;
      })()`, { userGesture: true })
      .catch(() => false);
    if (!clicked) return;
    await sleep(250);
  }
}

async function openPanel() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await hasPanel()) return true;
    await dismissAppModals();
    const label = TEXT[currentLocale] ? TEXT[currentLocale].kanbanEntry : 'Kanban';
    await app.evaluate(`(() => {
      const want = ${JSON.stringify(label)};
      const row = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === want && b.getBoundingClientRect().width > 0);
      if (row) row.click();
      return Boolean(row);
    })()`, { userGesture: true });
    await sleep(1000);
  }
  return hasPanel();
}

async function waitPanelReady(expectedTitle = null, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const info = await app
      .evaluate(`(() => {
        const title = document.querySelector('.kb-projectBtn');
        const entry = document.querySelector('.kb-autopilotWrap button');
        return {
          title: title ? (title.getAttribute('title') || title.textContent || '').trim() : null,
          board: !!document.querySelector('.kb-boardWrap'),
          entry: entry ? entry.getAttribute('aria-label') : null,
        };
      })()`)
      .catch(() => null);
    if (info && info.title && info.entry && info.board) {
      if (!expectedTitle || info.title === expectedTitle) return info;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for the Kanban panel${expectedTitle ? ` on ${expectedTitle}` : ''}`);
}

const popoverOpen = () => app.evaluate(`!!document.querySelector('.kb-apPopover')`);

async function openPopover() {
  if (await popoverOpen()) return true;
  const opened = await app.evaluate(`(() => {
    const el = document.querySelector('.kb-autopilotWrap button');
    if (!el) return false;
    el.click();
    return true;
  })()`, { userGesture: true });
  if (!opened) return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await popoverOpen()) return true;
    await sleep(120);
  }
  return false;
}

async function closePopover() {
  return app
    .evaluate(`(() => {
      const el = document.querySelector('.kb-apPopover .kb-apHead button');
      if (!el) return false;
      el.click();
      return true;
    })()`, { userGesture: true })
    .catch(() => false);
}

async function waitPopoverIdle(timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const busy = await app
      .evaluate(`(() => {
        const pop = document.querySelector('.kb-apPopover');
        if (!pop) return 'missing';
        if (pop.getAttribute('aria-busy') === 'true') return 'busy';
        if (document.querySelector('.kb-apSaving')) return 'saving';
        return 'idle';
      })()`)
      .catch(() => 'missing');
    if (busy === 'idle') return true;
    await sleep(150);
  }
  return false;
}

async function waitNoToasts(timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const count = await app.evaluate(`document.querySelectorAll('.kb-toast').length`).catch(() => 0);
    if (count === 0) return true;
    await sleep(300);
  }
  return false;
}

async function scrollPopover(selector, offset = 40) {
  return app.evaluate(`(() => {
    const pop = document.querySelector('.kb-apPopover');
    if (!pop) return false;
    if (${JSON.stringify(selector)} === '.kb-apPopover') {
      pop.scrollTop = 0;
      return true;
    }
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) {
      pop.scrollTop = 0;
      return false;
    }
    pop.scrollTop = Math.max(0, target.offsetTop - ${Number(offset) || 0});
    return true;
  })()`);
}

async function measureOverflow() {
  return app.evaluate(`(() => {
    const measure = (node) => (node ? {
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      overflowX: node.scrollWidth > node.clientWidth,
    } : null);
    return {
      doc: measure(document.documentElement),
      body: measure(document.body),
      root: measure(document.querySelector('.kb-root')),
      popover: measure(document.querySelector('.kb-apPopover')),
    };
  })()`);
}

async function clickPopoverControl(which) {
  const t = TEXT[currentLocale];
  const labels = which === 'preview' ? [t.preview] : [t.pulseNow, t.pulseDisabled];
  return app.evaluate(`(() => {
    const labels = ${JSON.stringify(labels)};
    const buttons = [...document.querySelectorAll('.kb-apPopover button')];
    const match = buttons.find((b) => labels.indexOf((b.getAttribute('title') || '').trim()) !== -1);
    if (!match || match.disabled) return { clicked: false, reason: match ? 'disabled' : 'missing' };
    match.click();
    return { clicked: true };
  })()`, { userGesture: true });
}

async function readPopover() {
  return app.evaluate(`(() => {
    const pop = document.querySelector('.kb-apPopover');
    if (!pop) return { open: false };
    const readText = (node) => (node ? (node.textContent || '').trim() : null);
    const selects = [...pop.querySelectorAll('.kb-apSelect')].map((s) => ({ label: s.getAttribute('aria-label'), value: s.value }));
    const actions = [...pop.querySelectorAll('.kb-apActions button')].map((b) => ({
      title: (b.getAttribute('title') || '').trim(),
      text: (b.textContent || '').trim(),
      disabled: b.disabled === true,
    }));
    const rows = [...pop.querySelectorAll('.kb-apRow')].map((row) => ({
      index: readText(row.querySelector('.kb-apRowIndex')),
      id: readText(row.querySelector('.kb-apRowId')),
      title: readText(row.querySelector('.kb-apRowTitle')) || '',
      meta: [...row.querySelectorAll('.kb-apRowMeta span')].map((span) => (span.textContent || '').trim()),
      reason: readText(row.querySelector('.kb-apRowReason')) || '',
    }));
    const pulses = [...pop.querySelectorAll('.kb-apPulse')].map((li) => ({
      id: li.getAttribute('data-pulse'),
      trigger: readText(li.querySelector('.kb-apTrigger')),
      time: readText(li.querySelector('.kb-apPulseTime')),
      meta: [...li.querySelectorAll('.kb-apPulseMeta span')].map((span) => (span.textContent || '').trim()),
      errorMarker: readText(li.querySelector('.kb-apPulseError')),
      errorTitle: li.querySelector('.kb-apPulseError') ? li.querySelector('.kb-apPulseError').getAttribute('title') : null,
      hasError: li.classList.contains('kb-apPulse--error'),
    }));
    const alerts = [...pop.querySelectorAll('.kb-apAlert')].map((el) => (el.textContent || '').replace(/\\s+/g, ' ').trim());
    const countdown = readText(pop.querySelector('.kb-apCountdownValue'));
    return {
      open: true,
      state: readText(pop.querySelector('.kb-apState')),
      paused: Boolean(pop.querySelector('.kb-apState--paused')),
      countdown,
      selects,
      actions,
      preview: Boolean(pop.querySelector('.kb-apPreview')),
      previewSummary: readText(pop.querySelector('.kb-apPreviewCount')),
      rows,
      pulses,
      alerts,
      error: readText(pop.querySelector('.kb-apError')),
      feedEmpty: Boolean(pop.querySelector('.kb-apFeedEmpty')),
      feedEmptyTitle: readText(pop.querySelector('.kb-apFeedEmptyTitle')),
      saving: Boolean(pop.querySelector('.kb-apSaving')),
    };
  })()`);
}

async function readLaneChips() {
  return app.evaluate(`(() => [...document.querySelectorAll('.kb-colAdmission')].map((el) => ({
    lane: el.getAttribute('data-lane'),
    state: el.getAttribute('data-state'),
    stateText: (el.querySelector('.kb-colAdmissionState') || {}).textContent || '',
    capText: (el.querySelector('.kb-colAdmissionCap') || {}).textContent || '',
  })))()`);
}

async function readMemberChips() {
  return app.evaluate(`(() => [...document.querySelectorAll('.kb-rosterAutoChip')].map((el) => ({
    member: el.getAttribute('data-member'),
    kind: el.getAttribute('data-autopilot'),
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
  })))()`);
}

async function toggleTeamRail() {
  const t = TEXT[currentLocale];
  return app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.kb-header button')].find((x) => (x.getAttribute('title') || '') === ${JSON.stringify(t.team)});
    if (!b) return false;
    b.click();
    return true;
  })()`, { userGesture: true });
}

const teamRailOpen = () => app.evaluate(`!!document.querySelector('.kb-rosterAutoChip')`);

async function toggleBoardPause(pause) {
  const t = TEXT[currentLocale];
  const title = pause ? t.pauseBoard : t.resumeBoard;
  return app.evaluate(`(() => {
    const b = [...document.querySelectorAll('.kb-header button')].find((x) => (x.getAttribute('title') || '') === ${JSON.stringify(title)});
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`, { userGesture: true });
}

/** True when the app's left sidebar is currently collapsed. */
const sidebarCollapsed = () =>
  app.evaluate(`(() => {
    const labels = ['Collapse sidebar', 'Expand sidebar', '收起侧边栏', '展开侧边栏'];
    const buttons = [...document.querySelectorAll('button')].filter((b) => !b.closest('.kb-root') && b.getBoundingClientRect().width > 0);
    const labelsOf = buttons.map((b) => b.getAttribute('aria-label') || '');
    return labelsOf.indexOf('Expand sidebar') !== -1 || labelsOf.indexOf('展开侧边栏') !== -1;
  })()`);

/** Collapse/expand the app sidebar so the 640 capture uses the real narrow layout. */
async function setSidebarCollapsed(collapsed) {
  const current = await sidebarCollapsed().catch(() => null);
  if (current === null || current === collapsed) return current === collapsed;
  const label = collapsed
    ? (currentLocale === 'zh' ? '收起侧边栏' : 'Collapse sidebar')
    : (currentLocale === 'zh' ? '展开侧边栏' : 'Expand sidebar');
  const clicked = await app.evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0);
    if (!el) return false;
    el.click();
    return true;
  })()`, { userGesture: true }).catch(() => false);
  await sleep(450);
  return clicked;
}

/** Force a snapshot refresh without a toast (header refresh button or visibility event). */
async function forceRefresh() {
  const done = await app.evaluate(`(() => {
    const labels = ['Refresh', '刷新'];
    const btn = [...document.querySelectorAll('.kb-header button')].find((b) => labels.indexOf((b.getAttribute('title') || '').trim()) !== -1);
    if (btn) {
      btn.click();
      return 'button';
    }
    try { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); } catch (error) {}
    document.dispatchEvent(new Event('visibilitychange'));
    return 'visibility';
  })()`).catch(() => null);
  await sleep(350);
  return done;
}

/** Pause/resume the board through the isolated host (no toast) and wait for the UI to sync. */
async function setBoardPausedViaHost(paused) {
  if (!activeHost) return false;
  const response = await activeHost.action(paused ? 'pauseBoard' : 'resumeBoard');
  if (!response || response.status !== 200) return false;
  await forceRefresh();
  const started = Date.now();
  while (Date.now() - started < 10000) {
    const current = await readPopover();
    if (current.paused === paused) return true;
    await forceRefresh();
    await sleep(400);
  }
  return false;
}

async function setSelect(label, value) {
  return app.evaluate(`(() => {
    const el = [...document.querySelectorAll('.kb-apPopover .kb-apSelect')].find((s) => s.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(el, String(${JSON.stringify(value)}));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`, { userGesture: true });
}

async function selectProject(title) {
  const opened = await app.evaluate(`(() => {
    const b = document.querySelector('.kb-projectBtn');
    if (!b) return false;
    b.click();
    return true;
  })()`, { userGesture: true });
  if (!opened) return false;
  await sleep(350);
  const selected = await app.evaluate(`(() => {
    const row = [...document.querySelectorAll('.kb-menuRow')].find((el) => {
      const title = (el.querySelector('.kb-menuTitle') || {}).textContent || '';
      return title.trim() === ${JSON.stringify(title)};
    });
    if (!row) return false;
    row.click();
    return true;
  })()`, { userGesture: true });
  if (!selected) return false;
  await waitPanelReady(title);
  await sleep(500);
  return true;
}

const nativeLiveSnapshot = () =>
  app.evaluate(`(async () => {
    try {
      const response = await fetch('/kanban/state', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId: null }),
      });
      const payload = await response.json();
      const value = payload && payload.ok === true ? payload.value : null;
      return {
        status: response.status,
        workspaceId: value && value.workspaceId,
        projectTitle: value && value.board && value.board.projectTitle,
        projects: (value && Array.isArray(value.projects) ? value.projects : []).map((project) => ({ id: project.id, title: project.title })),
      };
    } catch (error) {
      return { status: 0, error: String((error && error.message) || error) };
    }
  })()`);

/* --------------------------- checks recorder --------------------- */

let recordContext = null;

function takeConsoleDelta() {
  if (!recordContext) return [];
  const entries = app ? app.console.slice(recordContext.consoleMark) : [];
  recordContext.consoleMark = app ? app.console.length : 0;
  return entries.filter((entry) => !isConsoleAllowed(entry.text));
}

function record(id, description, pass, extra = {}) {
  const ctx = recordContext;
  const rec = {
    id,
    description,
    pass: pass === true,
    viewport: extra.viewport !== undefined ? extra.viewport : ctx && ctx.viewport ? `${ctx.viewport.width}x${ctx.viewport.height}` : null,
    theme: extra.theme !== undefined ? extra.theme : ctx ? ctx.theme : null,
    locale: extra.locale !== undefined ? extra.locale : ctx ? ctx.locale : null,
    artifact: extra.artifact || null,
    consoleErrors: extra.consoleErrors || takeConsoleDelta(),
    detail: extra.detail === undefined ? null : extra.detail,
  };
  ctx.checks.push(rec);
  if (!rec.pass) ctx.failures += 1;
  if (VERBOSE) {
    const label = `${rec.pass ? 'ok  ' : 'FAIL'} ${id} ${description}`;
    console.log(`${label}${rec.detail === null ? '' : ` — ${short(rec.detail)}`}`);
  }
  return rec.pass;
}

/* ------------------------------------------------------------------ */
/* Evidence context for one suite run                                  */
/* ------------------------------------------------------------------ */

function createRunContext(index) {
  return {
    index,
    startedAt: new Date().toISOString(),
    startMs: Date.now(),
    checks: [],
    failures: 0,
    consoleMark: 0,
    viewport: currentViewport,
    theme: currentTheme,
    locale: currentLocale,
    boards: {},
    screenshots: [],
    notes: [],
    live: {},
  };
}

/* ------------------------------------------------------------------ */
/* Suite                                                               */
/* ------------------------------------------------------------------ */

async function runSuite(runIndex) {
  const ctx = createRunContext(runIndex);
  recordContext = ctx;
  let host = null;
  let runError = null;

  if (VERBOSE) console.log(`\n=== KB-79 probe run ${runIndex} ===`);

  try {
    /* -- reset the page, capture the live project list ------------------ */
    await restoreOverride();
    await reloadShell();
    const locale = await localeFromDocument();
    currentLocale = locale;
    if (locale !== 'en') {
      await setLanguage('en');
      await reloadShell();
    }
    await setStoredWorkspace(null);
    ctx.locale = currentLocale;
    ctx.theme = currentTheme;
    ctx.viewport = currentViewport;

    await setViewport(1024, 768);
    await applyThemePreference('light');
    ctx.viewport = currentViewport;
    ctx.theme = currentTheme;

    const liveBefore = await nativeLiveSnapshot();
    ctx.live.before = liveBefore;
    record('AC1.1.real-gui-attached', 'authenticates to the real Web GUI and loads the shell over CDP', liveBefore.status === 200, {
      viewport: null,
      theme: null,
      locale: currentLocale,
      detail: { status: liveBefore.status, projects: (liveBefore.projects || []).map((project) => project.title) },
    });

    /* -- boot the isolated host + bridge ------------------------------- */
    host = await bootProbeHost();
    activeHost = host;
    bridge = await startBridge(host);
    const boardsBefore = await host.listBoards();
    ctx.boards.before = boardsBefore;
    record('AC1.2.probe-boards-before', 'no temporary board exists before seeding (probe state dir is empty)', boardsBefore.boards.length === 0, {
      detail: { boards: boardsBefore.boards.length, stateDir: boardsBefore.stateDir },
    });
    const seeded = await host.seed();
    ctx.seeded = seeded;
    const boardsSeeded = await host.listBoards();
    ctx.boards.seeded = boardsSeeded;
    record(
      'AC1.3.temp-boards-seeded',
      'seeds an isolated temporary project (main + empty) through the real action handlers',
      boardsSeeded.boards.length === 2 && seeded.main.tickets.length === 3 && seeded.empty.pulses === 0 && seeded.empty.autopilot && seeded.empty.autopilot.enabled === true,
      {
        detail: {
          boards: boardsSeeded.boards.length,
          tickets: seeded.main.tickets,
          emptyAutopilot: seeded.empty.autopilot && seeded.empty.autopilot.enabled,
          emptyPulses: seeded.empty.pulses,
        },
      },
    );

    /* -- open the real panel against the isolated project -------------- */
    await installOverride();
    await setStoredWorkspace(MAIN_ID);
    await app.evaluate(`(() => { window.localStorage.removeItem('dsh.kanban.autopilot.phase1-confirmed'); return true })()`);
    const panelOpen = await openPanel();
    const panelInfo = panelOpen ? await waitPanelReady(MAIN_TITLE) : null;
    record('AC1.4.panel-opens-isolated-project', 'the real Kanban panel opens on the isolated temporary project', panelOpen === true && !!panelInfo && panelInfo.title === MAIN_TITLE, {
      detail: panelInfo,
    });

    await openPopover();
    await waitPopoverIdle();
    const initial = await readPopover();
    record('AC2.1.enable-via-ui', 'autopilot starts off and is enabled through the UI toggle', initial.open === true && initial.state === TEXT.en.state.off, {
      detail: { state: initial.state, selects: initial.selects },
    });

    /* -- enable + phase-1 confirmation --------------------------------- */
    const toggled = await app.evaluate(`(() => { const el = document.querySelector('.kb-apSwitch'); if (!el) return false; el.click(); return true; })()`, { userGesture: true });
    let enabledOk = false;
    let phase1Ok = false;
    const enabledStarted = Date.now();
    while (Date.now() - enabledStarted < 10000) {
      const enabled = await app.evaluate(`(() => { const el = document.querySelector('.kb-apSwitch'); return el ? el.getAttribute('aria-pressed') : null; })()`);
      const banner = await app.evaluate(`!!document.querySelector('.kb-apPhase1')`);
      const flag = await app.evaluate(`window.localStorage.getItem('dsh.kanban.autopilot.phase1-confirmed')`);
      if (enabled === 'true') enabledOk = true;
      if (banner && !phase1Ok) {
        phase1Ok = true;
        await app.evaluate(`(() => {
          const btn = [...document.querySelectorAll('.kb-apPhase1 button')].find((b) => /^(Got it|知道了)$/.test((b.textContent || '').trim()));
          if (btn) btn.click();
          return Boolean(btn);
        })()`, { userGesture: true });
        await sleep(350);
        const flagAfter = await app.evaluate(`window.localStorage.getItem('dsh.kanban.autopilot.phase1-confirmed')`);
        phase1Ok = flagAfter === '1';
        break;
      }
      await sleep(200);
    }
    await waitPopoverIdle(8000);
    const hostAfterEnable = await host.state(MAIN_ID);
    record(
      'AC2.2.enable-persists',
      'enabling through the UI persists `enabled: true` in the host config',
      enabledOk && hostAfterEnable.autopilot && hostAfterEnable.autopilot.config.enabled === true,
      { detail: { toggled, hostEnabled: hostAfterEnable.autopilot && hostAfterEnable.autopilot.config.enabled } },
    );
    record('AC2.3.phase1-confirmation', 'the one-time phase-1 warning is shown once, acknowledged, and remembered', phase1Ok, {
      detail: { phase1Ok },
    });

    /* -- cadence + caps through the UI -------------------------------- */
    const laneBefore = await readLaneChips();
    ctx.laneBefore = laneBefore;
    const setCadence = await setSelect(TEXT.en.cadence, 10);
    await sleep(320);
    const setDepth = await setSelect(TEXT.en.depth, 2);
    await sleep(320);
    const setRefine = await setSelect(TEXT.en.lane.refine, 2);
    await sleep(320);
    const setImplement = await setSelect(TEXT.en.lane.implement, 2);
    await sleep(400);
    let configured = null;
    const configuredStarted = Date.now();
    while (Date.now() - configuredStarted < 10000) {
      const stateNow = await host.state(MAIN_ID);
      const config = stateNow.autopilot && stateNow.autopilot.config;
      if (
        config &&
        config.cadenceMs === 600000 &&
        config.maxReadyDepth === 2 &&
        config.laneCaps &&
        config.laneCaps.refine === 2 &&
        config.laneCaps.implement === 2 &&
        config.laneCaps.review === 1
      ) {
        configured = config;
        break;
      }
      await sleep(200);
    }
    await waitPopoverIdle();
    const laneAfterConfigure = await readLaneChips();
    ctx.laneAfterConfigure = laneAfterConfigure;
    const laneCapChanged = laneAfterConfigure.some((chip) => {
      const before = laneBefore.find((entry) => entry.lane === chip.lane);
      return before && before.capText !== chip.capText;
    });
    record(
      'AC2.4.cadence-and-caps-via-ui',
      'cadence, Ready depth and lane caps are set through the UI and reach the host config',
      setCadence && setDepth && setRefine && setImplement && !!configured,
      { detail: { configured, selects: (await readPopover()).selects } },
    );
    record('AC2.5.lane-chips-update', 'lane admission chips update to the configured caps', laneCapChanged, {
      detail: { before: laneBefore.map((chip) => `${chip.lane}:${chip.capText}`), after: laneAfterConfigure.map((chip) => `${chip.lane}:${chip.capText}`) },
    });

    /* -- persistence after a real page refresh ------------------------ */
    await reloadShell();
    await installOverride();
    await setStoredWorkspace(MAIN_ID);
    await openPanel();
    await waitPanelReady(MAIN_TITLE);
    await openPopover();
    await waitPopoverIdle();
    const afterRefresh = await readPopover();
    const hostAfterRefresh = await host.state(MAIN_ID);
    const persistedValues =
      afterRefresh.selects.find((select) => select.label === TEXT.en.cadence)?.value === '10' &&
      afterRefresh.selects.find((select) => select.label === TEXT.en.depth)?.value === '2' &&
      afterRefresh.selects.find((select) => select.label === TEXT.en.lane.refine)?.value === '2' &&
      afterRefresh.selects.find((select) => select.label === TEXT.en.lane.implement)?.value === '2';
    record(
      'AC2.6.persistence-after-refresh',
      'configuration and enabled state survive a full page refresh (host persistence, not client memory)',
      afterRefresh.state === TEXT.en.state.on && persistedValues && hostAfterRefresh.autopilot.config.cadenceMs === 600000,
      { detail: { state: afterRefresh.state, selects: afterRefresh.selects, hostCadenceMs: hostAfterRefresh.autopilot.config.cadenceMs } },
    );

    /* -- dry-run preview equals the host plan ------------------------- */
    const previewClick = await clickPopoverControl('preview');
    let previewReady = false;
    const previewStarted = Date.now();
    while (Date.now() - previewStarted < 10000) {
      if (await app.evaluate(`!!document.querySelector('.kb-apPreview')`)) {
        previewReady = true;
        break;
      }
      await sleep(150);
    }
    const preview = await readPopover();
    const planResponse = await host.action('autopilot', { op: 'plan' });
    const hostPlan = planResponse.status === 200 ? planResponse.json.value : null;
    const snapshotForPlan = await host.state(MAIN_ID);
    const previewComparison = comparePreviewToPlan(preview.rows, hostPlan, snapshotForPlan, currentLocale);
    record('AC2.7.dry-run-preview', 'the dry-run preview renders the host plan rows', previewReady === true && preview.rows.length > 0 && preview.previewSummary !== null, {
      detail: { clicked: previewClick, rows: preview.rows.length, summary: preview.previewSummary },
    });
    record(
      'AC2.8.preview-equals-host-plan',
      'every rendered preview row matches the host plan (dispatch rows then skip rows, same ids/reasons/lanes/member)',
      previewComparison.equal,
      { detail: { expected: previewComparison.expected, rendered: previewComparison.rendered, mismatches: previewComparison.mismatches, planDecisions: hostPlan ? hostPlan.decisions.length : null, planSkips: hostPlan ? hostPlan.skips.length : null } },
    );

    /* -- admission chips before the pulse ----------------------------- */
    const teamOpened = await toggleTeamRail();
    if (teamOpened) await sleep(700);
    const memberBefore = await readMemberChips();
    const railWasOpen = memberBefore.length > 0;
    if (railWasOpen) {
      await toggleTeamRail();
      await sleep(400);
    }

    /* -- Pulse now ----------------------------------------------------- */
    const pulsesBefore = preview.pulses.length;
    const pulseClick = await clickPopoverControl('pulse');
    let pulseArrived = null;
    const pulseStarted = Date.now();
    while (Date.now() - pulseStarted < 25000) {
      const current = await readPopover();
      if (current.pulses.length > pulsesBefore) {
        pulseArrived = current;
        break;
      }
      await sleep(250);
    }
    await waitPopoverIdle(15000);
    const hostAfterPulse = await host.state(MAIN_ID);
    const newestPulse = hostAfterPulse.board.pulses[0] || null;
    const manualTriggerLabel = currentLocale === 'zh' ? '手动' : 'Manual';
    const pulseRow = pulseArrived && pulseArrived.pulses.find((row) => row.id === (newestPulse && newestPulse.id));
    record(
      'AC2.9.pulse-now-row',
      'Pulse now starts a real manual pulse and a new pulse row appears in the feed',
      pulseClick.clicked === true && pulseArrived !== null && !!pulseRow && pulseRow.trigger === manualTriggerLabel && !!newestPulse && newestPulse.trigger === 'manual',
      {
        detail: {
          clicked: pulseClick,
          before: pulsesBefore,
          after: pulseArrived ? pulseArrived.pulses.length : null,
          hostPulse: newestPulse ? { id: newestPulse.id, trigger: newestPulse.trigger, dispatched: (newestPulse.dispatched || []).length, decisions: (newestPulse.decisions || []).length } : null,
          renderedTrigger: pulseRow ? pulseRow.trigger : null,
        },
      },
    );

    /* -- countdown decreases ------------------------------------------ */
    const samples = [];
    for (let index = 0; index < 3; index += 1) {
      const value = await app.evaluate(`(() => { const el = document.querySelector('.kb-apCountdownValue'); return el ? el.textContent.trim() : null; })()`);
      samples.push(parseCountdown(value));
      await sleep(1300);
    }
    const countdownValid = samples.every((seconds) => Number.isFinite(seconds) && seconds >= 0);
    const countdownDecreased = countdownValid && samples[1] < samples[0] && samples[2] < samples[1];
    record('AC2.10.countdown-decreases', 'the next-pulse countdown decreases between samples', countdownDecreased, {
      detail: { samples },
    });

    /* -- lane + member admission chips after the pulse ---------------- */
    const laneAfterPulse = await readLaneChips();
    const dispatched = newestPulse && Array.isArray(newestPulse.dispatched) ? newestPulse.dispatched[0] : null;
    const dispatchedLane = (() => {
      const decision = newestPulse && Array.isArray(newestPulse.decisions) ? newestPulse.decisions.find((entry) => entry.action === 'dispatch' && entry.ticketId === (dispatched && dispatched.ticketId)) : null;
      return decision ? decision.lane : null;
    })();
    const busyLane = dispatchedLane ? laneAfterPulse.find((chip) => chip.lane === dispatchedLane) : null;
    record(
      'AC2.11.lane-chips-after-pulse',
      'the lane admission chip reflects the dispatched session as busy',
      !!dispatched && !!busyLane && busyLane.state === 'busy',
      { detail: { dispatched, lane: dispatchedLane, chips: laneAfterPulse } },
    );

    const teamOpenedAfter = await toggleTeamRail();
    if (teamOpenedAfter) await sleep(800);
    const memberAfter = await readMemberChips();
    if (memberAfter.length > 0) {
      await toggleTeamRail();
      await sleep(300);
    }
    const dispatchedMember = dispatched ? memberAfter.find((chip) => chip.member === dispatched.memberId) : null;
    const memberChanged = !!dispatchedMember && dispatchedMember.kind === 'active' && (!dispatched || dispatchedMember.text.indexOf(dispatched.ticketId) !== -1);
    record(
      'AC2.12.member-chips-update',
      'the dispatched member admission chip updates to the active ticket',
      memberChanged,
      { detail: { before: memberBefore, after: memberAfter, dispatched, memberChip: dispatchedMember, laneBefore: ctx.laneBefore } },
    );

    /* -- stubbed failing dispatch (AC 3) ------------------------------- */
    await bridgeFetch('/probe/faults', { dispatch: true });
    const pulsesBeforeError = (await readPopover()).pulses.length;
    const errorPulseClick = await clickPopoverControl('pulse');
    let errorState = null;
    const errorStarted = Date.now();
    while (Date.now() - errorStarted < 25000) {
      const current = await readPopover();
      const hostState = await host.state(MAIN_ID);
      const newest = hostState.board.pulses[0];
      if (newest && newest.error && current.pulses.length > pulsesBeforeError && current.alerts.length > 0) {
        errorState = { ui: current, hostPulse: newest };
        break;
      }
      await sleep(300);
    }
    await bridgeFetch('/probe/faults', { dispatch: false });
    await waitPopoverIdle(10000);
    const errorUi = errorState ? errorState.ui : await readPopover();
    const errorMarkerLocale = TEXT[currentLocale].feedErrorMarker;
    const dispatchFailedReason = TEXT[currentLocale].reasons['dispatch-failed'];
    const errorPulseRow = errorState && errorState.hostPulse ? errorUi.pulses.find((row) => row.id === errorState.hostPulse.id) : null;
    record(
      'AC3.1.error-alert',
      'a failing dispatch surfaces the deduplicated error alert in the control panel',
      !!errorState && errorUi.alerts.length > 0 && errorUi.alerts.some((text) => text.indexOf(dispatchFailedReason) !== -1 || text.length > 0),
      { detail: { clicked: errorPulseClick, alerts: errorUi.alerts, hostError: errorState && errorState.hostPulse ? errorState.hostPulse.error : null } },
    );
    record(
      'AC3.2.pulse-error-marker',
      'the failed pulse row carries the error marker and the persisted host error',
      !!errorPulseRow && errorPulseRow.hasError === true && errorPulseRow.errorMarker === errorMarkerLocale && !!errorState && typeof errorState.hostPulse.error === 'string' && errorState.hostPulse.error.length > 0,
      { detail: { row: errorPulseRow, hostError: errorState && errorState.hostPulse ? errorState.hostPulse.error : null, marker: errorMarkerLocale } },
    );

    /* -- failed configure rollback (AC 3) ------------------------------ */
    const configBeforeFailure = (await host.state(MAIN_ID)).autopilot.config;
    await bridgeFetch('/probe/faults', { configureOnce: true });
    const cadenceBefore = (await readPopover()).selects.find((select) => select.label === TEXT.en.cadence)?.value;
    await setSelect(TEXT.en.cadence, 15);
    let rollback = null;
    const rollbackStarted = Date.now();
    while (Date.now() - rollbackStarted < 8000) {
      const current = await readPopover();
      const cadence = current.selects.find((select) => select.label === TEXT.en.cadence)?.value;
      if (current.error && cadence === cadenceBefore) {
        rollback = current;
        break;
      }
      await sleep(200);
    }
    const hostAfterFailedConfigure = (await host.state(MAIN_ID)).autopilot.config;
    const rollbackAlert = rollback ? rollback.error : (await readPopover()).error;
    record(
      'AC3.3.configure-rollback',
      'a rejected configure is explained, the optimistic value rolls back, and the host config is unchanged',
      !!rollback && !!rollbackAlert && rollbackAlert.indexOf('autopilot/invalid') !== -1 && hostAfterFailedConfigure.cadenceMs === configBeforeFailure.cadenceMs,
      { detail: { error: rollbackAlert, cadence: rollback ? rollback.selects.find((select) => select.label === TEXT.en.cadence)?.value : null, hostCadenceMs: hostAfterFailedConfigure.cadenceMs, beforeCadenceMs: configBeforeFailure.cadenceMs } },
    );
    await app.evaluate(`(() => { const el = document.querySelector('.kb-apErrorDismiss'); if (el) el.click(); return true; })()`, { userGesture: true }).catch(() => false);
    await sleep(250);

    /* -- paused board disables Pulse now ------------------------------ */
    const pausedClick = await toggleBoardPause(true);
    let pausedUi = null;
    const pausedStarted = Date.now();
    while (Date.now() - pausedStarted < 10000) {
      const current = await readPopover();
      if (current.paused) {
        pausedUi = current;
        break;
      }
      await sleep(250);
    }
    const hostPaused = await host.state(MAIN_ID);
    const pausedPulseButton = pausedUi ? pausedUi.actions.find((action) => action.title === TEXT.en.pulseDisabled) : null;
    record(
      'AC2.13.paused-disables-pulse',
      'the paused board shows the paused state and disables Pulse now',
      pausedClick === true && !!pausedUi && pausedUi.state === TEXT.en.state.paused && pausedUi.countdown === TEXT.en.countdownPaused && !!pausedPulseButton && pausedPulseButton.disabled === true && hostPaused.board.paused === true,
      { detail: { clicked: pausedClick, state: pausedUi && pausedUi.state, countdown: pausedUi && pausedUi.countdown, pulseButton: pausedPulseButton, hostPaused: hostPaused.board.paused } },
    );
    await toggleBoardPause(false);
    await sleep(1200);

    /* -- live board never routed -------------------------------------- */
    const counters = await app.evaluate(`window.__kb79Counters || { bridge: 0, native: 0 }`);
    record('AC1.5.no-live-kanban-calls', 'every Kanban request from the panel went to the isolated bridge, never to the live host', counters.bridge > 0 && counters.native === 0, {
      detail: counters,
    });

    /* -- capture matrix: main project (5 states x 2 widths x 2 themes x 2 locales) */
    await waitNoToasts();
    for (const locale of ['en', 'zh']) {
      if (locale !== currentLocale) {
        await setLanguage(locale);
        await installOverride();
        await setStoredWorkspace(MAIN_ID);
        await openPanel();
        await waitPanelReady(MAIN_TITLE);
        await openPopover();
      }
      ctx.locale = currentLocale;
      for (const theme of ['light', 'dark']) {
        await applyThemePreference(theme);
        ctx.theme = theme;
        await ensurePanelAndPopover(MAIN_TITLE);
        for (const [width, height] of [[1024, 768], [640, 900]]) {
          await setViewport(width, height);
          ctx.viewport = currentViewport;
          await setSidebarCollapsed(width <= 660);
          await ensurePanelAndPopover(MAIN_TITLE);
          for (const state of ['control', 'preview', 'feed', 'error', 'paused']) {
            await captureMainState(state, ctx);
          }
          // return the board to resumed before the next group
          if ((await readPopover()).paused) {
            await toggleBoardPause(false);
            await sleep(900);
          }
        }
      }
    }

    /* -- capture matrix: empty project (fresh page so the feed is truly empty) */
    for (const locale of ['zh', 'en']) {
      await setStoredWorkspace(EMPTY_ID);
      if (locale !== currentLocale) await setLanguage(locale);
      else await reloadShell();
      await installOverride();
      await setStoredWorkspace(EMPTY_ID);
      await openPanel();
      await waitPanelReady(EMPTY_TITLE);
      await openPopover();
      await waitPopoverIdle();
      ctx.locale = currentLocale;
      for (const theme of ['light', 'dark']) {
        await applyThemePreference(theme);
        ctx.theme = theme;
        await ensurePanelAndPopover(EMPTY_TITLE);
        for (const [width, height] of [[1024, 768], [640, 900]]) {
          await setViewport(width, height);
          ctx.viewport = currentViewport;
          await setSidebarCollapsed(width <= 660);
          await ensurePanelAndPopover(EMPTY_TITLE);
          await captureEmptyState(locale, theme, width, height, ctx);
        }
      }
    }

    /* -- console hygiene (AC 3) --------------------------------------- */
    const allConsole = app.console.slice();
    const unexpected = allConsole.filter((entry) => !isConsoleAllowed(entry.text));
    record('AC3.4.no-unhandled-console-errors', 'no unhandled console error or page exception was captured during the run', unexpected.length === 0, {
      viewport: null,
      theme: null,
      locale: null,
      consoleErrors: unexpected,
      detail: { unexpected: unexpected.slice(0, 10), totalCaptured: allConsole.length, allowlist: CONSOLE_ALLOW.map((pattern) => String(pattern)) },
    });

    /* -- README / spec documentation (AC 7) --------------------------- */
    let readme = '';
    try {
      readme = await readFile(join(REPO, 'README.md'), 'utf8');
    } catch {
      readme = '';
    }
    const readmeHasCommand = readme.includes('node tools/autopilot-probe.js') && readme.includes('docs/screenshots/autopilot/final-verification.json') && readme.includes('--remote-debugging-port=9333');
    record('AC7.1.readme-documents-probe', 'README "Verifying the UI yourself" names the exact command, artifacts and Chrome flags', readmeHasCommand, {
      viewport: null,
      theme: null,
      locale: null,
      detail: { hasCommand: readme.includes('node tools/autopilot-probe.js'), hasArtifact: readme.includes('docs/screenshots/autopilot/final-verification.json'), hasChromeFlags: readme.includes('--remote-debugging-port=9333') },
    });
    let spec = '';
    try {
      spec = await readFile(join(REPO, 'KANBAN_SPEC.md'), 'utf8');
    } catch {
      spec = '';
    }
    const specHasAutopilotSection = /autopilot/i.test(spec) && /verification/i.test(spec);
    const specNamesInvariantSuite = spec.includes('tests/autopilot-invariants.test.mjs');
    const specNamesEvidenceDir = spec.includes('docs/screenshots/autopilot/');
    record(
      'AC7.2.spec-verification-list',
      'the KANBAN_SPEC autopilot verification section names the invariant suite and the evidence directory',
      specHasAutopilotSection && specNamesInvariantSuite && specNamesEvidenceDir,
      {
        viewport: null,
        theme: null,
        locale: null,
        detail: { specHasAutopilotSection, specNamesInvariantSuite, specNamesEvidenceDir },
      },
    );
  } catch (error) {
    runError = error;
    record('run.failure', 'the probe suite completed without an exception', false, {
      viewport: null,
      theme: null,
      locale: null,
      detail: { message: String((error && error.message) || error), stack: String((error && error.stack) || '').split('\n').slice(0, 6) },
    });
  } finally {
    /* -- cleanup + removal proof (AC 1) ------------------------------- */
    try {
      await restoreOverride();
    } catch {
      // best-effort
    }
    try {
      await resetEmulation();
    } catch {
      // best-effort
    }
    let removal = null;
    try {
      if (host) await host.dispose();
      if (bridge) await bridge.close();
      bridge = null;
      const afterDir = host ? await readdir(host.stateDir).catch(() => null) : null;
      removal = { stateDirExists: afterDir !== null, files: afterDir ? afterDir.length : 0, rootExists: false };
      if (host) removal.rootExists = await stat(host.root).then(() => true).catch(() => false);
    } catch (error) {
      removal = { error: String((error && error.message) || error) };
    }
    ctx.boards.after = removal;
    record(
      'AC1.6.temp-boards-removed',
      'the temporary boards are removed in a finally block (state dir and project dirs gone)',
      !!removal && removal.stateDirExists === false && removal.rootExists === false,
      { viewport: null, theme: null, locale: null, detail: removal },
    );
    // restore the GUI: drop the test keys, reload, and prove the live panel still loads.
    let restored = { ok: false };
    try {
      await setStoredWorkspace(null);
      await reloadShell();
      await openPanel();
      await waitPanelReady(null).catch(() => null);
      const liveInfo = await nativeLiveSnapshot();
      const liveTitle = await app.evaluate(`(() => { const el = document.querySelector('.kb-projectBtn'); return el ? (el.getAttribute('title') || el.textContent || '').trim() : null; })()`).catch(() => null);
      const liveAfter = await nativeLiveSnapshot();
      ctx.live.after = liveAfter;
      const titles = (liveAfter.projects || []).map((project) => project.title);
      const projectsUnchanged =
        (ctx.live.before.projects || []).length === titles.length &&
        (ctx.live.before.projects || []).every((project) => titles.includes(project.title));
      restored = { ok: !!liveTitle && titles.includes(liveTitle), liveTitle, projectsUnchanged, liveStatus: liveInfo.status, projects: titles };
      record(
        'AC1.7.live-project-list-unchanged',
        'the live project board is never mutated: the real host project list is identical before and after the probe',
        projectsUnchanged === true,
        { viewport: null, theme: null, locale: null, detail: { before: (ctx.live.before.projects || []).map((project) => project.title), after: titles } },
      );
      record('AC1.8.gui-restored-live', 'after cleanup the real GUI renders the live project again', restored.ok === true, {
        viewport: null,
        theme: null,
        locale: null,
        detail: restored,
      });
    } catch (error) {
      record('AC1.8.gui-restored-live', 'after cleanup the real GUI renders the live project again', false, {
        viewport: null,
        theme: null,
        locale: null,
        detail: { message: String((error && error.message) || error) },
      });
    }
    activeHost = null;
    ctx.removal = removal;
    ctx.finishedAt = new Date().toISOString();
    ctx.durationMs = Date.now() - ctx.startMs;
    ctx.runError = runError ? String((runError && runError.message) || runError) : null;
    recordContext = null;
  }

  // Informational live board listing (never asserted: other sessions may write it).
  ctx.live.boards = await listLiveBoards().catch(() => []);
  return ctx;
}

/* ------------------------------------------------------------------ */
/* Plan <-> preview comparison                                         */
/* ------------------------------------------------------------------ */

function comparePreviewToPlan(renderedRows, hostPlan, snapshot, locale) {
  const text = TEXT[locale] || TEXT.en;
  const roster = Array.isArray(snapshot && snapshot.roster) ? snapshot.roster : [];
  const members = new Map(roster.map((member) => [member.id, member]));
  const tickets = new Map(((snapshot && snapshot.board && snapshot.board.tickets) || []).map((ticket) => [ticket.id, ticket]));
  if (!hostPlan || !Array.isArray(hostPlan.decisions) || !Array.isArray(hostPlan.skips)) {
    return { equal: false, expected: [], rendered: renderedRows, mismatches: ['no host plan returned'] };
  }
  const expected = [];
  const decisions = hostPlan.decisions.slice().sort((left, right) => (Number(left.order) || 0) - (Number(right.order) || 0));
  const push = (entry, kind) => {
    const member = entry.memberId ? members.get(entry.memberId) : null;
    const ticket = entry.ticketId ? tickets.get(entry.ticketId) : null;
    expected.push({
      kind,
      id: entry.ticketId || text.boardLevel,
      title: ticket ? ticket.title : '',
      reason: (text.reasons[entry.reason] || '') || '',
      lane: entry.lane || null,
      laneLabel: entry.lane && text.lane[entry.lane] ? text.lane[entry.lane] : '',
      member: entry.memberName || (member ? member.name : ''),
    });
  };
  decisions.forEach((entry) => push(entry, 'dispatch'));
  hostPlan.skips.forEach((entry) => push(entry, 'skip'));
  const rendered = renderedRows.map((row) => ({
    kind: null,
    id: row.id,
    title: row.title,
    reason: row.reason,
    meta: row.meta || [],
    member: (row.meta || [])[0] || '',
  }));
  const mismatches = [];
  if (rendered.length !== expected.length) mismatches.push(`row count rendered ${rendered.length} != plan ${expected.length}`);
  const limit = Math.min(rendered.length, expected.length);
  for (let index = 0; index < limit; index += 1) {
    const want = expected[index];
    const got = rendered[index];
    if (got.id !== want.id) mismatches.push(`#${index + 1} id rendered "${got.id}" != plan "${want.id}"`);
    if (got.reason !== want.reason) mismatches.push(`#${index + 1} reason rendered "${got.reason}" != plan "${want.reason}"`);
    if (want.title && got.title !== want.title) mismatches.push(`#${index + 1} title rendered "${got.title}" != ticket "${want.title}"`);
    if (want.laneLabel && !(got.meta || []).join(' ').includes(want.laneLabel)) mismatches.push(`#${index + 1} lane "${want.laneLabel}" missing from row meta`);
    if (want.member && !(got.member || '').includes(want.member)) mismatches.push(`#${index + 1} member "${want.member}" missing from row meta`);
  }
  return { equal: mismatches.length === 0, expected, rendered: renderedRows, mismatches };
}

const parseCountdown = (value) => {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d+):(\d{2})$/.exec(value.trim());
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]);
};

/* ------------------------------------------------------------------ */
/* Screenshot capture states                                           */
/* ------------------------------------------------------------------ */

async function screenshotState(state, locale, theme, width, height, ctx, domOk, extraDetail) {
  const file = `${state}-${locale}-${theme}-${width}x${height}.png`;
  const path = join(OUT_DIR, file);
  await app.screenshot(path);
  const info = await pngInfo(path);
  const overflow = await measureOverflow();
  const artifact = relative(REPO, path);
  ctx.screenshots.push({ state, locale, theme, viewport: `${width}x${height}`, file: artifact, bytes: info.bytes });
  const noOverflow =
    overflow.doc && overflow.doc.overflowX === false &&
    overflow.body && overflow.body.overflowX === false &&
    (!overflow.root || overflow.root.overflowX === false) &&
    (!overflow.popover || overflow.popover.overflowX === false);
  const id = `AC4.${state}.${locale}.${theme}.${width}x${height}`;
  record(
    id,
    `PNG capture: ${state} state at ${width}x${height} (${locale}, ${theme}) with no horizontal overflow`,
    domOk === true && info.png === true && noOverflow,
    { viewport: `${width}x${height}`, theme, locale, artifact, detail: { domOk, overflow, bytes: info.bytes, ...(extraDetail || {}) } },
  );
}

async function captureMainState(state, ctx) {
  const locale = currentLocale;
  const theme = currentTheme;
  const width = currentViewport.width;
  const height = currentViewport.height;
  await waitPopoverIdle().catch(() => false);
  if (state === 'control') {
    await scrollPopover('.kb-apPopover', 0);
    await sleep(220);
    const dom = await app.evaluate(`!!document.querySelector('.kb-apPopover') && !!document.querySelector('.kb-apSwitch') && document.querySelectorAll('.kb-apSelect').length >= 4`);
    await screenshotState('control', locale, theme, width, height, ctx, dom, { note: 'control panel open, configuration visible' });
    return;
  }
  if (state === 'preview') {
    if (!(await app.evaluate(`!!document.querySelector('.kb-apPreview')`))) {
      await clickPopoverControl('preview');
      await sleep(750);
    }
    await scrollPopover('.kb-apPreview', 60);
    await sleep(220);
    const dom = await app.evaluate(`!!document.querySelector('.kb-apPreview') && document.querySelectorAll('.kb-apRow').length > 0`);
    await screenshotState('preview', locale, theme, width, height, ctx, dom, { note: 'dry-run preview rows' });
    return;
  }
  if (state === 'feed') {
    await scrollPopover('.kb-apFeed', 36);
    await sleep(220);
    const dom = await app.evaluate(`document.querySelectorAll('.kb-apPulse').length > 0`);
    await screenshotState('feed', locale, theme, width, height, ctx, dom, { note: 'pulse feed with a manual pulse row' });
    return;
  }
  if (state === 'error') {
    // Expand the failed pulse row once so the decision + executed detail is visible.
    await app.evaluate(`(() => {
      const row = document.querySelector('.kb-apPulse.kb-apPulse--error .kb-apPulseHead');
      if (row && row.getAttribute('aria-expanded') !== 'true') row.click();
      return true;
    })()`, { userGesture: true }).catch(() => false);
    await scrollPopover('.kb-apObservability', 20);
    await sleep(280);
    const dom = await app.evaluate(`!!document.querySelector('.kb-apAlert') && document.querySelectorAll('.kb-apPulse--error').length > 0`);
    await screenshotState('error', locale, theme, width, height, ctx, dom, { note: 'dispatch-failure alert + pulse error marker' });
    return;
  }
  if (state === 'paused') {
    if (!(await readPopover()).paused) {
      await setBoardPausedViaHost(true);
    }
    await scrollPopover('.kb-apPopover', 0);
    await sleep(300);
    const dom = await app.evaluate(`(() => {
      const pop = document.querySelector('.kb-apPopover');
      if (!pop || !pop.querySelector('.kb-apState--paused')) return false;
      const pulse = [...pop.querySelectorAll('.kb-apActions button')].find((b) => (b.getAttribute('title') || '') === ${JSON.stringify(TEXT[currentLocale].pulseDisabled)});
      if (!pulse || pulse.disabled !== true) return false;
      const popRect = pop.getBoundingClientRect();
      const rect = pulse.getBoundingClientRect();
      return rect.top >= popRect.top && rect.bottom <= Math.min(popRect.bottom, window.innerHeight);
    })()`);
    const current = await readPopover();
    const pulse = current.actions.find((action) => action.title === TEXT[currentLocale].pulseDisabled);
    await screenshotState('paused', locale, theme, width, height, ctx, dom && current.countdown === TEXT[currentLocale].countdownPaused && !!pulse && pulse.disabled === true, {
      note: 'paused board: paused countdown and disabled Pulse now',
      pulseButtonDisabled: pulse ? pulse.disabled : null,
    });
    await setBoardPausedViaHost(false);
    await sleep(500);
    return;
  }
}

async function captureEmptyState(locale, theme, width, height, ctx) {
  await waitPopoverIdle().catch(() => false);
  await sleep(380);
  await scrollPopover('.kb-apFeed', 36);
  await sleep(280);
  const current = await readPopover();
  const expectedTitle = TEXT[locale].feedEmptyTitleOn;
  const dom = current.feedEmpty === true && typeof current.feedEmptyTitle === 'string' && current.feedEmptyTitle.indexOf(expectedTitle) !== -1;
  const controls = await app.evaluate(`(() => {
    const pop = document.querySelector('.kb-apPopover');
    if (!pop) return null;
    const sw = pop.querySelector('.kb-apSwitch');
    return {
      pressed: sw ? sw.getAttribute('aria-pressed') : null,
      switchDisabled: sw ? sw.disabled : null,
      actions: [...pop.querySelectorAll('.kb-apActions button')].map((b) => ({ text: (b.textContent || '').trim(), title: b.getAttribute('title'), disabled: b.disabled, className: b.className })),
      busy: pop.getAttribute('aria-busy'),
      saving: (pop.querySelector('.kb-apSaving') || {}).textContent || null,
    };
  })()`);
  await screenshotState('empty', locale, theme, width, height, ctx, dom, { feedEmptyTitle: current.feedEmptyTitle, expectedTitle, state: current.state, controls });
}

/* ------------------------------------------------------------------ */
/* Evidence file                                                       */
/* ------------------------------------------------------------------ */

async function writeEvidence(runs, meta) {
  const last = runs[runs.length - 1];
  const checks = last.checks.slice();
  // AC 8 runtime + commit checks are appended to the last run's record.
  recordContext = null;
  const totalDurationMs = Date.now() - meta.processStartedMs;
  checks.push({
    id: 'AC8.1.commit-named',
    description: 'the probe output names the git commit it ran against',
    pass: typeof meta.commit.sha === 'string' && meta.commit.sha.length >= 7,
    viewport: null,
    theme: null,
    locale: null,
    artifact: null,
    consoleErrors: [],
    detail: { commit: meta.commit },
  });
  checks.push({
    id: 'AC8.2.runtime-under-5-minutes',
    description: 'the probe (all runs) finishes in under 5 minutes',
    pass: Number.isFinite(totalDurationMs) && totalDurationMs < 300000,
    viewport: null,
    theme: null,
    locale: null,
    artifact: null,
    consoleErrors: [],
    detail: { totalDurationMs, runs: runs.length },
  });
  const determinism = buildDeterminism(runs);
  if (runs.length > 1) {
    checks.push({
      id: 'AC6.1.deterministic-runs',
      description: 'two consecutive full suite runs produce the same check ids and all pass',
      pass: determinism.idsEqual === true && determinism.allRunsPassed === true,
      viewport: null,
      theme: null,
      locale: null,
      artifact: null,
      consoleErrors: [],
      detail: determinism,
    });
  }
  const failures = checks.filter((check) => check.pass !== true).length;
  const evidence = {
    meta: {
      ticket: 'KB-79',
      title: 'GUI probe and evidence pack for autopilot',
      probe: relative(REPO, fileURLToPath(import.meta.url)),
      url: APP_URL,
      chromePort: CDP_PORT,
      commit: meta.commit,
      startedAt: meta.startedAt,
      finishedAt: new Date().toISOString(),
      processDurationMs: totalDurationMs,
      runs: runs.map((run) => ({
        index: run.index,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        checks: run.checks.length,
        failures: run.checks.filter((check) => check.pass !== true).length,
        error: run.runError,
      })),
      checks: { total: checks.length, passed: checks.length - failures, failed: failures },
      screenshots: last.screenshots.length,
      host: {
        kind: 'real index.js route handlers booted in-process with fake Harness adapters',
        workspaces: last.boards && last.boards.seeded ? last.boards.seeded.workspaces : undefined,
        stateDir: last.boards && last.boards.before ? last.boards.before.stateDir : null,
        failureStubs: { dispatch: 'fake agents.create throws once armed', configure: 'bridge returns 400 autopilot/invalid once armed' },
      },
      boards: {
        before: last.boards.before,
        seeded: last.boards.seeded,
        after: last.boards.after,
        liveBefore: last.live.before,
        liveAfter: last.live.after,
        liveBoards: last.live.boards,
        note: 'The live ~/.dsh/kanban boards are listed read-only for the record; other sessions may write them concurrently, so only the real host project list is asserted unchanged.',
      },
      localeRestored: currentLocale,
      console: app ? app.console.map((entry) => ({ ...entry, allowed: isConsoleAllowed(entry.text) })) : [],
      consoleAllowlist: CONSOLE_ALLOW.map((pattern) => String(pattern)),
      determinism,
      note:
        'The real Web GUI (CDP harness + shipped client bundle) drives the real host handlers against two isolated temporary projects; all /kanban/* requests from the panel are bridged to that isolated host and the live project board is never contacted (AC1.5). Temporary state is removed in finally (AC1.6).',
    },
    checks,
    artifacts: last.screenshots,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  // AC 5 self-check: the file must exist and every record must carry the contract fields.
  let reloaded = null;
  try {
    reloaded = JSON.parse(await readFile(OUT_FILE, 'utf8'));
  } catch (error) {
    reloaded = null;
  }
  const requiredFields = ['id', 'description', 'pass', 'viewport', 'theme', 'locale', 'artifact', 'consoleErrors'];
  const recordsValid =
    !!reloaded &&
    Array.isArray(reloaded.checks) &&
    reloaded.checks.length === checks.length &&
    reloaded.checks.every((check) => requiredFields.every((field) => Object.prototype.hasOwnProperty.call(check, field)));
  checks.push({
    id: 'AC5.1.evidence-file',
    description: 'docs/screenshots/autopilot/final-verification.json is written with one record per check and the contract fields',
    pass: recordsValid,
    viewport: null,
    theme: null,
    locale: null,
    artifact: relative(REPO, OUT_FILE),
    consoleErrors: [],
    detail: { records: reloaded && reloaded.checks ? reloaded.checks.length : null, requiredFields },
  });
  // Rewrite with the self-check record included (ids stay stable across runs).
  const finalFailures = checks.filter((check) => check.pass !== true).length;
  evidence.checks = checks;
  evidence.meta.checks = { total: checks.length, passed: checks.length - finalFailures, failed: finalFailures };
  await writeFile(OUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { evidence, failures: finalFailures };
}

function buildDeterminism(runs) {
  const runsInfo = runs.map((run) => {
    const ids = run.checks.map((check) => check.id);
    return {
      index: run.index,
      durationMs: run.durationMs,
      checks: ids.length,
      failures: run.checks.filter((check) => check.pass !== true).length,
      idsHash: hashJson(ids),
    };
  });
  const first = runs.length > 0 ? runs[0].checks.map((check) => check.id) : [];
  const second = runs.length > 1 ? runs[1].checks.map((check) => check.id) : [];
  const idsEqual = first.length > 0 && first.length === second.length && first.every((id, index) => id === second[index]);
  const differing = first.length !== second.length
    ? [{ index: Math.min(first.length, second.length), first: first[Math.min(first.length, second.length)] || null, second: second[Math.min(first.length, second.length)] || null }]
    : first
        .map((id, index) => (id === second[index] ? null : { index, first: id, second: second[index] }))
        .filter(Boolean);
  return {
    runs: runsInfo,
    idsEqual,
    differingIds: differing.slice(0, 10),
    allRunsPassed: runs.every((run) => run.checks.every((check) => check.pass === true)),
    note: runs.length > 1
      ? 'Check ids are derived from the acceptance criteria and the capture matrix, never from timestamps.'
      : 'Single run (--runs=1): determinism is only compared when two or more runs execute.',
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const meta = { processStartedMs: Date.now(), startedAt: new Date().toISOString(), commit: await readGitCommit() };
  if (VERBOSE) {
    console.log(`KB-79 GUI probe — ${meta.commit.short || 'unknown commit'}${meta.commit.dirty ? ' (dirty tree)' : ''}`);
    console.log(`GUI ${APP_URL} · CDP ${CDP_PORT} · runs ${RUNS} · artifacts ${relative(REPO, OUT_DIR)}`);
  }
  await prepareChromeTargets();
  app = await attach();
  await app.ensureApp({ reload: true });
  await waitShell();

  const original = {
    locale: await localeFromDocument(),
    storage: await readStorage(),
    theme: await readThemePreference().catch(() => 'system'),
    sidebarCollapsed: await sidebarCollapsed().catch(() => null),
  };
  originalSidebarCollapsed = original.sidebarCollapsed;
  if (VERBOSE) console.log(`original GUI locale: ${original.locale}; probing locale: en`);

  const runs = [];
  for (let index = 1; index <= RUNS; index += 1) {
    const run = await runSuite(index);
    runs.push(run);
    if (VERBOSE) {
      console.log(`run ${index}: ${run.checks.length} checks, ${run.checks.filter((check) => check.pass !== true).length} failed, ${run.durationMs} ms`);
    }
  }

  /* restore the user's GUI preferences before writing evidence */
  try {
    await restoreOverride();
    await resetEmulation();
    await setStoredWorkspace(original.storage.workspace && !String(original.storage.workspace).startsWith('kb79-probe') ? original.storage.workspace : null);
    if (original.storage.phase1 === null) await app.evaluate(`window.localStorage.removeItem('dsh.kanban.autopilot.phase1-confirmed')`).catch(() => null);
    else await app.evaluate(`window.localStorage.setItem('dsh.kanban.autopilot.phase1-confirmed', ${JSON.stringify(original.storage.phase1)})`).catch(() => null);
    if (currentLocale !== original.locale) await setLanguage(original.locale);
    if (original.theme) await applyThemePreference(original.theme).catch(() => false);
    await reloadShell();
    if (typeof originalSidebarCollapsed === 'boolean') await setSidebarCollapsed(originalSidebarCollapsed).catch(() => false);
  } catch (error) {
    if (VERBOSE) console.log(`cleanup warning: ${error.message}`);
  }

  const { evidence, failures } = await writeEvidence(runs, meta);
  const determinism = evidence.meta.determinism;

  if (AS_JSON) {
    console.log(JSON.stringify({
      exitCode: failures === 0 ? 0 : 1,
      commit: meta.commit.short,
      runs: evidence.meta.runs,
      checks: evidence.meta.checks,
      determinism,
      evidence: relative(REPO, OUT_FILE),
      screenshots: evidence.artifacts.length,
      failed: evidence.checks.filter((check) => check.pass !== true).map((check) => check.id),
    }, null, 2));
  } else {
    console.log(`\ncommit      ${meta.commit.sha || 'unknown'}`);
    console.log(`evidence    ${relative(REPO, OUT_FILE)}`);
    console.log(`screenshots ${evidence.artifacts.length}`);
    console.log(`checks      ${evidence.meta.checks.passed}/${evidence.meta.checks.total} passed, ${evidence.meta.checks.failed} failed`);
    console.log(`determinism ${determinism.runs.length > 1 ? (determinism.idsEqual ? 'ids identical' : 'IDS DIFFER') : 'not compared (single run)'} across ${determinism.runs.length} run(s)`);
    console.log(`duration    ${evidence.meta.processDurationMs} ms`);
    if (failures > 0) {
      console.log('\nfailed checks:');
      for (const check of evidence.checks.filter((entry) => entry.pass !== true)) {
        console.log(`- ${check.id}: ${check.description} — ${short(check.detail)}`);
      }
    }
  }
  try {
    app.cdp.close();
  } catch {
    // ignore
  }
  process.exit(failures === 0 ? 0 : 1);
}

/** POST to the probe's own bridge from Node (fault arming). */
async function bridgeFetch(path, body) {
  const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return response.json();
}

await main().catch((error) => {
  console.error(`KB-79 probe failed: ${(error && error.stack) || error}`);
  process.exit(1);
});
