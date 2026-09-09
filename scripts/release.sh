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

step "Building"
# Passed as a config overlay rather than an environment variable, so which
# identity signed the build is unambiguous and recorded in the output.
pnpm tauri build --bundles dmg \
  --config "{\"bundle\":{\"macOS\":{\"signingIdentity\":\"$IDENTITY\"}}}"

DMG=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg | head -1)
echo "  $DMG"

step "Notarizing (Apple usually answers within a few minutes)"
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait

step "Stapling the ticket"
# The ticket goes onto the image, so mounting it needs no network. The app
# dragged out of it carries no ticket of its own and is checked against
# Apple's servers the first time it runs -- fine online, refused offline.
xcrun stapler staple "$DMG"

step "Checking the result the way another Mac will"
spctl -a -t open --context context:primary-signature -vv "$DMG"
xcrun stapler validate "$DMG"

step "Done"
echo "  $DMG is ready to send anywhere."
