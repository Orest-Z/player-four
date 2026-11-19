// @ts-check
// Gas and brake pedals. Phones can't feel pressure, so "how hard" is how far up the pedal the
// thumb is: low on the pedal is a light touch, near the top is flat out.
import { trigger } from '../protocol/pad.js';
import { track } from './touch.js';
import { buzz } from './haptics.js';

/** @typedef {import('../protocol/pad.js').Pad} Pad */

const cfg = { analog: true };

/** @param {{ analog?: boolean }} c */
export const configurePedals = c => {
  Object.assign(cfg, c);
};

/**
 * Pedal travel from the thumb's height: the bottom 10% is the lightest touch (5%), the top 15% is 100%,
 * linear between, so both ends are easy to hit without aiming.
 * @param {Element} el @param {number} y
 */
export function depth(el, y) {
  const r = el.getBoundingClientRect();
  const up = (r.bottom - y) / r.height;
  return Math.max(0.05, Math.min(1, (up - 0.1) / 0.75));
}

/** Pedal height (0..1 from the bottom) where a given depth sits, for drawing tick marks. @param {number} d */
export const heightFor = d => 0.1 + d * 0.75;

/** @param {Element} el @param {number} x horizontal distance from the thumb to a pedal */
const gap = (el, x) => {
  const r = el.getBoundingClientRect();
  return x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
};

/**
 * [data-pedal-group] holds one or more [data-pedal="lt"|"rt"]. One thumb drives a group and can
 * slide between its pedals without lifting, like a foot; separate groups work at the same time.
 * @param {ParentNode} root @param {Pad} pad @param {() => void} changed
 */
export function bindPedals(root, pad, changed) {
  for (const group of root.querySelectorAll('[data-pedal-group]')) {
    const pedals = /** @type {HTMLElement[]} */ ([...group.querySelectorAll('[data-pedal]')]);
    /** @type {HTMLElement | null} */
    let active = null;
    let flatOut = false;

    /** @param {HTMLElement} el @param {number} v */
    const draw = (el, v) => {
      el.style.setProperty('--v', String(v));
      /** @type {HTMLElement} */ (el.querySelector('.pedal-value')).textContent = `${Math.round(v * 100)}%`;
      el.classList.toggle('on', v > 0);
    };
    /** @param {HTMLElement | null} el @param {number} v */
    const press = (el, v) => {
      for (const p of pedals) {
        if (p === el) continue;
        pad[/** @type {'lt' | 'rt'} */ (p.dataset.pedal)] = 0;
        draw(p, 0);
      }
      if (el) {
        pad[/** @type {'lt' | 'rt'} */ (el.dataset.pedal)] = trigger(v);
        draw(el, v);
        if (el !== active) buzz(8); // switching pedals
        else if (v >= 1 && !flatOut) buzz(5); // reaching the top
      }
      active = el;
      flatOut = v >= 1;
      changed();
    };
    /** @param {PointerEvent} e */
    const at = e => {
      // Which pedal is decided by x alone, so drifting above or below one keeps it pressed.
      const el = pedals.reduce((best, p) => (gap(p, e.clientX) < gap(best, e.clientX) ? p : best));
      press(el, cfg.analog ? depth(el, e.clientY) : 1);
    };
    track(group, { down: at, move: at, up: () => press(null, 0) });
  }
}
