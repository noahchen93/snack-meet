#!/bin/zsh
# Snack Meet — build the complete, self-contained macOS application bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
FRONTEND="$ROOT/meetily/frontend"
BUNDLE="$ROOT/meetily/target/release/bundle/macos/Snack Meet.app"
EXECUTABLE="$BUNDLE/Contents/MacOS/snack-meet"

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
  echo "✗ Full Xcode is required to build Snack Meet." >&2
  exit 1
fi

ACTIVE_DEVELOPER_DIR="${DEVELOPER_DIR:-$(xcode-select -p)}"
CLANG_ROOT="$ACTIVE_DEVELOPER_DIR/Toolchains/XcodeDefault.xctoolchain/usr/lib/clang"
CLANG_RT_DIR="$(find "$CLANG_ROOT" -type d -path '*/lib/darwin' -print -quit 2>/dev/null || true)"
if [[ -n "$CLANG_RT_DIR" ]]; then
  export LIBRARY_PATH="$CLANG_RT_DIR${LIBRARY_PATH:+:$LIBRARY_PATH}"
fi

echo "▸ Building the complete Snack Meet.app bundle…"
if [[ ! -x "$FRONTEND/node_modules/.bin/tauri" ]]; then
  (cd "$FRONTEND" && pnpm install --frozen-lockfile)
fi
(cd "$FRONTEND" && ./node_modules/.bin/tauri build --bundles app)

if [[ ! -x "$EXECUTABLE" ]]; then
  echo "✗ Complete bundle was not produced at: $BUNDLE" >&2
  exit 1
fi

echo "✓ Snack Meet bundle: $BUNDLE"
