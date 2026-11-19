// @ts-check
// Touch controls shared by every layout: buttons, trigger buttons, floating sticks and D-pads.
// Each control finds its elements by data attribute, writes the pad, then calls changed().
import { BUTTON, DPAD, axis } from '../protocol/pad.js';
import { buzz } from './haptics.js';

/** @typedef {import('../protocol/pad.js').Pad} Pad */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {keyof typeof BUTTON} ButtonName */

/** Full touchscreen rate instead of once per frame, where the browser offers it (Chrome over HTTPS). */
const MOVE = 'onpointerrawupdate' in window ? 'pointerrawupdate' : 'pointermove';

/**
 * Follows one finger on `el` from touch to release; any other finger is left to other controls.
 * `origin` is where the finger landed. Handlers may move it, e.g. a stick that follows the thumb.
 * @param {Element} el
 * @param {{ down?(e: PointerEvent, origin: Point): void, move?(e: PointerEvent, origin: Point): void, up(): void }} on
 */
export function track(el, on) {
  let id = -1;
  /** @type {Point} */
  let origin = { x: 0, y: 0 };
  el.addEventListener('pointerdown', ev => {
    const e = /** @type {PointerEvent} */ (ev);
    if (id !== -1) return;
    id = e.pointerId;
    el.setPointerCapture(id);
    origin = { x: e.clientX, y: e.clientY };
    on.down?.(e, origin);
  });
  el.addEventListener(MOVE, ev => {
    const e = /** @type {PointerEvent} */ (ev);
    if (e.pointerId === id) on.move?.(e, origin);
  });
  /** @param {Event} ev */
  const release = ev => {
    if (/** @type {PointerEvent} */ (ev).pointerId !== id) return;
    id = -1;
    on.up();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(type, release);
}

/**
 * [data-btn="A"] etc.: holds that XInput button while touched.
 * @param {ParentNode} root @param {Pad} pad @param {() => void} changed
 */
export function bindButtons(root, pad, changed) {
  for (const el of root.querySelectorAll('[data-btn]')) {
    const bit = BUTTON[/** @type {ButtonName} */ (/** @type {HTMLElement} */ (el).dataset.btn)];
    track(el, {
      down() {
        el.classList.add('on');
        pad.buttons |= bit;
        buzz();
        changed();
      },
      up() {
        el.classList.remove('on');
        pad.buttons &= ~bit;
        changed();
      },
    });
  }
}

/**
 * [data-trigger="lt"|"rt"]: a trigger as a plain button, fully pressed while held.
 * @param {ParentNode} root @param {Pad} pad @param {() => void} changed
 */
export function bindTriggers(root, pad, changed) {
  for (const el of root.querySelectorAll('[data-trigger]')) {
    const key = /** @type {'lt' | 'rt'} */ (/** @type {HTMLElement} */ (el).dataset.trigger);
    track(el, {
      down() {
        el.classList.add('on');
        pad[key] = 255;
        buzz();
        changed();
      },
      up() {
        el.classList.remove('on');
        pad[key] = 0;
        changed();
      },
    });
  }
}

/**
 * [data-stick="left"|"right"]: a floating stick, centered wherever the thumb lands.
 * Past full tilt the center follows the thumb, so reversing direction responds at once.
 * @param {ParentNode} root @param {Pad} pad @param {() => void} changed
 */
export function bindSticks(root, pad, changed) {
  for (const zone of /** @type {NodeListOf<HTMLElement>} */ (root.querySelectorAll('[data-stick]'))) {
    const [kx, ky] = zone.dataset.stick === 'right' ? /** @type {const} */ (['rx', 'ry']) : /** @type {const} */ (['lx', 'ly']);
    zone.insertAdjacentHTML('beforeend', '<div class="stick-base" hidden><div class="stick-knob"></div></div>');
    const base = /** @type {HTMLElement} */ (zone.querySelector('.stick-base'));
    const knob = /** @type {HTMLElement} */ (base.firstElementChild);
    /** Full tilt this far from the center, in pixels. */
    const reach = () => Math.min(innerWidth, innerHeight) * 0.15;

    /** @param {Point} o */
    const placeBase = o => {
      const z = zone.getBoundingClientRect();
      base.style.left = `${o.x - z.left}px`;
      base.style.top = `${o.y - z.top}px`;
    };
    /** @param {PointerEvent} e @param {Point} o */
    const move = (e, o) => {
      const r = reach();
      let dx = e.clientX - o.x, dy = e.clientY - o.y;
      const d = Math.hypot(dx, dy);
      if (d > r) {
        dx *= r / d;
        dy *= r / d;
        o.x = e.clientX - dx;
        o.y = e.clientY - dy;
        placeBase(o);
      }
      pad[kx] = axis(dx / r);
      pad[ky] = axis(-dy / r);
      knob.style.translate = `${dx}px ${dy}px`;
      changed();
    };
    track(zone, {
      down(e, o) {
        base.style.setProperty('--reach', `${reach()}px`);
        placeBase(o);
        base.hidden = false;
        zone.classList.add('on', 'used');
        buzz();
        move(e, o);
      },
      move,
      up() {
        pad[kx] = pad[ky] = 0;
        knob.style.translate = '';
        base.hidden = true;
        zone.classList.remove('on');
        changed();
      },
    });
  }
}

const DPAD_ART = `<svg viewBox="-31 -31 62 62" aria-hidden="true">
  <rect x="-9" y="-9" width="18" height="18"/>
  <rect data-dir="UP" x="-9" y="-30" width="18" height="22" rx="4"/>
  <rect data-dir="DOWN" x="-9" y="8" width="18" height="22" rx="4"/>
  <rect data-dir="LEFT" x="-30" y="-9" width="22" height="18" rx="4"/>
  <rect data-dir="RIGHT" x="8" y="-9" width="22" height="18" rx="4"/>
  <path class="arrow" d="M0 -25l-4.5 6h9z M0 25l-4.5 -6h9z M-25 0l6 -4.5v9z M25 0l-6 -4.5v9z"/>
</svg>`;

/**
 * [data-dpad]: eight equal 45° slices around the cross's center. Sliding between them works,
 * so rolling from right to down-right to down is one motion, like a real D-pad.
 * @param {ParentNode} root @param {Pad} pad @param {() => void} changed
 */
export function bindDpads(root, pad, changed) {
  for (const zone of root.querySelectorAll('[data-dpad]')) {
    zone.innerHTML = DPAD_ART;
    const arms = [...zone.querySelectorAll('[data-dir]')];
    let held = 0;
    /** @param {number} bits */
    const set = bits => {
      if (bits === held) return;
      if (bits & ~held) buzz(6);
      held = bits;
      pad.buttons = (pad.buttons & ~DPAD) | bits;
      for (const a of arms) {
        const bit = BUTTON[/** @type {ButtonName} */ (/** @type {SVGElement} */ (a).dataset.dir)];
        a.classList.toggle('on', (bits & bit) !== 0);
      }
      changed();
    };
    /** @param {PointerEvent} e */
    const move = e => {
      const r = zone.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy), t = d * 0.383; // sin 22.5°: the edge of each 45° slice
      if (d < Math.min(r.width, r.height) * 0.06) return set(0); // dead center
      set((dx > t ? BUTTON.RIGHT : 0) | (dx < -t ? BUTTON.LEFT : 0) | (dy > t ? BUTTON.DOWN : 0) | (dy < -t ? BUTTON.UP : 0));
    };
    track(zone, { down: move, move, up: () => set(0) });
  }
}
