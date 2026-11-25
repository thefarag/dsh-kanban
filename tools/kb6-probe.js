#!/usr/bin/env node
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { apply } from '../index.js';

// KB-6 intake-hardening probe — a dependency-free fake-Harness CLI that boots the
// real host and drives the real `/kanban/action` handler plus the real `kanban`
// tool, then writes machine-readable evidence.
//
// It proves the four KB-6 contracts end to end:
//   1. duplicate protection: one thought, a normalized resubmission, 409
//      `thought/duplicate` naming the first row, no dispatch, no second row;
//   2. the per-workspace budget: 5 accepted / minute then 429
//      `thought/rate-limit` with a retry hint, and a second workspace unaffected;
//   3. the persisted intake audit: submitted -> dispatched -> ticket-linked per
//      created ticket, bounded exposure in the snapshot, survives a restart;
//   4. the adversarial guardrail matrix: every mutating catalog action from a
//      thought-tied session fails with `kanban/thought-read-only` and leaves the
//      board and thought store unchanged.
//
// No network, no model, no browser. It deliberately does NOT submit anything to
// the live GUI (that board is the user's working board and a 429/duplicate probe
// would pollute it); the dialog toast for 409/429 is rendered by the unchanged
// client error path and is covered by the `postJson` contract, not by screenshots.
//
//   node tools/kb6-probe.js          # print the transcript
//   node tools/kb6-probe.js --json   # machine-readable summary
//
// Exit code 0 = every check passed. Evidence:
//   docs/screenshots/kb6/final-verification.json

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const OUT_DIR = join(REPO, 'docs', 'screenshots', 'kb6');
const OUT_FILE = join(OUT_DIR, 'final-verification.json');
const AS_JSON = process.argv.includes('--json');
const START_AT = 1_700_000_000_000;
const MINUTE = 60_000;

const checks = [];
const transcripts = [];
const notes = [];
const record = (id, name, pass, detail = null) => {
  checks.push({ id, name, pass: pass === true, detail });
  if (!AS_JSON) console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === null ? '' : ` — ${JSON.stringify(detail).slice(0, 320)}`}`);
  return pass === true;
};
const transcript = (label, value) => {
  transcripts.push({ label, value });
  if (!AS_JSON) console.log(`# transcript: ${label}\n${JSON.stringify(value, null, 2)}`);
};
const note = (text) => {
  notes.push(text);
  if (!AS_JSON) console.log(`note ${text}`);
};
const deepEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// ---------------------------------------------------------------------------
// Fake Harness (same service shape production composes)
// ---------------------------------------------------------------------------
function makeHarness(dir) {
  const workspace = (id, title, path) => ({
    id,
    title,
    path,
    sessionIds: [],
    createdAt: new Date(START_AT).toISOString(),
    updatedAt: new Date(START_AT).toISOString(),
    async attachSession() {},
    async status() {
      return 'ok';
    },
  });
  const workspaces = [workspace('workspace-1', 'KB-6 lab', dir), workspace('workspace-2', 'KB-6 control', dir)];
  const sessionItems = [{ sessionId: 'session-normal', cwd: dir, running: false, updatedAt: START_AT, projections: { values: { title: 'Normal session' } } }];
  const createCalls = [];
  const prompts = [];
  const liveAgents = new Map();
  const flags = { failCreate: false };
  let clockNow = START_AT;
  const clock = () => clockNow;

  const agents = {
    async create(options) {
      createCalls.push(options);
      if (flags.failCreate) throw new Error('agents service unavailable');
      if (typeof options.setup === 'function') await options.setup({ effect: () => () => {} });
      liveAgents.set(options.sessionId, { id: options.sessionId, status: 'running', inbox: { hasPending: false }, session: { id: options.sessionId } });
      return { agent: { id: options.sessionId, session: { id: options.sessionId } } };
    },
    get: (id) => liveAgents.get(id),
    list: () => [...liveAgents.values()],
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
    on: () => () => {},
    get: (name) => services[name],
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
    workspaceRegistry: { list: () => workspaces },
    sessionPersistence: {
      async list() {
        return [{ header: { id: 'session-normal', cwd: dir } }];
      },
      async open() {
        return { async read() { return { events: [] }; }, async close() {} };
      },
      async stat(id) {
        return { header: { id, cwd: dir } };
      },
    },
    sessionController: {
      async list() {
        return { items: sessionItems.map((item) => ({ ...item })) };
      },
      async prompt(request) {
        prompts.push({ sessionId: request.sessionId, text: request.content.map((part) => part.text || '').join('') });
        return { accepted: true };
      },
      cancel() {},
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    agentPresets: { resolve: async () => ({ id: 'default-preset' }), mount: async () => {} },
    permissionPresets: {
      catalog: () => ({
        options: [
          { value: 'read-only', name: 'Read only', description: 'Inspect only' },
          { value: 'workspace-write', name: 'Workspace write', description: 'Modify the workspace' },
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

  // Real shipped defaults on the real injected clock.
  apply(ctx, { stateDir: dir, thoughtGraceMs: 2000, now: clock });

  const post = async (path, body) => {
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
  };

  return {
    dir,
    thoughtFile: join(dir, 'thoughts', 'workspace-1.json'),
    createCalls,
    prompts,
    flags,
    clock,
    advance: (ms) => {
      clockNow += ms;
    },
    action: (action, payload = {}, workspaceId = 'workspace-1') => post('/kanban/action', { workspaceId, action, payload }),
    state: async (workspaceId = 'workspace-1') => (await post('/kanban/state', { workspaceId })).json,
    callTool: (args, agentId) => tools.get('kanban').execute(args, { agent: { id: agentId } }),
    finish(sessionId) {
      const agent = liveAgents.get(sessionId);
      if (agent) agent.status = 'idle';
    },
  };
}

const fileIdentity = async (url) => {
  try {
    const buffer = await readFile(url);
    return { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
  } catch {
    return null;
  }
};

const failures = [];
const expect = (id, name, pass, detail = null) => {
  if (!record(id, name, pass, detail)) failures.push(`${id} ${name}`);
};

const scratch = [];
const makeCase = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kanban-kb6-probe-'));
  scratch.push(dir);
  return makeHarness(dir);
};

// ---------------------------------------------------------------------------
// 1. Duplicate protection (AC 1-4)
// ---------------------------------------------------------------------------
async function probeDuplicates() {
  if (!AS_JSON) console.log('\n## 1. duplicate protection');
  const app = await makeCase();
  const first = await app.action('submitThought', { text: '  Add   an   intake   audit  ' });
  expect('AC1', 'first thought accepted', first.status === 200 && first.json.ok === true, { status: first.status, thought: first.json.value?.thought?.id });
  expect('AC1', 'stored text is verbatim after trimming', first.json.value?.thought?.text === 'Add   an   intake   audit', first.json.value?.thought?.text);
  const createsBefore = app.createCalls.length;
  const duplicate = await app.action('submitThought', { text: 'add AN intake AUDIT' });
  expect('AC2', 'normalized duplicate is 409 thought/duplicate', duplicate.status === 409 && duplicate.json?.error?.code === 'thought/duplicate', { status: duplicate.status, code: duplicate.json?.error?.code, message: duplicate.json?.error?.message });
  expect('AC2', 'the duplicate message names the existing TH-n', /TH-1/.test(duplicate.json?.error?.message ?? ''), duplicate.json?.error?.message);
  expect('AC2', 'the duplicate creates no thought and no dispatch', app.createCalls.length === createsBefore && (await app.state()).value.thoughts.length === 1);
  app.advance(10 * MINUTE + 1);
  const afterWindow = await app.action('submitThought', { text: 'add an intake audit' });
  expect('AC4', 'the same text is accepted after the 10-minute window', afterWindow.status === 200, { status: afterWindow.status, code: afterWindow.json?.error?.code });
  transcript('duplicate-409', {
    submittedText: '  Add   an   intake   audit  ',
    existingThought: first.json.value?.thought?.id,
    duplicateRequest: { text: 'add AN intake AUDIT' },
    duplicateResponse: duplicate.json,
    createsBefore,
    createsAfter: app.createCalls.length,
  });
  return app;
}

// ---------------------------------------------------------------------------
// 2. Per-workspace rate limit (AC 6-7)
// ---------------------------------------------------------------------------
async function probeRateLimit() {
  if (!AS_JSON) console.log('\n## 2. per-workspace intake budget');
  const app = await makeCase();
  const accepted = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await app.action('submitThought', { text: `Budget transcript idea ${index}` });
    accepted.push(result.status);
    if (result.status === 200) {
      app.finish(result.json.value.thought.sessionId);
      await app.state();
    }
  }
  expect('AC6', 'five accepted submissions inside one minute', accepted.every((status) => status === 200), accepted);
  const createsBefore = app.createCalls.length;
  const rejected = await app.action('submitThought', { text: 'Budget transcript idea 5' });
  expect('AC6', 'the sixth submission is 429 thought/rate-limit', rejected.status === 429 && rejected.json?.error?.code === 'thought/rate-limit', { status: rejected.status, code: rejected.json?.error?.code });
  expect('AC6', 'the 429 carries a user-readable retry hint', /try again in \d+ seconds?/i.test(rejected.json?.error?.message ?? ''), rejected.json?.error?.message);
  expect('AC6', 'the rejection creates no thought and no session', app.createCalls.length === createsBefore && (await app.state()).value.thoughts.length === 5);
  const otherWorkspace = await app.action('submitThought', { text: 'Budget transcript idea 0' }, 'workspace-2');
  expect('AC6', 'another workspace keeps its own budget', otherWorkspace.status === 200, { status: otherWorkspace.status, code: otherWorkspace.json?.error?.code });
  const stored = JSON.parse(await readFile(app.thoughtFile, 'utf8'));
  transcript('rate-limit-429', {
    acceptedStatuses: accepted,
    rejectedRequest: { text: 'Budget transcript idea 5' },
    rejectedResponse: rejected.json,
    persistedRateLog: stored.rateLog,
    otherWorkspaceStatus: otherWorkspace.status,
  });
  return app;
}

// ---------------------------------------------------------------------------
// 3. Intake audit (AC 8-9)
// ---------------------------------------------------------------------------
async function probeAudit() {
  if (!AS_JSON) console.log('\n## 3. persisted intake audit');
  const app = await makeCase();
  const submitted = await app.action('submitThought', { text: 'Audit transcript thought' });
  const thought = submitted.json.value.thought;
  const epic = await app.callTool({ action: 'create', title: 'Transcript epic', type: 'epic' }, thought.sessionId);
  const child = await app.callTool({ action: 'create', title: 'Transcript child', parentId: epic.ticket.id }, thought.sessionId);
  app.finish(thought.sessionId);
  const snapshot = (await app.state()).value;
  const row = snapshot.thoughts.find((candidate) => candidate.id === thought.id);
  const types = row.intakeAudit.map((entry) => entry.type);
  expect('AC8', 'audit records submitted, dispatched and ticket-linked per ticket', deepEqual(types, ['submitted', 'dispatched', 'ticket-linked', 'ticket-linked']), types);
  expect('AC8', 'submitted is human-attributed and dispatched carries the session', row.intakeAudit[0].actor === 'human' && row.intakeAudit[1].sessionId === thought.sessionId);
  const links = row.intakeAudit.filter((entry) => entry.type === 'ticket-linked').map((entry) => entry.ticketId);
  expect('AC9', 'the ticket-linked union matches thought.ticketIds', deepEqual([...links].sort(), [...row.ticketIds].sort()), { links, ticketIds: row.ticketIds });
  expect('AC9', 'each ticket appears at most once as ticket-linked', new Set(links).size === links.length, links);
  const storedFile = JSON.parse(await readFile(app.thoughtFile, 'utf8'));
  expect('AC8', 'the audit is persisted in the thought store', deepEqual(storedFile.thoughts[0].intakeAudit, row.intakeAudit));
  const restarted = makeHarness(app.dir);
  const restartedRow = (await restarted.state()).value.thoughts.find((candidate) => candidate.id === thought.id);
  expect('AC8', 'the audit survives a restart', deepEqual(restartedRow.intakeAudit, row.intakeAudit));
  expect('AC8', 'the board schema is unchanged', snapshot.board.version === 3 && !('thoughts' in snapshot.board), { boardVersion: snapshot.board.version });
  transcript('intake-audit', {
    thoughtId: thought.id,
    sessionId: thought.sessionId,
    snapshottedAudit: row.intakeAudit,
    ticketIds: row.ticketIds,
    persistedAudit: storedFile.thoughts[0].intakeAudit,
    afterRestart: restartedRow.intakeAudit,
  });
  return { app, thought };
}

// ---------------------------------------------------------------------------
// 4. Adversarial guardrail matrix (AC 10-11)
// ---------------------------------------------------------------------------
async function probeGuardrail(app, thought) {
  if (!AS_JSON) console.log('\n## 4. adversarial guardrail matrix');
  const sessionId = thought.sessionId;
  await app.callTool({ action: 'whoami' }, sessionId);
  const baseline = (await app.state()).value;
  const storeBefore = await readFile(app.thoughtFile, 'utf8');
  const mutating = [
    'move', 'update', 'comment', 'claim', 'release', 'block', 'unblock', 'finish', 'run', 'assign',
    'pause', 'resume', 'scan', 'cancel_execution', 'retryThought', 'cancelThought', 'editThought',
    'deleteThought', 'create_member', 'set_role',
  ];
  const matrix = [];
  for (const action of mutating) {
    let code = '';
    try {
      await app.callTool({ action, ticketId: 'KB-1', thoughtId: thought.id, text: 'nope' }, sessionId);
    } catch (error) {
      code = error instanceof Error ? error.message : String(error);
    }
    matrix.push({ action, rejected: code.includes('kanban/thought-read-only'), code: code.slice(0, 120) });
    expect('AC10', `thought session rejects ${action}`, code.includes('kanban/thought-read-only'), code.slice(0, 120));
  }
  const after = (await app.state()).value;
  const boardEqual = deepEqual(
    JSON.parse(JSON.stringify({ ...after.board, updatedAt: 0 })),
    JSON.parse(JSON.stringify({ ...baseline.board, updatedAt: 0 })),
  );
  expect('AC10', 'the board stays deep-equal (no ticket/activity/agent change)', boardEqual);
  expect('AC10', 'the thought rows stay deep-equal', deepEqual(after.thoughts, baseline.thoughts));
  expect('AC10', 'the thought store stays byte-identical', (await readFile(app.thoughtFile, 'utf8')) === storeBefore);
  const forced = await app.callTool({ action: 'create', title: 'Forced transcript ticket', column: 'done', thoughtId: 'TH-99' }, sessionId);
  expect('AC11', 'create from a thought session forces Backlog', forced.ticket.column === 'backlog', forced.ticket.column);
  expect('AC11', 'a forged thoughtId is overridden by the server stamp', forced.ticket.thoughtId === thought.id, forced.ticket.thoughtId);
  const forcedRow = (await app.state()).value.thoughts.find((candidate) => candidate.id === thought.id);
  expect(
    'AC11',
    'the forced create is linked in ticketIds and the intake audit',
    forcedRow.ticketIds.includes(forced.ticket.id) &&
      forcedRow.intakeAudit.some((entry) => entry.type === 'ticket-linked' && entry.ticketId === forced.ticket.id),
    { ticketIds: forcedRow.ticketIds, audit: forcedRow.intakeAudit },
  );
  transcript('guardrail-matrix', { thoughtId: thought.id, actions: matrix, boardDeepEqual: boardEqual });
  transcript('create-forcing', { created: forced.ticket, forcedThoughtId: 'TH-99' });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const startedAt = Date.now();
if (!AS_JSON) {
  console.log('KB-6 intake hardening probe — real host handler, fake Harness services');
  console.log(`repo: ${REPO}`);
}
const duplicateApp = await probeDuplicates();
const rateApp = await probeRateLimit();
const audit = await probeAudit();
await probeGuardrail(audit.app, audit.thought);

const build = {
  probe: await fileIdentity(join(REPO, 'index.js')),
  client: await fileIdentity(join(REPO, 'client.js')),
  note: 'Evidence is produced by the real /kanban/action handler and the real kanban tool against fake Harness services; there is no browser mutation of the live board.',
};
const summary = {
  ok: failures.length === 0,
  meta: {
    probe: 'tools/kb6-probe.js',
    startedAt,
    durationMs: Date.now() - startedAt,
    clock: { start: START_AT, timezone: 'injected' },
    build,
  },
  checks,
  transcripts,
  notes,
  failures,
};
await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, JSON.stringify(summary, null, 2));

if (AS_JSON) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`\n${failures.length === 0 ? 'ALL KB-6 PROBE CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`}`);
  console.log(`evidence: ${OUT_FILE} (${checks.length} checks, ${transcripts.length} transcripts)`);
}
for (const dir of scratch) await rm(dir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
