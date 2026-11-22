//! Player Four's PC side: up to 4 phones become virtual Xbox 360 controllers, all
//! from one QR code. Phone browser -> PC over WebRTC with no signaling server.
//! The window (ui.rs) owns the main thread; phones and controllers run on their own
//! thread, so drawing never delays a button press.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // no console window

mod ui;

use std::error::Error;
use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, UdpSocket};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rustls::ServerConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use str0m::channel::{ChannelConfig, Reliability};
use str0m::config::Fingerprint;
use str0m::ice::StunMessage;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, Rtc, RtcConfig};
use vigem_client::{Client, TargetId, XButtons, XGamepad, Xbox360Wired};

/// The phone app, packed into the program by build.rs: (path, contents).
static PHONE_FILES: &[(&str, &[u8])] = include!(concat!(env!("OUT_DIR"), "/phone_files.rs"));
/// XInput's limit.
const MAX_PLAYERS: usize = 4;
/// A phone that goes quiet this long (screen locked, browser in the background)
/// gets its controller reset to neutral, so nobody's truck keeps accelerating.
/// Phones send a heartbeat every 100 ms.
const STALE: Duration = Duration::from_millis(500);

/// What the window shows. The host thread keeps it current.
#[derive(Clone, Default)]
pub struct Shared {
    /// The QR code's link, once phones can connect.
    pub url: Option<String>,
    pub problem: Option<Problem>,
    pub players: Vec<PlayerView>,
}

#[derive(Clone)]
pub enum Problem {
    /// ViGEmBus isn't installed, so there are no controllers to give phones.
    NoDriver,
    Failed(String),
}

/// One player as the window shows them.
#[derive(Clone, Default, PartialEq)]
pub struct PlayerView {
    /// 1-4: what games and Windows call this controller.
    pub number: u32,
    /// Inputs are flowing.
    pub open: bool,
    /// Round trip as the phone last measured it.
    pub rtt_ms: Option<u32>,
    /// What the phone is doing, e.g. "racing-tilt" (phone/src/main.js).
    pub mode: String,
    /// The name and color the player picked on their phone, if any.
    pub name: String,
    pub color: Option<[u8; 3]>,
    /// The controller state the game sees.
    pub pad: XGamepad,
}

struct Player {
    rtc: Rtc,
    pad: Xbox360Wired<Rc<Client>>,
    last_seq: Option<u16>,
    last_input: Instant,
    view: PlayerView,
}

fn main() -> eframe::Result {
    if ui::already_running() {
        println!("Player Four is already running: showing its window.");
        return Ok(());
    }
    let shared = Arc::new(Mutex::new(Shared::default()));
    let host_shared = shared.clone();
    std::thread::spawn(move || {
        if let Err(e) = host(&host_shared) {
            println!("Stopped: {e}");
            host_shared.lock().unwrap().problem = Some(Problem::Failed(e.to_string()));
            ui::wake();
        }
    });
    ui::run(shared)
}

/// Phones in, controllers out. Runs until the app quits.
fn host(shared: &Mutex<Shared>) -> Result<(), Box<dyn Error>> {
    let crypto = str0m::crypto::from_feature_flags();
    let cert = crypto.dtls_provider.generate_certificate().ok_or("couldn't make a DTLS certificate")?;
    let hmac = crypto.sha1_hmac_provider;
    crypto.install_process_default();

    let ip = match std::env::args().nth(1) {
        Some(arg) => arg.parse().map_err(|_| "usage: player-four [pc-wifi-ip]")?,
        None => lan_ip()?,
    };
    let udp = UdpSocket::bind((ip, 0))?;
    let udp_addr = udp.local_addr()?;
    // Fixed port when free: phones remember their controller mode per address.
    let http = TcpListener::bind((ip, 47800)).or_else(|_| TcpListener::bind((ip, 0)))?;
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

    let tls = tls_config(ip)?;
    let url = format!(
        "https://{http_addr}/#u={}&p={}&f={fingerprint}&a={udp_addr}",
        creds.ufrag, creds.pass
    );

    // ViGEmBus makes the virtual controllers. Until it's installed there's nothing
    // to play with: the window says how to get it, and we carry on once it's there.
    let vigem = loop {
        match Client::connect() {
            Ok(client) => break Rc::new(client),
            Err(_) => {
                shared.lock().unwrap().problem = Some(Problem::NoDriver);
                ui::wake();
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    };
    {
        let mut s = shared.lock().unwrap();
        s.problem = None;
        s.url = Some(url.clone());
    }
    ui::wake();
    println!("Player Four is ready: {url}"); // tests/run.mjs reads the link from here

    std::thread::spawn(move || {
        for tcp in http.incoming().flatten() {
            let tls = tls.clone();
            // One thread per connection, so a slow or broken phone can't stall the others.
            std::thread::spawn(move || {
                let _ = tcp.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = tcp.set_write_timeout(Some(Duration::from_secs(5)));
                let Ok(conn) = rustls::ServerConnection::new(tls) else { return };
                let mut stream = rustls::StreamOwned::new(conn, tcp);
                if respond(&mut stream).is_ok() {
                    stream.conn.send_close_notify();
                    let _ = stream.flush();
                }
            });
        }
    });

    let mut players: Vec<Player> = Vec::new();
    let mut buf = [0; 2000];
    loop {
        let now = Instant::now();
        let mut next = now + Duration::from_millis(100);
        for p in &mut players {
            if let Err(e) = drive(p, &udp, &mut next) {
                println!("Player {}: {e}", p.view.number);
                p.rtc.disconnect();
            }
            if now - p.last_input > STALE && p.view.pad != XGamepad::default() {
                p.view.pad = XGamepad::default();
                let _ = p.pad.update(&p.view.pad);
            }
        }
        for p in players.iter().filter(|p| !p.rtc.is_alive()) {
            println!("Player {} left.", p.view.number);
        }
        players.retain(|p| p.rtc.is_alive()); // dropping a Player unplugs its controller
        publish(shared, &players);

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
            let number = (1..).find(|n| players.iter().all(|p| p.view.number != *n)).unwrap();
            match join(&config, udp_addr, phone_ufrag, &vigem, number) {
                Ok(mut p) => {
                    println!("Player {} joined from {source}.", p.view.number);
                    let _ = p.rtc.handle_input(input);
                    players.push(p);
                }
                Err(e) => println!("A phone couldn't join: {e}"),
            }
        }
    }
}

/// Hands the window a fresh copy of every player. Wakes it only for what it doesn't
/// animate on its own (someone joining, leaving, renaming or switching layout), so a
/// hidden window costs nothing while people play.
fn publish(shared: &Mutex<Shared>, players: &[Player]) {
    let views: Vec<PlayerView> = players.iter().map(|p| p.view.clone()).collect();
    // Live inputs and latency don't count: the window animates those itself while showing.
    let settled = |v: &PlayerView| PlayerView { pad: XGamepad::default(), rtt_ms: None, ..v.clone() };
    let mut s = shared.lock().unwrap();
    let changed = s.players.len() != views.len() || s.players.iter().zip(&views).any(|(a, b)| settled(a) != settled(b));
    s.players = views;
    drop(s);
    if changed {
        ui::wake();
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
    Ok(Player { rtc, pad, last_seq: None, last_input: Instant::now(), view: PlayerView { number, ..Default::default() } })
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
            Output::Event(Event::ChannelOpen(..)) => {
                p.view.open = true;
                println!("Player {} connected.", p.view.number);
            }
            Output::Event(Event::ChannelData(d)) if d.binary => p.apply(&d.data),
            Output::Event(Event::ChannelData(d)) => {
                // Ping: "p <sent> <round trip ms or -> <doing> <color hex or -> <name...>".
                // Echo "p <sent> <player number>", so the phone can time the round trip
                // and show which player it is.
                let text = String::from_utf8_lossy(&d.data);
                let mut words = text.split(' ');
                if words.next() != Some("p") {
                    continue;
                }
                let sent = words.next().unwrap_or("0");
                let me = &mut p.view;
                me.rtt_ms = words.next().and_then(|w| w.parse().ok());
                me.mode = words.next().unwrap_or_default().chars().take(16).collect();
                me.color = words.next().and_then(hex_color);
                me.name = words.collect::<Vec<_>>().join(" ").chars().filter(|c| !c.is_control()).take(16).collect();
                let reply = format!("p {sent} {}", me.number);
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
        self.view.pad = XGamepad {
            buttons: XButtons(u16::from_le_bytes([b[2], b[3]])),
            left_trigger: b[4],
            right_trigger: b[5],
            thumb_lx: i16_at(6),
            thumb_ly: i16_at(8),
            thumb_rx: i16_at(10),
            thumb_ry: i16_at(12),
        };
        if let Err(e) = self.pad.update(&self.view.pad) {
            println!("Player {}: controller update failed: {e:?}", self.view.number);
        }
    }
}

/// HTTPS config with a self-signed certificate. Phones only expose the tilt
/// sensor to secure pages, and a self-signed one counts once the player taps
/// past the browser's warning.
fn tls_config(ip: IpAddr) -> Result<Arc<ServerConfig>, Box<dyn Error>> {
    // Saved, so a phone's "proceed anyway" survives restarts. One per address: a
    // certificate names the address it was made for.
    let ip_name = ip.to_string().replace(':', "_");
    let (cert_file, key_file) = (data_dir().join(format!("tls-{ip_name}-cert.der")), data_dir().join(format!("tls-{ip_name}-key.der")));
    let (cert, key) = match (fs::read(&cert_file), fs::read(&key_file)) {
        (Ok(cert), Ok(key)) => (cert, key),
        _ => {
            let made = rcgen::generate_simple_self_signed(vec![ip.to_string(), "localhost".into()])?;
            let (cert, key) = (made.cert.der().to_vec(), made.signing_key.serialize_der());
            fs::write(&cert_file, &cert)?;
            fs::write(&key_file, &key)?;
            (cert, key)
        }
    };
    let config = ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(cert)], PrivateKeyDer::Pkcs8(key.into()))?;
    Ok(Arc::new(config))
}

/// Answers one GET/HEAD request with a file from the phone app.
fn respond(stream: &mut (impl Read + Write)) -> io::Result<()> {
    let mut req = Vec::new();
    let mut buf = [0; 1024];
    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf)?;
        if n == 0 || req.len() > 8192 {
            return Ok(());
        }
        req.extend_from_slice(&buf[..n]);
    }
    let head = String::from_utf8_lossy(&req);
    let mut words = head.lines().next().unwrap_or_default().split(' ');
    let (method, target) = (words.next().unwrap_or_default(), words.next().unwrap_or_default());

    let (status, content_type, body) = if method != "GET" && method != "HEAD" {
        ("405 Method Not Allowed", "text/plain", &b"Method not allowed"[..])
    } else {
        match resolve(target) {
            None => ("400 Bad Request", "text/plain", &b"Bad request"[..]),
            Some((path, content_type)) => match PHONE_FILES.iter().find(|(name, _)| *name == path) {
                Some((_, body)) => ("200 OK", content_type, *body),
                None => ("404 Not Found", "text/plain", &b"Not found"[..]),
            },
        }
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    )?;
    if method != "HEAD" {
        stream.write_all(body)?;
    }
    stream.flush()
}

/// The phone app file a request target names, with its content type. None for
/// anything that isn't a plain relative path to a file type we serve.
fn resolve(target: &str) -> Option<(&str, &'static str)> {
    let path = target.split(['?', '#']).next()?.strip_prefix('/')?;
    let path = if path.is_empty() { "index.html" } else { path };
    let plain = path.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-/".contains(&b));
    if !plain || path.contains("..") || path.contains("//") || path.starts_with('/') {
        return None;
    }
    let content_type = match path.rsplit_once('.')?.1 {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => return None,
    };
    Some((path, content_type))
}

#[test]
fn resolve_takes_only_plain_paths() {
    assert_eq!(resolve("/"), Some(("index.html", "text/html; charset=utf-8")));
    assert_eq!(resolve("/src/main.js?v=2"), Some(("src/main.js", "text/javascript; charset=utf-8")));
    for bad in ["/../x.js", "/src/../../x.js", "/src/..%2f..%2fx.js", "/a\\b.js", "/C:/x.js", "//x.js", "/x.exe", "x.js", "/con.js:alt"] {
        assert!(resolve(bad).is_none(), "{bad}");
    }
}

#[test]
fn the_phone_app_is_packed_in() {
    for needed in ["index.html", "src/main.js", "src/style.css", "icon.png"] {
        assert!(PHONE_FILES.iter().any(|(name, _)| *name == needed), "{needed}");
    }
    assert!(!PHONE_FILES.iter().any(|(name, _)| name.ends_with("tsconfig.json")));
}

/// Where Player Four keeps its certificates and settings: %APPDATA%\Player Four.
pub fn data_dir() -> PathBuf {
    let dir = std::env::var_os("APPDATA").map_or_else(|| PathBuf::from("."), PathBuf::from).join("Player Four");
    let _ = fs::create_dir_all(&dir);
    dir
}

/// "ec4899" as RGB. Phones send their chosen color this way, or "-" for none.
fn hex_color(hex: &str) -> Option<[u8; 3]> {
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let v = u32::from_str_radix(hex, 16).ok()?;
    Some([(v >> 16) as u8, (v >> 8) as u8, v as u8])
}

#[test]
fn hex_color_takes_only_six_hex_digits() {
    assert_eq!(hex_color("ec4899"), Some([0xec, 0x48, 0x99]));
    assert_eq!(hex_color("CBD5E1"), Some([0xcb, 0xd5, 0xe1]));
    for bad in ["-", "", "ec489", "ec48999", "+c4899", "zz4899"] {
        assert_eq!(hex_color(bad), None, "{bad}");
    }
}

/// The PC's address on the local network: asks the OS which interface routes
/// outward. Connecting a UDP socket sends nothing.
fn lan_ip() -> io::Result<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0")?;
    s.connect("8.8.8.8:80")
        .map_err(|_| io::Error::other("This PC isn't on a network. Connect it to Wi-Fi, then reopen Player Four."))?;
    Ok(s.local_addr()?.ip())
}
