# custodes

_quis custodiet ipsos custodes_

Guardian agents for open-source maintainers, hosted on Cloudflare. The first agents help maintain
the [OWASP Cheat Sheet Series](https://github.com/OWASP/CheatSheetSeries): triaging issues and reviewing pull requests, with a human in or on the loop.

The name is the design principle. Agents that act on other people's repositories must themselves
be watched, so every side effect passes through one policy-enforcing broker, is recorded in a
signed audit log, and can be halted by one command.

## How it works

```
GitHub ── poll/webhook ──▶ gateway ──▶ agents (Durable Objects) ──▶ github-broker ──▶ GitHub
e-mail ── approvals ─────▶ gateway        │ LLM via AI Gateway         │ policy · kill switch
CLI ──── Cloudflare Access ▶ gateway ─────┘                            │ approvals · rate limit
                                                                       └ audit log · Ed25519 attestation
```

- **Agents** (Cloudflare Agents SDK) read issues and PRs, reason with Claude through Cloudflare AI
  Gateway, and _propose_ actions. They hold no credentials.
- **The broker** decides. It holds one fine-grained GitHub token per agent, checks a committed
  policy, the kill switch, human approvals and rate limits, executes the action, and signs an audit
  record. Every comment an agent posts ends with an attestation id you can verify.
- **Humans** approve by e-mail reply or CLI (`hitl` agents), or supervise via digests and a kill
  switch (`hotl` agents).
- **The CLI** (`custodes`) runs, halts and resumes agents, decides approvals, and verifies the audit
  trail, authenticated by Cloudflare Access.

Read more: [architecture](docs/architecture/overview.md) · [threat model](docs/architecture/threat-model.md) ·
[security controls](docs/architecture/security-controls.md) · [ADRs](docs/architecture/adr/README.md) ·
[how we build this with Claude Code](docs/sdlc.md).

## Repository layout

| Path                                                | Contents                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/schema`                                   | zod schemas for every wire format                                               |
| `packages/core`                                     | attestations, approval tokens, kill switch, policy evaluation, agent base class |
| `packages/github`, `packages/llm`, `packages/email` | adapters                                                                        |
| `workers/gateway`                                   | public ingress and Access-protected admin API                                   |
| `workers/agents`                                    | the agents                                                                      |
| `workers/github-broker`                             | the policy enforcement point                                                    |
| `apps/cli`                                          | operator CLI                                                                    |
| `infra/terraform`                                   | Cloudflare platform resources                                                   |
| `.claude/`                                          | skills, subagents, hooks and settings for Claude Code                           |
| `docs/`, `evals/`                                   | documentation, promptfoo evals                                                  |

## Getting started

```bash
./scripts/bootstrap.sh     # checks node, pnpm, cloudflared, terraform
pnpm install
pnpm check                 # format, lint, typecheck, 45 tests (Workers run in workerd)
pnpm dev:migrate           # create the local D1 schema once
pnpm dev                   # gateway + agents + broker on http://localhost:8787
```

The gateway is the only public entry point, and its `/admin` and `/agents` routes require a
Cloudflare Access JWT even locally. To poke an agent directly during development, run the agents
Worker on its own port in a second terminal:

```bash
pnpm dev:agents            # http://localhost:8788
curl localhost:8788/registry
curl -X POST localhost:8788/agents/hello-agent/default/run
curl localhost:8788/agents/hello-agent/default
```

Deployment needs a Cloudflare account with a domain for e-mail and Access; see
`infra/terraform/README.md` and the runbooks in `docs/runbooks/`.

No secrets are ever stored in files. CI reads them from GitHub Environment secrets; on a laptop
`scripts/with-secrets.sh` exports them from the macOS Keychain (or 1Password) into a single process:

```bash
./scripts/with-secrets.sh set CLOUDFLARE_API_TOKEN          # once
./scripts/with-secrets.sh terraform -chdir=infra/terraform/envs/prod plan -var-file=prod.tfvars
```

## Status

Scaffold. The `hello` agent exercises the full pipeline; the first real agents (issue triage, PR
review) are built with the `/new-agent` skill.

## Security

See [SECURITY.md](SECURITY.md). Please report vulnerabilities privately.

## License

Apache-2.0
