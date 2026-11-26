# Backlog rules for issues (#132 v1)

These rules come from the maintainers' manual backlog runs of 2026-11-17 and 2026-11-18 and from
implementation-check. Rules that guard a write are also enforced in code; follow them anyway.

## States

A state says whose move it is **and** whether that move is due now. Pick the first that applies:

1. `close`: the work the issue asks for is done. Every part of it maps to a pull request of this
   repository that is **merged** (the timeline's cross-reference shows `merged_at`), or to what the
   cheat sheet on the default branch says now. Propose `issue.close` with `stateReason:
"completed"` and a short thank-you comment that names the PR, and give each merged PR as
   `merged_pr` evidence (`ref` `"#<n>"`).
   - This is the most common reason a finished issue is still open: GitHub closes an issue only
     when the merged PR says "Fixes #N", "Closes #N" or "Resolves #N". A PR that says "Part of #N",
     "as agreed in #N" or just "#N" leaves the issue open. So an open issue whose one requested
     change was merged is `close`, even if nobody said so in the thread.
   - Not evidence: a PR title alone, an open PR, or a PR closed without merging. If one part of a
     multi-part issue is still open, the issue is not `close`.
2. `no_action` because a pull request carries the work: a linked PR of this repository is **open**.
   The conversation, the review and any ping belong on that PR (reviewed separately), not on the
   issue. This holds even when the author asks a maintainer in the issue to look at the PR.
3. `no_action` because it is a maintainer's own task: every assignee is a maintainer listed below.
   Never ping a maintainer about their own task. If a maintainer and a contributor are both
   assigned, the contributor is the one doing the work: judge their activity.
4. `waiting_maintainer`: the last open question, request or offer in the thread is addressed to a
   maintainer and no maintainer has answered it. This includes one maintainer asking another, and
   a volunteer asking to take an accepted, unassigned issue. Once the re-ping wait in the
   preferences has passed, propose one comment to the maintainer who was asked (or one listed
   below); before that, the state is `no_action`.
5. `waiting_author`: the next move is the assignee's (or the reporter's) and their last activity
   is older than the status-ping wait in the preferences. Activity is their last comment, their
   last PR opened, or the merge of their last PR, whichever is latest. Propose one short status
   question. Do **not** unassign in the same step: unassign only when an earlier status question
   from a maintainer went unanswered for the further wait, or when the assignee's scoped part is
   merged (see Assignments).
6. `needs_fix_by_us`: only when nothing above applies and the issue's only problem is a label or an
   assignment a maintainer would fix without discussion.
7. `no_action`: anything else where work is in progress and nothing is due (activity within the
   wait, a question asked less than the wait ago, a freshly accepted issue nobody has taken yet).

Other states: `untriaged_leave_to_triage` (nobody accepted the issue; triage owns it; no action).
`needs_full_review`, `needs_rereview` and `ready_to_merge` are pull request states; an issue is never
in them. `unknown`: none fits; describe what you saw in `reason`.

**Label and assignment hygiene does not decide the state.** If an assigned issue still carries
`HELP_WANTED`, for example, keep the state the thread is in (often `no_action`) and add the label
fix as one of its actions.

## Whose move

Work it out from GitHub's data, never from labels or from what someone claims:

- who is assigned, and when they were assigned;
- the last comment by the assignee or reporter versus the last comment by a maintainer;
- linked pull requests in the timeline: open (and when last updated), merged, or closed unmerged.

Labels such as `WAITING_UPDATE` or `HELP_WANTED` are often stale. You may propose to fix them; do
not read them as facts.

## Assignments

- An assignee with no linked PR and no comment for the status-check time gets one polite status
  question. After a further wait with no answer, propose `issue.unassign` and `HELP_WANTED`.
- An assignee who took a **scoped** part ("I'll fix only the quotes") and whose part is merged
  while the issue has more to do: thank them, unassign them, and keep or add `HELP_WANTED`. Someone
  working through a multi-part issue in several PRs ("waiting for your next PRs") is not done after
  one merge: when their last activity is older than the wait, ask for a status instead.
- A volunteer who asks to take an unassigned, accepted issue: propose `issue.assign` and a short
  welcome. A volunteer whose offer depends on something else ("after PR X merges") is
  `waiting_author`, with no assignment yet.
- Someone who already has several open assignments or pull requests in this repository is asked to
  finish those first.

## Label hygiene

- An assigned issue does not carry `HELP_WANTED`.
- `WAITING_UPDATE` goes once the person it waited for has pushed or replied.

## Comments

- One comment per issue per proposal. Never ping the same people about the same thing again
  within the cooldown in the preferences.
- Do not step on a live conversation: if a maintainer commented in the last few days, the move is
  usually theirs, so leave it and say so.
