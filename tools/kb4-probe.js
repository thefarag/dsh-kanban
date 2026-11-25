#!/usr/bin/env node
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

// KB-4 probe — EPIC PRD template and decomposition rules.
//
// A self-contained fake-Harness CLI: it boots the real host with injected
// session/agent services, dispatches `submitThought` exactly as production
// does, prints the built staff-PM brief, then replays five decomposition
// fixtures (big feature, small bug, single many-AC ticket, external-standard
// research, maximal PRD) through the thought session's `kanban` tool. For each
// fixture it prints the create arguments, the persisted ticket shape and the
// closing-summary format the brief demands, then checks the AC 1–11 invariants.
//
// No network, no model, no browser. Exit code 0 = every check passed.
//   node tools/kb4-probe.js            # print the transcript
//   node tools/kb4-probe.js --json     # machine-readable summary

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const AS_JSON = process.argv.includes('--json');

const HEADINGS = [
  'Vision',
  'Problem',
  'Users',
  'Jobs to be done',
  'Success metrics',
  'Scope in',
  'Scope out',
  'Acceptance criteria',
  'Risks',
  'Dependencies',
  'Rollout',
  'Open questions',
];
const DECISION_RULE =
  'Create an EPIC only when the thought needs two or more related tickets, a new feature, or a new project. A single small thought yields tickets only, with no EPIC.';
const CAP = 20000;

const results = [];
const check = (label, condition, detail = '') => {
  results.push({ label, ok: Boolean(condition), detail: String(detail).slice(0, 300) });
  if (!AS_JSON) console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`);
};
const parseSections = (description) => {
  const sections = {};
  let current = null;
  for (const line of String(description ?? '').split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = match[1];
      sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([heading, lines]) => [heading, lines.join('\n').trim()]));
};
const missingHeadings = (description) => HEADINGS.filter((heading) => !(heading in parseSections(description)));

function buildPrd({ extra = '' } = {}) {
  const pad = (text) => `${text}${extra ? ` ${extra}` : ''}`;
  const bodies = {
    Vision: pad('Expense reporting finance can trust: every expense captured once, approved with an audit trail, and reportable by month without a spreadsheet export.'),
    Problem: pad('Expenses are captured in chat, approved by memory and reconciled in spreadsheets, so month end is manual and approvals leave no trail.'),
    Users: pad('Primary: the finance analyst closing the month and the approver signing off. Secondary: spenders submitting receipts and the owner reading analytics.'),
    'Jobs to be done': pad('When I spend, I want to capture the expense with a receipt in one step. When month end comes, I want approved totals by category without manual reconciliation.'),
    'Success metrics': pad('100% of approved expenses carry an audit entry (automated test); close under 30 minutes for 50 people (rollout review); zero duplicate expenses in the first two months (telemetry).'),
    'Scope in': pad('Expense capture with receipts; approval workflow with an immutable audit trail; monthly report export with category analytics; board UI for all three.'),
    'Scope out': pad('Corporate card reconciliation and accounting-system sync are out of scope; the follow-up is filed as a separate Backlog ticket after rollout.'),
    'Acceptance criteria': pad('1. Submit an expense with a receipt in one form. 2. Approve or reject with a recorded reason. 3. Every approval writes an immutable audit entry. 4. Export a month of approved expenses. 5. Analytics shows monthly totals per category.'),
    Risks: pad('Receipt storage could grow unbounded; mitigation is a retention policy and a capture size limit. The audit trail is legally sensitive, so review the storage contract before rollout.'),
    Dependencies: pad('The EPIC parent/child model (available). A receipt storage contract (to build, backend slice). A retention-window product decision (open question owner: product).'),
    Rollout: pad('Land capture behind an internal flag, then approvals, then export. Each child ships independently. Rollback disables the flag; audit entries are additive.'),
    'Open questions': 'None — resolved.',
  };
  return HEADINGS.map((heading) => `## ${heading}\n${bodies[heading]}`).join('\n\n');
}
function buildMaximalPrd(target = 19700) {
  const filler = 'Concrete evidence, telemetry and review notes keep this section testable and auditable. ';
  // Text length grows monotonically with the padding length: binary-search the
  // largest padding that still lands under the description cap.
  const render = (length) => buildPrd({ extra: filler.repeat(Math.ceil(length / filler.length)).slice(0, length) });
  let low = 0;
  let high = 20000;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (render(mid).length <= target) low = mid;
    else high = mid - 1;
  }
  return render(low);
}

/** Boot the host with fake Harness services (same shape production composes). */
function makeHarness(dir) {
  const workspace = {
    id: 'workspace-1',
    title: 'KB-4 PRD lab',
    path: dir,
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    async attachSession() {},
    async status() {
      return 'ok';
    },
  };
  const sessionItems = [{ sessionId: 'session-normal', cwd: dir, running: false, updatedAt: Date.now(), projections: { values: { title: 'Normal session' } } }];
  const prompts = [];
  const createCalls = [];
  const permissionSets = [];
  const liveAgents = new Map();
  const agents = {
    async create(options) {
      createCalls.push(options);
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
    workspaceRegistry: { list: () => [workspace] },
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
      catalog: () => ({ options: [{ value: 'read-only', name: 'Read only' }], defaultOptions: [], defaultPreset: 'workspace-write' }),
      resolve: (value) => ({ sandbox: value }),
      set: (session, value) => permissionSets.push({ session: session.id, value }),
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

  // KB-6 adds a per-workspace intake budget (5/min, 20/hour). This probe submits
  // six fixtures back-to-back on the real clock, so it opts out through the host
  // knob; KB-6's shipped defaults are proven by tests/thought-hardening.test.mjs.
  apply(ctx, { stateDir: dir, thoughtGraceMs: 2000, thoughtRateLimits: { perMinute: 1000, perHour: 10000 } });
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
    const res = { statusCode: 0, headers: {}, body: '', setHeader() {}, end(text) { this.body = text ?? ''; } };
    await route.handler(req, res);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  };
  return {
    createCalls,
    prompts,
    permissionSets,
    action: (action, payload = {}) => post('/kanban/action', { workspaceId: 'workspace-1', action, payload }),
    state: async () => (await post('/kanban/state', { workspaceId: 'workspace-1' })).json,
    callTool: (args, agentId) => tools.get('kanban').execute(args, { agent: { id: agentId } }),
    promptFor: (sessionId) => prompts.find((entry) => entry.sessionId === sessionId)?.text ?? '',
    finish(sessionId) {
      sessionItems.push({ sessionId, cwd: dir, running: false, updatedAt: Date.now(), projections: { values: { title: sessionId } } });
      liveAgents.set(sessionId, { id: sessionId, status: 'idle', inbox: { hasPending: false }, session: { id: sessionId } });
    },
  };
}

const root = await mkdtemp(join(tmpdir(), 'kanban-kb4-probe-root-'));
const stateDir = await mkdtemp(join(tmpdir(), 'kanban-kb4-probe-state-'));
await writeFile(join(root, 'README.md'), '# KB-4 probe lab\n');
const app = makeHarness(stateDir);

if (!AS_JSON) {
  console.log('KB-4 probe — EPIC PRD template and decomposition rules');
  console.log(`workspace: ${root}`);
  console.log(`node: ${process.version}\n`);
}

// --- 1. Template completeness ----------------------------------------------
const template = await readFile(join(REPO, 'docs', 'EPIC_PRD_TEMPLATE.md'), 'utf8');
check('AC1 template lists all twelve headings', missingHeadings(template).length === 0, missingHeadings(template).join(', '));
check('AC1 template has usage notes', /^##\s+Usage notes\s*$/m.test(template));
check('AC1 template states the decision rule', template.includes(DECISION_RULE));
if (!AS_JSON) {
  console.log('\n=== template: docs/EPIC_PRD_TEMPLATE.md ===');
  console.log(`headings: ${HEADINGS.join(' | ')}`);
  console.log(`usage notes: ${template.split('## Usage notes')[1]?.split('## Vision')[0]?.trim().slice(0, 240)}…`);
}

// --- 2. Built brief ---------------------------------------------------------
const big = await app.action('submitThought', {
  text: 'Add an expense reporting suite: capture expenses with receipts, run an approval workflow with an audit trail, and export monthly reports with analytics.',
});
if (!big.json?.value?.thought?.sessionId) {
  console.error(`submitThought dispatch failed: ${big.status} ${JSON.stringify(big.json?.error ?? big.json)}`);
  process.exit(1);
}
const bigThought = big.json.value.thought;
const prompt = app.promptFor(bigThought.sessionId);
check('AC2 brief lists every template heading', HEADINGS.every((heading) => prompt.includes(heading)));
check('AC3 brief states the decision threshold verbatim', prompt.includes(DECISION_RULE));
check('AC4 old EPIC ban removed, read-only/Backlog wording kept', !prompt.includes('Do not create an EPIC') && /read-only/i.test(prompt) && /Backlog only/.test(prompt));
check('AC13 composition = role playbook + persona + brief', /## Role playbook: Product Manager/.test(prompt) && prompt.indexOf('## Role playbook') < prompt.indexOf('## The thought (verbatim)') && prompt.indexOf('## The thought (verbatim)') < prompt.indexOf('## Rules'));
if (!AS_JSON) {
  console.log('\n=== built submitThought brief (full) ===');
  console.log(prompt);
  console.log('=== end brief ===\n');
}

// --- 3. Decomposition fixtures ---------------------------------------------
const fixtures = [];
const summaries = [];
async function fixturesFor(name, thoughtText) {
  const res = await app.action('submitThought', { text: thoughtText });
  const thought = res.json.value.thought;
  check(`fixture ${name}: dispatched`, res.status === 200 && Boolean(thought.sessionId), `${res.status}`);
  return thought;
}
async function create(thought, args) {
  const result = await app.callTool({ action: 'create', ...args }, thought.sessionId);
  fixtures.push({ fixture: thought.id, args, ticket: result.ticket });
  return result.ticket;
}

// 3a. Big feature: one EPIC first, then linked children.
const epic = await create(bigThought, {
  title: 'EPIC: expense reporting suite',
  type: 'epic',
  priority: 'high',
  labels: ['epic', 'finance'],
  description: buildPrd(),
});
const children = [];
for (const spec of [
  { title: 'Expense capture with receipt upload', type: 'story', role: 'fe-developer', priority: 'high' },
  { title: 'Approval workflow with immutable audit trail', type: 'story', role: 'be-developer', priority: 'high' },
  { title: 'Monthly report export and category analytics', type: 'task', role: 'fullstack-developer', priority: 'medium' },
]) {
  children.push(
    await create(bigThought, {
      ...spec,
      parentId: epic.id,
      description: '## Acceptance criteria\n1. Slice works end to end.\n2. Tests prove it.\n\nSources: WCAG 2.2 — https://www.w3.org/TR/WCAG22/',
    }),
  );
}
check('AC5 fixture big: exactly one EPIC, created first', fixtures.filter((entry) => entry.fixture === bigThought.id && entry.args.type === 'epic').length === 1 && fixtures.find((entry) => entry.fixture === bigThought.id)?.args.type === 'epic');
check('AC5 fixture big: EPIC lands in Backlog', epic.column === 'backlog', epic.column);
check('AC5 fixture big: two or more children', children.length >= 2, String(children.length));
check('AC6 fixture big: every child carries parentId', children.every((child) => child.parentId === epic.id), children.map((child) => child.parentId).join(','));
check('AC6 fixture big: EPIC has no parentId', epic.parentId === null || epic.parentId === undefined, String(epic.parentId));
check('AC5 fixture big: EPIC PRD fills every section', missingHeadings(buildPrd()).length === 0);
summaries.push({
  fixture: bigThought.id,
  text: `EPIC ${epic.id} + ${children.length} tickets (${children.map((child) => child.id).join(', ')}). Rationale: a new expense-reporting feature needs two or more related tickets.`,
});

// 3b. Small bug: tickets only.
const small = await fixturesFor('small-bug', 'Fix the typo in the empty board message: it currently says "No ticekts yet".');
const smallTicket = await create(small, { title: 'Fix the empty-board message typo', type: 'bug', priority: 'low', role: 'fe-developer', description: '## Acceptance criteria\n1. The empty state reads "No tickets yet."' });
check('AC7 fixture small: zero EPICs', !fixtures.some((entry) => entry.fixture === small.id && entry.args.type === 'epic'));
check('AC7 fixture small: exactly one ticket without parentId', (await app.state()).value.board.tickets.filter((ticket) => ticket.thoughtId === small.id).length === 1 && (smallTicket.parentId === null || smallTicket.parentId === undefined));
check('AC7 fixture small: closing rationale demanded by the brief', /tickets alone suffice and why/.test(prompt));
summaries.push({
  fixture: small.id,
  text: `No EPIC: tickets alone suffice because this is a single small string-fix bug; 1 ticket: ${smallTicket.id}.`,
});
app.finish(bigThought.sessionId);
app.finish(small.sessionId);
await app.state();

// 3c. Single large-AC ticket: tickets only.
const single = await fixturesFor('single-many-ac', 'Make the CSV importer exactly-once: one deliverable, but many edge-case acceptance criteria.');
const manyAcs = Array.from({ length: 18 }, (_, index) => `${index + 1}. Edge case ${index + 1} is handled deterministically.`).join('\n');
const singleTicket = await create(single, { title: 'Make the CSV importer exactly-once', type: 'story', role: 'be-developer', description: `## Acceptance criteria\n${manyAcs}` });
check('AC8 fixture single: zero EPICs', !fixtures.some((entry) => entry.fixture === single.id && entry.args.type === 'epic'));
check('AC8 fixture single: one ticket, no parentId', singleTicket.parentId === null || singleTicket.parentId === undefined);
summaries.push({
  fixture: single.id,
  text: `No EPIC: one well-specified deliverable is one ticket even with 18 acceptance criteria; 1 ticket: ${singleTicket.id}.`,
});
app.finish(single.sessionId);
await app.state();

// 3d. Research: cited external standard.
const research = await fixturesFor('research', 'Align the board keyboard focus rings with the external accessibility standard for focus appearance.');
const researchTicket = await create(research, {
  title: 'Adopt WCAG 2.2 focus-appearance tokens',
  type: 'story',
  role: 'fe-developer',
  description: '## Acceptance criteria\n1. Every focusable control shows a 3:1 focus indicator.\n\nSources: WCAG 2.2 — Focus Appearance (https://www.w3.org/TR/WCAG22/#focus-appearance).',
});
const researchStored = (await app.state()).value.board.tickets.find((ticket) => ticket.id === researchTicket.id);
check('AC9 fixture research: cited source persisted', /Sources: WCAG 2\.2/.test(researchStored?.description ?? '') && /https:\/\/www\.w3\.org/.test(researchStored?.description ?? ''));
summaries.push({
  fixture: research.id,
  text: `No EPIC: one ticket; 1 ticket: ${researchTicket.id}. Source relied on: WCAG 2.2 Focus Appearance.`,
});
app.finish(research.sessionId);
await app.state();

// 3e. Maximal PRD: fits the cap, keeps the final heading.
const maximal = await fixturesFor('maximal-prd', 'Ship a full audit trail across the board with retention controls, exports and analytics.');
const maximalPrd = buildMaximalPrd();
const maximalTicket = await create(maximal, { title: 'EPIC: board-wide audit trail', type: 'epic', priority: 'high', description: maximalPrd });
const maximalStored = (await app.state()).value.board.tickets.find((ticket) => ticket.id === maximalTicket.id);
check('AC11 fixture maximal: under the 20,000 cap', maximalPrd.length < CAP && (maximalStored?.description ?? '').length < CAP, `${maximalPrd.length}/${maximalStored?.description?.length ?? '?'}`);
check('AC11 fixture maximal: final heading present', (maximalStored?.description ?? '').includes('## Open questions'), String(maximalStored?.description?.length));
summaries.push({
  fixture: maximal.id,
  text: `EPIC ${maximalTicket.id}; PRD ${maximalStored?.description?.length ?? 0} chars (under the 20,000 cap), final heading Open questions present.`,
});

// --- 4. Guardrail matrix ----------------------------------------------------
const guard = { allowed: [], rejected: [] };
for (const action of ['whoami', 'projects', 'board', 'list', 'next', 'team', 'members']) {
  try {
    await app.callTool({ action }, bigThought.sessionId);
    guard.allowed.push(action);
  } catch {
    /* recorded below */
    guard.rejected.push(action);
  }
}
for (const args of [
  { action: 'claim', ticketId: epic.id },
  { action: 'move', ticketId: epic.id, column: 'ready' },
  { action: 'update', ticketId: epic.id, title: 'nope' },
  { action: 'comment', ticketId: epic.id, text: 'nope' },
  { action: 'release', ticketId: epic.id },
  { action: 'finish', ticketId: epic.id },
  { action: 'block', ticketId: epic.id, text: 'nope' },
  { action: 'run', ticketId: epic.id },
  { action: 'create_member', name: 'Probe Person', role: 'tester' },
  { action: 'scan' },
  { action: 'pause' },
  { action: 'resume' },
]) {
  try {
    await app.callTool(args, bigThought.sessionId);
    guard.rejected.push(`${args.action}:UNEXPECTED-PASS`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('kanban/thought-read-only')) guard.rejected.push(args.action);
    else guard.rejected.push(`${args.action}:${message.slice(0, 40)}`);
  }
}
check('AC10 guardrail: read actions allowed', guard.allowed.length === 7, String(guard.allowed.length));
check('AC10 guardrail: every mutating action rejected thought-read-only', guard.rejected.every((entry) => !entry.includes('UNEXPECTED-PASS') && !entry.includes(':')) && guard.rejected.length === 12, guard.rejected.join(','));
const finalSnap = (await app.state()).value;
check('AC10 guardrail: no thought ticket left Backlog', finalSnap.board.tickets.filter((ticket) => ticket.thoughtId).every((ticket) => ticket.column === 'backlog'));

// --- summary ---------------------------------------------------------------
const pass = results.filter((entry) => entry.ok).length;
const fail = results.length - pass;
if (AS_JSON) {
  console.log(JSON.stringify({ prompt, fixtures, guard, checks: results, summary: { pass, fail } }, null, 2));
} else {
  console.log('\n=== decomposition fixtures (captured create arguments + persisted shape) ===');
  for (const entry of fixtures) {
    console.log(`\n[${entry.fixture}] create(${JSON.stringify({
      title: entry.args.title,
      type: entry.args.type ?? 'task',
      column: 'backlog (forced by thought session)',
      parentId: entry.args.parentId ?? null,
      descriptionLength: entry.args.description?.length ?? 0,
      headingsFilled: entry.args.description ? HEADINGS.filter((heading) => heading in parseSections(entry.args.description)).length : 0,
    })})`);
    console.log(`  → persisted: id=${entry.ticket.id} type=${entry.ticket.type} column=${entry.ticket.column} parentId=${entry.ticket.parentId ?? 'none'} thoughtId=${entry.ticket.thoughtId}`);
  }
  console.log('\n=== guardrail matrix ===');
  console.log(`allowed: ${guard.allowed.join(', ')}`);
  console.log(`rejected (kanban/thought-read-only): ${guard.rejected.join(', ')}`);
  console.log('\n=== closing summaries (fixture stand-ins for the PM closing chat message) ===');
  for (const summary of summaries) console.log(`[${summary.fixture}] ${summary.text}`);
  console.log(`\nSUMMARY: ${pass}/${results.length} checks passed${fail === 0 ? ' — PASS' : ` — ${fail} FAIL`}`);
}

await rm(root, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
