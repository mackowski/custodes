# cloudflare-researcher memory

- 2026-09: Agents SDK `agents@0.24` exposes `routeAgentRequest`, `routeAgentEmail`, `createAddressBasedEmailResolver`, `Agent` hooks `onRequest/onEmail/onStateChanged`, `schedule/scheduleEvery`, `runWorkflow/waitForApproval/approveWorkflow`.
- Fine-grained GitHub PATs: max 50 per user, tied to the user, org may block or require approval.
- Cloudflare has no OIDC federation for API tokens; CI uses scoped tokens in GitHub Environments.
