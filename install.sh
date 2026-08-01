#!/bin/zsh
# Snack Meet — install the single fused app from a completed build.sh run.
#   • Snack Meet (meetily) -> /Applications/meetily.app
#     (swap the embedded-frontend binary into the existing .app; build a full
#      bundle first if the .app is missing)
#
# Re-grant Screen Recording + Microphone + Audio Capture after install (the local
# signature changes each build). Screen Recording is now required by meetily
# ITSELF — for meeting-window detection (SCShareableContent) — not by a separate
# capture app. The bundle identifier is kept as com.meetily.ai so existing
# DB/recordings/onboarding/TCC are preserved; the app displays as "Snack Meet".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="/Applications/meetily.app"
# Workspace-root target dir (meetily/target, NOT src-tauri/target).
BIN="$ROOT/meetily/target/release/meetily"

quit_app() {
  osascript -e "tell application \"meetily\" to quit" 2>/dev/null
  sleep 1
  pkill -f "meetily.app/Contents/MacOS" 2>/dev/null
  sleep 1
}

if [[ ! -f "$BIN" ]]; then
  echo "✗ Snack Meet binary not built. Run: zsh build.sh" >&2; exit 1
fi

echo "▸ Installing Snack Meet -> $APP"
quit_app
if [[ ! -d "$APP" ]]; then
  echo "  no existing meetily.app — building a full bundle (slow, first time only)…"
  ( cd "$ROOT/meetily/frontend" && pnpm tauri build )
  BUNDLED="$ROOT/meetily/target/release/bundle/macos/meetily.app"
  if [[ ! -d "$BUNDLED" ]]; then
    echo "✗ Bundle not found at $BUNDLED. Install a meetily release .app into /Applications first, then re-run." >&2; exit 1
  fi
  sudo -n ditto "$BUNDLED" "$APP" 2>/dev/null || ditto "$BUNDLED" "$APP"
fi
# Swap in the embedded-frontend binary (the verified working artifact).
ditto "$BIN" "$APP/Contents/MacOS/meetily"
chmod +x "$APP/Contents/MacOS/meetily"
echo "  installed (binary swapped)."

echo ""
echo "✓ Snack Meet installed. Now grant in System Settings -> Privacy & Security:"
echo "    • Screen Recording  -> meetily  (meeting-window detection)"
echo "    • Microphone         -> meetily"
echo "    • Audio Capture      -> meetily  (system audio, macOS 14.4+)"
echo "  Re-grant after every reinstall (the local signature changes each build)."
echo ""
echo "  Then open Snack Meet -> Settings -> Recording and turn on 'Auto-detect Meetings'."