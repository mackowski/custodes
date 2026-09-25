output "wrangler_ids" {
  description = "Paste into the matching wrangler.jsonc env blocks"
  value = {
    kill_switch_kv_id = module.data_stores.kill_switch_kv_id
    audit_d1_id       = module.data_stores.audit_d1_id
    secrets_store_id  = module.secrets.store_id
    access_aud        = module.access.aud
  }
}
