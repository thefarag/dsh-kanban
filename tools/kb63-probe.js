/**
 * KB-63 verification probe — polling performance budget, link/image policy and
 * the memoization contract on the real GUI.
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) and
 * asserts the KB-63 acceptance contract end to end:
 *   AC6  a real ticket drawer opened with a ~20k-character PRD, while the board
 *        polls at POLL_MS = 2500, is measured with `Performance.enable` +
 *        `Performance.getMetrics` across a 6 s window (>= 2 poll cycles):
 *        ScriptDuration delta < 0.05 s and LayoutCount delta < 100. The JSON
 *        records both deltas, the poll count (a wrapped `window.fetch` counting
 *        `kanban/state` calls), the PRD length and the Network events, and
 *        asserts that no request is made to the fixture image URL.
 *   AC7  in a second 6 s window the same drawer is profiled with
 *        `Profiler.enable/start/stop`; zero samples may land in the parse
 *        functions (`parseMarkdown` / `markdownParse*`) while >= 2 polls happen,
 *        proving the memoized MarkdownBody does not re-parse the 20k PRD on each
 *        poll. The `.kb-md` node identity is recorded across both windows.
 *   Policy (live)  the PRD carries a safe https link, a `javascript:` link, a
 *        safe image Markdown URL and a raw `<img>`; the rendered read view must
 *        keep the safe anchor with target/rel, render the hostile link label
 *        with no anchor, render the image as an anchor labelled with its alt and
 *        never create an `<img>`/script/iframe element or a request.
 *
 * Fixture strategy: one real host ticket on the `default-workspace` scratch
 * board (the kb5/kb58/kb59 convention) created and deleted through real host
 * actions, with the previously selected workspace restored at the end. Nothing
 * is injected into the render path: the drawer, the CSS, the poll loop and the
 * MarkdownBody are the shipped ones.
 *
 * Writes docs/screenshots/kb63/final-verification.json plus one labelled PNG.
 *
 * Usage (Chrome on CDP port 9333, GUI URL in $DSH_WEB_URL):
 *   node tools/kb63-probe.js
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { attach } from './cdp.mjs'

const OUT_URL = new URL('../docs/screenshots/kb63/', import.meta.url)
const OUT = OUT_URL.pathname
const PROJECT_FILE = '../docs/screenshots/kb63/final-verification.json'
const PROBE_PROJECT = 'default-workspace'
const WINDOW_MS = 6000
const POLL_MS = 2500
const IMAGE_URL = 'https://kb63.invalid/fixture-image.png'
const RAW_IMAGE_URL = 'https://kb63.invalid/raw-image.png'
const SAFE_LINK_URL = 'https://example.com/shared-build-spec'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = {
	meta: {},
	checks: [],
	measurements: {},
	screenshots: [],
	network: { requests: [], fixtureImageRequests: [], imageRequests: [], stateRequests: [] },
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
// The ~20k-character PRD fixture (deterministic, <= the 20,000 host cap)
// ---------------------------------------------------------------------------

function buildPrd() {
	const headings = [
		'Vision',
		'Problem',
		'Users',
		'Jobs to be done',
		'Success metrics',
		'Scope in',
		'Scope out',
		'Acceptance criteria',
		'Risks',
		'Dependencies',
		'Rollout',
		'Open questions',
	]
	const section = (index) =>
		[
			`Section ${index} keeps **bold**, *em*, ~~strike~~ and \`inline code\` inside a realistic PRD.`,
			'',
			`A second paragraph links to [spec ${index}](https://example.com/prd/${index}) and keeps an entity &amp; plus <https://example.com/auto>.`,
			'',
			'- bullet one',
			'- bullet two',
			'  - nested bullet',
			'- [x] completed task',
			'- [ ] open task',
			'',
			'| Column A | Column B |',
			'| :--- | ---: |',
			'| value 1 | value 2 |',
			'',
			'```js',
			'const section = ' + index,
			'const markdown = true',
			'```',
			'',
		].join('\n')
	const intro = [
		'# EPIC PRD — KB-63 polling fixture',
		'',
		'KB63-PRD-MARKER — untrusted Markdown opened in a real ticket drawer while the board polls every 2.5 s.',
		'',
		`Read [the shared build spec](${SAFE_LINK_URL}) before you reply.`,
		'',
		`A hostile [hostile link](javascript:window.__kb63xss=true) and an ![fixture image](${IMAGE_URL})`,
		`plus a relative ![local image](./local-image.png) and raw <img src="${RAW_IMAGE_URL}" onerror="window.__kb63xss=true"> text.`,
		'',
	].join('\n')
	let prd = intro
	let index = 0
	while (prd.length < 19500) {
		prd += `## ${headings[index % headings.length]}\n\n${section(index)}\n`
		index += 1
	}
	// Fill to exactly the 20,000-character description cap so "20k-char PRD"
	// is literal, not approximate. Whole words keep the text layout-safe.
	while (prd.length < 20000) {
		const remaining = 20000 - prd.length
		prd += 'KB63 '.repeat(Math.ceil(remaining / 5)).slice(0, remaining)
	}
	return prd
}

const PRD = buildPrd()
// Markdown markers, list bullets, table pipes, fence delimiters and link
// destinations are stripped from the rendered text, so the read view keeps
// well over half of the source characters. Used only as a "the drawer really
// rendered the whole PRD" floor — never as a timing ceiling.
const MIN_RENDERED_TEXT = Math.floor(PRD.length / 2)

// ---------------------------------------------------------------------------
// Page helpers (same conventions as tools/kb59-probe.js)
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

async function setViewport(width, height = 768) {
	await app.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
	await sleep(700)
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

async function shot(name) {
	await dismissAppModals()
	await clearToasts()
	const path = `${OUT}${name}.png`
	await app.screenshot(path)
	console.log('SHOT ' + name)
	return path
}

async function waitFor(expression, label, timeoutMs = 12000) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		const value = await app.evaluate(`(() => { try { return !!(${expression}); } catch (error) { return false } })()`).catch(() => false)
		if (value) return true
		await sleep(200)
	}
	throw new Error('timeout waiting for ' + label)
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

const drawerOpen = () => app.evaluate('!!document.querySelector(".kb-drawer")')

async function closeDrawer() {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		if (!(await drawerOpen())) return true
		await app.key('Escape')
		await sleep(350)
	}
	return !(await drawerOpen())
}

/** Plain DOM click (focus semantics are not under test here). */
async function openTicket(id) {
	const expr = `document.querySelector('.kb-card[data-ticket="${id}"]')`
	await app.evaluate(`(() => { const c = ${expr}; if (c) c.scrollIntoView({ block: 'center', inline: 'center' }); return true })()`)
	await sleep(250)
	await closeDrawer()
	const clicked = await app.evaluate(`(() => { const c = ${expr}; if (!c) return false; c.click(); return true })()`)
	if (!clicked) throw new Error('card ' + id + ' not found')
	await waitFor(`document.querySelector('.kb-drawer[aria-label*="${id}"]')`, 'drawer ' + id)
	await sleep(600)
	return true
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

const rawState = () =>
	app.evaluate(`(async () => {
		const call = (window.__kb63 && window.__kb63.realFetch) || window.fetch;
		const response = await call.call(window, 'kanban/state', {
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

const ticketById = (state, id) => {
	const tickets = state && state.board && Array.isArray(state.board.tickets) ? state.board.tickets : []
	return tickets.find((ticket) => ticket && ticket.id === id) || null
}

// ---------------------------------------------------------------------------
// Wrapped fetch poll counter (AC6: poll count)
// ---------------------------------------------------------------------------

const installFetchCounter = () =>
	app.evaluate(`(() => {
		if (window.__kb63 && window.__kb63.realFetch) return true;
		const real = window.fetch;
		window.__kb63 = { realFetch: real, statePolls: 0, calls: [] };
		window.fetch = function (input, init) {
			const url = typeof input === 'string' ? input : (input && input.url) || '';
			window.__kb63.calls.push(url);
			if (url.indexOf('kanban/state') !== -1) window.__kb63.statePolls += 1;
			return real.call(this, input, init);
		};
		return true;
	})()`)

const removeFetchCounter = () =>
	app.evaluate(`(() => {
		if (window.__kb63 && window.__kb63.realFetch) window.fetch = window.__kb63.realFetch;
		window.__kb63 = null;
		return true;
	})()`)

const statePollCount = () => app.evaluate('(window.__kb63 && window.__kb63.statePolls) || 0')

async function nextPoll(timeoutMs = 9000) {
	const before = await statePollCount()
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		await sleep(250)
		if ((await statePollCount()) > before) return true
	}
	return false
}

// ---------------------------------------------------------------------------
// Performance metrics and the live read-view policy state
// ---------------------------------------------------------------------------

async function metrics() {
	const { metrics: list } = await app.cdp.send('Performance.getMetrics')
	const map = {}
	for (const metric of list) map[metric.name] = metric.value
	return map
}

const POLICY_STATE = `(() => {
	const root = document.querySelector('.kb-descRead .kb-md');
	if (!root) return null;
	const anchors = [...root.querySelectorAll('a')].map((anchor) => ({
		href: anchor.getAttribute('href'),
		target: anchor.getAttribute('target'),
		rel: anchor.getAttribute('rel'),
		text: (anchor.textContent || '').trim(),
	}));
	const text = root.textContent || '';
	return {
		textLength: text.length,
		marker: text.includes('KB63-PRD-MARKER'),
		nodeCount: root.querySelectorAll('*').length,
		anchors,
		anchorCount: anchors.length,
		imgCount: root.querySelectorAll('img').length,
		forbiddenCount: root.querySelectorAll('script,iframe,object,embed,style,math,img').length,
		svgCount: root.querySelectorAll('svg').length,
		svgIconCount: root.querySelectorAll('svg.kb-md-linkIcon').length,
		safeSpecAnchor: anchors.some((anchor) => anchor.href === ${JSON.stringify(SAFE_LINK_URL)}),
		imageAnchor: anchors.find((anchor) => anchor.href === ${JSON.stringify(IMAGE_URL)}) || null,
		localImageAnchor: anchors.some((anchor) => String(anchor.href || '').indexOf('local-image.png') !== -1),
		javascriptAnchorCount: anchors.filter((anchor) => /^javascript:/i.test(String(anchor.href))).length,
		hostileLabelAsText: text.includes('hostile link'),
		rawImageLiteral: text.includes('<img src="${RAW_IMAGE_URL}"'),
	};
})()`

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true })
await closeStrayTargets()
const app = await attach()
results.meta.startedAt = new Date().toISOString()
results.meta.ticket = 'KB-63'
results.meta.command = 'node tools/kb63-probe.js'
results.meta.windowMs = WINDOW_MS
results.meta.pollMs = POLL_MS

const networkEvents = []
let networkEnabled = false
let ticketId = null
let resumedBoard = false

try {
	await app.ensureApp({ reload: true })
	await app.cdp.send('Network.enable')
	networkEnabled = true
	app.cdp.on('Network.requestWillBeSent', (event) => {
		const request = event.request || {}
		networkEvents.push({ url: String(request.url || ''), method: String(request.method || ''), type: String(event.type || '') })
	})
	await setViewport(1024, 768)
	await dismissNotices()
	await dismissAppModals()
	await openPanel()

	const bootSnap = await app.evaluate(`(async () => {
		const response = await fetch('/kanban/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		const payload = await response.json();
		return payload.ok ? payload.value : { error: payload.error };
	})()`)
	const originalWorkspaceId = bootSnap.workspaceId
	const originalTheme = await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source") || "unknown"')
	const originalLocale = await panelTitle()
	const scratch = (bootSnap.projects || []).find((project) => project.title === PROBE_PROJECT)
	if (!scratch) throw new Error(`the ${PROBE_PROJECT} scratch board is not registered`)
	results.meta.probeProject = PROBE_PROJECT
	results.meta.probeWorkspaceId = scratch.id
	results.meta.originalWorkspaceId = originalWorkspaceId
	results.meta.originalTheme = originalTheme
	results.meta.originalLocale = originalLocale
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

	let bootState = await pageState()
	if (bootState.board && bootState.board.paused === true) {
		resumedBoard = true
		await pageAction('resumeBoard')
		await sleep(700)
		bootState = await pageState()
	}
	const preProbeCount = bootState.board && Array.isArray(bootState.board.tickets) ? bootState.board.tickets.length : -1
	results.meta.preProbeTickets = preProbeCount
	record('setup/unpaused', 'the probe board is unpaused so the 2.5 s poll runs', bootState.board && bootState.board.paused === false, { paused: bootState.board && bootState.board.paused })

	// AC6: the PRD fixture length (the host caps a description at 20,000 chars).
	results.measurements.prd = { length: PRD.length, cap: 20000, windowMs: WINDOW_MS, pollMs: POLL_MS }
	record(
		'AC6/prdLength',
		'a deterministic PRD fixture is built at exactly the 20,000-character description cap (the 20k PRD)',
		PRD.length === 20000,
		{ length: PRD.length },
	)

	// Count polls and create the real fixture after the final shell reload.
	await installFetchCounter()
	const created = await pageAction('createTicket', {
		title: 'KB-63 probe: 20k PRD drawer under polling',
		description: PRD,
		type: 'task',
		priority: 'high',
		labels: ['kb63-probe'],
	})
	ticketId = created.value && created.value.ticket ? created.value.ticket.id : null
	if (!ticketId) throw new Error('createTicket failed: ' + JSON.stringify(created.error || created))
	results.created.push(ticketId)
	results.meta.fixtureTicketId = ticketId
	await waitFor(`document.querySelector('.kb-card[data-ticket="${ticketId}"]')`, 'fixture card ' + ticketId)
	await sleep(1000)

	const stored = ticketById(await rawState(), ticketId)
	record(
		'AC6/prdStored',
		'the host stored the full 20,000-character PRD on the fixture ticket (no truncation)',
		Boolean(stored) && stored.description === PRD,
		{ storedLength: stored && typeof stored.description === 'string' ? stored.description.length : null, prdLength: PRD.length },
	)

	await openTicket(ticketId)
	await sleep(900)

	const rendered = await app.evaluate(POLICY_STATE)
	results.measurements.readView = rendered
	record(
		'AC6/readView',
		'the real ticket drawer renders the 20k PRD through MarkdownBody (marker and over half of the source text rendered)',
		Boolean(rendered) && rendered.marker === true && rendered.textLength >= MIN_RENDERED_TEXT && rendered.nodeCount > 500,
		rendered && { textLength: rendered.textLength, minRenderedText: MIN_RENDERED_TEXT, nodeCount: rendered.nodeCount, marker: rendered.marker },
	)
	record(
		'policy/link',
		'the live read view keeps the safe anchor with target/rel and renders the javascript: label with no anchor',
		Boolean(rendered) &&
			rendered.safeSpecAnchor === true &&
			rendered.javascriptAnchorCount === 0 &&
			rendered.hostileLabelAsText === true &&
			rendered.anchors.every(
				(anchor) => /^(https?|mailto):/i.test(String(anchor.href)) && anchor.target === '_blank' && anchor.rel === 'noopener noreferrer nofollow',
			),
		rendered && {
			anchorCount: rendered.anchorCount,
			safeSpecAnchor: rendered.safeSpecAnchor,
			javascriptAnchorCount: rendered.javascriptAnchorCount,
			hostileLabelAsText: rendered.hostileLabelAsText,
		},
	)
	record(
		'policy/image',
		'the live read view renders image Markdown as an alt-labelled anchor, keeps the raw <img> literal and creates no <img>',
		Boolean(rendered) &&
			rendered.imgCount === 0 &&
			rendered.forbiddenCount === 0 &&
			rendered.svgCount === rendered.svgIconCount &&
			rendered.imageAnchor !== null &&
			rendered.imageAnchor.text === 'fixture image' &&
			rendered.localImageAnchor === false &&
			rendered.rawImageLiteral === true,
		rendered && {
			imgCount: rendered.imgCount,
			forbiddenCount: rendered.forbiddenCount,
			imageAnchor: rendered.imageAnchor,
			localImageAnchor: rendered.localImageAnchor,
			rawImageLiteral: rendered.rawImageLiteral,
			svgCount: rendered.svgCount,
			svgIconCount: rendered.svgIconCount,
		},
	)

	// AC7: keep a reference to the rendered .kb-md node across both windows.
	await app.evaluate(`(() => { const md = document.querySelector('.kb-descRead .kb-md'); window.__kb63MdNode = md; return !!md })()`)

	// Confirm the poll loop is live before measuring.
	record('AC6/pollActive', 'at least one 2.5 s poll fires before the measurement windows', await nextPoll(), await statePollCount())

	// -----------------------------------------------------------------------
	// AC6 window 1 — Performance.getMetrics deltas over 6 s
	// -----------------------------------------------------------------------

	await app.cdp.send('Performance.enable')
	await sleep(400)
	const pollStart = await statePollCount()
	const networkStart = networkEvents.length
	const metricStart = await metrics()
	const windowStart = Date.now()
	await sleep(WINDOW_MS)
	const windowElapsed = Date.now() - windowStart
	const metricEnd = await metrics()
	const pollEnd = await statePollCount()
	const windowNetwork = networkEvents.slice(networkStart)
	const pollCount = pollEnd - pollStart
	const scriptDelta = Number((metricEnd.ScriptDuration ?? 0) - (metricStart.ScriptDuration ?? 0))
	const layoutDelta = Number((metricEnd.LayoutCount ?? 0) - (metricStart.LayoutCount ?? 0))
	const stateNetworkRequests = windowNetwork.filter((event) => event.url.includes('kanban/state')).length
	results.measurements.window = {
		durationMs: windowElapsed,
		pollCount,
		prdLength: PRD.length,
		scriptDurationDelta: scriptDelta,
		layoutCountDelta: layoutDelta,
		stateNetworkRequests,
		metricsStart: {
			ScriptDuration: metricStart.ScriptDuration ?? null,
			LayoutCount: metricStart.LayoutCount ?? null,
			TaskDuration: metricStart.TaskDuration ?? null,
		},
		metricsEnd: {
			ScriptDuration: metricEnd.ScriptDuration ?? null,
			LayoutCount: metricEnd.LayoutCount ?? null,
			TaskDuration: metricEnd.TaskDuration ?? null,
		},
	}
	note(
		`window: ${windowElapsed} ms, ${pollCount} kanban/state polls, ScriptDuration +${scriptDelta.toFixed(4)} s, LayoutCount +${layoutDelta}`,
	)
	record('AC6/pollCycles', 'the 6 s window contains at least two 2.5 s poll cycles', pollCount >= 2, { pollCount, windowElapsed })
	record('AC6/scriptBudget', 'ScriptDuration delta over the window is under the 0.05 s budget', Number.isFinite(scriptDelta) && scriptDelta < 0.05, {
		scriptDurationDelta: scriptDelta,
		budget: 0.05,
	})
	record('AC6/layoutBudget', 'LayoutCount delta over the window is under the 100 budget', Number.isFinite(layoutDelta) && layoutDelta < 100, {
		layoutCountDelta: layoutDelta,
		budget: 100,
	})
	record(
		'AC6/network',
		'the Network domain observed the state polls and no request to the fixture image URL',
		stateNetworkRequests >= 2 && windowNetwork.every((event) => !event.url.includes('kb63.invalid')),
		{ stateNetworkRequests, requests: windowNetwork.map((event) => event.url).slice(0, 12) },
	)

	// -----------------------------------------------------------------------
	// AC7 window 2 — profiler: no parse of the 20k PRD during polling
	// -----------------------------------------------------------------------

	await app.cdp.send('Profiler.disable').catch(() => {})
	await app.cdp.send('Profiler.enable')
	await app.cdp.send('Profiler.setSamplingInterval', { interval: 200 })
	const profilePollStart = await statePollCount()
	await app.cdp.send('Profiler.start')
	const profileStart = Date.now()
	await sleep(WINDOW_MS)
	const { profile } = await app.cdp.send('Profiler.stop')
	const profileElapsed = Date.now() - profileStart
	const profilePollEnd = await statePollCount()
	const profilePollCount = profilePollEnd - profilePollStart
	const frameNames = new Map((profile.nodes || []).map((node) => [node.id, String((node.callFrame && node.callFrame.functionName) || '')]))
	const sampleCounts = {}
	for (const sampleId of profile.samples || []) {
		const name = frameNames.get(sampleId) || '<root>'
		sampleCounts[name] = (sampleCounts[name] || 0) + 1
	}
	const isParseFrame = (name) => /parseMarkdown|markdownParse|markdownInlineScaffold/.test(name)
	const parseSamples = (profile.samples || []).filter((sampleId) => isParseFrame(frameNames.get(sampleId) || '')).length
	const topFrames = Object.entries(sampleCounts)
		.sort((left, right) => right[1] - left[1])
		.slice(0, 8)
	results.measurements.profile = {
		durationMs: profileElapsed,
		pollCount: profilePollCount,
		sampleCount: (profile.samples || []).length,
		parseSamples,
		parseFrameNames: [...frameNames.values()].filter(isParseFrame),
		topFrames,
	}
	note(`profile window: ${profileElapsed} ms, ${profilePollCount} polls, ${(profile.samples || []).length} samples, ${parseSamples} parse samples`)
	record(
		'AC7/noReparse',
		'>= 2 polls rendered the drawer with zero profiler samples in the parse functions (the 20k PRD is not re-parsed)',
		profilePollCount >= 2 && (profile.samples || []).length > 0 && parseSamples === 0,
		{ pollCount: profilePollCount, sampleCount: (profile.samples || []).length, parseSamples, topFrames },
	)

	const identity = await app.evaluate(`(() => {
		const md = document.querySelector('.kb-descRead .kb-md');
		return { present: !!md, sameNode: md !== null && md === window.__kb63MdNode, textLength: md ? (md.textContent || '').length : 0 };
	})()`)
	results.measurements.identity = identity
	record(
		'AC7/domStable',
		'the same .kb-md DOM node and 20k rendered text survive both polling windows',
		identity.present === true && identity.sameNode === true && identity.textLength >= MIN_RENDERED_TEXT,
		identity,
	)

	// -----------------------------------------------------------------------
	// Network assertion over the whole run (fixture image never fetched)
	// -----------------------------------------------------------------------

	const fixtureImageRequests = networkEvents.filter((event) => event.url.includes('kb63.invalid'))
	const imageRequests = networkEvents.filter((event) => event.type === 'Image')
	results.network = {
		requests: networkEvents,
		fixtureImageRequests,
		imageRequests,
		stateRequests: networkEvents.filter((event) => event.url.includes('kanban/state')),
	}
	record(
		'AC6/noImageRequest',
		'the whole run made no request to the fixture image URL (image Markdown renders as an anchor, raw <img> stays text)',
		fixtureImageRequests.length === 0 && imageRequests.every((event) => !event.url.includes('kb63.invalid')),
		{ fixtureImageRequests: fixtureImageRequests.map((event) => event.url), imageRequests: imageRequests.map((event) => event.url) },
	)

	// -----------------------------------------------------------------------
	// Labelled screenshot of the real drawer under polling
	// -----------------------------------------------------------------------

	await app.evaluate(`(() => { const body = document.querySelector('.kb-drawerBody'); if (body) body.scrollTop = 0; return true })()`)
	await sleep(400)
	const theme = await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source") || "unknown"')
	const name = `20k-prd-drawer-polling-1024-${theme}`
	await shot(name)
	results.screenshots.push({
		name: name + '.png',
		label: 'KB-63 · 20k PRD ticket drawer open under the 2.5 s board poll',
		theme,
		width: 1024,
		ticketId,
		prdLength: PRD.length,
	})

	const errors = await app.errors()
	const ignoredPattern = /deepseek-account|authentication|HTTP 40[49]|intercepted/i
	const relevant = errors.filter((entry) => !ignoredPattern.test(String(entry.text || '')))
	results.console = errors
	record('console/clean', 'the render path produced no unexpected console error or exception', relevant.length === 0, relevant.slice(0, 5))
} catch (error) {
	record('probe/completed', 'the probe ran to completion', false, String((error && error.message) || error))
} finally {
	try {
		await removeFetchCounter().catch(() => {})
		await app.cdp.send('Profiler.disable').catch(() => {})
		await closeDrawer()
		if (ticketId) {
			const deleted = await pageAction('deleteTicket', { ticketId })
			results.cleanup.push({ step: 'delete', id: ticketId, status: deleted.status, ok: deleted.ok })
		}
		await sleep(1000)
		const finalSnap = await rawState()
		const finalTickets = finalSnap.board && Array.isArray(finalSnap.board.tickets) ? finalSnap.board.tickets : []
		const finalCount = finalTickets.length
		record(
			'cleanup/deleted',
			'the probe fixture ticket is deleted and the scratch board ticket count is restored',
			results.created.every((id) => !finalTickets.some((ticket) => ticket.id === id)) && finalCount === results.meta.preProbeTickets,
			{ finalCount, preProbeCount: results.meta.preProbeTickets },
		)
		if (resumedBoard) {
			const paused = await pageAction('pauseBoard')
			results.cleanup.push({ step: 'pauseRestored', status: paused.status, ok: paused.ok })
		}
		const originalWorkspaceId = results.meta.originalWorkspaceId
		if (originalWorkspaceId && originalWorkspaceId !== results.meta.probeWorkspaceId) {
			await app.evaluate(`(() => { window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(originalWorkspaceId)}); return true })()`)
			workspaceId = originalWorkspaceId
			await reloadShell()
			await openPanel()
			await sleep(500)
			results.cleanup.push({ step: 'workspace', restoredTitle: await clientProjectTitle() })
		}
		await closeDrawer()
		if (networkEnabled) {
			results.notes.push('Network domain captured ' + networkEvents.length + ' request events after Network.enable')
		}
	} catch (error) {
		record('cleanup/error', 'cleanup completed without error', false, String((error && error.message) || error))
	}

	results.meta.finishedAt = new Date().toISOString()
	results.meta.failures = failures
	results.meta.createdTickets = results.created
	await mkdir(OUT, { recursive: true })
	await writeFile(new URL(PROJECT_FILE, import.meta.url), JSON.stringify(results, null, 1))
	console.log(`\n${failures === 0 ? 'ALL KB-63 PROBE CHECKS PASSED' : `${failures} PROBE FAILURE(S)`} — ${results.checks.length} checks, ${results.screenshots.length} screenshots`)
	process.exit(failures === 0 ? 0 : 1)
}
