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
  it('caps comments at 20 and comment bodies at 4000 characters', () => {
    expect(ok({ comments: Array.from({ length: 20 }, () => comment) })).toBe(true);
    expect(ok({ comments: Array.from({ length: 21 }, () => comment) })).toBe(false);
    expect(ok({ comments: [{ ...comment, body: 'x'.repeat(4_001) }] })).toBe(false);
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
