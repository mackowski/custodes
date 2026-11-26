import { getAgentByName, routeAgentRequest } from 'agents';
import { CRON_BACKLOG_REVIEW } from './crons.js';
import type { AgentsEnv } from './env.js';
import { allowedAgentPath, INSTANCES, unknownInstance } from './instances.js';

/**
 * Entry point of the `custodes-backlog-review` Worker (ADR 0018, workers/backlog-review/
 * wrangler.jsonc): backlog-review alone (#132 v1), with its own Keyholder, broker entrypoint
 * (`BacklogReviewBroker`) and D1 digest. Its hourly cron runs every real (non-sandbox) instance;
 * sandbox instances run on demand only.
 */
export { BacklogReviewAgent } from './agents/backlog-review.js';
export { KeyAdmin, Keyholder } from '@custodes/core/keyholder';

/** The only agent class this Worker routes to (kebab-case, as the Agents SDK names it). */
const CLASS = 'backlog-review-agent';

export default {
  async fetch(request: Request, env: AgentsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true, env: env.ENVIRONMENT });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'agents' || parts[1] !== CLASS || !allowedAgentPath(url.pathname))
      return unknownInstance();
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: AgentsEnv): Promise<void> {
    if (controller.cron !== CRON_BACKLOG_REVIEW) {
      console.warn(JSON.stringify({ event: 'cron.unknown', cron: controller.cron }));
      return;
    }
    const ns = env.BacklogReviewAgent;
    if (ns === undefined) throw new Error('BacklogReviewAgent is not bound');
    for (const [name, inst] of Object.entries(INSTANCES)) {
      if (inst.sandbox) continue;
      const r = await (
        await getAgentByName(ns, name)
      ).review({
        kind: 'schedule',
        ref: CRON_BACKLOG_REVIEW,
      });
      console.log(
        JSON.stringify({
          event: 'cron',
          cron: controller.cron,
          agent: 'backlog-review',
          instance: name,
          ok: r.ok,
          detail: r.detail,
        }),
      );
    }
  },
} satisfies ExportedHandler<AgentsEnv>;
