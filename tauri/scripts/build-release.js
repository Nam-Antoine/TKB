/**
 * Builds a signed release: `npm run release`
 *
 * Signs the NSIS installer with the updater key in ~/.tauri/usth-timetable.key
 * (generated once with `npx tauri signer generate`), then writes latest.json
 * next to the installer so the whole folder can be uploaded to a GitHub
 * release. Set TAURI_SIGNING_PRIVATE_KEY yourself to use another key.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const env = { ...process.env };
if (!env.TAURI_SIGNING_PRIVATE_KEY) {
  const keyFile = join(homedir(), '.tauri', 'usth-timetable.key');
  if (!existsSync(keyFile)) {
    console.error(`No updater signing key at ${keyFile}. Create one with: npx tauri signer generate -w "${keyFile}" --ci`);
    process.exit(1);
  }
  env.TAURI_SIGNING_PRIVATE_KEY = keyFile; // the Tauri CLI accepts a path or the key text here
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD == null) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '';
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const build = spawnSync(npx, ['tauri', 'build', ...process.argv.slice(2)], { stdio: 'inherit', env, shell: process.platform === 'win32' });
if (build.status !== 0) process.exit(build.status ?? 1);
const latest = spawnSync(process.execPath, [join(import.meta.dirname, 'make-latest-json.js')], { stdio: 'inherit', env });
process.exit(latest.status ?? 1);
