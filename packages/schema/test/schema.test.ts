import { describe, expect, it } from 'vitest';
import {
  AgentId,
  BrokerAction,
  BrokerActionType,
  BrokerReadRequest,
  BrokerRequest,
  Policy,
} from '../src/index.js';

describe('schema', () => {
  it('accepts a valid agent id and rejects bad ones', () => {
    expect(AgentId.safeParse('triage').success).toBe(true);
    expect(AgentId.safeParse('Triage').success).toBe(false);
    expect(AgentId.safeParse('a').success).toBe(false);
  });

  it('enumerates action types from the discriminated union', () => {
    expect(BrokerActionType.options).toContain('issue.comment');
    expect(BrokerActionType.options).toContain('pr.review');
  });

  it('parses a broker request', () => {
    const req = BrokerRequest.parse({
      agentId: 'triage',
      agentVersion: '0.1.0',
      runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      triggeredBy: { kind: 'schedule', ref: 'poll-labels' },
      action: { type: 'issue.comment', repo: 'OWASP/CheatSheetSeries', issue: 12, body: 'hi' },
    });
    expect(req.action.type).toBe('issue.comment');
  });

  it('rejects oversized comment bodies', () => {
    const r = BrokerAction.safeParse({
      type: 'issue.comment',
      repo: 'a/b',
      issue: 1,
      body: 'x'.repeat(60_001),
    });
    expect(r.success).toBe(false);
  });

  it('parses a policy with defaults', () => {
    const p = Policy.parse({
      version: 1,
      agents: {
        triage: {
          tokenBinding: 'PAT_TRIAGE',
          mode: 'hotl',
          repos: ['OWASP/CheatSheetSeries'],
          actions: ['issue.comment', 'issue.label.add'],
        },
      },
    });
    expect(p.agents['triage']?.rateLimitPerHour).toBe(60);
    expect(p.agents['triage']?.requiresApproval).toEqual([]);
  });
});

describe('pr.close action', () => {
  const close = { type: 'pr.close', repo: 'OWASP/CheatSheetSeries', pull: 7, body: 'reason' };
  it('is an enumerated action type and parses with a positive pull and a body', () => {
    expect(BrokerActionType.options).toContain('pr.close');
    expect(BrokerAction.safeParse(close).success).toBe(true);
  });
  it('rejects a non-positive or fractional pull number', () => {
    for (const pull of [0, -1, 1.5]) {
      expect(BrokerAction.safeParse({ ...close, pull }).success).toBe(false);
    }
  });
  it('requires a body of 1 to 60000 characters', () => {
    expect(BrokerAction.safeParse({ ...close, body: '' }).success).toBe(false);
    expect(BrokerAction.safeParse({ ...close, body: 'x' }).success).toBe(true);
    expect(BrokerAction.safeParse({ ...close, body: 'x'.repeat(60_000) }).success).toBe(true);
    expect(BrokerAction.safeParse({ ...close, body: 'x'.repeat(60_001) }).success).toBe(false);
  });
});

describe('read resource pulls', () => {
  const read = {
    agentId: 'pr-gate',
    runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
    repo: 'OWASP/CheatSheetSeries',
    resource: 'pulls',
    query: { state: 'open' },
  };
  it('is accepted without a number or file', () => {
    expect(BrokerReadRequest.safeParse(read).success).toBe(true);
  });
  it('rejects a number or file on a listing resource', () => {
    expect(BrokerReadRequest.safeParse({ ...read, number: 1 }).success).toBe(false);
    expect(BrokerReadRequest.safeParse({ ...read, file: 'A.md' }).success).toBe(false);
  });
});
