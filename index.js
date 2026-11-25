/**
 * Kanban board — Host half.
 *
 * A project-scoped, standard-practice Kanban board for the DeepSeek Harness:
 * - one board per DSH workspace/project, persisted as JSON under the DSH home;
 * - two authenticated same-origin HTTP routes the Web client polls;
 * - a `kanban` agent tool plus a system-prompt section that enforce the policy
 *   (WIP limits, role-based pull, strict transitions, review gate, pause);
 * - a project scanner that builds a board from vision/plan docs, TODO markers,
 *   checkboxes, recent AI conversations, and open MRs/PRs;
 * - team roster / pause / resume integration with live DSH sessions.
 *
 * Only Node builtins are imported so the bundle stays dependency-free.
 */

import { mkdir, readFile, writeFile, rename, readdir, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import {
  ROLES,
  ALL_ROLES,
  ROLE_INDEX,
  ROLE_MOVE,
  TRANSITIONS,
  LANE_CLAIM_ROLES,
  DEV_ROLES,
  DEFAULT_MEMBERS,
  DEFINITION_OF_READY,
  DEFINITION_OF_DONE,
  composeAgentPrompt,
  rolePlaybookText,
  buildSkillContent,
  personaTemplate,
} from './roles.js';

const run = promisify(execFile);

/** Cordis plugin name. */
export const name = 'kanban';

/** Services the board needs; optional peers are read with ctx.get(). */
export const inject = [
  'webServer',
  'connection',
  'workspaceRegistry',
  'sessionPersistence',
  'sessionController',
  'tools',
  'systemPrompt',
  'agents',
];

const VERSION = 3;
const TEAM_VERSION = 1;
// v3 adds `'epic'` and the optional additive `ticket.parentId`; no other board
// key changes shape, so v1/v2 boards migrate additively.
const TICKET_TYPES = ['story', 'task', 'bug', 'spike', 'epic'];
const MAX_BODY_BYTES = 512 * 1024;
const SESSION_CACHE_MS = 1500;
const ROSTER_LIMIT = 50;
const DRAFT_LIMIT = 3;
const DRAFT_TIMEOUT_MS = 120 * 1000;
const PERSONA_MAX = 6000;
const MEMBER_NAME_MAX = 48;
const MEMBER_TITLE_MAX = 60;
const MEMBER_DRAFT_DESCRIPTION_MAX = 1000;
// Thought intake (KB-1): a separate per-workspace store so the board schema
// stays v2. The record shape below is the whole public contract.
const THOUGHT_VERSION = 1;
const THOUGHT_TEXT_MAX = 4000;
const THOUGHT_WORKING_LIMIT = 3;
const THOUGHT_SNAPSHOT_MAX = 50;
const THOUGHT_GRACE_MS = 30 * 1000;
// KB-5 additive statuses: `queued` (captured while paused, drained on resume)
// and `cancelled` (terminal, never reconciled back to done/failed).
const THOUGHT_STATUSES = ['recorded', 'working', 'done', 'failed', 'queued', 'cancelled'];
const THOUGHT_QUEUE_MAX = 20;
// Audit: append-only per thought; the store keeps the newest 50, the polled
// snapshot exposes the newest 20 and bounds every serialized entry.
const THOUGHT_AUDIT_MAX = 50;
const THOUGHT_AUDIT_SNAPSHOT_MAX = 20;
const THOUGHT_AUDIT_ENTRY_MAX = 400;
const THOUGHT_EDIT_EXCERPT_MAX = 280;
const DELETED_THOUGHT_IDS_MAX = 100;
const THOUGHT_AUDIT_TYPES = ['status', 'ticket', 'edit', 'delete', 'retry'];
// KB-6 intake hardening: normalized duplicate protection, a per-workspace intake
// budget and a persisted intake audit (thought -> session -> tickets). All of it
// is additive to the KB-5 thought store: the envelope stays `version: 1`, the
// KB-5 `audit` timeline is untouched, and old rows simply lack the new fields.
const THOUGHT_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const THOUGHT_DUPLICATE_RECENT = 20;
const THOUGHT_RATE_MINUTE_MAX = 5;
const THOUGHT_RATE_HOUR_MAX = 20;
const THOUGHT_RATE_MINUTE_MS = 60 * 1000;
const THOUGHT_RATE_HOUR_MS = 60 * 60 * 1000;
// The persisted budget log only needs the last hour; keep a hard bound anyway.
const THOUGHT_RATE_LOG_MAX = 200;
const THOUGHT_INTAKE_AUDIT_MAX = 50;
const THOUGHT_INTAKE_AUDIT_SNAPSHOT_MAX = 50;
const THOUGHT_INTAKE_AUDIT_ENTRY_MAX = 260;
const THOUGHT_INTAKE_AUDIT_TYPES = ['submitted', 'dispatched', 'ticket-linked', 'failed'];
// A thought-dispatch session may read and create Backlog tickets, nothing else.
const THOUGHT_TOOL_ACTIONS = new Set([
  'whoami', 'projects', 'board', 'list', 'next', 'team', 'members', 'create',
]);
// ---------------------------------------------------------------------------
// Autopilot schema (KB-68) — additive under board `version: 3`
// ---------------------------------------------------------------------------
//
// The persisted surface is exactly two new board keys: `board.autopilot` (the
// configuration, the budget counters and this subtree's own `version: 1`
// envelope) and `board.pulses` (the newest-50 pulse ring). No existing board key
// changes shape and the board version stays 3: an older reader ignores both keys
// and a new reader synthesizes the defaults below when they are absent, so no
// migration command and no board-version bump are needed (KB-67 §4.4).
const AUTOPILOT_VERSION = 1;
const AUTOPILOT_PULSE_MAX = 50;
const AUTOPILOT_PULSE_DECISIONS_MAX = 50;
const AUTOPILOT_PULSE_DISPATCHES_MAX = 5;
const AUTOPILOT_TRIGGERS = ['timer', 'manual', 'resume'];
const AUTOPILOT_LANES = ['refine', 'implement', 'review'];
const TICKET_REVIEWS_MAX = 20;
// KB-73 structured review verdicts: additive `ticket.reviews[]` rows under board
// `version: 3`. Every new field is optional on read, so a ticket written before
// review verdicts existed loads with `reviews: []` and no migration command.
const TICKET_REVIEW_VERDICTS = ['accepted', 'changes-requested'];
const TICKET_REVIEW_CRITERIA_MAX = 40;
const TICKET_REVIEW_EVIDENCE_MAX = 20;
const REVIEW_NOTES_MAX = 4000;
const REVIEW_CRITERION_NOTE_MAX = 500;
const REVIEW_EVIDENCE_MAX = 500;
// KB-73 access decision (recorded in the ticket and docs/AUTOPILOT.md): a
// read-only sandbox cannot execute the repository test harness — `node --test`
// fails with EPERM on `mkdtemp` in TMPDIR — so a read-only reviewer could not
// re-run the checks the reviewer role requires. The review lane therefore runs
// the first preset whose sandbox is `workspace-write` (the "test-capable"
// policy): it can write temp files and execute tests, never dangerous access.
// The "do not edit source" rule is carried by the review brief; the verdict is
// the lane's only required mutation and the postcondition audits it.
const REVIEW_ACCESS_POLICY = 'test-capable';
const REVIEW_ACCESS_SANDBOX = 'workspace-write';
// One numbered acceptance criterion line ("1. ...", "2) ...").
const REVIEW_AC_ITEM_PATTERN = /^\s*(\d+)[.)]\s+(.+)$/;
// KB-74 handoff context pack: every dispatch brief carries the newest structured
// review verdicts and the attempt history, so the next agent starts from the
// persisted record instead of reconstructing it from a comment scroll. Both
// sections are composed from persisted state only (`ticket.reviews`,
// `ticket.execution`, the postcondition comments) and share one hard budget so
// history can never crowd out the role playbook or the ticket itself. The cap is
// applied by trimming the oldest block first; each block is additionally bounded
// so a single hostile verdict cannot exhaust the budget on its own.
const CONTEXT_PACK_MAX = 6000;
const CONTEXT_REVIEW_MAX = 3;
const CONTEXT_REVIEW_NOTES_MAX = 2000;
const CONTEXT_REPORT_MAX = 1200;
const CONTEXT_ERROR_MAX = 1200;
// The attempt-history change request is a SUMMARY: the full blocking notes (up
// to CONTEXT_REVIEW_NOTES_MAX) already live in the review history block, so the
// pack does not spend its budget quoting the same long note twice.
const CONTEXT_CHANGE_REQUEST_MAX = 300;
const CONTEXT_CRITERION_NOTE_MAX = 300;
const CONTEXT_CRITERION_NOTES_MAX = 6;
const CONTEXT_EVIDENCE_ITEMS_MAX = 6;
const CONTEXT_EVIDENCE_ITEM_MAX = 180;
const AUTOPILOT_HOUR_MS = 60 * 60 * 1000;
const AUTOPILOT_DAY_MS = 24 * AUTOPILOT_HOUR_MS;
// A consecutive pulse-error backoff doubles per pulse but never exceeds an hour.
const AUTOPILOT_MAX_BACKOFF_MS = 60 * 60 * 1000;
// Ticket AC 2 / AC 3 bounds. Reads clamp to the nearest bound; writes reject.
const AUTOPILOT_BOUNDS = {
  cadenceMs: { min: 60_000, max: 3_600_000, fallback: 300_000 },
  maxReadyDepth: { min: 0, max: 20, fallback: 3, integer: true },
  laneCap: { min: 0, max: 3, fallback: 1, integer: true },
  maxDispatchesPerPulse: { min: 1, max: 5, fallback: 1, integer: true },
  budgetHour: { min: 1, max: 200, fallback: 20, integer: true },
  budgetDay: { min: 1, max: 1000, fallback: 60, integer: true },
  backoffMs: { min: 60_000, max: 3_600_000, fallback: 300_000 },
  staleMs: { min: 60_000, max: 3_600_000, fallback: 600_000 },
};
// Every key a `configure` patch may name. Anything else is rejected (AC 2).
const AUTOPILOT_CONFIG_FIELDS = [
  'enabled',
  'cadenceMs',
  'maxReadyDepth',
  'laneCaps',
  'maxDispatchesPerPulse',
  'budget',
  'backoffMs',
  'staleMs',
];
// The scalar numeric fields: the same table validates writes and normalizes reads.
const AUTOPILOT_WRITE_NUMBERS = {
  cadenceMs: AUTOPILOT_BOUNDS.cadenceMs,
  maxReadyDepth: AUTOPILOT_BOUNDS.maxReadyDepth,
  maxDispatchesPerPulse: AUTOPILOT_BOUNDS.maxDispatchesPerPulse,
  backoffMs: AUTOPILOT_BOUNDS.backoffMs,
  staleMs: AUTOPILOT_BOUNDS.staleMs,
};
// KB-71/KB-72 lanes: the closed outcome vocabulary a pulse records when an
// autopilot session's turn is over. `postcondition-failed` is also the persisted
// comment marker the planner reads for its cooldown/loop guard; `deferred` means
// the session blocked on a fact only the user can supply. The vocabulary is
// lane-agnostic; which lanes may record an outcome is the closed set below.
const AUTOPILOT_OUTCOME_CODES = ['satisfied', 'deferred', 'postcondition-failed'];
// Lanes that record a verified outcome row on the pulse (KB-71 refine, KB-72
// implement, KB-73 review).
const AUTOPILOT_OUTCOME_LANES = ['refine', 'implement', 'review'];
// Execution statuses that mean the session's turn is over (it finished, ended
// without finishing, blocked on the user, or died).
const AUTOPILOT_ENDED_STATUSES = new Set(['done', 'idle', 'blocked', 'failed', 'cancelled']);
// One pulse never carries more than this many outcome rows (bounded like
// decisions/dispatched so a restored corrupt board stays small).
const AUTOPILOT_PULSE_OUTCOMES_MAX = 8;
// ---------------------------------------------------------------------------
// Autopilot safety rails (KB-75) — additive per-ticket failure state under v3
// ---------------------------------------------------------------------------
//
// KB-75 owns the run-away protections: the per-ticket consecutive-failure
// counter and exponential backoff, the stale-execution watchdog, the loop guard
// and the master-stop bookkeeping. Their persisted home is one additive optional
// key per ticket, `ticket.autopilot`; an older board that lacks it reads exactly
// as before (0 attempts, no backoff), so no migration command and no board
// version bump are needed. The same rules are applied by the planner (KB-69) for
// admission and by the executor (KB-70 hook) after a dispatch or postcondition.
const TICKET_AUTOPILOT_VERSION = 1;
// A ticket is parked after this many consecutive autopilot failures. Kept in
// lock-step with the planner's loop-guard gate below.
const AUTOPILOT_LOOP_GUARD_LIMIT = 3;
// A hand-edited counter can never grow the persisted row without bound.
const TICKET_AUTOPILOT_FAILURES_MAX = 1000;
// Closed set of reasons a ticket accrues a failure for. `stale` covers the
// watchdog and `dispatch-failed` a throw, so AC 2's "threw or ended without its
// lane postcondition" shares one counter.
const TICKET_AUTOPILOT_FAILURE_KINDS = ['postcondition-failed', 'dispatch-failed', 'stale'];
const TICKET_AUTOPILOT_STALE_TEXT_MAX = 300;
// The exact phrase the refine postcondition looks for in the description. It is
// part of the frozen contract: the brief asks for a heading containing it.
const REFINE_AC_PATTERN = /\bacceptance criteria\b/i;

const COLUMNS = [
  { id: 'backlog', title: 'Backlog', order: 0 },
  { id: 'ready', title: 'Ready', order: 1 },
  { id: 'in_progress', title: 'In Progress', order: 2 },
  { id: 'review', title: 'Review', order: 3 },
  { id: 'done', title: 'Done', order: 4 },
];
const COLUMN_IDS = COLUMNS.map((column) => column.id);
const COLUMN_INDEX = Object.fromEntries(COLUMN_IDS.map((id, index) => [id, index]));
const FORWARD = { backlog: 'ready', ready: 'in_progress', in_progress: 'review', review: 'done' };
const BACKWARD = { ready: 'backlog', in_progress: 'ready', review: 'in_progress', done: 'review' };
const EXECUTION_STATUSES = ['running', 'idle', 'blocked', 'paused', 'done', 'failed', 'cancelled'];
const EXECUTION_SUCCESS_COLUMNS = {
  backlog: ['ready'],
  ready: ['review', 'done'],
  in_progress: ['review', 'done'],
  review: ['done', 'in_progress'],
  done: ['done'],
};
const LANE_LABEL = { backlog: 'Backlog', ready: 'Ready', in_progress: 'In Progress', review: 'Review', done: 'Done' };
// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'KanbanError';
    this.status = status;
    this.code = code;
    // Optional machine-readable hint (KB-75 AC 1: the budget refusal carries a
    // `retryAfterSeconds`). Additive: an error without details serializes exactly
    // as before, so no existing client contract changes.
    this.details = details && typeof details === 'object' && !Array.isArray(details) ? details : null;
  }
}

const badRequest = (message) => new ApiError(400, 'bad-request', message);
const notFound = (message) => new ApiError(404, 'ticket/not-found', message);
const parentInvalid = (message) => new ApiError(400, 'ticket/parent-invalid', message);
const epicBacklogOnly = () =>
  new ApiError(409, 'epic/backlog-only', 'An EPIC lives in Backlog only; it cannot move to another column.');
const epicNotClaimable = () =>
  new ApiError(409, 'epic/not-claimable', 'An EPIC cannot be claimed or run by an agent; decompose it into child tickets first.');
const epicHasChildren = (count) =>
  new ApiError(409, 'epic/has-children', `This EPIC still has ${count} child ticket(s). Remove the children before deleting or converting it.`);

function errorPayload(error) {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: { ok: false, error: { code: 'internal', message } } };
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const now = () => Date.now();
const uid = () => randomUUID();
const clampString = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const safeArray = (value) => (Array.isArray(value) ? value : []);

function dshHome() {
  const env = process.env.DSH_HOME;
  return typeof env === 'string' && env.length > 0 ? env : join(homedir(), '.dsh');
}

function safeFileName(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

function isInside(candidate, parent) {
  if (typeof candidate !== 'string' || typeof parent !== 'string') return false;
  if (!candidate || !parent) return false;
  const a = candidate.length > 1 && candidate.endsWith(sep) ? candidate.slice(0, -1) : candidate;
  const b = parent.length > 1 && parent.endsWith(sep) ? parent.slice(0, -1) : parent;
  return a === b || a.startsWith(b + sep);
}

function sessionTitleOf(summary) {
  const title = summary?.projections?.values?.title;
  if (typeof title === 'string' && title.trim().length > 0) return title.trim().slice(0, 160);
  if (summary?.blank) return 'New session';
  return `Session ${String(summary?.sessionId ?? '').slice(-6)}`;
}

function priorityRank(priority) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[priority] ?? 2;
}

function inferRole(text) {
  const value = String(text ?? '').toLowerCase();
  if (/\b(ux|design|wireframe|figma|user flow|prototype|usability)\b/.test(value)) return 'ux-designer';
  if (/\b(review|code review|peer review|approve)\b/.test(value)) return 'reviewer';
  if (/\b(test|qa|e2e|coverage|regression test|verification)\b/.test(value)) return 'tester';
  if (/\b(deploy|ci\/cd|infra|docker|kubernetes|k8s|observability|monitoring|sre|ops|terraform)\b/.test(value)) return 'sre';
  if (/\b(product|vision|roadmap|requirement|prd|story|acceptance criteria|spec)\b/.test(value)) return 'product-manager';
  if (/\b(bug|bugfix|bug-fix|fix|crash|regression|broken|root cause|stack trace)\b/.test(value)) return 'bug-fixer';
  if (/\b(api|backend|back-end|server|database|db|endpoint|migration|schema|auth|graphql|rest)\b/.test(value)) return 'be-developer';
  if (/\b(frontend|front-end|react|vue|css|component|screen|layout|browser|ui)\b/.test(value)) return 'fe-developer';
  return 'fullstack-developer';
}

function inferTier(title, text) {
  const value = `${title} ${text}`.toLowerCase();
  if (/\b(critical|blocker|security|data loss|outage|sev1|p0)\b/.test(value)) return 'critical';
  if (/\b(bug|fix|crash|broken|regression|error|urgent|high)\b/.test(value)) return 'high';
  if (/\b(perf|performance|slow|refactor|improve|medium)\b/.test(value)) return 'medium';
  return 'low';
}

function inferType(title, text) {
  const value = `${title} ${text}`.toLowerCase();
  if (/\b(bug|fix|crash|broken|regression|error|security)\b/.test(value)) return 'bug';
  if (/\b(investigate|research|explore|spike|evaluate|prototype)\b/.test(value)) return 'spike';
  if (/^#{1,3}\s/.test(text) || /\b(story|user story|feature|add|build|implement)\b/.test(value)) return 'story';
  return 'task';
}

// ---------------------------------------------------------------------------
// Board state
// ---------------------------------------------------------------------------

function defaultWip(config) {
  return {
    backlog: 0,
    ready: 0,
    in_progress: positiveInt(config?.wipInProgress, 3),
    review: positiveInt(config?.wipReview, 5),
    done: 0,
  };
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

const MIGRATED = Symbol('kanbanMigrated');

function emptyTeam() {
  return { version: TEAM_VERSION, seededAt: null, members: [], drafts: [] };
}

function normalizeMember(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const roleId = ALL_ROLES.includes(raw.roleId) ? raw.roleId : null;
  if (!roleId) return null;
  const name = clampString(raw.name, MEMBER_NAME_MAX);
  if (!name) return null;
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : `member-${uid()}`,
    name,
    title: clampString(raw.title, MEMBER_TITLE_MAX),
    roleId,
    persona: clampString(raw.persona, PERSONA_MAX) || personaTemplate(roleId),
    paused: raw.paused === true,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    // KB-69 additive fairness key: the last autopilot activation of this member,
    // persisted so the planner can rotate least-recently-activated first without
    // any in-memory history. Old rosters read as 0 (never activated) and are
    // never rewritten unless another write touches the board.
    lastActivatedAt: Number.isFinite(raw.lastActivatedAt) && raw.lastActivatedAt >= 0
      ? Math.trunc(raw.lastActivatedAt)
      : 0,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    createdBy: clampString(raw.createdBy, 120) || 'system',
    source: ['seed', 'manual', 'ai'].includes(raw.source) ? raw.source : 'manual',
  };
}

function normalizeDraft(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const status = ['drafting', 'failed', 'cancelled'].includes(raw.status) ? raw.status : 'failed';
  return {
    id: raw.id.slice(0, 80),
    description: clampString(raw.description, MEMBER_DRAFT_DESCRIPTION_MAX),
    roleId: ALL_ROLES.includes(raw.roleId) ? raw.roleId : null,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    status,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : now(),
    ...(typeof raw.error === 'string' && raw.error ? { error: raw.error.slice(0, 600) } : {}),
    ...(typeof raw.mode === 'string' && raw.mode ? { mode: raw.mode.slice(0, 40) } : {}),
  };
}

function normalizeTeam(raw) {
  const team = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const members = [];
  for (const entry of Array.isArray(team.members) ? team.members : []) {
    const member = normalizeMember(entry);
    if (!member || seen.has(member.id)) continue;
    seen.add(member.id);
    members.push(member);
    if (members.length >= ROSTER_LIMIT) break;
  }
  const drafts = [];
  for (const entry of Array.isArray(team.drafts) ? team.drafts : []) {
    const draft = normalizeDraft(entry);
    if (draft) drafts.push(draft);
    if (drafts.length >= 20) break;
  }
  return {
    version: TEAM_VERSION,
    seededAt: Number.isFinite(team.seededAt) ? team.seededAt : null,
    members,
    drafts,
  };
}

/** Seed the ten curated specialists exactly once; deleting members never re-seeds. */
function seedTeam(board) {
  if (board.team.seededAt !== null) return false;
  const at = now();
  board.team.members = DEFAULT_MEMBERS.map((definition) => ({
    id: `member-${definition.roleId}`,
    name: definition.name,
    title: definition.title,
    roleId: definition.roleId,
    persona: definition.persona || personaTemplate(definition.roleId),
    paused: false,
    sessionId: null,
    lastActivatedAt: 0,
    createdAt: at,
    updatedAt: at,
    createdBy: 'system',
    source: 'seed',
  }));
  board.team.seededAt = at;
  return true;
}

/** A drafting agent that never calls create_member must surface as a retryable error. */
function reconcileDrafts(board) {
  const timedOut = [];
  const at = now();
  for (const draft of board.team.drafts) {
    if (draft.status !== 'drafting') continue;
    if (at - draft.createdAt <= DRAFT_TIMEOUT_MS) continue;
    if (draft.sessionId) timedOut.push(draft.sessionId);
    draft.status = 'failed';
    draft.error = 'Draft timed out before the AI created the member. Retry to try again.';
    draft.sessionId = null;
  }
  return timedOut;
}

// ---------------------------------------------------------------------------
// Thought records (KB-1)
// ---------------------------------------------------------------------------

/** Trim to at most `limit` characters (audit excerpts, ids, labels). */
function clip(value, limit) {
  return String(value ?? '').slice(0, limit);
}

/**
 * Normalize one audit entry. KB-5 additive: an old KB-1 record carries no
 * audit and loads with no added key, so the file is never rewritten on read.
 */
function normalizeAuditEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isFinite(raw.at)) return null;
  const type = THOUGHT_AUDIT_TYPES.includes(raw.type) ? raw.type : 'status';
  const entry = { at: raw.at, type, actor: clip(raw.actor, 60) || 'system' };
  if (THOUGHT_STATUSES.includes(raw.from)) entry.from = raw.from;
  if (THOUGHT_STATUSES.includes(raw.to)) entry.to = raw.to;
  if (typeof raw.ticketId === 'string' && raw.ticketId) entry.ticketId = clip(raw.ticketId, 40);
  if (typeof raw.thoughtId === 'string' && raw.thoughtId) entry.thoughtId = clip(raw.thoughtId, 40);
  if (typeof raw.previous === 'string') entry.previous = clip(raw.previous, THOUGHT_EDIT_EXCERPT_MAX);
  if (typeof raw.new === 'string') entry.new = clip(raw.new, THOUGHT_EDIT_EXCERPT_MAX);
  return entry;
}

/** Append one entry, keeping the newest 50 (oldest pruned). */
function appendThoughtAudit(thought, entry) {
  const normalized = normalizeAuditEntry(entry);
  if (!normalized) return;
  const list = Array.isArray(thought.audit) ? thought.audit : [];
  list.push(normalized);
  thought.audit = list.slice(-THOUGHT_AUDIT_MAX);
}

// ---------------------------------------------------------------------------
// Thought intake hardening (KB-6)
// ---------------------------------------------------------------------------

/**
 * The one duplicate-detection normalizer: trim, collapse internal whitespace to
 * a single space and case-fold. Punctuation is preserved, so "Ship it!" and
 * "ship it" collide but "Ship it!" and "Ship it" do not.
 */
function normalizeThoughtText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Resolve the host intake budget. Invalid or missing values fall back to the defaults. */
function normalizeThoughtRateLimits(value) {
  const raw = value && typeof value === 'object' ? value : {};
  const perMinute =
    Number.isInteger(raw.perMinute) && raw.perMinute > 0 ? raw.perMinute : THOUGHT_RATE_MINUTE_MAX;
  const perHour = Number.isInteger(raw.perHour) && raw.perHour > 0 ? raw.perHour : THOUGHT_RATE_HOUR_MAX;
  // The hourly ceiling can never sit below the per-minute one, or the hour window
  // would be dead config.
  return { perMinute, perHour: Math.max(perHour, perMinute) };
}

/** Normalize one persisted intake-audit event. Unknown kinds are dropped. */
function normalizeIntakeAuditEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isFinite(raw.at)) return null;
  if (!THOUGHT_INTAKE_AUDIT_TYPES.includes(raw.type)) return null;
  const actor = clip(raw.actor, 60) || 'system';
  const entry = { at: raw.at, type: raw.type, actor };
  if (typeof raw.sessionId === 'string' && raw.sessionId) entry.sessionId = clip(raw.sessionId, 80);
  if (typeof raw.ticketId === 'string' && raw.ticketId) entry.ticketId = clip(raw.ticketId, 40);
  return entry;
}

/**
 * Append one intake-audit event. The list is append-only and oldest-pruned at
 * 50 entries per thought; dedupe of ticket links lives in the caller so a
 * repeated link can never add a second `ticket-linked` event.
 */
function appendThoughtIntake(thought, entry) {
  const normalized = normalizeIntakeAuditEntry(entry);
  if (!normalized) return;
  const list = Array.isArray(thought.intakeAudit) ? thought.intakeAudit : [];
  list.push(normalized);
  thought.intakeAudit = list.slice(-THOUGHT_INTAKE_AUDIT_MAX);
}

/** Bound one intake event for the polled snapshot (the shape is already small). */
function snapshotIntakeAuditEntry(entry) {
  const out = { at: entry.at, type: entry.type, actor: clip(entry.actor, 60) };
  if (entry.sessionId) out.sessionId = clip(entry.sessionId, 80);
  if (entry.ticketId) out.ticketId = clip(entry.ticketId, 40);
  return JSON.stringify(out).length > THOUGHT_INTAKE_AUDIT_ENTRY_MAX
    ? { at: out.at, type: out.type, actor: clip(out.actor, 20) }
    : out;
}

/**
 * Persist a status transition + its audit entry. Returns false when the status
 * is unchanged, so callers can skip writes (idempotent reconciliation).
 */
function transitionThought(thought, to, { actor = 'system', at = now(), error } = {}) {
  if (!THOUGHT_STATUSES.includes(to) || thought.status === to) return false;
  const from = thought.status;
  thought.status = to;
  thought.updatedAt = at;
  if (error !== undefined) thought.error = error;
  appendThoughtAudit(thought, { at, type: 'status', actor, from, to });
  return true;
}

/** The public ThoughtRow shape. Nothing implementation-only leaks into it. */
function normalizeThought(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !/^TH-\d+$/.test(raw.id)) return null;
  const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, THOUGHT_TEXT_MAX) : '';
  if (!text) return null;
  const status = THOUGHT_STATUSES.includes(raw.status) ? raw.status : 'failed';
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now();
  const ticketIds = [];
  for (const entry of Array.isArray(raw.ticketIds) ? raw.ticketIds : []) {
    if (typeof entry !== 'string' || !entry || ticketIds.includes(entry)) continue;
    ticketIds.push(entry);
  }
  const retryOf = typeof raw.retryOf === 'string' && /^TH-\d+$/.test(raw.retryOf) ? raw.retryOf : null;
  const deletedAt = Number.isFinite(raw.deletedAt) && raw.deletedAt > 0 ? raw.deletedAt : null;
  const editedAt = Number.isFinite(raw.editedAt) && raw.editedAt > 0 ? raw.editedAt : null;
  const audit = [];
  for (const entry of Array.isArray(raw.audit) ? raw.audit : []) {
    const normalized = normalizeAuditEntry(entry);
    if (normalized) audit.push(normalized);
  }
  const intakeAudit = [];
  for (const entry of Array.isArray(raw.intakeAudit) ? raw.intakeAudit : []) {
    const normalized = normalizeIntakeAuditEntry(entry);
    if (normalized) intakeAudit.push(normalized);
  }
  return {
    id: raw.id,
    text,
    status,
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId ? raw.sessionId : null,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 2000) : '',
    ticketIds,
    ...(retryOf ? { retryOf } : {}),
    ...(deletedAt ? { deletedAt } : {}),
    ...(editedAt ? { editedAt } : {}),
    ...(audit.length > 0 ? { audit: audit.slice(-THOUGHT_AUDIT_MAX) } : {}),
    // KB-6 additive: absent on KB-1/KB-5 files so an old store is never rewritten.
    ...(intakeAudit.length > 0 ? { intakeAudit: intakeAudit.slice(-THOUGHT_INTAKE_AUDIT_MAX) } : {}),
  };
}

/**
 * Bound one audit entry for the polled snapshot: edit excerpts shrink first so
 * the serialized entry never exceeds 400 characters.
 */
function snapshotAuditEntry(entry) {
  const out = { at: entry.at, type: entry.type, actor: clip(entry.actor, 60) };
  if (entry.from !== undefined) out.from = entry.from;
  if (entry.to !== undefined) out.to = entry.to;
  if (entry.ticketId) out.ticketId = clip(entry.ticketId, 40);
  if (entry.thoughtId) out.thoughtId = clip(entry.thoughtId, 40);
  if (typeof entry.previous === 'string') out.previous = clip(entry.previous, THOUGHT_EDIT_EXCERPT_MAX);
  if (typeof entry.new === 'string') out.new = clip(entry.new, THOUGHT_EDIT_EXCERPT_MAX);
  let serialized = JSON.stringify(out).length;
  while (serialized > THOUGHT_AUDIT_ENTRY_MAX && (typeof out.previous === 'string' || typeof out.new === 'string')) {
    if (typeof out.previous === 'string' && out.previous.length > 0) {
      out.previous = out.previous.slice(0, Math.max(0, out.previous.length - 40));
    } else if (typeof out.new === 'string' && out.new.length > 0) {
      out.new = out.new.slice(0, Math.max(0, out.new.length - 40));
    } else {
      delete out.previous;
      delete out.new;
    }
    serialized = JSON.stringify(out).length;
  }
  if (serialized > THOUGHT_AUDIT_ENTRY_MAX) {
    return { at: out.at, type: out.type, actor: clip(out.actor, 20), ...(out.to ? { to: out.to } : {}) };
  }
  return out;
}

function emptyThoughtState() {
  return { version: THOUGHT_VERSION, nextNumber: 1, thoughts: [] };
}

/** Tolerant read: anything unparseable degrades to an empty thought list. */
function normalizeThoughtState(raw) {
  const state = emptyThoughtState();
  if (!raw || typeof raw !== 'object') return state;
  const seen = new Set();
  for (const entry of Array.isArray(raw.thoughts) ? raw.thoughts : []) {
    const thought = normalizeThought(entry);
    if (!thought || seen.has(thought.id)) continue;
    seen.add(thought.id);
    state.thoughts.push(thought);
  }
  let highest = 0;
  for (const thought of state.thoughts) {
    const number = Number(thought.id.slice(3));
    if (number > highest) highest = number;
  }
  state.nextNumber =
    Number.isInteger(raw.nextNumber) && raw.nextNumber > highest ? raw.nextNumber : highest + 1;
  // KB-6 additive: the persisted intake budget only exists once a submission is
  // accepted; it is bounded to the newest THOUGHT_RATE_LOG_MAX timestamps.
  const rateLog = [];
  for (const entry of Array.isArray(raw.rateLog) ? raw.rateLog : []) {
    if (Number.isFinite(entry) && entry > 0) rateLog.push(entry);
  }
  if (rateLog.length > 0) {
    state.rateLog = rateLog.sort((left, right) => left - right).slice(-THOUGHT_RATE_LOG_MAX);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Autopilot normalization (migrate-on-read, AC 1/AC 3/AC 4)
// ---------------------------------------------------------------------------

/** The default budget windows: `limit` is configured, `used`/`windowStart` are runtime state. */
function defaultAutopilotBudget() {
  return {
    hour: { limit: AUTOPILOT_BOUNDS.budgetHour.fallback, used: 0, windowStart: 0 },
    day: { limit: AUTOPILOT_BOUNDS.budgetDay.fallback, used: 0, windowStart: 0 },
  };
}

/** The synthesized `board.autopilot` envelope: ticket AC 1 defaults, subtree `version: 1`. */
function defaultAutopilot() {
  return {
    version: AUTOPILOT_VERSION,
    enabled: false,
    cadenceMs: AUTOPILOT_BOUNDS.cadenceMs.fallback,
    maxReadyDepth: AUTOPILOT_BOUNDS.maxReadyDepth.fallback,
    laneCaps: { refine: 1, implement: 1, review: 1 },
    maxDispatchesPerPulse: AUTOPILOT_BOUNDS.maxDispatchesPerPulse.fallback,
    budget: defaultAutopilotBudget(),
    backoffMs: AUTOPILOT_BOUNDS.backoffMs.fallback,
    staleMs: AUTOPILOT_BOUNDS.staleMs.fallback,
    updatedAt: 0,
    updatedBy: 'system',
  };
}

/**
 * Read-side repair of one numeric autopilot field: absent/non-finite/wrong-type
 * values fall back to the documented default, out-of-range values clamp to the
 * nearest bound. Every repair appends a reason so the caller can record one
 * normalization note (AC 3).
 */
function repairAutopilotNumber(value, spec, label, reasons) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    reasons.push(`${label}: expected a finite number, defaulted to ${spec.fallback}`);
    return spec.fallback;
  }
  if (spec.integer && !Number.isInteger(value)) {
    reasons.push(`${label}: expected an integer, defaulted to ${spec.fallback}`);
    return spec.fallback;
  }
  const clamped = Math.min(spec.max, Math.max(spec.min, value));
  if (clamped !== value) reasons.push(`${label}: clamped ${value} to ${clamped}`);
  return clamped;
}

/**
 * Repair one budget window. Accepts both the persisted window object
 * (`{limit, used, windowStart}`) and the ticket AC 1 scalar shape (`hour: 20`),
 * so a hand-written default board still loads. `used` never exceeds `limit`.
 */
function normalizeAutopilotBudgetWindow(raw, spec, label, reasons) {
  if (raw === undefined) {
    reasons.push(`${label}: missing, defaulted to ${spec.fallback}`);
    return { limit: spec.fallback, used: 0, windowStart: 0 };
  }
  if (typeof raw === 'number') {
    return { limit: repairAutopilotNumber(raw, spec, `${label}.limit`, reasons), used: 0, windowStart: 0 };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    reasons.push(`${label}: expected an object, defaulted to ${spec.fallback}`);
    return { limit: spec.fallback, used: 0, windowStart: 0 };
  }
  const limit = repairAutopilotNumber(raw.limit, spec, `${label}.limit`, reasons);
  let used = 0;
  if (Number.isFinite(raw.used)) used = Math.max(0, Math.round(raw.used));
  else if (raw.used !== undefined) reasons.push(`${label}.used: expected a finite number, reset to 0`);
  if (used > limit) {
    used = limit;
    reasons.push(`${label}.used: clamped to the limit ${limit}`);
  }
  let windowStart = 0;
  if (Number.isFinite(raw.windowStart) && raw.windowStart >= 0) windowStart = Math.trunc(raw.windowStart);
  else if (raw.windowStart !== undefined) reasons.push(`${label}.windowStart: reset to 0`);
  for (const key of Object.keys(raw)) {
    if (!['limit', 'used', 'windowStart'].includes(key)) reasons.push(`${label}: dropped unknown field ${key}`);
  }
  return { limit, used, windowStart };
}

/**
 * Normalize `board.autopilot` from persisted state (AC 1/AC 3).
 * - absent key: synthesize defaults in memory and do NOT force a write on read;
 * - present but invalid: repair each field independently, never throw, and
 *   report the reasons so normalizeBoard can persist one normalization note;
 * - unknown subtree `version`: fail safe to disabled, keep the rest of the board.
 * Only a literal `enabled === true` under a known version can enable autopilot.
 */
function normalizeAutopilotState(raw) {
  if (raw === undefined) {
    return { value: defaultAutopilot(), changed: false, kind: null, reasons: [] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      value: defaultAutopilot(),
      changed: true,
      kind: 'autopilot/config-normalized',
      reasons: ['subtree was not an object'],
    };
  }
  const reasons = [];
  const out = defaultAutopilot();
  const knownVersion = raw.version === AUTOPILOT_VERSION;
  if (!knownVersion) {
    reasons.push(raw.version === undefined ? 'version: missing, reset to 1' : `version: ${String(raw.version)} is unknown, reset to 1`);
    reasons.push('enabled: forced off after an unknown envelope version');
  } else if (raw.enabled === true) {
    out.enabled = true;
  } else if (raw.enabled !== undefined && raw.enabled !== false) {
    reasons.push('enabled: expected a literal boolean, forced off');
  }
  for (const [field, spec] of Object.entries(AUTOPILOT_WRITE_NUMBERS)) {
    out[field] = repairAutopilotNumber(raw[field], spec, field, reasons);
  }
  if (raw.laneCaps === undefined) {
    reasons.push('laneCaps: missing, defaulted');
  } else if (!raw.laneCaps || typeof raw.laneCaps !== 'object' || Array.isArray(raw.laneCaps)) {
    reasons.push('laneCaps: expected an object, defaulted');
  } else {
    for (const lane of AUTOPILOT_LANES) {
      out.laneCaps[lane] = repairAutopilotNumber(
        raw.laneCaps[lane],
        AUTOPILOT_BOUNDS.laneCap,
        `laneCaps.${lane}`,
        reasons,
      );
    }
    for (const key of Object.keys(raw.laneCaps)) {
      if (!AUTOPILOT_LANES.includes(key)) reasons.push(`laneCaps: dropped unknown lane ${key}`);
    }
  }
  if (raw.budget === undefined) {
    reasons.push('budget: missing, defaulted');
  } else if (!raw.budget || typeof raw.budget !== 'object' || Array.isArray(raw.budget)) {
    reasons.push('budget: expected an object, defaulted');
  } else {
    out.budget.hour = normalizeAutopilotBudgetWindow(raw.budget.hour, AUTOPILOT_BOUNDS.budgetHour, 'budget.hour', reasons);
    out.budget.day = normalizeAutopilotBudgetWindow(raw.budget.day, AUTOPILOT_BOUNDS.budgetDay, 'budget.day', reasons);
    for (const key of Object.keys(raw.budget)) {
      if (!['hour', 'day'].includes(key)) reasons.push(`budget: dropped unknown field ${key}`);
    }
  }
  if (Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0) out.updatedAt = Math.trunc(raw.updatedAt);
  else if (raw.updatedAt !== undefined) reasons.push('updatedAt: reset to 0');
  if (typeof raw.updatedBy === 'string' && raw.updatedBy.trim()) out.updatedBy = clampString(raw.updatedBy, 80);
  else if (raw.updatedBy !== undefined) reasons.push('updatedBy: reset to system');
  const allowed = new Set(['version', ...AUTOPILOT_CONFIG_FIELDS, 'updatedAt', 'updatedBy']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) reasons.push(`dropped unknown field ${key}`);
  }
  return {
    value: out,
    changed: reasons.length > 0,
    kind: knownVersion ? 'autopilot/config-normalized' : 'autopilot/config-version-unknown',
    reasons,
  };
}

/**
 * The safe default per-ticket safety state (KB-75 AC 7): zero attempts, no
 * backoff. A ticket that has never failed carries no counter at all, so an old
 * board reads exactly as before.
 */
function defaultTicketAutopilotState() {
  return {
    version: TICKET_AUTOPILOT_VERSION,
    attempts: 0,
    lastFailureAt: 0,
    backoffUntil: 0,
    lastDispatchAt: 0,
    lastOutcome: null,
  };
}

/**
 * Repair one `ticket.autopilot` row on read (KB-75 AC 7): a hand-edited or
 * downgraded counter is never trusted. Absent stays absent (no write churn on an
 * old board); anything malformed is reset to the safe default - 0 attempts and
 * no backoff - and the caller records one normalization note. A finite counter is
 * clamped to its bound, and a backoff window longer than the hard cap is reset to
 * the safe default rather than honoured.
 */
function normalizeTicketAutopilotState(raw) {
  if (raw === undefined) return { value: null, changed: false, reasons: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      value: defaultTicketAutopilotState(),
      changed: true,
      reasons: ['ticket autopilot: expected an object, reset to the safe default (0 attempts, no backoff)'],
    };
  }
  const reasons = [];
  const out = defaultTicketAutopilotState();
  if (raw.version !== TICKET_AUTOPILOT_VERSION) {
    reasons.push(raw.version === undefined ? 'ticket autopilot.version: missing, reset to 1' : `ticket autopilot.version: ${String(raw.version)} is unknown, reset to 1`);
  }
  if (Number.isInteger(raw.attempts) && raw.attempts >= 0) {
    out.attempts = Math.min(TICKET_AUTOPILOT_FAILURES_MAX, raw.attempts);
    if (out.attempts !== raw.attempts) reasons.push(`ticket autopilot.attempts: clamped ${raw.attempts} to ${out.attempts}`);
  } else if (raw.attempts !== undefined) {
    reasons.push('ticket autopilot.attempts: expected a non-negative integer, reset to 0');
  }
  if (Number.isFinite(raw.lastFailureAt) && raw.lastFailureAt > 0) out.lastFailureAt = Math.trunc(raw.lastFailureAt);
  else if (raw.lastFailureAt !== undefined && raw.lastFailureAt !== 0) reasons.push('ticket autopilot.lastFailureAt: reset to 0');
  if (Number.isFinite(raw.lastDispatchAt) && raw.lastDispatchAt > 0) out.lastDispatchAt = Math.trunc(raw.lastDispatchAt);
  else if (raw.lastDispatchAt !== undefined && raw.lastDispatchAt !== 0) reasons.push('ticket autopilot.lastDispatchAt: reset to 0');
  // A backoff window is only meaningful relative to the failure that produced it
  // and can never exceed the hard one-hour cap. Anything else is reset (AC 7):
  // trusting a hand-edited far-future backoff would silently park a ticket.
  if (Number.isFinite(raw.backoffUntil) && raw.backoffUntil >= 0) {
    if (out.lastFailureAt > 0 && raw.backoffUntil > out.lastFailureAt + AUTOPILOT_MAX_BACKOFF_MS) {
      reasons.push('ticket autopilot.backoffUntil: beyond the one-hour cap, reset to 0');
    } else if (out.lastFailureAt === 0 && raw.backoffUntil > 0) {
      reasons.push('ticket autopilot.backoffUntil: present without a failure timestamp, reset to 0');
    } else {
      out.backoffUntil = Math.trunc(raw.backoffUntil);
    }
  } else if (raw.backoffUntil !== undefined && raw.backoffUntil !== 0) {
    reasons.push('ticket autopilot.backoffUntil: reset to 0');
  }
  // `lastOutcome: null` is the valid reset value written by
  // `resetAutopilotTicketFailure` and by a fresh ticket row (KB-75 AC 2/AC 7):
  // only a non-null value outside the closed failure set is a hand edit. Treating
  // the reset value as invalid would rewrite a freshly reset board on every load
  // and emit a spurious normalization activity.
  if (raw.lastOutcome === null || TICKET_AUTOPILOT_FAILURE_KINDS.includes(raw.lastOutcome)) {
    out.lastOutcome = raw.lastOutcome;
  } else if (raw.lastOutcome !== undefined) {
    out.lastOutcome = null;
    reasons.push('ticket autopilot.lastOutcome: unknown value, reset to null');
  }
  const allowed = new Set(['version', 'attempts', 'lastFailureAt', 'backoffUntil', 'lastDispatchAt', 'lastOutcome']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) reasons.push(`ticket autopilot: dropped unknown field ${key}`);
  }
  return { value: out, changed: reasons.length > 0, reasons };
}

function normalizePulseDecision(raw) {
  const row = {
    ticketId: typeof raw.ticketId === 'string' && raw.ticketId.trim() ? raw.ticketId.trim().slice(0, 40) : null,
    memberId: typeof raw.memberId === 'string' && raw.memberId.trim() ? raw.memberId.trim().slice(0, 80) : null,
    lane: typeof raw.lane === 'string' && raw.lane.trim() ? raw.lane.trim().slice(0, 20) : null,
    action: clampString(raw.action, 40) || 'skip',
    reason: clampString(raw.reason, 400),
  };
  // KB-72 additive dispatch fingerprint: only an implement dispatch stamps the
  // resolved role, the inference marker and the applied access mode. Absent keys
  // are dropped so a KB-69/KB-71 pulse re-reads byte-identically (the frozen
  // 5-key row is unchanged), and the key order matches what the executor stores.
  if (typeof raw.role === 'string' && raw.role.trim()) row.role = raw.role.trim().slice(0, 40);
  if (raw.roleInferred === true) row.roleInferred = true;
  if (typeof raw.accessMode === 'string' && raw.accessMode.trim()) row.accessMode = raw.accessMode.trim().slice(0, 60);
  return row;
}

function normalizePulseDispatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sessionId = clampString(raw.sessionId, 120);
  // A dispatch row without a session id never started a session; drop it.
  if (!sessionId) return null;
  return {
    ticketId: clampString(raw.ticketId, 40),
    memberId: clampString(raw.memberId, 80),
    sessionId,
  };
}

/**
 * One lane outcome row: `{ticketId, lane, sessionId, outcome, detail}`.
 * Only the closed outcome vocabulary and the lanes that may record an outcome
 * survive; a corrupt row is dropped so a hand-edited pulse can never inject an
 * unknown status into the UI/feed.
 */
function normalizePulseOutcome(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const outcome = AUTOPILOT_OUTCOME_CODES.includes(raw.outcome) ? raw.outcome : null;
  if (!outcome) return null;
  return {
    ticketId: clampString(raw.ticketId, 40),
    lane: AUTOPILOT_OUTCOME_LANES.includes(raw.lane) ? raw.lane : null,
    sessionId: clampString(raw.sessionId, 120),
    outcome,
    detail: clampString(raw.detail, 400),
  };
}

/**
 * One pulse record (AC 4): `{id, at, trigger, decisions, dispatched, error}`.
 * Entries that are not objects or lack a finite `at` are corrupt and return
 * null, so the caller drops them instead of throwing.
 */
function normalizePulse(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isFinite(raw.at)) return null;
  const trigger = AUTOPILOT_TRIGGERS.includes(raw.trigger) ? raw.trigger : 'manual';
  // KB-70/KB-71 additive pulse fields. They are optional so a pulse written by
  // KB-68 (or a hand-edited board) keeps its exact old shape. The keys are built
  // in the exact order the executor stores them, so a re-read is byte-stable and
  // never records a spurious `autopilot/pulses-normalized` note (and never bumps
  // `updatedAt` just by being looked at).
  let atIso;
  if (typeof raw.atIso === 'string' && raw.atIso.trim()) {
    atIso = clampString(raw.atIso, 40);
  } else if (Number.isFinite(raw.at) && raw.atIso !== undefined) {
    atIso = new Date(raw.at).toISOString();
  }
  const durationMs =
    Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? Math.max(0, Math.round(raw.durationMs)) : undefined;
  // KB-71: the refine-lane verification outcomes recorded on this pulse.
  const outcomes =
    Array.isArray(raw.outcomes) && raw.outcomes.length > 0
      ? raw.outcomes.map(normalizePulseOutcome).filter(Boolean).slice(0, AUTOPILOT_PULSE_OUTCOMES_MAX)
      : [];
  const pulse = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 40) : `PL-${Math.trunc(raw.at)}-${index + 1}`,
    at: raw.at,
    ...(atIso !== undefined ? { atIso } : {}),
    trigger,
    decisions: Array.isArray(raw.decisions)
      ? raw.decisions
          .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .slice(0, AUTOPILOT_PULSE_DECISIONS_MAX)
          .map(normalizePulseDecision)
      : [],
    dispatched: Array.isArray(raw.dispatched)
      ? raw.dispatched.map(normalizePulseDispatch).filter(Boolean).slice(0, AUTOPILOT_PULSE_DISPATCHES_MAX)
      : [],
    error: clampString(raw.error, 500),
    ...(outcomes.length > 0 ? { outcomes } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  return pulse;
}

/**
 * Normalize `board.pulses` into the newest-first 50-entry ring (AC 4).
 * Corrupt entries are dropped, the ring is trimmed to the newest 50, and the
 * result is canonicalized so a repaired board is byte-stable on the next read.
 */
function normalizePulses(raw) {
  if (raw === undefined) return { value: [], changed: false, dropped: 0, trimmed: 0, invalid: false };
  if (!Array.isArray(raw)) {
    return { value: [], changed: true, dropped: 0, trimmed: 0, invalid: true };
  }
  const entries = [];
  let dropped = 0;
  raw.forEach((entry, index) => {
    const pulse = normalizePulse(entry, index);
    if (pulse) entries.push(pulse);
    else dropped += 1;
  });
  entries.sort((left, right) => right.at - left.at);
  const value = entries.slice(0, AUTOPILOT_PULSE_MAX);
  const trimmed = Math.max(0, entries.length - value.length);
  const changed = dropped > 0 || trimmed > 0 || JSON.stringify(value) !== JSON.stringify(raw);
  return { value, changed, dropped, trimmed, invalid: false };
}

/** One `{ref, passed, note?}` criterion row, bounded and de-duplicated by ref. */
function normalizeReviewCriteria(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const ref = clampString(entry.ref, 20);
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const note = clampString(entry.note, REVIEW_CRITERION_NOTE_MAX);
    rows.push({ ref, passed: entry.passed === true, ...(note ? { note } : {}) });
  }
  return rows.slice(0, TICKET_REVIEW_CRITERIA_MAX);
}

/**
 * Newest-20 structured review verdicts for one ticket (KB-73 AC 1). Reads are
 * permissive so a hand-edited or pre-KB-73 board still loads: unknown fields are
 * dropped, known fields are bounded, an unknown `verdict` reads as `null` (never
 * silently promoted to an acceptance), and the list is newest-first and capped.
 * `normalizeBoard` runs this on every ticket, so an absent value reads `[]`.
 */
function normalizeReviews(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    // Every row is materialized with the full AC 1 field set (null/[] when a
    // legacy or hand-edited row lacks one) so the shape a reader sees is stable
    // across a save/reload and never depends on which optional keys were present.
    const row = {
      id: clampString(entry.id, 80) || null,
      at: Number.isFinite(entry.at) ? entry.at : 0,
      reviewerMemberId: clampString(entry.reviewerMemberId, 80) || null,
      reviewerName: clampString(entry.reviewerName, 120) || null,
      sessionId: clampString(entry.sessionId, 120) || null,
      verdict: TICKET_REVIEW_VERDICTS.includes(entry.verdict) ? entry.verdict : null,
      notes: clampString(entry.notes, REVIEW_NOTES_MAX),
      criteria: normalizeReviewCriteria(entry.criteria),
      evidence: Array.isArray(entry.evidence)
        ? entry.evidence
            .filter((value) => typeof value === 'string')
            .map((value) => clampString(value, REVIEW_EVIDENCE_MAX))
            .filter(Boolean)
            .slice(0, TICKET_REVIEW_EVIDENCE_MAX)
        : [],
    };
    rows.push(row);
  }
  rows.sort((left, right) => right.at - left.at);
  return rows.slice(0, TICKET_REVIEWS_MAX);
}

/**
 * One `## <heading>` section of a ticket description, verbatim (heading line
 * included), or null when the section is absent. Module scope so the pure review
 * postcondition can quote the same acceptance criteria the brief quotes.
 */
function descriptionSectionOf(description, pattern) {
  const lines = String(description ?? '').split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(lines[index]);
    if (!heading) continue;
    if (!pattern.test(heading[2].trim())) continue;
    start = index;
    level = heading[1].length;
    break;
  }
  if (start < 0) return null;
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+/.exec(lines[index]);
    if (heading && heading[1].length <= level) break;
    body.push(lines[index]);
  }
  const text = [lines[start], ...body].join('\n').trim();
  return text || null;
}

/**
 * Numbered acceptance criteria as `{ref, text}` rows (KB-73). The ref is the
 * literal number the ticket uses, so a reviewer's verdict maps to the ticket's
 * own numbering rather than a positional index. An absent/corrupt section is
 * empty, never invented.
 */
function acceptanceCriteriaRefs(description) {
  const section = descriptionSectionOf(description, /^acceptance criteria\b/i);
  if (!section) return [];
  const refs = [];
  const seen = new Set();
  for (const line of section.split(/\r?\n/)) {
    const match = REVIEW_AC_ITEM_PATTERN.exec(line);
    if (!match) continue;
    const ref = String(Number(match[1]));
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push({ ref, text: match[2].trim().slice(0, 300) });
  }
  return refs;
}

/** Newest structured review verdict, optionally for one reviewer session. */
function newestReviewOf(ticket, sessionId = null) {
  const rows = Array.isArray(ticket?.reviews) ? ticket.reviews : [];
  let newest = null;
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    if (sessionId && entry.sessionId !== sessionId) continue;
    if (newest === null || planNumber(entry.at, 0) > planNumber(newest.at, 0)) newest = entry;
  }
  return newest;
}

/** The review lane's sandbox decision (KB-73): test-capable, never dangerous. */
function reviewAccessSandbox() {
  return REVIEW_ACCESS_SANDBOX;
}

// ---------------------------------------------------------------------------
// KB-74 handoff context pack — review history + attempt history in every brief
// ---------------------------------------------------------------------------

/** Clip one context value, marking a cut with an ellipsis (content ≤ max chars). */
function clipContextText(value, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** ISO-8601 timestamp for a context line; a missing/zero clock reads as unknown. */
function contextIsoDate(at) {
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : 'unknown date';
}

/** One structured review verdict as a bounded block of brief lines (AC 1). */
function reviewHistoryBlock(review) {
  const verdict = TICKET_REVIEW_VERDICTS.includes(review?.verdict) ? review.verdict : 'unknown';
  const reviewer = clampString(review?.reviewerName, 120) || 'unknown reviewer';
  const lines = [`### ${verdict} · ${reviewer} · ${contextIsoDate(review?.at)}`];
  const criteria = Array.isArray(review?.criteria) ? review.criteria : [];
  if (criteria.length > 0) {
    // Every criterion is listed passed/failed, so a failed reference is never
    // hidden; individual failed notes are bounded so one row cannot fill the cap.
    lines.push(`Criteria: ${criteria.map((entry) => `${entry.ref}: ${entry.passed ? 'passed' : 'FAILED'}`).join(' · ')}`);
    const failed = criteria.filter((entry) => entry.passed !== true);
    if (failed.length > 0) {
      lines.push(`Failed criterion references: ${failed.map((entry) => entry.ref).join(', ')}`);
      const notes = failed
        .filter((entry) => entry.note)
        .slice(0, CONTEXT_CRITERION_NOTES_MAX)
        .map((entry) => `- [${entry.ref}] ${clipContextText(entry.note, CONTEXT_CRITERION_NOTE_MAX)}`);
      if (notes.length > 0) lines.push('Failed criterion notes:', ...notes);
    }
  } else {
    lines.push('Criteria: none recorded');
  }
  const evidence = Array.isArray(review?.evidence) ? review.evidence : [];
  const shownEvidence = evidence.filter((item) => typeof item === 'string' && item).slice(0, CONTEXT_EVIDENCE_ITEMS_MAX);
  if (shownEvidence.length > 0) {
    lines.push('Evidence paths:');
    lines.push(...shownEvidence.map((item) => `- ${clipContextText(item, CONTEXT_EVIDENCE_ITEM_MAX)}`));
    if (evidence.length > shownEvidence.length) {
      lines.push(`- (+${evidence.length - shownEvidence.length} more evidence item(s) on the ticket)`);
    }
  } else {
    lines.push('Evidence paths: none recorded');
  }
  if (review?.notes) {
    lines.push(
      `${verdict === 'changes-requested' ? 'Blocking notes' : 'Reviewer notes'} (clipped to ${CONTEXT_REVIEW_NOTES_MAX} chars):`,
      clipContextText(review.notes, CONTEXT_REVIEW_NOTES_MAX),
    );
  } else {
    lines.push('Blocking notes: none recorded');
  }
  return { at: planNumber(review?.at, 0), text: lines.join('\n') };
}

/**
 * The attempt-history facts for one dispatch (AC 2). `previousExecution` is the
 * execution row the caller captured BEFORE a start dispatch overwrote
 * `ticket.execution`; on a resume it is absent and the current row carries the
 * last report. Returns newest-first-ready facts plus the current review round.
 */
function attemptHistoryContext(ticket, previousExecution = null) {
  const reviews = normalizeReviews(ticket?.reviews);
  const changeRequests = reviews.filter((review) => review.verdict === 'changes-requested');
  const lastChangeRequest = changeRequests[0] ?? null;
  const execution = previousExecution && typeof previousExecution === 'object'
    ? previousExecution
    : (ticket?.execution && typeof ticket.execution === 'object' ? ticket.execution : null);
  const comments = Array.isArray(ticket?.comments) ? ticket.comments : [];
  const failureComment = comments
    .filter((comment) => typeof comment?.text === 'string' && comment.text.startsWith('[autopilot postcondition-failed]'))
    .sort((left, right) => planNumber(right?.at, 0) - planNumber(left?.at, 0))[0] ?? null;
  const blocks = [];
  const executionAt = planNumber(
    execution?.finishedAt,
    planNumber(execution?.updatedAt, planNumber(execution?.startedAt, 0)),
  );
  if (execution?.report) {
    const state = [];
    if (['done', 'failed', 'blocked', 'cancelled'].includes(execution.status)) state.push(`status ${execution.status}`);
    if (typeof execution.role === 'string' && execution.role) state.push(`role ${execution.role}`);
    if (Number.isFinite(execution.finishedAt)) state.push(`finished ${contextIsoDate(execution.finishedAt)}`);
    blocks.push({
      at: executionAt,
      text: [
        `Previous execution${state.length > 0 ? ` (${state.join(', ')})` : ''}:`,
        `Previous agent report (clipped to ${CONTEXT_REPORT_MAX} chars):`,
        clipContextText(execution.report, CONTEXT_REPORT_MAX),
      ].join('\n'),
    });
  }
  if (lastChangeRequest) {
    const failed = lastChangeRequest.criteria.filter((entry) => entry.passed !== true).map((entry) => entry.ref);
    const lines = [
      `Last change request (${contextIsoDate(lastChangeRequest.at)}${lastChangeRequest.reviewerName ? ` · ${clampString(lastChangeRequest.reviewerName, 120)}` : ''}; the full blocking notes are in the review history):`,
      clipContextText(lastChangeRequest.notes, CONTEXT_CHANGE_REQUEST_MAX),
    ];
    if (failed.length > 0) lines.push(`Failed criterion references: ${failed.join(', ')}`);
    blocks.push({ at: planNumber(lastChangeRequest.at, 0), text: lines.join('\n') });
  }
  const failureText = execution?.error
    ? clipContextText(execution.error, CONTEXT_ERROR_MAX)
    : failureComment
      ? clipContextText(failureComment.text, CONTEXT_ERROR_MAX)
      : '';
  if (failureText) {
    blocks.push({
      at: planNumber(failureComment?.at, executionAt),
      text: `Last failure / postcondition error (clipped to ${CONTEXT_ERROR_MAX} chars):\n${failureText}`,
    });
  }
  return { attempts: blocks, changeRequests: changeRequests.length, attemptNumber: 1 + changeRequests.length };
}

/** The attempt-history intro line: attempt number == current review round (AC 2). */
function attemptHistoryIntro(context) {
  return context.changeRequests > 0
    ? `Attempt ${context.attemptNumber} — current review round (${context.changeRequests} recorded changes-requested verdict(s) in this ticket's history).`
    : `Attempt ${context.attemptNumber} — current review round (the first implementation attempt).`;
}

/**
 * Compose the KB-74 handoff context pack: `## Review history` (the newest three
 * structured verdicts) and `## Attempt history`, jointly capped at
 * CONTEXT_PACK_MAX characters. When the cap is hit, the oldest block across both
 * sections is dropped first and the sections are re-rendered; a section with no
 * block left is omitted entirely (never an empty heading). Exported so the cap
 * and trimming are testable directly; every dispatch brief inlines it.
 */
export function composeHandoffContext(ticket, previousExecution = null) {
  const reviews = normalizeReviews(ticket?.reviews);
  const reviewBlocks = reviews.slice(0, CONTEXT_REVIEW_MAX).map(reviewHistoryBlock);
  const attempt = attemptHistoryContext(ticket, previousExecution);
  const shownReviews = reviewBlocks.slice();
  const shownAttempts = attempt.attempts.slice();
  const render = () => {
    const parts = [];
    if (shownReviews.length > 0) {
      parts.push([
        '## Review history',
        shownReviews.length < reviewBlocks.length
          ? `Newest ${shownReviews.length} of ${reviews.length} recorded verdict(s), newest first; older verdicts were trimmed to respect the ${CONTEXT_PACK_MAX}-character handoff-context cap.`
          : `Newest ${shownReviews.length} of ${reviews.length} recorded verdict(s), newest first.`,
        ...shownReviews.map((block) => block.text),
      ].join('\n'));
    }
    if (shownAttempts.length > 0) {
      parts.push([
        '## Attempt history',
        attemptHistoryIntro(attempt),
        ...shownAttempts.map((block) => block.text),
      ].join('\n'));
    }
    return parts.join('\n\n');
  };
  let text = render();
  while (text.length > CONTEXT_PACK_MAX && (shownReviews.length > 0 || shownAttempts.length > 0)) {
    const oldestReview = shownReviews.length > 0 ? shownReviews[shownReviews.length - 1].at : null;
    let attemptIndex = -1;
    let attemptAt = null;
    shownAttempts.forEach((block, index) => {
      if (attemptAt === null || block.at < attemptAt || (block.at === attemptAt && index > attemptIndex)) {
        attemptIndex = index;
        attemptAt = block.at;
      }
    });
    // Oldest block first; on an age tie the review block is dropped first so
    // the trim is deterministic across sections.
    if (attemptIndex < 0 || (oldestReview !== null && oldestReview <= attemptAt)) shownReviews.pop();
    else shownAttempts.splice(attemptIndex, 1);
    text = render();
  }
  // Defensive bound: the per-block limits keep even one hostile block under the
  // cap, but a hand-edited block must never push the brief past its budget.
  if (text.length > CONTEXT_PACK_MAX) text = text.slice(0, CONTEXT_PACK_MAX);
  return {
    text,
    reviews: { total: reviews.length, shown: shownReviews.length, trimmed: reviews.length - shownReviews.length },
    attempts: { total: attempt.attempts.length, shown: shownAttempts.length, trimmed: attempt.attempts.length - shownAttempts.length },
  };
}

/**
 * KB-74 AC 4: the one human-readable ticket comment a recorded verdict writes.
 * The structured verdict row is persisted separately; this comment is the
 * readable record and is deduped by its `reviewId`, never duplicated by a
 * reload or a normalization pass.
 */
function reviewVerdictCommentText(review) {
  const fallback = review?.verdict === 'accepted' ? 'every numbered criterion passed' : 'no blocking notes recorded';
  return `Review verdict: ${review?.verdict ?? 'unknown'} — ${clipContextText(review?.notes, 4000) || fallback}`;
}

// ---------------------------------------------------------------------------
// Policy helpers shared by the execution pipeline and the pure pulse planner
// ---------------------------------------------------------------------------
//
// These helpers used to live inside `apply`. The pulse planner (KB-69) is a
// module-level pure function and the ticket requires it to reuse the policy
// primitives instead of re-implementing them, so the primitives are defined once
// at module scope with unchanged semantics. The execution pipeline calls the
// same functions, so a manual dispatch and an automatic pulse can never drift.

/** The ticket an agent session currently holds in a working lane, if any. */
function activeTicketOf(board, sessionId) {
  return board.tickets.find(
    (ticket) =>
      ticket.owner?.sessionId === sessionId &&
      (ticket.column === 'in_progress' || ticket.column === 'review'),
  );
}

/** Lane routing for a dispatch, derived from the policy tables in roles.js. */
function executionRoleFor(ticket) {
  const laneRoles = LANE_CLAIM_ROLES[ticket.column] ?? LANE_CLAIM_ROLES.ready;
  if (ticket.column === 'review') return ticket.role === 'tester' ? 'tester' : 'reviewer';
  if (ticket.column === 'backlog') return 'product-manager';
  if (laneRoles.includes(ticket.role)) return ticket.role;
  const labels = Array.isArray(ticket.labels) ? ticket.labels.join(' ') : '';
  const inferred = inferRole(`${ticket.title ?? ''} ${ticket.description ?? ''} ${labels}`);
  if (laneRoles.includes(inferred)) return inferred;
  return 'fullstack-developer';
}

function executionRoleAllowed(column, role) {
  return (LANE_CLAIM_ROLES[column] ?? []).includes(role);
}

/** The role the next lane needs when a ticket is handed off (`review`/`ready`). */
function handoffRoleFor(ticket, to) {
  if (to === 'review') return ticket.role === 'tester' ? 'tester' : 'reviewer';
  if (to === 'backlog') return 'product-manager';
  if (to === 'ready') return executionRoleFor({ ...ticket, column: 'ready' });
  return null;
}

/** The working ticket a roster member is in flight for (one ticket per member). */
function memberTicket(board, member) {
  return board.tickets.find(
    (ticket) =>
      (ticket.column === 'in_progress' || ticket.column === 'review') &&
      (ticket.owner?.memberId === member.id ||
        (member.sessionId && ticket.owner?.sessionId === member.sessionId) ||
        ticket.assignment?.memberId === member.id),
  );
}

/** Roles that own the Review gate and therefore act on Review tickets. */
const REVIEW_GATE_ROLES = new Set(['reviewer', 'tester', 'tech-lead']);

/**
 * The ticket a member is actually focused on RIGHT NOW, for display only.
 * Their own In Progress work counts; a Review ticket counts only when the
 * member's role owns the review gate. An implementer's ticket parked in Review
 * has been handed off, so it is not that member's current work. `memberTicket`
 * stays the broader held-work rule used for delete/busy protection.
 */
function memberFocusTicket(board, member) {
  const ticket = memberTicket(board, member);
  if (!ticket) return null;
  if (ticket.column === 'review' && !REVIEW_GATE_ROLES.has(member.roleId)) return null;
  return ticket;
}

/** Pure WIP headroom for a target column; the throwing wrapper lives in `apply`. */
function wipState(board, wip, to) {
  const limit = wip && Number.isFinite(wip[to]) ? wip[to] : 0;
  const count = board.tickets.filter((ticket) => ticket.column === to).length;
  return { over: limit > 0 && count >= limit, limit, count };
}

// ---------------------------------------------------------------------------
// Autopilot planner (KB-69) — pure, deterministic pulse admission
// ---------------------------------------------------------------------------
//
// `planPulse(board, config, now)` is the single admission function behind the
// real pulse (KB-70), the dry-run preview (`autopilot {op:'plan'}`) and the
// invariant suite. It is pure: it reads a board value, never writes, never
// creates a session, never reads the wall clock (`now` is a parameter) and never
// consults memory-only state — budget windows, postcondition cooldown and
// loop-guard evidence are all derived from persisted board JSON, so a preview is
// exactly what an executor would use on the same board. The optional fourth
// parameter, `liveAgentStatusFor(sessionId)`, is the one caller-injected
// observation used by the KB-75 stale gate (the live agent behind an execution);
// when it is omitted the planner falls back to the persisted no-progress
// heuristic alone.
//
// The result is `{generatedAt, decisions, skips}`. `decisions` is the ordered
// list of activations the executor may dispatch; `skips` explains every
// candidate the planner refused. Every entry carries one reason code from the
// closed vocabulary below so a pulse record and the UI can explain themselves.
//
// Reason codes (KB-69 AC 3 + KB-67 §5.6):
// - the ticket AC 3 list is the closed skip vocabulary; `pulse-cap` completes it
//   because a dispatchable candidate beyond `maxDispatchesPerPulse` is deferred
//   rather than silently dropped (KB-67 §5.5.2);
// - `admitted` is the only activation code;
// - the cooldown after a failed postcondition is reported as
//   `postcondition-failed` (AC 7's "backoff-family"), and a ticket that keeps
//   failing its postcondition trips `loop-guard` at three attempts.

/** Closed skip vocabulary (AC 3). */
export const AUTOPILOT_SKIP_CODES = Object.freeze([
  'disabled',
  'board-paused',
  'epic',
  'blocked',
  'active-execution',
  'lane-cap',
  'wip-limit',
  'ready-depth',
  'no-member',
  'member-busy',
  'member-paused',
  'stale-execution',
  'postcondition-failed',
  'budget-exhausted',
  'loop-guard',
  'pulse-cap',
]);
/** Closed activation vocabulary. */
export const AUTOPILOT_ACTIVATION_CODES = Object.freeze(['admitted']);
/**
 * Every reason code the host may persist, in one closed vocabulary (KB-82 AC 1).
 *
 * The planner entries come first, unchanged: `admitted` plus the frozen 16-code
 * skip list. The tail is the executor heartbeat — `no-work` — which
 * `dispatchPlannedWork` writes directly into `board.pulses[].decisions` when a
 * pulse has nothing to say (KB-67 §4.2/§8) and which docs/AUTOPILOT.md §5.6
 * documents as a closed code. It is deliberately NOT in
 * `AUTOPILOT_SKIP_CODES`: the planner never emits it, and that list is frozen at
 * exactly 16 codes (KB-69 AC 3, docs/AUTOPILOT.md:603), so a persisted reason a
 * downstream consumer must accept widens this export only.
 */
export const AUTOPILOT_REASON_CODES = Object.freeze([
  ...AUTOPILOT_ACTIVATION_CODES,
  ...AUTOPILOT_SKIP_CODES,
  'no-work',
]);

/** Priority rank used to order candidates inside one ordering group (AC 2). */
const PLAN_PRIORITY_RANK = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });
/** Ordering groups: rework, then review, then implement, then refine (AC 2). */
const PLAN_GROUP_ORDER = Object.freeze({ rework: 0, review: 1, implement: 2, refine: 3 });
/** Lane group each ordering group is admitted into (AC 4). */
const PLAN_GROUP_LANE = Object.freeze({ rework: 'implement', review: 'review', implement: 'implement', refine: 'refine' });
/** Execution statuses that still occupy a lane / member. */
const PLAN_LIVE_EXECUTION = new Set(['running', 'idle', 'blocked', 'paused']);
/** Attempts at which the ticket is parked until a human acts (AC 7, KB-67 §6.8). */
const PLAN_LOOP_GUARD_LIMIT = AUTOPILOT_LOOP_GUARD_LIMIT;
/** Ready-lane roles an autopilot implementer may take. `tech-lead` is never an
 * autopilot candidate (KB-67 §5.1); the set is derived from the policy table so
 * a role can never be auto-dispatched into a lane it cannot claim (AC 5). */
const PLAN_IMPLEMENT_ROLES = new Set(LANE_CLAIM_ROLES.ready.filter((role) => role !== 'tech-lead'));

function planNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function planIdCompare(left, right) {
  const leftId = String(left ?? '');
  const rightId = String(right ?? '');
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

/** Effective Ready-depth ceiling (KB-68 bounds): the planner and the refine lane share one value. */
function effectiveMaxReadyDepth(autopilot) {
  return Number.isInteger(autopilot?.maxReadyDepth)
    ? autopilot.maxReadyDepth
    : AUTOPILOT_BOUNDS.maxReadyDepth.fallback;
}

/** Lane group a ticket's column belongs to (lane membership is derived). */
function planTicketLane(ticket) {
  if (ticket.column === 'backlog') return 'refine';
  if (ticket.column === 'ready' || ticket.column === 'in_progress') return 'implement';
  if (ticket.column === 'review') return 'review';
  return null;
}

/**
 * Lane group a ticket's live session occupies (KB-71). An autopilot session is
 * tied to the lane it was dispatched FROM (`execution.startColumn`), not to the
 * column the ticket happens to sit in now: a refine PM claims Backlog → Ready
 * while still working, and the refine lane must stay occupied until that session
 * ends (AC 4). Manual/older rows keep the old current-column derivation so a
 * pre-KB-71 board reads exactly as before.
 */
function planExecutionLane(ticket) {
  const execution = ticket.execution;
  if (
    execution &&
    PLAN_LIVE_EXECUTION.has(execution.status) &&
    execution.origin === 'autopilot' &&
    typeof execution.startColumn === 'string' &&
    COLUMN_INDEX[execution.startColumn] !== undefined
  ) {
    return planTicketLane({ column: execution.startColumn });
  }
  return planTicketLane(ticket);
}

/**
 * Refine postcondition (KB-71 AC 5), pure and shared by the executor and tests:
 * a refined ticket is in Ready, has a role, has a priority and its description
 * contains an acceptance-criteria section.
 */
export function evaluateRefinePostcondition(ticket) {
  if (!ticket || typeof ticket !== 'object') {
    return { ok: false, missing: ['ticket is missing'] };
  }
  const missing = [];
  if (ticket.column !== 'ready') missing.push(`expected Ready, found ${ticket.column ?? 'no column'}`);
  if (!ALL_ROLES.includes(ticket.role)) missing.push('role is not set');
  if (!['low', 'medium', 'high', 'critical'].includes(ticket.priority)) missing.push('priority is not set');
  if (!REFINE_AC_PATTERN.test(typeof ticket.description === 'string' ? ticket.description : '')) {
    missing.push('description has no "Acceptance criteria" section');
  }
  return { ok: missing.length === 0, missing };
}

/** Columns a claimed implementer may legitimately leave its ticket in (KB-72 AC 5). */
const IMPLEMENT_EXPECTED_COLUMNS = new Set(['in_progress', 'review']);

/**
 * Implement postcondition (KB-72 AC 5), pure and shared by the executor and
 * tests: the implementer pulled Ready → In Progress and, when it finished, the
 * ticket is either still claimed (In Progress) or handed to the review gate
 * (Review). A ticket left in Ready means the pull never happened.
 */
export function evaluateImplementPostcondition(ticket) {
  if (!ticket || typeof ticket !== 'object') {
    return { ok: false, missing: ['ticket is missing'] };
  }
  const column = typeof ticket.column === 'string' ? ticket.column : null;
  const missing = [];
  if (!IMPLEMENT_EXPECTED_COLUMNS.has(column)) {
    missing.push(`expected In Progress or Review, found ${column ?? 'no column'}`);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Review postcondition (KB-73 AC 4/AC 5), pure and shared by the executor, the
 * move guard and tests. The newest verdict decides:
 * - `accepted`: the ticket is Done and every numbered acceptance criterion is
 *   mapped `passed: true`; a missing mapping fails the verification (never a
 *   silent Done);
 * - `changes-requested`: the ticket is back In Progress with a non-empty blocking
 *   note, at least one `passed: false` criterion, and an implementation-role
 *   assignment for the handback;
 * - no valid verdict at all: fails, because an unverified Done is exactly the
 *   failure this lane exists to prevent.
 */
export function evaluateReviewPostcondition(ticket) {
  if (!ticket || typeof ticket !== 'object') {
    return { ok: false, verdict: null, review: null, missing: ['ticket is missing'] };
  }
  const review = newestReviewOf(ticket);
  if (!review) {
    return { ok: false, verdict: null, review: null, missing: ['no review verdict recorded'] };
  }
  const verdict = TICKET_REVIEW_VERDICTS.includes(review.verdict) ? review.verdict : null;
  if (!verdict) {
    return {
      ok: false,
      verdict: null,
      review,
      missing: [`the newest review has no valid verdict (found ${JSON.stringify(review.verdict ?? null)})`],
    };
  }
  const criteria = Array.isArray(review.criteria) ? review.criteria : [];
  const passedRefs = new Set(criteria.filter((entry) => entry?.passed === true).map((entry) => entry.ref));
  const failedCriteria = criteria.filter((entry) => entry?.passed !== true);
  const missing = [];
  if (verdict === 'accepted') {
    if (ticket.column !== 'done') missing.push(`expected Done, found ${ticket.column ?? 'no column'}`);
    const refs = acceptanceCriteriaRefs(ticket.description);
    for (const ref of refs) {
      if (!passedRefs.has(ref.ref)) missing.push(`criterion ${ref.ref} is not mapped as passed`);
    }
    if (refs.length === 0 && passedRefs.size === 0) missing.push('no acceptance criterion is mapped as passed');
  } else {
    if (ticket.column !== 'in_progress') {
      missing.push(`expected In Progress for a change request, found ${ticket.column ?? 'no column'}`);
    }
    if (typeof review.notes !== 'string' || review.notes.trim().length === 0) {
      missing.push('changes-requested has no blocking note');
    }
    if (failedCriteria.length === 0) missing.push('changes-requested has no passed:false criterion');
    const assigned = ticket.assignment && typeof ticket.assignment === 'object' ? ticket.assignment.role : null;
    if (!assigned || !PLAN_IMPLEMENT_ROLES.has(assigned)) {
      missing.push('no implementation-role assignment for the change-request handback');
    }
  }
  return { ok: missing.length === 0, verdict, review, missing };
}

/** Newest KB-73 review verdict on a ticket, or null when it has none. */
function planNewestReview(ticket) {
  return newestReviewOf(ticket);
}

/** A `changes-requested` verdict with no newer accepted verdict (AC 2a). */
function planHasUnresolvedChangeRequest(ticket) {
  const review = planNewestReview(ticket);
  if (!review) return false;
  const verdict = review.verdict ?? review.status ?? review.decision;
  return verdict === 'changes-requested';
}

/** Admission ordering group for a ticket, or null when the planner ignores it. */
function planGroupOf(ticket) {
  if (!ticket || typeof ticket !== 'object') return null;
  // An EPIC is Backlog-only by invariant; it is still enumerated so the plan can
  // report the `epic` reason instead of silently ignoring it.
  if (ticket.type === 'epic') return 'refine';
  if (ticket.column === 'backlog') return 'refine';
  if (ticket.column === 'ready') return 'implement';
  if (ticket.column === 'review') return 'review';
  if (ticket.column === 'in_progress') {
    // Only rework is picked up from In Progress. A ticket whose previous
    // dispatch failed its postcondition is parked/cooled down, not re-dispatched
    // from this column; the executor owns stale/recovery bookkeeping (§5.3).
    return planHasUnresolvedChangeRequest(ticket) ? 'rework' : null;
  }
  return null;
}

/** Candidate order (AC 2): group, priority rank, oldest movedAt, ticket id. */
function planCandidateOrder(left, right) {
  const groupDiff = PLAN_GROUP_ORDER[left.group] - PLAN_GROUP_ORDER[right.group];
  if (groupDiff !== 0) return groupDiff;
  const rankDiff =
    (PLAN_PRIORITY_RANK[left.ticket.priority] ?? 2) - (PLAN_PRIORITY_RANK[right.ticket.priority] ?? 2);
  if (rankDiff !== 0) return rankDiff;
  const movedDiff = planNumber(left.ticket.movedAt, 0) - planNumber(right.ticket.movedAt, 0);
  if (movedDiff !== 0) return movedDiff;
  const leftNumber = Number.isInteger(left.ticket.number) ? left.ticket.number : null;
  const rightNumber = Number.isInteger(right.ticket.number) ? right.ticket.number : null;
  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return planIdCompare(left.ticket.id, right.ticket.id);
}

/** Lane occupancy from persisted execution rows: one session per live ticket. */
function planLaneOccupancy(tickets) {
  const occupancy = { refine: 0, implement: 0, review: 0 };
  for (const ticket of tickets) {
    const execution = ticket.execution;
    if (!execution || typeof execution !== 'object' || !PLAN_LIVE_EXECUTION.has(execution.status)) continue;
    const lane = planExecutionLane(ticket);
    if (lane) occupancy[lane] += 1;
  }
  return occupancy;
}

/** Board WIP headroom for a target column, read from the persisted board. */
function planWipOver(wip, tickets, column) {
  const limit = wip && Number.isFinite(wip[column]) ? wip[column] : 0;
  if (limit <= 0) return false;
  return tickets.filter((ticket) => ticket.column === column).length >= limit;
}

/** True when the hourly or daily budget window has no allowance left (AC 3). */
function planBudgetExhausted(config, at) {
  for (const unit of ['hour', 'day']) {
    const window = config.budget && config.budget[unit];
    if (!window || typeof window !== 'object') continue;
    const period = unit === 'hour' ? AUTOPILOT_HOUR_MS : AUTOPILOT_DAY_MS;
    const fallback = unit === 'hour' ? AUTOPILOT_BOUNDS.budgetHour.fallback : AUTOPILOT_BOUNDS.budgetDay.fallback;
    const limit = planNumber(window.limit, fallback);
    const started = planNumber(window.windowStart, 0);
    const active = started > 0 && at >= started && at - started < period;
    const used = active ? Math.max(0, planNumber(window.used, 0)) : 0;
    if (used >= limit) return true;
  }
  return false;
}

/**
 * True when a live execution has shown no progress for longer than staleMs AND
 * its session is not runnable (KB-75 AC 3). A session whose live agent is still
 * `running` is working, however quiet its persisted row looks: it is never stale
 * and must never be cancelled. Only an absent agent or one that is no longer
 * running can be recovered.
 *
 * `liveStatus` is the observed live agent status: `null` for an absent agent, a
 * status string when the session is still registered, and `undefined` when the
 * caller cannot consult the agents service (the pure planner heuristic then
 * applies unchanged). The host always passes the real observation; the pure
 * planner receives it through its optional resolver so it stays side-effect free.
 */
function planExecutionIsStale(ticket, config, at, liveStatus) {
  const execution = ticket.execution;
  if (!execution || !['running', 'idle'].includes(execution.status)) return false;
  if (liveStatus === 'running') return false;
  let lastSignal = planNumber(execution.updatedAt, 0);
  for (const entry of Array.isArray(ticket.activity) ? ticket.activity : []) {
    lastSignal = Math.max(lastSignal, planNumber(entry?.at, 0));
  }
  const staleMs = Math.max(0, planNumber(config.staleMs, AUTOPILOT_BOUNDS.staleMs.fallback));
  return at - lastSignal > staleMs;
}

/**
 * Loop-guard attempts from persisted evidence (AC 7): autopilot postcondition /
 * stale comments newer than the ticket's last human action (a non-autopilot
 * comment or a move). `ticket.movedAt` is the persisted proxy for the move.
 */
function planAttempts(ticket) {
  const comments = Array.isArray(ticket.comments) ? ticket.comments : [];
  let humanFloor = planNumber(ticket.movedAt, 0);
  for (const comment of comments) {
    if (typeof comment?.author === 'string' && comment.author !== 'autopilot') {
      // The dispatch bookkeeping comment is authored by the session name, not by
      // a human: counting it as the latest human action would hide a same-tick
      // postcondition failure and let a failing ticket be re-dispatched inside
      // backoffMs (KB-73 AC 7). It is host text, so the prefix is stable.
      const text = typeof comment.text === 'string' ? comment.text : '';
      if (text.startsWith('Execution session started as ')) continue;
      humanFloor = Math.max(humanFloor, planNumber(comment.at, 0));
    }
  }
  let attempts = 0;
  for (const comment of comments) {
    if (comment?.author !== 'autopilot') continue;
    if (planNumber(comment.at, 0) <= humanFloor) continue;
    const text = typeof comment.text === 'string' ? comment.text : '';
    if (text.startsWith('[autopilot postcondition-failed]') || text.startsWith('[autopilot stale-execution]')) {
      attempts += 1;
    }
  }
  return attempts;
}

/** Newest persisted autopilot dispatch timestamp for a ticket, or null. */
function planLastAutopilotDispatchAt(board, ticketId) {
  let newest = null;
  for (const pulse of Array.isArray(board.pulses) ? board.pulses : []) {
    if (!pulse || typeof pulse !== 'object' || !Array.isArray(pulse.dispatched)) continue;
    if (!pulse.dispatched.some((row) => row && row.ticketId === ticketId)) continue;
    const at = Number.isFinite(pulse.at) ? pulse.at : null;
    if (at === null) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest;
}

/**
 * The ticket's persisted KB-75 safety row (failure counter + backoff), repaired
 * on read so a hand-edited value can never park a healthy ticket. Absent reads as
 * the safe default, exactly like an old board.
 */
function planTicketSafety(ticket) {
  const safety = normalizeTicketAutopilotState(ticket?.autopilot);
  return safety.value ?? defaultTicketAutopilotState();
}

/** A member is busy with a working ticket or a live linked session (AC 4/AC 6). */
function planMemberBusy(board, member) {
  const sessionId = typeof member.sessionId === 'string' && member.sessionId ? member.sessionId : null;
  for (const ticket of Array.isArray(board.tickets) ? board.tickets : []) {
    if (!ticket || typeof ticket !== 'object') continue;
    const owner = ticket.owner;
    const ownsTicket = Boolean(owner) && (
      owner.memberId === member.id ||
      (sessionId !== null && owner.sessionId === sessionId)
    );
    if (ownsTicket && (ticket.column === 'in_progress' || ticket.column === 'review')) return true;
    const execution = ticket.execution;
    if (!execution || typeof execution !== 'object' || !PLAN_LIVE_EXECUTION.has(execution.status)) continue;
    if (ownsTicket) return true;
    if (sessionId !== null && execution.sessionId === sessionId) return true;
  }
  return false;
}

/** The member/session that produced the version now sitting in Review (AC 5). */
function planIsCurrentImplementer(member, ticket) {
  const owner = ticket.owner;
  if (owner && typeof owner === 'object') {
    if (typeof owner.memberId === 'string' && owner.memberId === member.id) return true;
    if (typeof owner.sessionId === 'string' && member.sessionId === owner.sessionId) return true;
  }
  const execution = ticket.execution;
  if (execution && typeof execution.sessionId === 'string' && member.sessionId === execution.sessionId) {
    // A review-lane execution is the verifier, not the implementer. Excluding it
    // would make a reviewer who failed their own verification permanently
    // "ineligible" and could never satisfy the postcondition retry (KB-73 AC 7).
    if (execution.origin === 'autopilot' && execution.startColumn === 'review') return false;
    return true;
  }
  return false;
}

/** Deterministic fair member order: oldest lastActivatedAt, then lowest id (AC 6). */
function planMemberOrder(left, right) {
  const activation = planNumber(left.lastActivatedAt, 0) - planNumber(right.lastActivatedAt, 0);
  if (activation !== 0) return activation;
  return planIdCompare(left.id, right.id);
}

/**
 * Required role for a candidate, derived from the policy tables and never a role
 * that cannot claim the lane (AC 5). `tech-lead` is never auto-dispatched.
 *
 * Returns `{role, source}` where `source` records how the role was chosen, so
 * the executor can stamp an inferred role on the ticket and the pulse decision
 * can explain it (KB-72 AC 7):
 * - `'lane'`   — the lane table fixes the role (refine/review);
 * - `'assignment'` — an in-progress rework still carries its assignment role;
 * - `'ticket'` — the ticket names an implementation role and it is preserved;
 * - `'inferred'` — the ticket names no usable implementation role, so the role
 *   is inferred from title+description+labels (fallback fullstack-developer).
 */
function planRoleFor(group, ticket) {
  if (group === 'refine') return { role: 'product-manager', source: 'lane' };
  if (group === 'review') return { role: handoffRoleFor(ticket, 'review'), source: 'lane' };
  if (group === 'rework') {
    const assigned = ticket.assignment && typeof ticket.assignment.role === 'string' ? ticket.assignment.role : null;
    if (assigned && PLAN_IMPLEMENT_ROLES.has(assigned)) return { role: assigned, source: 'assignment' };
  }
  const preferred = typeof ticket.role === 'string' ? ticket.role : null;
  if (preferred && PLAN_IMPLEMENT_ROLES.has(preferred)) return { role: preferred, source: 'ticket' };
  const labels = Array.isArray(ticket.labels) ? ticket.labels.join(' ') : '';
  const inferred = inferRole(`${ticket.title ?? ''} ${ticket.description ?? ''} ${labels}`);
  return { role: PLAN_IMPLEMENT_ROLES.has(inferred) ? inferred : 'fullstack-developer', source: 'inferred' };
}

/**
 * The implementation role a change request is handed back to (KB-73 AC 5): the
 * ticket's own implementation role when it has one, otherwise the same inference
 * the rework planner uses. Derived from the policy table, never guessed here.
 */
function reviewHandbackRole(ticket) {
  return planRoleFor('rework', { ...ticket, assignment: null }).role;
}

/** Select one free member for a candidate (AC 6), or explain why none is free. */
function planSelectMember(board, members, role, ticket, group, chosen) {
  const eligible = members.filter((member) => member.roleId === role);
  if (eligible.length === 0) {
    return { member: null, reason: 'no-member', detail: `No roster member has the required role ${role}.` };
  }
  const unpaused = eligible.filter((member) => member.paused !== true);
  if (unpaused.length === 0) {
    return { member: null, reason: 'member-paused', detail: `Every ${role} member is paused.` };
  }
  // Separation is a property of the roster, not of availability (KB-73 AC 3):
  // when the only reviewer is the current implementer the honest reason is
  // no-member, not member-busy. Busyness is only evaluated on the separated pool.
  const separatedPool = group === 'review'
    ? unpaused.filter((member) => !planIsCurrentImplementer(member, ticket))
    : unpaused;
  if (separatedPool.length === 0) {
    return {
      member: null,
      reason: 'no-member',
      detail: `Only the member/session that implemented the current version can review ${ticket.id}; separation forbids it.`,
    };
  }
  const available = separatedPool.filter((member) => !chosen.has(member.id) && !planMemberBusy(board, member));
  if (available.length === 0) {
    return { member: null, reason: 'member-busy', detail: `Every free ${role} member already holds an in-flight ticket or session.` };
  }
  return { member: [...available].sort(planMemberOrder)[0], reason: null, detail: '' };
}

/** Columns in which a dispatched session counts as having reached its outcome. */
function planExpectedColumns(group) {
  if (group === 'refine') return ['ready'];
  if (group === 'review') return ['done', 'in_progress'];
  return ['review'];
}

function planDecisionDetail(group, ticket, role, member) {
  const verb = group === 'rework' ? 'Rework' : group === 'review' ? 'Review' : group === 'refine' ? 'Refine' : 'Implement';
  const who = typeof member.name === 'string' && member.name ? member.name : member.id;
  return `${verb} ${ticket.id} from ${ticket.column}: ${role} -> ${who}`.slice(0, 240);
}

/**
 * Plan one pulse. Pure: the same `(board, config, now, liveAgentStatusFor)`
 * always produces a deep-equal plan, the input values are never mutated, and no
 * storage or session call originates here (KB-69 AC 1/AC 2/AC 8). The optional
 * `liveAgentStatusFor(sessionId)` resolver is the caller's observation of the
 * live agent behind an execution; it is only read, never written.
 */
export function planPulse(board, config, now, liveAgentStatusFor) {
  const at = Number.isFinite(now) ? now : 0;
  const source = board && typeof board === 'object' && !Array.isArray(board) ? board : {};
  const decisions = [];
  const skips = [];
  const plan = { generatedAt: at, decisions, skips };
  const liveStatusFor = typeof liveAgentStatusFor === 'function' ? liveAgentStatusFor : null;
  const boardSkip = (reason, detail) => {
    skips.push({ action: 'skip', reason, group: null, lane: null, ticketId: null, memberId: null, detail });
  };
  const tickets = Array.isArray(source.tickets)
    ? source.tickets.filter((ticket) => ticket && typeof ticket === 'object')
    : [];
  const members = source.team && Array.isArray(source.team.members)
    ? source.team.members.filter((member) => member && typeof member === 'object')
    : [];
  const effective = normalizeAutopilotState(config === undefined ? source.autopilot : config).value;

  // Board gates, in KB-67 §5.5 order: disabled -> paused -> budget. Each one
  // terminates the plan with one board-level skip and no dispatch.
  if (effective.enabled !== true) {
    boardSkip('disabled', 'Autopilot is disabled; enable it before a pulse can dispatch work.');
    return plan;
  }
  if (source.paused === true) {
    boardSkip('board-paused', 'The board is paused; no dispatch until it is resumed.');
    return plan;
  }
  if (planBudgetExhausted(effective, at)) {
    boardSkip('budget-exhausted', 'The hourly or daily autopilot dispatch budget is used up.');
    return plan;
  }

  const occupancy = planLaneOccupancy(tickets);
  const wip = source.wip && typeof source.wip === 'object' ? source.wip : {};
  const readyCount = tickets.filter((ticket) => ticket.column === 'ready').length;
  const maxReadyDepth = effectiveMaxReadyDepth(effective);
  const maxDispatches = Number.isInteger(effective.maxDispatchesPerPulse)
    ? effective.maxDispatchesPerPulse
    : AUTOPILOT_BOUNDS.maxDispatchesPerPulse.fallback;
  const backoffMs = planNumber(effective.backoffMs, AUTOPILOT_BOUNDS.backoffMs.fallback);

  const candidates = [];
  for (const ticket of tickets) {
    const group = planGroupOf(ticket);
    if (!group) continue;
    candidates.push({ ticket, group, lane: PLAN_GROUP_LANE[group] });
  }
  candidates.sort(planCandidateOrder);

  const chosenMembers = new Set();
  const laneDecisions = { refine: 0, implement: 0, review: 0 };
  for (const candidate of candidates) {
    const { ticket, group, lane } = candidate;
    const ticketId = typeof ticket.id === 'string' ? ticket.id : null;
    const skip = (reason, detail, memberId = null) => {
      skips.push({ action: 'skip', reason, group, lane, ticketId, memberId, detail });
    };
    const execution = ticket.execution && typeof ticket.execution === 'object' ? ticket.execution : null;
    const liveExecution = Boolean(execution) && PLAN_LIVE_EXECUTION.has(execution.status);

    // 1. Lane gates (KB-67 §5.5.4): phase-1 serialization is one admission per
    // lane group per pulse, bounded further by the configured cap and occupancy.
    // The candidate's own live execution is not "another session" occupying the
    // lane: it is why the ticket is skipped, and the execution gate below gives
    // the precise `active-execution`/`stale-execution` reason instead.
    const cap = Number.isInteger(effective.laneCaps?.[lane]) ? effective.laneCaps[lane] : 1;
    if (cap <= 0) {
      skip('lane-cap', `Lane ${lane} is disabled (laneCaps.${lane} = 0).`);
      continue;
    }
    const selfOccupancy = liveExecution && planExecutionLane(ticket) === lane ? 1 : 0;
    const otherOccupancy = occupancy[lane] - selfOccupancy;
    if (otherOccupancy >= cap) {
      skip('lane-cap', `Lane ${lane} already has ${otherOccupancy} running session(s) at cap ${cap}.`);
      continue;
    }
    if (laneDecisions[lane] >= 1) {
      skip('lane-cap', `Lane ${lane} already has a decision in this pulse (phase-1 cap 1).`);
      continue;
    }
    if (group === 'implement' && planWipOver(wip, tickets, 'in_progress')) {
      skip('wip-limit', 'In Progress is at its board WIP limit; the pull would exceed it.');
      continue;
    }
    if (group === 'refine' && readyCount >= maxReadyDepth) {
      skip('ready-depth', `Ready depth ${readyCount} is at the ceiling ${maxReadyDepth}; refine stands down.`);
      continue;
    }

    // 2. Pause precedence (§5.5.8): a paused owning member wins over any
    // staleness/execution reason. Ownership is matched by roster id or by the
    // linked session id, since an execution row persists the session link.
    const ownerMemberId = ticket.owner && typeof ticket.owner.memberId === 'string' ? ticket.owner.memberId : null;
    const ownerSessionId = ticket.owner && typeof ticket.owner.sessionId === 'string' ? ticket.owner.sessionId : null;
    const ownerMember = members.find(
      (member) =>
        (ownerMemberId !== null && member.id === ownerMemberId) ||
        (ownerSessionId !== null && member.sessionId === ownerSessionId),
    ) ?? null;
    if (ownerMember && ownerMember.paused === true) {
      skip('member-paused', `Owning member ${ownerMember.name ?? ownerMember.id} is paused.`);
      continue;
    }

    // 3. Structural ticket gates: an EPIC is never dispatched and a blocked
    // ticket always waits for its human answer.
    if (ticket.type === 'epic') {
      skip('epic', 'An EPIC is a structural parent and is never dispatched.');
      continue;
    }
    if (ticket.blocked === true) {
      skip('blocked', 'The ticket is waiting for a user answer or decision.');
      continue;
    }

    // 4. Loop guard and the per-ticket failure backoff. The persisted KB-75
    // safety row is the primary evidence; the KB-71/72/73 comment history and the
    // pulse ring stay as the legacy fallback so a board written before this
    // feature still cools down and parks. The two sources are combined with
    // `max`, never summed, so the same failure is never counted twice (AC 2/AC 4).
    const safety = planTicketSafety(ticket);
    const attempts = Math.max(safety.attempts, planAttempts(ticket));
    if (attempts >= PLAN_LOOP_GUARD_LIMIT) {
      skip('loop-guard', `${attempts} consecutive autopilot failures since the last human action; the ticket is parked until a human moves it, unblocks it, or records a verdict.`);
      continue;
    }
    // Exponential ticket backoff: doubles per consecutive failure, capped at one
    // hour. The persisted `backoffUntil` wins; the legacy derivation below keeps
    // an older board (failure comments + dispatch pulses, no safety row) honest.
    const ticketBackoffMs = Math.min(backoffMs * 2 ** Math.max(0, attempts - 1), AUTOPILOT_MAX_BACKOFF_MS);
    if (safety.backoffUntil > at) {
      skip('postcondition-failed', `The ticket's last autopilot attempt failed (${safety.lastOutcome ?? 'unknown'}); waiting out the persisted backoff of ${safety.backoffUntil - at}ms (attempt ${safety.attempts}, cap ${AUTOPILOT_MAX_BACKOFF_MS}ms).`);
      continue;
    }
    const lastDispatchAt = planLastAutopilotDispatchAt(source, ticket.id);
    if (lastDispatchAt !== null && attempts > 0 && at - lastDispatchAt < ticketBackoffMs) {
      skip('postcondition-failed', `Last autopilot dispatch failed its postcondition ${Math.max(0, at - lastDispatchAt)}ms ago; waiting out the ${ticketBackoffMs}ms backoff for attempt ${attempts}.`);
      continue;
    }

    // 5. Live execution gate. A stale execution is the executor's to recover and
    // does not admit a second session; a healthy one is simply occupied. AC 3: the
    // live agent is consulted, so a session whose agent is still running is never
    // reported stale even when its persisted row has been silent past staleMs.
    if (liveExecution) {
      let liveStatus;
      try {
        liveStatus = liveStatusFor ? liveStatusFor(execution.sessionId) : undefined;
      } catch {
        liveStatus = undefined;
      }
      if (planExecutionIsStale(ticket, effective, at, liveStatus)) {
        skip('stale-execution', `Execution ${execution.sessionId ?? '(unknown)'} has shown no progress for over staleMs ${effective.staleMs} and its live agent is not running.`);
      } else {
        skip('active-execution', `Execution ${execution.sessionId ?? '(unknown)'} is ${execution.status}; phase 1 never starts a second session.`);
      }
      continue;
    }

    // 6. Member gate: free, non-paused member of the required role, chosen by
    // least-recently-activated then lowest id (AC 6); no role-only fallback.
    const routing = planRoleFor(group, ticket);
    const role = routing.role;
    const selection = planSelectMember(source, members, role, ticket, group, chosenMembers);
    if (!selection.member) {
      skip(selection.reason, selection.detail);
      continue;
    }
    const member = selection.member;

    // 7. Pulse pacing: a dispatchable candidate beyond the pulse cap is
    // deferred to a later pulse and says so (KB-67 §5.5.2).
    if (decisions.length >= maxDispatches) {
      skip('pulse-cap', `Pulse already has ${decisions.length} dispatch decision(s) at maxDispatchesPerPulse ${maxDispatches}.`);
      continue;
    }

    // 8. Admit. The planner never creates the session and never moves a ticket:
    // KB-70 consumes this decision. For rework it must first move the ticket one
    // legal backward step (in_progress -> ready) and then start from Ready,
    // because `startTicketExecution` rejects In Progress by design.
    const mode = group === 'rework' ? 'handoff' : 'start';
    decisions.push({
      order: decisions.length + 1,
      action: 'dispatch',
      reason: 'admitted',
      group,
      lane,
      ticketId,
      ticketColumn: ticket.column,
      role,
      memberId: member.id,
      memberName: typeof member.name === 'string' && member.name ? member.name : member.id,
      // KB-72 AC 7: the executor stamps an inferred role on the ticket; the pulse
      // records where the role came from so the decision is auditable instead of
      // implied. Additive and absent for refine/review, whose role is fixed by
      // the lane table. `roleSource` is on the plan only (the persisted row keeps
      // the narrower `roleInferred` marker).
      ...(group === 'implement' || group === 'rework' ? { roleSource: routing.source, roleInferred: routing.source === 'inferred' } : {}),
      mode,
      handoffTo: mode === 'handoff' ? 'ready' : null,
      expectedColumns: planExpectedColumns(group),
      detail: planDecisionDetail(group, ticket, role, member),
    });
    chosenMembers.add(member.id);
    laneDecisions[lane] += 1;
  }
  return plan;
}

function newBoard(project, wip) {
  const at = now();
  const board = {
    version: VERSION,
    workspaceId: project.id,
    projectTitle: project.title,
    projectPath: project.path,
    createdAt: at,
    updatedAt: at,
    paused: false,
    pausedAt: null,
    pausedBy: null,
    wip: { ...wip },
    nextNumber: 1,
    tickets: [],
    activity: [],
    agents: {},
    team: emptyTeam(),
    // KB-68 additive keys: the synthesized autopilot envelope and the empty
    // pulse ring. Old readers ignore both; board `version` stays 3.
    autopilot: defaultAutopilot(),
    pulses: [],
    meta: {
      vision: null,
      docs: [],
      conversations: [],
      mrs: [],
      lastScanAt: null,
    },
  };
  seedTeam(board);
  return board;
}

/**
 * Append a board activity note produced by normalization. Used when an invariant
 * repair (dropped parent link, EPIC returned to Backlog) is persisted on read.
 */
function recordNormalizationNote(board, ticketId, kind, text) {
  board.activity.unshift({
    id: uid(),
    at: now(),
    by: 'system',
    kind,
    ...(ticketId ? { ticketId } : {}),
    text: clampString(text, 600),
  });
  board.activity = board.activity.slice(0, 200);
}

/**
 * Enforce the v3 EPIC invariants on read, so no path can leave a dangling
 * `parentId` behind and an EPIC can never sit outside Backlog:
 * - an EPIC never carries a parent;
 * - a `parentId` must reference an EPIC ticket in the same board (missing,
 *   non-EPIC and self links are dropped and noted);
 * - an EPIC is pinned to Backlog.
 * Returns true when the board changed and must be rewritten.
 */
function repairEpicInvariants(board) {
  let changed = false;
  for (const ticket of board.tickets) {
    if (ticket.type === 'epic' && ticket.parentId) {
      delete ticket.parentId;
      recordNormalizationNote(
        board,
        ticket.id,
        'ticket/parent-dropped',
        `${ticket.id}: parent link dropped because an EPIC cannot have a parent`,
      );
      changed = true;
    }
  }
  const byId = new Map(board.tickets.map((ticket) => [ticket.id, ticket]));
  for (const ticket of board.tickets) {
    if (!ticket.parentId) continue;
    const parent = byId.get(ticket.parentId);
    const reason =
      parent === undefined
        ? `parent ${ticket.parentId} is missing`
        : parent.id === ticket.id
          ? 'a ticket cannot be its own parent'
          : parent.type !== 'epic'
            ? `parent ${ticket.parentId} is not an EPIC`
            : '';
    if (!reason) continue;
    delete ticket.parentId;
    recordNormalizationNote(board, ticket.id, 'ticket/parent-dropped', `${ticket.id}: parent link dropped (${reason})`);
    changed = true;
  }
  for (const ticket of board.tickets) {
    if (ticket.type !== 'epic' || ticket.column === 'backlog') continue;
    const from = ticket.column;
    ticket.column = 'backlog';
    ticket.movedAt = now();
    ticket.updatedAt = now();
    recordNormalizationNote(board, ticket.id, 'ticket/epic-pinned', `${ticket.id}: EPIC returned to Backlog from ${from}`);
    changed = true;
  }
  return changed;
}

/**
 * Normalize and (when needed) migrate a persisted board. Version 1, 2 and 3
 * boards are migrated in place: every ticket, checklist, comment, activity
 * entry, agent record, meta field, WIP setting, pause flag and nextNumber
 * survives; v1/v2 boards are rewritten to disk as v3 immediately.
 */
function normalizeBoard(raw, project, wip) {
  if (!raw || typeof raw !== 'object') return newBoard(project, wip);
  const sourceVersion = Number.isFinite(raw.version) ? raw.version : 0;
  // v1 → v2 (team roster) → v3 (EPIC model); any other version starts fresh.
  if (![1, 2, 3].includes(sourceVersion)) return newBoard(project, wip);
  const migrated = sourceVersion !== VERSION || !raw.team;
  const board = raw;
  board.version = VERSION;
  board.workspaceId = project.id;
  board.projectTitle = project.title;
  board.projectPath = project.path;
  board.createdAt = Number.isFinite(board.createdAt) ? board.createdAt : now();
  board.updatedAt = Number.isFinite(board.updatedAt) ? board.updatedAt : now();
  board.paused = board.paused === true;
  board.pausedAt = Number.isFinite(board.pausedAt) ? board.pausedAt : null;
  board.pausedBy = typeof board.pausedBy === 'string' ? board.pausedBy : null;
  board.wip = { ...wip, ...(board.wip && typeof board.wip === 'object' ? board.wip : {}) };
  const rawTicketRows = Array.isArray(board.tickets) ? board.tickets : [];
  board.tickets = rawTicketRows.map(normalizeTicket);
  // KB-75 AC 7: repair each ticket's additive safety row on read. An absent row
  // stays absent (no write churn); a malformed or hand-edited one is reset to the
  // safe default and reported as one board normalization note.
  let repairedTicketSafety = 0;
  for (let index = 0; index < board.tickets.length; index += 1) {
    const safety = normalizeTicketAutopilotState(rawTicketRows[index]?.autopilot);
    if (safety.value === null) continue;
    board.tickets[index].autopilot = safety.value;
    if (safety.changed) repairedTicketSafety += 1;
  }
  board.activity = Array.isArray(board.activity) ? board.activity.slice(0, 200) : [];
  // Never let a migrated board reuse an existing ticket number: nextNumber keeps
  // its stored value unless it would collide with an already persisted ticket.
  const highestNumber = board.tickets.reduce(
    (highest, ticket) => (Number.isInteger(ticket.number) && ticket.number > highest ? ticket.number : highest),
    0,
  );
  const floor = highestNumber + 1;
  board.nextNumber =
    Number.isInteger(board.nextNumber) && board.nextNumber > 0 ? Math.max(board.nextNumber, floor) : floor;
  board.agents = board.agents && typeof board.agents === 'object' ? board.agents : {};
  board.team = normalizeTeam(board.team);
  // KB-68 additive schema: repaired or synthesized in memory on every read.
  // An absent subtree never forces a write (a load does not churn the file), but
  // a present-and-invalid one is repaired and persisted with one normalization
  // note, exactly like the EPIC invariant repairs above (AC 3).
  const autopilot = normalizeAutopilotState(raw.autopilot);
  board.autopilot = autopilot.value;
  const pulses = normalizePulses(raw.pulses);
  board.pulses = pulses.value;
  if (autopilot.changed) {
    board[MIGRATED] = true;
    recordNormalizationNote(
      board,
      null,
      autopilot.kind,
      `autopilot: config normalized (${autopilot.reasons.slice(0, 6).join('; ')})`,
    );
  }
  if (pulses.changed) {
    board[MIGRATED] = true;
    const detail = pulses.invalid
      ? 'corrupt pulse history replaced with an empty ring'
      : `pulse history normalized (${pulses.dropped} corrupt dropped, ${pulses.trimmed} over the 50-entry cap trimmed)`;
    recordNormalizationNote(board, null, 'autopilot/pulses-normalized', `autopilot: ${detail}`);
  }
  if (repairedTicketSafety > 0) {
    board[MIGRATED] = true;
    recordNormalizationNote(
      board,
      null,
      'autopilot/ticket-state-normalized',
      `autopilot: repaired the per-ticket failure/backoff state on ${repairedTicketSafety} ticket(s) to safe values`,
    );
  }
  board.meta = {
    vision: typeof board.meta?.vision === 'string' ? board.meta.vision : null,
    docs: Array.isArray(board.meta?.docs) ? board.meta.docs : [],
    conversations: Array.isArray(board.meta?.conversations) ? board.meta.conversations : [],
    mrs: Array.isArray(board.meta?.mrs) ? board.meta.mrs : [],
    lastScanAt: Number.isFinite(board.meta?.lastScanAt) ? board.meta.lastScanAt : null,
  };
  // Any of these means the normalized board differs from what is on disk.
  if (migrated) board[MIGRATED] = true;
  if (seedTeam(board)) board[MIGRATED] = true;
  if (reconcileDrafts(board).length > 0) board[MIGRATED] = true;
  if (repairEpicInvariants(board)) board[MIGRATED] = true;
  return board;
}

function normalizeExecution(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.sessionId !== 'string') return null;
  const status = EXECUTION_STATUSES.includes(raw.status) ? raw.status : 'idle';
  const questions = Array.isArray(raw.blocked?.questions)
    ? raw.blocked.questions
        .map((question) => (typeof question === 'string' ? { text: question } : question))
        .filter((question) => question && typeof question.text === 'string')
        .slice(0, 20)
        .map((question) => ({
          id: typeof question.id === 'string' ? question.id : uid(),
          text: question.text.slice(0, 800),
          answer: typeof question.answer === 'string' ? question.answer.slice(0, 4000) : '',
        }))
    : [];
  const needs = Array.isArray(raw.blocked?.needs)
    ? raw.blocked.needs
        .filter((need) => need && typeof need.text === 'string')
        .slice(0, 20)
        .map((need) => ({
          id: typeof need.id === 'string' ? need.id : uid(),
          kind: ['question', 'permission', 'decision', 'input'].includes(need.kind) ? need.kind : 'input',
          text: need.text.slice(0, 1000),
          status: ['pending', 'granted', 'denied'].includes(need.status) ? need.status : 'pending',
        }))
    : [];
  return {
    sessionId: raw.sessionId,
    status,
    role: ALL_ROLES.includes(raw.role) ? raw.role : null,
    accessMode: typeof raw.accessMode === 'string' ? raw.accessMode : null,
    startColumn: COLUMN_IDS.includes(raw.startColumn) ? raw.startColumn : 'backlog',
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now(),
    finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : null,
    report: typeof raw.report === 'string' ? raw.report.slice(0, 6000) : '',
    error: typeof raw.error === 'string' ? raw.error.slice(0, 2000) : '',
    // KB-71 additive fields: `origin` marks an autopilot-dispatched session (so
    // the refine lane can tell its own sessions apart without guessing), and
    // `postcondition` is the once-per-state-change verification marker. Both are
    // absent on older rows, which therefore read exactly as before.
    ...(raw.origin === 'autopilot' ? { origin: 'autopilot' } : {}),
    ...(raw.postcondition && typeof raw.postcondition === 'object' &&
    AUTOPILOT_OUTCOME_CODES.includes(raw.postcondition.outcome)
      ? {
          postcondition: {
            at: Number.isFinite(raw.postcondition.at) ? raw.postcondition.at : 0,
            outcome: raw.postcondition.outcome,
          },
        }
      : {}),
    // KB-75 additive field: the stale-execution marker. It is the persisted "this
    // session was already recovered once" evidence, so a host restart cannot make
    // the watchdog cancel and re-count the same staling event. Absent on every row
    // written before the watchdog existed, which reads exactly as before.
    ...(raw.stale && typeof raw.stale === 'object' && typeof raw.stale.sessionId === 'string'
      ? {
          stale: {
            at: Number.isFinite(raw.stale.at) ? raw.stale.at : 0,
            sessionId: raw.stale.sessionId.slice(0, 120),
            reason: clampString(raw.stale.reason, TICKET_AUTOPILOT_STALE_TEXT_MAX),
            lastSignalAt: Number.isFinite(raw.stale.lastSignalAt) ? raw.stale.lastSignalAt : 0,
          },
        }
      : {}),
    blocked: questions.length > 0 || needs.length > 0 || typeof raw.blocked?.reason === 'string'
      ? {
          reason: typeof raw.blocked?.reason === 'string' ? raw.blocked.reason.slice(0, 1000) : '',
          questions,
          needs,
          askedAt: Number.isFinite(raw.blocked?.askedAt) ? raw.blocked.askedAt : now(),
        }
      : null,
  };
}

function normalizeAssignment(raw) {
  if (!raw || typeof raw !== 'object' || !ALL_ROLES.includes(raw.role)) return null;
  return {
    role: raw.role,
    accessMode: typeof raw.accessMode === 'string' ? raw.accessMode : null,
    agentSessionId: typeof raw.agentSessionId === 'string' ? raw.agentSessionId : null,
    agentName: typeof raw.agentName === 'string' ? raw.agentName.slice(0, 120) : null,
    memberId: typeof raw.memberId === 'string' ? raw.memberId.slice(0, 80) : null,
    auto: raw.auto === true,
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 400) : '',
    at: Number.isFinite(raw.at) ? raw.at : now(),
  };
}

function normalizeBlock(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const questions = Array.isArray(raw.questions)
    ? raw.questions
        .map((question) => (typeof question === 'string' ? { text: question } : question))
        .filter((question) => question && typeof question.text === 'string')
        .slice(0, 20)
        .map((question) => ({ id: typeof question.id === 'string' ? question.id : uid(), text: question.text.slice(0, 800) }))
    : [];
  const needs = Array.isArray(raw.needs)
    ? raw.needs
        .filter((need) => need && typeof need.text === 'string')
        .slice(0, 20)
        .map((need) => ({
          id: typeof need.id === 'string' ? need.id : uid(),
          kind: ['question', 'permission', 'decision', 'input'].includes(need.kind) ? need.kind : 'input',
          text: need.text.slice(0, 1000),
          status: ['pending', 'granted', 'denied'].includes(need.status) ? need.status : 'pending',
        }))
    : [];
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 1000) : '';
  if (questions.length === 0 && needs.length === 0 && !reason) return null;
  return { reason, questions, needs, askedAt: Number.isFinite(raw.askedAt) ? raw.askedAt : now() };
}

/**
 * Ticket comments, bounded and stable across a save/reload. KB-74 AC 4 adds one
 * optional additive field: `reviewId`, the verdict a "Review verdict: …" comment
 * was written for. At most one comment may carry a given verdict id, so a
 * normalized or reloaded board can never show the verdict comment twice. Comments
 * without a `reviewId` are untouched (free-text remains the human record).
 */
function normalizeTicketComments(raw) {
  if (!Array.isArray(raw)) return [];
  const rows = [];
  const seenVerdicts = new Set();
  for (const comment of raw) {
    if (!comment || typeof comment.text !== 'string') continue;
    const reviewId = clampString(comment.reviewId, 80) || null;
    if (reviewId) {
      if (seenVerdicts.has(reviewId)) continue;
      seenVerdicts.add(reviewId);
    }
    rows.push({
      id: typeof comment.id === 'string' ? comment.id : uid(),
      author: clampString(comment.author, 120) || 'agent',
      text: comment.text.slice(0, 4000),
      at: Number.isFinite(comment.at) ? comment.at : now(),
      ...(reviewId ? { reviewId } : {}),
    });
  }
  return rows.slice(-100);
}

function normalizeTicket(raw) {
  const at = Number.isFinite(raw?.createdAt) ? raw.createdAt : now();
  return {
    id: typeof raw?.id === 'string' ? raw.id : `KB-${uid().slice(0, 4)}`,
    number: Number.isInteger(raw?.number) ? raw.number : 0,
    title: clampString(raw?.title, 300) || 'Untitled ticket',
    description: typeof raw?.description === 'string' ? raw.description.slice(0, 20000) : '',
    type: TICKET_TYPES.includes(raw?.type) ? raw.type : 'task',
    priority: ['low', 'medium', 'high', 'critical'].includes(raw?.priority) ? raw.priority : 'medium',
    column: COLUMN_IDS.includes(raw?.column) ? raw.column : 'backlog',
    role: ALL_ROLES.includes(raw?.role) ? raw.role : null,
    labels: Array.isArray(raw?.labels) ? raw.labels.filter((label) => typeof label === 'string').slice(0, 12) : [],
    // Additive KB-1 field: present only on tickets a thought dispatch created.
    ...(typeof raw?.thoughtId === 'string' && raw.thoughtId ? { thoughtId: raw.thoughtId.slice(0, 40) } : {}),
    // Additive KB-3 field: present only on a child ticket linked to an EPIC.
    // Dangling/non-EPIC links are dropped by repairEpicInvariants on the board.
    ...(typeof raw?.parentId === 'string' && raw.parentId.trim() ? { parentId: raw.parentId.trim().slice(0, 40) } : {}),
    owner: raw?.owner && typeof raw.owner === 'object' && typeof raw.owner.sessionId === 'string'
      ? {
          sessionId: raw.owner.sessionId,
          name: clampString(raw.owner.name, 120) || 'agent',
          role: ALL_ROLES.includes(raw.owner.role) ? raw.owner.role : null,
          memberId: typeof raw.owner.memberId === 'string' ? raw.owner.memberId.slice(0, 80) : null,
        }
      : null,
    blocked: raw?.blocked === true,
    blockReason: typeof raw?.blockReason === 'string' ? raw.blockReason.slice(0, 1000) : '',
    block: normalizeBlock(raw?.block),
    execution: normalizeExecution(raw?.execution),
    assignment: normalizeAssignment(raw?.assignment),
    checklist: Array.isArray(raw?.checklist)
      ? raw.checklist
          .filter((item) => item && typeof item.text === 'string')
          .slice(0, 40)
          .map((item) => ({
            id: typeof item.id === 'string' ? item.id : uid(),
            text: item.text.slice(0, 300),
            done: item.done === true,
          }))
      : [],
    comments: normalizeTicketComments(raw?.comments),
    // KB-68 additive read model: the newest 20 review verdicts. Always an array
    // (empty for every ticket written before review verdicts existed) so the UI
    // never has to guard for `undefined`.
    reviews: normalizeReviews(raw?.reviews),
    source: raw?.source && typeof raw.source === 'object' && typeof raw.source.kind === 'string'
      ? {
          kind: raw.source.kind,
          ref: clampString(raw.source.ref, 500),
          ...(typeof raw.source.title === 'string' ? { title: raw.source.title.slice(0, 300) } : {}),
          ...(typeof raw.source.url === 'string' ? { url: raw.source.url.slice(0, 1000) } : {}),
        }
      : null,
    createdAt: at,
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : at,
    movedAt: Number.isFinite(raw?.movedAt) ? raw.movedAt : at,
    acceptedAt: Number.isFinite(raw?.acceptedAt) ? raw.acceptedAt : null,
    activity: Array.isArray(raw?.activity)
      ? raw.activity.slice(0, 60).map((entry) => ({
          id: typeof entry?.id === 'string' ? entry.id : uid(),
          at: Number.isFinite(entry?.at) ? entry.at : at,
          by: clampString(entry?.by, 120) || 'system',
          action: clampString(entry?.action, 60) || 'update',
          text: clampString(entry?.text, 800),
        }))
      : [],
  };
}

/**
 * Validate an optional additive parent link. Returns the parent ticket id, or
 * null when the input is absent. A parent must be an existing EPIC in the same
 * board; an EPIC may never itself have a parent.
 */
function resolveParentId(board, value, { type = null, ticketId = null } = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parentId = value.trim();
  if (parentId.length > 40) throw parentInvalid('A parent ticket id is at most 40 characters.');
  if (ticketId && parentId === ticketId) throw parentInvalid('A ticket cannot be its own parent.');
  if (type === 'epic') throw parentInvalid('An EPIC cannot have a parent; only non-EPIC tickets link to an EPIC.');
  const parent = board.tickets.find((ticket) => ticket.id === parentId);
  if (!parent) throw parentInvalid(`Unknown parent ticket: ${parentId}.`);
  if (parent.type !== 'epic') throw parentInvalid(`${parentId} is not an EPIC; only an EPIC can be a parent.`);
  return parent.id;
}

/** Per-workspace JSON board store: single writer, atomic replace, in-memory cache. */
class BoardStore {
  constructor(dir, wip, clock) {
    this.dir = dir;
    this.wip = wip;
    // The board's `updatedAt` is stamped from the host clock. Using the injected
    // clock here (rather than Date.now) keeps the persisted timestamp and the
    // autopilot cadence on the same timeline, including in fake-clock tests.
    this.clock = typeof clock === 'function' ? clock : now;
    this.cache = new Map();
    this.pending = new Map();
    this.errors = new Map();
    this.persisted = new Set();
  }

  file(workspaceId) {
    return join(this.dir, `${safeFileName(workspaceId)}.json`);
  }

  async peek(project) {
    if (this.cache.has(project.id)) return this.cache.get(project.id);
    let raw = null;
    try {
      raw = JSON.parse(await readFile(this.file(project.id), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.errors.set(project.id, error instanceof Error ? error.message : String(error));
        try {
          await rename(this.file(project.id), `${this.file(project.id)}.corrupt-${now()}`);
        } catch {
          // best effort: a corrupt board is replaced, never fatal
        }
      }
    }
    const board = normalizeBoard(raw, project, this.wip);
    if (raw) {
      this.persisted.add(project.id);
      // A migrated/seeded board must land on disk immediately; otherwise the
      // next start would migrate it again from the stale version.
      if (board[MIGRATED] === true) await this.save(board);
    }
    this.cache.set(project.id, board);
    return board;
  }

  async ensure(project) {
    const board = await this.peek(project);
    if (!this.persisted.has(project.id)) {
      await this.save(board);
      this.persisted.add(project.id);
    }
    return board;
  }

  /**
   * Read-only inspection for the autopilot startup sweep: normalize an existing
   * board file WITHOUT populating the cache, so a later real load still reads the
   * file (a test or a teammate may write it after `apply`) and an untouched
   * project never gets a board file created for it.
   */
  async inspect(project) {
    let raw;
    try {
      raw = JSON.parse(await readFile(this.file(project.id), 'utf8'));
    } catch {
      return null;
    }
    return normalizeBoard(raw, project, this.wip);
  }

  async save(board) {
    board.updatedAt = this.clock();
    const workspaceId = board.workspaceId;
    const previous = this.pending.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const target = this.file(workspaceId);
        const temp = `${target}.tmp-${process.pid}-${this.clock()}`;
        await writeFile(temp, JSON.stringify(board, null, 0), 'utf8');
        await rename(temp, target);
        this.errors.delete(workspaceId);
      })
      .catch((error) => {
        this.errors.set(workspaceId, error instanceof Error ? error.message : String(error));
      });
    this.pending.set(workspaceId, next);
    return next;
  }
}

/**
 * Per-workspace thought store: one file per workspace under `<stateDir>/thoughts/`,
 * atomic replace, serialized writes, tolerant read. Kept apart from the board so
 * the board schema stays v2 and an old board never needs a migration for intake.
 */
class ThoughtStore {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.loading = new Map();
    this.pending = new Map();
    this.errors = new Map();
  }

  file(workspaceId) {
    return join(this.dir, `${safeFileName(workspaceId)}.json`);
  }

  /**
   * Cached in-memory state. Concurrent first reads must share ONE state object:
   * otherwise two snapshots would mutate different copies and a queue drain
   * could dispatch the same thought twice.
   */
  async get(project) {
    const cached = this.cache.get(project.id);
    if (cached) return cached;
    const inFlight = this.loading.get(project.id);
    if (inFlight) return inFlight;
    const load = (async () => {
      let raw = null;
      try {
        raw = JSON.parse(await readFile(this.file(project.id), 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.errors.set(project.id, error instanceof Error ? error.message : String(error));
          try {
            await rename(this.file(project.id), `${this.file(project.id)}.corrupt-${now()}`);
          } catch {
            // best effort: a corrupt file is replaced, never fatal
          }
        }
      }
      // A corrupt file leaves raw null, and normalizeThoughtState degrades to [].
      const state = normalizeThoughtState(raw);
      this.cache.set(project.id, state);
      return state;
    })();
    this.loading.set(project.id, load);
    try {
      return await load;
    } finally {
      this.loading.delete(project.id);
    }
  }

  async save(project, state) {
    const workspaceId = project.id;
    const previous = this.pending.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const target = this.file(workspaceId);
        const temp = `${target}.tmp-${process.pid}-${now()}`;
        await writeFile(temp, JSON.stringify(state, null, 0), 'utf8');
        await rename(temp, target);
        this.errors.delete(workspaceId);
      })
      .catch((error) => {
        this.errors.set(workspaceId, error instanceof Error ? error.message : String(error));
      });
    this.pending.set(workspaceId, next);
    return next;
  }
}

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir.length > 0
    ? settings.stateDir
    : join(dshHome(), 'kanban');
  // Test-only clock knob (KB-5): thought timestamps, audit `at`, timeline order
  // and grace checks all read this, so tests need no wall-clock sleeps.
  const clock = typeof settings.now === 'function' ? settings.now : now;
  const store = new BoardStore(stateDir, defaultWip(settings), clock);
  const thoughtStore = new ThoughtStore(join(stateDir, 'thoughts'));
  // Live dispatch grace is 30 s; tests may shrink it with the config knob.
  const thoughtGraceMs =
    Number.isInteger(settings.thoughtGraceMs) && settings.thoughtGraceMs > 0
      ? settings.thoughtGraceMs
      : THOUGHT_GRACE_MS;
  // KB-6 per-workspace intake budget. The defaults (5/min, 20/hour) are the
  // shipped contract; the knob exists so a host can tune it and so suites that
  // deliberately submit bursts can opt out without changing production limits.
  const thoughtRateLimits = normalizeThoughtRateLimits(settings.thoughtRateLimits);
  const lastScans = new Map();
  let sessionsCache = { at: 0, items: [] };

  // -- live DSH helpers ----------------------------------------------------

  async function readSessions() {
    if (now() - sessionsCache.at < SESSION_CACHE_MS) return sessionsCache.items;
    let items = [];
    try {
      const signal = AbortSignal.timeout(8000);
      const result = await ctx.sessionController.list({}, signal);
      if (result && Array.isArray(result.items)) {
        items = result.items.map((item) => ({
          sessionId: String(item.sessionId),
          title: sessionTitleOf(item),
          updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
          running: item.running === true,
          isSubagent: item.origin === 'subagent' || typeof item.parentSessionId === 'string',
          parentSessionId: typeof item.parentSessionId === 'string' ? item.parentSessionId : undefined,
          cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
          agentPreset:
            (item.projections && item.projections.values && item.projections.values.agentPreset) ??
            (item.projectionValues && item.projectionValues.agentPreset) ??
            (typeof item.agentPreset === 'string' ? item.agentPreset : undefined),
        }));
      }
    } catch {
      items = [];
    }
    sessionsCache = { at: now(), items };
    return items;
  }

  function workspaces() {
    try {
      return ctx.workspaceRegistry.list();
    } catch {
      return [];
    }
  }

  function owningWorkspace(cwd, list = workspaces()) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null;
    let best = null;
    for (const workspace of list) {
      if (!isInside(cwd, workspace.path)) continue;
      if (best === null || workspace.path.length > best.path.length) best = workspace;
    }
    return best;
  }

  function projectFor(workspaceId, sessionsForDefault) {
    const list = workspaces();
    if (typeof workspaceId === 'string' && workspaceId.length > 0) {
      const found = list.find((workspace) => String(workspace.id) === workspaceId);
      if (!found) throw new ApiError(404, 'project/not-found', `Unknown project: ${workspaceId}`);
      return found;
    }
    if (list.length === 0) throw new ApiError(409, 'project/empty', 'No workspace is registered in this Harness yet.');
    // Default project: the workspace of the most recently active conversation,
    // so the board opens on the project the user is actually working in.
    if (Array.isArray(sessionsForDefault) && sessionsForDefault.length > 0) {
      const ordered = [...sessionsForDefault].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      for (const session of ordered) {
        const match = owningWorkspace(session.cwd, list);
        if (match) return match;
      }
    }
    return list[0];
  }

  function projectOfSession(session) {
    return owningWorkspace(session.cwd);
  }

  async function agentCwd(agent) {
    try {
      const snapshot = await ctx.sessionPersistence.stat(agent.id);
      if (snapshot?.header?.cwd) return snapshot.header.cwd;
    } catch {
      // fall through to the live store
    }
    try {
      const live = ctx.get('sessions')?.get?.(agent.id);
      if (live?.header?.cwd) return live.header.cwd;
    } catch {
      // no live session
    }
    return undefined;
  }

  async function projectForAgent(agent, requested) {
    if (typeof requested === 'string' && requested.length > 0) {
      const byId = workspaces().find(
        (workspace) => String(workspace.id) === requested || workspace.title.toLowerCase() === requested.toLowerCase(),
      );
      if (byId) return byId;
    }
    const cwd = await agentCwd(agent);
    if (cwd) {
      const byCwd = owningWorkspace(cwd);
      if (byCwd) return byCwd;
    }
    throw new ApiError(
      409,
      'project/unresolved',
      'The Kanban board could not resolve your project. Pass `project` (a workspace id or title) or run from a session whose working directory is a registered workspace.',
    );
  }

  function defaultAgentRole(name, description) {
    const text = `${name ?? ''} ${description ?? ''}`.toLowerCase();
    if (/\b(tech lead|tech-lead|architect|lead engineer)\b/.test(text)) return 'tech-lead';
    if (/\b(bug fixer|bug-fixer|bugfix|root cause|repro|forensic)\b/.test(text)) return 'bug-fixer';
    if (/\b(product manager|product owner|\bpm\b|product)\b/.test(text)) return 'product-manager';
    if (/\b(designer|\bux\b|\bui\/ux\b|design)\b/.test(text)) return 'ux-designer';
    if (/\b(reviewer|code review)\b/.test(text)) return 'reviewer';
    if (/\b(tester|\bqa\b|quality)\b/.test(text)) return 'tester';
    if (/\b(sre|devops|platform|infra|reliability)\b/.test(text)) return 'sre';
    if (/\b(frontend|front-end|\bfe\b|react|web ui)\b/.test(text)) return 'fe-developer';
    if (/\b(backend|back-end|\bbe\b|api|server|database)\b/.test(text)) return 'be-developer';
    return 'fullstack-developer';
  }

  /** Case-folded display name: "Ashraf  AHWA" and "ashraf ahwa" match. */
  function memberNameKey(value) {
    return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /** kebab-case identity so a DSH teammate id ("ashraf-ahwa") matches "Ashraf Ahwa". */
  function memberSlugKey(value) {
    return memberNameKey(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  /** Match a session/agent/teammate label to exactly one roster member. */
  function matchRosterMember(board, ...values) {
    for (const value of values) {
      const key = memberNameKey(value);
      if (!key) continue;
      const direct = board.team.members.find((candidate) => memberNameKey(candidate.name) === key);
      if (direct) return direct;
    }
    for (const value of values) {
      const slug = memberSlugKey(value);
      if (!slug) continue;
      const match = board.team.members.find((candidate) => memberSlugKey(candidate.name) === slug);
      if (match) return match;
    }
    return null;
  }

  /** "You are `Name`" / session title → the person label the title carries. */
  function displayTitleName(title) {
    const raw = typeof title === 'string' ? title.trim() : '';
    if (!raw || /^(Session |New session$)/.test(raw)) return '';
    const named = /You are `([^`]{2,60})`/.exec(raw);
    if (named) return named[1];
    return raw.replace(/\s+/g, ' ').slice(0, 60);
  }

  /**
   * Attach a live session to one roster member and persist both sides:
   * `board.agents[sessionId].memberId` and, when this is the member's current
   * agent, `member.sessionId`. Returns true when the board changed.
   */
  function attachSessionToMember(board, sessionId, member, { current = false } = {}) {
    if (!member) return false;
    const key = String(sessionId);
    const entry = ensureBoardAgent(board, key, { name: member.name, role: member.roleId, memberId: member.id });
    let changed = false;
    if (entry.memberId !== member.id) {
      entry.memberId = member.id;
      changed = true;
    }
    if (!ALL_ROLES.includes(entry.role)) entry.role = member.roleId;
    if (current && member.sessionId !== key) {
      member.sessionId = key;
      member.updatedAt = now();
      changed = true;
    }
    return changed;
  }

  function ensureBoardAgent(board, sessionId, hints = {}) {
    const key = String(sessionId);
    let entry = board.agents[key];
    if (!entry || typeof entry !== 'object') {
      entry = {
        name: hints.name || `Agent ${key.slice(-4)}`,
        role: hints.role || defaultAgentRole(hints.name, hints.description),
        paused: false,
        firstSeenAt: now(),
      };
      if (typeof hints.memberId === 'string' && hints.memberId) entry.memberId = hints.memberId;
      board.agents[key] = entry;
    } else {
      if (hints.name && (!entry.name || entry.name.startsWith('Agent '))) entry.name = hints.name;
      if (hints.role && !ALL_ROLES.includes(entry.role)) entry.role = hints.role;
      if (!ALL_ROLES.includes(entry.role)) entry.role = defaultAgentRole(entry.name, hints.description);
      if (typeof hints.memberId === 'string' && hints.memberId) entry.memberId = hints.memberId;
      else if (entry.memberId !== undefined && typeof entry.memberId !== 'string') delete entry.memberId;
      entry.paused = entry.paused === true;
    }
    return entry;
  }

  async function liveTeamIndex() {
    const index = new Map();
    try {
      const live = ctx.get('agents')?.list?.() ?? [];
      const teams = ctx.get('agentTeams');
      if (!teams) return index;
      for (const agent of live) {
        try {
          const membership = teams.tryMembership(agent);
          if (!membership) continue;
          index.set(String(agent.id), {
            name: membership.name,
            role: membership.role,
            leadId: String(membership.root.id),
          });
        } catch {
          // membership is optional
        }
      }
    } catch {
      // Agent Teams may be disabled
    }
    return index;
  }

  /**
   * Build the project's fixed team view: which observed sessions are attached to
   * a roster member, whether each attached agent is executing a turn right now,
   * and the prune of `board.agents` rows that belong to nobody.
   *
   * Attachment is deterministic and persisted:
   *  - an explicit `board.agents[sessionId].memberId` wins;
   *  - `member.sessionId` anchors the member's current agent;
   *  - a live agent is matched by Agent Teams name, board-agent name or session
   *    title, and by the member named on the active ticket it owns.
   * A stored conversation never resurrects a roster row on its own, and legacy
   * agent rows for sessions no member owns are dropped (the "Other agents" noise
   * is gone). Drafting and executing sessions are added by their own dispatch
   * paths, never inferred here.
   */
  async function snapshotTeam(project, board) {
    const [allSessions, teamIndex] = await Promise.all([readSessions(), liveTeamIndex()]);
    const draftingSessions = new Set(
      board.team.drafts.filter((draft) => draft.status === 'drafting' && draft.sessionId).map((draft) => draft.sessionId),
    );
    const observed = new Map();
    for (const session of allSessions) {
      if (owningWorkspace(session.cwd)?.id !== project.id) continue;
      if (draftingSessions.has(session.sessionId)) continue;
      if (board.agents?.[session.sessionId]?.draft === true) continue;
      observed.set(session.sessionId, session);
    }
    const membersById = new Map(board.team.members.map((member) => [member.id, member]));
    const attachments = new Map();
    let changed = false;
    const attach = (sessionId, member) => {
      const key = String(sessionId);
      const previous = attachments.get(key);
      if (previous && previous.memberId !== member.id) return false;
      const live = liveAgentStatus(key);
      const session = observed.get(key);
      if (live === null && !session && !previous) return false;
      const ticket = memberFocusTicket(board, member);
      attachments.set(key, {
        sessionId: key,
        memberId: member.id,
        memberName: member.name,
        status: live === 'running' ? 'running' : 'idle',
        ticketId: ticket?.id ?? null,
      });
      if (attachSessionToMember(board, key, member, { current: live === 'running' })) changed = true;
      return true;
    };
    // 1. Explicit persisted links.
    for (const [sessionId, entry] of Object.entries(board.agents ?? {})) {
      if (!entry || typeof entry !== 'object' || entry.draft === true) continue;
      const member = typeof entry.memberId === 'string' ? membersById.get(entry.memberId) : null;
      if (member) attach(sessionId, member);
    }
    // 2. The member's current-session anchor.
    for (const member of board.team.members) {
      if (member.sessionId) attach(member.sessionId, member);
    }
    // 3. A live agent whose name (Agent Teams, board entry, session title) names a member.
    for (const session of observed.values()) {
      if (attachments.has(session.sessionId)) continue;
      if (liveAgentStatus(session.sessionId) === null) continue;
      const membership = teamIndex.get(session.sessionId);
      const member = matchRosterMember(
        board,
        membership?.name,
        board.agents?.[session.sessionId]?.name,
        displayTitleName(session.title),
      );
      if (member) attach(session.sessionId, member);
    }
    // 4. A live agent bound to a member by the active ticket it owns.
    for (const session of observed.values()) {
      if (attachments.has(session.sessionId)) continue;
      if (liveAgentStatus(session.sessionId) === null) continue;
      const ticket = board.tickets.find(
        (candidate) =>
          candidate.owner?.sessionId === session.sessionId &&
          (candidate.column === 'in_progress' || candidate.column === 'review'),
      );
      const member = ticket?.owner?.memberId ? membersById.get(ticket.owner.memberId) : null;
      if (member) attach(session.sessionId, member);
    }
    // Drop legacy agent rows: keep only roster attachments, in-flight drafting
    // agents, agents that are actually live, and sessions an active ticket still
    // names. Stored conversations are not team rows any more, so they must not
    // keep a bookkeeping record alive.
    const referencedByActiveTicket = new Set();
    for (const ticket of board.tickets) {
      if (ticket.column !== 'in_progress' && ticket.column !== 'review') continue;
      if (ticket.owner?.sessionId) referencedByActiveTicket.add(ticket.owner.sessionId);
      if (ticket.assignment?.agentSessionId) referencedByActiveTicket.add(ticket.assignment.agentSessionId);
      if (ticket.execution?.sessionId) referencedByActiveTicket.add(ticket.execution.sessionId);
    }
    const draftingEntries = new Set(
      board.team.drafts.filter((draft) => draft.status === 'drafting' && draft.sessionId).map((draft) => draft.sessionId),
    );
    for (const sessionId of Object.keys(board.agents ?? {})) {
      const entry = board.agents[sessionId];
      if (!entry || typeof entry !== 'object') {
        delete board.agents[sessionId];
        changed = true;
        continue;
      }
      if (attachments.has(sessionId)) continue;
      if (entry.draft === true && draftingEntries.has(sessionId)) continue;
      if (entry.roleOverride === true) continue;
      if (liveAgentStatus(sessionId) !== null) continue;
      if (referencedByActiveTicket.has(sessionId)) continue;
      delete board.agents[sessionId];
      changed = true;
    }
    const rows = [];
    for (const [sessionId, attachment] of attachments) {
      const member = membersById.get(attachment.memberId);
      if (!member) continue;
      const ticket = attachment.ticketId ? board.tickets.find((candidate) => candidate.id === attachment.ticketId) : null;
      rows.push({
        sessionId,
        name: member.name,
        role: member.roleId,
        roleName: ROLE_INDEX[member.roleId]?.name ?? member.roleId,
        status: attachment.status,
        ticketId: attachment.ticketId,
        ticketTitle: ticket?.title ?? null,
        isLead: false,
        paused: member.paused === true,
        memberId: member.id,
        description: 'Team member',
      });
    }
    rows.sort((left, right) => left.name.localeCompare(right.name));
    return { rows, sessions: [...observed.values()], attachments, changed };
  }

  // -- team roster ---------------------------------------------------------

  function memberLastActivityAt(board, member) {
    let at = Number.isFinite(member.updatedAt) ? member.updatedAt : member.createdAt;
    for (const ticket of board.tickets) {
      const owns =
        ticket.owner?.memberId === member.id ||
        (member.sessionId && ticket.owner?.sessionId === member.sessionId) ||
        ticket.assignment?.memberId === member.id;
      if (!owns) continue;
      at = Math.max(at, ticket.updatedAt, ticket.movedAt);
      for (const entry of ticket.activity) {
        if (entry.by === member.name) at = Math.max(at, entry.at);
      }
    }
    for (const entry of board.activity) {
      if (entry.by === member.name) at = Math.max(at, entry.at);
    }
    return at;
  }

  /**
   * Truthful member status, derived only from the agents attached to the member:
   * paused > running (an attached live agent is executing a turn) > idle (an
   * attached session/agent exists but no turn is executing) > offline (none).
   * Owning a ticket never makes a member busy; `currentTicket` is the
   * display-safe focus ticket (their own In Progress work, or a Review ticket
   * when their role owns the review gate), never a handed-off implementer ticket.
   */
  function rosterRows(board, sessions, attachments = new Map()) {
    const order = new Map(ALL_ROLES.map((roleId, index) => [roleId, index]));
    const observed = new Set((sessions ?? []).map((session) => session.sessionId));
    const byMember = new Map();
    for (const attachment of attachments.values()) {
      const list = byMember.get(attachment.memberId) ?? [];
      list.push(attachment);
      byMember.set(attachment.memberId, list);
    }
    return board.team.members
      .map((member) => {
        const held = memberTicket(board, member);
        const ticket = memberFocusTicket(board, member);
        const attached = [...(byMember.get(member.id) ?? [])];
        if (
          member.sessionId &&
          !attached.some((row) => row.sessionId === member.sessionId) &&
          observed.has(member.sessionId)
        ) {
          attached.push({ sessionId: member.sessionId, memberId: member.id, status: 'idle', ticketId: null });
        }
        const running = attached.some((row) => row.status === 'running');
        const status = member.paused ? 'paused' : running ? 'running' : attached.length > 0 ? 'idle' : 'offline';
        const active = attached.find((row) => row.status === 'running') ?? attached[0] ?? null;
        const reason = member.paused
          ? 'Member is paused'
          : running
            ? ticket
              ? `Agent session is running (working ${ticket.id})`
              : 'Agent session is running'
            : attached.length > 0
              ? ticket
                ? `Agent session is idle (next ${ticket.id})`
                : held && held.column === 'review'
                  ? `Agent session is idle (${held.id} is in review, not with this member)`
                  : 'Agent session is idle'
              : ticket
                ? `No agent session attached (${ticket.id} waiting in ${ticket.column})`
                : 'No agent session attached';
        return {
          id: member.id,
          name: member.name,
          title: member.title,
          roleId: member.roleId,
          roleName: ROLE_INDEX[member.roleId]?.name ?? member.roleId,
          persona: member.persona,
          paused: member.paused,
          sessionId: active?.sessionId ?? null,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
          createdBy: member.createdBy,
          source: member.source,
          status,
          statusReason: reason,
          currentTicket: ticket ? { id: ticket.id, title: ticket.title, column: ticket.column } : null,
          // `since` only means "working since" while the agent is actually
          // running; an idle owner keeps the ticket but reports no busy clock.
          since: running && ticket ? ticket.movedAt : null,
          lastActivityAt: memberLastActivityAt(board, member),
        };
      })
      .sort(
        (left, right) =>
          (order.get(left.roleId) ?? 99) - (order.get(right.roleId) ?? 99) ||
          left.name.localeCompare(right.name),
      );
  }

  function draftRows(board) {
    return board.team.drafts.map((draft) => ({
      id: draft.id,
      description: draft.description,
      roleId: draft.roleId,
      roleName: draft.roleId ? (ROLE_INDEX[draft.roleId]?.name ?? draft.roleId) : null,
      sessionId: draft.sessionId,
      status: draft.status,
      createdAt: draft.createdAt,
      ...(draft.error ? { error: draft.error } : {}),
      ...(draft.mode ? { mode: draft.mode } : {}),
    }));
  }

  function findMember(board, memberId) {
    const member = board.team.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new ApiError(404, 'member/not-found', `Unknown team member: ${memberId}`);
    return member;
  }

  function memberNameTaken(board, name, exceptId = null) {
    const key = name.trim().toLowerCase();
    return board.team.members.some(
      (member) => member.id !== exceptId && member.name.trim().toLowerCase() === key,
    );
  }

  function ticketCounts(board) {
    const counts = { backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0, blocked: 0, executing: 0 };
    for (const ticket of board.tickets) {
      if (counts[ticket.column] !== undefined) counts[ticket.column] += 1;
      if (ticket.blocked) counts.blocked += 1;
      if (ticket.execution && ticket.execution.status === 'running') counts.executing += 1;
    }
    return counts;
  }

  async function snapshotProjects(currentId) {
    const list = workspaces();
    const sessions = await readSessions();
    const summaries = [];
    for (const workspace of list) {
      const board = await store.peek(workspace);
      const counts = board ? ticketCounts(board) : { backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0 };
      const relevant = sessions.filter((session) => owningWorkspace(session.cwd, list)?.id === workspace.id);
      summaries.push({
        id: String(workspace.id),
        title: workspace.title,
        path: workspace.path,
        sessionCount: relevant.length || (workspace.sessionIds?.length ?? 0),
        running: relevant.filter((session) => session.running).length,
        paused: board?.paused === true,
        counts,
        active: counts.in_progress + counts.review,
        updatedAt: board?.updatedAt ?? null,
        selected: String(workspace.id) === currentId,
      });
    }
    return summaries;
  }

  function rulesSnapshot() {
    return {
      columns: COLUMNS.map((column) => ({ ...column, wip: store.wip[column.id] ?? 0 })),
      // Compact role rows only: the polled snapshot must never carry the full
      // playbooks. `roleDetail` serves a whole playbook on demand.
      roles: ROLES.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description,
        summary: role.summary,
        claimColumns: [...role.claimColumns],
        canCreate: role.canCreate,
        canOverride: role.canOverride,
        stepCount: role.playbook.steps.length,
        definitionOfDone: [...role.playbook.definitionOfDone],
      })),
      transitions: TRANSITIONS.map((transition) => ({ ...transition, allowedRoles: [...transition.allowedRoles] })),
      definitionOfReady: DEFINITION_OF_READY,
      definitionOfDone: DEFINITION_OF_DONE,
    };
  }

  async function snapshot(workspaceId) {
    const list = workspaces();
    if (list.length === 0) {
      return {
        version: VERSION,
        now: now(),
        projects: [],
        workspaceId: null,
        project: null,
        board: null,
        team: [],
        roster: [],
        drafts: [],
        sessions: [],
        thoughts: [],
        deletedThoughtIds: [],
        rules: rulesSnapshot(),
        autopilot: null,
        lastScan: null,
      };
    }
    const sessionsForDefault = await readSessions();
    const project = projectFor(workspaceId, sessionsForDefault);
    const board = await store.ensure(project);
    noteAutopilotBoard(board);
    await reconcileExecutions(board);
    await reconcileThoughts(project);
    // A snapshot read is also a drain trigger: resume can race with the poll, so
    // the per-workspace lock guarantees each queued thought dispatches at most once.
    await drainThoughtQueue(project, board);
    const { thoughts, deletedThoughtIds } = await thoughtSnapshot(project);
    // Reconcile timed-out drafts before building the team view so a stale drafting
    // agent is not mistaken for a live attachment on this very read.
    const timedOutDrafts = reconcileDrafts(board);
    for (const sessionId of timedOutDrafts) {
      try {
        ctx.sessionController.cancel({ sessionId });
      } catch {
        // best effort: the draft is already marked failed for retry
      }
    }
    const { rows, sessions, attachments, changed } = await snapshotTeam(project, board);
    const roster = rosterRows(board, sessions, attachments);
    const drafts = draftRows(board);
    if (changed || timedOutDrafts.length > 0) await store.save(board);
    const projects = await snapshotProjects(String(project.id));
    return {
      version: VERSION,
      now: now(),
      projects,
      workspaceId: String(project.id),
      project: {
        id: String(project.id),
        title: project.title,
        path: project.path,
        sessionCount: sessions.length || (project.sessionIds?.length ?? 0),
        createdAt: board.createdAt,
        updatedAt: board.updatedAt,
      },
      board,
      // KB-68 additive read model. Derived and never persisted; the persisted
      // keys stay visible on `board.autopilot` / `board.pulses` above.
      autopilot: autopilotReadModel(board, clock()),
      execution: executionSummary(board),
      team: rows,
      roster,
      drafts,
      thoughts,
      deletedThoughtIds,
      sessions,
      rules: rulesSnapshot(),
      accessModes: { options: accessOptions(), suggestions: accessSuggestions() },
      lastScan: lastScans.get(String(project.id)) ?? null,
      ...(store.errors.has(String(project.id)) ? { routeError: store.errors.get(String(project.id)) } : {}),
    };
  }

  // -- policy helpers ------------------------------------------------------

  function findTicket(board, ticketId) {
    const ticket = board.tickets.find((candidate) => candidate.id === ticketId);
    if (!ticket) throw notFound(`Unknown ticket: ${ticketId}`);
    return ticket;
  }

  function validateMove(ticket, to, role, actor, { user = false } = {}) {
    if (!COLUMN_IDS.includes(to)) throw badRequest(`Unknown column: ${to}`);
    const from = ticket.column;
    if (from === to) return;
    // An EPIC is pinned to Backlog: this wins over transitions and over the
    // user/tech-lead bypass, so no path can move one to a work lane.
    if (ticket.type === 'epic') throw epicBacklogOnly();
    // KB-73 AC 5: Review has exactly two legal exits. `review → ready` is not a
    // policy edge (Ready is PM-owned refinement), so the attempt is rejected with
    // the policy reason instead of the generic "one column at a time" message;
    // actionMove logs the rejection so the pulse feed shows a policy error rather
    // than a silent retry.
    if (from === 'review' && to === 'ready') {
      throw new ApiError(
        409,
        'ticket/invalid-transition',
        `review → ready is not a legal policy move: Review exits to Done (accepted) or In Progress (changes-requested); Ready is a PM-owned refinement lane.`,
      );
    }
    const fromIndex = COLUMN_INDEX[from];
    const toIndex = COLUMN_INDEX[to];
    if (Math.abs(fromIndex - toIndex) !== 1) {
      throw new ApiError(
        409,
        'ticket/invalid-transition',
        `Invalid transition ${from} → ${to}: Kanban moves one column at a time.`,
      );
    }
    if (ticket.blocked) {
      throw new ApiError(409, 'ticket/blocked', `Ticket ${ticket.id} is blocked: ${ticket.blockReason || 'no reason recorded'}.`);
    }
    if (user) return;
    if (role === 'tech-lead') return;
    // KB-73 AC 4/AC 5: an autopilot review session may only leave Review through
    // a recorded verdict. A Done without an accepted verdict is never allowed and
    // a handback without a changes-requested verdict would be an unowned rework,
    // so both are rejected with an explicit code the action layer logs.
    const execution = ticket.execution;
    const reviewExecution =
      execution && execution.origin === 'autopilot' && execution.startColumn === 'review' && execution.sessionId === actor.sessionId;
    if (reviewExecution && from === 'review' && to === 'done') {
      const verdict = newestReviewOf(ticket, actor.sessionId);
      if (!verdict || verdict.verdict !== 'accepted') {
        throw new ApiError(
          409,
          'ticket/review-verdict-required',
          `Record an accepted verdict with {"action":"review","verdict":"accepted",...} before moving ${ticket.id} review → done; a silent Done is not allowed.`,
        );
      }
    }
    if (reviewExecution && from === 'review' && to === 'in_progress') {
      const verdict = newestReviewOf(ticket, actor.sessionId);
      if (!verdict || verdict.verdict !== 'changes-requested') {
        throw new ApiError(
          409,
          'ticket/review-verdict-required',
          `Record a changes-requested verdict with {"action":"review","verdict":"changes-requested",...} before returning ${ticket.id} to In Progress.`,
        );
      }
    }
    if (ticket.execution?.sessionId === actor.sessionId) return;
    if (!canRoleMove(role, ticket, from, to)) {
      throw new ApiError(
        403,
        'ticket/role-forbidden',
        `${ROLE_INDEX[role]?.name ?? role} may not move ${ticket.id} ${from} → ${to}.`,
      );
    }
    if (from === 'in_progress' && to === 'review' && ticket.owner?.sessionId !== actor.sessionId) {
      throw new ApiError(403, 'ticket/role-forbidden', `Only ${ticket.owner?.name ?? 'the owner'} may raise ${ticket.id} to Review.`);
    }
    if (from === 'review' && to === 'in_progress' && !['reviewer', 'tester', 'tech-lead'].includes(role)) {
      throw new ApiError(403, 'ticket/role-forbidden', 'Only a reviewer or tester can send a ticket back to In Progress.');
    }
    if (from === 'review' && to === 'done' && !['reviewer', 'tester', 'tech-lead'].includes(role)) {
      throw new ApiError(403, 'ticket/role-forbidden', 'Only a reviewer or tester can accept a ticket to Done.');
    }
    if (from === 'done' && to === 'review' && !['tester', 'tech-lead'].includes(role)) {
      throw new ApiError(403, 'ticket/role-forbidden', 'Only a tester can reopen an accepted ticket.');
    }
  }

  function canRoleMove(role, ticket, from, to) {
    const moves = ROLE_MOVE[role] ?? [];
    if (moves.includes('*') || moves.includes(`${from}>${to}`)) {
      if (from === 'ready' && to === 'in_progress' && ticket.role) {
        return roleMatches(role, ticket.role);
      }
      return true;
    }
    return false;
  }

  function roleMatches(role, ticketRole) {
    if (!ticketRole) return DEV_ROLES.has(role) || role === 'ux-designer';
    if (role === ticketRole) return true;
    if (role === 'tech-lead') return true;
    if (role === 'fullstack-developer' && (ticketRole === 'fe-developer' || ticketRole === 'be-developer')) return true;
    if (ticketRole === 'fullstack-developer' && (role === 'fe-developer' || role === 'be-developer')) return true;
    return false;
  }

  function enforceWip(board, to) {
    // The pure headroom check is shared with the pulse planner; this wrapper
    // keeps the board's throwing API for manual moves.
    const state = wipState(board, store.wip, to);
    if (state.over) {
      throw new ApiError(409, 'ticket/wip-limit', `WIP limit reached for ${to} (${state.count}/${state.limit}). Finish or unblock work before pulling more.`);
    }
    return { over: false, limit: state.limit };
  }

  /**
   * KB-71 AC 3 second gate: an autopilot refine session may never push Ready past
   * `maxReadyDepth`. The planner checks the depth before dispatching, but Ready
   * can fill concurrently (a human move, or another lane's dispatch) between the
   * plan and the PM's claim, so the host's claim/move path re-checks. Only a
   * session the autopilot dispatched (execution `origin: 'autopilot'`, started
   * from Backlog) is restrained; a human-initiated PM run has no origin and is
   * never blocked by the autopilot cap (AC 4).
   */
  function assertAutopilotRefineHeadroom(board, ticket, actor) {
    const execution = ticket?.execution;
    if (!execution || execution.origin !== 'autopilot' || execution.startColumn !== 'backlog') return;
    if (actor?.sessionId && execution.sessionId !== actor.sessionId) return;
    if (!autopilotEnabled(board)) return;
    const ceiling = effectiveMaxReadyDepth(board.autopilot);
    const depth = board.tickets.filter((candidate) => candidate.column === 'ready').length;
    if (depth < ceiling) return;
    throw new ApiError(
      409,
      'ticket/wip-limit',
      `Ready depth ${depth} is at the autopilot ceiling ${ceiling}; ${ticket.id} stays in Backlog and the refine pulse records the miss.`,
    );
  }

  function pushBoardActivity(board, by, kind, text, ticketId) {
    board.activity.unshift({
      id: uid(),
      at: now(),
      by: clampString(by, 120) || 'system',
      kind,
      ...(ticketId ? { ticketId } : {}),
      text: clampString(text, 600),
    });
    board.activity = board.activity.slice(0, 200);
  }

  function pushTicketActivity(ticket, by, action, text) {
    ticket.activity.unshift({
      id: uid(),
      at: now(),
      by: clampString(by, 120) || 'system',
      action,
      text: clampString(text, 600),
    });
    ticket.activity = ticket.activity.slice(0, 60);
  }

  function nextTicketNumber(board) {
    const number = board.nextNumber ?? 1;
    board.nextNumber = number + 1;
    return number;
  }

  function createTicketRecord(board, input, actor) {
    const at = now();
    const title = clampString(input.title, 300);
    if (!title) throw badRequest('A ticket title is required.');
    const type = TICKET_TYPES.includes(input.type) ? input.type : 'task';
    // An EPIC is always created in Backlog, whatever column was requested (the
    // same rule a thought dispatch already applies to every ticket).
    const column = type === 'epic' ? 'backlog' : COLUMN_IDS.includes(input.column) ? input.column : 'backlog';
    const role = ALL_ROLES.includes(input.role) ? input.role : null;
    // Validate the parent link before consuming a ticket number, so a rejected
    // create cannot silently skip an id.
    const parentId = resolveParentId(board, input.parentId, { type });
    const number = nextTicketNumber(board);
    const ticket = {
      id: `KB-${number}`,
      number,
      title,
      description: typeof input.description === 'string' ? input.description.slice(0, 20000) : '',
      type,
      priority: ['low', 'medium', 'high', 'critical'].includes(input.priority) ? input.priority : 'medium',
      column,
      role,
      labels: Array.isArray(input.labels)
        ? input.labels.filter((label) => typeof label === 'string').slice(0, 12)
        : [],
      // Additive KB-1 linkage: tickets created by a thought dispatch carry its id.
      ...(typeof input.thoughtId === 'string' && input.thoughtId ? { thoughtId: input.thoughtId.slice(0, 40) } : {}),
      // Additive KB-3 linkage: present only on a child of an EPIC.
      ...(parentId ? { parentId } : {}),
      owner: null,
      blocked: false,
      blockReason: '',
      checklist: Array.isArray(input.checklist)
        ? input.checklist
            .filter((item) => typeof item === 'string' || (item && typeof item.text === 'string'))
            .slice(0, 40)
            .map((item) => ({
              id: uid(),
              text: (typeof item === 'string' ? item : item.text).slice(0, 300),
              done: false,
            }))
        : [],
      comments: [],
      // KB-68 additive read model: a new ticket has no review verdicts yet.
      reviews: [],
      source: input.source && typeof input.source === 'object'
        ? {
            kind: String(input.source.kind ?? 'manual'),
            ref: clampString(input.source.ref, 500),
            ...(typeof input.source.title === 'string' ? { title: input.source.title.slice(0, 300) } : {}),
            ...(typeof input.source.url === 'string' ? { url: input.source.url.slice(0, 1000) } : {}),
          }
        : null,
      createdAt: at,
      updatedAt: at,
      movedAt: at,
      acceptedAt: null,
      activity: [{ id: uid(), at, by: actor, action: 'create', text: `Created in ${column}` }],
    };
    board.tickets.push(ticket);
    pushBoardActivity(board, actor, 'ticket/create', `Created ${ticket.id}: ${title}`, ticket.id);
    return ticket;
  }

  function withActor(actor) {
    return clampString(actor, 120) || 'system';
  }

  // -- ticket execution sessions ------------------------------------------

  function roleShortName(role) {
    return {
      'product-manager': 'pm',
      'ux-designer': 'ux',
      'fe-developer': 'fe',
      'be-developer': 'be',
      'fullstack-developer': 'dev',
      'bug-fixer': 'fix',
      reviewer: 'reviewer',
      tester: 'tester',
      sre: 'sre',
      'tech-lead': 'lead',
    }[role] ?? 'agent';
  }

  /**
   * Member resolution for a dispatch: explicit memberId → idle member of the
   * chosen role → any free member of that role → role-only fallback (the
   * legacy behaviour with no persona).
   */
  function resolveDispatchMember(board, role, explicitMemberId) {
    if (typeof explicitMemberId === 'string' && explicitMemberId) {
      const member = findMember(board, explicitMemberId);
      if (member.paused) {
        throw new ApiError(409, 'member/paused', `${member.name} is paused. Resume the member before dispatching work.`);
      }
      return member;
    }
    const candidates = board.team.members.filter((member) => member.roleId === role && !member.paused);
    const idle = candidates.find((member) => !memberTicket(board, member) && !member.sessionId);
    if (idle) return idle;
    return candidates.find((member) => !memberTicket(board, member)) ?? null;
  }

  const ACCESS_FALLBACK = [
    { value: 'read-only', name: 'Read only', description: 'Can inspect files and run read-only tools; cannot modify the workspace.' },
    { value: 'workspace-write', name: 'Workspace write', description: 'Can modify files inside the project workspace.' },
    { value: 'danger-full-access', name: 'Full access', description: 'Unrestricted filesystem and command access. Use only when the task requires it.' },
  ];

  function accessOptions() {
    const presets = ctx.get('permissionPresets');
    let options = [];
    try {
      const catalog = presets?.catalog?.();
      if (catalog && Array.isArray(catalog.options)) {
        options = catalog.options
          .filter((option) => option && typeof option.value === 'string')
          .map((option) => ({
            value: option.value,
            name: typeof option.name === 'string' && option.name ? option.name : option.value,
            description: typeof option.description === 'string' ? option.description : '',
          }));
      }
    } catch {
      options = [];
    }
    return options.length > 0 ? options : ACCESS_FALLBACK.map((option) => ({ ...option }));
  }

  function accessSandbox(value, presets) {
    try {
      const spec = presets.resolve(value);
      if (spec && typeof spec.sandbox === 'string') return spec.sandbox;
    } catch {
      // fall through to the id convention
    }
    return value;
  }

  function resolveAccessMode(requested, ticket, role) {
    const presets = ctx.get('permissionPresets');
    const options = accessOptions();
    const wanted = typeof requested === 'string' && requested.length > 0
      ? requested
      : suggestedAccessMode(ticket, role, options, presets);
    const match = options.find((option) => option.value === wanted) ?? options[0];
    return {
      value: match ? match.value : 'workspace-write',
      options,
    };
  }

  function suggestedAccessSandbox(ticket, role) {
    if (ticket.column === 'backlog') return 'read-only';
    // KB-73 access decision: review dispatches use the test-capable preset. A
    // read-only reviewer cannot execute `node --test` (EPERM on mkdtemp in
    // TMPDIR), so it could not re-run the checks the gate depends on. The brief
    // forbids editing the change under review and the verdict postcondition audits
    // the outcome; the preset never becomes danger-full-access.
    if (ticket.column === 'review') return reviewAccessSandbox();
    if (role === 'sre' && /deploy|production|release|infra|cluster|kubernetes/i.test(`${ticket.title} ${ticket.description} ${ticket.labels.join(' ')}`)) {
      return 'workspace-write';
    }
    return 'workspace-write';
  }

  function suggestedAccessMode(ticket, role, options = accessOptions(), presets = ctx.get('permissionPresets')) {
    const sandbox = suggestedAccessSandbox(ticket, role);
    const match = options.find((option) => accessSandbox(option.value, presets) === sandbox) ?? options.find((option) => option.value === sandbox);
    return match ? match.value : (options[0] ? options[0].value : 'workspace-write');
  }

  function accessSuggestions() {
    const presets = ctx.get('permissionPresets');
    const options = accessOptions();
    const suggestions = {};
    for (const column of COLUMN_IDS) {
      const sandbox = column === 'review' ? reviewAccessSandbox() : column === 'backlog' || column === 'done' ? 'read-only' : 'workspace-write';
      const match = options.find((option) => accessSandbox(option.value, presets) === sandbox) ?? options.find((option) => option.value === sandbox) ?? options[0];
      suggestions[column] = match ? match.value : 'workspace-write';
    }
    return suggestions;
  }

  function suggestAgentForRole(board, role) {
    // Only a roster member's current session is a candidate; arbitrary historical
    // sessions are not people and must never be suggested as the next owner.
    let best = null;
    for (const member of board.team.members) {
      if (member.roleId !== role || member.paused === true || !member.sessionId) continue;
      const sessionId = member.sessionId;
      // A stored conversation is not an assignable agent; only a live session of
      // the member may be suggested as the next owner.
      if (liveAgentStatus(sessionId) === null) continue;
      const busy = board.tickets.some(
        (ticket) =>
          ticket.owner?.sessionId === sessionId &&
          (ticket.column === 'in_progress' || ticket.column === 'review') &&
          ticket.execution?.status === 'running',
      );
      if (busy) continue;
      const candidate = { agentSessionId: sessionId, agentName: member.name };
      if (!best || candidate.agentName.localeCompare(best.agentName) < 0) best = candidate;
    }
    return best;
  }

  /** Assign the next lane's most suitable role (and idle agent when one exists). */
  function applyAutoAssignment(board, ticket, to, reason) {
    if (to === 'done' || to === 'in_progress') {
      ticket.assignment = null;
      return;
    }
    const role = handoffRoleFor(ticket, to);
    if (!role) {
      ticket.assignment = null;
      return;
    }
    const suggestion = suggestAgentForRole(board, role);
    const member = board.team.members.find(
      (candidate) => candidate.roleId === role && !candidate.paused && !memberTicket(board, candidate),
    );
    ticket.assignment = {
      role,
      accessMode: suggestedAccessMode(ticket, role),
      agentSessionId: suggestion?.agentSessionId ?? null,
      agentName: suggestion?.agentName ?? null,
      memberId: suggestion ? null : (member?.id ?? null),
      auto: true,
      reason: reason || `Next lane ${LANE_LABEL[to]} needs ${ROLE_INDEX[role]?.name ?? role}`,
      at: now(),
    };
    pushTicketActivity(
      ticket,
      'board',
      'assign',
      `Auto-assigned for ${LANE_LABEL[to]}: ${suggestion?.agentName ?? ROLE_INDEX[role]?.name ?? role}${suggestion ? '' : ' (role)'}`,
    );
  }

  function executionSuccessColumns(startColumn) {
    return EXECUTION_SUCCESS_COLUMNS[startColumn] ?? [nextLaneFor(startColumn)];
  }

  function nextLaneFor(column) {
    return { backlog: 'ready', ready: 'in_progress', in_progress: 'review', review: 'done', done: 'done' }[column] ?? column;
  }

  /** Board facts the refine brief needs (KB-71 AC 1): vision, Ready depth, ceiling. */
  function refineContextFor(board) {
    const vision = typeof board?.meta?.vision === 'string' ? board.meta.vision.trim() : '';
    return {
      vision: vision ? vision.slice(0, 1200) : null,
      readyDepth: Array.isArray(board?.tickets)
        ? board.tickets.filter((ticket) => ticket.column === 'ready').length
        : 0,
      readyCeiling: effectiveMaxReadyDepth(board?.autopilot),
    };
  }

  /**
   * The refine-lane brief (KB-71 AC 1/AC 2). Appended to the execution prompt for
   * a Backlog ticket, it is the PM's whole contract for this lane: research the
   * gaps, improve the ticket, claim it; or leave it in Backlog and block on the
   * exact missing fact. The Definition of Ready checklist is included verbatim so
   * the brief and the board policy cannot drift.
   */
  function refineBriefLines(ticket, context) {
    const vision = context && typeof context.vision === 'string' && context.vision.trim() ? context.vision.trim() : '';
    const readyDepth = Number.isInteger(context?.readyDepth) ? context.readyDepth : 0;
    const readyCeiling = Number.isInteger(context?.readyCeiling)
      ? context.readyCeiling
      : effectiveMaxReadyDepth(null);
    const claim = `{"action":"claim","ticketId":"${ticket.id}"}`;
    const block = `{"action":"block","ticketId":"${ticket.id}","text":"<the exact missing fact>","questions":["<the exact missing fact>"]}`;
    return [
      '## Refinement brief — autopilot refine lane',
      `This Backlog ticket is being refined by the autopilot refine lane. Ready depth: ${readyDepth} of maxReadyDepth ${readyCeiling}. A refine dispatch is admitted only while Ready depth is below that ceiling; reaching it is a reason to stop refining, never a reason to skip the checklist below.`,
      'Project vision excerpt:',
      vision
        ? vision
        : 'No vision recorded for this project. Do not invent a vision: if the outcome depends on one, record the gap and block on it.',
      '',
      '### Definition of Ready — the gate (use this checklist verbatim)',
      ...DEFINITION_OF_READY.map((item) => `- ${item}`),
      '',
      '### What to do',
      '1. Research the missing facts you need to make the ticket Ready (the codebase, the project docs, the repository, and public sources). Record the sources you used — a URL, a file path, or file:line — in a "Research sources" section of the description or in a ticket comment. A fact with no source is still missing.',
      '2. Do not invent scope. Every new requirement, behaviour, or acceptance criterion must come from the project vision, the existing ticket, the repository, or a recorded source. If you cannot source it, it is not yours to add: keep the scope as it is.',
      '3. Improve the ticket with the kanban tool (`update`): a clearer outcome and description, a numbered "## Acceptance criteria" section (that exact heading — the host checks for it), the owning role, priority, labels, dependencies, and the write scope. The refine postcondition when you finish requires the ticket to be in Ready with role and priority set and an "Acceptance criteria" section in the description.',
      `4. Record the decisions and the research sources as a ticket comment, then claim the ticket when — and only when — every Definition of Ready item above is met: ${claim} moves it Backlog → Ready. Claiming is your finish line for this lane; do not start implementing the work.`,
      '',
      '### Stop condition — when the Definition of Ready cannot be met',
      `If you cannot meet every item above without inventing scope, do NOT claim and do NOT move the ticket. Leave it in Backlog, add a comment naming the unmet checklist item and what is missing, then call ${block} with the exact missing fact as the question and STOP. Do not guess, do not widen the scope to make it Ready, and do not retry: the pulse records the deferral and waits until the block is answered.`,
    ];
  }

  /**
   * One `## <heading>` section of a ticket description, verbatim (heading line
   * included), or null when the section is absent. The briefs quote the ticket
   * rather than paraphrasing it, so the acceptance criteria and the evidence plan
   * cannot drift from the ticket a reviewer reads.
   */
  // The briefs quote a ticket section verbatim; the parser is shared with the
  // pure review postcondition so both read the same acceptance criteria.
  const descriptionSection = descriptionSectionOf;

  /** Board/ticket facts the implement brief needs (KB-72 AC 1/AC 5). */
  function implementContextFor(ticket, options = {}) {
    const execution =
      options.previousExecution && typeof options.previousExecution === 'object'
        ? options.previousExecution
        : ticket?.execution && typeof ticket.execution === 'object'
          ? ticket.execution
          : null;
    const handoffReason =
      typeof options.handoffReason === 'string' && options.handoffReason.trim() ? options.handoffReason.trim() : null;
    return {
      acceptanceCriteria: descriptionSection(ticket?.description, /^acceptance criteria\b/i),
      evidencePlan: descriptionSection(ticket?.description, /^evidence plan\b/i),
      previousReport: clampString(execution?.report, 1200) || null,
      previousError: clampString(execution?.error, 1200) || null,
      previousStatus: typeof execution?.status === 'string' ? execution.status : null,
      handoffReason,
    };
  }

  /**
   * The implement-lane brief (KB-72 AC 1/AC 5). Appended to every Ready dispatch,
   * it is the implementer's contract for the lane: the ticket's acceptance
   * criteria and evidence plan verbatim, what the previous attempt reported, and
   * the exact exit path (claim Ready → In Progress, implement, move to Review,
   * finish). Nothing here restates the host contract: the ticket is the source.
   */
  function implementBriefLines(ticket, context) {
    const claim = `{"action":"claim","ticketId":"${ticket.id}"}`;
    const finish = `{"action":"finish","ticketId":"${ticket.id}","summary":"<what changed, the commands you ran, and the evidence>"}`;
    const block = `{"action":"block","ticketId":"${ticket.id}","text":"<the exact missing fact>","questions":["<the exact missing fact>"]}`;
    const acceptance = context?.acceptanceCriteria;
    const evidence = context?.evidencePlan;
    const previous = [];
    if (context?.previousStatus) {
      previous.push(`Previous execution status: ${context.previousStatus}.`);
    }
    if (context?.previousReport) {
      previous.push('Previous agent report (verbatim):', context.previousReport);
    }
    if (context?.previousError) {
      previous.push('Previous execution error (verbatim):', context.previousError);
    }
    return [
      '## Implementation brief — autopilot implement lane',
      `This Ready ticket is being pulled by the autopilot implement lane. Claim it (${claim} moves Ready → In Progress), implement the ticket, and hand it to the review gate by moving it exactly one column to Review. The implement postcondition when your turn ends requires the ticket to be in In Progress or Review: a ticket still in Ready means the pull never happened and the pulse records a failed postcondition.`,
      '',
      '### Acceptance criteria — the finish line (verbatim from the ticket)',
      acceptance || 'The ticket has no "Acceptance criteria" section. Do not invent one: comment the gap, block with the exact missing fact, and stop.',
      '',
      '### Evidence plan — what to attach (verbatim from the ticket)',
      evidence || 'The ticket has no "Evidence plan" section. Record the checks you ran and the output you captured as a ticket comment; do not claim evidence you did not produce.',
      '',
      '### Previous execution',
      previous.length > 0 ? previous.join('\n') : 'This is the first autopilot dispatch of this ticket; there is no previous execution report.',
      '',
      '### Handoff',
      context?.handoffReason
        ? `Handoff reason (verbatim): ${context.handoffReason}`
        : 'No handoff was recorded: this ticket is pulled directly from Ready.',
      '',
      '### What to do',
      `1. Call ${claim} to claim the ticket; the claim is the signal that you are acting on it (Ready → In Progress).`,
      '2. Read the ticket, its acceptance criteria and its write scope. Implement only what the criteria ask for, inside the write scope. Do not widen the scope to make the criteria pass.',
      '3. Run the checks and tests the ticket names (or the repository checks for the files you touch) and keep the real output for the report.',
      '4. Record the evidence on the ticket with a comment: the commands, the results, and any follow-ups you consciously deferred.',
      '5. Move the ticket exactly one column: In Progress → Review. Never skip the review gate and never move it backwards.',
      `6. Call ${finish} and stop. The report must say what changed, the checks you ran, and what you deferred.`,
      '',
      '### Stop condition',
      `If a fact only the user can supply blocks the work, do not guess and do not improvise scope. Comment the exact missing fact, call ${block}, leave the ticket in In Progress, and STOP. A blocked ticket is deferred by the pulse, not counted as a failed postcondition.`,
    ];
  }

  /** Ticket/execution facts the review brief needs (KB-73 AC 2). */
  function reviewContextFor(ticket, options = {}) {
    const execution =
      options.previousExecution && typeof options.previousExecution === 'object'
        ? options.previousExecution
        : ticket?.execution && typeof ticket.execution === 'object'
          ? ticket.execution
          : null;
    const previousOwnerName =
      typeof options.previousOwnerName === 'string' && options.previousOwnerName
        ? options.previousOwnerName
        : null;
    const evidenceComments = (Array.isArray(options.previousComments) ? options.previousComments : [])
      .filter((comment) => previousOwnerName && comment?.author === previousOwnerName)
      .slice(-6)
      .map((comment) => clampString(comment.text, 400))
      .filter(Boolean);
    return {
      acceptanceCriteria: descriptionSectionOf(ticket?.description, /^acceptance criteria\b/i),
      evidencePlan: descriptionSectionOf(ticket?.description, /^evidence plan\b/i),
      criteriaRefs: acceptanceCriteriaRefs(ticket?.description),
      implementerReport: clampString(execution?.report, 2000) || null,
      implementerError: clampString(execution?.error, 1200) || null,
      implementerName: previousOwnerName,
      implementerStatus: typeof execution?.status === 'string' ? execution.status : null,
      evidenceComments,
      accessPolicy: REVIEW_ACCESS_POLICY,
      accessSandbox: reviewAccessSandbox(),
    };
  }

  /**
   * The review-lane brief (KB-73 AC 2/AC 4/AC 5). Appended to every Review
   * dispatch, it is the reviewer's whole contract for the lane: the acceptance
   * criteria and evidence plan verbatim, what the implementer reported and
   * recorded as evidence, the exact structured verdict to record, the accept and
   * change-request exits, and the access rule that the reviewer verifies but does
   * not author the change under review.
   */
  function reviewBriefLines(ticket, context) {
    const record = `{"action":"review","ticketId":"${ticket.id}","verdict":"accepted","notes":"<why>","criteria":[{"ref":"1","passed":true,"note":"<what you checked>"}],"evidence":["node --test tests/<suite>.test.mjs"]}`;
    const recordChanges = `{"action":"review","ticketId":"${ticket.id}","verdict":"changes-requested","notes":"<the blocking defect, with file:line and what to change>","criteria":[{"ref":"1","passed":false,"note":"<the blocking defect>"}],"evidence":["<the failing command or artifact>"]}`;
    const accept = `{"action":"move","ticketId":"${ticket.id}","column":"done"}`;
    const handback = `{"action":"move","ticketId":"${ticket.id}","column":"in_progress"}`;
    const finish = `{"action":"finish","ticketId":"${ticket.id}","summary":"<verdict, what you re-ran, and the evidence>"}`;
    const block = `{"action":"block","ticketId":"${ticket.id}","text":"<the exact missing fact>","questions":["<the exact missing fact>"]}`;
    const refs = Array.isArray(context?.criteriaRefs) ? context.criteriaRefs : [];
    const rubric = refs.length
      ? refs.map((ref) => `${ref.ref}. ${ref.text}`).join('\n')
      : 'The ticket has no numbered acceptance criteria. Do not invent any: comment the gap and block on the exact missing fact.';
    const evidenceRows = [];
    if (context?.evidencePlan) evidenceRows.push(context.evidencePlan);
    if (Array.isArray(context?.evidenceComments) && context.evidenceComments.length > 0) {
      evidenceRows.push('Implementer evidence comments (verbatim):', ...context.evidenceComments.map((text) => `- ${text}`));
    }
    const implementer = [];
    if (context?.implementerStatus) implementer.push(`Implementer execution status: ${context.implementerStatus}.`);
    if (context?.implementerName) implementer.push(`Implementer: ${context.implementerName}.`);
    if (context?.implementerReport) {
      implementer.push('Implementer report (verbatim):', context.implementerReport);
    } else {
      implementer.push('The implementation execution left no written report. Treat a missing report as a verification gap, not as evidence.');
    }
    if (context?.implementerError) {
      implementer.push('Implementer execution error (verbatim):', context.implementerError);
    }
    return [
      '## Review brief — autopilot review lane',
      `This ticket is in Review and you are the separate review gate. Verify the written change against the acceptance criteria and record a structured verdict, then move the ticket. The review postcondition when your turn ends requires a recorded verdict plus the ticket moved to its verdict lane: a Done without an accepted verdict, or an unmoved ticket, records postcondition-failed — never a silent acceptance.`,
      '',
      '### Access policy (KB-73 decision)',
      `Your session runs the test-capable preset (sandbox: ${context?.accessSandbox ?? reviewAccessSandbox()}, policy: ${context?.accessPolicy ?? REVIEW_ACCESS_POLICY}) because a read-only sandbox cannot execute the repository test harness (node --test fails with EPERM on mkdtemp in TMPDIR). That exception is only for running tests and writing temporary artifacts. Do NOT edit the change under review: no source, test, documentation, or persisted-board edits. You verify and judge; you do not author. Never request danger-full-access.`,
      '',
      '### Acceptance criteria — the rubric (verbatim from the ticket)',
      context?.acceptanceCriteria ||
        'The ticket has no "Acceptance criteria" section. Do not invent one: comment the gap, block with the exact missing fact, and stop.',
      '',
      '### Numbered criteria to map in the verdict',
      rubric,
      '',
      '### Implementer report and execution',
      implementer.join('\n'),
      '',
      '### Evidence list — what to re-run or inspect',
      evidenceRows.length > 0
        ? evidenceRows.join('\n')
        : 'No evidence plan or implementer evidence comment was recorded. Re-run the checks you can find, and treat the gap as a finding.',
      '',
      '### Record the verdict (required before moving)',
      `Accepted (every numbered criterion passed): ${record}`,
      `Changes requested (at least one blocking note + at least one passed:false criterion): ${recordChanges}`,
      'The host validates the verdict: an accepted verdict must map every numbered criterion as passed, and a change request must carry a blocking note and a failed criterion. The verdict is persisted in ticket.reviews, so it survives the move and the finish summary being overwritten.',
      '',
      '### Exit paths',
      `- Accept: record the accepted verdict, then move Review → Done: ${accept}. Move only after the verdict is recorded; the host rejects a Done without an accepted verdict.`,
      `- Request changes: record the changes-requested verdict, then move Review → In Progress: ${handback}. Review → Ready does not exist in the board policy and is rejected as a policy error; the host assigns the implementation role for the handback.`,
      `- Then call ${finish} and stop.`,
      '',
      '### Stop condition',
      `If a fact only the user can supply blocks verification, do not guess and do not accept. Comment the exact missing fact, call ${block}, leave the ticket in Review, and STOP. A blocked review is deferred by the pulse, not counted as a failed postcondition.`,
    ];
  }

  /**
   * The lane brief for a dispatch, chosen by the ticket's column. Keeping the
   * selection in one place means the start and resume prompts can never disagree
   * about which lane contract applies.
   */
  function executionLaneContext(board, ticket, options = {}) {
    // KB-74: the handoff context pack is composed for every lane and every
    // dispatch mode, once, from the persisted ticket plus the pre-dispatch
    // execution row the caller captured. A resume passes no previous row and the
    // pack falls back to the current (idle) row, so it re-reads current state.
    const handoffContext = composeHandoffContext(ticket, options.previousExecution ?? null);
    const withHandoff = (laneContext) => ({ ...laneContext, handoffContext });
    if (ticket.column === 'backlog') return withHandoff({ lane: 'refine', ...refineContextFor(board) });
    if (ticket.column === 'ready') {
      return withHandoff({
        lane: 'implement',
        ...implementContextFor(ticket, {
          handoffReason: options.handoff?.reason,
          previousExecution: options.previousExecution ?? null,
        }),
      });
    }
    if (ticket.column === 'review') {
      return withHandoff({
        lane: 'review',
        ...reviewContextFor(ticket, {
          previousExecution: options.previousExecution ?? null,
          previousOwnerName: options.previousOwnerName ?? null,
          previousComments: options.previousComments ?? [],
        }),
      });
    }
    return null;
  }

  function executionPrompt(ticket, project, role, mode, member = null, laneContext = null) {
    const roleName = ROLE_INDEX[role]?.name ?? role;
    const composition = composeAgentPrompt({ role: ROLE_INDEX[role] ?? role, member: member ?? null });
    // KB-74 AC 1/AC 2: every dispatch brief (refine, implement, review, resume,
    // manual handoff) carries the same bounded handoff context pack. The lane
    // context pre-composes it with the pre-dispatch execution row; an unlaned
    // dispatch falls back to the persisted ticket so no mode is left without one.
    const handoffContext = laneContext?.handoffContext ?? composeHandoffContext(ticket, null);
    const checklist = safeArray(ticket.checklist)
      .map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`)
      .join('\n');
    const comments = safeArray(ticket.comments)
      .slice(-4)
      .map((comment) => `- ${comment.author}: ${String(comment.text).slice(0, 400)}`)
      .join('\n');
    const lane =
      ticket.column === 'backlog'
        ? 'You are refining this Backlog ticket. Make it Ready: clarify outcome, acceptance criteria, scope, role and dependencies, edit the ticket, then move it to Ready.'
        : ticket.column === 'ready'
          ? 'Claim this Ready ticket (it moves to In Progress), implement/complete it, then move it to Review.'
          : ticket.column === 'review'
            ? 'You are the review gate. Verify the change against the written acceptance criteria, re-run the checks, record a structured verdict (action "review"), then move Review → Done (accepted) or Review → In Progress (changes-requested). You verify rather than author: do not edit the change under review.'
            : 'Continue this ticket from its current lane.';
    return [
      `# Kanban execution — ${ticket.id} · ${ticket.title}`,
      `Project: ${project.title} (${project.path})`,
      member
        ? `Role: ${roleName}. Team member: ${member.name}${member.title ? ` — ${member.title}` : ''}. You own ONLY this ticket; the kanban tool is scoped to it.`
        : `Role: ${roleName}. You own ONLY this ticket; the kanban tool is scoped to it.`,
      composition ? `\n${composition}` : '',
      '',
      '## Ticket',
      `Lane: ${LANE_LABEL[ticket.column]}. Type: ${ticket.type}. Priority: ${ticket.priority}. Labels: ${ticket.labels.length ? ticket.labels.join(', ') : 'none'}.`,
      `Role required: ${ticket.role ? ROLE_INDEX[ticket.role]?.name ?? ticket.role : 'any fitting role'}.`,
      '',
      `Description:\n${ticket.description || '(no description)'}`,
      checklist ? `\nChecklist:\n${checklist}` : '',
      handoffContext.text ? `\n${handoffContext.text}` : '',
      comments ? `\nRecent comments:\n${comments}` : '',
      ticket.source ? `\nSource: ${ticket.source.kind} ${ticket.source.ref}${ticket.source.url ? ` ${ticket.source.url}` : ''}` : '',
      ...(laneContext?.lane === 'refine' ? ['', ...refineBriefLines(ticket, laneContext)] : []),
      ...(laneContext?.lane === 'implement' ? ['', ...implementBriefLines(ticket, laneContext)] : []),
      ...(laneContext?.lane === 'review' ? ['', ...reviewBriefLines(ticket, laneContext)] : []),
      '',
      '## How to work',
      '1. Load the `kanban-workflow` skill with the skill tool.',
      `2. Call the kanban tool: {"action":"whoami"} to confirm scope, then {"action":"claim","ticketId":"${ticket.id}"} if you do not own it yet. Execution sessions are authorized to claim and advance THIS ticket along its lane path even when the generic role matrix would not allow it.`,
      `3. ${lane}`,
      '4. Keep changes inside the project directory and limited to this ticket. Do not touch other tickets, branches, deployments, or user data.',
      '5. Record evidence on the ticket: comment decisions/results, tick checklist items.',
      '6. If you need a user decision, permission, credential, or any external input, call {"action":"block","ticketId":"' + ticket.id + '","text":"reason","questions":["..."],"needs":[{"kind":"permission","text":"..."}]} and STOP. The user answers from the Kanban board; the session resumes automatically.',
      `7. When the ticket is in an accepted lane, call {"action":"finish","ticketId":"${ticket.id}","summary":"what changed, evidence, follow-ups"} and STOP.`,
      '',
      '## Constraints',
      '- One ticket in flight; never move other tickets; never skip a lane; respect WIP and role gates.',
      '- The board may be paused by the user; if a tool call is rejected, stop and report.',
      '- Finish only after the ticket has advanced to a sensible next lane (Review normally; Done for a review gate; Ready for backlog refinement).',
      '- Work only from the ticket context above. Do not inspect or modify the Harness installation, other plugins, or unrelated project files.',
    ].filter(Boolean).join('\n');
  }

  async function promptSession(sessionId, text) {
    await ctx.sessionController.prompt(
      {
        requestId: `kanban-${uid()}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      },
      AbortSignal.timeout(30000),
    );
  }

  function executionSummary(board) {
    const summary = { running: 0, idle: 0, blocked: 0, paused: 0, done: 0, failed: 0, cancelled: 0 };
    for (const ticket of board.tickets) {
      const status = ticket.execution?.status;
      if (status && summary[status] !== undefined) summary[status] += 1;
      if (ticket.blocked) summary.blocked += 1;
    }
    return summary;
  }

  // -- autopilot config, budget and read model (KB-68) ---------------------

  /** Public config view (AC 1/AC 2): flat budget limits, no counters or envelope fields. */
  function autopilotConfigView(autopilot) {
    return {
      enabled: autopilot.enabled,
      cadenceMs: autopilot.cadenceMs,
      maxReadyDepth: autopilot.maxReadyDepth,
      laneCaps: {
        refine: autopilot.laneCaps.refine,
        implement: autopilot.laneCaps.implement,
        review: autopilot.laneCaps.review,
      },
      maxDispatchesPerPulse: autopilot.maxDispatchesPerPulse,
      budget: { hour: autopilot.budget.hour.limit, day: autopilot.budget.day.limit },
      backoffMs: autopilot.backoffMs,
      staleMs: autopilot.staleMs,
    };
  }

  /**
   * Effective budget window at `at` (AC 5). Expiry rolls over lazily in the read
   * model and is never written by a read; a started window reports its reset time
   * (`windowStart + period`) while an unused window starts counting from `at`.
   */
  function autopilotBudgetUnit(window, unit, at) {
    const period = unit === 'hour' ? AUTOPILOT_HOUR_MS : AUTOPILOT_DAY_MS;
    const started = Number.isFinite(window.windowStart) && window.windowStart > 0;
    const expired = started && (at - window.windowStart >= period || at < window.windowStart);
    const active = started && !expired;
    const windowStart = active ? window.windowStart : at;
    const used = active ? window.used : 0;
    return {
      limit: window.limit,
      used,
      remaining: Math.max(0, window.limit - used),
      resetsAt: windowStart + period,
    };
  }

  function autopilotBudgetRemaining(autopilot, at) {
    return {
      hour: autopilotBudgetUnit(autopilot.budget.hour, 'hour', at),
      day: autopilotBudgetUnit(autopilot.budget.day, 'day', at),
    };
  }

  /**
   * KB-75 AC 1: the manual-pulse refusal. Returns `null` while either window has
   * allowance, otherwise the exhausted units plus the exact retry-after hint (the
   * soonest window reset, rounded up to whole seconds). A manual pulse is an
   * autopilot action, so it is refused with `429 autopilot/budget` instead of
   * running a pulse that can only record `budget-exhausted`.
   */
  function autopilotBudgetRefusal(autopilot, at) {
    rollAutopilotBudget(autopilot, at);
    const windows = autopilotBudgetRemaining(autopilot, at);
    const exhausted = [];
    if (windows.hour.remaining <= 0) exhausted.push({ unit: 'hour', ...windows.hour });
    if (windows.day.remaining <= 0) exhausted.push({ unit: 'day', ...windows.day });
    if (exhausted.length === 0) return null;
    const resetsAt = Math.min(...exhausted.map((window) => window.resetsAt));
    return {
      reason: 'budget-exhausted',
      windows: exhausted.map((window) => window.unit),
      resetsAt,
      retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - at) / 1000)),
      budget: {
        hour: { used: windows.hour.used, limit: windows.hour.limit },
        day: { used: windows.day.used, limit: windows.day.limit },
      },
    };
  }

  /** Trailing streak of pulse records that ended with an executor error. */
  function autopilotConsecutiveErrors(pulses) {
    let count = 0;
    for (const pulse of pulses) {
      if (!pulse.error) break;
      count += 1;
    }
    return count;
  }

  /**
   * Derived countdown to the next scheduled pulse. Never persisted and null when
   * autopilot is disabled or its envelope version is unknown. A consecutive-error
   * streak uses the exponential backoff instead of the cadence.
   */
  function autopilotNextTickAt(autopilot, pulses, at) {
    if (autopilot.version !== AUTOPILOT_VERSION || !autopilot.enabled) return null;
    const base = Number.isFinite(pulses[0]?.at) ? pulses[0].at : at;
    const errors = autopilotConsecutiveErrors(pulses);
    if (errors === 0) return base + autopilot.cadenceMs;
    const delay = Math.min(autopilot.backoffMs * 2 ** (errors - 1), AUTOPILOT_MAX_BACKOFF_MS);
    // Backoff never runs ahead of the cadence (KB-67 §6.7): a failed pulse waits
    // at least one cadence, then the exponential delay once it is longer.
    return base + Math.max(autopilot.cadenceMs, delay);
  }

  /** Derived, never-persisted autopilot object exposed by the snapshot (AC 6). */
  function autopilotReadModel(board, at) {
    // Prefer the timer the host actually armed: after a board resume it is the
    // truth, while the purely derived value is a fallback for a fresh process.
    const armed = autopilotArmedAt(String(board.workspaceId));
    return {
      config: autopilotConfigView(board.autopilot),
      nextTickAt: armed !== null ? armed : autopilotNextTickAt(board.autopilot, board.pulses, at),
      lastPulse: board.pulses.length > 0 ? board.pulses[0] : null,
      pulseCount: board.pulses.length,
      budgetRemaining: autopilotBudgetRemaining(board.autopilot, at),
    };
  }

  /** The `{op:'status'}` body: exactly `{config, nextTickAt, lastPulse, budgetRemaining}` (AC 2). */
  function autopilotStatus(board, at) {
    const model = autopilotReadModel(board, at);
    return {
      config: model.config,
      nextTickAt: model.nextTickAt,
      lastPulse: model.lastPulse,
      budgetRemaining: model.budgetRemaining,
    };
  }

  function invalidAutopilot(message) {
    return new ApiError(400, 'autopilot/invalid', message);
  }

  /** Validate one configure number against its bound; throws before any write. */
  function readAutopilotWrite(value, spec, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidAutopilot(`${label} must be a finite number.`);
    }
    if (spec.integer && !Number.isInteger(value)) {
      throw invalidAutopilot(`${label} must be an integer.`);
    }
    if (value < spec.min || value > spec.max) {
      throw invalidAutopilot(`${label} must be between ${spec.min} and ${spec.max}.`);
    }
    return value;
  }

  /**
   * Validate a `configure` patch (AC 2). Complete validation happens before the
   * board is touched: any unknown field, wrong type or out-of-range value throws
   * `400 autopilot/invalid` and the persisted board stays byte-identical.
   */
  function parseAutopilotPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw invalidAutopilot('patch must be an object.');
    }
    const unknown = Object.keys(patch).filter((key) => !AUTOPILOT_CONFIG_FIELDS.includes(key));
    if (unknown.length > 0) throw invalidAutopilot(`Unknown autopilot field(s): ${unknown.join(', ')}.`);
    const parsed = {};
    if ('enabled' in patch) {
      if (typeof patch.enabled !== 'boolean') throw invalidAutopilot('enabled must be a literal boolean.');
      parsed.enabled = patch.enabled;
    }
    for (const [field, spec] of Object.entries(AUTOPILOT_WRITE_NUMBERS)) {
      if (field in patch) parsed[field] = readAutopilotWrite(patch[field], spec, field);
    }
    if ('laneCaps' in patch) {
      const caps = patch.laneCaps;
      if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
        throw invalidAutopilot('laneCaps must be an object.');
      }
      const unknownLanes = Object.keys(caps).filter((lane) => !AUTOPILOT_LANES.includes(lane));
      if (unknownLanes.length > 0) throw invalidAutopilot(`Unknown laneCap(s): ${unknownLanes.join(', ')}.`);
      parsed.laneCaps = {};
      for (const lane of AUTOPILOT_LANES) {
        if (lane in caps) parsed.laneCaps[lane] = readAutopilotWrite(caps[lane], AUTOPILOT_BOUNDS.laneCap, `laneCaps.${lane}`);
      }
    }
    if ('budget' in patch) {
      const budget = patch.budget;
      if (!budget || typeof budget !== 'object' || Array.isArray(budget)) {
        throw invalidAutopilot('budget must be an object.');
      }
      const unknownBudget = Object.keys(budget).filter((unit) => unit !== 'hour' && unit !== 'day');
      if (unknownBudget.length > 0) throw invalidAutopilot(`Unknown budget field(s): ${unknownBudget.join(', ')}.`);
      parsed.budget = {};
      if ('hour' in budget) parsed.budget.hour = readAutopilotWrite(budget.hour, AUTOPILOT_BOUNDS.budgetHour, 'budget.hour');
      if ('day' in budget) parsed.budget.day = readAutopilotWrite(budget.day, AUTOPILOT_BOUNDS.budgetDay, 'budget.day');
    }
    return parsed;
  }

  /** Roll persisted counters over on a write path when their window elapsed (AC 5). */
  function rollAutopilotBudget(autopilot, at) {
    let changed = false;
    for (const unit of ['hour', 'day']) {
      const period = unit === 'hour' ? AUTOPILOT_HOUR_MS : AUTOPILOT_DAY_MS;
      const window = autopilot.budget[unit];
      if (window.windowStart <= 0) continue;
      if (at - window.windowStart >= period || at < window.windowStart) {
        window.used = 0;
        window.windowStart = at;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Apply an already-validated patch. Budget `used`/`windowStart` survive a
   * configuration write unless the window rolled over (AC 5); a reduced limit
   * caps the already-spent count so `used <= limit` stays true.
   */
  function applyAutopilotPatch(autopilot, patch, at, actor) {
    if (patch.enabled !== undefined) autopilot.enabled = patch.enabled;
    for (const field of Object.keys(AUTOPILOT_WRITE_NUMBERS)) {
      if (patch[field] !== undefined) autopilot[field] = patch[field];
    }
    if (patch.laneCaps) Object.assign(autopilot.laneCaps, patch.laneCaps);
    if (patch.budget) {
      if (patch.budget.hour !== undefined) {
        autopilot.budget.hour.limit = patch.budget.hour;
        autopilot.budget.hour.used = Math.min(autopilot.budget.hour.used, patch.budget.hour);
      }
      if (patch.budget.day !== undefined) {
        autopilot.budget.day.limit = patch.budget.day;
        autopilot.budget.day.used = Math.min(autopilot.budget.day.used, patch.budget.day);
      }
    }
    autopilot.version = AUTOPILOT_VERSION;
    autopilot.updatedAt = Number.isFinite(at) ? at : now();
    autopilot.updatedBy = clampString(actor, 80) || 'system';
  }

  async function actionAutopilot({ workspaceId, payload }) {
    const op = typeof payload?.op === 'string' ? payload.op.trim() : '';
    // KB-70 manual pulse: one immediate pulse through the same planner, budget,
    // caps, mutex and dispatch path as a timer pulse (KB-67 §5.7 / §6.7). It is
    // rejected with 409 `autopilot/pulsing` while another pulse is running.
    if (op === 'pulseNow') {
      if (autopilotPulseInFlight(workspaceId)) {
        throw new ApiError(409, 'autopilot/pulsing', 'A pulse is already running for this project. Retry when it finishes.');
      }
      // KB-75 AC 1: a manual pulse is an autopilot dispatch, so an exhausted
      // hourly/day window refuses it with `429 autopilot/budget` and a retry-after
      // hint instead of running a pulse that can only record `budget-exhausted`.
      // A disabled board still gets the recorded `disabled` no-op pulse below.
      // Read-only precheck: `store.peek` normalizes in memory without creating a
      // board file for a project that has none (the pulse itself decides whether
      // the project exists).
      const budgetBoard = await store.peek(projectFor(workspaceId));
      const budgetAt = clock();
      if (autopilotEnabled(budgetBoard)) {
        const refusal = autopilotBudgetRefusal(budgetBoard.autopilot, budgetAt);
        if (refusal) {
          throw new ApiError(
            429,
            'autopilot/budget',
            `The autopilot dispatch budget is exhausted (${refusal.windows.join(' and ')} window${refusal.windows.length === 1 ? '' : 's'}); try again in ${refusal.retryAfterSeconds} second${refusal.retryAfterSeconds === 1 ? '' : 's'}.`,
            refusal,
          );
        }
      }
      const pulse = await runAutopilotPulse(workspaceId, 'manual');
      return { pulse };
    }
    const { board } = await loadProject(workspaceId);
    const at = clock();
    if (op === 'status') return autopilotStatus(board, at);
    // KB-69 dry-run: run the exact planner an executor runs and return its plan.
    // Read-only: no board mutation, no store.save, no budget increment, no
    // session creation. It is allowed while disabled/paused so an operator can
    // preview before enabling or resuming (the plan carries the board gate).
    if (op === 'plan') return planPulse(board, board.autopilot, at, liveAgentStatus);
    if (op === 'configure') {
      const patch = parseAutopilotPatch(payload?.patch);
      const rolled = rollAutopilotBudget(board.autopilot, at);
      applyAutopilotPatch(board.autopilot, patch, at, 'You');
      // A no-op configure still persists the synthesized defaults; it only adds
      // an activity row when something actually changed.
      if (Object.keys(patch).length > 0 || rolled) {
        pushBoardActivity(
          board,
          'You',
          'autopilot/configure',
          `Autopilot configured: ${Object.keys(patch).length > 0 ? Object.keys(patch).join(', ') : 'budget window rolled over'}`,
        );
      }
      // KB-70 AC 9: turning the master switch off is a synchronous stop. Record
      // the actor and time, clear this workspace's timer, and leave already
      // running sessions untouched (KB-67 §6.6). Re-enabling re-arms at cadence.
      if (patch.enabled === false) {
        clearAutopilotTimer(String(workspaceId));
        autopilotResumePulses.delete(String(workspaceId));
        pushBoardActivity(
          board,
          'You',
          'autopilot/disabled',
          'Autopilot disabled: no further automatic dispatches; running sessions were left alone.',
        );
      }
      await store.save(board);
      if (autopilotEnabled(board)) {
        armAutopilotTimer(String(workspaceId), at + Math.max(AUTOPILOT_TICK_FLOOR_MS, board.autopilot.cadenceMs));
      } else {
        clearAutopilotTimer(String(workspaceId));
      }
      return autopilotStatus(board, at);
    }
    throw invalidAutopilot(
      `Unknown autopilot op "${op || '(missing)'}"; expected "status", "configure", "plan" or "pulseNow".`,
    );
  }

  // -- autopilot executor and scheduler (KB-70) ----------------------------
  //
  // One host-level scheduler iterates the persisted boards. An enabled board
  // owns exactly one self-rescheduling timeout, armed through `ctx.effect` and
  // cleared by its disposer; a pulse is the only path that starts sessions, and
  // it always goes through `startTicketExecution` (never a second execution
  // pipeline). The clock (`settings.now`) and the timer implementation
  // (`settings.scheduler`) are injectable so a suite can walk a fake timeline
  // without a wall-clock sleep (AC 10).

  const AUTOPILOT_TICK_FLOOR_MS = 1000;
  const schedulerApi = (() => {
    const injected = settings.scheduler;
    if (injected && typeof injected.setTimeout === 'function' && typeof injected.clearTimeout === 'function') {
      return {
        setTimeout: (callback, delay) => injected.setTimeout(callback, delay),
        clearTimeout: (handle) => injected.clearTimeout(handle),
      };
    }
    return {
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (handle) => globalThis.clearTimeout(handle),
    };
  })();
  /** Per-workspace armed timer: `{handle, at}`. */
  const autopilotTimers = new Map();
  /** Per-workspace in-flight pulse promise (the overlap guard). */
  const autopilotPulses = new Map();
  /** Workspaces whose first non-paused pulse after start must recover executions. */
  const autopilotRecovery = new Set();
  /** Workspaces whose next pulse runs with `trigger: 'resume'` after a board resume. */
  const autopilotResumePulses = new Set();
  let autopilotDisposed = false;
  /** Promise for the startup sweep; the returned handle can await it. */
  let autopilotSweepPromise = null;

  function autopilotEnabled(board) {
    return Boolean(board) && board.autopilot?.version === AUTOPILOT_VERSION && board.autopilot.enabled === true;
  }

  /** Effective delay between pulse starts: cadence, or cadence-or-longer backoff. */
  function autopilotDelayMs(board) {
    const errors = autopilotConsecutiveErrors(board.pulses);
    if (errors === 0) return board.autopilot.cadenceMs;
    const delay = Math.min(board.autopilot.backoffMs * 2 ** (errors - 1), AUTOPILOT_MAX_BACKOFF_MS);
    return Math.max(board.autopilot.cadenceMs, delay);
  }

  function clearAutopilotTimer(workspaceId) {
    const entry = autopilotTimers.get(String(workspaceId));
    if (!entry) return;
    autopilotTimers.delete(String(workspaceId));
    try {
      schedulerApi.clearTimeout(entry.handle);
    } catch {
      // the timer handle is a host detail; a failed clear must not break teardown
    }
  }

  /** Arm (or replace) this workspace's single self-rescheduling timeout. */
  function armAutopilotTimer(workspaceId, targetAt) {
    if (autopilotDisposed) return;
    const workspaceKey = String(workspaceId);
    clearAutopilotTimer(workspaceKey);
    const delay = Math.max(AUTOPILOT_TICK_FLOOR_MS, Math.floor(targetAt - clock()));
    const handle = schedulerApi.setTimeout(() => {
      autopilotTimers.delete(workspaceKey);
      // KB-75 AC 6: the production timer callback is fire-and-forget, so a
      // rejected pulse would become an unhandled rejection. The pulse and the
      // timer path are both written to resolve; this guard is the last line of
      // defence and keeps the cadence alive no matter what happens inside.
      try {
        return Promise.resolve(onAutopilotTimer(workspaceKey)).catch(() => undefined);
      } catch {
        return undefined;
      }
    }, delay);
    // Never keep the host process alive merely for a pending pulse.
    try {
      if (handle && typeof handle.unref === 'function') handle.unref();
    } catch {
      // a non-Node timer handle has no unref
    }
    autopilotTimers.set(workspaceKey, { handle, at: targetAt });
  }

  function autopilotArmedAt(workspaceId) {
    const entry = autopilotTimers.get(String(workspaceId));
    return entry && Number.isFinite(entry.at) ? entry.at : null;
  }

  function autopilotPulseInFlight(workspaceId) {
    return autopilotPulses.has(String(workspaceId));
  }

  /**
   * Next pulse target for one board. `fromLoad` implements AC 1 / KB-67 §6.2:
   * `updatedAt + cadenceMs`, or `now + cadenceMs` when the board is already
   * overdue (cadence is a rate, not a queue, so missed intervals are not
   * replayed). The post-pulse re-arm measures from the last stored pulse start.
   */
  function scheduleAutopilotFromBoard(board, { fromLoad = false } = {}) {
    const workspaceKey = String(board.workspaceId);
    if (autopilotDisposed || !autopilotEnabled(board)) {
      clearAutopilotTimer(workspaceKey);
      return null;
    }
    const at = clock();
    const delay = autopilotDelayMs(board);
    const lastAt = Number.isFinite(board.pulses?.[0]?.at) ? board.pulses[0].at : null;
    let target;
    if (board.paused === true) {
      // A paused board keeps its timer armed so resuming needs no human action,
      // but the pulse is a deduped no-op: keep the cadence, never a 1 s loop.
      target = at + delay;
    } else if (fromLoad) {
      const base = Number.isFinite(board.updatedAt) && board.updatedAt > 0 ? board.updatedAt : at;
      target = base + delay;
      if (target <= at) target = at + delay;
    } else if (lastAt !== null) {
      target = lastAt + delay;
      if (target < at + AUTOPILOT_TICK_FLOOR_MS) target = at + AUTOPILOT_TICK_FLOOR_MS;
    } else {
      target = at + delay;
    }
    armAutopilotTimer(workspaceKey, target);
    return target;
  }

  /** Arm an enabled board discovered through any later board load (KB-67 §6.2.2). */
  function noteAutopilotBoard(board) {
    if (autopilotDisposed || !board) return;
    const workspaceKey = String(board.workspaceId);
    if (!autopilotEnabled(board)) {
      clearAutopilotTimer(workspaceKey);
      return;
    }
    if (autopilotTimers.has(workspaceKey) || autopilotPulses.has(workspaceKey)) return;
    scheduleAutopilotFromBoard(board, { fromLoad: true });
  }

  /** Read the board from disk (bypassing the cache) — the pulse's fresh read. */
  async function reloadAutopilotBoard(workspaceId) {
    const project = projectFor(workspaceId);
    store.cache.delete(String(project.id));
    return store.peek(project);
  }

  /** Best-effort `store.save`, used where a failure must not abort the pulse. */
  async function saveAutopilotBoard(board) {
    try {
      await store.save(board);
      return true;
    } catch {
      return false;
    }
  }

  function autopilotLaneForColumn(column) {
    if (column === 'backlog') return 'refine';
    if (column === 'ready' || column === 'in_progress') return 'implement';
    if (column === 'review') return 'review';
    return null;
  }

  function autopilotDecisionRow(entry) {
    const row = {
      ticketId: typeof entry?.ticketId === 'string' && entry.ticketId ? entry.ticketId.slice(0, 40) : null,
      memberId: typeof entry?.memberId === 'string' && entry.memberId ? entry.memberId.slice(0, 80) : null,
      lane: AUTOPILOT_LANES.includes(entry?.lane) ? entry.lane : null,
      action: entry?.action === 'dispatch' ? 'dispatch' : 'skip',
      reason: clampString(entry?.reason, 400) || 'skip',
    };
    // KB-72: an implement dispatch records the arguments the host actually used
    // (role resolve, inference marker, applied access mode) so the capture is a
    // persisted fact rather than something a test has to infer. Key order matches
    // `normalizePulseDecision`, keeping a re-read byte-stable; the fields are
    // present only on the implement lane, so refine/review rows keep their exact
    // KB-69/KB-71 shape and an old pulse still re-reads byte-identically.
    // KB-73: review dispatches also record the resolved role and the applied
    // access mode, so the test-capable access decision is an auditable persisted
    // fact on the pulse rather than something a reviewer has to infer.
    if (entry?.lane === 'implement' || entry?.lane === 'review') {
      if (typeof entry?.role === 'string' && entry.role) row.role = entry.role.slice(0, 40);
      if (entry?.roleInferred === true) row.roleInferred = true;
      if (typeof entry?.accessMode === 'string' && entry.accessMode) row.accessMode = entry.accessMode.slice(0, 60);
    }
    return row;
  }

  function nextAutopilotPulseId(board) {
    let max = 0;
    for (const pulse of board.pulses) {
      const match = /^PL-(\d+)$/.exec(typeof pulse?.id === 'string' ? pulse.id : '');
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `PL-${max + 1}`;
  }

  /** One dispatch = one budget unit, charged in the same board object as the dispatch. */
  function chargeAutopilotBudget(autopilot, at) {
    rollAutopilotBudget(autopilot, at);
    for (const unit of ['hour', 'day']) {
      const window = autopilot.budget[unit];
      if (!Number.isFinite(window.windowStart) || window.windowStart <= 0) window.windowStart = at;
      window.used = Math.min(window.limit, Math.max(0, Math.round(window.used)) + 1);
    }
  }

  /** The effective per-ticket backoff for `attempts` consecutive failures (AC 2). */
  function autopilotTicketBackoffMs(board, attempts) {
    const base = planNumber(board?.autopilot?.backoffMs, AUTOPILOT_BOUNDS.backoffMs.fallback);
    return Math.min(base * 2 ** Math.max(0, attempts - 1), AUTOPILOT_MAX_BACKOFF_MS);
  }

  /**
   * Clear a ticket's consecutive-failure state (KB-75 AC 2/AC 4): a successful
   * dispatch outcome, a human move, a review verdict, a manual dispatch or an
   * unblock all reset the counter and the backoff window. Additive key only: a
   * ticket that never failed keeps no row, so an untouched board writes nothing.
   */
  function resetAutopilotTicketFailure(ticket, reason) {
    if (!ticket || !ticket.autopilot) return false;
    const state = planTicketSafety(ticket);
    if (state.attempts === 0 && state.backoffUntil === 0 && state.lastOutcome === null) return false;
    ticket.autopilot = { ...defaultTicketAutopilotState(), lastDispatchAt: state.lastDispatchAt };
    pushTicketActivity(ticket, 'autopilot', 'tracking-reset', `Autopilot failure counter reset: ${reason}`.slice(0, 300));
    return true;
  }

  /**
   * Count one consecutive autopilot failure on a ticket and enforce the loop
   * guard (KB-75 AC 2/AC 4). One helper for every failure source — a thrown
   * dispatch, a missed lane postcondition and a stale execution — so there is a
   * single counter, a single exponential backoff and a single park decision.
   * At the third consecutive failure the ticket is blocked with
   * `autopilot/loop-guard`, a comment asking the human what to do, and a board
   * activity row; a human unblock resets the counter.
   */
  function recordAutopilotTicketFailure(board, ticket, at, kind, detail, pulse = null) {
    const reason = TICKET_AUTOPILOT_FAILURE_KINDS.includes(kind) ? kind : 'postcondition-failed';
    const previous = planTicketSafety(ticket);
    const attempts = Math.min(TICKET_AUTOPILOT_FAILURES_MAX, previous.attempts + 1);
    const backoffUntil = at + autopilotTicketBackoffMs(board, attempts);
    ticket.autopilot = {
      version: TICKET_AUTOPILOT_VERSION,
      attempts,
      lastFailureAt: at,
      backoffUntil,
      lastDispatchAt: Number.isFinite(previous.lastDispatchAt) && previous.lastDispatchAt > 0 ? previous.lastDispatchAt : at,
      lastOutcome: reason,
    };
    ticket.updatedAt = at;
    if (attempts < AUTOPILOT_LOOP_GUARD_LIMIT || ticket.blocked === true) {
      return { attempts, backoffUntil, loopGuard: false };
    }
    // Loop guard: park the ticket and ask the human, exactly once. The blocked
    // gate in the planner keeps every later pulse away from it until a human
    // moves, unblocks, comments or manually dispatches the ticket.
    const summary = clampString(detail, 400) || `the last autopilot ${reason} attempt failed`;
    const blockReason = `autopilot/loop-guard: ${attempts} consecutive autopilot attempts failed on ${ticket.id} (last: ${reason}). ${summary}`.slice(0, 1000);
    const question = `Autopilot stopped working ${ticket.id} after ${attempts} consecutive failed attempts (last: ${reason}). What should happen next: retry manually, rework the ticket, or close it? Unblocking resets the failure counter.`;
    ticket.blocked = true;
    ticket.blockReason = blockReason;
    ticket.block = {
      reason: blockReason,
      questions: [{ id: uid(), text: question.slice(0, 800), answer: '' }],
      needs: [],
      askedAt: at,
    };
    ticket.comments = Array.isArray(ticket.comments) ? ticket.comments : [];
    ticket.comments.push({
      id: uid(),
      author: 'autopilot',
      text: `[autopilot loop-guard] ${blockReason} ${question}`.slice(0, 1000),
      at,
    });
    ticket.comments = ticket.comments.slice(-100);
    pushTicketActivity(ticket, 'autopilot', 'loop-guard', `Blocked by the loop guard after ${attempts} consecutive failures`);
    pushBoardActivity(board, 'autopilot', 'autopilot/loop-guard', `${ticket.id} blocked by the loop guard: ${summary}`.slice(0, 600), ticket.id);
    if (pulse) {
      pulse.decisions.push(
        autopilotDecisionRow({
          ticketId: ticket.id,
          memberId: ticket.owner?.memberId ?? null,
          lane: autopilotLaneForColumn(ticket.column),
          action: 'skip',
          reason: 'loop-guard',
        }),
      );
    }
    return { attempts, backoffUntil, loopGuard: true };
  }

  /**
   * Rework/recovery bridge for `mode:'handoff'` (KB-69 §13): the board's
   * `startTicketExecution` rejects In Progress, so move the ticket one legal
   * step back to Ready first and let the normal dispatch carry it forward.
   */
  async function autopilotHandoffMove(workspaceId, board, ticketId, at, reason) {
    const ticket = board.tickets.find((entry) => entry.id === ticketId);
    if (!ticket || ticket.column !== 'in_progress' || ticket.type === 'epic' || ticket.blocked === true) {
      return false;
    }
    if (ticket.owner) {
      pushTicketActivity(ticket, 'autopilot', 'unassign', `Unassigned from ${ticket.owner.name} for an autopilot ${reason} dispatch`);
      ticket.owner = null;
    }
    ticket.column = 'ready';
    ticket.acceptedAt = null;
    ticket.movedAt = at;
    ticket.updatedAt = at;
    if (ticket.execution) {
      ticket.execution.updatedAt = at;
      ticket.execution.report = ticket.execution.report || '';
    }
    applyAutoAssignment(board, ticket, 'ready', `Autopilot ${reason} handoff`);
    pushTicketActivity(ticket, 'autopilot', 'move', `in_progress → ready (autopilot ${reason} handoff)`);
    pushBoardActivity(board, 'autopilot', 'autopilot/handoff', `${ticketId}: in_progress → ready for a fresh dispatch (${reason})`, ticketId);
    await saveAutopilotBoard(board);
    return true;
  }

  /** Bookkeeping repair after a board resume (KB-67 §6.3) — starts no session. */
  async function repairPausedExecutions(board, at) {
    let repaired = 0;
    for (const ticket of board.tickets) {
      if (ticket.execution?.status !== 'paused') continue;
      ticket.execution.status = 'idle';
      ticket.execution.updatedAt = at;
      repaired += 1;
    }
    if (repaired === 0) return false;
    pushBoardActivity(
      board,
      'autopilot',
      'autopilot/board-resume-repair',
      `Board resumed: repaired ${repaired} paused execution row(s) to idle; no session was started.`,
    );
    await saveAutopilotBoard(board);
    return true;
  }

  /**
   * Reconcile execution rows against live agents before planning (AC 8): a row
   * left `running`/`idle` whose session no longer resolves is marked idle and
   * reported as abandoned so the first pulse after start can recover it instead
   * of duplicating it.
   */
  async function reconcileAutopilotExecutions(board, at) {
    let changed = false;
    const abandoned = [];
    for (const ticket of board.tickets) {
      const execution = ticket.execution;
      if (!execution?.sessionId) continue;
      if (!['running', 'idle'].includes(execution.status)) continue;
      const liveStatus = liveAgentStatus(execution.sessionId);
      if (liveStatus === null) {
        if (execution.status === 'running' && board.paused !== true) {
          // KB-75 AC 3: a dead session is bookkeeping, not progress. Do NOT bump
          // `updatedAt` here, or the no-progress watchdog would restart its
          // `staleMs` clock on every reconcile and a dead row would look fresh
          // forever. The row keeps its last real signal and goes stale on time.
          execution.status = 'idle';
          changed = true;
        }
        abandoned.push(ticket.id);
        continue;
      }
      if (liveStatus === 'idle' && execution.status === 'running') {
        execution.status = 'idle';
        execution.updatedAt = at;
        changed = true;
      } else if (liveStatus === 'running' && execution.status === 'idle') {
        execution.status = 'running';
        execution.updatedAt = at;
        changed = true;
      }
    }
    if (changed) await saveAutopilotBoard(board);
    return { changed, abandoned };
  }

  /** Recover one abandoned execution as the first dispatch of the pulse (AC 8). */
  async function recoverAbandonedExecutions(workspaceId, abandonedIds, at, pulse) {
    let board = await reloadAutopilotBoard(workspaceId);
    const maxDispatches = Number.isInteger(board.autopilot.maxDispatchesPerPulse)
      ? board.autopilot.maxDispatchesPerPulse
      : 1;
    for (const ticketId of abandonedIds) {
      if (autopilotDisposed) return;
      if (pulse.dispatched.length >= maxDispatches) return;
      board = await reloadAutopilotBoard(workspaceId);
      if (board.paused === true) return;
      const ticket = board.tickets.find((entry) => entry.id === ticketId) ?? null;
      if (!ticket || !ticket.execution?.sessionId) continue;
      if (ticket.blocked === true || ticket.type === 'epic') continue;
      // KB-75: restart recovery is a dispatch path too, so it honours the same
      // per-ticket safety row as the planner. A parked ticket is never revived by
      // a host restart, and a ticket inside its failure backoff waits it out.
      const safety = planTicketSafety(ticket);
      if (safety.attempts >= AUTOPILOT_LOOP_GUARD_LIMIT || safety.backoffUntil > at) continue;
      const lane = autopilotLaneForColumn(ticket.column);
      if (!lane) continue;
      const ownerMemberId = typeof ticket.owner?.memberId === 'string' ? ticket.owner.memberId : null;
      const ownerMember = ownerMemberId
        ? board.team.members.find((member) => member.id === ownerMemberId) ?? null
        : null;
      if (ownerMember && ownerMember.paused === true) {
        pulse.decisions.push(autopilotDecisionRow({ ticketId, memberId: ownerMemberId, lane, action: 'skip', reason: 'member-paused' }));
        continue;
      }
      if (planBudgetExhausted(board.autopilot, at)) return;
      if (ticket.column === 'in_progress') {
        await autopilotHandoffMove(workspaceId, board, ticketId, at, 'restart-recovery');
        board = await reloadAutopilotBoard(workspaceId);
      }
      const current = board.tickets.find((entry) => entry.id === ticketId) ?? null;
      if (!current) continue;
      const execution = current.execution;
      if (!execution?.sessionId) continue;
      const role = ALL_ROLES.includes(execution.role) ? execution.role : executionRoleFor(current);
      const memberId = typeof current.owner?.memberId === 'string' ? current.owner.memberId : null;
      const rollback = {
        hour: { ...board.autopilot.budget.hour },
        day: { ...board.autopilot.budget.day },
        member: null,
      };
      chargeAutopilotBudget(board.autopilot, at);
      const stamped = memberId ? board.team.members.find((member) => member.id === memberId) : null;
      if (stamped) {
        rollback.member = stamped.lastActivatedAt ?? 0;
        stamped.lastActivatedAt = at;
        stamped.updatedAt = at;
      }
      try {
        const result = await startTicketExecution({
          workspaceId,
          ticketId,
          role,
          memberId: memberId ?? undefined,
          actor: 'autopilot',
          // The recorded session died with the host: start a fresh one instead
          // of prompting a session that can never answer (KB-67 §5.3).
          force: true,
          // Recovery keeps the refine lane's dispatch fingerprint (KB-71).
          dispatchOrigin: 'autopilot',
        });
        pulse.dispatched.push({
          ticketId,
          memberId: memberId ?? '',
          sessionId: String(result.sessionId),
        });
        pulse.decisions.push(
          autopilotDecisionRow({
            ticketId,
            memberId,
            lane,
            action: 'dispatch',
            reason: 'admitted',
            role: result.role ?? role,
            accessMode: result.accessMode,
          }),
        );
      } catch (error) {
        const message = clampString(error instanceof Error ? error.message : String(error), 500) || 'dispatch failed';
        pulse.error = message;
        const spent = error?.code === 'execution/prompt-failed' || error?.code === 'execution/access-mode-failed';
        if (!spent) {
          board.autopilot.budget.hour = rollback.hour;
          board.autopilot.budget.day = rollback.day;
          const restored = memberId ? board.team.members.find((member) => member.id === memberId) : null;
          if (restored && rollback.member !== null) restored.lastActivatedAt = rollback.member;
        }
        const failed = board.tickets.find((entry) => entry.id === ticketId) ?? null;
        if (failed) {
          failed.comments.push({
            id: uid(),
            author: 'autopilot',
            text: `[autopilot dispatch-failed] Recovery dispatch for ${ticketId} failed: ${message}`.slice(0, 1000),
            at,
          });
          failed.comments = failed.comments.slice(-100);
          pushTicketActivity(failed, 'autopilot', 'dispatch-failed', `Recovery dispatch failed: ${message}`.slice(0, 300));
        }
        pushBoardActivity(board, 'autopilot', 'autopilot/dispatch-failed', `Recovery dispatch for ${ticketId} failed: ${message}`.slice(0, 600), ticketId);
        if (failed) recordAutopilotTicketFailure(board, failed, at, 'dispatch-failed', message, pulse);
        await saveAutopilotBoard(board);
        return;
      }
    }
  }

  /**
   * The live agent behind a dispatched session (KB-75 AC 3): `null` when no agent
   * is registered for the session (or the optional agents service cannot be
   * consulted), otherwise the agent's status string. The watchdog, the planner
   * resolver and reconcile all read this one observation, so a session whose agent
   * is still `running` is never mistaken for a dead one and never cancelled.
   */
  function liveAgentStatus(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) return null;
    let agent;
    try {
      agent = ctx.get('agents')?.get?.(sessionId);
    } catch {
      return null;
    }
    if (!agent) return null;
    return typeof agent.status === 'string' && agent.status ? agent.status : 'unknown';
  }

  /**
   * Stale-execution watchdog (KB-75 AC 3). A `running`/`idle` execution whose
   * session has produced no signal for longer than `staleMs` AND whose live agent
   * is absent or no longer running is dead weight: the session is cancelled (best
   * effort), the execution row is closed with a persisted `stale` marker, one
   * `[autopilot stale-execution]` comment and one board activity are written, the
   * ticket accrues one consecutive failure (so the exponential backoff and the
   * loop guard bound any repetition), and the pulse records the `stale-execution`
   * decision. A live `running` agent is working — however quiet the row looks — so
   * it is never stale and is never cancelled.
   *
   * The marker is keyed by session id, so a staling event is recovered exactly
   * once even across a board reload; the ticket is then re-planned by the normal
   * planner after its backoff, never in a recovery loop. Host-death rows still
   * get the KB-70 first-pulse recovery: this watchdog only fires once the row has
   * genuinely shown no progress for `staleMs`.
   */
  async function recoverStaleExecutions(workspaceId, board, at, pulse) {
    if (autopilotDisposed) return false;
    const config = normalizeAutopilotState(board.autopilot).value;
    let changed = false;
    for (const ticket of board.tickets) {
      const execution = ticket.execution;
      if (!execution?.sessionId) continue;
      if (!['running', 'idle'].includes(execution.status)) continue;
      // Already recovered this staling event: the marker (not memory) is the
      // guard, so a restart cannot cancel and re-count the same session.
      if (execution.stale && execution.stale.sessionId === execution.sessionId) continue;
      // AC 3: the live agent decides staleness, not the persisted row alone. An
      // agent that is still running is active work; only an absent agent or one
      // that is not running can be recovered.
      if (!planExecutionIsStale(ticket, config, at, liveAgentStatus(execution.sessionId))) continue;
      let lastSignal = planNumber(execution.updatedAt, 0);
      for (const entry of Array.isArray(ticket.activity) ? ticket.activity : []) {
        lastSignal = Math.max(lastSignal, planNumber(entry?.at, 0));
      }
      const silentFor = Math.max(0, at - lastSignal);
      const reason = `no progress for ${silentFor}ms (> staleMs ${config.staleMs})`;
      let cancelled = false;
      try {
        ctx.sessionController?.cancel?.({ sessionId: execution.sessionId });
        cancelled = true;
      } catch {
        cancelled = false;
      }
      // Close the row: an idle pointer to a cancelled session would otherwise sit
      // in `active-execution` forever. The persisted `stale` marker is the
      // "already recovered" evidence, and `failed` lets the planner re-plan the
      // ticket once the backoff elapses (KB-75 AC 3 "re-planned at most once").
      execution.status = 'failed';
      execution.finishedAt = at;
      execution.updatedAt = at;
      execution.error = `stale: ${reason}; session ${cancelled ? 'cancelled' : 'cancel failed'}.`.slice(0, 2000);
      execution.stale = {
        at,
        sessionId: execution.sessionId,
        reason: reason.slice(0, TICKET_AUTOPILOT_STALE_TEXT_MAX),
        lastSignalAt: lastSignal,
      };
      if (ticket.owner) {
        pushTicketActivity(ticket, 'autopilot', 'unassign', `Unassigned from ${ticket.owner.name} after a stale execution`);
        ticket.owner = null;
      }
      ticket.updatedAt = at;
      ticket.comments = Array.isArray(ticket.comments) ? ticket.comments : [];
      ticket.comments.push({
        id: uid(),
        author: 'autopilot',
        text: `[autopilot stale-execution] ${ticket.id}: ${reason}; session ${execution.sessionId} ${cancelled ? 'cancelled' : 'could not be cancelled'}. The ticket will be re-planned after its failure backoff.`.slice(0, 1000),
        at,
      });
      ticket.comments = ticket.comments.slice(-100);
      pushTicketActivity(ticket, 'autopilot', 'stale-execution', `Stale execution recovered: ${reason}`);
      pushBoardActivity(
        board,
        'autopilot',
        'autopilot/stale',
        `${ticket.id}: ${reason}; session ${execution.sessionId} ${cancelled ? 'cancelled' : 'not cancellable'}, execution marked stale.`.slice(0, 600),
        ticket.id,
      );
      recordAutopilotTicketFailure(board, ticket, at, 'stale', reason, pulse);
      pulse.decisions.push(
        autopilotDecisionRow({
          ticketId: ticket.id,
          memberId: null,
          lane: autopilotLaneForColumn(ticket.column),
          action: 'skip',
          reason: 'stale-execution',
        }),
      );
      changed = true;
      if (autopilotDisposed) break;
    }
    if (changed) await saveAutopilotBoard(board);
    return changed;
  }

  /**
   * Lane-agnostic postcondition verifier (KB-71 refine, KB-72 implement, KB-73
   * review). Runs once per pulse before planning: every autopilot session
   * (execution `origin: 'autopilot'`) whose turn is over is checked exactly once
   * per state change, in the lane it was dispatched FROM
   * (`execution.startColumn`).
   * - blocked on a fact only the user can supply → `deferred` for every lane;
   * - refine: not Ready with role, priority and an acceptance-criteria section →
   *   `postcondition-failed`;
   * - implement: not In Progress or Review (i.e. still Ready, the pull never
   *   happened) → `postcondition-failed`, quoting the last execution report/error
   *   in the persisted ticket comment (KB-72 AC 5);
   * - review: no valid verdict, an accepted verdict without Done, an accepted
   *   verdict with an unmapped criterion, or a change request without In Progress
   *   + blocking note + failed criterion + implementation assignment →
   *   `postcondition-failed` (KB-73 AC 4/AC 5/AC 7);
   * - satisfied → the verified outcome, closing a turn that ended without
   *   `finish` as `done` so the member and the lane are not left busy.
   * `execution.postcondition` is the marker, so one outcome is recorded per state
   * change; answering a block bumps `execution.updatedAt` past the marker and
   * re-arms verification for the resumed turn.
   */
  async function verifyAutopilotPostconditions(workspaceId, board, at, pulse) {
    let changed = false;
    for (const ticket of board.tickets) {
      const execution = ticket.execution;
      if (!execution || execution.origin !== 'autopilot') continue;
      // KB-75: a row the watchdog already recovered is judged by the watchdog
      // (one `stale-execution` failure), never re-judged here as a second
      // postcondition failure for the same turn.
      if (execution.stale) continue;
      if (!AUTOPILOT_ENDED_STATUSES.has(execution.status)) continue;
      const lane = autopilotLaneForColumn(execution.startColumn);
      if (lane !== 'refine' && lane !== 'implement' && lane !== 'review') continue;
      // A session that vanished with the host is the executor's reconcile/recovery
      // path (KB-70 §5.3), not a completed turn: judging it here would turn a host
      // restart into a postcondition failure and re-dispatch work the recovery cap
      // already deferred. A session that is still registered but idle/blocked is a
      // turn that ended and is verified below.
      let liveAgent;
      try {
        liveAgent = ctx.get('agents')?.get?.(execution.sessionId);
      } catch {
        liveAgent = undefined;
      }
      if (!liveAgent) continue;
      const marker = execution.postcondition;
      if (marker && Number.isFinite(marker.at) && marker.at >= planNumber(execution.updatedAt, 0)) continue;
      let outcome = 'satisfied';
      let detail;
      if (lane === 'refine') {
        if (ticket.blocked === true) {
          outcome = 'deferred';
          detail = `Refine ${ticket.id} is deferred: the PM blocked on the exact missing fact (${ticket.blockReason || 'waiting for the user'}).`;
        } else {
          const postcondition = evaluateRefinePostcondition(ticket);
          if (postcondition.ok) {
            detail = `Refine ${ticket.id} met its postcondition: Ready, role ${ticket.role}, priority ${ticket.priority}, acceptance criteria present.`;
          } else {
            outcome = 'postcondition-failed';
            detail = `Refine ${ticket.id} missed its postcondition: ${postcondition.missing.join('; ')}.`;
          }
        }
      } else if (lane === 'implement') {
        if (ticket.blocked === true) {
          // KB-67 §6.8: an escalation to the user is not a postcondition failure.
          outcome = 'deferred';
          detail = `Implement ${ticket.id} is deferred: the implementer blocked on the exact missing fact (${ticket.blockReason || 'waiting for the user'}).`;
        } else {
          const postcondition = evaluateImplementPostcondition(ticket);
          if (postcondition.ok) {
            detail =
              ticket.column === 'review'
                ? `Implement ${ticket.id} met its postcondition: handed to Review.`
                : `Implement ${ticket.id} met its postcondition: claimed and left In Progress.`;
          } else {
            outcome = 'postcondition-failed';
            const lastReport =
              clampString(execution.report, 600) ||
              clampString(execution.error, 600) ||
              'no execution report or error was written';
            detail = `Implement ${ticket.id} missed its postcondition: ${postcondition.missing.join('; ')}. Last execution report/error: ${lastReport}`;
          }
        }
      } else if (ticket.blocked === true) {
        // KB-73: a reviewer that asks the user for a missing fact is deferred, not
        // failed — the same escalation rule the other lanes use.
        outcome = 'deferred';
        detail = `Review ${ticket.id} is deferred: the reviewer blocked on the exact missing fact (${ticket.blockReason || 'waiting for the user'}).`;
      } else {
        const postcondition = evaluateReviewPostcondition(ticket);
        const lastReport =
          clampString(execution.report, 600) ||
          clampString(execution.error, 600) ||
          'no execution report or error was written';
        if (postcondition.ok && postcondition.verdict === 'accepted') {
          detail = `Review ${ticket.id} accepted: verdict recorded, every criterion mapped passed, ticket Done. Reviewer access: ${execution.accessMode ?? 'unknown'} (${REVIEW_ACCESS_POLICY} policy).`;
        } else if (postcondition.ok) {
          detail = `Review ${ticket.id} requested changes: verdict recorded, blocking note present, ticket returned to In Progress for ${ticket.assignment?.role ?? 'the implementation role'}. Reviewer access: ${execution.accessMode ?? 'unknown'} (${REVIEW_ACCESS_POLICY} policy).`;
        } else {
          outcome = 'postcondition-failed';
          detail = `Review ${ticket.id} missed its postcondition: ${postcondition.missing.join('; ')}. Last execution report/error: ${lastReport}`;
        }
      }
      execution.postcondition = { at, outcome };
      changed = true;
      if (outcome === 'postcondition-failed') {
        // A failed attempt is terminal: it frees the lane and the member so the
        // persisted cooldown (not a zombie idle row) decides when to retry.
        execution.status = 'failed';
        execution.finishedAt = at;
        execution.updatedAt = at;
        execution.error = detail.slice(0, 2000);
        // A review miss is the one failure that leaves the ticket in a working
        // column (Review). The reviewer's dispatch-time ownership is stale once the
        // turn failed: clear it, or the single reviewer member would look busy on
        // every later pulse and the persisted cooldown could never admit a retry.
        if (lane === 'review' && ticket.owner) {
          pushTicketActivity(ticket, 'autopilot', 'unassign', `Unassigned from ${ticket.owner.name} after a failed review postcondition`);
          ticket.owner = null;
        }
        ticket.comments = Array.isArray(ticket.comments) ? ticket.comments : [];
        ticket.comments.push({
          id: uid(),
          author: 'autopilot',
          text: `[autopilot postcondition-failed] ${detail}`.slice(0, 1000),
          at,
        });
        ticket.comments = ticket.comments.slice(-100);
        pushTicketActivity(ticket, 'autopilot', 'postcondition-failed', detail.slice(0, 300));
        pushBoardActivity(board, 'autopilot', 'autopilot/postcondition-failed', detail.slice(0, 600), ticket.id);
        // KB-75 AC 2/AC 4: one shared failure counter and exponential backoff for
        // a missed lane postcondition; the third consecutive failure parks the
        // ticket behind the loop guard instead of retrying it forever.
        recordAutopilotTicketFailure(board, ticket, at, 'postcondition-failed', detail, pulse);
      } else if (outcome === 'deferred') {
        pushTicketActivity(ticket, 'autopilot', `${lane}-deferred`, detail.slice(0, 300));
        pushBoardActivity(board, 'autopilot', `autopilot/${lane}-deferred`, detail.slice(0, 600), ticket.id);
      } else {
        if (execution.status !== 'done') {
          execution.status = 'done';
          execution.finishedAt = at;
          execution.updatedAt = at;
          const laneLabel = lane === 'refine' ? 'Refine' : lane === 'review' ? 'Review' : 'Implement';
          execution.report = execution.report || `${laneLabel} postcondition verified: ${detail}`;
        }
        // KB-75 AC 2: a satisfied dispatch is the success signal that resets the
        // consecutive-failure counter and the backoff window.
        resetAutopilotTicketFailure(ticket, `the ${lane} postcondition was verified satisfied`);
        pushBoardActivity(board, 'autopilot', `autopilot/${lane}-satisfied`, detail.slice(0, 600), ticket.id);
      }
      if (pulse.outcomes.length < AUTOPILOT_PULSE_OUTCOMES_MAX) {
        pulse.outcomes.push({
          ticketId: ticket.id,
          lane,
          sessionId: execution.sessionId,
          outcome,
          detail: detail.slice(0, 400),
        });
      }
    }
    if (changed) await saveAutopilotBoard(board);
    return changed;
  }

  /** Dispatch the planner's decisions in order, reloading before each one. */
  async function dispatchPlannedWork(workspaceId, board, at, pulse) {
    const plan = planPulse(board, board.autopilot, at, liveAgentStatus);
    // KB-72: the admitted row is written from the plan, then completed with the
    // arguments the dispatch actually used (role, inference marker, access mode).
    // The row object is kept by ticket id so the annotation updates that slot
    // without reordering the pulse record.
    const admittedRows = new Map();
    for (const decision of plan.decisions) {
      const row = autopilotDecisionRow({ ...decision, action: 'dispatch', reason: 'admitted' });
      pulse.decisions.push(row);
      admittedRows.set(decision.ticketId, row);
    }
    for (const skip of plan.skips) {
      pulse.decisions.push(autopilotDecisionRow({ ...skip, action: 'skip' }));
    }
    if (pulse.decisions.length === 0) {
      // A pulse with nothing to say still records a heartbeat (KB-67 §4.2/§8):
      // autopilot is work-conditional, so an idle pulse costs no agent session.
      pulse.decisions.push(autopilotDecisionRow({ action: 'skip', reason: 'no-work' }));
    }
    const maxDispatches = Number.isInteger(board.autopilot.maxDispatchesPerPulse)
      ? board.autopilot.maxDispatchesPerPulse
      : 1;
    let dispatched = pulse.dispatched.length;
    for (const decision of plan.decisions) {
      if (dispatched >= maxDispatches) {
        pulse.decisions.push(
          autopilotDecisionRow({
            ticketId: decision.ticketId,
            memberId: decision.memberId,
            lane: decision.lane,
            action: 'skip',
            reason: 'pulse-cap',
          }),
        );
        break;
      }
      const outcome = await dispatchAutopilotDecision(workspaceId, decision, at, pulse);
      if (outcome.dispatched) {
        dispatched += 1;
        const row = admittedRows.get(outcome.ticketId ?? decision.ticketId);
        if (row) {
          Object.assign(
            row,
            autopilotDecisionRow({
              ...decision,
              action: 'dispatch',
              reason: 'admitted',
              role: outcome.role ?? decision.role,
              roleInferred: outcome.roleInferred === true,
              accessMode: outcome.accessMode,
            }),
          );
        }
      }
      if (outcome.stop) break;
    }
  }

  /**
   * One dispatch: re-read the board JSON, re-plan against it so a human edit
   * between decisions is honoured, then call `startTicketExecution` exactly once.
   * A throw stops the pulse and is recorded on the pulse (AC 5).
   */
  async function dispatchAutopilotDecision(workspaceId, decision, at, pulse) {
    if (autopilotDisposed) return { stop: true };
    let board = await reloadAutopilotBoard(workspaceId);
    if (board.paused === true) {
      pulse.decisions.push(autopilotDecisionRow({ action: 'skip', reason: 'board-paused' }));
      return { stop: true };
    }
    if (!autopilotEnabled(board)) {
      pulse.decisions.push(autopilotDecisionRow({ action: 'skip', reason: 'disabled' }));
      return { stop: true };
    }
    // KB-75 AC 1: the budget is checked by the planner AND again here, immediately
    // before the dispatch. The fresh board read is authoritative: another dispatch
    // (or a manual pulse) may have spent the last unit after this pulse planned.
    if (planBudgetExhausted(board.autopilot, at)) {
      pulse.decisions.push(autopilotDecisionRow({ action: 'skip', reason: 'budget-exhausted' }));
      return { stop: true };
    }
    const fresh = planPulse(board, board.autopilot, at, liveAgentStatus);
    const current = fresh.decisions.find((entry) => entry.ticketId === decision.ticketId) ?? null;
    if (!current) {
      const skip = fresh.skips.find((entry) => entry.ticketId === decision.ticketId) ?? null;
      pulse.decisions.push(
        autopilotDecisionRow({
          ticketId: decision.ticketId,
          memberId: decision.memberId,
          lane: decision.lane,
          action: 'skip',
          reason: skip ? skip.reason : 'active-execution',
        }),
      );
      return { dispatched: false };
    }
    // Per-member pause is re-checked at dispatch time (AC 7): a human may have
    // paused the chosen member after the pulse plan was computed.
    const member = board.team.members.find((entry) => entry.id === current.memberId) ?? null;
    if (!member || member.paused === true) {
      pulse.decisions.push(
        autopilotDecisionRow({
          ticketId: current.ticketId,
          memberId: current.memberId,
          lane: current.lane,
          action: 'skip',
          reason: 'member-paused',
        }),
      );
      return { dispatched: false };
    }
    if (current.mode === 'handoff') {
      await autopilotHandoffMove(workspaceId, board, current.ticketId, at, 'rework');
      board = await reloadAutopilotBoard(workspaceId);
    }
    if (current.roleInferred === true) {
      // KB-72 AC 7: the pulse itself stamps an inferred implementation role on the
      // ticket, so the ticket records who owns it even when the pre-existing role
      // was an unusual value the dispatch path's lane defaulting would not promote.
      const target = board.tickets.find((ticket) => ticket.id === current.ticketId) ?? null;
      if (target && target.role !== current.role) {
        const previousRole = target.role ?? 'none';
        target.role = current.role;
        target.updatedAt = at;
        pushTicketActivity(target, 'autopilot', 'role-inferred', `Inferred implementation role ${current.role} (was ${previousRole})`);
        pushBoardActivity(board, 'autopilot', 'autopilot/role-inferred', `${target.id}: inferred implementation role ${current.role} (ticket role was ${previousRole})`, target.id);
        await saveAutopilotBoard(board);
        board = await reloadAutopilotBoard(workspaceId);
      }
    }
    if (!board.tickets.some((ticket) => ticket.id === current.ticketId)) {
      pulse.decisions.push(
        autopilotDecisionRow({
          ticketId: current.ticketId,
          memberId: current.memberId,
          lane: current.lane,
          action: 'skip',
          reason: 'active-execution',
        }),
      );
      return { dispatched: false };
    }
    const rollback = {
      hour: { ...board.autopilot.budget.hour },
      day: { ...board.autopilot.budget.day },
      member: null,
    };
    chargeAutopilotBudget(board.autopilot, at);
    const stamped = board.team.members.find((entry) => entry.id === current.memberId) ?? null;
    if (stamped) {
      rollback.member = stamped.lastActivatedAt ?? 0;
      // Persisted fairness key (KB-69 §13): both a start and a resume stamp it.
      stamped.lastActivatedAt = at;
      stamped.updatedAt = at;
    }
    try {
      const result = await startTicketExecution({
        workspaceId,
        ticketId: current.ticketId,
        role: current.role,
        memberId: current.memberId,
        actor: 'autopilot',
        force: false,
        // KB-71: the refine lane fingerprints its own sessions on the execution
        // row; manual dispatches never set this field.
        dispatchOrigin: 'autopilot',
      });
      pulse.dispatched.push({
        ticketId: current.ticketId,
        memberId: current.memberId,
        sessionId: String(result.sessionId),
      });
      return {
        dispatched: true,
        ticketId: current.ticketId,
        role: result.role ?? current.role,
        roleInferred: current.roleInferred === true,
        accessMode: result.accessMode,
      };
    } catch (error) {
      const message = clampString(error instanceof Error ? error.message : String(error), 500) || 'dispatch failed';
      pulse.error = message;
      // The budget counts spend only: a session that was created but whose prompt
      // (or access mode) failed has already spent; a validation or create failure
      // has not, so its counter/stamp increment is rolled back.
      const spent = error?.code === 'execution/prompt-failed' || error?.code === 'execution/access-mode-failed';
      if (!spent) {
        board.autopilot.budget.hour = rollback.hour;
        board.autopilot.budget.day = rollback.day;
        const restored = board.team.members.find((entry) => entry.id === current.memberId) ?? null;
        if (restored && rollback.member !== null) restored.lastActivatedAt = rollback.member;
      }
      const failed = board.tickets.find((ticket) => ticket.id === current.ticketId) ?? null;
      if (failed) {
        failed.comments.push({
          id: uid(),
          author: 'autopilot',
          text: `[autopilot dispatch-failed] ${current.ticketId}: ${message}`.slice(0, 1000),
          at,
        });
        failed.comments = failed.comments.slice(-100);
        pushTicketActivity(failed, 'autopilot', 'dispatch-failed', `Dispatch failed: ${message}`.slice(0, 300));
      }
      pushBoardActivity(board, 'autopilot', 'autopilot/dispatch-failed', `Pulse could not dispatch ${current.ticketId}: ${message}`.slice(0, 600), current.ticketId);
      // KB-75 AC 2: a dispatch that threw is one consecutive failure for THIS
      // ticket too, so it backs off instead of being retried on every pulse. The
      // pulse-level error still drives the global scheduler backoff.
      if (failed) recordAutopilotTicketFailure(board, failed, at, 'dispatch-failed', message, pulse);
      await saveAutopilotBoard(board);
      return { stop: true };
    }
  }

  /** Record the overlap guard hit (AC 3): no queue, no dispatch. */
  async function recordAutopilotOverlap(workspaceId) {
    try {
      const project = projectFor(workspaceId);
      const board = store.cache.get(String(project.id)) ?? (await store.ensure(project));
      pushBoardActivity(
        board,
        'autopilot',
        'pulse/skipped-overlap',
        'Pulse skipped: the previous pulse for this project is still running.',
      );
      await saveAutopilotBoard(board);
    } catch {
      // an overlap record must never throw out of the timer callback
    }
  }

  /**
   * Run one pulse. The overlap guard is set before the first await and released
   * in `finally`, so a throw can never wedge the scheduler (AC 3). The pulse
   * record is persisted in the same `finally`, which is what makes a failed
   * pulse readable (AC 4).
   */
  async function runAutopilotPulse(workspaceId, trigger) {
    const workspaceKey = String(workspaceId);
    if (autopilotDisposed) return null;
    if (autopilotPulses.has(workspaceKey)) return null;
    const at = clock();
    const pulse = {
      id: null,
      at,
      atIso: new Date(at).toISOString(),
      trigger: AUTOPILOT_TRIGGERS.includes(trigger) ? trigger : 'timer',
      decisions: [],
      dispatched: [],
      error: '',
      outcomes: [],
    };
    const run = (async () => {
      try {
        let board = await reloadAutopilotBoard(workspaceId);
        if (board.paused === true) {
          // A paused board is a no-op pulse: recorded once per pause for timers,
          // every time for an explicit manual pulse (KB-67 §6.3).
          pulse.decisions.push(autopilotDecisionRow({ action: 'skip', reason: 'board-paused' }));
        } else if (!autopilotEnabled(board)) {
          pulse.decisions.push(autopilotDecisionRow({ action: 'skip', reason: 'disabled' }));
        } else {
          // KB-70 P3-5 / KB-75: a board resume leaves one repair pending. Both the
          // first timer tick after resume AND a manual pulse run it, so the
          // `paused` execution rows are repaired before anything else is planned.
          const resumePending = autopilotResumePulses.delete(workspaceKey);
          if ((pulse.trigger === 'resume' || resumePending) && (await repairPausedExecutions(board, at))) {
            board = await reloadAutopilotBoard(workspaceId);
          }
          const reconciled = await reconcileAutopilotExecutions(board, at);
          if (reconciled.changed) board = await reloadAutopilotBoard(workspaceId);
          if (autopilotRecovery.has(workspaceKey)) {
            autopilotRecovery.delete(workspaceKey);
            if (reconciled.abandoned.length > 0 && board.paused !== true) {
              await recoverAbandonedExecutions(workspaceId, reconciled.abandoned, at, pulse);
              board = await reloadAutopilotBoard(workspaceId);
            }
          }
          if (autopilotEnabled(board) && board.paused !== true && !autopilotDisposed) {
            // KB-75 AC 3: the no-progress watchdog runs every pulse, so a dead
            // session beyond `staleMs` is recovered once instead of waiting for
            // the next restart. Its marker prevents a recovery loop.
            if (await recoverStaleExecutions(workspaceId, board, at, pulse)) {
              board = await reloadAutopilotBoard(workspaceId);
            }
            // KB-71: verify lane postconditions before planning, so a miss's
            // comment participates in this pulse's cooldown/loop-guard decision.
            if (await verifyAutopilotPostconditions(workspaceId, board, at, pulse)) {
              board = await reloadAutopilotBoard(workspaceId);
            }
            await dispatchPlannedWork(workspaceId, board, at, pulse);
          }
        }
      } catch (error) {
        pulse.error = clampString(error instanceof Error ? error.message : String(error), 500) || 'pulse failed';
      } finally {
        // A pulse must never reject into a fire-and-forget timer callback (KB-75
        // AC 6): persisting and re-arming fail soft, and the next board load
        // re-arms the scheduler if even that fails.
        try {
          await finishAutopilotPulse(workspaceId, pulse);
        } catch {
          // keep the loop alive; a later board load re-arms from persisted state
        }
      }
      return pulse;
    })();
    autopilotPulses.set(workspaceKey, run);
    try {
      return await run;
    } finally {
      autopilotPulses.delete(workspaceKey);
    }
  }

  /** Persist exactly one pulse record and re-arm from the persisted state. */
  async function finishAutopilotPulse(workspaceId, pulse) {
    pulse.durationMs = Math.max(0, Math.round(clock() - pulse.at));
    if (pulse.decisions.length > AUTOPILOT_PULSE_DECISIONS_MAX) {
      const dropped = pulse.decisions.length - AUTOPILOT_PULSE_DECISIONS_MAX;
      pulse.decisions = pulse.decisions.slice(0, AUTOPILOT_PULSE_DECISIONS_MAX);
      const last = pulse.decisions[pulse.decisions.length - 1];
      if (last) last.reason = clampString(`${last.reason} (+${dropped} decisions not stored)`, 400);
    }
    let board = null;
    try {
      board = await reloadAutopilotBoard(workspaceId);
    } catch {
      // A failed final read must not strand the scheduler: fall back to the
      // cached board, and if even that is gone, at least try to keep cadence.
      board = store.cache.get(String(workspaceId)) ?? null;
    }
    if (!board) {
      const fallbackDelay = AUTOPILOT_BOUNDS.cadenceMs.fallback;
      try {
        armAutopilotTimer(workspaceId, clock() + fallbackDelay);
      } catch {
        // nothing more to do; the next load re-arms the board
      }
      return;
    }
    const newest = board.pulses[0] ?? null;
    const repeatedPause =
      pulse.trigger !== 'manual' &&
      board.paused === true &&
      pulse.decisions.length === 1 &&
      pulse.decisions[0].reason === 'board-paused' &&
      newest &&
      newest.decisions.length === 1 &&
      newest.decisions[0].reason === 'board-paused' &&
      Number.isFinite(board.pausedAt) &&
      newest.at >= board.pausedAt;
    if (!repeatedPause) {
      // KB-71 additive field: only persist `outcomes` when this pulse verified a
      // refine session, so old pulse rows keep their exact stored shape.
      if (Array.isArray(pulse.outcomes) && pulse.outcomes.length === 0) delete pulse.outcomes;
      pulse.id = nextAutopilotPulseId(board);
      board.pulses.unshift({ ...pulse, decisions: pulse.decisions.map((row) => ({ ...row })) });
      board.pulses = board.pulses.slice(0, AUTOPILOT_PULSE_MAX);
      await saveAutopilotBoard(board);
    }
    scheduleAutopilotFromBoard(board);
  }

  /** Timer callback: provisional re-arm first, then the overlap guard, then a pulse. */
  async function onAutopilotTimer(workspaceId) {
    if (autopilotDisposed) return;
    let board;
    try {
      board = await reloadAutopilotBoard(workspaceId);
    } catch {
      // Keep the cadence alive even if this tick could not read the board.
      try {
        armAutopilotTimer(workspaceId, clock() + AUTOPILOT_BOUNDS.cadenceMs.fallback);
      } catch {
        // the next board load re-arms from persisted state
      }
      return;
    }
    // Arm the following cadence before the pulse runs. A slow pulse then leaves a
    // live timer whose tick is observed by the overlap guard instead of silently
    // losing the cadence (KB-67 §6.1/AC 3); the pulse's own `finally` re-arms.
    if (autopilotEnabled(board)) {
      const target = (Number.isFinite(board.pulses?.[0]?.at) ? board.pulses[0].at : clock()) + autopilotDelayMs(board);
      armAutopilotTimer(workspaceId, Math.max(target, clock() + AUTOPILOT_TICK_FLOOR_MS));
    }
    if (autopilotPulseInFlight(workspaceId)) {
      await recordAutopilotOverlap(workspaceId);
      return;
    }
    const trigger = autopilotResumePulses.delete(String(workspaceId)) ? 'resume' : 'timer';
    await runAutopilotPulse(workspaceId, trigger);
  }

  /** Startup sweep (KB-67 §6.2): only boards that already exist get a timer. */
  async function startupAutopilotSweep() {
    for (const project of workspaces()) {
      if (autopilotDisposed) return;
      try {
        // `inspect` never caches and never creates a board file for an untouched
        // project; a later snapshot/action arms the timer for a freshly written board.
        const board = await store.inspect(project);
        if (!board || !autopilotEnabled(board)) continue;
        autopilotRecovery.add(String(project.id));
        scheduleAutopilotFromBoard(board, { fromLoad: true });
      } catch {
        // one unreadable board must never stop the other projects' schedulers
      }
    }
  }

  /** Preset that supplies the project's tool composition to a new execution agent. */
  async function executionPreset(project) {
    const presets = ctx.get('agentPresets');
    if (!presets) return { id: null, mount: null };
    let presetId = null;
    try {
      const sessions = await readSessions();
      const recent = sessions
        .filter((session) => session.agentPreset && isInside(session.cwd, project.path))
        .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
      if (recent.length > 0) presetId = recent[0].agentPreset;
      if (!presetId) {
        const resolved = await presets.resolve(undefined);
        presetId = resolved && typeof resolved.id === 'string' ? resolved.id : null;
      }
    } catch {
      presetId = null;
    }
    if (!presetId) return { id: null, mount: null };
    const mount = async (agentCtx) => {
      await presets.mount(agentCtx, presetId);
    };
    return { id: presetId, mount };
  }

  async function startTicketExecution({ workspaceId, ticketId, role, accessMode, actor, memberId, force = false, dispatchOrigin = null }) {
    const { project, board } = await loadProject(workspaceId);
    if (board.paused) throw new ApiError(423, 'board/paused', 'The board is paused. Resume it before dispatching agents.');
    const ticket = findTicket(board, ticketId);
    // An EPIC is never dispatched: reject before creating any session.
    if (ticket.type === 'epic') throw epicNotClaimable();
    if (!['backlog', 'ready', 'review'].includes(ticket.column)) {
      throw new ApiError(409, 'ticket/lane', `Tickets in ${ticket.column} cannot be dispatched to an agent by the board.`);
    }
    if (ticket.blocked) throw new ApiError(409, 'ticket/blocked', 'Answer the blocked questions before dispatching this ticket.');
    // KB-75 AC 2: a human/manual dispatch (any caller that is not the autopilot
    // executor) is a human action, so it clears the ticket's consecutive-failure
    // counter and backoff. The autopilot's own dispatches never reset it.
    if (actor !== 'autopilot') resetAutopilotTicketFailure(ticket, 'a manual dispatch took over the ticket');
    const existing = ticket.execution;
    if (!force && existing?.sessionId && ['running', 'idle', 'blocked', 'paused'].includes(existing.status)) {
      return resumeTicketExecution({ workspaceId, ticketId, actor, message: 'Continue working on your Kanban ticket.' });
    }
    const handoff = ticket.assignment ? { ...ticket.assignment } : null;
    // KB-72: the implement brief quotes the previous attempt's report and error,
    // captured before the new execution row overwrites `ticket.execution`.
    const previousExecution =
      ticket.execution && typeof ticket.execution === 'object'
        ? {
            status: ticket.execution.status,
            report: ticket.execution.report,
            error: ticket.execution.error,
            // KB-74: the attempt-history block dates the previous report so the
            // context-pack trim can drop the oldest block first.
            role: ticket.execution.role,
            startedAt: ticket.execution.startedAt,
            updatedAt: ticket.execution.updatedAt,
            finishedAt: ticket.execution.finishedAt,
          }
        : null;
    // KB-73: the review brief quotes the implementation report and the evidence
    // comments, captured before this dispatch overwrites the owner and execution.
    const previousOwnerName = ticket.owner && typeof ticket.owner.name === 'string' ? ticket.owner.name : null;
    const previousComments = Array.isArray(ticket.comments) ? ticket.comments.slice(-20) : [];
    const previousReport = ticket.execution && ticket.execution.status === 'done' ? ticket.execution.report : '';
    const laneDefaultRole = executionRoleFor(ticket);
    let chosenRole = ALL_ROLES.includes(role) ? role : (handoff && ALL_ROLES.includes(handoff.role) ? handoff.role : laneDefaultRole);
    let roleNote = '';
    if (typeof memberId === 'string' && memberId) {
      // An explicit roster member is authoritative: the person's role wins.
      const chosen = findMember(board, memberId);
      if (chosen.paused) {
        throw new ApiError(409, 'member/paused', `${chosen.name} is paused. Resume the member before dispatching work.`);
      }
      chosenRole = chosen.roleId;
      if (!executionRoleAllowed(ticket.column, chosenRole)) {
        throw new ApiError(
          403,
          'ticket/role-forbidden',
          `${chosen.name} is ${ROLE_INDEX[chosenRole]?.name ?? chosenRole} and cannot claim from ${LANE_LABEL[ticket.column]}.`,
        );
      }
    } else if (!executionRoleAllowed(ticket.column, chosenRole)) {
      roleNote = `Requested ${ROLE_INDEX[chosenRole]?.name ?? chosenRole} is not allowed to pull from ${LANE_LABEL[ticket.column]}; dispatched as ${ROLE_INDEX[laneDefaultRole]?.name ?? laneDefaultRole} instead.`;
      chosenRole = laneDefaultRole;
    }
    if (ticket.column === 'ready' && !DEV_ROLES.has(ticket.role) && ticket.role !== 'ux-designer' && ticket.role !== 'sre' && ticket.role !== 'tech-lead') {
      ticket.role = chosenRole;
    }
    const member = resolveDispatchMember(board, chosenRole, memberId);
    const sessionId = `session-${randomUUID()}`;
    let modelSelection;
    try {
      modelSelection = ctx.get('agentDefaultModel')?.currentSelection?.();
    } catch {
      modelSelection = undefined;
    }
    const agentOptions = modelSelection && typeof modelSelection.provider === 'string' && typeof modelSelection.model === 'string'
      ? {
          provider: modelSelection.provider,
          model: modelSelection.model,
          ...(typeof modelSelection.reasoningEffort === 'string' ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
        }
      : undefined;
    const explicitAccess = typeof accessMode === 'string' && accessMode ? accessMode : null;
    const requestedAccess = explicitAccess ?? (handoff && handoff.accessMode ? handoff.accessMode : undefined);
    let access = resolveAccessMode(requestedAccess, ticket, chosenRole);
    // KB-73 access contract, enforced on the handoff path (surfaced by KB-74): a
    // persisted `assignment.accessMode` was written by whatever host last moved
    // the ticket, so a stale board can carry `read-only` for a Review ticket even
    // though the review lane's documented preset is test-capable. A review
    // dispatch must never be downgraded below that preset — a read-only reviewer
    // cannot execute `node --test`. An explicit human `runTicket` access choice
    // is still honoured; only the persisted handoff suggestion is repaired.
    if (!explicitAccess && ticket.column === 'review' && accessSandbox(access.value, ctx.get('permissionPresets')) === 'read-only') {
      access = { value: suggestedAccessMode(ticket, chosenRole), options: access.options };
    }
    const preset = await executionPreset(project);
    let handle;
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: project.path,
          ...(preset.id ? { agentPreset: preset.id } : {}),
        },
        ...(agentOptions ? { agentOptions } : {}),
        ...(preset.mount ? { setup: async (agentCtx) => { await preset.mount(agentCtx); } } : {}),
      });
    } catch (error) {
      throw new ApiError(502, 'execution/session-failed', `Could not start an agent session: ${error instanceof Error ? error.message : String(error)}`);
    }
    const agentId = String(handle.agent.id);
    try {
      const presets = ctx.get('permissionPresets');
      const liveSession = handle.agent?.session ?? ctx.get('sessions')?.get?.(agentId);
      if (presets && typeof presets.set === 'function' && liveSession) {
        presets.set(liveSession, access.value);
      }
    } catch (error) {
      try {
        await handle?.dispose?.();
      } catch {
        // best effort
      }
      throw new ApiError(502, 'execution/access-mode-failed', `Could not apply access mode "${access.value}": ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await project.attachSession?.(agentId);
    } catch {
      // grouping is cosmetic; the session still exists in the workspace directory
    }
    const name = `${roleShortName(chosenRole)} · ${ticket.id}`;
    try {
      const live = ctx.get('sessions')?.get?.(agentId);
      const titles = ctx.get('sessionTitle');
      if (live && titles && typeof titles.rename === 'function') {
        titles.rename(live, `${ticket.id} · ${ticket.title}`.slice(0, 120));
      }
    } catch {
      // title is cosmetic; never fail the dispatch over it
    }
    ensureBoardAgent(board, agentId, { name, role: chosenRole, ...(member ? { memberId: member.id } : {}) });
    board.agents[agentId].executionTicketId = ticket.id;
    if (member) {
      member.sessionId = agentId;
      member.updatedAt = now();
    }
    ticket.owner = { sessionId: agentId, name, role: chosenRole, memberId: member?.id ?? null };
    ticket.execution = {
      sessionId: agentId,
      status: 'running',
      role: chosenRole,
      accessMode: access.value,
      startColumn: ticket.column,
      // KB-71 additive field: only an autopilot dispatch stamps its origin, so the
      // refine lane can fingerprint its own sessions without guessing from roles.
      ...(dispatchOrigin === 'autopilot' ? { origin: 'autopilot' } : {}),
      startedAt: now(),
      updatedAt: now(),
      finishedAt: null,
      report: '',
      error: '',
      blocked: null,
    };
    ticket.updatedAt = now();
    ticket.assignment = null;
    ticket.comments.push({ id: uid(), author: name, text: `Execution session started as ${ROLE_INDEX[chosenRole]?.name ?? chosenRole}.`, at: now() });
    ticket.comments = ticket.comments.slice(-100);
    pushTicketActivity(ticket, name, 'execute', `Execution session started (${ROLE_INDEX[chosenRole]?.name ?? chosenRole})`);
    pushBoardActivity(board, actor, 'ticket/execute', `${ticket.id} dispatched to ${name}${roleNote ? ` — ${roleNote}` : ''}`, ticket.id);
    await store.save(board);
    const prompt = [
      executionPrompt(
        ticket,
        project,
        chosenRole,
        'start',
        member,
        executionLaneContext(board, ticket, { handoff, previousExecution, previousOwnerName, previousComments }),
      ),
      handoff ? `\n## Handoff\n${handoff.reason || 'This ticket was handed to your lane.'} You are picking it up in ${LANE_LABEL[ticket.column]} as ${ROLE_INDEX[chosenRole]?.name ?? chosenRole}.` : '',
      previousReport ? `\nPrevious agent report:\n${previousReport}` : '',
      `\n## Access mode\n${access.value}: stay within this access mode. Do not attempt operations the mode does not allow.`,
    ].filter(Boolean).join('\n');
    try {
      await promptSession(agentId, prompt);
    } catch (error) {
      ticket.execution.status = 'failed';
      ticket.execution.error = error instanceof Error ? error.message : String(error);
      ticket.execution.updatedAt = now();
      await store.save(board);
      throw new ApiError(502, 'execution/prompt-failed', `Agent session started but the prompt was rejected: ${ticket.execution.error}`);
    }
    return { ticket, sessionId: agentId, role: chosenRole, accessMode: access.value, prompt };
  }

  async function resumeTicketExecution({ workspaceId, ticketId, actor, message }) {
    const { project, board } = await loadProject(workspaceId);
    if (board.paused) throw new ApiError(423, 'board/paused', 'The board is paused.');
    const ticket = findTicket(board, ticketId);
    const execution = ticket.execution;
    if (!execution?.sessionId) throw new ApiError(409, 'execution/missing', 'This ticket has no agent session to resume.');
    if (execution.status === 'blocked') {
      throw new ApiError(409, 'execution/blocked', 'Answer the blocked questions to resume this execution.');
    }
    if (['done', 'cancelled'].includes(execution.status)) {
      return startTicketExecution({ workspaceId, ticketId, role: execution.role, actor, force: true });
    }
    // KB-75 AC 2: resuming by any non-autopilot caller is a human action.
    if (actor !== 'autopilot') resetAutopilotTicketFailure(ticket, 'a manual resume took over the ticket');
    execution.status = 'running';
    execution.updatedAt = now();
    ticket.updatedAt = now();
    pushTicketActivity(ticket, actor, 'execute', 'Execution resumed');
    pushBoardActivity(board, actor, 'ticket/resume', `${ticket.id} execution resumed`, ticket.id);
    await store.save(board);
    try {
      const member = ticket.owner?.memberId
        ? board.team.members.find((candidate) => candidate.id === ticket.owner.memberId) ?? null
        : null;
      const context = executionPrompt(
        ticket,
        project,
        execution.role ?? executionRoleFor(ticket),
        'resume',
        member,
        executionLaneContext(board, ticket),
      );
      await promptSession(execution.sessionId, `${message || 'Continue working on your Kanban ticket.'}\n\n${context}`);
    } catch (error) {
      execution.status = 'idle';
      execution.error = error instanceof Error ? error.message : String(error);
      await store.save(board);
      throw new ApiError(502, 'execution/prompt-failed', `Could not resume the agent: ${execution.error}`);
    }
    return { ticket, sessionId: execution.sessionId, role: execution.role };
  }

  async function answerTicketExecution({ workspaceId, ticketId, answers, grant, denied, actor }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    if (!ticket.blocked) {
      if (ticket.execution?.status === 'idle') return resumeTicketExecution({ workspaceId, ticketId, actor });
      throw new ApiError(409, 'ticket/not-blocked', 'This ticket is not waiting for an answer.');
    }
    const execution = ticket.execution;
    const blocked = execution?.blocked;
    const answerList = [];
    if (blocked?.questions?.length) {
      blocked.questions.forEach((question, index) => {
        const answer = clampString(Array.isArray(answers) ? answers[index] : '', 4000);
        question.answer = answer;
        answerList.push(`Q${index + 1}: ${question.text}\nA${index + 1}: ${answer || '(no answer provided)'}`);
      });
    }
    if (Array.isArray(answers) && blocked?.questions?.length === 0) {
      for (const value of answers) {
        const text = clampString(value, 4000);
        if (text) answerList.push(`Answer: ${text}`);
      }
    }
    const granted = Array.isArray(grant) ? grant.map((value) => clampString(value, 1000)).filter(Boolean) : [];
    const refused = Array.isArray(denied) ? denied.map((value) => clampString(value, 1000)).filter(Boolean) : [];
    if (blocked?.needs?.length) {
      for (const need of blocked.needs) {
        if (granted.some((value) => need.text.includes(value) || value.includes(need.text))) need.status = 'granted';
        if (refused.some((value) => need.text.includes(value) || value.includes(need.text))) need.status = 'denied';
      }
    }
    const summaryText = clampString(typeof answers === 'string' ? answers : '', 4000);
    if (summaryText) answerList.push(`Note: ${summaryText}`);
    const responseText = [
      `The user answered the blocked ticket ${ticket.id}.`,
      ...answerList,
      granted.length ? `Permissions granted: ${granted.join('; ')}` : '',
      refused.length ? `Permissions denied: ${refused.join('; ')}` : '',
      '',
      `Resume work on ${ticket.id} in lane ${LANE_LABEL[ticket.column]}. Re-read the ticket if needed, continue the plan, and finish with the kanban tool when done.`,
    ].filter(Boolean).join('\n');
    ticket.blocked = false;
    ticket.blockReason = '';
    ticket.block = null;
    // KB-75 AC 4: answering a parked ticket is a human unblock, which resets the
    // consecutive-failure counter and the loop-guard park.
    resetAutopilotTicketFailure(ticket, 'the blocked ticket was answered');
    if (execution) {
      execution.status = execution.sessionId ? 'running' : 'idle';
      execution.updatedAt = now();
      execution.blocked = null;
    }
    ticket.updatedAt = now();
    ticket.comments.push({ id: uid(), author: actor, text: `Answers provided: ${answerList.join(' | ').slice(0, 2000)}`, at: now() });
    ticket.comments = ticket.comments.slice(-100);
    pushTicketActivity(ticket, actor, 'answer', 'Blocked questions answered');
    pushBoardActivity(board, actor, 'ticket/answer', `${ticket.id} unblocked and resumed`, ticket.id);
    await store.save(board);
    if (execution?.sessionId) {
      try {
        await promptSession(execution.sessionId, responseText);
      } catch (error) {
        execution.status = 'idle';
        execution.error = error instanceof Error ? error.message : String(error);
        await store.save(board);
        throw new ApiError(502, 'execution/prompt-failed', `Ticket unblocked, but the agent could not resume: ${execution.error}`);
      }
    }
    return { ticket, sessionId: execution?.sessionId ?? null };
  }

  async function finishTicketExecution({ workspaceId, ticketId, summary, actor, sessionId }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    const execution = ticket.execution;
    if (!execution?.sessionId) throw new ApiError(409, 'execution/missing', 'This ticket has no execution to finish.');
    if (sessionId && execution.sessionId !== sessionId) {
      throw new ApiError(403, 'ticket/role-forbidden', 'Only the executing agent session may finish this ticket.');
    }
    if (execution.status === 'done') return { ticket };
    const allowed = executionSuccessColumns(execution.startColumn);
    if (!allowed.includes(ticket.column)) {
      throw new ApiError(
        409,
        'execution/not-advanced',
        `${ticket.id} is in ${LANE_LABEL[ticket.column]}; finish it after moving it to ${allowed.map((column) => LANE_LABEL[column]).join(' or ')}.`,
      );
    }
    const report = clampString(summary, 6000) || 'Completed without a written report.';
    execution.status = 'done';
    execution.report = report;
    execution.finishedAt = now();
    execution.updatedAt = now();
    ticket.updatedAt = now();
    ticket.comments.push({ id: uid(), author: actor, text: `Agent report: ${report}`, at: now() });
    ticket.comments = ticket.comments.slice(-100);
    pushTicketActivity(ticket, actor, 'finish', report.slice(0, 300));
    pushBoardActivity(board, actor, 'ticket/finish', `${ticket.id} execution finished in ${LANE_LABEL[ticket.column]}`, ticket.id);
    await store.save(board);
    return { ticket };
  }

  async function cancelTicketExecution({ workspaceId, ticketId, actor }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    const execution = ticket.execution;
    if (!execution?.sessionId) throw new ApiError(409, 'execution/missing', 'This ticket has no execution to cancel.');
    if (execution.status === 'cancelled') return { ticket };
    try {
      ctx.sessionController.cancel({ sessionId: execution.sessionId });
    } catch {
      // best effort
    }
    execution.status = 'cancelled';
    execution.updatedAt = now();
    execution.finishedAt = now();
    execution.blocked = null;
    ticket.owner = null;
    ticket.blocked = false;
    ticket.blockReason = '';
    ticket.block = null;
    ticket.updatedAt = now();
    ticket.comments.push({ id: uid(), author: actor, text: 'Execution cancelled by the user.', at: now() });
    pushTicketActivity(ticket, actor, 'cancel', 'Execution cancelled');
    pushBoardActivity(board, actor, 'ticket/cancel', `${ticket.id} execution cancelled`, ticket.id);
    await store.save(board);
    return { ticket };
  }

  /** Keep execution status honest against the live agent registry. */
  async function reconcileExecutions(board) {
    // Shared with the pulse executor so a snapshot read and a pulse can never
    // disagree about which execution rows are live (KB-70 AC 8).
    await reconcileAutopilotExecutions(board, clock());
    return board;
  }

  async function blockTicketExecution({ workspaceId, ticketId, reason, questions, needs, actor }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    const normalized = normalizeBlock({ reason, questions, needs });
    if (!normalized) throw badRequest('A block needs a reason, questions, or needs.');
    ticket.blocked = true;
    ticket.blockReason = normalized.reason || 'Waiting for the user.';
    ticket.block = normalized;
    if (ticket.execution) {
      ticket.execution.status = 'blocked';
      ticket.execution.blocked = normalized;
      ticket.execution.updatedAt = now();
    }
    ticket.updatedAt = now();
    const questionText = normalized.questions.map((question) => `• ${question.text}`).join('\n');
    const needText = normalized.needs.map((need) => `• [${need.kind}] ${need.text}`).join('\n');
    ticket.comments.push({
      id: uid(),
      author: actor,
      text: `Blocked: ${normalized.reason || 'waiting for user'}\n${questionText}\n${needText}`.trim(),
      at: now(),
    });
    ticket.comments = ticket.comments.slice(-100);
    pushTicketActivity(ticket, actor, 'block', `Blocked: ${normalized.reason || 'waiting for user'}`);
    pushBoardActivity(board, actor, 'ticket/blocked', `${ticket.id} blocked — waiting for the user`, ticket.id);
    await store.save(board);
    return { ticket };
  }

  // -- actions used by both the HTTP route and the agent tool --------------

  async function loadProject(workspaceId) {
    const project = projectFor(workspaceId);
    const board = await store.ensure(project);
    // Any board loaded after the startup sweep arms its own timer (KB-67 §6.2.2).
    noteAutopilotBoard(board);
    return { project, board };
  }

  // -- thought intake (KB-1) ----------------------------------------------

  /** Snapshot row: the frozen public ThoughtRecord shape + KB-5 additive fields. */
  function thoughtRow(thought) {
    return {
      id: thought.id,
      text: thought.text,
      status: thought.status,
      createdAt: thought.createdAt,
      updatedAt: thought.updatedAt,
      sessionId: thought.sessionId,
      error: thought.error,
      ticketIds: [...thought.ticketIds],
      ...(thought.retryOf ? { retryOf: thought.retryOf } : {}),
      ...(thought.deletedAt ? { deletedAt: thought.deletedAt } : {}),
      ...(thought.editedAt ? { editedAt: thought.editedAt } : {}),
      ...(Array.isArray(thought.audit) && thought.audit.length > 0
        ? { audit: thought.audit.slice(-THOUGHT_AUDIT_SNAPSHOT_MAX).map(snapshotAuditEntry) }
        : {}),
      // KB-6 additive intake audit. Always an array: an old row with no recorded
      // events reads as an empty list instead of `undefined`.
      intakeAudit: (Array.isArray(thought.intakeAudit) ? thought.intakeAudit : [])
        .slice(-THOUGHT_INTAKE_AUDIT_SNAPSHOT_MAX)
        .map(snapshotIntakeAuditEntry),
    };
  }

  async function loadThoughts(project) {
    return thoughtStore.get(project);
  }

  /**
   * Bounded snapshot view: text rows (newest first, max 50, deleted filtered
   * out first) plus the additive `deletedThoughtIds` (most recent 100).
   */
  async function thoughtSnapshot(project) {
    const state = await loadThoughts(project);
    const live = state.thoughts.filter((thought) => !thought.deletedAt);
    const deleted = state.thoughts
      .filter((thought) => thought.deletedAt)
      .sort((left, right) => right.deletedAt - left.deletedAt)
      .slice(0, DELETED_THOUGHT_IDS_MAX);
    // Newest first, max 50: the file keeps creation order (append-only).
    return {
      thoughts: live.slice(-THOUGHT_SNAPSHOT_MAX).reverse().map(thoughtRow),
      deletedThoughtIds: deleted.map((thought) => thought.id),
    };
  }

  /** Is the dispatched session observable, and is it running? */
  async function sessionObservation(sessionId) {
    const sessions = await readSessions();
    const summary = sessions.find((session) => session.sessionId === sessionId);
    if (summary) return { observed: true, running: summary.running === true };
    let agent;
    try {
      agent = ctx.get('agents')?.get?.(sessionId);
    } catch {
      agent = undefined;
    }
    if (agent) return { observed: true, running: agent.status === 'running' };
    return { observed: false, running: false };
  }

  /**
   * Snapshot-read reconciliation, idempotent:
   *   observed + running -> working (no write)
   *   observed, not running -> done (write once)
   *   claim marker (working + no session) -> failed after the grace
   *   never observed -> working until the grace elapses, then failed
   *   recorded/queued/cancelled -> never dispatched here; `cancelled` is terminal.
   * A `recorded` thought whose dispatch never completed gets the same failure.
   */
  async function reconcileThoughts(project) {
    const state = await loadThoughts(project);
    const at = clock();
    let changed = false;
    for (const thought of state.thoughts) {
      if (thought.status === 'recorded') {
        if (at - thought.updatedAt > thoughtGraceMs) {
          appendThoughtIntake(thought, { at, type: 'failed', actor: 'system' });
          changed = transitionThought(thought, 'failed', {
            at,
            error: 'the product manager session did not start',
          }) || changed;
        }
        continue;
      }
      // A drained thought is claimed as `working` with no session yet; if the
      // dispatch never links one within the grace, fail it instead of wedging
      // the queue forever.
      if (thought.status === 'working' && !thought.sessionId) {
        if (at - thought.updatedAt > thoughtGraceMs) {
          appendThoughtIntake(thought, { at, type: 'failed', actor: 'system' });
          changed = transitionThought(thought, 'failed', {
            at,
            error: 'the product manager session did not start',
          }) || changed;
        }
        continue;
      }
      if (thought.status !== 'working') continue;
      const observation = await sessionObservation(thought.sessionId);
      if (observation.running) continue;
      if (observation.observed) {
        // Cancel is terminal and wins over reconciliation; it never gets here
        // because a cancelled thought is not `working`.
        changed = transitionThought(thought, 'done', { at }) || changed;
      } else if (at - thought.updatedAt > thoughtGraceMs) {
        changed = transitionThought(thought, 'failed', {
          at,
          error: 'the product manager session did not start',
        }) || changed;
      }
    }
    if (changed) await thoughtStore.save(project, state);
    return state;
  }

  function thoughtExcerpt(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function thoughtPrompt(project, thought, member) {
    const role = ROLE_INDEX['product-manager'];
    const composition = composeAgentPrompt({ role, member: member ?? null });
    return [
      `# Thought intake — ${thought.id}`,
      `Project: ${project.title} (${project.path})`,
      'You are the staff product manager for this thought. The human captured it; you turn it into real Kanban tickets in Backlog.',
      composition ? `\n${composition}` : '',
      '',
      '## The thought (verbatim)',
      thought.text,
      '',
      '## Rules',
      '1. Read the board first (`board`, `list`) and the project docs you need.',
      '2. Decompose into 1–20 independently shippable tickets; choose type (`story`/`task`/`bug`/`spike`/`epic`), priority, role and labels that match the work; every description must carry numbered, testable acceptance criteria and a short evidence plan.',
      '3. Create every ticket with the kanban `create` action, in Backlog only. Do not move, claim, update, release, comment on, run or finish existing tickets. Do not write code or files.',
      '4. Research the project first: read the board and the project docs. Use the web only when the thought needs an external standard or best practice, and when you use it name the sources you relied on in the description you write (for example `Sources: <standard> — <url>`).',
      '5. Decide EPIC vs tickets-only before creating anything. Create an EPIC only when the thought needs two or more related tickets, a new feature, or a new project. A single small thought yields tickets only, with no EPIC. One well-specified ticket is tickets-only too, however many acceptance criteria it carries.',
      '6. When the thought qualifies, create exactly one EPIC first: `type: "epic"`, Backlog, with the full PRD in its description. Fill every required section — Vision, Problem, Users, Jobs to be done, Success metrics, Scope in, Scope out, Acceptance criteria, Risks, Dependencies, Rollout, Open questions — with real content: no blank headings, and no TBD outside Open questions. Keep it concise: stay far under the board\'s 20,000-character description limit; summarise rather than truncate. The same template ships as `docs/EPIC_PRD_TEMPLATE.md` in repositories that have it; the heading list here is authoritative everywhere.',
      '7. Link every child of the initiative with `parentId` set to that EPIC id. The EPIC itself has no `parentId`, no child may point at a foreign or non-existent parent, and tickets outside the initiative stay unlinked.',
      '8. Finish with a short summary: the EPIC id and its ticket ids, or — when no EPIC was created — say explicitly that tickets alone suffice and why, plus the rationale for the decision and anything deliberately left out.',
      '',
      '## Session contract',
      'This session is read-only on the workspace and tool-scoped: only read actions and `create` are allowed, and every created ticket lands in Backlog. If the tool rejects an action with `kanban/thought-read-only`, that is expected.',
    ].filter(Boolean).join('\n');
  }

  /** Staff-PM dispatch: one project-preset session, read-only, PM persona, task brief. */
  async function dispatchThought(project, board, thought) {
    const preset = await executionPreset(project);
    const sessionId = `session-${randomUUID()}`;
    let modelSelection;
    try {
      modelSelection = ctx.get('agentDefaultModel')?.currentSelection?.();
    } catch {
      modelSelection = undefined;
    }
    const agentOptions =
      modelSelection && typeof modelSelection.provider === 'string' && typeof modelSelection.model === 'string'
        ? {
            provider: modelSelection.provider,
            model: modelSelection.model,
            ...(typeof modelSelection.reasoningEffort === 'string' ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
          }
        : undefined;
    let handle;
    try {
      handle = await ctx.agents.create({
        sessionId,
        meta: {
          cwd: project.path,
          ...(preset.id ? { agentPreset: preset.id } : {}),
        },
        ...(agentOptions ? { agentOptions } : {}),
        ...(preset.mount ? { setup: async (agentCtx) => { await preset.mount(agentCtx); } } : {}),
      });
    } catch (error) {
      throw new ApiError(502, 'thought/session-failed', `Could not start an agent session: ${error instanceof Error ? error.message : String(error)}`);
    }
    const agentId = String(handle.agent.id);
    const member =
      board.team.members.find((candidate) => candidate.roleId === 'product-manager' && !candidate.paused) ??
      board.team.members.find((candidate) => candidate.roleId === 'product-manager') ??
      null;
    try {
      const presets = ctx.get('permissionPresets');
      const liveSession = handle.agent?.session ?? ctx.get('sessions')?.get?.(agentId);
      if (presets && typeof presets.set === 'function' && liveSession) {
        presets.set(liveSession, readOnlyAccessValue());
      }
      await project.attachSession?.(agentId);
      try {
        const live = ctx.get('sessions')?.get?.(agentId);
        const titles = ctx.get('sessionTitle');
        if (live && titles && typeof titles.rename === 'function') {
          titles.rename(live, `Thought ${thought.id} · ${thoughtExcerpt(thought.text)}`.slice(0, 120));
        }
      } catch {
        // title is cosmetic; never fail the dispatch over it
      }
      ensureBoardAgent(board, agentId, {
        name: member?.name ?? 'Product Manager',
        role: 'product-manager',
        ...(member ? { memberId: member.id } : {}),
      });
      if (member) {
        member.sessionId = agentId;
        member.updatedAt = now();
      }
      await promptSession(agentId, thoughtPrompt(project, thought, member));
      return agentId;
    } catch (error) {
      // No partial linkage: drop the in-memory agent entry and stop the session.
      delete board.agents[agentId];
      try {
        ctx.sessionController?.cancel?.({ sessionId: agentId });
      } catch {
        // best effort
      }
      try {
        await handle?.dispose?.();
      } catch {
        // best effort
      }
      throw error instanceof ApiError
        ? error
        : new ApiError(502, 'thought/prompt-failed', `The product manager session started but the prompt was rejected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Create a persisted thought row (creation order = array order). */
  function newThoughtRow(state, { text, status, retryOf = null, audit }) {
    const at = clock();
    const number = Number.isInteger(state.nextNumber) && state.nextNumber > 0 ? state.nextNumber : 1;
    state.nextNumber = number + 1;
    const thought = {
      id: `TH-${number}`,
      text,
      status,
      createdAt: at,
      updatedAt: at,
      sessionId: null,
      error: '',
      ticketIds: [],
      ...(retryOf ? { retryOf } : {}),
    };
    if (audit) appendThoughtAudit(thought, { at, ...audit });
    return thought;
  }

  /** Find a live (not deleted) thought; a deleted row behaves as not-found. */
  function findThought(state, thoughtId) {
    const id = typeof thoughtId === 'string' ? thoughtId.trim() : '';
    const thought = state.thoughts.find((candidate) => candidate.id === id && !candidate.deletedAt);
    if (!thought) throw new ApiError(404, 'thought/not-found', `Unknown thought: ${id || '(missing)'}`);
    return thought;
  }

  function workingThoughts(state) {
    return state.thoughts.filter((thought) => thought.status === 'working').length;
  }

  /**
   * Queue drain, serialized per workspace: `resumeBoard` and concurrent snapshot
   * reads share this lock, so each queued thought is claimed + dispatched once.
   */
  const thoughtDrains = new Map();

  function drainThoughtQueue(project, board) {
    const key = String(project.id);
    const previous = thoughtDrains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => drainThoughtQueueInner(project, board));
    thoughtDrains.set(key, next);
    return next.finally(() => {
      if (thoughtDrains.get(key) === next) thoughtDrains.delete(key);
    });
  }

  async function drainThoughtQueueInner(project, board) {
    if (board.paused) return;
    const state = await loadThoughts(project);
    for (;;) {
      if (board.paused) return;
      // The working cap is enforced here, not at capture: overflow stays queued.
      if (workingThoughts(state) >= THOUGHT_WORKING_LIMIT) return;
      const next = state.thoughts.find((thought) => thought.status === 'queued' && !thought.deletedAt);
      if (!next) return;
      // Claim-before-dispatch: persist `working` with no session first, so a
      // drain that dies before linking a session is reconciled after the grace.
      transitionThought(next, 'working', { actor: 'system', at: clock() });
      next.sessionId = null;
      await thoughtStore.save(project, state);
      try {
        next.sessionId = await dispatchThought(project, board, next);
        next.updatedAt = clock();
        appendThoughtIntake(next, {
          at: clock(),
          type: 'dispatched',
          actor: 'pm-session',
          sessionId: next.sessionId,
        });
        await thoughtStore.save(project, state);
        await store.save(board);
      } catch (error) {
        // A failed drain marks only its own row failed and never blocks the queue.
        next.sessionId = null;
        appendThoughtIntake(next, { at: clock(), type: 'failed', actor: 'system' });
        transitionThought(next, 'failed', {
          actor: 'system',
          at: clock(),
          error: error instanceof Error ? error.message : String(error),
        });
        await thoughtStore.save(project, state);
      }
    }
  }

  /**
   * Per-workspace intake lock (KB-6). Duplicate detection, budget accounting and
   * row creation must observe one state atomically. The plugin is a single-Host
   * product, so a per-workspace promise chain is the whole critical section: the
   * second of two identical racing submissions sees the first persisted row and
   * answers 409 instead of creating a twin.
   */
  const thoughtIntakes = new Map();

  function withThoughtIntake(project, work) {
    const key = String(project.id);
    const previous = thoughtIntakes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    thoughtIntakes.set(key, next);
    return next.finally(() => {
      if (thoughtIntakes.get(key) === next) thoughtIntakes.delete(key);
    });
  }

  /**
   * AC 2/AC 4: one normalized match inside the 10-minute window, scanning at
   * most the newest 20 non-failed, non-deleted rows. The window is authoritative
   * for expiry (AC 4 accepts the same text again once it has elapsed), so it
   * gates the match; the newest-20 cohort is the scan bound that keeps detection
   * cheap on a long store. `failed` rows are excluded so a dispatch failure is
   * recoverable by resubmission, and soft-deleted rows never match.
   */
  function findDuplicateThought(state, normalized, at) {
    let scanned = 0;
    for (let index = state.thoughts.length - 1; index >= 0 && scanned < THOUGHT_DUPLICATE_RECENT; index -= 1) {
      const thought = state.thoughts[index];
      if (thought.deletedAt || thought.status === 'failed') continue;
      scanned += 1;
      if (at - thought.createdAt > THOUGHT_DUPLICATE_WINDOW_MS) continue;
      if (normalizeThoughtText(thought.text) === normalized) return thought;
    }
    return null;
  }

  /**
   * AC 6: per-workspace intake budget over the injected clock. Returns the retry
   * hint when the submission must be rejected with 429 `thought/rate-limit`.
   * Reading never mutates the persisted log.
   */
  function intakeBudgetBlock(state, at) {
    const log = (Array.isArray(state.rateLog) ? state.rateLog : [])
      .filter((entry) => Number.isFinite(entry) && entry <= at && at - entry < THOUGHT_RATE_HOUR_MS)
      .sort((left, right) => left - right);
    const minute = log.filter((entry) => at - entry < THOUGHT_RATE_MINUTE_MS);
    if (minute.length >= thoughtRateLimits.perMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((minute[0] + THOUGHT_RATE_MINUTE_MS - at) / 1000));
      return {
        retryAfterSeconds,
        message: `${thoughtRateLimits.perMinute} thoughts per minute is the limit. Try again in ${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}.`,
      };
    }
    if (log.length >= thoughtRateLimits.perHour) {
      const retryAfterSeconds = Math.max(1, Math.ceil((log[0] + THOUGHT_RATE_HOUR_MS - at) / 1000));
      const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
      return {
        retryAfterSeconds,
        message: `${thoughtRateLimits.perHour} thoughts per hour is the limit. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      };
    }
    return null;
  }

  /** AC 6: only an accepted submission consumes budget; the log is pruned to one hour. */
  function recordIntakeBudget(state, at) {
    const log = (Array.isArray(state.rateLog) ? state.rateLog : []).filter(
      (entry) => Number.isFinite(entry) && at - entry < THOUGHT_RATE_HOUR_MS,
    );
    log.push(at);
    state.rateLog = log.slice(-THOUGHT_RATE_LOG_MAX);
  }

  async function submitThought({ workspaceId, text }) {
    // AC 7 check order, part 1: boundary validation before any workspace read.
    if (typeof text !== 'string') throw badRequest('Thought text must be a string.');
    const trimmed = text.trim();
    if (!trimmed) throw new ApiError(400, 'thought/empty', 'Type a thought before sending it.');
    if (trimmed.length > THOUGHT_TEXT_MAX) {
      throw new ApiError(400, 'thought/too-long', `A thought is limited to ${THOUGHT_TEXT_MAX} characters.`);
    }
    const { project } = await loadProject(workspaceId);
    return withThoughtIntake(project, async () => {
      const board = await store.ensure(project);
      const state = await loadThoughts(project);
      const at = clock();
      // AC 7, part 2: duplicate before the rate budget and before every write.
      const duplicate = findDuplicateThought(state, normalizeThoughtText(trimmed), at);
      if (duplicate) {
        throw new ApiError(
          409,
          'thought/duplicate',
          `This thought duplicates ${duplicate.id}: "${thoughtExcerpt(duplicate.text)}". Edit or delete ${duplicate.id} before resubmitting it.`,
        );
      }
      // AC 7, part 3: rate budget before paused/queue and before the working cap.
      const blocked = intakeBudgetBlock(state, at);
      if (blocked) throw new ApiError(429, 'thought/rate-limit', blocked.message);
      if (board.paused) {
        // Captured while paused: queue instead of dispatching. The 3-working cap
        // is deferred to drain; only the paused queue cap applies here.
        const queued = state.thoughts.filter((thought) => thought.status === 'queued' && !thought.deletedAt).length;
        if (queued >= THOUGHT_QUEUE_MAX) {
          throw new ApiError(
            409,
            'thought/queue-full',
            `The paused queue is full (${THOUGHT_QUEUE_MAX}). Resume the board to drain it.`,
          );
        }
        recordIntakeBudget(state, at);
        const thought = newThoughtRow(state, { text: trimmed, status: 'queued' });
        appendThoughtIntake(thought, { at: thought.createdAt, type: 'submitted', actor: 'human' });
        appendThoughtAudit(thought, { at: thought.createdAt, type: 'status', actor: 'You', to: 'queued' });
        state.thoughts.push(thought);
        await thoughtStore.save(project, state);
        return { thought: thoughtRow(thought) };
      }
      if (workingThoughts(state) >= THOUGHT_WORKING_LIMIT) {
        throw new ApiError(
          409,
          'thought/limit',
          `${THOUGHT_WORKING_LIMIT} thoughts are already being processed. Wait for one to finish before adding another.`,
        );
      }
      recordIntakeBudget(state, at);
      const thought = newThoughtRow(state, { text: trimmed, status: 'recorded' });
      appendThoughtIntake(thought, { at: thought.createdAt, type: 'submitted', actor: 'human' });
      appendThoughtAudit(thought, { at: thought.createdAt, type: 'status', actor: 'You', to: 'recorded' });
      state.thoughts.push(thought);
      await thoughtStore.save(project, state);
      try {
        thought.sessionId = await dispatchThought(project, board, thought);
        appendThoughtIntake(thought, {
          at: clock(),
          type: 'dispatched',
          actor: 'pm-session',
          sessionId: thought.sessionId,
        });
        transitionThought(thought, 'working', { actor: 'system', at: clock() });
        await thoughtStore.save(project, state);
        // Persist only the additive agent registry entry, never board.thoughts.
        await store.save(board);
        return { thought: thoughtRow(thought) };
      } catch (error) {
        thought.sessionId = null;
        appendThoughtIntake(thought, { at: clock(), type: 'failed', actor: 'system' });
        transitionThought(thought, 'failed', {
          actor: 'system',
          at: clock(),
          error: error instanceof Error ? error.message : String(error),
        });
        await thoughtStore.save(project, state);
        return { thought: thoughtRow(thought) };
      }
    });
  }

  /**
   * Retry a failed thought as a NEW linked row. The original is never mutated:
   * retry history is the two rows themselves plus `retryOf` on the new row.
   */
  async function retryThought({ workspaceId, thoughtId }) {
    const { project, board } = await loadProject(workspaceId);
    const state = await loadThoughts(project);
    const original = findThought(state, thoughtId);
    if (board.paused) {
      throw new ApiError(423, 'board/paused', 'The board is paused. Resume it before retrying a thought.');
    }
    if (workingThoughts(state) >= THOUGHT_WORKING_LIMIT) {
      throw new ApiError(
        409,
        'thought/limit',
        `${THOUGHT_WORKING_LIMIT} thoughts are already being processed. Wait for one to finish before retrying.`,
      );
    }
    if (original.status !== 'failed') {
      throw new ApiError(409, 'thought/not-retryable', `Only a failed thought can be retried; ${original.id} is ${original.status}.`);
    }
    const thought = newThoughtRow(state, {
      text: original.text,
      status: 'recorded',
      retryOf: original.id,
      audit: { type: 'status', actor: 'You', to: 'recorded' },
    });
    appendThoughtAudit(thought, { at: clock(), type: 'retry', actor: 'You', thoughtId: original.id });
    state.thoughts.push(thought);
    await thoughtStore.save(project, state);
    try {
      thought.sessionId = await dispatchThought(project, board, thought);
      appendThoughtIntake(thought, {
        at: clock(),
        type: 'dispatched',
        actor: 'pm-session',
        sessionId: thought.sessionId,
      });
      transitionThought(thought, 'working', { actor: 'system', at: clock() });
      await thoughtStore.save(project, state);
      await store.save(board);
      return { thought: thoughtRow(thought) };
    } catch (error) {
      // A failed retry dispatch leaves only the new row failed; the original
      // keeps its own error/tickets/timestamps untouched.
      thought.sessionId = null;
      appendThoughtIntake(thought, { at: clock(), type: 'failed', actor: 'system' });
      transitionThought(thought, 'failed', {
        actor: 'system',
        at: clock(),
        error: error instanceof Error ? error.message : String(error),
      });
      await thoughtStore.save(project, state);
      return { thought: thoughtRow(thought) };
    }
  }

  /** Cancel a working thought: stop the session, keep its created tickets. */
  async function cancelThought({ workspaceId, thoughtId }) {
    const { project } = await loadProject(workspaceId);
    const state = await loadThoughts(project);
    const thought = findThought(state, thoughtId);
    if (thought.status === 'cancelled') {
      // Idempotent: same state, no second audit entry.
      return { thought: thoughtRow(thought) };
    }
    if (thought.status !== 'working') {
      throw new ApiError(409, 'thought/not-cancellable', `Only a working thought can be cancelled; ${thought.id} is ${thought.status}.`);
    }
    try {
      if (thought.sessionId) ctx.sessionController.cancel({ sessionId: thought.sessionId });
    } catch {
      // Best effort on the live session: the row still terminates as cancelled,
      // so cancel wins over later reconciliation.
    }
    transitionThought(thought, 'cancelled', { actor: 'You', at: clock() });
    await thoughtStore.save(project, state);
    return { thought: thoughtRow(thought) };
  }

  /** Edit the text of a queued/failed/cancelled thought; never dispatches. */
  async function editThought({ workspaceId, thoughtId, text }) {
    if (typeof text !== 'string') throw badRequest('Thought text must be a string.');
    const trimmed = text.trim();
    if (!trimmed) throw new ApiError(400, 'thought/empty', 'Type a thought before saving it.');
    if (trimmed.length > THOUGHT_TEXT_MAX) {
      throw new ApiError(400, 'thought/too-long', `A thought is limited to ${THOUGHT_TEXT_MAX} characters.`);
    }
    const { project } = await loadProject(workspaceId);
    const state = await loadThoughts(project);
    const thought = findThought(state, thoughtId);
    if (!['queued', 'failed', 'cancelled'].includes(thought.status)) {
      throw new ApiError(409, 'thought/not-editable', `A ${thought.status} thought cannot be edited; it has already been processed.`);
    }
    const at = clock();
    const previous = thought.text;
    thought.text = trimmed;
    thought.updatedAt = at;
    thought.editedAt = at;
    appendThoughtAudit(thought, {
      at,
      type: 'edit',
      actor: 'You',
      previous: clip(previous, THOUGHT_EDIT_EXCERPT_MAX),
      new: clip(trimmed, THOUGHT_EDIT_EXCERPT_MAX),
    });
    await thoughtStore.save(project, state);
    return { thought: thoughtRow(thought) };
  }

  /**
   * Soft-delete a thought: the row stays in the store (with `deletedAt`), leaves
   * `snapshot.thoughts`, and its id joins `deletedThoughtIds`. Repeating the
   * call is an idempotent no-op with no second audit entry.
   */
  async function deleteThought({ workspaceId, thoughtId }) {
    const { project } = await loadProject(workspaceId);
    const state = await loadThoughts(project);
    const id = typeof thoughtId === 'string' ? thoughtId.trim() : '';
    const thought = state.thoughts.find((candidate) => candidate.id === id);
    if (!thought) throw new ApiError(404, 'thought/not-found', `Unknown thought: ${id || '(missing)'}`);
    if (thought.deletedAt) return { deleted: true, thought: thoughtRow(thought) };
    if (thought.status === 'working') {
      throw new ApiError(409, 'thought/working', `${thought.id} is still working; cancel it before deleting.`);
    }
    const at = clock();
    thought.deletedAt = at;
    thought.updatedAt = at;
    appendThoughtAudit(thought, { at, type: 'delete', actor: 'You', from: thought.status });
    await thoughtStore.save(project, state);
    return { deleted: true, thought: thoughtRow(thought) };
  }

  function requireUserMoveContext(board, user) {
    if (!user && board.paused) {
      throw new ApiError(423, 'board/paused', 'The board is paused. Resume it before moving tickets.');
    }
  }

  async function actionMove({ workspaceId, payload, user = false, actor = 'user' }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, payload.ticketId);
    requireUserMoveContext(board, user);
    const target = String(payload.column ?? '');
    // KB-73 AC 5: a rejected review move is a recorded policy error, not something
    // the caller retries until it happens to find a legal edge. Persist the attempt
    // before rethrowing so the pulse/snapshot shows why the gate did not move.
    const reviewMove = ticket.column === 'review' && !user;
    try {
      validateMove(ticket, target, user ? 'tech-lead' : actor.role, actor, { user });
    } catch (error) {
      if (reviewMove && error && typeof error.code === 'string') {
        const policyText = `${ticket.column} → ${target} rejected (${error.code}): ${error.message}`.slice(0, 600);
        pushTicketActivity(ticket, withActor(actor.name), 'move-rejected', policyText.slice(0, 300));
        pushBoardActivity(board, withActor(actor.name), 'ticket/move-rejected', `${ticket.id}: ${policyText}`, ticket.id);
        await store.save(board);
      }
      throw error;
    }
    if (!user) {
      const active = activeTicketOf(board, actor.sessionId);
      if (active && active.id !== ticket.id) {
        throw new ApiError(409, 'agent/wip-limit', `${actor.name} already has ${active.id} in flight. Finish it before pulling another ticket.`);
      }
    }
    if (!user) {
      if (target === 'ready') assertAutopilotRefineHeadroom(board, ticket, actor);
      enforceWip(board, target);
    } else {
      const limit = store.wip[target] ?? 0;
      if (limit > 0) {
        const count = board.tickets.filter((candidate) => candidate.column === target).length;
        if (count >= limit) {
          pushBoardActivity(board, 'You', 'ticket/override', `Moved ${ticket.id} into ${target} over the WIP limit (${count}/${limit})`, ticket.id);
        }
      }
    }
    const from = ticket.column;
    // KB-75 AC 2/AC 4: a lane move is a progress signal that resets the
    // consecutive-failure counter, so a ticket a human moved is never parked by
    // stale failure history.
    resetAutopilotTicketFailure(ticket, `the ticket moved ${from} → ${target}`);
    ticket.column = target;
    ticket.movedAt = now();
    ticket.updatedAt = now();
    if (ticket.execution) {
      ticket.execution.updatedAt = now();
      ticket.execution.report = ticket.execution.report || '';
    }
    if (target === 'done') {
      ticket.acceptedAt = now();
      if (ticket.execution && !['done', 'cancelled'].includes(ticket.execution.status)) {
        ticket.execution.status = 'done';
        ticket.execution.finishedAt = now();
        ticket.execution.updatedAt = now();
        ticket.execution.report = ticket.execution.report || 'Completed by the user.';
      }
    }
    if (target === 'backlog' || target === 'ready') {
      ticket.acceptedAt = null;
      if (from === 'in_progress' || from === 'review') {
        if (ticket.owner) pushTicketActivity(ticket, withActor(actor.name), 'unassign', `Unassigned from ${ticket.owner.name} on return to ${target}`);
        ticket.owner = null;
      }
    }
    applyAutoAssignment(board, ticket, target, `Moved ${from} → ${target}`);
    // KB-73 AC 5: a changes-requested handback must reach the implementation role,
    // not the review lane, so the next implement pass (and KB-74's context pack)
    // knows exactly who owns the rework. applyAutoAssignment clears In Progress
    // assignments by design, so the handback assignment is written after it.
    if (from === 'review' && target === 'in_progress') {
      const handbackRole = reviewHandbackRole(ticket);
      if (ticket.owner) {
        pushTicketActivity(ticket, withActor(actor.name), 'unassign', `Unassigned from reviewer ${ticket.owner.name} on change-request handback`);
        ticket.owner = null;
      }
      ticket.assignment = {
        role: handbackRole,
        accessMode: suggestedAccessMode({ ...ticket, column: 'in_progress' }, handbackRole),
        agentSessionId: null,
        agentName: null,
        memberId: null,
        auto: true,
        reason: `Changes requested by review: hand back to ${ROLE_INDEX[handbackRole]?.name ?? handbackRole}`,
        at: now(),
      };
      pushTicketActivity(
        ticket,
        withActor(actor.name),
        'changes-requested',
        `Review requested changes; assigned to ${ROLE_INDEX[handbackRole]?.name ?? handbackRole} for the handback`,
      );
    }
    pushTicketActivity(ticket, withActor(actor.name), 'move', `${from} → ${target}${payload.note ? ` — ${clampString(payload.note, 300)}` : ''}`);
    pushBoardActivity(board, withActor(actor.name), 'ticket/move', `${ticket.id}: ${from} → ${target}`, ticket.id);
    await store.save(board);
    return { ticket };
  }

  async function actionClaim({ workspaceId, payload, actor }) {
    const { board } = await loadProject(workspaceId);
    if (board.paused) throw new ApiError(423, 'board/paused', 'The board is paused. Resume it before claiming work.');
    const ticket = findTicket(board, payload.ticketId);
    // An EPIC is a container, never agent work: reject before any mutation.
    if (ticket.type === 'epic') throw epicNotClaimable();
    if (ticket.owner && ticket.owner.sessionId !== actor.sessionId) {
      throw new ApiError(409, 'ticket/claimed', `${ticket.id} is already owned by ${ticket.owner.name}.`);
    }
    if (ticket.owner?.sessionId === actor.sessionId) {
      // An execution session is already the owner at dispatch; claiming it is the
      // signal to advance from its start lane (backlog→ready, ready→in_progress).
      const target = ticket.column === 'backlog' ? 'ready' : ticket.column === 'ready' ? 'in_progress' : ticket.column;
      if (ticket.execution?.sessionId === actor.sessionId && target !== ticket.column) {
        assertAutopilotRefineHeadroom(board, ticket, actor);
        enforceWip(board, target);
        const from = ticket.column;
        resetAutopilotTicketFailure(ticket, `the ticket was claimed and moved ${from} → ${target}`);
        ticket.column = target;
        ticket.movedAt = now();
        ticket.updatedAt = now();
        if (ticket.execution) ticket.execution.updatedAt = now();
        applyAutoAssignment(board, ticket, target, `Claimed ${from} → ${target}`);
        pushTicketActivity(ticket, actor.name, 'claim', `Claimed and moved ${from} → ${target}`);
        pushBoardActivity(board, actor.name, 'ticket/claim', `${ticket.id} claimed by ${actor.name}`, ticket.id);
        await store.save(board);
      }
      return { ticket, alreadyOwned: true };
    }
    const role = actor.role;
    const executionAuthorized = ticket.execution?.sessionId === actor.sessionId;
    const claimable = ROLE_INDEX[role]?.claimColumns ?? [];
    if (!executionAuthorized && role !== 'tech-lead' && !claimable.includes(ticket.column)) {
      throw new ApiError(403, 'ticket/role-forbidden', `${ROLE_INDEX[role]?.name ?? role} pulls from ${claimable.join(', ') || 'nothing'}; ${ticket.id} is in ${ticket.column}.`);
    }
    const refinement = ticket.column === 'backlog' && role === 'product-manager';
    if (!executionAuthorized && ticket.column !== 'review' && !refinement && !roleMatches(role, ticket.role)) {
      throw new ApiError(403, 'ticket/role-forbidden', `${ticket.id} needs ${ROLE_INDEX[ticket.role]?.name ?? ticket.role ?? 'a developer'}; you are ${ROLE_INDEX[role]?.name ?? role}.`);
    }
    if (ticket.blocked) throw new ApiError(409, 'ticket/blocked', `${ticket.id} is blocked: ${ticket.blockReason || 'no reason recorded'}.`);
    const active = activeTicketOf(board, actor.sessionId);
    if (active && active.id !== ticket.id) {
      throw new ApiError(409, 'agent/wip-limit', `${actor.name} already has ${active.id} in flight. WIP per agent is 1.`);
    }
    const target = ticket.column === 'backlog' ? 'ready' : ticket.column === 'ready' ? 'in_progress' : ticket.column;
    if (target !== ticket.column) {
      assertAutopilotRefineHeadroom(board, ticket, actor);
      enforceWip(board, target);
    }
    ticket.owner = refinement
      ? null
      : {
          sessionId: actor.sessionId,
          name: actor.name,
          role,
          ...(actor.memberId ? { memberId: actor.memberId } : {}),
        };
    ticket.role = ticket.role ?? (DEV_ROLES.has(role) ? role : null);
    const from = ticket.column;
    if (target !== from) {
      // KB-75 AC 2: claiming-and-moving is progress; it clears a stale failure
      // counter so the loop guard never parks a ticket that is advancing.
      resetAutopilotTicketFailure(ticket, `the ticket was claimed and moved ${from} → ${target}`);
      ticket.column = target;
      ticket.movedAt = now();
      if (target === 'in_progress') ticket.acceptedAt = null;
    }
    ticket.updatedAt = now();
    if (target !== from) applyAutoAssignment(board, ticket, target, `Claimed ${from} → ${target}`);
    pushTicketActivity(ticket, actor.name, 'claim', `Claimed by ${actor.name} (${ROLE_INDEX[role]?.name ?? role})${target !== from ? ` and moved ${from} → ${target}` : ''}`);
    pushBoardActivity(board, actor.name, 'ticket/claim', `${ticket.id} claimed by ${actor.name}`, ticket.id);
    await store.save(board);
    return { ticket };
  }

  async function actionRelease({ workspaceId, payload, actor }) {
    const { board } = await loadProject(workspaceId);
    if (board.paused) throw new ApiError(423, 'board/paused', 'The board is paused.');
    const ticket = findTicket(board, payload.ticketId);
    if (ticket.owner?.sessionId !== actor.sessionId && actor.role !== 'tech-lead') {
      throw new ApiError(403, 'ticket/role-forbidden', `Only ${ticket.owner?.name ?? 'the owner'} can release ${ticket.id}.`);
    }
    const from = ticket.column;
    ticket.owner = null;
    if (ticket.column === 'in_progress' || ticket.column === 'review') {
      ticket.column = 'ready';
      ticket.movedAt = now();
      ticket.acceptedAt = null;
    }
    ticket.updatedAt = now();
    if (from !== ticket.column) applyAutoAssignment(board, ticket, ticket.column, `Released ${from} → ${ticket.column}`);
    pushTicketActivity(ticket, actor.name, 'release', `Released${from !== ticket.column ? ` and moved ${from} → ${ticket.column}` : ''}`);
    pushBoardActivity(board, actor.name, 'ticket/release', `${ticket.id} released`, ticket.id);
    await store.save(board);
    return { ticket };
  }

  async function actionComment({ workspaceId, payload, actor }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, payload.ticketId);
    const text = clampString(payload.text, 4000);
    if (!text) throw badRequest('Comment text is required.');
    ticket.comments.push({ id: uid(), author: withActor(actor.name), text, at: now() });
    ticket.comments = ticket.comments.slice(-100);
    ticket.updatedAt = now();
    pushTicketActivity(ticket, actor.name, 'comment', text.slice(0, 200));
    // KB-75 AC 2/AC 4: a comment by anyone other than the autopilot executor is a
    // human action for the loop guard (KB-67 §6.8), so it resets the counter.
    if (actor.name !== 'autopilot') resetAutopilotTicketFailure(ticket, 'a human comment was added');
    await store.save(board);
    return { ticket };
  }

  /**
   * KB-73 AC 1/AC 4/AC 5: record one structured review verdict. Inputs are
   * validated at the boundary (closed verdict set, bounded notes/evidence, refs
   * restricted to the ticket's own numbered criteria), the reviewer identity is
   * stamped from the calling session (never trusted from the payload), and the
   * row is persisted in `ticket.reviews` newest-first/capped so it survives the
   * later move and the finish report being overwritten.
   */
  async function actionRecordReview({ workspaceId, ticketId, payload, actor }) {
    const { board } = await loadProject(workspaceId);
    if (board.paused) throw new ApiError(423, 'board/paused', 'The board is paused. Resume it before recording a review verdict.');
    const ticket = findTicket(board, ticketId);
    if (ticket.column !== 'review') {
      throw new ApiError(409, 'ticket/review-lane', `${ticket.id} is in ${LANE_LABEL[ticket.column]}; a verdict can only be recorded while it is in Review.`);
    }
    const execution = ticket.execution;
    const sessionOwns = Boolean(
      execution && execution.sessionId === actor.sessionId,
    ) || ticket.owner?.sessionId === actor.sessionId;
    if (!sessionOwns && actor.role !== 'tech-lead' && !actor.isLead) {
      throw new ApiError(403, 'ticket/role-forbidden', `Only the reviewing execution session can record a verdict on ${ticket.id}.`);
    }
    if (!sessionOwns && !['reviewer', 'tester', 'tech-lead'].includes(actor.role) && !actor.isLead) {
      throw new ApiError(403, 'ticket/role-forbidden', `${ROLE_INDEX[actor.role]?.name ?? actor.role} cannot review ${ticket.id}.`);
    }
    const verdict = clampString(payload?.verdict, 40);
    if (!TICKET_REVIEW_VERDICTS.includes(verdict)) {
      throw new ApiError(
        400,
        'ticket/review-invalid',
        `verdict must be one of ${TICKET_REVIEW_VERDICTS.join(' | ')}; found ${JSON.stringify(payload?.verdict ?? null)}.`,
      );
    }
    const notes = clampString(payload?.notes, REVIEW_NOTES_MAX);
    const refs = acceptanceCriteriaRefs(ticket.description);
    const refSet = new Set(refs.map((ref) => ref.ref));
    const criteria = [];
    const seenRefs = new Set();
    const criteriaRaw = Array.isArray(payload?.criteria) ? payload.criteria : [];
    for (const entry of criteriaRaw.slice(0, TICKET_REVIEW_CRITERIA_MAX)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const ref = clampString(entry.ref, 20);
      if (!ref || seenRefs.has(ref)) continue;
      if (refSet.size > 0 && !refSet.has(ref)) {
        throw new ApiError(
          400,
          'ticket/review-invalid',
          `criterion ref ${JSON.stringify(ref)} is not a numbered acceptance criterion on ${ticket.id} (expected ${[...refSet].join(', ')}).`,
        );
      }
      seenRefs.add(ref);
      const note = clampString(entry.note, REVIEW_CRITERION_NOTE_MAX);
      criteria.push({ ref, passed: entry.passed === true, ...(note ? { note } : {}) });
    }
    const evidence = Array.isArray(payload?.evidence)
      ? payload.evidence
          .filter((value) => typeof value === 'string')
          .map((value) => clampString(value, REVIEW_EVIDENCE_MAX))
          .filter(Boolean)
          .slice(0, TICKET_REVIEW_EVIDENCE_MAX)
      : [];
    if (verdict === 'accepted') {
      if (refs.length > 0) {
        const missing = refs.filter((ref) => !criteria.some((entry) => entry.ref === ref.ref && entry.passed)).map((ref) => ref.ref);
        if (missing.length > 0) {
          throw new ApiError(
            400,
            'ticket/review-invalid',
            `an accepted verdict must map every numbered criterion as passed; missing ${missing.join(', ')}.`,
          );
        }
      } else if (!criteria.some((entry) => entry.passed)) {
        throw new ApiError(
          400,
          'ticket/review-invalid',
          `an accepted verdict needs at least one passed criterion: ${ticket.id} has no numbered acceptance criteria to map.`,
        );
      }
    } else {
      if (!notes) {
        throw new ApiError(400, 'ticket/review-invalid', 'a changes-requested verdict needs at least one blocking note in notes.');
      }
      if (!criteria.some((entry) => entry.passed !== true)) {
        throw new ApiError(400, 'ticket/review-invalid', 'a changes-requested verdict needs at least one passed:false criterion.');
      }
    }
    const memberId = ticket.owner?.memberId ?? null;
    const review = {
      id: uid(),
      at: now(),
      reviewerMemberId: memberId,
      reviewerName: actor.name,
      sessionId: actor.sessionId,
      verdict,
      notes,
      criteria,
      evidence,
    };
    ticket.reviews = normalizeReviews([review, ...(Array.isArray(ticket.reviews) ? ticket.reviews : [])]);
    // KB-74 AC 4: one readable comment per verdict, deduped by the verdict id on
    // write and on every later normalization/reload. Comments stay the human
    // record; the structured row is additive and never replaces them.
    ticket.comments = normalizeTicketComments([
      ...(Array.isArray(ticket.comments) ? ticket.comments : []),
      {
        id: uid(),
        author: withActor(actor.name),
        text: clampString(reviewVerdictCommentText(review), 4000),
        at: review.at,
        reviewId: review.id,
      },
    ]);
    ticket.updatedAt = now();
    const summary = verdict === 'accepted' ? 'accepted' : 'changes requested';
    // KB-75 AC 2/AC 4: a new review verdict is a human decision signal that
    // resets the ticket's consecutive-failure counter, even before the ticket is
    // moved out of Review.
    resetAutopilotTicketFailure(ticket, `a review verdict (${summary}) was recorded`);
    pushTicketActivity(ticket, withActor(actor.name), 'review-verdict', `Review verdict recorded: ${summary} (${criteria.length} criterion row(s), ${evidence.length} evidence item(s))`);
    pushBoardActivity(board, withActor(actor.name), 'ticket/review-verdict', `${ticket.id} review verdict: ${summary}`, ticket.id);
    await store.save(board);
    return { ticket, review };
  }

  async function actionUpdateBoardTicket({ workspaceId, ticketId, patch, actor }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    if (typeof patch.title === 'string') {
      const title = clampString(patch.title, 300);
      if (title) ticket.title = title;
    }
    if (typeof patch.description === 'string') ticket.description = patch.description.slice(0, 20000);
    const requestedType = TICKET_TYPES.includes(patch.type) ? patch.type : null;
    if (requestedType && requestedType !== ticket.type) {
      // Converting away from an EPIC would orphan its children; converting into
      // an EPIC must respect the "EPIC never parented / never running" invariant.
      if (ticket.type === 'epic' && requestedType !== 'epic') {
        const children = board.tickets.filter((candidate) => candidate.parentId === ticket.id).length;
        if (children > 0) throw epicHasChildren(children);
      }
      if (requestedType === 'epic') {
        if (ticket.parentId) throw parentInvalid('Clear the parent link before converting this ticket into an EPIC.');
        if (ticket.owner || ticket.execution?.sessionId) throw epicNotClaimable();
        if (ticket.column !== 'backlog') {
          const fromColumn = ticket.column;
          ticket.column = 'backlog';
          ticket.movedAt = now();
          pushTicketActivity(ticket, actor, 'move', `${fromColumn} → backlog (converted to EPIC)`);
        }
      }
      ticket.type = requestedType;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'parentId')) {
      // null/omit clears; a non-string or empty value is treated as absent, so it
      // can only ever clear a link — it never creates an invalid one.
      const nextParentId = resolveParentId(board, patch.parentId, { type: ticket.type, ticketId: ticket.id });
      if (nextParentId && nextParentId !== ticket.parentId) {
        ticket.parentId = nextParentId;
        pushTicketActivity(ticket, actor, 'parent', `Parent linked to ${nextParentId}`);
      } else if (!nextParentId && ticket.parentId) {
        delete ticket.parentId;
        pushTicketActivity(ticket, actor, 'parent', 'Parent link cleared');
      }
    }
    if (['low', 'medium', 'high', 'critical'].includes(patch.priority)) ticket.priority = patch.priority;
    if (patch.role === null) ticket.role = null;
    else if (ALL_ROLES.includes(patch.role)) ticket.role = patch.role;
    if (Array.isArray(patch.labels)) {
      ticket.labels = patch.labels.filter((label) => typeof label === 'string').slice(0, 12);
    }
    if (typeof patch.blocked === 'boolean') {
      ticket.blocked = patch.blocked;
      ticket.blockReason = patch.blocked ? clampString(patch.blockReason ?? ticket.blockReason, 1000) : '';
      if (!ticket.blocked) ticket.block = null;
      pushTicketActivity(ticket, actor, 'block', ticket.blocked ? `Blocked: ${ticket.blockReason || 'no reason'}` : 'Unblocked');
      // KB-75 AC 4: unblocking a parked ticket resets the loop-guard counter. A
      // manual block does not reset it (blocking is not progress); only the
      // unblock is the human decision that the ticket should be worked again.
      if (!ticket.blocked) resetAutopilotTicketFailure(ticket, 'the ticket was unblocked');
    }
    ticket.updatedAt = now();
    pushTicketActivity(ticket, actor, 'update', 'Ticket details updated');
    await store.save(board);
    return { ticket };
  }

  async function actionChecklist({ workspaceId, ticketId, op, text, itemId, actor }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    if (op === 'add') {
      const value = clampString(text, 300);
      if (!value) throw badRequest('Checklist text is required.');
      ticket.checklist.push({ id: uid(), text: value, done: false });
    } else if (op === 'toggle') {
      const item = ticket.checklist.find((candidate) => candidate.id === itemId);
      if (!item) throw notFound(`Unknown checklist item: ${itemId}`);
      item.done = !item.done;
    } else if (op === 'remove') {
      ticket.checklist = ticket.checklist.filter((candidate) => candidate.id !== itemId);
    } else {
      throw badRequest(`Unknown checklist operation: ${op}`);
    }
    ticket.checklist = ticket.checklist.slice(0, 40);
    ticket.updatedAt = now();
    pushTicketActivity(ticket, actor, 'checklist', `Checklist ${op}`);
    await store.save(board);
    return { ticket };
  }

  async function actionDelete({ workspaceId, ticketId, actor }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    // Deleting an EPIC would leave its children with a dangling parentId.
    if (ticket.type === 'epic') {
      const children = board.tickets.filter((candidate) => candidate.parentId === ticket.id).length;
      if (children > 0) throw epicHasChildren(children);
    }
    if (ticket.execution?.sessionId) {
      try {
        ctx.sessionController.cancel({ sessionId: ticket.execution.sessionId });
      } catch {
        // best effort
      }
    }
    board.tickets = board.tickets.filter((candidate) => candidate.id !== ticketId);
    pushBoardActivity(board, actor, 'ticket/delete', `Deleted ${ticket.id}: ${ticket.title}`);
    await store.save(board);
    return { deleted: true };
  }

  async function actionAssign({ workspaceId, ticketId, sessionId, actor }) {
    const { board, project } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    ticket.assignment = null;
    if (sessionId === null || sessionId === undefined) {
      ticket.owner = null;
      pushTicketActivity(ticket, actor, 'assign', 'Unassigned');
    } else {
      const actorKey = String(sessionId);
      const team = await snapshotTeam(project, board);
      const row = team.rows.find((member) => member.sessionId === actorKey);
      const member = row?.memberId ? board.team.members.find((candidate) => candidate.id === row.memberId) : null;
      const entry = board.agents?.[actorKey];
      const role = member?.roleId ?? (ALL_ROLES.includes(row?.role) ? row?.role : ALL_ROLES.includes(entry?.role) ? entry.role : null);
      ticket.owner = {
        sessionId: actorKey,
        name: member?.name ?? row?.name ?? entry?.name ?? `Agent ${actorKey.slice(-4)}`,
        role,
        ...(member ? { memberId: member.id } : {}),
      };
      if (!ticket.role && ticket.owner.role) ticket.role = ticket.owner.role;
      pushTicketActivity(ticket, actor, 'assign', `Assigned to ${ticket.owner.name}`);
    }
    ticket.updatedAt = now();
    await store.save(board);
    return { ticket };
  }

  async function actionPauseBoard({ workspaceId, actor, paused }) {
    const { board, project } = await loadProject(workspaceId);
    if (paused === board.paused) return { board };
    board.paused = paused;
    board.pausedAt = paused ? now() : null;
    board.pausedBy = paused ? actor : null;
    const sessions = (await readSessions()).filter((session) => isInside(session.cwd, project.path) && session.running);
    if (paused) {
      for (const session of sessions) {
        try {
          ctx.sessionController.cancel({ sessionId: session.sessionId });
        } catch {
          // best effort
        }
      }
      for (const ticket of board.tickets) {
        if (ticket.execution && ['running', 'idle'].includes(ticket.execution.status)) {
          ticket.execution.status = 'paused';
          ticket.execution.updatedAt = now();
        }
      }
      pushBoardActivity(board, actor, 'board/pause', `Board paused (${sessions.length} running agent${sessions.length === 1 ? '' : 's'} stopped)`);
      // KB-75 AC 5: the master stop needs an autopilot-specific, auditable row
      // with the actor and the injected-clock timestamp. Pausing is a safety
      // action that stops agent work; it does not switch autopilot off, so the
      // configuration and the budget counters are left exactly as they are.
      if (autopilotEnabled(board)) {
        pushBoardActivity(
          board,
          actor,
          'autopilot/paused',
          `Autopilot paused with the board: no further dispatches until the board is resumed (${sessions.length} running agent${sessions.length === 1 ? '' : 's'} stopped).`,
        );
      }
    } else {
      pushBoardActivity(board, actor, 'board/resume', 'Board resumed');
    }
    await store.save(board);
    // KB-70 AC 7: pausing leaves the timer armed (pulses become recorded no-ops);
    // resuming re-arms at now + cadence and marks the next pulse `trigger:'resume'`
    // so the first pulse runs the paused→idle bookkeeping repair. No burst.
    if (paused) {
      noteAutopilotBoard(board);
    } else if (autopilotEnabled(board)) {
      autopilotResumePulses.add(String(workspaceId));
      armAutopilotTimer(String(workspaceId), clock() + Math.max(AUTOPILOT_TICK_FLOOR_MS, board.autopilot.cadenceMs));
    } else {
      clearAutopilotTimer(String(workspaceId));
    }
    // Resuming drains the paused capture queue (FIFO, up to the working cap).
    if (!paused) await drainThoughtQueue(project, board);
    return { board };
  }

  /** Legacy agent-level lookup for pause/resume and role overrides. */
  async function legacyAgentRow(project, board, key) {
    const view = await snapshotTeam(project, board);
    const attached = view.rows.find((row) => row.sessionId === key);
    if (attached) return attached;
    const sessions = await readSessions();
    const observed = sessions.find(
      (session) => session.sessionId === key && owningWorkspace(session.cwd)?.id === String(project.id),
    );
    const live = liveAgentStatus(key);
    if (!observed && live === null) {
      throw new ApiError(404, 'agent/not-found', `No agent session ${key} belongs to this project.`);
    }
    const entry = board.agents?.[key];
    return {
      sessionId: key,
      name: entry?.name ?? (displayTitleName(observed?.title ?? '') || `Agent ${key.slice(-4)}`),
      role: ALL_ROLES.includes(entry?.role) ? entry.role : defaultAgentRole(entry?.name ?? ''),
      ticketId: null,
      memberId: null,
    };
  }

  async function actionAgentPause({ workspaceId, sessionId, actor, paused }) {
    const { board, project } = await loadProject(workspaceId);
    const key = String(sessionId);
    const row = await legacyAgentRow(project, board, key);
    const entry = ensureBoardAgent(board, key, { name: row.name, role: row.role });
    entry.paused = paused;
    if (paused) {
      try {
        ctx.sessionController.cancel({ sessionId: key });
      } catch {
        // best effort
      }
      pushBoardActivity(board, actor, 'agent/pause', `Paused ${row.name}`, row.ticketId ?? undefined);
    } else {
      pushBoardActivity(board, actor, 'agent/resume', `Resumed ${row.name}`, row.ticketId ?? undefined);
      const ticket = row.ticketId ? board.tickets.find((candidate) => candidate.id === row.ticketId) : null;
      if (ticket) {
        try {
          await ctx.sessionController.prompt({
            requestId: `kanban-resume-${uid()}`,
            sessionId: key,
            mode: 'queue',
            content: [
              {
                type: 'text',
                text: `Resume your Kanban work on ${ticket.id} "${ticket.title}" (${ticket.column}). Call the kanban tool with {"action":"whoami"} first; then continue.`,
              },
            ],
          }, AbortSignal.timeout(15000));
        } catch {
          // resuming a cold session may be unavailable; clearing the pause is enough
        }
      }
    }
    await store.save(board);
    return { board, team: (await snapshotTeam(project, board)).rows };
  }

  async function actionSetRole({ workspaceId, sessionId, role, actor }) {
    if (!ALL_ROLES.includes(role)) throw badRequest(`Unknown role: ${role}`);
    const { board, project } = await loadProject(workspaceId);
    const key = String(sessionId);
    const row = await legacyAgentRow(project, board, key);
    const entry = ensureBoardAgent(board, key, { name: row.name, role: row.role });
    entry.role = role;
    // A deliberate role override outlives the session's attachment so the next
    // tool call still resolves the same permissions after a snapshot read.
    entry.roleOverride = true;
    if (row.memberId) {
      const member = board.team.members.find((candidate) => candidate.id === row.memberId);
      if (member) {
        member.roleId = role;
        member.updatedAt = now();
      }
    }
    for (const ticket of board.tickets) {
      if (ticket.owner?.sessionId === key) ticket.owner.role = role;
    }
    pushBoardActivity(board, actor, 'agent/role', `Set ${row.name} role to ${ROLE_INDEX[role]?.name ?? role}`);
    await store.save(board);
    return { board, team: (await snapshotTeam(project, board)).rows };
  }

  // -- team roster actions -------------------------------------------------

  function validateMemberRole(value, fallback = null) {
    if (value === undefined || value === null || value === '') {
      if (fallback) return fallback;
      throw new ApiError(400, 'member/role-invalid', 'A team member needs a role from the catalog.');
    }
    if (!ALL_ROLES.includes(value)) {
      throw new ApiError(400, 'member/role-invalid', `Unknown role: ${value}. Roles are platform-owned; pick one of: ${ALL_ROLES.join(', ')}.`);
    }
    return value;
  }

  function createMemberRecord(board, input, { actor = 'user', source = 'manual' } = {}) {
    if (board.team.members.length >= ROSTER_LIMIT) {
      throw new ApiError(409, 'member/limit', `The roster is capped at ${ROSTER_LIMIT} members. Remove a member before adding another.`);
    }
    const name = clampString(input.name, MEMBER_NAME_MAX);
    if (!name) throw badRequest('A team member needs a name (1–48 characters).');
    if (memberNameTaken(board, name)) {
      throw new ApiError(409, 'member/name-taken', `A team member named "${name}" already exists.`);
    }
    const roleId = validateMemberRole(input.roleId ?? input.role);
    const at = now();
    const member = {
      id: `member-${uid().slice(0, 8)}`,
      name,
      title: clampString(input.title, MEMBER_TITLE_MAX) || ROLE_INDEX[roleId].name,
      roleId,
      persona: clampString(input.persona, PERSONA_MAX) || personaTemplate(roleId),
      paused: input.paused === true,
      sessionId: null,
      createdAt: at,
      updatedAt: at,
      createdBy: clampString(actor, 120) || 'user',
      source: source === 'ai' ? 'ai' : 'manual',
    };
    board.team.members.push(member);
    pushBoardActivity(board, actor, 'team/member-add', `Added team member ${member.name} (${ROLE_INDEX[roleId].name})`);
    return member;
  }

  async function actionCreateMember({ workspaceId, payload, actor }) {
    const { board } = await loadProject(workspaceId);
    const input = payload && typeof payload === 'object' ? payload : {};
    const member = createMemberRecord(board, input, { actor, source: 'manual' });
    await store.save(board);
    return { member };
  }

  async function actionUpdateMember({ workspaceId, memberId, patch, actor }) {
    const { board } = await loadProject(workspaceId);
    const member = findMember(board, String(memberId ?? ''));
    const changes = patch && typeof patch === 'object' ? patch : {};
    let changed = false;
    if (typeof changes.name === 'string') {
      const name = clampString(changes.name, MEMBER_NAME_MAX);
      if (!name) throw badRequest('A team member needs a name (1–48 characters).');
      if (memberNameTaken(board, name, member.id)) {
        throw new ApiError(409, 'member/name-taken', `A team member named "${name}" already exists.`);
      }
      if (name !== member.name) {
        member.name = name;
        changed = true;
      }
    }
    if (typeof changes.title === 'string') {
      const title = clampString(changes.title, MEMBER_TITLE_MAX);
      if (title !== member.title) {
        member.title = title;
        changed = true;
      }
    }
    if (typeof changes.roleId === 'string' || typeof changes.role === 'string') {
      const roleId = validateMemberRole(changes.roleId ?? changes.role);
      if (roleId !== member.roleId) {
        member.roleId = roleId;
        changed = true;
      }
    }
    if (typeof changes.persona === 'string') {
      const persona = clampString(changes.persona, PERSONA_MAX) || personaTemplate(member.roleId);
      if (persona !== member.persona) {
        member.persona = persona;
        changed = true;
      }
    }
    if (typeof changes.paused === 'boolean' && changes.paused !== member.paused) {
      member.paused = changes.paused;
      changed = true;
      if (member.paused && member.sessionId) {
        try {
          ctx.sessionController.cancel({ sessionId: member.sessionId });
        } catch {
          // best effort: clearing the pause flag is enough
        }
      }
      pushBoardActivity(
        board,
        actor,
        member.paused ? 'member/pause' : 'member/resume',
        `${member.paused ? 'Paused' : 'Resumed'} team member ${member.name}`,
      );
    }
    if (changed) {
      member.updatedAt = now();
      pushBoardActivity(board, actor, 'team/member-update', `Updated team member ${member.name}`);
      await store.save(board);
    }
    return { member };
  }

  async function actionDeleteMember({ workspaceId, memberId, force, actor }) {
    const { board } = await loadProject(workspaceId);
    const member = findMember(board, String(memberId ?? ''));
    const busyTicket = memberTicket(board, member);
    if (busyTicket && force !== true) {
      throw new ApiError(409, 'member/busy', `${member.name} owns ${busyTicket.id} (${busyTicket.column}). Finish or release it, or force-delete as tech lead.`);
    }
    if (member.sessionId) {
      try {
        ctx.sessionController.cancel({ sessionId: member.sessionId });
      } catch {
        // best effort
      }
    }
    for (const ticket of board.tickets) {
      if (ticket.owner?.memberId === member.id) ticket.owner.memberId = null;
      if (ticket.assignment?.memberId === member.id) ticket.assignment.memberId = null;
    }
    board.team.members = board.team.members.filter((candidate) => candidate.id !== member.id);
    pushBoardActivity(board, actor, 'team/member-remove', `Removed team member ${member.name}${busyTicket ? ` (force, owned ${busyTicket.id})` : ''}`);
    await store.save(board);
    return { deleted: true };
  }

  function actionRoleDetail({ payload }) {
    const roleId = String(payload?.roleId ?? '');
    if (!ALL_ROLES.includes(roleId)) throw new ApiError(400, 'member/role-invalid', `Unknown role: ${roleId}`);
    return { role: ROLE_INDEX[roleId] };
  }

  async function actionMemberPrompt({ workspaceId, payload }) {
    const { board } = await loadProject(workspaceId);
    const member = findMember(board, String(payload?.memberId ?? ''));
    const role = ROLE_INDEX[member.roleId];
    return { prompt: composeAgentPrompt({ role, member }) };
  }

  function readOnlyAccessValue() {
    const presets = ctx.get('permissionPresets');
    const options = accessOptions();
    const match = options.find((option) => accessSandbox(option.value, presets) === 'read-only')
      ?? options.find((option) => option.value === 'read-only');
    return match ? match.value : 'read-only';
  }

  const TEMPLATE_FIRST_NAMES = ['Alex', 'Jordan', 'Riley', 'Casey', 'Morgan', 'Avery', 'Quinn', 'Rowan', 'Skyler', 'Dakota', 'Emerson', 'Finley'];
  const TEMPLATE_LAST_NAMES = ['Hart', 'Vale', 'Reed', 'Shaw', 'Cross', 'Wynn', 'Parker', 'Ellis', 'Blake', 'Mercer', 'Lane', 'Frost'];

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function templateMemberFor(board, description, roleId) {
    const text = `${description}`.toLowerCase();
    const inferred = roleId ?? defaultAgentRole('', text);
    const seed = hashText(`${description}|${inferred}`);
    let name = '';
    for (let attempt = 0; attempt < 48; attempt += 1) {
      const first = TEMPLATE_FIRST_NAMES[(seed + attempt) % TEMPLATE_FIRST_NAMES.length];
      const last = TEMPLATE_LAST_NAMES[(seed + attempt * 7) % TEMPLATE_LAST_NAMES.length];
      const candidate = `${first} ${last}`;
      if (!memberNameTaken(board, candidate)) {
        name = candidate;
        break;
      }
    }
    if (!name) name = `Member ${board.team.members.length + 1}`;
    return {
      name,
      title: ROLE_INDEX[inferred]?.name ?? 'Team member',
      roleId: inferred,
      persona: personaTemplate(inferred),
      source: 'ai',
    };
  }

  async function actionDraftMember({ workspaceId, payload, actor }) {
    const { project, board } = await loadProject(workspaceId);
    const description = clampString(payload?.description, MEMBER_DRAFT_DESCRIPTION_MAX);
    if (!description) throw badRequest('Describe the team member you want to add (max 1000 characters).');
    if (payload?.roleId !== undefined && payload?.roleId !== null && payload?.roleId !== '') {
      validateMemberRole(payload.roleId);
    }
    if (board.team.members.length >= ROSTER_LIMIT) {
      throw new ApiError(409, 'member/limit', `The roster is capped at ${ROSTER_LIMIT} members.`);
    }
    const active = board.team.drafts.filter((draft) => draft.status === 'drafting');
    if (active.length >= DRAFT_LIMIT) {
      throw new ApiError(409, 'draft/limit', `At most ${DRAFT_LIMIT} member drafts can run at once. Wait for one to finish or cancel it.`);
    }
    const roleId = ALL_ROLES.includes(payload?.roleId) ? payload.roleId : null;
    const at = now();
    const draft = {
      id: `draft-${uid().slice(0, 8)}`,
      description,
      roleId,
      sessionId: null,
      status: 'drafting',
      createdAt: at,
    };
    const agentsService = ctx.get('agents');
    if (!agentsService || typeof agentsService.create !== 'function') {
      // No drafting agent available: return a deterministic, editable template
      // member of the same shape so the feature still works offline.
      const template = templateMemberFor(board, description, roleId);
      const member = createMemberRecord(board, template, { actor, source: 'ai' });
      board.team.drafts.unshift({
        ...draft,
        status: 'failed',
        mode: 'template',
        error: 'AI drafting is unavailable; a deterministic template member was added. Edit it to make it yours.',
        createdAt: at + 1,
      });
      await store.save(board);
      return {
        draft: {
          ...draft,
          status: 'failed',
          mode: 'template',
          error: 'AI drafting is unavailable; a deterministic template member was added. Edit it to make it yours.',
          createdAt: at + 1,
        },
        member,
        source: 'template',
        message: 'AI drafting is unavailable; a template member was added.',
      };
    }
    let handle;
    try {
      // Mirror execution sessions: mount the project agent preset so the
      // drafting agent actually has the tool composition (including `kanban`),
      // and carry the current default provider/model or the turn cannot start.
      const preset = await executionPreset(project);
      let modelSelection;
      try {
        modelSelection = ctx.get('agentDefaultModel')?.currentSelection?.();
      } catch {
        modelSelection = undefined;
      }
      const agentOptions = modelSelection && typeof modelSelection.provider === 'string' && typeof modelSelection.model === 'string'
        ? {
            provider: modelSelection.provider,
            model: modelSelection.model,
            ...(typeof modelSelection.reasoningEffort === 'string' ? { reasoningEffort: modelSelection.reasoningEffort } : {}),
          }
        : undefined;
      handle = await agentsService.create({
        sessionId: `session-${randomUUID()}`,
        meta: { cwd: project.path, ...(preset.id ? { agentPreset: preset.id } : {}) },
        ...(agentOptions ? { agentOptions } : {}),
        ...(preset.mount ? { setup: async (agentCtx) => { await preset.mount(agentCtx); } } : {}),
      });
    } catch (error) {
      const template = templateMemberFor(board, description, roleId);
      const member = createMemberRecord(board, template, { actor, source: 'ai' });
      const failed = {
        ...draft,
        status: 'failed',
        mode: 'template',
        error: `Could not start a drafting agent (${error instanceof Error ? error.message : String(error)}); a template member was added.`,
      };
      board.team.drafts.unshift(failed);
      await store.save(board);
      return { draft: failed, member, source: 'template', message: 'Drafting agent unavailable; a template member was added.' };
    }
    const sessionId = String(handle.agent.id);
    draft.sessionId = sessionId;
    board.team.drafts.unshift(draft);
    // Mark the short-lived drafting session so it never shows up as a teammate.
    const draftAgent = ensureBoardAgent(board, sessionId, {
      name: `drafting · ${description.slice(0, 24)}`,
      role: roleId ?? defaultAgentRole('', description),
    });
    draftAgent.draft = true;
    try {
      const presets = ctx.get('permissionPresets');
      const liveSession = handle.agent?.session ?? ctx.get('sessions')?.get?.(sessionId);
      if (presets && typeof presets.set === 'function' && liveSession) presets.set(liveSession, readOnlyAccessValue());
    } catch {
      // access mode is a safety net; the drafted prompt only reads the board
    }
    await store.save(board);
    const roleLine = roleId
      ? `Preferred role: ${ROLE_INDEX[roleId].name} (${roleId}). Use it unless the description clearly asks for a different one.`
      : 'Pick the most fitting role id from the catalog.';
    const prompt = [
      '# Team member drafting',
      `Project: ${project.title} (${project.path})`,
      `The user wants to add a team member: "${description}"`,
      roleLine,
      '',
      'Call the `kanban` tool exactly once with action "create_member" and these arguments:',
      '- name: a unique human name (2–4 words), not already used in the team roster',
      '- title: a short role title (max 60 chars)',
      '- role: the chosen role id',
      '- persona: a second-person ("You are …") system prompt of 100–180 words covering identity & seniority, core strengths, working style, collaboration & communication, quality bar/non-negotiables, and anti-patterns refused. It must read as a distinct specialist, not a relabelled generic agent.',
      '- memberDescription: the user description above',
      '',
      'Optionally call the kanban tool with action "members" first to see existing names and roles.',
      'Do not modify any files, do not run other tools, and stop as soon as the member is created.',
    ].join('\n');
    try {
      await promptSession(sessionId, prompt);
    } catch (error) {
      draft.status = 'failed';
      draft.error = `The drafting agent could not start: ${error instanceof Error ? error.message : String(error)}`;
      await store.save(board);
    }
    return { draft, source: 'ai', member: null };
  }

  async function actionCancelDraft({ workspaceId, draftId, actor }) {
    const { board } = await loadProject(workspaceId);
    const draft = board.team.drafts.find((candidate) => candidate.id === String(draftId ?? ''));
    if (!draft) throw new ApiError(404, 'draft/not-found', `Unknown member draft: ${draftId}`);
    if (draft.status === 'drafting') {
      if (draft.sessionId) {
        try {
          ctx.sessionController.cancel({ sessionId: draft.sessionId });
        } catch {
          // best effort
        }
      }
      draft.status = 'cancelled';
      draft.error = 'Draft cancelled.';
      pushBoardActivity(board, actor, 'team/draft-cancel', `Cancelled member draft "${draft.description.slice(0, 80)}"`);
    } else {
      board.team.drafts = board.team.drafts.filter((candidate) => candidate.id !== draft.id);
    }
    await store.save(board);
    return { cancelled: true };
  }

  // -- project scanner -----------------------------------------------------

  async function scanProject(project) {
    const root = project.path;
    const ownerId = String(project.id);
    const limits = {
      maxFiles: positiveInt(settings.scanMaxFiles, 160),
      maxDepth: 4,
      maxBytes: 256 * 1024,
    };
    const [docs, sessions, mrs] = await Promise.all([
      scanDocs(root, limits),
      scanConversations(root, ownerId),
      scanMrs(root),
    ]);
    const vision = pickVision(docs);
    const candidates = deriveCandidates(docs, mrs);
    const scan = {
      generatedAt: now(),
      projectPath: root,
      vision,
      docs: docs.map((doc) => ({
        path: doc.path,
        title: doc.title,
        kind: doc.kind,
        excerpt: doc.excerpt,
      })),
      conversations: sessions,
      mrs,
      candidates,
    };
    return scan;
  }

  async function scanDocs(root, limits) {
    const skip = new Set([
      'node_modules', '.git', '.hg', '.svn', '.dsh', 'dist', 'build', 'out', '.next', '.nuxt',
      'coverage', 'vendor', 'target', '.venv', 'venv', '__pycache__', '.idea', '.vscode', '.cache',
      'tmp', '.turbo', '.output', 'Pods', 'bin', 'obj',
    ]);
    const results = [];
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && results.length < limits.maxFiles) {
      const { dir, depth } = stack.pop();
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (results.length >= limits.maxFiles) break;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skip.has(entry.name) || depth >= limits.maxDepth) continue;
          stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const extension = entry.name.includes('.') ? entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase() : '';
        if (!['.md', '.mdx', '.markdown', '.txt'].includes(extension)) continue;
        let size = 0;
        try {
          size = (await stat(full)).size;
        } catch {
          continue;
        }
        if (size > limits.maxBytes) continue;
        let content;
        try {
          content = await readFile(full, 'utf8');
        } catch {
          continue;
        }
        const relativePath = full.slice(root.length).replace(/^[\\/]/, '');
        const kind = docKind(relativePath);
        const title = firstHeading(content) ?? entry.name;
        results.push({
          path: relativePath,
          absolute: full,
          title,
          kind,
          excerpt: excerpt(content, kind === 'vision' ? 1600 : 600),
          content,
        });
      }
    }
    return results.sort((a, b) => docRank(a.kind) - docRank(b.kind) || a.path.localeCompare(b.path));
  }

  function docKind(relativePath) {
    const value = relativePath.toLowerCase();
    if (/(vision|product|prd|strategy|okr|manifesto)/.test(value)) return 'vision';
    if (/(roadmap|plan|milestone|backlog|todo)/.test(value)) return 'plan';
    if (/(architect|design|rfc|spec|adr)/.test(value)) return 'architecture';
    if (/(readme|contributing|agents|claude|guide)/.test(value)) return 'readme';
    return 'doc';
  }

  function docRank(kind) {
    return { vision: 0, plan: 1, architecture: 2, readme: 3, doc: 4 }[kind] ?? 5;
  }

  function firstHeading(content) {
    const match = /^#{1,2}\s+(.+)$/m.exec(content);
    return match ? match[1].trim().slice(0, 140) : null;
  }

  function excerpt(content, max) {
    const cleaned = content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*[-*]\s+\[[ xX]\]\s+/gm, '')
      .replace(/[#>*_`]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.slice(0, max);
  }

  function pickVision(docs) {
    const vision = docs.find((doc) => doc.kind === 'vision') ?? docs.find((doc) => doc.kind === 'readme');
    if (!vision) return null;
    return excerpt(vision.content, 1800) || null;
  }

  function deriveCandidates(docs, mrs) {
    const candidates = [];
    const seen = new Set();
    const push = (candidate) => {
      const key = `${candidate.source.kind}:${candidate.source.ref}`;
      if (seen.has(key)) return;
      if (!candidate.title || candidate.title.length < 4) return;
      seen.add(key);
      candidates.push(candidate);
    };
    for (const doc of docs) {
      if (candidates.length >= 60) break;
      if (doc.kind === 'readme') continue;
      if (doc.kind === 'vision') {
        push({
          key: `doc:${doc.path}`,
          title: `Capture product vision and outcomes from ${doc.path}`,
          description: `Turn the documented vision in ${doc.path} into a short, testable product thesis and acceptance criteria.\n\n${doc.excerpt}`,
          type: 'story',
          priority: 'high',
          role: 'product-manager',
          column: 'backlog',
          source: { kind: 'doc', ref: doc.path, title: doc.title },
          evidence: doc.path,
        });
        continue;
      }
      if (doc.kind === 'plan' || doc.kind === 'architecture') {
        push({
          key: `doc:${doc.path}`,
          title: doc.title || `Review documented plan ${doc.path}`,
          description: `Align the board with the documented plan in ${doc.path}. Split it into Ready tickets with clear acceptance criteria.\n\n${doc.excerpt}`,
          type: 'story',
          priority: 'medium',
          role: doc.kind === 'architecture' ? 'tech-lead' : 'product-manager',
          column: 'backlog',
          source: { kind: 'doc', ref: doc.path, title: doc.title },
          evidence: doc.path,
        });
      }
      // Checkboxes and leading TODO/FIXME markers become ready-to-refine work items.
      const lines = doc.content.split(/\r?\n/);
      let inFence = false;
      for (let index = 0; index < lines.length; index += 1) {
        if (candidates.length >= 80) break;
        const line = lines[index];
        if (/^\s*(?:```|~~~)/.test(line)) {
          inFence = !inFence;
          continue;
        }
        if (inFence) continue;
        const checkbox = /^\s*[-*]\s+\[\s\]\s+(.+)$/.exec(line);
        const todo = /^\s*(?:[-*+]\s+)?(?:\/\/|#|<!--|\*|;|\/\*)?\s*(TODO|FIXME|XXX|HACK|TBD)\b[:\s-]+(.+)$/i.exec(line);
        const text = (checkbox ? checkbox[1] : todo ? todo[2] : '')
          .replace(/\s*(?:-->|\*\/)\s*$/, '')
          .trim();
        if (!text || text.length < 6) continue;
        const clean = text.replace(/\s+/g, ' ').slice(0, 220);
        push({
          key: `line:${doc.path}:${index + 1}`,
          title: clean,
          description: `Captured from ${doc.path}:${index + 1}.\n\n\`${line.trim().slice(0, 300)}\`\n\nRefine into a Ready ticket with acceptance criteria before pulling.`,
          type: inferType(clean, line),
          priority: inferTier(clean, line),
          role: inferRole(clean),
          column: 'backlog',
          source: { kind: checkbox ? 'checkbox' : 'todo', ref: `${doc.path}:${index + 1}`, title: doc.title },
          evidence: `${doc.path}:${index + 1}`,
        });
      }
    }
    for (const mr of mrs) {
      if (candidates.length >= 100) break;
      push({
        key: `mr:${mr.id}`,
        title: `Review ${mr.source === 'gitlab' ? 'MR' : 'PR'} ${mr.number}: ${mr.title}`,
        description: `Open change request detected in the repository. Review the diff, verify tests, and accept or request changes on the Kanban board.\n\n${mr.url ?? ''}`,
        type: 'task',
        priority: 'high',
        role: 'reviewer',
        column: 'review',
        source: { kind: 'mr', ref: mr.id, title: mr.title, ...(mr.url ? { url: mr.url } : {}) },
        evidence: mr.url ?? mr.id,
      });
    }
    return candidates;
  }

  async function scanConversations(root, ownerId) {
    let snapshots = [];
    try {
      snapshots = await ctx.sessionPersistence.list();
    } catch {
      return [];
    }
    const relevant = snapshots
      .filter((snapshot) => owningWorkspace(snapshot.header?.cwd)?.id === ownerId)
      .sort((a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0))
      .slice(0, 14);
    const summaries = new Map((await readSessions()).map((session) => [session.sessionId, session]));
    const rows = [];
    for (const snapshot of relevant) {
      const sessionId = String(snapshot.header.id);
      const known = summaries.get(sessionId);
      let title = known?.title ?? `Session ${sessionId.slice(-6)}`;
      let summary = '';
      let messageCount = 0;
      try {
        const handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read');
        try {
          const total = snapshot.eventCount ?? 0;
          const offset = Math.max(0, total - 80);
          const result = await handle.read(offset, 80);
          const events = Array.isArray(result?.events) ? result.events : [];
          messageCount = events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message').length;
          const userTexts = [];
          const assistantTexts = [];
          for (const event of events) {
            const message = event?.data?.message;
            if (!message || typeof message !== 'object') continue;
            const text = (Array.isArray(message.content) ? message.content : [])
              .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join(' ')
              .trim();
            if (!text) continue;
            if (event.type === 'user/message') userTexts.push(text);
            if (event.type === 'assistant/message') assistantTexts.push(text);
          }
          const firstUser = userTexts[0];
          if (firstUser && (!known || title.startsWith('Session '))) title = firstUser.split(/\r?\n/)[0].slice(0, 120);
          summary = (assistantTexts[assistantTexts.length - 1] ?? firstUser ?? '').replace(/\s+/g, ' ').slice(0, 320);
        } finally {
          await handle.close();
        }
      } catch {
        // best effort: conversation history is context, not required
      }
      rows.push({
        sessionId,
        title,
        updatedAt: snapshot.header?.createdAt ?? 0,
        running: known?.running ?? false,
        summary,
        messageCount,
      });
    }
    return rows;
  }

  async function scanMrs(root) {
    const found = [];
    const gh = await tryExec('gh', ['pr', 'list', '--json', 'number,title,url,isDraft,state', '--limit', '30'], root);
    if (gh) {
      try {
        const list = JSON.parse(gh);
        if (Array.isArray(list)) {
          for (const item of list.slice(0, 30)) {
            const url = typeof item.url === 'string' ? item.url : null;
            found.push({
              id: url ?? `gh-${item.number}`,
              number: String(item.number ?? ''),
              title: clampString(item.title, 200) || 'Untitled pull request',
              url,
              state: item.isDraft ? 'draft' : 'open',
              source: 'github',
            });
          }
        }
      } catch {
        // gh returned non-JSON
      }
    }
    if (found.length === 0) {
      const glab = await tryExec('glab', ['mr', 'list', '-F', 'json', '-P', '30'], root);
      if (glab) {
        try {
          const list = JSON.parse(glab);
          if (Array.isArray(list)) {
            for (const item of list.slice(0, 30)) {
              const url = typeof item.web_url === 'string' ? item.web_url : typeof item.url === 'string' ? item.url : null;
              found.push({
                id: url ?? `glab-${item.iid}`,
                number: String(item.iid ?? ''),
                title: clampString(item.title, 200) || 'Untitled merge request',
                url,
                state: item.state ?? 'open',
                source: 'gitlab',
              });
            }
          }
        } catch {
          // glab returned non-JSON
        }
      }
    }
    return found;
  }

  async function tryExec(command, args, cwd) {
    try {
      const result = await run(command, args, {
        cwd,
        timeout: 6000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        env: process.env,
      });
      return typeof result.stdout === 'string' ? result.stdout : null;
    } catch {
      return null;
    }
  }

  // -- tool-facing actor resolution ---------------------------------------

  async function actorForAgent(agent, project, board) {
    const sessionId = String(agent.id);
    let name = `Agent ${sessionId.slice(-4)}`;
    let teamRole = null;
    try {
      const live = ctx.get('agents')?.get?.(agent.id);
      const teams = ctx.get('agentTeams');
      if (live && teams) {
        const membership = teams.tryMembership(live);
        if (membership) {
          name = membership.name;
          teamRole = membership.role;
        }
      }
    } catch {
      // optional
    }
    let sessionSummary = null;
    try {
      const sessions = await readSessions();
      sessionSummary = sessions.find((session) => session.sessionId === sessionId) ?? null;
      if (sessionSummary && name.startsWith('Agent ')) {
        const title = sessionSummary.title;
        if (title && !title.startsWith('Session ') && title !== 'New session') name = title.slice(0, 80);
      }
    } catch {
      // optional
    }
    const existing =
      board.agents?.[sessionId] && typeof board.agents[sessionId] === 'object' ? board.agents[sessionId] : null;
    // Execution identity comes from the ticket itself; the bookkeeping row is no
    // longer created for sessions that belong to nobody.
    const executionTicket =
      board.tickets.find(
        (ticket) =>
          ticket.execution?.sessionId === sessionId &&
          !['done', 'cancelled', 'failed'].includes(ticket.execution.status),
      ) ?? board.tickets.find((ticket) => ticket.execution?.sessionId === sessionId) ?? null;
    const executionTicketId = existing?.executionTicketId ?? executionTicket?.id ?? null;
    // The roster is the identity source: a session anchored by `member.sessionId`
    // or naming a member adopts that person, so persona/role stay attached.
    const member =
      board.team.members.find((candidate) => candidate.sessionId === sessionId) ??
      matchRosterMember(board, name, sessionSummary ? displayTitleName(sessionSummary.title) : '');
    if (member) {
      // Keep a dispatch's audit identity (`role · KB-n`) for execution sessions;
      // the roster row and persona still come from the person behind it.
      const dispatchName = executionTicketId && existing && typeof existing.name === 'string' ? existing.name : '';
      attachSessionToMember(board, sessionId, member, { current: true });
      name = dispatchName || member.name;
    } else if (existing && typeof existing.name === 'string' && existing.name) {
      name = existing.name;
    }
    let role;
    if (member && !executionTicketId) role = member.roleId;
    else if (existing && ALL_ROLES.includes(existing.role)) role = existing.role;
    else role = defaultAgentRole(name);
    const isLead = executionTicketId ? false : teamRole === 'lead' ? true : existing?.isLead === true;
    if (existing) {
      // Keep the legacy row's lead/role hints honest for the transition window.
      if (executionTicketId) existing.isLead = false;
      else if (teamRole === 'lead') existing.isLead = true;
      if (!ALL_ROLES.includes(existing.role)) existing.role = role;
      if (!existing.name) existing.name = name;
    }
    return {
      sessionId,
      name,
      role,
      isLead,
      executionTicketId,
      memberId: member?.id ?? null,
      memberName: member?.name ?? null,
    };
  }

  // -- HTTP routes ---------------------------------------------------------

  function rejected(req, res) {
    let rejection;
    try {
      rejection = ctx.connection.requestRejection(req);
    } catch {
      rejection = 401;
    }
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  }

  async function readBody(req) {
    const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (essence !== 'application/json') throw new ApiError(415, 'bad-request', 'content-type must be application/json');
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        req.resume();
        throw new ApiError(413, 'bad-request', 'request body is too large');
      }
      chunks.push(chunk);
    }
    if (size === 0) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new ApiError(400, 'bad-request', 'request body must be a JSON object');
    }
  }

  function sendJson(res, status, payload) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(payload));
  }

  async function handleState(req, res) {
    try {
      const body = await readBody(req);
      let value;
      try {
        value = await snapshot(typeof body.workspaceId === 'string' ? body.workspaceId : undefined);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'project/not-found') throw error;
        value = await snapshot(undefined);
      }
      sendJson(res, 200, { ok: true, value });
    } catch (error) {
      const payload = errorPayload(error);
      sendJson(res, payload.status, payload.body);
    }
  }

  async function dispatch(workspaceId, action, payload) {
    const actor = { sessionId: 'user', name: 'You', role: 'tech-lead' };
    const allowedWhilePaused = new Set([
      'pauseBoard', 'resumeBoard', 'pauseAgent', 'resumeAgent', 'setAgentRole', 'scan', 'refresh',
      'createMember', 'updateMember', 'deleteMember', 'draftMember', 'cancelDraft', 'roleDetail', 'memberPrompt',
      // KB-5: capture queues while paused; retry reaches its own handler so it can
      // answer 404 before 423; cancel/edit/delete move no lane and dispatch
      // nothing, and a thought is only queued while paused.
      'submitThought', 'retryThought', 'cancelThought', 'editThought', 'deleteThought',
      // KB-68: status is a read and configure is the operator's safety switch, so
      // both stay available on a paused board (pause is not "autopilot off").
      'autopilot',
    ]);
    if (!allowedWhilePaused.has(action)) {
      const { board } = await loadProject(workspaceId);
      if (board.paused) {
        throw new ApiError(423, 'board/paused', 'The board is paused. Resume it before changing tickets.');
      }
    }
    switch (action) {
      case 'runTicket':
        return startTicketExecution({
          workspaceId,
          ticketId: String(payload?.ticketId ?? ''),
          role: typeof payload?.role === 'string' ? payload.role : undefined,
          accessMode: typeof payload?.accessMode === 'string' ? payload.accessMode : undefined,
          memberId: typeof payload?.memberId === 'string' ? payload.memberId : undefined,
          actor: 'You',
          force: payload?.force === true,
        });
      case 'resumeExecution':
        return resumeTicketExecution({
          workspaceId,
          ticketId: String(payload?.ticketId ?? ''),
          actor: 'You',
          message: typeof payload?.message === 'string' ? payload.message : undefined,
        });
      case 'answerTicket':
        return answerTicketExecution({
          workspaceId,
          ticketId: String(payload?.ticketId ?? ''),
          answers: Array.isArray(payload?.answers) || typeof payload?.answers === 'string' ? payload.answers : [],
          grant: Array.isArray(payload?.grant) ? payload.grant : [],
          denied: Array.isArray(payload?.denied) ? payload.denied : [],
          actor: 'You',
        });
      case 'cancelExecution':
        return cancelTicketExecution({ workspaceId, ticketId: String(payload?.ticketId ?? ''), actor: 'You' });
      case 'submitThought':
        return submitThought({ workspaceId, text: payload?.text });
      case 'retryThought':
        return retryThought({ workspaceId, thoughtId: String(payload?.thoughtId ?? '') });
      case 'cancelThought':
        return cancelThought({ workspaceId, thoughtId: String(payload?.thoughtId ?? '') });
      case 'editThought':
        return editThought({
          workspaceId,
          thoughtId: String(payload?.thoughtId ?? ''),
          text: payload?.text,
        });
      case 'deleteThought':
        return deleteThought({ workspaceId, thoughtId: String(payload?.thoughtId ?? '') });
      case 'createTicket': {
        const { board } = await loadProject(workspaceId);
        const ticket = createTicketRecord(board, payload ?? {}, 'You');
        await store.save(board);
        return { ticket };
      }
      case 'updateTicket': {
        const patch = payload?.patch && typeof payload.patch === 'object' ? payload.patch : payload ?? {};
        return actionUpdateBoardTicket({ workspaceId, ticketId: String(payload?.ticketId ?? ''), patch, actor: 'You' });
      }
      case 'moveTicket':
        return actionMove({ workspaceId, payload: payload ?? {}, user: true, actor: { sessionId: 'user', name: 'You', role: 'tech-lead' } });
      case 'deleteTicket':
        return actionDelete({ workspaceId, ticketId: String(payload?.ticketId ?? ''), actor: 'You' });
      case 'assignTicket':
        return actionAssign({
          workspaceId,
          ticketId: String(payload?.ticketId ?? ''),
          sessionId: payload?.sessionId === null || payload?.sessionId === undefined ? null : String(payload.sessionId),
          actor: 'You',
        });
      case 'comment':
        return actionComment({ workspaceId, payload: payload ?? {}, actor });
      case 'checklistAdd':
        return actionChecklist({ workspaceId, ticketId: String(payload?.ticketId ?? ''), op: 'add', text: payload?.text, actor: 'You' });
      case 'checklistToggle':
        return actionChecklist({ workspaceId, ticketId: String(payload?.ticketId ?? ''), op: 'toggle', itemId: String(payload?.itemId ?? ''), actor: 'You' });
      case 'checklistRemove':
        return actionChecklist({ workspaceId, ticketId: String(payload?.ticketId ?? ''), op: 'remove', itemId: String(payload?.itemId ?? ''), actor: 'You' });
      case 'blockTicket': {
        const patch = { blocked: payload?.blocked === true, blockReason: payload?.reason };
        return actionUpdateBoardTicket({ workspaceId, ticketId: String(payload?.ticketId ?? ''), patch, actor: 'You' });
      }
      case 'pauseBoard':
        return actionPauseBoard({ workspaceId, actor: 'You', paused: true });
      case 'resumeBoard':
        return actionPauseBoard({ workspaceId, actor: 'You', paused: false });
      case 'pauseAgent':
        return actionAgentPause({ workspaceId, sessionId: String(payload?.sessionId ?? ''), actor: 'You', paused: true });
      case 'resumeAgent':
        return actionAgentPause({ workspaceId, sessionId: String(payload?.sessionId ?? ''), actor: 'You', paused: false });
      case 'setAgentRole':
        return actionSetRole({ workspaceId, sessionId: String(payload?.sessionId ?? ''), role: String(payload?.role ?? ''), actor: 'You' });
      case 'createMember':
        return actionCreateMember({ workspaceId, payload: payload ?? {}, actor: 'You' });
      case 'updateMember':
        return actionUpdateMember({
          workspaceId,
          memberId: String(payload?.memberId ?? ''),
          patch: payload?.patch && typeof payload.patch === 'object' ? payload.patch : payload ?? {},
          actor: 'You',
        });
      case 'deleteMember':
        return actionDeleteMember({
          workspaceId,
          memberId: String(payload?.memberId ?? ''),
          force: payload?.force === true,
          actor: 'You',
        });
      case 'draftMember':
        return actionDraftMember({ workspaceId, payload: payload ?? {}, actor: 'You' });
      case 'cancelDraft':
        return actionCancelDraft({ workspaceId, draftId: String(payload?.draftId ?? ''), actor: 'You' });
      case 'roleDetail':
        return actionRoleDetail({ payload: payload ?? {} });
      case 'memberPrompt':
        return actionMemberPrompt({ workspaceId, payload: payload ?? {} });
      case 'scan': {
        const { project, board } = await loadProject(workspaceId);
        const scan = await scanProject(project);
        lastScans.set(String(project.id), scan);
        board.meta.vision = scan.vision;
        board.meta.docs = scan.docs.map((doc) => ({ path: doc.path, title: doc.title, kind: doc.kind, bytes: 0 }));
        board.meta.conversations = scan.conversations;
        board.meta.mrs = scan.mrs;
        board.meta.lastScanAt = scan.generatedAt;
        pushBoardActivity(board, 'You', 'scan', `Scanned project: ${scan.docs.length} docs, ${scan.mrs.length} open MRs, ${scan.conversations.length} conversations, ${scan.candidates.length} candidates`);
        await store.save(board);
        return { scan };
      }
      case 'applyScan': {
        const { project, board } = await loadProject(workspaceId);
        const scan = lastScans.get(String(project.id)) ?? (await scanProject(project));
        lastScans.set(String(project.id), scan);
        let created = 0;
        let skipped = 0;
        const tickets = [];
        const wanted = Array.isArray(payload?.keys)
          ? new Set(payload.keys.filter((key) => typeof key === 'string'))
          : null;
        for (const candidate of scan.candidates) {
          if (wanted && !wanted.has(candidate.key)) {
            skipped += 1;
            continue;
          }
          const duplicate = board.tickets.some(
            (ticket) => ticket.source && ticket.source.kind === candidate.source.kind && ticket.source.ref === candidate.source.ref,
          );
          if (duplicate) {
            skipped += 1;
            continue;
          }
          const ticket = createTicketRecord(board, candidate, 'You');
          tickets.push(ticket);
          created += 1;
        }
        if (created > 0) {
          board.meta.vision = scan.vision;
          board.meta.docs = scan.docs.map((doc) => ({ path: doc.path, title: doc.title, kind: doc.kind, bytes: 0 }));
          board.meta.conversations = scan.conversations;
          board.meta.mrs = scan.mrs;
          board.meta.lastScanAt = scan.generatedAt;
          pushBoardActivity(board, 'You', 'scan/apply', `Imported ${created} ticket${created === 1 ? '' : 's'} from project scan (${skipped} already present)`);
          await store.save(board);
        }
        return { created, skipped, tickets };
      }
      // KB-68: read or change this project's autopilot configuration. Status is
      // read-only; configure validates the whole patch before writing once.
      case 'autopilot':
        return actionAutopilot({ workspaceId, payload: payload ?? {} });
      case 'refresh':
        return {};
      default:
        throw badRequest(`Unknown action: ${action}`);
    }
  }

  async function handleAction(req, res) {
    try {
      const body = await readBody(req);
      const action = String(body.action ?? '');
      if (!action) throw badRequest('action is required');
      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : '';
      if (!workspaceId) throw badRequest('workspaceId is required');
      const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
      const value = await dispatch(workspaceId, action, payload);
      let message;
      if (action === 'applyScan') message = `Imported ${value.created} ticket(s); ${value.skipped} skipped.`;
      if (action === 'scan') message = `Scan found ${value.scan.candidates.length} candidate ticket(s).`;
      if (action === 'pauseBoard') message = 'Board paused.';
      if (action === 'resumeBoard') message = 'Board resumed.';
      if (action === 'draftMember' && value?.source === 'template') {
        message = 'AI drafting is unavailable; a template member was added. Edit it to customise the persona.';
      }
      sendJson(res, 200, { ok: true, value, ...(message ? { message } : {}) });
    } catch (error) {
      const payload = errorPayload(error);
      sendJson(res, payload.status, payload.body);
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/kanban/state',
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
          }
          await handleState(req, res);
        },
      }),
    'kanban: POST /kanban/state',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/kanban/action',
        handler: async (req, res) => {
          if (rejected(req, res)) return;
          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
          }
          await handleAction(req, res);
        },
      }),
    'kanban: POST /kanban/action',
  );

  // -- agent tool ----------------------------------------------------------

  const TOOL_DESCRIPTION = [
    'Read and advance the project Kanban board. Use this tool for all project work state:',
    'start with action "whoami" to learn your project, role, and the tickets you may pull.',
    'The board is the single source of truth for what is being worked on. Standard Kanban policy is enforced:',
    'columns are backlog → ready → in_progress → review → done; move ONE column at a time;',
    'WIP limits apply (default in_progress 3, review 5) and each agent may hold only ONE in-flight ticket;',
    'claim work (action "claim") before doing it; raise to review when the change is ready;',
    'only a reviewer/tester accepts review → done; blocked work must be flagged with action "block";',
    'a paused board rejects all agent mutations. Never move another agent\'s ticket, never skip a column,',
    'and never claim a ticket outside the columns your role owns.',
    'Actions: whoami | projects | board | list | next | create | claim | move | update | comment |',
    'release | block | unblock | finish | run | assign | team | members | create_member | scan | pause | resume |',
    'set_role | debug | answer | cancel_execution. A reviewer records a structured verdict with action "review"',
    '(verdict, notes, criteria, evidence) before moving Review → Done or Review → In Progress.',
    '"members" and "team" return the fixed roster; live agent sessions are attachments that drive each',
    "member's running/idle/offline status, never extra team rows.",
    'When you are executing a ticket session the tool is scoped to that one ticket: claim it, work it, then',
    'move it forward and call "finish" with a summary. If you need a user decision or permission, call',
    'block with questions/needs and STOP; the user answers on the board and your session resumes.',
  ].join(' ');

  const TOOL_PARAMETERS = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [
          'whoami', 'projects', 'board', 'list', 'next', 'create', 'claim', 'move', 'update',
          'comment', 'review', 'release', 'block', 'unblock', 'finish', 'run', 'assign', 'team', 'members',
          'create_member', 'scan', 'pause', 'resume', 'set_role', 'debug', 'answer', 'cancel_execution',
        ],
        description: 'Operation to perform.',
      },
      project: { type: 'string', description: 'Workspace id or title; defaults to your session workspace.' },
      ticketId: { type: 'string', description: 'Ticket id such as KB-12.' },
      column: { type: 'string', enum: COLUMN_IDS, description: 'Target column for move/create/list filters.' },
      title: { type: 'string', description: 'Ticket title for create.' },
      description: { type: 'string', description: 'Ticket description for create/update.' },
      type: { type: 'string', enum: TICKET_TYPES, description: 'Ticket type. Use epic for a structural EPIC parent.' },
      parentId: { type: 'string', description: 'Parent EPIC ticket id for a child ticket (omit or null to clear on update).' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Ticket priority.' },
      role: { type: 'string', enum: ALL_ROLES, description: 'Required role for the ticket, or target role for set_role.' },
      accessMode: { type: 'string', description: 'Permission preset for a dispatched execution (for example read-only, workspace-write, danger-full-access). Defaults to the lane suggestion.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Labels for create/update.' },
      memberId: { type: 'string', description: 'Roster member id for run/create_member (optional for run: resolves an idle member of the role).' },
      name: { type: 'string', description: 'Team member name for create_member.' },
      title: { type: 'string', description: 'Team member title for create_member.' },
      persona: { type: 'string', description: 'Team member persona/system prompt for create_member (100–180 words, second person).' },
      memberDescription: { type: 'string', description: 'Original user description for create_member (optional).' },
      draftId: { type: 'string', description: 'Member draft id for create_member (optional; the drafting session is auto-detected).' },
      text: { type: 'string', description: 'Comment, block reason, or finish summary text.' },
      summary: { type: 'string', description: 'Finish report: what changed, evidence, follow-ups.' },
      verdict: { type: 'string', enum: ['accepted', 'changes-requested'], description: 'Structured review verdict for the review action.' },
      notes: { type: 'string', description: 'Review notes: for changes-requested, the blocking defect and what to change (required).' },
      criteria: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The numbered acceptance criterion, e.g. "3".' },
            passed: { type: 'boolean', description: 'True when the criterion is verified.' },
            note: { type: 'string', description: 'What was checked for this criterion.' },
          },
          required: ['ref', 'passed'],
          additionalProperties: false,
        },
        description: 'Per-criterion verdict mapping; accepted must map every numbered criterion as passed.',
      },
      evidence: { type: 'array', items: { type: 'string' }, description: 'Evidence list: commands and artifacts the reviewer checked.' },
      answers: { type: 'array', items: { type: 'string' }, description: 'Answers to the blocked questions, one per question (or free-form notes).' },
      grant: { type: 'array', items: { type: 'string' }, description: 'Permissions/decisions the user grants.' },
      questions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Blocked questions for the user (one per item).',
      },
      needs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['question', 'permission', 'decision', 'input'] },
            text: { type: 'string' },
          },
          required: ['kind', 'text'],
          additionalProperties: false,
        },
        description: 'Actions needed from the user (permission/decision/input).',
      },
      blocked: { type: 'boolean', description: 'True to block, false to unblock.' },
      sessionId: { type: 'string', description: 'Agent session id for assign/pause/resume.' },
      owner: { type: 'string', description: 'Owner name filter for list, or my/any/all.' },
      mine: { type: 'boolean', description: 'List only tickets owned by you.' },
      limit: { type: 'integer', description: 'Maximum rows to return (default 20).' },
      apply: { type: 'boolean', description: 'For scan: import the discovered candidates too.' },
    },
    required: ['action'],
    additionalProperties: false,
  };

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'kanban',
        description: TOOL_DESCRIPTION,
        parameters: TOOL_PARAMETERS,
        output: {
          schema: { type: 'object', additionalProperties: true, properties: {} },
          render: (_args, value) => {
            const summary = value && typeof value === 'object' && typeof value.summary === 'string'
              ? value.summary
              : 'Kanban result';
            const detail = (() => {
              try {
                return JSON.stringify(value, null, 2);
              } catch {
                return String(value);
              }
            })();
            return [{ type: 'text', text: `${summary}\n\n${detail.slice(0, 12000)}` }];
          },
        },
        async execute(args, exec) {
          try {
            const value = await runToolAction(args ?? {}, exec);
            // Tool results must be lossless JSON; a computed row may carry
            // `undefined` for an absent optional field, which JSON drops.
            return JSON.parse(JSON.stringify(value));
          } catch (error) {
            if (error && typeof error === 'object' && typeof error.code === 'string') {
              throw new Error(`kanban/${error.code}: ${error.message}`);
            }
            throw error;
          }
        },
      }),
    'kanban: tool',
  );

  function toolError(code, message) {
    return new Error(`kanban/${code}: ${message}`);
  }

  async function runToolAction(args, exec) {
    const agent = exec?.agent;
    if (!agent) throw toolError('agent-required', 'The kanban tool must be called by an agent session.');
    const action = String(args.action ?? 'whoami');
    let project;
    let board;
    let actor;
    try {
      project = await projectForAgent(agent, args.project);
      board = await store.ensure(project);
      actor = await actorForAgent(agent, project, board);
      await store.save(board);
    } catch (error) {
      throw toolError('unresolved', error instanceof Error ? error.message : String(error));
    }
    const projectView = { id: String(project.id), title: project.title, path: project.path };
    // Thought-dispatch guardrail (KB-1): a session linked to a thought may only
    // read and create Backlog tickets. Resolved before execution scoping so a
    // thought session can never borrow execution privileges.
    const callerThoughtState = await loadThoughts(project);
    const callerThought =
      callerThoughtState.thoughts.find(
        (thought) => thought.sessionId && thought.sessionId === actor.sessionId,
      ) ?? null;
    if (callerThought && !THOUGHT_TOOL_ACTIONS.has(action)) {
      throw toolError(
        'thought-read-only',
        `This session is scoped to ${callerThought.id}: only read actions and creating Backlog tickets are allowed.`,
      );
    }
    const scopedTicket = board.tickets.find(
      (ticket) =>
        ticket.execution?.sessionId === actor.sessionId &&
        !['done', 'cancelled', 'failed'].includes(ticket.execution.status),
    ) ?? null;
    const scopedReadOnly = new Set(['whoami', 'projects', 'board', 'list', 'next', 'team', 'members']);
    const scopedMutations = new Set(['claim', 'move', 'update', 'comment', 'review', 'block', 'unblock', 'finish', 'release']);
    if (scopedTicket && !scopedReadOnly.has(action)) {
      if (!scopedMutations.has(action)) {
        throw toolError(
          'execution-scoped',
          `This session is scoped to ${scopedTicket.id}. Action "${action}" is not available; finish or block that ticket instead.`,
        );
      }
      const targetId = String(args.ticketId ?? scopedTicket.id);
      if (targetId !== scopedTicket.id) {
        throw toolError('execution-scoped', `This session may only act on ${scopedTicket.id}, not ${targetId}.`);
      }
    }
    const scopedBrief = () =>
      scopedTicket
        ? {
            id: scopedTicket.id,
            title: scopedTicket.title,
            column: scopedTicket.column,
            execution: scopedTicket.execution ? { status: scopedTicket.execution.status, role: scopedTicket.execution.role, startColumn: scopedTicket.execution.startColumn } : null,
            blocked: scopedTicket.blocked,
            questions: safeArray(scopedTicket.block?.questions).map((question) => question.text),
            needs: safeArray(scopedTicket.block?.needs).map((need) => ({ kind: need.kind, text: need.text })),
          }
        : null;

    const summaryBoard = () => {
      const counts = ticketCounts(board);
      return {
        paused: board.paused,
        counts,
        wip: { ...store.wip },
        tickets: board.tickets.length,
        active: counts.in_progress + counts.review,
      };
    };
    const brief = (ticket) => ({
      id: ticket.id,
      title: ticket.title,
      type: ticket.type,
      parentId: ticket.parentId ?? null,
      priority: ticket.priority,
      column: ticket.column,
      role: ticket.role,
      thoughtId: ticket.thoughtId ?? null,
      owner: ticket.owner ? { name: ticket.owner.name, sessionId: ticket.owner.sessionId } : null,
      assignment: ticket.assignment ? { role: ticket.assignment.role, accessMode: ticket.assignment.accessMode, agentName: ticket.assignment.agentName, auto: ticket.assignment.auto } : null,
      executionStatus: ticket.execution?.status ?? null,
      blocked: ticket.blocked,
      labels: ticket.labels,
      updatedAt: ticket.updatedAt,
    });
    const requireBoardActive = () => {
      if (board.paused) throw toolError('board-paused', 'The board is paused. Ask the Lead to resume it before changing work.');
    };
    const requireLead = () => {
      if (actor.role !== 'tech-lead' && !actor.isLead) {
        throw toolError('role-forbidden', 'Only the tech lead may perform this action.');
      }
    };
    const refreshActor = async () => {
      actor = await actorForAgent(agent, project, board);
    };

    switch (action) {
      case 'whoami': {
        const claimable = ROLE_INDEX[actor.role]?.claimColumns ?? [];
        const actionable = board.tickets
          .filter((ticket) => ticket.column === 'backlog' ? actor.role === 'product-manager' : claimable.includes(ticket.column))
          .filter((ticket) => !ticket.owner || ticket.owner.sessionId === actor.sessionId)
          .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.movedAt - b.movedAt)
          .slice(0, 12)
          .map(brief);
        const mine = board.tickets
          .filter((ticket) => ticket.owner?.sessionId === actor.sessionId)
          .map(brief);
        const role = ROLE_INDEX[actor.role] ?? null;
        const member =
          (actor.memberId ? board.team.members.find((candidate) => candidate.id === actor.memberId) : null) ??
          board.team.members.find(
            (candidate) =>
              (candidate.sessionId && candidate.sessionId === actor.sessionId) ||
              candidate.name.trim().toLowerCase() === actor.name.trim().toLowerCase(),
          ) ??
          null;
        return {
          summary: scopedTicket
            ? `You are ${actor.name} executing ${scopedTicket.id} "${scopedTicket.title}" in ${LANE_LABEL[scopedTicket.column]} (status ${scopedTicket.execution?.status ?? 'unknown'}) on project "${project.title}". The kanban tool is scoped to this ticket.`
            : `You are ${actor.name} (${ROLE_INDEX[actor.role]?.name ?? actor.role}) on project "${project.title}". Board ${board.paused ? 'is PAUSED' : 'is active'}; your claimable columns: ${claimable.join(', ') || 'none'}.`,
          project: projectView,
          agent: { ...actor, memberId: member?.id ?? null, memberName: member?.name ?? null },
          member: member
            ? { id: member.id, name: member.name, title: member.title, roleId: member.roleId, persona: member.persona }
            : null,
          persona: member?.persona ?? '',
          rolePlaybook: role ? rolePlaybookText(role) : '',
          playbook: role ? role.playbook : null,
          memberPrompt: member ? composeAgentPrompt({ role, member }) : '',
          board: summaryBoard(),
          executionTicket: scopedBrief(),
          actionable,
          mine,
          rules: {
            definitionOfReady: DEFINITION_OF_READY,
            definitionOfDone: role ? role.playbook.definitionOfDone : DEFINITION_OF_DONE,
            policy: 'Pull one ticket, move one column at a time, claim before working, review before done, block instead of stalling.',
          },
        };
      }
      case 'projects': {
        const projects = await snapshotProjects(String(project.id));
        return {
          summary: `${projects.length} project workspace(s). Current: ${project.title}.`,
          projects,
        };
      }
      case 'board': {
        const counts = ticketCounts(board);
        return {
          summary: `Board "${project.title}" — ${counts.backlog} backlog, ${counts.ready} ready, ${counts.in_progress} in progress, ${counts.review} review, ${counts.done} done.${board.paused ? ' PAUSED.' : ''}`,
          project: projectView,
          paused: board.paused,
          counts,
          wip: { ...store.wip },
          tickets: (scopedTicket ? [scopedTicket] : board.tickets).map(brief),
        };
      }
      case 'list': {
        const limit = Math.min(Math.max(positiveInt(args.limit, 20), 1), 100);
        const filtered = board.tickets
          .filter((ticket) => (scopedTicket ? ticket.id === scopedTicket.id : true))
          .filter((ticket) => (args.column ? ticket.column === args.column : true))
          .filter((ticket) => (args.role ? ticket.role === args.role : true))
          .filter((ticket) => (args.mine ? ticket.owner?.sessionId === actor.sessionId : true))
          .filter((ticket) => {
            if (!args.owner) return true;
            if (args.owner === 'my' || args.owner === 'me') return ticket.owner?.sessionId === actor.sessionId;
            if (args.owner === 'any') return Boolean(ticket.owner);
            if (args.owner === 'none') return !ticket.owner;
            return ticket.owner?.name === args.owner || ticket.owner?.sessionId === args.owner;
          })
          .sort((a, b) => COLUMN_INDEX[a.column] - COLUMN_INDEX[b.column] || priorityRank(a.priority) - priorityRank(b.priority))
          .slice(0, limit)
          .map(brief);
        return { summary: `${filtered.length} ticket(s) match.`, tickets: filtered };
      }
      case 'next': {
        if (scopedTicket) {
          return {
            summary: `Your scoped ticket is ${scopedTicket.id} "${scopedTicket.title}" in ${LANE_LABEL[scopedTicket.column]} (${scopedTicket.execution?.status ?? 'unknown'}).`,
            ticket: brief(scopedTicket),
          };
        }
        const claimable = ROLE_INDEX[actor.role]?.claimColumns ?? [];
        const next = board.tickets
          .filter((ticket) => claimable.includes(ticket.column))
          .filter((ticket) => !ticket.owner && !ticket.blocked)
          .filter((ticket) => ticket.column !== 'review' || !ticket.role || roleMatches(actor.role, ticket.role))
          .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.movedAt - b.movedAt)[0];
        return {
          summary: next
            ? `Next: ${next.id} "${next.title}" in ${next.column} (${next.priority}, ${ROLE_INDEX[(next.assignment && next.assignment.role) ?? next.role]?.name ?? 'any role'}).${next.assignment ? ` Assigned for this lane to ${next.assignment.agentName ?? ROLE_INDEX[next.assignment.role]?.name ?? next.assignment.role}; use run or claim.` : ' Call claim.'}`
            : `No unowned ticket is currently available for ${ROLE_INDEX[actor.role]?.name ?? actor.role} in ${claimable.join(', ') || 'no column'}.`,
          ticket: next ? brief(next) : null,
        };
      }
      case 'create': {
        requireBoardActive();
        if (!callerThought && actor.role !== 'product-manager' && actor.role !== 'tech-lead' && !actor.isLead) {
          throw toolError('role-forbidden', 'Only the product manager or tech lead creates new tickets; raise a comment on an existing ticket instead.');
        }
        // KB-6: `thoughtId` is server-stamped from the resolved caller session,
        // never read from the tool args. Any forged `args.thoughtId` is ignored,
        // so a thought session can never link a ticket to another thought.
        if (callerThought) {
          // A thought session may only link a child inside an EPIC it created:
          // the parent has to carry the caller's own `thoughtId`.
          const requestedParent = typeof args.parentId === 'string' ? args.parentId.trim() : '';
          if (requestedParent) {
            const parentId = resolveParentId(board, requestedParent, { type: args.type });
            const parent = board.tickets.find((candidate) => candidate.id === parentId) ?? null;
            if (!parent || parent.thoughtId !== callerThought.id) {
              throw parentInvalid(
                `${callerThought.id} may only link a child to an EPIC it created, not ${requestedParent}.`,
              );
            }
          }
        }
        // A thought session always creates in Backlog, whatever it asked for,
        // and the ticket is stamped with the owning thought.
        const ticket = createTicketRecord(
          board,
          {
            title: args.title,
            description: args.description,
            type: args.type,
            priority: args.priority,
            column: callerThought ? 'backlog' : (args.column ?? 'backlog'),
            role: args.role,
            labels: args.labels,
            parentId: args.parentId,
            ...(callerThought ? { thoughtId: callerThought.id } : {}),
          },
          actor.name,
        );
        if (callerThought && !callerThought.ticketIds.includes(ticket.id)) {
          callerThought.ticketIds.push(ticket.id);
          // KB-6 intake audit: exactly one ticket-linked event per created ticket.
          appendThoughtIntake(callerThought, {
            at: clock(),
            type: 'ticket-linked',
            actor: 'pm-session',
            ticketId: ticket.id,
          });
          // KB-5 timeline entry retained unchanged: the drawer timeline shows it.
          appendThoughtAudit(callerThought, {
            at: clock(),
            type: 'ticket',
            actor: actor.name,
            ticketId: ticket.id,
          });
          await thoughtStore.save(project, callerThoughtState);
        }
        await store.save(board);
        return { summary: `Created ${ticket.id}: ${ticket.title}`, ticket: brief(ticket) };
      }
      case 'claim': {
        requireBoardActive();
        const result = await actionClaim({
          workspaceId: String(project.id),
          payload: { ticketId: String(args.ticketId ?? '') },
          actor,
        });
        await refreshActor();
        return {
          summary: `Claimed ${result.ticket.id} "${result.ticket.title}" — now in ${result.ticket.column}.`,
          ticket: brief(result.ticket),
          board: summaryBoard(),
        };
      }
      case 'move': {
        requireBoardActive();
        const result = await actionMove({
          workspaceId: String(project.id),
          payload: { ticketId: String(args.ticketId ?? ''), column: String(args.column ?? ''), note: args.text },
          user: false,
          actor,
        });
        return {
          summary: `Moved ${result.ticket.id} to ${result.ticket.column}.`,
          ticket: brief(result.ticket),
          board: summaryBoard(),
        };
      }
      case 'update': {
        requireBoardActive();
        const ticketId = String(args.ticketId ?? '');
        const existing = findTicket(board, ticketId);
        if (existing.owner?.sessionId !== actor.sessionId && actor.role !== 'tech-lead' && !actor.isLead) {
          throw toolError('role-forbidden', `Only the owner or tech lead can update ${ticketId}.`);
        }
        const result = await actionUpdateBoardTicket({
          workspaceId: String(project.id),
          ticketId,
          patch: {
            title: args.title,
            description: args.description,
            type: args.type,
            priority: args.priority,
            role: args.role,
            labels: args.labels,
            blocked: args.blocked,
            blockReason: args.text,
            // Only forwarded when the caller actually supplied it, so a plain
            // update never clears an existing parent link.
            ...(Object.prototype.hasOwnProperty.call(args, 'parentId') ? { parentId: args.parentId } : {}),
          },
          actor: actor.name,
        });
        return { summary: `Updated ${result.ticket.id}.`, ticket: brief(result.ticket) };
      }
      case 'comment': {
        const result = await actionComment({
          workspaceId: String(project.id),
          payload: { ticketId: String(args.ticketId ?? ''), text: args.text },
          actor,
        });
        return { summary: `Commented on ${result.ticket.id}.`, ticket: brief(result.ticket) };
      }
      case 'review': {
        requireBoardActive();
        const result = await actionRecordReview({
          workspaceId: String(project.id),
          ticketId: String(args.ticketId ?? scopedTicket?.id ?? ''),
          payload: {
            verdict: args.verdict,
            notes: args.notes ?? args.text,
            criteria: args.criteria,
            evidence: args.evidence,
          },
          actor,
        });
        return {
          summary: `Recorded review verdict "${result.review.verdict}" on ${result.ticket.id}. Now move it to ${result.review.verdict === 'accepted' ? 'Done' : 'In Progress'} and call finish.`,
          ticket: brief(result.ticket),
          review: result.review,
        };
      }
      case 'release': {
        requireBoardActive();
        const result = await actionRelease({
          workspaceId: String(project.id),
          payload: { ticketId: String(args.ticketId ?? '') },
          actor,
        });
        return { summary: `Released ${result.ticket.id} back to ${result.ticket.column}.`, ticket: brief(result.ticket) };
      }
      case 'finish': {
        const result = await finishTicketExecution({
          workspaceId: String(project.id),
          ticketId: String(args.ticketId ?? scopedTicket?.id ?? ''),
          summary: args.summary ?? args.text,
          actor: actor.name,
          sessionId: actor.sessionId,
        });
        return {
          summary: `Finished ${result.ticket.id} in ${LANE_LABEL[result.ticket.column]}.`,
          ticket: brief(result.ticket),
          report: result.ticket.execution?.report ?? '',
        };
      }
      case 'run': {
        if (!(actor.role === 'tech-lead' || actor.isLead || actor.role === 'product-manager')) {
          throw toolError('role-forbidden', 'Only the tech lead or product manager can dispatch ticket execution sessions.');
        }
        const result = await startTicketExecution({
          workspaceId: String(project.id),
          ticketId: String(args.ticketId ?? ''),
          role: typeof args.role === 'string' ? args.role : undefined,
          accessMode: typeof args.accessMode === 'string' ? args.accessMode : undefined,
          memberId: typeof args.memberId === 'string' ? args.memberId : undefined,
          actor: actor.name,
          force: false,
        });
        return {
          summary: `Dispatched ${result.ticket.id} to a ${ROLE_INDEX[result.role ?? result.ticket.execution?.role]?.name ?? 'kanban'} session (${result.sessionId}).`,
          ticket: brief(result.ticket),
          sessionId: result.sessionId,
        };
      }
      case 'block':
      case 'unblock': {
        const blocked = action === 'block';
        const ticketId = String(args.ticketId ?? scopedTicket?.id ?? '');
        const existing = findTicket(board, ticketId);
        if (existing.owner?.sessionId !== actor.sessionId && actor.role !== 'tech-lead' && !actor.isLead && actor.role !== 'product-manager') {
          throw toolError('role-forbidden', `Only the owner, product manager, or tech lead can ${blocked ? 'block' : 'unblock'} ${ticketId}.`);
        }
        if (blocked) {
          const result = await blockTicketExecution({
            workspaceId: String(project.id),
            ticketId,
            reason: args.text,
            questions: Array.isArray(args.questions) ? args.questions : [],
            needs: Array.isArray(args.needs) ? args.needs : [],
            actor: actor.name,
          });
          const questions = safeArray(result.ticket.block?.questions).map((question) => question.text);
          return {
            summary: [
              `Blocked ${result.ticket.id}; waiting for the user.`,
              questions.length ? `Questions: ${questions.join(' | ')}` : '',
              'Do not continue until the user answers on the Kanban board; this turn should end here.',
            ].filter(Boolean).join(' '),
            ticket: brief(result.ticket),
            questions,
          };
        }
        const result = await actionUpdateBoardTicket({
          workspaceId: String(project.id),
          ticketId,
          patch: { blocked: false, blockReason: '' },
          actor: actor.name,
        });
        return { summary: `Unblocked ${result.ticket.id}.`, ticket: brief(result.ticket) };
      }
      case 'assign': {
        requireLead();
        const result = await actionAssign({
          workspaceId: String(project.id),
          ticketId: String(args.ticketId ?? ''),
          sessionId: args.sessionId ? String(args.sessionId) : null,
          actor: actor.name,
        });
        return { summary: `Assigned ${result.ticket.id} to ${result.ticket.owner?.name ?? 'nobody'}.`, ticket: brief(result.ticket) };
      }
      case 'team': {
        // The team list is the fixed roster; sessions are attachments, never rows.
        const view = await snapshotTeam(project, board);
        if (view.changed) await store.save(board);
        const roster = rosterRows(board, view.sessions, view.attachments);
        return {
          summary: `${roster.length} team member(s) in project "${project.title}" — ${roster.filter((row) => row.status === 'running').length} running.`,
          team: roster,
          roster,
          board: summaryBoard(),
        };
      }
      case 'members': {
        const view = await snapshotTeam(project, board);
        if (view.changed) await store.save(board);
        const roster = rosterRows(board, view.sessions, view.attachments);
        return {
          summary: `${roster.length} team member(s) on project "${project.title}" — ${roster.filter((row) => row.status === 'running').length} running.`,
          roster,
          drafts: draftRows(board),
        };
      }
      case 'create_member': {
        const drafting = board.team.drafts.find(
          (draft) => draft.status === 'drafting' && draft.sessionId && draft.sessionId === actor.sessionId,
        ) ?? null;
        const requested = args.draftId
          ? board.team.drafts.find((candidate) => candidate.id === String(args.draftId) && candidate.status === 'drafting') ?? null
          : null;
        const draft = requested ?? drafting;
        const draftOwner = Boolean(draft && draft.sessionId && draft.sessionId === actor.sessionId);
        const privileged = actor.role === 'tech-lead' || actor.isLead;
        if (!draftOwner && !privileged) {
          throw toolError('role-forbidden', 'Only the drafting session that owns this draft, or the tech lead, can create roster members.');
        }
        const fallbackRole = draft?.roleId ?? defaultAgentRole(String(args.name ?? ''), String(args.memberDescription ?? args.persona ?? ''));
        const member = createMemberRecord(
          board,
          {
            name: args.name,
            title: args.title,
            roleId: args.role ?? fallbackRole,
            persona: args.persona,
            source: draft ? 'ai' : 'manual',
          },
          { actor: actor.name, source: draft ? 'ai' : 'manual' },
        );
        if (draft) board.team.drafts = board.team.drafts.filter((candidate) => candidate.id !== draft.id);
        await store.save(board);
        return {
          summary: draft
            ? `Created team member ${member.name} (${ROLE_INDEX[member.roleId]?.name ?? member.roleId}) from draft ${draft.id}.`
            : `Created team member ${member.name} (${ROLE_INDEX[member.roleId]?.name ?? member.roleId}).`,
          member,
          draftId: draft?.id ?? null,
        };
      }
      case 'scan': {
        const scan = await scanProject(project);
        lastScans.set(String(project.id), scan);
        board.meta.vision = scan.vision;
        board.meta.docs = scan.docs.map((doc) => ({ path: doc.path, title: doc.title, kind: doc.kind, bytes: 0 }));
        board.meta.conversations = scan.conversations;
        board.meta.mrs = scan.mrs;
        board.meta.lastScanAt = scan.generatedAt;
        pushBoardActivity(board, actor.name, 'scan', `Scanned project: ${scan.candidates.length} candidates`);
        let imported = 0;
        if (args.apply === true) {
          for (const candidate of scan.candidates) {
            const duplicate = board.tickets.some(
              (ticket) => ticket.source && ticket.source.kind === candidate.source.kind && ticket.source.ref === candidate.source.ref,
            );
            if (duplicate) continue;
            createTicketRecord(board, candidate, actor.name);
            imported += 1;
          }
        }
        await store.save(board);
        return {
          summary: `Scanned "${project.title}": ${scan.docs.length} docs, ${scan.mrs.length} open MR/PRs, ${scan.conversations.length} conversations, ${scan.candidates.length} candidate tickets${args.apply === true ? `, imported ${imported}` : ''}.`,
          scan,
          imported,
        };
      }
      case 'pause': {
        requireLead();
        const result = await actionPauseBoard({ workspaceId: String(project.id), actor: actor.name, paused: true });
        return { summary: 'Board paused; agent work was cancelled.', board: { paused: result.board.paused, ...summaryBoard() } };
      }
      case 'resume': {
        requireLead();
        const result = await actionPauseBoard({ workspaceId: String(project.id), actor: actor.name, paused: false });
        return { summary: 'Board resumed.', board: { paused: result.board.paused, ...summaryBoard() } };
      }
      case 'answer': {
        requireLead();
        const rawAnswers = args.answers ?? (typeof args.text === 'string' ? [args.text] : []);
        const answers = Array.isArray(rawAnswers) ? rawAnswers.map(String) : [String(rawAnswers)];
        const result = await answerTicketExecution({
          workspaceId: String(project.id),
          ticketId: String(args.ticketId ?? ''),
          answers,
          grant: Array.isArray(args.grant) ? args.grant.map(String) : [],
          denied: [],
          actor: actor.name,
        });
        return {
          summary: `Answered and resumed ${result.ticket.id}${result.sessionId ? ` (session ${result.sessionId})` : ''}.`,
          ticket: brief(result.ticket),
          sessionId: result.sessionId,
        };
      }
      case 'cancel_execution': {
        requireLead();
        const result = await cancelTicketExecution({
          workspaceId: String(project.id),
          ticketId: String(args.ticketId ?? ''),
          actor: actor.name,
        });
        return { summary: `Cancelled execution for ${result.ticket.id}.`, ticket: brief(result.ticket) };
      }
      case 'debug': {
        requireLead();
        const out = board.tickets
          .filter((ticket) => ticket.execution?.sessionId)
          .map((ticket) => {
            const sessionId = ticket.execution.sessionId;
            const agent = ctx.get('agents')?.get?.(sessionId);
            const session = ctx.get('sessions')?.get?.(sessionId);
            let events = [];
            try {
              events = session ? session.snapshotEvents(Math.max(0, session.seq - 8)).map((event) => event.type) : [];
            } catch {
              events = [];
            }
            return {
              ticket: ticket.id,
              sessionId,
              execution: { status: ticket.execution.status, startColumn: ticket.execution.startColumn },
              agent: agent ? { status: agent.status, inbox: agent.inbox?.hasPending === true } : null,
              session: session ? { seq: session.seq, events } : null,
            };
          });
        // KB-70 AC 10: the debug transcript exposes the scheduler's next tick and
        // the last pulse so an operator can see cadence and overlap state without
        // turning on noisy logging.
        const debugAutopilot = autopilotStatus(board, clock());
        return {
          summary: `${out.length} execution session(s).`,
          executions: out,
          board: summaryBoard(),
          autopilot: {
            enabled: autopilotEnabled(board),
            paused: board.paused === true,
            nextTickAt: debugAutopilot.nextTickAt,
            pulseInFlight: autopilotPulseInFlight(String(project.id)),
            consecutiveErrors: autopilotConsecutiveErrors(board.pulses),
            lastPulse: debugAutopilot.lastPulse,
            budgetRemaining: debugAutopilot.budgetRemaining,
          },
        };
      }
      case 'set_role': {
        requireLead();
        const result = await actionSetRole({
          workspaceId: String(project.id),
          sessionId: String(args.sessionId ?? actor.sessionId),
          role: String(args.role ?? ''),
          actor: actor.name,
        });
        return { summary: `Role updated.`, team: result.team };
      }
      default:
        throw toolError('unknown-action', `Unknown action "${action}".`);
    }
  }

  // -- prompt policy -------------------------------------------------------

  const PROMPT_TEXT = [
    '## Kanban board (project work)',
    'This Harness project has a Kanban board that is the source of truth for what is being worked on.',
    'Use the `kanban` tool before starting project work: call `{"action":"whoami"}` to learn your project,',
    'your role, and the tickets your role may pull, then `{"action":"next"}` and `{"action":"claim","ticketId":"..."}`.',
    'Policy enforced by the tool: columns are Backlog → Ready → In Progress → Review → Done; move ONE column at a',
    'time; WIP limits (In Progress 3, Review 5) and one in-flight ticket per agent; claim before working; raise to',
    'Review only when the change is ready; Review → Done is reserved for reviewer/tester; blocked work must be',
    'flagged with `block` and a reason; a paused board rejects mutations. Never skip columns, never move another',
    'agents ticket, and never claim outside your role columns.',
    `Roles (catalog; each has a rigorous playbook): ${ROLES.map((role) => `${role.id} (${role.summary})`).join('; ')}.`,
    'Your team roster and persona live on the board: call `{"action":"whoami"}` to receive your role playbook and member persona, then `{"action":"members"}` to see teammates. Personas refine HOW a member works, never WHAT the role may do.',
    'Record progress on the ticket: comment decisions, tick checklist items, then advance it. If the project has',
    'no board, offer to scan the project and build one. Load the `kanban-workflow` skill for the full role playbooks,',
    'Definition of Ready/Done, and the exact pull loop; if you are the team Lead, staff missing roles with Agent Teams.',
    'If you are a teammate, never move another agent\'s ticket and never skip a column.',
  ].join(' ');

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'kanban:board-policy',
        order: 700,
        text: PROMPT_TEXT,
      }),
    'kanban: prompt policy',
  );

  // -- role playbook skill -------------------------------------------------

  // Generated from the role catalog (roles.js) so it can never drift.
  const SKILL_CONTENT = buildSkillContent();

  ctx.effect(() => {
    const skills = ctx.get('skills');
    if (!skills || typeof skills.register !== 'function') return () => {};
    try {
      return skills.register({
        name: 'kanban-workflow',
        description: 'Kanban board policy, team roster and persona model, and the rigorous playbook + Definition of Done of every role (PM, UX, FE, BE, fullstack, bug-fixer, reviewer, tester, SRE, tech lead).',
        whenToUse: 'Before starting, claiming, moving, reviewing, or blocking project work on a Kanban board.',
        content: SKILL_CONTENT,
        source: 'runtime',
        provider: 'kanban',
      });
    } catch {
      return () => {};
    }
  }, 'kanban: role skill');

  // -- autopilot scheduler lifecycle (KB-70) -------------------------------

  // The scheduler is a plugin effect: the timer map is armed for enabled boards
  // now and cleaned up on unload, so an unloaded plugin can never keep firing
  // pulses (KB-70 AC 1, KB-67 §11 "timer leak / unload residue").
  ctx.effect(() => {
    autopilotDisposed = false;
    autopilotSweepPromise = startupAutopilotSweep();
    return () => {
      autopilotDisposed = true;
      for (const workspaceId of [...autopilotTimers.keys()]) clearAutopilotTimer(workspaceId);
      autopilotTimers.clear();
      autopilotPulses.clear();
      autopilotRecovery.clear();
      autopilotResumePulses.clear();
    };
  }, 'kanban: autopilot scheduler');

  // Expose a small service surface for other plugins/tests.
  ctx.effect(() => {
    const service = {
      state: (workspaceId) => snapshot(workspaceId),
      projects: () => snapshotProjects(),
      scan: (workspaceId) =>
        loadProject(workspaceId).then(({ project }) => scanProject(project)),
      rules: () => rulesSnapshot(),
      stateDir,
    };
    return ctx.provide ? ctx.provide('kanban', service) : () => {};
  }, 'kanban: service surface');

  return {
    async snapshot(workspaceId) {
      return snapshot(workspaceId);
    },
    /** Resolves once the startup sweep has armed every enabled persisted board. */
    async autopilotReady() {
      if (autopilotSweepPromise) await autopilotSweepPromise;
    },
  };
}
