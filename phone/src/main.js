// @ts-check
// Entry point: wires the controls, the link to the PC and the screens together.
import { neutralPad, encode } from './protocol/pad.js';
import { connect } from './link/link.js';
import { bindButtons, bindTriggers, bindSticks, bindDpads } from './input/touch.js';
import { bindPedals, configurePedals } from './input/pedals.js';
import { createSteering } from './input/steering.js';
import { setHaptics, setRumble, rumble, canVibrate } from './input/haptics.js';
import { initShell } from './screens/shell.js';
import { initModes } from './screens/modes.js';
import { initRacing } from './screens/racing.js';
import { loadSettings, saveSettings, initSettingsSheet, travelFor } from './screens/settings.js';

/** Resend the full state this often even when nothing changes: repairs lost packets and tells the PC we're here. */
const HEARTBEAT_MS = 100;

const pad = neutralPad();
let seq = 0;
/** @type {{ send(packet: ArrayBuffer): void } | null} */
let link = null;
const changed = () => link?.send(encode(pad, ++seq));

const shell = initShell(document);
const steering = createSteering(pad, changed);
const racing = initRacing(document, steering);
const settings = loadSettings();

function applySettings() {
  steering.configure({
    travel: travelFor(settings.sensitivity),
    tiltRange: settings.tiltRange,
    tiltInvert: settings.tiltInvert,
    precision: settings.precision / 100,
  });
  configurePedals({ analog: settings.pedals === 'analog' });
  setHaptics(settings.haptics);
  setRumble(settings.rumble);
  shell.setColor(settings.color);
  document.body.dataset.pedals = settings.pedals;
}

/**
 * Switches racing steering between the touch wheel and tilt. Must run inside a tap: iPhones only
 * ask for motion permission from one.
 * @param {'touch' | 'tilt'} kind
 */
async function useSteering(kind) {
  settings.steering = kind;
  racing.showSteering(kind);
  sheet.refresh();
  if (kind === 'tilt') {
    const pending = steering.enableTilt(); // first: iPhones ask for motion access within this tap
    // Tilting a phone like a wheel makes it auto-rotate. Full screen lets Android lock rotation;
    // where nothing can (iPhones), steering holds its frame and the page turns itself back.
    void shell.fullscreen();
    const result = await pending;
    if (result !== 'ok') {
      shell.toast(result === 'denied'
        ? 'Motion access was declined, so the touch wheel is back. Allow it in Safari settings to use tilt.'
        : "This browser isn't sharing tilt readings, so the touch wheel is back.");
      return useSteering('touch');
    }
    shell.toast('Tilt steering on. Hold the phone level, or tap Center.');
  } else {
    steering.disableTilt();
  }
  saveSettings(settings);
}

const sheet = initSettingsSheet(document, settings, (key, value) => {
  if (key === 'steering') return void useSteering(value);
  /** @type {any} */ (settings)[key] = value;
  saveSettings(settings);
  applySettings();
});

const modes = initModes(document, mode => {
  if (mode === 'racing' && settings.steering === 'tilt') void useSteering('tilt'); // goes full screen too
  else {
    if (mode !== 'racing') steering.disableTilt(); // tilt must not steer the other layouts
    void shell.fullscreen();
  }
  void shell.keepAwake();
});

for (const el of document.querySelectorAll('[data-action="steer"]')) {
  el.addEventListener('click', () => {
    const kind = /** @type {'touch' | 'tilt'} */ (/** @type {HTMLElement} */ (el).dataset.value);
    if (kind !== steering.kind) void useSteering(kind);
  });
}
for (const el of document.querySelectorAll('[data-action="center"]')) {
  el.addEventListener('click', () => {
    steering.center();
    shell.toast('Centered: this is straight ahead now.');
  });
}

if (!canVibrate()) {
  const row = document.querySelector('#haptics-row');
  row?.classList.add('disabled');
  for (const input of row?.querySelectorAll('input') ?? []) input.setAttribute('disabled', '');
  for (const note of row?.querySelectorAll('.note') ?? []) note.remove();
  row?.insertAdjacentHTML('beforeend', `<p class="note">This phone's browser can't vibrate. iPhones don't let web pages vibrate at all.</p>`);
}

applySettings();
racing.showSteering('touch'); // tilt turns on from the first tap, if it was the saved choice
bindButtons(document, pad, changed);
bindTriggers(document, pad, changed);
bindSticks(document, pad, changed);
bindDpads(document, pad, changed);
bindPedals(document, pad, changed);
steering.bindWheel(/** @type {Element} */ (document.querySelector('#wheel-zone')));

// Let go of everything when the phone locks or switches apps; the PC also does this on its own
// if packets stop arriving.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  Object.assign(pad, neutralPad());
  changed();
});
// No pinch-zoom or double-tap zoom on iOS, where touch-action alone doesn't stop them.
document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault());

let opened = false;
shell.setLink('connecting');
try {
  link = await connect(location.hash, {
    onStatus(status) {
      shell.setLink(status);
      if (status === 'open' && !opened) {
        opened = true;
        modes.open();
      }
      if (status === 'lost') {
        Object.assign(pad, neutralPad());
        steering.disableTilt();
      }
    },
    onPong(ms, player) {
      shell.setLatency(ms);
      shell.setPlayer(player);
    },
    onRumble: rumble,
    // "<doing> <color or -> <name>", read by the PC's window (pc/src/main.rs, drive()).
    about() {
      const doing = !document.querySelector('#picker')?.hasAttribute('hidden') ? 'picking'
        : modes.current === 'racing' ? `racing-${steering.kind}`
        : modes.current;
      return `${doing} ${settings.color || '-'} ${settings.name.trim()}`.trim();
    },
  });
  setInterval(changed, HEARTBEAT_MS);
} catch (e) {
  shell.setLink('lost', e instanceof Error ? e.message : String(e));
}
