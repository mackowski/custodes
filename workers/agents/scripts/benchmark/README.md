# cheatsheet-review model benchmark (one-off)

A one-off measurement to choose cheatsheet-review's models (ADR 0017) on real history. It is run by
hand and is **not** part of CI. Decisions and thresholds were fixed before the run
(grill-plan, 2026-10-29); the result is [REPORT.md](REPORT.md).

What it does:

1. `select.ts` picks 30 external pull requests to OWASP/CheatSheetSeries closed in the last 12
   months (10 merged cleanly, 12 merged after maintainer objections, 8 closed by a maintainer) and
   freezes each at the commit of the first maintainer review. Ground truth is what maintainers wrote.
2. `run.ts` runs the agent's own prompts and parsing on each snapshot: the current lineup and the
   candidates (DeepSeek V4.1 Flash, Muse Wonder, Sonnet 5.5, GPT-6 Astra as judge).
3. `grade.ts` asks GPT-6.1 Terra, which plays no candidate role, to match findings to maintainer
   notes without knowing which model wrote them.
4. `report.ts` writes REPORT.md and a 10-item spot check for the operator.

Read-only: public GitHub reads and model calls through the one AI Gateway; no broker, no GitHub
writes. Snapshots, raw model answers and the spot check stay in `.bench/cheatsheet-review/`
(git-ignored). A hard budget of $50 stops the run; every step resumes where it stopped.

```bash
cd workers/agents
for s in select run grade report; do
  pnpm exec esbuild scripts/benchmark/$s.ts --bundle --platform=node --format=esm --outfile=/tmp/bench-$s.mjs --log-level=warning
done
export GITHUB_TOKEN=$(gh auth token --user mackowski)   # public reads, rate limit only
../../scripts/with-secrets.sh node /tmp/bench-select.mjs
../../scripts/with-secrets.sh node /tmp/bench-run.mjs
../../scripts/with-secrets.sh node /tmp/bench-grade.mjs
node /tmp/bench-report.mjs
```

Needs `AI_GATEWAY_TOKEN` and `CF_WORKERS_AI_EVAL_TOKEN` (Workers AI read and edit) in the Keychain
(`scripts/with-secrets.sh set <NAME>`).
