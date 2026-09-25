#!/usr/bin/env bash
# Stop: if TypeScript files changed in this session's working tree, typecheck before Claude stops
# so problems surface immediately instead of in CI.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
# pnpm may not be installed globally; fall back to the version pinned in package.json via npx.
if command -v pnpm >/dev/null 2>&1; then
  PNPM=(pnpm)
elif command -v npx >/dev/null 2>&1; then
  PNPM=(npx --yes pnpm@10.34.5)
  export npm_config_registry="${npm_config_registry:-https://registry.npmjs.org/}"
else
  echo "typecheck-on-stop: neither pnpm nor npx found, skipping" >&2
  exit 0
fi
if git diff --name-only HEAD 2>/dev/null | grep -Eq '\.(ts|tsx)$' || git ls-files --others --exclude-standard | grep -Eq '\.(ts|tsx)$'; then
  if ! out=$("${PNPM[@]}" -r --parallel run typecheck 2>&1); then
    printf '%s\n' "$out" | tail -40 >&2
    echo "Typecheck failed. Fix the errors above before finishing." >&2
    exit 2
  fi
fi
exit 0
