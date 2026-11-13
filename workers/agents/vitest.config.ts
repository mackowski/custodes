import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Stub broker: every action and read is denied so no test can accidentally reach GitHub. It answers
 * `/v1/state` from the kill-switch namespace the tests write to, like the real broker.
 */
const brokerStub = {
  name: 'custodes-github-broker',
  modules: true,
  compatibilityDate: '2026-08-15',
  kvNamespaces: { KILL_SWITCH: 'kill-switch' },
  script: `export default { async fetch(req, env) {
    if (new URL(req.url).pathname === '/v1/state') {
      const { agentId } = await req.json();
      for (const key of ['halt:*', 'halt:' + agentId]) {
        const raw = await env.KILL_SWITCH.get(key);
        if (raw !== null) return new Response(raw, { headers: { 'content-type': 'application/json' } });
      }
      return Response.json({ halted: false });
    }
    return Response.json({ ok: false, code: 'policy_denied', reason: 'stub broker' });
  } }`,
};

export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The AI binding (Clef) is remote-only: tests never reach Workers AI, they inject a fake.
      remoteBindings: false,
      miniflare: {
        // Test-only: the Worker itself no longer binds the kill switch (#103, threat T1). Tests write
        // halt flags here and the stub broker above reads the same namespace.
        kvNamespaces: { KILL_SWITCH: 'kill-switch' },
        // Test-only: every agent runs in its own Worker since its cutover (triage, pr-gate,
        // cheatsheet-review); the tests still load them from this Worker's code (src/index.ts
        // exports the classes).
        durableObjects: {
          TriageAgent: { className: 'TriageAgent', useSQLite: true },
          ImplementationCheckAgent: { className: 'ImplementationCheckAgent', useSQLite: true },
          ProposalReviewAgent: { className: 'ProposalReviewAgent', useSQLite: true },
          PrGateAgent: { className: 'PrGateAgent', useSQLite: true },
          CheatsheetReviewAgent: { className: 'CheatsheetReviewAgent', useSQLite: true },
        },
        bindings: {
          AI_GATEWAY_TOKEN: 'test',
          OPENROUTER_API_KEY: 'test',
        },
        workers: [brokerStub],
      },
    }),
  ],
});
