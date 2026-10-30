---
name: review-patterns
description: Recurring Custodes review checks - argument evaluation before no-op guards, sanitizer regexes for error ids, loop control converted into callbacks, render overrides that disagree with what drove the event
metadata:
  type: feedback
---

Recurring things worth checking in Custodes diffs:

- "Guarded"/no-op wrappers (tracing `span.set`, `span.payload`) still evaluate their arguments at the call site. A property access like `out.usage.input_tokens` there can throw and change behaviour even when tracing is off. (`clipPayload` added 2026-10-30 is evaluated eagerly too; harmless because it only slices strings.)
- Error-to-id sanitizers (`describeError` in workers/agents triage/errors.ts, `errorType` in packages/core tracing.ts) read `name`, numeric `status`, `errorType`, `reason`. Any new error class that stores provider or user text in a field with one of those names leaks it. `GatewayError` messages contain provider body text by design.
- When `break`/`continue` move into a callback (`return 'stop'|'next'`), check every exit: halt, the close-refused `halted` code, thrown errors, and that budget counters are outer `let`s mutated by the closure.
- Render-time overrides (e.g. cheatsheet-review's forced "NOT RUN" rows, 2026-10-30) are computed from model outcomes only; check they agree with the deterministic signals that still drive the posted event (link-stage BLOCKERs from HTTP checks run even when the link model is unavailable).

- D1 "conditional UPDATE ... WHERE status = 'pending'" after a separate SELECT: check the code reads `meta.changes`. `ApprovalStore.decide` (2026-10-30) returned 'ok' to the loser of a race, so concurrent approve and reject both report success. `consume()` does it right.
- Two copies of the same data in one row, only one verified: the approval page renders `request_json.action` while `act()` hash-checks `request_json.request.action`. Ask that what is shown is the copy that is verified.
- Decide-then-execute flows: any denial in the pipeline _before_ the single-use step (kill switch, policy) leaves the grant live. Check what can spend it later and whether that path checks expiry.
- "Spend it anyway" cleanup placed after an awaited call (e.g. `store.consume` after `act()` in `decideApproval`, 2026-10-30) is skipped when that call throws; check for `finally`, and whether any other path could spend the leftover grant.
- Config-pinning tests (e.g. `bindings.test.ts` on wrangler.jsonc): check they enumerate files instead of hard-coding names, look at every binding kind that grants reach (services, DO `script_name`, D1, KV), and cover `env.*` overrides. Hand-rolled JSONC stripping is fine if unknown syntax makes `JSON.parse` throw (fails closed).
- "Only one live X" dedupe done as SELECT-then-UPDATE _before_ the INSERT (approval `supersedePending`, 2026-10-30) lets two concurrent creates both survive. Suggest: insert first, then reject every other pending row for the target with `id != new`; worst case both die (fails closed). Also: approvals past `expires_at` stay `status='pending'` forever (only `decide` flips them), so "pending" scans need an `expires_at` filter. Both fixed in ba22e12 (insert, then supersede `id != keepId`); residual: if the supersede step throws, the new row is orphaned (no token issued) but counts toward MAX_PENDING and the old link stays live. Accepted as Low.
- Invisible-char display regexes: `\p{Cc}\p{Cf}` catches bidi, ZW*, tag chars (ASCII smuggling); it misses variation selectors (Mn, U+FE00-FE0F, U+E0100-E01EF), Hangul fillers (Lo), U+2028/2029. Accepted as Low on the operator-only approval page.
- Bench README `env -i` wrappers drop operator knobs like `BENCH_SKIP` silently: a cost regression, check what each script reads from `process.env`.

**Why:** found in the ADR 0016 tracing review (2026-10-29) and the lineup review (2026-10-30); the same shapes recur in pr-gate and the llm clients.

**How to apply:** check these first in any diff that touches the llm clients, error reporting, renderers or the pr-gate poll loop. See also [[adr0016-trace-payloads]].
