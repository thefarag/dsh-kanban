/**
 * KB-57 Markdown surface verification probe.
 *
 * The kitchen-sink fixture is rendered in Node by the shipped `MarkdownBody`
 * + `parseMarkdown`/`renderMarkdown` engine under a fake React, serialized to
 * HTML, then injected as a harness drawer (and as 1024/640 px containers)
 * inside the real open Kanban panel, so the host `--dsw-*` theme tokens and the
 * shipped `.kb-md` CSS apply to exactly what this slice ships.
 *
 * Verifies: no page/drawer horizontal overflow at 500/1024/640, long code and
 * table scrolling inside their own wrappers, heading scale + long-heading wrap,
 * link target/rel/host aria-label + aria-hidden icon, Tab order and the token
 * focus ring, pre aria-label/tabIndex/white-space/max-height, th scope, task
 * checkbox state, en/zh localized labels and token-driven light/dark colors.
 *
 * Writes docs/screenshots/kb57/final-verification.json and 7 PNGs.
 *
 * Usage (Chrome on port 9333, GUI URL in $DSH_WEB_URL):
 *   DSH_WEB_URL=http://127.0.0.1:51591 node tools/kb57-probe.js
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { attach, mintCookie, APP_URL } from './cdp.mjs'

const REPO_ROOT = new URL('../', import.meta.url)
const OUT_URL = new URL('../docs/screenshots/kb57/', import.meta.url)
const OUT = fileURLToPath(OUT_URL)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = {
  meta: { ticket: 'KB-57', url: APP_URL },
  checks: [],
  measurements: {},
  screenshots: [],
  console: [],
  notes: [],
}
let failures = 0

const record = (id, name, pass, detail) => {
  results.checks.push({ id, name, pass: pass === true, detail: detail === undefined ? null : detail })
  if (pass !== true) failures += 1
  console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 280)}`}`)
}
const note = (text) => {
  results.notes.push(text)
  console.log('note ' + text)
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ---------------------------------------------------------------------------
// 0. Render the fixture with the shipped component under a fake React
// ---------------------------------------------------------------------------

const clientSource = await readFile(new URL('client.js', REPO_ROOT), 'utf8')
let captured = null
globalThis.window = { __ModuleLoader__: { load: (entry) => (captured = entry) } }
globalThis.window.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}, activeElement: null }
await import(`data:text/javascript;base64,${Buffer.from(clientSource).toString('base64')}`)

const fakeReact = (() => {
  const hooks = new Map()
  let current = null
  const entryFor = (component) => {
    if (!hooks.has(component)) hooks.set(component, { hooks: [], cursor: 0 })
    return hooks.get(component)
  }
  const React = {
    Component: class Component {
      constructor(props) {
        this.props = props
      }
    },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: () => {
      throw new Error('state is not expected in the probe fixture')
    },
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo(factory, deps) {
      const entry = entryFor(current)
      const slot = entry.cursor
      entry.cursor += 1
      const previous = entry.hooks[slot]
      const same = previous && deps && previous.deps && previous.deps.length === deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]))
      if (same) return previous.value
      const value = factory()
      entry.hooks[slot] = { deps: deps || [], value }
      return value
    },
  }
  const resolve = (node) => {
    if (Array.isArray(node)) return node.map(resolve)
    if (node === null || node === undefined || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const previous = current
      current = node.type
      const entry = entryFor(node.type)
      entry.cursor = 0
      let result
      try {
        result = node.type({ ...node.props, children: node.children.length > 0 ? node.children : node.props.children })
      } finally {
        current = previous
      }
      return resolve(result)
    }
    return { type: node.type, props: node.props, children: node.children.map(resolve) }
  }
  return { React, render: (type, props) => resolve({ type, props: props || {}, children: [] }) }
})()

const plugin = captured.factory((name) => {
  if (name === 'react') return fakeReact.React
  throw new Error(`unexpected require ${name}`)
})
const MarkdownBody = plugin.markdown.MarkdownBody

const dictionaries = {}
plugin.apply({
  effect(fn) {
    return fn() || (() => {})
  },
  locale: {
    register(namespace, dicts) {
      dictionaries[namespace] = dicts
      return () => {}
    },
    bind: () => (key) => key,
  },
  uiWorkspace: { openSession() {} },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  slots: { inject: (slot, callback) => callback(), register: () => () => {} },
})
const translations = {
  en: (key) => dictionaries.kanban.en[key] ?? key,
  zh: (key) => dictionaries.kanban.zh[key] ?? key,
}
// Visible caption built from the shipped dictionaries, so the en/zh PNGs carry
// the localized copy the component feeds into aria labels (which a screenshot
// cannot show otherwise). Probe chrome, not product UI.
const labelCaption = (locale) =>
  `${locale} · ${dictionaries.kanban[locale]['md.codeBlock']} · ${dictionaries.kanban[locale]['md.table']} · ${dictionaries.kanban[locale]['md.linkExternal']}`

const TABLE_HEADERS = Array.from({ length: 10 }, (_, index) => `Column ${index + 1} heading`)
const FIXTURE = [
  `# Markdown kitchen sink ${'x'.repeat(0)}`,
  '## Second level heading',
  '### Third level heading',
  '#### Fourth level heading',
  '##### Fifth level heading',
  '###### Sixth level heading',
  '',
  'Paragraph with **bold**, *italic*, ~~struck~~ and `inline code`, plus a hard',
  'line break right here.',
  '',
  '- first item',
  '  - nested item',
  '    - deeply nested item',
  '- second item',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '- [x] shipped task',
  '- [ ] pending task',
  '',
  '> A quoted line for the blockquote style.',
  '',
  '---',
  '',
  'Links: [DeepSeek docs](https://example.com/docs/reference) and [email the team](mailto:team@example.com).',
  '',
  '```js',
  `const longLine = "${'abcdefghij'.repeat(24)}"`,
  'const second = 2',
  '```',
  '',
  `| ${TABLE_HEADERS.join(' | ')} |`,
  `| ${TABLE_HEADERS.map(() => '---').join(' | ')} |`,
  `| ${TABLE_HEADERS.map((_, index) => `cell value ${index + 1}`).join(' | ')} |`,
  `| ${TABLE_HEADERS.map((_, index) => `more content ${index + 1}`).join(' | ')} |`,
  '',
  `# ${'Supercalifragilisticexpialidocious'.repeat(6)}`,
].join('\n')

const escapeHtml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const ATTRIBUTE_NAMES = {
  className: 'class',
  tabIndex: 'tabindex',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
}
const VOID_ELEMENTS = new Set(['br', 'hr', 'input', 'img'])
const serialize = (node) => {
  if (Array.isArray(node)) return node.map(serialize).join('')
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return escapeHtml(node)
  const props = node.props || {}
  const attributes = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || value === undefined || value === null || value === false) continue
    if (key === 'defaultChecked') {
      if (value === true) attributes.push('checked')
      continue
    }
    if (key === 'disabled') {
      if (value === true) attributes.push('disabled')
      continue
    }
    attributes.push(`${ATTRIBUTE_NAMES[key] || key}="${escapeHtml(value)}"`)
  }
  const open = `<${node.type}${attributes.length > 0 ? ' ' + attributes.join(' ') : ''}>`
  if (VOID_ELEMENTS.has(node.type)) return open
  return `${open}${serialize(node.children)}</${node.type}>`
}
const renderFixture = (locale) => serialize(fakeReact.render(MarkdownBody, { text: FIXTURE, t: translations[locale] }))
const FIXTURE_HTML = { en: renderFixture('en'), zh: renderFixture('zh') }
results.meta.fixture = { characters: FIXTURE.length, sha256: sha256(Buffer.from(FIXTURE)) }
results.meta.harness = {
  fixture:
    'kitchen sink: h1-h6, nested/ordered/task lists, inline code, long-line fenced code, blockquote, hr, external+mailto links, 10-column table, 200-char unbroken heading',
  renderer: 'shipped MarkdownBody + parseMarkdown/renderMarkdown under a Node fake React, serialized to HTML',
  themeControl:
    'Emulation.setEmulatedMedia plus the host body[data-ds-dark-theme] marker the GUI uses for its dark token block, because the GUI pins data-ds-theme-source and ignores the media query',
  caption: 'container shots carry a caption built from the shipped en/zh dictionary labels (probe chrome, not product UI)',
}

// ---------------------------------------------------------------------------
// 1. Attach to the real GUI and open the Kanban panel
// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true })

// Cross-process navigation can drop the pending CDP response and replace the
// page target, so boot in steps and re-attach after every navigation instead of
// relying on a single long-lived session.
async function bootGui() {
  const cookie = await mintCookie()
  let page = await attach()
  try {
    await page.cdp.send('Page.navigate', { url: APP_URL + '/' }, 12000)
  } catch {
    note('Page.navigate response was lost during process swap; reconnecting')
  }
  await sleep(1600)
  page = await attach()
  await page.evaluate(
    `(() => { document.cookie = ${JSON.stringify(cookie.name)} + '=' + ${JSON.stringify(cookie.value)} + '; path=/; SameSite=Strict'; return true })()`,
  )
  try {
    await page.cdp.send('Page.reload', { ignoreCache: true }, 12000)
  } catch {
    note('Page.reload response was lost during process swap; reconnecting')
  }
  await sleep(2000)
  page = await attach()
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const state = await page
      .evaluate(
        `({ ready: document.readyState, auth: !document.body || document.body.innerText.includes('authentication required'), length: document.body ? document.body.innerText.length : 0 })`,
      )
      .catch(() => null)
    if (state && state.ready === 'complete' && state.auth === false && state.length > 50) return page
    await sleep(1000)
    page = await attach()
  }
  throw new Error('the authenticated GUI shell did not load')
}

async function installCollectors(page) {
  await page.cdp.send('Runtime.enable')
  await page.cdp.send('Log.enable')
  page.cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type !== 'error' && params.type !== 'warning') return
    const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
    page.console.push({ type: params.type, text })
  })
  page.cdp.on('Runtime.exceptionThrown', (params) => {
    page.console.push({ type: 'exception', text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception' })
  })
  await page.evaluate(`(() => {
    if (window.__dshUiErrors) return true;
    window.__dshUiErrors = [];
    window.addEventListener('error', (e) => window.__dshUiErrors.push(String(e.message || e.error || 'error')));
    window.addEventListener('unhandledrejection', (e) => window.__dshUiErrors.push(String((e.reason && e.reason.message) || e.reason || 'rejection')));
    const original = console.error;
    console.error = (...args) => { window.__dshUiErrors.push(args.map(String).join(' ')); original.apply(console, args); };
    return true;
  })()`)
}

const app = await bootGui()
await installCollectors(app)
results.meta.startedAt = new Date().toISOString()
results.meta.url = await app.evaluate('location.href')
try {
  results.meta.gitRev = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(REPO_ROOT) }).toString().trim()
} catch {
  results.meta.gitRev = null
}
results.meta.clientSha256 = sha256(clientSource)

async function setViewport(width, height = 900) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
}
async function setTheme(theme) {
  // The GUI pins an explicit theme source, so prefers-color-scheme alone does
  // not flip its tokens. Emulate the media query (as the KB-5 probe does) and
  // additionally toggle the host's own dark-theme marker — the exact attribute
  // its `body[data-ds-dark-theme]` token block switches on — so the shots carry
  // the real dark host tokens rather than a probe-invented palette.
  await app.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'dark' : 'light' }] })
  await app.evaluate(`(() => {
    const dark = ${theme === 'dark' ? 'true' : 'false'};
    if (dark) document.body.setAttribute('data-ds-dark-theme', '');
    else document.body.removeAttribute('data-ds-dark-theme');
    document.documentElement.setAttribute('data-ds-theme-source', dark ? 'dark' : 'light');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    return true;
  })()`)
  await sleep(500)
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
    if (await app.evaluate(`!!document.querySelector('.kb-root')`)) return true
    await dismissAppModals()
    await app.evaluate(
      `(() => {
        const row = [...document.querySelectorAll('button')].find((b) => /^(Kanban|看板)$/.test((b.getAttribute('aria-label') || '').trim()) && b.getBoundingClientRect().width > 0);
        if (!row) return false;
        row.click();
        return true;
      })()`,
      { userGesture: true },
    )
    await sleep(1200)
  }
  throw new Error('could not open the Kanban panel')
}

await setViewport(1024, 900)
await setTheme('light')
await dismissAppModals()
await openPanel()
await app.waitFor(`!!document.querySelector('.kb-root')`, 10000, 'Kanban panel').catch(() => {})
const panelReady = await app.evaluate(`!!document.querySelector('.kb-root')`)
record('setup/panel', 'the real Kanban panel is open so host tokens and shipped CSS apply', panelReady)
if (!panelReady) throw new Error('Kanban panel is not open')

// ---------------------------------------------------------------------------
// 2. Harness injection (removed in the finally block)
// ---------------------------------------------------------------------------

const HARNESS_HEAD = { en: 'Markdown surface fixture', zh: 'Markdown 界面测试' }

async function installHarness(mode, locale, width) {
  const html = FIXTURE_HTML[locale]
  await app.evaluate(
    `(() => {
      const root = document.querySelector('.kb-root');
      if (!root) return false;
      document.querySelectorAll('.kb57-harness').forEach((el) => el.remove());
      const mode = ${JSON.stringify(mode)};
      const locale = ${JSON.stringify(locale)};
      const width = ${JSON.stringify(width)};
      const headText = ${JSON.stringify(HARNESS_HEAD[locale])};
      const captionText = ${JSON.stringify(labelCaption(locale))};
      if (mode === 'drawer') {
        const overlay = document.createElement('div');
        overlay.className = 'kb-overlay kb-overlay--right kb57-harness';
        overlay.style.zIndex = '60';
        const drawer = document.createElement('div');
        drawer.className = 'kb-drawer';
        const head = document.createElement('div');
        head.className = 'kb-drawerHead';
        const headMain = document.createElement('div');
        headMain.className = 'kb-drawerHeadMain';
        headMain.textContent = 'KB-57 ' + headText;
        head.appendChild(headMain);
        const body = document.createElement('div');
        body.className = 'kb-drawerBody';
        body.innerHTML = ${JSON.stringify(html)};
        drawer.appendChild(head);
        drawer.appendChild(body);
        overlay.appendChild(drawer);
        root.appendChild(overlay);
        return true;
      }
      const wrap = document.createElement('div');
      wrap.className = 'kb57-harness';
      // No padding when the container is the full 1024 px so its measured width
      // is exactly 1024; the 640 px container stays centred with a gutter.
      const gutter = width >= 1024 ? '0' : '16px';
      wrap.style.cssText = 'position:fixed;inset:0;z-index:60;overflow:auto;background:var(--dsw-alias-bg-base);padding:' + gutter + ';box-sizing:border-box';
      const container = document.createElement('div');
      container.className = 'kb57-container';
      container.style.cssText =
        'width:' + width + 'px;max-width:100%;margin:0 auto;padding:14px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base)';
      const caption = document.createElement('div');
      caption.className = 'kb57-caption';
      caption.textContent = captionText;
      caption.style.cssText = 'margin:0 0 10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary)';
      container.appendChild(caption);
      container.insertAdjacentHTML('beforeend', ${JSON.stringify(html)});
      wrap.appendChild(container);
      root.appendChild(wrap);
      return true;
    })()`,
    { userGesture: true },
  )
  await sleep(400)
}

const removeHarness = () => app.evaluate(`(() => { document.querySelectorAll('.kb57-harness').forEach((el) => el.remove()); return true })()`)

async function measure() {
  return app.evaluate(`(() => {
    const harness = document.querySelector('.kb57-harness');
    const md = harness && harness.querySelector('.kb-md');
    const drawer = harness && harness.querySelector('.kb-drawer');
    const container = harness && harness.querySelector('.kb57-container');
    const panel = document.querySelector('.kb-root');
    const doc = document.documentElement;
    const box = (el) => (el ? { width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) } : null);
    const overflow = (el) => (el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflowX: el.scrollWidth > el.clientWidth + 1 } : null);
    const pre = md && md.querySelector('pre');
    const tableWrap = md && md.querySelector('.kb-md-tableWrap');
    const table = md && md.querySelector('table');
    const headingNodes = md ? [...md.querySelectorAll('h3,h4,h5,h6')] : [];
    const headings = headingNodes.map((node) => ({
      tag: node.tagName.toLowerCase(),
      fontSize: parseFloat(getComputedStyle(node).fontSize),
      width: Math.round(node.getBoundingClientRect().width),
      text: (node.textContent || '').slice(0, 24),
    }));
    const longHeading = headingNodes.find((node) => (node.textContent || '').length >= 200) || null;
    const longHeadingBox = longHeading
      ? {
          width: Math.round(longHeading.getBoundingClientRect().width),
          height: Math.round(longHeading.getBoundingClientRect().height),
          lineHeight: parseFloat(getComputedStyle(longHeading).lineHeight),
          wrap: getComputedStyle(longHeading).overflowWrap,
          scrollWidth: longHeading.scrollWidth,
          clientWidth: longHeading.clientWidth,
        }
      : null;
    const links = md
      ? [...md.querySelectorAll('a')].map((anchor) => {
          const icon = anchor.querySelector('svg');
          return {
            href: anchor.getAttribute('href'),
            target: anchor.getAttribute('target'),
            rel: anchor.getAttribute('rel'),
            ariaLabel: anchor.getAttribute('aria-label'),
            icon: Boolean(icon),
            iconHidden: icon ? icon.getAttribute('aria-hidden') : null,
          };
        })
      : [];
    const boxes = md
      ? [...md.querySelectorAll('input[type="checkbox"]')].map((input) => ({
          disabled: input.disabled === true,
          ariaLabel: input.getAttribute('aria-label'),
          pointerEvents: getComputedStyle(input).pointerEvents,
          checked: input.checked === true,
        }))
      : [];
    const ths = md ? [...md.querySelectorAll('th')].map((th) => th.getAttribute('scope')) : [];
    const preStyle = pre ? getComputedStyle(pre) : null;
    return {
      viewport: { width: doc.clientWidth, height: doc.clientHeight },
      page: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth },
      panel: overflow(panel),
      drawer: drawer ? { ...box(drawer), ...overflow(drawer) } : null,
      container: box(container),
      md: md ? { ...box(md), ...overflow(md) } : null,
      pre: pre ? { ...box(pre), ...overflow(pre), tabIndex: pre.getAttribute('tabindex'), ariaLabel: pre.getAttribute('aria-label'), whiteSpace: preStyle.whiteSpace, overflowX: preStyle.overflowX, overflowY: preStyle.overflowY, maxHeight: preStyle.maxHeight, fontFamily: preStyle.fontFamily } : null,
      tableWrap: tableWrap
        ? { ...box(tableWrap), ...overflow(tableWrap), role: tableWrap.getAttribute('role'), tabIndex: tableWrap.getAttribute('tabindex'), ariaLabel: tableWrap.getAttribute('aria-label') }
        : null,
      table: box(table),
      cellMinWidth: md && md.querySelector('th,td') ? parseFloat(getComputedStyle(md.querySelector('th,td')).minWidth) : null,
      headings,
      longHeading: longHeadingBox,
      links,
      boxes,
      thScopes: ths,
      colors: {
        body: md ? getComputedStyle(md).color : null,
        background: md ? getComputedStyle(md).backgroundColor : null,
        preBackground: pre ? getComputedStyle(pre).backgroundColor : null,
        link: md && md.querySelector('a') ? getComputedStyle(md.querySelector('a')).color : null,
        tableHeaderBackground: md && md.querySelector('th') ? getComputedStyle(md.querySelector('th')).backgroundColor : null,
      },
    };
  })()`)
}

const shot = async (name) => {
  await app.screenshot(`${OUT}${name}.png`)
  results.screenshots.push(name + '.png')
  console.log('SHOT ' + name)
}

function assertNoOverflow(id, measurement) {
  record(`${id}/page`, 'the page has no horizontal overflow', measurement.page.scrollWidth <= measurement.page.clientWidth, measurement.page)
  record(`${id}/panel`, 'the panel has no horizontal overflow', Boolean(measurement.panel) && measurement.panel.overflowX === false, measurement.panel)
  record(`${id}/md`, 'the .kb-md surface has no horizontal overflow', Boolean(measurement.md) && measurement.md.overflowX === false, measurement.md)
}

function assertFixtureContract(id, measurement, expected) {
  const locale = expected.locale
  const links = measurement.links || []
  record(`${id}/pre`, 'fenced code is a labelled tab stop with preserved whitespace and a max-height', Boolean(measurement.pre) && measurement.pre.tabIndex === '0' && measurement.pre.ariaLabel === expected.codeLabel && /^pre/.test(measurement.pre.whiteSpace) && measurement.pre.overflowX === 'auto' && measurement.pre.overflowY === 'auto' && measurement.pre.maxHeight !== 'none', measurement.pre)
  record(`${id}/preScroll`, 'long code scrolls inside the pre wrapper', Boolean(measurement.pre) && measurement.pre.scrollWidth > measurement.pre.clientWidth, measurement.pre && { scrollWidth: measurement.pre.scrollWidth, clientWidth: measurement.pre.clientWidth })
  record(`${id}/tableScope`, 'every table header carries scope=col', Array.isArray(measurement.thScopes) && measurement.thScopes.length >= 10 && measurement.thScopes.every((scope) => scope === 'col'), measurement.thScopes)
  record(`${id}/tableWrap`, 'the table sits in a labelled tab stop that scrolls horizontally', Boolean(measurement.tableWrap) && measurement.tableWrap.role === 'region' && measurement.tableWrap.tabIndex === '0' && measurement.tableWrap.ariaLabel === expected.tableLabel && measurement.tableWrap.overflowX === true, measurement.tableWrap)
  record(`${id}/cellMinWidth`, 'table cells keep their min-width instead of squishing', typeof measurement.cellMinWidth === 'number' && measurement.cellMinWidth >= 64, measurement.cellMinWidth)
  const sizesByTag = {}
  for (const heading of measurement.headings) if (!sizesByTag[heading.tag]) sizesByTag[heading.tag] = heading.fontSize
  const sizes = ['h3', 'h4', 'h5', 'h6'].map((tag) => sizesByTag[tag])
  record(`${id}/headingScale`, 'the h3–h6 computed size scale strictly decreases', sizes.every((size) => typeof size === 'number') && sizes.slice(1).every((size, index) => size < sizes[index]), sizes)
  record(`${id}/longHeading`, 'the 200-char unbroken heading wraps inside the surface', Boolean(measurement.longHeading) && measurement.longHeading.wrap === 'anywhere' && measurement.longHeading.width <= (measurement.md ? measurement.md.width : 0) + 1 && measurement.longHeading.height > measurement.longHeading.lineHeight * 1.5, measurement.longHeading)
  const web = links.find((link) => /^https:/.test(link.href || ''))
  const mail = links.find((link) => /^mailto:/.test(link.href || ''))
  record(`${id}/linkAttrs`, 'links carry target=_blank and rel=noopener noreferrer nofollow', links.length >= 2 && links.every((link) => link.target === '_blank' && link.rel === 'noopener noreferrer nofollow'), links)
  record(`${id}/linkHost`, 'the web link accessible name includes the destination host and localized external text', Boolean(web) && /example\.com/.test(web.ariaLabel || '') && String(web.ariaLabel).includes(expected.externalText), web)
  record(`${id}/mailHost`, 'the mailto link accessible name includes the address', Boolean(mail) && /team@example\.com/.test(mail.ariaLabel || ''), mail)
  record(`${id}/linkIcon`, 'the external indicator is aria-hidden', links.length >= 2 && links.every((link) => link.icon === true && link.iconHidden === 'true'), links.map((link) => link.iconHidden))
  record(`${id}/taskList`, 'task checkboxes are disabled, labelled and non-interactive', measurement.boxes.length === 2 && measurement.boxes.every((input) => input.disabled && input.ariaLabel && input.pointerEvents === 'none') && measurement.boxes[0].checked === true && measurement.boxes[1].checked === false, measurement.boxes)
  record(`${id}/locale`, `fixture labels use the ${locale} dictionary`, measurement.pre.ariaLabel === expected.codeLabel && measurement.tableWrap.ariaLabel === expected.tableLabel, { code: measurement.pre.ariaLabel, table: measurement.tableWrap.ariaLabel })
}

// ---------------------------------------------------------------------------
// 3. 500 px harness drawer — light + dark, keyboard walk, token colors
// ---------------------------------------------------------------------------

const EN = { locale: 'en', codeLabel: 'Code block', tableLabel: 'Table', externalText: 'opens in a new tab' }
const ZH = { locale: 'zh', codeLabel: '代码块', tableLabel: '表格', externalText: '在新标签页打开' }

let scenarioError = null
try {
	await setTheme('light')
	await installHarness('drawer', 'en')
	let measured = await measure()
	results.measurements.drawer500Light = measured
	record('drawer/width', 'the harness drawer honours min(500px, 94%) at a 1024 px viewport', Boolean(measured.drawer) && measured.drawer.width <= 500 && measured.drawer.width >= 400, measured.drawer)
	assertNoOverflow('drawerLight', measured)
	assertFixtureContract('drawerLight', measured, EN)

	// Keyboard: focus the first link, then Tab through the next link, the code
	// wrapper and the table wrapper; the focused link must show the token ring.
	const focusStart = await app.evaluate(`(() => { const anchor = document.querySelector('.kb57-harness .kb-md a'); if (!anchor) return false; anchor.focus(); return document.activeElement === anchor })()`)
	const walk = []
	for (let step = 0; step < 3; step += 1) {
	  await app.key('Tab')
	  await sleep(150)
	  walk.push(
	    await app.evaluate(`(() => {
	      const el = document.activeElement;
	      if (!el) return null;
	      const style = getComputedStyle(el);
	      return {
	        tag: el.tagName.toLowerCase(),
	        className: typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '',
	        href: el.getAttribute ? el.getAttribute('href') : null,
	        ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
	        outlineStyle: style.outlineStyle,
	        outlineWidth: style.outlineWidth,
	        outlineColor: style.outlineColor,
	      };
	    })()`),
	  )
	}
	results.measurements.keyboardWalk = walk
	record('drawer/keyboard', 'Tab reaches the links in order, then the code and table scroll regions', focusStart === true && walk.length === 3 && walk[0].tag === 'a' && /^mailto:/.test(walk[0].href || '') && walk[1].tag === 'pre' && /kb-md-tableWrap/.test(walk[2].className), walk.map((step) => `${step.tag}:${step.href || step.className}`))
	record('drawer/focusRing', 'the focused link shows a token-driven :focus-visible ring', Boolean(walk[0]) && walk[0].outlineStyle === 'solid' && walk[0].outlineWidth === '2px' && /rgb/.test(walk[0].outlineColor || ''), walk[0] && { style: walk[0].outlineStyle, width: walk[0].outlineWidth, color: walk[0].outlineColor })

	const lightColors = measured.colors
	await shot('fixture-drawer-500-1024-light')

	await setTheme('dark')
	measured = await measure()
	results.measurements.drawer500Dark = measured
	const darkColors = measured.colors
	record(
	  'drawer/themeTokens',
	  'light and dark render different token-driven colors on the same surface',
	  Boolean(lightColors.body && darkColors.body && lightColors.body !== darkColors.body && lightColors.preBackground !== darkColors.preBackground),
	  { light: lightColors, dark: darkColors },
	)
	await shot('fixture-drawer-500-1024-dark')
	await setTheme('light')
	await removeHarness()

	// ---------------------------------------------------------------------------
	// 4. 1024 px container — light + dark
	// ---------------------------------------------------------------------------

	await installHarness('container', 'en', 1024)
	measured = await measure()
	results.measurements.container1024Light = measured
	record('container1024/width', 'the harness container measures 1024 px at a 1024 px viewport', Boolean(measured.container) && measured.container.width === 1024, measured.container)
	assertNoOverflow('container1024Light', measured)
	assertFixtureContract('container1024Light', measured, EN)
	await shot('fixture-1024-light')
	await setTheme('dark')
	measured = await measure()
	results.measurements.container1024Dark = measured
	await shot('fixture-1024-dark')
	await setTheme('light')
	await removeHarness()

	// ---------------------------------------------------------------------------
	// 5. 640 px container — light + dark (tables must not widen the page)
	// ---------------------------------------------------------------------------

	await installHarness('container', 'en', 640)
	measured = await measure()
	results.measurements.container640Light = measured
	record('container640/width', 'the harness container measures 640 px', Boolean(measured.container) && measured.container.width === 640, measured.container)
	assertNoOverflow('container640Light', measured)
	assertFixtureContract('container640Light', measured, EN)
	await shot('fixture-640-light')
	await setTheme('dark')
	measured = await measure()
	results.measurements.container640Dark = measured
	await shot('fixture-640-dark')
	await setTheme('light')
	await removeHarness()

	// ---------------------------------------------------------------------------
	// 6. zh labels on the same fixture — visible zh screenshot
	// ---------------------------------------------------------------------------

	await installHarness('container', 'zh', 1024)
	measured = await measure()
	results.measurements.container1024Zh = measured
	assertNoOverflow('container1024Zh', measured)
	assertFixtureContract('container1024Zh', measured, ZH)
	const zhLink = measured.links.find((link) => /^https:/.test(link.href || ''))
	record('container1024Zh/linkText', 'the zh link accessible name uses the zh external text', Boolean(zhLink) && /在新标签页打开/.test(zhLink.ariaLabel || ''), zhLink)
	await shot('fixture-1024-zh')
	await removeHarness()
} catch (error) {
	scenarioError = error
	record('probe/error', 'the probe scenarios ran to completion', false, String((error && error.stack) || error).slice(0, 600))
} finally {
	// The harness must never survive a failed run: remove it and restore the
	// host theme/viewport even when a measurement throws.
	await removeHarness().catch(() => {})
	await setTheme('light').catch(() => {})
	await setViewport(1024, 900).catch(() => {})
}

// ---------------------------------------------------------------------------
// 7. Teardown + console
// ---------------------------------------------------------------------------

results.console = (await app.errors()).map((entry) => ({ type: entry.type, text: String(entry.text).slice(0, 300) }))
const consoleErrors = results.console.filter((entry) => entry.type === 'error' || entry.type === 'exception')
const hostNoise = /deepseek-account|account read failed/i
const relevantErrors = consoleErrors.filter((entry) => !hostNoise.test(String(entry.text || '')))
if (relevantErrors.length !== consoleErrors.length) note(`ignored ${consoleErrors.length - relevantErrors.length} host account-console lines (not the plugin)`)
record('console/clean', 'no page exceptions or plugin console errors during the run', relevantErrors.length === 0, relevantErrors.slice(0, 3))

results.meta.finishedAt = new Date().toISOString()
results.meta.failures = failures
results.meta.scenarioError = scenarioError ? String((scenarioError && scenarioError.message) || scenarioError) : null
results.meta.screenshots = results.screenshots
await writeFile(new URL('../docs/screenshots/kb57/final-verification.json', import.meta.url), JSON.stringify(results, null, 1))
console.log(`\n${failures === 0 ? 'ALL KB-57 PROBE CHECKS PASSED' : `${failures} FAILURE(S)`}`)
console.log(`evidence: docs/screenshots/kb57/final-verification.json (${results.screenshots.length} screenshots, ${results.checks.length} checks)`)
process.exit(failures === 0 ? 0 : 1)
