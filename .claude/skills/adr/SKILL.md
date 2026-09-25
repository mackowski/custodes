---
name: adr
description: Write an Architecture Decision Record in docs/architecture/adr with the next number, in the repo's format (context, decision, consequences, security considerations). Use whenever an architectural or security-relevant decision is made.
argument-hint: '<short title>'
allowed-tools: Read, Glob, Write, Bash(ls *)
---

# ADR: $ARGUMENTS

Existing ADRs:
!`ls docs/architecture/adr/`

1. Pick the next four-digit number and a kebab-case slug from the title.
2. Write `docs/architecture/adr/NNNN-<slug>.md` using exactly this template:

```markdown
# NNNN. <Title>

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD
- Deciders: <people>

## Context

<What forces are at play; link issues and docs.>

## Decision

<The decision, in one or two paragraphs, stated as "We will ...".>

## Alternatives considered

<Each with one line on why not.>

## Consequences

<Positive, negative, and what becomes easier or harder.>

## Security considerations

<What this changes about authority, trust boundaries, secrets, or auditability.>
```

3. Add a line to the index table in `docs/architecture/adr/README.md`.
4. If the decision supersedes an older ADR, update that ADR's status line.
