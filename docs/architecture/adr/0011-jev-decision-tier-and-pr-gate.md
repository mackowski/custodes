# 0011. Jev decision tier, and the pr-gate agent that closes non-compliant pull requests

- Status: accepted
- Date: 2026-10-15
- Deciders: Jakub Maćkowski

## Context

Most decisions the agents make are classifications: a yes/no or a choice among a few options. Using
Claude for them is slower and costs more than needed. TypeSafe's **Jev** (`typesafe/jev-1.14`),
served through OpenRouter's Decisions API (`POST https://openrouter.ai/api/alpha/decisions`):

- answers typed questions (`noul` yes/no, `choice`, `score`) about a `state` with probabilities;
- writes no free text;
- costs about $0.04 per million input tokens, with output free;
- switches to a slower, less accurate mode for states over about 32 KB.

The operator wants pull requests to OWASP/CheatSheetSeries checked against `CONTRIBUTING.md`, and
those that break it closed:

- An update or a new cheat sheet needs an approved issue (`ACK_OBTAINED`) assigned to the author.
- Typos, broken links and small corrections need no issue.
- The PR template says a PR with a blank AI disclosure "will be closed".

There are only three open PRs today, but the backlog of non-compliant contributions (often
AI-generated) is the reason for this agent.

## Decision

**Decision ladder.** Agents decide with deterministic code first, then Jev, then an LLM, then a
human (`packages/core/src/ladder.ts`).

- A rung either decides or passes the question up.
- A rung that throws passes it up too, so an outage never turns into a wrong decision.
- Thresholds are explicit bands per question.
- Only rule decisions and high-confidence model decisions may lead to side effects. "Human" always
  means flag, never act.
- An agent uses only the rungs it needs. pr-gate uses rule, Jev and human, with no LLM.

**Jev client.** `JevClient` lives in `packages/llm/src/jev.ts`; the pinned model id is
`MODELS.decision` in `packages/llm/src/models.ts`.

- The state is a branded `JevState`, which only `jevState()` produces. `jevState()` wraps the text
  with `untrusted()` and clips it to 30,000 characters.
- Answers are validated with zod. A missing or mistyped answer is an error.
- **Transport: direct (`JEV_TRANSPORT="direct"`).** The preferred route was AI Gateway's
  `openrouter` provider with the key stored in the gateway (BYOK). Diagnose run 38715467646
  (2026-10-15) showed the gateway answers **404** for every path that could reach
  `/api/alpha/decisions` (`api/alpha/decisions`, `alpha/decisions`, `v1/alpha/decisions`,
  `api/v1/alpha/decisions`), while the same request sent directly succeeded. So the agents Worker
  calls OpenRouter directly with `OPENROUTER_API_KEY`, a Worker secret pushed by CI from the GitHub
  secret of the same name. That key can only spend OpenRouter credit (the account has a credit
  limit) and grants no GitHub or e-mail authority. Without the gateway, the agent logs every Jev
  call itself (PR number, rung, score; no content) and OpenRouter's activity log holds the
  requests.
- The gateway transport stays in `JevClient` (`JEV_TRANSPORT="gateway"`, `JEV_GATEWAY_PATH`). Switch
  back when AI Gateway supports the Decisions API; `scripts/jev-smoke.ts --probe` in the Diagnose
  workflow tells. A key alone never switches the transport.

**pr-gate** (`workers/agents/src/agents/pr-gate*`) is a **hotl** agent, and the first one that writes
to GitHub. It runs with the triage poll and decides each open pull request again only when it changes:

1. **Exempt (skip):** `dependabot[bot]` (checked first, never closed), other bots, drafts, owners,
   members, collaborators, and PRs labelled `WAITING_UPDATE`.
2. **AI disclosure section with nothing ticked:** close (`ai_disclosure`). A missing section (the
   template was not used, or upstream renamed the heading) is flagged instead.
3. **Linked issues** (`#N` or issue URLs in the body, outside code spans; up to five are read, and a
   body with more is never closed):
   - Approved and assigned to the author: skip.
   - Approved and assigned only to others: close (`assigned_to_other`).
   - Approved and unassigned: flag.
4. **No approved issue:** apply a structural rule.
   - Only files under `cheatsheets/` count. Anything else is flagged.
   - Added or removed files, or more than 60 changed lines, mean the PR is not minor: close
     (`no_approved_issue`).
   - Otherwise, Jev judges the diff:
     - Minor with p ≥ 0.70 and a kind other than `new_guidance`: skip (0.85 until 2026-10-19).
     - p ≤ 0.15 and `new_guidance`: close.
     - Anything else: flag.

**Closing.** The close comment is code-built text: the rule, the guide section, what to do next, and
an invitation to comment or open an issue if the close was a mistake. It contains no PR text, no
model text and no @-mentions. It is posted by the new broker action `pr.close`, which comments
first and then closes, so a close never lacks its reason. The broker appends the signed trailer
(agent, version, attestation id, `/verify` link), and the comment states the UTC time.

**Caps and reporting.**

- Closes are capped at 5 per poll and 10 per UTC day by the agent, and 5 per hour by the broker.
- A daily e-mail (07:00 UTC, with the triage digest) lists what was closed, what would have been
  closed, what needs a maintainer, and errors.

**Closing from the first deploy.** The operator chose to enable closes immediately instead of a
dry run. CLAUDE.md invariant 3 (agents stay `hitl` until evals pass) is met: the pr-gate eval suite
passes 14/14 on the real Jev, including the injection cases. `PR_GATE_ENFORCE="true"` ships, and
setting it to `"false"` is a soft stop (decide and report "would close" only). The broker policy has
no `requiresApproval` for pr-gate, so its limits are the policy (`pr.close` on one repository),
the caps and the kill switch.

**Policy widening** (`workers/github-broker/policy/policy.json`, invariant 4):

- `BrokerAction` gains `pr.close {repo, pull, body}`.
- `ReadResource` gains `pulls`: a list of pull requests, honouring state, sort, direction and paging.
- `agents["pr-gate"]`:
  - `PAT_PR_GATE`, a **classic** PAT on the operator's account with only the `public_repo` scope
    (see "Amendment: classic PAT" below)
  - `hotl`, `actions: ["pr.close"]`, `rateLimitPerHour: 5`, `requiresApproval: []`
- `reads["pr-gate"]`: `pulls`, `pull_files`, `issue`.

## Alternatives considered

- **Claude for the minor-fix question.** Works, but costs about 100 times more and needs a prompt
  that produces free text. Jev's probability is enough for a yes/no, and an unsure answer goes to
  the operator.
- **An LLM rung behind Jev.** Dropped for pr-gate. It would only turn some flags into automatic
  decisions, and a flag costs the operator a glance in the daily mail.
- **hitl (approve every close).** Rejected by the operator: closes are reversible, signed and
  reported daily, and the PR author is a second human on the loop.
- **Readonly recommendations only.** Leaves the maintainer to do every close by hand, which is the
  work being automated.
- **Waiting for AI Gateway to support the Decisions API.** Would block the agent on a vendor
  roadmap; the transport switch is one var when it lands.
- **Proxying Jev through the broker to keep the OpenRouter key out of the agents Worker.** Stretches
  the broker's GitHub-only role for a key that carries no repository authority.
- **GitHub's `closingIssuesReferences` for linked issues.** The template's "This PR fixes issue #N"
  wording does not create one, and the field is GraphQL only. Parsing the body covers the
  template.

## Consequences

- PRs that break the guide are closed within about 5 hours (4-hourly poll plus 1-hour grace) with
  an explanation.
- Ambiguous cases reach the maintainer daily instead of piling up.
- Jev cost is negligible: one call per small, unlinked PR diff.
- The decision ladder and `JevClient` are reusable. Triage's classification is the next candidate.
- **Risks:**
  - A wrong close is public, though reversible and signed.
  - Contributors who forget to reference their approved issue are closed and must comment.
- OpenRouter's Decisions API is `alpha`, so a breaking change would make Jev calls fail. Those PRs
  are then flagged, never closed. The `Diagnose` workflow's Jev step detects such a change.

## Security considerations

- **Untrusted inputs:**
  - The PR body is used only for regex counting: checkboxes and issue numbers.
  - The diff reaches Jev only inside `untrusted()`, clipped. Jev produces numbers and enum labels
    that we validate, so the diff cannot make it emit instructions.
  - An injected diff can at most push its own PR towards "minor". That means a skip, which is
    harmless, or a flag.
  - A "not minor" close needs high confidence and the `new_guidance` label. The injection eval
    covers diffs that argue for either answer.
- **The PAT** is a classic `public_repo` token on the operator's account (amendment below), so the
  token itself is broad. What limits pr-gate is the broker: it allows only `pr.close` on
  OWASP/CheatSheetSeries for this agent, so pr-gate cannot merge, push or label, and it comments
  only as part of a close. The token never leaves the broker's Secrets Store binding.
- **Half-done closes:** `pr.close` comments first, then closes. If GitHub refuses the close after the
  comment posted, the broker signs the failure under the id already in the comment's trailer (so
  `/verify` works) and counts it against the hourly rate limit. The agent marks the PR
  `close_failed` and does not retry until the author pushes new commits, so a missing permission
  can never turn into a comment every poll.
- **Reopened PRs:** a PR the agent closed that is open again was reopened by a human. The agent
  reports it once and never acts on it again.
- **Spam closes** are bounded by the agent's daily cap and the broker's hourly rate limit, and
  stopped by the kill switch (`custodes agents halt pr-gate`).
- **Logs** hold PR numbers, rule names and scores only.
- `OPENROUTER_API_KEY` is a CI-managed Worker secret (ADR 0008), the first provider key held by a
  Worker rather than the gateway. It is never in files or logs, it is sent only to openrouter.ai,
  and it is limited by an OpenRouter credit cap.

## Amendment (2026-10-15): classic PAT for pr-gate

The operator cannot create a fine-grained PAT for the OWASP organisation, so `PAT_PR_GATE` is a
**classic PAT on the operator's account** with only the `public_repo` scope, the narrowest classic
scope that can close a pull request. This departs from ADR 0003 (per-agent fine-grained tokens) for
this agent only.

- **What the token could do if leaked:** write to every public repository the operator can reach,
  with the operator's maintainer rights across OWASP repositories. A fine-grained token would have
  been limited to one repository and to pull requests.
- **What still limits the agent:**
  - Only the broker reads the token (Secrets Store binding, never in files, logs or the agents
    Worker).
  - The broker policy allows pr-gate one action (`pr.close`) on one repository, with 5 per hour plus
    the agent's own caps.
  - The kill switch stops it.
- **Mitigations the operator applies:** `public_repo` only (no `repo`, `workflow`, `admin:*` or
  `delete_repo`); an expiry of 90 days or less with rotation per `docs/runbooks/rotate-pat.md`; and
  revoking it at once on any suspicion (`custodes agents halt pr-gate`, then delete the token on
  GitHub).
- **Attribution:** closes and comments appear on GitHub as the operator. The signed trailer and
  `/verify` link name the agent, and the comment says it was closed automatically.
- **Alternatives considered:**
  - A dedicated bot account with the Triage role would confine a leak to triage on one repository.
    The operator declined it for now.
  - A GitHub App installed on OWASP remains the migration target (ADR 0003).

## Amendment (2026-10-19): false close of PR #2801, safety net and event log

**What happened.** On 2026-10-17 pr-gate closed PR #2801 with `no_approved_issue`. The PR followed
the template, but it wrote the reference as a code span: ``This PR fixes issue `#2770`.``.
`linkedIssueNumbers` dropped code spans (added to ignore `#9` in pasted lint output), so the
agent saw no linked issue. #2770 was `ACK_OBTAINED` and assigned to the PR author. A maintainer
reopened the PR within an hour. The close also never reached the operator's e-mail: the next poll
saw the PR open again and overwrote the stored close with a `reopened_after_close` flag before
the 07:00 summary.

**Changes.**

- A code span that holds only a reference (`` `#123` ``, ``#`123` ``) counts as a reference.
  Longer spans and fenced blocks are still ignored.
- **Safety net:** before any `no_approved_issue` close, pr-gate lists open `ACK_OBTAINED` issues and
  flags the PR (`author_has_approved_issue`) instead of closing it when one is assigned to the
  author. A missed link can no longer close a contributor who did follow the guide.
- **Summary event log:** decisions are also appended to an `events` table, which is what the
  summary reports. A later state change for the same PR no longer hides an earlier close.

**Policy widening** (invariant 4): `reads.pr-gate.resources` gains `issues` (public issue list with
a single-label filter), which the safety net needs. No write grant changes.
