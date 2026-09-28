---
name: agents-sdk-state-writable
description: Cloudflare Agents SDK (0.24.0) lets any connected WebSocket client overwrite Agent state via cf_agent_state unless validateStateChange is overridden; check every new agent
metadata:
  type: project
---

In `agents@0.24.0` the base `Agent` accepts `{"type":"cf_agent_state","state":...}` frames from connected WebSocket clients and applies them with `setState`. The hook `validateStateChange(nextState, source)` is a no-op by default (`source` is `"server"` or a `Connection`). The gateway proxies `/agents/*` (including upgrades) to the agents Worker behind Access, so any Access-authenticated client can rewrite an agent's `state` (cursors, `lastErrors`, counters).

**Why:** Found during the triage review (2026-09-28). Impact is operator-only today, but state fields flow into digests/e-mails and control what gets re-processed, so it is a quiet integrity gap that every agent inherits.

**How to apply:** Recommend a fleet-wide override in `packages/core/src/agent.ts` (`CustodesAgent.validateStateChange` throwing when `source !== 'server'`). Until that lands, flag it as Low on each new agent that stores anything security-relevant in `state`. Verify the SDK version first; the hook name may change.
