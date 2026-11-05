---
name: session-hooks
description: The repo's PreToolUse hook blocks any Bash command whose text contains deploy/secret command strings, even inside grep patterns; phrase searches differently
metadata:
  type: reference
---

A PreToolUse hook rejects Bash commands whose text matches deploy/secret-write commands (e.g. the wrangler secret subcommand) regardless of context, so a `grep "wrangler secret"` is blocked. Search for the binding names (`AI_GATEWAY_TOKEN`, `APPROVAL_TOKEN_SECRET`) or the workflow file (`.github/workflows/deploy-workers.yml`) instead. Deploy secrets are pushed by `cloudflare/wrangler-action` `secrets:` in that workflow.

**How to apply:** When a read-only grep is rejected by the hook, rewrite the pattern; do not disable the sandbox.

PostToolUse output contract (checked against Claude Code 2.1.318 on 2026-11-05 by grepping the binary at `~/.local/share/claude/versions/<v>`): `hookSpecificOutput.updatedToolOutput` is the current field and works for all tools. `updatedMCPToolOutput` is legacy and MCP-only. If a rewrite does not match the tool's output schema, or is too long, Claude Code falls back to the original output (fail-open), and `additionalContext` is still delivered. The cloudflare plugin declares a single MCP server named `cloudflare` (`https://mcp.cloudflare.com/mcp`), so its tools are `mcp__plugin_cloudflare_cloudflare__*`. The `untrusted-mcp.mjs` hook (C24) relies on all of this. Since 3fa2d57 the matcher is `mcp__plugin_cloudflare_.*`, so it covers every server of the plugin, and the operator checked by hand that a `whoami` result arrives wrapped. Third pass added `resource` blocks; round 4 (2026-11-05) confirmed `structuredContent` is now dropped. Remaining accepted gap (Info): other block types (`resource_link` name/description/uri, `annotations`, `_meta`) pass through unwrapped, covered only by the `additionalContext` notice.

Diff under review vs cwd branch: `/agent-security-review` may hand over a diff from another worktree (2026-11-05: cwd on `fix/implementation-check-thread`, diff was `fix/cheatsheet-review-round1` in `/Users/jakub.mackowski/custodes-csr`). Match the diff's file list against `git diff main...<branch>` and `git worktree list`, then read code from that worktree, not the cwd. The persisted diff can also lag the worktree HEAD (round 4 of #92: it lacked ac132cb). HEAD can also move during the review (round 6: 48d9604 landed mid-review; round 9: persisted diff stopped at e55ed2b, HEAD was 3ede3b1, so check for a marker symbol of the newest commit in the persisted file), so re-check `git log -1` before writing the report. Review HEAD and focus on the commits added since the last round.

Memory location: when the reviewer is launched with a subdirectory cwd (e.g. `workers/agents/src/agents`), the harness points memory at `<cwd>/.claude/agent-memory/security-reviewer/` and creates it empty. The canonical memory is the repo-root `.claude/agent-memory/security-reviewer/` (commit 095c404 untracked a stray nested copy). Read and write the repo-root one; never populate the nested dir.
