import { describe, expect, it } from 'vitest';
import type { BrokerRequest, Policy } from '@custodes/schema';
import { evaluatePolicy } from '../src/policy-eval.js';

const policy: Policy = {
  version: 1,
  agents: {
    triage: {
      tokenBinding: 'PAT_TRIAGE',
      mode: 'hotl',
      repos: ['OWASP/CheatSheetSeries'],
      actions: ['issue.comment', 'issue.label.add'],
      requiresApproval: ['issue.label.add'],
      rateLimitPerHour: 60,
    },
  },
};
const base = {
  agentId: 'triage',
  agentVersion: '0.1.0',
  runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
  triggeredBy: { kind: 'schedule' as const },
};

describe('evaluatePolicy', () => {
  it('allows a permitted action without approval', () => {
    const req: BrokerRequest = {
      ...base,
      action: { type: 'issue.comment', repo: 'OWASP/CheatSheetSeries', issue: 1, body: 'x' },
    };
    expect(evaluatePolicy(policy, req)).toEqual({ allow: true, needsApproval: false });
  });
  it('flags approval-required actions', () => {
    const req: BrokerRequest = {
      ...base,
      action: {
        type: 'issue.label.add',
        repo: 'OWASP/CheatSheetSeries',
        issue: 1,
        labels: ['bug'],
      },
    };
    expect(evaluatePolicy(policy, req)).toEqual({ allow: true, needsApproval: true });
  });
  it('denies other repos, other actions and unknown agents', () => {
    expect(
      evaluatePolicy(policy, {
        ...base,
        action: { type: 'issue.comment', repo: 'evil/repo', issue: 1, body: 'x' },
      }),
    ).toMatchObject({ allow: false, code: 'policy_denied' });
    expect(
      evaluatePolicy(policy, {
        ...base,
        action: {
          type: 'pr.review',
          repo: 'OWASP/CheatSheetSeries',
          pull: 1,
          event: 'APPROVE',
          body: 'x',
        },
      }),
    ).toMatchObject({ allow: false, code: 'policy_denied' });
    expect(
      evaluatePolicy(policy, {
        ...base,
        agentId: 'ghost',
        action: { type: 'issue.comment', repo: 'OWASP/CheatSheetSeries', issue: 1, body: 'x' },
      }),
    ).toMatchObject({ allow: false, code: 'unknown_agent' });
  });
});
