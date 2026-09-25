# Platform infrastructure (Terraform)

Terraform owns everything Wrangler cannot: Cloudflare Access applications and policies, Email
Routing, DNS, AI Gateway, Secrets Store, and the KV / D1 / Queues that Workers bind to. Each
Worker's `wrangler.jsonc` owns its own bindings and references the ids Terraform creates.

```
modules/
  access-app      Access application + policies + service token for the CLI/API
  email-routing   inbound rules: approve+*/reject+* → gateway, *@agents.<domain> → agents
  ai-gateway      authenticated gateway with logging, rate/spend limits, guardrails
  dns             records for the gateway custom domain and email (MX/SPF/DKIM/DMARC)
  secrets-store   the account Secrets Store and one PAT entry *name* per agent (values synced by CI)
  data-stores     KV (kill switch), D1 (audit), Queues (inbound + DLQ)
envs/
  prod            the single environment (ADR 0007); composes the modules
```

## State and credentials

- Remote state: Cloudflare R2 with the S3-compatible backend (bucket `custodes-tfstate`, one key per
  env). The bucket name and endpoint are inlined in each env's `main.tf`; neither is secret. Create
  the bucket once by hand; it is the only manually created resource.
- **No secrets in files, anywhere.** Credentials reach Terraform only through environment variables:
  `CLOUDFLARE_API_TOKEN` for the provider and an R2 API token (`R2_STATE_ACCESS_KEY_ID` /
  `R2_STATE_SECRET_ACCESS_KEY`) for the state backend. R2 speaks the S3 protocol, so Terraform's generic
  `s3` backend is used; there is no AWS account or service anywhere in this project. In CI they are GitHub Environment secrets. On a laptop they come from the macOS
  Keychain via `scripts/with-secrets.sh` (or 1Password with `CUSTODES_SECRETS=op`), which exports them
  into one process and nothing else. There is no `backend.hcl`, no `.env`, no `.dev.vars`.
- CI uses a dedicated Cloudflare API token (`CLOUDFLARE_API_TOKEN_TERRAFORM`) scoped to: Access:
  Apps and Policies, Email Routing, DNS, AI Gateway, Workers KV/D1/Queues, Secrets Store. It is
  _not_ allowed to edit Workers; that is the deploy token's job.
- Secret _values_ (PATs, attestation keys, gateway token) are never in Terraform. They are written
  with `wrangler secret put` / `wrangler secrets-store secret create` by an operator, see
  `docs/runbooks/rotate-pat.md`.

## Bootstrap order

Some resources depend on things Terraform cannot create or order:

1. `terraform apply` with `email_rules_enabled = false` (default): data stores, Secrets Store, AI
   Gateway, Access, SPF/DMARC records.
2. Enable Email Routing on the zone once, in the dashboard (Email → Email Routing → Get started) or
   with `POST /zones/{zone_id}/email/routing/enable`, then turn on plus-addressing with
   `PATCH /zones/{zone_id}/email/routing {"support_subaddress": true}` so `approve+<token>@`
   addresses match the `approve@` rule. Provider 5.25 cannot manage this resource.
   Done for `custodes.work` on 2026-09-25.
3. Deploy the Workers (CI). Routing rules reference `custodes-gateway` and `custodes-agents` by
   name and are rejected until the scripts exist.
4. Set `email_rules_enabled = true` and apply again.

## Workflow

`.github/workflows/deploy-infra.yml` runs `fmt -check`, `validate`, `plan` on pull requests and
posts the plan; `apply` runs on `main` after the `prod` environment's required reviewer approves.

Local, only when you want a plan without pushing a branch. Store the three credentials in the
Keychain once, then run Terraform through the wrapper:

```bash
./scripts/with-secrets.sh set CLOUDFLARE_API_TOKEN
./scripts/with-secrets.sh set R2_STATE_ACCESS_KEY_ID
./scripts/with-secrets.sh set R2_STATE_SECRET_ACCESS_KEY
./scripts/with-secrets.sh terraform -chdir=infra/terraform/envs/prod init -input=false
./scripts/with-secrets.sh terraform -chdir=infra/terraform/envs/prod plan -var-file=prod.tfvars
```

`apply` is never run locally; the Claude Code hooks refuse it and CI does it after review.
Without credentials you can still run `terraform init -backend=false && terraform validate`.

`*.tfvars` are git-ignored because they are environment-specific, not because they are secret: they
hold account and zone ids, hostnames and operator addresses only. Never put credentials in them. A
file that must hold a secret is named `*secret*.tfvars`; the Claude Code hooks refuse to read those.
Copy from `prod.tfvars.example`.
