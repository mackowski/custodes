import { describe, expect, it } from 'vitest';
import type { AuditRecord, BrokerRequest, PinnedAgentKey } from '@custodes/schema';
import { buildAuditRecord, signedRequestOf, verifyCallerIntent } from '../src/audit.js';
import { canonicalJson, sha256Hex } from '../src/canonical.js';
import { signRequest } from '../src/request-signature.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const NONCE = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
const request: BrokerRequest = {
  agentId: 'pr-gate',
  agentVersion: '0.3.0',
  runId: NONCE,
  triggeredBy: { kind: 'schedule' },
  action: { type: 'pr.close', repo: 'mackowski/custodes-sandbox', pull: 7, body: 'closing' },
};

async function keyPair(kid: string): Promise<{ priv: CryptoKey; pinned: PinnedAgentKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const { x } = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { x: string };
  return { priv: pair.privateKey, pinned: { kid, x, addedAt: '2026-11-09' } };
}

/** A record as the broker writes it for a signed /v1/act, with the agent's signature in it. */
async function signedRecord(priv: CryptoKey, kid: string, req = request): Promise<AuditRecord> {
  const body = canonicalJson(req);
  const part = { method: 'POST', path: '/v1/act', body };
  const headers = new Headers(await signRequest(priv, kid, part, NOW, NONCE));
  return buildAuditRecord({
    request: req,
    decision: 'allowed',
    now: new Date(NOW),
    callerSignature: {
      caller: 'custodes-pr-gate',
      kid,
      signature: headers.get('x-custodes-signature') ?? '',
      timestamp: String(NOW),
      nonce: NONCE,
      method: 'POST',
      path: '/v1/act',
      bodySha256: await sha256Hex(body),
    },
  });
}

describe('agent signature in the audit record (ADR 0018, R1)', () => {
  it('is valid for the request the record describes', async () => {
    const { priv, pinned } = await keyPair('pr-gate-20261109-a1b2c3d4');
    const record = await signedRecord(priv, pinned.kid);
    expect(canonicalJson(signedRequestOf(record))).toBe(canonicalJson(request));
    expect(await verifyCallerIntent(record, () => [pinned])).toEqual({
      status: 'valid',
      caller: 'custodes-pr-gate',
      kid: pinned.kid,
    });
  });

  it('is invalid when the record says something the agent did not send', async () => {
    const { priv, pinned } = await keyPair('pr-gate-20261109-a1b2c3d4');
    const record = await signedRecord(priv, pinned.kid);
    const forged: AuditRecord = {
      ...record,
      action: { type: 'pr.close', repo: 'OWASP/CheatSheetSeries', pull: 7, body: 'closing' },
    };
    expect(await verifyCallerIntent(forged, () => [pinned])).toEqual({
      status: 'invalid',
      reason: 'body_mismatch',
    });
  });

  it("is invalid with another Worker's key, or a key that is not pinned", async () => {
    const mine = await keyPair('pr-gate-20261109-a1b2c3d4');
    const theirs = await keyPair('pr-gate-20261109-a1b2c3d4');
    const record = await signedRecord(theirs.priv, mine.pinned.kid);
    expect(await verifyCallerIntent(record, () => [mine.pinned])).toEqual({
      status: 'invalid',
      reason: 'bad_signature',
    });
    expect(await verifyCallerIntent(record, () => [])).toEqual({
      status: 'invalid',
      reason: 'unknown_key',
    });
  });

  it('stays valid with a retired key, and is "none" for records without an agent signature', async () => {
    const { priv, pinned } = await keyPair('pr-gate-20261001-00000000');
    const record = await signedRecord(priv, pinned.kid);
    // verificationKeys() returns active + retired; a retired key is just in that list.
    expect((await verifyCallerIntent(record, () => [pinned])).status).toBe('valid');
    const shared = await buildAuditRecord({ request, decision: 'allowed', now: new Date(NOW) });
    expect(await verifyCallerIntent(shared, () => [pinned])).toEqual({ status: 'none' });
  });
});
