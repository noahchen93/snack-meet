#!/bin/zsh
# Snack Meet — install the single fused app from a completed build.sh run.
#   • Snack Meet -> /Applications/Snack Meet.app
#     (swap the embedded-frontend binary into the existing .app; build a full
#      bundle first if the .app is missing)
#
# Screen Recording is now required by the app
# ITSELF — for meeting-window detection (SCShareableContent) — not by a separate
# capture app. The bundle identifier is kept as com.meetily.ai so existing
# DB/recordings/onboarding/TCC are preserved; the .app displays + is named "Snack Meet".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Snack Meet.app"
SIGNING_HELPER="$ROOT/scripts/ensure_local_signing_identity.sh"
# Workspace-root target dir (meetily/target, NOT src-tauri/target).
BIN="$ROOT/meetily/target/release/meetily"
# The CFBundleExecutable is still "meetily" (only the .app folder + display name
# are "Snack Meet"), so the binary inside the bundle is Contents/MacOS/meetily.
EXE="meetily"

quit_app() {
  osascript -e "tell application \"Snack Meet\" to quit" 2>/dev/null || true
  sleep 1
  pkill -f "Snack Meet.app/Contents/MacOS" 2>/dev/null || true
  sleep 1
}

if [[ ! -f "$BIN" ]]; then
  echo "✗ Snack Meet binary not built. Run: zsh build.sh" >&2; exit 1
fi

echo "▸ Installing Snack Meet -> $APP"
quit_app
if [[ ! -d "$APP" ]]; then
  echo "  no existing Snack Meet.app — building a full bundle (slow, first time only)…"
  ( cd "$ROOT/meetily/frontend" && pnpm tauri build )
  BUNDLED="$ROOT/meetily/target/release/bundle/macos/Snack Meet.app"
  if [[ ! -d "$BUNDLED" ]]; then
    echo "✗ Bundle not found at $BUNDLED. Install a Snack Meet release .app into /Applications first, then re-run." >&2; exit 1
  fi
  sudo -n ditto "$BUNDLED" "$APP" 2>/dev/null || ditto "$BUNDLED" "$APP"
fi
# Swap in the embedded-frontend binary (the verified working artifact).
ditto "$BIN" "$APP/Contents/MacOS/$EXE"
chmod +x "$APP/Contents/MacOS/$EXE"
# Keep the display name in sync (a fresh full bundle would already set this; a
# binary-swap into an older .app would not).
/usr/libexec/PlistBuddy -c "Set :CFBundleName Snack Meet" "$APP/Contents/Info.plist" 2>/dev/null
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Snack Meet" "$APP/Contents/Info.plist" 2>/dev/null

# Re-sign the complete bundle after replacing its main executable. By default we
# create/reuse a stable local identity so the designated requirement stays the same
# across development builds and TCC grants survive. Set
# SNACK_MEET_SIGNING_IDENTITY=- to explicitly opt back into ad-hoc signing.
SIGNING_IDENTITY="${SNACK_MEET_SIGNING_IDENTITY:-}"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  if [[ ! -x "$SIGNING_HELPER" ]]; then
    echo "✗ signing helper is missing or not executable: $SIGNING_HELPER" >&2; exit 1
  fi
  SIGNING_IDENTITY="$($SIGNING_HELPER)"
fi
echo "  signing with identity: $SIGNING_IDENTITY"
codesign --force --deep --options runtime \
  --identifier com.meetily.ai \
  --entitlements "$ROOT/meetily/frontend/src-tauri/entitlements.plist" \
  --sign "$SIGNING_IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements :- "$APP" 2>&1 | grep -q "com.apple.security.device.audio-input"

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null
echo "  installed (binary swapped)."

echo ""
echo "✓ Snack Meet installed. Now grant in System Settings -> Privacy & Security:"
echo "    • Screen Recording  -> Snack Meet  (meeting-window detection)"
echo "    • Microphone         -> Snack Meet"
echo "    • Audio Capture      -> Snack Meet  (system audio, macOS 14.4+)"
echo "  With the default stable local signing identity, grants survive future rebuilds."
echo "  The first migration from ad-hoc signing still requires one clean re-grant."
echo ""
echo "  Then open Snack Meet -> Settings -> Recording and turn on 'Auto-detect Meetings'."
