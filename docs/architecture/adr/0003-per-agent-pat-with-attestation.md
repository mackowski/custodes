# 0003. Per-agent fine-grained PATs with signed attestations

- Status: accepted
- Date: 2026-09-25
- Deciders: Jakub Maćkowski

## Context

The operator wants each agent to authenticate separately so logging and "on behalf of" semantics
are clear, and wants agents to sign their work. A GitHub App would give distinct bot identities and
short-lived tokens, but requires installation on the target organisation. Fine-grained PATs are
available immediately but: all belong to the operator's account (GitHub shows every action as that
user), there is a cap of 50 per account, they expire and must be rotated, and the OWASP organisation
may block or gate them.

## Decision

We will start with one fine-grained PAT per agent, scoped to the minimum repositories and
permissions, stored in Cloudflare Secrets Store and readable only by the broker. Attribution is
provided by Custodes itself: the broker signs every audit record with a per-agent Ed25519 key and
appends `Custodes-Agent`, `Custodes-Attestation` and optional `On-Behalf-Of` trailers to every
comment. `GitHubIdentity` in `@custodes/github` abstracts the token source so moving an agent to
a GitHub App installation token is a configuration change.

## Alternatives considered

- GitHub App now: best identity model; blocked on org installation. Planned migration target.
- Commit signing with per-agent SSH keys: relevant once agents push commits; not needed for
  comments/labels. Commits created through the GraphQL `createCommitOnBranch` mutation are signed by
  GitHub, which gives a "Verified" badge but not agent-level provenance; the attestation log does.

## Consequences

Operators must create and rotate PATs (runbook). GitHub-side attribution is the operator; Custodes
attribution is authoritative and verifiable.

## Security considerations

A leaked PAT is a leaked slice of the operator's authority; scopes are minimal and the broker is the
only reader. Attestation private keys never leave the broker; public keys are served for verification.
