//! Throwaway spike: can a phone browser reach this PC over WebRTC with no
//! signaling server? Everything the phone needs travels in the QR code.

use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, TcpListener, UdpSocket};
use std::time::Instant;

use qrcode::QrCode;
use qrcode::render::{svg, unicode};
use str0m::channel::{ChannelConfig, Reliability};
use str0m::config::Fingerprint;
use str0m::ice::StunMessage;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, IceCreds, Input, Output, RtcConfig, RtcError};

const PAGE: &str = include_str!("phone.html");

fn main() -> Result<(), RtcError> {
    str0m::crypto::from_feature_flags().install_process_default();

    let ip = match std::env::args().nth(1) {
        Some(arg) => arg.parse().expect("usage: phonepad-spike [pc-wifi-ip]"),
        None => lan_ip(),
    };
    let udp = UdpSocket::bind((ip, 0))?;
    let udp_addr = udp.local_addr()?;
    let http = TcpListener::bind((ip, 0))?;
    let http_addr = http.local_addr()?;

    let mut rtc = RtcConfig::new()
        .set_ice_lite(true)
        // The phone's DTLS certificate is unknown up front. The phone proves itself
        // by passing ICE instead, which needs the password only the QR code carries.
        .set_fingerprint_verification(false)
        .build(Instant::now());
    rtc.add_local_candidate(Candidate::host(udp_addr, "udp")?)
        .expect("host candidate");

    let mut api = rtc.direct_api();
    let creds = api.local_ice_credentials();
    let fingerprint: String = api
        .local_dtls_fingerprint()
        .bytes
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect();
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

    let url = format!(
        "http://{http_addr}/#u={}&p={}&f={fingerprint}&a={udp_addr}",
        creds.ufrag, creds.pass
    );
    let qr = QrCode::new(&url).expect("URL fits in a QR code");
    // Inverted so it scans on a dark terminal: light modules are drawn as blocks.
    let text_qr = qr
        .render::<unicode::Dense1x2>()
        .dark_color(unicode::Dense1x2::Light)
        .light_color(unicode::Dense1x2::Dark)
        .build();
    std::fs::write("qr.svg", qr.render::<svg::Color>().min_dimensions(320, 320).build())?;
    println!("\n{text_qr}\nScan with your phone on the same Wi-Fi.");
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

    let mut paired = false;
    let mut buf = [0; 2000];
    loop {
        let timeout = match rtc.poll_output()? {
            Output::Timeout(t) => t,
            Output::Transmit(t) => {
                udp.send_to(&t.contents, t.destination)?;
                continue;
            }
            Output::Event(event) => {
                match event {
                    Event::IceConnectionStateChange(IceConnectionState::Disconnected) => {
                        println!("Phone disconnected. Run again to pair a new session.");
                        return Ok(());
                    }
                    Event::ChannelOpen(..) => println!("Phone connected. Tap the buttons."),
                    // Pings are echoed so the phone can time the round trip.
                    Event::ChannelData(d) if d.data.starts_with(b"p ") => {
                        if let Some(mut chan) = rtc.channel(d.id) {
                            chan.write(false, &d.data)?;
                        }
                    }
                    Event::ChannelData(d) => println!("{}", String::from_utf8_lossy(&d.data)),
                    _ => {}
                }
                continue;
            }
        };

        let wait = timeout.saturating_duration_since(Instant::now());
        if wait.is_zero() {
            rtc.handle_input(Input::Timeout(Instant::now()))?;
            continue;
        }
        udp.set_read_timeout(Some(wait))?;

        let (n, source) = match udp.recv_from(&mut buf) {
            Ok(v) => v,
            // ConnectionReset: Windows reporting an ICMP "port unreachable" from an earlier send.
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::ConnectionReset) => {
                rtc.handle_input(Input::Timeout(Instant::now()))?;
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let data = &buf[..n];

        // Ice-lite str0m holds STUN checks until it knows the phone's ufrag, which
        // only the phone's SDP has, and that SDP never leaves the phone. Read the
        // ufrag off the phone's first check instead.
        if !paired
            && let Ok(msg) = StunMessage::parse(data)
            && let Some((local, remote)) = msg.split_username()
            && local == creds.ufrag
        {
            rtc.direct_api().set_remote_ice_credentials(IceCreds {
                ufrag: remote.into(),
                pass: "unused-by-ice-lite".into(),
            });
            paired = true;
            println!("Phone found at {source}, connecting...");
        }

        rtc.handle_input(Input::Receive(
            Instant::now(),
            Receive { proto: Protocol::Udp, source, destination: udp_addr, contents: data.try_into()? },
        ))?;
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
