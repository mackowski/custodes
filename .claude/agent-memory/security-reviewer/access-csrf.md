---
name: access-csrf
description: Gateway Access routes accept the edge-injected Cf-Access-Jwt-Assertion (cookie-based), and the Access app sets no SameSite, so effectful POSTs under /admin and /agents are CSRF candidates
metadata:
  type: project
---

Raised 2026-10-15 (ADR 0012 sandbox review). `workers/gateway/src/access.ts` accepts `cf-access-jwt-assertion`, which Cloudflare Access injects for any request carrying the browser's `CF_Authorization` cookie. `infra/terraform/modules/access-app/main.tf` sets `http_only_cookie_attribute` and `enable_binding_cookie` but no `same_site_cookie_attribute`. The gateway does no Origin / `Sec-Fetch-Site` check and has no custom-header requirement. `cloudflared access login` authenticates the operator's browser on the same hostname.

Effectful POSTs at the time: `/admin/agents/:id/resume` (kill-switch bypass, no body), `/admin/agents/:id/halt`, approvals decide, key rotate, and since ADR 0012 `/agents/{triage,pr-gate}-agent/custodes-sandbox/{run,digest,summary}`.

Suggested fix: `same_site_cookie_attribute = "strict"` in Terraform, plus a gateway check that rejects non-GET requests when `sec-fetch-site` is present and not `same-origin`/`none`. CLI and service tokens send no Sec-Fetch headers, so they keep working.

**Why:** Access makes these routes look "operator only", but a cookie-authenticated cross-site form POST is still the operator.

**How to apply:** Whenever a review adds an effectful method under `/admin` or `/agents`, check whether this fix has landed (grep `same_site_cookie_attribute`, `sec-fetch-site`). If it hasn't, report it again and reference this note. See [[architecture-invariants]].
