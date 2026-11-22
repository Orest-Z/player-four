// @ts-check
// Settings: defaults, saving per phone, and the settings sheet. Every form control in the
// sheet is named after the setting it edits.

const KEY = 'playerfour.settings';

export const DEFAULTS = Object.freeze({
  /** Shown on the PC next to this phone's player number. Empty: "Player 1" and so on. */
  name: '',
  /** Hex without '#', e.g. "ec4899". Empty: the player number's own color. */
  color: '',
  /** @type {'touch' | 'tilt'} */
  steering: 'touch',
  /** @type {'turn' | 'slide'} Turn the touch wheel like a real one, or slide left and right. */
  wheelStyle: 'turn',
  /** Wheel rotation lock to lock, in degrees, to match the game's: 900 for Euro Truck Simulator 2. */
  rotation: 360,
  /** The turned wheel springs back to center when let go. */
  wheelReturn: true,
  /** 1..10: how little thumb travel full lock takes on the sliding touch wheel. */
  sensitivity: 6,
  /** Degrees of tilt for full lock. */
  tiltRange: 35,
  tiltInvert: false,
  /** 0..100: finer control near center. */
  precision: 0,
  /** @type {'analog' | 'full'} */
  pedals: 'analog',
  haptics: true,
  /** Shake the phone when the game rumbles the controller. */
  rumble: true,
});
/** @typedef {{ -readonly [K in keyof typeof DEFAULTS]: (typeof DEFAULTS)[K] }} Settings */

/** @returns {Settings} */
export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

/** @param {Settings} s */
export const saveSettings = s => localStorage.setItem(KEY, JSON.stringify(s));

/** Touch-wheel thumb travel for full lock, as a share of screen width: 1 → 42%, 10 → 12%. @param {number} sensitivity */
export const travelFor = sensitivity => 0.42 - ((sensitivity - 1) * 0.3) / 9;

/** @type {Record<string, (v: any) => string>} */
const FORMAT = {
  sensitivity: v => String(v),
  tiltRange: v => `${v}°`,
  rotation: v => `${v}°`,
  precision: v => (Number(v) === 0 ? 'Off' : `${v}%`),
};

/**
 * @param {Document} doc
 * @param {Settings} s edited in place
 * @param {(key: keyof Settings, value: any) => void} onChange called from the user's tap or drag
 */
export function initSettingsSheet(doc, s, onChange) {
  const sheet = /** @type {HTMLElement} */ (doc.querySelector('#settings'));
  const form = /** @type {HTMLFormElement} */ (sheet.querySelector('form'));
  const controls = /** @type {HTMLInputElement[]} */ ([...form.elements].filter(el => el instanceof HTMLInputElement));
  const presets = /** @type {NodeListOf<HTMLElement>} */ (sheet.querySelectorAll('[data-rotation]'));

  function refresh() {
    for (const el of controls) {
      if (el === doc.activeElement && el.type === 'text') continue; // don't fight the typing
      const v = /** @type {any} */ (s)[el.name];
      if (el.type === 'radio') el.checked = el.value === v;
      else if (el.type === 'checkbox') el.checked = Boolean(v);
      else el.value = String(v);
      const out = form.querySelector(`output[for="${el.id}"]`);
      if (out && FORMAT[el.name]) out.textContent = FORMAT[el.name](v);
    }
    sheet.dataset.steering = s.steering; // shows only the touch or tilt fields
    sheet.dataset.wheel = s.wheelStyle; // and only the turning or sliding wheel's
    for (const b of presets) b.classList.toggle('on', Number(b.dataset.rotation) === s.rotation);
  }

  form.addEventListener('submit', e => e.preventDefault());
  for (const b of presets) {
    b.addEventListener('click', () => {
      onChange('rotation', Number(b.dataset.rotation));
      refresh();
    });
  }
  // "Done" on the keyboard closes it.
  form.addEventListener('keydown', e => e.key === 'Enter' && /** @type {HTMLElement} */ (e.target).blur());
  form.addEventListener('input', e => {
    const el = /** @type {HTMLInputElement} */ (e.target);
    const key = /** @type {keyof Settings} */ (el.name);
    const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
    onChange(key, value);
    refresh();
  });
  doc.querySelector('#settings-btn')?.addEventListener('click', () => {
    refresh();
    sheet.hidden = false;
  });
  for (const close of sheet.querySelectorAll('[data-close]')) {
    close.addEventListener('click', e => {
      if (e.target === close) sheet.hidden = true;
    });
  }
  refresh();
  return { refresh };
}
