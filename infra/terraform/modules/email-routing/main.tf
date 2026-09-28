terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
}

# Enabling Email Routing on the zone (adds the MX records) is a one-time step done outside
# Terraform: provider 5.25 crashes reading `cloudflare_email_routing_settings` ("support_subaddress"
# field mismatch). Enable once with the dashboard or
#   POST /zones/{zone_id}/email/routing/enable
# then set `rules_enabled = true` after the Workers exist; rules reference them by name.

# approve+<token>@domain and reject+<token>@domain → gateway Worker (approval decisions)
resource "cloudflare_email_routing_rule" "approvals" {
  for_each = var.rules_enabled ? toset(["approve", "reject"]) : toset([])
  zone_id  = var.zone_id
  name     = "custodes ${each.key}"
  enabled  = true
  matchers = [{ type = "literal", field = "to", value = "${each.key}@${var.domain}" }]
  actions  = [{ type = "worker", value = [var.gateway_worker_name] }]
}

# Anything addressed to an agent mailbox → agents Worker (routeAgentEmail)
resource "cloudflare_email_routing_catch_all" "agents" {
  count    = var.rules_enabled ? 1 : 0
  zone_id  = var.zone_id
  name     = "custodes agents catch-all"
  enabled  = true
  matchers = [{ type = "all" }]
  actions  = [{ type = "worker", value = [var.agents_worker_name] }]
}

# Verified destination addresses. Workers may send to these without Email Sending onboarding
# (free on any plan); each address receives a one-time verification e-mail that must be clicked.
resource "cloudflare_email_routing_address" "destination" {
  for_each   = toset(var.destination_addresses)
  account_id = var.account_id
  email      = each.key
}
