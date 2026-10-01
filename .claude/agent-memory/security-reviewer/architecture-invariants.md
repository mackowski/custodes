---
name: architecture-invariants
description: Review-time invariants for Custodes: credentials only in the broker, policy widening needs an ADR, readonly agents (ADR 0009) have no policy entry, per-agent read resource allow-list (ADR 0010), specialist delegation pattern
metadata:
  type: project
---

- Agents never hold GitHub or e-mail credentials; only `workers/github-broker` does. Any PR that adds a token binding to `workers/agents` is a finding.
- Policy file: `workers/github-broker/policy/policy.json`. Widening `repos`, `actions`, `rateLimitPerHour`, or (since ADR 0010) `reads.<agent>.resources` needs an ADR reference in the PR.
- ADR 0009 (2026-09-28): `readonly` agent mode. A readonly agent has NO `agents` policy entry (broker answers `unknown_agent`), `CustodesAgent.act()` throws, and `evaluatePolicy` denies even if an entry is added. Reads go through the broker's GET-only `/v1/read` with `PAT_READONLY` (the earlier "unauthenticated client in the agents Worker" exception is gone).
- ADR 0010 (2026-10-01): `ReadPolicy.resources` is a required per-agent allow-list; a new `ReadResource` enum value grants nothing until listed. Numbered resources need `number` (≤1e6), `cheatsheet` needs `file` matching `CheatSheetFile` (no `/`, no leading dot). The broker builds every path (`buildReadPath`); agents never pass paths. Check that each agent's grant matches what its reader methods actually call.
- Specialist pattern (ADR 0010): triage hands specialists **ids only** (`SpecialistJob = {issue, issueUpdatedAt}`) over DO stub RPC; specialists re-read under their own agent id and re-validate args with zod; triage re-validates results on receipt. Cost bound is `MAX_JOBS_PER_DAY` per specialist in server-owned state.
- E-mail from agents is bounded by `send_email.allowed_destination_addresses` in `workers/agents/wrangler.jsonc`; the `to` must come from a var, never from model or issue data. Widening the list is a reviewed PR.

**Why:** These are the load-bearing controls; the threat model (docs/architecture/threat-model.md) accepts that agents in one Worker share a trust domain, so the broker policy is the real blast-radius limit.

**How to apply:** Check them first in every review (authority category). Treat a readonly agent gaining a `tokenBinding`, an `agents` policy entry, or a new `resources` grant without an ADR as a finding. See [[agents-sdk-trust-surface]] for what "RPC" means in trust terms and [[email-rendering-pattern]] for the digest checks.
