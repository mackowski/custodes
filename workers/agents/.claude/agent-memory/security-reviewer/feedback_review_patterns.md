---
name: review-patterns
description: Recurring Custodes review checks - argument evaluation before no-op guards, sanitizer regexes for error ids, loop control converted into callbacks
metadata:
  type: feedback
---

Recurring things worth checking in Custodes diffs:

- "Guarded"/no-op wrappers (tracing `span.set`, `span.payload`) still evaluate their arguments at the call site. A property access like `out.usage.input_tokens` there can throw and change behaviour even when tracing is off.
- Error-to-id sanitizers (`describeError` in workers/agents triage/errors.ts, `errorType` in packages/core tracing.ts) read `name`, numeric `status`, `errorType`, `reason`. Any new error class that stores provider or user text in a field with one of those names leaks it. `GatewayError` messages contain provider body text by design.
- When `break`/`continue` move into a callback (`return 'stop'|'next'`), check every exit: halt, the close-refused `halted` code, thrown errors, and that budget counters are outer `let`s mutated by the closure.

**Why:** found in the ADR 0016 tracing review (2026-10-29); the same shapes recur in pr-gate and the llm clients.

**How to apply:** check these first in any diff that touches the llm clients, error reporting or the pr-gate poll loop. See also [[adr0016-trace-payloads]].
