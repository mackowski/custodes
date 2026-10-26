import { getAgentByName, routeAgentRequest } from 'agents';
import { InboundEvent } from '@custodes/schema';
import { PR_GATE_INSTANCE } from './agents/pr-gate.js';
import { TRIAGE_INSTANCE } from './agents/triage.js';
import { route } from './dispatch.js';
import type { AgentsEnv } from './env.js';
import { allowedAgentPath, unknownInstance } from './instances.js';
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
    // Refuse unlisted instances here: the SDK creates a Durable Object's state before onRequest.
    if (!allowedAgentPath(url.pathname)) return unknownInstance();
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

  /**
   * Webhook events queued by the gateway. Dispatch by repo/event to the agent that owns it; only
   * pr-gate listens, and only to schedule a poll. Triage stays on its crons.
   */
  async queue(batch: MessageBatch, env: AgentsEnv): Promise<void> {
    for (const msg of batch.messages) {
      const parsed = InboundEvent.safeParse(msg.body);
      if (!parsed.success) {
        console.warn(JSON.stringify({ event: 'queue.invalid', id: msg.id }));
        msg.ack();
        continue;
      }
      const e = parsed.data;
      const r = route(e);
      const ids = {
        event: 'queue.dispatch',
        delivery: e.deliveryId,
        repo: e.repo,
        type: e.event,
        action: e.payload.action ?? null,
      };
      if (r.agent === null) {
        console.log(JSON.stringify({ ...ids, outcome: 'ignored', why: r.why }));
        msg.ack();
        continue;
      }
      try {
        const gate = await getAgentByName(env.PrGateAgent, r.instance);
        const wake = await gate.notify(r.updatedAt);
        console.log(
          JSON.stringify({
            ...ids,
            outcome: 'scheduled',
            instance: r.instance,
            pr: r.pr,
            scheduledFor: wake.at,
          }),
        );
        msg.ack();
      } catch (err) {
        // Scheduling is idempotent per slot, so a retry is safe; after three the DLQ keeps it.
        console.error(
          JSON.stringify({
            ...ids,
            outcome: 'retry',
            what: err instanceof Error ? err.name : 'error',
          }),
        );
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<AgentsEnv>;
