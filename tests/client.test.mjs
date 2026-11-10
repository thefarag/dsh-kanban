import { readFile } from 'node:fs/promises';

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
globalThis.document = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {}, activeElement: null };

await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

check('module loader entry', captured && captured.id === '@local/dsh-kanban', captured?.id);
check('factory present', typeof captured?.factory === 'function');

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

check('plugin inject', Array.isArray(plugin.inject) && ['slots', 'locale', 'uiWorkspace', 'sessions'].every((k) => plugin.inject.includes(k)), JSON.stringify(plugin.inject));
check('plugin apply', typeof plugin.apply === 'function');

const localeDicts = {};
const registrations = [];
const slotInjections = [];
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
    bind(namespace) {
      return (key, params) => {
        const dict = localeDicts[namespace]?.en ?? {};
        let value = dict[key] ?? key;
        if (params && typeof value === 'string') {
          for (const [name, replacement] of Object.entries(params)) {
            value = value.split(`{${name}}`).join(String(replacement));
          }
        }
        return value;
      };
    },
  },
  uiWorkspace: { openSession: () => {} },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  slots: {
    inject(slot, callback) {
      slotInjections.push(slot);
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

plugin.apply(ctx);

check('locale namespace registered', Boolean(localeDicts.kanban?.en && localeDicts.kanban?.zh));
const enKeys = Object.keys(localeDicts.kanban?.en ?? {});
const zhKeys = Object.keys(localeDicts.kanban?.zh ?? {});
check('english dictionary size', enKeys.length > 120, String(enKeys.length));
check('zh dictionary size', zhKeys.length === enKeys.length, `${zhKeys.length}/${enKeys.length}`);
const missingZh = enKeys.filter((key) => !(key in (localeDicts.kanban?.zh ?? {})));
check('zh has all keys', missingZh.length === 0, missingZh.slice(0, 6).join(','));

const main = registrations.find((entry) => entry.options.name === 'main');
const side = registrations.find((entry) => entry.options.name === 'sidebar.panellist');
check('main registration', Boolean(main) && main.options.key === 'kanban' && main.options.locale === 'kanban');
check('sidebar registration', Boolean(side) && side.options.id === 'kanban' && side.options.order === 15);
check('slot injections', slotInjections.includes('main') && slotInjections.includes('sidebar.panellist'), slotInjections.join(','));

// Icon must render an SVG and honour size.
const iconProps = main?.options.inject ? main.options.inject() : {};
check('main inject props', typeof iconProps.openSession === 'function' && typeof iconProps.readSessionCwd === 'function');
const icon = side.component({ size: 18, active: true });
const svg = icon?.type === 'svg' ? icon : icon?.props ? null : null;
check('icon renders svg', icon?.type === 'svg', icon?.type);
check('icon size honoured', icon?.props?.width === 18 && icon?.props?.height === 18, JSON.stringify(icon?.props?.width));

// The page component must be a function and reference no forbidden globals at definition time.
check('page component', typeof main.component === 'function');

console.log('\n' + (failures.length === 0 ? 'ALL CLIENT CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
process.exit(failures.length === 0 ? 0 : 1);
