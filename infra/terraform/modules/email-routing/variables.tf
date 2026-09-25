variable "zone_id" { type = string }
variable "domain" { type = string }
variable "gateway_worker_name" { type = string }
variable "agents_worker_name" { type = string }
variable "rules_enabled" {
  type        = bool
  description = "Create routing rules. Requires Email Routing enabled on the zone and the gateway/agents Workers deployed."
  default     = false
}
