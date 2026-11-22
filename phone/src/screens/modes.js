// @ts-check
// The controller picker and which layout is showing. Each phone remembers its own choice.

const KEY = 'playerfour.mode';
export const MODES = /** @type {const} */ (['racing', 'party', 'retro', 'full']);
/** @typedef {typeof MODES[number]} Mode */

/**
 * @param {Document} doc
 * @param {(mode: Mode) => void} onChoose called from the tap on a card, so it may go full screen
 */
export function initModes(doc, onChoose) {
  const picker = /** @type {HTMLElement} */ (doc.querySelector('#picker'));
  const label = /** @type {HTMLElement} */ (doc.querySelector('#mode-name'));
  const saved = /** @type {Mode} */ (localStorage.getItem(KEY));
  /** @type {Mode} */
  let current = MODES.includes(saved) ? saved : 'racing';

  /** @param {Mode} mode */
  function show(mode) {
    current = mode;
    localStorage.setItem(KEY, mode);
    doc.body.dataset.mode = mode; // lets mode-specific bits of the top bar show
    for (const m of /** @type {NodeListOf<HTMLElement>} */ (doc.querySelectorAll('main[data-mode]'))) {
      m.hidden = m.dataset.mode !== mode;
    }
    for (const c of /** @type {NodeListOf<HTMLElement>} */ (picker.querySelectorAll('[data-pick]'))) {
      c.classList.toggle('current', c.dataset.pick === mode);
      c.setAttribute('aria-pressed', String(c.dataset.pick === mode));
    }
    label.textContent = picker.querySelector(`[data-pick="${mode}"] b`)?.textContent ?? mode;
  }

  for (const card of /** @type {NodeListOf<HTMLElement>} */ (picker.querySelectorAll('[data-pick]'))) {
    card.addEventListener('click', () => {
      const mode = /** @type {Mode} */ (card.dataset.pick);
      show(mode);
      picker.hidden = true;
      onChoose(mode);
    });
  }
  doc.querySelector('#mode-btn')?.addEventListener('click', () => (picker.hidden = false));
  show(current);

  return {
    open() {
      picker.hidden = false;
    },
    get current() {
      return current;
    },
  };
}
