---
name: access-csrf
description: Access-cookie CSRF on effectful /admin and /agents POSTs - FIXED (SameSite lax + gateway crossSiteWrite Sec-Fetch-Site check); verify it stays on every new route
metadata:
  type: project
---

Raised 2026-10-15 (ADR 0012 sandbox review): the Access cookie had no SameSite and the gateway had no Origin check, so cross-site form POSTs to `/admin/*` and `/agents/*` ran as the operator.

Status 2026-10-26 (Clef shadow review): FIXED. `infra/terraform/modules/access-app/main.tf` sets `same_site_cookie_attribute = "lax"`, and `workers/gateway/src/access.ts` `crossSiteWrite()` refuses non-GET/HEAD/OPTIONS requests whose `Sec-Fetch-Site` is present and not `same-origin`/`none`. Both the `admin` middleware and `app.all('/agents/*')` call it. CLI and service tokens send no Sec-Fetch headers.

Service tokens: `adminWriteAllowed()` makes them read-only on `/admin`. On `/agents/*` they may POST (CI sandbox scenarios: run/summary); only paths ending in `/verdict` are denied (ADR 0015). That is a denylist keyed on a path suffix; the agent itself does not check the actor.

2026-10-30 (approval links): `POST /admin/approvals/link/:token` is inside the `admin` middleware, so `crossSiteWrite` covers it, and the token is an unguessable HMAC as well. GET and POST check `isApprover` (Access user on `APPROVER_EMAILS`; service tokens refused). The page sets CSP `default-src 'none'; form-action 'self'; frame-ancestors 'none'`, XFO DENY and no-referrer. The token is in the URL path, so it shows up in gateway and broker invocation logs. This is accepted because the token is not a bearer credential: Access plus the approver list is.

**Why:** Access makes these routes look "operator only", but a cookie-authenticated cross-site POST is still the operator.

**How to apply:** For any new effectful method under `/admin` or `/agents`, check it sits behind `crossSiteWrite` (route registered after/inside the guarded handler) and decide whether service tokens should reach it; prefer an allow-list for service-token writes over per-path denials. See [[architecture-invariants]].
