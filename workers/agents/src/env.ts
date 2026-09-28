import type { CustodesEnv } from '@custodes/core/agent';

/** Generated bindings (wrangler types) plus the secrets set by CI on deploy. */
export interface AgentsEnv extends Cloudflare.Env, CustodesEnv {
  AI_GATEWAY_TOKEN: string;
  APPROVAL_TOKEN_SECRET: string;
}
