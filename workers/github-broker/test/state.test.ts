import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { KillSwitch } from '@custodes/core';
import { Hono } from 'hono';
import { agentRoutes, type App } from '../src/index.js';

const kill = () => new KillSwitch(env.KILL_SWITCH);
// /v1/state itself: the routes every agent Worker's signed entrypoint serves, run with an `admit`
// that lets pr-gate and cheatsheet-review through (signing is tested in callers.test.ts).
// A verified call as callerApp's middleware would set it; agentRoutes refuses requests without one.
const signedApp: App = new Hono();
signedApp.use('*', async (c, next) => {
  c.set('call', {
    caller: 'custodes-pr-gate',
    kid: 'pr-gate-20261109-aaaaaaaa',
    signature: 'x',
    timestamp: '0',
    nonce: 'n',
    bodySha256: '0'.repeat(64),
    admittedAt: 0,
  });
  await next();
});
const app = agentRoutes(
  signedApp,
  (id) => (id === 'pr-gate' || id === 'cheatsheet-review' ? null : `agent ${id} is not served`),
  'test',
);
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
