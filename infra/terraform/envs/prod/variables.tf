variable "account_id" { type = string }
variable "zone_id" { type = string }
variable "hostname" { type = string }
variable "operator_emails" { type = list(string) }
variable "dmarc_report_address" { type = string }
variable "agents" { type = list(string) }
variable "access_identity_provider_id" {
  type        = string
  description = "Zero Trust identity provider id operators must use (Cloudflare IdP restricted to account members)"
}
variable "email_rules_enabled" {
  type        = bool
  description = "Set true after Email Routing is enabled on the zone and the Workers are deployed (bootstrap phase 2)."
  default     = false
}
