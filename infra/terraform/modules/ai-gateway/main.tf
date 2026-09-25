terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
}

# Authenticated gateway: Workers must present cf-aig-authorization. Provider keys (BYOK) and
# guardrails/DLP policies are configured in the dashboard or API until the provider exposes them.
resource "cloudflare_ai_gateway" "this" {
  account_id                 = var.account_id
  id                         = var.gateway_id
  authentication             = true
  collect_logs               = true
  log_management             = 10000
  log_management_strategy    = "DELETE_OLDEST"
  cache_ttl                  = 0
  cache_invalidate_on_update = true
  rate_limiting_interval     = 60
  rate_limiting_limit        = var.requests_per_minute
  rate_limiting_technique    = "sliding"
  # Pinned explicitly so the provider does not report drift on server-side defaults.
  log_classification = false
  logpush            = false
  # Zero Data Retention would disable the request logs we rely on for auditing prompts.
  zdr = false
}
