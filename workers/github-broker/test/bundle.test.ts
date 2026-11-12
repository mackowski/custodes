import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, KillSwitch, sha256Hex } from '@custodes/core';
import {
  type ApprovalBundle,
  type BrokerAction,
  type BundleApprovalAsk,
  type IssueSnapshot,
} from '@custodes/schema';
import { act } from '../src/act.js';
import {
  approvalByToken,
  createApproval,
  createBundleApproval,
  decideApproval,
  mentionsIn,
  readIssueThread,
} from '../src/approvals.js';
import type { BrokerEnv } from '../src/env.js';
import { ApprovalStore } from '../src/store.js';

const REPO = 'mackowski/custodes-sandbox';
const runId = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
const NOW = new Date('2026-11-12T10:00:00.000Z');

let testEnv: BrokerEnv;
beforeAll(() => {
  testEnv = {
    ...env,
    PAT_TRIAGE_APPLY: { get: () => Promise.resolve('apply-token') },
    PAT_READONLY: { get: () => Promise.resolve('read-token') },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});

interface FakeIssue {
  state?: 'open' | 'closed';
  author?: string;
  labels?: string[];
  assignees?: string[];
  /** One comment per entry: the login who wrote it. */
  commenters?: string[];
  pull?: boolean;
  /** Make a write fail: `${METHOD} ${path-suffix}` -> status. */
  failWrites?: Record<string, number>;
  /** Do not echo the assignee back (GitHub silently skipped it). */
  dropAssignee?: boolean;
}
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake GitHub for one issue. Reads answer from `issue`; writes are recorded in `calls`. */
function fakeGithub(issue: FakeIssue = {}, number = 1) {
  const calls: Call[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
    const base = `/repos/${REPO}/issues/${number}`;
    if (method === 'GET' && path === base) {
      return Promise.resolve(
        Response.json({
          state: issue.state ?? 'open',
          user: { login: issue.author ?? 'author' },
          labels: (issue.labels ?? []).map((name) => ({ name })),
          assignees: (issue.assignees ?? []).map((login) => ({ login })),
          comments: (issue.commenters ?? []).length,
          updated_at: UPDATED,
          ...(issue.pull ? { pull_request: {} } : {}),
        }),
      );
    }
    if (method === 'GET' && path === `${base}/comments`) {
      const page = Number(url.searchParams.get('page'));
      const all = (issue.commenters ?? []).map((login, i) => ({
        id: i + 1,
        updated_at: UPDATED,
        user: { login },
      }));
      return Promise.resolve(Response.json(all.slice((page - 1) * 100, page * 100)));
    }
    calls.push({ method, path, body });
    const failing = Object.entries(issue.failWrites ?? {}).find(
      ([k]) => k.startsWith(method) && path.endsWith(k.slice(method.length + 1)),
    );
    if (failing) return Promise.resolve(new Response('nope', { status: failing[1] }));
    if (path === `${base}/assignees`) {
      const login = (body as { assignees: string[] }).assignees[0]!;
      return Promise.resolve(
        Response.json({ assignees: issue.dropAssignee ? [] : [{ login }] }, { status: 201 }),
      );
    }
    if (path === `${base}/comments`)
      return Promise.resolve(
        Response.json(
          { html_url: `https://github.com/${REPO}/issues/${number}#c1` },
          { status: 201 },
        ),
      );
    return Promise.resolve(Response.json([]));
  });
  return { calls, spy, writes: () => calls.filter((c) => c.method !== 'GET') };
}

const UPDATED = '2026-11-10T10:00:00Z';
/** The broker's commentsDigest for the fake's comments (ids 1..n, all at UPDATED). */
const digestOf = (commenters: string[]) =>
  createHash('sha256')
    .update(canonicalJson(commenters.map((_c, i) => [i + 1, UPDATED])))
    .digest('hex');
const snapshotOf = (i: FakeIssue = {}): IssueSnapshot => ({
  state: i.state ?? 'open',
  labels: [...(i.labels ?? [])].sort(),
  assignees: [...(i.assignees ?? [])].sort(),
  comments: (i.commenters ?? []).length,
  updatedAt: UPDATED,
  commentsDigest: digestOf(i.commenters ?? []),
});

const FULL = (n: number): BrokerAction[] => [
  { type: 'issue.assign', repo: REPO, issue: n, assignees: ['author'] },
  { type: 'issue.label.add', repo: REPO, issue: n, labels: ['docker'] },
  { type: 'issue.label.remove', repo: REPO, issue: n, labels: ['python'] },
  { type: 'issue.comment', repo: REPO, issue: n, body: 'Thanks @author, applied.' },
];

function ask(
  n: number,
  actions: BrokerAction[],
  snapshot: IssueSnapshot,
  agentId = 'triage-apply',
) {
  const bundle: ApprovalBundle = { actions, snapshot };
  const a: BundleApprovalAsk = {
    request: {
      agentId,
      agentVersion: '0.1.0',
      runId,
      triggeredBy: { kind: 'cli', ref: `issue:${n}` },
      bundle,
    },
    rationale: 'proposal',
  };
  return a;
}

let counter = 100;
/** A fresh issue number per test so pending approvals of earlier tests are never superseded. */
const nextIssue = () => ++counter;

async function created(opts: { issue?: FakeIssue; actions?: (n: number) => BrokerAction[] } = {}) {
  const n = nextIssue();
  const issue: FakeIssue = { labels: ['python'], commenters: ['carol'], ...opts.issue };
  const gh = fakeGithub(issue, n);
  const out = await createBundleApproval(
    testEnv,
    ask(n, (opts.actions ?? FULL)(n), snapshotOf(issue)),
    NOW,
  );
  if (!out.ok) throw new Error(out.error);
  return { n, issue, gh, ...out };
}

const decide = (id: string, now = NOW) =>
  decideApproval(testEnv, id, 'approved', 'op@example.org', now);

describe('createBundleApproval', () => {
  it('refuses a comment with an HTML character reference (it renders as @)', async () => {
    const n = nextIssue();
    const issue = { commenters: [] };
    fakeGithub(issue, n);
    for (const body of ['hi &#64;victim', 'hi &#x40;victim', 'hi &commat;victim', 'a &amp; b']) {
      const actions: BrokerAction[] = [{ type: 'issue.comment', repo: REPO, issue: n, body }];
      expect(
        await createBundleApproval(testEnv, ask(n, actions, snapshotOf(issue)), NOW),
        body,
      ).toEqual({
        ok: false,
        status: 403,
        error: 'comment contains an HTML character reference',
      });
    }
  });

  it('refuses as stale when a comment was edited or the issue updated, with the same count', async () => {
    const n = nextIssue();
    const issue = { commenters: ['bob'] };
    fakeGithub(issue, n);
    const edited = { ...snapshotOf(issue), commentsDigest: digestOf(['bob', 'x']) };
    const touched = { ...snapshotOf(issue), updatedAt: '2026-11-11T10:00:00Z' };
    for (const snap of [edited, touched])
      expect(await createBundleApproval(testEnv, ask(n, FULL(n), snap), NOW)).toEqual({
        ok: false,
        status: 403,
        error: 'stale: the issue changed since the proposal',
      });
  });

  it('never gives a bundle-only agent a one-action approval (review M1)', async () => {
    const out = await createApproval(
      testEnv,
      {
        agentId: 'triage-apply',
        agentVersion: '0.1.0',
        runId,
        triggeredBy: { kind: 'cli', ref: 'm1' },
        action: { type: 'issue.assign', repo: REPO, issue: 1, assignees: ['anyone'] },
      },
      'x',
      NOW,
    );
    expect(out).toEqual({
      ok: false,
      status: 403,
      error: 'this agent asks for bundle approvals only',
    });
  });

  it('stores one approval for the whole bundle, with a 168 h ttl on approval and token', async () => {
    const c = await created();
    expect(c.approval.bundle?.actions.map((a) => a.type)).toEqual([
      'issue.assign',
      'issue.label.add',
      'issue.label.remove',
      'issue.comment',
    ]);
    expect(c.approval.expiresAt).toBe(new Date(NOW.getTime() + 168 * 3600_000).toISOString());
    const [, exp] = c.token.split('.') as [string, string];
    expect(Number(exp)).toBe(Math.floor(NOW.getTime() / 1000) + 168 * 3600);
    expect(c.gh.writes()).toEqual([]);
  });

  it('refuses the whole bundle when policy denies one action (a repo or label outside policy)', async () => {
    const n = nextIssue();
    const issue = { commenters: [] };
    fakeGithub(issue, n);
    const bad = FULL(n);
    bad[1] = {
      type: 'issue.label.add',
      repo: REPO,
      issue: n,
      labels: ['custodes_cheatsheet_review'],
    };
    expect(await createBundleApproval(testEnv, ask(n, bad, snapshotOf(issue)), NOW)).toMatchObject({
      ok: false,
      status: 403,
    });
    const other = FULL(n).map((a) => ({ ...a, repo: 'OWASP/CheatSheetSeries' }));
    expect(
      await createBundleApproval(testEnv, ask(n, other as BrokerAction[], snapshotOf(issue)), NOW),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses an agent that is not in the policy and one whose actions need no approval', async () => {
    const n = nextIssue();
    fakeGithub({}, n);
    expect(
      await createBundleApproval(testEnv, ask(n, FULL(n), snapshotOf(), 'nobody'), NOW),
    ).toMatchObject({ ok: false, status: 404 });
    // pr-gate may not comment at all: denied by policy, not parked in the queue.
    expect(
      await createBundleApproval(testEnv, ask(n, FULL(n), snapshotOf(), 'pr-gate'), NOW),
    ).toMatchObject({ ok: false, status: 403 });
  });

  it('is refused while the agent is halted, and asks GitHub nothing', async () => {
    const n = nextIssue();
    const gh = fakeGithub({}, n);
    const ks = new KillSwitch(env.KILL_SWITCH);
    await ks.halt('triage-apply', 'test', 'test');
    try {
      expect(await createBundleApproval(testEnv, ask(n, FULL(n), snapshotOf()), NOW)).toEqual({
        ok: false,
        status: 403,
        error: 'agent is halted',
      });
      expect(gh.spy).not.toHaveBeenCalled();
    } finally {
      await ks.resume('triage-apply');
    }
  });

  it('refuses with a stale reason when the issue changed since the snapshot', async () => {
    const n = nextIssue();
    fakeGithub({ labels: ['python', 'docker'], commenters: [] }, n);
    const out = await createBundleApproval(
      testEnv,
      ask(n, FULL(n), snapshotOf({ labels: ['python'], commenters: [] })),
      NOW,
    );
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect((out as { error: string }).error).toMatch(/^stale/);
  });

  it('refuses a new comment, a closed issue and a changed assignee as stale', async () => {
    for (const changed of [
      { commenters: ['carol', 'dave'] },
      { state: 'closed' as const },
      { assignees: ['carol'] },
    ]) {
      const n = nextIssue();
      fakeGithub({ commenters: ['carol'], ...changed }, n);
      const out = await createBundleApproval(
        testEnv,
        ask(n, FULL(n), snapshotOf({ commenters: ['carol'] })),
        NOW,
      );
      expect(out, JSON.stringify(changed)).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('refuses an assignee who is neither the author nor a commenter', async () => {
    const n = nextIssue();
    const issue = { commenters: ['carol'] };
    fakeGithub(issue, n);
    const actions = FULL(n);
    actions[0] = { type: 'issue.assign', repo: REPO, issue: n, assignees: ['stranger'] };
    expect(await createBundleApproval(testEnv, ask(n, actions, snapshotOf(issue)), NOW)).toEqual({
      ok: false,
      status: 403,
      error: '@stranger is neither the issue author nor a commenter',
    });
  });

  it('accepts a commenter as assignee regardless of letter case', async () => {
    const c = await created({
      actions: (n) => [{ type: 'issue.assign', repo: REPO, issue: n, assignees: ['CAROL'] }],
    });
    expect(c.ok).toBe(true);
  });

  it('refuses a comment that @mentions someone outside the thread', async () => {
    const n = nextIssue();
    const issue = { commenters: ['carol'] };
    fakeGithub(issue, n);
    const actions = FULL(n);
    actions[3] = { type: 'issue.comment', repo: REPO, issue: n, body: 'cc @stranger please' };
    expect(await createBundleApproval(testEnv, ask(n, actions, snapshotOf(issue)), NOW)).toEqual({
      ok: false,
      status: 403,
      error: '@stranger is neither the issue author nor a commenter',
    });
  });

  it('refuses a pull request, and an issue that cannot be read', async () => {
    const n = nextIssue();
    fakeGithub({ pull: true }, n);
    expect(await createBundleApproval(testEnv, ask(n, FULL(n), snapshotOf()), NOW)).toEqual({
      ok: false,
      status: 403,
      error: 'not an issue',
    });
    const m = nextIssue();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 404 }));
    const out = await createBundleApproval(testEnv, ask(m, FULL(m), snapshotOf()), NOW);
    expect(out).toMatchObject({ ok: false, status: 403 });
    expect((out as { error: string }).error).toMatch(/^issue read failed/);
  });

  it('replaces an older pending bundle for the same issue', async () => {
    const first = await created();
    const gh = fakeGithub(first.issue, first.n);
    const again = await createBundleApproval(
      testEnv,
      ask(first.n, FULL(first.n), snapshotOf(first.issue)),
      NOW,
    );
    expect(again.ok).toBe(true);
    expect(gh.writes()).toEqual([]);
    expect(await decide(first.approval.id)).toEqual({ result: 'not_pending' });
  });
});

describe('approvalByToken for a bundle', () => {
  it('shows the whole bundle with its snapshot, without hash or stored request', async () => {
    const c = await created();
    const found = await approvalByToken(testEnv, c.token, NOW);
    expect(found).toMatchObject({
      ok: true,
      approval: {
        id: c.approval.id,
        status: 'pending',
        bundle: { actions: expect.any(Array) as unknown },
      },
    });
    if (!found.ok) throw new Error('unreachable');
    expect(found.approval.bundle?.snapshot).toEqual(snapshotOf(c.issue));
    expect(JSON.stringify(found)).not.toContain('actionHash');
  });

  it('is not found when the stored bundle no longer matches the token hash', async () => {
    const c = await created();
    const row = await env.AUDIT.prepare('SELECT request_json FROM approvals WHERE id = ?1')
      .bind(c.approval.id)
      .first<{ request_json: string }>();
    const stored = JSON.parse(row!.request_json) as { bundle: ApprovalBundle };
    stored.bundle.snapshot.comments += 1;
    await env.AUDIT.prepare('UPDATE approvals SET request_json = ?2 WHERE id = ?1')
      .bind(c.approval.id, JSON.stringify(stored))
      .run();
    expect(await approvalByToken(testEnv, c.token, NOW)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('expires after 168 hours, not before', async () => {
    const c = await created();
    const day6 = new Date(NOW.getTime() + 6 * 86_400_000);
    expect(await approvalByToken(testEnv, c.token, day6)).toMatchObject({ ok: true });
    const day8 = new Date(NOW.getTime() + 8 * 86_400_000);
    expect(await approvalByToken(testEnv, c.token, day8)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('decideApproval on a bundle', () => {
  it('runs assign, labels, comment in order through act() and consumes once', async () => {
    const c = await created();
    const run = fakeGithub(c.issue, c.n);
    const out = await decide(c.approval.id);
    expect(out).toMatchObject({ result: 'ok', decision: 'approved', executed: { ok: true } });
    if (out.result !== 'ok' || out.decision !== 'approved') throw new Error('unreachable');
    expect(out.steps?.map((s) => [s.type, s.outcome])).toEqual([
      ['issue.assign', 'done'],
      ['issue.label.add', 'done'],
      ['issue.label.remove', 'done'],
      ['issue.comment', 'done'],
    ]);
    expect(out.steps?.[3]?.githubUrl).toContain('/issues/');
    const base = `/repos/${REPO}/issues/${c.n}`;
    expect(run.writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      `POST ${base}/assignees`,
      `POST ${base}/labels`,
      `DELETE ${base}/labels/python`,
      `POST ${base}/comments`,
    ]);
    const stored = await new ApprovalStore(env.AUDIT).get(c.approval.id);
    expect(stored?.consumedAt).not.toBeNull();
  });

  it('posts the comment with the hidden trailer only', async () => {
    const c = await created();
    const run = fakeGithub(c.issue, c.n);
    await decide(c.approval.id);
    const body = (run.writes().find((w) => w.path.endsWith('/comments'))!.body as { body: string })
      .body;
    expect(body).toContain('Thanks @author, applied.');
    expect(body).toContain('<!--\nCustodes-Agent: triage-apply@0.1.0');
    expect(body).not.toContain('<sub>');
    expect(body).not.toContain('Custodes-Agent: triage-apply@0.1.0 ·');
  });

  it('a second decision is not_pending and runs nothing', async () => {
    const c = await created();
    const run = fakeGithub(c.issue, c.n);
    await decide(c.approval.id);
    const writes = run.writes().length;
    expect(await decide(c.approval.id)).toEqual({ result: 'not_pending' });
    expect(run.writes()).toHaveLength(writes);
  });

  it('stops at the first failure, marks later steps not_run and still consumes', async () => {
    const c = await created();
    const run = fakeGithub({ ...c.issue, failWrites: { 'POST labels': 403 } }, c.n);
    const out = await decide(c.approval.id);
    if (out.result !== 'ok' || out.decision !== 'approved') throw new Error('unreachable');
    expect(out.executed.ok).toBe(false);
    expect(out.steps?.map((s) => s.outcome)).toEqual(['done', 'failed', 'not_run', 'not_run']);
    expect(out.steps?.[1]?.code).toBeDefined();
    expect(run.writes().map((w) => w.method)).toEqual(['POST', 'POST']);
    expect((await new ApprovalStore(env.AUDIT).get(c.approval.id))?.consumedAt).not.toBeNull();
    // The link cannot be used again for the remaining steps.
    expect(await decide(c.approval.id)).toEqual({ result: 'not_pending' });
  });

  it('fails the assign step when GitHub silently leaves the login out', async () => {
    const c = await created();
    const run = fakeGithub({ ...c.issue, dropAssignee: true }, c.n);
    const out = await decide(c.approval.id);
    if (out.result !== 'ok' || out.decision !== 'approved') throw new Error('unreachable');
    expect(out.steps?.map((s) => s.outcome)).toEqual(['failed', 'not_run', 'not_run', 'not_run']);
    expect(run.writes()).toHaveLength(1);
  });

  it('runs nothing when the issue changed between asking and deciding, and consumes', async () => {
    const c = await created();
    const run = fakeGithub({ ...c.issue, commenters: ['carol', 'late'] }, c.n);
    const out = await decide(c.approval.id);
    if (out.result !== 'ok' || out.decision !== 'approved') throw new Error('unreachable');
    expect(out.executed).toMatchObject({ ok: false, code: 'approval_invalid' });
    expect((out.executed as { reason: string }).reason).toMatch(/^stale/);
    expect(out.steps?.every((s) => s.outcome === 'not_run')).toBe(true);
    expect(run.writes()).toEqual([]);
    expect((await new ApprovalStore(env.AUDIT).get(c.approval.id))?.consumedAt).not.toBeNull();
  });

  it('runs nothing when the thread lost a person between asking and deciding', async () => {
    const c = await created();
    // The thread lost a person (e.g. the commenter was removed): the author is still there.
    const run = fakeGithub({ ...c.issue, commenters: [] }, c.n);
    const out = await decide(c.approval.id);
    expect(out).toMatchObject({ executed: { ok: false } });
    expect(run.writes()).toEqual([]);
  });

  it('runs nothing and does not leak when the agent is halted at decision time', async () => {
    const c = await created();
    const run = fakeGithub(c.issue, c.n);
    const ks = new KillSwitch(env.KILL_SWITCH);
    await ks.halt('triage-apply', 'test', 'test');
    try {
      const out = await decide(c.approval.id);
      expect(out).toMatchObject({ result: 'ok', decision: 'approved', executed: { ok: false } });
      expect(run.writes()).toEqual([]);
    } finally {
      await ks.resume('triage-apply');
    }
  });

  it('rejecting runs nothing', async () => {
    const c = await created();
    const run = fakeGithub(c.issue, c.n);
    expect(await decideApproval(testEnv, c.approval.id, 'rejected', 'op', NOW)).toEqual({
      result: 'ok',
      decision: 'rejected',
    });
    expect(run.writes()).toEqual([]);
  });

  it('refuses to decide after the 168 h are over', async () => {
    const c = await created();
    expect(await decide(c.approval.id, new Date(NOW.getTime() + 169 * 3600_000))).toEqual({
      result: 'expired',
    });
  });
});

describe('act() with a bundle approval', () => {
  const requestFor = (n: number, action: BrokerAction, approvalId: string) => ({
    agentId: 'triage-apply',
    agentVersion: '0.1.0',
    runId,
    triggeredBy: { kind: 'cli' as const, ref: 'x' },
    action,
    approvalId,
  });
  /** Approve in the store without running the bundle. */
  async function approvedOnly() {
    const c = await created();
    await new ApprovalStore(env.AUDIT).decide(c.approval.id, 'approved', 'op', NOW);
    return c;
  }

  it('accepts each action of the bundle while it is approved and not consumed', async () => {
    const c = await approvedOnly();
    const run = fakeGithub(c.issue, c.n);
    const actions = c.approval.bundle!.actions;
    for (const a of [actions[1]!, actions[1]!]) {
      // twice: a bundle action is not consumed per action
      const res = await act(testEnv, requestFor(c.n, a, c.approval.id), NOW);
      expect(res.ok).toBe(true);
    }
    expect(run.writes()).toHaveLength(2);
  });

  it('refuses an action that is not in the bundle', async () => {
    const c = await approvedOnly();
    const run = fakeGithub(c.issue, c.n);
    const other: BrokerAction = {
      type: 'issue.label.add',
      repo: REPO,
      issue: c.n,
      labels: ['python'],
    };
    expect(await act(testEnv, requestFor(c.n, other, c.approval.id), NOW)).toMatchObject({
      ok: false,
      code: 'approval_invalid',
      reason: 'approval was for a different action',
    });
    const elsewhere: BrokerAction = {
      ...c.approval.bundle!.actions[3]!,
      issue: c.n + 1,
    } as BrokerAction;
    expect(await act(testEnv, requestFor(c.n, elsewhere, c.approval.id), NOW)).toMatchObject({
      ok: false,
      code: 'approval_invalid',
    });
    expect(run.writes()).toEqual([]);
  });

  it('refuses while the bundle is still pending', async () => {
    const c = await created();
    const run = fakeGithub(c.issue, c.n);
    expect(
      await act(testEnv, requestFor(c.n, c.approval.bundle!.actions[0]!, c.approval.id), NOW),
    ).toMatchObject({ ok: false, code: 'approval_invalid', reason: 'approval status is pending' });
    expect(run.writes()).toEqual([]);
  });

  it('refuses once the bundle was consumed, and after expiry', async () => {
    const c = await created();
    const run = fakeGithub(c.issue, c.n);
    await decide(c.approval.id);
    const writes = run.writes().length;
    expect(
      await act(testEnv, requestFor(c.n, c.approval.bundle!.actions[0]!, c.approval.id), NOW),
    ).toMatchObject({ ok: false, code: 'approval_invalid', reason: 'approval already used' });
    expect(run.writes()).toHaveLength(writes);

    const d = await approvedOnly();
    const late = new Date(NOW.getTime() + 169 * 3600_000);
    expect(
      await act(testEnv, requestFor(d.n, d.approval.bundle!.actions[0]!, d.approval.id), late),
    ).toMatchObject({ ok: false, reason: 'approval expired' });
  });

  it('refuses an approval of another agent', async () => {
    const c = await approvedOnly();
    const res = await act(
      testEnv,
      {
        ...requestFor(c.n, c.approval.bundle!.actions[0]!, c.approval.id),
        agentId: 'cheatsheet-review',
      },
      NOW,
    );
    expect(res.ok).toBe(false);
  });

  it('binds the token hash to actions and snapshot together', async () => {
    const c = await created();
    const expected = await sha256Hex(
      canonicalJson({ actions: c.approval.bundle!.actions, snapshot: c.approval.bundle!.snapshot }),
    );
    const row = await env.AUDIT.prepare('SELECT action_hash FROM approvals WHERE id = ?1')
      .bind(c.approval.id)
      .first<{ action_hash: string }>();
    expect(row!.action_hash).toBe(expected);
  });
});

describe('mentionsIn', () => {
  it('finds plain @logins, once each', () => {
    expect(mentionsIn('hi @alice and @Bob-1, again @alice.')).toEqual(['alice', 'Bob-1']);
    expect(mentionsIn('(@carol)')).toEqual(['carol']);
  });
  it('does not count e-mail addresses or @ inside a word', () => {
    expect(mentionsIn('mail me at a@example.org')).toEqual([]);
    expect(mentionsIn('word9@bar')).toEqual([]);
  });
  it('counts forms GitHub mentions in rendered text: after code, emphasis, a slash or `_`', () => {
    // Over-reporting only refuses more; under-reporting would ping a stranger (review M2).
    expect(mentionsIn('see /@x')).toEqual(['x']);
    expect(mentionsIn('use `@decorator` here')).toEqual(['decorator']);
    expect(mentionsIn('run `a`@b and _@c_ and foo_@d')).toEqual(['b', 'c', 'd']);
  });
  it('over-reports rather than under-reports odd forms', () => {
    expect(mentionsIn('@a-')).toEqual(['a-']);
    expect(mentionsIn('@' + 'x'.repeat(45))).toEqual(['x'.repeat(39)]);
  });
});

describe('readIssueThread', () => {
  const read = (n: number) => readIssueThread(testEnv, 'triage-apply', runId, REPO, n);

  it('lists the author first, then commenters once each (case-insensitive)', async () => {
    fakeGithub({ author: 'Author', commenters: ['bob', 'author', 'BOB', 'carol'] }, 7);
    const t = await read(7);
    expect(t).toMatchObject({ ok: true, people: ['Author', 'bob', 'carol'] });
    if (t.ok) expect(t.snapshot.comments).toBe(4);
  });

  it('pages through the comments 100 at a time', async () => {
    const commenters = Array.from({ length: 250 }, (_, i) => `u${i}`);
    const gh = fakeGithub({ commenters }, 8);
    const t = await read(8);
    expect(t).toMatchObject({ ok: true });
    if (t.ok) expect(t.people).toHaveLength(251);
    const pages = gh.calls.length; // writes only are recorded; reads are counted via the spy
    expect(pages).toBe(0);
    const commentReads = gh.spy.mock.calls.filter(([u]) => (u as string).includes('/comments'));
    expect(commentReads).toHaveLength(3);
  });

  it('fails closed when the thread is longer than ten pages', async () => {
    fakeGithub({ commenters: Array.from({ length: 1000 }, (_, i) => `u${i}`) }, 9);
    expect(await read(9)).toEqual({ ok: false, reason: 'thread too long to check' });
  });

  it('refuses a pull request and an unexpected shape', async () => {
    fakeGithub({ pull: true }, 10);
    expect(await read(10)).toEqual({ ok: false, reason: 'not an issue' });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ state: 'open', user: null }));
    expect(await read(11)).toEqual({ ok: false, reason: 'unexpected issue shape' });
  });

  it('does not read for an agent without read policy for the repo', async () => {
    const gh = fakeGithub({}, 12);
    const t = await readIssueThread(testEnv, 'triage-apply', runId, 'evil/repo', 12);
    expect(t).toMatchObject({ ok: false });
    expect(gh.spy).not.toHaveBeenCalled();
  });
});

describe('maxPendingApprovals (policy: 50 for triage-apply)', () => {
  it('refuses the 51st pending bundle', async () => {
    const store = new ApprovalStore(env.AUDIT);
    await env.AUDIT.prepare(
      `UPDATE approvals SET status = 'rejected' WHERE agent_id = 'triage-apply' AND status = 'pending'`,
    ).run();
    try {
      for (let i = 0; i < 50; i++) {
        const n = 5000 + i;
        const action = FULL(n)[3]!;
        await store.create(
          {
            agentId: 'triage-apply',
            agentVersion: '0.1.0',
            runId,
            triggeredBy: { kind: 'cli', ref: 'x' },
            action,
          },
          'r',
          'h',
          3600,
          NOW,
        );
      }
      const n = nextIssue();
      fakeGithub({}, n);
      expect(await createBundleApproval(testEnv, ask(n, FULL(n), snapshotOf()), NOW)).toEqual({
        ok: false,
        status: 403,
        error: 'too many pending approvals',
      });
    } finally {
      await env.AUDIT.prepare(
        `UPDATE approvals SET status = 'rejected' WHERE agent_id = 'triage-apply' AND status = 'pending'`,
      ).run();
    }
  });
});
