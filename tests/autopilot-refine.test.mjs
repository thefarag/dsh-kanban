/**
 * KB-71 — autopilot refine lane: PM refines Backlog to Ready up to the
 * ready-depth cap.
 *
 * Dependency-free harness in the same style as `tests/autopilot-executor.test.mjs`:
 * a temporary state directory, a fake Harness ctx, and an INJECTED clock plus an
 * INJECTED scheduler (no wall-clock sleep anywhere). The fake PM session is a
 * real kanban-tool caller: during the dispatch prompt it runs `claim`, `update`,
 * `comment`, `block` or `finish` as the dispatched session, so every assertion
 * crosses host → tool → persisted board → pulse, not a mocked handler.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  eligible refine dispatch: highest priority then oldest Backlog ticket,
 *         the seeded PM member, read-only access, and a brief carrying the vision
 *         excerpt, Ready depth/ceiling, DoR verbatim and the ticket content
 *   AC 2  the brief's stop condition + no-invented-scope + source-recording rules
 *   AC 3  ready-depth guard creates no session; a concurrent Ready fill makes the
 *         claim fail through the host claim path and the next pulse records
 *         `postcondition-failed` without exceeding the cap (cap 1, two candidates)
 *   AC 4  one refine session at a time (`lane-cap:refine`); a human PM run is not
 *         blocked by the autopilot cap
 *   AC 5  postcondition miss → ticket comment + `postcondition-failed` outcome +
 *         backoff before the ticket can be dispatched again
 *   AC 6  a blocked refinement stays in Backlog, is visible as blocked, records
 *         `deferred` and is not retried until the block is answered
 *   AC 7  no member / paused member → no session, `no-member` / `member-paused`
 *   AC 8  the fake PM session performs claim + edits; dispatch count is exactly 1
 *         for the eligible case and 0 for depth-capped / no-member cases
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, evaluateRefinePostcondition } from '../index.js';
import { DEFINITION_OF_READY } from '../roles.js';

// ---------------------------------------------------------------------------
// Virtual time: `Date.now` and the injected host clock share one source, so
// persisted timestamps, pulse `at` values, cadence and backoff stay coherent.
// ---------------------------------------------------------------------------
const realDateNow = Date.now;
let virtualNow = realDateNow();
Date.now = () => virtualNow;

/** Fake self-rescheduling scheduler: virtual queue entries, never a sleep. */
function createScheduler() {
  const queue = [];
  let sequence = 0;
  return {
    now: () => virtualNow,
    setTimeout(callback, delay) {
      const handle = {
        id: (sequence += 1),
        at: virtualNow + Math.max(0, Math.round(Number(delay) || 0)),
        callback,
        cancelled: false,
        fired: false,
      };
      queue.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) handle.cancelled = true;
    },
    pending() {
      return queue.filter((handle) => !handle.cancelled && !handle.fired).map((handle) => ({ at: handle.at }));
    },
    async advance(ms = 0) {
      const target = virtualNow + ms;
      for (;;) {
        const due = queue
          .filter((handle) => !handle.cancelled && !handle.fired && handle.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!due) break;
        due.fired = true;
        virtualNow = Math.max(virtualNow, due.at);
        const result = due.callback();
        if (result && typeof result.then === 'function') await result;
      }
      virtualNow = Math.max(virtualNow, target);
    },
  };
}

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const brief = (value) => String(JSON.stringify(value)).slice(0, 300);
const section = (title) => console.log(`\n## ${title}`);
const capture = (label, value) =>
  console.log(`[capture] ${label}:`, typeof value === 'string' ? value : JSON.stringify(value));

/** Drain the host's real async file I/O without waiting on wall time. */
async function settle(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const dirs = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const WORKSPACE_ID = 'workspace-refine';
const ACCESS_OPTIONS = [
  { value: 'read-only', name: 'Read only', description: 'Inspect only' },
  { value: 'workspace-write', name: 'Workspace write', description: 'Modify the workspace' },
  { value: 'danger-full-access', name: 'Full access', description: 'Unrestricted' },
];

async function makeApp({ stateDir, root, scheduler }) {
  const services = { routes: new Map() };
  const routes = new Map();
  const tools = new Map();
  const disposers = [];
  const live = new Map();
  const createdSessions = [];
  const createCalls = [];
  const prompts = [];
  const permissionSets = [];
  let promptHook = null;

  const workspace = {
    id: WORKSPACE_ID,
    title: 'Refine Fixture',
    path: root,
    createdAt: new Date(virtualNow).toISOString(),
    updatedAt: new Date(virtualNow).toISOString(),
    sessionIds: [],
    async attachSession() {},
    async status() {
      return 'ok';
    },
  };

  const ctx = {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer !== 'function') throw new Error('effect returned no disposer');
      disposers.push(disposer);
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
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    systemPrompt: { section: () => () => {} },
    connection: { requestRejection: () => undefined },
    workspaceRegistry: { list: () => [workspace] },
    sessionController: {
      async list() {
        return { items: [] };
      },
      async prompt(request) {
        prompts.push({
          sessionId: request.sessionId,
          text: (request.content ?? []).map((part) => part.text || '').join(''),
        });
        if (promptHook) await promptHook(request);
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
      async stat(id) {
        return { header: { id, cwd: root } };
      },
    },
    agents: {
      async create(options) {
        createCalls.push(options);
        createdSessions.push(options.sessionId);
        if (typeof options.setup === 'function') await options.setup({ effect: () => () => {} }, { id: options.sessionId });
        live.set(options.sessionId, { id: options.sessionId, status: 'running', inbox: { hasPending: false } });
        return { agent: { id: options.sessionId, session: { id: options.sessionId } } };
      },
      get(id) {
        return live.get(id);
      },
      list() {
        return [...live.values()];
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    agentPresets: {
      resolve: async () => ({ id: 'default-preset' }),
      mount: async () => {},
    },
    permissionPresets: {
      catalog: () => ({
        options: ACCESS_OPTIONS.map((option) => ({ ...option })),
        defaultOptions: [],
        defaultPreset: 'workspace-write',
      }),
      resolve: (value) => ({ sandbox: value, approval: 'ask' }),
      set: (session, value) => permissionSets.push({ session: session?.id, value }),
    },
    sessionTitle: { rename() {} },
    sessions: { get: () => undefined, flush: async () => {} },
  };
  services.sessionController = ctx.sessionController;
  services.sessionTitle = ctx.sessionTitle;
  services.sessions = ctx.sessions;
  services.permissionPresets = ctx.permissionPresets;
  services.agentPresets = ctx.agentPresets;
  services.agentDefaultModel = ctx.agentDefaultModel;
  services.agents = ctx.agents;

  const handle = apply(ctx, {
    stateDir,
    now: scheduler.now,
    scheduler,
    wipInProgress: 3,
    wipReview: 5,
  });
  if (handle && typeof handle.autopilotReady === 'function') await handle.autopilotReady();
  await settle(4);

  async function http(path, body) {
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

  return {
    handle,
    ctx,
    routes,
    tools,
    disposers,
    live,
    createdSessions,
    createCalls,
    prompts,
    permissionSets,
    stateDir,
    root,
    scheduler,
    async state() {
      const result = await http('/kanban/state', { workspaceId: WORKSPACE_ID });
      return result.json.value;
    },
    async action(action, payload = {}) {
      return http('/kanban/action', { workspaceId: WORKSPACE_ID, action, payload });
    },
    async pulseNow() {
      return http('/kanban/action', { workspaceId: WORKSPACE_ID, action: 'autopilot', payload: { op: 'pulseNow' } });
    },
    async plan() {
      return http('/kanban/action', { workspaceId: WORKSPACE_ID, action: 'autopilot', payload: { op: 'plan' } });
    },
    async configure(patch) {
      return http('/kanban/action', { workspaceId: WORKSPACE_ID, action: 'autopilot', payload: { op: 'configure', patch } });
    },
    setPromptHook(hook) {
      promptHook = hook;
    },
    async dispose() {
      for (const disposer of [...disposers].reverse()) {
        try {
          disposer();
        } catch {
          // one effect's failure must not mask the scheduler teardown
        }
      }
      await settle(2);
    },
  };
}

async function freshApp() {
  const root = await tempDir('kanban-kb71-root-');
  const stateDir = await tempDir('kanban-kb71-state-');
  await writeFile(join(root, 'README.md'), '# Refine fixture\n', 'utf8');
  const scheduler = createScheduler();
  const app = await makeApp({ stateDir, root, scheduler });
  return { app, root, stateDir, scheduler };
}

const boardFile = (stateDir) => join(stateDir, `${WORKSPACE_ID}.json`);
const readBoard = async (stateDir) => JSON.parse(await readFile(boardFile(stateDir), 'utf8'));
/** Patch the persisted board directly — an edit that bypasses the cache. */
async function patchBoardOnDisk(stateDir, mutate) {
  const board = await readBoard(stateDir);
  mutate(board);
  await writeFile(boardFile(stateDir), JSON.stringify(board), 'utf8');
}

async function createTicket(app, input) {
  const result = await app.action('createTicket', input);
  if (result.status !== 200) throw new Error(`createTicket failed: ${result.status} ${brief(result.json)}`);
  return result.json.value.ticket;
}

const ticketOf = (board, id) => board.tickets.find((ticket) => ticket.id === id) ?? null;
const ticketsIn = (board, column) => board.tickets.filter((ticket) => ticket.column === column);
const pulseRows = (board) => (Array.isArray(board.pulses) ? board.pulses : []);
const decisionFor = (pulse, ticketId) => (pulse?.decisions ?? []).find((entry) => entry.ticketId === ticketId) ?? null;
const outcomeFor = (pulse, ticketId) => (pulse?.outcomes ?? []).find((entry) => entry.ticketId === ticketId) ?? null;

/** The fake PM session: run one kanban-tool action as the dispatched session. */
async function pm(app, sessionId, args) {
  const tool = app.tools.get('kanban');
  if (!tool) throw new Error('the kanban tool is not registered');
  try {
    const value = await tool.execute(args, { agent: { id: sessionId } });
    return { ok: true, value };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const match = /kanban\/([a-z/-]+)/.exec(message);
    return { ok: false, code: match ? match[1] : null, message };
  }
}

async function ticketForSession(stateDir, sessionId) {
  const board = await readBoard(stateDir);
  return board.tickets.find((ticket) => ticket.execution?.sessionId === sessionId) ?? null;
}

/** Mark the fake session's turn over, the way a real agent goes idle. */
function endTurn(app, sessionId) {
  const agent = app.live.get(sessionId);
  if (agent) agent.status = 'idle';
}

/** A complete, honest refinement: claim, improve, record sources, finish. */
async function refineProperly(app, stateDir, sessionId, { role = 'be-developer', priority = 'high' } = {}) {
  const target = await ticketForSession(stateDir, sessionId);
  if (!target) throw new Error(`no ticket linked to ${sessionId}`);
  const claim = await pm(app, sessionId, { action: 'claim', ticketId: target.id });
  const update = await pm(app, sessionId, {
    action: 'update',
    ticketId: target.id,
    description: '## Outcome\nShip the refined behaviour.\n\n## Acceptance criteria\n1. The behaviour is observable.\n2. A test proves it.',
    role,
    priority,
    labels: ['autopilot', 'refined'],
  });
  const comment = await pm(app, sessionId, {
    action: 'comment',
    ticketId: target.id,
    text: 'Research sources: docs/AUTOPILOT.md §13, roles.js DEFINITION_OF_READY.',
  });
  const finish = await pm(app, sessionId, { action: 'finish', ticketId: target.id, summary: `Refined ${target.id} to Ready.` });
  return { target, claim, update, comment, finish };
}

// ===========================================================================
// AC 1 / AC 2 — eligible refine dispatch, brief content, read-only session
// ===========================================================================
section('AC 1/2 — eligible refine dispatch, brief, read-only access');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 1, laneCaps: { implement: 0, review: 0 } });
  const low = await createTicket(app, {
    title: 'Lower value refinement',
    column: 'backlog',
    priority: 'high',
    description: 'A rough idea with no scope and no role.',
  });
  const high = await createTicket(app, {
    title: 'Highest value refinement',
    column: 'backlog',
    priority: 'critical',
    description: 'The highest-value Backlog ticket, still rough.',
  });
  // The vision is a board meta field, patched after the creates so the cache
  // cannot overwrite it; the pulse re-reads from disk.
  await patchBoardOnDisk(stateDir, (board) => {
    board.meta.vision = 'Ship a calm, accessible Kanban board for DSH teams.';
  });

  const beforeTicket = await readBoard(stateDir);
  capture('AC1 before — Backlog ticket', JSON.stringify(Object.fromEntries(Object.entries(ticketOf(beforeTicket, high.id)).filter(([key]) => ['id', 'column', 'role', 'priority', 'description', 'labels'].includes(key)))));
  let refined = null;
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    refined = await refineProperly(app, stateDir, request.sessionId, { role: 'be-developer', priority: 'critical' });
  });
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  const sessionId = app.createdSessions[0];
  const promptText = app.prompts.find((prompt) => prompt.sessionId === sessionId)?.text ?? '';

  check('AC1 the pulse admits exactly one refine dispatch', pulse.dispatched.length === 1, brief(pulse.dispatched));
  check('AC1 the highest priority Backlog ticket is chosen', pulse.dispatched[0]?.ticketId === high.id, brief({ dispatched: pulse.dispatched[0]?.ticketId, high: high.id, low: low.id }));
  check('AC1 exactly one agents.create call starts a session', app.createCalls.length === 1, String(app.createCalls.length));
  check('AC1 the dispatched session belongs to the seeded product-manager member', typeof pulse.dispatched[0]?.memberId === 'string' && pulse.dispatched[0].memberId.includes('product-manager'), pulse.dispatched[0]?.memberId);
  check('AC1 the fake PM claim + edits + finish all succeeded', refined?.claim?.ok === true && refined?.update?.ok === true && refined?.finish?.ok === true, brief(refined && Object.fromEntries(Object.entries(refined).filter(([, value]) => value && typeof value === 'object').map(([key, value]) => [key, value.ok]))));

  // Brief content (AC 1 + AC 2).
  check('AC1 the brief carries the project vision excerpt', promptText.includes('Ship a calm, accessible Kanban board for DSH teams.'), brief(promptText.slice(0, 160)));
  check('AC1 the brief carries the current Ready depth and its ceiling', promptText.includes('Ready depth: 0 of maxReadyDepth 1'), 'Ready depth line missing');
  check('AC1 the brief carries the ticket content', promptText.includes(`# Kanban execution — ${high.id}`) && promptText.includes('The highest-value Backlog ticket, still rough.'), 'ticket content missing');
  const missingDor = DEFINITION_OF_READY.filter((item) => !promptText.includes(item));
  check('AC2 the brief contains the Definition of Ready checklist verbatim', missingDor.length === 0, brief(missingDor));
  const briefLower = promptText.toLowerCase();
  check(
    'AC2 the brief explains the stop condition and the no-invented-scope / source rules',
    briefLower.includes('leave it in backlog') &&
      briefLower.includes('do not claim') &&
      briefLower.includes('do not invent scope') &&
      briefLower.includes('record the sources') &&
      briefLower.includes('block') &&
      briefLower.includes('acceptance criteria'),
    'stop-condition or research rules missing',
  );
  check('AC1 the brief tells the PM to claim Backlog → Ready as the finish line', promptText.includes(`{"action":"claim","ticketId":"${high.id}"}`) && promptText.includes('Backlog → Ready'), 'claim instruction missing');
  check(
    'AC1 the brief asks for role, priority, labels, dependencies and write scope',
    ['the owning role', 'priority', 'labels', 'dependencies', 'write scope', 'research'].every((field) =>
      promptText.toLowerCase().includes(field),
    ),
    'field instructions missing',
  );
  check('AC1 the session runs read-only', app.permissionSets.some((entry) => entry.session === sessionId && entry.value === 'read-only'), brief(app.permissionSets));

  let board = await readBoard(stateDir);
  const refinedTicket = ticketOf(board, high.id);
  const untouched = ticketOf(board, low.id);
  check('AC1 the refined ticket is now in Ready', refinedTicket?.column === 'ready', refinedTicket?.column);
  check('AC1 the refined ticket has a role, a priority and an Acceptance criteria section', refinedTicket?.role === 'be-developer' && refinedTicket?.priority === 'critical' && /Acceptance criteria/.test(refinedTicket?.description ?? ''), brief({ role: refinedTicket?.role, priority: refinedTicket?.priority }));
  check('AC1 the refined ticket keeps the PM research sources on the ticket', (refinedTicket?.comments ?? []).some((comment) => String(comment.text).includes('Research sources')), brief((refinedTicket?.comments ?? []).slice(-2)));
  check('AC1 the execution is read-only and fingerprinted as autopilot', refinedTicket?.execution?.accessMode === 'read-only' && refinedTicket?.execution?.origin === 'autopilot', brief(refinedTicket?.execution));
  check('AC1 the lower priority Backlog ticket is untouched', untouched?.column === 'backlog' && !untouched?.execution, brief({ column: untouched?.column, execution: untouched?.execution }));
  capture('AC1 after — refined ticket', JSON.stringify(Object.fromEntries(Object.entries(refinedTicket).filter(([key]) => ['id', 'column', 'role', 'priority', 'labels', 'description'].includes(key)))).slice(0, 500));
  capture('AC1 after — execution row', JSON.stringify(refinedTicket?.execution));
  check('AC1 the ticket has no duplicate live session', app.createdSessions.length === 1, String(app.createdSessions.length));

  // AC 5 postcondition (satisfied) on the next pulse; implement lane is disabled
  // so the Ready ticket is not pulled in this window.
  const verify = await app.pulseNow();
  const satisfied = outcomeFor(verify.json.value.pulse, high.id);
  check('AC1 a satisfied refine records a satisfied outcome', satisfied?.outcome === 'satisfied', brief(verify.json.value.pulse.outcomes));
  check('AC1 the successful refine does not start a second session', app.createdSessions.length === 1, String(app.createdSessions.length));
  capture('the refine brief for a real Backlog ticket', promptText.slice(promptText.indexOf('## Refinement brief'), promptText.indexOf('## How to work')));

  // The additive execution/pulse fields survive a normalized reload (migration).
  const restarted = await makeApp({ stateDir, root: app.root, scheduler: app.scheduler });
  const snapshot = await restarted.state();
  check(
    'AC1 the additive execution origin and pulse outcomes survive a reload',
    ticketOf(snapshot.board, high.id)?.execution?.origin === 'autopilot' &&
      (snapshot.board.pulses[0]?.outcomes ?? []).some((entry) => entry.outcome === 'satisfied'),
    brief(snapshot.board.pulses[0]?.outcomes),
  );
  const normalizedNotes = (boardLike) =>
    (boardLike?.activity ?? []).filter((entry) => entry.kind === 'autopilot/pulses-normalized').length;
  const secondRead = await restarted.state();
  check(
    'AC1 the additive fields re-read byte-stably (no normalization churn)',
    normalizedNotes(snapshot.board) === 0 && normalizedNotes(secondRead.board) === 0,
    `first=${normalizedNotes(snapshot.board)} second=${normalizedNotes(secondRead.board)}`,
  );
  await restarted.dispose();
  await app.dispose();
}

// ===========================================================================
// Compatibility — a pre-KB-71 persisted board still loads and is not refined
// ===========================================================================
section('compatibility — a legacy execution row is not an autopilot refine');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 5, laneCaps: { implement: 0 } });
  const ticket = await createTicket(app, { title: 'Legacy in-flight work', column: 'ready', role: 'be-developer', priority: 'high' });
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticket.id);
    // The pre-KB-70 shape: no `origin`, no `postcondition`, no `startColumn`.
    target.execution = {
      sessionId: 'session-legacy',
      status: 'running',
      role: 'be-developer',
      accessMode: 'workspace-write',
      startedAt: virtualNow - 60_000,
      updatedAt: virtualNow - 60_000,
      finishedAt: null,
      report: '',
      error: '',
      blocked: null,
    };
    target.owner = { sessionId: 'session-legacy', name: 'legacy', role: 'be-developer', memberId: null };
  });
  // The pulse is the first read that bypasses the cache, so it loads the patched
  // (legacy-shaped) board exactly as a restarted host would.
  const pulse = (await app.pulseNow()).json.value.pulse;
  const snapshot = await app.state();
  const legacy = ticketOf(snapshot.board, ticket.id);
  check('compat the legacy execution row loads without a synthesized origin or marker', legacy?.execution?.origin === undefined && legacy?.execution?.postcondition === undefined, brief(legacy?.execution));
  check('compat a legacy row records no refine outcome', outcomeFor(pulse, ticket.id) == null, brief(pulse.outcomes));
  check('compat the legacy row is not re-dispatched or misread as refine', app.createdSessions.length === 0 && decisionFor(pulse, ticket.id)?.reason !== 'postcondition-failed', brief(decisionFor(pulse, ticket.id)));
  await app.dispose();
}

// ===========================================================================
// AC 1 — ordering inside the refine group: priority, then oldest movedAt
// ===========================================================================
section('AC 1 — highest priority, then oldest Backlog ticket');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 5, laneCaps: { implement: 0, review: 0 } });
  const newer = await createTicket(app, { title: 'Newer high', column: 'backlog', priority: 'high' });
  const older = await createTicket(app, { title: 'Older high', column: 'backlog', priority: 'high' });
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, older.id);
    if (target) {
      target.movedAt = virtualNow - 900_000;
      target.createdAt = virtualNow - 900_000;
    }
  });
  const result = await app.pulseNow();
  const dispatched = result.json.value.pulse.dispatched;
  check('AC1 the oldest Backlog ticket wins inside one priority', dispatched.length === 1 && dispatched[0].ticketId === older.id, brief({ dispatched: dispatched[0]?.ticketId, older: older.id, newer: newer.id }));
  check('AC1 exactly one session is created for the eligible case', app.createdSessions.length === 1, String(app.createdSessions.length));
  await app.dispose();
}

// ===========================================================================
// AC 3a — the depth guard: at maxReadyDepth no session is created
// ===========================================================================
section('AC 3a — Ready at maxReadyDepth: ready-depth, zero sessions');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 1, laneCaps: { implement: 0 } });
  await createTicket(app, { title: 'Already ready', column: 'ready', role: 'be-developer', priority: 'high' });
  const waiting = await createTicket(app, { title: 'Waiting in Backlog', column: 'backlog', priority: 'critical' });

  const dryRun = await app.plan();
  check('AC3 the operator dry-run plans a ready-depth skip', (dryRun.json.value.skips ?? []).some((skip) => skip.ticketId === waiting.id && skip.reason === 'ready-depth'), brief(dryRun.json.value.skips));

  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  check('AC3 the pulse records ready-depth for the Backlog ticket', decisionFor(pulse, waiting.id)?.reason === 'ready-depth', brief(decisionFor(pulse, waiting.id)));
  capture('AC3a depth-capped pulse decision', JSON.stringify({ decisions: pulse.decisions, dispatched: pulse.dispatched, createdSessions: app.createCalls.length }));
  check('AC3 the depth-capped pulse creates zero sessions', app.createCalls.length === 0, String(app.createCalls.length));
  const board = await readBoard(stateDir);
  check('AC3 the Backlog ticket stays in Backlog', ticketOf(board, waiting.id)?.column === 'backlog', ticketOf(board, waiting.id)?.column);
  await app.dispose();
}

// ===========================================================================
// AC 3b — a concurrent Ready fill after planning: claim rejected, no overflow
// ===========================================================================
section('AC 3b — concurrent Ready fill: claim rejected, postcondition-failed');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 1, maxDispatchesPerPulse: 2, laneCaps: { implement: 0 } });
  const firstCandidate = await createTicket(app, { title: 'First planned refinement', column: 'backlog', priority: 'high' });
  const secondCandidate = await createTicket(app, { title: 'Second planned refinement', column: 'backlog', priority: 'critical' });
  const concurrent = await createTicket(app, { title: 'Concurrent fill', column: 'backlog', priority: 'low' });

  // The plan sees two eligible refinements and admits one (phase-1 lane cap 1);
  // the other is lane-capped, so "two planned refinements" can never mean two
  // concurrent refine sessions.
  const planned = await app.plan();
  const plannedRefine = planned.json.value.decisions.filter((decision) => decision.lane === 'refine');
  check('AC3b the plan admits exactly one of the two refinements', plannedRefine.length === 1, brief(planned.json.value.decisions));

  let claimAttempt = null;
  let concurrentMove = null;
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    // A concurrent dispatch (a human move here) fills Ready after planning.
    concurrentMove = await app.action('moveTicket', { ticketId: concurrent.id, column: 'ready' });
    const target = await ticketForSession(stateDir, request.sessionId);
    claimAttempt = await pm(app, request.sessionId, { action: 'claim', ticketId: target.id });
  });
  const dispatchPulse = await app.pulseNow();
  const dispatchedId = dispatchPulse.json.value.pulse.dispatched[0]?.ticketId;
  check('AC3b the planned refinement is dispatched once', app.createdSessions.length === 1, String(app.createdSessions.length));
  check('AC3b the concurrent dispatch filled Ready to the cap', concurrentMove?.status === 200 && ticketsIn(await readBoard(stateDir), 'ready').length === 1, brief({ status: concurrentMove?.status }));
  check('AC3b the PM claim is rejected by the host claim path', claimAttempt?.ok === false && claimAttempt?.code === 'ticket/wip-limit', brief(claimAttempt));
  check('AC3b the rejection names the autopilot ceiling', String(claimAttempt?.message ?? '').includes('autopilot ceiling 1'), claimAttempt?.message);
  capture('AC3b concurrent-fill claim rejection', JSON.stringify(claimAttempt));
  let board = await readBoard(stateDir);
  check('AC3b the rejected claim leaves the ticket in Backlog', ticketOf(board, dispatchedId)?.column === 'backlog', ticketOf(board, dispatchedId)?.column);
  const otherCandidate = firstCandidate.id === dispatchedId ? secondCandidate.id : firstCandidate.id;
  check('AC3b the second planned refinement never starts a session', ticketOf(board, otherCandidate)?.execution == null, brief({ otherCandidate, execution: ticketOf(board, otherCandidate)?.execution }));

  // The PM's turn ends without the claim; the next pulse verifies and records it.
  endTurn(app, app.createdSessions[0]);
  const verifyPulse = (await app.pulseNow()).json.value.pulse;
  const failedOutcome = outcomeFor(verifyPulse, dispatchedId);
  capture('AC3b postcondition-failed outcome', JSON.stringify(verifyPulse.outcomes));
  check('AC3b the pulse records postcondition-failed for the miss', failedOutcome?.outcome === 'postcondition-failed', brief(verifyPulse.outcomes));
  board = await readBoard(stateDir);
  check('AC3b the ticket carries the autopilot postcondition-failed comment', (ticketOf(board, dispatchedId)?.comments ?? []).some((comment) => comment.author === 'autopilot' && String(comment.text).startsWith('[autopilot postcondition-failed]')), brief((ticketOf(board, dispatchedId)?.comments ?? []).slice(-2)));
  check('AC3b the cap is never exceeded', ticketsIn(board, 'ready').length === 1, String(ticketsIn(board, 'ready').length));
  check('AC3b no extra session is ever started', app.createdSessions.length === 1, String(app.createdSessions.length));
  await app.dispose();
}

// ===========================================================================
// AC 4 — one refine session at a time; a human PM run is not blocked
// ===========================================================================
section('AC 4 — lane-cap:refine while a refine session is active');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 5, maxDispatchesPerPulse: 2, laneCaps: { implement: 0, review: 0 } });
  const active = await createTicket(app, { title: 'Refinement in flight', column: 'backlog', priority: 'high' });
  const waiting = await createTicket(app, { title: 'Waiting refinement', column: 'backlog', priority: 'high' });
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    const target = await ticketForSession(stateDir, request.sessionId);
    const claim = await pm(app, request.sessionId, { action: 'claim', ticketId: target.id });
    check('AC4 the in-flight PM claim succeeds', claim.ok === true, brief(claim));
  });
  const first = await app.pulseNow();
  check('AC4 the first refine dispatch starts one session', first.json.value.pulse.dispatched.length === 1 && app.createdSessions.length === 1, brief(first.json.value.pulse.dispatched));

  // The PM claimed Backlog → Ready but its session is still running: the refine
  // lane stays occupied by its dispatch origin, so a second refine is capped.
  const second = await app.pulseNow();
  const skip = decisionFor(second.json.value.pulse, waiting.id);
  capture('AC4 lane-cap:refine skip', JSON.stringify(skip));
  check('AC4 the second refine decision is lane-capped', skip?.reason === 'lane-cap' && skip?.lane === 'refine', brief(skip));
  check('AC4 the active refine session keeps the lane occupied', outcomeFor(second.json.value.pulse, active.id) == null, 'unexpected outcome for a live session');
  check('AC4 no second refine session is created', app.createdSessions.length === 1, String(app.createdSessions.length));

  // A human-initiated PM run is not restrained by the autopilot ready-depth cap.
  await app.configure({ maxReadyDepth: 1 });
  const humanTicket = await createTicket(app, { title: 'Human-run refinement', column: 'backlog', priority: 'high' });
  const humanRun = await app.action('runTicket', { ticketId: humanTicket.id, role: 'product-manager' });
  check('AC4 the host accepts a human-initiated PM run', humanRun.status === 200, `${humanRun.status} ${brief(humanRun.json)}`);
  const humanSession = humanRun.json?.value?.sessionId;
  const humanClaim = await pm(app, humanSession, { action: 'claim', ticketId: humanTicket.id });
  check('AC4 the human PM claim is not blocked by the autopilot cap', humanClaim.ok === true, brief(humanClaim));
  const board = await readBoard(stateDir);
  check('AC4 the human-run ticket reaches Ready above the autopilot cap', ticketOf(board, humanTicket.id)?.column === 'ready' && ticketOf(board, humanTicket.id)?.execution?.origin === undefined, brief(ticketOf(board, humanTicket.id)?.execution));
  await app.dispose();
}

// ===========================================================================
// AC 5 — postcondition miss: comment, outcome, backoff before retry
// ===========================================================================
section('AC 5 — a refine that advances nothing is cooled down by backoffMs');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 5, backoffMs: 900_000, laneCaps: { implement: 0 } });
  const ticket = await createTicket(app, { title: 'Refine me properly', column: 'backlog', priority: 'high' });
  app.setPromptHook(async () => {
    app.setPromptHook(null);
    // A PM session that ends its turn without claiming or editing anything.
  });
  const first = await app.pulseNow();
  const sessionId = app.createdSessions[0];
  check('AC5 the first refine dispatch starts one session', first.json.value.pulse.dispatched.length === 1, brief(first.json.value.pulse.dispatched));
  check('AC5 the missed refine never claimed the ticket', ticketOf(await readBoard(stateDir), ticket.id)?.column === 'backlog', ticketOf(await readBoard(stateDir), ticket.id)?.column);

  endTurn(app, sessionId);
  await scheduler.advance(1_000);
  const miss = (await app.pulseNow()).json.value.pulse;
  check('AC5 the pulse records postcondition-failed', outcomeFor(miss, ticket.id)?.outcome === 'postcondition-failed', brief(miss.outcomes));
  check('AC5 the ticket carries the postcondition-failed comment', (ticketOf(await readBoard(stateDir), ticket.id)?.comments ?? []).some((comment) => String(comment.text).startsWith('[autopilot postcondition-failed]')), brief((ticketOf(await readBoard(stateDir), ticket.id)?.comments ?? []).slice(-2)));
  check('AC5 the ticket is not dispatched inside backoffMs', decisionFor(miss, ticket.id)?.reason === 'postcondition-failed' && app.createdSessions.length === 1, brief(decisionFor(miss, ticket.id)));

  // Another pulse inside the backoff window: still no session, one comment only.
  const again = (await app.pulseNow()).json.value.pulse;
  check('AC5 a second pulse inside the backoff still dispatches nothing', app.createdSessions.length === 1, String(app.createdSessions.length));
  const afterMarker = (ticketOf(await readBoard(stateDir), ticket.id)?.comments ?? []).filter((comment) => String(comment.text).startsWith('[autopilot postcondition-failed]'));
  check('AC5 the failure is recorded once per state change, not every pulse', afterMarker.length === 1, String(afterMarker.length));
  check('AC5 the pulse keeps reporting the cooldown reason', decisionFor(again, ticket.id)?.reason === 'postcondition-failed', brief(decisionFor(again, ticket.id)));

  // After the backoff the ticket is retried; a proper refine then succeeds.
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    await refineProperly(app, stateDir, request.sessionId);
  });
  await scheduler.advance(900_000);
  await settle();
  const board = await readBoard(stateDir);
  check('AC5 the ticket is dispatched again once backoffMs elapsed', app.createdSessions.length === 2, String(app.createdSessions.length));
  check('AC5 the retried refine reaches Ready with the postcondition met', ticketOf(board, ticket.id)?.column === 'ready' && evaluateRefinePostcondition(ticketOf(board, ticket.id)).ok === true, brief(ticketOf(board, ticket.id)));
  await app.dispose();
}

// ===========================================================================
// AC 6 — a refinement needing a user fact blocks and is deferred
// ===========================================================================
section('AC 6 — blocked refinement: deferred, visible, not retried');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 5, laneCaps: { implement: 0 } });
  const ticket = await createTicket(app, { title: 'Retention window is unknown', column: 'backlog', priority: 'high' });
  let blockResult = null;
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    const target = await ticketForSession(stateDir, request.sessionId);
    await pm(app, request.sessionId, { action: 'comment', ticketId: target.id, text: 'Cannot meet the DoR: the retention window is not on the ticket, in the vision, or in the repo.' });
    blockResult = await pm(app, request.sessionId, {
      action: 'block',
      ticketId: target.id,
      text: 'The ticket does not state how long audit logs must be retained.',
      questions: ['How long must audit logs be retained?'],
    });
  });
  const first = await app.pulseNow();
  check('AC6 the blocked PM calls block successfully', blockResult?.ok === true, brief(blockResult));
  const sessionId = app.createdSessions[0];
  const blockedPrompt = app.prompts.find((prompt) => prompt.sessionId === sessionId)?.text ?? '';
  check('AC1 the brief states "No vision recorded" when the board has no vision', blockedPrompt.includes('No vision recorded for this project'), 'vision fallback missing');

  const deferredPulse = (await app.pulseNow()).json.value.pulse;
  capture('AC6 deferred outcome + blocked ticket', JSON.stringify({ outcome: outcomeFor(deferredPulse, ticket.id), block: ticketOf(await readBoard(stateDir), ticket.id)?.block, decision: decisionFor(deferredPulse, ticket.id) }));
  check('AC6 the pulse records deferred', outcomeFor(deferredPulse, ticket.id)?.outcome === 'deferred', brief(deferredPulse.outcomes));
  let board = await readBoard(stateDir);
  const blockedTicket = ticketOf(board, ticket.id);
  check('AC6 the ticket stays in Backlog', blockedTicket?.column === 'backlog', blockedTicket?.column);
  check('AC6 the ticket is visible as blocked with the exact missing fact', blockedTicket?.blocked === true && (blockedTicket?.block?.questions ?? []).some((question) => String(question.text).includes('retained')), brief(blockedTicket?.block));
  const blockedSnapshot = await app.state();
  check('AC6 the snapshot exposes it in the Blocked lane count', blockedSnapshot.execution.blocked >= 1 && blockedSnapshot.board.tickets.some((entry) => entry.id === ticket.id && entry.blocked === true), brief(blockedSnapshot.execution));
  check('AC6 the pulse records the blocked skip reason', decisionFor(deferredPulse, ticket.id)?.reason === 'blocked', brief(decisionFor(deferredPulse, ticket.id)));
  check('AC6 no second session starts while blocked', app.createdSessions.length === 1, String(app.createdSessions.length));

  // Repeated pulses inside and after the cadence: still no retry (the session
  // resumes from the answer, so a new dispatch is never needed).
  await scheduler.advance(600_000);
  await settle();
  check('AC6 the blocked ticket is not retried by later pulses', app.createdSessions.length === 1, String(app.createdSessions.length));
  board = await readBoard(stateDir);
  check('AC6 the deferred outcome is recorded once', outcomeFor(deferredPulse, ticket.id)?.outcome === 'deferred', brief(deferredPulse.outcomes));
  check('AC6 the same session owns the blocked ticket', ticketOf(board, ticket.id)?.execution?.sessionId === sessionId, brief(ticketOf(board, ticket.id)?.execution));
  await app.dispose();
}

// ===========================================================================
// AC 7 — no member / paused member: no session, named reason
// ===========================================================================
section('AC 7 — no product-manager member / all paused');
{
  const { app } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 5, laneCaps: { implement: 0 } });
  const ticket = await createTicket(app, { title: 'No PM available', column: 'backlog', priority: 'high' });
  const snapshot = await app.state();
  const pmMember = snapshot.board.team.members.find((member) => member.roleId === 'product-manager');
  const repurposed = await app.action('updateMember', { memberId: pmMember.id, patch: { roleId: 'reviewer' } });
  check('AC7 the fixture removes the product-manager member', repurposed.status === 200, String(repurposed.status));
  const pulse = (await app.pulseNow()).json.value.pulse;
  check('AC7 no member starts no session', app.createCalls.length === 0, String(app.createCalls.length));
  check('AC7 the pulse records no-member', decisionFor(pulse, ticket.id)?.reason === 'no-member', brief(decisionFor(pulse, ticket.id)));
  await app.dispose();
}
{
  const { app } = await freshApp();
  await app.configure({ enabled: true, maxReadyDepth: 5, laneCaps: { implement: 0 } });
  const ticket = await createTicket(app, { title: 'PM is paused', column: 'backlog', priority: 'high' });
  const snapshot = await app.state();
  const pmMember = snapshot.board.team.members.find((member) => member.roleId === 'product-manager');
  const paused = await app.action('updateMember', { memberId: pmMember.id, patch: { paused: true } });
  check('AC7 the fixture pauses the product-manager member', paused.status === 200, String(paused.status));
  const pulse = (await app.pulseNow()).json.value.pulse;
  check('AC7 a paused member starts no session', app.createCalls.length === 0, String(app.createCalls.length));
  check('AC7 the pulse records member-paused', decisionFor(pulse, ticket.id)?.reason === 'member-paused', brief(decisionFor(pulse, ticket.id)));
  await app.dispose();
}

// ===========================================================================
// Unit coverage — the refine postcondition predicate (the risky branch)
// ===========================================================================
section('unit — evaluateRefinePostcondition');
{
  const complete = {
    column: 'ready',
    role: 'be-developer',
    priority: 'high',
    description: '## Outcome\nx\n\n## Acceptance criteria\n1. one',
  };
  const ok = evaluateRefinePostcondition(complete);
  check('unit a fully refined ticket passes', ok.ok === true && ok.missing.length === 0, brief(ok));
  check('unit a Backlog ticket fails with the column named', evaluateRefinePostcondition({ ...complete, column: 'backlog' }).missing.some((item) => item.includes('Ready')), brief(evaluateRefinePostcondition({ ...complete, column: 'backlog' })));
  check('unit a missing role fails', evaluateRefinePostcondition({ ...complete, role: null }).missing.some((item) => item.includes('role')), brief(evaluateRefinePostcondition({ ...complete, role: null })));
  check('unit a missing acceptance criteria section fails', evaluateRefinePostcondition({ ...complete, description: 'only prose' }).missing.some((item) => item.includes('Acceptance criteria')), brief(evaluateRefinePostcondition({ ...complete, description: 'only prose' })));
  check('unit a corrupt ticket never throws', evaluateRefinePostcondition(null).ok === false, brief(evaluateRefinePostcondition(null)));
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
Date.now = realDateNow;
for (const dir of dirs) await rm(dir, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? 'ALL KB-71 REFINE CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
