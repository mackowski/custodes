/** Generated bindings (wrangler types) plus the secrets set with `wrangler secret put`. */
export interface GatewayEnv extends Cloudflare.Env {
  GITHUB_WEBHOOK_SECRET: string;
  APPROVAL_TOKEN_SECRET: string;
}
