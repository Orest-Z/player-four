// @ts-check
// Racing visuals: which steering layout shows, the wheel's rotation and every steering meter
// (on the racing screen and in settings). Drawing is batched to one update per frame; the
// steering value itself goes to the PC immediately, on every sensor or touch event.

/** How far the drawn wheel turns at full lock, in degrees. */
const WHEEL_LOCK_DEG = 135;

/**
 * @param {Document} doc
 * @param {import('../input/steering.js').Steering} steering
 */
export function initRacing(doc, steering) {
  const main = /** @type {HTMLElement} */ (doc.querySelector('main[data-mode="racing"]'));
  const wheels = /** @type {NodeListOf<SVGElement>} */ (doc.querySelectorAll('.wheel'));
  const meters = [...doc.querySelectorAll('.steer-meter')].map(m => ({
    fill: /** @type {HTMLElement} */ (m.querySelector('.steer-fill')),
    text: /** @type {HTMLElement} */ (m.querySelector('.steer-text')),
  }));
  let value = 0, queued = false;

  function draw() {
    queued = false;
    for (const w of wheels) w.style.rotate = `${value * WHEEL_LOCK_DEG}deg`;
    const pct = Math.round(Math.abs(value) * 100);
    let text = pct === 0 ? 'Straight' : `${value < 0 ? 'Left' : 'Right'} ${pct}%`;
    if (steering.kind === 'tilt') text += ` · tilt ${Math.round(steering.tiltAngle())}°`;
    for (const m of meters) {
      m.fill.style.left = `${50 + Math.min(value, 0) * 50}%`;
      m.fill.style.width = `${Math.abs(value) * 50}%`;
      m.text.textContent = text;
    }
  }
  steering.onSteer(v => {
    value = v;
    if (!queued) {
      queued = true;
      requestAnimationFrame(draw);
    }
  });

  return {
    /** @param {import('../input/steering.js').SteeringKind} kind */
    showSteering(kind) {
      main.dataset.steering = kind;
      value = 0;
      draw();
    },
  };
}
