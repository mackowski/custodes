output "wrangler_ids" {
  description = "Paste into the matching wrangler.jsonc env blocks"
  value = {
    kill_switch_kv_id = module.data_stores.kill_switch_kv_id
    audit_d1_id       = module.data_stores.audit_d1_id
    secrets_store_id  = module.secrets.store_id
    access_aud        = module.access.aud
  }
}

# Access service token for CI (sandbox scenarios, ADR 0012). Copy into GitHub secrets with
# `terraform output -raw … | gh secret set …` so the secret is never printed.
output "access_service_client_id" {
  value     = module.access.service_token_client_id
  sensitive = true
}

output "access_service_client_secret" {
  value     = module.access.service_token_client_secret
  sensitive = true
}
