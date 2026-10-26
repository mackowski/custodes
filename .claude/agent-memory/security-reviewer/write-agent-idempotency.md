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
- Same class again on 2026-10-20 (ADR 0013, maintainer-agreement check): the page-full case set `truncated`, but the 20-comment cap, the per-comment 2,000-char clip and `jevState`'s 30,000-char clip did not, so a Jev "no" over a partial view still closed. Check every `slice`/`clip` before a model call that can lead to a close. Also: an exclusion filter (agent `Custodes-Agent:` marker) run on the raw body before quote stripping drops a maintainer's whole comment when they quote the bot. Exclusions that remove evidence push toward close.
- **Append-only report logs** (pr-gate `events`): check for pruning and for row explosion from `error`/`would_close` retried every poll. Mark rows reported with `id <= lastId`, never with a blanket `reported_at IS NULL`.
- **Concurrent polls in one DO** (pr-gate webhooks review, 2026-10-26). A DO interleaves events at every `await` on fetch, so an alarm-driven poll (`schedule` callback) and a cron RPC `poll()` can run at once. Both list the same PRs, both decide, both `act()`; `pr.close` in `packages/github/src/api.ts` has no "still open?" check, so the second posts a duplicate public comment, and `closesToday`/`closedThisRun` caps are checked before the await, so they overrun. Before 2026-10-26 the only crons (`17 */4`, `30 5`) almost never overlapped; 5-minute wake slots make overlap routine (05:30 is both a slot and the prepare cron). Ask for a single-flight guard on any agent method that can be entered by more than one trigger.
- **Poll duration vs the poll lock.** pr-gate's single-flight guard is an in-memory `pollingSince` that goes stale after `POLL_LOCK_MS` (15 min). Anything that adds per-PR latency (Clef shadow: up to 2 × 10 s timeouts per PR × `MAX_EVALUATIONS_PER_RUN` 30 = 600 s; Jev has no timeout) eats that margin, and an expired lock brings back concurrent polls. Ask for a per-poll time budget or circuit breaker whenever a new await enters the per-PR loop.
- **Rows re-decided every poll × poll frequency.** `nextStep` re-decides `error` rows always and `would_close` rows when enforcing. Anything that raises poll frequency (wakes, webhooks) multiplies Jev spend and `PAT_READONLY` reads (shared with triage and specialists, 5000/h) unless there is a daily evaluation budget. Check this whenever a new trigger is added.

**Why:** These are the mass-action and public-reputation failure modes on someone else's repository; the docs claimed "cannot comment without closing" and "bounded by the broker rate limit", both false.

**How to apply:** For every new write action or hotl agent, walk: partial failure → what is public → is it counted → does the agent retry → what if a human reverses it. See [[architecture-invariants]].
