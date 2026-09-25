variable "account_id" { type = string }
variable "agents" {
  type        = list(string)
  description = "Agent ids that need a GitHub PAT, e.g. [\"hello\", \"triage\"]"
}
