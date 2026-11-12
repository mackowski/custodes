# 0019. One-click triage proposals (triage-apply)

- Status: proposed
- Date: 2026-11-12
- Deciders: Jakub Maćkowski (round 1, 2026-11-09; round 2 answered by Claude on the operator's
  instruction and confirmed by the operator, 2026-11-12)

## Context

The triage digest proposes, per community issue, a comment, labels and an assignee
(proposal-review, ADR 0010). The operator applied them by hand on GitHub. Issue #108 asks for:

- approving a proposal from the e-mail and having it applied;
- comments that name people by their @handle (the prompt forbade @-mentions, so comments said
  "thanks to the other contributor");
- the issue author getting priority for assignment: assign the author if they offered, ask them if
  it is unclear, and only after they decline or stay silent for 2 days propose someone else who
  offered.

Two earlier constraints shape the answer. Every GitHub write goes through the broker, and an
approval link binds the operator's click to the exact action (ADR 0002, ADR 0017 amendment).
Agents may no longer share a Worker or a key with a different authority (ADR 0018, #103). The
decisions and the rejected options of both /grill-plan rounds are in #108.

## Decision

We will add a `triage-apply` agent in its own Worker, `custodes-triage-apply`, with its own
Keyholder key and its own broker entrypoint `TriageApplyBroker`. It has no model, cron, queue or
e-mail. `custodes-triage` (and no other Worker) binds its RPC entrypoint `TriageApplyIntake`. When
triage builds the digest, it passes each stored proposal over that binding. triage-apply reads the
issue again through the broker, drops anything the thread does not allow, and asks the broker for
**one approval for the whole proposal**. The digest shows the resulting link as "Review and apply".

The broker stores the proposal as a **bundle** on one approval record. The bundle holds 1-4 issue
actions in a fixed order (`issue.assign`, `issue.label.add`, `issue.label.remove`, `issue.comment`)
and a snapshot of the issue (state, labels, assignees, comment count). The link token is bound to
the hash of the actions plus the snapshot. When the operator approves, the broker reads the issue
again and runs nothing if it changed since the snapshot, or if the assignee or any `@login` is not
the author or a commenter. Otherwise it runs the actions in order through the normal pipeline,
stops at the first failure and consumes the approval once. The result page and the audit log show
each step.

We will add the broker action `issue.assign` (one login). The policy entry for triage-apply is a
widening, and this ADR is its link (invariant 4):

- mode `hitl`, so every action needs the approval;
- the sandbox only, until the evals and a sandbox end-to-end run pass;
- 30 actions per hour;
- 19 labels: the OWASP labels except `custodes_cheatsheet_review`;
- approvals live 168 h, with at most 50 pending (the broker default is 24 h and 20);
- `trailer: "hidden"`: comments carry only the HTML-comment trailer, no visible footer.

proposal-review no longer names an assignee. The model reports the author's intent
(`offered | declined | unclear`), who offered in their own comment, and whether to ask the author.
Code applies the rule. Our earlier question is recognised by its hidden trailer on a
maintainer-association comment. The 2 days are measured from that comment's GitHub timestamp, and
the specialist queues itself to review the issue again when they end. The model writes `{author}`
and `{commenter:N}`, and code puts in logins taken from GitHub. An unknown placeholder drops the
comment.

## Alternatives considered

- **A gateway-only `/admin/triage/apply` path with no agent:** proposed while agents could still
  impersonate each other. Isolation removed that reason, and it would put GitHub writes outside an
  agent identity.
- **A fourth identity in `custodes-triage`:** keys are per Worker, so it would share triage's key.
  Write authority would also sit next to three model-driven read-only agents.
- **Binding triage-apply from the shared `custodes-agents`:** this would put a write path into the
  shared Worker for the weeks before the triage cutover.
- **One approval per action, or one record per action created together:** a partial approve
  breaks all-or-nothing, and five links per issue defeats the point.
- **A digest page with checkboxes and "apply selected":** it weakens the binding between what is
  shown and what runs.
- **Editing the comment on the approval page:** it breaks the token-to-content binding. The
  operator writes their own comment instead.
- **The model writes `@login`, filtered afterwards:** a filter that misses one form notifies a
  stranger. With placeholders, the model never chooses who is named.
- **A visible trailer:** against the operator's decision (no mention of Custodes). The hidden one
  keeps `/verify` working.

## Consequences

- The operator applies a proposal with two clicks (open, approve) instead of four manual edits.
- A proposal that went stale between the digest and the click does nothing. The operator sees why
  and waits for the next digest.
- A bundle can stop half-way: assignment and labels are idempotent, the comment goes last, and the
  page lists what ran. Running it again needs a new proposal.
- No links until triage runs in `custodes-triage`: the shared Worker does not bind triage-apply.
  OWASP needs a policy PR after the evals pass.
- Posted comments look like the operator's own. This is an accepted risk, owned by the operator:
  readers cannot tell that a model drafted the text, and OWASP asks contributors to disclose AI use.
- pr-gate and cheatsheet-review skip comments with an agent trailer (`AGENT_TRAILER` matches the
  hidden one too), so an approved triage-apply comment never counts as a maintainer's agreement
  for them. proposal-review counts only a triage-apply comment by the posting account that names
  the author as our question (it starts the 2 days).

## Security considerations

- **Authority:** the triage-apply PAT (Triage role, no push) can assign, label and comment. The
  policy grants it only behind the per-bundle approval. It can never add the cheatsheet-review
  trigger label: that PAT is the operator's account, so cheatsheet-review's "who added the label"
  check would accept it.
- **Untrusted input:** proposals are built from model output over issue text. Logins come only from
  GitHub-set fields, and the broker checks assignees and mentions against the thread twice (when
  asked and when run). It counts every `@` not after a letter or digit as a mention, and refuses
  HTML character references (`&#64;` renders as `@`). The snapshot (state, labels, assignees,
  comment count, the issue's `updated_at` and a digest of every comment's id and `updated_at`)
  makes a click on a stale or edited view a no-op.
- **Bundle only:** the policy flag `bundleOnly` makes the broker refuse triage-apply's one-action
  approvals, so no request skips those checks.
- **Model-read intent:** "the author declined" comes from the model's reading and can be faked by
  an injection. The digest and the approval page say so, and an eval case covers it. Only the
  2-day silence is measured by code.
- **Trust boundary:** triage can only ask triage-apply to ask for an approval. The operator's click
  on a page that shows the exact actions is still the only thing that writes. The RPC binding is
  pinned by a binding test.
- **Audit:** every action has a signed attestation. Comments carry the attestation id in a hidden
  trailer, so `/verify` still works. The approval record keeps the whole bundle.
- **Kill switch:** `halt:triage-apply` stops new approvals and their execution (the broker checks
  it in both places).
