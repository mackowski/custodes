# security-reviewer memory

- [Architecture invariants](architecture-invariants.md) — broker-only credentials, policy widening needs ADR, readonly mode (ADR 0009), per-agent read resources (ADR 0010), specialist ids-only RPC
- [Agents SDK trust surface](agents-sdk-state-writable.md) — state frames fixed in core; only `@callable` methods are client-reachable; `schedule` idempotent dedupe
- [E-mail rendering pattern](email-rendering-pattern.md) — sanitize every interpolated field (esp. `dropped` lists, seen twice); paste-ready comments need Markdown-aware link stripping
- [Session hooks](session-hooks.md) — hook blocks Bash text containing deploy/secret commands even in grep patterns; search by binding names instead
