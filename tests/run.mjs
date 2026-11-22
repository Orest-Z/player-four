// Runs every phone test end to end: starts the PC host, plays a phone in headless Chrome over the
// real HTTPS + WebRTC path, and reads the virtual Xbox controller back through XInput like a game.
// Needs Windows with ViGEmBus and Chrome. Builds the PC app first (the phone app is packed into it).
// usage: node tests/run.mjs   Screenshots land in a temp folder, printed at the end.
//   PLAYER_FOUR_EXE=<path to an .exe> tests that program instead, e.g. the packed download.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const host = process.env.PLAYER_FOUR_EXE ?? join(root, 'pc', 'target', 'release', 'player-four.exe');
const out = mkdtempSync(join(tmpdir(), 'player-four-tests-'));
let failed = 0;

if (!process.env.PLAYER_FOUR_EXE) {
  console.log('== build');
  const build = spawnSync('cargo', ['build', '--release', '--quiet', '--manifest-path', join(root, 'pc', 'Cargo.toml')], { stdio: 'inherit' });
  if (build.status !== 0) process.exit(1);
}

console.log('== types (strict TypeScript over the JSDoc-typed phone app)');
const types = spawnSync(`npx -y -p typescript@5 tsc -p "${join(root, 'phone')}"`, { stdio: 'inherit', shell: true });
if (types.status !== 0) failed++;
else console.log('no type errors');

for (const suite of ['racing.mjs', 'rotate.mjs']) {
  // A fresh host per suite, so its phone is always player 1 and controller 1.
  const pc = spawn(host, [], { cwd: dirname(host) });
  const url = await new Promise((resolve, reject) => {
    let text = '';
    pc.stdout.on('data', d => {
      text += d;
      const qr = text.match(/https:\/\/\S+#u=\S+/);
      if (qr) resolve(qr[0]);
    });
    pc.on('exit', code => reject(new Error(`PC host exited (${code}) before printing its QR link:\n${text}`)));
  });
  console.log(`\n== ${suite}`);
  const dir = mkdtempSync(join(out, suite.replace('.mjs', '-')));
  if (spawnSync(process.execPath, [join(import.meta.dirname, suite), url, dir], { stdio: 'inherit' }).status !== 0) failed++;
  pc.kill();
  await new Promise(r => pc.once('exit', r));
}

console.log(`\n${failed ? `${failed} suite(s) FAILED` : 'all suites passed'}. Screenshots: ${out}`);
process.exit(failed ? 1 : 0);
