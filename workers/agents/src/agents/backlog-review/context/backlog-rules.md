# Backlog rules for issues (#132 v1)

These rules come from the maintainers' manual backlog runs of 2026-11-17 and 2026-11-18 and from
implementation-check. Rules that guard a write are also enforced in code; follow them anyway.

## States

- `close`: the work the issue asks for is done. Every part of it maps to a pull request of this
  repository that is **merged** (the timeline shows it), or to what the cheat sheet on the default
  branch says now. Propose `issue.close` with `stateReason: "completed"` and a short thank-you
  comment that names the PR, and give each merged PR as `merged_pr` evidence. A PR title alone is
  not evidence, and an open or closed-unmerged PR is not either. If one part is still open, the
  issue is not `close`.
- `waiting_author`: the next move is the assignee's or the reporter's (an answer, a PR, a fix). If
  nothing happened for the time in the preferences, propose a short status ping to them.
- `waiting_maintainer`: a contributor asked a maintainer something, or volunteered, and no
  maintainer answered. Propose a comment that mentions one maintainer listed below once the wait
  in the preferences has passed; otherwise no action.
- `needs_fix_by_us`: labels or assignment are wrong in a way a maintainer would fix without a
  discussion (see label hygiene). Propose the label or assignment change.
- `untriaged_leave_to_triage`: nobody accepted the issue yet; triage owns it. No action.
- `no_action`: work is in progress and nothing is due (an assignee active recently, an open PR
  updated recently, a maintainer's own task).
- `needs_full_review`, `needs_rereview`, `ready_to_merge`: pull request states; an issue is never in
  them.
- `unknown`: none of the above fits. Describe what you saw in `reason`.

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
- An assignee whose part is merged while the issue has more to do: thank them, unassign them, and
  keep or add `HELP_WANTED`.
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
