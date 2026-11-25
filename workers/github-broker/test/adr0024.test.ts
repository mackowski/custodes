import { createHash } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from '@custodes/core';
import {
  AgentPolicy,
  ReadPolicy,
  type ApprovalBundle,
  type BrokerAction,
  type BundleApprovalAsk,
  type BrokerRequest,
  type PullSnapshot,
} from '@custodes/schema';
import { act } from '../src/act.js';
import { createBundleApproval, decideApproval } from '../src/approvals.js';
import { policy } from '../src/policy.js';
import { readPullThread } from '../src/thread.js';
import type { BrokerEnv } from '../src/env.js';

// ADR 0024 in the broker: the mention rule for hotl comments, the trigger-label daily cap,
// issue.close, the pull request thread reader and pull bundles. backlog-review has no policy entry
// yet (#132 v2), so this file adds temporary ones to the parsed module policy and removes them.

const REPO = 'mackowski/custodes-sandbox';
const OTHER_REPO = 'mackowski/other-repo';
const TRIGGER = 'custodes_cheatsheet_review';
const runId = '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44';
const SHA_A = '0123456789abcdef0123456789abcdef01234567';
const SHA_B = '89abcdef0123456789abcdef0123456789abcdef';
const UPDATED = '2026-11-20T10:00:00Z';

/** Every test gets its own day, later than the last: audit rows of one test never count in another. */
let day = 0;
const nextNow = () => new Date(Date.UTC(2027, 0, 1 + 3 * ++day, 10, 0, 0));

let testEnv: BrokerEnv;
let saved: {
  agents: typeof policy.agents;
  reads: typeof policy.reads;
  maintainers: typeof policy.maintainers;
};
beforeAll(() => {
  testEnv = {
    ...env,
    PAT_BACKLOG_REVIEW: { get: () => Promise.resolve('backlog-token') },
    PAT_TRIAGE_APPLY: { get: () => Promise.resolve('apply-token') },
    PAT_READONLY: { get: () => Promise.resolve('read-token') },
    // PAT_BACKLOG_REVIEW is not a binding of wrangler.jsonc yet (#132 v2): a test-only secret.
  } as BrokerEnv;
  saved = {
    agents: { ...policy.agents },
    reads: { ...policy.reads },
    maintainers: { ...policy.maintainers },
  };
  const repos = [REPO, OTHER_REPO];
  const labels = [TRIGGER.toUpperCase(), 'Custodes_CheatSheet_Review', TRIGGER, 'docker'];
  policy.agents['backlog-review'] = AgentPolicy.parse({
    tokenBinding: 'PAT_BACKLOG_REVIEW',
    mode: 'hotl',
    tier: 'T1',
    repos,
    actions: ['issue.comment', 'issue.label.add', 'issue.close'],
    labels,
  });
  // The same actions behind an approval, for bundles.
  policy.agents['backlog-bundle'] = AgentPolicy.parse({
    tokenBinding: 'PAT_BACKLOG_REVIEW',
    mode: 'hitl',
    tier: 'T1',
    repos,
    actions: ['issue.comment', 'issue.label.add', 'pr.close'],
    labels,
  });
  for (const id of ['backlog-review', 'backlog-bundle'])
    policy.reads[id] = ReadPolicy.parse({
      tokenBinding: 'PAT_READONLY',
      repos,
      resources: ['issue', 'comments', 'pull', 'pull_reviews'],
    });
});
afterAll(() => {
  policy.agents = saved.agents;
  policy.reads = saved.reads;
  policy.maintainers = saved.maintainers;
});
afterEach(() => {
  vi.restoreAllMocks();
  policy.maintainers = { ...saved.maintainers };
});

interface Fake {
  /** `pull` serves the number as a pull request (the issue read carries `pull_request`). */
  pull?: boolean;
  author?: string;
  commenters?: string[];
  reviewers?: { login: string; type?: string }[];
  head?: string;
  /** Answer GETs whose path ends with one of these with a 500. */
  failReads?: string[];
}
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake GitHub for one issue or pull request number on any repository; `t` can change mid-test. */
function fakeGithub(t: Fake = {}, n = 7) {
  const gets: string[] = [];
  const writes: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const body: unknown = init?.body ? JSON.parse(init.body as string) : undefined;
    if (method === 'GET') {
      gets.push(path);
      if ((t.failReads ?? []).some((s) => path.endsWith(s)))
        return Promise.resolve(new Response('boom', { status: 500 }));
      const common = {
        state: 'open',
        user: { login: t.author ?? 'author' },
        labels: [],
        assignees: [],
        comments: (t.commenters ?? []).length,
        updated_at: UPDATED,
      };
      if (path === `/issues/${n}`)
        return Promise.resolve(
          Response.json({ ...common, ...(t.pull ? { pull_request: {} } : {}) }),
        );
      if (path === `/pulls/${n}`)
        return Promise.resolve(Response.json({ ...common, head: { sha: t.head ?? SHA_A } }));
      if (path === `/issues/${n}/comments`)
        return Promise.resolve(
          Response.json(
            (t.commenters ?? []).map((login, i) => ({
              id: i + 1,
              updated_at: UPDATED,
              user: { login },
            })),
          ),
        );
      if (path === `/pulls/${n}/reviews`)
        return Promise.resolve(
          Response.json(
            (t.reviewers ?? []).map((r, i) => ({
              id: 500 + i,
              state: 'COMMENTED',
              submitted_at: UPDATED,
              user: { login: r.login, ...(r.type ? { type: r.type } : {}) },
            })),
          ),
        );
      return Promise.resolve(new Response('not found', { status: 404 }));
    }
    writes.push({ method, path, body });
    if (path === `/issues/${n}/comments`)
      return Promise.resolve(
        Response.json({ html_url: `https://github.com/x/y/issues/${n}#c1` }, { status: 201 }),
      );
    return Promise.resolve(Response.json({ state: 'closed' }));
  });
  return { gets, writes };
}

const request = (action: BrokerAction, agentId = 'backlog-review'): BrokerRequest => ({
  agentId,
  agentVersion: '0.1.0',
  runId,
  triggeredBy: { kind: 'cli', ref: 'adr0024' },
  action,
});
const comment = (body: string, issue = 7, repo = REPO): BrokerAction => ({
  type: 'issue.comment',
  repo,
  issue,
  body,
});
const addLabels = (labels: string[], repo = REPO, issue = 7): BrokerAction => ({
  type: 'issue.label.add',
  repo,
  issue,
  labels,
});

describe('mentions in a hotl comment (ADR 0024)', () => {
  it('refuses a comment that names a stranger, and writes nothing', async () => {
    const gh = fakeGithub({ commenters: ['carol'] });
    const r = await act(testEnv, request(comment('cc @stranger')), nextNow());
    expect(r).toMatchObject({
      ok: false,
      code: 'policy_denied',
      reason: '@stranger is neither in the thread nor a listed maintainer',
    });
    expect(gh.writes).toEqual([]);
  });

  it('refuses a stranger named next to an allowed person, and a close that names one', async () => {
    const gh = fakeGithub({ commenters: ['carol'] });
    const now = nextNow();
    expect(await act(testEnv, request(comment('@carol and @stranger')), now)).toMatchObject({
      ok: false,
      code: 'policy_denied',
    });
    const close: BrokerAction = {
      type: 'issue.close',
      repo: REPO,
      issue: 7,
      body: 'bye @stranger',
      stateReason: 'not_planned',
    };
    expect(await act(testEnv, request(close), now)).toMatchObject({
      ok: false,
      code: 'policy_denied',
    });
    expect(gh.writes).toEqual([]);
  });

  it('allows naming the issue author or a commenter, in any letter case', async () => {
    const gh = fakeGithub({ author: 'Author', commenters: ['carol'] });
    const now = nextNow();
    expect(await act(testEnv, request(comment('thanks @author')), now)).toMatchObject({ ok: true });
    expect(await act(testEnv, request(comment('see @Carol')), now)).toMatchObject({ ok: true });
    expect(gh.writes.map((w) => w.method + ' ' + w.path)).toEqual([
      'POST /issues/7/comments',
      'POST /issues/7/comments',
    ]);
  });

  it('allows naming only a listed maintainer without reading the thread at all', async () => {
    policy.maintainers[REPO] = ['Maint'];
    const gh = fakeGithub();
    const r = await act(testEnv, request(comment('ping @maint')), nextNow());
    expect(r).toMatchObject({ ok: true });
    expect(gh.gets).toEqual([]);
    expect(gh.writes).toHaveLength(1);
  });

  it('keeps maintainers per repository: a maintainer of another repository is a stranger', async () => {
    policy.maintainers[OTHER_REPO] = ['maint'];
    const gh = fakeGithub();
    const r = await act(testEnv, request(comment('ping @maint')), nextNow());
    expect(r).toMatchObject({ ok: false, code: 'policy_denied' });
    expect(gh.writes).toEqual([]);
  });

  it('reads the thread when a maintainer and a stranger are both named, and refuses', async () => {
    policy.maintainers[REPO] = ['maint'];
    const gh = fakeGithub();
    const r = await act(testEnv, request(comment('@maint @stranger')), nextNow());
    expect(r).toMatchObject({ ok: false, code: 'policy_denied' });
    expect(gh.gets).toContain('/issues/7');
    expect(gh.writes).toEqual([]);
  });

  it('does not read the thread for a comment that names nobody', async () => {
    const gh = fakeGithub();
    expect(await act(testEnv, request(comment('plain text')), nextNow())).toMatchObject({
      ok: true,
    });
    expect(gh.gets).toEqual([]);
  });

  it('falls back to the pull request thread for a comment on a pull request, reviewers included', async () => {
    const gh = fakeGithub({
      pull: true,
      commenters: ['carol'],
      reviewers: [{ login: 'rita' }, { login: 'copilot-bot', type: 'Bot' }],
    });
    const now = nextNow();
    expect(await act(testEnv, request(comment('thanks @rita')), now)).toMatchObject({ ok: true });
    expect(gh.gets).toEqual(
      expect.arrayContaining(['/issues/7', '/pulls/7', '/issues/7/comments', '/pulls/7/reviews']),
    );
    // A bot reviewer is not a person to name, and a stranger is refused here too.
    expect(await act(testEnv, request(comment('@copilot-bot')), now)).toMatchObject({
      ok: false,
      code: 'policy_denied',
    });
    expect(await act(testEnv, request(comment('@stranger')), now)).toMatchObject({
      ok: false,
      code: 'policy_denied',
    });
    expect(gh.writes).toHaveLength(1);
  });

  it('refuses when the thread cannot be read, and says so', async () => {
    for (const failReads of [['/issues/7'], ['/issues/7/comments']]) {
      const gh = fakeGithub({ failReads });
      const r = await act(testEnv, request(comment('hi @author')), nextNow());
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('policy_denied');
        expect(r.reason.startsWith('cannot check who the comment names')).toBe(true);
      }
      expect(gh.writes).toEqual([]);
      vi.restoreAllMocks();
    }
  });

  it('refuses when a pull request thread cannot be read', async () => {
    fakeGithub({ pull: true, failReads: ['/pulls/7/reviews'] });
    const r = await act(testEnv, request(comment('hi @author')), nextNow());
    expect(r).toMatchObject({ ok: false, code: 'policy_denied' });
    if (!r.ok) expect(r.reason).toMatch(/^cannot check who the comment names/);
  });
});

describe('trigger-label daily cap (ADR 0024)', () => {
  const add = (now: Date, labels = [TRIGGER], repo = REPO) =>
    act(testEnv, request(addLabels(labels, repo)), now);
  const hours = (d: Date, h: number) => new Date(d.getTime() + h * 3_600_000);

  it('allows three adds on a repository in 24 hours and denies the fourth', async () => {
    const gh = fakeGithub();
    const now = nextNow();
    for (const h of [-5, -3, -1])
      expect(await add(hours(now, h)), `h${h}`).toMatchObject({ ok: true });
    const r = await add(now);
    expect(r).toMatchObject({ ok: false, code: 'policy_denied' });
    if (!r.ok) expect(r.reason).toContain('daily cap');
    expect(gh.writes).toHaveLength(3);
  });

  it('does not count an add that is 25 hours old', async () => {
    fakeGithub();
    const now = nextNow();
    for (const m of [0, 1, 2])
      expect(await add(new Date(hours(now, -25).getTime() + m * 60_000))).toMatchObject({
        ok: true,
      });
    // Three more now: the old ones are outside the window of every one of these checks.
    for (let i = 0; i < 3; i++) expect(await add(now), `now ${i}`).toMatchObject({ ok: true });
    expect(await add(now)).toMatchObject({ ok: false });
  });

  it('counts only the trigger label, not other labels', async () => {
    const gh = fakeGithub();
    const now = nextNow();
    for (const h of [-6, -5, -4, -3])
      expect(await add(hours(now, h), ['docker'])).toMatchObject({ ok: true });
    for (const h of [-3, -2, -1]) expect(await add(hours(now, h))).toMatchObject({ ok: true });
    expect(await add(now, ['docker'])).toMatchObject({ ok: true });
    expect(await add(now)).toMatchObject({ ok: false });
    expect(gh.writes).toHaveLength(8);
  });

  it('matches the label case-insensitively', async () => {
    fakeGithub();
    const now = nextNow();
    expect(await add(hours(now, -3), [TRIGGER])).toMatchObject({ ok: true });
    expect(await add(hours(now, -2), ['Custodes_CheatSheet_Review'])).toMatchObject({ ok: true });
    expect(await add(hours(now, -1), [TRIGGER.toUpperCase()])).toMatchObject({ ok: true });
    for (const label of [TRIGGER, 'Custodes_CheatSheet_Review', TRIGGER.toUpperCase()])
      expect(await add(now, [label]), label).toMatchObject({ ok: false });
  });

  it('caps per repository', async () => {
    fakeGithub();
    const now = nextNow();
    for (const h of [-3, -2, -1]) await add(hours(now, h));
    expect(await add(now)).toMatchObject({ ok: false });
    expect(await add(now, [TRIGGER], OTHER_REPO)).toMatchObject({ ok: true });
  });

  it('refuses the trigger label for an agent without a grant before any cap applies', async () => {
    const gh = fakeGithub();
    const r = await act(testEnv, { ...request(addLabels([TRIGGER]), 'triage-apply') }, nextNow());
    expect(r).toMatchObject({ ok: false, code: 'policy_denied' });
    expect(gh.writes).toEqual([]);
  });
});

describe('issue.close through act (ADR 0024)', () => {
  it('posts the comment with its attestation trailer, then closes with the reason', async () => {
    const gh = fakeGithub();
    const r = await act(
      testEnv,
      request({
        type: 'issue.close',
        repo: REPO,
        issue: 7,
        body: 'Done in #8.',
        stateReason: 'completed',
      }),
      nextNow(),
    );
    expect(r).toMatchObject({ ok: true });
    expect(gh.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /issues/7/comments',
      'PATCH /issues/7',
    ]);
    const posted = (gh.writes[0]?.body as { body: string }).body;
    expect(posted.startsWith('Done in #8.')).toBe(true);
    if (r.ok) expect(posted).toContain(r.attestationId);
    expect(gh.writes[1]?.body).toEqual({ state: 'closed', state_reason: 'completed' });
  });

  it('is refused for an agent that was not granted it', async () => {
    const gh = fakeGithub();
    const r = await act(
      testEnv,
      request(
        { type: 'issue.close', repo: REPO, issue: 7, body: 'x', stateReason: 'completed' },
        'triage-apply',
      ),
      nextNow(),
    );
    expect(r).toMatchObject({ ok: false, code: 'policy_denied' });
    expect(gh.writes).toEqual([]);
  });
});

describe('readPullThread (ADR 0024)', () => {
  const read = (t: Fake) => {
    fakeGithub(t);
    return readPullThread(testEnv, 'backlog-review', runId, REPO, 7);
  };

  it('returns the head sha, digests and people, and the reviews digest changes with a new review', async () => {
    const one = await read({ commenters: ['carol'], reviewers: [{ login: 'rita' }] });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.snapshot).toMatchObject({
      state: 'open',
      headSha: SHA_A,
      comments: 1,
      updatedAt: UPDATED,
      commentsDigest: createHash('sha256')
        .update(canonicalJson([[1, UPDATED]]))
        .digest('hex'),
      reviewsDigest: createHash('sha256')
        .update(canonicalJson([[500, 'COMMENTED', UPDATED]]))
        .digest('hex'),
    });
    expect(one.people).toEqual(['author', 'carol', 'rita']);
    vi.restoreAllMocks();
    const two = await read({
      commenters: ['carol'],
      reviewers: [{ login: 'rita' }, { login: 'sam' }],
    });
    expect(two.ok && two.snapshot.reviewsDigest).not.toBe(one.snapshot.reviewsDigest);
    expect(two.ok && two.snapshot.commentsDigest).toBe(one.snapshot.commentsDigest);
    expect(two.ok && two.people).toContain('sam');
  });

  it('changes the snapshot when a commit is pushed', async () => {
    const a = await read({ head: SHA_A });
    vi.restoreAllMocks();
    const b = await read({ head: SHA_B });
    expect(a.ok && b.ok && a.snapshot.headSha !== b.snapshot.headSha).toBe(true);
  });

  it('leaves bot reviewers out of the people', async () => {
    const t = await read({
      reviewers: [
        { login: 'copilot-pull-request-reviewer', type: 'Bot' },
        { login: 'rita' },
        { login: 'RITA' },
      ],
    });
    expect(t.ok && t.people).toEqual(['author', 'rita']);
  });

  it.each(['abc123', SHA_A.toUpperCase(), SHA_A + '0', ''])(
    'fails closed on a head sha that is not 40 lowercase hex: %j',
    async (head) => {
      expect(await read({ head })).toEqual({ ok: false, reason: 'unexpected pull request shape' });
    },
  );

  it('fails closed when the reviews cannot be read', async () => {
    const t = await read({ failReads: ['/pulls/7/reviews'] });
    expect(t.ok).toBe(false);
  });
});

describe('pull request bundles (ADR 0024)', () => {
  const askFor = (
    agentId: string,
    actions: BrokerAction[],
    snapshot: ApprovalBundle['snapshot'],
  ): BundleApprovalAsk => ({
    request: {
      agentId,
      agentVersion: '0.1.0',
      runId,
      triggeredBy: { kind: 'cli', ref: 'pull:7' },
      bundle: { actions, snapshot },
    },
    rationale: 'proposal',
  });
  const snapshotNow = async (): Promise<PullSnapshot> => {
    const thread = await readPullThread(testEnv, 'backlog-bundle', runId, REPO, 7);
    if (!thread.ok) throw new Error(thread.reason);
    return thread.snapshot;
  };
  // BUNDLE_ORDER: labels, comment, then the closing action last.
  const bundleActions = (): BrokerAction[] => [
    addLabels(['docker']),
    comment('Heads up, closing.'),
    { type: 'pr.close', repo: REPO, pull: 7, body: 'Closing, superseded.' },
  ];

  it('refuses a pull bundle for triage-apply: its policy has no pr.close', async () => {
    const t: Fake = { commenters: ['carol'] };
    const gh = fakeGithub(t);
    const snap = await snapshotNow();
    const out = await createBundleApproval(
      testEnv,
      askFor('triage-apply', [{ type: 'pr.close', repo: REPO, pull: 7, body: 'x' }], snap),
      nextNow(),
    );
    expect(out).toEqual({ ok: false, status: 403, error: 'action pr.close not allowed' });
    expect(gh.writes).toEqual([]);
  });

  it('runs labels, comment and pr.close in order when the pull request is unchanged', async () => {
    const t: Fake = { commenters: ['carol'], reviewers: [{ login: 'rita' }] };
    const gh = fakeGithub(t);
    const snap = await snapshotNow();
    const now = nextNow();
    const created = await createBundleApproval(
      testEnv,
      askFor('backlog-bundle', bundleActions(), snap),
      now,
    );
    if (!created.ok) throw new Error(created.error);
    expect(gh.writes).toEqual([]);
    const out = await decideApproval(
      testEnv,
      created.approval.id,
      'approved',
      'op@example.org',
      now,
    );
    expect(out).toMatchObject({ result: 'ok', decision: 'approved' });
    expect('steps' in out && out.steps?.map((s) => `${s.type}:${s.outcome}`)).toEqual([
      'issue.label.add:done',
      'issue.comment:done',
      'pr.close:done',
    ]);
    expect(gh.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /issues/7/labels',
      'POST /issues/7/comments',
      'POST /issues/7/comments',
      'PATCH /pulls/7',
    ]);
    expect(gh.writes[3]?.body).toEqual({ state: 'closed' });
  });

  it('runs nothing when the head sha moved between the proposal and the click', async () => {
    const t: Fake = { commenters: ['carol'], head: SHA_A };
    const gh = fakeGithub(t);
    const snap = await snapshotNow();
    const now = nextNow();
    const created = await createBundleApproval(
      testEnv,
      askFor('backlog-bundle', bundleActions(), snap),
      now,
    );
    if (!created.ok) throw new Error(created.error);
    t.head = SHA_B; // a push after the proposal
    const out = await decideApproval(
      testEnv,
      created.approval.id,
      'approved',
      'op@example.org',
      now,
    );
    expect(out).toMatchObject({
      result: 'ok',
      decision: 'approved',
      executed: {
        ok: false,
        code: 'approval_invalid',
        reason: 'stale: the target changed since the proposal',
      },
    });
    expect('steps' in out && out.steps?.every((s) => s.outcome === 'not_run')).toBe(true);
    expect(gh.writes).toEqual([]);
  });

  it('refuses at the request when the head sha already differs from the snapshot', async () => {
    const t: Fake = { head: SHA_B };
    const gh = fakeGithub(t);
    const snap = { ...(await snapshotNow()), headSha: SHA_A };
    expect(
      await createBundleApproval(
        testEnv,
        askFor('backlog-bundle', bundleActions(), snap),
        nextNow(),
      ),
    ).toEqual({ ok: false, status: 403, error: 'stale: the target changed since the proposal' });
    expect(gh.writes).toEqual([]);
  });

  it('runs nothing when a review was added after the proposal', async () => {
    const t: Fake = { reviewers: [] };
    const gh = fakeGithub(t);
    const snap = await snapshotNow();
    const now = nextNow();
    const created = await createBundleApproval(
      testEnv,
      askFor('backlog-bundle', bundleActions(), snap),
      now,
    );
    if (!created.ok) throw new Error(created.error);
    t.reviewers = [{ login: 'rita' }];
    const out = await decideApproval(
      testEnv,
      created.approval.id,
      'approved',
      'op@example.org',
      now,
    );
    expect(out).toMatchObject({ executed: { ok: false, code: 'approval_invalid' } });
    expect(gh.writes).toEqual([]);
  });

  it('refuses a pull bundle whose comment names a stranger', async () => {
    const t: Fake = {};
    fakeGithub(t);
    const snap = await snapshotNow();
    const actions: BrokerAction[] = [
      comment('hello @stranger'),
      { type: 'pr.close', repo: REPO, pull: 7, body: 'bye' },
    ];
    expect(
      await createBundleApproval(testEnv, askFor('backlog-bundle', actions, snap), nextNow()),
    ).toEqual({
      ok: false,
      status: 403,
      error: '@stranger is neither in the thread nor a listed maintainer',
    });
  });
});
