import { describe, expect, it } from 'vitest';
import {
  AgentId,
  BrokerAction,
  BrokerActionType,
  BrokerReadRequest,
  BrokerRequest,
  BrokerResponse,
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
          tier: 'T1',
          mode: 'hotl',
          repos: ['OWASP/CheatSheetSeries'],
          actions: ['issue.comment', 'issue.label.add'],
          labels: ['bug'],
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

describe('pr.review.inline action', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const comment = { path: 'cheatsheets/A_Cheat_Sheet.md', line: 10, side: 'RIGHT', body: 'fix' };
  const review = {
    type: 'pr.review.inline',
    repo: 'mackowski/custodes-sandbox',
    pull: 7,
    commitId: sha,
    event: 'COMMENT',
    body: 'summary',
    comments: [comment],
  };
  const ok = (over: Record<string, unknown>) =>
    BrokerAction.safeParse({ ...review, ...over }).success;

  it('is an enumerated action type and parses a valid review', () => {
    expect(BrokerActionType.options).toContain('pr.review.inline');
    expect(ok({})).toBe(true);
    expect(ok({ event: 'REQUEST_CHANGES', comments: [] })).toBe(true);
  });
  it('never allows APPROVE', () => {
    expect(ok({ event: 'APPROVE' })).toBe(false);
  });
  it('pins a full lower-case commit SHA', () => {
    for (const commitId of ['main', sha.slice(0, 7), sha.toUpperCase(), `${sha}0`]) {
      expect(ok({ commitId })).toBe(false);
    }
  });
  it('caps comments at 20 and comment bodies at 3900 characters (the broker adds a marker)', () => {
    expect(ok({ comments: Array.from({ length: 20 }, () => comment) })).toBe(true);
    expect(ok({ comments: Array.from({ length: 21 }, () => comment) })).toBe(false);
    expect(ok({ comments: [{ ...comment, body: 'x'.repeat(3_900) }] })).toBe(true);
    expect(ok({ comments: [{ ...comment, body: 'x'.repeat(3_901) }] })).toBe(false);
    expect(ok({ comments: [{ ...comment, body: '' }] })).toBe(false);
  });
  it('accepts only RIGHT-side comments with a start line before the end line', () => {
    expect(ok({ comments: [{ ...comment, side: 'LEFT' }] })).toBe(false);
    expect(ok({ comments: [{ ...comment, startLine: 8 }] })).toBe(true);
    expect(ok({ comments: [{ ...comment, startLine: 10 }] })).toBe(false);
    expect(ok({ comments: [{ ...comment, line: 0 }] })).toBe(false);
  });
  it('rejects absolute, dot-segment and odd paths', () => {
    for (const path of [
      '/etc/passwd',
      '../x.md',
      'a/../b.md',
      'a/./b.md',
      'a//b.md',
      'a b.md',
      '',
    ]) {
      expect(ok({ comments: [{ ...comment, path }] })).toBe(false);
    }
  });
});

describe('read resources pull and pull_file_at_ref', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const base = {
    agentId: 'cheatsheet-review',
    runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
    repo: 'mackowski/custodes-sandbox',
  };
  const ok = (over: Record<string, unknown>) =>
    BrokerReadRequest.safeParse({ ...base, ...over }).success;

  it('pull needs a number and nothing else', () => {
    expect(ok({ resource: 'pull', number: 3 })).toBe(true);
    expect(ok({ resource: 'pull' })).toBe(false);
    expect(ok({ resource: 'pull', number: 3, ref: sha })).toBe(false);
  });
  it('pull_file_at_ref needs a cheat sheet path and a full SHA, and nothing else', () => {
    const at = { resource: 'pull_file_at_ref', path: 'cheatsheets/A_Cheat_Sheet.md', ref: sha };
    expect(ok(at)).toBe(true);
    expect(ok({ ...at, path: 'cheatsheets_draft/A.md' })).toBe(true);
    expect(ok({ ...at, ref: undefined })).toBe(false);
    expect(ok({ ...at, path: undefined })).toBe(false);
    expect(ok({ ...at, number: 1 })).toBe(false);
    expect(ok({ ...at, ref: 'main' })).toBe(false);
    for (const path of [
      'README.md',
      '.github/workflows/x.md',
      'cheatsheets/../README.md',
      'cheatsheets/a/b.md',
      'cheatsheets/.hidden.md',
      'cheatsheets/A.txt',
    ]) {
      expect(ok({ ...at, path })).toBe(false);
    }
  });
  it('path and ref are refused on other resources', () => {
    expect(ok({ resource: 'cheatsheets', ref: sha })).toBe(false);
    expect(ok({ resource: 'issue', number: 1, path: 'cheatsheets/A.md' })).toBe(false);
  });
});

describe('label actions and policy token bindings', () => {
  it('refuses `.` and `..` as label names (URL parsing would widen the DELETE)', () => {
    const remove = (labels: string[]) =>
      BrokerAction.safeParse({ type: 'issue.label.remove', repo: 'a/b', issue: 1, labels }).success;
    expect(remove(['custodes_cheatsheet_review'])).toBe(true);
    expect(remove(['.'])).toBe(false);
    expect(remove(['..'])).toBe(false);
    expect(remove(['ok', '..'])).toBe(false);
  });
  it('accepts only PAT_* token bindings', () => {
    const agent = (tokenBinding: string) =>
      Policy.safeParse({
        version: 1,
        agents: {
          x1: {
            tokenBinding,
            mode: 'hotl',
            tier: 'T1',
            repos: ['a/b'],
            actions: ['issue.comment'],
          },
        },
      }).success;
    expect(agent('PAT_X')).toBe(true);
    expect(agent('CLOUDFLARE_API_TOKEN')).toBe(false);
    expect(agent('PAT_')).toBe(false);
  });
});

describe('policy label grants', () => {
  const agent = (over: Record<string, unknown>) =>
    Policy.safeParse({
      version: 1,
      agents: {
        x1: {
          tokenBinding: 'PAT_X',
          tier: 'T1',
          mode: 'hotl',
          repos: ['a/b'],
          actions: ['issue.label.remove'],
          ...over,
        },
      },
    }).success;
  it('needs a labels allow-list for a label action', () => {
    expect(agent({})).toBe(false);
    expect(agent({ labels: ['custodes_cheatsheet_review'] })).toBe(true);
    expect(agent({ actions: ['issue.label.add'] })).toBe(false);
    expect(agent({ actions: ['issue.comment'] })).toBe(true);
  });
});

describe('broker response', () => {
  it('parses every refusal the broker sends before executing', () => {
    // index.ts: a refused signature (401) and the default entrypoint that serves no agent (403).
    for (const code of ['unauthenticated', 'refused', 'invalid', 'policy_denied'])
      expect(BrokerResponse.safeParse({ ok: false, code, reason: 'x' }).success).toBe(true);
    expect(BrokerResponse.safeParse({ ok: false, code: 'made_up', reason: 'x' }).success).toBe(
      false,
    );
  });
});

describe('issue.close and issue.unassign (ADR 0024)', () => {
  const close = {
    type: 'issue.close',
    repo: 'o/r',
    issue: 3,
    body: 'fixed in #4',
    stateReason: 'completed',
  };
  const unassign = { type: 'issue.unassign', repo: 'o/r', issue: 3, assignees: ['alice'] };
  it('issue.close needs a body and a state reason from the enum', () => {
    expect(BrokerAction.safeParse(close).success).toBe(true);
    expect(BrokerAction.safeParse({ ...close, stateReason: 'not_planned' }).success).toBe(true);
    expect(BrokerAction.safeParse({ ...close, stateReason: 'duplicate' }).success).toBe(false);
    expect(BrokerAction.safeParse({ ...close, stateReason: 'reopened' }).success).toBe(false);
    const { stateReason: _s, ...noReason } = close;
    expect(BrokerAction.safeParse(noReason).success).toBe(false);
    const { body: _b, ...noBody } = close;
    expect(BrokerAction.safeParse(noBody).success).toBe(false);
    expect(BrokerAction.safeParse({ ...close, body: '' }).success).toBe(false);
  });
  it('issue.unassign takes exactly one valid login', () => {
    expect(BrokerAction.safeParse(unassign).success).toBe(true);
    expect(BrokerAction.safeParse({ ...unassign, assignees: [] }).success).toBe(false);
    expect(BrokerAction.safeParse({ ...unassign, assignees: ['a', 'b'] }).success).toBe(false);
    expect(BrokerAction.safeParse({ ...unassign, assignees: ['-bad'] }).success).toBe(false);
  });
});

describe('policy trigger-label grants, maintainers and critical actions (ADR 0024)', () => {
  const approvedReview = {
    tokenBinding: 'PAT_CHEATSHEET_REVIEW',
    tier: 'T2',
    mode: 'hotl',
    repos: ['OWASP/CheatSheetSeries'],
    actions: ['pr.review.inline', 'issue.label.remove'],
    requiresApprovalOn: { 'OWASP/CheatSheetSeries': ['pr.review.inline'] },
    labels: ['custodes_cheatsheet_review'],
  };
  const labeller = (labels: string[]) => ({
    tokenBinding: 'PAT_X',
    tier: 'T1',
    mode: 'hitl',
    repos: ['OWASP/CheatSheetSeries'],
    actions: ['issue.label.add'],
    labels,
  });
  const policy = (agents: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    Policy.safeParse({ version: 1, agents, ...extra });

  it.each(['custodes_cheatsheet_review', 'jules', 'Custodes_CheatSheet_Review', 'JULES'])(
    'refuses a label-adding agent that is not granted the trigger label %s',
    (label) => {
      expect(policy({ 'some-agent': labeller([label]) }).success).toBe(false);
      expect(
        policy({ 'cheatsheet-review': approvedReview, 'some-agent': labeller([label]) }).success,
      ).toBe(false);
    },
  );
  it('accepts a non-trigger label for any agent', () => {
    expect(policy({ 'some-agent': labeller(['docker']) }).success).toBe(true);
  });
  it('accepts the granted agent, case-insensitively, when OWASP approval for reviews stays', () => {
    const agents = { 'cheatsheet-review': approvedReview };
    for (const label of ['custodes_cheatsheet_review', 'Custodes_Cheatsheet_Review'])
      expect(policy({ ...agents, 'backlog-review': labeller([label]) }).success, label).toBe(true);
  });
  it('never grants jules, even to the granted agent', () => {
    const agents = { 'cheatsheet-review': approvedReview };
    expect(policy({ ...agents, 'backlog-review': labeller(['jules']) }).success).toBe(false);
  });
  describe('the grant is tied to approval on every repository shared with cheatsheet-review', () => {
    const SANDBOX = 'mackowski/custodes-sandbox';
    const OWASP = 'OWASP/CheatSheetSeries';
    const review = (repos: string[], approvedOn: string[]) => ({
      ...approvedReview,
      repos,
      requiresApprovalOn: Object.fromEntries(approvedOn.map((r) => [r, ['pr.review.inline']])),
    });
    const granted = (repos: string[]) => ({
      'backlog-review': { ...labeller(['custodes_cheatsheet_review']), repos },
    });
    it('refuses a shared non-sandbox repository without the approval', () => {
      expect(
        policy({ 'cheatsheet-review': review([OWASP], []), ...granted([OWASP]) }).success,
      ).toBe(false);
      // An approval for another action or another repository does not count.
      const other = review([OWASP, 'a/b'], ['a/b']);
      expect(policy({ 'cheatsheet-review': other, ...granted([OWASP]) }).success).toBe(false);
      const wrongAction = {
        ...review([OWASP], []),
        requiresApprovalOn: { [OWASP]: ['issue.label.remove'] },
      };
      expect(policy({ 'cheatsheet-review': wrongAction, ...granted([OWASP]) }).success).toBe(false);
    });
    it('accepts it when the approval stands on the shared repository', () => {
      expect(
        policy({ 'cheatsheet-review': review([OWASP], [OWASP]), ...granted([OWASP]) }).success,
      ).toBe(true);
    });
    it('accepts a sandbox-only overlap without any approval', () => {
      expect(
        policy({ 'cheatsheet-review': review([SANDBOX], []), ...granted([SANDBOX]) }).success,
      ).toBe(true);
    });
    it('refuses a third shared non-sandbox repository that lacks the approval', () => {
      const repos = [SANDBOX, OWASP, 'a/b'];
      expect(
        policy({ 'cheatsheet-review': review(repos, [OWASP]), ...granted(repos) }).success,
      ).toBe(false);
      expect(
        policy({ 'cheatsheet-review': review(repos, [OWASP, 'a/b']), ...granted(repos) }).success,
      ).toBe(true);
    });
    it('accepts no overlap at all, without approval', () => {
      expect(
        policy({ 'cheatsheet-review': review([OWASP], []), ...granted(['a/b']) }).success,
      ).toBe(true);
    });
    it('does not need the approval for a repository only the grantee has', () => {
      expect(
        policy({
          'cheatsheet-review': review([SANDBOX, OWASP], [OWASP]),
          ...granted([SANDBOX, OWASP, 'a/b']),
        }).success,
      ).toBe(true);
    });
  });
  it('lets an agent that only removes the trigger label list it (cheatsheet-review style)', () => {
    expect(policy({ 'cheatsheet-review': approvedReview }).success).toBe(true);
    expect(
      policy({
        'other-agent': {
          ...labeller(['jules']),
          actions: ['issue.label.remove'],
        },
      }).success,
    ).toBe(true);
  });

  it('accepts maintainers per repository and refuses bad logins or repositories', () => {
    const agents = { 'some-agent': labeller(['docker']) };
    const p = policy(agents, { maintainers: { 'o/r': ['alice', 'Bob-1'] } });
    expect(p.success).toBe(true);
    if (p.success) expect(p.data.maintainers['o/r']).toEqual(['alice', 'Bob-1']);
    expect(policy(agents).success && Policy.parse({ version: 1, agents }).maintainers).toEqual({});
    expect(policy(agents, { maintainers: { 'o/r': ['-bad'] } }).success).toBe(false);
    expect(policy(agents, { maintainers: { 'o/r': ['@alice'] } }).success).toBe(false);
    expect(policy(agents, { maintainers: { 'o/r': ['a b'] } }).success).toBe(false);
    expect(policy(agents, { maintainers: { 'not a repo': ['alice'] } }).success).toBe(false);
    expect(policy(agents, { maintainers: { 'o/r': 'alice' } }).success).toBe(false);
  });

  describe('a critical action needs an approval unless the agent is hitl', () => {
    // pr.review is retired but stays in the registry as critical: a usable fixture.
    const critical = (over: Record<string, unknown>) =>
      Policy.safeParse({
        version: 1,
        agents: {
          'x-agent': {
            tokenBinding: 'PAT_X',
            tier: 'T1',
            repos: ['a/b'],
            actions: ['pr.review'],
            ...over,
          },
        },
      });
    it('refuses a hotl agent granted a critical action without requiresApproval', () => {
      expect(critical({ mode: 'hotl' }).success).toBe(false);
      expect(critical({ mode: 'hotl', requiresApproval: [] }).success).toBe(false);
      // An approval on one repository only is not "every repository".
      expect(critical({ mode: 'hotl', requiresApprovalOn: { 'a/b': ['pr.review'] } }).success).toBe(
        false,
      );
    });
    it('accepts a hotl agent when requiresApproval names the critical action', () => {
      expect(critical({ mode: 'hotl', requiresApproval: ['pr.review'] }).success).toBe(true);
    });
    it('accepts a hitl agent, which already needs an approval for everything', () => {
      expect(critical({ mode: 'hitl' }).success).toBe(true);
    });
  });
});

describe('cheatsheet_search request (ADR 0023)', () => {
  const base = {
    agentId: 'backlog-review',
    runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
    repo: 'OWASP/CheatSheetSeries',
    resource: 'cheatsheet_search',
  };
  it('needs search, and search only goes with cheatsheet_search', () => {
    expect(BrokerReadRequest.safeParse({ ...base, search: 'password storage' }).success).toBe(true);
    expect(BrokerReadRequest.safeParse(base).success).toBe(false);
    expect(
      BrokerReadRequest.safeParse({ ...base, resource: 'issues', search: 'password' }).success,
    ).toBe(false);
  });
  it.each([
    'repo:evil/repo password',
    'password path:secrets',
    '"exact phrase"',
    'a',
    'x'.repeat(101),
    '-password',
    'pass+word',
    'user:someone',
    'password\nrepo:x',
    'password OR secret',
    'NOT password',
    'a AND b',
  ])('refuses search words %j that could carry their own qualifiers', (search) => {
    expect(BrokerReadRequest.safeParse({ ...base, search }).success).toBe(false);
  });
});
