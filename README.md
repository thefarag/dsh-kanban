# Kanban Board

A reusable **DeepSeek Harness** plugin that gives every project a real Kanban board — and gives every
agent in that project one strict, standard Kanban workflow to follow.

It installs as a profile bundle: a new **Kanban** icon appears in the left sidebar and opens a full
board panel in the main column. The board is project-scoped (one board per DSH Workspace), with a
project selector, drag-and-drop columns, owner agents, a persisted team roster of named specialists
with editable personas, 10 role playbooks, pause/resume controls, and a project scanner that can build
the board from an existing project's docs, plans, AI conversations, and open MRs/PRs.

The Host⇄Client wire contract lives in [docs/SHARED_BUILD_SPEC.md](docs/SHARED_BUILD_SPEC.md);
versioned snapshot changes are recorded in [KANBAN_SPEC.md](KANBAN_SPEC.md).

## Install

This project lives at `/Users/thefarag/Projects/AI/AI_Generated/DSH-Kanban` and is its own DSH
Workspace. It is linked into the DSH profile (`~/.dsh/profiles/desktop`) as a local bundle, so the
running Host resolves `@local/dsh-kanban` straight from this directory:

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "@local/dsh-kanban": "link:/Users/thefarag/Projects/AI/AI_Generated/DSH-Kanban" }
```

To point another machine or profile at a checkout:

```
# in the DSH chat, ask the agent to install the bundle, or use the Plugins UI
plugin_manager install_bundle target=/absolute/path/to/DSH-Kanban
```

Then refresh the Web GUI once. The bundle patch inserts one row:

```yaml
- insert:
    - id: kanban
      name: '@local/dsh-kanban'
      config:
        wipInProgress: 3
        wipReview: 5
        scanMaxFiles: 160
```

`config.stateDir` overrides where boards are stored (default `$DSH_HOME/kanban`).

## Use

1. Open **Kanban** in the sidebar.
2. Pick a project in the header. The board is created on first use.
3. Press **Scan** on an existing project: it reads vision/plan/architecture docs, README notes,
   `TODO`/`FIXME`/`HACK` markers, unchecked checkboxes, recent AI conversation sessions (from the
   session log), and open GitHub PRs / GitLab MRs (`gh` / `glab` when available). Review the
   insights, then **Import** the candidate tickets.
4. Or press **+ New ticket** and write your own.
5. Drag cards between columns, open a card for full detail, assign an owner agent, and use
   **Open agent session** to peek at the conversation doing the work.
6. **Team** opens the team rail: the fixed **Members** roster (one row per persisted member: name,
   title, role, attached-agent status, current ticket, last activity), **Add member** / **Add with AI**,
   **Drafts**, and **Role playbooks**. Pause or resume a member, edit their name/title/role/persona, or
   pause the whole board (running agent turns are cancelled). Agent sessions are attachments that drive
   each member's status; they are never listed as extra team rows.

**The primary entry point is a thought.** Press **Speak a thought** (说出想法) in the board header, type
one thought, and send it. A read-only product-manager agent session decomposes it into Backlog tickets.
When the thought needs two or more related tickets, a new feature or a new project, the PM creates one
**EPIC** in Backlog with a fully filled PRD — the canonical form is
[`docs/EPIC_PRD_TEMPLATE.md`](docs/EPIC_PRD_TEMPLATE.md) — and links every child ticket with `parentId`;
a single small thought (or one well-specified ticket) becomes tickets only, with no EPIC.
The **Thoughts** button (badge = working count) opens a drawer with each thought's status,
created-ticket chips and **Open agent session**; expanding a row shows its status history and
retry/cancel/edit/delete controls. While the board is paused a thought is accepted and **queued**
(`200` with `status: 'queued'`) and runs when you resume — capture is never rejected (KB-5 amended
KB-1's `423 board/paused`). Intake is hardened: a near-identical thought submitted again inside ten
minutes is refused with `409 thought/duplicate` (naming the earlier `TH-n`; failed/deleted thoughts and
other workspaces never block), a workspace is limited to 5 thoughts a minute and 20 an hour
(`429 thought/rate-limit` with a retry hint), and every accepted thought keeps a persisted
`submitted → dispatched → ticket-linked` audit trail in its row. **+ New ticket** is now a secondary,
ghost-style action.

## Team members and personas

Every project board gets a persisted roster of **team members**. A member is a person: a name, a title,
exactly one role from the platform catalog, and an editable **persona** (their system prompt). The
roster ships with **10 seeded specialists, one per role**, so the panel is useful on first open:

| Seeded member | Role |
|---|---|
| Kareem Koshary | Product Manager |
| Yasmin Feteer | UX Designer |
| Sherif Shawarma | Frontend Developer |
| Mariam Molokhia | Backend Developer |
| Hassan Hawawshi | Full-stack Developer |
| Zizi Zaatar | Bug Fixer |
| Ashraf Ahwa | Reviewer |
| Tamer Tameya | Tester / QA |
| Salma Semsemeya | SRE / Platform |
| Moustafa Mishmish | Tech Lead |

What you can do from the team rail:

- **See who is doing what.** Each row shows a truthful text status derived only from the agents attached
  to that member — **Running** (an attached agent is executing a turn), **Idle** (an attached session or
  agent exists at rest), **Offline** (no agent session is attached) or **Paused** — plus last activity.
  The status dot pulses **only** while Running. The current ticket (`id · title`, click to open it) is the
  member's active focus: their own In Progress work, or a Review ticket when their role owns the review
  gate (reviewer/tester/tech lead); an implementer's ticket parked in Review has been handed off and does
  not appear as their current ticket. The autopilot chip is text-only and derives from the same real
  status: **Active on KB-n** only while running, **Resume KB-n** / **Next KB-n** as a neutral next action
  at rest, **Session idle** or **No work** otherwise — never a green "engaged" pulse for an idle member.
- **Edit a member.** The pencil opens the member editor: name, title, role, persona (with a live word
  count and a 6,000-character cap), and a **composed-prompt preview** that shows exactly what the agent
  will receive (role playbook → persona). Deletion asks for confirmation; a member who owns an active
  ticket is protected unless you force-delete.
- **Add a member manually** with **Add member**, or **Add with AI**: describe the teammate in a sentence
  ("a backend dev who lives for migrations"), optionally pick a role, and press **Draft**. A **Drafting**
  row appears; when the AI calls the member tool it becomes a normal, immediately editable member. At
  most 3 drafts run at once, a draft that times out or fails can be retried, and cancelling a draft
  stops its agent. If the agents service is unavailable, the action adds a deterministic **template**
  member instead (flagged in the drafts list and toast), which you can edit.
- **Read the playbooks.** **Role playbooks** opens the catalog viewer: mission, inputs, the numbered
  process with its artifacts and gates, when to ask the user, escalation rules, and the role's
  Definition of Done. `bug-fixer` keeps the full 11-phase workflow (0–10) with before/after evidence.

The roster is stored with the project board (max 50 members) and survives restarts. Deleting members
never re-seeds the default 10 — `seededAt` is set once. Named members are linked to execution sessions
when a ticket is dispatched to them, so their persona and role travel into the session prompt.

## Roles and personas

Roles are platform policy, not user data. The 10 roles and their playbooks live in `roles.js`, the
single source of truth for claim columns, transitions, lane defaults, the tool's role enum and the
generated `kanban-workflow` skill. Each role has a numbered process with artifacts and gates, when to
ask the user, escalation rules, and a role-specific Definition of Done (at least six items).

`bug-fixer` is the reference workflow: 11 phases (0–10), from the bug charter and isolated baseline
through pre-state reproduction, root-cause probes, blast radius, fix plan, one owned implementation
slice, post-state verification, global consistency, a hostile-critic quality gate, and report/handoff.
It can claim Ready bugs and raise them to Review, but it cannot accept `review→done`.

A team member inherits exactly one role's playbook and adds a **persona** — how that person thinks,
collaborates, and what they refuse to do. The Host composes **role playbook → member persona → ticket
context** into the dispatch prompt, returns the role playbook and persona from `kanban whoami`, and
generates the `kanban-workflow` skill from the same catalog, so the process cannot drift from the
policy. A persona never changes what the role may do: columns, moves, WIP and the review gate still
come from the role.

## The Kanban policy (enforced, not suggested)

The Host registers a `kanban` tool and a system-prompt section for every agent, and the tool rejects
any move that breaks the policy.

| Column | Meaning |
|---|---|
| **Backlog** | Captured work; not ready to pull |
| **Ready** | Refined, unambiguous, pullable |
| **In Progress** | An agent owns it and is working |
| **Review** | Change ready; reviewer/tester gate |
| **Done** | Accepted against the Definition of Done |

- **One column at a time.** `backlog→ready→in_progress→review→done`; backward moves are explicit
  (release, changes requested, reopen). Skipping is rejected.
- **WIP limits.** In Progress 3, Review 5 by default (configurable). Each agent may hold only **one**
  in-flight ticket.
- **Pull, not push.** Agents claim from the columns their role owns; a claim is the only way to
  become the owner.
- **Role ownership.** `product-manager`, `ux-designer`, `fe-developer`, `be-developer`,
  `fullstack-developer`, `bug-fixer`, `reviewer`, `tester`, `sre`, `tech-lead` each have defined claim
  columns and transitions. Only reviewer/tester/tech-lead accepts `review→done`; `bug-fixer` pulls
  Ready bugs but cannot accept `review→done`. Roles are policy; team members are people with one role
  and an editable persona.
- **Blocked work is visible.** A blocked ticket carries a reason and cannot move until unblocked.
- **Pause freezes everything.** A paused board rejects agent mutations and stops running work.
- **Definition of Ready / Done** are shown in the board rules and on ticket detail.

Agents start each work session with `kanban {"action":"whoami"}` and then `{"action":"next"}`.

Tool actions: `whoami`, `projects`, `board`, `list`, `next`, `create`, `claim`, `move`, `update`,
`comment`, `review`, `release`, `block`, `unblock`, `assign`, `team`, `members`, `create_member`, `scan`,
`pause`, `resume`, `set_role`. Execution sessions add `finish`, `run`, `answer` and `cancel_execution`.

## Running a ticket with an agent

Every ticket in **Backlog**, **Ready**, or **Review** can be executed by a dedicated agent session:

1. Open the ticket and choose the agent role (the picker is filtered to roles that can pull from
   that lane), then press **Run with agent** (or the small run button on the card). The Host picks the
   roster member for that role — an idle member first, then any free member — and falls back to a
   role-only session when the role has no free member. The `run` tool and the `runTicket` action also
   accept an explicit `memberId`; a member whose role cannot pull the lane is rejected with
   `ticket/role-forbidden`.
2. The Host resolves the project's **agent preset** (from its recent sessions, falling back to the
   deployment default), mounts that preset into the new agent scope, creates a real DSH session in the
   project workspace, **links it to the ticket**, and starts it with a scoped brief (the preset is what
   gives the session the normal coding toolset — bash/read/write/edit/grep/glob and the rest): ticket fields, project path, role, lane, description, checklist, recent
   comments, and source. The brief also carries the member's role playbook and persona, in that order
   before the ticket context. The prompt tells the agent to load the `kanban-workflow` skill, claim this
   ticket only, advance one lane at a time, and finish with a report. The `kanban` tool is scoped to
   that single ticket for the session.
3. The card and drawer show live state — `Agent running`, `Agent idle`, `Agent blocked`, `Agent done`
   — with **Open agent session** to peek at the conversation. The session also appears in the
   workspace's session list under its ticket title.
4. On success the agent moves the ticket forward (Ready → In Progress → Review, or Review → Done) and
   calls `finish`; the report is stored on the ticket and shown in the drawer.
5. If the agent needs a user decision, permission, credential, or input, it calls `block` with
   **questions and needs**. The ticket appears in the **Blocked** lane and the drawer lists each
   question as an input plus each permission/decision as a grant checkbox.
   **Send answers & resume** unblocks the ticket, prompts the same session with the answers, and the
   ticket returns to its lane automatically while the agent continues.
6. **Cancel run** stops the current turn; the session stays in your sessions list. **Run again**
   dispatches a fresh session, and **Continue** resumes an idle one.

### Access mode per agent session

Before starting a ticket execution, the drawer shows an **Access** picker next to the role:

- `Read only` — inspect and reason; no workspace writes (Backlog refinement and Review gates)
- `Workspace write` — edit files inside the project workspace (implementation work in Ready/In Progress)
- `Full access` — unrestricted filesystem/command access (choose deliberately)
- `Auto` — the Harness's current permission preset

The picker is **pre-selected from the lane and task nature** (Backlog/Review → Read only, Ready/In Progress →
Workspace write, SRE deploy/infra tasks → Workspace write) and the suggested mode is also stored on the
handoff, so the next lane's Start button opens with the correct mode. The Host applies the chosen preset to
the new session through `permissionPresets.set()` before the first turn, records it as
`execution.accessMode`, shows it as a tag in the drawer, and tells the agent its access mode in the brief.
If the mode is too restrictive for the task, the agent blocks and asks for a re-dispatch with a wider mode —
that is the intended blocked-flow behavior.

### Automatic lane handoffs

When a ticket advances to a lane owned by a different role, the board **auto-assigns the next lane's
most suitable role** and, when a matching idle agent is known, the most suitable agent:

- Ready → the ticket's implementation role (frontend / backend / fullstack / UX / SRE), inferred from the
  ticket when its stored role cannot pull that lane;
- In Progress → Review assigns **Reviewer** (or **Tester** for test tasks);
- Review → In Progress hands back to the implementation role; Review → Done clears the handoff;
- moving back to Backlog assigns **Product Manager**.

The handoff does **not** start the ticket by itself: it only assigns the next lane's role and suggests an
agent. Cards show a `→ Reviewer` (etc.) chip and the drawer shows **Next up: <role> · Suggested agent:
<name>** with a one-click **Start <role>** button. That manual Start is always available and is **never
blocked by autopilot**: it ignores autopilot caps, Ready depth, the dispatch budget and pulse limits, and
it creates a new session for the role with the ticket context **plus the handoff reason and the previous
agent's report**, so the reviewer/next implementer inherits what happened. Starting clears the handoff;
manual reassignment replaces it. When **Autopilot** is enabled it can also dispatch the next lane's ticket
automatically, under its own caps and budget (see [Autopilot](#autopilot-optional-off-by-default)); when it
is off (the default), the ticket waits for a human to press Start.

The blocked lane is a view over the ticket's real lane: the underlying column never changes while
blocked, so answering the questions returns the ticket exactly where it was.

## Autopilot (optional, off by default)

Autopilot turns the passive board into a pull system. A host-side timer owned by the plugin runs one
**pulse** every cadence (5 minutes by default): a pure planning pass over the persisted board plus at
most one session start/resume. A pulse that runs records the decisions it considered, so the operator can
see why work started or was skipped; the one exception is repeated timer pulses on a paused board, which
fold into the existing `board-paused` row instead of adding new ones. A timer tick that lands while the
previous pulse is still running starts no pulse and records only a `pulse/skipped-overlap` board
activity. It is **off by default**, costs **zero model tokens while idle** (no heartbeat sessions are
created just to prove liveness), and only runs for a project where a human enabled it. The design record
is [`docs/AUTOPILOT.md`](docs/AUTOPILOT.md); the operator procedures are in
[`docs/AUTOPILOT_RUNBOOK.md`](docs/AUTOPILOT_RUNBOOK.md).

### What it does per lane

| Lane group | Candidates | What a dispatch does | Default cap |
|---|---|---|---|
| **Refine** | Backlog, non-EPIC, not blocked, no live execution | A read-only Product Manager session pulls the ticket in Backlog, researches it, improves the description/acceptance criteria/role/labels/write scope and claims it `backlog → ready`, up to the Ready-depth ceiling. | 1 |
| **Implement** | Ready (pull), or In Progress with a recoverable/abandoned execution or a `changes-requested` verdict (rework) | Starts the ticket's implementation role (frontend/backend/fullstack/UX/SRE/bug-fixer) on the ticket; the expected outcome is Review. Rework first bridges `in_progress → ready` and re-dispatches from Ready because In Progress cannot be started directly. | 1 |
| **Review** | Review, no live execution | A Reviewer (or Tester for test tasks) session verifies against the acceptance criteria and records a structured verdict, then exits to Done (accepted) or In Progress (changes requested). | 1 |

A pulse evaluates lanes in `rework → review → implement → refine` order, so the feedback gate is never
starved behind new work; with one dispatch per pulse, a busy review lane is skipped as `lane-cap` and
implement is evaluated next. The planner admits **at most one ticket per lane group per pulse**.

### Phase 1: one implementer and one reviewer at a time

Phase 1 deliberately serializes the two engineering lanes (default lane caps `1/1/1`). Every dispatched
session gets the **same working tree** (`project.path`) and the same board file, so two concurrent
implementers would edit and overwrite each other's files, and two review sessions would race the review
gate; `laneCaps.implement`/`review` above 1 is therefore unsupported until per-ticket worktree isolation
ships (designed in [`docs/AUTOPILOT_PHASE2.md`](docs/AUTOPILOT_PHASE2.md), KB-81). The popover's one-time
phase-1 notice states the same thing. The lane-cap selectors expose `0–3` and the shipped validator
accepts that range — a known phase-1 gap recorded by the KB-78 invariant suite (finding F2) — so the
one-implementer guarantee is a **policy** rule here, not a schema bound: keep `implement` and `review` at
1 unless you consciously accept two agents editing the same worktree.

### Defaults and limits

The host validates every write against these bounds and clamps a hand-edited board on read instead of
failing to load it.

| Setting | Default | Accepted bounds | Meaning |
|---|---|---|---|
| `enabled` | `false` | `true` / `false` | Master switch. Only a literal `true` enables dispatch; manual Start/Run is independent. |
| `cadenceMs` | 5 min | 1–60 min | Target interval between pulse starts. |
| `maxReadyDepth` | 3 | 0–20 | Refine stands down while the Ready count is at or above this depth. |
| `laneCaps.refine` / `.implement` / `.review` | 1 / 1 / 1 | 0–3 each | `0` disables that lane; keep implement and review at 1 in phase 1. |
| `maxDispatchesPerPulse` | 1 | 1–5 | New sessions per pulse, across all lanes. |
| `budget.hour.limit` | 20 | 1–200 | Autopilot dispatches per fixed hour window. |
| `budget.day.limit` | 60 | 1–1000 | Autopilot dispatches per fixed day window. |
| `backoffMs` | 5 min | 1–60 min | Base delay after a pulse-level error; doubles per consecutive error, capped at 1 hour. |
| `staleMs` | 10 min | 1–60 min | No-progress threshold before a dead execution is recovered by the watchdog. |

Budget counters are persisted `{ limit, used, windowStart }` windows: one dispatch = one autopilot
session start or resume (a manual **Start/Run** does not count; a manual **Pulse now** does). A window
starts on first use and rolls over lazily, so `20/h 60/day` is the default spend ceiling no matter how the
board is edited.

### Enable, disable, and pause

- **Enable.** Open the **Autopilot** button (bolt icon, right side of the board header) and switch
  **Autopilot** on. The first enable shows a one-time phase-1 confirmation in the browser. The toggle is
  the master switch: it persists `board.autopilot`, arms the workspace timer, and nothing dispatches
  before the first tick at `now + cadence` — press **Pulse now** for an immediate, budget-counted pulse.
  For a staged rollout, enable one project at a time, use **Preview next pulse** before switching on, keep
  the lane caps at 1, and read the first few pulses in the feed before trusting the lane; the operator
  checklist is in [`docs/AUTOPILOT_RUNBOOK.md`](docs/AUTOPILOT_RUNBOOK.md#rollout-checklist).
- **Adjust.** The same popover holds Settings — cadence, Max Ready depth, lane caps and the live dispatch
  budget read-out (**Hour: n of m left / Day: n of m left**) — plus **Preview next pulse** (dry run),
  **Pulse now** and the **Pulse feed**. Changes are validated by the host; an invalid value returns `400
  autopilot/invalid`, is rolled back in the UI, and is never persisted.
- **Disable (one step).** Switch **Autopilot** off in the same popover. The host persists
  `enabled: false`, clears the workspace timer synchronously, records an `autopilot/disabled` board
  activity and **leaves already-running sessions alone** — they finish their current turn and their
  normal kanban actions still work; only future automatic dispatches stop. Pulse history, budget and
  failure state are retained, and re-enabling resumes from that state without replaying the disabled
  interval. Disabling is also the rollback: there is no migration.
- **Pause the board (different).** **Pause** freezes the whole board and cancels running agent sessions
  (their executions become `paused`); autopilot stays enabled but no decision is dispatched. The timer
  stays armed, and pausing is recorded at most once: the first timer pulse after the pause adds one
  `board-paused` row and later timer pulses are deduplicated into it (a manual **Pulse now** records its
  own `board-paused` row, except when an enabled board's budget refuses it with `429`). On **Resume** the
  paused execution rows are repaired (`paused → idle`), the next pulse runs at the normal cadence with
  trigger `resume`, and no burst follows.
- **Manual Start/Run is never blocked by autopilot.** Cards still show the handoff Start button and the
  drawer still has **Run with agent**; a manual dispatch is an explicit override that ignores lane caps,
  Ready depth, the dispatch budget and pulse limits (it may push lane occupancy above its cap). It still
  consumes board WIP, member busy state and lane occupancy, so autopilot will not start a second session
  on the same lane; it does not increment the dispatch budget, and it resets that ticket's autopilot
  failure counter.

### Reading the pulse feed

The **Pulse feed** is the operator's liveness proof. It lists the newest pulses (max 50, newest first)
with the trigger (`Timer`, `Manual`, `Resume`), time, duration, `n dispatched` / `n skipped` and an
`error` marker. Expanding a pulse shows every decision — the lane, ticket, action (`Dispatch`/`Skip`),
reason code and a human-readable detail — plus the sessions actually started and any lane verification
outcomes (`satisfied`, `deferred`, `postcondition-failed`). The popover header shows the **next pulse**
countdown and the state (`On`, `Off`, `Paused`, `Unavailable`); the board column headers show lane
admission chips (`busy`/`idle`, occupancy/cap) and the Team rail shows each member's autopilot chip
(active only while running; neutral next action, idle, paused or no work at rest; last activation). Pulse failures and per-ticket failures raise alerts with
**Open ticket** and **Acknowledge**. **Preview next pulse** runs the exact planner read-only — it writes
nothing, starts nothing and does not touch the budget — so it is safe while autopilot is off or paused.

### Reason codes

Every plan decision carries one of these closed reason codes (unknown codes from a newer host render with
a fallback label):

| Code | Where | Meaning |
|---|---|---|
| `admitted` | dispatch | The ticket/member pair starts or resumes a session this pulse. |
| `disabled` | board | Autopilot is off (the dry-run planner can still be asked). |
| `board-paused` | board | The board is paused. |
| `epic` | ticket | EPICs are never dispatched. |
| `blocked` | ticket | The ticket waits for a user answer/decision; autopilot never answers it. |
| `active-execution` | ticket | A healthy execution already covers the ticket; phase 1 never starts a second session. |
| `lane-cap` | lane | The lane group already has `laneCaps[group]` running sessions (or is disabled with cap 0, or this pulse already used the lane's one admission). |
| `wip-limit` | lane | Dispatching would exceed the board's In Progress WIP limit. |
| `ready-depth` | lane | Ready is at or above Max Ready depth; refine stands down. |
| `no-member` | lane | The roster has no member with an eligible role for the lane (or only the implementer itself for review). |
| `member-busy` | lane | Every eligible member already holds an in-flight ticket or live session. |
| `member-paused` | lane/ticket | The only eligible member, or the ticket's owning member, is paused. |
| `stale-execution` | ticket | A live execution has shown no progress for `staleMs`; the watchdog recovers it (once). |
| `postcondition-failed` | ticket | The last dispatch missed its expected lane and the ticket is inside its exponential backoff. |
| `loop-guard` | ticket | Three consecutive autopilot failures parked the ticket until a human acts. |
| `budget-exhausted` | board | The hourly or daily dispatch budget is used up. |
| `pulse-cap` | lane | `maxDispatchesPerPulse` is reached; the lane waits for a later pulse. |
| `no-work` | board | No lane had a candidate ticket; the record is the pulse heartbeat. |

A pulse-level failure (a thrown dispatch, store error or failed prompt) is recorded in `pulse.error` and
shown as a `Dispatch failed` alert rather than as a decision code; per-ticket quality failures are
`postcondition-failed`/`stale-execution`, and a parked ticket is `loop-guard`.

### What is never automatic

- **Answering a blocked question.** A blocked ticket is skipped as `blocked`; it appears in the Blocked
  lane with its questions/permissions, and only your answer resumes the same session.
- **Dispatching an EPIC.** EPICs are Backlog-only structural parents and are skipped as `epic`.
- **Rubber-stamp review.** An autopilot review session must record a structured verdict: an `accepted`
  verdict has to map every numbered acceptance criterion as passed, and `review → done` from an autopilot
  review session without one is rejected with `409 ticket/review-verdict-required`. A changes-requested
  verdict needs a blocking note and at least one failed criterion, and hands the ticket back to In
  Progress. The autopilot reviewer is also a different member/session from the implementer, runs the
  test-capable `workspace-write` preset (a read-only sandbox cannot run `node --test`) and must not edit
  the change under review — the verdict postcondition audits it.
- **Creating team members.** Autopilot only chooses from the persisted roster; it never drafts, creates or
  schedules members (`Add member` / `Add with AI` remain human actions).
- **Bypassing the board policy.** It never skips a column, never moves another agent's ticket, never
  exceeds board WIP, and never dispatches the `tech-lead` override role.
- **Spending model time when idle.** No heartbeat sessions; a pulse with no work records a decision and
  costs host CPU only.

### Rollback and phase 2

Turning autopilot off is the whole rollback: the board stays `version: 3`, no migration command exists,
and a downgraded or older host simply ignores the additive `autopilot`/`pulses`/`reviews` keys (automation
silently stops; tickets, comments, runs and the roster are untouched). Phase 2 is designed but **not
shipped**: parallel implementers with per-ticket git worktrees (KB-81,
[`docs/AUTOPILOT_PHASE2.md`](docs/AUTOPILOT_PHASE2.md)), per-lane cadence and automatic member scheduling
stay deferred — see [Not included yet](#not-included-yet--follow-ups). The phase-2 record's clean-base,
worktree-layout, land-conflict and cleanup procedures (and its `worktrees.enabled = false` rollback) only
become operator steps once that work lands; the runbook keeps them in a clearly marked "not shipped"
section.

Known UI limitation: in Chinese, the Max Ready depth label reads `Ready 最大深度` while the Ready column
is labelled `就绪`; the value and behaviour are correct, only that label is inconsistent.

## Architecture

- `roles.js` — the platform role catalog and single source of truth (ESM, Node builtins only): the 10
  roles with playbooks and role DoD, derived policy tables (`ROLE_MOVE`, `TRANSITIONS`,
  `LANE_CLAIM_ROLES`, `DEV_ROLES`), the 10 curated `DEFAULT_MEMBERS` personas, `composeAgentPrompt`,
  `rolePlaybookText`, `personaTemplate`, and the generated `kanban-workflow` skill text.
- `index.js` — Host half. Node-builtins only.
  - `BoardStore`: per-workspace JSON boards under `$DSH_HOME/kanban/<workspace>.json`, atomic writes;
    board `version: 3` with a persisted `team` store and the additive EPIC model (`type: 'epic'`,
    optional `ticket.parentId`), migrated on read from v1/v2 and repaired on read so a hand-edited
    dangling parent link or an EPIC outside Backlog can never survive a load.
  - `POST /kanban/state`, `POST /kanban/action`: authenticated same-origin routes gated by
    `ctx.connection.requestRejection`; the action router also serves the member actions
    (`createMember`, `updateMember`, `deleteMember`, `draftMember`, `cancelDraft`, `roleDetail`,
    `memberPrompt`).
  - `kanban` tool + `systemPrompt.section` (order 700) implementing the policy; the tool exposes
    `members` and `create_member`, and `whoami` returns the caller's role playbook and persona.
  - Aggregates live project state from `workspaceRegistry`, `sessionController`, `sessionPersistence`,
    `agents`, and (when enabled) `agentTeams`.
  - Team roster: seeding, member CRUD and validation, live status computation, session auto-link by
    name, AI member drafting, and the compact `rules.roles[]` snapshot rows.
  - Execution pipeline: `agents.create` starts a ticket-scoped session with the default model, the
    project's **agent preset mounted** (so the agent receives the same tool composition as a normal
    session: bash/read/write/edit/grep/glob, skills, etc.), a chosen permission preset, and the ticket
    brief; `sessionController.prompt` drives/resumes it, `sessionTitle.rename` labels it, and the session
    is attached to the workspace so it appears in the project's session list. The tool is scoped to that
    ticket; `block` with questions/needs and `answerTicket` implement the wait-for-user loop; `finish`
    stores the report.
  - Dispatch linkage: resolves an explicit `memberId` or an idle/free roster member for the lane's role,
    sets `ticket.owner.memberId`, links `member.sessionId`, and prepends the role playbook + persona to
    the session brief.
  - Lane handoffs: every move computes the next lane's role (and a matching idle agent when available),
    stores `ticket.assignment`, and the next start carries the handoff reason plus the previous report.
  - Access modes: the available `permissionPresets` catalog is exposed to the board; each Start can
    choose one, suggested per lane/task, and the Host applies it to the new session before its first turn.
  - Autopilot: config + budget and a newest-50 pulse ring persisted additively under board `version: 3`
    (no version bump, no migration); a pure exported `planPulse` planner; one `ctx.effect`-owned
    self-rescheduling per-workspace timer with an in-memory pulse/overlap guard; the dispatch budget,
    stale-execution watchdog, per-ticket failure backoff and three-strike loop guard; and one `autopilot`
    action with the `status`/`configure`/`plan`/`pulseNow` ops. The derived read model is exposed as
    `snapshot.autopilot`; every dispatch reuses `startTicketExecution`/`resumeTicketExecution`.
  - Scanner: docs walk, TODO/checkbox extraction, session-log summaries, `gh`/`glab` MR discovery.
- `client.js` — Web half. Registers the `sidebar.panellist` icon and the `main` panel key `kanban`,
  polls the host routes, and renders the drag-and-drop board, detail drawer, team rail (roster, drafts,
  member editor, role-playbook viewer), scan drawer, and toasts with host theme tokens only. It also
  renders the autopilot header entry and settings popover, the dry-run preview, Pulse now, the pulse
  feed with alerts, the next-pulse countdown, and the lane/member admission chips (en + zh).
- `locale/{en,zh}.json` — Plugin Manager display metadata.
- `icon.svg` — Original artwork.

## Notes

- Session titles/status come from the live DSH session store; agent names/roles come from Agent Teams
  when present, otherwise from the session title and a keyword-based role inference.
- The roster is the fixed source of people and the only team list. A live session is attached to a
  member by an explicit persisted link, `member.sessionId`, the member named on the ticket it owns, its
  Agent Teams name, or its session title. Unlinked sessions are bookkeeping, not teammates: they are
  never rendered as team rows, and stale legacy `board.agents` rows are pruned on the next snapshot.
- A persona refines *how* a member works. It never grants a column, a move, an override or a review
  gate; policy always comes from the role.
- MR discovery is best-effort: install `gh` or `glab` and authenticate it for automatic detection.
- Boards are local to this machine's `$DSH_HOME`. No data leaves the machine.

## Tests

The package ships dependency-free Node test harnesses (no install needed):

Run from this repository's root:

```
node --test tests/*.test.mjs              # everything
node tests/host.test.mjs                  # policy engine, HTTP routes, scanner, persistence
node tests/scoping.test.mjs               # nested-workspace ownership, default project
node tests/execution.test.mjs             # dispatch, scoped tool, block/answer, finish, cancel
node tests/roles.test.mjs                 # role catalog rigor, playbooks, personas, prompt composition
node tests/team.test.mjs                  # roster, migration, statuses, drafting, linkage, member actions
node --test tests/thoughts.test.mjs       # thought intake: store, dispatch, guardrail, reconciliation
node --test tests/thought-hardening.test.mjs  # KB-6: duplicates, rate limits, intake audit, guardrail matrix
node --test tests/thought-lifecycle.test.mjs  # lifecycle: queue/drain, retry, cancel, edit, delete, audit
node tests/client.test.mjs                # client module shape, locale coverage, slot registrations
node --test tests/epic.test.mjs           # EPIC model: v1/v2/v3 migration, parent rules, invariants
node --test tests/epic-prd.test.mjs       # EPIC PRD template + decomposition rules (fake Harness)
node --test tests/autopilot-invariants.test.mjs  # KB-78: randomized boards, lane journey, migration/failure matrices, 24h cross-check
node --test tests/autopilot-*.test.mjs    # all autopilot suites: schema, planner, executor, refine/implement/review lanes, context pack, safety rails, UI, invariants
```

The autopilot suites are plain Node scripts that print one `ok`/`FAIL` line per check and exit non-zero
if any check fails; they use a fake Harness context and a frozen/injected clock, so they never wait on a
wall clock. `node --test tests/*.test.mjs` runs all of them and the exit code is the gate.

They run against temporary directories and a fake Harness context/client runtime.

The thought-intake probe is `node tools/kb14-probe.js`; it writes its evidence to `docs/screenshots/kb14/`.
The thought-lifecycle probe is `node tools/kb5-probe.js`; it drives the real GUI through a paused capture,
Resume drain, retry, cancel, detail/timeline and the deleted-thought ticket drawer at en+zh 1024/640, and
writes `docs/screenshots/kb5/final-verification.json` + PNGs.
The intake-hardening probe is `node tools/kb6-probe.js`; it is a dependency-free fake-Harness CLI that drives
the real `/kanban/action` handler through duplicate 409, rate-limit 429, the persisted intake audit and the
adversarial guardrail matrix, and writes `docs/screenshots/kb6/final-verification.json` (browser evidence for
the dialog toast is intentionally not captured: it would mutate the live board this GUI is showing).
The EPIC-model probe is `node tools/kb3-probe.js`; it writes its evidence to `docs/screenshots/kb3/`.
The EPIC-decomposition probe is `node tools/kb4-probe.js`; it is a dependency-free fake-Harness CLI
that prints the built `submitThought` brief (with the twelve PRD headings and the decision rule) and
replays the big-feature / small-bug / single-ticket / research / maximal-PRD fixtures, printing the
captured create arguments and persisted shapes. `--json` emits the same transcript machine-readably.
The cross-surface verification probe is `node tools/kb64-probe.js`; one invocation runs the suite twice
against the `default-workspace` scratch board and proves the ticket drawer (read mode, Edit/Preview
round-trip, Markdown comments, hostile HTML rendered literally), the Thoughts drawer and the scan
drawer at 1440×900 / 1024×768 / 640×900 in light and dark, in en and zh, with no horizontal overflow
and a console that must carry no errors or unhandled rejections (warnings are recorded but do not
fail). A startup sweep deletes `kb64-probe`-labelled fixtures leaked by an interrupted run, and every
`screenshots[].bytes` is re-checked against the file on disk so a stale pack cannot pass. It writes
`docs/screenshots/kb64/final-verification.json` plus labelled PNGs to `docs/screenshots/kb64/`. It
needs the running Web GUI (`DSH_WEB_URL`) and Chrome on CDP port 9333 (`DSH_CDP_PORT`) and cannot run
offline; `--runs=1` skips the determinism comparison.

## Harness integration

- **Agent Teams** — team membership/roles and teammate names come from `ctx.agentTeams`; the board is the shared work surface that teammates pull from, and per-member pause/resume cancels/resumes live turns through `ctx.sessionController`. A teammate session that joins is attached to the roster member whose name it matches (trimmed, case-insensitive display name or its kebab-case teammate id), and its running state drives that member's status.
- **Subagents** — a subagent session is not a team row on its own. When it matches a roster member it attaches to that person (and shows up as their running/idle status); otherwise it stays out of the fixed team list.
- **Skills** — registers the runtime skill `kanban-workflow`, generated from the role catalog at registration so it can never drift from the playbooks and Definition of Done.
- **Tools + Agent loop** — the `kanban` tool is the only mutation path for agents; it enforces WIP, roles, transitions, pause, and ownership. It adds `members` (roster + drafts) and `create_member` (member-drafting session or tech lead/lead only), and `whoami` returns the caller's playbook, persona and composed prompt. A `system-prompt` section (order 700) makes the policy visible in every request.
- **Session store / session controller** — live running state, durable conversation history, and "peek agent session" navigation via `uiWorkspace.openSession`.
- **Workspaces** — the project selector is the DSH workspace registry; one board per workspace.
- **Web/Client** — the UI is a root `main` panel plus a `sidebar.panellist` icon, styled only with host theme tokens and localized through the client locale service.
- **Shell/Subprocess** — the scanner discovers open GitHub PRs / GitLab MRs with `gh` / `glab` when available (best-effort, bounded, non-fatal).

## Not included yet / follow-ups

- **Parallel implementer sessions / per-ticket worktrees** — phase 1 runs one implementer at a time in
  the one shared working tree. Isolated git worktrees with artifact-pinned review, deterministic landing
  and tech-lead conflict arbitration are designed and accepted as conditional phase 2 in
  [`docs/AUTOPILOT_PHASE2.md`](docs/AUTOPILOT_PHASE2.md) (KB-81), but **not shipped**; until then
  `laneCaps.implement` must stay 1 and the phase-2 rollback (`board.autopilot.worktrees.enabled = false`)
  is not an operator step.
- **Per-lane cadence** — one cadence drives all three lane groups (default 5 min, 1–60 min). A separate
  cadence per lane is deferred scope from the EPIC (KB-66) and has **no dedicated follow-up ticket yet**
  (KB-81 covers the worktree phase-2 spine, not cadence); **Pulse now** covers on-demand runs.
- **Automatic member scheduling** — autopilot only selects from the existing roster (exact role first,
  then least recently activated, then roster order). Shifts, availability windows and member creation are
  human actions and also have **no dedicated follow-up ticket yet** (KB-66 defers per-member schedules to
  phase 2).
- **Start team / materialized teammate sessions** — idle roster members are not backed by permanent
  sessions; a session is created when a ticket is dispatched to the member.
- **Global cross-project roster** — the roster is stored per project board.
- **Per-member model, preset and access defaults** — those remain per dispatch/session.
- **Manual member ↔ session linking UI** — linking currently happens by dispatch or by name match.
- **Role editing or policy customization** — role ids, claim columns and transitions are platform-owned.
- **Localized playbook/persona content** — UI chrome is en + zh; playbook and persona text is English
  (the known `Ready 最大深度` label inconsistency is noted in the Autopilot section).
- **Push-based status** — the panel still polls every 2500ms.

## Screenshots

![Kanban board, light theme](docs/screenshots/board-light.png)
![Ticket drawer](docs/screenshots/ticket-drawer.png)
![Team rail](docs/screenshots/team-rail.png)
![Project scan](docs/screenshots/project-scan.png)
![Kanban board, dark theme](docs/screenshots/board-dark.png)
![Blocked lane](docs/screenshots/blocked-lane.png)
![Blocked questions in the drawer](docs/screenshots/blocked-questions.png)
![Agent running on a ticket](docs/screenshots/agent-running.png)
![Agent report after finishing](docs/screenshots/agent-report.png)
![Auto-assigned next lane](docs/screenshots/handoff-assignment.png)
![Handoff chip on the board](docs/screenshots/board-handoff.png)
![Access mode for a Ready ticket](docs/screenshots/access-mode-ready.png)
![Access mode for a Review ticket](docs/screenshots/access-mode-review.png)

## Verifying the UI yourself

`tools/` ships a dependency-free Chrome DevTools Protocol harness that authenticates
to the real Web GUI and drives it headlessly (click, type, drag, screenshots, console
capture). See [tools/README.md](tools/README.md). It was used to validate the board,
ticket drawer, drag & drop, team roster, per-agent pause/resume, board pause banner,
filters, search, project switching, scan drawer, open-session navigation, the blocked lane
with question answering, and a full UI-dispatched agent execution through to its report.

For the team panel specifically, run `node tools/kb13-probe.js`. It checks snapshot
v2 (seeded roster, compact roles), the Members/Drafts sections and attached-agent statuses, the member editor
and its composed-prompt preview, manual create/delete, the role-playbook viewer, Add-with-AI
drafting (or the labelled template fallback), and the narrow-panel rail/drawer behaviour. It
writes `docs/screenshots/kb13/final-verification.json` and PNG evidence to
`docs/screenshots/kb13/`.

For the EPIC model specifically, run `node tools/kb3-probe.js`. It checks the live v3 snapshot, the
New-ticket EPIC flow (forced Backlog), the EPIC badge/child count on cards, the parent chip (click and
keyboard), the EPIC drawer's PRD area and children list with its empty state, disabled moves and
blocked drag, 1024px/640px layouts with no horizontal overflow, and English/Chinese copy. It writes
`docs/screenshots/kb3/final-verification.json` and PNG evidence to `docs/screenshots/kb3/`.

For autopilot specifically, run:

```bash
node tools/autopilot-probe.js
```

The probe drives the real Kanban client bundle in the Web GUI, but it never touches your live
board: it boots the real `index.js` snapshot/action handlers in-process against two throwaway
projects in a temporary state directory, exposes them to the page through a short-lived local
bridge, and removes every temporary board in a `finally` block (the live project list is asserted
unchanged before/after). It exercises enabling autopilot, cadence/depth/lane caps, persistence
after a page refresh, the dry-run preview against the host plan, Pulse now and its pulse row, the
countdown, lane/member admission chips, the paused board, a stubbed failing dispatch, a rejected
configure and its rollback, and the empty feed — then captures the control panel, preview, pulse
feed, empty, error and paused states at 1024×768 and 640×900 in light/dark and en/zh (48 PNGs,
each checked for horizontal overflow). It writes
`docs/screenshots/autopilot/final-verification.json` (one record per check: id, description,
pass/fail, viewport, theme, locale, artifact path, console errors), prints the git commit it ran
against, exits non-zero if any check fails, and runs the whole suite twice by default so it can
assert both runs produce the same check ids (`--runs=1` for a quick single pass). It takes about
four minutes for the two runs. It attaches over CDP, so Chrome must already be running with the same flags as the
other probes (see the script header for the exact command):

```bash
mkdir -p .cdp-profile .chrome-home .chrome-tmp
HOME="$PWD/.chrome-home" TMPDIR="$PWD/.chrome-tmp" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9333 --user-data-dir="$PWD/.cdp-profile" \
  --no-first-run --no-default-browser-check --no-sandbox --disable-gpu \
  --disable-software-rasterizer --disable-breakpad --disable-crash-reporter \
  --disable-dev-shm-usage --in-process-gpu --window-size=1440,900 about:blank &
```

Set `DSH_WEB_URL` when the GUI is not on `http://127.0.0.1:50738`.

The autopilot probe is a GUI test and cannot run offline: it needs the running Web GUI
(`DSH_WEB_URL`, default `http://127.0.0.1:50738`) and a Chrome instance on CDP port 9333. The
offline-checkable commands (unit suites, syntax checks, board-file inspection) and their expected
output are listed in [`docs/AUTOPILOT_RUNBOOK.md`](docs/AUTOPILOT_RUNBOOK.md); the committed evidence
pack was produced by the probe and lives under `docs/screenshots/autopilot/`.
