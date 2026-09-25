import { describe, expect, it } from 'vitest';
import {
  buildAuditRecord,
  generateAgentKeyPair,
  importPrivateKey,
  signAuditRecord,
} from '@custodes/core';
import { verifyLocally } from '../src/commands/audit.js';
import { toKebab } from '../src/commands/agents.js';

describe('custodes audit verify', () => {
  it('verifies against published keys and rejects unknown keys', async () => {
    const { publicJwk, privateJwk } = await generateAgentKeyPair();
    const record = await buildAuditRecord({
      request: {
        agentId: 'hello',
        agentVersion: '0.1.0',
        runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
        triggeredBy: { kind: 'cli' },
        action: { type: 'issue.comment', repo: 'a/b', issue: 1, body: 'x' },
      },
      decision: 'allowed',
    });
    const att = await signAuditRecord(record, await importPrivateKey(privateJwk), 'hello-test');
    expect(
      await verifyLocally(att, [
        {
          keyId: 'hello-test',
          agentId: 'hello',
          jwk: publicJwk,
          createdAt: new Date(0).toISOString(),
        },
      ]),
    ).toEqual({ valid: true });
    expect((await verifyLocally(att, [])).valid).toBe(false);
  });
  it('maps agent ids to SDK routes', () => {
    expect(toKebab('hello')).toBe('hello-agent');
    expect(toKebab('hello-agent')).toBe('hello-agent');
  });
});
