import { GitHubLogin, type IssueSnapshot, type PullSnapshot } from '@custodes/schema';
import { canonicalJson, sha256Hex } from './canonical.js';
import { commentsDigest } from './issue-digest.js';

/**
 * How an issue's or a pull request's snapshot and thread people are built from GitHub's JSON
 * (ADR 0019, ADR 0024). One definition for the broker, which checks a snapshot before it writes,
 * and the agent runtime, which reads the target and proposes with that snapshot (ADR 0023): two
 * copies would disagree on one field and turn every runtime write into a stale no-op.
 */

/** The issue as GitHub has it now, and everyone who wrote in it (author first). */
export type IssueThread =
  { ok: true; snapshot: IssueSnapshot; people: string[] } | { ok: false; reason: string };
/** A pull request as GitHub has it now (ADR 0024), and everyone who wrote or reviewed in it. */
export type PullThread =
  { ok: true; snapshot: PullSnapshot; people: string[] } | { ok: false; reason: string };

/** Comment (and review) pages read at most (100 each); a longer thread fails closed. */
const MAX_THREAD_PAGES = 10;

type RawUser = { login?: unknown; type?: unknown } | null | undefined;
interface RawThread {
  state?: unknown;
  user?: RawUser;
  labels?: ({ name?: unknown } | string)[];
  assignees?: { login?: unknown }[] | null;
  updated_at?: unknown;
  comments?: unknown;
}

/** `ghost` is GitHub's placeholder for a deleted account: nobody to assign or name. */
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

/**
 * Every item of a paged resource, page by page, or a refusal past MAX_THREAD_PAGES. `readPage`
 * returns the page's items or why it could not be read.
 */
export async function readAllPages(
  readPage: (page: number) => Promise<{ ok: true; data: unknown } | { ok: false; reason: string }>,
): Promise<{ ok: true; items: unknown[] } | { ok: false; reason: string }> {
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_THREAD_PAGES; page++) {
    const got = await readPage(page);
    if (!got.ok) return got;
    const list = Array.isArray(got.data) ? (got.data as unknown[]) : [];
    items.push(...list);
    if (list.length < 100) return { ok: true, items };
  }
  return { ok: false, reason: 'thread too long to check' };
}

/** The fields an issue and a pull request share, read from either GitHub object. */
function commonFields(data: RawThread):
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

/** An issue's thread from its JSON and every comment. A pull request is refused. */
export async function issueThreadFrom(data: unknown, comments: unknown[]): Promise<IssueThread> {
  const d = (data ?? {}) as RawThread & { pull_request?: unknown };
  if (d.pull_request !== undefined) return { ok: false, reason: 'not an issue' };
  const common = commonFields(d);
  if (!common.ok) return { ok: false, reason: 'unexpected issue shape' };
  const people = common.people;
  for (const c of comments) addPerson(people, (c as { user?: RawUser }).user);
  return {
    ok: true,
    snapshot: {
      state: common.state,
      labels: common.labels,
      assignees: common.assignees,
      comments: typeof d.comments === 'number' ? d.comments : comments.length,
      updatedAt: common.updatedAt,
      commentsDigest: await commentsDigest(comments),
    },
    people,
  };
}

/** The pull request's head SHA, or null for an unexpected shape. */
function headShaOf(data: unknown): string | null {
  const sha = (data as { head?: { sha?: unknown } | null } | null)?.head?.sha;
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** A pull request's thread from its JSON, every conversation comment and every review. */
export async function pullThreadFrom(
  data: unknown,
  comments: unknown[],
  reviews: unknown[],
): Promise<PullThread> {
  const d = (data ?? {}) as RawThread;
  const common = commonFields(d);
  const headSha = headShaOf(data);
  if (!common.ok || headSha === null) return { ok: false, reason: 'unexpected pull request shape' };
  const people = common.people;
  for (const c of comments) addPerson(people, (c as { user?: RawUser }).user);
  for (const r of reviews) addPerson(people, (r as { user?: RawUser }).user);
  return {
    ok: true,
    snapshot: {
      state: common.state,
      labels: common.labels,
      assignees: common.assignees,
      comments: typeof d.comments === 'number' ? d.comments : comments.length,
      updatedAt: common.updatedAt,
      commentsDigest: await commentsDigest(comments),
      headSha,
      reviewsDigest: await reviewsDigest(reviews),
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
