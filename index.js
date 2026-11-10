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

const VERSION = 2;
const TEAM_VERSION = 1;
const MAX_BODY_BYTES = 512 * 1024;
const SESSION_CACHE_MS = 1500;
const ROSTER_LIMIT = 50;
const DRAFT_LIMIT = 3;
const DRAFT_TIMEOUT_MS = 120 * 1000;
const PERSONA_MAX = 6000;
const MEMBER_NAME_MAX = 48;
const MEMBER_TITLE_MAX = 60;
const MEMBER_DRAFT_DESCRIPTION_MAX = 1000;

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
  constructor(status, code, message) {
    super(message);
    this.name = 'KanbanError';
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new ApiError(400, 'bad-request', message);
const notFound = (message) => new ApiError(404, 'ticket/not-found', message);

function errorPayload(error) {
  if (error instanceof ApiError) {
    return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
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
 * Normalize and (when needed) migrate a persisted board. Version 1 boards are
 * migrated in place: every ticket, checklist, comment, activity entry, agent
 * record, meta field, WIP setting, pause flag and nextNumber survives.
 */
function normalizeBoard(raw, project, wip) {
  if (!raw || typeof raw !== 'object') return newBoard(project, wip);
  const sourceVersion = Number.isFinite(raw.version) ? raw.version : 0;
  if (sourceVersion !== VERSION && sourceVersion !== 1) return newBoard(project, wip);
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
  board.nextNumber = Number.isInteger(board.nextNumber) && board.nextNumber > 0 ? board.nextNumber : 1;
  board.tickets = Array.isArray(board.tickets) ? board.tickets.map(normalizeTicket) : [];
  board.activity = Array.isArray(board.activity) ? board.activity.slice(0, 200) : [];
  board.agents = board.agents && typeof board.agents === 'object' ? board.agents : {};
  board.team = normalizeTeam(board.team);
  board.meta = {
    vision: typeof board.meta?.vision === 'string' ? board.meta.vision : null,
    docs: Array.isArray(board.meta?.docs) ? board.meta.docs : [],
    conversations: Array.isArray(board.meta?.conversations) ? board.meta.conversations : [],
    mrs: Array.isArray(board.meta?.mrs) ? board.meta.mrs : [],
    lastScanAt: Number.isFinite(board.meta?.lastScanAt) ? board.meta.lastScanAt : null,
  };
  if (seedTeam(board)) board[MIGRATED] = migrated;
  if (reconcileDrafts(board).length > 0) board[MIGRATED] = true;
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

function normalizeTicket(raw) {
  const at = Number.isFinite(raw?.createdAt) ? raw.createdAt : now();
  return {
    id: typeof raw?.id === 'string' ? raw.id : `KB-${uid().slice(0, 4)}`,
    number: Number.isInteger(raw?.number) ? raw.number : 0,
    title: clampString(raw?.title, 300) || 'Untitled ticket',
    description: typeof raw?.description === 'string' ? raw.description.slice(0, 20000) : '',
    type: ['story', 'task', 'bug', 'spike'].includes(raw?.type) ? raw.type : 'task',
    priority: ['low', 'medium', 'high', 'critical'].includes(raw?.priority) ? raw.priority : 'medium',
    column: COLUMN_IDS.includes(raw?.column) ? raw.column : 'backlog',
    role: ALL_ROLES.includes(raw?.role) ? raw.role : null,
    labels: Array.isArray(raw?.labels) ? raw.labels.filter((label) => typeof label === 'string').slice(0, 12) : [],
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
    comments: Array.isArray(raw?.comments)
      ? raw.comments
          .filter((comment) => comment && typeof comment.text === 'string')
          .slice(-100)
          .map((comment) => ({
            id: typeof comment.id === 'string' ? comment.id : uid(),
            author: clampString(comment.author, 120) || 'agent',
            text: comment.text.slice(0, 4000),
            at: Number.isFinite(comment.at) ? comment.at : now(),
          }))
      : [],
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

/** Per-workspace JSON board store: single writer, atomic replace, in-memory cache. */
class BoardStore {
  constructor(dir, wip) {
    this.dir = dir;
    this.wip = wip;
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

  async save(board) {
    board.updatedAt = now();
    const workspaceId = board.workspaceId;
    const previous = this.pending.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const target = this.file(workspaceId);
        const temp = `${target}.tmp-${process.pid}-${now()}`;
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

// ---------------------------------------------------------------------------
// Host plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  const stateDir = typeof settings.stateDir === 'string' && settings.stateDir.length > 0
    ? settings.stateDir
    : join(dshHome(), 'kanban');
  const store = new BoardStore(stateDir, defaultWip(settings));
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
      board.agents[key] = entry;
    } else {
      if (hints.name && (!entry.name || entry.name.startsWith('Agent '))) entry.name = hints.name;
      if (hints.role && !ALL_ROLES.includes(entry.role)) entry.role = hints.role;
      if (!ALL_ROLES.includes(entry.role)) entry.role = defaultAgentRole(entry.name, hints.description);
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

  async function snapshotTeam(project, board) {
    const [allSessions, teamIndex] = await Promise.all([readSessions(), liveTeamIndex()]);
    const draftingSessions = new Set(
      board.team.drafts.filter((draft) => draft.status === 'drafting' && draft.sessionId).map((draft) => draft.sessionId),
    );
    const relevant = allSessions.filter(
      (session) =>
        owningWorkspace(session.cwd)?.id === project.id &&
        !draftingSessions.has(session.sessionId) &&
        board.agents?.[session.sessionId]?.draft !== true,
    );
    const seen = new Set();
    const rows = [];
    for (const session of relevant) {
      const membership = teamIndex.get(session.sessionId);
      const rawTitle = session.title && !/^(Session |New session$)/.test(session.title) ? session.title : '';
      const named = /You are `([^`]{2,60})`/.exec(rawTitle ?? '');
      const titleName = named
        ? named[1]
        : rawTitle
          ? rawTitle.replace(/\s+/g, ' ').slice(0, 60)
          : '';
      const hints = membership
        ? { name: membership.name, role: defaultAgentRole(membership.name, '') }
        : titleName
          ? { name: titleName }
          : {};
      const entry = ensureBoardAgent(board, session.sessionId, hints);
      if (membership && !entry.executionTicketId) entry.name = membership.name;
      else if (titleName && !entry.executionTicketId) entry.name = titleName;
      const activeTicket = board.tickets.find(
        (ticket) =>
          ticket.owner?.sessionId === session.sessionId &&
          (entry.executionTicketId === ticket.id || ticket.column === 'in_progress' || ticket.column === 'review'),
      );
      const isLead = entry.executionTicketId ? false : membership ? membership.role === 'lead' : board.tickets.some(
        (ticket) => ticket.owner?.sessionId === session.sessionId && ticket.column === 'in_progress',
      );
      const paused = entry.paused === true;
      rows.push({
        sessionId: session.sessionId,
        name: entry.name,
        role: entry.role,
        roleName: ROLE_INDEX[entry.role]?.name ?? entry.role,
        status: paused ? 'paused' : session.running ? 'running' : 'idle',
        ticketId: activeTicket?.id ?? null,
        ticketTitle: activeTicket?.title ?? null,
        isLead: Boolean(isLead),
        paused,
        description: membership ? (membership.role === 'lead' ? 'Team lead' : 'Team teammate') : undefined,
      });
      seen.add(session.sessionId);
    }
    // Live agents whose sessions are not in the summary cache still count,
    // but only when their Team root belongs to THIS project.
    const projectSessionIds = new Set(relevant.map((session) => session.sessionId));
    for (const [sessionId, membership] of teamIndex) {
      if (seen.has(sessionId)) continue;
      if (!projectSessionIds.has(sessionId) && !projectSessionIds.has(String(membership.leadId))) continue;
      const entry = ensureBoardAgent(board, sessionId, { name: membership.name, role: defaultAgentRole(membership.name, '') });
      rows.push({
        sessionId,
        name: entry.name,
        role: entry.role,
        roleName: ROLE_INDEX[entry.role]?.name ?? entry.role,
        status: entry.paused ? 'paused' : 'running',
        ticketId: null,
        ticketTitle: null,
        isLead: membership.role === 'lead',
        paused: entry.paused === true,
        description: membership.role === 'lead' ? 'Team lead' : 'Team teammate',
      });
    }
    const nameCounts = new Map();
    for (const row of rows) nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
    for (const row of rows) {
      if ((nameCounts.get(row.name) ?? 0) > 1) row.name = `${row.name} · ${row.sessionId.slice(-4)}`;
    }
    rows.sort((a, b) => Number(b.isLead) - Number(a.isLead) || a.name.localeCompare(b.name));
    return { rows, sessions: relevant };
  }

  // -- team roster ---------------------------------------------------------

  /** Link a live agent session to the roster member it represents (name match). */
  function linkRosterSession(board, sessionId, name) {
    const key = String(name ?? '').trim().toLowerCase();
    if (!key) return null;
    const member = board.team.members.find((candidate) => candidate.name.trim().toLowerCase() === key);
    if (!member || member.sessionId === sessionId || member.sessionId) return null;
    member.sessionId = String(sessionId);
    member.updatedAt = now();
    return member;
  }

  /** Auto-link sessions that joined through Agent Teams to their roster member. */
  function reconcileRosterLinks(board, sessions) {
    let changed = false;
    const known = new Set((sessions ?? []).map((session) => session.sessionId));
    for (const [sessionId, entry] of Object.entries(board.agents ?? {})) {
      if (!known.has(sessionId) || !entry || typeof entry.name !== 'string') continue;
      if (linkRosterSession(board, sessionId, entry.name)) changed = true;
    }
    return changed;
  }

  function memberTicket(board, member) {
    return board.tickets.find(
      (ticket) =>
        (ticket.column === 'in_progress' || ticket.column === 'review') &&
        (ticket.owner?.memberId === member.id ||
          (member.sessionId && ticket.owner?.sessionId === member.sessionId) ||
          ticket.assignment?.memberId === member.id),
    );
  }

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
   * Live status: paused > working (owns an in_progress/review ticket) >
   * running (linked session running) > idle (linked session known) > offline.
   */
  function memberStatus(board, member, sessions) {
    if (member.paused) return 'paused';
    if (memberTicket(board, member)) return 'working';
    if (!member.sessionId) return 'offline';
    const session = sessions.find((candidate) => candidate.sessionId === member.sessionId);
    if (session?.running) return 'running';
    try {
      const agent = ctx.get('agents')?.get?.(member.sessionId);
      if (agent && agent.status === 'running') return 'running';
    } catch {
      // agents service is optional
    }
    return session ? 'idle' : 'offline';
  }

  function memberStatusReason(board, member, sessions) {
    if (member.paused) return 'Member is paused';
    const ticket = memberTicket(board, member);
    if (ticket) return `Owns ${ticket.id} in ${ticket.column}`;
    if (!member.sessionId) return 'No linked session';
    const session = sessions.find((candidate) => candidate.sessionId === member.sessionId);
    let running = session?.running === true;
    try {
      const agent = ctx.get('agents')?.get?.(member.sessionId);
      if (agent && agent.status === 'running') running = true;
    } catch {
      // agents service is optional
    }
    if (running) return 'Linked session is running';
    return session ? 'Linked session is idle' : 'Linked session is no longer active';
  }

  function rosterRows(board, sessions) {
    const order = new Map(ALL_ROLES.map((roleId, index) => [roleId, index]));
    return board.team.members
      .map((member) => {
        const ticket = memberTicket(board, member);
        return {
          id: member.id,
          name: member.name,
          title: member.title,
          roleId: member.roleId,
          roleName: ROLE_INDEX[member.roleId]?.name ?? member.roleId,
          persona: member.persona,
          paused: member.paused,
          sessionId: member.sessionId,
          createdAt: member.createdAt,
          updatedAt: member.updatedAt,
          createdBy: member.createdBy,
          source: member.source,
          status: memberStatus(board, member, sessions),
          statusReason: memberStatusReason(board, member, sessions),
          currentTicket: ticket ? { id: ticket.id, title: ticket.title, column: ticket.column } : null,
          since: ticket ? ticket.movedAt : null,
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
        rules: rulesSnapshot(),
        lastScan: null,
      };
    }
    const sessionsForDefault = await readSessions();
    const project = projectFor(workspaceId, sessionsForDefault);
    const board = await store.ensure(project);
    await reconcileExecutions(board);
    const { rows, sessions } = await snapshotTeam(project, board);
    // A session that joined through Agent Teams adopts the roster member it
    // names; persist that link so the roster sees it on the next read.
    const linked = reconcileRosterLinks(board, sessions);
    const timedOutDrafts = reconcileDrafts(board);
    for (const sessionId of timedOutDrafts) {
      try {
        ctx.sessionController.cancel({ sessionId });
      } catch {
        // best effort: the draft is already marked failed for retry
      }
    }
    const roster = rosterRows(board, sessions);
    const drafts = draftRows(board);
    if (linked || timedOutDrafts.length > 0) await store.save(board);
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
      execution: executionSummary(board),
      team: rows,
      roster,
      drafts,
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

  function activeTicketOf(board, sessionId) {
    return board.tickets.find(
      (ticket) =>
        ticket.owner?.sessionId === sessionId &&
        (ticket.column === 'in_progress' || ticket.column === 'review'),
    );
  }

  function validateMove(ticket, to, role, actor, { user = false } = {}) {
    if (!COLUMN_IDS.includes(to)) throw badRequest(`Unknown column: ${to}`);
    const from = ticket.column;
    if (from === to) return;
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
    const limit = store.wip[to] ?? 0;
    if (limit <= 0) return { over: false, limit };
    const count = board.tickets.filter((ticket) => ticket.column === to).length;
    if (count >= limit) {
      throw new ApiError(409, 'ticket/wip-limit', `WIP limit reached for ${to} (${count}/${limit}). Finish or unblock work before pulling more.`);
    }
    return { over: false, limit };
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
    const number = nextTicketNumber(board);
    const title = clampString(input.title, 300);
    if (!title) throw badRequest('A ticket title is required.');
    const column = COLUMN_IDS.includes(input.column) ? input.column : 'backlog';
    const role = ALL_ROLES.includes(input.role) ? input.role : null;
    const ticket = {
      id: `KB-${number}`,
      number,
      title,
      description: typeof input.description === 'string' ? input.description.slice(0, 20000) : '',
      type: ['story', 'task', 'bug', 'spike'].includes(input.type) ? input.type : 'task',
      priority: ['low', 'medium', 'high', 'critical'].includes(input.priority) ? input.priority : 'medium',
      column,
      role,
      labels: Array.isArray(input.labels)
        ? input.labels.filter((label) => typeof label === 'string').slice(0, 12)
        : [],
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

  function executionRoleFor(ticket) {
    const laneRoles = LANE_CLAIM_ROLES[ticket.column] ?? LANE_CLAIM_ROLES.ready;
    if (ticket.column === 'review') return ticket.role === 'tester' ? 'tester' : 'reviewer';
    if (ticket.column === 'backlog') return 'product-manager';
    if (laneRoles.includes(ticket.role)) return ticket.role;
    const inferred = inferRole(`${ticket.title} ${ticket.description} ${ticket.labels.join(' ')}`);
    if (laneRoles.includes(inferred)) return inferred;
    return 'fullstack-developer';
  }

  function executionRoleAllowed(column, role) {
    return (LANE_CLAIM_ROLES[column] ?? []).includes(role);
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

  function handoffRoleFor(ticket, to) {
    if (to === 'review') return ticket.role === 'tester' ? 'tester' : 'reviewer';
    if (to === 'backlog') return 'product-manager';
    if (to === 'ready') return executionRoleFor({ ...ticket, column: 'ready' });
    return null;
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
    if (ticket.column === 'review') return 'read-only';
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
      const sandbox = column === 'backlog' || column === 'review' || column === 'done' ? 'read-only' : 'workspace-write';
      const match = options.find((option) => accessSandbox(option.value, presets) === sandbox) ?? options.find((option) => option.value === sandbox) ?? options[0];
      suggestions[column] = match ? match.value : 'workspace-write';
    }
    return suggestions;
  }

  function suggestAgentForRole(board, role) {
    let best = null;
    for (const [sessionId, entry] of Object.entries(board.agents ?? {})) {
      if (!entry || entry.role !== role || entry.paused === true || entry.executionTicketId) continue;
      if (entry.isLead === true || /^lead\b/i.test(entry.name || '')) continue;
      const busy = board.tickets.some(
        (ticket) =>
          ticket.owner?.sessionId === sessionId &&
          (ticket.column === 'in_progress' || ticket.column === 'review') &&
          ticket.execution?.status === 'running',
      );
      if (busy) continue;
      const candidate = { agentSessionId: sessionId, agentName: entry.name || `Agent ${sessionId.slice(-4)}` };
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

  function executionPrompt(ticket, project, role, mode, member = null) {
    const roleName = ROLE_INDEX[role]?.name ?? role;
    const composition = composeAgentPrompt({ role: ROLE_INDEX[role] ?? role, member: member ?? null });
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
            ? 'You are the review gate. Verify the change against the acceptance criteria. Accept to Done when it passes, or move it back to In Progress with a concrete change request. Do not edit code unless the ticket explicitly asks you to.'
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
      comments ? `\nRecent comments:\n${comments}` : '',
      ticket.source ? `\nSource: ${ticket.source.kind} ${ticket.source.ref}${ticket.source.url ? ` ${ticket.source.url}` : ''}` : '',
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

  async function startTicketExecution({ workspaceId, ticketId, role, accessMode, actor, memberId, force = false }) {
    const { project, board } = await loadProject(workspaceId);
    if (board.paused) throw new ApiError(423, 'board/paused', 'The board is paused. Resume it before dispatching agents.');
    const ticket = findTicket(board, ticketId);
    if (!['backlog', 'ready', 'review'].includes(ticket.column)) {
      throw new ApiError(409, 'ticket/lane', `Tickets in ${ticket.column} cannot be dispatched to an agent by the board.`);
    }
    if (ticket.blocked) throw new ApiError(409, 'ticket/blocked', 'Answer the blocked questions before dispatching this ticket.');
    const existing = ticket.execution;
    if (!force && existing?.sessionId && ['running', 'idle', 'blocked', 'paused'].includes(existing.status)) {
      return resumeTicketExecution({ workspaceId, ticketId, actor, message: 'Continue working on your Kanban ticket.' });
    }
    const handoff = ticket.assignment ? { ...ticket.assignment } : null;
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
    const requestedAccess = typeof accessMode === 'string' && accessMode ? accessMode : (handoff && handoff.accessMode ? handoff.accessMode : undefined);
    const access = resolveAccessMode(requestedAccess, ticket, chosenRole);
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
    ensureBoardAgent(board, agentId, { name, role: chosenRole });
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
      executionPrompt(ticket, project, chosenRole, 'start', member),
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
      const context = executionPrompt(ticket, project, execution.role ?? executionRoleFor(ticket), 'resume', member);
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
    let changed = false;
    for (const ticket of board.tickets) {
      const execution = ticket.execution;
      if (!execution?.sessionId) continue;
      if (!['running', 'idle'].includes(execution.status)) continue;
      let agent;
      try {
        agent = ctx.get('agents')?.get?.(execution.sessionId);
      } catch {
        agent = undefined;
      }
      if (!agent) {
        if (execution.status === 'running' && !board.paused) {
          execution.status = 'idle';
          execution.updatedAt = now();
          changed = true;
        }
        continue;
      }
      const live = agent.status;
      if (live === 'idle' && execution.status === 'running') {
        execution.status = 'idle';
        execution.updatedAt = now();
        changed = true;
      } else if (live === 'running' && execution.status === 'idle') {
        execution.status = 'running';
        execution.updatedAt = now();
        changed = true;
      }
    }
    if (changed) await store.save(board);
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
    return { project, board };
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
    validateMove(ticket, target, user ? 'tech-lead' : actor.role, actor, { user });
    if (!user) {
      const active = activeTicketOf(board, actor.sessionId);
      if (active && active.id !== ticket.id) {
        throw new ApiError(409, 'agent/wip-limit', `${actor.name} already has ${active.id} in flight. Finish it before pulling another ticket.`);
      }
    }
    if (!user) {
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
    pushTicketActivity(ticket, withActor(actor.name), 'move', `${from} → ${target}${payload.note ? ` — ${clampString(payload.note, 300)}` : ''}`);
    pushBoardActivity(board, withActor(actor.name), 'ticket/move', `${ticket.id}: ${from} → ${target}`, ticket.id);
    await store.save(board);
    return { ticket };
  }

  async function actionClaim({ workspaceId, payload, actor }) {
    const { board } = await loadProject(workspaceId);
    if (board.paused) throw new ApiError(423, 'board/paused', 'The board is paused. Resume it before claiming work.');
    const ticket = findTicket(board, payload.ticketId);
    if (ticket.owner && ticket.owner.sessionId !== actor.sessionId) {
      throw new ApiError(409, 'ticket/claimed', `${ticket.id} is already owned by ${ticket.owner.name}.`);
    }
    if (ticket.owner?.sessionId === actor.sessionId) {
      // An execution session is already the owner at dispatch; claiming it is the
      // signal to advance from its start lane (backlog→ready, ready→in_progress).
      const target = ticket.column === 'backlog' ? 'ready' : ticket.column === 'ready' ? 'in_progress' : ticket.column;
      if (ticket.execution?.sessionId === actor.sessionId && target !== ticket.column) {
        enforceWip(board, target);
        const from = ticket.column;
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
    if (target !== ticket.column) enforceWip(board, target);
    ticket.owner = refinement ? null : { sessionId: actor.sessionId, name: actor.name, role };
    ticket.role = ticket.role ?? (DEV_ROLES.has(role) ? role : null);
    const from = ticket.column;
    if (target !== from) {
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
    await store.save(board);
    return { ticket };
  }

  async function actionUpdateBoardTicket({ workspaceId, ticketId, patch, actor }) {
    const { board } = await loadProject(workspaceId);
    const ticket = findTicket(board, ticketId);
    if (typeof patch.title === 'string') {
      const title = clampString(patch.title, 300);
      if (title) ticket.title = title;
    }
    if (typeof patch.description === 'string') ticket.description = patch.description.slice(0, 20000);
    if (['story', 'task', 'bug', 'spike'].includes(patch.type)) ticket.type = patch.type;
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
      const entry = ensureBoardAgent(board, actorKey);
      const team = await snapshotTeam(project, board);
      const row = team.rows.find((member) => member.sessionId === actorKey);
      ticket.owner = {
        sessionId: actorKey,
        name: row?.name ?? entry.name,
        role: ALL_ROLES.includes(entry.role) ? entry.role : null,
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
    } else {
      pushBoardActivity(board, actor, 'board/resume', 'Board resumed');
    }
    await store.save(board);
    return { board };
  }

  async function actionAgentPause({ workspaceId, sessionId, actor, paused }) {
    const { board, project } = await loadProject(workspaceId);
    const key = String(sessionId);
    const team = await snapshotTeam(project, board);
    const row = team.rows.find((member) => member.sessionId === key);
    if (!row) throw new ApiError(404, 'agent/not-found', `No agent session ${key} belongs to this project.`);
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
    const team = await snapshotTeam(project, board);
    const row = team.rows.find((member) => member.sessionId === key);
    if (!row) throw new ApiError(404, 'agent/not-found', `No agent session ${key} belongs to this project.`);
    const entry = ensureBoardAgent(board, key, { name: row.name });
    entry.role = role;
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
    const entry = ensureBoardAgent(board, sessionId, { name });
    if (entry.executionTicketId) {
      // Execution sessions carry their dispatch identity, not a Team lead label.
      entry.isLead = false;
    } else if (teamRole === 'lead') {
      entry.isLead = true;
    }
    // A session that joined through Agent Teams adopts the roster member it
    // names, so its persona and role stay attached to the person.
    const linkedMember = linkRosterSession(board, sessionId, entry.name);
    if (linkedMember && !entry.executionTicketId) entry.role = linkedMember.roleId;
    return {
      sessionId,
      name: entry.name,
      role: entry.role,
      isLead: entry.isLead === true,
      executionTicketId: entry.executionTicketId ?? null,
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
    'set_role | debug | answer | cancel_execution.',
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
          'comment', 'release', 'block', 'unblock', 'finish', 'run', 'assign', 'team', 'members',
          'create_member', 'scan', 'pause', 'resume', 'set_role', 'debug', 'answer', 'cancel_execution',
        ],
        description: 'Operation to perform.',
      },
      project: { type: 'string', description: 'Workspace id or title; defaults to your session workspace.' },
      ticketId: { type: 'string', description: 'Ticket id such as KB-12.' },
      column: { type: 'string', enum: COLUMN_IDS, description: 'Target column for move/create/list filters.' },
      title: { type: 'string', description: 'Ticket title for create.' },
      description: { type: 'string', description: 'Ticket description for create/update.' },
      type: { type: 'string', enum: ['story', 'task', 'bug', 'spike'], description: 'Ticket type.' },
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
    const scopedTicket = board.tickets.find(
      (ticket) =>
        ticket.execution?.sessionId === actor.sessionId &&
        !['done', 'cancelled', 'failed'].includes(ticket.execution.status),
    ) ?? null;
    const scopedReadOnly = new Set(['whoami', 'projects', 'board', 'list', 'next', 'team', 'members']);
    const scopedMutations = new Set(['claim', 'move', 'update', 'comment', 'block', 'unblock', 'finish', 'release']);
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
      priority: ticket.priority,
      column: ticket.column,
      role: ticket.role,
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
        const member = board.team.members.find(
          (candidate) =>
            (candidate.sessionId && candidate.sessionId === actor.sessionId) ||
            candidate.name.trim().toLowerCase() === actor.name.trim().toLowerCase(),
        ) ?? null;
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
        if (actor.role !== 'product-manager' && actor.role !== 'tech-lead' && !actor.isLead) {
          throw toolError('role-forbidden', 'Only the product manager or tech lead creates new tickets; raise a comment on an existing ticket instead.');
        }
        const ticket = createTicketRecord(
          board,
          {
            title: args.title,
            description: args.description,
            type: args.type,
            priority: args.priority,
            column: args.column ?? 'backlog',
            role: args.role,
            labels: args.labels,
          },
          actor.name,
        );
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
        const team = await snapshotTeam(project, board);
        await store.save(board);
        return {
          summary: `${team.rows.length} agent(s) in project "${project.title}".`,
          team: team.rows,
          board: summaryBoard(),
        };
      }
      case 'members': {
        const sessions = await readSessions();
        const roster = rosterRows(board, sessions);
        return {
          summary: `${roster.length} team member(s) on project "${project.title}" — ${roster.filter((row) => row.status === 'working').length} working.`,
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
        return { summary: `${out.length} execution session(s).`, executions: out, board: summaryBoard() };
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
  };
}
