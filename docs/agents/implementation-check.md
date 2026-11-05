# implementation-check

- Version: 0.1.0 · Mode: **readonly** · Repositories: OWASP/CheatSheetSeries; mackowski/custodes-sandbox for tests (ADR 0012, run on demand only)
- Class: `workers/agents/src/agents/implementation-check.ts` · Logic: `workers/agents/src/agents/specialists/`
- Policy: no `agents` entry. `reads.implementation-check` allows `issue`, `comments`, `timeline`,
  `pull`, `pull_files`, `cheatsheets`, `cheatsheet` (ADR 0010 and its 2026-11-05 amendment).

## Purpose

For issues accepted (`ACK_OBTAINED`) more than a week ago, check whether the current cheat sheets
already implement them. When they do, the digest recommends closing the issue and gives a comment
with the evidence: quoted lines with links, and merged pull requests that reference the issue.

## Trigger

Called by triage, never on its own. Every triage poll lists open accepted issues, dates each
acceptance from the timeline, and hands the stale ones to `enqueue` (issue number and `updated_at`
only). A result is reused for 30 days while the issue is unchanged.

## How a job runs

1. Read the issue (skip it if closed), its timeline and the cheat sheet list.
2. Find same-repository pull requests that reference it; for up to three merged ones, read their
   changed files under `cheatsheets/`; for up to three open ones, read their `updated_at`.
3. Fast model (`claude-sonnet-5`, thinking disabled) picks up to three related cheat sheets.
4. Load at most four cheat sheets (PR-changed first), each clipped to 30,000 characters, enveloped
   as untrusted.
5. Read the comments (the last 30 human comments, newest kept within 12,000 characters) and the
   assignees. Code, not the model, writes who commented last and whether they are a maintainer
   (`author_association` `OWNER`, `MEMBER` or `COLLABORATOR`), outside the untrusted envelope.
6. Reasoning model (`claude-opus-5-5`, adaptive thinking, `max_tokens` 16000) answers in JSON.
7. `validateImplementationCheck`: quotes must be on a line of a loaded file, PRs must be merged and
   referencing; "yes" without verified evidence becomes "unclear". Only "yes" recommends closing.

## Outputs

Results wait in SQLite until triage's 07:00 UTC digest collects them. The digest adjusts the
suggestion from the stored thread state, measured when it is sent (`followUp`): "looks
implemented" stays first; a maintainer comment or an open linked PR updated within 14 days moves
the issue to a collapsed "in progress, nothing to do" line; a non-maintainer comment last asks the
maintainer to answer it. A result flagged for possible injection is always shown in full. Status at
`/agents/implementation-check-agent/owasp-cheatsheetseries` through the Access-protected gateway.
Nothing on GitHub.

## Limits and failure modes

| Limit or failure                        | Effect                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| 10 jobs per UTC day                     | the rest wait; the first poll after midnight resumes                          |
| Model output invalid, refused, cut off  | job moves to the back of the queue; dropped after 4 attempts, error in digest |
| Broker, GitHub or gateway failure       | job kept, chain stops, retried on the next triage poll                        |
| Kill switch `halt:implementation-check` | alarms return at once; checked again before every model call                  |

## Threat model

See ADR 0010. Main risks: instruction-like text in a cheat sheet or issue steering the verdict
(envelope, verified evidence, injection evals in `evals/agents/implementation-check`), and a
pasted comment carrying a link or mention (removed by `sanitizeComment`; links appended by code).
Comments are a new untrusted input: they are enveloped, and a comment claiming to come from a
maintainer or to confirm the work is done is not evidence (injection eval). Who counts as a
maintainer comes from GitHub's `author_association`, never from comment text; `MEMBER` covers the
whole OWASP organisation, an accepted risk in ADR 0010 (2026-11-05).
