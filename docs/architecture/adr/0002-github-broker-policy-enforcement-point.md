# 0002. GitHub broker as the single policy enforcement point

- Status: accepted
- Date: 2026-09-25
- Deciders: Jakub Maćkowski

## Context

Agents consume untrusted text and call models whose output cannot be fully trusted. If an agent
held a GitHub token, a successful prompt injection or an ordinary bug could post anything anywhere
the token allows. Cloudflare bindings are Worker-wide, so co-locating tokens with agent code would
also let every agent read every other agent's token.

## Decision

We will route every GitHub side effect through a dedicated Worker, `workers/github-broker`, that
is not internet-reachable, holds all per-agent credentials, evaluates a committed policy
(agent → repos → actions), checks the kill switch and approvals, enforces rate limits, executes the
call, and writes a signed audit record for every request, allowed or denied.

## Alternatives considered

- Policy inside each agent: no isolation from the code being protected.
- One Worker per agent with its own token: better isolation, more operational overhead; we keep it
  as the escalation path for high-risk agents.

## Consequences

Adding a capability is deliberate: schema variant, broker case, policy entry, tests. Agents become
simpler because they only propose. One extra hop per action (service binding, sub-millisecond).

## Security considerations

The broker is the trusted computing base for authority. Changes to it and to `policy.json` require
CODEOWNERS review and a security review. Agents in one Worker still share a trust domain; the
broker bounds the damage to that Worker's union of permissions.
