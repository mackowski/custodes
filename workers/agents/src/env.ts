import type { CustodesEnv } from '@custodes/core/agent';
import type { TriageApplyAgent } from './agents/triage-apply.js';
import type { TriageAgent } from './agents/triage.js';
import type { ImplementationCheckAgent } from './agents/implementation-check.js';
import type { ProposalReviewAgent } from './agents/proposal-review.js';
import type { PrGateAgent } from './agents/pr-gate.js';
import type { CheatsheetReviewAgent } from './agents/cheatsheet-review.js';
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
  /**
   * Bound in custodes-triage (workers/triage/wrangler.jsonc) since the 2026-11-12 cutover, no
   * longer in the shared Worker, whose code checks before use (`hasTriage` in index.ts). Required
   * here only to keep the triage code and its tests simple: shared-Worker code that uses them
   * without that check compiles but fails at runtime (an outage, never a bypass). They become
   * optional or move to a `TriageEnv` in the clean-up PR (docs/runbooks/agent-cutover.md).
   */
  TriageAgent: DurableObjectNamespace<TriageAgent>;
  ImplementationCheckAgent: DurableObjectNamespace<ImplementationCheckAgent>;
  ProposalReviewAgent: DurableObjectNamespace<ProposalReviewAgent>;
  /** Bound in custodes-pr-gate since its cutover; the shared Worker checks first (`hasPrGate`). */
  PrGateAgent: DurableObjectNamespace<PrGateAgent>;
  /**
   * Bound in custodes-cheatsheet-review since its cutover; the shared Worker checks first
   * (`hasCheatsheetReview`).
   */
  CheatsheetReviewAgent: DurableObjectNamespace<CheatsheetReviewAgent>;
  TRIAGE_APPLY?: Service<TriageApplyIntake>;
}
