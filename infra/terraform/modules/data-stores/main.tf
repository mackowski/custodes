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
