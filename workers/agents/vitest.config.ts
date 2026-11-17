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
      // Production's custodes-agents holds no agent (ADR 0018), so the tests run from a test-only
      // entry that exports every agent class, with the bindings the agent Workers have between them.
      main: './test/entry.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      // The AI binding (Clef) is remote-only: tests never reach Workers AI, they inject a fake.
      remoteBindings: false,
      miniflare: {
        // Test-only: no agent Worker binds the kill switch (#103, threat T1). Tests write halt
        // flags here and the stub broker above reads the same namespace.
        kvNamespaces: { KILL_SWITCH: 'kill-switch' },
        // Test-only: every agent class, bound side by side (production binds each in its own Worker).
        durableObjects: {
          TriageAgent: { className: 'TriageAgent', useSQLite: true },
          ImplementationCheckAgent: { className: 'ImplementationCheckAgent', useSQLite: true },
          ProposalReviewAgent: { className: 'ProposalReviewAgent', useSQLite: true },
          PrGateAgent: { className: 'PrGateAgent', useSQLite: true },
          CheatsheetReviewAgent: { className: 'CheatsheetReviewAgent', useSQLite: true },
          // As in every agent Worker: broker calls are signed by the Worker's Keyholder (ADR 0018).
          KEYHOLDER: { className: 'Keyholder', useSQLite: true },
        },
        serviceBindings: { BROKER: 'custodes-github-broker' },
        // The vars every agent Worker sets in its own wrangler file, with the same values.
        bindings: {
          ENVIRONMENT: 'prod',
          CALLER_NAME: 'custodes-pr-gate',
          AI_GATEWAY_ACCOUNT_ID: '5f62912564df344533c9563904c77662',
          AI_GATEWAY_ID: 'custodes',
          EMAIL_FROM: 'custodes@custodes.work',
          EMAIL_DOMAIN: 'custodes.work',
          OPERATOR_EMAIL: 'jkb.mackowski@gmail.com',
          TRACE_PAYLOADS: 'true',
          APPROVAL_LINK_BASE: 'https://custodes.work/admin/approvals/link',
          PR_GATE_ENFORCE: 'true',
          JEV_TRANSPORT: 'direct',
          JEV_GATEWAY_PATH: 'api/alpha/decisions',
          AI_GATEWAY_TOKEN: 'test',
          OPENROUTER_API_KEY: 'test',
        },
        workers: [brokerStub],
      },
    }),
  ],
});
