import { getAgentByName, routeAgentRequest } from 'agents';
import { InboundEvent } from '@custodes/schema';
import { PR_GATE_INSTANCE } from './agents/pr-gate.js';
import { route } from './dispatch.js';
import type { AgentsEnv } from './env.js';
import { allowedAgentPath, unknownInstance } from './instances.js';
import { CRON_TRIAGE_DIGEST, CRON_TRIAGE_POLL, CRON_TRIAGE_PREPARE } from './crons.js';

/**
 * Entry point of the `custodes-pr-gate` Worker (ADR 0018, workers/pr-gate/wrangler.jsonc): pr-gate
 * alone, with its own Keyholder and its own broker entrypoint (`PrGateBroker`). It shares source
 * with the agents Worker, but its bundle holds only what this file imports, and at runtime it has
 * only its own bindings and secrets.
 */
export { PrGateAgent } from './agents/pr-gate.js';
export { Keyholder } from '@custodes/core/keyholder';

/** The only agent class this Worker routes to (kebab-case, as the Agents SDK names it). */
const CLASS = 'pr-gate-agent';

export default {
  async fetch(request: Request, env: AgentsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true, env: env.ENVIRONMENT });
    // /agents/pr-gate-agent/<instance>/... only: never the Keyholder or anything else.
    const m = /^\/agents\/([^/]+)\//.exec(`${url.pathname}/`);
    if (m?.[1] !== CLASS || !allowedAgentPath(url.pathname)) return unknownInstance();
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
  },

  /** pr-gate polls on the poll and prepare crons and sends its summary with the digest (as before). */
  async scheduled(controller: ScheduledController, env: AgentsEnv): Promise<void> {
    if (![CRON_TRIAGE_POLL, CRON_TRIAGE_PREPARE, CRON_TRIAGE_DIGEST].includes(controller.cron)) {
      console.warn(JSON.stringify({ event: 'cron.unknown', cron: controller.cron }));
      return;
    }
    const gate = await getAgentByName(env.PrGateAgent, PR_GATE_INSTANCE);
    const r = controller.cron === CRON_TRIAGE_DIGEST ? await gate.sendSummary() : await gate.poll();
    console.log(
      JSON.stringify({
        event: 'cron',
        cron: controller.cron,
        agent: 'pr-gate',
        ok: r.ok,
        detail: r.detail,
      }),
    );
  },

  /** Webhook events for pr-gate, from its own queue. Anything routed elsewhere is dropped. */
  async queue(batch: MessageBatch, env: AgentsEnv): Promise<void> {
    for (const msg of batch.messages) {
      const parsed = InboundEvent.safeParse(msg.body);
      const r = parsed.success ? route(parsed.data) : null;
      if (r?.agent !== 'pr-gate') {
        console.warn(
          JSON.stringify({ event: 'queue.ignored', id: msg.id, agent: r?.agent ?? null }),
        );
        msg.ack();
        continue;
      }
      try {
        const wake = await (await getAgentByName(env.PrGateAgent, r.instance)).notify(r.updatedAt);
        console.log(
          JSON.stringify({
            event: 'queue.dispatch',
            agent: 'pr-gate',
            instance: r.instance,
            pr: r.pr,
            scheduledFor: wake.at,
          }),
        );
        msg.ack();
      } catch (err) {
        // Scheduling is idempotent per slot, so a retry is safe; after three the DLQ keeps it.
        console.error(
          JSON.stringify({ event: 'queue.retry', what: err instanceof Error ? err.name : 'error' }),
        );
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<AgentsEnv>;
