import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { KillSwitch } from '@custodes/core';
import { BrokerReadRequest } from '@custodes/schema';
import { read } from '../src/read.js';

const runId = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
const req = (over: Partial<BrokerReadRequest> = {}): BrokerReadRequest => ({
  agentId: 'triage',
  runId,
  repo: 'OWASP/CheatSheetSeries',
  resource: 'labels',
  query: {},
  ...over,
});
// Test double for the Secrets Store binding.
const testEnv = {
  ...env,
  PAT_READONLY: { get: () => Promise.resolve('ro-token') },
};

describe('broker read()', () => {
  it('GETs the allow-listed path with the read-only token and returns the data', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) =>
      Promise.resolve(Response.json([{ name: 'bug' }])),
    );
    const res = await read(testEnv, req(), fetchImpl);
    expect(res).toEqual({ ok: true, data: [{ name: 'bug' }] });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/repos/OWASP/CheatSheetSeries/labels?per_page=100');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer ro-token');
  });

  it('denies agents without a read policy and repos outside it, before any network call', async () => {
    const fetchImpl = vi.fn();
    expect(await read(testEnv, req({ agentId: 'hello' }), fetchImpl)).toMatchObject({
      ok: false,
      code: 'unknown_agent',
    });
    expect(await read(testEnv, req({ repo: 'evil/repo' }), fetchImpl)).toMatchObject({
      ok: false,
      code: 'policy_denied',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honours the kill switch', async () => {
    const ks = new KillSwitch(env.KILL_SWITCH);
    await ks.halt('triage', 'test', 'tester');
    expect(await read(testEnv, req(), vi.fn())).toMatchObject({ ok: false, code: 'halted' });
    await ks.resume('triage');
  });

  it('reports GitHub errors with status and rate-limit flag', async () => {
    const fetchImpl = () =>
      Promise.resolve(
        new Response('limited', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      );
    expect(await read(testEnv, req(), fetchImpl)).toEqual({
      ok: false,
      code: 'github_error',
      reason: 'GitHub 403 on labels',
      status: 403,
      rateLimited: true,
    });
  });

  it('rejects free-form paths and unknown query keys at the schema', () => {
    expect(BrokerReadRequest.safeParse({ ...req(), resource: 'contents/../../user' }).success).toBe(
      false,
    );
    expect(BrokerReadRequest.safeParse({ ...req(), query: { path: '/user' } }).success).toBe(false);
    expect(BrokerReadRequest.safeParse({ ...req(), path: '/user' }).success).toBe(false);
  });

  it('denies resources outside the agent read policy, before any network call', async () => {
    const fetchImpl = vi.fn();
    // triage may not read file contents; proposal-review may not read timelines.
    expect(
      await read(testEnv, req({ resource: 'cheatsheet', file: 'A_Cheat_Sheet.md' }), fetchImpl),
    ).toMatchObject({
      ok: false,
      code: 'policy_denied',
      reason: 'resource cheatsheet not allowed',
    });
    expect(
      await read(
        testEnv,
        req({ agentId: 'proposal-review', resource: 'timeline', number: 1 }),
        fetchImpl,
      ),
    ).toMatchObject({ ok: false, code: 'policy_denied' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets a specialist read a cheat sheet by validated file name', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) =>
      Promise.resolve(Response.json({ type: 'file', encoding: 'base64', content: 'IyBB' })),
    );
    const res = await read(
      testEnv,
      req({ agentId: 'implementation-check', resource: 'cheatsheet', file: 'A_Cheat_Sheet.md' }),
      fetchImpl,
    );
    expect(res.ok).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/OWASP/CheatSheetSeries/contents/cheatsheets/A_Cheat_Sheet.md',
    );
  });

  it('requires a number or file exactly where the resource needs one, and safe file names', () => {
    const ok = (over: Partial<BrokerReadRequest>) => BrokerReadRequest.safeParse(req(over)).success;
    expect(ok({ resource: 'issue', number: 1 })).toBe(true);
    expect(ok({ resource: 'issue' })).toBe(false);
    expect(ok({ resource: 'labels', number: 1 })).toBe(false);
    expect(ok({ resource: 'cheatsheet', file: 'A.md' })).toBe(true);
    expect(ok({ resource: 'cheatsheet', file: '../../README.md' })).toBe(false);
    expect(ok({ resource: 'cheatsheet', file: 'a/b.md' })).toBe(false);
    expect(ok({ resource: 'cheatsheet', file: '.hidden.md' })).toBe(false);
    expect(ok({ resource: 'cheatsheet' })).toBe(false);
    expect(ok({ resource: 'issues', query: { labels: 'a,b' } })).toBe(false);
  });
});
