import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { KillSwitch } from '@custodes/core';
import type { BrokerRequest } from '@custodes/schema';
import { approvalByToken, createApproval, decideApproval } from '../src/approvals.js';
import type { BrokerEnv } from '../src/env.js';
import broker, { BrokerAdmin } from '../src/index.js';
import { AuditStore } from '../src/store.js';

const base: Omit<BrokerRequest, 'action'> = {
  agentId: 'cheatsheet-review',
  agentVersion: '0.1.0',
  runId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
  triggeredBy: { kind: 'webhook', ref: 'label:1' },
};
const review = (body = 'LLM review'): BrokerRequest => ({
  ...base,
  action: {
    type: 'pr.review.inline',
    repo: 'mackowski/custodes-sandbox',
    pull: 3,
    commitId: '0123456789abcdef0123456789abcdef01234567',
    event: 'COMMENT',
    body,
    comments: [],
  },
});

let testEnv: BrokerEnv;
beforeAll(() => {
  testEnv = {
    ...env,
    PAT_HELLO: { get: () => Promise.resolve('unused') },
    PAT_PR_GATE: { get: () => Promise.resolve('unused') },
    PAT_CHEATSHEET_REVIEW: { get: () => Promise.resolve('review-token') },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

const githubOk = () =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(() =>
      Promise.resolve(
        Response.json({ html_url: 'https://github.com/mackowski/custodes-sandbox/pull/3#r1' }),
      ),
    );

async function created(req = review()) {
  const c = await createApproval(testEnv, req, 'COMMENT, 0 suggestions');
  if (!c.ok) throw new Error(c.error);
  return c;
}

describe('approval requests', () => {
  it('are refused for an action the policy denies or that needs no approval', async () => {
    expect(
      await createApproval(
        testEnv,
        { ...review(), action: { ...review().action, repo: 'evil/r' } },
        'r',
      ),
    ).toMatchObject({ ok: false, status: 403 });
    // Removing the trigger label needs no approval: nothing to park in the operator's queue.
    expect(
      await createApproval(
        testEnv,
        {
          ...base,
          action: {
            type: 'issue.label.remove',
            repo: 'mackowski/custodes-sandbox',
            issue: 3,
            labels: ['custodes_cheatsheet_review'],
          },
        },
        'r',
      ),
    ).toMatchObject({ ok: false, status: 403, error: 'this action needs no approval' });
    expect(await createApproval(testEnv, { ...review(), agentId: 'nobody' }, 'r')).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('come with a token that finds exactly that approval, and reading it decides nothing', async () => {
    const c = await created();
    const found = await approvalByToken(testEnv, c.token);
    expect(found).toMatchObject({ ok: true, approval: { id: c.approval.id, status: 'pending' } });
    // The stored request and its hash are not part of what the page gets.
    expect(JSON.stringify(found)).not.toContain('actionHash');
    expect(JSON.stringify(found)).not.toContain('"request"');
  });
});

describe('approval tokens', () => {
  it('do not open another approval, even of the same agent', async () => {
    const a = await created(review('first'));
    const b = await created(review('second'));
    const [id, exp, sig] = a.token.split('.') as [string, string, string];
    const swapped = `${b.approval.id}.${exp}.${sig}`;
    expect(id).toBe(a.approval.id);
    expect(await approvalByToken(testEnv, swapped)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('are refused when tampered with, malformed or unknown', async () => {
    const a = await created();
    const [id, exp, sig] = a.token.split('.') as [string, string, string];
    expect(await approvalByToken(testEnv, `${id}.${Number(exp) + 60}.${sig}`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(await approvalByToken(testEnv, 'x.y.z')).toEqual({ ok: false, reason: 'malformed' });
    expect(
      await approvalByToken(testEnv, `0d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44.${exp}.${sig}`),
    ).toEqual({ ok: false, reason: 'not_found' });
  });

  it('expire after a day', async () => {
    const a = await createApproval(testEnv, review(), 'r', new Date(Date.now() - 2 * 86_400_000));
    if (!a.ok) throw new Error(a.error);
    expect(await approvalByToken(testEnv, a.token)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('deciding', () => {
  it('posts the stored review once on approval; a second click does nothing', async () => {
    const fetchSpy = githubOk();
    const c = await created();
    const first = await decideApproval(testEnv, c.approval.id, 'approved', 'op@example.org');
    expect(first).toMatchObject({ result: 'ok', decision: 'approved', executed: { ok: true } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const second = await decideApproval(testEnv, c.approval.id, 'approved', 'op@example.org');
    expect(second).toEqual({ result: 'not_pending' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The post is in the signed audit log like any other side effect.
    if (first.result !== 'ok' || first.decision !== 'approved' || !first.executed.ok)
      throw new Error('expected a post');
    const att = await new AuditStore(env.AUDIT).get(first.executed.attestationId);
    expect(att?.record.decision).toBe('allowed');
  });

  it('posts nothing on rejection', async () => {
    const fetchSpy = githubOk();
    const c = await created();
    expect(await decideApproval(testEnv, c.approval.id, 'rejected', 'op@example.org')).toEqual({
      result: 'ok',
      decision: 'rejected',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still honours the kill switch after approval', async () => {
    const fetchSpy = githubOk();
    const c = await created();
    const ks = new KillSwitch(env.KILL_SWITCH);
    await ks.halt('cheatsheet-review', 'test', 'test');
    try {
      const out = await decideApproval(testEnv, c.approval.id, 'approved', 'op@example.org');
      expect(out).toMatchObject({ executed: { ok: false, code: 'halted' } });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await ks.resume('cheatsheet-review');
    }
  });
});

describe('entrypoints', () => {
  const call = (fetcher: { fetch: (r: Request) => Response | Promise<Response> }, path: string) =>
    fetcher.fetch(
      new Request(`https://broker.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approved', by: 'agent' }),
      }),
    );

  it('give agents no way to decide approvals, read the audit log or rotate keys', async () => {
    const c = await created();
    const agents = {
      fetch: (r: Request) =>
        broker.fetch(r as Parameters<typeof broker.fetch>[0], testEnv, {} as ExecutionContext),
    };
    for (const path of [
      `/v1/approvals/${c.approval.id}/decide`,
      `/v1/approvals/token/${c.token}/decide`,
      '/v1/keys/cheatsheet-review/rotate',
    ])
      expect((await call(agents, path)).status).toBe(404);
    for (const path of ['/v1/approvals', `/v1/approvals/token/${c.token}`, '/v1/attestations'])
      expect((await agents.fetch(new Request(`https://broker.internal${path}`))).status).toBe(404);
    const after = await approvalByToken(testEnv, c.token);
    expect(after).toMatchObject({ ok: true, approval: { status: 'pending' } });
  });

  it('let the admin entrypoint decide through a valid token only', async () => {
    githubOk();
    const c = await created();
    const admin = new BrokerAdmin({} as ExecutionContext, testEnv);
    expect((await call(admin, `/v1/approvals/token/x.1.y/decide`)).status).toBe(404);
    const res = await call(admin, `/v1/approvals/token/${c.token}/decide`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: 'ok', decision: 'approved' });
  });
});
