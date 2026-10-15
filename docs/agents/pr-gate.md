# pr-gate

- Version: 0.1.0 · Mode: **hotl** (closes only while `PR_GATE_ENFORCE="true"`)
- Repositories: OWASP/CheatSheetSeries
- Class: `workers/agents/src/agents/pr-gate.ts` · Logic: `workers/agents/src/agents/pr-gate/`
- Policy: `agents.pr-gate` (`pr.close`, 5/h) and `reads.pr-gate` (`pulls`, `pull_files`, `issue`).
  ADR 0011.

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
| 4    | Small edit to existing cheat sheets: Jev asks "minor fix?"                                                                 | p ≥ 0.85: skip · p ≤ 0.15 and `new_guidance`: **close** · otherwise: flag |

Both disclosure options ticked turns a skip into a flag; it is never a close on its own.

## Inputs (all untrusted)

- PR list: title, body, author, labels and head commit.
- Changed files: names, line counts and patches.
- Linked issues: labels, assignees and state.
- The body is only matched with regexes. The diff goes to Jev inside `untrusted()`, clipped to
  30,000 characters.

## Actions requested (must match policy)

`pr.close`. The broker posts the comment and then closes the PR. The comment is code-built text
plus the broker's signed trailer (agent, version, attestation id, verify link) and the UTC time.

## PAT scopes (fine-grained)

`PAT_PR_GATE`: repository OWASP/CheatSheetSeries only, **Pull requests: read & write**.

## Schedule / triggers

- **Every 4 hours** with the triage poll (`17 */4 * * *`): evaluates PRs that are new or changed,
  and only those untouched for at least 1 hour.
- **07:00 UTC daily** (`0 7 * * *`): sends the summary e-mail. It lists closed PRs, PRs it would
  close, PRs that need a maintainer, and errors. Nothing is sent when nothing happened.
- **Caps:** at most 30 evaluations and 5 closes per poll, and 10 closes per UTC day. The broker also
  enforces 5 per hour. Closes over a cap are reported as "would close".

## Failure modes and what happens

| Failure                                       | What happens                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Jev unavailable, or a mistyped answer         | The PR is flagged for a human, never closed.                                                          |
| GitHub read failure                           | The PR is recorded as an error and retried next poll. The error appears in the summary.               |
| Broker refuses the close (rate limit, halted) | Recorded as an error and retried next poll.                                                           |
| The comment posts but the close fails         | Signed and counted by the broker. The PR is flagged `close_failed` and not retried until new commits. |
| A maintainer reopens a PR the agent closed    | Reported once (`reopened_after_close`). The agent never acts on that PR again.                        |
| More than five issue references in the body   | Never closed (`too_many_refs` flag) unless an approved, assigned one is among them.                   |

## Dry run and enabling closes

While `PR_GATE_ENFORCE="false"` the agent only reports "would close", and the broker policy requires
an approval for `pr.close` as a second gate. To enable closes, one reviewed PR sets
`PR_GATE_ENFORCE` to `"true"` in `workers/agents/wrangler.jsonc` and empties
`agents.pr-gate.requiresApproval` in the policy (also update the policy unit test).

## How to halt

`custodes agents halt pr-gate --reason "..."`. For a softer stop, set `PR_GATE_ENFORCE` to
`"false"` in a reviewed PR: the agent keeps evaluating and only reports.

## Jev transport

Jev is called directly at `https://openrouter.ai/api/alpha/decisions` (`JEV_TRANSPORT="direct"`)
with the `OPENROUTER_API_KEY` Worker secret, pushed by CI from the GitHub secret of the same name.
AI Gateway's `openrouter` provider returned 404 for the Decisions API on 2026-10-15 (ADR 0011).
When it supports it, set `JEV_TRANSPORT="gateway"` (path: `JEV_GATEWAY_PATH`). Check either route
with the `Diagnose` workflow's Jev step (`scripts/jev-smoke.ts --probe`).

## Threat model

See ADR 0011.

- **An injected diff** can only push its own PR towards "minor" (skip or flag). A close needs
  either a structural rule or Jev confidence of at least 0.85 on "not minor" plus the
  `new_guidance` label.
- **A wrong close** is public but reversible. It is signed, attested and listed in the next summary.
- **The close comment** contains no third-party or model text, and no @-mentions.
- **Mass closes** are bounded by the caps and the broker rate limit, and stopped by the kill switch.
