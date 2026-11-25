import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../index.js';

// KB-4 — EPIC PRD template and decomposition rules.
//
// Fake Harness: `submitThought` is dispatched through the real host against
// injected agents/session services, so the built prompt and the staff-PM tool
// calls are observed exactly as they are in production. The staff product
// manager is scripted from each fixture (there is no network and no model):
// the test proves the brief carries the standard, that the host accepts and
// persists the intended decomposition (EPIC-first + parentId linkage), and
// that the thought-session guardrail still confines the PM to read + create.
//
// Covers AC 1–11 and AC 13. AC 12/14/15 are mechanical evidence (isolated
// diff, node --check, full suite run) recorded on the ticket.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

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
const DESCRIPTION_CAP = 20000;

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};
const brief = (value) => String(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 200);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Split a PRD description into `## Heading` -> body. */
function parseSections(description) {
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
}

const missingHeadings = (description) => HEADINGS.filter((heading) => !(heading in parseSections(description)));
/** The brief lists the headings inline rather than as `##` sections. */
const headingsNotListed = (text) => HEADINGS.filter((heading) => !String(text ?? '').includes(heading));
const blankHeadings = (description) => {
  const sections = parseSections(description);
  return HEADINGS.filter((heading) => heading in sections && !sections[heading]);
};
const tbdOutsideOpenQuestions = (description) => {
  const sections = parseSections(description);
  return HEADINGS.filter(
    (heading) => heading !== 'Open questions' && heading in sections && /\bTBD\b|\bTODO\b/i.test(sections[heading]),
  );
};

/** A realistic, fully filled EPIC PRD. `extra` pads every non-Open-questions section. */
function buildPrd({ extra = '' } = {}) {
  const pad = (text) => `${text}${extra ? ` ${extra}` : ''}`;
  const bodies = {
    Vision: pad(
      'Expense reporting finance can trust: every expense is captured once, approved with an audit trail, and reportable by month without a spreadsheet export.',
    ),
    Problem: pad(
      'Expenses are captured in chat, approved by memory and reconciled in spreadsheets. Finance cannot answer "what did we spend on travel in March" without a manual pass, and approvals leave no trail.',
    ),
    Users: pad(
      'Primary: the finance analyst closing the month, and the approver signing off. Secondary: the spenders submitting receipts, and the board owner reading monthly analytics.',
    ),
    'Jobs to be done': pad(
      'When a spender buys something, I want to capture it with a receipt in one step, so I can be reimbursed without chasing forms. When month end comes, I want the approved totals by category, so I can close the books without manual reconciliation.',
    ),
    'Success metrics': pad(
      '100% of approved expenses carry an audit-trail entry (verified by an automated test on the approval action); month-end close under 30 minutes for a 50-person team (measured in the rollout review); zero duplicate expenses in the first two months (telemetry on capture).',
    ),
    'Scope in': pad(
      'Expense capture with receipt attachment; an approval workflow with an immutable audit trail; monthly report export with category analytics; the board UI for all three.',
    ),
    'Scope out': pad(
      'Corporate card reconciliation and accounting-system sync are out of scope; the follow-up will be filed as a separate Backlog ticket after rollout.',
    ),
    'Acceptance criteria': pad(
      '1. A spender can submit an expense with a receipt in one form. 2. An approver can approve or reject with a recorded reason. 3. Every approval writes an audit entry that cannot be edited. 4. Finance can export a month of approved expenses by category. 5. The analytics view shows monthly totals per category.',
    ),
    Risks: pad(
      'Receipt storage could grow without bound; mitigation is a documented retention policy and a size limit in the capture slice. The audit trail is legally sensitive, so the storage contract must be reviewed before rollout.',
    ),
    Dependencies: pad(
      'The board ticket model for parent/child links (available). A storage contract for receipts (to build, owned by the backend slice). A product decision on the retention window (open question owner: product).',
    ),
    Rollout: pad(
      'Land capture first behind an internal flag, then approvals, then export. Each child ships independently. Rollback is disabling the capture flag; the audit entries are additive and need no migration back.',
    ),
    'Open questions': 'None — resolved.',
  };
  return HEADINGS.map((heading) => `## ${heading}\n${bodies[heading]}`).join('\n\n');
}

/** Near-cap PRD: still realistic prose, padded to just under the 20,000-char cap. */
function buildMaximalPrd() {
  let extra = '';
  for (let round = 0; round < 400; round += 1) {
    const text = buildPrd({ extra });
    if (text.length >= 19300) return text;
    extra += 'Concrete evidence, telemetry and review notes keep this section testable and auditable.';
  }
  return buildPrd({ extra });
}

/**
 * Boot one host with fake Harness services. `thoughtGraceMs` is shrunk so the
 * snapshot reconciliation reaches `done` immediately once the fake session is
 * observed stopped (freeing a `working` slot for the next fixture).
 */
function makeHarness(dir, { graceMs = 2000 } = {}) {
  const root = dir;
  const workspace = {
    id: 'workspace-1',
    title: 'Epic PRD lab',
    path: root,
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    async attachSession() {},
    async status() {
      return 'ok';
    },
  };
  const sessionItems = [
    { sessionId: 'session-normal', cwd: root, running: false, updatedAt: Date.now(), projections: { values: { title: 'Normal PM session' } } },
  ];
  const createCalls = [];
  const prompts = [];
  const permissionSets = [];
  const presetMounts = [];
  const renamed = [];
  const liveAgents = new Map();

  const agents = {
    async create(options) {
      createCalls.push(options);
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

  // KB-6 adds a per-workspace intake budget (5/min, 20/hour). This suite submits
  // six fixture thoughts back-to-back, so it opts out through the host knob;
  // tests/thought-hardening.test.mjs exercises the shipped defaults.
  apply(ctx, { stateDir: dir, thoughtGraceMs: graceMs, thoughtRateLimits: { perMinute: 1000, perHour: 10000 } });

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
    permissionSets,
    presetMounts,
    renamed,
    action: (action, payload = {}) => post('/kanban/action', { workspaceId: 'workspace-1', action, payload }),
    state: async () => (await post('/kanban/state', { workspaceId: 'workspace-1' })).json,
    callTool: (args, agentId) => tools.get('kanban').execute(args, { agent: { id: agentId } }),
    promptFor: (sessionId) => prompts.find((entry) => entry.sessionId === sessionId)?.text ?? '',
    /** Mark a dispatched session observable and stopped so reconciliation reaches `done`. */
    finish(sessionId) {
      sessionItems.push({ sessionId, cwd: root, running: false, updatedAt: Date.now(), projections: { values: { title: sessionId } } });
      const agent = liveAgents.get(sessionId);
      if (agent) agent.status = 'idle';
      else liveAgents.set(sessionId, { id: sessionId, status: 'idle', inbox: { hasPending: false }, session: { id: sessionId } });
    },
  };
}

const expectToolError = async (label, fn, code) => {
  try {
    await fn();
    check(label, false, 'no throw');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(label, message.includes(`kanban/${code}`), message.slice(0, 160));
  }
};

const submitThought = async (app, text) => {
  const res = await app.action('submitThought', { text });
  check(`dispatched thought "${text.slice(0, 32)}…"`, res.status === 200 && res.json?.ok === true, `${res.status} ${brief(res.json?.error)}`);
  return res.json.value.thought;
};
const ticketsOfThought = (snap, thoughtId) => snap.board.tickets.filter((ticket) => ticket.thoughtId === thoughtId);
const epicsOfThought = (snap, thoughtId) => ticketsOfThought(snap, thoughtId).filter((ticket) => ticket.type === 'epic');

const root = await mkdtemp(join(tmpdir(), 'kanban-kb4-root-'));
const stateDir = await mkdtemp(join(tmpdir(), 'kanban-kb4-state-'));
await writeFile(join(root, 'README.md'), '# EPIC PRD lab\n');
const app = makeHarness(stateDir);

// ---------------------------------------------------------------------------
// AC 1 — the canonical template exists and is complete.
// ---------------------------------------------------------------------------
const templateText = await readFile(join(REPO, 'docs', 'EPIC_PRD_TEMPLATE.md'), 'utf8');
check('template: all twelve required headings are present', missingHeadings(templateText).length === 0, brief(missingHeadings(templateText)));
check('template: has usage notes', /^##\s+Usage notes\s*$/m.test(templateText));
check('template: usage notes state the decision rule', templateText.includes(DECISION_RULE));
check('template: usage notes name the description cap', /20,000/.test(templateText));
check('template: links back to the shared build spec', templateText.includes('SHARED_BUILD_SPEC.md'));
check('template: usage notes forbid TBD outside Open questions', /no `TBD`|no TBD/i.test(templateText));

// ---------------------------------------------------------------------------
// AC 2/3/4/9/11/13 — the built brief carries the standard.
// ---------------------------------------------------------------------------
const seedPm = (await app.state()).value.roster.find((member) => member.roleId === 'product-manager');
check('seeded product manager available for composition', Boolean(seedPm) && seedPm.name.length > 2, seedPm?.name);

const bigThought = {
  id: 'big',
  text: 'Add an expense reporting suite: capture expenses with receipts, run an approval workflow with an audit trail, and export monthly reports with analytics.',
};
const big = await submitThought(app, bigThought.text);
const bigPrompt = app.promptFor(big.sessionId);
check('AC2: brief lists every template heading', headingsNotListed(bigPrompt).length === 0, brief(headingsNotListed(bigPrompt)));
check('AC3: brief states the decision threshold verbatim', bigPrompt.includes(DECISION_RULE), bigPrompt.slice(0, 120));
check('AC4: old "do not create an EPIC" rule is gone', !bigPrompt.includes('Do not create an EPIC'));
check('AC4: read-only and Backlog-only wording retained', /read-only/i.test(bigPrompt) && /thought-read-only/.test(bigPrompt) && /Backlog only/.test(bigPrompt));
check('AC9: brief requires project-first research and named web sources', /read the board and the project docs/i.test(bigPrompt) && /name the sources you relied on/i.test(bigPrompt));
check('AC11: brief caps the PRD and forbids truncation', /20,000-character description limit/.test(bigPrompt) && /summarise rather than truncate/i.test(bigPrompt));
check('AC5: brief requires one EPIC first with a fully filled PRD', /create exactly one EPIC first/.test(bigPrompt) && /no blank headings/.test(bigPrompt));
check('AC6: brief requires child parentId linkage', /parentId/.test(bigPrompt) && /foreign or non-existent parent/.test(bigPrompt));
check('AC7: brief requires a tickets-only rationale when no EPIC is created', /when no EPIC was created/i.test(bigPrompt) && /tickets alone suffice and why/i.test(bigPrompt));
check('AC10: brief reiterates the read-only restriction', bigPrompt.includes('Do not move, claim, update, release, comment on, run or finish existing tickets'));
check('AC13: role playbook is first, brief appended after the thought',
  /## Role playbook: Product Manager \(`product-manager`\)/.test(bigPrompt) &&
    (seedPm ? bigPrompt.includes(`## Team member: ${seedPm.name}`) : true) &&
    bigPrompt.indexOf('## Role playbook: Product Manager') < bigPrompt.indexOf('## The thought (verbatim)') &&
    bigPrompt.indexOf('## The thought (verbatim)') < bigPrompt.indexOf('## Rules') &&
    bigPrompt.indexOf('## Rules') < bigPrompt.indexOf('## Session contract'),
  String(bigPrompt.length));

// Dispatch unchanged by KB-4: read-only preset, preset mount, session rename.
check('dispatch: read-only preset still applied before prompting', app.permissionSets.some((entry) => entry.session === big.sessionId && entry.value === 'read-only'));
check('dispatch: project preset still mounted', app.presetMounts.includes('default-preset'));

// ---------------------------------------------------------------------------
// AC 5/6 — big feature: one EPIC first in Backlog, then linked children.
// ---------------------------------------------------------------------------
const bigEpicPrd = buildPrd();
const bigCalls = [];
const epicResult = await app.callTool(
  {
    action: 'create',
    title: 'EPIC: expense reporting suite',
    type: 'epic',
    priority: 'high',
    labels: ['epic', 'finance'],
    description: bigEpicPrd,
  },
  big.sessionId,
);
bigCalls.push({ type: 'epic', ticket: epicResult.ticket });
const bigEpicId = epicResult.ticket.id;
check('AC5: PM create accepts type epic', epicResult.ticket.type === 'epic', brief(epicResult.ticket));
check('AC5: EPIC is created in Backlog', epicResult.ticket.column === 'backlog', epicResult.ticket.column);
check('AC5: EPIC carries the thought id (KB-1)', epicResult.ticket.thoughtId === big.id, String(epicResult.ticket.thoughtId));

const childSpecs = [
  { title: 'Expense capture with receipt upload', type: 'story', priority: 'high', role: 'fe-developer', labels: ['fe'] },
  { title: 'Approval workflow with immutable audit trail', type: 'story', priority: 'high', role: 'be-developer', labels: ['be'] },
  { title: 'Monthly report export and category analytics', type: 'task', priority: 'medium', role: 'fullstack-developer', labels: ['fe', 'be'] },
];
for (const spec of childSpecs) {
  const child = await app.callTool(
    {
      action: 'create',
      ...spec,
      parentId: bigEpicId,
      description: `## Acceptance criteria\n1. The slice works end to end.\n2. It has tests.\n\nSources: WCAG 2.2 — https://www.w3.org/TR/WCAG22/`,
    },
    big.sessionId,
  );
  bigCalls.push({ type: spec.type, ticket: child.ticket, args: spec });
}
check('AC5: create order starts with the EPIC', bigCalls[0].type === 'epic', brief(bigCalls.map((entry) => entry.type)));
check('AC5: two or more child tickets follow', bigCalls.filter((entry) => entry.type !== 'epic').length >= 2, String(bigCalls.length - 1));

let snap = (await app.state()).value;
const bigTickets = ticketsOfThought(snap, big.id);
const bigEpics = epicsOfThought(snap, big.id);
const bigChildren = bigTickets.filter((ticket) => ticket.type !== 'epic');
check('AC5: exactly one EPIC for the thought', bigEpics.length === 1, String(bigEpics.length));
check('AC5: EPIC is in Backlog in the snapshot', bigEpics[0]?.column === 'backlog', bigEpics[0]?.column);
check('AC5: EPIC description fills every template section', missingHeadings(bigEpics[0]?.description).length === 0, brief(missingHeadings(bigEpics[0]?.description)));
check('AC5: EPIC description has no blank headings', blankHeadings(bigEpics[0]?.description).length === 0, brief(blankHeadings(bigEpics[0]?.description)));
check('AC5: EPIC description has no TBD outside Open questions', tbdOutsideOpenQuestions(bigEpics[0]?.description).length === 0, brief(tbdOutsideOpenQuestions(bigEpics[0]?.description)));
check('AC5: EPIC description keeps the Open questions section last', bigEpics[0]?.description.lastIndexOf('## ') === bigEpics[0]?.description.indexOf('## Open questions'), String(bigEpics[0]?.description.lastIndexOf('## ')));
check('AC6: every child carries parentId = the EPIC id', bigChildren.length >= 2 && bigChildren.every((ticket) => ticket.parentId === bigEpicId), brief(bigChildren.map((ticket) => ticket.parentId)));
check('AC6: the EPIC itself has no parentId', !('parentId' in (bigEpics[0] ?? {})), brief(Object.keys(bigEpics[0] ?? {})));
check('AC6: children are created after the EPIC', Math.min(...bigChildren.map((ticket) => ticket.number)) > bigEpics[0]?.number, `${bigEpics[0]?.number} vs ${bigChildren.map((ticket) => ticket.number)}`);
check('AC6: every parentId resolves to an existing EPIC', bigTickets.every((ticket) => !ticket.parentId || snap.board.tickets.some((candidate) => candidate.id === ticket.parentId && candidate.type === 'epic')));
check('AC6: all thought tickets are in Backlog', bigTickets.every((ticket) => ticket.column === 'backlog'), brief(bigTickets.map((ticket) => ticket.column)));
check('AC6: every ticket carries the thought id', bigTickets.every((ticket) => ticket.thoughtId === big.id), brief(bigTickets.map((ticket) => ticket.thoughtId)));
check('AC9: cited sources persist in the child description', bigChildren.some((ticket) => /Sources: .*https?:\/\//.test(ticket.description ?? '')), brief(bigChildren.map((ticket) => ticket.description).find((text) => /Sources:/.test(text ?? ''))));

await expectToolError('AC6: a foreign parent id is rejected with ticket/parent-invalid', () => app.callTool({ action: 'create', title: 'Orphan slice', parentId: 'KB-999' }, big.sessionId), 'ticket/parent-invalid');
snap = (await app.state()).value;
check('AC6: the rejected child leaves no ticket behind', ticketsOfThought(snap, big.id).length === bigTickets.length, String(ticketsOfThought(snap, big.id).length));

// ---------------------------------------------------------------------------
// AC 10 — the PM stays read-only and Backlog-only.
// ---------------------------------------------------------------------------
const beforeGuard = (await app.state()).value;
for (const action of ['whoami', 'projects', 'board', 'list', 'next', 'team', 'members']) {
  let ok = true;
  try {
    await app.callTool({ action }, big.sessionId);
  } catch {
    ok = false;
  }
  check(`AC10: thought session may ${action}`, ok);
}
const blocked = [
  { action: 'claim', ticketId: bigEpicId },
  { action: 'move', ticketId: bigEpicId, column: 'ready' },
  { action: 'update', ticketId: bigEpicId, title: 'nope' },
  { action: 'comment', ticketId: bigEpicId, text: 'nope' },
  { action: 'release', ticketId: bigEpicId },
  { action: 'finish', ticketId: bigEpicId },
  { action: 'block', ticketId: bigEpicId, text: 'nope' },
  { action: 'run', ticketId: bigEpicId },
  { action: 'create_member', name: 'Probe Person', role: 'tester' },
  { action: 'scan' },
  { action: 'pause' },
  { action: 'resume' },
];
for (const args of blocked) {
  await expectToolError(`AC10: thought session rejected: ${args.action}`, () => app.callTool(args, big.sessionId), 'thought-read-only');
}
const afterGuard = (await app.state()).value;
check('AC10: guardrail leaves board state untouched',
  same(afterGuard.board.tickets.map((ticket) => ({ id: ticket.id, column: ticket.column, type: ticket.type })), beforeGuard.board.tickets.map((ticket) => ({ id: ticket.id, column: ticket.column, type: ticket.type }))) &&
    afterGuard.board.paused === false,
  `${beforeGuard.board.tickets.length} → ${afterGuard.board.tickets.length}`);
check('AC10: no thought ticket left Backlog', ticketsOfThought(afterGuard, big.id).every((ticket) => ticket.column === 'backlog'));

// Free the working slot before the next fixture (the fake session has stopped).
app.finish(big.sessionId);
await app.state();

// ---------------------------------------------------------------------------
// AC 7 — small bug: tickets only, no EPIC, tickets-only rationale required.
// ---------------------------------------------------------------------------
const small = await submitThought(app, 'Fix the typo in the empty board message: it currently says "No ticekts yet".');
const smallPrompt = app.promptFor(small.sessionId);
check('AC7: small-thought brief still carries the decision rule', smallPrompt.includes(DECISION_RULE));
await app.callTool(
  {
    action: 'create',
    title: 'Fix the empty-board message typo',
    type: 'bug',
    priority: 'low',
    role: 'fe-developer',
    description: '## Acceptance criteria\n1. The empty state reads "No tickets yet."\n2. The locale copy stays in parity.\n\nClosing rationale: tickets only — this is one small fix; no EPIC needed.',
  },
  small.sessionId,
);
snap = (await app.state()).value;
const smallTickets = ticketsOfThought(snap, small.id);
check('AC7: zero EPICs for a small thought', epicsOfThought(snap, small.id).length === 0, String(epicsOfThought(snap, small.id).length));
check('AC7: exactly one ticket', smallTickets.length === 1, String(smallTickets.length));
check('AC7: the ticket has no parentId', !('parentId' in (smallTickets[0] ?? {})), brief(Object.keys(smallTickets[0] ?? {})));
check('AC7: the ticket is in Backlog with the thought id', smallTickets[0]?.column === 'backlog' && smallTickets[0]?.thoughtId === small.id, `${smallTickets[0]?.column} ${smallTickets[0]?.thoughtId}`);
check('AC7: the brief demands a tickets-only rationale in the closing summary', /when no EPIC was created/i.test(smallPrompt) && /tickets alone suffice and why/i.test(smallPrompt));
app.finish(small.sessionId);
await app.state();

// ---------------------------------------------------------------------------
// AC 8 — one well-specified ticket with many acceptance criteria: no EPIC.
// ---------------------------------------------------------------------------
const single = await submitThought(app, 'Make the CSV importer exactly-once: one deliverable, but it carries many edge-case acceptance criteria.');
const manyAcs = Array.from({ length: 18 }, (_, index) => `${index + 1}. Edge case ${index + 1} is handled deterministically.`).join('\n');
await app.callTool(
  {
    action: 'create',
    title: 'Make the CSV importer exactly-once',
    type: 'story',
    priority: 'high',
    role: 'be-developer',
    description: `## Acceptance criteria\n${manyAcs}`,
  },
  single.sessionId,
);
snap = (await app.state()).value;
const singleTickets = ticketsOfThought(snap, single.id);
check('AC8: many-AC single deliverable produces zero EPICs', epicsOfThought(snap, single.id).length === 0, String(epicsOfThought(snap, single.id).length));
check('AC8: exactly one ticket, no parentId', singleTickets.length === 1 && !('parentId' in (singleTickets[0] ?? {})), `${singleTickets.length} ${brief(Object.keys(singleTickets[0] ?? {}))}`);
check('AC8: the ticket keeps all its acceptance criteria', /1\. Edge case 1[\s\S]*18\. Edge case 18/.test(singleTickets[0]?.description ?? ''), brief(singleTickets[0]?.description));
app.finish(single.sessionId);
await app.state();

// ---------------------------------------------------------------------------
// AC 9 — research rule fixture: a cited external source in the description.
// ---------------------------------------------------------------------------
const research = await submitThought(app, 'Align the board keyboard focus rings with the external accessibility standard for focus appearance.');
await app.callTool(
  {
    action: 'create',
    title: 'Adopt WCAG 2.2 focus-appearance tokens',
    type: 'story',
    priority: 'medium',
    role: 'fe-developer',
    description:
      '## Acceptance criteria\n1. Every focusable control shows a 3:1 focus indicator.\n\nSources: WCAG 2.2 — Focus Appearance (https://www.w3.org/TR/WCAG22/#focus-appearance).',
  },
  research.sessionId,
);
snap = (await app.state()).value;
const researchTicket = ticketsOfThought(snap, research.id)[0];
check('AC9: research-only thought is tickets-only', epicsOfThought(snap, research.id).length === 0, String(epicsOfThought(snap, research.id).length));
check('AC9: the cited source is persisted in the ticket description', /Sources: WCAG 2\.2/.test(researchTicket?.description ?? '') && /https:\/\/www\.w3\.org/.test(researchTicket?.description ?? ''), brief(researchTicket?.description));
app.finish(research.sessionId);
await app.state();

// ---------------------------------------------------------------------------
// AC 11 — a maximal realistic PRD fits the 20,000-char cap.
// ---------------------------------------------------------------------------
const maximal = await submitThought(app, 'Ship a full audit trail across the board with retention controls, exports and analytics.');
const maximalPrd = buildMaximalPrd();
check('AC11: maximal fixture is realistic but under the cap', maximalPrd.length >= 19000 && maximalPrd.length < DESCRIPTION_CAP, String(maximalPrd.length));
const maximalEpic = await app.callTool(
  {
    action: 'create',
    title: 'EPIC: board-wide audit trail',
    type: 'epic',
    priority: 'high',
    description: maximalPrd,
  },
  maximal.sessionId,
);
check('AC11: maximal EPIC is accepted', maximalEpic.ticket.type === 'epic', brief(maximalEpic.ticket));
snap = (await app.state()).value;
const maximalTicket = snap.board.tickets.find((ticket) => ticket.id === maximalEpic.ticket.id);
check('AC11: stored description stays under the cap', Boolean(maximalTicket) && maximalTicket.description.length < DESCRIPTION_CAP, String(maximalTicket?.description?.length));
check('AC11: the final required heading survives', Boolean(maximalTicket?.description) && maximalTicket.description.includes('## Open questions'), String(maximalTicket?.description?.length));
check('AC11: every heading survives the maximal PRD', missingHeadings(maximalTicket?.description).length === 0, brief(missingHeadings(maximalTicket?.description)));

// ---------------------------------------------------------------------------
// AC 12 (partial, test-side) — no snapshot/board contract drift.
// ---------------------------------------------------------------------------
snap = (await app.state()).value;
check('AC12: snapshot still reports board schema v3', snap.version === 3 && snap.board.version === 3, `${snap.version}/${snap.board.version}`);
check('AC12: submitThought response shape unchanged', (await app.action('submitThought', { text: 'x' })).json?.value?.thought?.status === 'working');
check('AC12: created tickets keep the KB-3 additive parentId contract', typeof snap.board.tickets[0]?.id === 'string' && ['story', 'task', 'bug', 'spike', 'epic'].includes(snap.board.tickets[0]?.type ?? ''), brief(snap.board.tickets[0]?.type));

console.log('\n' + (failures.length === 0 ? 'ALL KB-4 EPIC PRD CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
await rm(root, { recursive: true, force: true });
await rm(stateDir, { recursive: true, force: true });
process.exit(failures.length === 0 ? 0 : 1);
