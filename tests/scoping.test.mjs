import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

// Nested workspaces: <parent>/child must not leak sessions or team members into
// the parent, and the default project must be the one owning the newest session.
const parent = await mkdtemp(join(tmpdir(), 'kanban-parent-'));
const child = join(parent, 'child');
await mkdir(join(child, 'docs'), { recursive: true });
await writeFile(join(parent, 'README.md'), '# Parent\n');
await writeFile(join(child, 'docs', 'VISION.md'), '# Child Vision\nChild product.\n');

const stateDir = await mkdtemp(join(tmpdir(), 'kanban-state-'));
const workspaces = [
  {
    id: 'workspace-parent',
    title: 'Parent',
    path: parent,
    sessionIds: ['session-parent'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'workspace-child',
    title: 'Child',
    path: child,
    sessionIds: ['session-child'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];
const now = Date.now();
const sessions = [
  { sessionId: 'session-parent', cwd: parent, running: false, updatedAt: now - 60_000, projections: { values: { title: 'Parent work' } } },
  { sessionId: 'session-child', cwd: child, running: false, updatedAt: now, projections: { values: { title: 'Child work' } } },
];

const routes = new Map();
const services = {};
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
  tools: { register: () => () => {} },
  systemPrompt: { section: () => () => {} },
  connection: { requestRejection: () => undefined },
  workspaceRegistry: { list: () => workspaces },
  sessionController: { async list() { return { items: sessions }; }, cancel() {}, async prompt() {} },
  sessionPersistence: {
    async list() { return []; },
    async open() { return { async read() { return { events: [] }; }, async close() {} }; },
    async stat() { return undefined; },
  },
  agents: { list: () => [], get: () => undefined },
};

apply(ctx, { stateDir });

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

async function state(workspaceId) {
  const route = routes.get('/kanban/state');
  const payload = Buffer.from(JSON.stringify(workspaceId ? { workspaceId } : {}));
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      yield payload;
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

const parentState = await state('workspace-parent');
check('parent exists', parentState.project.id === 'workspace-parent');
check('parent sessions exclude child session', parentState.sessions.every((row) => row.sessionId !== 'session-child'), JSON.stringify(parentState.sessions.map((row) => row.sessionId)));
check(
  'parent project counts exclude child session',
  parentState.projects.find((project) => project.id === 'workspace-parent').sessionCount === 1,
  String(parentState.projects.find((project) => project.id === 'workspace-parent').sessionCount),
);
check(
  'child project counts its own session',
  parentState.projects.find((project) => project.id === 'workspace-child').sessionCount === 1,
  String(parentState.projects.find((project) => project.id === 'workspace-child').sessionCount),
);

const childState = await state('workspace-child');
check('child sessions include child session', childState.sessions.some((row) => row.sessionId === 'session-child'), JSON.stringify(childState.sessions.map((row) => row.sessionId)));
check('team rows are attached roster agents only', childState.team.every((row) => typeof row.memberId === 'string'), JSON.stringify(childState.team));
check('child sessions exclude parent session', childState.sessions.every((row) => row.sessionId !== 'session-parent'));

const defaultState = await state(undefined);
check('default project is newest session owner', defaultState.project.id === 'workspace-child', defaultState.project.id);

console.log('\n' + (failures.length === 0 ? 'ALL SCOPING CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
await rm(parent, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
