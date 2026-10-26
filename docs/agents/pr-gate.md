# pr-gate

- Version: 0.1.0 · Mode: **hotl**, closing enabled (`PR_GATE_ENFORCE="true"`)
- Repositories: OWASP/CheatSheetSeries, and mackowski/custodes-sandbox for tests (ADR 0012)
- Class: `workers/agents/src/agents/pr-gate.ts` · Logic: `workers/agents/src/agents/pr-gate/`
- Policy: `agents.pr-gate` (`pr.close`, 5/h) and `reads.pr-gate` (`pulls`, `pull_files`, `issue`,
  `issues`, `comments`).
  ADR 0011, ADR 0013.

## Purpose

Checks every open community pull request against the project's
[contributing guide](https://github.com/OWASP/CheatSheetSeries/blob/master/CONTRIBUTING.md).
It closes the PRs that break it, with a signed comment explaining why and what to do next.

The decision ladder is deterministic rules first, then Jev, then a human. No LLM is used.

| Step | Check                                                                                                                      | Outcome                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | Author is `dependabot[bot]` (checked first), another bot, owner, member or collaborator; PR is a draft or `WAITING_UPDATE` | skip                                                                      |
| 2    | "AI Tool Usage Disclosure" section with nothing ticked (a missing section is flagged)                                      | **close** `ai_disclosure`                                                 |
| 3    | A linked `ACK_OBTAINED` issue is assigned to the author                                                                    | skip (compliant)                                                          |
| 3    | A linked `ACK_OBTAINED` issue is assigned only to others                                                                   | **close** `assigned_to_other`                                             |
| 3    | A linked `ACK_OBTAINED` issue is unassigned                                                                                | flag                                                                      |
| 4    | A file outside `cheatsheets/` or `cheatsheets_draft/` is changed                                                           | flag                                                                      |
| 4    | Files added or removed, or more than 60 changed lines                                                                      | **close** `no_approved_issue`                                             |
| 4    | Small edit to existing cheat sheets: Jev asks "minor fix?"                                                                 | p ≥ 0.70: skip · p ≤ 0.15 and `new_guidance`: **close** · otherwise: flag |

Both disclosure options ticked turns a skip into a flag; it is never a close on its own.

**Before every `assigned_to_other` or `no_approved_issue` close** (ADR 0013, after PR #2831), the
agent reads the comments on the PR and on every issue or PR its body links. It keeps only comments
by owners, members and collaborators. It drops the author's own comments, bots and agent
comments. From the rest it removes quoted lines, code blocks and HTML comments.

- **No maintainer comment:** the close goes ahead.
- **Otherwise:** Jev is asked whether a maintainer agreed that this author make this change.

| Jev answer                                                                      | Outcome                              |
| ------------------------------------------------------------------------------- | ------------------------------------ |
| p ≥ 0.85 and `approved`, and a kept comment names the author or is on the PR    | skip `maintainer_approved`           |
| p ≤ 0.2 and `rejected` or `unrelated`                                           | **close** (the original rule)        |
| anything else, or Jev unavailable                                               | flag `maintainer_maybe_approved`     |
| a "no" when Jev did not see every comment (a full page of 100, over 20, or cut) | flag `maintainer_comments_truncated` |

`ai_disclosure` closes skip this step, because agreement does not replace the disclosure.

## Inputs (all untrusted)

- PR list: title, body, author, labels and head commit.
- Changed files: names, line counts and patches.
- Linked issues: labels, assignees and state.
- Comments on the PR and linked threads (first 100 each), only before a close.
- The body is only matched with regexes. The diff goes to Jev inside `untrusted()`, clipped to
  30,000 characters.
- For the agreement question, Jev sees only the author's login, the names of existing cheat sheets
  the PR modifies, and up to 20 maintainer comments of up to 1,400 characters each, never the PR
  title or body. Everything is inside `untrusted()`.

## Actions requested (must match policy)

`pr.close`. The broker posts the comment and then closes the PR. The comment is code-built text
plus the broker's signed trailer (agent, version, attestation id, verify link) and the UTC time.

## PAT scopes

`PAT_PR_GATE` is a **classic** PAT on the operator's account with **only `public_repo`**, expiring in
90 days or less. A fine-grained token is not possible for the OWASP organisation; ADR 0011's
amendment records the trade-off. The broker policy, not the token, confines the agent to `pr.close`
on OWASP/CheatSheetSeries. Rotate it per [rotate-pat](../runbooks/rotate-pat.md).

## Schedule / triggers

- **Every 4 hours, and at 05:30 UTC,** with the triage poll and prepare crons (`17 */4 * * *`, `30 5 * * *`): evaluates PRs that are new or changed,
  and only those untouched for at least 30 minutes.
- **On a webhook** (`pull_request` `opened` or `reopened`, on a repository with the hook installed):
  schedules a poll for the end of the PR's grace period, rounded up to a 5-minute slot. Events in
  the same slot share one poll. The event is only a hint: the poll lists and reads every PR through
  the broker as on a cron. Other actions (edits, pushes) and other events are ignored.
- **After a poll that skipped a PR still in its grace period:** schedules another poll for when the
  earliest of them settles, so an edit during the grace period does not wait for the next cron.
  This happens with or without a webhook.
- **One poll at a time:** a poll that starts while another runs (cron, wake-up, sandbox run) does
  nothing and schedules a wake-up for the next slot, so a PR is never decided or closed twice. A
  poll flag older than 15 minutes (a hung poll) is ignored, and a halted agent schedules nothing.
- With the webhook installed and the caps not reached, a PR that breaks the guide is closed about
  30–35 minutes after its last change; otherwise at the first poll after that.
- **07:00 UTC daily** (`0 7 * * *`): sends the summary e-mail. It lists closed PRs, PRs it would
  close, PRs that need a maintainer, and errors. Nothing is sent when nothing happened.
- **Caps:** at most 30 evaluations and 5 closes per poll, and 300 evaluations and 10 closes per UTC
  day. One PR is evaluated at most 4 times per UTC day (sandbox runs on demand are exempt), so a few
  PRs edited over and over cannot use up the daily budget; the summary names a PR that hits it. The broker also enforces 5 per hour. Closes over a cap are reported as "would close", and a
  "would close" is not decided again until a close is possible (enforcing and under the daily cap).

## Failure modes and what happens

| Failure                                       | What happens                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Jev unavailable, or a mistyped answer         | The PR is flagged for a human, never closed.                                                                                                                             |
| GitHub read failure                           | The PR is recorded as an error and retried next poll. The error appears in the summary.                                                                                  |
| Broker refuses the close (rate limit, halted) | Recorded as an error and retried next poll.                                                                                                                              |
| The comment posts but the close fails         | Signed and counted by the broker. The PR is flagged `close_failed` and not retried until new commits.                                                                    |
| A webhook delivery is lost or the hook is off | The next cron poll finds the PR. Unticking "Active" on the hook stops webhook wake-ups only; polls still schedule their own (kill switch or deploy to stop those).       |
| A burst of new PRs (233 on 2026-10-04)        | One poll per 5-minute slot and one at a time, at most 30 evaluations per poll, 300 per day and 4 per PR per day; closes stay capped per poll, per day and by the broker. |
| A maintainer reopens a PR the agent closed    | Reported once (`reopened_after_close`). The agent never acts on that PR again.                                                                                           |
| A link written in a form the parser misses    | Before a `no_approved_issue` close, the agent checks for an open `ACK_OBTAINED` issue assigned to the author and flags instead (`author_has_approved_issue`).            |
| More than five issue references in the body   | Never closed (`too_many_refs` flag) unless an approved, assigned one is among them.                                                                                      |

## Testing in the sandbox

Run `node e2e/sandbox/run.ts all` (see `e2e/sandbox/README.md`), or one step at a time:
`custodes agents run pr-gate --instance custodes-sandbox` judges open sandbox PRs at once (no grace
period, maintainers gated too), and `custodes agents report pr-gate --instance custodes-sandbox`
shows the e-mail without sending it.

## Turning closes off

pr-gate closes from its first deploy. To pause closing without stopping the agent, set
`PR_GATE_ENFORCE` to `"false"` in `workers/agents/wrangler.jsonc` in a reviewed PR: it keeps
evaluating and the summary lists "would close". To stop it entirely, use the kill switch.

## How to halt

`custodes agents halt pr-gate --reason "..."`. For a softer stop, set `PR_GATE_ENFORCE` to
`"false"` in a reviewed PR: the agent keeps evaluating and only reports.

## Jev transport

Jev is called directly at `https://openrouter.ai/api/alpha/decisions` (`JEV_TRANSPORT="direct"`)
with the `OPENROUTER_API_KEY` Worker secret, pushed by CI from the GitHub secret of the same name.
AI Gateway's `openrouter` provider returned 404 for the Decisions API on 2026-10-15 (ADR 0011).
When it supports it, set `JEV_TRANSPORT="gateway"` (path: `JEV_GATEWAY_PATH`). Check either route
with the `Diagnose` workflow's Jev step (`scripts/jev-smoke.ts --probe`).

## Clef shadow (ADR 0015)

Every Jev question is also sent to Cloudflare Clef (`@cf/cloudflare/clef`) through the `custodes`
AI Gateway, with the same state. Clef never decides: if it fails or times out (10 s; 60 s budget per
poll), the decision is the same and only the comparison row records the error.

- `model_comparisons` (agent SQLite, 180 days): per question, both probabilities and options,
  latency, tokens, errors, pr-gate's outcome and `human_verdict`. No PR or model text.
- `human_verdict` is set at the daily summary from GitHub (`merged`, `closed_unmerged` by someone
  else, possibly the author, `reopened` after our close) or by the operator:
  `custodes pr-gate verdict <pr> --question minor|approval --answer yes|no` (people only).
- `custodes pr-gate compare [--since <iso>] [--csv]` lists the rows; the e-mail has one
  "Jev vs Clef" line.
- Evals: both pr-gate suites run `shadow:clef` next to Jev, report only.

## Threat model

See ADR 0011.

- **An injected maintainer comment** (pasted text) can only push a PR towards skip or flag. Only
  OWNER, MEMBER or COLLABORATOR text reaches the agreement question, because GitHub sets
  `author_association`. A "yes" leaves the PR for normal review, and the summary lists it with
  its score.
- **An injected diff** can only push its own PR towards "minor" (skip or flag). A close needs
  either a structural rule or Jev at p ≤ 0.15 (confidently "not minor") plus the `new_guidance`
  label.
- **A wrong close** is public but reversible. It is signed, attested and listed in the next summary.
- **The close comment** contains no third-party or model text, and no @-mentions.
- **Mass closes** are bounded by the caps and the broker rate limit, and stopped by the kill switch.
