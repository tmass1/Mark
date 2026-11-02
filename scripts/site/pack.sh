#!/bin/sh
# Assembles the site into dist-site/, ready to upload to any static host: the
# page as index.html, the guide to AI tools, the demo it frames, their assets,
# and the disk image the download button points at if one has been built.
set -eu
cd "$(dirname "$0")/../.."
pnpm build
rm -rf dist-site
mkdir dist-site
cp dist/site.html dist-site/index.html
cp dist/ai.html dist-site/ai.html      # the guide to AI tools, at /ai
cp dist/demo.html dist-site/
cp -R dist/assets dist/demo dist/site dist/signature dist-site/
cp scripts/site/_headers dist-site/_headers      # read by Cloudflare's static asset host
VERSION=$(node -p "require('./package.json').version")
DMG="Mark_${VERSION}_universal.dmg"
for candidate in "$DMG" "src-tauri/target/universal-apple-darwin/release/bundle/dmg/$DMG"; do
  if [ -f "$candidate" ]; then cp "$candidate" "dist-site/$DMG"; break; fi
done
# The in-app update: Software Update reads a manifest, then fetches the archive
# it names. Only this version's: a manifest left over from another build would
# offer something this page no longer is. Two manifests for the one archive:
# Marks from 0.9 on read latest-with-notes.json and show the release notes;
# earlier ones read latest.json, the notes left out of it, since 0.4.5's window
# can't grow to fit them and would push its buttons out of sight.
UPDATES=src-tauri/target/universal-apple-darwin/release/bundle/updates
if [ -f "$UPDATES/latest.json" ] && [ "$(node -p "require('./$UPDATES/latest.json').version")" = "$VERSION" ]; then
  mkdir -p dist-site/updates
  cp "$UPDATES/Mark_${VERSION}.app.tar.gz" dist-site/updates/
  cp "$UPDATES/latest.json" dist-site/updates/latest-with-notes.json
  node -e 'const fs = require("fs"); const [from, to] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(from, "utf8")); manifest.notes = "";
    fs.writeFileSync(to, JSON.stringify(manifest, null, 2) + "\n");' "$UPDATES/latest.json" dist-site/updates/latest.json
  echo "dist-site/updates/ holds the in-app update for $VERSION"
else
  echo "No in-app update for $VERSION was found; Mark's Software Update will find nothing new until one is published."
fi
if [ -f "dist-site/$DMG" ]; then
  echo "dist-site/ is ready, with $DMG"
else
  echo "dist-site/ is ready. No $DMG was found; run scripts/release.sh and pack again, or upload the image beside index.html."
fi
