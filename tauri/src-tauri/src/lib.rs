//! Native side of the USTH Timetable app.
//!
//! The timetable logic (portal crypto, diffing, notifications, scheduling)
//! lives in the web front-end; this crate only provides what a web page
//! cannot do by itself: HTTP with the portal cookies attached, the login
//! window, JSON storage, the tray icon, toasts, autostart, the Windows
//! Credential Manager and self-update.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_updater::UpdaterExt as _;

const ORIGIN: &str = "https://erp.usth.edu.vn";
const PORTAL_URL: &str = "https://erp.usth.edu.vn/students/learn/timetable";
const AUTH_COOKIE: &str = "x-student-portal-token";
/// The account this app is built for. It is pre-filled on the portal login page.
const DEFAULT_ACCOUNT: &str = "namtk2410702";
const KEYRING_SERVICE: &str = "vn.edu.usth.timetable";
const LOGIN_LABEL: &str = "login";
const MAIN_LABEL: &str = "main";
const SILENT_REAUTH_TIMEOUT: Duration = Duration::from_secs(45);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct AppState {
    close_to_tray: Mutex<bool>,
    quitting: Mutex<bool>,
    login_open: Mutex<bool>,
    hidden_start: bool,
}

// ---------- helpers ----------

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(err)?.join("data");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn safe_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("invalid store name {name:?}"));
    }
    Ok(name)
}

/// All cookies the WebView2 profile holds for the portal origin, as a Cookie header.
fn portal_cookie_header(app: &AppHandle) -> String {
    let Some(w) = app.get_webview_window(MAIN_LABEL) else { return String::new() };
    let Ok(url) = Url::parse(ORIGIN) else { return String::new() };
    match w.cookies_for_url(url) {
        Ok(cookies) => cookies
            .iter()
            .map(|c| format!("{}={}", c.name(), c.value()))
            .collect::<Vec<_>>()
            .join("; "),
        Err(_) => String::new(),
    }
}

fn auth_cookie_value(app: &AppHandle) -> Option<String> {
    let w = app.get_webview_window(MAIN_LABEL)?;
    let url = Url::parse(ORIGIN).ok()?;
    let cookies = w.cookies_for_url(url).ok()?;
    cookies.iter().find(|c| c.name() == AUTH_COOKIE).map(|c| c.value().to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn is_portal_host(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case("erp.usth.edu.vn")))
        .unwrap_or(false)
}

/// JavaScript injected into every page of the login window. The USTH portal signs
/// in with a USTH Google account ("Sử dụng email để login!"), so on the SSO login
/// page this takes the Gmail / Google OAuth path (/sso/oauth2/authorization/google)
/// instead of the qldt username+password form. Success is still detected by the new
/// auth cookie back in open_login, whichever way the sign-in actually went.
/// A safe JavaScript double-quoted string literal for `s`, so credentials can be
/// embedded into the init script without breaking out of the string.
fn js_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '<' => out.push_str("\\u003c"),
            '>' => out.push_str("\\u003e"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn login_init_script(email: Option<&str>, password: Option<&str>) -> String {
    const TEMPLATE: &str = r#"(function () {
  var host = location.hostname;
  var TKB_EMAIL = __TKB_EMAIL__;
  var TKB_PASS = __TKB_PASS__;

  // ---- Google's own sign-in pages: log in without showing the form ----
  // The login window shares a persistent WebView2 profile, so after one real
  // Google sign-in the session survives here. We handle three pages:
  //   * account chooser  -> click the USTH tile (no password needed)
  //   * email page       -> type TKB_EMAIL and press Next
  //   * password page    -> type TKB_PASS and press Next
  // Anything Google throws in between (2FA, "verify it's you", a CAPTCHA) has no
  // matching field, so the script just stops and lets the user finish by hand.
  if (host === 'accounts.google.com') {
    function nativeSet(el, val) {
      try {
        var d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        d.set.call(el, val);
      } catch (e) { el.value = val; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function clickNext(sels, n) {
      for (var i = 0; i < sels.length; i++) {
        var b = document.querySelector(sels[i]);
        if (b) { b.click(); if (n > 0) setTimeout(function () { clickNext(sels, n - 1); }, 350); return; }
      }
      if (n > 0) setTimeout(function () { clickNext(sels, n - 1); }, 350);
    }
    function once(flag) {
      try { if (sessionStorage.getItem(flag)) return false; sessionStorage.setItem(flag, '1'); } catch (e) {}
      return true;
    }
    // ONE long-lived poller for the whole Google sign-in. Google moves from the
    // email page to the password page with a same-document (history) navigation,
    // so the init script is NOT re-injected there — the poller must stay alive
    // across that step and act on whichever field is currently on screen. Gating
    // the *fill* on an empty value (not on a one-shot flag) survives React
    // re-rendering the input after we set it.
    var tries = 0;
    var poll = setInterval(function () {
      if (++tries > 150) { clearInterval(poll); return; } // ~60s ceiling

      // Password page first, so the account chip it shows (also a
      // data-identifier) is never mistaken for a chooser tile.
      var pwd = document.querySelector('input[type=password][name=Passwd], input[type=password]');
      if (pwd && pwd.offsetParent !== null) {
        if (!TKB_PASS) { clearInterval(poll); return; } // nothing to type; user finishes
        if (pwd.value.length === 0) nativeSet(pwd, TKB_PASS); // (re)fill if empty
        if (pwd.value.length > 0 && once('tkbPwdNext')) {
          setTimeout(function () { clickNext(['#passwordNext button', '#passwordNext'], 4); }, 250);
        }
        return; // keep polling; the window closes itself once the cookie lands
      }

      // Email page. Do NOT stop after this — the password page follows in the
      // same document and needs this same poller.
      var em = document.querySelector('input[type=email], #identifierId, input[name=identifier]');
      if (em && em.offsetParent !== null) {
        if (!TKB_EMAIL) { clearInterval(poll); return; }
        if (em.value.length === 0) nativeSet(em, TKB_EMAIL);
        if (em.value.length > 0 && once('tkbEmailNext')) {
          setTimeout(function () { clickNext(['#identifierNext button', '#identifierNext'], 4); }, 250);
        }
        return;
      }

      // Account chooser: pick the USTH tile (or the exact email, or the sole one).
      var tiles = document.querySelectorAll('[data-identifier]');
      if (tiles.length) {
        var pick = null, want = (TKB_EMAIL || '').toLowerCase();
        for (var i = 0; i < tiles.length; i++) {
          var id = (tiles[i].getAttribute('data-identifier') || '').toLowerCase();
          if (want && id === want) { pick = tiles[i]; break; }
        }
        if (!pick) for (var j = 0; j < tiles.length; j++) {
          if ((tiles[j].getAttribute('data-identifier') || '').toLowerCase().indexOf('usth') !== -1) { pick = tiles[j]; break; }
        }
        if (!pick && tiles.length === 1) pick = tiles[0];
        if (pick && once('tkbGAcctPicked')) pick.click();
        return; // keep polling; a password page or completion follows
      }
    }, 400);
    return;
  }

  if (host !== 'erp.usth.edu.vn') return;
  if (!/^\/sso\//.test(location.pathname)) {
    // Signed-out visitors land on the public home page; press its "Log in"
    // control so the window goes to the SSO login page.
    var clicks = 0;
    var poll = setInterval(function () {
      var el = document.querySelector('.hp-header__login');
      if (el) { clearInterval(poll); el.click(); }
      else if (++clicks > 60) clearInterval(poll);
    }, 250);
    return;
  }
  // Only the bare login page, never the /sso/login/oauth2/code/google callback,
  // and only once per window so a bounce back to the login page cannot loop.
  if (!/^\/sso\/login\/?$/.test(location.pathname)) return;
  try { if (sessionStorage.getItem('tkbGmailTried')) return; } catch (e) {}
  function go() {
    try { sessionStorage.setItem('tkbGmailTried', '1'); } catch (e) {}
    var btn = document.querySelector('button.social-btn.gmail, .social-btn.gmail');
    if (btn) btn.click();
    else location.assign('/sso/oauth2/authorization/google');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
  else go();
})();"#;
    TEMPLATE
        .replace("__TKB_EMAIL__", &js_string(email.unwrap_or("")))
        .replace("__TKB_PASS__", &js_string(password.unwrap_or("")))
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, DEFAULT_ACCOUNT).map_err(err)
}

fn saved_password() -> Option<String> {
    keyring_entry().ok()?.get_password().ok().filter(|p| !p.is_empty())
}

// ---------- commands: http ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: Option<String>,
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct HttpResponse {
    status: u16,
    body: String,
}

/// Plain HTTP from Rust (no CORS). Requests to the portal get the WebView2
/// cookies attached so the page never sees the session tokens.
#[tauri::command]
async fn http_request(app: AppHandle, req: HttpRequest) -> Result<HttpResponse, String> {
    let method = reqwest::Method::from_bytes(req.method.as_deref().unwrap_or("GET").as_bytes()).map_err(err)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(req.timeout_ms.unwrap_or(30_000)))
        .build()
        .map_err(err)?;
    let mut builder = client.request(method, &req.url);
    for (k, v) in req.headers.unwrap_or_default() {
        builder = builder.header(k, v);
    }
    if is_portal_host(&req.url) {
        let cookie = portal_cookie_header(&app);
        if !cookie.is_empty() {
            builder = builder.header("cookie", cookie);
        }
    }
    if let Some(body) = req.body {
        builder = builder.body(body);
    }
    let res = builder.send().await.map_err(err)?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(err)?;
    Ok(HttpResponse { status, body })
}

// ---------- commands: auth / login window ----------

#[tauri::command]
async fn get_auth_cookie(app: AppHandle) -> Option<String> {
    auth_cookie_value(&app)
}

#[tauri::command]
async fn portal_cookie_names(app: AppHandle) -> Vec<String> {
    portal_cookie_header(&app)
        .split("; ")
        .filter_map(|kv| kv.split('=').next().map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .collect()
}

/// Wipes the WebView2 profile (cookies, storage): used for "sign out" and "re-sign in".
#[tauri::command]
async fn clear_browsing_data(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.close();
    }
    let w = app.get_webview_window(MAIN_LABEL).ok_or("no main window")?;
    w.clear_all_browsing_data().map_err(err)
}

/// Opens the portal in a second window sharing the WebView2 profile and
/// resolves true once a new auth cookie shows up. In silent mode the window
/// stays hidden and only gets a short time: the portal SPA re-runs SSO by
/// itself when the 24 h token has expired but the SSO session is still alive.
#[tauri::command]
async fn open_login(app: AppHandle, state: State<'_, AppState>, silent: bool, title: Option<String>, google_email: Option<String>) -> Result<bool, String> {
    if let Some(existing) = app.get_webview_window(LOGIN_LABEL) {
        if !silent {
            let _ = existing.show();
            let _ = existing.set_focus();
        }
        // Another call is already waiting on this window; just report "no new cookie".
        return Ok(false);
    }
    let before = auth_cookie_value(&app);
    let password = saved_password();
    let script = login_init_script(google_email.as_deref(), password.as_deref());
    let url = Url::parse(PORTAL_URL).map_err(err)?;
    let win = WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(url))
        .title(title.as_deref().unwrap_or("Sign in to USTH student portal"))
        .inner_size(1000.0, 780.0)
        .visible(!silent)
        .initialization_script(&script)
        .build()
        .map_err(err)?;
    *state.login_open.lock().unwrap() = !silent;
    let _ = app.emit("tkb://login-state", !silent);

    let timeout = if silent { SILENT_REAUTH_TIMEOUT } else { LOGIN_TIMEOUT };
    let started = Instant::now();
    let mut ok = false;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        if app.get_webview_window(LOGIN_LABEL).is_none() {
            break; // closed by the user
        }
        let now = auth_cookie_value(&app);
        if now.is_some() && now != before {
            // Give the SPA a moment to finish setting the second cookie.
            tokio::time::sleep(Duration::from_millis(800)).await;
            ok = true;
            break;
        }
        if started.elapsed() > timeout {
            break;
        }
    }
    let _ = win.close();
    *state.login_open.lock().unwrap() = false;
    let _ = app.emit("tkb://login-state", false);
    Ok(ok)
}

// ---------- commands: storage / secrets ----------

#[tauri::command]
fn store_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let file = data_dir(&app)?.join(format!("{}.json", safe_name(&name)?));
    match std::fs::read_to_string(&file) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn store_write(app: AppHandle, name: String, value: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let file = dir.join(format!("{}.json", safe_name(&name)?));
    let tmp = dir.join(format!("{}.json.{}.tmp", name, std::process::id()));
    std::fs::write(&tmp, value).map_err(err)?;
    std::fs::rename(&tmp, &file).map_err(err)
}

#[tauri::command]
fn data_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn password_saved() -> bool {
    saved_password().is_some()
}

#[tauri::command]
fn password_set(value: String) -> Result<(), String> {
    let entry = keyring_entry()?;
    if value.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(err(e)),
        }
    } else {
        entry.set_password(&value).map_err(err)
    }
}

// ---------- commands: desktop integration ----------

#[tauri::command]
fn show_main(app: AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
fn notify_desktop(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification().builder().title(title).body(body).show().map_err(err)
}

#[tauri::command]
fn set_tray_tooltip(app: AppHandle, text: String) {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(text));
    }
}

#[derive(Deserialize)]
pub struct TrayLabels {
    open: String,
    check: String,
    login: String,
    quit: String,
}

/// Relabels the tray menu (the front-end owns the wording, in the user's language).
#[tauri::command]
fn set_tray_labels(app: AppHandle, labels: TrayLabels) {
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.open.set_text(labels.open);
        let _ = items.check.set_text(labels.check);
        let _ = items.login.set_text(labels.login);
        let _ = items.quit.set_text(labels.quit);
    }
}

#[tauri::command]
fn set_close_to_tray(state: State<'_, AppState>, value: bool) {
    *state.close_to_tray.lock().unwrap() = value;
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let m = app.autolaunch();
    if enabled { m.enable().map_err(err) } else { m.disable().map_err(err) }
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only http(s) links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupInfo {
    version: String,
    hidden_start: bool,
    default_account: String,
    login_open: bool,
}

#[tauri::command]
fn startup_info(app: AppHandle, state: State<'_, AppState>) -> StartupInfo {
    StartupInfo {
        version: app.package_info().version.to_string(),
        hidden_start: state.hidden_start,
        default_account: DEFAULT_ACCOUNT.to_string(),
        login_open: *state.login_open.lock().unwrap(),
    }
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    *state.quitting.lock().unwrap() = true;
    app.exit(0);
}

// ---------- commands: self-update ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    installed: bool,
}

/// Checks the update feed (GitHub Releases `latest.json`) and, if asked,
/// downloads and installs the new version. On Windows the installer takes
/// over and relaunches the app, so `installed: true` is rarely observed.
#[tauri::command]
async fn check_update(app: AppHandle, endpoint: Option<String>, install: bool) -> Result<Option<UpdateInfo>, String> {
    let mut builder = app.updater_builder();
    if let Some(e) = endpoint.filter(|s| !s.trim().is_empty()) {
        let url = Url::parse(e.trim()).map_err(err)?;
        builder = builder.endpoints(vec![url]).map_err(err)?;
    }
    let updater = builder.build().map_err(err)?;
    let Some(update) = updater.check().await.map_err(err)? else { return Ok(None) };
    let mut info = UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        installed: false,
    };
    if install {
        update.download_and_install(|_, _| {}, || {}).await.map_err(err)?;
        info.installed = true;
    }
    Ok(Some(info))
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

// ---------- tray ----------

struct TrayItems {
    open: MenuItem<tauri::Wry>,
    check: MenuItem<tauri::Wry>,
    login: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let check = MenuItem::with_id(app, "check", "Check now", true, None::<&str>)?;
    let login = MenuItem::with_id(app, "login", "Sign in", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &check, &login, &PredefinedMenuItem::separator(app)?, &quit])?;
    app.manage(TrayItems { open: open.clone(), check: check.clone(), login: login.clone(), quit: quit.clone() });
    let icon = app.default_window_icon().cloned().expect("window icon");
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("USTH Timetable")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "check" => {
                let _ = app.emit("tkb://refresh", ());
            }
            "login" => {
                show_main_window(app);
                let _ = app.emit("tkb://login", ());
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    *state.quitting.lock().unwrap() = true;
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// ---------- app ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let hidden_start = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(AppState {
            close_to_tray: Mutex::new(true),
            quitting: Mutex::new(false),
            login_open: Mutex::new(false),
            hidden_start,
        })
        .invoke_handler(tauri::generate_handler![
            http_request,
            get_auth_cookie,
            portal_cookie_names,
            clear_browsing_data,
            open_login,
            store_read,
            store_write,
            data_dir_path,
            password_saved,
            password_set,
            show_main,
            notify_desktop,
            set_tray_tooltip,
            set_tray_labels,
            set_close_to_tray,
            set_autostart,
            open_external,
            startup_info,
            quit_app,
            check_update,
            restart_app,
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            // Heartbeat for the front-end scheduler: a hidden WebView2 page may
            // throttle its own timers, a Rust timer never does.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    let _ = handle.emit("tkb://tick", ());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != MAIN_LABEL {
                    return;
                }
                let state = window.state::<AppState>();
                let quitting = *state.quitting.lock().unwrap();
                let to_tray = *state.close_to_tray.lock().unwrap();
                if to_tray && !quitting {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running USTH Timetable");
}
