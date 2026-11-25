import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

// KB-3 — EPIC data model and parent linking.
//
// Covers the v3 contract end to end against the real host (`apply`), not
// helpers: v1/v2 fixture migration (fields preserved, one-time rewrite,
// idempotent second load, nextNumber continues), v3 persistence/restart,
// corrupt/unknown-version degradation, epic create/forced-Backlog, move /
// claim / run rejection with stable codes and an unchanged board, parent
// validation (missing/non-EPIC/self/EPIC-with-parent/empty/clear), no dangling
// parents (delete guard + read-time repair with a recorded board note), and
// snapshot additivity.

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const brief = (value) => {
  const text = JSON.stringify(value);
  return (typeof text === 'string' ? text : String(value)).slice(0, 220);
};

const freshRoot = async (prefix = 'kanban-epic-root-') => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(dir, 'README.md'), '# Epic lab\n');
  return dir;
};
const freshState = (prefix = 'kanban-epic-state-') => mkdtemp(join(tmpdir(), prefix));
const boardPath = (stateDir, workspaceId = 'workspace-1') => join(stateDir, `${workspaceId}.json`);
const writeBoard = async (stateDir, workspaceId, board) => {
  await mkdir(stateDir, { recursive: true });
  await writeFile(boardPath(stateDir, workspaceId), JSON.stringify(board));
};

/**
 * One booted host with its own fake Harness services. `workspaceId` lets a
 * fixture be named workspace-v1 so the persisted file matches it.
 */
function makeApp({ stateDir, root, workspaceId = 'workspace-1' }) {
  const workspace = {
    id: workspaceId,
    title: 'Epic Lab',
    path: root,
    sessionIds: ['session-1'],
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
  const sessionItems = [
    {
      sessionId: 'session-1',
      cwd: root,
      running: false,
      updatedAt: Date.now(),
      projections: { values: { title: 'Epic lab session' } },
    },
  ];
  const ctx = {
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
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
        return [{ header: { id: 'session-1', cwd: root, createdAt: Date.now() }, eventCount: 0, revision: 'r1' }];
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
      cancel() {},
      async prompt() {
        return { accepted: true };
      },
    },
    agents: {
      get: () => undefined,
      list: () => [],
      async create() {
        throw new Error('no agent sessions in the epic test harness');
      },
    },
    permissionPresets: {
      catalog: () => ({
        options: [
          { value: 'read-only', name: 'Read only' },
          { value: 'workspace-write', name: 'Workspace write' },
          { value: 'danger-full-access', name: 'Full access' },
        ],
        defaultOptions: [],
        defaultPreset: 'workspace-write',
      }),
      resolve: (value) => ({ sandbox: value }),
      set() {},
    },
    sessionTitle: { rename() {} },
    agentPresets: { resolve: async () => ({ id: 'preset' }), mount: async () => {} },
  };
  apply(ctx, { stateDir, wipInProgress: 3, wipReview: 5 });

  const request = async (path, body) => {
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
      setHeader(key, value) {
        this.headers[key] = value;
      },
      end(text) {
        this.body = text ?? '';
      },
    };
    await route.handler(req, res);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };

  return {
    workspaceId,
    tool: (args) => tools.get('kanban').execute(args, { agent: { id: 'session-1' } }),
    state: async () => {
      const res = await request('/kanban/state', { workspaceId });
      return res.json.value;
    },
    rawState: () => request('/kanban/state', { workspaceId }),
    action: (action, payload = {}) => request('/kanban/action', { workspaceId, action, payload }),
  };
}

const expectError = async (label, fn, status, code) => {
  try {
    const res = await fn();
    check(label, res.status === status && res.json?.error?.code === code, `${res.status} ${brief(res.json?.error)}`);
  } catch (error) {
    check(label, false, `threw ${error instanceof Error ? error.message : String(error)}`);
  }
};
const expectToolError = async (label, fn, code) => {
  try {
    await fn();
    check(label, false, 'no throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, message.includes(`kanban/${code}`), message.slice(0, 160));
  }
};
const ticketOf = (snap, id) => snap.board.tickets.find((ticket) => ticket.id === id) ?? null;

async function setRole(app, role) {
  const res = await app.action('setAgentRole', { sessionId: 'session-1', role });
  check(`set role ${role}`, res.status === 200, `${res.status} ${brief(res.json?.error)}`);
}

// ---------------------------------------------------------------------------
// Legacy fixtures (v1 and v2) + one-time migration
// ---------------------------------------------------------------------------
// Fixed timestamps so the content comparison is deterministic.
const T = 1_760_000_000_000;

function legacyTicket(overrides = {}) {
  return {
    id: 'KB-3',
    number: 3,
    title: 'Legacy ticket',
    description: 'Kept through migration.',
    type: 'bug',
    priority: 'critical',
    column: 'in_progress',
    role: 'be-developer',
    labels: ['legacy', 'schema'],
    owner: { sessionId: 'session-old', name: 'Old Agent', role: 'be-developer' },
    blocked: false,
    blockReason: '',
    checklist: [
      { id: 'c1', text: 'Kept checklist', done: true },
      { id: 'c2', text: 'Second item', done: false },
    ],
    comments: [{ id: 'm1', author: 'Old Agent', text: 'Kept comment', at: T - 2000 }],
    source: { kind: 'manual', ref: 'legacy.md' },
    createdAt: T - 90_000,
    updatedAt: T - 3000,
    movedAt: T - 3000,
    acceptedAt: null,
    activity: [{ id: 'a1', at: T - 3000, by: 'Old Agent', action: 'create', text: 'Kept ticket activity' }],
    ...overrides,
  };
}

function v1Fixture(root) {
  return {
    version: 1,
    workspaceId: 'workspace-v1',
    projectTitle: 'Old v1',
    projectPath: root,
    createdAt: T - 100_000,
    updatedAt: T - 5000,
    paused: true,
    pausedAt: T - 4000,
    pausedBy: 'You',
    wip: { backlog: 1, ready: 2, in_progress: 2, review: 4, done: 0 },
    nextNumber: 7,
    tickets: [legacyTicket()],
    activity: [
      { id: 'ba1', at: T - 5000, by: 'You', kind: 'ticket/create', ticketId: 'KB-3', text: 'Legacy v1 board activity' },
    ],
    agents: { 'session-old': { name: 'Old Agent', role: 'be-developer', paused: false, firstSeenAt: T - 80_000 } },
    meta: {
      vision: 'Legacy v1 vision',
      docs: [{ path: 'docs/VISION.md', title: 'Vision', kind: 'vision', bytes: 10 }],
      conversations: [],
      mrs: [],
      lastScanAt: T - 6000,
    },
  };
}

function v2Fixture(root) {
  return {
    version: 2,
    workspaceId: 'workspace-v2',
    projectTitle: 'Old v2',
    projectPath: root,
    createdAt: T - 200_000,
    updatedAt: T - 9000,
    paused: false,
    pausedAt: null,
    pausedBy: null,
    wip: { backlog: 2, ready: 3, in_progress: 3, review: 5, done: 0 },
    nextNumber: 5,
    tickets: [
      legacyTicket({ thoughtId: 'TH-9' }),
      {
        id: 'KB-4',
        number: 4,
        title: 'Legacy v2 child-shaped ticket',
        description: 'No parent in v2.',
        type: 'task',
        priority: 'medium',
        column: 'ready',
        role: null,
        labels: [],
        owner: null,
        blocked: true,
        blockReason: 'waiting on a decision',
        checklist: [],
        comments: [],
        source: null,
        createdAt: T - 20_000,
        updatedAt: T - 10_000,
        movedAt: T - 10_000,
        acceptedAt: null,
        activity: [],
      },
    ],
    activity: [
      { id: 'ba2', at: T - 9000, by: 'Old Agent', kind: 'ticket/move', ticketId: 'KB-4', text: 'Legacy v2 board activity' },
    ],
    agents: { 'session-old': { name: 'Old Agent', role: 'be-developer', paused: true, firstSeenAt: T - 80_000 } },
    team: {
      version: 1,
      seededAt: T - 150_000,
      members: [
        {
          id: 'member-be-developer',
          name: 'Kept Member',
          title: 'Kept Title',
          roleId: 'be-developer',
          persona: 'Kept persona text for the migrated roster member.',
          paused: false,
          sessionId: null,
          createdAt: T - 140_000,
          updatedAt: T - 130_000,
          createdBy: 'system',
          source: 'seed',
        },
      ],
      drafts: [],
    },
    meta: {
      vision: 'Legacy v2 vision',
      docs: [],
      conversations: [],
      mrs: [{ id: 'mr-1', number: '7', title: 'Kept MR', url: null, state: 'open', source: 'gitlab' }],
      lastScanAt: T - 7000,
    },
  };
}

function checkLegacyPreserved(label, snap, { nextNumber, paused, pausedBy, thoughtId, activityText, metaVision }) {
  const board = snap.board;
  check(`${label}: snapshot version 3`, snap.version === 3, String(snap.version));
  check(`${label}: board version 3`, board.version === 3, String(board.version));
  check(`${label}: ticket count`, board.tickets.length === (thoughtId ? 2 : 1), String(board.tickets.length));
  const ticket = board.tickets.find((entry) => entry.id === 'KB-3');
  check(`${label}: ticket id/number`, ticket?.id === 'KB-3' && ticket?.number === 3, brief(ticket));
  check(`${label}: ticket fields`, ticket?.title === 'Legacy ticket' && ticket?.description === 'Kept through migration.', `${ticket?.title}|${ticket?.description}`);
  check(`${label}: ticket type/priority/column/role`, ticket?.type === 'bug' && ticket?.priority === 'critical' && ticket?.column === 'in_progress' && ticket?.role === 'be-developer', brief({ type: ticket?.type, priority: ticket?.priority, column: ticket?.column }));
  check(`${label}: ticket labels`, same(ticket?.labels, ['legacy', 'schema']), brief(ticket?.labels));
  check(`${label}: ticket owner`, ticket?.owner?.sessionId === 'session-old' && ticket?.owner?.name === 'Old Agent', brief(ticket?.owner));
  check(`${label}: ticket blocked/blockReason`, ticket?.blocked === false && ticket?.blockReason === '', `${ticket?.blocked}|${ticket?.blockReason}`);
  check(`${label}: ticket checklist preserved`, same(ticket?.checklist.map((item) => [item.text, item.done]), [['Kept checklist', true], ['Second item', false]]), brief(ticket?.checklist));
  check(`${label}: ticket comments preserved`, ticket?.comments?.[0]?.text === 'Kept comment' && ticket?.comments?.[0]?.author === 'Old Agent', brief(ticket?.comments));
  check(`${label}: ticket source preserved`, ticket?.source?.kind === 'manual' && ticket?.source?.ref === 'legacy.md', brief(ticket?.source));
  check(`${label}: ticket timestamps preserved`, ticket?.createdAt === T - 90_000 && ticket?.updatedAt === T - 3000 && ticket?.movedAt === T - 3000 && ticket?.acceptedAt === null, brief({ createdAt: ticket?.createdAt, updatedAt: ticket?.updatedAt }));
  check(`${label}: ticket activity preserved`, ticket?.activity?.[0]?.text === 'Kept ticket activity' && ticket?.activity?.[0]?.by === 'Old Agent', brief(ticket?.activity));
  check(`${label}: thoughtId preserved`, (ticket?.thoughtId ?? null) === (thoughtId ?? null), String(ticket?.thoughtId));
  check(`${label}: no parentId on legacy tickets`, !('parentId' in (ticket ?? {})), brief(Object.keys(ticket ?? {})));
  check(`${label}: board activity preserved`, board.activity.some((entry) => entry.text === activityText), brief(board.activity.map((entry) => entry.text)));
  check(`${label}: agents preserved`, board.agents['session-old']?.name === 'Old Agent', brief(board.agents));
  check(`${label}: meta preserved`, board.meta?.vision === metaVision && Number.isFinite(board.meta?.lastScanAt), brief(board.meta));
  check(`${label}: wip preserved`, board.wip.in_progress === (nextNumber === 7 ? 2 : 3), brief(board.wip));
  check(`${label}: pause flags preserved`, board.paused === paused && board.pausedBy === pausedBy, `${board.paused}|${board.pausedBy}`);
  check(`${label}: nextNumber preserved`, board.nextNumber === nextNumber, String(board.nextNumber));
}

// --- v1 fixture ------------------------------------------------------------
{
  const root = await freshRoot('kanban-epic-v1-');
  const stateDir = await freshState('kanban-epic-v1-state-');
  await writeBoard(stateDir, 'workspace-v1', v1Fixture(root));
  const app = makeApp({ stateDir, root, workspaceId: 'workspace-v1' });
  const snap = await app.state();
  checkLegacyPreserved('v1', snap, {
    nextNumber: 7,
    paused: true,
    pausedBy: 'You',
    thoughtId: null,
    activityText: 'Legacy v1 board activity',
    metaVision: 'Legacy v1 vision',
  });
  check('v1: roster seeded on migration', snap.roster.length === 10, String(snap.roster?.length));
  check('v1: roster ids deterministic', snap.roster.every((row) => row.id === `member-${row.roleId}`), brief(snap.roster.map((row) => row.id)));
  const onDisk = JSON.parse(await readFile(boardPath(stateDir, 'workspace-v1'), 'utf8'));
  check('v1: migration persisted as v3', onDisk.version === 3 && onDisk.tickets[0].id === 'KB-3' && onDisk.team.members.length === 10, String(onDisk.version));
  // Every pre-existing key survives (team is the documented additive v2 key).
  const fixtureKeys = Object.keys(v1Fixture(root));
  check('v1: every pre-existing board key survives', fixtureKeys.every((key) => key in snap.board), fixtureKeys.filter((key) => !(key in snap.board)).join(','));
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

// --- v2 fixture + idempotent second load -----------------------------------
{
  const root = await freshRoot('kanban-epic-v2-');
  const stateDir = await freshState('kanban-epic-v2-state-');
  const fixture = v2Fixture(root);
  await writeBoard(stateDir, 'workspace-v2', fixture);
  const app = makeApp({ stateDir, root, workspaceId: 'workspace-v2' });
  const snap = await app.state();
  checkLegacyPreserved('v2', snap, {
    nextNumber: 5,
    paused: false,
    pausedBy: null,
    thoughtId: 'TH-9',
    activityText: 'Legacy v2 board activity',
    metaVision: 'Legacy v2 vision',
  });
  check('v2: roster not re-seeded', snap.roster.length === 1 && snap.roster[0].name === 'Kept Member', brief(snap.roster.map((row) => row.name)));
  check('v2: seededAt preserved', snap.board.team.seededAt === T - 150_000, String(snap.board.team.seededAt));
  check('v2: second ticket preserved', ticketOf(snap, 'KB-4')?.title === 'Legacy v2 child-shaped ticket' && ticketOf(snap, 'KB-4')?.blocked === true, brief(ticketOf(snap, 'KB-4')));
  // "all pre-existing keys are unchanged" — the KB-68 autopilot schema adds two
  // documented board keys additively, so compare the legacy key set, not the
  // whole set (the strict superset check below is kept for the v3 fixture).
  const ADDITIVE_BOARD_KEYS = ['autopilot', 'pulses'];
  const fixtureKeys = Object.keys(fixture).sort();
  check(
    'v2: pre-existing board key set unchanged (additive KB-68 keys allowed)',
    same(Object.keys(snap.board).filter((key) => !ADDITIVE_BOARD_KEYS.includes(key)).sort(), fixtureKeys),
    brief(Object.keys(snap.board).sort()),
  );
  const diskAfterFirst = await readFile(boardPath(stateDir, 'workspace-v2'), 'utf8');
  const statAfterFirst = await stat(boardPath(stateDir, 'workspace-v2'));
  check('v2: migrated file is v3', JSON.parse(diskAfterFirst).version === 3);

  // A fresh Host on the same state dir must not rewrite or renumber anything.
  const restarted = makeApp({ stateDir, root, workspaceId: 'workspace-v2' });
  const second = await restarted.state();
  const diskAfterSecond = await readFile(boardPath(stateDir, 'workspace-v2'), 'utf8');
  const statAfterSecond = await stat(boardPath(stateDir, 'workspace-v2'));
  check('v2: second load writes nothing', statAfterSecond.mtimeMs === statAfterFirst.mtimeMs, `${statAfterFirst.mtimeMs} -> ${statAfterSecond.mtimeMs}`);
  check('v2: second load produces identical content', diskAfterSecond === diskAfterFirst);
  check('v2: second load does not duplicate tickets', second.board.tickets.length === 2 && second.board.tickets.filter((ticket) => ticket.id === 'KB-3').length === 1, String(second.board.tickets.length));
  check('v2: second load keeps nextNumber', second.board.nextNumber === 5, String(second.board.nextNumber));
  const created = await restarted.action('createTicket', { title: 'After migration', type: 'task', column: 'backlog' });
  check('v2: nextNumber continues after migration', created.status === 200 && created.json.value.ticket.id === 'KB-5', `${created.status} ${brief(created.json?.value?.ticket)}`);
  check('v2: new ticket lands in the v3 board', (await restarted.state()).board.nextNumber === 6);
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// New v3 board: version, forced-Backlog create, persistence across restart
// ---------------------------------------------------------------------------
const labRoot = await freshRoot('kanban-epic-lab-');
const labState = await freshState('kanban-epic-lab-state-');
const lab = makeApp({ stateDir: labState, root: labRoot });
const EXPECTED_BOARD_KEYS = [
  'activity',
  'agents',
  // Additive KB-68 keys: the autopilot envelope and the pulse ring.
  'autopilot',
  'createdAt',
  'meta',
  'nextNumber',
  'paused',
  'pausedAt',
  'pausedBy',
  'projectPath',
  'projectTitle',
  'pulses',
  'team',
  'tickets',
  'updatedAt',
  'version',
  'wip',
  'workspaceId',
];
const EXPECTED_SNAPSHOT_KEYS = [
  'accessModes',
  // Additive KB-68 key: the derived autopilot read model.
  'autopilot',
  'board',
  // Additive KB-5 key: soft-deleted thought ids for the ticket-drawer fallback.
  'deletedThoughtIds',
  'drafts',
  'execution',
  'lastScan',
  'now',
  'project',
  'projects',
  'roster',
  'rules',
  'sessions',
  'team',
  'thoughts',
  'version',
  'workspaceId',
];

let labSnap = await lab.state();
check('v3: new board persists version 3', labSnap.version === 3 && labSnap.board.version === 3, `${labSnap.version}/${labSnap.board.version}`);
check('v3: board key set unchanged', same(Object.keys(labSnap.board).sort(), EXPECTED_BOARD_KEYS), brief(Object.keys(labSnap.board).sort()));
check('v3: snapshot key set unchanged', same(Object.keys(labSnap).sort(), EXPECTED_SNAPSHOT_KEYS), brief(Object.keys(labSnap).sort()));
check('v3: empty board has no epic', labSnap.board.tickets.length === 0);

// AC6 — epic create always lands in Backlog, even when a work column is asked for.
let createEpic = await lab.action('createTicket', { title: 'EPIC: durable onboarding', type: 'epic', priority: 'high', column: 'in_progress' });
check('epic create returns 200', createEpic.status === 200, `${createEpic.status} ${brief(createEpic.json?.error)}`);
check('epic create forces Backlog', createEpic.json?.value?.ticket?.column === 'backlog', brief(createEpic.json?.value?.ticket));
check('epic create echoes type epic', createEpic.json?.value?.ticket?.type === 'epic', String(createEpic.json?.value?.ticket?.type));
const epicId = createEpic.json?.value?.ticket?.id;
labSnap = await lab.state();
check('epic create visible in snapshot', ticketOf(labSnap, epicId)?.type === 'epic' && ticketOf(labSnap, epicId)?.column === 'backlog', brief(ticketOf(labSnap, epicId)));

// Tool create (PM path used by KB-4) also forces Backlog.
await setRole(lab, 'product-manager');
const toolEpic = await lab.tool({ action: 'create', title: 'EPIC: tool-created', type: 'epic', column: 'ready' });
check('tool create epic lands in Backlog', toolEpic.ticket?.type === 'epic' && toolEpic.ticket?.column === 'backlog', brief(toolEpic.ticket));
check('tool brief echoes parentId null', toolEpic.ticket?.parentId === null, brief(toolEpic.ticket));
const toolEpicId = toolEpic.ticket?.id;
await setRole(lab, 'tech-lead');

// AC6/AC9 — a child links to an existing EPIC and echoes the link.
let createChild = await lab.action('createTicket', { title: 'Child: first slice', type: 'story', column: 'backlog', parentId: epicId });
check('child create returns 200', createChild.status === 200, `${createChild.status} ${brief(createChild.json?.error)}`);
check('child create echoes parentId', createChild.json?.value?.ticket?.parentId === epicId, brief(createChild.json?.value?.ticket));
const childId = createChild.json?.value?.ticket?.id;
let createChild2 = await lab.action('createTicket', { title: 'Child: second slice', type: 'task', parentId: epicId });
const child2Id = createChild2.json?.value?.ticket?.id;
labSnap = await lab.state();
check('snapshot child carries parentId', ticketOf(labSnap, childId)?.parentId === epicId, brief(ticketOf(labSnap, childId)));
check('snapshot epic carries no parentId', !('parentId' in (ticketOf(labSnap, epicId) ?? {})), brief(Object.keys(ticketOf(labSnap, epicId) ?? {})));

// AC5 — persistence/restart keeps ids, type and parentId; file is v3.
const persistedEpic = await lab.action('createTicket', { title: 'EPIC: restart proof', type: 'epic' });
const persistedEpicId = persistedEpic.json?.value?.ticket?.id;
const persistedChild = await lab.action('createTicket', { title: 'Restart child', type: 'bug', parentId: persistedEpicId });
const persistedChildId = persistedChild.json?.value?.ticket?.id;
const beforeRestart = await lab.state();
const restartedLab = makeApp({ stateDir: labState, root: labRoot });
const afterRestart = await restartedLab.state();
check('restart: epic id/type survive', ticketOf(afterRestart, persistedEpicId)?.type === 'epic', brief(ticketOf(afterRestart, persistedEpicId)));
check('restart: child parentId survives', ticketOf(afterRestart, persistedChildId)?.parentId === persistedEpicId, brief(ticketOf(afterRestart, persistedChildId)));
check('restart: ticket count identical', afterRestart.board.tickets.length === beforeRestart.board.tickets.length, `${beforeRestart.board.tickets.length}/${afterRestart.board.tickets.length}`);
check('restart: board file is v3', JSON.parse(await readFile(boardPath(labState), 'utf8')).version === 3);

// AC5 — corrupt and unknown-version files degrade safely and come back as v3.
{
  const corruptState = await freshState('kanban-epic-corrupt-');
  const corruptRoot = await freshRoot('kanban-epic-corrupt-root-');
  await mkdir(corruptState, { recursive: true });
  await writeFile(boardPath(corruptState), '{ this is not json');
  const corruptApp = makeApp({ stateDir: corruptState, root: corruptRoot });
  const corruptSnap = await corruptApp.state();
  check('corrupt board degrades to a fresh v3 board', corruptSnap.board?.version === 3 && corruptSnap.board.tickets.length === 0, brief(corruptSnap.board && corruptSnap.board.version));
  const unknownState = await freshState('kanban-epic-unknown-');
  const unknownRoot = await freshRoot('kanban-epic-unknown-root-');
  await writeBoard(unknownState, 'workspace-1', { version: 99, workspaceId: 'workspace-1', tickets: [{ id: 'KB-1', number: 1, title: 'ghost' }] });
  const unknownApp = makeApp({ stateDir: unknownState, root: unknownRoot });
  const unknownSnap = await unknownApp.state();
  check('unknown version starts fresh at v3', unknownSnap.board?.version === 3 && unknownSnap.board.tickets.length === 0, brief(unknownSnap.board && unknownSnap.board.version));
  await rm(corruptRoot, { recursive: true, force: true });
  await rm(corruptState, { recursive: true, force: true });
  await rm(unknownRoot, { recursive: true, force: true });
  await rm(unknownState, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// AC7 — an EPIC cannot move; the board and activity are untouched
// ---------------------------------------------------------------------------
for (const target of ['ready', 'in_progress', 'review', 'done']) {
  const before = await lab.state();
  await expectError(`epic move to ${target} rejected`, () => lab.action('moveTicket', { ticketId: epicId, column: target }), 409, 'epic/backlog-only');
  const after = await lab.state();
  check(
    `epic move to ${target}: ticket unchanged`,
    same(ticketOf(before, epicId), ticketOf(after, epicId)) && same(before.board.activity, after.board.activity),
    `${brief(ticketOf(after, epicId))} activity=${after.board.activity.length}`,
  );
}
check('epic still in Backlog after rejected moves', ticketOf(await lab.state(), epicId)?.column === 'backlog');

// AC8 — claim and run on an EPIC are rejected before any mutation.
{
  const before = await lab.state();
  await expectToolError('epic claim rejected', () => lab.tool({ action: 'claim', ticketId: epicId }), 'epic/not-claimable');
  const middle = await lab.state();
  check('epic claim mutates no ticket', same(ticketOf(before, epicId), ticketOf(middle, epicId)), brief(ticketOf(middle, epicId)));
  await expectError('epic runTicket rejected', () => lab.action('runTicket', { ticketId: epicId }), 409, 'epic/not-claimable');
  const after = await lab.state();
  check('epic run mutates no ticket', same(ticketOf(before, epicId), ticketOf(after, epicId)) && same(before.board.activity, after.board.activity), brief(ticketOf(after, epicId)));
  const rejectedEpic = ticketOf(after, epicId);
  check('epic has no execution/owner after rejection', rejectedEpic?.owner == null && rejectedEpic?.execution == null, brief({ owner: rejectedEpic?.owner, execution: rejectedEpic?.execution }));
}
// Non-epic tickets keep today's claim path (tech-lead may claim from Backlog → Ready).
let plainId = null;
{
  const plain = await lab.action('createTicket', { title: 'Plain story', type: 'story', column: 'backlog', role: 'be-developer' });
  plainId = plain.json?.value?.ticket?.id;
  const claimed = await lab.tool({ action: 'claim', ticketId: plainId });
  check('non-epic claim keeps working', claimed.ticket?.column === 'ready' && claimed.ticket?.owner?.sessionId === 'session-1', brief(claimed.ticket));
  // A non-epic dispatch reaches the dispatch path (and fails only because the
  // harness has no agents service), proving the epic guard did not fire.
  const run = await lab.action('runTicket', { ticketId: plainId });
  check('non-epic run reaches dispatch', run.status === 502 && run.json?.error?.code === 'execution/session-failed', `${run.status} ${brief(run.json?.error)}`);
}

// ---------------------------------------------------------------------------
// AC9 — parent validation
// ---------------------------------------------------------------------------
await expectError('missing parent rejected', () => lab.action('createTicket', { title: 'Orphan', parentId: 'KB-999' }), 400, 'ticket/parent-invalid');
await expectError('non-EPIC parent rejected', () => lab.action('createTicket', { title: 'Bad parent', parentId: plainId }), 400, 'ticket/parent-invalid');
await expectError('EPIC with a parent rejected', () => lab.action('createTicket', { title: 'Nested EPIC', type: 'epic', parentId: epicId }), 400, 'ticket/parent-invalid');
await expectError('self parent rejected on update', () => lab.action('updateTicket', { ticketId: childId, patch: { parentId: childId } }), 400, 'ticket/parent-invalid');
await expectError('update to non-EPIC parent rejected', () => lab.action('updateTicket', { ticketId: childId, patch: { parentId: plainId } }), 400, 'ticket/parent-invalid');
await expectError('update child of EPIC to missing parent rejected', () => lab.action('updateTicket', { ticketId: childId, patch: { parentId: 'KB-999' } }), 400, 'ticket/parent-invalid');

// Empty / non-string parentId is treated as absent (no link, no error).
const emptyParent = await lab.action('createTicket', { title: 'Empty parent', type: 'spike', parentId: '' });
check('empty parentId is absent', emptyParent.status === 200 && !('parentId' in (emptyParent.json?.value?.ticket ?? {})), `${emptyParent.status} ${brief(emptyParent.json?.value?.ticket)}`);
const numericParent = await lab.action('createTicket', { title: 'Numeric parent', type: 'task', parentId: 42 });
check('non-string parentId is absent', numericParent.status === 200 && !('parentId' in (numericParent.json?.value?.ticket ?? {})), `${numericParent.status} ${brief(numericParent.json?.value?.ticket)}`);

// Updating a child to another existing EPIC succeeds; null clears the link.
const reparent = await lab.action('updateTicket', { ticketId: child2Id, patch: { parentId: toolEpicId } });
check('update re-parents to another EPIC', reparent.status === 200 && reparent.json?.value?.ticket?.parentId === toolEpicId, `${reparent.status} ${brief(reparent.json?.value?.ticket)}`);
const cleared = await lab.action('updateTicket', { ticketId: child2Id, patch: { parentId: null } });
check('update null clears parentId', cleared.status === 200 && !('parentId' in (cleared.json?.value?.ticket ?? {})), `${cleared.status} ${brief(cleared.json?.value?.ticket)}`);
const noParentChange = await lab.action('updateTicket', { ticketId: childId, patch: { title: 'Child: retitled' } });
check('plain update never clears parent', noParentChange.status === 200 && noParentChange.json?.value?.ticket?.parentId === epicId, `${noParentChange.status} ${brief(noParentChange.json?.value?.ticket)}`);

// Tool update path (used by KB-4) applies the same validation.
await expectToolError('tool update missing parent rejected', () => lab.tool({ action: 'update', ticketId: childId, parentId: 'KB-999' }), 'ticket/parent-invalid');
const toolLinked = await lab.tool({ action: 'update', ticketId: child2Id, parentId: toolEpicId });
check('tool update links a parent', toolLinked.ticket?.parentId === toolEpicId, brief(toolLinked.ticket));
const toolCleared = await lab.tool({ action: 'update', ticketId: child2Id, parentId: null });
check('tool update clears a parent', toolCleared.ticket?.parentId === null, brief(toolCleared.ticket));

// ---------------------------------------------------------------------------
// AC10 — no dangling parents
// ---------------------------------------------------------------------------
{
  const before = await lab.state();
  await expectError('delete EPIC with children rejected', () => lab.action('deleteTicket', { ticketId: epicId }), 409, 'epic/has-children');
  const after = await lab.state();
  check('rejected EPIC delete leaves the board unchanged', same(before.board.tickets, after.board.tickets) && same(before.board.activity, after.board.activity));
  const deleteChild = await lab.action('deleteTicket', { ticketId: childId });
  check('deleting a child is allowed', deleteChild.status === 200 && deleteChild.json?.value?.deleted === true, `${deleteChild.status} ${brief(deleteChild.json?.value)}`);
  check('deleted child is gone', ticketOf(await lab.state(), childId) === null);
  // The EPIC can be deleted once its children are gone.
  const reparented = await lab.state();
  const childIds = reparented.board.tickets.filter((ticket) => ticket.parentId === epicId).map((ticket) => ticket.id);
  for (const id of childIds) await lab.action('deleteTicket', { ticketId: id });
  const deleteEpic = await lab.action('deleteTicket', { ticketId: epicId });
  check('childless EPIC can be deleted', deleteEpic.status === 200, `${deleteEpic.status} ${brief(deleteEpic.json?.error)}`);
}

// Read-time repair: a hand-edited v3 board with dangling/non-EPIC parent links.
{
  const root = await freshRoot('kanban-epic-repair-');
  const stateDir = await freshState('kanban-epic-repair-state-');
  const fixture = {
    version: 3,
    workspaceId: 'workspace-1',
    projectTitle: 'Repair',
    projectPath: root,
    createdAt: T,
    updatedAt: T,
    paused: false,
    pausedAt: null,
    pausedBy: null,
    wip: { backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0 },
    nextNumber: 8,
    tickets: [
      { id: 'KB-1', number: 1, title: 'Real EPIC', type: 'epic', column: 'backlog', priority: 'high', labels: [], checklist: [], comments: [], activity: [] },
      { id: 'KB-2', number: 2, title: 'Valid child', type: 'story', column: 'backlog', parentId: 'KB-1', priority: 'medium', labels: [], checklist: [], comments: [], activity: [] },
      { id: 'KB-3', number: 3, title: 'Missing parent child', type: 'story', column: 'backlog', parentId: 'KB-404', priority: 'medium', labels: [], checklist: [], comments: [], activity: [] },
      { id: 'KB-4', number: 4, title: 'Non-EPIC parent child', type: 'task', column: 'backlog', parentId: 'KB-5', priority: 'medium', labels: [], checklist: [], comments: [], activity: [] },
      { id: 'KB-5', number: 5, title: 'Not an EPIC', type: 'story', column: 'ready', priority: 'medium', labels: [], checklist: [], comments: [], activity: [] },
      { id: 'KB-6', number: 6, title: 'EPIC with a parent', type: 'epic', column: 'backlog', parentId: 'KB-1', priority: 'high', labels: [], checklist: [], comments: [], activity: [] },
      { id: 'KB-7', number: 7, title: 'EPIC outside Backlog', type: 'epic', column: 'ready', priority: 'high', labels: [], checklist: [], comments: [], activity: [] },
    ],
    activity: [],
    agents: {},
    team: { version: 1, seededAt: T, members: [], drafts: [] },
    meta: { vision: null, docs: [], conversations: [], mrs: [], lastScanAt: null },
  };
  await writeBoard(stateDir, 'workspace-1', fixture);
  const app = makeApp({ stateDir, root });
  const snap = await app.state();
  const byId = (id) => snap.board.tickets.find((ticket) => ticket.id === id) ?? null;
  check('repair: valid EPIC link kept', byId('KB-2')?.parentId === 'KB-1', brief(byId('KB-2')));
  check('repair: missing parent dropped', !('parentId' in (byId('KB-3') ?? {})), brief(byId('KB-3')));
  check('repair: non-EPIC parent dropped', !('parentId' in (byId('KB-4') ?? {})), brief(byId('KB-4')));
  check('repair: EPIC-with-parent link dropped', !('parentId' in (byId('KB-6') ?? {})), brief(byId('KB-6')));
  check('repair: EPIC pinned back to Backlog', byId('KB-7')?.column === 'backlog', brief(byId('KB-7')));
  const notes = snap.board.activity.filter((entry) => entry.kind === 'ticket/parent-dropped');
  check('repair: every dropped link recorded as board activity', notes.length === 3, brief(snap.board.activity.map((entry) => entry.kind)));
  check('repair: pin repair recorded as board activity', snap.board.activity.some((entry) => entry.kind === 'ticket/epic-pinned' && entry.ticketId === 'KB-7'), brief(snap.board.activity));
  const onDisk = JSON.parse(await readFile(boardPath(stateDir), 'utf8'));
  check('repair: drops persisted', !('parentId' in (onDisk.tickets.find((ticket) => ticket.id === 'KB-3') ?? {})), brief(onDisk.tickets.find((ticket) => ticket.id === 'KB-3')));
  check('repair: nextNumber unchanged', onDisk.nextNumber === 8, String(onDisk.nextNumber));
  const again = await app.state();
  check('repair: idempotent (no duplicate notes)', again.board.activity.length === snap.board.activity.length, `${snap.board.activity.length}/${again.board.activity.length}`);
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// AC1 — type validation everywhere
// ---------------------------------------------------------------------------
{
  const types = ['story', 'task', 'bug', 'spike'];
  const root = await freshRoot('kanban-epic-types-');
  const stateDir = await freshState('kanban-epic-types-state-');
  const app = makeApp({ stateDir, root });
  for (const type of types) {
    const created = await app.action('createTicket', { title: `Type ${type}`, type });
    check(`type ${type} accepted unchanged`, created.status === 200 && created.json?.value?.ticket?.type === type, `${created.status} ${brief(created.json?.value?.ticket)}`);
  }
  const invalid = await app.action('createTicket', { title: 'Type invalid', type: 'epic-ish' });
  check('invalid type keeps the task fallback', invalid.status === 200 && invalid.json?.value?.ticket?.type === 'task', `${invalid.status} ${brief(invalid.json?.value?.ticket)}`);
  const firstStory = (await app.state()).board.tickets.find((ticket) => ticket.type === 'story');
  const updateType = await app.action('updateTicket', { ticketId: firstStory.id, patch: { type: 'bug' } });
  check('update accepts an existing type', updateType.status === 200 && updateType.json?.value?.ticket?.type === 'bug', `${updateType.status} ${brief(updateType.json?.value?.ticket)}`);
  const updateEpic = await app.action('updateTicket', { ticketId: firstStory.id, patch: { type: 'epic' } });
  check('update accepts epic and pins Backlog', updateEpic.status === 200 && updateEpic.json?.value?.ticket?.type === 'epic' && updateEpic.json?.value?.ticket?.column === 'backlog', `${updateEpic.status} ${brief(updateEpic.json?.value?.ticket)}`);
  const updateInvalid = await app.action('updateTicket', { ticketId: firstStory.id, patch: { type: 'nonsense' } });
  check('update ignores an invalid type', updateInvalid.status === 200 && updateInvalid.json?.value?.ticket?.type === 'epic', `${updateInvalid.status} ${brief(updateInvalid.json?.value?.ticket)}`);
  // Converting an EPIC with children away from epic is rejected (would orphan them).
  const childOfEpic = await app.action('createTicket', { title: 'Child', type: 'story', parentId: firstStory.id });
  check('child of converted EPIC created', childOfEpic.status === 200, `${childOfEpic.status} ${brief(childOfEpic.json?.error)}`);
  await expectError('EPIC with children cannot change type', () => app.action('updateTicket', { ticketId: firstStory.id, patch: { type: 'story' } }), 409, 'epic/has-children');
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// AC10/AC11 — persisted parentIds never dangle after ordinary actions
// ---------------------------------------------------------------------------
{
  const snap = await lab.state();
  const ids = new Set(snap.board.tickets.map((ticket) => ticket.id));
  const dangling = snap.board.tickets.filter((ticket) => ticket.parentId && !ids.has(ticket.parentId));
  check('no dangling parentId after the full scenario', dangling.length === 0, brief(dangling.map((ticket) => `${ticket.id}->${ticket.parentId}`)));
  const wrongParent = snap.board.tickets.filter((ticket) => {
    if (!ticket.parentId) return false;
    const parent = snap.board.tickets.find((entry) => entry.id === ticket.parentId);
    return !parent || parent.type !== 'epic';
  });
  check('every parentId points at an EPIC', wrongParent.length === 0, brief(wrongParent.map((ticket) => ticket.id)));
  check('every EPIC stays in Backlog', snap.board.tickets.filter((ticket) => ticket.type === 'epic').every((ticket) => ticket.column === 'backlog'));
}

console.log('\n' + (failures.length === 0 ? 'ALL EPIC CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
await rm(labRoot, { recursive: true, force: true });
await rm(labState, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
