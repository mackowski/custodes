terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 5.0" }
  }
}

# Email authentication for outbound mail from the agents (Email Service publishes DKIM keys).
resource "cloudflare_dns_record" "spf" {
  zone_id = var.zone_id
  name    = var.domain
  type    = "TXT"
  ttl     = 3600
  content = "\"v=spf1 include:_spf.mx.cloudflare.net ~all\""
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.zone_id
  name    = "_dmarc.${var.domain}"
  type    = "TXT"
  ttl     = 3600
  content = "\"v=DMARC1; p=reject; rua=mailto:${var.dmarc_report_address}; fo=1\""
}
