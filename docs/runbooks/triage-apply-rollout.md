# triage-apply rollout (ADR 0019)

Get the one-click links in the triage digest working, sandbox first. Every step that writes is done
by the operator or by CI after review, never from a session (CLAUDE.md invariant 5).

## Before merging #106

1. On the GitHub account `mackowski`, create a fine-grained PAT:
   - repository `mackowski/custodes-sandbox` only;
   - Issues: read & write, nothing else.

   Store it as the GitHub Environment secret **`PAT_TRIAGE_APPLY`** (environment `prod`).
   deploy-workers syncs it into Secrets Store as `github-pat-triage-apply`. Terraform creates the
   entry with a placeholder (`prod.tfvars.example` lists `triage-apply`).

2. Confirm the round-2 decisions in #108. Claude answered them on the operator's instruction, and
   they are recommendations until confirmed.
3. Evals: `evals/agents/proposal-review` has 8 new cases (3 injections). They are a paid run: check
   the Anthropic balance first, then dispatch `Evals` for proposal-review only.

## After the merge deploy

1. deploy-workers deploys `custodes-triage-apply` before the gateway. Check
   `/admin/agent-keys`: triage-apply shows a key that is "not pinned".
2. Run **Agent key pin** (`agent-key-pin.yml`), then open and merge the PR it prepares. Until it
   merges, the broker refuses triage-apply (`unknown_key`), and the digest says "no one-click link".
3. Links appear only once triage runs in `custodes-triage`, after its cutover
   (`docs/runbooks/agent-cutover.md`). The shared `custodes-agents` deliberately does not bind
   triage-apply.

## Sandbox end-to-end

1. On the sandbox:
   - open an issue as a second account, without offering to do the work;
   - let triage and proposal-review run, then send the sandbox digest (`sandbox-e2e.yml`, "after
     all").
2. The digest shows "Review and apply" for the issue. The page lists the steps in order: the
   comment asks `@<author>` whether they want to work on it.
3. Approve. The result page shows each step done. On GitHub, the comment has no visible footer;
   its source has the `Custodes-Agent: triage-apply@…` HTML comment, and `/verify/<id>` checks it.
4. Stale check: open another proposal's link, add a comment to that issue on GitHub, then approve.
   Nothing runs, and the page says the issue changed.
5. Silence: 48 h after our question, with a volunteer comment and no reply from the author, the
   next digest proposes the volunteer.

## OWASP

When the evals and the sandbox run pass, open a policy PR that adds `OWASP/CheatSheetSeries` to
`agents.triage-apply.repos` and `reads.triage-apply.repos`, and to the PAT's repositories. Link it
to ADR 0019; it is a widening (invariant 4).

## Turn it off

- `halt:triage-apply` (kill-switch page) stops new approvals and the running of approved ones.
- Removing the `TRIAGE_APPLY` binding from `workers/triage/wrangler.jsonc` removes the links.
- Undo applied changes by hand on GitHub. `custodes audit list --agent triage-apply` lists them.
