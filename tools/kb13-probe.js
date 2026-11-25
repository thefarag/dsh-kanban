/**
 * KB-13 verification probe — team roles & personas.
 *
 * Drives the real DSH Web GUI in headless Chrome (see tools/README.md) and
 * asserts the KB-13 acceptance contract end to end:
 *   - snapshot v2 with a seeded 10-member roster + compact role catalog
 *   - team rail fixed roster with attached-agent statuses (no other-agents section)
 *   - member editor with composed-prompt preview (memberPrompt)
 *   - member CRUD through the UI (create + delete restores the roster)
 *   - role playbook viewer (roleDetail)
 *   - add-with-AI drafting (async draft row becomes a member, or template fallback)
 *   - responsive rail overlay at narrow panel widths
 *
 * Writes docs/screenshots/kb13/final-verification.json and PNGs.
 *
 * Usage (with Chrome on port 9333 and the app URL in $DSH_WEB_URL):
 *   node tools/kb13-probe.js
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { attach } from './cdp.mjs'

const OUT_URL = new URL('../docs/screenshots/kb13/', import.meta.url)
const OUT = OUT_URL.pathname
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = { meta: {}, checks: [], measurements: {}, screenshots: [], console: [], cleanup: [] }
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

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

async function setViewport(width, height = 900) {
  await app.cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
}

async function setTheme(theme) {
  await app.cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'dark' : 'light' }],
  })
  await sleep(500)
}

const hasPanel = () => app.evaluate(`!!document.querySelector('.kb-root')`)

async function openPanel() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
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
    await sleep(1500)
    if (clicked && (await hasPanel())) return true
  }
  throw new Error('could not open the Kanban panel')
}

async function clickLabel(label) {
  const clicked = await app.evaluate(
    `(() => {
      const want = ${JSON.stringify(label)}.toLowerCase();
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const nodes = [...document.querySelectorAll('button,[role="button"],a')].filter(visible);
      const el = nodes.find((n) => {
        const text = [n.getAttribute('aria-label') || '', n.getAttribute('title') || '', n.textContent || '']
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        return text === want || text.includes(want);
      });
      if (!el) return false;
      el.click();
      return true;
    })()`,
    { userGesture: true },
  )
  await sleep(700)
  return clicked
}

async function clickSelector(selector) {
  const clicked = await app.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
    { userGesture: true },
  )
  await sleep(500)
  return clicked
}

/** Click a labelled control inside a specific container (avoids board/ticket matches). */
async function clickIn(containerSelector, label) {
  const clicked = await app.evaluate(
    `(() => {
      const want = ${JSON.stringify(label)}.toLowerCase();
      const container = document.querySelector(${JSON.stringify(containerSelector)});
      if (!container) return false;
      const nodes = [...container.querySelectorAll('button,[role="button"],a')];
      const label = (n) => (n.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      // Exact match first: roster ticket chips and cards can contain the same
      // words as a control's label (e.g. "Document role playbooks ...").
      const el = nodes.find((n) => label(n) === want)
        ?? nodes.find((n) => (n.getAttribute('aria-label') || '').trim().toLowerCase() === want)
        ?? nodes.find((n) => (n.getAttribute('title') || '').trim().toLowerCase() === want);
      if (!el) return false;
      el.click();
      return true;
    })()`,
    { userGesture: true },
  )
  await sleep(700)
  return clicked
}

async function closeOverlays() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const open = await app.evaluate(`!!document.querySelector('.kb-drawer')`)
    if (!open) return
    await app.evaluate(
      `(() => {
        const btn = [...document.querySelectorAll('.kb-drawer button')].find((b) => /close/i.test(b.getAttribute('aria-label') || ''));
        if (btn) btn.click();
        return true;
      })()`,
    )
    await sleep(400)
  }
}

async function pageState() {
  return app.evaluate(`(async () => {
    const response = await fetch('/kanban/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: null }),
    });
    const payload = await response.json();
    return payload.ok ? payload.value : { error: payload.error, status: response.status };
  })()`)
}

let workspaceId = ''
async function pageAction(action, payload = {}) {
  return app.evaluate(`(async () => {
    const response = await fetch('/kanban/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: ${JSON.stringify(workspaceId === undefined ? '' : workspaceId)}, action: ${JSON.stringify(action)}, payload: ${JSON.stringify(payload)} }),
    });
    const payload = await response.json();
    return { status: response.status, body: payload };
  })()`)
}

async function shot(name) {
  const path = `${OUT}${name}.png`
  await app.screenshot(path)
  results.screenshots.push(name + '.png')
  return path
}

const rosterRowCount = () => app.evaluate(`document.querySelectorAll('.kb-rosterRow').length`)

let seededMemberIds = new Set()
async function cleanupProbe() {
  try {
    const state = await pageState()
    if (!state || !Array.isArray(state.roster)) return
    const stray = state.roster.filter((member) => !seededMemberIds.has(member.id))
    for (const member of stray) {
      await pageAction('deleteMember', { memberId: member.id, force: true })
      results.cleanup.push(`removed probe member ${member.name}`)
    }
    for (const draft of state.drafts || []) {
      if (draft.status === 'drafting') await pageAction('cancelDraft', { draftId: draft.id })
    }
  } catch (error) {
    results.cleanup.push(`cleanup error: ${error && error.message ? error.message : error}`)
  }
  try {
    await closeOverlays()
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// 1. Boot the real GUI and verify the Host contract (snapshot v2)
// ---------------------------------------------------------------------------

await app.ensureApp({ reload: true })
await setViewport(1440, 900)
await setTheme('light')
await openPanel()

let snap = await pageState()
workspaceId = typeof snap.workspaceId === 'string' ? snap.workspaceId : ''
results.meta.project = snap.project && snap.project.title
record('snapshot/version', 'snapshot version is 2', snap.version === 2, snap.version)
record('snapshot/roster', 'roster is seeded with 10 members', Array.isArray(snap.roster) && snap.roster.length === 10, snap.roster && snap.roster.length)
record('snapshot/drafts', 'drafts array is present', Array.isArray(snap.drafts), Array.isArray(snap.drafts))
record('snapshot/roles', 'role catalog has 10 compact roles', snap.rules && snap.rules.roles && snap.rules.roles.length === 10, snap.rules && snap.rules.roles && snap.rules.roles.length)
const roleRows = (snap.rules && snap.rules.roles) || []
record('snapshot/rolesCompact', 'roles are compact (no full playbook)', roleRows.every((role) => !('playbook' in role) && typeof role.stepCount === 'number' && Array.isArray(role.definitionOfDone) && role.definitionOfDone.length >= 6))
record('snapshot/bugFixer', 'bug-fixer role is present', roleRows.some((role) => role.id === 'bug-fixer'))
const bugRow = roleRows.find((role) => role.id === 'bug-fixer')
record('snapshot/bugFixerSteps', 'bug-fixer advertises 11 playbook steps', bugRow && bugRow.stepCount === 11, bugRow && bugRow.stepCount)
record('snapshot/rosterShape', 'roster rows carry status/persona/ticket fields', (snap.roster || []).every((member) => ['paused', 'running', 'idle', 'offline'].includes(member.status) && typeof member.persona === 'string' && member.persona.length > 500 && typeof member.roleName === 'string'))
const seededIds = new Set((snap.roster || []).map((member) => member.id))
seededMemberIds = seededIds
record('snapshot/deterministicIds', 'seeded ids are member-<roleId>', seededIds.size === 10 && [...seededIds].every((id) => id.startsWith('member-')))

// API-level action proofs (same-origin authenticated fetch from the page).
const roleDetail = await pageAction('roleDetail', { roleId: 'bug-fixer' })
record('api/roleDetail', 'roleDetail returns the full bug-fixer playbook', roleDetail.body.ok === true && roleDetail.body.value.role.playbook.steps.length === 11 && roleDetail.body.value.role.playbook.definitionOfDone.length >= 6, roleDetail.status)
const kenji = (snap.roster || []).find((member) => member.roleId === 'fe-developer')
const composed = await pageAction('memberPrompt', { memberId: kenji.id })
const promptText = composed.body.ok ? composed.body.value.prompt : ''
record('api/memberPrompt', 'memberPrompt composes playbook + persona + DoD', composed.body.ok === true && promptText.includes(kenji.persona) && promptText.includes('Definition of Done') && /Role playbook/i.test(promptText), composed.status)
const duplicate = await pageAction('createMember', { name: (snap.roster[0] || {}).name, roleId: 'tester' })
record('api/validation', 'duplicate roster name is rejected with member/name-taken', duplicate.status === 409 && duplicate.body.error.code === 'member/name-taken', `${duplicate.status} ${duplicate.body.error && duplicate.body.error.code}`)

try {
// ---------------------------------------------------------------------------
// 2. Team rail: fixed roster and attached-agent statuses
// ---------------------------------------------------------------------------

await clickIn('.kb-header', 'Team')
await app.waitFor(`!!document.querySelector('.kb-rail')`, 8000, 'team rail')
record('ui/railOpen', 'team rail opens', true)
const railText = await app.evaluate(`document.querySelector('.kb-rail') ? document.querySelector('.kb-rail').innerText : ''`)
record('ui/railRosterSection', 'rail renders the Members section', /Members/i.test(railText))
record('ui/railNoOtherAgents', 'rail has no Other agents section', !/Other agents/i.test(railText))
record('ui/railRolePlaybooks', 'rail exposes role playbooks', /Role playbooks/i.test(railText))
record('ui/railDraftButton', 'rail exposes Add with AI', /Add with AI/i.test(railText))
record('ui/railAddMember', 'rail exposes Add member', /Add member/i.test(railText))
const rowCount = await rosterRowCount()
record('ui/rosterRows', 'ten roster rows render', rowCount === 10, String(rowCount))
const visibleStatuses = await app.evaluate(
  `[...document.querySelectorAll('.kb-rosterRow')].map((row) => (row.querySelector('.kb-teamStatus,.kb-rosterStatus') || {}).innerText || '').filter(Boolean)`,
)
record('ui/statuses', 'each roster row renders a text status', visibleStatuses.length >= 10 && visibleStatuses.every((label) => label.trim().length > 0), visibleStatuses.slice(0, 10))
record('ui/statusesTruthful', 'no roster row claims the retired Working status', visibleStatuses.every((label) => !/^working$/i.test(label.trim())), visibleStatuses.slice(0, 10))
const railOverflow = await app.evaluate(`(() => { const rail = document.querySelector('.kb-rail'); return rail ? rail.scrollWidth - rail.clientWidth : -1; })()`)
record('ui/railNoOverflow', 'team rail never overflows horizontally', railOverflow <= 1, railOverflow)
await shot('team-rail-light')

// ---------------------------------------------------------------------------
// 3. Member editor: seeded persona + composed prompt preview
// ---------------------------------------------------------------------------

const editOpened = await app.evaluate(
  `(() => { const btn = document.querySelector('.kb-rosterRow button[aria-label^="Edit "]'); if (!btn) return false; btn.click(); return true; })()`,
  { userGesture: true },
)
await sleep(800)
record('ui/memberEditorOpen', 'member editor opens', editOpened === true)
await app.waitFor(`!!document.querySelector('.kb-drawer--member')`, 8000, 'member editor drawer')
const editor = await app.evaluate(`(() => {
  const drawer = document.querySelector('.kb-drawer--member');
  if (!drawer) return null;
  const name = drawer.querySelector('input[aria-label="Name"]');
  const title = drawer.querySelector('input[aria-label="Title"]');
  const role = drawer.querySelector('select[aria-label="Role"]');
  const persona = drawer.querySelector('textarea');
  const pre = drawer.querySelector('pre');
  return {
    name: name ? name.value : '',
    title: title ? title.value : '',
    role: role ? role.value : '',
    personaLength: persona ? persona.value.length : 0,
    personaWords: persona ? persona.value.trim().split(/\\s+/).filter(Boolean).length : 0,
    previewLength: pre ? pre.textContent.length : 0,
    previewHasDoD: pre ? /Definition of Done/i.test(pre.textContent) : false,
    roleOptions: role ? role.options.length : 0,
  };
})()`)
record('ui/editorFields', 'editor shows the seeded name/title/role/persona', Boolean(editor) && editor.name.length > 2 && editor.title.length > 2 && editor.role.length > 2 && editor.personaLength > 500 && editor.personaWords >= 100 && editor.personaWords <= 180, editor)
record('ui/editorRoleOptions', 'editor offers all ten roles', Boolean(editor) && editor.roleOptions === 10, editor && editor.roleOptions)
await app.waitFor(`(() => { const pre = document.querySelector('.kb-drawer--member pre'); return pre && pre.textContent.length > 400; })()`, 10000, 'composed prompt preview').catch(() => {})
const previewReady = await app.evaluate(`(() => { const pre = document.querySelector('.kb-drawer--member pre'); return pre ? { length: pre.textContent.length, hasDoD: /Definition of Done/i.test(pre.textContent), hasPersona: /You are/i.test(pre.textContent) } : null; })()`)
record('ui/editorPreview', 'editor previews the composed prompt from memberPrompt', Boolean(previewReady) && previewReady.length > 400 && previewReady.hasDoD && previewReady.hasPersona, previewReady)
await shot('member-editor')
await closeOverlays()
await sleep(400)

// ---------------------------------------------------------------------------
// 4. Create + delete a member through the UI (roster restored afterwards)
// ---------------------------------------------------------------------------

const probeName = 'Kaia Probe'
async function findMemberByName(name) {
  const state = await pageState()
  return (state.roster || []).find((member) => member.name === name) || null
}
await clickIn('.kb-rail', 'Add member')
await app.waitFor(`!!document.querySelector('.kb-drawer--member')`, 8000, 'new member drawer')
const newDrawer = await app.evaluate(`!!document.querySelector('.kb-drawer--member')`)
record('ui/addMemberOpens', 'Add member opens the editor', newDrawer === true)
await app.type(`document.querySelector('.kb-drawer--member input[aria-label="Name"]')`, probeName)
await app.type(`document.querySelector('.kb-drawer--member input[aria-label="Title"]')`, 'Probe Reliability Engineer')
await app.evaluate(`(() => { const select = document.querySelector('.kb-drawer--member select[aria-label="Role"]'); if (!select) return false; select.value = 'tester'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`, { userGesture: true })
await sleep(300)
await clickIn('.kb-drawer--member', 'Save member')
await sleep(1200)
let createdMember = null
for (let attempt = 0; attempt < 10; attempt += 1) {
  createdMember = await findMemberByName(probeName)
  if (createdMember) break
  await sleep(500)
}
record('ui/memberCreated', 'manual member is created from the editor', Boolean(createdMember) && createdMember.roleId === 'tester' && createdMember.source === 'manual', createdMember && { roleId: createdMember.roleId, source: createdMember.source })
const rowsAfterCreate = await rosterRowCount()
record('ui/rosterGrew', 'roster row appears after create', rowsAfterCreate === 11, String(rowsAfterCreate))
await shot('team-rail-after-create')
// Delete it again (restore the seeded roster).
if (createdMember) {
  await app.evaluate(
    `(() => { const btn = [...document.querySelectorAll('.kb-rosterRow button[aria-label^="Edit "]')].find((b) => (b.getAttribute('aria-label') || '').includes(${JSON.stringify(probeName)})); if (!btn) return false; btn.click(); return true; })()`,
    { userGesture: true },
  )
  await app.waitFor(`!!document.querySelector('.kb-drawer--member')`, 8000, 'edit probe member')
  await clickIn('.kb-drawer--member', 'Delete member')
  await clickIn('.kb-drawer--member', 'Confirm delete')
  await sleep(1200)
  const afterDelete = await findMemberByName(probeName)
  results.cleanup.push('deleted probe member from the UI')
  record('ui/memberDeleted', 'deleting the member restores the roster', afterDelete === null)
  await closeOverlays()
}
const finalRows = await rosterRowCount()
record('ui/rosterRestored', 'roster returns to ten rows', finalRows === 10, String(finalRows))

// ---------------------------------------------------------------------------
// 5. Role playbook viewer
// ---------------------------------------------------------------------------

await closeOverlays()
const rolesOpened = await clickIn('.kb-rail', 'Role playbooks')
record('ui/roleViewerOpen', 'Role playbooks opens the playbook viewer', rolesOpened === true)
await app.waitFor(`!!document.querySelector('.kb-drawer--roles')`, 8000, 'role viewer')
const roleButtons = await app.evaluate(`document.querySelectorAll('.kb-drawer--roles .kb-roleBtn').length`)
record('ui/roleViewerRoles', 'role viewer lists every catalog role', roleButtons === 10, String(roleButtons))
const bugClicked = await app.evaluate(
  `(() => { const btn = [...document.querySelectorAll('.kb-drawer--roles .kb-roleBtn')].find((b) => /Bug Fixer/i.test(b.textContent || '')); if (!btn) return false; btn.click(); return true; })()`,
  { userGesture: true },
)
await sleep(1000)
record('ui/roleViewerBugFixer', 'bug-fixer playbook can be selected', bugClicked === true)
await app.waitFor(`(() => { const detail = document.querySelector('.kb-drawer--roles .kb-rolesDetail'); return detail && /Intake/i.test(detail.textContent || '') && /Definition of Done/i.test(detail.textContent || ''); })()`, 10000, 'bug-fixer playbook detail').catch(() => {})
const roleDetailView = await app.evaluate(`(() => { const detail = document.querySelector('.kb-drawer--roles .kb-rolesDetail'); return detail ? { steps: detail.querySelectorAll('.kb-roleStep').length, hasDoD: /Definition of Done/i.test(detail.textContent || ''), hasGate: /gate/i.test(detail.textContent || '') } : null; })()`)
record('ui/roleViewerPlaybook', 'role viewer renders steps, gates and role DoD', Boolean(roleDetailView) && roleDetailView.steps === 11 && roleDetailView.hasDoD && roleDetailView.hasGate, roleDetailView)
await shot('role-playbooks')
await closeOverlays()
await sleep(400)

// ---------------------------------------------------------------------------
// 6. Add with AI: drafting row becomes a member (or template fallback)
// ---------------------------------------------------------------------------

await clickIn('.kb-rail', 'Add with AI')
await app.waitFor(`!!document.querySelector('.kb-aiForm')`, 8000, 'add-with-AI form')
await app.type(`document.querySelector('.kb-aiForm textarea')`, 'A migration-obsessed backend engineer who loves schema rollbacks')
const draftClicked = await app.evaluate(
  `(() => { const btn = [...document.querySelectorAll('.kb-aiForm button')].find((b) => /Draft/i.test(b.textContent || '')); if (!btn) return false; btn.click(); return true; })()`,
  { userGesture: true },
)
record('ui/draftSubmitted', 'Add with AI submits a draft', draftClicked === true)
let draftSeen = false
let aiMember = null
const aiDeadline = Date.now() + 180000
while (Date.now() < aiDeadline) {
  const state = await pageState()
  const drafting = (state.drafts || []).find((draft) => draft.status === 'drafting')
  const failedTemplate = (state.drafts || []).find((draft) => draft.mode === 'template')
  if (drafting && !draftSeen) {
    draftSeen = true
    record('ui/draftingRow', 'a Drafting row appears in the snapshot', true, drafting.id)
    await shot('drafting')
  }
  const candidates = (state.roster || []).filter(
    (member) => !snap.roster.some((seeded) => seeded.id === member.id) && !(createdMember && member.id === createdMember.id),
  )
  if (candidates.length > 0) {
    aiMember = candidates[0]
    break
  }
  if (failedTemplate) {
    record('ui/draftTemplateFallback', 'template fallback labelled in drafts', true)
    break
  }
  await sleep(2500)
}
record('ui/draftOutcome', 'drafting resolved into a team member', Boolean(aiMember), aiMember && { name: aiMember.name, roleId: aiMember.roleId, source: aiMember.source })
if (aiMember) {
  const state = await pageState()
  record('ui/aiMemberRole', 'AI member has a valid role and persona', Boolean(aiMember.roleId) && typeof aiMember.persona === 'string' && aiMember.persona.length > 300, { roleId: aiMember.roleId, personaLength: aiMember.persona.length })
  record('ui/aiDraftCleared', 'draft row clears after the member lands', (state.drafts || []).every((draft) => draft.status !== 'drafting'))
  await shot('team-rail-ai-member')
  // Clean up: remove the AI-created member so the project roster stays curated.
  const removed = await pageAction('deleteMember', { memberId: aiMember.id, force: true })
  record('ui/aiMemberCleanup', 'AI member can be removed after verification', removed.body.ok === true, removed.status)
  results.cleanup.push(`deleted AI-drafted member ${aiMember.name}`)
  await sleep(800)
} else {
  // Leave no stuck draft behind.
  const state = await pageState()
  for (const draft of state.drafts || []) {
    await pageAction('cancelDraft', { draftId: draft.id })
  }
  results.cleanup.push('cancelled unresolved drafts')
  await shot('drafting-timeout')
}

// ---------------------------------------------------------------------------
// 7. Responsive rail overlay + member editor at narrow panel widths
// ---------------------------------------------------------------------------

await setViewport(1024, 860)
await sleep(900)
const overlay1024 = await app.evaluate(`(() => { const rail = document.querySelector('.kb-rail'); if (!rail) return null; const style = getComputedStyle(rail); return { position: style.position, width: Math.round(rail.getBoundingClientRect().width) }; })()`)
record('responsive/railOverlay', 'rail becomes an overlay at 1024px panel width', Boolean(overlay1024) && overlay1024.position === 'absolute' && overlay1024.width <= 340, overlay1024)
const overflow1024 = await app.evaluate(`(() => { const root = document.querySelector('.kb-root'); return root ? root.scrollWidth - root.clientWidth : -1; })()`)
record('responsive/noHorizontalOverflow', 'panel does not overflow horizontally', overflow1024 <= 1, overflow1024)
await shot('team-rail-1024')
await clickIn('.kb-rail', 'Add member')
await app.waitFor(`!!document.querySelector('.kb-drawer--member')`, 8000, 'editor at 1024')
const drawerWidth = await app.evaluate(`(() => { const drawer = document.querySelector('.kb-drawer--member'); const root = document.querySelector('.kb-root'); if (!drawer || !root) return null; return { drawer: Math.round(drawer.getBoundingClientRect().width), root: Math.round(root.getBoundingClientRect().width) }; })()`)
record('responsive/editorClamped', 'member editor is clamped to the panel', Boolean(drawerWidth) && drawerWidth.drawer <= drawerWidth.root, drawerWidth)
await closeOverlays()
await setViewport(640, 860)
await sleep(900)
await clickIn('.kb-rail', 'Add member')
await app.waitFor(`!!document.querySelector('.kb-drawer--member')`, 8000, 'editor at 640')
const drawerWidth640 = await app.evaluate(`(() => { const drawer = document.querySelector('.kb-drawer--member'); const root = document.querySelector('.kb-root'); if (!drawer || !root) return null; return { drawer: Math.round(drawer.getBoundingClientRect().width), root: Math.round(root.getBoundingClientRect().width) }; })()`)
record('responsive/editorFullWidth', 'member editor goes full width at 640px', Boolean(drawerWidth640) && drawerWidth640.drawer === drawerWidth640.root, drawerWidth640)
await shot('member-editor-640')
await closeOverlays()
await setTheme('dark')
await sleep(700)
await shot('team-rail-dark')

// ---------------------------------------------------------------------------
// 8. Console / page error surface
// ---------------------------------------------------------------------------

const errors = await app.errors()
const relevantErrors = errors.filter(
  (entry) => !/favicon|developer logs|deepseek-account|account read failed/i.test(String(entry.text || '')),
)
record('console/clean', 'no client errors captured during the run', relevantErrors.length === 0, relevantErrors.slice(0, 5))

// ---------------------------------------------------------------------------
// 9. Restore the curated roster and write evidence (also on crash)
// ---------------------------------------------------------------------------
} catch (error) {
  record('probe/completed', 'probe executed every step without throwing', false, error && error.message ? error.message : String(error))
  console.error(error)
} finally {
  await cleanupProbe()
  const restoredState = await pageState().catch(() => null)
  const rosterCount = restoredState && Array.isArray(restoredState.roster) ? restoredState.roster.length : -1
  const draftCount = restoredState && Array.isArray(restoredState.drafts) ? restoredState.drafts.length : -1
  record('cleanup/rosterSeed', 'verification leaves the curated 10-member roster', rosterCount === 10 && draftCount === 0, { roster: rosterCount, drafts: draftCount })

  results.meta.finishedAt = new Date().toISOString()
  results.meta.failures = failures
  results.meta.checks = results.checks.length
  await writeFile(`${OUT}final-verification.json`, JSON.stringify(results, null, 2))
  console.log(`\n${failures === 0 ? 'ALL KB-13 PROBE CHECKS PASSED' : `${failures} FAILURE(S)`} — evidence: docs/screenshots/kb13/final-verification.json`)
  process.exit(failures === 0 ? 0 : 1)
}
