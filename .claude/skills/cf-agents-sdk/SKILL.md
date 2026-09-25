---
name: cf-agents-sdk
description: Cloudflare Agents SDK reference notes as used in Custodes: Agent lifecycle hooks, state, scheduling, email, workflows and approvals, wrangler bindings. Background knowledge; not user-invocable.
user-invocable: false
---

# Cloudflare Agents SDK (agents@0.24) in Custodes

This file holds only the Custodes-specific rules. For SDK API details prefer Cloudflare's own
`agents-sdk`, `durable-objects`, `cloudflare-email-service`, `cloudflare-one` and `wrangler`
skills from the `cloudflare@cloudflare` plugin (installed per
https://developers.cloudflare.com/agent-setup/), then
https://developers.cloudflare.com/agents/api-reference/agents-api/, then the
`cloudflare-researcher` subagent.

## Agent class (extend `CustodesAgent` from `@custodes/core/agent`, not `Agent` directly)

| Hook                                  | When                                      |
| ------------------------------------- | ----------------------------------------- |
| `onStart()`                           | instance starts or wakes from hibernation |
| `onRequest(request)`                  | HTTP request routed to this instance      |
| `onConnect/onMessage/onClose/onError` | WebSocket lifecycle                       |
| `onEmail(email)`                      | inbound email routed by `routeAgentEmail` |
| `onStateChanged(state, source)`       | after `setState`                          |
| `onWorkflowProgress/Complete/Error`   | workflow events                           |

State: `this.state`, `this.setState(next)`, `initialState`. SQL: `this.sql\`...\``.
Scheduling: `this.schedule(when, 'method', payload)`, `this.scheduleEvery(seconds, 'method', payload)`.
Workflows: `this.runWorkflow('BINDING', params)`, `waitForApproval`, `approveWorkflow(id)`, `rejectWorkflow(id)`.
Email: `sendEmail`/`replyToEmail`(Custodes wraps these in`@custodes/email`).
RPC: `@callable()` methods are reachable from clients over WebSocket; treat inputs as untrusted.

## Routing

- `routeAgentRequest(request, env)` maps `/agents/<kebab-class>/<instance>` to the Durable Object.
- `getAgentByName(env.ClassBinding, name)` for server-side addressing (queue consumers).
- `routeAgentEmail(message, env, { resolver: createAddressBasedEmailResolver('DefaultAgent') })`.

## wrangler.jsonc essentials

```jsonc
"durable_objects": { "bindings": [{ "name": "TriageAgent", "class_name": "TriageAgent" }] },
"migrations": [{ "tag": "v2", "new_sqlite_classes": ["TriageAgent"] }],   // new tag per new class
"compatibility_flags": ["nodejs_compat"],
"workflows": [{ "name": "REVIEW_WORKFLOW", "binding": "REVIEW_WORKFLOW", "class_name": "ReviewWorkflow" }]
```

Also export the class from `src/index.ts` and register the manifest in `src/registry.ts`.

## Custodes-specific rules

- Never call GitHub from an agent. Request through `this.act(action, runId, triggeredBy, opts)`.
- Call `await this.guard()` at the start of every scheduled or triggered run.
- One `runId` (`crypto.randomUUID()`) per run; pass it to every `act()` so the audit log groups them.
- `hitl` agents create an approval via the broker `/v1/approvals`, e-mail the configured operators, and retry
  `act()` with `approvalId` once approved. `hotl` agents act directly and append to the digest.
