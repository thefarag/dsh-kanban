import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';
import { ROLES, DEFAULT_MEMBERS, ROLE_INDEX } from '../roles.js';

// ---------------------------------------------------------------------------
// Mock Harness factory: one isolated context + state dir per scenario.
// ---------------------------------------------------------------------------

async function createHarness({ label = 'kanban-team', workspaceId = 'workspace-1', agentsEnabled = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), `${label}-`));
  const stateDir = await mkdtemp(join(tmpdir(), `${label}-state-`));
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Demo\n');
  const workspace = {
    id: workspaceId,
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
  const sessions = [];
  const live = new Map();
  const prompts = [];
  const createdAgents = [];
  const presetMounts = [];
  const permissionSets = [];
  const cancelled = [];
  const services = {};
  const routes = new Map();
  const tools = new Map();
  let promptSection = null;
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
        return () => {};
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
    sessionController: {
      async list() {
        return { items: sessions };
      },
      cancel(request) {
        cancelled.push(request?.sessionId);
        return { accepted: true };
      },
      async prompt(request) {
        prompts.push({ sessionId: request.sessionId, text: request.content.map((part) => part.text || '').join('') });
        return { accepted: true };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    permissionPresets: {
      catalog: () => ({
        options: [
          { value: 'read-only', name: 'Read only' },
          { value: 'workspace-write', name: 'Workspace write' },
          { value: 'danger-full-access', name: 'Full access' },
        ],
      }),
      resolve: (value) => ({ sandbox: value }),
      set: (session, value) => permissionSets.push({ session: session.id, value }),
    },
    sessionTitle: { rename() {} },
    agentPresets: { resolve: async () => ({ id: 'preset' }), mount: async () => {} },
  };
  if (agentsEnabled) {
    ctx.agents = {
      async create(options) {
        createdAgents.push(options);
        if (typeof options.setup === 'function') {
          await options.setup({ effect: () => () => {} }, { id: options.sessionId });
          presetMounts.push(options.sessionId);
        }
        live.set(options.sessionId, { id: options.sessionId, status: 'running', session: { id: options.sessionId }, inbox: { hasPending: false } });
        sessions.push({
          sessionId: options.sessionId,
          cwd: options.meta?.cwd ?? root,
          running: true,
          updatedAt: Date.now(),
          projections: { values: { title: 'Drafting session' } },
        });
        return { agent: { id: options.sessionId, session: { id: options.sessionId } } };
      },
      get(id) {
        return live.get(id);
      },
      list() {
        return [...live.values()];
      },
    };
  }
  services.agentDefaultModel = ctx.agentDefaultModel;
  services.agents = ctx.agents;
  services.permissionPresets = ctx.permissionPresets;
  services.sessionTitle = ctx.sessionTitle;
  services.agentPresets = ctx.agentPresets;
  services.sessions = { get: () => undefined };
  apply(ctx, { stateDir });

  const harness = { root, stateDir, workspace, sessions, live, prompts, createdAgents, presetMounts, permissionSets, cancelled, ctx, routes, tools, promptSection };
  harness.action = async (name, payload = {}) => {
    const route = routes.get('/kanban/action');
    const body = Buffer.from(JSON.stringify({ workspaceId, action: name, payload }));
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    };
    const res = {
      statusCode: 0,
      setHeader() {},
      body: '',
      end(text) {
        this.body = text ?? '';
      },
    };
    await route.handler(req, res);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };
  harness.state = async () => {
    const route = routes.get('/kanban/state');
    const body = Buffer.from(JSON.stringify({ workspaceId }));
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    };
    const res = {
      statusCode: 0,
      setHeader() {},
      body: '',
      end(text) {
        this.body = text ?? '';
      },
    };
    await route.handler(req, res);
    return JSON.parse(res.body).value;
  };
  harness.tool = tools.get('kanban');
  harness.asAgent = (sessionId) => ({ agent: { id: sessionId } });
  harness.cleanup = async () => {
    await rm(root, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  };
  return harness;
}

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const expectStatus = (label, result, status, code) => {
  const okStatus = result.status === status;
  const okCode = code === undefined || result.json?.error?.code === code;
  check(label, okStatus && okCode, `${result.status} ${result.json?.error?.code ?? ''}`);
};

const h = await createHarness();

// --- seeding + snapshot contract -------------------------------------------
let snap = await h.state();
check('snapshot version 2', snap.version === 2, String(snap.version));
check('rng seededAt persisted', Number.isFinite(snap.board?.team?.seededAt), String(snap.board?.team?.seededAt));
check('roster seeded with 10', snap.roster?.length === 10, String(snap.roster?.length));
check(
  'roster ids deterministic',
  snap.roster.every((row) => row.id === `member-${row.roleId}`),
  snap.roster.map((row) => row.id).join(','),
);
check('roster one member per role', new Set(snap.roster.map((row) => row.roleId)).size === 10);
check('roster starts offline', snap.roster.every((row) => row.status === 'offline'), JSON.stringify(snap.roster.map((row) => row.status)));
check('roster rows explain their status', snap.roster.every((row) => typeof row.statusReason === 'string' && row.statusReason.length > 0), snap.roster.map((row) => row.statusReason).slice(0, 3).join('|'));
check('roster has personas', snap.roster.every((row) => typeof row.persona === 'string' && row.persona.length > 200));
check('drafts empty', Array.isArray(snap.drafts) && snap.drafts.length === 0);
check('rules roles 10', snap.rules.roles.length === 10, String(snap.rules.roles.length));
check('rules compact (no playbook)', !('playbook' in snap.rules.roles[0]), Object.keys(snap.rules.roles[0]).join(','));
check(
  'rules roles compact fields',
  snap.rules.roles.every((role) => typeof role.summary === 'string' && Array.isArray(role.claimColumns) && typeof role.stepCount === 'number' && Array.isArray(role.definitionOfDone) && role.definitionOfDone.length >= 6),
);
check('bug-fixer role exposed', snap.rules.roles.some((role) => role.id === 'bug-fixer'));
check(
  'roster names unique',
  new Set(snap.roster.map((row) => row.name.toLowerCase())).size === 10,
  snap.roster.map((row) => row.name).join(','),
);
check(
  'roster role names',
  snap.roster.every((row) => ROLE_INDEX[row.roleId] && row.roleName === ROLE_INDEX[row.roleId].name),
);

// --- name validation / CRUD -------------------------------------------------
let res = await h.action('createMember', { name: '  Zoe Quinn  ', title: 'QA Partner', roleId: 'tester' });
check('createMember valid', res.status === 200 && res.json.value.member.name === 'Zoe Quinn', JSON.stringify(res.json?.error));
const zoe = res.json.value.member;
check('member defaults', zoe.source === 'manual' && zoe.paused === false && zoe.sessionId === null && zoe.persona.length > 200, JSON.stringify({ source: zoe.source, persona: zoe.persona.length }));
expectStatus('duplicate name rejected (case-insensitive)', await h.action('createMember', { name: 'zoe quinn', roleId: 'tester' }), 409, 'member/name-taken');
expectStatus('invalid role rejected', await h.action('createMember', { name: 'No Role', roleId: 'wizard' }), 400, 'member/role-invalid');
expectStatus('empty name rejected', await h.action('createMember', { name: '   ', roleId: 'tester' }), 400, 'bad-request');
res = await h.action('createMember', { name: 'Max Title', roleId: 'sre', title: 'x'.repeat(90) });
check('title clamped to 60', res.status === 200 && res.json.value.member.title.length === 60, String(res.json.value.member.title?.length));
res = await h.action('updateMember', { memberId: zoe.id, patch: { name: 'Zoe Quinn-Reyes', title: 'QA Lead', roleId: 'reviewer', persona: 'You are a relentless reviewer.' } });
check('updateMember patch', res.status === 200 && res.json.value.member.name === 'Zoe Quinn-Reyes' && res.json.value.member.roleId === 'reviewer' && res.json.value.member.persona === 'You are a relentless reviewer.', JSON.stringify(res.json?.error));
expectStatus('update to duplicate name rejected', await h.action('updateMember', { memberId: zoe.id, patch: { name: 'Kareem Koshary' } }), 409, 'member/name-taken');
expectStatus('update unknown member 404', await h.action('updateMember', { memberId: 'member-nope', patch: { name: 'X Y' } }), 404, 'member/not-found');
expectStatus('delete unknown member 404', await h.action('deleteMember', { memberId: 'member-nope' }), 404, 'member/not-found');
res = await h.action('updateMember', { memberId: zoe.id, patch: { paused: true } });
check('member paused', res.status === 200 && res.json.value.member.paused === true);
snap = await h.state();
check('paused member status', snap.roster.find((row) => row.id === zoe.id)?.status === 'paused');
res = await h.action('updateMember', { memberId: zoe.id, patch: { paused: false, persona: '' } });
check('empty persona restored to template', res.status === 200 && res.json.value.member.persona.length > 200);

// --- role detail + composed prompt -----------------------------------------
res = await h.action('roleDetail', { roleId: 'bug-fixer' });
check('roleDetail bug-fixer', res.status === 200 && res.json.value.role.playbook.steps.length === 11 && res.json.value.role.playbook.definitionOfDone.length >= 6, JSON.stringify(res.json?.error));
expectStatus('roleDetail invalid role', await h.action('roleDetail', { roleId: 'wizard' }), 400, 'member/role-invalid');
res = await h.action('memberPrompt', { memberId: zoe.id });
const zoeMember = (await h.state()).roster.find((row) => row.id === zoe.id);
check(
  'memberPrompt composes playbook + persona',
  res.status === 200 &&
    res.json.value.prompt.includes(zoeMember.persona) &&
    res.json.value.prompt.includes('Reviewer') &&
    res.json.value.prompt.includes('Definition of Done'),
  JSON.stringify(res.json?.error),
);
expectStatus('memberPrompt unknown member', await h.action('memberPrompt', { memberId: 'member-nope' }), 404, 'member/not-found');

// --- roster limit -----------------------------------------------------------
let limitHit = null;
for (let index = 0; index < 60; index += 1) {
  const created = await h.action('createMember', { name: `Roster Person ${index}`, roleId: 'tester' });
  if (created.status === 409) {
    limitHit = created.json.error.code;
    break;
  }
}
check('roster capped at 50', limitHit === 'member/limit', String(limitHit));

// --- AI drafting -------------------------------------------------------------
const h2 = await createHarness({ label: 'kanban-team-draft' });
res = await h2.action('draftMember', { description: 'A backend dev who lives for migrations', roleId: 'be-developer' });
check('draftMember ai path', res.status === 200 && res.json.value.source === 'ai' && res.json.value.draft.status === 'drafting', JSON.stringify(res.json?.error));
const draft = res.json.value.draft;
check('draft session created', typeof draft.sessionId === 'string' && h2.createdAgents.some((agent) => agent.sessionId === draft.sessionId));
check('draft agent read-only', h2.permissionSets.some((entry) => entry.session === draft.sessionId && entry.value === 'read-only'));
check('draft agent mounts the project preset', h2.presetMounts.includes(draft.sessionId) && h2.createdAgents.some((agent) => agent.sessionId === draft.sessionId && agent.meta?.agentPreset === 'preset'));
check('draft agent carries a model selection', h2.createdAgents.some((agent) => agent.sessionId === draft.sessionId && agent.agentOptions?.provider === 'deepseek' && agent.agentOptions?.model === 'deepseek-chat'));
const draftPrompt = h2.prompts.find((entry) => entry.sessionId === draft.sessionId);
check('draft prompt asks for create_member', Boolean(draftPrompt) && draftPrompt.text.includes('create_member'));
snap = await h2.state();
check('draft visible in snapshot', snap.drafts.length === 1 && snap.drafts[0].status === 'drafting');
check('drafting session hidden from team rows', !snap.team.some((row) => row.sessionId === draft.sessionId), JSON.stringify(snap.team.map((row) => row.sessionId)));
res = await h2.tool.execute({ action: 'create_member', name: 'Dana Whitfield', title: 'Staff Backend Engineer', role: 'be-developer', persona: 'You are Dana, a migration-obsessed backend engineer.' }, h2.asAgent(draft.sessionId));
check('drafting tool creates member', Boolean(res?.member) && res.member.source === 'ai', JSON.stringify(res));
snap = await h2.state();
check('draft cleared after member', snap.drafts.length === 0, JSON.stringify(snap.drafts));
check('member landed on roster', snap.roster.some((row) => row.name === 'Dana Whitfield' && row.source === 'ai'));
// Draft concurrent limit.
const h3 = await createHarness({ label: 'kanban-team-draft-limit' });
const first = await h3.action('draftMember', { description: 'first' });
const second = await h3.action('draftMember', { description: 'second' });
const third = await h3.action('draftMember', { description: 'third' });
check('three drafts allowed', [first, second, third].every((entry) => entry.status === 200), JSON.stringify([first.status, second.status, third.status]));
expectStatus('fourth draft rejected', await h3.action('draftMember', { description: 'fourth' }), 409, 'draft/limit');
const cancel = await h3.action('cancelDraft', { draftId: first.json.value.draft.id });
check('cancelDraft', cancel.status === 200 && h3.cancelled.includes(first.json.value.draft.sessionId));
snap = await h3.state();
check('cancelled draft retained as row', snap.drafts.some((entry) => entry.id === first.json.value.draft.id && entry.status === 'cancelled'));
const dismiss = await h3.action('cancelDraft', { draftId: first.json.value.draft.id });
check('dismiss cancelled draft', dismiss.status === 200 && (await h3.state()).drafts.every((entry) => entry.id !== first.json.value.draft.id));
// Tool permission: a normal agent may not create members.
let forbidden = false;
try {
  await h3.tool.execute({ action: 'create_member', name: 'Sneaky Person', role: 'tester' }, h3.asAgent('session-normal'));
} catch (error) {
  forbidden = String(error.message).includes('role-forbidden');
}
check('non-lead cannot create members via tool', forbidden);
// A non-lead agent cannot hijack another session's draft by passing its draftId.
let draftHijack = false;
try {
  await h3.tool.execute({ action: 'create_member', name: 'Hijack Person', role: 'tester', draftId: second.json.value.draft.id }, h3.asAgent('session-normal'));
} catch (error) {
  draftHijack = String(error.message).includes('role-forbidden');
}
check('non-lead cannot create from another draft', draftHijack);

// --- template fallback when the agents service is unavailable ---------------
const h4 = await createHarness({ label: 'kanban-team-template', agentsEnabled: false });
res = await h4.action('draftMember', { description: 'A bug hunter', roleId: 'bug-fixer' });
check('template fallback returns member', res.status === 200 && res.json.value.source === 'template' && Boolean(res.json.value.member), JSON.stringify(res.json?.error));
check('template member source ai', res.json.value.member.source === 'ai');
snap = await h4.state();
check('template member on roster', snap.roster.some((row) => row.name === res.json.value.member.name));
check('template draft labelled', snap.drafts.some((entry) => entry.mode === 'template' && entry.status === 'failed'));

// --- member / status / dispatch linkage -------------------------------------
const h5 = await createHarness({ label: 'kanban-team-link' });
h5.sessions.push({
  sessionId: 'session-ada',
  cwd: h5.root,
  running: false,
  updatedAt: Date.now(),
  projections: { values: { title: 'Zizi Zaatar' } },
});
res = await h5.action('createTicket', { title: 'Fix crash on save', column: 'ready', role: 'bug-fixer', type: 'bug' });
const bugTicketId = res.json.value.ticket.id;
const who = JSON.parse(JSON.stringify(await h5.tool.execute({ action: 'whoami' }, h5.asAgent('session-ada'))));
check('session adopted roster member by name', who.agent.memberId === 'member-bug-fixer' && who.agent.memberName === 'Zizi Zaatar', JSON.stringify({ id: who.agent.memberId }));
check('whoami returns role playbook', typeof who.rolePlaybook === 'string' && who.rolePlaybook.includes('Definition of Done') && who.playbook.steps.length === 11);
check('whoami returns persona', typeof who.persona === 'string' && who.persona.includes('You are'));
snap = await h5.state();
check('idle member status after link', snap.roster.find((row) => row.id === 'member-bug-fixer')?.status === 'idle', snap.roster.find((row) => row.id === 'member-bug-fixer')?.status);
// Dispatch the bug ticket from the board (user action) to a member.
await h5.action('runTicket', { ticketId: bugTicketId });
snap = await h5.state();
check('dispatched member linked to session', typeof snap.roster.find((row) => row.id === 'member-bug-fixer')?.sessionId === 'string');
// Explicit member dispatch for review lane is role-forbidden.
res = await h5.action('createTicket', { title: 'Review this', column: 'review', role: 'reviewer' });
const reviewId = res.json.value.ticket.id;
expectStatus(
  'explicit member role gated by lane',
  await h5.action('runTicket', { ticketId: reviewId, memberId: 'member-bug-fixer' }),
  403,
  'ticket/role-forbidden',
);
// Claim through the member's own scoped session -> working.
const dispatched = (await h5.state()).board.tickets.find((ticket) => ticket.id === bugTicketId);
const execSession = dispatched.execution.sessionId;
await h5.tool.execute({ action: 'claim', ticketId: bugTicketId }, h5.asAgent(execSession));
snap = await h5.state();
check('working status while owning in-progress ticket', snap.roster.find((row) => row.id === 'member-bug-fixer')?.status === 'working', snap.roster.find((row) => row.id === 'member-bug-fixer')?.status);
check('current ticket recorded', snap.roster.find((row) => row.id === 'member-bug-fixer')?.currentTicket?.id === bugTicketId);
check('since recorded', Number.isFinite(snap.roster.find((row) => row.id === 'member-bug-fixer')?.since));
// Paused overrides working.
res = await h5.action('updateMember', { memberId: 'member-bug-fixer', patch: { paused: true } });
snap = await h5.state();
check('paused overrides working', snap.roster.find((row) => row.id === 'member-bug-fixer')?.status === 'paused');
check('pause cancels linked session', h5.cancelled.includes(execSession), JSON.stringify(h5.cancelled));
await h5.action('updateMember', { memberId: 'member-bug-fixer', patch: { paused: false } });
// Busy member cannot be deleted without force.
res = await h5.action('deleteMember', { memberId: 'member-bug-fixer' });
expectStatus('busy member delete rejected', res, 409, 'member/busy');
res = await h5.action('deleteMember', { memberId: 'member-bug-fixer', force: true });
check('force delete removes member', res.status === 200 && (await h5.state()).roster.every((row) => row.id !== 'member-bug-fixer'));
check('force delete cleared owner memberId', (await h5.state()).board.tickets.every((ticket) => ticket.owner?.memberId !== 'member-bug-fixer'));

// --- v1 migration + no reseed ----------------------------------------------
const v1root = await mkdtemp(join(tmpdir(), 'kanban-team-v1-'));
const v1state = await mkdtemp(join(tmpdir(), 'kanban-team-v1-state-'));
const now = Date.now();
const v1board = {
  version: 1,
  workspaceId: 'workspace-v1',
  projectTitle: 'Old',
  projectPath: v1root,
  createdAt: now - 100000,
  updatedAt: now - 5000,
  paused: true,
  pausedAt: now - 4000,
  pausedBy: 'You',
  wip: { backlog: 0, ready: 0, in_progress: 2, review: 4, done: 0 },
  nextNumber: 7,
  tickets: [
    {
      id: 'KB-3',
      number: 3,
      title: 'Legacy ticket',
      description: 'Kept through migration.',
      type: 'story',
      priority: 'high',
      column: 'in_progress',
      role: 'fe-developer',
      labels: ['legacy'],
      owner: { sessionId: 'session-old', name: 'Old Agent', role: 'fe-developer' },
      blocked: false,
      blockReason: '',
      checklist: [{ id: 'c1', text: 'Kept checklist', done: true }],
      comments: [{ id: 'm1', author: 'Old Agent', text: 'Kept comment', at: now - 2000 }],
      source: null,
      createdAt: now - 90000,
      updatedAt: now - 3000,
      movedAt: now - 3000,
      acceptedAt: null,
      activity: [{ id: 'a1', at: now - 3000, by: 'Old Agent', action: 'create', text: 'Kept activity' }],
    },
  ],
  activity: [{ id: 'ba1', at: now - 5000, by: 'You', kind: 'ticket/create', ticketId: 'KB-3', text: 'Legacy board activity' }],
  agents: { 'session-old': { name: 'Old Agent', role: 'fe-developer', paused: false, firstSeenAt: now - 80000 } },
  meta: { vision: 'Legacy vision', docs: [{ path: 'docs/VISION.md', title: 'Vision', kind: 'vision', bytes: 10 }], conversations: [], mrs: [], lastScanAt: now - 6000 },
};
await writeFile(join(v1state, 'workspace-v1.json'), JSON.stringify(v1board));
const { apply: applyAgain } = await import('../index.js');
const v1workspace = {
  id: 'workspace-v1',
  title: 'Legacy',
  path: v1root,
  sessionIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  async attachSession() {},
  async status() {
    return 'ok';
  },
};
function buildMigrationHarness() {
  const routes = new Map();
  const services = {};
  const ctx = {
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    on() { return () => {}; },
    get(name) { return services[name]; },
    provide(name, value) { services[name] = value; return () => {}; },
    webServer: { register(route) { routes.set(route.path, route); return () => {}; } },
    tools: { register() { return () => {}; } },
    systemPrompt: { section() { return () => {}; } },
    connection: { requestRejection: () => undefined },
    workspaceRegistry: { list: () => [v1workspace] },
    sessionPersistence: { async list() { return []; }, async open() { return { async read() { return { events: [] }; }, async close() {} }; }, async stat() { return undefined; } },
    sessionController: { async list() { return { items: [] }; }, cancel() {}, async prompt() { return { accepted: true }; } },
    agents: { get: () => undefined, list: () => [], async create() { throw new Error('no agents in migration test'); } },
    permissionPresets: { catalog: () => ({ options: [] }), resolve: (value) => ({ sandbox: value }), set() {} },
    sessionTitle: { rename() {} },
    agentPresets: { resolve: async () => ({ id: 'preset' }), mount: async () => {} },
  };
  applyAgain(ctx, { stateDir: v1state });
  return {
    async action(name, payload = {}) {
      const route = routes.get('/kanban/action');
      const body = Buffer.from(JSON.stringify({ workspaceId: 'workspace-v1', action: name, payload }));
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield body; } };
      const res = { statusCode: 0, setHeader() {}, body: '', end(text) { this.body = text ?? ''; } };
      await route.handler(req, res);
      return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
    },
    async state() {
      const route = routes.get('/kanban/state');
      const body = Buffer.from(JSON.stringify({ workspaceId: 'workspace-v1' }));
      const req = { method: 'POST', headers: { 'content-type': 'application/json' }, async *[Symbol.asyncIterator]() { yield body; } };
      const res = { statusCode: 0, setHeader() {}, body: '', end(text) { this.body = text ?? ''; } };
      await route.handler(req, res);
      return JSON.parse(res.body).value;
    },
  };
}
const migration = buildMigrationHarness();
let migrated = await migration.state();
check('v1 board migrates to v2', migrated.version === 2 && migrated.board?.version === 2, String(migrated.board?.version));
check('v1 tickets preserved', migrated.board.tickets.length === 1 && migrated.board.tickets[0].id === 'KB-3');
check('v1 checklist preserved', migrated.board.tickets[0].checklist?.[0]?.text === 'Kept checklist');
check('v1 comments preserved', migrated.board.tickets[0].comments?.[0]?.text === 'Kept comment');
check('v1 ticket activity preserved', migrated.board.tickets[0].activity?.[0]?.text === 'Kept activity');
check('v1 board activity preserved', migrated.board.activity?.[0]?.text === 'Legacy board activity');
check('v1 agents preserved', migrated.board.agents['session-old']?.name === 'Old Agent');
check('v1 meta preserved', migrated.board.meta?.vision === 'Legacy vision');
check('v1 wip preserved', migrated.board.wip.in_progress === 2 && migrated.board.wip.review === 4, JSON.stringify(migrated.board.wip));
check('v1 pause preserved', migrated.board.paused === true && migrated.board.pausedBy === 'You');
check('v1 nextNumber preserved', migrated.board.nextNumber === 7, String(migrated.board.nextNumber));
check('migrated board seeded roster', migrated.roster?.length === 10, String(migrated.roster?.length));
const onDisk = JSON.parse(await readFile(join(v1state, 'workspace-v1.json'), 'utf8'));
check('migration persisted to disk', onDisk.version === 2 && onDisk.team?.members?.length === 10 && onDisk.tickets?.[0]?.id === 'KB-3', String(onDisk.version));
// Delete everyone, then reload: seed must not come back.
for (const member of migrated.roster) {
  await migration.action('deleteMember', { memberId: member.id, force: true });
}
check('all members deletable', (await migration.state()).roster.length === 0);
const reloaded = buildMigrationHarness();
const reloadedState = await reloaded.state();
check('deleted roster is not re-seeded', reloadedState.roster.length === 0, String(reloadedState.roster.length));
check('seededAt retained after deletion', Number.isFinite(reloadedState.board.team.seededAt));
// Create a member after deletion: no reseed, new member only.
const afterDelete = await reloaded.action('createMember', { name: 'Only Person', roleId: 'tester' });
check('create after delete', afterDelete.status === 200 && (await reloaded.state()).roster.length === 1);

// --- system prompt + skill drift -------------------------------------------
check('system prompt has persona line', typeof h.promptSection?.text === 'string' && h.promptSection.text.includes('whoami') && h.promptSection.text.includes('persona'));
check('system prompt lists 10 roles', ROLES.every((role) => h.promptSection.text.includes(role.id)), 'missing role id');
check(
  'bug-fixer in transitions',
  (await h.state()).rules.transitions
    .filter((transition) => transition.from === 'ready' && transition.to === 'in_progress')
    .some((transition) => transition.allowedRoles.includes('bug-fixer')),
);
check(
  'bug-fixer cannot accept review',
  (await h.state()).rules.transitions
    .filter((transition) => transition.to === 'done')
    .every((transition) => !transition.allowedRoles.includes('bug-fixer')),
);

await h.cleanup();
await h2.cleanup();
await h3.cleanup();
await h4.cleanup();
await h5.cleanup();
await rm(v1root, { recursive: true, force: true });
await rm(v1state, { recursive: true, force: true });

console.log('\n' + (failures.length === 0 ? 'ALL TEAM CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
process.exit(failures.length === 0 ? 0 : 1);
