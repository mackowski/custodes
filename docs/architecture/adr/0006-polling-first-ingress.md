# 0006. Polling-first ingress, webhooks optional

- Status: accepted
- Date: 2026-09-25
- Deciders: Jakub Maćkowski

## Context

Webhooks require admin rights on the target repository, which maintainers of an OWASP project may
not have or may not want to grant to a personal service.

## Decision

Agents discover work by polling (`scheduleEvery`) for labels such as `custodes/triage` on their
repositories. The gateway also accepts signed GitHub webhooks and queues them, for repositories
where an admin opts in.

## Alternatives considered

- Webhooks only: blocked on permissions.
- GitHub App events: requires the App path (see ADR 0003).

## Consequences

Latency of minutes rather than seconds; predictable API usage; no inbound dependency on GitHub.

## Security considerations

Polling uses public read endpoints and never needs a write token in the agents Worker. Webhook
payloads are verified and treated as untrusted hints; agents re-read the source of truth.

## Amendment (2026-10-26): webhooks wake pr-gate

The operator has admin rights on OWASP/CheatSheetSeries and installs a webhook there (sandbox
first). The agents Worker's queue consumer now dispatches `pull_request` `opened` and `reopened`
events on repositories listed in `instances.ts` to pr-gate, which only schedules a poll for the end
of the PR's grace period (5-minute slots, idempotent). Everything else is acknowledged and ignored;
triage stays on its crons, since its results only appear in the daily digest. Crons remain the
fallback for lost deliveries. Polling is still the default for repositories without a hook.
