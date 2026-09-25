---
name: agent-security-review
description: Security-focused review checklist for a pull request in this repo - agent authority, prompt injection paths, secrets, approvals, CI and Terraform changes. Use on any PR touching workers/, packages/, policy, hooks, CI or infra.
argument-hint: [pr-number | branch]
context: fork
agent: security-reviewer
allowed-tools: Read, Grep, Glob, Bash(gh pr diff *), Bash(gh pr view *), Bash(git diff *)
---

# Agent security review: ${ARGUMENTS:-current diff}

Diff under review:
!`if [ -n "$ARGUMENTS" ]; then gh pr diff "$ARGUMENTS" 2>/dev/null || git diff "$ARGUMENTS"...HEAD; else git diff HEAD; fi`

Work through the checklist in the security-reviewer system prompt. Also verify:

- `workers/github-broker/policy/policy.json` diff: any new repo, action, or higher rate limit must
  cite an ADR or issue.
- New `BrokerAction` variants have a denial test and a `summariseAction` case.
- New agent classes: registry, wrangler bindings, migration tag, docs page, evals all present.
- `.claude/settings.json` or hooks changed: does anything weaken the deny list?
- GitHub Actions: SHA-pinned, `permissions` minimal, no secrets on `pull_request` from forks.
- Terraform: no widening of Access policies; service tokens have durations.

Report findings ranked by severity with file:line and the smallest fix. If invoked with a PR
number and the inline comment tool is available, post each finding as an inline comment; otherwise
print them. End with an explicit verdict: approve, approve with nits, or request changes.
