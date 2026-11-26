/**
 * The runtime host (ADR 0023, slice 3): read tools from the read policy, the broker-backed evidence
 * checker, and a whole tree run with a scripted model through the real loop, dispatcher and store.
 */
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { issueThreadFrom, MAX_HOTL_WRITES_PER_TREE, RunStore, type SqlLike } from '@custodes/core';
import {
  AgentDefinition,
  BacklogVerdict,
  Policy,
  type BrokerAction,
  type BrokerReadRequest,
  type BrokerResponse,
  Proposal,
} from '@custodes/schema';
import type { MessagesResponse } from '../src/gateway.js';
import { PRICES_USD_PER_MTOK } from '../src/prices.js';
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
function fakeRead(
  opts: {
    merged?: boolean;
    crossRef?: boolean;
    fail?: string;
    /** The merged PR's own text; by default it names the issue. */
    prBody?: string;
    /** The cross-reference's repository; `null` leaves it out. */
    refRepo?: string | null;
    /** When the cross-reference was made; `null` leaves it out. Default: before the merge. */
    refAt?: string | null;
  } = {},
) {
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
              : [
                  {
                    event: 'cross-referenced',
                    ...(opts.refAt === null
                      ? {}
                      : { created_at: opts.refAt ?? '2026-11-23T10:00:00Z' }),
                    source: {
                      issue: {
                        number: 12,
                        pull_request: {},
                        ...(opts.refRepo === null
                          ? {}
                          : { repository: { full_name: opts.refRepo ?? REPO } }),
                      },
                    },
                  },
                ]
            : req.resource === 'pull'
              ? {
                  number: 12,
                  title: 'Fix the cheat sheet',
                  body: opts.prBody ?? 'Fixes #7.',
                  merged_at: opts.merged === false ? null : '2026-11-24T10:00:00Z',
                }
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

  it('gives the model compact fields, not GitHub JSON with users and URLs (lean 4)', async () => {
    const raw = {
      ...ISSUE,
      title: 'Typo',
      body: 'Body text',
      html_url: 'https://github.com/x',
      user: { login: 'author', avatar_url: 'https://avatars/x', type: 'User' },
    };
    const read = (_runId: string, req: ReadReq) =>
      Promise.resolve({
        ok: true as const,
        data:
          req.resource === 'issue'
            ? raw
            : COMMENTS.map((c) => ({ ...c, body: 'latest', user: { ...c.user, url: 'u' } })),
      });
    const [issue] = readTools({ repos: [REPO], resources: ['issue', 'comments'], read }, 'r', [
      'issue',
    ]);
    const out = await issue!.run({ repo: REPO, number: 7 });
    expect(out.content).not.toContain('avatar_url');
    expect(out.content).not.toContain('html_url');
    const parsed = JSON.parse(out.content) as {
      issue: { number: unknown; title: unknown; author: unknown; body: unknown };
      comments: unknown[];
    };
    expect(parsed.issue).toMatchObject({
      number: 7,
      title: 'Typo',
      author: 'author',
      body: 'Body text',
    });
    expect(parsed.comments).toEqual([
      { author: 'carol', author_association: null, created_at: null, body: 'latest' },
    ]);
    // The snapshot is still built from the raw data.
    const thread = await issueThreadFrom(raw, COMMENTS);
    if (!thread.ok) throw new Error('fixture');
    expect(out.read?.snapshot).toEqual(thread.snapshot);
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
  it("refuses an outsider's cross-reference: the merged PR's own text must name the issue (M2)", async () => {
    // Anyone can comment "#7" on an old merged PR; that PR's own text does not name issue 7.
    expect((await check({ prBody: 'Unrelated docs fix.' }, merged)).ok).toBe(false);
    // #70 and other/repo#7 are not issue 7 of this repository.
    expect((await check({ prBody: 'Fixes #70.' }, merged)).ok).toBe(false);
    expect((await check({ prBody: 'Fixes other/repo#7.' }, merged)).ok).toBe(false);
    expect((await check({ prBody: `Fixes ${REPO}#7.` }, merged)).ok).toBe(true);
  });
  it('needs the reference to predate the merge: a later edit of a merged PR does not count', async () => {
    expect((await check({ refAt: '2026-11-25T10:00:00Z' }, merged)).ok).toBe(false);
    expect((await check({ refAt: null }, merged)).ok).toBe(false);
    expect((await check({ refAt: 'not a date' }, merged)).ok).toBe(false);
    expect((await check({ refAt: '2026-11-24T10:00:00Z' }, merged)).ok).toBe(true);
  });
  it('does not take a longer owner name as this repository (owner boundary)', async () => {
    expect((await check({ prBody: `Fixes evil-${REPO}#7.` }, merged)).ok).toBe(false);
    expect((await check({ prBody: `Fixes a.${REPO}#7.` }, merged)).ok).toBe(false);
  });

  it('fails closed when the cross-reference names no repository, or another one (M2)', async () => {
    expect((await check({ refRepo: null }, merged)).ok).toBe(false);
    expect((await check({ refRepo: 'other/repo' }, merged)).ok).toBe(false);
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
function port(
  mode: 'hotl' | 'hitl',
  script: MessagesResponse[],
  opts: { actThrows?: boolean; actResults?: BrokerResponse[] } = {},
) {
  const store = new RunStore(memorySql());
  const { read } = fakeRead();
  const acts: { action: BrokerAction; runId: string; snapshot: unknown }[] = [];
  const bundles: { runId: string; actions: string[] }[] = [];
  const approvalsAsked: { action: BrokerAction; runId: string; snapshot: unknown }[] = [];
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
    act: (action, runId, snapshot) => {
      if (opts.actThrows) return Promise.reject(new Error('broker down: secret-ish detail'));
      acts.push({ action, runId, snapshot });
      const scripted = opts.actResults?.[acts.length - 1];
      return Promise.resolve(scripted ?? { ok: true, attestationId: crypto.randomUUID() });
    },
    requestBundle: (bundle, _r, runId) => {
      bundles.push({ runId, actions: bundle.actions.map((a) => a.type) });
      return Promise.resolve({ ok: true });
    },
    requestApproval: (action, _r, runId, snapshot) => {
      approvalsAsked.push({ action, runId, snapshot });
      return Promise.resolve({ ok: true });
    },
  };
  return { p, store, acts, bundles, approvalsAsked };
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

  it('reads a role answer through the child hook: Proposal fields to the dispatcher, the verdict to onResult (#132)', async () => {
    const child = agent(definition({ id: 'item-review', outputSchema: 'BacklogVerdict' }));
    const root = agent(definition({ tools: ['issue', 'delegate'], agents: ['item-review'] }));
    const verdict = {
      ...proposalOn7,
      state: 'waiting_author',
      confidence: 'medium',
      uncertainBecause: [],
    };
    const { p, acts, approvalsAsked } = port('hotl', [
      toolUse(
        'delegate',
        { role: 'item-review', target: { repo: REPO, kind: 'issue', number: 7 } },
        0,
      ),
      toolUse('issue', { repo: REPO, number: 7 }, 1),
      answer(JSON.stringify(verdict), 2),
      answer(JSON.stringify({ proposals: [] }), 3),
    ]);
    const results: unknown[] = [];
    const r = await runAgentTree(p, root, { 'item-review': child }, 'Review.', {
      shadow: true,
      child: {
        schema: BacklogVerdict,
        raiseNeedsHuman: (v) => (v as BacklogVerdict).confidence !== 'high',
        onResult: (x) => {
          results.push(x);
        },
      },
    });
    expect(r.status).toBe('done');
    expect(acts).toEqual([]);
    expect(approvalsAsked).toEqual([]);
    // hotl policy, but medium confidence raised needsHuman: live it would be an approval.
    expect(r.outcomes).toEqual([
      expect.objectContaining({ route: 'digest', detail: 'digest', live: 'approval' }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        ok: true,
        output: expect.objectContaining({
          state: 'waiting_author',
          confidence: 'medium',
        }) as unknown,
        outcomes: [expect.objectContaining({ live: 'approval' })],
      }),
    ]);
  });

  it('refuses a child answer about another item than it was given (reviews of #168)', async () => {
    const child = agent(definition({ id: 'item-review', outputSchema: 'Proposal' }));
    const root = agent(definition({ tools: ['issue', 'delegate'], agents: ['item-review'] }));
    const on9: BrokerAction = { ...commentOn7, issue: 9 };
    const about9 = {
      ...proposalOn7,
      target: { repo: REPO, kind: 'issue', number: 9 },
      actions: [on9],
    };
    const { p, acts } = port('hotl', [
      toolUse(
        'delegate',
        { role: 'item-review', target: { repo: REPO, kind: 'issue', number: 7 } },
        0,
      ),
      toolUse('issue', { repo: REPO, number: 7 }, 1),
      toolUse('issue', { repo: REPO, number: 9 }, 2),
      answer(JSON.stringify(about9), 3),
      answer(JSON.stringify({ proposals: [] }), 4),
    ]);
    const results: unknown[] = [];
    const r = await runAgentTree(p, root, { 'item-review': child }, 'Review.', {
      shadow: false,
      child: { schema: Proposal, onResult: (x) => void results.push(x) },
    });
    expect(acts).toEqual([]);
    expect(r.outcomes).toEqual([]);
    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        stop: 'invalid_output',
        target: expect.objectContaining({ number: 7 }) as unknown,
      }),
    ]);
  });

  it('starts no child for a target the agent did not allow (security review of #168, L1)', async () => {
    const child = agent(definition({ id: 'item-review', outputSchema: 'Proposal' }));
    const root = agent(definition({ tools: ['issue', 'delegate'], agents: ['item-review'] }));
    const { p, store } = port('hotl', [
      toolUse(
        'delegate',
        { role: 'item-review', target: { repo: REPO, kind: 'issue', number: 9 } },
        0,
      ),
      answer(JSON.stringify({ proposals: [] }), 1),
    ]);
    const r = await runAgentTree(p, root, { 'item-review': child }, 'Review.', {
      shadow: false,
      allowTarget: (t) => t.number === 7,
    });
    expect(r.status).toBe('done');
    // Only the root run exists: no child was started for #9.
    expect(store.spentSince('backlog-review', '1970-01-01T00:00:00Z')).toBeGreaterThan(0);
    expect(store.listEvents(r.rootRunId).every((e) => e.parentRunId === null)).toBe(true);
  });

  it('reports a child whose answer fails the hook schema as stopped, and routes nothing (#132)', async () => {
    const child = agent(definition({ id: 'item-review', outputSchema: 'BacklogVerdict' }));
    const root = agent(definition({ tools: ['issue', 'delegate'], agents: ['item-review'] }));
    // A plain Proposal has no state: it fails BacklogVerdict on every attempt.
    const bad = (i: number) => answer(JSON.stringify(proposalOn7), i);
    const { p, acts } = port('hotl', [
      toolUse(
        'delegate',
        { role: 'item-review', target: { repo: REPO, kind: 'issue', number: 7 } },
        0,
      ),
      toolUse('issue', { repo: REPO, number: 7 }, 1),
      bad(2),
      bad(3),
      bad(4),
      answer(JSON.stringify({ proposals: [] }), 5),
    ]);
    const results: { ok: boolean }[] = [];
    const r = await runAgentTree(p, root, { 'item-review': child }, 'Review.', {
      shadow: false,
      child: { schema: BacklogVerdict, onResult: (x) => void results.push(x) },
    });
    expect(acts).toEqual([]);
    expect(r.outcomes).toEqual([]);
    expect(results).toEqual([expect.objectContaining({ ok: false })]);
  });

  it('takes each HOTL slot on its own run with the tree-wide cap (re-review of #166)', async () => {
    const { p, store } = port('hotl', [
      toolUse('issue', { repo: REPO, number: 7 }, 0),
      answer(JSON.stringify({ proposals: [proposalOn7] }), 1),
    ]);
    const slot = vi.spyOn(store, 'takeHotlSlot');
    const r = await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(slot).toHaveBeenCalledWith(r.rootRunId, MAX_HOTL_WRITES_PER_TREE);
  });

  it('a store that already spent the daily budget stops the tree before any model call', async () => {
    const { p, store } = port('hotl', []);
    const send = vi.fn();
    p.send = send;
    store.addSpend(store.start('backlog-review'), 3);
    const r = await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(send).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 'stopped', stop: 'budget' });
  });

  it('prices a child role at its own model, not the root model (security review M1)', async () => {
    const prices = PRICES_USD_PER_MTOK as Record<string, { input: number; output: number }>;
    prices['test-pricey'] = { input: 1000, output: 1000 };
    try {
      const child = agent(
        definition({ id: 'item-review', model: 'test-pricey', outputSchema: 'Proposal' }),
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
      const r = await runAgentTree(p, root, { 'item-review': child }, 'Review.', {
        shadow: false,
      });
      // Two child rounds of 10 + 10 tokens at $1000/MTok; two root rounds at Sonnet rates.
      expect(store.get(acts[0]!.runId)?.spentUsd).toBeCloseTo(0.04, 10);
      expect(store.get(r.rootRunId)?.spentUsd).toBeCloseTo(2 * 120e-6, 10);
    } finally {
      delete prices['test-pricey'];
    }
  });

  it('refuses a tree with an unpriced model before any model call (security review M1)', async () => {
    const send = vi.fn();
    const { p, store } = port('hotl', []);
    p.send = send;
    const child = agent(
      definition({ id: 'item-review', model: 'claude-unpriced', outputSchema: 'Proposal' }),
    );
    const root = agent(definition({ tools: ['issue', 'delegate'], agents: ['item-review'] }));
    await expect(
      runAgentTree(p, root, { 'item-review': child }, 'Review.', { shadow: false }),
    ).rejects.toThrow(/no price for model claude-unpriced/);
    expect(send).not.toHaveBeenCalled();
    expect(store.spentSince('backlog-review', '1970-01-01T00:00:00Z')).toBe(0);
  });

  it('writes a two-action hotl proposal in bundle order, the snapshot on the first only (L1)', async () => {
    const label: BrokerAction = {
      type: 'issue.label.add',
      repo: REPO,
      issue: 7,
      labels: ['question'],
    };
    const two = { ...proposalOn7, actions: [commentOn7, label] };
    const { p, acts } = port('hotl', [
      toolUse('issue', { repo: REPO, number: 7 }, 0),
      answer(JSON.stringify({ proposals: [two] }), 1),
    ]);
    const r = await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(acts.map((a) => a.action.type)).toEqual(['issue.label.add', 'issue.comment']);
    expect(acts[0]?.snapshot).toBeDefined();
    expect(acts[1]?.snapshot).toBeUndefined();
    expect(r.outcomes.map((o) => o.detail)).toEqual(['ok', 'ok']);
  });

  it('a throwing model ends the run as an error, not the whole tree result (lean 3)', async () => {
    const { p, store } = port('hotl', []); // the script is empty: send throws
    const r = await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(r).toMatchObject({ status: 'stopped', stop: 'error' });
    expect(JSON.stringify(r)).not.toContain('script ran out');
    expect(store.get(r.rootRunId)?.status).toBe('stopped');
  });

  it('a throwing write halts the tree and records an error outcome without its text (lean 3)', async () => {
    const { p } = port(
      'hotl',
      [
        toolUse('issue', { repo: REPO, number: 7 }, 0),
        answer(JSON.stringify({ proposals: [proposalOn7] }), 1),
      ],
      { actThrows: true },
    );
    const r = await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(r).toMatchObject({ status: 'stopped', stop: 'halted' });
    expect(r.outcomes).toEqual([expect.objectContaining({ route: 'act', detail: 'error' })]);
    expect(JSON.stringify(r)).not.toContain('secret-ish');
  });

  it('a child whose read throws stops as an error and the parent keeps going (lean 3)', async () => {
    const child = agent(
      definition({
        id: 'item-review',
        outputSchema: 'Proposal',
        budget: { roundsPerRun: 5, usdPerRun: 0.15, usdPerDay: 3 },
      }),
    );
    const root = agent(definition({ tools: ['issue', 'delegate'], agents: ['item-review'] }));
    const { p } = port('hotl', [
      toolUse(
        'delegate',
        { role: 'item-review', target: { repo: REPO, kind: 'issue', number: 7 } },
        0,
      ),
      toolUse('issue', { repo: REPO, number: 7 }, 1),
      answer(JSON.stringify({ proposals: [] }), 2),
    ]);
    // The child's issue read throws; the root's script continues with its own answer.
    const read = p.read;
    let n = 0;
    p.read = (runId, req) => {
      if (req.resource === 'issue' && n++ === 0) return Promise.reject(new Error('boom'));
      return read(runId, req);
    };
    const r = await runAgentTree(p, root, { 'item-review': child }, 'Review.', { shadow: false });
    expect(r.status).toBe('done');
  });

  it('stops at the first direct write that is not ok: later ones are never called', async () => {
    const label: BrokerAction = {
      type: 'issue.label.add',
      repo: REPO,
      issue: 7,
      labels: ['question'],
    };
    const two = { ...proposalOn7, actions: [commentOn7, label] };
    const { p, acts } = port(
      'hotl',
      [
        toolUse('issue', { repo: REPO, number: 7 }, 0),
        answer(JSON.stringify({ proposals: [two] }), 1),
      ],
      { actResults: [{ ok: false, code: 'policy_denied', reason: 'x' }] },
    );
    const r = await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(acts).toHaveLength(1);
    expect(r.outcomes.map((o) => o.detail)).toEqual(['policy_denied', 'not run']);
  });

  it('asks each approval with the route snapshot', async () => {
    // Two approvals that cannot form a bundle (the same type twice) are asked one by one.
    const again: BrokerAction = { ...commentOn7, body: 'Second.' };
    const two = { ...proposalOn7, actions: [commentOn7, again] };
    const { p, approvalsAsked, bundles } = port('hitl', [
      toolUse('issue', { repo: REPO, number: 7 }, 0),
      answer(JSON.stringify({ proposals: [two] }), 1),
    ]);
    await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(bundles).toEqual([]);
    expect(approvalsAsked).toHaveLength(2);
    for (const a of approvalsAsked)
      expect(a.snapshot).toMatchObject({ state: 'open', comments: 1 });
  });

  it('does not ask approvals on a target the same proposal already wrote to', async () => {
    // hotl policy where issue.label.add needs an approval: the comment acts, the label would be stale.
    const pol = Policy.parse({
      version: 1,
      agents: {
        'backlog-review': {
          tokenBinding: 'PAT_BACKLOG_REVIEW',
          mode: 'hotl',
          tier: 'T1',
          repos: [REPO],
          actions: ['issue.comment', 'issue.label.add'],
          requiresApproval: ['issue.label.add'],
          labels: ['question'],
        },
      },
    });
    const label: BrokerAction = {
      type: 'issue.label.add',
      repo: REPO,
      issue: 7,
      labels: ['question'],
    };
    const two = { ...proposalOn7, actions: [commentOn7, label] };
    const { p, acts, approvalsAsked, bundles } = port('hotl', [
      toolUse('issue', { repo: REPO, number: 7 }, 0),
      answer(JSON.stringify({ proposals: [two] }), 1),
    ]);
    p.policy = pol;
    const r = await runAgentTree(p, agent(), {}, 'Review.', { shadow: false });
    expect(acts.map((a) => a.action.type)).toEqual(['issue.comment']);
    expect(approvalsAsked).toEqual([]);
    expect(bundles).toEqual([]);
    expect(r.outcomes.find((o) => o.action === 'issue.label.add')?.detail).toBe('not requested');
  });

  it('caps each body in the compact read at 4000 characters and keeps author_association', async () => {
    const raw = { ...ISSUE, title: 'T', body: 'y'.repeat(5_000), author_association: 'MEMBER' };
    const read = (_runId: string, req: ReadReq) =>
      Promise.resolve({ ok: true as const, data: req.resource === 'issue' ? raw : [] });
    const [issue] = readTools({ repos: [REPO], resources: ['issue', 'comments'], read }, 'r', [
      'issue',
    ]);
    const out = await issue!.run({ repo: REPO, number: 7 });
    const parsed = JSON.parse(out.content) as {
      issue: { body: string; author_association: string };
    };
    expect(parsed.issue.author_association).toBe('MEMBER');
    expect(parsed.issue.body.startsWith('y'.repeat(4_000))).toBe(true);
    expect(parsed.issue.body).toContain('1000 characters cut');
  });
});
