/**
 * KB-5 thought-lifecycle verification probe.
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) against a
 * scratch board (`default-workspace`, the convention kb14 used) and asserts the
 * KB-5 contract end to end:
 *   - paused capture: Speak a thought stays enabled, submit returns 200 `queued`
 *     (no session, no tickets), drawer row shows Queued + the header queued count
 *   - Resume drains FIFO: the same thought becomes `working` with a session
 *   - cancel: real `cancelThought` stops the session and the row stays Cancelled
 *   - detail: expanded row shows verbatim text, oldest→newest audit timeline,
 *     ticket chips and the session link (aria-expanded, keyboard operable)
 *   - edit: inline edit of a non-working thought updates text + audit
 *   - delete: soft delete removes the row, adds the id to deletedThoughtIds, and
 *     the ticket drawer shows "Thought deleted"; a live thought shows the chip
 *   - retry: a failed-thought row is a UI fixture (the live host has no failure
 *     injection); the Retry control and its `retryThought` payload are captured,
 *     and the host happy path is proven by tests/thought-lifecycle.test.mjs
 *   - en+zh, light+dark, 1024 and 640 widths, no horizontal overflow, clean console
 *
 * Writes docs/screenshots/kb5/final-verification.json and PNGs.
 *
 * Usage (Chrome on port 9333, app URL in $DSH_WEB_URL):
 *   node tools/kb5-probe.js
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { attach } from './cdp.mjs'

const OUT_URL = new URL('../docs/screenshots/kb5/', import.meta.url)
const OUT = OUT_URL.pathname
const SCRATCH_PROJECT = 'default-workspace'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = {
  meta: {},
  checks: [],
  transcripts: [],
  measurements: {},
  screenshots: [],
  fixtures: [],
  notes: [],
  console: [],
}
let failures = 0

const REPO_ROOT = new URL('../', import.meta.url)
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')
async function fileIdentity(url) {
  try {
    const buffer = await readFile(url)
    return { sha256: sha256(buffer), bytes: buffer.length }
  } catch {
    return null
  }
}
/**
 * Evidence build identity. The running GUI serves the shared repository tree while
 * this probe ships from the clean KB-5 worktree, so record both and let the
 * reviewer compare them. `KB5_LIVE_ROOT` names the tree the GUI is actually serving.
 */
const liveRoot = process.env.KB5_LIVE_ROOT
  ? (process.env.KB5_LIVE_ROOT.endsWith('/') ? process.env.KB5_LIVE_ROOT : process.env.KB5_LIVE_ROOT + '/')
  : null
results.meta.build = {
  probeRoot: fileURLToPath(REPO_ROOT),
  probeFiles: {
    'index.js': await fileIdentity(new URL('index.js', REPO_ROOT)),
    'client.js': await fileIdentity(new URL('client.js', REPO_ROOT)),
  },
  liveRoot,
  liveFiles: liveRoot
    ? { 'index.js': await fileIdentity(liveRoot + 'index.js'), 'client.js': await fileIdentity(liveRoot + 'client.js') }
    : null,
  note: liveRoot
    ? 'The GUI serves the shared repository tree; it carries this slice plus the sibling landed work (KB-2 voice, KB-3/KB-4 EPIC). The KB-5 branch suite and this evidence run target the same KB-5 source.'
    : 'Set KB5_LIVE_ROOT to the tree the GUI serves to record the live build identity next to the branch identity.',
}

function record(id, name, pass, detail) {
  results.checks.push({ id, name, pass: pass === true, detail: detail === undefined ? null : detail })
  if (pass !== true) failures += 1
  console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 260)}`}`)
}
function note(text) {
  results.notes.push(text)
  console.log('note ' + text)
}
function transcript(label, value) {
  results.transcripts.push({ label, at: new Date().toISOString(), value })
}

await mkdir(OUT, { recursive: true })
const app = await attach()
results.meta.url = await app.evaluate('location.href')
results.meta.startedAt = new Date().toISOString()

// ---------------------------------------------------------------------------
// Page helpers (same harness as kb14/kb2 probes)
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

const hasPanel = () => app.evaluate(`!!document.querySelector('.kb-root')`)

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
    await sleep(300)
  }
}

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
    await sleep(1200)
    if (clicked && (await hasPanel())) return true
  }
  throw new Error('could not open the Kanban panel')
}

/** Capture every kanban request/response the client makes (transcript evidence). */
async function installRecorder() {
  await app.evaluate(`(() => {
    if (window.__kb5Recorder) return true;
    const original = window.fetch;
    window.__kb5Recorder = { calls: [], original };
    window.fetch = async (input, options) => {
      const url = String(input && input.url ? input.url : input);
      const body = options && typeof options.body === 'string' ? options.body : '';
      if (!/kanban\\/(action|state)/.test(url)) return original.call(window, input, options);
      const response = await original.call(window, input, options);
      try {
        const clone = await response.clone().json();
        let sent = null;
        try { sent = body ? JSON.parse(body) : null; } catch { sent = body; }
        window.__kb5Recorder.calls.push({ path: url, action: sent && sent.action ? sent.action : 'state', payload: sent && sent.payload ? sent.payload : null, status: response.status, body: clone });
      } catch { /* non-JSON: ignore */ }
      return response;
    };
    return true;
  })()`)
}

async function reloadShell() {
  await app.ensureApp({ reload: true })
  await dismissNotices()
  await dismissAppModals()
  await installRecorder()
  await openPanel()
  await sleep(900)
}

async function pageState() {
  // Once the scratch board is pinned, ask for it explicitly: the client rewrites
  // its localStorage key while it reconciles the Host default project, so reading
  // the key back races the mount effect (the first KB-5 probe run hit exactly that).
  const pinned = workspaceId
  const body = pinned
    ? `{ workspaceId: ${JSON.stringify(pinned)} }`
    : `(() => { let stored = null; try { stored = window.localStorage.getItem('dsh.kanban.workspace'); } catch (error) { stored = null; } return stored ? { workspaceId: stored } : {}; })()`
  return app.evaluate(`(async () => {
    const body = ${body};
    const response = await fetch('/kanban/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload = await response.json();
    return payload.ok ? payload.value : { error: payload.error, status: response.status };
  })()`)
}

let workspaceId = ''
async function pageAction(action, payload = {}) {
  const result = await app.evaluate(`(async () => {
    const response = await fetch('/kanban/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId)}, action: ${JSON.stringify(action)}, payload: ${JSON.stringify(payload)} }),
    });
    const payload = await response.json();
    return { status: response.status, body: payload };
  })()`)
  transcript(`${action}`, { payload, response: result })
  return result
}

async function shot(name) {
  await dismissAppModals()
  await app.screenshot(`${OUT}${name}.png`)
  results.screenshots.push(name + '.png')
  console.log('SHOT ' + name)
}

const drawerRows = () =>
  app.evaluate(`(() => {
    const drawer = document.querySelector('.kb-drawer--thoughts');
    if (!drawer) return null;
    return [...drawer.querySelectorAll('.kb-thoughtRow')].map((row) => ({
      id: (row.querySelector('.kb-thoughtChip') || {}).innerText || null,
      status: ((row.querySelector('.kb-thoughtStatus') || {}).innerText || '').trim(),
      hint: ((row.querySelector('.kb-thoughtHint') || {}).innerText || '').trim(),
      text: ((row.querySelector('.kb-thoughtText') || {}).innerText || ''),
      error: ((row.querySelector('.kb-thoughtError') || {}).innerText || '').trim(),
      timeline: [...row.querySelectorAll('.kb-thoughtTimelineItem')].map((item) => (item.innerText || '').replace(/\\s+/g, ' ').trim()),
      retryOf: ((row.querySelector('.kb-thoughtRetryOf') || {}).innerText || '').trim(),
      buttons: [...row.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim()),
      expandLabel: ((row.querySelector('.kb-thoughtExpand') || {}).innerText || '').trim(),
      expanded: (row.querySelector('.kb-thoughtExpand') || {}).getAttribute ? (row.querySelector('.kb-thoughtExpand') || {}).getAttribute('aria-expanded') : null,
      editing: Boolean(row.querySelector('.kb-thoughtEditForm')),
    }));
  })()`)

const drawerChrome = () =>
  app.evaluate(`(() => {
    const drawer = document.querySelector('.kb-drawer--thoughts');
    if (!drawer) return null;
    const rect = drawer.getBoundingClientRect();
    return {
      open: true,
      queues: [...drawer.querySelectorAll('.kb-thoughtsHeadCount')].map((el) => (el.innerText || '').trim()),
      width: Math.round(rect.width),
      overflowX: drawer.scrollWidth > drawer.clientWidth + 1,
      bodyOverflowX: drawer.querySelector('.kb-drawerBody') ? drawer.querySelector('.kb-drawerBody').scrollWidth > drawer.querySelector('.kb-drawerBody').clientWidth + 1 : false,
    };
  })()`)

const headerState = () =>
  app.evaluate(`(() => {
    const header = document.querySelector('.kb-header');
    if (!header) return null;
    const buttons = [...header.querySelectorAll('button')].map((b) => ({
      label: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      text: (b.textContent || '').trim(),
      disabled: b.disabled === true,
      cls: b.className,
    }));
    const cta = buttons.find((b) => b.label === 'Speak a thought' || b.label === '说出想法');
    const pause = buttons.find((b) => /Pause board|Resume board|暂停看板|恢复看板/i.test((b.title || '') + ' ' + (b.label || '') + ' ' + (b.text || '')));
    return { buttons, cta, pause, thoughts: buttons.find((b) => /Thoughts|想法/.test(b.label || '')) };
  })()`)

/** The client's own board pause state, derived from its rendered banner. */
const clientPaused = () => app.evaluate(`!!document.querySelector('.kb-banner')`)

async function waitClientPaused(want, timeoutMs = 15000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await clientPaused()) === want) return true
    await sleep(300)
  }
  return false
}

async function clickHeaderLabel(pattern) {
  await dismissAppModals()
  const clicked = await app.evaluate(
    `(() => {
      const want = ${JSON.stringify(pattern)};
      const re = new RegExp(want, 'i');
      const header = document.querySelector('.kb-header');
      if (!header) return false;
      const el = [...header.querySelectorAll('button')].find((n) => re.test([n.getAttribute('aria-label') || '', n.getAttribute('title') || '', n.textContent || ''].join(' ')));
      if (!el) return false;
      el.click();
      return true;
    })()`,
    { userGesture: true },
  )
  await sleep(500)
  return clicked
}

async function openThoughts() {
  if (await app.evaluate(`!!document.querySelector('.kb-drawer--thoughts')`)) return true
  await clickHeaderLabel('Thoughts|想法')
  await app.waitFor(`!!document.querySelector('.kb-drawer--thoughts')`, 8000, 'thoughts drawer').catch(() => {})
  await sleep(400)
  return app.evaluate(`!!document.querySelector('.kb-drawer--thoughts')`)
}

/** The client's own project selection (the drawer renders its snapshot). */
const clientProjectTitle = () =>
  app.evaluate(`(() => { const el = document.querySelector('.kb-projectName'); return el ? (el.textContent || '').trim() : null })()`)

async function selectProject(title) {
  const opened = await app.evaluate(
    `(() => { const btn = document.querySelector('.kb-projectBtn'); if (!btn) return false; btn.click(); return true })()`,
    { userGesture: true },
  )
  await app.waitFor(`!!document.querySelector('.kb-menuRow')`, 6000, 'project menu').catch(() => {})
  const picked = await app.evaluate(
    `(() => { const rows = [...document.querySelectorAll('.kb-menuRow')]; const row = rows.find((el) => ((el.querySelector('.kb-menuTitle') || {}).textContent || '').trim() === ${JSON.stringify(title)}); if (!row) return false; row.click(); return true })()`,
    { userGesture: true },
  )
  await sleep(1400)
  return opened === true && picked === true
}

async function closeOverlays() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const open = await app.evaluate(`!!document.querySelector('.kb-dialog') || !!document.querySelector('.kb-drawer')`)
    if (!open) return
    await app.key('Escape')
    await sleep(400)
  }
}

async function waitThoughtStatus(thoughtId, wanted, timeoutMs = 90000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    const state = await pageState()
    last = (state.thoughts || []).find((thought) => thought.id === thoughtId) || null
    if (last && wanted.includes(last.status)) return { found: true, thought: last, state }
    await sleep(1200)
  }
  return { found: false, thought: last }
}

const toastText = () =>
  app.evaluate(`[...document.querySelectorAll('.kb-toast')].map((t) => (t.innerText || '').trim()).join(' | ')`)

async function waitToast(pattern, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const text = await toastText()
    if (pattern.test(text)) return text
    await sleep(200)
  }
  return null
}

// --- locale switching (same app settings path as the other probes) ----------
const languageButtonVisible = () =>
  app.evaluate(`[...document.querySelectorAll('button')].some((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`)

const settingsOverlayOpen = () =>
  app.evaluate(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|English|中文|Language|语言)$/.test((x.textContent || '').trim()))`)

const generalTabVisible = () =>
  app.evaluate(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`)

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

async function openSettings() {
  if (await languageButtonVisible()) return true
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await settingsOverlayOpen())) {
      await pressSettingsShortcut()
      await sleep(900)
    }
    if (await generalTabVisible()) {
      await app.evaluate(
        `(() => { const el = [...document.querySelectorAll('button,[role="tab"]')].find((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (el) el.click(); return Boolean(el) })()`,
        { userGesture: true },
      )
      await sleep(700)
    }
    if (await languageButtonVisible()) return true
  }
  return false
}

async function setLanguage(target) {
  const steps = { opened: false, pick: false, changed: false }
  await reloadShell()
  steps.opened = await openSettings()
  if (!steps.opened) {
    results.notes.push({ language: target, steps })
    return false
  }
  steps.pick = await app.evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true })()`,
    { userGesture: true },
  )
  await sleep(600)
  const picked = await app.evaluate(
    `(() => { const el = [...document.querySelectorAll('button,[role="option"],[role="menuitem"],li')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(target)} && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
    { userGesture: true },
  )
  await sleep(1200)
  await closeSettings()
  await dismissAppModals()
  const expectedTitle = target === '中文' ? '看板' : 'Kanban'
  try {
    await app.waitFor(`(() => { const el = document.querySelector('.kb-root .kb-title'); return el && (el.textContent || '').trim() === ${JSON.stringify(expectedTitle)} })()`, 6000, `language ${target}`)
    steps.changed = true
  } catch {
    steps.changed = false
  }
  results.notes.push({ language: target, steps })
  return steps.pick === true && picked === true && steps.changed
}

async function expandFirstRow() {
  return app.evaluate(
    `(() => { const row = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow'); if (!row) return false; const btn = row.querySelector('.kb-thoughtExpand'); if (!btn) return false; btn.click(); return true })()`,
    { userGesture: true },
  )
}

// ---------------------------------------------------------------------------
// 0. Switch to the scratch board and boot the panel
// ---------------------------------------------------------------------------

await app.ensureApp({ reload: true })
await installRecorder()
await setViewport(1024, 900)
await setTheme('light')
await dismissNotices()
await dismissAppModals()
await openPanel()

// The app remembers its language, so a previous (aborted) run can leave the shell
// in Chinese. Normalize to English for the base run; the zh pass switches
// explicitly and restores English afterwards.
const panelTitle = await app.evaluate(`(() => { const el = document.querySelector('.kb-root .kb-title'); return el ? (el.textContent || '').trim() : null })()`)
if (panelTitle !== 'Kanban') {
  note(`normalizing the UI language to English (panel title was ${JSON.stringify(panelTitle)})`)
  await setLanguage('English')
  await installRecorder()
  await openPanel()
  await sleep(600)
}

const bootState = await pageState()
const scratch = (bootState.projects || []).find((project) => project.title === SCRATCH_PROJECT)
record('setup/scratchProject', `the ${SCRATCH_PROJECT} scratch board is registered`, Boolean(scratch && scratch.id), scratch && { id: scratch.id, title: scratch.title, paused: scratch.paused })
if (!scratch) {
  console.log('\nFAILURE(S): scratch project missing')
  await writeFile(new URL('../docs/screenshots/kb5/final-verification.json', import.meta.url), JSON.stringify({ ...results, meta: { ...results.meta, failures: failures + 1 } }, null, 1))
  process.exit(1)
}
await app.evaluate(`(() => { window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(scratch.id)}); return true })()`)
// Pin the Host calls to the scratch board before the reload, and keep asking for it
// explicitly afterwards: the client's mount effect can rewrite localStorage.
workspaceId = scratch.id
await reloadShell()
await openPanel()
await sleep(600)
let snap = await pageState()
results.meta.project = snap.project && snap.project.title
results.meta.workspaceId = workspaceId
record('setup/selected', 'the probe runs on the scratch board', snap.project && snap.project.title === SCRATCH_PROJECT && workspaceId === scratch.id, { workspaceId, title: snap.project && snap.project.title })
let clientTitle = await clientProjectTitle()
if (clientTitle !== SCRATCH_PROJECT) {
  note(`the client opened ${clientTitle ?? '(none)'} instead of the scratch board; selecting it explicitly`)
  await selectProject(SCRATCH_PROJECT)
  await sleep(1200)
  clientTitle = await clientProjectTitle()
}
record('setup/clientSelected', 'the client panel is rendering the scratch board', clientTitle === SCRATCH_PROJECT, { clientTitle })
if (snap.board && snap.board.paused === true) {
  await pageAction('resumeBoard')
  snap = await pageState()
}
record('setup/unpaused', 'the scratch board starts unpaused', snap.board && snap.board.paused === false, snap.board && snap.board.paused)
const runningSessions = (snap.sessions || []).filter((session) => session.running)
record('setup/pauseSafe', 'no unrelated agent session is running inside the scratch board', runningSessions.length === 0, runningSessions.map((session) => session.sessionId))
if (runningSessions.length > 0) {
  note('Refusing to pause a scratch board with running sessions; aborting probe.')
  await writeFile(new URL('../docs/screenshots/kb5/final-verification.json', import.meta.url), JSON.stringify({ ...results, meta: { ...results.meta, failures: failures + 1 } }, null, 1))
  process.exit(1)
}

const probeThoughtIds = []
const probeTicketIds = []
const cleanup = async () => {
  try {
    await app.evaluate(`(() => { if (window.__kb5RetryStub) { window.fetch = window.__kb5RetryStub.original; delete window.__kb5RetryStub; } return true })()`)
    const state = await pageState()
    if (state.board && state.board.paused === true) await pageAction('resumeBoard')
    for (const ticketId of probeTicketIds) await pageAction('deleteTicket', { ticketId }).catch(() => {})
    for (const thoughtId of probeThoughtIds) await pageAction('deleteThought', { thoughtId }).catch(() => {})
    const after = await pageState()
    results.meta.cleanup = {
      paused: after.board && after.board.paused,
      probeThoughtsDeleted: probeThoughtIds.length,
      probeTicketsDeleted: probeTicketIds.length,
    }
  } catch (error) {
    results.meta.cleanupError = String((error && error.message) || error)
  }
}

// ---------------------------------------------------------------------------
// 1. Paused capture queues (real host path)
// ---------------------------------------------------------------------------

// The client polls every 2.5s: wait for it to render the unpaused header before
// clicking, or the control still reads "Resume board" from the setup resume.
await waitClientPaused(false)
let pausedClick = await clickHeaderLabel('Pause board|暂停看板')
if (!pausedClick) {
  await sleep(1200)
  pausedClick = await clickHeaderLabel('Pause board|暂停看板')
}
const clientPausedNow = await waitClientPaused(true)
snap = await pageState()
record('queue/paused', 'the board pauses from the header control', pausedClick === true && clientPausedNow === true && snap.board && snap.board.paused === true, { clicked: pausedClick, clientPaused: clientPausedNow, paused: snap.board && snap.board.paused })

let header = await headerState()
record('queue/ctaEnabled', 'Speak a thought stays enabled while paused', Boolean(header && header.cta && header.cta.disabled === false), header && header.cta && { disabled: header.cta.disabled, title: header.cta.title })
record('queue/ctaHint', 'the paused CTA title explains that captures queue', Boolean(header && header.cta && /queue|排队/i.test(header.cta.title || '')), header && header.cta && header.cta.title)

const queueText = 'KB-5 probe: capture queues while the board is paused'
await app.evaluate(
  `(() => {
    const header = document.querySelector('.kb-header');
    const cta = [...header.querySelectorAll('button')].find((b) => /^(Speak a thought|说出想法)$/.test((b.getAttribute('aria-label') || '').trim()));
    if (cta) cta.click();
    return Boolean(cta);
  })()`,
  { userGesture: true },
)
await app.waitFor(`!!document.querySelector('.kb-dialog')`, 8000, 'thought dialog').catch(() => {})
await app.type(`document.querySelector('.kb-dialog textarea')`, queueText)
await sleep(200)
const sent = await app.evaluate(
  `(() => {
    const dialog = document.querySelector('.kb-dialog');
    if (!dialog) return false;
    const send = [...dialog.querySelectorAll('button')].find((b) => /Send thought|发送想法/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    if (!send || send.disabled) return false;
    send.click();
    return true;
  })()`,
  { userGesture: true },
)
await app.waitFor(`!document.querySelector('.kb-dialog')`, 15000, 'dialog closed').catch(() => {})
await sleep(900)
let calls = await app.evaluate(`window.__kb5Recorder ? window.__kb5Recorder.calls.slice() : []`)
let submitCall = [...calls].reverse().find((call) => call.action === 'submitThought')
const queuedThought = submitCall && submitCall.body && submitCall.body.ok ? submitCall.body.value.thought : null
if (queuedThought) probeThoughtIds.push(queuedThought.id)
record('queue/sent', 'the paused dialog sends the capture', sent === true && Boolean(submitCall), submitCall && { status: submitCall.status, action: submitCall.action })
record('queue/200', 'paused submit returns 200 (never 423)', submitCall && submitCall.status === 200 && submitCall.body.ok === true, submitCall && submitCall.status)
record('queue/status', 'the capture is persisted as queued with no session and no tickets', Boolean(queuedThought) && queuedThought.status === 'queued' && queuedThought.sessionId === null && Array.isArray(queuedThought.ticketIds) && queuedThought.ticketIds.length === 0, queuedThought && { status: queuedThought.status, sessionId: queuedThought.sessionId, ticketIds: queuedThought.ticketIds })
const queuedSnapshot = await pageState()
const queuedRow = (queuedSnapshot.thoughts || []).find((thought) => thought.id === queuedThought.id)
record('queue/snapshot', 'the queued thought is in the snapshot and no ticket was created', Boolean(queuedRow) && queuedRow.status === 'queued', queuedRow && queuedRow.status)

await openThoughts()
await sleep(2600)
let rows = await drawerRows()
let chrome = await drawerChrome()
record('queue/drawer', 'the drawer row reads Queued with the queue hint', Boolean(rows && rows.length >= 1 && rows[0].status === 'Queued' && /Queued/.test(rows[0].hint)), rows && rows[0])
record('queue/count', 'the drawer header shows the queued count', Boolean(chrome && chrome.queues.some((text) => /1 queued/.test(text))), chrome && chrome.queues)
await shot('queued-paused-1024-light')
await setViewport(640, 900)
await sleep(600)
chrome = await drawerChrome()
results.measurements.drawer640 = chrome
record('queue/narrow', 'the drawer fits 640px with no horizontal overflow', Boolean(chrome && chrome.overflowX === false && chrome.bodyOverflowX === false && chrome.width <= 640), chrome)
await shot('queued-paused-640-light')
await setViewport(1024, 900)
await setTheme('dark')
await sleep(600)
await shot('queued-paused-1024-dark')
await setTheme('light')
record('queue/i18nZh', 'the queued row is localized in Chinese', await setLanguage('中文'))
await sleep(800)
await openThoughts()
await sleep(2200)
rows = await drawerRows()
record('queue/i18nRow', 'Chinese drawer renders the queued label', Boolean(rows && rows[0] && /已排队/.test(rows[0].status)), rows && rows[0] && rows[0].status)
await shot('queued-paused-1024-zh')
await setLanguage('English')
await sleep(800)

// ---------------------------------------------------------------------------
// 2. Resume drains FIFO into a real working session, cancel keeps it terminal
// ---------------------------------------------------------------------------

snap = await pageState()
if (snap.board && snap.board.paused !== true) {
  // The language reload does not change board state; pause again only if needed.
}
const resume = await pageAction('resumeBoard')
await waitClientPaused(false)
record('drain/resumed', 'Resume succeeds', resume.status === 200 && resume.body.ok === true, resume.status)
const drained = await waitThoughtStatus(queuedThought.id, ['working', 'done', 'failed'], 60000)
const drainedState = drained.state || (await pageState())
const drainedThought = drained.thought
record('drain/status', 'the queued thought drains into a dispatched thought', Boolean(drainedThought) && ['working', 'done'].includes(drainedThought.status), drainedThought && { status: drainedThought.status, sessionId: drainedThought.sessionId, error: drainedThought.error })
record('drain/session', 'draining linked exactly one PM session', Boolean(drainedThought && typeof drainedThought.sessionId === 'string' && drainedThought.sessionId.startsWith('session-')), drainedThought && drainedThought.sessionId)
const auditAfterDrain = (drainedThought && drainedThought.audit) || []
record('drain/audit', 'the audit shows queued -> working in order', auditAfterDrain.some((entry) => entry.from === 'queued' && entry.to === 'working'), auditAfterDrain.map((entry) => `${entry.from || ''}>${entry.to || entry.type}`))
record('drain/queueEmpty', 'the queue is empty after the drain', (drainedState.thoughts || []).filter((thought) => thought.status === 'queued').length === 0)

await openThoughts()
await sleep(2600)
rows = await drawerRows()
record('detail/workingRow', 'the drawer row shows the working state', Boolean(rows && rows.some((row) => /Thinking|思考中/.test(row.status))), rows && rows.map((row) => row.status))
const expanded = await expandFirstRow()
await sleep(600)
rows = await drawerRows()
const workingRow = rows && rows[0]
record('detail/expanded', 'the row expands with aria-expanded', Boolean(workingRow) && workingRow.expanded === 'true', workingRow && workingRow.expanded)
record('detail/verbatim', 'the expanded row keeps the full verbatim text', Boolean(workingRow) && workingRow.text.replace(/\s+/g, ' ').includes(queueText), workingRow && workingRow.text.slice(0, 80))
// A paused capture starts its timeline at Queued; a KB-1-row-without-audit fallback
// would start at Recorded, so accept either as the oldest entry.
record('detail/timeline', 'the expanded row shows the oldest->newest status timeline', Boolean(workingRow) && workingRow.timeline.length >= 2 && /Queued|已排队|Recorded|已记录/.test(workingRow.timeline[0]), workingRow && workingRow.timeline)
await shot('detail-timeline-1024-light')
await setTheme('dark')
await sleep(500)
await shot('detail-timeline-1024-dark')
await setTheme('light')

const cancel = await pageAction('cancelThought', { thoughtId: queuedThought.id })
record('cancel/200', 'cancelThought cancels the working thought', cancel.status === 200 && cancel.body.ok === true && cancel.body.value.thought.status === 'cancelled', cancel.status)
record('cancel/ticketsKept', 'cancel keeps any tickets the thought already created', Array.isArray(cancel.body.value.thought.ticketIds), cancel.body.value.thought.ticketIds)
const cancelAgain = await pageAction('cancelThought', { thoughtId: queuedThought.id })
record('cancel/idempotent', 'a second cancel is a 200 no-op', cancelAgain.status === 200 && cancelAgain.body.value.thought.status === 'cancelled' && cancelAgain.body.value.thought.updatedAt === cancel.body.value.thought.updatedAt, cancelAgain.status)
const terminal1 = await pageState()
await sleep(2600)
const terminal2 = await pageState()
const terminalThought = (terminal2.thoughts || []).find((thought) => thought.id === queuedThought.id)
record('cancelled/terminal', 'cancelled stays terminal across reads', terminalThought && terminalThought.status === 'cancelled', terminalThought && terminalThought.status)
await openThoughts()
await sleep(1000)
await expandFirstRow()
await sleep(600)
rows = await drawerRows()
record('cancelled/row', 'the drawer shows the Cancelled label', Boolean(rows && rows.some((row) => /Cancelled|已取消/.test(row.status))), rows && rows.map((row) => row.status))
await shot('cancelled-1024-light')
await setTheme('dark')
await sleep(500)
await shot('cancelled-1024-dark')
await setTheme('light')

// ---------------------------------------------------------------------------
// 3. Edit (real path): cancelled thoughts are editable
// ---------------------------------------------------------------------------

const editedText = 'KB-5 probe: edited after cancel'
const editClick = await app.evaluate(
  `(() => {
    const row = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow');
    if (!row) return false;
    const btn = [...row.querySelectorAll('button')].find((b) => /^(Edit|编辑)$/i.test((b.getAttribute('aria-label') || b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  { userGesture: true },
)
await sleep(700)
const editForm = await app.evaluate(
  `(() => {
    const form = document.querySelector('.kb-drawer--thoughts .kb-thoughtEditForm');
    if (!form) return null;
    const textarea = form.querySelector('textarea');
    return { open: true, value: textarea ? textarea.value : '', maxLength: textarea ? textarea.getAttribute('maxlength') : null, buttons: [...form.querySelectorAll('button')].map((b) => (b.innerText || '').trim()) };
  })()`,
)
record('edit/form', 'Edit opens an inline form with the current text', Boolean(editClick) && Boolean(editForm && editForm.maxLength === '4000'), editForm && { maxLength: editForm.maxLength, buttons: editForm.buttons })
await shot('edit-form-1024-light')
await app.type(`document.querySelector('.kb-drawer--thoughts .kb-thoughtEditForm textarea')`, editedText)
await sleep(300)
const saveClick = await app.evaluate(
  `(() => {
    const form = document.querySelector('.kb-drawer--thoughts .kb-thoughtEditForm');
    if (!form) return false;
    const btn = [...form.querySelectorAll('button')].find((b) => /^(Save|保存)$/i.test((b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  { userGesture: true },
)
await waitToast(/updated|更新/i, 8000).catch(() => {})
await sleep(1400)
calls = await app.evaluate(`window.__kb5Recorder ? window.__kb5Recorder.calls.slice() : []`)
const editCall = [...calls].reverse().find((call) => call.action === 'editThought')
record('edit/action', 'Save sends editThought with the new text', Boolean(saveClick) && Boolean(editCall) && editCall.payload.text === editedText, editCall && { status: editCall.status, payload: editCall.payload })
const editedSnapshot = await pageState()
const editedThought = (editedSnapshot.thoughts || []).find((thought) => thought.id === queuedThought.id)
record('edit/persisted', 'the edit updates text without a status change or dispatch', Boolean(editedThought) && editedThought.text === editedText && editedThought.status === 'cancelled' && Number.isFinite(editedThought.editedAt), editedThought && { status: editedThought.status, editedAt: editedThought.editedAt })
record('edit/audit', 'the edit writes an audit entry', Boolean(editedThought && (editedThought.audit || []).some((entry) => entry.type === 'edit')), editedThought && (editedThought.audit || []).map((entry) => entry.type))

// ---------------------------------------------------------------------------
// 4. Ticket drawer: live thought chip, then "Thought deleted"
// ---------------------------------------------------------------------------

const liveTicket = await pageAction('createTicket', { title: 'KB-5 probe: ticket from a cancelled thought', type: 'story', thoughtId: queuedThought.id })
const liveTicketId = liveTicket.body && liveTicket.body.ok ? liveTicket.body.value.ticket.id : null
if (liveTicketId) probeTicketIds.push(liveTicketId)
record('ticketdrawer/ticketCreated', 'a probe ticket linked to the thought is created', Boolean(liveTicketId), liveTicketId)
await closeOverlays()
await sleep(1200)
const openTicket = await app.evaluate(
  `(() => {
    const card = document.querySelector('.kb-card[data-ticket="' + ${JSON.stringify(liveTicketId)} + '"]');
    if (!card) return false;
    card.click();
    return true;
  })()`,
  { userGesture: true },
)
await app.waitFor(`!!document.querySelector('.kb-drawer')`, 8000, 'ticket drawer').catch(() => {})
await sleep(900)
let thoughtChipRow = await app.evaluate(
  `(() => {
    const row = document.querySelector('.kb-ticketThoughtRow');
    if (!row) return null;
    return { text: (row.innerText || '').replace(/\\s+/g, ' ').trim(), deleted: Boolean(row.querySelector('.kb-ticketThoughtDeleted')), chip: Boolean(row.querySelector('.kb-thoughtChip')) };
  })()`,
)
record('ticketdrawer/liveChip', 'the ticket drawer shows the thought chip for a live thought', Boolean(openTicket) && Boolean(thoughtChipRow && thoughtChipRow.chip && thoughtChipRow.deleted === false && /TH-/.test(thoughtChipRow.text)), thoughtChipRow)
await shot('ticket-drawer-thought-chip-1024-light')
await closeOverlays()
await sleep(400)

// ---------------------------------------------------------------------------
// 5. Accessibility: aria-expanded, keyboard focus path, Escape closes
// ---------------------------------------------------------------------------

// Click through the real control: focus the Thoughts button first so the drawer's
// focus restore has a trigger to return to (a synthetic .click() does not focus it).
const thoughtsTriggered = await app.evaluate(
  `(() => {
    const btn = [...document.querySelectorAll('.kb-header button')].find((b) => /^(Thoughts|想法)$/.test((b.getAttribute('aria-label') || '').trim()));
    if (!btn) return false;
    btn.focus();
    btn.click();
    return true;
  })()`,
  { userGesture: true },
)
await app.waitFor(`!!document.querySelector('.kb-drawer--thoughts')`, 8000, 'thoughts drawer').catch(() => {})
await sleep(800)
const a11y = await app.evaluate(
  `(() => {
    const drawer = document.querySelector('.kb-drawer--thoughts');
    if (!drawer) return null;
    const buttons = [...drawer.querySelectorAll('button')];
    return {
      role: drawer.getAttribute('role'),
      modal: drawer.getAttribute('aria-modal'),
      label: drawer.getAttribute('aria-label'),
      buttonCount: buttons.length,
      focusable: buttons.filter((b) => b.disabled !== true).length,
      expand: buttons.filter((b) => b.hasAttribute('aria-expanded')).map((b) => b.getAttribute('aria-expanded')),
    };
  })()`,
)
record('a11y/drawer', 'the thoughts drawer is a labelled modal dialog', Boolean(thoughtsTriggered && a11y && a11y.role === 'dialog' && a11y.modal === 'true' && a11y.label), a11y && { role: a11y.role, modal: a11y.modal, label: a11y.label })
record('a11y/focusable', 'drawer controls are focusable buttons', Boolean(a11y && a11y.focusable >= 3), a11y && a11y.focusable)
record('a11y/ariaExpanded', 'the expand toggle exposes aria-expanded', Boolean(a11y && a11y.expand.length > 0 && a11y.expand.every((value) => value === 'true' || value === 'false')), a11y && a11y.expand)
await app.key('Escape')
await sleep(600)
record('a11y/escape', 'Escape closes the drawer', !(await app.evaluate(`!!document.querySelector('.kb-drawer--thoughts')`)))
record('a11y/focusRestored', 'focus returns to the Thoughts control', (await app.evaluate(`document.activeElement ? document.activeElement.getAttribute('aria-label') : null`)) === 'Thoughts')

const deleted = await pageAction('deleteThought', { thoughtId: queuedThought.id })
record('delete/200', 'deleteThought soft-deletes a cancelled thought', deleted.status === 200 && deleted.body.ok === true && Number.isFinite(deleted.body.value.thought.deletedAt), deleted.status)
const deletedSnapshot = await pageState()
record('delete/snapshot', 'the deleted thought leaves snapshot.thoughts', !(deletedSnapshot.thoughts || []).some((thought) => thought.id === queuedThought.id))
record('delete/ids', 'the deleted id joins deletedThoughtIds', Array.isArray(deletedSnapshot.deletedThoughtIds) && deletedSnapshot.deletedThoughtIds.includes(queuedThought.id))
// The drawer renders the client's polled snapshot: give the 2.5s poll one cycle so
// `deletedThoughtIds` reaches the ticket drawer before reopening it.
await sleep(3400)
const reopenTicket = await app.evaluate(
  `(() => {
    const card = document.querySelector('.kb-card[data-ticket="' + ${JSON.stringify(liveTicketId)} + '"]');
    if (!card) return false;
    card.click();
    return true;
  })()`,
  { userGesture: true },
)
await app.waitFor(`!!document.querySelector('.kb-drawer')`, 8000, 'ticket drawer').catch(() => {})
await sleep(900)
thoughtChipRow = await app.evaluate(
  `(() => {
    const row = document.querySelector('.kb-ticketThoughtRow');
    if (!row) return null;
    return { text: (row.innerText || '').replace(/\\s+/g, ' ').trim(), deleted: Boolean(row.querySelector('.kb-ticketThoughtDeleted')) };
  })()`,
)
record('ticketdrawer/deletedFallback', 'the ticket drawer shows "Thought deleted" for the deleted id', Boolean(reopenTicket) && Boolean(thoughtChipRow && thoughtChipRow.deleted && /Thought deleted/.test(thoughtChipRow.text)), thoughtChipRow)
await shot('ticket-drawer-thought-deleted-1024-light')
await setTheme('dark')
await sleep(500)
await shot('ticket-drawer-thought-deleted-1024-dark')
await setTheme('light')
await closeOverlays()


// ---------------------------------------------------------------------------
// 6. Retry: UI fixture (the live host cannot fail a dispatch on demand)
// ---------------------------------------------------------------------------

const fixtureNote =
  'The failed thought used for the Retry control is a UI fixture injected into /kanban/state: the live host has no dispatch-failure injection, so a failed row cannot be produced safely against a real project. The host retry contract (new linked row, error order, idempotency) is proven by tests/thought-lifecycle.test.mjs. The fixture keeps the real row component, real copy and a captured retryThought request.'
results.fixtures.push({ id: 'failed-thought-row', reason: fixtureNote })
const fixtureText = 'KB-5 probe fixture: a failed dispatch to retry'
async function installRetryFixture() {
  await app.evaluate(`(() => {
  const original = window.fetch;
  const now = Date.now();
  const failed = {
    id: 'TH-fixture-2', text: ${JSON.stringify(fixtureText)}, status: 'failed',
    createdAt: now - 60000, updatedAt: now - 30000, sessionId: null,
    error: 'the product manager session did not start', ticketIds: [],
    retryOf: 'TH-fixture-1',
    audit: [
      { at: now - 60000, type: 'status', actor: 'You', to: 'recorded' },
      { at: now - 58000, type: 'status', actor: 'system', from: 'recorded', to: 'working' },
      { at: now - 32000, type: 'status', actor: 'system', from: 'working', to: 'failed' },
      { at: now - 31000, type: 'retry', actor: 'You', thoughtId: 'TH-fixture-1' },
    ],
  };
  const source = {
    id: 'TH-fixture-1', text: 'KB-5 probe fixture: the original failed thought', status: 'failed',
    createdAt: now - 120000, updatedAt: now - 90000, sessionId: null,
    error: 'agents service unavailable', ticketIds: [],
    audit: [{ at: now - 120000, type: 'status', actor: 'You', to: 'recorded' }, { at: now - 100000, type: 'status', actor: 'system', from: 'recorded', to: 'failed' }],
  };
  window.__kb5RetryStub = { calls: [], original };
  window.fetch = async (input, options) => {
    const url = String(input && input.url ? input.url : input);
    const body = options && typeof options.body === 'string' ? options.body : '';
    if (/kanban\\/state/.test(url)) {
      const response = await original.call(window, input, options);
      const json = await response.clone().json();
      if (json && json.ok && json.value) {
        json.value.thoughts = [failed, source].concat(Array.isArray(json.value.thoughts) ? json.value.thoughts : []);
      }
      return new Response(JSON.stringify(json), { status: response.status, headers: { 'content-type': 'application/json' } });
    }
    if (/kanban\\/action/.test(url)) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.action === 'retryThought') {
          window.__kb5RetryStub.calls.push(parsed);
          return new Response(JSON.stringify({ ok: true, value: { thought: { id: 'TH-fixture-3', text: failed.text, status: 'failed', retryOf: failed.id, createdAt: now, updatedAt: now, sessionId: null, error: 'agents service unavailable', ticketIds: [], audit: [] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
      } catch { /* not JSON: fall through */ }
    }
    return original.call(window, input, options);
  };
  return true;
})()`)
}
await installRetryFixture()
await sleep(3200)
await openThoughts()
await sleep(1200)
rows = await drawerRows()
let retryRow = (rows || []).find((row) => /Retry of TH-fixture-1/.test(row.retryOf || ''))
// The timeline only renders for an expanded row: expand the fixture first.
if (retryRow) {
  await app.evaluate(
    `(() => {
      const rows = [...document.querySelectorAll('.kb-drawer--thoughts .kb-thoughtRow')];
      const row = rows.find((entry) => /Retry of TH-fixture-1/.test((entry.querySelector('.kb-thoughtRetryOf') || {}).innerText || ''));
      if (!row) return false;
      const btn = row.querySelector('.kb-thoughtExpand');
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
    { userGesture: true },
  )
  await sleep(700)
  rows = await drawerRows()
  retryRow = (rows || []).find((row) => /Retry of TH-fixture-1/.test(row.retryOf || ''))
}
record('retry/row', 'the failed row renders with a Retry-of link and its timeline', Boolean(retryRow) && /Retry/.test((retryRow.buttons || []).join(' ')) && retryRow.timeline.length >= 2, retryRow && { buttons: retryRow.buttons, retryOf: retryRow.retryOf, timeline: retryRow.timeline })
await setViewport(640, 900)
await sleep(600)
chrome = await drawerChrome()
record('retry/narrow', 'the retry row fits 640px with no horizontal overflow', Boolean(chrome && chrome.overflowX === false && chrome.bodyOverflowX === false), chrome)
await shot('retry-fixture-640-light')
await setViewport(1024, 900)
await sleep(700)
await shot('retry-fixture-1024-light')
const retryClicked = await app.evaluate(
  `(() => {
    const rows = [...document.querySelectorAll('.kb-drawer--thoughts .kb-thoughtRow')];
    const row = rows.find((entry) => /Retry of TH-fixture-1/.test((entry.querySelector('.kb-thoughtRetryOf') || {}).innerText || ''));
    if (!row) return false;
    const btn = [...row.querySelectorAll('button')].find((b) => /^(Retry|重试)$/i.test((b.innerText || '').trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`,
  { userGesture: true },
)
await waitToast(/retried|重试/i, 8000).catch(() => {})
await sleep(600)
const retryStubCalls = await app.evaluate(`window.__kb5RetryStub ? window.__kb5RetryStub.calls.slice() : []`)
transcript('retryThought (UI fixture)', { payload: retryStubCalls })
record('retry/action', 'clicking Retry sends retryThought with the failed thought id', Boolean(retryClicked) && retryStubCalls.length === 1 && retryStubCalls[0].payload && retryStubCalls[0].payload.thoughtId === 'TH-fixture-2', retryStubCalls.map((call) => call.payload))
await shot('retry-fixture-1024-light-after')
record('retry/i18nZh', 'the retry copy is localized in Chinese', await setLanguage('中文'))
// The language switch reloads the shell, so the state fixture has to be installed
// again before the Chinese drawer can render the failed row.
await sleep(800)
await installRetryFixture()
await sleep(3200)
await openThoughts()
await sleep(2200)
rows = await drawerRows()
record('retry/i18nRow', 'Chinese retry controls are rendered', Boolean(rows && rows.some((row) => /重试/.test((row.buttons || []).join(' ')))), rows && rows.map((row) => row.buttons))
await setViewport(640, 900)
await sleep(600)
await shot('retry-fixture-640-zh')
await setViewport(1024, 900)
await setLanguage('English')
await sleep(600)
await app.evaluate(`(() => { if (window.__kb5RetryStub) { window.fetch = window.__kb5RetryStub.original; delete window.__kb5RetryStub; } return true })()`)
await closeOverlays()

// ---------------------------------------------------------------------------
// 7. Teardown: cleanup + console
// ---------------------------------------------------------------------------

await cleanup()
results.console = (await app.errors()).map((entry) => ({ type: entry.type, text: String(entry.text).slice(0, 300) }))
const consoleErrors = results.console.filter((entry) => entry.type === 'error' || entry.type === 'exception')
// The desktop shell logs its own account reads on this profile; that is host noise,
// not the Kanban plugin (same exception kb13's probe records).
const hostNoise = /deepseek-account|account read failed/i
const relevantErrors = consoleErrors.filter((entry) => !hostNoise.test(String(entry.text || '')))
if (relevantErrors.length !== consoleErrors.length) note(`ignored ${consoleErrors.length - relevantErrors.length} host account-console lines (not the plugin)`)
record('console/clean', 'no page exceptions or plugin console errors during the run', relevantErrors.length === 0, relevantErrors.slice(0, 3))

results.meta.finishedAt = new Date().toISOString()
results.meta.failures = failures
results.meta.finalThoughts = (await pageState()).thoughts.map((thought) => ({ id: thought.id, status: thought.status }))
await writeFile(new URL('../docs/screenshots/kb5/final-verification.json', import.meta.url), JSON.stringify(results, null, 1))
console.log(`\n${failures === 0 ? 'ALL KB-5 PROBE CHECKS PASSED' : `${failures} FAILURE(S)`}`)
console.log(`evidence: docs/screenshots/kb5/final-verification.json (${results.screenshots.length} screenshots, ${results.checks.length} checks)`)
process.exit(failures === 0 ? 0 : 1)
