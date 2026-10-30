import { describe, expect, it } from 'vitest';
import {
  mintApprovalToken,
  parseApprovalToken,
  verifyApprovalToken,
  type ApprovalBinding,
} from '../src/approval-token.js';

const key = () =>
  crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]) as Promise<CryptoKey>;
const binding: ApprovalBinding = {
  approvalId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
  agentId: 'cheatsheet-review',
  actionHash: 'a'.repeat(64),
};

describe('approval token', () => {
  it('round-trips', async () => {
    const k = await key();
    const t = await mintApprovalToken(binding, k, 3600, new Date(0));
    expect(await verifyApprovalToken(t, binding, k, new Date(1000))).toMatchObject({
      ok: true,
      approvalId: binding.approvalId,
    });
  });

  it('expires', async () => {
    const k = await key();
    const t = await mintApprovalToken(binding, k, 60, new Date(0));
    expect(await verifyApprovalToken(t, binding, k, new Date(61_000))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('approves only the action, agent and approval it was minted for', async () => {
    const k = await key();
    const t = await mintApprovalToken(binding, k, 60, new Date(0));
    for (const other of [
      { ...binding, actionHash: 'b'.repeat(64) },
      { ...binding, agentId: 'pr-gate' },
      { ...binding, approvalId: '0d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44' },
    ])
      expect(await verifyApprovalToken(t, other, k, new Date(0))).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
  });

  it('rejects another key and tampering', async () => {
    const k = await key();
    const t = await mintApprovalToken(binding, k, 60, new Date(0));
    expect(await verifyApprovalToken(t, binding, await key(), new Date(0))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const [a, b, c] = t.split('.') as [string, string, string];
    expect(
      await verifyApprovalToken(`${a}.${Number(b) + 1}.${c}`, binding, k, new Date(0)),
    ).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await verifyApprovalToken('nope', binding, k)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('parses only a uuid, a numeric expiry and a signature', () => {
    expect(parseApprovalToken(`${binding.approvalId}.60.sig`)).toEqual({
      ok: true,
      approvalId: binding.approvalId,
      exp: 60,
    });
    for (const bad of [
      'a.b.c',
      `${binding.approvalId}.-1.x`,
      `../x.1.y`,
      `${binding.approvalId}.1`,
    ])
      expect(parseApprovalToken(bad)).toEqual({ ok: false, reason: 'malformed' });
  });
});
