/**
 * KB-61 verification probe — the scan drawer renders the vision excerpt and
 * candidate descriptions as Markdown.
 *
 * Live-vs-fixture decision (recorded on the ticket): the host scanner strips
 * Markdown in `excerpt()` and caps the vision at 1800 chars, so a real scan can
 * never produce formatted Markdown or a 26,000-char vision. This probe therefore
 * drives the *real* scan drawer in the real DSH Web GUI while fulfilling the
 * `scan` and `applyScan` actions with fixtures through CDP `Fetch` interception
 * (`POST /kanban/action`). No real scan runs and no host action is forwarded for
 * those two actions; every other request is untouched. The fixture injection is
 * explicitly reported in final-verification.json.
 *
 * Board discipline: the probe runs on the `default-workspace` scratch board
 * (the KB-58 convention) so a concurrent live project board cannot make the
 * pre/post equality flaky. It never calls a mutating host action: the only
 * intercepted actions are `scan` and `applyScan`, and both are fulfilled
 * synthetically. It asserts the board JSON and ticket count are byte-equal
 * before/after, then restores the previously selected workspace.
 *
 * Verifies KB-61 AC1–AC10:
 *   AC1  Markdown vision: h3–h6 only, ul>li, pre>code, a[href] target/rel, no
 *        raw `#`, leading `- `, fence or `](` in rendered text
 *   AC2  26k vision: .kb-vision scrolls vertically, drawer/body never scroll
 *        horizontally at 1024 and 640, drawer outer size equals an empty vision
 *   AC3  candidate description: strong/code/a, no raw markers, 3-line clip;
 *        title is one line with a full-title tooltip
 *   AC4  a rendered description link follows (target/rel) without toggling the
 *        row checkbox; clicking the row still toggles only that row
 *   AC5  selection/import unchanged: all selected, select-all off/on, one-row
 *        toggle, Import sends exactly the selected keys, board unchanged
 *   AC6  docs/MR/conversation rows stay plain single-line values without .kb-md
 *   AC7  empty/missing/whitespace vision, loading, error + Retry, empty messages
 *   AC8  640px: full-width drawer, no page/drawer overflow, wide table and long
 *        code scroll inside their own wrappers
 *   AC9  en + zh render the same Markdown structure with the existing md.* names
 *   AC10 clean console/page errors; markup stable across a poll refresh
 *
 * Writes docs/screenshots/kb61/final-verification.json plus the labelled PNGs.
 *
 * Usage (Chrome on CDP port 9333; the GUI URL comes from DSH_WEB_URL):
 *   node tools/kb61-probe.js
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { attach } from './cdp.mjs'

const OUT = fileURLToPath(new URL('../docs/screenshots/kb61/', import.meta.url))
const PROBE_PROJECT = 'default-workspace'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = {
  meta: {
    ticket: 'KB-61',
    startedAt: new Date().toISOString(),
    mode: 'CDP Fetch interception of POST /kanban/action (scan/applyScan) against the real scan drawer; no real scan ran',
    liveVsFixture:
      'fixture for AC1–AC4 and AC8 because the live scanner strips Markdown (excerpt) and caps the vision at 1800 chars; AC5 import is a synthetic applyScan fulfilment; board is read before/after',
  },
  checks: [],
  measurements: {},
  screenshots: [],
  console: [],
  notes: [],
  interceptedActions: [],
}
let failures = 0

function record(id, name, pass, detail) {
  results.checks.push({ id, name, pass: pass === true, detail: detail === undefined ? null : detail })
  if (pass !== true) failures += 1
  console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 320)}`}`)
}
function note(text) {
  results.notes.push(text)
  console.log('note ' + text)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAIN_VISION = [
  '# Product vision',
  '',
  'Ship **calm**, focused tools.',
  '',
  '## Outcomes',
  '',
  '- Faster setup',
  '- Clearer flow',
  '',
  '### Detail',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '| Area | Status |',
  '| --- | --- |',
  '| Scan | Ready |',
  '',
  'Read the [vision doc](https://example.com/vision) for more.',
].join('\n')

const LONG_TITLE =
  'Refine the onboarding flow for every new workspace member with a title long enough to truncate in the compact candidate row'

const MAIN_CANDIDATES = [
  {
    key: 'line:docs/VISION.md:3',
    title: LONG_TITLE,
    description: [
      'Captured from docs/VISION.md:3.',
      '',
      '**Bold claim** with `inline code` and a [safe link](https://example.com/page) on the first rendered paragraph.',
      '',
      'A second paragraph continues so the description is long enough to be clipped after three rendered lines. It keeps going to prove the wrapper clamp is real.',
    ].join('\n'),
    type: 'task',
    priority: 'medium',
    role: 'fe-developer',
    column: 'backlog',
    source: { kind: 'todo', ref: 'docs/VISION.md:3', title: 'Vision' },
  },
  {
    key: 'line:docs/VISION.md:4',
    title: 'Second candidate',
    description: 'Second candidate description with a soft\nline break.\n\nMore text.',
    type: 'story',
    priority: 'low',
    column: 'backlog',
    source: { kind: 'checkbox', ref: 'docs/VISION.md:4', title: 'Vision' },
  },
  {
    key: 'line:docs/VISION.md:5',
    title: 'Third candidate',
    description: 'Third candidate description.',
    type: 'story',
    priority: 'medium',
    column: 'backlog',
    source: { kind: 'checkbox', ref: 'docs/VISION.md:5', title: 'Vision' },
  },
]

const MAIN_DOCS = [
  { path: 'docs/VISION.md', title: 'Vision', kind: 'vision', bytes: 120 },
  { path: 'docs/PLAN.md', title: 'Delivery plan', kind: 'plan', bytes: 90 },
]
const MAIN_MRS = [
  { id: 'mr-1', number: '12', title: 'Improve the scan drawer', url: 'https://example.com/mr/12', source: 'github' },
]
const MAIN_CONVERSATIONS = [
  { sessionId: 'sess-1', title: 'Planning chat', messageCount: 6, updatedAt: Date.now() },
]

function makeScan(overrides) {
  return Object.assign(
    {
      generatedAt: Date.now(),
      vision: MAIN_VISION,
      docs: MAIN_DOCS,
      mrs: MAIN_MRS,
      conversations: MAIN_CONVERSATIONS,
      candidates: MAIN_CANDIDATES,
    },
    overrides || {},
  )
}

// 26,000+ chars with a wide table and a long code line, so the vision's own
// scroller (AC2) and the table/pre wrappers (AC8) are genuinely exercised.
function buildBigVision() {
  const parts = [
    '# Big vision',
    '',
    'Long-form product vision used to prove the drawer keeps a bounded scroller.',
    '',
    '## Wide table',
    '',
    '| Cohort identification | Activation signal | Owner assignment | Current status | Regional coverage | Notes and caveats | Review cadence | Escalation path |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| Every new workspace member in the first week | First ticket created and claimed | Frontend developer on duty | Ready for rollout | Europe and North America | Long cell content that widens the table beyond the drawer width | Weekly | Tech lead |',
    '',
    '```text',
    `const longLine = '${'segment-'.repeat(45)}end';`,
    '```',
    '',
    '## Narrative',
    '',
  ]
  let index = 0
  while (parts.join('\n').length < 26200) {
    index += 1
    parts.push(
      `Paragraph ${index}: the vision describes calm, focused workflows, safe changes, honest evidence and a board that stays readable while long-form planning happens beside it.`,
      '',
    )
  }
  const text = parts.join('\n')
  return text.length >= 26000 ? text : text + '\n'.repeat(26000 - text.length)
}

const BIG_VISION = buildBigVision()

const FIXTURES = {
  main: makeScan(),
  noVision: makeScan({ vision: null }),
  whitespaceVision: makeScan({ vision: '   \n\t  ' }),
  emptyAll: makeScan({ vision: null, docs: [], mrs: [], conversations: [], candidates: [] }),
  big: makeScan({ vision: BIG_VISION }),
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true })
const app = await attach()

let mode = 'main'
let scanDelayMs = 0
let scanRequests = 0
let lastFulfilError = null

app.cdp.on('Fetch.requestPaused', async (params) => {
  try {
    const body = params.request.postData ? JSON.parse(params.request.postData) : {}
    if (body.action !== 'scan' && body.action !== 'applyScan') {
      results.interceptedActions.push({ action: body.action, forwarded: true })
      await app.cdp.send('Fetch.continueRequest', { requestId: params.requestId })
      return
    }
    results.interceptedActions.push({
      action: body.action,
      forwarded: false,
      payload: body.action === 'applyScan' ? body.payload : undefined,
    })
    if (body.action === 'scan') {
      scanRequests += 1
      if (scanDelayMs > 0) await sleep(scanDelayMs)
      if (mode === 'error') {
        const failure = JSON.stringify({ ok: false, error: { code: 'scan/failed', message: 'Fixture scan failed on purpose' } })
        await app.cdp.send('Fetch.fulfillRequest', {
          requestId: params.requestId,
          responseCode: 500,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from(failure).toString('base64'),
        })
        return
      }
      const fixture = FIXTURES[mode] || FIXTURES.main
      const payload = JSON.stringify({ ok: true, value: { scan: fixture } })
      await app.cdp.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'application/json' }],
        body: Buffer.from(payload).toString('base64'),
      })
      return
    }
    // applyScan: synthetic success so the host creates no ticket.
    const keys = body.payload && Array.isArray(body.payload.keys) ? body.payload.keys : []
    const payload = JSON.stringify({ ok: true, value: { created: keys.length, skipped: 0, tickets: [] } })
    await app.cdp.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'application/json' }],
      body: Buffer.from(payload).toString('base64'),
    })
  } catch (error) {
    lastFulfilError = String((error && error.message) || error)
    console.log('interception error:', lastFulfilError)
    try {
      await app.cdp.send('Fetch.continueRequest', { requestId: params.requestId })
    } catch {
      // request may already be gone
    }
  }
})

async function enableInterception() {
  await app.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*kanban/action*' }] })
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
  for (let attempt = 0; attempt < 12; attempt += 1) {
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
  if (!(await hasPanel())) throw new Error('could not open the Kanban panel')
  await enableInterception()
  return true
}

const SHELL_READY =
  'document.readyState === "complete" && document.body && document.body.innerText.length > 50 && !document.body.innerText.includes("authentication required")'

async function reloadShell() {
  await app.evaluate('(() => { location.reload(); return true })()').catch(() => {})
  for (let attempt = 0; attempt < 70; attempt += 1) {
    await sleep(400)
    const ready = await app.evaluate(`(() => { try { return ${SHELL_READY} } catch (error) { return false } })()`).catch(() => false)
    if (ready) break
  }
  await sleep(900)
  await enableInterception()
}

async function shot(name) {
  await dismissAppModals()
  // Let the overlay's 120ms fade-in finish so state screenshots are opaque.
  await sleep(320)
  const path = `${OUT}${name}.png`
  await app.screenshot(path)
  results.screenshots.push(name + '.png')
  console.log('SHOT ' + name)
  return path
}

const panelTitle = () => app.evaluate('(() => { const el = document.querySelector(".kb-root .kb-title"); return el ? (el.textContent || "").trim() : null })()')
const clientProjectTitle = () => app.evaluate('(() => { const el = document.querySelector(".kb-projectName"); return el ? (el.textContent || "").trim() : null })()')
const drawerOpen = () => app.evaluate('!!document.querySelector(".kb-drawer--scan")')

async function waitFor(expression, label, timeoutMs = 12000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await app.evaluate(`(() => { try { return !!(${expression}) } catch (error) { return false } })()`).catch(() => false)
    if (value) return true
    await sleep(200)
  }
  throw new Error('timeout waiting for ' + label)
}

async function closeDrawer() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!(await drawerOpen())) return true
    await app.key('Escape')
    await sleep(350)
  }
  return !(await drawerOpen())
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

// --- theme via the real Settings control (copied from the kb58 convention) ---

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
  if (await generalTabVisible()) return true
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
  await sleep(900)
  if (await generalTabVisible()) return true
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dismissAppModals()
    await sleep(300)
    if (!(await generalTabVisible())) {
      await clickAccountMenu()
      await sleep(1000)
      await clickSettings()
      await sleep(900)
    }
    if (await generalTabVisible()) return true
    await app.key('Escape')
    await sleep(500)
  }
  return false
}

const settingsOverlayOpen = () =>
  app.evaluate(`[...document.querySelectorAll('button,[role="tab"]')].some((x) => {
    const text = (x.textContent || '').trim();
    return text === 'General' || text === '通用设置' || text === '常规' || text === 'English' || text === '中文' || text === 'Language' || text === '语言';
  })`)

async function closeSettings() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (!(await settingsOverlayOpen())) return true
    await app.key('Escape')
    await sleep(450)
  }
  return !(await settingsOverlayOpen())
}

async function setTheme(theme) {
  const target = theme === 'dark' ? 'dark' : 'light'
  const current = await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")')
  if (current === target) return true
  await closeDrawer()
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

// --- language via the real Settings control (copied from the kb58 convention) --

const languageButtonVisible = () =>
  app.evaluate('[...document.querySelectorAll("button")].some((x) => /^(English|中文)$/.test((x.textContent || "").trim()) && x.getBoundingClientRect().width > 0)')

async function setLanguage(target) {
  await closeDrawer()
  await reloadShell()
  await dismissNotices()
  await dismissAppModals()
  await openPanel()
  await sleep(700)
  const opened = await openSettings()
  if (!opened) return false
  // Always start on General so the language row is in the DOM.
  await app.evaluate(
    `(() => { const el = [...document.querySelectorAll('button,[role="tab"]')].find((x) => /^(General|通用设置|常规)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0); if (!el) return false; el.click(); return true })()`,
    { userGesture: true },
  )
  await sleep(700)
  const menuItem = `(() => {
    const el = [...document.querySelectorAll('[role="menuitem"],[role="option"],button,li')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(target)} && x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().height > 0);
    if (!el) return false;
    el.click();
    return true;
  })()`
  // If a language menu is already open (the shell keeps it open across settings
  // visits), pick the target directly; otherwise open the trigger first.
  let picked = await app.evaluate(menuItem, { userGesture: true })
  if (!picked) {
    await app.evaluate(
      `(() => {
        const el = [...document.querySelectorAll('button')].find((x) => !x.closest('[role="menu"],[role="listbox"]') && /^(English|中文|日本語)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
        if (!el) return false;
        el.click();
        return true;
      })()`,
      { userGesture: true },
    )
    await sleep(700)
    picked = await app.evaluate(menuItem, { userGesture: true })
  }
  await sleep(1400)
  await closeSettings()
  await dismissAppModals()
  await sleep(400)
  const expected = target === '中文' ? '看板' : 'Kanban'
  let changed = false
  try {
    await waitFor(
      `(() => { const el = document.querySelector('.kb-root .kb-title'); return el && (el.textContent || '').trim() === ${JSON.stringify(expected)} })()`,
      'language ' + target,
      8000,
    )
    changed = true
  } catch {
    changed = false
  }
  return picked === true && changed
}

// ---------------------------------------------------------------------------
// State + drawer introspection
// ---------------------------------------------------------------------------

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

const bootState = () =>
  app.evaluate(`(async () => {
    const response = await fetch('/kanban/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const payload = await response.json();
    return payload.ok ? payload.value : { error: payload.error, status: response.status };
  })()`)

async function clickScan() {
  const clicked = await app.evaluate(
    `(() => {
      const btn = [...document.querySelectorAll('.kb-root button')].find((b) => {
        if (b.getBoundingClientRect().width === 0) return false;
        const title = (b.getAttribute('title') || '').trim();
        return /^(Scan|扫描)$/.test(title);
      });
      if (!btn) return false;
      btn.click();
      return true;
    })()`,
    { userGesture: true },
  )
  if (!clicked) throw new Error('scan button not found')
}

async function runScan(scanMode, delay = 0) {
  mode = scanMode
  scanDelayMs = delay
  await closeDrawer()
  const before = scanRequests
  await clickScan()
  await waitFor('document.querySelector(".kb-drawer--scan")', 'scan drawer')
  return { before }
}

const waitForData = () => waitFor('document.querySelector(".kb-candidate") || document.querySelector(".kb-emptyLine")', 'scan data')

const MAIN_STATE = `(() => {
  const drawer = document.querySelector('.kb-drawer--scan');
  if (!drawer) return null;
  const vision = drawer.querySelector('.kb-vision');
  const md = vision ? vision.querySelector('.kb-md') : null;
  const tagCounts = {};
  if (md) ['h1','h2','h3','h4','h5','h6','ul','ol','li','pre','code','p','strong','em','blockquote','table','a','input'].forEach((name) => {
    tagCounts[name] = md.querySelectorAll(name).length;
  });
  const candidates = [...drawer.querySelectorAll('.kb-candidate')];
  const selectAll = drawer.querySelector('.kb-section .kb-iconMeta input[type=checkbox]');
  const importBtn = [...drawer.querySelectorAll('.kb-scanFoot button')].find((b) => /Import|导入/.test(b.textContent || ''));
  const footer = drawer.querySelector('.kb-scanFootText');
  const rows = candidates.map((row) => {
    const input = row.querySelector('input[type=checkbox]');
    const title = row.querySelector('.kb-candidateTitle');
    const desc = row.querySelector('.kb-candidateDesc');
    const descMd = desc ? desc.querySelector('.kb-md') : null;
    const titleStyle = title ? getComputedStyle(title) : null;
    const descStyle = desc ? getComputedStyle(desc) : null;
    return {
      checked: input ? input.checked : null,
      checkboxLabel: input ? input.getAttribute('aria-label') : null,
      title: title ? title.textContent : null,
      titleAttr: title ? title.getAttribute('title') : null,
      titleHeight: title ? title.getBoundingClientRect().height : null,
      titleLineHeight: titleStyle ? parseFloat(titleStyle.lineHeight) : null,
      titleWhiteSpace: titleStyle ? titleStyle.whiteSpace : null,
      titleOverflow: titleStyle ? titleStyle.textOverflow : null,
      descHeight: desc ? desc.getBoundingClientRect().height : null,
      descLineHeight: descStyle ? parseFloat(descStyle.lineHeight) : null,
      descOverflow: descStyle ? descStyle.overflow : null,
      descMaxHeight: descStyle ? descStyle.maxHeight : null,
      descScrollHeight: desc ? desc.scrollHeight : null,
      descClientHeight: desc ? desc.clientHeight : null,
      descText: desc ? desc.innerText : null,
      hasMd: !!descMd,
      strong: descMd ? descMd.querySelectorAll('strong').length : 0,
      code: descMd ? descMd.querySelectorAll('code').length : 0,
      anchors: descMd ? [...descMd.querySelectorAll('a[href]')].map((a) => ({ href: a.href, target: a.target, rel: a.rel })) : [],
    };
  });
  const docs = [...drawer.querySelectorAll('.kb-docRow')].map((row) => {
    const path = row.querySelector('.kb-docPath');
    const style = path ? getComputedStyle(path) : null;
    return {
      title: row.querySelector('.kb-docTitle') ? row.querySelector('.kb-docTitle').textContent : null,
      path: path ? path.textContent : null,
      pathWhiteSpace: style ? style.whiteSpace : null,
      pathOverflow: style ? style.overflow : null,
      pathTextOverflow: style ? style.textOverflow : null,
      hasMd: !!row.querySelector('.kb-md'),
    };
  });
  const mrs = [...drawer.querySelectorAll('.kb-mrRow')].map((row) => {
    const title = row.querySelector('.kb-mrTitle');
    const link = row.querySelector('a.kb-link');
    return {
      chip: row.querySelector('.kb-chip') ? row.querySelector('.kb-chip').textContent : null,
      title: title ? title.textContent : null,
      titleWhiteSpace: title ? getComputedStyle(title).whiteSpace : null,
      link: link ? { href: link.href, target: link.target, rel: link.rel } : null,
      hasMd: !!row.querySelector('.kb-md'),
    };
  });
  const conversations = [...drawer.querySelectorAll('.kb-convRow')].map((row) => ({
    dot: !!row.querySelector('.kb-dot'),
    title: row.querySelector('.kb-convTitle') ? row.querySelector('.kb-convTitle').textContent : null,
    subs: [...row.querySelectorAll('.kb-convSub')].map((el) => el.textContent),
    hasMd: !!row.querySelector('.kb-md'),
  }));
  return {
    drawerTitle: (drawer.getAttribute('aria-label') || '') + '|' + ((drawer.querySelector('.kb-dialogTitle') || {}).textContent || ''),
    sectionTitles: [...drawer.querySelectorAll('.kb-sectionTitle')].map((el) => (el.textContent || '').trim()),
    vision: {
      exists: !!vision,
      hasMd: !!md,
      tagCounts,
      headingTags: md ? [...md.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((el) => el.tagName.toLowerCase()) : [],
      ulLi: md ? md.querySelectorAll('ul > li').length : 0,
      preCode: md ? md.querySelectorAll('pre > code').length : 0,
      anchors: md ? [...md.querySelectorAll('a[href]')].map((a) => ({ href: a.href, target: a.target, rel: a.rel, ariaLabel: a.getAttribute('aria-label') })) : [],
      text: md ? md.innerText : '',
      html: md ? md.outerHTML : null,
      preLabel: md && md.querySelector('pre') ? md.querySelector('pre').getAttribute('aria-label') : null,
      tableLabel: md && md.querySelector('.kb-md-tableWrap') ? md.querySelector('.kb-md-tableWrap').getAttribute('aria-label') : null,
      regionLabel: vision ? vision.getAttribute('aria-label') : null,
      regionTabIndex: vision ? vision.tabIndex : null,
    },
    rows,
    docs,
    mrs,
    conversations,
    selectAllChecked: selectAll ? selectAll.checked : null,
    importDisabled: importBtn ? importBtn.disabled === true : null,
    importText: importBtn ? (importBtn.textContent || '').trim() : null,
    footer: footer ? (footer.textContent || '').trim() : null,
    candidateCount: candidates.length,
    bodyText: drawer.innerText,
  };
})()`

const MEASURE = `(() => {
  const drawer = document.querySelector('.kb-drawer--scan');
  if (!drawer) return null;
  const overlay = drawer.parentElement;
  const body = drawer.querySelector('.kb-drawerBody');
  const vision = drawer.querySelector('.kb-vision');
  const md = vision ? vision.querySelector('.kb-md') : null;
  const tableWrap = md ? md.querySelector('.kb-md-tableWrap') : null;
  const pre = md ? md.querySelector('pre') : null;
  const rect = drawer.getBoundingClientRect();
  const doc = document.documentElement;
  const css = vision ? getComputedStyle(vision) : null;
  return {
    drawer: { width: rect.width, height: rect.height, scrollWidth: drawer.scrollWidth, clientWidth: drawer.clientWidth },
    overlay: overlay ? { width: overlay.clientWidth, height: overlay.clientHeight } : null,
    body: body ? { scrollWidth: body.scrollWidth, clientWidth: body.clientWidth, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } : null,
    vision: vision ? {
      scrollHeight: vision.scrollHeight,
      clientHeight: vision.clientHeight,
      scrollWidth: vision.scrollWidth,
      clientWidth: vision.clientWidth,
      maxHeight: css.maxHeight,
      overflowY: css.overflowY,
      scrollTop: vision.scrollTop,
    } : null,
    tableWrap: tableWrap ? { scrollWidth: tableWrap.scrollWidth, clientWidth: tableWrap.clientWidth, overflowX: getComputedStyle(tableWrap).overflowX } : null,
    pre: pre ? { scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth, overflowX: getComputedStyle(pre).overflowX } : null,
    doc: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth },
    hasMd: !!md,
    colors: vision ? {
      visionBackground: css.backgroundColor,
      mdColor: md ? getComputedStyle(md).color : null,
      drawerBackground: getComputedStyle(drawer).backgroundColor,
    } : null,
  };
})()`

async function measure() {
  return app.evaluate(MEASURE)
}
async function state() {
  return app.evaluate(MAIN_STATE)
}

async function waitForDataReady() {
  await waitFor('document.querySelector(".kb-candidate") && document.querySelector(".kb-vision .kb-md")', 'scan data with Markdown')
  await sleep(450)
}

// ---------------------------------------------------------------------------
// 0. Boot, scratch board, clean collectors
// ---------------------------------------------------------------------------

await app.ensureApp({ reload: true })
await setViewport(1024, 768)
await dismissNotices()
await dismissAppModals()
await openPanel()

// Page-error collector that survives reloads.
const pageCollector = `(() => {
  if (window.__kb61Errors) return;
  window.__kb61Errors = [];
  window.addEventListener('error', (event) => window.__kb61Errors.push('error: ' + String((event && event.message) || (event && event.error) || 'error')));
  window.addEventListener('unhandledrejection', (event) => window.__kb61Errors.push('rejection: ' + String((event.reason && event.reason.message) || event.reason || 'rejection')));
  const original = console.error;
  console.error = function () { window.__kb61Errors.push('console.error: ' + [...arguments].map(String).join(' ')); return original.apply(console, arguments); };
})();`
await app.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: pageCollector })
await app.evaluate(pageCollector)

const boot = await bootState()
results.meta.originalWorkspaceId = boot.workspaceId
results.meta.originalProject = boot.project && boot.project.title
const scratch = (boot.projects || []).find((project) => project.title === PROBE_PROJECT)
if (!scratch) {
  record('setup/scratchProject', `the ${PROBE_PROJECT} scratch board is registered`, false, 'missing')
  await writeFile(`${OUT}final-verification.json`, JSON.stringify({ ...results, meta: { ...results.meta, failures: failures + 1 } }, null, 1))
  process.exit(1)
}
workspaceId = scratch.id
results.meta.probeWorkspaceId = workspaceId
results.meta.probeProject = PROBE_PROJECT
await app.evaluate(`(() => { window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(workspaceId)}); return true })()`)
await reloadShell()
await openPanel()
await sleep(700)
let clientTitle = await clientProjectTitle()
if (clientTitle !== PROBE_PROJECT) {
  note('client opened ' + String(clientTitle) + ' instead of ' + PROBE_PROJECT + '; selecting it explicitly')
  await selectProject(PROBE_PROJECT)
  clientTitle = await clientProjectTitle()
}
record('setup/clientSelected', 'the client panel renders the scratch board', clientTitle === PROBE_PROJECT, clientTitle)

await setLanguage('English')
record('setup/english', 'the panel is in English before the fixture pass', (await panelTitle()) === 'Kanban', await panelTitle())
const light = await setTheme('light')
record('setup/light', 'the panel starts in the light theme', light === true, await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")'))

const preState = await pageState()
const preBoard = preState && preState.board ? preState.board : null
const preTickets = preBoard && Array.isArray(preBoard.tickets) ? preBoard.tickets.length : -1
results.meta.preTickets = preTickets
results.meta.preBoardPaused = preBoard && preBoard.paused
record('setup/board', 'the scratch board state was read before any fixture', Boolean(preBoard) && preTickets >= 0, { tickets: preTickets })
const consoleBaseline = app.console.length

// ---------------------------------------------------------------------------
// 1. Loading state (AC7) and the main Markdown fixture (AC1, AC3, AC6)
// ---------------------------------------------------------------------------

await runScan('main', 1200)
await waitFor('document.querySelector(".kb-drawer--scan .kb-centerLoading")', 'scan loading state')
const loading = await app.evaluate(`(() => {
  const box = document.querySelector('.kb-drawer--scan .kb-centerLoading');
  return box ? { text: (box.innerText || '').trim(), spinner: !!box.querySelector('.kb-spinner') } : null;
})()`)
record('AC7/loading', 'loading shows a spinner plus the localized running label', Boolean(loading) && loading.spinner === true && loading.text === 'Scanning project…', loading)
await shot('scan-drawer-loading-1024-light')
await waitForDataReady()

const main = await state()
const light1024 = await measure()
results.measurements.mainEn = {
  visionTags: main.vision.tagCounts,
  candidateCount: main.candidateCount,
  drawerTitle: main.drawerTitle,
  sectionTitles: main.sectionTitles,
  colors: light1024 && light1024.colors,
}
const visionText = main.vision.text
record('AC1/markdown', '.kb-vision contains a .kb-md subtree', main.vision.exists === true && main.vision.hasMd === true, { exists: main.vision.exists, hasMd: main.vision.hasMd })
record(
  'AC1/headings',
  'headings are clamped to h3–h6 and never h1/h2',
  main.vision.headingTags.length >= 3 && main.vision.headingTags.every((tag) => ['h3', 'h4', 'h5', 'h6'].includes(tag)),
  main.vision.headingTags,
)
record('AC1/list', 'the unordered list renders as ul > li', main.vision.ulLi >= 2, main.vision.ulLi)
record('AC1/code', 'the fenced block renders as pre > code', main.vision.preCode >= 1, main.vision.preCode)
record(
  'AC1/link',
  'the inline link is an a[href] with target/rel from the engine',
  main.vision.anchors.length >= 1 &&
    main.vision.anchors.every((anchor) => anchor.target === '_blank' && /noopener/.test(anchor.rel) && /noreferrer/.test(anchor.rel)),
  main.vision.anchors,
)
record(
  'AC1/noMarkers',
  'the rendered vision text contains no literal #, leading "- ", fence or "](" markers',
  !/#/.test(visionText) && !/^\s*-\s/m.test(visionText) && visionText.indexOf('```') === -1 && visionText.indexOf('](') === -1,
  visionText.slice(0, 220),
)
record(
  'AC1/region',
  'the vision scroller is a labelled, keyboard-reachable region',
  main.vision.regionLabel === 'Product vision' && main.vision.regionTabIndex === 0,
  { label: main.vision.regionLabel, tabIndex: main.vision.regionTabIndex },
)

const row = main.rows[0]
record('AC3/markdown', 'the candidate description renders strong, code and a[href]', row.hasMd === true && row.strong >= 1 && row.code >= 1 && row.anchors.length >= 1, { strong: row.strong, code: row.code, anchors: row.anchors })
record(
  'AC3/linkEngine',
  'the description anchor carries the engine target/rel',
  row.anchors.length >= 1 && row.anchors.every((anchor) => anchor.target === '_blank' && /noopener/.test(anchor.rel) && /noreferrer/.test(anchor.rel)),
  row.anchors,
)
record(
  'AC3/noMarkers',
  'the description text shows no raw **, backtick or ]( markers',
  typeof row.descText === 'string' && row.descText.indexOf('**') === -1 && row.descText.indexOf('`') === -1 && row.descText.indexOf('](') === -1,
  row.descText,
)
record(
  'AC3/clamp',
  'the description is clipped to at most three computed line-heights',
  row.descHeight <= row.descLineHeight * 3 + 0.6 && row.descOverflow === 'hidden' && row.descScrollHeight > row.descClientHeight,
  { height: row.descHeight, lineHeight: row.descLineHeight, overflow: row.descOverflow, scrollHeight: row.descScrollHeight, clientHeight: row.descClientHeight, maxHeight: row.descMaxHeight },
)
record(
  'AC3/title',
  'the candidate title is one line with the full untruncated title in title',
  row.titleHeight <= row.titleLineHeight * 1.5 + 0.6 && row.titleAttr === LONG_TITLE && row.titleWhiteSpace === 'nowrap' && row.titleOverflow === 'ellipsis',
  { height: row.titleHeight, lineHeight: row.titleLineHeight, attr: row.titleAttr, title: row.title },
)

record('AC6/docs', 'doc rows keep a title plus a single-line ellipsised path and no .kb-md', main.docs.length === 2 && main.docs.every((doc) => doc.title && doc.path && doc.pathWhiteSpace === 'nowrap' && doc.pathOverflow === 'hidden' && doc.pathTextOverflow === 'ellipsis' && doc.hasMd === false), main.docs)
record(
  'AC6/mrs',
  'MR rows keep their chip, single-line title and the .kb-link target/rel',
  main.mrs.length === 1 &&
    main.mrs[0].chip === '#12' &&
    main.mrs[0].titleWhiteSpace === 'nowrap' &&
    main.mrs[0].link &&
    main.mrs[0].link.target === '_blank' &&
    main.mrs[0].link.rel === 'noopener noreferrer' &&
    main.mrs[0].hasMd === false,
  main.mrs,
)
record(
  'AC6/conversations',
  'conversation rows keep dot/title/subs and no .kb-md',
  main.conversations.length === 1 && main.conversations[0].dot === true && main.conversations[0].title === 'Planning chat' && main.conversations[0].subs.length === 2 && main.conversations[0].hasMd === false,
  main.conversations,
)

await shot('scan-drawer-1024-light')
await app.evaluate(`(() => { const row = document.querySelectorAll('.kb-candidate')[0]; if (row) row.scrollIntoView({ block: 'center' }); return true })()`)
await sleep(500)
await shot('candidate-clamp-link-1024-light')

// AC10: markup is stable across a poll refresh (2.5s poll; wait past one).
const htmlBefore = main.vision.html
await sleep(2900)
const htmlAfter = await app.evaluate(`(() => { const md = document.querySelector('.kb-vision .kb-md'); return md ? md.outerHTML : null })()`)
record('AC10/stableMarkup', 'a poll refresh with unchanged vision leaves the .kb-md markup unchanged', Boolean(htmlBefore) && htmlBefore === htmlAfter, { bytes: htmlBefore ? htmlBefore.length : 0, same: htmlBefore === htmlAfter })

// ---------------------------------------------------------------------------
// 2. AC4 — description link does not toggle the row; row click toggles only it
// ---------------------------------------------------------------------------

const linkHit = await app.evaluate(`(() => {
  const anchor = document.querySelectorAll('.kb-candidate')[0].querySelector('.kb-candidateDesc a[href]');
  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return {
    insideAnchor: !!(hit && hit.closest && hit.closest('a[href]')),
    href: anchor.href,
    target: anchor.target,
    rel: anchor.rel,
    rect: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height },
  };
})()`)
if (linkHit && linkHit.insideAnchor) {
  // Track browsing contexts so the click proves it really follows the link
  // (target=_blank opens a real tab); the fixture page is closed afterwards.
  const existing = (await app.cdp.send('Target.getTargets')).targetInfos.map((target) => target.targetId)
  const existingIds = new Set(existing)
  let openedTarget = null
  const onTarget = (params) => {
    const info = params.targetInfo
    if (!info || info.type !== 'page') return
    if (existingIds.has(info.targetId)) return
    if (info.url.indexOf('https://example.com/page') !== 0) return
    openedTarget = { targetId: info.targetId, url: info.url }
  }
  app.cdp.on('Target.targetCreated', onTarget)
  app.cdp.on('Target.targetInfoChanged', onTarget)
  await app.cdp.send('Target.setDiscoverTargets', { discover: true })
  const beforeChecked = await app.evaluate(`(() => [...document.querySelectorAll('.kb-candidate input[type=checkbox]')].map((el) => el.checked))()`)
  await app.mouse('mousePressed', Math.round(linkHit.rect.x), Math.round(linkHit.rect.y))
  await app.mouse('mouseReleased', Math.round(linkHit.rect.x), Math.round(linkHit.rect.y))
  for (let attempt = 0; attempt < 20 && !openedTarget; attempt += 1) await sleep(200)
  const afterChecked = await app.evaluate(`(() => [...document.querySelectorAll('.kb-candidate input[type=checkbox]')].map((el) => el.checked))()`)
  record(
    'AC4/link',
    'clicking a rendered description link follows it (target=_blank) and leaves the row checkbox unchanged',
    Boolean(openedTarget) &&
      linkHit.href === 'https://example.com/page' &&
      linkHit.target === '_blank' &&
      /noopener/.test(linkHit.rel) &&
      /noreferrer/.test(linkHit.rel) &&
      JSON.stringify(beforeChecked) === JSON.stringify(afterChecked),
    { openedTarget, link: { href: linkHit.href, target: linkHit.target, rel: linkHit.rel }, beforeChecked, afterChecked },
  )
  if (openedTarget) {
    await app.cdp.send('Target.closeTarget', { targetId: openedTarget.targetId }, 5000).catch(() => {})
  }
} else {
  record('AC4/link', 'clicking a rendered description link follows it (target=_blank) and leaves the row checkbox unchanged', false, { linkHit })
}

// Click row 0's title (non-link area) with a real pointer: only that row flips.
const titleRect = await app.evaluate(`(() => { const el = document.querySelectorAll('.kb-candidate')[0].querySelector('.kb-candidateTitle'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
const beforeRowClick = await app.evaluate(`(() => [...document.querySelectorAll('.kb-candidate input[type=checkbox]')].map((el) => el.checked))()`)
await app.mouse('mousePressed', Math.round(titleRect.x), Math.round(titleRect.y))
await app.mouse('mouseReleased', Math.round(titleRect.x), Math.round(titleRect.y))
await sleep(400)
const afterRowClick = await app.evaluate(`(() => [...document.querySelectorAll('.kb-candidate input[type=checkbox]')].map((el) => el.checked))()`)
record(
  'AC4/row',
  'clicking the row non-link area toggles that row only',
  beforeRowClick.length === 3 && afterRowClick.length === 3 && beforeRowClick[0] !== afterRowClick[0] && beforeRowClick[1] === afterRowClick[1] && beforeRowClick[2] === afterRowClick[2],
  { beforeRowClick, afterRowClick },
)

// ---------------------------------------------------------------------------
// 3. AC5 — selection and import semantics unchanged
// ---------------------------------------------------------------------------

// The "opens with all selected" state is the `main` snapshot captured right
// after the fixture drawer opened, before the AC4 pointer clicks toggled rows.
record(
  'AC5/initial',
  'the drawer opens with all candidates selected and Import enabled',
  main.candidateCount === 3 && main.rows.every((item) => item.checked === true) && main.selectAllChecked === true && main.importDisabled === false,
  { count: main.candidateCount, checked: main.rows.map((item) => item.checked), selectAll: main.selectAllChecked, importDisabled: main.importDisabled, footer: main.footer },
)
// The AC4 pointer clicks above may have left a mixed selection; normalise to
// all-selected through the real select-all control so the sequence below starts
// from the same state a freshly opened drawer has.
const beforeAc5 = await state()
if (beforeAc5.selectAllChecked !== true) {
  await app.evaluate(`(() => { const input = document.querySelector('.kb-section .kb-iconMeta input[type=checkbox]'); input.click(); return true })()`)
  await sleep(350)
}
await app.evaluate(`(() => { const input = document.querySelector('.kb-section .kb-iconMeta input[type=checkbox]'); input.click(); return true })()`)
await sleep(350)
const noneSelected = await state()
record(
  'AC5/selectAllOff',
  'unchecking select-all leaves 0 selected and Import disabled',
  noneSelected.rows.every((item) => item.checked === false) && noneSelected.selectAllChecked === false && noneSelected.importDisabled === true && /0 selected/.test(noneSelected.footer),
  { checked: noneSelected.rows.map((item) => item.checked), selectAll: noneSelected.selectAllChecked, importDisabled: noneSelected.importDisabled, footer: noneSelected.footer },
)
await app.evaluate(`(() => { const input = document.querySelector('.kb-section .kb-iconMeta input[type=checkbox]'); input.click(); return true })()`)
await sleep(350)
const allAgain = await state()
record(
  'AC5/selectAllOn',
  'reselecting all restores N selected and Import enabled',
  allAgain.rows.every((item) => item.checked === true) && allAgain.selectAllChecked === true && allAgain.importDisabled === false && /3 selected/.test(allAgain.footer),
  { checked: allAgain.rows.map((item) => item.checked), footer: allAgain.footer },
)
// One-row toggle through the row label (the checkbox input itself also works).
const secondTitleRect = await app.evaluate(`(() => { const el = document.querySelectorAll('.kb-candidate')[1].querySelector('.kb-candidateTitle'); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
await app.mouse('mousePressed', Math.round(secondTitleRect.x), Math.round(secondTitleRect.y))
await app.mouse('mouseReleased', Math.round(secondTitleRect.x), Math.round(secondTitleRect.y))
await sleep(350)
const oneToggled = await state()
record(
  'AC5/oneRow',
  'toggling one row changes only that row and the footer count',
  oneToggled.rows[0].checked === true && oneToggled.rows[1].checked === false && oneToggled.rows[2].checked === true && /2 selected/.test(oneToggled.footer),
  { checked: oneToggled.rows.map((item) => item.checked), footer: oneToggled.footer },
)
const expectedKeys = [MAIN_CANDIDATES[0].key, MAIN_CANDIDATES[2].key]
await app.evaluate(`(() => { const btn = [...document.querySelectorAll('.kb-scanFoot button')].find((b) => /Import|导入/.test(b.textContent || '')); if (!btn) return false; btn.click(); return true })()`, { userGesture: true })
await waitFor('!document.querySelector(".kb-drawer--scan")', 'drawer closes after import', 10000)
await sleep(700)
const importRequest = results.interceptedActions.filter((entry) => entry.action === 'applyScan' && entry.forwarded === false).pop()
results.measurements.applyScanPayload = importRequest ? importRequest.payload : null
record(
  'AC5/importPayload',
  'Import sends applyScan with exactly the selected candidate keys',
  Boolean(importRequest && importRequest.payload && Array.isArray(importRequest.payload.keys)) && JSON.stringify(importRequest.payload.keys) === JSON.stringify(expectedKeys),
  importRequest ? importRequest.payload : null,
)
const postState = await pageState()
const postBoard = postState && postState.board ? postState.board : null
const postTickets = postBoard && Array.isArray(postBoard.tickets) ? postBoard.tickets.length : -1
results.measurements.board = {
  preTickets,
  postTickets,
  sameBoard: JSON.stringify(preBoard) === JSON.stringify(postBoard),
  intercepted: results.interceptedActions.map((entry) => entry.action),
}
record(
  'AC5/boardUnchanged',
  'no probe action creates, edits or deletes a real ticket or board row',
  JSON.stringify(preBoard) === JSON.stringify(postBoard) && preTickets === postTickets && results.interceptedActions.every((entry) => entry.action === 'scan' || entry.action === 'applyScan'),
  results.measurements.board,
)
// Let the import toast auto-dismiss so the error/empty screenshots are clean.
await sleep(4300)

// ---------------------------------------------------------------------------
// 4. AC7 — error + Retry, empty messages, missing and whitespace vision
// ---------------------------------------------------------------------------

await runScan('error', 0)
await waitFor('document.querySelector(".kb-drawer--scan .kb-errorText")', 'scan error state')
const errorState = await app.evaluate(`(() => {
  const drawer = document.querySelector('.kb-drawer--scan');
  if (!drawer) return null;
  const text = drawer.querySelector('.kb-errorText');
  const retry = [...drawer.querySelectorAll('button')].find((b) => /Retry|重试/.test(b.textContent || ''));
  return { message: text ? (text.innerText || '').trim() : null, retry: retry ? (retry.textContent || '').trim() : null };
})()`)
record('AC7/error', 'an error shows the message plus Retry', Boolean(errorState) && /Fixture scan failed on purpose/.test(errorState.message || '') && errorState.retry === 'Retry scan', errorState)
await shot('scan-drawer-error-1024-light')
const retryBefore = scanRequests
mode = 'main'
await app.evaluate(`(() => { const btn = [...document.querySelectorAll('.kb-drawer--scan button')].find((b) => /Retry|重试/.test(b.textContent || '')); if (!btn) return false; btn.click(); return true })()`, { userGesture: true })
await waitFor('document.querySelector(".kb-candidate")', 'retry re-runs the scan')
await sleep(400)
record('AC7/retry', 'Retry re-runs the scan and the drawer shows the fixture data', scanRequests > retryBefore && (await drawerOpen()) === true, { before: retryBefore, after: scanRequests })
await closeDrawer()
// Let the forcing error toast auto-dismiss before the empty-state screenshot.
await sleep(4300)

await runScan('emptyAll', 0)
await waitForData()
await sleep(350)
const emptyAll = await app.evaluate(`(() => {
  const drawer = document.querySelector('.kb-drawer--scan');
  return {
    text: drawer ? drawer.innerText : '',
    vision: !!document.querySelector('.kb-drawer--scan .kb-vision'),
    md: !!document.querySelector('.kb-drawer--scan .kb-vision .kb-md'),
    importDisabled: (() => { const b = [...document.querySelectorAll('.kb-scanFoot button')].find((x) => /Import|导入/.test(x.textContent || '')); return b ? b.disabled : null })(),
  };
})()`)
record(
  'AC7/emptyVision',
  'a missing vision omits the vision section entirely (no .kb-vision / .kb-md)',
  emptyAll.vision === false && emptyAll.md === false,
  emptyAll,
)
record(
  'AC7/emptyMessages',
  'empty docs/MRs/conversations/candidates messages are unchanged',
  /No docs found/.test(emptyAll.text) && /No open merge requests/.test(emptyAll.text) && /No recent conversations/.test(emptyAll.text) && /No candidate tickets found/.test(emptyAll.text) && emptyAll.importDisabled === true,
  { importDisabled: emptyAll.importDisabled },
)
await shot('scan-drawer-empty-1024-light')
await closeDrawer()

await runScan('noVision', 0)
await waitFor('document.querySelector(".kb-candidate")', 'no-vision fixture data')
await sleep(350)
const noVisionMeasure = await measure()
const noVisionBodyScrollHeight = noVisionMeasure ? noVisionMeasure.body.scrollHeight : null
const noVisionMissing = await app.evaluate(`(() => ({ vision: !!document.querySelector('.kb-drawer--scan .kb-vision'), md: !!document.querySelector('.kb-drawer--scan .kb-vision .kb-md') }))()`)
record('AC2/baseline1024', 'an empty vision at 1024 renders no Markdown and records the drawer size', noVisionMissing.vision === false && noVisionMissing.md === false && Boolean(noVisionMeasure), noVisionMeasure)
await closeDrawer()

await runScan('whitespaceVision', 0)
await waitFor('document.querySelector(".kb-candidate")', 'whitespace-vision fixture data')
await sleep(350)
const whitespace = await app.evaluate(`(() => {
  const drawer = document.querySelector('.kb-drawer--scan');
  return { vision: !!drawer.querySelector('.kb-vision'), md: !!drawer.querySelector('.kb-vision .kb-md'), bodyScrollHeight: drawer.querySelector('.kb-drawerBody').scrollHeight };
})()`)
record(
  'AC7/whitespaceVision',
  'a whitespace-only vision renders no .kb-md and adds no content height',
  whitespace.vision === false && whitespace.md === false && whitespace.bodyScrollHeight === noVisionBodyScrollHeight,
  { whitespace, noVisionBodyScrollHeight },
)
await closeDrawer()

// ---------------------------------------------------------------------------
// 5. AC2 — 26k vision containment at 1024 and 640
// ---------------------------------------------------------------------------

await runScan('big', 0)
await waitFor('document.querySelector(".kb-vision .kb-md")', 'big vision')
await sleep(450)
const big1024 = await measure()
results.measurements.big1024 = big1024
record(
  'AC2/contain1024',
  'the 26k vision keeps max-height/overflow-y and scrolls at 1024 without drawer/body horizontal overflow',
  Boolean(big1024) &&
    big1024.vision.scrollHeight > big1024.vision.clientHeight &&
    big1024.vision.overflowY === 'auto' &&
    big1024.drawer.scrollWidth <= big1024.drawer.clientWidth + 1 &&
    big1024.body.scrollWidth <= big1024.body.clientWidth + 1 &&
    big1024.doc.scrollWidth <= big1024.doc.clientWidth,
  big1024 && { vision: { scrollHeight: big1024.vision.scrollHeight, clientHeight: big1024.vision.clientHeight, maxHeight: big1024.vision.maxHeight, overflowY: big1024.vision.overflowY }, drawer: big1024.drawer, body: big1024.body, doc: big1024.doc },
)
record(
  'AC2/sizeUnchanged1024',
  'the drawer outer width/height is unchanged versus an empty-vision fixture at 1024',
  Boolean(big1024 && noVisionMeasure) && Math.abs(big1024.drawer.width - noVisionMeasure.drawer.width) < 0.6 && Math.abs(big1024.drawer.height - noVisionMeasure.drawer.height) < 0.6,
  { big: big1024 && big1024.drawer, empty: noVisionMeasure && noVisionMeasure.drawer },
)
await app.evaluate(`(() => { const vision = document.querySelector('.kb-vision'); vision.scrollTop = Math.round((vision.scrollHeight - vision.clientHeight) * 0.55); return vision.scrollTop })()`)
await sleep(450)
await shot('vision-26k-scrolled-1024-light')
await closeDrawer()

// ---------------------------------------------------------------------------
// 6. Dark theme (genuine dark paint through the shell)
// ---------------------------------------------------------------------------

const dark = await setTheme('dark')
record('setup/dark', 'the shell applies the dark theme', dark === true, await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")'))
await runScan('main', 0)
await waitForDataReady()
const darkMeasure = await measure()
results.measurements.dark = darkMeasure && darkMeasure.colors
await shot('scan-drawer-1024-dark')
record(
  'AC-theme/dark',
  'the dark screenshot is painted with a different token background than the light one',
  Boolean(darkMeasure && darkMeasure.colors && light1024 && light1024.colors) &&
    darkMeasure.colors.visionBackground !== light1024.colors.visionBackground &&
    darkMeasure.colors.drawerBackground !== light1024.colors.drawerBackground,
  { dark: darkMeasure && darkMeasure.colors, light: light1024 && light1024.colors },
)
await closeDrawer()
await setTheme('light')

// ---------------------------------------------------------------------------
// 7. AC9 — zh renders the same structure with the existing md.* labels
// ---------------------------------------------------------------------------

const zh = await setLanguage('中文')
record('setup/zh', 'the shell switches to Simplified Chinese', zh === true && (await panelTitle()) === '看板', await panelTitle())
if (zh === true) {
  await runScan('main', 0)
  await waitForDataReady()
  const zhState = await state()
  results.measurements.zh = {
    drawerTitle: zhState.drawerTitle,
    sectionTitles: zhState.sectionTitles,
    visionTags: zhState.vision.tagCounts,
    preLabel: zhState.vision.preLabel,
    tableLabel: zhState.vision.tableLabel,
    anchorLabel: zhState.vision.anchors[0] ? zhState.vision.anchors[0].ariaLabel : null,
  }
  const enTags = main.vision.tagCounts
  const sameTags = Object.keys(enTags).every((key) => (zhState.vision.tagCounts[key] || 0) === enTags[key])
  record(
    'AC9/structure',
    'the zh drawer renders the same Markdown structure as en',
    sameTags && zhState.vision.headingTags.every((tag) => ['h3', 'h4', 'h5', 'h6'].includes(tag)) && zhState.vision.ulLi === main.vision.ulLi && zhState.vision.preCode === main.vision.preCode,
    { en: enTags, zh: zhState.vision.tagCounts, headings: zhState.vision.headingTags },
  )
  record(
    'AC9/mdLabels',
    'the existing md.* labels are translated in zh',
    zhState.vision.preLabel === '代码块' && zhState.vision.tableLabel === '表格' && /在新标签页打开/.test(zhState.vision.anchors[0] ? zhState.vision.anchors[0].ariaLabel : ''),
    { pre: zhState.vision.preLabel, table: zhState.vision.tableLabel, anchor: zhState.vision.anchors[0] && zhState.vision.anchors[0].ariaLabel },
  )
  record(
    'AC9/scanCopy',
    'existing scan copy is unchanged in zh',
    zhState.drawerTitle.indexOf('项目扫描') !== -1 && zhState.sectionTitles.indexOf('产品愿景') !== -1,
    { drawerTitle: zhState.drawerTitle, sectionTitles: zhState.sectionTitles },
  )
  await shot('scan-drawer-1024-zh')
  await closeDrawer()
} else {
  record('AC9/structure', 'the zh drawer renders the same Markdown structure as en', false, 'language switch failed; screenshot omitted')
  record('AC9/mdLabels', 'the existing md.* labels are translated in zh', false, 'language switch failed')
  record('AC9/scanCopy', 'existing scan copy is unchanged in zh', false, 'language switch failed')
}
await setLanguage('English')
record('setup/backToEnglish', 'the shell returns to English', (await panelTitle()) === 'Kanban', await panelTitle())

// ---------------------------------------------------------------------------
// 8. AC8 — 640px full-width drawer and wrapper-local scrolling
// ---------------------------------------------------------------------------

await setViewport(640, 900)
await reloadShell()
await openPanel()
await sleep(700)
const title640 = await panelTitle()
const theme640 = await app.evaluate('document.documentElement.getAttribute("data-ds-theme-source")')
record('setup/640', 'the panel is reloaded and painted at 640x900 in English light', title640 === 'Kanban' && theme640 === 'light', { title: title640, theme: theme640 })

await runScan('main', 0)
await waitForDataReady()
await shot('scan-drawer-640-light')
const main640 = await measure()
results.measurements.main640 = main640
record(
  'AC8/fullWidth640',
  'at 640 the scan drawer is full width with no page or drawer horizontal overflow',
  Boolean(main640) && Math.abs(main640.drawer.width - main640.overlay.width) < 1.5 && main640.drawer.scrollWidth <= main640.drawer.clientWidth + 1 && main640.body.scrollWidth <= main640.body.clientWidth + 1 && main640.doc.scrollWidth <= main640.doc.clientWidth,
  main640 && { drawer: main640.drawer, overlay: main640.overlay, body: main640.body, doc: main640.doc },
)
await closeDrawer()

await runScan('noVision', 0)
await waitFor('document.querySelector(".kb-candidate")', '640 no-vision baseline')
await sleep(350)
const noVision640 = await measure()
record('AC2/baseline640', 'an empty vision at 640 records the drawer size', Boolean(noVision640), noVision640)
await closeDrawer()

await runScan('big', 0)
await waitFor('document.querySelector(".kb-vision .kb-md")', '640 big vision')
await sleep(450)
const big640 = await measure()
results.measurements.big640 = big640
record(
  'AC2/contain640',
  'the 26k vision scrolls at 640 with no horizontal drawer/body/page overflow',
  Boolean(big640) &&
    big640.vision.scrollHeight > big640.vision.clientHeight &&
    big640.vision.overflowY === 'auto' &&
    big640.drawer.scrollWidth <= big640.drawer.clientWidth + 1 &&
    big640.body.scrollWidth <= big640.body.clientWidth + 1 &&
    big640.doc.scrollWidth <= big640.doc.clientWidth,
  big640 && { vision: { scrollHeight: big640.vision.scrollHeight, clientHeight: big640.vision.clientHeight, maxHeight: big640.vision.maxHeight, overflowY: big640.vision.overflowY }, drawer: big640.drawer, body: big640.body, doc: big640.doc },
)
record(
  'AC2/sizeUnchanged640',
  'the drawer outer width/height is unchanged versus an empty-vision fixture at 640',
  Boolean(big640 && noVision640) && Math.abs(big640.drawer.width - noVision640.drawer.width) < 0.6 && Math.abs(big640.drawer.height - noVision640.drawer.height) < 0.6,
  { big: big640 && big640.drawer, empty: noVision640 && noVision640.drawer },
)
record(
  'AC8/wrappers640',
  'a wide table and a long code line scroll inside their own .kb-md-tableWrap/pre wrapper',
  Boolean(big640) &&
    ((big640.tableWrap && big640.tableWrap.scrollWidth > big640.tableWrap.clientWidth && /auto|scroll/.test(big640.tableWrap.overflowX)) ||
      (big640.pre && big640.pre.scrollWidth > big640.pre.clientWidth && /auto|scroll/.test(big640.pre.overflowX))),
  big640 && { tableWrap: big640.tableWrap, pre: big640.pre },
)
await shot('scan-drawer-640-big-light')
await closeDrawer()

// ---------------------------------------------------------------------------
// 9. AC10 console/page errors + final board equality + restore
// ---------------------------------------------------------------------------

await setViewport(1024, 768)
await sleep(500)
const pageErrors = await app.evaluate('window.__kb61Errors || []')
const knownShellNoise = pageErrors.filter((text) => /deepseek-account/.test(text))
const unexpectedPageErrors = pageErrors.filter((text) => !/deepseek-account/.test(text))
const consoleNew = app.console.slice(consoleBaseline)
const consoleUnexpected = consoleNew.filter((entry) => !/deepseek-account/.test(entry.text || ''))
results.console = { pageErrors, knownShellNoise, baselineEntries: consoleBaseline, newConsole: consoleNew }
record(
  'AC10/console',
  'no page error, unhandled rejection or console error during the fixture pass',
  unexpectedPageErrors.length === 0 && consoleUnexpected.length === 0 && lastFulfilError === null,
  { pageErrors: unexpectedPageErrors, console: consoleUnexpected, knownShellNoise, interception: lastFulfilError },
)

const finalState = await pageState()
const finalBoard = finalState && finalState.board ? finalState.board : null
const finalTickets = finalBoard && Array.isArray(finalBoard.tickets) ? finalBoard.tickets.length : -1
record(
  'AC5/boardFinal',
  'the board snapshot and ticket count are still equal after the whole pass',
  JSON.stringify(preBoard) === JSON.stringify(finalBoard) && preTickets === finalTickets,
  { preTickets, finalTickets, same: JSON.stringify(preBoard) === JSON.stringify(finalBoard) },
)

// Restore the previously selected workspace and language/theme.
await app.cdp.send('Fetch.disable').catch(() => {})
await app.evaluate(`(() => { window.localStorage.setItem('dsh.kanban.workspace', ${JSON.stringify(boot.workspaceId)}); return true })()`)
await reloadShell()
await openPanel()
await setTheme('light').catch(() => {})
const restoredTitle = await clientProjectTitle()
record('cleanup/workspace', 'the previously selected workspace is restored', restoredTitle === (results.meta.originalProject || null), { restoredTitle, original: results.meta.originalProject })

results.meta.finishedAt = new Date().toISOString()
results.meta.failures = failures
results.meta.intercepted = {
  scan: results.interceptedActions.filter((entry) => entry.action === 'scan').length,
  applyScan: results.interceptedActions.filter((entry) => entry.action === 'applyScan').length,
  forwardedActions: results.interceptedActions.filter((entry) => entry.forwarded === true).map((entry) => entry.action),
  fixtureInjected: true,
}
results.meta.bigVisionChars = BIG_VISION.length
results.meta.screenshots = results.screenshots
await writeFile(`${OUT}final-verification.json`, JSON.stringify(results, null, 1))
console.log(`\n${failures === 0 ? 'ALL KB-61 CHECKS PASSED' : failures + ' FAILURE(S)'}`)
console.log(`evidence: docs/screenshots/kb61/final-verification.json (${results.screenshots.length} screenshots, ${results.checks.length} checks)`)
process.exit(failures === 0 ? 0 : 1)
