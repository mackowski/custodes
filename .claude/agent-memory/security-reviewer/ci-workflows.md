---
name: ci-workflows
description: Accepted CI trust model for Claude review and evals (write access = ci secrets, once-per-PR paid runs, PR-editable reviewer config) and the shell-validation shape to check in workflow steps
metadata:
  type: project
---

Accepted decisions (commit c437cd1, 2026-10-30, branch ci/cheaper-reviews-and-evals):

- Claude review and evals run once per PR (opened as non-draft, or ready_for_review). Pushes after that re-run nothing paid; re-runs are draft→ready (review) or `workflow_dispatch -f suites=...` (evals). Both are advisory, not required checks. Do not re-argue the cadence; do flag anything that makes a run silently select nothing or report green without running.
- CI security review runs at `effort: medium` by `sed` on `.claude/agents/security-reviewer.md` in the runner checkout; the deep pass is local before ready. The edit shows up in `git diff` (an allowed tool), not in `gh pr diff`.
- Trust boundary: write access already equals the `ci` environment secrets (no branch policy on `ci`; same-repo PRs and `workflow_dispatch` from any branch run that branch's workflow file). A PR can also edit `.claude/` (agent, skills, this memory) and so steer its own CI review. Accepted because only collaborators trigger these runs and humans approve.
- claude-code-action skips (and reports success) on any PR that changes `claude-review.yml`: such PRs get no CI review, say so in the report.

**Why:** cost control after the 2026-10-29 benchmark drained Anthropic credit; evals and review are advisory by design (docs/sdlc.md).

**How to apply:** in workflow diffs check: user/PR-derived strings reach the shell only via `env:` and quoted; unquoted `for x in $VAR` loops validate each token with an anchored regex before use (glob expansion happens before the check, so `set -f` is the cheap hardening); anything written to `$GITHUB_OUTPUT` cannot carry a newline; scripts whose empty output means "skip" must fail rather than print nothing. See [[architecture-invariants]] (ADR 0014 WIF notes).
