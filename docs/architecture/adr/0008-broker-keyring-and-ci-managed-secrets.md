# 0008. Signing keys generated in the broker; all other secrets managed by CI

- Status: accepted (amends 0003)
- Date: 2026-09-25
- Deciders: Jakub Maćkowski

## Context

ADR 0003 stored one Ed25519 private key per agent in Secrets Store, generated offline by the
operator, next to the agent's GitHub PAT. Every new agent therefore needed two manual secret
steps, and every rotation another two. The operator does not want to create secrets by hand for
each agent.

## Decision

- **Signing keys** are generated inside the broker by a `Keyring` Durable Object on first use and
  never leave it. Callers send bytes and receive `{keyId, signature}`. Public keys, active and
  retired, are served at `/v1/keys`; rotation is `custodes keys rotate <agent>`. Retired keys stay
  published so historical attestations verify.
- **Worker secrets** (AI Gateway token, approval-token secret, webhook secret) are GitHub
  Environment secrets pushed into the Workers by the deploy workflow on every deploy.
- **Agent PATs** remain the one per-agent secret, because GitHub has no API to create them. Each is
  a GitHub Environment secret named `PAT_<AGENT>`; `scripts/sync-agent-secrets.sh` writes them into
  Secrets Store during deploy. Adding an agent is one paste; rotating is one paste and a re-run.

## Alternatives considered

- GitHub App identity: removes the per-agent PAT entirely (hourly installation tokens from one
  private key). Declined for now to keep distinct per-agent tokens; the `GitHubIdentity` interface
  keeps this open.
- Keys in Secrets Store written by CI: possible, but Workers cannot write Secrets Store, so
  generation would still happen outside the trust boundary that uses the key.

## Consequences

Zero manual steps for signing keys. One paste per agent for PATs. The broker is the sole custodian
of private keys, which matches its role as the sole executor of side effects.

## Security considerations

Durable Object storage is encrypted at rest and reachable only by the broker Worker, the same
trust boundary that previously read the keys from Secrets Store. Unknown agent ids never get a key,
so garbage requests cannot mint keys. Rotation is an Access-protected admin action and is logged.
