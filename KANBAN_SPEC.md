
## v1.1 — Agent execution pipeline

Tickets may be executed by a dedicated linked agent session.

### Snapshot additions

- `Ticket.execution`: `{ sessionId, status: 'running'|'idle'|'blocked'|'paused'|'done'|'failed'|'cancelled', role, startColumn, startedAt, updatedAt, finishedAt, report, error, blocked: { reason, questions:[{id,text,answer}], needs:[{id,kind,text,status}] } | null }` or `null`.
- `Ticket.block`: `{ reason, questions:[{id,text}], needs:[{id,kind,text}], askedAt } | null` (the user-facing blocked payload).
- `board counts`: `counts.blocked`, `counts.executing`; snapshot root `execution: {running,idle,blocked,paused,done,failed,cancelled}`.
- The UI renders tickets with `blocked: true` in a sixth **Blocked** lane (a view over the real column; `ticket.column` is unchanged).

### Actions

| action | payload | value |
|---|---|---|
| `runTicket` | `{ticketId, role?}` | `{ticket, sessionId, role, prompt}` |
| `resumeExecution` | `{ticketId, message?}` | `{ticket, sessionId, role}` |
| `answerTicket` | `{ticketId, answers: string[], grant?: string[], denied?: string[]}` | `{ticket, sessionId}` |
| `cancelExecution` | `{ticketId}` | `{ticket}` |

### Agent tool additions

- `finish {ticketId, summary}` — only the executing session (or lead) may finish, and only after the
  ticket advanced into a success lane for its start column; stores `execution.report`.
- `run {ticketId, role?}` — lead/PM dispatch.
- `block {ticketId, text, questions?, needs?}` — sets the blocked payload and `execution.status='blocked'`.
- Execution sessions are **scoped**: only `claim/move/update/comment/block/unblock/finish/release` for
  their own ticket, and their claim/move transitions are pre-authorized for the dispatched lane path.

### v1.2 — Automatic lane handoffs

Every lane change recomputes `Ticket.assignment`:

```ts
assignment: { role: RoleId, agentSessionId: string|null, agentName: string|null,
              auto: true, reason: string, at: number } | null
```

- `in_progress→review` → Reviewer (Tester for `ticket.role === 'tester'`); `review→in_progress` clears it;
  `backlog→ready` → the implementation role (ticket role if that role can pull Ready, otherwise inferred,
  fallback Fullstack); `ready/…→backlog` → Product Manager; `→done` clears it.
- A matching idle, non-lead agent from the board roster is recorded as `agentSessionId/agentName`
  (suggestion); otherwise only the role is assigned.
- `runTicket` (or the board Start button) without a role uses `assignment.role`; starting clears the
  assignment and prepends a `## Handoff` block plus the previous agent report to the session prompt.
- The UI shows `→ <role>` on cards and **Next up: <role> · Suggested agent** with a `Start <role>` button.

### v1.3 — Per-execution access modes

- `Snapshot.accessModes`: `{ options: [{value,name,description}], suggestions: Record<ColumnId,string> }`
  from the Host `permissionPresets.catalog()`.
- `runTicket` accepts `accessMode` (a preset value). Validation falls back to the lane suggestion;
  `startTicketExecution` applies it with `permissionPresets.set(liveSession, mode)` before prompting and
  stores `execution.accessMode`; the prompt includes an `## Access mode` section.
- Suggested sandbox by lane: Backlog/Review → read-only; Ready/In Progress → workspace-write; SRE
  deploy/infra text also workspace-write. `Full access`/`auto` remain selectable.
- `Ticket.assignment.accessMode` carries the suggestion to the handoff Start button.
- UI: an **Access** select beside the role select (labels localized), plus an access tag on an active
  execution.

### v1.4 — Execution sessions mount the project agent preset

A ticket execution agent created by a plugin does **not** automatically inherit the agent-preset scope
that supplies the standard Harness tool composition. `startTicketExecution` therefore resolves the
project's preset from recent project sessions (`sessionController.list` projections) or `agentPresets.resolve(undefined)`,
then:

```js
agents.create({
  sessionId, agentOptions, meta: { cwd, agentPreset: presetId },
  setup: async (agentCtx) => { await agentPresets.mount(agentCtx, presetId) },
})
```

The session header records the preset and the mounted scope supplies bash/read/write/edit/grep/glob and
the rest. Verified live: a dispatched `workspace-write` execution used bash, read, write, glob and grep
successfully before blocking with its probe report.

## v2.0 — Team roles & personas (KB-13)

Roles become a platform-owned catalog of 10 with rigorous playbooks; every project gains a persisted,
editable roster of team members whose personas compose into dispatch prompts.

### Role catalog (`roles.js`)

- `roles.js` is the single source of truth (ESM, Node builtins only). Exports: `ROLES`, `ALL_ROLES`,
  `ROLE_INDEX`, `ROLE_MOVE`, `TRANSITIONS`, `LANE_CLAIM_ROLES`, `DEV_ROLES`, `DEFAULT_MEMBERS`,
  `rolePlaybookText`, `composeAgentPrompt`, `personaTemplate`, `buildSkillContent`.
- 10 ids: `product-manager`, `ux-designer`, `fe-developer`, `be-developer`, `fullstack-developer`,
  `bug-fixer`, `reviewer`, `tester`, `sre`, `tech-lead`.
- Each role: `{ id, name, description, summary, claimColumns, canCreate, canOverride, playbook }`;
  `canOverride` only on tech-lead; `playbook` = `{ mission, inputs (>=2), steps (8–12), askUserWhen (>=2),
  escalation, definitionOfDone (>=6) }`; each step has an imperative title, a >=40-char detail, artifacts
  and a gate.
- `bug-fixer` (the reference workflow) keeps **11 phases, 0–10**, including worktree/baseline,
  pre-state capture, root-cause probes, blast radius, fix plan, verify/post-state, consistency,
  hostile-critic quality gate and report/handoff. It claims Ready, moves `ready→in_progress→review`,
  may return `in_progress→ready`, and **cannot** accept `review→done`.
- Policy tables (`ROLE_MOVE`, `TRANSITIONS`, `LANE_CLAIM_ROLES`, `DEV_ROLES`), the tool role enum, the
  `kanban-workflow` skill and the system-prompt role line are generated from the catalog; `index.js`
  keeps no duplicated role list.
- Prompt order: global policy → role playbook → member persona → ticket context (`composeAgentPrompt`),
  surfaced in execution/dispatch prompts, `whoami`, the generated skill, the member-editor preview and
  one system-prompt line pointing agents at `whoami`/`members`.

### Board schema + migration

- `VERSION = 2`; `board.team = { version: 1, seededAt, members, drafts }`:
  `Member = { id, name, title, roleId, persona, paused, sessionId, createdAt, updatedAt, createdBy,
  source: 'seed'|'manual'|'ai' }`;
  `Draft = { id, description, roleId, sessionId, status: 'drafting'|'failed'|'cancelled', createdAt,
  error?, mode? }`.
- Migrate-on-read from version 1, preserving tickets, checklists, comments, ticket/board activity,
  `agents`, `meta`, `wip`, pause state and `nextNumber`; the migrated board is rewritten to disk as v2
  immediately. A v1 fixture test covers it.
- A new or migrated board with `seededAt: null` gets exactly 10 members (`member-<roleId>`, one per
  role) from `roles.js` `DEFAULT_MEMBERS`; `seededAt` is set once and deleting members never re-seeds.
  Old `board.agents[sessionId]` bookkeeping still works.

### Snapshot additions (additive)

- Snapshot `version: 2`; `roster: MemberRow[]`; `drafts: DraftRow[]`.
- `MemberRow = Member + { roleName, status, statusReason, currentTicket:{id,title,column}|null, since,
  lastActivityAt }`; status precedence `paused` > `working` (owns an in_progress/review ticket) >
  `running` (linked session running) > `idle` (linked session known) > `offline` (no session).
- `rules.roles[]` is compact: `{ id, name, description, summary, claimColumns, canCreate, canOverride,
  stepCount, definitionOfDone }` — **no full playbook in the polled snapshot**.
- Legacy `team: AgentRow[]` stays; sessions linked to a roster member are omitted from **Other agents**, while unlinked sessions remain there.

### Actions

| action | payload | value |
|---|---|---|
| `createMember` | `{name, roleId, title?, persona?}` | `{member}` |
| `updateMember` | `{memberId, patch:{name?,title?,roleId?,persona?,paused?}}` | `{member}` |
| `deleteMember` | `{memberId, force?}` | `{deleted:true}` |
| `draftMember` | `{description, roleId?}` | `{draft, source:'ai'\|'template', member?}` |
| `cancelDraft` | `{draftId}` | `{cancelled:true}` |
| `roleDetail` | `{roleId}` | `{role}` (full playbook) |
| `memberPrompt` | `{memberId}` | `{prompt}` |

- Validation/limits: name 1–48 unique case-insensitively → 409 `member/name-taken`; invalid role → 400
  `member/role-invalid`; title ≤60; persona ≤6000 (deterministic template when empty); roster ≤50 →
  409 `member/limit`; delete while owning in_progress/review → 409 `member/busy` unless `force`;
  unknown member → 404 `member/not-found`; ≤3 drafting drafts → 409 `draft/limit`; unknown draft →
  404 `draft/not-found`; description clamped to 1000. Member actions are allowed while the board is
  paused.
- AI drafting: a short-lived read-only agent (`ctx.agents.create`, project preset mounted, read-only
  preset applied) is prompted to call `kanban create_member`; the panel shows a drafting row that
  becomes the member. 120s timeout or prompt failure → `failed` + Retry. `cancelDraft` on a drafting
  row cancels the agent and keeps a cancelled row; a second call dismisses it. Without an agents
  service, `draftMember` adds a deterministic template member and labels it `source: 'template'` /
  draft `mode: 'template'`.
- Dispatch: `runTicket` accepts optional `memberId`; an explicit member must be unpaused (409
  `member/paused` otherwise) and its role must pull the lane (else 403 `ticket/role-forbidden`), then
  resolution is idle member of the role → free member of the role → role-only fallback. Dispatch sets
  `ticket.owner.memberId`, links `member.sessionId`, and Agent Teams sessions auto-link by trimmed
  case-insensitive name match.

### Tool additions

- `members` — roster rows + drafts.
- `create_member` — only a member-drafting session or tech lead/lead; args `name/title/role/persona/
  memberDescription/draftId`.
- `whoami` — adds `playbook`, `rolePlaybook`, `persona`, `member`, `memberPrompt` for the caller.
- `run` — accepts `memberId`.
- Execution sessions remain scoped and **cannot** create members.

### UI

- Team rail (336px, overlay at `<=1180px` per the KB-12 contract): summary, **Members** roster (inline
  rename, title, role, text status, current ticket/since, last activity, per-member pause/edit),
  **Add member**, **Add with AI** (3-draft limit hint), **Drafts** (drafting/failed/timeout/cancelled,
  Retry/Dismiss), **Other agents**, **Role playbooks**.
- Member editor drawer `min(560px,96%)`: name/title/role/persona (word count, 6000 cap), composed-prompt
  preview via `memberPrompt`, save/cancel, delete confirm, force delete for a busy member.
- Role viewer drawer `min(720px,96%)`: loads `roleDetail` and renders mission, inputs, numbered
  steps/artifacts/gates, ask-user rules, escalation and role DoD.
- Full `en` + `zh` locale coverage; `role="dialog"`/`aria-modal`, Escape and focus handling; both
  drawers clamp to the panel and go full width at `<=660px`.

### Verification

- `node tests/roles.test.mjs` — catalog rigor, distinct playbooks, seeded personas, prompt
  order, skill/host wiring.
- `node tests/team.test.mjs` — v1 migration fixture, CRUD/validation/limits, statuses,
  drafting + template fallback, linkage, RBAC, system prompt.
- `node tools/kb13-probe.js` — headless Chrome over the real GUI; evidence in
  `docs/screenshots/kb13/` (`final-verification.json` + PNGs).

## v2.1 — Thought intake (KB-1)

A thought becomes the board's primary entry point: the user speaks one thought, a staff product-manager
agent session decomposes it, and the result is real Backlog tickets. The release is additive — the board
schema does not move.

### Snapshot additions (additive)

- `thoughts: ThoughtRow[]` on `POST kanban/state` — newest first, at most 50, `[]` when no workspace.
- `ThoughtRow = { id: 'TH-<n>', text, status: 'recorded'|'working'|'done'|'failed', createdAt, updatedAt,
  sessionId: string|null, error: string, ticketIds: string[] }`; `text` is trimmed once to 1–4000
  characters and stored verbatim.
- `Ticket.thoughtId` is the only board addition: the id of the thought that created the ticket, absent on
  tickets created any other way. `thought.ticketIds` lists the created tickets in creation order.
- **No board schema bump.** `VERSION` stays 2 and nothing is written to `board.thoughts`. Thoughts live in
  `<stateDir>/thoughts/<sanitized-workspaceId>.json` as `{ version: 1, nextNumber, thoughts[] }` in
  creation order, written atomically (tmp+rename) and read tolerantly (missing/corrupt → `[]`; a corrupt
  file is set aside as `.corrupt-*`). `nextNumber` keeps ids stable across restarts.

### Actions

| action | payload | value |
|---|---|---|
| `submitThought` | `{text}` | `{thought: ThoughtRow}` |

- Errors: non-string/missing text → 400 `bad-request`; empty after trim → 400 `thought/empty`; more than
  4000 characters → 400 `thought/too-long` (the message names the 4000 cap); 3 `working` thoughts → 409
  `thought/limit`; a paused board → 423 `board/paused` (thought-specific copy asking the user to resume).
- The thought is persisted before dispatch. A dispatch failure is still a 200 with the recorded thought in
  `failed`, its `error` filled in and `sessionId: null`; it is never lost and creates no tickets.

### Dispatch and completion

- `ctx.agents.create` with `meta.cwd = project.path`, the project's resolved agent preset id in
  `meta.agentPreset`, and a `setup` mounting that preset.
- The `read-only` permission preset is applied before prompting. The session is attached to the project,
  recorded as the roster product manager (role `product-manager`, first unpaused PM's name), and renamed
  `Thought TH-n · <first 60 characters>` (whitespace collapsed, whole title capped at 120).
- Prompt = PM role playbook + seeded PM persona (role playbook only when no PM member exists) + brief:
  the thought verbatim and six rules — read the board first; 1–20 independently shippable tickets with
  type/priority/role/labels, numbered testable acceptance criteria and an evidence plan; create in Backlog
  only and never move/claim/update/release/comment/finish/write code; research the project (and the web
  only when external standards or best practice matter, saying what was relied on); no EPIC in this
  slice, state whether one is needed; closing summary of created ids.
- Linkage: `create` from the thought session forces `column: 'backlog'`, stamps `ticket.thoughtId`, and
  appends the id to `thought.ticketIds` without duplicates.
- Snapshot-read reconciliation (idempotent): session running → `working`; session observed but stopped →
  `done` (`updatedAt` bumped once); session never observed → `failed` 30 s after dispatch, with error
  exactly `the product manager session did not start` (tests use the `thoughtGraceMs` knob). `done` with
  zero tickets is valid.

### Tool restriction

- A session tied to a thought may only call `whoami`, `projects`, `board`, `list`, `next`, `team`,
  `members`, `create`; anything else fails with `kanban/thought-read-only` and mutates nothing.
- Its `create` ignores `column`; sessions not tied to a thought are unchanged.

### UI

- Header primary **Speak a thought** (说出想法) opens a one-field dialog; **Thoughts** is the secondary
  button with a badge counting `working` thoughts and a drawer listing status, created-ticket chips and
  **Open agent session**. **+ New ticket** is demoted to a ghost action.
- Capture on a paused board is refused with 423 `board/paused`; the board is otherwise unchanged.

### Verification

- `node --test tests/thoughts.test.mjs` — additive snapshot, validation/limits, dispatch capture
  (cwd/preset/read-only/title/prompt), guardrail, linkage, failure paths, 30 s grace, persistence and
  restart, tolerant reads, 50-row newest-first cap.
- `node tools/kb14-probe.js` — headless Chrome over the real GUI; evidence in `docs/screenshots/kb14/`.
