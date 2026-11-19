// @ts-check

let enabled = true;

/** @param {boolean} on */
export const setHaptics = on => {
  enabled = on;
};

/** Whether this phone can vibrate at all (iPhone browsers can't). */
export const canVibrate = () => typeof navigator.vibrate === 'function';

/** A short tick of vibration, when the phone supports it and the player wants it. */
export const buzz = (ms = 8) => {
  if (enabled && canVibrate()) navigator.vibrate(ms);
};
