import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APPROVAL_TTL_HOURS,
  DEFAULT_MAX_PENDING_APPROVALS,
  Policy,
} from '@custodes/schema';
import { capabilityDiff, cell, grants, renderDiff } from '../../../scripts/policy-diff.js';
import { needsApproval } from '../src/policy-eval.js';

const live: unknown = JSON.parse(
  readFileSync(
    new URL('../../../workers/github-broker/policy/policy.json', import.meta.url),
    'utf8',
  ),
);
interface Fixture {
  version: number;
  agents: Record<
    string,
    {
      $comment?: string;
      tokenBinding: string;
      mode: string;
      tier: string;
      repos: string[];
      actions: string[];
      requiresApprovalOn: Record<string, string[]>;
      labels?: string[];
    }
  >;
  reads: Record<string, { tokenBinding: string; repos: string[]; resources: string[] }>;
}
const base: Fixture = {
  version: 1,
  agents: {
    x: {
      $comment: 'ignored',
      tokenBinding: 'PAT_X',
      mode: 'hotl',
      tier: 'T1',
      repos: ['o/a'],
      actions: ['issue.comment', 'issue.label.add'],
      requiresApprovalOn: { 'o/a': ['issue.comment'] },
      labels: ['bug'],
    },
  },
  reads: { x: { tokenBinding: 'PAT_READONLY', repos: ['o/a'], resources: ['issue'] } },
};

describe('policy capability diff (ADR 0022)', () => {
  it('reports nothing when the grants are the same, comments aside', () => {
    const recommented = structuredClone(base);
    recommented.agents['x']!.$comment = 'changed text';
    expect(capabilityDiff(base, recommented)).toEqual({ added: [], removed: [] });
    expect(capabilityDiff(live, live)).toEqual({ added: [], removed: [] });
  });

  it('shows a dropped approval as one grant removed and one added', () => {
    const head = structuredClone(base);
    head.agents['x']!.requiresApprovalOn = { 'o/a': [] };
    expect(capabilityDiff(base, head)).toEqual({
      added: ['x | action | o/a issue.comment approval=no'],
      removed: ['x | action | o/a issue.comment approval=yes'],
    });
  });

  it('shows a removed label allow-list as *any*, a new repo per action and rate, and new reads', () => {
    const head = structuredClone(base);
    const x = head.agents['x']!;
    delete x.labels;
    x.repos.push('o/b');
    head.reads['x']!.resources.push('pulls');
    const { added } = capabilityDiff(base, head);
    expect(added).toEqual(
      expect.arrayContaining([
        'x | label | *any*',
        'x | action | o/b issue.comment approval=no',
        'x | rate | o/b 60/h',
        'x | read | o/a pulls',
      ]),
    );
  });

  it('uses the broker defaults (it cannot import them) and the broker approval rule', () => {
    const lines = [...grants(live)];
    const ttl = `ttl=${DEFAULT_APPROVAL_TTL_HOURS}h pending=${DEFAULT_MAX_PENDING_APPROVALS}`;
    expect(lines.some((l) => l.startsWith('pr-gate | approvals | ') && l.includes(ttl))).toBe(true);
    const parsed = Policy.parse(live);
    for (const [id, a] of Object.entries(parsed.agents))
      for (const repo of a.repos)
        for (const t of a.actions) {
          const yes = needsApproval(a, repo, t) ? 'yes' : 'no';
          expect(lines).toContain(`${id} | action | ${repo} ${t} approval=${yes}`);
        }
  });

  it('shows no label row for an agent without a label action', () => {
    expect([...grants(live)].some((l) => l.startsWith('pr-gate | label'))).toBe(false);
  });

  it('shows a new maintainer as an added grant (ADR 0024)', () => {
    const next = { ...base, maintainers: { 'OWASP/CheatSheetSeries': ['alice'] } };
    expect(capabilityDiff(base, next).added).toEqual([
      '* | maintainer | OWASP/CheatSheetSeries alice',
    ]);
  });

  it('treats a missing base file as empty, so a new file shows every grant', () => {
    expect(capabilityDiff({}, base).added.length).toBe(grants(base).size);
  });

  it('keeps untrusted values from breaking the table', () => {
    expect(cell('a|b`c\n<script>')).toBe('a?b?c??script?');
    const head = structuredClone(base);
    head.agents['x|y'] = { ...head.agents['x']! };
    const md = renderDiff('policy.json', capabilityDiff(base, head));
    expect(md).not.toMatch(/x\|y/);
    expect(md).toMatch(/^\| \+ \| x\?y \| agent \|/m);
  });
});
