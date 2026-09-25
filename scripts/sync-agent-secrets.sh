#!/usr/bin/env bash
# Push each agent's GitHub PAT from the CI environment into Cloudflare Secrets Store.
#
# For every agent in workers/github-broker/policy/policy.json, reads the env var PAT_<AGENT_UPPER>
# (a GitHub secret) and writes it to the Secrets Store entry github-pat-<agent>: PATCH when the
# entry exists (Terraform creates it with a placeholder), POST when it does not. Agents whose
# variable is unset are skipped with a warning, so a missing PAT never blocks a deploy.
#
# Uses the REST API directly: wrangler's secrets-store commands prompt interactively for values.
# Requires: CLOUDFLARE_API_TOKEN (Secrets Store: Edit), CLOUDFLARE_ACCOUNT_ID, SECRETS_STORE_ID, jq.
set -euo pipefail
: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${SECRETS_STORE_ID:?}"
API="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/secrets_store/stores/${SECRETS_STORE_ID}/secrets"
POLICY="$(dirname "$0")/../workers/github-broker/policy/policy.json"

cf() { curl --silent --show-error --fail-with-body -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json" "$@"; }

# name -> id map of existing secrets (values are never returned by the API).
existing=$(cf "${API}?per_page=100" | jq -r '.result[] | "\(.name) \(.id)"')
agents=$(jq -r '.agents | keys[]' "$POLICY")
status=0
for agent in $agents; do
  var="PAT_$(echo "$agent" | tr '[:lower:]-' '[:upper:]_')"
  value="${!var:-}"
  name="github-pat-${agent}"
  if [ -z "$value" ]; then
    echo "::warning::${var} is not set; Secrets Store entry ${name} left unchanged"
    continue
  fi
  id=$(awk -v n="$name" '$1==n {print $2}' <<<"$existing")
  # The value goes through jq's --arg so it is never part of a shell command line or log.
  if [ -n "$id" ]; then
    body=$(jq -cn --arg v "$value" '{value: $v, scopes: ["workers"]}')
    if cf -X PATCH "${API}/${id}" --data "$body" >/dev/null; then echo "updated ${name}"; else echo "::error::failed to update ${name}"; status=1; fi
  else
    body=$(jq -cn --arg n "$name" --arg v "$value" '[{name: $n, value: $v, scopes: ["workers"]}]')
    if cf -X POST "$API" --data "$body" >/dev/null; then echo "created ${name}"; else echo "::error::failed to create ${name}"; status=1; fi
  fi
  unset value body
done
exit $status
