#!/bin/sh
# Assembles the site into dist-site/, ready to upload to any static host: the
# page as index.html, the demo it frames, their assets, and the disk image the
# download button points at if one has been built.
set -eu
cd "$(dirname "$0")/../.."
pnpm build
rm -rf dist-site
mkdir dist-site
cp dist/site.html dist-site/index.html
cp dist/demo.html dist-site/
cp -R dist/assets dist/demo dist/site dist-site/
cp scripts/site/_headers dist-site/_headers      # read by Cloudflare's static asset host
VERSION=$(node -p "require('./package.json').version")
DMG="Mark_${VERSION}_universal.dmg"
for candidate in "$DMG" "src-tauri/target/universal-apple-darwin/release/bundle/dmg/$DMG"; do
  if [ -f "$candidate" ]; then cp "$candidate" "dist-site/$DMG"; break; fi
done
# The in-app update: Software Update reads updates/latest.json, then fetches
# the archive it names. Only this version's: a manifest left over from another
# build would offer something this page no longer is.
UPDATES=src-tauri/target/universal-apple-darwin/release/bundle/updates
if [ -f "$UPDATES/latest.json" ] && [ "$(node -p "require('./$UPDATES/latest.json').version")" = "$VERSION" ]; then
  mkdir -p dist-site/updates
  cp "$UPDATES/latest.json" "$UPDATES/Mark_${VERSION}.app.tar.gz" dist-site/updates/
  echo "dist-site/updates/ holds the in-app update for $VERSION"
else
  echo "No in-app update for $VERSION was found; Mark's Software Update will find nothing new until one is published."
fi
if [ -f "dist-site/$DMG" ]; then
  echo "dist-site/ is ready, with $DMG"
else
  echo "dist-site/ is ready. No $DMG was found; run scripts/release.sh and pack again, or upload the image beside index.html."
fi
