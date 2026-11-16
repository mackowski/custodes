import type { CustodesEnv } from '@custodes/core/agent';
import type { TriageApplyAgent } from './agents/triage-apply.js';
import type { TriageAgent } from './agents/triage.js';
import type { ImplementationCheckAgent } from './agents/implementation-check.js';
import type { ProposalReviewAgent } from './agents/proposal-review.js';
import type { PrGateAgent } from './agents/pr-gate.js';
import type { CheatsheetReviewAgent } from './agents/cheatsheet-review.js';
import type { TriageApplyIntake } from './triage-apply-worker.js';

/**
 * What the agent code may read from `env`, declared here by hand (ADR 0018). Every agent runs in
 * its own Worker (`workers/<agent>/wrangler.jsonc`) with only the bindings it needs, and the shared
 * `custodes-agents` Worker has none, so no single wrangler file describes this type: it is the
 * union, and each Worker binds a subset. Code reads a binding only where its Worker has it; the
 * ones that exist in some Workers only are optional.
 */
export interface AgentsEnv extends CustodesEnv {
  // Vars (every agent Worker sets them in its own wrangler file).
  ENVIRONMENT: string;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
  EMAIL_FROM: string;
  EMAIL_DOMAIN: string;
  OPERATOR_EMAIL: string;
  /** Approval links in e-mails (ADR 0017 amendment): the gateway page behind Cloudflare Access. */
  APPROVAL_LINK_BASE: string;
  /** pr-gate closes pull requests while this is "true" (ADR 0011). */
  PR_GATE_ENFORCE: string;
  /** Jev transport (ADR 0011): "direct" calls OpenRouter with `OPENROUTER_API_KEY`. */
  JEV_TRANSPORT: string;
  JEV_GATEWAY_PATH: string;
  // Bindings.
  /** E-mail to the operator only (`allowed_destination_addresses`). */
  EMAIL: SendEmail;
  /** Workers AI: Clef (pr-gate) and cheatsheet-review's DeepSeek reviewers, via AI Gateway. */
  AI: Ai;
  // Secrets (set by CI on deploy, per Worker).
  AI_GATEWAY_TOKEN: string;
  /**
   * Only when AI Gateway cannot forward OpenRouter's Decisions API (ADR 0011): Jev is then called
   * directly with this key. Unset means Jev goes through the gateway with its stored (BYOK) key.
   */
  OPENROUTER_API_KEY?: string;
  /**
   * Agent classes. Each is bound only in its own Worker (triage and its two specialists in
   * custodes-triage, triage-apply in custodes-triage-apply, pr-gate in custodes-pr-gate,
   * cheatsheet-review in custodes-cheatsheet-review). Each entry point uses only its own; a missing
   * binding throws (fails closed). The tests bind all of them (`vitest.config.ts`).
   */
  TriageAgent: DurableObjectNamespace<TriageAgent>;
  ImplementationCheckAgent: DurableObjectNamespace<ImplementationCheckAgent>;
  ProposalReviewAgent: DurableObjectNamespace<ProposalReviewAgent>;
  PrGateAgent: DurableObjectNamespace<PrGateAgent>;
  CheatsheetReviewAgent: DurableObjectNamespace<CheatsheetReviewAgent>;
  TriageApplyAgent?: DurableObjectNamespace<TriageApplyAgent>;
  /** triage's RPC to triage-apply (ADR 0019); bound in custodes-triage only. */
  TRIAGE_APPLY?: Service<TriageApplyIntake>;
}
