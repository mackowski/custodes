# security-reviewer memory

- [Architecture invariants](architecture-invariants.md) — broker-only credentials, policy widening needs ADR, readonly mode (ADR 0009) semantics, e-mail destination allow-list
- [Agents SDK state is client-writable](agents-sdk-state-writable.md) — `cf_agent_state` frames overwrite Agent state unless `validateStateChange` is overridden; check every agent
- [E-mail rendering pattern](email-rendering-pattern.md) — sanitize every interpolated untrusted/model field (titles, dropped lists, errors), not just the summary
- [Session hooks](session-hooks.md) — hook blocks Bash text containing deploy/secret commands even in grep patterns; search by binding names instead
