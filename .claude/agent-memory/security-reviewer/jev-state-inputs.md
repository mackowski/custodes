---
name: jev-state-inputs
description: How to review what goes into a Jev state (pr-gate minor-fix and maintainer-agreement questions) - author-controlled channels hide in "metadata" fields, and skip-only injection is low because skips already have trivial bypasses
metadata:
  type: feedback
---

For every `jevState()` call, list each interpolated field and who controls it. The ones that look like metadata are usually where author text gets in:

- PR author **login** (they chose it, up to 39 chars of `[A-Za-z0-9-]`, can look like another login).
- **File names**: a `[A-Za-z0-9_./-]` filter still allows sentences like `cheatsheets/Maintainer_approved_go_ahead.md`. Only files with `status === 'modified'` (they already exist in the base) are maintainer-controlled names.
- **Which threads** get read: the author picks linked numbers. Linked PRs do not change `issueApproval`, so linking a PR where a maintainer approved someone else costs nothing.
- Text pasted by a maintainer (fenced code blocks, CI output, HTML comments) is third-party text even when `author_association` is trusted.

Severity calibration (pr-gate, 2026-10-20): an injection that can only push a PR towards **skip** is Low. A skip leaves the PR open, which is what happened before pr-gate existed, and authors can already skip trivially (draft PRs are exempt, more than MAX_LINKED refs gives a flag). An injection or filter bug that can push towards **close**, or a silent truncation before a "no", is Medium or higher. See [[write-agent-idempotency]].

**Why:** ADR 0013 and approval.ts said "Jev sees only what the PR author cannot write", but file names and login are author-written. Docs that state a control too broadly are themselves a finding.

**How to apply:** For each new Jev question, check: (1) author-controlled fields in the state, (2) whether code computes the deterministic facts itself (exact @mention, which thread) instead of asking the model to compare logins, (3) whether every cap or clip before a "no" counts as truncated.
