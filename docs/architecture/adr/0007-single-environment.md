# 0007. Single environment; test repositories as the proving ground

- Status: accepted
- Date: 2026-09-25
- Deciders: Jakub Maćkowski

## Context

The scaffold started with staging and production environments. For a single operator this doubled
every resource, secret, PAT and configuration block, and produced a real conflict: Email Routing is
zone-level, so two environments cannot both own it on one domain. The risk staging was meant to
absorb, an unproven agent touching a real repository, is already controlled elsewhere.

## Decision

We will run one environment. New agents are allow-listed in the broker policy only for **test
repositories** the operator owns; promotion to a real repository is a policy change in a reviewed
PR. Deploys happen on merge to `main` behind the GitHub `prod` environment's required reviewer.
Builds can be tried on real Cloudflare with `wrangler versions upload` (the `/preview` skill),
which routes no traffic. Terraform plans run in a separate, unprotected `ci` environment so they are
visible on pull requests.

## Alternatives considered

- Keep staging: the cost above, plus a second Access application and hostname to reason about.
- Staging as a subdomain sharing the zone: Email Routing subdomain onboarding is dashboard-only and
  catch-all rules exist only for the apex.

## Consequences

Half the infrastructure, one set of secrets per agent, one hostname. The `hitl` default, the kill
switch, rate limits and policy allow-lists carry the safety load. A real staging environment can be
reintroduced later by restoring `infra/terraform/envs/staging` and `env` blocks in wrangler configs.

## Security considerations

The production Access application, broker and audit log are the only ones, which concentrates
attention on them. Agents cannot reach a real repository until a human widens the policy, so the
missing environment does not weaken the authority model.
