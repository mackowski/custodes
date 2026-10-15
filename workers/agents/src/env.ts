import type { CustodesEnv } from '@custodes/core/agent';

/** Generated bindings (wrangler types) plus the secrets set by CI on deploy. */
export interface AgentsEnv extends Cloudflare.Env, CustodesEnv {
  AI_GATEWAY_TOKEN: string;
  APPROVAL_TOKEN_SECRET: string;
  /**
   * Only when AI Gateway cannot forward OpenRouter's Decisions API (ADR 0011): Jev is then called
   * directly with this key. Unset means Jev goes through the gateway with its stored (BYOK) key.
   */
  OPENROUTER_API_KEY?: string;
}
