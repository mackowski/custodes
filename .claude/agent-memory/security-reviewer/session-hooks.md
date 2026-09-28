---
name: session-hooks
description: The repo's PreToolUse hook blocks any Bash command whose text contains deploy/secret command strings, even inside grep patterns; phrase searches differently
metadata:
  type: reference
---

A PreToolUse hook rejects Bash commands whose text matches deploy/secret-write commands (e.g. the wrangler secret subcommand) regardless of context, so a `grep "wrangler secret"` is blocked. Search for the binding names (`AI_GATEWAY_TOKEN`, `APPROVAL_TOKEN_SECRET`) or the workflow file (`.github/workflows/deploy-workers.yml`) instead. Deploy secrets are pushed by `cloudflare/wrangler-action` `secrets:` in that workflow.

**How to apply:** When a read-only grep is rejected by the hook, rewrite the pattern; do not disable the sandbox.
