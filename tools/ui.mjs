import { readFile } from 'node:fs/promises';
import { attach } from './cdp.mjs';

const [command, ...args] = process.argv.slice(2);
const app = await attach();

const run = async () => {
  switch (command) {
    case 'ensure': {
      await app.ensureApp({ reload: args[0] === 'reload' });
      console.log('ENSURED title=' + (await app.evaluate('document.title')));
      return;
    }
    case 'shot': {
      if (!(await app.evaluate(`!!document.body && document.body.innerText.includes('New Session')`).catch(() => false))) {
        await app.ensureApp();
      }
      const path = args[0] || '.ui/shot.png';
      await app.screenshot(path);
      console.log('SHOT ' + path);
      return;
    }
    case 'eval': {
      const code = await readFile(args[0], 'utf8');
      const value = await app.evaluate(code);
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
      return;
    }
    case 'click': {
      const mode = args[0] || 'text';
      if (mode === 'exact') {
        const text = JSON.stringify(args[1] || '');
        const ok = await app.evaluate(`(() => {
          const nodes = [...document.querySelectorAll('button,a,[role=button],li,span,div')];
          const el = nodes.find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (n.textContent || '').trim() === ${text}; });
          if (!el) return false;
          (el.closest('button,a,[role=button]') || el).click();
          return true;
        })()`, { userGesture: true });
        console.log('CLICK ' + (ok ? 'ok' : 'not-found'));
        return;
      }
      console.log('CLICK ' + (await app.clickText(args[1] || args[0] || '')));
      return;
    }
    case 'text': {
      console.log(await app.evaluate('document.body.innerText'));
      return;
    }
    case 'errors': {
      console.log(JSON.stringify(await app.errors(), null, 1));
      return;
    }
    default:
      console.log('usage: ensure [reload] | shot [path] | eval <file> | click [exact] <text> | text | errors');
  }
};

await run();
process.exit(0);
