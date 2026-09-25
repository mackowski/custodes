import { z } from 'zod';

/** Minimal, loose view of a GitHub webhook payload; everything else stays opaque and untrusted. */
export const GitHubWebhookEnvelope = z.looseObject({
  action: z.string().optional(),
  repository: z.looseObject({ full_name: z.string() }),
  sender: z.looseObject({ login: z.string(), type: z.string().optional() }),
  issue: z.looseObject({ number: z.number().int() }).optional(),
  pull_request: z.looseObject({ number: z.number().int() }).optional(),
});
export type GitHubWebhookEnvelope = z.infer<typeof GitHubWebhookEnvelope>;

/** What the gateway puts on the queue after verifying the webhook signature. */
export const InboundEvent = z.object({
  id: z.uuid(),
  receivedAt: z.iso.datetime(),
  source: z.literal('github-webhook'),
  event: z.string(),
  deliveryId: z.string(),
  repo: z.string(),
  payload: GitHubWebhookEnvelope,
});
export type InboundEvent = z.infer<typeof InboundEvent>;
