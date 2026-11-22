// @ts-check
// Steering for the left stick's X axis, either from a touch wheel or from tilting the phone.
import { axis } from '../protocol/pad.js';
import { track } from './touch.js';
import { buzz } from './haptics.js';
import * as frame from './frame.js';

/** @typedef {import('../protocol/pad.js').Pad} Pad */
/** @typedef {'touch' | 'tilt'} SteeringKind */

const RAD = Math.PI / 180;
/** Tilt this close to center counts as straight ahead, so hand tremor doesn't wiggle the car. */
const TILT_DEADZONE_DEG = 1;
/** Smoothing time constant for tilt, in seconds: calms sensor jitter, too short to feel as lag. */
const TILT_SMOOTHING_S = 0.01;

/** @param {number} v @param {number} [lo] @param {number} [hi] */
const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));

/**
 * How far the phone's long edge is tipped from level, in degrees, positive when the right end
 * is lower: the phone as a steering wheel. Uses gravity rather than a single Euler angle, so it
 * works however the phone is held, from flat in the lap to upright.
 * "Up" in the phone's own axes follows from the W3C DeviceOrientation angles (Z-X'-Y''); it is
 * dotted with the rightward axis of the frame the controls are drawn in. That frame is held while
 * tilt steers, so a phone that auto-rotates mid-corner doesn't swing the reference by 90°.
 * @param {number} beta @param {number} gamma
 */
export function roll(beta, gamma) {
  const b = beta * RAD, g = gamma * RAD;
  const upX = -Math.cos(b) * Math.sin(g);
  const upY = Math.sin(b);
  const t = frame.angle() * RAD;
  return Math.asin(clamp(-(upX * Math.cos(t) - upY * Math.sin(t)))) / RAD;
}

/**
 * @param {Pad} pad
 * @param {() => void} changed
 */
export function createSteering(pad, changed) {
  const cfg = {
    /** Thumb travel for full lock on the touch wheel, as a share of screen width. */
    travel: 0.25,
    /** Degrees of tilt for full lock. */
    tiltRange: 35,
    tiltInvert: false,
    /** 0 = linear; higher = finer control near center, full lock still reachable. */
    precision: 0,
  };
  /** @type {Set<(value: number) => void>} */
  const listeners = new Set();
  /** @type {SteeringKind} */
  let kind = 'touch';
  let side = 0; // which side of center we're on, for the center tick
  let angle = 0, zero = 0, lastEvent = 0, gotTilt = false;

  /** @param {number} raw -1..1 before the response curve */
  function set(raw) {
    const x = clamp(raw);
    const v = Math.sign(x) * Math.abs(x) ** (1 + cfg.precision * 1.5);
    const s = Math.sign(v);
    if (s && side && s !== side) buzz(4); // a tick when passing through center
    if (s) side = s;
    pad.lx = axis(v);
    pad.ly = 0;
    changed();
    for (const fn of listeners) fn(v);
  }

  /** @param {Event} ev */
  function onOrientation(ev) {
    const e = /** @type {DeviceOrientationEvent} */ (ev);
    if (e.beta == null || e.gamma == null) return;
    gotTilt = true;
    const now = e.timeStamp / 1000;
    const k = lastEvent ? 1 - Math.exp(-(now - lastEvent) / TILT_SMOOTHING_S) : 1;
    lastEvent = now;
    angle += (roll(e.beta, e.gamma) - angle) * k;
    if (kind !== 'tilt') return;
    const d = (angle - zero) * (cfg.tiltInvert ? -1 : 1);
    const past = Math.max(0, Math.abs(d) - TILT_DEADZONE_DEG);
    set((Math.sign(d) * past) / (cfg.tiltRange - TILT_DEADZONE_DEG));
  }

  return {
    get kind() {
      return kind;
    },

    /** @param {Partial<typeof cfg>} c */
    configure(c) {
      Object.assign(cfg, c);
    },

    /** @param {(value: number) => void} fn called with the final -1..1 steering on every change */
    onSteer(fn) {
      listeners.add(fn);
    },

    /**
     * Touch wheel: steering is how far the thumb has slid left or right from where it landed,
     * so there is no spot to aim for. Past full lock the anchor slides along with the thumb,
     * so turning back responds at once instead of crossing dead travel first.
     * @param {Element} zone
     */
    bindWheel(zone) {
      /** @param {PointerEvent} e @param {{ x: number }} o */
      const move = (e, o) => {
        const full = innerWidth * cfg.travel;
        o.x = clamp(o.x, e.clientX - full, e.clientX + full);
        set((e.clientX - o.x) / full);
      };
      track(zone, {
        down(e, o) {
          if (kind !== 'touch') return;
          zone.classList.add('on', 'used');
          buzz();
          move(e, o);
        },
        move(e, o) {
          if (kind === 'touch') move(e, o);
        },
        up() {
          zone.classList.remove('on');
          if (kind !== 'touch') return;
          side = 0;
          set(0);
        },
      });
    },

    /**
     * Switches to tilt steering. Call it straight from a tap: iPhones ask for motion permission,
     * which only works inside a tap.
     * @returns {Promise<'ok' | 'denied' | 'unsupported'>}
     */
    async enableTilt() {
      if (!window.isSecureContext || !('DeviceOrientationEvent' in window)) return 'unsupported';
      const ask = /** @type {any} */ (DeviceOrientationEvent).requestPermission;
      if (typeof ask === 'function') {
        try {
          if ((await ask.call(DeviceOrientationEvent)) !== 'granted') return 'denied';
        } catch {
          return 'denied';
        }
      }
      addEventListener('deviceorientation', onOrientation);
      // Desktops and some phones expose the API but never send readings.
      for (let waited = 0; !gotTilt && waited < 1500; waited += 50) await new Promise(r => setTimeout(r, 50));
      if (!gotTilt) {
        removeEventListener('deviceorientation', onOrientation);
        return 'unsupported';
      }
      kind = 'tilt';
      side = 0;
      frame.hold();
      return 'ok';
    },

    disableTilt() {
      removeEventListener('deviceorientation', onOrientation);
      frame.release();
      kind = 'touch';
      side = 0;
      set(0);
    },

    /** Makes the phone's current tilt the new straight-ahead. */
    center() {
      zero = angle;
      side = 0;
      if (kind === 'tilt') set(0);
    },

    /** Current tilt from center in degrees (after invert), for display. */
    tiltAngle() {
      return (angle - zero) * (cfg.tiltInvert ? -1 : 1);
    },
  };
}

/** @typedef {ReturnType<typeof createSteering>} Steering */
