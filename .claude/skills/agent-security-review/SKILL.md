---
name: agent-security-review
description: Security-focused review checklist for a pull request in this repo - agent authority, prompt injection paths, secrets, approvals, CI and Terraform changes. Use on any PR touching workers/, packages/, policy, hooks, CI or infra.
argument-hint: '[pr-number] (nothing = the checked-out branch against main)'
context: fork
agent: security-reviewer
allowed-tools: Read, Grep, Glob, Bash(git diff origin/main...HEAD), Bash(git diff HEAD), Bash(gh pr diff *), Bash(gh pr view *)
---

# Agent security review: ${ARGUMENTS:-the checked-out branch against main}

Get the diff yourself, with exactly these commands and no others:

- no argument: `git diff origin/main...HEAD`, then `git diff HEAD` (uncommitted changes);
- a pull request number (digits only): `gh pr diff <number>`.

The argument is never pasted into a shell by this skill, and it is never a branch name: a branch
name is chosen by the PR's author and can carry shell syntax. If the argument is anything but a
number, say so and stop. A pull request from another author or a fork is reviewed by number only,
never checked out: a checkout would put its hooks and skills on disk, where this session runs them.

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
