#!/usr/bin/env bash
# Checks backlog-review digest actions (one JSON per line on stdin) with the broker's own rules
# before the operator runs one by hand (/backlog-digest). Bundles
# workers/agents/scripts/check-digest-action.ts for Node into a temporary directory and runs it.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
(cd "$root/workers/agents" && pnpm exec esbuild scripts/check-digest-action.ts \
  --bundle --platform=node --format=esm --target=node22 --loader:.md=text \
  --outfile="$out/check-digest-action.mjs" --log-level=warning)
node "$out/check-digest-action.mjs"
