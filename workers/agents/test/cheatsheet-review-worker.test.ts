import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/cheatsheet-review-worker.js';
import type { AgentsEnv } from '../src/env.js';
import { OWASP_INSTANCE } from '../src/instances.js';

/**
 * The custodes-cheatsheet-review entry point (ADR 0018). Runs here against the agents test env,
 * which binds CheatsheetReviewAgent; its own Worker config is pinned by bindings.test.
 */
const testEnv = env as AgentsEnv;
const get = (path: string) => worker.fetch(new Request(`https://x${path}`), testEnv);

describe('custodes-cheatsheet-review entry point', () => {
  it('serves health and its own agent class only', async () => {
    expect((await get('/healthz')).status).toBe(200);
    for (const path of [
      `/agents/pr-gate-agent/${OWASP_INSTANCE}`,
      `/agents/triage-agent/${OWASP_INSTANCE}`,
      '/agents/keyholder/default',
      '/agents//keyholder/default',
      '/agents//cheatsheet-review-agent/evil',
      '/agents/cheatsheet-review-agent/not-an-instance',
      '/registry',
    ])
      expect((await get(path)).status, path).toBe(404);
  });

  it('acks and drops queue messages that are not for cheatsheet-review', async () => {
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
    const synchronize = {
      id: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      receivedAt: new Date().toISOString(),
      source: 'github-webhook',
      event: 'pull_request',
      deliveryId: 'd1',
      repo: 'mackowski/custodes-sandbox',
      payload: {
        action: 'synchronize',
        repository: { full_name: 'mackowski/custodes-sandbox' },
        sender: { login: 'someone' },
        pull_request: { number: 1, updated_at: new Date().toISOString() },
      },
    };
    await worker.queue(
      {
        queue: 'custodes-inbound-cheatsheet-review',
        messages: [msg('garbage', { nope: true }), msg('pr-gate', synchronize)],
        ackAll: () => undefined,
        retryAll: () => undefined,
      } as unknown as MessageBatch,
      testEnv,
    );
    expect(acked).toEqual(['garbage', 'pr-gate']);
  });
});
