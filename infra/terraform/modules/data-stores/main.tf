terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
}

resource "cloudflare_workers_kv_namespace" "kill_switch" {
  account_id = var.account_id
  title      = "custodes-kill-switch"
}

resource "cloudflare_d1_database" "audit" {
  account_id = var.account_id
  name       = "custodes-audit"
  # Single-writer audit log; pinned so the provider does not report drift on the default.
  read_replication = { mode = "disabled" }
}

resource "cloudflare_queue" "inbound" {
  account_id = var.account_id
  queue_name = "custodes-inbound"
}

resource "cloudflare_queue" "inbound_dlq" {
  account_id = var.account_id
  queue_name = "custodes-inbound-dlq"
}

# pr-gate in its own Worker (ADR 0018): the gateway sends it webhook wake-ups on its own queue,
# consumed only by custodes-pr-gate (one consumer per queue).
resource "cloudflare_queue" "inbound_pr_gate" {
  account_id = var.account_id
  queue_name = "custodes-inbound-pr-gate"
}

resource "cloudflare_queue" "inbound_pr_gate_dlq" {
  account_id = var.account_id
  queue_name = "custodes-inbound-pr-gate-dlq"
}

# cheatsheet-review in its own Worker (ADR 0018): its trigger-label wake-ups.
resource "cloudflare_queue" "inbound_cheatsheet_review" {
  account_id = var.account_id
  queue_name = "custodes-inbound-cheatsheet-review"
}

resource "cloudflare_queue" "inbound_cheatsheet_review_dlq" {
  account_id = var.account_id
  queue_name = "custodes-inbound-cheatsheet-review-dlq"
}
