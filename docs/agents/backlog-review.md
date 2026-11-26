# backlog-review

- Tier: **T1** (ADR 0021) · Version: 0.1.0 · Mode: **hitl** in the policy, **shadow** in code (`SHADOW`)
- Repositories: OWASP/CheatSheetSeries (hourly cron); mackowski/custodes-sandbox (on demand only)
- Worker: `custodes-backlog-review` (`workers/backlog-review/wrangler.jsonc`, entry `workers/agents/src/backlog-review-worker.ts`)
- Class: `workers/agents/src/agents/backlog-review.ts` · Policy: `workers/github-broker/policy/policy.json#agents.backlog-review`
- Runtime (ADR 0023): `agent.md` for the orchestrator and the `item-review` role in
  `workers/agents/src/agents/backlog-review/`, with its `context/` files
- Decisions: #132 (comment of 2026-11-26) · Threat model: [threat-model-backlog-review.md](../architecture/threat-model-backlog-review.md)

## Purpose

Reviews the open issues of the backlog: issues past triage's new-issue stream (accepted, assigned
or otherwise in progress). For each one it decides whose move it is and proposes that move:

- close the issue when merged pull requests did the work;
- ping the author or the assignee;
- re-ping a maintainer;
- fix labels or assignments.

v1 runs in **shadow**. Every proposed action goes only to the D1 digest `custodes-backlog`. The
operator reads the digest in Claude Code with `/backlog-digest` and acts by hand. Nothing reaches
GitHub from the agent.

## How a run works

1. **Selector** (hourly cron `41 * * * *`, code only, no model). It lists open issues and drops
   pull requests and triage's new issues (`isNewIssue`). It keeps an issue if it changed since its
   last verdict, or if that verdict is at least 72 hours old. Never-reviewed issues come first, then
   the oldest verdict, at most 20 per run. When nothing is due, no model is called.
2. **Orchestrator** (`agent.md`, tool `delegate`). It delegates each selected issue once to
   `item-review`.
3. **item-review** (`item-review/agent.md`) reads the issue, its comments and timeline, and when it
   needs to, the cheat sheets (`cheatsheet`, `cheatsheet_search`). It answers with a
   `BacklogVerdict`: state, actions, evidence, reason, confidence and `uncertainBecause`.
4. **Code** raises `needsHuman` below high confidence, on any doubt, and for `unknown`. It never
   lowers it.
5. **Dispatcher** applies its rules in shadow:
   - the target was read in this run;
   - the policy allows the action and label;
   - `issue.close` evidence is re-checked: a merged PR in the same repository whose own text named
     the issue before the merge.

   Each action goes to the digest with the route it would take live.

6. Each verdict and its routes are written to D1 as its child finishes, in one batch. A child that answers about another issue than the one it was given is stopped (`invalid_output`), and the orchestrator can delegate only the selected issues. Rows older than 90 days are deleted at the start
   of every run.

## Inputs (all untrusted)

- Issue title and body, comments, timeline events, labels and logins.
- Cheat sheet text and search hits.

All of these reach the model inside `untrusted()`. The task and today's date are code-built.

## Actions requested (must match policy)

`issue.comment`, `issue.label.add`, `issue.label.remove`, `issue.assign`, `issue.unassign` and
`issue.close`, with the OWASP labels except the automation triggers.

- In shadow, all of them are digest-only.
- They are granted so that shadow shows what live would do: dispatcher rule 2 drops an action the
  policy does not grant.
- `mode: hitl`: if shadow were turned off, each action would still wait for an approval link.

## PAT scopes

- `PAT_BACKLOG_REVIEW` has **no secret yet** (#132 v2), so the broker cannot run anything for this
  agent.
- Reads use `PAT_READONLY`.

## Budgets

- Orchestrator: 40 rounds, $1 per run.
- `item-review`: 20 rounds, $0.15 per child.
- Shared by all runs: $3 per day, per instance. There is one instance per repository; any other
  instance name is refused.
- Model: `claude-sonnet-5-5` via AI Gateway (BYOK).

## Failure modes and what happens

| Failure                                          | Effect                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kill switch `halt:backlog-review` or `halt:*`    | the run stops before any read; a run in progress stops at the next round or dispatch                                                                                            |
| Broker or GitHub read fails                      | the run ends with an error class in the log (no text); nothing recorded; the next cron tries again                                                                              |
| A child stops (caps, invalid output, read error) | a `stopped` row if it made a model call (the issue then waits for a change or 72 hours); none if a guard, the daily budget or an error stopped it first, so the issue stays due |
| Daily budget reached                             | runs stop before the model call; the issues wait for the next day                                                                                                               |
| A model call fails after it was billed           | that spend is not recorded (accepted risk, threat model of the runtime)                                                                                                         |
| Comment spam bumps many issues                   | at most 20 issues per run, oldest verdict first                                                                                                                                 |

## How to halt

`custodes agents halt backlog-review --reason "..."`. To kill one run and its tree, use
`custodes runs kill backlog-review-agent owasp-cheatsheetseries <runId>`. A run on demand: `custodes agents run backlog-review --instance owasp-cheatsheetseries` (or `custodes-sandbox`).

## Evals

- Suite: `evals/agents/backlog-review` (provider `evals/providers/backlog-runtime.mjs`).
- Golden case 001: 25 issues at T0 2026-11-17; the bar is ≥ 95% state agreement.
- Eight injection cases.
- Build the provider first with `evals/build-runtime.sh`.

## Threat model

See [threat-model-backlog-review.md](../architecture/threat-model-backlog-review.md). The main
risks:

- **The digest steering the operator's session.** Commands are built only from parsed actions,
  each is checked with `scripts/check-digest-action.sh`, and the operator gives one consent per
  action.
- **Cross-item and fake-evidence closes.** Covered by dispatcher rules 1-3 and the broker's evidence
  check.
- **Spam burning the budget.** Covered by the selector cap and ordering.
