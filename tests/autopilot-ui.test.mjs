/**
 * KB-76 — autopilot UI control surface (client half).
 *
 * Dependency-free harness in the same style as `tests/client.test.mjs` and
 * `tests/voice.test.mjs`: the real `client.js` is materialized through the same
 * module loader the Web GUI uses, with a fake React (no DOM render needed), a
 * fake `localStorage`, and `__KB4_AUTOPILOT_UI_TEST__` set so the module exposes
 * its autopilot test seam. The seam contains only the pure state machine and the
 * projection helpers the component renders from — no host call is made here.
 *
 * Coverage map (ticket acceptance criteria):
 *   AC 1  configure round-trip: optimistic value, status response, persisted
 *         snapshot sync (refresh/project switch) and nested laneCaps merging
 *   AC 2  toggle state machine + the one-time phase-1 confirmation flag
 *   AC 3  dry-run preview projection: ordered dispatch rows then skip rows with
 *         ticket title, member name + role, lane and a localized reason; the
 *         empty plan shows "Nothing to do right now" with a reason summary
 *   AC 4  busy guard: a second pulse/start is a no-op, the button is disabled
 *         while a request is in flight, and the guard re-opens afterwards
 *   AC 5  paused/off states: status derivation and the pulse guard
 *   AC 6  aria-pressed toggle state, focus restore is the component's job (the
 *         reducer keeps the popover-independent state); locale parity below
 *   AC 8  every autopilot string exists in English and Chinese with matching keys
 *   AC 9  rollback: a failed configure restores the previous values and keeps the
 *         host error code; 409 autopilot/pulsing is explained, not a crash
 *   AC 10 deterministic: injected timers (no sleeps); the debounced configure
 *         queue merges rapid changes and fires exactly once
 */
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__KB4_AUTOPILOT_UI_TEST__ = true;

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const pluginSource = source;

// Fake browser surface: module loader, in-memory localStorage, inert document.
const storage = new Map();
let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
};
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
  activeElement: null,
};

await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

assert.ok(captured && captured.id === '@local/dsh-kanban', 'module loader entry registered');

const React = {
  Component: class Component {
    constructor(props) {
      this.props = props;
    }
  },
  createElement(type, props, ...children) {
    return { type, props: props || {}, children };
  },
  useState: () => {
    throw new Error('component render not expected in this test');
  },
  useEffect: () => {},
  useMemo: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
};
const plugin = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require ${name}`);
});
const autopilot = plugin.__autopilot;
assert.ok(autopilot, 'autopilot test seam is exposed when __KB4_AUTOPILOT_UI_TEST__ is set');

// Register the dictionaries exactly like the real host locale service does.
const localeDicts = {};
const ctx = {
  effect(fn) {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  locale: {
    register(namespace, dicts) {
      localeDicts[namespace] = dicts;
      return () => {};
    },
    bind() {
      return (key, params) => translate('en', key, params);
    },
  },
  uiWorkspace: { openSession: () => {} },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  slots: {
    inject(slot, callback) {
      return callback();
    },
    register() {
      return () => {};
    },
  },
};
plugin.apply(ctx);

const dictionaries = localeDicts.kanban;
assert.ok(dictionaries && dictionaries.en && dictionaries.zh, 'en and zh dictionaries registered');

/** Locale-service double: dictionary lookup + `{name}` interpolation, like the host. */
function translate(locale, key, params) {
  const dict = (dictionaries && dictionaries[locale]) || {};
  let value = typeof dict[key] === 'string' ? dict[key] : key;
  for (const [name, replacement] of Object.entries(params || {})) value = value.split(`{${name}}`).join(String(replacement));
  return value;
}
const t = (key, params) => translate('en', key, params);
const tzh = (key, params) => translate('zh', key, params);

const clone = (value) => JSON.parse(JSON.stringify(value));

/** Injected timers: deterministic, advanceable, no real waiting. */
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + Math.max(0, ms || 0) });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      now += Math.max(0, ms || 0);
      for (const [id, item] of Array.from(timers.entries())) {
        if (item.at > now) continue;
        timers.delete(id);
        item.fn();
      }
    },
    pending: () => timers.size,
  };
}

const AUTO_ON = {
  enabled: true,
  cadenceMs: 300000,
  maxReadyDepth: 3,
  laneCaps: { refine: 1, implement: 1, review: 1 },
  maxDispatchesPerPulse: 1,
  budget: { hour: 20, day: 60 },
  backoffMs: 300000,
  staleMs: 600000,
};

function snapshotWith(overrides = {}) {
  const boardTickets = overrides.tickets || [];
  const boardMembers = overrides.boardMembers || [];
  return {
    workspaceId: 'ws-1',
    now: overrides.now,
    board: {
      paused: overrides.boardPaused === true,
      tickets: boardTickets,
      team: boardMembers.length > 0 ? { members: boardMembers } : undefined,
      autopilot:
        overrides.envelope ||
        {
          ...clone(AUTO_ON),
          budget: { hour: { limit: 20, used: 3, windowStart: 1_800_000_000_000 }, day: { limit: 60, used: 5, windowStart: 1_800_000_000_000 } },
        },
      pulses: overrides.pulses || [],
    },
    autopilot:
      overrides.runtime === null
        ? null
        : {
            config: clone(overrides.config || AUTO_ON),
            nextTickAt: overrides.nextTickAt === undefined ? 1_800_300_000_000 : overrides.nextTickAt,
            lastPulse: null,
            pulseCount: 0,
            budgetRemaining: {
              hour: { limit: 20, used: 3, remaining: 17, resetsAt: 1_800_100_000_000 },
              day: { limit: 60, used: 5, remaining: 55, resetsAt: 1_800_300_000_000 },
            },
          },
    roster: overrides.roster || [],
  };
}

const TICKETS = [
  { id: 'KB-1', title: 'Fix the header control', column: 'ready' },
  { id: 'KB-2', title: 'Add the preview panel', column: 'backlog' },
  { id: 'KB-3', title: 'Review the pulse feed', column: 'review' },
];
const ROSTER = [
  { id: 'member-fe', name: 'Sherif Shawarma', roleId: 'fe-developer' },
  { id: 'member-reviewer', name: 'Ashraf Ahwa', roleId: 'reviewer' },
];
const PLAN = {
  generatedAt: 1_800_000_000_000,
  decisions: [
    {
      order: 1,
      action: 'dispatch',
      reason: 'admitted',
      group: 'implement',
      lane: 'implement',
      ticketId: 'KB-1',
      ticketColumn: 'ready',
      role: 'fe-developer',
      memberId: 'member-fe',
      memberName: 'Sherif Shawarma',
      mode: 'start',
      detail: 'KB-1 pulled by the implement lane.',
    },
  ],
  skips: [
    {
      action: 'skip',
      reason: 'ready-depth',
      group: 'refine',
      lane: 'refine',
      ticketId: 'KB-2',
      memberId: null,
      detail: 'Ready depth is at the ceiling.',
    },
    {
      action: 'skip',
      reason: 'blocked',
      group: 'review',
      lane: 'review',
      ticketId: 'KB-3',
      memberId: 'member-reviewer',
      detail: 'The ticket is blocked.',
    },
  ],
};

// ---------------------------------------------------------------------------
// AC 8 — locale parity and key coverage
// ---------------------------------------------------------------------------

test('AC8 locale parity: every autopilot key exists in en and zh', () => {
  const enKeys = Object.keys(dictionaries.en).filter((key) => key.startsWith('autopilot.'));
  const zhKeys = Object.keys(dictionaries.zh).filter((key) => key.startsWith('autopilot.'));
  assert.ok(enKeys.length > 40, `expected a full autopilot dictionary, got ${enKeys.length}`);
  assert.deepEqual(zhKeys.sort(), enKeys.sort(), 'zh autopilot keys must match en exactly');
  for (const key of enKeys) {
    assert.equal(typeof dictionaries.zh[key], 'string');
    assert.ok(dictionaries.zh[key].trim().length > 0, `zh value for ${key} is empty`);
    assert.ok(dictionaries.en[key].trim().length > 0, `en value for ${key} is empty`);
  }
});

test('AC8 every reason code, lane and state has a localized label', () => {
  for (const code of autopilot.AUTOPILOT_REASON_CODES) {
    const en = autopilot.autopilotReasonLabel(code, t);
    const zh = autopilot.autopilotReasonLabel(code, tzh);
    assert.notEqual(en, `autopilot.reason.${code}`, `missing en reason label for ${code}`);
    assert.notEqual(zh, `autopilot.reason.${code}`, `missing zh reason label for ${code}`);
    assert.ok(zh.length > 0);
  }
  assert.notEqual(autopilot.autopilotReasonLabel('a-new-code', t), 'autopilot.reasonUnknown');
  assert.match(autopilot.autopilotReasonLabel('a-new-code', t), /a-new-code/);
  for (const lane of autopilot.AUTOPILOT_LANES) {
    assert.notEqual(t(`autopilot.lane.${lane}`), `autopilot.lane.${lane}`);
    assert.notEqual(tzh(`autopilot.lane.${lane}`), `autopilot.lane.${lane}`);
  }
  for (const state of ['on', 'off', 'paused', 'unavailable']) {
    assert.notEqual(t(`autopilot.state.${state}`), `autopilot.state.${state}`);
    assert.notEqual(tzh(`autopilot.state.${state}`), `autopilot.state.${state}`);
  }
});

test('AC8 every autopilot key referenced by the client source is in both dictionaries', () => {
  const literalKeys = new Set();
  const pattern = /t\('(autopilot\.[a-zA-Z0-9.-]+)'/g;
  let match = pattern.exec(pluginSource);
  while (match) {
    literalKeys.add(match[1]);
    match = pattern.exec(pluginSource);
  }
  // Dynamic key families the component builds with a variable suffix.
  for (const state of ['on', 'off', 'paused', 'unavailable']) literalKeys.add(`autopilot.state.${state}`);
  for (const lane of autopilot.AUTOPILOT_LANES) literalKeys.add(`autopilot.lane.${lane}`);
  for (const code of autopilot.AUTOPILOT_REASON_CODES) literalKeys.add(`autopilot.reason.${code}`);
  // KB-77 dynamic families: trigger labels, lane admission states and the alert
  // reason labels all share a prefix with a runtime suffix.
  for (const trigger of autopilot.AUTOPILOT_TRIGGERS) literalKeys.add(`autopilot.trigger.${trigger}`);
  for (const state of ['busy', 'idle', 'paused']) literalKeys.add(`autopilot.laneAdmission.${state}`);
  for (const action of ['dispatch', 'skip']) literalKeys.add(`autopilot.action.${action}`);
  for (const code of autopilot.AUTOPILOT_ALERT_REASONS) {
    assert.equal(typeof dictionaries.en[`autopilot.reason.${code}`], 'string', `missing en alert reason ${code}`);
    assert.equal(typeof dictionaries.zh[`autopilot.reason.${code}`], 'string', `missing zh alert reason ${code}`);
  }
  assert.ok(literalKeys.size > 40, `unexpectedly small key set (${literalKeys.size})`);
  for (const key of literalKeys) {
    if (/^(autopilot\.(reason|state|lane|trigger|laneAdmission|action))\.$/.test(key)) continue;
    assert.equal(typeof dictionaries.en[key], 'string', `missing en key ${key}`);
    assert.equal(typeof dictionaries.zh[key], 'string', `missing zh key ${key}`);
  }
});

// ---------------------------------------------------------------------------
// AC 1 / AC 9 — configure round-trip, snapshot sync, optimistic rollback
// ---------------------------------------------------------------------------

test('AC1 configure round-trip keeps the optimistic value until the host answers', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, {
    type: 'sync',
    available: true,
    config: clone(AUTO_ON),
    pauseCause: null,
    membersPaused: false,
    budget: { hour: { used: 3, limit: 20, remaining: 17 }, day: { used: 5, limit: 60, remaining: 55 } },
  });
  assert.equal(autopilot.autopilotStateLabel(state), 'on');
  assert.equal(state.values.cadenceMs, 300000);

  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { cadenceMs: 900000 } });
  assert.equal(state.values.cadenceMs, 900000, 'optimistic value renders immediately');
  assert.equal(state.dirty, true);

  state = autopilot.reduceAutopilot(state, { type: 'configure/send', seq: 1 });
  assert.equal(state.busy, 'configure');
  assert.equal(state.seq, 1);

  const status = { config: { ...clone(AUTO_ON), cadenceMs: 900000 } };
  state = autopilot.reduceAutopilot(state, { type: 'configure/ok', seq: 1, config: autopilot.autopilotConfigFromStatus(status) });
  assert.equal(state.busy, null);
  assert.equal(state.dirty, false);
  assert.equal(state.values.cadenceMs, 900000);
  assert.equal(state.confirmed.cadenceMs, 900000);
  assert.equal(autopilot.autopilotStateLabel(state), 'on');
});

test('AC1/AC2 nested laneCaps patches merge and disabling flips the toggle state', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { laneCaps: { implement: 0 } } });
  assert.deepEqual(state.values.laneCaps, { refine: 1, implement: 0, review: 1 }, 'nested patch keeps sibling lanes');
  assert.equal(state.values.enabled, true);

  state = autopilot.reduceAutopilot(state, { type: 'configure/send', seq: 1 });
  state = autopilot.reduceAutopilot(state, {
    type: 'configure/ok',
    seq: 1,
    config: autopilot.autopilotConfigFromStatus({ config: { ...clone(AUTO_ON), laneCaps: { refine: 1, implement: 0, review: 1 } } }),
  });
  // Master stop: optimistic off renders the explicit off state before the host answers.
  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { enabled: false } });
  assert.equal(state.values.enabled, false);
  assert.equal(autopilot.autopilotStateLabel(state), 'off');
});

test('AC1 a poll sync never overwrites an unacknowledged optimistic edit', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { maxReadyDepth: 7 } });
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  assert.equal(state.values.maxReadyDepth, 7, 'optimistic edit survives the poll');
  assert.equal(state.confirmed.maxReadyDepth, 3, 'rollback target tracks the host value');
});

test('AC1 a project switch resets every surface', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  state = autopilot.reduceAutopilot(state, { type: 'preview/ok', plan: clone(PLAN), at: 1 });
  state = autopilot.reduceAutopilot(state, { type: 'phase1/show' });
  state = autopilot.reduceAutopilot(state, { type: 'reset', workspaceId: 'ws-2' });
  assert.equal(state.workspaceId, 'ws-2');
  assert.equal(state.preview, null);
  assert.equal(state.phase1, false);
  assert.equal(state.values, null);
});

test('AC9 a failed configure rolls the optimistic value back and keeps the host code', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  state = autopilot.reduceAutopilot(state, { type: 'preview/ok', plan: clone(PLAN), at: 1 });
  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { laneCaps: { implement: 0 } } });
  state = autopilot.reduceAutopilot(state, { type: 'configure/send', seq: 1 });
  state = autopilot.reduceAutopilot(state, {
    type: 'configure/fail',
    seq: 1,
    error: { code: 'autopilot/invalid', message: 'laneCaps.implement must be between 0 and 3.' },
  });
  assert.equal(state.busy, null);
  assert.equal(state.dirty, false);
  assert.deepEqual(state.values.laneCaps, { refine: 1, implement: 1, review: 1 }, 'previous values restored');
  assert.equal(state.error.code, 'autopilot/invalid');
  assert.equal(state.preview, null, 'a stale preview is dropped after a failed configure');
  assert.equal(autopilot.autopilotErrorText(state.error, t), dictionaries.en['autopilot.errorInvalid']);
  state = autopilot.reduceAutopilot(state, { type: 'error/dismiss' });
  assert.equal(state.error, null);
});

test('AC9 a stale response (older seq) cannot change newer UI state', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { cadenceMs: 600000 } });
  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { cadenceMs: 900000 } });
  state = autopilot.reduceAutopilot(state, { type: 'configure/send', seq: 2 });
  const afterSecondSend = state;
  state = autopilot.reduceAutopilot(state, { type: 'configure/ok', seq: 1, config: autopilot.normalizeAutopilotConfig(AUTO_ON) });
  assert.equal(state, afterSecondSend, 'stale ok is ignored');
  state = autopilot.reduceAutopilot(state, { type: 'configure/ok', seq: 2, config: autopilot.normalizeAutopilotConfig({ ...AUTO_ON, cadenceMs: 900000 }) });
  assert.equal(state.values.cadenceMs, 900000);
});

// ---------------------------------------------------------------------------
// AC 2 — toggle and the one-time phase-1 confirmation
// ---------------------------------------------------------------------------

test('AC2 the phase-1 confirmation is shown once per browser', () => {
  storage.clear();
  assert.equal(autopilot.readAutopilotConfirmSeen(), false);
  let state = autopilot.initialAutopilotUi('ws-1');
  assert.equal(state.phase1, false);
  state = autopilot.reduceAutopilot(state, { type: 'phase1/show' });
  assert.equal(state.phase1, true, 'turning autopilot on requests the one-time confirmation');
  autopilot.markAutopilotConfirmSeen();
  assert.equal(autopilot.readAutopilotConfirmSeen(), true);
  state = autopilot.reduceAutopilot(state, { type: 'phase1/dismiss' });
  assert.equal(state.phase1, false);
  assert.equal(storage.get(autopilot.AUTOPILOT_CONFIRM_KEY), '1', 'dismissal is persisted');
});

test('AC2 the toggle exposes its pressed state and the off state is explicit', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  assert.equal(state.values.enabled, true, 'toggle aria-pressed=true source');
  assert.equal(autopilot.canPreviewAutopilot(state), true);
  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { enabled: false } });
  assert.equal(state.values.enabled, false, 'toggle aria-pressed=false source');
  assert.match(t('autopilot.offNote'), /running sessions continue|cancelled/i);
  // AC 5: a disabled autopilot hides preview and Pulse now behind the toggle
  // instead of presenting controls whose only outcome is a no-op.
  assert.equal(autopilot.canPreviewAutopilot(state), false, 'off hides the preview control');
  assert.equal(autopilot.canPulseAutopilot(state), false, 'off hides Pulse now');
  state = autopilot.reduceAutopilot(state, { type: 'configure/optimistic', patch: { enabled: true } });
  assert.equal(autopilot.canPreviewAutopilot(state), true, 'preview returns with the toggle');
});

// ---------------------------------------------------------------------------
// AC 4 / AC 5 / AC 9 — pulse busy guard, paused state, 409 explanation
// ---------------------------------------------------------------------------

test('AC4/AC5 pulse-now guard: off, paused and busy each refuse to start', () => {
  const base = () => {
    let state = autopilot.initialAutopilotUi('ws-1');
    state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
    return state;
  };
  assert.equal(autopilot.canPulseAutopilot(base()), true);
  assert.equal(autopilot.canPulseAutopilot({ ...base(), values: { ...clone(AUTO_ON), enabled: false } }), false, 'off disables');
  assert.equal(autopilot.canPulseAutopilot({ ...base(), paused: true, pauseCause: 'board' }), false, 'paused board disables');

  let state = autopilot.reduceAutopilot(base(), { type: 'pulse/start' });
  assert.equal(state.busy, 'pulse', 'busy state renders');
  assert.equal(autopilot.canPulseAutopilot(state), false, 'button disabled while running');
  const during = state;
  state = autopilot.reduceAutopilot(state, { type: 'pulse/start' });
  assert.equal(state, during, 'a second pulse/start is a no-op (cannot double-fire)');
  state = autopilot.reduceAutopilot(state, { type: 'pulse/ok', pulse: { id: 'PL-7', trigger: 'manual' } });
  assert.equal(state.busy, null);
  assert.equal(autopilot.canPulseAutopilot(state), true);
  assert.equal(state.pulse.id, 'PL-7');
});

test('AC4 preview and pulse are mutually exclusive while a request is in flight', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  state = autopilot.reduceAutopilot(state, { type: 'preview/start' });
  assert.equal(autopilot.canPulseAutopilot(state), false, 'pulse disabled while previewing');
  assert.equal(autopilot.canPreviewAutopilot(state), false, 'preview cannot double-fire');
  state = autopilot.reduceAutopilot(state, { type: 'preview/fail', error: { code: 'network', message: 'offline' } });
  assert.equal(state.busy, null);
  assert.equal(autopilot.canPulseAutopilot(state), true);
});

test('AC9 a 409 autopilot/pulsing is explained inline, not treated as a crash', () => {
  let state = autopilot.initialAutopilotUi('ws-1');
  state = autopilot.reduceAutopilot(state, { type: 'sync', available: true, config: clone(AUTO_ON), pauseCause: null });
  state = autopilot.reduceAutopilot(state, { type: 'pulse/start' });
  state = autopilot.reduceAutopilot(state, {
    type: 'pulse/fail',
    error: { code: 'autopilot/pulsing', message: 'A pulse is already running for this project. Retry when it finishes.' },
  });
  assert.equal(state.busy, null);
  assert.equal(state.error.code, 'autopilot/pulsing');
  assert.equal(autopilot.autopilotErrorText(state.error, t), dictionaries.en['autopilot.errorPulsing']);
  assert.equal(autopilot.autopilotErrorText({ code: 'autopilot/budget', message: '' }, t), dictionaries.en['autopilot.errorBudget']);
});

test('AC5 paused cause is derived from the board first, then from the roster', () => {
  const boardPaused = snapshotWith({ boardPaused: true });
  assert.equal(autopilot.autopilotPauseCause(boardPaused), 'board');
  const memberPaused = snapshotWith({ roster: [{ id: 'm1', name: 'A', paused: true }, { id: 'm2', name: 'B', paused: true }] });
  assert.equal(autopilot.autopilotPauseCause(memberPaused), 'member');
  const active = snapshotWith({ roster: [{ id: 'm1', name: 'A', paused: false }] });
  assert.equal(autopilot.autopilotPauseCause(active), null);
  assert.equal(autopilot.autopilotPauseCause({ board: null, roster: [] }), null);
});

// ---------------------------------------------------------------------------
// AC 1 — snapshot read model (refresh / older host compatibility)
// ---------------------------------------------------------------------------

test('AC1 the view survives refresh from the snapshot read model and the persisted envelope', () => {
  const view = autopilot.autopilotViewFromSnapshot(snapshotWith());
  assert.equal(view.available, true);
  assert.equal(view.config.cadenceMs, 300000);
  assert.equal(view.budget.hour.remaining, 17);
  assert.equal(view.budget.day.remaining, 55);
  assert.equal(view.nextTickAt, 1_800_300_000_000);
  assert.deepEqual(autopilot.autopilotBudgetRows(view.budget, t), [
    dictionaries.en['autopilot.budgetHour'].replace('{remaining}', '17').replace('{limit}', '20'),
    dictionaries.en['autopilot.budgetDay'].replace('{remaining}', '55').replace('{limit}', '60'),
  ]);

  // An older host that has the persisted envelope but no derived read model.
  const envelopeOnly = snapshotWith({ runtime: null });
  const fallback = autopilot.autopilotViewFromSnapshot(envelopeOnly);
  assert.equal(fallback.available, true);
  assert.equal(fallback.config.enabled, true);
  assert.equal(fallback.budget.hour.remaining, 17, 'persisted counters drive the fallback budget read-out');
});

test('AC1 a host without any autopilot data renders the explicit unavailable state', () => {
  const view = autopilot.autopilotViewFromSnapshot({ workspaceId: 'ws-1', board: { tickets: [], pulses: [] }, roster: [] });
  assert.equal(view.available, false);
  const state = autopilot.reduceAutopilot(autopilot.initialAutopilotUi('ws-1'), {
    type: 'sync',
    available: view.available,
    config: view.config,
    pauseCause: view.pauseCause,
    membersPaused: view.membersPaused,
    budget: view.budget,
  });
  assert.equal(autopilot.autopilotStateLabel(state), 'unavailable');
  assert.equal(autopilot.canPulseAutopilot(state), false);
  assert.equal(autopilot.canPreviewAutopilot(state), false);
});

// ---------------------------------------------------------------------------
// AC 3 — dry-run projection and empty-plan reason summary
// ---------------------------------------------------------------------------

test('AC3 preview projects an ordered list with ticket, member, role, lane and reason', () => {
  const plan = clone(PLAN);
  const before = JSON.stringify(plan);
  const model = autopilot.buildAutopilotPreview(plan, TICKETS, ROSTER, t, (roleId) => t(`role.${roleId}`));
  assert.equal(model.empty, false);
  assert.equal(model.dispatchCount, 1);
  assert.equal(model.skipCount, 2);
  assert.equal(model.rows.length, 3);
  assert.deepEqual(model.rows.map((row) => row.kind), ['dispatch', 'skip', 'skip']);
  assert.deepEqual(model.rows.map((row) => row.ordinal), [1, 2, 3]);

  const dispatch = model.rows[0];
  assert.equal(dispatch.ticketId, 'KB-1');
  assert.equal(dispatch.title, 'Fix the header control');
  assert.equal(dispatch.memberName, 'Sherif Shawarma');
  assert.equal(dispatch.memberRole, dictionaries.en['role.fe-developer']);
  assert.equal(dispatch.lane, 'implement');
  assert.equal(dispatch.laneLabel, dictionaries.en['autopilot.lane.implement']);
  assert.equal(dispatch.reasonCode, 'admitted');
  assert.equal(dispatch.reason, dictionaries.en['autopilot.reason.admitted']);
  assert.equal(dispatch.detail, 'KB-1 pulled by the implement lane.');

  const skip = model.rows[1];
  assert.equal(skip.title, 'Add the preview panel');
  assert.equal(skip.laneLabel, dictionaries.en['autopilot.lane.refine']);
  assert.equal(skip.reason, dictionaries.en['autopilot.reason.ready-depth']);
  assert.equal(model.rows[2].memberName, 'Ashraf Ahwa', 'skip rows join the roster by memberId');

  assert.equal(JSON.stringify(plan), before, 'projection never mutates the plan');
});

test('AC3 an empty plan says "Nothing to do right now" with a reason summary', () => {
  const plan = { generatedAt: 5, decisions: [], skips: clone(PLAN.skips) };
  const model = autopilot.buildAutopilotPreview(plan, TICKETS, ROSTER, t, (roleId) => t(`role.${roleId}`));
  assert.equal(model.empty, true);
  assert.equal(model.dispatchCount, 0);
  assert.equal(model.rows.length, 2);
  assert.equal(model.rows[0].kind, 'skip', 'the ordered skip list is still rendered with the empty state');
  assert.match(dictionaries.en['autopilot.previewEmptyTitle'], /Nothing to do right now/);
  assert.ok(model.summary.length >= 2, 'summary counts every skip reason');
  assert.ok(model.summary.every((item) => item.count === 1));
  assert.ok(model.summaryText.includes(dictionaries.en['autopilot.reason.ready-depth']));
  assert.ok(model.summaryText.includes('×1'), 'summary shows the count');
  // The empty body interpolates the summary through the locale helper.
  const body = t('autopilot.previewEmptyBody', { summary: model.summaryText });
  assert.ok(body.includes(model.summaryText));
});

test('AC3 the ordered dispatch rows follow the plan order even when the array is unordered', () => {
  const plan = clone(PLAN);
  plan.decisions = [
    { ...clone(PLAN.decisions[0]), order: 2, ticketId: 'KB-3', memberName: 'B' },
    { ...clone(PLAN.decisions[0]), order: 1, ticketId: 'KB-1', memberName: 'A' },
  ];
  const model = autopilot.buildAutopilotPreview(plan, TICKETS, ROSTER, t, (roleId) => roleId);
  assert.deepEqual(model.rows.slice(0, 2).map((row) => row.ticketId), ['KB-1', 'KB-3']);
});

// ---------------------------------------------------------------------------
// AC 10 — fake timers: debounced configure queue
// ---------------------------------------------------------------------------

test('AC10 rapid configure changes merge into one debounced request (fake timers)', () => {
  const timers = createFakeTimers();
  const sent = [];
  const queue = autopilot.createAutopilotCommitQueue(timers, 220, (patch) => sent.push(patch));
  queue.push({ cadenceMs: 600000 });
  queue.push({ laneCaps: { implement: 0 } });
  assert.equal(timers.pending(), 1, 'one pending timer, not one per change');
  assert.equal(sent.length, 0, 'nothing is sent before the delay');

  timers.advance(219);
  assert.equal(sent.length, 0);
  timers.advance(1);
  assert.equal(sent.length, 1, 'exactly one request after the debounce window');
  assert.deepEqual(sent[0], { cadenceMs: 600000, laneCaps: { implement: 0 } });
  assert.equal(timers.pending(), 0);
});

test('AC10 the queue can be cancelled and flushed immediately for the master stop', () => {
  const timers = createFakeTimers();
  const sent = [];
  const queue = autopilot.createAutopilotCommitQueue(timers, 220, (patch) => sent.push(patch));
  queue.push({ maxReadyDepth: 9 });
  queue.cancel();
  timers.advance(500);
  assert.equal(sent.length, 0, 'cancelled work is dropped');

  queue.push({ enabled: false });
  queue.flushNow();
  assert.equal(sent.length, 1, 'the off switch bypasses the debounce');
  assert.deepEqual(sent[0], { enabled: false });
  timers.advance(500);
  assert.equal(sent.length, 1, 'no duplicate send after flushNow');
});

test('AC10 lane caps merge instead of replacing the sibling lanes', () => {
  const merged = autopilot.mergeAutopilotPatch({ laneCaps: { implement: 0 } }, { laneCaps: { review: 2 } });
  assert.deepEqual(merged, { laneCaps: { implement: 0, review: 2 } });
  const applied = autopilot.applyAutopilotPatch(clone(AUTO_ON), merged);
  assert.deepEqual(applied.laneCaps, { refine: 1, implement: 0, review: 2 });
});

// ---------------------------------------------------------------------------
// Constants the UI renders from
// ---------------------------------------------------------------------------

test('AC1/AC7 the controls expose exactly the ticket bounds', () => {
  assert.deepEqual(autopilot.AUTOPILOT_CADENCE_MINUTES, [5, 10, 15, 30, 60]);
  assert.deepEqual(autopilot.AUTOPILOT_LANE_CAP_OPTIONS, [0, 1, 2, 3]);
  assert.equal(autopilot.AUTOPILOT_DEPTH_OPTIONS[0], 0);
  assert.equal(autopilot.AUTOPILOT_DEPTH_OPTIONS[autopilot.AUTOPILOT_DEPTH_OPTIONS.length - 1], 20);
  assert.equal(autopilot.AUTOPILOT_DEPTH_OPTIONS.length, 21);
});

// ===========================================================================
// KB-77 — pulse feed, lane admission, member autopilot state, countdown and
// deduplicated alerts (observability surface)
// ===========================================================================

const PULSE_ROOT = 1_800_000_000_000;
const CLOCK = { locale: 'en-GB', timeZone: 'UTC' };

/** Real-shape pulse records (index.js normalizePulse output, KB-70/KB-71). */
const PULSE_FEED = [
  {
    id: 'PL-12',
    at: PULSE_ROOT + 240_000,
    trigger: 'timer',
    durationMs: 1450,
    error: '',
    decisions: [
      {
        order: 1,
        action: 'dispatch',
        reason: 'admitted',
        group: 'implement',
        lane: 'implement',
        ticketId: 'KB-1',
        memberId: 'member-fe',
        memberName: 'Sherif Shawarma',
        detail: 'KB-1 pulled by the implement lane.',
      },
      {
        order: 2,
        action: 'skip',
        reason: 'lane-cap',
        group: 'review',
        lane: 'review',
        ticketId: 'KB-3',
        memberId: 'member-reviewer',
        detail: 'Review lane is at its concurrency cap.',
      },
      {
        order: 3,
        action: 'skip',
        reason: 'ready-depth',
        group: 'refine',
        lane: 'refine',
        ticketId: 'KB-2',
        memberId: null,
        detail: 'Ready depth is at the ceiling.',
      },
    ],
    dispatched: [{ ticketId: 'KB-1', memberId: 'member-fe', sessionId: 'sess-1' }],
  },
  {
    id: 'PL-11',
    at: PULSE_ROOT + 180_000,
    trigger: 'manual',
    durationMs: 380,
    error: '',
    decisions: [
      { order: 1, action: 'skip', reason: 'postcondition-failed', lane: 'implement', ticketId: 'KB-2', memberId: 'member-fe', detail: 'Last dispatch missed its target.' },
      { order: 2, action: 'skip', reason: 'loop-guard', lane: 'implement', ticketId: 'KB-2', memberId: 'member-fe', detail: 'Three consecutive failures.' },
    ],
    dispatched: [],
  },
  {
    id: 'PL-10',
    at: PULSE_ROOT + 120_000,
    trigger: 'resume',
    durationMs: 20,
    error: 'session start failed',
    decisions: [],
    dispatched: [],
  },
  {
    id: 'PL-9',
    at: PULSE_ROOT + 60_000,
    trigger: 'restart',
    error: '',
    decisions: [{ order: 1, action: 'skip', reason: 'budget-exhausted', lane: null, ticketId: null, memberId: null, detail: 'Hour budget used up.' }],
    dispatched: [],
  },
  {
    id: 'PL-8',
    at: PULSE_ROOT + 10_000,
    trigger: 'timer',
    durationMs: 5000,
    error: '',
    decisions: [{ order: 1, action: 'dispatch', reason: 'admitted', lane: 'implement', ticketId: 'KB-2', memberId: 'member-fe', detail: 'KB-2 pulled.' }],
    // The dispatch-time skip: `dispatched` is the authoritative ledger.
    dispatched: [],
  },
];

// ---------------------------------------------------------------------------
// AC 1 — pulse feed projection
// ---------------------------------------------------------------------------

test('KB-77 AC1 the feed lists newest-first with trigger, local time, duration and counts', () => {
  const feed = autopilot.buildAutopilotFeed(PULSE_FEED, TICKETS, ROSTER, t, (roleId) => t(`role.${roleId}`), CLOCK);
  assert.equal(feed.rows.length, 5);
  assert.deepEqual(feed.rows.map((row) => row.id), ['PL-12', 'PL-11', 'PL-10', 'PL-9', 'PL-8'], 'newest first');
  const newest = feed.rows[0];
  assert.equal(newest.trigger, 'timer');
  assert.equal(newest.triggerLabel, dictionaries.en['autopilot.trigger.timer']);
  assert.match(newest.time, /^\d{2}:\d{2}:\d{2}$/, 'local HH:mm:ss');
  assert.notEqual(newest.time, feed.rows[1].time, 'each pulse keeps its own local time');
  assert.equal(newest.durationText, '1.5s');
  assert.equal(newest.dispatchedCount, 1, 'dispatched count comes from the dispatch ledger');
  assert.equal(newest.skippedCount, 2, 'skip count comes from the decision rows');
  assert.equal(newest.hasError, false);

  const resume = feed.rows.find((row) => row.id === 'PL-10');
  assert.equal(resume.triggerLabel, dictionaries.en['autopilot.trigger.resume']);
  assert.equal(resume.durationText, '20 ms');
  assert.equal(resume.hasError, true, 'a pulse-level error is an error marker');
  assert.equal(resume.errorLabel, dictionaries.en['autopilot.feedErrorMarker']);
  assert.equal(feed.rows.find((row) => row.id === 'PL-9').durationText, dictionaries.en['autopilot.feedDurationUnknown']);
});

test('KB-77 AC1 the feed is capped at the newest 20 pulses', () => {
  const many = [];
  for (let index = 0; index < 25; index += 1) {
    many.push({ id: `PL-${index + 1}`, at: PULSE_ROOT + index * 1000, trigger: 'timer', decisions: [], dispatched: [], error: '' });
  }
  const feed = autopilot.buildAutopilotFeed(many, [], [], t, null, CLOCK);
  assert.equal(feed.rows.length, autopilot.AUTOPILOT_FEED_MAX);
  assert.equal(feed.rows.length, 20);
  assert.equal(feed.rows[0].id, 'PL-25');
  assert.equal(feed.rows[19].id, 'PL-6');
  const times = feed.rows.map((row) => row.at);
  assert.deepEqual(times, times.slice().sort((left, right) => right - left), 'strictly newest-first');
});

test('KB-77 AC1 selecting a pulse joins ticket, member, lane, action and localized reason', () => {
  const feed = autopilot.buildAutopilotFeed(PULSE_FEED, TICKETS, ROSTER, t, (roleId) => t(`role.${roleId}`), CLOCK);
  const newest = feed.rows[0];
  assert.equal(newest.decisions.length, 3);
  const [dispatch, laneCap, readyDepth] = newest.decisions;
  assert.equal(dispatch.actionLabel, dictionaries.en['autopilot.action.dispatch']);
  assert.equal(dispatch.reason, dictionaries.en['autopilot.reason.admitted']);
  assert.equal(dispatch.ticketTitle, 'Fix the header control', 'ticket title joins the live board');
  assert.equal(dispatch.memberName, 'Sherif Shawarma');
  assert.equal(dispatch.memberRole, dictionaries.en['role.fe-developer']);
  assert.equal(dispatch.laneLabel, dictionaries.en['autopilot.lane.implement']);
  assert.equal(dispatch.notExecuted, false, 'a dispatched admitted row did start a session');
  assert.equal(laneCap.actionLabel, dictionaries.en['autopilot.action.skip']);
  assert.equal(laneCap.reason, dictionaries.en['autopilot.reason.lane-cap']);
  assert.equal(laneCap.laneLabel, dictionaries.en['autopilot.lane.review']);
  assert.equal(readyDepth.reason, dictionaries.en['autopilot.reason.ready-depth']);
  assert.equal(readyDepth.memberName, '', 'a board/lane row with no member stays empty');

  assert.equal(newest.executed.length, 1, 'the authoritative dispatched ledger is rendered');
  assert.equal(newest.executed[0].ticketId, 'KB-1');
  assert.equal(newest.executed[0].memberName, 'Sherif Shawarma');

  // KB-70 P3-1: an `admitted` decision contradicted by a dispatch-time skip must
  // be marked instead of rendering a session that never started.
  const contradicted = feed.rows.find((row) => row.id === 'PL-8');
  assert.equal(contradicted.decisions[0].notExecuted, true);
  assert.match(contradicted.decisions[0].notExecutedText, /no session started/i);
  assert.equal(contradicted.executed.length, 0, 'the dispatch ledger is empty');
});

// ---------------------------------------------------------------------------
// AC 2 — lane admission from host data
// ---------------------------------------------------------------------------

const LANE_TICKETS = [
  { id: 'KB-1', column: 'ready', execution: { status: 'running', origin: 'autopilot', startColumn: 'ready' } },
  { id: 'KB-2', column: 'in_progress', execution: { status: 'blocked' } },
  { id: 'KB-3', column: 'review', execution: { status: 'done' } },
  { id: 'KB-4', column: 'backlog', execution: null },
];

test('KB-77 AC2 occupancy counts live sessions only and honours the autopilot origin lane', () => {
  assert.deepEqual(autopilot.autopilotLaneOccupancy(LANE_TICKETS), { refine: 0, implement: 2, review: 0 });
  const refineOrigin = {
    id: 'KB-9',
    column: 'ready', // the PM already claimed Ready
    execution: { status: 'idle', origin: 'autopilot', startColumn: 'backlog' },
  };
  assert.equal(autopilot.autopilotExecutionLane(refineOrigin), 'refine', 'origin lane anchors the occupation');
  assert.deepEqual(autopilot.autopilotLaneOccupancy([...LANE_TICKETS, refineOrigin]), { refine: 1, implement: 2, review: 0 });
  assert.equal(autopilot.autopilotExecutionLane({ id: 'KB-8', column: 'review', execution: { status: 'running' } }), 'review');
  assert.equal(autopilot.autopilotExecutionLane({ id: 'KB-7', column: 'ready', execution: { status: 'failed' } }), null);
});

test('KB-77 AC2 every lane header shows busy/idle/paused with the configured cap', () => {
  const occupancy = { refine: 1, implement: 1, review: 0 };
  const admissions = autopilot.autopilotLaneAdmissions(
    { available: true, config: { ...clone(AUTO_ON), laneCaps: { refine: 1, implement: 2, review: 1 } }, paused: false, occupancy },
    t,
  );
  assert.equal(admissions.refine.state, 'busy');
  assert.equal(admissions.refine.stateLabel, dictionaries.en['autopilot.laneAdmission.busy']);
  assert.equal(admissions.refine.capacityText, '(1/1)');
  assert.equal(admissions.implement.state, 'idle', 'cap 2 with one live session is idle, not busy');
  assert.equal(admissions.implement.capacityText, '(1/2)', 'the capacity label uses the configured cap');
  assert.equal(admissions.review.state, 'idle');
  assert.equal(admissions.review.capacityText, '(0/1)');
  assert.match(admissions.implement.ariaLabel, /Implement lane admission: idle 1 of 2 slots/);
  for (const lane of autopilot.AUTOPILOT_LANES) {
    assert.equal(tzh(`autopilot.laneAdmission.${admissions[lane].state}`).length > 0, true, `zh label for ${lane}`);
  }
});

test('KB-77 AC2 lane admission never contradicts caps: paused board, cap 0 and disabled', () => {
  const config = { ...clone(AUTO_ON), laneCaps: { refine: 0, implement: 1, review: 1 } };
  const paused = autopilot.autopilotLaneAdmissions({ available: true, config, paused: true, occupancy: {} }, t);
  assert.equal(paused.refine.state, 'paused');
  assert.equal(paused.implement.state, 'paused');
  const off = autopilot.autopilotLaneAdmissions({ available: true, config: { ...clone(config), enabled: false }, paused: false, occupancy: {} }, t);
  assert.equal(off.implement.state, 'paused', 'autopilot off suspends admission');
  const cappedOff = autopilot.autopilotLaneAdmissions({ available: true, config, paused: false, occupancy: {} }, t);
  assert.equal(cappedOff.refine.state, 'paused', 'cap 0 disables the lane');
  assert.equal(cappedOff.refine.capacityText, '(0/0)');
  assert.equal(cappedOff.implement.state, 'idle');
  const unavailable = autopilot.autopilotLaneAdmissions({ available: false, config: null, paused: false, occupancy: {} }, t);
  assert.equal(unavailable.implement.state, 'paused');
  // Over-cap occupancy (manual work) is reported truthfully, never clamped to cap.
  const over = autopilot.autopilotLaneAdmissions({ available: true, config: clone(AUTO_ON), paused: false, occupancy: { implement: 2 } }, t);
  assert.equal(over.implement.state, 'busy');
  assert.equal(over.implement.capacityText, '(2/1)');
});

// ---------------------------------------------------------------------------
// AC 3 — member autopilot state
// ---------------------------------------------------------------------------

test('KB-77/KB-89 AC3 member rows derive autopilot state from the real attached-agent status', () => {
  const now = Date.now();
  const view = { available: true, memberActivatedAt: { 'm-fe': now - 5 * 60_000 } };
  const active = autopilot.memberAutopilotState(
    { id: 'm-fe', name: 'Sherif', status: 'running', currentTicket: { id: 'KB-9', title: 'T', column: 'in_progress' }, lastActivityAt: now - 60_000 },
    view,
    t,
  );
  assert.equal(active.kind, 'active');
  assert.equal(active.label, 'Active on KB-9');
  assert.equal(active.lastActivatedAt, now - 5 * 60_000, 'the persisted fairness key wins over lastActivityAt');
  assert.equal(active.lastActiveText, t('autopilot.member.lastActive', { ago: t('time.minutes', { n: 5 }) }));

  // A running member without a ticket is active; a member at rest never is.
  const running = autopilot.memberAutopilotState({ id: 'm-run', status: 'running', sessionId: 'sess-1' }, view, t);
  assert.equal(running.kind, 'active');
  assert.equal(running.label, dictionaries.en['autopilot.member.activeSession']);

  // At rest with their own In Progress ticket: resume, not active.
  const resumable = autopilot.memberAutopilotState(
    { id: 'm-resume', status: 'idle', sessionId: 'sess-3', currentTicket: { id: 'KB-7', title: 'T', column: 'in_progress' } },
    view,
    t,
  );
  assert.equal(resumable.kind, 'idle');
  assert.equal(resumable.label, 'Resume KB-7');

  // Idle implementer whose ticket is parked in Review has no current ticket from
  // the host, so autopilot reports no work — never a pulsing active state.
  const reviewOwner = autopilot.memberAutopilotState({ id: 'm-review-owner', status: 'idle', sessionId: 'sess-4', currentTicket: null }, view, t);
  assert.equal(reviewOwner.kind, 'idle');
  assert.equal(reviewOwner.label, dictionaries.en['autopilot.member.idle']);

  // A reviewer's review queue is a real next action, still neutral (not active).
  const nextReview = autopilot.memberAutopilotState(
    { id: 'm-reviewer', status: 'idle', sessionId: 'sess-5', currentTicket: { id: 'KB-5', title: 'T', column: 'review' } },
    view,
    t,
  );
  assert.equal(nextReview.kind, 'idle');
  assert.equal(nextReview.label, 'Next KB-5');

  const idle = autopilot.memberAutopilotState({ id: 'm-idle', status: 'idle', sessionId: 'sess-2' }, view, t);
  assert.equal(idle.kind, 'idle');
  assert.equal(idle.label, dictionaries.en['autopilot.member.idle']);

  const paused = autopilot.memberAutopilotState(
    { id: 'm-paused', status: 'running', paused: true, currentTicket: { id: 'KB-2' } },
    view,
    t,
  );
  assert.equal(paused.kind, 'paused', 'a user-paused member is paused even while holding a ticket');
  assert.equal(paused.label, dictionaries.en['autopilot.member.paused']);

  const noWork = autopilot.memberAutopilotState({ id: 'm-free', status: 'offline', sessionId: null }, view, t);
  assert.equal(noWork.kind, 'no-work');
  assert.equal(noWork.label, dictionaries.en['autopilot.member.noWork']);
  assert.notEqual(paused.label, noWork.label, 'paused and no-work are distinguishable textually');
  assert.equal(noWork.lastActiveText, dictionaries.en['autopilot.member.neverActive']);
  for (const state of [active, running, resumable, reviewOwner, nextReview, idle, paused, noWork]) {
    assert.ok(state.chipText.includes(state.label), 'the chip carries the state as text');
    assert.ok(state.ariaLabel.includes(state.label), 'the chip has an accessible name with the state');
    assert.equal(tzh(state.chipText).length > 0, true);
  }
});

// ---------------------------------------------------------------------------
// AC 4 / AC 9 — next-tick countdown with fake timers
// ---------------------------------------------------------------------------

test('KB-77 AC4 the countdown is mm:ss, updates ≤1/s and stays within 2 s of the host value', () => {
  let state = autopilot.initialAutopilotCountdown();
  state = autopilot.reduceAutopilotCountdown(state, {
    type: 'sync',
    available: true,
    enabled: true,
    paused: false,
    nextTickAt: 305_000,
    hostNow: 5_000,
    localNow: 1_000,
  });
  assert.equal(autopilot.autopilotCountdownMode(state), 'running');
  assert.equal(autopilot.autopilotCountdownLabel(state, t), '05:00');
  assert.equal(autopilot.autopilotCountdownAria(state, t), t('autopilot.countdown.aria', { value: '05:00' }));

  // Sub-second ticks are coalesced: the same state object means no re-render.
  const before = state;
  state = autopilot.reduceAutopilotCountdown(state, { type: 'tick', localNow: 1_999 });
  assert.equal(state, before, 'a sub-second tick does not change the rendered second');
  state = autopilot.reduceAutopilotCountdown(state, { type: 'tick', localNow: 2_000 });
  assert.equal(autopilot.autopilotCountdownLabel(state, t), '04:59');
  state = autopilot.reduceAutopilotCountdown(state, { type: 'tick', localNow: 3_500 });
  assert.equal(autopilot.autopilotCountdownLabel(state, t), '04:58', 'one update per second of host time');

  // Probe assertion: after a poll at localNow=1000 the host clock is projected
  // forward, so at localNow=4300 the label is within 2 s of the host value.
  const projected = autopilot.autopilotCountdownRemaining(state, 4_300);
  const hostRemaining = (305_000 - (5_000 + 3_300)) / 1000;
  assert.ok(Math.abs(projected - hostRemaining) <= 2, `countdown ${projected}s vs host ${hostRemaining}s`);

  // An out-of-order poll cannot move the countdown backwards.
  const afterPoll = autopilot.reduceAutopilotCountdown(state, {
    type: 'sync',
    available: true,
    enabled: true,
    paused: false,
    nextTickAt: 9_000,
    hostNow: 4_000,
    localNow: 9_000,
  });
  assert.equal(afterPoll, state, 'an older host clock is ignored');
  const afterFreshPoll = autopilot.reduceAutopilotCountdown(state, {
    type: 'sync',
    available: true,
    enabled: true,
    paused: false,
    nextTickAt: 405_000,
    hostNow: 105_000,
    localNow: 101_000,
  });
  assert.equal(autopilot.autopilotCountdownSeconds(afterFreshPoll, 101_000), 300, 'a fresh poll re-syncs the baseline');
});

test('KB-77 AC4/AC9 the countdown stops and reads off/paused when admission is suspended', () => {
  let paused = autopilot.reduceAutopilotCountdown(autopilot.initialAutopilotCountdown(), {
    type: 'sync',
    available: true,
    enabled: true,
    paused: true,
    nextTickAt: 305_000,
    hostNow: 5_000,
    localNow: 1_000,
  });
  assert.equal(autopilot.autopilotCountdownMode(paused), 'paused');
  assert.equal(autopilot.autopilotCountdownLabel(paused, t), dictionaries.en['autopilot.countdown.paused']);
  assert.equal(autopilot.reduceAutopilotCountdown(paused, { type: 'tick', localNow: 60_000 }), paused, 'paused does not tick');

  const off = autopilot.reduceAutopilotCountdown(paused, {
    type: 'sync',
    available: true,
    enabled: false,
    paused: false,
    nextTickAt: null,
    hostNow: 9_000,
    localNow: 5_000,
  });
  assert.equal(autopilot.autopilotCountdownMode(off), 'off');
  assert.equal(autopilot.autopilotCountdownLabel(off, t), dictionaries.en['autopilot.countdown.off']);
  assert.equal(autopilot.reduceAutopilotCountdown(off, { type: 'tick', localNow: 120_000 }), off, 'off does not tick');

  const unavailable = autopilot.reduceAutopilotCountdown(autopilot.initialAutopilotCountdown(), {
    type: 'sync',
    available: false,
    enabled: false,
    paused: false,
    nextTickAt: null,
    hostNow: 1,
    localNow: 1,
  });
  assert.equal(autopilot.autopilotCountdownLabel(unavailable, t), dictionaries.en['autopilot.countdown.off']);
  assert.equal(autopilot.autopilotCountdownLabel(off, tzh), tzh('autopilot.countdown.off'));
});

test('KB-77 AC4/AC9 fake timers drive the countdown at most once per second', () => {
  const timers = createFakeTimers();
  let state = autopilot.reduceAutopilotCountdown(autopilot.initialAutopilotCountdown(), {
    type: 'sync',
    available: true,
    enabled: true,
    paused: false,
    nextTickAt: 310_000,
    hostNow: 10_000,
    localNow: 0,
  });
  const labels = [];
  let lastLabel = autopilot.autopilotCountdownLabel(state, t);
  labels.push(lastLabel);
  const tick = () => {
    state = autopilot.reduceAutopilotCountdown(state, { type: 'tick', localNow: timers.now() });
    const label = autopilot.autopilotCountdownLabel(state, t);
    if (label !== lastLabel) {
      lastLabel = label;
      labels.push(label);
    }
  };
  // Two ticks per second for five seconds: the visible label still changes once
  // per second, never twice.
  const id = (() => {
    let running = true;
    const step = () => {
      if (!running) return;
      timers.setTimeout(() => {
        tick();
        step();
      }, 500);
    };
    step();
    return { stop: () => (running = false) };
  })();
  for (let second = 0; second < 10; second += 1) timers.advance(500);
  id.stop();
  assert.deepEqual(labels, ['05:00', '04:59', '04:58', '04:57', '04:56', '04:55'], 'one label change per host second');
  assert.equal(state.seconds, 295);
  assert.equal(state.hostNow, 10_000, 'the tick never rewrites the polled host baseline');
});

// ---------------------------------------------------------------------------
// AC 5 / AC 9 — deduplicated, non-destructive alerts
// ---------------------------------------------------------------------------

test('KB-77 AC5 alerts dedupe by pulse id and carry the localized reason', () => {
  const alerts = autopilot.buildAutopilotAlerts(PULSE_FEED, [], TICKETS, t, CLOCK);
  assert.deepEqual(alerts.map((alert) => alert.pulseId), ['PL-11', 'PL-10', 'PL-9'], 'newest first, one row per pulse');
  const loop = alerts[0];
  assert.equal(loop.reasons.length, 2, 'both failing reasons are shown once');
  assert.deepEqual(loop.reasons, [dictionaries.en['autopilot.reason.postcondition-failed'], dictionaries.en['autopilot.reason.loop-guard']]);
  assert.deepEqual(loop.ticketIds, ['KB-2'], 'ticket ids are deduplicated');
  assert.match(alerts[1].message, /session start failed/, 'a pulse-level error keeps the host message behind a localized label');
  assert.equal(alerts[2].reasons[0], dictionaries.en['autopilot.reason.budget-exhausted']);
  assert.match(alerts[2].reasons[0], /budget/i);
  assert.equal(alerts[2].ticketIds.length, 0, 'a board-level alert has no ticket link');
  assert.equal(alerts.every((alert) => alert.reasons.every((reason) => reason && !reason.startsWith('autopilot.'))), true, 'no raw keys leak');
  for (const reason of alerts[0].reasons) assert.equal(tzh('autopilot.reason.postcondition-failed').length > 0, true);
});

test('KB-77 AC5 a real failed-dispatch pulse (error + admitted row + empty ledger) links the ticket and a localized reason', () => {
  // Exact shape index.js writes when `startTicketExecution` throws in
  // `dispatchAutopilotDecision`: pulse.error is set, the planner's `admitted`
  // dispatch decision stays, `dispatched` stays empty and no alert-reason
  // decision or outcome is written. This is the shape the review round found
  // rendering a ticketless, reasonless alert.
  const failed = {
    id: 'PL-20',
    at: PULSE_ROOT + 300_000,
    trigger: 'timer',
    durationMs: 500,
    error: 'session start failed: the provider returned no session',
    decisions: [
      {
        order: 1,
        action: 'dispatch',
        reason: 'admitted',
        group: 'implement',
        lane: 'implement',
        ticketId: 'KB-1',
        memberId: 'member-fe',
        memberName: 'Sherif Shawarma',
        detail: 'KB-1 pulled by the implement lane.',
      },
    ],
    dispatched: [],
  };
  const [alert] = autopilot.buildAutopilotAlerts([failed], [], TICKETS, t, CLOCK);
  assert.ok(alert, 'a failed dispatch always alerts');
  assert.deepEqual(alert.reasons, [dictionaries.en['autopilot.reason.dispatch-failed']], 'the reason is a localized label, not a raw code');
  assert.equal(alert.reasons[0].startsWith('autopilot.'), false, 'no raw key leaks into the alert');
  assert.deepEqual(alert.ticketIds, ['KB-1'], 'the admitted ticket missing from the ledger is linked');
  assert.match(alert.message, /Pulse failed: session start failed/, 'the host message stays behind the localized wrapper');
  const [alertZh] = autopilot.buildAutopilotAlerts([failed], [], TICKETS, tzh, CLOCK);
  assert.deepEqual(alertZh.reasons, [dictionaries.zh['autopilot.reason.dispatch-failed']], 'ac 8: zh label parity');
  assert.deepEqual(alertZh.ticketIds, ['KB-1']);
  // Acknowledging the pulse stays acknowledged across the next poll (AC 5).
  let state = autopilot.reduceAutopilotPulseState(autopilot.initialAutopilotPulseState(), {
    type: 'sync',
    hostNow: failed.at,
    pulses: [failed],
  });
  state = autopilot.reduceAutopilotPulseState(state, { type: 'ack', pulseId: 'PL-20' });
  state = autopilot.reduceAutopilotPulseState(state, { type: 'sync', hostNow: failed.at + 2_500, pulses: [failed] });
  assert.equal(autopilot.buildAutopilotAlerts(state.pulses, state.acked, TICKETS, t, CLOCK).length, 0, 'an acknowledged alert stays hidden');
  // The successful twin of the same pulse (populated ledger, no error) is not an alert.
  const ok = { ...failed, id: 'PL-21', error: '', dispatched: [{ ticketId: 'KB-1', memberId: 'member-fe', sessionId: 'sess-9' }] };
  assert.equal(autopilot.buildAutopilotAlerts([ok], [], TICKETS, t, CLOCK).length, 0, 'a completed dispatch is not an alert');
  // A failed pulse whose ticket/decision is gone still alerts, without inventing a link.
  const noDecision = { ...failed, id: 'PL-22', decisions: [] };
  const [laneAlert] = autopilot.buildAutopilotAlerts([noDecision], [], TICKETS, t, CLOCK);
  assert.deepEqual(laneAlert.reasons, [dictionaries.en['autopilot.reason.dispatch-failed']]);
  assert.deepEqual(laneAlert.ticketIds, []);
});

test('KB-77 AC5/AC9 a poll never clears an unread alert and an ack survives every poll', () => {
  let state = autopilot.reduceAutopilotPulseState(autopilot.initialAutopilotPulseState(), {
    type: 'sync',
    hostNow: PULSE_ROOT,
    pulses: PULSE_FEED,
  });
  const first = autopilot.buildAutopilotAlerts(state.pulses, state.acked, TICKETS, t, CLOCK);
  assert.equal(first.length, 3);
  // The next poll (same ring or a newer one) keeps the unread alerts.
  state = autopilot.reduceAutopilotPulseState(state, { type: 'sync', hostNow: PULSE_ROOT + 2_500, pulses: PULSE_FEED });
  assert.equal(autopilot.buildAutopilotAlerts(state.pulses, state.acked, TICKETS, t, CLOCK).length, 3, 'a poll never clears an unread alert');

  state = autopilot.reduceAutopilotPulseState(state, { type: 'ack', pulseId: 'PL-11' });
  assert.deepEqual(state.acked, ['PL-11']);
  assert.deepEqual(autopilot.buildAutopilotAlerts(state.pulses, state.acked, TICKETS, t, CLOCK).map((alert) => alert.pulseId), ['PL-10', 'PL-9']);
  const afterAckPoll = autopilot.reduceAutopilotPulseState(state, { type: 'sync', hostNow: PULSE_ROOT + 5_000, pulses: PULSE_FEED });
  assert.deepEqual(afterAckPoll.acked, ['PL-11'], 'the acknowledgement is remembered for that pulse id');
  assert.equal(autopilot.buildAutopilotAlerts(afterAckPoll.pulses, afterAckPoll.acked, TICKETS, t, CLOCK).some((alert) => alert.pulseId === 'PL-11'), false);
  // A repeated ack is a no-op (stable identity for the renderer).
  assert.equal(autopilot.reduceAutopilotPulseState(afterAckPoll, { type: 'ack', pulseId: 'PL-11' }), afterAckPoll);
});

test('KB-77 AC9 the pulse reducer ignores out-of-order polls and never duplicates a pulse', () => {
  let state = autopilot.reduceAutopilotPulseState(autopilot.initialAutopilotPulseState(), {
    type: 'sync',
    hostNow: PULSE_ROOT + 10_000,
    pulses: PULSE_FEED,
  });
  assert.equal(state.pulses.length, PULSE_FEED.length);
  const ids = state.pulses.map((pulse) => pulse.id);
  // The same poll again (duplicate delivery) does not duplicate rows.
  state = autopilot.reduceAutopilotPulseState(state, { type: 'sync', hostNow: PULSE_ROOT + 10_000, pulses: PULSE_FEED });
  assert.deepEqual(state.pulses.map((pulse) => pulse.id), ids);
  // A delayed older poll is ignored outright.
  const stale = autopilot.reduceAutopilotPulseState(state, {
    type: 'sync',
    hostNow: PULSE_ROOT + 1_000,
    pulses: [{ id: 'PL-1', at: PULSE_ROOT, trigger: 'timer', decisions: [], dispatched: [] }],
  });
  assert.equal(stale, state, 'an older host clock cannot rewind or resurrect pulses');
  // A newer poll prepends the new pulse without dropping the history.
  const newer = autopilot.reduceAutopilotPulseState(state, {
    type: 'sync',
    hostNow: PULSE_ROOT + 300_000,
    pulses: [{ id: 'PL-13', at: PULSE_ROOT + 300_000, trigger: 'timer', decisions: [], dispatched: [] }],
  });
  assert.equal(newer.pulses[0].id, 'PL-13');
  assert.equal(newer.pulses.length, PULSE_FEED.length + 1);
  assert.equal(new Set(newer.pulses.map((pulse) => pulse.id)).size, newer.pulses.length, 'ids stay unique');
});

// ---------------------------------------------------------------------------
// AC 6 — empty / loading / unavailable feed states
// ---------------------------------------------------------------------------

test('KB-77 AC6 loading never flashes the empty state and the empty state offers the toggle', () => {
  assert.equal(autopilot.autopilotFeedState({ loading: true, available: true, pulses: [] }), 'loading');
  assert.equal(autopilot.autopilotFeedState({ loading: true, available: true, pulses: PULSE_FEED }), 'loading');
  assert.equal(autopilot.autopilotFeedState({ loading: false, available: true, pulses: [] }), 'empty');
  assert.equal(autopilot.autopilotFeedState({ loading: false, available: false, pulses: [] }), 'unavailable');
  assert.equal(autopilot.autopilotFeedState({ loading: false, available: true, pulses: PULSE_FEED }), 'ready');
  assert.equal(dictionaries.en['autopilot.feedEmptyTitle'], 'No pulses yet — turn Autopilot on');
  assert.ok(dictionaries.en['autopilot.feedEmptyAction'].length > 0);
  assert.ok(dictionaries.zh['autopilot.feedEmptyTitle'].includes('暂无脉冲'));
  // With autopilot already on there is no toggle to offer, so the copy must not
  // ask for it; the "on" variant exists in both locales instead.
  assert.notEqual(dictionaries.en['autopilot.feedEmptyTitleOn'], dictionaries.en['autopilot.feedEmptyTitle']);
  assert.ok(dictionaries.en['autopilot.feedEmptyTitleOn'].length > 0);
  assert.ok(dictionaries.en['autopilot.feedEmptyBodyOn'].length > 0);
  assert.ok(dictionaries.zh['autopilot.feedEmptyTitleOn'].length > 0);
  assert.ok(dictionaries.zh['autopilot.feedEmptyBodyOn'].length > 0);
  // The feed section reserves a stable body height, so a pulse arriving inside
  // the popover replaces text rather than growing the panel.
  assert.ok(CSS_HAS_FEED_MIN_HEIGHT, 'feed list keeps a min-height');
  const feed = autopilot.buildAutopilotFeed([], [], [], t, null, CLOCK);
  assert.equal(feed.rows.length, 0, 'an empty feed projects no rows without throwing');
});

const CSS_HAS_FEED_MIN_HEIGHT = /\.kb-apPulseList\{[^}]*min-height:\d+px/.test(pluginSource) && /\.kb-apFeedEmpty\{[^}]*min-height:\d+px/.test(pluginSource);

// ---------------------------------------------------------------------------
// AC 7 / AC 8 — accessible names, both locales, no raw codes
// ---------------------------------------------------------------------------

test('KB-77 AC7/AC8 every feed/status string is localized in en and zh', () => {
  assert.equal(autopilot.autopilotTriggerLabel('nonsense', t), dictionaries.en['autopilot.trigger.manual'], 'an unknown trigger falls back to a real label');
  for (const trigger of autopilot.AUTOPILOT_TRIGGERS) {
    assert.equal(autopilot.autopilotTriggerLabel(trigger, t), dictionaries.en[`autopilot.trigger.${trigger}`]);
    assert.equal(autopilot.autopilotTriggerLabel(trigger, tzh), dictionaries.zh[`autopilot.trigger.${trigger}`]);
  }
  const feed = autopilot.buildAutopilotFeed(PULSE_FEED, TICKETS, ROSTER, tzh, (roleId) => translateZhRole(roleId), CLOCK);
  for (const row of feed.rows) {
    assert.ok(row.triggerLabel.length > 0);
    assert.ok(row.durationText.length > 0);
    for (const decision of row.decisions) {
      assert.ok(decision.reason.length > 0);
      assert.equal(decision.reason.startsWith('autopilot.reason.'), false, 'a reason code is never rendered raw');
      assert.ok(decision.actionLabel.length > 0);
      assert.ok(decision.laneLabel.length > 0);
    }
  }
  // Every alert reason has a zh label as well.
  const alertsZh = autopilot.buildAutopilotAlerts(PULSE_FEED, [], TICKETS, tzh, CLOCK);
  assert.ok(alertsZh.length > 0);
  for (const alert of alertsZh) assert.ok(alert.reasons.join(' ').length > 0 || alert.message.length > 0, 'a zh alert carries a reason or an explained error');
});

function translateZhRole(roleId) {
  return tzh(`role.${roleId}`);
}

test('KB-77 AC1/AC7 the countdown, lane chip and member chip expose accessible names', () => {
  let countdown = autopilot.reduceAutopilotCountdown(autopilot.initialAutopilotCountdown(), {
    type: 'sync',
    available: true,
    enabled: true,
    paused: false,
    nextTickAt: 125_000,
    hostNow: 5_000,
    localNow: 5_000,
  });
  assert.match(autopilot.autopilotCountdownAria(countdown, t), /02:00/);
  const admission = autopilot.autopilotLaneAdmission('review', { available: true, config: clone(AUTO_ON), occupancy: { review: 1 } }, t);
  assert.match(admission.ariaLabel, /Review lane admission: busy 1 of 1 slots/);
  assert.equal(admission.stateLabel, 'busy', 'state is text, never colour-only');
  const member = autopilot.memberAutopilotState({ id: 'm', paused: true }, { available: true }, t);
  assert.match(member.ariaLabel, /Autopilot: Paused/);
});

// ---------------------------------------------------------------------------
// View read model + constants
// ---------------------------------------------------------------------------

test('KB-77 the snapshot view carries pulses, host clock, lane occupancy and member activation', () => {
  const now = Date.now();
  const view = autopilot.autopilotViewFromSnapshot(
    snapshotWith({
      tickets: LANE_TICKETS,
      pulses: PULSE_FEED,
      now: 1_800_000_400_000,
      boardMembers: [{ id: 'member-fe', lastActivatedAt: now - 90_000 }],
    }),
  );
  assert.equal(view.pulses.length, PULSE_FEED.length);
  assert.equal(view.hostNow, 1_800_000_400_000);
  assert.deepEqual(view.laneOccupancy, { refine: 0, implement: 2, review: 0 });
  assert.equal(view.memberActivatedAt['member-fe'], now - 90_000);
  // An older host that ships none of the KB-77 fields still yields a safe view.
  const old = autopilot.autopilotViewFromSnapshot({ workspaceId: 'ws-1', board: { tickets: [], pulses: [] }, roster: [] });
  assert.deepEqual(old.pulses, []);
  assert.equal(old.hostNow, null);
  assert.deepEqual(old.laneOccupancy, { refine: 0, implement: 0, review: 0 });
  assert.deepEqual(old.memberActivatedAt, {});
});

test('KB-77 the observability bounds are exactly the ticket bounds', () => {
  assert.equal(autopilot.AUTOPILOT_FEED_MAX, 20);
  assert.equal(autopilot.AUTOPILOT_PULSE_KEEP, 50);
  assert.deepEqual(autopilot.AUTOPILOT_TRIGGERS, ['timer', 'manual', 'resume']);
  assert.deepEqual(autopilot.AUTOPILOT_ALERT_REASONS, ['postcondition-failed', 'loop-guard', 'budget-exhausted']);
});
