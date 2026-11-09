# 0018. One Worker per agent and agent-held signing keys

- Status: proposed
- Date: 2026-11-09
- Deciders: Jakub Maćkowski

## Context

All agents run in one Worker, `custodes-agents`, with one `BROKER` service binding to the broker's
default entrypoint. The broker trusts the `agentId` field in each request and holds every agent's
signing key in its `Keyring` (ADR 0003). Prompt injection cannot change `agentId`
(`CustodesAgent` sets it from `this.manifest.id`), but any code in that Worker, whether a bug or a
malicious dependency, can act as any agent. ADR 0002 recorded this ("agents in one Worker still
share a trust domain") and kept one Worker per agent as the escalation path. Today that means:

- `pr-gate` is `hotl`: such code can close OWASP pull requests as `pr-gate` up to the broker's
  5 per hour. The 10-per-day cap lives in the agent, so it does not apply.
- Such code can create approvals as `cheatsheet-review` with arbitrary review text, supersede a real
  pending approval, or fill the 20-pending cap.
- Every agent can read `AI_GATEWAY_TOKEN` and `OPENROUTER_API_KEY`.

The operator's requirement (issue #103): agents must not be able to impersonate each other. Each
agent holds its own key, and only the operator and the broker verify who did what.

Facts checked on 2026-11-09:

- A queue has one consumer.
- Durable Object classes move between Workers through the `exports` configuration (`transferred` /
  `expecting-transfer`, two deploys). The documentation does not state explicitly that SQLite data
  moves with the class.
- Service binding `props` are documented on the Context page but not in the Wrangler configuration
  reference, and are reported not to propagate in multi-process local development.
- Anyone with Editor or Admin on a Worker can read and write its Durable Objects' SQLite storage
  through Data Studio, and anyone who can deploy the Worker can read it in code.

## Decision

We will run each agent with write authority in its own Worker, identify callers by binding, and
have each agent sign its own requests with a key only its Worker holds.

- **Workers.** `custodes-pr-gate`, `custodes-cheatsheet-review` and `custodes-triage`. The last one
  holds triage and its two read-only specialists, which have no write authority. Each Worker gets
  only the bindings and secrets its agent needs; for example, `OPENROUTER_API_KEY` goes only to
  `pr-gate`.
- **Caller identity.** The broker exports one `WorkerEntrypoint` per agent Worker with the allowed
  agent ids fixed in code, and refuses a request whose `agentId` is not one of them. A CI test
  asserts that each agent Worker's `wrangler.jsonc` binds only its own entrypoint.
- **Agent signature.** One `keyholder` Durable Object per agent Worker generates an Ed25519 key pair
  and keeps the private key in its storage. It signs every broker call (`/v1/act`, `/v1/read`,
  `/v1/state`, `/v1/approvals`) over a version tag (`custodes-request-v1`), the audience, the method, the path, a timestamp, a nonce and
  the SHA-256 of the exact body bytes. The broker verifies the signature against the public keys
  pinned for that agent Worker and refuses a timestamp outside 5 minutes or a nonce it has seen
  (nonces kept in D1 for twice the window plus a minute). The schema refuses weak public keys
  (small-order or non-canonical Ed25519 points, which would accept forged signatures).
- **Countersignature.** The broker keeps signing its audit record with its own `Keyring` key. The
  record now carries both signatures: the agent's (intent) and the broker's (execution under the
  policy). `/verify` and the CLI check both, and comment trailers are unchanged.
- **Pinning.** Public keys live in `workers/github-broker/policy/agent-keys.json`. The file is
  validated by a schema and changed only by a reviewed pull request. Rotating a key does not widen
  authority, so invariant 4 (ADR or issue for policy widening) does not apply to it. Up to two keys
  per agent may be pinned during a rotation.
- **Rotation and loss, without the CLI.**
  - An Access-protected page `/admin/keys` shows each agent's active and pinned key fingerprints and
    has a Rotate button. Only approvers can use it, through a POST with the same CSRF guard as
    approvals.
  - A GitHub Actions workflow reads the new public key with the read-only Access service token and
    opens the pinning pull request.
  - When the broker refuses an unknown key, the operator gets an e-mail linking to both. The agent
    stays stopped until the pull request is merged.
- **Transition.** An `isolated: true` flag in the agent's policy makes the default entrypoint refuse
  that agent and its own entrypoint require a signature. The default entrypoint is removed after the
  last migration. Each agent is protected from its own migration on. Setting `isolated` back from
  `true` to `false` reopens the unsigned path for that agent: it is a policy widening and needs a
  linked ADR or issue (invariant 4).
- **Kill switch out of agent reach.** Agent Workers no longer bind the `KILL_SWITCH` KV namespace.
  A KV binding can write, so today any agent code can delete a halt key and resume itself. `guard()`
  asks the broker for the halt state through a signed call, and only the broker and the gateway
  bind the namespace. This can ship first, in the current single Worker.
- **Webhooks.** The gateway publishes each verified event to the owning agent's queue (one queue and
  dead-letter queue per agent), taking over the routing in `workers/agents/src/dispatch.ts`.
- **State.** We first test an `exports` transfer on throwaway Workers. If the SQLite data moves, we
  transfer each class. If it does not, the agent starts fresh, after `pr-gate`'s `model_comparisons`
  is exported to D1.
- **Cutover.** Halt the agent, deploy, run it on the sandbox, resume. Order: `pr-gate`,
  `cheatsheet-review`, triage. The `hello` smoke-test agent is removed, not moved.

## Alternatives considered

- **Keep one Worker and trust `agentId`:** this is the impersonation we are removing.
- **Service binding `props` as identity:** missing from the Wrangler configuration reference and
  reportedly broken in local development; one entrypoint per agent is explicit and testable.
- **Per-agent keys held by the broker (today):** they sign the audit record but do not
  authenticate the caller, and the broker could sign as any agent.
- **A key wrapped with a Secrets Store key:** a Data Studio reader would see only ciphertext, but
  whoever can deploy the Worker can read both secrets, and it adds one generated secret per agent.
- **A separate signing Worker:** it has to identify its caller, which is the problem the binding
  already solves.
- **Three Workers for triage and its specialists:** they have no write authority, and calling
  Durable Objects across Workers is less documented.
- **A shared webhook dispatcher Worker:** a new component that can wake every agent.
- **Public keys in `policy.json`:** every rotation would need an ADR or issue.
- **Rotation through the `custodes` CLI, or a public key sent by e-mail:** the operator does not use
  the CLI, and an e-mailed key is a weaker channel. Pinning a substituted key accepts an attacker.

## Consequences

- Code in one agent's Worker can no longer act as another agent, read its key, or use its secrets.
- More Workers to deploy and develop locally: `deploy-workers.yml`, `pnpm dev` and the test pools
  grow, and the gateway routes `/agents/*` and the registry per Worker.
- Every broker call costs a signature and a verification plus a D1 nonce write.
- A lost key stops the agent until a pull request is merged (fail closed).
- A migration is a halt, two deploys and a sandbox run per agent. Agent state may be reset if the
  transfer does not carry data.
- ADR 0002's escalation path becomes the default for agents with write authority. ADR 0003's
  broker-held keys remain, as the countersignature only.

## Security considerations

- **Authority.** The broker still enforces the policy, kill switch, approvals and rate limits
  (ADR 0002). It now also authenticates the calling Worker by entrypoint and the agent by signature.
  A compromised agent Worker can act only as that agent, within its policy.
- **What it does not cover.** Everyone who can deploy a Worker, or holds Editor or Admin on it, can
  read that agent's key. Today that is the operator and CI. Restricting those roles to the operator
  is an operator step in the dashboard or Terraform, not a session change (invariant 5). The deploy
  pipeline remains the root of trust, as it already is for the broker's PATs. Shared dependencies
  ship in every Worker, so a compromised common package still reaches every agent at once (#105).
  The gateway remains the only holder of `BrokerAdmin` (#104).
- **Replay.** Signed requests carry a timestamp and a nonce. The broker refuses repeats within the
  window and anything outside it.
- **Auditability.** Each audit record carries the agent's signature and the broker's. Neither party
  can claim an action alone: the broker cannot forge the agent's intent, and the agent cannot
  forge the broker's execution.
- **Secrets.** Agent private keys are generated inside the agent's Worker and never written to a
  file, CI or the repository. Only public keys are committed.
