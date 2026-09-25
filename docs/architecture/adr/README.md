# Architecture Decision Records

| #                                                      | Title                                                                 | Status                    |
| ------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------- |
| [0001](0001-typescript-monorepo.md)                    | TypeScript pnpm monorepo                                              | accepted                  |
| [0002](0002-github-broker-policy-enforcement-point.md) | GitHub broker as the single policy enforcement point                  | accepted                  |
| [0003](0003-per-agent-pat-with-attestation.md)         | Per-agent fine-grained PATs with signed attestations                  | accepted, amended by 0008 |
| [0004](0004-hitl-hotl-model.md)                        | Human-in-the-loop and human-on-the-loop primitives                    | accepted                  |
| [0005](0005-anthropic-via-ai-gateway.md)               | Anthropic models through Cloudflare AI Gateway (BYOK)                 | accepted                  |
| [0006](0006-polling-first-ingress.md)                  | Polling-first ingress, webhooks optional                              | accepted                  |
| [0007](0007-single-environment.md)                     | Single environment; test repositories as the proving ground           | accepted                  |
| [0008](0008-broker-keyring-and-ci-managed-secrets.md)  | Signing keys generated in the broker; all other secrets managed by CI | accepted                  |

Create new records with the `/adr` skill.
