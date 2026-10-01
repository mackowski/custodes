# 0010. Specialist agents called by triage, and wider broker reads

- Status: accepted
- Date: 2026-10-01
- Deciders: Jakub Maćkowski

## Context

The triage digest listed every updated issue, including accepted ones (`ACK_OBTAINED`) that are
the maintainers' backlog rather than news. The operator asked for three changes:

1. Leave recently accepted issues out of the digest.
2. For issues accepted more than a week ago, have a separate agent check whether the cheat sheets
   already implement them, and recommend closing with a comment that cites the evidence.
3. For community issues not yet accepted, have a separate agent judge whether the proposal is
   sound, already covered or a real gap, and recommend labels, an assignee (or `HELP_WANTED`) and a
   comment.

Both checks need more than issue lists: one issue, its timeline (when the label was applied, which
pull requests reference it), its comments, the files a pull request changed, and the text of
individual cheat sheets.

## Decision

- Two new **read-only** Durable Object agents, `implementation-check` and `proposal-review`, in the
  agents Worker. Triage calls them over Durable Object RPC (`getAgentByName(...).enqueue(jobs)`).
  A job is an issue number and the `updated_at` triage saw; no issue text crosses the call. Each
  specialist reads the issue itself under its own broker read policy, queues jobs in SQLite, works
  one per alarm, caps itself at 10 jobs per UTC day, and keeps results until triage puts them in a
  digest (`pendingResults`, `markReported`). Triage re-validates every result with zod on receipt.
- Each job is a fast file-selection call (`claude-sonnet-5`, thinking disabled) followed by the
  assessment on `claude-opus-5-5` (adaptive thinking, which Opus 5.5 always uses; no sampling
  parameters; `max_tokens` 16000). At most four cheat sheets, each clipped to 30,000 characters, are
  given to the model, wrapped with `untrusted()` like issue text.
- "Older than a week" is measured from the last time `ACK_OBTAINED` was applied (timeline
  `labeled` event), falling back to the issue's creation date.
- Evidence is verified, not trusted. A quote counts only if it occurs on one line of a file the
  model was given; the digest shows the file's text and a link rebuilt from the file name and line
  number. Pull requests count only if the timeline shows them merged and referencing the issue.
  "Implemented" without verified evidence becomes "unclear", and only verified evidence produces a
  "close" recommendation. Labels must exist in the repository, removals must be on the issue, and an
  assignee must be the author or a commenter.
- **Policy widening** (`workers/github-broker/policy/policy.json`, invariant 4): `ReadResource` gains
  `issue`, `timeline`, `comments`, `pull_files` and `cheatsheet`; `ReadQuery` gains `page` and a
  single-label `labels` filter; `ReadPolicy` gains a required `resources` allow-list, so no agent gets
  a new resource by default. Grants:

  | Agent                  | Resources                                                      |
  | ---------------------- | -------------------------------------------------------------- |
  | `triage`               | `issues`, `labels`, `cheatsheets`, `timeline`                  |
  | `implementation-check` | `issue`, `timeline`, `pull_files`, `cheatsheets`, `cheatsheet` |
  | `proposal-review`      | `issue`, `comments`, `labels`, `cheatsheets`, `cheatsheet`     |

  `cheatsheet` takes a file name matching `^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}\.md$` (no path
  separators, no leading dot) and reads only under `cheatsheets/`. Numbered resources take a
  positive integer. The broker still builds every URL and uses `PAT_READONLY`.

## Alternatives considered

- **One bigger triage prompt.** Mixes a cheap classification with an expensive, long-context
  review, and gives one prompt every resource. Separate agents keep least privilege per task and
  their own kill switch.
- **Synchronous RPC from triage.** A reasoning call with long context can take minutes; queuing
  keeps the triage poll short and survives restarts.
- **Workflows.** Durable steps are not needed for a two-call job whose failure is simply retried.
- **Searching the code for evidence (GitHub code search).** Needs a token with more scope and
  returns snippets without stable line numbers; reading whole cheat sheets is enough here.

## Consequences

The digest gains recommendation sections and leaves accepted issues out unless triage flags them
(needs a maintainer, or possible injection). Model spend grows by at most 20 jobs a day across both
specialists, mostly Opus input tokens. The first week works through the backlog of about 27 old
accepted issues at 10 a day. Results are re-checked after 30 days or when the issue changes.

## Security considerations

Cheat sheet text is a new untrusted input: anyone whose pull request was merged can plant
instruction-like text. It is enveloped and clipped, evidence is verified against it, and injection
evals cover it. Suggested comments are model text the operator may paste into GitHub, so links,
@-mentions and hidden characters are removed and verified evidence links are appended by code. Both
specialists are `readonly`: no PAT, no `agents` policy, and `act()` throws.
