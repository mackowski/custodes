# pr-gate cutover: moving PrGateAgent to its own Worker

ADR 0018, issue #103. Moves the `PrGateAgent` Durable Object, with its stored state, from
`custodes-agents` to `custodes-pr-gate`. The Worker then signs every broker call with its own key.
**After step 3 of the workflow there is no rollback**, so each gate below must pass.

## Before (once PR #106 is merged and deployed)

1. **Transfer test.** Run [scripts/do-transfer-test](../../scripts/do-transfer-test/README.md). All
   four pass criteria must hold. If any fails, stop here: pr-gate keeps running in `custodes-agents`.
2. **Queue exists.** `deploy-infra.yml` applied `custodes-inbound-pr-gate` and its DLQ (Cloudflare
   dashboard → Queues).
3. **Halt pr-gate** and say why: `POST /admin/agents/pr-gate/halt` with
   `{"reason":"cutover to custodes-pr-gate"}` (or the CLI). The workflow refuses to run otherwise.
4. **Reject pending pr-gate approvals** (`/admin/approvals`). They were created through the shared
   Worker, and an approval is not checked against `isolated` when decided.
5. **Back up `model_comparisons`** (Clef vs Jev data, ADR 0015): `GET
/agents/pr-gate-agent/owasp-cheatsheetseries/comparisons` saved to a file. The transfer should keep
   it; this is the fallback.

## Cutover

Run **Actions → pr-gate cutover** from `main` with `move PrGateAgent`. It checks the halt flag, then:

1. deploys `custodes-pr-gate` with `PrGateAgent` as `expecting-transfer` (no binding, no crons, no
   queue) and its secrets;
2. deploys `custodes-agents` with `PrGateAgent` `transferred` and its binding removed: **the
   namespace and its data move here; no rollback after this**;
3. deploys `custodes-pr-gate` as committed (binding, crons, queue consumer).

If a step fails:

- **Step 1:** nothing has moved. Fix the cause and re-run the workflow.
- **Step 2:** the transfer did not commit (the source still owns the class). Re-run the workflow.
- **Step 3:** the transfer has committed, but the target is not bound yet. Do not re-run the whole
  workflow (step 1 would fail now). Re-run only the final deploy: dispatch **Deploy Workers** after
  the follow-up PR, or ask for a one-off CI run of `wrangler deploy -c ../pr-gate/.cutover.target-final.json`.

## After

pr-gate is still halted. On its first broker call (the next cron or a manual run) its Keyholder
creates a key, and the broker refuses it (`broker.caller.refused`, `unknown_key`) until it is pinned.

1. Open `/admin/keys`, note the `custodes-pr-gate` key fingerprint.
2. Merge the follow-up PR the key workflow opens. It contains:
   - the public key in `packages/schema/src/agent-keys.json` (check the fingerprint matches);
   - `PrGateAgent: transferred` in `workers/agents/wrangler.jsonc` and pr-gate removed from the
     shared Worker's code;
   - pr-gate in `deploy-workers.yml`;
   - the gateway sending pr-gate's webhook events to `custodes-inbound-pr-gate`;
   - `isolated: true` for pr-gate in `policy.json`.
3. After its deploy: `GET /agents/pr-gate-agent/custodes-sandbox/report`, then a sandbox run
   (`POST /agents/pr-gate-agent/custodes-sandbox/run`). The audit record must show
   `agentSignature: valid` on `/verify/<id>`.
4. Resume pr-gate.

## If something is wrong after the move

- Halt pr-gate (the kill switch still works: the broker checks it on every call).
- The data is in `custodes-pr-gate`; there is no automatic way back. Moving it back is another
  transfer in the other direction (same procedure, roles swapped), which needs its own test.
