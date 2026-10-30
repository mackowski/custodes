---
name: adr0016-trace-payloads
description: ADR 0016 (2026-10-29) - operator deliberately records model/tool payloads in Workers traces; review only the stated boundaries, not the choice
metadata:
  type: project
---

Recording untrusted issue/PR text, prompts and Jev/Clef state in Workers trace spans (`TRACE_PAYLOADS="true"`, var in workers/agents/wrangler.jsonc) is an accepted operator decision (ADR 0016). Do not re-argue it.

**Why:** session replay is what every pr-gate incident (#2801, #2831) needed; the operator accepted a second 7-day copy of untrusted text in Workers Observability.

**How to apply:** when reviewing tracing code, check only the ADR boundaries: no credentials in any span attribute, errors carry `error.type` only (no provider body text), `/v1/read` responses metadata-only, no OTel export destination without a new ADR, tracing must never change agent control flow, identity attributes come from manifest id + allow-listed DO instance names (`instanceOf`). Open items from the first review (2026-10-29): `enterSpan` itself was unguarded, and it was unverified whether workerd auto-records a rejected callback's exception message on the span (rethrowing through `enterSpan` could leak `GatewayError` text). Since 2026-10-30 chat payloads are clipped to 8k chars each (`clipPayload`, packages/llm gateway.ts) because large spans were dropped; a clip can cut an `untrusted()` envelope mid-way, which is fine only because traces are untrusted data (CLAUDE.md invariant 2). Related: [[review-patterns]].
