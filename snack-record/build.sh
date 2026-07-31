#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$ROOT/build"
APP="$BUILD_DIR/Snack Record.app"
ARCH="$(uname -m)"
DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
case "$ARCH" in
  arm64|x86_64) ;;
  *)
    echo "Unsupported Mac architecture: $ARCH" >&2
    exit 1
    ;;
esac
if [[ -z "${SIGN_IDENTITY:-}" ]]; then
  SIGN_IDENTITY="$(zsh "$ROOT/scripts/ensure_local_signing_identity.sh")"
fi
if [[ -z "$SIGN_IDENTITY" ]]; then
  echo "A stable signing identity is required. Set SIGN_IDENTITY=- only for disposable builds." >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/funasr_transcribe.py" "$APP/Contents/Resources/funasr_transcribe.py"
cp "$ROOT/Assets/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/Assets/SnackLogo.png" "$APP/Contents/Resources/SnackLogo.png"

clang -arch "$ARCH" -mmacosx-version-min="$DEPLOYMENT_TARGET" -fobjc-arc "$ROOT/Sources/main.m" "$ROOT/Sources/SnackRecordingActivity.m" \
  -framework Cocoa \
  -framework AVFoundation \
  -framework AudioToolbox \
  -framework Carbon \
  -framework ScreenCaptureKit \
  -framework CoreMedia \
  -framework UniformTypeIdentifiers \
  -framework UserNotifications \
  -o "$APP/Contents/MacOS/Snack Record"

if [[ "$(lipo -archs "$APP/Contents/MacOS/Snack Record")" != "$ARCH" ]]; then
  echo "Built executable does not match the current Mac architecture: $ARCH" >&2
  exit 1
fi

codesign --force --deep \
  --options runtime \
  --timestamp=none \
  --entitlements "$ROOT/Entitlements.plist" \
  --sign "$SIGN_IDENTITY" \
  "$APP"

echo "$APP"
