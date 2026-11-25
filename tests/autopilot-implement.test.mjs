/**
 * KB-72 — autopilot implement lane: a role-matched implementer pulls a Ready
 * ticket, implements it in the workspace, and hands it to Review.
 *
 * Dependency-free harness in the same style as `tests/autopilot-refine.test.mjs`:
 * a temporary state directory, a fake Harness ctx, and an INJECTED clock plus an
 * INJECTED scheduler (no wall-clock sleep anywhere). The fake implementer session
 * is a real kanban-tool caller: during the dispatch prompt it runs `claim`,
 * `comment`, `move` and `finish`, so every assertion crosses host → tool →
 * persisted board → pulse, not a mocked handler. The pure planner is exercised
 * directly for the ordering/role-matrix assertions.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  eligible Ready dispatch: exactly one session, the role-matched member,
 *         accessMode workspace-write, and the implement brief carrying the ticket
 *         content, the acceptance criteria verbatim, the evidence plan verbatim,
 *         the previous execution report and the handoff reason
 *   AC 2  strict role matching: a fullstack ticket with no fullstack member is
 *         `no-member` (never downgraded to a free fe/be member); every Ready
 *         implementation role routes to a member of exactly that role
 *   AC 3  phase-1 single implementer: two Ready tickets + two implementer members
 *         dispatch one session and record exactly one `lane-cap:implement` skip
 *   AC 4  a human-initiated Run is never blocked by the autopilot lane cap, runs
 *         concurrently with one autopilot implementer, and its ticket is excluded
 *         from autopilot planning as `active-execution`
 *   AC 5  implement postcondition: a session that ends with the ticket still in
 *         Ready records one `[autopilot postcondition-failed]` comment (with the
 *         last report/error), an implement outcome, and no re-dispatch inside
 *         backoffMs; the retry after backoff starts a second session
 *   AC 6  priority override: critical before high regardless of age, oldest
 *         movedAt inside one priority, blocked and EPIC tickets never selected
 *   AC 7  role inference: a roleless Ready ticket gets the inferred implementation
 *         role, the ticket stores it, and the pulse decision records the inference
 *   AC 8  `node --test tests/autopilot-implement.test.mjs` passes; captured
 *         dispatch arguments (role, member, accessMode) and the brief excerpt
 *   plus  verdict-row byte stability across a reload (additive pulse fields) and a
 *         legacy execution row that is never misread as an autopilot lane session
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, planPulse, evaluateImplementPostcondition } from '../index.js';

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

const WORKSPACE_ID = 'workspace-implement';
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
    title: 'Implement Fixture',
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
  const root = await tempDir('kanban-kb72-root-');
  const stateDir = await tempDir('kanban-kb72-state-');
  await writeFile(join(root, 'README.md'), '# Implement fixture\n', 'utf8');
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
const decisionsWithReason = (pulse, reason) => (pulse?.decisions ?? []).filter((entry) => entry.reason === reason);

/** Run one kanban-tool action as the dispatched session (a real tool caller). */
async function kanban(app, sessionId, args) {
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

/** A complete, honest implementation: claim, comment evidence, move to Review, finish. */
async function implementProperly(app, stateDir, sessionId, { moveTo = 'review', role } = {}) {
  const target = await ticketForSession(stateDir, sessionId);
  if (!target) throw new Error(`no ticket linked to ${sessionId}`);
  const claim = await kanban(app, sessionId, { action: 'claim', ticketId: target.id });
  const comment = await kanban(app, sessionId, {
    action: 'comment',
    ticketId: target.id,
    text: `Evidence: node --test tests/autopilot-implement.test.mjs passed${role ? ` as ${role}` : ''}.`,
  });
  const moved = moveTo === 'review'
    ? await kanban(app, sessionId, { action: 'move', ticketId: target.id, column: 'review' })
    : null;
  const finish = moveTo === 'review'
    ? await kanban(app, sessionId, {
        action: 'finish',
        ticketId: target.id,
        summary: `Implemented ${target.id}: the change landed and node --test tests/autopilot-implement.test.mjs passed.`,
      })
    : null;
  return { target, claim, comment, moved, finish };
}

const memberByRole = (board, roleId) => board.team.members.find((member) => member.roleId === roleId) ?? null;

/** Repurpose one seeded member onto a different role (fixture-only roster edit). */
async function repurposeMember(app, fromRole, toRoleId) {
  const snapshot = await app.state();
  const member = memberByRole(snapshot.board, fromRole);
  if (!member) throw new Error(`no seeded member with role ${fromRole}`);
  const result = await app.action('updateMember', { memberId: member.id, patch: { roleId: toRoleId } });
  if (result.status !== 200) throw new Error(`updateMember failed: ${result.status} ${brief(result.json)}`);
  return result.json.value.member;
}

// ---------------------------------------------------------------------------
// Pure planner fixtures (AC 2 / AC 6 / AC 7 role matrix and ordering)
// ---------------------------------------------------------------------------
const PLAN_T = 1_780_000_000_000;

const PLAN_AUTOPILOT = {
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
};

function planMember(id, roleId, overrides = {}) {
  return {
    id,
    name: overrides.name ?? id,
    title: '',
    roleId,
    persona: 'Planner fixture persona.',
    paused: overrides.paused ?? false,
    sessionId: overrides.sessionId ?? null,
    lastActivatedAt: overrides.lastActivatedAt ?? 0,
    ...overrides,
  };
}

function planTicket(id, overrides = {}) {
  const number = Number(String(id).replace(/\D/g, '')) || 1;
  return {
    id,
    number,
    title: overrides.title ?? `Ticket ${id}`,
    description: overrides.description ?? '',
    type: overrides.type ?? 'task',
    priority: overrides.priority ?? 'high',
    column: overrides.column ?? 'ready',
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
    createdAt: PLAN_T - 100_000,
    updatedAt: overrides.updatedAt ?? PLAN_T - 5_000,
    movedAt: overrides.movedAt ?? PLAN_T - 5_000,
    acceptedAt: null,
    activity: overrides.activity ?? [],
  };
}

function planBoard({ tickets = [], members = [], wip = { in_progress: 3, review: 5 } } = {}) {
  return {
    paused: false,
    wip: { backlog: 0, ready: 0, ...wip },
    tickets,
    team: { members },
    pulses: [],
  };
}

const planRoleTicket = (role) => planTicket('KB-1', { role });

// ===========================================================================
// AC 1 + AC 7 (preserved role) — eligible dispatch, workspace-write, brief
// ===========================================================================
section('AC 1 — eligible implement dispatch, workspace-write, implement brief');
const IMPLEMENT_DESCRIPTION = [
  '## Outcome',
  'Hand a Ready ticket from the pull lane to the review gate with recorded evidence.',
  '',
  '## Acceptance criteria',
  '1. The ticket leaves Ready for In Progress when the implementer claims it.',
  '2. The evidence comment names the command that was run.',
  '',
  '## Evidence plan',
  '- node --test tests/autopilot-implement.test.mjs',
  '- capture the dispatch row and the implement brief',
  '',
  '## Write scope',
  'index.js, tests/autopilot-implement.test.mjs',
].join('\n');
const EXPECTED_AC_SECTION = [
  '## Acceptance criteria',
  '1. The ticket leaves Ready for In Progress when the implementer claims it.',
  '2. The evidence comment names the command that was run.',
].join('\n');
const EXPECTED_EVIDENCE_SECTION = [
  '## Evidence plan',
  '- node --test tests/autopilot-implement.test.mjs',
  '- capture the dispatch row and the implement brief',
].join('\n');
const PREVIOUS_REPORT = 'Previous attempt: the write scope was missing, so no code was changed.';

{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { review: 0 } });
  const ticket = await createTicket(app, {
    title: 'Implement the handoff marker',
    description: IMPLEMENT_DESCRIPTION,
    role: 'be-developer',
    priority: 'high',
    labels: ['autopilot', 'lane-implement'],
  });
  // Move Backlog → Ready through the host so the dispatch carries a real handoff
  // reason (`applyAutoAssignment` writes it), then patch a previous done attempt so
  // the brief has a report to quote.
  const moved = await app.action('moveTicket', { ticketId: ticket.id, column: 'ready' });
  check('AC1 the fixture moves the ticket to Ready', moved.status === 200, String(moved.status));
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticket.id);
    target.execution = {
      sessionId: 'session-previous-attempt',
      status: 'done',
      role: 'be-developer',
      accessMode: 'workspace-write',
      startColumn: 'ready',
      origin: 'autopilot',
      startedAt: virtualNow - 600_000,
      updatedAt: virtualNow - 540_000,
      finishedAt: virtualNow - 540_000,
      report: PREVIOUS_REPORT,
      error: '',
      blocked: null,
    };
  });

  const handoffReason = ticketOf(await readBoard(stateDir), ticket.id)?.assignment?.reason ?? '';
  check('AC1 the fixture records a handoff reason on the Ready ticket', Boolean(handoffReason), brief(handoffReason));

  // Dry-run plan: the ticket names a valid implementation role, so it is preserved
  // and the decision advertises the role source before any dispatch happens.
  const planned = await app.plan();
  const plannedDecision = planned.json.value.decisions.find((decision) => decision.ticketId === ticket.id) ?? null;
  capture('AC1 dry-run dispatch decision', JSON.stringify(plannedDecision));
  check(
    'AC7 the planner preserves a matching implementation role (roleSource ticket)',
    plannedDecision?.role === 'be-developer' && plannedDecision?.roleSource === 'ticket' && plannedDecision?.roleInferred === false,
    brief(plannedDecision),
  );

  let implemented = null;
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    implemented = await implementProperly(app, stateDir, request.sessionId, { role: 'be-developer' });
  });
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  const sessionId = app.createdSessions[0];
  const promptText = app.prompts.find((prompt) => prompt.sessionId === sessionId)?.text ?? '';
  const dispatchRow = decisionFor(pulse, ticket.id);

  check('AC1 the pulse admits exactly one implement dispatch', pulse.dispatched.length === 1, brief(pulse.dispatched));
  check('AC1 the dispatched ticket is the Ready ticket', pulse.dispatched[0]?.ticketId === ticket.id, brief(pulse.dispatched[0]));
  check('AC1 exactly one agents.create call starts a session', app.createCalls.length === 1, String(app.createCalls.length));
  check('AC1 the role-matched be-developer member is dispatched', pulse.dispatched[0]?.memberId === 'member-be-developer', pulse.dispatched[0]?.memberId);
  check(
    'AC1 the captured dispatch row records role, member and accessMode',
    dispatchRow?.action === 'dispatch' &&
      dispatchRow?.reason === 'admitted' &&
      dispatchRow?.role === 'be-developer' &&
      dispatchRow?.memberId === 'member-be-developer' &&
      dispatchRow?.accessMode === 'workspace-write',
    brief(dispatchRow),
  );
  check('AC7 the preserved-role dispatch is not marked inferred', dispatchRow?.roleInferred !== true, brief(dispatchRow));
  check('AC1 the fake implementer claim + move + finish all succeeded', implemented?.claim?.ok === true && implemented?.moved?.ok === true && implemented?.finish?.ok === true, brief(implemented && { claim: implemented.claim?.ok, moved: implemented.moved?.ok, finish: implemented.finish?.ok }));

  // Brief content: ticket content, AC verbatim, evidence plan verbatim, previous
  // report, handoff reason, and the lane exit path.
  check('AC1 the brief carries the ticket content', promptText.includes(`# Kanban execution — ${ticket.id}`) && promptText.includes('Hand a Ready ticket from the pull lane to the review gate with recorded evidence.'), brief(promptText.slice(0, 160)));
  check(
    'AC1 the brief carries the acceptance criteria verbatim',
    promptText.includes(`### Acceptance criteria — the finish line (verbatim from the ticket)\n${EXPECTED_AC_SECTION}`),
    `${EXPECTED_AC_SECTION.split('\n').length} quoted lines`,
  );
  check(
    'AC1 the brief carries the evidence plan verbatim',
    promptText.includes(`### Evidence plan — what to attach (verbatim from the ticket)\n${EXPECTED_EVIDENCE_SECTION}`),
    `${EXPECTED_EVIDENCE_SECTION.split('\n').length} quoted lines`,
  );
  check('AC1 the brief carries the previous execution report', promptText.includes(PREVIOUS_REPORT), `${PREVIOUS_REPORT.length} chars quoted`);
  check('AC1 the brief carries the handoff reason', promptText.includes(`Handoff reason (verbatim): ${handoffReason}`), brief(handoffReason));
  check(
    'AC1 the brief states the claim → implement → Review → finish path',
    promptText.includes('## Implementation brief — autopilot implement lane') &&
      promptText.includes('Ready → In Progress') &&
      promptText.includes('In Progress → Review') &&
      promptText.includes('implement postcondition when your turn ends requires the ticket to be in In Progress or Review'),
    `${promptText.indexOf('## Implementation brief')} offset in the dispatch prompt`,
  );

  let board = await readBoard(stateDir);
  check('AC1 the ticket applied workspace-write access', (await ticketOf(board, ticket.id))?.execution?.accessMode === 'workspace-write', brief(ticketOf(board, ticket.id)?.execution));
  check('AC1 the session was granted the workspace-write sandbox', app.permissionSets.some((entry) => entry.session === sessionId && entry.value === 'workspace-write'), brief(app.permissionSets));
  check('AC1 the execution is fingerprinted as an autopilot dispatch from Ready', ticketOf(board, ticket.id)?.execution?.origin === 'autopilot' && ticketOf(board, ticket.id)?.execution?.startColumn === 'ready', brief(ticketOf(board, ticket.id)?.execution));
  check('AC1 the implementer handed the ticket to Review', ticketOf(board, ticket.id)?.column === 'review', ticketOf(board, ticket.id)?.column);
  check('AC1 the persisted ticket keeps the preserved role', ticketOf(board, ticket.id)?.role === 'be-developer', ticketOf(board, ticket.id)?.role);
  capture('AC1 dispatch row (role, member, accessMode)', JSON.stringify(dispatchRow));
  capture(
    'AC1 implement brief excerpt',
    promptText.slice(
      promptText.indexOf('## Implementation brief — autopilot implement lane'),
      promptText.indexOf('## How to work'),
    ),
  );

  // The postcondition verifier records the satisfied implement outcome on the next
  // pulse, and the review lane is disabled so the fixture stays implement-only.
  endTurn(app, sessionId);
  const verify = await app.pulseNow();
  const satisfied = outcomeFor(verify.json.value.pulse, ticket.id);
  check('AC5 a satisfied implement records a satisfied outcome in the implement lane', satisfied?.outcome === 'satisfied' && satisfied?.lane === 'implement', brief(verify.json.value.pulse.outcomes));
  check('AC5 the satisfied dispatch starts no second session', app.createdSessions.length === 1, String(app.createdSessions.length));

  // Additive pulse fields: the dispatch row and the implement outcome must survive
  // a normalized reload byte-stably (no churn note, no dropped fields).
  board = await readBoard(stateDir);
  const restarted = await makeApp({ stateDir, root: app.root, scheduler: app.scheduler });
  const reloaded = await restarted.state();
  const dispatchPulse = reloaded.board.pulses.find((entry) =>
    (entry.dispatched ?? []).some((row) => row.ticketId === ticket.id),
  ) ?? null;
  const reloadedRow = decisionFor(dispatchPulse, ticket.id);
  const reloadedOutcome = outcomeFor(reloaded.board.pulses[0], ticket.id);
  check(
    'AC1 the additive dispatch fields survive a reload',
    reloadedRow?.role === 'be-developer' && reloadedRow?.accessMode === 'workspace-write' && reloadedRow?.roleInferred !== true,
    brief(reloadedRow),
  );
  check('AC1 the implement outcome survives a reload', reloadedOutcome?.outcome === 'satisfied' && reloadedOutcome?.lane === 'implement', brief(reloadedOutcome));
  const normalizedNotes = (boardLike) => (boardLike?.activity ?? []).filter((entry) => entry.kind === 'autopilot/pulses-normalized').length;
  const secondRead = await restarted.state();
  check(
    'AC1 the widened pulse rows re-read with no normalization churn',
    normalizedNotes(reloaded.board) === 0 && normalizedNotes(secondRead.board) === 0,
    `first=${normalizedNotes(reloaded.board)} second=${normalizedNotes(secondRead.board)}`,
  );
  await restarted.dispose();
  await app.dispose();
}

// ===========================================================================
// AC 2 — strict role matching: no downgrade, exact role per implementation role
// ===========================================================================
section('AC 2 — strict role matching, no downgrade when no member of the role is free');
{
  const { app } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { review: 0 } });
  const fullstackTicket = await createTicket(app, {
    title: 'Fullstack work only',
    column: 'ready',
    role: 'fullstack-developer',
    priority: 'high',
  });
  const feTicket = await createTicket(app, { title: 'Frontend work', column: 'ready', role: 'fe-developer', priority: 'high' });
  // Remove the only fullstack member; the fe/be members stay free. A strict planner
  // must report no-member instead of downgrading the fullstack ticket.
  const repurposed = await repurposeMember(app, 'fullstack-developer', 'reviewer');
  check('AC2 the fixture repurposes the fullstack member', repurposed.roleId === 'reviewer', repurposed.roleId);
  const snapshot = await app.state();
  check('AC2 a free fe member is still on the roster', Boolean(memberByRole(snapshot.board, 'fe-developer')), brief(snapshot.board.team.members.map((member) => member.roleId)));

  const planned = await app.plan();
  const plannedFullstack = planned.json.value.decisions.find((decision) => decision.ticketId === fullstackTicket.id) ?? null;
  const plannedSkip = planned.json.value.skips.find((skip) => skip.ticketId === fullstackTicket.id) ?? null;
  check('AC2 the fullstack ticket is never planned to a fallback role', plannedFullstack === null, brief(plannedFullstack));
  check('AC2 the plan records no-member for the fullstack ticket', plannedSkip?.reason === 'no-member', brief(plannedSkip));

  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  {
    const memberlessBoard = (await app.state()).board;
    check(
      'AC2 the member-less ticket gets no session while the fe ticket does',
      app.createdSessions.length === 1 && ticketOf(memberlessBoard, fullstackTicket.id)?.execution == null,
      brief({ created: app.createdSessions.length, fullstackExecution: ticketOf(memberlessBoard, fullstackTicket.id)?.execution }),
    );
  }
  check('AC2 the fullstack ticket records no-member', decisionFor(pulse, fullstackTicket.id)?.reason === 'no-member', brief(decisionFor(pulse, fullstackTicket.id)));
  check(
    'AC2 the remaining dispatch is for its exact fe-developer role, not the fullstack ticket',
    pulse.dispatched.length === 1 && pulse.dispatched[0].ticketId === feTicket.id,
    brief(pulse.dispatched),
  );
  check('AC2 the fe dispatch carries the fe-developer member', decisionFor(pulse, feTicket.id)?.role === 'fe-developer' && decisionFor(pulse, feTicket.id)?.memberId === 'member-fe-developer', brief(decisionFor(pulse, feTicket.id)));
  capture('AC2 mismatched-roster no-member fixture', JSON.stringify({ plannedSkip, dispatch: decisionFor(pulse, feTicket.id), createdSessions: app.createCalls.length }));
  await app.dispose();
}

// Every Ready implementation role routes to a member of exactly that role, and a
// roleless ticket is inferred (AC 2 + AC 7), asserted on the pure planner.
section('AC 2/7 — the role matrix on the pure planner');
{
  const implementationRoles = ['ux-designer', 'fe-developer', 'be-developer', 'fullstack-developer', 'bug-fixer', 'sre'];
  for (const role of implementationRoles) {
    const plan = planPulse(
      planBoard({ tickets: [planRoleTicket(role)], members: [planMember(`member-${role}`, role)] }),
      PLAN_AUTOPILOT,
      PLAN_T,
    );
    check(
      `AC2 a ${role} ticket dispatches to a ${role} member`,
      plan.decisions.length === 1 && plan.decisions[0].role === role && plan.decisions[0].roleSource === 'ticket',
      brief(plan.decisions[0]),
    );
  }
  const fallbackPlan = planPulse(
    planBoard({ tickets: [planRoleTicket('fullstack-developer')], members: [planMember('member-fe', 'fe-developer'), planMember('member-be', 'be-developer')] }),
    PLAN_AUTOPILOT,
    PLAN_T,
  );
  check(
    'AC2 a fullstack ticket with no fullstack member is no-member, never a fe/be downgrade',
    fallbackPlan.decisions.length === 0 && fallbackPlan.skips.some((skip) => skip.reason === 'no-member' && skip.ticketId === 'KB-1'),
    brief(fallbackPlan.skips),
  );

  const inferredPlan = planPulse(
    planBoard({
      tickets: [planTicket('KB-1', { role: null, description: 'Backend API endpoint and database migration work.' })],
      members: [planMember('member-be', 'be-developer'), planMember('member-fullstack', 'fullstack-developer')],
    }),
    PLAN_AUTOPILOT,
    PLAN_T,
  );
  check(
    'AC7 a roleless ticket is inferred to be-developer and records the inference',
    inferredPlan.decisions[0]?.role === 'be-developer' &&
      inferredPlan.decisions[0]?.roleSource === 'inferred' &&
      inferredPlan.decisions[0]?.roleInferred === true,
    brief(inferredPlan.decisions[0]),
  );
  const uninferablePlan = planPulse(
    planBoard({
      tickets: [planTicket('KB-1', { role: null, title: 'Miscellaneous follow-up', description: 'Prose with no domain words.' })],
      members: [planMember('member-fullstack', 'fullstack-developer')],
    }),
    PLAN_AUTOPILOT,
    PLAN_T,
  );
  check(
    'AC7 an uninferable roleless ticket falls back to fullstack-developer and records the inference',
    uninferablePlan.decisions[0]?.role === 'fullstack-developer' && uninferablePlan.decisions[0]?.roleInferred === true,
    brief(uninferablePlan.decisions[0]),
  );
}

// ===========================================================================
// AC 3 — phase-1 single implementer: two Ready tickets, two members, one session
// ===========================================================================
section('AC 3 — phase-1 admit: 1 dispatch + exactly one lane-cap:implement skip');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxDispatchesPerPulse: 2, laneCaps: { review: 0 } });
  // Two implementer members of the same role: the cap, not the roster, must bound
  // the pulse.
  await repurposeMember(app, 'ux-designer', 'be-developer');
  const snapshot = await app.state();
  const implementers = snapshot.board.team.members.filter((member) => member.roleId === 'be-developer');
  check('AC3 the fixture has two be-developer members', implementers.length === 2, brief(implementers.map((member) => member.id)));

  const high = await createTicket(app, { title: 'High first pull', column: 'ready', role: 'be-developer', priority: 'high' });
  const critical = await createTicket(app, { title: 'Critical first pull', column: 'ready', role: 'be-developer', priority: 'critical' });
  const planned = await app.plan();
  const plannedImplement = planned.json.value.decisions.filter((decision) => decision.lane === 'implement');
  check('AC3 the plan admits exactly one implementer', plannedImplement.length === 1, brief(planned.json.value.decisions));
  check('AC6 the critical Ready ticket is planned before the high one', plannedImplement[0]?.ticketId === critical.id, brief({ planned: plannedImplement[0]?.ticketId, critical: critical.id }));

  const first = await app.pulseNow();
  const pulse = first.json.value.pulse;
  const laneCaps = decisionsWithReason(pulse, 'lane-cap');
  capture('AC3 two-Ready fixture pulse decisions', JSON.stringify(pulse.decisions));
  check('AC3 the pulse dispatches exactly one implementer', pulse.dispatched.length === 1, brief(pulse.dispatched));
  check('AC3 the dispatched ticket is the critical one', pulse.dispatched[0]?.ticketId === critical.id, brief(pulse.dispatched[0]));
  check('AC3 exactly one lane-cap skip is recorded in the implement lane', laneCaps.length === 1 && laneCaps[0].lane === 'implement', brief(laneCaps));
  check('AC3 the second Ready ticket is the lane-capped one', laneCaps[0]?.ticketId === high.id, brief(laneCaps[0]));
  check('AC3 exactly one session is created', app.createdSessions.length === 1, String(app.createdSessions.length));

  // A second pulse while the first session is live: still one implementer, and the
  // waiting ticket stays lane-capped.
  const second = (await app.pulseNow()).json.value.pulse;
  const secondLaneCaps = decisionsWithReason(second, 'lane-cap');
  check('AC3 the live implementer keeps the lane occupied', secondLaneCaps.some((entry) => entry.ticketId === high.id && entry.lane === 'implement'), brief(second.decisions));
  check('AC3 the active ticket is reported as active-execution', decisionFor(second, critical.id)?.reason === 'active-execution', brief(decisionFor(second, critical.id)));
  check('AC3 no second session is ever started', app.createdSessions.length === 1, String(app.createdSessions.length));
  const board = await readBoard(stateDir);
  check('AC3 the waiting ticket is untouched', ticketOf(board, high.id)?.execution == null && ticketOf(board, high.id)?.column === 'ready', brief(ticketOf(board, high.id)));
  await app.dispose();
}

// ===========================================================================
// AC 4 — a human Run is never blocked by the autopilot lane cap
// ===========================================================================
section('AC 4 — human Run concurrent with one autopilot implementer');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { review: 0 } });
  const autopilotTicket = await createTicket(app, { title: 'Autopilot pull', column: 'ready', role: 'be-developer', priority: 'high' });
  const humanTicket = await createTicket(app, { title: 'Human pull', column: 'ready', role: 'fe-developer', priority: 'high' });

  const first = await app.pulseNow();
  check('AC4 the pulse dispatches the autopilot implementer', first.json.value.pulse.dispatched.length === 1 && app.createdSessions.length === 1, brief(first.json.value.pulse.dispatched));

  const humanRun = await app.action('runTicket', { ticketId: humanTicket.id, role: 'fe-developer' });
  check('AC4 the host accepts a human Run while an autopilot implementer is active', humanRun.status === 200, `${humanRun.status} ${brief(humanRun.json)}`);
  const humanSession = humanRun.json?.value?.sessionId;
  let board = await readBoard(stateDir);
  const humanExecution = ticketOf(board, humanTicket.id)?.execution;
  check('AC4 both implementer sessions run concurrently', app.createdSessions.length === 2 && app.live.size === 2, `${app.createdSessions.length}/${app.live.size}`);
  check('AC4 the human run is not fingerprinted as autopilot', humanExecution?.sessionId === humanSession && humanExecution?.origin === undefined, brief(humanExecution));
  check('AC4 the human run also resolves workspace-write for Ready', humanExecution?.accessMode === 'workspace-write', humanExecution?.accessMode);

  // Finish the autopilot ticket correctly so only the human session is left live;
  // the human ticket (still Ready, session live) must then be excluded from
  // autopilot planning as active-execution, not pulled again.
  const autopilotSession = first.json.value.pulse.dispatched[0].sessionId;
  await implementProperly(app, stateDir, autopilotSession, { role: 'be-developer' });
  endTurn(app, autopilotSession);
  const second = (await app.pulseNow()).json.value.pulse;
  check('AC4 the autopilot advance is verified as satisfied', outcomeFor(second, autopilotTicket.id)?.outcome === 'satisfied', brief(second.outcomes));
  check('AC4 the human-owned ticket is excluded as active-execution', decisionFor(second, humanTicket.id)?.reason === 'active-execution', brief(decisionFor(second, humanTicket.id)));
  check('AC4 the human run is not blocked or restarted by the cap', app.createdSessions.length === 2, String(app.createdSessions.length));
  board = await readBoard(stateDir);
  check('AC4 the human-owned ticket stays Ready and keeps its session', ticketOf(board, humanTicket.id)?.column === 'ready' && ticketOf(board, humanTicket.id)?.execution?.sessionId === humanSession, brief(ticketOf(board, humanTicket.id)));
  capture('AC4 human concurrency fixture', JSON.stringify({
    autopilotSession,
    humanSession,
    sessions: app.createdSessions.length,
    humanExecution: { accessMode: humanExecution?.accessMode, origin: humanExecution?.origin },
    decision: decisionFor(second, humanTicket.id),
  }));
  await app.dispose();
}

// ===========================================================================
// AC 5 — the implement postcondition miss: comment, outcome, backoff, retry
// ===========================================================================
section('AC 5 — an implementer that never pulls records postcondition-failed and backs off');
{
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true, backoffMs: 900_000, laneCaps: { review: 0 } });
  const ticket = await createTicket(app, { title: 'Implement properly', column: 'ready', role: 'be-developer', priority: 'high' });
  app.setPromptHook(async () => {
    app.setPromptHook(null);
    // A session that ends its turn without claiming, moving or finishing anything.
  });
  const first = await app.pulseNow();
  const sessionId = app.createdSessions[0];
  check('AC5 the first implement dispatch starts one session', first.json.value.pulse.dispatched.length === 1, brief(first.json.value.pulse.dispatched));
  check('AC5 the missed implementer never claimed the ticket', ticketOf(await readBoard(stateDir), ticket.id)?.column === 'ready', ticketOf(await readBoard(stateDir), ticket.id)?.column);
  const LAST_REPORT = 'Implementer ended its turn after reading the ticket; no claim was made.';
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticket.id);
    target.execution.report = LAST_REPORT;
  });

  endTurn(app, sessionId);
  await scheduler.advance(1_000);
  const miss = (await app.pulseNow()).json.value.pulse;
  const failedOutcome = outcomeFor(miss, ticket.id);
  check('AC5 the pulse records an implement postcondition-failed outcome', failedOutcome?.outcome === 'postcondition-failed' && failedOutcome?.lane === 'implement', brief(miss.outcomes));
  check('AC5 the pulse does not re-dispatch inside backoffMs', decisionFor(miss, ticket.id)?.reason === 'postcondition-failed', brief(decisionFor(miss, ticket.id)));
  let board = await readBoard(stateDir);
  const failureComment = (ticketOf(board, ticket.id)?.comments ?? []).find((comment) => String(comment.text).startsWith('[autopilot postcondition-failed]')) ?? null;
  check('AC5 the ticket carries the postcondition-failed comment', Boolean(failureComment), brief((ticketOf(board, ticket.id)?.comments ?? []).slice(-2)));
  check('AC5 the comment quotes the last execution report/error', String(failureComment?.text ?? '').includes(LAST_REPORT), String(failureComment?.text ?? '').slice(0, 160));
  check('AC5 the failed execution row is terminal (lane and member freed)', ticketOf(board, ticket.id)?.execution?.status === 'failed', ticketOf(board, ticket.id)?.execution?.status);
  check('AC5 no second session is started inside the backoff', app.createdSessions.length === 1, String(app.createdSessions.length));

  const again = (await app.pulseNow()).json.value.pulse;
  const failureComments = (ticketOf(await readBoard(stateDir), ticket.id)?.comments ?? []).filter((comment) => String(comment.text).startsWith('[autopilot postcondition-failed]'));
  check('AC5 the failure is recorded once per state change', failureComments.length === 1, String(failureComments.length));
  check('AC5 the cooldown reason keeps being reported', decisionFor(again, ticket.id)?.reason === 'postcondition-failed', brief(decisionFor(again, ticket.id)));
  check('AC5 no session is started on the repeat pulse', app.createdSessions.length === 1, String(app.createdSessions.length));
  capture('AC5 postcondition-failed outcome + comment', JSON.stringify({ outcome: failedOutcome, comment: String(failureComment?.text ?? '').slice(0, 300) }));

  // After backoffMs the planner retries; the brief now quotes the failed attempt.
  await scheduler.advance(900_000);
  await settle();
  board = await readBoard(stateDir);
  check('AC5 the ticket is dispatched again once backoffMs elapsed', app.createdSessions.length === 2, String(app.createdSessions.length));
  const retryPrompt = app.prompts.find((prompt) => prompt.sessionId === app.createdSessions[1])?.text ?? '';
  check('AC1 the retry brief carries the previous execution error', retryPrompt.includes('Previous execution error (verbatim):') && retryPrompt.includes('missed its postcondition'), brief(retryPrompt.slice(0, 120)));
  board = await readBoard(stateDir);
  check('AC5 the retry keeps the ticket Ready until the implementer claims it', ticketOf(board, ticket.id)?.column === 'ready', ticketOf(board, ticket.id)?.column);
  await app.dispose();
}

// ===========================================================================
// AC 5 — the other verifier branches: claimed-in-place and blocked sessions
// ===========================================================================
section('AC 5 — In Progress satisfied, blocked deferred (never a failure)');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { review: 0 } });
  const ticket = await createTicket(app, { title: 'Claimed but not handed over', column: 'ready', role: 'be-developer', priority: 'high' });
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    const target = await ticketForSession(stateDir, request.sessionId);
    await kanban(app, request.sessionId, { action: 'claim', ticketId: target.id });
  });
  await app.pulseNow();
  const sessionId = app.createdSessions[0];
  endTurn(app, sessionId);
  const verify = (await app.pulseNow()).json.value.pulse;
  const outcome = outcomeFor(verify, ticket.id);
  check('AC5 an implementer that claimed and stopped is satisfied in In Progress', outcome?.outcome === 'satisfied' && String(outcome?.detail ?? '').includes('In Progress'), brief(outcome));
  const board = await readBoard(stateDir);
  check(
    'AC5 the In Progress ticket is left claimed for the review handoff',
    ticketOf(board, ticket.id)?.column === 'in_progress' && ticketOf(board, ticket.id)?.execution?.status === 'done',
    brief(ticketOf(board, ticket.id)?.execution),
  );
  check('AC5 the claimed-in-place branch starts no second session', app.createdSessions.length === 1, String(app.createdSessions.length));
  await app.dispose();
}
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { review: 0 } });
  const ticket = await createTicket(app, { title: 'Blocked implementer', column: 'ready', role: 'be-developer', priority: 'high' });
  let blockResult = null;
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    const target = await ticketForSession(stateDir, request.sessionId);
    await kanban(app, request.sessionId, { action: 'claim', ticketId: target.id });
    blockResult = await kanban(app, request.sessionId, {
      action: 'block',
      ticketId: target.id,
      text: 'The retention window is not on the ticket, in the vision, or in the repo.',
      questions: ['How long must the record be retained?'],
    });
  });
  const first = await app.pulseNow();
  check('AC5 the implementer block call succeeds', blockResult?.ok === true, brief(blockResult));
  const sessionId = app.createdSessions[0];
  endTurn(app, sessionId);
  const verify = (await app.pulseNow()).json.value.pulse;
  const deferred = outcomeFor(verify, ticket.id);
  check('AC5 a blocked implementer records a deferred outcome, not a failure', deferred?.outcome === 'deferred' && deferred?.lane === 'implement', brief(verify.outcomes));
  const board = await readBoard(stateDir);
  check(
    'AC5 the blocked ticket stays In Progress and is visible as blocked',
    ticketOf(board, ticket.id)?.blocked === true && ticketOf(board, ticket.id)?.column === 'in_progress',
    brief(ticketOf(board, ticket.id)?.block),
  );
  check('AC5 a blocked implementer is not re-dispatched', app.createdSessions.length === 1, String(app.createdSessions.length));
  check('AC5 the blocked session records no postcondition-failed comment', !(ticketOf(board, ticket.id)?.comments ?? []).some((comment) => String(comment.text).startsWith('[autopilot postcondition-failed]')), brief((ticketOf(board, ticket.id)?.comments ?? []).slice(-2)));
  await app.dispose();
}

// ===========================================================================
// AC 6 — priority override, oldest movedAt tie-break, blocked/EPIC never selected
// ===========================================================================
section('AC 6 — priority, age and structural exclusions on the pure planner');
{
  const members = [planMember('member-be', 'be-developer')];
  const criticalNew = planTicket('KB-2', { role: 'be-developer', priority: 'critical', movedAt: PLAN_T - 1_000 });
  const highOld = planTicket('KB-1', { role: 'be-developer', priority: 'high', movedAt: PLAN_T - 900_000 });
  const priorityPlan = planPulse(planBoard({ tickets: [highOld, criticalNew], members }), PLAN_AUTOPILOT, PLAN_T);
  check(
    'AC6 critical is chosen before high regardless of age',
    priorityPlan.decisions.length === 1 && priorityPlan.decisions[0].ticketId === 'KB-2',
    brief(priorityPlan.decisions),
  );

  const olderHigh = planTicket('KB-1', { role: 'be-developer', priority: 'high', movedAt: PLAN_T - 900_000 });
  const newerHigh = planTicket('KB-2', { role: 'be-developer', priority: 'high', movedAt: PLAN_T - 1_000 });
  const agePlan = planPulse(planBoard({ tickets: [newerHigh, olderHigh], members }), PLAN_AUTOPILOT, PLAN_T);
  check(
    'AC6 inside one priority the oldest movedAt is chosen',
    agePlan.decisions.length === 1 && agePlan.decisions[0].ticketId === 'KB-1',
    brief(agePlan.decisions),
  );

  const blockedCritical = planTicket('KB-1', { role: 'be-developer', priority: 'critical', blocked: true });
  const freeHigh = planTicket('KB-2', { role: 'be-developer', priority: 'high' });
  const blockedPlan = planPulse(planBoard({ tickets: [blockedCritical, freeHigh], members }), PLAN_AUTOPILOT, PLAN_T);
  check(
    'AC6 a blocked ticket is never selected and is reported as blocked',
    blockedPlan.decisions.length === 1 &&
      blockedPlan.decisions[0].ticketId === 'KB-2' &&
      blockedPlan.skips.some((skip) => skip.ticketId === 'KB-1' && skip.reason === 'blocked'),
    brief({ decisions: blockedPlan.decisions, skips: blockedPlan.skips }),
  );

  const epic = planTicket('KB-1', { type: 'epic', column: 'backlog', priority: 'critical' });
  const readyWork = planTicket('KB-2', { role: 'be-developer', priority: 'high' });
  const epicPlan = planPulse(planBoard({ tickets: [epic, readyWork], members }), PLAN_AUTOPILOT, PLAN_T);
  check(
    'AC6 an EPIC is never selected and is reported as epic',
    epicPlan.decisions.length === 1 &&
      epicPlan.decisions[0].ticketId === 'KB-2' &&
      !epicPlan.decisions.some((decision) => decision.ticketId === 'KB-1') &&
      epicPlan.skips.some((skip) => skip.ticketId === 'KB-1' && skip.reason === 'epic'),
    brief({ decisions: epicPlan.decisions, skips: epicPlan.skips }),
  );
}

// ===========================================================================
// AC 7 — role inference end to end: the ticket stores the inferred role
// ===========================================================================
section('AC 7 — a roleless Ready ticket gets the inferred role, stored and recorded');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { review: 0 } });
  const ticket = await createTicket(app, {
    title: 'Backend API endpoint work',
    column: 'ready',
    description: 'Add a REST endpoint and a database migration for the new record.',
    priority: 'high',
  });
  check('AC7 the fixture ticket has no role', ticketOf(await readBoard(stateDir), ticket.id)?.role == null, String(ticketOf(await readBoard(stateDir), ticket.id)?.role));

  const planned = await app.plan();
  const plannedDecision = planned.json.value.decisions.find((decision) => decision.ticketId === ticket.id) ?? null;
  check(
    'AC7 the dry-run plan infers be-developer and says so',
    plannedDecision?.role === 'be-developer' && plannedDecision?.roleSource === 'inferred' && plannedDecision?.roleInferred === true,
    brief(plannedDecision),
  );

  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  const dispatchRow = decisionFor(pulse, ticket.id);
  check(
    'AC7 the pulse dispatch decision records the inference',
    dispatchRow?.role === 'be-developer' && dispatchRow?.roleInferred === true,
    brief(dispatchRow),
  );
  check('AC7 the session is started for the inferred role', pulse.dispatched[0]?.memberId === 'member-be-developer', pulse.dispatched[0]?.memberId);
  const board = await readBoard(stateDir);
  check('AC7 the ticket stores the inferred role', ticketOf(board, ticket.id)?.role === 'be-developer', ticketOf(board, ticket.id)?.role);
  check(
    'AC7 the inference is recorded on the board activity',
    (board.activity ?? []).some((entry) => entry.kind === 'autopilot/role-inferred' && String(entry.text).includes(ticket.id)),
    brief((board.activity ?? []).filter((entry) => entry.kind === 'autopilot/role-inferred')),
  );
  capture('AC7 inferred dispatch decision', JSON.stringify(dispatchRow));
  await app.dispose();
}

// ===========================================================================
// Compatibility — a legacy execution row is not an autopilot implement session
// ===========================================================================
section('compatibility — a pre-autopilot execution row is not verified or re-dispatched');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { review: 0 } });
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
  const pulse = (await app.pulseNow()).json.value.pulse;
  const snapshot = await app.state();
  const legacy = ticketOf(snapshot.board, ticket.id);
  check('compat the legacy execution row loads without a synthesized marker', legacy?.execution?.origin === undefined && legacy?.execution?.postcondition === undefined, brief(legacy?.execution));
  check('compat a legacy row records no implement outcome', outcomeFor(pulse, ticket.id) == null, brief(pulse.outcomes));
  check(
    'compat the legacy row is excluded from planning and never re-dispatched',
    app.createdSessions.length === 0 && decisionFor(pulse, ticket.id)?.reason === 'active-execution',
    brief({ created: app.createCalls.length, decision: decisionFor(pulse, ticket.id) }),
  );
  await app.dispose();
}

// ===========================================================================
// Unit coverage — the implement postcondition predicate (the risky branch)
// ===========================================================================
section('unit — evaluateImplementPostcondition');
{
  const inProgress = { column: 'in_progress', role: 'be-developer' };
  const review = { column: 'review', role: 'be-developer' };
  const stillReady = { column: 'ready', role: 'be-developer' };
  check('unit In Progress passes', evaluateImplementPostcondition(inProgress).ok === true, brief(evaluateImplementPostcondition(inProgress)));
  check('unit Review passes', evaluateImplementPostcondition(review).ok === true, brief(evaluateImplementPostcondition(review)));
  check('unit still Ready fails and names both expected lanes', evaluateImplementPostcondition(stillReady).missing.some((item) => item.includes('In Progress') && item.includes('Review')), brief(evaluateImplementPostcondition(stillReady)));
  check('unit a corrupt ticket never throws', evaluateImplementPostcondition(null).ok === false, brief(evaluateImplementPostcondition(null)));
  check('unit Backlog fails like Ready', evaluateImplementPostcondition({ column: 'backlog', role: 'be-developer' }).ok === false, brief(evaluateImplementPostcondition({ column: 'backlog', role: 'be-developer' })));
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
Date.now = realDateNow;
for (const dir of dirs) await rm(dir, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? 'ALL KB-72 IMPLEMENT CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
