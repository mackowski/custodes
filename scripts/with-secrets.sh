#!/usr/bin/env bash
# Run a command with Custodes secrets exported from the macOS Keychain. Nothing is written to disk.
#
#   ./scripts/with-secrets.sh set CLOUDFLARE_API_TOKEN      # prompts once, stores in Keychain
#   ./scripts/with-secrets.sh terraform -chdir=infra/terraform/envs/prod plan -var-file=prod.tfvars
#   ./scripts/with-secrets.sh sh -c 'pnpm dev --var AI_GATEWAY_TOKEN:"$AI_GATEWAY_TOKEN"'
#
# Items live under account "custodes" in the login keychain; one item per variable name.
# Set CUSTODES_SECRETS=op to read the same names from 1Password instead (op://Custodes/<NAME>/credential).
set -euo pipefail

NAMES=(CLOUDFLARE_API_TOKEN R2_STATE_ACCESS_KEY_ID R2_STATE_SECRET_ACCESS_KEY AI_GATEWAY_TOKEN APPROVAL_TOKEN_SECRET GITHUB_WEBHOOK_SECRET)
ACCOUNT=custodes

usage() { sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
[ $# -ge 1 ] || usage

if [ "$1" = "set" ]; then
  [ $# -eq 2 ] || usage
  name=$2
  printf 'Value for %s (input hidden): ' "$name" >&2
  IFS= read -rs value; echo >&2
  [ -n "$value" ] || { echo "empty value, nothing stored" >&2; exit 1; }
  security add-generic-password -U -a "$ACCOUNT" -s "$name" -w "$value" >/dev/null
  unset value
  echo "stored $name in the login keychain (account: $ACCOUNT)" >&2
  exit 0
fi

if [ "$1" = "list" ]; then
  for n in "${NAMES[@]}"; do
    if security find-generic-password -a "$ACCOUNT" -s "$n" >/dev/null 2>&1; then echo "  set    $n"; else echo "  unset  $n"; fi
  done
  exit 0
fi

load() {
  local n=$1 v
  if [ "${CUSTODES_SECRETS:-keychain}" = "op" ]; then
    v=$(op read "op://Custodes/$n/credential" 2>/dev/null || true)
  else
    v=$(security find-generic-password -a "$ACCOUNT" -s "$n" -w 2>/dev/null || true)
  fi
  # Missing items are fine: the command decides what it needs.
  if [ -n "$v" ]; then export "$n=$v"; fi
}
for n in "${NAMES[@]}"; do load "$n"; done

# R2 is Cloudflare storage that speaks the S3 protocol. Terraform's generic "s3" backend only
# knows the AWS_* variable names, so map our R2 token onto them for this process. No AWS involved.
[ -n "${R2_STATE_ACCESS_KEY_ID:-}" ] && export AWS_ACCESS_KEY_ID="$R2_STATE_ACCESS_KEY_ID"
[ -n "${R2_STATE_SECRET_ACCESS_KEY:-}" ] && export AWS_SECRET_ACCESS_KEY="$R2_STATE_SECRET_ACCESS_KEY"
exec "$@"
