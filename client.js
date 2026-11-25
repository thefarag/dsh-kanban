/*
 * DSH Kanban board — browser half.
 *
 * Registers a sidebar panel icon (`sidebar.panellist`, id `kanban`) and its main
 * panel (`main`, key `kanban`), then renders a fully interactive Kanban board:
 * project selector over DSH workspaces, five drag-and-drop columns, ticket
 * detail drawer, new-ticket dialog, team rail with a persisted member roster
 * (member editor, AI drafts, role playbooks) plus session agents with
 * pause/resume, board pause, project scanner with candidate import, toasts, and
 * empty/error states.
 *
 * Talks to the Host half over two same-origin authenticated JSON routes:
 *   POST kanban/state   { workspaceId }
 *   POST kanban/action  { workspaceId, action, payload }
 * Both answer `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
 *
 * Constraints honoured here: one file, no JSX, no build step, only the React
 * module, scoped `kb-` CSS rendered from a style element, and every colour from
 * the `--dsw-alias-*` / `--dsw-specific-*` theme token set.
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-kanban',
	factory: (require) => {
		const React = require('react')
		const h = React.createElement
		const useState = React.useState
		const useEffect = React.useEffect
		const useMemo = React.useMemo
		const useRef = React.useRef
		const useCallback = React.useCallback

		// ------------------------------------------------------------------
		// Constants + pure helpers
		// ------------------------------------------------------------------

		const NS = 'kanban'
		const STORAGE_KEY = 'dsh.kanban.workspace'
		const POLL_MS = 2500
		const COLUMNS = ['backlog', 'ready', 'in_progress', 'review', 'done']
		const TYPES = ['story', 'task', 'bug', 'spike', 'epic']
		const PRIORITIES = ['low', 'medium', 'high', 'critical']
		const ROLE_IDS = [
			'product-manager',
			'ux-designer',
			'fe-developer',
			'be-developer',
			'fullstack-developer',
			'reviewer',
			'tester',
			'sre',
			'tech-lead',
			'bug-fixer',
		]
		// MemberRow.status values are derived by the host from the attached agent.
		const MEMBER_STATUSES = ['paused', 'running', 'idle', 'offline']
		const AGENT_STATUSES = ['running', 'idle', 'paused', 'provisioning', 'failed']
		const DRAFT_LIMIT = 3
		const UNASSIGNED = '__unassigned__'
		const PRIORITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 }
		// Smallest Kanban panel width that still holds the five workflow lanes plus the
		// conditional Blocked lane without horizontal board scrolling:
		// 6 × 176px lane floor + 5 × 12px gaps + 2 × 14px board padding.
		const BLOCKED_LANE_MIN_WIDTH = 1144

		function classNames() {
			const parts = []
			for (let index = 0; index < arguments.length; index += 1) {
				const part = arguments[index]
				if (part) parts.push(part)
			}
			return parts.join(' ')
		}

		function safeArray(value) {
			return Array.isArray(value) ? value : []
		}

		function safeString(value) {
			return typeof value === 'string' ? value : ''
		}

		function safeNumber(value, fallback) {
			return typeof value === 'number' && Number.isFinite(value) ? value : fallback
		}

		function normalizePath(value) {
			return safeString(value)
				.replace(/\\/g, '/')
				.replace(/\/+$/, '')
				.toLowerCase()
		}

		function initialsOf(name) {
			const parts = safeString(name).trim().split(/\s+/).filter(Boolean)
			if (parts.length === 0) return '?'
			if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
			return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase()
		}

		function formatAge(at, t) {
			const stamp = safeNumber(at, 0)
			if (!stamp) return ''
			const diff = Date.now() - stamp
			if (!Number.isFinite(diff) || diff < 60000) return t('time.justNow')
			const minutes = Math.floor(diff / 60000)
			if (minutes < 60) return t('time.minutes', { n: minutes })
			const hours = Math.floor(diff / 3600000)
			if (hours < 24) return t('time.hours', { n: hours })
			const days = Math.floor(diff / 86400000)
			if (days < 7) return t('time.days', { n: days })
			return t('time.weeks', { n: Math.floor(days / 7) })
		}

		function columnLabel(column, t) {
			if (typeof column === 'string' && COLUMNS.indexOf(column) !== -1) return t('columns.' + column)
			return safeString(column)
		}

		/** Localized label for a MemberRow / AgentRow status; never returns a raw key. */
		function statusLabel(status, t) {
			const value = safeString(status)
			const known = MEMBER_STATUSES.concat(AGENT_STATUSES)
			return known.indexOf(value) === -1 ? t('status.idle') : t('status.' + value)
		}

		/** `id · title` for a member's current ticket, or '' when idle. */
		function memberTicketText(member) {
			const ticket = member && member.currentTicket && typeof member.currentTicket === 'object' ? member.currentTicket : null
			if (!ticket || typeof ticket.id !== 'string' || !ticket.id) return ''
			const title = safeString(ticket.title)
			return ticket.id + (title ? ' · ' + title : '')
		}

		// ------------------------------------------------------------------
		// Autopilot controls (KB-76) — pure state machine and view helpers
		// ------------------------------------------------------------------
		//
		// Host contract (KB-68/KB-69/KB-70): `autopilot {op:'status'|'configure'|
		// 'plan'|'pulseNow'}` through `/kanban/action`. The snapshot carries the
		// derived read model `snapshot.autopilot` (config, nextTickAt, lastPulse,
		// budgetRemaining) plus the persisted `board.autopilot` / `board.pulses`.
		// The dry run returns `{generatedAt, decisions[], skips[]}` without writing
		// or starting anything; `pulseNow` returns `{pulse}` and can answer
		// `409 autopilot/pulsing`. Everything below is dependency-free so the UI
		// state machine can be tested without a DOM (tests/autopilot-ui.test.mjs).

		const AUTOPILOT_CONFIRM_KEY = 'dsh.kanban.autopilot.phase1-confirmed'
		const AUTOPILOT_COMMIT_MS = 220
		const AUTOPILOT_LANES = ['refine', 'implement', 'review']
		const AUTOPILOT_CADENCE_MINUTES = [5, 10, 15, 30, 60]
		const AUTOPILOT_DEPTH_OPTIONS = (() => {
			const list = []
			for (let value = 0; value <= 20; value += 1) list.push(value)
			return list
		})()
		const AUTOPILOT_LANE_CAP_OPTIONS = [0, 1, 2, 3]
		// Closed reason-code vocabulary the host planner emits. Unknown codes from a
		// newer host still render (a localized fallback carrying the raw code).
		const AUTOPILOT_REASON_CODES = [
			'admitted',
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
			'no-work',
		]

		/** `true` once the phase-1 one-time confirmation was dismissed in this browser. */
		function readAutopilotConfirmSeen() {
			try {
				return window.localStorage.getItem(AUTOPILOT_CONFIRM_KEY) === '1'
			} catch (error) {
				return false
			}
		}

		function markAutopilotConfirmSeen() {
			try {
				window.localStorage.setItem(AUTOPILOT_CONFIRM_KEY, '1')
			} catch (error) {
				// storage is best-effort; the confirmation reappears next session
			}
		}

		/**
		 * Pause cause for the header status: the board pause wins, otherwise a
		 * roster whose every member is paused. `null` when autopilot is effective.
		 */
		function autopilotPauseCause(snapshot) {
			const snap = snapshot && typeof snapshot === 'object' ? snapshot : null
			const board = snap && snap.board && typeof snap.board === 'object' ? snap.board : null
			if (board && board.paused === true) return 'board'
			const roster = snap && Array.isArray(snap.roster) ? snap.roster.filter((member) => member && typeof member === 'object') : []
			if (roster.length > 0 && roster.every((member) => member.paused === true)) return 'member'
			return null
		}

		/** Normalize the public config view (status) or the persisted envelope to one shape. */
		function normalizeAutopilotConfig(raw) {
			if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
			const laneCaps = raw.laneCaps && typeof raw.laneCaps === 'object' ? raw.laneCaps : {}
			const rawBudget = raw.budget && typeof raw.budget === 'object' ? raw.budget : {}
			const hourLimit =
				typeof rawBudget.hour === 'number'
					? rawBudget.hour
					: safeNumber(rawBudget.hour && rawBudget.hour.limit, 20)
			const dayLimit =
				typeof rawBudget.day === 'number' ? rawBudget.day : safeNumber(rawBudget.day && rawBudget.day.limit, 60)
			return {
				enabled: raw.enabled === true,
				cadenceMs: safeNumber(raw.cadenceMs, 300000),
				maxReadyDepth: safeNumber(raw.maxReadyDepth, 3),
				laneCaps: {
					refine: safeNumber(laneCaps.refine, 1),
					implement: safeNumber(laneCaps.implement, 1),
					review: safeNumber(laneCaps.review, 1),
				},
				maxDispatchesPerPulse: safeNumber(raw.maxDispatchesPerPulse, 1),
				budget: { hour: hourLimit, day: dayLimit },
				backoffMs: safeNumber(raw.backoffMs, 300000),
				staleMs: safeNumber(raw.staleMs, 600000),
			}
		}

		/** Dispatch-budget read-out: derived remaining first, persisted counters as fallback. */
		function autopilotBudgetView(runtime, envelope) {
			const remaining =
				runtime && runtime.budgetRemaining && typeof runtime.budgetRemaining === 'object' ? runtime.budgetRemaining : null
			if (remaining && remaining.hour && remaining.day) {
				return {
					hour: {
						used: safeNumber(remaining.hour.used, 0),
						limit: safeNumber(remaining.hour.limit, 0),
						remaining: safeNumber(remaining.hour.remaining, 0),
					},
					day: {
						used: safeNumber(remaining.day.used, 0),
						limit: safeNumber(remaining.day.limit, 0),
						remaining: safeNumber(remaining.day.remaining, 0),
					},
				}
			}
			const budget = envelope && envelope.budget && typeof envelope.budget === 'object' ? envelope.budget : null
			if (!budget) return null
			const unit = (window) => {
				// A config view stores the limit as a number; the persisted envelope
				// stores a `{limit, used, windowStart}` object. Accept both.
				if (typeof window === 'number') {
					const limit = safeNumber(window, 0)
					return { used: 0, limit, remaining: limit }
				}
				const value = window && typeof window === 'object' ? window : {}
				const limit = safeNumber(value.limit, 0)
				const used = Math.min(limit, Math.max(0, safeNumber(value.used, 0)))
				return { used, limit, remaining: Math.max(0, limit - used) }
			}
			return { hour: unit(budget.hour), day: unit(budget.day) }
		}

		/** Read-model view of autopilot from a snapshot; every field is optional. */
		function autopilotViewFromSnapshot(snapshot) {
			const snap = snapshot && typeof snapshot === 'object' ? snapshot : null
			const runtime = snap && snap.autopilot && typeof snap.autopilot === 'object' ? snap.autopilot : null
			const board = snap && snap.board && typeof snap.board === 'object' ? snap.board : null
			const envelope = board && board.autopilot && typeof board.autopilot === 'object' ? board.autopilot : null
			const rawConfig = runtime && runtime.config && typeof runtime.config === 'object' ? runtime.config : envelope
			const config = normalizeAutopilotConfig(rawConfig)
			const pauseCause = autopilotPauseCause(snap)
			const roster = snap && Array.isArray(snap.roster) ? snap.roster.filter((member) => member && typeof member === 'object') : []
			const previousPulse = board && Array.isArray(board.pulses) && board.pulses[0]
			// KB-77 observability fields, additive and optional for older hosts:
			// the persisted pulse ring, the host clock the poll was served at (the
			// countdown projects forward from it), live lane occupancy derived from
			// ticket execution rows, and the persisted fairness timestamp per member.
			const pulses = board && Array.isArray(board.pulses) ? board.pulses.filter((pulse) => pulse && typeof pulse === 'object') : []
			const boardMembers = board && board.team && Array.isArray(board.team.members) ? board.team.members : []
			const memberActivatedAt = {}
			boardMembers.forEach((member) => {
				if (member && typeof member.id === 'string' && Number.isFinite(member.lastActivatedAt)) {
					memberActivatedAt[member.id] = member.lastActivatedAt
				}
			})
			return {
				available: Boolean(config),
				config,
				pauseCause,
				paused: pauseCause !== null,
				membersPaused: roster.some((member) => member.paused === true),
				budget: autopilotBudgetView(runtime, envelope),
				nextTickAt: runtime && Number.isFinite(runtime.nextTickAt) ? runtime.nextTickAt : null,
				lastPulse:
					runtime && runtime.lastPulse && typeof runtime.lastPulse === 'object'
						? runtime.lastPulse
						: previousPulse || null,
				hostNow: snap && Number.isFinite(snap.now) ? snap.now : null,
				pulses,
				laneOccupancy: autopilotLaneOccupancy(board && board.tickets),
				memberActivatedAt,
			}
		}

		function initialAutopilotUi(workspaceId) {
			return {
				workspaceId: typeof workspaceId === 'string' && workspaceId ? workspaceId : null,
				available: false,
				config: null,
				values: null,
				confirmed: null,
				pauseCause: null,
				paused: false,
				membersPaused: false,
				budget: null,
				nextTickAt: null,
				lastPulse: null,
				phase: 'idle',
				busy: null,
				dirty: false,
				seq: 0,
				error: null,
				preview: null,
				previewAt: 0,
				pulse: null,
				phase1: false,
			}
		}

		function normalizeAutopilotError(error) {
			const value = error && typeof error === 'object' ? error : {}
			return {
				code: typeof value.code === 'string' && value.code ? value.code : 'unknown',
				message: typeof value.message === 'string' ? value.message : '',
			}
		}

		/** Human explanation for a host autopilot error code; raw host message as fallback. */
		function autopilotErrorText(error, t) {
			if (!error) return ''
			if (error.code === 'autopilot/pulsing') return t('autopilot.errorPulsing')
			if (error.code === 'autopilot/budget') return t('autopilot.errorBudget')
			if (error.code === 'autopilot/invalid') return t('autopilot.errorInvalid')
			return error.message || ''
		}

		/** Deep-merge a configure patch onto a config value (laneCaps/budget are nested). */
		function applyAutopilotPatch(base, patch) {
			const current = base && typeof base === 'object' ? base : null
			if (!patch || typeof patch !== 'object') return current
			const next = { ...(current || {}) }
			for (const key of Object.keys(patch)) {
				const value = patch[key]
				if (key === 'laneCaps' && value && typeof value === 'object') {
					next.laneCaps = { ...((current && current.laneCaps) || {}), ...value }
				} else if (key === 'budget' && value && typeof value === 'object') {
					next.budget = { ...((current && current.budget) || {}), ...value }
				} else {
					next[key] = value
				}
			}
			return next
		}

		/** Merge two pending patches so one debounced request carries every change. */
		function mergeAutopilotPatch(left, right) {
			const base = left && typeof left === 'object' ? left : {}
			if (!right || typeof right !== 'object') return { ...base }
			const next = { ...base, ...right }
			for (const key of ['laneCaps', 'budget']) {
				const a = base[key] && typeof base[key] === 'object' ? base[key] : null
				const b = right[key] && typeof right[key] === 'object' ? right[key] : null
				if (a || b) next[key] = { ...(a || {}), ...(b || {}) }
			}
			return next
		}

		/**
		 * Debounced configure queue: rapid control changes are merged into one
		 * `{op:'configure'}` call after `delayMs`. Deterministic and injectable so a
		 * test can drive it with fake timers.
		 */
		function createAutopilotCommitQueue(timers, delayMs, send) {
			const clock = timers && typeof timers === 'object' ? timers : { setTimeout: () => null, clearTimeout: () => {} }
			const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : AUTOPILOT_COMMIT_MS
			const sender = typeof send === 'function' ? send : () => {}
			let timer = null
			let patch = null
			const flush = () => {
				timer = null
				const current = patch
				patch = null
				if (current && Object.keys(current).length > 0) sender(current)
			}
			return {
				push(nextPatch) {
					if (!nextPatch || typeof nextPatch !== 'object') return null
					patch = mergeAutopilotPatch(patch, nextPatch)
					if (timer !== null) clock.clearTimeout(timer)
					timer = clock.setTimeout(flush, delay)
					return { ...patch }
				},
				pending() {
					return patch ? { ...patch } : null
				},
				hasTimer() {
					return timer !== null
				},
				cancel() {
					if (timer !== null) clock.clearTimeout(timer)
					timer = null
					patch = null
				},
				flushNow() {
					if (timer !== null) clock.clearTimeout(timer)
					flush()
				},
			}
		}

		/** Config from a `status`/`configure` response value (`{config,...}` or a bare config). */
		function autopilotConfigFromStatus(value) {
			if (!value || typeof value !== 'object') return null
			const raw = value.config && typeof value.config === 'object' ? value.config : value
			return normalizeAutopilotConfig(raw)
		}

		/** Header/toggle status derived from the view plus optimistic values. */
		function autopilotStateLabel(state) {
			if (!state || state.available !== true) return 'unavailable'
			if (!state.values || state.values.enabled !== true) return 'off'
			if (state.paused) return 'paused'
			return 'on'
		}

		/** Pulse-now guards: on, not paused, and no request of any kind in flight. */
		function canPulseAutopilot(state) {
			return Boolean(
				state &&
					state.available === true &&
					state.values &&
					state.values.enabled === true &&
					state.paused !== true &&
					state.busy === null,
			)
		}

		/**
		 * Preview guard. A disabled autopilot hides preview with Pulse now behind
		 * the toggle (KB-76 AC 5) instead of offering a control whose plan can only
		 * say "Autopilot is disabled".
		 */
		function canPreviewAutopilot(state) {
			return Boolean(
				state && state.available === true && state.values && state.values.enabled === true && state.busy === null,
			)
		}

		/**
		 * One reducer for the whole control surface. It is the only place a request
		 * can be started (so a double click cannot double-fire a pulse) and it owns
		 * the optimistic value + rollback contract for `configure`.
		 */
		function reduceAutopilot(state, action) {
			const current = state && typeof state === 'object' ? state : initialAutopilotUi(null)
			const type = action && typeof action.type === 'string' ? action.type : ''
			switch (type) {
				case 'reset':
					return initialAutopilotUi(action.workspaceId)
				case 'sync': {
					const config = action.config && typeof action.config === 'object' ? action.config : null
					const next = {
						...current,
						available: action.available === true || Boolean(config),
						config,
						confirmed: config || current.confirmed,
						pauseCause: typeof action.pauseCause === 'string' && action.pauseCause ? action.pauseCause : null,
						paused: Boolean(action.pauseCause),
						membersPaused: action.membersPaused === true,
						budget: action.budget && typeof action.budget === 'object' ? action.budget : null,
						nextTickAt: Number.isFinite(action.nextTickAt) ? action.nextTickAt : null,
						lastPulse: action.lastPulse && typeof action.lastPulse === 'object' ? action.lastPulse : null,
					}
					// An unacknowledged optimistic edit keeps its value; only the rollback
					// target is refreshed, so a poll can never resurrect a stale config.
					return current.dirty ? { ...next, values: current.values } : { ...next, values: config }
				}
				case 'configure/optimistic': {
					const patch = action.patch && typeof action.patch === 'object' ? action.patch : null
					if (!patch) return current
					return {
						...current,
						dirty: true,
						error: null,
						values: applyAutopilotPatch(current.values, patch),
						// A plan built for the previous settings is no longer proof.
						preview: action.keepPreview === true ? current.preview : null,
					}
				}
				case 'configure/send':
					return {
						...current,
						seq: Number.isInteger(action.seq) ? action.seq : current.seq + 1,
						busy: 'configure',
						phase: 'saving',
						error: null,
						dirty: true,
					}
				case 'configure/ok': {
					if (Number.isInteger(action.seq) && action.seq < current.seq) return current
					const config = action.config && typeof action.config === 'object' ? action.config : current.values
					return { ...current, busy: null, phase: 'idle', dirty: false, error: null, config, confirmed: config, values: config }
				}
				case 'configure/fail': {
					if (Number.isInteger(action.seq) && action.seq < current.seq) return current
					return {
						...current,
						busy: null,
						phase: 'idle',
						dirty: false,
						error: normalizeAutopilotError(action.error),
						values: current.confirmed || current.values,
						preview: null,
					}
				}
				case 'preview/start':
					return { ...current, busy: 'preview', error: null }
				case 'preview/ok':
					return {
						...current,
						busy: null,
						preview: action.plan && typeof action.plan === 'object' ? action.plan : null,
						previewAt: safeNumber(action.at, 0),
					}
				case 'preview/fail':
					return { ...current, busy: null, error: normalizeAutopilotError(action.error) }
				case 'preview/clear':
					return { ...current, preview: null, previewAt: 0 }
				case 'pulse/start':
					// The busy guard lives in the reducer: a second dispatch is a no-op.
					if (!canPulseAutopilot(current)) return current
					return { ...current, busy: 'pulse', error: null, pulse: null, preview: null }
				case 'pulse/ok':
					return { ...current, busy: null, pulse: action.pulse && typeof action.pulse === 'object' ? action.pulse : null }
				case 'pulse/fail':
					return { ...current, busy: null, error: normalizeAutopilotError(action.error) }
				case 'error/dismiss':
					return { ...current, error: null }
				case 'phase1/show':
					return { ...current, phase1: true }
				case 'phase1/dismiss':
					return { ...current, phase1: false }
				default:
					return current
			}
		}

		/** Localized reason label; unknown/newer codes stay visible instead of blank. */
		function autopilotReasonLabel(code, t) {
			const value = typeof code === 'string' && code ? code : 'unknown'
			if (AUTOPILOT_REASON_CODES.indexOf(value) === -1) return t('autopilot.reasonUnknown', { code: value })
			return t('autopilot.reason.' + value)
		}

		/** `[{code,count,label,text}]`, highest count first; used by the empty-plan line. */
		function autopilotReasonSummary(plan, t) {
			const counts = new Map()
			safeArray(plan && plan.skips).forEach((entry) => {
				const code = entry && typeof entry.reason === 'string' && entry.reason ? entry.reason : 'unknown'
				if (code === 'admitted') return
				counts.set(code, (counts.get(code) || 0) + 1)
			})
			return Array.from(counts.entries())
				.sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
				.map(([code, count]) => {
					const label = autopilotReasonLabel(code, t)
					return { code, count, label, text: t('autopilot.reasonCount', { label, count: String(count) }) }
				})
		}

		/**
		 * Render model for a dry-run plan: activations first in plan order, then the
		 * skip rows, each joined to the live ticket title and roster member. Purely a
		 * projection — it never mutates the plan and never starts anything.
		 */
		function buildAutopilotPreview(plan, tickets, roster, t, roleName) {
			const ticketsById = new Map()
			safeArray(tickets).forEach((ticket) => {
				if (ticket && typeof ticket.id === 'string') ticketsById.set(ticket.id, ticket)
			})
			const membersById = new Map()
			safeArray(roster).forEach((member) => {
				if (member && typeof member.id === 'string') membersById.set(member.id, member)
			})
			const source = plan && typeof plan === 'object' ? plan : null
			const decisions = safeArray(source && source.decisions)
				.filter((entry) => entry && typeof entry === 'object')
				.slice()
				.sort((left, right) => safeNumber(left.order, 0) - safeNumber(right.order, 0))
			const skips = safeArray(source && source.skips).filter((entry) => entry && typeof entry === 'object')
			const rows = []
			const pushRow = (kind, entry, index) => {
				const ticketId = safeString(entry.ticketId) || null
				const ticket = ticketId ? ticketsById.get(ticketId) : null
				const member = entry.memberId ? membersById.get(entry.memberId) : null
				// Dispatch rows carry the resolved role; skip rows may only carry the
				// member, so fall back to that member's roster role (AC 3: id + title,
				// member name + role, lane, reason).
				const role =
					safeString(entry.role) ||
					(member ? safeString(member.roleId) || safeString(member.roleName) : '')
				const lane = AUTOPILOT_LANES.indexOf(entry.lane) === -1 ? null : entry.lane
				rows.push({
					key: kind + ':' + String(ticketId || 'board') + ':' + String(index),
					kind,
					ordinal: index + 1,
					ticketId,
					title: ticket ? safeString(ticket.title) : '',
					memberName: safeString(entry.memberName) || (member ? safeString(member.name) : ''),
					memberRole: role ? (typeof roleName === 'function' ? roleName(role) : '') : '',
					lane,
					laneLabel: lane ? t('autopilot.lane.' + lane) : '',
					reasonCode: safeString(entry.reason) || 'unknown',
					reason: autopilotReasonLabel(entry.reason, t),
					detail: safeString(entry.detail),
				})
			}
			decisions.forEach((entry, index) => pushRow('dispatch', entry, index))
			skips.forEach((entry, index) => pushRow('skip', entry, decisions.length + index))
			const summary = autopilotReasonSummary(source, t)
			return {
				rows,
				dispatchCount: decisions.length,
				skipCount: skips.length,
				empty: decisions.length === 0,
				summary,
				summaryText: summary.map((item) => item.text).join(' · '),
				generatedAt: safeNumber(source && source.generatedAt, 0),
			}
		}

		/** Budget read-out strings (numbers interpolated through the locale helper). */
		function autopilotBudgetRows(budget, t) {
			if (!budget || !budget.hour || !budget.day) return []
			return [
				t('autopilot.budgetHour', {
					remaining: String(safeNumber(budget.hour.remaining, 0)),
					limit: String(safeNumber(budget.hour.limit, 0)),
				}),
				t('autopilot.budgetDay', {
					remaining: String(safeNumber(budget.day.remaining, 0)),
					limit: String(safeNumber(budget.day.limit, 0)),
				}),
			]
		}

		// ------------------------------------------------------------------
		// Autopilot observability (KB-77) — pulse feed, lane admission, member
		// autopilot state, next-tick countdown and deduplicated alerts
		// ------------------------------------------------------------------
		//
		// Everything below is a pure projection or reducer over the shipped
		// snapshot fields: `board.pulses` (newest-first normalized ring),
		// `board.team.members[].lastActivatedAt`, ticket execution rows,
		// `snapshot.now` and `snapshot.autopilot` (`config`, `nextTickAt`,
		// `lastPulse`, `budgetRemaining`). The client never recomputes admission
		// policy: lane occupancy mirrors the host's origin-anchored rule and the
		// pulse records explain themselves. No DOM or wall clock is touched here,
		// so the whole surface is testable with fake timers.

		const AUTOPILOT_FEED_MAX = 20 // AC 1: the feed lists the newest ≤20 pulses
		const AUTOPILOT_PULSE_KEEP = 50 // AC 5: keep the host ring so alerts persist
		// AC 1 names exactly these three triggers; the host normalizes anything else
		// (a legacy `restart` row included) to `manual`.
		const AUTOPILOT_TRIGGERS = ['timer', 'manual', 'resume']
		// Reasons that surface as an operator alert (AC 5): postcondition failure,
		// loop guard and an exhausted dispatch budget. A pulse-level `error` is the
		// "failed dispatch" family and is alerted under the same pulse id.
		const AUTOPILOT_ALERT_REASONS = ['postcondition-failed', 'loop-guard', 'budget-exhausted']
		const AUTOPILOT_LANE_BY_COLUMN = { backlog: 'refine', ready: 'implement', in_progress: 'implement', review: 'review' }
		// The planner's live-execution set (KB-69 §13): a ticket occupies a lane
		// while its execution row is one of these.
		const AUTOPILOT_LIVE_EXECUTION = ['running', 'idle', 'blocked', 'paused']
		const AUTOPILOT_ALERT_ERROR = 'pulse-error'

		function autopilotTriggerLabel(trigger, t) {
			const value = AUTOPILOT_TRIGGERS.indexOf(safeString(trigger)) === -1 ? 'manual' : trigger
			return t('autopilot.trigger.' + value)
		}

		/** Local `HH:mm:ss` for a pulse; locale/time zone injectable for tests. */
		function formatAutopilotPulseTime(at, options) {
			const stamp = safeNumber(at, 0)
			if (!stamp) return ''
			const opts = options && typeof options === 'object' ? options : {}
			try {
				return new Intl.DateTimeFormat(opts.locale || undefined, {
					hour: '2-digit',
					minute: '2-digit',
					second: '2-digit',
					...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
				}).format(new Date(stamp))
			} catch (error) {
				return ''
			}
		}

		/** Full local timestamp for the row title (tooltip / accessible context). */
		function formatAutopilotPulseStamp(at, options) {
			const stamp = safeNumber(at, 0)
			if (!stamp) return ''
			const opts = options && typeof options === 'object' ? options : {}
			try {
				return new Intl.DateTimeFormat(opts.locale || undefined, {
					dateStyle: 'medium',
					timeStyle: 'medium',
					...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
				}).format(new Date(stamp))
			} catch (error) {
				return ''
			}
		}

		/** Localized duration: `…s`/`… ms`, with an explicit unknown marker. */
		function formatAutopilotDuration(durationMs, t) {
			const value = safeNumber(durationMs, -1)
			if (value < 0) return t('autopilot.feedDurationUnknown')
			if (value < 1000) return t('autopilot.durationMs', { value: String(Math.round(value)) })
			return t('autopilot.durationSeconds', { value: (Math.round(value / 100) / 10).toFixed(1) })
		}

		function autopilotPulseDecisions(pulse) {
			return safeArray(pulse && pulse.decisions).filter((entry) => entry && typeof entry === 'object')
		}

		function autopilotPulseDispatches(pulse) {
			return safeArray(pulse && pulse.dispatched).filter((entry) => entry && typeof entry === 'object')
		}

		/** Error family recorded by a pulse: pulse-level error, failing decisions, outcomes. */
		function autopilotPulseAlertReasons(pulse) {
			const codes = []
			if (pulse && typeof pulse.error === 'string' && pulse.error) codes.push(AUTOPILOT_ALERT_ERROR)
			autopilotPulseDecisions(pulse).forEach((entry) => {
				const code = safeString(entry.reason)
				if (AUTOPILOT_ALERT_REASONS.indexOf(code) !== -1 && codes.indexOf(code) === -1) codes.push(code)
			})
			safeArray(pulse && pulse.outcomes).forEach((entry) => {
				if (entry && entry.outcome === 'postcondition-failed' && codes.indexOf('postcondition-failed') === -1) {
					codes.push('postcondition-failed')
				}
			})
			return codes
		}

		/** Lane group a ticket column belongs to, or null for done/blocked. */
		function autopilotLaneOfTicket(ticket) {
			const column = safeString(ticket && ticket.column)
			return AUTOPILOT_LANE_BY_COLUMN[column] || null
		}

		/**
		 * Lane group a live session occupies. Mirrors the shipped host rule
		 * (KB-71): an autopilot execution stays in the lane it was dispatched FROM
		 * (`startColumn`) even after the ticket moved on, so a refine PM that
		 * claimed Ready still holds the refine lane.
		 */
		function autopilotExecutionLane(ticket) {
			const execution = executionOf(ticket)
			const status = safeString(execution && execution.status)
			if (!execution || AUTOPILOT_LIVE_EXECUTION.indexOf(status) === -1) return null
			const startColumn = safeString(execution.startColumn)
			if (execution.origin === 'autopilot' && AUTOPILOT_LANE_BY_COLUMN[startColumn]) return AUTOPILOT_LANE_BY_COLUMN[startColumn]
			return autopilotLaneOfTicket(ticket)
		}

		/** Live-session occupancy per lane group, derived from ticket execution rows. */
		function autopilotLaneOccupancy(tickets) {
			const occupancy = { refine: 0, implement: 0, review: 0 }
			safeArray(tickets).forEach((ticket) => {
				const lane = autopilotExecutionLane(ticket)
				if (lane) occupancy[lane] += 1
			})
			return occupancy
		}

		/**
		 * One lane header admission chip (AC 2). The state is `paused` when
		 * admission is suspended (board paused, autopilot off, or cap 0), `busy`
		 * when occupancy reaches the configured cap, `idle` otherwise. The
		 * capacity label always uses the configured cap, never the occupancy, so
		 * caps >1 read correctly.
		 */
		function autopilotLaneAdmission(lane, options, t) {
			const opts = options && typeof options === 'object' ? options : {}
			const config = opts.config && typeof opts.config === 'object' ? opts.config : null
			const caps = config && config.laneCaps && typeof config.laneCaps === 'object' ? config.laneCaps : {}
			const cap = Math.max(0, Math.round(safeNumber(caps[lane], 0)))
			const occupancyMap = opts.occupancy && typeof opts.occupancy === 'object' ? opts.occupancy : {}
			const occupancy = Math.max(0, Math.round(safeNumber(occupancyMap[lane], 0)))
			const enabled = opts.available === true && Boolean(config) && config.enabled === true
			const suspended = opts.paused === true || !enabled || cap <= 0
			const state = suspended ? 'paused' : occupancy >= cap ? 'busy' : 'idle'
			const laneLabel = t('autopilot.lane.' + lane)
			const stateLabel = t('autopilot.laneAdmission.' + state)
			const capacityText = t('autopilot.laneAdmission.capacity', { occupancy: String(occupancy), cap: String(cap) })
			return {
				lane,
				state,
				stateLabel,
				capacityText,
				occupancy,
				cap,
				ariaLabel: t('autopilot.laneAdmission.aria', {
					lane: laneLabel,
					state: stateLabel,
					occupancy: String(occupancy),
					cap: String(cap),
				}),
			}
		}

		/** Admission view for every lane group; the Board passes one chip per column. */
		function autopilotLaneAdmissions(options, t) {
			const opts = options && typeof options === 'object' ? options : {}
			const out = {}
			AUTOPILOT_LANES.forEach((lane) => {
				out[lane] = autopilotLaneAdmission(lane, opts, t)
			})
			return out
		}

		/**
		 * Autopilot state for one roster member (AC 3): `active` on a held ticket,
		 * `active` for a running session without a ticket, `idle` for a linked
		 * session at rest, `paused` when the user paused the member (never conflated
		 * with no work), and `no-work` when the member holds nothing claimable.
		 * `lastActivatedAt` is the persisted fairness key (KB-69 §13); the roster
		 * read model's `lastActivityAt` is the fallback for older boards.
		 */
		function memberAutopilotState(member, view, t) {
			const row = member && typeof member === 'object' ? member : {}
			const ticket = row.currentTicket && typeof row.currentTicket === 'object' ? row.currentTicket : null
			const ticketId = safeString(ticket && ticket.id)
			const ticketColumn = safeString(ticket && ticket.column)
			const status = safeString(row.status)
			const activatedMap = view && view.memberActivatedAt && typeof view.memberActivatedAt === 'object' ? view.memberActivatedAt : {}
			// The persisted fairness key is the activation time; older boards (and
			// members without a stamp) fall back to the roster's last activity.
			const lastActivatedAt = safeNumber(activatedMap[row.id], 0) || safeNumber(row.lastActivityAt, 0)
			const paused = row.paused === true
			let kind
			let label
			if (paused) {
				kind = 'paused'
				label = t('autopilot.member.paused')
			} else if (status === 'running') {
				// Only a genuinely executing agent is "active"; a member at rest is
				// never labelled with the old ticket-ownership meaning of active.
				kind = 'active'
				label = ticketId ? t('autopilot.member.active', { id: ticketId }) : t('autopilot.member.activeSession')
			} else if (ticketId) {
				// At rest with a next piece of work: In Progress means the member can
				// resume their own ticket; a Review focus means their review queue.
				kind = 'idle'
				label = ticketColumn === 'in_progress'
					? t('autopilot.member.resume', { id: ticketId })
					: t('autopilot.member.next', { id: ticketId })
			} else if (status === 'idle') {
				kind = 'idle'
				label = t('autopilot.member.idle')
			} else {
				kind = 'no-work'
				label = t('autopilot.member.noWork')
			}
			const lastActiveText = lastActivatedAt
				? t('autopilot.member.lastActive', { ago: formatAge(lastActivatedAt, t) })
				: t('autopilot.member.neverActive')
			return {
				kind,
				label,
				chipText: t('autopilot.member.chip', { state: label }),
				ticketId: ticketId || null,
				lastActivatedAt: lastActivatedAt || null,
				lastActiveText,
				ariaLabel: t('autopilot.member.aria', { state: label, time: lastActiveText }),
			}
		}

		/** Newest-first pulse order; ties break on id so a re-poll is byte-stable. */
		function autopilotPulseKeyCompare(left, right) {
			const at = safeNumber(right && right.at, 0) - safeNumber(left && left.at, 0)
			if (at !== 0) return at
			const leftId = safeString(left && left.id)
			const rightId = safeString(right && right.id)
			return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
		}

		/**
		 * Merge a poll's pulse ring into local state by id (AC 9): a duplicate poll
		 * can never duplicate a row, and the newest version of a pulse wins.
		 */
		function mergeAutopilotPulses(existing, incoming) {
			const byId = new Map()
			safeArray(existing).forEach((pulse) => {
				if (pulse && typeof pulse.id === 'string' && pulse.id) byId.set(pulse.id, pulse)
			})
			safeArray(incoming).forEach((pulse) => {
				if (pulse && typeof pulse.id === 'string' && pulse.id) byId.set(pulse.id, pulse)
			})
			return Array.from(byId.values()).sort(autopilotPulseKeyCompare).slice(0, AUTOPILOT_PULSE_KEEP)
		}

		function initialAutopilotPulseState() {
			return { hostNow: null, pulses: [], acked: [] }
		}

		/**
		 * Pure pulse state: merge polls by pulse id, ignore an out-of-order poll
		 * (older host clock), and remember acknowledged alerts per pulse id so a
		 * poll can neither clear an unread alert nor resurrect a dismissed one.
		 */
		function reduceAutopilotPulseState(state, action) {
			const current = state && typeof state === 'object' ? state : initialAutopilotPulseState()
			const type = action && typeof action.type === 'string' ? action.type : ''
			if (type === 'reset') return initialAutopilotPulseState()
			if (type === 'ack') {
				const pulseId = safeString(action.pulseId)
				if (!pulseId || current.acked.indexOf(pulseId) !== -1) return current
				return { ...current, acked: current.acked.concat([pulseId]).slice(-AUTOPILOT_PULSE_KEEP) }
			}
			if (type === 'sync') {
				const hostNow = Number.isFinite(action.hostNow) ? action.hostNow : null
				if (hostNow === null) return current
				if (current.hostNow !== null && hostNow < current.hostNow) return current
				const pulses = mergeAutopilotPulses(current.pulses, action.pulses)
				const sameLength = pulses.length === current.pulses.length
				const unchanged = sameLength && pulses.every((pulse, index) => pulse === current.pulses[index])
				if (unchanged && hostNow === current.hostNow) return current
				return { ...current, hostNow, pulses }
			}
			return current
		}

		/**
		 * Deduplicated alert rows (AC 5): one row per pulse id that carries a
		 * pulse-level error or one of the error-family reasons. Acknowledgement is
		 * per pulse id and survives every poll. The projection is non-destructive:
		 * it only hides acknowledged rows, it never rewrites the pulse.
		 */
		function buildAutopilotAlerts(pulses, acked, tickets, t, options) {
			const acknowledged = {}
			safeArray(acked).forEach((id) => {
				const key = safeString(id)
				if (key) acknowledged[key] = true
			})
			const ticketsById = new Map()
			safeArray(tickets).forEach((ticket) => {
				if (ticket && typeof ticket.id === 'string') ticketsById.set(ticket.id, ticket)
			})
			const alerts = []
			safeArray(pulses).forEach((pulse) => {
				const pulseId = safeString(pulse && pulse.id)
				if (!pulseId || acknowledged[pulseId]) return
				const codes = autopilotPulseAlertReasons(pulse)
				if (codes.length === 0) return
				const pulseError = safeString(pulse.error)
				// The authoritative dispatch ledger: an `admitted` plan row missing from it
				// never started a session (same rule as the feed's `notExecuted`).
				const dispatchedIds = new Set()
				autopilotPulseDispatches(pulse).forEach((entry) => {
					const id = safeString(entry && entry.ticketId)
					if (id) dispatchedIds.add(id)
				})
				const ticketIds = []
				const addTicket = (value) => {
					const id = safeString(value)
					if (id && ticketIds.indexOf(id) === -1 && ticketsById.has(id)) ticketIds.push(id)
				}
				autopilotPulseDecisions(pulse).forEach((entry) => {
					const reason = safeString(entry.reason)
					if (AUTOPILOT_ALERT_REASONS.indexOf(reason) !== -1) addTicket(entry.ticketId)
					// Failed dispatch (AC 5): the host keeps the planned `admitted` row but
					// throws before writing the ledger, so that ticket is the one to link.
					if (pulseError && reason === 'admitted' && entry.action === 'dispatch') {
						const id = safeString(entry.ticketId)
						if (id && !dispatchedIds.has(id)) addTicket(id)
					}
				})
				safeArray(pulse.outcomes).forEach((entry) => {
					if (entry && entry.outcome === 'postcondition-failed') addTicket(entry.ticketId)
				})
				alerts.push({
					key: pulseId,
					pulseId,
					at: safeNumber(pulse.at, 0),
					time: formatAutopilotPulseTime(pulse.at, options),
					reasons: (pulseError ? [t('autopilot.reason.dispatch-failed')] : []).concat(
						codes.filter((code) => code !== AUTOPILOT_ALERT_ERROR).map((code) => autopilotReasonLabel(code, t)),
					),
					message: pulseError ? t('autopilot.alert.pulseError', { message: pulseError }) : '',
					ticketIds,
				})
			})
			return alerts.sort(autopilotPulseKeyCompare).slice(0, AUTOPILOT_FEED_MAX)
		}

		/**
		 * Render model for the pulse feed (AC 1): newest ≤20 pulses newest-first
		 * with trigger, local time, duration, dispatched count, skipped count and an
		 * error marker; each row carries the full decision list plus the authoritative
		 * `dispatched` ledger. A plan `admitted` row that is missing from `dispatched`
		 * is marked as skipped at dispatch instead of pretending a session started.
		 */
		function buildAutopilotFeed(pulses, tickets, roster, t, roleName, options) {
			const ticketsById = new Map()
			safeArray(tickets).forEach((ticket) => {
				if (ticket && typeof ticket.id === 'string') ticketsById.set(ticket.id, ticket)
			})
			const membersById = new Map()
			safeArray(roster).forEach((member) => {
				if (member && typeof member.id === 'string') membersById.set(member.id, member)
			})
			const roleLabel = (roleId) => {
				if (!roleId) return ''
				return typeof roleName === 'function' ? roleName(roleId) : safeString(roleId)
			}
			const rows = safeArray(pulses)
				.filter((pulse) => pulse && typeof pulse === 'object')
				.slice()
				.sort(autopilotPulseKeyCompare)
				.slice(0, AUTOPILOT_FEED_MAX)
				.map((pulse) => {
					const pulseId = safeString(pulse.id) || 'pulse-' + String(safeNumber(pulse.at, 0))
					const decisions = autopilotPulseDecisions(pulse)
					const dispatches = autopilotPulseDispatches(pulse)
					const executedIds = new Set()
					const executed = dispatches.map((entry, index) => {
						const ticketId = safeString(entry.ticketId)
						if (ticketId) executedIds.add(ticketId)
						const ticket = ticketId ? ticketsById.get(ticketId) : null
						const member = safeString(entry.memberId) ? membersById.get(safeString(entry.memberId)) : null
						return {
							key: 'executed:' + pulseId + ':' + String(index),
							ticketId: ticketId || null,
							ticketTitle: ticket ? safeString(ticket.title) : '',
							memberName: member ? safeString(member.name) : safeString(entry.memberId),
							sessionId: safeString(entry.sessionId),
						}
					})
					const decisionRows = decisions.map((entry, index) => {
						const action = entry.action === 'dispatch' ? 'dispatch' : 'skip'
						const reasonCode = safeString(entry.reason) || 'unknown'
						const ticketId = safeString(entry.ticketId)
						const ticket = ticketId ? ticketsById.get(ticketId) : null
						const member = safeString(entry.memberId) ? membersById.get(safeString(entry.memberId)) : null
						const lane = AUTOPILOT_LANES.indexOf(entry.lane) === -1 ? null : entry.lane
						const memberName = safeString(entry.memberName) || (member ? safeString(member.name) : '')
						const notExecuted = action === 'dispatch' && reasonCode === 'admitted' && Boolean(ticketId) && !executedIds.has(ticketId)
						return {
							key: 'decision:' + pulseId + ':' + String(index),
							action,
							actionLabel: t('autopilot.action.' + action),
							ticketId: ticketId || null,
							ticketTitle: ticket ? safeString(ticket.title) : '',
							memberName,
							memberRole: roleLabel(safeString(entry.role) || (member ? safeString(member.roleId) : '')),
							lane,
							laneLabel: lane ? t('autopilot.lane.' + lane) : t('autopilot.boardLevel'),
							reasonCode,
							reason: autopilotReasonLabel(reasonCode, t),
							detail: safeString(entry.detail),
							alert: AUTOPILOT_ALERT_REASONS.indexOf(reasonCode) !== -1,
							notExecuted,
							notExecutedText: notExecuted ? t('autopilot.feedDispatchSkipped') : '',
						}
					})
					const errorCodes = autopilotPulseAlertReasons(pulse)
					const trigger = AUTOPILOT_TRIGGERS.indexOf(safeString(pulse.trigger)) === -1 ? 'manual' : pulse.trigger
					return {
						key: pulseId,
						id: pulseId,
						at: safeNumber(pulse.at, 0),
						time: formatAutopilotPulseTime(pulse.at, options),
						stamp: formatAutopilotPulseStamp(pulse.at, options),
						trigger,
						triggerLabel: autopilotTriggerLabel(trigger, t),
						durationText: formatAutopilotDuration(pulse.durationMs, t),
						dispatchedCount: dispatches.length,
						skippedCount: decisions.filter((entry) => entry.action === 'skip').length,
						hasError: errorCodes.length > 0,
						errorLabel: t('autopilot.feedErrorMarker'),
						errorText: errorCodes
							.filter((code) => code !== AUTOPILOT_ALERT_ERROR)
							.map((code) => autopilotReasonLabel(code, t))
							.concat(safeString(pulse.error) ? [safeString(pulse.error)] : [])
							.join(' · '),
						decisions: decisionRows,
						executed,
					}
				})
			return { rows, total: rows.length }
		}

		/**
		 * Which state the feed section renders (AC 6). `loading` wins so the first
		 * poll cannot flash the empty state, and an unavailable host gets its own
		 * explanation instead of an empty feed.
		 */
		function autopilotFeedState(options) {
			const opts = options && typeof options === 'object' ? options : {}
			if (opts.loading === true) return 'loading'
			if (opts.available !== true) return 'unavailable'
			if (safeArray(opts.pulses).length === 0) return 'empty'
			return 'ready'
		}

		// -- Next-tick countdown (AC 4) --------------------------------------

		function initialAutopilotCountdown() {
			return {
				hostNow: null,
				syncedLocalAt: null,
				nextTickAt: null,
				available: false,
				enabled: false,
				paused: false,
				seconds: null,
			}
		}

		/** `running` only when the host actually has an armed tick. */
		function autopilotCountdownMode(state) {
			if (!state || state.available !== true) return 'off'
			if (state.enabled !== true) return 'off'
			if (state.paused === true) return 'paused'
			if (!Number.isFinite(state.nextTickAt)) return 'off'
			return 'running'
		}

		/**
		 * Whole seconds left, projected from the host clock captured at the last
		 * poll (`hostNow + (localNow - syncedLocalAt)`) rather than from a second
		 * local clock. Re-syncing every poll keeps the label within 2 s of the host
		 * value even if the local clock drifts.
		 */
		function autopilotCountdownRemaining(state, localNow) {
			if (!state || !Number.isFinite(state.nextTickAt) || state.hostNow === null || state.syncedLocalAt === null) return null
			const drift = Math.max(0, safeNumber(localNow, state.syncedLocalAt) - state.syncedLocalAt)
			return Math.ceil((state.nextTickAt - (state.hostNow + drift)) / 1000)
		}

		function autopilotCountdownSeconds(state, localNow) {
			const remaining = autopilotCountdownRemaining(state, localNow)
			return remaining === null ? null : Math.max(0, remaining)
		}

		/**
		 * Pure countdown reducer. `tick` returns the same state object when the
		 * displayed second did not change, so the component re-renders at most once
		 * per second; `off`/`paused` are sticky and a `tick` never advances them.
		 */
		function reduceAutopilotCountdown(state, action) {
			const current = state && typeof state === 'object' ? state : initialAutopilotCountdown()
			const type = action && typeof action.type === 'string' ? action.type : ''
			if (type === 'reset') return initialAutopilotCountdown()
			if (type === 'sync') {
				const hostNow = Number.isFinite(action.hostNow) ? action.hostNow : null
				const localNow = Number.isFinite(action.localNow) ? action.localNow : null
				if (hostNow === null || localNow === null) return current
				// A poll that arrives out of order must not move the countdown
				// backwards (AC 9): the older host clock is ignored outright.
				if (current.hostNow !== null && hostNow < current.hostNow) return current
				const nextTickAt = Number.isFinite(action.nextTickAt) ? action.nextTickAt : null
				const next = {
					...current,
					hostNow,
					syncedLocalAt: localNow,
					nextTickAt,
					available: action.available === true,
					enabled: action.enabled === true,
					paused: action.paused === true,
				}
				next.seconds = autopilotCountdownSeconds(next, localNow)
				return next
			}
			if (type === 'tick') {
				if (autopilotCountdownMode(current) !== 'running') return current
				const seconds = autopilotCountdownSeconds(current, action.localNow)
				if (seconds === null || seconds === current.seconds) return current
				return { ...current, seconds }
			}
			return current
		}

		/** `mm:ss`, or the explicit off/paused word (AC 4). */
		function autopilotCountdownLabel(state, t) {
			const mode = autopilotCountdownMode(state)
			if (mode === 'off') return t('autopilot.countdown.off')
			if (mode === 'paused') return t('autopilot.countdown.paused')
			const seconds = Math.max(0, safeNumber(state && state.seconds, 0))
			const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
			const ss = String(seconds % 60).padStart(2, '0')
			return t('autopilot.countdown.value', { mm, ss })
		}

		function autopilotCountdownAria(state, t) {
			return t('autopilot.countdown.aria', { value: autopilotCountdownLabel(state, t) })
		}

		function readStoredWorkspace() {
			try {
				const raw = window.localStorage.getItem(STORAGE_KEY)
				return raw && raw.length > 0 ? raw : null
			} catch (error) {
				return null
			}
		}

		function storeWorkspace(workspaceId) {
			try {
				if (typeof workspaceId === 'string' && workspaceId.length > 0) window.localStorage.setItem(STORAGE_KEY, workspaceId)
				else window.localStorage.removeItem(STORAGE_KEY)
			} catch (error) {
				// storage is best-effort
			}
		}

		/** POST one JSON body and unwrap the `{ ok, value }` envelope. */
		async function postJson(path, body) {
			let response
			try {
				response = await fetch(path, {
					method: 'POST',
					credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
			} catch (cause) {
				const failure = new Error((cause && cause.message) || 'network request failed')
				failure.code = 'network'
				throw failure
			}
			let payload = null
			try {
				payload = await response.json()
			} catch (error) {
				payload = null
			}
			if (response.ok && payload && payload.ok === true) return payload
			const detail = payload && payload.ok === false && payload.error ? payload.error : null
			const message = detail && typeof detail.message === 'string' && detail.message ? detail.message : 'HTTP ' + response.status
			const failure = new Error(message)
			failure.code = detail && typeof detail.code === 'string' ? detail.code : 'http/' + response.status
			failure.status = response.status
			throw failure
		}

		// ------------------------------------------------------------------
		// Locale dictionaries
		// ------------------------------------------------------------------

		const en = {
			'panel.title': 'Kanban',

			'header.project': 'Project',
			'header.search': 'Search tickets',
			'header.searchPlaceholder': 'Search title, ID, label, owner',
			'header.clearSearch': 'Clear search',
			'header.closeSearch': 'Close search',
			'header.filters': 'Filters',
			'header.scan': 'Scan',
			'header.newTicket': 'New ticket',
			'header.team': 'Team',
			'header.pause': 'Pause board',
			'header.resume': 'Resume board',
			'header.refresh': 'Refresh',
			'header.close': 'Close',
			'header.speakThought': 'Speak a thought',
			'header.thoughts': 'Thoughts',

			// KB-76 autopilot controls: header entry, settings popover, dry-run
			// preview, pulse now, paused/off/unavailable states and inline errors.
			'autopilot.entry': 'Autopilot',
			'autopilot.entryState': 'Autopilot — {state}',
			'autopilot.title': 'Autopilot controls',
			'autopilot.state.on': 'On',
			'autopilot.state.off': 'Off',
			'autopilot.state.paused': 'Paused',
			'autopilot.state.unavailable': 'Unavailable',
			'autopilot.toggleLabel': 'Autopilot',
			'autopilot.pauseBoard': 'Paused — the board is paused.',
			'autopilot.pauseMember': 'Paused — every team member is paused.',
			'autopilot.membersPaused': 'Some members are paused; their tickets are skipped.',
			'autopilot.offNote': 'Autopilot is off — running sessions continue and nothing is cancelled.',
			'autopilot.unavailableTitle': 'Autopilot unavailable',
			'autopilot.unavailableBody': 'This host build does not expose the autopilot service yet, so the board keeps working manually.',
			'autopilot.phase1Title': 'Phase 1 runs one implementer at a time',
			'autopilot.phase1Body':
				'Autopilot starts at most one implementer session at a time, and one session per refine and review lane. Two agents would otherwise edit the same board and worktree in parallel and overwrite each other. Raise a lane cap only when you accept that risk.',
			'autopilot.phase1Dismiss': 'Got it',
			'autopilot.settings': 'Settings',
			'autopilot.cadence': 'Cadence',
			'autopilot.minutes': '{n} min',
			'autopilot.maxReadyDepth': 'Max Ready depth',
			'autopilot.laneCaps': 'Lane caps',
			'autopilot.lane.refine': 'Refine',
			'autopilot.lane.implement': 'Implement',
			'autopilot.lane.review': 'Review',
			'autopilot.budget': 'Dispatch budget',
			'autopilot.budgetHour': 'Hour: {remaining} of {limit} left',
			'autopilot.budgetDay': 'Day: {remaining} of {limit} left',
			'autopilot.budgetUnavailable': 'Dispatch budget unavailable',
			'autopilot.preview': 'Preview next pulse',
			'autopilot.previewBusy': 'Previewing…',
			'autopilot.previewTitle': 'Next pulse plan',
			'autopilot.previewSummary': '{dispatches} dispatch · {skips} skip',
			'autopilot.previewEmptyTitle': 'Nothing to do right now',
			'autopilot.previewEmptyBody': 'The planner will not start anything. Summary: {summary}',
			'autopilot.reasonCount': '{label} ×{count}',
			'autopilot.reasonUnknown': 'Unknown reason ({code})',
			'autopilot.boardLevel': 'Board',
			'autopilot.noMember': 'No member',
			'autopilot.pulseNow': 'Pulse now',
			'autopilot.pulseBusy': 'Running pulse…',
			'autopilot.pulseDisabled': 'Pulse now is disabled while autopilot is paused.',
			'autopilot.pulseDone': 'Pulse {id} finished.',
			'autopilot.error': 'Autopilot error ({code})',
			'autopilot.errorPulsing': 'A pulse is already running for this project. Try again when it finishes.',
			'autopilot.errorBudget': 'The dispatch budget is exhausted. Try again when the window resets.',
			'autopilot.errorInvalid': 'The host rejected this setting; the previous value was restored.',
			'autopilot.dismissError': 'Dismiss error',
			'autopilot.saving': 'Saving…',
			'autopilot.reason.admitted': 'Admitted — starts a session',
			'autopilot.reason.disabled': 'Autopilot is disabled',
			'autopilot.reason.board-paused': 'The board is paused',
			'autopilot.reason.epic': 'EPICs are never dispatched',
			'autopilot.reason.blocked': 'The ticket is blocked',
			'autopilot.reason.active-execution': 'A session is already running',
			'autopilot.reason.lane-cap': 'The lane is at its concurrency cap',
			'autopilot.reason.wip-limit': 'In Progress is at its WIP limit',
			'autopilot.reason.ready-depth': 'Ready is at its depth ceiling',
			'autopilot.reason.no-member': 'No member has an eligible role',
			'autopilot.reason.member-busy': 'Every eligible member is busy',
			'autopilot.reason.member-paused': 'The member is paused',
			'autopilot.reason.stale-execution': 'The execution is stale',
			'autopilot.reason.postcondition-failed': 'The last dispatch missed its target; backing off',
			'autopilot.reason.budget-exhausted': 'The dispatch budget is exhausted',
			'autopilot.reason.loop-guard': 'Too many failures; parked for a human',
			'autopilot.reason.pulse-cap': 'This pulse already used its dispatch slots',
			'autopilot.reason.no-work': 'No candidate work in this lane',
			// Pulse-level failure family (a dispatch that threw): the planner row is
			// still `admitted`, so the alert names the failure instead of only the raw
			// host message. Never rendered as a bare code (AC 8).
			'autopilot.reason.dispatch-failed': 'Dispatch failed — the session did not start',
			// KB-77 observability: pulse feed, next-tick countdown, lane admission,
			// member autopilot state and deduplicated alerts.
			'autopilot.countdown.label': 'Next pulse',
			'autopilot.countdown.value': '{mm}:{ss}',
			'autopilot.countdown.off': 'off',
			'autopilot.countdown.paused': 'paused',
			'autopilot.countdown.aria': 'Next autopilot pulse: {value}',
			'autopilot.trigger.timer': 'Timer',
			'autopilot.trigger.manual': 'Manual',
			'autopilot.trigger.resume': 'Resume',
			'autopilot.feedTitle': 'Pulse feed',
			'autopilot.feedCount': 'newest {n}',
			'autopilot.feedLoading': 'Loading pulses…',
			'autopilot.feedUnavailable': 'Pulse history is unavailable on this host.',
			'autopilot.feedEmptyTitle': 'No pulses yet — turn Autopilot on',
			'autopilot.feedEmptyBody': 'Every pulse records what it considered and what it started.',
			'autopilot.feedEmptyAction': 'Turn Autopilot on',
			// Same empty feed while autopilot is already on: the toggle is hidden, so
			// the copy must not ask the operator to turn on something that is on.
			'autopilot.feedEmptyTitleOn': 'No pulses yet',
			'autopilot.feedEmptyBodyOn': 'Autopilot is on — the first pulse appears on the next timer tick.',
			'autopilot.feedOpen': 'Pulse {id} — show decisions',
			'autopilot.feedDetails': 'Pulse {id} decisions',
			'autopilot.feedDecisionTitle': 'Decisions',
			'autopilot.feedDispatchedTitle': 'Sessions started',
			'autopilot.feedNoDecisions': 'This pulse recorded no decisions.',
			'autopilot.feedNoDispatched': 'No session was started.',
			'autopilot.feedDispatchSkipped': 'Admitted in the plan, skipped at dispatch — no session started.',
			'autopilot.feedDurationUnknown': '—',
			'autopilot.durationSeconds': '{value}s',
			'autopilot.durationMs': '{value} ms',
			'autopilot.feedErrorMarker': 'error',
			'autopilot.feedDispatched': '{n} dispatched',
			'autopilot.feedSkipped': '{n} skipped',
			'autopilot.action.dispatch': 'Dispatch',
			'autopilot.action.skip': 'Skip',
			'autopilot.alert.group': 'Autopilot alerts',
			'autopilot.alert.title': 'Autopilot alert',
			'autopilot.alert.pulseError': 'Pulse failed: {message}',
			'autopilot.alert.openTicket': 'Open ticket {id}',
			'autopilot.alert.ack': 'Acknowledge',
			'autopilot.entryAlerts': '{n} unread alerts',
			'autopilot.laneAdmission.busy': 'busy',
			'autopilot.laneAdmission.idle': 'idle',
			'autopilot.laneAdmission.paused': 'paused',
			'autopilot.laneAdmission.capacity': '({occupancy}/{cap})',
			'autopilot.laneAdmission.aria': '{lane} lane admission: {state} {occupancy} of {cap} slots',
			'autopilot.member.chip': 'Autopilot: {state}',
			'autopilot.member.active': 'Active on {id}',
			'autopilot.member.activeSession': 'Session running',
			'autopilot.member.next': 'Next {id}',
			'autopilot.member.resume': 'Resume {id}',
			'autopilot.member.idle': 'Session idle',
			'autopilot.member.paused': 'Paused',
			'autopilot.member.noWork': 'No work',
			'autopilot.member.lastActive': 'Last activation {ago}',
			'autopilot.member.neverActive': 'Never activated',
			'autopilot.member.aria': 'Autopilot: {state}; {time}',

			'project.select': 'Select project',
			'project.none': 'No projects yet',
			'project.refresh': 'Refresh projects',
			'project.sessions': '{n} sessions',
			'project.active': '{n} active',
			'project.paused': 'Paused',

			'stats.backlog': 'Backlog',
			'stats.ready': 'Ready',
			'stats.wip': 'WIP',
			'stats.review': 'Review',
			'stats.done': 'Done',

			'paused.banner': 'Board paused — agent work is frozen until you resume.',
			'paused.resume': 'Resume board',
			'paused.by': 'Paused by {name}',
			'execution.title': 'Agent execution',
			'execution.run': 'Run with agent',
			'execution.role': 'Agent role',
			'execution.running': 'Agent running',
			'execution.idle': 'Agent idle',
			'execution.blocked': 'Blocked',
			'execution.paused': 'Agent paused',
			'execution.done': 'Agent done',
			'execution.failed': 'Agent failed',
			'execution.cancelled': 'Run cancelled',
			'execution.openSession': 'Open agent session',
			'execution.continue': 'Continue',
			'execution.cancel': 'Cancel run',
			'execution.confirmCancel': 'Confirm cancel',
			'execution.retry': 'Run again',
			'execution.report': 'Agent report',
			'execution.chooseRole': 'Choose the agent role',
			'execution.laneHint': 'The agent claims this ticket and advances it one lane at a time. If it needs you, it asks here.',
			'execution.waitingTitle': 'Waiting for you',
			'execution.waitingHint': 'Answer the questions or grant the needed permissions, and the agent resumes automatically.',
			'execution.answerPlaceholder': 'Your answer…',
			'execution.grant': 'Grant',
			'execution.sendAnswers': 'Send answers & resume',
			'execution.runStarted': 'Agent session started',
			'execution.runResumed': 'Agent resumed',
			'execution.answered': 'Answers sent',
			'execution.cancelledToast': 'Execution cancelled',
			'execution.questions': '{n} question(s)',
			'execution.accessMode': 'Access',
			'access.readOnly': 'Read only',
			'access.workspaceWrite': 'Workspace write',
			'access.fullAccess': 'Full access',
			'access.auto': 'Auto (current policy)',
			'execution.accessHint': 'Permission mode for this agent session. Suggested from the lane and task nature; change it before starting if needed.',
			'execution.handoff': 'Next up',
			'execution.startRole': 'Start {role}',
			'execution.suggestedAgent': 'Suggested agent: {name}',
			'execution.handoffHint': 'Auto-assigned when the ticket advanced. Start it to open a session with this role and the previous context.',
			'execution.need.permission': 'Permission',
			'execution.need.decision': 'Decision',
			'execution.need.question': 'Question',
			'execution.need.input': 'Input',
			'columns.blocked': 'Blocked',
			'stats.blocked': 'Blocked',
			'stats.executing': 'Agents',
			'card.run': 'Run with agent',
			'card.blockedQuestions': '{n} waiting',
			'card.nextRole': '→ {role}',
			'confirm.cancelExecution': 'Cancel this agent execution? The session stays in your sessions list.',

			'columns.backlog': 'Backlog',
			'columns.ready': 'Ready',
			'columns.in_progress': 'In Progress',
			'columns.review': 'Review',
			'columns.done': 'Done',
			'columns.add': 'Add ticket to {column}',
			'columns.empty': 'Drop tickets here',
			'columns.emptyBlocked': 'Nothing is blocked',
			'columns.emptyFiltered': 'No matching tickets',
			'columns.limit': '{n}/{limit}',

			'card.open': 'Open {id}',
			'card.blocked': 'Blocked',
			'card.blockedReason': 'Blocked: {reason}',
			'card.unassigned': 'Unassigned',
			'card.checklist': 'Checklist {done}/{total}',
			'card.comments': '{n} comments',
			'card.updated': 'Updated {ago}',
			// KB-3 EPIC model: badge, parent chip and the Backlog-only reason.
			'card.parent': 'Parent {id}',
			'card.parentTitle': 'EPIC: {title}',
			'card.children': '{n} children',
			'card.epicLocked': 'Backlog only',
			'card.epicLockedHint': 'An EPIC stays in Backlog and cannot be dragged, moved or run by an agent.',

			'filters.title': 'Filters',
			'filters.role': 'Role',
			'filters.owner': 'Owner',
			'filters.allRoles': 'All roles',
			'filters.allOwners': 'All owners',
			'filters.unassigned': 'Unassigned',
			'filters.clear': 'Clear filters',

			'actions.create': 'Create ticket',
			'actions.cancel': 'Cancel',
			'actions.save': 'Save',
			'actions.saved': 'Saved',
			'actions.delete': 'Delete',
			'actions.confirmDelete': 'Confirm delete',
			'actions.add': 'Add',
			'actions.block': 'Block',
			'actions.unblock': 'Unblock',
			'actions.openSession': 'Open session',
			'actions.pauseAgent': 'Pause agent',
			'actions.resumeAgent': 'Resume agent',
			'actions.selectAll': 'Select all',
			'actions.retry': 'Retry',

			'detail.ticket': 'Ticket {id}',
			'detail.title': 'Title',
			'detail.titlePlaceholder': 'Ticket title',
			'detail.description': 'Description',
			'detail.descriptionPlaceholder': 'Add context, acceptance criteria…',
			// KB-58 read/Edit/Preview toggle for the description and EPIC PRD.
			'detail.descriptionMode': 'Description view',
			'detail.edit': 'Edit',
			'detail.preview': 'Preview',
			'detail.descriptionEmpty': 'No description yet — use Edit to add context, acceptance criteria, and links.',
			'detail.epicPrdEmpty': 'No EPIC PRD yet — use Edit to write the outcome, scope, acceptance criteria, and decomposition plan.',
			'detail.column': 'Column',
			'detail.role': 'Role',
			'detail.roleNone': 'No role',
			'detail.priority': 'Priority',
			'detail.type': 'Type',
			'detail.owner': 'Owner',
			'detail.ownerNone': 'Unassigned',
			'detail.ownerSelect': 'Assign owner',
			'detail.labels': 'Labels',
			'detail.labelsPlaceholder': 'frontend, ux, urgent',
			'detail.labelsHint': 'Separate labels with commas',
			'detail.block': 'Blocking',
			'detail.blockReason': 'Block reason',
			'detail.blockReasonPlaceholder': 'Why is this blocked?',
			'detail.checklist': 'Checklist',
			'detail.checklistPlaceholder': 'Add a checklist item',
			'detail.comments': 'Comments',
			'detail.commentsEmpty': 'No comments yet',
			'detail.commentsPlaceholder': 'Write a comment…',
			'detail.commentSubmit': 'Comment',
			'detail.activity': 'Activity',
			'detail.activityEmpty': 'No activity yet',
			'detail.created': 'Created {ago}',
			'detail.updated': 'Updated {ago}',
			'detail.moved': 'Moved {ago}',
			'detail.accepted': 'Accepted {ago}',
			'detail.deleteHint': 'Deleting removes this ticket and its history.',
			'detail.close': 'Close ticket',
			'detail.moveHint': 'Kanban moves one column at a time.',
			// KB-3 EPIC drawer: PRD area + children list.
			'detail.epicPrd': 'EPIC PRD',
			'detail.epicPrdHint': 'Outcome, scope, acceptance criteria, and the decomposition plan for this EPIC.',
			'detail.children': 'Children',
			'detail.childrenEmpty': 'No child tickets yet.',
			'detail.childrenEmptyHint': 'Create a ticket with this EPIC as its parent to decompose it.',
			'detail.epicLocked': 'EPICs stay in Backlog. Decompose it into child tickets instead of moving or running it.',
			'detail.childStatus': 'Status',
			'detail.source': 'Source',

			'new.title': 'New ticket',
			'new.titleLabel': 'Title',
			'new.titlePlaceholder': 'What needs to happen?',
			'new.descriptionPlaceholder': 'Context, acceptance criteria…',
			'new.type': 'Type',
			'new.priority': 'Priority',
			'new.role': 'Role',
			'new.column': 'Column',
			'new.titleRequired': 'Enter a title to create the ticket',
			'new.create': 'Create ticket',
			'new.creating': 'Creating…',
			'new.epicHint': 'EPICs are created in Backlog and cannot be claimed by agents.',

			// Thought intake (KB-1). Shared labels reuse existing keys
			// (actions.cancel, execution.openSession, header.close).
			'thought.title': 'Speak a thought',
			'thought.field': 'Thought',
			'thought.placeholder': 'Say it how it comes. One thought is enough.',
			'thought.send': 'Send thought',
			'thought.sending': 'Sending…',
			'thought.success': 'Thought recorded — a product manager is on it.',
			// KB-5: capturing while paused queues the thought instead of refusing it.
			'thought.pausedHint': 'Captures are queued while the board is paused',
			'thought.close': 'Close thoughts',
			'thought.empty': 'No thoughts yet. Press Speak a thought to capture one.',
			'thought.count': '{n} thoughts',
			'thought.queuedCount': '{n} queued',
			'thought.expand': 'Expand',
			'thought.collapse': 'Collapse',
			'thought.status.recorded': 'Recorded',
			'thought.status.working': 'Thinking…',
			'thought.status.done': 'Done',
			'thought.status.failed': 'Failed',
			'thought.status.queued': 'Queued',
			'thought.status.cancelled': 'Cancelled',
			'thought.status.unknown': 'Unknown status',
			'thought.timeline': 'History',
			'thought.retry': 'Retry',
			'thought.cancel': 'Cancel run',
			'thought.retryOf': 'Retry of {id}',
			'thought.retryOfPlain': 'Retry of {id} (not in the current window)',
			'thought.retriedToast': 'Thought retried as {id}.',
			'thought.cancelledToast': 'Thought cancelled.',
			'thought.ticketCreated': 'Created {id}',
			'thought.edited': 'Edited',
			'thought.deleted': 'Deleted',
			'thought.delete': 'Delete',
			'thought.edit': 'Edit',
			'thought.save': 'Save',
			'thought.cancelEdit': 'Cancel edit',
			'thought.editedToast': 'Thought updated.',
			'thought.deletedToast': 'Thought deleted.',
			'thought.editPlaceholder': 'Edit the thought text',
			'thought.emptyError': 'Type a thought before saving it.',
			'thought.queuedHint': 'Queued — it runs when the board resumes',
			'thought.ticketChip': 'Thought',
			'thought.deletedFallback': 'Thought deleted',
			'thought.unavailable': 'Thought not loaded',

			// Voice dictation (KB-2). The installed voice bundle owns
			// recognition; the dialog owns capture and one-stop transcription.
			'thought.voice.start': 'Start dictation',
			'thought.voice.stop': 'Stop dictation and transcribe',
			'thought.voice.checking': 'Checking voice input…',
			'thought.voice.requesting': 'Waiting for microphone…',
			'thought.voice.listening': 'Listening… {seconds}s',
			'thought.voice.transcribing': 'Transcribing…',
			'thought.voice.unavailable': 'Voice input is unavailable — enable the Voice Input bundle in Plugins.',
			'thought.voice.unready': 'Voice input is not ready — prepare the model in Plugins → Voice Input.',
			'thought.voice.errorPermission': 'Microphone access is denied. Type your thought, or allow the microphone in your browser.',
			'thought.voice.errorDevice': 'No microphone is available. Type your thought instead.',
			'thought.voice.errorCapture': 'Recording failed. Your text is safe — try dictation again or type.',
			'thought.voice.errorTranscribe': 'Could not transcribe this recording. Your text is safe — try again or type.',
			'thought.voice.errorEmpty': 'No speech recognized — try again or type.',
			'thought.voice.errorTooLong': 'That recording is too long. Keep each dictation under {seconds}s.',
			'thought.voice.announceChecking': 'Checking voice input',
			'thought.voice.announceRequesting': 'Waiting for microphone',
			'thought.voice.announceListening': 'Listening. Press the microphone to stop and transcribe.',
			'thought.voice.announceTranscribing': 'Transcribing',
			'thought.voice.announceAdded': 'Transcript added: {text}',

			'scan.title': 'Project scan',
			'scan.subtitle': 'Scanned {ago}',
			'scan.running': 'Scanning project…',
			'scan.vision': 'Product vision',
			'scan.docs': 'Docs',
			'scan.docsEmpty': 'No docs found',
			'scan.mrs': 'Open merge requests',
			'scan.mrsEmpty': 'No open merge requests',
			'scan.conversations': 'Recent conversations',
			'scan.conversationsEmpty': 'No recent conversations',
			'scan.candidates': 'Candidates',
			'scan.candidatesEmpty': 'No candidate tickets found',
			'scan.candidatesHint': '{n} candidates · {selected} selected',
			'scan.importHint': 'New candidates are added to the board; existing tickets are skipped.',
			'scan.import': 'Import selected',
			'scan.importing': 'Importing…',
			'scan.noneSelected': 'Select at least one candidate to import',
			'scan.close': 'Close scan',
			'scan.retry': 'Retry scan',
			'scan.messages': '{n} messages',

			'team.title': 'Team',
			'team.empty': 'No agents on this project yet',
			'team.lead': 'Lead',
			'team.role': 'Role',
			'team.current': 'Current ticket',
			'team.noTicket': 'No ticket',
			'team.pauseBoard': 'Pause board',
			'team.resumeBoard': 'Resume board',
			'team.agents': '{n} agents',
			'team.running': '{n} running',
			'team.activeTickets': '{n} active tickets',
			'team.close': 'Hide team',
			'team.openTicket': 'Open {id}',
			'team.members': '{n} members',
			'team.running': '{n} running',
			'team.idle': '{n} idle',
			'team.roster': 'Members',
			'team.rosterEmpty': 'No members yet. Add one manually, or describe a teammate and let the AI draft it.',
			'team.addMember': 'Add member',
			'team.addWithAi': 'Add with AI',
			'team.rolePlaybooks': 'Role playbooks',
			'team.since': 'Working {ago}',
			'team.lastActive': 'Active {ago}',
			'team.noActivity': 'No activity yet',
			'team.memberPause': 'Pause {name}',
			'team.memberResume': 'Resume {name}',
			'team.editMember': 'Edit {name}',
			'team.renameHint': 'Rename {name}',

			'draft.section': 'Drafts',
			'draft.drafting': 'Drafting',
			'draft.timeout': 'Timeout',
			'draft.error': 'Error',
			'draft.cancelled': 'Cancelled',
			'draft.retry': 'Retry',
			'draft.dismiss': 'Dismiss',
			'draft.hint': 'The AI is composing this member from your description.',
			'draft.limit': 'Up to 3 drafts at a time — wait for one to finish or dismiss a draft.',
			'draft.started': 'Drafting a new member…',
			'draft.template': 'AI drafting is unavailable — a template member was added instead.',
			'draft.cancelledToast': 'Draft dismissed',

			'ai.title': 'Add with AI',
			'ai.description': 'Describe the teammate',
			'ai.placeholder': 'e.g. a backend dev who lives for migrations',
			'ai.role': 'Preferred role (optional)',
			'ai.anyRole': 'Let the AI choose the role',
			'ai.draft': 'Draft',
			'ai.drafting': 'Drafting…',
			'ai.required': 'Describe the teammate first',

			'member.new': 'New member',
			'member.edit': 'Edit member',
			'member.name': 'Name',
			'member.namePlaceholder': 'Member name',
			'member.nameRequired': 'Enter a name between 1 and 48 characters',
			'member.nameTaken': 'That name is already in the roster',
			'member.title': 'Title',
			'member.titlePlaceholder': 'e.g. Staff Backend Engineer',
			'member.titleTooLong': 'Titles are limited to 60 characters',
			'member.role': 'Role',
			'member.roleHint': 'The role sets the playbook; the persona refines how this person works.',
			'member.persona': 'Persona / system prompt',
			'member.personaPlaceholder': 'How this person thinks, collaborates, and refuses to work…',
			'member.personaCount': '{words} words · {chars}/{max} characters',
			'member.personaTooLong': 'Personas are limited to 6000 characters',
			'member.preview': 'Composed prompt',
			'member.previewHint': 'The preview reflects the saved member — save changes to refresh it.',
			'member.previewSaveFirst': 'Save this member to preview the composed prompt.',
			'member.previewLoad': 'Preview prompt',
			'member.previewLoading': 'Composing prompt…',
			'member.previewError': 'Could not load the composed prompt',
			'member.previewEmpty': 'No prompt available',
			'member.save': 'Save member',
			'member.saving': 'Saving…',
			'member.delete': 'Delete member',
			'member.confirmDelete': 'Confirm delete',
			'member.deleteHint': 'Deleting removes this member from the roster. The role playbook and session history stay.',
			'member.busy': 'This member owns an active ticket. Force delete anyway?',
			'member.forceDelete': 'Force delete',
			'member.forceDeleteConfirm': 'Confirm force delete',
			'member.pause': 'Pause member',
			'member.resume': 'Resume member',
			'member.pausedHint': 'Paused members stay in the roster but do not pick up work.',
			'member.close': 'Close member editor',
			'member.required': 'Name and role are required',

			'roles.title': 'Role playbooks',
			'roles.subtitle': '{n} roles',
			'roles.close': 'Close role playbooks',
			'roles.select': 'Select a role',
			'roles.loading': 'Loading playbook…',
			'roles.error': 'Could not load this playbook',
			'roles.mission': 'Mission',
			'roles.inputs': 'Inputs',
			'roles.steps': 'Steps',
			'roles.artifacts': 'Artifacts',
			'roles.gate': 'Gate',
			'roles.askUser': 'Ask the user when…',
			'roles.escalation': 'Escalation',
			'roles.dod': 'Definition of Done',
			'roles.claimColumns': 'Claims from',
			'roles.noDetail': 'Pick a role to see its playbook.',
			'roles.empty': 'No role catalog available',
			'roles.stepCount': '{n} steps',

			'status.running': 'Running',
			'status.idle': 'Idle',
			'status.paused': 'Paused',
			'status.provisioning': 'Provisioning',
			'status.failed': 'Failed',
			'status.working': 'Working',
			'status.offline': 'Offline',

			'types.story': 'Story',
			'types.task': 'Task',
			'types.bug': 'Bug',
			'types.spike': 'Spike',
			// KB-3 EPIC badge: structural parent ticket, not one more work item.
			'types.epic': 'EPIC',

			'priority.low': 'Low',
			'priority.medium': 'Medium',
			'priority.high': 'High',
			'priority.critical': 'Critical',

			'role.product-manager': 'Product Manager',
			'role.ux-designer': 'UX Designer',
			'role.fe-developer': 'Frontend Developer',
			'role.be-developer': 'Backend Developer',
			'role.fullstack-developer': 'Fullstack Developer',
			'role.reviewer': 'Reviewer',
			'role.tester': 'Tester',
			'role.sre': 'SRE',
			'role.tech-lead': 'Tech Lead',
			'role.bug-fixer': 'Bug Fixer',

			'source.doc': 'Doc',
			'source.todo': 'TODO',
			'source.checkbox': 'Checkbox',
			'source.mr': 'MR',
			'source.conversation': 'Conversation',
			'source.manual': 'Manual',

			'empty.noProjectsTitle': 'No workspaces yet',
			'empty.noProjectsBody':
				'Open a workspace or start a session in the Harness, then refresh to build its Kanban board.',
			'empty.boardTitle': 'This project has no board yet',
			'empty.boardBody':
				'Scan the project to derive tickets from docs, TODOs, conversations, and merge requests, or create the first ticket yourself.',
			'empty.scan': 'Scan project',
			'empty.createBoard': 'Create empty board',
			'empty.selectProjectTitle': 'Select a project',
			'empty.selectProjectBody': 'Pick a workspace to open its Kanban board.',
			'empty.filteredTitle': 'No tickets match',
			'empty.filteredBody': 'Clear the search or filters to see every ticket.',
			'empty.clearFilters': 'Clear filters',

			'loading.board': 'Loading Kanban board…',

			'error.title': 'Could not load the board',
			'error.body': 'The Kanban host endpoint did not answer. Check that the plugin is installed and try again.',
			'error.unreachable': 'Reconnecting…',
			'error.retry': 'Retry',
			'error.noWorkspace': 'Select a project first',
			'error.unknown': 'Unexpected error',

			'toast.created': 'Ticket {id} created',
			'toast.updated': 'Ticket updated',
			'toast.moved': 'Moved to {column}',
			'toast.deleted': 'Ticket deleted',
			'toast.assigned': 'Owner updated',
			'toast.commented': 'Comment added',
			'toast.checklist': 'Checklist updated',
			'toast.blocked': 'Ticket blocked',
			'toast.unblocked': 'Ticket unblocked',
			'toast.blockedMove': 'Unblock this ticket before moving it',
			'toast.boardPaused': 'Board paused',
			'toast.boardResumed': 'Board resumed',
			'toast.boardPausedMove': 'The board is paused — resume it to move tickets',
			'toast.agentPaused': '{name} paused',
			'toast.agentResumed': '{name} resumed',
			'toast.roleUpdated': 'Role updated',
			'toast.memberCreated': 'Member {name} added',
			'toast.memberUpdated': 'Member updated',
			'toast.memberDeleted': 'Member deleted',
			'toast.imported': 'Imported {created} tickets, skipped {skipped}',
			'toast.scanComplete': 'Scan complete',
			'toast.sessionError': 'Could not open that agent session',
			'toast.refreshFailed': 'Refresh failed',

			'time.justNow': 'just now',
			'time.minutes': '{n}m ago',
			'time.hours': '{n}h ago',
			'time.days': '{n}d ago',
			'time.weeks': '{n}w ago',

			'md.codeBlock': 'Code block',
			'md.table': 'Table',
			'md.linkExternal': 'opens in a new tab',
		}

		const zh = {
			'panel.title': '看板',

			'header.project': '项目',
			'header.search': '搜索任务',
			'header.searchPlaceholder': '搜索标题、编号、标签、负责人',
			'header.clearSearch': '清除搜索',
			'header.closeSearch': '关闭搜索',
			'header.filters': '筛选',
			'header.scan': '扫描',
			'header.newTicket': '新建任务',
			'header.team': '团队',
			'header.pause': '暂停看板',
			'header.resume': '恢复看板',
			'header.refresh': '刷新',
			'header.close': '关闭',
			'header.speakThought': '说出想法',
			'header.thoughts': '想法',

			// KB-76 自动巡航控件：入口、设置弹层、试运行预览、立即脉冲、暂停/关闭/不可用状态与内联错误。
			'autopilot.entry': '自动巡航',
			'autopilot.entryState': '自动巡航 — {state}',
			'autopilot.title': '自动巡航控制',
			'autopilot.state.on': '已开启',
			'autopilot.state.off': '已关闭',
			'autopilot.state.paused': '已暂停',
			'autopilot.state.unavailable': '不可用',
			'autopilot.toggleLabel': '自动巡航',
			'autopilot.pauseBoard': '已暂停 — 看板处于暂停状态。',
			'autopilot.pauseMember': '已暂停 — 所有团队成员均已暂停。',
			'autopilot.membersPaused': '部分成员已暂停，其任务会被跳过。',
			'autopilot.offNote': '自动巡航已关闭 — 正在运行的会话会继续，不会被取消。',
			'autopilot.unavailableTitle': '自动巡航不可用',
			'autopilot.unavailableBody': '此宿主版本尚未提供自动巡航服务，看板仍可手动操作。',
			'autopilot.phase1Title': '第一阶段一次只运行一个实现者',
			'autopilot.phase1Body':
				'自动巡航一次最多启动一个实现者会话，精炼与评审泳道也各为单会话。否则两个代理会并行修改同一看板与工作区并互相覆盖。只有在你接受该风险时才提高泳道上限。',
			'autopilot.phase1Dismiss': '知道了',
			'autopilot.settings': '设置',
			'autopilot.cadence': '节奏',
			'autopilot.minutes': '{n} 分钟',
			'autopilot.maxReadyDepth': 'Ready 最大深度',
			'autopilot.laneCaps': '泳道并发上限',
			'autopilot.lane.refine': '精炼',
			'autopilot.lane.implement': '实现',
			'autopilot.lane.review': '评审',
			'autopilot.budget': '派发预算',
			'autopilot.budgetHour': '小时：剩余 {remaining}/{limit}',
			'autopilot.budgetDay': '天：剩余 {remaining}/{limit}',
			'autopilot.budgetUnavailable': '派发预算读数不可用',
			'autopilot.preview': '预览下一次脉冲',
			'autopilot.previewBusy': '正在预览…',
			'autopilot.previewTitle': '下一次脉冲计划',
			'autopilot.previewSummary': '{dispatches} 个派发 · {skips} 个跳过',
			'autopilot.previewEmptyTitle': '当前没有可执行的工作',
			'autopilot.previewEmptyBody': '计划器不会启动任何任务。原因汇总：{summary}',
			'autopilot.reasonCount': '{label} ×{count}',
			'autopilot.reasonUnknown': '未知原因（{code}）',
			'autopilot.boardLevel': '看板',
			'autopilot.noMember': '无成员',
			'autopilot.pulseNow': '立即脉冲',
			'autopilot.pulseBusy': '正在执行脉冲…',
			'autopilot.pulseDisabled': '自动巡航暂停期间无法立即执行脉冲。',
			'autopilot.pulseDone': '脉冲 {id} 已完成。',
			'autopilot.error': '自动巡航错误（{code}）',
			'autopilot.errorPulsing': '该项目已有脉冲正在运行，请在其结束后重试。',
			'autopilot.errorBudget': '派发预算已用尽，请在窗口重置后重试。',
			'autopilot.errorInvalid': '宿主拒绝了该设置，已恢复之前的值。',
			'autopilot.dismissError': '关闭错误',
			'autopilot.saving': '正在保存…',
			'autopilot.reason.admitted': '已准入 — 将启动会话',
			'autopilot.reason.disabled': '自动巡航已关闭',
			'autopilot.reason.board-paused': '看板已暂停',
			'autopilot.reason.epic': 'EPIC 不会被派发',
			'autopilot.reason.blocked': '任务被阻塞',
			'autopilot.reason.active-execution': '已有运行中的会话',
			'autopilot.reason.lane-cap': '泳道已达到并发上限',
			'autopilot.reason.wip-limit': '进行中已达到 WIP 上限',
			'autopilot.reason.ready-depth': 'Ready 深度已达到上限',
			'autopilot.reason.no-member': '没有合适角色的成员',
			'autopilot.reason.member-busy': '成员正忙',
			'autopilot.reason.member-paused': '成员已暂停',
			'autopilot.reason.stale-execution': '执行已停滞',
			'autopilot.reason.postcondition-failed': '上次派发未达成目标，正在退避',
			'autopilot.reason.budget-exhausted': '派发预算已用尽',
			'autopilot.reason.loop-guard': '失败次数过多，已停下等待人工处理',
			'autopilot.reason.pulse-cap': '本次脉冲名额已满',
			'autopilot.reason.no-work': '该泳道当前没有可执行的工作',
			'autopilot.reason.dispatch-failed': '派发失败 — 会话未能启动',
			// KB-77 观测面：脉冲记录、下一次脉冲倒计时、泳道准入、成员自动巡航状态与去重告警。
			'autopilot.countdown.label': '下一次脉冲',
			'autopilot.countdown.value': '{mm}:{ss}',
			'autopilot.countdown.off': '关闭',
			'autopilot.countdown.paused': '暂停',
			'autopilot.countdown.aria': '下一次自动巡航脉冲：{value}',
			'autopilot.trigger.timer': '定时',
			'autopilot.trigger.manual': '手动',
			'autopilot.trigger.resume': '恢复后',
			'autopilot.feedTitle': '脉冲记录',
			'autopilot.feedCount': '最新 {n} 条',
			'autopilot.feedLoading': '正在加载脉冲…',
			'autopilot.feedUnavailable': '此宿主不提供脉冲历史。',
			'autopilot.feedEmptyTitle': '暂无脉冲 — 请开启自动巡航',
			'autopilot.feedEmptyBody': '每次脉冲都会记录其考量与启动内容。',
			'autopilot.feedEmptyAction': '开启自动巡航',
			'autopilot.feedEmptyTitleOn': '暂无脉冲',
			'autopilot.feedEmptyBodyOn': '自动巡航已开启 — 首次脉冲会在下一个定时周期出现。',
			'autopilot.feedOpen': '脉冲 {id} — 展开决策',
			'autopilot.feedDetails': '脉冲 {id} 的决策',
			'autopilot.feedDecisionTitle': '决策',
			'autopilot.feedDispatchedTitle': '已启动的会话',
			'autopilot.feedNoDecisions': '该脉冲没有记录任何决策。',
			'autopilot.feedNoDispatched': '没有启动任何会话。',
			'autopilot.feedDispatchSkipped': '计划中已准入，但派发时被跳过 — 未启动会话。',
			'autopilot.feedDurationUnknown': '—',
			'autopilot.durationSeconds': '{value} 秒',
			'autopilot.durationMs': '{value} 毫秒',
			'autopilot.feedErrorMarker': '错误',
			'autopilot.feedDispatched': '派发 {n}',
			'autopilot.feedSkipped': '跳过 {n}',
			'autopilot.action.dispatch': '派发',
			'autopilot.action.skip': '跳过',
			'autopilot.alert.group': '自动巡航告警',
			'autopilot.alert.title': '自动巡航告警',
			'autopilot.alert.pulseError': '脉冲失败：{message}',
			'autopilot.alert.openTicket': '打开任务 {id}',
			'autopilot.alert.ack': '确认',
			'autopilot.entryAlerts': '{n} 条未读告警',
			'autopilot.laneAdmission.busy': '繁忙',
			'autopilot.laneAdmission.idle': '空闲',
			'autopilot.laneAdmission.paused': '暂停',
			'autopilot.laneAdmission.capacity': '（{occupancy}/{cap}）',
			'autopilot.laneAdmission.aria': '{lane}泳道准入：{state}，{occupancy}/{cap} 个名额',
			'autopilot.member.chip': '自动巡航：{state}',
			'autopilot.member.active': '正在处理 {id}',
			'autopilot.member.activeSession': '会话运行中',
			'autopilot.member.next': '下一个 {id}',
			'autopilot.member.resume': '继续 {id}',
			'autopilot.member.idle': '会话空闲',
			'autopilot.member.paused': '已暂停',
			'autopilot.member.noWork': '无工作',
			'autopilot.member.lastActive': '最近激活 {ago}',
			'autopilot.member.neverActive': '从未激活',
			'autopilot.member.aria': '自动巡航：{state}；{time}',

			'project.select': '选择项目',
			'project.none': '暂无项目',
			'project.refresh': '刷新项目',
			'project.sessions': '{n} 个会话',
			'project.active': '{n} 项进行中',
			'project.paused': '已暂停',

			'stats.backlog': '待办',
			'stats.ready': '就绪',
			'stats.wip': '进行中',
			'stats.review': '评审',
			'stats.done': '完成',

			'paused.banner': '看板已暂停 — 代理的工作被冻结，直到你恢复。',
			'paused.resume': '恢复看板',
			'paused.by': '由 {name} 暂停',
			'execution.title': '智能体执行',
			'execution.run': '交给智能体执行',
			'execution.role': '执行角色',
			'execution.running': '智能体执行中',
			'execution.idle': '智能体空闲',
			'execution.blocked': '已阻塞',
			'execution.paused': '智能体已暂停',
			'execution.done': '智能体已完成',
			'execution.failed': '智能体失败',
			'execution.cancelled': '执行已取消',
			'execution.openSession': '打开智能体会话',
			'execution.continue': '继续',
			'execution.cancel': '取消执行',
			'execution.confirmCancel': '确认取消',
			'execution.retry': '重新执行',
			'execution.report': '执行报告',
			'execution.chooseRole': '选择执行角色',
			'execution.laneHint': '智能体会认领此任务并逐列推进；需要你时会在这里提问。',
			'execution.waitingTitle': '等待你的回复',
			'execution.waitingHint': '回答这些问题或授予所需权限后，智能体会自动恢复。',
			'execution.answerPlaceholder': '你的回答…',
			'execution.grant': '授予',
			'execution.sendAnswers': '发送回答并恢复',
			'execution.runStarted': '已启动智能体会话',
			'execution.runResumed': '智能体已恢复',
			'execution.answered': '回答已发送',
			'execution.cancelledToast': '执行已取消',
			'execution.questions': '{n} 个问题',
			'execution.accessMode': '访问权限',
			'access.readOnly': '只读',
			'access.workspaceWrite': '工作区写入',
			'access.fullAccess': '完全访问',
			'access.auto': '自动（当前策略）',
			'execution.accessHint': '此智能体会话的权限模式，会按列和任务性质推荐；启动前可以修改。',
			'execution.handoff': '接下来',
			'execution.startRole': '启动{role}',
			'execution.suggestedAgent': '建议代理：{name}',
			'execution.handoffHint': '任务进入新列时已自动指派。启动后会创建该角色的会话并带上之前的上下文。',
			'execution.need.permission': '权限',
			'execution.need.decision': '决策',
			'execution.need.question': '问题',
			'execution.need.input': '输入',
			'columns.blocked': '阻塞',
			'stats.blocked': '阻塞',
			'stats.executing': '智能体',
			'card.run': '交给智能体执行',
			'card.blockedQuestions': '{n} 项待处理',
			'card.nextRole': '→ {role}',
			'confirm.cancelExecution': '取消此智能体执行？会话仍会保留在会话列表。',

			'columns.backlog': '待办',
			'columns.ready': '就绪',
			'columns.in_progress': '进行中',
			'columns.review': '评审',
			'columns.done': '完成',
			'columns.add': '向{column}添加任务',
			'columns.empty': '将任务拖到这里',
			'columns.emptyBlocked': '没有阻塞的任务',
			'columns.emptyFiltered': '没有匹配的任务',
			'columns.limit': '{n}/{limit}',

			'card.open': '打开 {id}',
			'card.blocked': '已阻塞',
			'card.blockedReason': '已阻塞：{reason}',
			'card.unassigned': '未分配',
			'card.checklist': '清单 {done}/{total}',
			'card.comments': '{n} 条评论',
			'card.updated': '{ago}更新',
			'card.parent': '父任务 {id}',
			'card.parentTitle': '史诗：{title}',
			'card.children': '{n} 个子任务',
			'card.epicLocked': '仅 Backlog',
			'card.epicLockedHint': '史诗固定留在 Backlog，不能拖拽、移动或由智能体运行。',

			'filters.title': '筛选',
			'filters.role': '角色',
			'filters.owner': '负责人',
			'filters.allRoles': '全部角色',
			'filters.allOwners': '全部负责人',
			'filters.unassigned': '未分配',
			'filters.clear': '清除筛选',

			'actions.create': '创建任务',
			'actions.cancel': '取消',
			'actions.save': '保存',
			'actions.saved': '已保存',
			'actions.delete': '删除',
			'actions.confirmDelete': '确认删除',
			'actions.add': '添加',
			'actions.block': '阻塞',
			'actions.unblock': '解除阻塞',
			'actions.openSession': '打开会话',
			'actions.pauseAgent': '暂停代理',
			'actions.resumeAgent': '恢复代理',
			'actions.selectAll': '全选',
			'actions.retry': '重试',

			'detail.ticket': '任务 {id}',
			'detail.title': '标题',
			'detail.titlePlaceholder': '任务标题',
			'detail.description': '描述',
			'detail.descriptionPlaceholder': '补充背景、验收标准…',
			// KB-58 描述与史诗 PRD 的阅读 / 编辑 / 预览切换。
			'detail.descriptionMode': '描述视图',
			'detail.edit': '编辑',
			'detail.preview': '预览',
			'detail.descriptionEmpty': '暂无描述 — 使用“编辑”添加背景、验收标准与链接。',
			'detail.epicPrdEmpty': '暂无史诗 PRD — 使用“编辑”撰写成果、范围、验收标准与拆解计划。',
			'detail.column': '列',
			'detail.role': '角色',
			'detail.roleNone': '无角色',
			'detail.priority': '优先级',
			'detail.type': '类型',
			'detail.owner': '负责人',
			'detail.ownerNone': '未分配',
			'detail.ownerSelect': '分配负责人',
			'detail.labels': '标签',
			'detail.labelsPlaceholder': '前端, ux, 紧急',
			'detail.labelsHint': '用逗号分隔标签',
			'detail.block': '阻塞状态',
			'detail.blockReason': '阻塞原因',
			'detail.blockReasonPlaceholder': '为什么被阻塞？',
			'detail.checklist': '检查清单',
			'detail.checklistPlaceholder': '添加检查项',
			'detail.comments': '评论',
			'detail.commentsEmpty': '暂无评论',
			'detail.commentsPlaceholder': '写一条评论…',
			'detail.commentSubmit': '评论',
			'detail.activity': '动态',
			'detail.activityEmpty': '暂无动态',
			'detail.created': '{ago}创建',
			'detail.updated': '{ago}更新',
			'detail.moved': '{ago}移动',
			'detail.accepted': '{ago}验收',
			'detail.deleteHint': '删除后将移除该任务及其历史记录。',
			'detail.close': '关闭任务详情',
			'detail.moveHint': '看板每次只能移动一列。',
			'detail.epicPrd': '史诗 PRD',
			'detail.epicPrdHint': '史诗的成果、范围、验收标准与拆解计划。',
			'detail.children': '子任务',
			'detail.childrenEmpty': '暂无子任务。',
			'detail.childrenEmptyHint': '新建任务并把该史诗设为父任务，即可开始拆解。',
			'detail.epicLocked': '史诗固定留在 Backlog。请把它拆解为子任务，而不是移动或运行它。',
			'detail.childStatus': '状态',
			'detail.source': '来源',

			'new.title': '新建任务',
			'new.titleLabel': '标题',
			'new.titlePlaceholder': '需要完成什么？',
			'new.descriptionPlaceholder': '背景、验收标准…',
			'new.type': '类型',
			'new.priority': '优先级',
			'new.role': '角色',
			'new.column': '列',
			'new.titleRequired': '请输入标题以创建任务',
			'new.create': '创建任务',
			'new.creating': '创建中…',
			'new.epicHint': '史诗创建在 Backlog，且不能由智能体认领。',

			// 想法记录（KB-1）。共用文案复用现有键（actions.cancel、execution.openSession、header.close）。
			'thought.title': '说出想法',
			'thought.field': '想法',
			'thought.placeholder': '想到什么就说什么，一个想法就够了。',
			'thought.send': '发送想法',
			'thought.sending': '发送中…',
			'thought.success': '已记录想法，产品经理正在处理。',
			// KB-5：暂停期间记录的想法会排队，而不是被拒绝。
			'thought.pausedHint': '看板暂停期间记录的想法会排队',
			'thought.close': '关闭想法',
			'thought.empty': '还没有想法。点击“说出想法”记录一个。',
			'thought.count': '{n} 个想法',
			'thought.queuedCount': '{n} 个排队中',
			'thought.expand': '展开',
			'thought.collapse': '收起',
			'thought.status.recorded': '已记录',
			'thought.status.working': '思考中…',
			'thought.status.done': '已完成',
			'thought.status.failed': '失败',
			'thought.status.queued': '已排队',
			'thought.status.cancelled': '已取消',
			'thought.status.unknown': '未知状态',
			'thought.timeline': '历史',
			'thought.retry': '重试',
			'thought.cancel': '取消运行',
			'thought.retryOf': '重试自 {id}',
			'thought.retryOfPlain': '重试自 {id}（不在当前窗口）',
			'thought.retriedToast': '已重试为 {id}。',
			'thought.cancelledToast': '已取消该想法。',
			'thought.ticketCreated': '已创建 {id}',
			'thought.edited': '已编辑',
			'thought.deleted': '已删除',
			'thought.delete': '删除',
			'thought.edit': '编辑',
			'thought.save': '保存',
			'thought.cancelEdit': '取消编辑',
			'thought.editedToast': '想法已更新。',
			'thought.deletedToast': '想法已删除。',
			'thought.editPlaceholder': '修改想法内容',
			'thought.emptyError': '请先输入想法再保存。',
			'thought.queuedHint': '已排队，恢复看板后开始处理',
			'thought.ticketChip': '想法',
			'thought.deletedFallback': '想法已删除',
			'thought.unavailable': '想法未加载',

			// 语音输入（KB-2）。识别由已安装的语音包负责；对话框负责录音与停止后的一次转写。
			'thought.voice.start': '开始语音输入',
			'thought.voice.stop': '停止语音输入并转写',
			'thought.voice.checking': '正在检查语音输入…',
			'thought.voice.requesting': '正在等待麦克风…',
			'thought.voice.listening': '正在聆听… {seconds} 秒',
			'thought.voice.transcribing': '正在转写…',
			'thought.voice.unavailable': '语音输入不可用——请在“插件”中启用 Voice Input。',
			'thought.voice.unready': '语音输入尚未就绪——请在“插件”→“Voice Input”中准备模型。',
			'thought.voice.errorPermission': '麦克风权限被拒绝。请直接输入想法，或在浏览器中允许麦克风。',
			'thought.voice.errorDevice': '没有可用的麦克风，请直接输入想法。',
			'thought.voice.errorCapture': '录音失败。文本已保留——请重试语音输入或直接输入。',
			'thought.voice.errorTranscribe': '无法转写这段录音。文本已保留——请重试或直接输入。',
			'thought.voice.errorEmpty': '未识别到语音——请重试或直接输入。',
			'thought.voice.errorTooLong': '录音过长。每次语音输入请保持在 {seconds} 秒以内。',
			'thought.voice.announceChecking': '正在检查语音输入',
			'thought.voice.announceRequesting': '正在等待麦克风',
			'thought.voice.announceListening': '正在聆听。点击麦克风停止并转写。',
			'thought.voice.announceTranscribing': '正在转写',
			'thought.voice.announceAdded': '已添加转写文本：{text}',

			'scan.title': '项目扫描',
			'scan.subtitle': '{ago}扫描',
			'scan.running': '正在扫描项目…',
			'scan.vision': '产品愿景',
			'scan.docs': '文档',
			'scan.docsEmpty': '未找到文档',
			'scan.mrs': '待合并请求',
			'scan.mrsEmpty': '暂无待合并请求',
			'scan.conversations': '最近会话',
			'scan.conversationsEmpty': '暂无最近会话',
			'scan.candidates': '候选任务',
			'scan.candidatesEmpty': '未找到候选任务',
			'scan.candidatesHint': '{n} 个候选 · 已选 {selected}',
			'scan.importHint': '新候选会加入看板，已存在的任务会跳过。',
			'scan.import': '导入所选',
			'scan.importing': '导入中…',
			'scan.noneSelected': '请至少选择一个候选任务',
			'scan.close': '关闭扫描',
			'scan.retry': '重新扫描',
			'scan.messages': '{n} 条消息',

			'team.title': '团队',
			'team.empty': '该项目暂无代理',
			'team.lead': '负责人',
			'team.role': '角色',
			'team.current': '当前任务',
			'team.noTicket': '无任务',
			'team.pauseBoard': '暂停看板',
			'team.resumeBoard': '恢复看板',
			'team.agents': '{n} 个代理',
			'team.running': '{n} 个运行中',
			'team.activeTickets': '{n} 项进行中任务',
			'team.close': '隐藏团队',
			'team.openTicket': '打开 {id}',
			'team.members': '{n} 位成员',
			'team.idle': '{n} 位空闲',
			'team.roster': '成员',
			'team.rosterEmpty': '还没有成员。可以手动添加，或描述一位伙伴让 AI 起草。',
			'team.addMember': '添加成员',
			'team.addWithAi': 'AI 添加',
			'team.rolePlaybooks': '角色手册',
			'team.since': '已工作 {ago}',
			'team.lastActive': '{ago}活跃',
			'team.noActivity': '暂无活动',
			'team.memberPause': '暂停 {name}',
			'team.memberResume': '恢复 {name}',
			'team.editMember': '编辑 {name}',
			'team.renameHint': '重命名 {name}',

			'draft.section': '起草中',
			'draft.drafting': '起草中',
			'draft.timeout': '超时',
			'draft.error': '出错',
			'draft.cancelled': '已取消',
			'draft.retry': '重试',
			'draft.dismiss': '忽略',
			'draft.hint': 'AI 正在根据你的描述合成这位成员。',
			'draft.limit': '最多同时起草 3 位 — 请等待其中一位完成，或忽略一份草稿。',
			'draft.started': '正在起草新成员…',
			'draft.template': 'AI 起草暂不可用 — 已改为添加模板成员。',
			'draft.cancelledToast': '已忽略该草稿',

			'ai.title': 'AI 添加成员',
			'ai.description': '描述这位成员',
			'ai.placeholder': '例如：一位热衷数据库迁移的后端工程师',
			'ai.role': '偏好角色（可选）',
			'ai.anyRole': '由 AI 决定角色',
			'ai.draft': '起草',
			'ai.drafting': '起草中…',
			'ai.required': '请先描述这位成员',

			'member.new': '新建成员',
			'member.edit': '编辑成员',
			'member.name': '姓名',
			'member.namePlaceholder': '成员姓名',
			'member.nameRequired': '请输入 1–48 个字符的姓名',
			'member.nameTaken': '该姓名已在成员列表中',
			'member.title': '头衔',
			'member.titlePlaceholder': '例如：高级后端工程师',
			'member.titleTooLong': '头衔最多 60 个字符',
			'member.role': '角色',
			'member.roleHint': '角色决定使用哪本手册，人设细化这个人的工作方式。',
			'member.persona': '人设 / 系统提示',
			'member.personaPlaceholder': '这个人如何思考、协作，以及拒绝怎样工作…',
			'member.personaCount': '{words} 词 · {chars}/{max} 字符',
			'member.personaTooLong': '人设最多 6000 个字符',
			'member.preview': '合成提示词',
			'member.previewHint': '预览基于已保存的成员 — 修改后请保存再刷新。',
			'member.previewSaveFirst': '保存成员后才能预览合成提示词。',
			'member.previewLoad': '预览提示词',
			'member.previewLoading': '正在合成提示词…',
			'member.previewError': '无法加载合成提示词',
			'member.previewEmpty': '暂无提示词',
			'member.save': '保存成员',
			'member.saving': '保存中…',
			'member.delete': '删除成员',
			'member.confirmDelete': '确认删除',
			'member.deleteHint': '删除会将该成员从名册移除；角色手册与会话历史保留。',
			'member.busy': '该成员仍有进行中的任务。要强制删除吗？',
			'member.forceDelete': '强制删除',
			'member.forceDeleteConfirm': '确认强制删除',
			'member.pause': '暂停成员',
			'member.resume': '恢复成员',
			'member.pausedHint': '已暂停的成员仍在名册中，但不会领取工作。',
			'member.close': '关闭成员编辑器',
			'member.required': '姓名和角色为必填项',

			'roles.title': '角色手册',
			'roles.subtitle': '{n} 个角色',
			'roles.close': '关闭角色手册',
			'roles.select': '选择角色',
			'roles.loading': '正在加载手册…',
			'roles.error': '无法加载该手册',
			'roles.mission': '使命',
			'roles.inputs': '输入',
			'roles.steps': '步骤',
			'roles.artifacts': '产出物',
			'roles.gate': '检查点',
			'roles.askUser': '何时询问用户…',
			'roles.escalation': '升级处理',
			'roles.dod': '完成定义',
			'roles.claimColumns': '可认领列',
			'roles.noDetail': '选择一个角色查看其手册。',
			'roles.empty': '暂无角色目录',
			'roles.stepCount': '{n} 个步骤',

			'status.running': '运行中',
			'status.idle': '空闲',
			'status.paused': '已暂停',
			'status.provisioning': '准备中',
			'status.failed': '失败',
			'status.working': '工作中',
			'status.offline': '离线',

			'types.story': '故事',
			'types.task': '任务',
			'types.bug': '缺陷',
			'types.spike': '探索',
			'types.epic': '史诗',

			'priority.low': '低',
			'priority.medium': '中',
			'priority.high': '高',
			'priority.critical': '紧急',

			'role.product-manager': '产品经理',
			'role.ux-designer': 'UX 设计师',
			'role.fe-developer': '前端开发',
			'role.be-developer': '后端开发',
			'role.fullstack-developer': '全栈开发',
			'role.reviewer': '评审',
			'role.tester': '测试',
			'role.sre': 'SRE',
			'role.tech-lead': '技术负责人',
			'role.bug-fixer': '缺陷修复工程师',

			'source.doc': '文档',
			'source.todo': 'TODO',
			'source.checkbox': '勾选项',
			'source.mr': '合并请求',
			'source.conversation': '会话',
			'source.manual': '手动',

			'empty.noProjectsTitle': '暂无工作区',
			'empty.noProjectsBody': '在 Harness 中打开工作区或新建会话，然后刷新以创建看板。',
			'empty.boardTitle': '该项目还没有看板',
			'empty.boardBody': '扫描项目以从文档、TODO、会话和合并请求中生成任务，或自己创建第一个任务。',
			'empty.scan': '扫描项目',
			'empty.createBoard': '创建空白看板',
			'empty.selectProjectTitle': '选择一个项目',
			'empty.selectProjectBody': '选择一个工作区以打开其看板。',
			'empty.filteredTitle': '没有匹配的任务',
			'empty.filteredBody': '清除搜索或筛选以查看全部任务。',
			'empty.clearFilters': '清除筛选',

			'loading.board': '正在加载看板…',

			'error.title': '无法加载看板',
			'error.body': '看板宿主接口没有响应。请确认插件已安装后重试。',
			'error.unreachable': '正在重新连接…',
			'error.retry': '重试',
			'error.noWorkspace': '请先选择项目',
			'error.unknown': '未知错误',

			'toast.created': '任务 {id} 已创建',
			'toast.updated': '任务已更新',
			'toast.moved': '已移动到{column}',
			'toast.deleted': '任务已删除',
			'toast.assigned': '负责人已更新',
			'toast.commented': '评论已添加',
			'toast.checklist': '清单已更新',
			'toast.blocked': '任务已阻塞',
			'toast.unblocked': '任务已解除阻塞',
			'toast.blockedMove': '请先解除阻塞再移动任务',
			'toast.boardPaused': '看板已暂停',
			'toast.boardResumed': '看板已恢复',
			'toast.boardPausedMove': '看板已暂停 — 恢复后才能移动任务',
			'toast.agentPaused': '{name} 已暂停',
			'toast.agentResumed': '{name} 已恢复',
			'toast.roleUpdated': '角色已更新',
			'toast.memberCreated': '成员 {name} 已添加',
			'toast.memberUpdated': '成员已更新',
			'toast.memberDeleted': '成员已删除',
			'toast.imported': '已导入 {created} 个任务，跳过 {skipped} 个',
			'toast.scanComplete': '扫描完成',
			'toast.sessionError': '无法打开该代理会话',
			'toast.refreshFailed': '刷新失败',

			'time.justNow': '刚刚',
			'time.minutes': '{n} 分钟前',
			'time.hours': '{n} 小时前',
			'time.days': '{n} 天前',
			'time.weeks': '{n} 周前',

			'md.codeBlock': '代码块',
			'md.table': '表格',
			'md.linkExternal': '在新标签页打开',
		}

		// ------------------------------------------------------------------
		// Scoped stylesheet (one style element rendered by the root)
		// ------------------------------------------------------------------

		const CSS = `.kb-root{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;font-size:13px;line-height:1.45;--kb-panel-surface:var(--dsw-alias-bg-overlay);--kb-panel-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent);--kb-rail-shadow:-8px 0 24px color-mix(in srgb,var(--dsw-alias-label-primary) 14%,transparent);container-type:inline-size;container-name:kb}
body[data-ds-dark-theme] .kb-root{--kb-panel-surface:var(--dsw-alias-bg-layer-3);--kb-panel-shadow:var(--dsw-elevation-panel);--kb-rail-shadow:var(--dsw-elevation-panel)}
.kb-root *,.kb-root *::before,.kb-root *::after{box-sizing:border-box}
.kb-root button{font-family:inherit}
.kb-root input,.kb-root textarea,.kb-root select{font-family:inherit;color:var(--dsw-alias-label-primary)}
.kb-root button{cursor:pointer}
.kb-root button:disabled{cursor:default}
.kb-root select{cursor:pointer}
.kb-header{display:flex;align-items:center;gap:8px;height:56px;min-height:56px;min-width:0;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);position:relative;z-index:6}
.kb-headerLeft{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 auto}
.kb-headerRight{display:flex;align-items:center;gap:6px;flex:none;min-width:0}
.kb-titleIcon{display:inline-flex;flex:none;color:var(--dsw-alias-brand-primary)}
.kb-title{font-size:15px;font-weight:600;letter-spacing:-.01em;white-space:nowrap}
.kb-projectWrap{position:relative;min-width:0}
.kb-projectBtn{display:flex;align-items:center;gap:6px;max-width:300px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);min-width:0}
.kb-projectBtn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.kb-projectBtn:disabled{opacity:.55}
.kb-projectName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:500}
.kb-chevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.kb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;white-space:nowrap;flex:none;transition:background .12s ease,border-color .12s ease,opacity .12s ease}
.kb-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.kb-btn:disabled{opacity:.45}
.kb-btn--primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.kb-btn--primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);opacity:.9}
.kb-btn--ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.kb-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kb-btn--active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kb-btn--icon{width:28px;padding:0}
.kb-btn--sm{height:24px;padding:0 8px;font-size:11px;border-radius:6px}
.kb-btn--danger{color:var(--dsw-alias-state-error-primary)}
.kb-btn--danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary)}
body[data-ds-dark-theme] .kb-btn--danger{color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 70%,var(--dsw-alias-label-primary))}
.kb-btnIcon{display:inline-flex;flex:none}
.kb-btnBadge{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-size:9px;font-weight:700;font-variant-numeric:tabular-nums}
.kb-search{position:relative;display:flex;align-items:center;height:28px;width:186px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:0 4px 0 8px;gap:6px}
.kb-search:focus-within{border-color:var(--dsw-alias-border-l2)}
.kb-searchIcon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}
.kb-searchInput{flex:1;min-width:0;border:0;outline:0;background:transparent;font-size:12px;height:100%;padding:0}
.kb-searchInput::placeholder{color:var(--dsw-alias-label-secondary)}
.kb-searchClear{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0}
.kb-searchClear:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kb-btnLabel{white-space:nowrap}
.kb-searchToggle{display:none}
.kb-search.kb-search--overlay{position:absolute;top:8px;left:10px;right:10px;z-index:9;width:auto;max-width:none;display:none;background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2)}
.kb-search--overlay .kb-searchClose{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0}
.kb-search--overlay .kb-searchClose:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kb-filtersWrap{position:relative}
.kb-menu{position:absolute;top:34px;left:0;z-index:40;width:330px;max-height:min(430px,70vh);overflow-y:auto;padding:6px;background:var(--kb-panel-surface);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:var(--kb-panel-shadow)}
.kb-menuRow{display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:7px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary)}
.kb-menuRow:hover{background:var(--dsw-alias-bg-layer-2)}
.kb-menuRow--active{background:var(--dsw-alias-bg-layer-2)}
.kb-menuTop{display:flex;align-items:center;gap:6px;min-width:0}
.kb-menuTitle{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}
.kb-menuCheck{display:inline-flex;flex:none;color:var(--dsw-alias-brand-primary)}
.kb-menuPath{font-size:10px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.kb-menuCounts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:1px}
.kb-menuCount{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.kb-menuEmpty{padding:10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.kb-menuFoot{display:flex;gap:6px;padding:6px 4px 2px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:4px}
.kb-filters{position:absolute;top:34px;right:0;z-index:40;width:248px;padding:10px;display:flex;flex-direction:column;gap:9px;background:var(--kb-panel-surface);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:var(--kb-panel-shadow)}
.kb-stats{display:flex;align-items:center;gap:6px;height:34px;min-height:34px;min-width:0;padding:0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);overflow-x:auto;overflow-y:hidden}
.kb-statPill{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary);background:transparent;white-space:nowrap;flex:none}
.kb-statPill b{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-weight:600;font-size:11px}
.kb-statPill--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.kb-statPill--warn b{color:var(--dsw-alias-state-warn-primary)}
.kb-statPill--error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.kb-statPill--error b{color:var(--dsw-alias-state-error-primary)}
.kb-banner{display:flex;align-items:center;gap:8px;height:36px;min-height:36px;padding:0 14px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,var(--dsw-alias-bg-base));border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-state-warn-primary);font-size:12px}
.kb-bannerText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-warnStrip{display:flex;align-items:center;gap:8px;padding:5px 14px;font-size:11px;color:var(--dsw-alias-state-warn-primary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.kb-warnStripText{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-body{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}
.kb-bodyMain{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0}
.kb-boardWrap{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.kb-emptyBanner{display:flex;align-items:center;gap:10px;margin:12px 14px 0;padding:8px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.kb-emptyBannerIcon{display:inline-flex;flex:none;color:var(--dsw-alias-brand-primary)}
.kb-emptyBannerText{flex:1;min-width:0;font-size:12px;line-height:1.45}
.kb-board{display:flex;align-items:stretch;gap:12px;flex:1;min-height:0;min-width:0;padding:12px 14px;overflow-x:auto;overflow-y:hidden}
.kb-col{display:flex;flex-direction:column;flex:1 1 0;min-width:176px;max-width:440px;min-height:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;transition:border-color .12s ease,background .12s ease;container-type:inline-size;container-name:kb-lane}
.kb-col--over{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1))}
.kb-colHead{display:flex;align-items:center;gap:6px;height:38px;min-height:38px;padding:0 6px 0 10px}
.kb-dot{width:7px;height:7px;border-radius:999px;flex:none;background:var(--dsw-alias-state-idle-primary)}
.kb-dot--backlog{background:var(--dsw-alias-state-idle-primary)}
.kb-dot--ready{background:var(--dsw-alias-label-secondary)}
.kb-dot--in_progress{background:var(--dsw-alias-state-warn-primary)}
.kb-dot--review{background:var(--dsw-alias-brand-primary)}
.kb-dot--done{background:var(--dsw-alias-state-success-primary)}
.kb-colTitle{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-colCount{display:inline-flex;align-items:center;justify-content:center;min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:600;font-variant-numeric:tabular-nums}
.kb-colWip{font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 5px;height:16px;line-height:14px;flex:none}
.kb-colWip--warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.kb-colWip--error{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.kb-colSpacer{flex:1}
.kb-colAdd{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;flex:none}
.kb-colAdd:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kb-colAdd:disabled{opacity:.4}
.kb-colBody{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;overflow-y:auto;padding:2px 8px 10px}
.kb-colEmpty{display:flex;align-items:center;justify-content:center;min-height:76px;margin:2px 0 2px;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:11px;text-align:center}
.kb-card{position:relative;display:flex;flex-direction:column;gap:6px;min-width:0;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:border-color .12s ease,opacity .12s ease}
.kb-card:hover{border-color:var(--dsw-alias-border-l2)}
.kb-card--dragging{opacity:.45}
.kb-cardTop{display:flex;align-items:center;gap:5px;row-gap:4px;flex-wrap:wrap;min-width:0}
.kb-cardId{font-size:10px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.03em;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.kb-cardChips{display:flex;align-items:center;flex-wrap:wrap;gap:4px;flex:1 1 118px;min-width:0}
.kb-cardTop > .kb-chip{flex:none;margin-left:auto}
.kb-cardSpacer{flex:1}
.kb-cardTitle{font-size:12.5px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.kb-cardMeta{display:flex;align-items:center;gap:5px;row-gap:4px;flex-wrap:wrap;min-width:0}
.kb-cardFoot{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;min-width:0}
.kb-cardLabels{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.kb-tag{display:inline-flex;align-items:center;gap:3px;height:16px;max-width:min(120px,100%);min-width:0;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:9.5px;font-weight:500;white-space:nowrap;overflow:hidden;flex:0 1 auto}
.kb-tagText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-chip{display:inline-flex;align-items:center;gap:3px;height:18px;max-width:100%;min-width:0;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-size:10px;font-weight:600;white-space:nowrap;flex:0 1 auto;overflow:hidden}
.kb-chipText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-chip--brand{color:var(--dsw-alias-brand-primary);border-color:currentColor}
.kb-chip--warn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}
.kb-chip--error{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.kb-chip--success{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.kb-chip--idle{color:var(--dsw-alias-state-idle-primary);border-color:currentColor}
.kb-chip--epic{color:var(--dsw-alias-brand-primary);border-color:currentColor;letter-spacing:.04em}
.kb-chip--parent{appearance:none;font:inherit;padding:0 6px;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);cursor:pointer}
.kb-chip--parent:hover{color:var(--dsw-alias-label-primary);border-color:currentColor}
.kb-card--epic{box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary)}
.kb-childList{display:flex;flex-direction:column;gap:6px}
.kb-childRow{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;text-align:left;cursor:pointer}
.kb-childRow:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3)}
.kb-childRow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.kb-childId{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.kb-childTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.kb-hint--epic{color:var(--dsw-alias-brand-primary)}
.kb-iconMeta{display:inline-flex;align-items:center;gap:2px;min-width:0;font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.kb-cardMeta .kb-iconMeta{max-width:100%;flex:0 1 auto}
.kb-cardOwnerName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-avatar{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:9px;font-weight:700;letter-spacing:.02em;flex:none}
.kb-avatar--lead{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.kb-avatar--sm{width:18px;height:18px;font-size:8.5px}
.kb-rail{display:flex;flex-direction:column;flex:0 0 336px;width:336px;min-width:336px;min-height:0;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-sidebar-fill)}
.kb-railHead{display:flex;align-items:center;gap:8px;height:44px;min-height:44px;padding:0 8px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.kb-railTitle{display:flex;align-items:center;gap:6px;flex:1;min-width:0;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kb-railBody{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow-y:auto;padding:10px 10px 16px}
.kb-railSection{display:flex;flex-direction:column;gap:6px}
.kb-railSectionTitle{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);padding:0 2px}
.kb-pauseRow{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-pauseText{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.kb-pauseTitle{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-pauseHint{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-summaryRow{display:flex;flex-wrap:wrap;gap:4px}
.kb-teamRow{display:flex;flex-direction:column;gap:5px;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-teamTop{display:flex;align-items:center;gap:6px;min-width:0}
.kb-teamName{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0}
.kb-teamStatus{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.kb-teamBottom{display:flex;align-items:center;gap:6px;min-width:0}
.kb-teamRole{height:22px;min-width:0;flex:0 1 150px;max-width:190px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px}
.kb-teamRole:disabled{opacity:.55}
.kb-teamTicket{display:inline-flex;align-items:center;gap:3px;min-width:0;max-width:100%;border:0;background:transparent;padding:0;font-size:10px;color:var(--dsw-alias-brand-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 0}
.kb-teamTicketText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-teamTicket:hover{text-decoration:underline}
.kb-teamNoTicket{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.kb-statusDot{width:6px;height:6px;border-radius:999px;flex:none;background:var(--dsw-alias-state-idle-primary)}
.kb-statusDot--running{background:var(--dsw-alias-state-success-primary);animation:kb-pulse 1.8s ease-in-out infinite}
.kb-statusDot--idle{background:var(--dsw-alias-state-idle-primary)}
.kb-statusDot--paused{background:var(--dsw-alias-state-warn-primary)}
.kb-statusDot--provisioning{background:var(--dsw-alias-brand-primary)}
.kb-statusDot--failed{background:var(--dsw-alias-state-error-primary)}
.kb-overlay{position:absolute;inset:0;z-index:30;display:flex;background:color-mix(in srgb,var(--dsw-alias-bg-base) 64%,transparent);animation:kb-fade .12s ease}
.kb-overlay--center{align-items:center;justify-content:center;padding:24px}
.kb-overlay--right{justify-content:flex-end}
.kb-drawer{display:flex;flex-direction:column;width:min(500px,94%);max-width:100%;height:100%;min-height:0;overflow:hidden;background:var(--kb-panel-surface);border-left:1px solid var(--dsw-alias-border-l1)}
.kb-drawer--scan{width:min(600px,96%)}
.kb-drawerHead{display:flex;align-items:center;gap:8px;height:48px;min-height:48px;padding:0 8px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.kb-drawerHeadMain{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.kb-drawerId{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);letter-spacing:.03em;flex:none}
.kb-drawerBody{display:flex;flex-direction:column;gap:16px;flex:1;min-height:0;overflow-y:auto;padding:14px}
.kb-drawerFoot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}
.kb-scanFoot{display:flex;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--kb-panel-surface);flex:none}
.kb-scanFootText{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary)}
.kb-section{display:flex;flex-direction:column;gap:8px}
.kb-sectionHead{display:flex;align-items:center;gap:6px}
.kb-sectionTitle{flex:1;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kb-sectionCount{font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.kb-titleInput{width:100%;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.35;padding:4px 6px;outline:none}
.kb-titleInput:hover{border-color:var(--dsw-alias-border-l1)}
.kb-titleInput:focus{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.kb-description{width:100%;min-height:64px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.5;padding:6px;outline:none;resize:vertical}
.kb-description:hover{border-color:var(--dsw-alias-border-l1)}
.kb-description:focus{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
/* KB-58 description read/Edit/Preview: the header row carries the EPIC label and the
   mode toggle; the read view is plain (no border) and the dependency's .kb-md
   typography is contained inside the drawer body. */
.kb-descHead{display:flex;align-items:center;gap:6px;min-width:0}
.kb-descModes{display:flex;align-items:center;gap:4px;margin-left:auto;flex:none}
.kb-btn.kb-descMode[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,var(--dsw-alias-bg-layer-1))}
.kb-descMode:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.kb-descRead{min-width:0;padding:0 6px}
.kb-descRead .kb-md{min-width:0;max-width:100%}
.kb-descEmpty{padding:0 6px}
.kb-savedHint{display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--dsw-alias-state-success-primary);flex:none}
.kb-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.kb-fieldLabel{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kb-input,.kb-select{width:100%;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;outline:none}
.kb-input:focus,.kb-select:focus{border-color:var(--dsw-alias-border-l2)}
.kb-input::placeholder{color:var(--dsw-alias-label-secondary)}
.kb-input--invalid{border-color:var(--dsw-alias-state-error-primary)}
.kb-hint{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.kb-hint--error{color:var(--dsw-alias-state-error-primary)}
.kb-colButtons{display:flex;flex-wrap:wrap;gap:4px}
.kb-colBtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.kb-colBtn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.kb-colBtn--active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:transparent}
.kb-colBtn:disabled{opacity:.4}
.kb-ownerRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kb-ownerName{display:flex;align-items:center;gap:6px;min-width:0;font-size:12px;font-weight:500}
.kb-ownerSub{font-size:10px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.kb-blockRow{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-blockHead{display:flex;align-items:center;gap:6px}
.kb-blockReasonText{font-size:11.5px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.kb-checkItem{display:flex;align-items:center;gap:6px;padding:2px 0}
.kb-checkbox{appearance:none;-webkit-appearance:none;position:relative;width:14px;height:14px;margin:0;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.kb-checkbox:checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.kb-checkbox:checked::after{content:"";position:absolute;left:3px;top:0;width:4px;height:8px;border:2px solid var(--dsw-alias-bg-base);border-top:0;border-left:0;transform:rotate(45deg)}
.kb-checkbox:disabled{opacity:.5}
.kb-checkText{flex:1;min-width:0;font-size:12px;line-height:1.4;overflow-wrap:anywhere}
.kb-checkText--done{color:var(--dsw-alias-label-secondary);text-decoration:line-through}
.kb-inlineAdd{display:flex;align-items:center;gap:6px}
.kb-inlineAdd .kb-input{flex:1;min-width:0}
.kb-comment{display:flex;flex-direction:column;gap:3px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-commentHead{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--dsw-alias-label-secondary)}
.kb-commentAuthor{font-size:11px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%}
.kb-commentText{font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}
.kb-activityItem{display:flex;align-items:flex-start;gap:6px;padding:3px 0;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.kb-activityBullet{width:4px;height:4px;margin-top:6px;border-radius:999px;background:var(--dsw-alias-border-l2);flex:none}
.kb-activityText{flex:1;min-width:0;overflow-wrap:anywhere}
.kb-activityText b{color:var(--dsw-alias-label-primary);font-weight:600}
.kb-activityTime{flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.kb-emptyLine{font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 0}
.kb-dialog{display:flex;flex-direction:column;width:min(540px,100%);max-height:min(700px,100%);background:var(--kb-panel-surface);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden}
.kb-dialogHead{display:flex;align-items:center;gap:8px;height:48px;min-height:48px;padding:0 8px 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.kb-dialogTitle{flex:1;font-size:14px;font-weight:600}
.kb-dialogBody{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0;overflow-y:auto;padding:14px}
.kb-dialogFoot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}
.kb-formGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.kb-formGrid .kb-select{width:100%}
.kb-vision{max-height:140px;overflow-y:auto;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-vision:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
/* KB-61: the vision keeps its subdued body colour inside the shared .kb-md surface. */
.kb-vision .kb-md{color:var(--dsw-alias-label-secondary)}
.kb-docRow{display:flex;flex-direction:column;gap:1px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.kb-docRow:last-child{border-bottom:0}
.kb-docTitle{font-size:12px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kb-docPath{font-size:10px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-mrRow{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:11.5px;min-width:0}
.kb-mrTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-link{color:var(--dsw-alias-brand-primary);text-decoration:none;flex:none}
.kb-link:hover{text-decoration:underline}
.kb-convRow{display:flex;align-items:center;gap:6px;padding:4px 0;font-size:11.5px;min-width:0}
.kb-convTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-convSub{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.kb-candidate{display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-candidateMain{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.kb-candidateTitle{display:block;font-size:12px;font-weight:500;line-height:1.4;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-candidateDesc{display:block;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);max-height:calc(3 * 1.4 * 11px);overflow:hidden;overflow-wrap:anywhere}
/* KB-61: candidate descriptions are Markdown, so the clamp lives on the wrapper
   (a block, exactly 3 line-heights tall). Paragraph/list margins are zeroed so
   the clamp lands on a line boundary instead of cutting through glyphs. */
.kb-candidateDesc .kb-md{font-size:11px;line-height:1.4;color:inherit}
.kb-candidateDesc .kb-md p{margin:0}
.kb-candidateDesc .kb-md ul,.kb-candidateDesc .kb-md ol{margin:0;padding-left:16px}
.kb-candidateDesc .kb-md li{margin:0}
.kb-candidateDesc .kb-md h3,.kb-candidateDesc .kb-md h4,.kb-candidateDesc .kb-md h5,.kb-candidateDesc .kb-md h6{margin:0;font-size:11px;line-height:1.4}
.kb-candidateMeta{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.kb-scanCandidateList{display:flex;flex-direction:column;gap:6px}
.kb-center{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;flex:1;min-height:0;padding:32px;text-align:center;overflow-y:auto}
.kb-centerIcon{display:inline-flex;color:var(--dsw-alias-label-secondary);opacity:.85}
.kb-centerTitle{font-size:14px;font-weight:600}
.kb-centerBody{max-width:440px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.kb-centerActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:2px}
.kb-centerLoading{display:inline-flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.kb-errorText{max-width:520px;max-height:120px;overflow-y:auto;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-error-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.45;text-align:left;overflow-wrap:anywhere}
.kb-spinner{display:inline-block;width:14px;height:14px;flex:none;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:999px;animation:kb-spin .7s linear infinite}
.kb-toasts{position:absolute;left:50%;bottom:16px;z-index:50;display:flex;flex-direction:column;align-items:center;gap:6px;width:min(440px,90%);transform:translateX(-50%);pointer-events:none}
.kb-toast{display:flex;align-items:center;gap:8px;max-width:100%;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--kb-panel-surface);color:var(--dsw-alias-label-primary);font-size:12px;box-shadow:var(--kb-panel-shadow);pointer-events:auto;animation:kb-toast-in .16s ease}
.kb-toast--ok{border-left-color:var(--dsw-alias-state-success-primary)}
.kb-toast--ok .kb-toastIcon{color:var(--dsw-alias-state-success-primary)}
.kb-toast--error{border-left-color:var(--dsw-alias-state-error-primary)}
.kb-toast--error .kb-toastIcon{color:var(--dsw-alias-state-error-primary)}
.kb-toast--warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.kb-toast--warn .kb-toastIcon{color:var(--dsw-alias-state-warn-primary)}
.kb-toastIcon{display:inline-flex;flex:none}
.kb-toastText{min-width:0;overflow-wrap:anywhere}
@keyframes kb-spin{to{transform:rotate(360deg)}}
@keyframes kb-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes kb-fade{from{opacity:0}to{opacity:1}}
@keyframes kb-toast-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
/* Container-aware layout contract (breakpoints are the Kanban panel width, not the viewport,
   so collapsing/expanding the DSH sidebar reflows without a window resize). */
@container kb (max-width:1180px){.kb-rail{position:absolute;top:0;right:0;bottom:0;z-index:25;width:336px;min-width:0;border-left:1px solid var(--dsw-alias-border-l2);box-shadow:var(--kb-rail-shadow)}}
@container kb (max-width:1200px){.kb-title{display:none}.kb-search{width:150px}}
@container kb (max-width:1040px){.kb-search{width:132px}.kb-btnLabel{display:none}}
@container kb (max-width:900px){.kb-search{display:none}.kb-searchToggle{display:inline-flex}.kb-search.kb-search--overlay{display:flex}.kb-projectBtn{max-width:170px}.kb-stats{height:32px;min-height:32px}.kb-header{gap:6px}}
/* Concrete lane width (not the panel): keep the column header legible at the
   176px lane floor by tightening the header chrome only inside narrow lanes. */
@container kb-lane (max-width:200px){.kb-colHead{gap:3px;padding:0 4px 0 8px}.kb-colTitle{font-size:10px;letter-spacing:.02em}.kb-colCount{min-width:15px;height:16px;padding:0 4px;font-size:9.5px}.kb-colWip{height:15px;line-height:13px;padding:0 4px;font-size:9.5px}.kb-colAdd{width:20px;height:20px}}
@container kb (max-width:660px){.kb-overlay--center{padding:0}.kb-dialog{width:100%;height:100%;max-height:100%;border-radius:0;border:0}.kb-drawer{width:100%}.kb-drawer--scan{width:100%}.kb-header{padding:0 8px;gap:4px}.kb-headerRight{gap:3px}.kb-formGrid{grid-template-columns:1fr}.kb-board{padding:10px 8px;gap:8px}}.kb-select--compact{height:24px;width:auto;max-width:120px;padding:0 4px;font-size:11px;flex:none}.kb-filtersFoot{display:flex;justify-content:flex-end}
.kb-execChip{display:inline-flex;align-items:center;gap:4px;height:18px;max-width:100%;min-width:0;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:10px;font-weight:600;white-space:nowrap;flex:0 1 auto;overflow:hidden;color:var(--dsw-alias-label-secondary);background:transparent}
.kb-execChip--running{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.kb-execChip--blocked{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.kb-execChip--done{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.kb-execChip--idle,.kb-execChip--paused{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.kb-execChip--failed,.kb-execChip--cancelled{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.kb-col--blocked{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 5%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,var(--dsw-alias-border-l1))}
.kb-dot--blocked{background:var(--dsw-alias-state-warn-primary)}
.kb-cardRun{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);flex:none}
.kb-cardRun:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.kb-execPanel{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}
.kb-execPanelHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kb-execPanelTitle{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);flex:1;min-width:0}
.kb-execRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kb-execHint{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.kb-execReport{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary);white-space:pre-wrap;max-height:120px;overflow:auto;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.kb-waitBox{display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent)}
.kb-waitQ{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--dsw-alias-label-primary)}
.kb-waitQ .kb-input{height:28px;font-size:11.5px}
.kb-waitNeed{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-primary)}
.kb-waitNeed input{accent-color:var(--dsw-alias-brand-primary)}
.kb-waitKind{font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-state-warn-primary);flex:none}
/* KB-13 team roster, member editor, drafts, role playbooks. Scoped kb- classes only;
   colors come from the documented theme tokens. The rail stays 336px and never
   overflows horizontally: every row is min-width:0 with ellipsized text. */
.kb-railBody{overflow-x:hidden}
.kb-sectionActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-sectionActions .kb-btn{min-width:0}
.kb-rosterRow{display:flex;flex-direction:column;gap:5px;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-rosterRow--paused{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 6%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,var(--dsw-alias-border-l1))}
.kb-rosterTop{display:flex;align-items:flex-start;gap:6px;min-width:0}
.kb-rosterInfo{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0}
.kb-nameInput{width:100%;min-width:0;margin:0 -3px;padding:1px 3px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:1.3;outline:none}
.kb-nameInput:hover:not(:disabled){border-color:var(--dsw-alias-border-l1)}
.kb-nameInput:focus{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.kb-nameInput:disabled{opacity:.6}
.kb-rosterTitle{font-size:10.5px;line-height:1.35;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.kb-rosterMeta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.kb-rosterMetaText{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;font-variant-numeric:tabular-nums}
.kb-rosterFoot{display:flex;align-items:center;gap:6px;min-width:0}
.kb-rosterActions{display:flex;align-items:center;gap:2px;flex:none}
.kb-statusDot--working{background:var(--dsw-alias-state-success-primary);animation:kb-pulse 1.8s ease-in-out infinite}
.kb-statusDot--offline{background:var(--dsw-alias-border-l2)}
.kb-draftsList{display:flex;flex-direction:column;gap:6px}
.kb-draftRow{display:flex;flex-direction:column;gap:5px;min-width:0;padding:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-draftTop{display:flex;align-items:center;gap:6px;min-width:0}
.kb-draftDesc{flex:1 1 auto;min-width:0;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-draftStatus{display:inline-flex;align-items:center;gap:4px;font-size:10px;color:var(--dsw-alias-label-secondary);flex:none;white-space:nowrap}
.kb-draftStatus--drafting{color:var(--dsw-alias-brand-primary)}
.kb-draftStatus--failed{color:var(--dsw-alias-state-error-primary)}
.kb-draftStatus--cancelled{color:var(--dsw-alias-label-secondary)}
.kb-draftActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-aiForm{display:flex;flex-direction:column;gap:6px;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-aiTextarea{width:100%;min-height:52px;max-height:120px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11.5px;line-height:1.45;resize:vertical;outline:none}
.kb-aiTextarea:focus{border-color:var(--dsw-alias-border-l2)}
.kb-aiRow{display:flex;align-items:center;gap:6px;min-width:0}
.kb-aiRole{min-width:0;flex:1 1 auto;height:24px;padding:0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-size:11px}
.kb-hint--warn{color:var(--dsw-alias-state-warn-primary)}
.kb-drawer--member{width:min(560px,96%)}
.kb-drawer--roles{width:min(720px,96%)}
.kb-drawer--thoughts{width:min(560px,96%)}
.kb-thoughtsHeadCount{font-size:10.5px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none}
.kb-thoughtsList{display:flex;flex-direction:column;gap:8px}
.kb-thoughtRow{display:flex;flex-direction:column;gap:6px;min-width:0;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.kb-thoughtTop{display:flex;align-items:center;gap:6px;min-width:0}
.kb-thoughtStatus{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:10px;font-weight:600;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.kb-thoughtStatus--working{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}
.kb-thoughtStatus--done{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.kb-thoughtStatus--failed{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.kb-thoughtStatus--recorded{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.kb-thoughtStatus--queued{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.kb-thoughtStatus--cancelled{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);text-decoration:line-through}
.kb-thoughtsHeadCount--queued{color:var(--dsw-alias-state-warn-primary)}
.kb-thoughtAge{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;font-variant-numeric:tabular-nums}
.kb-thoughtText{font-size:12.5px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.kb-thoughtText--expanded{display:block;white-space:normal;-webkit-line-clamp:unset;overflow:visible}
.kb-thoughtExpand{align-self:flex-start;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-size:11px;cursor:pointer}
.kb-thoughtExpand:hover{text-decoration:underline}
.kb-thoughtExpand:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:2px}
.kb-thoughtMeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-thoughtChip{display:inline-flex;align-items:center;height:20px;max-width:100%;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-thoughtChip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.kb-thoughtError{font-size:11px;line-height:1.45;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.kb-thoughtEmpty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 16px;text-align:center;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.kb-thoughtEmptyIcon{display:inline-flex;color:var(--dsw-alias-label-secondary);opacity:.8}
.kb-thoughtCounter{align-self:flex-end;font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.kb-thoughtVoice{display:flex;align-items:center;gap:7px;min-width:0;flex-wrap:wrap}
.kb-thoughtVoiceToggle{flex:none}
.kb-thoughtVoiceToggle[aria-pressed="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
.kb-thoughtVoiceToggle[aria-pressed="true"]:hover:not(:disabled){background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);opacity:.9}
.kb-thoughtVoiceToggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.kb-thoughtVoiceDot{width:7px;height:7px;flex:none;border-radius:999px;background:var(--dsw-alias-brand-primary);animation:kb-pulse 1.2s ease-in-out infinite}
.kb-thoughtVoiceState{min-width:0;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-thoughtVoiceState--error{color:var(--dsw-alias-state-error-primary)}
.kb-srOnly{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
@media (prefers-reduced-motion:reduce){.kb-thoughtVoiceDot{animation:none}}
.kb-thoughtHint{font-size:10.5px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.kb-thoughtDetail{display:flex;flex-direction:column;gap:5px;min-width:0;padding-top:2px;border-top:1px solid var(--dsw-alias-border-l1)}
.kb-thoughtDetailHead{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--dsw-alias-label-secondary)}
.kb-thoughtTimeline{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none;min-width:0}
.kb-thoughtTimelineItem{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-primary)}
.kb-thoughtTimelineAt{flex:none;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kb-thoughtTimelineText{min-width:0;overflow-wrap:anywhere}
.kb-thoughtControls{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-thoughtRetryOf{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0}
.kb-thoughtEditForm{display:flex;flex-direction:column;gap:6px;min-width:0}
.kb-thoughtEditFoot{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.kb-ticketThoughtRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-ticketThoughtLabel{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}
.kb-ticketThoughtDeleted{font-size:11px;font-style:italic;color:var(--dsw-alias-label-secondary)}
@container kb (max-width:660px){.kb-drawer--thoughts{width:100%}}
.kb-formField{display:flex;flex-direction:column;gap:4px;min-width:0}
.kb-textarea{width:100%;min-height:96px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.5;resize:vertical;outline:none}
.kb-textarea:focus{border-color:var(--dsw-alias-border-l2)}
.kb-textarea--invalid{border-color:var(--dsw-alias-state-error-primary)}
.kb-fieldFoot{display:flex;align-items:center;gap:8px;justify-content:space-between;min-width:0}
.kb-wordCount{font-size:10px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:none}
.kb-promptBox{display:flex;flex-direction:column;gap:6px;min-width:0}
.kb-promptHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-promptTitle{font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);flex:1;min-width:0}
.kb-promptPre{max-height:240px;min-height:64px;margin:0;overflow:auto;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.kb-toggleRow{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-toggleText{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.kb-toggleTitle{font-size:12px;font-weight:600}
.kb-toggleHint{font-size:10.5px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.kb-busyBox{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,var(--dsw-alias-border-l1));border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
.kb-rolesBody{display:flex;flex:1;min-height:0;overflow:hidden}
.kb-rolesList{display:flex;flex-direction:column;gap:2px;width:208px;min-width:0;flex:none;padding:10px 8px;border-right:1px solid var(--dsw-alias-border-l1);overflow-y:auto}
.kb-roleBtn{display:flex;flex-direction:column;gap:1px;width:100%;min-width:0;text-align:left;padding:6px 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:11.5px}
.kb-roleBtn:hover{background:var(--dsw-alias-bg-layer-2)}
.kb-roleBtn--active{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:transparent}
.kb-roleBtnName{font-weight:600;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-roleBtnSub{font-size:10px;line-height:1.35;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-rolesDetail{display:flex;flex-direction:column;gap:14px;flex:1;min-width:0;min-height:0;overflow-y:auto;padding:14px}
.kb-roleHead{display:flex;flex-direction:column;gap:4px;min-width:0}
.kb-roleName{font-size:15px;font-weight:600}
.kb-roleDesc{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-roleBlock{display:flex;flex-direction:column;gap:6px;min-width:0}
.kb-roleBlockTitle{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kb-roleText{font-size:12px;line-height:1.55;overflow-wrap:anywhere}
.kb-roleList{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:3px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kb-roleStep{display:flex;flex-direction:column;gap:3px;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-roleStepHead{display:flex;align-items:baseline;gap:6px;min-width:0}
.kb-roleStepNum{font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.kb-roleStepTitle{font-size:12px;font-weight:600;min-width:0;overflow-wrap:anywhere}
.kb-roleStepDetail{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-roleItems{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.kb-roleGate{display:flex;align-items:flex-start;gap:5px;font-size:11px;line-height:1.45;color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere}
.kb-roleDodItem{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:1.45;overflow-wrap:anywhere}
.kb-roleDodCheck{display:inline-flex;flex:none;margin-top:1px;color:var(--dsw-alias-state-success-primary)}
.kb-roleEmpty{padding:10px 2px;font-size:11px;color:var(--dsw-alias-label-secondary)}
@container kb (max-width:660px){.kb-drawer--member{width:100%}.kb-drawer--roles{width:100%}.kb-rolesBody{flex-direction:column}.kb-rolesList{width:100%;flex-direction:row;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.kb-roleBtn{width:auto;max-width:180px;flex:none}}
/* KB-76 autopilot control surface. Theme tokens only; the popover becomes a
   full-height panel at the 660px container breakpoint so nothing clips or
   overlaps the board header controls. */
.kb-autopilotWrap{position:relative;display:flex;min-width:0;flex:none}
.kb-apPopover{position:absolute;top:34px;right:0;z-index:45;display:flex;flex-direction:column;gap:10px;width:min(372px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 120px));overflow-y:auto;padding:12px;background:var(--kb-panel-surface);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:var(--kb-panel-shadow);--kb-ap-ok:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-label-primary));--kb-ap-warn:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 50%,var(--dsw-alias-label-primary));--kb-ap-err:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-label-primary))}
.kb-apHead{display:flex;align-items:center;gap:8px;min-width:0}
.kb-apTitle{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-apState{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:10px;font-weight:600;white-space:nowrap;flex:none;color:var(--dsw-alias-label-secondary)}
.kb-apState--on{color:var(--kb-ap-ok);border-color:currentColor}
.kb-apState--off{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.kb-apState--paused{color:var(--kb-ap-warn);border-color:currentColor}
.kb-apState--unavailable{color:var(--kb-ap-err);border-color:currentColor}
.kb-apNote{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-apNote--warn{color:var(--kb-ap-warn)}
.kb-apSwitch{display:flex;align-items:center;gap:8px;width:100%;min-width:0;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
.kb-apSwitch:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.kb-apSwitch:disabled{opacity:.55}
.kb-apSwitchTrack{position:relative;display:inline-flex;align-items:center;width:30px;height:18px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);flex:none;transition:background .12s ease,border-color .12s ease}
.kb-apSwitchKnob{position:absolute;left:2px;width:12px;height:12px;border-radius:999px;background:var(--dsw-alias-label-secondary);transition:transform .12s ease,background .12s ease}
.kb-apSwitch[aria-pressed="true"] .kb-apSwitchTrack{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.kb-apSwitch[aria-pressed="true"] .kb-apSwitchKnob{transform:translateX(12px);background:var(--dsw-alias-bg-base)}
.kb-apSwitchText{flex:1;min-width:0;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-apSwitchState{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none;white-space:nowrap}
.kb-apPhase1{display:flex;flex-direction:column;gap:5px;padding:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1));border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
.kb-apPhase1Title{font-size:11.5px;font-weight:600;color:var(--dsw-alias-brand-primary)}
.kb-apPhase1Body{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kb-apFields{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0}
.kb-apField{display:flex;flex-direction:column;gap:3px;min-width:0}
.kb-apFieldLabel{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-apFieldCaps{grid-column:1 / -1;min-width:0}
.kb-apCapsGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;min-width:0}
.kb-apCapsGrid .kb-apField{min-width:0}
.kb-apSelect{width:100%;min-width:0;height:28px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;outline:none}
.kb-apSelect:focus{border-color:var(--dsw-alias-border-l2)}
.kb-apSelect:disabled{opacity:.55}
.kb-apBudget{display:flex;flex-direction:column;gap:2px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.kb-apBudgetTitle{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kb-apBudgetRow{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kb-apError{display:flex;align-items:flex-start;gap:6px;padding:8px 9px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--kb-ap-err);font-size:11px;line-height:1.45}
.kb-apErrorText{flex:1;min-width:0;overflow-wrap:anywhere}
.kb-apErrorCode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}
.kb-apErrorDismiss{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:5px;background:transparent;color:currentColor;flex:none}
.kb-apErrorDismiss:hover{background:var(--dsw-alias-bg-layer-2)}
.kb-apActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-apActions .kb-btn{min-width:0}
.kb-apSaving{font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.kb-apPreview{display:flex;flex-direction:column;gap:6px;min-width:0}
.kb-apPreviewHead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-apPreviewTitle{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kb-apPreviewCount{font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.kb-apEmpty{padding:8px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-apEmptyTitle{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:2px}
.kb-apList{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.kb-apRow{display:flex;flex-direction:column;gap:2px;min-width:0;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.kb-apRow--dispatch{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1))}
.kb-apRowTop{display:flex;align-items:center;gap:5px;min-width:0}
.kb-apRowIndex{font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.kb-apRowId{font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.kb-apRowTitle{font-size:11.5px;font-weight:500;min-width:0;flex:1;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.kb-apRowMeta{display:flex;align-items:center;gap:4px;row-gap:2px;flex-wrap:wrap;min-width:0;font-size:10px;color:var(--dsw-alias-label-secondary)}
.kb-apRowReason{font-size:11px;line-height:1.4;overflow-wrap:anywhere}
.kb-apRow--dispatch .kb-apRowReason{color:var(--dsw-alias-label-primary);font-weight:500}
.kb-apRowDetail{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
/* KB-77 observability: countdown, pulse feed, deduplicated alerts. Text carries
   every state; colour is reinforcement only. */
.kb-apCountdown{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:10px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
.kb-apCountdownLabel{font-size:9.5px;letter-spacing:.03em;text-transform:uppercase}
.kb-apCountdownValue{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.kb-apCountdown--off .kb-apCountdownValue,.kb-apCountdown--paused .kb-apCountdownValue{color:var(--kb-ap-warn);font-weight:500;text-transform:none}
.kb-apObservability{display:flex;flex-direction:column;gap:8px;min-width:0}
.kb-apAlerts{display:flex;flex-direction:column;gap:6px;min-width:0}
.kb-apAlert{display:flex;flex-direction:column;gap:4px;min-width:0;padding:8px 9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-border-l1));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.kb-apAlertTop{display:flex;align-items:center;gap:5px;min-width:0;color:var(--kb-ap-warn)}
.kb-apAlertTitle{flex:1;min-width:0;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--kb-ap-warn)}
.kb-apAlertTime{font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.kb-apAlertText{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kb-apAlertActions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-apAlertTicket{display:inline-flex;align-items:center;gap:3px;height:22px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums}
.kb-apAlertTicket:hover{border-color:var(--dsw-alias-border-l2)}
.kb-apAlertAck{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10.5px}
.kb-apAlertAck:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kb-apAlertTicket:focus-visible,.kb-apAlertAck:focus-visible,.kb-apPulseHead:focus-visible,.kb-apFeedAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.kb-apFeed{display:flex;flex-direction:column;gap:6px;min-width:0}
.kb-apFeedHead{display:flex;align-items:center;gap:6px;min-width:0}
.kb-apFeedTitle{flex:1;min-width:0;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-apFeedCount{font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.kb-apFeedNote{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-apFeedEmpty{min-height:66px;padding:9px;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;display:flex;flex-direction:column;gap:5px;align-items:flex-start}
.kb-apFeedEmptyTitle{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kb-apFeedEmptyBody{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-apPulseList{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none;min-height:66px}
.kb-apPulse{display:flex;flex-direction:column;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.kb-apPulse--error{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-border-l1))}
.kb-apPulseHead{display:flex;flex-direction:column;gap:3px;width:100%;min-width:0;padding:6px 8px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
.kb-apPulseHead:hover{background:var(--dsw-alias-bg-layer-2)}
.kb-apPulseTop{display:flex;align-items:center;gap:5px;min-width:0;flex-wrap:wrap}
.kb-apTrigger{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);font-size:9.5px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);flex:none}
.kb-apTrigger--manual{color:var(--dsw-alias-brand-primary);border-color:currentColor}
.kb-apTrigger--resume{color:var(--kb-ap-ok);border-color:currentColor}
.kb-apTrigger--restart{color:var(--kb-ap-warn);border-color:currentColor}
.kb-apPulseTime{font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);flex:none}
.kb-apPulseError{display:inline-flex;align-items:center;gap:2px;font-size:9.5px;font-weight:600;color:var(--kb-ap-warn);flex:none}
.kb-apPulseMeta{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;font-size:10px;color:var(--dsw-alias-label-secondary)}
.kb-apPulseDetail{display:flex;flex-direction:column;gap:5px;min-width:0;padding:7px 8px 8px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.kb-apFeedSubTitle{font-size:9.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kb-apDecisionList,.kb-apExecutedList{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;min-width:0}
.kb-apDecision{display:flex;flex-direction:column;gap:2px;min-width:0;padding:5px 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}
.kb-apDecision--alert{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,var(--dsw-alias-border-l1))}
.kb-apDecisionTop{display:flex;align-items:center;gap:4px;min-width:0;flex-wrap:wrap}
.kb-apDecisionAction{display:inline-flex;align-items:center;height:15px;padding:0 4px;border-radius:4px;font-size:9px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;flex:none;border:1px solid currentColor;color:var(--dsw-alias-label-secondary)}
.kb-apDecisionAction--dispatch{color:var(--dsw-alias-brand-primary)}
.kb-apDecisionAction--skip{color:var(--dsw-alias-label-secondary)}
.kb-apDecisionId{font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);flex:none}
.kb-apDecisionTitle{font-size:10.5px;font-weight:500;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.kb-apDecisionMeta{display:flex;align-items:center;gap:3px;flex-wrap:wrap;min-width:0;font-size:9.5px;color:var(--dsw-alias-label-secondary)}
.kb-apDecisionReason{font-size:10.5px;line-height:1.4;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kb-apDecisionDetail,.kb-apDecisionNote{font-size:9.5px;line-height:1.4;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kb-apDecisionNote{color:var(--kb-ap-warn)}
.kb-apExecuted{display:flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0;font-size:10px;color:var(--dsw-alias-label-secondary)}
.kb-btn--alert{color:var(--dsw-alias-state-warn-primary)}
.kb-btnBadge--alert{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base)}
/* KB-77 lane admission chip: one stable bar under every workflow column head so
   a pulse arriving (or an execution ending) never shifts the board layout. */
.kb-colAdmissionBar{display:flex;align-items:center;gap:4px;min-height:19px;padding:0 10px 3px;min-width:0}
.kb-colAdmissionBar--none{min-height:19px}
.kb-colAdmission{display:inline-flex;align-items:center;gap:4px;min-width:0;height:16px;padding:0 5px;border-radius:4px;border:1px solid var(--dsw-alias-border-l1);font-size:9.5px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-colAdmissionState{font-weight:600}
.kb-colAdmissionCap{font-variant-numeric:tabular-nums;opacity:.85}
.kb-colAdmission--busy{color:var(--kb-ap-warn);border-color:currentColor}
.kb-colAdmission--idle{color:var(--kb-ap-ok);border-color:currentColor}
.kb-colAdmission--paused{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
/* KB-77 member autopilot state line in the Team rail. */
.kb-rosterAuto{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.kb-rosterAutoChip{display:inline-flex;align-items:center;gap:4px;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.kb-rosterAutoChip>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kb-rosterAuto--active .kb-rosterAutoChip{color:var(--kb-ap-ok)}
.kb-rosterAuto--paused .kb-rosterAutoChip{color:var(--kb-ap-warn)}
.kb-rosterAuto--no-work .kb-rosterAutoChip{color:var(--dsw-alias-label-secondary)}
@container kb (max-width:660px){.kb-apPopover{position:fixed;top:56px;left:0;right:0;bottom:0;width:auto;max-height:none;border-radius:0;border-left:0;border-right:0;border-bottom:0;padding:14px 12px}.kb-apFields{grid-template-columns:1fr}.kb-apHead{flex-wrap:wrap;row-gap:4px}.kb-apCountdown{margin-left:auto}}
/* kb-md */
.kb-md{display:flex;flex-direction:column;min-width:0;max-width:100%;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kb-md>:first-child{margin-top:0}
.kb-md>:last-child{margin-bottom:0}
.kb-md p{margin:0 0 8px}
.kb-md h3,.kb-md h4,.kb-md h5,.kb-md h6{margin:14px 0 6px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.kb-md h3{font-size:15px}
.kb-md h4{font-size:13.5px}
.kb-md h5{font-size:12.5px}
.kb-md h6{font-size:11.5px}
.kb-md ul,.kb-md ol{margin:0 0 8px;padding-left:20px}
.kb-md li{margin:2px 0}
.kb-md li>ul,.kb-md li>ol{margin:2px 0;padding-left:18px}
.kb-md strong{font-weight:600}
.kb-md em{font-style:italic}
.kb-md del{text-decoration:line-through;color:var(--dsw-alias-label-secondary)}
.kb-md code{padding:1px 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.kb-md pre{max-height:240px;margin:0 0 10px;padding:8px 10px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);white-space:pre;overflow-wrap:normal}
.kb-md pre code{padding:0;border-width:0;border-radius:0;background:var(--dsw-alias-bg-layer-1);font-size:11px;line-height:1.5}
.kb-md pre:focus-visible,.kb-md-tableWrap:focus-visible,.kb-md a:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:2px}
.kb-md blockquote{margin:0 0 10px;padding:6px 10px;border-left:3px solid var(--dsw-alias-border-l2);border-radius:0 6px 6px 0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.kb-md hr{margin:12px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.kb-md a{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px}
.kb-md-linkIcon{margin-left:3px;vertical-align:-2px;flex:none;color:var(--dsw-alias-label-secondary)}
.kb-md input[type="checkbox"]{margin:0 4px 0 0;vertical-align:-2px;pointer-events:none;accent-color:var(--dsw-alias-brand-primary)}
.kb-md-tableWrap{max-width:100%;margin:0 0 10px;overflow-x:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}
.kb-md table{min-width:100%;border-collapse:collapse;font-size:11.5px}
.kb-md th,.kb-md td{min-width:64px;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;vertical-align:top}
.kb-md th{background:var(--dsw-alias-bg-layer-1);font-weight:600;white-space:nowrap}
.kb-md th[data-align="center"],.kb-md td[data-align="center"]{text-align:center}
.kb-md th[data-align="right"],.kb-md td[data-align="right"]{text-align:right}
/* /kb-md */
/* KB-59: the shared .kb-md inside the drawer's agent-written surfaces (comment body,
   .kb-execReport, .kb-waitBox). Each wrapper keeps its own chrome — the comment
   block, the 120px report scroller, the wait box — so only the type scale is
   tailored to the compact surface, and the wait box inherits its existing colour
   (grey hint for the block reason, primary label for questions and needs). */
.kb-commentText .kb-md{font-size:12px;line-height:1.45}
.kb-execReport .kb-md{font-size:11.5px;line-height:1.5}
.kb-waitBox .kb-md{font-size:11.5px;line-height:1.45;color:inherit}
.kb-waitNeed .kb-md{flex:1;min-width:0}
`

		// ------------------------------------------------------------------
		// Icons + primitives
		// ------------------------------------------------------------------

		function Svg(props) {
			const size = typeof props.size === 'number' ? props.size : 16
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 16 16',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: props.strokeWidth || 1.5,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
					className: props.className,
				},
				props.children,
			)
		}

		function KanbanIcon(props) {
			const size = typeof props.size === 'number' ? props.size : 18
			const active = props.active === true
			return h(
				'svg',
				{
					width: size,
					height: size,
					viewBox: '0 0 18 18',
					fill: 'none',
					stroke: 'currentColor',
					strokeWidth: active ? 1.7 : 1.4,
					strokeLinecap: 'round',
					strokeLinejoin: 'round',
					'aria-hidden': 'true',
					focusable: 'false',
				},
				h('rect', { x: 2.1, y: 2.6, width: 3.6, height: 12.8, rx: 1.2 }),
				h('rect', { x: 7.2, y: 2.6, width: 3.6, height: 8.2, rx: 1.2 }),
				h('rect', { x: 12.3, y: 2.6, width: 3.6, height: 10.6, rx: 1.2 }),
			)
		}

		function IconPlus(props) {
			return h(Svg, props, h('path', { d: 'M8 3.2v9.6M3.2 8h9.6' }))
		}

		function IconSearch(props) {
			return h(Svg, props, h('circle', { cx: 7, cy: 7, r: 4.1 }), h('path', { d: 'M10.2 10.2 14 14' }))
		}

		function IconRefresh(props) {
			return h(Svg, props, h('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.7-3.85' }), h('path', { d: 'M13.4 2.4v2.9h-2.9' }))
		}

		function IconClose(props) {
			return h(Svg, props, h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }))
		}

		function IconChevronDown(props) {
			return h(Svg, props, h('path', { d: 'M4 6.3 8 10l4-3.7' }))
		}

		function IconPause(props) {
			return h(Svg, props, h('rect', { x: 4.6, y: 3.4, width: 2, height: 9.2, rx: 0.9 }), h('rect', { x: 9.4, y: 3.4, width: 2, height: 9.2, rx: 0.9 }))
		}

		function IconPlay(props) {
			return h(Svg, props, h('path', { d: 'M5.4 3.5 12.2 8l-6.8 4.5z', fill: 'currentColor', stroke: 'none' }))
		}

		function IconScan(props) {
			return h(
				Svg,
				props,
				h('path', { d: 'M2.6 5.4V4.2a1.2 1.2 0 0 1 1.2-1.2h1.3' }),
				h('path', { d: 'M10.9 3h1.3a1.2 1.2 0 0 1 1.2 1.2v1.2' }),
				h('path', { d: 'M13.4 10.6v1.2a1.2 1.2 0 0 1-1.2 1.2h-1.3' }),
				h('path', { d: 'M5.1 13H3.8a1.2 1.2 0 0 1-1.2-1.2v-1.2' }),
				h('circle', { cx: 8, cy: 8, r: 1.9 }),
			)
		}

		function IconMic(props) {
			return h(
				Svg,
				props,
				h('rect', { x: 5.7, y: 2.4, width: 4.6, height: 7.1, rx: 2.3 }),
				h('path', { d: 'M3.5 7.5a4.5 4.5 0 0 0 9 0' }),
				h('path', { d: 'M8 12.3v2' }),
				h('path', { d: 'M5.9 14.3h4.2' }),
			)
		}

		function IconTeam(props) {
			return h(
				Svg,
				props,
				h('circle', { cx: 5.9, cy: 5.8, r: 2.1 }),
				h('path', { d: 'M2.5 13c.4-2.1 1.7-3.3 3.4-3.3s3 1.2 3.4 3.3' }),
				h('path', { d: 'M10.4 4.1a2 2 0 0 1 0 3.5' }),
				h('path', { d: 'M11.4 9.8c1 .5 1.6 1.6 1.8 3.2' }),
			)
		}

		function IconExternal(props) {
			return h(
				Svg,
				props,
				h('path', { d: 'M6.6 3.4H4.1a1.1 1.1 0 0 0-1.1 1.1v7.4a1.1 1.1 0 0 0 1.1 1.1h7.4a1.1 1.1 0 0 0 1.1-1.1V9.4' }),
				h('path', { d: 'M9.6 2.6h3.8v3.8' }),
				h('path', { d: 'M13.4 2.6 8.1 7.9' }),
			)
		}

		function IconTrash(props) {
			return h(
				Svg,
				props,
				h('path', { d: 'M3.2 4.4h9.6' }),
				h('path', { d: 'M6.2 2.7h3.6' }),
				h('path', { d: 'M4.8 4.4l.5 8.1a1 1 0 0 0 1 .95h3.4a1 1 0 0 0 1-.95l.5-8.1' }),
			)
		}

		function IconCheck(props) {
			return h(Svg, props, h('path', { d: 'M3.1 8.4 6.3 11.6 13 4.4' }))
		}

		function IconWarning(props) {
			return h(Svg, props, h('path', { d: 'M8 2.6 14 13.2H2z' }), h('path', { d: 'M8 6.2v3.1' }), h('path', { d: 'M8 11.4h.01' }))
		}

		function IconComment(props) {
			return h(Svg, props, h('path', { d: 'M3 3.6h10v6.5H7.4L4.4 12.9v-2.8H3z' }))
		}

		function IconList(props) {
			return h(
				Svg,
				props,
				h('rect', { x: 2.6, y: 3.3, width: 1.7, height: 1.7, rx: 0.4 }),
				h('rect', { x: 2.6, y: 7.15, width: 1.7, height: 1.7, rx: 0.4 }),
				h('rect', { x: 2.6, y: 11, width: 1.7, height: 1.7, rx: 0.4 }),
				h('path', { d: 'M6.4 4.15h7M6.4 8h7M6.4 11.85h7' }),
			)
		}

		function IconFilter(props) {
			return h(Svg, props, h('path', { d: 'M2.6 4h10.8l-4.2 4.9v4.2L6.8 14V8.9z' }))
		}

		function IconTicket(props) {
			return h(
				Svg,
				props,
				h('path', { d: 'M2.6 4.2a1 1 0 0 1 1-1h8.8a1 1 0 0 1 1 1v2.1a2 2 0 0 0 0 3.4v2.1a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V9.7a2 2 0 0 0 0-3.4z' }),
			)
		}

		function IconEdit(props) {
			return h(
				Svg,
				props,
				h('path', { d: 'M3 13l.5-2.6 7.4-7.4a1.5 1.5 0 0 1 2.1 2.1l-7.4 7.4z' }),
				h('path', { d: 'M9.6 4.3l2.1 2.1' }),
			)
		}

		function IconBook(props) {
			return h(
				Svg,
				props,
				h('path', { d: 'M8 4.1C6.9 3.3 5.3 3 3 3v9.3c2.3 0 3.9.3 5 1.1 1.1-.8 2.7-1.1 5-1.1V3c-2.3 0-3.9.3-5 1.1z' }),
				h('path', { d: 'M8 4.1v9.3' }),
			)
		}

		function IconSparkles(props) {
			return h(
				Svg,
				props,
				h('path', { d: 'M6.4 2.8l.9 2.4 2.4.9-2.4.9-.9 2.4-.9-2.4-2.4-.9 2.4-.9z' }),
				h('path', { d: 'M11.6 8.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z' }),
			)
		}

		/** KB-76 autopilot entry icon (a pulse/bolt). */
		function IconBolt(props) {
			return h(Svg, props, h('path', { d: 'M9 1.8 3.6 9h3.3l-.9 5.2L11.8 7H8.2z' }))
		}

		function Spinner() {
			return h('span', { className: 'kb-spinner', 'aria-hidden': 'true' })
		}

		function Button(props) {
			return h(
				'button',
				{
					ref: props.buttonRef,
					type: props.type || 'button',
					className: classNames(
						'kb-btn',
						props.variant ? 'kb-btn--' + props.variant : null,
						props.size ? 'kb-btn--' + props.size : null,
						props.className,
					),
					disabled: props.disabled === true,
					title: props.title,
					'aria-label': props['aria-label'] || props.title,
					'aria-pressed': props.pressed === undefined ? undefined : props.pressed === true,
					'aria-expanded': props['aria-expanded'],
					'aria-haspopup': props['aria-haspopup'],
					'aria-busy': props['aria-busy'],
					autoFocus: props.autoFocus === true ? true : undefined,
					onClick: props.onClick,
				},
				props.icon ? h('span', { className: 'kb-btnIcon' }, props.icon) : null,
				props.children,
			)
		}

		function Avatar(props) {
			const name = safeString(props.name) || '?'
			return h(
				'span',
				{
					className: classNames('kb-avatar', props.lead === true && 'kb-avatar--lead', props.small === true && 'kb-avatar--sm'),
					title: name,
					'aria-hidden': 'true',
				},
				initialsOf(name),
			)
		}

		function StatusDot(props) {
			return h('span', { className: 'kb-statusDot kb-statusDot--' + safeString(props.status || 'idle'), 'aria-hidden': 'true' })
		}

		function SectionHead(props) {
			return h(
				'div',
				{ className: 'kb-sectionHead' },
				h('span', { className: 'kb-sectionTitle' }, props.title),
				props.count === undefined ? null : h('span', { className: 'kb-sectionCount' }, String(props.count)),
				props.extra || null,
			)
		}

		// ------------------------------------------------------------------
		// Hooks
		// ------------------------------------------------------------------

		function useToasts() {
			const [toasts, setToasts] = useState([])
			const seqRef = useRef(0)
			const notify = useCallback((kind, text) => {
				if (typeof text !== 'string' || !text) return
				seqRef.current += 1
				const item = { id: seqRef.current, kind: kind === 'error' || kind === 'warn' ? kind : 'ok', text }
				setToasts((previous) => {
					const next = previous.concat([item])
					return next.length > 3 ? next.slice(next.length - 3) : next
				})
			}, [])
			const dismiss = useCallback((id) => {
				setToasts((previous) => previous.filter((item) => item.id !== id))
			}, [])
			return { toasts, notify, dismiss }
		}

		function defaultSuccessText(action, value, payload, t) {
			const result = value && typeof value === 'object' ? value : {}
			if (action === 'submitThought') return t('thought.success')
			if (action === 'retryThought') return t('thought.retriedToast', { id: safeString(result.thought && result.thought.id) })
			if (action === 'cancelThought') return t('thought.cancelledToast')
			if (action === 'editThought') return t('thought.editedToast')
			if (action === 'deleteThought') return t('thought.deletedToast')
			if (action === 'createTicket' && result.ticket) return t('toast.created', { id: result.ticket.id })
			if (action === 'moveTicket') {
				const column = result.ticket && result.ticket.column ? result.ticket.column : payload && payload.column
				return t('toast.moved', { column: columnLabel(column, t) })
			}
			if (action === 'deleteTicket') return t('toast.deleted')
			if (action === 'assignTicket') return t('toast.assigned')
			if (action === 'comment') return t('toast.commented')
			if (action === 'checklistAdd' || action === 'checklistToggle' || action === 'checklistRemove') return t('toast.checklist')
			if (action === 'blockTicket') return payload && payload.blocked === true ? t('toast.blocked') : t('toast.unblocked')
			if (action === 'pauseBoard') return t('toast.boardPaused')
			if (action === 'resumeBoard') return t('toast.boardResumed')
			if (action === 'setAgentRole') return t('toast.roleUpdated')
			if (action === 'applyScan') {
				const created = safeNumber(result.created, 0)
				const skipped = safeNumber(result.skipped, 0)
				return t('toast.imported', { created, skipped })
			}
			if (action === 'pauseAgent' || action === 'resumeAgent') return ''
			if (action === 'runTicket') return t('execution.runStarted')
			if (action === 'resumeExecution') return t('execution.runResumed')
			if (action === 'cancelExecution') return t('execution.cancelledToast')
			return t('toast.updated')
		}

		function useSnapshot(workspaceId, t, notify) {
			const [snapshot, setSnapshot] = useState(null)
			const [phase, setPhase] = useState('loading')
			const [error, setError] = useState(null)
			const [pending, setPending] = useState({})
			const snapshotRef = useRef(null)
			const workspaceRef = useRef(workspaceId)
			workspaceRef.current = workspaceId
			const seqRef = useRef(0)

			const applyValue = useCallback((value) => {
				if (!value || typeof value !== 'object') return
				setSnapshot((previous) => {
					if (!previous) return previous
					let next = previous
					if (value.ticket && typeof value.ticket === 'object' && next.board && Array.isArray(next.board.tickets)) {
						const ticket = value.ticket
						const exists = next.board.tickets.some((item) => item && item.id === ticket.id)
						const tickets = exists
							? next.board.tickets.map((item) => (item && item.id === ticket.id ? ticket : item))
							: next.board.tickets.concat([ticket])
						next = { ...next, board: { ...next.board, tickets } }
					}
					if (value.board && typeof value.board === 'object') next = { ...next, board: value.board }
					if (Array.isArray(value.team)) next = { ...next, team: value.team }
					return next
				})
			}, [])

			const refresh = useCallback(async () => {
				seqRef.current += 1
				const seq = seqRef.current
				try {
					const payload = await postJson('kanban/state', { workspaceId: workspaceRef.current == null ? null : workspaceRef.current })
					if (seq !== seqRef.current) return { ok: true, stale: true }
					const value = payload.value && typeof payload.value === 'object' ? payload.value : null
					snapshotRef.current = value
					setSnapshot(value)
					setError(null)
					setPhase('ready')
					return { ok: true, value }
				} catch (failure) {
					if (seq !== seqRef.current) return { ok: false, stale: true, error: failure }
					setError(failure)
					setPhase(snapshotRef.current ? 'ready' : 'error')
					return { ok: false, error: failure }
				}
			}, [])

			const reset = useCallback(() => {
				seqRef.current += 1
				snapshotRef.current = null
				setSnapshot(null)
				setError(null)
				setPhase('loading')
			}, [])

			const act = useCallback(
				async (action, payload, options) => {
					const opts = options && typeof options === 'object' ? options : {}
					const key = typeof opts.key === 'string' && opts.key ? opts.key : action
					const target = workspaceRef.current || (snapshotRef.current && snapshotRef.current.workspaceId) || null
					if (!target) {
						notify('error', t('error.noWorkspace'))
						return { ok: false, error: new Error(t('error.noWorkspace')) }
					}
					setPending((previous) => {
						const next = { ...previous }
						next[key] = (next[key] || 0) + 1
						return next
					})
					try {
						const response = await postJson('kanban/action', { workspaceId: target, action, payload: payload || {} })
						applyValue(response.value)
						if (opts.quiet !== true) {
							const text =
								typeof opts.toastText === 'string' && opts.toastText
									? opts.toastText
									: defaultSuccessText(action, response.value, payload, t)
							if (text) notify('ok', text)
						}
						if (opts.refresh !== false) await refresh()
						return { ok: true, value: response.value, message: response.message }
					} catch (failure) {
						notify('error', (failure && failure.message) || t('error.unknown'))
						return { ok: false, error: failure }
					} finally {
						setPending((previous) => {
							const next = { ...previous }
							const count = (next[key] || 0) - 1
							if (count > 0) next[key] = count
							else delete next[key]
							return next
						})
					}
				},
				[applyValue, notify, refresh, t],
			)

			return { snapshot, phase, error, pending, refresh, reset, act }
		}

		function useEscape(open, onClose) {
			useEffect(() => {
				if (!open) return undefined
				const handler = (event) => {
					if (event.key !== 'Escape') return
					event.preventDefault()
					event.stopPropagation()
					onClose()
				}
				document.addEventListener('keydown', handler, true)
				return () => document.removeEventListener('keydown', handler, true)
			}, [open, onClose])
		}

		function useOutsideClick(open, ref, onClose) {
			useEffect(() => {
				if (!open) return undefined
				const handler = (event) => {
					const node = ref.current
					if (node && event.target instanceof Node && node.contains(event.target)) return
					onClose()
				}
				document.addEventListener('mousedown', handler)
				return () => document.removeEventListener('mousedown', handler)
			}, [open, ref, onClose])
		}

		function useFocusOnOpen(open, ref) {
			const previousRef = useRef(null)
			useEffect(() => {
				if (!open) return undefined
				if (typeof document !== 'undefined') previousRef.current = document.activeElement
				const timer = window.setTimeout(() => {
					const node = ref.current
					if (node && typeof node.focus === 'function') {
						try {
							node.focus()
						} catch (error) {
							// focus is best-effort
						}
					}
				}, 0)
				return () => {
					window.clearTimeout(timer)
					const previous = previousRef.current
					previousRef.current = null
					if (previous && typeof previous.focus === 'function') {
						try {
							previous.focus()
						} catch (error) {
							// restore is best-effort
						}
					}
				}
			}, [open, ref])
		}

		// Panel width via ResizeObserver: the Kanban panel is container-queried in CSS,
		// and the few layout decisions that build different DOM (the conditional Blocked
		// lane) read the same container width here instead of the viewport.
		function useElementWidth(ref) {
			const [width, setWidth] = useState(0)
			useEffect(() => {
				const node = ref && ref.current ? ref.current : null
				if (!node) return undefined
				const apply = (next) => {
					const value = Math.round(safeNumber(next, 0))
					setWidth((current) => (current === value ? current : value))
				}
				apply(node.clientWidth)
				if (typeof window === 'undefined' || typeof window.ResizeObserver !== 'function') return undefined
				const observer = new window.ResizeObserver((entries) => {
					const entry = entries && entries.length > 0 ? entries[0] : null
					apply(entry && entry.contentRect ? entry.contentRect.width : node.clientWidth)
				})
				observer.observe(node)
				return () => {
					observer.disconnect()
				}
			}, [ref])
			return width
		}

		// ------------------------------------------------------------------
		// Toasts
		// ------------------------------------------------------------------

		function ToastItem(props) {
			const { item, onDismiss } = props
			useEffect(() => {
				const timer = window.setTimeout(() => onDismiss(item.id), 4000)
				return () => window.clearTimeout(timer)
			}, [item.id, onDismiss])
			const icon = item.kind === 'ok' ? h(IconCheck, { size: 13 }) : h(IconWarning, { size: 13 })
			return h(
				'div',
				{ className: 'kb-toast kb-toast--' + item.kind, role: 'status' },
				h('span', { className: 'kb-toastIcon' }, icon),
				h('span', { className: 'kb-toastText' }, item.text),
			)
		}

		function Toasts(props) {
			const items = safeArray(props.toasts)
			if (items.length === 0) return null
			return h(
				'div',
				{ className: 'kb-toasts', 'aria-live': 'polite' },
				items.map((item) => h(ToastItem, { key: item.id, item, onDismiss: props.onDismiss })),
			)
		}

		// ------------------------------------------------------------------
		// Autopilot header entry + settings popover (KB-76)
		// ------------------------------------------------------------------
		//
		// One header entry opens the popover; the master toggle lives inside it so
		// the header stays uncrowded at narrow panel widths. The popover is the
		// single place for settings, budget read-out, dry-run preview, Pulse now and
		// inline host errors. Everything renders from the snapshot read model; the
		// optimistic values in `state.values` are rolled back by the reducer.

		function AutopilotEntryButton(props) {
			const { t, stateKey, open, onOpen, onClose, entryRef, alertCount } = props
			const stateText = t('autopilot.state.' + stateKey)
			const alerts = Math.max(0, safeNumber(alertCount, 0))
			const alertText = alerts > 0 ? t('autopilot.entryAlerts', { n: String(alerts) }) : ''
			const entryLabel = t('autopilot.entryState', { state: stateText }) + (alertText ? ' · ' + alertText : '')
			return h(
				Button,
				{
					variant: 'ghost',
					className: classNames('kb-autopilotEntry', open && 'kb-btn--active', alerts > 0 && 'kb-btn--alert'),
					icon: h(IconBolt, { size: 15 }),
					title: entryLabel,
					'aria-label': entryLabel,
					'aria-haspopup': 'dialog',
					'aria-expanded': open ? 'true' : 'false',
					buttonRef: entryRef,
					onClick: () => (open ? onClose() : onOpen()),
				},
				h('span', { className: 'kb-btnLabel kb-btnLabel--secondary' }, t('autopilot.entry')),
				alerts > 0 ? h('span', { className: 'kb-btnBadge kb-btnBadge--alert' }, String(alerts)) : null,
			)
		}

		/**
		 * mm:ss countdown to `nextTickAt` (AC 4). The interval lives in this leaf
		 * component so the page tree is not re-rendered once per second, and the
		 * reducer coalesces sub-second updates. Off/paused stop the interval and
		 * render the explicit word instead of a frozen number.
		 */
		function AutopilotCountdown(props) {
			const { t, view } = props
			const [countdown, setCountdown] = useState(() => initialAutopilotCountdown())
			const countdownRef = useRef(countdown)
			countdownRef.current = countdown
			useEffect(() => {
				if (!view || typeof view !== 'object') return
				setCountdown((previous) =>
					reduceAutopilotCountdown(previous, {
						type: 'sync',
						available: view.available === true,
						enabled: Boolean(view.config && view.config.enabled === true),
						paused: view.paused === true,
						nextTickAt: view.nextTickAt,
						hostNow: view.hostNow,
						localNow: Date.now(),
					}),
				)
			}, [view])
			useEffect(() => {
				if (autopilotCountdownMode(countdownRef.current) !== 'running') return undefined
				const timer = window.setInterval(() => {
					setCountdown((previous) => reduceAutopilotCountdown(previous, { type: 'tick', localNow: Date.now() }))
				}, 1000)
				return () => window.clearInterval(timer)
			}, [countdown.nextTickAt, countdown.available, countdown.enabled, countdown.paused])
			const mode = autopilotCountdownMode(countdown)
			const label = autopilotCountdownLabel(countdown, t)
			return h(
				'span',
				{
					className: 'kb-apCountdown kb-apCountdown--' + mode,
					role: 'timer',
					title: t('autopilot.countdown.label'),
					'aria-label': autopilotCountdownAria(countdown, t),
				},
				h('span', { className: 'kb-apCountdownLabel' }, t('autopilot.countdown.label')),
				h('span', { className: 'kb-apCountdownValue' }, label),
			)
		}

		/**
		 * Autopilot observability section: deduplicated alerts above the pulse feed
		 * (AC 5) and the newest ≤20 pulses with an expandable decision region
		 * (AC 1/AC 6/AC 7). Rows are real buttons, so keyboard focus and
		 * Enter/Space expansion are native; every state is carried by text.
		 */
		function AutopilotObservability(props) {
			const { t, feed, alerts, feedState, expandedPulseId, onTogglePulse, onAck, onOpenTicket, onEnable, enabled, available, saving } = props
			const rows = safeArray(feed && feed.rows)
			const alertRows = safeArray(alerts)
			return h(
				'div',
				{ className: 'kb-apObservability' },
				alertRows.length > 0
					? h(
							'div',
							{ className: 'kb-apAlerts', role: 'group', 'aria-label': t('autopilot.alert.group') },
							alertRows.map((alert) =>
								h(
									'div',
									{ key: alert.key, className: 'kb-apAlert', role: 'alert' },
									h(
										'div',
										{ className: 'kb-apAlertTop' },
										h(IconWarning, { size: 12 }),
										h('span', { className: 'kb-apAlertTitle' }, t('autopilot.alert.title')),
										alert.time ? h('span', { className: 'kb-apAlertTime' }, alert.time) : null,
									),
									alert.message ? h('div', { className: 'kb-apAlertText' }, alert.message) : null,
									alert.reasons.length > 0 ? h('div', { className: 'kb-apAlertText' }, alert.reasons.join(' · ')) : null,
									h(
										'div',
										{ className: 'kb-apAlertActions' },
										alert.ticketIds.map((id) =>
											h(
												'button',
												{
													key: id,
													type: 'button',
													className: 'kb-apAlertTicket',
													title: t('autopilot.alert.openTicket', { id }),
													'aria-label': t('autopilot.alert.openTicket', { id }),
													onClick: () => (typeof onOpenTicket === 'function' ? onOpenTicket(id) : null),
												},
												h(IconTicket, { size: 11 }),
												h('span', null, id),
											),
										),
										h(
											'button',
											{
												type: 'button',
												className: 'kb-apAlertAck',
												title: t('autopilot.alert.ack'),
												'aria-label': t('autopilot.alert.ack'),
												onClick: () => (typeof onAck === 'function' ? onAck(alert.pulseId) : null),
											},
											h(IconCheck, { size: 12 }),
											h('span', null, t('autopilot.alert.ack')),
										),
									),
								),
							),
						)
					: null,
				h(
					'div',
					{ className: 'kb-apFeed' },
					h(
						'div',
						{ className: 'kb-apFeedHead' },
						h('span', { className: 'kb-apFeedTitle' }, t('autopilot.feedTitle')),
						feedState === 'ready' ? h('span', { className: 'kb-apFeedCount' }, t('autopilot.feedCount', { n: String(rows.length) })) : null,
					),
					feedState === 'loading'
						? h('div', { className: 'kb-apFeedNote', role: 'status' }, t('autopilot.feedLoading'))
						: feedState === 'unavailable'
							? h('div', { className: 'kb-apFeedNote' }, t('autopilot.feedUnavailable'))
							: feedState === 'empty'
								? h(
										'div',
										{ className: 'kb-apFeedEmpty' },
										h('div', { className: 'kb-apFeedEmptyTitle' }, t(enabled && available ? 'autopilot.feedEmptyTitleOn' : 'autopilot.feedEmptyTitle')),
										h('div', { className: 'kb-apFeedEmptyBody' }, t(enabled && available ? 'autopilot.feedEmptyBodyOn' : 'autopilot.feedEmptyBody')),
										!enabled && available
											? h(
													Button,
													{
														size: 'sm',
														variant: 'primary',
														icon: h(IconBolt, { size: 12 }),
														disabled: saving,
														onClick: () => (typeof onEnable === 'function' ? onEnable() : null),
													},
													t('autopilot.feedEmptyAction'),
												)
											: null,
									)
								: h(
										'ol',
										{ className: 'kb-apPulseList' },
										rows.map((row) => {
											const expanded = expandedPulseId === row.key
											const detailId = 'kb-ap-pulse-' + row.key.replace(/[^a-zA-Z0-9_-]/g, '-')
											return h(
												'li',
												{ key: row.key, className: classNames('kb-apPulse', row.hasError && 'kb-apPulse--error'), 'data-pulse': row.id },
												h(
													'button',
													{
														type: 'button',
														className: 'kb-apPulseHead',
														'aria-expanded': expanded ? 'true' : 'false',
														'aria-controls': detailId,
														title: row.stamp,
														'aria-label': t('autopilot.feedOpen', { id: row.id }),
														'data-pulse': row.id,
														onClick: () => (typeof onTogglePulse === 'function' ? onTogglePulse(row.key) : null),
													},
													h(
														'span',
														{ className: 'kb-apPulseTop' },
														h('span', { className: 'kb-apTrigger kb-apTrigger--' + row.trigger }, row.triggerLabel),
														h('span', { className: 'kb-apPulseTime' }, row.time),
														row.hasError
															? h(
																	'span',
																	{ className: 'kb-apPulseError', title: row.errorText },
																	h(IconWarning, { size: 10 }),
																	h('span', null, row.errorLabel),
																)
															: null,
													),
													h(
														'span',
														{ className: 'kb-apPulseMeta' },
														h('span', null, row.durationText),
														h('span', { 'aria-hidden': 'true' }, '·'),
														h('span', null, t('autopilot.feedDispatched', { n: String(row.dispatchedCount) })),
														h('span', { 'aria-hidden': 'true' }, '·'),
														h('span', null, t('autopilot.feedSkipped', { n: String(row.skippedCount) })),
													),
												),
												expanded
													? h(
															'div',
															{
																id: detailId,
																className: 'kb-apPulseDetail',
																role: 'region',
																'aria-label': t('autopilot.feedDetails', { id: row.id }),
															},
															h('div', { className: 'kb-apFeedSubTitle' }, t('autopilot.feedDecisionTitle')),
															row.decisions.length === 0
																? h('div', { className: 'kb-apFeedNote' }, t('autopilot.feedNoDecisions'))
																: h(
																		'ul',
																		{ className: 'kb-apDecisionList' },
																		row.decisions.map((decision) =>
																			h(
																				'li',
																				{
																					key: decision.key,
																					className: classNames('kb-apDecision', decision.alert && 'kb-apDecision--alert'),
																					'data-action': decision.action,
																					'data-reason': decision.reasonCode,
																					'data-ticket': decision.ticketId || '',
																					'data-member': decision.memberName,
																				},
																				h(
																					'div',
																					{ className: 'kb-apDecisionTop' },
																					h('span', { className: 'kb-apDecisionAction kb-apDecisionAction--' + decision.action }, decision.actionLabel),
																					h('span', { className: 'kb-apDecisionId' }, decision.ticketId || t('autopilot.boardLevel')),
																					decision.ticketTitle ? h('span', { className: 'kb-apDecisionTitle' }, decision.ticketTitle) : null,
																				),
																				h(
																					'div',
																					{ className: 'kb-apDecisionMeta' },
																					decision.memberName ? h('span', null, decision.memberName) : null,
																					decision.memberRole ? h('span', null, '· ' + decision.memberRole) : null,
																					decision.laneLabel ? h('span', null, '· ' + decision.laneLabel) : null,
																				),
																				h('div', { className: 'kb-apDecisionReason' }, decision.reason),
																				decision.detail ? h('div', { className: 'kb-apDecisionDetail' }, decision.detail) : null,
																				decision.notExecuted ? h('div', { className: 'kb-apDecisionNote' }, decision.notExecutedText) : null,
																			),
																		),
																	),
															h('div', { className: 'kb-apFeedSubTitle' }, t('autopilot.feedDispatchedTitle')),
															row.executed.length === 0
																? h('div', { className: 'kb-apFeedNote' }, t('autopilot.feedNoDispatched'))
																: h(
																		'ul',
																		{ className: 'kb-apExecutedList' },
																		row.executed.map((entry) =>
																			h(
																				'li',
																				{ key: entry.key, className: 'kb-apExecuted', 'data-ticket': entry.ticketId || '' },
																				h('span', { className: 'kb-apDecisionId' }, entry.ticketId || t('autopilot.boardLevel')),
																				entry.ticketTitle ? h('span', { className: 'kb-apDecisionTitle' }, entry.ticketTitle) : null,
																				entry.memberName ? h('span', { className: 'kb-apDecisionMeta' }, entry.memberName) : null,
																			),
																		),
																	),
														)
													: null,
											)
										}),
									),
				),
			)
		}

		function AutopilotControl(props) {
			const { t, open, onOpen, onClose, onConfigure, onPreview, onPulse, onDismissError, onDismissPhase1, entryRef, wrapRef, roleName, onOpenTicket } = props
			const view = props.view && typeof props.view === 'object' ? props.view : autopilotViewFromSnapshot(null)
			const ui = props.state && typeof props.state === 'object' ? props.state : initialAutopilotUi(null)
			const values = ui.values || view.config
			const available = ui.available === true
			const enabled = Boolean(values && values.enabled === true)
			const busy = ui.busy
			const saving = busy === 'configure'
			const previewing = busy === 'preview'
			const pulsing = busy === 'pulse'
			const stateKey = autopilotStateLabel(ui)
			const budgetRows = autopilotBudgetRows(ui.budget, t)
			// KB-77: the feed and its alerts are merged locally per pulse id, so a
			// poll can never duplicate a row, clear an unread alert or un-acknowledge
			// one; the component stays mounted while the popover opens and closes.
			const [pulseState, setPulseState] = useState(() => initialAutopilotPulseState())
			const [expandedPulseId, setExpandedPulseId] = useState(null)
			useEffect(() => {
				setPulseState((previous) =>
					reduceAutopilotPulseState(previous, { type: 'sync', hostNow: view.hostNow, pulses: view.pulses }),
				)
			}, [view])
			// Before the first sync, render the polled ring directly so the popover
			// never flashes "No pulses yet" for a board that already has history.
			const feedPulses = pulseState.hostNow === null ? safeArray(view.pulses) : pulseState.pulses
			const feedState = autopilotFeedState({ loading: props.loading === true, available, pulses: feedPulses })
			const feed = buildAutopilotFeed(feedPulses, props.tickets, props.roster, t, roleName)
			const alerts = available
				? buildAutopilotAlerts(feedPulses, pulseState.acked, props.tickets, t)
				: []
			const acknowledgeAlert = (pulseId) => {
				setPulseState((previous) => reduceAutopilotPulseState(previous, { type: 'ack', pulseId }))
			}
			const openAlertTicket = (ticketId) => {
				if (typeof onOpenTicket === 'function') onOpenTicket(ticketId)
			}
			const previewModel = ui.preview
				? buildAutopilotPreview(ui.preview, safeArray(props.tickets), safeArray(props.roster), t, roleName)
				: null
			const previewAllowed = canPreviewAutopilot(ui)
			const pulseAllowed = canPulseAutopilot(ui)
			const cadenceMinutes = Math.round(safeNumber(values && values.cadenceMs, 300000) / 60000)
			const depth = Math.round(safeNumber(values && values.maxReadyDepth, 3))
			const caps = (values && values.laneCaps) || { refine: 1, implement: 1, review: 1 }
			const pauseNote =
				ui.pauseCause === 'member' ? t('autopilot.pauseMember') : ui.pauseCause === 'board' ? t('autopilot.pauseBoard') : ''
			const statusNote = stateKey === 'paused' ? pauseNote : stateKey === 'off' ? t('autopilot.offNote') : ''
			const errorText = autopilotErrorText(ui.error, t)

			const field = (label, control) =>
				h('label', { className: 'kb-apField' }, h('span', { className: 'kb-apFieldLabel' }, label), control)

			return h(
				'div',
				{ className: 'kb-autopilotWrap', ref: wrapRef },
				h(AutopilotEntryButton, { t, stateKey, open, onOpen, onClose, entryRef, alertCount: alerts.length }),
				open
					? h(
							'div',
							{
								className: 'kb-apPopover',
								role: 'dialog',
								'aria-label': t('autopilot.title'),
								'aria-busy': busy === null ? undefined : 'true',
							},
							h(
								'div',
								{ className: 'kb-apHead' },
								h('span', { className: 'kb-apTitle' }, t('autopilot.title')),
								available ? h(AutopilotCountdown, { t, view }) : null,
								h('span', { className: 'kb-apState kb-apState--' + stateKey }, t('autopilot.state.' + stateKey)),
								h(Button, {
									variant: 'ghost',
									size: 'sm',
									icon: h(IconClose, { size: 13 }),
									title: t('header.close'),
									'aria-label': t('header.close'),
									onClick: onClose,
								}),
							),
							!available
								? h(
										'div',
										{ className: 'kb-apNote kb-apNote--warn', role: 'status' },
										h('div', null, h('strong', null, t('autopilot.unavailableTitle'))),
										h('div', null, t('autopilot.unavailableBody')),
									)
								: null,
							statusNote ? h('div', { className: 'kb-apNote' }, statusNote) : null,
							available && ui.membersPaused && !ui.paused
								? h('div', { className: 'kb-apNote kb-apNote--warn' }, t('autopilot.membersPaused'))
								: null,
							h(
								'button',
								{
									type: 'button',
									className: 'kb-apSwitch',
									'aria-pressed': enabled ? 'true' : 'false',
									'aria-label': t('autopilot.toggleLabel'),
									disabled: !available || saving,
									autoFocus: !available,
									onClick: () => onConfigure({ enabled: !enabled }),
								},
								h('span', { className: 'kb-apSwitchTrack', 'aria-hidden': 'true' }, h('span', { className: 'kb-apSwitchKnob' })),
								h('span', { className: 'kb-apSwitchText' }, t('autopilot.toggleLabel')),
								h('span', { className: 'kb-apSwitchState' }, t('autopilot.state.' + (enabled ? 'on' : 'off'))),
							),
							ui.phase1
								? h(
										'div',
										{ className: 'kb-apPhase1', role: 'status' },
										h('div', { className: 'kb-apPhase1Title' }, t('autopilot.phase1Title')),
										h('div', { className: 'kb-apPhase1Body' }, t('autopilot.phase1Body')),
										h(
											'div',
											{ className: 'kb-apActions' },
											h(Button, { size: 'sm', onClick: onDismissPhase1 }, t('autopilot.phase1Dismiss')),
										),
									)
								: null,
							available
								? h(
										'div',
										{ className: 'kb-apFields' },
										field(
											t('autopilot.cadence'),
											h(
												'select',
												{
													className: 'kb-apSelect',
													value: String(cadenceMinutes),
													'aria-label': t('autopilot.cadence'),
													disabled: saving,
													onChange: (event) => onConfigure({ cadenceMs: safeNumber(Number(event.target.value), 5) * 60000 }),
												},
												AUTOPILOT_CADENCE_MINUTES.map((minutes) =>
													h('option', { key: String(minutes), value: String(minutes) }, t('autopilot.minutes', { n: String(minutes) })),
												),
											),
										),
										field(
											t('autopilot.maxReadyDepth'),
											h(
												'select',
												{
													className: 'kb-apSelect',
													value: String(depth),
													'aria-label': t('autopilot.maxReadyDepth'),
													disabled: saving,
													onChange: (event) => onConfigure({ maxReadyDepth: safeNumber(Number(event.target.value), 3) }),
												},
												AUTOPILOT_DEPTH_OPTIONS.map((option) =>
													h('option', { key: String(option), value: String(option) }, String(option)),
												),
											),
										),
										h(
											'div',
											{ className: 'kb-apField kb-apFieldCaps' },
											h('span', { className: 'kb-apFieldLabel' }, t('autopilot.laneCaps')),
											h(
												'div',
												{ className: 'kb-apCapsGrid' },
												AUTOPILOT_LANES.map((lane) =>
													field(
														t('autopilot.lane.' + lane),
														h(
															'select',
															{
																className: 'kb-apSelect',
																value: String(Math.round(safeNumber(caps[lane], 1))),
																'aria-label': t('autopilot.lane.' + lane),
																disabled: saving,
																onChange: (event) =>
																	onConfigure({ laneCaps: { [lane]: safeNumber(Number(event.target.value), 1) } }),
															},
															AUTOPILOT_LANE_CAP_OPTIONS.map((option) =>
																h('option', { key: String(option), value: String(option) }, String(option)),
															),
														),
													),
												),
											),
										),
									)
								: null,
							available
								? h(
										'div',
										{ className: 'kb-apBudget' },
										h('span', { className: 'kb-apBudgetTitle' }, t('autopilot.budget')),
										budgetRows.length > 0
											? budgetRows.map((text, index) => h('span', { key: String(index), className: 'kb-apBudgetRow' }, text))
											: h('span', { className: 'kb-apBudgetRow' }, t('autopilot.budgetUnavailable')),
									)
								: null,
							ui.error
								? h(
										'div',
										{ className: 'kb-apError', role: 'alert' },
										h(
											'span',
											{ className: 'kb-apErrorText' },
											h('span', { className: 'kb-apErrorCode' }, t('autopilot.error', { code: ui.error.code })),
											errorText ? h('span', null, ' ' + errorText) : null,
										),
										h(
											'button',
											{
												type: 'button',
												className: 'kb-apErrorDismiss',
												title: t('autopilot.dismissError'),
												'aria-label': t('autopilot.dismissError'),
												onClick: onDismissError,
											},
											h(IconClose, { size: 12 }),
										),
									)
								: null,
							available && (enabled || saving)
								? h(
										'div',
										{ className: 'kb-apActions' },
										enabled
											? h(
													Button,
													{
														icon: previewing ? h(Spinner) : h(IconList, { size: 13 }),
														title: t('autopilot.preview'),
														disabled: !previewAllowed,
														onClick: onPreview,
													},
													previewing ? t('autopilot.previewBusy') : t('autopilot.preview'),
												)
											: null,
										enabled
											? h(
													Button,
													{
														variant: 'primary',
														icon: pulsing ? h(Spinner) : h(IconBolt, { size: 13 }),
														title: ui.paused ? t('autopilot.pulseDisabled') : t('autopilot.pulseNow'),
														'aria-busy': pulsing ? 'true' : undefined,
														disabled: !pulseAllowed,
														onClick: onPulse,
													},
													pulsing ? t('autopilot.pulseBusy') : t('autopilot.pulseNow'),
												)
											: null,
										saving ? h('span', { className: 'kb-apSaving' }, t('autopilot.saving')) : null,
									)
								: null,
							previewModel
								? h(
										'div',
										{ className: 'kb-apPreview', 'aria-live': 'polite' },
										h(
											'div',
											{ className: 'kb-apPreviewHead' },
											h('span', { className: 'kb-apPreviewTitle' }, t('autopilot.previewTitle')),
											h(
												'span',
												{ className: 'kb-apPreviewCount' },
												t('autopilot.previewSummary', {
													dispatches: String(previewModel.dispatchCount),
													skips: String(previewModel.skipCount),
												}),
											),
										),
										previewModel.empty
											? h(
													'div',
													{ className: 'kb-apEmpty' },
													h('div', { className: 'kb-apEmptyTitle' }, t('autopilot.previewEmptyTitle')),
													h(
														'div',
														null,
														t('autopilot.previewEmptyBody', {
															summary: previewModel.summaryText || t('autopilot.reasonUnknown', { code: 'none' }),
														}),
													),
												)
											: null,
										h(
											'ol',
											{ className: 'kb-apList' },
											previewModel.rows.map((row) =>
												h(
													'li',
													{
														key: row.key,
														className: 'kb-apRow' + (row.kind === 'dispatch' ? ' kb-apRow--dispatch' : ''),
													},
													h(
														'div',
														{ className: 'kb-apRowTop' },
														h('span', { className: 'kb-apRowIndex' }, String(row.ordinal)),
														h('span', { className: 'kb-apRowId' }, row.ticketId || t('autopilot.boardLevel')),
														row.title ? h('span', { className: 'kb-apRowTitle' }, row.title) : null,
													),
													h(
														'div',
														{ className: 'kb-apRowMeta' },
														h(
															'span',
															null,
															row.memberName ? row.memberName : row.kind === 'dispatch' ? t('autopilot.noMember') : '',
														),
														row.memberRole ? h('span', null, '· ' + row.memberRole) : null,
														row.laneLabel ? h('span', null, '· ' + row.laneLabel) : null,
													),
													h('div', { className: 'kb-apRowReason' }, row.reason),
													row.detail ? h('div', { className: 'kb-apRowDetail', title: row.detail }, row.detail) : null,
												),
											),
										),
									)
								: null,
							available
								? h(AutopilotObservability, {
										t,
										feed,
										alerts,
										feedState,
										expandedPulseId,
										onTogglePulse: (pulseId) => setExpandedPulseId((previous) => (previous === pulseId ? null : pulseId)),
										onAck: acknowledgeAlert,
										onOpenTicket: openAlertTicket,
										onEnable: () => onConfigure({ enabled: true }),
										enabled,
										available,
										saving,
									})
								: null,
						)
					: null,
			)
		}

		// ------------------------------------------------------------------
		// Menu components
		// ------------------------------------------------------------------

		function ProjectMenu(props) {
			const { t, projects, currentId } = props
			const list = safeArray(projects)
			return h(
				'div',
				{ className: 'kb-menu', role: 'menu' },
				list.length === 0
					? h('div', { className: 'kb-menuEmpty' }, t('project.none'))
					: list.map((project) => {
							if (!project || typeof project.id !== 'string') return null
							const counts = project.counts && typeof project.counts === 'object' ? project.counts : {}
							const selected = project.id === currentId
							return h(
								'button',
								{
									key: project.id,
									type: 'button',
									role: 'menuitemradio',
									'aria-checked': selected ? 'true' : 'false',
									className: classNames('kb-menuRow', selected && 'kb-menuRow--active'),
									onClick: () => props.onSelect(project.id),
								},
								h(
									'div',
									{ className: 'kb-menuTop' },
									h('span', { className: 'kb-menuTitle' }, safeString(project.title) || project.id),
									project.paused === true ? h('span', { className: 'kb-chip kb-chip--warn' }, t('project.paused')) : null,
									selected ? h('span', { className: 'kb-menuCheck' }, h(IconCheck, { size: 12 })) : null,
								),
								h('div', { className: 'kb-menuPath' }, safeString(project.path)),
								h(
									'div',
									{ className: 'kb-menuCounts' },
									COLUMNS.map((column) =>
										h(
											'span',
											{ key: column, className: 'kb-menuCount', title: t('columns.' + column) },
											h('span', { className: 'kb-dot kb-dot--' + column }),
											String(safeNumber(counts[column], 0)),
										),
									),
									safeNumber(project.sessionCount, 0) > 0
										? h('span', { className: 'kb-menuCount' }, t('project.sessions', { n: safeNumber(project.sessionCount, 0) }))
										: null,
								),
							)
						}),
				h(
					'div',
					{ className: 'kb-menuFoot' },
					h(
						Button,
						{
							variant: 'ghost',
							size: 'sm',
							icon: h(IconRefresh, { size: 12 }),
							onClick: props.onRefresh,
							disabled: props.loading === true,
							title: t('project.refresh'),
						},
						t('project.refresh'),
					),
				),
			)
		}

		function FiltersMenu(props) {
			const { t, roles, agents } = props
			const roleOptions = safeArray(roles)
			const agentOptions = safeArray(agents)
			return h(
				'div',
				{ className: 'kb-filters' },
				h(
					'label',
					{ className: 'kb-field' },
					h('span', { className: 'kb-fieldLabel' }, t('filters.role')),
					h(
						'select',
						{ className: 'kb-select', value: props.roleFilter, onChange: (event) => props.onRole(event.target.value) },
						h('option', { value: '' }, t('filters.allRoles')),
						roleOptions.map((role) => h('option', { key: role.id, value: role.id }, role.name)),
					),
				),
				h(
					'label',
					{ className: 'kb-field' },
					h('span', { className: 'kb-fieldLabel' }, t('filters.owner')),
					h(
						'select',
						{ className: 'kb-select', value: props.ownerFilter, onChange: (event) => props.onOwner(event.target.value) },
						h('option', { value: '' }, t('filters.allOwners')),
						h('option', { value: UNASSIGNED }, t('filters.unassigned')),
						agentOptions.map((agent) =>
							h('option', { key: agent.sessionId, value: agent.sessionId }, safeString(agent.name) || agent.sessionId),
						),
					),
				),
				h(
					'div',
					{ className: 'kb-filtersFoot' },
					h(Button, { variant: 'ghost', size: 'sm', onClick: props.onClear }, t('filters.clear')),
				),
			)
		}

		// ------------------------------------------------------------------
		// Board
		// ------------------------------------------------------------------

		function cardTypeClass(type) {
			if (type === 'bug') return 'error'
			if (type === 'spike') return 'warn'
			if (type === 'epic') return 'epic'
			if (type === 'story') return 'brand'
			return 'idle'
		}

		function priorityClass(priority) {
			if (priority === 'critical') return 'error'
			if (priority === 'high') return 'warn'
			if (priority === 'medium') return 'brand'
			return 'idle'
		}

		function typeLabel(type, t) {
			return TYPES.indexOf(type) === -1 ? safeString(type) : t('types.' + type)
		}

		function priorityLabel(priority, t) {
			return PRIORITIES.indexOf(priority) === -1 ? safeString(priority) : t('priority.' + priority)
		}

		const LANE_CLAIM_ROLES = {
			backlog: ['product-manager', 'tech-lead'],
			ready: ['ux-designer', 'fe-developer', 'be-developer', 'fullstack-developer', 'bug-fixer', 'sre', 'tech-lead'],
			review: ['reviewer', 'tester', 'tech-lead'],
		}

		function executionOf(ticket) {
			return ticket && typeof ticket === 'object' && ticket.execution && typeof ticket.execution === 'object'
				? ticket.execution
				: null
		}

		function executionStatusOf(ticket) {
			const execution = executionOf(ticket)
			return execution && typeof execution.status === 'string' ? execution.status : null
		}

		function laneRunRoles(roles, column) {
			const allowed = LANE_CLAIM_ROLES[column] ?? []
			return safeArray(roles).filter((role) => role && allowed.indexOf(role.id) !== -1)
		}

		function assignmentOf(ticket) {
			return ticket && typeof ticket === 'object' && ticket.assignment && typeof ticket.assignment === 'object'
				? ticket.assignment
				: null
		}

		function accessOptionsOf(snapshot) {
			const modes = snapshot && snapshot.accessModes && typeof snapshot.accessModes === 'object' ? snapshot.accessModes : null
			const options = safeArray(modes && modes.options).filter((option) => option && typeof option.value === 'string')
			return {
				options:
					options.length > 0
						? options
						: [
								{ value: 'read-only', name: 'Read only' },
								{ value: 'workspace-write', name: 'Workspace write' },
								{ value: 'danger-full-access', name: 'Full access' },
							],
				suggestions: modes && modes.suggestions && typeof modes.suggestions === 'object' ? modes.suggestions : {},
			}
		}

		function accessName(value, name, t) {
			const known = {
				'read-only': 'access.readOnly',
				'workspace-write': 'access.workspaceWrite',
				'danger-full-access': 'access.fullAccess',
				auto: 'access.auto',
			}
			return known[value] ? t(known[value]) : safeString(name) || safeString(value)
		}

		function accessLabel(value, options, t) {
			const found = safeArray(options).find((option) => option && option.value === value)
			return accessName(value, found && found.name, t || ((key) => key))
		}

		function roleDisplay(role, t, roles) {
			const found = safeArray(roles).find((item) => item && item.id === role)
			return (found && found.name) || (role ? t('role.' + role) : '')
		}

		function executionChipLabel(status, t) {
			if (!status) return ''
			const known = ['running', 'idle', 'blocked', 'paused', 'done', 'failed', 'cancelled']
			return known.indexOf(status) === -1 ? safeString(status) : t('execution.' + status)
		}

		function needKindLabel(kind, t) {
			const known = ['permission', 'decision', 'question', 'input']
			return known.indexOf(kind) === -1 ? t('execution.need.input') : t('execution.need.' + kind)
		}

		function ExecutionChip(props) {
			const status = safeString(props.status)
			if (!status) return null
			return h(
				'span',
				{ className: 'kb-execChip kb-execChip--' + status, title: props.title },
				h('span', { className: 'kb-chipText' }, executionChipLabel(status, props.t)),
			)
		}

		function TicketCard(props) {
			const { t, ticket, blocked, dragging, onOpen, onDragStart, onDragEnd, roleName, onRun, runPending, parent, childCount, onOpenParent } = props
			const checklist = safeArray(ticket.checklist)
			const doneCount = checklist.filter((item) => item && item.done === true).length
			const commentCount = safeArray(ticket.comments).length
			const labels = safeArray(ticket.labels).slice(0, 3)
			const owner = ticket.owner && typeof ticket.owner === 'object' ? ticket.owner : null
			const blockedChip = blocked === true
			const execution = executionOf(ticket)
			const executionStatus = executionStatusOf(ticket)
			const activeExecution = executionStatus && ['running', 'blocked', 'idle', 'paused'].indexOf(executionStatus) !== -1
			const waitingCount = safeArray(ticket.block && ticket.block.questions).length + safeArray(ticket.block && ticket.block.needs).length
			const assignment = assignmentOf(ticket)
			const showHandoff = Boolean(assignment) && !activeExecution
			const laneRunnable = ['backlog', 'ready', 'review'].indexOf(ticket.column) !== -1
			// An EPIC is structural: it never runs, never drags, and always shows why.
			const isEpic = ticket.type === 'epic'
			const canRun = !blockedChip && laneRunnable && !activeExecution && !isEpic
			const draggable = !blockedChip && !activeExecution && !isEpic
			const cardTitle = isEpic
				? t('card.epicLockedHint')
				: blockedChip && ticket.blockReason
					? t('card.blockedReason', { reason: ticket.blockReason })
					: undefined
			return h(
				'article',
				{
					className: classNames('kb-card', dragging === true && 'kb-card--dragging', isEpic && 'kb-card--epic'),
					draggable,
					tabIndex: 0,
					role: 'button',
					'aria-label': t('card.open', { id: safeString(ticket.id) }),
					'aria-disabled': isEpic ? 'true' : undefined,
					'data-ticket': safeString(ticket.id),
					'data-epic': isEpic ? 'true' : undefined,
					title: cardTitle,
					onClick: () => onOpen(ticket.id),
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault()
							onOpen(ticket.id)
						}
					},
					onDragStart: (event) => onDragStart(event, ticket),
					onDragEnd,
				},
				h(
					'div',
					{ className: 'kb-cardTop' },
					h('span', { className: 'kb-cardId', title: safeString(ticket.id) }, safeString(ticket.id)),
					h(
						'div',
						{ className: 'kb-cardChips' },
						h(
							'span',
							{ className: 'kb-chip kb-chip--' + cardTypeClass(ticket.type), title: typeLabel(ticket.type, t) },
							h('span', { className: 'kb-chipText' }, typeLabel(ticket.type, t)),
						),
						parent
							? h(
									'button',
									{
										type: 'button',
										className: 'kb-chip kb-chip--parent',
										title: t('card.parentTitle', { title: safeString(parent.title) }) || t('card.parent', { id: parent.id }),
										'data-parent': safeString(parent.id),
										onClick: (event) => {
											event.stopPropagation()
											if (typeof onOpenParent === 'function') onOpenParent(parent.id)
										},
										onKeyDown: (event) => {
											event.stopPropagation()
										},
									},
									h('span', { className: 'kb-chipText' }, t('card.parent', { id: safeString(parent.id) })),
								)
							: null,
						isEpic
							? h(
									'span',
									{ className: 'kb-chip kb-chip--idle', title: t('card.epicLockedHint'), 'data-epic-lock': 'true' },
									h('span', { className: 'kb-chipText' }, t('card.epicLocked')),
								)
							: null,
						isEpic && childCount > 0
							? h(
									'span',
									{ className: 'kb-chip kb-chip--epic', title: t('card.children', { n: childCount }), 'data-child-count': String(childCount) },
									h('span', { className: 'kb-chipText' }, t('card.children', { n: childCount })),
								)
							: null,
						blockedChip
							? h(
									'span',
									{ className: 'kb-chip kb-chip--error', title: t('card.blocked') },
									h(IconWarning, { size: 10 }),
									h('span', { className: 'kb-chipText' }, t('card.blocked')),
								)
							: null,
						waitingCount > 0
							? h(
									'span',
									{ className: 'kb-chip kb-chip--warn', title: t('card.blockedQuestions', { n: waitingCount }) },
									h('span', { className: 'kb-chipText' }, t('card.blockedQuestions', { n: waitingCount })),
								)
							: null,
						executionStatus ? h(ExecutionChip, { status: executionStatus, t, title: t('execution.title') }) : null,
						showHandoff
							? h(
									'span',
									{ className: 'kb-chip kb-chip--warn', title: t('execution.handoffHint') },
									h(
										'span',
										{ className: 'kb-chipText' },
										t('card.nextRole', { role: roleName(assignment.role) }),
									),
								)
							: null,
					),
					h(
						'span',
						{ className: 'kb-chip kb-chip--' + priorityClass(ticket.priority), title: priorityLabel(ticket.priority, t) },
						h('span', { className: 'kb-chipText' }, priorityLabel(ticket.priority, t)),
					),
				),
				h('div', { className: 'kb-cardTitle' }, safeString(ticket.title)),
				h(
					'div',
					{ className: 'kb-cardMeta' },
					ticket.role
						? h(
								'span',
								{ className: 'kb-tag', title: roleName(ticket.role) },
								h('span', { className: 'kb-tagText' }, roleName(ticket.role)),
							)
						: null,
					owner
						? h(
								'span',
								{ className: 'kb-iconMeta', title: safeString(owner.name) },
								h(Avatar, { name: owner.name, small: true }),
								h('span', { className: 'kb-cardOwnerName' }, safeString(owner.name)),
							)
						: h('span', { className: 'kb-iconMeta' }, t('card.unassigned')),
				),
				labels.length > 0
					? h(
							'div',
							{ className: 'kb-cardLabels' },
							labels.map((label) =>
								h(
									'span',
									{ key: label, className: 'kb-tag', title: label },
									h('span', { className: 'kb-tagText' }, label),
								),
							),
						)
					: null,
				h(
					'div',
					{ className: 'kb-cardFoot' },
					checklist.length > 0
						? h(
								'span',
								{ className: 'kb-iconMeta', title: t('card.checklist', { done: doneCount, total: checklist.length }) },
								h(IconList, { size: 12 }),
								String(doneCount) + '/' + String(checklist.length),
							)
						: null,
					commentCount > 0
						? h(
								'span',
								{ className: 'kb-iconMeta', title: t('card.comments', { n: commentCount }) },
								h(IconComment, { size: 12 }),
								String(commentCount),
							)
						: null,
					h('span', { className: 'kb-cardSpacer' }),
					canRun
						? h(
								'button',
								{
									type: 'button',
									className: 'kb-cardRun',
									title: assignment ? t('execution.startRole', { role: roleName(assignment.role) }) : executionStatus && executionStatus !== 'done' ? t('execution.continue') : t('execution.run'),
									'aria-label': t('execution.run'),
									disabled: runPending === true,
									onClick: (event) => {
										event.stopPropagation()
										if (typeof onRun === 'function') onRun(ticket)
									},
								},
								h(IconPlay, { size: 11 }),
							)
						: null,
					h(
						'span',
						{ className: 'kb-iconMeta', title: t('card.updated', { ago: formatAge(ticket.updatedAt, t) }) },
						formatAge(safeNumber(ticket.movedAt, safeNumber(ticket.updatedAt, 0)), t),
					),
				),
			)
		}

		function BoardColumn(props) {
			const { t, column, tickets, totalCount, wipLimit, paused, isOver, drag, onOpenTicket, onAddTicket, roleName, onRun, pending, parentOf, childCountOf, onOpenParent, admission } = props
			const list = safeArray(tickets)
			const blockedColumn = column === 'blocked'
			const wipClass =
				wipLimit > 0 && totalCount > wipLimit
					? ' kb-colWip--error'
					: wipLimit > 0 && totalCount === wipLimit
						? ' kb-colWip--warn'
						: ''
			const columnName = t('columns.' + column)
			return h(
				'section',
				{
					className: classNames('kb-col', isOver === true && 'kb-col--over', blockedColumn && 'kb-col--blocked'),
					'data-column': column,
					'aria-label': columnName,
					onDragOver: blockedColumn ? undefined : (event) => props.onDragOver(event, column),
					onDragLeave: blockedColumn ? undefined : (event) => props.onDragLeave(event, column),
					onDrop: blockedColumn ? undefined : (event) => props.onDrop(event, column),
				},
				h(
					'div',
					{ className: 'kb-colHead' },
					h('span', { className: 'kb-dot kb-dot--' + column }),
					h('span', { className: 'kb-colTitle' }, columnName),
					h('span', { className: 'kb-colCount' }, String(list.length)),
					wipLimit > 0
						? h(
								'span',
								{ className: 'kb-colWip' + wipClass, title: t('columns.limit', { n: totalCount, limit: wipLimit }) },
								String(totalCount) + '/' + String(wipLimit),
							)
						: null,
					h('span', { className: 'kb-colSpacer' }),
					blockedColumn
						? h('span', { className: 'kb-colWip', title: t('execution.waitingHint') }, h(IconWarning, { size: 11 }))
						: h(
								'button',
								{
									type: 'button',
									className: 'kb-colAdd',
									title: t('columns.add', { column: columnName }),
									'aria-label': t('columns.add', { column: columnName }),
									disabled: paused === true,
									onClick: () => onAddTicket(column),
								},
								h(IconPlus, { size: 14 }),
							),
				),
				props.showAdmission === true
					? h(
							'div',
							{ className: 'kb-colAdmissionBar' + (admission ? ' kb-colAdmissionBar--' + admission.state : ' kb-colAdmissionBar--none') },
							admission
								? h(
										'span',
										{ className: 'kb-colAdmission kb-colAdmission--' + admission.state, title: admission.ariaLabel, 'data-lane': admission.lane, 'data-state': admission.state },
										h('span', { className: 'kb-colAdmissionState' }, admission.stateLabel),
										h('span', { className: 'kb-colAdmissionCap' }, admission.capacityText),
									)
								: null,
						)
					: null,
				h(
					'div',
					{ className: 'kb-colBody' },
					list.length === 0
						? h(
								'div',
								{ className: 'kb-colEmpty' },
								blockedColumn
									? t('columns.emptyBlocked')
									: props.filterActive === true
										? t('columns.emptyFiltered')
										: t('columns.empty'),
							)
						: null,
					list.map((ticket) =>
						ticket && typeof ticket.id === 'string'
							? h(TicketCard, {
									key: ticket.id,
									ticket,
									t,
									blocked: ticket.blocked === true,
									dragging: Boolean(drag && drag.ticketId === ticket.id),
									onOpen: onOpenTicket,
									onDragStart: props.onDragStart,
									onDragEnd: props.onDragEnd,
									roleName,
									onRun,
									runPending: Boolean(pending && pending['execute:' + ticket.id]),
									parent: typeof parentOf === 'function' ? parentOf(ticket) : null,
									childCount: typeof childCountOf === 'function' ? childCountOf(ticket) : 0,
									onOpenParent,
								})
							: null,
					),
				),
			)
		}

		function Board(props) {
			const { t, columnTickets, allCounts, wipLimits, paused, drag, over, roleName, filterActive, onRun, pending, parentOf, childCountOf, onOpenParent, laneAdmissions } = props
			const blockedTickets = safeArray(columnTickets.blocked)
			const admissions = laneAdmissions && typeof laneAdmissions === 'object' ? laneAdmissions : null
			const admissionFor = (column) => {
				if (!admissions) return null
				const lane = AUTOPILOT_LANE_BY_COLUMN[column]
				return lane ? admissions[lane] || null : null
			}
			return h(
				'div',
				{ className: 'kb-board' },
				COLUMNS.map((column) =>
					h(BoardColumn, {
						key: column,
						column,
						t,
						tickets: safeArray(columnTickets[column]),
						totalCount: safeNumber(allCounts[column], 0),
						wipLimit: safeNumber(wipLimits[column], 0),
						paused,
						isOver: over === column,
						filterActive,
						drag,
						roleName,
						admission: admissionFor(column),
						showAdmission: admissions !== null,
						onOpenTicket: props.onOpenTicket,
						onAddTicket: props.onAddTicket,
						onDragStart: props.onDragStart,
						onDragEnd: props.onDragEnd,
						onDragOver: props.onDragOver,
						onDragLeave: props.onDragLeave,
						onDrop: props.onDrop,
						parentOf,
						childCountOf,
						onOpenParent,
					}),
				),
				blockedTickets.length > 0
					? h(BoardColumn, {
							key: 'blocked',
							column: 'blocked',
							t,
							tickets: blockedTickets,
							totalCount: blockedTickets.length,
							wipLimit: 0,
							paused: true,
							isOver: false,
							filterActive,
							drag,
							roleName,
							admission: null,
							showAdmission: admissions !== null,
							onOpenTicket: props.onOpenTicket,
							onRun,
							pending,
							parentOf,
							childCountOf,
							onOpenParent,
						})
					: null,
			)
		}

		// ------------------------------------------------------------------
		// Team rail
		// ------------------------------------------------------------------

		/** Borderless inline name field on a roster row (host validates uniqueness). */
		function MemberNameInput(props) {
			const { t, name, disabled, onCommit } = props
			const original = safeString(name)
			const [value, setValue] = useState(original)
			const [invalid, setInvalid] = useState(false)
			useEffect(() => {
				setValue(safeString(name))
			}, [name])
			const commit = () => {
				const next = value.trim()
				if (!next || next.length > 48) {
					setInvalid(true)
					return
				}
				setInvalid(false)
				setValue(next)
				if (next === original) return
				Promise.resolve(typeof onCommit === 'function' ? onCommit(next) : null).then((result) => {
					if (!result || result.ok !== true) setValue(original)
				})
			}
			return h('input', {
				className: classNames('kb-nameInput', invalid && 'kb-input--invalid'),
				type: 'text',
				value,
				disabled: disabled === true,
				maxLength: 48,
				title: t('team.renameHint', { name: original }),
				'aria-label': t('team.renameHint', { name: original }),
				onChange: (event) => {
					setValue(event.target.value)
					if (invalid) setInvalid(false)
				},
				onBlur: commit,
				onKeyDown: (event) => {
					if (event.key === 'Enter') {
						event.preventDefault()
						event.currentTarget.blur()
					}
				},
			})
		}

		function MemberRosterRow(props) {
			const { t, member, pending, roleName, autopilot } = props
			const name = safeString(member.name) || safeString(member.id)
			const status = MEMBER_STATUSES.indexOf(safeString(member.status)) === -1 ? 'idle' : member.status
			const ticket = member.currentTicket && typeof member.currentTicket === 'object' ? member.currentTicket : null
			const ticketId = ticket && typeof ticket.id === 'string' ? ticket.id : ''
			const ticketTitle = safeString(ticket && ticket.title)
			const ticketText = memberTicketText(member)
			const roleLabel =
				member.roleId && typeof roleName === 'function'
					? roleName(member.roleId)
					: safeString(member.roleName) || safeString(member.roleId)
			const paused = member.paused === true
			const busy = (pending['member:' + member.id] || 0) > 0
			const sinceText = safeNumber(member.since, 0) ? t('team.since', { ago: formatAge(member.since, t) }) : ''
			const activityText = safeNumber(member.lastActivityAt, 0)
				? t('team.lastActive', { ago: formatAge(member.lastActivityAt, t) })
				: t('team.noActivity')
			const pauseLabel = paused ? t('team.memberResume', { name }) : t('team.memberPause', { name })
			return h(
				'div',
				{ className: classNames('kb-rosterRow', paused && 'kb-rosterRow--paused') },
				h(
					'div',
					{ className: 'kb-rosterTop' },
					h(Avatar, { name }),
					h(
						'div',
						{ className: 'kb-rosterInfo' },
						h(MemberNameInput, {
							t,
							name,
							disabled: busy,
							onCommit: (next) => (typeof props.onRename === 'function' ? props.onRename(member, next) : null),
						}),
						safeString(member.title)
							? h('span', { className: 'kb-rosterTitle', title: safeString(member.title) }, safeString(member.title))
							: null,
					),
					h(
						'span',
						{ className: 'kb-rosterActions' },
						h(
							'button',
							{
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon kb-btn--sm',
								disabled: busy,
								title: pauseLabel,
								'aria-label': pauseLabel,
								onClick: () => typeof props.onTogglePause === 'function' && props.onTogglePause(member),
							},
							paused ? h(IconPlay, { size: 12 }) : h(IconPause, { size: 12 }),
						),
						h(
							'button',
							{
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon kb-btn--sm',
								title: t('team.editMember', { name }),
								'aria-label': t('team.editMember', { name }),
								onClick: () => typeof props.onEdit === 'function' && props.onEdit(member),
							},
							h(IconEdit, { size: 12 }),
						),
					),
				),
				h(
					'div',
					{ className: 'kb-rosterMeta' },
					roleLabel ? h('span', { className: 'kb-tag', title: roleLabel }, h('span', { className: 'kb-tagText' }, roleLabel)) : null,
					h('span', { className: 'kb-teamStatus', title: safeString(member.statusReason) || statusLabel(status, t) }, h(StatusDot, { status }), statusLabel(status, t)),
					sinceText ? h('span', { className: 'kb-rosterMetaText', title: sinceText }, sinceText) : null,
				),
				autopilot
					? h(
							'div',
							{ className: 'kb-rosterAuto kb-rosterAuto--' + autopilot.kind },
							// Text only: a member at rest must not carry a pulsing green
							// "engaged" dot. The row's single status dot pulses only while
							// the member's attached agent is actually running.
							h(
								'span',
								{ className: 'kb-rosterAutoChip', title: autopilot.ariaLabel, 'aria-label': autopilot.ariaLabel, 'data-autopilot': autopilot.kind, 'data-member': member.id },
								h('span', null, autopilot.chipText),
							),
							h('span', { className: 'kb-rosterMetaText', title: autopilot.lastActiveText }, autopilot.lastActiveText),
						)
					: null,
				h(
					'div',
					{ className: 'kb-rosterFoot' },
					ticketId
						? h(
								'button',
								{
									type: 'button',
									className: 'kb-teamTicket',
									title: ticketText + ' · ' + t('team.openTicket', { id: ticketId }),
									'aria-label': t('team.openTicket', { id: ticketId }) + (ticketTitle ? ' ' + ticketTitle : ''),
									onClick: () => typeof props.onOpenTicket === 'function' && props.onOpenTicket(ticketId),
								},
								h(IconTicket, { size: 11 }),
								h('span', { className: 'kb-teamTicketText' }, ticketText),
							)
						: h('span', { className: 'kb-teamNoTicket' }, t('team.noTicket')),
					h('span', { className: 'kb-rosterMetaText', title: activityText }, activityText),
				),
			)
		}

		function DraftRow(props) {
			const { t, draft } = props
			const status = safeString(draft.status) || 'drafting'
			const errorText = safeString(draft.error)
			const drafting = status === 'drafting'
			const timeoutHint = errorText + ' ' + safeString(draft.mode)
			const timedOut = !drafting && /timeout|timed[\s-]?out/i.test(timeoutHint)
			// The host labels its deterministic fallback as failed + mode 'template';
			// that row already added a member, so retrying it must not add another.
			const retryable = !drafting && safeString(draft.mode) !== 'template'
			const label = drafting
				? t('draft.drafting')
				: status === 'cancelled'
					? t('draft.cancelled')
					: timedOut
						? t('draft.timeout')
						: t('draft.error')
			const description = safeString(draft.description)
			return h(
				'div',
				{ className: 'kb-draftRow' },
				h(
					'div',
					{ className: 'kb-draftTop' },
					h('span', { className: 'kb-draftDesc', title: description }, description || t('draft.section')),
					h(
						'span',
						{ className: 'kb-draftStatus kb-draftStatus--' + status },
						drafting ? h(Spinner) : h(StatusDot, { status: status === 'cancelled' ? 'offline' : 'failed' }),
						label,
					),
				),
				errorText && !drafting ? h('span', { className: 'kb-hint kb-hint--error', title: errorText }, errorText) : null,
				h(
					'div',
					{ className: 'kb-draftActions' },
					retryable
						? h(
								Button,
								{
									size: 'sm',
									variant: 'ghost',
									icon: h(IconRefresh, { size: 12 }),
									title: t('draft.retry'),
									onClick: () => typeof props.onRetry === 'function' && props.onRetry(draft),
								},
								t('draft.retry'),
							)
						: null,
					h(
						Button,
						{
							size: 'sm',
							variant: 'ghost',
							title: t('draft.dismiss'),
							onClick: () => typeof props.onDismiss === 'function' && props.onDismiss(draft),
						},
						t('draft.dismiss'),
					),
				),
			)
		}

		function TeamRail(props) {
			const {
				t,
				roster,
				drafts,
				board,
				tickets,
				roles,
				pending,
				roleName,
				autopilot,
				onOpenTicket,
				onToggleBoard,
				onClose,
				pauseBusy,
			} = props
			const autopilotView = autopilot && typeof autopilot === 'object' ? autopilot : null
			const showAutopilot = Boolean(autopilotView && autopilotView.available === true)
			// The team list is the fixed roster. Agent sessions are attachments that
			// drive each member's status; they are never rendered as extra team rows.
			const members = safeArray(roster).filter((member) => member && typeof member.id === 'string' && member.id)
			const draftRows = safeArray(drafts).filter((draft) => draft && typeof draft.id === 'string' && draft.id)
			const running = members.filter((member) => member.status === 'running').length
			const idle = members.filter((member) => member.status === 'idle').length
			const activeTickets = safeArray(tickets).filter(
				(ticket) => ticket && (ticket.column === 'in_progress' || ticket.column === 'review'),
			).length
			const boardPaused = board && board.paused === true
			const roleOptions = safeArray(roles)
			// The host limit counts only in-flight drafts; failed/cancelled rows stay
			// visible for retry/dismiss and must not block a new draft.
			const draftLimit = draftRows.filter((draft) => draft && draft.status === 'drafting').length >= DRAFT_LIMIT
			const [aiOpen, setAiOpen] = useState(false)
			const [aiDescription, setAiDescription] = useState('')
			const [aiRole, setAiRole] = useState('')
			const [aiBusy, setAiBusy] = useState(false)
			const submitAi = () => {
				const description = aiDescription.trim()
				if (!description || aiBusy || draftLimit || typeof props.onDraft !== 'function') return
				setAiBusy(true)
				Promise.resolve(props.onDraft(description, aiRole ? aiRole : null))
					.then((result) => {
						setAiBusy(false)
						if (result && result.ok) {
							setAiDescription('')
							setAiOpen(false)
						}
					})
					.catch(() => setAiBusy(false))
			}
			return h(
				'aside',
				{ className: 'kb-rail', 'aria-label': t('team.title') },
				h(
					'div',
					{ className: 'kb-railHead' },
					h('span', { className: 'kb-railTitle' }, h(IconTeam, { size: 14 }), t('team.title')),
					h(
						'button',
						{
							type: 'button',
							className: 'kb-btn kb-btn--ghost kb-btn--icon',
							title: t('team.close'),
							'aria-label': t('team.close'),
							onClick: onClose,
						},
						h(IconClose, { size: 14 }),
					),
				),
				h(
					'div',
					{ className: 'kb-railBody' },
					h(
						'div',
						{ className: 'kb-pauseRow' },
						h(
							'span',
							{ className: 'kb-pauseText' },
							h('span', { className: 'kb-pauseTitle' }, t('team.title')),
							h(
								'span',
								{ className: 'kb-pauseHint' },
								t('team.members', { n: members.length }) + ' · ' + t('team.running', { n: running }),
							),
						),
						h(
							Button,
							{
								size: 'sm',
								variant: boardPaused ? 'primary' : undefined,
								icon: boardPaused ? h(IconPlay, { size: 12 }) : h(IconPause, { size: 12 }),
								onClick: onToggleBoard,
								disabled: pauseBusy === true || !board,
								title: boardPaused ? t('team.resumeBoard') : t('team.pauseBoard'),
							},
							boardPaused ? t('team.resumeBoard') : t('team.pauseBoard'),
						),
					),
					h(
						'div',
						{ className: 'kb-railSection' },
						h(
							'div',
							{ className: 'kb-summaryRow' },
							h('span', { className: 'kb-chip' }, t('team.members', { n: members.length })),
							h('span', { className: 'kb-chip' }, t('team.running', { n: running })),
							h('span', { className: 'kb-chip' }, t('team.idle', { n: idle })),
							h('span', { className: 'kb-chip' }, t('team.activeTickets', { n: activeTickets })),
						),
					),
					h(
						'div',
						{ className: 'kb-railSection' },
						h(SectionHead, { title: t('team.roster'), count: members.length }),
						h(
							'div',
							{ className: 'kb-sectionActions' },
							h(
								Button,
								{
									size: 'sm',
									icon: h(IconPlus, { size: 12 }),
									disabled: !board,
									title: t('team.addMember'),
									onClick: () => typeof props.onAddMember === 'function' && props.onAddMember(),
								},
								t('team.addMember'),
							),
							h(
								Button,
								{
									size: 'sm',
									variant: aiOpen ? 'primary' : undefined,
									icon: h(IconSparkles, { size: 12 }),
									disabled: !board,
									pressed: aiOpen,
									title: t('team.addWithAi'),
									onClick: () => setAiOpen((value) => !value),
								},
								t('team.addWithAi'),
							),
						),
						aiOpen
							? h(
									'div',
									{ className: 'kb-aiForm' },
									h(
										'label',
										{ className: 'kb-field' },
										h('span', { className: 'kb-fieldLabel' }, t('ai.description')),
										h('textarea', {
											className: 'kb-aiTextarea',
											value: aiDescription,
											rows: 3,
											maxLength: 1000,
											disabled: draftLimit,
											autoFocus: true,
											placeholder: t('ai.placeholder'),
											'aria-label': t('ai.description'),
											onChange: (event) => setAiDescription(event.target.value),
										}),
									),
									h(
										'div',
										{ className: 'kb-aiRow' },
										h(
											'select',
											{
												className: 'kb-aiRole',
												value: aiRole,
												disabled: draftLimit,
												title: t('ai.role'),
												'aria-label': t('ai.role'),
												onChange: (event) => setAiRole(event.target.value),
											},
											h('option', { value: '' }, t('ai.anyRole')),
											roleOptions.map((role) => h('option', { key: role.id, value: role.id }, role.name)),
										),
										h(
											Button,
											{
												size: 'sm',
												variant: 'primary',
												disabled: aiBusy || draftLimit || aiDescription.trim() === '',
												icon: aiBusy ? h(Spinner) : h(IconSparkles, { size: 12 }),
												title: t('ai.draft'),
												onClick: submitAi,
											},
											aiBusy ? t('ai.drafting') : t('ai.draft'),
										),
									),
									draftLimit
										? h('span', { className: 'kb-hint kb-hint--warn' }, t('draft.limit'))
										: h('span', { className: 'kb-hint' }, t('draft.hint')),
								)
							: null,
						members.length === 0
							? h('div', { className: 'kb-emptyLine' }, t('team.rosterEmpty'))
							: members.map((member) =>
									h(MemberRosterRow, {
										key: member.id,
										t,
										member,
										pending,
										roleName,
										autopilot: showAutopilot ? memberAutopilotState(member, autopilotView, t) : null,
										onOpenTicket,
										onEdit: props.onEditMember,
										onTogglePause: props.onToggleMember,
										onRename: props.onRenameMember,
									}),
								),
					),
					draftRows.length > 0
						? h(
								'div',
								{ className: 'kb-railSection' },
								h(SectionHead, { title: t('draft.section'), count: draftRows.length }),
								h(
									'div',
									{ className: 'kb-draftsList' },
									draftRows.map((draft) =>
										h(DraftRow, {
											key: draft.id,
											t,
											draft,
											onRetry: props.onRetryDraft,
											onDismiss: props.onDismissDraft,
										}),
									),
								),
							)
						: null,
					h(
						'div',
						{ className: 'kb-railSection' },
						h(
							'div',
							{ className: 'kb-sectionActions' },
							h(
								Button,
								{
									size: 'sm',
									variant: 'ghost',
									icon: h(IconBook, { size: 13 }),
									title: t('team.rolePlaybooks'),
									onClick: () => typeof props.onOpenRoles === 'function' && props.onOpenRoles(),
								},
								t('team.rolePlaybooks'),
							),
						),
					),
				),
			)
		}

		// ------------------------------------------------------------------
		// Team member editor (right-hand drawer) + role playbook viewer
		// ------------------------------------------------------------------

		function wordCount(text) {
			const value = safeString(text).trim()
			if (!value) return 0
			return value.split(/\s+/).filter(Boolean).length
		}

		function MemberEditor(props) {
			const { t, member, roles, act, notify, onClose } = props
			const isEdit = Boolean(member && typeof member.id === 'string' && member.id)
			const roleOptions = safeArray(roles)
			const fallbackRole = roleOptions[0] && roleOptions[0].id ? roleOptions[0].id : ROLE_IDS[0]
			const nameRef = useRef(null)
			const [name, setName] = useState(isEdit ? safeString(member.name) : '')
			const [title, setTitle] = useState(isEdit ? safeString(member.title) : '')
			const [roleId, setRoleId] = useState(isEdit && safeString(member.roleId) ? member.roleId : fallbackRole)
			const [persona, setPersona] = useState(isEdit ? safeString(member.persona) : '')
			const [paused, setPaused] = useState(isEdit ? member.paused === true : false)
			const [nameError, setNameError] = useState('')
			const [formError, setFormError] = useState('')
			const [saving, setSaving] = useState(false)
			const [deleteArmed, setDeleteArmed] = useState(false)
			const [busyError, setBusyError] = useState('')
			const [forceArmed, setForceArmed] = useState(false)
			const [toggleBusy, setToggleBusy] = useState(false)
			const [preview, setPreview] = useState({ loading: false, text: '', error: '' })
			const memberId = isEdit ? member.id : ''

			useEscape(true, onClose)
			useFocusOnOpen(true, nameRef)
			useEffect(() => {
				if (isEdit) setPaused(member.paused === true)
			}, [isEdit, member && member.paused])
			useEffect(() => {
				if (!deleteArmed) return undefined
				const timer = window.setTimeout(() => setDeleteArmed(false), 4000)
				return () => window.clearTimeout(timer)
			}, [deleteArmed])
			useEffect(() => {
				if (!forceArmed) return undefined
				const timer = window.setTimeout(() => setForceArmed(false), 6000)
				return () => window.clearTimeout(timer)
			}, [forceArmed])

			const loadPreview = useCallback(async () => {
				if (!memberId) return
				setPreview({ loading: true, text: '', error: '' })
				const result = await act('memberPrompt', { memberId }, { key: 'memberPrompt', quiet: true, refresh: false })
				if (result && result.ok) {
					const value = result.value && typeof result.value === 'object' ? result.value : {}
					setPreview({ loading: false, text: safeString(value.prompt), error: '' })
				} else {
					const failure = result && result.error ? result.error : null
					setPreview({ loading: false, text: '', error: (failure && failure.message) || t('member.previewError') })
				}
			}, [act, memberId, t])

			useEffect(() => {
				if (!memberId) return
				void loadPreview()
			}, [memberId])

			const validate = () => {
				const value = name.trim()
				if (!value || value.length > 48) {
					setNameError(t('member.nameRequired'))
					const node = nameRef.current
					if (node && typeof node.focus === 'function') node.focus()
					return null
				}
				if (title.trim().length > 60) {
					setFormError(t('member.titleTooLong'))
					return null
				}
				if (persona.length > 6000) {
					setFormError(t('member.personaTooLong'))
					return null
				}
				if (!roleId) {
					setFormError(t('member.required'))
					return null
				}
				return { name: value, title: title.trim(), roleId, persona }
			}

			const submit = async () => {
				if (saving) return
				setFormError('')
				const form = validate()
				if (!form) return
				setSaving(true)
				const result = isEdit
					? await act('updateMember', { memberId: member.id, patch: form }, { key: 'memberSave', quiet: true })
					: await act('createMember', form, { key: 'memberSave', quiet: true })
				setSaving(false)
				if (result && result.ok) {
					notify('ok', isEdit ? t('toast.memberUpdated') : t('toast.memberCreated', { name: form.name }))
					onClose()
					return
				}
				const failure = result && result.error ? result.error : {}
				if (failure.code === 'member/name-taken') setNameError(failure.message || t('member.nameTaken'))
				else setFormError(failure.message || t('error.unknown'))
			}

			const remove = async (force) => {
				if (!isEdit || saving) return
				if (force === true) {
					if (!forceArmed) {
						setForceArmed(true)
						return
					}
				} else if (!deleteArmed) {
					setDeleteArmed(true)
					return
				}
				setSaving(true)
				setFormError('')
				setBusyError('')
				const result = await act(
					'deleteMember',
					{ memberId: member.id, force: force === true },
					{ key: 'memberDelete', quiet: true },
				)
				setSaving(false)
				if (result && result.ok) {
					notify('ok', t('toast.memberDeleted'))
					onClose()
					return
				}
				const failure = result && result.error ? result.error : {}
				if (failure.code === 'member/busy') {
					setBusyError(failure.message || t('member.busy'))
					setForceArmed(false)
				} else {
					setFormError(failure.message || t('error.unknown'))
				}
			}

			const togglePause = async () => {
				if (!isEdit || toggleBusy) return
				const next = !paused
				setToggleBusy(true)
				const result = await act(
					'updateMember',
					{ memberId: member.id, patch: { paused: next } },
					{ key: 'member-pause:' + member.id, quiet: true },
				)
				setToggleBusy(false)
				if (result && result.ok) {
					setPaused(next)
					notify('ok', t(next ? 'toast.agentPaused' : 'toast.agentResumed', { name: safeString(member.name) || member.id }))
				}
			}

			const personaCount = t('member.personaCount', {
				words: wordCount(persona),
				chars: persona.length,
				max: 6000,
			})

			return h(
				'div',
				{ className: 'kb-overlay kb-overlay--right', onClick: onClose },
				h(
					'div',
					{
						className: 'kb-drawer kb-drawer--member',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': isEdit ? t('member.edit') : t('member.new'),
						onClick: (event) => event.stopPropagation(),
					},
					h(
						'div',
						{ className: 'kb-drawerHead' },
						h(
							'div',
							{ className: 'kb-drawerHeadMain' },
							h('span', { className: 'kb-dialogTitle' }, isEdit ? t('member.edit') : t('member.new')),
							isEdit && roleId ? h('span', { className: 'kb-chip' }, roleDisplay(roleId, t, roleOptions)) : null,
						),
						h(
							'button',
							{
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon',
								title: t('member.close'),
								'aria-label': t('member.close'),
								onClick: onClose,
							},
							h(IconClose, { size: 15 }),
						),
					),
					h(
						'div',
						{ className: 'kb-drawerBody' },
						formError ? h('div', { className: 'kb-hint kb-hint--error', role: 'alert' }, formError) : null,
						h(
							'label',
							{ className: 'kb-field' },
							h('span', { className: 'kb-fieldLabel' }, t('member.name')),
							h('input', {
								ref: nameRef,
								className: classNames('kb-input', nameError && 'kb-input--invalid'),
								type: 'text',
								value: name,
								maxLength: 48,
								disabled: saving,
								placeholder: t('member.namePlaceholder'),
								'aria-label': t('member.name'),
								onChange: (event) => {
									setName(event.target.value)
									if (nameError) setNameError('')
								},
								onKeyDown: (event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										void submit()
									}
								},
							}),
							nameError ? h('span', { className: 'kb-hint kb-hint--error' }, nameError) : null,
						),
						h(
							'label',
							{ className: 'kb-field' },
							h('span', { className: 'kb-fieldLabel' }, t('member.title')),
							h('input', {
								className: 'kb-input',
								type: 'text',
								value: title,
								maxLength: 60,
								disabled: saving,
								placeholder: t('member.titlePlaceholder'),
								'aria-label': t('member.title'),
								onChange: (event) => setTitle(event.target.value),
							}),
						),
						h(
							'label',
							{ className: 'kb-field' },
							h('span', { className: 'kb-fieldLabel' }, t('member.role')),
							h(
								'select',
								{
									className: 'kb-select',
									value: roleId,
									disabled: saving || roleOptions.length === 0,
									'aria-label': t('member.role'),
									onChange: (event) => setRoleId(event.target.value),
								},
								roleOptions.map((role) => h('option', { key: role.id, value: role.id }, role.name)),
							),
							h('span', { className: 'kb-hint' }, t('member.roleHint')),
						),
						isEdit
							? h(
									'div',
									{ className: 'kb-toggleRow' },
									h(
										'span',
										{ className: 'kb-toggleText' },
										h('span', { className: 'kb-toggleTitle' }, paused ? t('member.resume') : t('member.pause')),
										h('span', { className: 'kb-toggleHint' }, t('member.pausedHint')),
									),
									h(
										Button,
										{
											size: 'sm',
											variant: paused ? 'primary' : undefined,
											icon: paused ? h(IconPlay, { size: 12 }) : h(IconPause, { size: 12 }),
											disabled: saving || toggleBusy,
											title: paused ? t('member.resume') : t('member.pause'),
											onClick: () => void togglePause(),
										},
										paused ? t('member.resume') : t('member.pause'),
									),
								)
							: null,
						h(
							'label',
							{ className: 'kb-formField' },
							h('span', { className: 'kb-fieldLabel' }, t('member.persona')),
							h('textarea', {
								className: classNames('kb-textarea', persona.length > 6000 && 'kb-textarea--invalid'),
								value: persona,
								rows: 7,
								maxLength: 6000,
								disabled: saving,
								placeholder: t('member.personaPlaceholder'),
								'aria-label': t('member.persona'),
								onChange: (event) => setPersona(event.target.value),
							}),
							h(
								'span',
								{ className: 'kb-fieldFoot' },
								h('span', { className: 'kb-hint' }, t('member.roleHint')),
								h('span', { className: 'kb-wordCount', title: personaCount }, personaCount),
							),
						),
						h(
							'div',
							{ className: 'kb-promptBox' },
							h(
								'div',
								{ className: 'kb-promptHead' },
								h('span', { className: 'kb-promptTitle' }, t('member.preview')),
								isEdit
									? h(
											Button,
											{
												size: 'sm',
												variant: 'ghost',
												icon: h(IconRefresh, { size: 12 }),
												disabled: preview.loading,
												title: t('member.previewLoad'),
												onClick: () => void loadPreview(),
											},
											t('member.previewLoad'),
										)
									: null,
							),
							!isEdit
								? h('div', { className: 'kb-hint' }, t('member.previewSaveFirst'))
								: preview.loading
									? h('div', { className: 'kb-centerLoading' }, h(Spinner), h('span', null, t('member.previewLoading')))
									: preview.error
										? h(
												'div',
												{ className: 'kb-hint kb-hint--error' },
												preview.error + ' · ' + t('member.previewHint'),
											)
										: h(
												'pre',
												{ className: 'kb-promptPre', tabIndex: 0, 'aria-label': t('member.preview') },
												preview.text || t('member.previewEmpty'),
											),
							isEdit ? h('div', { className: 'kb-hint' }, t('member.previewHint')) : null,
						),
						busyError
							? h(
									'div',
									{ className: 'kb-busyBox', role: 'alert' },
									h('span', { className: 'kb-hint kb-hint--error' }, busyError),
									h(
										'div',
										{ className: 'kb-sectionActions' },
										h(
											Button,
											{
												size: 'sm',
												variant: 'danger',
												disabled: saving,
												onClick: () => void remove(true),
											},
											forceArmed ? t('member.forceDeleteConfirm') : t('member.forceDelete'),
										),
										h(
											Button,
											{
												size: 'sm',
												variant: 'ghost',
												onClick: () => {
													setBusyError('')
													setForceArmed(false)
												},
											},
											t('actions.cancel'),
										),
									),
								)
							: null,
					),
					h(
						'div',
						{ className: 'kb-drawerFoot' },
						isEdit
							? h(
									Button,
									{
										size: 'sm',
										variant: 'danger',
										icon: h(IconTrash, { size: 12 }),
										disabled: saving,
										title: t('member.deleteHint'),
										onClick: () => void remove(false),
									},
									deleteArmed ? t('member.confirmDelete') : t('member.delete'),
								)
							: null,
						h('span', { className: 'kb-cardSpacer' }),
						h(Button, { size: 'sm', variant: 'ghost', disabled: saving, onClick: onClose }, t('actions.cancel')),
						h(
							Button,
							{
								size: 'sm',
								variant: 'primary',
								icon: saving ? h(Spinner) : h(IconCheck, { size: 12 }),
								disabled: saving || name.trim() === '',
								onClick: () => void submit(),
							},
							saving ? t('member.saving') : t('member.save'),
						),
					),
				),
			)
		}

		function RoleViewer(props) {
			const { t, roles, act, onClose } = props
			const list = safeArray(roles)
			const closeRef = useRef(null)
			const initialRoleId = list.length > 0 && list[0].id ? safeString(list[0].id) : ''
			const [selectedId, setSelectedId] = useState(initialRoleId)
			const [state, setState] = useState({ loading: initialRoleId !== '', role: null, error: null })

			useEscape(true, onClose)
			useFocusOnOpen(true, closeRef)

			const load = useCallback(
				async (roleId) => {
					if (!roleId) return
					setState({ loading: true, role: null, error: null })
					const result = await act('roleDetail', { roleId }, { key: 'roleDetail', quiet: true, refresh: false })
					if (result && result.ok) {
						const role = result.value && result.value.role && typeof result.value.role === 'object' ? result.value.role : null
						setState({ loading: false, role, error: role ? null : new Error(t('roles.error')) })
					} else {
						setState({ loading: false, role: null, error: (result && result.error) || new Error(t('roles.error')) })
					}
				},
				[act, t],
			)

			useEffect(() => {
				if (selectedId) void load(selectedId)
			}, [selectedId])

			const detail = () => {
				if (list.length === 0) return null
				if (state.loading) {
					return h('div', { className: 'kb-centerLoading' }, h(Spinner), h('span', null, t('roles.loading')))
				}
				if (state.error) {
					return h(
						'div',
						{ className: 'kb-roleBlock' },
						h('span', { className: 'kb-roleBlockTitle' }, t('roles.error')),
						h('div', { className: 'kb-hint kb-hint--error' }, (state.error && state.error.message) || t('roles.error')),
						h(
							Button,
							{ size: 'sm', icon: h(IconRefresh, { size: 12 }), onClick: () => void load(selectedId) },
							t('actions.retry'),
						),
					)
				}
				const role = state.role
				if (!role) return h('div', { className: 'kb-roleEmpty' }, t('roles.noDetail'))
				const playbook = role.playbook && typeof role.playbook === 'object' ? role.playbook : {}
				const steps = safeArray(playbook.steps).filter((step) => step && typeof step === 'object')
				const inputs = safeArray(playbook.inputs).filter((item) => typeof item === 'string' && item)
				const askUserWhen = safeArray(playbook.askUserWhen).filter((item) => typeof item === 'string' && item)
				const dod = safeArray(playbook.definitionOfDone).filter((item) => typeof item === 'string' && item)
				const claimColumns = safeArray(role.claimColumns)
				return h(
					React.Fragment,
					null,
					h(
						'div',
						{ className: 'kb-roleHead' },
						h('div', { className: 'kb-roleName' }, safeString(role.name) || t('role.' + safeString(role.id))),
						safeString(role.description) ? h('div', { className: 'kb-roleDesc' }, role.description) : null,
					),
					claimColumns.length > 0
						? h(
								'div',
								{ className: 'kb-roleBlock' },
								h('span', { className: 'kb-roleBlockTitle' }, t('roles.claimColumns')),
								h(
									'div',
									{ className: 'kb-roleItems' },
									claimColumns.map((column) =>
										h('span', { key: String(column), className: 'kb-chip kb-chip--brand' }, columnLabel(column, t)),
									),
								),
							)
						: null,
					safeString(playbook.mission)
						? h(
								'div',
								{ className: 'kb-roleBlock' },
								h('span', { className: 'kb-roleBlockTitle' }, t('roles.mission')),
								h('div', { className: 'kb-roleText' }, playbook.mission),
							)
						: null,
					inputs.length > 0
						? h(
								'div',
								{ className: 'kb-roleBlock' },
								h('span', { className: 'kb-roleBlockTitle' }, t('roles.inputs')),
								h(
									'ul',
									{ className: 'kb-roleList' },
									inputs.map((item, index) => h('li', { key: index }, item)),
								),
							)
						: null,
					steps.length > 0
						? h(
								'div',
								{ className: 'kb-roleBlock' },
								h('span', { className: 'kb-roleBlockTitle' }, t('roles.steps') + ' · ' + t('roles.stepCount', { n: steps.length })),
								steps.map((step, index) => {
									const artifacts = safeArray(step.artifacts).filter((artifact) => artifact !== null && artifact !== undefined)
									return h(
										'div',
										{ key: index, className: 'kb-roleStep' },
										h(
											'div',
											{ className: 'kb-roleStepHead' },
											h('span', { className: 'kb-roleStepNum' }, String(index + 1)),
											h('span', { className: 'kb-roleStepTitle' }, safeString(step.title)),
										),
										safeString(step.detail) ? h('div', { className: 'kb-roleStepDetail' }, step.detail) : null,
										artifacts.length > 0
											? h(
													'div',
													{ className: 'kb-roleItems' },
													h('span', { className: 'kb-roleBlockTitle' }, t('roles.artifacts')),
													artifacts.map((artifact, artifactIndex) =>
														h(
															'span',
															{ key: artifactIndex, className: 'kb-tag', title: String(artifact) },
															h('span', { className: 'kb-tagText' }, String(artifact)),
														),
													),
												)
											: null,
										safeString(step.gate)
											? h(
													'div',
													{ className: 'kb-roleGate' },
													h(IconWarning, { size: 11 }),
													h('span', null, t('roles.gate') + ': ' + step.gate),
												)
											: null,
									)
								}),
							)
						: null,
					askUserWhen.length > 0
						? h(
								'div',
								{ className: 'kb-roleBlock' },
								h('span', { className: 'kb-roleBlockTitle' }, t('roles.askUser')),
								h(
									'ul',
									{ className: 'kb-roleList' },
									askUserWhen.map((item, index) => h('li', { key: index }, item)),
								),
							)
						: null,
					safeString(playbook.escalation)
						? h(
								'div',
								{ className: 'kb-roleBlock' },
								h('span', { className: 'kb-roleBlockTitle' }, t('roles.escalation')),
								h('div', { className: 'kb-roleText' }, playbook.escalation),
							)
						: null,
					dod.length > 0
						? h(
								'div',
								{ className: 'kb-roleBlock' },
								h('span', { className: 'kb-roleBlockTitle' }, t('roles.dod')),
								dod.map((item, index) =>
									h(
										'div',
										{ key: index, className: 'kb-roleDodItem' },
										h('span', { className: 'kb-roleDodCheck' }, h(IconCheck, { size: 12 })),
										h('span', null, item),
									),
								),
							)
						: null,
				)
			}

			return h(
				'div',
				{ className: 'kb-overlay kb-overlay--right', onClick: onClose },
				h(
					'div',
					{
						className: 'kb-drawer kb-drawer--roles',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': t('roles.title'),
						onClick: (event) => event.stopPropagation(),
					},
					h(
						'div',
						{ className: 'kb-drawerHead' },
						h(
							'div',
							{ className: 'kb-drawerHeadMain' },
							h('span', { className: 'kb-dialogTitle' }, t('roles.title')),
							h('span', { className: 'kb-hint' }, t('roles.subtitle', { n: list.length })),
						),
						h(
							'button',
							{
								ref: closeRef,
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon',
								title: t('roles.close'),
								'aria-label': t('roles.close'),
								onClick: onClose,
							},
							h(IconClose, { size: 15 }),
						),
					),
					h(
						'div',
						{ className: 'kb-rolesBody' },
						h(
							'div',
							{ className: 'kb-rolesList', role: 'tablist', 'aria-label': t('roles.select') },
							list.length === 0
								? h('div', { className: 'kb-roleEmpty' }, t('roles.empty'))
								: list.map((role) => {
										const roleId = safeString(role.id)
										const stepCount = safeNumber(role.stepCount, 0)
										const sub = safeString(role.summary) || (stepCount > 0 ? t('roles.stepCount', { n: stepCount }) : '')
										return h(
											'button',
											{
												key: roleId,
												type: 'button',
												role: 'tab',
												'aria-selected': selectedId === roleId ? 'true' : 'false',
												className: classNames('kb-roleBtn', selectedId === roleId && 'kb-roleBtn--active'),
												title: safeString(role.name) || roleId,
												onClick: () => setSelectedId(roleId),
											},
											h('span', { className: 'kb-roleBtnName' }, safeString(role.name) || roleId),
											sub ? h('span', { className: 'kb-roleBtnSub' }, sub) : null,
										)
									}),
						),
						h('div', { className: 'kb-rolesDetail' }, detail()),
					),
				),
			)
		}
		// ------------------------------------------------------------------
		// Agent execution panel (drawer)
		// ------------------------------------------------------------------

		function ExecutionPanel(props) {
			const { t, ticket, roles, paused, pending, onRun, onCancelExecution, onAnswerExecution, openSession, accessModes } = props
			const execution = executionOf(ticket)
			const status = executionStatusOf(ticket)
			const blocked = ticket.blocked === true
			const questions = safeArray(ticket.block && ticket.block.questions)
			const needs = safeArray(ticket.block && ticket.block.needs)
			const laneRunnable = ['backlog', 'ready', 'review'].indexOf(ticket.column) !== -1
			const laneRoles = laneRunRoles(roles, ticket.column)
			const assignment = assignmentOf(ticket)
			const access = accessOptionsOf({ accessModes })
			const [answers, setAnswers] = useState([])
			const [grants, setGrants] = useState({})
			const [role, setRole] = useState('')
			const [mode, setMode] = useState('')
			const [cancelArmed, setCancelArmed] = useState(false)
			const suggestedMode = (assignment && assignment.accessMode) || (execution && execution.accessMode) || access.suggestions[ticket.column] || (access.options[0] && access.options[0].value) || 'workspace-write'
			const effectiveMode = mode || suggestedMode
			useEffect(() => {
				setAnswers([])
				setGrants({})
				setRole('')
				setMode('')
				setCancelArmed(false)
			}, [ticket.id, status, blocked])
			useEffect(() => {
				if (!cancelArmed) return undefined
				const timer = window.setTimeout(() => setCancelArmed(false), 4000)
				return () => window.clearTimeout(timer)
			}, [cancelArmed])
			const cancelButton = () =>
				h(
					Button,
					{
						size: 'sm',
						variant: 'danger',
						disabled: cancelPending,
						onClick: () => {
							if (!cancelArmed) {
								setCancelArmed(true)
								return
							}
							setCancelArmed(false)
							onCancelExecution(ticket)
						},
					},
					cancelArmed ? t('execution.confirmCancel') : t('execution.cancel'),
				)
			// An EPIC is structural: it never has an agent execution panel.
			if (ticket.type === 'epic') return null
			if (!execution && !blocked && !laneRunnable) return null
			const executePending = (pending['execute:' + ticket.id] || 0) > 0
			const answerPending = (pending['answer:' + ticket.id] || 0) > 0
			const cancelPending = (pending['cancel:' + ticket.id] || 0) > 0
			const ticketLaneRole = ticket.role && laneRoles.some((item) => item.id === ticket.role) ? ticket.role : ''
			const laneDefaultRole = laneRoles.some((item) => item.id === 'fullstack-developer') ? 'fullstack-developer' : laneRoles[0] && laneRoles[0].id
			const effectiveRole = role || (assignment && assignment.role) || (execution && execution.role) || ticketLaneRole || laneDefaultRole || ''
			const setAnswer = (index, value) => {
				setAnswers((previous) => {
					const next = previous.slice()
					next[index] = value
					return next
				})
			}
			const toggleGrant = (index) => {
				setGrants((previous) => ({ ...previous, [index]: !previous[index] }))
			}
			const sendAnswers = () => {
				const list = questions.length > 0 ? questions.map((_question, index) => answers[index] || '') : [answers[0] || '']
				const granted = needs.filter((_need, index) => grants[index]).map((need) => need.text)
				if (typeof onAnswerExecution === 'function') onAnswerExecution(ticket, list, granted)
			}
			const canSend = answerPending !== true && (questions.some((_question, index) => safeString(answers[index]).trim() !== '') || needs.some((_need, index) => grants[index]) || questions.length === 0)
			const head = h(
				'div',
				{ className: 'kb-execPanelHead' },
				h('span', { className: 'kb-execPanelTitle' }, t('execution.title')),
				status ? h(ExecutionChip, { status, t }) : null,
				execution && execution.role ? h('span', { className: 'kb-tag' }, t('role.' + execution.role)) : null,
				execution && execution.accessMode ? h('span', { className: 'kb-tag', title: t('execution.accessHint') }, accessLabel(execution.accessMode, access.options, t)) : null,
				execution && execution.sessionId
					? h(
							Button,
							{ size: 'sm', variant: 'ghost', icon: h(IconExternal, { size: 12 }), onClick: () => openSession(execution.sessionId) },
							t('execution.openSession'),
						)
					: null,
			)
			let body = null
			if (blocked) {
				body = h(
					'div',
					{ className: 'kb-waitBox' },
					h('div', { className: 'kb-waitQ' }, h('strong', null, t('execution.waitingTitle')), h('span', { className: 'kb-execHint' }, t('execution.waitingHint'))),
					// KB-59: the block reason is agent-written Markdown; the wait box keeps
					// its hint styling, so the body inherits the hint colour.
					(ticket.block && ticket.block.reason) || ticket.blockReason
						? h('div', { className: 'kb-execHint' }, h(MarkdownBody, { text: ticket.blockReason || ticket.block.reason, t }))
						: null,
					questions.length > 0
						? questions.map((question, index) =>
								h(
									'label',
									{ key: question.id || index, className: 'kb-waitQ' },
									// The visible question renders as Markdown; the input keeps a
									// plain projection of it as its accessible name (KB-59 D2).
									h(MarkdownBody, { text: question.text, t }),
									h('input', {
										className: 'kb-input',
										placeholder: t('execution.answerPlaceholder'),
										value: safeString(answers[index]),
										'aria-label': markdownPlainLabel(question.text),
										onChange: (event) => setAnswer(index, event.target.value),
									}),
								),
							)
						: h('label', { className: 'kb-waitQ' }, h('span', null, t('execution.waitingTitle')), h('input', { className: 'kb-input', placeholder: t('execution.answerPlaceholder'), value: safeString(answers[0]), onChange: (event) => setAnswer(0, event.target.value) })),
					needs.length > 0
						? needs.map((need, index) =>
								h(
									'label',
									{ key: need.id || index, className: 'kb-waitNeed' },
									h('input', { type: 'checkbox', checked: grants[index] === true, onChange: () => toggleGrant(index) }),
									h('span', { className: 'kb-waitKind' }, needKindLabel(need.kind, t)),
									// KB-59: each need statement renders as Markdown; the grant
									// checkbox, its wrapper and the Send rules stay untouched.
									h(MarkdownBody, { text: need.text, t }),
								),
							)
						: null,
					h(
						Button,
						{ variant: 'primary', size: 'sm', disabled: canSend !== true, onClick: sendAnswers },
						t('execution.sendAnswers'),
					),
				)
			} else if (status === 'running') {
				body = h(
					'div',
					{ className: 'kb-execRow' },
					h('span', { className: 'kb-execHint' }, t('execution.laneHint')),
					cancelButton(),
				)
			} else if (status === 'idle' || status === 'paused') {
				body = h(
					'div',
					{ className: 'kb-execRow' },
					h(Button, { size: 'sm', variant: 'primary', icon: h(IconPlay, { size: 12 }), disabled: executePending, onClick: () => onRun(ticket) }, t('execution.continue')),
					cancelButton(),
				)
			} else {
				const parts = []
				if (assignment) {
					parts.push(
						h(
							'div',
							{ className: 'kb-execHint', title: t('execution.handoffHint') },
							h('strong', null, t('execution.handoff') + ': '),
							roleDisplay(assignment.role, t, roles),
							assignment.agentName ? ' · ' + t('execution.suggestedAgent', { name: assignment.agentName }) : '',
						),
					)
				}
				if (execution && status === 'done') {
					// KB-59: the stored report is agent-written Markdown rendered inside the
					// unchanged 120px scroll wrapper, so the panel buttons stay reachable.
					parts.push(
						execution.report
							? h('div', { className: 'kb-execReport' }, h(MarkdownBody, { text: execution.report, t }))
							: h('span', { className: 'kb-execHint' }, t('execution.done')),
					)
				}
				if (execution && (status === 'failed' || status === 'cancelled') && execution.error) {
					parts.push(h('span', { className: 'kb-hint kb-hint--error' }, execution.error))
				}
				if (laneRunnable) {
					const startRole = assignment ? assignment.role : effectiveRole
					const startLabel = assignment
						? t('execution.startRole', { role: roleDisplay(startRole, t, roles) })
						: execution && status === 'done'
							? t('execution.retry')
							: t('execution.run')
					parts.push(
						h(
							'div',
							{ className: 'kb-execRow' },
							laneRoles.length > 0
								? h(
										'select',
										{
											className: 'kb-select',
											style: { width: '170px' },
											value: startRole,
											'aria-label': t('execution.role'),
											onChange: (event) => setRole(event.target.value),
										},
										laneRoles.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
									)
								: null,
							h(
								'select',
								{
									className: 'kb-select',
									style: { width: '150px' },
									value: effectiveMode,
									'aria-label': t('execution.accessMode'),
									title: t('execution.accessHint'),
									onChange: (event) => setMode(event.target.value),
								},
								access.options.map((item) => h('option', { key: item.value, value: item.value, title: item.description }, accessName(item.value, item.name, t))),
							),
							h(
								Button,
								{
									variant: 'primary',
									size: 'sm',
									icon: h(IconPlay, { size: 12 }),
									disabled: executePending || paused,
									onClick: () => onRun(ticket, startRole, effectiveMode),
								},
								startLabel,
							),
						),
					)
					parts.push(h('span', { className: 'kb-execHint' }, assignment ? t('execution.handoffHint') : t('execution.laneHint')))
				}
				body = h('div', { className: 'kb-execPanelBody' }, ...parts)
			}
			if (!head || !body) return null
			return h(
				'div',
				{ className: 'kb-execPanel' },
				head,
				body,
				// KB-59: below the panel body the non-done report renders the same way,
				// inside the same 120px scroll wrapper.
				execution && execution.report && status !== 'done'
					? h('div', { className: 'kb-execReport' }, h(MarkdownBody, { text: execution.report, t }))
					: null,
			)
		}

		// ------------------------------------------------------------------
		// Ticket detail drawer
		// ------------------------------------------------------------------

		function TicketDrawer(props) {
			const { t, ticket, team, thoughts, deletedThoughtIds, paused, pending, act, notify, roleName, openSession, onOpenThought, onClose, onRun, onCancelExecution, onAnswerExecution, children, onOpenTicket } = props
			const closeRef = useRef(null)
			const [draftTitle, setDraftTitle] = useState(safeString(ticket.title))
			const [draftDescription, setDraftDescription] = useState(safeString(ticket.description))
			const [draftLabels, setDraftLabels] = useState(safeArray(ticket.labels).join(', '))
			const [draftBlockReason, setDraftBlockReason] = useState(safeString(ticket.blockReason))
			const [checklistDraft, setChecklistDraft] = useState('')
			const [commentDraft, setCommentDraft] = useState('')
			const [deleteArmed, setDeleteArmed] = useState(false)
			const [savedTick, setSavedTick] = useState(0)
			// KB-58: the description/PRD opens as a rendered read view; `edit` is
			// today's textarea and `preview` renders the unsaved draft.
			const [descriptionMode, setDescriptionMode] = useState('read')

			useEscape(true, onClose)
			useFocusOnOpen(true, closeRef)
			useEffect(() => {
				if (!savedTick) return undefined
				const timer = window.setTimeout(() => setSavedTick(0), 1600)
				return () => window.clearTimeout(timer)
			}, [savedTick])
			useEffect(() => {
				if (!deleteArmed) return undefined
				const timer = window.setTimeout(() => setDeleteArmed(false), 4000)
				return () => window.clearTimeout(timer)
			}, [deleteArmed])

			const isPaused = paused === true
			const isEpic = ticket.type === 'epic'
			// KB-58: the read view renders the persisted source; Preview renders the
			// live draft so unsaved text is never hidden or discarded.
			const storedDescription = safeString(ticket.description)
			const descriptionLabelText = isEpic ? t('detail.epicPrd') : t('detail.description')
			const descriptionEmptyText = isEpic ? t('detail.epicPrdEmpty') : t('detail.descriptionEmpty')
			const toggleDescriptionMode = (mode) => {
				if (isPaused) return
				setDescriptionMode((current) => (current === mode ? 'read' : mode))
			}
			const renderDescriptionRead = (source) => {
				if (safeString(source).trim() === '') {
					return h('div', { className: 'kb-hint kb-descEmpty', 'data-description-empty': 'true' }, descriptionEmptyText)
				}
				return h(MarkdownBody, { text: source, label: descriptionLabelText, t })
			}
			const childTickets = safeArray(children).filter((child) => child && typeof child.id === 'string')
			const childStatus = (child) => {
				if (child.blocked === true) return { label: t('card.blocked'), cls: 'error' }
				const status = executionStatusOf(child)
				if (status) return { label: executionChipLabel(status, t), cls: status === 'running' ? 'brand' : 'idle' }
				return { label: t('status.idle'), cls: 'idle' }
			}
			const owner = ticket.owner && typeof ticket.owner === 'object' ? ticket.owner : null
			const checklist = safeArray(ticket.checklist).filter((item) => item && typeof item.id === 'string')
			const doneCount = checklist.filter((item) => item.done === true).length
			const comments = safeArray(ticket.comments)
				.filter((comment) => comment && typeof comment.text === 'string')
				.slice()
				.sort((left, right) => safeNumber(right.at, 0) - safeNumber(left.at, 0))
			const activity = safeArray(ticket.activity)
				.filter((entry) => entry && typeof entry.text === 'string')
				.slice(-20)
				.reverse()
			const columnIndex = COLUMNS.indexOf(ticket.column)
			// An EPIC never moves out of Backlog; the drawer disables the controls.
			const canMove = !isPaused && ticket.blocked !== true && !isEpic
			const movePending = (pending['move:' + ticket.id] || 0) > 0
			const blockPending = (pending['block:' + ticket.id] || 0) > 0
			const deletePending = (pending['delete:' + ticket.id] || 0) > 0
			const commentPending = (pending['comment:' + ticket.id] || 0) > 0
			const assignPending = (pending['assign:' + ticket.id] || 0) > 0
			const ownerOptions = []
			safeArray(team)
				.filter((agent) => agent && typeof agent.sessionId === 'string')
				.forEach((agent) => {
					ownerOptions.push({ id: agent.sessionId, name: safeString(agent.name) || agent.sessionId })
				})
			if (owner && owner.sessionId && !ownerOptions.some((option) => option.id === owner.sessionId)) {
				ownerOptions.push({ id: owner.sessionId, name: safeString(owner.name) || owner.sessionId })
			}

			const flashSaved = () => setSavedTick((value) => value + 1)

			const commitTitle = () => {
				const next = draftTitle.trim()
				if (!next) {
					setDraftTitle(safeString(ticket.title))
					return
				}
				if (next === safeString(ticket.title)) return
				void act('updateTicket', { ticketId: ticket.id, patch: { title: next } }, { key: 'title:' + ticket.id, quiet: true }).then(
					(result) => {
						if (result.ok) flashSaved()
						else setDraftTitle(safeString(ticket.title))
					},
				)
			}

			const commitDescription = () => {
				const next = draftDescription
				if (next === safeString(ticket.description)) return
				void act(
					'updateTicket',
					{ ticketId: ticket.id, patch: { description: next } },
					{ key: 'description:' + ticket.id, quiet: true },
				).then((result) => {
					if (result.ok) flashSaved()
				})
			}

			const commitLabels = () => {
				const labels = draftLabels
					.split(',')
					.map((label) => label.trim())
					.filter(Boolean)
					.slice(0, 12)
				const current = safeArray(ticket.labels)
				if (labels.length === current.length && labels.every((label, index) => label === current[index])) return
				void act('updateTicket', { ticketId: ticket.id, patch: { labels } }, { key: 'labels:' + ticket.id, quiet: true }).then((result) => {
					if (result.ok) flashSaved()
				})
			}

			const changePriority = (event) => {
				const priority = event.target.value
				if (PRIORITIES.indexOf(priority) === -1) return
				void act('updateTicket', { ticketId: ticket.id, patch: { priority } }, { key: 'priority:' + ticket.id, quiet: true }).then((result) => {
					if (result.ok) flashSaved()
				})
			}

			const changeRole = (event) => {
				const role = event.target.value
				void act(
					'updateTicket',
					{ ticketId: ticket.id, patch: { role: role ? role : null } },
					{ key: 'role-ticket:' + ticket.id, quiet: true },
				).then((result) => {
					if (result.ok) flashSaved()
				})
			}

			const changeOwner = (event) => {
				const sessionId = event.target.value
				void act('assignTicket', { ticketId: ticket.id, sessionId: sessionId ? sessionId : null }, { key: 'assign:' + ticket.id })
			}

			const moveTo = (column) => {
				if (isPaused) {
					notify('warn', t('toast.boardPausedMove'))
					return
				}
				if (ticket.blocked === true) {
					notify('warn', t('toast.blockedMove'))
					return
				}
				if (Math.abs(COLUMNS.indexOf(column) - columnIndex) !== 1) return
				void act('moveTicket', { ticketId: ticket.id, column }, { key: 'move:' + ticket.id })
			}

			const toggleBlock = () => {
				if (ticket.blocked === true) {
					void act('blockTicket', { ticketId: ticket.id, blocked: false }, { key: 'block:' + ticket.id })
				} else {
					void act(
						'blockTicket',
						{ ticketId: ticket.id, blocked: true, reason: draftBlockReason.trim() },
						{ key: 'block:' + ticket.id },
					)
				}
			}

			const commitBlockReason = () => {
				if (ticket.blocked !== true) return
				const reason = draftBlockReason.trim()
				if (reason === safeString(ticket.blockReason)) return
				void act('blockTicket', { ticketId: ticket.id, blocked: true, reason }, { key: 'block:' + ticket.id, quiet: true })
			}

			const addChecklistItem = () => {
				const text = checklistDraft.trim()
				if (!text || isPaused) return
				void act('checklistAdd', { ticketId: ticket.id, text }, { key: 'checklist-add:' + ticket.id, quiet: true }).then((result) => {
					if (result.ok) setChecklistDraft('')
				})
			}

			const toggleChecklistItem = (item) => {
				if (isPaused) return
				void act('checklistToggle', { ticketId: ticket.id, itemId: item.id }, { key: 'check:' + item.id, quiet: true })
			}

			const removeChecklistItem = (item) => {
				void act('checklistRemove', { ticketId: ticket.id, itemId: item.id }, { key: 'check-remove:' + item.id, quiet: true })
			}

			const submitComment = () => {
				const text = commentDraft.trim()
				if (!text) return
				void act('comment', { ticketId: ticket.id, text }, { key: 'comment:' + ticket.id }).then((result) => {
					if (result.ok) setCommentDraft('')
				})
			}

			const removeTicket = () => {
				if (!deleteArmed) {
					setDeleteArmed(true)
					return
				}
				void act('deleteTicket', { ticketId: ticket.id }, { key: 'delete:' + ticket.id }).then((result) => {
					if (result.ok) onClose()
				})
			}

			// KB-5: the thought this ticket came from. `deletedThoughtIds` separates a
			// soft-deleted thought ("Thought deleted") from one outside the 50-row window.
			const thoughtId = safeString(ticket.thoughtId)
			const linkedThought = thoughtId ? safeArray(thoughts).find((thought) => thought && thought.id === thoughtId) ?? null : null
			const thoughtDeleted = thoughtId !== '' && !linkedThought && safeArray(deletedThoughtIds).indexOf(thoughtId) !== -1
			const thoughtChip = thoughtId === ''
				? null
				: h(
						'div',
						{ className: 'kb-ticketThoughtRow' },
						h('span', { className: 'kb-ticketThoughtLabel' }, t('thought.ticketChip')),
						thoughtDeleted
							? h('span', { className: 'kb-ticketThoughtDeleted' }, t('thought.deletedFallback'))
							: linkedThought
								? h(
										'button',
										{
											type: 'button',
											className: 'kb-thoughtChip',
											title: thoughtStatusLabel(linkedThought.status, t),
											onClick: () => {
												if (linkedThought.sessionId) openSession(linkedThought.sessionId)
												else onOpenThought(linkedThought.id)
											},
										},
										thoughtId,
								  )
								: h('span', { className: 'kb-thoughtChip', title: t('thought.unavailable') }, thoughtId),
						linkedThought ? h('span', { className: 'kb-ticketThoughtLabel' }, thoughtStatusLabel(linkedThought.status, t)) : null,
					  )

			const prioritySelect = h(
				'select',
				{
					className: 'kb-select kb-select--compact',
					value: PRIORITIES.indexOf(ticket.priority) === -1 ? 'medium' : ticket.priority,
					disabled: isPaused,
					'aria-label': t('detail.priority'),
					title: t('detail.priority'),
					onChange: changePriority,
				},
				PRIORITIES.map((priority) => h('option', { key: priority, value: priority }, priorityLabel(priority, t))),
			)

			return h(
				'div',
				{ className: 'kb-overlay kb-overlay--right', onClick: onClose },
				h(
					'div',
					{
						className: 'kb-drawer',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': t('detail.ticket', { id: safeString(ticket.id) }),
						onClick: (event) => event.stopPropagation(),
					},
					h(
						'div',
						{ className: 'kb-drawerHead' },
						h(
							'div',
							{ className: 'kb-drawerHeadMain' },
							h('span', { className: 'kb-drawerId' }, safeString(ticket.id)),
							h('span', { className: 'kb-chip kb-chip--' + cardTypeClass(ticket.type) }, typeLabel(ticket.type, t)),
							savedTick > 0 ? h('span', { className: 'kb-savedHint' }, h(IconCheck, { size: 11 }), t('actions.saved')) : null,
						),
						prioritySelect,
						h(
							'button',
							{
								ref: closeRef,
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon',
								title: t('detail.close'),
								'aria-label': t('detail.close'),
								onClick: onClose,
							},
							h(IconClose, { size: 15 }),
						),
					),
					h(
						'div',
						{ className: 'kb-drawerBody' },
						thoughtChip,
						h(
							'div',
							{ className: 'kb-section', 'data-description-section': 'true' },
							h('input', {
								className: 'kb-titleInput',
								value: draftTitle,
								disabled: isPaused,
								placeholder: t('detail.titlePlaceholder'),
								'aria-label': t('detail.title'),
								onChange: (event) => setDraftTitle(event.target.value),
								onBlur: commitTitle,
								onKeyDown: (event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										event.currentTarget.blur()
									}
								},
							}),
							h(
								'div',
								{ className: 'kb-descHead' },
								isEpic ? h('div', { className: 'kb-fieldLabel' }, t('detail.epicPrd')) : null,
								h(
									'div',
									{ className: 'kb-descModes', role: 'group', 'aria-label': t('detail.descriptionMode') },
									h(
										'button',
										{
											type: 'button',
											className: 'kb-btn kb-btn--sm kb-descMode',
											'aria-pressed': descriptionMode === 'edit' ? 'true' : 'false',
											disabled: isPaused,
											onClick: () => toggleDescriptionMode('edit'),
										},
										t('detail.edit'),
									),
									h(
										'button',
										{
											type: 'button',
											className: 'kb-btn kb-btn--sm kb-descMode',
											'aria-pressed': descriptionMode === 'preview' ? 'true' : 'false',
											disabled: isPaused,
											onClick: () => toggleDescriptionMode('preview'),
										},
										t('detail.preview'),
									),
								),
							),
							isEpic ? h('div', { className: 'kb-hint' }, t('detail.epicPrdHint')) : null,
							descriptionMode === 'edit'
								? h('textarea', {
										className: 'kb-description',
										value: draftDescription,
										disabled: isPaused,
										placeholder: isEpic ? t('detail.epicPrdHint') : t('detail.descriptionPlaceholder'),
										'aria-label': isEpic ? t('detail.epicPrd') : t('detail.description'),
										rows: isEpic ? 6 : 3,
										onChange: (event) => setDraftDescription(event.target.value),
										onBlur: commitDescription,
									})
								: h(
										'div',
										{ className: 'kb-descRead', 'data-description-mode': descriptionMode },
										renderDescriptionRead(descriptionMode === 'preview' ? draftDescription : storedDescription),
									),
						),
						isEpic
							? h(
									'div',
									{ className: 'kb-section', 'data-epic-children': 'true' },
									h(SectionHead, { title: t('detail.children'), count: childTickets.length }),
									childTickets.length === 0
										? h(
												'div',
												{ className: 'kb-emptyLine kb-childrenEmpty' },
												h('div', null, t('detail.childrenEmpty')),
												h('div', { className: 'kb-hint' }, t('detail.childrenEmptyHint')),
											)
										: h(
												'div',
												{ className: 'kb-childList' },
												childTickets.map((child) => {
													const status = childStatus(child)
													return h(
														'button',
														{
															key: child.id,
															type: 'button',
															className: 'kb-childRow',
															'data-child-id': child.id,
															'data-column': safeString(child.column),
															'data-status': status.label,
															'aria-label': t('card.open', { id: child.id }),
															onClick: () => {
																if (typeof onOpenTicket === 'function') onOpenTicket(child.id)
															},
														},
														h('span', { className: 'kb-childId' }, safeString(child.id)),
														h('span', { className: 'kb-childTitle', title: safeString(child.title) }, safeString(child.title)),
														h(
															'span',
															{ className: 'kb-chip kb-chip--idle' },
															h('span', { className: 'kb-dot kb-dot--' + safeString(child.column) }),
															h('span', { className: 'kb-chipText' }, t('columns.' + safeString(child.column))),
														),
														h(
															'span',
															{ className: 'kb-chip kb-chip--' + status.cls, title: t('detail.childStatus') + ': ' + status.label },
															h('span', { className: 'kb-chipText' }, status.label),
														),
													)
												}),
											),
								)
							: null,
						h(ExecutionPanel, {
							t,
							ticket,
							roles: props.roles,
							paused,
							pending,
							accessModes: props.accessModes,
							onRun,
							onCancelExecution,
							onAnswerExecution,
							openSession,
						}),
						h(
							'div',
							{ className: 'kb-section' },
							h(SectionHead, { title: t('detail.column') }),
							h(
								'div',
								{ className: 'kb-colButtons' },
								COLUMNS.map((column) => {
									const active = ticket.column === column
									const adjacent = Math.abs(COLUMNS.indexOf(column) - columnIndex) === 1
									const disabled = active || !canMove || !adjacent || movePending
									return h(
										'button',
										{
											key: column,
											type: 'button',
											className: classNames('kb-colBtn', active && 'kb-colBtn--active'),
											disabled,
											title: active ? undefined : !adjacent ? t('detail.moveHint') : t('columns.' + column),
											onClick: () => moveTo(column),
										},
										h('span', { className: 'kb-dot kb-dot--' + column }),
										t('columns.' + column),
									)
								}),
							),
							h(
								'div',
								{ className: classNames('kb-hint', ticket.blocked === true && 'kb-hint--error', isEpic && 'kb-hint--epic') },
								isEpic ? t('detail.epicLocked') : t('detail.moveHint'),
							),
						),
						h(
							'div',
							{ className: 'kb-section' },
							h(SectionHead, { title: t('detail.role') }),
							h(
								'label',
								{ className: 'kb-field' },
								h(
									'select',
									{
										className: 'kb-select',
										value: safeString(ticket.role),
										disabled: isPaused,
										'aria-label': t('detail.role'),
										onChange: changeRole,
									},
									h('option', { value: '' }, t('detail.roleNone')),
									safeArray(props.roles).map((option) => h('option', { key: option.id, value: option.id }, option.name)),
								),
							),
						),
						h(
							'div',
							{ className: 'kb-section' },
							h(SectionHead, { title: t('detail.owner') }),
							h(
								'div',
								{ className: 'kb-ownerRow' },
								owner
									? h(
											'span',
											{ className: 'kb-ownerName' },
											h(Avatar, { name: owner.name, lead: false }),
											safeString(owner.name),
											owner.role ? h('span', { className: 'kb-ownerSub' }, roleName(owner.role)) : null,
										)
									: h('span', { className: 'kb-hint' }, t('detail.ownerNone')),
								owner
									? h(
											Button,
											{
												size: 'sm',
												variant: 'ghost',
												icon: h(IconExternal, { size: 12 }),
												title: t('actions.openSession'),
												onClick: () => openSession(owner.sessionId),
											},
											t('actions.openSession'),
										)
									: null,
							),
							h(
								'label',
								{ className: 'kb-field' },
								h('span', { className: 'kb-fieldLabel' }, t('detail.ownerSelect')),
								h(
									'select',
									{
										className: 'kb-select',
										value: owner ? owner.sessionId : '',
										disabled: isPaused || assignPending,
										onChange: changeOwner,
									},
									h('option', { value: '' }, t('detail.ownerNone')),
									ownerOptions.map((option) => h('option', { key: option.id, value: option.id }, option.name)),
								),
							),
						),
						h(
							'div',
							{ className: 'kb-section' },
							h(SectionHead, {
								title: t('detail.block'),
								extra: h(
									'button',
									{
										type: 'button',
										className: classNames('kb-btn', 'kb-btn--sm', ticket.blocked === true ? 'kb-btn--danger' : undefined),
										disabled: blockPending || isPaused,
										onClick: toggleBlock,
									},
									ticket.blocked === true ? t('actions.unblock') : t('actions.block'),
								),
							}),
							h(
								'div',
								{ className: 'kb-blockRow' },
								ticket.blocked === true
									? h('div', { className: 'kb-blockReasonText' }, safeString(ticket.blockReason) || t('card.blocked'))
									: null,
								h('input', {
									className: 'kb-input',
									value: draftBlockReason,
									disabled: isPaused || blockPending,
									placeholder: t('detail.blockReasonPlaceholder'),
									'aria-label': t('detail.blockReason'),
									onChange: (event) => setDraftBlockReason(event.target.value),
									onBlur: commitBlockReason,
									onKeyDown: (event) => {
										if (event.key === 'Enter') {
											event.preventDefault()
											event.currentTarget.blur()
										}
									},
								}),
							),
						),
						h(
							'div',
							{ className: 'kb-section' },
							h(SectionHead, { title: t('detail.labels') }),
							h(
								'label',
								{ className: 'kb-field' },
								h('input', {
									className: 'kb-input',
									value: draftLabels,
									disabled: isPaused,
									placeholder: t('detail.labelsPlaceholder'),
									'aria-label': t('detail.labels'),
									onChange: (event) => setDraftLabels(event.target.value),
									onBlur: commitLabels,
									onKeyDown: (event) => {
										if (event.key === 'Enter') {
											event.preventDefault()
											event.currentTarget.blur()
										}
									},
								}),
								h('span', { className: 'kb-hint' }, t('detail.labelsHint')),
							),
						),
						h(
							'div',
							{ className: 'kb-section' },
							h(SectionHead, {
								title: t('detail.checklist'),
								count: checklist.length > 0 ? String(doneCount) + '/' + String(checklist.length) : undefined,
							}),
							checklist.length === 0
								? h('div', { className: 'kb-emptyLine' }, t('detail.checklistPlaceholder'))
								: checklist.map((item) =>
										h(
											'div',
											{ key: item.id, className: 'kb-checkItem' },
											h('input', {
												type: 'checkbox',
												className: 'kb-checkbox',
												checked: item.done === true,
												disabled: isPaused,
												'aria-label': item.text,
												onChange: () => toggleChecklistItem(item),
											}),
											h('span', { className: classNames('kb-checkText', item.done === true && 'kb-checkText--done') }, item.text),
											h(
												'button',
												{
													type: 'button',
													className: 'kb-btn kb-btn--ghost kb-btn--icon kb-btn--sm',
													title: t('actions.delete'),
													'aria-label': t('actions.delete') + ' ' + item.text,
													disabled: isPaused,
													onClick: () => removeChecklistItem(item),
												},
												h(IconClose, { size: 11 }),
											),
										),
									),
							h(
								'div',
								{ className: 'kb-inlineAdd' },
								h('input', {
									className: 'kb-input',
									value: checklistDraft,
									disabled: isPaused,
									placeholder: t('detail.checklistPlaceholder'),
									'aria-label': t('detail.checklistPlaceholder'),
									onChange: (event) => setChecklistDraft(event.target.value),
									onKeyDown: (event) => {
										if (event.key === 'Enter') {
											event.preventDefault()
											addChecklistItem()
										}
									},
								}),
								h(
									'button',
									{
										type: 'button',
										className: 'kb-btn kb-btn--icon',
										title: t('actions.add'),
										'aria-label': t('actions.add'),
										disabled: isPaused || !checklistDraft.trim(),
										onClick: addChecklistItem,
									},
									h(IconPlus, { size: 14 }),
								),
							),
						),
						h(
							'div',
							{ className: 'kb-section' },
							h(SectionHead, { title: t('detail.comments'), count: comments.length }),
							comments.length > 0
								? comments.map((comment) =>
										h(
											'div',
											{ key: comment.id, className: 'kb-comment' },
											h(
												'div',
												{ className: 'kb-commentHead' },
												h('span', { className: 'kb-commentAuthor' }, safeString(comment.author) || 'agent'),
												h('span', null, formatAge(comment.at, t)),
											),
											// KB-59: comment bodies are agent-written Markdown; the
											// author, relative time and newest-first order stay as-is.
											h('div', { className: 'kb-commentText' }, h(MarkdownBody, { text: comment.text, t })),
										),
									)
								: h('div', { className: 'kb-emptyLine' }, t('detail.commentsEmpty')),
							h(
								'div',
								{ className: 'kb-inlineAdd' },
								h('input', {
									className: 'kb-input',
									value: commentDraft,
									disabled: isPaused,
									placeholder: t('detail.commentsPlaceholder'),
									'aria-label': t('detail.commentsPlaceholder'),
									onChange: (event) => setCommentDraft(event.target.value),
									onKeyDown: (event) => {
										if (event.key === 'Enter') {
											event.preventDefault()
											submitComment()
										}
									},
								}),
								h(
									Button,
									{
										size: 'sm',
										disabled: commentPending || isPaused || !commentDraft.trim(),
										title: t('detail.commentSubmit'),
										onClick: submitComment,
									},
									t('detail.commentSubmit'),
								),
							),
						),
						h(
							'div',
							{ className: 'kb-section' },
							h(SectionHead, { title: t('detail.activity') }),
							activity.length === 0
								? h('div', { className: 'kb-emptyLine' }, t('detail.activityEmpty'))
								: activity.map((entry) =>
										h(
											'div',
											{ key: entry.id, className: 'kb-activityItem' },
											h('span', { className: 'kb-activityBullet' }),
											h('span', { className: 'kb-activityText' }, h('b', null, safeString(entry.by) || 'system'), ' — ', entry.text),
											h('span', { className: 'kb-activityTime' }, formatAge(entry.at, t)),
										),
									),
						),
						ticket.source && typeof ticket.source === 'object'
							? h(
									'div',
									{ className: 'kb-section' },
									h(SectionHead, { title: t('detail.source') }),
									h(
										'div',
										{ className: 'kb-cardMeta' },
										h('span', { className: 'kb-tag' }, t('source.' + safeString(ticket.source.kind))),
										h('span', { className: 'kb-docPath' }, safeString(ticket.source.ref)),
										ticket.source.url
											? h(
													'a',
													{ className: 'kb-link', href: ticket.source.url, target: '_blank', rel: 'noopener noreferrer' },
													h(IconExternal, { size: 12 }),
												)
											: null,
									),
								)
							: null,
						h(
							'div',
							{ className: 'kb-hint' },
							t('detail.created', { ago: formatAge(ticket.createdAt, t) }) +
								' · ' +
								t('detail.updated', { ago: formatAge(ticket.updatedAt, t) }) +
								(ticket.acceptedAt ? ' · ' + t('detail.accepted', { ago: formatAge(ticket.acceptedAt, t) }) : ''),
						),
					),
					h(
						'div',
						{ className: 'kb-drawerFoot' },
						h('span', { className: 'kb-hint' }, t('detail.deleteHint')),
						h('span', { className: 'kb-cardSpacer' }),
						deleteArmed
							? h(Button, { size: 'sm', variant: 'ghost', onClick: () => setDeleteArmed(false) }, t('actions.cancel'))
							: null,
						h(
							Button,
							{
								size: 'sm',
								variant: 'danger',
								icon: h(IconTrash, { size: 12 }),
								disabled: deletePending || isPaused,
								onClick: removeTicket,
							},
							deleteArmed ? t('actions.confirmDelete') : t('actions.delete'),
						),
					),
				),
			)
		}

		// ------------------------------------------------------------------
		// New ticket dialog
		// ------------------------------------------------------------------

		// ------------------------------------------------------------------
		// Thought intake (KB-1): Speak-a-thought dialog + Thoughts drawer
		// ------------------------------------------------------------------

		// KB-5 additive statuses: `queued` (captured while paused) and `cancelled`.
		const THOUGHT_STATUSES = ['recorded', 'working', 'done', 'failed', 'queued', 'cancelled']

		/** Localized status text; status is always conveyed by words, never colour alone. */
		function thoughtStatusLabel(status, t) {
			const value = safeString(status)
			return t('thought.status.' + (THOUGHT_STATUSES.indexOf(value) === -1 ? 'unknown' : value))
		}

		// ------------------------------------------------------------------
		// Voice dictation (KB-2)
		//
		// The installed voice bundle owns recognition and exposes an optional
		// experimental `remote.speech` namespace with `catalog()` and
		// `transcribe({ audioBase64, providerId, language })`. It has no
		// streaming segment API and no exported capture control, so this dialog
		// records one fragment itself, sends that one complete 16 kHz mono PCM16
		// WAV on stop and appends the single final transcript. No partial text is
		// invented and nothing submits without the user pressing Send.
		// ------------------------------------------------------------------

		const THOUGHT_MAX_LENGTH = 4000
		const VOICE_DEFAULT_MAX_SECONDS = 120
		const VOICE_DEFAULT_MAX_BYTES = 4 * 1024 * 1024
		const VOICE_READY_PHASES = ['ready', 'standby', 'waking']

		function initialVoiceState() {
			return { phase: 'checking', pressed: false, reason: '', error: '', announcement: '', elapsedSeconds: 0, lastTranscript: '' }
		}

		/** Append one final transcript after existing text without overwriting it. */
		function appendTranscript(current, transcript, maxLength) {
			const base = safeString(current)
			const extra = safeString(transcript)
				.replace(/\s+/g, ' ')
				.trim()
			if (extra === '') return base
			const next = base === '' ? extra : /\s$/.test(base) ? base + extra : base + ' ' + extra
			const limit = safeNumber(maxLength, THOUGHT_MAX_LENGTH)
			return next.length > limit ? next.slice(0, limit) : next
		}

		/** Encode mono float samples as the canonical 16 kHz PCM16 WAV the bundle accepts. */
		function encodeWave(samples) {
			const bytes = new Uint8Array(44 + samples.length * 2)
			const view = new DataView(bytes.buffer)
			const text = (at, value) => {
				for (let index = 0; index < value.length; index += 1) bytes[at + index] = value.charCodeAt(index)
			}
			text(0, 'RIFF')
			view.setUint32(4, bytes.length - 8, true)
			text(8, 'WAVE')
			text(12, 'fmt ')
			view.setUint32(16, 16, true)
			view.setUint16(20, 1, true)
			view.setUint16(22, 1, true)
			view.setUint32(24, 16000, true)
			view.setUint32(28, 32000, true)
			view.setUint16(32, 2, true)
			view.setUint16(34, 16, true)
			text(36, 'data')
			view.setUint32(40, samples.length * 2, true)
			for (let index = 0; index < samples.length; index += 1) {
				const sample = Math.max(-1, Math.min(1, samples[index]))
				view.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
			}
			return bytes
		}

		/** Base64 for the bundle's existing JSON Remote carrier (no data-URL prefix). */
		function waveBase64(bytes) {
			let text = ''
			for (let index = 0; index < bytes.length; index += 8192) text += String.fromCharCode(...bytes.subarray(index, index + 8192))
			return btoa(text)
		}

		/** Map a capture failure onto the dialog's localized error states. */
		function captureFailureKind(error) {
			const name = error && typeof error === 'object' ? safeString(error.name) : ''
			if (name === 'NotAllowedError' || name === 'SecurityError') return 'permission'
			if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') return 'device'
			return 'capture'
		}

		function voiceErrorText(kind, t, catalog) {
			const keys = {
				permission: 'thought.voice.errorPermission',
				device: 'thought.voice.errorDevice',
				capture: 'thought.voice.errorCapture',
				transcribe: 'thought.voice.errorTranscribe',
				empty: 'thought.voice.errorEmpty',
				'too-long': 'thought.voice.errorTooLong',
			}
			const key = keys[kind] || keys.capture
			const seconds = safeNumber(catalog && catalog.maxDurationSeconds, VOICE_DEFAULT_MAX_SECONDS)
			return t(key, { seconds })
		}

		/** Read the bundle's `catalog()` envelope into the dialog's capability state. */
		function readVoiceCatalog(envelope) {
			if (!envelope || envelope.ok !== true || !envelope.value || typeof envelope.value !== 'object') {
				return { available: false, ready: false, reason: 'service', phase: '' }
			}
			const value = envelope.value
			const providers = safeArray(value.providers)
			const selection = value.selection && typeof value.selection === 'object' ? value.selection : {}
			const providerId = safeString(selection.providerId)
			const language = safeString(selection.language)
			const provider = providers.find((item) => item && item.id === providerId) || null
			const phase =
				provider && provider.preparation && typeof provider.preparation.phase === 'string' ? provider.preparation.phase : 'unprepared'
			return {
				available: true,
				ready: provider !== null && VOICE_READY_PHASES.indexOf(phase) !== -1,
				reason: 'unready',
				phase,
				providerId,
				language,
				maxDurationSeconds: safeNumber(value.maxDurationSeconds, VOICE_DEFAULT_MAX_SECONDS),
				maxAudioBytes: safeNumber(value.maxAudioBytes, VOICE_DEFAULT_MAX_BYTES),
			}
		}

		/**
		 * One microphone recording, released on stop/dispose. The bundle's own
		 * capture control is composer-scoped and unexported, so the dialog keeps
		 * this small capture layer and hands the resulting WAV to the bundle.
		 */
		function createMicrophoneCapture() {
			let stream = null
			let context = null
			let recorder = null
			let chunks = []
			let cancelled = false
			let released = false

			const release = async () => {
				if (released) return
				released = true
				try {
					if (recorder && recorder.state !== 'inactive') recorder.stop()
				} catch (error) {
					// recorder teardown is best-effort
				}
				if (stream) {
					for (const track of stream.getTracks()) {
						try {
							track.stop()
						} catch (error) {
							// track teardown is best-effort
						}
					}
				}
				stream = null
				const closing = context
				context = null
				if (closing && closing.state !== 'closed') {
					try {
						await closing.close()
					} catch (error) {
						// audio-context teardown is best-effort
					}
				}
				chunks = []
			}

			return {
				async start(onEnded) {
					const devices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
					if (!devices || typeof devices.getUserMedia !== 'function' || typeof MediaRecorder === 'undefined') {
						const error = new Error('microphone capture is unavailable')
						error.name = 'NotSupportedError'
						throw error
					}
					const acquired = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
					if (cancelled) {
						for (const track of acquired.getTracks()) track.stop()
						const error = new Error('capture cancelled')
						error.name = 'AbortError'
						throw error
					}
					stream = acquired
					const AudioContextImpl = typeof AudioContext === 'function' ? AudioContext : null
					context = AudioContextImpl ? new AudioContextImpl() : null
					for (const track of acquired.getTracks()) {
						track.addEventListener('ended', () => {
							if (!cancelled && !released && typeof onEnded === 'function') onEnded()
						})
					}
					recorder = new MediaRecorder(acquired)
					chunks = []
					recorder.ondataavailable = (event) => {
						if (event.data && event.data.size > 0) chunks.push(event.data)
					}
					recorder.onerror = () => {
						if (!cancelled && !released && typeof onEnded === 'function') onEnded()
					}
					recorder.start()
				},
				async stop(maxDurationSeconds) {
					const active = recorder
					const audioContext = context
					if (!active || !audioContext || active.state !== 'recording') {
						await release()
						return null
					}
					try {
						await new Promise((resolve, reject) => {
							active.onstop = () => resolve()
							active.onerror = () => reject(new Error('recording failed'))
							active.stop()
						})
						if (stream) for (const track of stream.getTracks()) track.stop()
						const blob = new Blob(chunks, { type: active.mimeType })
						if (blob.size === 0) return null
						const decoded = await audioContext.decodeAudioData(await blob.arrayBuffer())
						const seconds = Math.min(decoded.duration, safeNumber(maxDurationSeconds, VOICE_DEFAULT_MAX_SECONDS))
						const frames = Math.max(1, Math.floor(seconds * 16000))
						const offline = new OfflineAudioContext(1, frames, 16000)
						const source = offline.createBufferSource()
						source.buffer = decoded
						source.connect(offline.destination)
						source.start()
						const rendered = await offline.startRendering()
						return encodeWave(rendered.getChannelData(0))
					} finally {
						await release()
					}
				},
				async dispose() {
					cancelled = true
					await release()
				},
			}
		}

		/**
		 * One dialog-scoped dictation session: capability check, capture start,
		 * one-stop transcription, submit flush and teardown. Kept independent of
		 * React so the dependency-free client harness can drive it with a fake
		 * bundle double, fake capture and injected timers.
		 */
		function createVoiceEngine(options) {
			const opts = options && typeof options === 'object' ? options : {}
			const getSpeech = typeof opts.getSpeech === 'function' ? opts.getSpeech : () => null
			const t = typeof opts.t === 'function' ? opts.t : (key) => key
			const getText = typeof opts.getText === 'function' ? opts.getText : () => ''
			const onText = typeof opts.onText === 'function' ? opts.onText : () => {}
			const onState = typeof opts.onState === 'function' ? opts.onState : () => {}
			const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
			const captureFactory = typeof opts.captureFactory === 'function' ? opts.captureFactory : createMicrophoneCapture
			const timers =
				opts.timers && typeof opts.timers === 'object'
					? opts.timers
					: {
							setTimeout: (fn, ms) => setTimeout(fn, ms),
							clearTimeout: (id) => clearTimeout(id),
							setInterval: (fn, ms) => setInterval(fn, ms),
							clearInterval: (id) => clearInterval(id),
					  }

			let state = initialVoiceState()
			let speech = null
			let catalog = null
			let capture = null
			let generation = 0
			let intervalId = null
			let limitId = null
			let startedAt = 0
			let transcribing = null
			let abort = null
			let disposed = false

			const emit = (patch) => {
				state = { ...state, ...patch }
				if (disposed) return
				try {
					onState(state)
				} catch (error) {
					// a render error must not break capture cleanup
				}
			}

			const clearTimers = () => {
				if (intervalId !== null) {
					timers.clearInterval(intervalId)
					intervalId = null
				}
				if (limitId !== null) {
					timers.clearTimeout(limitId)
					limitId = null
				}
			}

			const dropCapture = async (mic) => {
				if (!mic) return
				try {
					await mic.dispose()
				} catch (error) {
					// capture disposal is best-effort
				}
			}

			const schedule = (active) => {
				startedAt = now()
				intervalId = timers.setInterval(() => {
					if (disposed || active !== generation || state.phase !== 'recording') return
					emit({ elapsedSeconds: Math.max(0, Math.floor((now() - startedAt) / 1000)) })
				}, 1000)
				const seconds = Math.max(1, safeNumber(catalog && catalog.maxDurationSeconds, VOICE_DEFAULT_MAX_SECONDS))
				limitId = timers.setTimeout(() => {
					if (disposed || active !== generation || state.phase !== 'recording') return
					void stop(false)
				}, seconds * 1000)
			}

			function onCaptureEnded(active) {
				if (disposed || active !== generation) return
				if (state.phase !== 'recording' && state.phase !== 'requesting') return
				const mic = capture
				capture = null
				generation += 1
				clearTimers()
				void dropCapture(mic)
				emit({ phase: 'error', pressed: false, error: 'capture', announcement: voiceErrorText('capture', t, catalog), elapsedSeconds: 0 })
			}

			async function start() {
				if (disposed || !catalog || !catalog.ready) return
				if (state.phase === 'requesting' || state.phase === 'recording' || state.phase === 'transcribing') return
				const active = ++generation
				emit({ phase: 'requesting', pressed: true, reason: '', error: '', announcement: t('thought.voice.announceRequesting'), elapsedSeconds: 0 })
				abort = new AbortController()
				const mic = captureFactory()
				capture = mic
				try {
					await mic.start(() => onCaptureEnded(active))
				} catch (error) {
					if (capture === mic) capture = null
					await dropCapture(mic)
					if (disposed || active !== generation) return
					const kind = captureFailureKind(error)
					emit({ phase: 'error', pressed: false, error: kind, announcement: voiceErrorText(kind, t, catalog), elapsedSeconds: 0 })
					return
				}
				if (disposed || active !== generation) {
					await dropCapture(mic)
					return
				}
				emit({ phase: 'recording', pressed: true, error: '', announcement: t('thought.voice.announceListening'), elapsedSeconds: 0 })
				schedule(active)
			}

			async function stop(forSubmit) {
				if (disposed) return { ok: false, cancelled: true, text: getText() }
				if (state.phase === 'transcribing' && transcribing) return transcribing
				if (state.phase !== 'recording' && state.phase !== 'requesting') {
					return { ok: true, empty: true, text: getText() }
				}
				const active = ++generation
				const mic = capture
				capture = null
				clearTimers()
				if (!mic) {
					emit({ phase: 'idle', pressed: false, elapsedSeconds: 0 })
					return { ok: true, empty: true, text: getText() }
				}
				transcribing = (async () => {
					try {
						emit({ phase: 'transcribing', pressed: false, error: '', announcement: t('thought.voice.announceTranscribing'), elapsedSeconds: 0 })
						let bytes = null
						try {
							bytes = await mic.stop(catalog.maxDurationSeconds)
						} catch (error) {
							bytes = null
						}
						if (disposed || active !== generation) return { ok: false, cancelled: true, text: getText() }
						if (!bytes || bytes.length === 0) {
							if (forSubmit) {
								emit({ phase: 'idle', pressed: false, elapsedSeconds: 0 })
								return { ok: true, empty: true, text: getText() }
							}
							emit({ phase: 'error', pressed: false, error: 'empty', announcement: voiceErrorText('empty', t, catalog), elapsedSeconds: 0 })
							return { ok: false, empty: true, text: getText() }
						}
						if (bytes.length > safeNumber(catalog.maxAudioBytes, VOICE_DEFAULT_MAX_BYTES)) {
							emit({ phase: 'error', pressed: false, error: 'too-long', announcement: voiceErrorText('too-long', t, catalog), elapsedSeconds: 0 })
							return { ok: false, text: getText() }
						}
						let envelope = null
						try {
							envelope = await speech.transcribe(
								{ audioBase64: waveBase64(bytes), providerId: catalog.providerId, language: catalog.language },
								abort ? abort.signal : undefined,
							)
						} catch (error) {
							envelope = null
						}
						if (disposed || active !== generation) return { ok: false, cancelled: true, text: getText() }
						if (!envelope || envelope.ok !== true || !envelope.value || typeof envelope.value !== 'object') {
							emit({ phase: 'error', pressed: false, error: 'transcribe', announcement: voiceErrorText('transcribe', t, catalog), elapsedSeconds: 0 })
							return { ok: false, text: getText() }
						}
						const transcript = safeString(envelope.value.text)
						if (transcript === '') {
							if (forSubmit) {
								emit({ phase: 'idle', pressed: false, elapsedSeconds: 0 })
								return { ok: true, empty: true, text: getText() }
							}
							emit({ phase: 'error', pressed: false, error: 'empty', announcement: voiceErrorText('empty', t, catalog), elapsedSeconds: 0 })
							return { ok: false, empty: true, text: getText() }
						}
						const next = appendTranscript(getText(), transcript, THOUGHT_MAX_LENGTH)
						if (next !== getText()) onText(next)
						emit({
							phase: 'idle',
							pressed: false,
							error: '',
							lastTranscript: transcript,
							announcement: t('thought.voice.announceAdded', { text: transcript }),
							elapsedSeconds: 0,
						})
						return { ok: true, text: next }
					} finally {
						await dropCapture(mic)
						if (!disposed && active === generation) transcribing = null
					}
				})()
				return transcribing
			}

			function toggle() {
				if (disposed) return Promise.resolve()
				if (state.phase === 'recording') return stop(false)
				if (state.phase === 'idle' || state.phase === 'error') return start()
				return Promise.resolve()
			}

			async function submitFlush() {
				if (disposed) return { ok: false, cancelled: true, text: getText() }
				if (state.phase === 'recording') {
					const result = await stop(true)
					return { ok: result.ok === true, text: typeof result.text === 'string' ? result.text : getText() }
				}
				if (state.phase === 'transcribing' && transcribing) {
					await transcribing
					return { ok: true, text: getText() }
				}
				if (state.phase === 'requesting') {
					const active = ++generation
					const mic = capture
					capture = null
					clearTimers()
					await dropCapture(mic)
					if (!disposed && active === generation) emit({ phase: 'idle', pressed: false, elapsedSeconds: 0 })
					return { ok: true, text: getText() }
				}
				return { ok: true, text: getText() }
			}

			async function init() {
				if (disposed) return state
				emit({ phase: 'checking', pressed: false, reason: '', error: '', announcement: t('thought.voice.announceChecking'), elapsedSeconds: 0 })
				const remote = getSpeech()
				if (!remote || typeof remote.catalog !== 'function' || typeof remote.transcribe !== 'function') {
					emit({ phase: 'unavailable', pressed: false, reason: 'absent', announcement: t('thought.voice.unavailable'), elapsedSeconds: 0 })
					return state
				}
				let envelope = null
				try {
					envelope = await remote.catalog()
				} catch (error) {
					envelope = null
				}
				if (disposed) return state
				const reading = readVoiceCatalog(envelope)
				if (!reading.available) {
					emit({ phase: 'unavailable', pressed: false, reason: 'service', announcement: t('thought.voice.unavailable'), elapsedSeconds: 0 })
					return state
				}
				if (!reading.ready) {
					emit({ phase: 'unavailable', pressed: false, reason: 'unready', announcement: t('thought.voice.unready'), elapsedSeconds: 0 })
					return state
				}
				speech = remote
				catalog = reading
				await start()
				return state
			}

			function dispose() {
				if (disposed) return
				disposed = true
				generation += 1
				clearTimers()
				if (abort) {
					try {
						abort.abort()
					} catch (error) {
						// abort is best-effort
					}
					abort = null
				}
				const mic = capture
				capture = null
				transcribing = null
				void dropCapture(mic)
			}

			return { init, start, stop, toggle, submitFlush, dispose, getState: () => state }
		}

		/** Visible dictation status; an empty string is the deliberate quiet off state. */
		function voiceStatusText(voice, t) {
			const state = voice && typeof voice === 'object' ? voice : initialVoiceState()
			if (state.phase === 'recording') return t('thought.voice.listening', { seconds: safeNumber(state.elapsedSeconds, 0) })
			if (state.phase === 'requesting') return t('thought.voice.requesting')
			if (state.phase === 'checking') return t('thought.voice.checking')
			if (state.phase === 'transcribing') return t('thought.voice.transcribing')
			if (state.phase === 'unavailable' || state.phase === 'error') return safeString(state.announcement)
			return ''
		}

		function voiceToggleLabel(voice, t) {
			const state = voice && typeof voice === 'object' ? voice : initialVoiceState()
			if (state.phase === 'recording') return t('thought.voice.stop')
			if (state.phase === 'requesting') return t('thought.voice.requesting')
			if (state.phase === 'checking') return t('thought.voice.checking')
			if (state.phase === 'transcribing') return t('thought.voice.transcribing')
			return t('thought.voice.start')
		}

		function ThoughtDialog(props) {
			const { t, onSubmit, onClose, getSpeech } = props
			const textareaRef = useRef(null)
			const dialogRef = useRef(null)
			const engineRef = useRef(null)
			const textRef = useRef('')
			const submittingRef = useRef(false)
			const [text, setText] = useState('')
			const [submitting, setSubmitting] = useState(false)
			const [voice, setVoice] = useState(initialVoiceState)

			useEscape(true, onClose)
			useFocusOnOpen(true, textareaRef)

			// One dictation session per open dialog. Cleanup always releases the mic,
			// even when the dialog closes through Escape or the overlay.
			useEffect(() => {
				const engine = createVoiceEngine({
					getSpeech: typeof getSpeech === 'function' ? getSpeech : () => null,
					t,
					getText: () => textRef.current,
					onText: (next) => setText(next),
					onState: (next) => setVoice(next),
				})
				engineRef.current = engine
				void engine.init()
				return () => {
					engineRef.current = null
					engine.dispose()
				}
			}, [])

			useEffect(() => {
				textRef.current = text
			}, [text])

			const trimmed = text.trim()
			const voiceBusy = voice.phase === 'checking' || voice.phase === 'requesting' || voice.phase === 'transcribing'
			const canSend = trimmed !== '' && !submitting && voice.phase !== 'transcribing'
			const toggleDisabled = submitting || voiceBusy || voice.phase === 'unavailable'
			const toggleLabel = voiceToggleLabel(voice, t)
			const statusText = voiceStatusText(voice, t)
			const showingError = voice.phase === 'error'

			const submit = async () => {
				if (!canSend || submittingRef.current) return
				submittingRef.current = true
				setSubmitting(true)
				let keepOpen = true
				try {
					// A stop-to-transcribe flush finalizes the pending fragment first, so a
					// single Send either submits the reviewed text or fails closed.
					let nextText = text
					const engine = engineRef.current
					if (engine) {
						const flushed = await engine.submitFlush()
						if (!flushed || flushed.ok !== true) return
						if (typeof flushed.text === 'string') nextText = flushed.text
					}
					const finalText = nextText.trim()
					if (finalText === '') return
					const result = await onSubmit(finalText)
					if (result && result.ok) {
						keepOpen = false
						onClose()
					}
				} finally {
					submittingRef.current = false
					if (keepOpen) setSubmitting(false)
				}
			}

			// Trapped-lite: Tab cycles inside the dialog, Escape closes and focus restores.
			const onKeyDown = (event) => {
				if (event.key !== 'Tab') return
				const node = dialogRef.current
				if (!node) return
				const focusable = [...node.querySelectorAll('textarea,button,input,select,a[href]')].filter(
					(item) => item.disabled !== true && item.getBoundingClientRect().width > 0,
				)
				if (focusable.length === 0) return
				const first = focusable[0]
				const last = focusable[focusable.length - 1]
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault()
					last.focus()
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault()
					first.focus()
				}
			}

			const toggleDictation = () => {
				const engine = engineRef.current
				if (!engine) return
				void engine.toggle()
			}

			return h(
				'div',
				{ className: 'kb-overlay kb-overlay--center', onClick: onClose },
				h(
					'div',
					{
						ref: dialogRef,
						className: 'kb-dialog',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': t('thought.title'),
						onKeyDown,
						onClick: (event) => event.stopPropagation(),
					},
					h(
						'div',
						{ className: 'kb-dialogHead' },
						h('span', { className: 'kb-dialogTitle' }, t('thought.title')),
						h(
							'button',
							{
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon',
								title: t('header.close'),
								'aria-label': t('header.close'),
								onClick: onClose,
							},
							h(IconClose, { size: 15 }),
						),
					),
					h(
						'div',
						{ className: 'kb-dialogBody' },
						h(
							'label',
							{ className: 'kb-field', htmlFor: 'kb-thought-input' },
							h('span', { className: 'kb-fieldLabel' }, t('thought.field')),
							h('textarea', {
								id: 'kb-thought-input',
								ref: textareaRef,
								className: 'kb-textarea',
								value: text,
								rows: 6,
								maxLength: THOUGHT_MAX_LENGTH,
								placeholder: t('thought.placeholder'),
								'aria-label': t('thought.field'),
								onChange: (event) => setText(event.target.value),
								onKeyDown: (event) => {
									if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
										event.preventDefault()
										void submit()
									}
								},
							}),
							text.length > 3600
								? h('span', { className: 'kb-thoughtCounter' }, text.length + '/' + THOUGHT_MAX_LENGTH)
								: null,
						),
						h(
							'div',
							{ className: 'kb-thoughtVoice' },
							h(
								Button,
								{
									className: 'kb-thoughtVoiceToggle',
									variant: voice.phase === 'recording' ? 'primary' : 'ghost',
									size: 'sm',
									icon: h(IconMic, { size: 13 }),
									pressed: voice.pressed === true,
									disabled: toggleDisabled,
									title: toggleLabel,
									'aria-label': toggleLabel,
									onClick: toggleDictation,
								},
								toggleLabel,
							),
							voice.phase === 'recording' ? h('span', { className: 'kb-thoughtVoiceDot', 'aria-hidden': 'true' }) : null,
							statusText
								? h(
										'span',
										{
											className: classNames('kb-thoughtVoiceState', showingError && 'kb-thoughtVoiceState--error'),
											'aria-hidden': 'true',
										},
										statusText,
								  )
								: null,
						),
						h('span', { className: 'kb-srOnly', role: 'status', 'aria-live': 'polite' }, safeString(voice.announcement)),
					),
					h(
						'div',
						{ className: 'kb-dialogFoot' },
						h(Button, { variant: 'ghost', onClick: onClose }, t('actions.cancel')),
						h(
							Button,
							{
								variant: 'primary',
								disabled: !canSend,
								icon: submitting ? h(Spinner) : h(IconSparkles, { size: 14 }),
								onClick: () => void submit(),
							},
							submitting ? t('thought.sending') : t('thought.send'),
						),
					),
				),
			)
		}

		/** Best-effort timeline: the audit when present, else a derived two-step view. */
		function thoughtTimelineEntries(thought) {
			const audit = safeArray(thought.audit).filter((entry) => entry && typeof entry === 'object' && safeNumber(entry.at, 0) > 0)
			if (audit.length > 0) {
				return audit.slice().sort((left, right) => safeNumber(left.at, 0) - safeNumber(right.at, 0))
			}
			const createdAt = safeNumber(thought.createdAt, 0)
			const status = safeString(thought.status)
			const derived = createdAt > 0 ? [{ at: createdAt, type: 'status', to: 'recorded' }] : []
			if (status && status !== 'recorded' && safeNumber(thought.updatedAt, 0) > createdAt) {
				derived.push({ at: safeNumber(thought.updatedAt, 0), type: 'status', to: status })
			}
			return derived
		}

		function thoughtTimelineLabel(entry, t) {
			const type = safeString(entry.type) || 'status'
			const to = safeString(entry.to)
			const from = safeString(entry.from)
			if (type === 'status') {
				if (from && to) return thoughtStatusLabel(from, t) + ' → ' + thoughtStatusLabel(to, t)
				if (to) return thoughtStatusLabel(to, t)
				return t('thought.status.unknown')
			}
			if (type === 'ticket') return t('thought.ticketCreated', { id: safeString(entry.ticketId) })
			if (type === 'retry') return t('thought.retryOf', { id: safeString(entry.thoughtId) })
			if (type === 'edit') return t('thought.edited')
			if (type === 'delete') return t('thought.deleted')
			return type
		}

		function ThoughtRowView(props) {
			const { t, thought, expanded, pending, onToggle, onOpenTicket, openSession, onRetry, onCancel, onEdit, onDelete, onOpenThought } = props
			const text = safeString(thought.text)
			const status = safeString(thought.status)
			const errorText = safeString(thought.error)
			const chips = safeArray(thought.ticketIds).filter((id) => typeof id === 'string' && id)
			const statusKey = THOUGHT_STATUSES.indexOf(status) === -1 ? 'unknown' : status
			const isExpanded = expanded === true
			const retryOf = safeString(thought.retryOf)
			const timeline = isExpanded ? thoughtTimelineEntries(thought) : []
			const retryTargetKnown = retryOf !== '' && props.retryTargetKnown === true
			const [editing, setEditing] = useState(false)
			const [draft, setDraft] = useState(text)
			const [invalid, setInvalid] = useState(false)
			// KB-60: the collapsed row is one plain-projection string, derived once per
			// stored text so the 2.5 s poll never re-projects every row.
			const preview = useMemo(() => markdownPlainLabel(text), [text])
			const busy =
				safeNumber(pending && pending['thought-retry:' + thought.id], 0) > 0 ||
				safeNumber(pending && pending['thought-cancel:' + thought.id], 0) > 0 ||
				safeNumber(pending && pending['thought-edit:' + thought.id], 0) > 0 ||
				safeNumber(pending && pending['thought-delete:' + thought.id], 0) > 0
			const editable = status === 'queued' || status === 'failed' || status === 'cancelled'
			const deletable = status !== 'working'
			const startEdit = () => {
				setDraft(text)
				setInvalid(false)
				setEditing(true)
			}
			const saveEdit = async () => {
				const next = draft.trim()
				if (!next) {
					setInvalid(true)
					return
				}
				const result = await onEdit(thought.id, next)
				if (result && result.ok) {
					setEditing(false)
					setInvalid(false)
				}
			}
			const controls = []
			if (!editing) {
				if (status === 'failed') {
					controls.push(h(Button, { key: 'retry', size: 'sm', variant: 'ghost', disabled: busy, onClick: () => void onRetry(thought.id) }, t('thought.retry')))
				}
				if (status === 'working') {
					controls.push(h(Button, { key: 'cancel', size: 'sm', variant: 'danger', icon: h(IconClose, { size: 12 }), disabled: busy, onClick: () => void onCancel(thought.id) }, t('thought.cancel')))
				}
				if (editable) {
					controls.push(h(Button, { key: 'edit', size: 'sm', variant: 'ghost', icon: h(IconEdit, { size: 12 }), disabled: busy, onClick: startEdit }, t('thought.edit')))
				}
			}
			const meta =
				chips.length > 0 || thought.sessionId || retryOf
					? h(
							'div',
							{ className: 'kb-thoughtMeta' },
							chips.map((ticketId) =>
								h(
									'button',
									{
										key: ticketId,
										type: 'button',
										className: 'kb-thoughtChip',
										title: ticketId,
										'aria-label': ticketId,
										onClick: () => onOpenTicket(ticketId),
									},
									ticketId,
								),
							),
							thought.sessionId
								? h(
										Button,
										{
											size: 'sm',
											variant: 'ghost',
											icon: h(IconExternal, { size: 12 }),
											title: t('execution.openSession'),
											onClick: () => openSession(thought.sessionId),
										},
										t('execution.openSession'),
									)
								: null,
						  )
						: null
			return h(
				'div',
				{ className: 'kb-thoughtRow' },
				h(
					'div',
					{ className: 'kb-thoughtTop' },
					h('span', { className: 'kb-thoughtStatus kb-thoughtStatus--' + statusKey }, thoughtStatusLabel(status, t)),
					status === 'queued' ? h('span', { className: 'kb-thoughtHint', title: t('thought.queuedHint') }, t('thought.queuedHint')) : null,
					h('span', { className: 'kb-thoughtAge' }, formatAge(safeNumber(thought.updatedAt, safeNumber(thought.createdAt, 0)), t)),
				),
				editing
					? h(
							'div',
							{ className: 'kb-thoughtEditForm' },
							h('textarea', {
								className: classNames('kb-textarea', invalid && 'kb-textarea--invalid'),
								value: draft,
								rows: 4,
								maxLength: 4000,
								'aria-label': t('thought.editPlaceholder'),
								placeholder: t('thought.editPlaceholder'),
								onChange: (event) => {
									setDraft(event.target.value)
									if (invalid) setInvalid(false)
								},
							}),
							invalid ? h('div', { className: 'kb-thoughtError' }, t('thought.emptyError')) : null,
							h(
								'div',
								{ className: 'kb-thoughtEditFoot' },
								h(Button, { size: 'sm', variant: 'ghost', onClick: () => setEditing(false) }, t('thought.cancelEdit')),
								h(Button, { size: 'sm', variant: 'primary', disabled: busy, onClick: () => void saveEdit() }, t('thought.save')),
							),
						  )
					: h(
							'div',
							{ className: classNames('kb-thoughtText', isExpanded && 'kb-thoughtText--expanded') },
							// KB-60: expanded rows render the shipped MarkdownBody; the collapsed
							// row keeps its deterministic, marker-free single-line projection so
							// the 3-line clamp never measures a block layout.
							isExpanded ? h(MarkdownBody, { text, t }) : preview,
					  ),
				retryOf
					? h(
							'div',
							{ className: 'kb-thoughtRetryOf' },
							retryTargetKnown
								? h(
										'button',
										{
											type: 'button',
											className: 'kb-thoughtChip',
											title: t('thought.retryOf', { id: retryOf }),
											onClick: () => onOpenThought(retryOf),
										},
										t('thought.retryOf', { id: retryOf }),
									)
								: h('span', null, t('thought.retryOfPlain', { id: retryOf })),
						  )
					: null,
				editing
					? null
					: h(
							'button',
							{
								type: 'button',
								className: 'kb-thoughtExpand',
								onClick: onToggle,
								'aria-expanded': isExpanded ? 'true' : 'false',
							},
							isExpanded ? t('thought.collapse') : t('thought.expand'),
						),
				errorText ? h('div', { className: 'kb-thoughtError' }, errorText) : null,
				isExpanded && timeline.length > 0
					? h(
							'div',
							{ className: 'kb-thoughtDetail' },
							h('span', { className: 'kb-thoughtDetailHead' }, t('thought.timeline')),
							h(
								'ul',
								{ className: 'kb-thoughtTimeline' },
								timeline.map((entry, index) =>
									h(
										'li',
										{ key: 'tl-' + index, className: 'kb-thoughtTimelineItem' },
										h(
											'span',
											{ className: 'kb-thoughtTimelineAt', title: new Date(safeNumber(entry.at, 0)).toISOString() },
											formatAge(safeNumber(entry.at, 0), t),
										),
										h('span', { className: 'kb-thoughtTimelineText' }, thoughtTimelineLabel(entry, t)),
									),
								),
							),
						  )
					: null,
				meta,
				editing
					? null
					: controls.length > 0 || deletable
						? h(
								'div',
								{ className: 'kb-thoughtControls' },
								controls,
								deletable ? h(ThoughtDeleteControl, { key: 'delete', t, busy, onDelete: () => void onDelete(thought.id) }) : null,
						  )
						: null,
			)
		}

		/** Two-step delete for a thought (same armed pattern as the ticket drawer). */
		function ThoughtDeleteControl(props) {
			const { t, busy, onDelete } = props
			const [armed, setArmed] = useState(false)
			useEffect(() => {
				if (!armed) return undefined
				const timer = window.setTimeout(() => setArmed(false), 4000)
				return () => window.clearTimeout(timer)
			}, [armed])
			return h(
				Button,
				{
					size: 'sm',
					variant: 'ghost',
					icon: h(IconTrash, { size: 12 }),
					disabled: busy,
					onClick: () => {
						if (!armed) {
							setArmed(true)
							return
						}
						setArmed(false)
						onDelete()
					},
				},
				armed ? t('actions.confirmDelete') : t('thought.delete'),
			)
		}

		function ThoughtsDrawer(props) {
			const { t, thoughts, pending, focusThoughtId, onOpenTicket, openSession, onClose, onRetry, onCancel, onEdit, onDelete } = props
			const closeRef = useRef(null)
			// A ticket-drawer chip opens this drawer with its thought already expanded.
			const [expanded, setExpanded] = useState(() => (typeof focusThoughtId === 'string' && focusThoughtId ? { [focusThoughtId]: true } : {}))
			useEscape(true, onClose)
			useFocusOnOpen(true, closeRef)
			const rows = safeArray(thoughts).filter((thought) => thought && typeof thought.id === 'string' && thought.id)
			const queued = rows.filter((thought) => thought.status === 'queued').length
			const rowIds = rows.map((thought) => thought.id)
			// A retry link only resolves inside the current 50-row window; otherwise
			// the row shows the plain id instead of a dead link.
			const revealThought = (thoughtId) => {
				if (typeof thoughtId !== 'string' || !thoughtId) return
				setExpanded((previous) => ({ ...previous, [thoughtId]: true }))
			}
			return h(
				'div',
				{ className: 'kb-overlay kb-overlay--right', onClick: onClose },
				h(
					'div',
					{
						className: 'kb-drawer kb-drawer--thoughts',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': t('header.thoughts'),
						onClick: (event) => event.stopPropagation(),
					},
					h(
						'div',
						{ className: 'kb-drawerHead' },
						h(
							'div',
							{ className: 'kb-drawerHeadMain' },
							h('span', { className: 'kb-drawerId' }, t('header.thoughts')),
							rows.length > 0 ? h('span', { className: 'kb-thoughtsHeadCount' }, t('thought.count', { n: rows.length })) : null,
							queued > 0 ? h('span', { className: 'kb-thoughtsHeadCount kb-thoughtsHeadCount--queued' }, t('thought.queuedCount', { n: queued })) : null,
						),
						h(
							'button',
							{
								ref: closeRef,
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon',
								title: t('thought.close'),
								'aria-label': t('thought.close'),
								onClick: onClose,
							},
							h(IconClose, { size: 15 }),
						),
					),
					h(
						'div',
						{ className: 'kb-drawerBody' },
						rows.length === 0
							? h(
									'div',
									{ className: 'kb-thoughtEmpty' },
									h('span', { className: 'kb-thoughtEmptyIcon' }, h(IconSparkles, { size: 22 })),
									h('span', null, t('thought.empty')),
								)
							: h(
									'div',
									{ className: 'kb-thoughtsList' },
									rows.map((thought) =>
										h(ThoughtRowView, {
											key: thought.id,
											t,
											thought,
											expanded: expanded[thought.id] === true,
											onToggle: () => setExpanded((previous) => ({ ...previous, [thought.id]: !previous[thought.id] })),
											onOpenTicket,
											openSession,
											onRetry,
											onCancel,
											onEdit: onEdit,
											onDelete: onDelete,
											onOpenThought: revealThought,
											retryTargetKnown: Boolean(thought.retryOf) && rowIds.indexOf(thought.retryOf) !== -1,
										}),
									),
								),
					),
				),
			)
		}

		function NewTicketDialog(props) {
			const { t, roles, initialColumn, onCreate, onClose } = props
			const inputRef = useRef(null)
			const roleOptions = safeArray(roles)
			const [title, setTitle] = useState('')
			const [description, setDescription] = useState('')
			const [type, setType] = useState('story')
			const [priority, setPriority] = useState('medium')
			const [role, setRole] = useState('')
			const [column, setColumn] = useState(COLUMNS.indexOf(initialColumn) === -1 ? 'backlog' : initialColumn)
			const [invalid, setInvalid] = useState(false)
			const [submitting, setSubmitting] = useState(false)

			useEscape(true, onClose)
			useFocusOnOpen(true, inputRef)

			const submit = async () => {
				if (submitting) return
				const value = title.trim()
				if (!value) {
					setInvalid(true)
					const node = inputRef.current
					if (node && typeof node.focus === 'function') node.focus()
					return
				}
				setSubmitting(true)
				const result = await onCreate({
					title: value,
					description: description.trim(),
					type,
					priority,
					role: role ? role : null,
					column,
				})
				setSubmitting(false)
				if (result && result.ok) onClose()
			}

			return h(
				'div',
				{ className: 'kb-overlay kb-overlay--center', onClick: onClose },
				h(
					'div',
					{
						className: 'kb-dialog',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': t('new.title'),
						onClick: (event) => event.stopPropagation(),
					},
					h(
						'div',
						{ className: 'kb-dialogHead' },
						h('span', { className: 'kb-dialogTitle' }, t('new.title')),
						h(
							'button',
							{
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon',
								title: t('header.close'),
								'aria-label': t('header.close'),
								onClick: onClose,
							},
							h(IconClose, { size: 15 }),
						),
					),
					h(
						'div',
						{ className: 'kb-dialogBody' },
						h(
							'label',
							{ className: 'kb-field' },
							h('span', { className: 'kb-fieldLabel' }, t('new.titleLabel')),
							h('input', {
								ref: inputRef,
								className: classNames('kb-input', invalid && title.trim() === '' && 'kb-input--invalid'),
								value: title,
								placeholder: t('new.titlePlaceholder'),
								'aria-label': t('new.titleLabel'),
								onChange: (event) => {
									setTitle(event.target.value)
									if (invalid) setInvalid(false)
								},
								onKeyDown: (event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										void submit()
									}
								},
							}),
							invalid && title.trim() === '' ? h('span', { className: 'kb-hint kb-hint--error' }, t('new.titleRequired')) : null,
						),
						h(
							'label',
							{ className: 'kb-field' },
							h('span', { className: 'kb-fieldLabel' }, t('detail.description')),
							h('textarea', {
								className: 'kb-description',
								value: description,
								placeholder: t('new.descriptionPlaceholder'),
								'aria-label': t('detail.description'),
								rows: 4,
								onChange: (event) => setDescription(event.target.value),
							}),
						),
						h(
							'div',
							{ className: 'kb-formGrid' },
							h(
								'label',
								{ className: 'kb-field' },
								h('span', { className: 'kb-fieldLabel' }, t('new.type')),
								h(
									'select',
									{
										className: 'kb-select',
										value: type,
										onChange: (event) => {
											const next = event.target.value
											setType(next)
											if (next === 'epic') setColumn('backlog')
										},
									},
									TYPES.map((item) => h('option', { key: item, value: item }, t('types.' + item))),
								),
							),
							h(
								'label',
								{ className: 'kb-field' },
								h('span', { className: 'kb-fieldLabel' }, t('new.priority')),
								h(
									'select',
									{ className: 'kb-select', value: priority, onChange: (event) => setPriority(event.target.value) },
									PRIORITIES.map((item) => h('option', { key: item, value: item }, t('priority.' + item))),
								),
							),
							h(
								'label',
								{ className: 'kb-field' },
								h('span', { className: 'kb-fieldLabel' }, t('new.role')),
								h(
									'select',
									{ className: 'kb-select', value: role, onChange: (event) => setRole(event.target.value) },
									h('option', { value: '' }, t('detail.roleNone')),
									roleOptions.map((option) => h('option', { key: option.id, value: option.id }, option.name)),
								),
							),
							h(
								'label',
								{ className: 'kb-field' },
								h('span', { className: 'kb-fieldLabel' }, t('new.column')),
								h(
									'select',
									{
										className: 'kb-select',
										value: type === 'epic' ? 'backlog' : column,
										disabled: type === 'epic',
										onChange: (event) => setColumn(event.target.value),
									},
									COLUMNS.map((item) => h('option', { key: item, value: item }, t('columns.' + item))),
								),
								type === 'epic' ? h('span', { className: 'kb-hint kb-hint--epic' }, t('new.epicHint')) : null,
							),
						),
					),
					h(
						'div',
						{ className: 'kb-dialogFoot' },
						h(Button, { variant: 'ghost', onClick: onClose }, t('actions.cancel')),
						h(
							Button,
							{
								variant: 'primary',
								disabled: submitting || title.trim() === '',
								icon: submitting ? h(Spinner) : h(IconPlus, { size: 14 }),
								onClick: () => void submit(),
							},
							submitting ? t('new.creating') : t('new.create'),
						),
					),
				),
			)
		}

		// ------------------------------------------------------------------
		// Scan drawer
		// ------------------------------------------------------------------

		function ScanDrawer(props) {
			const { t, state, onClose, onImport, onToggleCandidate, onToggleAll, onRetry } = props
			const closeRef = useRef(null)
			useEscape(true, onClose)
			useFocusOnOpen(true, closeRef)
			const data = state && state.data ? state.data : null
			const loading = state && state.loading === true
			const importing = state && state.importing === true
			const scanError = state && state.error ? state.error : null
			const selected = state && state.selected && typeof state.selected === 'object' ? state.selected : {}
			const candidates = safeArray(data && data.candidates)
			const selectedCount = candidates.filter((candidate) => candidate && selected[candidate.key]).length
			const allSelected = candidates.length > 0 && selectedCount === candidates.length
			const docs = safeArray(data && data.docs)
			const mrs = safeArray(data && data.mrs)
			const conversations = safeArray(data && data.conversations)
			// KB-61: the vision and candidate descriptions are Markdown sources.
			// A whitespace-only vision is semantically empty — no `.kb-md` node and
			// no added content height — so it is omitted exactly like a missing one.
			const visionSource = data ? safeString(data.vision) : ''
			const vision = visionSource.trim() === '' ? '' : visionSource

			return h(
				'div',
				{ className: 'kb-overlay kb-overlay--right', onClick: onClose },
				h(
					'div',
					{
						className: 'kb-drawer kb-drawer--scan',
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': t('scan.title'),
						onClick: (event) => event.stopPropagation(),
					},
					h(
						'div',
						{ className: 'kb-drawerHead' },
						h(
							'div',
							{ className: 'kb-drawerHeadMain' },
							h('span', { className: 'kb-dialogTitle' }, t('scan.title')),
							data && data.generatedAt
								? h('span', { className: 'kb-hint' }, t('scan.subtitle', { ago: formatAge(data.generatedAt, t) }))
								: null,
						),
						h(
							'button',
							{
								ref: closeRef,
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon',
								title: t('scan.close'),
								'aria-label': t('scan.close'),
								onClick: onClose,
							},
							h(IconClose, { size: 15 }),
						),
					),
					h(
						'div',
						{ className: 'kb-drawerBody' },
						loading
							? h('div', { className: 'kb-centerLoading' }, h(Spinner), h('span', null, t('scan.running')))
							: scanError
								? h(
										'div',
										{ className: 'kb-section' },
										h(SectionHead, { title: t('scan.title') }),
										h('div', { className: 'kb-errorText' }, (scanError && scanError.message) || t('error.unknown')),
										h(Button, { size: 'sm', icon: h(IconRefresh, { size: 12 }), onClick: onRetry }, t('scan.retry')),
									)
								: data
									? h(
											React.Fragment,
											null,
											vision
												? h(
														'div',
														{ className: 'kb-section' },
														h(SectionHead, { title: t('scan.vision') }),
														h(
															'div',
															{
																className: 'kb-vision',
																role: 'region',
																tabIndex: 0,
																'aria-label': t('scan.vision'),
															},
															h(MarkdownBody, { text: vision, t }),
														),
													)
												: null,
											h(
												'div',
												{ className: 'kb-section' },
												h(SectionHead, { title: t('scan.docs'), count: docs.length }),
												docs.length === 0
													? h('div', { className: 'kb-emptyLine' }, t('scan.docsEmpty'))
													: docs.slice(0, 12).map((doc) =>
															h(
																'div',
																{ key: safeString(doc.path) || safeString(doc.title), className: 'kb-docRow' },
																h('span', { className: 'kb-docTitle' }, safeString(doc.title) || safeString(doc.path)),
																h('span', { className: 'kb-docPath', title: safeString(doc.path) }, safeString(doc.path)),
															),
														),
												docs.length > 12 ? h('div', { className: 'kb-emptyLine' }, '+' + String(docs.length - 12)) : null,
											),
											h(
												'div',
												{ className: 'kb-section' },
												h(SectionHead, { title: t('scan.mrs'), count: mrs.length }),
												mrs.length === 0
													? h('div', { className: 'kb-emptyLine' }, t('scan.mrsEmpty'))
													: mrs.map((mr) =>
															h(
																'div',
																{ key: safeString(mr.id) || safeString(mr.number), className: 'kb-mrRow' },
																h('span', { className: 'kb-chip' }, '#' + safeString(mr.number)),
																h('span', { className: 'kb-mrTitle', title: safeString(mr.title) }, safeString(mr.title) || t('scan.mrs')),
																mr.url
																	? h(
																			'a',
																			{
																				className: 'kb-link',
																				href: mr.url,
																				target: '_blank',
																				rel: 'noopener noreferrer',
																				title: safeString(mr.url),
																			},
																			h(IconExternal, { size: 12 }),
																		)
																	: null,
															),
														),
											),
											h(
												'div',
												{ className: 'kb-section' },
												h(SectionHead, { title: t('scan.conversations'), count: conversations.length }),
												conversations.length === 0
													? h('div', { className: 'kb-emptyLine' }, t('scan.conversationsEmpty'))
													: conversations.slice(0, 8).map((conversation) =>
															h(
																'div',
																{ key: safeString(conversation.sessionId), className: 'kb-convRow' },
																h('span', { className: 'kb-dot' }),
																h(
																	'span',
																	{ className: 'kb-convTitle', title: safeString(conversation.title) },
																	safeString(conversation.title) || t('scan.conversations'),
																),
																h('span', { className: 'kb-convSub' }, t('scan.messages', { n: safeNumber(conversation.messageCount, 0) })),
																h('span', { className: 'kb-convSub' }, formatAge(conversation.updatedAt, t)),
															),
														),
												conversations.length > 8 ? h('div', { className: 'kb-emptyLine' }, '+' + String(conversations.length - 8)) : null,
											),
											h(
												'div',
												{ className: 'kb-section' },
												h(SectionHead, {
													title: t('scan.candidates'),
													count: candidates.length,
													extra:
														candidates.length > 0
															? h(
																	'label',
																	{ className: 'kb-iconMeta' },
																	h('input', {
																		type: 'checkbox',
																		className: 'kb-checkbox',
																		checked: allSelected,
																		'aria-label': t('actions.selectAll'),
																		onChange: () => onToggleAll(!allSelected),
																	}),
																	t('actions.selectAll'),
																)
															: null,
												}),
												h('div', { className: 'kb-hint' }, t('scan.importHint')),
												candidates.length === 0
													? h('div', { className: 'kb-emptyLine' }, t('scan.candidatesEmpty'))
													: h(
															'div',
															{ className: 'kb-scanCandidateList' },
															candidates.map((candidate) =>
																h(
																	'label',
																	{ key: candidate.key, className: 'kb-candidate' },
																	h('input', {
																		type: 'checkbox',
																		className: 'kb-checkbox',
																		checked: selected[candidate.key] === true,
																		'aria-label': safeString(candidate.title),
																		onChange: () => onToggleCandidate(candidate.key),
																	}),
																	h(
																		'span',
																		{ className: 'kb-candidateMain' },
																		h(
																			'span',
																			{ className: 'kb-candidateTitle', title: safeString(candidate.title) },
																			safeString(candidate.title),
																		),
																		safeString(candidate.description)
																			? h(
																					'span',
																					{ className: 'kb-candidateDesc' },
																					h(MarkdownBody, { text: safeString(candidate.description), t }),
																				)
																			: null,
																		h(
																			'span',
																			{ className: 'kb-candidateMeta' },
																			h(
																				'span',
																				{ className: 'kb-chip kb-chip--' + cardTypeClass(candidate.type) },
																				typeLabel(candidate.type, t),
																			),
																			h(
																				'span',
																				{ className: 'kb-chip kb-chip--' + priorityClass(candidate.priority) },
																				priorityLabel(candidate.priority, t),
																			),
																			candidate.role ? h('span', { className: 'kb-tag' }, roleNameFor(candidate.role, t)) : null,
																			h('span', { className: 'kb-tag' }, columnLabel(candidate.column, t)),
																			candidate.source && candidate.source.kind
																				? h('span', { className: 'kb-tag' }, t('source.' + safeString(candidate.source.kind)))
																				: null,
																		),
																	),
																),
															),
														),
											),
										)
									: null,
					),
					data
						? h(
								'div',
								{ className: 'kb-scanFoot' },
								h('span', { className: 'kb-scanFootText' }, t('scan.candidatesHint', { n: candidates.length, selected: selectedCount })),
								h(
									Button,
									{
										variant: 'primary',
										disabled: importing || selectedCount === 0,
										icon: importing ? h(Spinner) : h(IconScan, { size: 14 }),
										onClick: onImport,
									},
									importing ? t('scan.importing') : t('scan.import'),
								),
							)
						: null,
				),
			)
		}

		// ------------------------------------------------------------------
		// Shared empty / loading / error state + role labels
		// ------------------------------------------------------------------

		function CenterState(props) {
			return h(
				'div',
				{ className: 'kb-center' },
				props.icon ? h('span', { className: 'kb-centerIcon' }, props.icon) : null,
				props.loading === true
					? h('div', { className: 'kb-centerLoading' }, h(Spinner), h('span', null, props.title))
					: h('div', { className: 'kb-centerTitle' }, props.title),
				props.body ? h('div', { className: 'kb-centerBody' }, props.body) : null,
				props.error ? h('div', { className: 'kb-errorText' }, props.error) : null,
				safeArray(props.actions).length > 0
					? h('div', { className: 'kb-centerActions' }, safeArray(props.actions).filter(Boolean))
					: null,
			)
		}

		function roleNameFor(roleId, t) {
			if (!roleId || typeof roleId !== 'string') return ''
			if (ROLE_IDS.indexOf(roleId) !== -1) return t('role.' + roleId)
			return roleId
		}

				// ------------------------------------------------------------------
		// Root panel
		// ------------------------------------------------------------------

		function emptyScanState() {
			return { open: false, loading: false, data: null, selected: {}, error: null, importing: false }
		}

		function KanbanPage(props) {
			const t = typeof props.t === 'function' ? props.t : (key) => key
			const openSessionProp = props.openSession
			const readSessionCwd = props.readSessionCwd
			const getSpeech = props.getSpeech

			const { toasts, notify, dismiss } = useToasts()
			const [workspaceId, setWorkspaceId] = useState(readStoredWorkspace)
			const { snapshot, phase, error, pending, refresh, reset, act } = useSnapshot(workspaceId, t, notify)
			const [search, setSearch] = useState('')
			const [searchOpen, setSearchOpen] = useState(false)
			const [roleFilter, setRoleFilter] = useState('')
			const [ownerFilter, setOwnerFilter] = useState('')
			const [projectOpen, setProjectOpen] = useState(false)
			const [filtersOpen, setFiltersOpen] = useState(false)
			const [showTeam, setShowTeam] = useState(false)
			const [selectedId, setSelectedId] = useState(null)
			const [newTicket, setNewTicket] = useState(null)
			const [memberEditor, setMemberEditor] = useState(null)
			const [rolesOpen, setRolesOpen] = useState(false)
			const [scan, setScan] = useState(emptyScanState)
			const [thoughtOpen, setThoughtOpen] = useState(false)
			const [thoughtsOpen, setThoughtsOpen] = useState(false)
			const [thoughtFocus, setThoughtFocus] = useState('')
			const [drag, setDrag] = useState(null)
			const [dragOver, setDragOver] = useState(null)
			const bootedRef = useRef(false)
			const rootRef = useRef(null)
			const panelWidth = useElementWidth(rootRef)
			const showBlockedLane = panelWidth === 0 || panelWidth >= BLOCKED_LANE_MIN_WIDTH
			const pendingWorkspaceRef = useRef(null)
			const projectRef = useRef(null)
			const filtersRef = useRef(null)

			const closeProjectMenu = useCallback(() => setProjectOpen(false), [])
			const closeFiltersMenu = useCallback(() => setFiltersOpen(false), [])
			const closeSearch = useCallback(() => {
				if (search) setSearch('')
				else setSearchOpen(false)
			}, [search])
			const closeDrawer = useCallback(() => setSelectedId(null), [])
			const closeNewTicket = useCallback(() => setNewTicket(null), [])
			const closeScan = useCallback(() => setScan(emptyScanState()), [])
			const thoughtCtaRef = useRef(null)
			const closeThought = useCallback(() => {
				setThoughtOpen(false)
				// End-to-end focus order: closing the dialog always returns focus to
				// the control that opens it (also covers programmatic open paths).
				// Deferred one tick so the dialog's own focus-restore cleanup cannot
				// steal focus back after unmount.
				window.setTimeout(() => {
					const node = thoughtCtaRef.current
					if (node && typeof node.focus === 'function') node.focus()
				}, 0)
			}, [])
			const closeThoughts = useCallback(() => {
				setThoughtsOpen(false)
				setThoughtFocus('')
			}, [])
			const closeMemberEditor = useCallback(() => setMemberEditor(null), [])
			const closeRoles = useCallback(() => setRolesOpen(false), [])
			const openNewMember = useCallback(() => setMemberEditor({ memberId: null }), [])
			const openMember = useCallback((member) => {
				if (!member || typeof member.id !== 'string' || !member.id) return
				setMemberEditor({ memberId: member.id })
			}, [])
			const openRoles = useCallback(() => setRolesOpen(true), [])

			useOutsideClick(projectOpen, projectRef, closeProjectMenu)
			useOutsideClick(filtersOpen, filtersRef, closeFiltersMenu)
			useEscape(projectOpen, closeProjectMenu)
			useEscape(filtersOpen, closeFiltersMenu)
			useEscape(searchOpen, closeSearch)

			const isBusy = (key) => (pending[key] || 0) > 0
			const actionBusy = Object.keys(pending).length > 0

			useEffect(() => {
				reset()
				void refresh()
				let timer = null
				const start = () => {
					if (timer === null) timer = window.setInterval(() => void refresh(), POLL_MS)
				}
				const stop = () => {
					if (timer !== null) {
						window.clearInterval(timer)
						timer = null
					}
				}
				const onVisibility = () => {
					if (typeof document === 'undefined' || document.visibilityState === 'visible') {
						void refresh()
						start()
					} else {
						stop()
					}
				}
				start()
				document.addEventListener('visibilitychange', onVisibility)
				return () => {
					stop()
					document.removeEventListener('visibilitychange', onVisibility)
				}
			}, [workspaceId, refresh, reset])

			useEffect(() => {
				if (!snapshot) return
				const resolved = typeof snapshot.workspaceId === 'string' && snapshot.workspaceId ? snapshot.workspaceId : null
				if (pendingWorkspaceRef.current !== null) {
					// A user-selected project is being fetched; the current snapshot
					// still describes the previous project, so never reconcile it.
					if (resolved === pendingWorkspaceRef.current) pendingWorkspaceRef.current = null
					return
				}
				if (!bootedRef.current) {
					bootedRef.current = true
					if (!workspaceId) {
						const projects = safeArray(snapshot.projects)
						let cwd = null
						try {
							cwd = typeof readSessionCwd === 'function' ? readSessionCwd() : null
						} catch (sessionError) {
							cwd = null
						}
						const match = cwd
							? projects.find((project) => project && normalizePath(project.path) === normalizePath(cwd))
							: null
						const preferred = resolved || (match && typeof match.id === 'string' ? match.id : null)
						if (preferred) {
							storeWorkspace(preferred)
							if (preferred !== resolved) setWorkspaceId(preferred)
						}
						return
					}
					if (resolved && resolved !== workspaceId) {
						storeWorkspace(resolved)
						setWorkspaceId(resolved)
					}
					return
				}
				if (resolved && workspaceId && resolved !== workspaceId) {
					storeWorkspace(resolved)
					setWorkspaceId(resolved)
				}
			}, [snapshot, workspaceId, readSessionCwd])

			useEffect(() => {
				if (error && error.code === 'project/not-found' && workspaceId) {
					pendingWorkspaceRef.current = null
					storeWorkspace(null)
					setWorkspaceId(null)
				}
			}, [error, workspaceId])

			const board = snapshot && snapshot.board && typeof snapshot.board === 'object' ? snapshot.board : null
			const tickets = useMemo(() => {
				if (!board || !Array.isArray(board.tickets)) return []
				return board.tickets.filter((ticket) => ticket && typeof ticket === 'object' && typeof ticket.id === 'string')
			}, [board])

			// -- Autopilot controls (KB-76) -------------------------------------
			// The view is derived from the snapshot read model; the reducer owns the
			// optimistic configure value, the busy guard and the rollback. The
			// popover open state stays outside the reducer so a poll cannot close it.
			const [autopilotOpen, setAutopilotOpen] = useState(false)
			const [autopilotUi, setAutopilotUi] = useState(() => initialAutopilotUi(null))
			const autopilotView = useMemo(() => autopilotViewFromSnapshot(snapshot), [snapshot])
			const autopilotBtnRef = useRef(null)
			const autopilotWrapRef = useRef(null)
			const autopilotQueueRef = useRef(null)
			const autopilotSendRef = useRef(null)
			const autopilotSeqRef = useRef(0)
			const autopilotUiRef = useRef(autopilotUi)
			autopilotUiRef.current = autopilotUi

			const closeAutopilot = useCallback(() => {
				setAutopilotOpen(false)
				// Return focus to the header entry so the keyboard path survives the
				// re-render; deferred one tick like the thought dialog's restore.
				window.setTimeout(() => {
					const node = autopilotBtnRef.current
					if (node && typeof node.focus === 'function') node.focus()
				}, 0)
			}, [])
			useOutsideClick(autopilotOpen, autopilotWrapRef, closeAutopilot)
			useEscape(autopilotOpen, closeAutopilot)

			useEffect(() => {
				setAutopilotOpen(false)
				setAutopilotUi(initialAutopilotUi(workspaceId))
			}, [workspaceId])

			useEffect(() => {
				setAutopilotUi((previous) =>
					reduceAutopilot(previous, {
						type: 'sync',
						available: autopilotView.available,
						config: autopilotView.config,
						pauseCause: autopilotView.pauseCause,
						membersPaused: autopilotView.membersPaused,
						budget: autopilotView.budget,
						nextTickAt: autopilotView.nextTickAt,
						lastPulse: autopilotView.lastPulse,
					}),
				)
			}, [autopilotView])

			// KB-77 lane admission chips. Occupancy comes from the shipped ticket
			// execution rows; the cap is the configured (or optimistically edited)
			// cap. No admission policy is recomputed here.
			const autopilotLaneChips = useMemo(() => {
				if (autopilotView.available !== true) return null
				return autopilotLaneAdmissions(
					{
						available: true,
						config: autopilotUi.values || autopilotView.config,
						paused: autopilotView.paused,
						occupancy: autopilotView.laneOccupancy,
					},
					t,
				)
			}, [autopilotView, autopilotUi.values, t])

			const flushAutopilotConfigure = useCallback(
				async (patch) => {
					if (!patch || typeof patch !== 'object') return
					autopilotSeqRef.current += 1
					const seq = autopilotSeqRef.current
					setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'configure/send', seq }))
					const result = await act('autopilot', { op: 'configure', patch }, {
						key: 'autopilot-configure',
						quiet: true,
						refresh: false,
					})
					if (result.ok) {
						const config = autopilotConfigFromStatus(result.value)
						setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'configure/ok', seq, config }))
						if (patch.enabled === true && !readAutopilotConfirmSeen()) {
							setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'phase1/show' }))
						}
					} else {
						setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'configure/fail', seq, error: result.error }))
					}
				},
				[act],
			)
			autopilotSendRef.current = flushAutopilotConfigure
			if (!autopilotQueueRef.current) {
				autopilotQueueRef.current = createAutopilotCommitQueue(window, AUTOPILOT_COMMIT_MS, (patch) => {
					const send = autopilotSendRef.current
					if (typeof send === 'function') void send(patch)
				})
			}
			useEffect(
				() => () => {
					if (autopilotQueueRef.current) autopilotQueueRef.current.cancel()
				},
				[],
			)

			const configureAutopilot = useCallback((patch) => {
				if (!patch || typeof patch !== 'object') return
				setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'configure/optimistic', patch }))
				const queue = autopilotQueueRef.current
				if (!queue) return
				queue.push(patch)
				// Turning the master switch off is a synchronous host stop; do not
				// leave it sitting in the debounce window.
				if (patch.enabled === false) queue.flushNow()
			}, [])

			const previewAutopilot = useCallback(async () => {
				if (!canPreviewAutopilot(autopilotUiRef.current)) return
				setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'preview/start' }))
				const result = await act('autopilot', { op: 'plan' }, { key: 'autopilot-plan', quiet: true, refresh: false })
				if (result.ok) {
					setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'preview/ok', plan: result.value, at: Date.now() }))
				} else {
					setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'preview/fail', error: result.error }))
				}
			}, [act])

			const pulseAutopilot = useCallback(async () => {
				if (!canPulseAutopilot(autopilotUiRef.current)) return
				setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'pulse/start' }))
				const result = await act('autopilot', { op: 'pulseNow' }, { key: 'autopilot-pulse', quiet: true })
				if (result.ok) {
					const pulse = result.value && typeof result.value === 'object' ? result.value.pulse : null
					setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'pulse/ok', pulse }))
					notify('ok', t('autopilot.pulseDone', { id: pulse && typeof pulse.id === 'string' ? pulse.id : '—' }))
				} else {
					setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'pulse/fail', error: result.error }))
				}
			}, [act, notify, t])

			const dismissAutopilotError = useCallback(() => {
				setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'error/dismiss' }))
			}, [])

			const dismissAutopilotPhase1 = useCallback(() => {
				markAutopilotConfirmSeen()
				setAutopilotUi((previous) => reduceAutopilot(previous, { type: 'phase1/dismiss' }))
			}, [])

			// KB-3 EPIC model: parent/child relations are derived from board.tickets
			// only; the snapshot adds no collection and older snapshots simply have none.
			const ticketById = useMemo(() => {
				const map = new Map()
				tickets.forEach((ticket) => map.set(ticket.id, ticket))
				return map
			}, [tickets])
			const childrenByParent = useMemo(() => {
				const map = new Map()
				tickets.forEach((ticket) => {
					if (typeof ticket.parentId !== 'string' || !ticket.parentId) return
					const list = map.get(ticket.parentId) || []
					list.push(ticket)
					map.set(ticket.parentId, list)
				})
				return map
			}, [tickets])
			const parentOf = useCallback(
				(ticket) => (ticket && typeof ticket.parentId === 'string' ? ticketById.get(ticket.parentId) || null : null),
				[ticketById],
			)
			const childCountOf = useCallback(
				(ticket) => (ticket && typeof ticket.id === 'string' ? safeArray(childrenByParent.get(ticket.id)).length : 0),
				[childrenByParent],
			)
			const team = useMemo(() => {
				if (!snapshot || !Array.isArray(snapshot.team)) return []
				return snapshot.team.filter((agent) => agent && typeof agent.sessionId === 'string')
			}, [snapshot])
			const rules = snapshot && snapshot.rules && typeof snapshot.rules === 'object' ? snapshot.rules : {}
			const accessModes = snapshot && snapshot.accessModes && typeof snapshot.accessModes === 'object' ? snapshot.accessModes : null
			// KB-13 roster/drafts are additive: old snapshots simply have none.
			const roster = useMemo(() => {
				if (!snapshot || !Array.isArray(snapshot.roster)) return []
				return snapshot.roster.filter((member) => member && typeof member.id === 'string' && member.id)
			}, [snapshot])
			const drafts = useMemo(() => {
				if (!snapshot || !Array.isArray(snapshot.drafts)) return []
				return snapshot.drafts.filter((draft) => draft && typeof draft.id === 'string' && draft.id)
			}, [snapshot])
			// KB-1 thoughts are additive: an older snapshot simply has none.
			const thoughts = useMemo(() => {
				if (!snapshot || !Array.isArray(snapshot.thoughts)) return []
				return snapshot.thoughts.filter((thought) => thought && typeof thought.id === 'string' && thought.id)
			}, [snapshot])
			// KB-5: ids of soft-deleted thoughts (most recent 100) let the ticket
			// drawer distinguish "Thought deleted" from "not in the loaded window".
			const deletedThoughtIds = useMemo(() => {
				if (!snapshot || !Array.isArray(snapshot.deletedThoughtIds)) return []
				return snapshot.deletedThoughtIds.filter((id) => typeof id === 'string' && id)
			}, [snapshot])
			const workingThoughts = useMemo(
				() => thoughts.filter((thought) => thought.status === 'working').length,
				[thoughts],
			)
			const roleCatalog = useMemo(() => {
				const fromRules = safeArray(rules.roles).filter((role) => role && typeof role.id === 'string' && role.id)
				const source = fromRules.length > 0 ? fromRules : ROLE_IDS.map((id) => ({ id }))
				return source.map((role) => {
					const localized = ROLE_IDS.indexOf(role.id) !== -1 ? t('role.' + role.id) : ''
					return {
						id: role.id,
						name: localized || safeString(role.name) || role.id,
						description: safeString(role.description),
						summary: safeString(role.summary),
						claimColumns: safeArray(role.claimColumns),
						stepCount: safeNumber(role.stepCount, 0),
						definitionOfDone: safeArray(role.definitionOfDone).filter((item) => typeof item === 'string' && item),
					}
				})
			}, [rules, t])
			const roles = useMemo(() => roleCatalog.map((role) => ({ id: role.id, name: role.name })), [roleCatalog])
			const roleName = useCallback(
				(roleId) => {
					if (!roleId || typeof roleId !== 'string') return ''
					if (ROLE_IDS.indexOf(roleId) !== -1) return t('role.' + roleId)
					const found = safeArray(rules.roles).find((role) => role && role.id === roleId)
					return (found && safeString(found.name)) || roleId
				},
				[rules, t],
			)
			const paused = Boolean(board && board.paused === true)
			const wipLimits = useMemo(() => {
				const limits = {}
				COLUMNS.forEach((column) => {
					limits[column] = 0
				})
				if (board && board.wip && typeof board.wip === 'object') {
					COLUMNS.forEach((column) => {
						limits[column] = safeNumber(board.wip[column], 0)
					})
				} else {
					safeArray(rules.columns).forEach((column) => {
						if (column && COLUMNS.indexOf(column.id) !== -1) limits[column.id] = safeNumber(column.wip, 0)
					})
				}
				return limits
			}, [board, rules])
			const allCounts = useMemo(() => {
				const counts = { backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0, blocked: 0, executing: 0 }
				tickets.forEach((ticket) => {
					if (ticket.blocked === true) counts.blocked += 1
					if (counts[ticket.column] !== undefined) counts[ticket.column] += 1
					if (executionStatusOf(ticket) === 'running') counts.executing += 1
				})
				return counts
			}, [tickets])
			const filterActive = search.trim() !== '' || roleFilter !== '' || ownerFilter !== ''
			const filtersCount = (roleFilter ? 1 : 0) + (ownerFilter ? 1 : 0)
			const filteredTickets = useMemo(() => {
				const query = search.trim().toLowerCase()
				return tickets.filter((ticket) => {
					if (roleFilter && ticket.role !== roleFilter) return false
					if (ownerFilter === UNASSIGNED) {
						if (ticket.owner) return false
					} else if (ownerFilter) {
						if (!ticket.owner || ticket.owner.sessionId !== ownerFilter) return false
					}
					if (!query) return true
					const owner = ticket.owner && typeof ticket.owner === 'object' ? safeString(ticket.owner.name) : ''
					const haystack = [safeString(ticket.id), safeString(ticket.title), safeArray(ticket.labels).join(' '), owner]
						.join(' ')
						.toLowerCase()
					return haystack.indexOf(query) !== -1
				})
			}, [tickets, search, roleFilter, ownerFilter])
			const columnTickets = useMemo(() => {
				const map = {}
				COLUMNS.forEach((column) => {
					map[column] = []
				})
				map.blocked = []
				filteredTickets.forEach((ticket) => {
					// The Blocked lane is a view over real columns. Below the width that fits
					// six lanes the view collapses and blocked tickets stay in their own
					// column (still flagged with their blocked chip) instead of forcing a
					// horizontal board scroll.
					if (ticket.blocked === true && showBlockedLane) {
						map.blocked.push(ticket)
						return
					}
					if (map[ticket.column]) map[ticket.column].push(ticket)
				})
				Object.keys(map).forEach((column) => {
					map[column].sort(
						(left, right) =>
							safeNumber(PRIORITY_RANK[right.priority], 0) - safeNumber(PRIORITY_RANK[left.priority], 0) ||
							safeNumber(right.movedAt, 0) - safeNumber(left.movedAt, 0),
					)
				})
				return map
			}, [filteredTickets, showBlockedLane])
			const selectedTicket = useMemo(
				() => (selectedId ? tickets.find((ticket) => ticket.id === selectedId) || null : null),
				[tickets, selectedId],
			)
			const project = snapshot && snapshot.project && typeof snapshot.project === 'object' ? snapshot.project : null
			const projectTitle =
				(project && safeString(project.title)) || (board && safeString(board.projectTitle)) || t('project.select')
			const activeWorkspaceId = (snapshot && snapshot.workspaceId) || workspaceId || null
			const canEdit = Boolean(activeWorkspaceId) && !paused

			useEffect(() => {
				if (!selectedId || !snapshot || !board) return
				if (!tickets.some((ticket) => ticket.id === selectedId)) setSelectedId(null)
			}, [snapshot, board, tickets, selectedId])

			useEffect(() => {
				if (!memberEditor || !memberEditor.memberId) return
				if (!roster.some((member) => member.id === memberEditor.memberId)) setMemberEditor(null)
			}, [roster, memberEditor])

			const editingMember = useMemo(
				() =>
					memberEditor && memberEditor.memberId
						? roster.find((member) => member.id === memberEditor.memberId) || null
						: null,
				[memberEditor, roster],
			)

			const onRefresh = useCallback(async () => {
				const result = await refresh()
				if (!result.ok && !result.stale) {
					notify('error', (result.error && result.error.message) || t('toast.refreshFailed'))
				}
			}, [refresh, notify, t])

			const selectProject = useCallback(
				(id) => {
					setProjectOpen(false)
					if (typeof id !== 'string' || id === workspaceId) return
					setSelectedId(null)
					setDrag(null)
					setDragOver(null)
					setMemberEditor(null)
					setRolesOpen(false)
					pendingWorkspaceRef.current = id
					storeWorkspace(id)
					setWorkspaceId(id)
				},
				[workspaceId],
			)

			const notifyOpenSession = useCallback(
				(sessionId) => {
					if (!sessionId) return false
					try {
						if (typeof openSessionProp === 'function') {
							openSessionProp(sessionId)
							return true
						}
					} catch (sessionError) {
						notify('error', t('toast.sessionError'))
						return false
					}
					notify('error', t('toast.sessionError'))
					return false
				},
				[notify, openSessionProp, t],
			)

			const toggleBoardPause = useCallback(() => {
				if (!board) return
				const resuming = board.paused === true
				void act(resuming ? 'resumeBoard' : 'pauseBoard', {}, { key: 'boardPause' })
			}, [act, board])

			const openTicket = useCallback((ticketId) => {
				if (typeof ticketId === 'string' && ticketId) setSelectedId(ticketId)
			}, [])

			const addTicketTo = useCallback(
				(column) => {
					if (paused) {
						notify('warn', t('toast.boardPausedMove'))
						return
					}
					setNewTicket({ column: COLUMNS.indexOf(column) === -1 ? 'backlog' : column })
				},
				[notify, paused, t],
			)

			const createTicket = useCallback(
				async (form) => {
					const result = await act('createTicket', form, { key: 'createTicket' })
					if (result.ok && result.value && result.value.ticket && typeof result.value.ticket.id === 'string') {
						setSelectedId(result.value.ticket.id)
					}
					return result
				},
				[act],
			)

			// The dialog owns the typed text: a failed submit keeps it, only `ok` closes.
			const submitThoughtAction = useCallback(
				(text) => act('submitThought', { text }, { key: 'submitThought' }),
				[act],
			)
			const retryThoughtAction = useCallback(
				(thoughtId) => act('retryThought', { thoughtId }, { key: 'thought-retry:' + thoughtId }),
				[act],
			)
			const cancelThoughtAction = useCallback(
				(thoughtId) => act('cancelThought', { thoughtId }, { key: 'thought-cancel:' + thoughtId }),
				[act],
			)
			const editThoughtAction = useCallback(
				(thoughtId, text) => act('editThought', { thoughtId, text }, { key: 'thought-edit:' + thoughtId }),
				[act],
			)
			const deleteThoughtAction = useCallback(
				(thoughtId) => act('deleteThought', { thoughtId }, { key: 'thought-delete:' + thoughtId }),
				[act],
			)
			const openThoughtsAt = useCallback((thoughtId) => {
				setSelectedId(null)
				if (typeof thoughtId === 'string' && thoughtId) setThoughtFocus(thoughtId)
				setThoughtsOpen(true)
			}, [])

			const openThoughtTicket = useCallback(
				(ticketId) => {
					setThoughtsOpen(false)
					openTicket(ticketId)
				},
				[openTicket],
			)

			const toggleMemberPause = useCallback(
				(member) => {
					if (!member || typeof member.id !== 'string') return
					const resuming = member.paused === true
					void act('updateMember', { memberId: member.id, patch: { paused: !resuming } }, {
						key: 'member:' + member.id,
						toastText: t(resuming ? 'toast.agentResumed' : 'toast.agentPaused', {
							name: safeString(member.name) || member.id,
						}),
					})
				},
				[act, t],
			)

			const renameMember = useCallback(
				(member, name) => {
					if (!member || typeof member.id !== 'string') return Promise.resolve({ ok: false })
					const value = safeString(name).trim()
					if (!value || value === safeString(member.name)) return Promise.resolve({ ok: true })
					return act('updateMember', { memberId: member.id, patch: { name: value } }, { key: 'member:' + member.id, quiet: true })
				},
				[act],
			)

			const draftMemberAction = useCallback(
				async (description, roleId) => {
					const text = safeString(description).trim().slice(0, 1000)
					if (!text) {
						notify('warn', t('ai.required'))
						return { ok: false }
					}
					const payload = { description: text }
					if (typeof roleId === 'string' && roleId) payload.roleId = roleId
					const result = await act('draftMember', payload, { key: 'draftMember', quiet: true })
					if (result.ok) {
						const source = result.value && typeof result.value === 'object' ? safeString(result.value.source) : ''
						notify(source === 'template' ? 'warn' : 'ok', source === 'template' ? t('draft.template') : t('draft.started'))
					}
					return result
				},
				[act, notify, t],
			)

			const retryDraft = useCallback(
				async (draft) => {
					if (!draft || typeof draft.description !== 'string') return
					const result = await draftMemberAction(draft.description, draft.roleId || null)
					if (result && result.ok) {
						await act('cancelDraft', { draftId: draft.id }, { key: 'draft:' + draft.id, quiet: true })
					}
					return result
				},
				[act, draftMemberAction],
			)

			const dismissDraft = useCallback(
				(draft) => {
					if (!draft || typeof draft.id !== 'string') return
					void act('cancelDraft', { draftId: draft.id }, { key: 'draft:' + draft.id, toastText: t('draft.cancelledToast') })
				},
				[act, t],
			)

			const runTicketAction = useCallback(
				(ticket, role, mode) => {
					if (!ticket || typeof ticket.id !== 'string') return
					if (paused) {
						notify('warn', t('toast.boardPausedMove'))
						return
					}
					const payload = { ticketId: ticket.id }
					if (typeof role === 'string' && role) payload.role = role
					if (typeof mode === 'string' && mode) payload.accessMode = mode
					void act('runTicket', payload, { key: 'execute:' + ticket.id })
				},
				[act, notify, paused, t],
			)

			const cancelExecutionAction = useCallback(
				(ticket) => {
					if (!ticket || typeof ticket.id !== 'string') return
					void act('cancelExecution', { ticketId: ticket.id }, { key: 'cancel:' + ticket.id })
				},
				[act],
			)

			const answerExecutionAction = useCallback(
				(ticket, answers, grant) => {
					if (!ticket || typeof ticket.id !== 'string') return
					void act(
						'answerTicket',
						{ ticketId: ticket.id, answers: safeArray(answers), grant: safeArray(grant) },
						{ key: 'answer:' + ticket.id, toastText: t('execution.answered') },
					)
				},
				[act, t],
			)

			const onDragStart = useCallback(
				(event, ticket) => {
					// EPICs are pinned to Backlog: refuse the drag and say why.
					if (paused || ticket.blocked === true || ticket.type === 'epic') {
						event.preventDefault()
						notify(
							'warn',
							paused
								? t('toast.boardPausedMove')
								: ticket.type === 'epic'
									? t('card.epicLockedHint')
									: t('toast.blockedMove'),
						)
						return
					}
					try {
						if (event.dataTransfer) {
							event.dataTransfer.effectAllowed = 'move'
							event.dataTransfer.setData('text/plain', ticket.id)
						}
					} catch (dataError) {
						// some browsers restrict dataTransfer outside a user gesture
					}
					setDrag({ ticketId: ticket.id, column: ticket.column })
				},
				[notify, paused, t],
			)

			const onDragEnd = useCallback(() => {
				setDrag(null)
				setDragOver(null)
			}, [])

			const onDragOver = useCallback(
				(event, column) => {
					if (paused || !drag) return
					event.preventDefault()
					try {
						if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
					} catch (dataError) {
						// ignore
					}
					setDragOver((previous) => (previous === column ? previous : column))
				},
				[drag, paused],
			)

			const onDragLeave = useCallback((event, column) => {
				const node = event.currentTarget
				if (node && event.relatedTarget && node.contains(event.relatedTarget)) return
				setDragOver((previous) => (previous === column ? null : previous))
			}, [])

			const onDrop = useCallback(
				(event, column) => {
					event.preventDefault()
					const moving = drag
					setDrag(null)
					setDragOver(null)
					if (!moving || !moving.ticketId || paused) return
					if (moving.column === column) return
					void act('moveTicket', { ticketId: moving.ticketId, column }, { key: 'move:' + moving.ticketId })
				},
				[act, drag, paused],
			)

			const runScan = useCallback(async () => {
				if (!activeWorkspaceId) {
					notify('error', t('error.noWorkspace'))
					return
				}
				setScan({ open: true, loading: true, data: null, selected: {}, error: null, importing: false })
				const result = await act('scan', {}, { quiet: true, refresh: false })
				if (!result.ok) {
					setScan((previous) => ({ ...previous, loading: false, error: result.error }))
					return
				}
				const data = result.value && result.value.scan && typeof result.value.scan === 'object' ? result.value.scan : null
				const selected = {}
				safeArray(data && data.candidates).forEach((candidate) => {
					if (candidate && typeof candidate.key === 'string') selected[candidate.key] = true
				})
				setScan({ open: true, loading: false, data, selected, error: null, importing: false })
			}, [act, activeWorkspaceId, notify, t])

			const toggleCandidate = useCallback((key) => {
				if (typeof key !== 'string') return
				setScan((previous) => ({
					...previous,
					selected: { ...previous.selected, [key]: !previous.selected[key] },
				}))
			}, [])

			const toggleAllCandidates = useCallback((value) => {
				setScan((previous) => {
					const selected = {}
					safeArray(previous.data && previous.data.candidates).forEach((candidate) => {
						if (candidate && typeof candidate.key === 'string') selected[candidate.key] = value !== false
					})
					return { ...previous, selected }
				})
			}, [])

			const importScan = useCallback(async () => {
				const data = scan.data
				const candidates = safeArray(data && data.candidates)
				const selectedCount = candidates.filter((candidate) => candidate && scan.selected[candidate.key]).length
				if (selectedCount === 0) {
					notify('warn', t('scan.noneSelected'))
					return
				}
				setScan((previous) => ({ ...previous, importing: true }))
				const keys = candidates
					.filter((candidate) => candidate && typeof candidate.key === 'string' && scan.selected[candidate.key])
					.map((candidate) => candidate.key)
				const result = await act('applyScan', { keys }, { key: 'applyScan' })
				if (result.ok) setScan(emptyScanState())
				else setScan((previous) => ({ ...previous, importing: false }))
			}, [act, notify, scan, t])

			const clearFilters = useCallback(() => {
				setSearch('')
				setRoleFilter('')
				setOwnerFilter('')
			}, [])

			const warningText =
				snapshot && typeof snapshot.routeError === 'string' && snapshot.routeError
					? snapshot.routeError
					: snapshot && error
						? t('error.unreachable') + ' ' + safeString(error.message)
						: ''

			const wipCount = allCounts.in_progress
			const wipLimit = wipLimits.in_progress
			const wipStateClass =
				wipLimit > 0 && wipCount > wipLimit
					? ' kb-statPill--error'
					: wipLimit > 0 && wipCount === wipLimit
						? ' kb-statPill--warn'
						: ''
			const statLabels = { backlog: 'stats.backlog', ready: 'stats.ready', review: 'stats.review', done: 'stats.done' }

			let content = null
			if (!snapshot) {
				content =
					phase === 'error'
						? h(CenterState, {
								icon: h(IconWarning, { size: 22 }),
								title: t('error.title'),
								body: t('error.body'),
								error: error && error.message,
								actions: [
									h(
										Button,
										{ key: 'retry', variant: 'primary', icon: h(IconRefresh, { size: 14 }), onClick: onRefresh },
										t('error.retry'),
									),
								],
							})
						: h(CenterState, { loading: true, title: t('loading.board') })
			} else if (safeArray(snapshot.projects).length === 0) {
				content = h(CenterState, {
					icon: h(KanbanIcon, { size: 24 }),
					title: t('empty.noProjectsTitle'),
					body: t('empty.noProjectsBody'),
					actions: [
						h(
							Button,
							{ key: 'refresh', variant: 'primary', icon: h(IconRefresh, { size: 14 }), onClick: onRefresh },
							t('error.retry'),
						),
					],
				})
			} else if (!board) {
				if (!activeWorkspaceId) {
					content = h(CenterState, {
						icon: h(KanbanIcon, { size: 24 }),
						title: t('empty.selectProjectTitle'),
						body: t('empty.selectProjectBody'),
						actions: safeArray(snapshot.projects)
							.slice(0, 3)
							.map((item) =>
								h(Button, { key: item.id, onClick: () => selectProject(item.id) }, safeString(item.title) || item.id),
							),
					})
				} else {
					content = h(CenterState, {
						icon: h(KanbanIcon, { size: 24 }),
						title: t('empty.boardTitle'),
						body: t('empty.boardBody'),
						actions: [
							h(
								Button,
								{ key: 'scan', variant: 'primary', icon: h(IconScan, { size: 14 }), onClick: () => void runScan() },
								t('empty.scan'),
							),
							h(
								Button,
								{
									key: 'new',
									icon: h(IconPlus, { size: 14 }),
									disabled: paused,
									onClick: () => setNewTicket({ column: 'backlog' }),
								},
								t('empty.createBoard'),
							),
						],
					})
				}
			} else if (filterActive && filteredTickets.length === 0) {
				content = h(CenterState, {
					icon: h(IconSearch, { size: 22 }),
					title: t('empty.filteredTitle'),
					body: t('empty.filteredBody'),
					actions: [h(Button, { key: 'clear', onClick: clearFilters }, t('empty.clearFilters'))],
				})
			} else {
				const boardEmpty = tickets.length === 0 && !filterActive
				content = h(
					'div',
					{ className: 'kb-boardWrap' },
					boardEmpty
						? h(
								'div',
								{ className: 'kb-emptyBanner' },
								h('span', { className: 'kb-emptyBannerIcon' }, h(IconScan, { size: 14 })),
								h('span', { className: 'kb-emptyBannerText' }, t('empty.boardBody')),
								h(
									Button,
									{ variant: 'primary', size: 'sm', icon: h(IconScan, { size: 12 }), onClick: () => void runScan() },
									t('empty.scan'),
								),
								h(
									Button,
									{ size: 'sm', icon: h(IconPlus, { size: 12 }), onClick: () => setNewTicket({ column: 'backlog' }) },
									t('header.newTicket'),
								),
							)
						: null,
					h(Board, {
						t,
						columnTickets,
						allCounts,
						wipLimits,
						paused,
						drag,
						over: dragOver,
						roleName,
						filterActive,
						laneAdmissions: autopilotLaneChips,
						onOpenTicket: openTicket,
						onAddTicket: addTicketTo,
						onDragStart,
						onDragEnd,
						onDragOver,
						onDragLeave,
						onDrop,
						onRun: runTicketAction,
						pending,
						parentOf,
						childCountOf,
						onOpenParent: openTicket,
					}),
				)
			}

			return h(
				React.Fragment,
				null,
				h('style', { key: 'kb-style' }, CSS),
				h(
					'div',
					{ className: 'kb-root', ref: rootRef },
					h(
						'header',
						{ className: 'kb-header' },
						h(
							'div',
							{ className: 'kb-headerLeft' },
							h('span', { className: 'kb-titleIcon' }, h(KanbanIcon, { size: 18 })),
							h('span', { className: 'kb-title' }, t('panel.title')),
							h(
								'div',
								{ className: 'kb-projectWrap', ref: projectRef },
								h(
									'button',
									{
										type: 'button',
										className: 'kb-projectBtn',
										disabled: !snapshot,
										title: projectTitle,
										'aria-haspopup': 'menu',
										'aria-expanded': projectOpen ? 'true' : 'false',
										onClick: () => setProjectOpen((value) => !value),
									},
									h('span', { className: 'kb-projectName' }, projectTitle),
									h('span', { className: 'kb-chevron' }, h(IconChevronDown, { size: 14 })),
								),
								projectOpen
									? h(ProjectMenu, {
											t,
											projects: safeArray(snapshot && snapshot.projects),
											currentId: (snapshot && snapshot.workspaceId) || workspaceId,
											onSelect: selectProject,
											onRefresh,
											loading: phase === 'loading',
										})
									: null,
							),
						),
						h(
							'div',
							{ className: 'kb-headerRight' },
							h(Button, {
								variant: 'ghost',
								className: 'kb-searchToggle' + (search.trim() ? ' kb-btn--active' : ''),
								icon: h(IconSearch, { size: 15 }),
								title: t('header.search'),
								pressed: searchOpen || search.trim() !== '',
								disabled: !snapshot,
								onClick: () => setSearchOpen((value) => !value),
							}),
							h(
								'div',
								{ className: 'kb-search' },
								h('span', { className: 'kb-searchIcon' }, h(IconSearch, { size: 14 })),
								h('input', {
									className: 'kb-searchInput',
									type: 'text',
									value: search,
									placeholder: t('header.searchPlaceholder'),
									'aria-label': t('header.search'),
									onChange: (event) => setSearch(event.target.value),
								}),
								search
									? h(
											'button',
											{
												type: 'button',
												className: 'kb-searchClear',
												title: t('header.clearSearch'),
												'aria-label': t('header.clearSearch'),
												onClick: () => setSearch(''),
											},
											h(IconClose, { size: 12 }),
										)
									: null,
							),
							searchOpen
								? h(
										'div',
										{ className: 'kb-search kb-search--overlay' },
										h('span', { className: 'kb-searchIcon' }, h(IconSearch, { size: 14 })),
										h('input', {
											className: 'kb-searchInput',
											type: 'text',
											value: search,
											placeholder: t('header.searchPlaceholder'),
											'aria-label': t('header.search'),
											autoFocus: true,
											onChange: (event) => setSearch(event.target.value),
										}),
										h(
											'button',
											{
												type: 'button',
												className: 'kb-searchClose',
												title: t('header.closeSearch'),
												'aria-label': t('header.closeSearch'),
												onClick: () => setSearchOpen(false),
											},
											h(IconClose, { size: 12 }),
										),
									)
								: null,
							h(
								'div',
								{ className: 'kb-filtersWrap', ref: filtersRef },
								h(
									Button,
									{
										variant: 'ghost',
										className: filterActive ? 'kb-btn--active' : undefined,
										icon: h(IconFilter, { size: 14 }),
										title: t('header.filters'),
										disabled: !snapshot || !board,
										onClick: () => setFiltersOpen((value) => !value),
									},
									filtersCount > 0 ? h('span', { className: 'kb-btnBadge' }, String(filtersCount)) : null,
								),
								filtersOpen
									? h(FiltersMenu, {
											t,
											roles,
											agents: team,
											roleFilter,
											ownerFilter,
											onRole: setRoleFilter,
											onOwner: setOwnerFilter,
											onClear: clearFilters,
										})
									: null,
							),
							h(AutopilotControl, {
								key: 'autopilot:' + String(workspaceId || ''),
								t,
								open: autopilotOpen,
								onOpen: () => setAutopilotOpen(true),
								onClose: closeAutopilot,
								onConfigure: configureAutopilot,
								onPreview: () => void previewAutopilot(),
								onPulse: () => void pulseAutopilot(),
								onDismissError: dismissAutopilotError,
								onDismissPhase1: dismissAutopilotPhase1,
								entryRef: autopilotBtnRef,
								wrapRef: autopilotWrapRef,
								state: autopilotUi,
								view: autopilotView,
								tickets,
								roster,
								roleName,
								loading: phase === 'loading',
								onOpenTicket: openTicket,
							}),
							// Everything after the filters is a board action: the Thoughts
							// drawer and the single primary entry point sit immediately
							// before the ticket actions.
							h(
								Button,
								{
									variant: 'ghost',
									className: thoughtsOpen ? 'kb-btn--active' : undefined,
									icon: h(IconList, { size: 14 }),
									title: t('header.thoughts'),
									pressed: thoughtsOpen,
									disabled: !board,
									onClick: () => setThoughtsOpen((value) => !value),
								},
								h('span', { className: 'kb-btnLabel kb-btnLabel--secondary' }, t('header.thoughts')),
								workingThoughts > 0 ? h('span', { className: 'kb-btnBadge' }, String(workingThoughts)) : null,
							),
							h(
								Button,
								{
									variant: 'primary',
									icon: h(IconSparkles, { size: 14 }),
									title: paused ? t('thought.pausedHint') : t('header.speakThought'),
									'aria-label': t('header.speakThought'),
									buttonRef: thoughtCtaRef,
									// KB-5: capture stays open while paused; the host queues it.
									disabled: !board,
									onClick: () => setThoughtOpen(true),
								},
								h('span', { className: 'kb-btnLabel' }, t('header.speakThought')),
							),
							h(
								Button,
								{
									variant: 'ghost',
									icon: h(IconScan, { size: 14 }),
									title: t('header.scan'),
									disabled: !activeWorkspaceId,
									onClick: () => void runScan(),
								},
								h('span', { className: 'kb-btnLabel kb-btnLabel--secondary' }, t('header.scan')),
							),
							h(
								Button,
								{
									variant: 'ghost',
									icon: h(IconPlus, { size: 14 }),
									title: t('header.newTicket'),
									disabled: !canEdit,
									onClick: () => setNewTicket({ column: 'backlog' }),
								},
								h('span', { className: 'kb-btnLabel' }, t('header.newTicket')),
							),
							h(Button, {
								variant: 'ghost',
								className: showTeam ? 'kb-btn--active' : undefined,
								icon: h(IconTeam, { size: 15 }),
								title: t('header.team'),
								pressed: showTeam,
								onClick: () => setShowTeam((value) => !value),
							}),
							board
								? h(Button, {
										variant: 'ghost',
										icon: paused ? h(IconPlay, { size: 15 }) : h(IconPause, { size: 15 }),
										title: paused ? t('header.resume') : t('header.pause'),
										disabled: isBusy('boardPause'),
										onClick: toggleBoardPause,
									})
								: null,
							h(Button, {
								variant: 'ghost',
								icon: actionBusy ? h(Spinner) : h(IconRefresh, { size: 15 }),
								title: t('header.refresh'),
								onClick: () => void onRefresh(),
							}),
						),
					),
					paused
						? h(
								'div',
								{ className: 'kb-banner' },
								h(IconPause, { size: 13 }),
								h(
									'span',
									{ className: 'kb-bannerText' },
									t('paused.banner') +
										(board && board.pausedBy ? ' · ' + t('paused.by', { name: board.pausedBy }) : ''),
								),
								h(
									Button,
									{
										size: 'sm',
										variant: 'primary',
										icon: h(IconPlay, { size: 12 }),
										disabled: isBusy('boardPause'),
										onClick: toggleBoardPause,
									},
									t('paused.resume'),
								),
							)
						: null,
					board
						? h(
								'div',
								{ className: 'kb-stats' },
								COLUMNS.map((column, index) =>
									index === 2
										? h(
												'span',
												{ key: column, className: 'kb-statPill' + wipStateClass },
												t('stats.wip'),
												h('b', null, wipLimit > 0 ? String(wipCount) + '/' + String(wipLimit) : String(wipCount)),
											)
										: h(
												'span',
												{ key: column, className: 'kb-statPill' },
												t(statLabels[column]),
												h('b', null, String(allCounts[column] || 0)),
											),
									),
								allCounts.blocked > 0
									? h(
											'span',
											{ key: 'blocked', className: 'kb-statPill kb-statPill--warn' },
											t('stats.blocked'),
											h('b', null, String(allCounts.blocked)),
										)
									: null,
								allCounts.executing > 0
									? h(
											'span',
											{ key: 'executing', className: 'kb-statPill kb-statPill--warn' },
											t('stats.executing'),
											h('b', null, String(allCounts.executing)),
										)
									: null,
							)
						: null,
					h(
						'div',
						{ className: 'kb-body' },
						h(
							'div',
							{ className: 'kb-bodyMain' },
							warningText
								? h(
										'div',
										{ className: 'kb-warnStrip' },
										h(IconWarning, { size: 12 }),
										h('span', { className: 'kb-warnStripText', title: warningText }, warningText),
										h(Button, { variant: 'ghost', size: 'sm', onClick: () => void onRefresh() }, t('error.retry')),
									)
								: null,
							content,
						),
						showTeam
							? h(TeamRail, {
									t,
									roster,
									drafts,
									board,
									tickets,
									roles,
									pending,
									pauseBusy: isBusy('boardPause'),
									roleName,
									autopilot: autopilotView,
									onOpenTicket: openTicket,
									onToggleBoard: toggleBoardPause,
									onClose: () => setShowTeam(false),
									onAddMember: openNewMember,
									onEditMember: openMember,
									onToggleMember: toggleMemberPause,
									onRenameMember: renameMember,
									onDraft: draftMemberAction,
									onRetryDraft: retryDraft,
									onDismissDraft: dismissDraft,
									onOpenRoles: openRoles,
								})
							: null,
						memberEditor
							? h(MemberEditor, {
									key: memberEditor.memberId || 'new-member',
									t,
									member: editingMember,
									roles,
									act,
									notify,
									onClose: closeMemberEditor,
								})
							: null,
						rolesOpen
							? h(RoleViewer, {
									t,
									roles: roleCatalog,
									act,
									onClose: closeRoles,
								})
							: null,
						selectedTicket
							? h(TicketDrawer, {
									key: selectedTicket.id,
									t,
									ticket: selectedTicket,
									team,
									thoughts,
									deletedThoughtIds,
									onOpenThought: openThoughtsAt,
									roles,
									paused,
									pending,
									act,
									notify,
									roleName,
									openSession: notifyOpenSession,
									onRun: runTicketAction,
									onCancelExecution: cancelExecutionAction,
									onAnswerExecution: answerExecutionAction,
									accessModes,
									children: safeArray(childrenByParent.get(selectedTicket.id)),
									onOpenTicket: openTicket,
									onClose: closeDrawer,
								})
							: null,
						newTicket
							? h(NewTicketDialog, {
									t,
									roles,
									initialColumn: newTicket.column,
									onCreate: createTicket,
									onClose: closeNewTicket,
								})
							: null,
						thoughtOpen
							? h(ThoughtDialog, {
									t,
									onSubmit: submitThoughtAction,
									onClose: closeThought,
									getSpeech,
								})
							: null,
						scan.open
							? h(ScanDrawer, {
									t,
									state: scan,
									onClose: closeScan,
									onImport: importScan,
									onToggleCandidate: toggleCandidate,
									onToggleAll: toggleAllCandidates,
									onRetry: runScan,
								})
							: null,
						thoughtsOpen
							? h(ThoughtsDrawer, {
									t,
									thoughts,
									pending,
									focusThoughtId: thoughtFocus,
									onOpenTicket: openThoughtTicket,
									openSession: notifyOpenSession,
									onRetry: retryThoughtAction,
									onCancel: cancelThoughtAction,
									onEdit: editThoughtAction,
									onDelete: deleteThoughtAction,
									onClose: closeThoughts,
								})
							: null,
					),
					h(Toasts, { toasts, onDismiss: dismiss }),
				),
			)
		}

		// ------------------------------------------------------------------
		// Crash boundary: one bad render must never blank the panel seat
		// ------------------------------------------------------------------

		const CRASH_STYLE = {
			padding: '24px',
			color: 'var(--dsw-alias-label-primary)',
			background: 'var(--dsw-alias-bg-base)',
			fontFamily: 'inherit',
			fontSize: '13px',
			display: 'flex',
			flexDirection: 'column',
			gap: '10px',
			alignItems: 'flex-start',
		}

		class KanbanBoundary extends React.Component {
			constructor(props) {
				super(props)
				this.state = { error: null }
			}

			static getDerivedStateFromError(error) {
				return { error }
			}

			componentDidCatch(error) {
				console.error('kanban: panel crashed', error)
			}

			render() {
				if (this.state.error) {
					const detail = String((this.state.error && this.state.error.message) || this.state.error || 'unknown error')
					return h(
						'div',
						{ className: 'kb-root', style: CRASH_STYLE, role: 'alert' },
						h('strong', null, 'Kanban panel hit a rendering error'),
						h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, detail),
						h(
							'button',
							{
								type: 'button',
								className: 'kb-btn',
								onClick: () => this.setState({ error: null }),
							},
							'Retry',
						),
					)
				}
				return this.props.children
			}
		}

		function KanbanPageBoundary(props) {
			return h(KanbanBoundary, null, h(KanbanPage, props))
		}

		// ------------------------------------------------------------------
		// Safe Markdown engine (KB-56)
		//
		// Pure, dependency-free Markdown pipeline. `parseMarkdown` turns
		// untrusted Markdown into a deep-frozen AST; `renderMarkdown(ast, h)`
		// renders it to React elements through the injected `h` factory. There
		// is no HTML string path and no raw-HTML injection API; every rendered
		// element and attribute comes from a closed allowlist.
		// ------------------------------------------------------------------

		const MARKDOWN_HEADING_TAGS = Object.freeze({ 1: 'h3', 2: 'h4', 3: 'h5', 4: 'h6', 5: 'h6', 6: 'h6' })
		const MARKDOWN_ALLOWED_SCHEMES = Object.freeze(['http', 'https', 'mailto'])
		const MARKDOWN_MAX_INLINE_DEPTH = 60
		const MARKDOWN_MAX_BLOCK_DEPTH = 24
		const MARKDOWN_NAMED_ENTITIES = Object.freeze({
			amp: '&',
			lt: '<',
			gt: '>',
			quot: '"',
			apos: "'",
			nbsp: '\u00a0',
		})
		const MARKDOWN_ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g
		const MARKDOWN_ENTITY_AT_RE = /&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/y
		const MARKDOWN_URI_AUTOLINK_RE = /<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/y
		const MARKDOWN_EMAIL_AUTOLINK_RE = /<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/y
		const MARKDOWN_ASCII_PUNCTUATION_RE = /[!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~]/

		function markdownCodePoint(code) {
			if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '\ufffd'
			if (code >= 0xd800 && code <= 0xdfff) return '\ufffd'
			try {
				return String.fromCodePoint(code)
			} catch (error) {
				return '\ufffd'
			}
		}

		function markdownEntityValue(match) {
			if (match[1]) return markdownCodePoint(parseInt(match[1], 10))
			if (match[2]) return markdownCodePoint(parseInt(match[2], 16))
			const named = MARKDOWN_NAMED_ENTITIES[match[3]]
			return named === undefined ? match[0] : named
		}

		/** Decode the entity subset we support; unknown or malformed entities stay literal. */
		function markdownDecodeEntitiesIn(value) {
			if (typeof value !== 'string' || value.indexOf('&') === -1) return value
			return value.replace(MARKDOWN_ENTITY_RE, function replaceEntity(match, dec, hex, name) {
				return markdownEntityValue([match, dec, hex, name])
			})
		}

		/** Backslash escapes for ASCII punctuation only (CommonMark). */
		function markdownUnescape(value) {
			if (typeof value !== 'string' || value.indexOf('\\') === -1) return value
			return value.replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1')
		}

		function markdownNormalize(source) {
			const text = typeof source === 'string' ? source : ''
			return text.replace(/\r\n?/g, '\n')
		}

		function markdownDeepFreeze(value) {
			if (Array.isArray(value)) {
				for (let index = 0; index < value.length; index += 1) markdownDeepFreeze(value[index])
				return Object.freeze(value)
			}
			if (value && typeof value === 'object') {
				const keys = Object.keys(value)
				for (let index = 0; index < keys.length; index += 1) markdownDeepFreeze(value[keys[index]])
				return Object.freeze(value)
			}
			return value
		}

		function markdownTextNode(value) {
			return { type: 'text', value: String(value === undefined ? '' : value) }
		}

		function markdownIsBlank(line) {
			return /^[ \t]*$/.test(line)
		}

		function markdownLeadingColumns(line) {
			let columns = 0
			for (let index = 0; index < line.length; index += 1) {
				const ch = line.charAt(index)
				if (ch === ' ') columns += 1
				else if (ch === '\t') columns += 4 - (columns % 4)
				else break
			}
			return columns
		}

		function markdownStripColumns(line, count) {
			let columns = 0
			let index = 0
			while (index < line.length && columns < count) {
				const ch = line.charAt(index)
				if (ch === ' ') {
					columns += 1
					index += 1
				} else if (ch === '\t') {
					columns += 4 - (columns % 4)
					index += 1
				} else break
			}
			return line.slice(index)
		}

		function markdownFenceMatch(line) {
			const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
			if (!match) return null
			const marker = match[1]
			const info = match[2]
			if (marker.charAt(0) === '`' && info.indexOf('`') !== -1) return null
			return {
				marker: marker.charAt(0),
				length: marker.length,
				info: info.trim(),
				close: new RegExp('^ {0,3}' + (marker.charAt(0) === '`' ? '`' : '~') + '{' + marker.length + ',}[ \\t]*$'),
			}
		}

		function markdownAtxMatch(line) {
			const match = /^ {0,3}(#{1,6})(?!#)(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
			if (!match) return null
			let content = match[2] === undefined ? '' : match[2]
			content = content.replace(/[ \t]+#+[ \t]*$/, '')
			return { level: match[1].length, content: content.trim() }
		}

		function markdownIsThematicBreak(line) {
			return (
				/^ {0,3}(?:\*[ \t]*){3,}$/.test(line) ||
				/^ {0,3}(?:-[ \t]*){3,}$/.test(line) ||
				/^ {0,3}(?:_[ \t]*){3,}$/.test(line)
			)
		}

		function markdownIsSetextUnderline(line) {
			return /^ {0,3}(?:=+|-+)[ \t]*$/.test(line)
		}

		function markdownBlockquoteMatch(line) {
			const match = /^ {0,3}>[ \t]?(.*)$/.exec(line)
			return match ? match[1] : null
		}

		function markdownListMarker(line) {
			const match = /^( {0,3})([-+*]|([0-9]{1,9})[.)])([ \t]+|$)/.exec(line)
			if (!match) return null
			const indent = match[1].length
			const marker = match[2]
			const rest = line.slice(indent + marker.length)
			const spacing = /^[ \t]*/.exec(rest)[0]
			const padding = spacing.length >= 1 && spacing.length <= 4 ? spacing.length : 1
			const ordered = /^[0-9]/.test(marker)
			return {
				indent,
				ordered,
				number: ordered ? parseInt(marker, 10) : 1,
				contentIndent: indent + marker.length + padding,
				content: markdownStripColumns(rest, padding),
			}
		}

		function markdownStartsBlock(lines, index) {
			const line = lines[index]
			if (line === undefined) return false
			if (markdownFenceMatch(line)) return true
			if (markdownAtxMatch(line)) return true
			if (markdownIsThematicBreak(line)) return true
			if (markdownBlockquoteMatch(line) !== null) return true
			if (markdownListMarker(line)) return true
			if (markdownLeadingColumns(line) >= 4) return true
			return false
		}

		function markdownParseFenced(lines, start, fence) {
			const content = []
			let index = start + 1
			while (index < lines.length) {
				if (fence.close.test(lines[index])) {
					index += 1
					break
				}
				content.push(lines[index])
				index += 1
			}
			const lang = fence.info.split(/[ \t]+/)[0] || ''
			return { block: { type: 'code', lang, value: content.join('\n') }, next: index }
		}

		function markdownParseIndentedCode(lines, start) {
			const content = []
			let index = start
			let pendingBlanks = 0
			while (index < lines.length) {
				const line = lines[index]
				if (markdownIsBlank(line)) {
					pendingBlanks += 1
					index += 1
					continue
				}
				if (markdownLeadingColumns(line) < 4) break
				for (let blank = 0; blank < pendingBlanks; blank += 1) content.push('')
				pendingBlanks = 0
				content.push(markdownStripColumns(line, 4))
				index += 1
			}
			return { block: { type: 'code', lang: '', value: content.join('\n') }, next: index }
		}

		function markdownParseBlockquote(lines, start, depth) {
			const inner = []
			let index = start
			while (index < lines.length) {
				const stripped = markdownBlockquoteMatch(lines[index])
				if (stripped === null) break
				inner.push(stripped)
				index += 1
			}
			return { block: { type: 'blockquote', children: markdownParseBlocks(inner, depth + 1) }, next: index }
		}

		function markdownItemPlainText(blocks) {
			for (let index = 0; index < blocks.length; index += 1) {
				const block = blocks[index]
				if (block && block.type === 'paragraph') return markdownPlainInlineText(block.children).trim()
			}
			return ''
		}

		function markdownBuildListItem(item, depth) {
			let lines = item.lines
			let task = false
			let checked = false
			if (lines.length > 0) {
				const match = /^\[([ xX])\](?:[ \t]+|$)/.exec(lines[0])
				if (match) {
					task = true
					checked = match[1].toLowerCase() === 'x'
					const remainder = lines[0].slice(match[0].length)
					lines = lines.slice()
					lines[0] = remainder
					if (lines[0] === '') lines.splice(0, 1)
				}
			}
			const children = markdownParseBlocks(lines, depth)
			return { type: 'listItem', task, checked, text: markdownItemPlainText(children), children }
		}

		function markdownParseList(lines, start, depth) {
			const first = markdownListMarker(lines[start])
			const ordered = first.ordered
			const items = []
			let loose = false
			let index = start
			while (index < lines.length) {
				const marker = markdownListMarker(lines[index])
				if (!marker || marker.ordered !== ordered) break
				const item = { lines: [marker.content], contentIndent: marker.contentIndent }
				index += 1
				let blankPending = false
				while (index < lines.length) {
					const line = lines[index]
					if (markdownIsBlank(line)) {
						blankPending = true
						index += 1
						continue
					}
					if (markdownLeadingColumns(line) >= item.contentIndent) {
						if (blankPending) {
							loose = true
							item.lines.push('')
						}
						blankPending = false
						item.lines.push(markdownStripColumns(line, item.contentIndent))
						index += 1
						continue
					}
					if (markdownListMarker(line)) {
						// A blank line between two items makes the whole list loose.
						if (blankPending) loose = true
						break
					}
					if (markdownStartsBlock(lines, index)) break
					if (blankPending) break
					item.lines.push(line.trim())
					index += 1
				}
				let trailing = 0
				while (item.lines.length > 0 && item.lines[item.lines.length - 1] === '') {
					item.lines.pop()
					trailing += 1
				}
				items.push(markdownBuildListItem(item, depth + 1))
				let lookahead = index
				while (lookahead < lines.length && markdownIsBlank(lines[lookahead])) lookahead += 1
				const next = lookahead < lines.length ? markdownListMarker(lines[lookahead]) : null
				if (next && next.ordered === ordered) {
					if (lookahead > index) loose = true
					index = lookahead
					continue
				}
				break
			}
			return {
				block: { type: 'list', ordered, start: ordered ? first.number : 1, tight: !loose, children: items },
				next: index,
			}
		}

		function markdownSplitTableRow(line) {
			const cells = []
			let current = ''
			let escaped = false
			for (let index = 0; index < line.length; index += 1) {
				const ch = line.charAt(index)
				if (escaped) {
					current += ch === '|' ? '|' : '\\' + ch
					escaped = false
					continue
				}
				if (ch === '\\') {
					escaped = true
					continue
				}
				if (ch === '|') {
					cells.push(current)
					current = ''
					continue
				}
				current += ch
			}
			if (escaped) current += '\\'
			cells.push(current)
			const trimmed = line.trim()
			if (trimmed.charAt(0) === '|') cells.shift()
			if (trimmed.charAt(trimmed.length - 1) === '|' && cells.length > 0) cells.pop()
			return cells.map((cell) => cell.trim())
		}

		function markdownTableAlignments(line) {
			const cells = markdownSplitTableRow(line)
			if (cells.length === 0) return null
			const aligns = []
			for (let index = 0; index < cells.length; index += 1) {
				const cell = cells[index]
				if (!/^:?-+:?$/.test(cell)) return null
				const left = cell.charAt(0) === ':'
				const right = cell.charAt(cell.length - 1) === ':'
				aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
			}
			return aligns
		}

		function markdownTryTable(lines, start, depth) {
			const headerLine = lines[start]
			const delimiterLine = lines[start + 1]
			if (delimiterLine === undefined) return null
			const aligns = markdownTableAlignments(delimiterLine)
			if (!aligns) return null
			if (headerLine.indexOf('|') === -1 && delimiterLine.indexOf('|') === -1) return null
			const header = markdownSplitTableRow(headerLine)
			if (header.length === 0 || header.length !== aligns.length) return null
			const rows = []
			let index = start + 2
			while (index < lines.length) {
				const line = lines[index]
				if (markdownIsBlank(line) || line.indexOf('|') === -1) break
				if (markdownStartsBlock(lines, index)) break
				const cells = markdownSplitTableRow(line)
				const normalized = []
				for (let column = 0; column < header.length; column += 1) {
					normalized.push(cells[column] === undefined ? '' : cells[column])
				}
				rows.push(normalized)
				index += 1
			}
			return {
				block: {
					type: 'table',
					align: aligns,
					header: header.map((cell) => ({ type: 'tableCell', children: markdownParseInline(cell, 0) })),
					children: rows.map((row) =>
						row.map((cell) => ({ type: 'tableCell', children: markdownParseInline(cell, 0) })),
					),
				},
				next: index,
			}
		}

		function markdownJoinParagraphLines(lines) {
			return lines.map((line) => line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '')).join('\n')
		}

		function markdownParseParagraph(lines, start) {
			const collected = []
			let index = start
			while (index < lines.length) {
				const line = lines[index]
				if (markdownIsBlank(line)) break
				if (collected.length > 0) {
					if (markdownIsSetextUnderline(line)) break
					if (markdownStartsBlock(lines, index)) break
				}
				collected.push(line)
				index += 1
			}
			if (index < lines.length && collected.length > 0 && markdownIsSetextUnderline(lines[index])) {
				const level = lines[index].trim().charAt(0) === '=' ? 1 : 2
				index += 1
				return {
					block: { type: 'heading', level, children: markdownParseInline(markdownJoinParagraphLines(collected), 0) },
					next: index,
				}
			}
			return {
				block: { type: 'paragraph', children: markdownParseInline(markdownJoinParagraphLines(collected), 0) },
				next: index,
			}
		}

		function markdownParseBlocks(lines, depth) {
			if (depth > MARKDOWN_MAX_BLOCK_DEPTH) {
				const joined = lines
					.map((line) => line.trim())
					.filter((line) => line !== '')
					.join('\n')
				return joined === ''
					? []
					: [{ type: 'paragraph', children: [markdownTextNode(markdownDecodeEntitiesIn(markdownUnescape(joined)))] }]
			}
			const blocks = []
			let index = 0
			while (index < lines.length) {
				const line = lines[index]
				if (markdownIsBlank(line)) {
					index += 1
					continue
				}
				const fence = markdownFenceMatch(line)
				if (fence) {
					const parsed = markdownParseFenced(lines, index, fence)
					blocks.push(parsed.block)
					index = parsed.next
					continue
				}
				const atx = markdownAtxMatch(line)
				if (atx) {
					blocks.push({ type: 'heading', level: atx.level, children: markdownParseInline(atx.content, 0) })
					index += 1
					continue
				}
				if (markdownIsThematicBreak(line)) {
					blocks.push({ type: 'hr' })
					index += 1
					continue
				}
				if (markdownBlockquoteMatch(line) !== null) {
					const parsed = markdownParseBlockquote(lines, index, depth)
					blocks.push(parsed.block)
					index = parsed.next
					continue
				}
				if (markdownListMarker(line)) {
					const parsed = markdownParseList(lines, index, depth)
					blocks.push(parsed.block)
					index = parsed.next
					continue
				}
				const table = markdownTryTable(lines, index, depth)
				if (table) {
					blocks.push(table.block)
					index = table.next
					continue
				}
				if (markdownLeadingColumns(line) >= 4) {
					const parsed = markdownParseIndentedCode(lines, index)
					blocks.push(parsed.block)
					index = parsed.next
					continue
				}
				const paragraph = markdownParseParagraph(lines, index)
				blocks.push(paragraph.block)
				index = paragraph.next > index ? paragraph.next : index + 1
			}
			return blocks
		}

		// --- Inline parsing -------------------------------------------------

		function markdownCodeSpans(source) {
			const spans = new Map()
			let index = 0
			while (index < source.length) {
				const ch = source.charAt(index)
				if (ch === '\\') {
					index += 2
					continue
				}
				if (ch !== '`') {
					index += 1
					continue
				}
				let run = 1
				while (index + run < source.length && source.charAt(index + run) === '`') run += 1
				const marker = new Array(run + 1).join('`')
				let search = index + run
				let close = -1
				while (search < source.length) {
					const found = source.indexOf(marker, search)
					if (found === -1) break
					const before = found > 0 ? source.charAt(found - 1) : ''
					const after = source.charAt(found + run)
					if (before !== '`' && after !== '`') {
						close = found
						break
					}
					search = found + run
				}
				if (close === -1) {
					index += run
					continue
				}
				spans.set(index, { end: close + run, value: source.slice(index + run, close) })
				index = close + run
			}
			return spans
		}

		function markdownNormalizeCodeSpan(value) {
			let text = value.replace(/\n/g, ' ')
			if (text.length >= 2 && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ' && text.trim() !== '') {
				text = text.slice(1, -1)
			}
			return text
		}

		function markdownDelimiterRun(source, start, length, char) {
			const end = start + length
			const before = start === 0 ? '\n' : source.charAt(start - 1)
			const after = end >= source.length ? '\n' : source.charAt(end)
			const beforeWhitespace = /\s/.test(before)
			const afterWhitespace = /\s/.test(after)
			const beforePunctuation = MARKDOWN_ASCII_PUNCTUATION_RE.test(before)
			const afterPunctuation = MARKDOWN_ASCII_PUNCTUATION_RE.test(after)
			const leftFlanking = !afterWhitespace && (!afterPunctuation || beforeWhitespace || beforePunctuation)
			const rightFlanking = !beforeWhitespace && (!beforePunctuation || afterWhitespace || afterPunctuation)
			let canOpen = leftFlanking
			let canClose = rightFlanking
			if (char === '_') {
				canOpen = leftFlanking && (!rightFlanking || beforePunctuation)
				canClose = rightFlanking && (!leftFlanking || afterPunctuation)
			}
			if (char === '~') {
				const enough = length >= 2
				canOpen = enough && leftFlanking
				canClose = enough && rightFlanking
			}
			return { start, end, char, length, canOpen, canClose }
		}

		function markdownMatchDelimiters(runs) {
			const pairs = new Map()
			const stacks = { '*': [], _: [], '~': [] }
			for (let index = 0; index < runs.length; index += 1) {
				const run = runs[index]
				const stack = stacks[run.char]
				let openerIndex = -1
				if (run.canClose) {
					for (let cursor = stack.length - 1; cursor >= 0; cursor -= 1) {
						const opener = stack[cursor]
						if (run.char !== '~' || (opener.length >= 2 && run.length >= 2)) {
							openerIndex = cursor
							break
						}
					}
				}
				if (openerIndex >= 0) {
					const opener = stack[openerIndex]
					stack.length = openerIndex
					pairs.set(opener.start, {
						close: run.start,
						char: run.char,
						strong: run.length >= 2 && opener.length >= 2,
						triple: run.length >= 3 && opener.length >= 3,
					})
					continue
				}
				if (run.canOpen) stack.push(run)
			}
			return pairs
		}

		function markdownInlineScaffold(source) {
			const codeSpans = markdownCodeSpans(source)
			const brackets = new Map()
			const parens = new Map()
			const runs = []
			const runByStart = new Map()
			const bracketStack = []
			const parenStack = []
			let index = 0
			while (index < source.length) {
				const span = codeSpans.get(index)
				if (span) {
					index = span.end
					continue
				}
				const ch = source.charAt(index)
				if (ch === '\\') {
					index += 2
					continue
				}
				if (ch === '[') {
					bracketStack.push(index)
					index += 1
					continue
				}
				if (ch === ']') {
					if (bracketStack.length > 0) brackets.set(bracketStack.pop(), index)
					index += 1
					continue
				}
				if (ch === '(') {
					parenStack.push(index)
					index += 1
					continue
				}
				if (ch === ')') {
					if (parenStack.length > 0) parens.set(parenStack.pop(), index)
					index += 1
					continue
				}
				if (ch === '*' || ch === '_' || ch === '~') {
					let run = 1
					while (index + run < source.length && source.charAt(index + run) === ch) run += 1
					const info = markdownDelimiterRun(source, index, run, ch)
					runs.push(info)
					runByStart.set(index, info)
					index += run
					continue
				}
				index += 1
			}
			return { codeSpans, brackets, parens, runs, runByStart, pairs: markdownMatchDelimiters(runs) }
		}

		function markdownCleanDestination(value) {
			let destination = String(value === undefined ? '' : value).trim()
			if (destination.length >= 2 && destination.charAt(0) === '<' && destination.charAt(destination.length - 1) === '>') {
				destination = destination.slice(1, -1)
			}
			const title = /^(\S+)[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$/.exec(destination)
			if (title) destination = title[1]
			return markdownDecodeEntitiesIn(markdownUnescape(destination)).trim()
		}

		function markdownPlainInlineText(nodes) {
			let out = ''
			if (!Array.isArray(nodes)) return out
			for (let index = 0; index < nodes.length; index += 1) {
				const node = nodes[index]
				if (!node) continue
				if (node.type === 'text' || node.type === 'code') out += String(node.value === undefined ? '' : node.value)
				else if (node.type === 'br') out += ' '
				else if (node.children) out += markdownPlainInlineText(node.children)
			}
			return out
		}

		function markdownParseInline(source, depth) {
			const level = typeof depth === 'number' ? depth : 0
			if (typeof source !== 'string' || source === '') return []
			if (level > MARKDOWN_MAX_INLINE_DEPTH) {
				return [markdownTextNode(markdownDecodeEntitiesIn(markdownUnescape(source)))]
			}
			const scaffold = markdownInlineScaffold(source)
			const nodes = []
			let text = ''
			const flush = () => {
				if (text !== '') {
					nodes.push({ type: 'text', value: text })
					text = ''
				}
			}
			let index = 0
			while (index < source.length) {
				const span = scaffold.codeSpans.get(index)
				if (span) {
					flush()
					nodes.push({ type: 'code', value: markdownNormalizeCodeSpan(span.value) })
					index = span.end
					continue
				}
				const ch = source.charAt(index)
				if (ch === '\\') {
					const next = index + 1 < source.length ? source.charAt(index + 1) : ''
					if (next !== '' && MARKDOWN_ASCII_PUNCTUATION_RE.test(next)) {
						text += next
						index += 2
					} else {
						text += '\\'
						index += 1
					}
					continue
				}
				const pair = scaffold.pairs.get(index)
				if (pair) {
					const opener = scaffold.runByStart.get(index)
					if (opener) {
						flush()
						const inner = source.slice(opener.end, pair.close)
						const children = markdownParseInline(inner, level + 1)
						const node =
							pair.char === '~'
								? { type: 'del', children }
								: pair.triple
									? { type: 'strong', children: [{ type: 'em', children }] }
									: { type: pair.strong ? 'strong' : 'em', children }
						nodes.push(node)
						const closer = scaffold.runByStart.get(pair.close)
						index = closer ? closer.end : pair.close + 1
						continue
					}
				}
				const run = scaffold.runByStart.get(index)
				if (run) {
					flush()
					nodes.push({ type: 'text', value: source.slice(run.start, run.end) })
					index = run.end
					continue
				}
				if (ch === '!' && source.charAt(index + 1) === '[') {
					const open = index + 1
					const close = scaffold.brackets.get(open)
					if (close !== undefined && source.charAt(close + 1) === '(') {
						const closeParen = scaffold.parens.get(close + 1)
						if (closeParen !== undefined) {
							flush()
							const label = markdownParseInline(source.slice(open + 1, close), level + 1)
							const alt = markdownPlainInlineText(label)
							const src = markdownCleanDestination(source.slice(close + 2, closeParen))
							nodes.push({ type: 'image', src, alt })
							index = closeParen + 1
							continue
						}
					}
					text += '!'
					index += 1
					continue
				}
				if (ch === '[') {
					const close = scaffold.brackets.get(index)
					if (close !== undefined && source.charAt(close + 1) === '(') {
						const closeParen = scaffold.parens.get(close + 1)
						if (closeParen !== undefined) {
							flush()
							const label = markdownParseInline(source.slice(index + 1, close), level + 1)
							const href = markdownCleanDestination(source.slice(close + 2, closeParen))
							nodes.push({ type: 'link', href, children: label })
							index = closeParen + 1
							continue
						}
					}
					text += '['
					index += 1
					continue
				}
				if (ch === '<') {
					MARKDOWN_URI_AUTOLINK_RE.lastIndex = index
					const uri = MARKDOWN_URI_AUTOLINK_RE.exec(source)
					if (uri) {
						flush()
						const target = markdownDecodeEntitiesIn(uri[1])
						nodes.push({ type: 'link', href: target, children: [markdownTextNode(target)] })
						index += uri[0].length
						continue
					}
					MARKDOWN_EMAIL_AUTOLINK_RE.lastIndex = index
					const email = MARKDOWN_EMAIL_AUTOLINK_RE.exec(source)
					if (email) {
						flush()
						nodes.push({
							type: 'link',
							href: 'mailto:' + email[1],
							children: [markdownTextNode(email[1])],
						})
						index += email[0].length
						continue
					}
					text += '<'
					index += 1
					continue
				}
				if (ch === '&') {
					MARKDOWN_ENTITY_AT_RE.lastIndex = index
					const entity = MARKDOWN_ENTITY_AT_RE.exec(source)
					if (entity) {
						text += markdownEntityValue(entity)
						index += entity[0].length
						continue
					}
					text += '&'
					index += 1
					continue
				}
				if (ch === '\n') {
					flush()
					nodes.push({ type: 'br' })
					index += 1
					continue
				}
				text += ch
				index += 1
			}
			flush()
			return nodes
		}

		// --- Public parse + render -----------------------------------------

		function parseMarkdown(source) {
			const text = markdownNormalize(source)
			if (text.trim() === '') return markdownDeepFreeze([])
			try {
				const lines = text.split('\n')
				return markdownDeepFreeze(markdownParseBlocks(lines, 0))
			} catch (error) {
				// Untrusted text must never take the panel down: degrade to empty.
				return markdownDeepFreeze([])
			}
		}

		function markdownIsSafeDestination(value) {
			if (typeof value !== 'string') return false
			const destination = value.trim()
			if (destination === '') return false
			const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(destination)
			if (!scheme) return false
			return MARKDOWN_ALLOWED_SCHEMES.indexOf(scheme[1].toLowerCase()) !== -1
		}

		function markdownCreateElement(h, type, props, children) {
			const list = children || []
			if (list.length === 0) return h(type, props)
			if (list.length <= 512) return h(type, props, ...list)
			// Very large child lists exceed the engine call-argument limit; React
			// accepts an array child and flattens it, so keep the render safe.
			return h(type, props, list)
		}

		function markdownFlattenInto(target, value) {
			if (value === null || value === undefined) return
			if (Array.isArray(value)) {
				for (let index = 0; index < value.length; index += 1) markdownFlattenInto(target, value[index])
				return
			}
			target.push(value)
		}

		function markdownRenderInlines(nodes, h) {
			const out = []
			if (!Array.isArray(nodes)) return out
			for (let index = 0; index < nodes.length; index += 1) {
				const node = nodes[index]
				if (node === null || node === undefined) continue
				if (typeof node === 'string') {
					out.push(node)
					continue
				}
				if (typeof node.type !== 'string') continue
				switch (node.type) {
					case 'text':
						out.push(String(node.value === undefined ? '' : node.value))
						break
					case 'br':
						out.push(h('br', null))
						break
					case 'strong':
						out.push(markdownCreateElement(h, 'strong', null, markdownRenderInlines(node.children, h)))
						break
					case 'em':
						out.push(markdownCreateElement(h, 'em', null, markdownRenderInlines(node.children, h)))
						break
					case 'del':
						out.push(markdownCreateElement(h, 'del', null, markdownRenderInlines(node.children, h)))
						break
					case 'code':
						out.push(markdownCreateElement(h, 'code', null, [String(node.value === undefined ? '' : node.value)]))
						break
					case 'link': {
						const children = markdownRenderInlines(node.children, h)
						if (markdownIsSafeDestination(node.href)) {
							out.push(
								markdownCreateElement(
									h,
									'a',
									{ href: node.href.trim(), target: '_blank', rel: 'noopener noreferrer nofollow' },
									children,
								),
							)
						} else {
							markdownFlattenInto(out, children)
						}
						break
					}
					case 'image': {
						const alt = typeof node.alt === 'string' ? node.alt : ''
						// Safe destination: the anchor is labelled with the alt text and
						// falls back to the source string. Unsafe/relative destination:
						// only the alt text survives as plain text (never a link, never an
						// image, never a fetch).
						const label = alt.trim() !== '' ? alt : String(node.src === undefined ? '' : node.src)
						if (markdownIsSafeDestination(node.src)) {
							out.push(
								markdownCreateElement(
									h,
									'a',
									{ href: node.src.trim(), target: '_blank', rel: 'noopener noreferrer nofollow' },
									[label],
								),
							)
						} else if (alt !== '') {
							out.push(alt)
						}
						break
					}
					default:
						break
				}
			}
			return out
		}

		function markdownRenderTable(node, h) {
			const align = Array.isArray(node.align) ? node.align : []
			const headerCells = []
			for (let column = 0; column < node.header.length; column += 1) {
				const cell = node.header[column]
				const props = align[column] ? { 'data-align': align[column] } : null
				headerCells.push(markdownCreateElement(h, 'th', props, markdownRenderInlines(cell.children, h)))
			}
			const headRow = markdownCreateElement(h, 'tr', null, headerCells)
			const thead = markdownCreateElement(h, 'thead', null, [headRow])
			const bodyRows = []
			for (let row = 0; row < node.children.length; row += 1) {
				const cells = node.children[row]
				const rowCells = []
				for (let column = 0; column < cells.length; column += 1) {
					const cell = cells[column]
					const props = align[column] ? { 'data-align': align[column] } : null
					rowCells.push(markdownCreateElement(h, 'td', props, markdownRenderInlines(cell.children, h)))
				}
				bodyRows.push(markdownCreateElement(h, 'tr', null, rowCells))
			}
			const tbody = markdownCreateElement(h, 'tbody', null, bodyRows)
			return markdownCreateElement(h, 'table', null, [thead, tbody])
		}

		function markdownRenderList(node, h) {
			const tag = node.ordered ? 'ol' : 'ul'
			const props = node.ordered && node.start !== 1 ? { start: node.start } : null
			const items = []
			for (let index = 0; index < node.children.length; index += 1) {
				const item = node.children[index]
				const children = []
				if (item.task) {
					children.push(
						h('input', {
							type: 'checkbox',
							disabled: true,
							defaultChecked: item.checked === true,
							'aria-label': typeof item.text === 'string' ? item.text : '',
						}),
					)
				}
				markdownFlattenInto(children, markdownRenderBlocks(item.children, h, node.tight))
				items.push(markdownCreateElement(h, 'li', null, children))
			}
			return markdownCreateElement(h, tag, props, items)
		}

		function markdownRenderBlock(node, h) {
			if (!node || typeof node.type !== 'string') return null
			switch (node.type) {
				case 'paragraph':
					return markdownCreateElement(h, 'p', null, markdownRenderInlines(node.children, h))
				case 'heading': {
					const tag = MARKDOWN_HEADING_TAGS[node.level] || 'h6'
					return markdownCreateElement(h, tag, null, markdownRenderInlines(node.children, h))
				}
				case 'code': {
					const props = node.lang ? { 'data-lang': node.lang } : null
					const code = markdownCreateElement(h, 'code', props, [String(node.value === undefined ? '' : node.value)])
					return markdownCreateElement(h, 'pre', null, [code])
				}
				case 'hr':
					return h('hr', null)
				case 'blockquote':
					return markdownCreateElement(h, 'blockquote', null, markdownRenderBlocks(node.children, h, false))
				case 'list':
					return markdownRenderList(node, h)
				case 'table':
					return markdownRenderTable(node, h)
				default:
					return null
			}
		}

		function markdownRenderBlocks(blocks, h, tight) {
			const out = []
			if (!Array.isArray(blocks)) return out
			for (let index = 0; index < blocks.length; index += 1) {
				const node = blocks[index]
				if (node === null || node === undefined) continue
				if (tight && node.type === 'paragraph') {
					markdownFlattenInto(out, markdownRenderInlines(node.children, h))
					continue
				}
				markdownFlattenInto(out, markdownRenderBlock(node, h))
			}
			return out
		}

		function renderMarkdown(ast, h) {
			if (!Array.isArray(ast) || typeof h !== 'function') return []
			return markdownRenderBlocks(ast, h, false)
		}

		// ------------------------------------------------------------------
		// Shared Markdown surface component (KB-57)
		//
		// The engine above owns parsing and element construction; this component
		// only decorates the rendered element tree with the accessibility
		// affordances the surfaces need (labelled scroll regions, external-link
		// names, table header scope). Parsing is memoized on the raw text while
		// rendering re-runs on a locale change, so translated aria labels update
		// without a second parse. Empty text renders nothing at all: each surface
		// keeps its own localized empty state instead of an empty bordered box.
		// ------------------------------------------------------------------

		function markdownPlainText(value) {
			if (typeof value === 'string') return value
			if (typeof value === 'number') return String(value)
			if (Array.isArray(value)) {
				let out = ''
				for (let index = 0; index < value.length; index += 1) out += markdownPlainText(value[index])
				return out
			}
			if (value && typeof value === 'object') {
				// The fake-React harness stores rest children on the element; the
				// real React element exposes them as props.children.
				const children = value.children !== undefined ? value.children : value.props && value.props.children
				return children === undefined ? '' : markdownPlainText(children)
			}
			return ''
		}

		function markdownLinkHost(href) {
			if (typeof href !== 'string') return ''
			const destination = href.trim()
			if (destination === '') return ''
			try {
				const parsed = new URL(destination)
				if (parsed.protocol === 'mailto:') return destination.slice('mailto:'.length).split('?')[0]
				return parsed.host || ''
			} catch (error) {
				return ''
			}
		}

		function markdownDecorator(t, h) {
			const translate = typeof t === 'function' ? t : (key) => key
			return function decorateMarkdownElement(type, props, ...children) {
				const next = props && typeof props === 'object' ? Object.assign({}, props) : {}
				if (type === 'th') next.scope = 'col'
				if (type === 'pre') {
					next.tabIndex = 0
					next['aria-label'] = translate('md.codeBlock')
				}
				if (type === 'a') {
					const host = markdownLinkHost(next.href)
					const visible = markdownPlainText(children).trim()
					const parts = []
					if (visible !== '' && visible !== host) parts.push(visible)
					if (host !== '') parts.push(host)
					parts.push(translate('md.linkExternal'))
					next['aria-label'] = parts.join(' — ')
					const linkChildren = children.concat([h(IconExternal, { className: 'kb-md-linkIcon', size: 11 })])
					if (linkChildren.length > 512) return h('a', next, linkChildren)
					return h('a', next, ...linkChildren)
				}
				if (type === 'table') {
					return h(
						'div',
						{ className: 'kb-md-tableWrap', role: 'region', tabIndex: 0, 'aria-label': translate('md.table') },
						h('table', next, ...children),
					)
				}
				if (children.length === 0) return h(type, Object.keys(next).length > 0 ? next : null)
				return h(type, Object.keys(next).length > 0 ? next : null, ...children)
			}
		}

		function MarkdownBodyContent(props) {
			const text = typeof props.text === 'string' ? props.text : ''
			// Only parsing is memoized; every render re-decorates so a locale
			// change updates the aria labels without parsing the text again.
			const ast = React.useMemo(() => parseMarkdown(text), [text])
			const decorate = markdownDecorator(props.t, h)
			const children = renderMarkdown(ast, decorate)
			if (!Array.isArray(children) || children.length === 0) return null
			const wrapperProps = { className: classNames('kb-md', typeof props.className === 'string' ? props.className : '') }
			if (typeof props.label === 'string' && props.label !== '') wrapperProps['aria-label'] = props.label
			// Mirror the engine's argument-limit guard for hostile, very large documents.
			if (children.length > 512) return h('div', wrapperProps, children)
			return h('div', wrapperProps, ...children)
		}

		function MarkdownBody(props) {
			const text = props && typeof props.text === 'string' ? props.text : ''
			// Empty/whitespace input renders nothing (no wrapper, no border) and
			// never reaches the parse hook, so surfaces keep their own empty copy.
			if (text.trim() === '') return null
			return h(MarkdownBodyContent, props)
		}

		// KB-59: plain accessible-name projection for the surfaces that keep a native
		// input beside rendered Markdown (the blocked-execution answer fields). It
		// mirrors what a reader sees — link labels without their destinations, code
		// text without delimiters, one line — by stripping markers instead of
		// parsing, so an aria label never adds a second parse to a polling render.
		// KB-60 reuses it for the collapsed thought-row preview: block and inline
		// syntax is stripped while literal characters (`C#`, `issue #12`, a pipe in
		// prose) and fenced-code content survive.
		// This stays a local helper: the engine's public export is unchanged.
		function markdownPlainLabel(source) {
			if (typeof source !== 'string' || source === '') return ''
			const lines = source.replace(/\r\n?/g, '\n').split('\n')
			// Fences and GFM tables are structural: their delimiter lines disappear and
			// their content is projected as text, never mistaken for block markers or
			// for prose. Mark them in a first pass so the line pass below stays pure.
			const codeLine = new Array(lines.length).fill(false)
			const tableLine = new Array(lines.length).fill(false)
			const fenceLine = new Array(lines.length).fill(false)
			let fence = null
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index]
				if (fence) {
					const close = new RegExp('^[ \\t]*' + (fence.char === '`' ? '`' : '~') + '{' + fence.length + ',}[ \\t]*$')
					if (close.test(line)) {
						fenceLine[index] = true
						fence = null
					} else {
						codeLine[index] = true
					}
					continue
				}
				const open = /^[ \t]*(`{3,}|~{3,})/.exec(line)
				if (open) {
					fenceLine[index] = true
					fence = { char: open[1].charAt(0), length: open[1].length }
				}
			}
			const isTableRule = (line) =>
				line.indexOf('|') !== -1 && /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line)
			const isListLine = (line) => /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/.test(line)
			// Indented code (four or more spaces) is content, so its markers must
			// survive. A four-space line after a list item is a nested list item, not
			// code, which is why the previous non-blank line decides.
			const indentedCode = new Array(lines.length).fill(false)
			for (let index = 0; index < lines.length; index += 1) {
				if (codeLine[index] || fenceLine[index] || !/^[ \t]{4,}\S/.test(lines[index])) continue
				let previous = index - 1
				while (previous >= 0 && lines[previous].trim() === '') previous -= 1
				const separated = index > 0 && lines[index - 1].trim() === ''
				if (previous < 0 || indentedCode[previous] || (separated && !isListLine(lines[previous]))) indentedCode[index] = true
			}
			for (let index = 0; index + 1 < lines.length; index += 1) {
				if (codeLine[index] || codeLine[index + 1] || tableLine[index]) continue
				if (lines[index].indexOf('|') === -1 || !isTableRule(lines[index + 1])) continue
				tableLine[index] = true
				tableLine[index + 1] = true
				for (let row = index + 2; row < lines.length; row += 1) {
					if (codeLine[row] || tableLine[row] || lines[row].trim() === '' || lines[row].indexOf('|') === -1) break
					tableLine[row] = true
				}
			}
			// Images keep their alt text; links keep their label, never the destination.
			// One level of balanced parentheses is allowed inside a destination so a
			// hostile `[click](javascript:alert(1))` projects to just `click`.
			const projectInline = (line) => {
				// Backslash-escaped punctuation is literal content, not syntax. Park each
				// escaped character behind a token so the strippers below cannot consume it,
				// then restore the character itself at the end.
				const escaped = []
				let text = line.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, (match, char) => {
					escaped.push(char)
					return '\u0001' + (escaped.length - 1) + '\u0002'
				})
				text = text.replace(/!\[([^\]]*)\]\(([^()\n]|\([^()\n]*\))*\)/g, '$1')
				text = text.replace(/\[([^\]]*)\]\(([^()\n]|\([^()\n]*\))*\)/g, '$1')
				// Code spans and emphasis / strike delimiters.
				text = text.replace(/`+/g, '')
				text = text.replace(/~~(?=\S)([^~]+?)~~/g, '$1')
				text = text.replace(/\*\*\*(?=\S)([^*]+?)\*\*\*/g, '$1')
				text = text.replace(/\*\*(?=\S)([^*]+?)\*\*/g, '$1')
				text = text.replace(/\*(?=\S)([^*]+?)\*/g, '$1')
				text = text.replace(/(^|[\s([{])_+(?=\S)([^_\n]+?)_+(?=[\s)\]}.,;:!?]|$)/g, '$1$2')
				// An angle autolink's target is its visible label, so keep the target and
				// drop only the brackets (`<https://…>` / `<user@example.com>`).
				text = text.replace(/<((?:[a-z][a-z0-9+.-]*:[^<>\s]+)|(?:[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+))>/gi, '$1')
				text = text.replace(/\u0001(\d+)\u0002/g, (match, index) => escaped[Number(index)] || '')
				return text
			}
			const projected = []
			for (let index = 0; index < lines.length; index += 1) {
				const line = lines[index]
				if (fenceLine[index]) continue
				// Code-block content survives verbatim (whitespace collapses at the end).
				if (codeLine[index]) {
					projected.push(line)
					continue
				}
				if (indentedCode[index]) {
					projected.push(line)
					continue
				}
				if (tableLine[index]) {
					if (isTableRule(line)) continue
					// Row pipes are structural; an escaped pipe stays a literal cell pipe.
					// Cell content runs through the same inline projection as prose, so a
					// cell carrying **bold**, `code` or [a link](url) also stays clean.
					const cells = line
						.replace(/^[ \t]*\|/, '')
						.replace(/\|[ \t]*$/, '')
						.replace(/\\\|/g, '\u0000')
						.split('|')
						.map((cell) => projectInline(cell.replace(/\u0000/g, '|').trim()))
					projected.push(cells.join(' '))
					continue
				}
				// Thematic breaks and setext underlines.
				if (/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) continue
				if (/^[ \t]{0,3}=+[ \t]*$/.test(line)) continue
				let block = line
				// Nested blockquote markers, then headings, then task/list markers.
				while (/^[ \t]{0,3}>[ \t]?/.test(block)) block = block.replace(/^[ \t]{0,3}>[ \t]?/, '')
				const heading = /^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/.test(block)
				block = block.replace(/^[ \t]{0,3}#{1,6}(?:[ \t]+|$)/, '')
				// An ATX closing sequence is syntax only on a heading line; a paragraph
				// ending in `#` characters keeps them (`C#`, `issue #12`).
				if (heading) block = block.replace(/[ \t]+#+[ \t]*$/, '')
				block = block.replace(/^[ \t]*(?:[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d{1,9}[.)][ \t]+)/, '')
				projected.push(projectInline(block))
			}
			return projected.join(' ').replace(/\s+/g, ' ').trim()
		}

		// ------------------------------------------------------------------
		// Plugin registration
		// ------------------------------------------------------------------

		const inject = ['slots', 'locale', 'uiWorkspace', 'sessions']

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'kanban: dictionaries')
			const t = ctx.locale.bind(NS)

			const openSession = (sessionId) => {
				try {
					ctx.uiWorkspace.openSession(sessionId)
				} catch (error) {
					console.warn('kanban: open session failed', error)
				}
			}

			const readSessionCwd = () => {
				try {
					const list = ctx.sessions && ctx.sessions.list ? ctx.sessions.list.getSnapshot() : null
					const byId = list && list.byId && typeof list.byId === 'object' ? list.byId : null
					if (!byId) return null
					const rows = Object.keys(byId)
						.map((key) => byId[key])
						.filter((row) => row && typeof row === 'object')
					const active =
						rows.find((row) => row.retainedBy && safeNumber(row.retainedBy.mainView, 0) > 0) || rows[0]
					return active && typeof active.cwd === 'string' ? active.cwd : null
				} catch (error) {
					return null
				}
			}

			// Voice dictation (KB-2): the installed voice bundle mounts an
			// optional experimental `remote.speech` namespace. Look it up lazily
			// so the board loads and the dialog stays text-only when it is absent.
			const getSpeech = () => {
				try {
					return typeof ctx.get === 'function' ? ctx.get('remote.speech') || null : null
				} catch (error) {
					return null
				}
			}

			ctx.slots.inject('main', () =>
				ctx.slots.register(
					{
						name: 'main',
						key: 'kanban',
						locale: NS,
						inject: () => ({ openSession, readSessionCwd, getSpeech }),
					},
					KanbanPageBoundary,
				),
			)

			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register(
					{
						name: 'sidebar.panellist',
						id: 'kanban',
						order: 15,
						locale: NS,
						label: () => t('panel.title'),
					},
					KanbanIcon,
				),
			)
		}

		const plugin = { inject, apply }

		// KB-56: additive, unconditional export of the safe Markdown engine
		// (`parse` -> deep-frozen AST, `render` -> React elements only).
		// KB-57 extends it with the shared `MarkdownBody` surface component.
		plugin.markdown = Object.freeze({ parse: parseMarkdown, render: renderMarkdown, MarkdownBody })
		// Test seam (KB-60): the dependency-free Markdown suite drives the collapsed
		// thought-row projection, and the probe renders one row at component level for
		// the failed-only branch a paused board cannot produce safely. Production
		// exports stay apply/inject.
		if (typeof globalThis === 'object' && globalThis.__KB60_THOUGHT_TEST__ === true) {
			plugin.__thoughtRow = Object.freeze({ project: markdownPlainLabel, ThoughtRowView })
		}
		// Test seam: the dependency-free client harness sets this before it
		// materializes the module so tests/voice.test.mjs can drive the dictation
		// engine with a fake bundle double. Production exports stay apply/inject.
		if (typeof globalThis === 'object' && globalThis.__KB2_VOICE_TEST__ === true) {
			plugin.__voice = { appendTranscript, encodeWave, waveBase64, captureFailureKind, readVoiceCatalog, createVoiceEngine }
		}
		// Test seam (KB-76): the dependency-free UI suite drives the pure autopilot
		// state machine, the preview projection and the debounced commit queue
		// without a DOM. Production exports stay apply/inject.
		if (typeof globalThis === 'object' && globalThis.__KB4_AUTOPILOT_UI_TEST__ === true) {
			plugin.__autopilot = {
				AUTOPILOT_ALERT_REASONS,
				AUTOPILOT_COMMIT_MS,
				AUTOPILOT_CONFIRM_KEY,
				AUTOPILOT_CADENCE_MINUTES,
				AUTOPILOT_DEPTH_OPTIONS,
				AUTOPILOT_FEED_MAX,
				AUTOPILOT_LANE_CAP_OPTIONS,
				AUTOPILOT_LANES,
				AUTOPILOT_PULSE_KEEP,
				AUTOPILOT_REASON_CODES,
				AUTOPILOT_TRIGGERS,
				applyAutopilotPatch,
				autopilotBudgetRows,
				autopilotCountdownAria,
				autopilotCountdownLabel,
				autopilotCountdownMode,
				autopilotCountdownRemaining,
				autopilotCountdownSeconds,
				autopilotErrorText,
				autopilotExecutionLane,
				autopilotFeedState,
				autopilotLaneAdmission,
				autopilotLaneAdmissions,
				autopilotLaneOccupancy,
				autopilotPauseCause,
				autopilotPulseAlertReasons,
				autopilotReasonLabel,
				autopilotReasonSummary,
				autopilotStateLabel,
				autopilotTriggerLabel,
				autopilotViewFromSnapshot,
				autopilotConfigFromStatus,
				buildAutopilotAlerts,
				buildAutopilotFeed,
				buildAutopilotPreview,
				canPreviewAutopilot,
				canPulseAutopilot,
				createAutopilotCommitQueue,
				formatAutopilotDuration,
				formatAutopilotPulseStamp,
				formatAutopilotPulseTime,
				initialAutopilotCountdown,
				initialAutopilotPulseState,
				initialAutopilotUi,
				markAutopilotConfirmSeen,
				memberAutopilotState,
				mergeAutopilotPatch,
				mergeAutopilotPulses,
				normalizeAutopilotConfig,
				normalizeAutopilotError,
				readAutopilotConfirmSeen,
				reduceAutopilot,
				reduceAutopilotCountdown,
				reduceAutopilotPulseState,
			}
		}
		return plugin

	},
})
