# Agents

One page per agent. Create pages with `/new-agent`; the template is below.

| Agent                                           | Mode     | Repos                      | Actions                                                                                | Status  |
| ----------------------------------------------- | -------- | -------------------------- | -------------------------------------------------------------------------------------- | ------- |
| [triage](triage.md)                             | readonly | OWASP/CheatSheetSeries     | none (read-only)                                                                       | active  |
| [implementation-check](implementation-check.md) | readonly | OWASP/CheatSheetSeries     | none (read-only)                                                                       | active  |
| [proposal-review](proposal-review.md)           | readonly | OWASP/CheatSheetSeries     | none (read-only)                                                                       | active  |
| [pr-gate](pr-gate.md)                           | hotl     | OWASP/CheatSheetSeries     | pr.close                                                                               | active  |
| [cheatsheet-review](cheatsheet-review.md)       | hotl     | mackowski/custodes-sandbox | pr.review.inline, issue.label.remove (trigger label)                                   | sandbox |
| [triage-apply](triage-apply.md)                 | hitl     | mackowski/custodes-sandbox | issue.assign, issue.label.add/remove, issue.comment (one approval per issue, ADR 0019) | sandbox |

## Template

```markdown
# <agent-id>

- Version: 0.1.0 · Mode: hitl|hotl
- Repositories: ...
- Class: `workers/agents/src/agents/<id>.ts` · Policy: `workers/github-broker/policy/policy.json#agents.<id>`

## Purpose

## Inputs (all untrusted)

## Actions requested (must match policy)

## PAT scopes (fine-grained)

## Schedule / triggers

## Failure modes and what happens

## How to halt: `custodes agents halt <id> --reason "..."`

## Threat model (from /threat-model)
```
