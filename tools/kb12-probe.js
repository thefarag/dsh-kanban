/**
 * KB-12 verification probe — Kanban panel UX: responsive layout, card containment,
 * wider side panels.
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) and asserts
 * AC1–AC7 from the ticket, then writes:
 *   dsh-kanban/docs/screenshots/kb12/final-verification.json
 *   dsh-kanban/docs/screenshots/kb12/after-*.png
 *
 * Usage (from the repository root, with Chrome on port 9333):
 *   node dsh-kanban/tools/kb12-probe.js
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { attach } from './cdp.mjs'

const OUT_URL = new URL('../docs/screenshots/kb12/', import.meta.url)
const OUT = OUT_URL.pathname
const WIDTHS = [1440, 1280, 1024, 860, 640]
const HEIGHT = 700
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = { meta: {}, checks: [], measurements: {}, screenshots: [], console: [] }
let failures = 0

function record(id, name, pass, detail) {
  results.checks.push({ id, name, pass: pass === true, detail: detail === undefined ? null : detail })
  if (pass !== true) failures += 1
  console.log(`${pass === true ? 'ok  ' : 'FAIL'} ${id} ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const app = await attach()

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function setViewport(width, height = HEIGHT) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(550)
}

async function setTheme(theme) {
  await app.cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'dark' : 'light' }],
  })
  await sleep(550)
}

const hasPanel = () => app.evaluate(`!!document.querySelector('.kb-root')`)

async function openPanel() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await hasPanel()) return true
    const clicked = await app.evaluate(
      `(() => {
        const row = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === 'Kanban' && b.getBoundingClientRect().width > 0);
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

async function clickLabel(label) {
  const clicked = await app.evaluate(
    `(() => {
      const want = ${JSON.stringify(label)}.toLowerCase();
      const nodes = [...document.querySelectorAll('button')].filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const el = nodes.find((n) => (n.getAttribute('aria-label') || '').trim().toLowerCase() === want);
      if (!el) return false;
      el.click();
      return true;
    })()`,
    { userGesture: true },
  )
  await sleep(800)
  return clicked
}

async function closeHeaderPopovers() {
  await app.evaluate(`(() => {
    for (const label of ['Close team panel', 'Close']) {
      const btn = [...document.querySelectorAll('.kb-header button')].find((b) => (b.getAttribute('aria-label') || '') === label);
      if (btn) btn.click();
    }
    return true;
  })()`)
  // Clicking the Team header toggle again is the reliable way to close the rail.
  const railOpen = await app.evaluate(`!!document.querySelector('.kb-rail')`)
  if (railOpen) await clickLabel('Team')
  await sleep(250)
}

async function ensureRailClosed() {
  if (await app.evaluate(`!!document.querySelector('.kb-rail')`)) {
    await clickLabel('Team')
    await sleep(300)
  }
}

async function ensureDrawerClosed() {
  const open = await app.evaluate(`!!document.querySelector('.kb-drawer, .kb-dialog')`)
  if (!open) return
  await app.evaluate(
    `(() => {
      const btn = [...document.querySelectorAll('.kb-drawer button')].find((b) => /close/i.test(b.getAttribute('aria-label') || ''));
      if (btn) btn.click();
      else {
        const alt = [...document.querySelectorAll('.kb-drawer button, .kb-dialog button')].find((b) => /cancel|close/i.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')));
        if (alt) alt.click();
      }
      return true;
    })()`,
    { userGesture: true },
  )
  await sleep(500)
}

async function shoot(name, extra = {}) {
  await app.screenshot(OUT + name)
  results.screenshots.push({ file: `dsh-kanban/docs/screenshots/kb12/${name}`, ...extra })
  return name
}

/** Screenshot a clip in CSS pixels. */
async function shootClip(name, clip) {
  const { data } = await app.cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
  })
  await writeFile(OUT + name, Buffer.from(data, 'base64'))
  results.screenshots.push({ file: `dsh-kanban/docs/screenshots/kb12/${name}`, clip })
}

// ---------------------------------------------------------------------------
// Measurement expressions (single synchronous evaluate = safe against the
// 2.5s Host poll re-render)
// ---------------------------------------------------------------------------

const MEASURE_PAGE = `(() => {
  const q = (selector) => document.querySelector(selector);
  const rect = (el) => {
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), right: Math.round(box.right), bottom: Math.round(box.bottom) };
  };
  const root = q('.kb-root');
  const board = q('.kb-board');
  const header = q('.kb-header');
  const stats = q('.kb-stats');
  const lanes = [...document.querySelectorAll('.kb-col')].map((el) => {
    const head = el.querySelector('.kb-colHead');
    const title = el.querySelector('.kb-colTitle');
    const count = el.querySelector('.kb-colCount');
    const wip = el.querySelector('.kb-colWip');
    const add = el.querySelector('.kb-colAdd');
    return {
      column: el.getAttribute('data-column'),
      ...rect(el),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      head: {
        title: title ? title.textContent : null,
        titleEllipsized: !!(title && title.scrollWidth > title.clientWidth + 1),
        countVisible: !!count && count.getBoundingClientRect().width > 0,
        wipVisible: !!wip && wip.getBoundingClientRect().width > 0,
        addVisible: !!add && add.getBoundingClientRect().width > 0,
        overflow: head ? head.scrollWidth > head.clientWidth + 1 : false,
      },
    };
  });
  const boardBox = rect(board);
  const boardContentRight = board ? Math.round(board.getBoundingClientRect().left + board.clientLeft + board.clientWidth) : null;
  const headerBox = rect(header);
  const controls = [...document.querySelectorAll('.kb-header button, .kb-header input, .kb-header select')].map((el) => {
    const box = el.getBoundingClientRect();
    const visible = box.width > 0 && box.height > 0;
    const inside = !visible || (box.left >= headerBox.x - 1 && box.right <= headerBox.right + 1 && box.top >= headerBox.y - 1 && box.bottom <= headerBox.bottom + 1);
    const style = getComputedStyle(el);
    return {
      label: (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().slice(0, 40),
      cls: String(el.className || '').slice(0, 60),
      tag: el.tagName.toLowerCase(),
      visible,
      shown: style.display !== 'none' && style.visibility !== 'hidden',
      inside,
      ...rect(el),
    };
  });
  const fixedRegions = ['.kb-header', '.kb-colHead', '.kb-railHead', '.kb-drawerHead', '.kb-stats']
    .map((selector) => {
      const el = q(selector);
      if (!el) return null;
      return { selector, scrollH: el.scrollHeight, clientH: el.clientHeight, scrollW: el.scrollWidth, clientW: el.clientWidth };
    })
    .filter(Boolean);
  return {
    viewport: { w: innerWidth, h: innerHeight },
    panel: root ? Math.round(root.getBoundingClientRect().width) : null,
    root: root ? { scrollW: root.scrollWidth, clientW: root.clientWidth, ...rect(root) } : null,
    body: { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth },
    header: header ? { scrollW: header.scrollWidth, clientW: header.clientWidth, ...headerBox } : null,
    stats: stats ? { scrollW: stats.scrollWidth, clientW: stats.clientWidth, ...rect(stats) } : null,
    board: board ? { scrollW: board.scrollWidth, clientW: board.clientWidth, contentRight: boardContentRight, ...boardBox } : null,
    lanes,
    controls,
    fixedRegions,
    searchVisible: !!q('.kb-search') && getComputedStyle(q('.kb-search')).display !== 'none' && q('.kb-search').getBoundingClientRect().width > 0,
    searchToggleVisible: !!q('.kb-searchToggle') && getComputedStyle(q('.kb-searchToggle')).display !== 'none',
    titleVisible: !!q('.kb-title') && getComputedStyle(q('.kb-title')).display !== 'none',
    blockedLaneRendered: !!q('.kb-col--blocked'),
    cardCount: document.querySelectorAll('.kb-card').length,
    laneCount: lanes.length,
  };
})()`

const MEASURE_RAIL = `(() => {
  const q = (selector) => document.querySelector(selector);
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
  const rail = q('.kb-rail');
  const header = q('.kb-header');
  const panel = q('.kb-root');
  if (!rail) return { open: false };
  const railBox = rail.getBoundingClientRect();
  const outside = [...rail.querySelectorAll('*')].filter((el) => {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return false;
    return b.right > railBox.right + 1 || b.left < railBox.left - 1;
  }).map((el) => String(el.className || el.tagName).slice(0, 44));
  const rows = [...document.querySelectorAll('.kb-teamRow')].map((row) => {
    const rowBox = row.getBoundingClientRect();
    const name = row.querySelector('.kb-teamName');
    const role = row.querySelector('.kb-teamRole');
    const status = row.querySelector('.kb-teamStatus');
    const ticket = row.querySelector('.kb-teamTicket');
    const ticketText = row.querySelector('.kb-teamTicketText');
    const outsideRow = [...row.querySelectorAll('*')].filter((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return false;
      return b.right > rowBox.right + 1 || b.left < rowBox.left - 1;
    }).map((el) => String(el.className || el.tagName).slice(0, 40));
    return {
      name: name ? name.textContent : null,
      nameTitle: name ? name.getAttribute('title') : null,
      roleLabel: role && role.selectedIndex >= 0 ? role.options[role.selectedIndex].textContent : null,
      roleWidth: role ? Math.round(role.getBoundingClientRect().width) : null,
      statusVisible: !!status && status.getBoundingClientRect().width > 0,
      ticketId: ticket ? ticket.textContent.trim() : null,
      ticketTitle: ticket ? ticket.getAttribute('title') : null,
      ticketShownWidth: ticket ? Math.round(ticket.getBoundingClientRect().width) : null,
      ticketTextWidth: ticketText ? Math.round(ticketText.scrollWidth) : null,
      ticketEllipsized: !!(ticketText && ticketText.scrollWidth > ticketText.clientWidth + 1),
      outside: outsideRow.slice(0, 3),
    };
  });
  return {
    open: true,
    rail: { ...rect(rail), scrollW: rail.scrollWidth, clientW: rail.clientWidth, position: getComputedStyle(rail).position },
    headerBottom: header ? Math.round(header.getBoundingClientRect().bottom) : null,
    panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : null,
    outside: outside.slice(0, 5),
    rows,
  };
})()`

const MEASURE_DRAWER = `(() => {
  const q = (selector) => document.querySelector(selector);
  const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), right: Math.round(b.right) }; };
  const drawer = q('.kb-drawer');
  const panel = q('.kb-root');
  if (!drawer) return { open: false };
  const drawerBox = drawer.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  const outside = [...drawer.querySelectorAll('*')].filter((el) => {
    const b = el.getBoundingClientRect();
    if (b.width === 0 || b.height === 0) return false;
    return b.right > drawerBox.right + 1 || b.left < drawerBox.left - 1;
  }).map((el) => String(el.className || el.tagName).slice(0, 44));
  const columns = [...document.querySelectorAll('.kb-colButtons .kb-colBtn')].map((el) => (el.textContent || '').trim());
  const longValues = [...drawer.querySelectorAll('.kb-mrTitle, .kb-docPath, .kb-commentAuthor, .kb-activityTime')].map((el) => ({
    cls: String(el.className),
    title: el.getAttribute('title'),
    ellipsized: el.scrollWidth > el.clientWidth + 1,
  }));
  return {
    open: true,
    scan: drawer.classList.contains('kb-drawer--scan'),
    drawer: { ...rect(drawer), scrollW: drawer.scrollWidth, clientW: drawer.clientWidth },
    panel: { ...rect(panel), right: Math.round(panelBox.right) },
    vsPanel: {
      widthLePanel: drawerBox.width <= panelBox.width + 1,
      rightAligned: Math.round(drawerBox.right) <= Math.round(panelBox.right) + 1,
      leftInside: Math.round(drawerBox.left) >= Math.round(panelBox.left) - 1,
    },
    outside: outside.slice(0, 5),
    columnButtons: columns,
    longValues: longValues.filter((v) => v.ellipsized).length ? longValues : [],
  };
})()`

// Worst-case DOM fixture for AC4: mutate every rendered card, then measure in the
// same synchronous task (before the 2.5s poll re-render restores React output).
const FIXTURE_AND_CHECK = `(() => {
  const longTitle = 'Worst-case ticket title with a deliberately long sentence that wraps over several lines and averylongunbreakabletokenwithoutspacesthatmustnotescape the card border box';
  const longLabel = 'a-very-long-label-value-that-exceeds-the-card-width';
  const longOwner = 'dev · KB-3 · 9f4f-super-long-agent-display-name-that-cannot-fit';
  const chips = [
    ['kb-chip kb-chip--story', 'Story'],
    ['kb-chip kb-chip--error', 'Blocked'],
    ['kb-chip kb-chip--warn', 'Waiting: 3 questions and needs'],
    ['kb-execChip kb-execChip--running', 'Agent running'],
    ['kb-chip kb-chip--warn', 'Next: Fullstack Developer'],
  ];
  const cards = [...document.querySelectorAll('.kb-card')];
  for (const card of cards) {
    const top = card.querySelector('.kb-cardTop');
    if (top) {
      const idEl = top.querySelector('.kb-cardId');
      if (idEl) idEl.textContent = 'KB-12345';
      const target = top.querySelector('.kb-cardChips') || top;
      [...target.querySelectorAll('.kb-chip, .kb-execChip')].forEach((el) => el.remove());
      for (const [cls, text] of chips) {
        const chip = document.createElement('span');
        chip.className = cls;
        chip.title = text;
        const span = document.createElement('span');
        span.className = 'kb-chipText';
        span.textContent = text;
        chip.appendChild(span);
        target.appendChild(chip);
      }
    }
    const title = card.querySelector('.kb-cardTitle');
    if (title) title.textContent = longTitle;
    const meta = card.querySelector('.kb-cardMeta');
    if (meta) {
      meta.innerHTML = '';
      const tag = document.createElement('span');
      tag.className = 'kb-tag';
      tag.title = 'Fullstack Developer';
      const tagText = document.createElement('span');
      tagText.className = 'kb-tagText';
      tagText.textContent = 'Fullstack Developer';
      tag.appendChild(tagText);
      meta.appendChild(tag);
      const owner = document.createElement('span');
      owner.className = 'kb-iconMeta';
      owner.title = longOwner;
      const ownerName = document.createElement('span');
      ownerName.className = 'kb-cardOwnerName';
      ownerName.textContent = longOwner;
      owner.appendChild(ownerName);
      meta.appendChild(owner);
    }
    const labels = card.querySelector('.kb-cardLabels');
    if (labels) {
      labels.innerHTML = '';
      for (let index = 0; index < 3; index += 1) {
        const tag = document.createElement('span');
        tag.className = 'kb-tag';
        tag.title = longLabel + '-' + index;
        const text = document.createElement('span');
        text.className = 'kb-tagText';
        text.textContent = longLabel + '-' + index;
        tag.appendChild(text);
        labels.appendChild(tag);
      }
    }
  }
  const report = [];
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const outside = [...card.querySelectorAll('*')].filter((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0 && b.height === 0) return false;
      return b.right > box.right + 1 || b.left < box.left - 1 || b.bottom > box.bottom + 1 || b.top < box.top - 1;
    }).map((el) => ({ cls: String(el.className || el.tagName).slice(0, 44), rect: [Math.round(el.getBoundingClientRect().left), Math.round(el.getBoundingClientRect().right)] }));
    report.push({
      id: card.getAttribute('data-ticket'),
      width: Math.round(box.width),
      scrollW: card.scrollWidth,
      clientW: card.clientWidth,
      outside: outside.slice(0, 4),
    });
  }
  return { cards: cards.length, report };
})()`

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

await mkdir(OUT, { recursive: true })
await app.ensureApp({ reload: true })
await setTheme('light')
await setViewport(1440)
await openPanel()
results.meta = {
  generatedAt: new Date().toISOString(),
  viewportHeights: HEIGHT,
  widths: WIDTHS,
  chrome: await app.evaluate('navigator.userAgent'),
  containerQueries: await app.evaluate(`CSS.supports('container-type', 'inline-size')`),
}

// ---- AC1 + AC2 across the required widths --------------------------------
const pageByWidth = {}
for (const width of WIDTHS) {
  await setViewport(width)
  await ensureDrawerClosed()
  await ensureRailClosed()
  await openPanel()
  await sleep(500)
  const page = await app.evaluate(MEASURE_PAGE)
  pageByWidth[width] = page
  results.measurements[`page@${width}`] = page
  await shoot(`after-light-board-${width}.png`, { width, viewport: page.viewport, panel: page.panel })
}

// AC1 — five workflow lanes fit at 1440 and 1280 (default DSH sidebar, rail closed)
for (const width of [1440, 1280]) {
  const page = pageByWidth[width]
  const workflowLanes = page.lanes.filter((lane) => ['backlog', 'ready', 'in_progress', 'review', 'done'].includes(lane.column))
  const allLaneRightInside = page.lanes.every((lane) => lane.right <= page.board.contentRight + 1)
  const workflowRightInside = workflowLanes.every((lane) => lane.right <= page.board.contentRight + 1)
  record(
    'AC1',
    `five lanes fully visible at ${width}px window (panel ${page.panel}px)`,
    workflowLanes.length === 5 && workflowRightInside && allLaneRightInside && page.board.scrollW <= page.board.clientW,
    {
      panel: page.panel,
      laneCount: page.lanes.length,
      workflowLaneWidths: workflowLanes.map((lane) => lane.w),
      laneRights: page.lanes.map((lane) => [lane.column, lane.right]),
      boardContentRight: page.board.contentRight,
      boardScrollW: page.board.scrollW,
      boardClientW: page.board.clientW,
    },
  )
  record(
    'AC1',
    `every lane readable at ${width}px window (>=176px)`,
    page.lanes.every((lane) => lane.w >= 176),
    { laneWidths: page.lanes.map((lane) => [lane.column, lane.w]) },
  )
}

// AC2 — no root overflow, no clipped/unreachable header control, no cut region
for (const width of WIDTHS) {
  const page = pageByWidth[width]
  const clipped = page.controls.filter((control) => control.visible && !control.inside)
  // A control that is display:none is fine only when it is the duplicate half of
  // the search pair (collapsed input vs. search toggle); both must never be hidden.
  const hiddenControls = page.controls.filter((control) => control.shown && control.visible === false)
  const hiddenDuplicatesOk = hiddenControls.every((control) => control.label === 'Search tickets') && (page.searchVisible || page.searchToggleVisible)
  const cutRegions = page.fixedRegions.filter((region) => region.scrollH > region.clientH + 1)
  const headerOverflow = page.header.scrollW > page.header.clientW + 1
  const rootOverflow = page.root.scrollW > page.root.clientW + 1
  const expectedLabels = ['Filters', 'Scan', 'New ticket', 'Team', 'Pause board', 'Refresh']
  const reachable = expectedLabels.every((label) => page.controls.some((control) => control.label === label && control.visible && control.inside))
  record('AC2', `no root horizontal overflow at ${width}px window`, !rootOverflow, {
    rootScrollW: page.root.scrollW,
    rootClientW: page.root.clientW,
  })
  record('AC2', `header controls not clipped and every action reachable at ${width}px window`, clipped.length === 0 && !headerOverflow && reachable && hiddenDuplicatesOk, {
    panel: page.panel,
    headerScrollW: page.header.scrollW,
    headerClientW: page.header.clientW,
    clipped: clipped.map((control) => control.label),
    hiddenDuplicates: hiddenControls.map((control) => control.label),
    searchVisible: page.searchVisible,
    searchToggleVisible: page.searchToggleVisible,
    allLabelsReachable: reachable,
  })
  record('AC2', `no fixed-height region cuts off content at ${width}px window`, cutRegions.length === 0, {
    regions: page.fixedRegions,
    cut: cutRegions.map((region) => region.selector),
  })
  record('AC2', `stats row scrolls inside itself only at ${width}px window`, page.stats.scrollW >= page.stats.clientW && rootOverflow === false, {
    statsScrollW: page.stats.scrollW,
    statsClientW: page.stats.clientW,
  })
  // The Blocked lane intentionally shows a waiting indicator instead of the + button.
  const illLegible = page.lanes.filter(
    (lane) =>
      lane.head.titleEllipsized ||
      !lane.head.countVisible ||
      lane.head.overflow ||
      (!lane.head.addVisible && lane.column !== 'blocked'),
  )
  record('AC2', `column header, count, WIP and add stay legible at ${width}px window`, illLegible.length === 0, {
    laneWidths: page.lanes.map((lane) => [lane.column, lane.w]),
    illLegible: illLegible.map((lane) => ({ column: lane.column, ...lane.head })),
  })
}

// ---- AC3 container reflow: same panel width from two paths ---------------
await setViewport(1440)
await openPanel()
await ensureRailClosed()
const panel1440 = await app.evaluate(MEASURE_PAGE)
const layoutSignature = (page) => ({
  panel: page.panel,
  laneWidths: page.lanes.map((lane) => lane.w),
  laneCount: page.lanes.length,
  searchVisible: page.searchVisible,
  searchToggleVisible: page.searchToggleVisible,
  titleVisible: page.titleVisible,
  headerHeight: page.header ? page.header.h : null,
})
// Collapse the DSH sidebar at 1216px → the Kanban panel becomes the same 1160px.
await setViewport(1216)
await app.evaluate(
  `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === 'Collapse sidebar');
    if (btn) btn.click();
    return !!btn;
  })()`,
  { userGesture: true },
)
await sleep(900)
await openPanel()
await ensureRailClosed()
await sleep(400)
const panel1216Collapsed = await app.evaluate(MEASURE_PAGE)
results.measurements['AC3-1440-expanded'] = layoutSignature(panel1440)
results.measurements['AC3-1216-collapsed'] = layoutSignature(panel1216Collapsed)
record(
  'AC3',
  'panel-driven reflow: sidebar toggle gives the same layout as the equivalent window width',
  panel1440.panel === 1160 &&
    panel1216Collapsed.panel === 1160 &&
    JSON.stringify(layoutSignature(panel1440)) === JSON.stringify(layoutSignature(panel1216Collapsed)),
  { expandedPath: layoutSignature(panel1440), collapsedPath: layoutSignature(panel1216Collapsed) },
)
// Restore the sidebar and the 1440 viewport.
await app.evaluate(
  `(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === 'Open sidebar');
    if (btn) btn.click();
    return !!btn;
  })()`,
  { userGesture: true },
)
await sleep(800)
await setViewport(1440)
await openPanel()

// ---- AC5 team rail -------------------------------------------------------
await setViewport(1440)
await openPanel()
await ensureDrawerClosed()
await ensureRailClosed()
const lanesBeforeRail = await app.evaluate(MEASURE_PAGE)
const railOpened = await clickLabel('Team')
const rail1440 = await app.evaluate(MEASURE_RAIL)
const lanesWithRail = await app.evaluate(MEASURE_PAGE)
results.measurements['rail@1440'] = rail1440
const railWidthOk = rail1440.open && rail1440.rail.w >= 320 && rail1440.rail.w % 4 === 0
const railOverlay = rail1440.open && rail1440.rail.position === 'absolute'
const railClearsHeader = rail1440.open && rail1440.rail.y >= rail1440.headerBottom - 1
const railNoOverflow = rail1440.open && rail1440.rail.scrollW <= rail1440.rail.clientW + 1 && rail1440.outside.length === 0
const rowsHaveInfo =
  rail1440.open &&
  rail1440.rows.every(
    (row) => row.name && row.roleWidth >= 120 && row.statusVisible && (row.ticketId === null || row.ticketTitle !== null),
  )
const rowsNoClip = rail1440.open && rail1440.rows.every((row) => row.outside.length === 0)
const lanesUnchanged = JSON.stringify(lanesBeforeRail.lanes.map((lane) => lane.w)) === JSON.stringify(lanesWithRail.lanes.map((lane) => lane.w))
record('AC5', 'team rail default width >= 320px on the 4px grid', railWidthOk, { width: rail1440.open ? rail1440.rail.w : null })
record('AC5', 'team rail rows show name, full role label, status and current ticket without clipping', rowsHaveInfo && rowsNoClip && railNoOverflow, {
  rows: rail1440.rows.length,
  sample: rail1440.rows.slice(0, 3),
})
record('AC5', 'open rail overlays (does not squeeze lanes) at <=1180px panel and never covers the header', railOverlay && railClearsHeader && lanesUnchanged, {
  railPosition: rail1440.open ? rail1440.rail.position : null,
  railTop: rail1440.open ? rail1440.rail.y : null,
  headerBottom: rail1440.headerBottom,
  lanesBefore: lanesBeforeRail.lanes.map((lane) => lane.w),
  lanesAfter: lanesWithRail.lanes.map((lane) => lane.w),
  delivered: await app.evaluate(`!!document.querySelector('.kb-rail')`),
})
await shoot('after-light-team-rail-1440.png')

// Long ticket title tooltip / ellipsis evidence.
await setTheme('dark')
await sleep(400)
await shoot('after-dark-team-rail-1440.png')
await setTheme('light')
await ensureRailClosed()

// ---- AC6 drawers ---------------------------------------------------------
async function openTicketDrawer(id = 'KB-10') {
  const opened = await app.evaluate(
    `(() => { const el = document.querySelector('[data-ticket=${JSON.stringify(id)}]'); if (!el) return false; el.click(); return true; })()`,
    { userGesture: true },
  )
  await sleep(900)
  return opened
}

const drawerByWidth = {}
const drawerSizes = { 1440: 500, 1024: 500, 640: 640 }
for (const width of [1440, 1024, 640]) {
  await setViewport(width)
  await ensureRailClosed()
  await openPanel()
  await sleep(350)
  await openTicketDrawer('KB-10')
  const drawer = await app.evaluate(MEASURE_DRAWER)
  drawerByWidth[width] = drawer
  results.measurements[`ticketDrawer@${width}`] = drawer
  const inside = drawer.open && drawer.vsPanel.widthLePanel && drawer.vsPanel.rightAligned && drawer.vsPanel.leftInside
  const noOverflow = drawer.open && drawer.drawer.scrollW <= drawer.drawer.clientW + 1 && drawer.outside.length === 0
  const fullscreen = width === 640 ? drawer.drawer.w === drawer.panel.w : true
  record('AC6', `ticket drawer clamps to the panel with no horizontal overflow at ${width}px`, inside && noOverflow && fullscreen && drawer.columnButtons.length === 5, {
    drawer: drawer.drawer,
    panel: drawer.panel,
    vsPanel: drawer.vsPanel,
    outside: drawer.outside,
    columnButtons: drawer.columnButtons,
    width: drawerSizes[width],
  })
  if (width === 1440) {
    await shoot('after-light-ticket-drawer-1440.png')
    await setTheme('dark')
    await shoot('after-dark-ticket-drawer-1440.png')
    await setTheme('light')
  }
  if (width === 640) await shoot('after-light-ticket-drawer-640.png')
  await ensureDrawerClosed()
}

// Scan drawer at the same widths.
for (const width of [1440, 1024, 640]) {
  await setViewport(width)
  await ensureDrawerClosed()
  await ensureRailClosed()
  await openPanel()
  await sleep(300)
  await clickLabel('Scan')
  await sleep(2400)
  const drawer = await app.evaluate(MEASURE_DRAWER)
  results.measurements[`scanDrawer@${width}`] = drawer
  const inside = drawer.open && drawer.scan && drawer.vsPanel.widthLePanel && drawer.vsPanel.rightAligned && drawer.vsPanel.leftInside
  const noOverflow = drawer.open && drawer.drawer.scrollW <= drawer.drawer.clientW + 1 && drawer.outside.length === 0
  const fullscreen = width === 640 ? drawer.drawer.w === drawer.panel.w : true
  record('AC6', `scan drawer clamps to the panel with no horizontal overflow at ${width}px`, inside && noOverflow && fullscreen, {
    drawer: drawer.drawer,
    panel: drawer.panel,
    outside: drawer.outside,
  })
  if (width === 1440) await shoot('after-light-scan-1440.png')
  await ensureDrawerClosed()
}

// ---- AC7 theme + a11y ----------------------------------------------------
await setViewport(1440)
await openPanel()
await ensureRailClosed()
const themeColors = {}
for (const theme of ['light', 'dark']) {
  await setTheme(theme)
  themeColors[theme] = await app.evaluate(`(() => {
    const read = (selector) => { const el = document.querySelector(selector); if (!el) return null; const cs = getComputedStyle(el); return { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor }; };
    return {
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      root: read('.kb-root'),
      col: read('.kb-col'),
      card: read('.kb-card'),
      chip: read('.kb-cardChips .kb-chip'),
    };
  })()`)
}
results.measurements.themeColors = themeColors
const themeDiffers =
  themeColors.light.dark === false &&
  themeColors.dark.dark === true &&
  JSON.stringify(themeColors.light.root) !== JSON.stringify(themeColors.dark.root) &&
  JSON.stringify(themeColors.light.card) !== JSON.stringify(themeColors.dark.card)
record('AC7', 'light and dark both render from theme tokens (panel/card/rail surfaces differ)', themeDiffers, themeColors)

// Theme screenshot pairs (board + rightmost lanes).
await setTheme('light')
await ensureRailClosed()
await ensureDrawerClosed()
await shoot('after-light-board-1440.png')
await app.evaluate(`(() => { const board = document.querySelector('.kb-board'); if (board) board.scrollLeft = board.scrollWidth; return true; })()`)
await sleep(300)
await shoot('after-light-rightmost-lanes-1440.png')
// Card-with-labels closeup: the widest card that carries labels.
const cardClip = await app.evaluate(`(() => {
  const cards = [...document.querySelectorAll('.kb-card')].filter((card) => card.querySelector('.kb-cardLabels'));
  if (cards.length === 0) return null;
  const card = cards.sort((left, right) => right.getBoundingClientRect().width - left.getBoundingClientRect().width)[0];
  const box = card.getBoundingClientRect();
  return { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), width: Math.min(innerWidth - Math.max(0, box.x - 6), box.width + 12), height: box.height + 12, ticket: card.getAttribute('data-ticket') };
})()`)
if (cardClip) await shootClip('after-light-card-labels.png', cardClip)
await app.evaluate(`(() => { const board = document.querySelector('.kb-board'); if (board) board.scrollLeft = 0; return true; })()`)
await setTheme('dark')
await sleep(400)
await shoot('after-dark-board-1440.png')
await app.evaluate(`(() => { const board = document.querySelector('.kb-board'); if (board) board.scrollLeft = board.scrollWidth; return true; })()`)
await sleep(300)
await shoot('after-dark-rightmost-lanes-1440.png')
await app.evaluate(`(() => { const board = document.querySelector('.kb-board'); if (board) board.scrollLeft = 0; return true; })()`)
await setTheme('light')

// a11y: new controls expose aria-label/title; Escape + drag alternative unchanged.
await clickLabel('Team') // team rows carry the ticket/name tooltips we assert below
await sleep(400)
const a11y = await app.evaluate(`(() => {
  const labelled = (el) => !!(el && ((el.getAttribute('aria-label') || '').trim() || (el.getAttribute('title') || '').trim()));
  const searchToggle = document.querySelector('.kb-searchToggle');
  return {
    searchToggle: labelled(searchToggle),
    searchTogglePressed: searchToggle ? searchToggle.getAttribute('aria-pressed') : null,
    teamTicketsHaveTooltips: [...document.querySelectorAll('.kb-teamTicket')].every(labelled),
    teamNamesHaveTooltips: [...document.querySelectorAll('.kb-teamName')].every(labelled),
    cardOwnersHaveTooltips: [...document.querySelectorAll('.kb-cardMeta .kb-iconMeta')].filter((el) => el.querySelector('.kb-cardOwnerName')).every(labelled),
    cardLabelsHaveTooltips: [...document.querySelectorAll('.kb-cardLabels .kb-tag')].every(labelled),
    teamPauseHasLabel: [...document.querySelectorAll('.kb-teamTop button')].every(labelled),
  };
})()`)
await ensureRailClosed()
record(
  'AC7',
  'new responsive controls expose aria-label/title and keep keyboard/drag-alternative behaviour',
  a11y.searchToggle &&
    a11y.searchTogglePressed !== null &&
    a11y.teamTicketsHaveTooltips &&
    a11y.teamNamesHaveTooltips &&
    a11y.cardOwnersHaveTooltips &&
    a11y.cardLabelsHaveTooltips &&
    a11y.teamPauseHasLabel,
  a11y,
)

// Escape closes the drawer; drawer column buttons remain the drag alternative.
await setViewport(1440)
await openTicketDrawer('KB-10')
const openedDrawer = await app.evaluate(`!!document.querySelector('.kb-drawer')`)
await app.key('Escape')
await sleep(600)
const closedByEscape = !(await app.evaluate(`!!document.querySelector('.kb-drawer')`))
record('AC7', 'Escape closes the ticket drawer (keyboard behaviour unchanged)', openedDrawer && closedByEscape, { openedDrawer, closedByEscape })

// Narrow search toggle keeps search reachable at 640.
await setViewport(640)
await openPanel()
await sleep(400)
const searchToggleClicked = await clickLabel('Search tickets')
const overlay = await app.evaluate(`(() => {
  const overlay = document.querySelector('.kb-search--overlay');
  if (!overlay) return { open: false };
  const box = overlay.getBoundingClientRect();
  const header = document.querySelector('.kb-header').getBoundingClientRect();
  return { open: true, width: Math.round(box.width), headerWidth: Math.round(header.width), inputLabel: (overlay.querySelector('input') || {}).getAttribute ? overlay.querySelector('input').getAttribute('aria-label') : null, closeLabel: (overlay.querySelector('.kb-searchClose') || {}).getAttribute ? overlay.querySelector('.kb-searchClose').getAttribute('aria-label') : null };
})()`)
record('AC2', 'narrow header keeps search reachable through the search toggle overlay', searchToggleClicked && overlay.open && overlay.width >= overlay.headerWidth - 32, overlay)
await shoot('after-light-search-overlay-640.png')
await app.key('Escape')
await sleep(400)
await shoot('after-light-board-640.png')
record('AC2', 'search overlay closes back to the compact header', !(await app.evaluate(`!!document.querySelector('.kb-search--overlay')`)), null)

// ---- AC4 card containment with worst-case fixture ------------------------
// Runs last: the fixture mutates rendered React DOM on purpose, so no later
// assertion or screenshot may depend on React output after this point.
const fixtureByWidth = {}
for (const width of WIDTHS) {
  await setViewport(width)
  await ensureDrawerClosed()
  await ensureRailClosed()
  await openPanel()
  await sleep(350)
  const fixture = await app.evaluate(FIXTURE_AND_CHECK)
  fixtureByWidth[width] = fixture
  results.measurements[`fixture@${width}`] = {
    cards: fixture.cards,
    worstCards: fixture.report.filter((card) => card.outside.length > 0 || card.scrollW > card.clientW),
  }
  const bad = fixture.report.filter((card) => card.outside.length > 0 || card.scrollW > card.clientW)
  record('AC4', `worst-case cards stay inside their border box at ${width}px (${fixture.cards} cards)`, bad.length === 0 && fixture.cards > 0, {
    cards: fixture.cards,
    offenders: bad.slice(0, 4),
  })
}

// ---- Finish --------------------------------------------------------------
await setTheme('light')
await setViewport(1440)
await openPanel()
const pageErrors = await app.errors()
results.console = pageErrors.slice(0, 20)
// Ignore unrelated Host shell noise (e.g. account/network reads); only Kanban
// errors and uncaught exceptions fail the gate.
const kanbanErrors = pageErrors.filter(
  (entry) => entry.type === 'exception' || /kanban|kb-/i.test(String(entry.text || '')),
)
record('AC8', 'no Kanban console errors or unhandled exceptions during the probe', kanbanErrors.length === 0, {
  kanbanErrors: kanbanErrors.slice(0, 6),
  unrelatedIgnored: pageErrors.length - kanbanErrors.length,
})

results.summary = { checks: results.checks.length, failures, pass: failures === 0 }
await writeFile(OUT + 'final-verification.json', JSON.stringify(results, null, 1))
console.log(`\n${failures === 0 ? 'ALL KB-12 CHECKS PASSED' : `${failures} FAILURE(S)`} — evidence: dsh-kanban/docs/screenshots/kb12/final-verification.json`)
process.exit(failures === 0 ? 0 : 1)
