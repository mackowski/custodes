# Agent cutover: moving an agent to its own Worker

ADR 0018, issue #103. Moves an agent's Durable Object classes, with their stored state, from
`custodes-agents` to the agent's own Worker. That Worker then signs every broker call with its own
key. **After step 2 of the workflow there is no rollback**, so each gate below must pass. One agent at
a time: finish its follow-up PR before the next cutover.

| Agent (`agent` input) | Worker                       | Classes                 | Halt ids            | Queue                                |
| --------------------- | ---------------------------- | ----------------------- | ------------------- | ------------------------------------ |
| `pr-gate`             | `custodes-pr-gate`           | `PrGateAgent`           | `pr-gate`           | `custodes-inbound-pr-gate`           |
| `cheatsheet-review`   | `custodes-cheatsheet-review` | `CheatsheetReviewAgent` | `cheatsheet-review` | `custodes-inbound-cheatsheet-review` |

The table mirrors `MOVES` in `scripts/agent-cutover-config.ts`, which the workflow and the deploy
guard read.

## Before PR #106 is marked ready

**Transfer rehearsal.** Run [scripts/do-transfer-test](../../scripts/do-transfer-test/README.md).
It covers both one-way steps: the `migrations` to `exports` switch that ships with the merge of #106,
and the transfer itself. All pass criteria must hold. If any fails, do not merge #106 as it is.

## Before a cutover (after #106 is merged and deployed)

1. **Nothing else merges to main from here until this agent's follow-up PR.** `deploy-workers.yml`
   refuses to deploy `custodes-agents` while it still declares a class another Worker owns, so a merge
   would stop every fleet deploy until the follow-up lands.
2. **Queue exists.** `deploy-infra.yml` applied the agent's queue and its DLQ (Cloudflare dashboard →
   Queues).
3. **Halt every id in the move** and say why: `POST /admin/agents/<id>/halt` with
   `{"reason":"cutover to <Worker>"}`. The workflow refuses to run otherwise.
4. **Reject the agent's pending approvals** (`/admin/approvals`). They were created through the shared
   Worker, and an approval is not checked against `isolated` when decided.
5. **Back up what cannot be rebuilt.**
   - pr-gate: `GET /agents/pr-gate-agent/owasp-cheatsheetseries/comparisons` (Clef vs Jev data, ADR 0015) saved to a file.
   - cheatsheet-review: nothing (each review is started again by the label).

## Cutover

Run **Actions → Agent cutover** from `main` with the agent, `move <agent>` and phase `full`. It checks
that every id in the move is halted and every class still belongs to `custodes-agents` (it never runs
twice), then:

1. deploys the agent's Worker with its classes as `expecting-transfer` (no class bindings, no crons,
   no queue) and its secrets;
2. deploys `custodes-agents` with those classes `transferred` and their bindings removed: **the
   namespaces and their data move here; no rollback after this**;
3. deploys the agent's Worker as committed (bindings, crons, queue consumer).

If a step fails:

- **Step 1:** nothing has moved. Fix the cause and re-run the workflow.
- **Step 2:** the transfer did not commit (the source still owns the classes). Re-run the workflow.
- **Step 3:** the transfer has committed, but the target is not bound yet. Re-run with phase
  `final-only`: it checks that the classes now belong to the agent's Worker and runs step 3 only.

## After

The agent is still halted. On its first broker call its Keyholder creates a key, and the broker
refuses it (`broker.caller.refused`, `unknown_key`) until it is pinned.

1. Read the key: the Worker logs `keyholder.key.created` with its `kid` and public `x` when it
   creates the key (Workers Logs of that Worker; public data only).
2. Open and merge the follow-up PR, by hand (the **Agent key pin** workflow can only read keys once the
   gateway binds the Worker, which is part of this PR). It contains:
   - the public key in `packages/schema/src/agent-keys.json` (check `kid` and `x` against the log);
   - the classes as `transferred` in `workers/agents/wrangler.jsonc`, and the agent removed from the
     shared Worker's code;
   - the agent's Worker in `deploy-workers.yml`, after the broker and the agents, with its secrets
     and the same guard (`<Class> --guard workers/<agent> <Worker>`);
   - the gateway: the agent's webhook events to its queue, `/agents/<agent>-agent/*` routed to its
     Worker, and its `KeyAdmin` bound as `KEYS_<AGENT>` (only the gateway may bind it,
     `bindings.test.ts`);
   - `isolated: true` for the agent's ids in `policy.json`.
3. After its deploy: a sandbox run (`POST /agents/<agent>-agent/custodes-sandbox/run`, or the trigger
   label for cheatsheet-review). The audit record must show `agentSignature: valid` on `/verify/<id>`.
4. Resume the agent.

## If something is wrong after the move

- Halt the agent (the kill switch still works: the broker checks it on every call).
- The data is in the agent's Worker; there is no automatic way back. Moving it back is another
  transfer in the other direction (same procedure, roles swapped), which needs its own rehearsal.
