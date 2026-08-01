#!/bin/zsh
# Snack Meet — install the single fused app from a completed build.sh run.
#   • Snack Meet -> /Applications/Snack Meet.app
#     (swap the embedded-frontend binary into the existing .app; build a full
#      bundle first if the .app is missing)
#
# Re-grant Screen Recording + Microphone + Audio Capture after install (the local
# signature changes each build). Screen Recording is now required by the app
# ITSELF — for meeting-window detection (SCShareableContent) — not by a separate
# capture app. The bundle identifier is kept as com.meetily.ai so existing
# DB/recordings/onboarding/TCC are preserved; the .app displays + is named "Snack Meet".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/Snack Meet.app"
# Workspace-root target dir (meetily/target, NOT src-tauri/target).
BIN="$ROOT/meetily/target/release/meetily"
# The CFBundleExecutable is still "meetily" (only the .app folder + display name
# are "Snack Meet"), so the binary inside the bundle is Contents/MacOS/meetily.
EXE="meetily"

quit_app() {
  osascript -e "tell application \"Snack Meet\" to quit" 2>/dev/null
  sleep 1
  pkill -f "Snack Meet.app/Contents/MacOS" 2>/dev/null
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
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" 2>/dev/null
echo "  installed (binary swapped)."

echo ""
echo "✓ Snack Meet installed. Now grant in System Settings -> Privacy & Security:"
echo "    • Screen Recording  -> Snack Meet  (meeting-window detection)"
echo "    • Microphone         -> Snack Meet"
echo "    • Audio Capture      -> Snack Meet  (system audio, macOS 14.4+)"
echo "  Re-grant after every reinstall (the local signature changes each build)."
echo ""
echo "  Then open Snack Meet -> Settings -> Recording and turn on 'Auto-detect Meetings'."