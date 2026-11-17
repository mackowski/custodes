import { describe, expect, it } from 'vitest';
import {
  buildAuditRecord,
  generateAgentKeyPair,
  importPrivateKey,
  signAuditRecord,
  verifyRecord,
} from '@custodes/core';
import { toKebab } from '../src/commands/agents.js';

describe('custodes audit verify', () => {
  it('verifies against published keys and rejects unknown keys', async () => {
    const { publicJwk, privateJwk } = await generateAgentKeyPair();
    const record = await buildAuditRecord({
      request: {
        agentId: 'pr-gate',
        agentVersion: '0.1.0',
        runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
        triggeredBy: { kind: 'cli' },
        action: { type: 'issue.comment', repo: 'a/b', issue: 1, body: 'x' },
      },
      decision: 'allowed',
    });
    const att = await signAuditRecord(record, await importPrivateKey(privateJwk), 'pr-gate-test');
    const keys = [
      {
        keyId: 'pr-gate-test',
        agentId: 'pr-gate',
        jwk: publicJwk,
        createdAt: new Date(0).toISOString(),
      },
    ];
    expect(await verifyRecord(att, record.id, keys)).toMatchObject({
      valid: true,
      agentSignature: { status: 'none' },
    });
    expect((await verifyRecord(att, record.id, [])).valid).toBe(false);
    // The same record fetched under another id, and a key published for another agent.
    expect(await verifyRecord(att, '0b6b8a4e-6a9c-4f7e-8d2a-3c1b5e7f9a10', keys)).toMatchObject({
      valid: false,
      reason: 'record id does not match',
    });
    expect(await verifyRecord(att, record.id, [{ ...keys[0]!, agentId: 'triage' }])).toMatchObject({
      valid: false,
      reason: 'key belongs to another agent',
    });
  });
  it('maps agent ids to SDK routes', () => {
    expect(toKebab('pr-gate')).toBe('pr-gate-agent');
    expect(toKebab('pr-gate-agent')).toBe('pr-gate-agent');
  });
});
