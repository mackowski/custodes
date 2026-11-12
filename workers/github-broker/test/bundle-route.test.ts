import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { signRequest } from '@custodes/core';
import { AgentKeys, type CallerName } from '@custodes/schema';
import { callerApp } from '../src/index.js';

const KID = 'triage-apply-20261112-a1b2c3d4';
const REPO = 'mackowski/custodes-sandbox';
const runId = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
let priv: CryptoKey;
let priv2: CryptoKey;
let keys: AgentKeys;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  priv = pair.privateKey;
  const { x } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x: string };
  const pair2 = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  priv2 = pair2.privateKey;
  const { x: x2 } = (await crypto.subtle.exportKey('jwk', pair2.publicKey)) as { x: string };
  keys = AgentKeys.parse({
    version: 1,
    callers: {
      'custodes-triage-apply': [{ kid: KID, x, addedAt: '2026-11-12' }],
      'custodes-triage': [{ kid: 'triage-20261112-a1b2c3d4', x: x2, addedAt: '2026-11-12' }],
    },
  });
});
afterEach(() => vi.restoreAllMocks());

const askFor = (agentId: string) => ({
  request: {
    agentId,
    agentVersion: '0.1.0',
    runId,
    triggeredBy: { kind: 'cli', ref: 'x' },
    bundle: {
      actions: [{ type: 'issue.comment', repo: REPO, issue: 900, body: 'hello' }],
      snapshot: {
        state: 'open',
        labels: [],
        assignees: [],
        comments: 0,
        updatedAt: '2026-11-10T10:00:00Z',
        commentsDigest:
          '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' /* sha256('[]'): no comments */,
      },
    },
  },
  rationale: 'r',
});

async function post(
  app: CallerName,
  kid: string,
  payload: unknown,
  key = priv,
  path = '/v1/approvals/bundle',
) {
  const body = JSON.stringify(payload);
  const headers = await signRequest(key, kid, { method: 'POST', path, body });
  return callerApp(app, keys).request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
    env,
  );
}

describe('/v1/approvals/bundle on the custodes-triage-apply entrypoint', () => {
  it('refuses an unsigned request', async () => {
    const res = await callerApp('custodes-triage-apply', keys).request(
      '/v1/approvals/bundle',
      { method: 'POST', body: JSON.stringify(askFor('triage-apply')) },
      env,
    );
    expect(res.status).toBe(401);
  });

  it.each(['triage', 'proposal-review', 'pr-gate', 'cheatsheet-review'])(
    'refuses a bundle for agent id %s',
    async (agentId) => {
      const res = await post('custodes-triage-apply', KID, askFor(agentId));
      expect(res.status).toBe(403);
    },
  );

  it('refuses a bundle for triage-apply sent through another Worker entrypoint', async () => {
    const res = await post(
      'custodes-triage',
      'triage-20261112-a1b2c3d4',
      askFor('triage-apply'),
      priv2,
    );
    expect(res.status).toBe(403);
  });

  it('answers 400 for a body that is not a bundle ask', async () => {
    const bad = askFor('triage-apply');
    bad.request.bundle.actions.push({
      type: 'issue.comment',
      repo: REPO,
      issue: 900,
      body: 'twice',
    });
    const res = await post('custodes-triage-apply', KID, bad);
    expect(res.status).toBe(400);
  });

  it('serves a valid ask for triage-apply: 201 with a token, or the broker refusal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = new URL(typeof input === 'string' ? input : (input as Request).url).pathname;
      if (path.endsWith('/comments')) return Promise.resolve(Response.json([]));
      return Promise.resolve(
        Response.json({
          state: 'open',
          user: { login: 'a' },
          labels: [],
          assignees: [],
          comments: 0,
          updated_at: '2026-11-10T10:00:00Z',
        }),
      );
    });
    const testEnvPat = {
      ...env,
      PAT_READONLY: { get: () => Promise.resolve('r') },
    };
    const body = JSON.stringify(askFor('triage-apply'));
    const headers = await signRequest(priv, KID, {
      method: 'POST',
      path: '/v1/approvals/bundle',
      body,
    });
    const res = await callerApp('custodes-triage-apply', keys).request(
      '/v1/approvals/bundle',
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
      testEnvPat,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      token: expect.any(String) as unknown,
      approval: { status: 'pending' },
    });
  });
});
