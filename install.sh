#!/bin/zsh
# Snack Meet — install both apps from a completed build.sh run.
#   • Snack Record -> ~/Applications/Snack Record.app   (ditto, full app)
#   • meetily      -> /Applications/meetily.app          (swap the embedded-frontend
#                     binary into the existing .app; build a bundle first if missing)
# Re-grant Screen Recording + Microphone after install (local signature changes).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
USER_APPS="$HOME/Applications"
MEETILY_APP="/Applications/meetily.app"
MEETILY_BIN="$ROOT/meetily/frontend/src-tauri/target/release/meetily"

quit_app() { osascript -e "tell application \"$1\" to quit" 2>/dev/null; sleep 1; pkill -f "$2" 2>/dev/null; sleep 1; }

# ---------- 1) Snack Record ----------
SNACK_APP="$ROOT/snack-record/build/Snack Record.app"
if [[ ! -d "$SNACK_APP" ]]; then
  echo "✗ Snack Record.app not built. Run: zsh build.sh" >&2; exit 1
fi
echo "▸ Installing Snack Record -> $USER_APPS/"
quit_app "Snack Record" "Snack Record.app/Contents/MacOS"
mkdir -p "$USER_APPS"
rm -rf "$USER_APPS/Snack Record.app"
ditto "$SNACK_APP" "$USER_APPS/Snack Record.app"
echo "  installed."

# ---------- 2) meetily ----------
if [[ ! -f "$MEETILY_BIN" ]]; then
  echo "✗ meetily binary not built. Run: zsh build.sh" >&2; exit 1
fi
echo "▸ Installing meetily -> $MEETILY_APP"
quit_app "meetily" "meetily.app/Contents/MacOS"
if [[ ! -d "$MEETILY_APP" ]]; then
  echo "  no existing meetily.app — building a full bundle (slow, first time only)…"
  ( cd "$ROOT/meetily/frontend" && pnpm tauri build )
  BUNDLED="$ROOT/meetily/frontend/src-tauri/target/release/bundle/macos/meetily.app"
  if [[ ! -d "$BUNDLED" ]]; then
    echo "✗ Bundle not found at $BUNDLED. Install a meetily release .app into /Applications first, then re-run." >&2
    exit 1
  fi
  sudo -n ditto "$BUNDLED" "$MEETILY_APP" 2>/dev/null || ditto "$BUNDLED" "$MEETILY_APP"
fi
# Swap in the embedded-frontend binary (the verified working artifact).
ditto "$MEETILY_BIN" "$MEETILY_APP/Contents/MacOS/meetily"
chmod +x "$MEETILY_APP/Contents/MacOS/meetily"
echo "  installed (binary swapped)."

echo ""
echo "✓ Snack Meet installed. Now grant in System Settings -> Privacy & Security:"
echo "    • Screen Recording  -> Snack Record"
echo "    • Microphone         -> Snack Record  (and meetily for transcription)"