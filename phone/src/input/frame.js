// @ts-check
// The screen frame the controls are drawn in. Normally that's however the browser shows the page.
// Tilt steering holds it still: turning a phone like a wheel is exactly what makes it auto-rotate.
// Where the browser can't lock rotation (iPhones, or after leaving full screen) the phone flips
// anyway, so the page is turned back by CSS (html[data-turn] in style.css) and the controls stay
// under the thumbs. Touch positions then need turning too: see point() and box().
// ponytail: only the pedals convert, since only tilt racing holds the frame; route other controls
// through point()/box() if they ever need to work while it's held.

/** The browser's screen rotation in degrees (0, 90, 180, 270), counter-clockwise from portrait. */
const osAngle = () =>
  ((screen.orientation?.angle ?? Number(/** @type {any} */ (window).orientation ?? 0)) + 360) % 360;

let holding = false;
/** @type {number | null} the held frame's angle; only ever a landscape one */
let held = null;
/** How far the page is turned back, clockwise, in degrees. */
let turn = 0;

function update() {
  const os = osAngle();
  if (holding && held === null && os % 180) held = os; // enabled in portrait: hold once sideways
  turn = held === null ? 0 : (held - os + 360) % 360;
  if (turn) document.documentElement.dataset.turn = String(turn);
  else delete document.documentElement.dataset.turn;
}
screen.orientation?.addEventListener('change', update);
addEventListener('orientationchange', update); // older iPhones
addEventListener('resize', update);

/** Keeps the current landscape frame, however the phone turns, until release(). */
export function hold() {
  holding = true;
  held = null;
  update();
}

export function release() {
  holding = false;
  held = null;
  update();
}

/** Screen rotation the controls are drawn in, for turning sensor readings into screen directions. */
export const angle = () => held ?? osAngle();

/**
 * A viewport point in the controls' own frame. Only differences between points and boxes mean
 * anything, so turning about the viewport center is as good as any.
 * @param {number} x @param {number} y
 */
export function point(x, y) {
  if (!turn) return { x, y };
  const t = (turn * Math.PI) / 180, cx = innerWidth / 2, cy = innerHeight / 2;
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * Math.cos(t) + dy * Math.sin(t), y: cy - dx * Math.sin(t) + dy * Math.cos(t) };
}

/** An element's box in the controls' own frame. @param {Element} el */
export function box(el) {
  const r = el.getBoundingClientRect();
  const a = point(r.left, r.top), b = point(r.right, r.bottom);
  return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
}
