---
name: new-agent
description: Scaffold a new Custodes agent end to end - Durable Object class, manifest, registry entry, wrangler bindings, broker policy entry, secrets names, docs page, threat-model section, evals and tests. Use when asked to create or add an agent.
argument-hint: <agent-id> "<one-line purpose>" [hitl|hotl]
allowed-tools: Read, Grep, Glob, Write, Edit, Bash(pnpm *), Bash(git status*), Bash(git diff*)
skills:
  - custodes-conventions
  - cf-agents-sdk
---

# New agent: $ARGUMENTS

Create agent **$0** (purpose: $1, mode: ${2:-hitl}). Work through every step; an agent is not done
until all of them exist, because the broker refuses agents that have no policy and the admin API
lists only registered manifests.

## Steps

1. **Class** `workers/agents/src/agents/$0.ts`: `export class <Pascal>Agent extends CustodesAgent<AgentsEnv, State>`,
   `MANIFEST` with `id: '$0'`, `version: '0.1.0'`, `mode`, `repos`. Never put contact addresses in agent code; recipients come from the Workers' configuration. Implement `run(triggeredBy)`:
   `await this.guard()`, gather inputs (read-only GitHub calls go through the broker's future read
   endpoints or the public API without a token), wrap them with `untrusted()`, call the model via
   `AnthropicGateway`, `parseStructured()` the result, then `this.act()` per proposed action.
   Follow `hello.ts` for the shape.
2. **Export + registry**: add `export { <Pascal>Agent }` in `workers/agents/src/index.ts` and the
   manifest to `REGISTRY` in `src/registry.ts`.
3. **wrangler**: add the Durable Object binding in every env block of `workers/agents/wrangler.jsonc`
   and a new migration tag with `new_sqlite_classes`. If it needs a schedule, call `scheduleEvery`
   in `onStart` guarded by a state flag.
4. **Policy**: add `$0` to `workers/github-broker/policy/policy.json` with the minimum `repos` and
   `actions`, `mode`, `requiresApproval`, a conservative `rateLimitPerHour` and `tokenBinding: PAT_<UPPER>`.
   Signing keys need no configuration; the broker Keyring generates them.
5. **PAT plumbing** (the only per-agent secret): add the `secrets_store_secrets` binding
   `{ binding: PAT_<UPPER>, secret_name: github-pat-$0 }` in `workers/github-broker/wrangler.jsonc`;
   add `"$0"` to `agents` in `infra/terraform/envs/prod/prod.tfvars.example`; add
   `PAT_<UPPER>: ${{ secrets.PAT_<UPPER> }}` to the "Sync agent PATs" step in
   `.github/workflows/deploy-workers.yml`.
6. **Docs**: `docs/agents/$0.md` from the template in `docs/agents/README.md`: purpose, mode,
   inputs, actions, PAT scopes (fine-grained: only the repos and permissions the actions need),
   failure modes, how to halt.
7. **Threat model**: run `/threat-model $0` and paste the result into the docs page.
8. **Evals**: `evals/agents/$0/` with at least 5 behaviour cases and 5 injection cases reusing
   `evals/injection/corpus.yaml`.
9. **Tests**: `workers/agents/test/$0.test.ts` covering: halted → no action; model output that fails
   the schema → no action; happy path → `act()` called with the expected `BrokerAction`
   (mock `env.BROKER.fetch`).
10. Run `pnpm typecheck && pnpm test`, then `git status` and list every file touched.

Finish by printing the operator checklist: create the fine-grained PAT on GitHub and paste it into
the `prod` environment secret `PAT_<UPPER>` (nothing else to store), add a **test repository** you
own to the agent's `repos` first, merge so CI deploys and syncs the PAT, run `custodes agents run $0` against the test repo and
`custodes audit list --agent $0`. Widen `repos` to the real repository in a later, reviewed PR.
