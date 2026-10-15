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

describe('cross-site writes to Access-protected routes', () => {
  const post = (path: string, site?: string) =>
    worker.fetch(
      new Request(`https://x${path}`, {
        method: 'POST',
        headers: site ? { 'sec-fetch-site': site } : {},
      }),
      testEnv(),
      ctx,
    );

  it('refuses browser POSTs from another site before checking Access', async () => {
    for (const path of [
      '/admin/agents/pr-gate/resume',
      '/agents/pr-gate-agent/custodes-sandbox/run',
    ]) {
      expect((await post(path, 'cross-site')).status, path).toBe(403);
      expect((await post(path, 'same-site')).status, path).toBe(403);
    }
  });

  it('leaves the CLI (no Sec-Fetch headers) and same-origin requests to the Access check', async () => {
    expect((await post('/agents/pr-gate-agent/custodes-sandbox/run')).status).toBe(401);
    expect((await post('/admin/agents/pr-gate/resume', 'same-origin')).status).toBe(401);
  });
});
