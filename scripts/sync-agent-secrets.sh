#!/usr/bin/env bash
# Push each agent's GitHub PAT from the CI environment into Cloudflare Secrets Store.
# For every agent in workers/github-broker/policy/policy.json, reads env var PAT_<AGENT_UPPER>
# (a GitHub Environment secret) and updates the Secrets Store entry github-pat-<agent>.
# Agents whose variable is unset are skipped with a warning, so a missing PAT never blocks a deploy.
set -euo pipefail
STORE_ID="${SECRETS_STORE_ID:?set SECRETS_STORE_ID}"
POLICY="$(dirname "$0")/../workers/github-broker/policy/policy.json"
agents=$(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).agents).join(" "))' "$POLICY")
for agent in $agents; do
  var="PAT_$(echo "$agent" | tr '[:lower:]-' '[:upper:]_')"
  value="${!var:-}"
  if [ -z "$value" ]; then
    echo "::warning::$var is not set; Secrets Store entry github-pat-$agent left unchanged"
    continue
  fi
  printf '%s' "$value" | pnpm --filter ./workers/github-broker exec wrangler secrets-store secret update "$STORE_ID" \
    --name "github-pat-$agent" --scopes workers --value-from-stdin --remote >/dev/null
  echo "updated github-pat-$agent"
done
