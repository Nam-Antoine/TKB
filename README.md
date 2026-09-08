# USTH Timetable

A small Windows desktop app that shows the USTH (University of Science and Technology of Hanoi) student timetable of one account, keeps checking the portal in the background and notifies you (Windows toast, phone push via ntfy, Discord, Telegram or any webhook) whenever a session is added, removed, moved, or changes room or teacher. It updates itself from the releases of this repository.

Built for the account `namtk2410702` and the people around it who want to know when there is class.

## Get the app

Open the [latest release](https://github.com/Nam-Antoine/TKB/releases/latest) and download the one file the notes point at, `USTH.Timetable_<version>_x64-setup.exe`. Everything else on that page can be ignored: `latest.json` is what installed copies read to update themselves, and the two "Source code" archives are GitHub's copy of this repository. Run the installer (per-user, no admin rights needed). Then:

1. Press **Sign in**. The real portal login page opens with the account already filled in; type the password and tick the captcha.
2. Done. The timetable loads, the app keeps checking every 30 minutes (also from the tray when the window is closed), renews the portal session by itself and installs new versions on its own. When the portal ends the session for good, the app tells you with a desktop notification (and a phone push if enabled), repeats the reminder every 4 hours until you sign in again, and says so in its window and tray tooltip. The interval is in Settings (0 = notify only once).
3. Every evening at 20:00 the app tells you what you have tomorrow, and every morning at 07:00 what you have today: one notification listing that day's sessions with time, room and teacher (or "no class"), on the desktop and on the phone targets. Each has its own time, "also tell me when there is no class" switch and *Send now* button in Settings → *Tomorrow's timetable* and *Today's timetable*.
4. Optional: Settings → *Phone push via ntfy* to get the changes on your phone (install the free ntfy app, subscribe to the topic shown, press *Send test notification*). Discord, Telegram and generic webhooks work too.

Views: **Month** (the portal's own layout: a month calendar with a dot on every day that has class and the selected day's sessions next to it), **Day** (cards for one day, with a week strip on top), **Week** (period grid), **Agenda** (whole semester as a list) and **Classes** (one row per class with how many lessons are done and, per subject and overall, how many are still left). Every change found between two checks lands in the change log (bell icon).

The whole app, the change log, the tray menu and the notifications are available in **English and Vietnamese**: the EN / VI switch at the top right changes the language at any time (the first start follows the Windows display language).

## Repository layout

| Folder | What |
|---|---|
| `tauri/` | The app: Tauri 2 on the Edge WebView2 that Windows already ships. Releases are built from here. |
| `tauri/src/` | UI and all timetable logic (plain HTML/CSS/ES modules, no bundler). |
| `tauri/src/lib/` | Portal API wrapper, snapshot diff, notifications, config, EN/VI strings. Runs in Node too, so it is unit-tested there. |
| `tauri/src-tauri/` | Rust shell: HTTP with the portal cookies, login window, tray, toasts, Credential Manager, updater. |
| `src/`, `scripts/`, `test/` | The original Electron edition (same logic, 100 MB installer). Kept for reference. |
| `assets/` | Icon sources. |

## Build from source

Requirements: Node 20+, Rust stable (MSVC toolchain), Visual Studio Build Tools with the *Desktop development with C++* workload, WebView2 runtime (part of Windows 11).

```powershell
cd tauri
npm install
npm test          # unit tests
npm run dev       # run the app, front-end served from src/
npm run build     # installer -> src-tauri/target/release/bundle/nsis/
```

## Releasing a new version (self-update)

Installed copies read `https://github.com/Nam-Antoine/TKB/releases/latest/download/latest.json` at start and every 6 hours and install whatever is newer, as long as it is signed with the updater key. The app fetches that URL without any credentials, so the repository has to be **public** (Settings → General → Danger zone → Change visibility); on a private repository GitHub answers 404 and the app keeps its current version.

1. Bump `version` in `tauri/package.json` and `tauri/src-tauri/tauri.conf.json`.
2. Commit, then push a tag: `git tag v1.2.0` and `git push origin main v1.2.0`.
3. The **Release** workflow (`.github/workflows/release.yml`) builds the installer, signs it and publishes the GitHub release together with `latest.json`, then tidies the release page (`.github/scripts/tidy-release.sh`: drops the redundant `.sig`, whose content is already inside `latest.json`, and writes notes that link straight at the installer). It needs the repository secret `TAURI_SIGNING_PRIVATE_KEY` (the contents of `~/.tauri/usth-timetable.key`, created once with `npx tauri signer generate`); `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be empty.

Without CI: `npm run release` inside `tauri/` does the same locally and prints the three files to upload to a release tagged `v<version>`.

## How it talks to the portal

The portal wraps every API call in AES-256-CBC (`{ "payload": ... }`) plus a checksum header. `tauri/src/lib/usth-api.js` re-implements that wrapper, so the app uses the portal's own API with the cookies from its own login window; the password is only ever typed into the real portal page. Nothing is sent anywhere except to the portal and the notification targets you configure. Data lives in `%APPDATA%\vn.edu.usth.timetable\`; the password, if you choose to save it, in Windows Credential Manager.

## License

MIT
