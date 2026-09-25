import { routeAgentRequest } from 'agents';
import { InboundEvent } from '@custodes/schema';
import type { AgentsEnv } from './env.js';
import { REGISTRY } from './registry.js';

export { HelloAgent } from './agents/hello.js';

export default {
  async fetch(request: Request, env: AgentsEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true, env: env.ENVIRONMENT });
    if (url.pathname === '/registry') return Response.json(REGISTRY);
    // /agents/<kebab-class-name>/<instance> → the Durable Object. Only reachable via the gateway.
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
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
      // TODO(new-agent): route parsed.data to the owning agent, e.g. getAgentByName(env.TriageAgent, repo).
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
