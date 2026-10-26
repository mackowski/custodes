---
name: grill-plan
description: Stress-test a plan before any code is written - interview the operator in rounds about every open decision, with a recommended answer for each, using the Custodes question bank (authority, untrusted input, failure, evals, cost, rollout, observability). Use right after a plan is agreed in plan mode or written in an issue, before implementing a new agent, broker tool, policy widening, prompt or schema change, or architectural decision; also when the user says "grill", "stress-test this plan" or "poke holes in this". Do not use for typo fixes, dependency bumps or other changes with no design decisions.
argument-hint: '<plan, issue number, or nothing to use the plan in this conversation>'
skills:
  - custodes-conventions
---

# Grill the plan: $ARGUMENTS

The goal is a shared understanding of the plan before implementation, with every decision made
by the operator on purpose instead of by the implementer by accident. Find the plan in the
argument, the linked issue (`gh issue view`), or this conversation. If there is none, ask for it.

## Is a grilling needed?

Required for a new agent, a new broker action, anything that widens `policy.json`, a prompt or
output schema change, a model choice, and architectural decisions. Otherwise say in one line that
the change has no design decisions to grill, and stop. Skip questions whose answers the plan
already states clearly and the code confirms.

## Method

Adapted from Matt Pocock's `grilling` and `domain-modeling` skills (MIT,
github.com/mattpocock/skills).

Treat the plan as a **design tree**: each decision opens the decisions that depend on it. Work it
in rounds. The **frontier** is every open decision whose prerequisites are settled. Ask the whole
frontier in one round, then wait. A question that depends on another question still open in the
same round belongs to a later round. Each answer reshapes the tree, so recompute the frontier
before the next round.

Keep a round to about seven questions, most consequential first; the rest wait for the next round,
listed in one line so the operator sees what is coming. A long first round gets skimmed and
answered "yes" wholesale, which defeats the point. When the plan adds or changes something an
agent does on its own (closing, labelling, commenting), the first round includes how it will be
proven: which eval cases, including injection cases.

Format each question so that answering "yes" accepts the recommendation:

```
❓ **Q1 - <title>**: <the decision, the options, and what each costs here>

➡️ <recommended answer, with the reason in one line>
```

Facts are your job; decisions are the operator's. Look up anything the repo, the docs or a
command can answer (dispatch `Explore` or `cloudflare-researcher` for anything that takes more
than a few reads) and state what you found inside the question. Do not ask the operator for a
fact. A lookup still running only blocks the questions that depend on it.

Questions in [QUESTIONS.md](QUESTIONS.md) are a checklist of what usually goes wrong in this
repository, not a script: read it, ask only what applies to this plan, and phrase it about this
plan. Plans also fail in ways the list does not cover, so look for those too:

- **Sharpen the words.** When the plan uses a vague or overloaded term ("approve", "close",
  "instance", "agent"), ask which concrete thing it means. This repository already has
  similar-sounding concepts (an HITL approval token versus a maintainer agreeing in a comment).
- **Use concrete scenarios.** Ask about a specific edge case ("a maintainer agreed in a thread the
  PR author linked themselves") instead of an abstract property.
- **Check the plan against the code.** If the plan assumes behaviour the code does not have, or
  contradicts an accepted ADR in `docs/architecture/adr/`, say so in the question.
- **Check the premise against data and the upstream rules.** Plans often rest on a claim ("these
  PRs are almost always spam", "nobody updates old issues"). Test it on a long window of real
  history in the target repository (a year, not a few weeks) and against what the project's own
  CONTRIBUTING.md allows. A rule that mostly hits contributions the maintainers welcome is the
  costliest mistake an enforcing agent can make.
- **Record the no's.** When the operator rules something out, keep it: rejected options are
  as useful to a later reader as the chosen ones.

## Finishing

The grilling is done when the frontier is empty: every branch visited and nothing silently
assumed. Then write the result and ask the operator to confirm it. Do not start implementing
until they do.

```markdown
## Design decisions

- **<decision>**: <what was chosen> - <why, one line>
- ...

### Ruled out

- <option>: <why not>

### Follow-ups

- [ ] /adr <title> (only decisions that need one, see below)
- [ ] /threat-model <agent> (new agent or widened policy)
- [ ] eval cases: <which suites, which new injection cases>
```

Put it where the plan lives: append it to the issue or to the PR description, or keep it in the
conversation if there is neither, and say which.

Propose `/adr` only for a decision that is hard to reverse, would surprise a reader without
context, and was a real trade-off between alternatives. All three must hold; otherwise the
"Design decisions" list is enough. ADRs go through `/adr` into `docs/architecture/adr/`, never
anywhere else.
