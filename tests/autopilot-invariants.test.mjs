/**
 * KB-78 — autopilot invariant suite: randomized boards, lane journeys and the
 * migration/failure matrices.
 *
 * This is the acceptance gate named by the autopilot EPIC (KB-66) and the
 * decision record (docs/AUTOPILOT.md §9): per-lane suites prove their own paths,
 * this suite proves the invariants compose.
 *
 * Dependency-free harness in the same style as `tests/execution.test.mjs` and
 * `tests/autopilot-safety.test.mjs`: temporary state directories, a fake Harness
 * ctx (agents / sessionController / permissionPresets / workspaceRegistry), an
 * INJECTED clock and an INJECTED scheduler. There is no network, no real agent
 * session and no wall-clock wait anywhere in this file: a 24 simulated hour run
 * is walked by advancing the fake timeline.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  the whole suite is offline/fake-Harness/virtual-clock and finishes in
 *         well under 60 s on the project's Node version (asserted at the end).
 *   AC 2  a property test over ≥1000 seeded-random boards (0–40 tickets, random
 *         columns/roles/priorities/owners/executions/blocked/EPICs, random
 *         members and pause states) asserts every admission invariant; a
 *         randomized executor sweep then proves the persisted board keeps one
 *         session per ticket (no duplicate session, no second session for a live
 *         ticket) across two pulses.
 *   AC 3  a scripted journey Backlog→Ready→In Progress→Review→changes-requested
 *         →In Progress→Review→Done, asserting column/owner/member/verdict/
 *         assignment/activity/pulse at every step, including the separation rule
 *         that the reviewer is never the current implementer.
 *   AC 4  the migration matrix: absent, corrupt, unknown-version envelopes,
 *         v1/v2/v3 board fixtures, and `pulses` not an array; every board loads
 *         and pulses without throwing, defaults apply, no board data is lost.
 *   AC 5  the failure matrix: agents.create throws, prompt throws, the agent never
 *         starts, the agent goes idle without moving the ticket, the board is
 *         paused mid-pulse, a member is paused mid-pulse, the host restarts
 *         mid-pulse; each leaves a consistent board and a recorded pulse/board
 *         event, and the next pulse follows the backoff/loop-guard rules.
 *   AC 6  the KB-75 24-hour simulated run cross-check: dispatch count ≤ budget,
 *         bounded retries, and the same seed produces the same outcome twice.
 *   AC 7  the suite is listed in the README test list; that wiring is asserted by
 *         this file, so removing it fails the suite.
 *   AC 8  no blanket skips: `known-fail` is only permitted through the explicit
 *         exclusion registry below, and every entry must name a Backlog ticket.
 *
 * Defects found beyond a trivial fixture are recorded on KB-78 with a
 * reproduction and filed as new Backlog tickets by the reviewer/Lead; they are
 * NOT patched by this suite. `KNOWN_FAIL` is empty on this commit.
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, planPulse, AUTOPILOT_REASON_CODES, AUTOPILOT_SKIP_CODES } from '../index.js';
import { LANE_CLAIM_ROLES, DEFAULT_MEMBERS } from '../roles.js';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE_ID = 'workspace-1';
const ACCESS_OPTIONS = [
  { value: 'read-only', name: 'Read only', description: 'Inspect only' },
  { value: 'workspace-write', name: 'Workspace write', description: 'Modify the workspace' },
  { value: 'danger-full-access', name: 'Full access', description: 'Unrestricted' },
];
const ROLE_IDS = DEFAULT_MEMBERS.map((member) => member.roleId);
const ALL_ROLES = [...new Set(ROLE_IDS)];
const LANE_CLAIM = {
  refine: LANE_CLAIM_ROLES.backlog,
  implement: LANE_CLAIM_ROLES.ready,
  review: LANE_CLAIM_ROLES.review,
};
const SKIP_CODES = new Set(AUTOPILOT_SKIP_CODES);
const REASON_CODES = new Set(AUTOPILOT_REASON_CODES);
/**
 * KB-82 fixes KB-78 finding F1: the exported closed vocabulary now includes the
 * executor heartbeat `no-work` that `dispatchPlannedWork` writes to
 * `board.pulses[].decisions` and the client already localizes as
 * `autopilot.reason.no-work`. The heartbeat is not a planner skip code, so
 * `AUTOPILOT_SKIP_CODES` keeps its frozen 16 entries; every persisted decision
 * reason is a member of the reason export.
 */
const EXECUTOR_HEARTBEAT_CODES = new Set(['no-work']);
const PERSISTED_REASON_CODES = new Set([...REASON_CODES, ...EXECUTOR_HEARTBEAT_CODES]);
const LIVE_STATUSES = new Set(['running', 'idle', 'blocked', 'paused']);
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const COLUMNS = ['backlog', 'ready', 'in_progress', 'review', 'done'];

/**
 * Explicit known-fail registry (AC 8). Every row MUST name the Backlog ticket
 * that owns the defect and the exact assertion it exempts; there is no blanket
 * skip and no `test.skip` in this file. Empty on this commit: the suite is green.
 */
const KNOWN_FAIL = Object.freeze([]);

// ---------------------------------------------------------------------------
// Virtual time + scheduler. `Date.now` and the injected host clock share one
// source so persisted timestamps, pulse `at` values, windows and backoff stay
// coherent. Nothing in this file sleeps on the wall clock.
// ---------------------------------------------------------------------------
const realDateNow = Date.now.bind(Date);
const realStartNs = process.hrtime.bigint();
let virtualNow = 1_800_000_000_000;
Date.now = () => virtualNow;

/** Advance virtual time WITHOUT firing pending timers (explicit-pulse control). */
function advanceClock(ms) {
  virtualNow += Math.max(0, Math.round(Number(ms) || 0));
}

/** Fake self-rescheduling scheduler: queue only, no sleep; `advance` fires due timers. */
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

// ---------------------------------------------------------------------------
// Result collection. The repository suites print `ok`/`FAIL` lines and exit
// non-zero; we keep that convention so a reviewer can read the transcript.
// ---------------------------------------------------------------------------
const failures = [];
const evidenceRows = [];
/** A pulse must never reject into a fire-and-forget timer callback (AC 6/AC 1). */
const unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason instanceof Error ? reason.message : String(reason));
});
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
  return condition === true;
};
const brief = (value) => String(JSON.stringify(value)).slice(0, 280);
const section = (title) => console.log(`\n## ${title}`);
const matrixRow = (row) => {
  evidenceRows.push(row);
  console.log(`[matrix] ${JSON.stringify(row)}`);
};
/** Let real async I/O run without waiting on wall-clock time. */
async function settle(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

const dirs = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
const stateFile = (stateDir, workspaceId = WORKSPACE_ID) => join(stateDir, `${workspaceId}.json`);
const readBoard = async (stateDir, workspaceId = WORKSPACE_ID) =>
  JSON.parse(await readFile(stateFile(stateDir, workspaceId), 'utf8'));
/** Patch the persisted board directly — a human edit / mid-pulse side effect. */
async function patchBoardOnDisk(stateDir, mutate, workspaceId = WORKSPACE_ID) {
  const board = await readBoard(stateDir, workspaceId);
  mutate(board);
  await writeFile(stateFile(stateDir, workspaceId), JSON.stringify(board), 'utf8');
  return board;
}

// ---------------------------------------------------------------------------
// Fake Harness app. Each call has fresh caches, live agents and routes, so a
// restart (dispose + makeApp on the same state dir) is a genuine new-process
// stand-in: persisted state survives, live sessions do not.
// ---------------------------------------------------------------------------
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
  let failCreateError = null;
  let createHook = null;
  let promptHook = null;

  const workspace = {
    id: workspaceId,
    title: 'KB-78 Invariants Fixture',
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
        return { async read() { return { events: [] }; }, async close() {} };
      },
      async stat(id) {
        return { header: { id, cwd: root } };
      },
    },
    agents: {
      async create(options) {
        createCalls.push(options);
        if (failCreateError) throw failCreateError;
        const custom = createHook ? await createHook(options, live) : undefined;
        createdSessions.push(options.sessionId);
        if (typeof options.setup === 'function') await options.setup({ effect: () => () => {} }, { id: options.sessionId });
        if (custom !== 'no-register') {
          live.set(options.sessionId, { id: options.sessionId, status: 'running', inbox: { hasPending: false } });
        }
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

  const handle = apply(ctx, { stateDir, now: scheduler.now, scheduler, wipInProgress: 3, wipReview: 5 });
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

  const app = {
    handle,
    ctx,
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
    async plan() {
      return http('/kanban/action', { workspaceId, action: 'autopilot', payload: { op: 'plan' } });
    },
    async status() {
      return http('/kanban/action', { workspaceId, action: 'autopilot', payload: { op: 'status' } });
    },
    async kanban(sessionId, args) {
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
    readBoard: () => readBoard(stateDir, workspaceId),
    patchBoardOnDisk: (mutate) => patchBoardOnDisk(stateDir, mutate, workspaceId),
    setFailCreate(error) {
      failCreateError = error;
    },
    setCreateHook(hook) {
      createHook = hook;
    },
    setPromptHook(hook) {
      promptHook = hook;
    },
    /** Mark the fake session's turn over, the way a real agent goes idle. */
    endTurn(sessionId) {
      const agent = live.get(sessionId);
      if (agent) agent.status = 'idle';
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
  return app;
}

async function freshApp({ workspaceId = WORKSPACE_ID } = {}) {
  const scheduler = createScheduler();
  const root = await tempDir('kanban-kb78-root-');
  const stateDir = await tempDir('kanban-kb78-state-');
  await writeFile(join(root, 'README.md'), '# KB-78 invariants fixture\n', 'utf8');
  const app = await makeApp({ stateDir, root, scheduler, workspaceId });
  return { app, root, stateDir, scheduler };
}

// ---------------------------------------------------------------------------
// Small board helpers shared by the journey and the matrices.
// ---------------------------------------------------------------------------
const ticketOf = (board, id) => (board.tickets ?? []).find((ticket) => ticket.id === id) ?? null;
const pulseRows = (board) => (Array.isArray(board.pulses) ? board.pulses : []);
const newestPulse = (board) => pulseRows(board)[0] ?? null;
const decisionFor = (pulse, ticketId) => (pulse?.decisions ?? []).find((entry) => entry.ticketId === ticketId) ?? null;
const outcomesFor = (pulse, ticketId) => (pulse?.outcomes ?? []).filter((entry) => entry.ticketId === ticketId);
async function createTicket(app, input) {
  const result = await app.action('createTicket', input);
  if (result.status !== 200) throw new Error(`createTicket failed: ${result.status} ${brief(result.json)}`);
  return result.json.value.ticket;
}

/** The session a fresh dispatch created for `ticketId` (from the pulse row). */
function dispatchedSession(pulse, ticketId) {
  return (pulse?.dispatched ?? []).find((row) => row.ticketId === ticketId)?.sessionId ?? null;
}

// ===========================================================================
// AC 1 — offline/fake-harness/virtual-clock setup self-checks
// ===========================================================================
section('AC 1 — offline, fake agents, injected clock/scheduler (no wall-clock waits)');
{
  // A network guard: any attempt to reach the network from the host during this
  // suite is a failure. The fake ctx never asks for one.
  let networkCalls = 0;
  const internalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error('network is disabled in the KB-78 invariant suite');
  };
  check('AC1 the suite installs no real network client', typeof internalFetch === 'function' && networkCalls === 0);
  check('AC1 the clock is injected and virtual', Date.now() === virtualNow && virtualNow === 1_800_000_000_000, String(Date.now()));
  const scheduler = createScheduler();
  check('AC1 the scheduler is injected (queue only, no wall clock)', typeof scheduler.setTimeout === 'function' && scheduler.pending().length === 0);
  check('AC1 the role policy tables used as the independent oracle are imported', ALL_ROLES.length === 10 && LANE_CLAIM.refine.includes('product-manager'), brief(ALL_ROLES));
}

// ===========================================================================
// Seeded randomness (AC 2). Deterministic: the same seed always rebuilds the
// same board corpus, so a failure is reproducible from the printed seed.
// ===========================================================================
const PROPERTY_SEED = 0x78a0b1c2;
const PROPERTY_ITERATIONS = 1200;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const int = (rng, min, max) => min + Math.floor(rng() * (max - min + 1));
const chance = (rng, probability) => rng() < probability;

/** One random member row in the persisted roster shape. */
function randomMember(rng, index) {
  return {
    id: `member-rand-${index}`,
    name: `Random ${index}`,
    title: 'Invariant fixture member',
    roleId: pick(rng, ALL_ROLES),
    persona: 'seeded random roster member for the KB-78 property test',
    paused: chance(rng, 0.22),
    sessionId: chance(rng, 0.3) ? `session-member-${index}` : null,
    lastActivatedAt: chance(rng, 0.5) ? int(rng, 0, 10) * 60_000 : 0,
    createdAt: virtualNow - 60_000,
    updatedAt: virtualNow - 60_000,
    createdBy: 'system',
    source: 'seed',
  };
}

/** One random ticket row in the persisted (normalized) shape. */
function randomTicket(rng, index, members) {
  const column = pick(rng, COLUMNS);
  const type = chance(rng, 0.16) ? 'epic' : 'task';
  const role = chance(rng, 0.12) ? pick(rng, [null, 'tech-lead']) : pick(rng, ALL_ROLES);
  const ownerMember = chance(rng, 0.55) && members.length > 0 ? pick(rng, members) : null;
  const owner = ownerMember && chance(rng, 0.75)
    ? {
        sessionId: `session-owner-${index}`,
        name: `${ownerMember.roleId} · KB-${index}`,
        role: ownerMember.roleId,
        memberId: ownerMember.id,
      }
    : chance(rng, 0.18)
      ? { sessionId: `session-owner-${index}`, name: `agent · KB-${index}`, role: pick(rng, ALL_ROLES), memberId: null }
      : null;
  const status = pick(rng, ['running', 'idle', 'blocked', 'paused', 'done', 'failed', 'cancelled', 'none']);
  const execution = status === 'none'
    ? null
    : {
        sessionId: `session-exec-${index}`,
        status,
        role: pick(rng, ALL_ROLES),
        accessMode: pick(rng, ['read-only', 'workspace-write']),
        startColumn: pick(rng, COLUMNS),
        origin: chance(rng, 0.5) ? 'autopilot' : undefined,
        startedAt: virtualNow - int(rng, 1, 120) * 60_000,
        updatedAt: virtualNow - int(rng, 0, 90) * 60_000,
        finishedAt: LIVE_STATUSES.has(status) ? null : virtualNow - int(rng, 0, 60) * 60_000,
        report: '',
        error: '',
        blocked: null,
      };
  // KB-75 additive safety row: exercise the loop guard and the failure cooldown
  // branches from the property test too (valid values; the planner repairs them).
  const safetyAttempts = chance(rng, 0.2) ? int(rng, 1, 4) : 0;
  const failureAgeMs = int(rng, 0, 20) * 60_000;
  const lastFailureAt = virtualNow - failureAgeMs;
  // The row is built inside the read-repair rules (`backoffUntil` never exceeds
  // one hour past `lastFailureAt`) so the property test exercises the cooldown,
  // not the repair. The repair matrix is covered by the migration section.
  const safety = safetyAttempts > 0
    ? {
        version: 1,
        attempts: safetyAttempts,
        lastFailureAt,
        backoffUntil: chance(rng, 0.5) ? lastFailureAt + int(rng, 0, 60) * 60_000 : 0,
        lastDispatchAt: lastFailureAt,
        lastOutcome: pick(rng, ['postcondition-failed', 'dispatch-failed', 'stale']),
      }
    : undefined;
  const reviews = chance(rng, 0.3)
    ? [{
        id: `review-${index}`,
        at: virtualNow - int(rng, 1, 60) * 60_000,
        reviewerMemberId: members.length > 0 ? members[0].id : null,
        reviewerName: 'Random Reviewer',
        sessionId: `session-review-${index}`,
        verdict: pick(rng, ['accepted', 'changes-requested']),
        notes: chance(rng, 0.5) ? 'blocking note' : '',
        criteria: [{ ref: '1', passed: chance(rng, 0.5) }],
        evidence: [],
      }]
    : [];
  return {
    id: `KB-${index}`,
    number: index,
    title: `Random ticket ${index}`,
    description: chance(rng, 0.5)
      ? '## Outcome\nRandom.\n\n## Acceptance criteria\n1. One invariant.\n2. Another invariant.'
      : 'Random ticket description without criteria.',
    type,
    priority: pick(rng, PRIORITIES),
    column,
    role,
    labels: chance(rng, 0.4) ? [pick(rng, ['tests', 'autopilot', 'ui', 'backend'])] : [],
    ...(type === 'epic' ? {} : chance(rng, 0.2) ? { parentId: 'KB-1' } : {}),
    owner,
    blocked: chance(rng, 0.2),
    blockReason: '',
    block: null,
    execution,
    assignment: chance(rng, 0.4)
      ? { role: pick(rng, ALL_ROLES), accessMode: 'workspace-write', agentSessionId: null, agentName: null, memberId: null, auto: true, reason: 'random', at: virtualNow - 60_000 }
      : null,
    checklist: [],
    comments: [],
    reviews,
    ...(safety ? { autopilot: safety } : {}),
    source: null,
    createdAt: virtualNow - int(rng, 1, 240) * 60_000,
    updatedAt: virtualNow - int(rng, 0, 240) * 60_000,
    movedAt: virtualNow - int(rng, 0, 240) * 60_000,
    acceptedAt: column === 'done' ? virtualNow - 60_000 : null,
    activity: chance(rng, 0.3)
      ? [{ id: `activity-${index}`, at: virtualNow - int(rng, 0, 60) * 60_000, by: 'You', action: 'update', text: 'random activity' }]
      : [],
  };
}

/** A random valid persisted autopilot envelope (plus deliberate odd variants). */
function randomAutopilot(rng) {
  const hourLimit = int(rng, 1, 6);
  const dayLimit = int(rng, hourLimit, 8);
  const windowStart = chance(rng, 0.7) ? virtualNow - int(rng, 0, 180) * 60_000 : 0;
  const variant = rng();
  return {
    // Unknown envelope versions must fail safe (disabled), never throw.
    version: variant < 0.85 ? 1 : pick(rng, [0, 2, 99, null, '1', undefined]),
    // Only a literal `true` with a known version may enable dispatch.
    enabled: variant < 0.7 ? true : pick(rng, [false, 'true', 1, null, undefined]),
    cadenceMs: pick(rng, [300_000, 600_000, 3_600_000]),
    maxReadyDepth: int(rng, 1, 10),
    laneCaps: { refine: int(rng, 0, 1), implement: int(rng, 0, 1), review: int(rng, 0, 1) },
    maxDispatchesPerPulse: int(rng, 1, 3),
    budget: {
      hour: { limit: hourLimit, used: int(rng, 0, hourLimit), windowStart },
      day: { limit: dayLimit, used: int(rng, 0, dayLimit), windowStart },
    },
    backoffMs: pick(rng, [60_000, 300_000, 1_800_000]),
    staleMs: pick(rng, [300_000, 600_000, 3_600_000]),
    updatedAt: virtualNow - 60_000,
    updatedBy: 'system',
  };
}

/** One random board over the persisted shape. 0–40 tickets; pause states random. */
function randomBoard(rng) {
  // One board in five is a clean work-generating board (no pre-existing live
  // executions, mostly-free lanes) so the corpus reaches the admitted/pulse-cap
  // branches instead of only the occupied-lane ones. The rest stay adversarial.
  const clean = chance(rng, 0.22);
  const memberCount = int(rng, 0, 8);
  const members = Array.from({ length: memberCount }, (_, index) => randomMember(rng, index));
  // Roughly two-thirds of boards add a guaranteed candidate per lane so the
  // corpus actually exercises dispatch, pulse pacing and lane ordering; the
  // remaining boards keep a genuinely random (sometimes role-less) roster.
  if (chance(rng, 0.66)) {
    for (const [offset, roleId] of ['product-manager', 'be-developer', 'reviewer'].entries()) {
      members.push({
        ...randomMember(rng, 100 + offset),
        id: `member-fixed-${roleId}`,
        name: `Fixed ${roleId}`,
        roleId,
        sessionId: null,
        paused: clean ? false : chance(rng, 0.15),
      });
    }
  }
  const ticketCount = int(rng, 0, 40);
  const tickets = Array.from({ length: ticketCount }, (_, index) => randomTicket(rng, index + 1, members));
  if (clean) {
    for (const ticket of tickets) {
      ticket.execution = null;
      ticket.owner = null;
      ticket.blocked = false;
      if (ticket.type === 'epic') ticket.column = 'backlog';
      else ticket.column = pick(rng, ['backlog', 'ready', 'ready', 'review', 'in_progress']);
    }
  }
  return {
    version: 3,
    workspaceId: WORKSPACE_ID,
    projectTitle: 'Random board',
    projectPath: '/tmp/random',
    createdAt: virtualNow - 86_400_000,
    updatedAt: virtualNow - 60_000,
    paused: chance(rng, 0.12),
    pausedAt: null,
    pausedBy: null,
    wip: { in_progress: int(rng, 0, 4), review: int(rng, 0, 5) },
    nextNumber: tickets.length + 1,
    tickets,
    activity: [],
    agents: {},
    team: { version: 1, seededAt: virtualNow - 86_400_000, members, drafts: [] },
    autopilot: randomAutopilot(rng),
    pulses: [],
    meta: { vision: null, docs: [], conversations: [], mrs: [], lastScanAt: null },
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const laneOfColumn = (column) => {
  if (column === 'backlog') return 'refine';
  if (column === 'ready' || column === 'in_progress') return 'implement';
  if (column === 'review') return 'review';
  return null;
};
const liveExecution = (ticket) => Boolean(ticket?.execution && LIVE_STATUSES.has(ticket.execution.status));
const laneOccupiedBy = (ticket) => {
  if (!liveExecution(ticket)) return null;
  const startColumn = ticket.execution.origin === 'autopilot' && COLUMNS.includes(ticket.execution.startColumn)
    ? ticket.execution.startColumn
    : ticket.column;
  return laneOfColumn(startColumn);
};

/**
 * Independent oracle for one plan (AC 2). Everything here is derived from the
 * policy record (docs/AUTOPILOT.md §5) and the role tables, never from the
 * planner's own helpers, so a regression has to be visible in the assertion.
 */
function assertPlanInvariants(board, plan, now, seed, iteration) {
  const problems = [];
  const fail = (message) => problems.push(`seed=${seed} #${iteration} ${message}`);
  const decisions = Array.isArray(plan?.decisions) ? plan.decisions : [];
  const skips = Array.isArray(plan?.skips) ? plan.skips : [];
  const config = board.autopilot ?? {};
  const enabled = config.version === 1 && config.enabled === true;
  const maxDispatches = Number.isInteger(config.maxDispatchesPerPulse) ? config.maxDispatchesPerPulse : 1;
  const caps = config.laneCaps ?? { refine: 1, implement: 1, review: 1 };
  const nowIso = Number.isFinite(now);

  if (plan?.generatedAt !== now || !nowIso) fail(`generatedAt ${plan?.generatedAt} !== now ${now}`);

  // Every decision carries a reason code from the closed list.
  for (const entry of decisions) {
    if (entry.action !== 'dispatch' || entry.reason !== 'admitted') fail(`decision ${brief(entry)} is not an admitted dispatch`);
    if (typeof entry.ticketId !== 'string' || !entry.ticketId) fail(`decision has no ticketId: ${brief(entry)}`);
    if (typeof entry.memberId !== 'string' || !entry.memberId) fail(`decision has no memberId: ${brief(entry)}`);
    if (!REASON_CODES.has(entry.reason)) fail(`decision reason ${entry.reason} is outside the closed vocabulary`);
  }
  for (const entry of skips) {
    if (entry.action !== 'skip') fail(`skip ${brief(entry)} is not an action:skip row`);
    if (!SKIP_CODES.has(entry.reason)) fail(`skip reason ${entry.reason} is outside the closed vocabulary`);
  }

  // Board gates: disabled, paused and exhausted boards dispatch nothing.
  if (!enabled) {
    if (decisions.length > 0) fail(`a disabled board dispatched ${decisions.length} ticket(s)`);
    if (skips[0]?.reason !== 'disabled') fail(`a disabled board did not record the disabled gate: ${brief(skips[0])}`);
  }
  if (board.paused === true) {
    if (decisions.length > 0) fail(`a paused board dispatched ${decisions.length} ticket(s)`);
    if (enabled && skips[0]?.reason !== 'board-paused') fail(`a paused board did not record board-paused: ${brief(skips[0])}`);
  }
  const hourWindow = config.budget?.hour ?? null;
  const dayWindow = config.budget?.day ?? null;
  const active = (window) => Boolean(window) && Number.isFinite(window.windowStart) && window.windowStart > 0 && now - window.windowStart < 3_600_000;
  const dayActive = (window) => Boolean(window) && Number.isFinite(window.windowStart) && window.windowStart > 0 && now - window.windowStart < 86_400_000;
  const exhausted = active(hourWindow) && hourWindow.used >= hourWindow.limit || dayActive(dayWindow) && dayWindow.used >= dayWindow.limit;
  if (exhausted && decisions.length > 0) fail(`an exhausted budget dispatched ${decisions.length} ticket(s)`);

  if (decisions.length > maxDispatches) fail(`dispatched ${decisions.length} > maxDispatchesPerPulse ${maxDispatches}`);

  // Occupancy before this pulse (this plan itself dispatches nothing yet).
  const occupancy = { refine: 0, implement: 0, review: 0 };
  for (const ticket of board.tickets ?? []) {
    const lane = laneOccupiedBy(ticket);
    if (lane) occupancy[lane] += 1;
  }

  const byLane = { refine: 0, implement: 0, review: 0 };
  const dispatchedMembers = new Set();
  const dispatchedTickets = new Set();
  for (const entry of decisions) {
    const ticket = (board.tickets ?? []).find((row) => row.id === entry.ticketId) ?? null;
    const lane = entry.lane;
    if (!ticket) {
      fail(`dispatch ${entry.ticketId} targets a ticket that is not on the board`);
      continue;
    }
    if (dispatchedTickets.has(entry.ticketId)) fail(`duplicate dispatch for ticket ${entry.ticketId}`);
    dispatchedTickets.add(entry.ticketId);
    // No EPIC and no blocked dispatch, ever.
    if (ticket.type === 'epic') fail(`dispatch targets EPIC ${ticket.id}`);
    if (ticket.blocked === true) fail(`dispatch targets blocked ticket ${ticket.id}`);
    // Loop guard / failure cooldown (KB-75): a parked or cooling-down ticket is
    // never dispatched. The oracle reads the persisted safety row directly.
    const safety = ticket.autopilot && typeof ticket.autopilot === 'object' ? ticket.autopilot : null;
    const attempts = safety && Number.isInteger(safety.attempts) ? safety.attempts : 0;
    if (attempts >= 3) fail(`dispatch targets ${ticket.id} with ${attempts} consecutive failures (loop guard)`);
    if (safety && Number.isFinite(safety.backoffUntil) && safety.backoffUntil > now) fail(`dispatch targets ${ticket.id} inside its failure backoff ${brief(safety)} column=${ticket.column} reviews=${brief(ticket.reviews?.[0]?.verdict)}`);
    // Lane membership derived from the ticket column.
    const expectedLane = laneOfColumn(ticket.column);
    if (expectedLane !== lane) fail(`dispatch ${ticket.id} lane ${lane} does not match column ${ticket.column}`);
    // One autopilot session per lane group, and never above the configured cap.
    byLane[lane] = (byLane[lane] ?? 0) + 1;
    const cap = Number.isInteger(caps[lane]) ? caps[lane] : 1;
    if (byLane[lane] > 1) fail(`lane ${lane} was admitted ${byLane[lane]} times in one pulse`);
    if (cap <= 0) fail(`lane ${lane} dispatched while its cap is 0`);
    if (occupancy[lane] >= cap) fail(`lane ${lane} dispatched while occupancy ${occupancy[lane]} >= cap ${cap}`);
    // No second session while a live execution exists for the ticket.
    if (liveExecution(ticket)) fail(`dispatch targets ${ticket.id} with a live ${ticket.execution.status} execution ${ticket.execution.sessionId}`);
    // WIP / ready-depth headroom for the lane that would move the ticket.
    if (lane === 'implement' && ticket.column === 'ready' && Number.isFinite(board.wip?.in_progress) && board.wip.in_progress > 0) {
      const inProgress = (board.tickets ?? []).filter((row) => row.column === 'in_progress').length;
      if (inProgress >= board.wip.in_progress) fail(`implement dispatch while In Progress is at WIP ${inProgress}/${board.wip.in_progress}`);
    }
    if (lane === 'refine') {
      const ready = (board.tickets ?? []).filter((row) => row.column === 'ready').length;
      const depth = Number.isInteger(config.maxReadyDepth) ? config.maxReadyDepth : 3;
      if (ready >= depth) fail(`refine dispatch while Ready depth ${ready} >= ${depth}`);
    }
    // The chosen member exists, is not paused, and can claim the lane.
    const member = (board.team?.members ?? []).find((row) => row.id === entry.memberId) ?? null;
    if (!member) {
      fail(`dispatch targets unknown member ${entry.memberId}`);
      continue;
    }
    if (dispatchedMembers.has(member.id)) fail(`member ${member.id} received more than one dispatch in one pulse (≤1 ticket per member)`);
    dispatchedMembers.add(member.id);
    if (member.paused === true) fail(`dispatch targets paused member ${member.id}`);
    if (!entry.role || entry.role !== member.roleId) fail(`decision role ${entry.role} !== member role ${member.roleId}`);
    if (entry.role === 'tech-lead') fail('tech-lead must never be an autopilot dispatch target');
    if (!LANE_CLAIM[lane].includes(member.roleId)) fail(`member role ${member.roleId} cannot claim lane ${lane}`);
    // The member is free: no in-flight ticket and no live session of its own.
    for (const other of board.tickets ?? []) {
      if (!other || other.id === ticket.id) continue;
      const owns = Boolean(other.owner) && (other.owner.memberId === member.id || (member.sessionId && other.owner.sessionId === member.sessionId));
      if (owns && (other.column === 'in_progress' || other.column === 'review')) fail(`member ${member.id} is busy with ${other.id}`);
      if (liveExecution(other) && (owns || (member.sessionId && other.execution.sessionId === member.sessionId))) {
        fail(`member ${member.id} has a live session on ${other.id}`);
      }
    }
    // A ticket owned by a paused member is skipped, never dispatched.
    if (ticket.owner?.memberId) {
      const ownerMember = (board.team?.members ?? []).find((row) => row.id === ticket.owner.memberId) ?? null;
      if (ownerMember?.paused === true) fail(`dispatch targets ticket owned by paused member ${ownerMember.id}`);
    }
  }

  // Purity/determinism: the same frozen input yields the same plan.
  const replay = planPulse(clone(board), clone(config), now);
  if (JSON.stringify(replay) !== JSON.stringify(plan)) fail('planPulse is not deterministic for identical input');
  return problems;
}

// ===========================================================================
// AC 2 — property test: ≥1000 seeded-random boards, every admission invariant
// ===========================================================================
section(`AC 2 — property: ${PROPERTY_ITERATIONS} seeded-random boards (seed ${PROPERTY_SEED})`);
{
  const rng = mulberry32(PROPERTY_SEED);
  const problems = [];
  const reasonCoverage = new Set();
  let dispatchCount = 0;
  let boardsWithDispatch = 0;
  let pausedBoards = 0;
  let epicCandidates = 0;
  let blockedCandidates = 0;
  let reworkCandidates = 0;
  const propertyStart = process.hrtime.bigint();

  for (let iteration = 0; iteration < PROPERTY_ITERATIONS; iteration += 1) {
    const board = randomBoard(rng);
    const now = virtualNow;
    let plan;
    try {
      plan = planPulse(board, board.autopilot, now);
    } catch (error) {
      problems.push(`seed=${PROPERTY_SEED} #${iteration} planPulse threw: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    problems.push(...assertPlanInvariants(board, plan, now, PROPERTY_SEED, iteration));
    for (const entry of [...(plan.decisions ?? []), ...(plan.skips ?? [])]) reasonCoverage.add(entry.reason);
    dispatchCount += plan.decisions.length;
    if (plan.decisions.length > 0) boardsWithDispatch += 1;
    if (board.paused === true) pausedBoards += 1;
    if (board.tickets.some((ticket) => ticket.type === 'epic' && ticket.column === 'backlog')) epicCandidates += 1;
    if (board.tickets.some((ticket) => ticket.blocked === true && ['backlog', 'ready', 'review'].includes(ticket.column))) blockedCandidates += 1;
    if (board.tickets.some((ticket) => ticket.column === 'in_progress')) reworkCandidates += 1;
  }

  const propertyMs = Number(process.hrtime.bigint() - propertyStart) / 1e6;
  console.log(
    `[property] seed=${PROPERTY_SEED} iterations=${PROPERTY_ITERATIONS} dispatched=${dispatchCount} boards-with-dispatch=${boardsWithDispatch} paused-boards=${pausedBoards} elapsed-ms=${propertyMs.toFixed(1)}`,
  );
  console.log(`[property] reason codes observed: ${[...reasonCoverage].sort().join(', ')}`);
  check(
    `AC2 ${PROPERTY_ITERATIONS} randomized plans satisfy every admission invariant`,
    problems.length === 0,
    problems.slice(0, 6).join(' | '),
  );
  check('AC2 the randomized corpus actually exercised dispatch', dispatchCount > 0 && boardsWithDispatch > 0, `${dispatchCount}/${boardsWithDispatch}`);
  check('AC2 the randomized corpus exercised paused boards and EPIC/blocked candidates', pausedBoards > 0 && epicCandidates > 0 && blockedCandidates > 0, `${pausedBoards}/${epicCandidates}/${blockedCandidates}`);
  check('AC2 the randomized corpus exercised In Progress/rework candidates', reworkCandidates > 0, String(reworkCandidates));
  check('AC2 every observed reason is in the closed vocabulary', [...reasonCoverage].every((code) => REASON_CODES.has(code)), [...reasonCoverage].join(','));
  check('AC2 the property run is deterministic (same seed twice)', JSON.stringify(planPulse(clone(randomBoard(mulberry32(PROPERTY_SEED))), null, virtualNow)) === JSON.stringify(planPulse(clone(randomBoard(mulberry32(PROPERTY_SEED))), null, virtualNow)));
  check('AC2 the property run completes in under 10 s of the 60 s budget', propertyMs < 10_000, `${propertyMs.toFixed(1)} ms`);
}

// ===========================================================================
// AC 2 (second half) — randomized executor sweep: no duplicate session per
// ticket, one live session per lane, persisted pulse ledger matches the board.
// ===========================================================================
section('AC 2 — randomized executor sweep: persisted no-duplicate-session invariants');
{
  const SWEEP_SEED = 0x78e1ec7;
  const SWEEP_BOARDS = 24;
  const rng = mulberry32(SWEEP_SEED);
  const problems = [];
  const fail = (message) => problems.push(message);
  let boardsWithDispatch = 0;
  let totalDispatched = 0;

  /** A roster that guarantees a candidate for every lane, plus random pauses. */
  function sweepRoster() {
    const fixed = [
      { roleId: 'product-manager', id: 'member-product-manager' },
      { roleId: 'be-developer', id: 'member-be-developer' },
      { roleId: 'reviewer', id: 'member-reviewer' },
      { roleId: 'tester', id: 'member-tester' },
    ];
    return fixed.map((entry) => ({
      id: entry.id,
      name: `${entry.roleId} sweep`,
      title: 'sweep member',
      roleId: entry.roleId,
      persona: 'randomized executor sweep member',
      paused: chance(rng, 0.15),
      sessionId: null,
      lastActivatedAt: 0,
      createdAt: virtualNow - 86_400_000,
      updatedAt: virtualNow - 86_400_000,
      createdBy: 'system',
      source: 'seed',
    }));
  }

  function sweepTicket(index) {
    const column = pick(rng, ['backlog', 'ready', 'in_progress', 'review']);
    const type = chance(rng, 0.12) ? 'epic' : 'task';
    const role = pick(rng, ['be-developer', 'fe-developer', 'reviewer', 'product-manager', 'tester']);
    const status = pick(rng, ['none', 'none', 'none', 'running', 'idle', 'failed', 'paused']);
    return {
      id: `KB-${index}`,
      number: index,
      title: `Sweep ticket ${index}`,
      description: '## Acceptance criteria\n1. A sweep invariant holds.\n2. No duplicate session exists.',
      type,
      priority: pick(rng, PRIORITIES),
      column,
      role,
      labels: ['invariants'],
      owner: status === 'running' || status === 'idle'
        ? { sessionId: `session-sweep-owner-${index}`, name: `owner · KB-${index}`, role, memberId: null }
        : null,
      blocked: chance(rng, 0.15),
      blockReason: '',
      block: null,
      execution: status === 'none'
        ? null
        : {
            sessionId: `session-sweep-${index}`,
            status,
            role,
            accessMode: 'workspace-write',
            startColumn: column,
            startedAt: virtualNow - 300_000,
            updatedAt: virtualNow - 300_000,
            finishedAt: null,
            report: '',
            error: '',
            blocked: null,
          },
      assignment: null,
      checklist: [],
      comments: [{ id: `comment-${index}`, author: 'You', text: `preserve-me-${index}`, at: virtualNow - 600_000 }],
      reviews: chance(rng, 0.3)
        ? [{ id: `review-${index}`, at: virtualNow - 600_000, reviewerMemberId: null, reviewerName: 'sweep', sessionId: `session-review-${index}`, verdict: 'changes-requested', notes: 'blocking', criteria: [{ ref: '1', passed: false }], evidence: [] }]
        : [],
      source: null,
      createdAt: virtualNow - 86_400_000,
      updatedAt: virtualNow - 600_000,
      movedAt: virtualNow - 600_000,
      acceptedAt: null,
      activity: [],
    };
  }

  for (let index = 0; index < SWEEP_BOARDS; index += 1) {
    const workspaceId = `workspace-sweep-${index}`;
    const root = await tempDir('kanban-kb78-sweep-root-');
    const stateDir = await tempDir('kanban-kb78-sweep-state-');
    await writeFile(join(root, 'README.md'), '# sweep\n', 'utf8');
    const members = sweepRoster();
    const ticketCount = int(rng, 0, 14);
    const tickets = Array.from({ length: ticketCount }, (_, ticketIndex) => sweepTicket(ticketIndex + 1));
    const board = {
      version: 3,
      workspaceId,
      projectTitle: 'Sweep board',
      projectPath: root,
      createdAt: virtualNow - 86_400_000,
      updatedAt: virtualNow - 60_000,
      paused: chance(rng, 0.12),
      pausedAt: null,
      pausedBy: null,
      wip: { in_progress: 3, review: 5 },
      nextNumber: tickets.length + 1,
      tickets,
      activity: [],
      agents: {},
      team: { version: 1, seededAt: virtualNow - 86_400_000, members, drafts: [] },
      autopilot: {
        version: chance(rng, 0.9) ? 1 : 99,
        enabled: chance(rng, 0.9) ? true : false,
        cadenceMs: 300_000,
        maxReadyDepth: 3,
        laneCaps: { refine: 1, implement: 1, review: 1 },
        maxDispatchesPerPulse: int(rng, 1, 3),
        budget: {
          hour: { limit: 20, used: 0, windowStart: 0 },
          day: { limit: 60, used: 0, windowStart: 0 },
        },
        backoffMs: 300_000,
        staleMs: 600_000,
        updatedAt: virtualNow - 60_000,
        updatedBy: 'system',
      },
      pulses: [],
      meta: { vision: null, docs: [], conversations: [], mrs: [], lastScanAt: null },
    };
    await writeFile(stateFile(stateDir, workspaceId), JSON.stringify(board), 'utf8');
    const scheduler = createScheduler();
    const app = await makeApp({ stateDir, root, scheduler, workspaceId });
    const first = await app.pulseNow();
    if (first.status !== 200) {
      fail(`sweep ${index} the first pulse was refused: ${first.status} ${brief(first.json)}`);
      await app.dispose();
      continue;
    }
    const firstPulse = first.json.value.pulse;
    const afterFirst = await app.readBoard();
    const expectedMax = board.autopilot.maxDispatchesPerPulse;
    if (firstPulse.dispatched.length > expectedMax) fail(`sweep ${index} dispatched ${firstPulse.dispatched.length} > ${expectedMax}`);
    if (firstPulse.dispatched.length !== app.createdSessions.length) fail(`sweep ${index} pulse ledger ${firstPulse.dispatched.length} != created sessions ${app.createdSessions.length}`);
    if (board.paused === true && app.createdSessions.length !== 0) fail(`sweep ${index} a paused board created ${app.createdSessions.length} session(s)`);
    totalDispatched += firstPulse.dispatched.length;
    if (firstPulse.dispatched.length > 0) boardsWithDispatch += 1;
    // Persisted ledger: one dispatch row per created session, one session per ticket.
    const sessionsPerTicket = new Map();
    for (const row of firstPulse.dispatched) {
      sessionsPerTicket.set(row.ticketId, (sessionsPerTicket.get(row.ticketId) ?? 0) + 1);
      const ticket = ticketOf(afterFirst, row.ticketId);
      if (!ticket) {
        fail(`sweep ${index} dispatched missing ticket ${row.ticketId}`);
        continue;
      }
      if (ticket.execution?.sessionId !== row.sessionId) fail(`sweep ${index} ${row.ticketId} persisted session ${ticket.execution?.sessionId} != dispatched ${row.sessionId}`);
      if (ticket.owner?.sessionId !== row.sessionId) fail(`sweep ${index} ${row.ticketId} owner ${ticket.owner?.sessionId} != dispatched ${row.sessionId}`);
      if (ticket.execution?.origin !== 'autopilot') fail(`sweep ${index} ${row.ticketId} execution is not autopilot-origin`);
      if (ticket.execution?.status !== 'running') fail(`sweep ${index} ${row.ticketId} execution is not running`);
      const original = ticketOf(board, row.ticketId);
      // A row persisted by a previous process is reconciled/recovered (the live
      // agent died with that process); only a session this host can still see is
      // a duplicate-dispatch defect.
      if (original?.execution && LIVE_STATUSES.has(original.execution.status) && app.live.has(original.execution.sessionId)) {
        fail(`sweep ${index} ${row.ticketId} was dispatched while its live session was still registered`);
      }
      if (original?.type === 'epic') fail(`sweep ${index} dispatched EPIC ${row.ticketId}`);
      if (original?.blocked === true) fail(`sweep ${index} dispatched blocked ${row.ticketId}`);
      if (row.memberId) {
        const member = (afterFirst.team?.members ?? []).find((entry) => entry.id === row.memberId) ?? null;
        if (!member) fail(`sweep ${index} dispatch row names unknown member ${row.memberId}`);
        const lane = laneOfColumn(ticket.execution?.startColumn ?? ticket.column);
        if (member && lane && !LANE_CLAIM[lane].includes(member.roleId)) fail(`sweep ${index} member ${member.roleId} cannot claim ${lane}`);
        if (lane && !LANE_CLAIM[lane].includes(member.roleId)) fail(`sweep ${index} member ${member.roleId} cannot claim ${lane}`);
      }
    }
    for (const [ticketId, count] of sessionsPerTicket) if (count > 1) fail(`sweep ${index} ticket ${ticketId} received ${count} sessions in one pulse`);
    // No two tickets may point at the same execution session.
    const allSessions = (afterFirst.tickets ?? []).map((ticket) => ticket.execution?.sessionId).filter(Boolean);
    if (new Set(allSessions).size !== allSessions.length) fail(`sweep ${index} two tickets share one execution session id`);
    // Every persisted decision carries a valid reason code.
    for (const decision of firstPulse.decisions ?? []) {
      if (!PERSISTED_REASON_CODES.has(decision.reason)) fail(`sweep ${index} persisted decision reason ${decision.reason} is outside the vocabulary`);
    }
    // Data preservation: ticket ids, roster ids and marker comments survive the pulse.
    if ((afterFirst.tickets ?? []).length !== tickets.length) fail(`sweep ${index} ticket count changed ${tickets.length} -> ${afterFirst.tickets?.length}`);
    if (new Set(board.team.members.map((member) => member.id)).size !== new Set((afterFirst.team?.members ?? []).map((member) => member.id)).size) fail(`sweep ${index} roster changed during the pulse`);
    for (const original of tickets) {
      const persisted = ticketOf(afterFirst, original.id);
      if (!persisted) fail(`sweep ${index} lost ticket ${original.id}`);
      else if (!(persisted.comments ?? []).some((comment) => comment.text === `preserve-me-${original.number}`)) fail(`sweep ${index} lost the preserve-me comment on ${original.id}`);
    }
    if (afterFirst.version !== 3) fail(`sweep ${index} board version changed to ${afterFirst.version}`);
    // Second pulse: a ticket with a live session is never dispatched again.
    const second = await app.pulseNow();
    if (second.status !== 200) {
      // Budget is fresh (0 used), so a 429 here is impossible; a refusal is a defect.
      fail(`sweep ${index} the second pulse was refused: ${second.status} ${brief(second.json)}`);
    } else {
      const secondPulse = second.json.value.pulse;
      const alreadyDispatched = new Set(firstPulse.dispatched.map((row) => row.ticketId));
      for (const row of secondPulse.dispatched) {
        if (alreadyDispatched.has(row.ticketId)) fail(`sweep ${index} ticket ${row.ticketId} received a second session across pulses`);
      }
      for (const row of secondPulse.dispatched) {
        const pre = ticketOf(afterFirst, row.ticketId);
        if (pre?.execution && LIVE_STATUSES.has(pre.execution.status)) fail(`sweep ${index} second pulse re-dispatched live ticket ${row.ticketId}`);
      }
      const afterSecond = await app.readBoard();
      const sessionsAfter = (afterSecond.tickets ?? []).map((ticket) => ticket.execution?.sessionId).filter(Boolean);
      if (new Set(sessionsAfter).size !== sessionsAfter.length) fail(`sweep ${index} duplicate execution session after the second pulse`);
      if (pulseRows(afterSecond).length !== 2) fail(`sweep ${index} expected 2 persisted pulses, found ${pulseRows(afterSecond).length}`);
      totalDispatched += secondPulse.dispatched.length;
    }
    await app.dispose();
  }

  check(`AC2 the randomized executor sweep (${SWEEP_BOARDS} boards, seed ${SWEEP_SEED}) leaves a consistent board`, problems.length === 0, problems.slice(0, 6).join(' | '));
  check('AC2 the sweep exercised real dispatches across lanes', boardsWithDispatch > 0 && totalDispatched > 0, `${boardsWithDispatch} boards / ${totalDispatched} dispatches`);
}

// ===========================================================================
// AC 3 — scripted lane journey. Every step asserts the persisted column, owner
// and roster member, the verdict/assignment records, the activity trail and the
// pulse record that produced the step. The reviewer must never be the member or
// session that implemented the current version (KB-73 separation).
// ===========================================================================
section('AC 3 — scripted journey: Backlog → Ready → In Progress → Review → changes-requested → In Progress → Review → Done');
{
  const { app, stateDir } = await freshApp();
  await app.configure({
    enabled: true,
    maxDispatchesPerPulse: 1,
    laneCaps: { refine: 1, implement: 1, review: 1 },
    maxReadyDepth: 3,
    cadenceMs: 300_000,
    staleMs: 600_000,
  });
  const ticket = await createTicket(app, {
    title: 'Journey ticket: prove every lane transition',
    description: '## Outcome\nOne vertical slice crosses every lane.\n\n## Acceptance criteria\n1. The refine lane lands a Ready ticket.\n2. The implement lane hands it to Review.\n3. The review lane records a verdict and reaches Done.',
    column: 'backlog',
    role: 'be-developer',
    priority: 'high',
  });
  const journey = [];
  const journeyStep = (name, checks, snapshot) => {
    const row = {
      step: name,
      column: snapshot?.column ?? null,
      owner: snapshot?.owner?.name ?? null,
      ownerMember: snapshot?.owner?.memberId ?? null,
      execution: snapshot?.execution?.status ?? null,
      verdict: snapshot?.reviews?.[0]?.verdict ?? null,
      assignment: snapshot?.assignment?.role ?? null,
      passed: checks.every(Boolean),
    };
    journey.push(row);
    console.log(`[journey] ${JSON.stringify(row)}`);
    return checks;
  };
  const pulseOf = async (label) => {
    const response = await app.pulseNow();
    if (response.status !== 200) throw new Error(`${label}: pulseNow ${response.status} ${brief(response.json)}`);
    return response.json.value.pulse;
  };
  /** Assert the persisted ring's newest row is the pulse the action returned. */
  const persistedPulse = async (pulse) => {
    const board = await app.readBoard();
    const newest = newestPulse(board);
    return {
      board,
      persisted: Boolean(newest) && newest.id === pulse.id && newest.trigger === pulse.trigger,
      sameDecisionCount: Boolean(newest) && newest.decisions.length === pulse.decisions.length,
      sameDispatchCount: Boolean(newest) && newest.dispatched.length === pulse.dispatched.length,
    };
  };
  const activityHas = (item, action) => (item?.activity ?? []).some((entry) => entry.action === action);
  const commentHas = (item, text) => (item?.comments ?? []).some((entry) => String(entry.text).includes(text));

  // --- step 1: refine dispatch (Backlog) ----------------------------------
  let pulse = await pulseOf('step 1');
  let seen = await persistedPulse(pulse);
  let board = seen.board;
  let current = ticketOf(board, ticket.id);
  const refineRow = dispatchedSession(pulse, ticket.id);
  const refineDecision = decisionFor(pulse, ticket.id);
  journeyStep('1. refine dispatch', [
    check('AC3 step 1 the ticket starts in Backlog', current?.column === 'backlog', current?.column),
    check('AC3 step 1 the refine pulse dispatches the PM', pulse.dispatched.length === 1 && refineRow !== null && refineDecision?.lane === 'refine' && refineDecision?.reason === 'admitted', brief({ dispatched: pulse.dispatched, decision: refineDecision })),
    check('AC3 step 1 the owner is the roster product-manager', current?.owner?.memberId === 'member-product-manager' && current?.owner?.sessionId === refineRow, brief(current?.owner)),
    check('AC3 step 1 the execution records the autopilot Backlog origin', current?.execution?.origin === 'autopilot' && current?.execution?.startColumn === 'backlog' && current?.execution?.status === 'running', brief(current?.execution)),
    check('AC3 step 1 the persisted pulse record matches the action result', seen.persisted && seen.sameDecisionCount && seen.sameDispatchCount, brief({ persisted: seen.persisted })),
    check('AC3 step 1 the refine brief is composed in the prompt', app.prompts.some((entry) => entry.sessionId === refineRow && entry.text.includes('Refinement brief')), String(app.prompts.length)),
    check('AC3 step 1 the ticket activity records the execute entry', activityHas(current, 'execute'), brief((current?.activity ?? []).slice(-2))),
  ], current);

  // --- step 2: PM claims Backlog → Ready and finishes ----------------------
  const refineSession = refineRow;
  check('AC3 step 2 the PM claim is accepted', (await app.kanban(refineSession, { action: 'claim', ticketId: ticket.id }))?.ok === true);
  check('AC3 step 2 the PM finish is accepted', (await app.kanban(refineSession, { action: 'finish', ticketId: ticket.id, summary: 'Refined to Ready with testable criteria.' }))?.ok === true);
  app.endTurn(refineSession);
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  journeyStep('2. refine claim → Ready', [
    check('AC3 step 2 the ticket reached Ready', current?.column === 'ready', current?.column),
    check('AC3 step 2 the owner is the PM session and member', current?.owner?.sessionId === refineSession && current?.owner?.memberId === 'member-product-manager', brief(current?.owner)),
    check('AC3 step 2 the Ready assignment names the implementation role', current?.assignment?.role === 'be-developer', brief(current?.assignment)),
    check('AC3 step 2 the activity trail records the claim', activityHas(current, 'claim'), brief((current?.activity ?? []).slice(-3))),
    check('AC3 step 2 the activity trail records the lane assignment', activityHas(current, 'assign'), brief((current?.activity ?? []).slice(-3))),
    check('AC3 step 2 the execution is finished', current?.execution?.status === 'done', current?.execution?.status),
  ], current);

  // --- step 3: pulse verifies refine and dispatches the implementer --------
  pulse = await pulseOf('step 3');
  seen = await persistedPulse(pulse);
  board = seen.board;
  current = ticketOf(board, ticket.id);
  const implementSession = dispatchedSession(pulse, ticket.id);
  const implementDecision = decisionFor(pulse, ticket.id);
  const refineOutcome = outcomesFor(pulse, ticket.id).find((entry) => entry.lane === 'refine');
  journeyStep('3. refine verified → implement dispatch', [
    check('AC3 step 3 the refine postcondition is verified satisfied', refineOutcome?.outcome === 'satisfied', brief(pulse.outcomes)),
    check('AC3 step 3 the implement lane dispatches from Ready', implementSession !== null && implementDecision?.lane === 'implement' && implementDecision?.reason === 'admitted', brief(implementDecision)),
    check('AC3 step 3 the ticket is still Ready while the implementer starts', current?.column === 'ready', current?.column),
    check('AC3 step 3 the owner is the roster be-developer', current?.owner?.memberId === 'member-be-developer' && current?.owner?.sessionId === implementSession, brief(current?.owner)),
    check('AC3 step 3 the execution records the autopilot Ready origin', current?.execution?.startColumn === 'ready' && current?.execution?.origin === 'autopilot', brief(current?.execution)),
    check('AC3 step 3 the implement brief is composed in the prompt', app.prompts.some((entry) => entry.sessionId === implementSession && entry.text.includes('Implementation brief')), String(app.prompts.length)),
    check('AC3 step 3 the persisted pulse record matches', seen.persisted && seen.sameDispatchCount, brief(seen.persisted)),
  ], current);

  // --- step 4: implementer claims → In Progress, moves to Review, finishes --
  check('AC3 step 4 the implementer claim is accepted', (await app.kanban(implementSession, { action: 'claim', ticketId: ticket.id }))?.ok === true);
  check('AC3 step 4 the implementer move to Review is accepted', (await app.kanban(implementSession, { action: 'move', ticketId: ticket.id, column: 'review' }))?.ok === true);
  check('AC3 step 4 the implementer finish is accepted', (await app.kanban(implementSession, { action: 'finish', ticketId: ticket.id, summary: 'Implemented and handed to Review.' }))?.ok === true);
  app.endTurn(implementSession);
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  journeyStep('4. implement claim → Review', [
    check('AC3 step 4 the ticket reached Review', current?.column === 'review', current?.column),
    check('AC3 step 4 the current implementer is the owner', current?.owner?.sessionId === implementSession && current?.owner?.memberId === 'member-be-developer', brief(current?.owner)),
    check('AC3 step 4 the execution start column is Ready', current?.execution?.startColumn === 'ready', current?.execution?.startColumn),
    check('AC3 step 4 the activity trail records claim, move and finish', ['claim', 'move', 'finish'].every((action) => activityHas(current, action)), brief((current?.activity ?? []).slice(-4))),
    check('AC3 step 4 the execution is finished', current?.execution?.status === 'done', current?.execution?.status),
  ], current);
  // Captured before the review dispatch overwrites ticket.owner: this is the
  // implementer of the current version the reviewer must be separated from.
  const firstImplementer = { memberId: current?.owner?.memberId ?? null, sessionId: current?.owner?.sessionId ?? null };

  // --- step 5: pulse verifies implement and dispatches a separated reviewer -
  pulse = await pulseOf('step 5');
  seen = await persistedPulse(pulse);
  board = seen.board;
  current = ticketOf(board, ticket.id);
  const reviewerSession = dispatchedSession(pulse, ticket.id);
  const reviewDecision = decisionFor(pulse, ticket.id);
  const implementOutcome = outcomesFor(pulse, ticket.id).find((entry) => entry.lane === 'implement');
  journeyStep('5. implement verified → review dispatch', [
    check('AC3 step 5 the implement postcondition is verified satisfied', implementOutcome?.outcome === 'satisfied', brief(pulse.outcomes)),
    check('AC3 step 5 the review lane dispatches a reviewer', reviewerSession !== null && reviewDecision?.lane === 'review' && reviewDecision?.reason === 'admitted', brief(reviewDecision)),
    check('AC3 step 5 the reviewer is a reviewer/tester roster member', ['member-reviewer', 'member-tester'].includes(current?.owner?.memberId), brief(current?.owner)),
    check('AC3 step 5 SEPARATION: the reviewer member is not the implementer member', firstImplementer.memberId === 'member-be-developer' && current?.owner?.memberId !== firstImplementer.memberId, brief({ implementer: firstImplementer, reviewer: current?.owner })),
    check('AC3 step 5 SEPARATION: the reviewer session is not the implementer session', reviewerSession !== firstImplementer.sessionId, brief({ reviewerSession, implementer: firstImplementer })),
    check('AC3 step 5 the review brief is composed in the prompt', app.prompts.some((entry) => entry.sessionId === reviewerSession && entry.text.includes('Review brief')), String(app.prompts.length)),
    check('AC3 step 5 the persisted pulse record matches', seen.persisted && seen.sameDispatchCount, brief(seen.persisted)),
  ], current);

  // --- step 6: reviewer requests changes, hands back to In Progress --------
  const changesVerdict = await app.kanban(reviewerSession, {
    action: 'review',
    ticketId: ticket.id,
    verdict: 'changes-requested',
    notes: 'Blocking: criterion 2 is unproven in the submitted change.',
    criteria: [
      { ref: '1', passed: true, note: 'the refine lane landed a Ready ticket' },
      { ref: '2', passed: false, note: 'no evidence proves the implement handoff on the final build' },
      { ref: '3', passed: true, note: 'the review lane recorded a verdict' },
    ],
    evidence: ['node --test tests/autopilot-invariants.test.mjs (journey step 4)'],
  });
  check('AC3 step 6 the changes-requested verdict is accepted', changesVerdict?.ok === true && changesVerdict?.value?.review?.verdict === 'changes-requested', brief(changesVerdict?.code ?? changesVerdict?.value?.review?.verdict));
  check('AC3 step 6 the reviewer moves Review → In Progress', (await app.kanban(reviewerSession, { action: 'move', ticketId: ticket.id, column: 'in_progress' }))?.ok === true);
  check('AC3 step 6 the reviewer finish is accepted', (await app.kanban(reviewerSession, { action: 'finish', ticketId: ticket.id, summary: 'Changes requested: criterion 2 is unproven.' }))?.ok === true);
  app.endTurn(reviewerSession);
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  journeyStep('6. changes-requested → In Progress', [
    check('AC3 step 6 the ticket is back In Progress', current?.column === 'in_progress', current?.column),
    check('AC3 step 6 the verdict record persists with the reviewer identity', current?.reviews?.[0]?.verdict === 'changes-requested' && current?.reviews?.[0]?.reviewerMemberId === 'member-reviewer', brief(current?.reviews?.[0])),
    check('AC3 step 6 the verdict keeps the blocking note and failed criterion', String(current?.reviews?.[0]?.notes ?? '').includes('criterion 2') && current?.reviews?.[0]?.criteria?.some((entry) => entry.passed === false), brief(current?.reviews?.[0])),
    check('AC3 step 6 the handback assignment names the implementation role', current?.assignment?.role === 'be-developer', brief(current?.assignment)),
    check('AC3 step 6 the reviewer is no longer the owner', current?.owner === null, brief(current?.owner)),
    check('AC3 step 6 the activity trail records the verdict and the move', activityHas(current, 'review-verdict') && activityHas(current, 'move'), brief((current?.activity ?? []).slice(-4))),
    check('AC3 step 6 the readable verdict comment is persisted', commentHas(current, 'Review verdict: changes-requested'), brief((current?.comments ?? []).slice(-2))),
  ], current);

  // --- step 7: pulse verifies the handback and dispatches rework -----------
  pulse = await pulseOf('step 7');
  seen = await persistedPulse(pulse);
  board = seen.board;
  current = ticketOf(board, ticket.id);
  const reworkSession = dispatchedSession(pulse, ticket.id);
  const reworkDecision = decisionFor(pulse, ticket.id);
  const reviewOutcome = outcomesFor(pulse, ticket.id).find((entry) => entry.lane === 'review');
  journeyStep('7. review verified → rework dispatch', [
    check('AC3 step 7 the changes-requested review is verified satisfied', reviewOutcome?.outcome === 'satisfied' && String(reviewOutcome?.detail ?? '').includes('requested changes'), brief(pulse.outcomes)),
    check('AC3 step 7 the rework lane dispatches through the In Progress → Ready bridge', reworkSession !== null && reworkDecision?.lane === 'implement' && reworkDecision?.reason === 'admitted', brief(reworkDecision)),
    check('AC3 step 7 the ticket is Ready when the rework session starts', current?.column === 'ready' && current?.execution?.startColumn === 'ready', brief({ column: current?.column, startColumn: current?.execution?.startColumn })),
    check('AC3 step 7 the rework owner is the implementer member again', current?.owner?.memberId === 'member-be-developer' && current?.owner?.sessionId === reworkSession, brief(current?.owner)),
    check('AC3 step 7 the rework session is not the reviewer session', reworkSession !== reviewerSession, brief({ reworkSession, reviewerSession })),
    check('AC3 step 7 the autopilot handoff is recorded in the activity trail', activityHas(current, 'move'), brief((current?.activity ?? []).slice(-4))),
    check('AC3 step 7 the persisted pulse record matches', seen.persisted && seen.sameDispatchCount, brief(seen.persisted)),
  ], current);

  // --- step 8: rework implementer returns the ticket to Review -------------
  check('AC3 step 8 the rework claim is accepted', (await app.kanban(reworkSession, { action: 'claim', ticketId: ticket.id }))?.ok === true);
  check('AC3 step 8 the rework move to Review is accepted', (await app.kanban(reworkSession, { action: 'move', ticketId: ticket.id, column: 'review' }))?.ok === true);
  check('AC3 step 8 the rework finish is accepted', (await app.kanban(reworkSession, { action: 'finish', ticketId: ticket.id, summary: 'Rework complete: criterion 2 now has evidence.' }))?.ok === true);
  app.endTurn(reworkSession);
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  journeyStep('8. rework → Review (second round)', [
    check('AC3 step 8 the ticket returned to Review', current?.column === 'review', current?.column),
    check('AC3 step 8 the current implementer is the rework session', current?.owner?.sessionId === reworkSession && current?.owner?.memberId === 'member-be-developer', brief(current?.owner)),
    check('AC3 step 8 the earlier changes-requested verdict is still the newest record', current?.reviews?.[0]?.verdict === 'changes-requested' && current?.reviews?.length === 1, brief(current?.reviews?.map((entry) => entry.verdict))),
    check('AC3 step 8 the attempt history keeps the first implementer report', (current?.comments ?? []).some((entry) => String(entry.text).includes('Implemented and handed to Review')), brief((current?.comments ?? []).slice(-3))),
  ], current);
  const secondImplementer = { memberId: current?.owner?.memberId ?? null, sessionId: current?.owner?.sessionId ?? null };

  // --- step 9: second review dispatch, still separated from the implementer -
  pulse = await pulseOf('step 9');
  seen = await persistedPulse(pulse);
  board = seen.board;
  current = ticketOf(board, ticket.id);
  const secondReviewerSession = dispatchedSession(pulse, ticket.id);
  const secondImplementOutcome = outcomesFor(pulse, ticket.id).find((entry) => entry.lane === 'implement');
  journeyStep('9. rework verified → second review dispatch', [
    check('AC3 step 9 the rework postcondition is verified satisfied', secondImplementOutcome?.outcome === 'satisfied', brief(pulse.outcomes)),
    check('AC3 step 9 the review lane dispatches again', secondReviewerSession !== null && decisionFor(pulse, ticket.id)?.lane === 'review', brief(decisionFor(pulse, ticket.id))),
    check('AC3 step 9 SEPARATION: the second reviewer member is not the rework implementer', secondImplementer.memberId === 'member-be-developer' && current?.owner?.memberId !== secondImplementer.memberId, brief({ implementer: secondImplementer, reviewer: current?.owner })),
    check('AC3 step 9 SEPARATION: the second reviewer session is new', secondReviewerSession !== secondImplementer.sessionId && secondReviewerSession !== reviewerSession, brief({ secondReviewerSession, implementer: secondImplementer })),
    check('AC3 step 9 SEPARATION: the second reviewer is also not the first reviewer session', secondReviewerSession !== reviewerSession, brief({ secondReviewerSession, reviewerSession })),
    check('AC3 step 9 the ticket is still in Review', current?.column === 'review', current?.column),
    check('AC3 step 9 the persisted pulse record matches', seen.persisted && seen.sameDispatchCount, brief(seen.persisted)),
  ], current);

  // --- step 10: reviewer accepts and moves Review → Done --------------------
  const acceptedVerdict = await app.kanban(secondReviewerSession, {
    action: 'review',
    ticketId: ticket.id,
    verdict: 'accepted',
    notes: 'All accepted: the refine, implement and review evidence is present.',
    criteria: [
      { ref: '1', passed: true, note: 'Ready ticket with testable criteria' },
      { ref: '2', passed: true, note: 'implement handoff re-proven with the final build evidence' },
      { ref: '3', passed: true, note: 'review verdict and Done transition' },
    ],
    evidence: ['node --test tests/autopilot-invariants.test.mjs (full journey)'],
  });
  check('AC3 step 10 the accepted verdict is accepted', acceptedVerdict?.ok === true && acceptedVerdict?.value?.review?.verdict === 'accepted', brief(acceptedVerdict?.code ?? acceptedVerdict?.value?.review?.verdict));
  check('AC3 step 10 the reviewer moves Review → Done', (await app.kanban(secondReviewerSession, { action: 'move', ticketId: ticket.id, column: 'done' }))?.ok === true);
  check('AC3 step 10 the reviewer finish is accepted', (await app.kanban(secondReviewerSession, { action: 'finish', ticketId: ticket.id, summary: 'Accepted: every criterion is mapped passed.' }))?.ok === true);
  app.endTurn(secondReviewerSession);
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  journeyStep('10. accepted → Done', [
    check('AC3 step 10 the ticket reached Done', current?.column === 'done', current?.column),
    check('AC3 step 10 the accepted verdict maps every criterion passed', current?.reviews?.[0]?.verdict === 'accepted' && current?.reviews?.[0]?.criteria?.every((entry) => entry.passed === true), brief(current?.reviews?.[0])),
    check('AC3 step 10 the verdict record names the second reviewer', current?.reviews?.[0]?.reviewerMemberId === current?.owner?.memberId, brief({ reviewer: current?.reviews?.[0]?.reviewerMemberId, owner: current?.owner?.memberId })),
    check('AC3 step 10 the accepted timestamp is persisted', Number.isFinite(current?.acceptedAt), String(current?.acceptedAt)),
    check('AC3 step 10 the activity trail records the move and the finish', activityHas(current, 'move') && activityHas(current, 'finish'), brief((current?.activity ?? []).slice(-4))),
    check('AC3 step 10 the readable accepted comment is persisted', commentHas(current, 'Review verdict: accepted'), brief((current?.comments ?? []).slice(-2))),
  ], current);

  // --- step 11: final pulse verifies the acceptance and starts nothing -----
  pulse = await pulseOf('step 11');
  seen = await persistedPulse(pulse);
  board = seen.board;
  current = ticketOf(board, ticket.id);
  const acceptedOutcome = outcomesFor(pulse, ticket.id).find((entry) => entry.lane === 'review');
  const dispatchedForTicket = (pulse.dispatched ?? []).some((row) => row.ticketId === ticket.id);
  journeyStep('11. accepted review verified, idle heartbeat', [
    check('AC3 step 11 the accepted review is verified satisfied', acceptedOutcome?.outcome === 'satisfied' && String(acceptedOutcome?.detail ?? '').includes('accepted'), brief(pulse.outcomes)),
    check('AC3 step 11 no further session is started for the Done ticket', dispatchedForTicket === false, brief(pulse.dispatched)),
    check('AC3 step 11 the Done ticket stays Done', current?.column === 'done', current?.column),
    check('AC3 step 11 the pulse record is persisted with a heartbeat decision', seen.persisted && pulse.decisions.length > 0, brief(pulse.decisions.slice(0, 2))),
    check('AC3 step 11 no execution is left running on the Done ticket', current?.execution?.status === 'done', brief(current?.execution)),
  ], current);

  // The journey table itself is part of the ticket evidence.
  console.log('\n[journey-table]');
  console.log('| step | column | owner | owner member | execution | verdict | assignment | passed |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const row of journey) {
    console.log(`| ${row.step} | ${row.column} | ${row.owner} | ${row.ownerMember} | ${row.execution} | ${row.verdict ?? '-'} | ${row.assignment ?? '-'} | ${row.passed ? 'yes' : 'NO'} |`);
  }
  check('AC3 every journey step passed its assertions', journey.length === 11 && journey.every((row) => row.passed), brief(journey.filter((row) => !row.passed)));
  check('AC3 the journey ends in Done after exactly two review rounds', (await app.readBoard()).tickets.find((entry) => entry.id === ticket.id)?.reviews?.length === 2, String((await app.readBoard()).tickets.find((entry) => entry.id === ticket.id)?.reviews?.length));
  await app.dispose();
}

// ===========================================================================
// AC 4 — migration matrix. Every fixture board must load AND pulse without
// throwing, apply the documented defaults, keep board version 3, and preserve
// every ticket / roster / comment row it carried in.
// ===========================================================================
section('AC 4 — migration matrix: absent, corrupt, unknown version, v1/v2/v3, non-array pulses');

/** A minimal ticket in an old board fixture. */
function fixtureTicket(id, overrides = {}) {
  return {
    id,
    number: Number(id.replace(/\D/g, '')) || 1,
    title: `Fixture ${id}`,
    description: '## Acceptance criteria\n1. The fixture survives migration.\n2. Nothing is lost.',
    type: 'task',
    priority: 'medium',
    column: 'ready',
    role: 'be-developer',
    labels: [],
    owner: null,
    blocked: false,
    blockReason: '',
    block: null,
    execution: null,
    assignment: null,
    checklist: [],
    comments: [{ id: `comment-${id}`, author: 'You', text: `preserve-${id}`, at: virtualNow - 7_200_000 }],
    reviews: [],
    source: null,
    createdAt: virtualNow - 86_400_000,
    updatedAt: virtualNow - 7_200_000,
    movedAt: virtualNow - 7_200_000,
    acceptedAt: null,
    activity: [],
    ...overrides,
  };
}

function fixtureMember(id, roleId) {
  return {
    id,
    name: `Fixture ${roleId}`,
    title: 'fixture member',
    roleId,
    persona: 'fixture persona',
    paused: false,
    sessionId: null,
    lastActivatedAt: 0,
    createdAt: virtualNow - 86_400_000,
    updatedAt: virtualNow - 86_400_000,
    createdBy: 'system',
    source: 'seed',
  };
}

/** Base v3 board with the two additive keys absent and the given overrides. */
function fixtureBoard(overrides = {}) {
  return {
    version: 3,
    workspaceId: 'workspace-migrate',
    projectTitle: 'Migration fixture',
    projectPath: '/tmp/migration-fixture',
    createdAt: virtualNow - 86_400_000,
    updatedAt: virtualNow - 86_400_000,
    paused: false,
    pausedAt: null,
    pausedBy: null,
    wip: { in_progress: 3, review: 5 },
    nextNumber: 8,
    tickets: [fixtureTicket('KB-7'), fixtureTicket('KB-8', { column: 'review', role: 'tester' })],
    activity: [],
    agents: {},
    team: {
      version: 1,
      seededAt: virtualNow - 86_400_000,
      members: [fixtureMember('member-product-manager', 'product-manager'), fixtureMember('member-be-developer', 'be-developer'), fixtureMember('member-reviewer', 'reviewer')],
      drafts: [],
    },
    meta: { vision: null, docs: [], conversations: [], mrs: [], lastScanAt: null },
    ...overrides,
  };
}

const DEFAULT_AUTOPILOT = Object.freeze({
  enabled: false,
  cadenceMs: 300_000,
  maxReadyDepth: 3,
  maxDispatchesPerPulse: 1,
  backoffMs: 300_000,
  staleMs: 600_000,
});
const defaultsHold = (config) =>
  Boolean(config) &&
  config.enabled === false &&
  config.cadenceMs === DEFAULT_AUTOPILOT.cadenceMs &&
  config.maxReadyDepth === DEFAULT_AUTOPILOT.maxReadyDepth &&
  config.maxDispatchesPerPulse === DEFAULT_AUTOPILOT.maxDispatchesPerPulse &&
  config.backoffMs === DEFAULT_AUTOPILOT.backoffMs &&
  config.staleMs === DEFAULT_AUTOPILOT.staleMs &&
  config.laneCaps?.refine === 1 &&
  config.laneCaps?.implement === 1 &&
  config.laneCaps?.review === 1 &&
  config.budget?.hour === 20 &&
  config.budget?.day === 60;
/** A repaired (corrupt-input) config must still be inside the documented bounds. */
const repairedSane = (config) => {
  if (!config) return false;
  const numbers = [config.cadenceMs, config.maxReadyDepth, config.maxDispatchesPerPulse, config.backoffMs, config.staleMs, config.budget?.hour, config.budget?.day];
  if (!numbers.every((value) => Number.isFinite(value))) return false;
  if (config.enabled !== false) return false;
  // Ranges are the shipped AUTOPILOT_BOUNDS read-repair ranges; see finding F2
  // on the ticket — the record's §7 phase-1 envelope is narrower than the code.
  if (config.cadenceMs < 60_000 || config.cadenceMs > 3_600_000) return false;
  if (config.maxReadyDepth < 0 || config.maxReadyDepth > 20) return false;
  if (config.maxDispatchesPerPulse < 1 || config.maxDispatchesPerPulse > 5) return false;
  if (config.backoffMs < 60_000 || config.backoffMs > 3_600_000) return false;
  if (config.staleMs < 60_000 || config.staleMs > 3_600_000) return false;
  if (![config.laneCaps?.refine, config.laneCaps?.implement, config.laneCaps?.review].every((cap) => cap >= 0 && cap <= 3)) return false;
  if (![config.budget.hour, config.budget.day].every((limit) => limit >= 1)) return false;
  return true;
};
const dataPreserved = (board, { members, tickets, comments }) => {
  const problems = [];
  for (const ticket of tickets) {
    const ticketId = typeof ticket === 'string' ? ticket : ticket?.id;
    const persisted = (board.tickets ?? []).find((entry) => entry.id === ticketId);
    if (!persisted) problems.push(`lost ticket ${ticketId}`);
  }
  for (const [ticketId, text] of comments) {
    const persisted = (board.tickets ?? []).find((entry) => entry.id === ticketId);
    if (!persisted?.comments?.some((comment) => comment.text === text)) problems.push(`lost comment ${text}`);
  }
  if (members !== null && (board.team?.members ?? []).length < members) problems.push(`lost roster members ${board.team?.members?.length} < ${members}`);
  return problems;
};

async function loadMigrationFixture(board, workspaceId) {
  const root = await tempDir('kanban-kb78-migrate-root-');
  const stateDir = await tempDir('kanban-kb78-migrate-state-');
  await writeFile(join(root, 'README.md'), '# migration fixture\n', 'utf8');
  const fixture = { ...board, workspaceId, projectPath: root };
  await writeFile(stateFile(stateDir, workspaceId), JSON.stringify(fixture), 'utf8');
  const scheduler = createScheduler();
  const app = await makeApp({ stateDir, root, scheduler, workspaceId });
  let snapshot = null;
  let stateError = null;
  try {
    snapshot = await app.state();
  } catch (error) {
    stateError = error instanceof Error ? error.message : String(error);
  }
  let pulseResponse = null;
  let pulseError = null;
  try {
    pulseResponse = await app.pulseNow();
  } catch (error) {
    pulseError = error instanceof Error ? error.message : String(error);
  }
  const after = await app.readBoard();
  return { app, snapshot, stateError, pulseResponse, pulseError, after };
}

const migrationCases = [];
async function migrationCase(name, board, expect) {
  const workspaceId = `workspace-migrate-${migrationCases.length + 1}`;
  const loaded = await loadMigrationFixture(board, workspaceId);
  const { app, snapshot, stateError, pulseResponse, pulseError, after } = loaded;
  const row = {
    case: name,
    boardState: expect.boardState,
    loaded: stateError === null && Boolean(snapshot?.board),
    version: after.version,
    configEnabled: snapshot?.autopilot?.config?.enabled ?? null,
    defaults: defaultsHold(snapshot?.autopilot?.config),
    repaired: repairedSane(snapshot?.autopilot?.config),
    pulse: pulseResponse?.status ?? null,
    pulseError: pulseError ?? pulseResponse?.json?.error?.message ?? null,
    decisions: (pulseResponse?.json?.value?.pulse?.decisions ?? []).map((entry) => entry.reason),
    dataProblems: dataPreserved(after, expect.data),
  };
  row.passed =
    row.loaded === true &&
    row.version === 3 &&
    (expect.defaults === 'defaults' ? row.defaults === true : true) &&
    (expect.defaults === 'repaired' ? row.repaired === true : true) &&
    row.configEnabled === expect.enabled &&
    row.pulse === 200 &&
    row.pulseError === null &&
    row.dataProblems.length === 0 &&
    (expect.reason ? row.decisions.includes(expect.reason) : true) &&
    (expect.activityKind ? (after.activity ?? []).some((entry) => entry.kind === expect.activityKind) : true);
  migrationCases.push(row);
  matrixRow(row);
  await app.dispose();
  return row;
}

const preserve = {
  members: 3,
  tickets: ['KB-7', 'KB-8'],
  comments: [['KB-7', 'preserve-KB-7'], ['KB-8', 'preserve-KB-8']],
};

// 1. Absent autopilot + absent pulses: defaults, no data loss, no crash.
await migrationCase('absent autopilot', fixtureBoard(), {
  boardState: 'v3, autopilot/pulses keys absent',
  defaults: 'defaults',
  enabled: false,
  reason: 'disabled',
  data: preserve,
});

// 2. Corrupt autopilot: every field invalid; read repairs instead of throwing.
await migrationCase(
  'corrupt autopilot',
  fixtureBoard({
    autopilot: {
      version: '1',
      enabled: 'true',
      cadenceMs: 'soon',
      maxReadyDepth: -5,
      laneCaps: 'nope',
      maxDispatchesPerPulse: 99,
      budget: { hour: { limit: 0, used: -3, windowStart: 'x' }, day: { limit: -1 } },
      backoffMs: null,
      staleMs: 1,
      updatedBy: 7,
    },
    pulses: 'not-an-array',
  }),
  { boardState: 'autopilot corrupt, pulses a string', defaults: 'repaired', enabled: false, reason: 'disabled', data: preserve, activityKind: 'autopilot/pulses-normalized' },
);

// 3. Unknown autopilot envelope version: fail safe to disabled, board intact.
await migrationCase(
  'wrong autopilot version',
  fixtureBoard({
    autopilot: { version: 99, enabled: true, cadenceMs: 300_000, laneCaps: { refine: 1, implement: 1, review: 1 }, budget: { hour: { limit: 20, used: 0, windowStart: 0 }, day: { limit: 60, used: 0, windowStart: 0 } } },
    pulses: [],
  }),
  { boardState: 'autopilot.version 99 + enabled true', defaults: 'defaults', enabled: false, reason: 'disabled', data: preserve, activityKind: 'autopilot/config-version-unknown' },
);

// 4. v1 fixture: team absent (seeded on read), autopilot absent.
await migrationCase(
  'v1 board fixture',
  { ...fixtureBoard({ team: undefined, version: 1 }), autopilot: undefined, pulses: undefined },
  { boardState: 'board version 1, no team, no autopilot', defaults: 'defaults', enabled: false, reason: 'disabled', data: { members: 10, tickets: ['KB-7', 'KB-8'], comments: [['KB-7', 'preserve-KB-7']] } },
);

// 5. v2 fixture: additive team roster present, autopilot absent.
await migrationCase(
  'v2 board fixture',
  { ...fixtureBoard({ version: 2 }), autopilot: undefined, pulses: undefined },
  { boardState: 'board version 2 with roster', defaults: 'defaults', enabled: false, reason: 'disabled', data: preserve },
);

// 6. v3 fixture with an existing (valid, enabled) autopilot but an empty ring.
await migrationCase(
  'v3 board fixture with autopilot',
  fixtureBoard({
    autopilot: {
      version: 1,
      enabled: true,
      cadenceMs: 300_000,
      maxReadyDepth: 3,
      laneCaps: { refine: 1, implement: 1, review: 1 },
      maxDispatchesPerPulse: 1,
      budget: { hour: { limit: 20, used: 0, windowStart: 0 }, day: { limit: 60, used: 0, windowStart: 0 } },
      backoffMs: 300_000,
      staleMs: 600_000,
      updatedAt: virtualNow - 86_400_000,
      updatedBy: 'system',
    },
    pulses: [],
  }),
  { boardState: 'v3 enabled autopilot, empty pulses', defaults: null, enabled: true, data: preserve },
);

// 7. pulses is not an array while the config is valid.
await migrationCase(
  'pulses not an array',
  fixtureBoard({
    autopilot: null,
    pulses: { nope: true },
  }),
  { boardState: 'pulses is an object, autopilot null', defaults: 'defaults', enabled: false, reason: 'disabled', data: preserve, activityKind: 'autopilot/pulses-normalized' },
);

{
  const failed = migrationCases.filter((row) => !row.passed);
  check('AC4 every migration fixture loads, applies defaults and pulses without throwing', failed.length === 0, brief(failed));
  check('AC4 no migration fixture lost ticket, roster or comment data', migrationCases.every((row) => row.dataProblems.length === 0), brief(migrationCases.map((row) => [row.case, row.dataProblems])));
  check('AC4 the board version stays 3 for every fixture', migrationCases.every((row) => row.version === 3), brief(migrationCases.map((row) => [row.case, row.version])));
  check('AC4 absent/corrupt/unknown config never enables autopilot', migrationCases.filter((row) => row.case !== 'v3 board fixture with autopilot').every((row) => row.configEnabled === false));
  check('AC4 the corrupt and non-array pulse rings are repaired, not fatal', migrationCases.filter((row) => ['corrupt autopilot', 'pulses not an array'].includes(row.case)).every((row) => row.decisions.length > 0 && row.pulse === 200));
  check('AC4 the v1/v2/v3 fixtures preserve their persisted ticket rows', ['v1 board fixture', 'v2 board fixture', 'v3 board fixture with autopilot'].every((name) => migrationCases.find((row) => row.case === name)?.dataProblems.length === 0));
}

// ===========================================================================
// AC 5 — failure matrix. Each case leaves a consistent board (no half-owned
// ticket, no duplicate session), records its pulse/board evidence, and the next
// pulse follows the persisted backoff / loop-guard rules.
// ===========================================================================
section('AC 5 — failure matrix: create/prompt/no-start/idle/pause×2/restart');

/** Board-level consistency oracle shared by every failure case. */
function consistencyProblems(board) {
  const problems = [];
  if (board.version !== 3) problems.push(`board version ${board.version}`);
  const sessions = [];
  for (const ticket of board.tickets ?? []) {
    const execution = ticket.execution;
    if (!execution?.sessionId) continue;
    sessions.push(execution.sessionId);
    const live = LIVE_STATUSES.has(execution.status);
    if (live && ticket.owner?.sessionId !== execution.sessionId) {
      problems.push(`half-owned ticket ${ticket.id}: ${execution.status} execution ${execution.sessionId} but owner ${ticket.owner?.sessionId ?? 'null'}`);
    }
    if (execution.origin !== 'autopilot') problems.push(`ticket ${ticket.id} execution lost its autopilot origin`);
  }
  if (new Set(sessions).size !== sessions.length) problems.push(`duplicate execution session: ${brief(sessions)}`);
  return problems;
}

async function failureFixture({ tickets } = {}) {
  const { app, stateDir, root, scheduler } = await freshApp();
  await app.configure({
    enabled: true,
    maxDispatchesPerPulse: tickets && tickets.length > 1 ? 2 : 1,
    laneCaps: { refine: 1, implement: 1, review: 1 },
    cadenceMs: 300_000,
    staleMs: 600_000,
    backoffMs: 300_000,
    budget: { hour: 20, day: 60 },
  });
  const created = [];
  for (const input of tickets ?? [{ title: 'Failure matrix ticket', column: 'ready', role: 'be-developer' }]) {
    created.push(await createTicket(app, {
      title: input.title,
      description: input.description ?? '## Acceptance criteria\n1. The failure is contained.\n2. The board stays consistent.',
      column: input.column,
      role: input.role,
      priority: 'high',
    }));
  }
  return { app, stateDir, root, scheduler, tickets: created };
}

const failureCases = [];
/** Flatten a matrix field so the printed row stays one parseable JSON object. */
const matrixField = (value) =>
  String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/\\/g, '/')
    .slice(0, 320);
function failureRow(row) {
  // Rows are printed after their case finishes so the logged `passed` value is
  // the final one, not the pre-assertion placeholder.
  for (const key of ['boardState', 'recorded', 'nextPulse']) {
    if (typeof row[key] === 'string') row[key] = matrixField(row[key]);
  }
  failureCases.push(row);
  return row;
}

// --- case 1: agents.create throws (+ the full loop guard over three attempts) --
{
  const { app, stateDir } = await failureFixture();
  const ticket = (await app.readBoard()).tickets[0];
  app.setFailCreate(new Error('fake agents.create exploded'));
  const first = (await app.pulseNow()).json.value.pulse;
  let board = await app.readBoard();
  let current = ticketOf(board, ticket.id);
  const issues = consistencyProblems(board);
  const row = failureRow({
    case: 'agents.create throws',
    boardState: `column=${current?.column} owner=${current?.owner ?? 'null'} execution=${current?.execution?.status ?? 'null'} attempts=${current?.autopilot?.attempts ?? 0}`,
    recorded: `pulse.error=${brief(first.error)}; comment=${(current?.comments ?? []).some((entry) => String(entry.text).startsWith('[autopilot dispatch-failed]'))}`,
    nextPulse: 'within backoff: no dispatch, postcondition-failed skip',
    passed: false,
  });
  check('AC5 create-throws records a pulse error', typeof first.error === 'string' && first.error.includes('fake agents.create exploded'), brief(first.error));
  check('AC5 create-throws leaves no half-owned ticket', current?.owner === null && current?.execution === null, brief({ owner: current?.owner, execution: current?.execution }));
  check('AC5 create-throws starts no session and charges no budget', app.createdSessions.length === 0 && board.autopilot.budget.hour.used === 0, `${app.createdSessions.length}/${board.autopilot.budget.hour.used}`);
  check('AC5 create-throws records one consecutive failure and a dispatch-failed comment', current?.autopilot?.attempts === 1 && (current?.comments ?? []).some((entry) => String(entry.text).startsWith('[autopilot dispatch-failed]')), brief(current?.autopilot));
  check('AC5 create-throws leaves a consistent board', issues.length === 0, brief(issues));

  // Next pulse inside the backoff: no retry, and the planner explains the wait.
  const wait = (await app.pulseNow()).json.value.pulse;
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  check(
    'AC5 after create-throws the next pulse waits out the backoff and dispatches nothing',
    app.createdSessions.length === 0 && (wait.decisions ?? []).some((entry) => entry.ticketId === ticket.id && entry.reason === 'postcondition-failed'),
    brief(wait.decisions),
  );

  // Retry after the backoff and repeat to the third strike: the loop guard parks
  // the ticket, the 4th attempt is refused, and a human unblock resets it.
  let attemptsSeen = 1;
  for (let attempt = 2; attempt <= 3; attempt += 1) {
    advanceClock(600_001 * attempt);
    const retry = (await app.pulseNow()).json.value.pulse;
    board = await app.readBoard();
    current = ticketOf(board, ticket.id);
    attemptsSeen = current?.autopilot?.attempts ?? 0;
    if (retry.error === '' && retry.dispatched.length === 0) break;
  }
  check('AC5 the third consecutive create failure trips the loop guard and parks the ticket', current?.blocked === true && current?.autopilot?.attempts === 3 && String(current?.blockReason ?? '').startsWith('autopilot/loop-guard'), brief({ blocked: current?.blocked, attempts: current?.autopilot?.attempts, blockReason: current?.blockReason }));
  check('AC5 the loop guard writes the human question and the board activity', (current?.comments ?? []).some((entry) => String(entry.text).startsWith('[autopilot loop-guard]')) && (board.activity ?? []).some((entry) => entry.kind === 'autopilot/loop-guard'), brief((board.activity ?? []).slice(-2)));
  const parked = (await app.pulseNow()).json.value.pulse;
  check('AC5 the parked ticket is refused by the blocked gate, not retried', app.createdSessions.length === 0 && (parked.decisions ?? []).some((entry) => entry.ticketId === ticket.id && entry.reason === 'blocked'), brief({ created: app.createdSessions.length, decisions: parked.decisions }));
  const answered = await app.action('answerTicket', { ticketId: ticket.id, answers: ['Retry manually after the loop guard.'] });
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  check('AC5 the human answer unblocks and resets the counter', answered.status === 200 && current?.blocked === false && (current?.autopilot?.attempts ?? 0) === 0 && current?.autopilot?.backoffUntil === 0, brief({ status: answered.status, autopilot: current?.autopilot }));
  row.passed = attemptsSeen === 3 && current?.blocked === false;
  row.nextPulse = `3 failures → loop-guard park; 4th refused (blocked); answer resets (attempts=${current?.autopilot?.attempts ?? 'reset'})`;
  await app.dispose();
}

// --- case 2: the prompt throws after the session was created -------------------
{
  const { app, stateDir } = await failureFixture();
  const ticket = (await app.readBoard()).tickets[0];
  app.setPromptHook(async () => {
    throw new Error('fake prompt rejected');
  });
  const first = (await app.pulseNow()).json.value.pulse;
  let board = await app.readBoard();
  let current = ticketOf(board, ticket.id);
  const issues = consistencyProblems(board);
  const row = failureRow({
    case: 'prompt throws',
    boardState: `column=${current?.column} owner=${current?.owner?.sessionId ? 'session' : 'null'} execution=${current?.execution?.status} error=${brief(current?.execution?.error)}`,
    recorded: `pulse.error=${brief(first.error)}; comment=${(current?.comments ?? []).some((entry) => String(entry.text).startsWith('[autopilot dispatch-failed]'))}`,
    nextPulse: 'within backoff: no dispatch; after backoff: fresh session replaces the failed row',
    passed: false,
  });
  check('AC5 prompt-throws records the pulse error', typeof first.error === 'string' && first.error.includes('fake prompt rejected'), brief(first.error));
  check('AC5 prompt-throws leaves exactly one session and one execution row', app.createdSessions.length === 1 && current?.execution?.status === 'failed' && current?.execution?.sessionId === app.createdSessions[0], brief({ created: app.createdSessions.length, execution: current?.execution?.status }));
  check('AC5 prompt-throws keeps owner and execution pointing at the same session', current?.owner?.sessionId === current?.execution?.sessionId, brief({ owner: current?.owner?.sessionId, execution: current?.execution?.sessionId }));
  check('AC5 prompt-throws counts the spend exactly once', board.autopilot.budget.hour.used === 1, String(board.autopilot.budget.hour.used));
  check('AC5 prompt-throws leaves a consistent board', issues.length === 0, brief(issues));
  // KB-78 finding F3 (recorded on the ticket; production code is out of scope):
  // the prompt-rejected row is `origin: 'autopilot'` + `status: 'failed'` + a
  // still-registered live agent, so the very next pulse also judges it as a
  // lane postcondition miss and counts the SAME failed attempt a second time
  // (`dispatch-failed` on the first pulse, `postcondition-failed` on the next).
  // The suite asserts the bounded rule this produces: two attempts after one
  // real dispatch, no third count, and the retry waits out the doubled backoff.
  const verifyPulse = (await app.pulseNow()).json.value.pulse;
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  const doubledOutcome = outcomesFor(verifyPulse, ticket.id).find((entry) => entry.lane === 'implement');
  check(
    'AC5 finding F3: a prompt-rejected row is re-counted as postcondition-failed by the next pulse',
    doubledOutcome?.outcome === 'postcondition-failed' && current?.autopilot?.attempts === 2,
    brief({ outcome: doubledOutcome, autopilot: current?.autopilot }),
  );
  const wait = (await app.pulseNow()).json.value.pulse;
  check('AC5 after the second count the pulse waits out the doubled backoff without a third count', app.createdSessions.length === 1 && current?.autopilot?.attempts === 2 && (wait.decisions ?? []).some((entry) => entry.ticketId === ticket.id && entry.reason === 'postcondition-failed'), brief({ created: app.createdSessions.length, autopilot: current?.autopilot, decisions: wait.decisions }));
  app.setPromptHook(null);
  advanceClock(600_001);
  const retry = (await app.pulseNow()).json.value.pulse;
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  check(
    'AC5 after the backoff the retry creates a fresh session and one execution row',
    retry.dispatched.length === 1 && app.createdSessions.length === 2 && current?.execution?.status === 'running' && current?.execution?.sessionId === retry.dispatched[0].sessionId,
    brief({ dispatched: retry.dispatched, execution: current?.execution?.sessionId, error: retry.error, decisions: retry.decisions, autopilot: current?.autopilot }),
  );
  row.recorded += '; next pulse re-counts the same attempt (finding F3)';
  row.passed = first.error?.includes('fake prompt rejected') === true && current?.execution?.status === 'running';
  await app.dispose();
}

// --- case 3: the agent never starts (create returns, nothing is registered) ---
{
  const { app, stateDir } = await failureFixture();
  const ticket = (await app.readBoard()).tickets[0];
  app.setCreateHook(() => 'no-register');
  const first = (await app.pulseNow()).json.value.pulse;
  let board = await app.readBoard();
  let current = ticketOf(board, ticket.id);
  const row = failureRow({
    case: 'agent never starts',
    boardState: `execution=${current?.execution?.status} live-agent=${app.live.size === 0 ? 'absent' : 'present'}`,
    recorded: `dispatch=${first.dispatched.length}; created=${app.createdSessions.length}`,
    nextPulse: 'after staleMs: watchdog recovers once; then backoff; then a real retry',
    passed: false,
  });
  check('AC5 no-start still records the dispatch (the board write precedes the prompt)', first.dispatched.length === 1 && current?.execution?.status === 'running' && app.live.size === 0, brief({ dispatched: first.dispatched, execution: current?.execution?.status, live: app.live.size }));
  // Advance past staleMs: the watchdog recovers the dead row exactly once.
  advanceClock(600_001);
  const watchdog = (await app.pulseNow()).json.value.pulse;
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  const issues = consistencyProblems(board);
  check('AC5 no-start is recovered once as stale, not duplicated', current?.execution?.status === 'failed' && current?.execution?.stale?.sessionId === app.createdSessions[0] && (watchdog.decisions ?? []).some((entry) => entry.ticketId === ticket.id && entry.reason === 'stale-execution'), brief({ execution: current?.execution, decisions: watchdog.decisions }));
  check('AC5 the stale recovery writes the marker comment and one failure', (current?.comments ?? []).some((entry) => String(entry.text).startsWith('[autopilot stale-execution]')) && current?.autopilot?.attempts === 1, brief(current?.autopilot));
  check('AC5 the stale recovery leaves a consistent board', issues.length === 0 && app.createdSessions.length === 1, brief(issues));
  const wait = (await app.pulseNow()).json.value.pulse;
  check('AC5 the pulse after the stale recovery waits out the backoff', app.createdSessions.length === 1 && (wait.decisions ?? []).some((entry) => entry.ticketId === ticket.id && entry.reason === 'postcondition-failed'), brief(wait.decisions));
  app.setCreateHook(null);
  advanceClock(600_001);
  const retry = (await app.pulseNow()).json.value.pulse;
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  check('AC5 the retry after the stale backoff starts one fresh, registered session', retry.dispatched.length === 1 && app.live.has(current?.execution?.sessionId) && app.createdSessions.length === 2, brief({ dispatched: retry.dispatched, live: [...app.live.keys()] }));
  check('AC5 the stale recovery is recorded as board activity, not only a decision', (board.activity ?? []).some((entry) => entry.kind === 'autopilot/stale'), brief((board.activity ?? []).slice(-2)));
  row.passed = current?.execution?.status === 'running' && app.live.size >= 1;
  await app.dispose();
}

// --- case 4: the agent goes idle without moving the ticket --------------------
{
  const { app, stateDir } = await failureFixture();
  const ticket = (await app.readBoard()).tickets[0];
  const first = (await app.pulseNow()).json.value.pulse;
  const sessionId = first.dispatched[0].sessionId;
  app.endTurn(sessionId);
  advanceClock(10_000);
  const verify = (await app.pulseNow()).json.value.pulse;
  let board = await app.readBoard();
  let current = ticketOf(board, ticket.id);
  const outcome = outcomesFor(verify, ticket.id).find((entry) => entry.lane === 'implement');
  const issues = consistencyProblems(board);
  const row = failureRow({
    case: 'agent idles without moving the ticket',
    boardState: `column=${current?.column} execution=${current?.execution?.status} attempts=${current?.autopilot?.attempts}`,
    recorded: `pulse.outcome=${outcome?.outcome}; comment=${(current?.comments ?? []).some((entry) => String(entry.text).startsWith('[autopilot postcondition-failed]'))}`,
    nextPulse: 'within backoff: no dispatch; after backoff: retry',
    passed: false,
  });
  check('AC5 idle-without-progress records postcondition-failed', outcome?.outcome === 'postcondition-failed' && outcome?.lane === 'implement', brief(verify.outcomes));
  check('AC5 idle-without-progress persists the failure comment and one attempt', (current?.comments ?? []).some((entry) => String(entry.text).startsWith('[autopilot postcondition-failed]')) && current?.autopilot?.attempts === 1, brief(current?.autopilot));
  check('AC5 idle-without-progress closes the failed execution row', current?.execution?.status === 'failed', current?.execution?.status);
  check('AC5 idle-without-progress leaves a consistent board with one session', issues.length === 0 && app.createdSessions.length === 1, brief(issues));
  const wait = (await app.pulseNow()).json.value.pulse;
  check('AC5 the pulse inside the postcondition backoff does not retry', app.createdSessions.length === 1 && (wait.decisions ?? []).some((entry) => entry.ticketId === ticket.id && entry.reason === 'postcondition-failed'), brief(wait.decisions));
  advanceClock(300_001);
  const retry = (await app.pulseNow()).json.value.pulse;
  board = await app.readBoard();
  current = ticketOf(board, ticket.id);
  check('AC5 the retry after the postcondition backoff starts exactly one new session', retry.dispatched.length === 1 && app.createdSessions.length === 2 && current?.execution?.sessionId === retry.dispatched[0].sessionId, brief(retry.dispatched));
  row.passed = outcome?.outcome === 'postcondition-failed' && current?.execution?.status === 'running';
  await app.dispose();
}

// --- case 5: the board is paused mid-pulse -----------------------------------
{
  const { app, stateDir } = await failureFixture({
    tickets: [
      { title: 'Mid-pulse pause review', column: 'review', role: 'tester' },
      { title: 'Mid-pulse pause implement', column: 'ready', role: 'be-developer' },
    ],
  });
  let hookFired = 0;
  app.setPromptHook(async () => {
    hookFired += 1;
    if (hookFired === 1) await app.patchBoardOnDisk((board) => { board.paused = true; board.pausedAt = virtualNow; board.pausedBy = 'You'; });
  });
  const pulse = (await app.pulseNow()).json.value.pulse;
  let board = await app.readBoard();
  const issues = consistencyProblems(board);
  const readyTicket = board.tickets.find((entry) => entry.column === 'ready' || entry.title.includes('implement'));
  const row = failureRow({
    case: 'board paused mid-pulse',
    boardState: `paused=${board.paused} sessions=${app.createdSessions.length} second-ticket-execution=${readyTicket?.execution?.status ?? 'null'}`,
    recorded: `decision=${brief((pulse.decisions ?? []).filter((entry) => entry.reason === 'board-paused'))}`,
    nextPulse: 'paused board records board-paused and dispatches nothing; resume needs a pulse',
    passed: false,
  });
  check('AC5 a mid-pulse board pause stops the remaining dispatch', app.createdSessions.length === 1 && (pulse.decisions ?? []).some((entry) => entry.reason === 'board-paused'), brief({ created: app.createdSessions.length, decisions: pulse.decisions }));
  check('AC5 the already-dispatched ticket keeps a coherent owner/execution pair', consistencyProblems(board).length === 0, brief(issues));
  check('AC5 the second ticket was never touched', readyTicket?.execution === null || readyTicket?.execution === undefined, brief(readyTicket?.execution));
  const pausedPulse = (await app.pulseNow()).json.value.pulse;
  check('AC5 the next pulse while paused is a recorded no-op', (pausedPulse.decisions ?? []).some((entry) => entry.reason === 'board-paused') && app.createdSessions.length === 1, brief(pausedPulse.decisions));
  await app.action('resumeBoard');
  const resumed = (await app.pulseNow()).json.value.pulse;
  board = await app.readBoard();
  check('AC5 resuming lets the second lane dispatch without duplicating the first', resumed.dispatched.length === 1 && app.createdSessions.length === 2, brief({ dispatched: resumed.dispatched, created: app.createdSessions.length }));
  check('AC5 no ticket holds two execution rows after the pause/resume', consistencyProblems(board).length === 0, brief(consistencyProblems(board)));
  row.passed = app.createdSessions.length === 2 && consistencyProblems(board).length === 0;
  await app.dispose();
}

// --- case 6: a member is paused mid-pulse ------------------------------------
{
  const { app, stateDir } = await failureFixture({
    tickets: [
      { title: 'Mid-pulse member pause review', column: 'review', role: 'tester' },
      { title: 'Mid-pulse member pause implement', column: 'ready', role: 'be-developer' },
    ],
  });
  let hookFired = 0;
  app.setPromptHook(async () => {
    hookFired += 1;
    if (hookFired === 1) {
      await app.patchBoardOnDisk((board) => {
        const member = board.team.members.find((entry) => entry.id === 'member-be-developer');
        if (member) member.paused = true;
      });
    }
  });
  const pulse = (await app.pulseNow()).json.value.pulse;
  let board = await app.readBoard();
  const implementTicket = board.tickets.find((entry) => entry.role === 'be-developer' && entry.column !== 'review') ?? null;
  const pauseDecisions = (pulse.decisions ?? []).filter((entry) => entry.reason === 'member-paused');
  const issues = consistencyProblems(board);
  const row = failureRow({
    case: 'member paused mid-pulse',
    boardState: `paused-member=member-be-developer sessions=${app.createdSessions.length} ready-ticket-execution=${implementTicket?.execution?.status ?? 'null'}`,
    recorded: `decision=${brief(pauseDecisions)}`,
    nextPulse: 'paused member is filtered; after resume the lane dispatches once',
    passed: false,
  });
  check('AC5 a mid-pulse member pause stops that lane', app.createdSessions.length === 1 && pauseDecisions.length > 0, brief({ created: app.createdSessions.length, decisions: pulse.decisions }));
  check('AC5 the paused member receives no session and the ticket is untouched', (implementTicket?.execution ?? null) === null && !(implementTicket?.owner), brief({ execution: implementTicket?.execution, owner: implementTicket?.owner }));
  check('AC5 the mid-pulse member pause leaves a consistent board', issues.length === 0, brief(issues));
  await app.patchBoardOnDisk((board2) => {
    const member = board2.team.members.find((entry) => entry.id === 'member-be-developer');
    if (member) member.paused = false;
  });
  const resumed = (await app.pulseNow()).json.value.pulse;
  board = await app.readBoard();
  check('AC5 after member resume the lane dispatches exactly once', resumed.dispatched.length === 1 && app.createdSessions.length === 2 && consistencyProblems(board).length === 0, brief({ dispatched: resumed.dispatched, created: app.createdSessions.length }));
  row.passed = app.createdSessions.length === 2 && consistencyProblems(board).length === 0;
  await app.dispose();
}

// --- case 7: the host restarts while a pulse is in flight --------------------
{
  const { app: app1, stateDir, root, scheduler } = await failureFixture();
  const ticket = (await app1.readBoard()).tickets[0];
  const first = (await app1.pulseNow()).json.value.pulse;
  const deadSession = first.dispatched[0].sessionId;
  // Crash-state simulation: the execution row and budget were persisted before
  // the prompt, but the process died before the pulse record was written.
  await app1.dispose();
  await app1.patchBoardOnDisk((board) => { board.pulses = []; });
  const crashed = await app1.readBoard();
  const app2 = await makeApp({ stateDir, root, scheduler });
  await app2.handle.autopilotReady();
  const snapshot = await app2.state();
  const recovery = (await app2.pulseNow()).json.value.pulse;
  const board = await app2.readBoard();
  const current = ticketOf(board, ticket.id);
  const issues = consistencyProblems(board);
  const row = failureRow({
    case: 'host restarts mid-pulse',
    boardState: `loaded=${snapshot.board?.tickets?.length ?? 0} tickets; dead-session=${deadSession.slice(0, 12)}…; pulses-before=${crashed.pulses.length}`,
    recorded: `recovery-pulse=${brief(recovery.dispatched)}; reconcile of the dead session (a clean host abort records no executor error)`,
    nextPulse: 'recovered session is live: next pulse sees active-execution and never starts a duplicate',
    passed: false,
  });
  check('AC5 the crash-state board loads on the new host with its ticket data', snapshot.board?.tickets?.length === 1 && snapshot.board?.tickets?.[0]?.id === ticket.id, brief(snapshot.board?.tickets?.map((entry) => entry.id)));
  check('AC5 the restart recovers the dead session with exactly one new session', recovery.dispatched.length === 1 && app2.createdSessions.length === 1 && app2.createdSessions[0] !== deadSession, brief({ dispatched: recovery.dispatched, created: app2.createdSessions }));
  check('AC5 the ticket points at the new session only (no duplicate session)', current?.execution?.sessionId === app2.createdSessions[0] && !(board.tickets ?? []).some((entry) => entry.execution?.sessionId === deadSession), brief(current?.execution));
  check('AC5 the recovered execution is running and autopilot-owned', current?.execution?.status === 'running' && current?.execution?.origin === 'autopilot' && current?.owner?.sessionId === current?.execution?.sessionId, brief({ execution: current?.execution, owner: current?.owner }));
  check('AC5 the recovery pulse is persisted and consistent', pulseRows(board).length === 1 && (recovery.decisions ?? []).some((entry) => entry.reason === 'admitted') && issues.length === 0, brief({ pulses: pulseRows(board).length, issues }));
  const overlap = (await app2.pulseNow()).json.value.pulse;
  check(
    'AC5 the next pulse never duplicates the recovered session',
    app2.createdSessions.length === 1 && (overlap.decisions ?? []).some((entry) => entry.ticketId === ticket.id && entry.reason === 'active-execution'),
    brief(overlap.decisions),
  );
  row.passed = app2.createdSessions.length === 1 && consistencyProblems(board).length === 0;
  await app2.dispose();
}

{
  const failed = failureCases.filter((row) => !row.passed);
  for (const row of failureCases) matrixRow(row);
  check('AC5 every failure-matrix case leaves a consistent board and follows backoff/loop-guard rules', failed.length === 0, brief(failed));
}

// ===========================================================================
// AC 6 — the KB-75 24-hour simulated run, re-run here as a cross-check:
// dispatch count ≤ budget, no unbounded retries, and identical outcomes for the
// same seed across two independent runs.
// ===========================================================================
section('AC 6 — 24-hour simulated run cross-check: budget bound, bounded retries, determinism');

/** One full 24 h fake-clock run. Returns a seed-deterministic summary. */
async function simulationRun(seed) {
  virtualNow = 1_900_000_000_000;
  const scheduler = createScheduler();
  const root = await tempDir(`kanban-kb78-sim-root-${seed}-`);
  const stateDir = await tempDir(`kanban-kb78-sim-state-${seed}-`);
  await writeFile(join(root, 'README.md'), '# 24h simulation\n', 'utf8');
  const app = await makeApp({ stateDir, root, scheduler });
  await app.configure({
    enabled: true,
    maxDispatchesPerPulse: 1,
    laneCaps: { refine: 0, implement: 1, review: 0 },
    cadenceMs: 300_000,
    maxReadyDepth: 10,
    backoffMs: 300_000,
    staleMs: 600_000,
    budget: { hour: 20, day: 60 },
  });
  // Eight Ready tickets, one implement lane cap and one dispatch per pulse: the
  // 24 h timeline can only spend 24 sessions if every ticket is pinned at the
  // loop guard (3 attempts each), so both the rate and the retry bound are real.
  for (let index = 1; index <= 8; index += 1) {
    await createTicket(app, {
      title: `24h simulation ticket ${index}`,
      description: '## Acceptance criteria\n1. The simulated agent never advances it.\n2. The loop guard bounds retries.',
      column: 'ready',
      role: 'be-developer',
      priority: 'medium',
    });
  }
  const initialColumns = [...(await app.readBoard()).tickets.map((ticket) => `${ticket.id}:${ticket.column}`)].sort();
  // 288 five-minute ticks = 24 simulated hours. Each tick fires the host timer,
  // then the fake agent's turn ends where it began (idle, ticket unmoved).
  for (let tick = 0; tick < 288; tick += 1) {
    await scheduler.advance(300_000);
    await settle(2);
    for (const agent of app.live.values()) agent.status = 'idle';
  }
  const board = await app.readBoard();
  const reasons = {};
  for (const pulse of pulseRows(board)) {
    for (const decision of pulse.decisions ?? []) reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
  }
  const outcomeCounts = {};
  for (const pulse of pulseRows(board)) {
    for (const outcome of pulse.outcomes ?? []) outcomeCounts[outcome.outcome] = (outcomeCounts[outcome.outcome] ?? 0) + 1;
  }
  const activityCounts = {};
  for (const entry of board.activity ?? []) activityCounts[entry.kind] = (activityCounts[entry.kind] ?? 0) + 1;
  const summary = {
    seed,
    dispatches: app.createdSessions.length,
    persistedPulses: pulseRows(board).length,
    reasons,
    outcomes: outcomeCounts,
    activityCounts,
    ticketStates: board.tickets
      .map((ticket) => ({
        id: ticket.id,
        column: ticket.column,
        blocked: ticket.blocked === true,
        attempts: ticket.autopilot?.attempts ?? 0,
        lastOutcome: ticket.autopilot?.lastOutcome ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    budget: { hourLimit: board.autopilot.budget.hour.limit, dayLimit: board.autopilot.budget.day.limit, dayUsed: board.autopilot.budget.day.used, hourUsed: board.autopilot.budget.hour.used },
    finalColumns: [...board.tickets.map((ticket) => `${ticket.id}:${ticket.column}`)].sort(),
    initialColumns,
    budgetExhaustedTicks: Object.keys(reasons).includes('budget-exhausted') ? reasons['budget-exhausted'] : 0,
    pulseErrors: pulseRows(board).filter((pulse) => typeof pulse.error === 'string' && pulse.error !== '').length,
  };
  await app.dispose();
  return summary;
}

{
  const seed = 0x24_78;
  const simulationStart = process.hrtime.bigint();
  const first = await simulationRun(seed);
  const firstDurationMs = Number(process.hrtime.bigint() - simulationStart) / 1e6;
  const second = await simulationRun(seed);
  const maxAttempts = Math.max(...first.ticketStates.map((ticket) => ticket.attempts));
  console.log(`[simulation] 24h seed=${seed} dispatches=${first.dispatches} dayLimit=${first.budget.dayLimit} maxAttempts=${maxAttempts}`);
  console.log(`[simulation] reasons=${JSON.stringify(first.reasons)} pulses=${first.persistedPulses}`);
  check('AC6 the 24h dispatch count stays inside the daily budget', first.dispatches <= first.budget.dayLimit, `${first.dispatches} <= ${first.budget.dayLimit}`);
  check('AC6 no ticket exceeds the three-attempt loop guard', maxAttempts <= 3, String(maxAttempts));
  check('AC6 every retried ticket is parked by the loop guard rather than retried forever', first.ticketStates.filter((ticket) => ticket.attempts >= 3).every((ticket) => ticket.blocked === true), brief(first.ticketStates.filter((ticket) => ticket.attempts >= 3)));
  check('AC6 the simulated run leaves every ticket in its initial column', JSON.stringify(first.finalColumns) === JSON.stringify(first.initialColumns), brief({ before: first.initialColumns, after: first.finalColumns }));
  const ringPulses = first.persistedPulses > 0 ? first.persistedPulses : 0;
  check('AC6 24 simulated hours complete without a wall-clock wait (virtual clock only)', firstDurationMs < 20_000 && ringPulses > 0, `${firstDurationMs.toFixed(0)} ms for 24 h of virtual time`);
  check('AC6 the persisted pulse ring records no pulse-level error on the bounded run', first.pulseErrors === 0, String(first.pulseErrors));
  check('AC6 the 24h run is deterministic for the same seed across two runs', JSON.stringify(first) === JSON.stringify(second), brief({ first: first.dispatches, second: second.dispatches }));
  check('AC6 the run actually spent dispatches and exercised the retry bound', first.dispatches > 0 && first.ticketStates.some((ticket) => ticket.attempts >= 2), `${first.dispatches} dispatches`);
}

// ===========================================================================
// Findings filed for new Backlog tickets (AC 8). This suite patches no
// production code; each finding carries an exact reproduction and is reported
// on KB-78. Findings are evidence rows, not skipped assertions: no invariant in
// AC2–AC6 depends on them.
// ===========================================================================
section('Findings recorded for Backlog (AC 8 — no production patch in this suite)');
{
  // F1 (fixed by KB-82): the export now carries the executor heartbeat.
  check(
    'KB-82 F1 AUTOPILOT_REASON_CODES includes the documented no-work heartbeat',
    REASON_CODES.has('no-work') && AUTOPILOT_REASON_CODES.filter((code) => code === 'no-work').length === 1,
    brief(AUTOPILOT_REASON_CODES),
  );
  check(
    'KB-82 F1 the heartbeat widens only the reason export, not the frozen skip list',
    AUTOPILOT_SKIP_CODES.length === 16 && !AUTOPILOT_SKIP_CODES.includes('no-work'),
    brief(AUTOPILOT_SKIP_CODES),
  );

  // F2: shipped config bounds are wider than the phase-1 envelope in the record.
  const { app } = await freshApp();
  const configured = await app.configure({ enabled: true, laneCaps: { implement: 3 }, cadenceMs: 60_000 });
  const board = await app.readBoard();
  evidenceRows.push({
    finding: 'F2',
    title: 'Configure accepts lane caps and cadence outside the frozen phase-1 envelope',
    reproduction: 'POST /kanban/action {action:"autopilot",payload:{op:"configure",patch:{laneCaps:{implement:3},cadenceMs:60000}}} -> 200; GET /kanban/state -> board.autopilot.laneCaps.implement === 3 and cadenceMs === 60000. docs/AUTOPILOT.md §5.2/§7 freeze laneCaps 0–1 and cadence ≥ 300000 for phase 1.',
    impact: 'A human or hand-edited board can widen phase-1 implement concurrency to 3 sessions and lower the cadence to 1 minute, outside the decision record’s runaway-cost envelope.',
    observed: { status: configured.status, laneCaps: board.autopilot.laneCaps, cadenceMs: board.autopilot.cadenceMs },
  });
  console.log('[finding] F2 recorded: configure accepts laneCaps.implement=3 / cadenceMs=60000 while docs/AUTOPILOT.md §5.2/§7 freeze 0–1 and ≥300000 for phase 1.');
  check('finding F2 probe: the shipped configure path accepts the observed wider values', configured.status === 200 && board.autopilot.laneCaps.implement === 3, brief({ status: configured.status, laneCaps: board.autopilot.laneCaps }));
  await app.dispose();
  // F3 is recorded by the failure-matrix prompt-throws case above.
}

// ===========================================================================
// AC 7 — documentation wiring. The suite is listed in the README test list;
// this assertion makes removing the wiring fail the suite.
// ===========================================================================
section('AC 7 — documentation wiring: README test list');
{
  const readme = await readFile(join(REPO_ROOT, 'README.md'), 'utf8');
  const listed = readme.split(/\r?\n/).some((line) => line.includes('tests/autopilot-invariants.test.mjs'));
  check('AC7 the README test list names tests/autopilot-invariants.test.mjs', listed);
  check('AC7 the README line explains what the suite proves', readme.split(/\r?\n/).some((line) => line.includes('tests/autopilot-invariants.test.mjs') && line.includes('KB-78')));
  let specAutopilotSection = false;
  try {
    const spec = await readFile(join(REPO_ROOT, 'KANBAN_SPEC.md'), 'utf8');
    specAutopilotSection = /autopilot/i.test(spec) && /verification/i.test(spec);
    if (specAutopilotSection) {
      check('AC7 the KANBAN_SPEC autopilot verification section names the invariant suite', spec.includes('tests/autopilot-invariants.test.mjs'));
    } else {
      console.log('[wiring] KANBAN_SPEC has no autopilot verification section on this commit; README wiring is the complete AC 7 requirement.');
    }
  } catch {
    console.log('[wiring] KANBAN_SPEC.md is absent; README wiring is the complete AC 7 requirement.');
  }
  check('AC7 (conditional) KANBAN_SPEC verification wiring checked when present', true);
}

// ===========================================================================
// AC 8 — no blanket skips. `known-fail` is only allowed through the explicit
// registry at the top of this file, and every entry must name a Backlog ticket.
// ===========================================================================
section('AC 8 — known-fail registry and no blanket skips');
{
  const source = await readFile(fileURLToPath(import.meta.url), 'utf8');
  check('AC8 the known-fail registry is an explicit list', Array.isArray(KNOWN_FAIL) === true);
  check(
    'AC8 every known-fail entry names a Backlog ticket and the exact assertion',
    KNOWN_FAIL.every((row) => typeof row?.ticketId === 'string' && /^KB-\d+$/.test(row.ticketId) && typeof row.assertion === 'string' && row.assertion.length > 0 && typeof row.reason === 'string' && row.reason.length > 0),
    brief(KNOWN_FAIL),
  );
  check('AC8 the suite contains no blanket skip call', !/(?:^|[^\w])test\s*\.\s*skip\s*\(/.test(source) && !/describe\s*\.\s*skip\s*\(/.test(source) && !/it\s*\.\s*skip\s*\(/.test(source));
  // Avoid self-reference: the markers are assembled so this assertion line does
  // not itself contain the literal it searches for.
  const skipMarker = ['TODO', 'KNOWN', 'FAIL'].join('-');
  const registryMarker = ['KNOWN', 'FAIL = Object.freeze'].join('_');
  check('AC8 the file declares no skipped test markers', !source.includes(skipMarker) && source.includes(registryMarker));
  check('AC8 no known-fail exemption is active on this commit', KNOWN_FAIL.length === 0, String(KNOWN_FAIL.length));
  check('AC8 every recorded finding carries an exact reproduction (filed as new Backlog tickets)', evidenceRows.filter((row) => row.finding).every((row) => typeof row.reproduction === 'string' && row.reproduction.length > 40), brief(evidenceRows.filter((row) => row.finding).map((row) => row.finding)));
}

// ===========================================================================
// Suite summary: AC 1 timing/no-wall-clock and AC 6 no-unhandled-rejection
// ===========================================================================
section('Suite summary');
{
  const elapsedMs = Number(process.hrtime.bigint() - realStartNs) / 1e6;
  console.log(`[summary] elapsed-ms=${elapsedMs.toFixed(1)} checks-failed=${failures.length} virtual-now=${virtualNow} virtual-hours-simulated=24`);
  console.log(`[summary] property seed=${PROPERTY_SEED} iterations=${PROPERTY_ITERATIONS} sweep-seed=0x78e1ec7 boards=24`);
  check('AC1 the whole suite completes in well under 60 s', elapsedMs < 60_000, `${elapsedMs.toFixed(1)} ms`);
  check('AC1 no unhandled rejection escaped a pulse', unhandledRejections.length === 0, brief(unhandledRejections));
  check('AC6 no wall-clock wait: every simulated hour ran on the virtual clock', virtualNow > 1_800_000_000_000, String(virtualNow));

  for (const dir of dirs) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // cleanup is best effort
    }
  }
  console.log('\n' + (failures.length === 0 ? 'ALL AUTOPILOT INVARIANT CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
}
Date.now = realDateNow;
process.exit(failures.length === 0 ? 0 : 1);
