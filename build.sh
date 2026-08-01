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