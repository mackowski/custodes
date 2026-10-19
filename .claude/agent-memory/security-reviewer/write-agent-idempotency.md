---
name: write-agent-idempotency
description: Checks for write-capable (hotl) agents and multi-call broker actions: partial side effects, rate limit counting only 'allowed', retry loops on 'error', re-acting after a human reversal
metadata:
  type: project
---

First found in the pr-gate review (2026-10-15, ADR 0011, `pr.close` = comment then PATCH close):

- **Multi-call broker actions are not atomic.** If call 1 succeeds and call 2 fails, `act.ts` returns `github_error` through `deny()`, which (a) records a _new_ attestation id, so the trailer id already posted on GitHub does not verify, and (b) is not counted by `countAllowedSince` (only `decision = 'allowed'`), so the hourly rate limit does not bound partial side effects.
- **Agent retry on `error`.** pr-gate re-decides rows with `outcome = 'error'` every poll. Combined with the above, that means a public comment every 4 h per PR with no close. Check any new write agent for "error ⇒ retry" on codes that may have had side effects (`github_error`).
- **Human reversal.** Re-deciding on `updated_at` change means a maintainer reopen triggers a re-close. Any agent that acts on GitHub state must treat "I already acted and a human undid it" as terminal (flag, never act again).
- **Dry-run flags in agent vars are not broker enforcement.** The broker trusts the `agentId` from any caller in the agents Worker (accepted risk, threat-model.md), so a `*_ENFORCE=false` var does not limit what the policy already allows. Suggest the policy carry the gate (`requiresApproval`) until enforcement is flipped.

- **Safety nets must fail toward "flag".** (pr-gate 2026-10-19, #2801 false close.) Check that a pre-close lookup that throws or is truncated never lets the close go ahead. pr-gate's `approvedIssuesOf` throwing gives `error` (safe), but `listOpenIssuesWithLabel` stops at 300 issues (sorted `created asc`) without saying so, and a truncated list reads as "not approved", which allows the close.
- **Append-only report logs** (pr-gate `events`): check for pruning and for row explosion from `error`/`would_close` retried every poll. Mark rows reported with `id <= lastId`, never with a blanket `reported_at IS NULL`.

**Why:** These are the mass-action and public-reputation failure modes on someone else's repository; the docs claimed "cannot comment without closing" and "bounded by the broker rate limit", both false.

**How to apply:** For every new write action or hotl agent, walk: partial failure → what is public → is it counted → does the agent retry → what if a human reverses it. See [[architecture-invariants]].
