import { getAgentByName, routeAgentRequest } from 'agents';
import { InboundEvent } from '@custodes/schema';
import { TRIAGE_INSTANCE } from './agents/triage.js';
import type { AgentsEnv } from './env.js';
import { REGISTRY } from './registry.js';

export { HelloAgent } from './agents/hello.js';
export { TriageAgent } from './agents/triage.js';
export { ImplementationCheckAgent } from './agents/implementation-check.js';
export { ProposalReviewAgent } from './agents/proposal-review.js';

/** Must match wrangler.jsonc triggers.crons. */
export const CRON_TRIAGE_POLL = '17 */4 * * *';
export const CRON_TRIAGE_DIGEST = '0 7 * * *';

export default {
  async fetch(request: Request, env: AgentsEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true, env: env.ENVIRONMENT });
    if (url.pathname === '/registry') return Response.json(REGISTRY);
    // /agents/<kebab-class-name>/<instance> → the Durable Object. Only reachable via the gateway.
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: AgentsEnv): Promise<void> {
    // Explicit dispatch: a cron added for another agent must never trigger triage spend by default.
    if (controller.cron !== CRON_TRIAGE_POLL && controller.cron !== CRON_TRIAGE_DIGEST) {
      console.warn(JSON.stringify({ event: 'cron.unknown', cron: controller.cron }));
      return;
    }
    const triage = await getAgentByName(env.TriageAgent, TRIAGE_INSTANCE);
    const result =
      controller.cron === CRON_TRIAGE_DIGEST ? await triage.sendDigest() : await triage.poll();
    console.log(
      JSON.stringify({
        event: 'cron',
        cron: controller.cron,
        ok: result.ok,
        detail: result.detail,
      }),
    );
  },

  /** Webhook events queued by the gateway. Dispatch by repo/event to the agent that owns it. */
  queue(batch: MessageBatch): void {
    for (const msg of batch.messages) {
      const parsed = InboundEvent.safeParse(msg.body);
      if (!parsed.success) {
        console.warn(JSON.stringify({ event: 'queue.invalid', id: msg.id }));
        msg.ack();
        continue;
      }
      // Read-only triage polls on a schedule; webhook events are acknowledged and ignored for now.
      console.log(
        JSON.stringify({
          event: 'queue.received',
          repo: parsed.data.repo,
          type: parsed.data.event,
          delivery: parsed.data.deliveryId,
        }),
      );
      msg.ack();
    }
  },
} satisfies ExportedHandler<AgentsEnv>;
