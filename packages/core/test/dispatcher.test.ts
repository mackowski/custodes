import { describe, expect, it, vi } from 'vitest';
import type { AgentPolicy, BrokerAction, Policy, Proposal, TargetRead } from '@custodes/schema';
import {
  MAX_HOTL_WRITES_PER_TREE,
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
const PULL_SNAP = { ...SNAP, headSha: 'a'.repeat(40), reviewsDigest: 'c'.repeat(64) };
const pullTarget = { repo: REPO, kind: 'pull' as const, number: 7 };

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
const policyWith = (a: AgentPolicy): Policy => ({
  version: 1,
  reads: {},
  maintainers: {},
  agents: { br: a },
});

const comment: BrokerAction = { type: 'issue.comment', repo: REPO, issue: 7, body: 'ping' };
const label: BrokerAction = { type: 'issue.label.add', repo: REPO, issue: 7, labels: ['docs'] };

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  target,
  actions: [comment],
  evidence: [],
  reason: 'stale',
  needsHuman: false,
  ...over,
});

const ok: EvidenceChecker = () => Promise.resolve({ ok: true });
const noop = () => Promise.resolve();

/** A tree-wide slot counter like RunStore.takeHotlSlot's. */
function slots(used = 0) {
  let n = used;
  return () => (n < MAX_HOTL_WRITES_PER_TREE ? (n++, true) : false);
}

function run(over: Partial<DispatchInput> = {}) {
  return routeProposal({
    policy: policyWith(agent()),
    agentId: 'br',
    proposal: proposal(),
    reads: [read],
    shadow: false,
    checkEvidence: ok,
    guard: noop,
    takeHotlSlot: slots(),
    ...over,
  });
}

describe('routeProposal', () => {
  it('sends a hotl action that needs no approval to act, with the snapshot of the run', async () => {
    expect(await run()).toEqual([{ action: comment, route: 'act', snapshot: SNAP }]);
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

  it('attaches the latest read of the target, never a snapshot from the model', async () => {
    const newer = { target, snapshot: { ...SNAP, comments: 2 } };
    expect((await run({ reads: [read, newer] }))[0]).toMatchObject({
      route: 'act',
      snapshot: newer.snapshot,
    });
  });

  it('a pull request read does not count for an issue with the same number', async () => {
    const pullRead: TargetRead = { target: pullTarget, snapshot: PULL_SNAP };
    expect((await run({ reads: [pullRead] }))[0]).toMatchObject({ route: 'drop' });
  });

  it('routes a pull request action with the pull snapshot, head SHA included (ADR 0024)', async () => {
    const pullRead: TargetRead = { target: pullTarget, snapshot: PULL_SNAP };
    const routes = await run({
      reads: [pullRead],
      proposal: { ...proposal(), target: pullTarget },
    });
    expect(routes[0]).toMatchObject({ route: 'act', snapshot: { headSha: 'a'.repeat(40) } });
  });

  it('drops a pull request target read without a head SHA, and a close of the wrong kind', async () => {
    const badRead = { target: pullTarget, snapshot: SNAP } as unknown as TargetRead;
    expect(
      (await run({ reads: [badRead], proposal: { ...proposal(), target: pullTarget } }))[0],
    ).toMatchObject({ route: 'drop', reason: 'snapshot does not match the target kind' });
    const issueClose: BrokerAction = {
      type: 'issue.close',
      repo: REPO,
      issue: 7,
      body: 'Closing.',
      stateReason: 'completed',
    };
    const pullRead: TargetRead = { target: pullTarget, snapshot: PULL_SNAP };
    const routes = await run({
      reads: [pullRead],
      policy: policyWith(agent({ actions: ['issue.comment', 'issue.close'] })),
      proposal: { ...proposal(), target: pullTarget, actions: [issueClose] },
    });
    expect(routes[0]).toMatchObject({
      route: 'drop',
      reason: 'closing action does not match the target kind',
    });
  });

  it("drops an action the policy does not grant, with the broker's own reason", async () => {
    const close: BrokerAction = { type: 'pr.close', repo: REPO, pull: 7, body: 'x' };
    const r = await run({ proposal: proposal({ actions: [close] }) });
    expect(r[0]).toMatchObject({ route: 'drop', reason: 'action pr.close not allowed' });
  });

  it('drops a retired action even if a policy lists it', async () => {
    const review: BrokerAction = {
      type: 'pr.review',
      repo: REPO,
      pull: 7,
      event: 'APPROVE',
      body: 'x',
    };
    const r = await run({
      policy: policyWith(agent({ actions: ['issue.comment', 'issue.label.add', 'pr.review'] })),
      proposal: proposal({ actions: [review] }),
    });
    expect(r[0]).toMatchObject({ route: 'drop', reason: 'action pr.review is retired' });
  });

  it('drops a label outside the allow-list, such as an automation trigger', async () => {
    const trigger: BrokerAction = { ...label, labels: ['docs', 'custodes_cheatsheet_review'] };
    const routes = await run({ proposal: proposal({ actions: [label, trigger] }) });
    expect(routes.map((r) => r.route)).toEqual(['act', 'drop']);
    expect(routes[1]).toMatchObject({ reason: 'label custodes_cheatsheet_review not allowed' });
  });

  it('refuses an ungranted trigger label with the broker reason, whatever its case (ADR 0024)', async () => {
    const trigger: BrokerAction = { ...label, labels: ['Custodes_CheatSheet_Review'] };
    const routes = await run({
      policy: policyWith(agent({ labels: ['docs', 'Custodes_CheatSheet_Review'] })),
      proposal: proposal({ actions: [trigger] }),
    });
    expect(routes[0]).toMatchObject({
      route: 'drop',
      reason: 'label Custodes_CheatSheet_Review starts automation',
    });
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

  it('caps hotl writes per run tree and raises the rest to approval', async () => {
    const r = await run({
      proposal: proposal({ actions: [label, comment] }),
      takeHotlSlot: slots(MAX_HOTL_WRITES_PER_TREE - 1),
    });
    expect(r.map((x) => x.route)).toEqual(['act', 'approval']);
  });

  it('a child after ten tree-wide writes gets approval, whatever its own count', async () => {
    const tree = slots();
    for (let i = 0; i < MAX_HOTL_WRITES_PER_TREE; i++)
      expect((await run({ takeHotlSlot: tree }))[0]?.route).toBe('act');
    expect((await run({ takeHotlSlot: tree }))[0]?.route).toBe('approval');
  });

  it('only reports in shadow, for a readonly agent, or without a policy entry', async () => {
    expect((await run({ shadow: true }))[0]?.route).toBe('digest');
    expect((await run({ policy: policyWith(agent({ mode: 'readonly' })) }))[0]?.route).toBe(
      'digest',
    );
    expect((await run({ agentId: 'unknown' }))[0]?.route).toBe('digest');
  });

  it('applies the policy, label and evidence checks in shadow too, so the digest is what live would do', async () => {
    expect((await run({ shadow: true, reads: [] }))[0]?.route).toBe('drop');
    const trigger: BrokerAction = { ...label, labels: ['custodes_cheatsheet_review'] };
    expect(
      (await run({ shadow: true, proposal: proposal({ actions: [trigger] }) }))[0]?.route,
    ).toBe('drop');
    const bad: EvidenceChecker = () => Promise.resolve({ ok: false, reason: 'PR #12 is open' });
    expect((await run({ shadow: true, checkEvidence: bad }))[0]).toMatchObject({
      route: 'drop',
      reason: 'PR #12 is open',
    });
  });

  it('checks the run guard before routing and before each direct write (a killed tree never routes to act)', async () => {
    const killed = () => Promise.reject(new Error('run killed'));
    await expect(run({ guard: killed })).rejects.toThrow('run killed');
    let calls = 0;
    const killAfterFirst = () => (++calls > 1 ? Promise.reject(new Error('run killed')) : noop());
    await expect(run({ guard: killAfterFirst })).rejects.toThrow('run killed');
    // The approval route needs no guard: the broker checks halts before an approval runs.
    calls = 0;
    expect(
      (await run({ guard: killAfterFirst, proposal: proposal({ needsHuman: true }) }))[0]?.route,
    ).toBe('approval');
  });
});
