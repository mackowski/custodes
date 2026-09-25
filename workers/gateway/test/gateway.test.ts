import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { GatewayEnv } from '../src/env.js';

const testEnv = (): GatewayEnv => ({
  ...(env as GatewayEnv),
  ACCESS_TEAM: 'test',
  ACCESS_AUD: 'aud',
});
const ctx = {} as ExecutionContext;

describe('gateway', () => {
  it('serves health', async () => {
    const res = await worker.fetch(new Request('https://x/healthz'), testEnv(), ctx);
    expect(res.status).toBe(200);
  });
  it('rejects unsigned webhooks', async () => {
    const res = await worker.fetch(
      new Request('https://x/webhooks/github', { method: 'POST', body: '{}' }),
      testEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
  });
  it('accepts a correctly signed webhook and queues it', async () => {
    const body = JSON.stringify({
      repository: { full_name: 'a/b' },
      sender: { login: 'x' },
      issue: { number: 1 },
    });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(testEnv().GITHUB_WEBHOOK_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = Array.from(
      new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    const res = await worker.fetch(
      new Request('https://x/webhooks/github', {
        method: 'POST',
        body,
        headers: { 'x-hub-signature-256': `sha256=${sig}`, 'x-github-event': 'issues' },
      }),
      testEnv(),
      ctx,
    );
    expect(res.status).toBe(202);
  });
  it('requires Access on the admin API', async () => {
    const res = await worker.fetch(new Request('https://x/admin/agents'), testEnv(), ctx);
    expect(res.status).toBe(401);
  });
});
