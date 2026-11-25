/**
 * KB-58 verification probe — ticket drawer Markdown read view with Edit/Preview.
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) and
 * asserts the KB-58 acceptance contract end to end:
 *   AC1  read mode is the default and renders h3–h6 / ul>li / pre>code with no
 *        literal ## , leading "- " or fence markers left as text
 *   AC2  EPIC PRD keeps its label + hint, renders Markdown, the Children section
 *        is unchanged and a child row still opens the child drawer; no execution
 *        panel for the EPIC
 *   AC3  empty/whitespace description shows the localized empty hint + Edit and
 *        renders no bordered Markdown container
 *   AC4  Edit shows the existing .kb-description textarea pre-filled with the
 *        exact stored source; blur autosaves the exact typed text and flashes
 *        Saved
 *   AC5  Preview renders the unsaved draft; Edit returns the same draft; the
 *        persisted description ends up equal to the shown draft
 *   AC6  20,000-char PRD: .kb-drawerBody is the only scroller, .kb-drawerHead
 *        never moves, no horizontal page scrollbar at 1024x768 and 640x900
 *   AC7  paused board: banner visible, Edit disabled, read view renders and
 *        scrolls, no Saved flash, stored description unchanged
 *   AC8  Edit/Preview are real buttons with localized accessible names, in the
 *        Tab order, expose aria-pressed; Escape closes and focus returns to the
 *        originating card
 *   AC9  en + zh render the read view, empty hint, Edit and Preview; key parity
 *        is covered by tests/client.test.mjs (run separately)
 *   AC10 the other drawer sections are present and the console stays clean
 *
 * Board discipline: this probe runs on the `default-workspace` scratch board
 * (the kb5 convention) so the paused-board check can pause/resume a board that
 * has no running agent sessions — pausing the project board would cancel live
 * sessions. It creates temporary tickets through /kanban/action, deletes them in
 * cleanup, and asserts the board ticket count is restored. The project board is
 * never mutated and the previously selected workspace is restored at the end.
 *
 * Writes docs/screenshots/kb58/final-verification.json plus PNG evidence.
 *
 * Usage (Chrome on CDP port 9333, GUI URL in $DSH_WEB_URL):
 *   node tools/kb58-probe.js
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { attach } from './cdp.mjs'

const OUT_URL = new URL('../docs/screenshots/kb58/', import.meta.url)
const OUT = OUT_URL.pathname
const PROBE_PROJECT = 'default-workspace'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = {
	meta: {},
	checks: [],
	measurements: {},
	screenshots: [],
	console: [],
	created: [],
	notes: [],
	cleanup: [],
}
let failures = 0

function record(id, name, pass, detail) {
	results.checks.push({ id, name, pass: pass === true, detail: detail === undefined ? null : detail })
	if (pass !== true) failures += 1
	console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function note(text) {
	results.notes.push(text)
	console.log(`     ${text}`)
}

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

// AC1: the only "##", leading "- " and fence occurrences in this source are
// Markdown syntax, so any of them appearing as text proves the read view failed.
const MD_SOURCE = [
	'# Release checklist',
	'',
	'## Why this matters',
	'',
	'Readers must see the formatted tree, not raw syntax markers.',
	'',
	'### Acceptance focus',
	'',
	'- First bullet renders as a list item',
	'- Second bullet carries **strong** and `inline code`',
	'- Third bullet closes the list',
	'',
	'```js',
	"const ticket = 'KB-58'",
	'console.log(ticket)',
	'```',
	'',
	'## Done',
	'',
	'All sections render.',
].join('\n')

const EPIC_PRD = [
	'# Durable onboarding',
	'',
	'## Outcome',
	'',
	'Agents read this PRD as formatted Markdown.',
	'',
	'- Scope item one',
	'- Scope item two',
	'',
	'```text',
	'acceptance sample',
	'```',
	'',
	'## Plan',
	'',
	'Ship the read view first.',
].join('\n')

const DRAFT4 = '## Saved draft\n\n- alpha\n- beta\n\n```\nraw line kept\n```\n\n'
const DRAFT5 = '## Preview draft heading\n\n- draft bullet one\n- draft bullet two\n'
const COMMENT_TEXT = 'KB-58 probe comment: the comments list still renders.'

function buildPrd() {
	const parts = ['# 20k PRD fixture', '']
	let index = 0
	while (parts.join('\n').length < 20000) {
		index += 1
		parts.push(
			'## Section ' + index,
			'',
			'Paragraph ' + index + ': agents paste long PRDs here. ' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(5),
			'',
			'- item one of section ' + index,
			'- item two of section ' + index,
			'',
		)
		if (index === 3) parts.push('```text', 'fenced sample line', '```', '')
	}
	return parts.join('\n').slice(0, 20000)
}

const PRD_SOURCE = buildPrd()

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function closeStrayTargets() {
	try {
		const list = await (await fetch('http://127.0.0.1:9333/json/list')).json()
		const pages = list.filter((target) => target.type === 'page')
		const keep = pages.find((target) => target.url.startsWith('http://127.0.0.1')) || pages[0] || null
		for (const page of pages) {
			if (page === keep) continue
			await fetch(`http://127.0.0.1:9333/json/close/${page.id}`).catch(() => {})
		}
	} catch {
		// CDP endpoint unavailable: the probe still boots from whatever target exists.
	}
}

await mkdir(OUT, { recursive: true })
await closeStrayTargets()
const app = await attach()
results.meta.startedAt = new Date().toISOString()

async function setViewport(width, height = 768) {
	await app.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
	await sleep(700)
}

/**
 * Switch the app theme through its real control (Settings -> General ->
 * Appearance) instead of emulated media: the shell owns the theme and reports it
 * on <html data-ds-theme-source>, so the dark screenshot is a genuine dark build.
 */
async function setTheme(theme) {
	const target = theme === 'dark' ? 'dark' : 'light'
	const current = await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")')
	if (current === target) return true
	await openPanel()
	const opened = await openSettings()
	if (!opened) return false
	const clickGeneral = () =>
		app.evaluate(
			`(() => { const el = [...document.querySelectorAll('button,[role="tab"]')].find((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
			{ userGesture: true },
		)
	await clickGeneral()
	await sleep(700)
	const labels = target === 'dark' ? ['Dark', '深色', '暗色'] : ['Light', '浅色', '亮色']
	let clicked = false
	for (const candidate of labels) {
		clicked = await app.evaluate(
			`(() => { const el = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(candidate)} && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
			{ userGesture: true },
		)
		if (clicked) break
	}
	await sleep(1100)
	await closeSettings()
	await sleep(400)
	const applied = await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")')
	return clicked === true && applied === target
}

const hasPanel = () => app.evaluate('!!document.querySelector(".kb-root")')

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
		await sleep(350)
	}
}

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
	for (let attempt = 0; attempt < 10; attempt += 1) {
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

const SHELL_READY =
	'document.readyState === "complete" && document.body && document.body.innerText.length > 50 && !document.body.innerText.includes("authentication required")'

async function reloadShell() {
	await app.evaluate('(() => { location.reload(); return true })()').catch(() => {})
	for (let attempt = 0; attempt < 60; attempt += 1) {
		await sleep(400)
		const ready = await app.evaluate(`(() => { try { return ${SHELL_READY} } catch (error) { return false } })()`).catch(() => false)
		if (ready) break
	}
	await sleep(900)
}

async function shot(name) {
	await dismissAppModals()
	const path = `${OUT}${name}.png`
	await app.screenshot(path)
	results.screenshots.push(name + '.png')
	console.log('SHOT ' + name)
	return path
}

let workspaceId = ''
const pageState = () =>
	app.evaluate(`(async () => {
		const response = await fetch('/kanban/state', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId)} }),
		});
		const payload = await response.json();
		return payload.ok ? payload.value : { error: payload.error, status: response.status };
	})()`)

const pageAction = (action, payload = {}) =>
	app.evaluate(`(async () => {
		const response = await fetch('/kanban/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId)}, action: ${JSON.stringify(action)}, payload: ${JSON.stringify(payload)} }),
		});
		const body = await response.json();
		return { status: response.status, ok: body.ok === true, value: body.value, error: body.error };
	})()`)

async function waitFor(expression, label, timeoutMs = 12000) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		const value = await app.evaluate(`(() => { try { return !!(${expression}); } catch (error) { return false } })()`).catch(() => false)
		if (value) return true
		await sleep(200)
	}
	throw new Error('timeout waiting for ' + label)
}

const drawerOpen = () => app.evaluate('!!document.querySelector(".kb-drawer")')

async function closeDrawer() {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		if (!(await drawerOpen())) return true
		await app.key('Escape')
		await sleep(350)
	}
	return !(await drawerOpen())
}

/** Focus a card, then click it with real input events so the browser focuses it. */
async function openTicketByPointer(id) {
	const cardExpr = `document.querySelector('.kb-card[data-ticket="${id}"]')`
	await app.evaluate(`(() => { const c = ${cardExpr}; if (c) c.scrollIntoView({ block: 'center', inline: 'center' }); return true })()`)
	await sleep(400)
	await closeDrawer()
	await app.evaluate(`(() => { const c = ${cardExpr}; if (c) c.focus(); return true })()`)
	const rect = await app.rect(cardExpr)
	if (!rect) throw new Error('card ' + id + ' not found')
	await app.mouse('mousePressed', rect.x, rect.y)
	await app.mouse('mouseReleased', rect.x, rect.y)
	await waitFor(`document.querySelector('.kb-drawer[aria-label*="${id}"]')`, 'drawer ' + id)
	await sleep(400)
	return true
}

/** Plain DOM click (no focus semantics) — used when focus order is not under test. */
async function openTicket(id) {
	const expr = `document.querySelector('.kb-card[data-ticket="${id}"]')`
	await app.evaluate(`(() => { const c = ${expr}; if (c) c.scrollIntoView({ block: 'center', inline: 'center' }); return true })()`)
	await sleep(250)
	await closeDrawer()
	const clicked = await app.evaluate(`(() => { const c = ${expr}; if (!c) return false; c.click(); return true })()`)
	if (!clicked) throw new Error('card ' + id + ' not found')
	await waitFor(`document.querySelector('.kb-drawer[aria-label*="${id}"]')`, 'drawer ' + id)
	await sleep(400)
	return true
}

/** Real pointer click on an element found by a DOM expression (focus/blur faithful). */
async function pointerClick(expression) {
	const rect = await app.rect(expression)
	if (!rect) return false
	await app.mouse('mousePressed', rect.x, rect.y)
	await app.mouse('mouseReleased', rect.x, rect.y)
	await sleep(250)
	return true
}

const modeButtonExpr = (label) => `[...document.querySelectorAll('.kb-drawer .kb-descMode')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)})`

/**
 * Snapshot the description section: mode, textarea, buttons, rendered Markdown
 * nodes and the text that is actually visible (never the raw source).
 */
const descriptionState = () =>
	app.evaluate(`(() => {
		const drawer = document.querySelector('.kb-drawer');
		if (!drawer) return null;
		const section = drawer.querySelector('[data-description-section]');
		if (!section) return null;
		const read = section.querySelector('.kb-descRead');
		const md = section.querySelector('.kb-md');
		const textarea = section.querySelector('textarea.kb-description');
		const empty = section.querySelector('[data-description-empty]');
		const buttons = [...section.querySelectorAll('.kb-descMode')].map((b) => ({
			tag: b.tagName.toLowerCase(),
			type: b.getAttribute('type'),
			text: (b.textContent || '').trim(),
			ariaLabel: b.getAttribute('aria-label'),
			pressed: b.getAttribute('aria-pressed'),
			disabled: b.disabled === true,
			tabIndex: b.tabIndex,
		}));
		const group = section.querySelector('.kb-descModes');
		const tags = {};
		if (md) ['h1','h2','h3','h4','h5','h6','ul','ol','li','pre','code','p','strong','em','blockquote','table'].forEach((name) => {
			tags[name] = md.querySelectorAll(name).length;
		});
		return {
			readMode: read ? read.getAttribute('data-description-mode') : null,
			hasTextarea: Boolean(textarea),
			textareaValue: textarea ? String(textarea.value) : null,
			hasMarkdown: Boolean(md),
			emptyText: empty ? (empty.textContent || '').trim() : null,
			visibleText: md ? (md.innerText || '') : (empty ? (empty.textContent || '').trim() : ''),
			sectionText: (section.innerText || ''),
			tags,
			preCode: md ? md.querySelectorAll('pre > code').length : 0,
			buttons,
			buttonStyles: [...section.querySelectorAll('.kb-descMode')].map((b) => ({
				text: (b.textContent || '').trim(),
				pressed: b.getAttribute('aria-pressed'),
				color: getComputedStyle(b).color,
				borderColor: getComputedStyle(b).borderColor,
				background: getComputedStyle(b).backgroundColor,
			})),
			groupLabel: group ? group.getAttribute('aria-label') : null,
			readBorders: read ? (() => {
				const style = getComputedStyle(read);
				return { top: style.borderTopWidth, right: style.borderRightWidth, bottom: style.borderBottomWidth, left: style.borderLeftWidth, background: style.backgroundColor };
			})() : null,
		};
	})()`)

const ticketById = (snap, id) => (snap && snap.board && Array.isArray(snap.board.tickets) ? snap.board.tickets.find((ticket) => ticket.id === id) : null)

const panelTitle = () => app.evaluate('(() => { const el = document.querySelector(".kb-root .kb-title"); return el ? (el.textContent || "").trim() : null })()')
const clientProjectTitle = () =>
	app.evaluate('(() => { const el = document.querySelector(".kb-projectName"); return el ? (el.textContent || "").trim() : null })()')

async function selectProject(title) {
	const opened = await app.evaluate(
		`(() => { const btn = document.querySelector('.kb-projectBtn'); if (!btn) return false; btn.click(); return true })()`,
		{ userGesture: true },
	)
	await sleep(600)
	const picked = await app.evaluate(
		`(() => {
			const rows = [...document.querySelectorAll('.kb-menuRow')];
			const row = rows.find((el) => ((el.querySelector('.kb-menuTitle') || {}).textContent || '').trim() === ${JSON.stringify(title)});
			if (!row) return false;
			row.click();
			return true;
		})()`,
		{ userGesture: true },
	)
	await sleep(1400)
	return opened === true && picked === true
}

// --- language switching (copied from the kb3/kb5 probe convention) ----------

const languageButtonVisible = () =>
	app.evaluate('[...document.querySelectorAll("button")].some((x) => /^(English|中文)$/.test((x.textContent || "").trim()) && x.getBoundingClientRect().width > 0)')

const settingsOverlayOpen = () =>
	app.evaluate(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => {
		const text = (x.textContent || '').trim();
		return text === 'General' || text === '通用设置' || text === 'English' || text === '中文' || text === 'Language' || text === '语言';
	})`)

async function closeSettings() {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		if (!(await settingsOverlayOpen())) return true
		await app.key('Escape')
		await sleep(450)
	}
	return !(await settingsOverlayOpen())
}

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
	const waitSettings = async (label) => {
		try {
			await waitFor(
				`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()))`,
				label,
				6000,
			)
			return true
		} catch {
			return false
		}
	}
	if (await languageButtonVisible()) return true
	// Primary: the app's Settings shortcut (⌥⌘,).
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (!(await settingsOverlayOpen())) {
			await pressSettingsShortcut()
			await waitSettings('settings panel')
		}
		if (await generalTabVisible()) await clickGeneral()
		await sleep(700)
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
					const text = (x.textContent || '').trim().replace(/^[^\\w\\u4e00-\\u9fff]+/, '');
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
			await waitSettings('settings panel via account menu')
		}
		if (await generalTabVisible()) await clickGeneral()
		await sleep(700)
		if (await languageButtonVisible()) return true
		await app.key('Escape')
		await sleep(500)
	}
	return false
}

async function setLanguage(target) {
	const steps = {}
	await reloadShell()
	await dismissNotices()
	await dismissAppModals()
	await openPanel()
	await sleep(700)
	steps.opened = await openSettings()
	if (!steps.opened) {
		results.notes.push({ language: target, steps })
		return false
	}
	steps.openPicker = await app.evaluate(
		`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true })()`,
		{ userGesture: true },
	)
	await sleep(600)
	steps.pick = await app.evaluate(
		`(() => { const el = [...document.querySelectorAll('button,[role="option"],[role="menuitem"],li')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(target)} && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
		{ userGesture: true },
	)
	await sleep(1300)
	await closeSettings()
	await dismissAppModals()
	await sleep(400)
	const expectedTitle = target === '中文' ? '看板' : 'Kanban'
	let changed = false
	try {
		await waitFor(`(() => { const el = document.querySelector('.kb-root .kb-title'); return el && (el.textContent || '').trim() === ${JSON.stringify(expectedTitle)} })()`, 'language ' + target, 6000)
		changed = true
	} catch {
		changed = false
	}
	results.notes.push({ language: target, steps, changed })
	return steps.pick === true && changed
}

// ---------------------------------------------------------------------------
// 0. Boot, pick the scratch board, capture the pre-probe board count
// ---------------------------------------------------------------------------

await app.ensureApp({ reload: true })
await setViewport(1024, 768)
await setTheme('light')
await dismissNotices()
await dismissAppModals()
await openPanel()

const bootSnap = await app.evaluate(`(async () => {
	const response = await fetch('/kanban/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	const payload = await response.json();
	return payload.ok ? payload.value : { error: payload.error };
})()`)
results.meta.project = bootSnap.project && bootSnap.project.title
const originalWorkspaceId = bootSnap.workspaceId
const scratch = (bootSnap.projects || []).find((project) => project.title === PROBE_PROJECT)
if (!scratch) {
	record('setup/scratchProject', 'the ' + PROBE_PROJECT + ' scratch board is registered', false, 'missing')
	await writeFile(new URL('../docs/screenshots/kb58/final-verification.json', import.meta.url), JSON.stringify({ ...results, meta: { ...results.meta, failures: failures + 1 } }, null, 1))
	process.exit(1)
}
results.meta.probeProject = PROBE_PROJECT
results.meta.probeWorkspaceId = scratch.id
results.meta.originalWorkspaceId = originalWorkspaceId
workspaceId = scratch.id
await app.evaluate(`(() => { window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(scratch.id)}); return true })()`)
await reloadShell()
await openPanel()
await sleep(600)
let clientTitle = await clientProjectTitle()
if (clientTitle !== PROBE_PROJECT) {
	note('the client opened ' + String(clientTitle) + ' instead of ' + PROBE_PROJECT + '; selecting it explicitly')
	await selectProject(PROBE_PROJECT)
	clientTitle = await clientProjectTitle()
}
record('setup/clientSelected', 'the client panel renders the probe board', clientTitle === PROBE_PROJECT, clientTitle)
record('setup/panelTitle', 'the panel is in English for the base run', (await panelTitle()) === 'Kanban', await panelTitle())

let bootState = await pageState()
if (bootState.board && bootState.board.paused === true) {
	await pageAction('resumeBoard')
	await sleep(600)
	bootState = await pageState()
}
const preProbeCount = bootState.board && Array.isArray(bootState.board.tickets) ? bootState.board.tickets.length : -1
results.meta.preProbeTickets = preProbeCount
results.measurements.board = {
	paused: bootState.board && bootState.board.paused,
	ticketsAtStart: preProbeCount,
	scratchPath: scratch.path,
}
record('setup/unpaused', 'the probe board starts unpaused', bootState.board && bootState.board.paused === false, bootState.board && bootState.board.paused)

// Pausing this board must never cancel an unrelated live session.
const probeBoardSessions = (bootState.sessions || []).filter(
	(session) => session.running === true && typeof session.cwd === 'string' && session.cwd.startsWith(scratch.path),
)
results.measurements.pauseSafety = { runningSessions: probeBoardSessions.map((session) => session.sessionId) }
record('setup/pauseSafe', 'no running agent session lives inside the probe board', probeBoardSessions.length === 0, results.measurements.pauseSafe)

// ---------------------------------------------------------------------------
// 1. Fixtures (host actions; deleted + counted in cleanup)
// ---------------------------------------------------------------------------

async function createFixture(payload) {
	const result = await pageAction('createTicket', payload)
	const ticket = result.value && result.value.ticket ? result.value.ticket : null
	if (!ticket || typeof ticket.id !== 'string') throw new Error('createTicket failed: ' + JSON.stringify(result.error || result))
	results.created.push(ticket.id)
	return ticket
}

let mdId = null
let emptyId = null
let epicId = null
let childAId = null
let childBId = null
let prdId = null
let cleanupDone = false
let boardPausedByProbe = false

try {
	const mdTicket = await createFixture({ title: 'KB-58 fixture: formatted read view', type: 'story', priority: 'high', labels: ['probe'], description: MD_SOURCE })
	mdId = mdTicket.id
	await pageAction('comment', { ticketId: mdId, text: COMMENT_TEXT })

	const emptyTicket = await createFixture({ title: 'KB-58 fixture: empty description', type: 'task', priority: 'medium', description: '   \n\t  ' })
	emptyId = emptyTicket.id

	const epicTicket = await createFixture({ title: 'KB-58 fixture: EPIC PRD read view', type: 'epic', priority: 'high', description: EPIC_PRD })
	epicId = epicTicket.id
	const childA = await createFixture({ title: 'KB-58 fixture: child slice one', type: 'story', priority: 'critical', parentId: epicId })
	childAId = childA.id
	const childB = await createFixture({ title: 'KB-58 fixture: child slice two', type: 'task', priority: 'high', parentId: epicId })
	childBId = childB.id

	const prdTicket = await createFixture({ title: 'KB-58 fixture: 20k PRD', type: 'story', priority: 'low', description: PRD_SOURCE })
	prdId = prdTicket.id

	await waitFor(`document.querySelector('.kb-card[data-ticket="${mdId}"]')`, 'fixture card ' + mdId)
	await sleep(1200)
	let snap = await pageState()
	const storedMd = ticketById(snap, mdId)
	const storedEmpty = ticketById(snap, emptyId)
	const storedPrd = ticketById(snap, prdId)
	record(
		'data/seed',
		'the host stored the fixtures (exact Markdown source, whitespace, 20k clamp, EPIC children)',
		Boolean(storedMd && storedEmpty && storedPrd) &&
			storedMd.description === MD_SOURCE &&
			storedEmpty.description.trim() === '' &&
			storedPrd.description.length > 15000 &&
			storedPrd.description.length <= 20000 &&
			Boolean(ticketById(snap, childAId)) &&
			ticketById(snap, childAId).parentId === epicId,
		{
			mdLength: storedMd ? storedMd.description.length : null,
			emptyLength: storedEmpty ? storedEmpty.description.length : null,
			prdLength: storedPrd ? storedPrd.description.length : null,
			children: [childAId, childBId],
		},
	)
	results.measurements.fixtures = { mdId, emptyId, epicId, prdId, childAId, childBId }

	// -------------------------------------------------------------------
	// AC1 — read mode is the default and renders a formatted tree
	// -------------------------------------------------------------------

	await openTicket(mdId)
	const readState = await descriptionState()
	record(
		'AC1/defaultRead',
		'opening the drawer shows the read view with no click',
		Boolean(readState) && readState.readMode === 'read' && readState.hasMarkdown === true && readState.hasTextarea === false,
		readState && { readMode: readState.readMode, hasMarkdown: readState.hasMarkdown, hasTextarea: readState.hasTextarea },
	)
	record(
		'AC1/nodes',
		'the read view renders h3–h6, ul>li and pre>code',
		Boolean(readState) &&
			readState.tags.h3 >= 1 &&
			readState.tags.h4 >= 1 &&
			readState.tags.h5 >= 1 &&
			readState.tags.h6 === 0 &&
			readState.tags.h1 === 0 &&
			readState.tags.h2 === 0 &&
			readState.tags.ul >= 1 &&
			readState.tags.li >= 3 &&
			readState.tags.pre >= 1 &&
			readState.preCode >= 1,
		readState && readState.tags,
	)
	const markerFree =
		Boolean(readState) &&
		readState.visibleText.indexOf('##') === -1 &&
		readState.visibleText.indexOf('```') === -1 &&
		readState.visibleText.split('\n').every((line) => !/^\s*[-*]\s/.test(line)) &&
		!/(^|\n)#{1,6}\s/.test(readState.visibleText)
	record(
		'AC1/noLiteralMarkers',
		'no literal ##, leading "-" or fence marker is visible in the read view',
		markerFree,
		readState && { sample: readState.visibleText.slice(0, 160) },
	)
	record(
		'AC1/textContent',
		'the read view carries the rendered text content',
		Boolean(readState) &&
			readState.visibleText.indexOf('Release checklist') !== -1 &&
			readState.visibleText.indexOf('First bullet renders as a list item') !== -1 &&
			readState.visibleText.indexOf("const ticket = 'KB-58'") !== -1 &&
			readState.visibleText.indexOf('All sections render.') !== -1,
		null,
	)
	record(
		'AC1/inlineFormatting',
		'the read view renders strong and inline code',
		Boolean(readState) && readState.tags.strong >= 1 && readState.tags.code >= 2,
		readState && { strong: readState.tags.strong, code: readState.tags.code },
	)
	await shot('read-1024-light')

	// AC9 (light/dark half): the same read view in the dark theme.
	const darkApplied = await setTheme('dark')
	await sleep(500)
	if (!(await drawerOpen())) await openTicket(mdId)
	const darkState = await descriptionState()
	record(
		'AC9/darkTheme',
		'the read view renders in the real dark theme',
		darkApplied === true &&
			Boolean(darkState) &&
			darkState.hasMarkdown === true &&
			darkState.tags.h3 >= 1 &&
			darkState.tags.li >= 3 &&
			(await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")')) === 'dark',
		darkState && { h3: darkState.tags.h3, mode: darkState.readMode, source: await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")') },
	)
	await shot('read-1024-dark')
	await setTheme('light')
	await sleep(400)
	if (!(await drawerOpen())) await openTicket(mdId)

	// Width evidence on the same pristine source: full-width drawer at 640.
	await setViewport(640, 900)
	await sleep(500)
	await shot('read-640-light')
	await setViewport(1024, 768)
	await sleep(400)

	// -------------------------------------------------------------------
	// AC4 — Edit shows today's textarea, blur saves the exact typed text
	// -------------------------------------------------------------------

	const storedBeforeEdit = ticketById(await pageState(), mdId).description
	const clickedEdit = await pointerClick(modeButtonExpr('Edit'))
	await sleep(300)
	const editState = await descriptionState()
	record(
		'AC4/editOpens',
		'Edit reveals the existing .kb-description textarea',
		clickedEdit === true && Boolean(editState) && editState.hasTextarea === true && editState.hasMarkdown === false,
		editState && { hasTextarea: editState.hasTextarea, hasMarkdown: editState.hasMarkdown },
	)
	record(
		'AC4/prefilledExact',
		'the textarea is pre-filled with the exact stored source',
		Boolean(editState) && editState.textareaValue === storedBeforeEdit,
		editState && { storedLength: storedBeforeEdit.length, valueLength: editState.textareaValue === null ? null : editState.textareaValue.length },
	)
	record(
		'AC4/editPressed',
		'Edit exposes aria-pressed=true while editing (Preview=false)',
		Boolean(editState) && editState.buttons.some((b) => b.text === 'Edit' && b.pressed === 'true') && editState.buttons.some((b) => b.text === 'Preview' && b.pressed === 'false'),
		editState && editState.buttons.map((b) => ({ text: b.text, pressed: b.pressed })),
	)

	const typed4 = await app.type('document.querySelector(".kb-drawer .kb-description")', DRAFT4)
	record('AC4/typed', 'the probe typed a different draft into the textarea', typed4 === true && (await descriptionState()).textareaValue === DRAFT4, null)
	// Show the beginning of the draft in the fixed-height textarea before the shot.
	await app.evaluate('(() => { const el = document.querySelector(".kb-drawer .kb-description"); if (el) el.scrollTop = 0; return true })()')
	await sleep(200)
	await shot('edit-1024-light')

	// Blur to a different field: this is today's autosave trigger.
	await app.evaluate('(() => { const input = document.querySelector(".kb-drawer .kb-titleInput"); if (input) input.focus(); return true })()')
	let savedFlash = false
	try {
		await waitFor('document.querySelector(".kb-drawer .kb-savedHint")', 'Saved flash', 6000)
		savedFlash = true
	} catch {
		savedFlash = false
	}
	record('AC4/savedFlash', 'blurring flashes Saved', savedFlash, null)
	let savedDescription = null
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const ticket = ticketById(await pageState(), mdId)
		savedDescription = ticket ? ticket.description : null
		if (savedDescription === DRAFT4) break
		await sleep(200)
	}
	record(
		'AC4/persistedExact',
		'the persisted description equals the typed text exactly (no trimming or normalization)',
		savedDescription === DRAFT4,
		savedDescription === null ? null : { equal: savedDescription === DRAFT4, storedLength: savedDescription.length, typedLength: DRAFT4.length },
	)

	// -------------------------------------------------------------------
	// AC5 — Preview renders the unsaved draft and Edit returns it
	// -------------------------------------------------------------------

	const editStillOpen = await descriptionState()
	if (!editStillOpen || editStillOpen.hasTextarea !== true) {
		await pointerClick(modeButtonExpr('Edit'))
		await sleep(250)
	}
	const typed5 = await app.type('document.querySelector(".kb-drawer .kb-description")', DRAFT5)
	const afterType5 = await descriptionState()
	record(
		'AC5/typedDraft',
		'a draft that differs from the stored source is in the textarea',
		typed5 === true && Boolean(afterType5) && afterType5.textareaValue === DRAFT5,
		afterType5 && { valueLength: afterType5.textareaValue === null ? null : afterType5.textareaValue.length },
	)

	const clickedPreview = await pointerClick(modeButtonExpr('Preview'))
	await sleep(250)
	const previewState = await descriptionState()
	record(
		'AC5/previewRendersDraft',
		'Preview renders the typed draft immediately, before any click-back',
		clickedPreview === true &&
			Boolean(previewState) &&
			previewState.readMode === 'preview' &&
			previewState.hasTextarea === false &&
			previewState.visibleText.indexOf('Preview draft heading') !== -1 &&
			previewState.visibleText.indexOf('draft bullet one') !== -1 &&
			previewState.tags.h4 >= 1 &&
			previewState.tags.li >= 2,
		previewState && { mode: previewState.readMode, sample: previewState.visibleText.slice(0, 120), h4: previewState.tags.h4, li: previewState.tags.li },
	)
	record(
		'AC5/previewPressed',
		'Preview exposes aria-pressed=true (Edit=false)',
		Boolean(previewState) && previewState.buttons.some((b) => b.text === 'Preview' && b.pressed === 'true') && previewState.buttons.some((b) => b.text === 'Edit' && b.pressed === 'false'),
		previewState && previewState.buttons.map((b) => ({ text: b.text, pressed: b.pressed })),
	)
	await shot('preview-1024-light')

	const backToEdit = await pointerClick(modeButtonExpr('Edit'))
	await sleep(250)
	const backState = await descriptionState()
	record(
		'AC5/draftPreserved',
		'pressing Edit again returns the same draft text (nothing discarded)',
		backToEdit === true && Boolean(backState) && backState.hasTextarea === true && backState.textareaValue === DRAFT5,
		backState && { valueEqual: backState.textareaValue === DRAFT5 },
	)
	await app.evaluate('(() => { const input = document.querySelector(".kb-drawer .kb-titleInput"); if (input) input.focus(); return true })()')
	let persisted5 = null
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const ticket = ticketById(await pageState(), mdId)
		persisted5 = ticket ? ticket.description : null
		if (persisted5 === DRAFT5) break
		await sleep(200)
	}
	record(
		'AC5/persistedDraft',
		'after the blur save the persisted description equals the shown draft',
		persisted5 === DRAFT5,
		persisted5 === null ? null : { equal: persisted5 === DRAFT5, storedLength: persisted5.length, draftLength: DRAFT5.length },
	)
	await closeDrawer()

	// -------------------------------------------------------------------
	// AC3 — empty / whitespace-only description
	// -------------------------------------------------------------------

	await openTicket(emptyId)
	const emptyState = await descriptionState()
	record(
		'AC3/emptyHint',
		'the empty read view shows the localized hint and an Edit button',
		Boolean(emptyState) &&
			emptyState.emptyText !== null &&
			emptyState.emptyText.indexOf('No description yet') !== -1 &&
			emptyState.hasMarkdown === false &&
			emptyState.hasTextarea === false &&
			emptyState.buttons.some((b) => b.text === 'Edit' && b.disabled === false),
		emptyState && { emptyText: emptyState.emptyText, buttons: emptyState.buttons.map((b) => b.text) },
	)
	const emptyBorders = emptyState && emptyState.readBorders
	record(
		'AC3/noBorderedContainer',
		'no bordered Markdown container is rendered for an empty description',
		Boolean(emptyState) &&
			emptyState.hasMarkdown === false &&
			Boolean(emptyBorders) &&
			emptyBorders.top === '0px' &&
			emptyBorders.right === '0px' &&
			emptyBorders.bottom === '0px' &&
			emptyBorders.left === '0px',
		emptyState && { hasMarkdown: emptyState.hasMarkdown, readBorders: emptyBorders },
	)
	await shot('empty-read-1024-light')
	await closeDrawer()

	// -------------------------------------------------------------------
	// AC2 — EPIC PRD + unchanged Children section
	// -------------------------------------------------------------------

	await openTicket(epicId)
	const epicState = await descriptionState()
	const epicInfo = await app.evaluate(`(() => {
		const drawer = document.querySelector('.kb-drawer');
		const section = drawer ? drawer.querySelector('[data-description-section]') : null;
		const label = drawer ? drawer.querySelector('.kb-fieldLabel') : null;
		const hint = section ? section.querySelector('.kb-hint') : null;
		const childSection = drawer ? drawer.querySelector('[data-epic-children]') : null;
		const rows = childSection ? [...childSection.querySelectorAll('[data-child-id]')] : [];
		return {
			label: label ? (label.textContent || '').trim() : null,
			hint: hint ? (hint.textContent || '').trim() : null,
			hasChildSection: Boolean(childSection),
			children: rows.map((row) => ({ id: row.getAttribute('data-child-id'), column: row.getAttribute('data-column'), text: (row.innerText || '').trim() })),
			hasExecPanel: Boolean(drawer && drawer.querySelector('.kb-execPanel')),
			drawerText: drawer ? drawer.innerText : '',
		};
	})()`)
	record(
		'AC2/labelAndHint',
		'the localized EPIC PRD label and hint stay above the read view',
		Boolean(epicInfo) && epicInfo.label === 'EPIC PRD' && typeof epicInfo.hint === 'string' && epicInfo.hint.indexOf('Outcome, scope, acceptance criteria') !== -1,
		epicInfo && { label: epicInfo.label, hint: epicInfo.hint },
	)
	record(
		'AC2/prdMarkdown',
		'the EPIC PRD renders as Markdown in read mode',
		Boolean(epicState) && epicState.hasMarkdown === true && epicState.hasTextarea === false && epicState.tags.h3 >= 1 && epicState.tags.h4 >= 1 && epicState.tags.li >= 2 && epicState.visibleText.indexOf('Durable onboarding') !== -1,
		epicState && { mode: epicState.readMode, tags: epicState.tags, sample: epicState.visibleText.slice(0, 120) },
	)
	record(
		'AC2/childrenUnchanged',
		'the Children section keeps its rows, count and columns',
		Boolean(epicInfo) && epicInfo.hasChildSection === true && epicInfo.children.length === 2 && epicInfo.children.some((child) => child.id === childAId) && epicInfo.children.some((child) => child.id === childBId),
		epicInfo && { count: epicInfo.children.length, children: epicInfo.children.map((child) => child.id) },
	)
	record('AC2/noExecPanel', 'no execution panel is rendered for the EPIC', Boolean(epicInfo) && epicInfo.hasExecPanel === false, epicInfo && { hasExecPanel: epicInfo.hasExecPanel })
	await shot('epic-read-1024-light')

	const childRowExpr = `document.querySelector('.kb-drawer [data-child-id="${childAId}"]')`
	const childClicked = await pointerClick(childRowExpr)
	let childDrawerOpened = false
	try {
		await waitFor(`document.querySelector('.kb-drawer[aria-label*="${childAId}"]')`, 'child drawer ' + childAId, 6000)
		childDrawerOpened = true
	} catch {
		childDrawerOpened = false
	}
	const childState = childDrawerOpened ? await descriptionState() : null
	record(
		'AC2/childOpens',
		'clicking a child row still opens that child drawer',
		childClicked === true && childDrawerOpened === true && Boolean(childState) && childState.readMode === 'read',
		{ childAId, childDrawerOpened },
	)
	await closeDrawer()

	// -------------------------------------------------------------------
	// AC6 — 20,000-char PRD scroll containment at 1024 and 640
	// -------------------------------------------------------------------

	const measureDrawer = () =>
		app.evaluate(`(() => {
			const body = document.querySelector('.kb-drawerBody');
			const head = document.querySelector('.kb-drawerHead');
			const drawer = document.querySelector('.kb-drawer');
			if (!body || !head || !drawer) return null;
			const headRect = head.getBoundingClientRect();
			const drawerRect = drawer.getBoundingClientRect();
			const doc = document.documentElement;
			return {
				scrollTop: body.scrollTop,
				scrollHeight: body.scrollHeight,
				clientHeight: body.clientHeight,
				bodyScrollWidth: body.scrollWidth,
				bodyClientWidth: body.clientWidth,
				headTop: Math.round(headRect.top),
				headLeft: Math.round(headRect.left),
				headWidth: Math.round(headRect.width),
				headHeight: Math.round(headRect.height),
				drawerWidth: Math.round(drawerRect.width),
				windowScrollY: window.scrollY,
				docScrollWidth: doc.scrollWidth,
				docClientWidth: doc.clientWidth,
			};
		})()`)

	const scrollDrawerBody = () =>
		app.evaluate('(() => { const body = document.querySelector(".kb-drawerBody"); if (!body) return false; body.scrollTop = body.scrollHeight; return true })()')

	const measureAtWidth = async (width, height) => {
		await setViewport(width, height)
		await openTicket(prdId)
		await sleep(500)
		const before = await measureDrawer()
		await scrollDrawerBody()
		await sleep(500)
		const after = await measureDrawer()
		await closeDrawer()
		return { width, height, before, after }
	}

	const at1024 = await measureAtWidth(1024, 768)
	record(
		'AC6/containment1024',
		'at 1024x768 the drawer body is the only scroller and the head stays put',
		Boolean(at1024.before && at1024.after) &&
			at1024.before.scrollHeight > at1024.before.clientHeight &&
			at1024.after.scrollTop > at1024.before.scrollTop &&
			at1024.after.headTop === at1024.before.headTop &&
			at1024.after.headLeft === at1024.before.headLeft &&
			at1024.after.headWidth === at1024.before.headWidth &&
			at1024.after.headHeight === at1024.before.headHeight &&
			at1024.after.windowScrollY === at1024.before.windowScrollY &&
			at1024.after.docScrollWidth <= at1024.after.docClientWidth,
		at1024,
	)
	const at640 = await measureAtWidth(640, 900)
	record(
		'AC6/containment640',
		'at 640x900 the drawer body is the only scroller and the head stays put',
		Boolean(at640.before && at640.after) &&
			at640.before.scrollHeight > at640.before.clientHeight &&
			at640.after.scrollTop > at640.before.scrollTop &&
			at640.after.headTop === at640.before.headTop &&
			at640.after.headLeft === at640.before.headLeft &&
			at640.after.headWidth === at640.before.headWidth &&
			at640.after.headHeight === at640.before.headHeight &&
			at640.after.windowScrollY === at640.before.windowScrollY &&
			at640.after.docScrollWidth <= at640.after.docClientWidth,
		at640,
	)
	record(
		'AC6/fullWidthAt640',
		'the drawer takes the full panel width at 640',
		Boolean(at640.after) && at640.after.drawerWidth >= 600,
		at640.after && { drawerWidth: at640.after.drawerWidth },
	)
	await setViewport(1024, 768)

	// -------------------------------------------------------------------
	// AC7 — paused board
	// -------------------------------------------------------------------

	const pauseResult = await pageAction('pauseBoard')
	boardPausedByProbe = pauseResult.ok === true
	let pausedSnap = await pageState()
	const pausedNow = pausedSnap.board && pausedSnap.board.paused === true
	record('AC7/paused', 'the board can be paused through the existing action', pauseResult.ok === true && pausedNow === true, { status: pauseResult.status, paused: pausedNow })
	if (pausedNow) {
		let bannerVisible = false
		try {
			await waitFor('(document.querySelector(".kb-banner") || {}).innerText && /Board paused/.test(document.querySelector(".kb-banner").innerText)', 'paused banner', 8000)
			bannerVisible = true
		} catch {
			bannerVisible = false
		}
		record('AC7/banner', 'the paused banner is visible', bannerVisible, null)

		const descriptionBeforePause = ticketById(pausedSnap, prdId).description
		await openTicket(prdId)
		await sleep(400)
		const pausedState = await descriptionState()
		record(
			'AC7/editDisabled',
			'Edit is disabled exactly as the textarea is today',
			Boolean(pausedState) && pausedState.buttons.some((b) => b.text === 'Edit' && b.disabled === true),
			pausedState && pausedState.buttons.map((b) => ({ text: b.text, disabled: b.disabled })),
		)
		record(
			'AC7/readRenders',
			'the read view still renders',
			Boolean(pausedState) && pausedState.hasMarkdown === true && pausedState.hasTextarea === false && pausedState.tags.h3 >= 1,
			pausedState && { tags: pausedState.tags },
		)
		const pausedBefore = await measureDrawer()
		await scrollDrawerBody()
		await sleep(450)
		const pausedAfter = await measureDrawer()
		record(
			'AC7/readScrolls',
			'the read view body still scrolls while paused',
			Boolean(pausedBefore && pausedAfter) && pausedBefore.scrollHeight > pausedBefore.clientHeight && pausedAfter.scrollTop > pausedBefore.scrollTop,
			{ before: pausedBefore && pausedBefore.scrollTop, after: pausedAfter && pausedAfter.scrollTop },
		)
		await app.evaluate('(() => { const body = document.querySelector(".kb-drawerBody"); if (body) body.scrollTop = 0; return true })()')
		await sleep(300)
		await shot('paused-1024-light')
		const savedFlashPaused = await app.evaluate('!!document.querySelector(".kb-drawer .kb-savedHint")')
		const descriptionAfterPause = ticketById(await pageState(), prdId).description
		record(
			'AC7/noMutation',
			'no Saved flash and the stored description is unchanged while paused',
			savedFlashPaused === false && descriptionAfterPause === descriptionBeforePause,
			{ savedFlash: savedFlashPaused, unchanged: descriptionAfterPause === descriptionBeforePause },
		)
		await closeDrawer()

		const resumeResult = await pageAction('resumeBoard')
		boardPausedByProbe = false
		pausedSnap = await pageState()
		record('AC7/resumed', 'the board is resumed in cleanup', resumeResult.ok === true && pausedSnap.board && pausedSnap.board.paused === false, { status: resumeResult.status })
		try {
			await waitFor('!document.querySelector(".kb-banner")', 'paused banner gone', 8000)
		} catch {
			// the banner check above already recorded the state; resume is asserted from the snapshot
		}
	}
	await setViewport(1024, 768)

	// -------------------------------------------------------------------
	// AC8 — real buttons, Tab order, aria-pressed, Escape focus return
	// -------------------------------------------------------------------

	await closeDrawer()
	await openTicketByPointer(mdId)
	const focusAtOpen = await app.evaluate('(() => { const el = document.activeElement; return el ? { tag: el.tagName.toLowerCase(), label: el.getAttribute("aria-label"), text: (el.textContent || "").trim().slice(0, 40) } : null })()')
	const buttonsInfo = await descriptionState()
	record(
		'AC8/realButtons',
		'Edit and Preview are real <button type=button> elements with accessible names',
		Boolean(buttonsInfo) &&
			buttonsInfo.buttons.length === 2 &&
			buttonsInfo.buttons.every((b) => b.tag === 'button' && b.type === 'button' && b.text.length > 0) &&
			buttonsInfo.buttons.some((b) => b.text === 'Edit') &&
			buttonsInfo.buttons.some((b) => b.text === 'Preview'),
		buttonsInfo && buttonsInfo.buttons.map((b) => ({ tag: b.tag, type: b.type, text: b.text })),
	)
	record(
		'AC8/modeGroup',
		'the toggle group carries a localized accessible name',
		Boolean(buttonsInfo) && buttonsInfo.groupLabel === 'Description view',
		buttonsInfo && { groupLabel: buttonsInfo.groupLabel },
	)
	record(
		'AC8/readPressedState',
		'in read mode both toggles report aria-pressed=false',
		Boolean(buttonsInfo) && buttonsInfo.buttons.every((b) => b.pressed === 'false'),
		buttonsInfo && buttonsInfo.buttons.map((b) => ({ text: b.text, pressed: b.pressed })),
	)

	// Tab walk from the focused close button: the two toggles must be reachable.
	const tabOrder = []
	for (let step = 0; step < 6; step += 1) {
		await app.key('Tab')
		await sleep(200)
		tabOrder.push(
			await app.evaluate('(() => { const el = document.activeElement; if (!el) return null; return { tag: el.tagName.toLowerCase(), label: el.getAttribute("aria-label"), text: (el.textContent || "").trim().slice(0, 30), className: el.className }; })()'),
		)
	}
	const tabLabels = tabOrder.map((entry) => (entry ? (entry.text || entry.label || entry.className) : null))
	const editIndex = tabLabels.indexOf('Edit')
	const previewIndex = tabLabels.indexOf('Preview')
	record(
		'AC8/tabOrder',
		'Edit and Preview are reachable with Tab, in order',
		editIndex !== -1 && previewIndex === editIndex + 1,
		{ focusAtOpen, tabLabels },
	)

	const pressedAfterEdit = await pointerClick(modeButtonExpr('Edit'))
	await sleep(250)
	const editPressState = await descriptionState()
	record(
		'AC8/pressedEdit',
		'pressing Edit flips aria-pressed on Edit only',
		pressedAfterEdit === true && Boolean(editPressState) && editPressState.buttons.some((b) => b.text === 'Edit' && b.pressed === 'true') && editPressState.buttons.some((b) => b.text === 'Preview' && b.pressed === 'false'),
		editPressState && editPressState.buttons.map((b) => ({ text: b.text, pressed: b.pressed })),
	)
	const pressedStyle = editPressState
		? (() => {
				const pressed = editPressState.buttonStyles.find((b) => b.text === 'Edit')
				const idle = editPressState.buttonStyles.find((b) => b.text === 'Preview')
				return { pressed, idle, differs: Boolean(pressed && idle) && (pressed.borderColor !== idle.borderColor || pressed.background !== idle.background) }
		  })()
		: null
	record(
		'AC8/pressedVisible',
		'the pressed toggle is visually distinguishable from the idle one',
		Boolean(pressedStyle) && pressedStyle.differs === true,
		pressedStyle,
	)
	const pressedPreview = await pointerClick(modeButtonExpr('Preview'))
	await sleep(250)
	const previewPressState = await descriptionState()
	record(
		'AC8/pressedPreview',
		'pressing Preview flips aria-pressed to Preview',
		pressedPreview === true && Boolean(previewPressState) && previewPressState.buttons.some((b) => b.text === 'Preview' && b.pressed === 'true') && previewPressState.buttons.some((b) => b.text === 'Edit' && b.pressed === 'false'),
		previewPressState && previewPressState.buttons.map((b) => ({ text: b.text, pressed: b.pressed })),
	)

	// Escape closes and focus returns to the originating card.
	await app.key('Escape')
	await sleep(500)
	const closed = !(await drawerOpen())
	const focusReturn = await app.evaluate('(() => { const el = document.activeElement; if (!el) return null; return { tag: el.tagName.toLowerCase(), ticket: el.getAttribute("data-ticket"), role: el.getAttribute("role"), tabIndex: el.tabIndex, isCard: el.matches("article.kb-card[data-ticket]") }; })()')
	record(
		'AC8/escapeFocusReturn',
		'Escape closes the drawer and focus returns to the originating card',
		closed === true && Boolean(focusReturn) && focusReturn.isCard === true && focusReturn.ticket === mdId && focusReturn.role === 'button' && focusReturn.tabIndex === 0,
		{ closed, focusReturn },
	)

	// Keyboard open path: focus the card, Enter, Escape, focus back on the card.
	await app.evaluate(`(() => { const c = document.querySelector('.kb-card[data-ticket="${mdId}"]'); if (c) c.focus(); return true })()`)
	await app.key('Enter')
	let keyboardOpened = false
	try {
		await waitFor(`document.querySelector('.kb-drawer[aria-label*="${mdId}"]')`, 'keyboard open', 6000)
		keyboardOpened = true
	} catch {
		keyboardOpened = false
	}
	await app.key('Escape')
	await sleep(500)
	const keyboardFocusReturn = await app.evaluate('(() => { const el = document.activeElement; return el ? { isCard: el.matches("article.kb-card[data-ticket]"), ticket: el.getAttribute("data-ticket") } : null; })()')
	record(
		'AC8/keyboardOpen',
		'the card opens by keyboard and Escape restores keyboard focus to it',
		keyboardOpened === true && Boolean(keyboardFocusReturn) && keyboardFocusReturn.isCard === true && keyboardFocusReturn.ticket === mdId,
		{ keyboardOpened, keyboardFocusReturn },
	)

	// -------------------------------------------------------------------
	// AC9 — zh locale renders the read view, empty hint, Edit and Preview
	// -------------------------------------------------------------------

	// Restore the rich source after the edit/preview drafts so the zh pass (and
	// its screenshot) exercises the full read view, not just the short draft.
	const resetMd = await pageAction('updateTicket', { ticketId: mdId, patch: { description: MD_SOURCE } })
	await sleep(900)
	const resetTicket = ticketById(await pageState(), mdId)
	record(
		'AC9/zhFixtureReset',
		'the fixture description is restored to the Markdown source for the zh pass',
		resetMd.ok === true && Boolean(resetTicket) && resetTicket.description === MD_SOURCE,
		resetTicket ? { length: resetTicket.description.length } : null,
	)

	const zhSwitched = await setLanguage('中文')
	record('AC9/zhSwitch', 'the shell switches to Simplified Chinese', zhSwitched === true, null)
	if (zhSwitched) {
		await openPanel()
		await waitFor('document.querySelector(".kb-card[data-ticket=\\"' + mdId + '\\"]")', 'zh fixture card', 12000).catch(() => {})
		let zhClientTitle = await clientProjectTitle()
		if (zhClientTitle !== PROBE_PROJECT) {
			// The project selector copy does not localize; reselect only when the board moved.
			await selectProject(PROBE_PROJECT)
		}
		await openTicket(mdId)
		const zhState = await descriptionState()
		record(
			'AC9/zhReadView',
			'the zh read view renders the formatted tree',
			Boolean(zhState) &&
				zhState.hasMarkdown === true &&
				zhState.hasTextarea === false &&
				zhState.tags.h3 >= 1 &&
				zhState.tags.h4 >= 1 &&
				zhState.tags.li >= 3 &&
				zhState.preCode >= 1 &&
				zhState.visibleText.indexOf('Release checklist') !== -1,
			zhState && { tags: zhState.tags, sample: zhState.visibleText.slice(0, 120) },
		)
		record(
			'AC9/zhButtons',
			'Edit and Preview carry the zh accessible names',
			Boolean(zhState) && zhState.buttons.some((b) => b.text === '编辑') && zhState.buttons.some((b) => b.text === '预览') && zhState.groupLabel === '描述视图',
			zhState && { buttons: zhState.buttons.map((b) => ({ text: b.text, pressed: b.pressed })), groupLabel: zhState.groupLabel },
		)
		await shot('read-1024-zh')
		await closeDrawer()
		await openTicket(emptyId)
		const zhEmpty = await descriptionState()
		record(
			'AC9/zhEmptyHint',
			'the zh empty hint renders for an empty description',
			Boolean(zhEmpty) && typeof zhEmpty.emptyText === 'string' && zhEmpty.emptyText.indexOf('暂无描述') !== -1,
			zhEmpty && { emptyText: zhEmpty.emptyText },
		)
		await closeDrawer()

		const backToEnglish = await setLanguage('English')
		record('AC9/backToEnglish', 'the shell returns to English', backToEnglish === true && (await panelTitle()) === 'Kanban', await panelTitle())
	}

	await openPanel()
	await reloadShell()
	await openPanel()
	let finalClientTitle = await clientProjectTitle()
	if (finalClientTitle !== PROBE_PROJECT) {
		await selectProject(PROBE_PROJECT)
		finalClientTitle = await clientProjectTitle()
	}
	await setViewport(1024, 768)
	await setTheme('light')
	record(
		'setup/boardRestored',
		'the probe board is selected again after the locale pass',
		finalClientTitle === PROBE_PROJECT,
		{ finalClientTitle },
	)

	// -------------------------------------------------------------------
	// AC10 — the other drawer sections are intact and interactive
	// -------------------------------------------------------------------

	await openTicket(mdId)
	await sleep(400)
	const sections = await app.evaluate(`(() => {
		const drawer = document.querySelector('.kb-drawer');
		if (!drawer) return null;
		const byLabel = (label) => [...drawer.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === label) || null;
		const input = (label) => drawer.querySelector('input[aria-label="' + label + '"]') || drawer.querySelector('input[placeholder="' + label + '"]');
		return {
			titleInput: (() => { const el = drawer.querySelector('.kb-titleInput'); return el ? { value: el.value, disabled: el.disabled } : null; })(),
			blockButton: (() => { const el = byLabel('Block'); return el ? { text: (el.textContent || '').trim(), disabled: el.disabled } : null; })(),
			blockReason: (() => { const el = input('Block reason'); return el ? { disabled: el.disabled, value: el.value } : null; })(),
			labels: (() => { const el = input('Labels'); return el ? { value: el.value, disabled: el.disabled } : null; })(),
			checklistAddInput: (() => { const el = input('Add a checklist item'); return el ? { disabled: el.disabled } : null; })(),
			checklistAddButton: (() => { const el = drawer.querySelector('button[aria-label="Add"]'); return el ? { disabled: el.disabled, label: el.getAttribute('aria-label') } : null; })(),
			commentComposer: (() => { const el = input('Write a comment…'); return el ? { disabled: el.disabled } : null; })(),
			commentButton: (() => { const el = byLabel('Comment'); return el ? { disabled: el.disabled } : null; })(),
			comments: [...drawer.querySelectorAll('.kb-comment')].map((el) => (el.innerText || '').trim().slice(0, 80)),
			activityItems: drawer.querySelectorAll('.kb-activityItem').length,
			execPanel: Boolean(drawer.querySelector('.kb-execPanel')),
			execEnabledControls: [...drawer.querySelectorAll('.kb-execPanel button, .kb-execPanel select, .kb-execPanel input')].filter((el) => !el.disabled).length,
			checklistItems: drawer.querySelectorAll('.kb-checkItem').length,
		};
	})()`)
	const sectionsPass =
		Boolean(sections) &&
		sections.titleInput &&
		sections.titleInput.disabled === false &&
		sections.blockButton &&
		sections.blockButton.disabled === false &&
		sections.blockReason &&
		sections.blockReason.disabled === false &&
		sections.labels &&
		sections.labels.disabled === false &&
		sections.checklistAddInput &&
		sections.checklistAddInput.disabled === false &&
		sections.checklistAddButton &&
		sections.commentComposer &&
		sections.commentComposer.disabled === false &&
		sections.commentButton &&
		sections.comments.length === 1 &&
		sections.comments[0].indexOf('KB-58 probe comment') !== -1 &&
		sections.activityItems >= 1 &&
		sections.execPanel === true &&
		sections.execEnabledControls >= 1
	record('AC10/sectionsPresent', 'every other drawer section is still present and interactive', sectionsPass, sections)

	// One real interaction proves the checklist path still works after the change.
	const checklistBefore = sections ? sections.checklistItems : 0
	await app.type('document.querySelector(".kb-drawer input[placeholder=\\"Add a checklist item\\"]")', 'probe checklist item')
	await pointerClick('document.querySelector(".kb-drawer button[aria-label=\\"Add\\"]")')
	await sleep(1500)
	const checklistAfter = await app.evaluate('document.querySelectorAll(".kb-drawer .kb-checkItem").length')
	record(
		'AC10/checklistInteractive',
		'adding a checklist item from the drawer still works',
		checklistAfter > checklistBefore,
		{ before: checklistBefore, after: checklistAfter },
	)
	await closeDrawer()

	// -------------------------------------------------------------------
	// Console hygiene
	// -------------------------------------------------------------------

	const allConsole = await app.errors()
	const exceptions = allConsole.filter((entry) => entry.type === 'exception')
	const kanbanErrors = allConsole.filter(
		(entry) => entry.type === 'error' && /kanban|kb-|markdown|drawer/i.test(entry.text || ''),
	)
	results.console = allConsole.slice(0, 60)
	record(
		'AC10/consoleClean',
		'no console exception or kanban error is recorded during the probe',
		exceptions.length === 0 && kanbanErrors.length === 0,
		{ exceptions: exceptions.slice(0, 3), kanbanErrors: kanbanErrors.slice(0, 3) },
	)
} catch (error) {
	record('probe/completed', 'the probe ran to completion', false, String((error && error.message) || error))
} finally {
	// -------------------------------------------------------------------
	// Cleanup: resume, delete fixtures, restore language/workspace, verify count
	// -------------------------------------------------------------------

	try {
		const themeRestored = await setTheme('light')
		results.cleanup.push({ step: 'theme', themeRestored, source: await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")') })
		await setViewport(1024, 768)
		await closeDrawer()
		const stateBeforeCleanup = await pageState()
		if (stateBeforeCleanup.board && stateBeforeCleanup.board.paused === true) {
			const resumed = await pageAction('resumeBoard')
			results.cleanup.push({ step: 'resume', status: resumed.status, ok: resumed.ok })
			boardPausedByProbe = false
		}
		// Children must go before their EPIC.
		for (const id of [childAId, childBId, epicId, prdId, emptyId, mdId]) {
			if (!id) continue
			const deleted = await pageAction('deleteTicket', { ticketId: id })
			results.cleanup.push({ step: 'delete', id, status: deleted.status, ok: deleted.ok })
		}
		// The checklist item added in AC10 is removed with the fixture.
		await sleep(1200)
		const finalSnap = await pageState()
		const remainingFixtures = (finalSnap.board && Array.isArray(finalSnap.board.tickets) ? finalSnap.board.tickets : []).filter(
			(ticket) => results.created.indexOf(ticket.id) !== -1,
		)
		const finalCount = finalSnap.board && Array.isArray(finalSnap.board.tickets) ? finalSnap.board.tickets.length : -1
		record(
			'cleanup/deleted',
			'the probe fixtures are deleted and the board ticket count is restored',
			remainingFixtures.length === 0 && finalCount === preProbeCount,
			{ remaining: remainingFixtures.map((ticket) => ticket.id), finalCount, preProbeCount },
		)
		results.cleanup.push({ step: 'count', finalCount, preProbeCount })

		// A crash mid-i18n must not leave the user's shell in Chinese.
		try {
			const titleNow = await panelTitle()
			if (titleNow !== null && titleNow !== 'Kanban') {
				await setLanguage('English')
				results.cleanup.push({ step: 'language', restored: await panelTitle() })
			}
		} catch {
			results.cleanup.push({ step: 'language', restored: 'failed' })
		}

		// Restore the previously selected workspace so the user's GUI is untouched.
		if (originalWorkspaceId && originalWorkspaceId !== scratch.id) {
			await app.evaluate(`(() => { window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(originalWorkspaceId)}); return true })()`)
			workspaceId = originalWorkspaceId
			await reloadShell()
			await openPanel()
			await sleep(500)
			const restoredTitle = await clientProjectTitle()
			const restoredPanel = await panelTitle()
			results.cleanup.push({ step: 'workspace', restoredTitle, restoredPanel })
			record(
				'cleanup/workspaceRestored',
				'the previously selected workspace is restored',
				restoredTitle !== PROBE_PROJECT || restoredTitle === bootSnap.project.title,
				{ restoredTitle, expected: bootSnap.project && bootSnap.project.title },
			)
		}
		await setTheme('light')
		await closeDrawer()
	} catch (error) {
		record('cleanup/error', 'cleanup completed without error', false, String((error && error.message) || error))
	}

	cleanupDone = true
	results.meta.finishedAt = new Date().toISOString()
	results.meta.failures = failures
	results.meta.createdTickets = results.created
	results.meta.boardPausedByProbe = boardPausedByProbe
	results.meta.cleanupDone = cleanupDone
	await mkdir(OUT, { recursive: true })
	await writeFile(new URL('../docs/screenshots/kb58/final-verification.json', import.meta.url), JSON.stringify(results, null, 1))
	console.log(`\n${failures === 0 ? 'ALL KB-58 PROBE CHECKS PASSED' : `${failures} PROBE FAILURE(S)`} — ${results.checks.length} checks, ${results.screenshots.length} screenshots`)
	process.exit(failures === 0 ? 0 : 1)
}
