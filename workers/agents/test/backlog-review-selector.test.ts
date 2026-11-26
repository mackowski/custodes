import { describe, expect, it } from 'vitest';
import {
  MAX_ISSUES_PER_RUN,
  selectIssues,
  type LastVerdict,
} from '../src/agents/backlog-review/selector.js';
import type { PublicIssue } from '../src/agents/triage/github.js';

const NOW = new Date('2026-11-26T12:00:00Z');
const HOUR = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR).toISOString();

/** An accepted, assigned issue: backlog, not triage's new-issue stream. */
function issue(number: number, over: Partial<PublicIssue> = {}): PublicIssue {
  return {
    number,
    title: `Issue ${String(number)}`,
    html_url: `https://github.com/OWASP/CheatSheetSeries/issues/${String(number)}`,
    user: { login: 'someone' },
    labels: [{ name: 'ACK_OBTAINED' }],
    assignees: [{ login: 'volunteer' }],
    created_at: ago(1000),
    updated_at: ago(100),
    comments: 1,
    ...over,
  };
}

const verdict = (issueUpdatedAt: string, at: string): LastVerdict => ({ issueUpdatedAt, at });

describe('selectIssues', () => {
  it('picks never-reviewed backlog issues', () => {
    expect(selectIssues([issue(1), issue(2)], new Map(), NOW)).toEqual([1, 2]);
  });

  it('skips pull requests and triage new issues', () => {
    const pr = issue(3, { pull_request: { url: 'x' } });
    const fresh = issue(4, { labels: [{ name: 'ACK_WAITING' }], assignees: [] });
    const noAck = issue(5, { labels: [], assignees: [] });
    // Assigned without an ACK label is backlog (isNewIssue: assignees > 0).
    const assigned = issue(6, { labels: [] });
    expect(selectIssues([pr, fresh, noAck, assigned], new Map(), NOW)).toEqual([6]);
  });

  it('reviews again only after a change or 72 hours', () => {
    const i = issue(7);
    const unchanged = new Map([[7, verdict(i.updated_at, ago(71))]]);
    expect(selectIssues([i], unchanged, NOW)).toEqual([]);
    const old = new Map([[7, verdict(i.updated_at, ago(72))]]);
    expect(selectIssues([i], old, NOW)).toEqual([7]);
    const changed = new Map([[7, verdict(ago(200), ago(1))]]);
    expect(selectIssues([i], changed, NOW)).toEqual([7]);
  });

  it('orders never-reviewed first, then the oldest verdict, and caps the run', () => {
    const open = Array.from({ length: 30 }, (_, k) => issue(k + 1, { updated_at: ago(1) }));
    // Issues 1-25 have a verdict on an older updated_at, the newer the higher the number.
    const last = new Map(
      Array.from({ length: 25 }, (_, k) => [k + 1, verdict(ago(500), ago(50 - k))] as const),
    );
    const picked = selectIssues(open, last, NOW);
    expect(picked).toHaveLength(MAX_ISSUES_PER_RUN);
    expect(picked.slice(0, 5)).toEqual([26, 27, 28, 29, 30]);
    expect(picked.slice(5, 8)).toEqual([1, 2, 3]);
  });
});
