output "kill_switch_kv_id" { value = cloudflare_workers_kv_namespace.kill_switch.id }
output "audit_d1_id" { value = cloudflare_d1_database.audit.id }
