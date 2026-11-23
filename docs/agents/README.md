# Agents

One page per agent. Create pages with `/new-agent`; the template is below.

| Agent                                           | Tier | Mode     | Repos                           | Actions                                                                                | Status |
| ----------------------------------------------- | ---- | -------- | ------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| [triage](triage.md)                             | T0   | readonly | OWASP/CheatSheetSeries          | none (read-only)                                                                       | active |
| [implementation-check](implementation-check.md) | T0   | readonly | OWASP/CheatSheetSeries          | none (read-only)                                                                       | paused |
| [proposal-review](proposal-review.md)           | T0   | readonly | OWASP/CheatSheetSeries          | none (read-only)                                                                       | active |
| [pr-gate](pr-gate.md)                           | T1   | hotl     | OWASP/CheatSheetSeries          | pr.close                                                                               | active |
| [cheatsheet-review](cheatsheet-review.md)       | T2   | hotl     | OWASP/CheatSheetSeries, sandbox | pr.review.inline, issue.label.remove (trigger label)                                   | active |
| [triage-apply](triage-apply.md)                 | T1   | hitl     | OWASP/CheatSheetSeries, sandbox | issue.assign, issue.label.add/remove, issue.comment (one approval per issue, ADR 0019) | active |

## Template

```markdown
# <agent-id>

- Tier: T0|T1|T2|T3 (ADR 0021) · Version: 0.1.0 · Mode: hitl|hotl
- Repositories: ...
- Worker: `custodes-<id>` (`workers/<id>/wrangler.jsonc`, entry `workers/agents/src/<id>-worker.ts`)
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
