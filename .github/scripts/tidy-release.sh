#!/usr/bin/env bash
# Leaves one obvious download on a GitHub release page.
#
# tauri-action uploads three files: the installer, its .sig and latest.json. The .sig
# content is already inside latest.json (the only thing installed copies read), so the
# separate .sig file is dropped, and the release notes are rewritten to link straight
# at the installer. GitHub's own "Source code" archives cannot be removed.
#
# Usage: tidy-release.sh <tag> [owner/repo]     (needs an authenticated `gh`)
set -euo pipefail

tag="$1"
repo="${2:-${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}}"

assets=$(gh release view "$tag" -R "$repo" --json assets --jq '.assets[].name')
exe=$(grep -- '-setup\.exe$' <<<"$assets" | head -n 1 || true)
if [ -z "$exe" ]; then
  echo "No *-setup.exe asset on release $tag of $repo" >&2
  exit 1
fi

for sig in $(grep '\.sig$' <<<"$assets" || true); do
  gh release delete-asset "$tag" "$sig" -R "$repo" --yes
  echo "Removed $sig (its content is inside latest.json)"
done

url="https://github.com/$repo/releases/download/$tag/$exe"
notes=$(mktemp)
cat >"$notes" <<NOTES
## ⬇️ Download: [$exe]($url)

That is the only file you need: run it, press **Sign in**, done.
Chỉ cần tải đúng file trên rồi chạy; các file còn lại không cần tải.

- Already have the app? Nothing to do, it updates itself within 6 hours.
- \`latest.json\` is what installed copies read to find this update. The two "Source code" entries are added by GitHub and only contain the repository files.
NOTES
gh release edit "$tag" -R "$repo" --notes-file "$notes"
rm -f "$notes"
echo "Release $tag tidied: $url"
