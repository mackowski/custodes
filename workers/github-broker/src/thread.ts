import {
  commentProblem as sharedCommentProblem,
  issueThreadFrom,
  mentionsIn,
  pullThreadFrom,
  readAllPages,
  type CommentProblem,
  type IssueThread,
  type PullThread,
} from '@custodes/core';
import type { BrokerAction } from '@custodes/schema';
import type { BrokerEnv } from './env.js';
import { policy } from './policy.js';
import { read } from './read.js';

/**
 * Threads as GitHub has them now, read through an agent's read policy (read-only token), and who
 * an agent may name in them (ADR 0019, ADR 0024). Used by the approval checks and by `act()`. The
 * snapshot and the thread people are built in `@custodes/core` (`thread-snapshot.ts`), the same
 * code the agent runtime uses, so a runtime proposal's snapshot matches the broker's (ADR 0023).
 */
export type { IssueThread, PullThread };

interface Base {
  agentId: string;
  runId: string;
  repo: string;
  number: number;
}

function pages(
  env: BrokerEnv,
  base: Base,
  resource: 'comments' | 'pull_reviews',
  fetchImpl?: typeof fetch,
) {
  return readAllPages(async (page) => {
    const c = await read(env, { ...base, resource, query: { per_page: 100, page } }, fetchImpl);
    return c.ok
      ? { ok: true as const, data: c.data }
      : { ok: false as const, reason: `${resource} read failed: ${c.code}` };
  });
}

/** Reads the issue and its comments through the agent's read policy (read-only token). */
export async function readIssueThread(
  env: BrokerEnv,
  agentId: string,
  runId: string,
  repo: string,
  issue: number,
  fetchImpl?: typeof fetch,
): Promise<IssueThread> {
  const base = { agentId, runId, repo, number: issue };
  const got = await read(env, { ...base, resource: 'issue', query: {} }, fetchImpl);
  if (!got.ok) return { ok: false, reason: `issue read failed: ${got.code}` };
  // A pull request or an unexpected shape is refused before its comments are read.
  const shape = await issueThreadFrom(got.data, []);
  if (!shape.ok) return shape;
  const comments = await pages(env, base, 'comments', fetchImpl);
  if (!comments.ok) return comments;
  return issueThreadFrom(got.data, comments.items);
}

/**
 * Reads a pull request, its conversation and its reviews through the agent's read policy
 * (ADR 0024). Reviewers count as thread people, like commenters.
 */
export async function readPullThread(
  env: BrokerEnv,
  agentId: string,
  runId: string,
  repo: string,
  pull: number,
  fetchImpl?: typeof fetch,
): Promise<PullThread> {
  const base = { agentId, runId, repo, number: pull };
  const got = await read(env, { ...base, resource: 'pull', query: {} }, fetchImpl);
  if (!got.ok) return { ok: false, reason: `pull read failed: ${got.code}` };
  const shape = await pullThreadFrom(got.data, [], []);
  if (!shape.ok) return shape;
  const comments = await pages(env, base, 'comments', fetchImpl);
  if (!comments.ok) return comments;
  const reviews = await pages(env, base, 'pull_reviews', fetchImpl);
  if (!reviews.ok) return reviews;
  return pullThreadFrom(got.data, comments.items, reviews.items);
}

/**
 * Who this action may name: the thread's people, plus the policy's maintainers for that repository
 * in text only (a ping). An assignee must come from the thread itself (ADR 0019), so the
 * maintainers list never widens assignment (ADR 0024).
 */
export function allowedFor(a: BrokerAction, threadPeople: readonly string[]): string[] {
  return a.type === 'issue.assign'
    ? [...threadPeople]
    : [...threadPeople, ...(policy.maintainers[a.repo] ?? [])];
}

/**
 * The people rule for one action on a thread whose people are known, as a refusal reason, or
 * null. One definition for the bundle path and `act()`.
 */
export function strangerProblem(a: BrokerAction, threadPeople: readonly string[]): string | null {
  const allowed = allowedFor(a, threadPeople).map((p) => p.toLowerCase());
  const stranger = namedBy(a).find((l) => !allowed.includes(l.toLowerCase()));
  if (stranger === undefined) return null;
  return a.type === 'issue.assign'
    ? `@${stranger} is not in the thread`
    : `@${stranger} is neither in the thread nor a listed maintainer`;
}

/** The logins an action names: its assignee, or every @mention in its text. */
export function namedBy(a: BrokerAction): string[] {
  switch (a.type) {
    case 'issue.assign':
      return a.assignees;
    case 'issue.comment':
    case 'issue.close':
    case 'pr.close':
      return mentionsIn(a.body);
    // Assignee removal names nobody new; labels name nobody. pr.review.inline is cheatsheet-review's
    // review, gated by its own approval on OWASP (ADR 0017); retired actions never run.
    case 'issue.unassign':
    case 'issue.label.add':
    case 'issue.label.remove':
    case 'pr.review.inline':
    case 'pr.comment':
    case 'pr.review':
      return [];
  }
}

/** The text an action posts as a comment, for the shared comment rules; null if none. */
export function commentBody(a: BrokerAction): string | null {
  return a.type === 'issue.comment' || a.type === 'issue.close' || a.type === 'pr.close'
    ? a.body
    : null;
}

const PROBLEM_TEXT: Record<CommentProblem, string> = {
  character_reference: 'comment contains an HTML character reference',
  comment_marker: 'comment contains an HTML comment marker',
  link: 'comment contains a link',
  other_repository: 'comment references another repository',
};

/** The shared rule (`@custodes/core`, which triage-apply applies first), in the broker's words. */
export function commentProblem(body: string, repo: string): string | null {
  const problem = sharedCommentProblem(body, repo);
  return problem === null ? null : PROBLEM_TEXT[problem];
}
