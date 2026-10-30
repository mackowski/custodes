import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canonicalJson,
  importPublicKey,
  KillSwitch,
  sha256Hex,
  verifyAttestation,
} from '@custodes/core';
import { INLINE_COMMENT_MARKER, type BrokerRequest } from '@custodes/schema';
import { act } from '../src/act.js';
import { createApproval, decideApproval } from '../src/approvals.js';
import { keyring, type BrokerEnv } from '../src/env.js';
import { ApprovalStore, AuditStore } from '../src/store.js';

const runId = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
const base: Omit<BrokerRequest, 'action'> = {
  agentId: 'hello',
  agentVersion: '0.1.0',
  runId,
  triggeredBy: { kind: 'cli', ref: 'test' },
};
const comment = (repo: string, body = 'x'): BrokerRequest['action'] => ({
  type: 'issue.comment',
  repo,
  issue: 1,
  body,
});

let testEnv: BrokerEnv;

beforeAll(() => {
  // Test double for the Secrets Store PAT binding. GitHub is never reached in these tests because
  // every case is denied before the execute step.
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

describe('broker act()', () => {
  it('denies a repo outside policy and signs the denial with a keyring-generated key', async () => {
    const res = await act(testEnv, { ...base, action: comment('evil/repo') });
    expect(res.ok).toBe(false);
    if (res.ok || !res.attestationId) throw new Error('expected a signed denial');
    expect(res.code).toBe('policy_denied');
    const att = await new AuditStore(env.AUDIT).get(res.attestationId);
    expect(att?.record.decision).toBe('denied');
    const keys = await keyring(env).publicKeys();
    const key = keys.find((k) => k.keyId === att?.keyId && k.agentId === 'hello');
    expect(key).toBeDefined();
    expect((await verifyAttestation(att, await importPublicKey(key!.jwk))).valid).toBe(true);
  });

  it('keeps old attestations verifiable after key rotation', async () => {
    const before = await act(testEnv, { ...base, action: comment('evil/repo') });
    if (before.ok || !before.attestationId) throw new Error('expected a signed denial');
    const rotated = await keyring(env).rotate('hello');
    const after = await act(testEnv, { ...base, action: comment('evil/repo') });
    if (after.ok || !after.attestationId) throw new Error('expected a signed denial');
    const store = new AuditStore(env.AUDIT);
    const [attBefore, attAfter] = [
      await store.get(before.attestationId),
      await store.get(after.attestationId),
    ];
    expect(attAfter?.keyId).toBe(rotated.keyId);
    expect(attBefore?.keyId).not.toBe(rotated.keyId);
    const keys = await keyring(env).publicKeys();
    for (const att of [attBefore, attAfter]) {
      const key = keys.find((k) => k.keyId === att?.keyId)!;
      expect((await verifyAttestation(att, await importPublicKey(key.jwk))).valid).toBe(true);
    }
    expect(keys.find((k) => k.keyId === attBefore?.keyId)?.retiredAt).toBeDefined();
  });

  it('denies when halted', async () => {
    const ks = new KillSwitch(env.KILL_SWITCH);
    await ks.halt('hello', 'test', 'tester');
    const res = await act(testEnv, { ...base, action: comment('OWASP/CheatSheetSeries') });
    expect(res).toMatchObject({ ok: false, code: 'halted' });
    await ks.resume('hello');
  });

  it('requires an approval for a hitl agent', async () => {
    const res = await act(testEnv, { ...base, action: comment('OWASP/CheatSheetSeries') });
    expect(res).toMatchObject({ ok: false, code: 'approval_required' });
  });

  it('rejects an approval issued for a different action', async () => {
    const store = new ApprovalStore(env.AUDIT);
    const other = comment('OWASP/CheatSheetSeries', 'a different comment');
    const approval = await store.create(
      { ...base, action: other },
      'because',
      await sha256Hex(canonicalJson(other)),
      3600,
    );
    expect(await store.decide(approval.id, 'approved', 'tester')).toBe('ok');
    const res = await act(testEnv, {
      ...base,
      approvalId: approval.id,
      action: comment('OWASP/CheatSheetSeries'),
    });
    expect(res).toMatchObject({ ok: false, code: 'approval_invalid' });
  });

  it('refuses an unknown agent without minting a key', async () => {
    const res = await act(testEnv, {
      ...base,
      agentId: 'ghost',
      action: comment('OWASP/CheatSheetSeries'),
    });
    expect(res).toMatchObject({ ok: false, code: 'unknown_agent' });
    expect((await keyring(env).publicKeys()).some((k) => k.agentId === 'ghost')).toBe(false);
  });
});

describe('broker act() when execution fails half way', () => {
  it('signs the failure under the trailer id and counts it against the rate limit', async () => {
    const gate: BrokerRequest = {
      ...base,
      agentId: 'pr-gate',
      action: { type: 'pr.close', repo: 'OWASP/CheatSheetSeries', pull: 7, body: 'closing' },
    };
    let postedBody = '';
    const calls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (init?.method === 'POST') {
        postedBody = (JSON.parse(init.body as string) as { body: string }).body;
        return Promise.resolve(
          Response.json({ html_url: 'https://github.com/OWASP/CheatSheetSeries/pull/7#c1' }),
        );
      }
      return Promise.resolve(new Response('Resource not accessible', { status: 403 }));
    });
    const store = new AuditStore(env.AUDIT);
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const before = await store.countAllowedSince('pr-gate', 'OWASP/CheatSheetSeries', hourAgo);
    const res = await act(testEnv, gate);
    expect(calls).toEqual([
      'POST /repos/OWASP/CheatSheetSeries/issues/7/comments',
      'PATCH /repos/OWASP/CheatSheetSeries/pulls/7',
    ]);
    if (res.ok || !res.attestationId) throw new Error('expected a signed github_error');
    expect(res.code).toBe('github_error');
    // The posted comment's trailer names this attestation, and it exists and verifies.
    expect(postedBody).toContain(res.attestationId);
    const att = await store.get(res.attestationId);
    expect(att?.record.decision).toBe('denied');
    expect(att?.record.reason).toMatch(/^execution failed: /);
    expect(await store.countAllowedSince('pr-gate', 'OWASP/CheatSheetSeries', hourAgo)).toBe(
      before + 1,
    );
  });
});

describe('broker act() at the rate limit', () => {
  it('refuses the sixth close on one repository and still allows another repository', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
      Promise.resolve(
        init?.method === 'POST'
          ? Response.json({ html_url: 'https://github.com/x/y/pull/1#c' })
          : Response.json({ state: 'closed' }),
      ),
    );
    const close = (repo: string, pull: number): BrokerRequest => ({
      ...base,
      agentId: 'pr-gate',
      action: { type: 'pr.close', repo, pull, body: 'closing' },
    });
    for (let i = 1; i <= 5; i++) {
      const res = await act(testEnv, close('mackowski/custodes-sandbox', 100 + i));
      expect(res.ok, `close ${i}`).toBe(true);
    }
    const sixth = await act(testEnv, close('mackowski/custodes-sandbox', 106));
    expect(sixth).toMatchObject({ ok: false, code: 'policy_denied' });
    if (sixth.ok) throw new Error('expected a refusal');
    expect(sixth.reason).toMatch(/rate limit .* mackowski\/custodes-sandbox/);
    // OWASP has its own budget (the half-done close above used one of its five).
    expect(await act(testEnv, close('OWASP/CheatSheetSeries', 200))).toMatchObject({ ok: true });
  });
});

describe('broker act() for cheatsheet-review', () => {
  const inline = (agentId: string, repo = 'OWASP/CheatSheetSeries'): BrokerRequest => ({
    ...base,
    agentId,
    action: {
      type: 'pr.review.inline',
      repo,
      pull: 3,
      commitId: '0123456789abcdef0123456789abcdef01234567',
      event: 'COMMENT',
      body: 'LLM review',
      comments: [{ path: 'cheatsheets/A.md', line: 2, side: 'RIGHT', body: 'x' }],
    },
  });

  it('denies inline reviews from any other agent before reaching GitHub', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const agentId of ['pr-gate', 'hello']) {
      expect(await act(testEnv, inline(agentId))).toMatchObject({
        ok: false,
        code: 'policy_denied',
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts directly on the sandbox, which needs no approval', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          Response.json({ html_url: 'https://github.com/mackowski/custodes-sandbox/pull/3#r1' }),
        ),
      );
    expect(
      await act(testEnv, inline('cheatsheet-review', 'mackowski/custodes-sandbox')),
    ).toMatchObject({ ok: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('needs an approval to post on OWASP (ADR 0017 amendment), before reaching GitHub', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await act(testEnv, inline('cheatsheet-review'))).toMatchObject({
      ok: false,
      code: 'approval_required',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts one signed inline review once approved, with the agent PAT and a marker on each comment', async () => {
    let sent:
      | {
          url: string;
          auth: string;
          body: { body: string; commit_id: string; comments: { body: string }[] };
        }
      | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      sent = {
        url: new URL(url).pathname,
        auth: (init?.headers as Record<string, string>)['authorization'] ?? '',
        body: JSON.parse(init?.body as string) as {
          body: string;
          commit_id: string;
          comments: { body: string }[];
        },
      };
      return Promise.resolve(
        Response.json({ html_url: 'https://github.com/OWASP/CheatSheetSeries/pull/3#r1' }),
      );
    });
    const created = await createApproval(testEnv, inline('cheatsheet-review'), 'r');
    if (!created.ok) throw new Error(created.error);
    const out = await decideApproval(testEnv, created.approval.id, 'approved', 'op@example.org');
    if (out.result !== 'ok' || out.decision !== 'approved') throw new Error('expected approval');
    const res = out.executed;
    if (!res.ok) throw new Error(`expected success, got ${res.code}`);
    expect(sent?.url).toBe('/repos/OWASP/CheatSheetSeries/pulls/3/reviews');
    expect(sent?.auth).toBe('Bearer review-token');
    expect(sent?.body.commit_id).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(sent?.body.body).toContain(res.attestationId);
    expect(sent?.body.comments[0]?.body).toBe(`${INLINE_COMMENT_MARKER}x`);
  });
});
