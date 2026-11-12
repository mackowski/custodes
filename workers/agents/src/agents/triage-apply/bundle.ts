/**
 * triage-apply (ADR 0019): turns one triage proposal into one bundle of issue actions for the
 * operator to approve. Pure: the agent reads the issue and its comments through the broker and
 * passes them in. The broker checks the same things again before asking and before running.
 */
import { z } from 'zod';
import {
  type ApprovalBundle,
  type BrokerAction,
  BrokerActionType,
  GitHubLogin,
  type IssueSnapshot,
} from '@custodes/schema';
import { issueLabels, type IssueComment, type PublicIssue } from '../triage/github.js';

/** What triage hands over for one issue: the stored proposal, nothing the model wrote unchecked. */
export const ProposalInput = z.object({
  repo: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/),
  issue: z.number().int().positive().max(1_000_000),
  addLabels: z.array(z.string().min(1).max(50)).max(6),
  removeLabels: z.array(z.string().min(1).max(50)).max(6),
  /** Chosen by code from GitHub-set fields (the assignment rule), never by the model alone. */
  assignee: GitHubLogin.nullable(),
  /** Placeholders already replaced by code with logins from GitHub; "" for no comment. */
  comment: z.string().max(3_000),
  /** One line for the operator's approval page: why this proposal. */
  reason: z.string().max(300),
});
export type ProposalInput = z.infer<typeof ProposalInput>;

/** triage-apply's answer; triage parses it on receipt (an RPC peer is still another component). */
export const ProposeResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    token: z.string().regex(/^[0-9a-f-]{36}\.\d{1,12}\.[A-Za-z0-9_-]{20,100}$/),
    expiresAt: z.iso.datetime(),
    actions: z.array(BrokerActionType).min(1).max(4),
    dropped: z.array(z.string().max(100)).max(10),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.string().max(300),
    dropped: z.array(z.string().max(100)).max(10).optional(),
  }),
]);
export type ProposeResult = z.infer<typeof ProposeResult>;

const lower = (s: string) => s.toLowerCase();

/** The snapshot the broker compares against: sorted names, the comment count GitHub reports. */
export function snapshotOf(issue: PublicIssue, commentsDigest: string): IssueSnapshot | null {
  if (issue.state !== 'open' && issue.state !== 'closed') return null;
  return {
    updatedAt: issue.updated_at,
    commentsDigest,
    state: issue.state,
    labels: issueLabels(issue)
      .filter((l) => l.length > 0)
      .sort(),
    assignees: (issue.assignees ?? [])
      .map((a) => a.login)
      .filter((l) => GitHubLogin.safeParse(l).success)
      .sort(),
    comments: issue.comments,
  };
}

/** The author and every commenter, as GitHub reports them (author first, case-insensitive set). */
export function threadPeople(issue: PublicIssue, comments: IssueComment[]): string[] {
  const out: string[] = [];
  for (const l of [issue.user?.login, ...comments.map((c) => c.user?.login)])
    if (l && GitHubLogin.safeParse(l).success && !out.some((p) => lower(p) === lower(l)))
      out.push(l);
  return out;
}

/** Same rules as the broker's `commentProblem` (it checks again): see there for why. */
export function commentProblem(body: string, repo: string): string | null {
  if (/&(#|[A-Za-z][A-Za-z0-9]*;)/.test(body)) return 'HTML character reference';
  if (body.includes('<!--') || body.includes('-->')) return 'HTML comment marker';
  if (/https?:|www\./i.test(body)) return 'link';
  for (const m of body.matchAll(/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#\d+/g))
    if (m[1]?.toLowerCase() !== repo.toLowerCase()) return 'reference to another repository';
  return null;
}

/** Same rule as the broker's `mentionsIn`: `@name` not after a letter or digit. */
export function mentionsIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/(?<![A-Za-z0-9])@([A-Za-z0-9-]{1,39})/g))
    if (m[1] !== undefined) out.add(m[1]);
  return [...out];
}

/**
 * The bundle for one proposal, in run order, with what was left out and why. Fails when the issue
 * is not an open issue, when nothing is left to do, or when the thread is longer than was read.
 */
export function buildBundle(
  input: ProposalInput,
  issue: PublicIssue,
  comments: IssueComment[],
  /** `commentsDigest(comments)` from @custodes/core, computed by the caller (async). */
  commentsDigest: string,
): { ok: true; bundle: ApprovalBundle; dropped: string[] } | { ok: false; reason: string } {
  if (issue.pull_request !== undefined) return { ok: false, reason: 'not an issue' };
  if (issue.number !== input.issue) return { ok: false, reason: 'wrong issue' };
  if (issue.state !== 'open') return { ok: false, reason: 'issue is not open' };
  if (comments.length < issue.comments) return { ok: false, reason: 'thread longer than was read' };
  const snapshot = snapshotOf(issue, commentsDigest);
  if (snapshot === null) return { ok: false, reason: 'unexpected issue shape' };
  const people = threadPeople(issue, comments);
  const inThread = (l: string) => people.some((p) => lower(p) === lower(l));
  const has = new Set(snapshot.labels.map(lower));
  const dropped: string[] = [];
  const actions: BrokerAction[] = [];
  const target = { repo: input.repo, issue: input.issue };

  if (input.assignee !== null) {
    if (snapshot.assignees.length > 0) dropped.push('assignee (already assigned)');
    else if (!inThread(input.assignee)) dropped.push('assignee (not in the thread)');
    else actions.push({ type: 'issue.assign', ...target, assignees: [input.assignee] });
  }
  const add = [...new Set(input.addLabels)].filter((l) => !has.has(lower(l)));
  if (add.length) actions.push({ type: 'issue.label.add', ...target, labels: add });
  // Only labels the issue has: removing a missing label is a GitHub 404, which would stop the bundle.
  const remove = [...new Set(input.removeLabels)].filter(
    (l) => has.has(lower(l)) && !add.some((a) => lower(a) === lower(l)),
  );
  if (remove.length) actions.push({ type: 'issue.label.remove', ...target, labels: remove });
  const body = input.comment.trim();
  const problem = body ? commentProblem(body, input.repo) : null;
  if (problem !== null) dropped.push(`comment (${problem})`);
  else if (body) {
    const stranger = mentionsIn(body).find((l) => !inThread(l));
    if (stranger !== undefined) dropped.push('comment (names someone outside the thread)');
    else actions.push({ type: 'issue.comment', ...target, body });
  }
  if (actions.length === 0) return { ok: false, reason: 'nothing left to apply' };
  return { ok: true, bundle: { actions, snapshot }, dropped };
}
