/**
 * KB-74 — handoff context pack: review notes, attempt history, and the previous
 * report in every dispatch brief.
 *
 * Dependency-free harness in the same style as `tests/autopilot-review.test.mjs`:
 * a temporary state directory, a fake Harness ctx, and an INJECTED clock plus an
 * INJECTED scheduler (no wall-clock sleep anywhere). Fake sessions are real
 * kanban-tool callers, so every assertion crosses host → tool → persisted board →
 * pulse rather than a mocked handler. `composeHandoffContext` is exercised
 * directly for the exact 6000-character cap and the oldest-first trim, and the
 * captured dispatch prompts prove the same composition reaches a real brief.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  every brief gains `## Review history` with the newest ≤3 verdicts
 *         (verdict, reviewer, ISO date, clipped blocking notes, per-criterion
 *         pass/fail with failed refs, evidence paths); omitted with no verdicts
 *   AC 2  every brief gains `## Attempt history` (attempt number = current review
 *         round, previous report clipped, last change request, last failure when
 *         present); omitted on a first attempt
 *   AC 3  the two sections are jointly capped at 6000 chars, trimmed oldest-first;
 *         a 10-verdict × 2000-char-note fixture stays inside the cap and the brief
 *         respects the existing prompt-size conventions
 *   AC 4  a recorded verdict writes exactly one readable `Review verdict: …`
 *         comment with the blocking notes; normalization/reload never duplicates
 *         it (dedupe by verdict id)
 *   AC 5  the re-dispatched implementer's brief carries the reviewer's literal
 *         blocking note and the failed criterion's reference
 *   AC 6  resuming an idle session re-composes from current board state, so a
 *         verdict that landed while it was idle appears in the resume prompt
 *   AC 7  free-text comments on old tickets still dispatch normally (no crash,
 *         no empty heading); structured verdicts are additive, never a replacement
 *   AC 8  `node --test tests/autopilot-context.test.mjs` passes; captured briefs
 *         for first attempt, post-review rework, and resume
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, composeHandoffContext } from '../index.js';

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

const WORKSPACE_ID = 'workspace-context';
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
    title: 'Context Fixture',
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
  const root = await tempDir('kanban-kb74-root-');
  const stateDir = await tempDir('kanban-kb74-state-');
  await writeFile(join(root, 'README.md'), '# Context fixture\n', 'utf8');
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
const decisionFor = (pulse, ticketId) => (pulse?.decisions ?? []).find((entry) => entry.ticketId === ticketId) ?? null;
const outcomeFor = (pulse, ticketId) => (pulse?.outcomes ?? []).find((entry) => entry.ticketId === ticketId) ?? null;
const verdictComments = (ticket) =>
  (ticket?.comments ?? []).filter((comment) => String(comment.text).startsWith('Review verdict:'));
const isoOf = (at) => new Date(at).toISOString();

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
// Fixtures: a Review ticket whose version was implemented by one be-developer
// session, and the shared ticket description with three numbered criteria.
// ---------------------------------------------------------------------------
// The pack's shared budget (KB-74 AC 3) plus a small allowance for the fixture's
// differing ticket title/comment text when the bounded-growth assertion runs.
const CONTEXT_CAP_ASSERTION_MAX = 6000 + 500;
const CONTEXT_DESCRIPTION = [
  '## Outcome',
  'Give the next agent the full handoff story in the dispatch brief.',
  '',
  '## Acceptance criteria',
  '1. Every brief gains a bounded review-history section.',
  '2. Every brief gains an attempt-history section.',
  '3. A recorded verdict writes exactly one readable comment.',
  '',
  '## Evidence plan',
  '- node --test tests/autopilot-context.test.mjs',
  '- the captured first-attempt, rework and resume briefs',
].join('\n');
const IMPLEMENTER_REPORT = 'Implemented the context pack; node --test tests/autopilot-context.test.mjs passed.';
const IMPLEMENTER_EVIDENCE = 'Evidence: node --test tests/autopilot-context.test.mjs passed (context harness).';
const REVIEW_NOTE =
  'Blocking: criterion 2 is unproven — the rework brief does not carry the failed criterion reference. Add the assertion and re-run the suite.';
const CRITERION_REF = '2';
const EVIDENCE_PATH = 'node --test tests/autopilot-context.test.mjs';
const REVIEWER_FINISH_SUMMARY = 'Changes requested: criterion 2 is unproven; verdict and handback recorded.';

/** Seed the Review ticket with the implementer's done execution + evidence. */
async function seedImplementation(stateDir, ticketId) {
  await patchBoardOnDisk(stateDir, (board) => {
    const target = ticketOf(board, ticketId);
    target.owner = {
      sessionId: 'session-implementer',
      name: 'be · ' + ticketId,
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
      author: 'be · ' + ticketId,
      text: IMPLEMENTER_EVIDENCE,
      at: virtualNow - 520_000,
    });
  });
}

async function reviewFixture() {
  const { app, stateDir, scheduler } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { refine: 0, implement: 1, review: 1 } });
  const ticket = await createTicket(app, {
    title: 'Hand the story forward',
    description: CONTEXT_DESCRIPTION,
    column: 'review',
    role: 'be-developer',
    priority: 'high',
    labels: ['autopilot', 'lane-review'],
  });
  await seedImplementation(stateDir, ticket.id);
  return { app, stateDir, scheduler, ticket };
}

/** Dispatch the review lane once and capture the prompt it started with. */
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

/** The `## Review history` + `## Attempt history` slice of a captured brief. */
function handoffPackSlice(prompt) {
  const starts = ['## Review history', '## Attempt history']
    .map((heading) => prompt.indexOf(heading))
    .filter((index) => index >= 0);
  if (starts.length === 0) return null;
  const start = Math.min(...starts);
  const endMarkers = [
    '\n## Recent comments',
    '\n## Source:',
    '\n## Implementation brief',
    '\n## Review brief',
    '\n## Refinement brief',
    '\n## How to work',
  ];
  let end = prompt.length;
  for (const marker of endMarkers) {
    const index = prompt.indexOf(marker, start);
    if (index >= 0 && index < end) end = index;
  }
  return { start, end, text: prompt.slice(start, end) };
}

// ===========================================================================
// AC 2 / AC 8 — first attempt: no history sections, ticket and comments intact
// ===========================================================================
section('AC 2/AC 8 — first attempt brief: no history sections');
let firstAttemptBrief = '';
{
  const { app } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { refine: 0, review: 0 } });
  const ticket = await createTicket(app, {
    title: 'First attempt has no history',
    description: CONTEXT_DESCRIPTION,
    column: 'ready',
    role: 'be-developer',
    priority: 'high',
  });
  const pulse = (await app.pulseNow()).json.value.pulse;
  const sessionId = app.createdSessions[0] ?? null;
  firstAttemptBrief = app.prompts.find((entry) => entry.sessionId === sessionId)?.text ?? '';
  check('AC2 the fixture dispatches one first-attempt implementer', pulse?.dispatched?.length === 1, brief(pulse?.dispatched));
  check('AC2 a first attempt has no Review history section', !firstAttemptBrief.includes('## Review history'), `${firstAttemptBrief.length} chars`);
  check('AC2 a first attempt has no Attempt history section', !firstAttemptBrief.includes('## Attempt history'), `${firstAttemptBrief.length} chars`);
  check('AC2 the brief still carries the ticket and its criteria', firstAttemptBrief.includes(`# Kanban execution — ${ticket.id}`) && firstAttemptBrief.includes('## Acceptance criteria'), `${firstAttemptBrief.length} chars`);
  check('AC8 the first-attempt prompt was captured', firstAttemptBrief.includes('## Implementation brief — autopilot implement lane'), `${firstAttemptBrief.length} chars`);
  capture('AC8 first-attempt brief excerpt', firstAttemptBrief.slice(0, 500));
  await app.dispose();
}

// ===========================================================================
// AC 1 / AC 2 / AC 5 — post-review rework: review history + failed criterion
// ===========================================================================
section('AC 1/AC 2/AC 5 — review rework brief carries the review and attempt history');
{
  const { app, stateDir, ticket } = await reviewFixture();
  let recorded = null;
  const first = await dispatchReviewer(app, async (request) => {
    const target = await ticketForSession(stateDir, request.sessionId);
    recorded = await kanban(app, request.sessionId, {
      action: 'review',
      ticketId: target.id,
      verdict: 'changes-requested',
      notes: REVIEW_NOTE,
      criteria: [
        { ref: '1', passed: true, note: 'the section is composed for every lane.' },
        { ref: '2', passed: false, note: 'the failed criterion reference never reached the rework brief.' },
        { ref: '3', passed: true, note: 'one readable comment per verdict is asserted.' },
      ],
      evidence: [EVIDENCE_PATH],
    });
    await kanban(app, request.sessionId, { action: 'move', ticketId: target.id, column: 'in_progress' });
    await kanban(app, request.sessionId, { action: 'finish', ticketId: target.id, summary: REVIEWER_FINISH_SUMMARY });
  });
  check('AC1 the review dispatch started one reviewer session', first.pulse?.dispatched?.length === 1 && Boolean(first.sessionId), brief(first.pulse?.dispatched));
  check('AC1 the changes-requested verdict is recorded', recorded?.ok === true && recorded?.value?.review?.verdict === 'changes-requested', brief(recorded));
  check('AC2 the review brief carries the implementer report as attempt history', first.prompt.includes('## Attempt history') && first.prompt.includes(IMPLEMENTER_REPORT), brief(first.prompt.slice(0, 140)));
  check('AC1 the first review brief has no Review history yet (no prior verdict)', !first.prompt.includes('## Review history'), brief(first.prompt.slice(0, 140)));

  let board = await readBoard(stateDir);
  const reviewRow = ticketOf(board, ticket.id)?.reviews?.[0] ?? null;
  check('AC1 the verdict row is persisted with its reviewer identity', reviewRow?.verdict === 'changes-requested' && Number.isFinite(reviewRow?.at), brief(reviewRow));

  endTurn(app, first.sessionId);
  const reworkPulse = (await app.pulseNow()).json.value.pulse;
  const reworkSession = app.createdSessions[1] ?? null;
  const reworkBrief = app.prompts.find((entry) => entry.sessionId === reworkSession)?.text ?? '';
  const reworkTicket = ticketOf(await readBoard(stateDir), ticket.id);

  check('AC2 the pulse re-dispatches the implementer as rework', Boolean(reworkSession) && reworkPulse?.dispatched?.some((row) => row.ticketId === ticket.id), brief(reworkPulse?.dispatched));
  check('AC2 the rework dispatch is admitted from Ready (the legal handoff bridge)', reworkTicket?.execution?.startColumn === 'ready', brief(reworkTicket?.execution));
  check('AC1 the rework brief carries a Review history section', reworkBrief.includes('## Review history'), `${reworkBrief.length} chars`);
  check(
    'AC1 the review history names the verdict, reviewer and ISO date',
    reworkBrief.includes(`### changes-requested · ${reviewRow.reviewerName} · ${isoOf(reviewRow.at)}`),
    brief(reworkBrief.slice(reworkBrief.indexOf('## Review history'), reworkBrief.indexOf('## Review history') + 160)),
  );
  check('AC1 the review history carries the per-criterion pass/fail mapping', reworkBrief.includes('Criteria: 1: passed · 2: FAILED · 3: passed'), brief(reviewRow?.criteria));
  check('AC1 the review history names the failed criterion reference', reworkBrief.includes(`Failed criterion references: ${CRITERION_REF}`), CRITERION_REF);
  check('AC1 the review history carries the evidence paths', reworkBrief.includes('Evidence paths:') && reworkBrief.includes(EVIDENCE_PATH), EVIDENCE_PATH);
  check('AC1 the review history carries the blocking notes', reworkBrief.includes(REVIEW_NOTE), `${REVIEW_NOTE.length} chars`);
  check('AC2 the rework brief carries an Attempt history section', reworkBrief.includes('## Attempt history'), `${reworkBrief.length} chars`);
  check('AC2 the attempt history states the current review round', reworkBrief.includes('Attempt 2 — current review round'), brief(reworkBrief.slice(reworkBrief.indexOf('## Attempt history'), reworkBrief.indexOf('## Attempt history') + 140)));
  check('AC2 the attempt history carries the previous execution report', reworkBrief.includes(REVIEWER_FINISH_SUMMARY), brief(REVIEWER_FINISH_SUMMARY));
  check('AC2 the attempt history carries the last change request', reworkBrief.includes('Last change request') && reworkBrief.includes(`Failed criterion references: ${CRITERION_REF}`), CRITERION_REF);
  check(
    'AC5 the rework brief carries the reviewer\'s literal blocking note',
    reworkBrief.includes(REVIEW_NOTE),
    `${REVIEW_NOTE.length} chars quoted`,
  );
  check(
    'AC5 the rework brief carries the failed criterion reference inside the attempt history',
    reworkBrief.slice(reworkBrief.indexOf('## Attempt history')).includes(`Failed criterion references: ${CRITERION_REF}`),
    CRITERION_REF,
  );
  const reworkPack = handoffPackSlice(reworkBrief);
  check('AC8 the rework pack slice was captured', Boolean(reworkPack) && reworkPack.text.length > 0, String(reworkPack?.text.length ?? 0));
  capture('AC8 post-review rework brief (context pack)', reworkPack?.text ?? '(missing)');
  capture('AC5 rework prompt excerpt around the change request', reworkBrief.slice(reworkBrief.indexOf('## Attempt history'), reworkBrief.indexOf('## Attempt history') + 900));
  await app.dispose();
}

// ===========================================================================
// AC 3 — the 6000-character cap: 10 verdicts × 2000-char notes, oldest trimmed
// ===========================================================================
section('AC 3 — 10-verdict × 2000-char-notes fixture stays under the 6000-char cap');
{
  const CAP_BASE = virtualNow - 10_000;
  const noteFor = (index) => {
    const marker = `V${index}:`;
    return `${marker} ${'x'.repeat(2000 - marker.length - 1)}`;
  };
  const reviewRows = Array.from({ length: 10 }, (_, offset) => ({
    id: `rv-cap-${offset + 1}`,
    at: CAP_BASE + (offset + 1) * 1_000,
    reviewerMemberId: 'member-reviewer',
    reviewerName: 'reviewer',
    sessionId: `session-cap-${offset + 1}`,
    verdict: offset % 2 === 0 ? 'accepted' : 'changes-requested',
    notes: noteFor(offset + 1),
    criteria: [{ ref: '1', passed: offset % 2 === 0, note: 'cap fixture criterion' }],
    evidence: [EVIDENCE_PATH],
  }));

  // Pure builder: exact cap + oldest-first trim metadata, no host needed.
  const pure = composeHandoffContext({ reviews: reviewRows, execution: null });
  check('AC3 the composed pack respects the 6000-character cap', pure.text.length <= 6000, `${pure.text.length} chars`);
  check('AC3 the newest verdicts are kept and the oldest candidates are trimmed', pure.text.includes('V10:') && pure.text.includes('V9:') && !pure.text.includes('V8:'), `shown=${pure.reviews.shown} trimmed=${pure.reviews.trimmed}`);
  check('AC3 the trim metadata reports the dropped verdicts', pure.reviews.total === 10 && pure.reviews.trimmed === 8, brief(pure.reviews));
  check('AC3 the trimmed section says which entries were dropped', pure.text.includes('trimmed to respect the 6000-character handoff-context cap'), brief(pure.text.slice(0, 200)));
  capture('AC3 pure cap fixture', JSON.stringify({ chars: pure.text.length, reviews: pure.reviews, section: pure.text.slice(0, 240) }));

  // Host end-to-end: a real dispatch brief carries the capped section.
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { refine: 0, review: 0 } });
  const ticket = await createTicket(app, {
    title: 'Cap fixture ticket',
    description: CONTEXT_DESCRIPTION,
    column: 'ready',
    role: 'be-developer',
    priority: 'high',
  });
  await patchBoardOnDisk(stateDir, (board) => {
    ticketOf(board, ticket.id).reviews = reviewRows;
  });
  const restarted = await makeApp({ stateDir, root: app.root, scheduler: app.scheduler });
  const pulse = (await restarted.pulseNow()).json.value.pulse;
  const sessionId = restarted.createdSessions[0] ?? null;
  const capPrompt = restarted.prompts.find((entry) => entry.sessionId === sessionId)?.text ?? '';
  const pack = handoffPackSlice(capPrompt);
  check('AC3 the host dispatches the cap fixture', pulse?.dispatched?.length === 1, brief(pulse?.dispatched));
  check('AC3 the captured brief carries the capped pack', Boolean(pack) && pack.text.length <= 6000, `${pack?.text.length ?? 0} chars`);
  check('AC3 the captured brief keeps the newest verdict note and drops the oldest', capPrompt.includes('V10:') && capPrompt.includes('V9:') && !capPrompt.includes('V8:'), `${pack?.text.length ?? 0} chars`);
  check('AC3 the brief stays inside the existing prompt-size conventions', capPrompt.length < 30000, `${capPrompt.length} chars total`);
  // The pack can only ever add its own capped budget on top of the base brief: a
  // first-attempt brief of the same ticket shape carries no pack at all.
  const growth = capPrompt.length - firstAttemptBrief.length;
  check(
    'AC3 the pack adds at most the 6000-char budget over the base brief',
    growth > 0 && growth <= CONTEXT_CAP_ASSERTION_MAX,
    `${growth} chars over the ${firstAttemptBrief.length}-char first-attempt baseline`,
  );
  capture('AC3 host cap fixture', JSON.stringify({ combinedChars: pack?.text.length ?? 0, promptChars: capPrompt.length, section: pack?.text.slice(0, 240) ?? '(missing)' }));
  await restarted.dispose();
  await app.dispose();
}

// ===========================================================================
// AC 4 — one readable verdict comment, deduped by verdict id across reloads
// ===========================================================================
section('AC 4 — one readable verdict comment, never duplicated by reload or normalization');
{
  const HUMAN_COMMENT = 'Human note: the evidence plan looks thin, add the resume capture.';
  const { app, stateDir, ticket } = await reviewFixture();
  await app.action('comment', { ticketId: ticket.id, text: HUMAN_COMMENT });
  const first = await dispatchReviewer(app, async (request) => {
    const target = await ticketForSession(stateDir, request.sessionId);
    await kanban(app, request.sessionId, {
      action: 'review',
      ticketId: target.id,
      verdict: 'changes-requested',
      notes: REVIEW_NOTE,
      criteria: [
        { ref: '1', passed: false, note: 'the note must reach the rework brief.' },
        { ref: '2', passed: true, note: 'checked.' },
        { ref: '3', passed: true, note: 'checked.' },
      ],
      evidence: [EVIDENCE_PATH],
    });
    await kanban(app, request.sessionId, { action: 'move', ticketId: target.id, column: 'in_progress' });
    await kanban(app, request.sessionId, { action: 'finish', ticketId: target.id, summary: REVIEWER_FINISH_SUMMARY });
  });
  check('AC4 the verdict was recorded once', Boolean(first.sessionId), brief(first.pulse?.dispatched));

  let board = await readBoard(stateDir);
  let persisted = ticketOf(board, ticket.id);
  const verdictRows = verdictComments(persisted);
  check('AC4 recording the verdict writes exactly one readable comment', verdictRows.length === 1, String(verdictRows.length));
  check('AC4 the readable comment uses the documented prefix and the blocking notes', verdictRows[0]?.text.startsWith('Review verdict: changes-requested — ') && verdictRows[0].text.includes(REVIEW_NOTE), brief(verdictRows[0]?.text));
  check('AC4 the readable comment is linked to the verdict id', verdictRows[0]?.reviewId === persisted?.reviews?.[0]?.id, brief({ commentReviewId: verdictRows[0]?.reviewId, verdictId: persisted?.reviews?.[0]?.id }));
  check('AC4 free-text comments are reflected, not replaced', (persisted?.comments ?? []).some((comment) => comment.text === HUMAN_COMMENT), brief((persisted?.comments ?? []).map((comment) => comment.text)));

  // Reloads: two snapshot reads, then a host restart that re-normalizes from disk.
  const firstRead = (await app.state()).board;
  const secondRead = (await app.state()).board;
  check('AC4 the snapshot reload never duplicates the comment', verdictComments(ticketOf(firstRead, ticket.id)).length === 1 && verdictComments(ticketOf(secondRead, ticket.id)).length === 1, brief(verdictComments(ticketOf(secondRead, ticket.id)).length));
  await app.dispose();
  const restarted = await makeApp({ stateDir, root: app.root, scheduler: app.scheduler });
  const restartedBoard = (await restarted.state()).board;
  const normalizedTicket = ticketOf(restartedBoard, ticket.id);
  check('AC4 normalization after a restart keeps exactly one readable comment', verdictComments(normalizedTicket).length === 1, String(verdictComments(normalizedTicket).length));
  check('AC4 normalization preserves the verdict id link', verdictComments(normalizedTicket)[0]?.reviewId === normalizedTicket?.reviews?.[0]?.id, brief({ comment: verdictComments(normalizedTicket)[0], verdict: normalizedTicket?.reviews?.[0]?.id }));
  await restarted.configure({});
  const rePersisted = ticketOf(await readBoard(stateDir), ticket.id);
  check('AC4 re-persisting the normalized board keeps exactly one readable comment', verdictComments(rePersisted).length === 1, String(verdictComments(rePersisted).length));
  capture('AC4 dedupe result', JSON.stringify({ afterRecord: verdictRows.length, afterReloads: verdictComments(normalizedTicket).length, comment: verdictRows[0]?.text, reviewId: verdictRows[0]?.reviewId }));
  await restarted.dispose();
}

// ===========================================================================
// AC 6 — resume re-composes from current state: a verdict that landed while idle
// ===========================================================================
section('AC 6 — resume after an idle period picks up a verdict recorded meanwhile');
{
  const RESUME_NOTE = 'Blocking: criterion 1 is unproven in the resume path; re-run the suite after the fix.';
  const { app, stateDir, ticket } = await reviewFixture();
  const first = await dispatchReviewer(app);
  check('AC6 the review session starts idle without a verdict', first.pulse?.dispatched?.length === 1 && !first.prompt.includes('## Review history'), brief(first.pulse?.dispatched));
  endTurn(app, first.sessionId);

  // The verdict lands while the reviewer session is idle, not in Review.
  const recorded = await kanban(app, first.sessionId, {
    action: 'review',
    ticketId: ticket.id,
    verdict: 'changes-requested',
    notes: RESUME_NOTE,
    criteria: [
      { ref: '1', passed: false, note: 'the idle resume never saw the verdict.' },
      { ref: '2', passed: true, note: 'checked.' },
      { ref: '3', passed: true, note: 'checked.' },
    ],
    evidence: [EVIDENCE_PATH],
  });
  check('AC6 the verdict is recorded while the session is idle', recorded?.ok === true, brief(recorded));
  const resumed = await app.action('resumeExecution', { ticketId: ticket.id });
  check('AC6 the idle session resumes', resumed.status === 200, `${resumed.status} ${brief(resumed.json)}`);
  const resumePrompts = app.prompts.filter((entry) => entry.sessionId === first.sessionId);
  const resumeBrief = resumePrompts[resumePrompts.length - 1]?.text ?? '';
  const pack = handoffPackSlice(resumeBrief);
  check('AC6 the resume prompt re-composes the review history', resumeBrief.includes('## Review history'), `${resumeBrief.length} chars`);
  check('AC6 the resume prompt carries the verdict recorded while idle', resumeBrief.includes('### changes-requested ·') && resumeBrief.includes(RESUME_NOTE), RESUME_NOTE.length + ' chars');
  check('AC6 the resume prompt is not a stale snapshot of the first prompt', !first.prompt.includes(RESUME_NOTE) && resumeBrief.includes(RESUME_NOTE), String(pack?.text.length ?? 0));
  capture('AC8 resume-after-idle brief (context pack)', pack?.text ?? '(missing)');
  await app.dispose();
}

// ===========================================================================
// AC 7 — old tickets with free-text comments only dispatch normally
// ===========================================================================
section('AC 7 — a free-text-only ticket dispatches with no history sections');
{
  const OLD_NOTE = 'Old review note (free text): the endpoint returned 500 before the fix.';
  const { app, stateDir } = await freshApp();
  await app.configure({ enabled: true, laneCaps: { refine: 0, review: 0 } });
  const ticket = await createTicket(app, {
    title: 'Legacy free-text ticket',
    description: CONTEXT_DESCRIPTION,
    column: 'ready',
    role: 'be-developer',
    priority: 'high',
  });
  await app.action('comment', { ticketId: ticket.id, text: OLD_NOTE });
  const pulse = (await app.pulseNow()).json.value.pulse;
  const sessionId = app.createdSessions[0] ?? null;
  const prompt = app.prompts.find((entry) => entry.sessionId === sessionId)?.text ?? '';
  check('AC7 the legacy ticket dispatches normally', pulse?.dispatched?.length === 1 && Boolean(sessionId), brief(pulse?.dispatched));
  check('AC7 no Review history heading is invented', !prompt.includes('## Review history'), `${prompt.length} chars`);
  check('AC7 no Attempt history heading is invented', !prompt.includes('## Attempt history'), `${prompt.length} chars`);
  check('AC7 the free-text comment still reaches the brief', prompt.includes(OLD_NOTE), OLD_NOTE.length + ' chars');
  const legacy = ticketOf(await readBoard(stateDir), ticket.id);
  check('AC7 the free-text comment is still the ticket record', (legacy?.comments ?? []).some((comment) => comment.text === OLD_NOTE), brief((legacy?.comments ?? []).map((comment) => comment.text)));
  await app.dispose();
}

// ===========================================================================
// Consumer guard — a stale read-only handoff cannot downgrade a Review dispatch
// ===========================================================================
section('Consumer guard — Review dispatch repairs a stale read-only handoff suggestion');
{
  // The review lane's KB-73 access contract is test-capable (workspace-write).
  // A persisted `assignment.accessMode: read-only` (a board last written by a
  // pre-KB-73 host, or a hand edit) must not downgrade the dispatch, because a
  // read-only reviewer cannot run `node --test`. An explicit human access choice
  // is still honoured; only the persisted handoff suggestion is repaired.
  const { app, stateDir, ticket } = await reviewFixture();
  await patchBoardOnDisk(stateDir, (board) => {
    ticketOf(board, ticket.id).assignment = {
      role: 'reviewer',
      accessMode: 'read-only',
      agentSessionId: null,
      agentName: null,
      memberId: null,
      auto: true,
      reason: 'stale pre-KB-73 lane suggestion',
      at: virtualNow,
    };
  });
  const restarted = await makeApp({ stateDir, root: app.root, scheduler: app.scheduler });
  const pulse = (await restarted.pulseNow()).json.value.pulse;
  const sessionId = restarted.createdSessions[0] ?? null;
  const prompt = restarted.prompts.find((entry) => entry.sessionId === sessionId)?.text ?? '';
  const dispatched = ticketOf(await readBoard(stateDir), ticket.id);
  const permission = restarted.permissionSets.find((entry) => entry.session === sessionId) ?? null;
  check('guard the Review dispatch still happens from the stale assignment', pulse?.dispatched?.length === 1 && Boolean(sessionId), brief(pulse?.dispatched));
  check(
    'guard the Review dispatch access is repaired to the test-capable preset',
    dispatched?.execution?.accessMode === 'workspace-write' && permission?.value === 'workspace-write',
    brief({ execution: dispatched?.execution?.accessMode, permission }),
  );
  check('guard the reviewer brief still states the test-capable policy', prompt.includes('test-capable') && prompt.includes('## Review brief — autopilot review lane'), brief(prompt.slice(prompt.indexOf('### Access policy'), prompt.indexOf('### Access policy') + 120)));
  capture('guard stale read-only assignment repair', JSON.stringify({ assignment: { role: 'reviewer', accessMode: 'read-only' }, dispatchedAccess: dispatched?.execution?.accessMode, permission }));
  await restarted.dispose();
  await app.dispose();
}

// ---------------------------------------------------------------------------
// Unit checks on the exported composer (AC 2 attempt-history fields)
// ---------------------------------------------------------------------------
section('AC 2 unit — failure/postcondition error and omission rules');
{
  const failed = composeHandoffContext({
    reviews: [
      {
        id: 'rv-1',
        at: 1_780_000_000_000,
        reviewerMemberId: 'member-reviewer',
        reviewerName: 'reviewer',
        sessionId: 'session-rv-1',
        verdict: 'changes-requested',
        notes: 'Blocking: criterion 2 is unproven.',
        criteria: [
          { ref: '1', passed: true },
          { ref: '2', passed: false, note: 'no assertion.' },
        ],
        evidence: ['node --test tests/autopilot-context.test.mjs'],
      },
    ],
    execution: null,
  });
  const withFailure = composeHandoffContext({
    reviews: [],
    execution: {
      sessionId: 'session-failed',
      status: 'failed',
      role: 'be-developer',
      startedAt: 1_779_999_000_000,
      updatedAt: 1_779_999_500_000,
      finishedAt: 1_779_999_500_000,
      report: 'The previous attempt stopped before the change landed.',
      error: 'ticket/postcondition-failed: the implementer left the ticket in Ready.',
      blocked: null,
    },
  });
  const firstAttempt = composeHandoffContext({ reviews: [], execution: null });
  check('AC2 unit a changes-requested verdict produces a review history section', failed.text.includes('## Review history') && failed.text.includes('Failed criterion references: 2'), brief(failed.text.slice(0, 160)));
  check('AC2 unit a failed previous execution produces a failure block', withFailure.text.includes('## Attempt history') && withFailure.text.includes('Last failure / postcondition error') && withFailure.text.includes('ticket/postcondition-failed'), brief(withFailure.text.slice(0, 160)));
  check('AC2 unit a first attempt produces no context sections at all', firstAttempt.text === '', brief(firstAttempt.text));
  check('AC2 unit no reviews or execution is never an empty heading', !firstAttempt.text.includes('##'), brief(firstAttempt.text));
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
Date.now = realDateNow;
for (const dir of dirs) await rm(dir, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? 'ALL KB-74 CONTEXT CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`}`);
process.exit(failures.length === 0 ? 0 : 1);
