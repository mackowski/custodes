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
      repos: ['OWASP/CheatSheetSeries', 'mackowski/custodes-sandbox'],
      actions: ['issue.comment', 'issue.label.add'],
      requiresApproval: ['issue.label.add'],
      requiresApprovalOn: { 'mackowski/custodes-sandbox': ['issue.comment'] },
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

describe('evaluatePolicy: approval per repository', () => {
  const comment = (repo: string): BrokerRequest => ({
    ...base,
    action: { type: 'issue.comment', repo, issue: 1, body: 'x' },
  });

  it('asks for an approval only on the repository that lists the action', () => {
    expect(evaluatePolicy(policy, comment('mackowski/custodes-sandbox'))).toEqual({
      allow: true,
      needsApproval: true,
    });
    expect(evaluatePolicy(policy, comment('OWASP/CheatSheetSeries'))).toEqual({
      allow: true,
      needsApproval: false,
    });
  });

  it('never allows a repository just because it has an approval entry', () => {
    const p: Policy = {
      ...policy,
      agents: {
        triage: {
          ...policy.agents['triage']!,
          requiresApprovalOn: { 'other/repo': ['issue.comment'] },
        },
      },
    };
    expect(evaluatePolicy(p, comment('other/repo'))).toMatchObject({ allow: false });
  });

  it('refuses a policy whose per-repository approval names an action the agent lacks', () => {
    const bad = {
      version: 1,
      agents: {
        a: {
          tokenBinding: 'PAT_A',
          mode: 'hotl',
          repos: ['o/r'],
          actions: ['issue.comment'],
          requiresApprovalOn: { 'o/r': ['pr.close'] },
        },
      },
    };
    expect(PolicySchema.safeParse(bad).success).toBe(false);
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
          requiresApprovalOn: {},
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

describe('evaluatePolicy for cheatsheet-review (real broker policy)', () => {
  const real = PolicySchema.parse(
    JSON.parse(
      readFileSync(
        new URL('../../../workers/github-broker/policy/policy.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  const reviewer = { ...base, agentId: 'cheatsheet-review' };
  const review = {
    type: 'pr.review.inline' as const,
    repo: 'mackowski/custodes-sandbox',
    pull: 7,
    commitId: '0123456789abcdef0123456789abcdef01234567',
    event: 'REQUEST_CHANGES' as const,
    body: 'x',
    comments: [],
  };

  it('lets cheatsheet-review post an inline review on the sandbox only with an approval, and remove its label without one (ADR 0017 amendment)', () => {
    expect(evaluatePolicy(real, { ...reviewer, action: review })).toEqual({
      allow: true,
      needsApproval: true,
    });
    expect(
      evaluatePolicy(real, {
        ...reviewer,
        action: {
          type: 'issue.label.remove',
          repo: 'mackowski/custodes-sandbox',
          issue: 7,
          labels: ['custodes_cheatsheet_review'],
        },
      }),
    ).toEqual({ allow: true, needsApproval: false });
  });
  it('already asks for an approval to post on OWASP, before OWASP is in its repos', () => {
    expect(real.agents['cheatsheet-review']?.requiresApprovalOn['OWASP/CheatSheetSeries']).toEqual([
      'pr.review.inline',
    ]);
  });
  it('denies cheatsheet-review on OWASP until its evals pass, and every other action', () => {
    expect(
      evaluatePolicy(real, {
        ...reviewer,
        action: { ...review, repo: 'OWASP/CheatSheetSeries' },
      }),
    ).toMatchObject({ allow: false, code: 'policy_denied' });
    for (const action of [
      { type: 'pr.close' as const, repo: 'mackowski/custodes-sandbox', pull: 7, body: 'x' },
      { type: 'pr.comment' as const, repo: 'mackowski/custodes-sandbox', pull: 7, body: 'x' },
      {
        type: 'pr.review' as const,
        repo: 'mackowski/custodes-sandbox',
        pull: 7,
        event: 'APPROVE' as const,
        body: 'x',
      },
      {
        type: 'issue.label.add' as const,
        repo: 'mackowski/custodes-sandbox',
        issue: 7,
        labels: ['x'],
      },
    ]) {
      expect(evaluatePolicy(real, { ...reviewer, action })).toMatchObject({
        allow: false,
        code: 'policy_denied',
      });
    }
  });
  it('may remove only its trigger label', () => {
    const remove = (labels: string[]) =>
      evaluatePolicy(real, {
        ...reviewer,
        action: {
          type: 'issue.label.remove',
          repo: 'mackowski/custodes-sandbox',
          issue: 7,
          labels,
        },
      });
    expect(remove(['custodes_cheatsheet_review'])).toMatchObject({ allow: true });
    expect(remove(['ACK_WAITING'])).toMatchObject({ allow: false, code: 'policy_denied' });
    expect(remove(['custodes_cheatsheet_review', 'bug'])).toMatchObject({
      allow: false,
      code: 'policy_denied',
    });
  });
  it('does not let other agents post inline reviews', () => {
    for (const agentId of ['pr-gate', 'hello', 'triage']) {
      expect(evaluatePolicy(real, { ...base, agentId, action: review })).toMatchObject({
        allow: false,
      });
    }
  });
});
