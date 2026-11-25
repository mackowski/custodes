# 0024. Generalised proposal approval and the cheatsheet-review label handoff

- Status: accepted
- Date: 2026-11-25
- Deciders: Jakub Maćkowski

## Context

ADR 0019 lets one agent (triage-apply) turn a proposal into one approval link: a **bundle** of 1-4
issue actions in a fixed order, bound to an `IssueSnapshot`, checked again when the operator
clicks, with comments allowed to @-mention only the issue author and commenters. It covers issues
only, and `bundleOnly` ties it to one agent.

The next agents (#132 backlog-review, then #133b and #134) run as model loops on the runtime of
#140 (ADR 0023). A run ends with one typed `Proposal`, and a deterministic dispatcher routes each
action by policy: shadow to the digest, `hitl` to an approval, `hotl` to `act()`. backlog-review
needs, beyond ADR 0019: pull requests as targets, closing issues (`issue.close` does not exist),
removing an assignee, @-mentioning a maintainer who has not answered, and handing a pull request to
cheatsheet-review for a full review.

Three accepted rules stand in the way of that handoff. ADR 0017 makes the `custodes_cheatsheet_review`
label the operator's decision to publish a review. ADR 0019 and its policy test forbid every
labelling agent from adding a label in `AUTOMATION_TRIGGER_LABELS`, because all PATs belong to the
operator's account and the trigger would take the agent's label as the operator's. ADR 0021 asks for
the handoff ADR to tell an agent's label from the operator's, to require an approval on every
repository for agent-started runs, and to cap them.

ADR 0022 recorded a `risk` per action and left "a critical action needs an approval" to this issue.

Decisions were taken in a joint `/grill-plan` with #140 (comments on #140 and #143, 2026-11-25).

## Decision

We will generalise ADR 0019 instead of adding a second approval mechanism, and let backlog-review
start cheatsheet-review by adding its label.

**One approval mechanism for issues and pull requests.**

- `ApprovalBundle` gets a `target` of `issue` or `pull` and a snapshot discriminated by it:
  `IssueSnapshot` as today, and a new `PullSnapshot` with `head_sha`, state, labels, assignees,
  `updated_at`, a comments digest and a reviews digest.
- A bundle still has one target. Its actions run in the fixed order of `BUNDLE_ORDER`:
  idempotent state first (assign, unassign, labels), then text (comment), then the state change that
  ends the thread (`issue.close`, `pr.close`), which is always last.
- The token stays bound to the hash of the actions plus the snapshot. The broker re-reads the target
  on approval and runs nothing if the snapshot changed.
- triage-apply moves to the new schema. Approval records written before the change still parse.
  `bundleOnly`, the hidden-trailer rule and the rest of ADR 0019 stay.

**New actions, all T1.** Each starts `hitl` and sandbox-only:

- `issue.close`: a body and `state_reason` (`completed | not_planned`). It posts the signed comment,
  then closes, like `pr.close`. Risk `high`: public, but a person can reopen it. GitHub's issue
  endpoints also accept a pull request number, so the broker always reads the target first and
  refuses `issue.close` on a pull request: closing one is `pr.close`'s grant.
- `issue.unassign`: one login. Risk `low`.

update-branch, approving held fork workflow runs and re-requesting a review come later, one
`/new-tool` each, in #132 v2.

**Risk drives approval.** A policy check in CI refuses any grant of a `critical` action that does
not need an approval on every repository. No grantable action is critical today.

**Mentions.** The policy gets a per-repository `maintainers` list of GitHub logins, changed only by
a reviewed policy pull request. A comment from an agent may @-mention the target's author, its
commenters and reviewers, and the listed maintainers of that repository, and nobody else. An
assignee still has to come from the thread: the list widens pings, not assignment. The check moves
from the bundle path into the broker's action pipeline, so a `hotl` comment gets it too. It keeps
ADR 0019's parsing: every `@` not after a letter or digit is a mention. The two comment rules it
depends on move with it: HTML character references (`&#64;x` renders as `@x`) and comment markers
are refused on every path. So are links and references to another repository, which would put
model text into someone else's timeline under the operator's name, except in `pr.close`: pr-gate's
code-built close comment links CONTRIBUTING.md (operator decision, 2026-11-25). Granting `pr.close`
to an agent whose close text comes from a model must revisit this exemption. These rules cover `issue.comment`, `issue.close` and
`pr.close`; cheatsheet-review's own `pr.review.inline` keeps its ADR 0017 rules (a fixed marker on
every inline comment, the operator's approval on OWASP).

**The label handoff.**

- backlog-review may add `custodes_cheatsheet_review`. It is the only agent with this exception,
  and the label is the only one: the policy test that forbids trigger labels gets a named, per-agent
  exception. `jules` stays forbidden for every agent. triage-apply gets no trigger label.
- cheatsheet-review does not try to tell who added the label. Its ADR 0017 trigger is unchanged:
  the latest `labeled` event must come from the configured actor, the operator's account, and every
  agent PAT belongs to that account. Any label added from that account starts a review.
- This is safe because every review on `OWASP/CheatSheetSeries` already waits for the operator's
  approval before it is posted (`requiresApprovalOn`, the cheatsheet-review exception in ADR 0021).
  On the sandbox repository a review posts without an approval.
- The broker caps backlog-review's `issue.label.add` of that label at 3 per repository per day.
  cheatsheet-review has no cap of its own. Before adding the label, backlog-review's dispatcher
  checks the pull request's reviews and does not ask again for a head SHA that already has a
  cheatsheet-review review.
- **Tied condition:** the policy schema refuses a grant unless cheatsheet-review keeps
  `requiresApprovalOn` for `pr.review.inline` on every repository it shares with the granted agent,
  except the sandbox. Removing that approval therefore needs label provenance first, so the broker
  can tell an agent's label from the operator's. This is the same condition that ends the
  cheatsheet-review exception in ADR 0021.
- The cap is checked before the label is added and counted from audit rows written after, so two
  adds at the same moment can both pass (as with the hourly rate limit). Accepted: every OWASP
  review still waits for the operator.

This ADR amends ADR 0017 (an agent may start a review), ADR 0019 (generic bundles, mention rule,
trigger-label exception) and ADR 0021 (the handoff conditions above replace the ones ADR 0021
listed).

## Alternatives considered

- **A second approval mechanism for pull requests next to ADR 0019:** two sets of snapshot and
  staleness logic to test and review.
- **Several targets per bundle:** one click would then change several threads, and one stale target
  would block the rest.
- **Every #132 action in this change:** each widening deserves its own test, policy entry and
  review.
- **A `review.request` action that calls cheatsheet-review over RPC without a label:** this was the
  recommendation. The operator chose the label: it is how maintainers already use the reviewer, it is
  visible on GitHub, and it needs no new trigger path.
- **Telling an agent's label from the operator's by the broker's attestation:** this is what ADR 0021
  asked for. It is unnecessary while every OWASP review needs the operator's approval, and it adds a
  lookup that can fail.
- **A daily cap or one run per head SHA in cheatsheet-review:** it cannot tell who added the label,
  so the cap would also limit the operator. Re-adding the label for a new review of the same commit
  stays allowed (ADR 0017).
- **Mentions by `author_association` (OWNER, MEMBER, COLLABORATOR):** that would let an agent ping
  any member of the OWASP organisation.
- **Keeping thread people only:** this blocks re-pinging a maintainer who has not answered, the main
  comment #132 needs.
- **Risk-based approval left for later:** the first critical action would land without the rule.

## Consequences

- Any agent on the #140 runtime gets one-click approvals for issues and pull requests without its
  own approval code.
- triage-apply changes schema but not behaviour. Its tests and evals have to stay green on the new
  bundle.
- backlog-review can hand a pull request to cheatsheet-review without the operator in the loop, at
  most 3 times a day per repository. On OWASP the operator still approves each review before it is
  posted. On the sandbox it posts at once.
- Removing the OWASP approval from cheatsheet-review is no longer a one-line policy change: it also
  needs label provenance.
- The maintainers list is a new thing to keep current. A maintainer missing from it cannot be
  pinged, which fails safe.
- A `hotl` comment that names a stranger is now refused by the broker, where before only bundles
  were checked. An agent that relied on free mentions (none today) would see refusals.

## Security considerations

- **Authority:** two new T1 actions (`issue.close`, `issue.unassign`) and one trigger label for one
  agent. All start `hitl` on the sandbox. OWASP needs a reviewed policy change after the evals and a
  sandbox end-to-end run pass. `hotl` follows ADR 0021: limits in code, evals with injection cases,
  and an agreement threshold in shadow.
- **Automation through the operator's account:** the trigger label added by backlog-review is
  indistinguishable from the operator's on GitHub. It is bounded by three things: the broker's
  per-agent allow-list and its 3-per-day cap, the operator's approval of every OWASP review, and the
  tied condition above. `jules` stays forbidden, since it would push code as the operator.
- **Untrusted input:** proposals come from model output over untrusted issue and pull request text.
  The broker re-reads the target, compares snapshots and checks every login against the thread and
  the maintainers list, at request and at execution. The dispatcher (ADR 0023) re-verifies the
  evidence an action needs. For `issue.close` that is a merged pull request that references the
  issue in its timeline, so an injected "this is done, close it" in another thread does not close
  anything.
- **Staleness:** `PullSnapshot` includes `head_sha`, so a push after the proposal turns the approval
  into a no-op, which fixes the "head moved between review and action" failure seen in the manual
  run (#132).
- **Half-completion:** state actions run first and the closing action runs last, so a bundle that
  stops early never closes a thread without its comment. A partial bundle is shown step by step on
  the result page and in the audit log, as in ADR 0019.
- **Audit:** every action is signed and attested as today. A comment carries the attestation id in
  its trailer, so `/verify` works. The label's attestation records that backlog-review added it,
  even though GitHub shows the operator.
- **Kill switch:** `halt:<agent>` stops new approvals and their execution, as in ADR 0019.
  `halt:cheatsheet-review` stops reviews whoever added the label.
