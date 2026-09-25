# Contributing

Custodes is built with an AI-native workflow: most code is written with Claude Code using the
skills in `.claude/skills/`, then reviewed by humans and by automated review. Read
`docs/sdlc.md` first.

## Quick rules

1. Every change goes through a pull request. No direct pushes to `main`.
2. Every new agent gets a threat-model section (`/threat-model <agent>`), a policy entry, a docs
   page, evals, and tests. The `/new-agent` skill scaffolds all of them.
3. Agents never receive credentials. If your change needs a token inside `workers/agents`, stop and
   redesign around `workers/github-broker`.
4. Untrusted text (issue bodies, PR diffs, emails) is wrapped with `untrusted()` from
   `@custodes/llm` before it reaches a prompt, and model output is validated with a zod schema.
5. Pin everything: exact dependency versions, GitHub Actions by SHA, Terraform providers.
6. Add a changeset (`pnpm changeset`) for user-visible changes.

## Local setup

```bash
./scripts/bootstrap.sh     # checks node, pnpm, wrangler, terraform, cloudflared
pnpm install
pnpm check                 # format, lint, typecheck, test
```

When you open the repo in Claude Code it asks to install the `cloudflare` plugin that
`.claude/settings.json` enables. Accept: it provides the official Cloudflare skills and MCP server
the workflow relies on.

## Commit and PR conventions

- Conventional Commits (`feat(agents): ...`, `fix(broker): ...`, `docs: ...`).
- Sign your commits (`git config commit.gpgsign true`).
- The PR template asks for the security impact of the change. Fill it in honestly.
