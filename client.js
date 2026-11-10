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
		const TYPES = ['story', 'task', 'bug', 'spike']
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
		// MemberRow.status values (KB-13) plus the legacy AgentRow statuses.
		const MEMBER_STATUSES = ['paused', 'working', 'running', 'idle', 'offline']
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
			'team.activeTickets': '{n} active',
			'team.close': 'Hide team',
			'team.openTicket': 'Open {id}',
			'team.members': '{n} members',
			'team.working': '{n} working',
			'team.roster': 'Members',
			'team.rosterEmpty': 'No members yet. Add one manually, or describe a teammate and let the AI draft it.',
			'team.addMember': 'Add member',
			'team.addWithAi': 'Add with AI',
			'team.otherAgents': 'Other agents',
			'team.otherAgentsEmpty': 'No session agents outside the roster',
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
			'team.activeTickets': '{n} 项进行中',
			'team.close': '隐藏团队',
			'team.openTicket': '打开 {id}',
			'team.members': '{n} 位成员',
			'team.working': '{n} 位工作中',
			'team.roster': '成员',
			'team.rosterEmpty': '还没有成员。可以手动添加，或描述一位伙伴让 AI 起草。',
			'team.addMember': '添加成员',
			'team.addWithAi': 'AI 添加',
			'team.otherAgents': '其他代理',
			'team.otherAgentsEmpty': '名册之外暂无会话代理',
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
.kb-vision{max-height:140px;overflow-y:auto;padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.55;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
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
.kb-candidateTitle{font-size:12px;font-weight:500;line-height:1.4;overflow-wrap:anywhere}
.kb-candidateDesc{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
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

		function Spinner() {
			return h('span', { className: 'kb-spinner', 'aria-hidden': 'true' })
		}

		function Button(props) {
			return h(
				'button',
				{
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
			const { t, ticket, blocked, dragging, onOpen, onDragStart, onDragEnd, roleName, onRun, runPending } = props
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
			const canRun = !blockedChip && laneRunnable && !activeExecution
			const draggable = !blockedChip && !activeExecution
			return h(
				'article',
				{
					className: classNames('kb-card', dragging === true && 'kb-card--dragging'),
					draggable,
					tabIndex: 0,
					role: 'button',
					'aria-label': t('card.open', { id: safeString(ticket.id) }),
					'data-ticket': safeString(ticket.id),
					title: blockedChip && ticket.blockReason ? t('card.blockedReason', { reason: ticket.blockReason }) : undefined,
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
			const { t, column, tickets, totalCount, wipLimit, paused, isOver, drag, onOpenTicket, onAddTicket, roleName, onRun, pending } = props
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
								})
							: null,
					),
				),
			)
		}

		function Board(props) {
			const { t, columnTickets, allCounts, wipLimits, paused, drag, over, roleName, filterActive, onRun, pending } = props
			const blockedTickets = safeArray(columnTickets.blocked)
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
						onOpenTicket: props.onOpenTicket,
						onAddTicket: props.onAddTicket,
						onDragStart: props.onDragStart,
						onDragEnd: props.onDragEnd,
						onDragOver: props.onDragOver,
						onDragLeave: props.onDragLeave,
						onDrop: props.onDrop,
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
							onOpenTicket: props.onOpenTicket,
							onRun,
							pending,
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
			const { t, member, pending, roleName } = props
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
					h('span', { className: 'kb-teamStatus', title: statusLabel(status, t) }, h(StatusDot, { status }), statusLabel(status, t)),
					sinceText ? h('span', { className: 'kb-rosterMetaText', title: sinceText }, sinceText) : null,
				),
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
				team,
				roster,
				drafts,
				board,
				tickets,
				roles,
				pending,
				roleName,
				onOpenTicket,
				onToggleAgent,
				onSetRole,
				onToggleBoard,
				onClose,
				pauseBusy,
			} = props
			const members = safeArray(roster).filter((member) => member && typeof member.id === 'string' && member.id)
			const draftRows = safeArray(drafts).filter((draft) => draft && typeof draft.id === 'string' && draft.id)
			const agents = safeArray(team).filter((agent) => agent && typeof agent.sessionId === 'string')
			const linkedSessions = {}
			members.forEach((member) => {
				if (typeof member.sessionId === 'string' && member.sessionId) linkedSessions[member.sessionId] = true
			})
			// Roster-linked sessions also appear in the legacy team list; only the
			// unlinked ones belong to the "Other agents" section.
			const otherAgents = agents.filter((agent) => linkedSessions[agent.sessionId] !== true)
			const working = members.filter((member) => member.status === 'working').length
			const running = members.filter((member) => member.status === 'running').length + otherAgents.filter((agent) => agent.status === 'running').length
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
			const agentRow = (agent) => {
				const agentStatus = agent.paused === true ? 'paused' : safeString(agent.status) || 'idle'
				const rolePending = (pending['role:' + agent.sessionId] || 0) > 0
				const agentPending = (pending['agent:' + agent.sessionId] || 0) > 0
				const name = safeString(agent.name) || agent.sessionId
				const roleOption = roleOptions.find((role) => role && role.id === agent.role)
				const agentRoleLabel = (roleOption && safeString(roleOption.name)) || safeString(agent.role)
				const ticketTitle = safeString(agent.ticketTitle)
				const ticketText = agent.ticketId ? safeString(agent.ticketId) + (ticketTitle ? ' · ' + ticketTitle : '') : ''
				return h(
					'div',
					{ key: agent.sessionId, className: 'kb-teamRow' },
					h(
						'div',
						{ className: 'kb-teamTop' },
						h(Avatar, { name, lead: agent.isLead === true }),
						h('span', { className: 'kb-teamName', title: name }, name),
						agent.isLead === true ? h('span', { className: 'kb-tag' }, t('team.lead')) : null,
						h('span', { className: 'kb-teamStatus', title: statusLabel(agentStatus, t) }, h(StatusDot, { status: agentStatus }), statusLabel(agentStatus, t)),
						h(
							'button',
							{
								type: 'button',
								className: 'kb-btn kb-btn--ghost kb-btn--icon kb-btn--sm',
								disabled: agentPending || agentStatus === 'failed',
								title: (agent.paused === true ? t('actions.resumeAgent') : t('actions.pauseAgent')) + ' ' + name,
								'aria-label': (agent.paused === true ? t('actions.resumeAgent') : t('actions.pauseAgent')) + ' ' + name,
								onClick: () => onToggleAgent(agent),
							},
							agent.paused === true ? h(IconPlay, { size: 12 }) : h(IconPause, { size: 12 }),
						),
					),
					h(
						'div',
						{ className: 'kb-teamBottom' },
						h(
							'select',
							{
								className: 'kb-teamRole',
								value: safeString(agent.role),
								disabled: rolePending || roleOptions.length === 0,
								title: t('team.role') + ': ' + agentRoleLabel,
								'aria-label': t('team.role') + ' ' + name,
								onChange: (event) => onSetRole(agent, event.target.value),
							},
							roleOptions.map((role) => h('option', { key: role.id, value: role.id }, role.name)),
						),
						agent.ticketId
							? h(
									'button',
									{
										type: 'button',
										className: 'kb-teamTicket',
										title: (ticketTitle ? ticketTitle + ' · ' : '') + t('team.openTicket', { id: agent.ticketId }),
										'aria-label': t('team.openTicket', { id: agent.ticketId }) + ' ' + ticketTitle,
										onClick: () => onOpenTicket(agent.ticketId),
									},
									h(IconTicket, { size: 11 }),
									h('span', { className: 'kb-teamTicketText' }, ticketText),
								)
							: h('span', { className: 'kb-teamNoTicket' }, t('team.noTicket')),
					),
				)
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
							h('span', { className: 'kb-chip' }, t('team.working', { n: working })),
							h('span', { className: 'kb-chip' }, t('team.running', { n: running })),
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
						h(SectionHead, { title: t('team.otherAgents'), count: otherAgents.length }),
						otherAgents.length === 0
							? h('div', { className: 'kb-emptyLine' }, t('team.otherAgentsEmpty'))
							: otherAgents.map((agent) => agentRow(agent)),
					),
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
					(ticket.block && ticket.block.reason) || ticket.blockReason
						? h('div', { className: 'kb-execHint' }, ticket.blockReason || ticket.block.reason)
						: null,
					questions.length > 0
						? questions.map((question, index) =>
								h(
									'label',
									{ key: question.id || index, className: 'kb-waitQ' },
									h('span', null, question.text),
									h('input', {
										className: 'kb-input',
										placeholder: t('execution.answerPlaceholder'),
										value: safeString(answers[index]),
										'aria-label': question.text,
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
									h('span', null, need.text),
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
					parts.push(execution.report ? h('div', { className: 'kb-execReport' }, execution.report) : h('span', { className: 'kb-execHint' }, t('execution.done')))
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
				execution && execution.report && status !== 'done' ? h('div', { className: 'kb-execReport' }, execution.report) : null,
			)
		}

		// ------------------------------------------------------------------
		// Ticket detail drawer
		// ------------------------------------------------------------------

		function TicketDrawer(props) {
			const { t, ticket, team, paused, pending, act, notify, roleName, openSession, onClose, onRun, onCancelExecution, onAnswerExecution } = props
			const closeRef = useRef(null)
			const [draftTitle, setDraftTitle] = useState(safeString(ticket.title))
			const [draftDescription, setDraftDescription] = useState(safeString(ticket.description))
			const [draftLabels, setDraftLabels] = useState(safeArray(ticket.labels).join(', '))
			const [draftBlockReason, setDraftBlockReason] = useState(safeString(ticket.blockReason))
			const [checklistDraft, setChecklistDraft] = useState('')
			const [commentDraft, setCommentDraft] = useState('')
			const [deleteArmed, setDeleteArmed] = useState(false)
			const [savedTick, setSavedTick] = useState(0)

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
			const canMove = !isPaused && ticket.blocked !== true
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
						h(
							'div',
							{ className: 'kb-section' },
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
							h('textarea', {
								className: 'kb-description',
								value: draftDescription,
								disabled: isPaused,
								placeholder: t('detail.descriptionPlaceholder'),
								'aria-label': t('detail.description'),
								rows: 3,
								onChange: (event) => setDraftDescription(event.target.value),
								onBlur: commitDescription,
							}),
						),
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
								{ className: classNames('kb-hint', ticket.blocked === true && 'kb-hint--error') },
								t('detail.moveHint'),
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
											h('div', { className: 'kb-commentText' }, comment.text),
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
									{ className: 'kb-select', value: type, onChange: (event) => setType(event.target.value) },
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
									{ className: 'kb-select', value: column, onChange: (event) => setColumn(event.target.value) },
									COLUMNS.map((item) => h('option', { key: item, value: item }, t('columns.' + item))),
								),
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
			const vision = data ? safeString(data.vision) : ''

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
														h('div', { className: 'kb-vision' }, vision),
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
																		h('span', { className: 'kb-candidateTitle' }, safeString(candidate.title)),
																		safeString(candidate.description)
																			? h('span', { className: 'kb-candidateDesc' }, candidate.description)
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

			const toggleAgent = useCallback(
				(agent) => {
					if (!agent || typeof agent.sessionId !== 'string') return
					const resuming = agent.paused === true
					void act(resuming ? 'resumeAgent' : 'pauseAgent', { sessionId: agent.sessionId }, {
						key: 'agent:' + agent.sessionId,
						toastText: t(resuming ? 'toast.agentResumed' : 'toast.agentPaused', {
							name: safeString(agent.name) || agent.sessionId,
						}),
					})
				},
				[act, t],
			)

			const setAgentRole = useCallback(
				(agent, role) => {
					if (!agent || typeof agent.sessionId !== 'string' || !role) return
					void act('setAgentRole', { sessionId: agent.sessionId, role }, { key: 'role:' + agent.sessionId })
				},
				[act],
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
					if (paused || ticket.blocked === true) {
						event.preventDefault()
						notify('warn', paused ? t('toast.boardPausedMove') : t('toast.blockedMove'))
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
						onOpenTicket: openTicket,
						onAddTicket: addTicketTo,
						onDragStart,
						onDragEnd,
						onDragOver,
						onDragLeave,
						onDrop,
						onRun: runTicketAction,
						pending,
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
									variant: 'primary',
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
									team,
									roster,
									drafts,
									board,
									tickets,
									roles,
									pending,
									pauseBusy: isBusy('boardPause'),
									roleName,
									onOpenTicket: openTicket,
									onToggleAgent: toggleAgent,
									onSetRole: setAgentRole,
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

			ctx.slots.inject('main', () =>
				ctx.slots.register(
					{
						name: 'main',
						key: 'kanban',
						locale: NS,
						inject: () => ({ openSession, readSessionCwd }),
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

		return { inject, apply }

	},
})
