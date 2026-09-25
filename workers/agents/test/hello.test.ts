import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { KillSwitch } from '@custodes/core';
import worker from '../src/index.js';
import type { AgentsEnv } from '../src/env.js';

const testEnv = env as AgentsEnv;
const ctx = {} as ExecutionContext;

describe('agents worker', () => {
  it('lists the registry', async () => {
    const res = await worker.fetch(new Request('https://x/registry'), testEnv, ctx);
    const body = await res.json<{ id: string }[]>();
    expect(body.map((m) => m.id)).toContain('hello');
  });

  it('routes to HelloAgent and respects the kill switch', async () => {
    const status = await worker.fetch(
      new Request('https://x/agents/hello-agent/default'),
      testEnv,
      ctx,
    );
    expect(status.status).toBe(200);
    const run = await worker.fetch(
      new Request('https://x/agents/hello-agent/default/run', { method: 'POST' }),
      testEnv,
      ctx,
    );
    expect(await run.json()).toMatchObject({ ok: true });

    await new KillSwitch(testEnv.KILL_SWITCH).halt('hello', 'test', 'tester');
    const halted = await worker.fetch(
      new Request('https://x/agents/hello-agent/default/run', { method: 'POST' }),
      testEnv,
      ctx,
    );
    expect(await halted.json()).toMatchObject({ ok: false });
    await new KillSwitch(testEnv.KILL_SWITCH).resume('hello');
  });
});
