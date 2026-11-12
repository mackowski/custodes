import { WorkerEntrypoint } from 'cloudflare:workers';
import { getAgentByName } from 'agents';
import type { AgentsEnv } from './env.js';
import { INSTANCES } from './instances.js';
import type { ProposeResult } from './agents/triage-apply/bundle.js';

/**
 * Entry point of the `custodes-triage-apply` Worker (ADR 0019, workers/triage-apply/wrangler.jsonc):
 * triage-apply alone, with its own Keyholder and broker entrypoint (`TriageApplyBroker`). It has no
 * model, no cron, no queue and no e-mail. Nothing reaches it over HTTP except /healthz; triage
 * calls `TriageApplyIntake` through a service binding (only custodes-triage binds it, a binding
 * test checks that).
 */
export { TriageApplyAgent } from './agents/triage-apply.js';
export { KeyAdmin, Keyholder } from '@custodes/core/keyholder';

/** RPC for triage: one proposal in, a link token (or the reason there is none) out. */
export class TriageApplyIntake extends WorkerEntrypoint<AgentsEnv> {
  async propose(instance: string, proposal: unknown): Promise<ProposeResult> {
    // The instance name selects the repository (instances.ts); anything else is refused here.
    if (!Object.hasOwn(INSTANCES, instance)) return { ok: false, reason: 'unknown instance' };
    const ns = this.env.TriageApplyAgent;
    if (ns === undefined) return { ok: false, reason: 'triage-apply is not deployed here' };
    const agent = await getAgentByName(ns, instance);
    return agent.propose(proposal);
  }
}

export default {
  fetch(request: Request, env: AgentsEnv): Response {
    if (new URL(request.url).pathname === '/healthz')
      return Response.json({ ok: true, env: env.ENVIRONMENT });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<AgentsEnv>;
