import { describe, expect, it, vi } from 'vitest';
import { runRoute } from '../src/runtime/run-routes.js';

const RUN = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
const base = `https://agents.internal/agents/backlog-review-agent/owasp/runs/${RUN}`;
const person = { 'x-custodes-actor-via': 'access-user' };

function ops() {
  return {
    kill: vi.fn(() => Promise.resolve(2)),
    events: vi.fn(() => Promise.resolve([])),
  };
}

describe('runRoute (ADR 0023)', () => {
  it('kills a run for a person and lists its events marked untrusted', async () => {
    const o = ops();
    const kill = await runRoute(
      new Request(`${base}/kill`, { method: 'POST', headers: person }),
      o,
    );
    expect(await kill?.json()).toEqual({ runId: RUN, killed: 2 });
    expect(o.kill).toHaveBeenCalledWith(RUN);
    const ev = await runRoute(new Request(`${base}/events`, { headers: person }), o);
    expect(await ev?.json()).toEqual({ runId: RUN, untrusted: true, events: [] });
  });

  it('refuses a service token or a missing actor, and a wrong method', async () => {
    const o = ops();
    for (const headers of [{ 'x-custodes-actor-via': 'access-service-token' }, {}]) {
      const r = await runRoute(new Request(`${base}/kill`, { method: 'POST', headers }), o);
      expect(r?.status).toBe(403);
    }
    expect((await runRoute(new Request(`${base}/kill`, { headers: person }), o))?.status).toBe(405);
    expect(o.kill).not.toHaveBeenCalled();
  });

  it('ignores other paths and run ids that are not UUIDs', async () => {
    const o = ops();
    expect(await runRoute(new Request('https://x/agents/a/b/status'), o)).toBeNull();
    expect(
      await runRoute(new Request('https://x/agents/a/b/runs/../kill', { method: 'POST' }), o),
    ).toBeNull();
    expect(
      await runRoute(new Request('https://x/agents/a/b/runs/abc/kill', { method: 'POST' }), o),
    ).toBeNull();
  });
});
