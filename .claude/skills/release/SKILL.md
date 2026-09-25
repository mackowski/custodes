---
name: release
description: Prepare a release - ensure changesets exist for user-visible changes, run the full check, and open the version PR. Only a human may invoke this.
disable-model-invocation: true
allowed-tools: Read, Glob, Bash(pnpm changeset*), Bash(pnpm check*), Bash(git status*), Bash(git log*), Bash(gh pr create *)
---

# Release

Pending changesets:
!`ls .changeset/*.md 2>/dev/null | grep -v README || echo "(none)"`

Commits since last tag:
!`git log $(git describe --tags --abbrev=0 2>/dev/null || git rev-list --max-parents=0 HEAD)..HEAD --oneline`

1. For every `feat`/`fix` commit without a changeset, create one with `pnpm changeset` (patch for
   fixes, minor for features; major only for broker policy semantics or wire-format changes).
2. `pnpm check` must pass.
3. Push and let the `Release` workflow open the version PR; do not tag manually.
4. Summarise what will ship and any migration or runbook steps operators must take.
