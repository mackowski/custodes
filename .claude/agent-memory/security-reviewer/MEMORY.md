# security-reviewer memory

- Architecture invariant: agents never hold GitHub or email credentials; only `workers/github-broker` does. Any PR that adds a token binding to `workers/agents` is a finding.
- Policy file: `workers/github-broker/policy/policy.json`. Widening `repos`, `actions`, or raising `rateLimitPerHour` needs an ADR reference in the PR.
