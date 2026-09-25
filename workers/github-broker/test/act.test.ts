import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  importPublicKey,
  KillSwitch,
  sha256Hex,
  verifyAttestation,
} from '@custodes/core';
import type { BrokerRequest } from '@custodes/schema';
import { act } from '../src/act.js';
import { keyring, type BrokerEnv } from '../src/env.js';
import { ApprovalStore, AuditStore } from '../src/store.js';

const runId = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
const base: Omit<BrokerRequest, 'action'> = {
  agentId: 'hello',
  agentVersion: '0.1.0',
  runId,
  triggeredBy: { kind: 'cli', ref: 'test' },
};
const comment = (repo: string, body = 'x'): BrokerRequest['action'] => ({
  type: 'issue.comment',
  repo,
  issue: 1,
  body,
});

let testEnv: BrokerEnv;

beforeAll(() => {
  // Test double for the Secrets Store PAT binding. GitHub is never reached in these tests because
  // every case is denied before the execute step.
  testEnv = { ...env, PAT_HELLO: { get: () => Promise.resolve('unused') } };
});

describe('broker act()', () => {
  it('denies a repo outside policy and signs the denial with a keyring-generated key', async () => {
    const res = await act(testEnv, { ...base, action: comment('evil/repo') });
    expect(res.ok).toBe(false);
    if (res.ok || !res.attestationId) throw new Error('expected a signed denial');
    expect(res.code).toBe('policy_denied');
    const att = await new AuditStore(env.AUDIT).get(res.attestationId);
    expect(att?.record.decision).toBe('denied');
    const keys = await keyring(env).publicKeys();
    const key = keys.find((k) => k.keyId === att?.keyId && k.agentId === 'hello');
    expect(key).toBeDefined();
    expect((await verifyAttestation(att, await importPublicKey(key!.jwk))).valid).toBe(true);
  });

  it('keeps old attestations verifiable after key rotation', async () => {
    const before = await act(testEnv, { ...base, action: comment('evil/repo') });
    if (before.ok || !before.attestationId) throw new Error('expected a signed denial');
    const rotated = await keyring(env).rotate('hello');
    const after = await act(testEnv, { ...base, action: comment('evil/repo') });
    if (after.ok || !after.attestationId) throw new Error('expected a signed denial');
    const store = new AuditStore(env.AUDIT);
    const [attBefore, attAfter] = [
      await store.get(before.attestationId),
      await store.get(after.attestationId),
    ];
    expect(attAfter?.keyId).toBe(rotated.keyId);
    expect(attBefore?.keyId).not.toBe(rotated.keyId);
    const keys = await keyring(env).publicKeys();
    for (const att of [attBefore, attAfter]) {
      const key = keys.find((k) => k.keyId === att?.keyId)!;
      expect((await verifyAttestation(att, await importPublicKey(key.jwk))).valid).toBe(true);
    }
    expect(keys.find((k) => k.keyId === attBefore?.keyId)?.retiredAt).toBeDefined();
  });

  it('denies when halted', async () => {
    const ks = new KillSwitch(env.KILL_SWITCH);
    await ks.halt('hello', 'test', 'tester');
    const res = await act(testEnv, { ...base, action: comment('OWASP/CheatSheetSeries') });
    expect(res).toMatchObject({ ok: false, code: 'halted' });
    await ks.resume('hello');
  });

  it('requires an approval for a hitl agent', async () => {
    const res = await act(testEnv, { ...base, action: comment('OWASP/CheatSheetSeries') });
    expect(res).toMatchObject({ ok: false, code: 'approval_required' });
  });

  it('rejects an approval issued for a different action', async () => {
    const store = new ApprovalStore(env.AUDIT);
    const other = comment('OWASP/CheatSheetSeries', 'a different comment');
    const approval = await store.create(
      { ...base, action: other },
      'because',
      await sha256Hex(canonicalJson(other)),
      3600,
    );
    expect(await store.decide(approval.id, 'approved', 'tester')).toBe('ok');
    const res = await act(testEnv, {
      ...base,
      approvalId: approval.id,
      action: comment('OWASP/CheatSheetSeries'),
    });
    expect(res).toMatchObject({ ok: false, code: 'approval_invalid' });
  });

  it('refuses an unknown agent without minting a key', async () => {
    const res = await act(testEnv, {
      ...base,
      agentId: 'ghost',
      action: comment('OWASP/CheatSheetSeries'),
    });
    expect(res).toMatchObject({ ok: false, code: 'unknown_agent' });
    expect((await keyring(env).publicKeys()).some((k) => k.agentId === 'ghost')).toBe(false);
  });
});
