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
const missingEn = zhKeys.filter((key) => !(key in (localeDicts.kanban?.en ?? {})));
check('zh has all keys', missingZh.length === 0, missingZh.slice(0, 6).join(','));
check(
  'locale key sets are identical both directions',
  missingEn.length === 0 && enKeys.length === zhKeys.length,
  `en-only:[${missingZh.slice(0, 6).join(',')}] zh-only:[${missingEn.slice(0, 6).join(',')}] total:${enKeys.length}`,
);
for (const key of ['md.linkExternal', 'md.codeBlock', 'md.table']) {
  check(`shared markdown key ${key}`, typeof localeDicts.kanban?.en?.[key] === 'string' && typeof localeDicts.kanban?.zh?.[key] === 'string' && localeDicts.kanban.en[key] !== localeDicts.kanban.zh[key], `${localeDicts.kanban?.en?.[key]} / ${localeDicts.kanban?.zh?.[key]}`);
}

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

// ---------------------------------------------------------------------------
// KB-57 AC4 — the `.kb-md` segment of the single CSS literal is token-only,
// plus the mechanical properties the component relies on.
// ---------------------------------------------------------------------------
const mdStart = source.indexOf('/* kb-md */');
const mdEnd = source.indexOf('/* /kb-md */');
check('kb-md CSS segment present', mdStart !== -1 && mdEnd > mdStart, mdStart === -1 ? 'start marker missing' : `bytes ${mdEnd - mdStart}`);
const mdCss = mdStart !== -1 && mdEnd > mdStart ? source.slice(mdStart, mdEnd) : '';

check('kb-md CSS has zero hex literals', mdCss.length > 0 && !/#[0-9a-fA-F]{3,8}\b/.test(mdCss));
check('kb-md CSS has zero rgb/hsl literals', mdCss.length > 0 && !/\b(?:rgba?|hsla?)\s*\(/.test(mdCss));

const COLORISH = /^(?:color|background|background-color|accent-color|caret-color|box-shadow|fill|stroke|outline|outline-color|border|border-color|border-(?:top|right|bottom|left)(?:-color)?|text-decoration-color)$/;
const tokenless = [];
for (const match of mdCss.matchAll(/([a-z-]+)\s*:\s*([^;}]+)/g)) {
  const property = match[1];
  const value = match[2].trim();
  if (!COLORISH.test(property)) continue;
  if (!/var\(--dsw-/.test(value)) tokenless.push(`${property}:${value}`);
}
check('every kb-md color/background/border declaration uses var(--dsw-*)', tokenless.length === 0, tokenless.slice(0, 5).join(' | '));

const headingSizes = [3, 4, 5, 6].map((level) => {
  const match = new RegExp(`\\.kb-md h${level}\\{font-size:([\\d.]+)px\\}`).exec(mdCss);
  return match ? Number(match[1]) : null;
});
check(
  'kb-md heading scale h3–h6 strictly decreases',
  headingSizes.every((size) => typeof size === 'number') && headingSizes.every((size, index) => index === 0 || size < headingSizes[index - 1]),
  headingSizes.join(' > '),
);
check('kb-md headings wrap anywhere', /\.kb-md h3[^{]*\{[^}]*overflow-wrap:anywhere/.test(mdCss));

const preBlock = /\.kb-md pre\{([^}]*)\}/.exec(mdCss);
check(
  'kb-md fenced code preserves whitespace, scrolls both axes within a max-height',
  Boolean(preBlock && /white-space:pre/.test(preBlock[1]) && /overflow:auto/.test(preBlock[1]) && /max-height:\d+px/.test(preBlock[1])),
  preBlock ? preBlock[1].slice(0, 120) : 'pre rule missing',
);
check('kb-md focus ring uses a theme token', /\.kb-md [^{]*:focus-visible[^{]*\{[^}]*outline:2px solid var\(--dsw-[a-z0-9-]+\)/.test(mdCss));
check('kb-md task checkboxes are non-interactive', /\.kb-md input\[type="checkbox"\]\{[^}]*pointer-events:none/.test(mdCss));

const tableWrap = /\.kb-md-tableWrap\{([^}]*)\}/.exec(mdCss);
check('kb-md table wrapper scrolls horizontally', Boolean(tableWrap && /overflow-x:auto/.test(tableWrap[1])), tableWrap ? tableWrap[1].slice(0, 120) : 'wrapper rule missing');
const cellRule = /\.kb-md th,\.kb-md td\{([^}]*)\}/.exec(mdCss);
check('kb-md table cells keep a min-width', Boolean(cellRule && /min-width:\d+px/.test(cellRule[1])), cellRule ? cellRule[1].slice(0, 120) : 'cell rule missing');

console.log('\n' + (failures.length === 0 ? 'ALL CLIENT CHECKS PASSED' : `${failures.length} FAILURE(S):\n- ${failures.join('\n- ')}`));
process.exit(failures.length === 0 ? 0 : 1);
