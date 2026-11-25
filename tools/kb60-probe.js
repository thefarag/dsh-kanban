/**
 * KB-60 verification probe — Thoughts drawer renders captured thought text as
 * Markdown when expanded, with the 3-line plain-text preview preserved.
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) and
 * asserts the KB-60 acceptance contract end to end:
 *   AC1  expanded row renders heading/list/inline code/fenced code/link/table
 *        through the shipped MarkdownBody (no literal-marker wall)
 *   AC2  collapsed row clamps at 3 × 18.75 px, shows the marker-free projection
 *        (literal C#, issue #12 and a prose pipe survive), and keeps its height
 *        when the expand control takes focus
 *   AC3  edit pre-fills the stored source byte-for-byte; a successful save keeps
 *        the trim-to-non-empty rule and re-renders as Markdown; an empty save
 *        shows thought.emptyError and persists nothing
 *   AC4  a 4000-character thought with one very long fenced line: no drawer or
 *        page horizontal overflow at 1024/640, the code block scrolls inside
 *        itself, and collapsing restores the ≤3-line state
 *   AC5  queued/cancelled rows keep their status text and edit/delete controls;
 *        the failed row's Retry + error stay plain (component-level fallback)
 *   AC6  aria-expanded toggles, Space and Enter activate the native button, the
 *        Expand/Collapse label swaps, and the row-control focus order survives
 *   AC7  zh renders localized Expand/Collapse and code/table/link aria labels
 *   AC8  expand/collapse, edit/save, cancel (working → cancelling immediately),
 *        delete (two-step control) and ticket-chip navigation still work
 *
 * Fixture strategy (stated, not hidden):
 *   - Real host mutations on the currently selected project board: pauseBoard →
 *     submitThought (persisted `queued`, no session dispatched) → UI drive →
 *     deleteThought → resumeBoard. The cancelled row needs a real dispatch, so
 *     it is submitted after resume and cancelled through the host immediately;
 *     the row's created tickets are recorded (none expected).
 *   - The failed-only Retry/error branch cannot be produced safely (a dispatch
 *     failure would need a live agent session), so it is rendered from the
 *     shipped ThoughtRowView under the gated `__KB60_THOUGHT_TEST__` seam in
 *     Node and labelled `component-level` in this JSON.
 *   - Everything is restored in a `finally`: paused flag, thought count, theme
 *     and language; a failed run cannot leave the board paused.
 *
 * Writes docs/screenshots/kb60/final-verification.json + labelled PNGs.
 *
 * Usage (Chrome on port 9333, GUI URL in $DSH_WEB_URL):
 *   node tools/kb60-probe.js
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { attach, APP_URL } from './cdp.mjs'

const REPO_ROOT = new URL('../', import.meta.url)
const OUT_URL = new URL('../docs/screenshots/kb60/', import.meta.url)
const OUT = fileURLToPath(OUT_URL)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = {
  meta: { ticket: 'KB-60', url: APP_URL },
  checks: [],
  measurements: {},
  screenshots: [],
  console: [],
  notes: [],
  cleanup: [],
}
let failures = 0
const record = (id, name, pass, detail) => {
  results.checks.push({ id, name, pass: pass === true, detail: detail === undefined ? null : detail })
  if (pass !== true) failures += 1
  console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 320)}`}`)
}
const note = (text) => {
  results.notes.push(text)
  console.log('note ' + text)
}

// ---------------------------------------------------------------------------
// 0a. Node-side: the shipped row component, failed-only branch + projection
// ---------------------------------------------------------------------------

const clientSource = await readFile(new URL('client.js', REPO_ROOT), 'utf8')
let captured = null
globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } }
globalThis.window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}, activeElement: null }
globalThis.__KB60_THOUGHT_TEST__ = true
await import(`data:text/javascript;base64,${Buffer.from(clientSource).toString('base64')}`)

const hooksByComponent = new Map()
let currentComponent = null
const hookEntry = (component) => {
  if (!hooksByComponent.has(component)) hooksByComponent.set(component, { hooks: [], cursor: 0 })
  return hooksByComponent.get(component)
}
const fakeReact = {
  Component: class Component {
    constructor(props) {
      this.props = props
    }
  },
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState(initial) {
    const entry = hookEntry(currentComponent)
    const index = entry.cursor
    entry.cursor += 1
    if (!entry.hooks[index]) entry.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    return [entry.hooks[index].value, () => {}]
  },
  useEffect() {},
  useRef(initial) {
    const entry = hookEntry(currentComponent)
    const index = entry.cursor
    entry.cursor += 1
    if (!entry.hooks[index]) entry.hooks[index] = { current: typeof initial === 'function' ? initial() : initial }
    return entry.hooks[index]
  },
  useCallback: (fn) => fn,
  useMemo(factory, deps) {
    const entry = hookEntry(currentComponent)
    const index = entry.cursor
    entry.cursor += 1
    const previous = entry.hooks[index]
    const same = previous && Array.isArray(deps) && Array.isArray(previous.deps) && deps.length === previous.deps.length && deps.every((value, at) => Object.is(value, previous.deps[at]))
    if (same) return previous.value
    const value = factory()
    entry.hooks[index] = { deps: deps || [], value }
    return value
  },
}
const resolveTree = (node) => {
  if (Array.isArray(node)) return node.map(resolveTree)
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const previous = currentComponent
    currentComponent = node.type
    const entry = hookEntry(node.type)
    entry.cursor = 0
    let result
    try {
      result = node.type({ ...node.props, children: node.children.length > 0 ? node.children : node.props.children })
    } finally {
      currentComponent = previous
    }
    return resolveTree(result)
  }
  return { type: node.type, props: node.props, children: node.children.map(resolveTree) }
}
const pluginNode = captured.factory((name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require ${name}`)
})
delete globalThis.__KB60_THOUGHT_TEST__
delete globalThis.window
delete globalThis.document
const seam = pluginNode.__thoughtRow
if (!seam || typeof seam.project !== 'function' || typeof seam.ThoughtRowView !== 'function') {
  throw new Error('KB-60 test seam missing from the shipped client module')
}
const projectPreview = seam.project
const ThoughtRowView = seam.ThoughtRowView

const elementsOf = (tree) => {
  const out = []
  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (!node || typeof node !== 'object') return
    out.push(node)
    walk(node.children)
  }
  walk(tree)
  return out
}
const textOf = (tree) => {
  if (typeof tree === 'string') return tree
  if (tree === null || tree === undefined) return ''
  if (Array.isArray(tree)) return tree.map(textOf).join('')
  if (typeof tree === 'object') return textOf(tree.children)
  return ''
}
const byClass = (tree, className) => elementsOf(tree).filter((node) => String((node.props || {}).className || '').split(/\s+/).includes(className))
const tEn = (key) =>
  ({
    'thought.expand': 'Expand',
    'thought.collapse': 'Collapse',
    'thought.retry': 'Retry',
    'thought.cancel': 'Cancel run',
    'thought.edit': 'Edit',
    'thought.delete': 'Delete',
    'thought.status.failed': 'Failed',
    'thought.error': '',
    'thought.queuedHint': 'Queued — it runs when the board resumes',
    'time.justNow': 'just now',
    'md.codeBlock': 'Code block',
    'md.table': 'Table',
    'md.linkExternal': 'opens in a new tab',
  })[key] ?? key
const failedThought = {
  id: 'TH-60-failed',
  text: '# Failed thought\n\nA **failed** thought keeps its source.',
  status: 'failed',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  sessionId: null,
  error: 'the product manager session did not start',
  ticketIds: [],
}
const failedTree = resolveTree({
  type: ThoughtRowView,
  props: {
    t: tEn,
    thought: failedThought,
    expanded: false,
    pending: {},
    onToggle() {},
    onOpenTicket() {},
    openSession() {},
    onRetry() {},
    onCancel() {},
    onEdit() {},
    onDelete() {},
    onOpenThought() {},
    retryTargetKnown: false,
  },
  children: [],
})
const failedButtons = elementsOf(failedTree)
  .filter((node) => node.type === 'button')
  .map((node) => textOf(node).trim())
const failedErrors = byClass(failedTree, 'kb-thoughtError').map((node) => textOf(node).trim())
record('failed/component-level', 'failed branch renders from the shipped component (component-level fixture)', failedButtons.includes('Retry') && failedButtons.includes('Edit') && failedButtons.includes('Delete'), { buttons: failedButtons, source: 'component-level' })
record('failed/plainError', 'failed row error stays plain system text outside .kb-md', failedErrors.length === 1 && failedErrors[0] === failedThought.error && byClass(failedTree, 'kb-md').length === 0, { error: failedErrors[0] })
record('failed/noCancel', 'failed row has no Cancel control', failedButtons.includes('Cancel run') === false && failedButtons.includes('Expand') === true, failedButtons)
note('failed/Retry is component-level: forcing a dispatch failure would spawn a real product-manager session, so the failed-only branch is rendered from the shipped ThoughtRowView in Node.')

const FIXTURE_HEAD = [
  '# Ship the settings page',
  '',
  'A paragraph with **bold**, *emphasis*, `inline code`, C#, issue #12 and a paragraph | pipe that is not a table.',
  '',
  '- first bullet',
  '- second bullet with [the docs](https://example.com/docs)',
  '',
  '| **Column one** | `Column two` with [the docs](https://example.com/table) |',
  '| --- | --- |',
  '| cell one | cell two |',
  '',
  '```js',
].join('\n') + '\n'
const FIXTURE_TAIL = '\n```'
const filler = 4000 - FIXTURE_HEAD.length - FIXTURE_TAIL.length - "const longLine = ''".length
const FIXTURE = FIXTURE_HEAD + "const longLine = '" + 'x'.repeat(filler) + "'" + FIXTURE_TAIL
if (FIXTURE.length !== 4000) throw new Error(`fixture length ${FIXTURE.length}, expected 4000`)
const EXPECTED_PREVIEW = projectPreview(FIXTURE)
results.measurements.fixtureLength = FIXTURE.length
results.measurements.projectionLength = EXPECTED_PREVIEW.length
record('fixture/length', 'the long fixture is exactly 4000 characters', FIXTURE.length === 4000, FIXTURE.length)
record('fixture/projection', 'the projection is one line and keeps literal C#/#12/prose pipe', !EXPECTED_PREVIEW.includes('\n') && EXPECTED_PREVIEW.includes('C#') && EXPECTED_PREVIEW.includes('issue #12') && EXPECTED_PREVIEW.includes('paragraph | pipe'), { length: EXPECTED_PREVIEW.length })

// ---------------------------------------------------------------------------
// 0b. Browser helpers
// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true })
const app = await attach()
results.meta.startedAt = new Date().toISOString()

async function setViewport(width, height = 900) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
}
const settingsVisible = () =>
  app.evaluate(`[...document.querySelectorAll('button')].some((b) => /^(General|Account)$/.test((b.textContent || '').trim()) && b.getBoundingClientRect().width > 0)`)
const settingsButtonVisible = (label) =>
  app.evaluate(`[...document.querySelectorAll('button')].some((b) => (b.textContent || '').trim() === ${JSON.stringify(label)} && b.getBoundingClientRect().width > 0)`)
const clickSettingsButton = (label) =>
  app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)} && x.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true })()`, { userGesture: true })
/**
 * Switch the real shell theme through Settings → General → Appearance. This
 * profile pins the theme source to light, so prefers-color-scheme emulation does
 * not repaint the board; clicking the shipped Light/Dark cubes does.
 */
async function setThemeMode(mode) {
  await pressSettingsShortcut()
  for (let attempt = 0; attempt < 25 && !(await settingsVisible()); attempt += 1) await sleep(300)
  if (await settingsButtonVisible('General')) await clickSettingsButton('General')
  await sleep(600)
  for (let attempt = 0; attempt < 25 && !(await settingsButtonVisible(mode)); attempt += 1) await sleep(300)
  const clicked = await clickSettingsButton(mode)
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const state = await app.evaluate(`(() => ({ dark: document.body.hasAttribute('data-ds-dark-theme') }))()`)
    if ((mode === 'Dark') === (state.dark === true)) break
    await sleep(250)
  }
  await app.key('Escape')
  await sleep(650)
  return clicked
}
const themeState = () =>
  app.evaluate(`(() => {
    const root = document.querySelector('.kb-root');
    const style = root ? getComputedStyle(root) : null;
    return {
      source: document.documentElement.dataset.dsThemeSource || null,
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      rootBg: style ? style.backgroundColor : null,
      labelColor: style ? style.color : null,
    };
  })()`)
const hasPanel = () => app.evaluate(`!!document.querySelector('.kb-root')`)
async function dismissNotices() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await app.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => /^(Continue|Got it|Dismiss)$/i.test((b.textContent || '').trim()));
      if (!btn || btn.getBoundingClientRect().width === 0) return false;
      btn.click(); return true;
    })()`, { userGesture: true })
    if (!clicked) return
    await sleep(350)
  }
}
async function dismissAppModals() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const clicked = await app.evaluate(`(() => {
      const outside = [...document.querySelectorAll('button')].filter((b) => !b.closest('.kb-root') && b.getBoundingClientRect().width > 0 && !b.disabled);
      const close = outside.find((b) => {
        const label = (b.getAttribute('aria-label') || '').trim();
        const text = (b.textContent || '').trim();
        return /^(close|dismiss|got it|continue)$/i.test(label) || /^(continue|close|dismiss|got it)$/i.test(text);
      });
      if (!close) return false;
      close.click(); return true;
    })()`, { userGesture: true })
    if (!clicked) return
    await sleep(350)
  }
}
async function openPanel() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (await hasPanel()) return true
    await dismissAppModals()
    await app.evaluate(`(() => {
      const row = [...document.querySelectorAll('button')].find((b) => {
        if (b.getBoundingClientRect().width === 0) return false;
        const label = (b.getAttribute('aria-label') || '').trim();
        const text = (b.textContent || '').trim();
        return /^(kanban|看板)$/i.test(label) || /^(kanban|看板)$/i.test(text);
      });
      if (row) row.click();
    })()`, { userGesture: true })
    await sleep(1200)
  }
  throw new Error('could not open the Kanban panel')
}
async function clickHeader(label) {
  await dismissAppModals()
  const clicked = await app.evaluate(`(() => {
    const header = document.querySelector('.kb-header');
    if (!header) return false;
    const want = ${JSON.stringify(label.toLowerCase())};
    const el = [...header.querySelectorAll('button')].find((n) => [n.getAttribute('aria-label') || '', n.getAttribute('title') || '', n.textContent || ''].join(' ').replace(/\\s+/g, ' ').trim().toLowerCase().includes(want));
    if (!el) return false;
    el.click(); return true;
  })()`, { userGesture: true })
  await sleep(600)
  return clicked
}
async function clickRowButton(label) {
  const clicked = await app.evaluate(`(() => {
    const row = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow');
    if (!row) return false;
    const want = ${JSON.stringify(label.toLowerCase())};
    const el = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim().toLowerCase() === want);
    if (!el || el.disabled) return false;
    el.click(); return true;
  })()`, { userGesture: true })
  await sleep(500)
  return clicked
}
async function closeOverlays() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const open = await app.evaluate(`!!document.querySelector('.kb-drawer') || !!document.querySelector('.kb-dialog')`)
    if (!open) return
    await app.key('Escape')
    await sleep(350)
  }
}
/** The header Thoughts control is a toggle, so open only when the drawer is closed. */
async function ensureThoughtsDrawer(label = 'Thoughts') {
  const open = await app.evaluate('!!document.querySelector(".kb-drawer--thoughts")')
  if (!open) await clickHeader(label)
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts')`, 'thoughts drawer')
  await sleep(400)
}
async function pageState() {
  return app.evaluate(`(async () => {
    const response = await fetch('/kanban/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const payload = await response.json();
    return payload.ok ? payload.value : { error: payload.error };
  })()`)
}
let workspaceId = ''
const boardPaused = (snap) => Boolean(snap && snap.board && snap.board.paused === true)
async function pageAction(action, payload = {}) {
  return app.evaluate(`(async () => {
    const response = await fetch('/kanban/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId)}, action: ${JSON.stringify(action)}, payload: ${JSON.stringify(payload)} }),
    });
    const payload = await response.json();
    return { status: response.status, ok: payload.ok === true, value: payload.value, error: payload.error };
  })()`)
}
const safeAction = async (action, payload) => {
  try {
    return await pageAction(action, payload)
  } catch (error) {
    return { status: 0, ok: false, error: { message: String((error && error.message) || error) } }
  }
}
async function waitFor(expression, label, timeoutMs = 12000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await app.evaluate(`(() => { try { return !!(${expression}) } catch (error) { return false } })()`).catch(() => false)
    if (value) return true
    await sleep(200)
  }
  throw new Error('timeout waiting for ' + label)
}
async function shot(name, width, theme) {
  await app.screenshot(`${OUT}${name}.png`)
  results.screenshots.push({ file: `${name}.png`, ticket: 'KB-60', width, theme })
  console.log(`SHOT ${name}.png (${width}px ${theme})`)
}

let fixtureId = ''
/**
 * The board is shared state: a human clicking Resume board while the probe runs
 * would drain the queued fixture. Re-check paused + queued before every phase
 * that depends on the queued row, and abort into the cleanup path if it moved.
 */
async function fixtureHealth(label) {
  const snapshot = await pageState()
  const thought = (snapshot.thoughts || []).find((entry) => entry.id === fixtureId)
  const paused = boardPaused(snapshot)
  const healthy = paused === true && Boolean(thought) && thought.status === 'queued'
  record(`fixture/health/${label}`, `the paused queued fixture survives ${label}`, healthy, { paused, status: thought && thought.status })
  if (!healthy) throw new Error(`board state changed underneath the probe at ${label} (paused=${paused}, status=${thought && thought.status})`)
}

const rowsState = () =>
  app.evaluate(`(() => {
    const drawer = document.querySelector('.kb-drawer--thoughts');
    if (!drawer) return null;
    return [...drawer.querySelectorAll('.kb-thoughtRow')].map((row) => {
      const textEl = row.querySelector('.kb-thoughtText');
      const md = row.querySelector('.kb-md');
      const pre = row.querySelector('.kb-md pre');
      const expand = [...row.querySelectorAll('button')].find((b) => /^(Expand|Collapse|展开|收起)$/i.test((b.textContent || '').trim()));
      return {
        status: ((row.querySelector('.kb-thoughtStatus') || {}).innerText || '').trim(),
        hint: ((row.querySelector('.kb-thoughtHint') || {}).innerText || '').trim() || null,
        error: ((row.querySelector('.kb-thoughtError') || {}).innerText || '').trim() || null,
        age: ((row.querySelector('.kb-thoughtAge') || {}).innerText || '').trim(),
        text: textEl ? textEl.innerText : null,
        textClass: textEl ? textEl.className : null,
        clientHeight: textEl ? textEl.clientHeight : null,
        scrollHeight: textEl ? textEl.scrollHeight : null,
        fontSize: textEl ? getComputedStyle(textEl).fontSize : null,
        lineHeight: textEl ? getComputedStyle(textEl).lineHeight : null,
        rowHeight: Math.round(row.getBoundingClientRect().height),
        expanded: expand ? expand.getAttribute('aria-expanded') : null,
        expandLabel: expand ? (expand.textContent || '').trim() : null,
        buttons: [...row.querySelectorAll('button')].map((b) => ({ text: (b.textContent || '').trim(), aria: b.getAttribute('aria-label'), disabled: b.disabled === true })),
        chips: [...row.querySelectorAll('.kb-thoughtChip')].map((c) => (c.textContent || '').trim()),
        textarea: row.querySelector('textarea') ? row.querySelector('textarea').value : null,
        markdown: md ? {
          headings: md.querySelectorAll('h3,h4,h5,h6').length,
          lists: md.querySelectorAll('ul,ol').length,
          listItems: md.querySelectorAll('li').length,
          codes: md.querySelectorAll('code').length,
          pres: md.querySelectorAll('pre').length,
          links: md.querySelectorAll('a').length,
          tables: md.querySelectorAll('table').length,
          tableRegions: [...md.querySelectorAll('.kb-md-tableWrap')].map((w) => w.getAttribute('aria-label')),
          preAria: pre ? pre.getAttribute('aria-label') : null,
          preOverflowX: pre ? getComputedStyle(pre).overflowX : null,
          preScrollWidth: pre ? pre.scrollWidth : null,
          preClientWidth: pre ? pre.clientWidth : null,
          linkAria: [...md.querySelectorAll('a')].map((a) => a.getAttribute('aria-label')),
          text: md.innerText,
        } : null,
        drawerScrollWidth: drawer.scrollWidth,
        drawerClientWidth: drawer.clientWidth,
      };
    });
  })()`)

const focusExpand = () =>
  app.evaluate(`(() => {
    const row = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow');
    const text = row.querySelector('.kb-thoughtText');
    const before = { row: row.getBoundingClientRect().height, text: text.getBoundingClientRect().height };
    const btn = [...row.querySelectorAll('button')].find((b) => /^(Expand|展开)$/.test((b.textContent || '').trim()));
    if (!btn) return { focused: false };
    btn.focus();
    const after = { row: row.getBoundingClientRect().height, text: text.getBoundingClientRect().height };
    const style = getComputedStyle(btn);
    const rule = [...document.querySelectorAll('style')].some((sheet) => (sheet.textContent || '').indexOf('.kb-thoughtExpand:focus-visible') !== -1);
    return { focused: document.activeElement === btn, before, after, outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle, rule };
  })()`)

const rowTabOrder = () =>
  app.evaluate(`(() => {
    const row = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow');
    const all = [...row.querySelectorAll('button,a[href],input,textarea,select,pre[tabindex],.kb-md-tableWrap[tabindex],[tabindex]:not([tabindex="-1"])')];
    const map = (el) => ({ tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 40), aria: el.getAttribute('aria-label'), tabIndex: el.tabIndex });
    return {
      controls: all.filter((el) => !el.closest('.kb-md')).map(map),
      markdown: all.filter((el) => el.closest('.kb-md')).map(map),
    };
  })()`)

const overflowState = () =>
  app.evaluate(`(() => {
    const drawer = document.querySelector('.kb-drawer--thoughts');
    const row = drawer && drawer.querySelector('.kb-thoughtRow');
    const pre = row && row.querySelector('.kb-md pre');
    return {
      page: { scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth },
      drawer: drawer ? { scrollWidth: drawer.scrollWidth, clientWidth: drawer.clientWidth } : null,
      row: row ? { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth } : null,
      pre: pre ? { scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, overflowX: getComputedStyle(pre).overflowX } : null,
    };
  })()`)

async function pressSpace() {
  for (const type of ['keyDown', 'keyUp']) {
    await app.cdp.send('Input.dispatchKeyEvent', {
      type,
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
      ...(type === 'keyDown' ? { text: ' ' } : {}),
    })
  }
  await sleep(450)
}
async function pressEnter() {
  // A native button activates on Enter only when the key event carries text.
  for (const type of ['keyDown', 'keyUp']) {
    await app.cdp.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r' } : {}),
    })
  }
  await sleep(450)
}

// --- language switching (kb3/kb5/kb58/kb59 probe convention) ----------------
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
  const generalTabVisible = () =>
    app.evaluate(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0)`)
  const clickGeneral = () =>
    app.evaluate(`(() => { const el = [...document.querySelectorAll('button,[role="tab"]')].find((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`, { userGesture: true })
  const waitSettings = async (label) => {
    try {
      await waitFor(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()))`, label, 6000)
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
    await sleep(450)
  }
  return false
}
async function setLanguage(target) {
  const steps = {}
  await reloadShell()
  await dismissNotices()
  await dismissAppModals()
  await openPanel()
  await sleep(600)
  steps.opened = await openSettings()
  if (!steps.opened) {
    results.notes.push({ language: target, steps })
    return false
  }
  steps.openPicker = await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /^(English|中文)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!b) return false; b.click(); return true })()`, { userGesture: true })
  await sleep(600)
  steps.pick = await app.evaluate(`(() => { const el = [...document.querySelectorAll('button,[role="option"],[role="menuitem"],li')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(target)} && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`, { userGesture: true })
  await sleep(1200)
  await closeSettings()
  await dismissAppModals()
  await sleep(300)
  const expectedTitle = target === '中文' ? '看板' : 'Kanban'
  try {
    await waitFor(`(() => { const el = document.querySelector('.kb-root .kb-title'); return el && (el.textContent || '').trim() === ${JSON.stringify(expectedTitle)} })()`, 'language ' + target, 8000)
    steps.changed = true
  } catch {
    steps.changed = false
  }
  results.notes.push({ language: target, steps })
  return steps.pick === true && steps.changed === true
}

// ---------------------------------------------------------------------------
// 1. Boot, baseline, pause, submit the 4000-character fixture
// ---------------------------------------------------------------------------

let baseline = null
let pausedPinned = false
let language = 'English'
const fixtures = []
const deleted = new Set()

try {
  await app.ensureApp({ reload: true })
  await setViewport(1280, 900)
  await setThemeMode('Light')
  await dismissNotices()
  await openPanel()
  await sleep(600)

  let snap = await pageState()
  workspaceId = typeof snap.workspaceId === 'string' ? snap.workspaceId : ''
  baseline = {
    paused: boardPaused(snap),
    thoughtCount: Array.isArray(snap.thoughts) ? snap.thoughts.length : -1,
    thoughtIds: Array.isArray(snap.thoughts) ? snap.thoughts.map((thought) => thought.id) : [],
  }
  results.measurements.baseline = baseline
  record('baseline/read', 'baseline board state is readable', Boolean(workspaceId) && Array.isArray(snap.thoughts), baseline)

  const paused = await pageAction('pauseBoard', {})
  pausedPinned = paused.ok === true
  record('fixture/paused', 'the board pauses before the queued fixture is submitted', paused.ok === true, paused.status)

  const submitted = await pageAction('submitThought', { text: FIXTURE })
  const fixture = submitted.value && submitted.value.thought
  record('fixture/submitted', 'submitThought persists the 4000-character fixture as queued', submitted.ok === true && Boolean(fixture) && fixture.status === 'queued' && fixture.text === FIXTURE, fixture && { id: fixture.id, status: fixture.status, storedExact: fixture.text === FIXTURE })
  if (!fixture) throw new Error('fixture thought was not created')
  fixtureId = fixture.id
  fixtures.push(fixtureId)
  results.meta.fixtureId = fixtureId

  // -------------------------------------------------------------------------
  // 2. Collapsed row: clamp, marker-free projection, focus height
  // -------------------------------------------------------------------------
  await ensureThoughtsDrawer()
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow')`, 'thoughts drawer row')
  await waitFor(`document.querySelectorAll('.kb-drawer--thoughts .kb-thoughtRow').length >= 1 && ((document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-thoughtStatus') || {}).innerText || '').includes('Queued')`, 'queued row label')
  await sleep(600)

  for (const width of [1024, 640]) {
    await setViewport(width, 900)
    await sleep(500)
    const rows = await rowsState()
    const row = rows && rows[0]
    record(`collapsed/${width}/clamp`, `collapsed row is at most 3 × 18.75 px at ${width}`, row && row.clientHeight <= 3 * 18.75 + 1 && row.scrollHeight > row.clientHeight, row && { clientHeight: row.clientHeight, scrollHeight: row.scrollHeight, lineHeight: row.lineHeight })
    record(`collapsed/${width}/projection`, `collapsed row shows the marker-free projection at ${width}`, row && row.text === EXPECTED_PREVIEW && !row.text.includes('\n'), row && { exact: row.text === EXPECTED_PREVIEW, length: row.text && row.text.length })
    record(
      `collapsed/${width}/noSyntax`,
      `collapsed row shows no Markdown syntax for the fixture at ${width}`,
      row && !['# Ship', '**', '`', '```', '| --- |', '](https://'].some((marker) => row.text.includes(marker)),
      row && ['# Ship', '**', '`', '```', '| --- |', '](https://'].filter((marker) => row.text.includes(marker)),
    )
    record(`collapsed/${width}/literals`, `collapsed row keeps literal C#, issue #12 and the prose pipe at ${width}`, row && row.text.includes('C#') && row.text.includes('issue #12') && row.text.includes('paragraph | pipe'), row && { csharp: row.text.includes('C#'), issue: row.text.includes('issue #12'), pipe: row.text.includes('paragraph | pipe') })
    record(`collapsed/${width}/noMarkdown`, `collapsed row mounts no MarkdownBody at ${width}`, row && row.markdown === null && row.textClass === 'kb-thoughtText', row && row.textClass)
    await shot(`kb60-collapsed-${width}-light`, width, 'light')
  }

  await setViewport(1024, 900)
  await sleep(400)
  const focus = await focusExpand()
  record('collapsed/focusHeight', 'row height does not change when the expand control takes focus', focus.focused === true && Math.abs(focus.after.row - focus.before.row) < 0.5 && Math.abs(focus.after.text - focus.before.text) < 0.5, focus)
  record('collapsed/focusVisible', 'the expand control defines a visible focus ring', focus.focused === true && focus.rule === true, { outlineStyle: focus.outlineStyle, outlineWidth: focus.outlineWidth, rule: focus.rule })
  results.measurements.collapsedAt1024 = (await rowsState())[0]

  // -------------------------------------------------------------------------
  // 3. AC1 expanded Markdown + AC4 overflow + AC6 keyboard
  // -------------------------------------------------------------------------
  await fixtureHealth('before expand')
  const collapsedTabOrder = await rowTabOrder()
  const expandClicked = await clickRowButton('Expand')
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-md')`, 'expanded markdown body')
  await sleep(500)
  const expandedRows = await rowsState()
  const expandedRow = expandedRows && expandedRows[0]
  record('expanded/markdown', 'expanded row renders heading, list, inline code, fenced code, link and table', Boolean(expandedRow && expandedRow.markdown) && expandedRow.markdown.headings >= 1 && expandedRow.markdown.lists >= 1 && expandedRow.markdown.listItems >= 2 && expandedRow.markdown.codes >= 2 && expandedRow.markdown.pres >= 1 && expandedRow.markdown.links >= 1 && expandedRow.markdown.tables >= 1, expandedRow && expandedRow.markdown && { headings: expandedRow.markdown.headings, lists: expandedRow.markdown.lists, codes: expandedRow.markdown.codes, pres: expandedRow.markdown.pres, links: expandedRow.markdown.links, tables: expandedRow.markdown.tables })
  record('expanded/noRawMarkers', 'expanded row is not a raw-marker wall', Boolean(expandedRow && expandedRow.markdown) && !['**', '```', '](https://', '| --- |', '# Ship'].some((marker) => expandedRow.markdown.text.includes(marker)) && expandedRow.markdown.text.includes('Ship the settings page'), expandedRow && expandedRow.markdown && ['**', '```', '](https://', '| --- |', '# Ship'].filter((marker) => expandedRow.markdown.text.includes(marker)))
  record('expanded/ariaExpanded', 'aria-expanded flips false → true and the label swaps to Collapse', Boolean(expandedRow) && expandedRow.expanded === 'true' && expandedRow.expandLabel === 'Collapse', expandedRow && { expanded: expandedRow.expanded, label: expandedRow.expandLabel })

  const tabOrderExpanded = await rowTabOrder()
  // The first control's label legitimately swaps Expand ↔ Collapse; order is what matters.
  const normalizeControl = (entry) => ({ ...entry, text: /^(Expand|Collapse)$/.test(entry.text) ? '<toggle>' : entry.text })
  record('keyboard/focusOrder', 'expanding keeps the row-control focus order unchanged', expandClicked === true && JSON.stringify(tabOrderExpanded.controls.map(normalizeControl)) === JSON.stringify(collapsedTabOrder.controls.map(normalizeControl)), { collapsed: collapsedTabOrder.controls, expanded: tabOrderExpanded.controls })
  record('keyboard/markdownFocusables', 'expanded Markdown adds only in-body focusables (KB-57 pre/table regions)', tabOrderExpanded.markdown.length >= 1 && tabOrderExpanded.markdown.every((entry) => entry.tabIndex === 0), tabOrderExpanded.markdown)
  results.measurements.tabOrder = { collapsed: collapsedTabOrder, expanded: tabOrderExpanded }

  for (const width of [1024, 640]) {
    await setViewport(width, 900)
    await sleep(500)
    const overflow = await overflowState()
    record(`overflow/${width}/drawer`, `no drawer horizontal overflow at ${width}`, Boolean(overflow.drawer) && overflow.drawer.scrollWidth <= overflow.drawer.clientWidth + 1, overflow.drawer)
    record(`overflow/${width}/page`, `no page horizontal overflow at ${width}`, overflow.page.scrollWidth <= overflow.page.innerWidth + 1, overflow.page)
    record(`overflow/${width}/codeScrolls`, `the long fenced code line scrolls inside the code block at ${width}`, Boolean(overflow.pre) && overflow.pre.scrollWidth > overflow.pre.clientWidth && overflow.pre.overflowX === 'auto', overflow.pre)
    const rows = await rowsState()
    record(`overflow/${width}/codeAria`, `the code block keeps its localized aria label at ${width}`, rows && rows[0].markdown.preAria === 'Code block', rows && rows[0].markdown.preAria)
    await shot(`kb60-expanded-${width}-light`, width, 'light')
  }

  // AC6 keyboard: Space expands, Enter collapses, on the native button.
  await setViewport(1024, 900)
  await app.evaluate(`(() => {
    const row = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow');
    const btn = [...row.querySelectorAll('button')].find((b) => /^(Expand|Collapse)$/.test((b.textContent || '').trim()));
    if (btn) btn.focus();
    return true;
  })()`)
  await sleep(200)
  // Currently expanded: Enter collapses it.
  await pressEnter()
  await sleep(400)
  let keyboardRows = await rowsState()
  record('keyboard/enterCollapses', 'Enter activates the native button and collapses the row', keyboardRows && keyboardRows[0].expanded === 'false' && keyboardRows[0].expandLabel === 'Expand' && keyboardRows[0].markdown === null, keyboardRows && { expanded: keyboardRows[0].expanded, label: keyboardRows[0].expandLabel })
  record('keyboard/collapseHeight', 'collapsing returns the row to the ≤3-line state', keyboardRows && keyboardRows[0].clientHeight <= 3 * 18.75 + 1 && keyboardRows[0].scrollHeight > keyboardRows[0].clientHeight, keyboardRows && { clientHeight: keyboardRows[0].clientHeight, scrollHeight: keyboardRows[0].scrollHeight, lineHeight: keyboardRows[0].lineHeight })
  await focusExpand()
  await pressSpace()
  keyboardRows = await rowsState()
  record('keyboard/spaceExpands', 'Space activates the native button and expands the row', keyboardRows && keyboardRows[0].expanded === 'true' && keyboardRows[0].expandLabel === 'Collapse' && keyboardRows[0].markdown !== null, keyboardRows && { expanded: keyboardRows[0].expanded, label: keyboardRows[0].expandLabel })

  await fixtureHealth('before dark-theme evidence')
  // -------------------------------------------------------------------------
  // 4. Dark-theme evidence from the same final build
  // -------------------------------------------------------------------------
  // The shell ignores its settings shortcut while a modal drawer is open.
  await closeOverlays()
  const darkMode = await setThemeMode('Dark')
  const darkState = await themeState()
  record('dark/mode', 'the shell dark theme mode is applied through Settings → Appearance', darkMode === true && darkState.dark === true && darkState.source === 'dark', darkState)
  await ensureThoughtsDrawer()
  if (!(await app.evaluate(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-md')`))) await clickRowButton('Expand')
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-md')`, 'expanded dark body')
  for (const width of [1024, 640]) {
    await setViewport(width, 900)
    await sleep(500)
    const dark = await themeState()
    record(`dark/${width}`, `dark theme tokens apply at ${width}`, dark.dark === true, dark)
    await shot(`kb60-expanded-${width}-dark`, width, 'dark')
  }
  // Collapse for the dark collapsed shot.
  await clickRowButton('Collapse')
  await waitFor(`!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-md')`, 'collapsed row')
  await setViewport(1024, 900)
  await sleep(400)
  await shot('kb60-collapsed-1024-dark', 1024, 'dark')
  // Same modal rule in reverse: the drawer must close for the shortcut to work.
  await closeOverlays()
  const lightMode = await setThemeMode('Light')
  const lightState = await themeState()
  record('dark/restoredLight', 'the shell returns to the light theme', lightMode === true && lightState.dark === false, lightState)
  await ensureThoughtsDrawer()

  await fixtureHealth('before edit')
  // -------------------------------------------------------------------------
  // 5. AC3 edit: byte-exact prefill, Markdown re-render after save, empty save
  // -------------------------------------------------------------------------
  await setViewport(1024, 900)
  await sleep(300)
  const editedSource = [
    '## Edited heading',
    '',
    '- edited bullet with **bold**',
    '',
    'An edited paragraph with `code` and [the spec](https://example.com/edited).',
    '',
    '| One | Two |',
    '| --- | --- |',
    '| a | b |',
    '',
    '```js',
    'const edited = true',
    '```',
  ].join('\n')
  const editOpened = await clickRowButton('Edit')
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow textarea')`, 'edit textarea')
  const prefill = await rowsState()
  record('edit/prefillByteExact', 'textarea pre-fills the stored source byte-for-byte', editOpened === true && Boolean(prefill) && prefill[0].textarea === FIXTURE, prefill && { exact: prefill[0].textarea === FIXTURE, length: prefill[0].textarea && prefill[0].textarea.length })

  await app.type(`document.querySelector('.kb-drawer--thoughts .kb-thoughtRow textarea')`, editedSource)
  const saved = await clickRowButton('Save')
  await sleep(600)
  await waitFor(`!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow textarea')`, 'edit form closed')
  // Wait for the next poll to deliver the saved text.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshot = await pageState()
    const stored = (snapshot.thoughts || []).find((thought) => thought.id === fixtureId)
    if (stored && stored.text === editedSource) break
    await sleep(400)
  }
  const afterSaveSnap = (await pageState()).thoughts || []
  const afterSave = afterSaveSnap.find((thought) => thought.id === fixtureId)
  record('edit/saveTrimmed', 'a successful save persists the trimmed draft', saved === true && Boolean(afterSave) && afterSave.text === editedSource, afterSave && { storedExact: afterSave.text === editedSource })
  // Expand so the saved source is visible as Markdown.
  await clickRowButton('Expand')
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-md')`, 'saved markdown body')
  await sleep(400)
  const savedRows = await rowsState()
  record('edit/rendersMarkdown', 'the row re-renders the saved text as Markdown', Boolean(savedRows) && savedRows[0].markdown.headings >= 1 && savedRows[0].markdown.lists >= 1 && savedRows[0].markdown.links >= 1 && savedRows[0].markdown.text.includes('Edited heading'), savedRows && savedRows[0].markdown && { headings: savedRows[0].markdown.headings, lists: savedRows[0].markdown.lists, links: savedRows[0].markdown.links })

  await fixtureHealth('before empty-save check')
  await clickRowButton('Edit')
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow textarea')`, 'edit textarea again')
  await app.type(`document.querySelector('.kb-drawer--thoughts .kb-thoughtRow textarea')`, '   ')
  await clickRowButton('Save')
  await sleep(500)
  const emptyRows = await rowsState()
  const emptyError = await app.evaluate(`(() => { const el = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-thoughtError'); return el ? el.innerText.trim() : null })()`)
  const afterEmptySnap = (await pageState()).thoughts || []
  const afterEmpty = afterEmptySnap.find((thought) => thought.id === fixtureId)
  record('edit/emptyError', 'an empty save shows thought.emptyError and keeps the editor open', emptyError === 'Type a thought before saving it.' && Boolean(emptyRows) && emptyRows[0].textarea !== null, { error: emptyError, stillEditing: emptyRows && emptyRows[0].textarea !== null })
  record('edit/emptyPersistsNothing', 'an empty save persists nothing', Boolean(afterEmpty) && afterEmpty.text === editedSource, afterEmpty && { storedExact: afterEmpty.text === editedSource })
  await clickRowButton('Cancel edit')
  await sleep(300)
  await clickRowButton('Collapse')

  // -------------------------------------------------------------------------
  // 6. AC7 zh: localized Expand/Collapse and code/table/link aria labels
  // -------------------------------------------------------------------------
  language = '中文'
  const zhSwitched = await setLanguage('中文')
  record('zh/switched', 'the shell switches to Chinese', zhSwitched === true)
  await dismissNotices()
  await openPanel()
  await ensureThoughtsDrawer('想法')
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow')`, 'zh thoughts drawer')
  await sleep(600)
  const zhExpand = await clickRowButton('展开')
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow .kb-md')`, 'zh expanded body')
  await sleep(500)
  const zhRows = await rowsState()
  const zhRow = zhRows && zhRows[0]
  record('zh/labels', 'zh renders the localized Expand/Collapse label', zhExpand === true && zhRow.expandLabel === '收起', zhRow && { expand: zhExpand, label: zhRow && zhRow.expandLabel })
  record('zh/markdownAria', 'zh keeps code/table/link aria labels localized through t', Boolean(zhRow && zhRow.markdown) && zhRow.markdown.preAria === '代码块' && zhRow.markdown.tableRegions.includes('表格') && zhRow.markdown.linkAria.some((label) => /在新标签页打开/.test(String(label))), zhRow && zhRow.markdown && { code: zhRow.markdown.preAria, tables: zhRow.markdown.tableRegions, links: zhRow.markdown.linkAria })
  await setViewport(1024, 900)
  await sleep(400)
  await shot('kb60-expanded-1024-zh', 1024, 'light')
  const enRestored = await setLanguage('English')
  if (enRestored) language = 'English'
  record('zh/restored', 'the shell returns to English', enRestored === true)
  await dismissNotices()
  await openPanel()

  // -------------------------------------------------------------------------
  // 7. AC8 UI delete (two-step) + board restore, then AC5 cancelled row
  // -------------------------------------------------------------------------
  await fixtureHealth('before delete')
  await ensureThoughtsDrawer()
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow')`, 'thoughts drawer before delete')
  await sleep(500)
  const armed = await clickRowButton('Delete')
  await sleep(250)
  const armedLabels = (await rowsState())[0].buttons.map((button) => button.text)
  const confirmed = await app.evaluate(`(() => {
    const row = document.querySelector('.kb-drawer--thoughts .kb-thoughtRow');
    const btn = row && [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Confirm delete');
    if (!btn) return false;
    btn.click(); return true;
  })()`, { userGesture: true })
  await sleep(800)
  let afterDeleteSnap = await pageState()
  for (let attempt = 0; attempt < 16 && (afterDeleteSnap.thoughts || []).some((thought) => thought.id === fixtureId); attempt += 1) {
    await sleep(400)
    afterDeleteSnap = await pageState()
  }
  const fixtureGone = !(afterDeleteSnap.thoughts || []).some((thought) => thought.id === fixtureId)
  if (fixtureGone) deleted.add(fixtureId)
  record('delete/twoStep', 'the two-step delete control removes the queued fixture', armed === true && armedLabels.includes('Confirm delete') && confirmed === true && fixtureGone, { armed, armedLabels, confirmed, fixtureGone })

  const resumed = await pageAction('resumeBoard', {})
  pausedPinned = false
  const resumedSnap = await pageState()
  record('restore/resumed', 'the board resumes after the queued fixture work', resumed.ok === true && boardPaused(resumedSnap) === false, { status: resumed.status, boardPaused: boardPaused(resumedSnap) })
  let restoredSnap = await pageState()
  for (let attempt = 0; attempt < 20 && (restoredSnap.thoughts || []).length !== baseline.thoughtCount; attempt += 1) {
    await sleep(400)
    restoredSnap = await pageState()
  }
  record('restore/thoughtCount', 'the thought count returns to the baseline after the queued fixture is deleted', (restoredSnap.thoughts || []).length === baseline.thoughtCount, { count: (restoredSnap.thoughts || []).length, baseline: baseline.thoughtCount })

  // AC5/AC8 cancelled row: a real dispatch is cancelled immediately by the host.
  const cancelledText = 'KB-60 cancelled fixture: cancel this run immediately.'
  const cancelledSubmit = await pageAction('submitThought', { text: cancelledText })
  const cancelledThought = cancelledSubmit.value && cancelledSubmit.value.thought
  if (cancelledThought && cancelledThought.id) fixtures.push(cancelledThought.id)
  record('cancelled/submitted', 'the cancelled fixture is submitted while the board is running', cancelledSubmit.ok === true && Boolean(cancelledThought), cancelledThought && { id: cancelledThought.id, status: cancelledThought.status })
  const cancelled = cancelledThought ? await pageAction('cancelThought', { thoughtId: cancelledThought.id }) : { ok: false }
  record('cancelled/hostCancel', 'cancelThought terminates the working row', cancelled.ok === true && cancelled.value && cancelled.value.thought && cancelled.value.thought.status === 'cancelled', cancelled.status)
  if (cancelledThought) results.meta.cancelledTickets = (cancelled && cancelled.value && cancelled.value.thought && cancelled.value.thought.ticketIds) || []
  // Wait for the drawer poll to show the cancelled row (newest first).
  await ensureThoughtsDrawer()
  await waitFor(`!!document.querySelector('.kb-drawer--thoughts .kb-thoughtRow')`, 'thoughts drawer cancelled row')
  let cancelledRow = null
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const rows = await rowsState()
    if (rows && rows[0] && /Cancelled/i.test(rows[0].status)) {
      cancelledRow = rows[0]
      break
    }
    await sleep(400)
  }
  record('cancelled/row', 'the cancelled row keeps its status text and error-free shape', Boolean(cancelledRow) && cancelledRow.error === null, cancelledRow && { status: cancelledRow.status, error: cancelledRow.error })
  const cancelledButtons = cancelledRow ? cancelledRow.buttons.map((button) => button.text) : []
  record('cancelled/controls', 'the cancelled row keeps Edit and Delete and offers no Retry/Cancel', cancelledButtons.includes('Edit') && cancelledButtons.includes('Delete') && !cancelledButtons.includes('Retry') && !cancelledButtons.includes('Cancel run'), cancelledButtons)
  if (cancelledThought) {
    const cleanupCancel = await safeAction('deleteThought', { thoughtId: cancelledThought.id })
    if (cleanupCancel.ok) deleted.add(cancelledThought.id)
    await sleep(600)
  }

  // -------------------------------------------------------------------------
  // 8. AC5 queued row controls (queued fixture was the long one) + AC8 chips
  // -------------------------------------------------------------------------
  // Queued row shape is asserted from the earlier collapsed measurements.
  const queuedShape = results.measurements.collapsedAt1024
  record('queued/controls', 'the queued row kept its status label, hint and Edit/Delete controls', Boolean(queuedShape) && queuedShape.status === 'Queued' && queuedShape.hint === 'Queued — it runs when the board resumes' && queuedShape.buttons.map((b) => b.text).includes('Edit') && queuedShape.buttons.map((b) => b.text).includes('Delete'), queuedShape && { status: queuedShape.status, hint: queuedShape.hint, buttons: queuedShape.buttons.map((b) => b.text) })

  const chipRows = await rowsState()
  const chipRow = (chipRows || []).find((row) => row.chips.length > 0)
  let chipId = null
  if (chipRow) {
    chipId = chipRow.chips[0]
    await app.evaluate(`(() => {
      const row = [...document.querySelectorAll('.kb-drawer--thoughts .kb-thoughtRow')].find((r) => [...r.querySelectorAll('.kb-thoughtChip')].some((c) => (c.textContent || '').trim() === ${JSON.stringify(chipId)}));
      const chip = row && [...row.querySelectorAll('.kb-thoughtChip')].find((c) => (c.textContent || '').trim() === ${JSON.stringify(chipId)});
      if (chip) chip.click();
      return true;
    })()`, { userGesture: true })
    await sleep(700)
  }
  const ticketDrawer = await app.evaluate(`(() => {
    const drawers = [...document.querySelectorAll('.kb-drawer')].filter((d) => !d.classList.contains('kb-drawer--thoughts'));
    const drawer = drawers.find((d) => (d.getAttribute('aria-label') || '').includes(${JSON.stringify(chipId || '')}));
    const idEl = drawer && drawer.querySelector('.kb-drawerId');
    return { open: Boolean(drawer), id: idEl ? (idEl.textContent || '').trim() : null };
  })()`)
  record('chips/navigation', 'a thought ticket chip opens the matching ticket drawer', Boolean(chipRow) && ticketDrawer.open === true && ticketDrawer.id === chipId, { chipId, ticketDrawer })

  await closeOverlays()
  await closeOverlays()

  // -------------------------------------------------------------------------
  // 9. Console hygiene + final state
  // -------------------------------------------------------------------------
  const consoleErrors = (await app.errors()).filter((entry) => entry.type === 'exception' || (/error/i.test(entry.type) && /kanban|kb-/i.test(entry.text || '')))
  results.console = (await app.errors()).slice(0, 50)
  record('console/clean', 'no kanban exception or error in the console', consoleErrors.length === 0, consoleErrors.slice(0, 3))
} catch (error) {
  record('probe/uncaught', 'the probe completed without an uncaught error', false, String((error && error.stack) || error))
} finally {
  // Restore the board (thought fixtures, paused flag) and the shell (language).
  const cleanupSnap = await pageState().catch(() => null)
  for (const fixtureId of fixtures) {
    if (deleted.has(fixtureId)) continue
    const row = cleanupSnap && Array.isArray(cleanupSnap.thoughts) ? cleanupSnap.thoughts.find((entry) => entry.id === fixtureId) : null
    if (row && row.status === 'working') {
      const cancelled = await safeAction('cancelThought', { thoughtId: fixtureId })
      results.cleanup.push({ step: 'cancelThought', id: fixtureId, ok: cancelled.ok === true, status: cancelled.status })
    }
    const result = await safeAction('deleteThought', { thoughtId: fixtureId })
    results.cleanup.push({ step: 'deleteThought', id: fixtureId, ok: result.ok === true, status: result.status })
    if (result.ok) deleted.add(fixtureId)
  }
  const finalPaused = await pageState().catch(() => null)
  if (pausedPinned || boardPaused(finalPaused)) {
    const resumed = await safeAction('resumeBoard', {})
    pausedPinned = false
    results.cleanup.push({ step: 'resumeBoard', ok: resumed.ok === true, status: resumed.status })
  }
  if (language !== 'English') {
    try {
      language = (await setLanguage('English')) ? 'English' : language
    } catch {
      results.cleanup.push({ step: 'language', ok: false })
    }
  }
  await closeOverlays().catch(() => {})
  try {
    if ((await themeState()).dark === true) await setThemeMode('Light')
  } catch {
    results.cleanup.push({ step: 'theme', ok: false })
  }

  const finalSnap = await pageState().catch(() => null)
  results.cleanup.push({
    step: 'finalState',
    paused: finalSnap ? boardPaused(finalSnap) : null,
    thoughtCount: finalSnap && Array.isArray(finalSnap.thoughts) ? finalSnap.thoughts.length : null,
    baselinePaused: baseline ? baseline.paused : null,
    baselineThoughtCount: baseline ? baseline.thoughtCount : null,
  })
  record('cleanup/paused', 'the board pause flag is restored', Boolean(finalSnap) && boardPaused(finalSnap) === (baseline ? baseline.paused : false), finalSnap && { boardPaused: boardPaused(finalSnap), baseline: baseline && baseline.paused })
  record('cleanup/thoughtCount', 'the thought count is restored', Boolean(finalSnap) && Array.isArray(finalSnap.thoughts) && finalSnap.thoughts.length === (baseline ? baseline.thoughtCount : 0), finalSnap && { count: finalSnap.thoughts && finalSnap.thoughts.length, baseline: baseline && baseline.thoughtCount })

  results.meta.finishedAt = new Date().toISOString()
  results.meta.failures = failures
  results.meta.fixtureSource = 'real host mutations; failed row component-level'
  await mkdir(OUT, { recursive: true })
  await writeFile(new URL('../docs/screenshots/kb60/final-verification.json', import.meta.url), JSON.stringify(results, null, 1))
  console.log(`\n${failures === 0 ? 'ALL KB-60 PROBE CHECKS PASSED' : `${failures} PROBE FAILURE(S)`} — ${results.checks.length} checks, ${results.screenshots.length} screenshots`)
  process.exit(failures === 0 ? 0 : 1)
}
