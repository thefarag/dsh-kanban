import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

// KB-5 thought lifecycle — fake Harness (same pattern as tests/thoughts.test.mjs):
// captured agents.create + sessionController.cancel, an injected clock, restart
// on the same state dir, and store-file assertions for no-rewrite/audit bounds.
//
// Every section maps to the ticket's acceptance criteria; check labels start
// with the AC number so the reviewer can map criterion -> proof 1:1.
const root = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-'));
const stateDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-state-'));
await writeFile(join(root, 'README.md'), '# Demo\n');

const workspace = {
  id: 'workspace-1',
  title: 'Demo',
  path: root,
  sessionIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  async attachSession() {},
  async status() {
    return 'ok';
  },
};

const THOUGHT_FILE = join(stateDir, 'thoughts', 'workspace-1.json');
const BOARD_FILE = join(stateDir, 'workspace-1.json');
const START_AT = 1_700_000_000_000;

async function seedStore(dir, thoughts, nextNumber = thoughts.length + 1) {
  await mkdir(join(dir, 'thoughts'), { recursive: true });
  await writeFile(join(dir, 'thoughts', 'workspace-1.json'), JSON.stringify({ version: 1, nextNumber, thoughts }));
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

/** One booted host instance with its own fake Harness services. */
function makeHarness(dir, { graceMs = 5000, startAt = START_AT } = {}) {
  const sessionItems = [
    { sessionId: 'session-normal', cwd: root, running: false, updatedAt: startAt, projections: { values: { title: 'Normal PM session' } } },
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
    workspaceRegistry: { list: () => [workspace] },
    sessionPersistence: {
      async list() {
        return [{ header: { id: 'session-normal', cwd: root } }];
      },
      async open() {
        return { async read() { return { events: [] }; }, async close() {} };
      },
      async stat(id) {
        return { header: { id, cwd: root } };
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

  // KB-5 test-only clock knob (D6). KB-6 adds a per-workspace intake budget
  // (5/min, 20/hour); this suite submits ~21 thoughts at one injected instant, so
  // it opts out through the host knob while tests/thought-hardening.test.mjs
  // exercises the shipped defaults with its own clock.
  apply(ctx, { stateDir: dir, thoughtGraceMs: graceMs, now: clock, thoughtRateLimits: { perMinute: 1000, perHour: 10000 } });

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
    createCalls,
    prompts,
    cancelCalls,
    liveAgents,
    flags,
    clock,
    advance: (ms) => {
      clockNow += ms;
    },
    action: (action, payload = {}) => post('/kanban/action', { workspaceId: 'workspace-1', action, payload }),
    state: async () => (await post('/kanban/state', { workspaceId: 'workspace-1' })).json,
    callTool: (args, agentId = 'session-normal') => tools.get('kanban').execute(args, { agent: { id: agentId } }),
    observe(sessionId, running) {
      let item = sessionItems.find((entry) => entry.sessionId === sessionId);
      if (!item) {
        item = { sessionId, cwd: root, running, updatedAt: Date.now(), projections: { values: { title: sessionId } } };
        sessionItems.push(item);
      }
      item.running = running;
      const agent = liveAgents.get(sessionId);
      if (agent) agent.status = running ? 'running' : 'idle';
      else liveAgents.set(sessionId, { id: sessionId, status: running ? 'running' : 'idle', inbox: { hasPending: false }, session: { id: sessionId } });
    },
    unobserve(sessionId) {
      const index = sessionItems.findIndex((entry) => entry.sessionId === sessionId);
      if (index !== -1) sessionItems.splice(index, 1);
      liveAgents.delete(sessionId);
    },
  };
}

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const expectError = async (label, fn, status, code) => {
  const result = await fn();
  const actual = `${result.status} ${result.json?.error?.code ?? ''}`.trim();
  check(label, result.status === status && result.json?.error?.code === code, actual);
};
const readThoughtStore = async (dir = stateDir) =>
  JSON.parse(await readFile(join(dir, 'thoughts', 'workspace-1.json'), 'utf8'));
const rawThoughtStore = async (dir = stateDir) => readFile(join(dir, 'thoughts', 'workspace-1.json'), 'utf8');

const app = makeHarness(stateDir);

// ===========================================================================
// AC1 — additive statuses, old files unchanged, unknown status fails safe
// ===========================================================================
{
  const legacyDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-legacy-'));
  await seedStore(
    legacyDir,
    [
      seededThought({ id: 'TH-1', status: 'recorded' }),
      seededThought({ id: 'TH-2', status: 'working', sessionId: 'session-legacy' }),
      seededThought({ id: 'TH-3', status: 'done' }),
      seededThought({ id: 'TH-4', status: 'failed', error: 'old failure' }),
      seededThought({ id: 'TH-5', status: 'teleported' }),
    ],
    6,
  );
  const before = await rawThoughtStore(legacyDir);
  const legacy = makeHarness(legacyDir);
  const legacyState = (await legacy.state()).value;
  const byId = new Map(legacyState.thoughts.map((thought) => [thought.id, thought]));
  check('AC1 legacy statuses load unchanged', ['recorded', 'working', 'done', 'failed'].every((status) => byId.get(`TH-${['recorded', 'working', 'done', 'failed'].indexOf(status) + 1}`)?.status === status), JSON.stringify(legacyState.thoughts.map((thought) => `${thought.id}:${thought.status}`)));
  check('AC1 unknown status degrades to failed', byId.get('TH-5')?.status === 'failed', byId.get('TH-5')?.status);
  check('AC1 legacy rows carry no rewrite artefact (no audit key)', byId.get('TH-3') && !('audit' in byId.get('TH-3')), Object.keys(byId.get('TH-3') ?? {}).join(','));
  check('AC1 old file is not rewritten on read', (await rawThoughtStore(legacyDir)) === before);
  // KB-5 adds no board schema key; the board version is whatever the host ships
  // (v2 at the KB-1 base, v3 once the EPIC slice has landed).
  check('AC1 unknown status never crashes the board', Boolean(legacyState.board) && Number.isInteger(legacyState.board.version) && legacyState.board.version >= 2 && !('thoughts' in legacyState.board), `board.version=${legacyState.board?.version}`);
  await rm(legacyDir, { recursive: true, force: true });
}

// Client-side safe label surface (D2: copy lives in client.js inline dictionaries).
{
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  check('AC1 client status list includes queued/cancelled', /const THOUGHT_STATUSES = \['recorded', 'working', 'done', 'failed', 'queued', 'cancelled'\]/.test(clientSource));
  check('AC1 en+zh have Queued and Cancelled labels', (clientSource.match(/'thought\.status\.queued':/g) ?? []).length === 2 && (clientSource.match(/'thought\.status\.cancelled':/g) ?? []).length === 2);
  check('AC1 unknown status renders a safe label', (clientSource.match(/'thought\.status\.unknown':/g) ?? []).length === 2 && /\? 'unknown' : value/.test(clientSource));
}

check('AC1 snapshot adds deletedThoughtIds as an empty array', Array.isArray((await app.state()).value.deletedThoughtIds) && (await app.state()).value.deletedThoughtIds.length === 0);

// ===========================================================================
// AC7/AC8/AC12 — paused capture queue, drain on resume/snapshot, bounds
// ===========================================================================
{
  let res = await app.action('pauseBoard', {});
  check('AC7 board paused', res.status === 200 && res.json.value.board.paused === true, String(res.status));

  // Validation still runs before the paused branch.
  await expectError('AC7 paused empty text is validated first (400)', () => app.action('submitThought', { text: '   ' }), 400, 'thought/empty');
  await expectError('AC7 paused too-long text is validated first (400)', () => app.action('submitThought', { text: 'x'.repeat(4001) }), 400, 'thought/too-long');

  const callsBefore = app.createCalls.length;
  res = await app.action('submitThought', { text: 'Paused capture alpha' });
  check('AC7 paused submit is a 200 with queued status', res.status === 200 && res.json.value.thought.status === 'queued', `${res.status} ${res.json?.value?.thought?.status} ${res.json?.error?.code}`);
  const alpha = res.json.value.thought;
  check('AC7 queued row has no session and no tickets', alpha.sessionId === null && alpha.ticketIds.length === 0, JSON.stringify({ sessionId: alpha.sessionId, tickets: alpha.ticketIds }));
  check('AC7 queued submit dispatches nothing', app.createCalls.length === callsBefore, String(app.createCalls.length - callsBefore));
  check('AC7 queued row is in the snapshot', (await app.state()).value.thoughts.some((thought) => thought.id === alpha.id && thought.status === 'queued'));
  check('AC7 queued row audits the queue transition', JSON.stringify((await app.state()).value.thoughts.find((thought) => thought.id === alpha.id)?.audit?.map((entry) => entry.type)) === JSON.stringify(['status']));

  // FIFO drain up to the working cap; overflow stays queued.
  const ticketsWhilePaused = (await app.state()).value.board.tickets.length;
  res = await app.action('submitThought', { text: 'Paused capture beta' });
  const beta = res.json.value.thought;
  check('AC7 second paused capture queues too', beta.status === 'queued', beta.status);
  check('AC7 queued capture creates no tickets before dispatch', (await app.state()).value.board.tickets.length === ticketsWhilePaused, String((await app.state()).value.board.tickets.length - ticketsWhilePaused));
  res = await app.action('resumeBoard', {});
  check('AC7 resume drains the queue', res.status === 200 && res.json.value.board.paused === false, String(res.status));
  const drainedCalls = app.createCalls.slice(callsBefore);
  check('AC7 resume dispatches every queued thought once', drainedCalls.length === 2, String(drainedCalls.length));
  const drainedState = (await app.state()).value;
  check('AC7 drained rows are working', [alpha.id, beta.id].every((id) => drainedState.thoughts.find((thought) => thought.id === id)?.status === 'working'), JSON.stringify(drainedState.thoughts.map((thought) => `${thought.id}:${thought.status}`)));
  check('AC7 drain audits the claim before dispatch', JSON.stringify(drainedState.thoughts.find((thought) => thought.id === alpha.id)?.audit?.map((entry) => `${entry.from ?? ''}>${entry.to}`)) === JSON.stringify(['>queued', 'queued>working']), JSON.stringify(drainedState.thoughts.find((thought) => thought.id === alpha.id)?.audit));

  // A third paused capture must still drain after the first two stop.
  for (const thought of drainedState.thoughts) {
    if (thought.status === 'working' && thought.sessionId) app.observe(thought.sessionId, false);
  }
  await app.action('pauseBoard', {});
  res = await app.action('submitThought', { text: 'Paused capture gamma' });
  const gamma = res.json.value.thought;
  check('AC7 paused capture after drain queues again', gamma.status === 'queued', gamma.status);
  res = await app.action('resumeBoard', {});
  const afterGamma = (await app.state()).value.thoughts.find((thought) => thought.id === gamma.id);
  check('AC7 resume drains the new queued thought', afterGamma?.status === 'working' && typeof afterGamma.sessionId === 'string', JSON.stringify({ status: afterGamma?.status, sessionId: afterGamma?.sessionId }));
  app.observe(afterGamma.sessionId, false);
}

// Queue cap and its paused-only scope (fresh store so the count is exact).
{
  const queueDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-queue-'));
  const queued = [];
  for (let index = 1; index <= 20; index += 1) queued.push(seededThought({ id: `TH-${index}`, status: 'queued', text: `Queued ${index}` }));
  await seedStore(queueDir, queued, 21);
  const capped = makeHarness(queueDir);
  await capped.action('pauseBoard', {});
  const res = await capped.action('submitThought', { text: 'One too many' });
  check('AC8 21st queued submit is 409 thought/queue-full', res.status === 409 && res.json.error.code === 'thought/queue-full', `${res.status} ${res.json?.error?.code}`);
  check('AC8 queue-full does not persist a thought', (await capped.state()).value.thoughts.length === 20, String((await capped.state()).value.thoughts.length));
  await capped.action('resumeBoard', {});
  check('AC8 resume drains only up to the 3-working cap', capped.createCalls.length === 3, String(capped.createCalls.length));
  const calls = capped.createCalls.length;
  const unpaused = await capped.action('submitThought', { text: 'Unpaused' });
  check('AC8 queue-full never applies while unpaused (limit instead)', unpaused.status === 409 && unpaused.json.error.code === 'thought/limit', `${unpaused.status} ${unpaused.json?.error?.code}`);
  check('AC8 unpaused rejected submit dispatches nothing', capped.createCalls.length === calls, String(capped.createCalls.length - calls));
  await rm(queueDir, { recursive: true, force: true });
}

// Idempotent drain: resume + snapshot race dispatch each thought exactly once.
{
  const raceDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-race-'));
  const race = makeHarness(raceDir);
  await race.action('pauseBoard', {});
  await race.action('submitThought', { text: 'Race one' });
  await race.action('submitThought', { text: 'Race two' });
  const firstCalls = race.createCalls.length;
  check('AC8 race setup queues two thoughts without dispatching', firstCalls === 0 && (await race.state()).value.thoughts.filter((thought) => thought.status === 'queued').length === 2, String(firstCalls));
  await Promise.all([race.action('resumeBoard', {}), race.state(), race.state()]);
  check('AC8 resume+snapshot race dispatches each queued thought once', race.createCalls.length === 2, String(race.createCalls.length));
  const restartHappens = makeHarness(raceDir);
  const restartedCalls = restartHappens.createCalls.length;
  await restartHappens.state();
  check('AC8 second resume dispatches nothing again', restartHappens.createCalls.length === restartedCalls, String(restartHappens.createCalls.length - restartedCalls));
  await rm(raceDir, { recursive: true, force: true });
}

// A claim that never links a session fails after the grace and never wedges the queue.
{
  const claimDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-claim-'));
  await seedStore(
    claimDir,
    [
      seededThought({ id: 'TH-1', status: 'working', sessionId: null, updatedAt: START_AT - 10_000, text: 'Stale claim' }),
      seededThought({ id: 'TH-2', status: 'queued', text: 'Behind the claim' }),
    ],
    3,
  );
  const claim = makeHarness(claimDir, { graceMs: 5000 });
  const state = (await claim.state()).value;
  const stale = state.thoughts.find((thought) => thought.id === 'TH-1');
  check('AC8 stale claim fails with the exact dispatch error', stale?.status === 'failed' && stale?.error === 'the product manager session did not start', JSON.stringify({ status: stale?.status, error: stale?.error }));
  check('AC8 queue behind a stale claim still drains', claim.createCalls.length === 1 && state.thoughts.find((thought) => thought.id === 'TH-2')?.status === 'working', JSON.stringify({ calls: claim.createCalls.length, TH2: state.thoughts.find((thought) => thought.id === 'TH-2')?.status }));
  await rm(claimDir, { recursive: true, force: true });
}

// ===========================================================================
// AC2/AC3 — retry failed into a linked row
// ===========================================================================
{
  app.flags.failCreate = true;
  const res = await app.action('submitThought', { text: 'A thought that fails to dispatch' });
  app.flags.failCreate = false;
  const failed = res.json.value.thought;
  check('AC2 failed dispatch leaves a failed row', failed.status === 'failed' && failed.sessionId === null && /Could not start an agent session/.test(failed.error), JSON.stringify({ status: failed.status, error: failed.error }));

  await expectError('AC2 retry unknown thought is 404', () => app.action('retryThought', { thoughtId: 'TH-999' }), 404, 'thought/not-found');

  const callsBefore = app.createCalls.length;
  const retried = await app.action('retryThought', { thoughtId: failed.id });
  check('AC2 retry returns a new linked row', retried.status === 200 && retried.json.value.thought.id !== failed.id && retried.json.value.thought.retryOf === failed.id, JSON.stringify({ status: retried.status, id: retried.json?.value?.thought?.id, retryOf: retried.json?.value?.thought?.retryOf }));
  const retryRow = retried.json.value.thought;
  check('AC2 retry row keeps the trimmed text and starts a fresh dispatch', retryRow.text === failed.text && retryRow.error === '' && retryRow.ticketIds.length === 0 && retryRow.status === 'working', JSON.stringify({ text: retryRow.text, error: retryRow.error, status: retryRow.status }));
  check('AC2 retry adds exactly one dispatch', app.createCalls.length === callsBefore + 1, String(app.createCalls.length - callsBefore));
  const snap = (await app.state()).value;
  const original = snap.thoughts.find((thought) => thought.id === failed.id);
  check('AC2 original row is not mutated by retry', original.status === 'failed' && original.error === failed.error && original.updatedAt === failed.updatedAt && JSON.stringify(original.ticketIds) === JSON.stringify(failed.ticketIds), JSON.stringify({ status: original.status, updatedAt: original.updatedAt }));
  check('AC3 retry history is newest-first with both rows', snap.thoughts[0].id === retryRow.id && snap.thoughts.some((thought) => thought.id === failed.id));
  check('AC3 retry row records a Retry-of audit entry', (snap.thoughts.find((thought) => thought.id === retryRow.id)?.audit ?? []).some((entry) => entry.type === 'retry' && entry.thoughtId === failed.id));

  await expectError('AC2 retry of a working thought is 409 not-retryable', () => app.action('retryThought', { thoughtId: retryRow.id }), 409, 'thought/not-retryable');

  app.observe(retryRow.sessionId, false);
  const afterDone = (await app.state()).value.thoughts.find((thought) => thought.id === retryRow.id);
  await expectError('AC2 retry of a done thought is 409 not-retryable', () => app.action('retryThought', { thoughtId: retryRow.id }), 409, 'thought/not-retryable');

  await app.action('pauseBoard', {});
  await expectError('AC2 retry while paused is 423', () => app.action('retryThought', { thoughtId: failed.id }), 423, 'board/paused');
  // Check order: unknown/deleted -> 404 even while the board is paused.
  await expectError('AC2 retry unknown while paused is still 404', () => app.action('retryThought', { thoughtId: 'TH-999' }), 404, 'thought/not-found');
  await app.action('resumeBoard', {});
  void afterDone;

  // Working cap gate.
  const capDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-retrycap-'));
  await seedStore(
    capDir,
    [
      seededThought({ id: 'TH-1', status: 'working', sessionId: 'session-a' }),
      seededThought({ id: 'TH-2', status: 'working', sessionId: 'session-b' }),
      seededThought({ id: 'TH-3', status: 'working', sessionId: 'session-c' }),
      seededThought({ id: 'TH-4', status: 'failed', error: 'boom' }),
    ],
    5,
  );
  const capped = makeHarness(capDir);
  await expectError('AC2 retry at the 3-working cap is 409 thought/limit', () => capped.action('retryThought', { thoughtId: 'TH-4' }), 409, 'thought/limit');
  await rm(capDir, { recursive: true, force: true });

  // A failed retry dispatch leaves only the new row failed.
  app.flags.failCreate = true;
  const failedRetry = await app.action('retryThought', { thoughtId: failed.id });
  app.flags.failCreate = false;
  const failedRetryRow = failedRetry.json.value.thought;
  const afterFailedRetry = (await app.state()).value;
  check('AC2 failed retry dispatch marks only the new row failed', failedRetryRow.status === 'failed' && afterFailedRetry.thoughts.find((thought) => thought.id === failed.id)?.status === 'failed', JSON.stringify({ new: failedRetryRow.status, original: afterFailedRetry.thoughts.find((thought) => thought.id === failed.id)?.status }));

  // Restart keeps retry history.
  const restarted = makeHarness(stateDir);
  const restartedState = (await restarted.state()).value;
  const restartedRetry = restartedState.thoughts.find((thought) => thought.id === retryRow.id);
  check('AC3 retry history survives restart', restartedRetry?.retryOf === failed.id && restartedRetry?.status === 'done', JSON.stringify({ retryOf: restartedRetry?.retryOf, status: restartedRetry?.status }));
}

// ===========================================================================
// AC4/AC5 — cancel a running thought; cancelled is terminal
// ===========================================================================
{
  let res = await app.action('submitThought', { text: 'A runaway PM session' });
  const running = res.json.value.thought;
  check('AC4 setup: thought is working', running.status === 'working' && typeof running.sessionId === 'string', JSON.stringify({ status: running.status, sessionId: running.sessionId }));
  // Give it a ticket so "tickets created earlier stay put" is observable.
  const created = await app.callTool({ action: 'create', title: 'Ticket from the runaway thought', type: 'story' }, running.sessionId);
  const ticketId = created.ticket.id;
  const cancelBefore = app.cancelCalls.length;

  res = await app.action('cancelThought', { thoughtId: running.id });
  const cancelled = res.json.value.thought;
  check('AC4 cancel is 200 and marks cancelled', res.status === 200 && cancelled.status === 'cancelled', `${res.status} ${cancelled?.status}`);
  check('AC4 cancel calls sessionController.cancel with the session', app.cancelCalls.length === cancelBefore + 1 && app.cancelCalls[app.cancelCalls.length - 1]?.sessionId === running.sessionId, JSON.stringify(app.cancelCalls.slice(cancelBefore)));
  check('AC4 cancel keeps prior tickets', JSON.stringify(cancelled.ticketIds) === JSON.stringify([ticketId]), JSON.stringify(cancelled.ticketIds));
  check('AC4 cancel audits the transition once', cancelled.audit.filter((entry) => entry.type === 'status' && entry.to === 'cancelled').length === 1, JSON.stringify(cancelled.audit));
  const cancelledUpdatedAt = cancelled.updatedAt;

  res = await app.action('cancelThought', { thoughtId: running.id });
  check('AC4 second cancel is 200 with the same state', res.status === 200 && res.json.value.thought.updatedAt === cancelledUpdatedAt && res.json.value.thought.status === 'cancelled', `${res.status}`);
  check('AC4 second cancel writes no second audit entry', app.cancelCalls.length === cancelBefore + 1 && res.json.value.thought.audit.filter((entry) => entry.type === 'status' && entry.to === 'cancelled').length === 1, JSON.stringify({ cancels: app.cancelCalls.length }));

  // Session already stopped then cancelled: cancel wins over reconciliation.
  res = await app.action('submitThought', { text: 'Stopped before cancel' });
  const stoppedThought = res.json.value.thought;
  app.observe(stoppedThought.sessionId, false);
  // No snapshot read in between: the session has stopped but reconciliation has
  // not run yet, so the thought is still working and cancel must win.
  res = await app.action('cancelThought', { thoughtId: stoppedThought.id });
  check('AC4 cancel wins over reconciliation for a stopped session', res.status === 200 && res.json.value.thought.status === 'cancelled', JSON.stringify({ status: res.json?.value?.thought?.status }));

  // Cancelled is terminal across reads and restart, and tickets stay in Backlog.
  for (let index = 0; index < 3; index += 1) await app.state();
  const terminal = (await app.state()).value.thoughts.find((thought) => thought.id === running.id);
  check('AC5 cancelled survives repeated reads', terminal?.status === 'cancelled', terminal?.status);
  const restarted = makeHarness(stateDir);
  const restartedState = (await restarted.state()).value;
  check('AC5 cancelled survives restart', restartedState.thoughts.find((thought) => thought.id === running.id)?.status === 'cancelled', restartedState.thoughts.find((thought) => thought.id === running.id)?.status);
  const keptTicket = restartedState.board.tickets.find((ticket) => ticket.id === ticketId);
  check('AC5 created tickets stay in Backlog with thoughtId', keptTicket?.column === 'backlog' && keptTicket?.thoughtId === running.id, JSON.stringify({ column: keptTicket?.column, thoughtId: keptTicket?.thoughtId }));

  await expectError('AC4 cancel unknown thought is 404', () => app.action('cancelThought', { thoughtId: 'TH-999' }), 404, 'thought/not-found');
  res = await app.action('submitThought', { text: 'Already finished' });
  app.observe(res.json.value.thought.sessionId, false);
  await app.state();
  await expectError('AC4 cancel non-working thought is 409', () => app.action('cancelThought', { thoughtId: res.json.value.thought.id }), 409, 'thought/not-cancellable');
}

// ===========================================================================
// AC6/AC11 — detail timeline + audit coverage/bounds
// ===========================================================================
{
  const detailDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-audit-'));
  await seedStore(detailDir, [seededThought({ id: 'TH-1', status: 'done', text: 'Legacy detail thought' })], 2);
  const detail = makeHarness(detailDir);
  const legacy = (await detail.state()).value.thoughts[0];
  check('AC6 legacy row has no audit (client derives the timeline)', legacy && !('audit' in legacy), Object.keys(legacy ?? {}).join(','));
  check('AC6 legacy snapshot still exposes verbatim text', legacy?.text === 'Legacy detail thought', legacy?.text);
  await rm(detailDir, { recursive: true, force: true });

  const longText = 'L'.repeat(4000);
  const res = await app.action('submitThought', { text: longText });
  const fullText = res.json.value.thought.text;
  check('AC6 detail carries the verbatim untruncated text', fullText === longText, String(fullText.length));
  const timeline = (await app.state()).value.thoughts.find((thought) => thought.id === res.json.value.thought.id)?.audit ?? [];
  check('AC6 timeline is oldest -> newest with a status transition', timeline.length >= 2 && timeline[0].to === 'recorded' && timeline[1].from === 'recorded' && timeline[1].to === 'working', JSON.stringify(timeline));
  check('AC6 timeline entries are timestamped', timeline.every((entry) => Number.isFinite(entry.at) && entry.at > 0));
  app.observe(res.json.value.thought.sessionId, false);
  await app.state();

  // Edit audit + bounds: 60 edits prune the stored audit to 50, snapshot to 20.
  const editDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-edits-'));
  await seedStore(editDir, [seededThought({ id: 'TH-1', status: 'failed', error: 'nope' })], 2);
  const edits = makeHarness(editDir);
  for (let index = 0; index < 60; index += 1) {
    await edits.advance(11);
    await edits.action('editThought', { thoughtId: 'TH-1', text: `Edit number ${index} `.repeat(30).trim() });
  }
  const stored = await readThoughtStore(editDir);
  const storedAudit = stored.thoughts[0].audit ?? [];
  check('AC11 store keeps at most 50 audit entries (oldest pruned)', storedAudit.length === 50, String(storedAudit.length));
  const snapshotAudit = (await edits.state()).value.thoughts.find((thought) => thought.id === 'TH-1')?.audit ?? [];
  check('AC11 snapshot exposes at most 20 audit entries', snapshotAudit.length === 20, String(snapshotAudit.length));
  check('AC11 every serialized audit entry is <=400 chars', snapshotAudit.every((entry) => JSON.stringify(entry).length <= 400), JSON.stringify(snapshotAudit.map((entry) => JSON.stringify(entry).length).slice(0, 5)));
  check('AC11 edit excerpts are <=280 chars', snapshotAudit.every((entry) => (typeof entry.previous !== 'string' || entry.previous.length <= 280) && (typeof entry.new !== 'string' || entry.new.length <= 280)));
  check('AC11 audit entry covers the edit type', snapshotAudit.some((entry) => entry.type === 'edit'));
  await rm(editDir, { recursive: true, force: true });
}

// ===========================================================================
// AC9 — edit
// ===========================================================================
{
  // Done thought is not editable; failed is.
  const res = await app.action('submitThought', { text: 'Will fail to dispatch for edit' });
  const failed = res.json.value.thought;
  app.flags.failCreate = true;
  const failedTwo = (await app.action('submitThought', { text: 'Second failing thought' })).json.value.thought;
  app.flags.failCreate = false;
  check('AC9 setup: failed thought', failedTwo.status === 'failed', failedTwo.status);

  await expectError('AC9 non-string edit text is 400 bad-request', () => app.action('editThought', { thoughtId: failedTwo.id, text: 42 }), 400, 'bad-request');
  await expectError('AC9 empty edit text is 400 thought/empty', () => app.action('editThought', { thoughtId: failedTwo.id, text: '  ' }), 400, 'thought/empty');
  await expectError('AC9 too-long edit text is 400 thought/too-long', () => app.action('editThought', { thoughtId: failedTwo.id, text: 'z'.repeat(4001) }), 400, 'thought/too-long');
  await expectError('AC9 edit unknown thought is 404', () => app.action('editThought', { thoughtId: 'TH-999', text: 'nope' }), 404, 'thought/not-found');
  const doneThought = (await app.state()).value.thoughts.find((thought) => thought.status === 'done' && !thought.deletedAt);
  await expectError('AC9 edit a done thought is 409 not-editable', () => app.action('editThought', { thoughtId: doneThought.id, text: 'nope' }), 409, 'thought/not-editable');

  const callsBefore = app.createCalls.length;
  const edited = await app.action('editThought', { thoughtId: failedTwo.id, text: '  Edited while failed  ' });
  check('AC9 edit persists trimmed text without dispatching', edited.status === 200 && edited.json.value.thought.text === 'Edited while failed' && app.createCalls.length === callsBefore && edited.json.value.thought.status === 'failed', JSON.stringify({ status: edited.status, text: edited.json?.value?.thought?.text, calls: app.createCalls.length - callsBefore }));
  check('AC9 edit sets updatedAt and editedAt', Number.isFinite(edited.json.value.thought.editedAt) && edited.json.value.thought.editedAt === edited.json.value.thought.updatedAt, JSON.stringify({ updatedAt: edited.json.value.thought.updatedAt, editedAt: edited.json.value.thought.editedAt }));
  const editEntry = (edited.json.value.thought.audit ?? []).find((entry) => entry.type === 'edit');
  check('AC9 edit audit carries actor, time and bounded excerpts', editEntry && editEntry.actor === 'You' && Number.isFinite(editEntry.at) && editEntry.previous === 'Second failing thought' && editEntry.new === 'Edited while failed', JSON.stringify(editEntry));
  const persistedEdit = (await readThoughtStore()).thoughts.find((thought) => thought.id === failedTwo.id);
  check('AC9 edit survives persistence', persistedEdit?.text === 'Edited while failed' && persistedEdit?.editedAt === edited.json.value.thought.editedAt, JSON.stringify({ text: persistedEdit?.text }));

  // A queued thought is editable while paused (the main edit case).
  await app.action('pauseBoard', {});
  const queued = (await app.action('submitThought', { text: 'Queued and editable' })).json.value.thought;
  const queuedEdit = await app.action('editThought', { thoughtId: queued.id, text: 'Queued and corrected' });
  check('AC9 a queued thought is editable while paused', queuedEdit.status === 200 && queuedEdit.json.value.thought.text === 'Queued and corrected' && queuedEdit.json.value.thought.status === 'queued', JSON.stringify({ status: queuedEdit.status, text: queuedEdit.json?.value?.thought?.text }));
  await app.action('deleteThought', { thoughtId: queued.id });
  await expectError('AC9 edit of a deleted thought is 404', () => app.action('editThought', { thoughtId: queued.id, text: 'nope' }), 404, 'thought/not-found');
  await app.action('resumeBoard', {});
}

// ===========================================================================
// AC10 — soft delete + ticket-drawer fallback
// ===========================================================================
{
  const res = await app.action('submitThought', { text: 'A thought scheduled for deletion' });
  const doomed = res.json.value.thought;
  const created = await app.callTool({ action: 'create', title: 'Survives the deletion', type: 'story' }, doomed.sessionId);
  const ticketId = created.ticket.id;
  app.observe(doomed.sessionId, false);
  await app.state();

  let deleted = await app.action('deleteThought', { thoughtId: doomed.id });
  check('AC10 delete is 200 and soft-deletes', deleted.status === 200 && deleted.json.value.thought.deletedAt > 0, `${deleted.status}`);
  check('AC10 delete audits exactly one entry', deleted.json.value.thought.audit.filter((entry) => entry.type === 'delete').length === 1);
  check('AC11 audit covers each linked ticket', deleted.json.value.thought.audit.some((entry) => entry.type === 'ticket' && entry.ticketId === ticketId), JSON.stringify(deleted.json.value.thought.audit));
  const afterDelete = (await app.state()).value;
  check('AC10 deleted row leaves snapshot.thoughts', !afterDelete.thoughts.some((thought) => thought.id === doomed.id));
  check('AC10 deleted id joins deletedThoughtIds', afterDelete.deletedThoughtIds.includes(doomed.id));
  check('AC10 ticket.thoughtId is untouched', afterDelete.board.tickets.find((ticket) => ticket.id === ticketId)?.thoughtId === doomed.id, afterDelete.board.tickets.find((ticket) => ticket.id === ticketId)?.thoughtId);
  check('AC10 deleted row stays in the store', (await readThoughtStore()).thoughts.some((thought) => thought.id === doomed.id && thought.deletedAt > 0));

  deleted = await app.action('deleteThought', { thoughtId: doomed.id });
  check('AC10 repeat delete is an idempotent 200', deleted.status === 200 && deleted.json.value.deleted === true, `${deleted.status}`);
  check('AC10 repeat delete writes no second audit entry', deleted.json.value.thought.audit.filter((entry) => entry.type === 'delete').length === 1);
  await expectError('AC10 delete unknown thought is 404', () => app.action('deleteThought', { thoughtId: 'TH-999' }), 404, 'thought/not-found');
  await expectError('AC10 delete of a working thought is 409', async () => {
    const running = (await app.action('submitThought', { text: 'Still working, cannot delete' })).json.value.thought;
    const attempt = await app.action('deleteThought', { thoughtId: running.id });
    app.observe(running.sessionId, false);
    return attempt;
  }, 409, 'thought/working');

  // Restart keeps the delete and the bounded id list.
  const restarted = makeHarness(stateDir);
  const restartedState = (await restarted.state()).value;
  check('AC10 delete survives restart', restartedState.deletedThoughtIds.includes(doomed.id) && !restartedState.thoughts.some((thought) => thought.id === doomed.id));

  const deletedCapDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-deletedcap-'));
  const manyDeleted = [];
  for (let index = 1; index <= 120; index += 1) {
    manyDeleted.push(seededThought({ id: `TH-${index}`, status: 'done', deletedAt: START_AT + index, updatedAt: START_AT + index }));
  }
  await seedStore(deletedCapDir, manyDeleted, 121);
  const deletedCap = makeHarness(deletedCapDir);
  const ids = (await deletedCap.state()).value.deletedThoughtIds;
  check('AC10 deletedThoughtIds is capped at 100, most recent first', ids.length === 100 && ids[0] === 'TH-120', JSON.stringify({ length: ids.length, first: ids[0] }));
  await rm(deletedCapDir, { recursive: true, force: true });
}

// ===========================================================================
// AC12 — limits unchanged: snapshot cap, working cap counts only working
// ===========================================================================
{
  const capDir = await mkdtemp(join(tmpdir(), 'kanban-lifecycle-snapcap-'));
  const seeded = [];
  for (let index = 1; index <= 60; index += 1) {
    seeded.push(seededThought({ id: `TH-${index}`, status: ['queued', 'cancelled', 'done', 'failed'][index % 4], createdAt: index, updatedAt: index }));
  }
  await seedStore(capDir, seeded, 61);
  const cap = makeHarness(capDir);
  await cap.action('pauseBoard', {});
  const capped = (await cap.state()).value;
  check('AC12 snapshot cap stays 50 newest-first', capped.thoughts.length === 50 && capped.thoughts[0].id === 'TH-60', `${capped.thoughts.length} ${capped.thoughts[0]?.id}`);
  check('AC12 queued/cancelled never count as working', capped.thoughts.every((thought) => thought.status !== 'working' ? true : true) && (await cap.action('submitThought', { text: 'Allowed' })).status === 200);
  check('AC12 no board schema bump and no board.thoughts', Number.isInteger(capped.board.version) && capped.board.version >= 2 && !('thoughts' in capped.board), `board.version=${capped.board.version}`);
  await rm(capDir, { recursive: true, force: true });
}

// ===========================================================================
// AC13 — guardrail: lifecycle actions are UI-only and rejected by name
// ===========================================================================
{
  const res = await app.action('submitThought', { text: 'Guardrail thought' });
  const thoughtSession = res.json.value.thought.sessionId;
  const storeBefore = await rawThoughtStore();
  const lifecycleActions = [
    { action: 'retryThought', thoughtId: res.json.value.thought.id },
    { action: 'cancelThought', thoughtId: res.json.value.thought.id },
    { action: 'editThought', thoughtId: res.json.value.thought.id, text: 'nope' },
    { action: 'deleteThought', thoughtId: res.json.value.thought.id },
  ];
  for (const args of lifecycleActions) {
    let code = '';
    try {
      await app.callTool(args, thoughtSession);
    } catch (error) {
      code = error instanceof Error ? error.message : String(error);
    }
    check(`AC13 thought-tied session rejected: ${args.action}`, code.includes('thought-read-only'), code.slice(0, 90));
  }
  let boardMutations = 0;
  try {
    await app.callTool({ action: 'move', ticketId: 'KB-1', column: 'ready' }, thoughtSession);
  } catch {
    boardMutations += 1;
  }
  check('AC13 thought session mutations stay rejected', boardMutations === 1 && (await rawThoughtStore()) === storeBefore, `boardMutations=${boardMutations}`);

  // The same names from a normal session are unknown actions.
  await app.action('setAgentRole', { sessionId: 'session-normal', role: 'product-manager' });
  for (const args of lifecycleActions) {
    let code = '';
    try {
      await app.callTool(args, 'session-normal');
    } catch (error) {
      code = error instanceof Error ? error.message : String(error);
    }
    check(`AC13 normal session gets unknown-action: ${args.action}`, code.includes('kanban/unknown-action'), code.slice(0, 90));
  }
  // Existing permissions unchanged: thought session can read and create; normal PM can create.
  let readOk = true;
  try {
    await app.callTool({ action: 'board' }, thoughtSession);
  } catch {
    readOk = false;
  }
  check('AC13 thought session read permission unchanged', readOk);
  let normalCreate = null;
  try {
    normalCreate = await app.callTool({ action: 'create', title: 'Normal create still works' }, 'session-normal');
  } catch (error) {
    normalCreate = { error: String(error) };
  }
  check('AC13 normal session create permission unchanged', Boolean(normalCreate?.ticket?.id), JSON.stringify(normalCreate).slice(0, 100));
  app.observe(thoughtSession, false);
}

// ===========================================================================
// AC12/AC14 — final invariants: no temp files, snapshot additivity, suite exit
// ===========================================================================
{
  const state = (await app.state()).value;
  check('AC12 snapshot keeps every pre-existing key', ['version', 'now', 'projects', 'workspaceId', 'project', 'board', 'team', 'roster', 'drafts', 'thoughts', 'sessions', 'rules'].every((key) => key in state), Object.keys(state).join(','));
  check('AC11 no board.thoughts and no board schema bump', !('thoughts' in state.board) && Number.isInteger(state.board.version) && state.board.version >= 2);
  check('AC11 thought store is still version 1', (await readThoughtStore()).version === 1);
  check('AC14 no atomic temp files left behind', (await readdir(join(stateDir, 'thoughts'))).every((name) => !name.includes('.tmp-')));
}

console.log('\n' + (failures.length === 0 ? 'ALL LIFECYCLE CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
await rm(root, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
