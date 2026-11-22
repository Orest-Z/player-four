//! The PC window: the QR code to scan, who's playing and how, and a tray icon so
//! closing the window keeps everyone's controller connected. egui draws it; it
//! repaints only when something changes, or ~30 times a second while phones are
//! connected and the window is showing. Hidden in the tray it doesn't draw at all.

use std::fs;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use eframe::egui::text::{LayoutJob, TextFormat};
use eframe::egui::{
    self, Align, Align2, Color32, ColorImage, CornerRadius, FontData, FontDefinitions, FontFamily, FontId, Frame,
    Layout, Margin, Painter, Pos2, Rect, Response, RichText, Sense, Stroke, StrokeKind, TextStyle, TextureHandle,
    TextureOptions, Ui, Vec2, ViewportCommand, vec2,
};
use qrcode::{Color as Module, QrCode};
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

use crate::{PlayerView, Problem, Shared};

const LOGO: &[u8] = include_bytes!("../../phone/icon.png");
/// Remembers what the window's X button should do.
const SETTINGS: &str = "playerfour-settings.txt";
/// A second launch finds the first one here and asks it to show its window instead.
const INSTANCE_PORT: u16 = 47801;
const DRIVER_URL: &str = "https://github.com/nefarius/ViGEmBus/releases/latest";

// The phone app's palette (phone/src/style.css), so both screens feel like one product.
const BG: Color32 = Color32::from_rgb(0x0b, 0x0d, 0x10);
const PANEL: Color32 = Color32::from_rgb(0x14, 0x17, 0x1c);
const RAISED: Color32 = Color32::from_rgb(0x1c, 0x20, 0x27);
const LINE: Color32 = Color32::from_rgb(0x25, 0x29, 0x31);
const OFF: Color32 = Color32::from_rgb(0x2a, 0x2f, 0x37);
const TEXT: Color32 = Color32::from_rgb(0xee, 0xf1, 0xf5);
const MUTED: Color32 = Color32::from_rgb(0x8b, 0x93, 0xa1);
const GREEN: Color32 = Color32::from_rgb(0x22, 0xc5, 0x5e);
const AMBER: Color32 = Color32::from_rgb(0xea, 0xb3, 0x08);
const RED: Color32 = Color32::from_rgb(0xef, 0x44, 0x44);
/// Players 1-4, as on the phones' badges and in the logo.
const PLAYER: [Color32; 4] = [
    Color32::from_rgb(0x3b, 0x82, 0xf6),
    Color32::from_rgb(0xf9, 0x73, 0x16),
    Color32::from_rgb(0xa8, 0x55, 0xf7),
    Color32::from_rgb(0xea, 0xb3, 0x08),
];

static CTX: OnceLock<egui::Context> = OnceLock::new();

/// Redraw soon, from any thread. Works while hidden too (App::logic runs).
pub fn wake() {
    if let Some(ctx) = CTX.get() {
        ctx.request_repaint();
    }
}

fn show_window() {
    if let Some(ctx) = CTX.get() {
        ctx.send_viewport_cmd(ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(ViewportCommand::Minimized(false));
        ctx.send_viewport_cmd(ViewportCommand::Focus);
        ctx.request_repaint();
    }
}

/// True if Player Four is already running; that copy is asked to show its window.
/// Otherwise this copy starts listening for later launches.
pub fn already_running() -> bool {
    match TcpListener::bind((Ipv4Addr::LOCALHOST, INSTANCE_PORT)) {
        Ok(listener) => {
            std::thread::spawn(move || listener.incoming().for_each(|_| show_window()));
            false
        }
        // ponytail: assumes whoever holds the port is us; move the port if something else ever does.
        Err(_) => TcpStream::connect((Ipv4Addr::LOCALHOST, INSTANCE_PORT)).is_ok(),
    }
}

pub fn run(shared: Arc<Mutex<Shared>>) -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Player Four")
            .with_inner_size([900.0, 580.0])
            .with_min_inner_size([800.0, 540.0])
            .with_icon(eframe::icon_data::from_png_bytes(LOGO).expect("logo")),
        centered: true,
        ..Default::default()
    };
    eframe::run_native("Player Four", options, Box::new(|cc| Ok(Box::new(App::new(cc, shared)))))
}

#[derive(Clone, Copy, PartialEq)]
enum OnClose {
    Ask,
    Tray,
    Quit,
}

struct App {
    shared: Arc<Mutex<Shared>>,
    logo: TextureHandle,
    /// The QR code for this link, one texel per module.
    qr: Option<(String, TextureHandle, usize)>,
    tray: Option<TrayIcon>,
    tooltip: String,
    on_close: OnClose,
    asking: bool,
    copied: Option<Instant>,
}

impl App {
    fn new(cc: &eframe::CreationContext, shared: Arc<Mutex<Shared>>) -> Self {
        let ctx = &cc.egui_ctx;
        let _ = CTX.set(ctx.clone());
        style(ctx);
        let logo = image::load_from_memory(LOGO).expect("logo").to_rgba8();
        let size = [logo.width() as usize, logo.height() as usize];
        let on_close = match fs::read_to_string(SETTINGS).unwrap_or_default().trim() {
            "close=tray" => OnClose::Tray,
            "close=quit" => OnClose::Quit,
            _ => OnClose::Ask,
        };
        Self {
            shared,
            logo: ctx.load_texture("logo", ColorImage::from_rgba_unmultiplied(size, &logo), TextureOptions::LINEAR),
            qr: None,
            tray: tray(&logo),
            tooltip: String::new(),
            on_close,
            asking: false,
            copied: None,
        }
    }

    fn header(&self, ui: &mut Ui, state: &Shared) {
        ui.horizontal(|ui| {
            ui.add(egui::Image::new((self.logo.id(), Vec2::splat(46.0))));
            ui.add_space(4.0);
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 1.0;
                ui.add_space(3.0);
                let mut title = LayoutJob::default();
                let font_id = FontId::new(19.0, family("bold"));
                title.append("PLAYER FOUR", 0.0, TextFormat { font_id, color: TEXT, extra_letter_spacing: 3.2, ..Default::default() });
                ui.label(title);
                ui.label(RichText::new("Your phone is the controller").size(13.0).color(MUTED));
            });
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let (dot, text) = match (&state.problem, &state.url) {
                    (Some(Problem::NoDriver), _) => (RED, "Driver needed".to_string()),
                    (Some(Problem::Failed(_)), _) => (RED, "Stopped".to_string()),
                    (None, Some(url)) => (GREEN, format!("Ready  ·  {}", address(url))),
                    (None, None) => (AMBER, "Starting…".to_string()),
                };
                pill(ui, dot, &text);
            });
        });
    }

    fn join_card(&mut self, ui: &mut Ui, state: &Shared) {
        ui.vertical_centered(|ui| match (&state.problem, &state.url) {
            (Some(Problem::NoDriver), _) => notice(
                ui,
                "One-time setup",
                "Install the controller driver",
                "Player Four uses ViGEmBus to create the Xbox controllers that games see. \
                 Install it once; this window carries on by itself when it's done.",
                Some(("Download ViGEmBus", DRIVER_URL)),
            ),
            (Some(Problem::Failed(why)), _) => notice(ui, "Player Four stopped", why, "Quit it from the tray and open it again.", None),
            (None, None) => {
                ui.add_space(150.0);
                ui.spinner();
                ui.label(RichText::new("Starting…").color(MUTED));
            }
            (None, Some(url)) => self.qr_code(ui, url),
        });
    }

    fn qr_code(&mut self, ui: &mut Ui, url: &str) {
        if self.qr.as_ref().is_none_or(|(shown, ..)| shown != url) {
            let code = QrCode::new(url).expect("the link fits in a QR code");
            let side = code.width();
            let rgb: Vec<u8> = code
                .to_colors()
                .iter()
                .flat_map(|m| if *m == Module::Dark { [0x0b, 0x0d, 0x10] } else { [0xff; 3] })
                .collect();
            let texture = ui.ctx().load_texture("qr", ColorImage::from_rgb([side, side], &rgb), TextureOptions::NEAREST);
            self.qr = Some((url.to_string(), texture, side));
        }
        let (_, texture, side) = self.qr.as_ref().unwrap();
        // Whole screen pixels per module, so every square is crisp for the camera.
        let ppp = ui.ctx().pixels_per_point();
        // As big as the card allows (up to 236 pt), leaving room for the text and button below.
        let room = (ui.available_height() - 150.0).clamp(140.0, 236.0);
        let module_px = ((room * ppp) / *side as f32).floor().max(1.0);
        let size = module_px * *side as f32 / ppp;
        ui.add_space(((ui.available_height() - size - 172.0) / 2.0).max(0.0)); // centered in the card
        Frame::new().fill(Color32::WHITE).corner_radius(CornerRadius::same(18)).inner_margin(Margin::same(16)).show(ui, |ui| {
            ui.add(egui::Image::new((texture.id(), Vec2::splat(size))));
        });
        ui.add_space(14.0);
        ui.label(RichText::new("Scan with your phone's camera").size(17.0).family(family("semibold")).color(TEXT));
        ui.label(RichText::new("Same Wi-Fi as this PC  ·  up to 4 players").size(13.0).color(MUTED));
        ui.add_space(8.0);
        let copied = self.copied.is_some_and(|t| t.elapsed() < Duration::from_millis(1600));
        let label = RichText::new(if copied { "✔  Link copied" } else { "Copy link" }).size(13.0);
        let button = ui.add(egui::Button::new(label).min_size(vec2(132.0, 32.0)));
        if button.on_hover_text("For a phone that can't scan: send it this link").clicked() {
            ui.ctx().copy_text(url.to_string());
            self.copied = Some(Instant::now());
            ui.ctx().request_repaint_after(Duration::from_millis(1700));
        }
    }

    fn ask_close(&mut self, ctx: &egui::Context) {
        let frame = Frame::new()
            .fill(PANEL)
            .stroke(Stroke::new(1.0, LINE))
            .corner_radius(CornerRadius::same(18))
            .inner_margin(Margin::same(26));
        let modal = egui::Modal::new(egui::Id::unique("close")).frame(frame).backdrop_color(Color32::from_black_alpha(170)).show(ctx, |ui| {
            ui.set_width(420.0);
            ui.label(RichText::new("Keep Player Four running?").size(19.0).family(family("bold")).color(TEXT));
            ui.add_space(2.0);
            ui.label(
                RichText::new(
                    "It can wait in the tray, next to the clock. Phones stay connected and \
                     games keep their controllers.",
                )
                .color(MUTED),
            );
            ui.add_space(16.0);
            let mut choice = None;
            ui.horizontal(|ui| {
                if primary(ui, "Keep running in tray").clicked() {
                    choice = Some(OnClose::Tray);
                }
                if ui.add(egui::Button::new("Quit").min_size(vec2(90.0, 38.0))).clicked() {
                    choice = Some(OnClose::Quit);
                }
            });
            ui.add_space(4.0);
            ui.label(RichText::new("Player Four remembers your choice.").size(12.0).color(MUTED));
            choice
        });
        if let Some(choice) = modal.inner {
            self.on_close = choice;
            self.asking = false;
            let _ = fs::write(SETTINGS, if choice == OnClose::Tray { "close=tray" } else { "close=quit" });
            ctx.send_viewport_cmd(if choice == OnClose::Tray { ViewportCommand::Visible(false) } else { ViewportCommand::Close });
        } else if modal.should_close() {
            self.asking = false;
        }
    }
}

impl eframe::App for App {
    /// Runs before every frame and also while hidden in the tray.
    fn logic(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if ctx.input(|i| i.viewport().close_requested()) {
            match (self.tray.is_some(), self.on_close) {
                (true, OnClose::Tray) => {
                    ctx.send_viewport_cmd(ViewportCommand::CancelClose);
                    ctx.send_viewport_cmd(ViewportCommand::Visible(false));
                }
                (true, OnClose::Ask) => {
                    ctx.send_viewport_cmd(ViewportCommand::CancelClose);
                    self.asking = true;
                }
                _ => {} // no tray (or the player chose Quit): closing quits
            }
        }
        if let Some(tray) = &self.tray {
            let tip = match self.shared.lock().unwrap().players.len() {
                0 => "Player Four · waiting for players".to_string(),
                1 => "Player Four · 1 player".to_string(),
                n => format!("Player Four · {n} players"),
            };
            if tip != self.tooltip {
                let _ = tray.set_tooltip(Some(&tip));
                self.tooltip = tip;
            }
        }
    }

    fn ui(&mut self, ui: &mut Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let state = self.shared.lock().unwrap().clone();
        let page = Frame::new().fill(BG).inner_margin(Margin::symmetric(28, 24));
        egui::CentralPanel::default().frame(page).show(ui, |ui| {
            self.header(ui, &state);
            ui.add_space(20.0);
            let height = ui.available_height() - 56.0; // the footer below
            ui.horizontal_top(|ui| {
                ui.spacing_mut().item_spacing.x = 16.0;
                card(ui, 340.0, height, |ui| self.join_card(ui, &state));
                let rest = ui.available_width();
                card(ui, rest, height, |ui| players(ui, &state.players));
            });
            ui.add_space(14.0);
            footer(ui, self.tray.is_some());
        });
        if self.asking {
            self.ask_close(&ctx);
        }
        // Live inputs move on their own; nothing else needs a timer.
        if state.players.iter().any(|p| p.open) {
            ctx.request_repaint_after(Duration::from_millis(33));
        }
    }
}

/// Windows' own UI font when it's there, egui's built-in font otherwise (and for symbols).
fn style(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let fallback = fonts.families[&FontFamily::Proportional].clone();
    for (name, file) in [("regular", "segoeui.ttf"), ("semibold", "seguisb.ttf"), ("bold", "segoeuib.ttf")] {
        let mut chain = fallback.clone();
        if let Ok(bytes) = fs::read(format!("C:/Windows/Fonts/{file}")) {
            fonts.font_data.insert(name.into(), Arc::new(FontData::from_owned(bytes)));
            chain.insert(0, name.into());
        }
        fonts.families.insert(family(name), chain);
    }
    fonts.families.insert(FontFamily::Proportional, fonts.families[&family("regular")].clone());
    ctx.set_fonts(fonts);

    ctx.set_theme(egui::Theme::Dark);
    ctx.all_styles_mut(|s| {
        s.text_styles.insert(TextStyle::Small, FontId::proportional(12.0));
        s.text_styles.insert(TextStyle::Body, FontId::proportional(14.0));
        s.text_styles.insert(TextStyle::Button, FontId::proportional(14.0));
        s.text_styles.insert(TextStyle::Heading, FontId::proportional(20.0));
        s.spacing.button_padding = vec2(14.0, 8.0);
        s.spacing.item_spacing = vec2(8.0, 8.0);
        let v = &mut s.visuals;
        v.panel_fill = BG;
        v.window_fill = PANEL;
        v.extreme_bg_color = BG;
        v.faint_bg_color = RAISED;
        v.selection.bg_fill = PLAYER[0];
        v.widgets.noninteractive.fg_stroke = Stroke::new(1.0, TEXT);
        v.widgets.noninteractive.bg_stroke = Stroke::new(1.0, LINE);
        for (w, fill) in [
            (&mut v.widgets.inactive, RAISED),
            (&mut v.widgets.hovered, Color32::from_rgb(0x27, 0x2c, 0x34)),
            (&mut v.widgets.active, Color32::from_rgb(0x30, 0x36, 0x3f)),
        ] {
            w.bg_fill = fill;
            w.weak_bg_fill = fill;
            w.bg_stroke = Stroke::new(1.0, LINE);
            w.fg_stroke = Stroke::new(1.0, TEXT);
            w.corner_radius = CornerRadius::same(10);
            w.expansion = 0.0;
        }
    });
}

/// The icon by the clock: left click shows the window, right click offers Show and Quit.
/// None where the desktop has no tray; closing the window then quits.
fn tray(logo: &image::RgbaImage) -> Option<TrayIcon> {
    let small = image::imageops::resize(logo, 32, 32, image::imageops::FilterType::Lanczos3);
    let show = MenuItem::new("Show Player Four", true, None);
    let quit = MenuItem::new("Quit Player Four", true, None);
    let menu = Menu::new();
    menu.append_items(&[&show, &PredefinedMenuItem::separator(), &quit]).ok()?;
    let quit_id = quit.id().clone();
    // Quitting ends the process, and Windows unplugs its virtual controllers with it.
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| if e.id == quit_id { std::process::exit(0) } else { show_window() }));
    TrayIconEvent::set_event_handler(Some(|e| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            show_window();
        }
    }));
    TrayIconBuilder::new()
        .with_icon(Icon::from_rgba(small.into_raw(), 32, 32).ok()?)
        .with_tooltip("Player Four")
        .with_menu(Box::new(menu))
        .with_menu_on_left_click(false)
        .build()
        .ok()
}

fn family(name: &str) -> FontFamily {
    FontFamily::Name(name.into())
}

/// "192.168.1.10" from the QR link.
fn address(url: &str) -> &str {
    let rest = url.trim_start_matches("https://");
    rest.split([':', '/']).next().unwrap_or(rest)
}

fn card(ui: &mut Ui, width: f32, height: f32, add: impl FnOnce(&mut Ui)) {
    Frame::new()
        .fill(PANEL)
        .stroke(Stroke::new(1.0, LINE))
        .corner_radius(CornerRadius::same(20))
        .inner_margin(Margin::same(22))
        .show(ui, |ui| {
            ui.set_width(width - 46.0);
            ui.set_height(height - 46.0); // exactly: contents size themselves to fit
            ui.vertical(add); // cards sit side by side; their contents stack
        });
}

/// "● Ready · 192.168.1.10", sized to its text.
fn pill(ui: &mut Ui, dot: Color32, text: &str) {
    let galley = ui.painter().layout_no_wrap(text.to_string(), FontId::proportional(13.0), TEXT);
    let (rect, _) = ui.allocate_exact_size(vec2(galley.size().x + 44.0, 32.0), Sense::hover());
    let painter = ui.painter();
    painter.rect(rect, CornerRadius::same(16), PANEL, Stroke::new(1.0, LINE), StrokeKind::Inside);
    painter.circle_filled(Pos2::new(rect.left() + 17.0, rect.center().y), 4.0, dot);
    painter.galley(Pos2::new(rect.left() + 29.0, rect.center().y - galley.size().y / 2.0), galley, TEXT);
}

fn primary(ui: &mut Ui, text: &str) -> Response {
    let label = RichText::new(text).size(14.0).family(family("semibold")).color(Color32::WHITE);
    ui.add(egui::Button::new(label).fill(PLAYER[0]).stroke(Stroke::NONE).min_size(vec2(0.0, 38.0)))
}

/// Something needs the player's attention instead of the QR code.
fn notice(ui: &mut Ui, kicker: &str, title: &str, body: &str, action: Option<(&str, &str)>) {
    ui.add_space(70.0);
    let (rect, _) = ui.allocate_exact_size(Vec2::splat(56.0), Sense::hover());
    ui.painter().circle_filled(rect.center(), 28.0, RED.gamma_multiply(0.16));
    ui.painter().text(rect.center(), Align2::CENTER_CENTER, "!", FontId::new(28.0, family("bold")), RED);
    ui.add_space(10.0);
    ui.label(RichText::new(kicker).size(12.5).color(MUTED));
    ui.label(RichText::new(title).size(19.0).family(family("bold")).color(TEXT));
    ui.add_space(2.0);
    ui.label(RichText::new(body).size(13.5).color(MUTED));
    if let Some((label, url)) = action {
        ui.add_space(14.0);
        if primary(ui, label).clicked() {
            ui.ctx().open_url(egui::OpenUrl::new_tab(url));
        }
    }
}

fn players(ui: &mut Ui, players: &[PlayerView]) {
    ui.horizontal(|ui| {
        ui.label(RichText::new("Players").size(17.0).family(family("semibold")).color(TEXT));
        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.label(RichText::new(format!("{} of 4", players.len())).size(13.0).color(MUTED));
        });
    });
    ui.add_space(4.0);
    ui.spacing_mut().item_spacing.y = 10.0;
    let row = ((ui.available_height() - 30.0) / 4.0).clamp(60.0, 84.0);
    for n in 1..=4 {
        player_row(ui, n, players.iter().find(|p| p.number == n), row);
    }
}

fn player_row(ui: &mut Ui, n: u32, player: Option<&PlayerView>, height: f32) {
    let color = PLAYER[n as usize - 1];
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), height), Sense::hover());
    let painter = ui.painter();
    let here = player.is_some();
    let edge = if here { color.gamma_multiply(0.45) } else { LINE };
    painter.rect(rect, CornerRadius::same(16), if here { RAISED } else { PANEL }, Stroke::new(1.0, edge), StrokeKind::Inside);

    let badge = Pos2::new(rect.left() + 38.0, rect.center().y);
    let tag = format!("P{n}");
    if here {
        painter.circle_filled(badge, 20.0, color);
        painter.text(badge, Align2::CENTER_CENTER, tag, FontId::new(14.0, family("bold")), BG);
    } else {
        painter.circle_stroke(badge, 19.0, Stroke::new(1.5, color.gamma_multiply(0.4)));
        painter.text(badge, Align2::CENTER_CENTER, tag, FontId::new(14.0, family("bold")), color.gamma_multiply(0.55));
    }

    let x = badge.x + 34.0;
    let name = FontId::new(15.0, family("semibold"));
    painter.text(Pos2::new(x, rect.center().y - 10.0), Align2::LEFT_CENTER, format!("Player {n}"), name, if here { TEXT } else { MUTED });
    let status = match player {
        None => "Waiting for a phone…",
        Some(p) if !p.open => "Connecting…",
        Some(p) => describe(&p.mode),
    };
    painter.text(Pos2::new(x, rect.center().y + 11.0), Align2::LEFT_CENTER, status, FontId::proportional(13.0), MUTED);

    if let Some(p) = player.filter(|p| p.open) {
        let mut right = rect.right() - 18.0;
        if let Some(ms) = p.rtt_ms {
            right = latency(painter, Pos2::new(right, rect.center().y), ms) - 16.0;
        }
        live_inputs(painter, Pos2::new(right - LIVE_WIDTH, rect.center().y - 18.0), p, color);
    }
}

/// What the phone said it's doing (phone/src/main.js), in words.
fn describe(mode: &str) -> &'static str {
    match mode {
        "racing tilt" => "Racing  ·  tilt steering",
        "racing touch" => "Racing  ·  touch wheel",
        "party" => "Party",
        "retro" => "Retro",
        "full" => "Full pad",
        "picking" => "Choosing a controller…",
        _ => "Connected",
    }
}

/// Draws "● 3 ms" ending at `right_middle`; returns its left edge.
fn latency(painter: &Painter, right_middle: Pos2, ms: u32) -> f32 {
    let dot = if ms < 25 { GREEN } else if ms < 60 { AMBER } else { RED };
    let text = painter.layout_no_wrap(format!("{ms} ms"), FontId::proportional(13.0), TEXT);
    let width = text.size().x + 34.0;
    let rect = Rect::from_center_size(Pos2::new(right_middle.x - width / 2.0, right_middle.y), vec2(width, 28.0));
    painter.rect_filled(rect, CornerRadius::same(14), BG);
    painter.circle_filled(Pos2::new(rect.left() + 14.0, rect.center().y), 3.5, dot);
    painter.galley(Pos2::new(rect.left() + 24.0, rect.center().y - text.size().y / 2.0), text, TEXT);
    rect.left()
}

const LIVE_WIDTH: f32 = 110.0;

/// A tiny live controller, as the game receives it: left stick, the two
/// triggers (brake red, gas green, like the phone's pedals) and the face buttons.
fn live_inputs(painter: &Painter, top_left: Pos2, p: &PlayerView, color: Color32) {
    let g = &p.pad;
    let mid = top_left.y + 18.0;

    let stick = Pos2::new(top_left.x + 18.0, mid);
    painter.circle_filled(stick, 17.0, BG);
    painter.circle_stroke(stick, 17.0, Stroke::new(1.0, LINE));
    let tilt = vec2(g.thumb_lx as f32, -(g.thumb_ly as f32)) / 32767.0;
    painter.circle_filled(stick + tilt * 12.0, 5.0, color);

    for (i, (value, fill)) in [(g.left_trigger, RED), (g.right_trigger, GREEN)].into_iter().enumerate() {
        let track = Rect::from_min_size(Pos2::new(top_left.x + 44.0 + i as f32 * 12.0, top_left.y + 2.0), vec2(7.0, 32.0));
        painter.rect_filled(track, CornerRadius::same(4), BG);
        let filled = track.height() * value as f32 / 255.0;
        painter.rect_filled(Rect::from_min_max(Pos2::new(track.left(), track.bottom() - filled), track.max), CornerRadius::same(4), fill);
    }

    let face = Pos2::new(top_left.x + 92.0, mid);
    for (bit, offset, lit) in [
        (0x8000, vec2(0.0, -10.0), AMBER),    // Y
        (0x4000, vec2(-10.0, 0.0), PLAYER[0]), // X
        (0x2000, vec2(10.0, 0.0), RED),       // B
        (0x1000, vec2(0.0, 10.0), GREEN),     // A
    ] {
        painter.circle_filled(face + offset, 4.5, if g.buttons.raw & bit != 0 { lit } else { OFF });
    }
}

fn footer(ui: &mut Ui, tray: bool) {
    ui.horizontal(|ui| {
        ui.label(RichText::new("First time on a phone? Tap Advanced, then Proceed, on its security warning.").size(12.5).color(MUTED));
        if tray {
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new("Closing keeps it running in the tray").size(12.5).color(MUTED));
            });
        }
    });
}
