import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  KeyStore,
  type KeyStorage,
  NEXT_KEY_PROBE_INTERVAL_MS,
  signingBroker,
  signRequest,
  verifyCallerIntent,
} from '@custodes/core';
import { AgentKeys, type CallerName, verificationKeys } from '@custodes/schema';
import { CALLER_AGENTS } from '../src/callers.js';
import { Hono } from 'hono';
import broker, { agentRoutes, callerApp, sharedAgentApp } from '../src/index.js';
import { AuditStore } from '../src/store.js';
import { policy } from '../src/policy.js';

const KID = 'pr-gate-20261109-a1b2c3d4';
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
    callers: { 'custodes-pr-gate': [{ kid: KID, x, addedAt: '2026-11-09' }] },
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
    (await signRequest(opts.key ?? priv, opts.keyId ?? KID, { method: 'POST', path, body }));
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
    const headers = await signRequest(priv, KID, { method: 'POST', path: '/v1/state', body });
    expect((await call('/v1/state', { agentId: 'pr-gate' }, { headers })).status).toBe(200);
    const again = await call('/v1/state', { agentId: 'pr-gate' }, { headers });
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ reason: 'replayed' });
  });

  it('refuses a body signed for another endpoint', async () => {
    const body = JSON.stringify({ agentId: 'pr-gate' });
    const headers = await signRequest(priv, KID, { method: 'POST', path: '/v1/read', body });
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

describe('approval ids on a per-Worker entrypoint (security review of #116, L2)', () => {
  it('refuses a signed /v1/act that names an approval: only the broker runs approved actions', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const res = await call('/v1/act', {
        agentId: 'pr-gate',
        agentVersion: '0.3.0',
        runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
        triggeredBy: { kind: 'schedule' },
        action: { type: 'pr.close', repo: 'mackowski/custodes-sandbox', pull: 1, body: 'x' },
        approvalId: '30d2f6f4-0814-4ad7-859a-01b8cd18eece',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ reason: 'approved actions are run by the broker' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('agent signature in the audit record (ADR 0018, R1)', () => {
  // pr-gate may not comment, so the broker denies this: it still writes a signed audit record,
  // and nothing reaches GitHub.
  const request = {
    agentId: 'pr-gate',
    agentVersion: '0.3.0',
    runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
    triggeredBy: { kind: 'schedule' },
    action: { type: 'issue.comment', repo: 'mackowski/custodes-sandbox', issue: 1, body: 'x' },
  };
  const send = async (body: string) =>
    callerApp('custodes-pr-gate', keys).request(
      '/v1/act',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(await signRequest(priv, KID, { method: 'POST', path: '/v1/act', body })),
        },
        body,
      },
      env,
    );

  it('records the signature, and /verify logic finds it valid for that exact request', async () => {
    const res = await send(canonicalJson(request));
    const out = await res.json<{ ok: boolean; code: string; attestationId: string }>();
    expect(out).toMatchObject({ ok: false, code: 'policy_denied' });
    const att = await new AuditStore(env.AUDIT).get(out.attestationId);
    expect(att?.record.callerSignature).toMatchObject({
      caller: 'custodes-pr-gate',
      kid: KID,
      path: '/v1/act',
    });
    expect(await verifyCallerIntent(att!.record, (c) => verificationKeys(keys, c))).toEqual({
      status: 'valid',
      caller: 'custodes-pr-gate',
      kid: KID,
    });
  });

  it('refuses a nonce the audit log could not read back, before any side effect', async () => {
    const body = canonicalJson(request);
    // Valid hex shape (the signature check accepts it) but not an RFC 4122 UUID (the record needs one).
    const nonce = '11111111-1111-1111-1111-111111111111';
    const headers = await signRequest(
      priv,
      KID,
      { method: 'POST', path: '/v1/act', body },
      Date.now(),
      nonce,
    );
    const res = await callerApp('custodes-pr-gate', keys).request(
      '/v1/act',
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: 'signature fields' });
  });

  it('refuses an encoded path even though the router would map it to /v1/act', async () => {
    const body = canonicalJson(request);
    const headers = await signRequest(priv, KID, { method: 'POST', path: '/v1/%61ct', body });
    const res = await callerApp('custodes-pr-gate', keys).request(
      '/v1/%61ct',
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
      env,
    );
    expect(res.status).toBe(404);
  });

  it('refuses a signed body that is not the canonical JSON of the request', async () => {
    const res = await send(JSON.stringify(request, null, 2));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: /canonical JSON/ });
  });
});

describe('agent side to broker, end to end (ADR 0018)', () => {
  const memStorage = (): KeyStorage => {
    const m = new Map<string, unknown>();
    return {
      get: <T>(k: string) => Promise.resolve(m.get(k) as T | undefined),
      put: (k: string, v: unknown) => Promise.resolve(void m.set(k, structuredClone(v))),
    };
  };
  const pin = (...ks: { kid: string; x: string }[]) =>
    AgentKeys.parse({
      version: 1,
      callers: {
        'custodes-pr-gate': ks.map((k) => ({ kid: k.kid, x: k.x, addedAt: '2026-11-09' })),
      },
    });
  /** The agent's signed client against a broker that pins `keys()` (read on every call). */
  const wire = (keyholder: KeyStore, keys: () => AgentKeys) =>
    signingBroker(
      {
        fetch: (url, init) =>
          Promise.resolve(
            callerApp('custodes-pr-gate', keys()).request(new URL(url).pathname, init, env),
          ),
      },
      keyholder,
    );
  const state = (broker: ReturnType<typeof wire>) =>
    broker.fetch('https://broker.internal/v1/state', {
      method: 'POST',
      body: JSON.stringify({ agentId: 'pr-gate' }),
    });

  it("accepts an agent's signed call once its key is pinned, and records a valid agent signature", async () => {
    const keyholder = new KeyStore(memStorage(), 'custodes-pr-gate');
    await keyholder.signRequest({ method: 'POST', path: '/x', body: '{}' }); // first use makes the key
    const [active] = await keyholder.publicKeys();
    let pinned = pin(); // not pinned yet: refused, so the agent stays stopped
    const broker = wire(keyholder, () => pinned);
    expect((await state(broker)).status).toBe(401);
    pinned = pin(active!);
    expect((await state(broker)).status).toBe(200);
    const request = {
      agentId: 'pr-gate',
      agentVersion: '0.3.0',
      runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      triggeredBy: { kind: 'schedule' },
      action: { type: 'issue.comment', repo: 'mackowski/custodes-sandbox', issue: 1, body: 'x' },
    };
    // Not canonical on purpose: the client re-serialises before signing.
    const res = await broker.fetch('https://broker.internal/v1/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request, null, 2),
    });
    const out = await res.json<{ code: string; attestationId: string }>();
    expect(out.code).toBe('policy_denied'); // pr-gate may not comment; nothing reaches GitHub
    const att = await new AuditStore(env.AUDIT).get(out.attestationId);
    expect(await verifyCallerIntent(att!.record, (c) => verificationKeys(pinned, c))).toMatchObject(
      { status: 'valid', kid: active!.kid },
    );
  });

  it('rotates without downtime: old key works throughout, next key takes over once pinned', async () => {
    // Real time for signatures; the probe throttle is passed by moving `skew` past its interval.
    let skew = 0;
    const keyholder = new KeyStore(
      memStorage(),
      'custodes-pr-gate',
      () => new Date(Date.now() + skew),
    );
    await keyholder.signRequest({ method: 'POST', path: '/x', body: '{}' });
    const [old] = await keyholder.publicKeys();
    let pinned = pin(old!);
    const broker = wire(keyholder, () => pinned);
    const probe = async (
      sign: Parameters<Parameters<KeyStore['activateNextIfAccepted']>[0]>[0],
    ) => {
      const body = JSON.stringify({ agentId: 'pr-gate' });
      const headers = await sign({ method: 'POST', path: '/v1/state', body });
      const res = await callerApp('custodes-pr-gate', pinned).request(
        '/v1/state',
        { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body },
        env,
      );
      return res.status === 200;
    };

    const next = await keyholder.rotate();
    expect((await state(broker)).status).toBe(200); // still the old key
    expect(await keyholder.activateNextIfAccepted(probe)).toBe(false); // next not pinned yet
    pinned = pin(old!, next); // the rotation PR pins both
    expect((await state(broker)).status).toBe(200);
    // Throttled right after the refused probe; offered again after the interval. The clock moves
    // back afterwards so signatures stay inside the broker's window.
    expect(await keyholder.activateNextIfAccepted(probe)).toBe(false);
    skew = NEXT_KEY_PROBE_INTERVAL_MS + 1000;
    const switched = keyholder.activateNextIfAccepted(async (sign) => {
      skew = 0;
      return probe(sign);
    });
    expect(await switched).toBe(true);
    expect((await state(broker)).status).toBe(200); // now signed with the next key
    pinned = pin(next); // the follow-up retires the old key
    expect((await state(broker)).status).toBe(200);
  });
});

describe('the default (unsigned) entrypoint serves no agent (ADR 0018)', () => {
  const runId = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
  /** One payload per route, all naming `agentId`. */
  const routes = (agentId: string) => {
    const request = {
      agentId,
      agentVersion: '0.1.0',
      runId,
      triggeredBy: { kind: 'cli', ref: 'test' },
      action: { type: 'pr.close', repo: 'mackowski/custodes-sandbox', pull: 1, body: 'x' },
    };
    return [
      ['/v1/act', request],
      [
        '/v1/read',
        { agentId, runId, repo: 'OWASP/CheatSheetSeries', resource: 'labels', query: {} },
      ],
      ['/v1/state', { agentId }],
      ['/v1/approvals', { request, rationale: 'x' }],
      [
        '/v1/approvals/bundle',
        {
          request: {
            agentId,
            agentVersion: '0.1.0',
            runId,
            triggeredBy: { kind: 'cli', ref: 'x' },
            bundle: {
              actions: [
                { type: 'issue.comment', repo: 'mackowski/custodes-sandbox', issue: 1, body: 'x' },
              ],
              snapshot: {
                state: 'open',
                labels: [],
                assignees: [],
                comments: 0,
                updatedAt: '2026-11-10T10:00:00Z',
                commentsDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
              },
            },
          },
          rationale: 'r',
        },
      ],
    ] as const;
  };
  const post = (path: string, payload: unknown) =>
    sharedAgentApp().request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      },
      env,
    );

  it('refuses every route for every agent in the policy, and for one that is not in it', async () => {
    // By code, not by a policy flag: a new agent added to policy.json is refused with no flag.
    const ids = [
      ...new Set([...Object.keys(policy.agents), ...Object.keys(policy.reads)]),
      'a-future-agent',
    ];
    expect(ids.length).toBeGreaterThan(5);
    for (const id of ids)
      for (const [path, payload] of routes(id)) {
        const res = await post(path, payload);
        expect(res.status, `${id} ${path}`).toBe(403);
        // The reason proves the refusal came from the entrypoint, not a later step that also says 403.
        expect(JSON.stringify(await res.json()), `${id} ${path}`).toMatch(
          /signed broker entrypoint/,
        );
      }
  });

  it('the shared route code never runs an unsigned action, whatever admit says (review of #122, L2)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const open = agentRoutes(new Hono(), () => null, 'test');
      const [, payload] = routes('pr-gate')[0];
      const res = await open.request(
        '/v1/act',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
        env,
      );
      expect(res.status).toBe(401);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('is what the Worker answers on its default export', async () => {
    const res = await broker.fetch(
      new Request('https://broker.internal/v1/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'cheatsheet-review' }),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });
});
