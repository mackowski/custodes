# Architecture Decision Records

| #                                                             | Title                                                                                    | Status                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- |
| [0001](0001-typescript-monorepo.md)                           | TypeScript pnpm monorepo                                                                 | accepted                        |
| [0002](0002-github-broker-policy-enforcement-point.md)        | GitHub broker as the single policy enforcement point                                     | accepted                        |
| [0003](0003-per-agent-pat-with-attestation.md)                | Per-agent fine-grained PATs with signed attestations                                     | accepted, amended by 0008, 0011 |
| [0004](0004-hitl-hotl-model.md)                               | Human-in-the-loop and human-on-the-loop primitives                                       | accepted                        |
| [0005](0005-anthropic-via-ai-gateway.md)                      | Anthropic models through Cloudflare AI Gateway (BYOK)                                    | accepted                        |
| [0006](0006-polling-first-ingress.md)                         | Polling-first ingress, webhooks optional                                                 | accepted                        |
| [0007](0007-single-environment.md)                            | Single environment; test repositories as the proving ground                              | accepted                        |
| [0008](0008-broker-keyring-and-ci-managed-secrets.md)         | Signing keys generated in the broker; all other secrets managed by CI                    | accepted                        |
| [0009](0009-read-only-agents.md)                              | Read-only agents                                                                         | accepted                        |
| [0010](0010-specialist-agents-and-wider-reads.md)             | Specialist agents called by triage, and wider broker reads                               | accepted                        |
| [0011](0011-jev-decision-tier-and-pr-gate.md)                 | Jev decision tier, and the pr-gate agent closing non-compliant PRs                       | accepted                        |
| [0012](0012-sandbox-repository-and-on-demand-runs.md)         | Sandbox repository, per-repository instances and on-demand runs                          | accepted                        |
| [0013](0013-pr-gate-maintainer-agreement.md)                  | pr-gate reads maintainer comments and asks Jev about agreement                           | accepted                        |
| [0014](0014-anthropic-workload-identity-federation-in-ci.md)  | GitHub Actions authenticate to Anthropic with workload identity federation               | accepted                        |
| [0015](0015-clef-shadow-decision-model-and-one-ai-gateway.md) | Clef as a shadow decision model next to Jev; all agent AI traffic through one AI Gateway | accepted                        |

Create new records with the `/adr` skill.
