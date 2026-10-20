# 0013. pr-gate reads maintainer comments and asks Jev about agreement before a close

- Status: proposed
- Date: 2026-10-20
- Deciders: Jakub Maćkowski

## Context

On 2026-10-20 pr-gate closed
[OWASP/CheatSheetSeries#2831](https://github.com/OWASP/CheatSheetSeries/pull/2831) with rule
`assigned_to_other`. The body said "related to #2815" (an `ACK_OBTAINED` issue assigned to
`randomstuff`). But `randomstuff` had invited exactly this change in a comment on PR #2808
("@shishir-cyber, Yes, I think it would be nice to have a short note…"). They reopened the PR
and said it was fine. pr-gate never read comments, so it could not see the agreement.

Restricting `assigned_to_other` to closing keywords ("Fixes #N") was rejected. The operator
wants pr-gate to close as many non-compliant PRs as possible. The missing piece is the
conversation, not the parsing.

## Decision

We will add `comments` to `reads.pr-gate.resources` in the broker policy. Before any
`assigned_to_other` or `no_approved_issue` close, pr-gate reads the first page of comments on
the PR itself and on every number the body links (issues and pull requests).

From those comments it keeps only the ones whose GitHub-set `author_association` is OWNER, MEMBER
or COLLABORATOR. MEMBER means any public member of the OWASP organisation, the same set that is
already exempt from gating. It drops:

- the PR author's own comments and bots,
- the agents' own comments (identified by the trailer block, checked after quotes are removed,
  so a maintainer who quote-replies an agent comment keeps their words),
- quoted (`>`) lines, fenced code blocks and HTML comments, which may repeat third-party text.

If no maintainer comment remains, the close goes ahead as before and no model is called.
Otherwise Jev is asked two questions:

- `approved` (noul): did a maintainer agree that this author make this change?
- `stance` (choice): `approved | rejected | unrelated | unclear`.

Jev's state holds only the author's login, the names of existing cheat sheets the PR modifies
(added or renamed files are left out, because the author chose those names) and up to 20
maintainer comments of up to 1,400 characters each, inside `untrusted()`. With band
yes 0.75 / no 0.2:

- p ≥ 0.75 and `approved` → skip (`maintainer_approved`, listed in the daily summary). This
  needs at least one kept comment that @-mentions the exact author login or is on the PR
  itself. Otherwise it is a flag, because agreement given to someone else in a thread the
  author chose to link is not enough.
- p ≤ 0.2 and `rejected` or `unrelated` → the close goes ahead. If Jev did not see every comment
  (a thread had a full page of 100, more than 20 comments, or a comment was cut), it is a flag
  instead, because the agreement may be in the part Jev did not see.
- Anything else, or a Jev failure → flag for a maintainer.

`ai_disclosure` closes are unchanged, because agreement does not replace the disclosure.

## Alternatives considered

- **Closing keywords only for `assigned_to_other`.** This would close fewer PRs, and the
  operator wants the opposite.
- **A deterministic "maintainer @-mentioned the author" rule that flags.** It never closes when
  any maintainer talked to the author, even to refuse. Too many flags.
- **An LLM (Claude) judging agreement with a rationale.** It costs more, writes text, and
  Anthropic credits are currently exhausted. Jev's probabilities map directly onto bands.
- **Including the PR title and body in Jev's state.** The author controls both and could
  write "maintainer approved". Excluded.

## Consequences

- PRs like #2831 are left open (or flagged) instead of closed. The skip appears in the summary
  with its score.
- A poll costs up to `MAX_LINKED + 1` more reads per would-be close, and at most one more Jev
  call, only when maintainers commented.
- Bands start at 0.75 / 0.2 and are tuned with `evals/agents/pr-gate-approval`.
- Comments beyond the first 100 per thread are not read. A full page, or comments cut to fit the
  state, turn a "no" into a flag.
- Inline review comments are not read (a different endpoint). Agreement given there is missed,
  as before.

## Security considerations

- **Policy widening:** one read resource (`comments`) for pr-gate, on the same token
  (`PAT_READONLY`) and the same repositories. It adds no write authority. Comments on these
  public repositories are already public.
- **Injection:** the only free text that reaches Jev is written by OWNER/MEMBER/COLLABORATOR.
  `author_association` is set by GitHub. The author's login is constrained by GitHub, and file
  names come only from existing, modified cheat sheets. Quotes, code blocks and HTML comments
  are removed, and the rest stays inside `untrusted()`. Jev writes no text,
  and its answers are zod-validated probabilities.
- **Worst case:** an injection makes Jev answer "approved". That only skips the PR, which a
  maintainer then reviews normally, and the skip is listed in the summary with its score. It
  can never cause a close that would not have happened without this change.
- **Agent comments:** the agent posts as a COLLABORATOR account (the operator's). Its comments
  are excluded by the trailer block (`^Custodes-Agent: <id>@`), so its own close comment cannot
  count as agreement. The operator's personal comments still count.
- **Logs and traces** hold counts, p and stance only, never comment text.
