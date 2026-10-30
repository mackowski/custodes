# AI-native SDLC

Custodes is developed with Claude Code as the primary author and humans as reviewers and
approvers. The repository encodes how that works so every session behaves the same way.

## Building blocks

| Mechanism         | Where                                      | Purpose                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE.md`       | repo root                                  | short always-on map and invariants                                                                                                                                                                                 |
| Skills            | `.claude/skills/*`                         | repeatable procedures: `/grill-plan`, `/new-agent`, `/new-tool`, `/threat-model`, `/agent-security-review`, `/adr`, `/eval`, `/preview`, `/release`; background knowledge: `custodes-conventions`, `cf-agents-sdk` |
| Subagents         | `.claude/agents/*`                         | `security-reviewer` (read-only, high effort), `cloudflare-researcher` (docs lookups), `test-writer`                                                                                                                |
| Hooks             | `.claude/settings.json`, `.claude/hooks/*` | deny deploys/secret access from sessions, format on edit, typecheck on stop                                                                                                                                        |
| Permissions       | `.claude/settings.json`                    | allow the routine, deny the dangerous                                                                                                                                                                              |
| Agent memory      | `.claude/agent-memory/*`                   | committed learnings for subagents                                                                                                                                                                                  |
| Cloudflare plugin | `.claude/settings.json` → `enabledPlugins` | official `cloudflare` skills (Agents SDK, Wrangler, Access, Email, Durable Objects) and the Cloudflare MCP server, installed per https://developers.cloudflare.com/agent-setup/                                    |
| GitHub Actions    | `.github/workflows/*`                      | CI, security scans, evals, Claude review, reviewer-gated deploys                                                                                                                                                   |

## The loop for a change

1. **Issue** describes the outcome. For agents, use the "Agent proposal" template.
2. **Plan** in Claude Code plan mode, and keep the plan in the issue or the PR description.
3. **Grill** the plan with `/grill-plan` before writing code. It asks every open decision in
   rounds, each with a recommended answer, using the Custodes question bank (authority, untrusted
   input, failure, cost, evals, rollout). It ends with a "Design decisions" section next to the
   plan, and with `/adr` or `/threat-model` follow-ups where needed. Required for a new agent, a
   new broker action, a policy widening, a prompt or output schema change, a model choice, and
   architectural decisions; skip it for changes with no design decisions.
4. **Build** with the matching skill (`/new-agent`, `/new-tool`) so nothing is forgotten; the
   skill ends by listing every file touched.
5. **Verify locally**: hooks typecheck on stop; run `pnpm check`; `/eval <agent> --run` when a
   prompt or schema changed.
6. **Review**: `/agent-security-review` (delegates to `security-reviewer`), fix, then open the PR
   with the template's security-impact section filled in.
7. **CI**: lint, typecheck and tests (one `check` job), CodeQL, gitleaks, Semgrep, dependency
   review, Terraform scan, evals, and Claude code review and security review as PR comments. The
   `main` ruleset requires `check`, `codeql`, `gitleaks`, `dependency-review`, `semgrep` and
   `terraform-scan`. Evals (`promptfoo`) and Claude review (`review`) are advisory. Evals run on a non-draft PR only when a prompt, output schema, model choice, the untrusted-data rules or the evals change (paths in `.github/workflows/evals.yml`), never on a draft; otherwise run them by hand. The free scans (CodeQL, gitleaks, Semgrep, dependency review, Terraform scan) run on every push, drafts included; `pnpm scan` runs Semgrep, gitleaks and actionlint locally in under a minute. Run evals
   yourself before merging a prompt or schema change. Limits of Claude review:
   - It runs only for same-repo, non-draft, non-dependabot PRs: once when the PR is opened or marked
     ready, and again whenever someone adds the `claude-review` label (the workflow removes the label
     afterwards). Pushes do not re-run it. The security review is skipped when every changed file is
     documentation. Each review is capped with `--max-budget-usd` (2 and 3 USD), and the job
     summary shows what each one cost.
   - It skips itself on a PR that changes `.github/workflows/claude-review.yml`, and the check
     still reports success (seen on #17): `claude-code-action` only runs a workflow identical to
     the one on `main`. That protects the action's own invocation, not Anthropic access. The job
     gets a short-lived Anthropic token through workload identity federation (ADR 0014), and a
     `pull_request` run uses the PR's workflow file, so anyone who can push a same-repo branch can
     mint one. That is accepted because only collaborators with write access can push a branch,
     and it is why the job never runs for forks.
   - The skill, subagent, agent memory, `.claude/settings.json` (including its hooks, which run as
     shell inside the review process) and `CLAUDE.md` all come from the PR branch. The review
     therefore runs with collaborator trust and a PR can steer its verdict. That is why it is
     advisory and must never become a required check.
   - Code review is expected to comment once per PR. The workflow posts the security review's report as one
     comment starting `Custodes agent security review:`, with its verdict.
   - A green `review` check without such a comment means it did not run. The "Review diagnostics"
     step shows which tools ran, which were denied and the outcome. The transcript itself is
     hidden on purpose.
8. **Human review** by a CODEOWNER. AI-written code is reviewed like any other code.
9. **Merge to `main`** deploys to the single production environment after the protected
   environment's reviewer approves the run. New agents start against a test repository you own;
   widening their policy to a real repository is its own reviewed PR (ADR 0007).
10. **Operate** with the `custodes` CLI; incidents follow the runbooks and feed the eval corpus.

## Rules that keep this safe

- Sessions cannot deploy, write secrets, apply Terraform, or force-push; CI does, after review.
- Anything that widens what an agent may do is a policy diff, reviewed by a human, with an ADR or
  issue linked.
- Prompts and schemas change only with evals; injection cases are never deleted, only added.
- If a skill or hook gets in the way, change the skill in a PR; do not work around it.
