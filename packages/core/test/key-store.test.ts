import { describe, expect, it } from 'vitest';
import type { PinnedAgentKey } from '@custodes/schema';
import { KeyStore, newKid, type AcceptanceProbe, type KeyStorage } from '../src/key-store.js';
import { verifyRequestSignature } from '../src/request-signature.js';
import { signingBroker } from '../src/signed-broker.js';
import { canonicalJson } from '../src/canonical.js';

const NOW = new Date(Date.UTC(2026, 10, 9, 12, 0, 0));
const CALLER = 'custodes-pr-gate';

function memStorage(): KeyStorage & { privateScalars(): string[] } {
  const m = new Map<string, unknown>();
  return {
    get: <T>(k: string) => Promise.resolve(m.get(k) as T | undefined),
    put: (k: string, v: unknown) => {
      m.set(k, structuredClone(v));
      return Promise.resolve();
    },
    /** Every `d` currently stored, so the canaries can look for each of them. */
    privateScalars: () =>
      [...JSON.stringify([...m.values()]).matchAll(/"d":"([^"]+)"/g)].map((x) => x[1] ?? ''),
  };
}

const pinnedOf = (k: { kid: string; x: string }): PinnedAgentKey => ({
  kid: k.kid,
  x: k.x,
  addedAt: '2026-11-09',
});
const part = { method: 'POST', path: '/v1/state', body: '{"agentId":"pr-gate"}' };
const newStore = (storage: KeyStorage) => new KeyStore(storage, CALLER, () => NOW);

/** A broker double for the activation probe that accepts exactly the pinned kids. */
const acceptsOnly =
  (pinned: () => PinnedAgentKey[]): AcceptanceProbe =>
  async (sign) =>
    (await verifyRequestSignature(pinned(), new Headers(await sign(part)), part, NOW.getTime())).ok;

describe('Keyholder key store (ADR 0018)', () => {
  it('creates a key on first use and signs requests the broker accepts with its public key', async () => {
    const store = newStore(memStorage());
    const headers = await store.signRequest(part);
    const [active] = await store.publicKeys();
    expect(active).toMatchObject({ state: 'active' });
    expect(active?.kid).toMatch(/^pr-gate-20261109-[0-9a-f]{8}$/);
    expect(
      await verifyRequestSignature([pinnedOf(active!)], new Headers(headers), part, NOW.getTime()),
    ).toMatchObject({ ok: true, keyId: active?.kid });
    await store.signRequest(part);
    expect(await store.publicKeys()).toHaveLength(1);
  });

  it('makes one key for concurrent first uses when generation is serialised', async () => {
    let chain: Promise<unknown> = Promise.resolve();
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(fn);
      chain = run.catch(() => undefined);
      return run;
    };
    const store = new KeyStore(memStorage(), CALLER, () => NOW, serialize);
    await Promise.all(Array.from({ length: 20 }, () => store.signRequest(part)));
    expect(await store.publicKeys()).toHaveLength(1);
  });

  it('never returns a private key, active or next, in any output or error', async () => {
    const storage = memStorage();
    const store = newStore(storage);
    const outputs: unknown[] = [
      await store.signRequest(part),
      await store.rotate(),
      await store.publicKeys(),
      await store.activateNextIfAccepted(() => Promise.resolve(false)),
      await store.rotate(),
      await store
        .activateNextIfAccepted(() => Promise.reject(new Error('probe failed')))
        .catch((e: unknown) => (e instanceof Error ? e.message : String(e))),
    ];
    const secrets = storage.privateScalars();
    expect(secrets).toHaveLength(2); // the active and the next key
    for (const d of secrets) {
      expect(d).toMatch(/^[A-Za-z0-9_-]{43}$/);
      for (const out of outputs) expect(JSON.stringify(out)).not.toContain(d);
    }
  });

  it('rotates without downtime: switches to the next key only once the broker accepts it', async () => {
    const storage = memStorage();
    const store = newStore(storage);
    await store.signRequest(part);
    const [old] = await store.publicKeys();
    const next = await store.rotate();
    let pinned = [pinnedOf(old!)];
    const probe = acceptsOnly(() => pinned);

    // Not pinned yet: stays on the old key.
    expect(await store.activateNextIfAccepted(probe)).toBe(false);
    expect((await store.signRequest(part))['x-custodes-key-id']).toBe(old?.kid);

    // Pinned next to the old one (the rotation PR): switches, old private key gone.
    pinned = [pinnedOf(old!), pinnedOf(next)];
    expect(await store.activateNextIfAccepted(probe)).toBe(true);
    expect(await store.publicKeys()).toEqual([{ ...next, state: 'active' }]);
    expect((await store.signRequest(part))['x-custodes-key-id']).toBe(next.kid);
    expect(storage.privateScalars()).toHaveLength(1);
    expect(await store.activateNextIfAccepted(probe)).toBe(false); // nothing pending
  });

  it('builds kids in the pinned format', () => {
    expect(newKid('custodes-cheatsheet-review', NOW)).toMatch(
      /^cheatsheet-review-20261109-[0-9a-f]{8}$/,
    );
  });
});

describe('signing broker client (ADR 0018)', () => {
  it('sends canonical JSON with signature headers that verify for that exact body and path', async () => {
    const store = newStore(memStorage());
    const seen: { url: string; init: RequestInit }[] = [];
    const broker = signingBroker(
      {
        fetch: (url, init = {}) => {
          seen.push({ url, init });
          return Promise.resolve(Response.json({ ok: true }));
        },
      },
      store,
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
      newStore(memStorage()),
    );
    await expect(
      broker.fetch('https://broker.internal/v1/act', { method: 'POST' }),
    ).rejects.toThrow('JSON body');
  });
});
