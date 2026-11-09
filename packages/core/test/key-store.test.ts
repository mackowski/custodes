import { describe, expect, it } from 'vitest';
import type { PinnedAgentKey } from '@custodes/schema';
import { KeyStore, newKid, type KeyStorage } from '../src/key-store.js';
import { verifyRequestSignature } from '../src/request-signature.js';
import { signingBroker } from '../src/signed-broker.js';
import { canonicalJson } from '../src/canonical.js';

const NOW = new Date(Date.UTC(2026, 10, 9, 12, 0, 0));
const CALLER = 'custodes-pr-gate';

function memStorage(): KeyStorage & { dump(): string } {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string) => Promise.resolve(m.get(k) as T | undefined),
    put: (k: string, v: unknown) => {
      m.set(k, structuredClone(v));
      return Promise.resolve();
    },
    dump: () => JSON.stringify([...m.entries()]),
  };
}

const pinnedOf = (k: { kid: string; x: string }): PinnedAgentKey => ({
  kid: k.kid,
  x: k.x,
  addedAt: '2026-11-09',
});

const part = { method: 'POST', path: '/v1/state', body: '{"agentId":"pr-gate"}' };

describe('Keyholder key store (ADR 0018)', () => {
  it('creates a key on first use and signs requests the broker accepts with its public key', async () => {
    const store = new KeyStore(memStorage(), () => NOW);
    const headers = await store.signRequest(CALLER, part);
    const [active] = await store.publicKeys();
    expect(active).toMatchObject({ state: 'active' });
    expect(active?.kid).toMatch(/^pr-gate-20261109-[0-9a-f]{8}$/);
    expect(
      await verifyRequestSignature([pinnedOf(active!)], new Headers(headers), part, NOW.getTime()),
    ).toMatchObject({ ok: true, keyId: active?.kid });
    // Same key next time.
    await store.signRequest(CALLER, part);
    expect(await store.publicKeys()).toHaveLength(1);
  });

  it('never returns the private key', async () => {
    const storage = memStorage();
    const store = new KeyStore(storage, () => NOW);
    const headers = await store.signRequest(CALLER, part);
    const d = (JSON.parse(storage.dump()) as [string, { active: { d: string } }][])[0]![1].active.d;
    expect(d).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const out of [headers, await store.publicKeys(), await store.rotate(CALLER)])
      expect(JSON.stringify(out)).not.toContain(d);
    expect(JSON.stringify(await store.activateNext())).not.toContain(d);
  });

  it('rotates without stopping: the old key signs until the next one is activated, then is gone', async () => {
    const storage = memStorage();
    const store = new KeyStore(storage, () => NOW);
    await store.signRequest(CALLER, part);
    const [old] = await store.publicKeys();
    const next = await store.rotate(CALLER);
    expect(await store.rotate(CALLER)).toEqual(next); // idempotent while pending
    const during = await store.signRequest(CALLER, part);
    expect(during['x-custodes-key-id']).toBe(old?.kid);
    await store.activateNext();
    expect(await store.publicKeys()).toEqual([{ ...next, state: 'active' }]);
    const after = await store.signRequest(CALLER, part);
    expect(after['x-custodes-key-id']).toBe(next.kid);
    expect(storage.dump()).not.toContain(old!.x); // the old key pair is deleted
    await expect(store.activateNext()).rejects.toThrow('no next key');
  });

  it('builds kids in the pinned format', () => {
    expect(newKid('custodes-cheatsheet-review', NOW)).toMatch(
      /^cheatsheet-review-20261109-[0-9a-f]{8}$/,
    );
  });
});

describe('signing broker client (ADR 0018)', () => {
  it('sends canonical JSON with signature headers that verify for that exact body and path', async () => {
    const store = new KeyStore(memStorage(), () => NOW);
    const seen: { url: string; init: RequestInit }[] = [];
    const broker = signingBroker(
      {
        fetch: (url, init = {}) => {
          seen.push({ url, init });
          return Promise.resolve(Response.json({ ok: true }));
        },
      },
      store,
      CALLER,
    );
    await broker.fetch('https://broker.internal/v1/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r', agentId: 'pr-gate' }, null, 2),
    });
    const { url, init } = seen[0]!;
    expect(init.body).toBe(canonicalJson({ agentId: 'pr-gate', runId: 'r' }));
    const [active] = await store.publicKeys();
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(
      await verifyRequestSignature(
        [pinnedOf(active!)],
        headers,
        { method: 'POST', path: new URL(url).pathname, body: init.body as string },
        NOW.getTime(),
      ),
    ).toMatchObject({ ok: true });
  });

  it('refuses to send a body it cannot sign', async () => {
    const broker = signingBroker(
      { fetch: () => Promise.resolve(new Response()) },
      new KeyStore(memStorage(), () => NOW),
      CALLER,
    );
    await expect(
      broker.fetch('https://broker.internal/v1/act', { method: 'POST' }),
    ).rejects.toThrow('JSON body');
  });
});
