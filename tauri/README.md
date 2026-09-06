# USTH Timetable (Tauri edition)

Windows-native port of the Electron app one folder up. Same features, same
portal API wrapper, same change detection and phone notifications, but it runs
on the Edge WebView2 that Windows 11 already ships: the installer is a few MB
instead of 100 MB and the app idles at a fraction of the memory.

Built for the portal account **namtk2410702**: the login window opens the real
portal sign-in page with that account already filled in. Optionally the
password can be stored in Windows Credential Manager (Settings -> Portal
account) so the form is submitted for you as soon as the captcha is ticked.

## What is where

| Part | Path | Notes |
|---|---|---|
| Front-end (UI + all timetable logic) | `src/` | Plain HTML/CSS/ES modules, no bundler. `core.js` is the former Electron main process. |
| Portal API, diff, notifications, config, EN/VI strings | `src/lib/` | WebCrypto only, so the same files run in Node for the tests. `i18n.js` holds every user-facing string; add a key to both languages there. |
| Native side | `src-tauri/src/lib.rs` | HTTP with portal cookies, login window, JSON store, tray, toasts, autostart, Credential Manager, updater. |
| App config / bundling | `src-tauri/tauri.conf.json` | Version, updater feed URL and public key live here. |

## Run / build

```powershell
cd tauri
npm install              # Tauri CLI only; Rust + MSVC + WebView2 are already on this PC
npm test                 # unit tests (node:test)
npm run dev              # run with hot reload of the front-end
npm run build            # unsigned NSIS installer -> src-tauri/target/release/bundle/nsis/
npm run release          # signed installer + latest.json for the updater
```

The first Rust build downloads and compiles ~600 crates and takes several
minutes; later builds are incremental.

## Self-update

The app checks an update feed at start and every 6 hours and, when
"Install new versions automatically" is on (default), downloads and installs
the new version by itself. The feed is a `latest.json` on GitHub Releases:

1. Bump `version` in `src-tauri/tauri.conf.json` (and `package.json`).
2. `npm run release` – builds the installer, signs it with
   `~/.tauri/usth-timetable.key` and writes `latest.json` next to it.
3. Create a GitHub release tagged `v<version>` in the repository named in the
   updater endpoint and upload the two files the script lists
   (`*-setup.exe` and `latest.json`; the signature is inside `latest.json`).

Pushing a tag `v<version>` to github.com/Nam-Antoine/TKB does steps 2 and 3
for you (workflow `.github/workflows/release.yml`, needs the repository secret
`TAURI_SIGNING_PRIVATE_KEY`).

Every installed copy picks the release up within 6 hours. The endpoint is
`plugins.updater.endpoints[0]` in `tauri.conf.json` (the releases of
Nam-Antoine/TKB); Settings -> App updates -> Update feed overrides it at run
time without a rebuild.

Keep `~/.tauri/usth-timetable.key` safe: updates must be signed with it or
installed apps will refuse them.

## Data

- Settings, snapshot and change log: `%APPDATA%\vn.edu.usth.timetable\data\*.json`
- Portal cookies: the WebView2 profile under `%LOCALAPPDATA%\vn.edu.usth.timetable\`
- Saved password: Windows Credential Manager, entry `vn.edu.usth.timetable` / `namtk2410702`

## How it works

Same as the Electron version (see `../README.md`): the portal's encrypted
request/response wrapper and checksum are re-implemented in
`src/lib/usth-api.js`; the session is checked, the current semester's whole
timetable is fetched, flattened, compared with the stored snapshot, and every
difference is written to the change log and pushed to the configured targets
(ntfy, Discord, Telegram, generic webhook, Windows toast). Portal tokens last
24 h; the app re-authenticates silently through a hidden portal window while
the SSO session is alive and asks you to sign in otherwise.
