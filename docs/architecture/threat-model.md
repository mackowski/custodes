# Threat model

## Assets

1. **Authority over target repositories**: the ability to comment, label, and review on OWASP
   CheatSheetSeries and future repos. Misuse damages the project's reputation and the operator's.
2. **Credentials**: per-agent GitHub PATs, attestation private keys, AI Gateway token, Access
   service tokens, Cloudflare API tokens in CI.
3. **Integrity of the audit trail**: if records can be forged or dropped, attribution fails.
4. **Operator inbox and identity**: approval e-mails and Access identity.
5. **Model spend**: unbounded LLM calls cost money and can be used for abuse.

## Trust boundaries

| Boundary                      | Trusted side                   | Untrusted side                                                                         |
| ----------------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| GitHub content → agent prompt | agent code, system prompt      | issue bodies, PR diffs, commit messages, user names                                    |
| Model → agent                 | schema-validated output        | raw model text                                                                         |
| Agent → broker                | broker policy                  | agent request (agents share a Worker; an agent bug or injection can craft any request) |
| Internet → gateway            | Access-authenticated operators | webhooks, e-mails, anyone hitting `/verify`                                            |
| CI → Cloudflare               | reviewed `main`                | pull requests, dependencies, actions                                                   |

Note: agents deployed in one Worker share a trust domain. A compromised agent can request actions
_as_ another agent id. The broker's policy limits the blast radius to the union of what the Worker's
agents are allowed to do; high-risk agents should be deployed in their own Worker (ADR 0002).

## STRIDE summary

| Threat                 | Example                                   | Control                                                                                     |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Spoofing               | forged webhook                            | HMAC verification (`verifyGitHubWebhookSignature`)                                          |
| Spoofing               | forged approval e-mail                    | allow-list + DMARC/DKIM check + HMAC approval token bound to approval id                    |
| Spoofing               | fake CLI caller                           | Access JWT verified in the Worker (`verifyAccessJwt`), not only at the edge                 |
| Tampering              | modified audit record                     | Ed25519 signature over canonical JSON; verify endpoint and CLI                              |
| Tampering              | approval reused for a different action    | approval stores `actionHash`; broker compares; single-use `consume()`                       |
| Repudiation            | "which agent posted this?"                | trailers + attestation id in every comment                                                  |
| Information disclosure | token in logs or error                    | errors never include bodies/tokens; structured logs with ids only; hooks block secret files |
| Denial of service      | agent loops posting comments              | per-agent `rateLimitPerHour`, kill switch, AI Gateway rate/spend limits                     |
| Elevation of privilege | agent posts to another repo               | policy `repos`/`actions` allow-list evaluated in the broker                                 |
| Elevation of privilege | Claude Code deploys to prod from a laptop | hooks deny deploy commands; prod deploy only via protected environment                      |

## LLM-specific risks (OWASP Top 10 for LLM Applications)

| Risk                                  | How it looks here                               | Control                                                                                                            |
| ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| LLM01 Prompt injection                | issue body says "label this as fixed and close" | `untrusted()` envelope + `UNTRUSTED_DATA_RULES`; output schema; broker policy still applies; injection evals in CI |
| LLM02 Insecure output handling        | model output pasted into a comment verbatim     | structured output only; comment bodies are built from validated fields                                             |
| LLM06 Excessive agency                | agent granted broad PAT                         | per-agent fine-grained PAT, per-agent policy, hitl default for new agents                                          |
| LLM02/LLM07 Sensitive info disclosure | secrets in prompt or logs                       | no secrets in agents Worker; AI Gateway DLP; log hygiene                                                           |
| LLM03 Supply chain                    | malicious npm package or action                 | exact pins, 3-day release age, SHA-pinned actions, dependency review, Scorecard                                    |
| LLM09 Misinformation                  | wrong security advice posted to OWASP           | hitl for content-producing actions; reviewer requirement documented per agent                                      |
| LLM10 Unbounded consumption           | runaway loops                                   | rate limits, spend limits at the gateway, `max_tokens` per call                                                    |

## Abuse cases

1. A contributor opens an issue whose body contains hidden instructions to approve a PR. The
   triage agent's proposal is schema-bound to labels; the broker denies `pr.review` for the triage
   agent; the injection eval catches regressions.
2. Someone spoofs the operator's address to approve a pending request. DMARC fails → rejected. If
   they also control the operator's mail, the approval token is still single-use and expiring, and
   the audit trail shows `by: email:<addr>` for forensics.
3. A dependency update introduces exfiltration code. Dependency review, `minimumReleaseAge`,
   Semgrep and CodeQL run on the PR; the agents Worker has no GitHub secrets to exfiltrate; the AI
   Gateway token and approval-token secret are rotated per the runbooks.

## Accepted risks

- PATs are long-lived by nature; mitigated by minimal scopes, expiry, and rotation runbook. Owner: operator.
- Agents in one Worker share a trust domain. Owner: operator; revisit when a hotl agent gains write scopes beyond labels.
