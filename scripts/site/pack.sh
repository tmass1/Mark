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
VERSION=$(node -p "require('./package.json').version")
DMG="Mark_${VERSION}_universal.dmg"
for candidate in "$DMG" "src-tauri/target/universal-apple-darwin/release/bundle/dmg/$DMG"; do
  if [ -f "$candidate" ]; then cp "$candidate" "dist-site/$DMG"; break; fi
done
if [ -f "dist-site/$DMG" ]; then
  echo "dist-site/ is ready, with $DMG"
else
  echo "dist-site/ is ready. No $DMG was found; run scripts/release.sh and pack again, or upload the image beside index.html."
fi
