import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BacklogVerdict } from '@custodes/schema';
import { raisesToHuman, SHADOW, type BacklogReviewAgent } from '../src/agents/backlog-review.js';
import { backlogAgents, bundle, POLICY } from '../src/agents/backlog-review/bundle.js';
import type { AgentsEnv } from '../src/env.js';
import { SANDBOX_INSTANCE } from '../src/instances.js';
import { testKillSwitch, withHaltState } from './helpers/halt-state.js';

const testEnv = env as AgentsEnv;
const REPO = 'mackowski/custodes-sandbox';
const NOW = new Date('2026-11-26T12:00:00Z');
const DB = () => {
  if (!testEnv.BACKLOG) throw new Error('BACKLOG not bound');
  return testEnv.BACKLOG;
};

/** An accepted, assigned issue: backlog-review's, not triage's. */
const issue = {
  number: 7,
  title: 'Add a note on refresh tokens',
  body: 'Please add it.',
  html_url: `https://github.com/${REPO}/issues/7`,
  state: 'open',
  user: { login: 'reporter' },
  author_association: 'NONE',
  labels: [{ name: 'ACK_OBTAINED' }],
  assignees: [{ login: 'volunteer' }],
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-05T10:00:00Z',
  comments: 0,
};

interface Calls {
  reads: string[];
  writes: string[];
}

/** A broker that lists `open`, reads issue 7 and refuses everything else; records every call. */
/** Reads a test adds on top of the defaults (reset before each test). */
let extraReads: Record<string, unknown> = {};

function fakeBroker(open: unknown[], calls: Calls) {
  return withHaltState({
    fetch: (url: string, init: RequestInit) => {
      if (url !== 'https://broker.internal/v1/read') {
        calls.writes.push(url);
        return Response.json({ ok: false, code: 'policy_denied', reason: 'test' });
      }
      const req = JSON.parse(init.body as string) as { resource: string; number?: number };
      calls.reads.push(req.resource);
      const data: Record<string, unknown> = {
        issues: open,
        issue,
        comments: [],
        timeline: [],
        ...extraReads,
      };
      return Object.hasOwn(data, req.resource)
        ? Response.json({ ok: true, data: data[req.resource] })
        : Response.json({ ok: false, code: 'policy_denied', reason: 'test' });
    },
  });
}

/** A scripted model behind the AI Gateway URL; counts calls. */
function fakeModel(script: unknown[]) {
  const state = { calls: 0 };
  const fetchImpl = ((_u: unknown, _i?: unknown) => {
    const next = script[state.calls++];
    if (next === undefined) return Promise.resolve(new Response('script ran out', { status: 500 }));
    return Promise.resolve(Response.json(next));
  }) as typeof fetch;
  return { fetchImpl, state };
}

const msg = (i: number, content: unknown[], stop = 'tool_use') => ({
  id: `m${String(i)}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  stop_reason: stop,
  content,
  usage: { input_tokens: 100, output_tokens: 50 },
});
const toolUse = (i: number, name: string, input: unknown) =>
  msg(i, [{ type: 'tool_use', id: `t${String(i)}`, name, input }]);
const answer = (i: number, value: unknown) =>
  msg(i, [{ type: 'text', text: JSON.stringify(value) }], 'end_turn');

const verdict: BacklogVerdict = {
  target: { repo: REPO, kind: 'issue', number: 7 },
  actions: [{ type: 'issue.comment', repo: REPO, issue: 7, body: 'Any news on this?' }],
  evidence: [{ type: 'last_activity', ref: '7', at: '2026-10-05T10:00:00Z' }],
  reason: 'Assigned eight weeks ago, no PR and no comment since.',
  needsHuman: false,
  state: 'waiting_author',
  confidence: 'high',
  uncertainBecause: [],
};

interface Internals {
  env: AgentsEnv;
  modelFetch: typeof fetch | undefined;
}

async function inAgent<T>(
  open: unknown[],
  script: unknown[],
  fn: (agent: BacklogReviewAgent, calls: Calls, model: { calls: number }) => Promise<T>,
): Promise<T> {
  const stub = await getAgentByName(testEnv.BacklogReviewAgent!, SANDBOX_INSTANCE);
  return runInDurableObject(stub, async (agent: BacklogReviewAgent) => {
    const i = agent as unknown as Internals;
    const calls: Calls = { reads: [], writes: [] };
    const model = fakeModel(script);
    const original = i.env;
    i.env = Object.create(original, {
      BROKER: { value: fakeBroker(open, calls) },
    }) as AgentsEnv;
    i.modelFetch = model.fetchImpl;
    try {
      return await fn(agent, calls, model.state);
    } finally {
      i.env = original;
      i.modelFetch = undefined;
    }
  });
}

const rows = async () => (await DB().prepare('SELECT * FROM verdicts ORDER BY id').all()).results;
const actionRows = async () =>
  (await DB().prepare('SELECT * FROM verdict_actions ORDER BY verdict_id, position').all()).results;

beforeEach(async () => {
  extraReads = {};
  const sql = await import('../../backlog-review/migrations/0001_verdicts.sql?raw');
  await DB().exec('DROP TABLE IF EXISTS verdict_actions; DROP TABLE IF EXISTS verdicts;');
  for (const stmt of sql.default
    .replace(/--.*$/gm, '')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean))
    await DB().exec(stmt);
});

afterEach(async () => {
  await testKillSwitch().resume('backlog-review');
});

describe('backlog-review (#132 v1)', () => {
  it('is in shadow', () => {
    expect(SHADOW).toBe(true);
  });

  it('bundles the context files and the policy maintainers into the role prompt only', () => {
    const { root, roles } = backlogAgents('OWASP/CheatSheetSeries');
    expect(root.prompt).not.toContain('# Maintainers');
    const item = roles['item-review'];
    expect(item?.prompt).toContain('# Backlog rules for issues');
    expect(item?.prompt).toContain('# Operator preferences');
    for (const m of POLICY.maintainers['OWASP/CheatSheetSeries'] ?? [])
      expect(item?.prompt).toContain(`- ${m}`);
    expect(() =>
      bundle(
        '---\n{"id":"xyz-test","tier":"T0","triggers":["manual"],"model":"claude-sonnet-5-5","tools":["issue"],"context":["context/missing.md"],"outputSchema":"Proposal","budget":{"roundsPerRun":1,"usdPerRun":0.1,"usdPerDay":1}}\n---\nPrompt.',
        REPO,
      ),
    ).toThrow(/no bundled context\/missing.md/);
  });

  it('does nothing while halted', async () => {
    await testKillSwitch().halt('backlog-review', 'test', 'tester');
    await inAgent([issue], [], async (agent, calls, model) => {
      const r = await agent.review({ kind: 'manual' }, NOW);
      expect(r.ok).toBe(false);
      expect(calls.reads).toEqual([]);
      expect(model.calls).toBe(0);
    });
  });

  it('calls no model when nothing is due', async () => {
    const triageOwned = { ...issue, number: 8, labels: [{ name: 'ACK_WAITING' }], assignees: [] };
    await inAgent([triageOwned], [], async (agent, _calls, model) => {
      const r = await agent.review({ kind: 'manual' }, NOW);
      expect(r).toMatchObject({ ok: true, detail: 'nothing due', selected: 0 });
      expect(model.calls).toBe(0);
    });
    expect(await rows()).toEqual([]);
  });

  it('records a verdict and its digest route in D1, and writes nothing to GitHub', async () => {
    const script = [
      toolUse(0, 'delegate', {
        role: 'item-review',
        target: { repo: REPO, kind: 'issue', number: 7 },
      }),
      toolUse(1, 'issue', { repo: REPO, number: 7 }),
      answer(2, verdict),
      answer(3, { proposals: [] }),
    ];
    await inAgent([issue], script, async (agent, calls, model) => {
      const r = await agent.review({ kind: 'manual' }, NOW);
      expect(r).toMatchObject({ ok: true, selected: 1 });
      expect(model.calls).toBe(4);
      expect(calls.writes).toEqual([]);
    });
    const [v] = await rows();
    expect(v).toMatchObject({
      repo: REPO,
      issue: 7,
      issue_updated_at: issue.updated_at,
      status: 'ok',
      state: 'waiting_author',
      confidence: 'high',
      needs_human: 0,
    });
    const [a] = await actionRows();
    // Shadow: the digest, with where it would go live (hitl policy: an approval).
    expect(a).toMatchObject({ route: 'digest', live: 'approval', detail: 'digest' });
    expect(JSON.parse(a?.['action'] as string)).toMatchObject({ type: 'issue.comment', issue: 7 });
  });

  it('raises a verdict short of high confidence to a human in code', async () => {
    const unsure = { ...verdict, confidence: 'medium', uncertainBecause: ['scope_judgment'] };
    const script = [
      toolUse(0, 'delegate', {
        role: 'item-review',
        target: { repo: REPO, kind: 'issue', number: 7 },
      }),
      toolUse(1, 'issue', { repo: REPO, number: 7 }),
      answer(2, unsure),
      answer(3, { proposals: [] }),
    ];
    await inAgent([issue], script, (agent) => agent.review({ kind: 'manual' }, NOW));
    const [v] = await rows();
    // Stored as routed: the model said false, code raised it.
    expect(v).toMatchObject({ confidence: 'medium', needs_human: 1 });
    const [a] = await actionRows();
    expect(a).toMatchObject({ route: 'digest', live: 'approval' });
  });

  it('keeps a close backed by a merged PR that names the issue (pull is readable for evidence)', async () => {
    extraReads = {
      timeline: [
        {
          event: 'cross-referenced',
          created_at: '2026-11-01T09:00:00Z',
          source: {
            issue: {
              number: 12,
              pull_request: {},
              repository: { full_name: REPO },
            },
          },
        },
      ],
      pull: {
        number: 12,
        title: 'Add the refresh token note',
        body: 'Fixes #7',
        merged_at: '2026-11-02T09:00:00Z',
      },
    };
    const close = {
      ...verdict,
      state: 'close',
      actions: [
        {
          type: 'issue.close',
          repo: REPO,
          issue: 7,
          body: 'Done in #12, thanks!',
          stateReason: 'completed',
        },
      ],
      evidence: [{ type: 'merged_pr', ref: '#12' }],
    };
    const script = [
      toolUse(0, 'delegate', {
        role: 'item-review',
        target: { repo: REPO, kind: 'issue', number: 7 },
      }),
      toolUse(1, 'issue', { repo: REPO, number: 7 }),
      answer(2, close),
      answer(3, { proposals: [] }),
    ];
    await inAgent([issue], script, (agent) => agent.review({ kind: 'manual' }, NOW));
    const [a] = await actionRows();
    expect(a).toMatchObject({ route: 'digest', live: 'approval' });
  });

  it('may read what the dispatcher evidence check reads for issue.close (timeline and pull)', () => {
    // brokerEvidence reads the timeline and each cross-referenced pull request through the broker:
    // without both in the read policy every close would be dropped as unreadable.
    expect(POLICY.reads['backlog-review']?.resources).toEqual(
      expect.arrayContaining(['timeline', 'pull']),
    );
  });

  it('raises to a human below high confidence, on any doubt, or for an unknown state', () => {
    expect(raisesToHuman(verdict)).toBe(false);
    expect(raisesToHuman({ ...verdict, confidence: 'medium' })).toBe(true);
    expect(raisesToHuman({ ...verdict, uncertainBecause: ['possible_injection'] })).toBe(true);
    expect(raisesToHuman({ ...verdict, state: 'unknown' })).toBe(true);
  });

  it('skips an issue whose last verdict is recent and unchanged', async () => {
    await DB()
      .prepare(
        `INSERT INTO verdicts (repo, issue, issue_updated_at, at, status, root_run_id, run_id, agent_version)
         VALUES (?, 7, ?, ?, 'ok', 'r', 'r', '0.1.0')`,
      )
      .bind(REPO, issue.updated_at, new Date(NOW.getTime() - 3_600_000).toISOString())
      .run();
    await inAgent([issue], [], async (agent, _calls, model) => {
      expect(await agent.review({ kind: 'manual' }, NOW)).toMatchObject({ selected: 0 });
      expect(model.calls).toBe(0);
    });
  });
});

describe('check-digest-action (the /backlog-digest gate, threat model E1)', () => {
  const R = 'OWASP/CheatSheetSeries';
  it('passes a policy-allowed comment and lists mentions that are not maintainers', async () => {
    const { checkAction } = await import('../scripts/check-digest-action.js');
    expect(
      checkAction({
        type: 'issue.comment',
        repo: R,
        issue: 7,
        body: 'Any news, @volunteer? cc @jmanico',
      }),
    ).toEqual({ ok: true, type: 'issue.comment', mentions: ['volunteer'] });
  });
  it('refuses what the broker would refuse', async () => {
    const { checkAction } = await import('../scripts/check-digest-action.js');
    expect(checkAction({ type: 'pr.merge', repo: R, pull: 7 })).toMatchObject({ ok: false });
    expect(
      checkAction({ type: 'issue.comment', repo: R, issue: 7, body: 'see https://evil.example' }),
    ).toMatchObject({ ok: false, problem: 'link' });
    expect(
      checkAction({
        type: 'issue.label.add',
        repo: R,
        issue: 7,
        labels: ['custodes_cheatsheet_review'],
      }),
    ).toMatchObject({ ok: false });
    expect(
      checkAction({ type: 'issue.comment', repo: 'evil/repo', issue: 7, body: 'hi' }),
    ).toMatchObject({ ok: false, denial: 'repo evil/repo not allowed' });
  });
});
