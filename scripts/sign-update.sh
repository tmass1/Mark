#!/bin/sh
# Packs a built Mark.app as an in-app update: the archive Tauri's updater
# downloads, its signature, and latest.json, the manifest that announces it.
#
#   scripts/sign-update.sh <Mark.app> <version> <base URL> <notes.md> <out dir>
#
# The release script runs this on the notarized, stapled app inside the disk
# image, so an update is exactly what the image holds. The signing key never
# leaves the keychain except into the signer's environment for this one
# command: never onto a command line, into a file, or into this repository.
set -eu
cd "$(dirname "$0")/.."
APP=$1 VERSION=$2 BASE=$3 NOTES=$4 OUT=$5
ARCHIVE="Mark_${VERSION}.app.tar.gz"

KEY=$(security find-generic-password -s "Mark updater key" -w 2>/dev/null) || {
  echo "No 'Mark updater key' in the keychain. It signs every update; see the README." >&2
  exit 1
}
mkdir -p "$OUT"
rm -f "$OUT/$ARCHIVE" "$OUT/$ARCHIVE.sig" "$OUT/latest.json"

# The app at the top of the archive, as the updater expects to unpack it, and
# none of the Mac's own metadata alongside.
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$OUT/$ARCHIVE" -C "$(dirname "$APP")" "$(basename "$APP")"
TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  pnpm --silent tauri signer sign "$OUT/$ARCHIVE" >/dev/null

# One universal archive answers for both kinds of Mac.
VERSION="$VERSION" URL="${BASE%/}/$ARCHIVE" NOTES="$NOTES" SIG="$OUT/$ARCHIVE.sig" node -e '
  const fs = require("fs");
  const platform = { signature: fs.readFileSync(process.env.SIG, "utf8").trim(), url: process.env.URL };
  fs.writeFileSync(process.argv[1], JSON.stringify({
    version: process.env.VERSION,
    notes: fs.readFileSync(process.env.NOTES, "utf8").trim(),
    pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: { "darwin-aarch64": platform, "darwin-x86_64": platform },
  }, null, 2) + "\n");
' "$OUT/latest.json"
echo "  $OUT/$ARCHIVE ($(( $(stat -f%z "$OUT/$ARCHIVE") / 1024 )) KB), signed"
echo "  $OUT/latest.json, announcing $VERSION"
