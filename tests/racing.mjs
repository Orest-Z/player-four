// Racing and every layout, end to end: the real HTTPS certificate warning, touch wheel, analog
// pedals, tilt steering, settings, the other layouts, a small phone and portrait.
// usage: node tests/racing.mjs <qr-url> <out-dir>   (run.mjs does this for you)
import { openPhone, sleep, W, H } from './phone.mjs';

const [url, out] = process.argv.slice(2);
const { cdp, connect, js, rect, click, touch, tilt, screen, shot, xinput, check, finish } = await openPhone(out, 9336);

// 1. Through the certificate warning, as a person would ("Advanced", "Proceed").
await connect(url);
check('page loaded past the certificate warning', await js('!!document.querySelector("#player")'));
check('secure context (tilt allowed)', await js('window.isSecureContext'));
check('DeviceOrientationEvent available', await js('"DeviceOrientationEvent" in window'));
check('pointerrawupdate available', await js('"onpointerrawupdate" in window'));
check('connected and picker shown', await js('!document.querySelector("#picker").hidden && document.querySelector("#connecting").hidden'));
await sleep(1200);
check('player number + latency shown', /P\d/.test(await js('document.querySelector("#player").textContent')), await js('document.querySelector("#player").textContent + " " + document.querySelector("#net-text").textContent'));
await shot('1-picker');


// 2. Racing, touch wheel + analog pedals.
await click('[data-pick="racing"]');
await sleep(300);
await shot('2-racing-touch');
const wheel = await rect('#wheel-zone'), gas = await rect('.touch-layout .gas'), brake = await rect('.touch-layout .brake');
const travel = await js('innerWidth') * (0.42 - (5 * 0.3) / 9); // default sensitivity 6
const steerPt = [wheel.x + travel * 0.5, wheel.y];
const gasHalf = [gas.x, gas.b - gas.h * 0.5]; // halfway up → (0.5 - 0.1) / 0.75 = 53% → 136
await touch('touchStart', [[wheel.x, wheel.y]]);
await touch('touchMove', [steerPt]);
await touch('touchStart', [steerPt, gasHalf]);
await sleep(250);
let x = xinput();
check('touch: steer half right + gas halfway', /RT=13[4-8] LX=16[0-9]{3} /.test(x), x);
await shot('3-racing-touch-pressed');
await touch('touchMove', [steerPt, [brake.x, brake.b - brake.h * 0.92]]);
await sleep(250);
x = xinput();
check('touch: slide gas → brake near top (100%)', /LT=255 RT=0 LX=16[0-9]{3} /.test(x), x);
await touch('touchMove', [[wheel.x - travel * 3, wheel.y], [brake.x, brake.b - brake.h * 0.92]]);
await touch('touchMove', [[wheel.x - travel * 3 + travel * 0.25, wheel.y], [brake.x, brake.b - brake.h * 0.92]]);
await sleep(250);
x = xinput();
check('touch: past full lock then back a quarter → 75% left at once', /LX=-24[0-9]{3} /.test(x), x);
await touch('touchEnd', []);
await sleep(250);
x = xinput();
check('touch: release → neutral', /buttons=0x0000 LT=0 RT=0 LX=0 LY=0/.test(x), x);

// 3. Tilt steering (Chrome fakes the phone's sensors).
await click('.steer-switch [data-value="tilt"]');
await sleep(600);
check('tilt layout on', (await js('document.body.dataset.steering')) === 'tilt', await js('document.querySelector("#toast").textContent'));
await tilt(18); // landscape, right end 18° lower → (18 - 1) / (35 - 1) = 50% right
await sleep(250);
x = xinput();
check('tilt: 18° → steer 50% right', /LX=16[0-9]{3} /.test(x), x);
const tg = await rect('.tilt-layout .gas'), tb = await rect('.tilt-layout .brake');
await touch('touchStart', [[tb.x, tb.b - tb.h * 0.3], [tg.x, tg.b - tg.h * 0.8]]);
await sleep(250);
x = xinput();
check('tilt: brake 27% and gas 93% at the same time', /LT=6[6-9] RT=23[6-9] /.test(x), x);
await shot('4-racing-tilt-pressed');
await touch('touchEnd', []);
await tilt(-35);
await sleep(250);
x = xinput();
check('tilt: -35° → full left', /LX=-32767 /.test(x), x);
await tilt(10);
await sleep(250);
const centerBtn = await rect('.tilt-layout [data-action="center"]');
check('Center button is tappable while the wheel is turned', (await js(`document.elementFromPoint(${centerBtn.x}, ${centerBtn.y})?.closest('[data-action="center"]') !== null`)));
await click('.tilt-layout [data-action="center"]');
await sleep(250);
x = xinput();
check('tilt: Center makes the current tilt straight ahead', /LX=0 /.test(x), x);
await tilt(0);
await sleep(200);

// 4. Settings sheet, starting with a name and color, which stay on this phone.
await click('#settings-btn');
await sleep(400);
await click('#s-name');
await cdp('Input.insertText', { text: 'Sara' });
await click('.swatches input[value="ec4899"]');
await sleep(200);
const saved = JSON.parse(await js('localStorage.getItem("playerfour.settings")'));
check('name and color saved on the phone', saved.name === 'Sara' && saved.color === 'ec4899', `${saved.name} #${saved.color}`);
check('the controller takes the chosen color', (await js('getComputedStyle(document.documentElement).getPropertyValue("--p").trim()')) === '#ec4899');
await shot('5-settings');
await click('.sheet .done');
await sleep(200);
check('settings closes', await js('document.querySelector("#settings").hidden'));

// 5. The other layouts.
for (const mode of ['party', 'retro', 'full']) {
  await click('#mode-btn');
  await sleep(150);
  await click(`[data-pick="${mode}"]`);
  await sleep(300);
  await shot(`6-${mode}`);
}
x = xinput();
check('leaving racing turns tilt off (stick stays centered)', /LX=0 /.test(x), x);

check('steering switch hidden outside racing', await js('getComputedStyle(document.querySelector(".steer-switch")).display === "none"'));

// 6. A small phone (740×360): racing in both steering modes and the picker must still fit.
await screen(740, 360, 'landscapePrimary', 90);
await click('#mode-btn');
await sleep(200);
await shot('8-small-picker');
await click('[data-pick="racing"]');
await sleep(600);
await shot(`8-small-racing-${await js('document.body.dataset.steering')}`);
await click('.steer-switch [data-value="touch"]');
await sleep(300);
await shot('8-small-racing-touch');
check('small phone: nothing spills past the screen', await js('[...document.querySelectorAll("main:not([hidden]) *, .bar *")].every(e => { const r = e.getBoundingClientRect(); return r.width === 0 || (r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1); })'));

// 7. Portrait shows the rotate prompt.
await screen(H, W, 'portraitPrimary', 0);
await sleep(300);
await shot('7-portrait');
check('portrait shows "turn your phone"', await js('getComputedStyle(document.querySelector("#rotate")).display !== "none"'));


finish();
