import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepStrictEqual } from 'node:assert';
import { apply } from '../index.js';

// KB-6 intake hardening — fake Harness with an injected clock, two workspaces and
// captured `agents.create`. Every section maps to the ticket acceptance criteria;
// check labels start with the AC number so a reviewer can map criterion -> proof.
//
// Determinism: the clock is injected and only moved explicitly, so the 10-minute
// duplicate window, the 5/minute + 20/hour budget and the 30 s grace never need a
// wall-clock sleep. Every store assertion reads the real persisted JSON.
const START_AT = 1_700_000_000_000;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const WINDOW = 10 * MINUTE;

const rootA = await mkdtemp(join(tmpdir(), 'kanban-hardening-a-'));
const rootB = await mkdtemp(join(tmpdir(), 'kanban-hardening-b-'));
await writeFile(join(rootA, 'README.md'), '# Alpha\n');
await writeFile(join(rootB, 'README.md'), '# Beta\n');

const workspaceA = {
  id: 'workspace-1',
  title: 'Alpha',
  path: rootA,
  sessionIds: [],
  createdAt: new Date(START_AT).toISOString(),
  updatedAt: new Date(START_AT).toISOString(),
  async attachSession() {},
  async status() {
    return 'ok';
  },
};
const workspaceB = {
  id: 'workspace-2',
  title: 'Beta',
  path: rootB,
  sessionIds: [],
  createdAt: new Date(START_AT).toISOString(),
  updatedAt: new Date(START_AT).toISOString(),
  async attachSession() {},
  async status() {
    return 'ok';
  },
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
function makeHarness(dir, { startAt = START_AT, graceMs = 5000 } = {}) {
  const sessionItems = [
    { sessionId: 'session-normal', cwd: rootA, running: false, updatedAt: startAt, projections: { values: { title: 'Normal PM session' } } },
  ];
  const createCalls = [];
  const prompts = [];
  const cancelCalls = [];
  const liveAgents = new Map();
  const flags = { failCreate: false, failPrompt: false };
  let clockNow = startAt;
  const clock = () => clockNow;

  const agents = {
    async create(options) {
      createCalls.push(options);
      if (flags.failCreate) throw new Error('agents service unavailable');
      if (typeof options.setup === 'function') await options.setup({ effect: () => () => {} });
      liveAgents.set(options.sessionId, { id: options.sessionId, status: 'running', inbox: { hasPending: false }, session: { id: options.sessionId } });
      return { agent: { id: options.sessionId, session: { id: options.sessionId } } };
    },
    get(id) {
      return liveAgents.get(id);
    },
    list() {
      return [...liveAgents.values()];
    },
  };

  const services = { agents };
  const routes = new Map();
  const tools = new Map();

  const ctx = {
    effect(fn) {
      const disposer = fn();
      if (typeof disposer !== 'function') throw new Error('effect returned no disposer');
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
    workspaceRegistry: { list: () => [workspaceA, workspaceB] },
    sessionPersistence: {
      async list() {
        return [{ header: { id: 'session-normal', cwd: rootA } }];
      },
      async open() {
        return { async read() { return { events: [] }; }, async close() {} };
      },
      async stat(id) {
        return { header: { id, cwd: rootA } };
      },
    },
    sessionController: {
      async list() {
        return { items: sessionItems.map((item) => ({ ...item })) };
      },
      async prompt(request) {
        if (flags.failPrompt) throw new Error('prompt channel closed');
        prompts.push({ sessionId: request.sessionId, text: request.content.map((part) => part.text || '').join('') });
        return { accepted: true };
      },
      cancel(request) {
        cancelCalls.push(request);
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    agentPresets: {
      resolve: async () => ({ id: 'default-preset' }),
      mount: async () => {},
    },
    permissionPresets: {
      catalog: () => ({
        options: [
          { value: 'read-only', name: 'Read only', description: 'Inspect only' },
          { value: 'workspace-write', name: 'Workspace write', description: 'Modify the workspace' },
          { value: 'danger-full-access', name: 'Full access', description: 'Unrestricted' },
        ],
        defaultOptions: [],
        defaultPreset: 'workspace-write',
      }),
      resolve: (value) => ({ sandbox: value, approval: 'ask' }),
      set: () => {},
    },
    sessionTitle: { rename() {} },
    sessions: { get: (id) => liveAgents.get(id), flush: async () => {} },
    agents,
  };
  services.agentDefaultModel = ctx.agentDefaultModel;
  services.sessionTitle = ctx.sessionTitle;
  services.sessions = ctx.sessions;
  services.permissionPresets = ctx.permissionPresets;
  services.agentPresets = ctx.agentPresets;

  // Production defaults are deliberately NOT overridden here: this suite proves
  // the shipped 5/minute + 20/hour budget against the injected clock.
  apply(ctx, { stateDir: dir, thoughtGraceMs: graceMs, now: clock });

  async function post(path, body) {
    const route = routes.get(path);
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
      setHeader() {},
      end(text) {
        this.body = text ?? '';
      },
    };
    await route.handler(req, res);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  }

  return {
    dir,
    thoughtFile: join(dir, 'thoughts', 'workspace-1.json'),
    thoughtFileOf: (workspaceId) => join(dir, 'thoughts', `${workspaceId}.json`),
    createCalls,
    prompts,
    cancelCalls,
    liveAgents,
    flags,
    clock,
    advance: (ms) => {
      clockNow += ms;
    },
    action: (action, payload = {}, workspaceId = 'workspace-1') => post('/kanban/action', { workspaceId, action, payload }),
    state: async (workspaceId = 'workspace-1') => (await post('/kanban/state', { workspaceId })).json,
    callTool: (args, agentId = 'session-normal') => tools.get('kanban').execute(args, { agent: { id: agentId } }),
    /** The fake session stops running; reconciliation may then mark the thought `done`. */
    finish(sessionId) {
      const agent = liveAgents.get(sessionId);
      if (agent) agent.status = 'idle';
    },
    /** The fake session never materializes: observation fails and the grace applies. */
    lose(sessionId) {
      liveAgents.delete(sessionId);
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const isDeepEqual = (left, right) => {
  try {
    deepStrictEqual(left, right);
    return true;
  } catch {
    return false;
  }
};
const brief = (value) => JSON.stringify(value).slice(0, 240);
const expectRejection = async (label, promise, status, code) => {
  const result = await promise;
  const actual = `${result.status} ${result.json?.error?.code ?? ''}`.trim();
  check(label, result.status === status && result.json?.error?.code === code, `${actual} ${result.json?.error?.message ?? ''}`);
  return result;
};
const rawStore = async (file) => JSON.parse(await readFile(file, 'utf8'));
const rawText = async (file) => readFile(file, 'utf8');
async function seedStore(dir, thoughts, nextNumber = thoughts.length + 1, extra = {}) {
  await mkdir(join(dir, 'thoughts'), { recursive: true });
  await writeFile(
    join(dir, 'thoughts', 'workspace-1.json'),
    JSON.stringify({ version: 1, nextNumber, thoughts, ...extra }),
  );
}
function seededThought(overrides) {
  return {
    id: 'TH-1',
    text: 'Seeded thought',
    status: 'done',
    createdAt: START_AT,
    updatedAt: START_AT,
    sessionId: null,
    error: '',
    ticketIds: [],
    ...overrides,
  };
}
/** Fresh state dir for one isolated scenario. */
const freshDir = () => mkdtemp(join(tmpdir(), 'kanban-hardening-case-'));
/** Submit a thought and return the HTTP result without any finishing. */
const submit = (app, text, workspaceId = 'workspace-1') => app.action('submitThought', { text }, workspaceId);
/** Submit, finish the fake session and reconcile so the working slot frees up. */
async function acceptAndFinish(app, text, workspaceId = 'workspace-1') {
  const res = await submit(app, text, workspaceId);
  if (res.status !== 200) return res;
  app.finish(res.json.value.thought.sessionId);
  await app.state(workspaceId);
  return res;
}
const cleanup = [];
async function makeCase(options) {
  const dir = await freshDir();
  cleanup.push(dir);
  return makeHarness(dir, options);
}

// ===========================================================================
// AC 1 — normalization: trim, collapse whitespace, case-fold, punctuation kept
// ===========================================================================
{
  console.log('\n# AC 1 — normalized duplicate detection');
  const app = await makeCase();
  const text = '  Ship   the   Settings page  ';
  let res = await submit(app, text);
  check('AC1 first submission accepted', res.status === 200 && res.json.ok === true, `${res.status}`);
  const stored = res.json.value.thought.text;
  check('AC1 stored text is verbatim after trimming (internal spacing kept)', stored === 'Ship   the   Settings page', brief(stored));
  check('AC1 normalization is not applied to the stored text', stored !== 'ship the settings page', brief(stored));

  const before = (await app.state()).value.thoughts[0];
  const createsBefore = app.createCalls.length;
  res = await expectRejection(
    'AC1 whitespace + case variant is a duplicate',
    submit(app, ' ship THE settings   PAGE '),
    409,
    'thought/duplicate',
  );
  check('AC1 duplicate message names the existing TH-n', /TH-1/.test(res.json?.error?.message ?? ''), res.json?.error?.message);
  check('AC1 duplicate creates no thought and no dispatch', app.createCalls.length === createsBefore);
  const after = (await app.state()).value.thoughts[0];
  check('AC1 the existing thought is untouched', isDeepEqual(before, after), brief(after));

  // Punctuation is preserved: "!" makes a different normalized string.
  const punctuationApp = await makeCase();
  check('AC1 "Ship it!" accepted', (await submit(punctuationApp, 'Ship it!')).status === 200);
  check('AC1 "Ship it" is NOT a duplicate of "Ship it!"', (await submit(punctuationApp, 'Ship it')).status === 200);
}

// ===========================================================================
// AC 2 — duplicate rejection window/last-20 and crash-free rejection
// ===========================================================================
{
  console.log('\n# AC 2 — duplicate rejection');
  const app = await makeCase();
  const first = await submit(app, 'Add an audit trail for board changes');
  check('AC2 first accepted as TH-1', first.status === 200 && first.json.value.thought.id === 'TH-1');
  const clickBefore = app.createCalls.length;
  const storeBefore = await rawText(app.thoughtFile);
  const res = await expectRejection(
    'AC2 identical normalized text returns 409 thought/duplicate',
    submit(app, 'add an AUDIT   trail for board changes'),
    409,
    'thought/duplicate',
  );
  check('AC2 no agents.create on rejection', app.createCalls.length === clickBefore, String(app.createCalls.length));
  check('AC2 no persisted write on rejection', (await rawText(app.thoughtFile)) === storeBefore);
  check('AC2 response carries no new thought value', res.json?.value === undefined, brief(res.json));

  // Recovery: a failed thought is excluded, so the same text can be retried.
  const failedDir = await freshDir();
  cleanup.push(failedDir);
  const failedApp = makeHarness(failedDir);
  failedApp.flags.failCreate = true;
  let failed = await submit(failedApp, 'A thought whose dispatch fails');
  failedApp.flags.failCreate = false;
  check('AC2 fixture thought is failed', failed.json.value.thought.status === 'failed', failed.json.value.thought.status);
  const recovered = await submit(failedApp, 'a THOUGHT whose dispatch   fails');
  check('AC2 failed text is accepted again', recovered.status === 200 && recovered.json.value.thought.id === 'TH-2', `${recovered.status} ${recovered.json.value?.thought?.id}`);
  const duplicateOfRecovered = await expectRejection(
    'AC2 the recovered live thought now blocks a third copy',
    submit(failedApp, 'a thought whose dispatch fails'),
    409,
    'thought/duplicate',
  );
  check('AC2 duplicate names the recovered row', /TH-2/.test(duplicateOfRecovered.json?.error?.message ?? ''), duplicateOfRecovered.json?.error?.message);
}

// ===========================================================================
// AC 3 — recovery: failed and deleted rows never block a resubmission
// ===========================================================================
{
  console.log('\n# AC 3 — failed and deleted rows are excluded');
  const dir = await freshDir();
  cleanup.push(dir);
  await seedStore(
    dir,
    [
      seededThought({ id: 'TH-1', text: 'Recover me please', status: 'failed', error: 'old failure' }),
      seededThought({ id: 'TH-2', text: 'Deleted idea', status: 'done', deletedAt: START_AT + 10 }),
    ],
    3,
  );
  const app = makeHarness(dir);
  let res = await submit(app, 'recover   ME please');
  check('AC3 failed thought text is accepted as a new row', res.status === 200 && res.json.value.thought.id === 'TH-3', `${res.status} ${res.json.value?.thought?.id}`);
  check('AC3 resubmission dispatches a session', typeof res.json.value.thought.sessionId === 'string' && app.createCalls.length === 1);
  res = await submit(app, 'deleted idea');
  check('AC3 deleted thought text is accepted as a new row', res.status === 200 && res.json.value.thought.id === 'TH-4', `${res.status} ${res.json.value?.thought?.id}`);
  const stored = await rawStore(app.thoughtFile);
  check('AC3 the failed and deleted rows are untouched', stored.thoughts[0].status === 'failed' && stored.thoughts[1].deletedAt > 0);
}

// ===========================================================================
// AC 4 — window expiry (injected clock) and per-workspace isolation
// ===========================================================================
{
  console.log('\n# AC 4 — window expiry and workspace isolation');
  const app = await makeCase();
  let res = await submit(app, 'Windowed idea');
  check('AC4 seeded submission accepted', res.status === 200 && res.json.value.thought.id === 'TH-1');
  app.advance(WINDOW + 1);
  res = await submit(app, 'windowed IDEA');
  check('AC4 identical text accepted after the 10-minute window', res.status === 200 && res.json.value.thought.id === 'TH-2', `${res.status} ${res.json.error?.code}`);
  check('AC4 two rows persist after window expiry', (await app.state()).value.thoughts.length === 2);

  const cross = await makeCase();
  res = await submit(cross, 'Cross workspace thought', 'workspace-1');
  check('AC4 submission in workspace 1 accepted', res.status === 200);
  res = await submit(cross, 'cross WORKSPACE thought', 'workspace-2');
  check('AC4 same text in another workspace is not a duplicate', res.status === 200 && res.json.value.thought.id === 'TH-1', `${res.status} ${res.json.error?.code}`);
  const duplicateInTwo = await expectRejection(
    'AC4 matching stays per workspace',
    submit(cross, 'cross workspace thought', 'workspace-2'),
    409,
    'thought/duplicate',
  );
  check('AC4 per-workspace duplicate names that workspace row', /TH-1/.test(duplicateInTwo.json?.error?.message ?? ''));
  const workspaceTwoStore = await rawStore(cross.thoughtFileOf('workspace-2'));
  check('AC4 workspace 2 keeps its own store file', workspaceTwoStore.thoughts.length === 1, String(workspaceTwoStore.thoughts.length));
}

// ===========================================================================
// AC 5 — concurrency: two identical submissions in one tick
// ===========================================================================
{
  console.log('\n# AC 5 — in-process concurrency');
  const app = await makeCase();
  const [left, right] = await Promise.all([
    submit(app, 'Race the intake boundary'),
    submit(app, 'race   THE intake boundary'),
  ]);
  const statuses = [left.status, right.status].sort((a, b) => a - b);
  check('AC5 exactly one 200 and one 409', statuses[0] === 200 && statuses[1] === 409, statuses.join(','));
  const rejected = left.status === 409 ? left : right;
  check('AC5 the loser is thought/duplicate', rejected.json?.error?.code === 'thought/duplicate', rejected.json?.error?.code);
  const store = await rawStore(app.thoughtFile);
  check('AC5 exactly one persisted thought', store.thoughts.length === 1, String(store.thoughts.length));
  check('AC5 exactly one dispatch', app.createCalls.length === 1, String(app.createCalls.length));
  check('AC5 rejected submission consumed no budget', store.rateLog.length === 1, brief(store.rateLog));
  check('AC5 thought store is valid JSON with version 1', store.version === 1 && store.nextNumber === 2);
  const thought = store.thoughts[0];
  check('AC5 accepted row carries submitted + dispatched audit', isDeepEqual(thought.intakeAudit.map((entry) => entry.type), ['submitted', 'dispatched']), brief(thought.intakeAudit));
  check('AC5 no atomic temp files left behind', (await readdir(join(app.dir, 'thoughts'))).every((name) => !name.includes('.tmp-')));

  const restarted = makeHarness(app.dir);
  const restartedState = (await restarted.state()).value;
  const restartedThought = restartedState.thoughts.find((candidate) => candidate.id === 'TH-1');
  check('AC5 the store loads after a restart', restartedThought?.status === 'working' && isDeepEqual(restartedThought.intakeAudit.map((entry) => entry.type), ['submitted', 'dispatched']), brief(restartedThought));
}

// ===========================================================================
// AC 6 — per-workspace rate limits: 5/minute and 20/hour
// ===========================================================================
{
  console.log('\n# AC 6 — per-workspace intake budget');
  const app = await makeCase();
  const accepted = [];
  for (let index = 0; index < 5; index += 1) {
    const res = await acceptAndFinish(app, `Burst idea ${index}`);
    accepted.push(res.status);
  }
  check('AC6 five submissions accepted inside one minute', accepted.every((status) => status === 200), accepted.join(','));
  const createsBefore = app.createCalls.length;
  const rejected = await expectRejection(
    'AC6 the sixth submission in a minute is 429 thought/rate-limit',
    submit(app, 'Burst idea 5'),
    429,
    'thought/rate-limit',
  );
  check('AC6 429 message carries a retry hint in seconds', /try again in \d+ seconds?/i.test(rejected.json?.error?.message ?? ''), rejected.json?.error?.message);
  check('AC6 rejected submission creates no thought and no session', app.createCalls.length === createsBefore && (await app.state()).value.thoughts.length === 5);
  check('AC6 rejected submission is not in the store', (await rawStore(app.thoughtFile)).thoughts.length === 5);
  let res = await submit(app, 'Other workspace is untouched', 'workspace-2');
  check('AC6 another workspace has its own budget', res.status === 200, `${res.status} ${res.json.error?.code}`);
  const restartedBudget = makeHarness(app.dir);
  await expectRejection(
    'AC6 the persisted budget survives a Host restart',
    submit(restartedBudget, 'Burst idea after restart'),
    429,
    'thought/rate-limit',
  );

  // A rejected duplicate does not consume the minute budget.
  const dupApp = await makeCase();
  for (let index = 0; index < 4; index += 1) await acceptAndFinish(dupApp, `Budget idea ${index}`);
  await expectRejection('AC6 duplicate fixture rejected', submit(dupApp, 'budget   IDEA 0'), 409, 'thought/duplicate');
  res = await acceptAndFinish(dupApp, 'Budget idea 4');
  check('AC6 duplicate did not consume budget (fifth submission accepted)', res.status === 200, `${res.status} ${res.json.error?.code}`);
  await expectRejection('AC6 sixth distinct submission then hits the minute budget', submit(dupApp, 'Budget idea 5'), 429, 'thought/rate-limit');

  // The hourly ceiling applies with the minute window kept small.
  const hourApp = await makeCase();
  let hourStatus = 200;
  for (let index = 0; index < 20; index += 1) {
    if (index > 0) hourApp.advance(MINUTE + 1000);
    const result = await acceptAndFinish(hourApp, `Hourly idea ${index}`);
    if (result.status !== 200) hourStatus = result.status;
  }
  check('AC6 twenty submissions across twenty minutes accepted', hourStatus === 200, String(hourStatus));
  const hourRejected = await expectRejection(
    'AC6 the twenty-first submission in an hour is 429',
    submit(hourApp, 'Hourly idea 20'),
    429,
    'thought/rate-limit',
  );
  check('AC6 429 message names the hourly window and a minute hint', /per hour/i.test(hourRejected.json?.error?.message ?? '') && /try again in \d+ minutes?/i.test(hourRejected.json?.error?.message ?? ''), hourRejected.json?.error?.message);
  check('AC6 hourly rejection creates no session', hourApp.createCalls.length === 20, String(hourApp.createCalls.length));
  check('AC6 the persisted budget log stays bounded to the last hour', (await rawStore(hourApp.thoughtFile)).rateLog.length === 20, String((await rawStore(hourApp.thoughtFile)).rateLog.length));
}

// ===========================================================================
// AC 7 — check order precedence and no rejection path leaks a write
// ===========================================================================
{
  console.log('\n# AC 7 — documented check order');
  {
    const app = await makeCase();
    await expectRejection('AC7 bad-request precedes empty', submit(app, 42), 400, 'bad-request');
    await expectRejection('AC7 empty precedes too-long', submit(app, ' \n\t '), 400, 'thought/empty');
    const tooLong = 'x'.repeat(4001);
    await expectRejection('AC7 too-long precedes duplicate (first)', submit(app, tooLong), 400, 'thought/too-long');
    await expectRejection('AC7 too-long precedes duplicate (second)', submit(app, tooLong), 400, 'thought/too-long');
    check('AC7 validation rejections wrote nothing', (await readdir(join(app.dir, 'thoughts')).catch(() => [])).length === 0);
  }
  {
    // duplicate before rate limit
    const app = await makeCase();
    for (let index = 0; index < 5; index += 1) await acceptAndFinish(app, `Order idea ${index}`);
    const duplicate = await expectRejection('AC7 duplicate precedes the rate budget', submit(app, 'ORDER   idea 0'), 409, 'thought/duplicate');
    check('AC7 duplicate wins even with the minute budget exhausted', duplicate.json?.error?.code === 'thought/duplicate');
    await expectRejection('AC7 and the next distinct submission is rate limited', submit(app, 'Order idea 9'), 429, 'thought/rate-limit');
  }
  {
    // rate limit before paused/queue
    const app = await makeCase();
    for (let index = 0; index < 5; index += 1) await acceptAndFinish(app, `Paused order idea ${index}`);
    await app.action('pauseBoard', {});
    await expectRejection('AC7 rate limit precedes paused queueing', submit(app, 'Paused after budget'), 429, 'thought/rate-limit');
    check('AC7 the paused board created no queued row', (await app.state()).value.thoughts.filter((thought) => thought.status === 'queued').length === 0);
  }
  {
    // paused/queue before the working cap, and no write on thought/limit
    const app = await makeCase();
    for (let index = 0; index < 3; index += 1) {
      const res = await submit(app, `Working idea ${index}`);
      check(`AC7 working fixture ${index} accepted`, res.status === 200, `${res.status}`);
    }
    await app.action('pauseBoard', {});
    let res = await submit(app, 'Queued while three are working');
    check('AC7 paused queueing precedes the 3-working cap', res.status === 200 && res.json.value.thought.status === 'queued', `${res.status} ${res.json.value?.thought?.status} ${res.json.error?.code}`);
    await app.action('resumeBoard', {});
    const storeBefore = await rawText(app.thoughtFile);
    const createsBefore = app.createCalls.length;
    await expectRejection('AC7 thought/limit is the last rejection', submit(app, 'One more working thought'), 409, 'thought/limit');
    check('AC7 thought/limit leaked no write', (await rawText(app.thoughtFile)) === storeBefore && app.createCalls.length === createsBefore);
    check('AC7 thought/limit did not consume budget', (await rawStore(app.thoughtFile)).rateLog.length === 4, String((await rawStore(app.thoughtFile)).rateLog.length));
  }
}

// ===========================================================================
// AC 8 — persisted intake audit: submitted -> dispatched -> ticket-linked/failed
// ===========================================================================
{
  console.log('\n# AC 8 — additive, persisted intake audit');
  const app = await makeCase();
  const res = await submit(app, 'Audit trail thought');
  const thought = res.json.value.thought;
  check('AC8 fixture thought accepted', res.status === 200 && thought.intakeAudit[0].type === 'submitted', brief(thought.intakeAudit));
  const epic = await app.callTool({ action: 'create', title: 'Audit epic', type: 'epic' }, thought.sessionId);
  await app.callTool({ action: 'create', title: 'Audit child one', parentId: epic.ticket.id }, thought.sessionId);
  await app.callTool({ action: 'create', title: 'Audit child two', parentId: epic.ticket.id }, thought.sessionId);
  app.finish(thought.sessionId);
  let snap = (await app.state()).value;
  let row = snap.thoughts.find((candidate) => candidate.id === thought.id);
  check('AC8 audit records submitted, dispatched and one ticket-linked per ticket', isDeepEqual(row.intakeAudit.map((entry) => entry.type), ['submitted', 'dispatched', 'ticket-linked', 'ticket-linked', 'ticket-linked']), brief(row.intakeAudit));
  check('AC8 submitted is attributed to the human', row.intakeAudit[0].actor === 'human' && Number.isFinite(row.intakeAudit[0].at), brief(row.intakeAudit[0]));
  check('AC8 dispatched is attributed to the pm session and carries sessionId', row.intakeAudit[1].actor === 'pm-session' && row.intakeAudit[1].sessionId === thought.sessionId, brief(row.intakeAudit[1]));
  check('AC8 ticket-linked events are attributed to the pm session', row.intakeAudit.slice(2).every((entry) => entry.actor === 'pm-session' && Number.isFinite(entry.at)));
  const stored = await rawStore(app.thoughtFile);
  check('AC8 the audit is persisted in the thought store', isDeepEqual(stored.thoughts[0].intakeAudit, row.intakeAudit), brief(stored.thoughts[0].intakeAudit));
  const restarted = makeHarness(app.dir);
  const restartedRow = (await restarted.state()).value.thoughts.find((candidate) => candidate.id === thought.id);
  check('AC8 the audit survives a restart', isDeepEqual(restartedRow.intakeAudit, row.intakeAudit));
  check('AC8 no board schema bump for the audit', snap.board.version === 3 && !('thoughts' in snap.board), `board.version=${snap.board.version}`);

  // Failure events.
  const failedDir = await freshDir();
  cleanup.push(failedDir);
  const failedApp = makeHarness(failedDir);
  failedApp.flags.failCreate = true;
  const failed = await submit(failedApp, 'Audit failure thought');
  failedApp.flags.failCreate = false;
  check('AC8 a failed dispatch records submitted + failed', isDeepEqual(failed.json.value.thought.intakeAudit.map((entry) => entry.type), ['submitted', 'failed']), brief(failed.json.value.thought.intakeAudit));
  check('AC8 failed is attributed to the system', failed.json.value.thought.intakeAudit[1].actor === 'system');

  // Old rows read as an empty list and are not rewritten.
  const legacyDir = await freshDir();
  cleanup.push(legacyDir);
  await seedStore(legacyDir, [seededThought({ id: 'TH-1', text: 'Legacy thought' })], 2);
  const legacyFile = join(legacyDir, 'thoughts', 'workspace-1.json');
  const legacyBefore = await rawText(legacyFile);
  const legacy = makeHarness(legacyDir);
  const legacyRow = (await legacy.state()).value.thoughts[0];
  check('AC8 old rows without an intake audit read as an empty list', Array.isArray(legacyRow.intakeAudit) && legacyRow.intakeAudit.length === 0, brief(legacyRow.intakeAudit));
  check('AC8 reading an old store rewrites nothing', (await rawText(legacyFile)) === legacyBefore);
  check('AC8 the legacy row has no injected audit/intake keys in the store', !('intakeAudit' in (await rawStore(legacyFile)).thoughts[0]));

  // A paused capture records submitted at capture and dispatched when it drains.
  const queueDir = await freshDir();
  cleanup.push(queueDir);
  const queueApp = makeHarness(queueDir);
  await queueApp.action('pauseBoard', {});
  const queued = await submit(queueApp, 'Queued audit thought');
  check('AC8 a queued capture records submitted but not dispatched', isDeepEqual(queued.json.value.thought.intakeAudit.map((entry) => entry.type), ['submitted']), brief(queued.json.value.thought.intakeAudit));
  await queueApp.action('resumeBoard', {});
  const drained = (await queueApp.state()).value.thoughts.find((candidate) => candidate.id === queued.json.value.thought.id);
  check('AC8 draining the queue records dispatched with the session id', isDeepEqual(drained.intakeAudit.map((entry) => entry.type), ['submitted', 'dispatched']) && drained.intakeAudit[1].sessionId === drained.sessionId, brief(drained.intakeAudit));

  // Bounded exposure.
  const boundDir = await freshDir();
  cleanup.push(boundDir);
  const manyEvents = Array.from({ length: 60 }, (_, index) => ({
    at: START_AT + index,
    type: index % 4 === 0 ? 'submitted' : 'ticket-linked',
    actor: index % 4 === 0 ? 'human' : 'pm-session',
    ...(index % 4 === 0 ? {} : { ticketId: `KB-${index}` }),
  }));
  await seedStore(boundDir, [seededThought({ id: 'TH-1', text: 'Bounded audit', intakeAudit: manyEvents })], 2);
  const bounded = makeHarness(boundDir);
  const boundedRow = (await bounded.state()).value.thoughts[0];
  check('AC8 the snapshot exposes at most 50 intake events', boundedRow.intakeAudit.length === 50, String(boundedRow.intakeAudit.length));
  check('AC8 the exposed window is the newest events', boundedRow.intakeAudit[0].at === START_AT + 10 && boundedRow.intakeAudit[49].at === START_AT + 59);
  check('AC8 every exposed event is serialized small', boundedRow.intakeAudit.every((entry) => JSON.stringify(entry).length <= 260), String(Math.max(...boundedRow.intakeAudit.map((entry) => JSON.stringify(entry).length))));
}

// ===========================================================================
// AC 9 — audit integrity and snapshot query
// ===========================================================================
{
  console.log('\n# AC 9 — audit integrity and query');
  const app = await makeCase();
  const res = await submit(app, 'Audit query thought');
  const thought = res.json.value.thought;
  const epic = await app.callTool({ action: 'create', title: 'Query epic', type: 'epic' }, thought.sessionId);
  const child = await app.callTool({ action: 'create', title: 'Query child', parentId: epic.ticket.id }, thought.sessionId);
  app.finish(thought.sessionId);
  const snap = (await app.state()).value;
  const row = snap.thoughts.find((candidate) => candidate.id === thought.id);
  const links = row.intakeAudit.filter((entry) => entry.type === 'ticket-linked');
  check('AC9 one ticket-linked event per created ticket', links.length === 2 && row.ticketIds.length === 2, `${links.length}/${row.ticketIds.length}`);
  const linkIds = links.map((entry) => entry.ticketId);
  check('AC9 no ticket appears twice in the intake audit', new Set(linkIds).size === linkIds.length, brief(linkIds));
  check('AC9 the ticket-linked union matches thought.ticketIds', isDeepEqual([...linkIds].sort(), [...row.ticketIds].sort()), brief({ linkIds, ticketIds: row.ticketIds }));
  check('AC9 linked events carry the created ids', linkIds.includes(epic.ticket.id) && linkIds.includes(child.ticket.id), brief(linkIds));
  check('AC9 every event is timestamped and actor-attributed', row.intakeAudit.every((entry) => Number.isFinite(entry.at) && ['human', 'pm-session', 'system'].includes(entry.actor)), brief(row.intakeAudit));
  check('AC9 timestamps are non-decreasing (append-only order)', row.intakeAudit.every((entry, index) => index === 0 || entry.at >= row.intakeAudit[index - 1].at));
  const stored = (await rawStore(app.thoughtFile)).thoughts.find((candidate) => candidate.id === thought.id);
  check('AC9 the snapshot query matches the persisted store', isDeepEqual(
    row.intakeAudit.filter((entry) => entry.type === 'ticket-linked').map((entry) => entry.ticketId),
    (stored.intakeAudit ?? []).filter((entry) => entry.type === 'ticket-linked').map((entry) => entry.ticketId),
  ));
  const beforeCancel = JSON.parse(JSON.stringify(row.intakeAudit));
  await app.action('cancelThought', { thoughtId: thought.id });
  const afterCancel = (await app.state()).value.thoughts.find((candidate) => candidate.id === thought.id);
  check('AC9 unrelated lifecycle actions never rewrite the intake audit', isDeepEqual(afterCancel.intakeAudit, beforeCancel), brief(afterCancel.intakeAudit));
  check('AC9 linked tickets keep thoughtId on the board', child.ticket.thoughtId === thought.id && child.ticket.parentId === epic.ticket.id);
}

// ===========================================================================
// AC 10 — adversarial guardrail matrix: every mutating action is rejected
// ===========================================================================
{
  console.log('\n# AC 10 — adversarial guardrail matrix');
  const app = await makeCase();
  const res = await submit(app, 'Guardrail hardening thought');
  const thought = res.json.value.thought;
  const sessionId = thought.sessionId;
  // Settle the board agent entry (the first tool call may adopt the roster link).
  await app.callTool({ action: 'whoami' }, sessionId);
  const baseline = (await app.state()).value;
  const storeBefore = await rawText(app.thoughtFile);
  const mutating = [
    { action: 'move', ticketId: 'KB-1', column: 'ready' },
    { action: 'update', ticketId: 'KB-1', title: 'nope' },
    { action: 'comment', ticketId: 'KB-1', text: 'nope' },
    { action: 'claim', ticketId: 'KB-1' },
    { action: 'release', ticketId: 'KB-1' },
    { action: 'block', ticketId: 'KB-1', text: 'nope' },
    { action: 'unblock', ticketId: 'KB-1' },
    { action: 'finish', ticketId: 'KB-1', summary: 'nope' },
    { action: 'run', ticketId: 'KB-1' },
    { action: 'assign', ticketId: 'KB-1', sessionId: 'session-normal' },
    { action: 'pause' },
    { action: 'resume' },
    { action: 'scan' },
    { action: 'cancel_execution', ticketId: 'KB-1' },
    { action: 'retryThought', thoughtId: 'TH-1' },
    { action: 'cancelThought', thoughtId: 'TH-1' },
    { action: 'editThought', thoughtId: 'TH-1', text: 'nope' },
    { action: 'deleteThought', thoughtId: 'TH-1' },
    { action: 'create_member', name: 'Probe Person', role: 'tester' },
    { action: 'set_role', sessionId: 'session-normal', role: 'tester' },
  ];
  for (const args of mutating) {
    let code = '';
    try {
      await app.callTool(args, sessionId);
    } catch (error) {
      code = error instanceof Error ? error.message : String(error);
    }
    check(`AC10 thought session rejects ${args.action} with thought-read-only`, code.includes('kanban/thought-read-only'), code.slice(0, 90));
  }
  const after = (await app.state()).value;
  const boardNoTimestamp = (board) => {
    const { updatedAt: _updatedAt, ...rest } = board ?? {};
    return rest;
  };
  // `store.save` stamps board.updatedAt on every tool call (pre-existing write
  // bookkeeping), so the semantic deep-equal excludes that single field.
  check('AC10 the board stays deep-equal (no ticket/activity/agent change)', isDeepEqual(boardNoTimestamp(after.board), boardNoTimestamp(baseline.board)), brief({ tickets: after.board?.tickets?.length }));
  check('AC10 tickets, activity and agents are unchanged', isDeepEqual(after.board.tickets, baseline.board.tickets) && isDeepEqual(after.board.activity, baseline.board.activity) && isDeepEqual(after.board.agents, baseline.board.agents));
  check('AC10 the thought rows stay deep-equal', isDeepEqual(after.thoughts, baseline.thoughts));
  check('AC10 the roster stays deep-equal', isDeepEqual(after.roster, baseline.roster));
  check('AC10 the thought store file is byte-identical', (await rawText(app.thoughtFile)) === storeBefore);

  // Read actions and `create` keep working from the same session.
  let readOk = true;
  for (const action of ['whoami', 'projects', 'board', 'list', 'next', 'team', 'members']) {
    try {
      await app.callTool({ action }, sessionId);
    } catch {
      readOk = false;
    }
  }
  check('AC10 every read action still works from the thought session', readOk);
}

// ===========================================================================
// AC 11 — create forcing + no cross-thought linkage
// ===========================================================================
{
  console.log('\n# AC 11 — create forcing and linkage confinement');
  const app = await makeCase();
  const first = (await submit(app, 'Linkage thought one')).json.value.thought;
  for (const column of ['ready', 'in_progress', 'review', 'done']) {
    const created = await app.callTool({ action: 'create', title: `Forced ${column}`, column }, first.sessionId);
    check(`AC11 thought create with column:${column} lands in Backlog`, created.ticket.column === 'backlog', created.ticket.column);
    check(`AC11 forced create is stamped with the caller thought`, created.ticket.thoughtId === first.id, created.ticket.thoughtId);
  }
  const forged = await app.callTool({ action: 'create', title: 'Forged linkage', thoughtId: 'TH-99' }, first.sessionId);
  check('AC11 a forged thoughtId is overridden by the server stamp', forged.ticket.thoughtId === first.id, forged.ticket.thoughtId);
  const epic = await app.callTool({ action: 'create', title: 'Own epic', type: 'epic' }, first.sessionId);
  const child = await app.callTool({ action: 'create', title: 'Own child', parentId: epic.ticket.id }, first.sessionId);
  check('AC11 a child of the caller thought EPIC is accepted', child.ticket.parentId === epic.ticket.id && child.ticket.thoughtId === first.id, brief({ parentId: child.ticket.parentId }));
  let code = '';
  try {
    await app.callTool({ action: 'create', title: 'Bad parent', parentId: forged.ticket.id }, first.sessionId);
  } catch (error) {
    code = error instanceof Error ? error.message : String(error);
  }
  check('AC11 a non-EPIC parent is rejected by KB-3/KB-4 rules', code.includes('kanban/ticket/parent-invalid'), code.slice(0, 90));

  // A second thought owns its own EPIC; the first thought may not link into it.
  const second = (await submit(app, 'Linkage thought two')).json.value.thought;
  const foreignEpic = await app.callTool({ action: 'create', title: 'Foreign epic', type: 'epic' }, second.sessionId);
  const ticketsBefore = (await app.state()).value.board.tickets.length;
  code = '';
  try {
    await app.callTool({ action: 'create', title: 'Cross-thought child', parentId: foreignEpic.ticket.id }, first.sessionId);
  } catch (error) {
    code = error instanceof Error ? error.message : String(error);
  }
  check('AC11 linking into another thought EPIC is rejected', code.includes('kanban/ticket/parent-invalid'), code.slice(0, 90));
  check('AC11 the cross-thought rejection creates no ticket', (await app.state()).value.board.tickets.length === ticketsBefore);
  check('AC11 the foreign EPIC keeps its own thoughtId', foreignEpic.ticket.thoughtId === second.id);

  // A normal PM session cannot smuggle a thoughtId either.
  await app.action('setAgentRole', { sessionId: 'session-normal', role: 'product-manager' });
  const normal = await app.callTool({ action: 'create', title: 'Normal create', thoughtId: 'TH-1' }, 'session-normal');
  check('AC11 a normal session create ignores a forged thoughtId', normal.ticket.thoughtId === undefined || normal.ticket.thoughtId === null, String(normal.ticket.thoughtId));
}

// ===========================================================================
// AC 12 — determinism: no wall-clock sleeps, no temp files, bounded snapshot
// ===========================================================================
{
  console.log('\n# AC 12 — deterministic suite side conditions');
  const app = await makeCase();
  await submit(app, 'Determinism thought');
  const stored = await rawStore(app.thoughtFile);
  check('AC12 the thought store envelope is still version 1', stored.version === 1);
  check('AC12 the board is still v3 with no board.thoughts', (await app.state()).value.board.version === 3 && !('thoughts' in (await app.state()).value.board));
  check('AC12 rateLog only appears once a submission is accepted', Array.isArray(stored.rateLog) && stored.rateLog.length === 1, brief(stored.rateLog));
  check('AC12 no temp files in the thoughts directory', (await readdir(join(app.dir, 'thoughts'))).every((name) => !name.includes('.tmp-')));
}

console.log('\n' + (failures.length === 0 ? 'ALL THOUGHT HARDENING CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
await rm(rootA, { recursive: true, force: true });
await rm(rootB, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
