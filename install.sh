#!/bin/zsh
# Snack Meet — install one complete app bundle by atomic replacement.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Snack Meet.app"
BUNDLED="$ROOT/meetily/target/release/bundle/macos/Snack Meet.app"
SIGNING_HELPER="$ROOT/scripts/ensure_local_signing_identity.sh"
EXPECTED_EXECUTABLE="snack-meet"
EXPECTED_IDENTIFIER="com.meetily.ai" # retained only for existing data/TCC compatibility
STAMP="$(date +%Y%m%d-%H%M%S)"
STAGE_ROOT="$(mktemp -d /private/tmp/snack-meet-install.XXXXXX)"
STAGED_APP="$STAGE_ROOT/Snack Meet.app"
TRASH_DIR="$HOME/.Trash"

cleanup_stage() {
  if [[ -d "$STAGE_ROOT" ]]; then
    rm -rf "$STAGE_ROOT"
  fi
}
trap cleanup_stage EXIT

move_with_auth() {
  local source="$1"
  local destination="$2"
  mv "$source" "$destination" 2>/dev/null || sudo mv "$source" "$destination"
}

quit_known_apps() {
  osascript -e 'tell application "Snack Meet" to quit' 2>/dev/null || true
  osascript -e 'tell application "Meetily" to quit' 2>/dev/null || true
  osascript -e 'tell application "Snack Record" to quit' 2>/dev/null || true
  sleep 1
  pkill -f '/Snack Meet.app/Contents/MacOS/' 2>/dev/null || true
  pkill -f '/Meetily.app/Contents/MacOS/' 2>/dev/null || true
  pkill -f '/Snack Record.app/Contents/MacOS/' 2>/dev/null || true
}

if [[ ! -x "$BUNDLED/Contents/MacOS/$EXPECTED_EXECUTABLE" ]]; then
  echo "✗ Complete Snack Meet bundle not found. Run: zsh build.sh" >&2
  exit 1
fi

echo "▸ Staging complete Snack Meet.app…"
ditto "$BUNDLED" "$STAGED_APP"

SIGNING_IDENTITY="${SNACK_MEET_SIGNING_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  if [[ ! -x "$SIGNING_HELPER" ]]; then
    echo "✗ signing helper is missing: $SIGNING_HELPER" >&2
    exit 1
  fi
  SIGNING_IDENTITY="$($SIGNING_HELPER)"
fi

echo "  signing staged bundle with: $SIGNING_IDENTITY"
codesign --force --deep --options runtime \
  --identifier "$EXPECTED_IDENTIFIER" \
  --entitlements "$ROOT/meetily/frontend/src-tauri/entitlements.plist" \
  --sign "$SIGNING_IDENTITY" "$STAGED_APP"
codesign --verify --deep --strict --verbose=2 "$STAGED_APP"
codesign -d --entitlements :- "$STAGED_APP" 2>&1 | grep -q 'com.apple.security.device.audio-input'

PLIST="$STAGED_APP/Contents/Info.plist"
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST")" == "$EXPECTED_EXECUTABLE" ]]
[[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")" == "$EXPECTED_IDENTIFIER" ]]

echo "▸ Replacing installed app as one complete unit…"
quit_known_apps
mkdir -p "$TRASH_DIR"

for LEGACY_APP in "/Applications/Meetily.app" "/Applications/Snack Record.app"; do
  if [[ -d "$LEGACY_APP" ]]; then
    LEGACY_NAME="${LEGACY_APP:t:r}-$STAMP.app"
    move_with_auth "$LEGACY_APP" "$TRASH_DIR/$LEGACY_NAME"
    echo "  moved legacy ${LEGACY_APP:t} to Trash"
  fi
done

if [[ -d "$APP" ]]; then
  move_with_auth "$APP" "$TRASH_DIR/Snack Meet-previous-$STAMP.app"
fi

move_with_auth "$STAGED_APP" "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null || true

echo "✓ Installed exactly one current app at: $APP"
echo "  Previous/legacy copies were moved to Trash and can be recovered until Trash is emptied."
