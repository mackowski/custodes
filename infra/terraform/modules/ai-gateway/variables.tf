variable "account_id" { type = string }
variable "gateway_id" {
  type        = string
  description = "referenced as AI_GATEWAY_ID by the agents Worker"
}
variable "requests_per_minute" {
  type    = number
  default = 60
}
