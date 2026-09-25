#!/usr/bin/env bash
# PostToolUse(Edit|Write): keep formatting deterministic so diffs stay reviewable.
set -uo pipefail
input=$(cat)
path=$(printf '%s' "$input" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).tool_input.file_path||'')}catch{console.log('')}})")
[ -z "$path" ] && exit 0
case "$path" in
  *.ts|*.js|*.json|*.jsonc|*.md|*.yml|*.yaml)
    # Use the workspace's prettier directly so this works without a global pnpm.
    cd "${CLAUDE_PROJECT_DIR:-.}" && [ -x node_modules/.bin/prettier ] && node_modules/.bin/prettier --write "$path" >/dev/null 2>&1 || true ;;
  *.tf)
    command -v terraform >/dev/null && terraform fmt "$path" >/dev/null 2>&1 || true ;;
esac
exit 0
