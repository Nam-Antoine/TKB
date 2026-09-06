/**
 * Writes src-tauri/target/release/bundle/nsis/latest.json, the manifest the
 * in-app updater downloads from
 *   https://github.com/<owner>/<repo>/releases/latest/download/latest.json
 *
 * Upload the installer (*-setup.exe), its *.sig file and latest.json to a
 * GitHub release tagged v<version>. The download URL below assumes that tag.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const endpoint = conf.plugins.updater.endpoints[0];
const m = /github\.com\/([^/]+)\/([^/]+)\/releases/.exec(endpoint);
if (!m) { console.error(`Cannot derive the GitHub repo from the updater endpoint ${endpoint}`); process.exit(1); }
const [, owner, repo] = m;

const dir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const files = readdirSync(dir);
const installer = files.find((f) => f.endsWith('-setup.exe'));
const sig = installer && files.includes(installer + '.sig') ? installer + '.sig' : null;
if (!installer || !sig) {
  console.error(`No signed installer in ${dir}. Build with \`npm run release\` (the signature needs the updater key).`);
  process.exit(1);
}
const notesFile = join(root, 'RELEASE_NOTES.md');
let notes = `USTH Timetable ${version}`;
try { notes = readFileSync(notesFile, 'utf8').trim() || notes; } catch { /* optional */ }

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(join(dir, sig), 'utf8').trim(),
      url: `https://github.com/${owner}/${repo}/releases/download/v${version}/${encodeURIComponent(installer)}`,
    },
  },
};
writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${join(dir, 'latest.json')}`);
console.log(`Upload these three files to the GitHub release v${version} of ${owner}/${repo}:`);
for (const f of [installer, sig, 'latest.json']) console.log('  ' + join(dir, f));
