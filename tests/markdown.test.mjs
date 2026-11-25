/**
 * KB-56 — Safe Markdown engine contract tests.
 *
 * `parseMarkdown` turns untrusted Markdown into a deep-frozen, immutable AST and
 * `renderMarkdown(ast, h)` turns that AST into React elements through the
 * injected `h` factory: no HTML strings, no raw-HTML pass-through, no
 * `dangerouslySetInnerHTML`, no `innerHTML`, no DOM/window access. The module is
 * materialized exactly like the real Web GUI (module loader + fake React) with
 * `plugin.markdown` exported unconditionally, and the browser globals are
 * deleted *before* the factory runs to prove the engine is DOM-free.
 *
 * Every test is named after its acceptance criterion (AC1 … AC13) so the raw
 * `node --test tests/markdown.test.mjs` output maps one-to-one to the ticket.
 */
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
assert.equal(typeof captured.factory, 'function', 'factory present');

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

// The engine is DOM-free: drop the browser globals before the factory is called.
delete globalThis.window;
delete globalThis.document;

const plugin = captured.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require ${name}`);
});

const h = React.createElement;
const markdown = plugin.markdown;

const ALLOWED_ELEMENTS = new Set([
  'p',
  'br',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'blockquote',
  'hr',
  'a',
  'input',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
const ALLOWED_PROPS = {
  a: new Set(['href', 'target', 'rel']),
  ol: new Set(['start']),
  code: new Set(['data-lang']),
  th: new Set(['data-align']),
  td: new Set(['data-align']),
  input: new Set(['type', 'disabled', 'defaultChecked', 'aria-label']),
};

/** Depth-first flatten of a fake-React tree (arrays, elements and text leaves). */
function flatten(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out);
    return out;
  }
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (typeof node === 'object') {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

const elementsOf = (tree) => flatten(tree).filter((value) => value !== null && typeof value === 'object');
const textOf = (tree) => flatten(tree).filter((value) => typeof value === 'string').join('');
const typesOf = (tree) => elementsOf(tree).map((node) => node.type);
const find = (tree, type) => elementsOf(tree).filter((node) => node.type === type);
const parse = (markdownSource) => markdown.parse(markdownSource);
const render = (markdownSource) => markdown.render(parse(markdownSource), h);

function assertSafeTree(tree) {
  for (const node of elementsOf(tree)) {
    assert.ok(ALLOWED_ELEMENTS.has(node.type), `element <${node.type}> is outside the allowlist`);
    const props = node.props || {};
    for (const key of Object.keys(props)) {
      assert.ok(!/^on/i.test(key), `event handler prop ${key} on <${node.type}>`);
      assert.notEqual(key, 'style', `style prop on <${node.type}>`);
      assert.notEqual(key, 'className', `className prop on <${node.type}>`);
      assert.notEqual(key, 'dangerouslySetInnerHTML', `dangerouslySetInnerHTML on <${node.type}>`);
      const allowed = ALLOWED_PROPS[node.type];
      if (allowed) assert.ok(allowed.has(key), `prop ${key} is not allowed on <${node.type}>`);
      else assert.fail(`unexpected prop ${key} on <${node.type}>`);
    }
    if (node.type === 'a') {
      assert.match(props.href, /^(https?|mailto):/i, `anchor href scheme: ${props.href}`);
      assert.equal(props.target, '_blank', 'anchor target');
      assert.equal(props.rel, 'noopener noreferrer nofollow', 'anchor rel');
    }
    if (node.type === 'input') {
      assert.equal(props.type, 'checkbox', 'task input type');
      assert.equal(props.disabled, true, 'task input disabled');
      assert.equal('checked' in props, false, 'task input is uncontrolled');
    }
  }
}

function assertDeepFrozen(value, path = 'ast') {
  if (Array.isArray(value)) {
    assert.ok(Object.isFrozen(value), `${path} array is frozen`);
    value.forEach((item, index) => assertDeepFrozen(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value), `${path} object is frozen`);
    for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${path}.${key}`);
  }
}

/** No `children`/cell/row array may contain null or undefined (table `align` may). */
function assertCleanAst(value, path = 'ast') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assert.notEqual(value[index], null, `${path}[${index}] is null`);
      assert.notEqual(value[index], undefined, `${path}[${index}] is undefined`);
      assertCleanAst(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key === 'align') continue;
      assert.notEqual(value[key], undefined, `${path}.${key} is undefined`);
      assertCleanAst(value[key], `${path}.${key}`);
    }
  }
}

function assertCleanRender(node, path = 'render') {
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) {
      assert.notEqual(node[index], null, `${path}[${index}] is null`);
      assert.notEqual(node[index], undefined, `${path}[${index}] is undefined`);
      assertCleanRender(node[index], `${path}[${index}]`);
    }
    return;
  }
  if (node && typeof node === 'object') {
    assert.ok(Array.isArray(node.children), `${path} children array`);
    assertCleanRender(node.children, `${path}.children`);
  }
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('AC1 — empty and whitespace input yields a frozen empty AST and an empty render', () => {
  for (const input of ['', '   ', '\n\t\r\n']) {
    const ast = parse(input);
    assert.ok(Array.isArray(ast), `${JSON.stringify(input)} parse returns an array`);
    assert.equal(ast.length, 0, `${JSON.stringify(input)} parse returns []`);
    assert.ok(Object.isFrozen(ast), `${JSON.stringify(input)} AST root is frozen`);
  }
  assert.deepEqual(markdown.render([], h), []);
  assert.doesNotThrow(() => markdown.render(parse(''), h));
});

test('AC2 — plain text keeps one br per source newline and blank lines start paragraphs', () => {
  const oneLineBreak = parse('hello\nworld');
  assert.equal(oneLineBreak.length, 1);
  assert.equal(oneLineBreak[0].type, 'paragraph');
  const inlineTypes = oneLineBreak[0].children.map((node) => node.type);
  assert.deepEqual(inlineTypes, ['text', 'br', 'text']);
  assert.equal(find(render('hello\nworld'), 'br').length, 1);
  assert.equal(textOf(render('hello\nworld')), 'helloworld');

  const twoParagraphs = parse('alpha\n\nbeta');
  assert.deepEqual(
    twoParagraphs.map((block) => block.type),
    ['paragraph', 'paragraph'],
  );
  assert.equal(find(render('alpha\n\nbeta'), 'br').length, 0);
  assert.equal(find(render('alpha\n\nbeta'), 'p').length, 2);

  // Non-syntax text keeps every marker literal — no emphasis/heading/quote/code.
  const literal = 'plain * star _ bare # hash > angle and ` tick';
  const literalTree = render(literal);
  assert.equal(textOf(literalTree), literal);
  for (const type of ['strong', 'em', 'del', 'code', 'h3', 'h4', 'h5', 'h6', 'blockquote']) {
    assert.equal(find(literalTree, type).length, 0, `no ${type} from non-syntax text`);
  }
});

test('AC3 — ATX + Setext headings parse levels 1–6 and clamp to h3–h6', () => {
  const clamp = { 1: 'h3', 2: 'h4', 3: 'h5', 4: 'h6', 5: 'h6', 6: 'h6' };
  for (let level = 1; level <= 6; level += 1) {
    const blocks = parse(`${'#'.repeat(level)} heading ${level}`);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, 'heading');
    assert.equal(blocks[0].level, level);
    const tree = render(`${'#'.repeat(level)} heading ${level}`);
    assert.equal(typesOf(tree)[0], clamp[level], `level ${level} renders ${clamp[level]}`);
  }

  const setextOne = parse('Setext one\n===');
  assert.equal(setextOne[0].level, 1);
  const setextTwo = parse('Setext two\n---');
  assert.equal(setextTwo[0].level, 2);
  for (const blocks of [setextOne, setextTwo]) {
    assert.ok(blocks[0].level >= 1 && blocks[0].level <= 2, 'Setext supplies levels 1–2 only');
  }

  const fullDocument = [
    '# one',
    '## two',
    '### three',
    '#### four',
    '##### five',
    '###### six',
    '',
    'Setext one',
    '===',
    '',
    'Setext two',
    '---',
  ].join('\n');
  const renderedTypes = typesOf(render(fullDocument));
  assert.equal(renderedTypes.includes('h1'), false, 'no h1 in the rendered tree');
  assert.equal(renderedTypes.includes('h2'), false, 'no h2 in the rendered tree');
  assert.equal(find(render(fullDocument), 'h3').length, 2);
});

test('AC4 — emphasis, inline code, escapes and unmatched delimiters', () => {
  const tree = render('**strong** *em* _em_ ~~strike~~ `code`');
  assert.equal(find(tree, 'strong').length, 1);
  assert.equal(find(tree, 'em').length, 2);
  assert.equal(find(tree, 'del').length, 1, '~~strike~~ renders <del>');
  assert.equal(find(tree, 'code').length, 1);
  assert.equal(textOf(find(tree, 'code')), 'code');

  const escaped = render('\\*not em\\* \\_not em\\_ \\`not code\\` done \\\\');
  for (const type of ['strong', 'em', 'code']) assert.equal(find(escaped, type).length, 0);
  const escapedText = textOf(escaped);
  assert.ok(escapedText.includes('*not em*'), escapedText);
  assert.ok(escapedText.includes('_not em_'), escapedText);
  assert.ok(escapedText.includes('`not code`'), escapedText);
  assert.ok(escapedText.includes('\\'), escapedText);

  for (const unmatched of ['**open', '*open', '~~open', '_open']) {
    const unmatchedTree = render(unmatched);
    for (const type of ['strong', 'em', 'del']) {
      assert.equal(find(unmatchedTree, type).length, 0, `${unmatched} stays literal`);
    }
    assert.ok(textOf(unmatchedTree).includes(unmatched), `${unmatched} text preserved`);
  }

  const codeTree = render('`**not strong** and *not em*`');
  assert.equal(find(codeTree, 'strong').length, 0, 'no emphasis inside inline code');
  assert.equal(find(codeTree, 'em').length, 0, 'no emphasis inside inline code');
  assert.equal(find(codeTree, 'code')[0].children[0], '**not strong** and *not em*');
});

test('AC5 — fenced and indented code preserve whitespace and never parse Markdown', () => {
  const fenced = '```js title=one\nalpha\n  beta\n\n  gamma  \n```';
  const fencedBlocks = parse(fenced);
  assert.equal(fencedBlocks.length, 1);
  assert.equal(fencedBlocks[0].type, 'code');
  assert.equal(fencedBlocks[0].lang, 'js', 'first info token becomes data-lang');
  assert.equal(fencedBlocks[0].value, 'alpha\n  beta\n\n  gamma  ');
  const fencedTree = render(fenced);
  assert.deepEqual(typesOf(fencedTree), ['pre', 'code']);
  assert.equal(find(fencedTree, 'code')[0].props['data-lang'], 'js');
  assert.equal(find(fencedTree, 'code')[0].children[0], 'alpha\n  beta\n\n  gamma  ');
  assert.equal(find(fencedTree, 'strong').length, 0);

  const tilde = '~~~\nraw **not strong**\n~~~';
  assert.equal(parse(tilde)[0].value, 'raw **not strong**');
  assert.equal(find(render(tilde), 'strong').length, 0);

  const noLang = parse('```\nplain\n```')[0];
  assert.equal(noLang.lang, '');
  assert.equal('data-lang' in find(render('```\nplain\n```'), 'code')[0].props, false, 'no data-lang when empty');

  const unterminated = parse('```\nnever closes\n**raw**')[0];
  assert.equal(unterminated.type, 'code');
  assert.equal(unterminated.value, 'never closes\n**raw**');
  assert.equal(find(render('```\nnever closes\n**raw**'), 'strong').length, 0);

  const indented = parse('    one\n      two\n\n    three')[0];
  assert.equal(indented.type, 'code');
  assert.equal(indented.value, 'one\n  two\n\nthree');

  const longerClose = parse('````js\nx\n`````')[0];
  assert.equal(longerClose.value, 'x');

  assertSafeTree(render(fenced));
});

test('AC6 — lists: ordered start, nesting, tight/loose and GFM task items', () => {
  const ordered = render('3. a\n4. b');
  assert.equal(find(ordered, 'ol').length, 1);
  assert.equal(find(ordered, 'ol')[0].props.start, 3);
  const fromOne = render('1. a\n2. b');
  assert.equal('start' in find(fromOne, 'ol')[0].props, false, 'no start prop when first number is 1');
  assert.equal(find(render('- a\n- b'), 'ul').length, 1);

  const nested = render('- a\n  - b\n    - c');
  assert.equal(find(nested, 'ul').length, 3, 'nesting depth of at least 3');
  assert.equal(find(nested, 'li').length, 3);

  const tight = render('- a\n- b');
  assert.equal(find(tight, 'p').length, 0, 'tight items carry no <p>');
  const looseIndented = render('- a\n\n  b');
  assert.ok(find(looseIndented, 'p').length >= 1, 'loose item paragraphs are wrapped in <p>');
  assert.equal(parse('- a\n\n  b')[0].tight, false);
  const looseBetweenItems = parse('- a\n\n- b');
  assert.equal(looseBetweenItems[0].tight, false, 'blank line between items makes the list loose');
  assert.equal(find(render('- a\n\n- b'), 'p').length, 2);
  assert.equal(parse('- a\n- b\n\n')[0].tight, true, 'a trailing blank line does not loosen the list');

  const tasks = render('- [ ] todo\n- [x] done\n- [X] upper');
  const inputs = find(tasks, 'input');
  assert.equal(inputs.length, 3);
  assert.deepEqual(
    inputs.map((input) => input.props.defaultChecked),
    [false, true, true],
  );
  assert.deepEqual(
    inputs.map((input) => input.props['aria-label']),
    ['todo', 'done', 'upper'],
  );
  assert.equal(textOf(find(tasks, 'li')[0]), 'todo');
  assertSafeTree(tasks);

  const formattedTask = render('- [x] **done** item');
  assert.equal(find(formattedTask, 'input')[0].props['aria-label'], 'done item');
});

test('AC7 — blockquotes, horizontal rules, links and angle autolinks', () => {
  const nestedQuote = render('> a\n> > b\n> > > c');
  assert.equal(find(nestedQuote, 'blockquote').length, 3, 'nested blockquotes');
  assert.deepEqual(
    find(nestedQuote, 'blockquote').map((quote) => textOf(quote)),
    ['abc', 'bc', 'c'],
  );

  const breaks = render('---\n\n***\n\n___');
  assert.equal(find(breaks, 'hr').length, 3, 'all three horizontal-rule markers');

  const explicit = render('[docs](https://example.com/a?x=1)');
  assert.equal(find(explicit, 'a').length, 1);
  assert.equal(find(explicit, 'a')[0].props.href, 'https://example.com/a?x=1');
  assert.equal(textOf(find(explicit, 'a')), 'docs');

  const titled = render('[docs](https://example.com/a "the title")');
  assert.equal(find(titled, 'a')[0].props.href, 'https://example.com/a');

  const uri = render('<https://example.com/angle>');
  assert.equal(find(uri, 'a')[0].props.href, 'https://example.com/angle');
  assert.equal(textOf(find(uri, 'a')), 'https://example.com/angle');

  const email = render('<user@example.com>');
  assert.equal(find(email, 'a')[0].props.href, 'mailto:user@example.com');
  assert.equal(textOf(find(email, 'a')), 'user@example.com');

  const mailto = render('<mailto:user@example.com>');
  assert.equal(find(mailto, 'a')[0].props.href, 'mailto:user@example.com');
});

test('AC8 — safe link schemes keep href; every unsafe destination renders as plain text', () => {
  for (const [sourceText, expectedHref] of [
    ['[http](http://example.com/x)', 'http://example.com/x'],
    ['[https](https://example.com/x)', 'https://example.com/x'],
    ['[mail](mailto:user@example.com)', 'mailto:user@example.com'],
    ['[trim](  https://example.com/trim  )', 'https://example.com/trim'],
  ]) {
    const tree = render(sourceText);
    const anchors = find(tree, 'a');
    assert.equal(anchors.length, 1, `${sourceText} keeps an anchor`);
    assert.equal(anchors[0].props.href, expectedHref);
    assert.equal(anchors[0].props.target, '_blank');
    assert.equal(anchors[0].props.rel, 'noopener noreferrer nofollow');
  }

  const unsafe = [
    '[js](javascript:alert(1))',
    '[Js](JaVaScRiPt:alert(1))',
    '[data](data:text/html;base64,PHNjcmlwdD4=)',
    '[vb](vbscript:msgbox(1))',
    '[file](file:///etc/passwd)',
    '[proto](//evil.example/x)',
    '[relative](/relative/path)',
    '[fragment](#fragment)',
    '[entity](&#106;avascript:alert(1))',
    '[hexentity](&#x6a;avascript:alert(1))',
    '[whitespace](java\tscript:alert(1))',
    '[control](java\u0000script:alert(1))',
  ];
  for (const sourceText of unsafe) {
    const tree = render(sourceText);
    assert.equal(find(tree, 'a').length, 0, `${sourceText} has no anchor`);
    assert.equal(find(tree, 'a').filter((anchor) => 'href' in anchor.props).length, 0);
    const label = sourceText.slice(1, sourceText.indexOf(']'));
    assert.ok(textOf(tree).includes(label), `${sourceText} renders its label as text`);
  }

  const mixed = render('[ok](https://ok.example) [bad](javascript:alert(1))');
  assert.equal(find(mixed, 'a').length, 1);
  assert.equal(find(mixed, 'a')[0].props.href, 'https://ok.example');

  // Images never become <img>: safe src is an anchor labelled with the alt text
  // (empty alt falls back to the src string); unsafe src keeps only alt text.
  const safeImage = render('![alt text](https://example.com/i.png)');
  assert.equal(find(safeImage, 'a').length, 1);
  assert.equal(find(safeImage, 'a')[0].props.href, 'https://example.com/i.png');
  assert.equal(textOf(find(safeImage, 'a')), 'alt text');
  const safeImageNoAlt = render('![](https://example.com/i.png)');
  assert.equal(textOf(find(safeImageNoAlt, 'a')), 'https://example.com/i.png');
  const unsafeImage = render('![alt text](javascript:alert(1))');
  assert.equal(find(unsafeImage, 'a').length, 0);
  assert.equal(textOf(unsafeImage), 'alt text');
  const unsafeImageNoAlt = render('![](javascript:alert(1))');
  assert.equal(find(unsafeImageNoAlt, 'a').length, 0);
  assert.equal(textOf(unsafeImageNoAlt), '');
});

test('AC9 — GFM tables render alignment and degrade malformed tables to paragraphs', () => {
  const table = render('| Left | Center | Right | Plain |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |');
  assert.equal(find(table, 'table').length, 1);
  assert.equal(find(table, 'th').length, 4);
  assert.deepEqual(
    find(table, 'th').map((cell) => cell.props['data-align']),
    ['left', 'center', 'right', undefined],
  );
  assert.deepEqual(
    find(table, 'td').map((cell) => cell.props['data-align']),
    ['left', 'center', 'right', undefined],
  );
  assert.equal(find(table, 'thead').length, 1);
  assert.equal(find(table, 'tbody').length, 1);

  const padded = render('| a | b |\n| --- | --- |\n| 1 |\n| 1 | 2 | 3 |');
  for (const row of find(padded, 'tr').slice(1)) {
    assert.equal(find(row, 'td').length, 2, 'body rows pad/truncate to the header width');
  }
  assert.equal(find(padded, 'td').length, 4);

  const noOuterPipes = render('a | b\n--- | ---\n1 | 2');
  assert.equal(find(noOuterPipes, 'table').length, 1);

  for (const malformed of ['a | b\n| --- |', '| a | b |\nrow', '| a | b |\n| --- | --- | --- |']) {
    const tree = render(malformed);
    assert.equal(find(tree, 'table').length, 0, `malformed table creates no table: ${JSON.stringify(malformed)}`);
    assert.ok(find(tree, 'p').length >= 1, 'malformed table degrades to paragraphs');
  }

  assertSafeTree(table);
});

test('AC10 — hostile input renders literal text inside the allowlist only', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '',
    '<img src=x onerror=alert(1)>',
    '',
    '<iframe src="javascript:alert(1)"></iframe>',
    '',
    '<svg onload=alert(1)></svg>',
    '',
    '<object data="x"></object>',
    '',
    '<embed src="x">',
    '',
    '<style>body{display:none}</style>',
    '',
    '[js](javascript:alert(1)) [data](data:text/html,x) [rel](/x) [proto](//x)',
    '',
    '![image](javascript:alert(1))',
    '',
    '<https://safe.example/ok>',
  ].join('\n');

  const tree = render(hostile);
  assertSafeTree(tree);
  const renderedTypes = typesOf(tree);
  for (const forbidden of ['script', 'iframe', 'img', 'object', 'embed', 'style', 'svg', 'h1', 'h2']) {
    assert.equal(renderedTypes.includes(forbidden), false, `never renders <${forbidden}> from source`);
  }
  assert.equal(find(tree, 'input').length, 0, 'image syntax never becomes a control');

  const renderedText = textOf(tree);
  for (const literal of [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<svg onload=alert(1)></svg>',
  ]) {
    assert.ok(renderedText.includes(literal), `raw HTML stays literal text: ${literal}`);
  }
  const anchors = find(tree, 'a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].props.href, 'https://safe.example/ok');
});

test('AC11 — 200 seeded random inputs never throw, stay deterministic, frozen and clean', () => {
  const random = mulberry32(0x5eed1234);
  const tokens = [
    '*',
    '**',
    '_',
    '__',
    '~~',
    '`',
    '```',
    '~~~',
    '# ',
    '## ',
    '###### ',
    '- ',
    '1. ',
    '> ',
    '[',
    ']',
    '(',
    ')',
    '![',
    '](https://x.y)',
    'javascript:',
    '<',
    '>',
    '&amp;',
    '&#106;',
    '\n',
    '\r\n',
    '\r',
    '\t',
    '\u0000',
    '|',
    ':---:',
    '---',
    '===',
    '    ',
    '\\',
    '</script>',
    '<img src=x onerror=1>',
    '[task](javascript:alert(1))',
    'word ',
  ];

  const build = () => {
    let input = '';
    const length = 1 + Math.floor(random() * 48);
    for (let index = 0; index < length; index += 1) input += tokens[Math.floor(random() * tokens.length)];
    return input;
  };

  for (let caseIndex = 0; caseIndex < 200; caseIndex += 1) {
    const input = build();
    let ast;
    assert.doesNotThrow(() => {
      ast = parse(input);
    }, `parse threw for ${JSON.stringify(input.slice(0, 80))}`);
    assert.equal(JSON.stringify(ast), JSON.stringify(parse(input)), 'parse is deterministic');
    assertDeepFrozen(ast);
    assertCleanAst(ast);
    let tree;
    assert.doesNotThrow(() => {
      tree = markdown.render(ast, h);
    }, `render threw for ${JSON.stringify(input.slice(0, 80))}`);
    assert.ok(Array.isArray(tree), 'render returns an array');
    assertCleanRender(tree);
    assertSafeTree(tree);
  }
});

test('AC12 — 20k PRD fixture and 100k adversarial string parse+render under 2s', () => {
  const headings = [
    'Vision',
    'Problem',
    'Users',
    'Jobs to be done',
    'Success metrics',
    'Scope in',
    'Scope out',
    'Acceptance criteria',
    'Risks',
    'Dependencies',
    'Rollout',
    'Open questions',
  ];
  const sectionBody = (index) =>
    [
      `Sentence one for section ${index} with **bold**, *em*, ~~strike~~ and \`inline code\`.`,
      '',
      `A second paragraph with a [link](https://example.com/prd/${index}) and an entity &amp; plus a <https://example.com/auto>.`,
      '',
      '- bullet one',
      '- bullet two',
      '  - nested bullet',
      '- [x] completed task',
      '- [ ] open task',
      '',
      '| Column A | Column B |',
      '| :--- | ---: |',
      '| value 1 | value 2 |',
      '',
      '```js',
      'const section = ' + index,
      'const markdown = true',
      '```',
      '',
    ].join('\n');
  let prd = '# EPIC PRD — realistic fixture\n\n';
  let sectionIndex = 0;
  while (prd.length < 19500) {
    prd += `## ${headings[sectionIndex % headings.length]}\n\n${sectionBody(sectionIndex)}\n`;
    sectionIndex += 1;
  }
  for (const heading of headings) assert.ok(prd.includes(`## ${heading}`), `fixture has heading ${heading}`);
  assert.ok(prd.length >= 19500, `PRD fixture length ${prd.length}`);

  const adversarial = '[a](javascript:alert(1)) ![b](data:image/png;base64,xx) <img src=x onerror=1> **unterminated '.repeat(4000).slice(0, 100000);
  // Deeply alternating delimiters are the classic exponential-backtracking trap.
  const nestedDelimiters = '*_'.repeat(25000) + 'x' + '_*'.repeat(25000);

  const prdStart = performance.now();
  const prdTree = markdown.render(parse(prd), h);
  const prdMs = performance.now() - prdStart;
  assert.ok(prdTree.length > 0);

  const adversarialStart = performance.now();
  const adversarialTree = markdown.render(parse(adversarial), h);
  const adversarialMs = performance.now() - adversarialStart;
  assert.ok(adversarialTree.length > 0);
  assertSafeTree(adversarialTree);

  const nestedStart = performance.now();
  const nestedTree = markdown.render(parse(nestedDelimiters), h);
  const nestedMs = performance.now() - nestedStart;
  assert.ok(nestedTree.length > 0);

  console.log(
    `AC12 perf: PRD ${prd.length} chars -> ${prdMs.toFixed(1)} ms; adversarial ${adversarial.length} chars -> ${adversarialMs.toFixed(1)} ms; nested delimiters ${nestedDelimiters.length} chars -> ${nestedMs.toFixed(1)} ms`,
  );
  assert.ok(prdMs < 2000, `PRD fixture took ${prdMs.toFixed(1)} ms`);
  assert.ok(adversarialMs < 2000, `adversarial fixture took ${adversarialMs.toFixed(1)} ms`);
  assert.ok(nestedMs < 2000, `nested delimiter fixture took ${nestedMs.toFixed(1)} ms`);
});

test('AC13 — module shape, static scan and DOM-free engine calls', () => {
  const requireCalls = source.match(/\brequire\s*\(/g) || [];
  assert.equal(requireCalls.length, 1, 'exactly one require() in client.js');
  assert.match(source, /const React = require\('react'\)/, 'the only require is React');
  assert.equal(/^\s*import\s/m.test(source), false, 'no import statements');
  assert.equal(/^\s*<[A-Za-z][A-Za-z0-9.]*[\s>/]/m.test(source), false, 'no JSX element syntax');
  assert.equal(source.includes('React.createElement('), false, 'no direct React.createElement calls (h is injected)');
  assert.equal(source.includes('dangerouslySetInnerHTML'), false, 'no dangerouslySetInnerHTML path');
  assert.equal(source.includes('innerHTML'), false, 'no innerHTML path');

  assert.deepEqual(plugin.inject, ['slots', 'locale', 'uiWorkspace', 'sessions']);
  assert.equal(typeof plugin.apply, 'function');
  assert.ok(plugin.markdown && typeof plugin.markdown === 'object');
  assert.ok(Object.isFrozen(plugin.markdown), 'plugin.markdown is frozen');
  assert.equal(typeof markdown.parse, 'function');
  assert.equal(typeof markdown.render, 'function');
  assert.equal(globalThis.__KB2_VOICE_TEST__, undefined, 'markdown export is unconditional, not a gated test seam');
  assert.equal(globalThis.__KB4_AUTOPILOT_UI_TEST__, undefined);

  assert.equal(typeof globalThis.window, 'undefined', 'no window while the engine runs');
  assert.equal(typeof globalThis.document, 'undefined', 'no document while the engine runs');
  const tree = render('**dom free** [link](https://example.com) `code`');
  assert.equal(find(tree, 'strong').length, 1);
  assert.equal(find(tree, 'a').length, 1);
  assert.equal(find(tree, 'code').length, 1);
});

// ===========================================================================
// KB-57 — shared MarkdownBody surface component
//
// The engine module is materialized a second time with a counting fake React
// runtime: `useMemo` implements real dependency caching across consecutive
// renders, and function components are resolved so the wrapper + decorated
// engine tree can be inspected. The shipped `en`/`zh` dictionaries are captured
// through `apply` so the locale test exercises the real copy, not a copy of it.
// ===========================================================================

function createCountingRuntime() {
  const stats = { memoCalls: 0, memoHits: 0 };
  const hooksByComponent = new Map();
  let currentComponent = null;

  const hookEntry = (component) => {
    let entry = hooksByComponent.get(component);
    if (!entry) {
      entry = { hooks: [], cursor: 0 };
      hooksByComponent.set(component, entry);
    }
    return entry;
  };
  const sameDeps = (left, right) =>
    Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

  const React = {
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
    },
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState() {
      throw new Error('component state is not expected in this test');
    },
    useEffect() {},
    useRef() {
      return { current: null };
    },
    useCallback: (fn) => fn,
    useMemo(factory, deps) {
      assert.ok(currentComponent, 'useMemo must run inside a rendered component');
      const entry = hookEntry(currentComponent);
      const index = entry.cursor;
      entry.cursor += 1;
      const previous = entry.hooks[index];
      if (previous && sameDeps(previous.deps, deps)) {
        stats.memoHits += 1;
        return previous.value;
      }
      stats.memoCalls += 1;
      const value = factory();
      entry.hooks[index] = { deps: Array.isArray(deps) ? deps : [], value };
      return value;
    },
  };

  const resolveTree = (node) => {
    if (Array.isArray(node)) return node.map(resolveTree);
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const previous = currentComponent;
      currentComponent = node.type;
      const entry = hookEntry(node.type);
      entry.cursor = 0;
      let result;
      try {
        // Mirror React: rest children are exposed to the component as props.children.
        const props = { ...node.props, children: node.children.length > 0 ? node.children : node.props.children };
        result = node.type(props);
      } finally {
        currentComponent = previous;
      }
      return resolveTree(result);
    }
    return { type: node.type, props: node.props, children: node.children.map(resolveTree) };
  };

  return {
    React,
    stats,
    render: (type, props) => resolveTree({ type, props: props || {}, children: [] }),
    reset() {
      hooksByComponent.clear();
      stats.memoCalls = 0;
      stats.memoHits = 0;
    },
  };
}

const counting = createCountingRuntime();
const pluginKb57 = captured.factory((name) => {
  if (name === 'react') return counting.React;
  throw new Error(`unexpected require ${name}`);
});
assert.ok(pluginKb57.markdown, 'plugin.markdown is exported');
assert.equal(typeof pluginKb57.markdown.MarkdownBody, 'function', 'KB-57 extends the additive markdown export with MarkdownBody');
assert.ok(Object.isFrozen(pluginKb57.markdown), 'the extended export stays frozen');
const MarkdownBody = pluginKb57.markdown.MarkdownBody;

// Capture the shipped dictionaries through the real registration path.
const dictionaries = {};
pluginKb57.apply({
  effect(fn) {
    const disposer = fn();
    return typeof disposer === 'function' ? disposer : () => {};
  },
  locale: {
    register(namespace, dicts) {
      dictionaries[namespace] = dicts;
      return () => {};
    },
    bind(namespace) {
      return (key, params) => {
        const dict = dictionaries[namespace]?.en ?? {};
        let value = dict[key] ?? key;
        if (params && typeof value === 'string') {
          for (const [name, replacement] of Object.entries(params)) value = value.split(`{${name}}`).join(String(replacement));
        }
        return value;
      };
    },
  },
  uiWorkspace: { openSession() {} },
  sessions: { list: { getSnapshot: () => ({ byId: {} }) } },
  slots: {
    inject(slot, callback) {
      return callback();
    },
    register() {
      return () => {};
    },
  },
});
const shippedEn = dictionaries.kanban.en;
const shippedZh = dictionaries.kanban.zh;
const translator = (dict) => (key) => (key in dict ? dict[key] : key);
const tEn = translator(shippedEn);
const tZh = translator(shippedZh);

const renderBody = (text, extra = {}) =>
  counting.render(MarkdownBody, { text, t: extra.t || tEn, className: extra.className, label: extra.label });
const propsOf = (node) => node?.props || {};
const byClass = (tree, className) =>
  elementsOf(tree).filter((node) => String(propsOf(node).className || '').split(/\s+/).includes(className));

const FIXTURE = [
  '# Heading one',
  '## Heading two',
  '### Heading three',
  '#### Heading four',
  '##### Heading five',
  '###### Heading six',
  '',
  'Paragraph with **bold**, *italic*, ~~deleted~~ and `inline code`.',
  '',
  '- first',
  '  - nested two',
  '    - nested three',
  '- [x] shipped task',
  '- [ ] pending task',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '> quoted line',
  '',
  '---',
  '',
  '[DeepSeek](https://example.com/docs) and [mail us](mailto:dev@example.com).',
  '',
  '```js',
  'const line = "a very long code line that keeps whitespace and never wraps"',
  '```',
  '',
  '| Column one | Column two |',
  '| --- | --- |',
  '| cell one | cell two |',
].join('\n');

test('KB57 AC1 — empty/whitespace text returns null and hostile fuzz never throws', () => {
  counting.reset();
  assert.equal(renderBody(''), null, 'empty text renders nothing');
  assert.equal(renderBody('   \n\t  '), null, 'whitespace-only text renders nothing');

  const fuzz = [
    '#'.repeat(400),
    '**'.repeat(600),
    '```\nunclosed fence',
    '| a | b |\n| - | - |\n| c |',
    '[link](javascript:alert(1))',
    '![image](https://example.com/x.png)',
    '<script>alert(1)</script>',
    '\u0000\u0001\u0002 control-ish',
    '😀'.repeat(2000),
    'a'.repeat(50000),
    '>'.repeat(1000),
    '- '.repeat(800),
    '`'.repeat(300),
    '[x](https://example.com/' + 'a'.repeat(10000) + ')',
    'line\r\nwith\rCRLF',
    '',
    '   ',
  ];
  for (const text of fuzz) {
    let tree;
    assert.doesNotThrow(() => {
      tree = renderBody(text);
    }, `fuzz input threw: ${JSON.stringify(text.slice(0, 32))}`);
    assert.ok(tree === null || (tree && typeof tree === 'object'), 'fuzz render returns a value');
    assert.equal(find(tree, 'img').length, 0, 'images never render as <img>');
  }
});

test('KB57 AC2 — empty/whitespace input emits no .kb-md wrapper and zero parses', () => {
  counting.reset();
  assert.equal(renderBody(''), null);
  assert.equal(renderBody('\n\n\t '), null);
  assert.equal(counting.stats.memoCalls, 0, 'empty text never reaches the parse hook');
});

test('KB57 AC5 — h1–h6 map to h3–h6 only and an unbroken 200-char heading wraps', () => {
  const tree = renderBody(FIXTURE);
  const headingTypes = find(tree, 'h1').length === 0 ? typesOf(tree).filter((type) => /^h[1-6]$/.test(type)) : [];
  assert.deepEqual(headingTypes, ['h3', 'h4', 'h5', 'h6', 'h6', 'h6']);
  assert.equal(find(tree, 'h1').length, 0, 'never emits h1');
  assert.equal(find(tree, 'h2').length, 0, 'never emits h2');

  const long = 'W'.repeat(200);
  const wrapped = renderBody(`# ${long}`);
  const h3 = find(wrapped, 'h3')[0];
  assert.ok(h3, 'the long heading renders as h3');
  assert.equal(textOf(h3), long);
});

test('KB57 AC6 — links carry safe target/rel, host in the accessible name and an aria-hidden icon', () => {
  const tree = renderBody(FIXTURE);
  const anchors = find(tree, 'a');
  assert.equal(anchors.length, 2);
  const web = anchors.find((node) => propsOf(node).href === 'https://example.com/docs');
  const mail = anchors.find((node) => propsOf(node).href === 'mailto:dev@example.com');
  assert.ok(web && mail, 'both links render');
  for (const anchor of anchors) {
    assert.equal(propsOf(anchor).target, '_blank');
    assert.equal(propsOf(anchor).rel, 'noopener noreferrer nofollow');
  }
  assert.match(propsOf(web)['aria-label'], /example\.com/);
  assert.match(propsOf(web)['aria-label'], /opens in a new tab/);
  assert.match(propsOf(mail)['aria-label'], /dev@example\.com/);
  for (const anchor of anchors) {
    const icon = find(anchor, 'svg')[0];
    assert.ok(icon, 'the external indicator is present');
    assert.equal(propsOf(icon)['aria-hidden'], 'true');
  }
  const unsafe = renderBody('[bad](javascript:alert(1))');
  assert.equal(find(unsafe, 'a').length, 0, 'unsafe schemes are degraded to text');
});

test('KB57 AC7 — fenced code renders a labelled, scrollable <pre>', () => {
  const tree = renderBody(FIXTURE);
  const pre = find(tree, 'pre')[0];
  assert.ok(pre, 'the fence renders as pre');
  assert.equal(propsOf(pre).tabIndex, 0);
  assert.equal(propsOf(pre)['aria-label'], 'Code block');
  assert.equal(find(pre, 'code').length, 1);
  assert.match(textOf(pre), /keeps whitespace and never wraps/);
});

test('KB57 AC8 — every th has scope=col inside a labelled scroll region', () => {
  const tree = renderBody(FIXTURE);
  const headers = find(tree, 'th');
  assert.ok(headers.length >= 2);
  for (const header of headers) assert.equal(propsOf(header).scope, 'col');
  const wrappers = byClass(tree, 'kb-md-tableWrap');
  assert.equal(wrappers.length, 1, 'exactly one table wrapper');
  assert.equal(propsOf(wrappers[0]).role, 'region');
  assert.equal(propsOf(wrappers[0]).tabIndex, 0);
  assert.equal(propsOf(wrappers[0])['aria-label'], 'Table');
  assert.equal(find(wrappers[0], 'table').length, 1, 'the table sits inside the wrapper');
});

test('KB57 AC9 — task checkboxes are disabled, labelled and non-interactive', () => {
  const tree = renderBody('- [x] shipped task\n- [ ] pending task');
  const boxes = find(tree, 'input').filter((node) => propsOf(node).type === 'checkbox');
  assert.equal(boxes.length, 2);
  for (const box of boxes) {
    assert.equal(propsOf(box).disabled, true);
    assert.ok(String(propsOf(box)['aria-label']).trim().length > 0, 'checkbox has accessible text from the item');
  }
  assert.match(propsOf(boxes[0])['aria-label'], /shipped task/);
  assert.match(propsOf(boxes[1])['aria-label'], /pending task/);
  assert.equal(propsOf(boxes[0]).defaultChecked, true);
  assert.equal(propsOf(boxes[1]).defaultChecked, false);
});

test('KB57 AC10 — every source newline becomes exactly one <br>', () => {
  const tree = renderBody('line1\nline2\nline3');
  assert.equal(find(tree, 'br').length, 2);
  assert.match(textOf(tree), /line1/);
  assert.match(textOf(tree), /line2/);
  assert.match(textOf(tree), /line3/);
  assert.equal(find(tree, 'p').length, 1, 'no paragraph collapsing');
});

test('KB57 AC11 — the same fixture yields different localized aria labels in en and zh', () => {
  const collect = (tree) => ({
    code: propsOf(find(tree, 'pre')[0])['aria-label'],
    table: propsOf(byClass(tree, 'kb-md-tableWrap')[0])['aria-label'],
    link: propsOf(find(tree, 'a').find((node) => /^https:/.test(propsOf(node).href)) || find(tree, 'a')[0])['aria-label'],
  });
  const en = collect(renderBody(FIXTURE, { t: tEn }));
  const zh = collect(renderBody(FIXTURE, { t: tZh }));
  assert.equal(en.code, 'Code block');
  assert.equal(en.table, 'Table');
  assert.match(en.link, /opens in a new tab/);
  assert.equal(zh.code, '代码块');
  assert.equal(zh.table, '表格');
  assert.match(zh.link, /在新标签页打开/);
  assert.notEqual(en.code, zh.code);
  assert.notEqual(en.table, zh.table);
  assert.notEqual(en.link, zh.link);
});

test('KB57 AC12 — parse is memoized on text; locale changes re-render labels without re-parsing', () => {
  counting.reset();
  renderBody(FIXTURE, { t: tEn });
  assert.equal(counting.stats.memoCalls, 1, 'first render parses once');
  renderBody(FIXTURE, { t: tEn });
  assert.equal(counting.stats.memoCalls, 1, 'a second identical render reuses the memoized AST');
  renderBody(FIXTURE, { t: tZh });
  assert.equal(counting.stats.memoCalls, 1, 'a locale change does not parse again');
  const zh = renderBody(FIXTURE, { t: tZh });
  assert.equal(propsOf(find(zh, 'pre')[0])['aria-label'], '代码块', 'labels re-render with the new locale');

  counting.reset();
  assert.equal(renderBody(''), null);
  assert.equal(counting.stats.memoCalls, 0, 'empty text never parses');
});

test('KB57 seam — MarkdownBody is exported with the engine and wrapper props stay optional', () => {
  const bare = renderBody('hello');
  assert.equal(propsOf(bare).className, 'kb-md');
  assert.equal(propsOf(bare)['aria-label'], undefined);
  const labelled = renderBody('hello', { className: 'kb-commentText', label: 'Comment' });
  assert.equal(propsOf(labelled).className, 'kb-md kb-commentText');
  assert.equal(propsOf(labelled)['aria-label'], 'Comment');
});

// ===========================================================================
// KB-63 — Markdown hardening: adversarial corpus, link/image policy, parse
// budget and lifecycle contract.
//
// The KB-56 engine and the KB-57 component materialized above are exercised
// with a named hostile corpus, the exact link/image policy, a deterministic
// p50 parse budget and a 100-cycle lifecycle contract. AC6 (the live polling
// budget under the board's 2.5 s poll) is evidenced by `tools/kb63-probe.js`
// and `docs/screenshots/kb63/final-verification.json`; AC4 also records the
// literal grep command and its empty output in the Review comment.
// ===========================================================================

/** Element types that must never be produced from Markdown source. */
const KB63_FORBIDDEN_ELEMENTS = Object.freeze([
  'script',
  'iframe',
  'img',
  'object',
  'embed',
  'style',
  'svg',
  'math',
  'link',
  'meta',
  'base',
  'form',
  'video',
  'audio',
  'source',
  'h1',
  'h2',
]);

/** A URL that must never be fetched by an image fixture. */
const KB63_IMAGE_FIXTURE_URL = 'https://kb63.invalid/fixture-image.png';

const KB63_SAFE_SCHEME = /^(https?|mailto):/i;

const kb63Anchors = (tree) => elementsOf(tree).filter((node) => node.type === 'a');

function kb63ParseAndRender(markdownSource) {
  return markdown.render(parse(markdownSource), h);
}

/** Allowlist + no `<img>`/`src`, no event/style props, and only http(s)/mailto hrefs. */
function assertKb63SafeTree(tree, label) {
  assertSafeTree(tree);
  for (const node of elementsOf(tree)) {
    assert.equal(KB63_FORBIDDEN_ELEMENTS.includes(node.type), false, `${label}: rendered <${node.type}>`);
    assert.equal('src' in (node.props || {}), false, `${label}: <${node.type}> carries a src attribute`);
  }
  for (const anchor of kb63Anchors(tree)) {
    assert.match(String(anchor.props.href), KB63_SAFE_SCHEME, `${label}: unsafe anchor href ${anchor.props.href}`);
  }
}

function kb63NestedList(depth) {
  return Array.from({ length: depth }, (_value, index) => '  '.repeat(index) + `- item ${index}`).join('\n');
}

function kb63NestedQuote(depth) {
  return Array.from({ length: depth }, (_value, index) => '> '.repeat(index) + `quote ${index}`).join('\n');
}

/** A 10,000-character emphasis run: 2,000 `*em*` spans, never a delimiter DoS. */
function kb63EmphasisRun(length = 10000) {
  return '*em* '.repeat(Math.ceil(length / 5)).slice(0, length);
}

/** A 100,000-character adversarial document mixing every hostile surface. */
function kb63HundredKiloBytes() {
  const block = '[a](javascript:alert(1)) ![b](data:image/png;base64,xx) <img src=x onerror=1> **unterminated ';
  return block.repeat(4000).slice(0, 100000);
}

/**
 * The named hostile corpus. `tags` map every fixture to the AC1 category it
 * proves; `anchors`/`href`/`textIncludes`/`textExcludes` pin the per-fixture
 * outcome so a silently degraded render cannot pass as "allowlisted".
 */
const KB63_FIXTURES = Object.freeze([
  {
    name: 'raw-script-tag',
    tags: ['raw-html-script'],
    source: '<script>alert(document.cookie)</script>',
    anchors: 0,
    textIncludes: ['<script>alert(document.cookie)</script>'],
  },
  {
    name: 'img-onerror',
    tags: ['raw-html-img'],
    source: '<img src=x onerror="fetch(\'https://evil.invalid/steal\')">',
    anchors: 0,
    textIncludes: ['<img src=x onerror='],
  },
  {
    name: 'iframe-javascript',
    tags: ['raw-html-iframe'],
    source: '<iframe src="javascript:alert(1)"></iframe>',
    anchors: 0,
    textIncludes: ['<iframe src="javascript:alert(1)">'],
  },
  {
    name: 'svg-onload',
    tags: ['raw-html-svg'],
    source: '<svg onload=alert(1)><circle r=1></circle></svg>',
    anchors: 0,
    textIncludes: ['<svg onload=alert(1)>'],
  },
  {
    name: 'math-mtext',
    tags: ['raw-html-math'],
    source: '<math><mtext><img src=x onerror=alert(1)></mtext></math>',
    anchors: 0,
    textIncludes: ['<math>'],
  },
  {
    name: 'style-block',
    tags: ['raw-html-style'],
    source: '<style>body{display:none}</style>',
    anchors: 0,
    textIncludes: ['<style>body{display:none}</style>'],
  },
  {
    name: 'html-comment',
    tags: ['html-comment'],
    source: '<!-- <script>alert(1)</script> -->',
    anchors: 0,
    textIncludes: ['<!-- <script>alert(1)</script> -->'],
  },
  {
    name: 'entity-encoded-tag',
    tags: ['entity-encoded-tag'],
    source: '&lt;script&gt;alert(1)&lt;/script&gt;',
    anchors: 0,
    textIncludes: ['<script>alert(1)</script>'],
  },
  {
    name: 'javascript-scheme',
    tags: ['scheme-javascript'],
    source: '[click](javascript:alert(1))',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['javascript:'],
  },
  {
    name: 'data-scheme',
    tags: ['scheme-data'],
    source: '[click](data:text/html;base64,PHNjcmlwdD4=)',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['data:'],
  },
  {
    name: 'vbscript-scheme',
    tags: ['scheme-vbscript'],
    source: '[click](vbscript:msgbox(1))',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['vbscript:'],
  },
  {
    name: 'file-scheme',
    tags: ['scheme-file'],
    source: '[click](file:///etc/passwd)',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['file:'],
  },
  {
    name: 'mixed-case-scheme',
    tags: ['scheme-mixed-case'],
    source: '[click](JaVaScRiPt:alert(1))',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['JaVaScRiPt:'],
  },
  {
    name: 'space-in-scheme',
    tags: ['scheme-whitespace'],
    source: '[click](java script:alert(1))',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['java script:'],
  },
  {
    name: 'tab-in-scheme',
    tags: ['scheme-tab'],
    source: '[click](java\tscript:alert(1))',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['script:'],
  },
  {
    name: 'newline-in-scheme',
    tags: ['scheme-whitespace'],
    source: '[click](java\nscript:alert(1))',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['script:'],
  },
  {
    name: 'entity-obfuscated-scheme',
    tags: ['scheme-entity'],
    source: '[click](&#106;avascript:alert(1))',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['javascript:'],
  },
  {
    name: 'entity-encoded-colon-scheme',
    tags: ['scheme-entity'],
    source: '[click](javascript&#58;alert(1))',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['javascript:'],
  },
  {
    name: 'link-title-attribute-injection',
    tags: ['link-title-injection'],
    source: '[docs](https://ok.example/docs "onmouseover=alert(1)")',
    anchors: 1,
    href: 'https://ok.example/docs',
    textIncludes: ['docs'],
    textExcludes: ['onmouseover'],
  },
  {
    name: 'nested-brackets',
    tags: ['nested-brackets'],
    source: '[[[[deep]]]](https://ok.example/x)\n\nplain [unclosed bracket and (paren',
    anchors: 1,
    href: 'https://ok.example/x',
    textIncludes: ['deep'],
  },
  {
    name: 'emphasis-run-10k',
    tags: ['emphasis-10k'],
    source: kb63EmphasisRun(),
    anchors: 0,
    minElements: 2000,
    textIncludes: ['em'],
  },
  {
    name: 'emphasis-delimiter-run-10k',
    tags: ['emphasis-10k'],
    source: '*'.repeat(10000),
    anchors: 0,
  },
  {
    name: 'nested-lists-50',
    tags: ['nested-lists-50'],
    source: kb63NestedList(50),
    anchors: 0,
    textIncludes: ['item 0'],
    minElements: 2,
  },
  {
    name: 'nested-quotes-50',
    tags: ['nested-quotes-50'],
    source: kb63NestedQuote(50),
    anchors: 0,
    textIncludes: ['quote 0'],
    minElements: 2,
  },
  {
    name: 'malformed-table',
    tags: ['malformed-table'],
    source: '| a | b |\n| --- |\n| 1 | 2 | 3 |\nrow without pipes\n| only | header |\n| --- | --- |',
    anchors: 0,
    textIncludes: ['row without pipes'],
  },
  {
    name: 'null-and-control-bytes',
    tags: ['null-control'],
    source: 'nul\u0000 byte \u0001 stx \u0008 backspace \u000b vt \u000c ff \u000e so \u001f us\n\n[ctrl](java\u0000script:alert(1))',
    anchors: 0,
    textIncludes: ['nul'],
    textExcludes: ['script:'],
  },
  {
    name: 'bidi-override-chars',
    tags: ['bidi'],
    source: 'abc\u202e\u202d\u2066def\u2069 ghi\u202a\u202b\u202c jkl\u2067\u2068',
    anchors: 0,
    textIncludes: ['abc'],
  },
  {
    name: 'crlf-document',
    tags: ['crlf'],
    source: [
      '# CRLF heading',
      '',
      'Paragraph with **bold** and *em*.',
      '',
      '- one',
      '- two',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```js',
      'const crlf = true',
      '```',
    ].join('\r\n'),
    anchors: 0,
    textIncludes: ['CRLF heading', 'const crlf = true'],
  },
  {
    name: 'protocol-relative-link',
    tags: ['scheme-protocol-relative'],
    source: '[click](//evil.example/x)',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['evil.example'],
  },
  {
    name: 'fragment-link',
    tags: ['scheme-fragment'],
    source: '[click](#fragment)',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['fragment'],
  },
  {
    name: 'relative-link',
    tags: ['scheme-relative'],
    source: '[click](/relative/path)',
    anchors: 0,
    textIncludes: ['click'],
    textExcludes: ['relative'],
  },
  {
    name: 'image-tracker-src',
    tags: ['raw-html-img'],
    source: `![alt text](${KB63_IMAGE_FIXTURE_URL})`,
    anchors: 1,
    href: KB63_IMAGE_FIXTURE_URL,
    textIncludes: ['alt text'],
  },
  {
    name: 'hundred-kilo-byte-adversarial',
    tags: ['hundred-k'],
    source: kb63HundredKiloBytes(),
    anchors: 0,
    minElements: 1,
  },
]);

const KB63_REQUIRED_TAGS = Object.freeze([
  'raw-html-script',
  'raw-html-img',
  'raw-html-iframe',
  'raw-html-svg',
  'raw-html-math',
  'raw-html-style',
  'html-comment',
  'entity-encoded-tag',
  'scheme-javascript',
  'scheme-data',
  'scheme-vbscript',
  'scheme-file',
  'scheme-mixed-case',
  'scheme-whitespace',
  'scheme-tab',
  'scheme-entity',
  'link-title-injection',
  'nested-brackets',
  'emphasis-10k',
  'nested-lists-50',
  'nested-quotes-50',
  'malformed-table',
  'null-control',
  'bidi',
  'crlf',
  'hundred-k',
]);

test('KB-63 AC1 — the committed corpus is named and covers every required hostile category', () => {
  assert.ok(KB63_FIXTURES.length >= 25, `corpus has ${KB63_FIXTURES.length} fixtures (need >= 25)`);
  const names = KB63_FIXTURES.map((fixture) => fixture.name);
  assert.equal(new Set(names).size, names.length, 'fixture names are unique');
  const tags = new Set(KB63_FIXTURES.flatMap((fixture) => fixture.tags || []));
  for (const required of KB63_REQUIRED_TAGS) {
    assert.ok(tags.has(required), `corpus covers the "${required}" category`);
  }
  const hundredK = KB63_FIXTURES.find((fixture) => fixture.tags.includes('hundred-k'));
  assert.equal(hundredK.source.length, 100000, 'the 100k fixture is exactly 100,000 characters');
  const tenK = KB63_FIXTURES.find((fixture) => fixture.name === 'emphasis-run-10k');
  assert.equal(tenK.source.length, 10000, 'the emphasis fixture is exactly 10,000 characters');
  const deepLists = KB63_FIXTURES.find((fixture) => fixture.name === 'nested-lists-50');
  assert.equal(deepLists.source.split('\n').length, 50, 'the list fixture is 50 items deep');
  const deepQuotes = KB63_FIXTURES.find((fixture) => fixture.name === 'nested-quotes-50');
  assert.equal(deepQuotes.source.split('\n').length, 50, 'the quote fixture is 50 levels deep');
  console.log(`KB-63 AC1 corpus: ${KB63_FIXTURES.length} named fixtures across ${tags.size} categories`);
});

for (const fixture of KB63_FIXTURES) {
  test(`KB-63 AC1 — hostile fixture "${fixture.name}" parses and renders allowlisted elements only`, () => {
    let ast;
    assert.doesNotThrow(() => {
      ast = parse(fixture.source);
    }, `parse threw for ${fixture.name}`);
    assert.deepEqual(JSON.parse(JSON.stringify(ast)), JSON.parse(JSON.stringify(parse(fixture.source))), 'parse is deterministic');
    assertDeepFrozen(ast);
    assertCleanAst(ast);

    let tree;
    assert.doesNotThrow(() => {
      tree = markdown.render(ast, h);
    }, `render threw for ${fixture.name}`);
    assert.ok(Array.isArray(tree), 'render returns an array');
    assertCleanRender(tree);
    assertKb63SafeTree(tree, fixture.name);

    for (const forbidden of KB63_FORBIDDEN_ELEMENTS) {
      assert.equal(find(tree, forbidden).length, 0, `${fixture.name} never renders <${forbidden}>`);
    }

    const anchors = kb63Anchors(tree);
    assert.equal(anchors.length, fixture.anchors ?? 0, `${fixture.name} anchor count`);
    if (typeof fixture.href === 'string') {
      assert.equal(anchors[0].props.href, fixture.href, `${fixture.name} anchor href`);
      assert.equal(anchors[0].props.target, '_blank', `${fixture.name} anchor target`);
      assert.equal(anchors[0].props.rel, 'noopener noreferrer nofollow', `${fixture.name} anchor rel`);
    }
    if (anchors.length === 0) {
      assert.equal(elementsOf(tree).filter((node) => 'href' in (node.props || {})).length, 0, `${fixture.name} leaves no href`);
    }
    const renderedText = textOf(tree);
    for (const needle of fixture.textIncludes || []) {
      assert.ok(renderedText.includes(needle), `${fixture.name} renders its source text (${needle})`);
    }
    for (const needle of fixture.textExcludes || []) {
      assert.equal(renderedText.includes(needle), false, `${fixture.name} never leaks ${needle} as text`);
    }
    if (fixture.minElements) {
      assert.ok(elementsOf(tree).length >= fixture.minElements, `${fixture.name} parses into >= ${fixture.minElements} elements`);
    }
  });
}

test('KB-63 AC2 — http/https/mailto keep a trimmed, entity-decoded href with safe external attributes', () => {
  const safe = [
    ['http', '[http](http://example.com/x)', 'http://example.com/x'],
    ['https', '[https](https://example.com/x)', 'https://example.com/x'],
    ['mailto', '[mail](mailto:user@example.com)', 'mailto:user@example.com'],
    ['trimmed', '[trim](  https://example.com/trim  )', 'https://example.com/trim'],
    ['entity-decoded https', '[entity](&#104;ttps://example.com/decoded)', 'https://example.com/decoded'],
    ['entity-decoded mailto', '[entity](&#109;ailto:user@example.com)', 'mailto:user@example.com'],
    ['mixed-case safe scheme', '[case](HTTPS://example.com/case)', 'HTTPS://example.com/case'],
    ['angle destination', '[angle](<https://example.com/angle>)', 'https://example.com/angle'],
  ];
  for (const [label, markdownSource, expectedHref] of safe) {
    const tree = kb63ParseAndRender(markdownSource);
    assertKb63SafeTree(tree, label);
    const anchors = kb63Anchors(tree);
    assert.equal(anchors.length, 1, `${label}: one anchor`);
    assert.equal(anchors[0].props.href, expectedHref, `${label}: href`);
    assert.equal(anchors[0].props.target, '_blank', `${label}: target=_blank`);
    assert.equal(anchors[0].props.rel, 'noopener noreferrer nofollow', `${label}: rel`);
    assert.equal(textOf(anchors[0]), markdownSource.slice(1, markdownSource.indexOf(']')), `${label}: label stays the link text`);
  }

  const unsafe = [
    ['javascript', '[js](javascript:alert(1))'],
    ['javascript mixed case', '[js](JaVaScRiPt:alert(1))'],
    ['javascript tab', '[js](java\tscript:alert(1))'],
    ['javascript space', '[js](java script:alert(1))'],
    ['javascript newline', '[js](java\nscript:alert(1))'],
    ['javascript control', '[js](java\u0000script:alert(1))'],
    ['javascript entity', '[js](&#106;avascript:alert(1))'],
    ['javascript hex entity', '[js](&#x6a;avascript:alert(1))'],
    ['javascript escaped colon', '[js](javascript\\:alert(1))'],
    ['javascript entity colon', '[js](javascript&#58;alert(1))'],
    ['data', '[d](data:text/html;base64,PHNjcmlwdD4=)'],
    ['vbscript', '[v](vbscript:msgbox(1))'],
    ['file', '[f](file:///etc/passwd)'],
    ['ftp', '[f](ftp://evil.example/x)'],
    ['protocol-relative', '[p](//evil.example/x)'],
    ['fragment', '[f](#fragment)'],
    ['root-relative', '[r](/relative/path)'],
    ['dot-relative', '[r](./relative)'],
    ['query-only', '[q](?query=1)'],
    ['empty destination', '[e]()'],
    ['whitespace destination', '[w](   )'],
  ];
  for (const [label, markdownSource] of unsafe) {
    const tree = kb63ParseAndRender(markdownSource);
    assertKb63SafeTree(tree, label);
    assert.equal(kb63Anchors(tree).length, 0, `${label}: no <a> element`);
    assert.equal(elementsOf(tree).filter((node) => 'href' in (node.props || {})).length, 0, `${label}: no href anywhere`);
    const sourceLabel = markdownSource.slice(1, markdownSource.indexOf(']'));
    assert.ok(textOf(tree).includes(sourceLabel), `${label}: label renders as text`);
    assert.equal(find(tree, 'img').length, 0, `${label}: no <img>`);
  }

  // External attributes are non-negotiable on every anchor the engine emits.
  const mixed = kb63ParseAndRender('[one](https://one.example) [two](mailto:two@example.com) [bad](javascript:alert(1))');
  const anchors = kb63Anchors(mixed);
  assert.equal(anchors.length, 2);
  for (const anchor of anchors) {
    assert.equal(anchor.props.target, '_blank');
    assert.equal(anchor.props.rel, 'noopener noreferrer nofollow');
    assert.match(anchor.props.href, KB63_SAFE_SCHEME);
  }
});

test('KB-63 AC3 — images never become <img>/a request; safe src is a labelled anchor, unsafe is alt text only', () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    fetchCalls += 1;
    if (typeof originalFetch === 'function') return originalFetch(...args);
    throw new Error('network is not expected in the Markdown engine');
  };
  try {
    const safe = [
      ['https', '![alt text](https://example.com/i.png)', 'alt text', 'https://example.com/i.png'],
      ['http', '![alt text](http://example.com/i.png)', 'alt text', 'http://example.com/i.png'],
      ['mailto', '![alt text](mailto:user@example.com)', 'alt text', 'mailto:user@example.com'],
      ['empty alt falls back to src', '![](https://example.com/i.png)', 'https://example.com/i.png', 'https://example.com/i.png'],
      ['entity-decoded src', '![alt](&#104;ttps://example.com/i.png)', 'alt', 'https://example.com/i.png'],
    ];
    for (const [label, markdownSource, expectedLabel, expectedHref] of safe) {
      const tree = kb63ParseAndRender(markdownSource);
      assertKb63SafeTree(tree, label);
      assert.equal(find(tree, 'img').length, 0, `${label}: no <img> element`);
      assert.equal(elementsOf(tree).filter((node) => 'src' in (node.props || {})).length, 0, `${label}: no src attribute`);
      const anchors = kb63Anchors(tree);
      assert.equal(anchors.length, 1, `${label}: one anchor`);
      assert.equal(anchors[0].props.href, expectedHref, `${label}: href`);
      assert.equal(anchors[0].props.target, '_blank', `${label}: target`);
      assert.equal(anchors[0].props.rel, 'noopener noreferrer nofollow', `${label}: rel`);
      assert.equal(textOf(anchors[0]), expectedLabel, `${label}: anchor label`);
    }

    const unsafe = [
      ['javascript', '![alt text](javascript:alert(1))'],
      ['data', '![alt text](data:image/png;base64,xx)'],
      ['vbscript', '![alt text](vbscript:msgbox(1))'],
      ['file', '![alt text](file:///etc/passwd)'],
      ['protocol-relative', '![alt text](//evil.example/i.png)'],
      ['root-relative', '![alt text](/relative/i.png)'],
      ['fragment', '![alt text](#fragment)'],
    ];
    for (const [label, markdownSource] of unsafe) {
      const tree = kb63ParseAndRender(markdownSource);
      assertKb63SafeTree(tree, label);
      assert.equal(find(tree, 'img').length, 0, `${label}: no <img> element`);
      assert.equal(kb63Anchors(tree).length, 0, `${label}: no anchor`);
      assert.equal(elementsOf(tree).filter((node) => 'src' in (node.props || {})).length, 0, `${label}: no src`);
      assert.equal(textOf(tree), 'alt text', `${label}: only the alt text survives`);
    }

    const emptyUnsafe = kb63ParseAndRender('![](javascript:alert(1))');
    assert.equal(kb63Anchors(emptyUnsafe).length, 0, 'empty alt + unsafe src renders no anchor');
    assert.equal(textOf(emptyUnsafe), '', 'empty alt + unsafe src renders no text');

    // Raw HTML images stay literal text and are never parsed into an element.
    for (const raw of ['<img src="https://tracker.example/pixel.png">', '<img src=x onerror=alert(1)>']) {
      const tree = kb63ParseAndRender(raw);
      assertKb63SafeTree(tree, raw);
      assert.equal(find(tree, 'img').length, 0, 'raw HTML <img> never becomes an element');
      assert.ok(textOf(tree).includes(raw), 'raw HTML <img> stays literal text');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0, 'no Markdown fixture reaches the network');
});

test('KB-63 AC4 — the injection guard regex finds no HTML-string or dynamic-code path in client.js', () => {
  const guard = /dangerouslySetInnerHTML|innerHTML|outerHTML|document\.write|new Function|eval\(/g;
  const matches = source.match(guard) || [];
  assert.deepEqual(matches, [], `client.js must not match ${guard}`);
  for (const token of ['dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'document.write', 'new Function', 'eval(']) {
    assert.equal(source.includes(token), false, `client.js must not contain ${token}`);
  }
});

/** Deterministic >= 19,500-character realistic PRD: headings, lists, tables, fences, links. */
function buildKb63Prd(targetLength = 19700) {
  const headings = [
    'Vision',
    'Problem',
    'Users',
    'Jobs to be done',
    'Success metrics',
    'Scope in',
    'Scope out',
    'Acceptance criteria',
    'Risks',
    'Dependencies',
    'Rollout',
    'Open questions',
  ];
  const section = (index) =>
    [
      `Sentence one for section ${index}: **bold**, *em*, ~~strike~~ and \`inline code\`.`,
      '',
      `A second paragraph with a [link](https://example.com/prd/${index}) and an entity &amp; plus a <https://example.com/auto>.`,
      '',
      '- bullet one',
      '- bullet two',
      '  - nested bullet',
      '- [x] completed task',
      '- [ ] open task',
      '',
      '| Column A | Column B |',
      '| :--- | ---: |',
      '| value 1 | value 2 |',
      '',
      '```js',
      'const section = ' + index,
      'const markdown = true',
      '```',
      '',
    ].join('\n');
  let prd = '# EPIC PRD — KB-63 realistic fixture\n\n';
  let index = 0;
  while (prd.length < targetLength) {
    prd += `## ${headings[index % headings.length]}\n\n${section(index)}\n`;
    index += 1;
  }
  return prd;
}

test('KB-63 AC5 — deterministic 19,500+ char PRD parses at p50 <= 50 ms; 100k adversarial under 2 s', () => {
  const prd = buildKb63Prd();
  assert.ok(prd.length >= 19500, `PRD fixture length ${prd.length}`);
  assert.equal(prd, buildKb63Prd(), 'the PRD fixture is deterministic');

  // Warm the JIT once, then measure the 20-iteration p50 window.
  assert.ok(Array.isArray(markdown.render(parse(prd), h)));
  const samples = [];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const started = performance.now();
    const tree = markdown.render(parse(prd), h);
    samples.push(performance.now() - started);
    assert.ok(Array.isArray(tree), 'render returns an array');
  }
  const sorted = samples.slice().sort((left, right) => left - right);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = (sorted[9] + sorted[10]) / 2;
  console.log(
    `KB-63 AC5 parse table — ${prd.length}-char PRD, 20 iterations: min ${min.toFixed(2)} ms, p50 ${p50.toFixed(2)} ms, max ${max.toFixed(2)} ms`,
  );
  assert.ok(p50 <= 50, `PRD parse p50 ${p50.toFixed(2)} ms exceeds the 50 ms budget`);

  const adversarial = kb63HundredKiloBytes();
  assert.equal(adversarial.length, 100000);
  const started = performance.now();
  const tree = markdown.render(parse(adversarial), h);
  const elapsed = performance.now() - started;
  console.log(`KB-63 AC5 adversarial — ${adversarial.length} chars parse+render in ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 2000, `100k adversarial parse+render took ${elapsed.toFixed(1)} ms`);
  assert.ok(Array.isArray(tree) && tree.length > 0);
  assertKb63SafeTree(tree, '100k adversarial');
});

test('KB-63 AC7 — 100 parse+render cycles register zero timers/listeners and repeat deep-equal output', () => {
  const prd = buildKb63Prd();
  const counters = { setTimeout: 0, setInterval: 0, addEventListener: 0 };
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalAddEventListener = globalThis.addEventListener;
  let first = null;
  try {
    globalThis.setTimeout = (...args) => {
      counters.setTimeout += 1;
      return originalSetTimeout(...args);
    };
    globalThis.setInterval = (...args) => {
      counters.setInterval += 1;
      return originalSetInterval(...args);
    };
    globalThis.addEventListener = (...args) => {
      counters.addEventListener += 1;
      if (typeof originalAddEventListener === 'function') return originalAddEventListener.apply(globalThis, args);
      return undefined;
    };
    first = JSON.stringify(markdown.render(parse(prd), h));
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const tree = markdown.render(parse(prd), h);
      assert.equal(JSON.stringify(tree), first, `cycle ${cycle} output differs from the first render`);
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    if (originalAddEventListener === undefined) delete globalThis.addEventListener;
    else globalThis.addEventListener = originalAddEventListener;
  }
  assert.deepEqual(counters, { setTimeout: 0, setInterval: 0, addEventListener: 0 }, 'engine cycles register no timers or listeners');
});

test('KB-63 AC7 — MarkdownBodyContent memoizes parseMarkdown(text) on [text] so polls never re-parse the 20k PRD', () => {
  const memoContract = /const ast = React\.useMemo\(\(\) => parseMarkdown\(text\), \[text\]\)/.exec(source);
  assert.ok(memoContract, 'static contract: MarkdownBodyContent memoizes parseMarkdown(text) on [text]');

  const prd = buildKb63Prd(19500);
  counting.reset();
  const baseline = JSON.stringify(renderBody(prd));
  assert.equal(counting.stats.memoCalls, 1, 'the first render parses the 20k PRD once');
  for (let poll = 0; poll < 100; poll += 1) {
    const tree = renderBody(prd);
    assert.equal(JSON.stringify(tree), baseline, `poll-like render ${poll} produces the same output`);
  }
  assert.equal(counting.stats.memoCalls, 1, '100 poll-like renders reuse the memoized AST (no re-parse)');
  assert.ok(counting.stats.memoHits >= 100, `memo hits ${counting.stats.memoHits}`);

  renderBody(prd, { t: tZh });
  assert.equal(counting.stats.memoCalls, 1, 'a locale change re-decorates without parsing the PRD again');
});

// ===========================================================================
// KB-60 — Thoughts drawer: Markdown expanded, plain projection collapsed
//
// The shipped `ThoughtRowView` is materialized a third time through the gated
// `__KB60_THOUGHT_TEST__` seam with a stateful fake React, so the collapsed
// projection, the expanded `MarkdownBody` render, the failed/queued/cancelled
// control branches and the projection memo can be inspected without a DOM.
// ===========================================================================

function createRowRuntime() {
  const hooksByComponent = new Map();
  let currentComponent = null;
  const stats = { memoCalls: 0, memoHits: 0 };
  const hookEntry = (component) => {
    let entry = hooksByComponent.get(component);
    if (!entry) {
      entry = { hooks: [], cursor: 0 };
      hooksByComponent.set(component, entry);
    }
    return entry;
  };
  const sameDeps = (left, right) =>
    Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  const React = {
    Component: class Component {
      constructor(props) {
        this.props = props;
      }
    },
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const entry = hookEntry(currentComponent);
      const index = entry.cursor;
      entry.cursor += 1;
      if (!entry.hooks[index]) entry.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [entry.hooks[index].value, () => {}];
    },
    useEffect() {},
    useRef(initial) {
      const entry = hookEntry(currentComponent);
      const index = entry.cursor;
      entry.cursor += 1;
      if (!entry.hooks[index]) entry.hooks[index] = { current: typeof initial === 'function' ? initial() : initial };
      return entry.hooks[index];
    },
    useCallback: (fn) => fn,
    useMemo(factory, deps) {
      const entry = hookEntry(currentComponent);
      const index = entry.cursor;
      entry.cursor += 1;
      const previous = entry.hooks[index];
      if (previous && sameDeps(previous.deps, deps)) {
        stats.memoHits += 1;
        return previous.value;
      }
      stats.memoCalls += 1;
      const value = factory();
      entry.hooks[index] = { deps: Array.isArray(deps) ? deps : [], value };
      return value;
    },
  };
  const resolveTree = (node) => {
    if (Array.isArray(node)) return node.map(resolveTree);
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const previous = currentComponent;
      currentComponent = node.type;
      const entry = hookEntry(node.type);
      entry.cursor = 0;
      let result;
      try {
        const props = { ...node.props, children: node.children.length > 0 ? node.children : node.props.children };
        result = node.type(props);
      } finally {
        currentComponent = previous;
      }
      return resolveTree(result);
    }
    return { type: node.type, props: node.props, children: node.children.map(resolveTree) };
  };
  return {
    React,
    stats,
    render: (component, props) => resolveTree({ type: component, props: props || {}, children: [] }),
    reset() {
      hooksByComponent.clear();
      stats.memoCalls = 0;
      stats.memoHits = 0;
    },
  };
}

const rowRuntime = createRowRuntime();
globalThis.__KB60_THOUGHT_TEST__ = true;
let pluginKb60 = null;
try {
  pluginKb60 = captured.factory((name) => {
    if (name === 'react') return rowRuntime.React;
    throw new Error(`unexpected require ${name}`);
  });
} finally {
  delete globalThis.__KB60_THOUGHT_TEST__;
}
assert.equal(globalThis.__KB60_THOUGHT_TEST__, undefined, 'the KB-60 flag is not left behind');
assert.ok(pluginKb60.__thoughtRow, 'the gated KB-60 seam is exposed when the flag is set');
const ThoughtRowView = pluginKb60.__thoughtRow.ThoughtRowView;
const projectPreview = pluginKb60.__thoughtRow.project;

const KB60_FIXTURE = [
  '# Heading one',
  '## Heading two',
  '',
  'A paragraph with **bold**, *emphasis*, ~~struck~~, `inline code`, C# and issue #12, plus a paragraph | pipe.',
  '',
  '- first bullet',
  '- second bullet',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '> quoted line',
  '',
  '[the docs](https://example.com/docs)',
  '',
  '| Column one | Column two |',
  '| --- | --- |',
  '| cell one | cell two |',
  '',
  '```js',
  'const line = "a long fenced code line"',
  '```',
  '',
  '---',
].join('\n');
const KB60_EXPECTED = [
  'Heading one Heading two A paragraph with bold, emphasis, struck, inline code, C# and issue #12, plus a paragraph | pipe.',
  'first bullet second bullet ordered one ordered two quoted line the docs',
  'Column one Column two cell one cell two const line = "a long fenced code line"',
].join(' ');

const rowThought = {
  id: 'TH-60',
  text: KB60_FIXTURE,
  status: 'queued',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  sessionId: null,
  error: '',
  ticketIds: [],
};
const rowBaseProps = (overrides = {}) => ({
  t: tEn,
  thought: { ...rowThought },
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
  ...overrides,
});
const renderRow = (overrides = {}) => rowRuntime.render(ThoughtRowView, rowBaseProps(overrides));
const rowButtons = (tree) => find(tree, 'button');

test('KB60 seam — projection and row component are gated behind the flag', () => {
  assert.equal(plugin.__thoughtRow, undefined, 'the default plugin exposes no KB-60 seam');
  assert.equal(typeof projectPreview, 'function', 'the projection is a pure function');
  assert.equal(typeof ThoughtRowView, 'function', 'the row component is a function');
});

test('KB60 AC2 — projection strips block/inline syntax, keeps literals and code content', () => {
  assert.equal(projectPreview(KB60_FIXTURE), KB60_EXPECTED);
  assert.equal(projectPreview('C# and issue #12 and a paragraph | pipe'), 'C# and issue #12 and a paragraph | pipe');
  assert.equal(projectPreview('```js\n# not a heading\nconst x = 1 * 2 | 3\n```'), '# not a heading const x = 1 * 2 | 3');
  assert.equal(projectPreview('| a \\| b | c |\n| --- | --- |\n| d | e |'), 'a | b c d e');
  assert.equal(projectPreview('- one\n  - two\n    - three'), 'one two three', 'nested list bullets are stripped at any depth');
  assert.equal(projectPreview('- one\n\n    - nested loose'), 'one nested loose', 'a loose nested list item is still a list');
  assert.equal(projectPreview('    - code dash\n    const x = 1'), '- code dash const x = 1', 'indented code content survives');
  assert.equal(projectPreview('A paragraph.\n\n    - code dash'), 'A paragraph. - code dash', 'blank-separated indented code survives');
  assert.equal(projectPreview('a\r\nb'), 'a b');
  assert.equal(projectPreview('#\n\n---\n\n***\n\n```\n```\n\n==='), '', 'marker-only source projects to nothing');
  assert.equal(projectPreview(''), '');
  assert.equal(projectPreview(null), '');
  assert.equal(
    projectPreview(['## Which scope do you approve?', '', '- `client.js` only', '- [the shared spec](https://example.com/spec) as well', '', 'Reply with `yes` or `no`.'].join('\n')),
    'Which scope do you approve? client.js only the shared spec as well Reply with yes or no.',
    'the documented KB-59 answer-field projection is unchanged',
  );
  assert.equal(projectPreview(KB60_FIXTURE).includes('\n'), false, 'the projection is one line');
  assert.equal(projectPreview(KB60_FIXTURE), projectPreview(KB60_FIXTURE), 'the projection is deterministic');
  for (const marker of ['# Heading', '**', '`', '```', '](', '| --- |']) {
    assert.equal(KB60_EXPECTED.includes(marker), false, `projection still exposes ${marker}`);
  }
});

test('KB60 AC2 — inline Markdown inside table cells is stripped from the projection', () => {
  const source = ['| **Option** | `Cost` | [Docs](https://example.com/x) |', '| --- | --- | --- |', '| **A** | `1` | [see](https://example.com/a) |'].join('\n');
  assert.equal(projectPreview(source), 'Option Cost Docs A 1 see', 'table-cell emphasis, code and link labels project as text');
  for (const marker of ['**', '`', '](https://']) {
    assert.equal(projectPreview(source).includes(marker), false, `table-cell projection exposes ${marker}`);
  }
  assert.equal(projectPreview('| **A** \\| `B` | C |\n| --- | --- |\n| [D](https://example.com/d) | E |'), 'A | B C D E', 'an escaped pipe and an inline link in cells both survive as text');
});

test('KB60 AC2 — escaped literals, angle autolinks and ATX closing sequences project faithfully', () => {
  assert.equal(projectPreview('\\*literal\\* and \\`code\\`'), '*literal* and `code`', 'backslash-escaped punctuation survives literally');
  assert.equal(projectPreview('see <https://example.com/x> and <a@example.com>'), 'see https://example.com/x and a@example.com', 'angle autolinks drop the brackets, not the visible target');
  assert.equal(projectPreview('# Heading ##\n\n### Sub heading ###'), 'Heading Sub heading', 'ATX closing sequences are stripped');
  assert.equal(projectPreview('# C# rocks\n\nC# and a paragraph ##'), 'C# rocks C# and a paragraph ##', 'literal # outside an ATX closing sequence survives');
});

test('KB60 AC1 — expanded row renders heading, list, code, link and table through MarkdownBody', () => {
  rowRuntime.reset();
  const tree = renderRow({ expanded: true });
  const textNodes = byClass(tree, 'kb-thoughtText');
  assert.equal(textNodes.length, 1, 'one text container');
  assert.match(String(propsOf(textNodes[0]).className), /kb-thoughtText--expanded/, 'expanded drops the clamp class');
  assert.equal(byClass(tree, 'kb-md').length, 1, 'exactly one MarkdownBody wrapper');
  assert.ok(find(tree, 'h3').length >= 1, 'heading renders as a heading node');
  assert.ok(find(tree, 'ul').length >= 1, 'list renders as a list node');
  assert.equal(find(tree, 'pre').length, 1, 'fence renders as pre');
  assert.equal(find(tree, 'code').length >= 1, true, 'inline/fenced code renders as code nodes');
  assert.equal(find(tree, 'a').length, 1, 'link renders as an anchor');
  assert.equal(find(tree, 'table').length, 1, 'table renders as a table node');
  const visible = textOf(tree);
  assert.match(visible, /Heading one/, 'heading text is visible');
  assert.match(visible, /a long fenced code line/, 'code text is visible');
  assert.equal(visible.includes('**'), false, 'no raw emphasis markers');
  assert.equal(visible.includes('```'), false, 'no fence markers');
  assert.equal(visible.includes('](https://'), false, 'no raw link destination');
});

test('KB60 AC2 — collapsed row renders one plain-projection text node and no Markdown wrapper', () => {
  rowRuntime.reset();
  const tree = renderRow();
  const textNodes = byClass(tree, 'kb-thoughtText');
  assert.equal(textNodes.length, 1);
  assert.equal(propsOf(textNodes[0]).className, 'kb-thoughtText', 'collapsed keeps the clamped class only');
  assert.equal(byClass(tree, 'kb-md').length, 0, 'collapsed never mounts MarkdownBody');
  assert.equal(textOf(textNodes[0]), KB60_EXPECTED);
  for (const marker of ['# Heading', '**', '`', '```', '](', '| --- |']) {
    assert.equal(textOf(textNodes[0]).includes(marker), false, `collapsed preview still exposes ${marker}`);
  }
  assert.match(textOf(textNodes[0]), /C#/, 'literal C# survives');
});

test('KB60 AC2 — the projection is memoized on the thought text across re-renders', () => {
  assert.ok(
    /const preview = useMemo\(\(\) => markdownPlainLabel\(text\), \[text\]\)/.exec(source),
    'static contract: the row memoizes the projection on [text]',
  );
  rowRuntime.reset();
  renderRow();
  assert.equal(rowRuntime.stats.memoCalls, 1, 'first render projects once');
  renderRow();
  assert.equal(rowRuntime.stats.memoCalls, 1, 'an unchanged text reuses the memoized projection');
  renderRow({ thought: { ...rowThought, text: '# Other text' } });
  assert.equal(rowRuntime.stats.memoCalls, 2, 'a changed text projects again');
});

test('KB60 AC5 — failed/queued/cancelled rows keep their controls and the error stays plain', () => {
  const failed = renderRow({ thought: { ...rowThought, status: 'failed', error: 'the product manager session did not start' } });
  const failedButtons = rowButtons(failed).map((button) => textOf(button));
  assert.ok(failedButtons.includes('Retry'), 'failed row keeps Retry');
  assert.ok(failedButtons.includes('Edit'), 'failed row keeps Edit');
  assert.ok(failedButtons.includes('Delete'), 'failed row keeps Delete');
  assert.equal(failedButtons.includes('Cancel run'), false, 'failed row has no Cancel');
  assert.match(textOf(failed), /Failed/);
  const errorNodes = byClass(failed, 'kb-thoughtError');
  assert.equal(errorNodes.length, 1, 'error renders once');
  assert.equal(textOf(errorNodes[0]), 'the product manager session did not start', 'error text is exact');
  assert.equal(byClass(failed, 'kb-md').length, 0, 'the plain error is not wrapped in Markdown');

  const queued = renderRow();
  const queuedButtons = rowButtons(queued).map((button) => textOf(button));
  assert.ok(queuedButtons.includes('Edit') && queuedButtons.includes('Delete'), 'queued row keeps Edit/Delete');
  assert.equal(queuedButtons.includes('Retry') || queuedButtons.includes('Cancel run'), false);
  assert.match(textOf(queued), /Queued/);

  const cancelled = renderRow({ thought: { ...rowThought, status: 'cancelled' } });
  const cancelledButtons = rowButtons(cancelled).map((button) => textOf(button));
  assert.ok(cancelledButtons.includes('Edit') && cancelledButtons.includes('Delete'), 'cancelled row keeps Edit/Delete');
  assert.match(textOf(cancelled), /Cancelled/);
});

test('KB60 AC6 — expand control keeps aria-expanded and the localized Expand/Collapse label', () => {
  const collapsed = renderRow();
  const collapsedToggle = rowButtons(collapsed).find((button) => textOf(button) === 'Expand');
  assert.ok(collapsedToggle, 'collapsed row offers Expand');
  assert.equal(propsOf(collapsedToggle)['aria-expanded'], 'false');
  assert.equal(propsOf(collapsedToggle).type, 'button', 'native button keeps Space/Enter activation');

  const expanded = renderRow({ expanded: true });
  const expandedToggle = rowButtons(expanded).find((button) => textOf(button) === 'Collapse');
  assert.ok(expandedToggle, 'expanded row offers Collapse');
  assert.equal(propsOf(expandedToggle)['aria-expanded'], 'true');
});

test('KB60 AC7 — expanded Markdown aria labels stay localized through t', () => {
  const en = renderRow({ expanded: true });
  assert.equal(propsOf(find(en, 'pre')[0])['aria-label'], 'Code block');
  assert.equal(propsOf(byClass(en, 'kb-md-tableWrap')[0])['aria-label'], 'Table');
  assert.match(propsOf(find(en, 'a')[0])['aria-label'], /opens in a new tab/);

  const zh = renderRow({ expanded: true, t: tZh });
  assert.equal(propsOf(find(zh, 'pre')[0])['aria-label'], '代码块');
  assert.equal(propsOf(byClass(zh, 'kb-md-tableWrap')[0])['aria-label'], '表格');
  assert.match(propsOf(find(zh, 'a')[0])['aria-label'], /在新标签页打开/);
  assert.equal(propsOf(byClass(zh, 'kb-thoughtText')[0]).className, 'kb-thoughtText kb-thoughtText--expanded');
});
