terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
}

# Self-hosted Access application in front of the gateway's /admin and /agents paths.
resource "cloudflare_zero_trust_access_application" "gateway" {
  account_id = var.account_id
  name       = "custodes"
  type       = "self_hosted"
  # The primary domain must be one of the destinations; only these two paths require sign-in.
  domain = "${var.hostname}/admin"
  destinations = [
    { type = "public", uri = "${var.hostname}/admin" },
    { type = "public", uri = "${var.hostname}/agents" },
  ]
  # Reusable policies are only enforced once attached to the application.
  policies = [
    { id = cloudflare_zero_trust_access_policy.operators.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.service.id, precedence = 2 },
  ]
  session_duration           = "8h"
  app_launcher_visible       = false
  auto_redirect_to_identity  = true
  http_only_cookie_attribute = true
  # Bind cookies to the user's device posture when available.
  enable_binding_cookie = true
}

# Humans: allow-listed operator emails (ideally an IdP group in production).
resource "cloudflare_zero_trust_access_policy" "operators" {
  account_id = var.account_id
  name       = "custodes operators"
  decision   = "allow"
  include    = [for e in var.operator_emails : { email = { email = e } }]
  # Only the Cloudflare identity provider (restricted to account members) may satisfy this policy.
  # MFA is enforced by the Cloudflare account itself, so no separate `auth_method = mfa` claim is
  # required; that claim is only emitted reliably by third-party IdPs and could lock operators out.
  require = [{ login_method = { id = var.identity_provider_id } }]
}

# Automation: a service token for CI or scheduled CLI runs.
resource "cloudflare_zero_trust_access_service_token" "cli" {
  account_id = var.account_id
  name       = "custodes-cli"
  duration   = "8760h"
}

resource "cloudflare_zero_trust_access_policy" "service" {
  account_id = var.account_id
  name       = "custodes service token"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.cli.id } }]
}
