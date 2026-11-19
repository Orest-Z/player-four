// @ts-check
// Direct WebRTC link to the PC, built only from what the QR code put in the URL fragment:
// u/p = the PC's ICE ufrag/password, f = its DTLS certificate fingerprint, a = its IP:port.
// There is no signaling server: the PC's SDP answer is rebuilt right here.

/** How long to wait for the first connection before giving up. */
const CONNECT_TIMEOUT_MS = 12000;

/** @typedef {'connecting' | 'open' | 'unstable' | 'lost'} LinkStatus */

/**
 * @param {string} hash location.hash from the QR code's link
 * @param {{ onStatus(status: LinkStatus): void, onPong(rttMs: number, player: number): void }} on
 * @returns {Promise<{ send(packet: ArrayBuffer): void }>}
 */
export async function connect(hash, on) {
  const q = new URLSearchParams(hash.slice(1));
  const [ip, port] = (q.get('a') ?? '').split(':');
  const fingerprint = (q.get('f') ?? '').match(/../g)?.join(':');
  const ufrag = q.get('u'), pwd = q.get('p');
  if (!ip || !port || !fingerprint || !ufrag || !pwd) {
    throw new Error('This link is incomplete. Scan the QR code on your PC again.');
  }

  const pc = new RTCPeerConnection();
  // Unordered and never retransmitted: a late gamepad packet is worse than a lost one.
  const dc = pc.createDataChannel('pad', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
  await pc.setLocalDescription(await pc.createOffer());
  const mid = pc.localDescription?.sdp.match(/a=mid:(\S+)/)?.[1] ?? '0';
  await pc.setRemoteDescription({ type: 'answer', sdp: [
    'v=0', 'o=- 0 0 IN IP4 0.0.0.0', 's=-', 't=0 0',
    `a=group:BUNDLE ${mid}`, 'a=ice-lite',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
    `a=mid:${mid}`, `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${fingerprint}`, 'a=setup:passive',
    'a=sctp-port:5000', 'a=max-message-size:16384',
    `a=candidate:1 1 udp 2130706431 ${ip} ${port} typ host`, 'a=end-of-candidates', '',
  ].join('\r\n') });

  let pings = 0;
  const giveUp = setTimeout(() => { if (dc.readyState !== 'open') { pc.close(); on.onStatus('lost'); } }, CONNECT_TIMEOUT_MS);
  dc.onopen = () => {
    clearTimeout(giveUp);
    on.onStatus('open');
    // The PC echoes each ping with our player number: latency and identity in one.
    pings = setInterval(() => dc.readyState === 'open' && dc.send('p ' + performance.now()), 500);
  };
  dc.onmessage = e => {
    const [, sent, player] = String(e.data).split(' ');
    on.onPong(performance.now() - Number(sent), Number(player));
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected' && dc.readyState === 'open') on.onStatus('open');
    else if (s === 'disconnected') on.onStatus('unstable'); // WebRTC often recovers from this by itself
    else if (s === 'failed' || s === 'closed') {
      clearInterval(pings);
      on.onStatus('lost');
    }
  };

  return {
    send(packet) {
      if (dc.readyState === 'open') dc.send(packet);
    },
  };
}
