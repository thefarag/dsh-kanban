import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

const root = await mkdtemp(join(tmpdir(), 'kanban-test-'));
const stateDir = await mkdtemp(join(tmpdir(), 'kanban-state-'));
await mkdir(join(root, 'docs'), { recursive: true });
await writeFile(join(root, 'README.md'), '# Demo Project\n\nSomething useful.\n');
await writeFile(join(root, 'docs', 'VISION.md'), '# Product Vision\n\nWe help small teams ship reliable software.\n');
await writeFile(
  join(root, 'docs', 'PLAN.md'),
  '# Delivery Plan\n\n- [ ] Add login flow\n- [ ] Add billing page\n- [x] bootstrap repo\n\nTODO: fix crash on start\nFIXME: slow query in reports\n',
);
await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
await writeFile(join(root, 'node_modules', 'x', 'README.md'), '# ignored\n- [ ] should not appear\n');

const workspace = {
  id: 'workspace-1',
  title: 'Demo',
  path: root,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  sessionIds: ['session-1'],
};

const sessionItems = [
  { sessionId: 'session-1', cwd: root, running: false, updatedAt: Date.now(), projections: { values: { title: 'Demo lead session' } } },
];
const persistence = [
  { header: { id: 'session-1', cwd: root, createdAt: Date.now() }, eventCount: 0, revision: 'r1' },
];

const services = {};
const routes = new Map();
const tools = new Map();
let promptSection = null;

const ctx = {
  effect(fn, label) {
    const disposer = fn();
    if (typeof disposer !== 'function') throw new Error(`effect ${label} returned no disposer`);
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
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`);
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
  systemPrompt: {
    section(section) {
      promptSection = section;
      return () => {};
    },
  },
  connection: { requestRejection: () => undefined },
  workspaceRegistry: { list: () => [workspace] },
  sessionController: {
    async list() {
      return { items: sessionItems };
    },
    cancel() {
      return { accepted: true };
    },
    async prompt() {
      return { accepted: true };
    },
  },
  sessionPersistence: {
    async list() {
      return persistence;
    },
    async open() {
      return { async read() { return { events: [] }; }, async close() {} };
    },
    async stat(id) {
      return persistence.find((entry) => entry.header.id === id) ?? undefined;
    },
  },
  agents: { list: () => [], get: () => undefined },
};

apply(ctx, { stateDir, wipInProgress: 3, wipReview: 5, scanMaxFiles: 40 });

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const expectThrow = async (label, fn, code) => {
  try {
    await fn();
    failures.push(`${label} — expected throw`);
    console.log(`FAIL ${label} (no throw)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, message.includes(code), message.slice(0, 120));
  }
};

check('routes registered', routes.has('/kanban/state') && routes.has('/kanban/action'));
check('tool registered', tools.has('kanban'));
check('prompt section registered', promptSection?.name === 'kanban:board-policy', promptSection?.name);

const tool = tools.get('kanban');
const exec = (agentId = 'session-1') => ({ agent: { id: agentId } });
const callTool = (args, agentId) => tool.execute(args, exec(agentId));

async function mockHttp(path, body, { contentType = 'application/json' } = {}) {
  const route = routes.get(path);
  const payload = Buffer.from(JSON.stringify(body));
  const req = {
    method: 'POST',
    headers: { 'content-type': contentType },
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

// --- project + tool basics -------------------------------------------------
let who = await callTool({ action: 'whoami' });
check('whoami project', who.project.id === 'workspace-1', who.project?.title);
check('whoami agent', who.agent.sessionId === 'session-1');

// Set the agent to product-manager through the UI route.
let res = await mockHttp('/kanban/action', {
  workspaceId: 'workspace-1',
  action: 'setAgentRole',
  payload: { sessionId: 'session-1', role: 'product-manager' },
});
check('setAgentRole route', res.status === 200 && res.json.ok, String(res.status));

who = await callTool({ action: 'whoami' });
check('role after set', who.agent.role === 'product-manager', who.agent.role);

// Create a ticket as PM (tool).
let created = await callTool({ action: 'create', title: 'Ship login flow', type: 'story', priority: 'high', role: 'fe-developer' });
check('create ticket', created.ticket?.id === 'KB-1', JSON.stringify(created.ticket));

// PM claims backlog ticket -> ready.
let claimed = await callTool({ action: 'claim', ticketId: 'KB-1' });
check('PM claim moves to ready', claimed.ticket?.column === 'ready', claimed.ticket?.column);
await expectThrow('PM cannot claim again (already owned)', () => callTool({ action: 'claim', ticketId: 'KB-1' }), '');

// PM cannot move ready -> in_progress.
await expectThrow('PM role forbidden forward', () => callTool({ action: 'move', ticketId: 'KB-1', column: 'in_progress' }), 'role-forbidden');

// UI user forces the move within one column.
res = await mockHttp('/kanban/action', {
  workspaceId: 'workspace-1',
  action: 'moveTicket',
  payload: { ticketId: 'KB-1', column: 'in_progress' },
});
check('user one-column move', res.status === 200 && res.json.value.ticket.column === 'in_progress', String(res.status));

// Assign the in-progress ticket to the agent so per-agent WIP applies.
res = await mockHttp('/kanban/action', {
  workspaceId: 'workspace-1',
  action: 'assignTicket',
  payload: { ticketId: 'KB-1', sessionId: 'session-1' },
});
check('assign ticket', res.status === 200 && res.json.value.ticket.owner?.sessionId === 'session-1');

// User cannot skip columns.
res = await mockHttp('/kanban/action', {
  workspaceId: 'workspace-1',
  action: 'moveTicket',
  payload: { ticketId: 'KB-1', column: 'done' },
});
check('user skip rejected', res.status === 409 && res.json.error.code === 'ticket/invalid-transition', `${res.status} ${res.json?.error?.code}`);

// Switch agent to frontend dev, release/claim another ticket in ready.
res = await mockHttp('/kanban/action', {
  workspaceId: 'workspace-1',
  action: 'setAgentRole',
  payload: { sessionId: 'session-1', role: 'fe-developer' },
});
check('setAgentRole to fe', res.status === 200);

await expectThrow('fe cannot create tickets', () => callTool({ action: 'create', title: 'Nope' }), 'role-forbidden');

// UI creates a Ready frontend ticket.
res = await mockHttp('/kanban/action', {
  workspaceId: 'workspace-1',
  action: 'createTicket',
  payload: { title: 'Build settings page', type: 'story', priority: 'medium', column: 'ready', role: 'fe-developer' },
});
check('UI createTicket', res.status === 200 && res.json.value.ticket.id === 'KB-2', String(res.status));

// Agent has KB-1 in progress: claiming KB-2 must hit the per-agent WIP limit.
await expectThrow('agent WIP limit', () => callTool({ action: 'claim', ticketId: 'KB-2' }), 'wip-limit');
let released = await callTool({ action: 'release', ticketId: 'KB-1' });
check('release frees agent', released.ticket.column === 'ready' && released.ticket.owner === null, released.ticket.column);

let devClaim = await callTool({ action: 'claim', ticketId: 'KB-2' });
check('fe claim ready -> in progress', devClaim.ticket.column === 'in_progress', devClaim.ticket.column);
let review = await callTool({ action: 'move', ticketId: 'KB-2', column: 'review' });
check('fe raises to review', review.ticket.column === 'review', review.ticket.column);

// Reviewer accepts.
res = await mockHttp('/kanban/action', {
  workspaceId: 'workspace-1',
  action: 'setAgentRole',
  payload: { sessionId: 'session-1', role: 'reviewer' },
});
check('setAgentRole reviewer', res.status === 200);
let done = await callTool({ action: 'move', ticketId: 'KB-2', column: 'done' });
check('reviewer accepts to done', done.ticket.column === 'done', done.ticket.column);

// Pause blocks agent mutations, resume restores.
res = await mockHttp('/kanban/action', { workspaceId: 'workspace-1', action: 'pauseBoard', payload: {} });
check('pause board', res.status === 200 && res.json.value.board.paused === true, String(res.status));
await expectThrow('paused blocks move', () => callTool({ action: 'move', ticketId: 'KB-1', column: 'in_progress' }), 'board-paused');
res = await mockHttp('/kanban/action', { workspaceId: 'workspace-1', action: 'resumeBoard', payload: {} });
check('resume board', res.status === 200 && res.json.value.board.paused === false, String(res.status));

// Scan + import.
res = await mockHttp('/kanban/action', { workspaceId: 'workspace-1', action: 'scan', payload: {} });
check('scan route', res.status === 200, `${res.status} ${JSON.stringify(res.json?.error ?? {})}`);
const scan = res.json.value.scan;
check('scan vision', typeof scan.vision === 'string' && scan.vision.includes('reliable software'), scan.vision?.slice(0, 60));
check('scan docs', scan.docs.length >= 3, String(scan.docs.length));
check('scan candidates', scan.candidates.length >= 5, String(scan.candidates.length));
check('scan skipped node_modules', !scan.candidates.some((c) => c.title.includes('should not appear')));

res = await mockHttp('/kanban/action', { workspaceId: 'workspace-1', action: 'applyScan', payload: {} });
check('applyScan route', res.status === 200, String(res.status));
check('applyScan created', res.json.value.created >= 5, String(res.json.value.created));
check('applyScan idempotent', (await mockHttp('/kanban/action', { workspaceId: 'workspace-1', action: 'applyScan', payload: {} })).json.value.created === 0);

// State snapshot.
res = await mockHttp('/kanban/state', { workspaceId: 'workspace-1' });
check('state route', res.status === 200 && res.json.ok, String(res.status));
const snap = res.json.value;
check('state projects', snap.projects.length === 1 && snap.projects[0].title === 'Demo');
check('state board tickets', snap.board.tickets.length >= 7, String(snap.board.tickets.length));
check('state team lists only attached roster agents', Array.isArray(snap.team) && snap.team.every((row) => typeof row.memberId === 'string'), JSON.stringify(snap.team?.map((m) => m.memberId ?? m.sessionId)));
check('state rules', snap.rules.roles.length === 10 && snap.rules.columns.length === 5, String(snap.rules.roles.length));
check('state snapshot version', snap.version === 3, String(snap.version));
check('state roster seeded', Array.isArray(snap.roster) && snap.roster.length === 10, String(snap.roster?.length));
check('state drafts empty', Array.isArray(snap.drafts) && snap.drafts.length === 0);
check('state rules compact roles', snap.rules.roles.every((role) => typeof role.stepCount === 'number' && Array.isArray(role.definitionOfDone) && !('playbook' in role)));
check('state includes bug-fixer', snap.rules.roles.some((role) => role.id === 'bug-fixer'));
check('prompt section has persona line', typeof promptSection?.text === 'string' && promptSection.text.includes('persona'));
// KB-68 additive schema: the board version is unchanged and the autopilot read
// model rides alongside the existing snapshot shape.
check('state board version is still 3', snap.board.version === 3 && snap.version === 3, `${snap.board.version}/${snap.version}`);
check('state board autopilot envelope is synthesized', snap.board.autopilot?.version === 1 && snap.board.pulses.length === 0, JSON.stringify(snap.board.autopilot?.version));
check('state autopilot read model uses the ticket defaults', snap.autopilot?.config?.enabled === false && snap.autopilot.config.budget.hour === 20 && snap.autopilot.config.budget.day === 60, JSON.stringify(snap.autopilot?.config?.budget));
check('state tickets expose an empty reviews list', snap.board.tickets.every((ticket) => Array.isArray(ticket.reviews) && ticket.reviews.length === 0));

// Board persisted to disk.
const persisted = JSON.parse(await readFile(join(stateDir, 'workspace-1.json'), 'utf8'));
check('board persisted', persisted.tickets.length === snap.board.tickets.length);

console.log('\n' + (failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
await rm(root, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
