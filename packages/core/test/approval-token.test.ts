import { describe, expect, it } from 'vitest';
import { mintApprovalToken, verifyApprovalToken } from '../src/approval-token.js';

const secret = 'test-secret-do-not-use';
const id = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';

describe('approval token', () => {
  it('round-trips', async () => {
    const t = await mintApprovalToken(id, secret, 3600, new Date(0));
    const r = await verifyApprovalToken(t, secret, new Date(1000));
    expect(r).toMatchObject({ ok: true, approvalId: id });
  });
  it('expires', async () => {
    const t = await mintApprovalToken(id, secret, 60, new Date(0));
    expect(await verifyApprovalToken(t, secret, new Date(61_000))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
  it('rejects a different secret and tampering', async () => {
    const t = await mintApprovalToken(id, secret, 60, new Date(0));
    expect(await verifyApprovalToken(t, 'other', new Date(0))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const [a, b, c] = t.split('.') as [string, string, string];
    expect(await verifyApprovalToken(`${a}.${Number(b) + 1}.${c}`, secret, new Date(0))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await verifyApprovalToken('nope', secret)).toEqual({ ok: false, reason: 'malformed' });
  });
});
