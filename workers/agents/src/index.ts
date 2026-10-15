import { getAgentByName, routeAgentRequest } from 'agents';
import { InboundEvent } from '@custodes/schema';
import { PR_GATE_INSTANCE } from './agents/pr-gate.js';
import { TRIAGE_INSTANCE } from './agents/triage.js';
import type { AgentsEnv } from './env.js';
import { REGISTRY } from './registry.js';

export { HelloAgent } from './agents/hello.js';
export { TriageAgent } from './agents/triage.js';
export { ImplementationCheckAgent } from './agents/implementation-check.js';
export { ProposalReviewAgent } from './agents/proposal-review.js';
export { PrGateAgent } from './agents/pr-gate.js';

/** Must match wrangler.jsonc triggers.crons. */
export const CRON_TRIAGE_POLL = '17 */4 * * *';
/** Daily, before the digest: fresh poll plus specialist reviews of everything the digest will show. */
export const CRON_TRIAGE_PREPARE = '30 5 * * *';
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
    if (![CRON_TRIAGE_POLL, CRON_TRIAGE_PREPARE, CRON_TRIAGE_DIGEST].includes(controller.cron)) {
      console.warn(JSON.stringify({ event: 'cron.unknown', cron: controller.cron }));
      return;
    }
    const digest = controller.cron === CRON_TRIAGE_DIGEST;
    // Independent agents: one failing or halted must not stop the other. pr-gate polls on the
    // poll and prepare crons and sends its summary with the digest.
    const jobs = {
      triage: async () => {
        const triage = await getAgentByName(env.TriageAgent, TRIAGE_INSTANCE);
        return digest
          ? triage.sendDigest()
          : triage.poll({ prepare: controller.cron === CRON_TRIAGE_PREPARE });
      },
      'pr-gate': async () => {
        const gate = await getAgentByName(env.PrGateAgent, PR_GATE_INSTANCE);
        return digest ? gate.sendSummary() : gate.poll();
      },
    };
    const results = await Promise.allSettled(Object.values(jobs).map((run) => run()));
    Object.keys(jobs).forEach((agent, i) => {
      const r = results[i];
      console.log(
        JSON.stringify({
          event: 'cron',
          cron: controller.cron,
          agent,
          ok: r?.status === 'fulfilled' && r.value.ok,
          detail: r?.status === 'fulfilled' ? r.value.detail : 'threw',
        }),
      );
    });
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
