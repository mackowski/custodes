# proposal-review

- Version: 0.1.0 · Mode: **readonly** · Repositories: OWASP/CheatSheetSeries; mackowski/custodes-sandbox for tests (ADR 0012, run on demand only)
- Class: `workers/agents/src/agents/proposal-review.ts` · Logic: `workers/agents/src/agents/specialists/`
- Policy: no `agents` entry. `reads.proposal-review` allows `issue`, `comments`, `labels`,
  `cheatsheets`, `cheatsheet`, `timeline` (ADR 0010 and its 2026-10-13 amendment).

## Purpose

For community issues not yet accepted, judge whether the proposal is sound and in scope, whether
the cheat sheets already cover it (with quoted evidence), or whether it is a real gap, and
recommend what the maintainer could do: labels to add or remove (for example `ACK_OBTAINED` instead
of `ACK_WAITING`), whom to assign (only someone in the thread who offered to do the work) or
`HELP_WANTED` when nobody did, and a comment to post.

## Trigger

Called by triage once a day at 05:30 UTC, before the 07:00 digest, for every pending issue that has
no `ACK_OBTAINED` label and is not spam. Each issue version (`updated_at`) is reviewed once, and an
issue at most once a day.

## How a job runs

1. Read the issue (skip it if closed), its current assignees, the page with its newest comments,
   its timeline (pull requests that reference it, and their state), the labels and the cheat sheet
   list. The prompt gets the last 30 human comments, quoted line by line, and code-built "Last
   comment" and "Maintainers in this thread" lines (`author_association`) outside the envelope.
2. Referenced issues (#85): same-repository issues named in the issue body or in maintainers'
   comments (never a contributor's comment), up to three, pull requests skipped. Only their
   maintainers' comments are read, enveloped as `github:issue#N:maintainer-comments` (2,000
   characters each). An unreadable reference is skipped.
3. Fast model picks up to three related cheat sheets; they are loaded and enveloped as untrusted.
4. Reasoning model answers in JSON. When maintainers already decided the scope or destination
   in a referenced issue, it reports `priorDecision` and follows it.
5. `validateProposalReview`: labels must exist (removals must be on the issue), the assignee must be
   the author or a commenter and only when nobody is assigned yet, `reviewPr` must be an open
   linked PR (then nobody is assigned), `HELP_WANTED` is added only when nobody is or will be on it,
   and "covered" verdicts need verified evidence or become "unclear". `priorDecision` must name an
   issue whose maintainer comments were shown, or it is dropped.

The digest (code, from GitHub-set data, at send time): a proposal whose last comment is a
maintainer's from the last 14 days and that has nothing left to do (no labels, assignee, PR to
review or closing verdict) is one line under "waiting on the author". A non-maintainer comment last
adds "answer the latest comment". A review flagged for possible injection is always shown in full.

## Outputs, limits, failure modes, halting

As for [implementation-check](implementation-check.md): 10 jobs per UTC day, results collected by
the triage digest, kill switch `halt:proposal-review`. Evals: `evals/agents/proposal-review`.

## Threat model

See ADR 0010. Beyond the shared risks, a commenter may try to get assigned or have a bad proposal
accepted by addressing the model; assignees are limited to thread participants, the maintainer
decides, and an injection eval covers the case. A referenced issue is read only when the author's
body or a maintainer points at it, and only its maintainers' comments count; a contributor comment
claiming that "maintainers agreed" is covered by an injection eval.
