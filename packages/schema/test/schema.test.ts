import { describe, expect, it } from 'vitest';
import { AgentId, BrokerAction, BrokerActionType, BrokerRequest, Policy } from '../src/index.js';

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
