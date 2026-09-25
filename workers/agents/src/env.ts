import type { CustodesEnv } from '@custodes/core/agent';

/** Generated bindings (wrangler types) plus the secrets set with `wrangler secret put`. */
export interface AgentsEnv extends Cloudflare.Env, CustodesEnv {
  AI_GATEWAY_TOKEN: string;
  APPROVAL_TOKEN_SECRET: string;
}
