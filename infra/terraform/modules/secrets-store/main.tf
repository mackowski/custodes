terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
}

# One store per account. Secret *values* are set out of band by an operator; Terraform only
# knows which names must exist so the broker's bindings resolve.
resource "cloudflare_secrets_store" "this" {
  account_id = var.account_id
  name       = "custodes"
}

locals {
  # One GitHub PAT per agent. Signing keys are generated inside the broker (Keyring DO), not stored here.
  secret_names = [for a in var.agents : "github-pat-${a}"]
}

resource "cloudflare_secrets_store_secret" "agent" {
  for_each   = toset(local.secret_names)
  account_id = var.account_id
  store_id   = cloudflare_secrets_store.this.id
  name       = each.key
  scopes     = ["workers"]
  # Placeholder; CI overwrites it from the GitHub secret PAT_<AGENT> on every deploy.
  value = "ROTATE-ME"
  lifecycle { ignore_changes = [value] }
}
