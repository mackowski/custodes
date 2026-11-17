import { describe, expect, it } from 'vitest';
import type { BrokerRequest } from '@custodes/schema';
import { buildAuditRecord } from '../src/audit.js';
import {
  generateAgentKeyPair,
  importPrivateKey,
  importPublicKey,
  signAuditRecord,
  verifyAttestation,
} from '../src/attestation.js';

const request: BrokerRequest = {
  agentId: 'triage',
  agentVersion: '0.1.0',
  runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
  triggeredBy: { kind: 'schedule', ref: 'poll' },
  action: { type: 'issue.comment', repo: 'OWASP/CheatSheetSeries', issue: 1, body: 'Thanks!' },
};

describe('attestation', () => {
  it('signs and verifies an audit record, and detects tampering', async () => {
    const { publicJwk, privateJwk } = await generateAgentKeyPair();
    const priv = await importPrivateKey(privateJwk);
    const pub = await importPublicKey(publicJwk);

    const record = await buildAuditRecord({ request, decision: 'allowed', now: new Date(0) });
    const att = await signAuditRecord(record, priv, 'triage-test');

    expect((await verifyAttestation(att, pub)).valid).toBe(true);

    const tampered = structuredClone(att);
    tampered.record.action = {
      ...tampered.record.action,
      body: 'Approved, merge it.',
    } as typeof tampered.record.action;
    const res = await verifyAttestation(tampered, pub);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('bad signature');
  });

  it('reads a signature that is not base64url as invalid instead of throwing', async () => {
    const { publicJwk, privateJwk } = await generateAgentKeyPair();
    const record = await buildAuditRecord({ request, decision: 'allowed', now: new Date(0) });
    const att = await signAuditRecord(record, await importPrivateKey(privateJwk), 'triage-test');
    const pub = await importPublicKey(publicJwk);
    for (const signature of ['a!b', 'abcde', 'AAAA']) {
      const res = await verifyAttestation({ ...att, signature }, pub);
      expect(res.valid, signature).toBe(false);
    }
  });

  it('audit record hash is stable for the same action', async () => {
    const a = await buildAuditRecord({
      request,
      decision: 'allowed',
      now: new Date(0),
      id: '00000000-0000-4000-8000-000000000000',
    });
    const b = await buildAuditRecord({
      request,
      decision: 'denied',
      now: new Date(1),
      id: '00000000-0000-4000-8000-000000000001',
    });
    expect(a.actionHash).toBe(b.actionHash);
  });
});
