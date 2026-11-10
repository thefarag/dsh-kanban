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

This project lives at `/Users/thefarag/Projects/AI/AI_Generated/HDS-Kanban` and is its own DSH
Workspace. It is linked into the DSH profile (`~/.dsh/profiles/desktop`) as a local bundle, so the
running Host resolves `@local/dsh-kanban` straight from this directory:

```jsonc
// ~/.dsh/profiles/desktop/package.json
"dependencies": { "@local/dsh-kanban": "link:/Users/thefarag/Projects/AI/AI_Generated/HDS-Kanban" }
```

To point another machine or profile at a checkout:

```
# in the DSH chat, ask the agent to install the bundle, or use the Plugins UI
plugin_manager install_bundle target=/absolute/path/to/HDS-Kanban
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
6. **Team** opens the team rail: the **Members** roster (name, title, role, live status, current
   ticket, last activity), **Add member** / **Add with AI**, **Drafts**, **Other agents** (sessions not
   linked to a roster member) and **Role playbooks**. Pause or resume a member, edit their
   name/title/role/persona, or pause the whole board (running agent turns are cancelled).

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

- **See who is doing what.** Each row shows a text status — **Working** (owns an in-progress or review
  ticket), **Running** (linked session running), **Idle**, **Offline** or **Paused** — plus the current
  ticket (`id · title`, click to open it), how long it has been working, and last activity. Statuses are
  computed by the Host from ticket ownership and the live session, not stored guesses.
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
`comment`, `release`, `block`, `unblock`, `assign`, `team`, `members`, `create_member`, `scan`,
`pause`, `resume`, `set_role`.

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

The ticket is *not* started automatically. Cards show a `→ Reviewer` (etc.) chip and the drawer shows
**Next up: <role> · Suggested agent: <name>** with a one-click **Start <role>** button. Starting creates a
new session for that role with the ticket context **plus the handoff reason and the previous agent's
report**, so the reviewer/next implementer inherits what happened. Starting clears the handoff; manual
reassignment replaces it.

The blocked lane is a view over the ticket's real lane: the underlying column never changes while
blocked, so answering the questions returns the ticket exactly where it was.

## Architecture

- `roles.js` — the platform role catalog and single source of truth (ESM, Node builtins only): the 10
  roles with playbooks and role DoD, derived policy tables (`ROLE_MOVE`, `TRANSITIONS`,
  `LANE_CLAIM_ROLES`, `DEV_ROLES`), the 10 curated `DEFAULT_MEMBERS` personas, `composeAgentPrompt`,
  `rolePlaybookText`, `personaTemplate`, and the generated `kanban-workflow` skill text.
- `index.js` — Host half. Node-builtins only.
  - `BoardStore`: per-workspace JSON boards under `$DSH_HOME/kanban/<workspace>.json`, atomic writes;
    board `version: 2` with a persisted `team` store, migrated on read from v1.
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
  - Scanner: docs walk, TODO/checkbox extraction, session-log summaries, `gh`/`glab` MR discovery.
- `client.js` — Web half. Registers the `sidebar.panellist` icon and the `main` panel key `kanban`,
  polls the host routes, and renders the drag-and-drop board, detail drawer, team rail (roster, drafts,
  member editor, role-playbook viewer), scan drawer, and toasts with host theme tokens only.
- `locale/{en,zh}.json` — Plugin Manager display metadata.
- `icon.svg` — Original artwork.

## Notes

- Session titles/status come from the live DSH session store; agent names/roles come from Agent Teams
  when present, otherwise from the session title and a keyword-based role inference that the user can
  override per agent in the Team rail's **Other agents** section.
- The roster is the source of people: a live session is linked to a member by name when it joins
  through Agent Teams or when a ticket is dispatched to that member. Unlinked sessions are still shown
  under **Other agents** so nothing regresses.
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
node tests/client.test.mjs                # client module shape, locale coverage, slot registrations
```

They run against temporary directories and a fake Harness context/client runtime.

## Harness integration

- **Agent Teams** — team membership/roles and teammate names come from `ctx.agentTeams`; the board is the shared work surface that teammates pull from, and per-agent pause/resume cancels/resumes live turns through `ctx.sessionController`. A teammate session that joins is auto-linked to the roster member whose name it matches (trimmed, case-insensitive).
- **Subagents** — every subagent session in the project appears in the team roster (with its parent/session title) and can be paused or resumed from the board.
- **Skills** — registers the runtime skill `kanban-workflow`, generated from the role catalog at registration so it can never drift from the playbooks and Definition of Done.
- **Tools + Agent loop** — the `kanban` tool is the only mutation path for agents; it enforces WIP, roles, transitions, pause, and ownership. It adds `members` (roster + drafts) and `create_member` (member-drafting session or tech lead/lead only), and `whoami` returns the caller's playbook, persona and composed prompt. A `system-prompt` section (order 700) makes the policy visible in every request.
- **Session store / session controller** — live running state, durable conversation history, and "peek agent session" navigation via `uiWorkspace.openSession`.
- **Workspaces** — the project selector is the DSH workspace registry; one board per workspace.
- **Web/Client** — the UI is a root `main` panel plus a `sidebar.panellist` icon, styled only with host theme tokens and localized through the client locale service.
- **Shell/Subprocess** — the scanner discovers open GitHub PRs / GitLab MRs with `gh` / `glab` when available (best-effort, bounded, non-fatal).

## Not included yet / follow-ups

- **Start team / materialized teammate sessions** — idle roster members are not backed by permanent
  sessions; a session is created when a ticket is dispatched to the member.
- **Global cross-project roster** — the roster is stored per project board.
- **Per-member model, preset and access defaults** — those remain per dispatch/session.
- **Manual member ↔ session linking UI** — linking currently happens by dispatch or by name match.
- **Role editing or policy customization** — role ids, claim columns and transitions are platform-owned.
- **Localized playbook/persona content** — UI chrome is en + zh; playbook and persona text is English.
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
v2 (seeded roster, compact roles), the Members/Drafts/Other agents sections, the member editor
and its composed-prompt preview, manual create/delete, the role-playbook viewer, Add-with-AI
drafting (or the labelled template fallback), and the narrow-panel rail/drawer behaviour. It
writes `docs/screenshots/kb13/final-verification.json` and PNG evidence to
`docs/screenshots/kb13/`.
