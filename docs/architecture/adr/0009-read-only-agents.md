# 0009. Read-only agents

- Status: accepted
- Date: 2026-09-28
- Deciders: Jakub Maćkowski

## Context

The first useful agent only needs to read public repository data and report to the operator. Giving
it a PAT and a broker policy, even a narrow one, would add authority it never needs.

## Decision

We add a third agent mode, `readonly`. A read-only agent has no PAT and no policy entry. It reads
public data only through the broker's GET-only `/v1/read` endpoint and reports only to operators
(e-mail, Access-protected status). Three independent layers refuse side effects: `CustodesAgent.act()` throws
for read-only agents, the broker has no policy for them (`unknown_agent`), and `evaluatePolicy`
denies read-only agents even if a policy entry is added by mistake.

## Alternatives considered

- `hitl` with no allowed actions: works, but hides intent and still suggests a write path exists.
- Unauthenticated reads from the agent: tried first; Cloudflare Workers share egress IPs, and
  GitHub's 60 requests/hour per-IP budget was routinely exhausted by other tenants (403s on
  2026-09-29).

## Amendment (2026-09-29): reads go through the broker

Reads use `/v1/read`: `policy.json` `reads` allow-lists repositories per agent, the request names a
resource (`issues`, `labels`, `cheatsheets`) and a strictly typed query, and the broker builds the
URL and authenticates with `PAT_READONLY`, a fine-grained token scoped to public repositories with
no permissions. Agents still hold no credential and cannot form arbitrary GitHub paths.

## Consequences

Read-only agents can ship without any secret provisioning. Promoting one to act on GitHub is an
explicit mode change plus a policy entry in a reviewed PR (ADR 0007's promotion path).

## Security considerations

The e-mail binding stays restricted to operator addresses. Model output reaches a human only, after
schema validation, link stripping, and cross-checking against real repository data.
