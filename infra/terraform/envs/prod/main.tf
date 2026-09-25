terraform {
  required_version = ">= 1.9"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
  # R2 (S3-compatible) remote state. Nothing here is secret: credentials are the R2 API token, passed only
  # via environment variables (CI secrets or scripts/with-secrets.sh). The "s3" backend is Terraform's
  # generic client for S3-compatible storage; R2 is Cloudflare, no AWS is involved.
  backend "s3" {
    bucket                      = "custodes-tfstate"
    endpoints                   = { s3 = "https://5f62912564df344533c9563904c77662.r2.cloudflarestorage.com" }
    key                         = "prod/terraform.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "cloudflare" {}

# Custodes runs as a single environment. New agents prove themselves against test repositories
# (allow-listed in the broker policy) before their policy is widened to real ones; see ADR 0007.

module "data_stores" {
  source     = "../../modules/data-stores"
  account_id = var.account_id
}

module "secrets" {
  source     = "../../modules/secrets-store"
  account_id = var.account_id
  agents     = var.agents
}

module "ai_gateway" {
  source              = "../../modules/ai-gateway"
  account_id          = var.account_id
  gateway_id          = "custodes"
  requests_per_minute = 60
}

module "access" {
  source               = "../../modules/access-app"
  account_id           = var.account_id
  hostname             = var.hostname
  operator_emails      = var.operator_emails
  identity_provider_id = var.access_identity_provider_id
}

module "dns" {
  source               = "../../modules/dns"
  zone_id              = var.zone_id
  domain               = var.hostname
  dmarc_report_address = var.dmarc_report_address
}

module "email" {
  source              = "../../modules/email-routing"
  zone_id             = var.zone_id
  domain              = var.hostname
  gateway_worker_name = "custodes-gateway"
  agents_worker_name  = "custodes-agents"
  rules_enabled       = var.email_rules_enabled
}
