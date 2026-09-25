import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/** Stub broker: every request is denied so no test can accidentally reach GitHub. */
const brokerStub = {
  name: 'custodes-github-broker',
  modules: true,
  compatibilityDate: '2026-08-15',
  script: `export default { fetch() { return Response.json({ ok: false, code: 'policy_denied', reason: 'stub broker' }); } }`,
};

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        kvNamespaces: ['KILL_SWITCH'],
        bindings: { AI_GATEWAY_TOKEN: 'test', APPROVAL_TOKEN_SECRET: 'test-approval-secret' },
        workers: [brokerStub],
      },
    }),
  ],
});
