//! Throwaway spike 2: up to 4 phones become virtual Xbox 360 controllers, all
//! from one QR code. Phone browser -> PC over WebRTC with no signaling server.

use std::error::Error;
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, UdpSocket};
use std::rc::Rc;
use std::time::{Duration, Instant};

use qrcode::QrCode;
use qrcode::render::{svg, unicode};
use str0m::channel::{ChannelConfig, Reliability};
use str0m::config::Fingerprint;
use str0m::ice::StunMessage;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc, RtcConfig};
use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

const PAGE: &str = include_str!("phone.html");
/// XInput's limit.
const MAX_PLAYERS: usize = 4;
/// A phone that goes quiet this long (screen locked, browser in the background)
/// gets its controller reset to neutral, so nobody's truck keeps accelerating.
/// Phones send a heartbeat every 100 ms.
const STALE: Duration = Duration::from_millis(500);

struct Player {
    rtc: Rtc,
    pad: Xbox360Wired<Rc<Client>>,
    /// 1-4: what games and Windows call this controller.
    number: u32,
    last_seq: Option<u16>,
    last_input: Instant,
    state: XGamepad,
}

fn main() -> Result<(), Box<dyn Error>> {
    let crypto = str0m::crypto::from_feature_flags();
    let cert = crypto.dtls_provider.generate_certificate().expect("DTLS certificate");
    let hmac = crypto.sha1_hmac_provider;
    crypto.install_process_default();
    let vigem = Rc::new(Client::connect().map_err(|e| {
        format!("ViGEmBus driver not found ({e:?}); install it from github.com/nefarius/ViGEmBus/releases")
    })?);

    let ip = match std::env::args().nth(1) {
        Some(arg) => arg.parse().expect("usage: phonepad-spike [pc-wifi-ip]"),
        None => lan_ip(),
    };
    let udp = UdpSocket::bind((ip, 0))?;
    let udp_addr = udp.local_addr()?;
    let http = TcpListener::bind((ip, 0))?;
    let http_addr = http.local_addr()?;

    // Every phone scans the same QR code, so every connection shares one ICE
    // password and one DTLS certificate.
    let creds = IceCreds::new();
    let config = RtcConfig::new()
        .set_ice_lite(true)
        .set_local_ice_credentials(creds.clone())
        .set_dtls_cert(cert)
        // Phone certificates are unknown up front. Phones prove themselves by
        // passing ICE instead, which needs the password only the QR code carries.
        .set_fingerprint_verification(false);
    let fingerprint: String = config
        .clone()
        .build(Instant::now())
        .direct_api()
        .local_dtls_fingerprint()
        .bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();

    let url = format!(
        "http://{http_addr}/#u={}&p={}&f={fingerprint}&a={udp_addr}",
        creds.ufrag, creds.pass
    );
    let qr = QrCode::new(&url)?;
    // Inverted so it scans on a dark terminal: light modules are drawn as blocks.
    let text_qr = qr
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Light)
        .light_color(unicode::Dense1x2::Dark)
        .build();
    std::fs::write("qr.svg", qr.render::<svg::Color>().min_dimensions(320, 320).build())?;
    println!("\n{text_qr}\nUp to {MAX_PLAYERS} phones on the same Wi-Fi can scan this.");
    println!("QR won't scan? Open qr.svg in this folder instead.\n{url}\n");

    std::thread::spawn(move || {
        for mut conn in http.incoming().flatten() {
            let _ = conn.read(&mut [0; 2048]); // ponytail: request ignored, every path gets the page
            let _ = write!(
                conn,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{PAGE}",
                PAGE.len()
            );
        }
    });

    let mut players: Vec<Player> = Vec::new();
    let mut buf = [0; 2000];
    loop {
        let now = Instant::now();
        let mut next = now + Duration::from_millis(100);
        for p in &mut players {
            if let Err(e) = drive(p, &udp, &mut next) {
                println!("Player {}: {e}", p.number);
                p.rtc.disconnect();
            }
            if now - p.last_input > STALE && p.state != XGamepad::default() {
                p.state = XGamepad::default();
                let _ = p.pad.update(&p.state);
            }
        }
        for p in players.iter().filter(|p| !p.rtc.is_alive()) {
            println!("Player {} left.", p.number);
        }
        players.retain(|p| p.rtc.is_alive()); // dropping a Player unplugs its controller

        udp.set_read_timeout(Some(next.saturating_duration_since(Instant::now()).max(Duration::from_millis(1))))?;
        let (n, source) = match udp.recv_from(&mut buf) {
            Ok(v) => v,
            // ConnectionReset: Windows reporting an ICMP "port unreachable" from an earlier send.
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::ConnectionReset) => continue,
            Err(e) => return Err(e.into()),
        };
        let data = &buf[..n];
        let Ok(contents) = data.try_into() else { continue }; // not WebRTC traffic
        let input = Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source, destination: udp_addr, contents });

        if let Some(p) = players.iter_mut().find(|p| p.rtc.accepts(&input)) {
            if p.rtc.handle_input(input).is_err() {
                p.rtc.disconnect();
            }
        } else if players.len() < MAX_PLAYERS
            && let Some(phone_ufrag) = new_phone(data, &creds, |k, d| hmac.sha1_hmac(k, d))
        {
            // Lowest free number, the same rule Windows uses for XInput slots.
            // ponytail: ViGEm's get_user_index reported 0 for every pad here; revisit if numbers drift from the game's.
            let number = (1..).find(|n| players.iter().all(|p| p.number != *n)).unwrap();
            match join(&config, udp_addr, phone_ufrag, &vigem, number) {
                Ok(mut p) => {
                    println!("Player {} joined from {source}.", p.number);
                    let _ = p.rtc.handle_input(input);
                    players.push(p);
                }
                Err(e) => println!("A phone couldn't join: {e}"),
            }
        }
    }
}

/// The phone's ICE ufrag, if this packet is a genuine connection check from a
/// phone that scanned our QR code (it knows our ufrag and password).
fn new_phone(data: &[u8], creds: &IceCreds, hmac: impl Fn(&[u8], &[&[u8]]) -> [u8; 20]) -> Option<String> {
    let msg = StunMessage::parse(data).ok()?;
    let (local, remote) = msg.split_username()?;
    (local == creds.ufrag && msg.verify(creds.pass.as_bytes(), hmac)).then(|| remote.to_string())
}

/// A connection plus a freshly plugged-in virtual Xbox controller for one phone.
fn join(config: &RtcConfig, local: SocketAddr, phone_ufrag: String, vigem: &Rc<Client>, number: u32) -> Result<Player, Box<dyn Error>> {
    let mut rtc = config.clone().build(Instant::now());
    rtc.add_local_candidate(Candidate::host(local, "udp")?).ok_or("host candidate")?;
    let mut api = rtc.direct_api();
    // Ice-lite str0m holds connection checks until it knows the phone's ufrag,
    // which only the phone's SDP has, and that SDP never leaves the phone. The
    // caller reads it off the phone's first check instead.
    api.set_remote_ice_credentials(IceCreds { ufrag: phone_ufrag, pass: "unused-by-ice-lite".into() });
    // str0m won't start DTLS without an expected fingerprint; verification is off, so any value works.
    api.set_remote_fingerprint(Fingerprint { hash_func: "sha-256".into(), bytes: vec![0; 32] });
    api.set_ice_controlling(false);
    api.start_dtls(false)?;
    api.start_sctp(false);
    api.create_data_channel(ChannelConfig {
        label: "pad".into(),
        ordered: false,
        reliability: Reliability::MaxRetransmits { retransmits: 0 },
        negotiated: Some(0),
        ..Default::default()
    });

    let mut pad = Xbox360Wired::new(vigem.clone(), TargetId::XBOX360_WIRED);
    pad.plugin().map_err(|e| format!("plug in controller: {e:?}"))?;
    pad.wait_ready().map_err(|e| format!("controller ready: {e:?}"))?;
    Ok(Player { rtc, pad, number, last_seq: None, last_input: Instant::now(), state: XGamepad::default() })
}

/// Runs one phone's connection until it has nothing to do before `next`.
fn drive(p: &mut Player, udp: &UdpSocket, next: &mut Instant) -> Result<(), Box<dyn Error>> {
    loop {
        match p.rtc.poll_output()? {
            Output::Timeout(t) if t <= Instant::now() => p.rtc.handle_input(Input::Timeout(Instant::now()))?,
            Output::Timeout(t) => {
                *next = (*next).min(t);
                return Ok(());
            }
            Output::Transmit(t) => {
                udp.send_to(&t.contents, t.destination)?;
            }
            Output::Event(Event::IceConnectionStateChange(IceConnectionState::Disconnected)) => {
                p.rtc.disconnect();
                return Ok(());
            }
            Output::Event(Event::ChannelOpen(..)) => println!("Player {} connected.", p.number),
            Output::Event(Event::ChannelData(d)) if d.binary => p.apply(&d.data),
            Output::Event(Event::ChannelData(d)) => {
                // Ping: echo it with the player number, so the phone can time the
                // round trip and show which player it is.
                let reply = format!("{} {}", String::from_utf8_lossy(&d.data), p.number);
                if let Some(mut chan) = p.rtc.channel(d.id) {
                    chan.write(false, reply.as_bytes())?;
                }
            }
            Output::Event(_) => {}
        }
    }
}

impl Player {
    /// One state packet from the phone: seq u16, then XInput's own layout
    /// (buttons u16, LT u8, RT u8, LX LY RX RY i16), all little-endian.
    fn apply(&mut self, packet: &[u8]) {
        let Ok(b) = <[u8; 14]>::try_from(packet) else { return };
        let seq = u16::from_le_bytes([b[0], b[1]]);
        // Delivery is unordered: skip anything older than what's already applied.
        if self.last_seq.is_some_and(|last| seq.wrapping_sub(last) as i16 <= 0) {
            return;
        }
        self.last_seq = Some(seq);
        self.last_input = Instant::now();
        let i16_at = |i: usize| i16::from_le_bytes([b[i], b[i + 1]]);
        self.state = XGamepad {
            buttons: XButtons(u16::from_le_bytes([b[2], b[3]])),
            left_trigger: b[4],
            right_trigger: b[5],
            thumb_lx: i16_at(6),
            thumb_ly: i16_at(8),
            thumb_rx: i16_at(10),
            thumb_ry: i16_at(12),
        };
        if let Err(e) = self.pad.update(&self.state) {
            println!("Player {}: controller update failed: {e:?}", self.number);
        }
    }
}

/// The PC's address on the local network: asks the OS which interface routes
/// outward. Connecting a UDP socket sends nothing.
fn lan_ip() -> IpAddr {
    let s = UdpSocket::bind("0.0.0.0:0").expect("UDP socket");
    s.connect("8.8.8.8:80")
        .expect("no network route; pass the PC's Wi-Fi IP as the first argument");
    s.local_addr().expect("local address").ip()
}
