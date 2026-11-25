import { describe, expect, it } from 'vitest';
import {
  AgentPolicy,
  ApprovalBundle,
  BUNDLE_ORDER,
  BrokerAction,
  GitHubLogin,
  IssueSnapshot,
  PullSnapshot,
  isPullBundle,
} from '../src/index.js';

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
  it('rejects an empty bundle and more than BUNDLE_ORDER.length actions', () => {
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
  const base = {
    tokenBinding: 'PAT_X',
    mode: 'hitl',
    tier: 'T1',
    repos: ['o/r'],
    actions: ['issue.comment'],
  };
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
    tier: 'T1',
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

describe('ApprovalBundle for pull requests and closing actions (ADR 0024)', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const pullSnapshot = {
    ...snapshot,
    headSha: sha,
    reviewsDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const unassign = { type: 'issue.unassign' as const, repo, issue: 5, assignees: ['alice'] };
  const issueClose = {
    type: 'issue.close' as const,
    repo,
    issue: 5,
    body: 'done',
    stateReason: 'completed' as const,
  };
  const prClose = { type: 'pr.close' as const, repo, pull: 5, body: 'closing' };
  const pullBundle = (actions: unknown[], snap: unknown = pullSnapshot) =>
    ApprovalBundle.safeParse({ actions, snapshot: snap });

  it('accepts a pull bundle with labels and a comment before the closing pr.close', () => {
    const r = pullBundle([add, remove, comment, prClose]);
    expect(r.success).toBe(true);
    if (r.success) expect(isPullBundle(r.data)).toBe(true);
  });
  it('does not treat an issue bundle as a pull bundle', () => {
    const r = bundle([add, comment]);
    expect(r.success).toBe(true);
    if (r.success) expect(isPullBundle(r.data)).toBe(false);
  });
  it('refuses issue.close in a pull bundle and pr.close in an issue bundle', () => {
    expect(pullBundle([comment, issueClose]).success).toBe(false);
    expect(bundle([comment, prClose]).success).toBe(false);
    // The pair that matches each kind is accepted.
    expect(bundle([comment, issueClose]).success).toBe(true);
    expect(pullBundle([comment, prClose]).success).toBe(true);
  });
  it('lists unassign after assign and close last in BUNDLE_ORDER', () => {
    expect(BUNDLE_ORDER.indexOf('issue.assign')).toBeLessThan(
      BUNDLE_ORDER.indexOf('issue.unassign'),
    );
    expect(BUNDLE_ORDER.indexOf('issue.unassign')).toBeLessThan(
      BUNDLE_ORDER.indexOf('issue.label.add'),
    );
    expect(BUNDLE_ORDER.indexOf('issue.comment')).toBeLessThan(BUNDLE_ORDER.indexOf('issue.close'));
    expect(BUNDLE_ORDER.slice(-2)).toEqual(['issue.close', 'pr.close']);
  });
  it('accepts issue.unassign and issue.close in order and refuses them out of order', () => {
    expect(bundle([assign, unassign, add, remove, comment, issueClose]).success).toBe(true);
    expect(bundle([unassign, assign]).success).toBe(false);
    expect(bundle([add, unassign]).success).toBe(false);
    // A close must be last: nothing may follow it.
    expect(bundle([issueClose, comment]).success).toBe(false);
    expect(bundle([issueClose, add]).success).toBe(false);
    expect(pullBundle([prClose, comment]).success).toBe(false);
    expect(pullBundle([prClose, add]).success).toBe(false);
  });
  it('refuses issue.close and pr.close together', () => {
    expect(pullBundle([issueClose, prClose]).success).toBe(false);
    expect(bundle([issueClose, prClose]).success).toBe(false);
  });
  it('holds every action in the registry order, at most once, up to seven', () => {
    expect(BUNDLE_ORDER).toHaveLength(7);
    expect(bundle([assign, unassign, add, remove, comment, issueClose, issueClose]).success).toBe(
      false,
    );
  });
  it('requires one target: issue and pull numbers are compared, and so is the repository', () => {
    expect(pullBundle([add, prClose]).success).toBe(true);
    expect(pullBundle([add, { ...prClose, pull: 6 }]).success).toBe(false);
    expect(pullBundle([add, { ...prClose, repo: 'o/other' }]).success).toBe(false);
    expect(bundle([comment, { ...issueClose, issue: 6 }]).success).toBe(false);
  });
  it('does not parse an issue snapshot with extra keys such as headSha', () => {
    expect(IssueSnapshot.safeParse(snapshot).success).toBe(true);
    expect(IssueSnapshot.safeParse({ ...snapshot, headSha: sha }).success).toBe(false);
    expect(IssueSnapshot.safeParse(pullSnapshot).success).toBe(false);
    expect(PullSnapshot.safeParse(pullSnapshot).success).toBe(true);
  });
  it('fails a pull snapshot without reviewsDigest or with a malformed head sha', () => {
    const { reviewsDigest: _drop, ...noDigest } = pullSnapshot;
    expect(PullSnapshot.safeParse(noDigest).success).toBe(false);
    expect(pullBundle([add, prClose], noDigest).success).toBe(false);
    expect(pullBundle([add, prClose], { ...pullSnapshot, headSha: 'abc123' }).success).toBe(false);
    expect(
      pullBundle([add, prClose], { ...pullSnapshot, headSha: sha.toUpperCase() }).success,
    ).toBe(false);
  });
  it('still parses an ADR 0019 record: four issue actions with an IssueSnapshot, unchanged', () => {
    const stored = {
      actions: [assign, add, remove, comment],
      snapshot,
    };
    const r = ApprovalBundle.safeParse(JSON.parse(JSON.stringify(stored)));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data).toEqual(stored);
      expect(isPullBundle(r.data)).toBe(false);
    }
  });
});
