/**
 * KB-3 verification probe — EPIC data model and parent linking (UI half).
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) and
 * asserts the KB-3 UI contract end to end:
 *   - board schema v3 live in the snapshot (version 3, no new top-level key)
 *   - New-ticket dialog: `epic` is a type, the column is forced to Backlog, the
 *     EPIC hint is shown, and the created ticket lands in Backlog
 *   - card: EPIC badge / lock chip / child count, no run button, not draggable
 *   - child card: parent chip opens the parent drawer by click AND keyboard
 *   - EPIC drawer: "EPIC PRD" description area, children list (id, title,
 *     column, status, count) that opens the child drawer, empty state
 *   - EPIC drawer: move controls disabled with the Backlog-only reason, no
 *     agent execution panel
 *   - drag attempt does not move the EPIC
 *   - 1024px and 640px widths, English and Chinese copy
 *
 * Writes docs/screenshots/kb3/final-verification.json plus PNG evidence.
 *
 * Usage (Chrome 157+ on macOS: local-network checks must be disabled, otherwise
 * headless navigation to the local GUI never commits and CDP appears to hang):
 *   mkdir -p .cdp-profile .chrome-home .chrome-tmp
 *   HOME="$PWD/.chrome-home" TMPDIR="$PWD/.chrome-tmp" \
 *     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless=new --remote-debugging-port=9333 --user-data-dir="$PWD/.cdp-profile" \
 *     --no-first-run --no-default-browser-check --no-sandbox --disable-gpu \
 *     --disable-dev-shm-usage --window-size=1440,900 \
 *     --disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks about:blank &
 *   DSH_WEB_URL=http://127.0.0.1:<gui-port> node tools/kb3-probe.js
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { attach, mintCookie, APP_URL } from './cdp.mjs'

const OUT_URL = new URL('../docs/screenshots/kb3/', import.meta.url)
const OUT = OUT_URL.pathname
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = {
	meta: {},
	checks: [],
	measurements: {},
	screenshots: [],
	console: [],
	created: [],
	notes: [],
}
let failures = 0

function record(id, name, pass, detail) {
	results.checks.push({ id, name, pass: pass === true, detail: detail === undefined ? null : detail })
	if (pass !== true) failures += 1
	console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

await mkdir(OUT, { recursive: true })

/**
 * Drop stray page targets before attaching: an aborted run can leave a chrome://
 * page or an old about:blank first, and `attach()` picks the first page target.
 * Keeping a single app page makes the probe deterministic and rerunnable.
 */
async function closeStrayTargets() {
	try {
		const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
		const pages = list.filter((target) => target.type === 'page')
		const appPages = pages.filter((target) => target.url.startsWith(APP_URL))
		const keep = appPages[0] || pages.find((target) => target.url === 'about:blank') || null
		for (const page of pages) {
			if (page === keep) continue
			await fetch(`http://127.0.0.1:9333/json/close/${page.id}`).catch(() => {})
		}
	} catch {
		// CDP endpoint unavailable: bootApp still navigates from whatever is there.
	}
}

await closeStrayTargets()
const app = await attach()
results.meta.startedAt = new Date().toISOString()

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function setViewport(width, height = 900) {
	await app.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
	await sleep(700)
}

async function setTheme(theme) {
	await app.cdp.send('Emulation.setEmulatedMedia', {
		features: [{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'dark' : 'light' }],
	})
	await sleep(400)
}

const hasPanel = () => app.evaluate(`!!document.querySelector('.kb-root')`)

/** Dismiss first-run preview/notice modals that would cover the panel. */
async function dismissNotices() {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const clicked = await app.evaluate(
			`(() => {
				const btn = [...document.querySelectorAll('button')].find((b) => /^(Continue|Got it|Dismiss)$/i.test((b.textContent || '').trim()));
				if (!btn || btn.getBoundingClientRect().width === 0) return false;
				btn.click();
				return true;
			})()`,
			{ userGesture: true },
		)
		if (!clicked) return
		await sleep(400)
	}
}

/** Chrome-level chrome (Preview Notice, Get started) can cover the panel. */
async function dismissAppModals() {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const clicked = await app.evaluate(
			`(() => {
				const outside = [...document.querySelectorAll('button')].filter((b) => !b.closest('.kb-root') && b.getBoundingClientRect().width > 0 && !b.disabled);
				const close = outside.find((b) => {
					const label = (b.getAttribute('aria-label') || '').trim();
					const text = (b.textContent || '').trim();
					return /^(close|dismiss|got it|continue)$/i.test(label) || /^(continue|close|dismiss|got it)$/i.test(text);
				});
				if (!close) return false;
				close.click();
				return true;
			})()`,
			{ userGesture: true },
		)
		if (!clicked) return
		await sleep(300)
	}
}

async function openPanel() {
	for (let attempt = 0; attempt < 8; attempt += 1) {
		if (await hasPanel()) return true
		await dismissAppModals()
		const clicked = await app.evaluate(
			`(() => {
				const row = [...document.querySelectorAll('button')].find((b) => {
					if (b.getBoundingClientRect().width === 0) return false;
					const label = (b.getAttribute('aria-label') || '').trim();
					const text = (b.textContent || '').trim();
					return /^(kanban|看板)$/i.test(label) || /^(kanban|看板)$/i.test(text);
				});
				if (!row) return false;
				row.click();
				return true;
			})()`,
			{ userGesture: true },
		)
		await sleep(1200)
		if (!clicked && !(await hasPanel())) continue
	}
	throw new Error('could not open the Kanban panel')
}

async function shot(name) {
	await dismissAppModals()
	const path = `${OUT}${name}.png`
	await app.screenshot(path)
	results.screenshots.push(name + '.png')
	console.log('SHOT ' + name)
	return path
}

async function pageState() {
	return app.evaluate(`(async () => {
		const response = await fetch('/kanban/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		const payload = await response.json();
		return payload.ok ? payload.value : { error: payload.error, status: response.status };
	})()`)
}

let workspaceId = ''
async function pageAction(action, payload = {}) {
	return app.evaluate(`(async () => {
		const response = await fetch('/kanban/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId)}, action: ${JSON.stringify(action)}, payload: ${JSON.stringify(payload)} }),
		});
		const payload = await response.json();
		return { status: response.status, body: payload };
	})()`)
}

async function waitFor(expression, label, timeoutMs = 12000) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		try {
			if (await app.evaluate(`(() => { try { return !!(${expression}); } catch (error) { return false; } })()`)) return true
		} catch {
			// page may be re-rendering; retry
		}
		await sleep(250)
	}
	return false
}

const waitTicketRendered = (id) => waitFor(`document.querySelector('.kb-card[data-ticket="${id}"]')`, `card ${id}`)

async function openTicket(id) {
	const clicked = await app.evaluate(
		`(() => {
			const card = document.querySelector('.kb-card[data-ticket="${id}"]');
			if (!card) return false;
			card.click();
			return true;
		})()`,
		{ userGesture: true },
	)
	if (!clicked) return false
	return waitFor(`document.querySelector('.kb-drawer[aria-label*="${id}"]')`, `drawer ${id}`)
}

async function closeDrawer() {
	await app.key('Escape')
	return waitFor(`!document.querySelector('.kb-drawer')`, 'drawer closed', 5000)
}

/** Real keyboard activation: Chrome needs `text` on keyDown for Enter to click. */
async function pressEnter() {
	await app.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key: 'Enter',
		code: 'Enter',
		windowsVirtualKeyCode: 13,
		nativeVirtualKeyCode: 13,
		text: '\r',
		unmodifiedText: '\r',
	})
	await app.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyUp',
		key: 'Enter',
		code: 'Enter',
		windowsVirtualKeyCode: 13,
		nativeVirtualKeyCode: 13,
	})
}

const languageButtonVisible = () =>
	app.evaluate(
		`[...document.querySelectorAll('button')].some((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`,
	)

/**
 * True while the settings overlay is open. The nav labels localize, so this
 * checks the language control and the General tab in both locales; a plain
 * Escape is harmless when nothing is open.
 */
const settingsOverlayOpen = () =>
	app.evaluate(
		`[...document.querySelectorAll('button,[role="tab"]')].some((x) => {
			const text = (x.textContent || '').trim();
			return text === 'General' || text === '通用设置' || text === 'English' || text === '中文' || text === 'Language' || text === '语言';
		})`,
	)

/** Close the settings overlay: Escape works in both locales (the X label localizes). */
async function closeSettings() {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		if (!(await settingsOverlayOpen())) return true
		await app.key('Escape')
		await sleep(500)
	}
	return !(await settingsOverlayOpen())
}

/** Open Settings with the app shortcut (⌥⌘,) — reliable for a focused page. */
async function pressSettingsShortcut() {
	for (const type of ['keyDown', 'keyUp']) {
		await app.cdp.send('Input.dispatchKeyEvent', {
			type,
			key: ',',
			code: 'Comma',
			windowsVirtualKeyCode: 188,
			nativeVirtualKeyCode: 188,
			modifiers: 5,
			...(type === 'keyDown' ? { text: ',' } : {}),
		})
	}
}

/**
 * Open Settings → General with the shortcut first and the account menu as a
 * fallback; returns whether the language control is visible. Selectors accept
 * both locales because restoring English happens from an already-Chinese shell.
 */
async function openSettings() {
	const generalTabVisible = () =>
		app.evaluate(
			`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`,
		)
	const clickGeneral = () =>
		app.evaluate(
			`(() => { const el = [...document.querySelectorAll('button,[role="tab"]')].find((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
			{ userGesture: true },
		)
	if (await languageButtonVisible()) return true
	// Primary: the app's Settings shortcut (⌥⌘,).
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (!(await settingsOverlayOpen())) {
			await pressSettingsShortcut()
			await waitFor(
				`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()))`,
				'settings panel',
				6000,
			)
		}
		if (await generalTabVisible()) await clickGeneral()
		await waitFor(
			`[...document.querySelectorAll('button')].some((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`,
			'language control',
			6000,
		)
		if (await languageButtonVisible()) return true
		await app.key('Escape')
		await sleep(500)
	}
	// Fallback: the account menu (localized labels).
	const clickAccountMenu = () =>
		app.evaluate(
			`(() => {
				const el = [...document.querySelectorAll('button')].find((x) => {
					if (x.getBoundingClientRect().width === 0) return false;
					const label = x.getAttribute('aria-label') || '';
					const text = (x.textContent || '').trim();
					return /account menu/i.test(label) || /账户|账号|已登录/i.test(label) || /signed in|已登录/i.test(text);
				});
				if (!el) return false;
				el.click();
				return true;
			})()`,
			{ userGesture: true },
		)
	const clickSettings = () =>
		app.evaluate(
			`(() => {
				const el = [...document.querySelectorAll('button,[role="menuitem"],a')].find((x) => {
					if (x.getBoundingClientRect().width === 0) return false;
					const text = (x.textContent || '').trim().replace(/^[^\w\u4e00-\u9fff]+/, '');
					return /^(settings|设置|偏好设置)/i.test(text);
				});
				if (!el) return false;
				el.click();
				return true;
			})()`,
			{ userGesture: true },
		)
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await dismissAppModals()
		await sleep(300)
		if (!(await settingsOverlayOpen())) {
			await clickAccountMenu()
			await sleep(1000)
			await clickSettings()
			await waitFor(
				`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()))`,
				'settings panel',
				6000,
			)
		}
		if (await generalTabVisible()) await clickGeneral()
		await waitFor(
			`[...document.querySelectorAll('button')].some((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`,
			'language control',
			6000,
		)
		if (await languageButtonVisible()) return true
		await app.key('Escape')
		await sleep(500)
	}
	return false
}

async function setLanguage(target) {
	const steps = {}
	// The settings overlay is only reliable on a freshly loaded shell; reloading
	// first also proves the persisted locale round-trips through the app.
	await reloadApp()
	await dismissNotices()
	await dismissAppModals()
	await openPanel()
	await sleep(800)
	steps.opened = await openSettings()
	if (!steps.opened) {
		results.notes.push({ language: target, steps })
		return false
	}
	steps.openPicker = await app.evaluate(
		`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true })()`,
		{ userGesture: true },
	)
	await sleep(700)
	steps.pick = await app.evaluate(
		`(() => { const el = [...document.querySelectorAll('button,[role="option"],[role="menuitem"],li')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(target)} && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
		{ userGesture: true },
	)
	await sleep(1400)
	await closeSettings()
	await dismissAppModals()
	await sleep(400)
	const expectedTitle = target === '中文' ? '看板' : 'Kanban'
	const changed = await waitFor(`(() => { const el = document.querySelector('.kb-root .kb-title'); return el && (el.textContent || '').trim() === ${JSON.stringify(expectedTitle)} })()`, `language ${target}`, 6000)
	results.notes.push({ language: target, steps, changed })
	return steps.pick === true && changed
}

const panelTitle = () => app.evaluate(`(() => { const el = document.querySelector('.kb-root .kb-title'); return el ? (el.textContent || '').trim() : null })()`)

async function scrollCardIntoView(id) {
	return app.evaluate(
		`(() => { const card = document.querySelector('.kb-card[data-ticket="${id}"]'); if (!card) return false; card.scrollIntoView({ block: 'center', inline: 'center' }); return true })()`,
	)
}

const drawerInfo = () =>
	app.evaluate(`(() => {
		const drawer = document.querySelector('.kb-drawer');
		if (!drawer) return null;
		const textarea = drawer.querySelector('textarea');
		const childrenSection = drawer.querySelector('[data-epic-children]');
		const rows = childrenSection ? [...childrenSection.querySelectorAll('.kb-childRow')] : [];
		const colButtons = [...drawer.querySelectorAll('.kb-colBtn')];
		return {
			label: drawer.getAttribute('aria-label'),
			descriptionLabel: textarea ? textarea.getAttribute('aria-label') : null,
			hasExecutionPanel: !!drawer.querySelector('.kb-execPanel'),
			moveAllDisabled: colButtons.length > 0 && colButtons.every((b) => b.disabled === true),
			moveHint: (() => { const hints = [...drawer.querySelectorAll('.kb-hint')].map((el) => (el.textContent || '').trim()); return hints.find((text) => /backlog|Backlog/i.test(text)) || '' })(),
			children: childrenSection
				? {
						header: (childrenSection.innerText || '').split('\\n').slice(0, 2).join(' | '),
						count: rows.length,
						rows: rows.map((row) => ({
							id: row.getAttribute('data-child-id'),
							column: row.getAttribute('data-column'),
							status: row.getAttribute('data-status'),
							text: (row.textContent || '').replace(/\\s+/g, ' ').trim(),
						})),
					}
				: { header: null, count: 0, rows: [] },
			empty: (() => { const el = drawer.querySelector('.kb-childrenEmpty'); return el ? (el.textContent || '').replace(/\\s+/g, ' ').trim() : null })(),
		};
	})()`)

const cardInfo = (id) =>
	app.evaluate(`(() => {
		const card = document.querySelector('.kb-card[data-ticket="${id}"]');
		if (!card) return null;
		const typeChip = card.querySelector('.kb-chip--epic');
		const lockChip = card.querySelector('[data-epic-lock]');
		const parentChip = card.querySelector('.kb-chip--parent');
		const countChip = card.querySelector('[data-child-count]');
		return {
			className: card.className,
			epicFlag: card.getAttribute('data-epic'),
			draggable: card.draggable,
			ariaDisabled: card.getAttribute('aria-disabled'),
			typeChip: typeChip ? (typeChip.textContent || '').trim() : null,
			lockChip: lockChip ? { text: (lockChip.textContent || '').trim(), title: lockChip.getAttribute('title') } : null,
			parentChip: parentChip ? { text: (parentChip.textContent || '').trim(), target: parentChip.getAttribute('data-parent'), title: parentChip.getAttribute('title') } : null,
			childCount: countChip ? { text: (countChip.textContent || '').trim(), count: countChip.getAttribute('data-child-count') } : null,
			hasRunButton: !!card.querySelector('.kb-cardRun'),
		};
	})()`)

const layoutMetrics = () =>
	app.evaluate(`(() => {
		const root = document.querySelector('.kb-root');
		const drawer = document.querySelector('.kb-drawer');
		const rect = (el) => (el ? { width: Math.round(el.getBoundingClientRect().width), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null);
		return {
			viewport: window.innerWidth,
			panel: rect(root),
			drawer: rect(drawer),
			drawerInsideViewport: drawer ? drawer.getBoundingClientRect().right <= window.innerWidth + 1 && drawer.getBoundingClientRect().left >= -1 : null,
			rootNoHorizontalOverflow: root ? root.scrollWidth <= root.clientWidth + 2 : null,
		};
	})()`)

// ---------------------------------------------------------------------------
// 0. Boot the real GUI
// ---------------------------------------------------------------------------

const SHELL_READY =
	`document.readyState === 'complete' && document.body && document.body.innerText.length > 50 && !document.body.innerText.includes('authentication required')`

function installErrorCollectors() {
	app.cdp.on('Runtime.consoleAPICalled', (params) => {
		if (params.type !== 'error' && params.type !== 'warning') return
		const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
		app.console.push({ type: params.type, text })
	})
	app.cdp.on('Runtime.exceptionThrown', (params) => {
		app.console.push({
			type: 'exception',
			text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception',
		})
	})
}

const APP_ORIGIN = APP_URL + '/'

/** Run JS in the page; returns true when the snippet did not throw. */
async function pageEval(expression) {
	try {
		return await app.evaluate(expression)
	} catch {
		return undefined
	}
}

// Chrome 157 can leave the Page.navigate/Page.reload CDP command unanswered even
// though the navigation commits, so the probe boots with in-page JS navigation
// (`location.href = ...` / `location.reload()`), which is reliable here, and
// awaits the shell through Runtime.evaluate.
async function bootApp() {
	await app.cdp.send('Runtime.enable')
	installErrorCollectors()
	const cookie = await mintCookie()
	const href = String((await pageEval('location.href')) || '')
	if (!href.startsWith(APP_URL)) {
		await pageEval(`(() => { location.href = ${JSON.stringify(APP_ORIGIN)}; return true })()`)
		if (
			!(await waitFor(
				`document.readyState === 'complete' && String(location.href).startsWith(${JSON.stringify(APP_URL)})`,
				'initial navigation',
				40000,
			))
		) {
			throw new Error('could not navigate to the app origin')
		}
	}
	const cookieSet = await pageEval(
		`(() => { try { document.cookie = ${JSON.stringify(cookie.name)} + '=' + ${JSON.stringify(cookie.value)} + '; path=/; SameSite=Strict'; return document.cookie.length > 0 } catch (error) { return false } })()`,
	)
	if (!cookieSet) throw new Error('could not set the browser session cookie')
	await pageEval('(() => { location.reload(); return true })()')
	if (!(await waitFor(SHELL_READY, 'app shell', 30000))) throw new Error('the app shell did not load')
	await app.evaluate(`(() => {
		if (window.__dshUiErrors) return true;
		window.__dshUiErrors = [];
		window.addEventListener('error', (e) => window.__dshUiErrors.push(String(e.message || e.error || 'error')));
		window.addEventListener('unhandledrejection', (e) => window.__dshUiErrors.push(String((e.reason && e.reason.message) || e.reason || 'rejection')));
		const original = console.error;
		console.error = (...args) => { window.__dshUiErrors.push(args.map(String).join(' ')); original.apply(console, args); };
		return true;
	})()`)
	await sleep(1200)
}

async function reloadApp() {
	await pageEval('(() => { location.reload(); return true })()')
	if (!(await waitFor(SHELL_READY, 'app shell after reload', 30000))) throw new Error('the app shell did not reload')
	await sleep(1200)
}

await bootApp()
results.meta.url = await app.evaluate('location.href')
await setViewport(1440, 900)
await setTheme('light')
await dismissNotices()
await dismissAppModals()
await openPanel()
await sleep(900)
await dismissNotices()
const bootTitle = await panelTitle()
if (bootTitle && bootTitle !== 'Kanban') {
	// A previous interrupted run can leave the app locale in Chinese; the checks
	// below assert English copy first, then switch to Chinese deliberately.
	const restored = await setLanguage('English')
	record(
		'boot/english',
		'the app language is reset to English before the checks',
		restored === true && (await panelTitle()) === 'Kanban',
		{ was: bootTitle, now: await panelTitle() },
	)
	await sleep(600)
}

let snap = await pageState()
workspaceId = typeof snap.workspaceId === 'string' ? snap.workspaceId : ''
results.meta.project = snap.project && snap.project.title
record('boot/snapshot', 'kanban panel loads a board snapshot', Boolean(snap && snap.board), snap && snap.error)

// ---------------------------------------------------------------------------
// 1. Board schema v3 (no new top-level snapshot key)
// ---------------------------------------------------------------------------

const EXPECTED_SNAPSHOT_KEYS = [
	'accessModes', 'board', 'drafts', 'execution', 'lastScan', 'now', 'project', 'projects',
	'roster', 'rules', 'sessions', 'team', 'thoughts', 'version', 'workspaceId',
]
const EXPECTED_BOARD_KEYS = [
	'activity', 'agents', 'createdAt', 'meta', 'nextNumber', 'paused', 'pausedAt', 'pausedBy',
	'projectPath', 'projectTitle', 'team', 'tickets', 'updatedAt', 'version', 'wip', 'workspaceId',
]
const sortedKeys = (value) => Object.keys(value || {}).sort()
const sameList = (left, right) => JSON.stringify(left) === JSON.stringify(right)
record('schema/snapshotV3', 'snapshot and board report version 3', snap.version === 3 && snap.board.version === 3, `${snap.version}/${snap.board.version}`)
record('schema/snapshotKeys', 'no new top-level snapshot key', sameList(sortedKeys(snap), EXPECTED_SNAPSHOT_KEYS), sortedKeys(snap))
record('schema/boardKeys', 'no new top-level board key', sameList(sortedKeys(snap.board), EXPECTED_BOARD_KEYS), sortedKeys(snap.board))
record('schema/ticketShape', 'existing ticket fields keep their shape', (snap.board.tickets || []).every((ticket) => typeof ticket.id === 'string' && typeof ticket.title === 'string' && typeof ticket.column === 'string' && typeof ticket.type === 'string'))
// Sweep leftovers from an interrupted earlier run so this probe is rerunnable.
const stale = (snap.board.tickets || []).filter((ticket) => /^EPIC: probe |^Child: (first|second) slice/.test(ticket.title || ''))
if (stale.length > 0) {
	for (const ticket of stale.filter((entry) => entry.parentId)) await pageAction('deleteTicket', { ticketId: ticket.id })
	for (const ticket of stale.filter((entry) => !entry.parentId)) await pageAction('deleteTicket', { ticketId: ticket.id })
	await sleep(800)
	snap = await pageState()
}
results.notes.push({ sweptStaleProbeTickets: stale.map((ticket) => ticket.id) })

// ---------------------------------------------------------------------------
// 2. New-ticket dialog creates an EPIC in Backlog
// ---------------------------------------------------------------------------

await setViewport(1024, 900)
const openedDialog = await app.evaluate(
	`(() => { const b = [...document.querySelectorAll('.kb-header button')].find((x) => (x.getAttribute('aria-label') || '') === 'New ticket'); if (!b) return false; b.click(); return true })()`,
	{ userGesture: true },
)
const dialogOpen = await waitFor(`document.querySelector('.kb-dialog')`, 'new ticket dialog')
record('new/dialogOpens', 'New-ticket dialog opens', openedDialog === true && dialogOpen === true)
const dialogTypes = await app.evaluate(
	`(() => {
		const dialog = document.querySelector('.kb-dialog');
		if (!dialog) return null;
		const selects = [...dialog.querySelectorAll('select')];
		const typeSelect = selects[0];
		return {
			options: typeSelect ? [...typeSelect.options].map((option) => ({ value: option.value, label: (option.textContent || '').trim() })) : [],
			selectCount: selects.length,
		};
	})()`,
)
record(
	'new/typeHasEpic',
	'the type select offers epic as "EPIC"',
	Boolean(dialogTypes && dialogTypes.options.some((option) => option.value === 'epic' && option.label === 'EPIC')),
	dialogTypes && dialogTypes.options,
)
// Title + type epic.
await app.type(`document.querySelector('.kb-dialog input.kb-input')`, 'EPIC: probe empty parent')
await app.evaluate(
	`(() => { const select = document.querySelector('.kb-dialog select'); if (!select) return false; select.value = 'epic'; select.dispatchEvent(new Event('change', { bubbles: true })); return true })()`,
	{ userGesture: true },
)
await sleep(500)
const epicDialogState = await app.evaluate(
	`(() => {
		const dialog = document.querySelector('.kb-dialog');
		if (!dialog) return null;
		const selects = [...dialog.querySelectorAll('select')];
		const columnSelect = selects[selects.length - 1];
		const hint = dialog.querySelector('.kb-hint--epic');
		return {
			columnValue: columnSelect ? columnSelect.value : null,
			columnDisabled: columnSelect ? columnSelect.disabled === true : null,
			hint: hint ? (hint.textContent || '').trim() : null,
		};
	})()`,
)
record(
	'new/epicForcesBacklog',
	'choosing EPIC forces the Column select to Backlog and disables it',
	epicDialogState && epicDialogState.columnValue === 'backlog' && epicDialogState.columnDisabled === true,
	epicDialogState,
)
record(
	'new/epicHint',
	'the dialog explains that EPICs are created in Backlog',
	epicDialogState && epicDialogState.hint === 'EPICs are created in Backlog and cannot be claimed by agents.',
	epicDialogState && epicDialogState.hint,
)
await shot('new-ticket-epic-1024')
const submitted = await app.evaluate(
	`(() => { const dialog = document.querySelector('.kb-dialog'); if (!dialog) return false; const b = [...dialog.querySelectorAll('button')].find((x) => /Create ticket/i.test((x.textContent || '').trim())); if (!b) return false; b.click(); return true })()`,
	{ userGesture: true },
)
await waitFor(`!document.querySelector('.kb-dialog')`, 'new ticket dialog closes', 8000)
await sleep(1200)
snap = await pageState()
const emptyEpic = (snap.board.tickets || []).find(
	(ticket) => ticket.title === 'EPIC: probe empty parent' && ticket.type === 'epic',
)
const emptyEpicId = emptyEpic ? emptyEpic.id : null
if (emptyEpicId) results.created.push(emptyEpicId)
record(
	'new/epicCreatedInBacklog',
	'UI-created EPIC lands in Backlog with type epic',
	Boolean(emptyEpic) && emptyEpic.column === 'backlog' && emptyEpic.type === 'epic',
	emptyEpic && { id: emptyEpic.id, type: emptyEpic.type, column: emptyEpic.column },
)
record('new/submitted', 'the dialog closes after a successful create', submitted === true)
await setViewport(1440, 900)

// ---------------------------------------------------------------------------
// 3. Seed an EPIC with two children (host action; validation covered by tests)
// ---------------------------------------------------------------------------

async function createTicket(payload) {
	const result = await pageAction('createTicket', payload)
	const ticket = result.body && result.body.ok && result.body.value ? result.body.value.ticket : null
	if (ticket && typeof ticket.id === 'string') results.created.push(ticket.id)
	return { status: result.status, ticket, error: result.body && result.body.error }
}

const epicCreate = await createTicket({ title: 'EPIC: durable onboarding', type: 'epic', priority: 'high' })
const epicId = epicCreate.ticket && epicCreate.ticket.id
const childA = await createTicket({ title: 'Child: first slice', type: 'story', priority: 'critical', parentId: epicId })
const childACreate = childA
const childB = await createTicket({ title: 'Child: second slice', type: 'task', priority: 'high', parentId: epicId })
record(
	'data/seed',
	'an EPIC with two children is created through the host action',
	Boolean(epicId) && childA.ticket?.parentId === epicId && childB.ticket?.parentId === epicId,
	{ epicId, childA: childA.ticket && childA.ticket.id, childB: childB.ticket && childB.ticket.id },
)
const childAId = childA.ticket && childA.ticket.id
const childBId = childB.ticket && childB.ticket.id
await waitTicketRendered(epicId)
await waitTicketRendered(childAId)
await waitTicketRendered(childBId)
if (emptyEpicId) await waitTicketRendered(emptyEpicId)

// ---------------------------------------------------------------------------
// 4. Card badge, lock chip, child count, no run button
// ---------------------------------------------------------------------------

let epicCard = await cardInfo(epicId)
record(
	'card/epicBadge',
	'the EPIC card carries the badge, the epic class and data-epic',
	epicCard && /kb-card--epic/.test(epicCard.className) && epicCard.epicFlag === 'true' && epicCard.typeChip === 'EPIC',
	epicCard && { className: epicCard.className, epicFlag: epicCard.epicFlag, typeChip: epicCard.typeChip },
)
record(
	'card/lockChip',
	'the EPIC card shows the Backlog-only lock reason',
	epicCard && epicCard.lockChip && epicCard.lockChip.text === 'Backlog only' && /cannot be dragged/i.test(epicCard.lockChip.title || ''),
	epicCard && epicCard.lockChip,
)
record(
	'card/childCount',
	'the EPIC card shows its child count',
	epicCard && epicCard.childCount && epicCard.childCount.count === '2' && /2 children/.test(epicCard.childCount.text),
	epicCard && epicCard.childCount,
)
record(
	'card/notDraggable',
	'the EPIC card is not draggable and advertises aria-disabled',
	epicCard && epicCard.draggable === false && epicCard.ariaDisabled === 'true',
	epicCard && { draggable: epicCard.draggable, ariaDisabled: epicCard.ariaDisabled },
)
record('card/noRunButton', 'the EPIC card has no Run-with-agent button', epicCard && epicCard.hasRunButton === false)

// ---------------------------------------------------------------------------
// 5. Drag attempt does not move the EPIC
// ---------------------------------------------------------------------------

await scrollCardIntoView(epicId)
const dragBefore = await pageState()
const epicRect = await app.rect(`document.querySelector('.kb-card[data-ticket="${epicId}"]')`)
const readyRect = await app.rect(`document.querySelector('.kb-col[data-column="ready"]')`)
let dragAttempt = false
if (epicRect && readyRect) {
	await app.drag({ x: epicRect.x, y: epicRect.y }, { x: readyRect.x, y: readyRect.y })
	dragAttempt = true
	await sleep(900)
}
const dragAfter = await pageState()
const epicAfterDrag = (dragAfter.board.tickets || []).find((ticket) => ticket.id === epicId)
record(
	'epic/dragBlocked',
	'dragging the EPIC card toward Ready leaves it in Backlog',
	dragAttempt && epicAfterDrag && epicAfterDrag.column === 'backlog',
	{ attempt: dragAttempt, column: epicAfterDrag && epicAfterDrag.column, before: (dragBefore.board.tickets || []).find((ticket) => ticket.id === epicId)?.column },
)

// ---------------------------------------------------------------------------
// 6. Parent chip on the child card (click + keyboard)
// ---------------------------------------------------------------------------

await setViewport(1024, 900)
await closeDrawer()
await scrollCardIntoView(childAId)
const childCard = await cardInfo(childAId)
record(
	'parent/chip',
	'the child card shows a parent chip pointing at the EPIC',
	childCard && childCard.parentChip && childCard.parentChip.target === epicId && childCard.parentChip.text === `Parent ${epicId}`,
	childCard && childCard.parentChip,
)
// Click the chip: opens the parent drawer, not the child drawer.
await app.evaluate(
	`(() => { const chip = document.querySelector('.kb-card[data-ticket="${childAId}"] .kb-chip--parent'); if (!chip) return false; chip.click(); return true })()`,
	{ userGesture: true },
)
const clickedOpen = await waitFor(`document.querySelector('.kb-drawer[aria-label*="${epicId}"]')`, 'parent drawer via chip')
record('parent/chipOpensDrawer', 'clicking the parent chip opens the parent EPIC drawer', clickedOpen === true)

// ---------------------------------------------------------------------------
// 7. EPIC drawer: PRD area, children list, disabled moves, no execution
// ---------------------------------------------------------------------------

// Let the drawer slide-in animation finish so evidence/screenshots are opaque.
await sleep(800)
const epicDrawer = await drawerInfo()
record(
	'drawer/epicPrd',
	'the EPIC drawer labels the description as "EPIC PRD"',
	epicDrawer && epicDrawer.descriptionLabel === 'EPIC PRD',
	epicDrawer && epicDrawer.descriptionLabel,
)
record(
	'drawer/childrenList',
	'the EPIC drawer lists both children with id, title, column and status',
	epicDrawer && epicDrawer.children.count === 2
		&& epicDrawer.children.rows.every((row) => row.id && row.column === 'backlog' && row.status && /Child: (first|second) slice/.test(row.text)),
	epicDrawer && epicDrawer.children,
)
record(
	'drawer/childrenCount',
	'the children section header shows the count',
	epicDrawer && /children/i.test(epicDrawer.children.header || '') && /\b2\b/.test(epicDrawer.children.header || ''),
	epicDrawer && epicDrawer.children.header,
)
record('drawer/noExecution', 'the EPIC drawer has no agent execution panel', epicDrawer && epicDrawer.hasExecutionPanel === false)
record(
	'drawer/moveDisabled',
	'every move control is disabled and the Backlog-only reason is shown',
	epicDrawer && epicDrawer.moveAllDisabled === true && /EPICs stay in Backlog/i.test(epicDrawer.moveHint || ''),
	epicDrawer && { moveAllDisabled: epicDrawer.moveAllDisabled, moveHint: epicDrawer.moveHint },
)
await shot('children-list-1024')
await setViewport(640, 900)
await sleep(500)
await shot('children-list-640')
const children640 = await app.evaluate(
	`(() => {
		const drawer = document.querySelector('.kb-drawer');
		return drawer ? { label: drawer.getAttribute('aria-label'), width: Math.round(drawer.getBoundingClientRect().width), viewport: window.innerWidth } : null;
	})()`,
)
results.measurements.drawer640 = children640
// A child row opens the child drawer.
await app.evaluate(
	`(() => { const row = document.querySelector('.kb-drawer [data-child-id]'); if (!row) return false; row.click(); return true })()`,
	{ userGesture: true },
)
const childDrawerOpen = await waitFor(`(() => { const d = document.querySelector('.kb-drawer'); return d && d.getAttribute('aria-label') !== null && /KB-/.test(d.getAttribute('aria-label')) && d.getAttribute('aria-label') !== ${JSON.stringify(`Ticket ${epicId}`)} })()`, 'child drawer')
record('children/rowOpensChild', 'clicking a child row opens the child drawer', childDrawerOpen === true)
await closeDrawer()
await setViewport(1024, 900)
// Keyboard: the parent chip is a native button, so focus + Enter opens the drawer.
await scrollCardIntoView(childAId)
const focusChip = await app.evaluate(
	`(() => { const chip = document.querySelector('.kb-card[data-ticket="${childAId}"] .kb-chip--parent'); if (!chip) return false; chip.focus(); return document.activeElement === chip })()`,
)
if (focusChip) await pressEnter()
const keyboardOpen = await waitFor(`document.querySelector('.kb-drawer[aria-label*="${epicId}"]')`, 'parent drawer via keyboard', 6000)
record('parent/chipKeyboard', 'the parent chip is keyboard-activatable (focus + Enter)', focusChip === true && keyboardOpen === true)
await closeDrawer()

// ---------------------------------------------------------------------------
// 8. Empty state on an EPIC without children
// ---------------------------------------------------------------------------

await openTicket(emptyEpicId)
await sleep(900)
const emptyDrawer = await drawerInfo()
record(
	'children/emptyState',
	'an EPIC without children shows the children empty state',
	emptyDrawer && emptyDrawer.empty && /No child tickets yet/i.test(emptyDrawer.empty),
	emptyDrawer && emptyDrawer.empty,
)
record(
	'children/emptyHint',
	'the empty state explains how to decompose the EPIC',
	emptyDrawer && /Create a ticket with this EPIC as its parent/i.test(emptyDrawer.empty || ''),
	emptyDrawer && emptyDrawer.empty,
)
record('children/emptyPrd', 'the empty EPIC drawer still shows the EPIC PRD area', emptyDrawer && emptyDrawer.descriptionLabel === 'EPIC PRD')
await shot('empty-state-1024')
await setViewport(640, 900)
await sleep(500)
await shot('empty-state-640')
await closeDrawer()
await setViewport(1024, 900)
await sleep(400)

// ---------------------------------------------------------------------------
// 9. Badge + parent chip at 1024 and 640
// ---------------------------------------------------------------------------

for (const width of [1024, 640]) {
	await setViewport(width, 900)
	await sleep(500)
	await scrollCardIntoView(epicId)
	await sleep(300)
	await shot(`epic-badge-${width}`)
	await scrollCardIntoView(childAId)
	await sleep(300)
	await shot(`parent-chip-${width}`)
}
await setViewport(1024, 900)
await sleep(400)
const metrics1024 = await layoutMetrics()
results.measurements.layout1024 = metrics1024
record(
	'layout/1024',
	'at 1024px the panel has no horizontal overflow',
	metrics1024.rootNoHorizontalOverflow === true,
	metrics1024,
)
await setViewport(640, 900)
await sleep(500)
const metrics640 = await layoutMetrics()
results.measurements.layout640 = metrics640
record(
	'layout/640',
	'at 640px the panel has no horizontal overflow',
	metrics640.rootNoHorizontalOverflow === true,
	metrics640,
)
await setViewport(1024, 900)

// ---------------------------------------------------------------------------
// 10. Chinese copy (en + zh)
// ---------------------------------------------------------------------------

// Reload before touching app-level settings: the long interaction flow above can
// leave shell popovers in a transient state; a fresh shell makes the language
// switch deterministic and proves the board survives a browser reload too.
await reloadApp()
await setViewport(1024, 900)
await dismissNotices()
await dismissAppModals()
await openPanel()
await sleep(900)
snap = await pageState()
record('reload/board', 'a browser reload keeps the v3 board and the probe data', snap.version === 3 && (snap.board.tickets || []).some((ticket) => ticket.id === epicId), `${snap.version} ${(snap.board.tickets || []).length}`)
await setLanguage('中文')
const zhTitle = await panelTitle()
record('i18n/title', 'switching the app language renders the Chinese kanban title', zhTitle === '看板', zhTitle)
await sleep(600)
await scrollCardIntoView(epicId)
const zhEpicCard = await cardInfo(epicId)
const zhChildCard = await cardInfo(childAId)
record('i18n/epicBadge', 'the EPIC badge reads 史诗 in Chinese', zhEpicCard && zhEpicCard.typeChip === '史诗', zhEpicCard && zhEpicCard.typeChip)
record('i18n/lockChip', 'the Backlog-only lock chip reads 仅 Backlog', zhEpicCard && zhEpicCard.lockChip && zhEpicCard.lockChip.text === '仅 Backlog', zhEpicCard && zhEpicCard.lockChip)
record('i18n/parentChip', 'the parent chip reads 父任务 {id} in Chinese', zhChildCard && zhChildCard.parentChip && zhChildCard.parentChip.text === `父任务 ${epicId}`, zhChildCard && zhChildCard.parentChip)
await scrollCardIntoView(epicId)
await sleep(300)
await shot('epic-zh-1024')
await openTicket(epicId)
await sleep(900)
const zhDrawer = await drawerInfo()
record('i18n/epicPrd', 'the EPIC drawer PRD label is localized', zhDrawer && zhDrawer.descriptionLabel === '史诗 PRD', zhDrawer && zhDrawer.descriptionLabel)
record('i18n/children', 'the children section is localized and still lists the children', zhDrawer && /子任务/.test(zhDrawer.children.header || '') && zhDrawer.children.count === 2, zhDrawer && zhDrawer.children.header)
await shot('children-zh-1024')
await closeDrawer()
await openTicket(emptyEpicId)
await sleep(900)
const zhEmptyDrawer = await drawerInfo()
record('i18n/childrenEmpty', 'the empty children copy is localized', zhEmptyDrawer && /暂无子任务/.test(zhEmptyDrawer.empty || ''), zhEmptyDrawer && zhEmptyDrawer.empty)
await closeDrawer()
await setLanguage('English')
const enTitle = await panelTitle()
record('i18n/backToEnglish', 'switching back restores the English panel title', enTitle === 'Kanban', enTitle)
await sleep(500)

// ---------------------------------------------------------------------------
// 11. Cleanup the probe tickets, final snapshot, console hygiene
// ---------------------------------------------------------------------------

await setViewport(1440, 900)
await closeDrawer()
const cleanup = []
for (const id of [childAId, childBId, epicId, emptyEpicId]) {
	const deleted = await pageAction('deleteTicket', { ticketId: id })
	cleanup.push({ id, status: deleted.status, code: deleted.body && deleted.body.error && deleted.body.error.code })
}
// Deleting the parent EPIC before its children must be rejected (409) — the
// probe deliberately deletes children first. Confirm the final board is clean.
const finalSnap = await pageState()
const remaining = (finalSnap.board.tickets || []).filter((ticket) => results.created.includes(ticket.id))
record('cleanup/deleted', 'the probe tickets are removed from the board', remaining.length === 0, { cleanup, remaining: remaining.map((ticket) => ticket.id) })
record('cleanup/boardV3', 'the live board is still schema v3 after the probe', finalSnap.version === 3 && finalSnap.board.version === 3, `${finalSnap.version}/${finalSnap.board.version}`)

const consoleErrors = (await app.errors()).filter(
	(entry) => entry.type === 'exception' || (/error/i.test(entry.type) && /kanban|kb-|epic/i.test(entry.text || '')),
)
results.console = (await app.errors()).slice(0, 50)
record('console/clean', 'no kanban/epic exception or error in the console', consoleErrors.length === 0, consoleErrors.slice(0, 3))

results.meta.finishedAt = new Date().toISOString()
results.meta.failures = failures
results.meta.createdTickets = results.created
await writeFile(new URL('../docs/screenshots/kb3/final-verification.json', import.meta.url), JSON.stringify(results, null, 1))
console.log(`\n${failures === 0 ? 'ALL KB-3 PROBE CHECKS PASSED' : `${failures} PROBE FAILURE(S)`} — ${results.checks.length} checks, ${results.screenshots.length} screenshots`)
process.exit(failures === 0 ? 0 : 1)
