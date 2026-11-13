import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { KillSwitch } from '@custodes/core';
import { sharedAgentApp } from '../src/index.js';
import { policy } from '../src/policy.js';

const kill = () => new KillSwitch(env.KILL_SWITCH);
// /v1/state itself, on the shared entrypoint, for two agents that run there. pr-gate has its own
// Worker now (isolated); this copy of the policy keeps it on the shared app for the test only.
const app = sharedAgentApp({
  ...policy,
  agents: { ...policy.agents, 'pr-gate': { ...policy.agents['pr-gate']!, isolated: false } },
  reads: { ...policy.reads, 'pr-gate': { ...policy.reads['pr-gate']!, isolated: false } },
});
const state = (body: unknown) =>
  app.request(
    '/v1/state',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );

afterEach(async () => {
  await kill().resume('pr-gate');
  await kill().resume('*');
});

describe('broker /v1/state (#103, threat T1: agents do not bind the kill switch)', () => {
  it('answers not halted when no flag is set', async () => {
    const res = await state({ agentId: 'pr-gate' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ halted: false });
  });

  it("answers the agent's own halt flag", async () => {
    await kill().halt('pr-gate', 'wrong close', 'operator@example.com');
    // Who halted it (the operator's e-mail) and when are not given to agents.
    expect(await (await state({ agentId: 'pr-gate' })).json()).toEqual({
      halted: true,
      reason: 'wrong close',
    });
    // Another agent is not affected by it.
    expect(await (await state({ agentId: 'cheatsheet-review' })).json()).toEqual({
      halted: false,
    });
  });

  it('answers the fleet-wide halt for every agent', async () => {
    await kill().halt('*', 'incident', 'operator@example.com');
    expect(await (await state({ agentId: 'cheatsheet-review' })).json()).toMatchObject({
      halted: true,
    });
  });

  it('refuses a malformed request', async () => {
    expect((await state({ agentId: 'Not An Id!' })).status).toBe(400);
    expect((await state(null)).status).toBe(400);
  });

  it('has no way to change the state: only POST /v1/state exists, and it only reads', async () => {
    await kill().halt('pr-gate', 'stay halted', 'operator@example.com');
    await state({ agentId: 'pr-gate', halted: false });
    expect(await kill().isHalted('pr-gate')).toBe(true);
  });
});
