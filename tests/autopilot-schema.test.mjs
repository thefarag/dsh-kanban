/**
 * KB-68 — autopilot config, additive board schema and control API.
 *
 * Dependency-free harness in the same style as `tests/host.test.mjs`: temporary
 * directories, a fake Harness ctx, and a frozen `Date.now`/injected clock so no
 * test ever awaits a real timer. The board JSON on disk is the contract under
 * test — every assertion reads the persisted file or the polled snapshot, never
 * an internal helper.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  defaults, first save writes `board.autopilot.version: 1`, idempotent
 *         second load+save (byte-identical JSON)
 *   AC 2  `POST /kanban/action` action `autopilot`: status + configure, every
 *         bound rejected with 400 `autopilot/invalid`, board left unchanged
 *   AC 3  hand-edited corrupt config repaired on read with a normalization note;
 *         corrupt `pulses` entries dropped instead of throwing
 *   AC 4  `board.pulses` ring shape, newest-50 cap after 100 appends, survives
 *         restart
 *   AC 5  persisted budget counters/windows, remaining allowance + reset time
 *   AC 6  additive snapshot `autopilot` object and `ticket.reviews` (newest 20)
 *   AC 7  board version stays 3; v1/v2/v3 fixtures load; an older v3 reader
 *         (new keys projected away) still sees tickets, team, comments, activity
 */
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../index.js';

// One frozen instant for the whole file: `BoardStore.save()` stamps `updatedAt`
// from `Date.now`, so freezing it is what makes the AC 1 byte-identical second
// save a genuine assertion rather than a timestamp race.
const T = 1_760_000_000_000;
const realDateNow = Date.now;
Date.now = () => T;

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const brief = (value) => String(JSON.stringify(value)).slice(0, 220);

const dirs = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const DEFAULTS = {
  enabled: false,
  cadenceMs: 300000,
  maxReadyDepth: 3,
  laneCaps: { refine: 1, implement: 1, review: 1 },
  maxDispatchesPerPulse: 1,
  budget: { hour: 20, day: 60 },
  backoffMs: 300000,
  staleMs: 600000,
};

const WORKSPACE_ID = 'workspace-1';

function fixtureBoard(version) {
  const board = {
    version,
    workspaceId: WORKSPACE_ID,
    projectTitle: 'Fixture',
    projectPath: '/tmp/fixture',
    createdAt: T - 100_000,
    updatedAt: T - 10_000,
    paused: false,
    pausedAt: null,
    pausedBy: null,
    wip: { backlog: 0, ready: 0, in_progress: 3, review: 5, done: 0 },
    nextNumber: 2,
    tickets: [
      {
        id: 'KB-1',
        number: 1,
        title: 'Legacy ticket',
        description: 'Kept description',
        type: 'task',
        priority: 'medium',
        column: 'ready',
        role: 'be-developer',
        labels: ['legacy'],
        owner: null,
        blocked: false,
        blockReason: '',
        checklist: [],
        comments: [{ id: 'c1', author: 'Old Agent', text: 'legacy comment', at: T - 5000 }],
        source: null,
        createdAt: T - 9000,
        updatedAt: T - 8000,
        movedAt: T - 8000,
        acceptedAt: null,
        activity: [{ id: 'ta1', at: T - 7000, by: 'Old Agent', action: 'comment', text: 'legacy ticket activity' }],
      },
    ],
    activity: [{ id: 'ba1', at: T - 9000, by: 'You', kind: 'ticket/create', ticketId: 'KB-1', text: 'legacy board activity' }],
    agents: {},
    meta: { vision: 'Fixture vision', docs: [], conversations: [], mrs: [], lastScanAt: null },
  };
  if (version >= 2) {
    board.team = {
      version: 1,
      seededAt: T - 50_000,
      members: [
        {
          id: 'member-be-developer',
          name: 'Kept Member',
          title: 'Kept Member Title',
          roleId: 'be-developer',
          persona: 'Kept persona text for the migrated roster member.',
          paused: false,
          sessionId: null,
          createdAt: T - 40_000,
          updatedAt: T - 30_000,
          createdBy: 'system',
          source: 'seed',
        },
      ],
      drafts: [],
    };
  }
  return board;
}

async function writeBoard(stateDir, board, workspaceId = WORKSPACE_ID) {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, `${workspaceId}.json`), JSON.stringify(board), 'utf8');
}

const boardFile = (stateDir, workspaceId = WORKSPACE_ID) => join(stateDir, `${workspaceId}.json`);
const readBoardFile = async (stateDir, workspaceId = WORKSPACE_ID) =>
  JSON.parse(await readFile(boardFile(stateDir, workspaceId), 'utf8'));

/** Build one host instance against `stateDir`; every call has fresh caches. */
function makeApp({ stateDir, root, workspaceId = WORKSPACE_ID, now = () => T }) {
  const services = {};
  const routes = new Map();
  const workspace = {
    id: workspaceId,
    title: 'Fixture Project',
    path: root,
    createdAt: new Date(T).toISOString(),
    updatedAt: new Date(T).toISOString(),
    sessionIds: [],
  };
  const ctx = {
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    on() {
      return () => {};
    },
    get(service) {
      return services[service];
    },
    provide(service, value) {
      services[service] = value;
      return () => {};
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    tools: {
      register() {
        return () => {};
      },
    },
    systemPrompt: {
      section() {
        return () => {};
      },
    },
    connection: { requestRejection: () => undefined },
    workspaceRegistry: { list: () => [workspace] },
    sessionController: {
      async list() {
        return { items: [] };
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
        return [];
      },
      async open() {
        return { async read() { return { events: [] }; }, async close() {} };
      },
      async stat() {
        return undefined;
      },
    },
    agents: { list: () => [], get: () => undefined },
  };
  apply(ctx, { stateDir, wipInProgress: 3, wipReview: 5, now });

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
    routes,
    state: async () => (await http('/kanban/state', { workspaceId })).json.value,
    action: async (action, payload) => http('/kanban/action', { workspaceId, action, payload }),
  };
}

async function freshApp(now = () => T) {
  const root = await tempDir('kanban-kb68-root-');
  const stateDir = await tempDir('kanban-kb68-state-');
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Fixture Project\n', 'utf8');
  return { root, stateDir, app: makeApp({ stateDir, root, now }) };
}

// ---------------------------------------------------------------------------
// AC 1/AC 2 — defaults, status body, first save writes the envelope version
// ---------------------------------------------------------------------------
console.log('\n## AC 1/AC 2 — defaults, status, configure');
{
  const { stateDir, app } = await freshApp();
  const snap = await app.state();
  check('AC1 empty board loads with autopilot defaults', same(snap.autopilot.config, DEFAULTS), brief(snap.autopilot.config));
  check('AC1 board version stays 3', snap.version === 3 && snap.board.version === 3, `${snap.version}/${snap.board.version}`);
  check('AC1 board.autopilot envelope version 1', snap.board.autopilot?.version === 1, brief(snap.board.autopilot?.version));
  check('AC1 board.pulses starts empty', Array.isArray(snap.board.pulses) && snap.board.pulses.length === 0);

  const onDisk = await readBoardFile(stateDir);
  check('AC1 first save persists board.autopilot.version 1', onDisk.autopilot?.version === 1, brief(onDisk.autopilot?.version));
  check('AC1 persisted budget counters start at zero', onDisk.autopilot.budget.hour.used === 0 && onDisk.autopilot.budget.hour.windowStart === 0, brief(onDisk.autopilot.budget));

  const status = await app.action('autopilot', { op: 'status' });
  const value = status.json?.value;
  check('AC2 status returns 200 ok', status.status === 200 && status.json?.ok === true, String(status.status));
  check(
    'AC2 status body is {config, nextTickAt, lastPulse, budgetRemaining}',
    same(Object.keys(value ?? {}).sort(), ['budgetRemaining', 'config', 'lastPulse', 'nextTickAt']),
    brief(Object.keys(value ?? {})),
  );
  check('AC2 status config matches the defaults', same(value.config, DEFAULTS), brief(value.config));
  check('AC2 disabled autopilot has no next tick', value.nextTickAt === null, String(value.nextTickAt));
  check('AC2 no pulse yet', value.lastPulse === null, brief(value.lastPulse));
  check(
    'AC2 budgetRemaining exposes allowance and reset',
    value.budgetRemaining.hour.remaining === 20 &&
      value.budgetRemaining.day.remaining === 60 &&
      Number.isFinite(value.budgetRemaining.hour.resetsAt) &&
      value.budgetRemaining.hour.resetsAt === T + 60 * 60 * 1000,
    brief(value.budgetRemaining),
  );
  // Evidence capture for the ticket: the exact status body.
  console.log('[capture] autopilot {op:"status"} body:', JSON.stringify(status.json));

  const unknownOp = await app.action('autopilot', { op: 'launch' });
  check('AC2 unknown op rejects with autopilot/invalid', unknownOp.status === 400 && unknownOp.json?.error?.code === 'autopilot/invalid', `${unknownOp.status} ${unknownOp.json?.error?.code}`);
  const missingPatch = await app.action('autopilot', { op: 'configure' });
  check('AC2 configure without a patch rejects with autopilot/invalid', missingPatch.status === 400 && missingPatch.json?.error?.code === 'autopilot/invalid', `${missingPatch.status} ${missingPatch.json?.error?.code}`);
}

// ---------------------------------------------------------------------------
// AC 2 — configure: bounds accepted, everything invalid rejected, no write
// ---------------------------------------------------------------------------
console.log('\n## AC 2 — configure validation');
{
  const { stateDir, app } = await freshApp();
  await app.state();

  const low = await app.action('autopilot', {
    op: 'configure',
    patch: {
      cadenceMs: 60_000,
      maxReadyDepth: 0,
      laneCaps: { refine: 3, implement: 3, review: 3 },
      maxDispatchesPerPulse: 5,
      budget: { hour: 200, day: 1000 },
      backoffMs: 60_000,
      staleMs: 60_000,
    },
  });
  check('AC2 lower bounds accepted', low.status === 200, `${low.status} ${brief(low.json?.error)}`);
  check(
    'AC2 lower bounds applied',
    same(low.json?.value?.config, {
      enabled: false,
      cadenceMs: 60_000,
      maxReadyDepth: 0,
      laneCaps: { refine: 3, implement: 3, review: 3 },
      maxDispatchesPerPulse: 5,
      budget: { hour: 200, day: 1000 },
      backoffMs: 60_000,
      staleMs: 60_000,
    }),
    brief(low.json?.value?.config),
  );

  const high = await app.action('autopilot', {
    op: 'configure',
    patch: { cadenceMs: 3_600_000, maxReadyDepth: 20, maxDispatchesPerPulse: 5, budget: { hour: 200, day: 1000 }, backoffMs: 3_600_000, staleMs: 3_600_000 },
  });
  check('AC2 upper bounds accepted', high.status === 200, `${high.status} ${brief(high.json?.error)}`);
  check('AC2 enabled can only be a literal boolean', (await app.action('autopilot', { op: 'configure', patch: { enabled: true } })).json?.value?.config?.enabled === true);

  const invalidCases = [
    ['cadenceMs too low', { cadenceMs: 59_999 }],
    ['cadenceMs too high', { cadenceMs: 3_600_001 }],
    ['cadenceMs wrong type', { cadenceMs: '300000' }],
    ['maxReadyDepth too low', { maxReadyDepth: -1 }],
    ['maxReadyDepth too high', { maxReadyDepth: 21 }],
    ['maxReadyDepth fractional', { maxReadyDepth: 2.5 }],
    ['lane cap too low', { laneCaps: { refine: -1 } }],
    ['lane cap too high', { laneCaps: { review: 4 } }],
    ['lane cap wrong type', { laneCaps: { implement: '1' } }],
    ['unknown lane cap', { laneCaps: { story: 1 } }],
    ['maxDispatchesPerPulse too low', { maxDispatchesPerPulse: 0 }],
    ['maxDispatchesPerPulse too high', { maxDispatchesPerPulse: 6 }],
    ['budget.hour too low', { budget: { hour: 0 } }],
    ['budget.hour too high', { budget: { hour: 201 } }],
    ['budget.day too low', { budget: { day: 0 } }],
    ['budget.day too high', { budget: { day: 1001 } }],
    ['unknown budget unit', { budget: { week: 10 } }],
    ['backoffMs too low', { backoffMs: 59_999 }],
    ['backoffMs too high', { backoffMs: 3_600_001 }],
    ['staleMs too low', { staleMs: 59_999 }],
    ['staleMs too high', { staleMs: 3_600_001 }],
    ['unknown field', { nope: 1 }],
    ['enabled wrong type', { enabled: 'true' }],
    ['patch not an object', 'nope'],
  ];
  const before = await readFile(boardFile(stateDir), 'utf8');
  const beforeConfig = (await app.action('autopilot', { op: 'status' })).json.value.config;
  let rejected = 0;
  let firstRejection = null;
  for (const [label, patch] of invalidCases) {
    const response = await app.action('autopilot', { op: 'configure', patch });
    const code = response.json?.error?.code;
    const ok = response.status === 400 && code === 'autopilot/invalid';
    if (ok) rejected += 1;
    if (!ok) check(`AC2 rejected: ${label}`, false, `${response.status} ${code} ${brief(response.json?.error?.message)}`);
    if (ok && firstRejection === null) firstRejection = response.json;
  }
  check('AC2 every out-of-range/unknown field rejects 400 autopilot/invalid', rejected === invalidCases.length, `${rejected}/${invalidCases.length}`);
  console.log('[capture] rejected configure body:', JSON.stringify(firstRejection));
  const after = await readFile(boardFile(stateDir), 'utf8');
  check('AC2 rejected configure leaves the board file byte-identical', before === after, `${before.length}/${after.length}`);
  const afterConfig = (await app.action('autopilot', { op: 'status' })).json.value.config;
  check('AC2 rejected configure leaves the effective config unchanged', same(beforeConfig, afterConfig), brief(afterConfig));
  check(
    'AC2 rejection names the field and the bounds',
    typeof firstRejection?.error?.message === 'string' && /cadenceMs/.test(firstRejection.error.message) && /59999|60000|3600000/.test(firstRejection.error.message),
    firstRejection?.error?.message,
  );
}

// ---------------------------------------------------------------------------
// AC 1 — loading then saving once writes version 1 and is idempotent
// ---------------------------------------------------------------------------
console.log('\n## AC 1 — load + save writes version 1, second load+save is byte-identical');
{
  const { stateDir } = await freshApp();
  // A v3 board written before autopilot existed.
  await writeBoard(stateDir, fixtureBoard(3));
  const first = makeApp({ stateDir, root: '/tmp/fixture' });
  const loaded = await first.state();
  check('AC1 legacy board loads with synthesized defaults', same(loaded.autopilot.config, DEFAULTS), brief(loaded.autopilot.config));
  check('AC1 a read does not write autopilot to disk', !('autopilot' in (await readBoardFile(stateDir))), Object.keys(await readBoardFile(stateDir)).join(','));
  // One save (the configure action is the only side-effect-free save path: an
  // empty patch changes nothing but persists the synthesized envelope).
  const saved = await first.action('autopilot', { op: 'configure', patch: {} });
  check('AC1 configure with an empty patch returns 200', saved.status === 200, String(saved.status));
  const firstBytes = await readFile(boardFile(stateDir), 'utf8');
  check('AC1 load+save writes board.autopilot.version 1', JSON.parse(firstBytes).autopilot?.version === 1, brief(JSON.parse(firstBytes).autopilot?.version));
  check('AC1 persisted autopilot keeps the default config', same(JSON.parse(firstBytes).autopilot.cadenceMs, 300000) && JSON.parse(firstBytes).autopilot.budget.hour.limit === 20);

  // A fresh host on the same state dir: load from disk + one save.
  const second = makeApp({ stateDir, root: '/tmp/fixture' });
  await second.state();
  const again = await second.action('autopilot', { op: 'configure', patch: {} });
  check('AC1 second configure returns 200', again.status === 200, String(again.status));
  const secondBytes = await readFile(boardFile(stateDir), 'utf8');
  check('AC1 second load+save produces byte-identical JSON', firstBytes === secondBytes, `${firstBytes.length}/${secondBytes.length}`);
}

// ---------------------------------------------------------------------------
// AC 3 — corrupt config repaired on read, with a normalization note
// ---------------------------------------------------------------------------
console.log('\n## AC 3 — corrupt config repair and normalization notes');
{
  const { stateDir, app } = await freshApp();
  const board = fixtureBoard(3);
  board.autopilot = {
    version: 1,
    enabled: 'true',
    cadenceMs: 5,
    maxReadyDepth: 'many',
    laneCaps: { refine: 9, implement: 'one', story: 2 },
    maxDispatchesPerPulse: 99,
    budget: { hour: 5000, day: 'lots' },
    backoffMs: 1e12,
    staleMs: null,
    bogus: true,
  };
  await writeBoard(stateDir, board);
  const snap = await app.state();
  check('AC3 hand-edited board still loads', Boolean(snap.board));
  check(
    'AC3 wrong types/out-of-range repaired to the nearest valid default',
    same(snap.autopilot.config, {
      enabled: false,
      cadenceMs: 60_000,
      maxReadyDepth: 3,
      laneCaps: { refine: 3, implement: 1, review: 1 },
      maxDispatchesPerPulse: 5,
      budget: { hour: 200, day: 60 },
      backoffMs: 3_600_000,
      staleMs: 600_000,
    }),
    brief(snap.autopilot.config),
  );
  const note = (snap.board.activity ?? []).find((entry) => entry.by === 'system' && String(entry.kind ?? '').startsWith('autopilot/'));
  check('AC3 repair records a normalization note via board activity', Boolean(note), brief(snap.board.activity?.[0]));
  check('AC3 normalization note names the repairs', typeof note?.text === 'string' && note.text.includes('autopilot: config normalized') && note.text.includes('cadenceMs'), note?.text);
  const onDisk = await readBoardFile(stateDir);
  check('AC3 repaired config is persisted', onDisk.autopilot.version === 1 && onDisk.autopilot.enabled === false && !('bogus' in onDisk.autopilot), brief(onDisk.autopilot));
  check('AC3 repair is idempotent (one note only)', (onDisk.activity ?? []).filter((entry) => String(entry.kind ?? '').startsWith('autopilot/')).length === 1);

  // Unknown envelope version: fail safe to disabled, keep the board.
  const versioned = await freshApp();
  const vBoard = fixtureBoard(3);
  vBoard.autopilot = {
    version: 7,
    enabled: true,
    cadenceMs: 300000,
    maxReadyDepth: 3,
    laneCaps: { refine: 1, implement: 1, review: 1 },
    maxDispatchesPerPulse: 1,
    budget: { hour: 20, day: 60 },
    backoffMs: 300000,
    staleMs: 600000,
    updatedAt: T - 1000,
    updatedBy: 'You',
  };
  vBoard.tickets[0].title = 'kept after unknown version';
  await writeBoard(versioned.stateDir, vBoard);
  const vSnap = await versioned.app.state();
  check('AC3 unknown subtree version fails safe to disabled', vSnap.board.autopilot.version === 1 && vSnap.board.autopilot.enabled === false, brief(vSnap.board.autopilot));
  check('AC3 unknown version keeps the rest of the board', vSnap.board.tickets[0]?.title === 'kept after unknown version', vSnap.board.tickets[0]?.title);
  check(
    'AC3 unknown version uses the version-unknown note kind',
    (vSnap.board.activity ?? []).some((entry) => entry.kind === 'autopilot/config-version-unknown'),
    brief((vSnap.board.activity ?? []).filter((entry) => String(entry.kind ?? '').startsWith('autopilot/'))),
  );

  // A completely non-object subtree is the same fail-safe path.
  const garbage = await freshApp();
  const gBoard = fixtureBoard(3);
  gBoard.autopilot = 'not-a-config';
  await writeBoard(garbage.stateDir, gBoard);
  const gSnap = await garbage.app.state();
  check('AC3 non-object config degrades to defaults without throwing', same(gSnap.autopilot.config, DEFAULTS), brief(gSnap.autopilot.config));

  // A partial config (missing keys) is repaired field by field and noted.
  const partial = await freshApp();
  const pBoard = fixtureBoard(3);
  pBoard.autopilot = { version: 1, laneCaps: { refine: 2 } };
  await writeBoard(partial.stateDir, pBoard);
  const pSnap = await partial.app.state();
  check('AC3 missing keys are repaired to defaults', pSnap.autopilot.config.cadenceMs === 300000 && pSnap.autopilot.config.laneCaps.refine === 2 && pSnap.autopilot.config.laneCaps.review === 1, brief(pSnap.autopilot.config));
  check('AC3 missing keys record a normalization note', (pSnap.board.activity ?? []).some((entry) => entry.kind === 'autopilot/config-normalized'), brief((pSnap.board.activity ?? []).map((entry) => entry.kind)));
}

// ---------------------------------------------------------------------------
// AC 3/AC 4 — pulse history: corrupt entries dropped, ring shape, 100→50 cap
// ---------------------------------------------------------------------------
console.log('\n## AC 3/AC 4 — pulse history');
{
  const { stateDir, app } = await freshApp();
  const board = fixtureBoard(3);
  board.pulses = [
    null,
    'nope',
    { id: 'PL-bad', at: 'soon' },
    {
      id: 'PL-1',
      at: T - 1000,
      trigger: 'weird',
      decisions: 'not-an-array',
      dispatched: [{ ticketId: 'KB-1', memberId: 'member-be-developer', sessionId: 'session-1' }, { ticketId: 'KB-1' }],
      error: 42,
    },
    {
      id: 'PL-2',
      at: T - 9000,
      trigger: 'timer',
      decisions: [
        { ticketId: 'KB-1', memberId: 'member-be-developer', lane: 'implement', action: 'dispatch', reason: 'role match' },
        null,
      ],
      dispatched: [{ ticketId: 'KB-1', memberId: 'member-be-developer', sessionId: 'session-2' }],
      error: '',
    },
  ];
  await writeBoard(stateDir, board);
  const snap = await app.state();
  check('AC3 corrupt pulse entries are dropped, board still loads', snap.board.pulses.length === 2, String(snap.board.pulses.length));
  check('AC4 newest pulse is first after normalization', snap.board.pulses[0]?.id === 'PL-1' && snap.board.pulses[1]?.id === 'PL-2', brief(snap.board.pulses.map((pulse) => pulse.id)));
  check(
    'AC4 pulse entry has exactly {id, at, trigger, decisions, dispatched, error}',
    same(Object.keys(snap.board.pulses[0]).sort(), ['at', 'decisions', 'dispatched', 'error', 'id', 'trigger']),
    brief(Object.keys(snap.board.pulses[0])),
  );
  check('AC4 unknown trigger coerced to manual', snap.board.pulses[0].trigger === 'manual', snap.board.pulses[0].trigger);
  check('AC4 non-array decisions normalize to []', same(snap.board.pulses[0].decisions, []), brief(snap.board.pulses[0].decisions));
  check('AC4 dispatch without a session id is dropped', snap.board.pulses[0].dispatched.length === 1 && snap.board.pulses[1].dispatched.length === 1, `${snap.board.pulses[0].dispatched.length}/${snap.board.pulses[1].dispatched.length}`);
  check(
    'AC4 decision row has exactly {ticketId, memberId, lane, action, reason}',
    same(Object.keys(snap.board.pulses[1].decisions[0]).sort(), ['action', 'lane', 'memberId', 'reason', 'ticketId']),
    brief(Object.keys(snap.board.pulses[1].decisions[0])),
  );
  check(
    'AC4 dispatch row has exactly {ticketId, memberId, sessionId}',
    same(Object.keys(snap.board.pulses[1].dispatched[0]).sort(), ['memberId', 'sessionId', 'ticketId']),
    brief(Object.keys(snap.board.pulses[1].dispatched[0])),
  );
  check('AC4 pulse error is clamped to a string', snap.board.pulses[0].error === '', brief(snap.board.pulses[0].error));

  // 100 appends to a board: the ring keeps the newest 50 and survives restart.
  const capped = await freshApp();
  const capBoard = fixtureBoard(3);
  capBoard.pulses = Array.from({ length: 100 }, (_, index) => ({
    id: `PL-${index + 1}`,
    at: T - (100 - index) * 1000,
    trigger: 'timer',
    decisions: [],
    dispatched: [],
    error: '',
  }));
  await writeBoard(capped.stateDir, capBoard);
  const capSnap = await capped.app.state();
  check('AC4 100 appended pulses are capped at 50', capSnap.board.pulses.length === 50, String(capSnap.board.pulses.length));
  check('AC4 the cap keeps the newest 50', capSnap.board.pulses[0]?.id === 'PL-100' && capSnap.board.pulses[49]?.id === 'PL-51', `${capSnap.board.pulses[0]?.id}/${capSnap.board.pulses[49]?.id}`);
  check('AC4 status pulseCount reports the persisted ring', capSnap.autopilot.pulseCount === 50 && capSnap.autopilot.lastPulse?.id === 'PL-100', `${capSnap.autopilot.pulseCount}/${capSnap.autopilot.lastPulse?.id}`);
  await capped.app.action('autopilot', { op: 'configure', patch: {} });
  const cappedDisk = await readBoardFile(capped.stateDir);
  check('AC4 the trimmed ring is persisted', cappedDisk.pulses.length === 50 && cappedDisk.pulses[0].id === 'PL-100', String(cappedDisk.pulses.length));
  const cappedRestart = makeApp({ stateDir: capped.stateDir, root: '/tmp/fixture' });
  const restartSnap = await cappedRestart.state();
  check('AC4 pulse history survives restart', restartSnap.board.pulses.length === 50 && restartSnap.board.pulses[0].id === 'PL-100', String(restartSnap.board.pulses.length));
}

// ---------------------------------------------------------------------------
// AC 5 — persisted budget counters, remaining allowance and reset time
// ---------------------------------------------------------------------------
console.log('\n## AC 5 — budget windows');
{
  let fakeNow = T;
  const { stateDir, app } = await freshApp(() => fakeNow);
  const board = fixtureBoard(3);
  board.autopilot = {
    version: 1,
    enabled: false,
    cadenceMs: 300000,
    maxReadyDepth: 3,
    laneCaps: { refine: 1, implement: 1, review: 1 },
    maxDispatchesPerPulse: 1,
    budget: {
      hour: { limit: 20, used: 5, windowStart: T - 600000 },
      day: { limit: 60, used: 5, windowStart: T - 3_600_000 },
    },
    backoffMs: 300000,
    staleMs: 600000,
    updatedAt: 0,
    updatedBy: 'system',
  };
  await writeBoard(stateDir, board);
  const beforeBytes = await readFile(boardFile(stateDir), 'utf8');
  const status = await app.action('autopilot', { op: 'status' });
  const remaining = status.json?.value?.budgetRemaining;
  check(
    'AC5 status reports the remaining hourly allowance and reset time',
    remaining?.hour?.used === 5 && remaining.hour.remaining === 15 && remaining.hour.resetsAt === T - 600000 + 60 * 60 * 1000,
    brief(remaining?.hour),
  );
  check(
    'AC5 status reports the remaining daily allowance and reset time',
    remaining?.day?.used === 5 && remaining.day.remaining === 55 && remaining.day.resetsAt === T - 3_600_000 + 24 * 60 * 60 * 1000,
    brief(remaining?.day),
  );
  check('AC5 status is read-only (file unchanged)', (await readFile(boardFile(stateDir), 'utf8')) === beforeBytes);

  const configured = await app.action('autopilot', { op: 'configure', patch: { budget: { hour: 30 } } });
  check('AC5 configure can raise the hourly limit', configured.status === 200 && configured.json.value.config.budget.hour === 30, `${configured.status} ${brief(configured.json?.value?.config?.budget)}`);
  check('AC5 configure preserves used/windowStart', configured.json.value.budgetRemaining.hour.used === 5 && configured.json.value.budgetRemaining.hour.remaining === 25, brief(configured.json.value.budgetRemaining.hour));
  const configuredDisk = await readBoardFile(stateDir);
  check(
    'AC5 budget counters and timestamps are persisted',
    configuredDisk.autopilot.budget.hour.limit === 30 &&
      configuredDisk.autopilot.budget.hour.used === 5 &&
      configuredDisk.autopilot.budget.hour.windowStart === T - 600000,
    brief(configuredDisk.autopilot.budget.hour),
  );

  // A rollover: the persisted window has elapsed, so the read reports a fresh
  // allowance and the next write persists the new window start.
  fakeNow = T + 2 * 60 * 60 * 1000;
  const rolledStatus = await app.action('autopilot', { op: 'status' });
  check(
    'AC5 an expired window reads as a fresh allowance',
    rolledStatus.json.value.budgetRemaining.hour.used === 0 &&
      rolledStatus.json.value.budgetRemaining.hour.remaining === 30 &&
      rolledStatus.json.value.budgetRemaining.hour.resetsAt === fakeNow + 60 * 60 * 1000,
    brief(rolledStatus.json.value.budgetRemaining.hour),
  );
  await app.action('autopilot', { op: 'configure', patch: {} });
  const rolledDisk = await readBoardFile(stateDir);
  check(
    'AC5 the write path persists the rolled-over window',
    rolledDisk.autopilot.budget.hour.used === 0 && rolledDisk.autopilot.budget.hour.windowStart === fakeNow,
    brief(rolledDisk.autopilot.budget.hour),
  );
}

// ---------------------------------------------------------------------------
// AC 6 — additive snapshot: autopilot object and ticket.reviews
// ---------------------------------------------------------------------------
console.log('\n## AC 6 — snapshot read model');
{
  const { stateDir, app } = await freshApp();
  const board = fixtureBoard(3);
  board.tickets[0].reviews = Array.from({ length: 25 }, (_, index) => ({
    id: `rv-${index + 1}`,
    at: T - (25 - index) * 1000,
    verdict: index % 2 === 0 ? 'approve' : 'changes-requested',
    by: 'reviewer',
    notes: `review ${index + 1}`,
  }));
  // A ticket written before review verdicts existed reads as an empty list.
  board.tickets.push({ ...board.tickets[0], id: 'KB-2', number: 2, title: 'No reviews yet', reviews: undefined });
  delete board.tickets[1].reviews;
  board.pulses = [
    { id: 'PL-2', at: T - 1000, trigger: 'manual', decisions: [], dispatched: [], error: '' },
    { id: 'PL-1', at: T - 9000, trigger: 'timer', decisions: [], dispatched: [], error: '' },
  ];
  await writeBoard(stateDir, board);
  const snap = await app.state();
  check(
    'AC6 snapshot gains the additive autopilot object',
    same(Object.keys(snap.autopilot).sort(), ['budgetRemaining', 'config', 'lastPulse', 'nextTickAt', 'pulseCount']),
    brief(Object.keys(snap.autopilot)),
  );
  check('AC6 snapshot autopilot config matches board config', same(snap.autopilot.config, DEFAULTS), brief(snap.autopilot.config));
  check('AC6 snapshot reports the pulse count and last pulse', snap.autopilot.pulseCount === 2 && snap.autopilot.lastPulse.id === 'PL-2', `${snap.autopilot.pulseCount}/${snap.autopilot.lastPulse?.id}`);
  const reviews = snap.board.tickets[0].reviews;
  check('AC6 ticket.reviews keeps the newest 20', reviews.length === 20, String(reviews.length));
  check('AC6 ticket.reviews is newest first', reviews[0].id === 'rv-25' && reviews[19].id === 'rv-6', `${reviews[0]?.id}/${reviews[19]?.id}`);
  check('AC6 existing ticket shapes are unchanged', snap.board.tickets[0].title === 'Legacy ticket' && snap.board.tickets[0].comments[0].text === 'legacy comment', brief(snap.board.tickets[0].comments));
  const noReviews = snap.board.tickets.find((ticket) => ticket.id === 'KB-2');
  check('AC6 a ticket with no review history reads as []', Array.isArray(noReviews?.reviews) && noReviews.reviews.length === 0, brief(noReviews?.reviews));
  // The read caps the list in memory; the next save persists the bounded shape.
  await app.action('autopilot', { op: 'configure', patch: {} });
  const persistedTicket = (await readBoardFile(stateDir)).tickets[0];
  check('AC6 the next save persists the bounded reviews list', Array.isArray(persistedTicket.reviews) && persistedTicket.reviews.length === 20, String(persistedTicket.reviews?.length));
}

// ---------------------------------------------------------------------------
// AC 7 — board version 3, v1/v2/v3 fixtures, older-reader compatibility
// ---------------------------------------------------------------------------
console.log('\n## AC 7 — v1/v2/v3 fixtures and old-reader compatibility');
for (const version of [1, 2, 3]) {
  const { stateDir, app } = await freshApp();
  await writeBoard(stateDir, fixtureBoard(version));
  const snap = await app.state();
  check(`AC7 v${version} fixture loads without throwing`, Boolean(snap.board));
  check(`AC7 v${version} board is migrated to version 3`, snap.board.version === 3 && snap.version === 3, `${snap.board.version}/${snap.version}`);
  check(`AC7 v${version} tickets/comments/activity preserved`, snap.board.tickets.length === 1 && snap.board.tickets[0].comments[0].text === 'legacy comment' && snap.board.activity.some((entry) => entry.id === 'ba1'), brief(snap.board.tickets.length));
  check(`AC7 v${version} team is preserved or seeded`, Array.isArray(snap.board.team.members) && snap.board.team.members.length >= 1, String(snap.board.team.members.length));
  check(`AC7 v${version} autopilot defaults are synthesized`, same(snap.autopilot.config, DEFAULTS), brief(snap.autopilot.config));
  const migratedDisk = await readBoardFile(stateDir);
  check(`AC7 v${version} persisted board stays version 3`, migratedDisk.version === 3, String(migratedDisk.version));
  // v1/v2 are rewritten to v3 on read, so the additive envelope lands then; a
  // valid v3 board is left byte-stable until the first write (AC 1).
  if (version < 3) {
    check(`AC7 v${version} migration persists the additive envelope`, migratedDisk.autopilot?.version === 1, brief(migratedDisk.autopilot?.version));
  } else {
    check(`AC7 v${version} read does not write the additive envelope`, !('autopilot' in migratedDisk), Object.keys(migratedDisk).join(','));
    await app.action('autopilot', { op: 'configure', patch: {} });
    const savedDisk = await readBoardFile(stateDir);
    check(`AC7 v${version} first write persists the additive envelope`, savedDisk.autopilot?.version === 1 && savedDisk.version === 3);
  }
}

{
  // A board written by this branch, then projected to what the previous v3
  // reader saw. The previous commit on disk (`HEAD`) predates board v3 and would
  // reset a v3 board by design, so "previous commit" compatibility is proven
  // against the v3 reader this branch extends: it ignores `board.autopilot`,
  // `board.pulses` and `ticket.reviews`, and every legacy shape must be intact.
  const { stateDir, app } = await freshApp();
  const fixture = fixtureBoard(3);
  await writeBoard(stateDir, fixture);
  await app.state();
  const configured = await app.action('autopilot', { op: 'configure', patch: { enabled: true } });
  check('AC7 configure before the compatibility read succeeds', configured.status === 200, String(configured.status));
  const written = await readBoardFile(stateDir);
  const projected = JSON.parse(JSON.stringify(written));
  delete projected.autopilot;
  delete projected.pulses;
  for (const ticket of projected.tickets) delete ticket.reviews;
  check('AC7 old reader keeps board version 3', projected.version === 3, String(projected.version));
  check(
    'AC7 old reader sees exactly the pre-existing board keys',
    same(Object.keys(projected).sort(), Object.keys(fixture).sort()),
    brief(Object.keys(projected).sort()),
  );
  check('AC7 old reader keeps tickets', projected.tickets.length === 1 && projected.tickets[0].id === 'KB-1' && projected.tickets[0].title === 'Legacy ticket', brief(projected.tickets.map((ticket) => ticket.id)));
  check('AC7 old reader keeps comments', projected.tickets[0].comments[0]?.text === 'legacy comment', brief(projected.tickets[0].comments));
  check('AC7 old reader keeps ticket activity', projected.tickets[0].activity.some((entry) => entry.id === 'ta1'), brief(projected.tickets[0].activity));
  check('AC7 old reader keeps board activity', projected.activity.some((entry) => entry.id === 'ba1'), brief(projected.activity.map((entry) => entry.id)));
  check('AC7 old reader keeps the team roster', projected.team.members.some((member) => member.id === 'member-be-developer'), brief(projected.team.members.map((member) => member.id)));
}

// ---------------------------------------------------------------------------
// Persistence — concurrent configures stay atomic and serialized
// ---------------------------------------------------------------------------
console.log('\n## Persistence — concurrent writes');
{
  const { stateDir, app } = await freshApp();
  await app.state();
  // BoardStore serializes its per-workspace write chain (temp file + rename);
  // KB-68 adds no writer of its own, so concurrent configures must leave one
  // valid board and no temp artefacts behind.
  await Promise.all([
    app.action('autopilot', { op: 'configure', patch: { cadenceMs: 120000 } }),
    app.action('autopilot', { op: 'configure', patch: { maxReadyDepth: 7 } }),
    app.action('autopilot', { op: 'configure', patch: { laneCaps: { review: 2 } } }),
  ]);
  const files = await readdir(stateDir);
  check('concurrent writes leave no temp file behind', files.filter((name) => name.includes('.tmp-')).length === 0, files.join(','));
  const disk = await readBoardFile(stateDir);
  check('concurrent writes leave a valid v3 board', disk.version === 3 && disk.autopilot.version === 1 && Array.isArray(disk.tickets), `v${disk.version}`);
  const status = await app.action('autopilot', { op: 'status' });
  check(
    'serialized patches are all applied',
    status.json.value.config.cadenceMs === 120000 && status.json.value.config.maxReadyDepth === 7 && status.json.value.config.laneCaps.review === 2,
    brief(status.json.value.config),
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log('\n' + (failures.length === 0 ? 'ALL AUTOPILOT SCHEMA CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
for (const dir of dirs) await rm(dir, { recursive: true, force: true });
Date.now = realDateNow;
process.exit(failures.length === 0 ? 0 : 1);
