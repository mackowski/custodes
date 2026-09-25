# Architecture overview

Custodes runs a small fleet of agents on Cloudflare that help maintain open-source repositories,
starting with OWASP CheatSheetSeries. The design goal, after correctness, is that **no agent can
do more than a human explicitly allowed, and everything an agent does can be traced and verified.**

## Components

```
GitHub (target repos)         Email (Cloudflare Email Service)         Operator laptop
   │ poll / webhook               │ inbound routing                       │ custodes CLI
   ▼                              ▼                                       ▼ (Access JWT / service token)
┌────────────────────────── workers/gateway ────────────────────────────────────────┐
│ verify webhook HMAC · approval e-mail → decision · Access JWT · admin API · /verify│
└──────────┬──────────────────────────────────────────────┬─────────────────────────┘
           │ Queue (INBOUND) / service binding             │ service binding
┌──────────▼──────────── workers/agents ───────────────┐  ┌▼──────── workers/github-broker ─────────────┐
│ Durable Object per agent instance (Agents SDK)       │  │ policy.json · kill switch · approvals (D1)   │
│ schedule/scheduleEvery · state · Workflows           │──▶ per-agent PAT (Secrets Store) · rate limit  │
│ LLM via AI Gateway (BYOK) · guard() before acting    │  │ audit log (D1) · Ed25519 attestation         │
│ sends e-mail to operators only                       │  │ → api.github.com (the only place)            │
└──────────────────────────────────────────────────────┘  └──────────────────────────────────────────────┘
```

### workers/gateway

The only Worker with a public hostname. Responsibilities: verify GitHub webhook signatures and
queue events; receive approval e-mails and turn them into decisions; validate the Cloudflare Access
JWT and expose the admin API used by the CLI; expose `/verify/<attestation-id>` so anyone can check
an agent's footer against the published keys.

### workers/agents

Hosts the agent classes. Each agent is a Durable Object with SQLite state, scheduling and
optional WebSocket/e-mail channels, built on the Cloudflare Agents SDK through the
`CustodesAgent` base class. Agents reason, then _request_ side effects with `this.act()`. They hold
no GitHub credentials and cannot reach GitHub's write API.

### workers/github-broker

The single policy enforcement point. Every requested side effect goes through:
validate → policy → kill switch → approval (if required) → rate limit → execute → audit → sign.
It is the only Worker with GitHub tokens (one fine-grained PAT per agent) and with the agents'
Ed25519 signing keys. It is not reachable from the internet; only service bindings call it.

### packages

`schema` (zod wire formats), `core` (attestation, approval tokens, kill switch, policy evaluation,
agent base class), `github`, `llm`, `email` (adapters), `config` (shared tsconfig).

### apps/cli

`custodes`: list/run/halt/resume agents, decide approvals, browse and verify the audit log, tail
logs. Authenticates through Cloudflare Access (browser login or service token).

## Human involvement

| Mode                         | Behaviour                                                                                                                                | Controls                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **hitl** (human in the loop) | every side effect is proposed as an approval request; the operators (configured, not hardcoded) get an e-mail and decide by reply or CLI | approval token (HMAC, expiring, single use), action hash binding |
| **hotl** (human on the loop) | acts within policy, appends to a daily digest                                                                                            | kill switch per agent or fleet-wide, rate limits, audit log      |

## Identity and attribution

All PATs belong to the operator's GitHub account, so GitHub itself shows every comment as that
user. Custodes therefore provides its own attribution: each comment ends with
`Custodes-Agent: <id>@<version> · Custodes-Attestation: <uuid>` and the attestation is a signed
audit record verifiable at `/verify/<uuid>` or with `custodes audit verify`. See ADR 0003.

## Ingress

Polling with `scheduleEvery` is the default because it needs no rights on the target repository.
Webhooks are supported for repositories where an admin can add one; the gateway verifies the
signature and queues the event.
