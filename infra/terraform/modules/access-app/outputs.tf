output "aud" {
  description = "Application Audience tag; set as ACCESS_AUD in the gateway wrangler config"
  value       = cloudflare_zero_trust_access_application.gateway.aud
}
output "service_token_client_id" {
  value     = cloudflare_zero_trust_access_service_token.cli.client_id
  sensitive = true
}
output "service_token_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.cli.client_secret
  sensitive = true
}
