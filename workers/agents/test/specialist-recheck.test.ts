import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it } from 'vitest';
import { validateProposalReview } from '../src/agents/specialists/proposal.js';
import type { AgentsEnv } from '../src/env.js';
import { OWASP_INSTANCE, SANDBOX_INSTANCE } from '../src/instances.js';
import {
  MAX_FAILURES,
  MAX_JOBS_PER_DAY,
  MAX_JOBS_PER_DAY_SANDBOX,
} from '../src/agents/specialists/agent.js';
import e2eRunner from '../../../e2e/sandbox/run.ts?raw';

const testEnv = env as unknown as AgentsEnv;
const HOUR = 3_600_000;

// The Agents SDK's `sql` tag and the private queue methods are not part of the public type.
interface Internals {
  enqueue(jobs: unknown): Promise<{ queued: number }>;
  state: Record<string, unknown>;
  setState(state: Record<string, unknown>): void;
  sql<T>(strings: TemplateStringsArray, ...values: unknown[]): T[];
  run: (repo: string, issue: number, deps: unknown) => Promise<unknown>;
  workOne(): Promise<boolean>;
}
interface Job {
  issue: number;
  issue_updated_at: string;
  enqueued_at: string;
  attempts: number;
}

/** A review with the given "asked at" time; the ProposalReviewAgent derives recheckAt from it. */
function review(askedAt: Date | null, now: Date, over: { replied?: boolean } = {}) {
  return validateProposalReview(
    {
      verdict: 'real_gap',
      priorDecision: null,
      makesSense: true,
      evidence: [],
      addLabels: [],
      removeLabels: [],
      authorIntent: 'unclear',
      volunteers: ['bob'],
      askAuthor: false,
      reviewPr: null,
      helpWanted: false,
      explanation: 'x',
      suggestedComment: '',
      injectionDetected: false,
      confidence: 0.7,
    },
    {
      repo: 'mackowski/custodes-sandbox',
      title: 'T',
      labels: [],
      current: [],
      people: ['author', 'bob'],
      files: new Map(),
      now,
      ...(askedAt ? { asked: { at: askedAt.toISOString(), replied: over.replied ?? false } } : {}),
    },
  );
}

/** Runs `fn` inside a fresh instance of the agent (each name has its own SQLite). */
let n = 0;
async function inAgent<T>(fn: (a: Internals) => Promise<T>): Promise<T> {
  // Instance names must be known; each test file gets isolated storage, so one name per test is
  // reused with a distinct issue number instead.
  const stub = await getAgentByName(testEnv.ProposalReviewAgent, SANDBOX_INSTANCE);
  return runInDurableObject(stub, async (a) => {
    const agent = a as unknown as Internals;
    // Tests share this instance's SQLite: start each from an empty queue (jobs are worked head-first).
    await agent.enqueue([]); // creates the tables
    agent.sql`DELETE FROM jobs`;
    agent.sql`DELETE FROM results`;
    agent.setState({ ...agent.state, day: null, jobsToday: 0, workingSince: null });
    return fn(agent);
  });
}
const jobs = (a: Internals) =>
  a.sql<Job>`SELECT issue, issue_updated_at, enqueued_at, attempts FROM jobs ORDER BY issue`;

describe('SpecialistAgent recheck (ADR 0019)', () => {
  it('re-queues the job at recheckAt after a result that asks for it, and does not run it early', async () => {
    const issue = 1000 + ++n;
    const updated = '2026-11-10T10:00:00.000Z';
    await inAgent(async (a) => {
      const askedAt = new Date(Date.now() - 1 * HOUR);
      a.run = () => Promise.resolve(review(askedAt, new Date()));
      await a.enqueue([{ issue, issueUpdatedAt: updated }]);
      await a.workOne();
      const row = jobs(a).find((j) => j.issue === issue);
      expect(row).toBeDefined();
      const expected = new Date(askedAt.getTime() + 48 * HOUR).toISOString();
      expect(row?.enqueued_at).toBe(expected);
      expect(row?.issue_updated_at).toBe(updated);
      expect(row?.attempts).toBe(0);
      // The first result is stored for the digest.
      expect(a.sql`SELECT issue FROM results WHERE issue = ${issue}`).toHaveLength(1);
      // Not ready yet: a second run finds nothing to do.
      let calls = 0;
      a.run = () => {
        calls++;
        return Promise.resolve(null);
      };
      expect(await a.workOne()).toBe(false);
      expect(calls).toBe(0);
    });
  });

  it('queues nothing when the result has no recheckAt', async () => {
    const issue = 1000 + ++n;
    await inAgent(async (a) => {
      a.run = () => Promise.resolve(review(null, new Date()));
      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-10T10:00:00.000Z' }]);
      await a.workOne();
      expect(jobs(a).find((j) => j.issue === issue)).toBeUndefined();
    });
  });

  it('ignores a recheckAt less than a minute ahead, past, or more than 30 days away', async () => {
    for (const offset of [30_000, -HOUR, 31 * 24 * HOUR]) {
      const issue = 1000 + ++n;
      await inAgent(async (a) => {
        a.run = () =>
          Promise.resolve({
            ...review(null, new Date()),
            recheckAt: new Date(Date.now() + offset).toISOString(),
          });
        await a.enqueue([{ issue, issueUpdatedAt: '2026-11-10T10:00:00.000Z' }]);
        await a.workOne();
        expect(
          jobs(a).find((j) => j.issue === issue),
          String(offset),
        ).toBeUndefined();
      });
    }
  });

  it('ignores a recheckAt that is not a date', async () => {
    const issue = 1000 + ++n;
    await inAgent(async (a) => {
      a.run = () => Promise.resolve({ ...review(null, new Date()), recheckAt: 'soon' });
      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-10T10:00:00.000Z' }]);
      await a.workOne();
      expect(jobs(a).find((j) => j.issue === issue)).toBeUndefined();
    });
  });

  it('a newer issue version moves the waiting job earlier, to now', async () => {
    const issue = 1000 + ++n;
    await inAgent(async (a) => {
      a.run = () => Promise.resolve(review(new Date(Date.now() - HOUR), new Date()));
      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-10T10:00:00.000Z' }]);
      await a.workOne();
      const waiting = jobs(a).find((j) => j.issue === issue)!;
      expect(Date.parse(waiting.enqueued_at)).toBeGreaterThan(Date.now() + 40 * HOUR);

      const before = Date.now();
      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-11T09:00:00.000Z' }]);
      const moved = jobs(a).find((j) => j.issue === issue)!;
      expect(moved.issue_updated_at).toBe('2026-11-11T09:00:00.000Z');
      expect(Date.parse(moved.enqueued_at)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(moved.enqueued_at)).toBeLessThanOrEqual(Date.now());
    });
  });

  it('the same issue version does not move the job: the recheck time stays', async () => {
    const issue = 1000 + ++n;
    await inAgent(async (a) => {
      a.run = () => Promise.resolve(review(new Date(Date.now() - HOUR), new Date()));
      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-10T10:00:00.000Z' }]);
      await a.workOne();
      const waiting = jobs(a).find((j) => j.issue === issue)!;
      // The stored result is fresh for this version, so it is not even queued again.
      expect(await a.enqueue([{ issue, issueUpdatedAt: '2026-11-10T10:00:00.000Z' }])).toEqual({
        queued: 0,
      });
      expect(jobs(a).find((j) => j.issue === issue)).toEqual(waiting);
    });
  });

  it('a newer version also pulls a failed job out of its retry delay, but the same version does not', async () => {
    const issue = 1000 + ++n;
    await inAgent(async (a) => {
      // An unusable answer about this issue: the only kind of failure that counts as an attempt.
      a.run = () =>
        Promise.reject(Object.assign(new Error('bad output'), { name: 'StructuredOutputError' }));
      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-10T10:00:00.000Z' }]);
      await a.workOne();
      const delayed = jobs(a).find((j) => j.issue === issue)!;
      expect(delayed.attempts).toBe(MAX_FAILURES / 4);
      expect(Date.parse(delayed.enqueued_at)).toBeGreaterThan(Date.now() + 5 * HOUR);

      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-10T10:00:00.000Z' }]);
      expect(jobs(a).find((j) => j.issue === issue)?.enqueued_at).toBe(delayed.enqueued_at);

      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-12T10:00:00.000Z' }]);
      const moved = jobs(a).find((j) => j.issue === issue)!;
      expect(moved.attempts).toBe(0);
      expect(Date.parse(moved.enqueued_at)).toBeLessThanOrEqual(Date.now());
    });
  });
});

describe('specialists daily budget (operator, 2026-11-16)', () => {
  it('gives the sandbox a larger daily job budget than OWASP', async () => {
    const budget = async (instance: string) =>
      runInDurableObject(await getAgentByName(testEnv.ProposalReviewAgent, instance), (a) =>
        (a as unknown as { jobsPerDay(): number }).jobsPerDay(),
      );
    expect(await budget(SANDBOX_INSTANCE)).toBe(MAX_JOBS_PER_DAY_SANDBOX);
    expect(await budget(OWASP_INSTANCE)).toBe(MAX_JOBS_PER_DAY);
    expect(MAX_JOBS_PER_DAY_SANDBOX).toBeGreaterThan(MAX_JOBS_PER_DAY);
  });

  it('is mirrored by the sandbox e2e runner, which stops waiting at the cap', () => {
    // A stale mirror made the 2026-11-16 e2e send its digest before the specialists finished.
    expect(e2eRunner).toContain(`const SPECIALIST_JOBS_PER_DAY = ${MAX_JOBS_PER_DAY_SANDBOX};`);
  });
});

describe('SpecialistAgent queue: giving up, the daily cap and versions', () => {
  const updated = '2026-11-10T10:00:00.000Z';
  const makeReady = (a: Internals, issue: number) =>
    a.sql`UPDATE jobs SET enqueued_at = '2000-01-01T00:00:00.000Z' WHERE issue = ${issue}`;

  // An unusable answer about this issue (input-specific), as the model clients throw it.
  const unusable = () => Object.assign(new Error('bad output'), { name: 'StructuredOutputError' });

  it('does not park a job for a few infrastructure failures: an outage heals by itself', async () => {
    const issue = 1000 + ++n;
    await inAgent(async (a) => {
      a.run = () => Promise.reject(new Error('gateway down'));
      await a.enqueue([{ issue, issueUpdatedAt: updated }]);
      const failTimes = async (times: number) => {
        for (let k = 0; k < times; k++) {
          makeReady(a, issue);
          await a.workOne();
        }
        return jobs(a).find((j) => j.issue === issue);
      };
      // Six failures (a day and a half of outage): still waiting for the retry delay.
      const waiting = await failTimes(6);
      expect(Date.parse(waiting?.enqueued_at ?? '')).toBeLessThan(Date.now() + 7 * HOUR);
      // An issue that fails this way every time is parked in the end, so it cannot use up the
      // daily budget for ever.
      const parked = await failTimes(MAX_FAILURES - 6);
      expect(Date.parse(parked?.enqueued_at ?? '')).toBeGreaterThan(Date.now() + 29 * 24 * HOUR);
    });
  });

  it('parks a job after the last attempt, so the next prepare does not start it over', async () => {
    const issue = 1000 + ++n;
    await inAgent(async (a) => {
      a.run = () => Promise.reject(unusable());
      await a.enqueue([{ issue, issueUpdatedAt: updated }]);
      for (let k = 0; k < 4; k++) {
        makeReady(a, issue);
        await a.workOne();
      }
      const parked = jobs(a).find((j) => j.issue === issue);
      expect(parked?.attempts).toBe(MAX_FAILURES);
      expect(Date.parse(parked?.enqueued_at ?? '')).toBeGreaterThan(Date.now() + 29 * 24 * HOUR);
      // Triage sends the same version again on every prepare: the row stays parked.
      let calls = 0;
      a.run = () => {
        calls++;
        return Promise.resolve(null);
      };
      await a.enqueue([{ issue, issueUpdatedAt: updated }]);
      expect(await a.workOne()).toBe(false);
      expect(calls).toBe(0);
      expect(jobs(a).find((j) => j.issue === issue)?.attempts).toBe(MAX_FAILURES);
      // A newer version of the issue starts fresh and runs now.
      await a.enqueue([{ issue, issueUpdatedAt: '2026-11-12T10:00:00.000Z' }]);
      expect(jobs(a).find((j) => j.issue === issue)?.attempts).toBe(0);
      await a.workOne();
      expect(calls).toBe(1);
    });
  });

  it('runs nothing once the daily cap is used', async () => {
    const issue = 1000 + ++n;
    await inAgent(async (a) => {
      let calls = 0;
      a.run = () => {
        calls++;
        return Promise.resolve(null);
      };
      await a.enqueue([{ issue, issueUpdatedAt: updated }]);
      a.setState({
        ...a.state,
        day: new Date().toISOString().slice(0, 10),
        jobsToday: MAX_JOBS_PER_DAY_SANDBOX,
      });
      expect(await a.workOne()).toBe(false);
      expect(calls).toBe(0);
      expect(jobs(a).some((j) => j.issue === issue)).toBe(true);
    });
  });

  it('keeps a newer version that was enqueued while the old one was being worked', async () => {
    const issue = 1000 + ++n;
    const newer = '2026-11-12T10:00:00.000Z';
    await inAgent(async (a) => {
      a.run = async () => {
        await a.enqueue([{ issue, issueUpdatedAt: newer }]);
        return null;
      };
      await a.enqueue([{ issue, issueUpdatedAt: updated }]);
      await a.workOne();
      const row = jobs(a).find((j) => j.issue === issue);
      expect(row?.issue_updated_at).toBe(newer);
      expect(row?.attempts).toBe(0);
    });
  });
});
