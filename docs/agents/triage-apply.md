# triage-apply

- Version: 0.1.0 · Mode: **hitl** (every action waits for the operator's approval of the bundle)
- Repositories: mackowski/custodes-sandbox and, since 2026-11-13, OWASP/CheatSheetSeries (after the
  evals and the sandbox end-to-end run passed; #108). Every bundle still waits for the operator.
- Worker: `custodes-triage-apply` (`workers/triage-apply/wrangler.jsonc`), with its own Keyholder key
  and broker entrypoint `TriageApplyBroker` (ADR 0018). It has no model, cron, queue or e-mail.
- Class: `workers/agents/src/agents/triage-apply.ts` · Logic: `workers/agents/src/agents/triage-apply/bundle.ts`
- Policy: `agents.triage-apply` (`issue.assign`, `issue.label.add`, `issue.label.remove`,
  `issue.comment`, 30/h, 18 labels, approvals live 168 h with 50 pending, hidden trailer) and
  `reads.triage-apply` (`issue`, `comments`). See ADR 0019 and #108.

## Purpose

Turns one triage proposal (assignee, labels, comment) into **one approval request**. The digest
e-mail shows a "Review and apply" link per proposal. The operator opens it behind Access and sees
exactly what will run, in order. One click on Approve makes the broker apply it, all or nothing.

## Inputs (all untrusted)

- The proposal from triage, over the `TriageApplyIntake` RPC. It is model output over issue text,
  re-validated (`ProposalInput`).
- The issue and its comments, read again through the broker on every call.

The model never chooses a person:

- the assignee comes from proposal-review's code rule (`specialists/assignment.ts`);
- `@logins` in the comment come from `{author}` / `{commenter:N}` placeholders, filled from GitHub's
  author and commenter fields.

## Actions requested (must match policy)

One bundle per issue, in this order:

1. `issue.assign`: one login, only for an unassigned issue, the author or a commenter.
2. `issue.label.add`: labels the issue does not have, from the 18-label allow-list (never an automation trigger:
   `custodes_cheatsheet_review`, `jules`).
3. `issue.label.remove`: labels the issue has.
4. `issue.comment`: the suggested comment, as shown, with only the hidden trailer.

## PAT scopes (classic, `public_repo`)

`PAT_TRIAGE_APPLY` on account `mackowski`, which is an **admin** of OWASP/CheatSheetSeries (push,
maintain, settings) and owns the sandbox. A leaked token can do all of that, on every public
repository the account can write to. OWASP allows no fine-grained token, so it is a classic token with **only
`public_repo`**, like pr-gate's (ADR 0011 amendment). That scope reaches every public repository
the account can write to; the broker policy limits it to `issue.assign`, `issue.label.add/remove`
and `issue.comment` on these two repositories, each behind the operator's approval. Expiry 90 days
or less (`docs/runbooks/rotate-pat.md`).

## Schedule / triggers

None of its own. Triage calls it while building the 07:00 UTC digest (custodes-triage only). The
broker runs a bundle when the operator approves its link.

## Failure modes and what happens

| Failure                                                    | Result                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| triage-apply halted, unreachable or its key not pinned yet | The digest says "no one-click link: <reason>"; nothing is asked.        |
| The proposal names someone outside the thread              | That part is dropped (`dropped`); the rest is proposed.                 |
| The issue changed between the digest and the click         | The broker runs nothing (`stale`); the page says so.                    |
| A step fails (GitHub error, rate limit)                    | Later steps do not run; the page lists done / failed / not run.         |
| 50 approvals pending, or more than 20 links in one digest  | "N more proposal(s) without a one-click link"; apply them by hand.      |
| A newer proposal for the same issue                        | The older approval is superseded (rejected) and its link stops working. |

Undo by hand on GitHub: unassign, re-label, delete the comment. The audit log
(`custodes audit list --agent triage-apply`) lists every step with its attestation.

## How to halt: `custodes agents halt triage-apply --reason "..."`

You can also use the kill-switch page behind Access. Halting stops new approval requests and the
running of approved bundles: the broker checks the switch in both places.

## Threat model (from /threat-model)

**Assets:**

- the operator's GitHub identity (the PAT posts as `mackowski`);
- contributors' trust in what appears under that name;
- the approval link.

**Trust boundaries:**

- issue text → model (proposal-review) → stored proposal → triage-apply → broker → operator's
  click → GitHub.

| STRIDE                 | Threat                                                                      | Mitigation                                                                                                                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Another agent or Worker asks for approvals as triage-apply                  | Own Worker and key (ADR 0018); broker admits `triage-apply` only on `TriageApplyBroker`; only `custodes-triage` binds the intake (binding test).                                                                                                                                            |
| Spoofing               | A commenter fakes "our question" to start the 2-day clock                   | Only a comment by the account triage-apply posts as (`applyActor`), with a maintainer association and the hidden trailer, that names the author counts (`askedAuthor`).                                                                                                                     |
| Tampering              | What runs differs from what the page showed                                 | Token bound to the hash of actions + snapshot; no editing on the page; GET never decides.                                                                                                                                                                                                   |
| Tampering              | The issue changes after the digest (new comment, edit, label, assignee)     | Snapshot (incl. the issue's `updated_at` and a digest of every comment's id and `updated_at`) re-checked by the broker at the click; any difference runs nothing.                                                                                                                           |
| Repudiation            | Who applied what                                                            | Approval record (who decided, when), one signed attestation per step, hidden trailer with the attestation id on the comment.                                                                                                                                                                |
| Information disclosure | The model names or pings strangers (`@victim`)                              | Placeholders only; code fills logins from GitHub; HTML character references stripped and refused; triage-apply and the broker (twice) refuse any assignee or `@login` (any `@` not after a letter or digit) outside author + commenters; `bundleOnly` closes the one-action approval route. |
| Denial of service      | A flood of proposals fills the approval queue                               | 20 links per digest, 50 pending, a newer bundle supersedes the older one, 30 actions/h.                                                                                                                                                                                                     |
| Elevation of privilege | Injection makes the model assign itself or a friend ("a maintainer agreed") | The model only reports intent and volunteers; code assigns the author first, a volunteer only after a decline or 48 h of silence after our question; eval injection cases (#108).                                                                                                           |
| Elevation of privilege | triage-apply adds the cheatsheet-review trigger label                       | The label is not in its allow-list (policy test): the PAT is the operator's account, so cheatsheet-review would accept the label as the operator's.                                                                                                                                         |
| Elevation of privilege | A bundle aimed at a pull request                                            | Bundles are issue actions only (schema); the broker refuses a number that is a pull request.                                                                                                                                                                                                |

**Accepted risks (operator):**

- Comments carry no visible disclaimer and no mention of Custodes, so readers cannot tell a model
  drafted them. The audit log keeps the record.
- Approved comments are maintainer comments for our own agents (pr-gate's maintainer-agreement
  check, ADR 0013): the operator approved the exact text.
