# implementation-check

- Version: 0.1.0 · Mode: **readonly** · Repository: OWASP/CheatSheetSeries
- Class: `workers/agents/src/agents/implementation-check.ts` · Logic: `workers/agents/src/agents/specialists/`
- Policy: no `agents` entry. `reads.implementation-check` allows `issue`, `timeline`, `pull_files`,
  `cheatsheets`, `cheatsheet` (ADR 0010).

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
   changed files under `cheatsheets/`.
3. Fast model (`claude-sonnet-5`, thinking disabled) picks up to three related cheat sheets.
4. Load at most four cheat sheets (PR-changed first), each clipped to 30,000 characters, enveloped
   as untrusted.
5. Reasoning model (`claude-opus-5-5`, adaptive thinking, `max_tokens` 16000) answers in JSON.
6. `validateImplementationCheck`: quotes must be on a line of a loaded file, PRs must be merged and
   referencing; "yes" without verified evidence becomes "unclear". Only "yes" recommends closing.

## Outputs

Results wait in SQLite until triage's 07:00 UTC digest collects them. Status at
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
