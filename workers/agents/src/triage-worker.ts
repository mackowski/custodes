import { getAgentByName, routeAgentRequest } from 'agents';
import { TRIAGE_INSTANCE } from './agents/triage.js';
import { CRON_TRIAGE_DIGEST, CRON_TRIAGE_POLL, CRON_TRIAGE_PREPARE } from './crons.js';
import type { AgentsEnv } from './env.js';
import { allowedAgentPath, unknownInstance } from './instances.js';

/**
 * Entry point of the `custodes-triage` Worker (ADR 0018, workers/triage/wrangler.jsonc): triage and
 * its two read-only specialists, with their own Keyholder and broker entrypoint (`TriageBroker`).
 * Triage runs on its crons only; it has no queue.
 */
export { TriageAgent } from './agents/triage.js';
export { ImplementationCheckAgent } from './agents/implementation-check.js';
export { ProposalReviewAgent } from './agents/proposal-review.js';
export { KeyAdmin, Keyholder } from '@custodes/core/keyholder';

/** The agent classes this Worker routes to (kebab-case, as the Agents SDK names them). */
const CLASSES = new Set(['triage-agent', 'implementation-check-agent', 'proposal-review-agent']);

export default {
  async fetch(request: Request, env: AgentsEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true, env: env.ENVIRONMENT });
    // Split like the SDK router (empty segments dropped); only these agents' classes are routable.
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'agents' || !CLASSES.has(parts[1] ?? '') || !allowedAgentPath(url.pathname))
      return unknownInstance();
    return (await routeAgentRequest(request, env)) ?? new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: AgentsEnv): Promise<void> {
    if (![CRON_TRIAGE_POLL, CRON_TRIAGE_PREPARE, CRON_TRIAGE_DIGEST].includes(controller.cron)) {
      console.warn(JSON.stringify({ event: 'cron.unknown', cron: controller.cron }));
      return;
    }
    const triage = await getAgentByName(env.TriageAgent, TRIAGE_INSTANCE);
    const r =
      controller.cron === CRON_TRIAGE_DIGEST
        ? await triage.sendDigest()
        : await triage.poll({ prepare: controller.cron === CRON_TRIAGE_PREPARE });
    console.log(
      JSON.stringify({
        event: 'cron',
        cron: controller.cron,
        agent: 'triage',
        ok: r.ok,
        detail: r.detail,
      }),
    );
  },
} satisfies ExportedHandler<AgentsEnv>;
