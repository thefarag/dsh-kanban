/**
 * KB-70 — autopilot pulse executor: host cadence, overlap guard, restart
 * recovery, and the manual pulse.
 *
 * Dependency-free harness in the same style as `tests/execution.test.mjs`: a
 * temporary state directory, a fake Harness ctx, and an INJECTED clock plus an
 * INJECTED scheduler. There is no wall-clock sleep anywhere in this file — the
 * fake scheduler owns virtual time, so `apply()`'s timers fire only when the
 * suite advances the timeline, and a `setImmediate` flush only drains the host's
 * real async I/O (file reads/writes).
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  enabled boards discovered on apply; next pulse at updatedAt+cadence;
 *         timer armed inside ctx.effect and the disposer stops all dispatch
 *   AC 2  planPulse on a fresh board, startTicketExecution once per decision in
 *         order, board JSON re-read before every dispatch (human edit survives)
 *   AC 3  overlap guard records pulse/skipped-overlap, no queue/no dispatch, and
 *         the guard is released in `finally` (a thrown pulse does not wedge it)
 *   AC 4  exactly one board.pulses entry per pulse with trigger, ISO timestamp,
 *         duration, decisions, dispatched sessions and error; persisted on failure
 *   AC 5  first dispatch throw stops the pulse, records error + failing decision,
 *         increments the failure streak (backoff on the next pulse), and leaves
 *         the ticket consistent
 *   AC 6  pulseNow runs immediately with trigger manual, works while a timer is
 *         pending, 409 autopilot/pulsing while one runs, counts the same budget
 *   AC 7  paused board = recorded no-op; resume re-arms at now+cadence and repairs
 *         paused executions; per-member pause is planned and re-checked at dispatch
 *   AC 8  kill/restart with a persisted board: enabled board resumes, a dead
 *         running execution is reconciled to idle and recovered — exactly one new
 *         session, zero duplicates
 *   AC 9  autopilot off clears the timer synchronously, records autopilot/disabled
 *         with actor + timestamp, and leaves running sessions untouched
 *   AC 10 `debug` tool output exposes nextTickAt and the last pulse
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, AUTOPILOT_REASON_CODES, AUTOPILOT_SKIP_CODES } from '../index.js';

// ---------------------------------------------------------------------------
// Virtual time. `Date.now` and the injected host clock share the same source so
// persisted timestamps, pulse `at` values and cadence math stay on one timeline.
// ---------------------------------------------------------------------------
const realDateNow = Date.now;
let virtualNow = realDateNow();
Date.now = () => virtualNow;

/**
 * Fake self-rescheduling scheduler. `setTimeout` is a virtual queue entry, not a
 * sleep: nothing here waits on wall time. Returning the callback's promise lets
 * `advance()` await the pulse that the timer started.
 */
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
    /** Fire every due callback up to `virtualNow + ms`, in time order. */
    async advance(ms = 0, { awaitTicks = true } = {}) {
      const target = virtualNow + ms;
      for (;;) {
        const due = queue
          .filter((handle) => !handle.cancelled && !handle.fired && handle.at <= target)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!due) break;
        due.fired = true;
        virtualNow = Math.max(virtualNow, due.at);
        const result = due.callback();
        if (awaitTicks && result && typeof result.then === 'function') await result;
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
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const brief = (value) => String(JSON.stringify(value)).slice(0, 260);
const section = (title) => console.log(`\n## ${title}`);

/** Let the host's real async I/O run without waiting on wall-clock time. */
async function settle(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(condition, rounds = 500) {
  for (let index = 0; index < rounds; index += 1) {
    if (await condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

const dirs = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const WORKSPACE_ID = 'workspace-1';

const ACCESS_OPTIONS = [
  { value: 'read-only', name: 'Read only', description: 'Inspect only' },
  { value: 'workspace-write', name: 'Workspace write', description: 'Modify the workspace' },
  { value: 'danger-full-access', name: 'Full access', description: 'Unrestricted' },
];

/**
 * Build one host instance against `stateDir`. Each call has fresh caches, agents
 * and routes — that is what makes a "kill/restart" a genuine new process stand-in.
 */
async function makeApp({
  stateDir,
  root,
  scheduler,
  workspaceId = WORKSPACE_ID,
  agentTeams = null,
  extraWorkspaces = [],
}) {
  const services = {};
  const routes = new Map();
  const tools = new Map();
  const disposers = [];
  const live = new Map();
  const createdSessions = [];
  const createCalls = [];
  const prompts = [];
  const permissionSets = [];
  let createGate = null;
  let failCreate = null;
  let promptHook = null;

  const workspace = {
    id: workspaceId,
    title: 'Executor Fixture',
    path: root,
    createdAt: new Date(virtualNow).toISOString(),
    updatedAt: new Date(virtualNow).toISOString(),
    sessionIds: [],
    async attachSession() {},
    async status() {
      return 'ok';
    },
  };
  const registeredWorkspaces = [
    workspace,
    ...extraWorkspaces.map((entry) => ({
      id: entry.id,
      title: entry.title ?? `Extra ${entry.id}`,
      path: entry.root,
      createdAt: new Date(virtualNow).toISOString(),
      updatedAt: new Date(virtualNow).toISOString(),
      sessionIds: [],
      async attachSession() {},
      async status() {
        return 'ok';
      },
    })),
  ];

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
        return () => {};
      },
    },
    systemPrompt: { section: () => () => {} },
    connection: { requestRejection: () => undefined },
    workspaceRegistry: { list: () => registeredWorkspaces },
    sessionController: {
      async list() {
        return { items: [] };
      },
      async prompt(request) {
        prompts.push({ sessionId: request.sessionId, text: (request.content ?? []).map((part) => part.text || '').join('') });
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
        if (createGate) await createGate.promise;
        if (failCreate) throw failCreate;
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
      catalog: () => ({ options: ACCESS_OPTIONS.map((option) => ({ ...option })), defaultOptions: [], defaultPreset: 'workspace-write' }),
      resolve: (value) => ({ sandbox: value, approval: 'ask' }),
      set: (session, value) => permissionSets.push({ session: session?.id, value }),
    },
    sessionTitle: { rename() {} },
    sessions: { get: () => undefined, flush: async () => {} },
  };
  if (agentTeams) ctx.agentTeams = agentTeams;
  services.agentDefaultModel = ctx.agentDefaultModel;
  services.sessionTitle = ctx.sessionTitle;
  services.sessions = ctx.sessions;
  services.permissionPresets = ctx.permissionPresets;
  services.agentPresets = ctx.agentPresets;
  // The executor resolves live agents through `ctx.get('agents')` (liveness and
  // restart reconciliation), so the fake registry must be a service too.
  services.agents = ctx.agents;
  if (agentTeams) services.agentTeams = agentTeams;

  const handle = apply(ctx, {
    stateDir,
    now: scheduler.now,
    scheduler,
    wipInProgress: 3,
    wipReview: 5,
  });
  // The startup sweep is asynchronous by design; await its handle (and drain the
  // remaining async I/O) so the suite never races the first tick.
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
    workspaceId,
    stateDir,
    root,
    registeredWorkspaces,
    async state(ws = workspaceId) {
      const result = await http('/kanban/state', { workspaceId: ws });
      return result.json.value;
    },
    async action(action, payload = {}, ws = workspaceId) {
      return http('/kanban/action', { workspaceId: ws, action, payload });
    },
    async pulseNow(ws = workspaceId) {
      return http('/kanban/action', { workspaceId: ws, action: 'autopilot', payload: { op: 'pulseNow' } });
    },
    async configure(patch, ws = workspaceId) {
      return http('/kanban/action', { workspaceId: ws, action: 'autopilot', payload: { op: 'configure', patch } });
    },
    async status(ws = workspaceId) {
      return http('/kanban/action', { workspaceId: ws, action: 'autopilot', payload: { op: 'status' } });
    },
    setCreateGate(gate) {
      createGate = gate;
    },
    setFailCreate(error) {
      failCreate = error;
    },
    setPromptHook(hook) {
      promptHook = hook;
    },
    async dispose() {
      for (const disposer of [...disposers].reverse()) {
        try {
          disposer();
        } catch {
          // a sibling effect's failure must not mask the scheduler teardown
        }
      }
      await settle(2);
    },
  };
}

async function freshApp({ scheduler = createScheduler(), agentTeams = null } = {}) {
  const root = await tempDir('kanban-kb70-root-');
  const stateDir = await tempDir('kanban-kb70-state-');
  await writeFile(join(root, 'README.md'), '# Executor fixture\n', 'utf8');
  const app = await makeApp({ stateDir, root, scheduler, agentTeams });
  return { app, root, stateDir, scheduler };
}

const boardFile = (stateDir, workspaceId = WORKSPACE_ID) => join(stateDir, `${workspaceId}.json`);
const readBoard = async (stateDir, workspaceId = WORKSPACE_ID) =>
  JSON.parse(await readFile(boardFile(stateDir, workspaceId), 'utf8'));

/** Patch the persisted board directly — a human edit that bypasses the cache. */
async function patchBoardOnDisk(stateDir, mutate, workspaceId = WORKSPACE_ID) {
  const board = await readBoard(stateDir, workspaceId);
  mutate(board);
  await writeFile(boardFile(stateDir, workspaceId), JSON.stringify(board), 'utf8');
}

async function createTicket(app, input) {
  const result = await app.action('createTicket', input);
  if (result.status !== 200) throw new Error(`createTicket failed: ${result.status} ${brief(result.json)}`);
  return result.json.value.ticket;
}

const ticketOf = (board, id) => board.tickets.find((ticket) => ticket.id === id) ?? null;
const pulseRows = (board) => (Array.isArray(board.pulses) ? board.pulses : []);
const activityKinds = (board) => (Array.isArray(board.activity) ? board.activity.map((entry) => entry.kind) : []);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ===========================================================================
// AC 1 — cadence armed on apply, teardown stops dispatch
// ===========================================================================
section('AC 1 — cadence, self-rescheduling timer, disposer teardown');
{
  const { app, stateDir, scheduler } = await freshApp();
  const configured = await app.configure({ enabled: true });
  check('AC1 configure enabled returns 200', configured.status === 200 && configured.json.ok === true, String(configured.status));
  const status = await app.status();
  const t0 = virtualNow;
  check(
    'AC1 the next pulse is armed at updatedAt + cadenceMs',
    status.json.value.nextTickAt === t0 + 300000,
    brief({ nextTickAt: status.json.value.nextTickAt, t0 }),
  );
  check('AC1 exactly one timer is armed for the board', scheduler.pending().length === 1, brief(scheduler.pending()));

  await scheduler.advance(299000);
  await settle();
  let board = await readBoard(stateDir);
  check('AC1 no pulse fires before the cadence elapses', pulseRows(board).length === 0, String(pulseRows(board).length));

  await scheduler.advance(2000);
  await settle();
  board = await readBoard(stateDir);
  check('AC1 exactly one pulse fires at the cadence boundary', pulseRows(board).length === 1, String(pulseRows(board).length));
  check('AC1 the pulse carries trigger timer', pulseRows(board)[0]?.trigger === 'timer', pulseRows(board)[0]?.trigger);
  check('AC1 the pulse carries an ISO timestamp', pulseRows(board)[0]?.atIso === new Date(pulseRows(board)[0].at).toISOString(), pulseRows(board)[0]?.atIso);
  check('AC1 the pulse carries a measured duration', Number.isFinite(pulseRows(board)[0]?.durationMs), String(pulseRows(board)[0]?.durationMs));
  check('AC1 an idle pulse costs no agent session', app.createdSessions.length === 0, String(app.createdSessions.length));
  await app.dispose();
}

{
  // Teardown: the scheduler must clear its timer and stop dispatching for good.
  const { app, stateDir, scheduler } = await freshApp();
  await createTicket(app, { title: 'Never dispatched after unload', column: 'ready', role: 'be-developer' });
  await app.configure({ enabled: true });
  check('AC1 a timer is armed before teardown', scheduler.pending().length === 1, brief(scheduler.pending()));
  await app.dispose();
  check('AC1 the disposer clears the armed timer', scheduler.pending().length === 0, brief(scheduler.pending()));
  await scheduler.advance(30 * 60 * 1000);
  await settle();
  const board = await readBoard(stateDir);
  check('AC1 no dispatch happens after the disposer runs', app.createdSessions.length === 0, String(app.createdSessions.length));
  check('AC1 no pulse is written after the disposer runs', pulseRows(board).length === 0, String(pulseRows(board).length));
}

// ===========================================================================
// AC 1b — apply() discovers enabled persisted boards (and creates no board files)
// ===========================================================================
section('AC 1b — startup sweep discovers enabled boards without touching clean projects');
{
  const { app: seed, stateDir, root, scheduler } = await freshApp();
  await seed.configure({ enabled: true });
  await createTicket(seed, { title: 'Discovered on apply', column: 'ready', role: 'be-developer' });
  const firstCreated = seed.createdSessions.length;
  check('AC1b the seed app has not dispatched before restart', firstCreated === 0, String(firstCreated));
  await seed.dispose();
  await writeFile(join(root, 'README.md'), '# Executor fixture\n', 'utf8');
  const untouchedRoot = await tempDir('kanban-kb70-untouched-');
  await writeFile(join(untouchedRoot, 'README.md'), '# Untouched project\n', 'utf8');
  const app = await makeApp({
    stateDir,
    root,
    scheduler,
    extraWorkspaces: [{ id: 'workspace-2', root: untouchedRoot }],
  });
  check('AC1b the sweep arms the persisted enabled board', scheduler.pending().length === 1, brief(scheduler.pending()));
  let untouchedBoardExists = true;
  try {
    await readFile(join(stateDir, 'workspace-2.json'), 'utf8');
  } catch {
    untouchedBoardExists = false;
  }
  check('AC1b an untouched project gets no board file', untouchedBoardExists === false);
  await scheduler.advance(300000);
  await settle();
  const board = await readBoard(stateDir);
  check('AC1b the discovered board pulses on its persisted cadence', pulseRows(board).length === 1, String(pulseRows(board).length));
  check('AC1b the discovered board dispatches through the normal pipeline', app.createdSessions.length === 1, String(app.createdSessions.length));
  let stillAbsent = true;
  try {
    await readFile(join(stateDir, 'workspace-2.json'), 'utf8');
  } catch {
    stillAbsent = false;
  }
  check('AC1b the untouched project is still clean after a tick', stillAbsent === false);
  await app.dispose();
}

// ===========================================================================
// AC 1c — one host-level scheduler iterates every enabled board independently
// ===========================================================================
section('AC 1c — per-board timers for a multi-project host');
{
  const scheduler = createScheduler();
  const root = await tempDir('kanban-kb70-root-');
  const stateDir = await tempDir('kanban-kb70-state-');
  const secondRoot = await tempDir('kanban-kb70-root-2-');
  await writeFile(join(root, 'README.md'), '# One\n', 'utf8');
  await writeFile(join(secondRoot, 'README.md'), '# Two\n', 'utf8');
  const app = await makeApp({ stateDir, root, scheduler, extraWorkspaces: [{ id: 'workspace-2', root: secondRoot }] });
  await app.configure({ enabled: true });
  await app.configure({ enabled: true }, 'workspace-2');
  await createTicket(app, { title: 'Project one work', column: 'ready', role: 'be-developer' });
  await app.action('createTicket', { title: 'Project two work', column: 'ready', role: 'be-developer' }, 'workspace-2');
  check('AC1c each enabled board owns one timer', scheduler.pending().length === 2, brief(scheduler.pending()));
  await scheduler.advance(300000);
  await settle();
  const boardOne = await readBoard(stateDir);
  const boardTwo = await readBoard(stateDir, 'workspace-2');
  check('AC1c the first board pulsed once', pulseRows(boardOne).length === 1, String(pulseRows(boardOne).length));
  check('AC1c the second board pulsed once', pulseRows(boardTwo).length === 1, String(pulseRows(boardTwo).length));
  check('AC1c each board dispatched its own ticket', boardOne.tickets[0].execution?.status === 'running' && boardTwo.tickets[0].execution?.status === 'running', brief([boardOne.tickets[0].execution?.status, boardTwo.tickets[0].execution?.status]));
  await app.configure({ enabled: false });
  check('AC1c disabling one board leaves the other timer armed', scheduler.pending().length === 1, brief(scheduler.pending()));
  await scheduler.advance(300000);
  await settle();
  const boardOneAfter = await readBoard(stateDir);
  const boardTwoAfter = await readBoard(stateDir, 'workspace-2');
  check('AC1c the disabled board stops pulsing', pulseRows(boardOneAfter).length === 1, String(pulseRows(boardOneAfter).length));
  check('AC1c the still-enabled board keeps pulsing', pulseRows(boardTwoAfter).length === 2, String(pulseRows(boardTwoAfter).length));
  await app.dispose();
}

// ===========================================================================
// AC 2 — planPulse, dispatch order, re-read between decisions
// ===========================================================================
section('AC 2 — plan on a fresh board, dispatch in order, re-read before each dispatch');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxDispatchesPerPulse: 2 });
  const reviewTicket = await createTicket(app, { title: 'Review gate work', column: 'review', role: 'tester', priority: 'high' });
  const readyTicket = await createTicket(app, { title: 'Implement the slice', column: 'ready', role: 'be-developer', priority: 'high' });
  const humanEdit = { ticketId: readyTicket.id, title: 'HUMAN EDIT — edited between decisions' };
  app.setPromptHook(async () => {
    // A human edits the board while the first dispatch is in flight. The executor
    // must not overwrite that edit with its stale in-memory copy.
    app.setPromptHook(null);
    await patchBoardOnDisk(stateDir, (board) => {
      const target = board.tickets.find((ticket) => ticket.id === humanEdit.ticketId);
      if (target) target.title = humanEdit.title;
    });
  });
  const result = await app.pulseNow();
  check('AC2 manual pulse returns 200', result.status === 200 && result.json.ok === true, String(result.status));
  const pulse = result.json.value.pulse;
  const dispatched = pulse.decisions.filter((entry) => entry.action === 'dispatch');
  check('AC2 one dispatch decision per admitted ticket', dispatched.length === 2, brief(dispatched));
  check('AC2 dispatch order follows the planner (review then implement)', same(dispatched.map((entry) => entry.ticketId), [reviewTicket.id, readyTicket.id]), brief(dispatched.map((entry) => entry.ticketId)));
  check('AC2 exactly two sessions start', app.createdSessions.length === 2, String(app.createdSessions.length));
  const board = await readBoard(stateDir);
  check('AC2 review ticket is running its own session', ticketOf(board, reviewTicket.id)?.execution?.sessionId === app.createdSessions[0], brief(ticketOf(board, reviewTicket.id)?.execution));
  check('AC2 ready ticket is running its own session', ticketOf(board, readyTicket.id)?.execution?.sessionId === app.createdSessions[1], brief(ticketOf(board, readyTicket.id)?.execution));
  check('AC2 the human edit made between decisions survives', ticketOf(board, readyTicket.id)?.title === humanEdit.title, ticketOf(board, readyTicket.id)?.title);
  check('AC2 pulse.dispatched lists every dispatched session', pulse.dispatched.length === 2 && pulse.dispatched.every((row) => typeof row.sessionId === 'string'), brief(pulse.dispatched));
  await app.dispose();
}

{
  // Fairness key (KB-69 §13): both a start and a resume stamp the member.
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true });
  await createTicket(app, { title: 'Fairness stamp', column: 'ready', role: 'be-developer' });
  const result = await app.pulseNow();
  const board = await readBoard(stateDir);
  const dispatched = result.json.value.pulse.dispatched[0];
  const member = board.team.members.find((entry) => entry.id === dispatched.memberId);
  check('AC2 the dispatched member records lastActivatedAt', member?.lastActivatedAt === result.json.value.pulse.at, brief({ lastActivatedAt: member?.lastActivatedAt, at: result.json.value.pulse.at }));
  await app.dispose();
}

section('AC 2b — rework handoff bridge (in_progress → ready → dispatch)');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true });
  const ticket = await createTicket(app, { title: 'Rework the slice', column: 'in_progress', role: 'be-developer' });
  await patchBoardOnDisk(stateDir, (board) => {
    const target = board.tickets.find((entry) => entry.id === ticket.id);
    if (target) target.reviews = [{ verdict: 'changes-requested', at: virtualNow - 1000, by: 'reviewer' }];
  });
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  check('AC2b rework is admitted through the handoff decision', pulse.decisions.some((entry) => entry.ticketId === ticket.id && entry.action === 'dispatch'), brief(pulse.decisions));
  const board = await readBoard(stateDir);
  const moved = ticketOf(board, ticket.id);
  check('AC2b the executor moved the ticket one legal step to ready', moved?.column === 'ready', moved?.column);
  check('AC2b the dispatch started from ready', moved?.execution?.startColumn === 'ready', moved?.execution?.startColumn);
  check('AC2b the handoff is recorded as board activity', activityKinds(board).includes('autopilot/handoff'), brief(activityKinds(board).slice(0, 5)));
  check('AC2b the rework session was created once', app.createdSessions.length === 1, String(app.createdSessions.length));
  await app.dispose();
}

// ===========================================================================
// AC 3 — overlap guard
// ===========================================================================
section('AC 3 — overlap guard (recorded, no queue, no dispatch, released in finally)');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true });
  await createTicket(app, { title: 'Slow dispatch', column: 'ready', role: 'be-developer' });
  const gate = deferred();
  app.setCreateGate(gate);
  const pulsePromise = app.pulseNow();
  const started = await waitFor(() => app.createCalls.length === 1);
  check('AC3 the manual pulse is in flight', started === true, `createCalls=${app.createCalls.length}`);
  const conflicting = await app.pulseNow();
  check(
    'AC3 a second manual pulse while one runs is rejected 409 autopilot/pulsing',
    conflicting.status === 409 && conflicting.json?.error?.code === 'autopilot/pulsing',
    `${conflicting.status} ${conflicting.json?.error?.code}`,
  );
  // The next timer tick arrives while the pulse is still awaiting its dispatch.
  await scheduler.advance(300000, { awaitTicks: false });
  const overlapRecorded = await waitFor(async () => activityKinds(await readBoard(stateDir)).includes('pulse/skipped-overlap'));
  let board = await readBoard(stateDir);
  check('AC3 a second tick records pulse/skipped-overlap', overlapRecorded === true, brief(activityKinds(board).slice(0, 4)));
  check('AC3 the skipped tick dispatches nothing', app.createdSessions.length === 0 && app.createCalls.length === 1, `sessions=${app.createdSessions.length} creates=${app.createCalls.length}`);
  gate.resolve();
  const manual = await pulsePromise;
  check('AC3 the in-flight pulse completes normally', manual.status === 200 && manual.json.value.pulse.dispatched.length === 1, brief(manual.json?.value?.pulse?.dispatched));
  check('AC3 the overlap did not queue a second dispatch', app.createdSessions.length === 1, String(app.createdSessions.length));
  // Guard released: another manual pulse is accepted and plans against the
  // running execution instead of dispatching a duplicate.
  const second = await app.pulseNow();
  check('AC3 another pulse runs after the first (guard released)', second.status === 200, String(second.status));
  check('AC3 the follow-up pulse starts no duplicate session', app.createdSessions.length === 1, String(app.createdSessions.length));
  board = await readBoard(stateDir);
  check('AC3 the follow-up pulse records active-execution', second.json.value.pulse.decisions.some((entry) => entry.reason === 'active-execution' || entry.reason === 'lane-cap'), brief(second.json.value.pulse.decisions));
  await app.dispose();
}

// ===========================================================================
// AC 4 — one persisted pulse record with the full audit shape
// ===========================================================================
section('AC 4 — pulse record shape and persistence');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true });
  const ticket = await createTicket(app, { title: 'Recorded dispatch', column: 'ready', role: 'be-developer' });
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  const persisted = await readBoard(stateDir);
  const stored = pulseRows(persisted)[0];
  check('AC4 exactly one pulse entry is persisted', pulseRows(persisted).length === 1, String(pulseRows(persisted).length));
  check('AC4 record keys include the frozen pulse shape', ['id', 'at', 'trigger', 'decisions', 'dispatched', 'error'].every((key) => key in stored), brief(Object.keys(stored)));
  check('AC4 record adds the additive ISO timestamp', typeof stored.atIso === 'string' && stored.atIso === new Date(stored.at).toISOString(), stored.atIso);
  check('AC4 record adds the additive duration', Number.isFinite(stored.durationMs) && stored.durationMs >= 0, String(stored.durationMs));
  check('AC4 trigger is manual for a manual pulse', stored.trigger === 'manual', stored.trigger);
  check('AC4 decisions keep the planner vocabulary', stored.decisions.some((entry) => entry.action === 'dispatch' && entry.reason === 'admitted'), brief(stored.decisions));
  check('AC4 the dispatch ledger carries the session', stored.dispatched.length === 1 && stored.dispatched[0].ticketId === ticket.id && stored.dispatched[0].sessionId === app.createdSessions[0], brief(stored.dispatched));
  check('AC4 a successful pulse stores an empty error', stored.error === '', stored.error);
  // Restart: the additive fields must survive migrate-on-read.
  const scheduler = createScheduler();
  const restarted = await makeApp({ stateDir, root: app.root, scheduler });
  const snapshot = await restarted.state();
  check('AC4 the additive pulse fields survive a reload', snapshot.board.pulses[0]?.atIso === stored.atIso && snapshot.board.pulses[0]?.durationMs === stored.durationMs, brief(snapshot.board.pulses[0]));
  check('AC4 pulse ids stay stable across reload', snapshot.board.pulses[0]?.id === stored.id && pulse.id === stored.id, `${snapshot.board.pulses[0]?.id}/${stored.id}`);
  await restarted.dispose();
  await app.dispose();
}

// ===========================================================================
// AC 5 — dispatch failure containment, failure streak, backoff
// ===========================================================================
section('AC 5 — first dispatch throw stops the pulse; error recorded; backoff');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true, backoffMs: 600000, maxDispatchesPerPulse: 2 });
  const reviewTicket = await createTicket(app, { title: 'Review that fails', column: 'review', role: 'tester' });
  await createTicket(app, { title: 'Never reached', column: 'ready', role: 'be-developer' });
  app.setFailCreate(new Error('agent factory exploded'));
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  check('AC5 a failed pulse still returns a record', result.status === 200 && pulse.error.includes('agent factory exploded'), pulse.error);
  check('AC5 the first throw stops the pulse', app.createCalls.length === 1, String(app.createCalls.length));
  check('AC5 the failing decision is recorded on the pulse', pulse.decisions.some((entry) => entry.ticketId === reviewTicket.id && entry.action === 'dispatch'), brief(pulse.decisions));
  check('AC5 no session is recorded as dispatched', pulse.dispatched.length === 0, brief(pulse.dispatched));
  let board = await readBoard(stateDir);
  check('AC5 the failed pulse is persisted with its error', pulseRows(board)[0]?.error.includes('agent factory exploded'), pulseRows(board)[0]?.error);
  const failedTicket = ticketOf(board, reviewTicket.id);
  check('AC5 the ticket is not half-dispatched', !failedTicket?.execution || failedTicket.execution.status !== 'running', brief(failedTicket?.execution));
  check('AC5 the ticket has no owner claim', failedTicket?.owner === null, brief(failedTicket?.owner));
  check(
    'AC5 the ticket records the autopilot dispatch failure',
    (failedTicket?.comments ?? []).some((comment) => comment.author === 'autopilot' && String(comment.text).startsWith('[autopilot dispatch-failed]')),
    brief((failedTicket?.comments ?? []).slice(-2)),
  );
  const status = await app.status();
  const expectedNext = pulse.at + 600000;
  check('AC5 the failure streak applies the backoff to the next tick', status.json.value.nextTickAt === expectedNext, brief({ nextTickAt: status.json.value.nextTickAt, expectedNext }));
  await scheduler.advance(300000);
  await settle();
  board = await readBoard(stateDir);
  check('AC5 the next pulse does not fire at the bare cadence after an error', pulseRows(board).length === 1, String(pulseRows(board).length));
  await scheduler.advance(301000);
  await settle();
  board = await readBoard(stateDir);
  check('AC5 the backoff tick fires the retry pulse', pulseRows(board).length === 2, String(pulseRows(board).length));
  check('AC5 the retry pulse records the second error', pulseRows(board)[0]?.error.includes('agent factory exploded'), pulseRows(board)[0]?.error);
  const retryStatus = await app.status();
  check('AC5 the error streak doubles the backoff', retryStatus.json.value.nextTickAt === pulseRows(board)[0].at + 1200000, brief({ nextTickAt: retryStatus.json.value.nextTickAt, pulseAt: pulseRows(board)[0].at }));
  // Guard release after a throw: the scheduler is not wedged.
  app.setFailCreate(null);
  const recovered = await app.pulseNow();
  check(
    'AC5 a failed pulse does not wedge the overlap guard',
    recovered.status === 200 && recovered.json.value.pulse.dispatched.length >= 1,
    brief({ status: recovered.status, error: recovered.json?.value?.pulse?.error, decisions: recovered.json?.value?.pulse?.decisions, created: app.createdSessions.length }),
  );
  await app.dispose();
}

// ===========================================================================
// AC 6 — manual pulse: immediate, pending-timer, 409, same budget
// ===========================================================================
section('AC 6 — manual pulse (pulseNow)');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true });
  const ticket = await createTicket(app, { title: 'Manual dispatch', column: 'ready', role: 'be-developer' });
  check('AC6 a timer pulse is pending before the manual run', scheduler.pending().length === 1, brief(scheduler.pending()));
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  check('AC6 pulseNow returns 200 with the record', result.status === 200 && result.json.ok === true, String(result.status));
  check('AC6 the manual pulse uses trigger manual', pulse.trigger === 'manual', pulse.trigger);
  check('AC6 the manual pulse dispatched immediately', app.createdSessions.length === 1 && pulse.dispatched[0].ticketId === ticket.id, brief(pulse.dispatched));
  let board = await readBoard(stateDir);
  check('AC6 the manual dispatch consumed one budget unit', board.autopilot.budget.hour.used === 1 && board.autopilot.budget.day.used === 1, brief(board.autopilot.budget));
  const firstStatus = await app.status();
  // Evidence capture for the ticket: the persisted entry and the status body.
  console.log('[capture] persisted pulse entry:', JSON.stringify((await readBoard(stateDir)).pulses[0]));
  console.log('[capture] autopilot {op:"status"} after the manual pulse:', JSON.stringify(firstStatus.json.value));
  check('AC6 status reports the manual pulse as the last pulse', firstStatus.json.value.lastPulse?.id === pulse.id, brief(firstStatus.json.value.lastPulse?.id));
  check('AC6 status reports a finite nextTickAt after the manual pulse', Number.isFinite(firstStatus.json.value.nextTickAt), String(firstStatus.json.value.nextTickAt));
  // Second manual pulse stays budget-bounded: the dispatch budget is shared.
  // KB-75 AC 1 changes this contract: an exhausted manual pulse is REFUSED with
  // `429 autopilot/budget` and a retry-after hint instead of running a pulse that
  // could only record `budget-exhausted`.
  await app.configure({ budget: { hour: 1, day: 1 } });
  const blocked = await app.pulseNow();
  check('AC6 a budget-exhausted manual pulse dispatches nothing', app.createdSessions.length === 1, String(app.createdSessions.length));
  check(
    'AC6 a budget-exhausted manual pulse is refused with 429 autopilot/budget',
    blocked.status === 429 && blocked.json?.error?.code === 'autopilot/budget',
    `${blocked.status} ${blocked.json?.error?.code}`,
  );
  check(
    'AC6 the budget refusal carries the retry-after hint',
    Number.isFinite(blocked.json?.error?.details?.retryAfterSeconds) && blocked.json.error.details.retryAfterSeconds > 0,
    brief(blocked.json?.error?.details),
  );
  const budgetStatus = await app.status();
  check('AC6 budgetRemaining reports the shared counter', budgetStatus.json.value.budgetRemaining.hour.remaining === 0, brief(budgetStatus.json.value.budgetRemaining));
  await app.dispose();
}

// ===========================================================================
// AC 7 — pause integration
// ===========================================================================
section('AC 7 — board pause, resume re-arm/repair, per-member pause');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true });
  await createTicket(app, { title: 'Wait through the pause', column: 'ready', role: 'be-developer' });
  const paused = await app.action('pauseBoard');
  check('AC7 pauseBoard returns 200', paused.status === 200, String(paused.status));
  await scheduler.advance(300000);
  await settle();
  let board = await readBoard(stateDir);
  check('AC7 a paused pulse is a recorded no-op', pulseRows(board).length === 1 && pulseRows(board)[0].decisions[0].reason === 'board-paused', brief(pulseRows(board)[0]?.decisions));
  check('AC7 a paused pulse starts no session', app.createdSessions.length === 0, String(app.createdSessions.length));
  await scheduler.advance(300000);
  await settle();
  board = await readBoard(stateDir);
  check('AC7 repeated paused ticks do not spam the pulse feed', pulseRows(board).length === 1, String(pulseRows(board).length));
  const resumeAt = virtualNow;
  const resumed = await app.action('resumeBoard');
  check('AC7 resumeBoard returns 200', resumed.status === 200, String(resumed.status));
  const resumedStatus = await app.status();
  check('AC7 resuming re-arms the scheduler at now + cadence', resumedStatus.json.value.nextTickAt === resumeAt + 300000, brief({ nextTickAt: resumedStatus.json.value.nextTickAt, resumeAt }));
  await scheduler.advance(300000);
  await settle();
  board = await readBoard(stateDir);
  check('AC7 the first pulse after resume carries trigger resume', pulseRows(board)[0]?.trigger === 'resume', pulseRows(board)[0]?.trigger);
  check('AC7 resuming dispatches the waiting ticket normally', app.createdSessions.length === 1, String(app.createdSessions.length));
  await app.dispose();
}

{
  // Resume repairs `paused` execution rows to idle before planning; it does not
  // spawn a replacement session merely to restore state.
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true });
  const ticket = await createTicket(app, { title: 'Paused mid-flight', column: 'ready', role: 'be-developer' });
  await app.pulseNow();
  const firstSession = app.createdSessions[0];
  const paused = await app.action('pauseBoard');
  check('AC7 the running execution is marked paused by pauseBoard', paused.status === 200 && (await readBoard(stateDir)).tickets[0].execution.status === 'paused', (await readBoard(stateDir)).tickets[0].execution.status);
  await app.action('resumeBoard');
  await scheduler.advance(300000);
  await settle();
  const board = await readBoard(stateDir);
  const repaired = ticketOf(board, ticket.id);
  check('AC7 resume repairs the paused execution row before planning', repaired?.execution?.status === 'running', brief(repaired?.execution));
  check('AC7 the resume repair is recorded as board activity', activityKinds(board).includes('autopilot/board-resume-repair'), brief(activityKinds(board).slice(0, 5)));
  check('AC7 no replacement session is spawned just to restore state', app.createdSessions.length === 1 && firstSession === app.createdSessions[0], String(app.createdSessions.length));
  await app.dispose();
}

{
  // Per-member pause is a planner gate and is re-checked at dispatch time.
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true });
  const reviewTicket = await createTicket(app, { title: 'Review first', column: 'review', role: 'tester' });
  const readyTicket = await createTicket(app, { title: 'Implement second', column: 'ready', role: 'be-developer' });
  await app.configure({ maxDispatchesPerPulse: 2 });
  // A human pauses the implementer between the two decisions of the same pulse.
  app.setPromptHook(async () => {
    app.setPromptHook(null);
    await patchBoardOnDisk(stateDir, (board) => {
      const member = board.team.members.find((entry) => entry.id === 'member-be-developer');
      if (member) member.paused = true;
    });
  });
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  check('AC7 the first lane still dispatches', app.createdSessions.length === 1, String(app.createdSessions.length));
  check('AC7 the paused member is re-checked at dispatch time', pulse.decisions.some((entry) => entry.ticketId === readyTicket.id && entry.reason === 'member-paused'), brief(pulse.decisions.filter((entry) => entry.ticketId === readyTicket.id)));
  const board = await readBoard(stateDir);
  check('AC7 the paused member gets no session', ticketOf(board, readyTicket.id)?.execution == null, brief(ticketOf(board, readyTicket.id)?.execution));
  check('AC7 the review session was dispatched', ticketOf(board, reviewTicket.id)?.execution?.status === 'running', brief(ticketOf(board, reviewTicket.id)?.execution));
  await app.dispose();
}

// ===========================================================================
// AC 8 — restart recovery + the fake-clock kill/restart timeline
// ===========================================================================
section('AC 8 — restart recovery: one new session, zero duplicates');
{
  const { app: app1, stateDir, root, scheduler } = await freshApp();
  await app1.configure({ enabled: true });
  const reviewTicket = await createTicket(app1, { title: 'Survives the restart', column: 'review', role: 'tester' });
  const readyTicket = await createTicket(app1, { title: 'Second lane work', column: 'ready', role: 'be-developer' });
  const t0 = virtualNow;
  await scheduler.advance(300000);
  await settle();
  let board = await readBoard(stateDir);
  check('AC8 timeline t=5m dispatches the review ticket', pulseRows(board).length === 1 && ticketOf(board, reviewTicket.id)?.execution?.status === 'running', brief(ticketOf(board, reviewTicket.id)?.execution));
  const sessionOne = app1.createdSessions[0];
  await scheduler.advance(300000);
  await settle();
  board = await readBoard(stateDir);
  check('AC8 timeline t=10m dispatches the ready ticket', pulseRows(board).length === 2 && ticketOf(board, readyTicket.id)?.execution?.status === 'running', brief(ticketOf(board, readyTicket.id)?.execution));
  check('AC8 two pulses and two sessions before the restart', app1.createdSessions.length === 2 && pulseRows(board).length === 2, `${app1.createdSessions.length}/${pulseRows(board).length}`);
  check('AC8 the second pulse is at t=10m', pulseRows(board)[0].at === t0 + 600000, String(pulseRows(board)[0].at - t0));

  // Kill the host: the persisted board survives, live agent sessions do not.
  await app1.dispose();
  const app2 = await makeApp({ stateDir, root, scheduler });
  const restored = await app2.state();
  check('AC8 after restart the enabled board is scheduled again', Number.isFinite((await app2.status()).json.value.nextTickAt), String((await app2.status()).json.value.nextTickAt));
  await scheduler.advance(300000);
  await settle();
  board = await readBoard(stateDir);
  const pulsesAfterRestart = pulseRows(board);
  check('AC8 timeline t=15m runs the recovery pulse', pulsesAfterRestart.length === 3, String(pulsesAfterRestart.length));
  check('AC8 the recovery pulse is the third dispatch', pulsesAfterRestart[0].at === t0 + 900000, String(pulsesAfterRestart[0].at - t0));
  check('AC8 exactly one new session is created after restart', app2.createdSessions.length === 1, String(app2.createdSessions.length));
  check('AC8 the abandoned review execution is recovered', ticketOf(board, reviewTicket.id)?.execution?.sessionId === app2.createdSessions[0], brief(ticketOf(board, reviewTicket.id)?.execution));
  check('AC8 the recovered execution is live and running', ticketOf(board, reviewTicket.id)?.execution?.status === 'running', ticketOf(board, reviewTicket.id)?.execution?.status);
  check('AC8 zero duplicate live sessions for the ticket', [...app2.live.keys()].filter((id) => id === ticketOf(board, reviewTicket.id)?.execution?.sessionId).length === 1 && app2.live.size === 1, [...app2.live.keys()]);
  check('AC8 the old dead session is not revived', ticketOf(board, reviewTicket.id)?.execution?.sessionId !== sessionOne, brief({ newSession: ticketOf(board, reviewTicket.id)?.execution?.sessionId, sessionOne }));
  // Evidence capture for the ticket: the fake-clock restart timeline.
  console.log('[capture] restart timeline:', JSON.stringify({
    t0,
    pulses: [...pulsesAfterRestart].reverse().map((entry) => ({
      id: entry.id,
      offsetMs: entry.at - t0,
      trigger: entry.trigger,
      dispatched: entry.dispatched.map((row) => row.ticketId),
      error: entry.error,
    })),
    newSessionsAfterRestart: app2.createdSessions.length,
    liveSessions: [...app2.live.keys()],
  }));
  const recoveryPulse = pulsesAfterRestart[0];
  check('AC8 the recovery dispatch is recorded on the pulse', recoveryPulse.dispatched.length === 1 && recoveryPulse.decisions.some((entry) => entry.reason === 'admitted'), brief(recoveryPulse.decisions));
  // One more tick must not duplicate the recovered work.
  await scheduler.advance(300000);
  await settle();
  check('AC8 the next pulse dispatches no duplicate session', app2.createdSessions.length === 1, String(app2.createdSessions.length));
  await app2.dispose();
}

// ===========================================================================
// AC 9 — autopilot off
// ===========================================================================
section('AC 9 — switching autopilot off');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true });
  await createTicket(app, { title: 'Running when switched off', column: 'ready', role: 'be-developer' });
  await app.pulseNow();
  const session = app.createdSessions[0];
  const disabled = await app.configure({ enabled: false });
  check('AC9 disabling autopilot returns 200', disabled.status === 200, String(disabled.status));
  check('AC9 disabling clears the workspace timer immediately', scheduler.pending().length === 0, brief(scheduler.pending()));
  const status = await app.status();
  check('AC9 a disabled board has no next tick', status.json.value.nextTickAt === null, String(status.json.value.nextTickAt));
  let board = await readBoard(stateDir);
  const disabledActivity = board.activity.find((entry) => entry.kind === 'autopilot/disabled');
  check('AC9 the activity records autopilot/disabled with actor and timestamp', Boolean(disabledActivity) && disabledActivity.by === 'You' && Number.isFinite(disabledActivity.at), brief(disabledActivity));
  await scheduler.advance(30 * 60 * 1000);
  await settle();
  board = await readBoard(stateDir);
  check('AC9 no pulse is written after autopilot is switched off', pulseRows(board).length === 1, String(pulseRows(board).length));
  check('AC9 no new session is dispatched after the switch', app.createdSessions.length === 1, String(app.createdSessions.length));
  check('AC9 running sessions are left untouched', app.live.has(session) && ticketOf(board, 'KB-1')?.execution?.status === 'running', brief(ticketOf(board, 'KB-1')?.execution));
  await app.dispose();
}

// ===========================================================================
// AC 10 — debug output shows nextTickAt and the last pulse
// ===========================================================================
section('AC 10 — debug transcript exposes the scheduler state');
{
  const agentTeams = {
    tryMembership() {
      return { name: 'Debug Lead', role: 'lead', root: { id: 'root-session' } };
    },
  };
  const { app, stateDir } = await freshApp({ agentTeams });
  const tools = app.tools;
  check('AC10 the kanban tool is registered', Boolean(tools.get('kanban')), String(tools.size));
  await app.configure({ enabled: true });
  await createTicket(app, { title: 'Debuggable dispatch', column: 'ready', role: 'be-developer' });
  const manual = await app.pulseNow();
  const pulse = manual.json.value.pulse;
  // A live session that Agent Teams identifies as the lead can call `debug`.
  app.live.set('lead-session', { id: 'lead-session', status: 'idle', inbox: { hasPending: false } });
  const tool = tools.get('kanban');
  const result = JSON.parse(JSON.stringify(await tool.execute({ action: 'debug' }, { agent: { id: 'lead-session' } })));
  check('AC10 debug returns the autopilot runtime block', Boolean(result.autopilot), brief(Object.keys(result)));
  check('AC10 debug shows nextTickAt', Number.isFinite(result.autopilot.nextTickAt), String(result.autopilot.nextTickAt));
  check('AC10 debug shows the last pulse', result.autopilot.lastPulse?.id === pulse.id && result.autopilot.lastPulse?.trigger === 'manual', brief(result.autopilot.lastPulse?.id));
  check('AC10 debug shows the failure streak and overlap flag', result.autopilot.consecutiveErrors === 0 && result.autopilot.pulseInFlight === false, brief(result.autopilot));
  const status = await app.status();
  check('AC10 debug nextTickAt matches the status action', result.autopilot.nextTickAt === status.json.value.nextTickAt, brief({ debug: result.autopilot.nextTickAt, status: status.json.value.nextTickAt }));
  await app.dispose();
}

// ===========================================================================
// KB-82 — the persisted reason vocabulary is the exported reason vocabulary
// ===========================================================================
section('KB-82 — every persisted decision reason is in AUTOPILOT_REASON_CODES');
{
  // AC 1: the export is the docs/AUTOPILOT.md §5.6 table plus the shipped
  // `loop-guard` code, with no duplicate entries.
  const documentedReasonCodes = [
    'board-paused',
    'disabled',
    'epic',
    'blocked',
    'active-execution',
    'lane-cap',
    'wip-limit',
    'ready-depth',
    'no-member',
    'member-busy',
    'member-paused',
    'stale-execution',
    'postcondition-failed',
    'budget-exhausted',
    'admitted',
    'no-work',
    'pulse-cap',
    'loop-guard',
  ];
  const sorted = (values) => [...values].sort();
  check(
    'KB-82 AC1 the reason export is the §5.6 table plus loop-guard (18 codes)',
    same(sorted(AUTOPILOT_REASON_CODES), sorted(documentedReasonCodes)),
    brief(AUTOPILOT_REASON_CODES),
  );
  check(
    'KB-82 AC1 no-work appears in the export exactly once',
    AUTOPILOT_REASON_CODES.filter((code) => code === 'no-work').length === 1,
    brief(AUTOPILOT_REASON_CODES.filter((code) => code === 'no-work')),
  );
  check(
    'KB-82 AC1 the reason export has no duplicates',
    new Set(AUTOPILOT_REASON_CODES).size === AUTOPILOT_REASON_CODES.length,
    `${new Set(AUTOPILOT_REASON_CODES).size}/${AUTOPILOT_REASON_CODES.length}`,
  );
  // AC 2: the heartbeat widens the reason export only; the planner skip list is
  // frozen at exactly 16 codes and never emits `no-work`.
  check(
    'KB-82 AC2 the frozen 16-code skip list still excludes no-work',
    AUTOPILOT_SKIP_CODES.length === 16 && !AUTOPILOT_SKIP_CODES.includes('no-work'),
    brief(AUTOPILOT_SKIP_CODES),
  );

  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true });
  // AC 3: an enabled board with no claimable work records the no-work heartbeat.
  const heartbeatResult = await app.pulseNow();
  const heartbeatPulse = heartbeatResult.json.value.pulse;
  check(
    'KB-82 AC3 pulseNow on an idle enabled board returns 200',
    heartbeatResult.status === 200 && heartbeatResult.json.ok === true,
    String(heartbeatResult.status),
  );
  check(
    'KB-82 AC3 the pulse persists one skip row with reason no-work',
    heartbeatPulse.decisions.length === 1 &&
      heartbeatPulse.decisions[0].action === 'skip' &&
      heartbeatPulse.decisions[0].reason === 'no-work',
    brief(heartbeatPulse.decisions),
  );
  const heartbeatBoard = await readBoard(stateDir);
  check(
    'KB-82 AC3 the persisted board carries the no-work heartbeat',
    pulseRows(heartbeatBoard)[0]?.decisions?.[0]?.reason === 'no-work',
    brief(pulseRows(heartbeatBoard)[0]?.decisions),
  );
  console.log('[capture] KB-82 heartbeat pulse:', JSON.stringify(pulseRows(heartbeatBoard)[0]));

  // AC 4: a second pulse admits a claimable ticket and a third records a normal
  // skip, so every reason the board persists can be collected and validated.
  await createTicket(app, { title: 'KB-82 admission path', column: 'ready', role: 'be-developer' });
  const admission = await app.pulseNow();
  check(
    'KB-82 AC4 the admission pulse records the admitted reason',
    admission.json.value.pulse.decisions.some((entry) => entry.action === 'dispatch' && entry.reason === 'admitted'),
    brief(admission.json.value.pulse.decisions),
  );
  const followUp = await app.pulseNow();
  check(
    'KB-82 AC4 the follow-up pulse records a normal skip decision',
    followUp.json.value.pulse.decisions.some((entry) => entry.action === 'skip' && entry.reason !== 'no-work'),
    brief(followUp.json.value.pulse.decisions),
  );
  const board = await readBoard(stateDir);
  const persistedReasons = pulseRows(board).flatMap((pulse) => (pulse.decisions ?? []).map((entry) => entry.reason));
  check(
    'KB-82 AC4 every persisted decision reason is a member of AUTOPILOT_REASON_CODES',
    persistedReasons.length > 0 && persistedReasons.every((reason) => AUTOPILOT_REASON_CODES.includes(reason)),
    brief([...new Set(persistedReasons)]),
  );
  check(
    'KB-82 AC4 the collected reasons exercise the heartbeat and a normal path',
    new Set(persistedReasons).has('no-work') && persistedReasons.some((reason) => reason !== 'no-work'),
    brief([...new Set(persistedReasons)]),
  );
  await app.dispose();
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
Date.now = realDateNow;
for (const dir of dirs) {
  await rm(dir, { recursive: true, force: true });
}
console.log(`\n${failures.length === 0 ? 'ALL KB-70 EXECUTOR CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
