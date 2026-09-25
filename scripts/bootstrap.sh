#!/usr/bin/env bash
# Checks the local toolchain and prints what is missing. Safe to re-run.
set -euo pipefail
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
miss() { printf '  \033[31m✗\033[0m %s\n' "$1"; MISSING=1; }
MISSING=0

echo "custodes bootstrap"
need_node="$(cat .node-version)"
if command -v node >/dev/null; then ok "node $(node --version) (repo pins $need_node)"; else miss "node: install $need_node (https://nodejs.org or fnm/nvm)"; fi
if command -v pnpm >/dev/null; then ok "pnpm $(pnpm --version)"; else miss "pnpm: npm install -g pnpm@10 (or: corepack enable)"; fi
if command -v cloudflared >/dev/null; then ok "cloudflared $(cloudflared --version 2>&1 | head -1)"; else miss "cloudflared (for CLI login): brew install cloudflared"; fi
if command -v terraform >/dev/null; then ok "terraform $(terraform version -json | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).terraform_version))')"; else miss "terraform >= 1.9 (only needed for infra/): brew install hashicorp/tap/terraform"; fi
if command -v actionlint >/dev/null; then ok "actionlint"; else miss "actionlint (optional, CI runs it): brew install actionlint"; fi
if command -v gitleaks >/dev/null; then ok "gitleaks"; else miss "gitleaks (optional, CI runs it): brew install gitleaks"; fi

echo
echo "Next:"
echo "  pnpm install && pnpm check"
echo "  pnpm --filter ./workers/github-broker exec wrangler login   # once, for wrangler dev"
[ "$MISSING" -eq 0 ] || exit 1
