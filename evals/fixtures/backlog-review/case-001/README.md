# backlog-review golden case 001 (2026-11-17)

This is the first eval case for custodes#132 (backlog-review).

- `snapshot.json`: the state of every issue and PR in OWASP/CheatSheetSeries that was open at **T0 = 2026-11-17T07:30:00Z**, just before the manual run's first write. That is 10 PRs and 30 issues. It was rebuilt afterwards from GitHub timelines, and every event after T0 is filtered out. Each item has:
  - its body;
  - the timeline (comments, reviews, labels, assignments, commits, cross-references);
  - labels and assignees replayed to their T0 state.

  PRs additionally carry:
  - the head SHA at T0;
  - the diff against `master`, including patches;
  - review-thread comments;
  - the workflow runs on the T0 head.

- `golden.json`, with these parts:
  - per item: the expected state and actions, judged from the snapshot alone;
  - per item: what actually happened, and whether the session or the operator did it;
  - the lessons from mistakes made during the run;
  - the rules the operator gave mid-run (these belong in `operator-preferences`).
- `build_snapshot.py`: the script that produced the snapshot (`python3 -I build_snapshot.py OUT_DIR`, uses `gh api`).

Known limitations:

- For PRs that were force-pushed after T0, the head SHAs at T0 are hard-coded from the session's first read.
- Workflow-run `status` and `conclusion` are as of build time, not T0. Runs with `action_required` were held for fork approval at T0.
- Review-thread `isResolved` and `isOutdated` state at T0 cannot be reconstructed from REST, so only the comments are included.
- PRs 2999 and 2996 were closed at T0 and reopened during the run. They appear in `golden.json` under `arrived_during_run`, not in the snapshot.
- All data is public GitHub data from a public repository.

Scoring suggestion: score the agreement on `expected_state` per item, then on actions per action class. Treat the `lesson` entries as negative tests: the agent must not repeat them.
