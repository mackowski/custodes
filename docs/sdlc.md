# AI-native SDLC

Custodes is developed with Claude Code as the primary author and humans as reviewers and
approvers. The repository encodes how that works so every session behaves the same way.

## Building blocks

| Mechanism         | Where                                      | Purpose                                                                                                                                                                                             |
| ----------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`       | repo root                                  | short always-on map and invariants                                                                                                                                                                  |
| Skills            | `.claude/skills/*`                         | repeatable procedures: `/new-agent`, `/new-tool`, `/threat-model`, `/agent-security-review`, `/adr`, `/eval`, `/preview`, `/release`; background knowledge: `custodes-conventions`, `cf-agents-sdk` |
| Subagents         | `.claude/agents/*`                         | `security-reviewer` (read-only, high effort), `cloudflare-researcher` (docs lookups), `test-writer`                                                                                                 |
| Hooks             | `.claude/settings.json`, `.claude/hooks/*` | deny deploys/secret access from sessions, format on edit, typecheck on stop                                                                                                                         |
| Permissions       | `.claude/settings.json`                    | allow the routine, deny the dangerous                                                                                                                                                               |
| Agent memory      | `.claude/agent-memory/*`                   | committed learnings for subagents                                                                                                                                                                   |
| Cloudflare plugin | `.claude/settings.json` → `enabledPlugins` | official `cloudflare` skills (Agents SDK, Wrangler, Access, Email, Durable Objects) and the Cloudflare MCP server, installed per https://developers.cloudflare.com/agent-setup/                     |
| GitHub Actions    | `.github/workflows/*`                      | CI, security scans, evals, Claude review, reviewer-gated deploys                                                                                                                                    |

## The loop for a change

1. **Issue** describes the outcome. For agents, use the "Agent proposal" template.
2. **Plan** in Claude Code plan mode; for architecture decisions, `/adr`.
3. **Build** with the matching skill (`/new-agent`, `/new-tool`) so nothing is forgotten; the
   skill ends by listing every file touched.
4. **Verify locally**: hooks typecheck on stop; run `pnpm check`; `/eval <agent> --run` when a
   prompt or schema changed.
5. **Review**: `/agent-security-review` (delegates to `security-reviewer`), fix, then open the PR
   with the template's security-impact section filled in.
6. **CI**: lint, typecheck and tests (one `check` job), CodeQL, gitleaks, Semgrep, dependency
   review, Terraform scan, evals, and Claude code review and security review as PR comments. The
   `main` ruleset requires `check`, `codeql`, `gitleaks`, `dependency-review`, `semgrep` and
   `terraform-scan`. Evals (`promptfoo`) and Claude review (`review`) are advisory. Run evals
   yourself before merging a prompt or schema change. Limits of Claude review:
   - It runs only for same-repo, non-draft, non-dependabot PRs.
   - It skips itself on a PR that changes `.github/workflows/claude-review.yml`, and the check
     still reports success (seen on #17): `claude-code-action` only runs a workflow identical to
     the one on `main`. That protects the action's own invocation, not the API key. A
     `pull_request` run uses the PR's workflow file and the secret is repository-scoped, so anyone
     who can open a same-repo PR can reach it. That is accepted because only collaborators with
     write access can push a branch, and it is why the job never runs for forks.
   - The skill, subagent, agent memory, `.claude/settings.json` (including its hooks, which run as
     shell inside the review process) and `CLAUDE.md` all come from the PR branch. The review
     therefore runs with collaborator trust and a PR can steer its verdict. That is why it is
     advisory and must never become a required check.
   - Code review is expected to comment once per PR. The workflow posts the security review's report as one
     comment starting `Custodes agent security review:`, with its verdict.
   - A green `review` check without such a comment means it did not run. The "Review diagnostics"
     step shows which tools ran, which were denied and the outcome. The transcript itself is
     hidden on purpose.
7. **Human review** by a CODEOWNER. AI-written code is reviewed like any other code.
8. **Merge to `main`** deploys to the single production environment after the protected
   environment's reviewer approves the run. New agents start against a test repository you own;
   widening their policy to a real repository is its own reviewed PR (ADR 0007).
9. **Operate** with the `custodes` CLI; incidents follow the runbooks and feed the eval corpus.

## Rules that keep this safe

- Sessions cannot deploy, write secrets, apply Terraform, or force-push; CI does, after review.
- Anything that widens what an agent may do is a policy diff, reviewed by a human, with an ADR or
  issue linked.
- Prompts and schemas change only with evals; injection cases are never deleted, only added.
- If a skill or hook gets in the way, change the skill in a PR; do not work around it.
