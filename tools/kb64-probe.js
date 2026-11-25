/**
 * KB-64 cross-surface verification probe — one run proves the Epic surfaces render
 * together as one system: ticket drawer read mode, Edit/Preview, Markdown comments,
 * hostile HTML rendered literally, Thoughts collapsed/expanded, and scan vision —
 * at 1440x900 / 1024x768 / 640x900, in light and dark, in en and zh, on a clean
 * console, with one machine-readable evidence pack.
 *
 * Drives the real DSH Web GUI headlessly (see tools/README.md) by attaching to the
 * already-running Chrome over CDP (`$DSH_CDP_PORT`, default 9333) and the current
 * GUI URL (`$DSH_WEB_URL`; there is no stale localhost fallback). Dependency-free:
 * Node built-ins plus `tools/cdp.mjs`; no npm install.
 *
 * Board discipline (kb5/kb58/kb59 convention): the probe runs on the
 * `default-workspace` scratch board, never the project board. It creates temporary
 * fixtures through `/kanban/action`, deletes them through the drawer (and sweeps
 * survivors in `finally`), asserts the ticket/thought/member counts are identical
 * before and after, and restores the previously selected workspace, theme and
 * language. It never calls `submitThought`, `run` or `resume`, so no agent session
 * is spawned.
 *
 * Fixture sources (recorded in `fixtures[]` and `notDriven[]`):
 *   - main/hostile/empty/EPIC tickets + comments are real host records (createTicket/comment).
 *   - `thoughts` rows and the `scan` vision come from a read-only window.fetch shim:
 *     the scratch project contains zero scan docs, so a live scan returns vision:null.
 *     The real Thoughts drawer and the real scan drawer are driven; only their response
 *     data is fulfilled. The shim is removed before cleanup.
 *
 * Evidence: docs/screenshots/kb64/final-verification.json plus labelled PNGs
 * named `{surface}-{width}-{theme}.png` (zh captures add `-zh`).
 *
 * Usage (Chrome on CDP 9333, GUI URL exported):
 *   DSH_WEB_URL=http://127.0.0.1:<port> node tools/kb64-probe.js
 *   node tools/kb64-probe.js --runs=1          # single suite (determinism not compared)
 *   node tools/kb64-probe.js --runs=2          # default: two consecutive runs must pass identically
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { attach } from './cdp.mjs'

const execFileAsync = promisify(execFile)
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OUT_DIR = join(REPO, 'docs', 'screenshots', 'kb64')
const OUT_JSON = join(OUT_DIR, 'final-verification.json')
const OUT_MARKER = join(OUT_DIR, '.probe-incomplete.json')

const PROBE_PROJECT = 'default-workspace'
const APP_URL = (process.env.DSH_WEB_URL || '').trim()
const CDP_PORT = Number(process.env.DSH_CDP_PORT || 9333)
const RUNS_REQUESTED = (() => {
	const arg = process.argv.slice(2).find((value) => value.startsWith('--runs='))
	if (!arg) return 2
	const value = Number(arg.split('=')[1])
	return Number.isFinite(value) && value >= 1 ? Math.min(5, Math.floor(value)) : 2
})()

const WIDTHS = [1440, 1024, 640]
const VIEWPORT_HEIGHTS = { 1440: 900, 1024: 768, 640: 900 }
const THEMES = ['light', 'dark']
const SURFACES = ['read', 'edit', 'comments', 'hostile', 'thoughts-collapsed', 'thoughts-expanded', 'scan-vision']
const LANGS = ['en', 'zh']

const EXPECTED_KEYS = {
	'detail.descriptionMode': { en: 'Description view', zh: '描述视图' },
	'detail.edit': { en: 'Edit', zh: '编辑' },
	'detail.preview': { en: 'Preview', zh: '预览' },
	'detail.descriptionEmpty': {
		en: 'No description yet — use Edit to add context, acceptance criteria, and links.',
		zh: '暂无描述 — 使用“编辑”添加背景、验收标准与链接。',
	},
	'detail.epicPrdEmpty': {
		en: 'No EPIC PRD yet — use Edit to write the outcome, scope, acceptance criteria, and decomposition plan.',
		zh: '暂无史诗 PRD — 使用“编辑”撰写成果、范围、验收标准与拆解计划。',
	},
	'md.codeBlock': { en: 'Code block', zh: '代码块' },
	'md.table': { en: 'Table', zh: '表格' },
	'md.linkExternal': { en: 'opens in a new tab', zh: '在新标签页打开' },
	'header.thoughts': { en: 'Thoughts', zh: '想法' },
	'thought.empty': { en: 'No thoughts yet. Press Speak a thought to capture one.', zh: '还没有想法。点击“说出想法”记录一个。' },
	'thought.count': { en: '1 thoughts', zh: '1 个想法' },
	'thought.expand': { en: 'Expand', zh: '展开' },
	'thought.collapse': { en: 'Collapse', zh: '收起' },
	'scan.title': { en: 'Project scan', zh: '项目扫描' },
	'scan.vision': { en: 'Product vision', zh: '产品愿景' },
}

const FORBIDDEN_ACTIONS = new Set(['submitThought', 'run', 'resume'])
const MUTATING_ACTIONS = new Set(['createTicket', 'updateTicket', 'deleteTicket', 'comment', 'resumeBoard', 'pauseBoard', 'scan'])

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const shortJson = (value, limit = 700) => {
	try {
		const text = typeof value === 'string' ? value : JSON.stringify(value)
		return text.length > limit ? text.slice(0, limit) + '…' : text
	} catch {
		return String(value)
	}
}

function buildPrd(label) {
	return [
		'# ' + label,
		'',
		'A **PRD-shaped** fixture with `inline code`, a [probe link](https://example.com/kb64), and *emphasis*.',
		'',
		'## Acceptance criteria',
		'',
		'- Read mode renders Markdown without literal markers.',
		'- Edit persists the shown draft exactly.',
		'- Comments render Markdown through the shared engine.',
		'',
		'### Decomposition',
		'',
		'1. Capture read mode.',
		'2. Capture edit mode.',
		'3. Capture comments.',
		'',
		'```js',
		"const longLine = 'kb64-" + 'code-'.repeat(40) + "end';",
		'```',
		'',
		'| Surface | Width | Theme | kb64-header-' + 'token-'.repeat(18) + ' |',
		'| --- | --- | --- | --- |',
		'| read | 1440 | light | ok |',
		'| edit | 1024 | dark | ok |',
		'',
	].join('\n')
}

const MAIN_SOURCE = buildPrd('Cross-surface read view')
const DRAFT_SOURCE = buildPrd('Edited draft heading')
const COMMENT_SOURCE = [
	'## Comment fixture',
	'',
	'- rendered list item one',
	'- rendered list item two',
	'',
	'```text',
	'comment fence line',
	'```',
	'',
	'[Comment link](https://example.com/kb64#comments)',
	'',
].join('\n')
const HOSTILE_SOURCE = [
	'### Hostile fixture',
	'',
	'<script>window.__kb64xss = true</script>',
	'',
	'<img src=x onerror="window.__kb64xss = true">',
	'',
	'<iframe src="javascript:window.__kb64xss = true"></iframe>',
	'',
	'[click me](javascript:alert(1))',
	'',
].join('\n')
const HOSTILE_COMMENT = [
	'## Hostile comment',
	'',
	'<script>window.__kb64xss = true</script>',
	'',
	'- <img src=x onerror="window.__kb64xss = true">',
	'- [click me](javascript:alert(1))',
	'',
].join('\n')

const THOUGHT_FIXTURE = {
	id: 'TH-KB64',
	status: 'recorded',
	text: [
		'### Probe thought fixture',
		'',
		'A **read-only** thought injected through the KB-59 fetch shim.',
		'',
		'- collapsed rows clamp to three lines',
		'- expanded rows render the shared Markdown engine',
		'',
		'```text',
		'kb64-thought-fence',
		'```',
	].join('\n'),
	ticketIds: ['KB-1'],
	audit: [
		{ at: Date.now() - 180000, type: 'status', to: 'recorded' },
		{ at: Date.now() - 60000, type: 'ticket', ticketId: 'KB-1' },
	],
	createdAt: Date.now() - 180000,
	updatedAt: Date.now() - 60000,
	fixtureSource: 'fetch-shim',
}

const SCAN_FIXTURE = {
	generatedAt: Date.now(),
	projectPath: 'kb64-fixture',
	vision: [
		'### Product vision',
		'',
		'One **shared** board for every project, with a strict workflow every agent follows.',
		'',
		'- ship small slices',
		'- prove every criterion with evidence',
		'',
		'[Probe docs](https://example.com/kb64)',
	].join('\n'),
	docs: [{ path: 'docs/SHARED_BUILD_SPEC.md', title: 'Shared build spec', kind: 'vision', excerpt: 'fixture' }],
	conversations: [],
	mrs: [],
	candidates: [],
}

// ---------------------------------------------------------------------------
// Evidence skeleton
// ---------------------------------------------------------------------------

const PROCESS_STARTED = new Date()
const evidence = {
	ticket: 'KB-64',
	url: APP_URL || null,
	build: null,
	widths: WIDTHS,
	viewports: WIDTHS.map((width) => ({ width, height: VIEWPORT_HEIGHTS[width] })),
	themes: THEMES,
	languages: LANGS,
	runs: [],
	determinism: null,
	checks: [],
	timings: { startedAt: PROCESS_STARTED.toISOString(), finishedAt: null, durationMs: null },
	console: { errors: [], warnings: [], unhandledRejections: [] },
	board: {
		probeProject: PROBE_PROJECT,
		probeWorkspaceId: null,
		before: null,
		after: null,
		projectBefore: null,
		projectAfter: null,
		fixtureIds: {},
		actions: [],
		startupSweep: null,
		cleanupDone: false,
		restored: null,
	},
	screenshots: [],
	measurements: [],
	notDriven: [],
	fixtures: [],
	failures: [],
	consistency: null,
}

let app = null
let chromeVersion = null
const processFailures = []
const runs = []

function record(run, id, name, pass, detail) {
	const entry = { id, name, pass: pass === true, detail: detail === undefined ? null : detail }
	run.checks.push(entry)
	console.log(`${entry.pass ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${shortJson(detail)}`}`)
	return entry
}

async function shot(name) {
	await dismissAppModals()
	await clearToasts()
	await mkdir(OUT_DIR, { recursive: true })
	const path = join(OUT_DIR, name)
	await app.screenshot(path)
	let bytes = 0
	try {
		bytes = (await stat(path)).size
	} catch {
		bytes = 0
	}
	return { path: relative(REPO, path), bytes, name }
}

// ---------------------------------------------------------------------------
// Environment preflight (AC1): actionable messages, never a stack trace
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, timeoutMs) {
	return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
}

async function checkEnvironment() {
	if (!APP_URL) {
		processFailures.push({
			surface: 'environment',
			expected: '$DSH_WEB_URL is set to the running GUI URL',
			actual: 'unset',
			screenshot: null,
			message:
				'DSH_WEB_URL is not set. Export the current DeepSeek Harness Web GUI URL (the address in the browser, e.g. http://127.0.0.1:<port>) and re-run: DSH_WEB_URL=http://127.0.0.1:<port> node tools/kb64-probe.js',
		})
	}
	if (APP_URL) {
		try {
			const parsed = new URL(APP_URL)
			if (!/^https?:$/.test(parsed.protocol)) throw new Error('not an http(s) URL')
		} catch {
			processFailures.push({
				surface: 'environment',
				expected: '$DSH_WEB_URL is a valid http(s) URL',
				actual: APP_URL,
				screenshot: null,
				message: `DSH_WEB_URL is not a valid URL: ${APP_URL}. Export the current GUI URL, e.g. DSH_WEB_URL=http://127.0.0.1:<port>.`,
			})
		}
	}
	try {
		const response = await fetchWithTimeout(`http://127.0.0.1:${CDP_PORT}/json/version`, 4000)
		if (!response.ok) throw new Error(`HTTP ${response.status}`)
		const version = await response.json()
		chromeVersion = version.Browser || 'unknown Chrome'
	} catch (error) {
		processFailures.push({
			surface: 'environment',
			expected: `a Chrome DevTools endpoint at http://127.0.0.1:${CDP_PORT}/json/version`,
			actual: String((error && error.message) || error),
			screenshot: null,
			message: `No headless Chrome answers on CDP port ${CDP_PORT}. Launch Chrome with --remote-debugging-port=${CDP_PORT} (see tools/README.md) or set DSH_CDP_PORT to the running debugger port, then re-run.`,
		})
	}
	return processFailures.length === 0
}

/** AC1: the probe itself imports only Node built-ins and ./cdp.mjs (no npm install). */
async function probeImportCheck() {
	const source = await readFile(new URL(import.meta.url), 'utf8')
	const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
	const foreign = specifiers.filter((specifier) => !specifier.startsWith('node:') && specifier !== './cdp.mjs')
	return { specifiers, foreign }
}

// ---------------------------------------------------------------------------
// Page helpers (kb58/kb59 conventions)
// ---------------------------------------------------------------------------

async function setViewport(width, height) {
	const box = { width, height: height || VIEWPORT_HEIGHTS[width] || 900 }
	await app.cdp.send('Emulation.setDeviceMetricsOverride', { ...box, deviceScaleFactor: 1, mobile: false })
	await sleep(550)
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
		if (!closed) return false
		await sleep(250)
	}
	return (await app.evaluate('document.querySelectorAll(".kb-toast").length')) === 0
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
	throw new Error('could not open the Kanban panel (sidebar Kanban button not found)')
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

async function installErrorCapture() {
	await app.evaluate(`(() => {
		if (window.__kb64errors) return true;
		const box = { errors: [], rejections: [] };
		window.__kb64errors = box;
		window.addEventListener('error', (event) => box.errors.push(String((event && event.message) || 'error')));
		window.addEventListener('unhandledrejection', (event) => box.rejections.push(String((event.reason && event.reason.message) || event.reason || 'rejection')));
		return true;
	})()`)
}

async function dismissStrayTargets() {
	try {
		const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
		const pages = list.filter((target) => target.type === 'page')
		const keep = pages.find((target) => typeof target.url === 'string' && target.url.startsWith('http://127.0.0.1')) || pages[0] || null
		for (const page of pages) {
			if (page === keep) continue
			await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${page.id}`).catch(() => {})
		}
	} catch {
		// CDP unavailable: attach() reports it.
	}
}

const clientProjectTitle = () => app.evaluate('(() => { const el = document.querySelector(".kb-projectName"); return el ? (el.textContent || "").trim() : null })()')
const panelTitle = () => app.evaluate('(() => { const el = document.querySelector(".kb-root .kb-title"); return el ? (el.textContent || "").trim() : null })()')

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

/** Select a workspace through the persisted key + shell reload (kb58 convention). */
async function selectWorkspace(workspaceId) {
	await app.evaluate(`(() => { window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(workspaceId)}); return true })()`)
	await reloadShell()
	await installErrorCapture()
	await openPanel()
	await sleep(500)
	return true
}

// --- language switching (kb3/kb5/kb58/kb59 convention) ---------------------

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
	await closeDrawer()
	await closeSettings()
	await reloadShell()
	await installErrorCapture()
	await dismissNotices()
	await openPanel()
	await sleep(700)
	steps.opened = await openSettings()
	if (!steps.opened) return { ok: false, steps }
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
	let title = null
	for (let attempt = 0; attempt < 30; attempt += 1) {
		title = await panelTitle()
		if (title === expectedTitle) break
		await sleep(250)
	}
	steps.title = title
	return { ok: steps.pick === true && title === expectedTitle, steps }
}

/**
 * Switch the app theme through its real control (Settings -> General -> Appearance).
 * Emulated media is deliberately not used: the shell owns the theme and mirrors it
 * on <html data-ds-theme-source>.
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

async function currentTheme() {
	return app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")')
}

// --- host actions ----------------------------------------------------------

let actionLog = []
let scratchWorkspaceId = ''

async function pageAction(actionName, payload = {}, workspaceId = scratchWorkspaceId) {
	if (FORBIDDEN_ACTIONS.has(actionName)) {
		throw new Error(`probe safety: refusing to call ${actionName} (it would spawn an agent session)`)
	}
	actionLog.push({ workspaceId, action: actionName, mutating: MUTATING_ACTIONS.has(actionName), at: Date.now() })
	return app.evaluate(`(async () => {
		const response = await fetch('/kanban/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId)}, action: ${JSON.stringify(actionName)}, payload: ${JSON.stringify(payload)} }),
		});
		const body = await response.json();
		return { status: response.status, ok: body.ok === true, value: body.value, error: body.error };
	})()`)
}

async function rawState(workspaceId) {
	return app.evaluate(`(async () => {
		const response = await fetch('/kanban/state', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId)} }),
		});
		const payload = await response.json();
		return payload.ok ? payload.value : { error: payload.error, status: response.status };
	})()`)
}

const ticketById = (snap, id) => (snap && snap.board && Array.isArray(snap.board.tickets) ? snap.board.tickets.find((ticket) => ticket.id === id) || null : null)
const countsOf = (snap) => ({
	tickets: snap && snap.board && Array.isArray(snap.board.tickets) ? snap.board.tickets.length : -1,
	thoughts: snap && Array.isArray(snap.thoughts) ? snap.thoughts.length : -1,
	members: snap && Array.isArray(snap.roster) ? snap.roster.length : -1,
	ticketIds: snap && snap.board && Array.isArray(snap.board.tickets) ? snap.board.tickets.map((ticket) => ticket.id) : [],
})

async function waitFor(expression, label, timeoutMs = 12000) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		const value = await app.evaluate(`(() => { try { return !!(${expression}) } catch (error) { return false } })()`).catch(() => false)
		if (value) return true
		await sleep(200)
	}
	throw new Error('timeout waiting for ' + label)
}

const drawerOpen = () => app.evaluate('!!document.querySelector(".kb-drawer")')
const drawerLabel = () =>
	app.evaluate('(() => { const d = document.querySelector(".kb-drawer"); return d ? (d.getAttribute("aria-label") || "") : "" })()')

async function closeDrawer() {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		if (!(await drawerOpen())) return true
		await app.key('Escape')
		await sleep(350)
	}
	return !(await drawerOpen())
}

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

async function ensureTicketDrawer(id) {
	const label = await drawerLabel()
	if (label.indexOf(id) !== -1) return true
	await openTicket(id)
	return true
}

async function pointerClick(expression) {
	const rect = await app.rect(expression)
	if (!rect) return false
	await app.mouse('mousePressed', rect.x, rect.y)
	await app.mouse('mouseReleased', rect.x, rect.y)
	await sleep(300)
	return true
}

/** Click a visible button inside a container by its text, aria-label or title. */
async function clickIn(containerSelector, labels) {
	const wanted = Array.isArray(labels) ? labels : [labels]
	const clicked = await app.evaluate(
		`(() => {
			const want = ${JSON.stringify(wanted)}.map((value) => value.toLowerCase());
			const container = document.querySelector(${JSON.stringify(containerSelector)});
			if (!container) return false;
			const nodes = [...container.querySelectorAll('button,[role="button"],a')];
			const pick = (value) => nodes.find((n) => {
				const text = (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
				const aria = (n.getAttribute('aria-label') || '').trim().toLowerCase();
				const title = (n.getAttribute('title') || '').trim().toLowerCase();
				return text === value || aria === value || title === value;
			});
			for (const value of want) {
				const el = pick(value);
				if (el) { el.click(); return true; }
			}
			return false;
		})()`,
		{ userGesture: true },
	)
	await sleep(600)
	return clicked
}

/** Click a header action by its localized title/aria-label. */
async function clickHeaderAction(labels) {
	const wanted = Array.isArray(labels) ? labels : [labels]
	const clicked = await app.evaluate(
		`(() => {
			const want = ${JSON.stringify(wanted)}.map((value) => value.toLowerCase());
			const nodes = [...document.querySelectorAll('.kb-header button')].filter((b) => {
				const rect = b.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			});
			for (const value of want) {
				const el = nodes.find((n) => {
					const title = (n.getAttribute('title') || '').trim().toLowerCase();
					const aria = (n.getAttribute('aria-label') || '').trim().toLowerCase();
					const text = (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
					return title === value || aria === value || text === value;
				});
				if (el) { el.click(); return true; }
			}
			return false;
		})()`,
		{ userGesture: true },
	)
	await sleep(800)
	return clicked
}

async function scrollDrawerTop() {
	await app.evaluate('(() => { const body = document.querySelector(".kb-drawerBody"); if (body) body.scrollTop = 0; return true })()')
	await sleep(250)
}

/** Scroll the drawer body so the comments section is in view (evidence shots). */
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

// ---------------------------------------------------------------------------
// Read-only fetch shims: thoughts rows/empty state and the scan vision fixture
// ---------------------------------------------------------------------------

const SHIM_FETCH = `(() => {
	const existing = window.__kb64shim;
	const real = (existing && existing.real) || window.fetch;
	const state = existing || { real, installed: false, stateHits: 0, scanHits: 0, mode: null, thought: null, scan: null };
	state.real = real;
	state.mode = __MODE__;
	state.thought = __THOUGHT__;
	state.scan = __SCAN__;
	window.__kb64shim = state;
	if (!state.installed) {
		state.installed = true;
		window.fetch = async function (input, init) {
			const url = typeof input === 'string' ? input : (input && input.url) || '';
			let body = null;
			try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null } catch (error) { body = null }
			if (url.indexOf('kanban/state') !== -1 && window.__kb64shim && window.__kb64shim.mode) {
				const response = await real.call(window, input, init);
				const data = await response.clone().json();
				const value = data && data.value;
				if (value) {
					if (window.__kb64shim.mode === 'empty') value.thoughts = [];
					if (window.__kb64shim.mode === 'rows' && Array.isArray(value.board && value.board.tickets)) value.thoughts = [Object.assign({}, window.__kb64shim.thought)];
				}
				window.__kb64shim.stateHits += 1;
				return new Response(JSON.stringify(data), { status: response.status, headers: { 'content-type': 'application/json' } });
			}
			if (body && body.action === 'scan' && window.__kb64shim && window.__kb64shim.scan) {
				window.__kb64shim.scanHits += 1;
				return new Response(JSON.stringify({ ok: true, value: { scan: window.__kb64shim.scan } }), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			return real.call(window, input, init);
		};
	}
	return true;
})()`

async function installShim(mode, { thought = null, scan = null } = {}) {
	const code = SHIM_FETCH.replace('__MODE__', JSON.stringify(mode || null))
		.replace('__THOUGHT__', JSON.stringify(thought || null))
		.replace('__SCAN__', JSON.stringify(scan || null))
	await app.evaluate(code)
}

async function removeShim() {
	await app.evaluate(`(() => {
		const state = window.__kb64shim;
		if (state && state.real) window.fetch = state.real;
		window.__kb64shim = null;
		return true;
	})()`)
}

const shimState = () =>
	app.evaluate('(() => { const s = window.__kb64shim; return s ? { stateHits: s.stateHits, scanHits: s.scanHits, mode: s.mode } : null })()')

async function waitForPoll(beforeHits, label) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		await sleep(250)
		const state = await shimState()
		if (state && state.stateHits > beforeHits) return true
	}
	throw new Error('timeout waiting for the /kanban/state poll (' + label + ')')
}

async function openThoughtsDrawer() {
	await closeDrawer()
	const clicked = await clickHeaderAction(['Thoughts', '想法'])
	if (!clicked) throw new Error('Thoughts header control not found')
	await waitFor('document.querySelector(".kb-drawer--thoughts")', 'thoughts drawer')
	await sleep(400)
}

async function openScanDrawer() {
	await closeDrawer()
	const clicked = await clickHeaderAction(['Scan', '扫描'])
	if (!clicked) throw new Error('Scan header control not found')
	await waitFor('document.querySelector(".kb-drawer--scan")', 'scan drawer')
	await waitFor('document.querySelector(".kb-drawer--scan .kb-vision .kb-md") || document.querySelector(".kb-drawer--scan .kb-errorText")', 'scan data', 15000)
	await sleep(400)
}

// ---------------------------------------------------------------------------
// DOM state snapshots
// ---------------------------------------------------------------------------

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
			text: (b.textContent || '').trim(),
			pressed: b.getAttribute('aria-pressed'),
			disabled: b.disabled === true,
		}));
		const group = section.querySelector('.kb-descModes');
		const tags = {};
		if (md) ['h1','h2','h3','h4','h5','h6','ul','ol','li','pre','code','p','strong','em','blockquote','table','thead','tbody','tr','th','td','a'].forEach((name) => {
			tags[name] = md.querySelectorAll(name).length;
		});
		const anchors = md ? [...md.querySelectorAll('a')].map((a) => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), aria: a.getAttribute('aria-label') })) : [];
		return {
			readMode: read ? read.getAttribute('data-description-mode') : null,
			hasTextarea: Boolean(textarea),
			textareaValue: textarea ? String(textarea.value) : null,
			hasMarkdown: Boolean(md),
			emptyText: empty ? (empty.textContent || '').trim() : null,
			visibleText: md ? (md.innerText || '') : (empty ? (empty.textContent || '').trim() : ''),
			sectionText: (section.innerText || ''),
			tags,
			anchors,
			dangerous: md ? md.querySelectorAll('script,img,iframe,object,embed,style').length : 0,
			buttons,
			groupLabel: group ? group.getAttribute('aria-label') : null,
			codeAria: md && md.querySelector('pre') ? md.querySelector('pre').getAttribute('aria-label') : null,
			tableAria: md && md.querySelector('.kb-md-tableWrap') ? md.querySelector('.kb-md-tableWrap').getAttribute('aria-label') : null,
		};
	})()`)

const commentsState = () =>
	app.evaluate(`(() => {
		const drawer = document.querySelector('.kb-drawer');
		if (!drawer) return null;
		const rows = [...drawer.querySelectorAll('.kb-comment')].map((row) => {
			const head = row.querySelector('.kb-commentHead');
			const body = row.querySelector('.kb-commentText');
			const md = body ? body.querySelector('.kb-md') : null;
			return {
				author: head && head.querySelector('.kb-commentAuthor') ? String(head.querySelector('.kb-commentAuthor').textContent || '') : null,
				hasMarkdown: Boolean(md),
				tags: md ? ['h3','h4','h5','p','ul','li','pre','code','a','strong'].reduce((acc, name) => { acc[name] = md.querySelectorAll(name).length; return acc }, {}) : null,
				text: body ? String(body.innerText || '') : '',
				anchors: md ? [...md.querySelectorAll('a')].map((a) => ({ text: (a.textContent || '').trim(), href: a.getAttribute('href'), aria: a.getAttribute('aria-label') })) : [],
				dangerous: md ? md.querySelectorAll('script,img,iframe,object,embed,style').length : 0,
			};
		});
		return { count: rows.length, rows };
	})()`)

const thoughtsState = () =>
	app.evaluate(`(() => {
		const drawer = document.querySelector('.kb-drawer--thoughts');
		if (!drawer) return null;
		const rows = [...drawer.querySelectorAll('.kb-thoughtRow')].map((row) => {
			const text = row.querySelector('.kb-thoughtText');
			const button = row.querySelector('.kb-thoughtExpand');
			const md = text ? text.querySelector('.kb-md') : null;
			return {
				hasText: Boolean(text),
				expandedClass: text ? text.classList.contains('kb-thoughtText--expanded') : false,
				hasMarkdown: Boolean(md),
				textLength: text ? String(text.innerText || '').length : 0,
				expandText: button ? (button.textContent || '').trim() : null,
				ariaExpanded: button ? button.getAttribute('aria-expanded') : null,
			};
		});
		const count = drawer.querySelector('.kb-thoughtsHeadCount');
		return {
			count: rows.length,
			countText: count ? (count.textContent || '').trim() : null,
			empty: drawer.querySelector('.kb-thoughtEmpty') ? (drawer.querySelector('.kb-thoughtEmpty').innerText || '').trim() : null,
			rows,
		};
	})()`)

const scanState = () =>
	app.evaluate(`(() => {
		const drawer = document.querySelector('.kb-drawer--scan');
		if (!drawer) return null;
		const vision = drawer.querySelector('.kb-vision');
		const md = vision ? vision.querySelector('.kb-md') : null;
		return {
			ariaLabel: drawer.getAttribute('aria-label'),
			hasVision: Boolean(vision),
			visionAria: vision ? vision.getAttribute('aria-label') : null,
			hasMarkdown: Boolean(md),
			text: md ? String(md.innerText || '') : '',
			sectionTitles: [...drawer.querySelectorAll('.kb-sectionTitle')].map((el) => (el.textContent || '').trim()),
		};
	})()`)

const MEASURE = `(() => {
	const root = document.querySelector('.kb-root');
	if (!root) return { open: false };
	const drawer = document.querySelector('.kb-drawer');
	const body = drawer ? drawer.querySelector('.kb-drawerBody') : null;
	const rootBox = root.getBoundingClientRect();
	// Descendants of an internal scroller (.kb-drawerBody, .kb-md pre, .kb-md-tableWrap)
	// may legitimately be wider than their clip box; the scroller's own scrollWidth is
	// measured below, so only non-clipped elements are checked against the panel edge.
	const clipped = (el) => {
		let node = el.parentElement;
		while (node && node !== root) {
			const style = getComputedStyle(node);
			if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) return true;
			node = node.parentElement;
		}
		return false;
	};
	const crossing = [...root.querySelectorAll('*')].filter((el) => {
		const box = el.getBoundingClientRect();
		if (box.width === 0 || box.height === 0) return false;
		if (clipped(el)) return false;
		return box.right > rootBox.right + 1;
	}).slice(0, 6).map((el) => String(el.className || el.tagName).slice(0, 48));
	const pres = [...root.querySelectorAll('.kb-md pre')].map((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, aria: el.getAttribute('aria-label') }));
	const tables = [...root.querySelectorAll('.kb-md-tableWrap')].map((el) => ({ clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, aria: el.getAttribute('aria-label') }));
	const drawerBox = drawer ? drawer.getBoundingClientRect() : null;
	const bodyBox = body ? body.getBoundingClientRect() : null;
	const inside = (box) => !box || (box.right <= rootBox.right + 1 && box.left >= rootBox.left - 1);
	return {
		open: true,
		rootWidth: root.clientWidth,
		rootBox: { left: Math.round(rootBox.left), right: Math.round(rootBox.right), width: Math.round(rootBox.width) },
		panel: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth },
		drawer: drawer ? { clientWidth: drawer.clientWidth, scrollWidth: drawer.scrollWidth, left: Math.round(drawerBox.left), right: Math.round(drawerBox.right) } : null,
		drawerInside: inside(drawerBox),
		body: body ? { clientWidth: body.clientWidth, scrollWidth: body.scrollWidth, clientHeight: body.clientHeight, scrollHeight: body.scrollHeight, left: Math.round(bodyBox.left), right: Math.round(bodyBox.right) } : null,
		bodyInside: inside(bodyBox),
		pres,
		tables,
		crossing,
		docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
	};
})()`

const measureSurface = () => app.evaluate(MEASURE)

/** Everything the probe needs to judge one captured state. */
const captureState = () =>
	app.evaluate(`(() => {
		const state = {};
		const drawer = document.querySelector('.kb-drawer');
		state.drawerLabel = drawer ? (drawer.getAttribute('aria-label') || '') : '';
		state.thoughts = !!document.querySelector('.kb-drawer--thoughts');
		state.scan = !!document.querySelector('.kb-drawer--scan');
		state.html = document.documentElement.getAttribute('data-ds-theme-source');
		state.xss = window.__kb64xss === true;
		return state;
	})()`)

// ---------------------------------------------------------------------------
// Locale observation (AC6)
// ---------------------------------------------------------------------------

async function captureZh(run, surface) {
	const name = `${surface}-1440-light-zh.png`
	const captured = await shot(name)
	const measurements = await measureSurface()
	const state = await captureState()
	run.screenshots.push({ surface, width: 1440, theme: 'light', lang: 'zh', path: captured.path, bytes: captured.bytes, rootWidth: measurements.rootWidth })
	run.measurements.push({ surface, width: 1440, theme: 'light', lang: 'zh', ...measurements, state: { dark: state.html === 'dark', xss: state.xss } })
	record(run, `AC3/shot-${surface}-1440-light-zh`, `${surface} renders in zh at 1440px light (${name})`, captured.bytes > 0 && state.html === 'light', {
		file: captured.path,
		bytes: captured.bytes,
		rootWidth: measurements.rootWidth,
		themeSource: state.html,
	})
	const bodyOk = !measurements.body || measurements.body.scrollWidth <= measurements.body.clientWidth + 1
	const drawerOk = !measurements.drawer || measurements.drawer.scrollWidth <= measurements.drawer.clientWidth + 1
	const overflowOk = bodyOk && drawerOk && measurements.panel.scrollWidth <= measurements.panel.clientWidth + 1 && measurements.crossing.length === 0 && measurements.docOverflow === false && measurements.drawerInside !== false && measurements.bodyInside !== false
	record(run, `AC5/overflow-${surface}-1440-light-zh`, `${surface} in zh at 1440px light has no horizontal overflow and nothing crosses the panel edge`, overflowOk, {
		rootWidth: measurements.rootWidth,
		panel: measurements.panel,
		drawer: measurements.drawer,
		body: measurements.body,
		crossing: measurements.crossing,
		docOverflow: measurements.docOverflow,
	})
}

async function observeLocale(lang, run) {
	const labels = {}
	await closeDrawer()
	await setViewport(1440, 900)

	// Empty plain ticket -> detail.descriptionEmpty + mode control labels.
	await openTicket(run.fixtures.empty)
	const empty = await descriptionState()
	labels['detail.descriptionMode'] = empty ? empty.groupLabel : null
	labels['detail.edit'] = empty && empty.buttons[0] ? empty.buttons[0].text : null
	labels['detail.preview'] = empty && empty.buttons[1] ? empty.buttons[1].text : null
	labels['detail.descriptionEmpty'] = empty ? empty.emptyText : null
	await closeDrawer()

	// Empty EPIC -> detail.epicPrdEmpty.
	await openTicket(run.fixtures.epic)
	const epic = await descriptionState()
	labels['detail.epicPrdEmpty'] = epic ? epic.emptyText : null
	await closeDrawer()

	// Main PRD -> md.codeBlock / md.table / md.linkExternal and the read-mode screenshot.
	await openTicket(run.fixtures.main)
	await scrollDrawerTop()
	const read = await descriptionState()
	labels['md.codeBlock'] = read ? read.codeAria : null
	labels['md.table'] = read ? read.tableAria : null
	const anchor = read && read.anchors.length > 0 ? read.anchors[0] : null
	labels['md.linkExternal'] = anchor ? anchor.aria : null
	if (lang === 'zh') await captureZh(run, 'read')
	await scrollToComments()
	if (lang === 'zh') await captureZh(run, 'comments')
	await closeDrawer()

	// Thoughts empty state (forced through the read-only fetch shim).
	await installShim('empty')
	await openThoughtsDrawer()
	const beforeEmpty = (await shimState())?.stateHits || 0
	await waitForPoll(beforeEmpty, 'thoughts empty state')
	await waitFor('document.querySelector(".kb-drawer--thoughts .kb-thoughtEmpty")', 'thoughts empty copy')
	const emptyThoughts = await thoughtsState()
	labels['header.thoughts'] = await app.evaluate(
		`(() => { const b = [...document.querySelectorAll('.kb-header button')].find((x) => /^(Thoughts|想法)$/.test((x.getAttribute('title') || '').trim())); return b ? b.getAttribute('title') : null })()`,
	)
	labels['thought.empty'] = emptyThoughts ? emptyThoughts.empty : null
	await closeDrawer()

	// Thoughts row: count, expand and collapse labels; zh capture of the expanded row.
	await installShim('rows', { thought: THOUGHT_FIXTURE })
	await openThoughtsDrawer()
	const beforeRows = (await shimState())?.stateHits || 0
	await waitForPoll(beforeRows, 'thoughts row fixture')
	await waitFor('document.querySelector(".kb-drawer--thoughts .kb-thoughtRow")', 'thoughts row')
	const collapsed = await thoughtsState()
	labels['thought.count'] = collapsed ? collapsed.countText : null
	labels['thought.expand'] = collapsed && collapsed.rows[0] ? collapsed.rows[0].expandText : null
	const expandClicked = await app.evaluate(
		`(() => { const b = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-thoughtExpand'); if (!b) return false; b.click(); return true })()`,
		{ userGesture: true },
	)
	await sleep(500)
	const expanded = await thoughtsState()
	labels['thought.collapse'] = expanded && expanded.rows[0] ? expanded.rows[0].expandText : null
	if (lang === 'zh' && expandClicked) await captureZh(run, 'thoughts-expanded')
	await closeDrawer()
	await removeShim()

	// Scan vision through the read-only scan action shim.
	await installShim(null, { scan: { ...SCAN_FIXTURE, generatedAt: Date.now() } })
	await openScanDrawer()
	const scan = await scanState()
	labels['scan.title'] = scan ? scan.ariaLabel : null
	labels['scan.vision'] = scan ? scan.visionAria : null
	if (lang === 'zh') await captureZh(run, 'scan-vision')
	await closeDrawer()
	await removeShim()
	return labels
}

function localeValueOk(key, lang, value) {
	const expected = EXPECTED_KEYS[key][lang]
	if (value === null || value === undefined) return false
	if (key === 'md.linkExternal') return String(value).includes(expected)
	return String(value).trim() === expected
}

// ---------------------------------------------------------------------------
// Capture matrix (AC3/AC5)
// ---------------------------------------------------------------------------

function screenshotName(surface, width, theme) {
	return `${surface}-${width}-${theme}.png`
}

async function capture(run, surface, width, theme, verify) {
	const name = screenshotName(surface, width, theme)
	const captured = await shot(name)
	const measurements = await measureSurface()
	const state = await captureState()
	let valid = false
	let detail = null
	try {
		const snapshot = await verify()
		valid = snapshot.valid === true
		detail = snapshot.detail
	} catch (error) {
		valid = false
		detail = String((error && error.message) || error)
	}
	const themeOk = state.html === theme
	run.screenshots.push({ surface, width, theme, lang: 'en', path: captured.path, bytes: captured.bytes, rootWidth: measurements.rootWidth })
	run.measurements.push({ surface, width, theme, lang: 'en', ...measurements, state: { dark: state.html === 'dark', xss: state.xss } })
	record(run, `AC3/shot-${surface}-${width}-${theme}`, `${surface} renders at ${width}px in ${theme} (${name})`, captured.bytes > 0 && valid && themeOk, {
		file: captured.path,
		bytes: captured.bytes,
		themeSource: state.html,
		state: detail,
	})
	const bodyOk = !measurements.body || measurements.body.scrollWidth <= measurements.body.clientWidth + 1
	const drawerOk = !measurements.drawer || measurements.drawer.scrollWidth <= measurements.drawer.clientWidth + 1
	const panelOk = measurements.panel.scrollWidth <= measurements.panel.clientWidth + 1
	const overflowOk = bodyOk && drawerOk && panelOk && measurements.crossing.length === 0 && measurements.docOverflow === false && measurements.drawerInside !== false && measurements.bodyInside !== false
	record(run, `AC5/overflow-${surface}-${width}-${theme}`, `${surface} at ${width}px ${theme} has no horizontal overflow and nothing crosses the panel edge`, overflowOk, {
		rootWidth: measurements.rootWidth,
		rootBox: measurements.rootBox,
		panel: measurements.panel,
		drawer: measurements.drawer,
		drawerInside: measurements.drawerInside,
		body: measurements.body,
		bodyInside: measurements.bodyInside,
		crossing: measurements.crossing,
		docOverflow: measurements.docOverflow,
	})
	if (surface === 'read') {
		const presScroll = measurements.pres.some((entry) => entry.scrollWidth > entry.clientWidth)
		const tablesScroll = measurements.tables.some((entry) => entry.scrollWidth > entry.clientWidth)
		record(run, `AC5/wrappers-${width}-${theme}`, `code and table wrappers scroll internally on the overflow fixture at ${width}px ${theme}`, presScroll && tablesScroll, {
			pres: measurements.pres,
			tables: measurements.tables,
		})
	}
	return { valid, measurements }
}

async function lightMatrix(run) {
	await setViewport(1440, 900)
	await ensureTicketDrawer(run.fixtures.main)
	await scrollDrawerTop()

	// Read mode at 1440/1024/640.
	for (const width of WIDTHS) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await scrollDrawerTop()
		await capture(run, 'read', width, 'light', async () => {
			const state = await descriptionState()
			return {
				valid: Boolean(state && state.hasMarkdown && state.readMode === 'read' && state.tags.h3 >= 1 && state.tags.h4 >= 1 && state.tags.li >= 1 && state.tags.pre >= 1 && state.tags.table >= 1 && state.tags.code >= 1 && state.tags.a >= 1 && state.dangerous === 0),
				detail: state ? { mode: state.readMode, tags: state.tags, dangerous: state.dangerous } : null,
			}
		})
	}

	// AC2 read-mode proofs.
	await setViewport(1440, 900)
	await scrollDrawerTop()
	const readState = await descriptionState()
	record(run, 'AC2/readDefault', 'opening the drawer shows the read view with no click', Boolean(readState && readState.readMode === 'read' && readState.hasMarkdown && !readState.hasTextarea), readState && { mode: readState.readMode, hasMarkdown: readState.hasMarkdown, hasTextarea: readState.hasTextarea })
	const readText = readState ? readState.visibleText : ''
	const noMarkers = readText.indexOf('##') === -1 && readText.indexOf('```') === -1 && !/(^|\n)#{1,6}\s/.test(readText) && readText.split('\n').every((line) => !/^\s*[-*]\s/.test(line))
	record(run, 'AC2/readMarkdown', 'the read view renders h3/h4/h5, list, fenced code, table, inline code and an external link with no literal markers', Boolean(readState && noMarkers && readState.tags.h3 >= 1 && readState.tags.h4 >= 1 && readState.tags.h5 >= 1 && readState.tags.li >= 3 && readState.tags.pre >= 1 && readState.tags.code >= 2 && readState.tags.table >= 1 && readState.tags.th >= 1 && readState.tags.td >= 1 && readState.tags.a >= 1 && readState.anchors.some((a) => a.href === 'https://example.com/kb64' && a.target === '_blank')), readState && { sample: readText.slice(0, 160), tags: readState.tags, anchors: readState.anchors })

	// Edit mode shots at 1440/1024/640.
	await ensureTicketDrawer(run.fixtures.main)
	await setViewport(1440, 900)
	await pointerClick(`document.querySelectorAll('.kb-drawer .kb-descMode')[0]`)
	await sleep(300)
	const editState = await descriptionState()
	record(run, 'AC2/editPrefilled', 'Edit reveals a textarea pre-filled with the exact stored source', Boolean(editState && editState.hasTextarea && editState.textareaValue === MAIN_SOURCE && !editState.hasMarkdown), editState && { equal: editState.textareaValue === MAIN_SOURCE, length: editState.textareaValue === null ? null : editState.textareaValue.length })
	for (const width of WIDTHS) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await scrollDrawerTop()
		await capture(run, 'edit', width, 'light', async () => {
			const state = await descriptionState()
			return {
				valid: Boolean(state && state.hasTextarea && state.textareaValue === MAIN_SOURCE && !state.hasMarkdown && state.buttons.some((b) => b.pressed === 'true')),
				detail: state ? { hasTextarea: state.hasTextarea, hasMarkdown: state.hasMarkdown, valueLength: state.textareaValue === null ? null : state.textareaValue.length } : null,
			}
		})
	}

	// Edit -> Preview -> Edit -> blur round-trip that persists the shown draft.
	await setViewport(1440, 900)
	await scrollDrawerTop()
	const typed = await app.type('document.querySelector(".kb-drawer .kb-description")', DRAFT_SOURCE)
	const afterType = await descriptionState()
	record(run, 'AC2/draftTyped', 'the probe typed a different draft into the Edit textarea', typed === true && Boolean(afterType) && afterType.textareaValue === DRAFT_SOURCE, afterType && { valueLength: afterType.textareaValue === null ? null : afterType.textareaValue.length })
	await pointerClick(`document.querySelectorAll('.kb-drawer .kb-descMode')[1]`)
	await sleep(350)
	const previewState = await descriptionState()
	record(run, 'AC2/previewDraft', 'Preview renders the typed draft immediately (before any save)', Boolean(previewState && previewState.readMode === 'preview' && previewState.hasMarkdown && previewState.visibleText.indexOf('Edited draft heading') !== -1 && previewState.tags.pre >= 1 && previewState.tags.table >= 1), previewState && { mode: previewState.readMode, sample: previewState.visibleText.slice(0, 120), tags: previewState.tags })
	await pointerClick(`document.querySelectorAll('.kb-drawer .kb-descMode')[0]`)
	await sleep(300)
	const backState = await descriptionState()
	record(run, 'AC2/draftPreserved', 'pressing Edit again returns the same unsaved draft', Boolean(backState && backState.hasTextarea && backState.textareaValue === DRAFT_SOURCE), backState && { equal: backState.textareaValue === DRAFT_SOURCE })
	await app.evaluate('(() => { const input = document.querySelector(".kb-drawer .kb-titleInput"); if (input) input.focus(); return true })()')
	let persisted = null
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const ticket = ticketById(await rawState(scratchWorkspaceId), run.fixtures.main)
		persisted = ticket ? ticket.description : null
		if (persisted === DRAFT_SOURCE) break
		await sleep(200)
	}
	record(run, 'AC2/draftPersisted', 'the persisted description equals the shown draft exactly', persisted === DRAFT_SOURCE, { equal: persisted === DRAFT_SOURCE, storedLength: persisted === null ? null : persisted.length, draftLength: DRAFT_SOURCE.length })
	await pointerClick(`document.querySelectorAll('.kb-drawer .kb-descMode')[0]`)
	await sleep(350)
	const afterPersist = await descriptionState()
	record(run, 'AC2/readAfterPersist', 'read mode shows the persisted draft', Boolean(afterPersist && afterPersist.readMode === 'read' && afterPersist.visibleText.indexOf('Edited draft heading') !== -1), afterPersist && { mode: afterPersist.readMode, sample: afterPersist.visibleText.slice(0, 120) })

	// Comments shots at 1440/1024/640.
	const comments = await commentsState()
	record(run, 'AC2/commentsMarkdown', 'the Markdown comment renders as a list, a fence and an external link', Boolean(comments && comments.count === 1 && comments.rows[0].hasMarkdown && comments.rows[0].tags.li >= 2 && comments.rows[0].tags.pre >= 1 && comments.rows[0].tags.a >= 1 && comments.rows[0].dangerous === 0 && /rendered list item one/.test(comments.rows[0].text)), comments && { count: comments.count, row: comments.rows[0] })
	for (const width of WIDTHS) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await scrollToComments()
		await capture(run, 'comments', width, 'light', async () => {
			const state = await commentsState()
			return {
				valid: Boolean(state && state.count === 1 && state.rows[0].hasMarkdown && state.rows[0].tags.li >= 2 && state.rows[0].dangerous === 0),
				detail: state ? { count: state.count, tags: state.rows[0] && state.rows[0].tags } : null,
			}
		})
	}
	await closeDrawer()

	// Hostile fixture at 1440/1024/640.
	await ensureTicketDrawer(run.fixtures.hostile)
	await scrollDrawerTop()
	const hostile = await descriptionState()
	record(run, 'AC2/hostileLiteral', 'hostile HTML in a description and comment renders literally, with no script/img/iframe node and no javascript: link', Boolean(hostile && hostile.hasMarkdown && hostile.dangerous === 0 && !hostile.visibleText.includes('##') && hostile.visibleText.includes('<script>') && hostile.visibleText.includes('<img') && hostile.visibleText.includes('<iframe') && hostile.visibleText.includes('javascript:') && hostile.anchors.every((a) => !/^javascript:/i.test(String(a.href || '')))), hostile && { dangerous: hostile.dangerous, sample: hostile.visibleText.slice(0, 200), anchors: hostile.anchors })
	const hostileComment = await commentsState()
	record(run, 'AC2/hostileCommentLiteral', 'the hostile comment body renders literally too', Boolean(hostileComment && hostileComment.count === 1 && hostileComment.rows[0].dangerous === 0 && hostileComment.rows[0].text.includes('<script>') && hostileComment.rows[0].text.includes('<img')), hostileComment && { count: hostileComment.count, sample: hostileComment.rows[0] && hostileComment.rows[0].text.slice(0, 160) })
	const xssFired = await app.evaluate('window.__kb64xss === true')
	record(run, 'AC2/hostileNoExecution', 'the hostile payload never executed', xssFired === false, { xssFired })
	for (const width of WIDTHS) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await scrollDrawerTop()
		await capture(run, 'hostile', width, 'light', async () => {
			const state = await descriptionState()
			return {
				valid: Boolean(state && state.hasMarkdown && state.dangerous === 0 && state.visibleText.includes('<script>') && state.anchors.every((a) => !/^javascript:/i.test(String(a.href || '')))),
				detail: state ? { dangerous: state.dangerous, sample: state.visibleText.slice(0, 120) } : null,
			}
		})
	}
	await closeDrawer()
}

async function darkMatrix(run) {
	const applied = await setTheme('dark')
	record(run, 'AC3/darkThemeApplied', 'the real Settings -> General -> Appearance control applies the dark theme', applied === true && (await currentTheme()) === 'dark', { applied, source: await currentTheme() })
	await setViewport(1440, 900)
	await ensureTicketDrawer(run.fixtures.main)
	await scrollDrawerTop()
	for (const width of [1440, 1024]) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await scrollDrawerTop()
		await capture(run, 'read', width, 'dark', async () => {
			const state = await descriptionState()
			const source = await currentTheme()
			return {
				valid: Boolean(state && state.hasMarkdown && state.tags.pre >= 1 && state.tags.table >= 1 && source === 'dark'),
				detail: state ? { mode: state.readMode, tags: state.tags, source } : null,
			}
		})
	}
	await setViewport(1440, 900)
	await pointerClick(`document.querySelectorAll('.kb-drawer .kb-descMode')[0]`)
	await sleep(300)
	for (const width of [1440, 1024]) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await scrollDrawerTop()
		await capture(run, 'edit', width, 'dark', async () => {
			const state = await descriptionState()
			return { valid: Boolean(state && state.hasTextarea && state.textareaValue === DRAFT_SOURCE), detail: state ? { hasTextarea: state.hasTextarea, length: state.textareaValue === null ? null : state.textareaValue.length } : null }
		})
	}
	await pointerClick(`document.querySelectorAll('.kb-drawer .kb-descMode')[0]`)
	await sleep(350)
	for (const width of [1440, 1024]) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await scrollToComments()
		await capture(run, 'comments', width, 'dark', async () => {
			const state = await commentsState()
			return { valid: Boolean(state && state.count === 1 && state.rows[0].hasMarkdown), detail: state ? { count: state.count } : null }
		})
	}
	await closeDrawer()
	await setViewport(1440, 900)
	await ensureTicketDrawer(run.fixtures.hostile)
	await scrollDrawerTop()
	for (const width of [1440, 1024]) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await scrollDrawerTop()
		await capture(run, 'hostile', width, 'dark', async () => {
			const state = await descriptionState()
			return { valid: Boolean(state && state.hasMarkdown && state.dangerous === 0 && state.visibleText.includes('<script>')), detail: state ? { dangerous: state.dangerous, sample: state.visibleText.slice(0, 120) } : null }
		})
	}
	await closeDrawer()
}

async function thoughtsMatrix(run) {
	await setTheme('light')
	await setViewport(1440, 900)
	await installShim('rows', { thought: THOUGHT_FIXTURE })
	await openThoughtsDrawer()
	await waitFor('document.querySelector(".kb-drawer--thoughts .kb-thoughtRow")', 'thoughts row fixture')
	await sleep(400)

	// Light widths: collapsed then expanded.
	for (const width of WIDTHS) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await sleep(300)
		let state = await thoughtsState()
		if (state && state.rows[0] && state.rows[0].expandedClass) {
			await app.evaluate('(() => { const b = document.querySelector(".kb-drawer--thoughts .kb-thoughtRow .kb-thoughtExpand"); if (b) b.click(); return true })()', { userGesture: true })
			await sleep(400)
			state = await thoughtsState()
		}
		await capture(run, 'thoughts-collapsed', width, 'light', async () => {
			const snapshot = await thoughtsState()
			return {
				valid: Boolean(snapshot && snapshot.count >= 1 && snapshot.rows[0].hasText && snapshot.rows[0].expandedClass === false && snapshot.rows[0].ariaExpanded === 'false' && snapshot.rows[0].expandText),
				detail: snapshot ? { count: snapshot.count, expandText: snapshot.rows[0].expandText, ariaExpanded: snapshot.rows[0].ariaExpanded } : null,
			}
		})
		await app.evaluate('(() => { const b = document.querySelector(".kb-drawer--thoughts .kb-thoughtRow .kb-thoughtExpand"); if (b) b.click(); return true })()', { userGesture: true })
		await sleep(450)
		await capture(run, 'thoughts-expanded', width, 'light', async () => {
			const snapshot = await thoughtsState()
			return {
				valid: Boolean(snapshot && snapshot.count >= 1 && snapshot.rows[0].expandedClass === true && snapshot.rows[0].hasMarkdown && snapshot.rows[0].ariaExpanded === 'true'),
				detail: snapshot ? { count: snapshot.count, hasMarkdown: snapshot.rows[0].hasMarkdown, ariaExpanded: snapshot.rows[0].ariaExpanded } : null,
			}
		})
	}
	const thoughtsShots = run.screenshots.filter((entry) => entry.surface === 'thoughts-collapsed' || entry.surface === 'thoughts-expanded')
	const collapsedShot = thoughtsShots.some((entry) => entry.surface === 'thoughts-collapsed' && entry.width === 1440 && entry.theme === 'light')
	const expandedShot = thoughtsShots.some((entry) => entry.surface === 'thoughts-expanded' && entry.width === 1440 && entry.theme === 'light')
	const shimHits = await shimState()
	record(run, 'AC3/thoughtsDriven', 'Thoughts collapsed and expanded states render from the read-only fixture (not a component fallback)', collapsedShot && expandedShot && Boolean(shimHits && shimHits.stateHits > 0), { fixtureSource: 'fetch-shim', surface: 'thoughts', collapsedShot, expandedShot, stateHits: shimHits ? shimHits.stateHits : null })

	// Dark widths.
	await setViewport(1440, 900)
	await closeDrawer()
	const applied = await setTheme('dark')
	record(run, 'AC3/darkThemeAppliedThoughts', 'dark theme applies for the Thoughts captures', applied === true && (await currentTheme()) === 'dark', { applied })
	await openThoughtsDrawer()
	await waitFor('document.querySelector(".kb-drawer--thoughts .kb-thoughtRow")', 'thoughts row fixture (dark)')
	await sleep(400)
	for (const width of [1440, 1024]) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await sleep(300)
		let state = await thoughtsState()
		if (state && state.rows[0] && state.rows[0].expandedClass) {
			await app.evaluate('(() => { const b = document.querySelector(".kb-drawer--thoughts .kb-thoughtRow .kb-thoughtExpand"); if (b) b.click(); return true })()', { userGesture: true })
			await sleep(400)
		}
		await capture(run, 'thoughts-collapsed', width, 'dark', async () => {
			const snapshot = await thoughtsState()
			return { valid: Boolean(snapshot && snapshot.count >= 1 && snapshot.rows[0].expandedClass === false), detail: snapshot ? { count: snapshot.count } : null }
		})
		await app.evaluate('(() => { const b = document.querySelector(".kb-drawer--thoughts .kb-thoughtRow .kb-thoughtExpand"); if (b) b.click(); return true })()', { userGesture: true })
		await sleep(450)
		await capture(run, 'thoughts-expanded', width, 'dark', async () => {
			const snapshot = await thoughtsState()
			return { valid: Boolean(snapshot && snapshot.rows[0].expandedClass === true && snapshot.rows[0].hasMarkdown), detail: snapshot ? { count: snapshot.count, hasMarkdown: snapshot.rows[0].hasMarkdown } : null }
		})
	}
	await closeDrawer()
	await removeShim()
}

async function scanMatrix(run) {
	await setTheme('light')
	await setViewport(1440, 900)
	await installShim(null, { scan: { ...SCAN_FIXTURE, generatedAt: Date.now() } })
	await openScanDrawer()
	const scan = await scanState()
	record(run, 'AC3/scanVisionData', 'the scan drawer renders a Markdown product vision through the real drawer (read-only scan fixture: the scratch project has 0 docs)', Boolean(scan && scan.hasVision && scan.hasMarkdown && scan.visionAria && scan.text.length > 40), scan ? { ariaLabel: scan.ariaLabel, visionAria: scan.visionAria, titles: scan.sectionTitles, text: scan.text.slice(0, 160) } : null)
	for (const width of WIDTHS) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await sleep(300)
		await capture(run, 'scan-vision', width, 'light', async () => {
			const snapshot = await scanState()
			return { valid: Boolean(snapshot && snapshot.hasVision && snapshot.hasMarkdown && snapshot.ariaLabel && snapshot.visionAria), detail: snapshot ? { visionAria: snapshot.visionAria, titles: snapshot.sectionTitles } : null }
		})
	}
	await closeDrawer()
	await setViewport(1440, 900)
	const applied = await setTheme('dark')
	record(run, 'AC3/darkThemeAppliedScan', 'dark theme applies for the scan captures', applied === true && (await currentTheme()) === 'dark', { applied })
	await openScanDrawer()
	for (const width of [1024, 1440]) {
		await setViewport(width, VIEWPORT_HEIGHTS[width])
		await sleep(300)
		await capture(run, 'scan-vision', width, 'dark', async () => {
			const snapshot = await scanState()
			return { valid: Boolean(snapshot && snapshot.hasVision && snapshot.hasMarkdown), detail: snapshot ? { visionAria: snapshot.visionAria } : null }
		})
	}
	await closeDrawer()
	await removeShim()
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function deleteThroughDrawer(run, id) {
	await setViewport(1440, 900)
	await ensureTicketDrawer(id)
	const armed = await clickIn('.kb-drawerFoot', ['Delete', '删除'])
	const confirmed = await clickIn('.kb-drawerFoot', ['Confirm delete', '确认删除'])
	let gone = false
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const ticket = ticketById(await rawState(scratchWorkspaceId), id)
		if (!ticket) {
			gone = true
			break
		}
		await sleep(200)
	}
	return { armed, confirmed, gone }
}

/** Fixtures this probe owns carry the `kb64-probe` label (kb5/kb58/kb59 convention). */
const staleProbeTickets = async (workspaceId) => {
	const snap = await rawState(workspaceId)
	return snap && snap.board && Array.isArray(snap.board.tickets)
		? snap.board.tickets.filter((ticket) => Array.isArray(ticket.labels) && ticket.labels.includes('kb64-probe'))
		: []
}

/**
 * AC10: a killed run can leave its labelled fixtures behind. Delete them through
 * the host action before the before-snapshot so the next run starts from the same
 * board it will restore to, and prove the board is clean afterwards.
 */
async function sweepStaleFixtures(workspaceId) {
	const stale = await staleProbeTickets(workspaceId)
	const deleted = []
	const failed = []
	for (const ticket of stale) {
		const result = await pageAction('deleteTicket', { ticketId: ticket.id }, workspaceId)
		if (result.ok) deleted.push(ticket.id)
		else failed.push({ id: ticket.id, error: shortJson(result.error || result) })
	}
	const remaining = (await staleProbeTickets(workspaceId)).map((ticket) => ticket.id)
	return { found: stale.map((ticket) => ticket.id), deleted, failed, remaining }
}

// ---------------------------------------------------------------------------
// One suite run
// ---------------------------------------------------------------------------

async function runSuite(index, bootSnap, scratch, projectBefore) {
	const run = {
		index,
		startedAt: new Date().toISOString(),
		startedMs: Date.now(),
		checks: [],
		screenshots: [],
		measurements: [],
		notDriven: [],
		fixtures: {},
		failures: [],
		exitCode: 1,
		console: { errors: [], warnings: [], unhandledRejections: [] },
		board: { before: { tickets: -1, thoughts: -1, members: -1, ticketIds: [] } },
		labels: { en: {}, zh: {} },
	}
	actionLog = []
	const consoleMark = app.console.length
	let cleanupDone = false
	scratchWorkspaceId = scratch.id
	evidence.board.probeWorkspaceId = scratch.id

	// AC8: documentation anchors for this probe.
	try {
		const readme = await readFile(join(REPO, 'README.md'), 'utf8')
		const spec = await readFile(join(REPO, 'docs', 'SHARED_BUILD_SPEC.md'), 'utf8')
		record(run, 'AC8/readme', 'README ## Tests documents the probe command and output location', readme.includes('node tools/kb64-probe.js') && readme.includes('docs/screenshots/kb64/'), { command: readme.includes('node tools/kb64-probe.js'), evidence: readme.includes('docs/screenshots/kb64/') })
		record(run, 'AC8/spec', 'docs/SHARED_BUILD_SPEC.md Verification (Host) documents the probe coverage and evidence path', spec.includes('tools/kb64-probe.js') && spec.includes('docs/screenshots/kb64/') && /KB-64 verification/.test(spec), { command: spec.includes('tools/kb64-probe.js'), evidence: spec.includes('docs/screenshots/kb64/') })
	} catch (error) {
		record(run, 'AC8/readme', 'README ## Tests documents the probe command and output location', false, String((error && error.message) || error))
		record(run, 'AC8/spec', 'docs/SHARED_BUILD_SPEC.md Verification (Host) documents the probe coverage and evidence path', false, String((error && error.message) || error))
	}

	// AC1: no npm dependency.
	try {
		const imports = await probeImportCheck()
		record(run, 'AC1/nodeOnly', 'the probe imports only Node built-ins and tools/cdp.mjs (no npm install)', imports.specifiers.length > 0 && imports.foreign.length === 0, { imports: imports.specifiers, foreign: imports.foreign })
	} catch (error) {
		record(run, 'AC1/nodeOnly', 'the probe imports only Node built-ins and tools/cdp.mjs (no npm install)', false, String((error && error.message) || error))
	}

	try {
		// Reset to a known state: English, light, panel open.
		await setViewport(1440, 900)
		await installErrorCapture()
		await dismissNotices()
		await dismissAppModals()
		await openPanel()
		const english = await setLanguage('English')
		record(run, 'setup/english', 'the shell runs in English before the probe', english.ok === true, english.steps)
		const light = await setTheme('light')
		record(run, 'setup/light', 'the shell runs in the light theme before the probe', light === true && (await currentTheme()) === 'light', { light, source: await currentTheme() })

		// AC2: scratch board selection and before counts.
		const scratchNow = (bootSnap.projects || []).find((project) => project.title === PROBE_PROJECT)
		record(run, 'setup/scratchBoard', 'the ' + PROBE_PROJECT + ' scratch board is registered', Boolean(scratchNow), scratchNow && { id: scratchNow.id, path: scratchNow.path })
		await selectWorkspace(scratch.id)
		let title = await clientProjectTitle()
		if (title !== PROBE_PROJECT) {
			await selectProject(PROBE_PROJECT)
			title = await clientProjectTitle()
		}
		record(run, 'setup/clientSelected', 'the client panel renders the scratch board', title === PROBE_PROJECT, title)
		let before = await rawState(scratch.id)
		if (before.board && before.board.paused === true) {
			const resumed = await pageAction('resumeBoard', {}, scratch.id)
			record(run, 'setup/unpaused', 'the scratch board starts unpaused (resumed for the probe)', resumed.ok === true, resumed.status)
			before = await rawState(scratch.id)
		} else {
			record(run, 'setup/unpaused', 'the scratch board starts unpaused', true, false)
		}

		// AC10: sweep fixtures leaked by an interrupted earlier run before the
		// before-snapshot, so a killed probe can never make the next run pass
		// with a polluted scratch board.
		const sweep = await sweepStaleFixtures(scratch.id)
		run.board.startupSweep = sweep
		evidence.board.startupSweep = sweep
		record(run, 'AC10/startupSweep', 'no kb64-probe-labelled fixture from an earlier run survives the startup sweep', sweep.remaining.length === 0, sweep)
		before = await rawState(scratch.id)
		const beforeCounts = countsOf(before)
		run.board.before = beforeCounts
		evidence.board.before = beforeCounts
		record(run, 'board/beforeCounts', 'the probe captured the scratch board ticket/thought/member counts before the run', beforeCounts.tickets >= 0 && beforeCounts.thoughts >= 0 && beforeCounts.members >= 0, beforeCounts)

		// Create fixtures.
		const createFixture = async (payload) => {
			const result = await pageAction('createTicket', payload, scratch.id)
			const ticket = result.ok && result.value && result.value.ticket ? result.value.ticket : null
			if (!ticket || typeof ticket.id !== 'string') throw new Error('createTicket failed: ' + shortJson(result.error || result))
			return ticket
		}
		const main = await createFixture({ title: 'KB-64 fixture: PRD read/edit/hostile', type: 'story', priority: 'high', labels: ['kb64-probe'], description: MAIN_SOURCE })
		run.fixtures.main = main.id
		await pageAction('comment', { ticketId: main.id, text: COMMENT_SOURCE }, scratch.id)
		const hostile = await createFixture({ title: 'KB-64 fixture: hostile HTML', type: 'story', priority: 'medium', labels: ['kb64-probe'], description: HOSTILE_SOURCE })
		run.fixtures.hostile = hostile.id
		await pageAction('comment', { ticketId: hostile.id, text: HOSTILE_COMMENT }, scratch.id)
		const empty = await createFixture({ title: 'KB-64 fixture: empty description', type: 'task', priority: 'low', labels: ['kb64-probe'], description: '   \n\t  ' })
		run.fixtures.empty = empty.id
		const epic = await createFixture({ title: 'KB-64 fixture: empty EPIC PRD', type: 'epic', priority: 'low', labels: ['kb64-probe'], description: '   ' })
		run.fixtures.epic = epic.id
		run.fixtures.thought = THOUGHT_FIXTURE.id
		evidence.board.fixtureIds = { ...run.fixtures }
		evidence.fixtures = [
			{ surface: 'main', source: 'createTicket + comment', id: run.fixtures.main },
			{ surface: 'hostile', source: 'createTicket + comment', id: run.fixtures.hostile },
			{ surface: 'empty', source: 'createTicket', id: run.fixtures.empty },
			{ surface: 'epic', source: 'createTicket', id: run.fixtures.epic },
			{ surface: 'thoughts', source: 'fetch-shim (/kanban/state), read-only, removed before cleanup', id: THOUGHT_FIXTURE.id },
			{ surface: 'scan-vision', source: 'fetch-shim (/kanban/action scan), read-only', reason: 'the scratch project reports 0 scanned docs, so the real scan returns vision:null; the real scan drawer is still driven' },
		]
		const scratchDocs = before.board && before.board.meta && Array.isArray(before.board.meta.docs) ? before.board.meta.docs.length : null
		run.notDriven.push({
			surface: 'scan-vision (live data)',
			reason:
				'the scratch project ' + scratch.path + ' reports ' + (scratchDocs === null ? 'no' : String(scratchDocs)) + ' scanned docs in board.meta.docs, so the real scan action returns vision:null. The real scan drawer is driven; only its action response is fulfilled with a read-only Markdown vision fixture (window.fetch shim), matching the KB-61 precedent.',
		})
		record(run, 'AC2/created', 'the probe created the scratch-board fixtures', [run.fixtures.main, run.fixtures.hostile, run.fixtures.empty, run.fixtures.epic].every((id) => typeof id === 'string' && id.length > 0), { ...run.fixtures })

		const stored = await rawState(scratch.id)
		const storedMain = ticketById(stored, run.fixtures.main)
		const storedHostile = ticketById(stored, run.fixtures.hostile)
		const storedEmpty = ticketById(stored, run.fixtures.empty)
		const storedEpic = ticketById(stored, run.fixtures.epic)
		const storedComments = storedMain && Array.isArray(storedMain.comments) ? storedMain.comments : []
		record(run, 'AC2/fixturesStored', 'the host stored the exact Markdown source, whitespace and EPIC type', Boolean(storedMain && storedHostile && storedEmpty && storedEpic) && storedMain.description === MAIN_SOURCE && storedHostile.description === HOSTILE_SOURCE && storedEmpty.description.trim() === '' && storedEpic.description.trim() === '' && storedEpic.type === 'epic', {
			mainLength: storedMain ? storedMain.description.length : null,
			hostileLength: storedHostile ? storedHostile.description.length : null,
			emptyTrimmed: storedEmpty ? storedEmpty.description.trim().length : null,
			epicTrimmed: storedEpic ? storedEpic.description.trim().length : null,
			epicType: storedEpic ? storedEpic.type : null,
		})
		record(run, 'AC2/commentStored', 'the host stored the Markdown comments (comment bodies are trimmed by the host)', storedComments.some((comment) => comment.text === COMMENT_SOURCE.trim()) && Boolean(storedHostile) && Array.isArray(storedHostile.comments) && storedHostile.comments.some((comment) => comment.text === HOSTILE_COMMENT.trim()), { main: storedComments.length, hostile: storedHostile && Array.isArray(storedHostile.comments) ? storedHostile.comments.length : null })

		// Capture matrix.
		await lightMatrix(run)
		await darkMatrix(run)
		await thoughtsMatrix(run)
		await scanMatrix(run)

		// AC6: locale observations through the real Settings -> Language control.
		await setTheme('light')
		await setViewport(1440, 900)
		const en = await observeLocale('en', run)
		run.labels.en = en
		for (const key of Object.keys(EXPECTED_KEYS)) {
			record(run, `AC6/en-${key}`, `en renders ${key}`, localeValueOk(key, 'en', en[key]), { observed: en[key], expected: EXPECTED_KEYS[key].en })
		}
		const toZh = await setLanguage('中文')
		record(run, 'AC6/zhSwitch', 'the real Settings -> Language control switches the shell to Chinese', toZh.ok === true, toZh.steps)
		const zh = await observeLocale('zh', run)
		run.labels.zh = zh
		for (const key of Object.keys(EXPECTED_KEYS)) {
			record(run, `AC6/zh-${key}`, `zh renders ${key}`, localeValueOk(key, 'zh', zh[key]), { observed: zh[key], expected: EXPECTED_KEYS[key].zh })
		}
		const zhShots = await Promise.all(['read-1440-light-zh.png', 'comments-1440-light-zh.png', 'thoughts-expanded-1440-light-zh.png', 'scan-vision-1440-light-zh.png'].map(async (name) => {
			try {
				return { name, bytes: (await stat(join(OUT_DIR, name))).size }
			} catch {
				return { name, bytes: 0 }
			}
		}))
		record(run, 'AC6/zhEvidence', 'zh PNG evidence exists for read, comments, expanded Thoughts and scan vision', zhShots.every((entry) => entry.bytes > 0), zhShots)
		const toEn = await setLanguage('English')
		record(run, 'AC6/englishRestored', 'the shell is restored to English after the locale checks', toEn.ok === true, toEn.steps)
		await setTheme('light')

		// AC2: delete the main and hostile fixtures through the drawer.
		const mainDelete = await deleteThroughDrawer(run, run.fixtures.main)
		record(run, 'AC2/deleteThroughDrawer', 'the main fixture is deleted through the drawer Delete + Confirm delete', mainDelete.armed && mainDelete.confirmed && mainDelete.gone, mainDelete)
		if (!mainDelete.gone) throw new Error('main fixture ' + run.fixtures.main + ' survived the drawer delete')
		await setViewport(1440, 900)
		const hostileDelete = await deleteThroughDrawer(run, run.fixtures.hostile)
		record(run, 'AC2/deleteHostileThroughDrawer', 'the hostile fixture is deleted through the drawer Delete + Confirm delete', hostileDelete.armed && hostileDelete.confirmed && hostileDelete.gone, hostileDelete)

		// AC3: the required screenshot matrix is complete and labelled.
		const expected = []
		for (const surface of SURFACES) {
			for (const width of WIDTHS) expected.push(`${surface}-${width}-light`)
			for (const width of [1440, 1024]) expected.push(`${surface}-${width}-dark`)
		}
		const recorded = new Set(run.screenshots.filter((entry) => entry.lang === 'en').map((entry) => `${entry.surface}-${entry.width}-${entry.theme}`))
		const missing = expected.filter((name) => !recorded.has(name))
		const files = await Promise.all(expected.map(async (name) => {
			try {
				return { name, bytes: (await stat(join(OUT_DIR, name + '.png'))).size }
			} catch {
				return { name, bytes: 0 }
			}
		}))
		const badFiles = files.filter((entry) => entry.bytes === 0)
		record(run, 'AC3/matrixComplete', 'every required {surface}-{width}-{theme}.png exists for both themes and all three widths', missing.length === 0 && badFiles.length === 0, { expected: expected.length, missing, badFiles })
	} catch (error) {
		record(run, 'probe/completed', 'the suite ran every step without throwing', false, String((error && error.message) || error))
		console.error(error)
	} finally {
		// AC2/AC10: sweep survivors, restore state, verify counts.
		try {
			await removeShim()
			await closeDrawer()
			if (await currentTheme() === 'dark') await setTheme('light')
			for (const id of [run.fixtures.empty, run.fixtures.epic, run.fixtures.main, run.fixtures.hostile]) {
				if (!id) continue
				const surviving = ticketById(await rawState(scratch.id), id)
				if (surviving) await pageAction('deleteTicket', { ticketId: id }, scratch.id)
			}
			await sleep(800)
			const after = await rawState(scratch.id)
			const afterCounts = countsOf(after)
			run.board.after = afterCounts
			evidence.board.after = afterCounts
			const fixtureIds = Object.values(run.fixtures).filter((value) => typeof value === 'string' && value.startsWith('KB-'))
			const remaining = fixtureIds.filter((id) => ticketById(after, id))
			record(run, 'AC10/fixturesGone', 'all fixture tickets are gone from the scratch board', remaining.length === 0, { remaining, fixtureIds })
			record(run, 'AC10/boardCountsRestored', 'the scratch board ticket, thought and member counts equal the before values', afterCounts.tickets === run.board.before.tickets && afterCounts.thoughts === run.board.before.thoughts && afterCounts.members === run.board.before.members, { before: run.board.before, after: afterCounts })
			const beforeIds = [...run.board.before.ticketIds].sort()
			const afterIds = [...afterCounts.ticketIds].sort()
			const ticketIdsEqual = beforeIds.length === afterIds.length && beforeIds.every((id, index) => id === afterIds[index])
			record(run, 'AC10/ticketIdsIdentical', 'the full scratch board ticket id set is identical before and after', ticketIdsEqual, { before: beforeIds, after: afterIds })
			const probeLeft = await staleProbeTickets(scratch.id)
			record(run, 'AC10/noProbeTicketsLeft', 'no kb64-probe-labelled ticket remains on the scratch board', probeLeft.length === 0, probeLeft.map((ticket) => ticket.id))
			const foreignActions = actionLog.filter((entry) => entry.workspaceId !== scratch.id)
			const projectAfter = bootSnap.workspaceId === scratch.id ? projectBefore : await rawState(bootSnap.workspaceId)
			const projectAfterCounts = countsOf(projectAfter)
			run.board.projectAfter = projectAfterCounts
			evidence.board.projectAfter = projectAfterCounts
			const fixtureOnProject = fixtureIds.filter((id) => ticketById(projectAfter, id))
			record(run, 'AC10/projectBoardUntouched', 'every host action targeted the scratch board and no fixture exists on the project board', foreignActions.length === 0 && fixtureOnProject.length === 0, { foreignActions, fixtureOnProject, projectBefore: countsOf(projectBefore), projectAfter: projectAfterCounts, originalWorkspaceIsScratch: bootSnap.workspaceId === scratch.id })

			// Restore theme, language and workspace.
			const themeRestored = await setTheme('light')
			record(run, 'AC10/themeRestored', 'the light theme is restored', themeRestored === true && (await currentTheme()) === 'light', { themeRestored, source: await currentTheme() })
			const englishAgain = await setLanguage('English')
			record(run, 'AC10/languageRestored', 'English is restored', englishAgain.ok === true, englishAgain.steps)
			await selectWorkspace(bootSnap.workspaceId)
			const restoredTitle = await clientProjectTitle()
			const restoredPanel = await panelTitle()
			record(run, 'AC10/workspaceRestored', 'the previously selected workspace is restored', restoredTitle === bootSnap.project.title || restoredPanel === bootSnap.project.title, { restoredTitle, restoredPanel, expected: bootSnap.project.title })
			run.board.restored = { workspace: restoredTitle, theme: await currentTheme(), language: restoredPanel === 'Kanban' ? 'English' : restoredPanel, panelTitle: restoredPanel }
			await app.cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
			cleanupDone = true
		} catch (error) {
			record(run, 'AC10/cleanupError', 'cleanup completed without error', false, String((error && error.message) || error))
		}

		// AC4: console and unhandled rejections — any error or rejection fails the run.
		try {
			const entries = app.console.slice(consoleMark)
			const windowState = await app.evaluate('window.__kb64errors || { errors: [], rejections: [] }').catch(() => ({ errors: [], rejections: [] }))
			const errors = [
				...entries.filter((entry) => entry.type === 'error' || entry.type === 'exception').map((entry) => ({ type: entry.type, text: String(entry.text || '') })),
				...(windowState.errors || []).map((text) => ({ type: 'error', text: String(text) })),
			]
			const warnings = entries.filter((entry) => entry.type === 'warning').map((entry) => ({ type: 'warning', text: String(entry.text || '') }))
			const rejections = (windowState.rejections || []).map((text) => String(text))
			run.console = { errors, warnings, unhandledRejections: rejections }
			record(run, 'AC4/consoleErrors', 'no console error or uncaught exception is recorded during the run', errors.length === 0, { errors: errors.slice(0, 5), warnings: warnings.length })
			record(run, 'AC4/unhandledRejections', 'no unhandled promise rejection is recorded during the run', rejections.length === 0, rejections.slice(0, 5))
			record(run, 'AC4/warningsReported', 'console warnings are reported in the evidence JSON and do not fail the run', warnings.every((entry) => typeof entry.text === 'string'), { count: warnings.length, warnings: warnings.slice(0, 5) })
		} catch (error) {
			record(run, 'AC4/consoleErrors', 'no console error is recorded during the run', false, String((error && error.message) || error))
		}

		run.board.actions = actionLog.slice()
		run.board.cleanupDone = cleanupDone
		run.finishedAt = new Date().toISOString()
		run.durationMs = Date.now() - run.startedMs
		run.failures = run.checks
			.filter((check) => check.pass !== true)
			.map((check) => ({
				check: check.id,
				surface: surfaceOfCheck(check.id),
				expected: check.name,
				actual: check.detail,
				screenshot: screenshotForCheck(run, check.id),
				message: check.id + ': ' + check.name,
			}))
		run.exitCode = run.failures.length === 0 ? 0 : 1
	}
	return run
}

function surfaceOfCheck(id) {
	// AC2 draft/preview proofs belong to the edit surface even though the id does
	// not spell it out; map them before the generic surface regex.
	if (/^AC2\/(draft|preview|edit)/.test(id)) return 'edit'
	if (/^AC2\/read/.test(id)) return 'read'
	if (/^AC2\/comment/.test(id)) return 'comments'
	if (/^AC2\/hostile/.test(id)) return 'hostile'
	const match = /(read|edit|comments|hostile|thoughts-collapsed|thoughts-expanded|scan-vision)/.exec(id)
	if (match) return match[1]
	if (/locale|AC6|zh/.test(id)) return 'locale'
	if (/cleanup|AC10/.test(id)) return 'cleanup'
	if (/console|AC4/.test(id)) return 'console'
	if (/readme|spec|AC8/.test(id)) return 'documentation'
	if (/nodeOnly|AC1/.test(id)) return 'probe'
	return 'probe'
}

const REPRESENTATIVE_SHOT = {
	read: 'read-1440-light.png',
	edit: 'edit-1440-light.png',
	comments: 'comments-1440-light.png',
	hostile: 'hostile-1440-light.png',
	'thoughts-collapsed': 'thoughts-collapsed-1440-light.png',
	'thoughts-expanded': 'thoughts-expanded-1440-light.png',
	'scan-vision': 'scan-vision-1440-light.png',
	locale: 'read-1440-light-zh.png',
}

function screenshotForCheck(run, id) {
	const match = /(read|edit|comments|hostile|thoughts-collapsed|thoughts-expanded|scan-vision)-(\d+)-(light|dark)/.exec(id)
	if (match) {
		const entry = run.screenshots.find((shotEntry) => shotEntry.surface === match[1] && shotEntry.width === Number(match[2]) && shotEntry.theme === match[3] && shotEntry.lang === 'en')
		if (entry) return entry.path
	}
	// Non-visual checks still name the surface that owns them; attach its
	// representative labelled PNG so the failure carries an openable artifact.
	const surface = surfaceOfCheck(id)
	const file = REPRESENTATIVE_SHOT[surface]
	if (file) {
		const representative = run.screenshots.find((shotEntry) => shotEntry.path.endsWith(file))
		if (representative) return representative.path
	}
	// Console/cleanup checks have no dedicated capture; point the failure at the
	// last surface the run captured so the reviewer still has an artifact to open.
	if (surface === 'console' || surface === 'cleanup') {
		const lastShot = run.screenshots[run.screenshots.length - 1]
		return lastShot ? lastShot.path : null
	}
	return null
}

// ---------------------------------------------------------------------------
// Evidence assembly and schema
// ---------------------------------------------------------------------------

function validateEvidenceShape(value) {
	const issues = []
	const required = ['url', 'build', 'widths', 'themes', 'checks', 'timings', 'console', 'board', 'screenshots', 'notDriven', 'failures']
	for (const key of required) if (!(key in value)) issues.push('missing ' + key)
	if (!value.build || typeof value.build.version !== 'string' || typeof value.build.commit !== 'string' || typeof value.build.dirty !== 'boolean') issues.push('build {version, commit, dirty}')
	if (!Array.isArray(value.checks) || value.checks.some((check) => typeof check.id !== 'string' || typeof check.name !== 'string' || typeof check.pass !== 'boolean' || !('detail' in check))) issues.push('checks[] {id, name, pass, detail}')
	if (!value.timings || !value.timings.startedAt || !value.timings.finishedAt || typeof value.timings.durationMs !== 'number') issues.push('timings {startedAt, finishedAt, durationMs}')
	if (!value.console || !Array.isArray(value.console.errors) || !Array.isArray(value.console.warnings)) issues.push('console {errors, warnings}')
	if (!value.board || !('before' in value.board) || !('after' in value.board) || !('fixtureIds' in value.board) || !('cleanupDone' in value.board)) issues.push('board {before, after, fixtureIds, cleanupDone}')
	if (!Array.isArray(value.screenshots) || value.screenshots.some((entry) => typeof entry.surface !== 'string' || typeof entry.width !== 'number' || typeof entry.theme !== 'string' || typeof entry.path !== 'string')) issues.push('screenshots[] {surface, width, theme, path}')
	if (!Array.isArray(value.notDriven) || value.notDriven.some((entry) => typeof entry.surface !== 'string' || typeof entry.reason !== 'string')) issues.push('notDriven[] {surface, reason}')
	if (!Array.isArray(value.failures)) issues.push('failures[]')
	return issues
}

function assembleEvidence() {
	const last = runs[runs.length - 1]
	evidence.checks = last ? last.checks : []
	evidence.screenshots = last ? last.screenshots : []
	evidence.measurements = last ? last.measurements : []
	evidence.notDriven = last ? last.notDriven : []
	evidence.console = last ? last.console : evidence.console
	evidence.board.actions = last ? last.board.actions : []
	evidence.board.cleanupDone = Boolean(last && last.board.cleanupDone)
	evidence.board.restored = last ? last.board.restored : null
	if (runs.length > 0) evidence.failures = runs.flatMap((run) => run.failures)
	evidence.runs = runs.map((run) => ({
		index: run.index,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		durationMs: run.durationMs,
		exitCode: run.exitCode,
		checks: run.checks.length,
		failures: run.failures.length,
		checkIdsHash: createHash('sha256').update(run.checks.map((check) => check.id).join('|')).digest('hex'),
		board: { before: run.board.before, after: run.board.after, cleanupDone: run.board.cleanupDone },
	}))
}

function refreshFailures() {
	for (const run of runs) {
		run.failures = run.checks
			.filter((check) => check.pass !== true)
			.map((check) => ({
				check: check.id,
				surface: surfaceOfCheck(check.id),
				expected: check.name,
				actual: check.detail,
				screenshot: screenshotForCheck(run, check.id),
				message: check.id + ': ' + check.name,
			}))
		run.exitCode = run.failures.length === 0 ? 0 : 1
	}
}

async function writeEvidence() {
	assembleEvidence()
	await mkdir(OUT_DIR, { recursive: true })
	await writeFile(OUT_JSON, JSON.stringify(evidence, null, 2))
}

/**
 * AC7: prove the JSON and the PNGs come from the same final invocation. Every
 * screenshots[].bytes is re-stated from the file on disk (not the capture-time
 * value) and mismatches fail the run; a stale pack can no longer look green.
 */
async function verifyScreenshotFiles(shots) {
	const results = []
	for (const entry of shots) {
		let actualBytes = -1
		let mtimeMs = null
		try {
			const info = await stat(join(REPO, entry.path))
			actualBytes = info.size
			mtimeMs = info.mtimeMs
		} catch {
			actualBytes = -1
		}
		results.push({
			path: entry.path,
			surface: entry.surface,
			width: entry.width,
			theme: entry.theme,
			lang: entry.lang,
			recordedBytes: entry.bytes,
			actualBytes,
			mtimeMs,
			match: actualBytes === entry.bytes,
		})
	}
	return results
}

/**
 * A hard-killed run leaves this marker behind, so a stale JSON cannot pass for
 * evidence from the final invocation. Normal exits remove it synchronously.
 */
async function markRunStarted() {
	await writeFile(OUT_MARKER, JSON.stringify({ ticket: 'KB-64', startedAt: PROCESS_STARTED.toISOString(), pid: process.pid, build: evidence.build }, null, 2))
	process.once('exit', () => {
		try {
			unlinkSync(OUT_MARKER)
		} catch {
			// no marker (already removed by a hard kill or an earlier exit)
		}
	})
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function readBuild() {
	let version = 'unknown'
	try {
		version = JSON.parse(await readFile(join(REPO, 'package.json'), 'utf8')).version || 'unknown'
	} catch {
		// keep unknown
	}
	let sha = ''
	let dirty = false
	try {
		const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO })
		sha = head.stdout.trim()
		const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: REPO })
		dirty = status.stdout.trim().length > 0
	} catch {
		// git unavailable: prove honestly that the build is unknown
	}
	return { version, commit: sha.slice(0, 12), sha, dirty }
}

function printFailures() {
	if (evidence.failures.length === 0) return
	console.log('\nFAILURE LIST (one line per failure):')
	for (const failure of evidence.failures) {
		console.log(`FAIL ${failure.surface}: expected ${failure.expected} — actual ${shortJson(failure.actual, 300)} — screenshot ${failure.screenshot || 'n/a'}${failure.message ? ' — ' + failure.message : ''}`)
	}
}

async function main() {
	await mkdir(OUT_DIR, { recursive: true })
	evidence.build = await readBuild()
	await markRunStarted()
	console.log(`KB-64 cross-surface probe — ${evidence.build.commit || 'unknown commit'}${evidence.build.dirty ? ' (dirty tree)' : ''}`)
	console.log(`GUI ${APP_URL || '(unset)'} · CDP ${CDP_PORT} · runs ${RUNS_REQUESTED} · evidence docs/screenshots/kb64/`)
	const ok = await checkEnvironment()
	if (!ok) {
		evidence.timings.finishedAt = new Date().toISOString()
		evidence.timings.durationMs = Date.now() - PROCESS_STARTED.getTime()
		evidence.failures = processFailures
		await writeEvidence()
		printFailures()
		process.exit(1)
	}

	await dismissStrayTargets()
	try {
		app = await attach()
	} catch (error) {
		const message = String((error && error.message) || error)
		evidence.failures = [{
			surface: 'environment',
			expected: 'a live Chrome page target on CDP port ' + CDP_PORT,
			actual: message,
			screenshot: null,
			message: /no Chrome page target/i.test(message)
				? 'Chrome is running but exposes no page target. Open one tab in the headless Chrome (see tools/README.md) and re-run.'
				: 'Could not attach to Chrome over CDP: ' + message + '. Launch headless Chrome with --remote-debugging-port=' + CDP_PORT + ' (see tools/README.md) and re-run.',
		}]
		evidence.timings.finishedAt = new Date().toISOString()
		evidence.timings.durationMs = Date.now() - PROCESS_STARTED.getTime()
		await writeEvidence()
		printFailures()
		process.exit(1)
	}

	try {
		await app.ensureApp({ reload: true })
	} catch (error) {
		evidence.failures = [{
			surface: 'environment',
			expected: 'the GUI shell loads with a browser-session cookie',
			actual: String((error && error.message) || error),
			screenshot: null,
			message:
				'Could not load the GUI shell. Check that DSH_WEB_URL points at the running GUI and that $DSH_HOME/.credentials.yaml holds the browser-session secret (set DSH_HOME to the running Harness profile). Underlying: ' +
				String((error && error.message) || error),
		}]
		evidence.timings.finishedAt = new Date().toISOString()
		evidence.timings.durationMs = Date.now() - PROCESS_STARTED.getTime()
		await writeEvidence()
		printFailures()
		process.exit(1)
	}

	await installErrorCapture()
	await setViewport(1440, 900)

	// Process-level snapshots: the project board must never be written by the probe.
	let bootSnap = null
	try {
		bootSnap = await rawState('')
	} catch (error) {
		bootSnap = null
	}
	if (!bootSnap || !Array.isArray(bootSnap.projects) || !bootSnap.project) {
		evidence.failures = [{
			surface: 'environment',
			expected: '/kanban/state returns the project list',
			actual: bootSnap ? shortJson(bootSnap) : 'no response',
			screenshot: null,
			message: 'The GUI loaded but /kanban/state did not return a project list. Check the Kanban host plugin is installed and the GUI is connected to it.',
		}]
		evidence.timings.finishedAt = new Date().toISOString()
		evidence.timings.durationMs = Date.now() - PROCESS_STARTED.getTime()
		await writeEvidence()
		printFailures()
		process.exit(1)
	}
	const scratch = (bootSnap.projects || []).find((project) => project.title === PROBE_PROJECT)
	if (!scratch) {
		evidence.failures = [{
			surface: 'environment',
			expected: 'the ' + PROBE_PROJECT + ' scratch board is registered',
			actual: (bootSnap.projects || []).map((project) => project.title).join(', '),
			screenshot: null,
			message: 'The ' + PROBE_PROJECT + ' scratch board is not registered. Register it (or restore the kb58/kb59 scratch board) so the probe never mutates the project board, then re-run.',
		}]
		evidence.timings.finishedAt = new Date().toISOString()
		evidence.timings.durationMs = Date.now() - PROCESS_STARTED.getTime()
		await writeEvidence()
		printFailures()
		process.exit(1)
	}
	evidence.board.probeWorkspaceId = scratch.id
	const projectBefore = await rawState(bootSnap.workspaceId)
	evidence.board.projectBefore = countsOf(projectBefore)

	for (let index = 1; index <= RUNS_REQUESTED; index += 1) {
		console.log(`\n=== KB-64 run ${index}/${RUNS_REQUESTED} ===`)
		const run = await runSuite(index, bootSnap, scratch, projectBefore)
		runs.push(run)
		console.log(`run ${index}: ${run.checks.length} checks, ${run.failures.length} failed, exit ${run.exitCode}, ${run.durationMs} ms`)
	}

	// Determinism (AC10): both runs must pass with identical check ids.
	const firstIds = runs[0].checks.map((check) => check.id)
	const sameIds = runs.every((run) => run.checks.length === firstIds.length && run.checks.every((check, index) => check.id === firstIds[index]))
	const differing = []
	const longest = Math.max(...runs.map((run) => run.checks.length))
	for (let index = 0; index < longest; index += 1) {
		const ids = runs.map((run) => (run.checks[index] ? run.checks[index].id : null))
		if (ids.some((id) => id !== ids[0])) differing.push({ index, ids })
	}
	const allPassed = runs.every((run) => run.failures.length === 0)
	evidence.determinism = {
		runs: runs.length,
		idsEqual: sameIds,
		differingIds: differing.slice(0, 10),
		allRunsPassed: allPassed,
		note: runs.length > 1 ? 'check ids are derived from acceptance criteria and the capture matrix, never timestamps' : 'single run (--runs=1): determinism not compared',
	}
	for (const run of runs) {
		record(run, 'AC10/checkIdsIdentical', 'two consecutive runs produce the same checks[].id set', runs.length > 1 ? sameIds : true, { runs: runs.length, differing: differing.slice(0, 10) })
	}
	refreshFailures()

	// AC7: the PNGs on disk must be the ones this JSON describes. Re-stat every
	// captured file and fail on any byte-count mismatch, so a stale pack from an
	// earlier invocation can no longer look green.
	const finalRun = runs[runs.length - 1]
	const fileCheck = await verifyScreenshotFiles(finalRun ? finalRun.screenshots : [])
	const mismatched = fileCheck.filter((entry) => entry.match !== true)
	const latestPngMtimeMs = fileCheck.reduce((max, entry) => (entry.mtimeMs !== null && entry.mtimeMs > max ? entry.mtimeMs : max), 0)
	evidence.consistency = {
		verifiedAt: new Date().toISOString(),
		files: fileCheck.length,
		allBytesMatch: mismatched.length === 0,
		latestPngMtimeMs,
		jsonWriteStartedAt: null,
		jsonMtimeMs: null,
		jsonAfterScreenshots: null,
		screenshots: fileCheck,
	}
	for (const run of runs) {
		record(run, 'AC7/screenshotBytesMatch', 'every screenshots[].bytes in the JSON equals the PNG byte count on disk', mismatched.length === 0, { files: fileCheck.length, mismatched: mismatched.slice(0, 5) })
	}
	refreshFailures()

	// AC7: evidence shape, then AC9: failures carry a surface/expected/actual/screenshot.
	const shapeProbe = {
		...evidence,
		checks: runs.length > 0 ? runs[0].checks : [],
		screenshots: runs.length > 0 ? runs[0].screenshots : [],
		notDriven: runs.length > 0 ? runs[0].notDriven : [],
		build: evidence.build,
		timings: { startedAt: evidence.timings.startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - PROCESS_STARTED.getTime() },
		failures: runs.flatMap((run) => run.failures),
	}
	const shapeIssues = validateEvidenceShape(shapeProbe)
	const failureFormatOk = shapeProbe.failures.every((failure) => typeof failure.surface === 'string' && typeof failure.expected === 'string' && 'actual' in failure && 'screenshot' in failure)
	for (const run of runs) {
		record(run, 'AC7/evidenceSchema', 'the evidence JSON carries every required field', shapeIssues.length === 0, shapeIssues.length === 0 ? { fields: 'url, build, widths, themes, checks, timings, console, board, screenshots, notDriven, failures' } : shapeIssues)
		record(run, 'AC9/failureFormat', 'every failure names its surface, expected vs actual and screenshot path', failureFormatOk, { failures: shapeProbe.failures.length })
	}
	refreshFailures()

	evidence.timings.finishedAt = new Date().toISOString()
	evidence.timings.durationMs = Date.now() - PROCESS_STARTED.getTime()
	evidence.consistency.jsonWriteStartedAt = new Date().toISOString()
	await writeEvidence()
	// Prove the written JSON postdates every PNG it describes (same invocation).
	const writtenJson = await stat(OUT_JSON)
	evidence.consistency.jsonMtimeMs = writtenJson.mtimeMs
	evidence.consistency.jsonAfterScreenshots = writtenJson.mtimeMs >= evidence.consistency.latestPngMtimeMs
	await writeEvidence()

	const failed = evidence.failures.length
	console.log('\ncommit      ' + (evidence.build.commit || 'unknown') + (evidence.build.dirty ? ' (dirty)' : ''))
	console.log('evidence    ' + relative(REPO, OUT_JSON))
	console.log('screenshots ' + evidence.screenshots.length)
	console.log('checks      ' + evidence.checks.filter((check) => check.pass).length + '/' + evidence.checks.length + ' passed, ' + failed + ' failed')
	if (runs.length > 1) console.log('determinism ' + (sameIds ? 'check ids identical' : 'CHECK IDS DIFFER') + ' across ' + runs.length + ' runs; exit codes ' + runs.map((run) => run.exitCode).join(', '))
	printFailures()
	console.log('\n' + (failed === 0 ? 'ALL KB-64 PROBE CHECKS PASSED' : failed + ' KB-64 PROBE FAILURE(S)'))
	process.exit(failed === 0 ? 0 : 1)
}

main().catch(async (error) => {
	console.error('[kb64-probe] unexpected error: ' + String((error && error.stack) || error))
	evidence.failures = [{
		surface: 'probe',
		expected: 'the probe completes',
		actual: String((error && error.message) || error),
		screenshot: null,
		message: 'unexpected probe error: ' + String((error && error.message) || error),
	}]
	evidence.timings.finishedAt = new Date().toISOString()
	evidence.timings.durationMs = Date.now() - PROCESS_STARTED.getTime()
	try {
		await writeEvidence()
	} catch {
		// evidence is best effort here
	}
	printFailures()
	process.exit(1)
})
