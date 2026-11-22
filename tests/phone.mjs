// A phone for the tests: headless Chrome emulating a landscape phone (touch, tilt sensor, screen
// rotation), driven over the DevTools protocol, plus XInput to read the virtual controller back the
// way a game does. Each suite gets a fresh PC host from run.mjs, so it is always controller 1.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
export const W = 860, H = 400;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** @param {string} out folder for the browser profile and screenshots */
export async function openPhone(out, port = 9336) {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(out, 'profile')}`, '--no-first-run', 'about:blank']);
  let targets;
  for (let i = 0; i < 50 && !targets; i++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await sleep(200); }
  }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => (ws.onopen = r));

  let id = 0, failures = 0;
  const pending = new Map(), problems = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id) return pending.get(m.id)?.(m);
    if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ` + m.params.args.map(a => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url ?? ''));
  };
  const cdp = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const js = async expression => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  /** Center and box of the first visible match, in viewport pixels. */
  const rect = sel => js(`(() => { const el = [...document.querySelectorAll('${sel}')].find(e => e.offsetParent || e.getClientRects().length); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom }; })()`);

  const phone = {
    cdp, js, rect,
    async click(sel) {
      const r = await rect(sel);
      if (!r) throw new Error('not visible: ' + sel);
      for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    },
    /** @param {'touchStart'|'touchMove'|'touchEnd'} type @param {[number, number][]} points one per finger */
    touch: (type, points) => cdp('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i })) }),
    /** Fakes the tilt sensor: beta is the tilt, in degrees, while held in landscape. */
    tilt: beta => cdp('DeviceOrientation.setDeviceOrientationOverride', { alpha: 0, beta, gamma: 0 }),
    /** Screen size and rotation, as the phone's browser reports them. */
    screen: (width, height, type, angle) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true, screenOrientation: { type, angle } }),
    shot: async name => writeFileSync(join(out, `${name}.png`), Buffer.from((await cdp('Page.captureScreenshot')).result.data, 'base64')),
    /** Controller 1 as Windows sees it, e.g. "controller 1: buttons=0x0000 LT=0 RT=255 LX=16384 LY=0". */
    xinput: () => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'xinput.ps1')]).toString().trim().split('\n')[0].trim(),
    /** Rumbles controller 1 the way a game does. Steps are 'left:right:ms', motors 0-65535. */
    rumble: (...steps) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'xinput.ps1'), 'rumble', ...steps]),
    check(label, ok, detail = '') {
      if (!ok) failures++;
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  -> ' + detail : ''}`);
    },
    /** Opens the QR link, passes the certificate warning the way a person does, waits for the picker. */
    async connect(url) {
      await cdp('Page.navigate', { url });
      await sleep(1500);
      if (!(await js('!!document.querySelector("#player")'))) {
        await js('document.getElementById("details-button").click(); document.getElementById("proceed-link").click(); true');
        await sleep(2500);
      }
      for (let i = 0; i < 24; i++) {
        await sleep(500);
        if (await js('!document.querySelector("#picker").hidden')) return;
      }
    },
    /** Reports page errors, closes the browser and exits non-zero if anything failed. */
    finish() {
      console.log(problems.length ? 'PAGE PROBLEMS:\n  ' + problems.join('\n  ') : 'no page errors or warnings');
      ws.close();
      chrome.kill();
      process.exit(failures || problems.length ? 1 : 0);
    },
  };
  await cdp('Runtime.enable');
  await cdp('Log.enable');
  await cdp('Page.enable');
  await phone.screen(W, H, 'landscapePrimary', 90);
  await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await phone.tilt(0);
  return phone;
}
