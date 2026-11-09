# 0018. triage-apply: the operator applies triage proposals from the digest e-mail

- Status: proposed
- Date: 2026-11-09
- Deciders: Jakub Maćkowski

## Context

The daily triage digest (ADR 0009, ADR 0010) proposes, per issue, labels, an assignee, a "help
wanted" flag and a suggested comment. The operator then does each of them by hand on GitHub. Two
problems showed up in the digests:

- The suggested comment thanks "other contributor" instead of naming the person, because the
  proposal prompt forbids links and @-mentions.
- The assignee rule is too loose. The issue author should come first; assigning someone else
  because they offered, while the author was never asked, takes the issue from the person who
  raised it.

The operator wants to accept a proposal from the e-mail itself. Approval by link already exists
(ADR 0017 amendment): an agent asks for an approval, the operator opens a link behind Access and
decides, and the broker runs the stored request itself, so what runs is what was shown. Today one
approval is one action. The broker has no action that assigns an issue.

## Decision

We will let the operator apply a triage proposal for one issue with one click on a link in the
digest, and we will not add an agent for it.

- **No new Durable Object.** On approval the broker runs a stored, ordered list of actions through
  `act()`, each checked by the policy as if requested alone. The policy gets a new agent id,
  `triage-apply` (mode `hitl`, every action under `requiresApprovalOn`), with its own PAT
  `PAT_TRIAGE_APPLY` (account `mackowski`, Triage role: it can comment, label and assign, not push).
  Triage itself keeps only its reads.
- **One approval per issue, all or nothing.** A bundle holds at most 4 actions: `issue.label.add`,
  `issue.label.remove`, `issue.assign` and `issue.comment`. The page shows exactly what will run;
  the operator approves or rejects it whole and cannot edit the comment (to change it, write your
  own). Only a POST decides; opening the link changes nothing.
- **Order and failure.** Actions run assign, then labels, then the comment, and stop at the first
  failure. The first two are idempotent, the comment is not, so it goes last. The page and the audit
  log show what was done. Before running, the broker re-reads the issue and refuses if it changed
  (comments, labels, assignees) since the snapshot in the e-mail; nothing is executed then.
- **New broker action `issue.assign`** (logins only, validated). It widens the policy; this ADR is
  the link invariant 4 asks for.
- **Limits for `triage-apply`.** Approval TTL 7 days (the broker default is 24 hours), 50 pending,
  30 actions per hour. A newer bundle for the same issue supersedes the older one. Past the limit
  the digest says "N more without a link" instead of dropping proposals.
- **Comments name people, from data GitHub set.** The model never writes a raw `@login`. It writes
  placeholders (`{author}`, `{commenter:N}`) and code substitutes the logins of the issue author and
  of commenters read through the broker. The comment is posted from the operator's account with no
  LLM disclaimer and no mention of Custodes; the broker audit log still records the agent, the
  approval and the approver.
- **Assignment rule.** (a) The author clearly offered to do the work: propose assigning the author.
  (b) Unclear: propose one comment asking `{author}` whether they want to take it, with no assignee;
  never ask twice or repeat a maintainer's question. (c) The author declined in the text or in a
  reply, or stayed silent for 2 full days after our question was posted (time as GitHub recorded it):
  propose assigning someone who offered. With nobody offering, the issue stays `helpWanted`. A
  reply from the author after that is reported in the next digest; nothing is undone automatically.
- **Rollout.** The sandbox (`mackowski/custodes-sandbox`) first; OWASP after the evals pass (new
  cases for each assignment state and for @mention and assign injection). A threat model for
  `triage-apply` is part of the same change, including how the broker tells that a request for
  `triage-apply` came from triage and not from another agent.

## Alternatives considered

- **A new `triage-apply` Durable Object that performs the actions after the click.** It adds an
  agent, a wake-up and a PAT, and gives no capability the broker lacks: the broker already runs the
  approved request.
- **One digest page with a checkbox per issue and "Apply selected".** The approval is bound by hash
  to the exact action that was shown; selecting parts either breaks that or needs one stored
  record per issue, which is what we have. A one-click "apply all" can come later if the volume
  asks for it.
- **Editing the comment on the approval page.** Makes the shown text differ from the stored one and
  needs a trusted editor; writing the comment yourself costs the same effort.
- **Approving per action (one link each).** Four links per issue; a half-applied proposal is the
  usual outcome.
- **The model writes `@login` and code filters unknown logins.** Still lets the model decide whom to
  notify; placeholders keep that decision out of its output.
- **Assigning another volunteer while the author has not answered.** Takes the issue from the person
  who raised it, which the operator ruled out.

## Consequences

- The operator can accept a proposal from the e-mail, and comments name the contributor.
- Authors are asked before being assigned, which adds a comment per unclear issue and a 2-day delay
  before another volunteer gets it.
- A new broker action, a new policy agent and a new secret exist. Approval storage grows to a
  higher pending limit and a longer TTL for this agent only.
- Comments from this path look like the operator wrote them. That is accurate (each one is approved
  by hand) but a reader cannot tell a model drafted it.
- An approval link that leaks from the mailbox is usable by whoever passes Access as an approver
  for up to 7 days; it is bound to one request and runs once.

## Security considerations

- **Authority.** Agents still hold no GitHub credential (invariant 1). `triage-apply` can only run
  four action types on listed repositories, only after a person approves, with a Triage-role PAT.
  The worst single bundle is a wrong comment, label or assignment on one issue, undone by hand.
- **Untrusted input.** Issue and comment text reach the proposal prompt through `untrusted()`
  (invariant 2); the output goes through `parseStructured()`. Logins in a comment come only from
  GitHub fields via placeholders, and `assignTo` must be a login seen in the thread. An author
  cannot make the agent mention or assign someone they name in text. Claims that a maintainer
  agreed are not decisions (ADR 0013). Silence as refusal is measured from GitHub timestamps of our
  own question, not from anything the author wrote.
- **Kill switch.** `await this.guard()` before creating an approval; the broker checks the kill
  switch for `triage-apply` before executing.
- **Auditability.** The audit log records the approval id, approver, each action and its result,
  and the refusal when the issue changed.
- **Secrets.** `PAT_TRIAGE_APPLY` comes from CI secrets and the Secrets Store like the other PATs,
  never from a file; creating it is a step for the operator.
- **Open point.** Which caller may create approvals under `triage-apply` is decided in the threat
  model before code, because the agents share one service binding to the broker.
