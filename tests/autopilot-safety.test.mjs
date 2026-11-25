/**
 * KB-75 — autopilot safety rails: dispatch budget, failure backoff, stale-run
 * recovery, loop guard and master stop.
 *
 * Dependency-free harness in the same style as `tests/autopilot-executor.test.mjs`:
 * a temporary state directory, a fake Harness ctx, and an INJECTED clock plus an
 * INJECTED scheduler. There is no wall-clock sleep anywhere in this file. Clock
 * changes that are meant to be observed only by the next explicit pulse use
 * `advanceClock` (virtual time only); `scheduler.advance` also fires due timers.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  rolling hour/day windows (defaults 20/60) persist `windowStart`, are
 *         checked by the planner AND again at dispatch, record `budget-exhausted`
 *         when exhausted, refuse a manual pulse with 429 `autopilot/budget` plus a
 *         retry-after hint, and roll correctly across a simulated hour and day
 *   AC 2  per-ticket consecutive-failure state: a thrown dispatch and a missed
 *         lane postcondition both back off, the delay doubles up to one hour, it
 *         survives a board reload, and it resets on a human move, a review verdict
 *         and a satisfied dispatch
 *   AC 3  the stale-execution watchdog cancels the session, writes the persisted
 *         `stale` marker + comment + activity + `stale-execution` decision, and
 *         recovers a staling event EXACTLY once (no loop); the ticket is
 *         re-planned once its backoff elapses
 *   AC 4  three consecutive autopilot failures park the ticket: the 4th attempt is
 *         refused, the ticket is blocked with `autopilot/loop-guard`, a comment
 *         asks the human what to do, and unblocking resets the counter
 *   AC 5  switching autopilot off / pausing the board stops every future
 *         `agents.create` while leaving running sessions alone, and records
 *         `autopilot/disabled` / `autopilot/paused` with actor + timestamp
 *   AC 6  a 24-hour fake-clock simulation with an always-failing fake agent proves
 *         dispatch count <= daily budget, backoff grows and caps, no ticket exceeds
 *         the loop guard, final columns equal the initial columns, and no unhandled
 *         rejection escapes the pulse (a summary is printed for the ticket)
 *   AC 7  failure and budget counters survive a board reload; a hand-edited counter
 *         is repaired on read to a safe value (0 attempts / reset backoff / 0 used)
 *         instead of being trusted
 *   AC 8  `node --test tests/autopilot-safety.test.mjs` passes
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

// ---------------------------------------------------------------------------
// Virtual time. `Date.now` and the injected host clock share one source so
// persisted timestamps, pulse `at` values, windows and backoff stay coherent.
// ---------------------------------------------------------------------------
const realDateNow = Date.now;
let virtualNow = 1_800_000_000_000;
Date.now = () => virtualNow;

/** Advance virtual time WITHOUT firing pending timers (explicit-pulse control). */
function advanceClock(ms) {
  virtualNow += Math.max(0, Math.round(Number(ms) || 0));
}

/**
 * Fake self-rescheduling scheduler: `setTimeout` queues a virtual handle, never a
 * sleep. `advance` fires every due callback in time order and awaits its promise.
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
    async advance(ms = 0) {
      const target = virtualNow + Math.max(0, Math.round(Number(ms) || 0));
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
const brief = (value) => String(JSON.stringify(value)).slice(0, 260);
const section = (title) => console.log(`\n## ${title}`);

/** Let the host's real async I/O run without waiting on wall-clock time. */
async function settle(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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
 * Build one host instance against `stateDir`. Each call has fresh caches, live
 * agents and routes, so a restart is a genuine new-process stand-in.
 */
async function makeApp({ stateDir, root, scheduler, workspaceId = WORKSPACE_ID }) {
  const services = {};
  const routes = new Map();
  const tools = new Map();
  const disposers = [];
  const live = new Map();
  const createdSessions = [];
  const createCalls = [];
  const prompts = [];
  const cancelCalls = [];
  let failCreate = null;
  let promptHook = null;

  const workspace = {
    id: workspaceId,
    title: 'Safety Rails Fixture',
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
        return () => {};
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
      cancel(request) {
        cancelCalls.push(request?.sessionId ?? null);
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
      set: () => {},
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
    live,
    createdSessions,
    createCalls,
    prompts,
    cancelCalls,
    workspaceId,
    stateDir,
    root,
    async state() {
      return (await http('/kanban/state', { workspaceId })).json.value;
    },
    async action(action, payload = {}) {
      return http('/kanban/action', { workspaceId, action, payload });
    },
    async pulseNow() {
      return http('/kanban/action', { workspaceId, action: 'autopilot', payload: { op: 'pulseNow' } });
    },
    async configure(patch) {
      return http('/kanban/action', { workspaceId, action: 'autopilot', payload: { op: 'configure', patch } });
    },
    async status() {
      return http('/kanban/action', { workspaceId, action: 'autopilot', payload: { op: 'status' } });
    },
    async kanbanTool(sessionId, args) {
      const tool = tools.get('kanban');
      if (!tool) throw new Error('the kanban tool is not registered');
      try {
        const value = await tool.execute(args, { agent: { id: sessionId } });
        return { ok: true, value };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const match = /kanban\/([a-z/-]+)/.exec(message);
        return { ok: false, code: match ? match[1] : null, message };
      }
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

async function freshApp() {
  const scheduler = createScheduler();
  const root = await tempDir('kanban-kb75-root-');
  const stateDir = await tempDir('kanban-kb75-state-');
  await writeFile(join(root, 'README.md'), '# KB-75 safety fixture\n', 'utf8');
  const app = await makeApp({ stateDir, root, scheduler });
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
const decisionFor = (pulse, ticketId) => (pulse?.decisions ?? []).find((entry) => entry.ticketId === ticketId) ?? null;
const decisionsWithReason = (pulse, reason) => (pulse?.decisions ?? []).filter((entry) => entry.reason === reason);

/** Mark the fake session's turn over, the way a real agent goes idle. */
function endTurn(app, sessionId) {
  const agent = app.live.get(sessionId);
  if (agent) agent.status = 'idle';
}

// ===========================================================================
// AC 1 — rolling hour/day dispatch budget, 429 refusal, window rollover
// ===========================================================================
section('AC 1 — dispatch budget: windows, planner+dispatch checks, 429, rollover');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true, budget: { hour: 2, day: 3 }, maxDispatchesPerPulse: 1 });
  // One ticket per lane, because the phase-1 lane cap allows one live session per
  // lane: review, implement and refine are three independent dispatch lanes.
  const reviewTicket = await createTicket(app, { title: 'Budget review', column: 'review', role: 'tester' });
  const readyTicket = await createTicket(app, { title: 'Budget implement', column: 'ready', role: 'be-developer' });
  const backlogTicket = await createTicket(app, { title: 'Budget refine', column: 'backlog', role: 'product-manager' });
  const t1 = virtualNow;

  const first = await app.pulseNow();
  check('AC1 the first manual pulse dispatches within budget', first.status === 200 && first.json.value.pulse.dispatched.length === 1, `${first.status} ${brief(first.json?.value?.pulse?.dispatched)}`);
  const second = await app.pulseNow();
  check('AC1 the second manual pulse dispatches within budget', second.status === 200 && second.json.value.pulse.dispatched.length === 1, `${second.status} ${brief(second.json?.value?.pulse?.dispatched)}`);
  let board = await readBoard(stateDir);
  check(
    'AC1 the hour window persists its start timestamp and the used counter',
    board.autopilot.budget.hour.windowStart === t1 && board.autopilot.budget.hour.used === 2 && board.autopilot.budget.day.used === 2,
    brief(board.autopilot.budget),
  );

  const refused = await app.pulseNow();
  check(
    'AC1 an exhausted manual pulse is refused with 429 autopilot/budget',
    refused.status === 429 && refused.json?.error?.code === 'autopilot/budget',
    `${refused.status} ${brief(refused.json?.error)}`,
  );
  check(
    'AC1 the refusal carries a retry-after hint for the hour window',
    refused.json?.error?.details?.reason === 'budget-exhausted' &&
      sameList(refused.json.error.details.windows, ['hour']) &&
      refused.json.error.details.retryAfterSeconds > 0 &&
      refused.json.error.details.retryAfterSeconds <= 3600,
    brief(refused.json?.error?.details),
  );
  board = await readBoard(stateDir);
  check('AC1 the refused pulse starts nothing and writes no pulse record', app.createdSessions.length === 2 && pulseRows(board).length === 2, `${app.createdSessions.length}/${pulseRows(board).length}`);

  // Cross the simulated hour boundary: the hour window rolls, the day window not
  // yet (day limit 3, used 2). The refine lane is still free, so one dispatch fits.
  advanceClock(3_600_001);
  const afterHour = await app.pulseNow();
  check('AC1 the hour window rolls across a simulated hour boundary', afterHour.status === 200 && afterHour.json.value.pulse.dispatched.length === 1, `${afterHour.status} ${brief(afterHour.json?.error ?? afterHour.json?.value?.pulse?.dispatched)}`);
  board = await readBoard(stateDir);
  check(
    'AC1 the rolled hour window starts a new window and increments the day window',
    board.autopilot.budget.hour.used === 1 && board.autopilot.budget.hour.windowStart === t1 + 3_600_001 && board.autopilot.budget.day.used === 3,
    brief(board.autopilot.budget),
  );
  const dayRefused = await app.pulseNow();
  check(
    'AC1 the day window refuses once its limit is reached',
    dayRefused.status === 429 && sameList(dayRefused.json?.error?.details?.windows, ['day']),
    `${dayRefused.status} ${brief(dayRefused.json?.error?.details)}`,
  );

  // While the day budget is exhausted, a manual pulse is refused (429), so use
  // the timer path to run a recorded pulse: it verifies the ended turns (freeing
  // the three lanes) while the board gate still starts nothing.
  for (const sessionId of [...app.createdSessions]) endTurn(app, sessionId);
  advanceClock(300_000);
  await scheduler.advance(0);
  await settle();
  board = await readBoard(stateDir);
  const verifyPulse = pulseRows(board)[0];
  check(
    'AC1 a budget-exhausted timer pulse still verifies ended turns but starts nothing',
    verifyPulse.dispatched.length === 0 &&
      app.createdSessions.length === 3 &&
      [reviewTicket, readyTicket, backlogTicket].every((entry) => ticketOf(board, entry.id)?.execution?.status === 'failed'),
    brief({ decisions: verifyPulse.decisions, executions: [reviewTicket, readyTicket, backlogTicket].map((entry) => ticketOf(board, entry.id)?.execution?.status) }),
  );
  check('AC1 the exhausted timer pulse records budget-exhausted', decisionsWithReason(verifyPulse, 'budget-exhausted').length >= 1, brief(verifyPulse.decisions));

  // Cross the simulated day boundary: both windows roll and a dispatch is allowed.
  advanceClock(86_400_001 - 3_900_001);
  await scheduler.advance(0);
  await settle();
  board = await readBoard(stateDir);
  const afterDayPulse = pulseRows(board)[0];
  check('AC1 the day window rolls across a simulated day boundary', afterDayPulse.dispatched.length === 1, brief({ dispatched: afterDayPulse.dispatched, decisions: afterDayPulse.decisions }));
  check(
    'AC1 the rolled day window starts at the simulated rollover and counts one dispatch',
    board.autopilot.budget.day.used === 1 && board.autopilot.budget.day.windowStart === t1 + 86_400_001 && board.autopilot.budget.hour.used === 1,
    brief(board.autopilot.budget),
  );
  check('AC1 four dispatches total after two rollovers', app.createdSessions.length === 4, String(app.createdSessions.length));
  await app.dispose();
}

/** Order-insensitive list comparison for the refusal windows. */
function sameList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

{
  // The budget is checked a second time immediately before each dispatch, so a
  // pulse plan that was computed with allowance cannot overspend it.
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, budget: { hour: 1, day: 60 }, maxDispatchesPerPulse: 2 });
  const reviewTicket = await createTicket(app, { title: 'Review under budget', column: 'review', role: 'tester' });
  const readyTicket = await createTicket(app, { title: 'Implement after the budget', column: 'ready', role: 'be-developer' });
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  const board = await readBoard(stateDir);
  check('AC1 the planner admitted two lanes but the dispatch-time check spent only one unit', app.createdSessions.length === 1, `${app.createdSessions.length} ${brief(pulse.decisions)}`);
  check('AC1 the second dispatch is refused with budget-exhausted at dispatch time', decisionsWithReason(pulse, 'budget-exhausted').length >= 1, brief(pulse.decisions));
  check(
    'AC1 the un-dispatched ticket keeps no execution row',
    ticketOf(board, readyTicket.id)?.execution == null && ticketOf(board, reviewTicket.id)?.execution != null,
    brief({ review: ticketOf(board, reviewTicket.id)?.execution, ready: ticketOf(board, readyTicket.id)?.execution }),
  );
  check('AC1 the persisted hour counter equals the limit, never above it', board.autopilot.budget.hour.used === 1, brief(board.autopilot.budget));
  await app.dispose();
}

// ===========================================================================
// AC 2 — per-ticket failure backoff: throw, postcondition miss, doubling, resets
// ===========================================================================
section('AC 2 — failure backoff: throw and postcondition miss back off, doubles, resets');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, backoffMs: 60_000 });
  const ticket = await createTicket(app, { title: 'Back off after a throw', column: 'ready', role: 'be-developer' });
  app.setFailCreate(new Error('agent factory exploded'));

  const t0 = virtualNow;
  const first = await app.pulseNow();
  let board = await readBoard(stateDir);
  let row = ticketOf(board, ticket.id);
  check('AC2 a thrown dispatch is one consecutive failure', row?.autopilot?.attempts === 1 && row?.autopilot?.lastOutcome === 'dispatch-failed', brief(row?.autopilot));
  check('AC2 the first backoff is backoffMs', row?.autopilot?.backoffUntil === t0 + 60_000, brief(row?.autopilot));
  check('AC2 the failure is persisted with the ticket', board.tickets.some((entry) => entry.id === ticket.id && entry.autopilot?.attempts === 1), brief(row?.autopilot));

  const inside = await app.pulseNow();
  board = await readBoard(stateDir);
  check(
    'AC2 the ticket is not selected inside its backoff window',
    app.createCalls.length === 1 && decisionFor(inside.json?.value?.pulse, ticket.id)?.reason === 'postcondition-failed',
    `${app.createCalls.length} ${brief(decisionFor(inside.json?.value?.pulse, ticket.id))}`,
  );

  advanceClock(60_001);
  const second = await app.pulseNow();
  board = await readBoard(stateDir);
  row = ticketOf(board, ticket.id);
  check('AC2 the delayed retry doubles the backoff after the second failure', row?.autopilot?.attempts === 2 && row.autopilot.backoffUntil - row.autopilot.lastFailureAt === 120_000, brief(row?.autopilot));
  check('AC2 the second attempt actually reached the session factory', app.createCalls.length === 2, String(app.createCalls.length));
  check('AC2 the retried pulse is still recorded', second.status === 200, `${second.status}`);

  // A satisfied dispatch is the success signal. Seed the implement postcondition
  // (the fake agent's turn ended with the ticket in Review) and verify it.
  app.setFailCreate(null);
  advanceClock(120_001);
  const dispatched = await app.pulseNow();
  board = await readBoard(stateDir);
  row = ticketOf(board, ticket.id);
  const sessionId = dispatched.json.value.pulse.dispatched[0]?.sessionId;
  check('AC2 the ticket is dispatched again once the doubled backoff elapsed', Boolean(sessionId) && row?.execution?.status === 'running', brief(row?.execution));
  await patchBoardOnDisk(stateDir, (disk) => {
    const target = ticketOf(disk, ticket.id);
    if (target) {
      target.column = 'review';
      target.movedAt = virtualNow;
    }
  });
  endTurn(app, sessionId);
  advanceClock(1_000);
  const verified = await app.pulseNow();
  board = await readBoard(stateDir);
  row = ticketOf(board, ticket.id);
  check('AC2 a satisfied dispatch resets the failure counter and backoff', row?.autopilot?.attempts === 0 && row?.autopilot?.backoffUntil === 0, brief(row?.autopilot));
  check('AC2 the reset is recorded on the ticket activity', (row?.activity ?? []).some((entry) => entry.action === 'tracking-reset'), brief((row?.activity ?? []).slice(-3)));
  check('AC2 the satisfied outcome was verified by the pulse', (verified.json?.value?.pulse?.outcomes ?? []).some((outcome) => outcome.ticketId === ticket.id && outcome.outcome === 'satisfied'), brief(verified.json?.value?.pulse?.outcomes));
  await app.dispose();
}

{
  // A human move resets the counter immediately, even while the backoff is set.
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, backoffMs: 60_000 });
  const ticket = await createTicket(app, { title: 'Human move resets', column: 'ready', role: 'be-developer' });
  app.setFailCreate(new Error('agent factory exploded'));
  await app.pulseNow();
  let board = await readBoard(stateDir);
  check('AC2 the throw armed the counter before the human move', ticketOf(board, ticket.id)?.autopilot?.attempts === 1, brief(ticketOf(board, ticket.id)?.autopilot));
  const moved = await app.action('moveTicket', { ticketId: ticket.id, column: 'backlog' });
  board = await readBoard(stateDir);
  check(
    'AC2 a human move resets the failure counter and the backoff',
    moved.status === 200 && ticketOf(board, ticket.id)?.autopilot?.attempts === 0 && ticketOf(board, ticket.id)?.autopilot?.backoffUntil === 0,
    `${moved.status} ${brief(ticketOf(board, ticket.id)?.autopilot)}`,
  );
  await app.dispose();
}

{
  // A new review verdict resets the counter even while the ticket stays in Review.
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, backoffMs: 60_000, laneCaps: { refine: 0, implement: 0, review: 1 } });
  const description = ['## Outcome', 'A review verdict resets the autopilot failure counter.', '', '## Acceptance criteria', '1. The verdict is persisted and resets the counter.'].join('\n');
  const ticket = await createTicket(app, { title: 'Verdict resets', description, column: 'review', role: 'tester' });
  const dispatch = await app.pulseNow();
  const sessionId = dispatch.json.value.pulse.dispatched[0]?.sessionId;
  endTurn(app, sessionId);
  advanceClock(1_000);
  const miss = await app.pulseNow();
  let board = await readBoard(stateDir);
  check('AC2 a review without a verdict records one consecutive failure', ticketOf(board, ticket.id)?.autopilot?.attempts === 1, brief(ticketOf(board, ticket.id)?.autopilot));
  check('AC2 the missed review is recorded on the pulse', (miss.json?.value?.pulse?.outcomes ?? []).some((outcome) => outcome.ticketId === ticket.id && outcome.outcome === 'postcondition-failed'), brief(miss.json?.value?.pulse?.outcomes));
  const verdict = await app.kanbanTool(sessionId, {
    action: 'review',
    ticketId: ticket.id,
    verdict: 'changes-requested',
    notes: 'The verifier needs another pass before this can land.',
    criteria: [{ ref: '1', passed: false, note: 'not verified yet' }],
  });
  board = await readBoard(stateDir);
  check('AC2 the review verdict was accepted', verdict.ok === true, brief(verdict));
  check(
    'AC2 a new review verdict resets the failure counter and the backoff',
    ticketOf(board, ticket.id)?.autopilot?.attempts === 0 && ticketOf(board, ticket.id)?.autopilot?.backoffUntil === 0,
    brief(ticketOf(board, ticket.id)?.autopilot),
  );
  await app.dispose();
}

// ===========================================================================
// AC 3 — stale-run recovery: cancel once, stale marker, re-plan exactly once
// ===========================================================================
section('AC 3 — stale execution: cancel, marker, one recovery per staling event');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true });
  const ticket = await createTicket(app, { title: 'Dies mid-run', column: 'ready', role: 'be-developer' });
  const dispatch = await app.pulseNow();
  const sessionId = dispatch.json.value.pulse.dispatched[0]?.sessionId;
  check('AC3 the fixture starts one running execution', Boolean(sessionId) && ticketOf(await readBoard(stateDir), ticket.id)?.execution?.status === 'running', brief(ticketOf(await readBoard(stateDir), ticket.id)?.execution));

  // The host dies with the session: the live agent is absent and the persisted
  // execution row stays `running`.
  app.live.delete(sessionId);
  advanceClock(11 * 60 * 1000);
  const before = ticketOf(await readBoard(stateDir), ticket.id);
  const recovery = await app.pulseNow();
  const pulse = recovery.json.value.pulse;
  const board = await readBoard(stateDir);
  const after = ticketOf(board, ticket.id);
  check('AC3 the stale execution is closed with a persisted stale marker', after?.execution?.status === 'failed' && after?.execution?.stale?.sessionId === sessionId, brief(after?.execution));
  check('AC3 the cancellation was issued exactly once', app.cancelCalls.filter((id) => id === sessionId).length === 1, brief(app.cancelCalls));
  check('AC3 the pulse records the stale-execution decision', decisionsWithReason(pulse, 'stale-execution').some((entry) => entry.ticketId === ticket.id), brief(pulse.decisions));
  check('AC3 the ticket carries one stale-execution comment', (after?.comments ?? []).filter((comment) => comment.author === 'autopilot' && String(comment.text).startsWith('[autopilot stale-execution]')).length === 1, brief((after?.comments ?? []).slice(-2)));
  check('AC3 board activity records autopilot/stale', activityKinds(board).includes('autopilot/stale'), brief(activityKinds(board).slice(0, 5)));
  check('AC3 the stale event is one consecutive failure with a backoff', after?.autopilot?.attempts === 1 && after.autopilot.lastOutcome === 'stale' && after.autopilot.backoffUntil - after.autopilot.lastFailureAt === 300_000, brief(after?.autopilot));
  console.log(
    '[capture] stale fixture before → after:',
    JSON.stringify({
      before: { status: before?.execution?.status, stale: before?.execution?.stale ?? null, liveAgent: app.live.has(sessionId) },
      after: { status: after?.execution?.status, stale: after?.execution?.stale, error: after?.execution?.error },
      decision: decisionFor(pulse, ticket.id),
    }),
  );

  // Same staling event, one tick later: no second cancel, comment or counter.
  const repeat = await app.pulseNow();
  const boardRepeat = await readBoard(stateDir);
  const repeatTicket = ticketOf(boardRepeat, ticket.id);
  check('AC3 a second pulse does not recover the same staling event again', app.cancelCalls.filter((id) => id === sessionId).length === 1, brief(app.cancelCalls));
  check('AC3 the stale comment is not duplicated', (repeatTicket?.comments ?? []).filter((comment) => String(comment.text).startsWith('[autopilot stale-execution]')).length === 1, brief((repeatTicket?.comments ?? []).length));
  check('AC3 the failure counter is unchanged by the repeat pulse', repeatTicket?.autopilot?.attempts === 1, brief(repeatTicket?.autopilot));
  check('AC3 the repeat pulse reports the cooldown reason', decisionFor(repeat.json?.value?.pulse, ticket.id)?.reason === 'postcondition-failed', brief(decisionFor(repeat.json?.value?.pulse, ticket.id)));

  // After the backoff the ticket is re-planned exactly once.
  advanceClock(300_001);
  const replanned = await app.pulseNow();
  const boardReplanned = await readBoard(stateDir);
  check(
    'AC3 the ticket is re-planned once the stale backoff elapsed',
    replanned.json.value.pulse.dispatched.some((row) => row.ticketId === ticket.id) && ticketOf(boardReplanned, ticket.id)?.execution?.sessionId !== sessionId,
    brief({ dispatched: replanned.json?.value?.pulse?.dispatched, execution: ticketOf(boardReplanned, ticket.id)?.execution }),
  );
  await app.dispose();
}

// Review round 1 (AC 3): the live agent decides staleness. A session whose agent
// is still `running` is working even when its persisted row has been silent past
// staleMs, so it is never recovered or cancelled; a session whose live agent is
// present but `idle` (or absent) is recovered once after the same window. Both
// fixtures patch a `running`/`idle` execution row directly so the no-progress
// clock can predate the pulse without a real wait.
const staleExecutionFixture = (silentSince) => ({
  role: 'be-developer',
  accessMode: 'workspace-write',
  startColumn: 'ready',
  startedAt: silentSince,
  updatedAt: silentSince,
  finishedAt: null,
  report: '',
  error: '',
  origin: 'autopilot',
  blocked: null,
});

{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true });
  const ticket = await createTicket(app, { title: 'Live running agent is not stale', column: 'ready', role: 'be-developer' });
  const sessionId = 'session-live-running-kb75';
  app.live.set(sessionId, { id: sessionId, status: 'running', inbox: { hasPending: false } });
  const silentSince = virtualNow - 11 * 60 * 1000;
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticket.id);
    target.activity = [];
    target.updatedAt = silentSince;
    target.movedAt = silentSince;
    target.execution = { sessionId, status: 'running', ...staleExecutionFixture(silentSince) };
  });
  const response = await app.pulseNow();
  const board = await readBoard(stateDir);
  const after = ticketOf(board, ticket.id);
  const pulse = response.json?.value?.pulse;
  check(
    'AC3 a live running agent silent past staleMs is not stale',
    after?.execution?.status === 'running' && !after?.execution?.stale,
    brief(after?.execution),
  );
  check('AC3 a live running agent is never cancelled', app.cancelCalls.length === 0, brief(app.cancelCalls));
  check(
    'AC3 the pulse reports active-execution for a live running agent, not stale-execution',
    decisionFor(pulse, ticket.id)?.reason === 'active-execution' &&
      decisionsWithReason(pulse, 'stale-execution').length === 0,
    brief(pulse?.decisions),
  );
  check(
    'AC3 a live running agent accrues no failure, stale comment or stale activity',
    after?.autopilot == null &&
      !(after?.comments ?? []).some((comment) => String(comment.text).startsWith('[autopilot stale-execution]')) &&
      !activityKinds(board).includes('autopilot/stale'),
    brief({ autopilot: after?.autopilot, activity: activityKinds(board).slice(0, 5) }),
  );
  // The read-only dry-run preview uses the same planner, so it must make the same
  // live-agent observation instead of reporting a live session as stale.
  const preview = await app.action('autopilot', { op: 'plan' });
  const previewSkips = Array.isArray(preview.json?.value?.skips) ? preview.json.value.skips : [];
  check(
    'AC3 the dry-run planner preview reports active-execution for a live running agent',
    preview.status === 200 &&
      previewSkips.some((entry) => entry.ticketId === ticket.id && entry.reason === 'active-execution') &&
      !previewSkips.some((entry) => entry.ticketId === ticket.id && entry.reason === 'stale-execution'),
    brief(previewSkips.slice(0, 4)),
  );
  await app.dispose();
}

{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true });
  const ticket = await createTicket(app, { title: 'Live idle agent is stale', column: 'ready', role: 'be-developer' });
  const sessionId = 'session-live-idle-kb75';
  app.live.set(sessionId, { id: sessionId, status: 'idle', inbox: { hasPending: false } });
  const silentSince = virtualNow - 11 * 60 * 1000;
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticket.id);
    target.activity = [];
    target.updatedAt = silentSince;
    target.movedAt = silentSince;
    target.execution = { sessionId, status: 'idle', ...staleExecutionFixture(silentSince) };
  });
  const first = await app.pulseNow();
  const firstPulse = first.json?.value?.pulse;
  let board = await readBoard(stateDir);
  let after = ticketOf(board, ticket.id);
  check(
    'AC3 a live idle agent silent past staleMs is recovered as stale',
    after?.execution?.status === 'failed' && after?.execution?.stale?.sessionId === sessionId,
    brief(after?.execution),
  );
  check('AC3 the live idle session is cancelled exactly once', app.cancelCalls.filter((id) => id === sessionId).length === 1, brief(app.cancelCalls));
  check(
    'AC3 the live idle recovery records the stale-execution decision',
    decisionsWithReason(firstPulse, 'stale-execution').some((entry) => entry.ticketId === ticket.id),
    brief(firstPulse?.decisions),
  );
  check(
    'AC3 the live idle recovery is one consecutive failure with the stale backoff',
    after?.autopilot?.attempts === 1 &&
      after.autopilot.lastOutcome === 'stale' &&
      after.autopilot.backoffUntil - after.autopilot.lastFailureAt === 300_000,
    brief(after?.autopilot),
  );

  // Same staling event, one tick later: no second cancel, counter or activity.
  await app.pulseNow();
  board = await readBoard(stateDir);
  after = ticketOf(board, ticket.id);
  check(
    'AC3 a second pulse does not recover the live idle event again',
    app.cancelCalls.filter((id) => id === sessionId).length === 1 && after?.autopilot?.attempts === 1,
    brief({ cancels: app.cancelCalls, autopilot: after?.autopilot }),
  );
  check(
    'AC3 exactly one autopilot/stale activity is written for the live idle event',
    activityKinds(board).filter((kind) => kind === 'autopilot/stale').length === 1,
    brief(activityKinds(board).slice(0, 6)),
  );

  // The ticket is re-planned exactly once after the stale backoff.
  advanceClock(300_001);
  const replanned = await app.pulseNow();
  board = await readBoard(stateDir);
  after = ticketOf(board, ticket.id);
  check(
    'AC3 the live idle ticket is re-planned once after the stale backoff',
    replanned.json?.value?.pulse?.dispatched.some((row) => row.ticketId === ticket.id) &&
      after?.execution?.sessionId !== sessionId,
    brief({ dispatched: replanned.json?.value?.pulse?.dispatched, execution: after?.execution }),
  );
  await app.dispose();
}

// ===========================================================================
// AC 4 — loop guard parks the ticket and unblocking resets it
// ===========================================================================
section('AC 4 — loop guard: 3 failures park the ticket; a 4th attempt is refused');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true, backoffMs: 60_000 });
  const ticket = await createTicket(app, { title: 'Keeps failing', column: 'ready', role: 'be-developer' });
  app.setFailCreate(new Error('agent factory exploded'));
  await app.pulseNow();
  advanceClock(60_001);
  await app.pulseNow();
  advanceClock(120_001);
  await app.pulseNow();
  let board = await readBoard(stateDir);
  let row = ticketOf(board, ticket.id);
  check('AC4 three consecutive failures park the ticket', row?.autopilot?.attempts === 3, brief(row?.autopilot));
  check('AC4 the ticket is blocked with autopilot/loop-guard', row?.blocked === true && String(row?.blockReason).startsWith('autopilot/loop-guard'), brief({ blocked: row?.blocked, blockReason: row?.blockReason }));
  check('AC4 the loop guard leaves a comment asking the human what to do', (row?.comments ?? []).some((comment) => comment.author === 'autopilot' && String(comment.text).startsWith('[autopilot loop-guard]') && String(comment.text).includes('?')), brief((row?.comments ?? []).slice(-2)));
  check('AC4 board activity records autopilot/loop-guard with autopilot as the actor', board.activity.some((entry) => entry.kind === 'autopilot/loop-guard' && entry.by === 'autopilot' && Number.isFinite(entry.at)), brief(board.activity.filter((entry) => entry.kind === 'autopilot/loop-guard')));
  check('AC4 the parked backoff is capped at one hour', row?.autopilot && row.autopilot.backoffUntil - row.autopilot.lastFailureAt === 240_000, brief(row?.autopilot));
  console.log('[capture] loop-guard block payload:', JSON.stringify({ blocked: row?.blocked, blockReason: row?.blockReason, block: row?.block, autopilot: row?.autopilot }));

  // The 4th attempt is refused, even after the backoff would have elapsed.
  app.setFailCreate(null);
  advanceClock(3_600_001);
  const fourth = await app.pulseNow();
  board = await readBoard(stateDir);
  row = ticketOf(board, ticket.id);
  check('AC4 the 4th attempt starts no session', app.createCalls.length === 3 && row?.execution == null, `${app.createCalls.length} ${brief(row?.execution)}`);
  check(
    'AC4 the refused pulse names the park (blocked or loop-guard)',
    (fourth.json?.value?.pulse?.decisions ?? []).some((entry) => entry.ticketId === ticket.id && ['blocked', 'loop-guard'].includes(entry.reason)),
    brief((fourth.json?.value?.pulse?.decisions ?? []).slice(0, 6)),
  );

  // Persistence: the park survives a board reload, and unblocking resets it.
  await app.dispose();
  const restarted = await makeApp({ stateDir, root: app.root, scheduler });
  board = await readBoard(stateDir);
  row = ticketOf(board, ticket.id);
  check('AC7 the parked ticket and its counter survive a reload', row?.blocked === true && row?.autopilot?.attempts === 3, brief({ blocked: row?.blocked, autopilot: row?.autopilot }));
  const unblocked = await restarted.action('blockTicket', { ticketId: ticket.id, blocked: false });
  board = await readBoard(stateDir);
  row = ticketOf(board, ticket.id);
  check(
    'AC4 unblocking resets the failure counter and the backoff',
    unblocked.status === 200 && row?.blocked === false && row?.autopilot?.attempts === 0 && row?.autopilot?.backoffUntil === 0 && row?.block == null,
    `${unblocked.status} ${brief({ blocked: row?.blocked, autopilot: row?.autopilot, block: row?.block })}`,
  );
  const readmitted = await restarted.pulseNow();
  check(
    'AC4 the unblocked ticket is admitted again',
    readmitted.json?.value?.pulse?.dispatched.some((entry) => entry.ticketId === ticket.id) && restarted.createdSessions.length === 1,
    brief({ dispatched: readmitted.json?.value?.pulse?.dispatched, created: restarted.createdSessions.length }),
  );
  await restarted.dispose();
}

// ===========================================================================
// AC 5 — master stop: autopilot off and board pause stop every dispatch
// ===========================================================================
section('AC 5 — master stop: off/pause record actor + timestamp, zero further creates');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true });
  await createTicket(app, { title: 'Running when disabled', column: 'ready', role: 'be-developer' });
  const before = await app.pulseNow();
  const session = app.createdSessions[0];
  const createsBefore = app.createCalls.length;
  check('AC5 the fixture is running one session before the master stop', before.status === 200 && Boolean(session), brief({ created: app.createdSessions.length }));
  const disabled = await app.configure({ enabled: false });
  check('AC5 switching autopilot off returns 200 and clears the timer', disabled.status === 200 && scheduler.pending().length === 0, `${disabled.status} ${brief(scheduler.pending())}`);
  let board = await readBoard(stateDir);
  const disabledActivity = board.activity.find((entry) => entry.kind === 'autopilot/disabled');
  check('AC5 autopilot/disabled records the actor and timestamp', Boolean(disabledActivity) && disabledActivity.by === 'You' && Number.isFinite(disabledActivity.at), brief(disabledActivity));
  await scheduler.advance(24 * 60 * 60 * 1000);
  await settle();
  board = await readBoard(stateDir);
  check('AC5 zero further agents.create calls after the master stop', app.createCalls.length === createsBefore, `${app.createCalls.length}/${createsBefore}`);
  check('AC5 no pulse is written after the master stop', pulseRows(board).length === 1, String(pulseRows(board).length));
  check('AC5 the running session is left alone', app.live.has(session) && ticketOf(board, 'KB-1')?.execution?.status === 'running' && app.cancelCalls.length === 0, brief({ live: app.live.has(session), execution: ticketOf(board, 'KB-1')?.execution?.status, cancels: app.cancelCalls }));
  check('AC5 autopilot/paused is not recorded by an off switch', !activityKinds(board).includes('autopilot/paused'), brief(activityKinds(board).slice(0, 6)));
  await app.dispose();
}

{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true });
  await createTicket(app, { title: 'Paused mid-run', column: 'ready', role: 'be-developer' });
  await app.pulseNow();
  const createsBefore = app.createCalls.length;
  const paused = await app.action('pauseBoard');
  let board = await readBoard(stateDir);
  const pausedActivity = board.activity.find((entry) => entry.kind === 'autopilot/paused');
  const pauseAt = virtualNow;
  check('AC5 pausing the board returns 200', paused.status === 200, String(paused.status));
  check(
    'AC5 autopilot/paused records the actor and the injected-clock timestamp',
    Boolean(pausedActivity) && pausedActivity.by === 'You' && pausedActivity.at === pauseAt,
    brief({ activity: pausedActivity, pauseAt }),
  );
  check('AC5 pausing leaves the timer armed so resuming needs no human action', scheduler.pending().length === 1, brief(scheduler.pending()));
  await scheduler.advance(3 * 60 * 60 * 1000);
  await settle();
  board = await readBoard(stateDir);
  check('AC5 zero further agents.create calls while the board is paused', app.createCalls.length === createsBefore, `${app.createCalls.length}/${createsBefore}`);
  check(
    'AC5 the paused timer pulses are recorded no-ops, not dispatch pulses',
    pulseRows(board)
      .filter((pulse) => pulse.trigger === 'timer')
      .every((pulse) => pulse.dispatched.length === 0 && pulse.decisions.some((entry) => entry.reason === 'board-paused')),
    brief(pulseRows(board).map((pulse) => ({ trigger: pulse.trigger, decisions: pulse.decisions }))),
  );
  check('AC5 autopilot off state is untouched by a board pause', board.autopilot.enabled === true, brief(board.autopilot.enabled));
  console.log('[capture] master-stop activities:', JSON.stringify(board.activity.filter((entry) => entry.kind.startsWith('autopilot/') || entry.kind === 'board/pause').slice(0, 4)));
  await app.dispose();
}

// ===========================================================================
// AC 6 — 24-hour fake-clock simulation with an always-failing fake agent
// ===========================================================================
section('AC 6 — 24h fake-clock simulation: bounded spend, growing backoff, no loop');
{
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason instanceof Error ? reason.message : String(reason));
  process.on('unhandledRejection', onUnhandled);
  try {
    const { app, stateDir, scheduler } = await freshApp();
    // 20-minute base backoff: attempt 1 backs off 20m, attempt 2 40m, attempt 3 is
    // capped at the 1-hour maximum, all before the loop guard parks the ticket.
    await app.configure({ enabled: true, backoffMs: 1_200_000 });
    const tickets = [];
    for (let index = 0; index < 25; index += 1) {
      tickets.push(await createTicket(app, { title: `Simulated work ${index + 1}`, column: 'ready', role: 'be-developer' }));
    }
    const initialColumns = Object.fromEntries(tickets.map((ticket) => [ticket.id, ticket.column]));
    // The fake agent always "fails": its turn ends immediately without moving the
    // ticket, so the next pulse verifies a missed implement postcondition.
    app.setPromptHook(async (request) => {
      endTurn(app, request.sessionId);
    });
    const startAt = virtualNow;
    await scheduler.advance(24 * 60 * 60 * 1000);
    await settle();
    const board = await readBoard(stateDir);
    const dispatches = app.createdSessions.length;
    const dayLimit = board.autopilot.budget.day.limit;
    const blocked = board.tickets.filter((ticket) => ticket.blocked === true);
    const loopGuardHits = board.activity.filter((entry) => entry.kind === 'autopilot/loop-guard').length;
    const finalColumns = Object.fromEntries(board.tickets.map((ticket) => [ticket.id, ticket.column]));
    const safetyRows = board.tickets
      .filter((ticket) => ticket.autopilot && ticket.autopilot.attempts > 0)
      .map((ticket) => ({
        ticketId: ticket.id,
        attempts: ticket.autopilot.attempts,
        backoffMs: ticket.autopilot.backoffUntil - ticket.autopilot.lastFailureAt,
        lastOutcome: ticket.autopilot.lastOutcome,
        blocked: ticket.blocked === true,
      }));
    const backoffDeltas = [...new Set(safetyRows.map((row) => row.backoffMs))].sort((left, right) => left - right);
    const maxBackoff = safetyRows.reduce((max, row) => Math.max(max, row.backoffMs), 0);
    const maxAttempts = safetyRows.reduce((max, row) => Math.max(max, row.attempts), 0);
    const summary = {
      simulatedHours: 24,
      elapsedMs: virtualNow - startAt,
      pulseRingEntries: board.pulses.length,
      dispatches,
      dayLimit,
      hourLimit: board.autopilot.budget.hour.limit,
      blockedTickets: blocked.length,
      loopGuardHits,
      maxAttemptsPerTicket: maxAttempts,
      maxBackoffMs: maxBackoff,
      backoffDeltas,
      safetyRows: safetyRows.length,
      budgetUsed: { hour: board.autopilot.budget.hour.used, day: board.autopilot.budget.day.used },
      finalStates: board.tickets.reduce((counts, ticket) => {
        const key = `${ticket.column}${ticket.blocked ? '+blocked' : ''}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {}),
      unhandledRejections: unhandled.length,
    };
    console.log('[simulation summary]', JSON.stringify(summary));
    check('AC6 the simulation ran a full 24 hours of fake time', virtualNow >= startAt + 24 * 60 * 60 * 1000, String(virtualNow - startAt));
    check('AC6 dispatch count never exceeds the daily budget', dispatches <= dayLimit, `${dispatches}/${dayLimit}`);
    check('AC6 the daily budget was actually the binding limit', dispatches === dayLimit, `${dispatches}/${dayLimit}`);
    check('AC6 no ticket exceeds the loop guard', maxAttempts <= 3, String(maxAttempts));
    check('AC6 the loop guard fired and every parked ticket carries the reason', loopGuardHits > 0 && blocked.every((ticket) => String(ticket.blockReason).startsWith('autopilot/loop-guard')), brief({ loopGuardHits, blocked: blocked.map((ticket) => ticket.blockReason) }));
    check('AC6 backoff grows with each consecutive failure', backoffDeltas.includes(1_200_000) && backoffDeltas.includes(2_400_000), brief(backoffDeltas));
    check('AC6 backoff caps at one hour', maxBackoff === 3_600_000 && backoffDeltas.includes(3_600_000), brief({ maxBackoff, backoffDeltas }));
    check('AC6 every observed backoff stays within the cap', backoffDeltas.every((delta) => delta <= 3_600_000), brief(backoffDeltas));
    check('AC6 final ticket columns equal the initial columns', JSON.stringify(finalColumns) === JSON.stringify(initialColumns), brief({ initialColumns, finalColumns }));
    check('AC6 no unhandled rejection escaped the pulse', unhandled.length === 0, brief(unhandled));
    check('AC6 every persisted pulse is error-free (postcondition misses are not pulse errors)', pulseRows(board).every((pulse) => pulse.error === ''), brief(pulseRows(board).map((pulse) => pulse.error).slice(0, 4)));
    await app.dispose();
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

// ===========================================================================
// AC 7 — counters survive reload; hand-edited counters are repaired on read
// ===========================================================================
section('AC 7 — counters survive a reload; hand-edited counters are repaired, not trusted');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true, backoffMs: 60_000 });
  const reviewTicket = await createTicket(app, { title: 'Counters survive: a spent dispatch', column: 'review', role: 'tester' });
  const ticket = await createTicket(app, { title: 'Counters survive: a failed dispatch', column: 'ready', role: 'be-developer' });
  // One real (spent) dispatch first, so the budget counter persists a non-zero
  // value; then a thrown dispatch, which rolls the spend back but persists the
  // failure counter.
  const spent = await app.pulseNow();
  check('AC7 the spent dispatch consumed one budget unit', spent.json.value.pulse.dispatched.length === 1, brief(spent.json?.value?.pulse?.dispatched));
  app.setFailCreate(new Error('agent factory exploded'));
  await app.pulseNow();
  const failedAt = virtualNow;
  let board = await readBoard(stateDir);
  check(
    'AC7 the failure counter and the spent budget counter are persisted',
    ticketOf(board, ticket.id)?.autopilot?.attempts === 1 &&
      board.autopilot.budget.hour.used === 1 &&
      board.autopilot.budget.day.used === 1 &&
      board.autopilot.budget.hour.windowStart > 0 &&
      board.pulses.length === 2,
    brief({ autopilot: ticketOf(board, ticket.id)?.autopilot, budget: board.autopilot.budget }),
  );
  await app.dispose();
  const restarted = await makeApp({ stateDir, root: app.root, scheduler });
  board = await readBoard(stateDir);
  check(
    'AC7 the failure counter and backoff survive a board reload',
    ticketOf(board, ticket.id)?.autopilot?.attempts === 1 &&
      ticketOf(board, ticket.id)?.autopilot?.backoffUntil === failedAt + 60_000 &&
      ticketOf(board, ticket.id)?.autopilot?.lastOutcome === 'dispatch-failed',
    brief(ticketOf(board, ticket.id)?.autopilot),
  );
  check(
    'AC7 the budget window counters and timestamps survive a board reload',
    board.autopilot.budget.hour.used === 1 &&
      board.autopilot.budget.day.used === 1 &&
      Number.isFinite(board.autopilot.budget.hour.windowStart) &&
      board.autopilot.budget.hour.windowStart > 0,
    brief(board.autopilot.budget),
  );
  const snapshot = await restarted.state();
  const snapshotTicket = snapshot.board.tickets.find((entry) => entry.id === ticket.id);
  check('AC7 the snapshot exposes the persisted safety row', snapshotTicket?.autopilot?.attempts === 1, brief(snapshotTicket?.autopilot));
  check('AC7 the review ticket from the spent dispatch is untouched', ticketOf(board, reviewTicket.id)?.execution?.status === 'running', brief(ticketOf(board, reviewTicket.id)?.execution?.status));
  await restarted.dispose();
}

{
  // Hand-edited counters: the reader repairs them to safe values on load.
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true });
  const ticket = await createTicket(app, { title: 'Hand edited counters', column: 'ready', role: 'be-developer' });
  await app.dispose();
  // A never-failed ticket carries NO safety row at all: the additive key is
  // synthesized only when a failure happens, so a legacy board is untouched.
  const before = await readBoard(stateDir);
  check('AC7 a never-failed ticket carries no autopilot safety row', !('autopilot' in (ticketOf(before, ticket.id) ?? {})), brief(Object.keys(ticketOf(before, ticket.id) ?? {})));
  await patchBoardOnDisk(stateDir, (board) => {
    board.autopilot.budget.hour.used = -5;
    board.autopilot.budget.day.used = 999_999;
    const target = ticketOf(board, ticket.id);
    target.autopilot = {
      version: 1,
      attempts: 'lots',
      lastFailureAt: 'yesterday',
      backoffUntil: 9e15,
      lastDispatchAt: -1,
      lastOutcome: 'exploded',
      hostile: 'unknown field',
    };
  });
  const repaired = await makeApp({ stateDir, root: app.root, scheduler });
  // A load repairs and persists; read the board only after one real snapshot load.
  await repaired.state();
  const board = await readBoard(stateDir);
  const repairedTicket = ticketOf(board, ticket.id);
  check(
    'AC7 a hand-edited failure counter is repaired to the safe value (0 attempts, backoff reset)',
    repairedTicket?.autopilot?.attempts === 0 &&
      repairedTicket?.autopilot?.lastFailureAt === 0 &&
      repairedTicket?.autopilot?.backoffUntil === 0 &&
      repairedTicket?.autopilot?.lastOutcome === null &&
      !('hostile' in repairedTicket.autopilot),
    brief(repairedTicket?.autopilot),
  );
  check(
    'AC7 a hand-edited budget counter is repaired instead of trusted',
    board.autopilot.budget.hour.used === 0 && board.autopilot.budget.day.used === board.autopilot.budget.day.limit,
    brief(board.autopilot.budget),
  );
  const ticketNormalizations = board.activity.filter((entry) => entry.kind === 'autopilot/ticket-state-normalized').length;
  const configNormalizations = board.activity.filter((entry) => entry.kind === 'autopilot/config-normalized').length;
  check(
    'AC7 one hand edit records exactly one normalization activity per row',
    ticketNormalizations === 1 && configNormalizations === 1,
    brief({ ticketNormalizations, configNormalizations, activity: activityKinds(board).slice(0, 6) }),
  );
  // A repaired ticket is trusted again: it can be dispatched (0 attempts, no
  // backoff) rather than being parked by the hostile values.
  const dispatch = await repaired.pulseNow();
  check(
    'AC7 the repaired ticket is dispatchable again',
    dispatch.status === 200 && dispatch.json.value.pulse.dispatched.length === 1,
    `${dispatch.status} ${brief(dispatch.json?.value?.pulse?.decisions)}`,
  );
  await repaired.dispose();
}

{
  // Review round 1 P2 (AC 7): a row holding the *valid reset* values - attempts 0,
  // no failure timestamp, `lastOutcome: null` - is exactly what
  // `resetAutopilotTicketFailure` writes. It is not a hand edit, so a board load
  // must neither repair it nor rewrite the file. `BoardStore.save` stamps
  // `updatedAt`, so a spurious rewrite is observable as a changed board timestamp.
  const { app, stateDir, scheduler } = await freshApp();
  const ticket = await createTicket(app, { title: 'A valid reset row is not a hand edit', column: 'ready', role: 'be-developer' });
  await app.dispose();
  const resetRow = {
    version: 1,
    attempts: 0,
    lastFailureAt: 0,
    backoffUntil: 0,
    lastDispatchAt: virtualNow - 60_000,
    lastOutcome: null,
  };
  const untouchedUpdatedAt = virtualNow - 600_000;
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticket.id);
    target.autopilot = { ...resetRow };
    board.updatedAt = untouchedUpdatedAt;
  });
  const restarted = await makeApp({ stateDir, root: app.root, scheduler });
  await restarted.state();
  const board = await readBoard(stateDir);
  const row = ticketOf(board, ticket.id);
  check(
    'AC7 a valid reset safety row (lastOutcome:null) survives a load untouched',
    JSON.stringify(row?.autopilot) === JSON.stringify(resetRow),
    brief(row?.autopilot),
  );
  check(
    'AC7 a valid reset row writes no ticket-state normalization activity',
    !activityKinds(board).includes('autopilot/ticket-state-normalized'),
    brief(activityKinds(board).slice(0, 6)),
  );
  check(
    'AC7 a valid reset row does not rewrite the board file',
    board.updatedAt === untouchedUpdatedAt,
    `${board.updatedAt} vs ${untouchedUpdatedAt}`,
  );
  await restarted.dispose();
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
Date.now = realDateNow;
for (const dir of dirs) {
  await rm(dir, { recursive: true, force: true });
}
console.log(`\n${failures.length === 0 ? 'ALL KB-75 SAFETY CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
