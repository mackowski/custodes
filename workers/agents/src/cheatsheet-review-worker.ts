import { getAgentByName, routeAgentRequest } from 'agents';
import { InboundEvent } from '@custodes/schema';
import { route } from './dispatch.js';
import type { AgentsEnv } from './env.js';
import { allowedAgentPath, unknownInstance } from './instances.js';

/**
 * Entry point of the `custodes-cheatsheet-review` Worker (ADR 0018,
 * workers/cheatsheet-review/wrangler.jsonc): cheatsheet-review alone, with its own Keyholder and
 * broker entrypoint (`CheatsheetReviewBroker`). It is woken only by its trigger label (webhook queue)
 * and the operator's routes; it has no crons.
 */
export { CheatsheetReviewAgent } from './agents/cheatsheet-review.js';
export { KeyAdmin, Keyholder } from '@custodes/core/keyholder';

/** The only agent class this Worker routes to (kebab-case, as the Agents SDK names it). */
const CLASS = 'cheatsheet-review-agent';

export default {
  async fetch(request: Request, env: AgentsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true, env: env.ENVIRONMENT });
    // Split like the SDK router (empty segments dropped); only this agent's class is routable.
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'agents' || parts[1] !== CLASS || !allowedAgentPath(url.pathname))
      return unknownInstance();
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
  },

  /** Webhook events for cheatsheet-review, from its own queue. Anything routed elsewhere is dropped. */
  async queue(batch: MessageBatch, env: AgentsEnv): Promise<void> {
    for (const msg of batch.messages) {
      const parsed = InboundEvent.safeParse(msg.body);
      const r = parsed.success ? route(parsed.data) : null;
      if (r?.agent !== 'cheatsheet-review') {
        console.warn(
          JSON.stringify({ event: 'queue.ignored', id: msg.id, agent: r?.agent ?? null }),
        );
        msg.ack();
        continue;
      }
      try {
        const wake = await (
          await getAgentByName(env.CheatsheetReviewAgent, r.instance)
        ).notify(r.pr);
        console.log(
          JSON.stringify({
            event: 'queue.dispatch',
            agent: 'cheatsheet-review',
            instance: r.instance,
            pr: r.pr,
            scheduledFor: wake.at,
          }),
        );
        msg.ack();
      } catch (err) {
        console.error(
          JSON.stringify({ event: 'queue.retry', what: err instanceof Error ? err.name : 'error' }),
        );
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<AgentsEnv>;
