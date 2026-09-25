variable "account_id" { type = string }
variable "hostname" {
  type        = string
  description = "Gateway hostname, e.g. custodes.work"
}
variable "operator_emails" {
  type        = list(string)
  description = "Humans allowed to use the admin API and CLI"
}
variable "identity_provider_id" {
  type        = string
  description = "Access identity provider operators must log in with (the account's Cloudflare IdP, restricted to account members)"
}
