import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/triage-worker.js';
import type { AgentsEnv } from '../src/env.js';
import { OWASP_INSTANCE } from '../src/instances.js';

/**
 * The custodes-triage entry point (ADR 0018). Runs here against the agents test env, which binds
 * the three classes; its own Worker config is pinned by bindings.test.
 */
const testEnv = env as AgentsEnv;
const get = (path: string) => worker.fetch(new Request(`https://x${path}`), testEnv);

describe('custodes-triage entry point', () => {
  it('serves health and its own three agent classes only', async () => {
    expect((await get('/healthz')).status).toBe(200);
    for (const path of [
      `/agents/pr-gate-agent/${OWASP_INSTANCE}`,
      `/agents/cheatsheet-review-agent/${OWASP_INSTANCE}`,
      '/agents/keyholder/default',
      '/agents//keyholder/default',
      '/agents//triage-agent/evil',
      '/agents/triage-agent/not-an-instance',
      '/registry',
    ])
      expect((await get(path)).status, path).toBe(404);
  });

  it('ignores unknown crons', async () => {
    await expect(
      worker.scheduled({ cron: '* * * * *', scheduledTime: 0, noRetry: () => undefined }, testEnv),
    ).resolves.toBeUndefined();
  });

  it('has no queue handler (triage runs on crons only)', () => {
    expect((worker as { queue?: unknown }).queue).toBeUndefined();
  });
});
