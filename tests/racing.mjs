// Racing and every layout, end to end: the real HTTPS certificate warning, touch wheel, analog
// pedals, tilt steering, settings, the other layouts, a small phone and portrait.
// usage: node tests/racing.mjs <qr-url> <out-dir>   (run.mjs does this for you)
import { openPhone, sleep, W, H } from './phone.mjs';

const [url, out] = process.argv.slice(2);
const { cdp, connect, js, rect, click, touch, tilt, screen, shot, xinput, rumble, check, finish } = await openPhone(out, 9336);

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


// 2. Racing: the touch wheel, turned like a real wheel, and analog pedals.
await click('[data-pick="racing"]');
await sleep(300);
await shot('2-racing-touch');
const hub = await rect('#wheel-zone .wheel-wrap'), gas = await rect('.touch-layout .gas'), brake = await rect('.touch-layout .brake');
const grip = (Math.min(hub.w, hub.h) / 2) * 0.7;
/** Where a thumb on the wheel's rim is, at deg clockwise from 12 o'clock. */
const rim = deg => [hub.x + grip * Math.sin((deg * Math.PI) / 180), hub.y - grip * Math.cos((deg * Math.PI) / 180)];
/** Turns the thumb around the wheel from one angle to another in small steps, other fingers held. */
const turnWheel = async (from, to, others = []) => {
  const steps = Math.ceil(Math.abs(to - from) / 15);
  for (let i = 1; i <= steps; i++) await touch('touchMove', [rim(from + ((to - from) * i) / steps), ...others]);
};
const gasHalf = [gas.x, gas.b - gas.h * 0.5]; // halfway up → (0.5 - 0.1) / 0.75 = 53% → 136
const brakeTop = [brake.x, brake.b - brake.h * 0.92];
await touch('touchStart', [rim(0)]);
await turnWheel(0, 90); // a quarter turn on the default 360° wheel: half of the 180° to full lock
await touch('touchStart', [rim(90), gasHalf]);
await sleep(250);
let x = xinput();
check('touch: a quarter turn steers half right, gas halfway', /RT=13[4-8] LX=16[0-9]{3} /.test(x), x);
await shot('3-racing-touch-pressed');
await touch('touchMove', [rim(90), brakeTop]);
await sleep(250);
x = xinput();
check('touch: slide gas → brake near top (100%)', /LT=255 RT=0 LX=16[0-9]{3} /.test(x), x);
await turnWheel(90, 270, [brakeTop]); // stops at full lock, 180°
await turnWheel(270, 225, [brakeTop]); // back 45° → 135° of 180°
await sleep(250);
x = xinput();
check('touch: past full lock then back 45° → 75% at once', /LX=24[0-9]{3} /.test(x), x);
await touch('touchEnd', []);
await sleep(450);
x = xinput();
check('touch: let go → the wheel springs back to center', /buttons=0x0000 LT=0 RT=0 LX=0 LY=0/.test(x), x);

// A 900° wheel, as in Euro Truck Simulator 2: a full turn is 80%, and re-gripping hand over hand
// keeps the wheel where it was.
await click('#settings-btn');
await sleep(400);
await click('.presets [data-rotation="900"]');
await click('.sheet .done');
await sleep(200);
await touch('touchStart', [rim(0)]);
await turnWheel(0, 360);
await sleep(200);
x = xinput();
check('900° wheel: one full turn → 80%', /LX=26[0-9]{3} /.test(x), x);
await touch('touchEnd', []);
await sleep(100); // re-grip quickly
await touch('touchStart', [rim(0)]);
await turnWheel(0, 90);
await sleep(200);
x = xinput();
check('900° wheel: re-grip and turn on → full lock at 450°', /LX=32767 /.test(x), x);
await touch('touchEnd', []);
await sleep(800);
x = xinput();
check('900° wheel: let go → back to center', /LX=0 /.test(x), x);

// Sliding instead of turning still works.
await click('#settings-btn');
await sleep(400);
await click('input[name="wheelStyle"][value="slide"]');
await click('.sheet .done');
await sleep(200);
const zone = await rect('#wheel-zone');
const travel = (await js('innerWidth')) * (0.42 - (5 * 0.3) / 9); // default sensitivity 6
await touch('touchStart', [[zone.x, zone.y]]);
await touch('touchMove', [[zone.x + travel * 0.5, zone.y]]);
await sleep(200);
x = xinput();
check('slide wheel: half the travel → half right', /LX=16[0-9]{3} /.test(x), x);
await touch('touchEnd', []);
await sleep(200);

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

// 5. Rumble: a game shakes controller 1 and the phone vibrates, again and again while it lasts,
// harder for stronger rumble, until the game stops. Every vibration the phone makes is logged.
await js('window.buzzes = []; navigator.vibrate = p => (window.buzzes.push(p), true); true');
rumble('65535:0:700', '16000:8000:700', '0:0:200'); // full, lighter, off
await sleep(300);
const buzzes = JSON.parse(await js('JSON.stringify(window.buzzes)'));
const solid = buzzes.filter(b => b === 250), pulses = buzzes.filter(Array.isArray);
const shown = JSON.stringify(buzzes.map(b => (Array.isArray(b) ? b.slice(0, 2) : b)));
check('rumble: full rumble buzzes solidly, again and again while it lasts', solid.length >= 4, shown);
check('rumble: lighter rumble buzzes in shorter pulses', pulses.length >= 4 && pulses.every(p => p[0] === 15 && p[1] === 25));
check('rumble: in the order the game asked, then stops', buzzes.indexOf(250) < buzzes.findIndex(Array.isArray) && buzzes.at(-1) === 0);

// 6. The other layouts.
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

// 7. A small phone (740×360): racing in both steering modes and the picker must still fit.
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

// 8. Portrait shows the rotate prompt.
await screen(H, W, 'portraitPrimary', 0);
await sleep(300);
await shot('7-portrait');
check('portrait shows "turn your phone"', await js('getComputedStyle(document.querySelector("#rotate")).display !== "none"'));


finish();
