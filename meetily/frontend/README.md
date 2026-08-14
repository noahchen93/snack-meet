# Snack Meet frontend

Next.js/React interface and Tauri application manifest for Snack Meet.

Run from this directory:

```bash
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint src --max-warnings=0
pnpm build
```

Use the repository-root `build.sh` to create a complete macOS app bundle.
