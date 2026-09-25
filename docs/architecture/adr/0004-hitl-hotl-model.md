# 0004. Human-in-the-loop and human-on-the-loop primitives

- Status: accepted
- Date: 2026-09-25
- Deciders: Jakub Maćkowski

## Context

Some tasks (labelling, thanking reporters) are safe to automate with oversight; others (reviews,
content changes) need a human decision each time.

## Decision

Two primitives, both enforced in the broker: **Approval** (a stored request bound to the exact
action hash, decided by a human via CLI or e-mail token, single-use, expiring) and **KillSwitch**
(a KV flag per agent or `*`, checked by agents before acting and by the broker before executing).
Agents declare `mode: hitl | hotl`; hitl agents need an approval for every action, hotl agents may
also list `requiresApproval` action types. Hotl agents send a digest e-mail to the operators configured in `APPROVER_EMAILS`; no contact
address lives in agent code.

## Alternatives considered

- Approval via GitHub reactions: convenient but spoofable by anyone with a GitHub account.
- Slack: a future channel; e-mail and CLI cover the operator today.

## Consequences

New agents default to hitl and are promoted to hotl per action type after evals and a period of
observed behaviour.

## Security considerations

Approval tokens are HMAC-bound to the approval id and expire; the broker rejects mismatched
action hashes and reused approvals. The kill switch fails closed on corrupt state.
