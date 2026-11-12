import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  ASK_AUTHOR,
  askedAuthor,
  AUTHOR_SILENCE_MS,
  chooseAssignee,
  fillPlaceholders,
  type AssignmentInput,
} from '../src/agents/specialists/assignment.js';
import {
  type RawProposalReview,
  validateProposalReview,
} from '../src/agents/specialists/proposal.js';
import {
  buildBundle,
  mentionsIn,
  ProposalInput,
  snapshotOf,
  threadPeople,
} from '../src/agents/triage-apply/bundle.js';
import type { IssueComment, PublicIssue } from '../src/agents/triage/github.js';
import { applyLine, renderDigest, type ApplyLink } from '../src/agents/triage/digest.js';
import { renderDigestHtml } from '../src/agents/triage/digest-html.js';
import { TriageApplyIntake } from '../src/triage-apply-worker.js';
import type { AgentsEnv } from '../src/env.js';

const REPO = 'mackowski/custodes-sandbox';
const NOW = new Date('2026-11-12T10:00:00Z');

const issue = (over: Partial<PublicIssue> = {}): PublicIssue => ({
  number: 7,
  title: 'Proposal',
  body: 'I propose X',
  html_url: `https://github.com/${REPO}/issues/7`,
  state: 'open',
  user: { login: 'author' },
  labels: [{ name: 'ACK_WAITING' }],
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-10T10:00:00Z',
  comments: 0,
  assignees: [],
  ...over,
});
const comment = (login: string, over: Partial<IssueComment> = {}): IssueComment => ({
  user: { login },
  body: 'hello',
  created_at: '2026-11-02T10:00:00Z',
  ...over,
});
const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  repo: REPO,
  issue: 7,
  addLabels: [],
  removeLabels: [],
  assignee: null,
  comment: '',
  reason: 'proposal review: real_gap',
  ...over,
});

describe('buildBundle', () => {
  it('orders assign, labels add, labels remove, comment and snapshots the issue', () => {
    const r = buildBundle(
      input({
        assignee: 'author',
        addLabels: ['ACK_OBTAINED'],
        removeLabels: ['ACK_WAITING'],
        comment: 'Thanks @author',
      }),
      issue({ comments: 1 }),
      [comment('bob')],
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.bundle.actions.map((a) => a.type)).toEqual([
      'issue.assign',
      'issue.label.add',
      'issue.label.remove',
      'issue.comment',
    ]);
    expect(r.bundle.snapshot).toEqual({
      state: 'open',
      labels: ['ACK_WAITING'],
      assignees: [],
      comments: 1,
    });
    expect(r.dropped).toEqual([]);
  });

  it('drops the assignee when the issue is already assigned', () => {
    const r = buildBundle(
      input({ assignee: 'author', addLabels: ['NEW_CS'] }),
      issue({ assignees: [{ login: 'someone' }] }),
      [],
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.dropped).toEqual(['assignee (already assigned)']);
    expect(r.bundle.actions.map((a) => a.type)).toEqual(['issue.label.add']);
    expect(r.bundle.snapshot.assignees).toEqual(['someone']);
  });

  it('drops an assignee who is not in the thread (case-insensitively accepts one who is)', () => {
    const stranger = buildBundle(
      input({ assignee: 'mallory', addLabels: ['NEW_CS'] }),
      issue(),
      [],
    );
    if (!stranger.ok) throw new Error(stranger.reason);
    expect(stranger.dropped).toEqual(['assignee (not in the thread)']);
    const author = buildBundle(input({ assignee: 'AUTHOR' }), issue(), []);
    expect(author.ok && author.bundle.actions[0]).toMatchObject({
      type: 'issue.assign',
      assignees: ['AUTHOR'],
    });
  });

  it('adds only labels the issue lacks and removes only labels it has', () => {
    const r = buildBundle(
      input({
        addLabels: ['ack_waiting', 'NEW_CS', 'NEW_CS'],
        removeLabels: ['ACK_WAITING', 'WEBSITE'],
      }),
      issue(),
      [],
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.bundle.actions).toEqual([
      { type: 'issue.label.add', repo: REPO, issue: 7, labels: ['NEW_CS'] },
      { type: 'issue.label.remove', repo: REPO, issue: 7, labels: ['ACK_WAITING'] },
    ]);
  });

  it('never both adds and removes the same label', () => {
    const r = buildBundle(
      input({ addLabels: ['NEW_CS'], removeLabels: ['new_cs'] }),
      issue({ labels: [] }),
      [],
    );
    if (!r.ok) throw new Error(r.reason);
    expect(r.bundle.actions.map((a) => a.type)).toEqual(['issue.label.add']);
  });

  it('drops a comment that names someone outside the thread, keeps the rest', () => {
    const r = buildBundle(input({ comment: 'cc @stranger', addLabels: ['NEW_CS'] }), issue(), []);
    if (!r.ok) throw new Error(r.reason);
    expect(r.dropped).toEqual(['comment (names someone outside the thread)']);
    expect(r.bundle.actions.map((a) => a.type)).toEqual(['issue.label.add']);
  });

  it('keeps a comment that names the author or a commenter, and ignores e-mails and code', () => {
    const r = buildBundle(
      input({ comment: 'Hi @bob, mail a@example.org, run `@x`, see /@y' }),
      issue({ comments: 1 }),
      [comment('Bob')],
    );
    expect(r.ok && r.bundle.actions.map((a) => a.type)).toEqual(['issue.comment']);
  });

  it('refuses a pull request, a wrong number, a closed issue and an unexpected state', () => {
    expect(buildBundle(input({ addLabels: ['x'] }), issue({ pull_request: {} }), [])).toEqual({
      ok: false,
      reason: 'not an issue',
    });
    expect(buildBundle(input({ addLabels: ['x'] }), issue({ number: 8 }), [])).toEqual({
      ok: false,
      reason: 'wrong issue',
    });
    expect(buildBundle(input({ addLabels: ['x'] }), issue({ state: 'closed' }), [])).toEqual({
      ok: false,
      reason: 'issue is not open',
    });
    expect(buildBundle(input({ addLabels: ['x'] }), issue({ state: undefined }), [])).toEqual({
      ok: false,
      reason: 'issue is not open',
    });
  });

  it('refuses when the thread is longer than the comments that were read', () => {
    expect(
      buildBundle(input({ addLabels: ['x'] }), issue({ comments: 101 }), [comment('a')]),
    ).toEqual({
      ok: false,
      reason: 'thread longer than was read',
    });
  });

  it('refuses when nothing is left to do', () => {
    expect(
      buildBundle(input({ addLabels: ['ACK_WAITING'], removeLabels: ['WEBSITE'] }), issue(), []),
    ).toEqual({ ok: false, reason: 'nothing left to apply' });
    expect(buildBundle(input({ comment: '   ' }), issue(), [])).toEqual({
      ok: false,
      reason: 'nothing left to apply',
    });
    // Everything was dropped: an assignee for an assigned issue and nothing else.
    expect(
      buildBundle(input({ assignee: 'author' }), issue({ assignees: [{ login: 'someone' }] }), []),
    ).toEqual({ ok: false, reason: 'nothing left to apply' });
  });
});

describe('triage-apply helpers', () => {
  it('snapshots sorted labels and assignees, and drops invalid logins', () => {
    expect(
      snapshotOf(
        issue({
          labels: ['b', { name: 'a' }],
          assignees: [{ login: 'zed' }, { login: 'not a login' }, { login: 'amy' }],
          comments: 4,
        }),
      ),
    ).toEqual({ state: 'open', labels: ['a', 'b'], assignees: ['amy', 'zed'], comments: 4 });
    expect(snapshotOf(issue({ state: 'merged' }))).toBeNull();
  });

  it('lists the author first and every commenter once, ignoring invalid logins', () => {
    expect(
      threadPeople(issue(), [comment('Bob'), comment('bob'), comment('x y'), comment('author')]),
    ).toEqual(['author', 'Bob']);
  });

  it('mentionsIn agrees with the broker rule', () => {
    expect(mentionsIn('@a and (@b) but not x@c, `@d`, /@e or w@f')).toEqual(['a', 'b']);
  });

  it('ProposalInput rejects a bad repo, too many labels, a bad login and a long comment', () => {
    const ok = input();
    expect(ProposalInput.safeParse(ok).success).toBe(true);
    expect(ProposalInput.safeParse({ ...ok, repo: 'no-slash' }).success).toBe(false);
    expect(ProposalInput.safeParse({ ...ok, addLabels: Array(7).fill('x') }).success).toBe(false);
    expect(ProposalInput.safeParse({ ...ok, assignee: '@bad' }).success).toBe(false);
    expect(ProposalInput.safeParse({ ...ok, comment: 'x'.repeat(3001) }).success).toBe(false);
    expect(ProposalInput.safeParse({ ...ok, issue: 0 }).success).toBe(false);
  });
});

describe('askedAuthor', () => {
  const trailer =
    'Question?\n\n<!--\nCustodes-Agent: triage-apply@0.1.0\nCustodes-Attestation: x\n-->';
  const ours = (over: Partial<IssueComment> = {}) =>
    comment('maint', {
      body: trailer,
      author_association: 'OWNER',
      created_at: '2026-11-03T10:00:00Z',
      ...over,
    });

  it('is null when nobody asked', () => {
    expect(askedAuthor(issue(), [comment('bob')])).toBeNull();
  });

  it.each(['OWNER', 'MEMBER', 'COLLABORATOR'])('counts a comment by a %s with the trailer', (a) => {
    expect(askedAuthor(issue(), [ours({ author_association: a })])).toEqual({
      at: '2026-11-03T10:00:00Z',
      replied: false,
    });
  });

  it.each(['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR', undefined])(
    'ignores the trailer pasted by someone with association %s',
    (a) => {
      expect(
        askedAuthor(issue(), [
          ours(a === undefined ? { author_association: undefined } : { author_association: a }),
        ]),
      ).toBeNull();
    },
  );

  it('ignores a maintainer comment without the trailer or with another agent trailer', () => {
    expect(askedAuthor(issue(), [ours({ body: 'would you like to?' })])).toBeNull();
    expect(
      askedAuthor(issue(), [ours({ body: '<!--\nCustodes-Agent: triage@0.2.0\n-->' })]),
    ).toBeNull();
    expect(askedAuthor(issue(), [ours({ body: null })])).toBeNull();
  });

  it('uses the latest question and notes a later reply by the author (any letter case)', () => {
    const r = askedAuthor(issue(), [
      ours({ created_at: '2026-11-03T10:00:00Z' }),
      ours({ created_at: '2026-11-05T10:00:00Z' }),
      comment('AUTHOR', { created_at: '2026-11-04T10:00:00Z' }),
    ]);
    expect(r).toEqual({ at: '2026-11-05T10:00:00Z', replied: false });
    expect(
      askedAuthor(issue(), [ours(), comment('AUTHOR', { created_at: '2026-11-04T10:00:00Z' })]),
    ).toEqual({ at: '2026-11-03T10:00:00Z', replied: true });
  });

  it('does not count another commenter replying, or the author writing before the question', () => {
    expect(
      askedAuthor(issue(), [
        comment('author', { created_at: '2026-11-02T10:00:00Z' }),
        ours(),
        comment('bob', { created_at: '2026-11-04T10:00:00Z' }),
      ]),
    ).toEqual({ at: '2026-11-03T10:00:00Z', replied: false });
  });
});

describe('chooseAssignee', () => {
  const base: AssignmentInput = {
    intent: 'unclear',
    volunteers: [],
    people: ['author', 'bob', 'carol'],
    assignees: [],
    reviewPr: null,
    asked: null,
    now: NOW,
  };
  const askedAt = (hoursAgo: number, replied = false) => ({
    at: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    replied,
  });

  it('assigns the author when the author offered, even if a volunteer exists', () => {
    expect(chooseAssignee({ ...base, intent: 'offered', volunteers: ['bob'] })).toMatchObject({
      assignTo: 'author',
      why: 'author offered',
    });
  });

  it('assigns nobody when someone is assigned, a PR does the work or there is no author', () => {
    expect(chooseAssignee({ ...base, intent: 'offered', assignees: ['x'] }).assignTo).toBeNull();
    expect(chooseAssignee({ ...base, intent: 'offered', reviewPr: 5 }).assignTo).toBeNull();
    expect(chooseAssignee({ ...base, intent: 'offered', people: [] }).assignTo).toBeNull();
  });

  it('waits for the author while intent is unclear and a volunteer exists', () => {
    expect(chooseAssignee({ ...base, volunteers: ['bob'] })).toEqual({
      assignTo: null,
      why: null,
      recheckAt: null,
      dropped: [],
    });
  });

  it('picks the first volunteer in thread order after the author declined', () => {
    const r = chooseAssignee({ ...base, intent: 'declined', volunteers: ['carol', '@Bob'] });
    expect(r).toMatchObject({ assignTo: 'bob', why: 'author declined' });
  });

  it('never picks the author as a volunteer, nor a login outside the thread', () => {
    expect(
      chooseAssignee({ ...base, intent: 'declined', volunteers: ['author'] }).assignTo,
    ).toBeNull();
    const r = chooseAssignee({ ...base, intent: 'declined', volunteers: ['mallory'] });
    expect(r.assignTo).toBeNull();
    expect(r.dropped).toEqual(['volunteer not in the thread']);
  });

  it('asks for a recheck at the end of the 48 hours while the author is silent', () => {
    const asked = askedAt(10);
    const r = chooseAssignee({ ...base, volunteers: ['bob'], asked });
    expect(r.assignTo).toBeNull();
    expect(r.recheckAt).toBe(new Date(Date.parse(asked.at) + AUTHOR_SILENCE_MS).toISOString());
  });

  it('proposes the volunteer once the 48 hours are over, and not a second earlier', () => {
    const justBefore = {
      at: new Date(NOW.getTime() - AUTHOR_SILENCE_MS + 1000).toISOString(),
      replied: false,
    };
    expect(chooseAssignee({ ...base, volunteers: ['bob'], asked: justBefore }).assignTo).toBeNull();
    const exactly = {
      at: new Date(NOW.getTime() - AUTHOR_SILENCE_MS).toISOString(),
      replied: false,
    };
    expect(chooseAssignee({ ...base, volunteers: ['bob'], asked: exactly })).toMatchObject({
      assignTo: 'bob',
      why: 'author silent 2 days',
      recheckAt: null,
    });
  });

  it('does not treat a reply as silence, and sets no recheck after a reply', () => {
    const r = chooseAssignee({ ...base, volunteers: ['bob'], asked: askedAt(100, true) });
    expect(r).toMatchObject({ assignTo: null, recheckAt: null });
  });

  it('does nothing after the silence when nobody volunteered', () => {
    expect(chooseAssignee({ ...base, asked: askedAt(100) })).toMatchObject({
      assignTo: null,
      recheckAt: null,
    });
  });

  it('survives an unparsable question time', () => {
    const r = chooseAssignee({
      ...base,
      volunteers: ['bob'],
      asked: { at: 'garbage', replied: false },
    });
    expect(r).toMatchObject({ assignTo: null, recheckAt: null });
  });
});

describe('fillPlaceholders', () => {
  const people = ['author', 'bob', 'carol'];
  it('puts in the author and the N-th commenter, and lists each mention once', () => {
    expect(fillPlaceholders('{author} and {commenter:2}, {author}!', people)).toEqual({
      ok: true,
      text: '@author and @carol, @author!',
      mentions: ['author', 'carol'],
    });
  });
  it('leaves text without placeholders alone', () => {
    expect(fillPlaceholders('plain {1} text', people)).toEqual({
      ok: true,
      text: 'plain {1} text',
      mentions: [],
    });
  });
  it.each([
    '{unknown}',
    '{commenter:3}',
    '{commenter:0}',
    '{commenter}',
    '{author:1}',
    '{owner:1}',
  ])('rejects %s', (p) => {
    expect(fillPlaceholders(`hi ${p}`, people)).toEqual({ ok: false });
  });
  it('rejects {author} when there is nobody, and a login that is not safe', () => {
    expect(fillPlaceholders('{author}', [])).toEqual({ ok: false });
    expect(fillPlaceholders('{author}', ['bad login'])).toEqual({ ok: false });
  });
});

describe('validateProposalReview: asking the author and the 48 hours', () => {
  const ctx = {
    repo: REPO,
    title: 'T',
    labels: ['ACK_OBTAINED', 'ACK_WAITING', 'HELP_WANTED', 'NEW_CS'],
    current: ['ACK_WAITING'],
    people: ['author', 'bob'],
    files: new Map<string, string>(),
    now: NOW,
  };
  const raw = (over: Partial<RawProposalReview> = {}): RawProposalReview => ({
    verdict: 'real_gap',
    priorDecision: null,
    makesSense: true,
    evidence: [],
    addLabels: [],
    removeLabels: [],
    authorIntent: 'unclear',
    volunteers: [],
    askAuthor: true,
    reviewPr: null,
    helpWanted: false,
    explanation: 'x',
    suggestedComment: 'Thanks for the proposal.',
    injectionDetected: false,
    confidence: 0.7,
    ...over,
  });
  const ask = `@author, would you like to work on this yourself?`;

  it('appends the question to the comment when the model asks and did not name the author', () => {
    const r = validateProposalReview(raw(), ctx);
    expect(r.suggestedComment).toBe(`Thanks for the proposal.\n\n${ask}`);
    expect(r.mentions).toEqual(['author']);
    expect(ASK_AUTHOR).toContain('{author}');
  });

  it('uses the question alone when there is no other comment', () => {
    expect(validateProposalReview(raw({ suggestedComment: '' }), ctx).suggestedComment).toBe(ask);
  });

  it('does not append a second question when the comment already names {author}', () => {
    const r = validateProposalReview(raw({ suggestedComment: 'Hi {author}, interested?' }), ctx);
    expect(r.suggestedComment).toBe('Hi @author, interested?');
  });

  it('never asks when the question was already asked', () => {
    const r = validateProposalReview(raw(), {
      ...ctx,
      asked: { at: '2026-11-11T10:00:00Z', replied: false },
    });
    expect(r.suggestedComment).toBe('Thanks for the proposal.');
    expect(r.askedAuthorAt).toBe('2026-11-11T10:00:00Z');
  });

  it('never asks when the model did not ask, the author is clear, or someone is on it', () => {
    expect(validateProposalReview(raw({ askAuthor: false }), ctx).suggestedComment).toBe(
      'Thanks for the proposal.',
    );
    expect(validateProposalReview(raw({ authorIntent: 'declined' }), ctx).suggestedComment).toBe(
      'Thanks for the proposal.',
    );
    expect(validateProposalReview(raw(), { ...ctx, assignees: ['bob'] }).suggestedComment).toBe(
      'Thanks for the proposal.',
    );
    expect(validateProposalReview(raw({ authorIntent: 'offered' }), ctx).suggestedComment).toBe(
      'Thanks for the proposal.',
    );
  });

  it('drops a comment with a bad placeholder instead of posting it', () => {
    const r = validateProposalReview(raw({ suggestedComment: 'Hi {commenter:9}' }), ctx);
    expect(r.suggestedComment).toBe('');
    expect(r.mentions).toEqual([]);
    expect(r.dropped).toContain('comment (bad placeholder)');
  });

  it('removes an @ the model wrote itself, so it cannot mention anyone', () => {
    const r = validateProposalReview(raw({ askAuthor: false, suggestedComment: 'cc @evil' }), ctx);
    expect(r.suggestedComment).not.toContain('@');
    expect(r.mentions).toEqual([]);
  });

  it('waits for the author for 48 hours after the question, with recheckAt set', () => {
    const at = '2026-11-11T10:00:00Z';
    const r = validateProposalReview(raw({ volunteers: ['bob'], askAuthor: false }), {
      ...ctx,
      asked: { at, replied: false },
    });
    expect(r.assignTo).toBeNull();
    expect(r.recheckAt).toBe('2026-11-13T10:00:00.000Z');
  });

  it('proposes the volunteer after 48 hours of silence and clears recheckAt', () => {
    const r = validateProposalReview(raw({ volunteers: ['bob'], askAuthor: false }), {
      ...ctx,
      now: new Date('2026-11-13T10:00:01Z'),
      asked: { at: '2026-11-11T10:00:00Z', replied: false },
    });
    expect(r).toMatchObject({
      assignTo: 'bob',
      assignWhy: 'author silent 2 days',
      recheckAt: null,
    });
  });
});

describe('digest apply block', () => {
  const ctx = {
    repo: REPO,
    title: 'T',
    labels: ['ACK_OBTAINED', 'ACK_WAITING', 'NEW_CS'],
    current: ['ACK_WAITING'],
    people: ['author'],
    files: new Map<string, string>(),
    now: NOW,
  };
  const review = validateProposalReview(
    {
      verdict: 'real_gap',
      priorDecision: null,
      makesSense: true,
      evidence: [],
      addLabels: ['ACK_OBTAINED'],
      removeLabels: [],
      authorIntent: 'offered',
      volunteers: [],
      askAuthor: false,
      reviewPr: null,
      helpWanted: false,
      explanation: 'x',
      suggestedComment: '',
      injectionDetected: false,
      confidence: 0.8,
    },
    ctx,
  );
  const url =
    'https://custodes.work/admin/approvals/link/0f8e4d2a-1b3c-4d5e-8f90-a1b2c3d4e5f6.1763546400.abcdefghijklmnopqrstuvwxyz012345';
  const digest = (extra: object, r = review) => {
    const base = {
      repo: REPO,
      items: [],
      implementation: [],
      proposals: [{ issue: 7, result: r }],
      omittedAck: 0,
      errors: [],
      since: null,
      now: NOW,
      ...extra,
    };
    return { text: renderDigest(base).text, html: renderDigestHtml(base) };
  };
  const link: ApplyLink = { url, expiresAt: '2026-11-19T10:00:00.000Z', actions: ['issue.assign'] };

  it('shows the link the triage Worker supplied in the text digest, and the HTML block', () => {
    const d = digest({ applyLinks: new Map([[7, link]]) });
    expect(d.text).toContain(`apply in one click (issue.assign; expires 2026-11-19): ${url}`);
    expect(d.html).toContain('Review and apply');
    expect(d.html).toContain('expires 2026-11-19');
  });

  it('makes "Review and apply" in the HTML digest a link to the supplied URL', () => {
    const d = digest({ applyLinks: new Map([[7, link]]) });
    expect(d.html).toContain(`href="${url}"`);
  });

  it('links only an approval URL in the broker token format, nothing else on that host', () => {
    for (const bad of [
      'https://custodes.work/admin/approvals/link/TOKEN123',
      'https://custodes.work/admin/halt',
      'https://custodes.work.evil.example/admin/approvals/link/0f8e4d2a-1b3c-4d5e-8f90-a1b2c3d4e5f6.1763546400.abcdefghijklmnopqrstuvwxyz012345',
    ]) {
      const d = digest({ applyLinks: new Map([[7, { ...link, url: bad }]]) });
      expect(d.html, bad).not.toContain(`href="${bad}"`);
    }
  });

  it('shows no link line when there is no answer for the issue', () => {
    const d = digest({ applyLinks: new Map([[8, link]]) });
    expect(d.text).not.toContain('one click');
    expect(d.html).not.toContain('Review and apply');
    expect(applyLine(undefined)).toEqual([]);
  });

  it('renders the failure reason as inert text, never as a link', () => {
    const reason =
      'broker refused <a href="https://evil.example/x">click</a> https://evil.example/y';
    const d = digest({ applyLinks: new Map([[7, { reason }]]) });
    expect(d.text).toContain('no one-click link:');
    expect(d.text).not.toContain('https://evil.example');
    expect(d.html).toContain('No one-click link:');
    expect(d.html).not.toContain('evil.example');
    expect(d.html).not.toContain('<a href="https://evil');
  });

  it('shows no apply block for a review flagged as an injection attempt', () => {
    const flagged = { ...review, injectionDetected: true };
    const d = digest({ applyLinks: new Map([[7, link]]) }, flagged);
    expect(d.html).not.toContain(url);
  });

  it('says how many proposals have no link, only when there are some', () => {
    const line = '3 more proposal(s) without a one-click link (limit reached); apply them by hand.';
    const d = digest({ withoutLink: 3 });
    expect(d.text).toContain(line);
    expect(d.html).toContain(line);
    const none = digest({ withoutLink: 0 });
    expect(none.text).not.toContain('without a one-click link');
    expect(none.html).not.toContain('without a one-click link');
  });

  it('names the assignment reason and the wait in the recommended actions', () => {
    expect(digest({}).text).toContain('assign @author (author offered)');
    const waiting = {
      ...review,
      assignTo: null,
      assignWhy: null,
      askedAuthorAt: '2026-11-11T10:00:00Z',
      recheckAt: '2026-11-13T10:00:00.000Z',
    };
    expect(digest({}, waiting).text).toContain(
      'wait for the author until 2026-11-13 10:00 UTC (asked 2026-11-11)',
    );
  });
});

describe('TriageApplyIntake', () => {
  const intake = (e: Partial<AgentsEnv> = {}) =>
    new TriageApplyIntake({} as ExecutionContext, { ...(env as AgentsEnv), ...e });

  it('refuses an instance that is not in the instance list, including prototype names', async () => {
    for (const name of ['nope', '__proto__', 'constructor', 'toString', ''])
      expect(await intake().propose(name, {}), name).toEqual({
        ok: false,
        reason: 'unknown instance',
      });
  });

  it('says so when the agent is not deployed in this Worker, and does not touch the proposal', async () => {
    expect(await intake({}).propose('custodes-sandbox', { anything: 1 })).toEqual({
      ok: false,
      reason: 'triage-apply is not deployed here',
    });
  });
});
