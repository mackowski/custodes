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
6. **CI**: lint, typecheck, tests, CodeQL, gitleaks, Semgrep, dependency review, Terraform scan,
   evals, Claude code review and security review as PR comments.
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
