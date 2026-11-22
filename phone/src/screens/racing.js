// @ts-check
// Racing visuals: which steering layout shows, the wheel's rotation and every steering meter
// (on the racing screen and in settings). Drawing is batched to one update per frame; the
// steering value itself goes to the PC immediately, on every sensor or touch event.

/**
 * @param {Document} doc
 * @param {import('../input/steering.js').Steering} steering
 */
export function initRacing(doc, steering) {
  const wheels = /** @type {NodeListOf<SVGElement>} */ (doc.querySelectorAll('.wheel'));
  const meters = [...doc.querySelectorAll('.steer-meter')].map(m => ({
    fill: /** @type {HTMLElement} */ (m.querySelector('.steer-fill')),
    text: /** @type {HTMLElement} */ (m.querySelector('.steer-text')),
  }));
  let value = 0, turned = 0, queued = false;

  function draw() {
    queued = false;
    // The drawn wheel turns as far as the game's wheel: past a full turn on a 900° wheel.
    for (const w of wheels) w.style.rotate = `${turned}deg`;
    const pct = Math.round(Math.abs(value) * 100);
    let text = pct === 0 ? 'Straight' : `${value < 0 ? 'Left' : 'Right'} ${pct}%`;
    if (steering.kind === 'tilt') text += ` · tilt ${Math.round(steering.tiltAngle())}°`;
    else if (pct) text += ` · ${Math.round(Math.abs(turned))}°`;
    for (const m of meters) {
      m.fill.style.left = `${50 + Math.min(value, 0) * 50}%`;
      m.fill.style.width = `${Math.abs(value) * 50}%`;
      m.text.textContent = text;
    }
  }
  steering.onSteer((v, deg) => {
    value = v;
    turned = deg;
    if (!queued) {
      queued = true;
      requestAnimationFrame(draw);
    }
  });

  return {
    /** @param {import('../input/steering.js').SteeringKind} kind */
    showSteering(kind) {
      doc.body.dataset.steering = kind; // picks the layout and lights the top-bar switch
      value = turned = 0;
      draw();
    },
  };
}
