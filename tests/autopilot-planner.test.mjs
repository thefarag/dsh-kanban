/**
 * KB-69 — pure pulse planner: deterministic lane admission, reason codes, and dry-run.
 *
 * Dependency-free harness in the same style as `tests/autopilot-schema.test.mjs`:
 * a frozen clock, temporary directories, and a fake Harness ctx. Every assertion
 * is made against observable plan output (or the persisted board file), never an
 * internal helper. There is no wall-clock sleep anywhere in this file.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  purity — same `(board, config, now)` gives a deep-equal plan; inputs are
 *         not mutated; the dry-run performs zero storage writes and zero sessions
 *   AC 2  ordering — rework, review, implement, refine; then priority rank, oldest
 *         movedAt, ticket id
 *   AC 3  every closed reason code is reachable and only closed codes are emitted
 *   AC 4  admission — one decision per lane group, `maxDispatchesPerPulse`,
 *         `maxReadyDepth`, member-busy for running/idle/blocked/paused, no shared member
 *   AC 5  role routing from the policy tables, reviewer separation
 *   AC 6  deterministic fair member selection (oldest `lastActivatedAt`, lowest id)
 *   AC 7  persisted postcondition cooldown and loop guard
 *   AC 8  `autopilot {op:'plan'}` dry-run equals the planner, with no dispatch/mutation
 *   AC 9  500-board randomized property test over the admission invariants
 *   AC 10 `node --test tests/autopilot-planner.test.mjs` passes with no sleeps
 */
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, planPulse, AUTOPILOT_REASON_CODES, AUTOPILOT_SKIP_CODES } from '../index.js';
import { LANE_CLAIM_ROLES } from '../roles.js';

// One frozen instant: the host's `settings.now` and `Date.now` both return it, so
// every plan is reproducible and no test waits on the wall clock.
const T = 1_780_000_000_000;
const realDateNow = Date.now;
Date.now = () => T;

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const brief = (value) => String(JSON.stringify(value)).slice(0, 260);
const capture = (label, value) =>
  console.log(`[capture] ${label}:`, typeof value === 'string' ? value : JSON.stringify(value));

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_WIP = { backlog: 0, ready: 0, in_progress: 3, review: 5, done: 0 };
const ROLES = [
  'product-manager',
  'ux-designer',
  'fe-developer',
  'be-developer',
  'fullstack-developer',
  'bug-fixer',
  'reviewer',
  'tester',
  'sre',
  'tech-lead',
];

function member(id, roleId, overrides = {}) {
  return {
    id,
    name: overrides.name ?? id,
    title: '',
    roleId,
    persona: 'Planner fixture persona.',
    paused: overrides.paused ?? false,
    sessionId: overrides.sessionId ?? null,
    lastActivatedAt: overrides.lastActivatedAt ?? 0,
    createdAt: T - 100_000,
    updatedAt: T - 90_000,
    createdBy: 'system',
    source: 'manual',
  };
}

function ticket(id, overrides = {}) {
  const number = Number(String(id).replace(/\D/g, '')) || 1;
  return {
    id,
    number,
    title: overrides.title ?? `Ticket ${id}`,
    description: overrides.description ?? '',
    type: overrides.type ?? 'task',
    priority: overrides.priority ?? 'medium',
    column: overrides.column ?? 'backlog',
    role: overrides.role === undefined ? null : overrides.role,
    labels: overrides.labels ?? [],
    owner: overrides.owner ?? null,
    blocked: overrides.blocked ?? false,
    blockReason: '',
    checklist: [],
    comments: overrides.comments ?? [],
    reviews: overrides.reviews ?? [],
    execution: overrides.execution ?? null,
    assignment: overrides.assignment ?? null,
    source: null,
    createdAt: T - 100_000,
    updatedAt: overrides.updatedAt ?? T - 5_000,
    movedAt: overrides.movedAt ?? T - 5_000,
    acceptedAt: null,
    activity: overrides.activity ?? [],
  };
}

function autopilotConfig(overrides = {}) {
  const base = {
    version: 1,
    enabled: true,
    cadenceMs: 300_000,
    maxReadyDepth: 3,
    laneCaps: { refine: 1, implement: 1, review: 1 },
    maxDispatchesPerPulse: 1,
    budget: {
      hour: { limit: 20, used: 0, windowStart: 0 },
      day: { limit: 60, used: 0, windowStart: 0 },
    },
    backoffMs: 300_000,
    staleMs: 600_000,
    updatedAt: 0,
    updatedBy: 'system',
  };
  const merged = { ...base, ...overrides };
  merged.laneCaps = { ...base.laneCaps, ...(overrides.laneCaps ?? {}) };
  merged.budget = {
    hour: { ...base.budget.hour, ...(overrides.budget?.hour ?? {}) },
    day: { ...base.budget.day, ...(overrides.budget?.day ?? {}) },
  };
  return merged;
}

function boardFixture(overrides = {}) {
  return {
    version: 3,
    workspaceId: 'w1',
    projectTitle: 'Planner Fixture',
    projectPath: '/tmp/planner-fixture',
    createdAt: T - 100_000,
    updatedAt: T - 90_000,
    paused: overrides.paused ?? false,
    pausedAt: null,
    pausedBy: null,
    wip: overrides.wip ?? { ...DEFAULT_WIP },
    nextNumber: 100,
    tickets: overrides.tickets ?? [],
    activity: [],
    agents: {},
    team: { version: 1, seededAt: T - 50_000, members: overrides.members ?? [], drafts: [] },
    autopilot: overrides.autopilot ?? autopilotConfig(),
    pulses: overrides.pulses ?? [],
    meta: { vision: null, docs: [], conversations: [], mrs: [], lastScanAt: null },
  };
}

/** A team with one free, non-paused member per role named in `roles`. */
function teamOf(roles, overrides = {}) {
  return roles.map((role, index) => member(`member-${index}-${role}`, role, overrides));
}

const decisionsOf = (plan) => plan.decisions;
const decisionIds = (plan) => plan.decisions.map((decision) => decision.ticketId);
const skipReasons = (plan) => plan.skips.map((skip) => skip.reason);
const skipFor = (plan, ticketId) => plan.skips.find((skip) => skip.ticketId === ticketId) ?? null;

// ---------------------------------------------------------------------------
// Fake Harness (same contract as tests/autopilot-schema.test.mjs)
// ---------------------------------------------------------------------------

const dirs = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function makeApp({ stateDir, root, counters }) {
  const services = {};
  const routes = new Map();
  const workspace = {
    id: 'w1',
    title: 'Planner Fixture',
    path: root,
    createdAt: new Date(T).toISOString(),
    updatedAt: new Date(T).toISOString(),
    sessionIds: [],
  };
  const ctx = {
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on() {
      return () => {};
    },
    get(service) {
      return services[service];
    },
    provide(service, value) {
      services[service] = value;
      return () => {};
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    tools: {
      register() {
        return () => {};
      },
    },
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    workspaceRegistry: { list: () => [workspace] },
    sessionController: {
      async list() {
        return { items: [] };
      },
      cancel() {
        return { accepted: true };
      },
      async prompt() {
        counters.prompts += 1;
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
      async stat() {
        return undefined;
      },
    },
    agents: {
      list: () => [],
      get: () => undefined,
      async create() {
        counters.create += 1;
        throw new Error('KB-69 planner must never create an agent session.');
      },
    },
  };
  apply(ctx, { stateDir, wipInProgress: 3, wipReview: 5, now: () => T });

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
    state: async () => (await http('/kanban/state', { workspaceId: 'w1' })).json.value,
    action: async (action, payload) => http('/kanban/action', { workspaceId: 'w1', action, payload }),
  };
}

/**
 * Build a host over a real board file. `buildBoard` produces the persisted v3
 * board; `configure` (when given) is applied through the action API afterwards.
 */
async function fixtureApp(buildBoard, { configure = null } = {}) {
  const root = await tempDir('kanban-kb69-root-');
  const stateDir = await tempDir('kanban-kb69-state-');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Planner Fixture\n', 'utf8');
  const fixture = buildBoard();
  await writeFile(join(stateDir, 'w1.json'), JSON.stringify(fixture), 'utf8');
  const counters = { create: 0, prompts: 0 };
  const app = makeApp({ stateDir, root, counters });
  await app.state();
  if (configure) {
    const response = await app.action('autopilot', { op: 'configure', patch: configure });
    if (response.status !== 200) throw new Error(`fixture configure failed: ${response.status}`);
  }
  return { root, stateDir, app, counters, stateDirFile: join(stateDir, 'w1.json') };
}

/** Count state-directory writeFile calls (the store's only write primitive). */
function instrumentWrites(stateDir) {
  const original = fs.promises.writeFile;
  let count = 0;
  fs.promises.writeFile = function patchedWriteFile(file, ...rest) {
    if (String(file).startsWith(stateDir)) count += 1;
    return original.call(fs.promises, file, ...rest);
  };
  syncBuiltinESMExports();
  return {
    get count() {
      return count;
    },
    stop() {
      fs.promises.writeFile = original;
      syncBuiltinESMExports();
    },
  };
}

const stateFile = (stateDir) => join(stateDir, 'w1.json');
const readBoard = async (stateDir) => JSON.parse(await readFile(stateFile(stateDir), 'utf8'));

// ===========================================================================
// AC 1 — purity: deterministic plan, no mutation, no writes, no sessions
// ===========================================================================
console.log('\n## AC 1 — purity and zero side effects');
{
  const b = boardFixture({
    tickets: [
      ticket('KB-1', { column: 'backlog', priority: 'high' }),
      ticket('KB-2', { column: 'ready', role: 'be-developer', priority: 'critical' }),
      ticket('KB-3', { column: 'review' }),
    ],
    members: teamOf(['product-manager', 'be-developer', 'reviewer']),
  });
  const cfg = autopilotConfig({ maxDispatchesPerPulse: 5 });
  const before = JSON.stringify(b);
  const frozenBoard = deepFreeze(JSON.parse(before));
  const frozenConfig = deepFreeze(JSON.parse(JSON.stringify(cfg)));

  let first;
  let second;
  let threw = null;
  try {
    first = planPulse(frozenBoard, frozenConfig, T);
    second = planPulse(frozenBoard, frozenConfig, T);
  } catch (error) {
    threw = error;
  }
  check('AC1 planning frozen inputs does not attempt a mutation', threw === null, threw ? String(threw) : undefined);
  check('AC1 same (board, config, now) returns a deep-equal plan', same(first, second), brief(first?.generatedAt));
  check('AC1 plan carries generatedAt = now', first.generatedAt === T, String(first.generatedAt));
  check('AC1 a mixed plan has decisions', first.decisions.length === 3, brief(decisionIds(first)));
  const warmBefore = JSON.stringify(b);
  planPulse(b, cfg, T);
  check('AC1 planning leaves the board value unchanged', JSON.stringify(b) === warmBefore);
  check('AC1 planning leaves the config value unchanged', same(cfg, autopilotConfig({ maxDispatchesPerPulse: 5 })));
}

{
  // Action path: the dry-run must be read-only and must not create or prompt a
  // session. `Date.now`/settings.now are frozen, so a write would also change the
  // board file bytes (updatedAt), which the byte check catches independently.
  const { stateDir, app, counters } = await fixtureApp(
    () =>
      boardFixture({
        tickets: [ticket('KB-1', { column: 'ready', role: 'be-developer' })],
        members: teamOf(['be-developer']),
      }),
    { configure: { enabled: true } },
  );
  await app.state();
  const bytesBefore = await readFile(stateFile(stateDir), 'utf8');
  const writes = instrumentWrites(stateDir);
  let response;
  try {
    response = await app.action('autopilot', { op: 'plan' });
  } finally {
    writes.stop();
  }
  const bytesAfter = await readFile(stateFile(stateDir), 'utf8');
  check('AC1 dry-run responds 200', response.status === 200 && response.json?.ok === true, String(response.status));
  check('AC1 dry-run performed zero storage writes (fake store write count = 0)', writes.count === 0, `writes=${writes.count}`);
  check('AC1 dry-run leaves the persisted board byte-identical', bytesBefore === bytesAfter, `${bytesBefore.length}/${bytesAfter.length}`);
  check('AC1 fake agents.create was never called', counters.create === 0, `create=${counters.create}`);
  check('AC1 sessionController.prompt was never called', counters.prompts === 0, `prompts=${counters.prompts}`);
  capture('AC1 dry-run plan (single Ready ticket)', response.json.value);
}

// ===========================================================================
// AC 2 — deterministic ordering
// ===========================================================================
console.log('\n## AC 2 — ordering: rework, review, implement, refine');
{
  const b = boardFixture({
    tickets: [
      // Two rework candidates: priority decides the first, the implement lane
      // then has its one decision for this pulse (so the second is lane-capped).
      ticket('KB-1', {
        column: 'in_progress',
        priority: 'high',
        role: 'be-developer',
        movedAt: T - 500,
        reviews: [{ id: 'r1', verdict: 'changes-requested', at: T - 600, reviewerMemberId: 'member-2-reviewer' }],
      }),
      ticket('KB-2', {
        column: 'in_progress',
        priority: 'critical',
        role: 'be-developer',
        movedAt: T - 400,
        reviews: [{ id: 'r2', verdict: 'changes-requested', at: T - 800, reviewerMemberId: 'member-2-reviewer' }],
      }),
      ticket('KB-3', { column: 'review', priority: 'low', movedAt: T - 900 }),
      ticket('KB-4', { column: 'ready', priority: 'critical', role: 'be-developer', movedAt: T - 950 }),
      ticket('KB-5', { column: 'backlog', priority: 'low', movedAt: T - 300 }),
    ],
    members: teamOf(['product-manager', 'be-developer', 'reviewer']),
  });
  const plan = planPulse(b, autopilotConfig({ maxDispatchesPerPulse: 5 }), T);
  check(
    'AC2 exact decision order is [rework, review, refine]',
    same(decisionIds(plan), ['KB-2', 'KB-3', 'KB-5']),
    brief(decisionIds(plan)),
  );
  check(
    'AC2 rework group orders by priority rank before movedAt',
    plan.decisions[0].group === 'rework' && plan.decisions[0].ticketId === 'KB-2',
    brief(plan.decisions[0]),
  );
  check('AC2 the second implement-lane candidate is lane-capped', skipFor(plan, 'KB-1')?.reason === 'lane-cap', skipFor(plan, 'KB-1')?.reason);
  check('AC2 implement is capped after the rework decision', skipFor(plan, 'KB-4')?.reason === 'lane-cap', skipFor(plan, 'KB-4')?.reason);
  check('AC2 review outranks implement', plan.decisions[1].lane === 'review' && plan.decisions[2].lane === 'refine', brief(plan.decisions.map((d) => d.lane)));
}

{
  // Implement before refine, regardless of the refine ticket's priority.
  const b = boardFixture({
    tickets: [
      ticket('KB-1', { column: 'backlog', priority: 'critical', movedAt: T - 10 }),
      ticket('KB-2', { column: 'ready', priority: 'low', role: 'be-developer', movedAt: T - 20 }),
    ],
    members: teamOf(['product-manager', 'be-developer']),
  });
  const plan = planPulse(b, autopilotConfig({ maxDispatchesPerPulse: 5 }), T);
  check('AC2 implement precedes refine', same(decisionIds(plan), ['KB-2', 'KB-1']), brief(decisionIds(plan)));
}

{
  // Within one group: priority rank, then oldest movedAt, then ticket id.
  const byPriority = boardFixture({
    tickets: [
      ticket('KB-4', { column: 'ready', priority: 'high', role: 'be-developer', movedAt: T - 900 }),
      ticket('KB-5', { column: 'ready', priority: 'critical', role: 'be-developer', movedAt: T - 100 }),
    ],
    members: teamOf(['be-developer']),
  });
  const priorityPlan = planPulse(byPriority, autopilotConfig({ maxDispatchesPerPulse: 5 }), T);
  check('AC2 priority rank beats age inside a group', same(decisionIds(priorityPlan), ['KB-5']), brief(decisionIds(priorityPlan)));

  const byAge = boardFixture({
    tickets: [
      ticket('KB-6', { column: 'ready', priority: 'high', role: 'be-developer', movedAt: T - 100 }),
      ticket('KB-7', { column: 'ready', priority: 'high', role: 'be-developer', movedAt: T - 900 }),
    ],
    members: teamOf(['be-developer']),
  });
  const agePlan = planPulse(byAge, autopilotConfig({ maxDispatchesPerPulse: 5 }), T);
  check('AC2 oldest movedAt wins inside the same priority', same(decisionIds(agePlan), ['KB-7']), brief(decisionIds(agePlan)));

  const byId = boardFixture({
    tickets: [
      ticket('KB-10', { column: 'ready', priority: 'high', role: 'be-developer', movedAt: T - 900 }),
      ticket('KB-9', { column: 'ready', priority: 'high', role: 'be-developer', movedAt: T - 900 }),
    ],
    members: teamOf(['be-developer']),
  });
  const idPlan = planPulse(byId, autopilotConfig({ maxDispatchesPerPulse: 5 }), T);
  check('AC2 ticket id breaks a movedAt tie', same(decisionIds(idPlan), ['KB-9']), brief(decisionIds(idPlan)));
}

// ===========================================================================
// AC 3 — closed reason-code vocabulary and reachability
// ===========================================================================
console.log('\n## AC 3 — closed reason codes');
{
  const expectedAc3Codes = [
    'disabled',
    'board-paused',
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
    'loop-guard',
  ];
  check('AC3 the ticket’s 15 codes are in the closed list, in order', same(AUTOPILOT_SKIP_CODES.slice(0, 15), expectedAc3Codes), brief(AUTOPILOT_SKIP_CODES));
  check('AC3 pulse-cap completes the closed skip list', AUTOPILOT_SKIP_CODES.includes('pulse-cap') && AUTOPILOT_SKIP_CODES.length === 16, String(AUTOPILOT_SKIP_CODES.length));
  check(
    'KB-82 AC2 the reason export adds no-work without widening the frozen skip list',
    AUTOPILOT_REASON_CODES.includes('no-work') && !AUTOPILOT_SKIP_CODES.includes('no-work') && AUTOPILOT_SKIP_CODES.length === 16,
    brief({ reasonCount: AUTOPILOT_REASON_CODES.length, skipCount: AUTOPILOT_SKIP_CODES.length }),
  );
  check('AC3 admitted is the only activation code', same(AUTOPILOT_REASON_CODES.filter((code) => code === 'admitted'), ['admitted']));
  check('AC3 reason list has no duplicates', new Set(AUTOPILOT_REASON_CODES).size === AUTOPILOT_REASON_CODES.length);

  const observed = new Set();
  const observe = (plan) => {
    for (const skip of plan.skips) observed.add(skip.reason);
    for (const decision of plan.decisions) observed.add(decision.reason);
    return plan;
  };
  const beMember = () => teamOf(['be-developer']);
  const readyTicket = (overrides = {}) =>
    ticket('KB-1', { column: 'ready', priority: 'high', role: 'be-developer', movedAt: T - 9_000, ...overrides });
  const runningExecution = (overrides = {}) => ({
    sessionId: 'session-manual',
    status: 'running',
    role: 'be-developer',
    startedAt: T - 90_000,
    updatedAt: T - 60_000,
    finishedAt: null,
    report: '',
    error: '',
    blocked: null,
    ...overrides,
  });

  // disabled
  observe(planPulse(boardFixture({ tickets: [readyTicket()], members: beMember() }), autopilotConfig({ enabled: false }), T));
  // board-paused
  observe(planPulse(boardFixture({ paused: true, tickets: [readyTicket()], members: beMember() }), autopilotConfig(), T));
  // budget-exhausted
  observe(
    planPulse(
      boardFixture({ tickets: [readyTicket()], members: beMember() }),
      autopilotConfig({ budget: { hour: { limit: 2, used: 2, windowStart: T - 1_000 } } }),
      T,
    ),
  );
  // epic (critical so it is the first refine candidate and the reason is visible)
  observe(planPulse(boardFixture({ tickets: [ticket('KB-1', { column: 'backlog', type: 'epic', priority: 'critical' })], members: teamOf(['product-manager']) }), autopilotConfig(), T));
  // blocked
  observe(planPulse(boardFixture({ tickets: [readyTicket({ blocked: true })], members: beMember() }), autopilotConfig(), T));
  // active-execution (manual session with no roster link, so not member-busy)
  observe(
    planPulse(
      boardFixture({
        tickets: [readyTicket({ execution: runningExecution(), owner: { sessionId: 'session-manual', name: 'manual', role: 'be-developer', memberId: null } })],
        members: beMember(),
      }),
      autopilotConfig(),
      T,
    ),
  );
  // stale-execution
  observe(
    planPulse(
      boardFixture({
        tickets: [readyTicket({ execution: runningExecution({ updatedAt: T - 900_000 }) })],
        members: beMember(),
      }),
      autopilotConfig({ staleMs: 600_000 }),
      T,
    ),
  );
  // lane-cap (one review session already occupies the lane)
  observe(
    planPulse(
      boardFixture({
        tickets: [
          ticket('KB-1', { column: 'review', priority: 'critical', execution: runningExecution({ role: 'reviewer' }) }),
          ticket('KB-2', { column: 'review', priority: 'high' }),
        ],
        members: teamOf(['reviewer']),
      }),
      autopilotConfig(),
      T,
    ),
  );
  // wip-limit
  observe(
    planPulse(
      boardFixture({
        tickets: [readyTicket(), ticket('KB-2', { column: 'in_progress' }), ticket('KB-3', { column: 'in_progress' }), ticket('KB-4', { column: 'in_progress' })],
        members: beMember(),
      }),
      autopilotConfig(),
      T,
    ),
  );
  // ready-depth
  observe(
    planPulse(
      boardFixture({
        tickets: [ticket('KB-1', { column: 'backlog', priority: 'high' }), ticket('KB-2', { column: 'ready' }), ticket('KB-3', { column: 'ready' }), ticket('KB-4', { column: 'ready' })],
        members: teamOf(['product-manager', 'be-developer']),
      }),
      autopilotConfig({ maxReadyDepth: 3 }),
      T,
    ),
  );
  // no-member (the required role is missing entirely; no role-only fallback)
  observe(planPulse(boardFixture({ tickets: [readyTicket()], members: teamOf(['product-manager']) }), autopilotConfig(), T));
  // member-busy (the only reviewer is busy with a live ticket in another lane)
  observe(
    planPulse(
      boardFixture({
        tickets: [
          ticket('KB-1', { column: 'review', priority: 'high', role: 'reviewer' }),
          ticket('KB-2', {
            column: 'in_progress',
            owner: { sessionId: 'session-busy', name: 'member-0-reviewer', role: 'be-developer', memberId: 'member-0-reviewer' },
            execution: runningExecution({ sessionId: 'session-busy' }),
          }),
        ],
        members: teamOf(['reviewer']),
      }),
      autopilotConfig(),
      T,
    ),
  );
  // member-paused
  observe(planPulse(boardFixture({ tickets: [readyTicket()], members: teamOf(['be-developer'], { paused: true }) }), autopilotConfig(), T));
  // postcondition-failed (cooldown inside backoffMs, one persisted failure)
  const failureComment = (at, text = '[autopilot postcondition-failed] expected Review, found Ready') => ({ id: `c-${at}`, author: 'autopilot', text, at });
  const dispatchedPulse = (at) => ({ id: `PL-${at}`, at, trigger: 'timer', decisions: [], dispatched: [{ ticketId: 'KB-1', memberId: 'member-0-be-developer', sessionId: 'session-failed' }], error: '' });
  observe(
    planPulse(
      boardFixture({
        tickets: [readyTicket({ comments: [failureComment(T - 1_500)], movedAt: T - 50_000 })],
        members: beMember(),
        pulses: [dispatchedPulse(T - 2_000)],
      }),
      autopilotConfig({ backoffMs: 300_000 }),
      T,
    ),
  );
  // loop-guard (three persisted failures, no human action since)
  observe(
    planPulse(
      boardFixture({
        tickets: [readyTicket({ comments: [failureComment(T - 3_000), failureComment(T - 2_000), failureComment(T - 1_000)], movedAt: T - 50_000 })],
        members: beMember(),
        pulses: [dispatchedPulse(T - 1_000)],
      }),
      autopilotConfig(),
      T,
    ),
  );
  // pulse-cap (mixed lanes, one dispatch per pulse)
  observe(
    planPulse(
      boardFixture({
        tickets: [ticket('KB-1', { column: 'review', priority: 'critical' }), readyTicket({ movedAt: T - 8_000 }), ticket('KB-3', { column: 'backlog', priority: 'critical' })],
        members: teamOf(['product-manager', 'be-developer', 'reviewer']),
      }),
      autopilotConfig({ maxDispatchesPerPulse: 1 }),
      T,
    ),
  );

  const missing = AUTOPILOT_SKIP_CODES.filter((code) => !observed.has(code));
  check('AC3 every closed skip code is reachable from a plan', missing.length === 0, missing.join(',') || 'none missing');
  check('AC3 admitted is emitted for activation decisions', observed.has('admitted'), [...observed].join(','));
  check('AC3 no code outside the closed vocabulary is emitted', [...observed].every((code) => AUTOPILOT_REASON_CODES.includes(code)), [...observed].join(','));
  capture('AC3 reason codes observed', [...observed].sort().join(', '));
}

// ===========================================================================
// AC 4 — admission enforced in the plan itself
// ===========================================================================
console.log('\n## AC 4 — lane caps, pulse cap, ready depth, member busy, no shared member');
{
  const twoImplementers = teamOf(['be-developer'], {});
  twoImplementers.push(member('member-extra-be', 'be-developer'));
  const b = boardFixture({
    tickets: [
      ticket('KB-1', { column: 'ready', priority: 'critical', role: 'be-developer' }),
      ticket('KB-2', { column: 'ready', priority: 'high', role: 'be-developer' }),
    ],
    members: twoImplementers,
  });
  const plan = planPulse(b, autopilotConfig({ maxDispatchesPerPulse: 5 }), T);
  check('AC4 at most one implement-lane decision per pulse', plan.decisions.filter((decision) => decision.lane === 'implement').length === 1, String(plan.decisions.length));
  check('AC4 the second implement candidate is lane-capped', skipFor(plan, 'KB-2')?.reason === 'lane-cap', skipFor(plan, 'KB-2')?.reason);

  // Lane cap 1 holds even when the configured cap is larger (phase 1 is serial).
  const highCap = planPulse(
    boardFixture({
      tickets: [ticket('KB-1', { column: 'review', priority: 'critical' }), ticket('KB-2', { column: 'review', priority: 'high' })],
      members: [member('member-rev-1', 'reviewer'), member('member-rev-2', 'reviewer')],
    }),
    autopilotConfig({ laneCaps: { review: 3 }, maxDispatchesPerPulse: 5 }),
    T,
  );
  check('AC4 phase 1 keeps one review decision even with a larger configured cap', highCap.decisions.length === 1, String(highCap.decisions.length));

  // maxDispatchesPerPulse caps the whole plan.
  const mixed = planPulse(
    boardFixture({
      tickets: [ticket('KB-1', { column: 'review', priority: 'critical' }), ticket('KB-2', { column: 'ready', role: 'be-developer', priority: 'high' }), ticket('KB-3', { column: 'backlog', priority: 'high' })],
      members: teamOf(['product-manager', 'be-developer', 'reviewer']),
    }),
    autopilotConfig({ maxDispatchesPerPulse: 1 }),
    T,
  );
  check('AC4 plan never exceeds maxDispatchesPerPulse', mixed.decisions.length <= 1, String(mixed.decisions.length));
  check('AC4 deferred candidates are reported as pulse-cap', mixed.skips.filter((skip) => skip.reason === 'pulse-cap').length === 2, brief(skipReasons(mixed)));

  // maxReadyDepth: refine stands down while Ready is at or above the ceiling.
  const depthPlan = planPulse(
    boardFixture({
      tickets: [ticket('KB-1', { column: 'backlog', priority: 'critical' }), ticket('KB-2', { column: 'ready' }), ticket('KB-3', { column: 'ready' })],
      members: teamOf(['product-manager', 'be-developer']),
    }),
    autopilotConfig({ maxReadyDepth: 2, maxDispatchesPerPulse: 5 }),
    T,
  );
  check('AC4 refine is skipped at count(ready) >= maxReadyDepth', skipFor(depthPlan, 'KB-1')?.reason === 'ready-depth', skipFor(depthPlan, 'KB-1')?.reason);

  // A member with a running/idle/blocked/paused execution is member-busy.
  for (const status of ['running', 'idle', 'blocked', 'paused']) {
    const busyPlan = planPulse(
      boardFixture({
        tickets: [
          // The candidate is a review ticket so the busy implementer's live
          // session occupies the implement lane, not the candidate's own lane.
          ticket('KB-1', { column: 'review', role: 'reviewer' }),
          ticket('KB-2', {
            column: 'in_progress',
            owner: { sessionId: 'session-busy', name: 'rev', role: 'be-developer', memberId: 'member-0-reviewer' },
            execution: { sessionId: 'session-busy', status, role: 'be-developer', startedAt: T - 90_000, updatedAt: T - 1_000 },
          }),
        ],
        members: teamOf(['reviewer']),
      }),
      autopilotConfig(),
      T,
    );
    check(`AC4 member holding a ${status} execution is member-busy`, skipFor(busyPlan, 'KB-1')?.reason === 'member-busy', skipFor(busyPlan, 'KB-1')?.reason);
  }

  // No two decisions target the same member (across every generated plan too).
  const seen = mixed.decisions.map((decision) => decision.memberId);
  check('AC4 one decision per member', new Set(seen).size === seen.length, brief(seen));
}

// ===========================================================================
// AC 5 — role routing from the policy tables
// ===========================================================================
console.log('\n## AC 5 — role routing and reviewer separation');
{
  const planFor = (tickets, members, cfg = autopilotConfig({ maxDispatchesPerPulse: 5 })) =>
    planPulse(boardFixture({ tickets, members }), cfg, T);

  const backlogPlan = planFor([ticket('KB-1', { column: 'backlog' })], teamOf(['product-manager']));
  check('AC5 backlog routes to product-manager', backlogPlan.decisions[0]?.role === 'product-manager', backlogPlan.decisions[0]?.role);

  const reviewPlan = planFor([ticket('KB-1', { column: 'review' })], teamOf(['reviewer']));
  check('AC5 review routes to reviewer', reviewPlan.decisions[0]?.role === 'reviewer', reviewPlan.decisions[0]?.role);

  const testerPlan = planFor([ticket('KB-1', { column: 'review', role: 'tester' })], teamOf(['tester']));
  check('AC5 review routes to tester when the ticket asks for a tester', testerPlan.decisions[0]?.role === 'tester', testerPlan.decisions[0]?.role);

  const separatedPlan = planFor(
    [ticket('KB-1', { column: 'review', owner: { sessionId: 'session-impl', name: 'implementer', role: 'be-developer', memberId: 'member-rev' } })],
    [member('member-rev', 'reviewer')],
  );
  check(
    'AC5 the implementer cannot review their own version',
    separatedPlan.decisions.length === 0 && ['member-busy', 'no-member'].includes(skipFor(separatedPlan, 'KB-1')?.reason),
    brief(skipReasons(separatedPlan)),
  );

  // Separation also uses the session id: a reviewer whose linked session is the
  // one that implemented the current version is never selected.
  const sessionSeparated = planFor(
    [
      ticket('KB-1', {
        column: 'review',
        owner: { sessionId: 'session-owner', name: 'implementer', role: 'be-developer', memberId: 'member-ghost' },
        execution: { sessionId: 'session-impl', status: 'done', role: 'be-developer', startedAt: T - 90_000, updatedAt: T - 10_000 },
      }),
    ],
    [member('member-rev', 'reviewer', { sessionId: 'session-impl' })],
  );
  check(
    'AC5 the implementing session cannot review its own version',
    sessionSeparated.decisions.length === 0 && skipFor(sessionSeparated, 'KB-1')?.reason === 'no-member',
    skipFor(sessionSeparated, 'KB-1')?.reason,
  );

  const secondReviewerPlan = planFor(
    [ticket('KB-1', { column: 'review', owner: { sessionId: 'session-impl', name: 'implementer', role: 'be-developer', memberId: 'member-rev-a' } })],
    [member('member-rev-a', 'reviewer'), member('member-rev-b', 'reviewer', { lastActivatedAt: 5 })],
  );
  check('AC5 another reviewer is selected when one exists', secondReviewerPlan.decisions[0]?.memberId === 'member-rev-b', brief(secondReviewerPlan.decisions[0]));

  const roleRespected = planFor([ticket('KB-1', { column: 'ready', role: 'bug-fixer' })], teamOf(['bug-fixer', 'fullstack-developer']));
  check('AC5 a Ready implementation role is respected', roleRespected.decisions[0]?.role === 'bug-fixer', roleRespected.decisions[0]?.role);

  const inferred = planFor(
    [ticket('KB-1', { column: 'ready', role: null, title: 'Backend API migration for the payment service' })],
    teamOf(['be-developer']),
  );
  check('AC5 a roleless Ready ticket is routed by inference', inferred.decisions[0]?.role === 'be-developer', inferred.decisions[0]?.role);

  const fallback = planFor(
    [ticket('KB-1', { column: 'ready', role: null, title: 'Polish the experience' })],
    teamOf(['fullstack-developer']),
  );
  check('AC5 roleless, uninferable Ready work falls back to fullstack-developer', fallback.decisions[0]?.role === 'fullstack-developer', fallback.decisions[0]?.role);

  const techLeadOnly = planFor(
    [ticket('KB-1', { column: 'ready', role: 'tech-lead', title: 'Misc work' })],
    teamOf(['tech-lead']),
  );
  check('AC5 tech-lead is never auto-dispatched', techLeadOnly.decisions.length === 0 && skipFor(techLeadOnly, 'KB-1')?.reason === 'no-member', brief(skipReasons(techLeadOnly)));

  // Every routed role must be able to claim its lane according to roles.js.
  const routingPlan = planFor(
    [
      ticket('KB-1', { column: 'backlog' }),
      ticket('KB-2', { column: 'ready', role: 'ux-designer' }),
      ticket('KB-3', { column: 'ready', role: 'sre' }),
      ticket('KB-4', { column: 'review' }),
    ],
    teamOf(['product-manager', 'ux-designer', 'sre', 'reviewer']),
    autopilotConfig({ maxDispatchesPerPulse: 5, laneCaps: { refine: 1, implement: 1, review: 1 } }),
  );
  const claimable = routingPlan.decisions.every((decision) => {
    const laneColumn = decision.lane === 'refine' ? 'backlog' : decision.lane === 'review' ? 'review' : 'ready';
    return LANE_CLAIM_ROLES[laneColumn].includes(decision.role);
  });
  check('AC5 every routed role can claim its lane', claimable, brief(routingPlan.decisions.map((decision) => `${decision.role}:${decision.lane}`)));
}

// ===========================================================================
// AC 6 — deterministic, fair member selection
// ===========================================================================
console.log('\n## AC 6 — least-recently-activated member wins, no role-only fallback');
{
  const planFor = (tickets, members) =>
    planPulse(boardFixture({ tickets, members }), autopilotConfig({ maxDispatchesPerPulse: 5 }), T);

  const oldest = planFor(
    [ticket('KB-1', { column: 'ready', role: 'be-developer' })],
    [member('member-be-newer', 'be-developer', { lastActivatedAt: 900 }), member('member-be-older', 'be-developer', { lastActivatedAt: 100 })],
  );
  check('AC6 oldest lastActivatedAt is chosen', oldest.decisions[0]?.memberId === 'member-be-older', oldest.decisions[0]?.memberId);

  const lowestId = planFor(
    [ticket('KB-1', { column: 'ready', role: 'be-developer' })],
    [member('member-z', 'be-developer', { lastActivatedAt: 0 }), member('member-a', 'be-developer', { lastActivatedAt: 0 })],
  );
  check('AC6 lowest member id breaks an activation tie', lowestId.decisions[0]?.memberId === 'member-a', lowestId.decisions[0]?.memberId);

  const pausedExcluded = planFor(
    [ticket('KB-1', { column: 'ready', role: 'be-developer' })],
    [member('member-paused', 'be-developer', { lastActivatedAt: 1, paused: true }), member('member-free', 'be-developer', { lastActivatedAt: 50 })],
  );
  check('AC6 a paused member is filtered before selection', pausedExcluded.decisions[0]?.memberId === 'member-free', pausedExcluded.decisions[0]?.memberId);

  const allPaused = planFor(
    [ticket('KB-1', { column: 'ready', role: 'be-developer' })],
    [member('member-paused', 'be-developer', { paused: true })],
  );
  check('AC6 all paused members yields member-paused', skipFor(allPaused, 'KB-1')?.reason === 'member-paused', skipFor(allPaused, 'KB-1')?.reason);

  // Pause precedence: a paused owner stops the ticket even when a free member of
  // the required role exists (KB-67 §5.5.8) and even while its execution is stale.
  const pausedOwner = planFor(
    [
      ticket('KB-1', {
        column: 'ready',
        role: 'be-developer',
        owner: { sessionId: 'session-paused-owner', name: 'paused owner', role: 'be-developer', memberId: null },
        execution: { sessionId: 'session-paused-owner', status: 'running', role: 'be-developer', startedAt: T - 900_000, updatedAt: T - 900_000 },
      }),
    ],
    [member('member-paused', 'be-developer', { paused: true, sessionId: 'session-paused-owner' }), member('member-free', 'be-developer')],
  );
  check('AC6 a paused owner stops the ticket before staleness', skipFor(pausedOwner, 'KB-1')?.reason === 'member-paused', skipFor(pausedOwner, 'KB-1')?.reason);

  const wrongRole = planFor([ticket('KB-1', { column: 'ready', role: 'be-developer' })], teamOf(['product-manager']));
  check('AC6 no matching member yields no-member (no role-only fallback)', wrongRole.decisions.length === 0 && skipFor(wrongRole, 'KB-1')?.reason === 'no-member', brief(skipReasons(wrongRole)));
}

{
  // lastActivatedAt is a persisted member field the planner can read after a
  // board round-trip, so fairness survives a restart.
  const { app } = await fixtureApp(
    () =>
      boardFixture({
        tickets: [ticket('KB-1', { column: 'ready', role: 'be-developer' })],
        members: [member('member-a', 'be-developer', { lastActivatedAt: 1_234 }), member('member-b', 'be-developer', { lastActivatedAt: 9_999 })],
      }),
    { configure: { enabled: true } },
  );
  const snapshot = await app.state();
  const persisted = snapshot.board.team.members.find((entry) => entry.id === 'member-a');
  check('AC6 lastActivatedAt survives a persisted board round-trip', persisted?.lastActivatedAt === 1_234, brief(persisted?.lastActivatedAt));
}

// ===========================================================================
// AC 7 — persisted backoff cooldown and loop guard
// ===========================================================================
console.log('\n## AC 7 — postcondition cooldown and loop guard from persisted state');
{
  const failureComment = (at) => ({ id: `c-${at}`, author: 'autopilot', text: '[autopilot postcondition-failed] expected Review, found Ready', at });
  const dispatchedPulse = (at) => ({ id: `PL-${at}`, at, trigger: 'timer', decisions: [], dispatched: [{ ticketId: 'KB-1', memberId: 'member-0-be-developer', sessionId: 'session-failed' }], error: '' });
  const buildBoard = (comments, movedAt = T - 50_000) =>
    boardFixture({
      tickets: [ticket('KB-1', { column: 'ready', role: 'be-developer', comments, movedAt })],
      members: teamOf(['be-developer']),
      pulses: [dispatchedPulse(T - 2_000)],
    });
  const cfg = autopilotConfig({ backoffMs: 300_000 });

  const cooling = planPulse(buildBoard([failureComment(T - 1_500)]), cfg, T);
  check('AC7 a ticket cooled down by backoffMs is not chosen', cooling.decisions.length === 0 && skipFor(cooling, 'KB-1')?.reason === 'postcondition-failed', skipFor(cooling, 'KB-1')?.reason);

  const afterCooldown = planPulse(buildBoard([failureComment(T - 1_500)]), cfg, T - 2_000 + 300_000);
  check('AC7 the ticket is retried once the cooldown elapsed', afterCooldown.decisions[0]?.ticketId === 'KB-1', brief(afterCooldown.decisions));

  const loopGuarded = planPulse(buildBoard([failureComment(T - 3_000), failureComment(T - 2_000), failureComment(T - 1_000)]), cfg, T);
  check('AC7 three failures trip the loop guard', loopGuarded.decisions.length === 0 && skipFor(loopGuarded, 'KB-1')?.reason === 'loop-guard', skipFor(loopGuarded, 'KB-1')?.reason);

  const resetByHuman = planPulse(
    buildBoard(
      [
        failureComment(T - 3_000),
        failureComment(T - 2_000),
        failureComment(T - 1_000),
        { id: 'human', author: 'be · KB-1', text: 'Human took over.', at: T - 500 },
      ],
      T - 400,
    ),
    cfg,
    T,
  );
  check('AC7 a human comment resets the loop guard', resetByHuman.decisions[0]?.ticketId === 'KB-1', brief(resetByHuman.decisions.length));

  // Cooldown is read from the persisted pulse ring: with no dispatch evidence
  // the same board dispatch is admitted again.
  const withoutDispatch = planPulse(
    { ...buildBoard([failureComment(T - 1_500)]), pulses: [] },
    cfg,
    T,
  );
  check('AC7 cooldown evidence comes from persisted pulses, not memory', withoutDispatch.decisions[0]?.ticketId === 'KB-1', brief(withoutDispatch.decisions.length));
}

// ===========================================================================
// AC 8 — dry-run action is the planner and mutates nothing
// ===========================================================================
console.log('\n## AC 8 — autopilot {op:"plan"} dry-run');
{
  const evidenceBoard = () =>
    boardFixture({
      tickets: [
        ticket('KB-1', { column: 'backlog', priority: 'high', title: 'Backlog ticket' }),
        ticket('KB-2', { column: 'ready', priority: 'high', role: 'be-developer', title: 'Ready ticket' }),
        ticket('KB-3', { column: 'review', priority: 'medium', title: 'Review ticket', owner: { sessionId: 'session-impl', name: 'implementer', role: 'be-developer', memberId: 'member-impl-ghost' } }),
        ticket('KB-4', { column: 'ready', priority: 'critical', role: 'be-developer', blocked: true, title: 'Blocked ticket' }),
        ticket('KB-5', { column: 'backlog', type: 'epic', priority: 'critical', title: 'EPIC ticket' }),
      ],
      members: [
        member('member-pm', 'product-manager'),
        member('member-be', 'be-developer'),
        member('member-rev', 'reviewer'),
        member('member-tester', 'tester'),
      ],
    });
  const { stateDir, app, counters } = await fixtureApp(evidenceBoard, {
    configure: { enabled: true, maxDispatchesPerPulse: 5 },
  });
  const snapshot = await app.state();
  const bytesBefore = await readFile(stateFile(stateDir), 'utf8');
  const writes = instrumentWrites(stateDir);
  let response;
  try {
    response = await app.action('autopilot', { op: 'plan' });
  } finally {
    writes.stop();
  }
  const value = response.json?.value;
  check('AC8 plan action responds ok', response.status === 200 && response.json?.ok === true, String(response.status));
  check('AC8 plan body is exactly {generatedAt, decisions, skips}', same(Object.keys(value ?? {}).sort(), ['decisions', 'generatedAt', 'skips']), brief(Object.keys(value ?? {})));
  check('AC8 plan performed no dispatch', counters.create === 0 && counters.prompts === 0, `create=${counters.create} prompts=${counters.prompts}`);
  check('AC8 plan performed zero storage writes', writes.count === 0, `writes=${writes.count}`);
  check('AC8 board file is unchanged by the dry-run', (await readFile(stateFile(stateDir), 'utf8')) === bytesBefore);
  check(
    'AC8 ordered decisions: review, implement, refine',
    same(value.decisions.map((decision) => `${decision.group}:${decision.ticketId}`), ['review:KB-3', 'implement:KB-2', 'refine:KB-1']),
    brief(value.decisions.map((decision) => `${decision.group}:${decision.ticketId}`)),
  );
  check(
    'AC8 skipped candidates carry blocked/epic reason codes',
    same(value.skips.map((skip) => `${skip.reason}:${skip.ticketId}`).sort(), ['blocked:KB-4', 'epic:KB-5']),
    brief(value.skips.map((skip) => `${skip.reason}:${skip.ticketId}`)),
  );
  const direct = planPulse(snapshot.board, snapshot.board.autopilot, T);
  check('AC8 the dry-run equals the planner an executor would call', same(value, direct));
  capture('AC8 dry-run JSON for the representative board', value);
  capture('AC8 dry-run JSON (compact)', JSON.stringify(value));
}

{
  // Dry-run while disabled: allowed, reports `disabled`, writes nothing.
  const { stateDir, app } = await fixtureApp(() =>
    boardFixture({
      tickets: [ticket('KB-1', { column: 'ready', role: 'be-developer' })],
      members: teamOf(['be-developer']),
      autopilot: autopilotConfig({ enabled: false }),
    }),
  );
  const writes = instrumentWrites(stateDir);
  let disabledPlan;
  try {
    disabledPlan = await app.action('autopilot', { op: 'plan' });
  } finally {
    writes.stop();
  }
  check('AC8 dry-run is available while autopilot is disabled', disabledPlan.status === 200, String(disabledPlan.status));
  check('AC8 disabled dry-run reports the disabled board gate', same(disabledPlan.json.value.skips.map((skip) => skip.reason), ['disabled']), brief(skipReasons(disabledPlan.json.value)));
  check('AC8 disabled dry-run writes nothing', writes.count === 0, `writes=${writes.count}`);
}

{
  // Dry-run while the board is paused: allowed, reports `board-paused`, no write.
  const { stateDir, app } = await fixtureApp(
    () =>
      boardFixture({
        tickets: [ticket('KB-1', { column: 'ready', role: 'be-developer' })],
        members: teamOf(['be-developer']),
      }),
    { configure: { enabled: true } },
  );
  await app.state();
  await app.action('pauseBoard');
  const writes = instrumentWrites(stateDir);
  let pausedPlan;
  try {
    pausedPlan = await app.action('autopilot', { op: 'plan' });
  } finally {
    writes.stop();
  }
  check('AC8 dry-run is available while the board is paused', pausedPlan.status === 200, String(pausedPlan.status));
  check('AC8 paused dry-run reports the board-paused gate', same(pausedPlan.json.value.skips.map((skip) => skip.reason), ['board-paused']), brief(skipReasons(pausedPlan.json.value)));
  check('AC8 paused dry-run writes nothing', writes.count === 0, `writes=${writes.count}`);
}

// ===========================================================================
// AC 9 — randomized property test over 500 generated boards
// ===========================================================================
console.log('\n## AC 9 — 500-board property test');
{
  const SEED = 0x5eed69;
  const BOARDS = 500;
  const mulberry32 = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const rng = mulberry32(SEED);
  const rand = (limit) => Math.floor(rng() * limit);
  const pick = (list) => list[rand(list.length)];
  const maybe = (probability) => rng() < probability;

  const randomBoard = () => {
    const members = [];
    const memberCount = 1 + rand(5);
    for (let index = 0; index < memberCount; index += 1) {
      members.push(
        member(`member-${index}`, pick(ROLES), {
          paused: maybe(0.15),
          sessionId: maybe(0.4) ? `session-${index}` : null,
          lastActivatedAt: rand(1_000),
        }),
      );
    }
    const tickets = [];
    const ticketCount = rand(13);
    for (let index = 0; index < ticketCount; index += 1) {
      const type = maybe(0.08) ? 'epic' : pick(['task', 'story', 'bug', 'spike']);
      const column = pick(['backlog', 'ready', 'in_progress', 'review', 'done']);
      const execution = maybe(0.22)
        ? {
            sessionId: `session-${rand(6)}`,
            status: pick(['running', 'idle', 'blocked', 'paused', 'done', 'failed', 'cancelled']),
            role: pick(ROLES),
            startedAt: T - rand(500_000),
            updatedAt: T - rand(500_000),
            finishedAt: null,
            report: '',
            error: '',
            blocked: null,
          }
        : null;
      const reviews = [];
      if (maybe(0.3)) reviews.push({ id: `r-${index}`, at: T - rand(100_000), verdict: pick(['accepted', 'changes-requested']) });
      if (maybe(0.15)) reviews.push({ id: `r2-${index}`, at: T - rand(100_000), verdict: pick(['accepted', 'changes-requested']) });
      const comments = [];
      if (maybe(0.18)) {
        comments.push({ id: `c-${index}`, author: 'autopilot', text: '[autopilot postcondition-failed] expected Review', at: T - rand(100_000) });
      }
      const ownerMember = maybe(0.5) ? pick(members) : null;
      tickets.push(
        ticket(`KB-${index + 1}`, {
          type,
          column,
          priority: pick(['low', 'medium', 'high', 'critical']),
          role: maybe(0.6) ? pick(ROLES) : null,
          blocked: maybe(0.1),
          movedAt: T - rand(200_000),
          reviews,
          comments,
          execution,
          owner: ownerMember
            ? {
                sessionId: ownerMember.sessionId ?? `session-owner-${ownerMember.id}`,
                name: ownerMember.name,
                role: ownerMember.roleId,
                memberId: ownerMember.id,
              }
            : null,
          assignment: maybe(0.2) ? { role: pick(ROLES), memberId: pick(members).id } : null,
        }),
      );
    }
    const pulses = [];
    const pulseCount = rand(3);
    for (let index = 0; index < pulseCount; index += 1) {
      pulses.push({
        id: `PL-${index + 1}`,
        at: T - rand(100_000),
        trigger: 'timer',
        decisions: [],
        dispatched:
          tickets.length > 0 && maybe(0.5)
            ? [{ ticketId: tickets[rand(tickets.length)].id, memberId: 'member-0', sessionId: 'session-x' }]
            : [],
        error: '',
      });
    }
    return {
      board: boardFixture({
        tickets,
        members,
        pulses,
        paused: maybe(0.05),
        wip: { backlog: 0, ready: 0, in_progress: rand(5), review: rand(6), done: 0 },
        autopilot: autopilotConfig(),
      }),
      config: autopilotConfig({
        enabled: maybe(0.9),
        maxReadyDepth: rand(5),
        laneCaps: { refine: rand(3), implement: rand(3), review: rand(3) },
        maxDispatchesPerPulse: 1 + rand(5),
        budget: {
          hour: { limit: 1 + rand(5), used: rand(6), windowStart: T - rand(4_000_000) },
          day: { limit: 1 + rand(10), used: rand(11), windowStart: T - rand(90_000_000) },
        },
        backoffMs: 60_000 + rand(1_000_000),
        staleMs: 60_000 + rand(1_000_000),
      }),
    };
  };

  const propertyFailures = [];
  const startedAt = process.hrtime.bigint();
  for (let index = 0; index < BOARDS; index += 1) {
    const { board: generated, config } = randomBoard();
    const before = JSON.stringify(generated);
    const plan = planPulse(generated, config, T);
    const again = planPulse(generated, config, T);
    const fail = (message) => propertyFailures.push(`board#${index}: ${message}`);
    if (JSON.stringify(generated) !== before) fail('plan mutated the board');
    if (!same(plan, again)) fail('same inputs did not produce a deep-equal plan');
    if (config.enabled !== true) continue;
    if (generated.paused === true) {
      if (plan.decisions.length !== 0) fail('paused board produced a decision');
      continue;
    }
    if (plan.decisions.length > config.maxDispatchesPerPulse) fail('more decisions than maxDispatchesPerPulse');
    const laneCounts = { refine: 0, implement: 0, review: 0 };
    const memberIds = new Set();
    const ticketIds = new Set();
    for (const decision of plan.decisions) {
      if (!AUTOPILOT_REASON_CODES.includes(decision.reason)) fail(`invalid decision reason ${decision.reason}`);
      if (decision.reason !== 'admitted') fail(`unexpected activation reason ${decision.reason}`);
      laneCounts[decision.lane] += 1;
      if (laneCounts[decision.lane] > 1) fail(`lane ${decision.lane} has more than one decision`);
      if (memberIds.has(decision.memberId)) fail(`member ${decision.memberId} targeted twice`);
      memberIds.add(decision.memberId);
      if (ticketIds.has(decision.ticketId)) fail(`ticket ${decision.ticketId} targeted twice`);
      ticketIds.add(decision.ticketId);
      const target = generated.tickets.find((entry) => entry.id === decision.ticketId);
      if (!target) {
        fail(`decision for unknown ticket ${decision.ticketId}`);
        continue;
      }
      if (target.type === 'epic') fail(`decision for EPIC ${target.id}`);
      if (target.blocked === true) fail(`decision for blocked ticket ${target.id}`);
      if (target.execution && ['running', 'idle', 'blocked', 'paused'].includes(target.execution.status)) {
        fail(`decision for a ticket with a live ${target.execution.status} execution`);
      }
      const claimLane = decision.lane === 'refine' ? 'backlog' : decision.lane === 'review' ? 'review' : 'ready';
      if (!LANE_CLAIM_ROLES[claimLane].includes(decision.role)) fail(`role ${decision.role} cannot claim ${claimLane}`);
      const targetMember = generated.team.members.find((entry) => entry.id === decision.memberId);
      if (!targetMember) fail(`decision for unknown member ${decision.memberId}`);
      else if (targetMember.paused === true) fail(`decision for paused member ${targetMember.id}`);
      if (decision.lane === 'review' && target.owner?.memberId && decision.memberId === target.owner.memberId) {
        fail(`reviewer is the implementer of the current version on ${target.id}`);
      }
    }
    for (const skip of plan.skips) {
      if (!AUTOPILOT_SKIP_CODES.includes(skip.reason)) fail(`invalid skip reason ${skip.reason}`);
    }
    plan.decisions.forEach((decision, position) => {
      if (decision.order !== position + 1) fail('decision order is not contiguous');
    });
  }
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  capture('AC9 property test seed/count', `seed=${SEED} boards=${BOARDS} failures=${propertyFailures.length} elapsedMs=${elapsedMs.toFixed(1)}`);
  check(
    'AC9 500 randomized boards hold every admission invariant',
    propertyFailures.length === 0,
    propertyFailures.slice(0, 8).join(' | '),
  );
  check('AC9 property test completed without wall-clock sleeps', elapsedMs < 60_000, `${elapsedMs.toFixed(1)}ms`);
}

// ===========================================================================
// Summary
// ===========================================================================
console.log('\n' + (failures.length === 0 ? 'ALL AUTOPILOT PLANNER CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
for (const dir of dirs) await rm(dir, { recursive: true, force: true });
Date.now = realDateNow;
process.exit(failures.length === 0 ? 0 : 1);
