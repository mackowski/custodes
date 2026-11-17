---
name: agent-security-review
description: Security-focused review checklist for a pull request in this repo - agent authority, prompt injection paths, secrets, approvals, CI and Terraform changes. Use on any PR touching workers/, packages/, policy, hooks, CI or infra.
argument-hint: '[pr-number] (nothing = the checked-out branch against main)'
context: fork
agent: security-reviewer
allowed-tools: Read, Grep, Glob, Bash(gh pr diff *), Bash(git diff *)
---

# Agent security review: ${ARGUMENTS:-the checked-out branch against main}

Diff under review (a pull request by number, or the checked-out branch against main plus
uncommitted changes):
!`if [ -n "$ARGUMENTS" ]; then gh pr diff "$ARGUMENTS"; else git diff origin/main...HEAD; git diff HEAD; fi`

That command runs in the session that started this skill, with that session's rights; you, the
reviewer, have no shell at all. The argument is a pull request number, never a branch name (a
branch name is chosen by the PR's author and can carry shell syntax). A pull request from another
author or a fork is reviewed by number only, never checked out: a checkout would put its hooks and
skills on disk, where the session runs them. To read a file as the pull request has it, use the
diff above; Read shows the checked-out tree.

You cannot fetch the diff again. If the diff above is cut short, or was saved to a file instead of
shown, Read that file in full; if you cannot see the whole diff, say that the review is incomplete
and which files you did not see, and give no approving verdict.

Work through the checklist in the security-reviewer system prompt. Also verify:

- `workers/github-broker/policy/policy.json` diff: any new repo, action, or higher rate limit must
  cite an ADR or issue.
- New `BrokerAction` variants have a denial test.
- New agent classes: registry, wrangler bindings, migration tag, docs page, evals all present.
- `.claude/settings.json` or hooks changed: does anything weaken the deny list?
- GitHub Actions: SHA-pinned, `permissions` minimal, no secrets on `pull_request` from forks.
- Terraform: no widening of Access policies; service tokens have durations.

Do not build, test or run anything (no pnpm, node, wrangler or scripts): CI already ran the checks,
and in CI this review holds an API key in its environment. Read the code instead.

Report findings ranked by severity with file:line and the smallest fix. End with an explicit
verdict: approve, approve with nits, or request changes.

Return the report; do not post it yourself (this skill runs in the read-only `security-reviewer`
subagent). In CI, `.github/workflows/claude-review.yml` posts the returned report as a PR comment.
