import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Policy, type AgentPolicy } from '@custodes/schema';
import { boundaryViolations } from '../src/policy-boundary.js';

const load = (name: string): Policy =>
  Policy.parse(
    JSON.parse(
      readFileSync(
        new URL(`../../../workers/github-broker/policy/${name}`, import.meta.url),
        'utf8',
      ),
    ),
  );
const boundary = load('boundary.json');
const live = load('policy.json');

const agent: AgentPolicy = {
  tokenBinding: 'PAT_X',
  mode: 'hotl',
  tier: 'T1',
  repos: ['o/a', 'o/b'],
  actions: ['issue.comment', 'issue.label.add'],
  requiresApproval: [],
  requiresApprovalOn: { 'o/b': ['issue.comment'] },
  rateLimitPerHour: 10,
  labels: ['bug'],
  approvalTtlHours: 48,
  trailer: 'visible',
  bundleOnly: false,
};
const ceiling: Policy = {
  version: 1,
  agents: { x: agent },
  reads: { x: { tokenBinding: 'PAT_READONLY', repos: ['o/a'], resources: ['issue', 'comments'] } },
};
const withAgent = (over: Partial<AgentPolicy>): Policy => ({
  ...ceiling,
  agents: { x: { ...agent, ...over } },
});

describe('boundaryViolations (ADR 0022)', () => {
  it('finds the live policy inside the live boundary', () => {
    expect(boundaryViolations(boundary, live)).toEqual([]);
  });

  it('accepts the boundary itself and any narrowing', () => {
    expect(boundaryViolations(ceiling, ceiling)).toEqual([]);
    const narrower = withAgent({
      repos: ['o/a'],
      actions: ['issue.comment'],
      rateLimitPerHour: 5,
      mode: 'hitl',
      approvalTtlHours: 24,
    });
    expect(boundaryViolations(ceiling, narrower)).toEqual([]);
  });

  it('reports every kind of widening', () => {
    const cases: [Partial<AgentPolicy>, RegExp][] = [
      [{ repos: ['o/a', 'o/c'] }, /repo o\/c/],
      [{ actions: ['issue.comment', 'issue.label.add', 'pr.close'] }, /action pr.close/],
      [{ tier: 'T2', actions: ['pr.review.inline'] }, /tier T2/],
      [{ rateLimitPerHour: 11 }, /rateLimitPerHour/],
      [{ requiresApprovalOn: {} }, /issue.comment on o\/b needs an approval/],
      [{ labels: ['bug', 'jules'] }, /label jules/],
      [{ approvalTtlHours: 72 }, /approvalTtlHours/],
      [{ maxPendingApprovals: 21 }, /maxPendingApprovals/],
      [{ tokenBinding: 'PAT_Y' }, /tokenBinding/],
    ];
    for (const [over, re] of cases) {
      const found = boundaryViolations(ceiling, withAgent(over));
      expect(
        found.some((m) => re.test(m)),
        `${JSON.stringify(over)} → ${found.join('; ')}`,
      ).toBe(true);
    }
  });

  it('treats a removed label allow-list as a widening', () => {
    const { labels: _labels, ...noLabels } = agent;
    const p: Policy = { ...ceiling, agents: { x: noLabels } };
    expect(boundaryViolations(ceiling, p)).toContain(
      'agents.x: labels allow-list removed (every label allowed)',
    );
  });

  it('treats hotl under a hitl boundary, a hidden trailer and dropped bundleOnly as widenings', () => {
    const strict: Policy = {
      ...ceiling,
      agents: { x: { ...agent, mode: 'hitl', trailer: 'visible', bundleOnly: true } },
    };
    const loose = withAgent({ mode: 'hotl', bundleOnly: false });
    const found = boundaryViolations(strict, loose);
    expect(found).toContain('agents.x: mode hotl is looser than hitl');
    expect(found).toContain('agents.x: bundleOnly off, boundary says on');
  });

  it('reports a new agent and read widenings', () => {
    const p: Policy = {
      ...ceiling,
      agents: { ...ceiling.agents, y: agent },
      reads: {
        x: { tokenBinding: 'PAT_READONLY', repos: ['o/a', 'o/b'], resources: ['issue', 'pulls'] },
        z: { tokenBinding: 'PAT_READONLY', repos: ['o/a'], resources: ['issue'] },
      },
    };
    expect(boundaryViolations(ceiling, p)).toEqual([
      'agents.y: not in the boundary',
      'reads.x: repo o/b not in the boundary',
      'reads.x: resource pulls not in the boundary',
      'reads.z: not in the boundary',
    ]);
  });
});
