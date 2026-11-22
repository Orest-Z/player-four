// @ts-check
// Everything around the controls: player badge, latency, connection screens, toasts,
// full screen and keeping the screen awake.

/** Player colors, index = player number. Chosen to stay clear of the red brake and green gas. */
const COLORS = ['#8a8f98', '#3b82f6', '#f97316', '#a855f7', '#eab308'];

/** @param {Document} doc */
export function initShell(doc) {
  /** @param {string} sel */
  const $ = sel => /** @type {HTMLElement} */ (doc.querySelector(sel));
  const net = $('#net'), netText = $('#net-text'), player = $('#player'), toastEl = $('#toast');
  /** @type {number[]} */
  const rtts = [];
  let wasOpen = false, toastTimer = 0, wantAwake = false;

  const fsBtn = $('#fs-btn');
  fsBtn.hidden = !doc.fullscreenEnabled; // iPhone Safari can't full-screen a page
  fsBtn.addEventListener('click', () => (doc.fullscreenElement ? doc.exitFullscreen() : fullscreen()));
  doc.addEventListener('fullscreenchange', () => {
    fsBtn.querySelector('use')?.setAttribute('href', doc.fullscreenElement ? '#i-shrink' : '#i-expand');
  });
  $('#reconnect').addEventListener('click', () => location.reload());
  doc.addEventListener('visibilitychange', () => {
    if (!doc.hidden && wantAwake) keepAwake(); // the browser drops the wake lock when hidden
  });

  /** Full screen, then lock to the landscape side the phone is on, so tilting can't flip the screen. */
  async function fullscreen() {
    if (doc.fullscreenEnabled && !doc.fullscreenElement) {
      try {
        await doc.documentElement.requestFullscreen({ navigationUI: 'hide' });
      } catch {
        return;
      }
    }
    try {
      const type = screen.orientation.type;
      await /** @type {any} */ (screen.orientation).lock(type.startsWith('landscape') ? type : 'landscape');
    } catch {}
  }

  async function keepAwake() {
    wantAwake = true;
    try {
      await navigator.wakeLock?.request('screen');
    } catch {}
  }

  /** @param {string} message */
  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  /**
   * @param {import('../link/link.js').LinkStatus} status
   * @param {string} [detail] shown on the "lost" screen instead of the default advice
   */
  function setLink(status, detail) {
    $('#connecting').hidden = status !== 'connecting';
    $('#lost').hidden = status !== 'lost';
    if (status === 'open') wasOpen = true;
    if (status === 'unstable') {
      net.className = 'net bad';
      netText.textContent = 'Reconnecting…';
    }
    if (status === 'lost') {
      $('#lost-title').textContent = wasOpen ? 'Connection lost' : "Can't reach your PC";
      $('#lost-text').textContent = detail ?? (wasOpen
        ? 'The PC app stopped or the Wi-Fi dropped. Your controller is released.'
        : 'Check that the PC app is running and this phone is on the same Wi-Fi as the PC.');
    }
  }

  /** @param {number} ms */
  function setLatency(ms) {
    rtts.push(ms);
    if (rtts.length > 8) rtts.shift();
    const avg = rtts.reduce((a, b) => a + b) / rtts.length;
    netText.textContent = `${Math.round(avg)} ms`;
    net.className = `net ${avg < 25 ? 'good' : avg < 60 ? 'ok' : 'bad'}`;
  }

  let number = 0, chosen = '';
  const paint = () => doc.documentElement.style.setProperty('--p', chosen ? `#${chosen}` : COLORS[number] ?? COLORS[0]);

  /** @param {number} n */
  function setPlayer(n) {
    if (number === n) return;
    number = n;
    player.textContent = `P${n}`;
    paint();
  }

  /** This phone's own color (hex without '#'), or '' for its player number's color. @param {string} hex */
  function setColor(hex) {
    chosen = /^[0-9a-f]{6}$/i.test(hex) ? hex : '';
    paint();
  }

  return { setLink, setLatency, setPlayer, setColor, toast, fullscreen, keepAwake };
}

/** @typedef {ReturnType<typeof initShell>} Shell */
