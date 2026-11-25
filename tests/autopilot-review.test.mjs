/**
 * KB-73 — autopilot review lane: a separate reviewer verifies the written change
 * and records a structured verdict, then either accepts to Done or hands the
 * ticket back to In Progress with actionable change requests.
 *
 * Dependency-free harness in the same style as `tests/autopilot-implement.test.mjs`:
 * a temporary state directory, a fake Harness ctx, and an INJECTED clock plus an
 * INJECTED scheduler (no wall-clock sleep anywhere). The fake reviewer session is
 * a real kanban-tool caller: during the dispatch prompt it runs `review`, `move`,
 * `finish` (and the rejected attempts) as the dispatched session, so every
 * assertion crosses host → tool → persisted board → pulse, not a mocked handler.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  additive `Ticket.reviews` model: exact `{id, at, reviewerMemberId,
 *         reviewerName, sessionId, verdict, notes, criteria, evidence}` shape,
 *         newest-first cap 20, absent/old tickets read `[]`, persisted and exposed
 *         additively in the snapshot; input validation (closed verdict set,
 *         per-criterion mapping, blocking note for changes-requested)
 *   AC 2  one eligible Review dispatch: exactly one separate reviewer session, the
 *         documented test-capable access, and the review brief carrying the
 *         acceptance criteria verbatim, the implementer's report, the evidence
 *         list and the verdict/move instruction
 *   AC 3  separation: only the implementing member/session available → `no-member`
 *         and no session; a second reviewer is chosen when one exists
 *   AC 4  accept path: verdict accepted + every criterion passed + review→done;
 *         the pulse verifies Done and records satisfied; a Done without an accepted
 *         verdict is rejected at the move, never a silent Done
 *   AC 5  changes-requested path: ≥1 blocking note + ≥1 passed:false criterion,
 *         review→in_progress, assignment set to the implementation role, the pulse
 *         records the handback; an attempted review→ready is logged as a policy
 *         error and not retried into an illegal move
 *   AC 6  phase-1 review cap: two Review tickets + one reviewer member → one
 *         session and one `lane-cap:review` skip
 *   AC 7  a reviewer that finishes/ends idle without a verdict is caught by the
 *         postcondition: ticket comment, `postcondition-failed` outcome, no second
 *         reviewer in the same pulse, and the ticket is not retried until
 *         `backoffMs` elapses
 *   AC 8  `node --test tests/autopilot-review.test.mjs` passes; both prompts are
 *         captured; the review lane's documented access decision is asserted
 *         (test-capable workspace-write preset because read-only cannot run the
 *         harness, never danger-full-access) with the no-source-edit brief
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, planPulse, evaluateReviewPostcondition } from '../index.js';

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

const WORKSPACE_ID = 'workspace-review';
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
    title: 'Review Fixture',
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
  const root = await tempDir('kanban-kb73-root-');
  const stateDir = await tempDir('kanban-kb73-state-');
  await writeFile(join(root, 'README.md'), '# Review fixture\n', 'utf8');
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
const pulseRows = (board) => (Array.isArray(board.pulses) ? board.pulses : []);
const decisionFor = (pulse, ticketId) => (pulse?.decisions ?? []).find((entry) => entry.ticketId === ticketId) ?? null;
const outcomeFor = (pulse, ticketId) => (pulse?.outcomes ?? []).find((entry) => entry.ticketId === ticketId) ?? null;
const decisionsWithReason = (pulse, reason) => (pulse?.decisions ?? []).filter((entry) => entry.reason === reason);
const activityActions = (ticket) => (ticket?.activity ?? []).map((entry) => entry.action);

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

// ---------------------------------------------------------------------------
// Shared review fixture: a Review ticket whose version was implemented by one
// be-developer session, with a written report and an evidence comment.
// ---------------------------------------------------------------------------
const REVIEW_DESCRIPTION = [
  '## Outcome',
  'Review the change through the structured verdict gate and leave an actionable record.',
  '',
  '## Acceptance criteria',
  '1. The reviewer records a structured verdict with every criterion mapped.',
  '2. The ticket leaves Review for its verdict lane: Done or In Progress.',
  '',
  '## Evidence plan',
  '- node --test tests/autopilot-review.test.mjs',
  '- the captured review brief',
].join('\n');
const EXPECTED_AC_SECTION = [
  '## Acceptance criteria',
  '1. The reviewer records a structured verdict with every criterion mapped.',
  '2. The ticket leaves Review for its verdict lane: Done or In Progress.',
].join('\n');
const EXPECTED_EVIDENCE_SECTION = [
  '## Evidence plan',
  '- node --test tests/autopilot-review.test.mjs',
  '- the captured review brief',
].join('\n');
const IMPLEMENTER_REPORT = 'Implemented the review lane; node --test tests/autopilot-review.test.mjs passed.';
const IMPLEMENTER_EVIDENCE = 'Evidence: node --test tests/autopilot-review.test.mjs passed (review harness).';
const REVIEWER_ACCESS_POLICY = 'test-capable';

function implementerName(ticketId) {
  return `be · ${ticketId}`;
}

/** Seed the persisted board with the implementer's done execution + evidence. */
async function seedImplementation(stateDir, ticketId) {
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticketId);
    target.owner = {
      sessionId: 'session-implementer',
      name: implementerName(ticketId),
      role: 'be-developer',
      memberId: 'member-be-developer',
    };
    target.execution = {
      sessionId: 'session-implementer',
      status: 'done',
      role: 'be-developer',
      accessMode: 'workspace-write',
      startColumn: 'ready',
      origin: 'autopilot',
      startedAt: virtualNow - 600_000,
      updatedAt: virtualNow - 500_000,
      finishedAt: virtualNow - 500_000,
      report: IMPLEMENTER_REPORT,
      error: '',
      blocked: null,
    };
    target.assignment = null;
    target.comments.push({
      id: 'comment-implementer-evidence',
      author: implementerName(ticketId),
      text: IMPLEMENTER_EVIDENCE,
      at: virtualNow - 520_000,
    });
  });
}

async function reviewFixture(options = {}) {
  const { app, stateDir, scheduler } = await freshApp();
  const laneCaps = options.laneCaps ?? { refine: 0, implement: 0, review: 1 };
  await app.configure({ enabled: true, backoffMs: options.backoffMs, laneCaps });
  const ticket = await createTicket(app, {
    title: 'Review the verdict gate',
    description: REVIEW_DESCRIPTION,
    column: 'review',
    role: 'be-developer',
    priority: 'high',
    labels: ['autopilot', 'lane-review'],
  });
  await seedImplementation(stateDir, ticket.id);
  return { app, stateDir, scheduler, ticket };
}

/** Dispatch the review lane and capture the prompt it was started with. */
async function dispatchReviewer(app, hook = null) {
  app.setPromptHook(async (request) => {
    app.setPromptHook(null);
    if (hook) await hook(request);
  });
  const result = await app.pulseNow();
  const sessionId = app.createdSessions[0];
  const prompt = app.prompts.find((entry) => entry.sessionId === sessionId)?.text ?? '';
  return { result, pulse: result.json?.value?.pulse ?? null, sessionId, prompt };
}

// ===========================================================================
// AC 1 — additive review model: normalization, cap, snapshot, no reviews
// ===========================================================================
section('AC 1 — Ticket.reviews: normalized [] for old tickets, newest-first cap 20, snapshot');
{
  const { app, stateDir, root, scheduler } = await freshApp();
  const legacy = await createTicket(app, { title: 'Legacy ticket without reviews', priority: 'low' });
  const capped = await createTicket(app, { title: 'Ticket with review history', priority: 'low' });
  await patchBoardOnDisk(stateDir, (board) => {
    // A hand-edited/older board: one ticket has no reviews key at all, the other
    // has 25 rows with hostile extras, an unknown verdict, and an empty criterion.
    delete ticketOf(board, legacy.id).reviews;
    ticketOf(board, capped.id).reviews = Array.from({ length: 25 }, (_, index) => ({
      id: `rv-${index + 1}`,
      at: virtualNow - (25 - index) * 1_000,
      reviewerMemberId: `member-${index}`,
      reviewerName: `Reviewer ${index}`,
      sessionId: `session-rv-${index}`,
      verdict: index % 2 === 0 ? 'accepted' : 'changes-requested',
      notes: `review ${index + 1}`,
      criteria: [{ ref: '1', passed: index % 2 === 0, note: `checked ${index + 1}` }],
      evidence: ['node --test tests/autopilot-review.test.mjs'],
      injectedField: 'must be dropped',
    }));
  });
  // The board cache still holds the pre-patch copy; a host restart re-reads and
  // normalizes the persisted board (the same migrate-on-read path a real restart
  // uses).
  const restarted = await makeApp({ stateDir, root, scheduler });
  const snap = await restarted.state();
  const legacySnap = ticketOf(snap.board, legacy.id);
  const cappedSnap = ticketOf(snap.board, capped.id);
  const EXPECTED_KEYS = ['at', 'criteria', 'evidence', 'id', 'notes', 'reviewerMemberId', 'reviewerName', 'sessionId', 'verdict'];
  check('AC1 a ticket written before review verdicts reads as []', Array.isArray(legacySnap?.reviews) && legacySnap.reviews.length === 0, brief(legacySnap?.reviews));
  check('AC1 ticket.reviews is capped to the newest 20', cappedSnap?.reviews?.length === 20, String(cappedSnap?.reviews?.length));
  check('AC1 ticket.reviews is newest first', cappedSnap?.reviews?.[0]?.id === 'rv-25' && cappedSnap?.reviews?.[19]?.id === 'rv-6', `${cappedSnap?.reviews?.[0]?.id}/${cappedSnap?.reviews?.[19]?.id}`);
  check(
    'AC1 each row carries exactly the AC 1 field shape',
    cappedSnap?.reviews?.every((row) => String(Object.keys(row).sort()) === String(EXPECTED_KEYS)),
    brief(Object.keys(cappedSnap?.reviews?.[0] ?? {})),
  );
  check(
    'AC1 the normalized row keeps the fields and drops an injected one',
    cappedSnap?.reviews?.[0]?.reviewerName === 'Reviewer 24' &&
      cappedSnap?.reviews?.[0]?.verdict === 'accepted' &&
      cappedSnap?.reviews?.[0]?.criteria?.[0]?.passed === true &&
      !('injectedField' in (cappedSnap?.reviews?.[0] ?? {})),
    brief(cappedSnap?.reviews?.[0]),
  );
  // The next board save persists the bounded, canonical shape additively.
  await restarted.configure({});
  const persisted = ticketOf(await readBoard(stateDir), capped.id);
  check('AC1 the next save persists the bounded reviews list', persisted?.reviews?.length === 20, String(persisted?.reviews?.length));
  check('AC1 the persisted reviews list keeps the AC 1 shape', String(Object.keys(persisted?.reviews?.[0] ?? {}).sort()) === String(EXPECTED_KEYS), brief(Object.keys(persisted?.reviews?.[0] ?? {})));
  capture('AC1 normalized newest review row', JSON.stringify(cappedSnap?.reviews?.[0]));
  await restarted.dispose();
  await app.dispose();
}

// ===========================================================================
// AC 2 — one review dispatch with the test-capable access and the review brief
// ===========================================================================
section('AC 2 — eligible Review dispatch, access decision, review brief');
{
  const { app, stateDir, ticket } = await reviewFixture();
  const { result, pulse, sessionId, prompt } = await dispatchReviewer(app);
  const board = await readBoard(stateDir);
  const dispatchedTicket = ticketOf(board, ticket.id);
  const dispatchRow = decisionFor(pulse, ticket.id);
  const permission = app.permissionSets.find((entry) => entry.session === sessionId) ?? null;

  check('AC2 the pulse returns 200 and dispatches exactly one session', result.status === 200 && pulse?.dispatched?.length === 1, `${result.status}/${pulse?.dispatched?.length}`);
  check('AC2 exactly one agents.create call starts a session', app.createCalls.length === 1, String(app.createCalls.length));
  check('AC2 the dispatched ticket is the Review ticket', pulse?.dispatched?.[0]?.ticketId === ticket.id, brief(pulse?.dispatched?.[0]));
  check('AC2 the review role is selected (reviewer, not the implementer role)', dispatchRow?.role === 'reviewer' && pulse?.dispatched?.[0]?.memberId === 'member-reviewer', brief(dispatchRow));
  check(
    'AC2 the review lane applies the documented test-capable access preset',
    dispatchedTicket?.execution?.accessMode === 'workspace-write' && permission?.value === 'workspace-write',
    brief({ execution: dispatchedTicket?.execution?.accessMode, permission }),
  );
  check(
    'AC2 the review dispatch never selects danger-full-access',
    dispatchRow?.accessMode === 'workspace-write' && app.permissionSets.every((entry) => entry.value !== 'danger-full-access'),
    brief({ row: dispatchRow?.accessMode, permissions: app.permissionSets }),
  );
  check('AC2 the execution is fingerprinted as an autopilot dispatch from Review', dispatchedTicket?.execution?.origin === 'autopilot' && dispatchedTicket?.execution?.startColumn === 'review', brief(dispatchedTicket?.execution));

  check('AC2 the brief is the review-lane brief', prompt.includes('## Review brief — autopilot review lane'), brief(prompt.slice(0, 160)));
  check(
    'AC2 the brief carries the acceptance criteria verbatim',
    prompt.includes(`### Acceptance criteria — the rubric (verbatim from the ticket)\n${EXPECTED_AC_SECTION}`),
    `${EXPECTED_AC_SECTION.split('\n').length} quoted lines`,
  );
  check(
    'AC2 the brief carries the evidence plan verbatim',
    prompt.includes(EXPECTED_EVIDENCE_SECTION),
    `${EXPECTED_EVIDENCE_SECTION.split('\n').length} quoted lines`,
  );
  check('AC2 the brief carries the implementer report verbatim', prompt.includes(IMPLEMENTER_REPORT), `${IMPLEMENTER_REPORT.length} chars`);
  check('AC2 the brief carries the implementer evidence comment', prompt.includes(IMPLEMENTER_EVIDENCE), `${IMPLEMENTER_EVIDENCE.length} chars`);
  check(
    'AC2 the brief instructs a structured verdict and the ticket move',
    prompt.includes('"action":"review"') &&
      prompt.includes('"verdict":"accepted"') &&
      prompt.includes('"verdict":"changes-requested"') &&
      prompt.includes('Review → Done') &&
      prompt.includes('Review → In Progress'),
    brief(prompt.slice(prompt.indexOf('### Record the verdict'), prompt.indexOf('### Record the verdict') + 160)),
  );
  check(
    'AC2 the brief records the access decision and the no-source-edit rule',
    prompt.includes(`test-capable preset (sandbox: workspace-write, policy: ${REVIEWER_ACCESS_POLICY})`) &&
      prompt.includes('Do NOT edit the change under review') &&
      prompt.includes('Never request danger-full-access'),
    brief(prompt.slice(prompt.indexOf('### Access policy'), prompt.indexOf('### Access policy') + 200)),
  );
  check(
    'AC2 the persisted dispatch row records the role and the access decision',
    decisionFor(pulse, ticket.id)?.accessMode === 'workspace-write' && decisionFor(pulse, ticket.id)?.role === 'reviewer',
    brief(decisionFor(pulse, ticket.id)),
  );
  capture('AC2 review dispatch row', JSON.stringify(dispatchRow));
  capture(
    'AC2 review brief excerpt',
    prompt.slice(prompt.indexOf('## Review brief — autopilot review lane'), prompt.indexOf('## How to work')),
  );
  await app.dispose();
}

// ===========================================================================
// AC 3 — separation: the implementer can never review their own version
// ===========================================================================
section('AC 3 — separation from the implementing member/session');
{
  const PLAN_T = 1_780_000_000_000;
  const AUTOPILOT = {
    version: 1,
    enabled: true,
    cadenceMs: 300_000,
    maxReadyDepth: 3,
    laneCaps: { refine: 1, implement: 1, review: 1 },
    maxDispatchesPerPulse: 1,
    budget: { hour: { limit: 20, used: 0, windowStart: 0 }, day: { limit: 60, used: 0, windowStart: 0 } },
    backoffMs: 300_000,
    staleMs: 600_000,
  };
  const member = (id, roleId, overrides = {}) => ({ id, name: id, title: '', roleId, persona: 'p', paused: false, sessionId: null, lastActivatedAt: 0, ...overrides });
  const reviewTicket = (overrides = {}) => ({
    id: 'KB-1',
    number: 1,
    title: 'Review the change',
    description: REVIEW_DESCRIPTION,
    type: 'task',
    priority: 'high',
    column: 'review',
    role: 'be-developer',
    labels: [],
    owner: null,
    blocked: false,
    blockReason: '',
    checklist: [],
    comments: [],
    reviews: [],
    execution: null,
    assignment: null,
    createdAt: PLAN_T - 100_000,
    updatedAt: PLAN_T - 5_000,
    movedAt: PLAN_T - 5_000,
    acceptedAt: null,
    activity: [],
    ...overrides,
  });
  const planBoard = (tickets, members) => ({
    paused: false,
    wip: { backlog: 0, ready: 0, in_progress: 3, review: 5 },
    tickets,
    team: { members },
    pulses: [],
  });
  const implementingOwner = {
    sessionId: 'session-implementer',
    name: 'be · KB-1',
    role: 'be-developer',
    memberId: 'member-rev',
  };
  const onlyImplementerPlan = planPulse(
    planBoard([reviewTicket({ owner: implementingOwner })], [member('member-rev', 'reviewer', { sessionId: 'session-implementer' })]),
    AUTOPILOT,
    PLAN_T,
  );
  check(
    'AC3 the only available reviewer being the implementer records no-member',
    onlyImplementerPlan.decisions.length === 0 && onlyImplementerPlan.skips.some((skip) => skip.reason === 'no-member' && skip.ticketId === 'KB-1'),
    brief({ decisions: onlyImplementerPlan.decisions, skips: onlyImplementerPlan.skips }),
  );
  const secondReviewerPlan = planPulse(
    planBoard(
      [reviewTicket({ owner: implementingOwner })],
      [member('member-rev', 'reviewer', { sessionId: 'session-implementer' }), member('member-rev-2', 'reviewer')],
    ),
    AUTOPILOT,
    PLAN_T,
  );
  check(
    'AC3 a different reviewer is selected when one exists',
    secondReviewerPlan.decisions[0]?.memberId === 'member-rev-2',
    brief(secondReviewerPlan.decisions[0]),
  );

  // End to end: the seeded reviewer member is also the implementer → no session.
  const { app, stateDir, ticket } = await reviewFixture();
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticket.id);
    target.owner = { ...target.owner, memberId: 'member-reviewer', sessionId: 'session-implementer' };
    target.execution.sessionId = 'session-implementer';
  });
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  const board = await readBoard(stateDir);
  check('AC3 the pulse starts no reviewer session', app.createdSessions.length === 0, String(app.createdSessions.length));
  check('AC3 the pulse records no-member for the Review ticket', decisionFor(pulse, ticket.id)?.reason === 'no-member', brief(decisionFor(pulse, ticket.id)));
  check('AC3 the ticket keeps its implementer execution untouched', ticketOf(board, ticket.id)?.execution?.sessionId === 'session-implementer' && ticketOf(board, ticket.id)?.column === 'review', brief(ticketOf(board, ticket.id)?.execution));
  capture('AC3 separation no-member fixture', JSON.stringify({ decision: decisionFor(pulse, ticket.id), createdSessions: app.createdSessions.length }));
  await app.dispose();
}

// ===========================================================================
// AC 4 — accept path; a Done without an accepted verdict is rejected, not silent
// ===========================================================================
section('AC 4 — accepted verdict → Done, pulse verifies; a silent Done is blocked');
{
  const { app, stateDir, ticket } = await reviewFixture();
  let attempts = {};
  const { pulse, sessionId } = await dispatchReviewer(app, async (request) => {
    const target = await ticketForSession(stateDir, request.sessionId);
    attempts.invalidVerdict = await kanban(app, request.sessionId, { action: 'review', ticketId: target.id, verdict: 'approve', notes: 'x', criteria: [{ ref: '1', passed: true }], evidence: [] });
    attempts.missingCriterion = await kanban(app, request.sessionId, {
      action: 'review',
      ticketId: target.id,
      verdict: 'accepted',
      notes: 'only one criterion',
      criteria: [{ ref: '1', passed: true, note: 'checked' }],
      evidence: ['node --test tests/autopilot-review.test.mjs'],
    });
    attempts.verdict = await kanban(app, request.sessionId, {
      action: 'review',
      ticketId: target.id,
      verdict: 'accepted',
      notes: 'Every criterion verified against the final diff and a re-run of the suite.',
      criteria: [
        { ref: '1', passed: true, note: 'verdict shape and every criterion mapped, re-read from ticket.reviews' },
        { ref: '2', passed: true, note: 'moved review → done and the pulse verified column === done' },
      ],
      evidence: ['node --test tests/autopilot-review.test.mjs', IMPLEMENTER_EVIDENCE],
    });
    attempts.moveDone = await kanban(app, request.sessionId, { action: 'move', ticketId: target.id, column: 'done' });
    attempts.finish = await kanban(app, request.sessionId, { action: 'finish', ticketId: target.id, summary: 'Accepted: every criterion verified; suite re-run.' });
  });
  const dispatched = pulse?.dispatched?.[0];
  check('AC4 the review dispatch starts one reviewer session', Boolean(dispatched?.sessionId) && app.createdSessions.length === 1, brief(dispatched));
  check('AC4 an unknown verdict is rejected with ticket/review-invalid', attempts.invalidVerdict?.ok === false && attempts.invalidVerdict?.code === 'ticket/review-invalid', brief(attempts.invalidVerdict));
  check(
    'AC4 an accepted verdict missing a numbered criterion is rejected',
    attempts.missingCriterion?.ok === false && attempts.missingCriterion?.code === 'ticket/review-invalid' && String(attempts.missingCriterion?.message).includes('missing 2'),
    brief(attempts.missingCriterion),
  );
  check('AC4 the complete accepted verdict is accepted', attempts.verdict?.ok === true && attempts.verdict?.value?.review?.verdict === 'accepted', brief(attempts.verdict?.value?.review));
  check('AC4 the reviewer moves Review → Done after the verdict', attempts.moveDone?.ok === true && attempts.finish?.ok === true, brief({ move: attempts.moveDone?.code ?? 'ok', finish: attempts.finish?.code ?? 'ok' }));

  let board = await readBoard(stateDir);
  const acceptedTicket = ticketOf(board, ticket.id);
  check('AC4 the ticket is in Done', acceptedTicket?.column === 'done', acceptedTicket?.column);
  check('AC4 ticket.reviews persists the accepted verdict with the AC 1 shape', acceptedTicket?.reviews?.[0]?.verdict === 'accepted' && acceptedTicket?.reviews?.[0]?.sessionId === sessionId, brief(acceptedTicket?.reviews?.[0]));
  check(
    'AC4 the verdict maps every numbered criterion as passed',
    acceptedTicket?.reviews?.[0]?.criteria?.length === 2 && acceptedTicket.reviews[0].criteria.every((entry) => entry.passed === true),
    brief(acceptedTicket?.reviews?.[0]?.criteria),
  );
  check('AC4 the verdict records the reviewer identity and name', acceptedTicket?.reviews?.[0]?.reviewerMemberId === 'member-reviewer' && String(acceptedTicket?.reviews?.[0]?.reviewerName ?? '').includes('reviewer'), brief(acceptedTicket?.reviews?.[0]));
  check('AC4 the verdict evidence list is persisted', acceptedTicket?.reviews?.[0]?.evidence?.length === 2, brief(acceptedTicket?.reviews?.[0]?.evidence));

  endTurn(app, sessionId);
  const verify = (await app.pulseNow()).json.value.pulse;
  const satisfied = outcomeFor(verify, ticket.id);
  check('AC4 the pulse verifies the accepted review and records satisfied', satisfied?.outcome === 'satisfied' && satisfied?.lane === 'review', brief(verify.outcomes));
  check('AC4 the satisfied outcome names the accepted verdict and Done', String(satisfied?.detail ?? '').includes('accepted') && String(satisfied?.detail ?? '').includes('Done'), String(satisfied?.detail ?? '').slice(0, 200));
  check('AC4 the pulse dispatches no second reviewer after the accept', app.createdSessions.length === 1, String(app.createdSessions.length));
  board = await readBoard(stateDir);
  check('AC4 the execution is closed as done and the postcondition marker is recorded', ticketOf(board, ticket.id)?.execution?.status === 'done' && ticketOf(board, ticket.id)?.execution?.postcondition?.outcome === 'satisfied', brief(ticketOf(board, ticket.id)?.execution));
  capture('AC4 accepted verdict fixture', JSON.stringify({ review: acceptedTicket?.reviews?.[0], execution: acceptedTicket?.execution, outcome: satisfied, column: acceptedTicket?.column }));
  await app.dispose();
}
{
  // A reviewer that moves to Done without a verdict is rejected at the move; a
  // reviewer that ends idle without a verdict is caught by the postcondition.
  const { app, stateDir, ticket } = await reviewFixture();
  let attempts = {};
  const { pulse, sessionId } = await dispatchReviewer(app, async (request) => {
    const target = await ticketForSession(stateDir, request.sessionId);
    attempts.moveDone = await kanban(app, request.sessionId, { action: 'move', ticketId: target.id, column: 'done' });
    attempts.finish = await kanban(app, request.sessionId, { action: 'finish', ticketId: target.id, summary: 'Accepted without a verdict.' });
  });
  check('AC4 the review dispatch still started', pulse?.dispatched?.length === 1, brief(pulse?.dispatched));
  check('AC4 a review→done without an accepted verdict is rejected by the host', attempts.moveDone?.ok === false && attempts.moveDone?.code === 'ticket/review-verdict-required', brief(attempts.moveDone));
  check('AC4 finishing an unmoved review ticket is rejected as not advanced', attempts.finish?.ok === false && attempts.finish?.code === 'execution/not-advanced', brief(attempts.finish));
  let board = await readBoard(stateDir);
  check('AC4 the silent Done never happened: the ticket stays in Review', ticketOf(board, ticket.id)?.column === 'review', ticketOf(board, ticket.id)?.column);
  check(
    'AC4 the rejected move is logged as a policy error on the ticket',
    (ticketOf(board, ticket.id)?.activity ?? []).some((entry) => entry.action === 'move-rejected' && String(entry.text).includes('ticket/review-verdict-required')),
    brief(ticketOf(board, ticket.id)?.activity),
  );
  endTurn(app, sessionId);
  const verify = (await app.pulseNow()).json.value.pulse;
  const failedOutcome = outcomeFor(verify, ticket.id);
  board = await readBoard(stateDir);
  check('AC4 a missing verdict records postcondition-failed', failedOutcome?.outcome === 'postcondition-failed' && failedOutcome?.lane === 'review', brief(verify.outcomes));
  check(
    'AC4 the missed review carries a persisted postcondition-failed comment',
    (ticketOf(board, ticket.id)?.comments ?? []).some((comment) => String(comment.text).startsWith('[autopilot postcondition-failed]')),
    brief((ticketOf(board, ticket.id)?.comments ?? []).slice(-2)),
  );
  capture('AC4 silent-Done rejection fixture', JSON.stringify({ move: attempts.moveDone, finish: attempts.finish, outcome: failedOutcome, activity: ticketOf(board, ticket.id)?.activity }));
  await app.dispose();
}

// ===========================================================================
// AC 5 — change-request handback, review→ready rejection, assignment
// ===========================================================================
section('AC 5 — changes-requested → In Progress, implementation assignment, pulse handback');
{
  const { app, stateDir, ticket } = await reviewFixture({ laneCaps: { refine: 0, implement: 1, review: 1 } });
  let attempts = {};
  const { pulse, sessionId } = await dispatchReviewer(app, async (request) => {
    const target = await ticketForSession(stateDir, request.sessionId);
    // AC 5: Review has no edge to Ready — the attempt must be a recorded policy
    // error, never retried into an illegal move.
    attempts.moveReady = await kanban(app, request.sessionId, { action: 'move', ticketId: target.id, column: 'ready' });
    attempts.noNotes = await kanban(app, request.sessionId, {
      action: 'review',
      ticketId: target.id,
      verdict: 'changes-requested',
      notes: '',
      criteria: [{ ref: '1', passed: false }],
    });
    attempts.noFailed = await kanban(app, request.sessionId, {
      action: 'review',
      ticketId: target.id,
      verdict: 'changes-requested',
      notes: 'A blocking defect.',
      criteria: [{ ref: '1', passed: true }, { ref: '2', passed: true }],
    });
    attempts.verdict = await kanban(app, request.sessionId, {
      action: 'review',
      ticketId: target.id,
      verdict: 'changes-requested',
      notes: 'Blocking: criterion 1 is unproven — the pulse does not assert column === done.',
      criteria: [
        { ref: '1', passed: false, note: 'no assertion proves the Done postcondition' },
        { ref: '2', passed: true, note: 'the verdict lane path is implemented' },
      ],
      evidence: ['node --test tests/autopilot-review.test.mjs (the failing criterion)'],
    });
    attempts.moveBack = await kanban(app, request.sessionId, { action: 'move', ticketId: target.id, column: 'in_progress' });
    attempts.finish = await kanban(app, request.sessionId, { action: 'finish', ticketId: target.id, summary: 'Changes requested: criterion 1 is unproven.' });
  });
  check('AC 5 the review dispatch started', pulse?.dispatched?.length === 1, brief(pulse?.dispatched));
  check('AC 5 an attempted review→ready is rejected with the policy reason', attempts.moveReady?.ok === false && attempts.moveReady?.code === 'ticket/invalid-transition' && String(attempts.moveReady?.message).includes('review → ready'), brief(attempts.moveReady));
  check('AC 5 changes-requested without a blocking note is rejected', attempts.noNotes?.ok === false && attempts.noNotes?.code === 'ticket/review-invalid', brief(attempts.noNotes));
  check('AC 5 changes-requested without a passed:false criterion is rejected', attempts.noFailed?.ok === false && attempts.noFailed?.code === 'ticket/review-invalid', brief(attempts.noFailed));
  check('AC 5 the complete changes-requested verdict is accepted', attempts.verdict?.ok === true && attempts.verdict?.value?.review?.verdict === 'changes-requested', brief(attempts.verdict?.value?.review?.verdict));
  check('AC 5 the reviewer moves Review → In Progress after the verdict', attempts.moveBack?.ok === true && attempts.finish?.ok === true, brief({ move: attempts.moveBack?.code ?? 'ok' }));

  let board = await readBoard(stateDir);
  const handedBack = ticketOf(board, ticket.id);
  check('AC 5 the ticket is back In Progress', handedBack?.column === 'in_progress', handedBack?.column);
  check('AC 5 the verdict is persisted with at least one failed criterion', handedBack?.reviews?.[0]?.verdict === 'changes-requested' && handedBack.reviews[0].criteria.some((entry) => entry.passed === false), brief(handedBack?.reviews?.[0]));
  check('AC 5 the blocking note survives in the verdict', String(handedBack?.reviews?.[0]?.notes ?? '').includes('criterion 1 is unproven'), String(handedBack?.reviews?.[0]?.notes ?? '').slice(0, 160));
  check('AC 5 the handback assigns the implementation role', handedBack?.assignment?.role === 'be-developer', brief(handedBack?.assignment));
  check('AC 5 the reviewer is no longer the owner', handedBack?.owner === null, brief(handedBack?.owner));
  check(
    'AC 5 the review→ready attempt is logged as a policy error on the ticket',
    (handedBack?.activity ?? []).some((entry) => entry.action === 'move-rejected' && String(entry.text).includes('review → ready')),
    brief(handedBack?.activity),
  );

  endTurn(app, sessionId);
  const verify = (await app.pulseNow()).json.value.pulse;
  const handbackOutcome = outcomeFor(verify, ticket.id);
  check('AC 5 the pulse verifies the changes-requested verdict and records satisfied', handbackOutcome?.outcome === 'satisfied' && handbackOutcome?.lane === 'review', brief(verify.outcomes));
  check(
    'AC 5 the pulse records the handback (In Progress + implementation role)',
    String(handbackOutcome?.detail ?? '').includes('requested changes') && String(handbackOutcome?.detail ?? '').includes('In Progress') && String(handbackOutcome?.detail ?? '').includes('be-developer'),
    String(handbackOutcome?.detail ?? '').slice(0, 200),
  );
  board = await readBoard(stateDir);
  check(
    'AC 5 the change-requested ticket is picked up as rework from the handback',
    (verify.decisions ?? []).some((entry) => entry.ticketId === ticket.id && entry.action === 'dispatch' && entry.lane === 'implement'),
    brief(verify.decisions),
  );
  check(
    'AC 5 the rework dispatch starts from Ready (the legal handoff bridge)',
    ticketOf(board, ticket.id)?.column === 'ready' && ticketOf(board, ticket.id)?.execution?.startColumn === 'ready',
    brief({ column: ticketOf(board, ticket.id)?.column, execution: ticketOf(board, ticket.id)?.execution }),
  );
  capture('AC 5 changes-requested verdict fixture', JSON.stringify({ review: handedBack?.reviews?.[0], assignment: handedBack?.assignment, outcome: handbackOutcome, moveReady: attempts.moveReady }));
  await app.dispose();
}

// ===========================================================================
// AC 6 — phase-1 review cap: two Review tickets + one reviewer member
// ===========================================================================
section('AC 6 — phase-1 review cap: one session + one lane-cap:review skip');
{
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, maxDispatchesPerPulse: 2, laneCaps: { refine: 0, implement: 0, review: 1 } });
  const high = await createTicket(app, { title: 'Review ticket high', description: REVIEW_DESCRIPTION, column: 'review', role: 'be-developer', priority: 'high' });
  const critical = await createTicket(app, { title: 'Review ticket critical', description: REVIEW_DESCRIPTION, column: 'review', role: 'be-developer', priority: 'critical' });
  const plan = await app.action('autopilot', { op: 'plan' });
  const plannedReview = (plan.json.value.decisions ?? []).filter((entry) => entry.lane === 'review');
  check('AC6 the dry-run plan admits exactly one review decision', plannedReview.length === 1, brief(plan.json.value.decisions));
  check('AC6 the critical Review ticket is planned first', plannedReview[0]?.ticketId === critical.id, brief({ planned: plannedReview[0]?.ticketId, critical: critical.id }));
  const result = await app.pulseNow();
  const pulse = result.json.value.pulse;
  const laneCaps = decisionsWithReason(pulse, 'lane-cap');
  check('AC6 the pulse dispatches exactly one reviewer', pulse.dispatched.length === 1 && pulse.dispatched[0]?.ticketId === critical.id, brief(pulse.dispatched));
  check('AC6 exactly one session is created', app.createdSessions.length === 1, String(app.createdSessions.length));
  check('AC6 the second Review ticket records lane-cap:review', laneCaps.some((entry) => entry.ticketId === high.id && entry.lane === 'review'), brief(laneCaps));
  const board = await readBoard(stateDir);
  check('AC6 the capped ticket gets no session', ticketOf(board, high.id)?.execution == null, brief(ticketOf(board, high.id)?.execution));
  capture('AC6 review-cap pulse decisions', JSON.stringify(pulse.decisions));
  await app.dispose();
}

// ===========================================================================
// AC 7 — no verdict: comment, postcondition-failed, no second reviewer, backoff
// ===========================================================================
section('AC 7 — a reviewer that ends idle without a verdict is caught and backs off');
{
  const { app, stateDir, scheduler } = await reviewFixture({ backoffMs: 600_000, laneCaps: { refine: 0, implement: 0, review: 1 } });
  const { pulse, sessionId } = await dispatchReviewer(app, async () => {
    // A reviewer that reads the ticket and ends its turn without a verdict or a move.
  });
  const reviewTicketId = pulse?.dispatched?.[0]?.ticketId ?? null;
  check('AC7 the first review dispatch starts one session', Boolean(reviewTicketId) && app.createdSessions.length === 1, brief(pulse?.dispatched));
  endTurn(app, sessionId);
  // A real pulse never lands on the same millisecond as the dispatch: advance the
  // injected clock so the failure comment is newer than the ticket's last action.
  await scheduler.advance(1_000);

  const miss = (await app.pulseNow()).json.value.pulse;
  const failedOutcome = outcomeFor(miss, reviewTicketId);
  check('AC7 the pulse records a review postcondition-failed outcome', failedOutcome?.outcome === 'postcondition-failed' && failedOutcome?.lane === 'review', brief(miss.outcomes));
  check('AC7 the cooldown decision prevents a second reviewer in the same pulse', decisionFor(miss, reviewTicketId)?.reason === 'postcondition-failed', brief(decisionFor(miss, reviewTicketId)));
  check('AC7 no second reviewer session is started', app.createdSessions.length === 1, String(app.createdSessions.length));
  let board = await readBoard(stateDir);
  const missed = ticketOf(board, reviewTicketId);
  const failureComment = (missed?.comments ?? []).find((comment) => String(comment.text).startsWith('[autopilot postcondition-failed]'));
  check('AC7 the ticket carries the postcondition-failed comment', Boolean(failureComment), brief((missed?.comments ?? []).slice(-2)));
  check('AC7 the failed execution row is terminal so the cooldown, not a zombie row, decides', missed?.execution?.status === 'failed', missed?.execution?.status);

  // The failure is recorded once per state change; a repeat pulse stays cooled down.
  const again = (await app.pulseNow()).json.value.pulse;
  const failureComments = (ticketOf(await readBoard(stateDir), reviewTicketId)?.comments ?? []).filter((comment) => String(comment.text).startsWith('[autopilot postcondition-failed]'));
  check('AC7 the failure is recorded once per state change', failureComments.length === 1, String(failureComments.length));
  check('AC7 the repeat pulse keeps reporting the cooldown', decisionFor(again, reviewTicketId)?.reason === 'postcondition-failed', brief(decisionFor(again, reviewTicketId)));
  check('AC7 the repeat pulse starts no session', app.createdSessions.length === 1, String(app.createdSessions.length));

  // After backoffMs the planner retries the review lane for the same ticket.
  await scheduler.advance(600_001);
  await settle();
  check('AC7 the ticket is dispatched again only after backoffMs', app.createdSessions.length === 2, String(app.createdSessions.length));
  const retryPrompt = app.prompts.find((entry) => entry.sessionId === app.createdSessions[1])?.text ?? '';
  check('AC7 the retry prompt is still the review brief', retryPrompt.includes('## Review brief — autopilot review lane'), brief(retryPrompt.slice(0, 120)));
  capture('AC7 postcondition-failed outcome + comment', JSON.stringify({ outcome: failedOutcome, comment: String(failureComment?.text ?? '').slice(0, 300) }));
  await app.dispose();
}

// ===========================================================================
// AC 8 — both prompts captured; the documented access decision is enforced
// ===========================================================================
section('AC 8 — prompts captured and the review access decision asserted');
{
  // Implement prompt (the first half of "captures both prompts").
  const { app: implementApp } = await freshApp();
  await implementApp.configure({ enabled: true, laneCaps: { refine: 0, review: 0 } });
  await createTicket(implementApp, {
    title: 'Implement the review handoff',
    description: REVIEW_DESCRIPTION,
    column: 'ready',
    role: 'be-developer',
    priority: 'high',
  });
  const implementPulse = (await implementApp.pulseNow()).json.value.pulse;
  const implementPrompt = implementApp.prompts[0]?.text ?? '';
  check('AC8 the implement dispatch starts a session and captures its prompt', implementPulse.dispatched.length === 1 && implementPrompt.includes('## Implementation brief — autopilot implement lane'), brief(implementPulse.dispatched));
  capture('AC8 implement brief excerpt', implementPrompt.slice(implementPrompt.indexOf('## Implementation brief'), implementPrompt.indexOf('## How to work')));
  await implementApp.dispose();
}
{
  const { app } = await reviewFixture();
  const { pulse, prompt } = await dispatchReviewer(app);
  check('AC8 the review dispatch starts a session and captures its prompt', pulse?.dispatched?.length === 1 && prompt.includes('## Review brief — autopilot review lane'), brief(pulse?.dispatched));
  const snapshot = await app.state();
  check(
    'AC8 the review-lane access suggestion is the documented test-capable preset (never danger-full-access)',
    snapshot.accessModes?.suggestions?.review === 'workspace-write' &&
      snapshot.accessModes.suggestions.review !== 'danger-full-access' &&
      snapshot.accessModes.suggestions.review !== 'read-only',
    brief(snapshot.accessModes?.suggestions),
  );
  check(
    'AC8 the review session is never granted danger-full-access',
    snapshot.accessModes.options.every((option) => typeof option.value === 'string') &&
      app.permissionSets.every((entry) => entry.value !== 'danger-full-access'),
    brief(app.permissionSets),
  );
  check(
    'AC8 the review brief states that the test-capable access is only for running tests',
    prompt.includes('That exception is only for running tests and writing temporary artifacts.') && prompt.includes('no source, test, documentation, or persisted-board edits'),
    brief(prompt.slice(prompt.indexOf('### Access policy'), prompt.indexOf('### Access policy') + 240)),
  );
  capture('AC8 review brief excerpt', prompt.slice(prompt.indexOf('## Review brief'), prompt.indexOf('## How to work')));
  await app.dispose();
}

// ===========================================================================
// Unit — the review postcondition predicate and the pure model
// ===========================================================================
section('unit — evaluateReviewPostcondition');
{
  const acceptedReview = {
    id: 'rv-1',
    at: 10,
    reviewerMemberId: 'member-reviewer',
    reviewerName: 'reviewer · KB-1',
    sessionId: 'session-reviewer',
    verdict: 'accepted',
    notes: '',
    criteria: [
      { ref: '1', passed: true, note: 'ok' },
      { ref: '2', passed: true, note: 'ok' },
    ],
    evidence: ['node --test tests/autopilot-review.test.mjs'],
  };
  const changesReview = {
    ...acceptedReview,
    verdict: 'changes-requested',
    notes: 'Blocking: criterion 2 is unproven.',
    criteria: [{ ref: '1', passed: true }, { ref: '2', passed: false, note: 'unproven' }],
  };
  const baseTicket = {
    id: 'KB-1',
    description: REVIEW_DESCRIPTION,
    reviews: [acceptedReview],
    assignment: null,
  };
  const done = evaluateReviewPostcondition({ ...baseTicket, column: 'done' });
  check('unit an accepted verdict in Done with every criterion passed is satisfied', done.ok === true && done.verdict === 'accepted', brief(done));
  const notDone = evaluateReviewPostcondition({ ...baseTicket, column: 'review' });
  check('unit an accepted verdict still in Review fails and names Done', notDone.ok === false && notDone.missing.some((item) => item.includes('Done')), brief(notDone));
  const unmapped = evaluateReviewPostcondition({
    ...baseTicket,
    column: 'done',
    reviews: [{ ...acceptedReview, criteria: [{ ref: '1', passed: true }] }],
  });
  check('unit an accepted verdict missing a numbered criterion fails', unmapped.ok === false && unmapped.missing.some((item) => item.includes('criterion 2')), brief(unmapped));
  const handback = evaluateReviewPostcondition({
    ...baseTicket,
    column: 'in_progress',
    reviews: [changesReview],
    assignment: { role: 'be-developer' },
  });
  check('unit a changes-requested verdict In Progress with the implementation role is satisfied', handback.ok === true && handback.verdict === 'changes-requested', brief(handback));
  const noAssignment = evaluateReviewPostcondition({ ...baseTicket, column: 'in_progress', reviews: [changesReview], assignment: null });
  check('unit a changes-requested handback without an implementation role fails', noAssignment.ok === false && noAssignment.missing.some((item) => item.includes('assignment')), brief(noAssignment));
  const noFailed = evaluateReviewPostcondition({
    ...baseTicket,
    column: 'in_progress',
    reviews: [{ ...changesReview, criteria: [{ ref: '1', passed: true }] }],
    assignment: { role: 'be-developer' },
  });
  check('unit a changes-requested verdict without a failed criterion fails', noFailed.ok === false && noFailed.missing.some((item) => item.includes('passed:false')), brief(noFailed));
  const noVerdict = evaluateReviewPostcondition({ ...baseTicket, column: 'done', reviews: [] });
  check('unit no verdict at all fails (never a silent Done)', noVerdict.ok === false && noVerdict.missing.some((item) => item.includes('no review verdict')), brief(noVerdict));
  const unknownVerdict = evaluateReviewPostcondition({ ...baseTicket, column: 'done', reviews: [{ ...acceptedReview, verdict: 'approve' }] });
  check('unit an unknown verdict fails instead of being promoted', unknownVerdict.ok === false && unknownVerdict.verdict === null, brief(unknownVerdict));
  check('unit a corrupt ticket never throws', evaluateReviewPostcondition(null).ok === false, brief(evaluateReviewPostcondition(null)));
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
Date.now = realDateNow;
for (const dir of dirs) await rm(dir, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? 'ALL KB-73 REVIEW CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
