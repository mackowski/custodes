import type { CustodesEnv } from '@custodes/core/agent';
import type { TriageApplyAgent } from './agents/triage-apply.js';
import type { TriageApplyIntake } from './triage-apply-worker.js';

/** Generated bindings (wrangler types) plus the secrets set by CI on deploy. */
export interface AgentsEnv extends Cloudflare.Env, CustodesEnv {
  AI_GATEWAY_TOKEN: string;
  /**
   * Only when AI Gateway cannot forward OpenRouter's Decisions API (ADR 0011): Jev is then called
   * directly with this key. Unset means Jev goes through the gateway with its stored (BYOK) key.
   */
  OPENROUTER_API_KEY?: string;
  /**
   * Bindings that exist only in their own Workers (ADR 0019), not in the shared wrangler config
   * the types are generated from: triage-apply's agent class in custodes-triage-apply, and its RPC
   * entrypoint in custodes-triage. Absent anywhere else; code checks before use.
   */
  TriageApplyAgent?: DurableObjectNamespace<TriageApplyAgent>;
  TRIAGE_APPLY?: Service<TriageApplyIntake>;
}
