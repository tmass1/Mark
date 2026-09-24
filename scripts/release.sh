#!/bin/bash
# Build a signed, notarized, stapled disk image of Mark.
#
# Everything secret stays in your keychain: notarytool is given a stored profile
# rather than credentials, so no Apple password or API key is ever passed on a
# command line, written into a file here, or held in this repository.
#
#   ./scripts/release.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."
PROFILE="${MARK_NOTARY_PROFILE:-Mark}"

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; }

# Tauri's bundle_dmg.sh fails outright if a half-made image from a previous run
# is still attached -- which is exactly what it leaves behind when it fails. It
# has cost two releases now, so the next one starts by clearing up after the
# last one. Only images built from this folder are touched.
BUILD=src-tauri/target/universal-apple-darwin/release/bundle/macos
for stale in $(hdiutil info 2>/dev/null | awk -v dir="$PWD/$BUILD/rw." '
    $1 == "image-path" && index($3, dir) == 1 { found = 1 }
    found && $1 ~ /^\/dev\/disk/ && $NF ~ /^\/Volumes\// { print $1; found = 0 }'); do
  printf 'Detaching a disk image left attached by an earlier run: %s\n' "$stale"
  hdiutil detach "$stale" -force >/dev/null 2>&1 || true
done
rm -f "$BUILD"/rw.*.dmg

step "Looking for a Developer ID certificate"
# Chosen by fingerprint, never by name. Two certificates can carry the same
# name -- through a renewal you hold the old one and the new one at once -- and
# codesign refuses an ambiguous name rather than picking for you. Taking the
# first match would sign with whichever the keychain happened to list first.
MATCHES=$(security find-identity -v -p codesigning 2>/dev/null | grep "Developer ID Application" || true)
COUNT=$(printf '%s' "$MATCHES" | grep -c . || true)
if [ "$COUNT" -eq 0 ]; then
  fail "No Developer ID Application certificate in your keychain."
  cat >&2 <<'HELP'

An Apple Development certificate signs an app for the machine that built it.
Distributing to any other Mac needs a Developer ID Application certificate,
which only you can create:

  Xcode > Settings > Accounts > (your team) > Manage Certificates
  then + > Developer ID Application

or at developer.apple.com/account/resources/certificates.

Then run this again.
HELP
  exit 1
fi

if [ -n "${MARK_SIGNING_IDENTITY:-}" ]; then
  MATCHES=$(printf '%s\n' "$MATCHES" | grep -F "$MARK_SIGNING_IDENTITY" || true)
  if [ -z "$MATCHES" ]; then
    fail "No Developer ID certificate matches MARK_SIGNING_IDENTITY='$MARK_SIGNING_IDENTITY'."
    exit 1
  fi
  COUNT=$(printf '%s' "$MATCHES" | grep -c . || true)
fi

if [ "$COUNT" -gt 1 ]; then
  fail "$COUNT Developer ID Application certificates. Which one should sign this?"
  printf '%s\n' "$MATCHES" >&2
  cat >&2 <<'HELP'

Say which, by fingerprint:

  MARK_SIGNING_IDENTITY=<fingerprint> ./scripts/release.sh

or delete the one you have finished with, in Keychain Access > login >
My Certificates.
HELP
  exit 1
fi

IDENTITY=$(printf '%s\n' "$MATCHES" | awk '{print $2}')
echo "  $(printf '%s\n' "$MATCHES" | sed -E 's/.*"(.*)".*/\1/')"
echo "  $IDENTITY"

step "Checking notarization credentials"
if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  fail "No notarytool keychain profile named '$PROFILE'."
  cat >&2 <<HELP

Store your credentials once, in your keychain, so nothing secret has to be
passed around afterwards. Using an App Store Connect API key (preferred):

  xcrun notarytool store-credentials "$PROFILE" \\
    --key /path/to/AuthKey_XXXXXXXX.p8 --key-id XXXXXXXX --issuer <issuer-uuid>

or with an Apple ID and an app-specific password from appleid.apple.com:

  xcrun notarytool store-credentials "$PROFILE" \\
    --apple-id you@example.com --team-id <TEAMID> --password <app-specific-password>

Then run this again.
HELP
  exit 1
fi
echo "  profile '$PROFILE' is ready"

step "Building (universal: Apple silicon and Intel)"
# Passed as a config overlay rather than an environment variable, so which
# identity signed the build is unambiguous and recorded in the output.
pnpm tauri build --target universal-apple-darwin --bundles app,dmg \
  --config "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"$IDENTITY\"}}}"

BUNDLE=src-tauri/target/universal-apple-darwin/release/bundle
APP="$BUNDLE/macos/Mark.app"
DMG=$(ls -t "$BUNDLE"/dmg/*.dmg | head -1)
echo "  $APP"
echo "  $DMG"
lipo -archs "$APP/Contents/MacOS/mark" | sed 's/^/  architectures: /'

# Two rounds. A ticket is stapled to the thing that carries it: staple only
# the image and the app inside has no ticket of its own, so its first launch
# is an online check -- fine online, refused offline. So the app is notarized
# and stapled first, inside the image, and the image is notarized after.
step "Notarizing the app (Apple usually answers within a few minutes)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
ditto -c -k --keepParent "$APP" "$WORK/Mark.zip"
xcrun notarytool submit "$WORK/Mark.zip" --keychain-profile "$PROFILE" --wait

step "Stapling the app inside the image"
# The image tauri wrote is read-only and already signed. Open a writable copy,
# staple the app it holds, then close it back up and sign it again.
hdiutil convert "$DMG" -format UDRW -o "$WORK/rw.dmg" -quiet
# Room for the ticket: a few kilobytes, but the image was sized to its contents.
hdiutil resize -size "$(( $(stat -f%z "$WORK/rw.dmg") + 4 * 1024 * 1024 ))" "$WORK/rw.dmg"
MOUNT=$(hdiutil attach "$WORK/rw.dmg" -nobrowse -mountrandom "$WORK" | awk '/\/private\/|\/Volumes\//{print $NF}' | tail -1)
xcrun stapler staple "$MOUNT/Mark.app"
xcrun stapler validate "$MOUNT/Mark.app"
hdiutil detach "$MOUNT" -quiet
FINAL="$BUNDLE/dmg/$(basename "$DMG")"
rm -f "$FINAL"
hdiutil convert "$WORK/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$FINAL" -quiet
codesign --force --sign "$IDENTITY" --timestamp "$FINAL"
DMG="$FINAL"

step "Notarizing the image"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait

step "Stapling the image"
xcrun stapler staple "$DMG"

step "Checking the result the way another Mac will"
spctl -a -t open --context context:primary-signature -vv "$DMG"
xcrun stapler validate "$DMG"
# And the app a friend drags out of it, which is what actually runs.
CHECK=$(hdiutil attach "$DMG" -nobrowse -readonly -mountrandom "$WORK" | awk '/\/private\/|\/Volumes\//{print $NF}' | tail -1)
xcrun stapler validate "$CHECK/Mark.app"
spctl -a -t exec -vv "$CHECK/Mark.app"
hdiutil detach "$CHECK" -quiet

step "Done"
echo "  $DMG is ready to send anywhere, and opens without a network."
