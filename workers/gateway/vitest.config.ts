import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Stub for a service binding: answers every request with an empty JSON array, on the default
 * entrypoint and on BrokerAdmin (the gateway binds the broker's admin entrypoint).
 */
const stubWorker = (name: string) => ({
  name,
  modules: true,
  compatibilityDate: '2026-08-15',
  script: `import { WorkerEntrypoint } from 'cloudflare:workers';
const empty = () => new Response('[]', { headers: { 'content-type': 'application/json' } });
export class BrokerAdmin extends WorkerEntrypoint { fetch() { return empty(); } }
export default { fetch: empty };`,
});

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        kvNamespaces: ['KILL_SWITCH'],
        // Test doubles for the secrets normally set with `wrangler secret put`.
        bindings: { GITHUB_WEBHOOK_SECRET: "It's a Secret to Everybody" },
        // The real broker and agents Workers are separate deployables; stub them here.
        workers: [stubWorker('custodes-github-broker'), stubWorker('custodes-agents')],
      },
    }),
  ],
});
