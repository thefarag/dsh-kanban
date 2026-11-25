/**
 * KB-2 verification probe — voice dictation in the Thought dialog.
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) and
 * asserts the KB-2 one-shot dictation contract end to end:
 *   - dialog: mic toggle with accessible name + aria-pressed + title, live
 *     status line, `role=status aria-live=polite` region, KB-1 field intact
 *   - default on: with the installed voice bundle and a ready provider, opening
 *     the dialog starts capture ("Listening…", aria-pressed=true) and keeps
 *     focus in the field
 *   - typed text survives the stop→transcribe round trip (transcript appends,
 *     never overwrites); toggle off/on; outcome is an appended transcript or
 *     the retryable "No speech recognized" state for Chrome's non-speech fake
 *     device audio
 *   - permission denied: inline error, dictation off, a single getUserMedia
 *     attempt, typing/Send still work
 *   - paused submit: 423 keeps the dialog, its text and Send usable
 *   - submit: exactly one submitThought call with the trimmed field text (host
 *     stub so a verification run never dispatches a real PM session)
 *   - widths 1024 and 640 (light + dark), reduced height, no horizontal overflow
 *   - keyboard: Enter opens, Tab reaches the toggle, Space toggles, Escape
 *     closes and restores focus to the Speak a thought CTA
 *   - Chinese copy for every new label
 *
 * The bundle-absent and provider-unprepared states are not reachable in this
 * profile (bundle installed, model prepared); tests/voice.test.mjs covers them
 * with a fake bundle double and records the note in the JSON evidence.
 *
 * Chrome must be launched with fake media streams:
 *   --use-fake-ui-for-media-stream --use-fake-device-for-media-stream
 *
 * Usage (Chrome on port 9333, app URL in $DSH_WEB_URL):
 *   node tools/kb2-probe.js
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { attach } from './cdp.mjs'

const OUT_URL = new URL('../docs/screenshots/kb2/', import.meta.url)
const OUT = OUT_URL.pathname
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = { meta: {}, checks: [], measurements: {}, screenshots: [], notes: [], console: [] }
let failures = 0

function record(id, name, pass, detail) {
	results.checks.push({ id, name, pass: pass === true, detail: detail === undefined ? null : detail })
	if (pass !== true) failures += 1
	console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

await mkdir(OUT, { recursive: true })
const app = await attach()
results.meta.url = await app.evaluate('location.href')
results.meta.startedAt = new Date().toISOString()
results.meta.userAgent = await app.evaluate('navigator.userAgent')

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
	await sleep(500)
}

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
		await sleep(350)
	}
}

const hasPanel = () => app.evaluate(`!!document.querySelector('.kb-root')`)

async function openPanel() {
	for (let attempt = 0; attempt < 6; attempt += 1) {
		if (await hasPanel()) return true
		await dismissAppModals()
		const clicked = await app.evaluate(
			`(() => {
				const row = [...document.querySelectorAll('button')].find((b) => /^(Kanban|看板)$/.test((b.getAttribute('aria-label') || '').trim()) && b.getBoundingClientRect().width > 0);
				if (!row) return false;
				row.click();
				return true;
			})()`,
			{ userGesture: true },
		)
		await sleep(1400)
		if (clicked && (await hasPanel())) return true
	}
	throw new Error('could not open the Kanban panel')
}

/** Reload the whole shell (fresh plugin state) and land on the Kanban panel. */
async function reloadShell() {
	await app.ensureApp({ reload: true })
	await dismissNotices()
	await dismissAppModals()
	await openPanel()
	await sleep(900)
}

async function shot(name) {
	await dismissAppModals()
	await app.screenshot(`${OUT}${name}.png`)
	results.screenshots.push(`${name}.png`)
	console.log('SHOT ' + name)
	return `${OUT}${name}.png`
}

/** The dialog's voice surface, measured from the live DOM. */
const dialogInfo = () =>
	app.evaluate(`(() => {
		const dialog = document.querySelector('.kb-dialog');
		if (!dialog) return null;
		const textarea = dialog.querySelector('#kb-thought-input');
		const toggle = dialog.querySelector('.kb-thoughtVoiceToggle');
		const status = dialog.querySelector('.kb-thoughtVoiceState');
		const live = dialog.querySelector('.kb-srOnly');
		const send = [...dialog.querySelectorAll('button')].find((b) => /Send thought|Sending|发送想法|发送中/i.test(b.getAttribute('aria-label') || b.textContent || ''));
		const rect = (el) => {
			if (!el) return null;
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) };
		};
		const body = dialog.querySelector('.kb-dialogBody');
		const panel = document.querySelector('.kb-root');
		return {
			open: true,
			title: ((dialog.querySelector('.kb-dialogTitle') || {}).textContent || '').trim(),
			panel: panel ? { width: panel.clientWidth, overflow: panel.scrollWidth - panel.clientWidth } : null,
			viewport: { width: window.innerWidth, height: window.innerHeight },
			docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			textarea: textarea
				? {
						value: textarea.value,
						maxLength: textarea.getAttribute('maxlength'),
						focused: document.activeElement === textarea,
						rect: rect(textarea),
				  }
				: null,
			toggle: toggle
				? {
						label: (toggle.getAttribute('aria-label') || '').trim(),
						title: (toggle.getAttribute('title') || '').trim(),
						pressed: toggle.getAttribute('aria-pressed'),
						disabled: toggle.disabled === true,
						rect: rect(toggle),
				  }
				: null,
			status: status ? { text: (status.textContent || '').trim(), error: /--error/.test(status.className), rect: rect(status) } : null,
			live: live ? { role: live.getAttribute('role'), ariaLive: live.getAttribute('aria-live'), text: (live.textContent || '').trim() } : null,
			send: send ? { disabled: send.disabled === true } : null,
			voiceRow: rect(dialog.querySelector('.kb-thoughtVoice')),
			footer: rect(dialog.querySelector('.kb-dialogFoot')),
			dialog: rect(dialog),
			body: body ? { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight, scrollable: body.scrollHeight > body.clientHeight + 1 } : null,
			focus: document.activeElement ? document.activeElement.id || String(document.activeElement.className) || document.activeElement.tagName : null,
		};
	})()`)

const toggleEl = () => app.evaluate(`!!document.querySelector('.kb-thoughtVoiceToggle')`)

async function openDialog() {
	await dismissAppModals()
	const clicked = await app.evaluate(
		`(() => {
			const btn = [...document.querySelectorAll('.kb-root header button')].find((b) => {
				if (b.getBoundingClientRect().width === 0 || b.disabled) return false;
				const label = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
				return /^(Speak a thought|说出想法)$/.test(label) || b.classList.contains('kb-btn--primary');
			});
			if (!btn) return false;
			btn.click();
			return true;
		})()`,
		{ userGesture: true },
	)
	if (!clicked) return false
	await app.waitFor(`!!document.querySelector('.kb-dialog')`, 6000, 'thought dialog')
	await sleep(300)
	return true
}

async function closeDialog() {
	if (!(await app.evaluate(`!!document.querySelector('.kb-dialog')`))) return
	await app.key('Escape')
	await app.waitFor(`!document.querySelector('.kb-dialog')`, 6000, 'dialog closed')
	await sleep(300)
}

const isRecording = () =>
	app.evaluate(`(() => {
		const toggle = document.querySelector('.kb-thoughtVoiceToggle');
		return Boolean(toggle) && toggle.getAttribute('aria-pressed') === 'true' && !toggle.disabled;
	})()`)

async function waitRecording(timeoutMs = 15000) {
	try {
		await app.waitFor(
			`(() => {
				const toggle = document.querySelector('.kb-thoughtVoiceToggle');
				if (!toggle || toggle.getAttribute('aria-pressed') !== 'true') return false;
				const status = document.querySelector('.kb-thoughtVoiceState');
				return Boolean(status) && /Listening|正在聆听/.test(status.textContent || '');
			})()`,
			timeoutMs,
			'dictation listening',
		)
		return true
	} catch (error) {
		return false
	}
}

/** Wait until the toggle is back to Start/Stop (not checking/requesting/transcribing). */
async function waitSettled(timeoutMs = 60000) {
	try {
		await app.waitFor(
			`(() => {
				const toggle = document.querySelector('.kb-thoughtVoiceToggle');
				if (!toggle) return false;
				const label = (toggle.getAttribute('aria-label') || '').trim();
				if (!/^(Start dictation|Stop dictation and transcribe|开始语音输入|停止语音输入并转写)$/.test(label)) return false;
				const status = document.querySelector('.kb-thoughtVoiceState');
				const text = status ? status.textContent || '' : '';
				return !/Checking voice input|Waiting for microphone|Transcribing|正在检查语音输入|正在等待麦克风|正在转写/.test(text);
			})()`,
			timeoutMs,
			'dictation settled',
		)
		return true
	} catch (error) {
		return false
	}
}

async function clickToggle() {
	const clicked = await app.evaluate(
		`(() => {
			const toggle = document.querySelector('.kb-thoughtVoiceToggle');
			if (!toggle || toggle.disabled) return false;
			toggle.click();
			return true;
		})()`,
		{ userGesture: true },
	)
	await sleep(250)
	return clicked
}

async function stopDictation() {
	if (!(await isRecording())) return false
	await clickToggle()
	const settled = await waitSettled()
	return settled
}

async function typeThought(value) {
	await app.type(`document.querySelector('#kb-thought-input')`, value)
	await sleep(250)
}

const toastText = () =>
	app.evaluate(`(() => {
		const toast = document.querySelector('.kb-toast');
		if (!toast) return null;
		return { text: (toast.textContent || '').trim(), error: /kb-toast--error/.test(toast.className) };
	})()`)

// --- locale switching (same app settings path KB-3 uses) --------------------

const languageButtonVisible = () =>
	app.evaluate(`[...document.querySelectorAll('button')].some((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`)

const settingsOverlayOpen = () =>
	app.evaluate(
		`[...document.querySelectorAll('button,[role="tab"]')].some((x) => {
			const text = (x.textContent || '').trim();
			return text === 'General' || text === '通用设置' || text === 'English' || text === '中文' || text === 'Language' || text === '语言';
		})`,
	)

async function closeSettings() {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		if (!(await settingsOverlayOpen())) return true
		await app.key('Escape')
		await sleep(400)
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

const generalTabVisible = () =>
	app.evaluate(
		`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`,
	)

const clickGeneral = () =>
	app.evaluate(
		`(() => { const el = [...document.querySelectorAll('button,[role="tab"]')].find((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
		{ userGesture: true },
	)

async function openSettings() {
	if (await languageButtonVisible()) return true
	for (let attempt = 0; attempt < 2; attempt += 1) {
		if (!(await settingsOverlayOpen())) {
			await pressSettingsShortcut()
			try {
				await app.waitFor(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()))`, 6000, 'settings panel')
			} catch (error) {
				continue
			}
		}
		if (await generalTabVisible()) await clickGeneral()
		try {
			await app.waitFor(`[...document.querySelectorAll('button')].some((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`, 6000, 'language control')
		} catch (error) {
			continue
		}
		if (await languageButtonVisible()) return true
	}
	return false
}

async function setLanguage(target) {
	const steps = {}
	await reloadShell()
	steps.opened = await openSettings()
	if (!steps.opened) {
		results.notes.push({ language: target, steps, changed: false })
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
	await sleep(1400)
	await closeSettings()
	await dismissAppModals()
	await sleep(400)
	const expectedTitle = target === '中文' ? '看板' : 'Kanban'
	let changed = false
	try {
		await app.waitFor(
			`(() => { const el = document.querySelector('.kb-root .kb-title'); return el && (el.textContent || '').trim() === ${JSON.stringify(expectedTitle)} })()`,
			6000,
			`language ${target}`,
		)
		changed = true
	} catch (error) {
		changed = false
	}
	results.notes.push({ language: target, steps, changed })
	return steps.pick === true && changed
}

// --- board snapshot actions for the paused-submit check ---------------------

async function pageState() {
	return app.evaluate(`(async () => {
		const response = await fetch('/kanban/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		const payload = await response.json();
		return payload.ok ? payload.value : { error: payload.error, status: response.status };
	})()`)
}

async function pageAction(action, payload = {}) {
	const workspaceId = results.meta.workspaceId
	return app.evaluate(`(async () => {
		const response = await fetch('/kanban/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId)}, action: ${JSON.stringify(action)}, payload: ${JSON.stringify(payload)} }),
		});
		const body = await response.json();
		return { status: response.status, body };
	})()`)
}

// --- real keyboard input ----------------------------------------------------

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
	await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
	await sleep(400)
}

async function pressSpace() {
	await app.cdp.send('Input.dispatchKeyEvent', {
		type: 'keyDown',
		key: ' ',
		code: 'Space',
		windowsVirtualKeyCode: 32,
		nativeVirtualKeyCode: 32,
		text: ' ',
		unmodifiedText: ' ',
	})
	await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 })
	await sleep(350)
}

async function pressTab() {
	await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
	await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
	await sleep(300)
}

// ---------------------------------------------------------------------------
// 0. Fresh shell, panel, baseline
// ---------------------------------------------------------------------------

await setViewport(1024, 900)
await setTheme('light')
await reloadShell()
const initialTitle = await app.evaluate(`(() => { const el = document.querySelector('.kb-root .kb-title'); return el ? (el.textContent || '').trim() : null })()`)
if (initialTitle !== 'Kanban') {
	results.notes.push({ initialLocale: initialTitle, restored: await setLanguage('English') })
}
const initialState = await pageState()
if (initialState && typeof initialState.workspaceId === 'string') results.meta.workspaceId = initialState.workspaceId
results.meta.workspaceId = results.meta.workspaceId || (await pageState()).workspaceId
record('setup/panel', 'Kanban panel is open at 1024px', await hasPanel())
record('setup/workspace', 'a workspace is selected so the board is live', Boolean(results.meta.workspaceId), results.meta.workspaceId)

// ---------------------------------------------------------------------------
// 1. Dialog surface + default-on dictation (AC 2, 3, 5)
// ---------------------------------------------------------------------------

const opened = await openDialog()
record('dialog/open', 'clicking the header CTA opens the Thought dialog', opened)
const initialDialog = opened ? await dialogInfo() : null
record(
	'dialog/shape',
	'the dialog keeps the KB-1 one-field shape (role=dialog, labelled 4000-char field)',
	Boolean(initialDialog && initialDialog.textarea && initialDialog.textarea.maxLength === '4000' && initialDialog.send),
	initialDialog && { maxLength: initialDialog.textarea && initialDialog.textarea.maxLength },
)
record(
	'voice/toggle',
	'the mic toggle exposes an accessible label, title and aria-pressed',
	Boolean(initialDialog && initialDialog.toggle && initialDialog.toggle.label && initialDialog.toggle.title && initialDialog.toggle.pressed !== null),
	initialDialog && initialDialog.toggle,
)
record(
	'voice/liveRegion',
	'a polite live region announces dictation state',
	Boolean(initialDialog && initialDialog.live && initialDialog.live.role === 'status' && initialDialog.live.ariaLive === 'polite'),
	initialDialog && initialDialog.live,
)
const listened = opened ? await waitRecording(20000) : false
record('voice/defaultOn', 'opening the dialog starts capture automatically with a visible listening state', listened, listened ? null : await dialogInfo())
const listening = await dialogInfo()
record(
	'voice/listeningCopy',
	'the listening state is text + a pressed toggle, never colour alone',
	Boolean(listening && listening.toggle && listening.toggle.pressed === 'true' && listening.status && /Listening|正在聆听/.test(listening.status.text)),
	listening && { toggle: listening.toggle && listening.toggle.label, status: listening.status && listening.status.text },
)
record('voice/focusKept', 'focus stays in the Thought field while listening', Boolean(listening && listening.textarea && listening.textarea.focused), listening && listening.focus)
await shot('dialog-listening-1024-light')

// ---------------------------------------------------------------------------
// 2. Typed text preserved through stop → transcribe (AC 4, 5, 6)
// ---------------------------------------------------------------------------

const typed = 'Typed probe text survives dictation.'
await typeThought(typed)
const typedWhileListening = await dialogInfo()
record(
	'voice/typingWhileListening',
	'typing while listening keeps the field editable and the typed text intact',
	Boolean(typedWhileListening && typedWhileListening.textarea && typedWhileListening.textarea.value === typed),
	typedWhileListening && typedWhileListening.textarea && typedWhileListening.textarea.value,
)
await clickToggle()
const transcribingSeen = await app
	.evaluate(`(() => { const t = document.querySelector('.kb-thoughtVoiceToggle'); return Boolean(t) && /Transcribing/.test(t.getAttribute('aria-label') || '') })()`)
	.catch(() => false)
const settled = await waitSettled(60000)
const stopped = await dialogInfo()
const emptyOutcome = Boolean(stopped && stopped.status && /No speech recognized|未识别到语音/.test(stopped.status.text))
const appendedOutcome = Boolean(stopped && stopped.textarea && stopped.textarea.value !== typed && stopped.textarea.value.startsWith(typed))
record('voice/stopSettles', 'stopping capture reaches a settled Start state after one transcription', settled, settled ? null : stopped && stopped.toggle && stopped.toggle.label)
record(
	'voice/printedState',
	'the stopped state is a real outcome (appended transcript or the empty-transcript hint)',
	emptyOutcome || appendedOutcome,
	stopped && { status: stopped.status && stopped.status.text, value: stopped.textarea && stopped.textarea.value, transcribingSeen },
)
record(
	'voice/typedPreserved',
	'the typed text is never overwritten by the transcript update',
	Boolean(stopped && stopped.textarea && stopped.textarea.value.startsWith(typed)),
	stopped && stopped.textarea && stopped.textarea.value,
)
record(
	'voice/noLongerPressed',
	'the toggle reports off after the stop and Send is available',
	Boolean(stopped && stopped.toggle && stopped.toggle.pressed === 'false' && stopped.toggle.disabled === false && stopped.send && stopped.send.disabled === false),
	stopped && { toggle: stopped.toggle, send: stopped.send },
)
record('voice/focusRetained', 'focus is still in the field after the transcript update', Boolean(stopped && stopped.textarea && stopped.textarea.focused), stopped && stopped.focus)
await shot('dialog-stopped-1024-light')

// Toggle back on, then off again: capture restarts and the field is untouched.
await clickToggle()
const restarted = await waitRecording(15000)
record('voice/toggleOn', 'the toggle starts a second capture', restarted, restarted ? null : await dialogInfo())
if (restarted) await stopDictation()
const afterSecond = await dialogInfo()
record(
	'voice/typedPreservedSecond',
	'the second stop leaves the field text intact as well',
	Boolean(afterSecond && afterSecond.textarea && afterSecond.textarea.value.startsWith(typed)),
	afterSecond && afterSecond.textarea && afterSecond.textarea.value,
)

// ---------------------------------------------------------------------------
// 3. Widths 1024 / 640 in both themes + reduced height (AC 13)
// ---------------------------------------------------------------------------

async function measureWidth(width, height, theme, name) {
	await setViewport(width, height)
	await setTheme(theme)
	await closeDialog()
	const fresh = await openDialog()
	const listeningNow = fresh ? await waitRecording(15000) : false
	const info = fresh ? await dialogInfo() : null
	const fits =
		Boolean(info) &&
		info.docOverflow <= 1 &&
		info.panel &&
		info.panel.overflow <= 1 &&
		info.dialog &&
		info.dialog.right <= info.viewport.width + 1 &&
		info.dialog.x >= -1 &&
		Boolean(info.toggle && info.toggle.rect && info.toggle.rect.width > 0) &&
		Boolean(info.status && info.status.rect && info.status.rect.width > 0) &&
		Boolean(info.footer && info.footer.bottom <= info.viewport.height + 1) &&
		Boolean(info.textarea && info.textarea.rect && info.textarea.rect.width > 0)
	record(`widths/${name}/fits`, `field, toggle, status and footer fit without overflow at ${width}x${height} (${theme})`, fits, info && { docOverflow: info.docOverflow, panel: info.panel, dialog: info.dialog, footer: info.footer, viewport: info.viewport })
	if (fresh) await shot(`dialog-listening-${name}`)
	if (fresh) {
		await closeDialog()
	}
	return { info, listeningNow }
}

const wide = await measureWidth(1024, 900, 'light', '1024-light')
await measureWidth(1024, 900, 'dark', '1024-dark')
const narrow = await measureWidth(640, 900, 'light', '640-light')
await measureWidth(640, 900, 'dark', '640-dark')

// Reduced viewport height: body scrolls, footer and toggle stay reachable.
await closeDialog()
await setViewport(640, 520)
await setTheme('light')
const shortOpen = await openDialog()
await waitRecording(15000)
const shortInfo = shortOpen ? await dialogInfo() : null
const toggleReachable = await app.evaluate(`(() => {
	const toggle = document.querySelector('.kb-thoughtVoiceToggle');
	if (!toggle) return false;
	toggle.scrollIntoView({ block: 'center' });
	const rect = toggle.getBoundingClientRect();
	return rect.width > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
})()`)
record(
	'widths/640x520/reachable',
	'at a reduced 640x520 viewport the toggle is reachable and the footer stays visible',
	Boolean(shortInfo && shortInfo.body && shortInfo.body.clientHeight > 0 && toggleReachable && shortInfo.footer && shortInfo.footer.bottom <= 520 + 1),
	shortInfo && { body: shortInfo.body, footer: shortInfo.footer, toggleReachable },
)
if (shortOpen) await shot('dialog-640x520-light')
await closeDialog()

// ---------------------------------------------------------------------------
// 4. Keyboard-only path (AC 13)
// ---------------------------------------------------------------------------

await setViewport(1024, 900)
await setTheme('light')
await closeDialog()
await app.evaluate(`(() => { const cta = document.querySelector('.kb-header .kb-btn--primary'); if (cta) cta.focus(); return Boolean(cta) })()`)
const ctaFocused = await app.evaluate(`document.activeElement === document.querySelector('.kb-header .kb-btn--primary')`)
await pressEnter()
const keyboardOpen = await app.evaluate(`!!document.querySelector('.kb-dialog')`)
record('keyboard/enterOpens', 'Enter on the header CTA opens the dialog', ctaFocused && keyboardOpen, { ctaFocused, keyboardOpen })
await waitRecording(15000)
record('keyboard/autofocus', 'the Thought field is focused on open', await app.evaluate(`document.activeElement === document.querySelector('#kb-thought-input')`))
await pressTab()
const tabTarget = await app.evaluate(`(() => {
	const el = document.activeElement;
	if (!el) return null;
	return { className: String(el.className || ''), label: el.getAttribute && el.getAttribute('aria-label') };
})()`)
record('keyboard/tabToToggle', 'Tab reaches the mic toggle', Boolean(tabTarget && /kb-thoughtVoiceToggle/.test(tabTarget.className)), tabTarget)
await pressSpace()
const spaceStopped = await waitSettled(60000)
const spaceState = await dialogInfo()
record('keyboard/spaceToggles', 'Space activates the mic toggle (stop → transcribe)', Boolean(spaceStopped && spaceState && spaceState.toggle && spaceState.toggle.pressed === 'false'), spaceState && spaceState.toggle)
await app.key('Escape')
const escapeClosed = await app
	.waitFor(`!document.querySelector('.kb-dialog')`, 6000, 'escape closes')
	.then(() => true)
	.catch(() => false)
await sleep(400)
const focusRestored = await app.evaluate(`(() => { const el = document.activeElement; return el ? (el.getAttribute('aria-label') || el.textContent || '').trim() : null })()`)
record('keyboard/escapeRestores', 'Escape closes the dialog and focus returns to the Speak a thought CTA', escapeClosed && /^(Speak a thought|说出想法)$/.test(focusRestored || ''), { escapeClosed, focusRestored })

// ---------------------------------------------------------------------------
// 5. Permission denied (AC 10)
// ---------------------------------------------------------------------------

const permissionScript = await app.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
	source: `(() => {
		window.__kb2MicCalls = 0;
		const devices = navigator.mediaDevices;
		if (!devices) return;
		Object.defineProperty(devices, 'getUserMedia', {
			configurable: true,
			value: () => {
				window.__kb2MicCalls += 1;
				return Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
			},
		});
	})();`,
})
const permissionIdentifier = permissionScript.identifier
await reloadShell()
await openDialog()
await sleep(1500)
const denied = await dialogInfo()
const micCallsFirst = await app.evaluate('window.__kb2MicCalls || 0')
await sleep(2500)
const micCallsSecond = await app.evaluate('window.__kb2MicCalls || 0')
record(
	'permission/inlineError',
	'permission denial shows an inline error label, not only a toast',
	Boolean(denied && denied.status && denied.status.error && /Microphone access is denied|麦克风权限被拒绝/.test(denied.status.text)),
	denied && denied.status,
)
record('permission/dictationOff', 'dictation stays off after a denied permission', Boolean(denied && denied.toggle && denied.toggle.pressed === 'false' && denied.toggle.disabled === false), denied && denied.toggle)
record('permission/noPromptLoop', 'exactly one getUserMedia attempt happens (no prompt loop)', micCallsFirst === 1 && micCallsSecond === 1, { micCallsFirst, micCallsSecond })
await typeThought('Typed after denial.')
const afterDeniedText = await dialogInfo()
record(
	'permission/typingWorks',
	'typing and Send still work after the denial',
	Boolean(afterDeniedText && afterDeniedText.textarea && afterDeniedText.textarea.value === 'Typed after denial.' && afterDeniedText.send && afterDeniedText.send.disabled === false),
	afterDeniedText && { value: afterDeniedText.textarea && afterDeniedText.textarea.value, send: afterDeniedText.send },
)
await shot('dialog-permission-1024-light')
await closeDialog()
await app.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: permissionIdentifier }).catch(() => {})
await reloadShell()

// ---------------------------------------------------------------------------
// 6. Paused submit keeps the dialog and its text (AC 7, 8)
// ---------------------------------------------------------------------------

await setViewport(1024, 900)
await setTheme('light')
await openDialog()
await waitRecording(15000)
await stopDictation()
await typeThought('This thought must survive a rejected submit.')
const pausedResult = await pageAction('pauseBoard')
await sleep(800)
const sendClicked = await app.evaluate(
	`(() => {
		const btn = [...document.querySelectorAll('.kb-dialog button')].find((b) => /Send thought|发送想法/i.test(b.getAttribute('aria-label') || b.textContent || ''));
		if (!btn || btn.disabled) return false;
		btn.click();
		return true;
	})()`,
	{ userGesture: true },
)
await app
	.waitFor(`(() => { const t = document.querySelector('.kb-toast'); return Boolean(t) && /paused|恢复看板|board/i.test(t.textContent || '') })()`, 15000, 'paused error toast')
	.catch(() => {})
await sleep(500)
const pausedToast = await toastText()
const pausedDialog = await dialogInfo()
record(
	'pausedSubmit/setup',
	'the board is paused behind the open dialog before the submit (verify-teardown)',
	Boolean(pausedResult && pausedResult.status === 200 && pausedResult.body && pausedResult.body.ok === true),
	pausedResult && { status: pausedResult.status, ok: pausedResult.body && pausedResult.body.ok },
)
record('pausedSubmit/dialogStays', 'a failed submit keeps the dialog open with the text intact', Boolean(sendClicked && pausedDialog && pausedDialog.textarea && pausedDialog.textarea.value === 'This thought must survive a rejected submit.'), pausedDialog && pausedDialog.textarea && pausedDialog.textarea.value)
record('pausedSubmit/sendRecovered', 'Send is enabled again after the rejected submit', Boolean(pausedDialog && pausedDialog.send && pausedDialog.send.disabled === false), pausedDialog && pausedDialog.send)
record('pausedSubmit/toast', 'the host error is surfaced in a toast too', Boolean(pausedToast && /paused|board/i.test(pausedToast.text + ' ' + (pausedToast.error ? 'error' : ''))), pausedToast)
await shot('dialog-paused-error-1024-light')
await pageAction('resumeBoard')
await sleep(600)
await closeDialog()

// ---------------------------------------------------------------------------
// 7. Exactly one submitThought with the trimmed text (AC 7) — host stub
// ---------------------------------------------------------------------------

await reloadShell()
await setViewport(1024, 900)
await setTheme('light')
await app.evaluate(`(() => {
	const original = window.fetch;
	window.__kb2SubmitStub = { calls: [], original };
	window.fetch = async (input, options) => {
		const body = options && typeof options.body === 'string' ? options.body : '';
		if (/kanban\\/action/.test(String(input)) && /submitThought/.test(body)) {
			const parsed = JSON.parse(body);
			window.__kb2SubmitStub.calls.push(parsed);
			return new Response(JSON.stringify({ ok: true, value: { thought: { id: 'TH-probe', text: String(parsed.payload && parsed.payload.text || ''), status: 'recorded', createdAt: Date.now(), updatedAt: Date.now(), sessionId: null, error: '', ticketIds: [] } } }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}
		return original.call(window, input, options);
	};
	return true;
})()`)
await openDialog()
await waitRecording(15000)
await stopDictation()
await typeThought('  Probe submit happens once.  ')
const submitClicked = await app.evaluate(
	`(() => {
		const btn = [...document.querySelectorAll('.kb-dialog button')].find((b) => /Send thought|发送想法/i.test(b.getAttribute('aria-label') || b.textContent || ''));
		if (!btn || btn.disabled) return false;
		btn.click();
		return true;
	})()`,
	{ userGesture: true },
)
await app.waitFor(`!document.querySelector('.kb-dialog')`, 15000, 'dialog closes after submit').catch(() => {})
await sleep(600)
const stub = await app.evaluate('window.__kb2SubmitStub ? { calls: window.__kb2SubmitStub.calls } : null')
const successToast = await toastText()
record(
	'submit/once',
	'Send calls submitThought exactly once with the trimmed field text',
	Boolean(stub && stub.calls.length === 1 && stub.calls[0].payload && stub.calls[0].payload.text === 'Probe submit happens once.'),
	stub && stub.calls.map((call) => call.payload),
)
record('submit/closes', 'a successful submit closes the dialog', Boolean(submitClicked) && !(await app.evaluate(`!!document.querySelector('.kb-dialog')`)))
record('submit/toast', 'the existing success toast is used', Boolean(successToast && /Thought recorded|已记录想法/.test(successToast.text)), successToast)
await shot('dialog-submit-1024-light')
await app.evaluate(`(() => { if (window.__kb2SubmitStub) { window.fetch = window.__kb2SubmitStub.original; delete window.__kb2SubmitStub; } return true })()`)

// ---------------------------------------------------------------------------
// 8. Chinese copy (AC 12)
// ---------------------------------------------------------------------------

const switched = await setLanguage('中文')
record('i18n/switch', 'the app switches to Chinese', switched)
await setViewport(1024, 900)
await setTheme('light')
await openDialog()
await waitRecording(15000)
const zhListening = await dialogInfo()
record(
	'i18n/toggle',
	'the mic toggle label is localized in Chinese',
	Boolean(zhListening && zhListening.toggle && /停止语音输入并转写|开始语音输入/.test(zhListening.toggle.label)),
	zhListening && zhListening.toggle,
)
record(
	'i18n/listeningStatus',
	'the listening status is localized in Chinese',
	Boolean(zhListening && zhListening.status && /正在聆听/.test(zhListening.status.text)),
	zhListening && zhListening.status,
)
record(
	'i18n/liveRegion',
	'the live announcement is localized in Chinese',
	Boolean(zhListening && zhListening.live && /正在聆听|正在转写/.test(zhListening.live.text)),
	zhListening && zhListening.live,
)
await shot('dialog-listening-1024-zh')
if (await isRecording()) await stopDictation()
await closeDialog()
try {
	await setLanguage('English')
} catch (error) {
	results.notes.push({ languageRestore: String((error && error.message) || error) })
}
await sleep(600)

// ---------------------------------------------------------------------------
// 9. State coverage notes + console hygiene
// ---------------------------------------------------------------------------

results.notes.push({
	unreachable: 'bundle-absent and provider-unprepared states are not reachable in this profile (bundle installed, sensevoice-local model prepared); tests/voice.test.mjs covers them with a fake bundle double',
	fakeDevice: 'headless Chrome fake media device produces non-speech audio, so the real-GUI transcript outcome is the empty-transcript hint; appended transcript text is asserted in tests/voice.test.mjs',
	submitStub: 'the submit check stubs only the submitThought response so a verification run never dispatches a PM session; the host submit path is unchanged and covered by tests/thoughts.test.mjs',
})
try {
	await reloadShell()
	await setViewport(1024, 900)
	await setTheme('light')
	await sleep(1200)
} catch (error) {
	results.notes.push({ finalReload: String((error && error.message) || error) })
}
const consoleErrors = (await app.errors()).filter((entry) => entry.type === 'exception' || (/error/i.test(entry.type) && /kanban|kb-/i.test(entry.text || '')))
results.console = (await app.errors()).slice(0, 50)
record('console/clean', 'no Kanban exception or error in the console', consoleErrors.length === 0, consoleErrors.slice(0, 3))
results.measurements = {
	wide: wide.info,
	narrow: narrow.info,
	short: shortInfo,
	permission: denied,
}
results.meta.finishedAt = new Date().toISOString()
results.meta.failures = failures
await writeFile(new URL('../docs/screenshots/kb2/final-verification.json', import.meta.url), JSON.stringify(results, null, 1))
console.log(`\n${failures === 0 ? 'ALL KB-2 PROBE CHECKS PASSED' : `${failures} PROBE FAILURE(S)`} — ${results.checks.length} checks, ${results.screenshots.length} screenshots`)
process.exit(failures === 0 ? 0 : 1)
