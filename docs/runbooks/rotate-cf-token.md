# Rotate Cloudflare API tokens used by CI

Two tokens, stored as GitHub _Environment_ secrets (`ci` for plans and evals, `prod` for applies and deploys), never repository-wide:

| Secret                           | Scope                                                                                                                        | Used by              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `CLOUDFLARE_API_TOKEN_DEPLOY`    | Workers Scripts: Edit; Workers KV/D1/Queues: Edit; Account Settings: Read                                                    | `deploy-workers.yml` |
| `CLOUDFLARE_API_TOKEN_TERRAFORM` | Access: Apps and Policies Edit; Email Routing Edit; DNS Edit; AI Gateway Edit; Secrets Store Edit; Workers KV/D1/Queues Edit | `deploy-infra.yml`   |

1. Create the new token in Cloudflare → My Profile → API Tokens with the exact scopes above and,
   if possible, an IP filter for GitHub's runner ranges and a TTL.
2. Update the GitHub Environment secret. Re-run the last deploy workflow to confirm.
3. Roll the old token. Rotate every 90 days or immediately after any CI compromise.

Also rotate the R2 state credentials (`R2_STATE_*`) and the Access service token
(`terraform output -raw service_token_client_secret`) on the same schedule.

## Local copies

Secrets are never stored in files on a laptop. If you keep local copies for running
`terraform plan`, they live in the macOS Keychain under account `custodes` and are managed with
`scripts/with-secrets.sh set <NAME>` / `list`. Rotate them at the same time as the CI secrets, and
delete them when not needed: `security delete-generic-password -a custodes -s <NAME>`.
