
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

- `VERSION = 3` (v3 adds the additive EPIC model — see below); `board.team = { version: 1, seededAt, members, drafts }`:
  `Member = { id, name, title, roleId, persona, paused, sessionId, createdAt, updatedAt, createdBy,
  source: 'seed'|'manual'|'ai' }`;
  `Draft = { id, description, roleId, sessionId, status: 'drafting'|'failed'|'cancelled', createdAt,
  error?, mode? }`.
- Migrate-on-read from version 1 **and** version 2, preserving tickets, checklists, comments,
  ticket/board activity, `agents`, `meta`, `wip`, pause state, the team roster and `nextNumber`; the
  migrated board is rewritten to disk as v3 once, atomically, and a second load writes nothing.
  `nextNumber` is raised to `max(stored, highestTicketNumber + 1)` so ids are never reused. v1/v2
  fixture tests cover it.
- A new or migrated board with `seededAt: null` gets exactly 10 members (`member-<roleId>`, one per
  role) from `roles.js` `DEFAULT_MEMBERS`; `seededAt` is set once and deleting members never re-seeds.
  Old `board.agents[sessionId]` bookkeeping still works.

### Snapshot additions (additive)

- Snapshot `version: 3`; `roster: MemberRow[]`; `drafts: DraftRow[]`.
- `MemberRow = Member + { roleName, status, statusReason, currentTicket:{id,title,column}|null, since,
  lastActivityAt }`; status precedence `paused` > `running` (an attached live agent is executing a turn) >
  `idle` (an attached session/agent exists at rest) > `offline` (no attached agent session). Ticket
  ownership never makes a member busy/`working`; `since` is set only while the attached agent is running.
- `currentTicket` is the display-safe **focus** ticket: an In Progress ticket the member owns/is assigned,
  or a Review ticket when the member's role owns the review gate (`reviewer|tester|tech-lead`). An
  implementer's ticket parked in Review is **not** their current ticket (it is `null`); the broader
  held-ticket rule (`memberTicket`) is still used internally for delete/busy protection.
- The Team rail renders **no status dot on the autopilot chip** (text only); the single row status dot
  pulses only for `running`. `memberAutopilotState` reads the real status first: `paused` → paused;
  `running` → active (with its current ticket); at rest → neutral `Resume KB-n` (in_progress focus),
  `Next KB-n` (review focus), `Session idle`, or `No work` — never `active` from ticket ownership.
- `rules.roles[]` is compact: `{ id, name, description, summary, claimColumns, canCreate, canOverride,
  stepCount, definitionOfDone }` — **no full playbook in the polled snapshot**.
- `team: AgentRow[]` is derived and now contains **only sessions attached to a roster member** (the
  client uses it for owner filters); it never contains arbitrary sessions. The fixed team list is
  `roster`. Sessions attach deterministically (persisted `board.agents[sessionId].memberId`,
  `member.sessionId`, the member named on an active ticket, Agent Teams name, or session/agent title).
  Legacy `board.agents` rows that are neither attached, live, drafting, role-overridden, nor named by an
  active ticket are pruned on snapshot read (idempotent).

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
  Retry/Dismiss), **Role playbooks**. The **Other agents** section is removed: the roster is the fixed
  team list and live sessions only attach to member rows.
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
  `thought/limit`. *(Amended by v2.3: a paused board no longer returns 423 `board/paused` — the capture is
  queued and returns 200 `status: 'queued'`; validation still runs first.)*
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
  slice, state whether one is needed; closing summary of created ids. *(Superseded by v2.2 below: the
  brief now decides EPIC vs tickets-only and fills the EPIC PRD.)*
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
- ~~Capture on a paused board is refused with 423 `board/paused`~~ *(amended by v2.3: a paused capture is
  queued and returns 200 `queued`, then drains on resume; the board is otherwise unchanged).*

### Voice dictation (KB-2)

- With the installed voice bundle mounted and its selected provider ready, opening the dialog starts
  microphone capture by default. The mic toggle stops that one recording, the dialog transcribes it
  through the bundle's `remote.speech` Remote and **appends** the single final transcript to the existing
  Thought field (never overwriting typed text); toggling again starts a new capture. The unchanged
  `submitThought` action is still called once, with the trimmed field text.
- The toggle exposes `aria-pressed`, a text label and `title`, Space/Enter activation, and is disabled
  with an accessible en+zh explanation while the bundle is absent/disabled, the provider is not prepared,
  or the dialog is requesting/transcribing. States: `checking`, `requesting`, `recording` ("Listening…
  n s" + pulsing dot), `transcribing`, `idle`, inline `error` (permission denied, capture failure,
  transcription failure, empty transcript, over-long recording) and `unavailable`. The `aria-live="polite"`
  region announces state changes and committed transcript text; elapsed seconds are `aria-hidden`.
  Escape/overlay close releases the microphone; focus stays in the field across transcript updates.
- Scope note: the bundle has no partial/final segment stream, so KB-2 is one-shot stop → transcribe (no
  live partials, no pause-commit-while-recording, no auto-submit). The dialog's capture layer is the only
  board-owned audio code; recognition stays in the bundle and there is no new ASR dependency.

### Verification

- `node --test tests/thoughts.test.mjs` — additive snapshot, validation/limits, dispatch capture
  (cwd/preset/read-only/title/prompt), guardrail, linkage, failure paths, 30 s grace, persistence and
  restart, tolerant reads, 50-row newest-first cap.
- `node --test tests/voice.test.mjs` — fake bundle double + fake capture + injected timers: default-on,
  toggle, one-shot commit sequence, submit flush, bundle absent, provider not ready, permission denied,
  capture/transcription failure, empty transcript, locale parity.
- `node tools/kb14-probe.js` / `node tools/kb2-probe.js` — headless Chrome over the real GUI; evidence in
  `docs/screenshots/kb14/` and `docs/screenshots/kb2/`. The voice probe needs Chrome with
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`.


## v2.2 — EPIC decomposition (KB-4)

The product standard that sits on top of the v3 EPIC model: **when** a thought becomes an EPIC and
**what** its PRD contains. Prompt text, one new documentation file, tests and a probe only — no board
schema, snapshot key, action payload, `create`/`update` validation, UI or locale change.

### Template

`docs/EPIC_PRD_TEMPLATE.md` is the canonical EPIC PRD. Required sections, in order: **Vision**,
**Problem**, **Users**, **Jobs to be done**, **Success metrics**, **Scope in**, **Scope out**,
**Acceptance criteria**, **Risks**, **Dependencies**, **Rollout**, **Open questions**, plus usage
notes (one EPIC per thought/initiative, every section filled, no `TBD` outside Open questions,
concise enough for one ticket description, children linked with `parentId`, sources named).

### Decision rule

The `submitThought` brief states the threshold verbatim: "Create an EPIC only when the thought needs
two or more related tickets, a new feature, or a new project. A single small thought yields tickets
only, with no EPIC." One well-specified ticket is tickets-only too, however many acceptance criteria
it carries.

### Prompt rules (appended to the KB-1 brief; rules 1–4 and the session contract stay)

- List all twelve template headings in the brief, so the standard applies in a workspace without this
  repo's `docs/` file.
- When the thought qualifies: exactly one EPIC, created first, `type: 'epic'`, Backlog, description =
  the fully filled PRD (no blank headings, no `TBD` outside Open questions).
- Every child of the initiative is created after the EPIC with `parentId` = the EPIC id; the EPIC has
  no `parentId`; no foreign/non-existent parent; unrelated tickets stay unlinked.
- Research the board and project docs first; web research only for an external standard/best practice,
  with the sources named in the description.
- The PRD stays far under the 20,000-character description cap: summarise, never truncate.
- Close with the EPIC id + tickets, or state explicitly that tickets alone suffice and why.
- Unchanged: read-only/Backlog-only wording, forced-Backlog `create`, `kanban/thought-read-only`
  guardrail, and the role-playbook + persona composition order.

### Verification

- `node --test tests/epic-prd.test.mjs tests/thoughts.test.mjs` — template parse, built-brief text
  (headings, threshold, old rule gone, read-only/Backlog retained, research, cap, composition),
  fake-Harness decomposition fixtures (big feature, small bug, single many-AC ticket, cited source,
  maximal PRD) and the guardrail matrix; the KB-1 suite stays green with its prompt assertion updated.
- `node tools/kb4-probe.js` — dependency-free fake-Harness transcript: the full built brief plus the
  fixtures' captured create arguments and persisted shapes (`--json` for machine reading); exit 0 =
  every check passed. No UI change, so no screenshots.


## v3 — EPIC model (KB-3)

The board gains the structural model the EPIC flow needs: a ticket `type: 'epic'`, an additive
`parentId` on child tickets, and a v3 schema migration that still loads v1/v2 boards. It does not add
the EPIC PRD template or decomposition rules (KB-4).

### Data model + invariants

- `Ticket.type` union becomes `story|task|bug|spike|epic` in normalization, HTTP create/update and the
  `kanban` tool; any other value keeps the `task` fallback.
- `Ticket.parentId?: string` is additive and present only on a linked child. It must reference an
  existing `epic` ticket in the same board; missing target, non-EPIC parent, self-parent, an EPIC that
  would get a parent and an EPIC that already has a parent are `400 ticket/parent-invalid`. Non-string
  or empty `parentId` is treated as absent; `null` on update clears; a plain update never clears.
- An EPIC is created in Backlog whatever column was requested and is pinned there (read-time repair
  returns a hand-edited EPIC to Backlog and records `ticket/epic-pinned`). Moves out of Backlog are
  `409 epic/backlog-only` and add no activity entry; claim and dispatch are `409 epic/not-claimable`;
  deleting an EPIC with children is `409 epic/has-children`.
- No action can leave a dangling `parentId`: read-time normalization drops a missing/non-EPIC/self
  link (or a link hanging off an EPIC) and records `ticket/parent-dropped` board activity.

### Migration

- `VERSION = 3`; `normalizeBoard` accepts v1, v2 and v3 and rewrites v1/v2 to v3 once. Every
  pre-existing board key keeps its shape; `board.version` and `snapshot.version` report 3.
- The board file is replaced atomically (temp file + rename) by the existing serialized `BoardStore`
  write path, so an interrupted migration cannot leave a half-converted board.

### Snapshot + tool surface

- `board.tickets[]` carries `type` and optional `parentId`; no new top-level snapshot key is added
  (children are derived from `board.tickets`). Older clients receive every pre-existing field unchanged.
- The `kanban` tool `create`/`update` accept `parentId`, and the tool ticket brief echoes
  `parentId: string | null`.

### UI

- Cards: EPIC badge + Backlog-only lock chip + child count; child cards show a **Parent {id}** chip
  (native button, click or focus+Enter opens the parent drawer). EPIC cards have no run button and are
  not draggable (drag start is refused with the reason).
- EPIC drawer: the description is labelled **EPIC PRD**, and a **Children** section lists each child
  (id, title, column, status, count) with click-to-open and an empty state; move buttons are disabled
  with the reason and no agent execution panel is shown.
- New-ticket dialog offers `epic`; choosing it forces Backlog (column disabled) and shows the hint.
- Full `en` + `zh` copy for every new string (`types.epic`, `card.parent`, `card.children`,
  `card.epicLocked`, `detail.epicPrd`, `detail.children`, `detail.epicPrdHint`,
  `detail.childrenEmpty`, `detail.childrenEmptyHint`, `detail.epicLocked`, `new.epicHint`).

### Verification

- `node --test tests/epic.test.mjs` — v1/v2 fixture migration, idempotent reload, v3
  persistence/restart + corrupt/unknown-version degradation, epic create/forced Backlog, move/claim/run
  rejection with stable codes and an unchanged board, parent validation, delete-with-children rejection,
  read-time repair with recorded activity, snapshot additivity.
- `node tools/kb3-probe.js` — headless Chrome over the real GUI: live v3 snapshot, UI EPIC creation,
  badge/parent chip/children list/empty state, blocked drag, 1024/640 widths, en+zh. Evidence in
  `docs/screenshots/kb3/` (`final-verification.json` + PNGs).

## v2.3 — Thought lifecycle (KB-5)

The thought becomes a first-class, recoverable record: retry, cancel, inspect, queue while paused, edit
and soft-delete with an audit trail. Additive to the v3 board — no board schema move, no `board.thoughts`,
and the thought store envelope stays `version: 1`.

> **Amendment (KB-1 v2.1 → v2.3):** a capture on a paused board is no longer `423 board/paused`. It now
> returns `200 { thought }` with `status: 'queued'`, `sessionId: null`, no `agents.create` and no tickets,
> and drains on resume. KB-1's README/KANBAN_SPEC/SHARED_BUILD_SPEC text and
> `tests/thoughts.test.mjs`'s paused assertion are amended to match.

### Statuses + additive fields

- `ThoughtRow.status` union: `recorded|working|done|failed|queued|cancelled`; unknown/legacy values still
  degrade to `failed`. `queued` is a paused capture; `cancelled` is terminal for reconciliation.
- Additive `ThoughtRow` fields (present only when set, so KB-1 files load unchanged and are not
  rewritten): `retryOf?: string`, `audit?: AuditEntry[]`, `deletedAt?: number`, `editedAt?: number`.

### Actions

| action | payload | value | errors |
|---|---|---|---|
| `submitThought` | `{text}` | `{thought}` | 400 `bad-request`/`thought/empty`/`thought/too-long`; paused → queues (200) or 409 `thought/queue-full`; else 409 `thought/limit` |
| `retryThought` | `{thoughtId}` | `{thought}` new row | 404 `thought/not-found`; 423 `board/paused`; 409 `thought/limit`; 409 `thought/not-retryable` (in that order) |
| `cancelThought` | `{thoughtId}` | `{thought}` | 404; 409 `thought/not-cancellable`; repeat is 200 with no second audit entry |
| `editThought` | `{thoughtId,text}` | `{thought}` | 400 `bad-request`/`thought/empty`/`thought/too-long`; 404; 409 `thought/not-editable` |
| `deleteThought` | `{thoughtId}` | `{deleted,thought}` | 404; 409 `thought/working`; repeat is idempotent 200 with no second audit entry |

- Paused matrix: submit queues; retry 423s after the 404 check; cancel/edit/delete are allowed while
  paused (no lane move, no dispatch).
- Retry creates a new linked row (`retryOf`) and dispatches; the original is never mutated. Cancel calls
  `ctx.sessionController.cancel({sessionId})`, keeps created tickets and wins over reconciliation. Edit
  is allowed for `queued|failed|cancelled`; delete is a soft delete for any non-`working` thought whose
  row leaves the snapshot while `ticket.thoughtId` stays intact.

### Queue + drain + audit

- Paused submit queues (cap 20). Resume and every snapshot read drain FIFO up to 3 working, claiming
  `queued → working (sessionId:null)` and persisting the claim before dispatch; a claim that never links
  a session fails after `thoughtGraceMs` with error exactly
  `the product manager session did not start`. A per-workspace lock makes resume+snapshot races
  dispatch each thought once; overflow stays `queued`.
- `audit` is append-only, oldest-pruned beyond 50, covering every status transition plus `ticket`, `edit`,
  `delete` and `retry` events. The snapshot exposes ≤20 entries per thought and bounds each serialized
  entry to ≤400 chars (edit excerpts ≤280). The client derives a timeline for KB-1 rows without audit.

### Snapshot + UI

- Additive snapshot key `deletedThoughtIds: string[]` (most recent ≤100). `thoughts` is unchanged in
  shape: newest-first, ≤50, soft-deleted rows filtered out. `snapshot.version`/`board.version` are not
  changed by this release.
- UI: Queued/Cancelled labels (en+zh, safe unknown label), queued count in the Thoughts drawer header,
  expanded detail (verbatim text, timeline, error, ticket chips, session link, retry-of link), expand
  toggle with `aria-expanded`, retry/cancel/edit/two-step-delete controls, and the ticket drawer's thought
  chip plus **Thought deleted** fallback. Test-only clock knob `now: () => number`.

### Verification

- `node --test tests/thought-lifecycle.test.mjs tests/thoughts.test.mjs` — every action and error path
  with a no-mutation assertion, paused queue + drain cap/FIFO/race/stale claim, retry/cancel idempotency,
  terminal cancelled across reads and restart, detail timeline, edit/delete, audit bounds, guardrail
  table, limits and `deletedThoughtIds`.
- `node tools/kb5-probe.js` — headless Chrome over the real GUI: queued-while-paused then Resume, retry,
  cancel, detail/timeline, ticket-drawer deleted fallback, en+zh at 1024/640; evidence in
  `docs/screenshots/kb5/` (`final-verification.json` + PNGs).

## v2.4 — Thought intake hardening (KB-6)

The thought intake boundary becomes duplicate-safe, bounded and auditable. Additive to the v3 board and the
`version: 1` thought store: no board schema change, no `board.thoughts`, no client/locale change (new
rejections render through the dialog's existing toast).

### Duplicate protection

- One normalizer: trim, collapse internal whitespace to one space, case-fold; punctuation preserved. Stored
  text stays verbatim after trimming.
- `submitThought` returns `409 thought/duplicate` when the normalized text matches a live (`non-deleted`,
  `non-failed`) thought created in the last 10 minutes, scanning at most the newest 20 such rows; the message
  names the existing `TH-n`. No row, no session, existing row untouched. The window is authoritative: after it
  elapses the same text is accepted again. A `failed` or soft-deleted row never blocks resubmission.
- Matching is per workspace and serialized by an in-process per-workspace intake lock, so two identical
  submissions racing in one tick yield exactly one 200 and one 409, one row and one dispatch (single-Host scope).

### Per-workspace limits

- 5 accepted submissions / rolling 60 s and 20 / rolling hour, on the injected clock; over either returns
  `429 thought/rate-limit` with a retry hint in the message. Rejected submissions create no thought/session and
  consume no budget; rejected duplicates do not consume either. The budget log is persisted as the additive
  thought-store root `rateLog: number[]` (bounded, one-hour window), so a restart does not reset it; workspaces
  are independent. Host knob `thoughtRateLimits: { perMinute, perHour }` (test/operator only; the defaults are
  the contract).

### Check order

`bad-request` → `thought/empty` → `thought/too-long` → `409 thought/duplicate` → `429 thought/rate-limit` →
paused queue (`200 queued` / `409 thought/queue-full`) → `409 thought/limit` → persist/dispatch.

### Intake audit

- Additive `ThoughtRow.intakeAudit: IntakeEvent[]` persisted in the thought store, append-only, newest 50:
  `submitted` (`human`), `dispatched` (`pm-session`, `sessionId`), `ticket-linked` (`pm-session`, one per
  created ticket, `ticketId`), `failed` (`system`). The snapshot exposes `intakeAudit` (bounded 50, ≤260 chars
  per entry); old rows read as `[]`; KB-5's `audit` timeline is unchanged.
- Integrity: each ticket appears at most once as `ticket-linked`, the union matches `thought.ticketIds`, and
  cancel/edit/delete never rewrite the trail.

### Guardrail matrix

- Unchanged allow-list; every other catalog action from a thought-tied session fails with
  `kanban/thought-read-only` and leaves a deep-equal board/thoughts/roster (adversarial table in tests).
- `create` still forces Backlog, stamps the thought id from the caller (a forged `thoughtId` in tool args is
  ignored for every caller), and a thought session may only set `parentId` to an EPIC its own thought created
  (otherwise `ticket/parent-invalid`).

### Verification

`node --test tests/thought-hardening.test.mjs tests/thoughts.test.mjs` plus the whole
`node --test tests/*.test.mjs`; `node tools/kb6-probe.js` writes `docs/screenshots/kb6/final-verification.json`.

## v3.1 — Autopilot lanes (KB-67–KB-79)

Autopilot is additive to the **v3** board: a persisted configuration/budget envelope, a bounded pulse
history, structured review verdicts and a per-ticket failure row. **`board.version` remains `3` and
`snapshot.version` remains `3`.** There is no migration command and no version bump: an older reader
ignores the new keys and keeps operating manually, a newer reader synthesizes defaults when they are
absent, and an old board still loads. Removing autopilot is therefore configuration, not a data
migration. The design record is [`docs/AUTOPILOT.md`](docs/AUTOPILOT.md); the operator procedures are
[`docs/AUTOPILOT_RUNBOOK.md`](docs/AUTOPILOT_RUNBOOK.md).

### Additive board keys

The additive persisted surfaces are `board.autopilot`, `board.pulses[]`, `ticket.reviews[]`, the optional
`ticket.autopilot` row and the additive `ticket.execution` fingerprint fields.

```ts
interface BoardAutopilot {
  version: 1                    // envelope version of THIS subtree; unknown -> disabled, board intact
  enabled: boolean              // only literal true enables dispatch
  cadenceMs: number             // default 300000; bounds 60000..3600000
  maxReadyDepth: number         // default 3; bounds 0..20 (integer)
  laneCaps: { refine: number; implement: number; review: number } // default 1/1/1; each 0..3
  maxDispatchesPerPulse: number // default 1; bounds 1..5
  budget: {
    hour: { limit: number; used: number; windowStart: number } // default limit 20; 1..200
    day:  { limit: number; used: number; windowStart: number } // default limit 60; 1..1000
  }
  backoffMs: number             // default 300000; bounds 60000..3600000; doubling capped at 1 h
  staleMs: number               // default 600000; bounds 60000..3600000
  updatedAt: number             // epoch ms of the last configuration write (pulses never change it)
  updatedBy: string             // actor name, <= 80 chars; 'system' when normalized
}
```

- **Reads repair, writes reject.** A hand-edited or downgraded envelope is repaired field by field on
  read (non-finite numbers fall back, out-of-bounds values clamp, unknown fields drop, an unknown subtree
  `version` fails safe to disabled and keeps the rest of the board). A `configure` write validates the
  whole patch first and rejects any unknown field/type/out-of-range value with `400 autopilot/invalid`,
  leaving the persisted board untouched. A write preserves `budget.*.used`/`windowStart` unless the window
  has legitimately rolled over.
- **Caps in phase 1.** Defaults are `1/1/1`, the planner admits **at most one ticket per lane group per
  pulse**, and a configured cap bounds concurrent autopilot admissions by counting running sessions in
  the group (manual sessions included). The shipped write bounds are currently `0..3` for every lane; the
  phase-1 guarantee is one implementation session at a time, so raising `implement`/`review` above 1 is
  unsupported until per-ticket worktree isolation lands (KB-81, docs/AUTOPILOT_PHASE2.md). A manual
  Start/Run is never rejected by a cap and may leave occupancy above it; the planner then skips the lane
  as `lane-cap` until it drains.
- **Budget unit.** One dispatch = one autopilot session start or resume (a human Start/Run does not
  count; a manual *Pulse now* does). Counters increment in the same board write as the execution row;
  windows are fixed and roll over lazily on read/write.

```ts
interface BoardPulse {
  id: string                    // "PL-<n>", monotonic per board
  at: number                    // epoch ms, pulse start
  atIso?: string               // ISO-8601 of `at` (present on host-written pulses)
  trigger: 'timer' | 'manual' | 'resume'
  decisions: PulseDecision[]    // <= 50; the executor truncates and appends ` (+N decisions not stored)` to the last decision's reason
  dispatched: PulseDispatch[]   // <= 5 (maxDispatchesPerPulse <= 5)
  error: string                 // <= 500 chars; '' when the pulse had no executor error
  outcomes?: PulseOutcome[]     // present only when a lane verified a session; <= 8
  durationMs?: number           // pulse wall time, whole ms
}

interface PulseDecision {
  ticketId: string | null
  memberId: string | null
  lane: 'refine' | 'implement' | 'review' | null   // null = board-level
  action: 'dispatch' | 'skip'
  reason: string                // closed vocabulary below, <= 400 chars
  // additive dispatch fingerprint, present only on implement/review dispatches:
  role?: string
  roleInferred?: boolean
  accessMode?: string
}

interface PulseDispatch {
  ticketId: string
  memberId: string
  sessionId: string             // session started or resumed by this dispatch
}

interface PulseOutcome {
  ticketId: string
  lane: 'refine' | 'implement' | 'review' | null
  sessionId: string
  outcome: 'satisfied' | 'deferred' | 'postcondition-failed'
  detail: string                // <= 400 chars
}
```

`board.pulses` is newest-first, capped at **50** entries (prepend + `slice(0, 50)`). Pulse record shapes
above are the persisted rows: plan-level fields such as `order`/`group`/`mode`/`handoffTo`/`expectedColumns`
are not persisted. Entries without a finite `at` are corrupt and dropped on read; a missing `trigger`
coerces to `manual`; corrupt decisions/dispatched/outcomes are bounded/dropped. The pulse error is the
only backoff signal: the newest consecutive non-empty `error` streak drives exponential backoff.

Reason vocabulary (closed): the planner's seventeen codes `disabled`, `board-paused`, `epic`, `blocked`,
`active-execution`, `lane-cap`, `wip-limit`, `ready-depth`, `no-member`, `member-busy`, `member-paused`,
`stale-execution`, `postcondition-failed`, `budget-exhausted`, `loop-guard`, `pulse-cap`, `admitted`, plus
the executor's `no-work` heartbeat. A pulse-level throw is `pulse.error`, not a decision code.

```ts
interface TicketReview {
  id: string | null
  at: number
  reviewerMemberId: string | null   // stamped by the host from the calling session
  reviewerName: string | null
  sessionId: string | null
  verdict: 'accepted' | 'changes-requested' | null  // null only on a legacy/corrupt read
  notes: string                     // <= 4000; required for changes-requested
  criteria: { ref: string; passed: boolean; note?: string }[] // <= 40; refs name numbered ACs
  evidence: string[]                // <= 20 items, <= 500 chars each
}

interface TicketAutopilotState {
  version: 1
  attempts: number                  // consecutive autopilot failures since the last human action; <= 1000
  lastFailureAt: number
  backoffUntil: number              // epoch ms; never more than 1 h past the failure
  lastDispatchAt: number
  lastOutcome: null | 'postcondition-failed' | 'dispatch-failed' | 'stale'
}
```

`ticket.reviews` is newest-first, capped at **20**; every row is materialized with the full field set on
read so a save/reload cannot change the shape. `accepted` must map **every** numbered criterion as
`passed: true`; `changes-requested` needs a blocking `notes` string and at least one `passed: false`
criterion. A rejected write is `400 ticket/review-invalid` and leaves the board untouched. The verdict is
persisted before the move (a Done move overwrites `execution.report`). `ticket.autopilot` is written only
after a failure or a reset; an older board lacks it and reads as 0 attempts / no backoff.

Additive `ticket.execution` fields (all optional, absent on pre-autopilot rows):

- `origin: 'autopilot'` — marks an autopilot-dispatched session (manual/legacy rows have no `origin`);
- `postcondition: { at, outcome }` — the once-per-state-change verification marker;
- `stale: { at, sessionId, reason, lastSignalAt }` — the persisted "this staling event was recovered"
  marker, keyed by session id so a reload cannot recover/count it twice.

`member.lastActivatedAt` is also additive on the roster row (fair member selection): integer epoch ms,
absent reads as `0`.

### `autopilot` action ops

One `/kanban/action` action, `autopilot`, with a required `op`:

| op | payload | value | notes |
|---|---|---|---|
| `status` | `{}` | `{ config, nextTickAt, lastPulse, budgetRemaining }` | Read-only; `config` is the flat view below, `lastPulse` is the newest pulse record or `null`, `budgetRemaining` is `{hour,day}` of `{limit,used,remaining,resetsAt}`. |
| `configure` | `{ patch }` | `{ config, nextTickAt, lastPulse, budgetRemaining }` | Validates the whole patch before writing once; preserves budget counters; persists `updatedAt`/`updatedBy`; turning `enabled` off clears the timer synchronously and records `autopilot/disabled`. |
| `plan` | `{}` | `{ generatedAt, decisions, skips }` | Dry run of the exact `planPulse` the executor uses. Read-only: no write, no budget, no session. Allowed while disabled/paused (the plan then carries `disabled`/`board-paused`). |
| `pulseNow` | `{}` | `{ pulse }` | One immediate pulse through the same planner, budget, caps, mutex and dispatch path. An exhausted window refuses it with `429 autopilot/budget` only while autopilot is enabled; a disabled, unpaused board still records its `disabled` no-op pulse, and a paused board records `board-paused` when no refusal applies. An in-flight pulse refuses it with `409 autopilot/pulsing`. |

There is **no separate `pause` op**: the master stop is `configure { patch: { enabled: false } }`, and
pausing the board is the existing `pauseBoard` action (autopilot stays enabled; timer pulses while paused
become one deduplicated `board-paused` record, while an explicit manual pulse adds its own row when it
runs).

Errors: `400 autopilot/invalid` (bad op/patch/type/range), `429 autopilot/budget` (manual pulse while
autopilot is enabled and an hour/day window is exhausted; `error.details` carries `reason`, `windows`,
`resetsAt`, `retryAfterSeconds` and the budget), `409 autopilot/pulsing` (a pulse is already running for
this workspace).

### Additive snapshot fields

`snapshot.version` stays `3`; no pre-existing field changes shape.

```ts
interface Snapshot {               // additions only
  // ...
  autopilot: AutopilotReadModel | null   // derived, never persisted; null when there is no project
}

interface AutopilotReadModel {
  config: {                        // flat public view: budget as limits only
    enabled: boolean
    cadenceMs: number
    maxReadyDepth: number
    laneCaps: { refine: number; implement: number; review: number }
    maxDispatchesPerPulse: number
    budget: { hour: number; day: number }
    backoffMs: number
    staleMs: number
  }
  nextTickAt: number | null        // armed timer target, else derived; null when disabled/unknown version
  lastPulse: BoardPulse | null
  pulseCount: number               // persisted ring length (<= 50)
  budgetRemaining: {
    hour: { limit: number; used: number; remaining: number; resetsAt: number }
    day:  { limit: number; used: number; remaining: number; resetsAt: number }
  }
}
```

The persisted `board.autopilot`, `board.pulses`, `ticket.reviews`, `ticket.autopilot` and the additive
`ticket.execution` fields are also visible in the snapshot `board` (persisted keys are not hidden), so the
UI feed and the ticket drawer read the same records a reviewer sees on disk. UI consumers treat
`snapshot.autopilot` as optional: a host build without autopilot yields `null` and the panel renders
**Unavailable** while the board keeps working manually.

### Compatibility and verification

- **Board version stays 3 / old-client compatibility.** Every added key is optional on read and ignored
  by an old client/host; a newer reader synthesizes defaults rather than rewriting the board on read.
  A v1/v2/v3 fixture still loads, and a round trip through a reader that does not know the keys keeps
  the pre-existing board meaningful. Rollback is `enabled: false` (or a downgrade that ignores the keys);
  no migration command exists and none is needed.
- **Review move guard.** An autopilot review session (`execution.origin: 'autopilot'`,
  `startColumn: 'review'`) cannot move `review → done` without a host-stamped `accepted` verdict, and
  cannot move `review → in_progress` without a `changes-requested` verdict; both are `409
  ticket/review-verdict-required`. A refine session's claim is additionally rejected `409
  ticket/wip-limit` when the Ready count reached `maxReadyDepth` between planning and the claim.
- **Unit suites.** `node --test tests/autopilot-*.test.mjs` covers schema/defaults/migration
  (`tests/autopilot-schema.test.mjs`), the pure planner (`tests/autopilot-planner.test.mjs`), the executor
  scheduler/restart/overlap (`tests/autopilot-executor.test.mjs`), the refine/implement/review lanes, the
  handoff context pack, the safety rails, the UI state machine, and the invariant suite
  (`tests/autopilot-invariants.test.mjs`: randomized boards, lane journey, migration/failure matrices,
  24 h cross-check); the whole `node --test tests/*.test.mjs` must stay green.
- **GUI probe.** `node tools/autopilot-probe.js` drives the real client bundle against isolated temporary
  boards and writes its evidence pack under `docs/screenshots/autopilot/` (it needs the running Web GUI
  and Chrome on CDP 9333; it does not run offline). The README documents the exact command and flags.
