// @ts-check
// Vibration: short ticks for presses, and the game's rumble. iPhone browsers can't vibrate at all.

/** How long one rumble message from the PC buzzes. The PC repeats it every 100 ms while the
 * game keeps rumbling, so a lost "stop" can't leave the phone buzzing for long. */
const RUMBLE_MS = 250;
/** Phones can't set motor strength, so strength is how much of each slice the motor is on. */
const SLICE_MS = 40;

let taps = true, rumbleOn = true, rumbleUntil = 0;

/** @param {boolean} on vibrate on presses */
export const setHaptics = on => {
  taps = on;
};

/** @param {boolean} on pass the game's rumble on */
export const setRumble = on => {
  rumbleOn = on;
  if (!on) rumble(0, 0);
};

/** Whether this phone can vibrate at all (iPhone browsers can't). */
export const canVibrate = () => typeof navigator.vibrate === 'function';

/** A short tick of vibration, when the phone supports it and the player wants it. */
export const buzz = (ms = 8) => {
  // A tick would cut the game's rumble short.
  if (taps && canVibrate() && performance.now() > rumbleUntil) navigator.vibrate(ms);
};

/**
 * The game's rumble: XInput's two motors, 0-255 each. A phone has one motor, so the
 * stronger of the two sets how hard it buzzes.
 * @param {number} large @param {number} small
 */
export function rumble(large, small) {
  if (!canVibrate()) return;
  const strength = rumbleOn ? Math.max(large, small) / 255 : 0;
  if (!(strength > 0)) {
    if (rumbleUntil) navigator.vibrate(0);
    rumbleUntil = 0;
    return;
  }
  rumbleUntil = performance.now() + RUMBLE_MS;
  if (strength > 0.9) {
    navigator.vibrate(RUMBLE_MS);
    return;
  }
  const on = Math.round(8 + 28 * strength);
  /** @type {number[]} */
  const pattern = [];
  for (let t = 0; t < RUMBLE_MS; t += SLICE_MS) pattern.push(on, SLICE_MS - on);
  navigator.vibrate(pattern);
}
