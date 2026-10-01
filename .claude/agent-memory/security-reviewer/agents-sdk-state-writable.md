---
name: agents-sdk-trust-surface
description: Verified facts about the Cloudflare Agents SDK (0.24.0) trust surface — state frames (fixed in core), which methods WebSocket clients can call, schedule() dedupe semantics
metadata:
  type: project
---

Verified against `agents@0.24.0` (`dist/src-*.js`, `callable-decorator.js`) on 2026-10-01:

- **State frames:** `cf_agent_state` frames from clients are applied unless `validateStateChange` rejects them. FIXED fleet-wide on 2026-09-30/10-01: `CustodesAgent.validateStateChange` in `packages/core/src/agent.ts` throws when `source !== 'server'`. On each review, confirm the override is still there and that no agent re-overrides it.
- **RPC exposure:** `cf_agent_rpc` frames only reach methods decorated with `@callable()` (`_isCallable` → `isCallableMethod`). Plain public methods (`enqueue`, `work`, `pendingResults`, ...) are reachable only through a Durable Object stub (`getAgentByName(...)`) from inside the Worker, or via `onRequest` for HTTP. So agent-to-agent RPC is intra-Worker trust, not client trust; still require zod on every RPC arg (threat model treats agents as separate components).
- **schedule():** `schedule(delay, cb, payload, { idempotent: true })` dedupes on callback+payload against pending rows; delayed schedules default to `idempotent: false`. A self-rescheduling worker (`schedule(2, 'work')`) plus an external `schedule(5, 'work', undefined, { idempotent: true })` can still produce two concurrent alarm chains that pick the same SQL job before it is deleted.

**Why:** These decide whether a finding is "any Access user" (client-reachable) or "another agent in the same Worker" (accepted shared trust domain), and whether cost caps can be bypassed.

**How to apply:** Check version first (`node_modules/.pnpm/agents@*`); hook names may change. Flag any new `@callable()` as client-reachable surface behind Access.
