# 0022. Policy integrity: action registry, declared tier, boundary and strict schema

- Status: accepted
- Date: 2026-11-23
- Deciders: Jakub Maćkowski

## Context

`policy.json` is the only thing that bounds what an agent can do. Every PAT is a classic
`public_repo` token on the operator's account (ADR 0003, ADR 0011), so the token itself could do far
more. ADR 0021 defined trust tiers and left their enforcement to #139. Three gaps:

- `Policy` and `AgentPolicy` were plain `z.object`, which **strips unknown keys**. A misspelt
  `requiresAprovalOn` parsed cleanly and dropped the approval, so cheatsheet-review would have
  posted on OWASP without the operator's click. This is a fail-open.
- Nothing tied an agent to a tier. Granting `pr.review.inline` (T2) to a T1 agent looked like any
  other line in a diff.
- Invariant 4 (a widening needs an ADR or issue) was checked only by a regex on the PR body, and a
  widening was visible only as a raw JSON diff.

Decisions were taken in a `/grill-plan` round on #139.

## Decision

We will:

1. **Keep a registry of every broker action** with its `tier` (ADR 0021) and `risk`
   (`low | medium | high | critical`) in `packages/schema/src/tiers.ts`, typed as a `Record` over
   `BrokerActionType` so a new action does not compile without an entry. Risk is informational for
   now: it is recorded only and nothing reads it. A "critical needs an approval" rule
   comes with the first critical action (#143), so no hotl agent changes behaviour.
2. **Declare a `tier` per agent in `policy.json`.** The schema refuses a policy whose tier differs
   from the highest tier of the agent's actions, so the broker fails at startup and CI fails first.
   Read-only agents have no entry and are T0 (an entry added by mistake still declares its actions'
   tier, and the broker denies it anyway).
3. **Parse the policy strictly.** Unknown keys fail at every level (policy, agent, read). Only
   `$comment` and `$comment_<field>` with a **string** value are allowed; they are dropped before
   parsing. A non-string value fails, so a real field cannot hide under a comment key. (zod records
   skip a `__proto__` key instead of refusing it; that grants nothing, as it only drops an entry.)
4. **Add `boundary.json`, a policy-shaped ceiling**, next to `policy.json`. A test fails when the
   policy grants more than the boundary: an agent, repository, action, read resource or label it
   lacks; a higher tier, rate, approval TTL or pending cap; a looser mode; a dropped approval,
   `bundleOnly` or visible trailer; a different token binding. Today the boundary equals the
   policy. A PR that changes either file must name its ADR or issue in the "Authority" row
   (`scripts/pr-architecture.ts`).
5. **Make the boundary the operator's.** CODEOWNERS gives `boundary.json` its own line, and the
   ruleset `code-owners` (created 2026-11-23) requires a code owner's review, with a bypass for the
   Admin role through pull requests only. The code that enforces the boundary (`policy.ts`,
   `tiers.ts`, `policy-eval.ts`, `policy-boundary.ts` and its test, the core package's
   `vitest.config.ts` and `package.json` (they decide whether that test runs), `policy-diff.ts`, plus
   CODEOWNERS itself and the workflows that run the boundary test and the diff) has the same
   explicit lines, kept last in CODEOWNERS because GitHub applies the last matching line.
   Today the operator owns everything, so this changes nothing; once `policy/` has another code
   owner, they can change the policy inside the boundary, but widening the boundary needs the
   operator. **Nobody else gets the Admin role**, or they bypass that ruleset.
6. **Print a capability diff** of both files (agent × repository × action × approval, rates,
   labels, approval settings, reads) to the job summary of `pr-architecture.yml`, from
   `scripts/policy-diff.ts`. No PR comment, so the workflow keeps a read-only token.

The policy stays `version: 1`: every change adds fields, so there is nothing to migrate.

Broker content constraints for write actions (paths, size, new link domains; a T2 control in ADR 0021) are not part of this ADR: they come with the first T2 write action (#134).

## Alternatives considered

- Policy `version: 2` with a migration: nothing to migrate, all changes are additive.
- Risk driving approvals now: no action is critical today, and it could silently change hotl
  agents.
- Capability diff as a PR comment: needs a write token in CI for a one-operator repository.
- No `boundary.json`, with the declared tier as the only ceiling: enough for one operator, but it
  gives no protection once a second maintainer can edit the policy (operator decision).
- Declared tier "at least" the highest action tier: allows stale over-declared tiers; equality
  keeps the label honest.

## Consequences

- A misspelt policy field fails CI and the broker's startup instead of dropping a control.
- A T2 grant needs a tier change, which reviewers see, and which brings ADR 0021's T2 controls.
- Every widening edits two files, `policy.json` and `boundary.json`, in the same PR. With one
  operator this is mild friction; the boundary pays off when there are two maintainers.
- The operator merges their own PRs with "merge without waiting for requirements" (the
  `code-owners` bypass). Dependabot PRs need an approval or the same bypass.
- `/new-tool` adds a registry entry; `/new-agent` adds a boundary entry and a tier.
- The broker defaults for approval TTL and pending approvals now live in `packages/schema`
  (`DEFAULT_APPROVAL_TTL_HOURS`, `DEFAULT_MAX_PENDING_APPROVALS`), shared by the broker and the
  boundary check; `policy-diff.ts` keeps literal copies (it imports no workspace package), pinned
  by a test.

## Security considerations

- Closes the fail-open on unknown policy keys.
- Authority still lives only in `policy.json` and the broker's evaluation; the boundary and the
  diff run in CI and add no runtime path.
- The capability diff parses files from the pull request, which are untrusted: it executes nothing
  from them, and every table cell keeps only a safe character set. The script itself also comes
  from the pull request, so when a PR changes `scripts/policy-diff.ts` its summary is not evidence
  and the raw JSON diff is authoritative (the script needs the operator's review through CODEOWNERS).
- A failing boundary test blocks the merge: the `check` job of `ci.yml`, which runs it, is a
  required status check of the `main` ruleset, which has no bypass (as of 2026-11-24).
- The boundary protects against a second maintainer only while they lack the Admin role and the
  `code-owners` ruleset stays active. Rulesets are set by hand, not in Terraform.
