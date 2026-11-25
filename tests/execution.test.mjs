import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

// Mock Harness: a workspace, agent factory, session controller, and the tool.
const root = await mkdtemp(join(tmpdir(), 'kanban-exec-'));
const stateDir = await mkdtemp(join(tmpdir(), 'kanban-exec-state-'));
await writeFile(join(root, 'README.md'), '# Demo\n');

const live = new Map();
const prompts = [];
const createdSessions = [];
const permissionSets = [];
const presetMounts = [];
const createCalls = [];
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

const services = {};
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
      return () => {};
    },
  },
  systemPrompt: { section: () => () => {} },
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
      return { items: [] };
    },
    async prompt(request) {
      prompts.push({ sessionId: request.sessionId, text: request.content.map((part) => part.text || '').join('') });
      return { accepted: true };
    },
    cancel() {},
  },
  agents: {
    async create(options) {
      createdSessions.push(options.sessionId);
      createCalls.push(options);
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
  sessionTitle: { rename() {} },
  sessions: { get: () => undefined, flush: async () => {} },
};
services.agentDefaultModel = ctx.agentDefaultModel;
services.sessionTitle = ctx.sessionTitle;
services.sessions = ctx.sessions;
services.permissionPresets = ctx.permissionPresets;
services.agentPresets = ctx.agentPresets;

apply(ctx, { stateDir });

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

async function action(actionName, payload = {}) {
  const route = routes.get('/kanban/action');
  const body = Buffer.from(JSON.stringify({ workspaceId: 'workspace-1', action: actionName, payload }));
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
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

async function state() {
  const route = routes.get('/kanban/state');
  const body = Buffer.from(JSON.stringify({ workspaceId: 'workspace-1' }));
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
}

const tool = tools.get('kanban');
const asAgent = (sessionId) => ({ agent: { id: sessionId } });
const ticketFrom = async (id) => (await state()).board.tickets.find((ticket) => ticket.id === id);

// --- dispatch ---------------------------------------------------------------
const accessState = await state();
check('access catalog exposed', accessState.accessModes?.options?.length === 3, JSON.stringify(accessState.accessModes?.options?.map((option) => option.value)));
// KB-73 access decision: Review runs the test-capable preset (workspace-write)
// because a read-only sandbox cannot execute `node --test` (EPERM mkdtemp in TMPDIR).
check('access suggestion per lane', accessState.accessModes?.suggestions?.ready === 'workspace-write' && accessState.accessModes?.suggestions?.review === 'workspace-write', JSON.stringify(accessState.accessModes?.suggestions));

let res = await action('createTicket', {
  title: 'Execution test ticket',
  description: 'Run the execution pipeline.',
  column: 'ready',
  role: 'fe-developer',
  priority: 'high',
});
check('create ticket', res.status === 200 && res.json.value.ticket.id === 'KB-1', String(res.status));
const executionSession = 'pending';
res = await action('runTicket', { ticketId: 'KB-1', accessMode: 'read-only' });
check('runTicket', res.status === 200, JSON.stringify(res.json?.error));
const runTicket = res.json.value.ticket;
check('execution session linked', typeof runTicket.execution?.sessionId === 'string' && runTicket.execution.status === 'running', JSON.stringify(runTicket.execution));
check('owner is execution session', runTicket.owner?.sessionId === runTicket.execution.sessionId);
check('agent created', createdSessions.includes(runTicket.execution.sessionId));
check('agent preset recorded', createCalls[0]?.meta?.agentPreset === 'default-preset', JSON.stringify(createCalls[0]?.meta));
check('agent preset mounted for tools', presetMounts.includes('default-preset'), JSON.stringify(presetMounts));
check('explicit access mode applied', runTicket.execution.accessMode === 'read-only', runTicket.execution.accessMode);
check('permission preset set', permissionSets.some((entry) => entry.session === runTicket.execution.sessionId && entry.value === 'read-only'), JSON.stringify(permissionSets));
check('prompt sent', prompts.some((entry) => entry.sessionId === runTicket.execution.sessionId && entry.text.includes('Kanban execution')), String(prompts.length));
check('prompt carries ticket', prompts.find((entry) => entry.sessionId === runTicket.execution.sessionId)?.text.includes('KB-1'), '');
const execSessionId = runTicket.execution.sessionId;
live.get(execSessionId).status = 'idle';

// --- scoped tool: whoami / claim / move / finish ---------------------------
const who = JSON.parse(JSON.stringify(await tool.execute({ action: 'whoami' }, asAgent(execSessionId))));
check('whoami scoped', who.executionTicket?.id === 'KB-1', JSON.stringify(who.executionTicket));
await tool.execute({ action: 'claim', ticketId: 'KB-1' }, asAgent(execSessionId));
check('execution claim authorized', (await ticketFrom('KB-1')).column === 'in_progress', (await ticketFrom('KB-1')).column);
let scopedBlocked = false;
try {
  await tool.execute({ action: 'create', title: 'not allowed' }, asAgent(execSessionId));
} catch (error) {
  scopedBlocked = String(error.message).includes('execution-scoped');
}
check('execution cannot create other work', scopedBlocked);
await tool.execute({ action: 'move', ticketId: 'KB-1', column: 'review' }, asAgent(execSessionId));
const inReview = await ticketFrom('KB-1');
check('execution move to review', inReview.column === 'review');
check('auto-assign next lane role', inReview.assignment?.role === 'reviewer', JSON.stringify(inReview.assignment));
await tool.execute({ action: 'finish', ticketId: 'KB-1', summary: 'Execution test complete.' }, asAgent(execSessionId));
const finished = await ticketFrom('KB-1');
check('finish marks done', finished.execution?.status === 'done', String(finished.execution?.status));
check('finish stores report', finished.execution?.report === 'Execution test complete.', finished.execution?.report);

// --- handoff: starting the assigned next role carries previous context ----
res = await action('runTicket', { ticketId: 'KB-1' });
const handoffRun = res.json.value.ticket;
check('handoff start uses reviewer', handoffRun.execution?.role === 'reviewer', handoffRun.execution?.role);
check('handoff carries access mode', handoffRun.execution?.accessMode === 'workspace-write', handoffRun.execution?.accessMode);
check('handoff clears assignment', handoffRun.assignment === null, JSON.stringify(handoffRun.assignment));
const handoffPrompt = prompts[prompts.length - 1];
check('handoff prompt includes report', handoffPrompt.text.includes('Previous agent report') && handoffPrompt.text.includes('Execution test complete.'), handoffPrompt.text.slice(-160));
live.get(handoffRun.execution.sessionId).status = 'idle';

// --- blocked / answer loop -------------------------------------------------
res = await action('createTicket', { title: 'Blocked flow ticket', column: 'ready', role: 'be-developer' });
const blockedId = res.json.value.ticket.id;
res = await action('runTicket', { ticketId: blockedId });
check('default access mode by lane', res.json.value.ticket.execution.accessMode === 'workspace-write', res.json.value.ticket.execution.accessMode);
const blockedSession = res.json.value.ticket.execution.sessionId;
live.get(blockedSession).status = 'running';
const blockResult = JSON.parse(JSON.stringify(await tool.execute({
  action: 'block',
  ticketId: blockedId,
  text: 'Need permission',
  questions: ['Which environment?'],
  needs: [{ kind: 'permission', text: 'Allow production access' }],
}, asAgent(blockedSession))));
check('block via tool', blockResult.questions?.length === 1, JSON.stringify(blockResult.questions));
let blockedTicket = await ticketFrom(blockedId);
check('ticket blocked with questions', blockedTicket.blocked === true && blockedTicket.block?.questions.length === 1, JSON.stringify(blockedTicket.block));
check('execution blocked', blockedTicket.execution?.status === 'blocked', blockedTicket.execution?.status);
res = await action('answerTicket', { ticketId: blockedId, answers: ['Staging'], grant: ['Allow production access'] });
check('answer unblocks', res.status === 200 && (await ticketFrom(blockedId)).blocked === false, String(res.status));
const answerPrompt = prompts[prompts.length - 1];
check('answer prompts session', answerPrompt.sessionId === blockedSession && answerPrompt.text.includes('Which environment?') && answerPrompt.text.includes('Staging'), answerPrompt.text.slice(0, 80));
check('answer grants permission', answerPrompt.text.includes('Permissions granted'));

// --- cancel ----------------------------------------------------------------
res = await action('cancelExecution', { ticketId: blockedId });
check('cancel execution', res.status === 200 && (await ticketFrom(blockedId)).execution?.status === 'cancelled', String(res.status));
check('cancel clears owner', (await ticketFrom(blockedId)).owner === null);

console.log('\n' + (failures.length === 0 ? 'ALL EXECUTION CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
await rm(root, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
