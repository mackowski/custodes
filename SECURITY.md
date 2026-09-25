# Security Policy

Custodes runs agents that read and write to other people's repositories and inboxes. Security
issues in Custodes can therefore affect projects that are not Custodes. Please report responsibly.

## Reporting a vulnerability

- Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability).
- Do not open a public issue for anything that could be exploited before a fix ships.
- You should receive an acknowledgement within 3 business days.

## Scope

In scope:

- Any way for an agent to perform a GitHub or email action that its policy in
  `workers/github-broker/policy/` does not allow.
- Prompt injection that changes an agent's proposed action (even if the broker later blocks it).
- Bypass of Cloudflare Access on the admin API or the CLI.
- Forged or replayed approval tokens (email links, CLI approvals).
- Forged attestations, or an audit record that does not match the action taken.
- Secret exposure through logs, error messages, or LLM prompts.

Out of scope: vulnerabilities in Cloudflare or GitHub themselves (report those to the vendor),
and findings that require a compromised operator account.

## Security design

See `docs/architecture/threat-model.md` and `docs/architecture/security-controls.md`. The short version: agents never hold credentials; a single broker enforces policy, records an audit entry, and signs an attestation for every side effect; humans can halt any agent with one command.

## Supported versions

Only the `main` branch and the latest deployed version are supported.
