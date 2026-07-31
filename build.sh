#!/bin/zsh
# Snack Meet — unified build for both layers.
#   1) Capture layer:  snack-record/build.sh        -> snack-record/build/Snack Record.app
#   2) Intelligence:   pnpm tauri build --no-bundle  -> meetily/frontend/src-tauri/target/release/meetily
#                      (the --no-bundle binary embeds the _next frontend; a plain `cargo build`
#                       does NOT, and yields a blank UI — see docs/INTEGRATION.md)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

# ---------- 1) Capture layer ----------
echo "▸ Building capture layer (snack-record)…"
( cd "$ROOT/snack-record" && zsh build.sh )

# ---------- 2) Intelligence layer ----------
echo "▸ Building intelligence layer (meetily)…"
MEETILY="$ROOT/meetily/frontend"
if [[ ! -d "$MEETILY/node_modules" ]]; then
  echo "  installing frontend deps (pnpm install)…"
  ( cd "$MEETILY" && pnpm install --frozen-lockfile )
fi
# --no-bundle: emit only the self-contained binary (embeds _next). Verified working.
( cd "$MEETILY" && pnpm tauri build --no-bundle )

MEETILY_BIN="$MEETILY/src-tauri/target/release/meetily"
echo "✓ Done."
echo "  Snack Record.app : $ROOT/snack-record/build/Snack Record.app"
[[ -f "$MEETILY_BIN" ]] && echo "  meetily binary   : $MEETILY_BIN" || echo "  (meetily binary path may differ by target triple — check src-tauri/target/release/)"