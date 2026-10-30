import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { getAgentByName } from 'agents';
import { describe, expect, it, vi } from 'vitest';
import type { InboundEvent } from '@custodes/schema';
import worker from '../src/index.js';
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

describe('queue consumer', () => {
  const message = (body: unknown) => ({
    id: 'm-1',
    body,
    attempts: 1,
    timestamp: new Date(),
    ack: vi.fn(),
    retry: vi.fn(),
  });
  const run = async (body: unknown) => {
    const msg = message(body);
    const batch = { queue: 'custodes-inbound', messages: [msg] } as unknown as MessageBatch;
    await worker.queue(batch, testEnv);
    return msg;
  };

  it('schedules pr-gate and acks', async () => {
    const msg = await run(event({ repo: 'mackowski/custodes-sandbox' }));
    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('acks ignored and malformed events without retrying', async () => {
    for (const body of [event({ repo: 'attacker/repo' }), event({}, 'edited'), { bogus: true }]) {
      const msg = await run(body);
      expect(msg.ack).toHaveBeenCalledOnce();
      expect(msg.retry).not.toHaveBeenCalled();
    }
  });
});
