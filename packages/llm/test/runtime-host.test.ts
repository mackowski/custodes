/**
 * The runtime host (ADR 0023, slice 3): read tools from the read policy, the broker-backed evidence
 * checker, and a whole tree run with a scripted model through the real loop, dispatcher and store.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { issueThreadFrom, RunStore, type SqlLike } from '@custodes/core';
import {
  AgentDefinition,
  Policy,
  type BrokerAction,
  type BrokerReadRequest,
  type Proposal,
} from '@custodes/schema';
import type { MessagesResponse } from '../src/gateway.js';
import {
  brokerEvidence,
  readTools,
  runAgentTree,
  type BundledAgent,
  type HostPort,
} from '../src/runtime-host.js';

function memorySql(): SqlLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec<T extends Record<string, unknown>>(query: string, ...b: (string | number | null)[]) {
      const st = db.prepare(query);
      const rows = st.columns().length > 0 ? (st.all(...b) as T[]) : (st.run(...b), []);
      return { toArray: () => rows };
    },
  };
}

const REPO = 'mackowski/custodes-sandbox';
const ISSUE = {
  number: 7,
  state: 'open',
  user: { login: 'author' },
  labels: [],
  assignees: [],
  comments: 1,
  updated_at: '2026-11-25T10:00:00Z',
};
const COMMENTS = [{ id: 1, updated_at: '2026-11-25T10:00:00Z', user: { login: 'carol' } }];

type ReadReq = Omit<BrokerReadRequest, 'agentId' | 'runId'>;
/** A fake broker read: issue 7 with one comment, a timeline and pull 12 as configured. */
function fakeRead(opts: { merged?: boolean; crossRef?: boolean; fail?: string } = {}) {
  const calls: (ReadReq & { runId: string })[] = [];
  const read = (runId: string, req: ReadReq) => {
    calls.push({ ...req, runId });
    if (opts.fail === req.resource) return Promise.resolve({ ok: false as const, reason: 'x' });
    const data =
      req.resource === 'issue'
        ? ISSUE
        : req.resource === 'comments'
          ? COMMENTS
          : req.resource === 'timeline'
            ? opts.crossRef === false
              ? []
              : [{ event: 'cross-referenced', source: { issue: { number: 12, pull_request: {} } } }]
            : req.resource === 'pull'
              ? { number: 12, merged_at: opts.merged === false ? null : '2026-11-24T10:00:00Z' }
              : [];
    return Promise.resolve({ ok: true as const, data });
  };
  return { read, calls };
}

describe('readTools', () => {
  it('offers only what the read policy grants and the agent.md lists', () => {
    const { read } = fakeRead();
    const tools = readTools({ repos: [REPO], resources: ['issue', 'comments'], read }, 'r', [
      'issue',
      'cheatsheet_search',
      'timeline',
    ]);
    expect(tools.map((t) => t.name)).toEqual(['issue']);
  });

  it('reads an issue with its comments and names the target with the broker snapshot', async () => {
    const { read } = fakeRead();
    const [issue] = readTools({ repos: [REPO], resources: ['issue', 'comments'], read }, 'r', [
      'issue',
    ]);
    const out = await issue!.run({ repo: REPO, number: 7 });
    const thread = await issueThreadFrom(ISSUE, COMMENTS);
    if (!thread.ok) throw new Error('fixture');
    expect(out.read).toEqual({
      target: { repo: REPO, kind: 'issue', number: 7 },
      snapshot: thread.snapshot,
    });
  });

  it('names no target when the comments cannot be read', async () => {
    const { read } = fakeRead({ fail: 'comments' });
    const [issue] = readTools({ repos: [REPO], resources: ['issue', 'comments'], read }, 'r', [
      'issue',
    ]);
    const out = await issue!.run({ repo: REPO, number: 7 });
    expect(out.read).toBeUndefined();
    expect(out.content).toBe('read failed: x');
  });

  it('refuses a repository outside the read policy', () => {
    const { read } = fakeRead();
    const [issue] = readTools({ repos: [REPO], resources: ['issue'], read }, 'r', ['issue']);
    expect(issue!.args.safeParse({ repo: 'evil/repo', number: 7 }).success).toBe(false);
  });
});

const close: BrokerAction = {
  type: 'issue.close',
  repo: REPO,
  issue: 7,
  body: 'Fixed in #12.',
  stateReason: 'completed',
};
const proposalWith = (evidence: Proposal['evidence']): Proposal => ({
  target: { repo: REPO, kind: 'issue', number: 7 },
  actions: [close],
  evidence,
  reason: 'fixed',
  needsHuman: false,
});

describe('brokerEvidence (never ok by default for issue.close)', () => {
  const check = (opts: Parameters<typeof fakeRead>[0], evidence: Proposal['evidence']) => {
    const { read } = fakeRead(opts);
    return brokerEvidence((req) => read('r', req))(close, proposalWith(evidence));
  };
  const merged = [{ type: 'merged_pr' as const, ref: '#12' }];

  it('passes a merged pull request that references the issue', async () => {
    expect(await check({}, merged)).toEqual({ ok: true });
  });
  it('refuses a close with no merged_pr evidence, or another kind only', async () => {
    expect((await check({}, [])).ok).toBe(false);
    expect((await check({}, [{ type: 'review', ref: '#12' }])).ok).toBe(false);
  });
  it('refuses an open pull request, one that does not reference the issue, or a failed read', async () => {
    expect((await check({ merged: false }, merged)).ok).toBe(false);
    expect((await check({ crossRef: false }, merged)).ok).toBe(false);
    expect((await check({ fail: 'timeline' }, merged)).ok).toBe(false);
    expect((await check({ fail: 'pull' }, merged)).ok).toBe(false);
  });
  it('needs nothing for an action without evidence rules', async () => {
    const { read } = fakeRead();
    const comment: BrokerAction = { type: 'issue.comment', repo: REPO, issue: 7, body: 'hi' };
    expect(await brokerEvidence((req) => read('r', req))(comment, proposalWith([]))).toEqual({
      ok: true,
    });
  });
});

const policyFor = (mode: 'hotl' | 'hitl') =>
  Policy.parse({
    version: 1,
    agents: {
      'backlog-review': {
        tokenBinding: 'PAT_BACKLOG_REVIEW',
        mode,
        tier: 'T1',
        repos: [REPO],
        actions: ['issue.comment', 'issue.label.add'],
        labels: ['question'],
      },
    },
  });

const definition = (over: Partial<AgentDefinition> = {}) =>
  AgentDefinition.parse({
    id: 'backlog-review',
    tier: 'T1',
    triggers: ['manual'],
    model: 'claude-sonnet-5-5',
    tools: ['issue'],
    outputSchema: 'ProposalList',
    budget: { roundsPerRun: 5, usdPerRun: 0.15, usdPerDay: 3 },
    ...over,
  });

const answer = (text: string, i: number): MessagesResponse => ({
  id: `m${String(i)}`,
  model: 'claude-sonnet-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text }],
  usage: { input_tokens: 10, output_tokens: 10 },
});
const toolUse = (name: string, input: unknown, i: number): MessagesResponse => ({
  id: `m${String(i)}`,
  model: 'claude-sonnet-5-5',
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `t${String(i)}`, name, input }],
  usage: { input_tokens: 10, output_tokens: 10 },
});

const commentOn7: BrokerAction = { type: 'issue.comment', repo: REPO, issue: 7, body: 'Thanks.' };
const proposalOn7 = {
  target: { repo: REPO, kind: 'issue', number: 7 },
  actions: [commentOn7],
  evidence: [],
  reason: 'stale',
  needsHuman: false,
};

/** A port over a memory store and a scripted model; records every write and approval. */
function port(mode: 'hotl' | 'hitl', script: MessagesResponse[]) {
  const store = new RunStore(memorySql());
  const { read } = fakeRead();
  const acts: { action: BrokerAction; runId: string; snapshot: unknown }[] = [];
  const bundles: { runId: string; actions: string[] }[] = [];
  let i = 0;
  const p: HostPort = {
    agentId: 'backlog-review',
    policy: policyFor(mode),
    repos: [REPO],
    resources: ['issue', 'comments'],
    store,
    brokerGuard: () => Promise.resolve(),
    read,
    send: () => {
      const next = script[i++];
      if (!next) throw new Error('script ran out');
      return Promise.resolve(next);
    },
    costOf: () => 0.001,
    act: (action, runId, snapshot) => {
      acts.push({ action, runId, snapshot });
      return Promise.resolve({ ok: true, attestationId: crypto.randomUUID() });
    },
    requestBundle: (bundle, _r, runId) => {
      bundles.push({ runId, actions: bundle.actions.map((a) => a.type) });
      return Promise.resolve({ ok: true });
    },
    requestApproval: () => Promise.resolve({ ok: true }),
  };
  return { p, store, acts, bundles };
}

const agent = (def = definition()): BundledAgent => ({ definition: def, prompt: 'Review.' });

describe('runAgentTree', () => {
  it('reads, proposes and writes hotl with the snapshot it read and the store run id', async () => {
    const { p, acts } = port('hotl', [
      toolUse('issue', { repo: REPO, number: 7 }, 0),
      answer(JSON.stringify({ proposals: [proposalOn7] }), 1),
    ]);
    const r = await runAgentTree(p, agent(), {}, 'Review the backlog.', { shadow: false });
    expect(r.status).toBe('done');
    expect(acts).toHaveLength(1);
    expect(acts[0]?.runId).toBe(r.rootRunId);
    expect(acts[0]?.snapshot).toMatchObject({ comments: 1, state: 'open' });
    expect(r.outcomes).toEqual([
      expect.objectContaining({ route: 'act', detail: 'ok', action: 'issue.comment' }),
    ]);
  });

  it('asks for one bundle approval under a hitl policy, and only reports in shadow', async () => {
    const script = () => [
      toolUse('issue', { repo: REPO, number: 7 }, 0),
      answer(JSON.stringify({ proposals: [proposalOn7] }), 1),
    ];
    const hitl = port('hitl', script());
    await runAgentTree(hitl.p, agent(), {}, 'Review.', { shadow: false });
    expect(hitl.acts).toEqual([]);
    expect(hitl.bundles.map((b) => b.actions)).toEqual([['issue.comment']]);

    const shadow = port('hotl', script());
    const r = await runAgentTree(shadow.p, agent(), {}, 'Review.', { shadow: true });
    expect(shadow.acts).toEqual([]);
    expect(r.digest).toHaveLength(1);
  });

  it('checks the run guard again right before a write: a tree killed after routing never acts', async () => {
    const { p, store, acts } = port('hotl', [
      toolUse('issue', { repo: REPO, number: 7 }, 0),
      answer(JSON.stringify({ proposals: [proposalOn7] }), 1),
    ]);
    // The operator kills the run the moment the dispatcher has routed the write.
    vi.spyOn(store, 'takeHotlSlot').mockImplementation((runId) => {
      store.kill(runId);
      return true;
    });
    const r = await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(acts).toEqual([]);
    expect(r).toMatchObject({ status: 'stopped', stop: 'halted' });
    expect(r.outcomes).toEqual([expect.objectContaining({ route: 'act', detail: 'halted' })]);
  });

  it('delegates an item to a child role, whose proposal is routed under the child run', async () => {
    const child = agent(
      definition({
        id: 'item-review',
        outputSchema: 'Proposal',
        budget: { roundsPerRun: 5, usdPerRun: 0.15, usdPerDay: 3 },
      }),
    );
    const root = agent(definition({ tools: ['issue', 'delegate'], agents: ['item-review'] }));
    const { p, acts, store } = port('hotl', [
      toolUse(
        'delegate',
        { role: 'item-review', target: { repo: REPO, kind: 'issue', number: 7 } },
        0,
      ),
      toolUse('issue', { repo: REPO, number: 7 }, 1),
      answer(JSON.stringify(proposalOn7), 2),
      answer(JSON.stringify({ proposals: [] }), 3),
    ]);
    const r = await runAgentTree(p, root, { 'item-review': child }, 'Review.', { shadow: false });
    expect(r.status).toBe('done');
    expect(acts).toHaveLength(1);
    const childRun = store.get(acts[0]!.runId);
    expect(childRun?.parentRunId).toBe(r.rootRunId);
  });
});
