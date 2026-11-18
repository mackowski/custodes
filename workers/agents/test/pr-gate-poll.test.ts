import { env } from 'cloudflare:workers';
import { testKillSwitch, withHaltState } from './helpers/halt-state.js';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      BROKER: { value: withHaltState(fakeBroker(pulls)) },
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
  await testKillSwitch().resume('pr-gate');
});

describe('pr-gate summary', () => {
  it('keeps an error a poll recorded while the e-mail was being sent', async () => {
    const left = await runInDurableObject(await stub(), async (agent: PrGateAgent) => {
      const i = agent as unknown as Internals & { recordErrors(e: string[]): void };
      agent.setState({ ...agent.state, lastErrors: ['sent with this summary'] });
      const env = i.env;
      i.env = Object.create(env, {
        EMAIL: {
          value: {
            send: () => {
              i.recordErrors(['recorded during the send']);
              return Promise.resolve();
            },
          },
        },
      }) as AgentsEnv;
      try {
        expect((await agent.sendSummary()).ok).toBe(true);
      } finally {
        i.env = env;
      }
      return agent.state.lastErrors;
    });
    expect(left).toEqual(['recorded during the send']);
  });
});

describe('pr-gate poll budgets', () => {
  it('evaluates a settled PR up to the per-PR cap and reports the first refusal once', async () => {
    const cap = MAX_EVALUATIONS_PER_PR_PER_DAY;
    const results = await inAgent([pull(9101)], async (agent) => {
      const out: Result[] = [];
      const errorsAfter: string[][] = [];
      for (let n = 0; n < cap + 2; n++) {
        out.push(await agent.poll());
        errorsAfter.push([...agent.state.lastErrors]);
      }
      return { out, errorsAfter };
    });
    expect(cap).toBe(12);
    expect(results.out.map((r) => r.ok)).toEqual(Array(cap + 2).fill(true));
    expect(results.out.slice(0, cap).map((r) => r.detail)).toEqual(
      Array(cap).fill('1 open, 1 evaluated, 0 close attempt(s)'),
    );
    expect(results.out.slice(cap).map((r) => r.detail)).toEqual(
      Array(2).fill('1 open, 0 evaluated, 0 close attempt(s)'),
    );
    const refusal = (e: string) =>
      e.startsWith('#9101: not evaluated again today (12 evaluations)');
    // Reaching the cap is not a problem; only a refused evaluation is, and only once a day.
    expect(results.errorsAfter[cap - 1]?.some(refusal)).toBe(false);
    expect(results.errorsAfter[cap + 1]?.filter(refusal)).toHaveLength(1);
  });

  it('never refuses sandbox manual runs, and they cannot hide the next refusal', async () => {
    const cap = MAX_EVALUATIONS_PER_PR_PER_DAY;
    const r = await inAgent([pull(9102)], async (agent) => {
      const manual: Result[] = [];
      for (let n = 0; n < cap + 2; n++) manual.push(await agent.poll({ manual: true }));
      const scheduled = await agent.poll();
      return { manual, scheduled, errors: agent.state.lastErrors };
    });
    expect(r.manual.map((x) => x.detail)).toEqual(
      Array(cap + 2).fill('1 open, 1 evaluated, 0 close attempt(s)'),
    );
    expect(r.scheduled.detail).toBe('1 open, 0 evaluated, 0 close attempt(s)');
    expect(
      r.errors.filter((e) => e.startsWith('#9102: not evaluated again today (12 evaluations)')),
    ).toHaveLength(1);
  });

  it('flags a close whose broker answer is lost and does not try it again', async () => {
    // A blank disclosure closes at the rules, with no other read.
    const p = pull(9103, { body: BODY.replace('[x]', '[ ]') });
    let acts = 0;
    const r = await runInDurableObject(await stub(), async (agent: PrGateAgent) => {
      const i = agent as unknown as Internals;
      const original = i.env;
      const reads = fakeBroker([p]);
      i.env = Object.create(original, {
        BROKER: {
          value: withHaltState({
            fetch: (url: string, init: RequestInit) => {
              if (url !== 'https://broker.internal/v1/act') return reads.fetch(url, init);
              acts++;
              // The comment may be posted; the answer never arrives.
              return new Response('upstream crashed', { status: 502 });
            },
          }),
        },
      }) as AgentsEnv;
      try {
        const first = await agent.poll();
        const second = await agent.poll();
        const row = i.sql<{ outcome: string; detail: string }>`SELECT outcome, detail
          FROM decisions WHERE pr = ${p.number}`[0];
        return {
          first,
          second,
          row,
          errors: agent.state.lastErrors,
          closes: agent.state.closesToday,
        };
      } finally {
        i.env = original;
      }
    });
    expect(acts).toBe(1);
    // It may have closed, so it counts towards the daily close cap.
    expect(r.closes).toBe(1);
    expect(r.first.detail).toBe('1 open, 1 evaluated, 1 close attempt(s)');
    expect(r.second.detail).toBe('1 open, 0 evaluated, 0 close attempt(s)');
    expect(r.row?.outcome).toBe('flag');
    expect(JSON.parse(r.row?.detail ?? '{}')).toMatchObject({ why: 'close_unknown' });
    expect(r.errors).toContain(
      '#9103: close outcome unknown; the PR may be commented or closed, check by hand',
    );
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
    await testKillSwitch().halt('pr-gate', 'test', 'tester');
    const r = await inAgent([p], async (agent) => ({
      res: await agent.poll(),
      schedules: await wakes(agent),
    }));
    expect(r.res.ok).toBe(false);
    expect(r.res.detail).not.toContain('1 open');
    expect(r.schedules).toHaveLength(0);
  });

  it('answers halted, not "in progress", and schedules nothing when halted during a running poll', async () => {
    await testKillSwitch().halt('pr-gate', 'test', 'tester');
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

describe('kill switch read through the broker (#103, threat T1)', () => {
  const failing = async (fetch: () => Response | Promise<Response>) =>
    runInDurableObject(await stub(), async (agent: PrGateAgent) => {
      const i = agent as unknown as Internals;
      const original = i.env;
      i.env = Object.create(original, { BROKER: { value: { fetch } } }) as AgentsEnv;
      try {
        return await agent.poll();
      } finally {
        i.env = original;
      }
    });

  it('fails closed when the broker errors, answers garbage, or is unreachable', async () => {
    for (const fetch of [
      () => new Response('boom', { status: 500 }),
      () => Response.json({ halted: 'no' }),
      () => Promise.reject(new Error('unreachable')),
    ]) {
      const res = await failing(fetch);
      expect(res.ok).toBe(false);
      expect(res.detail).toContain('kill-switch state unavailable');
    }
  });
});

describe('broker calls signed by the Worker keyholder (ADR 0018)', () => {
  /** Runs a poll with `extra` env on top; returns the poll result and what the broker saw. */
  const pollWith = async (extra: Record<string, unknown>) => {
    const seen: Headers[] = [];
    const broker = {
      fetch: (_url: string, init: RequestInit = {}) => {
        seen.push(new Headers(init.headers));
        return Promise.resolve(Response.json({ halted: false }));
      },
    };
    const res = await runInDurableObject(await stub(), async (agent: PrGateAgent) => {
      const i = agent as unknown as Internals;
      const original = i.env;
      const props = Object.fromEntries(
        Object.entries({ BROKER: broker, ...extra }).map(([k, value]) => [k, { value }]),
      );
      i.env = Object.create(original, props) as AgentsEnv;
      try {
        return await agent.poll();
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      } finally {
        i.env = original;
      }
    });
    return { res, seen };
  };

  it('signs every call when KEYHOLDER and CALLER_NAME are set', async () => {
    // A made-up public kid, assembled so secret scanners do not read it as a credential.
    const kid = ['pr-gate', '20261109', 'a1b2c3d4'].join('-');
    const signer = {
      signRequest: () => Promise.resolve({ 'x-custodes-key-id': kid }),
      activateNextIfAccepted: () => Promise.resolve(false),
    };
    const keyholder = { idFromName: () => 'id', get: () => signer };
    const { seen } = await pollWith({ KEYHOLDER: keyholder, CALLER_NAME: 'custodes-pr-gate' });
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) expect(h.get('x-custodes-key-id')).toBe(kid);
  });

  it('refuses to run without its Keyholder or caller name: no request is ever sent unsigned', async () => {
    for (const missing of [
      { KEYHOLDER: undefined },
      { CALLER_NAME: undefined },
      { KEYHOLDER: undefined, CALLER_NAME: undefined },
    ]) {
      const { res, seen } = await pollWith(missing);
      expect(res.ok).toBe(false);
      expect(seen).toHaveLength(0);
    }
  });
});
