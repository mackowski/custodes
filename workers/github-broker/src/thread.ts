import {
  canonicalJson,
  commentProblem as sharedCommentProblem,
  commentsDigest,
  mentionsIn,
  sha256Hex,
  type CommentProblem,
} from '@custodes/core';
import {
  GitHubLogin,
  type BrokerAction,
  type IssueSnapshot,
  type PullSnapshot,
} from '@custodes/schema';
import type { BrokerEnv } from './env.js';
import { policy } from './policy.js';
import { read } from './read.js';

/**
 * Threads as GitHub has them now, read through an agent's read policy (read-only token), and who
 * an agent may name in them (ADR 0019, ADR 0024). Used by the approval checks and by `act()`.
 */

/** The issue as GitHub has it now, and everyone who wrote in it (author first). */
export type IssueThread =
  { ok: true; snapshot: IssueSnapshot; people: string[] } | { ok: false; reason: string };
/** A pull request as GitHub has it now (ADR 0024), and everyone who wrote or reviewed in it. */
export type PullThread =
  { ok: true; snapshot: PullSnapshot; people: string[] } | { ok: false; reason: string };

/** Comment (and review) pages read at most (100 each); a longer thread fails closed. */
const MAX_COMMENT_PAGES = 10;

interface Base {
  agentId: string;
  runId: string;
  repo: string;
  number: number;
}
type RawUser = { login?: unknown; type?: unknown } | null | undefined;

/**
 * `ghost` is GitHub's placeholder for a deleted account: nobody to assign or name, as the agents
 * read it too.
 */
const login = (v: unknown) =>
  typeof v === 'string' && GitHubLogin.safeParse(v).success && v.toLowerCase() !== 'ghost'
    ? v
    : null;

/** Adds a person once; a bot is never a person to assign or name (it could start another agent). */
function addPerson(people: string[], user: RawUser): void {
  if (user?.type === 'Bot') return;
  const who = login(user?.login);
  if (who !== null && !people.some((p) => p.toLowerCase() === who.toLowerCase())) people.push(who);
}

/** Every item of a paged resource (`comments`, `pull_reviews`), or null past the page limit. */
async function readAllPages(
  env: BrokerEnv,
  base: Base,
  resource: 'comments' | 'pull_reviews',
  fetchImpl?: typeof fetch,
): Promise<{ ok: true; items: { user?: RawUser }[] } | { ok: false; reason: string }> {
  const items: { user?: RawUser }[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const c = await read(env, { ...base, resource, query: { per_page: 100, page } }, fetchImpl);
    if (!c.ok) return { ok: false, reason: `${resource} read failed: ${c.code}` };
    const list = Array.isArray(c.data) ? (c.data as { user?: RawUser }[]) : [];
    items.push(...list);
    if (list.length < 100) return { ok: true, items };
  }
  return { ok: false, reason: 'thread too long to check' };
}

/** The fields an issue and a pull request share, read from either GitHub object. */
function commonFields(data: {
  state?: unknown;
  user?: RawUser;
  labels?: ({ name?: unknown } | string)[];
  assignees?: { login?: unknown }[] | null;
  updated_at?: unknown;
}):
  | {
      ok: true;
      state: 'open' | 'closed';
      labels: string[];
      assignees: string[];
      updatedAt: string;
      people: string[];
    }
  | { ok: false } {
  const author = login(data.user?.login);
  // A bot author often has a login we do not accept (`dependabot[bot]`): that is still a known
  // shape. It is never a person to assign or name; the commenters still are.
  const botAuthor =
    data.user?.type === 'Bot' ||
    (typeof data.user?.login === 'string' && data.user.login.toLowerCase() === 'ghost');
  if ((author === null && !botAuthor) || (data.state !== 'open' && data.state !== 'closed'))
    return { ok: false };
  const labels = (data.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : typeof l.name === 'string' ? l.name : ''))
    .filter((l) => l.length > 0)
    .sort();
  const assigned = (data.assignees ?? []).map((a) => login(a.login));
  // An assignee whose login we do not accept is still an assignee: dropping it would make the
  // issue look unassigned and let a bundle assign a second person (ADR 0019).
  if (assigned.includes(null)) return { ok: false };
  if (typeof data.updated_at !== 'string') return { ok: false };
  return {
    ok: true,
    state: data.state,
    labels,
    assignees: assigned.filter((a): a is string => a !== null).sort(),
    updatedAt: data.updated_at,
    people: botAuthor || author === null ? [] : [author],
  };
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
  const data = got.data as Parameters<typeof commonFields>[0] & {
    comments?: unknown;
    pull_request?: unknown;
  };
  if (data.pull_request !== undefined) return { ok: false, reason: 'not an issue' };
  const common = commonFields(data);
  if (!common.ok) return { ok: false, reason: 'unexpected issue shape' };
  const comments = await readAllPages(env, base, 'comments', fetchImpl);
  if (!comments.ok) return comments;
  const people = common.people;
  for (const c of comments.items) addPerson(people, c.user);
  return {
    ok: true,
    snapshot: {
      state: common.state,
      labels: common.labels,
      assignees: common.assignees,
      comments: typeof data.comments === 'number' ? data.comments : comments.items.length,
      updatedAt: common.updatedAt,
      commentsDigest: await commentsDigest(comments.items),
    },
    people,
  };
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
  const data = got.data as Parameters<typeof commonFields>[0] & {
    comments?: unknown;
    head?: { sha?: unknown } | null;
  };
  const common = commonFields(data);
  const headSha = data.head?.sha;
  if (!common.ok || typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha))
    return { ok: false, reason: 'unexpected pull request shape' };
  const comments = await readAllPages(env, base, 'comments', fetchImpl);
  if (!comments.ok) return comments;
  const reviews = await readAllPages(env, base, 'pull_reviews', fetchImpl);
  if (!reviews.ok) return reviews;
  const people = common.people;
  for (const c of comments.items) addPerson(people, c.user);
  for (const r of reviews.items) addPerson(people, r.user);
  return {
    ok: true,
    snapshot: {
      state: common.state,
      labels: common.labels,
      assignees: common.assignees,
      comments: typeof data.comments === 'number' ? data.comments : comments.items.length,
      updatedAt: common.updatedAt,
      commentsDigest: await commentsDigest(comments.items),
      headSha,
      reviewsDigest: await reviewsDigest(reviews.items),
    },
    people,
  };
}

/** sha256 of every review's `[id, state, submitted_at]`, in order: a new or dismissed review shows. */
async function reviewsDigest(reviews: unknown[]): Promise<string> {
  return sha256Hex(
    canonicalJson(
      reviews.map((r) => {
        const x = r as { id?: unknown; state?: unknown; submitted_at?: unknown };
        return [x.id ?? null, x.state ?? null, x.submitted_at ?? null];
      }),
    ),
  );
}

/**
 * Logins an agent may name or assign on a thread (ADR 0024): its people plus the policy's
 * maintainers for that repository.
 */
export function allowedPeople(repo: string, threadPeople: readonly string[]): string[] {
  return [...threadPeople, ...(policy.maintainers[repo] ?? [])];
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
