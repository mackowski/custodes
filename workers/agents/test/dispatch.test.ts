import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it, vi } from 'vitest';
import type { InboundEvent } from '@custodes/schema';
import prGateWorker from '../src/pr-gate-worker.js';
import cheatsheetReviewWorker from '../src/cheatsheet-review-worker.js';
import type { PrGateAgent } from '../src/agents/pr-gate.js';
import { route } from '../src/dispatch.js';
import type { AgentsEnv } from '../src/env.js';
import { OWASP_INSTANCE, SANDBOX_INSTANCE } from '../src/instances.js';

const testEnv = env as AgentsEnv;

const event = (over: Partial<InboundEvent> = {}, action = 'opened'): InboundEvent => ({
  id: '6a1f6c1e-0b1e-4c5e-9d55-3f1b1e0e7a01',
  receivedAt: '2026-10-26T10:00:00Z',
  source: 'github-webhook',
  event: 'pull_request',
  deliveryId: 'd-1',
  repo: 'OWASP/CheatSheetSeries',
  payload: {
    action,
    repository: { full_name: 'OWASP/CheatSheetSeries' },
    sender: { login: 'contributor' },
    pull_request: { number: 2900, updated_at: '2026-10-26T10:00:00Z' },
  },
  ...over,
});

describe('route (which webhook events wake an agent)', () => {
  it('wakes pr-gate for an opened or reopened pull request on a known repository', () => {
    expect(route(event())).toEqual({
      agent: 'pr-gate',
      instance: OWASP_INSTANCE,
      pr: 2900,
      updatedAt: '2026-10-26T10:00:00Z',
    });
    expect(route(event({}, 'reopened'))).toMatchObject({ agent: 'pr-gate' });
    expect(route(event({ repo: 'mackowski/custodes-sandbox' }))).toMatchObject({
      instance: SANDBOX_INSTANCE,
    });
  });

  it('matches the repository case-insensitively, as GitHub does', () => {
    expect(route(event({ repo: 'owasp/cheatsheetseries' }))).toMatchObject({
      instance: OWASP_INSTANCE,
    });
  });

  it('ignores repositories no instance works on', () => {
    expect(route(event({ repo: 'attacker/repo' }))).toEqual({ agent: null, why: 'unknown_repo' });
  });

  it('ignores other pull request actions: pr-gate re-polls edits itself', () => {
    for (const action of ['edited', 'synchronize', 'ready_for_review', 'labeled', 'closed'])
      expect(route(event({}, action))).toEqual({ agent: null, why: 'unhandled_event' });
  });

  it('ignores issues and other events (triage stays on its crons)', () => {
    const e = event();
    expect(
      route({
        ...e,
        event: 'issues',
        payload: { ...e.payload, issue: { number: 1 }, pull_request: undefined },
      }),
    ).toEqual({ agent: null, why: 'unhandled_event' });
    expect(route({ ...e, event: 'push' })).toEqual({ agent: null, why: 'unhandled_event' });
    expect(route({ ...e, payload: { ...e.payload, action: undefined } })).toEqual({
      agent: null,
      why: 'unhandled_event',
    });
  });

  it('passes a missing updated_at on as empty, which wakeAt treats as now', () => {
    const e = event();
    expect(route({ ...e, payload: { ...e.payload, pull_request: { number: 7 } } })).toMatchObject({
      pr: 7,
      updatedAt: '',
    });
  });
});

describe('route: cheatsheet-review trigger label (ADR 0017)', () => {
  const labeled = (
    over: { label?: string; sender?: string; repo?: string; action?: string } = {},
  ) =>
    event(
      {
        repo: over.repo ?? 'mackowski/custodes-sandbox',
        payload: {
          action: over.action ?? 'labeled',
          repository: { full_name: over.repo ?? 'mackowski/custodes-sandbox' },
          sender: { login: over.sender ?? 'mackowski' },
          pull_request: { number: 12 },
          label: { name: over.label ?? 'custodes_cheatsheet_review' },
        },
      },
      over.action ?? 'labeled',
    );

  it('wakes cheatsheet-review when the configured actor adds the label on the sandbox', () => {
    expect(route(labeled())).toEqual({
      agent: 'cheatsheet-review',
      instance: SANDBOX_INSTANCE,
      pr: 12,
    });
    expect(route(labeled({ sender: 'MacKowski' }))).toMatchObject({ agent: 'cheatsheet-review' });
  });

  it('ignores another label', () => {
    expect(route(labeled({ label: 'bug' }))).toEqual({ agent: null, why: 'unhandled_event' });
  });

  it('ignores the right label added by someone else', () => {
    expect(route(labeled({ sender: 'attacker' }))).toEqual({
      agent: null,
      why: 'unhandled_event',
    });
  });

  it('wakes the OWASP instance for the operator label on OWASP, and nobody else', () => {
    expect(route(labeled({ repo: 'OWASP/CheatSheetSeries' }))).toEqual({
      agent: 'cheatsheet-review',
      instance: OWASP_INSTANCE,
      pr: 12,
    });
    expect(route(labeled({ repo: 'OWASP/CheatSheetSeries', sender: 'contributor' }))).toEqual({
      agent: null,
      why: 'unhandled_event',
    });
  });

  it('ignores the label on a repository that is not an instance', () => {
    expect(route(labeled({ repo: 'OWASP/wstg' }))).toMatchObject({ agent: null });
  });

  it('ignores an unlabeled event and a labeled event without a label', () => {
    expect(route(labeled({ action: 'unlabeled' }))).toEqual({
      agent: null,
      why: 'unhandled_event',
    });
    const e = labeled();
    expect(route({ ...e, payload: { ...e.payload, label: undefined } })).toEqual({
      agent: null,
      why: 'unhandled_event',
    });
  });

  it('ignores the label on an issue event', () => {
    const e = labeled();
    expect(route({ ...e, event: 'issues' })).toEqual({ agent: null, why: 'unhandled_event' });
  });
});

describe('pr-gate notify', () => {
  it('schedules one wake-up per slot, however many events arrive', async () => {
    const gate = await getAgentByName(testEnv.PrGateAgent, SANDBOX_INSTANCE);
    // Recent and fixed, so both calls land on the same slot whatever the clock does in between.
    const updatedAt = new Date().toISOString();
    const a = await gate.notify(updatedAt);
    const b = await gate.notify(updatedAt);
    expect(b).toEqual(a);
    const at = Date.parse(a.at);
    expect(at % (5 * 60_000)).toBe(0);
    expect(at - Date.parse(updatedAt)).toBeGreaterThanOrEqual(30 * 60_000);
    expect(at - Date.parse(updatedAt)).toBeLessThanOrEqual(35 * 60_000);
  });
});

describe('pr-gate single flight', () => {
  it('refuses a second poll while one runs and schedules it for the next slot', async () => {
    const gate = await getAgentByName(testEnv.PrGateAgent, SANDBOX_INSTANCE);
    // Calls from the test reach the object one after another, so set the flag the way a running
    // poll does; in production a cron and a wake-up interleave at the broker fetch.
    const busy = await runInDurableObject(gate, async (agent: PrGateAgent) => {
      (agent as unknown as { pollingSince: number | null }).pollingSince = Date.now();
      try {
        return await agent.poll();
      } finally {
        (agent as unknown as { pollingSince: number | null }).pollingSince = null;
      }
    });
    expect(busy.ok).toBe(false);
    const at = /^poll in progress; again at (.+)$/.exec(busy.detail)?.[1];
    expect(at).toBeDefined();
    expect(Date.parse(at ?? '') % (5 * 60_000)).toBe(0);
    expect(Date.parse(at ?? '') - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  });

  it('releases the flag after a poll, whatever it returned', async () => {
    const gate = await getAgentByName(testEnv.PrGateAgent, SANDBOX_INSTANCE);
    await gate.poll(); // fails at the stub broker
    expect((await gate.poll()).detail).not.toContain('poll in progress');
  });
});

describe('queue consumers (each agent has its own Worker and queue, ADR 0018)', () => {
  const message = (body: unknown) => ({
    id: 'm-1',
    body,
    attempts: 1,
    timestamp: new Date(),
    ack: vi.fn(),
    retry: vi.fn(),
  });
  const batch = (queue: string, ...messages: ReturnType<typeof message>[]) =>
    ({ queue, messages }) as unknown as MessageBatch;
  const labeled = (number = 12) =>
    event(
      {
        repo: 'mackowski/custodes-sandbox',
        payload: {
          action: 'labeled',
          repository: { full_name: 'mackowski/custodes-sandbox' },
          sender: { login: 'mackowski' },
          pull_request: { number },
          label: { name: 'custodes_cheatsheet_review' },
        },
      },
      'labeled',
    );
  const logged = async (run: () => Promise<void>) => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return logs;
  };

  it('pr-gate: schedules a poll for an opened pull request and acks', async () => {
    const msg = message(event({ repo: 'mackowski/custodes-sandbox' }));
    const logs = await logged(() =>
      prGateWorker.queue(batch('custodes-inbound-pr-gate', msg), testEnv),
    );
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes('"queue.dispatch"') && l.includes('"pr-gate"'))).toBe(true);
  });

  it('cheatsheet-review: schedules a review for the trigger label and acks', async () => {
    const msg = message(labeled());
    const logs = await logged(() =>
      cheatsheetReviewWorker.queue(batch('custodes-inbound-cheatsheet-review', msg), testEnv),
    );
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(
      logs.some((l) => l.includes('"queue.dispatch"') && l.includes('"cheatsheet-review"')),
    ).toBe(true);
  });

  it('each drops what is for the other agent, and malformed or unlisted events, without retrying', async () => {
    const bodies = [
      event({ repo: 'attacker/repo' }),
      event({}, 'edited'),
      { bogus: true },
      // the other agent's event
      labeled(),
      event({ repo: 'mackowski/custodes-sandbox' }),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const prGate = bodies.slice(0, 4).map(message);
      const review = [...bodies.slice(0, 3), bodies[4]].map(message);
      const logs = await logged(async () => {
        await prGateWorker.queue(batch('custodes-inbound-pr-gate', ...prGate), testEnv);
        await cheatsheetReviewWorker.queue(
          batch('custodes-inbound-cheatsheet-review', ...review),
          testEnv,
        );
      });
      for (const msg of [...prGate, ...review]) {
        expect(msg.ack).toHaveBeenCalledOnce();
        expect(msg.retry).not.toHaveBeenCalled();
      }
      // Dropped, not dispatched: no agent was woken (review of #122, L4).
      expect(logs.filter((l) => l.includes('"queue.dispatch"'))).toEqual([]);
      expect(warn.mock.calls.filter(([m]) => String(m).includes('"queue.ignored"'))).toHaveLength(
        8,
      );
    } finally {
      warn.mockRestore();
    }
  });
});
