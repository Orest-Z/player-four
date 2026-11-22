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
/** Turning the touch wheel: this close to its center (share of its radius), angles are too jumpy to read. */
const WHEEL_DEAD_CENTER = 0.2;
/** A bigger jump between two touch events means the thumb skipped across the center: re-grab there. */
const WHEEL_MAX_STEP_DEG = 60;
/** On wheels above one turn, letting go holds the wheel this long, so you can re-grab hand over hand. */
const REGRAB_MS = 250;

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
    /** Touch wheel: 'turn' it around its center like a real wheel, or 'slide' left and right. */
    style: /** @type {'turn' | 'slide'} */ ('turn'),
    /** Wheel rotation lock to lock, in degrees: 900 matches a truck sim's wheel. */
    rotation: 360,
    /** Whether the touch wheel springs back to center when let go. */
    returns: true,
  };
  /** @type {Set<(value: number, turned: number) => void>} */
  const listeners = new Set();
  /** @type {SteeringKind} */
  let kind = 'touch';
  let side = 0; // which side of center we're on, for the center tick
  let angle = 0, zero = 0, lastEvent = 0, gotTilt = false;
  /** How far the touch wheel is turned, in degrees, + = right. */
  let wheel = 0;
  const lock = () => cfg.rotation / 2;

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
    for (const fn of listeners) fn(v, x * lock());
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

    /**
     * @param {(value: number, turned: number) => void} fn called on every change with the final
     *   -1..1 steering and how far the drawn wheel is turned, in degrees
     */
    onSteer(fn) {
      listeners.add(fn);
    },

    /**
     * The touch wheel, two ways:
     * - turn: grab it anywhere and turn it around its center like a real wheel, past a full
     *   turn when the rotation allows (900° is two and a half turns lock to lock). Past full
     *   lock it stops, so turning back responds at once.
     * - slide: steering is how far the thumb has slid left or right from where it landed. Past
     *   full lock the anchor slides along, so turning back responds at once here too.
     * @param {Element} zone
     */
    bindWheel(zone) {
      const hub = zone.querySelector('.wheel-wrap') ?? zone;
      /** @type {number | null} the thumb's angle around the hub at the last event */
      let grip = null;
      let settling = 0, holding = 0;

      /** The thumb's angle around the hub, clockwise from 12 o'clock, and its distance as a share of the radius. @param {PointerEvent} e */
      const around = e => {
        const r = frame.box(hub), p = frame.point(e.clientX, e.clientY);
        const dx = p.x - (r.left + r.right) / 2, dy = p.y - (r.top + r.bottom) / 2;
        const radius = Math.min(r.right - r.left, r.bottom - r.top) / 2;
        return { deg: Math.atan2(dx, -dy) / RAD, reach: Math.hypot(dx, dy) / radius };
      };
      /** @param {PointerEvent} e */
      const turn = e => {
        const { deg, reach } = around(e);
        if (reach < WHEEL_DEAD_CENTER) return void (grip = null);
        const step = grip === null ? 0 : ((deg - grip + 540) % 360) - 180;
        if (Math.abs(step) <= WHEEL_MAX_STEP_DEG) wheel = clamp(wheel + step, -lock(), lock());
        grip = deg;
        set(wheel / lock());
      };
      /** @param {PointerEvent} e @param {{ x: number }} o */
      const slide = (e, o) => {
        const full = innerWidth * cfg.travel;
        o.x = clamp(o.x, e.clientX - full, e.clientX + full);
        set((e.clientX - o.x) / full);
      };
      /** Springs back to center in about a fifth of a second, smoothly for the game too. */
      const settle = () => {
        wheel = Math.abs(wheel) < 1 ? 0 : wheel * 0.6;
        set(wheel / lock());
        settling = wheel ? requestAnimationFrame(settle) : 0;
      };

      track(zone, {
        down(e, o) {
          if (kind !== 'touch') return;
          clearTimeout(holding);
          cancelAnimationFrame(settling);
          zone.classList.add('on', 'used');
          buzz();
          grip = null;
          if (cfg.style === 'turn') turn(e);
          else slide(e, o);
        },
        move(e, o) {
          if (kind !== 'touch') return;
          if (cfg.style === 'turn') turn(e);
          else slide(e, o);
        },
        up() {
          zone.classList.remove('on');
          if (kind !== 'touch') return;
          side = 0;
          if (cfg.style === 'slide') return set(0);
          if (cfg.returns) holding = setTimeout(settle, cfg.rotation > 360 ? REGRAB_MS : 0);
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
      wheel = 0; // the touch wheel starts straight
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
