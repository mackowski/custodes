---
name: architecture-invariants
description: Review-time invariants for Custodes: credentials only in the broker, policy widening needs an ADR, readonly agents (ADR 0009) have no policy entry
metadata:
  type: project
---

- Agents never hold GitHub or e-mail credentials; only `workers/github-broker` does. Any PR that adds a token binding to `workers/agents` is a finding.
- Policy file: `workers/github-broker/policy/policy.json`. Widening `repos`, `actions`, or raising `rateLimitPerHour` needs an ADR reference in the PR.
- ADR 0009 (2026-09-28): `readonly` agent mode. A readonly agent has NO policy entry (broker answers `unknown_agent`), `CustodesAgent.act()` throws, and `evaluatePolicy` denies even if an entry is added. A readonly agent reads GitHub through an unauthenticated GET-only client in the agents Worker; that is the accepted exception to "agents never call api.github.com" as long as there is no token and no non-GET method.
- E-mail from agents is bounded by `send_email.allowed_destination_addresses` in `workers/agents/wrangler.jsonc`; the `to` must come from a var, never from model or issue data. Widening the list is a reviewed PR.

**Why:** These are the load-bearing controls; the threat model (docs/architecture/threat-model.md) accepts that agents in one Worker share a trust domain, so the broker policy is the real blast-radius limit.

**How to apply:** Check them first in every review (authority category). Treat a readonly agent gaining a `tokenBinding` or a policy entry as a mode change requiring an ADR.
