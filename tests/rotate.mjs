// The phone auto-rotating mid-corner while tilt steering: the page must turn itself back, steering
// must not jump, and pedals and buttons must still work in the turned page.
// usage: node tests/rotate.mjs <qr-url> <out-dir>   (run.mjs does this for you)
import { openPhone, sleep, W, H } from './phone.mjs';

const [url, out] = process.argv.slice(2);
const { connect, js, rect, click, touch, tilt, screen, shot, xinput, check, finish } = await openPhone(out, 9337);

await connect(url);
await click('[data-pick="racing"]');
await sleep(300);
await click('.steer-switch [data-value="tilt"]');
await sleep(600);
await tilt(18);
await sleep(250);
let x = xinput();
check('landscape: tilt 18° → 50% right', /LX=16[0-9]{3} /.test(x), x);

/** The browser auto-rotates the page, as a phone does when tilted far enough. @param {'portraitPrimary'|'portraitSecondary'|'landscapePrimary'} type @param {number} angle */
const osRotate = async (type, angle) => {
  const portrait = type.startsWith('portrait');
  await screen(portrait ? H : W, portrait ? W : H, type, angle);
  await sleep(400);
};
/** Touch a pedal `up` of the way up, where "up" on screen is `dir`: +1 = screen right, -1 = screen left. */
const pedalPoint = (r, up, dir) => [dir > 0 ? r.l + r.w * up : r.l + r.w * (1 - up), r.t + r.h / 2];

for (const [type, angle, turn, dir] of [['portraitPrimary', 0, '90', 1], ['portraitSecondary', 180, '270', -1]]) {
  await osRotate(type, angle);
  check(`${type}: page turned back by ${turn}°`, (await js('document.documentElement.dataset.turn')) === turn, await js('document.documentElement.dataset.turn'));
  check(`${type}: no "turn your phone" screen`, await js('getComputedStyle(document.querySelector("#rotate")).display === "none"'));
  x = xinput();
  check(`${type}: steering didn't jump (still 50% right)`, /LX=16[0-9]{3} /.test(x), x);
  await shot(`turn-${turn}`);
  const g = await rect('.tilt-layout .gas'), b = await rect('.tilt-layout .brake');
  check(`${type}: pedals are tall in the turned page`, g.w > g.h, JSON.stringify(g));
  await touch('touchStart', [pedalPoint(g, 0.8, dir), pedalPoint(b, 0.3, dir)]);
  await sleep(250);
  x = xinput();
  check(`${type}: gas 93% + brake 27% read along the turned pedals`, /LT=6[6-9] RT=23[6-9] /.test(x), x);
  await touch('touchEnd', []);
  await sleep(150);
  const c = await rect('.tilt-layout [data-action="center"]');
  check(`${type}: Center is under its own spot`, await js(`document.elementFromPoint(${c.x}, ${c.y})?.closest('[data-action="center"]') !== null`));
  check(`${type}: nothing spills off the screen`, await js(`[...document.querySelectorAll("main:not([hidden]) *:not(.wheel, .wheel *), .bar *")].every(e => { const r = e.getBoundingClientRect(); return r.width === 0 || (r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1); })`));
}

await osRotate('landscapePrimary', 90);
check('back to landscape: page not turned', (await js('document.documentElement.dataset.turn')) === undefined);
x = xinput();
check('back to landscape: still 50% right', /LX=16[0-9]{3} /.test(x), x);
await shot('turn-back');

// Leaving tilt lets the phone rotate normally again.
await click('.steer-switch [data-value="touch"]');
await sleep(300);
await osRotate('portraitPrimary', 0);
check('touch wheel: portrait asks to turn the phone again', (await js('document.documentElement.dataset.turn')) === undefined && await js('getComputedStyle(document.querySelector("#rotate")).display !== "none"'));

finish();
