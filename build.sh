#!/bin/zsh
# Snack Meet — single-app build.
#   pnpm tauri build --no-bundle  ->  meetily/target/release/meetily
#   (the --no-bundle binary embeds the _next frontend; a plain `cargo build` does NOT,
#    and yields a blank UI — see docs/INTEGRATION.md)
#
# The standalone snack-record/ capture app is RETIRED. Its meeting-window detection
# logic is now ported into meetily's Rust backend (src-tauri/src/meeting_detector.rs)
# and surfaced in the UI (src/contexts/MeetingDetectorProvider.tsx). The snack-record/
# source is kept in the repo for reference/history only.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
MEETILY="$ROOT/meetily/frontend"

if ! xcodebuild -version >/dev/null 2>&1; then
  for XCODE_APP in \
    "/Applications/Xcode.app" \
    "/Applications/Xcode-beta.app" \
    "$HOME/Downloads/Xcode.app" \
    "$HOME/Downloads/Xcode-beta.app"; do
    if [[ -x "$XCODE_APP/Contents/Developer/usr/bin/xcodebuild" ]]; then
      export DEVELOPER_DIR="$XCODE_APP/Contents/Developer"
      echo "  using Xcode at: $XCODE_APP"
      break
    fi
  done
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "✗ Full Xcode is required to build Snack Meet (cidre compiles Apple framework bindings)." >&2
  echo "  Install Xcode in /Applications or ~/Downloads, or set DEVELOPER_DIR explicitly." >&2
  exit 1
fi

# Some native dependencies cache the absolute compiler-rt search path. If Xcode
# is moved later (for example from Downloads to /Applications), that stale path
# can make the final link fail even though DEVELOPER_DIR is correct. Always add
# the runtime directory from the currently selected Xcode.
ACTIVE_DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
CLANG_ROOT="$ACTIVE_DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang"
CLANG_RT_DIR="$(find "$CLANG_ROOT" -type d -path '*/lib/darwin' -print -quit 2>/dev/null || true)"
if [[ -n "$CLANG_RT_DIR" ]]; then
  export LIBRARY_PATH="$CLANG_RT_DIR${LIBRARY_PATH:+:$LIBRARY_PATH}"
fi

echo "▸ Building Snack Meet (meetily)…"
if [[ ! -d "$MEETILY/node_modules" ]]; then
  echo "  installing frontend deps (pnpm install)…"
  ( cd "$MEETILY" && pnpm install --frozen-lockfile )
fi
# --no-bundle: emit only the self-contained binary (embeds _next). Verified working.
( cd "$MEETILY" && pnpm tauri build --no-bundle )

# The binary lands in the WORKSPACE-ROOT target dir (meetily/target), NOT
# meetily/frontend/src-tauri/target — the Cargo workspace root is meetily/.
BIN="$ROOT/meetily/target/release/meetily"
echo "✓ Done."
[[ -f "$BIN" ]] && echo "  Snack Meet binary: $BIN" \
  || echo "  ✗ binary not found at $BIN (check meetily/target/release/)"
