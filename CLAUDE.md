# Custodes

Guardian agents for open-source maintainers, hosted on Cloudflare. First target: OWASP
CheatSheetSeries (issue triage, PR review). Security and AI security come first.

## Invariants (never break these)

1. Agents never hold GitHub or e-mail credentials. Every GitHub side effect goes through
   `workers/github-broker` (`this.act()` in agents). If you need a token in `workers/agents`, stop.
2. Untrusted text (issues, PRs, e-mails, webhooks) is wrapped with `untrusted()` before any
   prompt; model output goes through `parseStructured()`.
3. `await this.guard()` before any side effect (kill switch). New agents are `hitl` until evals pass.
4. Widening a policy (`workers/github-broker/policy/policy.json`) needs a linked ADR or issue.
5. No deploys, secret writes, `terraform apply` or force pushes from a session. CI does that after review.
   No secrets in files, ever: credentials come from CI secrets or `scripts/with-secrets.sh` (Keychain).
6. The Cloudflare MCP server (from the `cloudflare` plugin) is for _reading_ account state in a
   session. Resource changes go through Terraform and wrangler in CI, never through MCP calls.

## Map

```
packages/schema   zod wire formats (source of truth for types)
packages/core     attestation, approval tokens, kill switch, policy eval, CustodesAgent base
packages/github|llm|email   adapters (no policy decisions)
workers/gateway   public ingress: webhooks, approval e-mail, Access-protected admin API, /verify
workers/agents    Durable Object agents (Agents SDK); registry.ts lists them
workers/github-broker   THE policy enforcement point: policy → kill switch → approval → rate limit → execute → audit → sign
apps/cli          `custodes` operator CLI (Cloudflare Access)
infra/terraform   Access, Email, DNS, AI Gateway, Secrets Store, KV/D1/Queues
docs/             architecture, threat model, ADRs, agent pages, runbooks, sdlc.md
evals/            promptfoo behaviour + injection suites
```

## Commands

```bash
pnpm install && pnpm check   # format, lint, typecheck, test
pnpm dev:migrate && pnpm dev # all three Workers locally on :8787 (shared state in .wrangler/state)
pnpm dev:agents              # agents Worker alone on :8788, bypasses the Access-protected gateway
pnpm --filter ./apps/cli build
```

## Workflow

Use the skills: `/new-agent`, `/new-tool`, `/threat-model`, `/agent-security-review`, `/adr`,
`/eval`; humans run `/preview` and `/release`. Delegate research to `cloudflare-researcher`,
reviews to `security-reviewer`, tests to `test-writer`. Conventions: `.claude/skills/custodes-conventions`.
Cloudflare platform knowledge comes from the `cloudflare` plugin declared in `.claude/settings.json`
(`cloudflare:agents-sdk`, `cloudflare:wrangler`, `cloudflare:cloudflare-one`, `cloudflare:durable-objects`,
`cloudflare:cloudflare-email-service`, `cloudflare:workers-best-practices`); install it when prompted.
Read `docs/sdlc.md` once.

## Style

TypeScript strict with `exactOptionalPropertyTypes`; exact dependency pins; tests deterministic
(inject `now`, keys, `fetchImpl`); structured JSON logs with ids only, never bodies or tokens.
