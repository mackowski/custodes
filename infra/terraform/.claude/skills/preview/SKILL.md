---
name: preview
description: Upload a preview version of one Worker to Cloudflare without routing any traffic to it, from a clean and tested tree. Prints the preview URL. Only a human may invoke this; real deploys run in CI.
disable-model-invocation: true
argument-hint: gateway | agents | github-broker
allowed-tools: Bash(git status*), Bash(git branch*), Bash(pnpm typecheck*), Bash(pnpm test*), Bash(pnpm --filter ./workers/* exec wrangler versions upload*)
---

# Preview version: $ARGUMENTS

Custodes runs as a single environment. To try a build on real Cloudflare before it is deployed,
upload a _version_ that receives no traffic. Production traffic only moves when CI deploys after the
`prod` environment's reviewer approves.

Preconditions (stop if any fails):

- `git status --porcelain` is empty.
- `pnpm typecheck && pnpm test` pass.

Then: `pnpm --filter ./workers/$0 exec wrangler versions upload`

Report the version id and the preview URL. Note that the gateway is the only Worker with
`preview_urls` enabled; broker and agents previews are reachable only through service bindings.
