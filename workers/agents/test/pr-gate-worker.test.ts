import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/pr-gate-worker.js';
import type { AgentsEnv } from '../src/env.js';
import { OWASP_INSTANCE, SANDBOX_INSTANCE } from '../src/instances.js';

/**
 * The custodes-pr-gate entry point (ADR 0018). Runs here against the agents test env, which binds
 * PrGateAgent; its own Worker config (workers/pr-gate/wrangler.jsonc) is pinned by bindings.test.
 */
const testEnv = env as AgentsEnv;
const get = (path: string) => worker.fetch(new Request(`https://x${path}`), testEnv);

describe('custodes-pr-gate entry point', () => {
  it('serves health and its own agent class only', async () => {
    expect((await get('/healthz')).status).toBe(200);
    expect((await get(`/agents/pr-gate-agent/${SANDBOX_INSTANCE}/report`)).status).toBe(200);
    for (const path of [
      `/agents/triage-agent/${OWASP_INSTANCE}`,
      `/agents/cheatsheet-review-agent/${OWASP_INSTANCE}`,
      '/agents/keyholder/default',
      '/agents//keyholder/default',
      '/agents//pr-gate-agent/evil',
      '/agents/pr-gate-agent/not-an-instance',
      '/registry',
    ])
      expect((await get(path)).status, path).toBe(404);
  });

  it('ignores unknown crons', async () => {
    await expect(
      worker.scheduled({ cron: '* * * * *', scheduledTime: 0, noRetry: () => undefined }, testEnv),
    ).resolves.toBeUndefined();
  });

  it('acks and drops queue messages that are not for pr-gate', async () => {
    const acked: string[] = [];
    const msg = (id: string, body: unknown) => ({
      id,
      body,
      timestamp: new Date(),
      attempts: 1,
      ack: () => void acked.push(id),
      retry: () => {
        throw new Error(`retried ${id}`);
      },
    });
    const labeled = {
      id: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      receivedAt: new Date().toISOString(),
      source: 'github-webhook',
      event: 'pull_request',
      deliveryId: 'd1',
      repo: 'mackowski/custodes-sandbox',
      payload: {
        action: 'labeled',
        repository: { full_name: 'mackowski/custodes-sandbox' },
        sender: { login: 'mackowski' },
        pull_request: { number: 1 },
        label: { name: 'custodes_cheatsheet_review' },
      },
    };
    await worker.queue(
      {
        queue: 'custodes-inbound-pr-gate',
        messages: [msg('garbage', { nope: true }), msg('cheatsheet', labeled)],
        ackAll: () => undefined,
        retryAll: () => undefined,
      } as unknown as MessageBatch,
      testEnv,
    );
    expect(acked).toEqual(['garbage', 'cheatsheet']);
  });
});
