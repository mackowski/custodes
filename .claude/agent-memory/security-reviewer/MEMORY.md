# security-reviewer memory

- [Architecture invariants](architecture-invariants.md) — broker-only credentials, policy widening needs ADR, readonly mode (ADR 0009), per-agent read resources (ADR 0010), specialist ids-only RPC, instance→repo map (ADR 0012)
- [Agents SDK trust surface](agents-sdk-state-writable.md) — state frames fixed in core; @callable only; onRequest 404 does not stop DO creation (0.28)
- [E-mail rendering pattern](email-rendering-pattern.md) — sanitize every interpolated field (esp. `dropped` lists, seen twice); paste-ready comments need Markdown-aware link stripping
- [Write-agent idempotency](write-agent-idempotency.md) — non-atomic multi-call actions, uncounted github_error, retry loops, human reopen, safety nets fail to flag, event-log pruning
- [Session hooks](session-hooks.md) — hook blocks Bash text containing deploy/secret commands even in grep patterns; search by binding names instead
- [Access CSRF](access-csrf.md) — Access cookie has no SameSite, gateway has no Origin check; effectful POSTs under /admin and /agents are CSRF-able until fixed
