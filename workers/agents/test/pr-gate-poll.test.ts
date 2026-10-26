import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KillSwitch } from '@custodes/core';
import {
  MAX_CLOSES_PER_DAY,
  MAX_EVALUATIONS_PER_DAY,
  MAX_EVALUATIONS_PER_PR_PER_DAY,
  POLL_LOCK_MS,
  type PrGateAgent,
} from '../src/agents/pr-gate.js';
import { GRACE_MS, wakeAt } from '../src/agents/pr-gate/rules.js';
import type { PublicPull } from '../src/agents/triage/github.js';
import type { AgentsEnv } from '../src/env.js';
import { SANDBOX_INSTANCE } from '../src/instances.js';

const testEnv = env as AgentsEnv;
const REPO = 'mackowski/custodes-sandbox';
const BODY = `## AI Tool Usage Disclosure (required for all PRs)

- [x] I did not use any AI tools in preparing this contribution.
- [ ] I used AI tools and have reviewed and verified all of the content.
`;

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const HOUR = 3_600_000;

const pull = (number: number, over: Partial<PublicPull> = {}): PublicPull => ({
  number,
  title: `PR ${number}`,
  body: BODY,
  html_url: `https://github.com/${REPO}/pull/${number}`,
  state: 'open',
  user: { login: 'contributor', type: 'User' },
  author_association: 'CONTRIBUTOR',
  labels: [],
  created_at: ago(5 * HOUR),
  updated_at: ago(3 * HOUR),
  head: { sha: `sha-${number}` },
  ...over,
});

/** Answers the pulls listing; every other read fails, so each evaluated PR becomes an error row. */
const fakeBroker = (
  pulls: PublicPull[],
): { fetch: (url: string, init: RequestInit) => Response } => ({
  fetch: (url, init) => {
    expect(url).toBe('https://broker.internal/v1/read');
    const req = JSON.parse(init.body as string) as { resource: string };
    return Response.json(
      req.resource === 'pulls'
        ? { ok: true, data: pulls }
        : { ok: false, code: 'github_error', reason: 'fake', status: 500 },
    );
  },
});

interface Internals {
  env: AgentsEnv;
  pollingSince: number | null;
  ensureSchema(): void;
  sql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[];
}

interface Result {
  ok: boolean;
  detail: string;
}

const stub = () => getAgentByName(testEnv.PrGateAgent, SANDBOX_INSTANCE);

/** Runs `fn` inside the agent with its broker replaced by one that lists `pulls`. */
async function inAgent<T>(
  pulls: PublicPull[],
  fn: (agent: PrGateAgent, i: Internals) => Promise<T>,
): Promise<T> {
  return runInDurableObject(await stub(), async (agent: PrGateAgent) => {
    const i = agent as unknown as Internals;
    const original = i.env;
    i.env = Object.create(original, {
      BROKER: { value: fakeBroker(pulls) },
    }) as AgentsEnv;
    try {
      return await fn(agent, i);
    } finally {
      i.env = original;
    }
  });
}

const today = () => new Date().toISOString().slice(0, 10);

const wakes = async (agent: PrGateAgent) =>
  (await agent.listSchedules()).filter((s) => s.callback === 'wake');

beforeEach(async () => {
  // Storage may persist between tests: start each from a clean agent.
  await runInDurableObject(await stub(), async (agent: PrGateAgent) => {
    const i = agent as unknown as Internals;
    i.ensureSchema();
    i.sql`DELETE FROM decisions`;
    i.sql`DELETE FROM evaluations`;
    i.sql`DELETE FROM events`;
    for (const s of await agent.listSchedules()) await agent.cancelSchedule(s.id);
    i.pollingSince = null;
    agent.setState({
      lastPollAt: null,
      lastSummaryAt: null,
      day: today(),
      closesToday: 0,
      evaluationsToday: 0,
      lastErrors: [],
    });
  });
});

afterEach(async () => {
  await new KillSwitch(testEnv.KILL_SWITCH).resume('pr-gate');
});

describe('pr-gate poll budgets', () => {
  it('evaluates a settled PR in the first four polls of a day and not in the fifth', async () => {
    const results = await inAgent([pull(9101)], async (agent) => {
      const out: Result[] = [];
      for (let n = 0; n <= MAX_EVALUATIONS_PER_PR_PER_DAY; n++) out.push(await agent.poll());
      return { out, errors: agent.state.lastErrors };
    });
    expect(MAX_EVALUATIONS_PER_PR_PER_DAY).toBe(4);
    expect(results.out.map((r) => r.ok)).toEqual([true, true, true, true, true]);
    expect(results.out.slice(0, 4).map((r) => r.detail)).toEqual(
      Array(4).fill('1 open, 1 evaluated, 0 close attempt(s)'),
    );
    expect(results.out[4]?.detail).toBe('1 open, 0 evaluated, 0 close attempt(s)');
    expect(results.errors.some((e) => e.includes('#9101: evaluated 4 times today'))).toBe(true);
  });

  it('stops evaluating when the daily budget is spent and says so', async () => {
    const pulls = [pull(9111), pull(9112), pull(9113)];
    const r = await inAgent(pulls, async (agent) => {
      agent.setState({
        ...agent.state,
        day: today(),
        evaluationsToday: MAX_EVALUATIONS_PER_DAY - 1,
      });
      const res = await agent.poll();
      return { res, state: agent.state };
    });
    expect(r.res.detail).toBe('3 open, 1 evaluated, 0 close attempt(s)');
    expect(r.state.evaluationsToday).toBe(MAX_EVALUATIONS_PER_DAY);
    expect(r.state.lastErrors.some((e) => e.includes('daily budget'))).toBe(true);
  });

  it('still reports a reopened PR once the daily budget is spent', async () => {
    const p = pull(9121);
    const flag = await inAgent([p], async (agent, i) => {
      i.ensureSchema();
      const detail = JSON.stringify({ why: 'no_approved_issue', rung: 'rule' });
      i.sql`INSERT INTO decisions (pr, head_sha, pr_updated_at, title, outcome, detail, decided_at)
        VALUES (${p.number}, ${p.head.sha}, ${p.updated_at}, ${p.title}, 'close', ${detail},
          ${new Date().toISOString()})`;
      agent.setState({ ...agent.state, day: today(), evaluationsToday: MAX_EVALUATIONS_PER_DAY });
      const res = await agent.poll();
      const row = i.sql<{ outcome: string; detail: string }>`
        SELECT outcome, detail FROM decisions WHERE pr = ${p.number}`[0];
      return { res, row };
    });
    expect(flag.res.detail).toBe('1 open, 0 evaluated, 0 close attempt(s)');
    expect(flag.row?.outcome).toBe('flag');
    expect(JSON.parse(flag.row?.detail ?? '{}')).toMatchObject({ why: 'reopened_after_close' });
  });

  it('does not decide a stored would-close again once the daily close cap is reached', async () => {
    // wrangler.jsonc sets PR_GATE_ENFORCE=true, so this exercises the enforcing path: the cap is
    // what turns "worth deciding again" off.
    expect(testEnv.PR_GATE_ENFORCE).toBe('true');
    const p = pull(9131);
    const r = await inAgent([p], async (agent, i) => {
      i.ensureSchema();
      const detail = JSON.stringify({ why: 'no_approved_issue', rung: 'rule' });
      i.sql`INSERT INTO decisions (pr, head_sha, pr_updated_at, title, outcome, detail, decided_at)
        VALUES (${p.number}, ${p.head.sha}, ${p.updated_at}, ${p.title}, 'would_close', ${detail},
          ${new Date().toISOString()})`;
      agent.setState({ ...agent.state, day: today(), closesToday: MAX_CLOSES_PER_DAY });
      return agent.poll();
    });
    expect(r.detail).toBe('1 open, 0 evaluated, 0 close attempt(s)');
  });

  it('decides a stored would-close again while the daily close cap has room', async () => {
    const p = pull(9132);
    const r = await inAgent([p], async (agent, i) => {
      i.ensureSchema();
      const detail = JSON.stringify({ why: 'no_approved_issue', rung: 'rule' });
      i.sql`INSERT INTO decisions (pr, head_sha, pr_updated_at, title, outcome, detail, decided_at)
        VALUES (${p.number}, ${p.head.sha}, ${p.updated_at}, ${p.title}, 'would_close', ${detail},
          ${new Date().toISOString()})`;
      return agent.poll();
    });
    expect(r.detail).toBe('1 open, 1 evaluated, 0 close attempt(s)');
  });
});

describe('pr-gate poll self-scheduling', () => {
  it('waits out the grace period with exactly one wake-up, however often it polls', async () => {
    const updated = ago(10 * 60_000);
    const p = pull(9141, { updated_at: updated });
    const before = new Date();
    const r = await inAgent([p], async (agent) => {
      const first = await agent.poll();
      const afterFirst = (await wakes(agent)).map((s) => ({ ...s }));
      const second = await agent.poll();
      return { first, second, afterFirst, afterSecond: await wakes(agent) };
    });
    const after = new Date();
    expect(r.first.detail).toBe('1 open, 0 evaluated, 0 close attempt(s)');
    expect(r.second.detail).toBe('1 open, 0 evaluated, 0 close attempt(s)');
    expect(r.afterFirst).toHaveLength(1);
    expect(r.afterSecond).toHaveLength(1);
    expect(r.afterSecond[0]?.id).toBe(r.afterFirst[0]?.id);
    // The slot is derived from updated_at, so bound it by the clock before and after the polls.
    const at = (r.afterSecond[0]?.time ?? 0) * 1000;
    expect(at).toBeGreaterThanOrEqual(wakeAt(updated, before).getTime());
    expect(at).toBeLessThanOrEqual(wakeAt(updated, after).getTime());
    expect(at - Date.parse(updated)).toBeGreaterThanOrEqual(GRACE_MS);
  });

  it('schedules nothing when the kill switch is on, whatever is waiting', async () => {
    const p = pull(9151, { updated_at: ago(10 * 60_000) });
    await new KillSwitch(testEnv.KILL_SWITCH).halt('pr-gate', 'test', 'tester');
    const r = await inAgent([p], async (agent) => ({
      res: await agent.poll(),
      schedules: await wakes(agent),
    }));
    expect(r.res.ok).toBe(false);
    expect(r.res.detail).not.toContain('1 open');
    expect(r.schedules).toHaveLength(0);
  });

  it('answers halted, not "in progress", and schedules nothing when halted during a running poll', async () => {
    await new KillSwitch(testEnv.KILL_SWITCH).halt('pr-gate', 'test', 'tester');
    const r = await inAgent([], async (agent, i) => {
      i.pollingSince = Date.now();
      try {
        return { res: await agent.poll(), schedules: await wakes(agent) };
      } finally {
        i.pollingSince = null;
      }
    });
    expect(r.res.ok).toBe(false);
    expect(r.res.detail).not.toContain('poll in progress');
    expect(r.schedules).toHaveLength(0);
  });
});

describe('pr-gate poll lock', () => {
  it('defers to a poll that started recently and books the next slot', async () => {
    const r = await inAgent([], async (agent, i) => {
      i.pollingSince = Date.now();
      try {
        return { res: await agent.poll(), schedules: await wakes(agent) };
      } finally {
        i.pollingSince = null;
      }
    });
    expect(r.res.ok).toBe(false);
    expect(r.res.detail).toMatch(/^poll in progress; again at /);
    expect(r.schedules).toHaveLength(1);
  });

  it('takes over a lock older than POLL_LOCK_MS and runs', async () => {
    const r = await inAgent([pull(9161)], async (agent, i) => {
      i.pollingSince = Date.now() - POLL_LOCK_MS - 1;
      const res = await agent.poll();
      return { res, since: i.pollingSince };
    });
    expect(r.res.ok).toBe(true);
    expect(r.res.detail).toBe('1 open, 1 evaluated, 0 close attempt(s)');
    expect(r.since).toBeNull();
  });
});
