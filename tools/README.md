# Browser UI self-test harness

Drives the real DSH Web GUI in headless Chrome over the Chrome DevTools Protocol,
so the plugin can be exercised end-to-end without a human at the keyboard.

- `cdp.mjs` — tiny CDP client. Mints the same signed browser-session cookie the Host
  issues (`$DSH_HOME/.credentials.yaml` secret, HMAC-SHA256, authority-bound), attaches
  to Chrome, and provides `evaluate`, `clickText`, `type`, `key`, `mouse`, `drag`,
  `screenshot`, `waitFor`, and console/exception collection.
- `ui.mjs` — CLI: `ensure [reload]`, `shot <path>`, `eval <file>`, `click [exact] <text>`,
  `text`, `errors`.

Launch Chrome once (kept outside the sandbox so it can use its own caches):

```bash
mkdir -p .cdp-profile .chrome-home .chrome-tmp
HOME="$PWD/.chrome-home" TMPDIR="$PWD/.chrome-tmp" \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9333 --user-data-dir="$PWD/.cdp-profile" \
  --no-first-run --no-default-browser-check --no-sandbox --disable-gpu \
  --disable-software-rasterizer --disable-breakpad --disable-crash-reporter \
  --disable-dev-shm-usage --in-process-gpu --window-size=1440,900 about:blank &
```

Then, from the repository root:

```bash
node dsh-kanban/tools/ui.mjs ensure
node dsh-kanban/tools/ui.mjs shot .ui/home.png
node dsh-kanban/tools/ui.mjs eval .ui/probe.js
```

`ensure` opens the GUI, exchanges the signed cookie, waits for the shell, and installs
an error collector. Reuse the same Chrome across invocations to keep UI state.
