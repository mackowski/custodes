import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { signRequest } from '@custodes/core';
import { AgentKeys, type CallerName, Policy } from '@custodes/schema';
import { CALLER_AGENTS, isIsolated } from '../src/callers.js';
import { callerApp, sharedAgentApp } from '../src/index.js';
import { policy } from '../src/policy.js';

const KEY_ID = 'pr-gate-20261109-a1b2c3d4';
let priv: CryptoKey;
let other: CryptoKey;
let keys: AgentKeys;

beforeAll(async () => {
  const gen = async () =>
    (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
  const pair = await gen();
  priv = pair.privateKey;
  other = (await gen()).privateKey;
  const { x } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x: string };
  keys = AgentKeys.parse({
    version: 1,
    callers: { 'custodes-pr-gate': [{ keyId: KEY_ID, x, addedAt: '2026-11-09' }] },
  });
});

/** A request to the pr-gate entrypoint, signed with `key` unless `headers` are given. */
async function call(
  path: string,
  payload: unknown,
  opts: {
    key?: CryptoKey;
    keyId?: string;
    headers?: Record<string, string>;
    app?: CallerName;
  } = {},
) {
  const body = JSON.stringify(payload);
  const headers =
    opts.headers ??
    (await signRequest(opts.key ?? priv, opts.keyId ?? KEY_ID, { method: 'POST', path, body }));
  const app = callerApp(opts.app ?? 'custodes-pr-gate', keys);
  return app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
    env,
  );
}

describe('per-Worker broker entrypoints (ADR 0018)', () => {
  it('serves a signed request for an agent the Worker hosts', async () => {
    const res = await call('/v1/state', { agentId: 'pr-gate' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ halted: false });
  });

  it('refuses an unsigned request, a foreign key and an unknown key id', async () => {
    expect((await call('/v1/state', { agentId: 'pr-gate' }, { headers: {} })).status).toBe(401);
    const foreign = await call('/v1/state', { agentId: 'pr-gate' }, { key: other });
    expect(foreign.status).toBe(401);
    expect(await foreign.json()).toMatchObject({
      code: 'unauthenticated',
      reason: 'bad_signature',
    });
    const unknown = await call(
      '/v1/state',
      { agentId: 'pr-gate' },
      { keyId: 'x-20261109-00000000' },
    );
    expect(await unknown.json()).toMatchObject({ reason: 'unknown_key' });
  });

  it('refuses a replayed request', async () => {
    const body = JSON.stringify({ agentId: 'pr-gate' });
    const headers = await signRequest(priv, KEY_ID, { method: 'POST', path: '/v1/state', body });
    expect((await call('/v1/state', { agentId: 'pr-gate' }, { headers })).status).toBe(200);
    const again = await call('/v1/state', { agentId: 'pr-gate' }, { headers });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ reason: 'replayed' });
  });

  it('refuses a body signed for another endpoint', async () => {
    const body = JSON.stringify({ agentId: 'pr-gate' });
    const headers = await signRequest(priv, KEY_ID, { method: 'POST', path: '/v1/read', body });
    expect((await call('/v1/state', { agentId: 'pr-gate' }, { headers })).status).toBe(401);
  });

  it('refuses, on every route, an agent id the Worker does not host', async () => {
    const request = {
      agentId: 'cheatsheet-review',
      agentVersion: '0.1.0',
      runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      triggeredBy: { kind: 'cli', ref: 'test' },
      action: { type: 'pr.close', repo: 'mackowski/custodes-sandbox', pull: 1, body: 'x' },
    };
    const read = {
      agentId: 'triage',
      runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      repo: 'OWASP/CheatSheetSeries',
      resource: 'labels',
      query: {},
    };
    for (const [path, payload] of [
      ['/v1/act', request],
      ['/v1/read', read],
      ['/v1/state', { agentId: 'triage' }],
      ['/v1/approvals', { request, rationale: 'x' }],
    ] as const) {
      const res = await call(path, payload);
      expect(res.status, path).toBe(403);
    }
  });

  it('refuses every request on an entrypoint with no pinned key', async () => {
    const res = await call('/v1/state', { agentId: 'triage' }, { app: 'custodes-triage' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'unknown_key' });
  });

  it('maps each agent id to at most one Worker', () => {
    const all = Object.values(CALLER_AGENTS).flat();
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the shared default entrypoint during the transition', () => {
  const withIsolated = (id: string): Policy =>
    Policy.parse({
      ...policy,
      agents: Object.fromEntries(
        Object.entries(policy.agents).map(([k, v]) => [k, k === id ? { ...v, isolated: true } : v]),
      ),
    });

  it('refuses an agent marked isolated, and still serves the others', async () => {
    const p = withIsolated('pr-gate');
    expect(isIsolated('pr-gate', p)).toBe(true);
    const app = sharedAgentApp(p);
    const post = (agentId: string) =>
      app.request(
        '/v1/state',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentId }),
        },
        env,
      );
    expect((await post('pr-gate')).status).toBe(403);
    expect((await post('cheatsheet-review')).status).toBe(200);
  });

  it('marks no agent isolated in the committed policy yet', () => {
    for (const id of [...Object.keys(policy.agents), ...Object.keys(policy.reads)])
      expect(isIsolated(id), id).toBe(false);
  });
});
