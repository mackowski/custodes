import { describe, expect, it, vi } from 'vitest';
import type { AgentPolicy, BrokerAction, Policy, Proposal, TargetRead } from '@custodes/schema';
import {
  MAX_HOTL_WRITES_PER_RUN,
  routeProposal,
  type DispatchInput,
  type EvidenceChecker,
} from '../src/runtime/dispatcher.js';

const REPO = 'mackowski/custodes-sandbox';
const SNAP = {
  state: 'open' as const,
  labels: [],
  assignees: [],
  comments: 1,
  updatedAt: '2026-11-25T10:00:00Z',
  commentsDigest: 'b'.repeat(64),
};
const target = { repo: REPO, kind: 'issue' as const, number: 7 };
const read: TargetRead = { target, snapshot: SNAP };

const agent = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  tokenBinding: 'PAT_X',
  tier: 'T1',
  mode: 'hotl',
  repos: [REPO],
  actions: ['issue.comment', 'issue.label.add'],
  requiresApproval: [],
  requiresApprovalOn: {},
  rateLimitPerHour: 60,
  labels: ['docs'],
  trailer: 'visible',
  bundleOnly: false,
  ...over,
});
const policyWith = (a: AgentPolicy): Policy => ({ version: 1, reads: {}, agents: { br: a } });

const comment: BrokerAction = { type: 'issue.comment', repo: REPO, issue: 7, body: 'ping' };
const label: BrokerAction = { type: 'issue.label.add', repo: REPO, issue: 7, labels: ['docs'] };

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  target,
  snapshot: SNAP,
  actions: [comment],
  evidence: [],
  reason: 'stale',
  needsHuman: false,
  ...over,
});

const ok: EvidenceChecker = () => Promise.resolve({ ok: true });

function run(over: Partial<DispatchInput> = {}) {
  return routeProposal({
    policy: policyWith(agent()),
    agentId: 'br',
    proposal: proposal(),
    reads: [read],
    hotlWritesSoFar: 0,
    shadow: false,
    checkEvidence: ok,
    ...over,
  });
}

describe('routeProposal', () => {
  it('sends a hotl action that needs no approval to act', async () => {
    expect(await run()).toEqual([{ action: comment, route: 'act' }]);
  });

  it('drops an action on an item not read in this run (cross-item injection)', async () => {
    const other = { ...target, number: 8 };
    const r = await run({
      proposal: proposal({ target: other, actions: [{ ...comment, issue: 8 }] }),
    });
    expect(r[0]).toMatchObject({ route: 'drop', reason: 'target was not read in this run' });
  });

  it('drops an action whose target differs from the proposal target', async () => {
    const r = await run({ proposal: proposal({ actions: [{ ...comment, issue: 8 }] }) });
    expect(r[0]).toMatchObject({ route: 'drop' });
  });

  it('drops when the snapshot is not the one the run read, using the latest read', async () => {
    const newer = { target, snapshot: { ...SNAP, comments: 2 } };
    expect((await run({ reads: [read, newer] }))[0]).toMatchObject({ route: 'drop' });
    expect((await run({ reads: [newer, read] }))[0]).toMatchObject({ route: 'act' });
  });

  it('a pull request read does not count for an issue with the same number', async () => {
    const pullRead = { target: { ...target, kind: 'pull' as const }, snapshot: SNAP };
    expect((await run({ reads: [pullRead] }))[0]).toMatchObject({ route: 'drop' });
  });

  it('drops an action the policy does not grant', async () => {
    const close: BrokerAction = { type: 'pr.close', repo: REPO, pull: 7, body: 'x' };
    const r = await run({ proposal: proposal({ actions: [close] }) });
    expect(r[0]).toMatchObject({ route: 'drop', reason: 'not allowed by policy' });
  });

  it('drops a label outside the allow-list, such as an automation trigger', async () => {
    const trigger: BrokerAction = { ...label, labels: ['docs', 'custodes_cheatsheet_review'] };
    const routes = await run({ proposal: proposal({ actions: [label, trigger] }) });
    expect(routes.map((r) => r.route)).toEqual(['act', 'drop']);
    expect(routes[1]).toMatchObject({ reason: 'label not allowed by policy' });
  });

  it('drops an action whose evidence does not hold', async () => {
    const checkEvidence = vi.fn<EvidenceChecker>(() =>
      Promise.resolve({ ok: false, reason: 'no merged PR references the issue' }),
    );
    const r = await run({ checkEvidence });
    expect(r[0]).toMatchObject({ route: 'drop', reason: 'no merged PR references the issue' });
    expect(checkEvidence).toHaveBeenCalledOnce();
  });

  it('routes to approval when the policy needs one, or the model asks for a human', async () => {
    expect((await run({ policy: policyWith(agent({ mode: 'hitl' })) }))[0]?.route).toBe('approval');
    expect(
      (await run({ policy: policyWith(agent({ requiresApproval: ['issue.comment'] })) }))[0]?.route,
    ).toBe('approval');
    expect((await run({ proposal: proposal({ needsHuman: true }) }))[0]?.route).toBe('approval');
  });

  it('caps hotl writes per run and raises the rest to approval', async () => {
    const r = await run({
      proposal: proposal({ actions: [label, comment] }),
      hotlWritesSoFar: MAX_HOTL_WRITES_PER_RUN - 1,
    });
    expect(r.map((x) => x.route)).toEqual(['act', 'approval']);
  });

  it('only reports in shadow, for a readonly agent, or without a policy entry', async () => {
    expect((await run({ shadow: true }))[0]?.route).toBe('digest');
    expect((await run({ policy: policyWith(agent({ mode: 'readonly' })) }))[0]?.route).toBe(
      'digest',
    );
    expect((await run({ agentId: 'unknown' }))[0]?.route).toBe('digest');
  });

  it('still drops unread targets in shadow, so the digest shows only checked proposals', async () => {
    expect((await run({ shadow: true, reads: [] }))[0]?.route).toBe('drop');
  });
});
