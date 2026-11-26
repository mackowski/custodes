#!/usr/bin/env bash
# Bundles workers/agents/scripts/eval-backlog-runtime.ts (the runtime, the shipped agent.md files and the
# policy) for Node, so the promptfoo provider runs exactly what the agent runs. Run from the repo
# root before a backlog-review eval (evals.yml does).
set -euo pipefail
cd "$(dirname "$0")/../workers/agents"
pnpm exec esbuild scripts/eval-backlog-runtime.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --loader:.md=text \
  --outfile=../../evals/output/backlog-runtime.mjs \
  --log-level=warning
