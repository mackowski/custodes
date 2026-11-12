import { describe, expect, it } from 'vitest';
import { AgentPolicy, ApprovalBundle, BrokerAction, GitHubLogin } from '../src/index.js';

const repo = 'o/r';
const snapshot = {
  state: 'open' as const,
  labels: [],
  assignees: [],
  comments: 0,
  updatedAt: '2026-11-10T10:00:00Z',
  commentsDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};
const assign = { type: 'issue.assign' as const, repo, issue: 5, assignees: ['alice'] };
const add = { type: 'issue.label.add' as const, repo, issue: 5, labels: ['docker'] };
const remove = { type: 'issue.label.remove' as const, repo, issue: 5, labels: ['python'] };
const comment = { type: 'issue.comment' as const, repo, issue: 5, body: 'hi' };
const bundle = (actions: unknown[]) => ApprovalBundle.safeParse({ actions, snapshot });

describe('ApprovalBundle', () => {
  it('accepts all four actions in the fixed order', () => {
    expect(bundle([assign, add, remove, comment]).success).toBe(true);
  });
  it('accepts a single action and any ordered subset', () => {
    expect(bundle([comment]).success).toBe(true);
    expect(bundle([assign, remove]).success).toBe(true);
  });
  it('rejects an empty bundle and more than four actions', () => {
    expect(bundle([]).success).toBe(false);
    expect(bundle([assign, add, remove, comment, comment]).success).toBe(false);
  });
  it('rejects actions out of order', () => {
    expect(bundle([comment, assign]).success).toBe(false);
    expect(bundle([add, assign]).success).toBe(false);
    expect(bundle([remove, add]).success).toBe(false);
  });
  it('rejects the same type twice', () => {
    expect(bundle([add, add]).success).toBe(false);
  });
  it('rejects actions on different issues or repositories', () => {
    expect(bundle([assign, { ...add, issue: 6 }]).success).toBe(false);
    expect(bundle([assign, { ...add, repo: 'o/other' }]).success).toBe(false);
  });
  it('rejects pull request actions and unrelated types', () => {
    expect(bundle([{ type: 'pr.comment', repo, pull: 5, body: 'x' }]).success).toBe(false);
    expect(bundle([assign, { type: 'pr.close', repo, pull: 5, body: 'x' }]).success).toBe(false);
  });
  it('requires a well-formed snapshot', () => {
    expect(
      ApprovalBundle.safeParse({ actions: [assign], snapshot: { ...snapshot, state: 'merged' } })
        .success,
    ).toBe(false);
    expect(
      ApprovalBundle.safeParse({
        actions: [assign],
        snapshot: { ...snapshot, assignees: ['-bad'] },
      }).success,
    ).toBe(false);
    expect(ApprovalBundle.safeParse({ actions: [assign] }).success).toBe(false);
  });
});

describe('GitHubLogin', () => {
  it.each(['a', 'alice', 'a-b', 'A1-b2-c3', 'a'.repeat(39)])('accepts %s', (l) => {
    expect(GitHubLogin.safeParse(l).success).toBe(true);
  });
  it.each(['', '-a', 'a-', 'a--b', 'a_b', 'a b', 'a'.repeat(40), '@alice', 'a/b', 'a\n'])(
    'rejects %j',
    (l) => {
      expect(GitHubLogin.safeParse(l).success).toBe(false);
    },
  );
});

describe('issue.assign', () => {
  it('takes exactly one valid login', () => {
    expect(BrokerAction.safeParse(assign).success).toBe(true);
    expect(BrokerAction.safeParse({ ...assign, assignees: [] }).success).toBe(false);
    expect(BrokerAction.safeParse({ ...assign, assignees: ['a', 'b'] }).success).toBe(false);
    expect(BrokerAction.safeParse({ ...assign, assignees: ['not a login'] }).success).toBe(false);
  });
});

describe('AgentPolicy approval fields', () => {
  const base = { tokenBinding: 'PAT_X', mode: 'hitl', repos: ['o/r'], actions: ['issue.comment'] };
  it('defaults: no ttl or pending limit, visible trailer', () => {
    const p = AgentPolicy.parse(base);
    expect(p.approvalTtlHours).toBeUndefined();
    expect(p.maxPendingApprovals).toBeUndefined();
    expect(p.trailer).toBe('visible');
  });
  it('accepts the triage-apply values', () => {
    const p = AgentPolicy.parse({
      ...base,
      approvalTtlHours: 168,
      maxPendingApprovals: 50,
      trailer: 'hidden',
      bundleOnly: true,
    });
    expect(p.trailer).toBe('hidden');
  });
  it.each([
    { approvalTtlHours: 0 },
    { approvalTtlHours: 337 },
    { approvalTtlHours: 1.5 },
    { maxPendingApprovals: 0 },
    { maxPendingApprovals: 201 },
    { trailer: 'none' },
  ])('rejects %j', (extra) => {
    expect(AgentPolicy.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});

describe('policy: a hidden trailer only behind a bundle approval (Claude review of #106)', () => {
  const agent = {
    tokenBinding: 'PAT_X',
    mode: 'hitl',
    repos: ['mackowski/custodes-sandbox'],
    actions: ['issue.comment'],
  };
  it('refuses trailer hidden without hitl and bundleOnly', () => {
    expect(AgentPolicy.safeParse({ ...agent, trailer: 'hidden', bundleOnly: true }).success).toBe(
      true,
    );
    expect(AgentPolicy.safeParse({ ...agent, trailer: 'hidden' }).success).toBe(false);
    expect(
      AgentPolicy.safeParse({ ...agent, mode: 'hotl', trailer: 'hidden', bundleOnly: true })
        .success,
    ).toBe(false);
    expect(AgentPolicy.safeParse(agent).success).toBe(true);
  });
});
