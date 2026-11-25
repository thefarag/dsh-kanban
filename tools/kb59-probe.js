/**
 * KB-59 verification probe — agent-written drawer surfaces render Markdown.
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) and
 * asserts the KB-59 acceptance contract end to end:
 *   AC1  a comment with a list, a fence and a link renders as markup (no literal
 *        "- ", fence or [label](url) text), every source word survives, the
 *        author is comment.author, the relative time is present and comments
 *        stay newest-first
 *   AC2  a plain multi-line comment keeps one line break per source newline
 *        (one <br> per newline, one paragraph, no lost words)
 *   AC3  a 4,000-character comment with a fence at 1024 and 640: only
 *        .kb-drawerBody scrolls, code scrolls inside <pre>, no horizontal
 *        overflow, the composer is reachable and its button is clickable
 *   AC4  the done-state and the non-done execution report blocks both render
 *        Markdown inside the unchanged 120px .kb-execReport scroller; the
 *        panel's retry/continue/cancel buttons stay visible and enabled and no
 *        page scrollbar appears
 *   AC5  the wait box renders reason/questions/needs as Markdown while the
 *        answer inputs, grant checkboxes and Send enable/disable rules (empty,
 *        answered, granted, pending) are unchanged
 *   AC6  each answer input's aria-label is the plain projection of its question
 *        (markers stripped, link label kept without URL, code text kept, one
 *        line) and still identifies the question
 *   AC7  hostile comment/report/reason/question/need content creates no
 *        script/img/iframe node, executes no script, shows the raw source as
 *        literal text and renders a javascript: link as its label with no anchor
 *   AC8  across a real 2.5s poll the drawer body scrollTop is unchanged and the
 *        comment DOM nodes are the same nodes (the memoized MarkdownBody is not
 *        re-parsed; confirmed in the diff)
 *   AC9  en + zh both render the surfaces and the locale-dependent aria labels
 *        (the <pre> code-block label inside a question) follow the locale; key
 *        parity is covered by tests/client.test.mjs (run separately)
 *   AC10 create / comment / block / unblock / run / resume / answer / delete stay
 *        wired: real host mutations where an action can write the field, the
 *        agent-only run/resume/answer controls are observed through the probe
 *        fetch shim so no live agent session is spawned, and the fixture tickets
 *        are deleted with the board ticket count restored
 *
 * Fixture strategy (stated, not hidden):
 *   - Real host mutations for everything a UI action can write: temporary
 *     tickets (createTicket), real comments (comment), block/unblock
 *     (blockTicket) and cleanup (deleteTicket).
 *   - execution.report and ticket.block.questions/needs can only be written by an
 *     agent execution/tool (index.js finishTicketExecution / the agent block
 *     tool), never by a UI action, so this probe injects a one-shot read-only
 *     fixture into the `/kanban/state` response through a page-level `fetch`
 *     shim. The real React render path, the real MarkdownBody and the real CSS
 *     are exercised; the shim is removed before cleanup and the persisted board
 *     is asserted untouched (`fixtureSource: "fetch-shim"` in the JSON).
 *   - The run/resume/answer controls are clicked for real, but `runTicket` is
 *     short-circuited by the shim: calling it on a real ticket would spawn a live
 *     agent session. `resumeExecution`/`answerTicket`/`cancelExecution` reach the
 *     host and are rejected (there is no execution on the crafted ticket), which
 *     is recorded; the dispatched payloads are asserted instead.
 *
 * Board discipline: runs on the `default-workspace` scratch board (the kb5/kb58
 * convention) so a fixture never lands on the project board; the previously
 * selected workspace, language and theme are restored at the end.
 *
 * Writes docs/screenshots/kb59/final-verification.json plus labelled PNG evidence.
 *
 * Usage (Chrome on CDP port 9333, GUI URL in $DSH_WEB_URL):
 *   node tools/kb59-probe.js
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { attach } from './cdp.mjs'

const OUT_URL = new URL('../docs/screenshots/kb59/', import.meta.url)
const OUT = OUT_URL.pathname
const PROJECT_FILE = '../docs/screenshots/kb59/final-verification.json'
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

const RICH_COMMENT = [
	'## Review summary',
	'',
	'The **scope** is fine, but the list below must be addressed:',
	'',
	'- First bullet keeps its words',
	'- Second bullet carries `inline code`',
	'',
	'```js',
	'const answer = 42',
	'console.log(answer)',
	'```',
	'',
	'Read [the spec](https://example.com/spec) before you reply.',
].join('\n')

// Every word below must survive rendering; the only newlines are soft breaks.
const PLAIN_COMMENT = [
	'Line one stays on its own line',
	'Line two follows immediately',
	'Line three keeps its words',
	'Line four closes the comment',
].join('\n')

const HOSTILE_SCRIPT = '<script>window.__kb59xss = true</script>'
const HOSTILE_IMG = '<img src=x onerror="window.__kb59xss = true">'
const HOSTILE_LINK = '[click](javascript:alert(1))'
const HOSTILE_COMMENT = [HOSTILE_SCRIPT, HOSTILE_IMG, HOSTILE_LINK].join('\n')

const LONG_CODE_LINE =
	'const veryLongIdentifierNameThatKeepsGoing = "' + 'x'.repeat(170) + '"; // past the drawer edge'

function buildLongComment() {
	const lines = [
		'## Long agent report',
		'',
		'This paragraph sits above the fenced block so the comment overflows the drawer',
		'body at both panel widths and the code block has to scroll on its own.',
		'',
		'```js',
		LONG_CODE_LINE,
		'const second = 2',
		'```',
		'',
	]
	for (let step = 1; step <= 40; step += 1) lines.push(`Step ${step}: verified surface ${step} without a regression in the drawer.`)
	while (lines.join('\n').length < 3900) lines.push('Padding line to reach the documented four-thousand character comment fixture.')
	return lines.join('\n')
}

const LONG_COMMENT = buildLongComment()

function buildReport(label) {
	const lines = [
		'## Execution summary',
		'',
		`${label} shipped the drawer surfaces and kept the controls reachable.`,
		'',
		'### What changed',
		'',
		'- Comment bodies render as Markdown',
		'- Reports render inside the same 120px scroller',
		'- The wait box renders reason, questions and needs',
		'',
		'```js',
		'const report = "markdown"',
		'console.log(report)',
		'```',
		'',
	]
	for (let step = 1; step <= 18; step += 1) lines.push(`Step ${step}: verified report surface ${step} without a regression.`)
	lines.push('', 'Retry with `npm test` if it flakes.')
	return lines.join('\n')
}

const DONE_REPORT = buildReport('The done attempt')
const PAUSED_REPORT = buildReport('The paused attempt')

const HOSTILE_REPORT = ['## Hostile report', '', HOSTILE_SCRIPT, '', '- ' + HOSTILE_IMG, '- ' + HOSTILE_LINK].join('\n')

const BLOCK_REASON = [
	'The **answer format** is unclear; I need one decision before I can continue.',
	'',
	'```json',
	'{ "scope": "client.js" }',
	'```',
].join('\n')
const BLOCK_QUESTIONS = [
	[
		'## Which scope do you approve?',
		'',
		'- `client.js` only',
		'- [the shared spec](https://example.com/spec) as well',
		'',
		'Reply with `yes` or `no`.',
	].join('\n'),
	'Should I keep the **plain** fallback for old clients?',
]
const BLOCK_NEEDS = [
	{ id: 'need-a', kind: 'permission', text: 'Grant **write** access to `docs/`' },
	{ id: 'need-b', kind: 'decision', text: 'Approve [the plan](https://example.com/plan) as written' },
]
// The documented plain projection of BLOCK_QUESTIONS[0] (KB-59 D2 / AC6).
const Q1_PLAIN_LABEL = 'Which scope do you approve? client.js only the shared spec as well Reply with yes or no.'

const HOSTILE_BLOCK = {
	reason: `${HOSTILE_SCRIPT} blocked the run`,
	questions: [{ id: 'hq-1', text: `Is ${HOSTILE_LINK} safe to open?` }],
	needs: [{ id: 'hn-1', kind: 'permission', text: `Allow ${HOSTILE_IMG} in the report` }],
	askedAt: 0,
}

const BLOCK_TICKET_TEXT = {
	reason: BLOCK_REASON,
	questions: BLOCK_QUESTIONS.map((text, index) => ({ id: `q-${index + 1}`, text })),
	needs: BLOCK_NEEDS,
	askedAt: 0,
}

const EXECUTION_DONE = {
	status: 'done',
	role: 'fe-developer',
	accessMode: 'workspace-write',
	sessionId: null,
	startedAt: 0,
	updatedAt: 0,
	finishedAt: 0,
	report: DONE_REPORT,
}

const EXECUTION_PAUSED = {
	status: 'paused',
	role: 'fe-developer',
	accessMode: 'workspace-write',
	sessionId: 'session-kb59-probe-fixture',
	startedAt: 0,
	updatedAt: 0,
	pausedAt: 0,
	report: PAUSED_REPORT,
}

const EXECUTION_HOSTILE = {
	status: 'blocked',
	role: 'fe-developer',
	accessMode: 'workspace-write',
	sessionId: null,
	startedAt: 0,
	updatedAt: 0,
	finishedAt: 0,
	report: HOSTILE_REPORT,
}

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

/** Switch the app theme through its real control (Settings → General → Appearance). */
async function setTheme(theme) {
	const target = theme === 'dark' ? 'dark' : 'light'
	const current = await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")')
	if (current === target) return true
	await openPanel()
	const opened = await openSettings()
	if (!opened) return false
	await app.evaluate(
		`(() => { const el = [...document.querySelectorAll('button,[role="tab"]')].find((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
		{ userGesture: true },
	)
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

async function clearToasts() {
	for (let attempt = 0; attempt < 16; attempt += 1) {
		const open = await app.evaluate('document.querySelectorAll(".kb-toast").length')
		if (!open) return true
		const closed = await app.evaluate(
			`(() => {
				const toast = document.querySelector('.kb-toast');
				const close = toast ? toast.querySelector('button') : null;
				if (!close) return false;
				close.click();
				return true;
			})()`,
			{ userGesture: true },
		)
		await sleep(closed ? 250 : 400)
	}
	return (await app.evaluate('document.querySelectorAll(".kb-toast").length')) === 0
}

/** Scroll the drawer body so the comment section is in view (evidence shots). */
async function scrollToComments() {
	await app.evaluate(`(() => {
		const body = document.querySelector('.kb-drawerBody');
		const section = [...document.querySelectorAll('.kb-drawer .kb-section')].find((s) => {
			const title = s.querySelector('.kb-sectionTitle');
			return title && /^(Comments|评论)$/.test((title.textContent || '').trim());
		});
		if (!body || !section) return false;
		const bodyRect = body.getBoundingClientRect();
		const sectionRect = section.getBoundingClientRect();
		body.scrollTop = body.scrollTop + (sectionRect.top - bodyRect.top) - 6;
		return true;
	})()`)
	await sleep(400)
}

async function shot(name) {
	await dismissAppModals()
	await clearToasts()
	const path = `${OUT}${name}.png`
	await app.screenshot(path)
	results.screenshots.push(name + '.png')
	console.log('SHOT ' + name)
	return path
}

let workspaceId = ''

/**
 * State through the page fetch (the KB-59 shim patches this response, so this is
 * the *rendered* snapshot, not necessarily the persisted board).
 */
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

/** State straight from the host, bypassing the KB-59 shim. */
const rawState = () =>
	app.evaluate(`(async () => {
		const call = (window.__kb59 && window.__kb59.realFetch) || window.fetch;
		const response = await call.call(window, '/kanban/state', {
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

/** Host action straight from the host, bypassing the KB-59 shim. */
const rawAction = (action, payload = {}) =>
	app.evaluate(`(async () => {
		const call = (window.__kb59 && window.__kb59.realFetch) || window.fetch;
		const response = await call.call(window, 'kanban/action', {
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

/** Plain DOM click (no focus semantics) — focus order is not under test here. */
async function openTicket(id) {
	const expr = `document.querySelector('.kb-card[data-ticket="${id}"]')`
	await app.evaluate(`(() => { const c = ${expr}; if (c) c.scrollIntoView({ block: 'center', inline: 'center' }); return true })()`)
	await sleep(250)
	await closeDrawer()
	const clicked = await app.evaluate(`(() => { const c = ${expr}; if (!c) return false; c.click(); return true })()`)
	if (!clicked) throw new Error('card ' + id + ' not found')
	await waitFor(`document.querySelector('.kb-drawer[aria-label*="${id}"]')`, 'drawer ' + id)
	await sleep(500)
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

const panelTitle = () => app.evaluate('(() => { const el = document.querySelector(".kb-root .kb-title"); return el ? (el.textContent || "").trim() : null })()')
const clientProjectTitle = () =>
	app.evaluate('(() => { const el = document.querySelector(".kb-projectName"); return el ? (el.textContent || "").trim() : null })()')

// --- language switching (kb3/kb5/kb58 probe convention) ---------------------

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
		await waitFor(
			`(() => { const el = document.querySelector('.kb-root .kb-title'); return el && (el.textContent || '').trim() === ${JSON.stringify(expectedTitle)} })()`,
			'language ' + target,
			6000,
		)
		changed = true
	} catch {
		changed = false
	}
	results.notes.push({ language: target, steps, changed })
	return steps.pick === true && changed
}

// ---------------------------------------------------------------------------
// KB-59 read-only /kanban/state fixture shim
// ---------------------------------------------------------------------------

function shimCode(spec, options = {}) {
	return `(() => {
		const real = (window.__kb59 && window.__kb59.realFetch) || window.fetch;
		const spec = ${JSON.stringify(spec)};
		const intercept = ${JSON.stringify(options.intercept || [])};
		const now = Date.now();
		const patches = {};
		Object.keys(spec).forEach((id) => {
			const patch = Object.assign({}, spec[id]);
			const append = Array.isArray(patch.appendComments) ? patch.appendComments : null;
			delete patch.appendComments;
			if (append) patch.__kb59Append = append.map((comment) => ({ id: comment.id, author: comment.author, text: comment.text, at: now - (Number(comment.atOffset) || 0) }));
			patches[id] = patch;
		});
		window.__kb59 = { realFetch: real, enabled: true, patches, stateHits: 0, actions: [], intercept, holdAnswer: 0, parsedAt: now };
		window.fetch = async function (input, init) {
			const url = typeof input === 'string' ? input : (input && input.url) || '';
			let body = null;
			try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; } catch (error) { body = null; }
			const action = body && typeof body.action === 'string' ? body.action : null;
			if (action) window.__kb59.actions.push({ action, payload: body.payload, at: Date.now() });
			if (action && window.__kb59.intercept.indexOf(action) !== -1) {
				return new Response(JSON.stringify({ ok: false, error: { code: 'probe/intercepted', message: 'kb59 probe intercepted ' + action + ' (host not called)' } }), { status: 409, headers: { 'content-type': 'application/json' } });
			}
			if (action === 'answerTicket' && window.__kb59.holdAnswer > 0) {
				await new Promise((resolve) => setTimeout(resolve, window.__kb59.holdAnswer));
			}
			const response = await real.call(this, input, init);
			if (url.indexOf('kanban/state') === -1) return response;
			window.__kb59.stateHits += 1;
			if (!window.__kb59.enabled) return response;
			const data = await response.clone().json();
			const value = data && data.value;
			if (value && value.board && Array.isArray(value.board.tickets)) {
				value.board.tickets = value.board.tickets.map((ticket) => {
					if (!ticket || !patches[ticket.id]) return ticket;
					const patch = patches[ticket.id];
					const next = Object.assign({}, ticket, patch);
					if (patch.__kb59Append) next.comments = (Array.isArray(ticket.comments) ? ticket.comments : []).concat(patch.__kb59Append);
					delete next.__kb59Append;
					return next;
				});
			}
			return new Response(JSON.stringify(data), { status: response.status, headers: { 'content-type': 'application/json' } });
		};
		return true;
	})()`
}

const installShim = (spec, options = {}) => app.evaluate(shimCode(spec, options))

const removeShim = () =>
	app.evaluate(`(() => { if (window.__kb59 && window.__kb59.realFetch) window.fetch = window.__kb59.realFetch; window.__kb59 = null; return true })()`)

const shimActions = () => app.evaluate('(window.__kb59 && window.__kb59.actions) || []')
const shimStateHits = () => app.evaluate('(window.__kb59 && window.__kb59.stateHits) || 0')
const setHoldAnswer = (ms) => app.evaluate(`(() => { if (window.__kb59) window.__kb59.holdAnswer = ${Number(ms) || 0}; return true })()`)
const xssFired = () => app.evaluate('window.__kb59xss === true')

/** Wait for at least one poll after a host action so the shim fixture is back in place. */
async function nextPoll() {
	const before = await shimStateHits()
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await sleep(300)
		if ((await shimStateHits()) > before) return true
	}
	return false
}

// ---------------------------------------------------------------------------
// DOM snapshots
// ---------------------------------------------------------------------------

const COMMENT_STATE = `(() => {
	const drawer = document.querySelector('.kb-drawer');
	if (!drawer) return null;
	const rows = [...drawer.querySelectorAll('.kb-comment')].map((row) => {
		const head = row.querySelector('.kb-commentHead');
		const body = row.querySelector('.kb-commentText');
		const md = body ? body.querySelector('.kb-md') : null;
		const tags = {};
		if (md) ['h3','h4','h5','h6','p','ul','ol','li','pre','code','a','br','strong','em','blockquote'].forEach((name) => { tags[name] = md.querySelectorAll(name).length });
		return {
			author: head && head.querySelector('.kb-commentAuthor') ? String(head.querySelector('.kb-commentAuthor').textContent || '') : null,
			age: head && head.children.length > 1 ? String(head.children[head.children.length - 1].textContent || '').trim() : null,
			hasMarkdown: Boolean(md),
			text: body ? String(body.innerText || '') : '',
			tags,
			anchors: md ? [...md.querySelectorAll('a')].map((a) => ({ text: String(a.textContent || '').trim(), href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') })) : [],
			preText: md && md.querySelector('pre') ? String(md.querySelector('pre').innerText || '') : null,
			dangerous: md ? md.querySelectorAll('script,img,iframe,object,embed,svg').length : 0,
			fontSize: md ? getComputedStyle(md).fontSize : null,
			lineHeight: md ? getComputedStyle(md).lineHeight : null,
		};
	});
	return { count: rows.length, rows, drawerText: String(drawer.innerText || '') };
})()`

const PANEL_STATE = `(() => {
	const drawer = document.querySelector('.kb-drawer');
	if (!drawer) return null;
	const panel = drawer.querySelector('.kb-execPanel');
	if (!panel) return null;
	const reports = [...panel.querySelectorAll('.kb-execReport')].map((el) => ({
		hasMarkdown: Boolean(el.querySelector('.kb-md')),
		tags: el.querySelector('.kb-md') ? ['h3','h4','h5','h6','p','ul','li','pre','code','br'].reduce((acc, name) => { acc[name] = el.querySelectorAll('.kb-md ' + name).length; return acc }, {}) : null,
		text: String(el.innerText || ''),
		maxHeight: getComputedStyle(el).maxHeight,
		overflowY: getComputedStyle(el).overflowY,
		scrollHeight: el.scrollHeight,
		clientHeight: el.clientHeight,
		scrollable: el.scrollHeight > el.clientHeight + 1,
		position: (() => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } })(),
	}));
	const buttons = [...panel.querySelectorAll('button')].map((b) => {
		const rect = b.getBoundingClientRect();
		const centre = document.elementFromPoint(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
		return {
			text: String(b.textContent || '').trim(),
			disabled: b.disabled === true,
			visible: rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
			hitTest: Boolean(centre && (centre === b || b.contains(centre))),
			rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
		};
	});
	return { reports, buttons, text: String(panel.innerText || '') };
})()`

const WAIT_STATE = `(() => {
	const drawer = document.querySelector('.kb-drawer');
	if (!drawer) return null;
	const box = drawer.querySelector('.kb-waitBox');
	if (!box) return null;
	const reason = box.querySelector(':scope > .kb-execHint');
	const questions = [...box.querySelectorAll('label.kb-waitQ')].filter((label) => label.querySelector('input.kb-input')).map((label) => {
		const input = label.querySelector('input.kb-input');
		const md = label.querySelector('.kb-md');
		const mdText = md ? String(md.innerText || '') : '';
		const tags = md ? ['h3','h4','h5','h6','p','ul','li','pre','code','br'].reduce((acc, name) => { acc[name] = md.querySelectorAll(name).length; return acc }, {}) : {};
		const pre = md && md.querySelector('pre') ? md.querySelector('pre') : null;
		return {
			hasMarkdown: Boolean(md),
			hasSpan: Boolean(label.querySelector(':scope > span')),
			markdownText: mdText,
			tags,
			preAriaLabel: pre ? pre.getAttribute('aria-label') : null,
			ariaLabel: input.getAttribute('aria-label'),
			value: String(input.value || ''),
			placeholder: input.getAttribute('placeholder'),
			index: input.getAttribute('id'),
		};
	});
	const needs = [...box.querySelectorAll('label.kb-waitNeed')].map((label) => {
		const checkbox = label.querySelector('input[type="checkbox"]');
		const md = label.querySelector('.kb-md');
		return {
			hasMarkdown: Boolean(md),
			markdownText: md ? String(md.innerText || '') : '',
			kind: label.querySelector('.kb-waitKind') ? String(label.querySelector('.kb-waitKind').textContent || '').trim() : null,
			checked: checkbox ? checkbox.checked === true : null,
			hasCheckbox: Boolean(checkbox && checkbox.type === 'checkbox'),
		};
	});
	const send = [...box.querySelectorAll('button')].find((b) => b.textContent && b.textContent.trim().length > 0);
	return {
		hasBox: true,
		hasReasonMarkdown: Boolean(reason && reason.querySelector('.kb-md')),
		reasonPreAriaLabel: reason && reason.querySelector('.kb-md pre') ? reason.querySelector('.kb-md pre').getAttribute('aria-label') : null,
		reasonPreTabIndex: reason && reason.querySelector('.kb-md pre') ? reason.querySelector('.kb-md pre').tabIndex : null,
		reasonText: reason ? String(reason.innerText || '') : null,
		reasonColor: reason ? getComputedStyle(reason).color : null,
		reasonChildColor: reason && reason.querySelector('.kb-md') ? getComputedStyle(reason.querySelector('.kb-md')).color : null,
		questions,
		needs,
		sendLabel: send ? String(send.textContent || '').trim() : null,
		sendDisabled: send ? send.disabled === true : null,
		boxText: String(box.innerText || ''),
	};
})()`

const MEASURE = `(() => {
	const body = document.querySelector('.kb-drawerBody');
	const drawer = document.querySelector('.kb-drawer');
	const doc = document.documentElement;
	if (!body || !drawer) return null;
	const commentPre = document.querySelector('.kb-commentText .kb-md pre');
	const reportPre = document.querySelector('.kb-execReport .kb-md pre');
	const composerInput = (() => {
		const section = [...document.querySelectorAll('.kb-drawer .kb-section')].find((s) => {
			const title = s.querySelector('.kb-sectionTitle');
			return title && /^(Comments|评论)$/.test(String(title.textContent || '').trim());
		});
		return section ? section.querySelector('.kb-inlineAdd .kb-input') : null;
	})();
	const composerButton = (() => {
		const section = [...document.querySelectorAll('.kb-drawer .kb-section')].find((s) => {
			const title = s.querySelector('.kb-sectionTitle');
			return title && /^(Comments|评论)$/.test(String(title.textContent || '').trim());
		});
		return section ? section.querySelector('.kb-inlineAdd button') : null;
	})();
	const hit = composerButton ? (() => {
		const rect = composerButton.getBoundingClientRect();
		const centre = document.elementFromPoint(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
		return { rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width) }, hitTest: Boolean(centre && (centre === composerButton || composerButton.contains(centre))), disabled: composerButton.disabled === true };
	})() : null;
	return {
		bodyClientWidth: body.clientWidth,
		bodyScrollWidth: body.scrollWidth,
		bodyClientHeight: body.clientHeight,
		bodyScrollHeight: body.scrollHeight,
		bodyScrollable: body.scrollHeight > body.clientHeight + 1,
		bodyScrollLeft: body.scrollLeft,
		drawerClientWidth: drawer.clientWidth,
		drawerScrollWidth: drawer.scrollWidth,
		docScrollWidth: doc.scrollWidth,
		docScrollHeight: doc.scrollHeight,
		innerWidth: window.innerWidth,
		innerHeight: window.innerHeight,
		pageHorizontalOverflow: doc.scrollWidth > window.innerWidth + 1,
		pageVerticalOverflow: doc.scrollHeight > window.innerHeight + 1,
		commentPre: commentPre ? { clientWidth: commentPre.clientWidth, scrollWidth: commentPre.scrollWidth, scrollable: commentPre.scrollWidth > commentPre.clientWidth + 1, maxHeight: getComputedStyle(commentPre).maxHeight, overflowX: getComputedStyle(commentPre).overflowX } : null,
		reportPre: reportPre ? { clientWidth: reportPre.clientWidth, scrollWidth: reportPre.scrollWidth } : null,
		composerInputVisible: composerInput ? (() => { const r = composerInput.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0 })() : null,
		composerHit: hit,
	};
})()`

const ticketById = (snap, id) =>
	snap && snap.board && Array.isArray(snap.board.tickets) ? snap.board.tickets.find((ticket) => ticket.id === id) || null : null

const hasMarkers = (text) => /[#*`\[\]]|```/.test(String(text || ''))
const hasUrlLeak = (text) => /https?:\/\/|javascript:|example\.com/.test(String(text || ''))

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
	await writeFile(new URL(PROJECT_FILE, import.meta.url), JSON.stringify({ ...results, meta: { ...results.meta, failures: failures + 1 } }, null, 1))
	process.exit(1)
}
results.meta.probeProject = PROBE_PROJECT
results.meta.probeWorkspaceId = scratch.id
results.meta.originalWorkspaceId = originalWorkspaceId
results.meta.fixtureSource = 'fetch-shim for agent-only fields (execution.report, block.questions/needs); real host mutations for tickets/comments/block'
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

const probeBoardSessions = (bootState.sessions || []).filter(
	(session) => session.running === true && typeof session.cwd === 'string' && session.cwd.startsWith(scratch.path),
)
results.measurements.pauseSafety = { runningSessions: probeBoardSessions.map((session) => session.sessionId) }

// ---------------------------------------------------------------------------
// 1. Fixtures (real host tickets; agent-only fields injected read-only)
// ---------------------------------------------------------------------------

/** (Re)install the read-only fixture shim and wait for the first poll. */
async function restoreFixtures() {
	await installShim(PATCH_SPEC, { intercept: ['runTicket'] })
	await nextPoll()
}

async function createFixture(payload) {
	const result = await pageAction('createTicket', payload)
	const ticket = result.value && result.value.ticket ? result.value.ticket : null
	if (!ticket || typeof ticket.id !== 'string') throw new Error('createTicket failed: ' + JSON.stringify(result.error || result))
	results.created.push(ticket.id)
	return ticket
}

let mdId = null
let longId = null
let PATCH_SPEC = {}
let doneId = null
let pausedId = null
let blockedId = null
let hostileId = null
let regId = null
let epicId = null
let cleanupDone = false

try {
	const mdTicket = await createFixture({ title: 'KB-59 fixture: comment Markdown', type: 'story', priority: 'high', labels: ['probe'] })
	mdId = mdTicket.id
	// Oldest first, so newest-first means [plain, rich] in the DOM.
	await pageAction('comment', { ticketId: mdId, text: RICH_COMMENT })
	await sleep(80)
	await pageAction('comment', { ticketId: mdId, text: PLAIN_COMMENT })
	await sleep(80)

	const longTicket = await createFixture({ title: 'KB-59 fixture: long comment', type: 'task', priority: 'medium', labels: ['probe'] })
	longId = longTicket.id
	await pageAction('comment', { ticketId: longId, text: LONG_COMMENT })

	const doneTicket = await createFixture({ title: 'KB-59 fixture: done report', type: 'story', priority: 'high', labels: ['probe'] })
	doneId = doneTicket.id

	const pausedTicket = await createFixture({ title: 'KB-59 fixture: paused report', type: 'story', priority: 'medium', labels: ['probe'] })
	pausedId = pausedTicket.id

	const blockedTicket = await createFixture({ title: 'KB-59 fixture: blocked wait box', type: 'task', priority: 'critical', labels: ['probe'] })
	blockedId = blockedTicket.id

	const hostileTicket = await createFixture({ title: 'KB-59 fixture: hostile agent output', type: 'bug', priority: 'high', labels: ['probe'] })
	hostileId = hostileTicket.id
	await pageAction('comment', { ticketId: hostileId, text: HOSTILE_COMMENT })

	const regTicket = await createFixture({ title: 'KB-59 fixture: action regression', type: 'task', priority: 'low', labels: ['probe'] })
	regId = regTicket.id

	const epicTicket = await createFixture({ title: 'KB-59 fixture: EPIC run rejection', type: 'epic', priority: 'low', labels: ['probe'] })
	epicId = epicTicket.id

	await waitFor(`document.querySelector('.kb-card[data-ticket="${mdId}"]')`, 'fixture card ' + mdId)
	await sleep(1200)

	const seedSnap = await rawState()
	const storedMd = ticketById(seedSnap, mdId)
	const storedLong = ticketById(seedSnap, longId)
	const mdComments = storedMd && Array.isArray(storedMd.comments) ? storedMd.comments : []
	record(
		'data/seed',
		'the host stored the real fixtures (comments exact, long comment ~4000 chars, blocked ticket available)',
		Boolean(storedMd) &&
			mdComments.length === 2 &&
			mdComments[0].text === RICH_COMMENT &&
			mdComments[1].text === PLAIN_COMMENT &&
			Boolean(storedLong) &&
			storedLong.comments[0].text === LONG_COMMENT &&
			LONG_COMMENT.length >= 3900 &&
			LONG_COMMENT.length <= 4000 &&
			Boolean(ticketById(seedSnap, blockedId)) &&
			Boolean(ticketById(seedSnap, epicId)) &&
			ticketById(seedSnap, epicId).type === 'epic',
		{
			mdComments: mdComments.map((comment) => comment.text.length),
			longLength: storedLong && storedLong.comments[0] ? storedLong.comments[0].text.length : null,
			fixtures: results.created,
		},
	)
	results.measurements.fixtures = { mdId, longId, doneId, pausedId, blockedId, hostileId, regId, epicId }

	// Install the read-only fixture shim for the agent-only fields. The spec is
	// kept so every shell reload (language switch, 640px evidence pass) restores
	// the same read-only fixture.
	PATCH_SPEC = {
		[mdId]: {
			appendComments: [{ id: 'kb59-fallback', author: '', text: 'Plain fallback comment\nwith a second line.', atOffset: 60000 }],
		},
		[doneId]: { execution: EXECUTION_DONE },
		[pausedId]: { execution: EXECUTION_PAUSED },
		[blockedId]: { blocked: true, blockReason: BLOCK_REASON, block: BLOCK_TICKET_TEXT, execution: { status: 'blocked', role: 'fe-developer', accessMode: 'workspace-write', sessionId: 'session-kb59-blocked', startedAt: 0, updatedAt: 0 } },
		[hostileId]: {
			execution: EXECUTION_HOSTILE,
			blocked: true,
			blockReason: HOSTILE_BLOCK.reason,
			block: HOSTILE_BLOCK,
		},
	}
	await restoreFixtures()

	// -------------------------------------------------------------------
	// AC1 — a Markdown comment renders as markup, newest-first, with author/time
	// -------------------------------------------------------------------

	await openTicket(mdId)
	const commentState = await app.evaluate(COMMENT_STATE)
	results.measurements.comments = commentState
	const rich = commentState && commentState.rows ? commentState.rows[1] : null
	const plain = commentState && commentState.rows ? commentState.rows[0] : null
	const fallback = commentState && commentState.rows ? commentState.rows[2] : null

	record(
		'AC1/render',
		'a comment with a list, fence and link renders as markup, not raw markers',
		Boolean(rich) &&
			rich.hasMarkdown === true &&
			rich.tags.ul === 1 &&
			rich.tags.li === 2 &&
			rich.tags.pre === 1 &&
			rich.tags.code >= 2 &&
			rich.tags.h4 === 1 &&
			rich.text.indexOf('```') === -1 &&
			rich.text.indexOf('](') === -1 &&
			!/^[ \t]*- /m.test(rich.text) &&
			rich.anchors.length === 1 &&
			rich.anchors[0].href === 'https://example.com/spec' &&
			rich.anchors[0].target === '_blank',
		rich && { tags: rich.tags, anchors: rich.anchors, text: rich.text.slice(0, 160) },
	)
	record(
		'AC1/words',
		'every source word survives, including the fenced code contents',
		Boolean(rich) &&
			['Review', 'summary', 'scope', 'First bullet keeps its words', 'Second bullet carries', 'inline code', 'const answer = 42', 'console.log(answer)', 'Read', 'the spec', 'before you reply.'].every(
				(needle) => rich.text.indexOf(needle) !== -1,
			) &&
			String(rich.preText || '').indexOf('const answer = 42') !== -1,
		rich && { missing: ['Review', 'scope', 'const answer = 42', 'console.log(answer)', 'the spec', 'before you reply.'].filter((needle) => (rich.text + ' ' + String(rich.preText || '')).indexOf(needle) === -1) },
	)
	record(
		'AC1/order',
		'comments stay newest-first (the last added comment renders first)',
		Boolean(plain) && plain.text.indexOf('Line one stays on its own line') !== -1,
		plain && { first: plain.text.slice(0, 60), second: rich ? rich.text.slice(0, 60) : null },
	)
	record(
		'AC1/authorTime',
		'the author is comment.author (or the literal agent fallback) and the relative time is present',
		Boolean(plain) && plain.author === 'You' && typeof plain.age === 'string' && plain.age.trim().length > 0 && Boolean(fallback) && fallback.author === 'agent' && String(fallback.age || '').trim().length > 0,
		{ plain: plain && { author: plain.author, age: plain.age }, fallback: fallback && { author: fallback.author, age: fallback.age } },
	)

	// -------------------------------------------------------------------
	// AC2 — a plain multi-line comment keeps one break per source newline
	// -------------------------------------------------------------------

	const sourceLines = PLAIN_COMMENT.split('\n')
	const visibleLines = String(plain ? plain.text : '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
	record(
		'AC2/lineBreaks',
		'a plain multi-line comment keeps one break per source newline and collapses no paragraph',
		Boolean(plain) &&
			plain.hasMarkdown === true &&
			plain.tags.p === 1 &&
			plain.tags.br === sourceLines.length - 1 &&
			visibleLines.length === sourceLines.length &&
			sourceLines.every((line, index) => visibleLines[index] === line),
		plain && { sourceLines, visibleLines, br: plain.tags.br, p: plain.tags.p },
	)

	// Comment-surface evidence: 1024 light/dark and 640 light.
	await scrollToComments()
	await shot('comments-1024-light')
	await setTheme('dark')
	await openTicket(mdId)
	await nextPoll()
	const darkState = await app.evaluate(COMMENT_STATE)
	await scrollToComments()
	await shot('comments-1024-dark')
	await setTheme('light')
	await setViewport(640, 900)
	await openTicket(mdId)
	await nextPoll()
	const narrowState = await app.evaluate(COMMENT_STATE)
	await scrollToComments()
	await shot('comments-640-light')
	await setViewport(1024, 768)
	await sleep(500)
	record(
		'AC1/themes',
		'the comment Markdown renders in dark theme and at 640px, not only at 1024 light',
		Boolean(darkState) && darkState.rows.length === 3 && darkState.rows[1].hasMarkdown === true && darkState.rows[1].tags.li === 2 && Boolean(narrowState) && narrowState.rows[1].hasMarkdown === true && narrowState.rows[1].tags.pre === 1,
		{ darkRows: darkState && darkState.rows.length, narrowRows: narrowState && narrowState.rows.length },
	)

	// -------------------------------------------------------------------
	// AC7 — hostile content in a real comment creates nothing dangerous
	// -------------------------------------------------------------------

	await openTicket(hostileId)
	await nextPoll()
	const hostileCommentState = await app.evaluate(COMMENT_STATE)
	const hostileRow = hostileCommentState && hostileCommentState.rows ? hostileCommentState.rows[0] : null
	record(
		'AC7/comment',
		'hostile comment content creates no script/img node, shows literal text and drops the javascript: link',
		Boolean(hostileRow) &&
			hostileRow.dangerous === 0 &&
			hostileRow.text.indexOf('<script>window.__kb59xss = true</script>') !== -1 &&
			hostileRow.text.indexOf('click') !== -1 &&
			hostileRow.text.indexOf('](javascript') === -1 &&
			hostileRow.anchors.length === 0,
		hostileRow && { dangerous: hostileRow.dangerous, anchors: hostileRow.anchors, text: hostileRow.text },
	)
	record('AC7/noScript', 'no script executed (window.__kb59xss is unset)', (await xssFired()) === false, await xssFired())
	await shot('hostile-1024-light')

	// Hostile report + block reason/questions/needs (agent-only fields via shim).
	const hostileWait = await app.evaluate(WAIT_STATE)
	const hostilePanel = await app.evaluate(PANEL_STATE)
	const hostileDangerous = await app.evaluate(
		`document.querySelectorAll('.kb-waitBox script, .kb-waitBox img, .kb-waitBox iframe, .kb-execReport script, .kb-execReport img, .kb-commentText script, .kb-commentText img').length`,
	)
	record(
		'AC7/agentFields',
		'hostile report/reason/question/need content creates no script/img node',
		hostileDangerous === 0 && Boolean(hostileWait) && Boolean(hostilePanel) && hostilePanel.reports.length === 1 && (await xssFired()) === false,
		{ nodes: hostileDangerous, reports: hostilePanel && hostilePanel.reports.length, xss: await xssFired() },
	)
	record(
		'AC7/literalReason',
		'the hostile block reason shows the raw source as literal text',
		Boolean(hostileWait) && String(hostileWait.reasonText || '').indexOf('<script>window.__kb59xss = true</script>') !== -1,
		hostileWait && String(hostileWait.reasonText || '').slice(0, 120),
	)
	await scrollToComments()
	await shot('hostile-comments-1024-light')

	// -------------------------------------------------------------------
	// AC4 — both report placements render Markdown inside the 120px scroller
	// -------------------------------------------------------------------

	await openTicket(doneId)
	await nextPoll()
	const donePanel = await app.evaluate(PANEL_STATE)
	const doneReport = donePanel && donePanel.reports ? donePanel.reports[0] : null
	const doneButtons = donePanel ? donePanel.buttons : []
	const retryButton = doneButtons.find((button) => /^(Run again|重新执行)$/.test(button.text))
	record(
		'AC4/doneReport',
		'the done-state report renders headings/list/fence inside .kb-execReport',
		Boolean(doneReport) &&
			doneReport.hasMarkdown === true &&
			doneReport.tags.h4 >= 1 &&
			doneReport.tags.h5 >= 1 &&
			doneReport.tags.ul >= 1 &&
			doneReport.tags.li >= 3 &&
			doneReport.tags.pre >= 1 &&
			doneReport.text.indexOf('```') === -1 &&
			doneReport.text.indexOf('- ') === -1,
		doneReport && { tags: doneReport.tags, text: doneReport.text.slice(0, 140) },
	)
	record(
		'AC4/chrome',
		'.kb-execReport keeps its 120px max-height/scroll behaviour and the panel button stays visible, enabled and hit-testable',
		Boolean(doneReport) &&
			doneReport.maxHeight === '120px' &&
			doneReport.overflowY === 'auto' &&
			doneReport.scrollable === true &&
			Boolean(retryButton) &&
			retryButton.visible === true &&
			retryButton.hitTest === true &&
			retryButton.disabled === false,
		{ report: doneReport && { maxHeight: doneReport.maxHeight, overflowY: doneReport.overflowY, scrollable: doneReport.scrollable, scrollHeight: doneReport.scrollHeight, clientHeight: doneReport.clientHeight }, retry: retryButton },
	)
	record(
		'AC4/noPageScroll',
		'no page scrollbar appears with the report rendered',
		await app.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1 && document.documentElement.scrollHeight <= window.innerHeight + 1'),
		await app.evaluate('({ w: document.documentElement.scrollWidth, iw: window.innerWidth, h: document.documentElement.scrollHeight, ih: window.innerHeight })'),
	)
	await shot('report-done-1024-light')

	await openTicket(pausedId)
	await nextPoll()
	const pausedPanel = await app.evaluate(PANEL_STATE)
	const pausedReport = pausedPanel && pausedPanel.reports ? pausedPanel.reports[0] : null
	const resumeButton = pausedPanel ? pausedPanel.buttons.find((button) => /^(Continue|继续)$/.test(button.text)) : null
	const cancelButton = pausedPanel ? pausedPanel.buttons.find((button) => /^(Cancel run|取消执行)$/.test(button.text)) : null
	record(
		'AC4/nonDoneReport',
		'the non-done panel report renders Markdown above the start controls',
		Boolean(pausedReport) &&
			pausedReport.hasMarkdown === true &&
			pausedReport.tags.h4 >= 1 &&
			pausedReport.tags.li >= 3 &&
			pausedReport.tags.pre >= 1 &&
			pausedReport.maxHeight === '120px' &&
			pausedReport.scrollable === true &&
			Boolean(resumeButton) &&
			resumeButton.visible === true &&
			resumeButton.disabled === false &&
			Boolean(cancelButton) &&
			cancelButton.visible === true &&
			cancelButton.hitTest === true,
		{ report: pausedReport && { tags: pausedReport.tags, maxHeight: pausedReport.maxHeight, scrollable: pausedReport.scrollable }, resume: resumeButton, cancel: cancelButton },
	)
	await shot('report-paused-1024-light')

	// AC10 — the run control dispatches runTicket with the panel's role/access.
	await openTicket(doneId)
	await nextPoll()
	const beforeActions = (await shimActions()).length
	const retryPanel = await app.evaluate(PANEL_STATE)
	const retryTarget = retryPanel && retryPanel.buttons.find((button) => /^(Run again|重新执行)$/.test(button.text))
	await pointerClick(`(() => { const panel = document.querySelector('.kb-execPanel'); const b = panel ? [...panel.querySelectorAll('button')].find((x) => /^(Run again|重新执行)$/.test((x.textContent || '').trim())) : null; return b })()`)
	await sleep(700)
	const afterActions = await shimActions()
	const runAction = afterActions.slice(beforeActions).find((entry) => entry.action === 'runTicket')
	record(
		'AC10/runDispatch',
		'the retry control dispatches runTicket with the ticket, role and access mode (host call intercepted so no agent is spawned)',
		Boolean(runAction) && runAction.payload && runAction.payload.ticketId === doneId && typeof runAction.payload.role === 'string' && runAction.payload.role.length > 0 && typeof runAction.payload.accessMode === 'string',
		runAction && runAction.payload,
	)
	const doneRealTicket = ticketById(await rawState(), doneId)
	record(
		'AC10/runNoSession',
		'the intercepted run left the persisted ticket without an execution',
		!doneRealTicket || !doneRealTicket.execution,
		doneRealTicket && doneRealTicket.execution ? doneRealTicket.execution.status : null,
	)
	// The real host run path still validates and rejects an EPIC without a session.
	const epicRun = await rawAction('runTicket', { ticketId: epicId })
	const epicAfter = ticketById(await rawState(), epicId)
	record(
		'AC10/runHostGuard',
		'the real host run path rejects an EPIC before creating any session',
		epicRun.ok === false && epicAfter && !epicAfter.execution,
		{ status: epicRun.status, code: epicRun.error && epicRun.error.code },
	)

	// AC10 — resume and cancel controls still dispatch.
	await sleep(4200)
	await openTicket(pausedId)
	await nextPoll()
	const resumeBefore = (await shimActions()).length
	await pointerClick(`(() => { const panel = document.querySelector('.kb-execPanel'); const b = panel ? [...panel.querySelectorAll('button')].find((x) => /^(Continue|继续)$/.test((x.textContent || '').trim())) : null; return b })()`)
	await sleep(800)
	const resumeAction = (await shimActions()).slice(resumeBefore).find((entry) => entry.action === 'resumeExecution' || entry.action === 'runTicket')
	record(
		'AC10/resumeDispatch',
		'the Continue control dispatches the resume path',
		Boolean(resumeAction) && resumeAction.payload && resumeAction.payload.ticketId === pausedId,
		resumeAction || null,
	)
	const cancelBefore = (await shimActions()).length
	await pointerClick(`(() => { const panel = document.querySelector('.kb-execPanel'); const b = panel ? [...panel.querySelectorAll('button')].find((x) => /^(Cancel run|取消执行)$/.test((x.textContent || '').trim())) : null; return b })()`)
	await sleep(400)
	await pointerClick(`(() => { const panel = document.querySelector('.kb-execPanel'); const b = panel ? [...panel.querySelectorAll('button')].find((x) => /^(Confirm cancel|确认取消)$/.test((x.textContent || '').trim())) : null; return b })()`)
	await sleep(800)
	const cancelAction = (await shimActions()).slice(cancelBefore).find((entry) => entry.action === 'cancelExecution')
	record('AC10/cancelDispatch', 'the Cancel control dispatches cancelExecution after confirmation', Boolean(cancelAction), cancelAction || null)

	// -------------------------------------------------------------------
	// AC5 + AC6 — the blocked wait box renders Markdown and keeps its controls
	// -------------------------------------------------------------------

	await openTicket(blockedId)
	await nextPoll()
	const waitBefore = await app.evaluate(WAIT_STATE)
	results.measurements.waitbox = waitBefore
	record(
		'AC5/reason',
		'the block reason renders as Markdown inside the wait box and keeps its hint colour',
		Boolean(waitBefore) && waitBefore.hasReasonMarkdown === true && waitBefore.reasonText.indexOf('answer format') !== -1 && waitBefore.reasonText.indexOf('**') === -1 && waitBefore.reasonColor === waitBefore.reasonChildColor,
		waitBefore && { reason: waitBefore.reasonText, reasonColor: waitBefore.reasonColor, child: waitBefore.reasonChildColor },
	)
	record(
		'AC5/questions',
		'every question text renders as Markdown inside its label (list, link, code, heading)',
		Boolean(waitBefore) &&
			waitBefore.questions.length === 2 &&
			waitBefore.questions[0].hasMarkdown === true &&
			waitBefore.questions[0].tags.h4 === 1 &&
			waitBefore.questions[0].tags.li === 2 &&
			waitBefore.questions[0].tags.pre === 0 &&
			waitBefore.questions[0].tags.code >= 3 &&
			waitBefore.questions[0].markdownText.indexOf('```') === -1 &&
			waitBefore.questions[0].markdownText.indexOf('](') === -1 &&
			waitBefore.questions[1].hasMarkdown === true &&
			waitBefore.questions[1].markdownText.indexOf('**') === -1,
		waitBefore && waitBefore.questions.map((question) => ({ tags: question.tags, text: question.markdownText })),
	)
	record(
		'AC5/needs',
		'every need text renders as Markdown beside its grant checkbox and kind',
		Boolean(waitBefore) &&
			waitBefore.needs.length === 2 &&
			waitBefore.needs.every((need) => need.hasMarkdown === true && need.hasCheckbox === true && need.checked === false) &&
			waitBefore.needs[0].markdownText.indexOf('write') !== -1 &&
			waitBefore.needs[0].markdownText.indexOf('**') === -1 &&
			waitBefore.needs[1].markdownText.indexOf('the plan') !== -1 &&
			waitBefore.needs[1].kind.length > 0,
		waitBefore && waitBefore.needs,
	)
	record(
		'AC5/inputsUnchanged',
		'the per-question answer input and per-need checkbox markup is unchanged (no extra span, label wrapper kept)',
		Boolean(waitBefore) &&
			waitBefore.questions.length === 2 &&
			waitBefore.questions.every((question) => question.hasSpan === false && question.placeholder === 'Your answer…') &&
			waitBefore.needs.length === 2 &&
			waitBefore.sendLabel === 'Send answers & resume',
		waitBefore && { questions: waitBefore.questions.map((question) => ({ hasSpan: question.hasSpan, placeholder: question.placeholder })), send: waitBefore.sendLabel },
	)
	record(
		'AC5/sendDisabledEmpty',
		'Send answers is disabled until an answer or a grant exists',
		Boolean(waitBefore) && waitBefore.sendDisabled === true,
		waitBefore && waitBefore.sendDisabled,
	)
	await shot('waitbox-1024-light')

	// AC6 — the answer input's accessible name is the plain projection.
	const q1 = waitBefore && waitBefore.questions[0]
	const q2 = waitBefore && waitBefore.questions[1]
	record(
		'AC6/plainLabel',
		'the answer input aria-label is the plain projection: markers stripped, link label kept without URL, code text kept, one line',
		Boolean(q1) &&
			q1.ariaLabel === Q1_PLAIN_LABEL &&
			hasMarkers(q1.ariaLabel) === false &&
			hasUrlLeak(q1.ariaLabel) === false &&
			q1.ariaLabel.split('\n').length === 1 &&
			Boolean(q2) &&
			q2.ariaLabel === 'Should I keep the plain fallback for old clients?' &&
			hasMarkers(q2.ariaLabel) === false &&
			q2.ariaLabel.length > 20,
		{ q1: q1 && q1.ariaLabel, expected: Q1_PLAIN_LABEL, q2: q2 && q2.ariaLabel },
	)
	record(
		'AC6/labelAssociation',
		'the visible question and its <label> association are unchanged (input still inside the same label)',
		Boolean(q1) && q1.hasMarkdown === true && q1.markdownText.indexOf('Which scope do you approve?') !== -1,
		q1 && { markdown: q1.markdownText.slice(0, 80) },
	)

	// Keyboard path: the rendered code block is reachable/scrollable, the answer
	// inputs keep their DOM order and the focused input shows its focus ring.
	const keyboard = await app.evaluate(`(() => {
		const inputs = [...document.querySelectorAll('.kb-waitBox label.kb-waitQ input.kb-input')];
		if (inputs.length < 2) return null;
		const unfocusedBorder = getComputedStyle(inputs[0]).borderColor;
		inputs[0].focus();
		return { focused: document.activeElement === inputs[0], unfocusedBorder };
	})()`)
	await app.key('Tab')
	await sleep(300)
	const afterTab = await app.evaluate(`(() => {
		const inputs = [...document.querySelectorAll('.kb-waitBox label.kb-waitQ input.kb-input')];
		const active = document.activeElement;
		return {
			second: active === inputs[1],
			focusedBorder: inputs[0] ? getComputedStyle(inputs[0]).borderColor : null,
			activeBorder: active ? getComputedStyle(active).borderColor : null,
		};
	})()`)
	record(
		'AC6/keyboard',
		'the rendered code block is keyboard-reachable, Tab moves from the first to the second answer input and the focused input shows its focus border',
		Boolean(keyboard) &&
			keyboard.focused === true &&
			(waitBefore ? waitBefore.reasonPreTabIndex === 0 : false) &&
			(waitBefore ? waitBefore.reasonPreAriaLabel === 'Code block' : false) &&
			afterTab.second === true &&
			afterTab.focusedBorder !== afterTab.activeBorder,
		{ keyboard, afterTab, preTabIndex: waitBefore && waitBefore.reasonPreTabIndex },
	)

	// Answer input + grant + Send enable/disable rules, including the pending state.
	await app.type(`document.querySelector('.kb-waitBox label.kb-waitQ input.kb-input')`, 'yes')
	await sleep(300)
	const waitAnswered = await app.evaluate(WAIT_STATE)
	record('AC5/sendEnabledAnswer', 'typing an answer enables Send answers', waitAnswered && waitAnswered.sendDisabled === false, waitAnswered && waitAnswered.sendDisabled)

	await app.evaluate(`(() => { const box = document.querySelector('.kb-waitBox'); const input = box ? box.querySelector('label.kb-waitQ input.kb-input') : null; if (input) { const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); } return true })()`)
	await sleep(250)
	await pointerClick(`(() => { const box = document.querySelector('.kb-waitBox'); const need = box ? box.querySelector('label.kb-waitNeed input[type="checkbox"]') : null; return need })()`)
	await sleep(300)
	const waitGranted = await app.evaluate(WAIT_STATE)
	record(
		'AC5/sendEnabledGrant',
		'granting a need enables Send answers and checks exactly that checkbox',
		Boolean(waitGranted) && waitGranted.sendDisabled === false && waitGranted.needs[0].checked === true && waitGranted.needs[1].checked === false,
		waitGranted && { send: waitGranted.sendDisabled, needs: waitGranted.needs.map((need) => need.checked) },
	)

	await app.type(`document.querySelector('.kb-waitBox label.kb-waitQ input.kb-input')`, 'yes')
	await sleep(300)
	await setHoldAnswer(1800)
	const answerBefore = (await shimActions()).length
	await pointerClick(`(() => { const box = document.querySelector('.kb-waitBox'); const b = box ? [...box.querySelectorAll('button')].find((x) => (x.textContent || '').trim().length > 0) : null; return b })()`)
	await sleep(400)
	const waitPending = await app.evaluate(WAIT_STATE)
	record(
		'AC5/sendPending',
		'Send answers is disabled while the answer action is pending',
		Boolean(waitPending) && waitPending.sendDisabled === true,
		waitPending && waitPending.sendDisabled,
	)
	await sleep(2200)
	const answerActions = (await shimActions()).slice(answerBefore)
	const answerAction = answerActions.find((entry) => entry.action === 'answerTicket')
	record(
		'AC10/answerDispatch',
		'the Send control dispatches answerTicket with the typed answers and granted needs',
		Boolean(answerAction) &&
			answerAction.payload &&
			answerAction.payload.ticketId === blockedId &&
			Array.isArray(answerAction.payload.answers) &&
			answerAction.payload.answers[0] === 'yes' &&
			Array.isArray(answerAction.payload.grant) &&
			answerAction.payload.grant.length === 1 &&
			answerAction.payload.grant[0].indexOf('Grant') !== -1,
		answerAction && answerAction.payload,
	)
	await setHoldAnswer(0)
	const answerResult = answerActions.find((entry) => entry.action === 'answerTicket')
	results.measurements.answerDispatch = answerResult || null

	// -------------------------------------------------------------------
	// AC3 — 4,000-character comment at 1024 and 640
	// -------------------------------------------------------------------

	for (const width of [1024, 640]) {
		await closeDrawer()
		await setViewport(width, width === 640 ? 900 : 768)
		if (width === 640) {
			// A headless Chrome live resize can leave the drawer painting a stale
			// frame; reload at the target width so the evidence is a real 640px paint.
			await reloadShell()
			await openPanel()
			await restoreFixtures()
		}
		await openTicket(longId)
		await nextPoll()
		const measure = await app.evaluate(MEASURE)
		results.measurements['longComment' + width] = measure
		record(
			`AC3/scroll${width}`,
			`at ${width}px only .kb-drawerBody scrolls, the code block scrolls inside itself and nothing overflows horizontally`,
			Boolean(measure) &&
				measure.bodyScrollable === true &&
				measure.bodyScrollWidth <= measure.bodyClientWidth + 1 &&
				measure.drawerScrollWidth <= measure.drawerClientWidth + 1 &&
				measure.pageHorizontalOverflow === false &&
				measure.pageVerticalOverflow === false &&
				Boolean(measure.commentPre) &&
				measure.commentPre.scrollable === true &&
				measure.commentPre.overflowX === 'auto',
			measure && {
				body: { client: measure.bodyClientWidth, scroll: measure.bodyScrollWidth, scrollable: measure.bodyScrollable },
				drawer: { client: measure.drawerClientWidth, scroll: measure.drawerScrollWidth },
				page: { overflowX: measure.pageHorizontalOverflow, overflowY: measure.pageVerticalOverflow },
				pre: measure.commentPre,
			},
		)
		await scrollToComments()
		await shot(`long-comment-${width}-light`)
		// Scroll the body to the composer and prove the submit button is clickable.
		await app.evaluate(`(() => { const body = document.querySelector('.kb-drawerBody'); body.scrollTop = body.scrollHeight; return body.scrollTop })()`)
		await sleep(500)
		const scrolled = await app.evaluate(MEASURE)
		record(
			`AC3/composer${width}`,
			`at ${width}px the composer is reachable by scrolling the body and its submit button is hit-testable`,
			Boolean(scrolled) && scrolled.composerInputVisible === true && Boolean(scrolled.composerHit) && scrolled.composerHit.hitTest === true && scrolled.composerHit.rect.width > 0,
			scrolled && { input: scrolled.composerInputVisible, button: scrolled.composerHit },
		)
	}

	// Back to the base viewport with a clean paint and the same read-only fixture.
	await closeDrawer()
	await setViewport(1024, 768)
	await reloadShell()
	await openPanel()
	await restoreFixtures()

	// AC10 — adding a comment through the real composer still works.
	await openTicket(longId)
	await nextPoll()
	await app.evaluate(`(() => { const body = document.querySelector('.kb-drawerBody'); body.scrollTop = body.scrollHeight; return true })()`)
	await sleep(400)
	await app.type(
		`(() => { const section = [...document.querySelectorAll('.kb-drawer .kb-section')].find((s) => { const title = s.querySelector('.kb-sectionTitle'); return title && /^(Comments|评论)$/.test((title.textContent || '').trim()) }); return section ? section.querySelector('.kb-inlineAdd .kb-input') : null })()`,
		'Probe added comment with `code` and a [link](https://example.com/probe).',
	)
	await sleep(300)
	const composerBefore = (await shimActions()).length
	await pointerClick(
		`(() => { const section = [...document.querySelectorAll('.kb-drawer .kb-section')].find((s) => { const title = s.querySelector('.kb-sectionTitle'); return title && /^(Comments|评论)$/.test((title.textContent || '').trim()) }); return section ? section.querySelector('.kb-inlineAdd button') : null })()`,
	)
	await sleep(1200)
	const commentAction = (await shimActions()).slice(composerBefore).find((entry) => entry.action === 'comment')
	const composedTicket = ticketById(await rawState(), longId)
	const addedComment = composedTicket && Array.isArray(composedTicket.comments) ? composedTicket.comments[composedTicket.comments.length - 1] : null
	record(
		'AC10/commentWorks',
		'adding a comment through the real composer persists it and the new comment renders as Markdown',
		Boolean(commentAction) && Boolean(addedComment) && addedComment.text.indexOf('Probe added comment') !== -1,
		{ action: commentAction && commentAction.payload, stored: addedComment && addedComment.text.slice(0, 60) },
	)
	await nextPoll()
	const afterComment = await app.evaluate(COMMENT_STATE)
	record(
		'AC10/newCommentRenders',
		'the newly added comment renders through the same Markdown surface',
		Boolean(afterComment) && afterComment.rows.some((row) => row.hasMarkdown === true && row.text.indexOf('Probe added comment') !== -1),
		afterComment && afterComment.rows.map((row) => row.text.slice(0, 40)),
	)

	// -------------------------------------------------------------------
	// AC8 — a poll keeps scrollTop and the comment DOM nodes
	// -------------------------------------------------------------------

	await openTicket(longId)
	await nextPoll()
	await app.evaluate(`(() => { const body = document.querySelector('.kb-drawerBody'); body.scrollTop = 160; window.__kb59nodes = [...document.querySelectorAll('.kb-comment')]; return body.scrollTop })()`)
	await sleep(300)
	const scrollBefore = await app.evaluate(`(() => { const body = document.querySelector('.kb-drawerBody'); return { top: body.scrollTop, nodes: window.__kb59nodes.length } })()`)
	const hitsBefore = await shimStateHits()
	let polled = false
	for (let attempt = 0; attempt < 20; attempt += 1) {
		await sleep(300)
		if ((await shimStateHits()) > hitsBefore) {
			polled = true
			break
		}
	}
	await sleep(300)
	const scrollAfter = await app.evaluate(`(() => {
		const body = document.querySelector('.kb-drawerBody');
		const current = [...document.querySelectorAll('.kb-comment')];
		return {
			top: body.scrollTop,
			same: current.length === window.__kb59nodes.length && current.every((node, index) => node === window.__kb59nodes[index]),
			count: current.length,
		};
	})()`)
	results.measurements.poll = { before: scrollBefore, after: scrollAfter, polled }
	record(
		'AC8/scrollPreserved',
		'a 2.5s poll keeps .kb-drawerBody scrollTop and the same comment DOM nodes (memoized MarkdownBody, no re-mount)',
		polled === true && scrollAfter.top === scrollBefore.top && scrollAfter.same === true && scrollBefore.top > 0,
		{ before: scrollBefore, after: scrollAfter, polled },
	)

	// -------------------------------------------------------------------
	// AC9 — zh renders the surfaces and the touched aria label follows the locale
	// -------------------------------------------------------------------

	const enPreLabel = waitBefore ? waitBefore.reasonPreAriaLabel : null
	const enCodeBlockLabel = 'Code block'
	const zhSwitched = await setLanguage('中文')
	// The language switch reloads the shell, so re-install the read-only fixture.
	await restoreFixtures()
	await waitFor(`document.querySelector('.kb-card[data-ticket="${blockedId}"]')`, 'zh fixture card ' + blockedId)
	await openTicket(blockedId)
	await nextPoll()
	const zhWait = await app.evaluate(WAIT_STATE)
	results.measurements.waitboxZh = zhWait
	record(
		'AC9/zh',
		'in zh the wait box renders the same Markdown, the answer aria-label stays the source projection and only the <pre> label is localized',
		zhSwitched === true &&
			(await panelTitle()) === '看板' &&
			Boolean(zhWait) &&
			zhWait.hasReasonMarkdown === true &&
			zhWait.questions.length === 2 &&
			zhWait.questions[0].hasMarkdown === true &&
			zhWait.questions[0].ariaLabel === Q1_PLAIN_LABEL &&
			zhWait.sendLabel === '发送回答并恢复' &&
			enPreLabel === enCodeBlockLabel &&
			zhWait.reasonPreAriaLabel === '代码块',
		zhWait && { send: zhWait.sendLabel, aria: zhWait.questions.map((question) => question.ariaLabel), preLabel: zhWait.reasonPreAriaLabel, enPreLabel, enCodeBlockLabel },
	)
	await shot('waitbox-1024-zh')
	// Switch back so the rest of the run (and the user's shell) is English again.
	const backToEnglish = await setLanguage('English')
	await restoreFixtures()
	record('AC9/englishRestored', 'the shell is restored to English', backToEnglish === true && (await panelTitle()) === 'Kanban', await panelTitle())

	// -------------------------------------------------------------------
	// AC10 — block / unblock through the real host action
	// -------------------------------------------------------------------

	await openTicket(regId)
	await nextPoll()
	const blockResult = await pageAction('blockTicket', { ticketId: regId, blocked: true, reason: 'Waiting on the **design** answer' })
	await nextPoll()
	const regTicketBlocked = ticketById(await rawState(), regId)
	const blockedDrawer = await app.evaluate(
		`(() => { const el = document.querySelector('.kb-drawer .kb-blockReasonText'); return el ? String(el.textContent || '').trim() : null })()`,
	)
	record(
		'AC10/block',
		'blocking a ticket through the host action persists the reason and the drawer reflects the blocked state',
		blockResult.ok === true && Boolean(regTicketBlocked) && regTicketBlocked.blocked === true && regTicketBlocked.blockReason === 'Waiting on the **design** answer' && blockedDrawer === 'Waiting on the **design** answer',
		{ ok: blockResult.ok, stored: regTicketBlocked && { blocked: regTicketBlocked.blocked, reason: regTicketBlocked.blockReason }, drawer: blockedDrawer },
	)
	const unblockResult = await pageAction('blockTicket', { ticketId: regId, blocked: false, reason: '' })
	await nextPoll()
	const regTicketUnblocked = ticketById(await rawState(), regId)
	record(
		'AC10/unblock',
		'unblocking clears the blocked flag',
		unblockResult.ok === true && Boolean(regTicketUnblocked) && regTicketUnblocked.blocked === false,
		regTicketUnblocked && regTicketUnblocked.blocked,
	)

	// Console hygiene: no uncaught exceptions or console errors from the render path.
	const errors = await app.errors()
	// Ignored and listed explicitly: the probe's own rejected answer/resume/cancel
	// round-trips, its intercepted runTicket, and the shell's DeepSeek-account
	// plugin error, which the headless probe session raises before any Kanban
	// surface renders and which this diff does not touch.
	const ignoredPattern = /deepseek-account|probe\/intercepted|HTTP 40[49]|no execution|not waiting for an answer|intercepted/i
	const relevant = errors.filter((entry) => !ignoredPattern.test(String(entry.text || '')))
	results.console = errors
	results.measurements.consoleIgnoreList = errors.filter((entry) => ignoredPattern.test(String(entry.text || ''))).map((entry) => String(entry.text || '').slice(0, 120))
	record('console/clean', 'the render path produced no unexpected console error or exception', relevant.length === 0, relevant.slice(0, 5))
} catch (error) {
	record('probe/completed', 'the probe ran to completion', false, String((error && error.message) || error))
} finally {
	// -------------------------------------------------------------------
	// Cleanup: remove the shim, delete fixtures, restore language/theme/count
	// -------------------------------------------------------------------

	try {
		await removeShim()
		const themeRestored = await setTheme('light')
		results.cleanup.push({ step: 'theme', themeRestored })
		await setViewport(1024, 768)
		await closeDrawer()
		const stateBeforeCleanup = await rawState()
		if (stateBeforeCleanup.board && stateBeforeCleanup.board.paused === true) {
			const resumed = await pageAction('resumeBoard')
			results.cleanup.push({ step: 'resume', status: resumed.status, ok: resumed.ok })
		}
		// The EPIC goes last; children would go before their parent (none here).
		for (const id of [epicId, regId, hostileId, blockedId, pausedId, doneId, longId, mdId]) {
			if (!id) continue
			const deleted = await pageAction('deleteTicket', { ticketId: id })
			results.cleanup.push({ step: 'delete', id, status: deleted.status, ok: deleted.ok })
		}
		await sleep(1200)
		const finalSnap = await rawState()
		const tickets = finalSnap.board && Array.isArray(finalSnap.board.tickets) ? finalSnap.board.tickets : []
		const remainingFixtures = tickets.filter((ticket) => results.created.indexOf(ticket.id) !== -1)
		const finalCount = tickets.length
		record(
			'cleanup/deleted',
			'the probe fixtures are deleted and the board ticket count is restored',
			remainingFixtures.length === 0 && finalCount === preProbeCount,
			{ remaining: remainingFixtures.map((ticket) => ticket.id), finalCount, preProbeCount },
		)
		results.cleanup.push({ step: 'count', finalCount, preProbeCount })

		try {
			const titleNow = await panelTitle()
			if (titleNow !== null && titleNow !== 'Kanban') {
				await setLanguage('English')
				results.cleanup.push({ step: 'language', restored: await panelTitle() })
			}
		} catch {
			results.cleanup.push({ step: 'language', restored: 'failed' })
		}

		if (originalWorkspaceId && originalWorkspaceId !== scratch.id) {
			await app.evaluate(`(() => { window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(originalWorkspaceId)}); return true })()`)
			workspaceId = originalWorkspaceId
			await reloadShell()
			await openPanel()
			await sleep(500)
			const restoredTitle = await clientProjectTitle()
			results.cleanup.push({ step: 'workspace', restoredTitle })
			record('cleanup/workspaceRestored', 'the previously selected workspace is restored', restoredTitle === (bootSnap.project && bootSnap.project.title), {
				restoredTitle,
				expected: bootSnap.project && bootSnap.project.title,
			})
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
	results.meta.cleanupDone = cleanupDone
	await mkdir(OUT, { recursive: true })
	await writeFile(new URL(PROJECT_FILE, import.meta.url), JSON.stringify(results, null, 1))
	console.log(`\n${failures === 0 ? 'ALL KB-59 PROBE CHECKS PASSED' : `${failures} PROBE FAILURE(S)`} — ${results.checks.length} checks, ${results.screenshots.length} screenshots`)
	process.exit(failures === 0 ? 0 : 1)
}
