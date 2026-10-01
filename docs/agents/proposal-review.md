# proposal-review

- Version: 0.1.0 · Mode: **readonly** · Repository: OWASP/CheatSheetSeries
- Class: `workers/agents/src/agents/proposal-review.ts` · Logic: `workers/agents/src/agents/specialists/`
- Policy: no `agents` entry. `reads.proposal-review` allows `issue`, `comments`, `labels`,
  `cheatsheets`, `cheatsheet` (ADR 0010).

## Purpose

For community issues not yet accepted, judge whether the proposal is sound and in scope, whether
the cheat sheets already cover it (with quoted evidence), or whether it is a real gap, and
recommend what the maintainer could do: labels to add or remove (for example `ACK_OBTAINED` instead
of `ACK_WAITING`), whom to assign (only someone in the thread who offered to do the work) or
`HELP_WANTED` when nobody did, and a comment to post.

## Trigger

Called by triage for every issue it assessed that has no `ACK_OBTAINED` label and is not spam.
Each issue version (`updated_at`) is reviewed once.

## How a job runs

1. Read the issue (skip it if closed), its first 100 comments, labels and the cheat sheet list.
2. Fast model picks up to three related cheat sheets; they are loaded and enveloped as untrusted.
3. Reasoning model answers in JSON.
4. `validateProposalReview`: labels must exist (removals must be on the issue), the assignee must be
   the author or a commenter, `HELP_WANTED` is added only without an assignee, and "covered"
   verdicts need verified evidence or become "unclear".

## Outputs, limits, failure modes, halting

As for [implementation-check](implementation-check.md): 10 jobs per UTC day, results collected by
the triage digest, kill switch `halt:proposal-review`. Evals: `evals/agents/proposal-review`.

## Threat model

See ADR 0010. Beyond the shared risks, a commenter may try to get assigned or have a bad proposal
accepted by addressing the model; assignees are limited to thread participants, the maintainer
decides, and an injection eval covers the case.
