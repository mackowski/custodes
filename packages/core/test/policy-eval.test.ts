import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Policy as PolicySchema, type BrokerRequest, type Policy } from '@custodes/schema';
import { evaluatePolicy } from '../src/policy-eval.js';

const policy: Policy = {
  version: 1,
  reads: {},
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

describe('evaluatePolicy for read-only agents', () => {
  it('denies every action even when the policy lists it', () => {
    const ro: Policy = {
      version: 1,
      reads: {},
      agents: {
        watcher: {
          tokenBinding: 'PAT_WATCHER',
          mode: 'readonly',
          repos: ['OWASP/CheatSheetSeries'],
          actions: ['issue.comment'],
          requiresApproval: [],
          rateLimitPerHour: 60,
        },
      },
    };
    const req: BrokerRequest = {
      agentId: 'watcher',
      agentVersion: '0.1.0',
      runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      triggeredBy: { kind: 'schedule' },
      action: { type: 'issue.comment', repo: 'OWASP/CheatSheetSeries', issue: 1, body: 'x' },
    };
    expect(evaluatePolicy(ro, req)).toMatchObject({ allow: false, code: 'policy_denied' });
  });
});

describe('evaluatePolicy for pr-gate (real broker policy)', () => {
  const real = PolicySchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../../workers/github-broker/policy/policy.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const gate = {
    ...base,
    agentId: 'pr-gate',
  };
  it('lets pr-gate close pull requests on CheatSheetSeries without human approval (hotl)', () => {
    expect(
      evaluatePolicy(real, {
        ...gate,
        action: { type: 'pr.close', repo: 'OWASP/CheatSheetSeries', pull: 7, body: 'x' },
      }),
    ).toEqual({ allow: true, needsApproval: false });
  });
  it('denies pr-gate commenting, reviewing and closing on other repositories', () => {
    expect(
      evaluatePolicy(real, {
        ...gate,
        action: { type: 'pr.comment', repo: 'OWASP/CheatSheetSeries', pull: 7, body: 'x' },
      }),
    ).toMatchObject({ allow: false, code: 'policy_denied' });
    expect(
      evaluatePolicy(real, {
        ...gate,
        action: {
          type: 'pr.review',
          repo: 'OWASP/CheatSheetSeries',
          pull: 7,
          event: 'APPROVE',
          body: 'x',
        },
      }),
    ).toMatchObject({ allow: false, code: 'policy_denied' });
    expect(
      evaluatePolicy(real, {
        ...gate,
        action: { type: 'pr.close', repo: 'evil/repo', pull: 7, body: 'x' },
      }),
    ).toMatchObject({ allow: false, code: 'policy_denied' });
  });
  it('does not let other agents close pull requests', () => {
    expect(
      evaluatePolicy(real, {
        ...base,
        agentId: 'hello',
        action: { type: 'pr.close', repo: 'OWASP/CheatSheetSeries', pull: 7, body: 'x' },
      }),
    ).toMatchObject({ allow: false, code: 'policy_denied' });
  });
});
