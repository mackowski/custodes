# Agent cutover: moving an agent to its own Worker

ADR 0018, issue #103. Moves an agent's Durable Object classes, with their stored state, from
`custodes-agents` to the agent's own Worker. That Worker then signs every broker call with its own
key. **After step 2 of the workflow there is no rollback**, so each gate below must pass. One agent at
a time: finish its follow-up PR before the next cutover.

| Agent (`agent` input) | Worker                       | Classes                                                          | Halt ids                                            | Queue                                |
| --------------------- | ---------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------ |
| `pr-gate`             | `custodes-pr-gate`           | `PrGateAgent`                                                    | `pr-gate`                                           | `custodes-inbound-pr-gate`           |
| `cheatsheet-review`   | `custodes-cheatsheet-review` | `CheatsheetReviewAgent`                                          | `cheatsheet-review`                                 | `custodes-inbound-cheatsheet-review` |
| `triage`              | `custodes-triage`            | `TriageAgent`, `ImplementationCheckAgent`, `ProposalReviewAgent` | `triage`, `implementation-check`, `proposal-review` | none (crons only)                    |

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
   - triage: nothing (assessments and specialist results are rebuilt by the next poll and prepare;
     the next digest may repeat items once).

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

The agent is still halted. It stays unable to act, and reads as halted even after you resume it,
until its key is pinned: its `/v1/state` call is signed with a key the broker does not know yet, so
the broker refuses it (`broker.caller.refused`, `unknown_key`) and `guard()` fails closed. Until then
the Keyholder logs one refusal per guarded call (a few a day, from the crons).

Do it in this order (done for triage on 2026-11-12/13, PR #111, and for pr-gate on 2026-11-13,
PRs #114 and #115):

1. **Follow-up PR, by hand, without the key.** The **Agent key pin** workflow can only read keys once
   the gateway binds the Worker, which is part of this PR. It contains:
   - the classes as `transferred` in `workers/agents/wrangler.jsonc`, with their bindings removed
     (the code can keep exporting them, see "Clean-up PR" below);
   - the agent's Worker in `deploy-workers.yml`, after the broker and the agents, with its secrets.
     The deploy guard needs no edit: it reads `scripts/agent-moves.json` and checks every finished
     move (`agent-cutover-config.ts moved`);
   - the gateway: the agent's webhook events to its queue, `/agents/<agent>-agent/*` routed to its
     Worker (`agentWorker` in `workers/gateway/src/index.ts`, with a case in its test), and its
     `KeyAdmin` bound as `KEYS_<AGENT>` (only the gateway may bind it, `bindings.test.ts`);
   - `isolated: true` for the agent's ids in `policy.json` (`cutover-moves.test.ts` fails if a
     finished move forgets one);
   - `AgentsEnv` types and the test bindings in `workers/agents/vitest.config.ts`;
   - for cheatsheet-review, which has no poll to catch up: the gateway must fail the delivery when
     its queue send fails (GitHub then shows the delivery as failed and it can be redelivered);
     the other queues are best effort;
   - the agent's secrets set with `wrangler secret put -c <its config>` in its deploy step, never
     wrangler-action `secrets:` (it ignores `-c` and writes to custodes-agents);
   - a step that deletes from custodes-agents any secret only the moved agent used (deploys never
     delete Worker secrets), and comments marking its now unused vars there;
   - the moved agent's docs (its knobs now live in its own wrangler file) and the Workers listed
     in `docs/runbooks/agent-traces.md`.

   Merge it and approve **Deploy Workers** in `prod`.

2. **Create the key.** Either **Rotate** the Worker on `/admin/agent-keys/page` (creates a `next`
   key; the Worker adopts it once the broker accepts it) or let its first broker call create it.
   The Worker logs `keyholder.key.created` with its `kid` and public `x` (Workers Logs of that
   Worker; public data only).
3. **Pin it.** Run **Agent key pin** (`gh workflow run agent-key-pin.yml --ref main`). It pushes a
   branch; open the PR, compare `kid` and `x` with the log, merge, and approve Deploy Workers again.
4. **Resume every id of the move**, so the run below can do anything (a halted agent stops at
   `guard()` before its first read). Use `custodes agents resume <id>` or
   `POST /admin/agents/<id>/resume`, once per id (for triage: `triage`, `implementation-check`,
   `proposal-review`), not by deleting the `halt:*` keys in KV: the admin route logs who resumed
   (`admin.resume`). Without the CLI, from the browser console on `https://custodes.work/admin/agents`:

   ```js
   for (const id of ['triage', 'implementation-check', 'proposal-review'])
     console.log(id, await (await fetch(`/admin/agents/${id}/resume`, { method: 'POST' })).json());
   ```

5. **Verify with a sandbox run** (`POST /agents/<agent>-agent/custodes-sandbox/run`, or the trigger
   label for cheatsheet-review). If the check fails, halt the ids again.
   - an agent that acts (pr-gate, cheatsheet-review): the audit record shows
     `agentSignature: valid` on `/verify/<id>`;
   - a read-only agent (triage and its specialists): reads leave no audit record. Check the
     broker's Workers Logs instead: `broker.read` lines for the agent ids, and no
     `broker.caller.refused` for the Worker.

### Clean-up PR (later)

The shared Worker still exports the moved classes next to their `transferred` tombstones, which
Cloudflare supports for zero-downtime transfers. Once the agent runs fine, a later PR removes:

- the class exports from `workers/agents/src/index.ts` and, for triage, the `hasTriage` branch and
  the cron job in `crons`/`scheduled`;
- the test-only `durableObjects` in `workers/agents/vitest.config.ts` (the classes then need another
  test home) and the `AgentsEnv` entries, which today are required although the shared Worker has no
  such binding (code there checks first; a missing check fails closed, as an outage);
- the `transferred` entries, once Cloudflare reports them stale (check that dropping a tombstone is
  allowed before removing it).
- after the last cutover (cheatsheet-review), what custodes-agents keeps only for the generated
  types: the shared crons, the `custodes-inbound` queue (consumer here, `INBOUND` producer in the
  gateway), the `AI` and `send_email` bindings, the unsigned default `BROKER` binding, every var, and
  the `hasTriage`/`hasPrGate`/`hasCheatsheetReview` branches. The gateway can then answer 404 for an
  unknown `/agents/<class>` instead of falling back to `AGENTS`. Then decide whether the Worker stays at all (the gateway's `AGENTS` binding still serves
  `/registry`).

## If something is wrong after the move

- Halt the agent (the kill switch still works: the broker checks it on every call).
- The data is in the agent's Worker; there is no automatic way back. Moving it back is another
  transfer in the other direction (same procedure, roles swapped), which needs its own rehearsal.
