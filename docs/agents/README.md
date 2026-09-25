# Agents

One page per agent. Create pages with `/new-agent`; the template is below.

| Agent             | Mode | Repos                  | Actions       | Status   |
| ----------------- | ---- | ---------------------- | ------------- | -------- |
| [hello](hello.md) | hitl | OWASP/CheatSheetSeries | issue.comment | scaffold |

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
