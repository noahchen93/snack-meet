#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_SUPPORT="$HOME/Library/Application Support/Snack Record"
RUNTIME_DIR="$APP_SUPPORT/Runtime"
MODELS_DIR="$APP_SUPPORT/Models"
VENV_DIR="$RUNTIME_DIR/venv"
INSTALL_DIR="${SNACK_RECORD_INSTALL_DIR:-$HOME/Applications}"
DEST_APP="$INSTALL_DIR/Snack Record.app"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64|x86_64) ;;
  *)
    echo "Unsupported Mac architecture: $ARCH" >&2
    exit 1
    ;;
esac

python_is_compatible() {
  local executable="$1"
  "$executable" - "$ARCH" <<'PY' >/dev/null 2>&1
import platform
import sys

expected_arch = sys.argv[1]
version = sys.version_info[:2]
supported_version = version >= (3, 10)
if expected_arch == "x86_64":
    supported_version = supported_version and version <= (3, 12)

raise SystemExit(not (platform.machine() == expected_arch and supported_version))
PY
}

find_compatible_python() {
  local candidate executable
  local -a candidates
  if [[ "$ARCH" == "x86_64" ]]; then
    candidates=(python3.11 python3.12 python3.10 python3)
  else
    candidates=(python3 python3.13 python3.12 python3.11 python3.10)
  fi

  for candidate in "${candidates[@]}"; do
    executable="$(command -v "$candidate" 2>/dev/null || true)"
    if [[ -n "$executable" ]] && python_is_compatible "$executable"; then
      print -r -- "$executable"
      return 0
    fi
  done
  return 1
}

command -v xcrun >/dev/null || { echo "Install Xcode Command Line Tools first: xcode-select --install"; exit 1; }
command -v security >/dev/null || { echo "The macOS security command is required."; exit 1; }

if [[ -n "${SNACK_RECORD_PYTHON:-}" ]]; then
  PYTHON_BIN="$SNACK_RECORD_PYTHON"
  if [[ ! -x "$PYTHON_BIN" ]] || ! python_is_compatible "$PYTHON_BIN"; then
    echo "SNACK_RECORD_PYTHON must point to a supported native $ARCH Python executable." >&2
    exit 1
  fi
else
  PYTHON_BIN="$(find_compatible_python || true)"
fi

if [[ -z "$PYTHON_BIN" ]]; then
  if ! command -v brew >/dev/null; then
    echo "A compatible Python is required. Install Homebrew so Python 3.11 can be installed." >&2
    exit 1
  fi
  echo "Installing Python 3.11 for Snack Record..."
  brew install python@3.11
  PYTHON_BIN="$(brew --prefix python@3.11)/bin/python3.11"
  if ! python_is_compatible "$PYTHON_BIN"; then
    echo "Homebrew did not provide a native $ARCH Python 3.11 executable." >&2
    exit 1
  fi
fi

if ! command -v ffmpeg >/dev/null; then
  if command -v brew >/dev/null; then
    brew install ffmpeg
  else
    echo "FFmpeg is required. Install Homebrew, then run: brew install ffmpeg"
    exit 1
  fi
fi

mkdir -p "$RUNTIME_DIR" "$MODELS_DIR" "$INSTALL_DIR"
if [[ -x "$VENV_DIR/bin/python" ]] && ! python_is_compatible "$VENV_DIR/bin/python"; then
  echo "Rebuilding an incompatible Snack Record Python environment..."
  rm -rf "$VENV_DIR"
fi
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/python" -m pip install --upgrade pip
"$VENV_DIR/bin/python" -m pip install -r "$ROOT/requirements.txt"
"$VENV_DIR/bin/python" - "$ARCH" <<'PY'
import platform
import sys

import torch
import torchaudio
from transformers.utils import is_torch_available

expected_arch = sys.argv[1]
torch_version = torch.__version__.split("+")[0]
torchaudio_version = torchaudio.__version__.split("+")[0]
if platform.machine() != expected_arch:
    raise SystemExit(f"Python runtime architecture is {platform.machine()}, expected {expected_arch}")
if torch_version != torchaudio_version:
    raise SystemExit(f"torch {torch_version} and torchaudio {torchaudio_version} do not match")
if expected_arch == "x86_64" and torch_version != "2.2.2":
    raise SystemExit(f"Intel Macs require torch 2.2.2, found {torch_version}")
if not is_torch_available():
    raise SystemExit("Transformers disabled its PyTorch backend")
print(f"Python runtime ready: {platform.machine()}, torch {torch_version}")
PY

echo "Downloading local speech models (about 2 GB on first install)..."
MODELSCOPE_CACHE="$MODELS_DIR" "$VENV_DIR/bin/python" "$ROOT/scripts/download_models.py"

zsh "$ROOT/build.sh"
rm -rf "$DEST_APP"
ditto "$ROOT/build/Snack Record.app" "$DEST_APP"
open "$DEST_APP"

echo "Installed: $DEST_APP"
