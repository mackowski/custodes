---
name: agent-split-findings
description: 2026-11-09 findings for splitting custodes-agents into per-class Workers (props, DO transfer, queue, limits)
metadata:
  type: reference
---

- Service binding `props` key in `services[]` (docs: workers/runtime-apis/context/): read as `this.ctx.props`; "only set by someone who can edit and deploy the worker". Wrangler config reference page does NOT list `props` (docs disagree/incomplete).
- DO transfer: new `exports` field (durable-objects/reference/durable-objects-migrations/) with `state: transferred` + `transferred_to`, target `expecting-transfer` + `transfer_from`. No `transferred_classes` documented. Same account only.
- Queues: one active consumer per queue (queues/reference/how-queues-works/).
- Limits (workers/platform/limits/): 250 cron triggers per ACCOUNT (paid), 500 Workers per account (paid). `ai` binding: one per Worker.
- CryptoKey storage in DO: not documented (2026-11-09).
