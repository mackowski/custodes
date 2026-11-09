# Threat model: agent isolation (ADR 0018)

Status: proposed, for [ADR 0018](adr/0018-one-worker-per-agent-and-agent-held-signing-keys.md)
(issue #103, PR #106). It covers what changes in the system model ([threat-model.md](threat-model.md)).
After the change ships, it is folded into that file.

## 1. Scope and assets

**Components:**

- `custodes-pr-gate`, `custodes-cheatsheet-review`, `custodes-triage` (triage plus two read-only
  specialists): one Worker per agent, each with a `keyholder` Durable Object.
- The broker's per-agent entrypoints, signature and nonce check, and `isolated` flag.
- `packages/schema/src/agent-keys.json` (built into the broker and the gateway).
- The gateway's `/admin/keys` page and per-agent queues.
- The rotation workflow.

**Assets:**

- **Agent private keys:** they authorise requests in the agent's name.
- **The pinned public key set:** whoever can add a key can authorise for that agent, provided they
  also hold the binding.
- **Broker authority:** PATs, policy and audit, as before.
- **Kill switch state.**
- **Audit integrity:** the agent's signature over intent plus the broker's countersignature over
  execution.

**Who trusts the output:**

- Contributors and maintainers trust that a close or review came from the named agent under policy.
- The operator trusts the audit log and `/verify`.
- The public trusts the trailers on OWASP comments.

## 2. Trust boundaries and data flows

```
GitHub webhook ─HMAC─► gateway ─► queue per agent ─► agent Worker (consumer of its own queue only)
agent code ─► keyholder DO.sign(canonical request + path + ts + nonce)
agent Worker ─BROKER binding (own entrypoint)─► broker: entrypoint→allowed ids → signature vs agent-keys.json
             → ts window + nonce (D1) → policy → kill switch → approval → rate limit → execute → audit (+ countersign)
operator ─Access─► gateway /admin/keys ─► agent Worker keyholder.rotate()  (per-agent binding)
GitHub Actions (service token, read) ─► gateway /admin/keys (public keys) ─► opens pinning PR ─► operator merges ─► CI deploys broker
```

**New boundaries:**

- Agent Worker to agent Worker: none. They share no binding.
- Agent Worker to broker: authenticated by entrypoint and by signature.
- Rotation workflow to repository: a PR, reviewed by the operator.

**Unchanged:**

- Untrusted text still enters the agents only (issue and PR bodies, comments, diffs, webhook
  fields, model output).
- Authority is still exercised only in the broker.

## 3. STRIDE

| #   | Threat                                                                                                                                                                                                        | L   | I   | Existing control                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Gap and smallest fix                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | Code in one agent Worker acts as another agent.                                                                                                                                                               | M   | H   | Before ADR 0018 none (the default entrypoint trusts `agentId`). Now: per-Worker entrypoints with signature and admit checks (step 1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Closed by the design: one entrypoint per agent with the allowed ids fixed in code, plus a signature by a key only that Worker holds. Add a CI test that parses every `wrangler.jsonc` and asserts that each agent Worker binds only its own broker entrypoint and nothing binds another's. |
| S2  | Signed request replayed (same body sent again).                                                                                                                                                               | L   | M   | Done in step 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Timestamp ±5 min, nonce unique in D1 (`AUDIT`) for the window, rows deleted after twice the window plus a minute (11 min).                                                                                                                                                                 |
| S3  | Signature reused across endpoints (a signed `/v1/read` body sent to `/v1/act`), or a signed approval body reused as an action.                                                                                | L   | M   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The signed payload includes the path and an audience string (`custodes-github-broker`), not only the body.                                                                                                                                                                                 |
| S4  | A key is pinned for the wrong agent: a compromised gateway returns its own public key to the rotation workflow, which opens a PR.                                                                             | L   | M   | PR review; the key alone is useless without the agent's broker entrypoint, which only that agent's Worker binds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The workflow writes the fingerprint into the PR body, and `/admin/keys` shows it too. Both pass through the gateway (#104), so the binding is the second factor. Accepted with #104.                                                                                                       |
| S5  | Someone with Editor/Admin on an agent Worker reads the key through Data Studio, or the CI deploy token deploys code that reads it. `CLOUDFLARE_API_TOKEN_DEPLOY` deploys every Worker (`deploy-workers.yml`). | L   | H   | Protected `environment` in `deploy-workers.yml`; Data Studio queries are audited. The broker's own `Keyring` already stores extractable JWKs the same way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Operator step: Editor/Admin on agent Workers for the operator only. Follow-up: one deploy token per Worker (granular Worker permissions). The deploy pipeline remains the root of trust, as it already is for PATs. Accepted.                                                              |
| T1  | **A compromised agent Worker un-halts itself or halts others:** it binds `KILL_SWITCH` KV (`workers/agents/wrangler.jsonc:66`), and KV bindings can write (`KillSwitch.resume` deletes the halt key).         | M   | H   | None. The broker reads the same KV.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **Required:** agent Workers do not bind `KILL_SWITCH`. `guard()` asks the broker through a signed `/v1/state` call, and only the broker and gateway bind the KV. This also fixes the problem in today's single Worker.                                                                     |
| T2  | Default entrypoint still serves a migrated agent during the transition.                                                                                                                                       | M   | H   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `isolated: true` in the policy makes the default entrypoint refuse that agent for `/v1/act`, `/v1/read` (reads policy) and `/v1/approvals`. Test all three.                                                                                                                                |
| T3  | DO transfer loses or corrupts state: `pr-gate` caps and decisions reset, `model_comparisons` lost.                                                                                                            | M   | L   | Broker rate limit (5/h) independent of agent state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Test on throwaway Workers first; save `model_comparisons` to a file (`GET .../comparisons`) before the cutover; halt during the cutover. A reset daily cap allows at most 10 extra closes that day. Accepted.                                                                              |
| T4  | Two copies of an agent run at once during the cutover (old and new Worker): double closes.                                                                                                                    | M   | M   | Kill switch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Halt before the deploy. The old Worker's crons and queue consumer are removed in the same deploy. Resume after the sandbox run.                                                                                                                                                            |
| R1  | Nobody can tell who authored a broker action, or the broker denies an action it executed.                                                                                                                     | L   | M   | Done: `AuditRecord.callerSignature` (agent signature over the canonical request); `verifyCallerIntent` rebuilds the request, compares the hash and checks ts, hosted agent id and that `githubUrl` is exactly the named issue or pull request (anchored, case-insensitive; a repository rename makes new records inconsistent); the gateway's `/verify` uses the committed keys (active + `retired`) and checks the record id. Not covered: decision, reason, repeated execution (broker-asserted); approval-run and shared-Worker records (`none`). The CLI `audit verify` still checks only the broker signature (the operator does not use it); follow-up. | Store the agent's signature, key id and signed payload hash in the audit record. `/verify/:id` and the CLI check both signatures against `agent-keys.json` (retired keys kept).                                                                                                            |
| I1  | A private key leaks through logs, trace spans or errors.                                                                                                                                                      | L   | H   | Done (step 3): `Keyholder` exposes exactly `signRequest`, `publicKeys`, `rotate`, `activateNextIfAccepted` (pinned by a test on its prototype); the Agents SDK router cannot reach it (`AGENT_CLASSES`); canary tests check the active and the next key against every output and error. Deleting a key removes it from current storage only: a point-in-time restore of the object could bring it back (same actors as S5), so a compromised key is removed from `agent-keys.json`, not only rotated out.                                                                                                                                                     | `keyholder` never returns the private key over RPC (only `sign`, `publicKey`, `rotate`). Extend the canary test to the key material. No span carries it.                                                                                                                                   |
| I2  | Rotation workflow or `/admin/keys` leaks something private.                                                                                                                                                   | L   | L   | Service token is read-only (`adminWriteAllowed`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The page and endpoint expose public keys and fingerprints only.                                                                                                                                                                                                                            |
| D1  | Rotate pressed by mistake, or by a rogue gateway: the agent stops until the PR is merged.                                                                                                                     | L   | M   | Done (step 3): `rotate` adds a next key while the active one keeps signing; the agent switches only after a signed `/v1/state` with the next key returns 200 (`activateNextIfAccepted`, run in `guard()`), so no route can stop it by activating an unpinned key. Generation runs under `blockConcurrencyWhile`. A rogue Rotate press only creates a pending key.                                                                                                                                                                                                                                                                                             | Keep the old key valid until the new one is pinned (two pinned keys). Rotation creates a pending key, and the agent switches only when the broker accepts it. Fail closed only on loss.                                                                                                    |
| D2  | Nonce writes or signature checks fail (D1 outage), so every agent stops.                                                                                                                                      | L   | M   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Fail closed (refuse). The agent records a failure and retries on its next poll. Accepted.                                                                                                                                                                                                  |
| D3  | A queue for one agent fills or its DLQ grows.                                                                                                                                                                 | L   | L   | DLQ per queue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Only that agent is affected. Same handling as today.                                                                                                                                                                                                                                       |
| E1  | A shared dependency compromised in every Worker signs as every agent.                                                                                                                                         | L   | H   | Pins, `minimumReleaseAge`, dependency review.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Not covered by this design (#105). Accepted.                                                                                                                                                                                                                                               |
| E2  | The per-Worker secrets differ but `AI_GATEWAY_TOKEN` is shared: a compromised Worker spends model budget as all agents.                                                                                       | M   | L   | AI Gateway spend and rate limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Follow-up: one AI Gateway token per agent Worker, for attribution and revocation.                                                                                                                                                                                                          |

## 4. LLM-specific (OWASP Top 10 for LLM Applications)

- **LLM01 prompt injection:** unchanged surface. Injection never controlled `agentId` (set from
  `this.manifest.id`), and it cannot reach `keyholder`: model output is never passed to it, and it
  signs whatever its own agent's code asks. A signature is not an authorisation. An injected request
  the agent's code builds is still bounded by the policy, approvals and the existing `untrusted()`
  and `parseStructured()` controls.
- **LLM02 insecure output handling:** unchanged. `/admin/keys` renders only public keys and
  fingerprints, escaped.
- **LLM06 excessive agency:** narrows. Each Worker gets only its own bindings and secrets.
  `OPENROUTER_API_KEY` goes to `pr-gate` alone, and the kill switch KV goes to no agent (T1).
- **LLM02/LLM07 sensitive information disclosure:** a new secret class (agent private keys). It
  lives only in `keyholder` storage, is never in RPC results, logs or spans (I1), and is readable by
  Worker Editors/Admins and deployers (S5).
- **LLM03 supply chain:** shared dependencies are still in every Worker (E1, #105). Isolation helps
  only against code that is in one Worker.
- **LLM09 misinformation:** not affected.
- **LLM10 unbounded consumption:** each Worker keeps its own crons and queue. One extra signature
  and D1 write per broker call.

## 5. Abuse cases

1. **A malicious package update lands only in `custodes-cheatsheet-review`** (it is the only
   Worker that bundles it) and tries to close OWASP PRs as `pr-gate`. Its binding reaches only the
   `CheatsheetReviewBroker` entrypoint, which refuses `agentId: pr-gate`, and its key is not pinned for
   `pr-gate`. It can act only as `cheatsheet-review`, and on OWASP every review still needs the
   operator's click.
2. **The operator halts `pr-gate` after a wrong close; compromised code in `pr-gate`'s Worker
   deletes the halt key from KV and keeps closing.** Today this works. With T1 fixed the Worker
   has no KV binding, and the broker reads the halt state itself before every action.
3. **Captured signed request.** A request body logged by mistake (or seen in a trace) is sent again
   to the broker. The nonce was already used and the timestamp is stale, so it is refused.
4. **Rogue rotation.** A compromised gateway presses Rotate and returns its own public key to the
   workflow, which opens a pinning PR. If the operator merges it without comparing fingerprints,
   the gateway holds a pinned key for `pr-gate`, but it binds only `BrokerAdmin`, not the
   `PrGateBroker` entrypoint, so the key authorises nothing. The real agent keeps working on its old key
   until the operator notices the mismatch.
5. **A sneaky config change.** A PR changes `custodes-triage`'s `wrangler.jsonc` to bind the
   `PrGateBroker` entrypoint. The CI binding test fails, and the broker policy change it would also need is
   CODEOWNERS-reviewed.

## 6. Required changes before merge

1. Per-agent broker entrypoints with fixed allowed ids, and a CI test over all `wrangler.jsonc`
   files (S1, abuse case 5).
2. Signature over audience + method + path + timestamp + nonce + SHA-256 of the exact body bytes.
   Nonce table in D1, kept for twice the window plus a minute. Weak (small-order, non-canonical)
   public keys refused by the schema and again at verification. Tests: missing, wrong key, another
   agent's key, stale, replayed, other path, every small-order key (S1–S3). The query string and other
   headers are not signed: no route reads them, and a route that does must extend the signature.
3. **Remove the `KILL_SWITCH` binding from agent Workers.** `guard()` uses a signed broker call,
   and only the broker and gateway bind the KV (T1). This can ship first, in the current single
   Worker.
4. `isolated: true` honoured on the default entrypoint for act, read, state and approvals, for both
   `agents` and `reads` entries, with tests (T2). Refusals are logged (`broker.admit.refused`).
   Turning `isolated` back to `false` is a widening (invariant 4).
5. Done: audit record stores the agent signature; the gateway's `/verify` checks both signatures against committed keys (R1). Follow-ups: sign approval requests; CLI `audit verify`; report `missing` for an isolated agent's record without signature or approval.
6. Done: `keyholder` exposes only `signRequest`, `publicKeys`, `rotate`, `activateNextIfAccepted`; canary tests cover both keys (I1).
7. Done for the keyholder: rotation keeps the old key until the broker accepts the next one (D1). Page and workflow show
   fingerprints (S4).
8. Cutover runbook: halt, reject the agent's pending approvals (they were created through the
   shared Worker, where any code could have asked as this agent, and `isolated` is not checked when
   an approval is decided), export `model_comparisons`, deploy (old crons and consumer removed),
   sandbox run, resume (T3, T4).

## Accepted risks

| Risk                                                                                                                                                 | Owner    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S5: Worker Editors/Admins and the CI deploy token can read an agent key; restrict roles (operator step), per-Worker deploy tokens later.             | operator |
| S4: rotation PR and `/admin/keys` both pass through the gateway; the entrypoint binding is the second factor (#104).                                 | operator |
| E1: a compromised shared dependency signs as every agent (#105).                                                                                     | operator |
| E2: shared `AI_GATEWAY_TOKEN` until per-agent tokens exist.                                                                                          | operator |
| T3: agent state may reset if the DO transfer does not carry data.                                                                                    | operator |
| R1 limits: fields the agent does not sign (decision, reason, repeated execution) are broker-asserted; approval-run records carry no agent signature. | operator |
| D2: a D1 outage stops all broker calls (fail closed).                                                                                                | operator |
