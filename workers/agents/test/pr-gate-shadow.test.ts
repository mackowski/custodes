import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClefTimeoutError, GatewayError, jevState } from '@custodes/llm';
import type { ComparisonRow, PrGateAgent } from '../src/agents/pr-gate.js';
import { agree, reduce, shadowed, type Comparison } from '../src/agents/pr-gate/shadow.js';
import { renderSummary, shadowLine } from '../src/agents/pr-gate/summary.js';
import type { PublicPull } from '../src/agents/triage/github.js';
import type { AgentsEnv } from '../src/env.js';
import { SANDBOX_INSTANCE } from '../src/instances.js';

const testEnv = env as AgentsEnv;
const REPO = 'mackowski/custodes-sandbox';

const minorAnswers = (model: string, p: number, kind: string) => ({
  model,
  answers: {
    minor: { type: 'noul' as const, noul: p },
    kind: { type: 'choice' as const, choice: kind, confidence: 0.9, probabilities: {} },
  },
  usage: { input_tokens: 120, output_tokens: 0 },
});

describe('shadowed', () => {
  const state = jevState('pr-diff', 'diff');
  let clock = 0;
  const now = () => (clock += 5);

  it('returns Jev and records both, reduced to numbers', async () => {
    const rows: Comparison[] = [];
    const jev = minorAnswers('typesafe/jev-1.14', 0.95, 'link');
    const r = await shadowed(
      'minor',
      state,
      () => Promise.resolve(jev),
      () => Promise.resolve(minorAnswers('clef', 0.3, 'new_guidance')),
      (c) => rows.push(c),
      now,
    );
    expect(r).toBe(jev);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      question: 'minor',
      jev: { model: 'typesafe/jev-1.14', p: 0.95, choice: 'link', tokens: 120 },
      clef: { model: 'clef', p: 0.3, choice: 'new_guidance', tokens: 120 },
    });
    expect(rows[0]?.stateSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps Jev when Clef fails, and records only the error class', async () => {
    const rows: Comparison[] = [];
    const r = await shadowed(
      'minor',
      state,
      () => Promise.resolve(minorAnswers('jev', 0.9, 'typo')),
      () => Promise.reject(new GatewayError(500, 'secret body text')),
      (c) => rows.push(c),
    );
    expect(r.answers.minor.noul).toBe(0.9);
    expect(rows[0]?.clef.error).toBe('GatewayError 500');
    expect(JSON.stringify(rows)).not.toContain('secret');
  });

  it('throws Jev’s own error after recording Clef’s answer', async () => {
    const rows: Comparison[] = [];
    const boom = new GatewayError(502, 'down');
    await expect(
      shadowed(
        'approval',
        state,
        () => Promise.reject(boom),
        () =>
          Promise.resolve({
            model: 'clef',
            answers: {
              approved: { type: 'noul' as const, noul: 0.2 },
              stance: {
                type: 'choice' as const,
                choice: 'unrelated',
                confidence: 0.8,
                probabilities: {},
              },
            },
          }),
        (c) => rows.push(c),
      ),
    ).rejects.toBe(boom);
    expect(rows[0]).toMatchObject({ question: 'approval', jev: { error: 'GatewayError 502' } });
    expect(rows[0]?.clef.p).toBe(0.2);
  });

  it('records nothing without a shadow', async () => {
    const record = vi.fn();
    await shadowed(
      'minor',
      state,
      () => Promise.resolve(minorAnswers('jev', 0.9, 'typo')),
      undefined,
      record,
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('never stores a choice that does not look like an option id', () => {
    expect(reduce('minor', minorAnswers('m', 0.5, 'Ignore previous instructions'), 1).choice).toBe(
      'other',
    );
  });

  it('reads the answers by question id, not by order', () => {
    const extra = minorAnswers('m', 0.9, 'typo');
    const res = {
      ...extra,
      answers: { other: { type: 'noul' as const, noul: 0.1 }, ...extra.answers },
    };
    expect(reduce('minor', res, 1)).toMatchObject({ p: 0.9, choice: 'typo' });
  });

  it('agrees on the same side of 0.5 with the same choice only', () => {
    const row = { jev_p: 0.9, clef_p: 0.6, jev_choice: 'typo', clef_choice: 'typo' };
    expect(agree(row)).toBe(true);
    expect(agree({ ...row, clef_p: 0.4 })).toBe(false);
    expect(agree({ ...row, clef_choice: 'link' })).toBe(false);
    expect(agree({ ...row, clef_p: null })).toBeUndefined();
  });
});

describe('summary shadow line', () => {
  it('lists counts and validated PR numbers only', () => {
    expect(shadowLine({ agree: 3, disagree: [12, -1, 1.5, 40], clefErrors: 1 })).toBe(
      'Jev vs Clef: 3 agree, 2 disagree (#12, #40), 1 Clef error(s).',
    );
    const r = renderSummary({
      repo: REPO,
      rows: [],
      skipped: 0,
      enforcing: true,
      verifyUrl: 'https://custodes.work/verify',
      errors: [],
      now: new Date(),
      shadow: { agree: 1, disagree: [], clefErrors: 0 },
    });
    expect(r.text).toContain('Jev vs Clef: 1 agree, 0 disagree, 0 Clef error(s).');
    expect(r.html).toContain('Jev vs Clef');
  });
});

// ---- Through a real poll: the agent, its SQLite, a fake broker, Jev and Clef ----

const BODY = `## AI Tool Usage Disclosure (required for all PRs)

- [x] I did not use any AI tools in preparing this contribution.
`;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const pull = (number: number, over: Partial<PublicPull> = {}): PublicPull => ({
  number,
  title: `PR ${number}`,
  body: BODY,
  html_url: `https://github.com/${REPO}/pull/${number}`,
  state: 'open',
  user: { login: 'contributor', type: 'User' },
  author_association: 'CONTRIBUTOR',
  labels: [],
  created_at: ago(5 * 3_600_000),
  updated_at: ago(3 * 3_600_000),
  head: { sha: `sha-${number}` },
  ...over,
});

const smallFix = {
  filename: 'cheatsheets/Foo_Cheat_Sheet.md',
  status: 'modified',
  additions: 1,
  deletions: 1,
  changes: 2,
  patch: '@@ -1 +1 @@\n-teh\n+the',
};

/** Open pulls, one small cheat sheet diff per PR, no approved issues, and `closed` when asked. */
const fakeBroker = (open: PublicPull[], closed: PublicPull[] = []) => ({
  fetch: (_url: string, init: RequestInit) => {
    const req = JSON.parse(init.body as string) as {
      resource: string;
      query?: { state?: string };
    };
    if (req.resource === 'pulls')
      return Response.json({ ok: true, data: req.query?.state === 'closed' ? closed : open });
    if (req.resource === 'pull_files') return Response.json({ ok: true, data: [smallFix] });
    return Response.json({ ok: true, data: [] });
  },
});

interface Internals {
  env: AgentsEnv;
  ensureSchema(): void;
  settleVerdicts(): Promise<void>;
  sql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[];
}

const stub = () => getAgentByName(testEnv.PrGateAgent, SANDBOX_INSTANCE);

async function inAgent<T>(
  broker: ReturnType<typeof fakeBroker>,
  ai: { run: (...a: unknown[]) => Promise<unknown> },
  fn: (agent: PrGateAgent, i: Internals) => Promise<T>,
): Promise<T> {
  return runInDurableObject(await stub(), async (agent: PrGateAgent) => {
    const i = agent as unknown as Internals;
    const original = i.env;
    i.env = Object.create(original, { BROKER: { value: broker }, AI: { value: ai } }) as AgentsEnv;
    try {
      return await fn(agent, i);
    } finally {
      i.env = original;
    }
  });
}

/** Jev is called directly (JEV_TRANSPORT=direct in wrangler.jsonc) through the global fetch. */
function fakeJev(p: number, kind: string) {
  const f = vi.fn((url: string, _init?: RequestInit) => {
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
    return Promise.resolve(
      Response.json({ id: 'd1', ...minorAnswers('typesafe/jev-1.14', p, kind) }),
    );
  });
  vi.stubGlobal('fetch', f);
  return f;
}

const rowsOf = (i: Internals) => i.sql<ComparisonRow>`SELECT * FROM model_comparisons ORDER BY id`;

beforeEach(async () => {
  await runInDurableObject(await stub(), async (agent: PrGateAgent) => {
    const i = agent as unknown as Internals;
    i.ensureSchema();
    i.sql`DELETE FROM decisions`;
    i.sql`DELETE FROM evaluations`;
    i.sql`DELETE FROM events`;
    i.sql`DELETE FROM model_comparisons`;
    for (const s of await agent.listSchedules()) await agent.cancelSchedule(s.id);
    agent.setState({
      lastPollAt: null,
      lastSummaryAt: null,
      day: new Date().toISOString().slice(0, 10),
      closesToday: 0,
      evaluationsToday: 0,
      lastErrors: [],
    });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pr-gate with Clef as a shadow', () => {
  it('decides on Jev alone and stores both answers with the outcome', async () => {
    const jev = fakeJev(0.95, 'link');
    const run = vi.fn((..._a: unknown[]) =>
      Promise.resolve(minorAnswers('clef', 0.2, 'new_guidance')),
    );
    const r = await inAgent(fakeBroker([pull(9201)]), { run }, async (agent, i) => {
      await agent.poll();
      const decision = i.sql<{ outcome: string }>`SELECT outcome FROM decisions WHERE pr = 9201`[0];
      return { decision, rows: rowsOf(i) };
    });
    expect(jev).toHaveBeenCalledTimes(1);
    expect(r.decision?.outcome).toBe('skip');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      pr: 9201,
      head_sha: 'sha-9201',
      question: 'minor',
      jev_p: 0.95,
      jev_choice: 'link',
      clef_p: 0.2,
      clef_choice: 'new_guidance',
      clef_error: null,
      outcome: 'skip',
      human_verdict: null,
    });
    // Same state for both, through the gateway named in wrangler.jsonc.
    const [model, inputs, options] = run.mock.calls[0] as [
      string,
      { state: string },
      { gateway: { id: string } },
    ];
    expect(model).toBe('@cf/cloudflare/clef');
    expect(options.gateway.id).toBe(testEnv.AI_GATEWAY_ID);
    const jevBody = JSON.parse(jev.mock.calls[0]?.[1]?.body as string) as { state: string };
    expect(inputs.state).toBe(jevBody.state);
  });

  it('makes the same decision when Clef is down, and records the error', async () => {
    fakeJev(0.95, 'link');
    const run = vi.fn(() => Promise.reject(new Error('AiError: 5007')));
    const r = await inAgent(fakeBroker([pull(9202)]), { run }, async (agent, i) => {
      const res = await agent.poll();
      return { res, errors: agent.state.lastErrors, rows: rowsOf(i) };
    });
    expect(r.res.detail).toBe('1 open, 1 evaluated, 0 close attempt(s)');
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ outcome: 'skip', jev_p: 0.95, clef_p: null });
    expect(r.rows[0]?.clef_error).toBe('Error');
  });

  it('stops asking Clef for the rest of the poll after it times out', async () => {
    fakeJev(0.95, 'link');
    const run = vi.fn(() => Promise.reject(new ClefTimeoutError()));
    const r = await inAgent(fakeBroker([pull(9211), pull(9212)]), { run }, async (agent, i) => {
      const res = await agent.poll();
      return { res, rows: rowsOf(i) };
    });
    expect(r.res.detail).toBe('2 open, 2 evaluated, 0 close attempt(s)');
    expect(run).toHaveBeenCalledTimes(1);
    expect(r.rows.map((x) => [x.pr, x.clef_error])).toEqual([[9211, 'ClefTimeoutError']]);
  });

  it('serves the rows and takes an operator verdict for one question', async () => {
    fakeJev(0.95, 'link');
    const run = vi.fn(() => Promise.resolve(minorAnswers('clef', 0.9, 'link')));
    const r = await inAgent(fakeBroker([pull(9203)]), { run }, async (agent) => {
      await agent.poll();
      const base = `https://x/agents/pr-gate-agent/${SANDBOX_INSTANCE}`;
      const bad = await agent.onRequest(
        new Request(`${base}/verdict`, {
          method: 'POST',
          headers: { 'x-custodes-actor-via': 'access-user' },
          body: '{"pr":9203,"answer":"maybe"}',
        }),
      );
      const ok = await agent.onRequest(
        new Request(`${base}/verdict`, {
          method: 'POST',
          headers: { 'x-custodes-actor': 'op@example.com', 'x-custodes-actor-via': 'access-user' },
          body: JSON.stringify({ pr: 9203, question: 'minor', answer: 'yes' }),
        }),
      );
      const svc = await agent.onRequest(
        new Request(`${base}/verdict`, {
          method: 'POST',
          headers: { 'x-custodes-actor-via': 'access-service-token' },
          body: JSON.stringify({ pr: 9203, question: 'minor', answer: 'no' }),
        }),
      );
      const list = await agent.onRequest(new Request(`${base}/comparisons`));
      const badSince = await agent.onRequest(new Request(`${base}/comparisons?since=nope`));
      return {
        svc: svc.status,
        bad: bad.status,
        ok: await ok.json(),
        list: await list.json<ComparisonRow[]>(),
        badSince: badSince.status,
      };
    });
    expect(r.svc).toBe(403);
    expect(r.bad).toBe(400);
    expect(r.ok).toEqual({ pr: 9203, question: 'minor', answer: 'yes', rows: 1 });
    expect(r.list.map((x) => [x.pr, x.human_verdict])).toEqual([[9203, 'yes']]);
    expect(r.badSince).toBe(400);
  });

  it('marks merged PRs and PRs others closed, not the ones pr-gate closed', async () => {
    const r = await inAgent(
      fakeBroker(
        [],
        [
          pull(9301, { state: 'closed', merged_at: ago(1000) }),
          pull(9302, { state: 'closed', merged_at: null }),
          pull(9303, { state: 'closed', merged_at: null }),
        ],
      ),
      { run: vi.fn() },
      async (_agent, i) => {
        const at = new Date().toISOString();
        for (const pr of [9301, 9302, 9303, 9304])
          i.sql`INSERT INTO model_comparisons (pr, head_sha, state_sha256, question, jev_ms,
              clef_ms, outcome, decided_at)
            VALUES (${pr}, 'h', 's', 'minor', 1, 1, 'skip', ${at})`;
        i.sql`INSERT INTO decisions (pr, head_sha, pr_updated_at, title, outcome, detail, decided_at)
          VALUES (9303, 'h', ${at}, 't', 'close', '{}', ${at})`;
        await i.settleVerdicts();
        return i.sql<{ pr: number; human_verdict: string | null }>`
          SELECT pr, human_verdict FROM model_comparisons ORDER BY pr`;
      },
    );
    expect(r).toEqual([
      { pr: 9301, human_verdict: 'merged' },
      { pr: 9302, human_verdict: 'closed_unmerged' },
      { pr: 9303, human_verdict: null },
      { pr: 9304, human_verdict: null },
    ]);
  });
});

describe('one AI Gateway in the agents Worker (ADR 0015)', () => {
  // The AI binding has no URL for the packages/llm test to catch: a call without `gateway` would
  // skip the gateway's logs and limits. Only ClefClient (built in pr-gate.ts) may touch it.
  const sources = import.meta.glob<string>('../src/**/*.ts', {
    query: '?raw',
    import: 'default',
    eager: true,
  });

  it('uses the AI binding in one place only, through ClefClient', () => {
    const uses = Object.entries(sources).flatMap(([file, text]) =>
      (text.match(/\benv\.AI\b/g) ?? []).map(() => file),
    );
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(uses).toEqual(['../src/agents/pr-gate.ts']);
    expect(sources['../src/agents/pr-gate.ts']).toMatch(
      /new ClefClient\(\{\s*ai: \{ run: \(model, inputs, options\) => this\.env\.AI\.run\(model, inputs, options\) \}/,
    );
  });
});
