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
│ verify webhook HMAC · approval link → decision · Access JWT · admin API · /verify│
└──────────┬──────────────────────────────────────────────┬─────────────────────────┘
           │ per-agent queues · service bindings           │ service binding (BrokerAdmin)
┌──────────▼──── one Worker per agent (ADR 0018) ──────┐  ┌▼──────── workers/github-broker ─────────────┐
│ custodes-triage · custodes-triage-apply ·            │  │ policy.json · kill switch · approvals (D1)   │
│ custodes-pr-gate · custodes-cheatsheet-review        │──▶ per-agent entrypoint: signature + nonce     │
│ Durable Object per instance (Agents SDK)             │  │ PATs (Secrets Store) · rate limit            │
│ own Keyholder key signs every broker call            │  │ audit log (D1) · Ed25519 attestation         │
│ LLM via AI Gateway · guard() · e-mail to operators   │  │ → api.github.com (the only place)            │
└──────────────────────────────────────────────────────┘  └──────────────────────────────────────────────┘
```

### workers/gateway

The only Worker with a public hostname. Responsibilities: verify GitHub webhook signatures and
queue events; serve approval links (behind Access) and turn clicks into decisions; validate the Cloudflare Access
JWT and expose the admin API used by the CLI; expose `/verify/<attestation-id>` so anyone can check
an agent's footer against the published keys.

### Agent Workers (`workers/<agent>`, code in `workers/agents`)

Each agent runs in its own Worker (ADR 0018): `custodes-triage` (triage and its two read-only
specialists), `custodes-triage-apply`, `custodes-pr-gate` and `custodes-cheatsheet-review`. Their
code lives in `workers/agents/src`; each Worker bundles only its entry point (`src/<agent>-worker.ts`)
and has only its own bindings and secrets. Each agent is a Durable Object with SQLite state and
scheduling, built on the Cloudflare Agents SDK through the `CustodesAgent` base class. Agents
reason, then _request_ side effects with `this.act()`. They hold no GitHub credentials and cannot
reach GitHub's write API. Each Worker keeps its own Ed25519 key in a `Keyholder` Durable Object and
signs every broker call with it; the broker accepts it only on that Worker's own entrypoint, for the
agent ids it hosts, and its public key is pinned in `packages/schema/src/agent-keys.json`.

`custodes-agents` (`workers/agents/wrangler.jsonc`) remains, running no agent: it serves the agent
registry for the gateway's `/admin/agents` and keeps the Durable Object tombstones of the moves.

### workers/github-broker

The single policy enforcement point. Every requested side effect goes through:
validate → policy → kill switch → approval (if required) → rate limit → execute → audit → sign.
It is the only Worker with GitHub tokens (a PAT per write agent, a read-only one for reads), and
it countersigns every audit record with its own keys; the agents' keys stay in their Workers (ADR
0018). It is not reachable from the internet; only service bindings call it, each agent Worker on
its own signed entrypoint (the unsigned default one refuses every agent).

### packages

`schema` (zod wire formats), `core` (attestation, approval tokens, kill switch, policy evaluation,
agent base class), `github`, `llm`, `email` (adapters), `config` (shared tsconfig).

### apps/cli

`custodes`: list/run/halt/resume agents, decide approvals, browse and verify the audit log, tail
logs. Authenticates through Cloudflare Access (browser login or service token).

## Human involvement

| Mode                         | Behaviour                                                                                                                                                                 | Controls                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **hitl** (human in the loop) | every side effect is proposed as an approval request; the operators (configured, not hardcoded) get an e-mail with a link and decide on its page behind Access, or by CLI | approval token (HMAC in the broker's Keyring, expiring, bound to the action hash), single use |
| **hotl** (human on the loop) | acts within policy, appends to a daily digest                                                                                                                             | kill switch per agent or fleet-wide, rate limits, audit log                                   |

## Identity and attribution

All PATs belong to the operator's GitHub account, so GitHub itself shows every comment as that
user. Custodes therefore provides its own attribution: each comment ends with
`Custodes-Agent: <id>@<version> · Custodes-Attestation: <uuid>` and the attestation is a signed
audit record verifiable at `/verify/<uuid>` or with `custodes audit verify`. See ADR 0003.

## Ingress

Polling with `scheduleEvery` is the default because it needs no rights on the target repository.
Webhooks are supported for repositories where an admin can add one; the gateway verifies the
signature and queues the event.
