import { describe, expect, it } from 'vitest';
import type { PinnedAgentKey } from '@custodes/schema';
import {
  SIGNATURE_HEADERS,
  SIGNATURE_WINDOW_MS,
  signRequest,
  verifyRequestSignature,
} from '../src/request-signature.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const NONCE = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
const part = { method: 'POST', path: '/v1/act', body: '{"agentId":"pr-gate"}' };

async function keyPair(keyId: string): Promise<{ priv: CryptoKey; pinned: PinnedAgentKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x: string };
  return { priv: pair.privateKey, pinned: { kid: keyId, x: jwk.x, addedAt: '2026-11-09' } };
}

const headersOf = (h: Record<string, string>) => new Headers(h);

describe('agent-signed broker requests (ADR 0018)', () => {
  it('verifies a request signed by a pinned key', async () => {
    const { priv, pinned } = await keyPair('pr-gate-20261109-a1b2c3d4');
    const h = await signRequest(priv, pinned.kid, part, NOW, NONCE);
    expect(await verifyRequestSignature([pinned], headersOf(h), part, NOW)).toEqual({
      ok: true,
      keyId: pinned.kid,
      nonce: NONCE,
      signature: h[SIGNATURE_HEADERS.signature],
    });
  });

  it('refuses any change to the body, path or method after signing', async () => {
    const { priv, pinned } = await keyPair('pr-gate-20261109-a1b2c3d4');
    const h = headersOf(await signRequest(priv, pinned.kid, part, NOW, NONCE));
    for (const changed of [
      { ...part, body: '{"agentId":"cheatsheet-review"}' },
      { ...part, path: '/v1/read' },
      { ...part, method: 'GET' },
    ])
      expect(await verifyRequestSignature([pinned], h, changed, NOW)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
  });

  it("refuses another Worker's key, even with a matching key id", async () => {
    const mine = await keyPair('pr-gate-20261109-a1b2c3d4');
    const theirs = await keyPair('pr-gate-20261109-a1b2c3d4');
    const h = headersOf(await signRequest(theirs.priv, mine.pinned.kid, part, NOW, NONCE));
    expect(await verifyRequestSignature([mine.pinned], h, part, NOW)).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a key id that is not pinned for this caller', async () => {
    const { priv, pinned } = await keyPair('pr-gate-20261109-a1b2c3d4');
    const h = headersOf(await signRequest(priv, 'triage-20261109-a1b2c3d4', part, NOW, NONCE));
    expect(await verifyRequestSignature([pinned], h, part, NOW)).toMatchObject({
      reason: 'unknown_key',
    });
    expect(await verifyRequestSignature([], h, part, NOW)).toMatchObject({ reason: 'unknown_key' });
  });

  it('refuses a timestamp outside the window, either way', async () => {
    const { priv, pinned } = await keyPair('pr-gate-20261109-a1b2c3d4');
    for (const skew of [SIGNATURE_WINDOW_MS + 1, -(SIGNATURE_WINDOW_MS + 1)]) {
      const h = headersOf(await signRequest(priv, pinned.kid, part, NOW + skew, NONCE));
      expect(await verifyRequestSignature([pinned], h, part, NOW)).toMatchObject({
        reason: 'stale',
      });
    }
    const edge = headersOf(
      await signRequest(priv, pinned.kid, part, NOW - SIGNATURE_WINDOW_MS, NONCE),
    );
    expect(await verifyRequestSignature([pinned], edge, part, NOW)).toMatchObject({ ok: true });
  });

  it('refuses missing or malformed headers before touching a key', async () => {
    const { priv, pinned } = await keyPair('pr-gate-20261109-a1b2c3d4');
    const good = await signRequest(priv, pinned.kid, part, NOW, NONCE);
    for (const name of Object.values(SIGNATURE_HEADERS)) {
      const h = headersOf(good);
      h.delete(name);
      expect(await verifyRequestSignature([pinned], h, part, NOW)).toMatchObject({
        reason: 'missing',
      });
    }
    for (const [name, value] of [
      [SIGNATURE_HEADERS.timestamp, '1e12'],
      [SIGNATURE_HEADERS.nonce, 'not-a-uuid'],
      [SIGNATURE_HEADERS.signature, 'short'],
    ] as const) {
      const h = headersOf({ ...good, [name]: value });
      expect(await verifyRequestSignature([pinned], h, part, NOW)).toMatchObject({
        reason: 'malformed',
      });
    }
  });

  it('accepts either of two pinned keys during a rotation', async () => {
    const old = await keyPair('pr-gate-20261001-00000000');
    const next = await keyPair('pr-gate-20261109-a1b2c3d4');
    for (const k of [old, next]) {
      const h = headersOf(await signRequest(k.priv, k.pinned.kid, part, NOW, NONCE));
      expect(await verifyRequestSignature([old.pinned, next.pinned], h, part, NOW)).toMatchObject({
        ok: true,
        keyId: k.pinned.kid,
      });
    }
  });
});
