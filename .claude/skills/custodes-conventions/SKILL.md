---
name: custodes-conventions
description: Layering rules, naming, error and audit patterns for the Custodes monorepo. Background knowledge loaded by other skills and agents.
user-invocable: false
---

# Custodes conventions

## Layering (imports only point downwards)

```
apps/cli ─┐
workers/* ─┼─> packages/{github,llm,email} ─> packages/core ─> packages/schema
           └────────────────────────────────────────────────────┘
```

- `packages/schema`: zod only. Every wire format (broker, admin API, queue, audit) is defined here
  and inferred as types. Never hand-write an interface for something that crosses a boundary.
- `packages/core`: pure logic runnable in node and workerd: canonical JSON, attestations,
  approval tokens, kill switch, policy evaluation, `CustodesAgent` base class (`@custodes/core/agent`).
- `packages/github|llm|email`: adapters. No policy decisions live here.
- `workers/github-broker`: the only code allowed to hold a GitHub token or call api.github.com.
- `workers/agents`: agents reason and _request_ actions with `this.act()`. They never execute them.
- `workers/gateway`: the only internet-facing Worker. Access on `/admin` and `/agents`.

## Security patterns

- Untrusted text goes through `untrusted(source, text)` from `@custodes/llm` before any prompt.
  The system prompt includes `UNTRUSTED_DATA_RULES`.
- Model output is parsed with `parseStructured(schema, text)`. Never `JSON.parse` model output directly.
- Before any side effect: `await this.guard()` (kill switch), then `this.act()`.
- New GitHub side effect = new variant in `BrokerAction` + new `case` in `executeAction` + policy
  entry + test for the denial path. In that order.
- Errors never include request bodies, tokens, or raw model output. Log structured JSON:
  `console.log(JSON.stringify({ event: 'domain.verb', ...ids }))`.
- Secrets: Secrets Store bindings in the broker (`PAT_<AGENT>`, synced by CI from GitHub secrets), signing keys inside the broker Keyring, Worker secrets
  elsewhere (`wrangler secret put`). Never `vars`, never in code, never in tests as real values.

## Code style

- TypeScript strict, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`: spread optional fields
  conditionally (`...(x !== undefined ? { x } : {})`).
- Exact dependency versions. New dependency = justify in the PR, check `pnpm licenses`.
- Tests: `test/**/*.test.ts`, deterministic, inject `now`, keys and `fetchImpl`.
- Agent ids are kebab-case (`triage`); Durable Object classes are `PascalCase` + `Agent`
  (`TriageAgent`); SDK routes are `/agents/triage-agent/<instance>`.

## Docs that must change with code

| Change                | Update                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------- |
| new agent             | `docs/agents/<id>.md`, `workers/agents/src/registry.ts`, policy, wrangler bindings, evals |
| new action type       | `docs/architecture/security-controls.md` table                                            |
| architecture decision | `docs/architecture/adr/NNNN-*.md` via `/adr`                                              |
| new secret            | `docs/runbooks/rotate-pat.md` or a new runbook                                            |
