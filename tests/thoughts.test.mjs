import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

// KB-1 thought intake — fake Harness: agents.create capture, permission preset
// assertion, session title rename, restart on the same state dir, linkage,
// guardrail, failure paths, and the 30 s grace (shrunk via config for the test).
const root = await mkdtemp(join(tmpdir(), 'kanban-thoughts-'));
const stateDir = await mkdtemp(join(tmpdir(), 'kanban-thoughts-state-'));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One booted host instance with its own fake Harness services. */
function makeHarness(dir, { graceMs = 2000 } = {}) {
  const sessionItems = [
    // Two unrelated sessions that belong to the project: they prove normal
    // sessions keep their permissions while a thought session is restricted.
    { sessionId: 'session-normal', cwd: root, running: false, updatedAt: Date.now(), projections: { values: { title: 'Normal PM session' } } },
    { sessionId: 'session-fe', cwd: root, running: false, updatedAt: Date.now(), projections: { values: { title: 'Normal FE session' } } },
  ];
  const createCalls = [];
  const prompts = [];
  const permissionSets = [];
  const presetMounts = [];
  const renamed = [];
  const liveAgents = new Map();
  const flags = { failCreate: false, failPrompt: false };

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
      cancel() {},
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    agentPresets: {
      resolve: async () => ({ id: 'default-preset' }),
      mount: async (_agentCtx, id) => {
        presetMounts.push(id);
      },
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
      set: (session, value) => permissionSets.push({ session: session.id, value }),
    },
    sessionTitle: {
      rename(live, title) {
        renamed.push({ sessionId: live.id, title });
      },
    },
    sessions: { get: (id) => liveAgents.get(id), flush: async () => {} },
    agents,
  };
  services.agentDefaultModel = ctx.agentDefaultModel;
  services.sessionTitle = ctx.sessionTitle;
  services.sessions = ctx.sessions;
  services.permissionPresets = ctx.permissionPresets;
  services.agentPresets = ctx.agentPresets;

  apply(ctx, { stateDir: dir, thoughtGraceMs: graceMs });

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
    agents,
    createCalls,
    prompts,
    permissionSets,
    presetMounts,
    renamed,
    liveAgents,
    flags,
    routes,
    tools,
    action: (action, payload = {}) => post('/kanban/action', { workspaceId: 'workspace-1', action, payload }),
    state: async () => (await post('/kanban/state', { workspaceId: 'workspace-1' })).json,
    callTool: (args, agentId = 'session-normal') =>
      tools.get('kanban').execute(args, { agent: { id: agentId } }),
    /** Mark a session observable + running/idle in the fake Harness. */
    observe(sessionId, running) {
      let item = sessionItems.find((entry) => entry.sessionId === sessionId);
      if (!item) {
        item = { sessionId, cwd: root, running, updatedAt: Date.now(), projections: { values: { title: sessionId } } };
        sessionItems.push(item);
      }
      item.running = running;
      item.updatedAt = Date.now();
      const agent = liveAgents.get(sessionId);
      if (agent) agent.status = running ? 'running' : 'idle';
      else liveAgents.set(sessionId, { id: sessionId, status: running ? 'running' : 'idle', inbox: { hasPending: false }, session: { id: sessionId } });
    },
    /** Simulate a session that never materializes (no summary, no agent). */
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

const app = makeHarness(stateDir);

// --- 1. additive snapshot contract -----------------------------------------
let state = await app.state();
check('snapshot ok', state.ok === true && state.value !== undefined);
let snap = state.value;
check('snapshot version 2 (no schema bump)', snap.version === 2, String(snap.version));
check('thoughts is an empty additive array', Array.isArray(snap.thoughts) && snap.thoughts.length === 0, JSON.stringify(snap.thoughts));
check('board has no thoughts key', snap.board && !('thoughts' in snap.board), Object.keys(snap.board ?? {}).filter((key) => key === 'thoughts').join(','));
check('board version still 2', snap.board.version === 2, String(snap.board.version));

// --- 2. validation ---------------------------------------------------------
await expectError('non-string text is bad-request', () => app.action('submitThought', { text: 42 }), 400, 'bad-request');
await expectError('missing text is bad-request', () => app.action('submitThought', {}), 400, 'bad-request');
await expectError('whitespace text is thought/empty', () => app.action('submitThought', { text: '  \n\t ' }), 400, 'thought/empty');
let res = await app.action('submitThought', { text: 'x'.repeat(4001) });
check('4001 chars is thought/too-long', res.status === 400 && res.json.error.code === 'thought/too-long', `${res.status} ${res.json?.error?.code}`);
check('too-long message names the 4000 cap', /4000/.test(res.json?.error?.message ?? ''), res.json?.error?.message);
check('rejected thoughts never dispatch', app.createCalls.length === 0, String(app.createCalls.length));

// --- 3. submit + dispatch contract ----------------------------------------
const firstText = '  Ship a settings page with dark mode and a danger zone  ';
const callsBefore = app.createCalls.length;
res = await app.action('submitThought', { text: firstText });
check('submit accepted', res.status === 200 && res.json.ok === true, `${res.status} ${res.json?.error?.code}`);
const first = res.json.value.thought;
check('thought id is TH-1', first.id === 'TH-1', first.id);
check('thought reaches working', first.status === 'working', JSON.stringify({ status: first.status, error: first.error }));
check('thought stores trimmed text verbatim', first.text === firstText.trim(), JSON.stringify(first.text));
check('thought carries the session id', typeof first.sessionId === 'string' && first.sessionId.startsWith('session-'), first.sessionId);
check('thought starts with no tickets', Array.isArray(first.ticketIds) && first.ticketIds.length === 0);
const dispatchCall = app.createCalls[callsBefore];
check('one agents.create call', app.createCalls.length - callsBefore === 1, String(app.createCalls.length - callsBefore));
check('dispatch cwd is the project path', dispatchCall?.meta?.cwd === root, dispatchCall?.meta?.cwd);
check('dispatch mounts the project preset', dispatchCall?.meta?.agentPreset === 'default-preset', JSON.stringify(dispatchCall?.meta));
check('project preset mounted for tools', app.presetMounts.includes('default-preset'), JSON.stringify(app.presetMounts));
check('read-only permission preset applied before prompting', app.permissionSets.some((entry) => entry.session === first.sessionId && entry.value === 'read-only'), JSON.stringify(app.permissionSets));
const expectedTitle = `Thought TH-1 · ${firstText.trim().replace(/\s+/g, ' ').slice(0, 60)}`;
check('session renamed to Thought TH-1 · excerpt', app.renamed.some((entry) => entry.sessionId === first.sessionId && entry.title === expectedTitle), JSON.stringify(app.renamed));
const seedPm = (snap.roster ?? []).find((member) => member.roleId === 'product-manager');
check('seeded product manager exists', Boolean(seedPm) && seedPm.name.length > 2, seedPm?.name);
const firstPrompt = app.prompts.find((entry) => entry.sessionId === first.sessionId)?.text ?? '';
check('prompt carries the thought verbatim', firstPrompt.includes(firstText.trim()), firstPrompt.slice(0, 80));
check('prompt carries the PM role playbook + persona', firstPrompt.includes(seedPm?.persona?.slice(0, 60) ?? 'missing-persona'), seedPm?.name);
check('prompt carries all six rules', [
  'Read the board first',
  '1–20 independently shippable tickets',
  'numbered, testable acceptance criteria',
  'Backlog only',
  'Do not create an EPIC',
  'summary of created ticket ids',
].every((rule) => firstPrompt.includes(rule)), firstPrompt.slice(0, 120));
check('prompt says the session is read-only and tool-scoped', /read-only/i.test(firstPrompt) && /thought-read-only/.test(firstPrompt));

snap = (await app.state()).value;
check('snapshot exposes the thought newest first', snap.thoughts.length === 1 && snap.thoughts[0].id === 'TH-1' && snap.thoughts[0].status === 'working', JSON.stringify(snap.thoughts.map((thought) => thought.id)));
check('board agent recorded as product-manager', snap.board.agents?.[first.sessionId]?.role === 'product-manager', snap.board.agents?.[first.sessionId]?.role);

// --- 4. tool guardrail -----------------------------------------------------
for (const action of ['whoami', 'projects', 'board', 'list', 'next', 'team', 'members']) {
  let ok = true;
  try {
    await app.callTool({ action }, first.sessionId);
  } catch (error) {
    ok = false;
  }
  check(`thought session may ${action}`, ok);
}
const blockedActions = [
  { action: 'claim', ticketId: 'KB-1' },
  { action: 'move', ticketId: 'KB-1', column: 'ready' },
  { action: 'update', ticketId: 'KB-1', title: 'nope' },
  { action: 'comment', ticketId: 'KB-1', text: 'nope' },
  { action: 'release', ticketId: 'KB-1' },
  { action: 'finish', ticketId: 'KB-1' },
  { action: 'block', ticketId: 'KB-1', text: 'nope' },
  { action: 'create_member', name: 'Probe Person', role: 'tester' },
  { action: 'scan' },
  { action: 'pause' },
  { action: 'resume' },
];
for (const args of blockedActions) {
  let code = '';
  try {
    await app.callTool(args, first.sessionId);
  } catch (error) {
    code = error instanceof Error ? error.message : String(error);
  }
  check(`thought session rejected: ${args.action}`, code.includes('thought-read-only'), code.slice(0, 80));
}
snap = (await app.state()).value;
check('guardrail changed no board state', snap.board.tickets.length === 0 && snap.board.paused === false, `${snap.board.tickets.length} ${snap.board.paused}`);

// --- 5. linkage: create forces Backlog + stamps thoughtId ------------------
let created = await app.callTool(
  { action: 'create', title: 'Settings page', description: 'AC1…', type: 'story', priority: 'high', role: 'fe-developer', column: 'ready', labels: ['ui'] },
  first.sessionId,
);
check('thought create lands in Backlog despite column:ready', created.ticket.column === 'backlog', created.ticket.column);
check('thought create stamps thoughtId', created.ticket.thoughtId === 'TH-1', created.ticket.thoughtId);
await app.callTool({ action: 'create', title: 'Danger zone', type: 'story', role: 'fe-developer' }, first.sessionId);
snap = (await app.state()).value;
const linked = snap.board.tickets.find((ticket) => ticket.id === 'KB-1');
check('ticket persisted with thoughtId in backlog', linked?.column === 'backlog' && linked?.thoughtId === 'TH-1', JSON.stringify({ column: linked?.column, thoughtId: linked?.thoughtId }));
check('thought lists created tickets in creation order', JSON.stringify(snap.thoughts[0].ticketIds) === JSON.stringify(['KB-1', 'KB-2']), JSON.stringify(snap.thoughts[0].ticketIds));
check('two tickets created from the thought session', snap.board.tickets.filter((ticket) => ticket.thoughtId === 'TH-1').length === 2);

// Normal sessions keep today's behaviour exactly.
res = await app.action('setAgentRole', { sessionId: 'session-normal', role: 'product-manager' });
check('normal session adopts PM role', res.status === 200, `${res.status} ${res.json?.error?.code}`);
created = await app.callTool({ action: 'create', title: 'Normal ready ticket', column: 'ready' }, 'session-normal');
check('normal session create keeps its column', created.ticket.column === 'ready', created.ticket.column);
check('normal session create has no thoughtId', created.ticket.thoughtId === null || created.ticket.thoughtId === undefined, String(created.ticket.thoughtId));
res = await app.action('setAgentRole', { sessionId: 'session-fe', role: 'fe-developer' });
check('normal FE role set', res.status === 200, `${res.status}`);
let normalCode = '';
try {
  await app.callTool({ action: 'create', title: 'FE nope' }, 'session-fe');
} catch (error) {
  normalCode = error instanceof Error ? error.message : String(error);
}
check('normal non-PM session still cannot create', normalCode.includes('role-forbidden'), normalCode.slice(0, 80));

// --- 6. working-thought limit + paused capture ----------------------------
const secondText = 'Add an audit log for board changes';
res = await app.action('submitThought', { text: secondText });
check('second thought accepted', res.status === 200 && res.json.value.thought.id === 'TH-2', `${res.status} ${res.json?.error?.code}`);
const second = res.json.value.thought;
app.observe(second.sessionId, true);
res = await app.action('submitThought', { text: 'Third thought for the limit' });
check('third thought accepted', res.status === 200 && res.json.value.thought.id === 'TH-3', `${res.status} ${res.json?.error?.code}`);
app.observe(res.json.value.thought.sessionId, true);
await expectError('fourth working thought is thought/limit', () => app.action('submitThought', { text: 'This should not start' }), 409, 'thought/limit');
res = await app.action('pauseBoard', {});
check('board paused', res.status === 200 && res.json.value.board.paused === true, String(res.status));
res = await app.action('submitThought', { text: 'Captured while paused?' });
check('paused capture is 423 board/paused', res.status === 423 && res.json.error.code === 'board/paused', `${res.status} ${res.json?.error?.code}`);
check('paused message tells the user to resume', /resume/i.test(res.json?.error?.message ?? ''), res.json?.error?.message);
res = await app.action('resumeBoard', {});
check('board resumed', res.status === 200 && res.json.value.board.paused === false, String(res.status));

// --- 7. completion: working -> done, exactly once, 0 tickets is valid ------
await sleep(1600);
snap = (await app.state()).value;
check('observed running session keeps the thought working', snap.thoughts.find((thought) => thought.id === 'TH-1')?.status === 'working', snap.thoughts.find((thought) => thought.id === 'TH-1')?.status);
const secondStatus = snap.thoughts.find((thought) => thought.id === 'TH-2')?.status;
check('newly observed session keeps working', secondStatus === 'working', secondStatus);
app.observe(first.sessionId, false);
app.observe(second.sessionId, false);
await sleep(1600);
snap = (await app.state()).value;
const doneFirst = snap.thoughts.find((thought) => thought.id === 'TH-1');
const doneSecond = snap.thoughts.find((thought) => thought.id === 'TH-2');
check('stopped session flips the thought to done', doneFirst?.status === 'done', doneFirst?.status);
check('done thought keeps its ticket list and session', JSON.stringify(doneFirst?.ticketIds) === JSON.stringify(['KB-1', 'KB-2']) && typeof doneFirst?.sessionId === 'string', JSON.stringify(doneFirst?.ticketIds));
check('done with zero tickets is valid', doneSecond?.status === 'done' && Array.isArray(doneSecond?.ticketIds) && doneSecond.ticketIds.length === 0 && typeof doneSecond?.sessionId === 'string', JSON.stringify({ status: doneSecond?.status, tickets: doneSecond?.ticketIds }));
const doneUpdatedAt = doneFirst?.updatedAt;
await sleep(1600);
snap = (await app.state()).value;
check('done is idempotent (updatedAt bumped once)', snap.thoughts.find((thought) => thought.id === 'TH-1')?.updatedAt === doneUpdatedAt, `${snap.thoughts.find((thought) => thought.id === 'TH-1')?.updatedAt} vs ${doneUpdatedAt}`);

// --- 8. dispatch failures keep the thought (200, failed, no linkage) ------
const ticketCountBefore = snap.board.tickets.length;
app.flags.failCreate = true;
res = await app.action('submitThought', { text: 'A thought the session cannot start for' });
check('create failure still returns 200', res.status === 200 && res.json.ok === true, String(res.status));
const failedCreate = res.json.value.thought;
check('create failure marks the thought failed', failedCreate.status === 'failed' && failedCreate.sessionId === null, JSON.stringify({ status: failedCreate.status, sessionId: failedCreate.sessionId }));
check('create failure records the error', /Could not start an agent session/.test(failedCreate.error), failedCreate.error);
app.flags.failCreate = false;

app.flags.failPrompt = true;
res = await app.action('submitThought', { text: 'A thought whose prompt is rejected' });
check('prompt failure still returns 200', res.status === 200 && res.json.ok === true, String(res.status));
const failedPrompt = res.json.value.thought;
check('prompt failure marks the thought failed', failedPrompt.status === 'failed' && failedPrompt.sessionId === null, JSON.stringify({ status: failedPrompt.status, sessionId: failedPrompt.sessionId }));
check('prompt failure records the error', /rejected/i.test(failedPrompt.error), failedPrompt.error);
const failedSession = app.createCalls[app.createCalls.length - 1]?.sessionId;
snap = (await app.state()).value;
check('prompt failure persists no partial agent linkage', failedSession && !snap.board.agents?.[failedSession], failedSession);
check('failed dispatches create no tickets', snap.board.tickets.length === ticketCountBefore, `${snap.board.tickets.length}/${ticketCountBefore}`);
app.flags.failPrompt = false;

// --- 9. never-observed session -> failed after the grace -------------------
const never = await app.action('submitThought', { text: 'A thought whose session never appears' });
check('never-observed thought starts working', never.json.value.thought.status === 'working', never.json.value.thought.status);
app.unobserve(never.json.value.thought.sessionId);
await sleep(2600);
snap = (await app.state()).value;
const failedNever = snap.thoughts.find((thought) => thought.id === never.json.value.thought.id);
check('never-observed session flips to failed after the grace', failedNever?.status === 'failed', failedNever?.status);
check('never-observed failure carries the exact error', failedNever?.error === 'the product manager session did not start', failedNever?.error);

// --- 10. length boundary: 4000 accepted -----------------------------------
res = await app.action('submitThought', { text: 'y'.repeat(4000) });
check('4000 chars is accepted', res.status === 200 && res.json.value.thought.status === 'working', `${res.status} ${res.json?.error?.code}`);

// --- 11. persistence, restart and the "no board.thoughts" rule ------------
const thoughtFile = join(stateDir, 'thoughts', 'workspace-1.json');
const thoughtFileRaw = JSON.parse(await readFile(thoughtFile, 'utf8'));
check('thought store file versioned', thoughtFileRaw.version === 1, String(thoughtFileRaw.version));
check('thought store file holds every record', thoughtFileRaw.thoughts.length === 7, String(thoughtFileRaw.thoughts.length));
check('thought store allocates TH-n from a persisted counter', thoughtFileRaw.nextNumber === 8, String(thoughtFileRaw.nextNumber));
const boardFileRaw = JSON.parse(await readFile(join(stateDir, 'workspace-1.json'), 'utf8'));
check('board file has no thoughts key', !('thoughts' in boardFileRaw), Object.keys(boardFileRaw).join(','));
check('board file version is still 2', boardFileRaw.version === 2, String(boardFileRaw.version));
check('no atomic temp files left behind', (await readdir(join(stateDir, 'thoughts'))).every((name) => !name.includes('.tmp-')), JSON.stringify(await readdir(join(stateDir, 'thoughts'))));

const restarted = makeHarness(stateDir);
const restartedState = (await restarted.state()).value;
const restartedFirst = restartedState.thoughts.find((thought) => thought.id === 'TH-1');
check('restart preserves id/text/status', restartedFirst?.id === 'TH-1' && restartedFirst?.text === firstText.trim() && restartedFirst?.status === 'done', JSON.stringify({ id: restartedFirst?.id, status: restartedFirst?.status }));
check('restart preserves ticket linkage', JSON.stringify(restartedFirst?.ticketIds) === JSON.stringify(['KB-1', 'KB-2']), JSON.stringify(restartedFirst?.ticketIds));
const restartedTicket = restartedState.board.tickets.find((ticket) => ticket.id === 'KB-1');
check('ticket.thoughtId survives restart', restartedTicket?.thoughtId === 'TH-1' && restartedTicket?.column === 'backlog', JSON.stringify({ thoughtId: restartedTicket?.thoughtId, column: restartedTicket?.column }));
check('restart still reports a v2 board', restartedState.version === 2 && restartedState.board.version === 2);

// --- 12. tolerant reads: missing and corrupt thought files ----------------
const corruptDir = await mkdtemp(join(tmpdir(), 'kanban-thoughts-corrupt-'));
await mkdir(join(corruptDir, 'thoughts'), { recursive: true });
await writeFile(join(corruptDir, 'thoughts', 'workspace-1.json'), '{ not json at all');
const corrupt = makeHarness(corruptDir);
const corruptState = (await corrupt.state()).value;
check('corrupt thoughts file degrades to []', Array.isArray(corruptState.thoughts) && corruptState.thoughts.length === 0, JSON.stringify(corruptState.thoughts));
check('board still loads with a corrupt thoughts file', Boolean(corruptState.board) && corruptState.board.version === 2);
check('corrupt file was set aside', (await readdir(join(corruptDir, 'thoughts'))).some((name) => name.includes('.corrupt-')), JSON.stringify(await readdir(join(corruptDir, 'thoughts'))));
const missingDir = await mkdtemp(join(tmpdir(), 'kanban-thoughts-missing-'));
const missing = makeHarness(missingDir);
const missingState = (await missing.state()).value;
check('missing thoughts file degrades to []', Array.isArray(missingState.thoughts) && missingState.thoughts.length === 0);

// --- 13. snapshot: newest first, capped at 50 -----------------------------
const capDir = await mkdtemp(join(tmpdir(), 'kanban-thoughts-cap-'));
await mkdir(join(capDir, 'thoughts'), { recursive: true });
const seededThoughts = [];
for (let index = 1; index <= 60; index += 1) {
  seededThoughts.push({
    id: `TH-${index}`,
    text: `Seeded thought ${index}`,
    status: 'done',
    createdAt: index,
    updatedAt: index,
    sessionId: null,
    error: '',
    ticketIds: [],
  });
}
await writeFile(join(capDir, 'thoughts', 'workspace-1.json'), JSON.stringify({ version: 1, nextNumber: 61, thoughts: seededThoughts }));
const capped = makeHarness(capDir);
const cappedThoughts = (await capped.state()).value.thoughts;
check('snapshot caps thoughts at 50', cappedThoughts.length === 50, String(cappedThoughts.length));
check('capped snapshot is newest first', cappedThoughts[0]?.id === 'TH-60' && cappedThoughts[49]?.id === 'TH-11', `${cappedThoughts[0]?.id} … ${cappedThoughts[49]?.id}`);

console.log('\n' + (failures.length === 0 ? 'ALL THOUGHT CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
await rm(root, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
await rm(corruptDir, { recursive: true, force: true });
await rm(missingDir, { recursive: true, force: true });
await rm(capDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
