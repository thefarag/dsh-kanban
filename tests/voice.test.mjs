/**
 * KB-2 voice dictation — fake-bundle contract tests.
 *
 * The dialog talks to the installed voice bundle through its experimental
 * `remote.speech` namespace (`catalog` + `transcribe`). The bundle has no
 * streaming segment API and no exported capture control, so the dialog records
 * one fragment with MediaRecorder and forwards one complete WAV per stop. These
 * tests drive the dialog's dictation engine with a fake bundle double, a fake
 * capture and injected timers (no sleeps), then assert the observable states,
 * the single-call transcription and the appended text.
 *
 * The client module is materialized exactly like in the real Web GUI (module
 * loader, fake React) with `__KB2_VOICE_TEST__` set so its test seam exposes the
 * engine; production exports stay `apply`/`inject`.
 */
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.__KB2_VOICE_TEST__ = true;

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      captured = entry;
    },
  },
};
globalThis.window.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
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
const voice = plugin.__voice;
assert.ok(voice, 'voice test seam is exposed when __KB2_VOICE_TEST__ is set');
assert.ok(typeof plugin.apply === 'function' && Array.isArray(plugin.inject), 'plugin shape unchanged');

// ---------------------------------------------------------------------------
// Fakes: bundle double, capture, timers, engine harness
// ---------------------------------------------------------------------------

const READY_CATALOG = {
  ok: true,
  value: {
    providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }],
    selection: { providerId: 'sensevoice-local', language: 'en' },
    maxDurationSeconds: 120,
    maxAudioBytes: 4 * 1024 * 1024,
  },
};

const flush = async () => {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** Injected timers: deterministic, advanceable, no real waiting. */
function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timeouts.set(id, { fn, at: now + Math.max(0, ms || 0) });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(fn, ms) {
      const id = nextId++;
      const every = Math.max(1, ms || 1);
      intervals.set(id, { fn, every, at: now + every });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, item] of timeouts) {
          if (item.at <= end && (due === null || item.at < due.at)) due = { id, item, kind: 'timeout' };
        }
        for (const [id, item] of intervals) {
          if (item.at <= end && (due === null || item.at < due.at)) due = { id, item, kind: 'interval' };
        }
        if (!due) break;
        now = due.item.at;
        if (due.kind === 'timeout') {
          timeouts.delete(due.id);
          due.item.fn();
        } else {
          due.item.at += due.item.every;
          due.item.fn();
        }
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

function createCaptureHarness(options = {}) {
  const captures = [];
  let created = 0;
  const factory = () => {
    created += 1;
    const capture = {
      started: 0,
      stopped: 0,
      disposed: 0,
      endHandler: null,
      bytes: options.bytes === undefined ? new Uint8Array([1, 2, 3, 4]) : options.bytes,
      pending: null,
      rejectStart: null,
    };
    capture.start = async (onEnded) => {
      capture.started += 1;
      capture.endHandler = onEnded;
      if (options.pendingStart === true) {
        await new Promise((resolve, reject) => {
          capture.pending = resolve;
          capture.rejectStart = reject;
        });
      }
      if (capture.startError) throw capture.startError;
    };
    capture.stop = async () => {
      capture.stopped += 1;
      return capture.bytes;
    };
    capture.dispose = async () => {
      capture.disposed += 1;
    };
    if (options.startError !== undefined) capture.startError = options.startError;
    captures.push(capture);
    return capture;
  };
  return {
    factory,
    captures,
    created: () => created,
    latest: () => captures[captures.length - 1],
  };
}

function createFakeSpeech(options = {}) {
  const state = {
    catalogCalls: 0,
    transcribeCalls: 0,
    requests: [],
    transcripts: Array.isArray(options.transcripts) ? options.transcripts.slice() : [],
    catalogEnvelope: options.catalogEnvelope === undefined ? READY_CATALOG : options.catalogEnvelope,
    transcribeEnvelope: options.transcribeEnvelope === undefined ? null : options.transcribeEnvelope,
    catalogError: options.catalogError === undefined ? null : options.catalogError,
    transcribeError: options.transcribeError === undefined ? null : options.transcribeError,
  };
  const speech = {
    async catalog() {
      state.catalogCalls += 1;
      if (typeof state.catalogEnvelope === 'function') return state.catalogEnvelope();
      if (state.catalogError) throw state.catalogError;
      return state.catalogEnvelope;
    },
    async transcribe(request) {
      state.transcribeCalls += 1;
      state.requests.push(request);
      if (state.transcribeError) throw state.transcribeError;
      if (typeof state.transcribeEnvelope === 'function') return state.transcribeEnvelope(request);
      if (state.transcribeEnvelope) return state.transcribeEnvelope;
      const text = state.transcripts.length > 0 ? state.transcripts.shift() : '';
      return { ok: true, value: { text, audioSeconds: 1, inferenceSeconds: 0.2 } };
    },
  };
  return { speech, state };
}

function createEngineHarness(options = {}) {
  const log = { states: [], texts: [] };
  let text = typeof options.text === 'string' ? options.text : '';
  const timers = createFakeTimers();
  const capture = createCaptureHarness(options.capture || {});
  const speech = createFakeSpeech(options.speech || {});
  const t = (key, params) => (params === undefined ? key : key + ' ' + JSON.stringify(params));
  const engine = voice.createVoiceEngine({
    getSpeech: options.getSpeech === undefined ? () => speech.speech : options.getSpeech,
    t,
    getText: () => text,
    onText: (next) => {
      text = next;
      log.texts.push(next);
    },
    onState: (state) => log.states.push(state),
    now: timers.now,
    timers: {
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
    },
    captureFactory: capture.factory,
  });
  return {
    engine,
    log,
    timers,
    capture,
    speech,
    text: () => text,
    setText: (value) => {
      text = value;
    },
    phase: () => engine.getState().phase,
  };
}

const phases = (log) => log.states.map((state) => state.phase);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('appendTranscript keeps typed text and appends once with one space', () => {
  assert.equal(voice.appendTranscript('', 'hello world'), 'hello world');
  assert.equal(voice.appendTranscript('typed', 'spoken'), 'typed spoken');
  assert.equal(voice.appendTranscript('typed ', 'spoken'), 'typed spoken');
  assert.equal(voice.appendTranscript('typed', '  spoken\n\nnow '), 'typed spoken now');
  assert.equal(voice.appendTranscript('typed', '   '), 'typed');
  assert.equal(voice.appendTranscript('typed', ''), 'typed');
  const atLimit = 'x'.repeat(4000);
  assert.equal(voice.appendTranscript(atLimit, 'more'), atLimit);
  const room = 'x'.repeat(3995);
  const clamped = voice.appendTranscript(room, 'abcdefgh');
  assert.equal(clamped.length, 4000);
  assert.ok(clamped.startsWith(room));
});

test('encodeWave writes the canonical 16 kHz mono PCM16 WAV header', () => {
  const samples = new Float32Array([0, 1, -1]);
  const bytes = voice.encodeWave(samples);
  assert.equal(bytes.length, 44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.length - 8);
  assert.equal(String.fromCharCode(...bytes.subarray(8, 12)), 'WAVE');
  assert.equal(String.fromCharCode(...bytes.subarray(12, 16)), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'PCM format');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000, '16 kHz');
  assert.equal(view.getUint32(28, true), 32000, 'byte rate');
  assert.equal(view.getUint16(32, true), 2, 'block align');
  assert.equal(view.getUint16(34, true), 16, 'bits per sample');
  assert.equal(String.fromCharCode(...bytes.subarray(36, 40)), 'data');
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(view.getInt16(44, true), 0);
  assert.equal(view.getInt16(46, true), 32767);
  assert.equal(view.getInt16(48, true), -32768);
});

test('waveBase64 emits the bundle carrier encoding without a data-URL prefix', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  const encoded = voice.waveBase64(bytes);
  assert.ok(!encoded.startsWith('data:'));
  assert.deepEqual([...Buffer.from(encoded, 'base64')], [...bytes]);
});

test('captureFailureKind maps permission and device failures', () => {
  const named = (name) => Object.assign(new Error(name), { name });
  assert.equal(voice.captureFailureKind(named('NotAllowedError')), 'permission');
  assert.equal(voice.captureFailureKind(named('SecurityError')), 'permission');
  assert.equal(voice.captureFailureKind(named('NotFoundError')), 'device');
  assert.equal(voice.captureFailureKind(named('NotReadableError')), 'device');
  assert.equal(voice.captureFailureKind(named('AbortError')), 'capture');
  assert.equal(voice.captureFailureKind(null), 'capture');
});

test('readVoiceCatalog distinguishes ready, not-ready and unreachable bundles', () => {
  const ready = voice.readVoiceCatalog(READY_CATALOG);
  assert.equal(ready.available, true);
  assert.equal(ready.ready, true);
  assert.equal(ready.providerId, 'sensevoice-local');
  assert.equal(ready.language, 'en');
  assert.equal(ready.maxDurationSeconds, 120);

  const standby = voice.readVoiceCatalog({
    ok: true,
    value: {
      ...READY_CATALOG.value,
      providers: [{ id: 'sensevoice-local', preparation: { phase: 'standby' } }],
    },
  });
  assert.equal(standby.ready, true);

  const unready = voice.readVoiceCatalog({
    ok: true,
    value: {
      ...READY_CATALOG.value,
      providers: [{ id: 'sensevoice-local', preparation: { phase: 'unprepared' } }],
    },
  });
  assert.equal(unready.available, true);
  assert.equal(unready.ready, false);
  assert.equal(unready.reason, 'unready');

  const failed = voice.readVoiceCatalog({ ok: false, error: { message: 'offline' } });
  assert.equal(failed.available, false);
  assert.equal(failed.ready, false);
  assert.equal(voice.readVoiceCatalog(null).available, false);
});

// ---------------------------------------------------------------------------
// Engine: default on, toggle, one-shot commit
// ---------------------------------------------------------------------------

test('default on: a ready bundle starts capture on init', async () => {
  const harness = createEngineHarness();
  await harness.engine.init();
  assert.equal(harness.phase(), 'recording');
  assert.equal(harness.engine.getState().pressed, true);
  assert.equal(harness.capture.created(), 1);
  assert.equal(harness.capture.latest().started, 1);
  assert.equal(harness.speech.state.catalogCalls, 1);
  assert.ok(phases(harness.log).includes('requesting'));
  assert.ok(phases(harness.log).includes('recording'));
  harness.engine.dispose();
  assert.equal(harness.capture.latest().disposed, 1);
});

test('toggle stops, transcribes exactly once, appends, and restarts capture', async () => {
  const harness = createEngineHarness({ text: 'typed' });
  harness.speech.state.transcripts.push('first fragment');
  await harness.engine.init();

  const result = await harness.engine.toggle();
  assert.equal(result.ok, true);
  assert.equal(harness.speech.state.transcribeCalls, 1);
  const request = harness.speech.state.requests[0];
  assert.equal(request.providerId, 'sensevoice-local');
  assert.equal(request.language, 'en');
  assert.ok(typeof request.audioBase64 === 'string' && request.audioBase64.length > 0);
  assert.equal(harness.text(), 'typed first fragment');
  assert.equal(harness.phase(), 'idle');
  assert.equal(harness.engine.getState().pressed, false);
  assert.equal(harness.capture.latest().stopped, 1);
  assert.equal(harness.capture.latest().disposed, 1);

  const second = await harness.engine.toggle();
  assert.equal(second, undefined);
  assert.equal(harness.phase(), 'recording');
  assert.equal(harness.capture.created(), 2);
  assert.equal(harness.engine.getState().pressed, true);
  harness.engine.dispose();
});

test('two stop-to-transcribe fragments yield "A B" once with no duplication', async () => {
  const harness = createEngineHarness();
  harness.speech.state.transcripts.push('A', 'B');
  await harness.engine.init();

  await harness.engine.toggle();
  await harness.engine.toggle();
  await harness.engine.toggle();

  assert.equal(harness.speech.state.transcribeCalls, 2);
  assert.equal(harness.text(), 'A B');
  assert.deepEqual(harness.log.texts, ['A', 'A B']);
  assert.equal(harness.phase(), 'idle');
  harness.engine.dispose();
});

test('elapsed seconds tick without changing the phase, then the max duration auto-stops', async () => {
  const harness = createEngineHarness();
  harness.speech.state.transcripts.push('after the cap');
  await harness.engine.init();
  assert.equal(harness.phase(), 'recording');

  await harness.timers.advance(3000);
  assert.equal(harness.engine.getState().elapsedSeconds, 3);
  assert.equal(harness.phase(), 'recording');
  assert.equal(harness.speech.state.transcribeCalls, 0);

  await harness.timers.advance(117000);
  assert.equal(harness.speech.state.transcribeCalls, 1);
  assert.equal(harness.text(), 'after the cap');
  assert.equal(harness.phase(), 'idle');
  harness.engine.dispose();
});

// ---------------------------------------------------------------------------
// Degraded states
// ---------------------------------------------------------------------------

test('bundle absent: no capture, no permission prompt, unavailable state', async () => {
  const harness = createEngineHarness({ getSpeech: () => null, text: 'typed' });
  await harness.engine.init();
  assert.equal(harness.phase(), 'unavailable');
  assert.equal(harness.engine.getState().reason, 'absent');
  assert.equal(harness.capture.created(), 0);
  const toggle = await harness.engine.toggle();
  assert.equal(toggle, undefined);
  assert.equal(harness.capture.created(), 0);
  harness.engine.dispose();
});

test('provider not ready: no capture and an unready explanation', async () => {
  const harness = createEngineHarness({
    speech: {
      catalogEnvelope: {
        ok: true,
        value: {
          ...READY_CATALOG.value,
          providers: [{ id: 'sensevoice-local', preparation: { phase: 'unprepared' } }],
        },
      },
    },
  });
  await harness.engine.init();
  assert.equal(harness.phase(), 'unavailable');
  assert.equal(harness.engine.getState().reason, 'unready');
  assert.equal(harness.capture.created(), 0);
  harness.engine.dispose();
});

test('catalog failure degrades to the unavailable state without throwing', async () => {
  const harness = createEngineHarness({ speech: { catalogError: new Error('remote offline') } });
  await harness.engine.init();
  assert.equal(harness.phase(), 'unavailable');
  assert.equal(harness.engine.getState().reason, 'service');
  assert.equal(harness.capture.created(), 0);
  harness.engine.dispose();
});

test('permission denied: one inline error, dictation off, retry only on explicit toggle', async () => {
  const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const harness = createEngineHarness({ capture: { startError: denied } });
  await harness.engine.init();
  assert.equal(harness.phase(), 'error');
  assert.equal(harness.engine.getState().error, 'permission');
  assert.equal(harness.engine.getState().pressed, false);
  assert.equal(harness.capture.created(), 1);

  await flush();
  assert.equal(harness.capture.created(), 1, 'no automatic permission-prompt loop');

  await harness.engine.toggle();
  assert.equal(harness.capture.created(), 2, 'an explicit toggle press retries');
  assert.equal(harness.phase(), 'error');
  harness.engine.dispose();
});

test('mid-way capture failure keeps committed text and drops the broken fragment', async () => {
  const harness = createEngineHarness({ text: 'kept text' });
  await harness.engine.init();
  assert.equal(harness.phase(), 'recording');
  harness.capture.latest().endHandler();
  await flush();
  assert.equal(harness.phase(), 'error');
  assert.equal(harness.engine.getState().error, 'capture');
  assert.equal(harness.text(), 'kept text');
  assert.equal(harness.speech.state.transcribeCalls, 0);
  harness.engine.dispose();
});

test('transcription failure keeps committed text and shows the transcribe error', async () => {
  const harness = createEngineHarness({ text: 'kept text' });
  harness.speech.state.transcribeEnvelope = { ok: false, error: { message: 'recognizer failed' } };
  await harness.engine.init();
  const result = await harness.engine.toggle();
  assert.equal(result.ok, false);
  assert.equal(harness.phase(), 'error');
  assert.equal(harness.engine.getState().error, 'transcribe');
  assert.equal(harness.text(), 'kept text');
  assert.equal(harness.speech.state.transcribeCalls, 1);
  harness.engine.dispose();
});

test('a thrown transcription rejects into the same non-blocking error state', async () => {
  const harness = createEngineHarness({ text: 'kept text' });
  harness.speech.state.transcribeError = new Error('connection lost');
  await harness.engine.init();
  const result = await harness.engine.toggle();
  assert.equal(result.ok, false);
  assert.equal(harness.phase(), 'error');
  assert.equal(harness.engine.getState().error, 'transcribe');
  assert.equal(harness.text(), 'kept text');
  harness.engine.dispose();
});

test('an empty transcript on an explicit stop is a retryable empty state', async () => {
  const harness = createEngineHarness();
  harness.speech.state.transcripts.push('');
  await harness.engine.init();
  const result = await harness.engine.toggle();
  assert.equal(result.ok, false);
  assert.equal(harness.phase(), 'error');
  assert.equal(harness.engine.getState().error, 'empty');
  assert.equal(harness.text(), '');
  harness.engine.dispose();
});

// ---------------------------------------------------------------------------
// Submit flush: the dialog submits once, after finalizing the fragment
// ---------------------------------------------------------------------------

test('submit while recording finalizes the fragment and returns one trimmed text', async () => {
  const harness = createEngineHarness({ text: '  typed ' });
  harness.speech.state.transcripts.push('spoken');
  await harness.engine.init();
  const flushed = await harness.engine.submitFlush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.text.trim(), 'typed spoken');
  assert.equal(harness.speech.state.transcribeCalls, 1);
  assert.equal(harness.phase(), 'idle');
  harness.engine.dispose();
});

test('submit while recording does not submit when transcription fails', async () => {
  const harness = createEngineHarness({ text: 'typed' });
  harness.speech.state.transcribeEnvelope = { ok: false, error: { message: 'failed' } };
  await harness.engine.init();
  const flushed = await harness.engine.submitFlush();
  assert.equal(flushed.ok, false);
  assert.equal(harness.phase(), 'error');
  assert.equal(harness.text(), 'typed');
  harness.engine.dispose();
});

test('submit with an empty spoken fragment still submits the typed text', async () => {
  const harness = createEngineHarness({ text: 'typed only' });
  harness.speech.state.transcripts.push('');
  await harness.engine.init();
  const flushed = await harness.engine.submitFlush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.text, 'typed only');
  assert.equal(harness.phase(), 'idle');
  harness.engine.dispose();
});

test('submit while a permission request is pending cancels it and keeps the typed text', async () => {
  const harness = createEngineHarness({ text: 'typed', capture: { pendingStart: true } });
  const initPromise = harness.engine.init();
  await flush();
  assert.equal(harness.phase(), 'requesting');
  const flushed = await harness.engine.submitFlush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.text, 'typed');
  harness.capture.latest().pending();
  await initPromise;
  assert.notEqual(harness.phase(), 'recording');
  harness.engine.dispose();
});

test('dispose while recording releases the microphone and never transcribes', async () => {
  const harness = createEngineHarness();
  await harness.engine.init();
  harness.engine.dispose();
  await flush();
  assert.equal(harness.capture.latest().disposed, 1);
  assert.equal(harness.speech.state.transcribeCalls, 0);
  assert.equal(harness.engine.getState().phase, 'recording');
});

// ---------------------------------------------------------------------------
// Locale parity
// ---------------------------------------------------------------------------

test('every voice string exists in both client dictionaries and is used from t()', async () => {
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
        return (key) => key;
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
  const en = localeDicts.kanban.en;
  const zh = localeDicts.kanban.zh;
  assert.ok(en && zh, 'both dictionaries registered');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'key parity');

  const used = new Set([...source.matchAll(/t\('(thought\.voice\.[A-Za-z]+)'/g)].map((match) => match[1]));
  for (const key of [
    'thought.voice.errorPermission',
    'thought.voice.errorDevice',
    'thought.voice.errorCapture',
    'thought.voice.errorTranscribe',
    'thought.voice.errorEmpty',
    'thought.voice.errorTooLong',
  ]) {
    used.add(key);
  }
  assert.ok(used.size >= 19, `voice keys referenced from t(): ${used.size}`);
  for (const key of used) {
    assert.ok(key in en, `en has ${key}`);
    assert.ok(key in zh, `zh has ${key}`);
    assert.ok(String(zh[key]).length > 0, `zh ${key} is not empty`);
    assert.notEqual(zh[key], en[key], `zh ${key} is translated`);
  }
  for (const key of Object.keys(en)) {
    if (!key.startsWith('thought.voice.')) continue;
    assert.ok(key in zh, `zh has dictionary key ${key}`);
  }
});
