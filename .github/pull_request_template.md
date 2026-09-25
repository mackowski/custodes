## What

<!-- One paragraph. Link the issue. -->

## Why

## Security impact

- [ ] No change to what any agent may do (policy, actions, repos, tokens, bindings)
- [ ] Changes agent capabilities → policy diff reviewed, threat model section updated (`/threat-model`)
- [ ] Touches untrusted input handling (issue text, PR diffs, email, webhook) → wrapped with `untrusted()`, output schema-validated
- [ ] Touches secrets, Access, Terraform or CI → second reviewer requested

## How it was tested

<!-- Unit tests, `pnpm check`, evals run, preview version, manual steps -->

## AI assistance

<!-- Which skills/agents produced this? (e.g. /new-agent, security-reviewer). Reviewers read AI-generated code with the same care as any other. -->
