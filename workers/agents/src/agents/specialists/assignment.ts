/**
 * The assignment rule and comment placeholders for proposal-review (ADR 0019, #108). The model
 * only reports what people said (author's intent, who offered); who gets assigned, and when the
 * 2-day wait is over, is decided here from GitHub-set fields: logins, associations, timestamps.
 */
import { safeLogin } from '../triage/prompt.js';
import type { IssueComment, PublicIssue } from '../triage/github.js';
import { isMaintainer } from './implementation.js';

/** How long the author has to answer our question before someone else who offered is proposed. */
export const AUTHOR_SILENCE_MS = 48 * 3_600_000;

/**
 * The hidden trailer triage-apply comments carry (packages/github trailers, `visibility: hidden`).
 * Only a comment by a maintainer account counts: anyone can paste the text into their own comment.
 */
const OUR_TRAILER = '<!--\nCustodes-Agent: triage-apply@';

export interface AskedAuthor {
  /** When our question was posted (GitHub `created_at`). */
  at: string;
  /** The author commented after it. */
  replied: boolean;
}

/**
 * Our latest question to the author, from the comments read, or null if we never asked. It counts
 * only when posted by `actor` (the account triage-apply posts as), with a maintainer association
 * and the hidden trailer, and only when it names the author: any other triage-apply comment, or a
 * pasted trailer, does not start the 2 days.
 */
export function askedAuthor(
  issue: PublicIssue,
  comments: IssueComment[],
  actor: string | undefined,
): AskedAuthor | null {
  const author = issue.user?.login.toLowerCase();
  // GitHub-set, but checked anyway: it goes into a RegExp.
  if (author === undefined || actor === undefined || !/^[a-z0-9-]{1,39}$/.test(author)) return null;
  const namesAuthor = new RegExp(`(?<![A-Za-z0-9])@${author}(?![A-Za-z0-9-])`, 'i');
  let at: string | null = null;
  for (const c of comments) {
    const body = c.body ?? '';
    if (
      c.user?.login.toLowerCase() === actor.toLowerCase() &&
      isMaintainer(c) &&
      body.includes(OUR_TRAILER) &&
      namesAuthor.test(body) &&
      (at === null || c.created_at > at)
    )
      at = c.created_at;
  }
  if (at === null) return null;
  const asked = at;
  const replied = comments.some(
    (c) => c.user?.login.toLowerCase() === author && c.created_at > asked,
  );
  return { at: asked, replied };
}

export type AuthorIntent = 'offered' | 'declined' | 'unclear';

export interface AssignmentInput {
  intent: AuthorIntent;
  /** Logins the model says offered in their own comment; checked against the thread here. */
  volunteers: string[];
  /** The issue author (when there is a usable one) and every commenter, author first (GitHub-set). */
  people: string[];
  /**
   * The author's login, or null when a bot or a deleted account opened the issue: then nobody is
   * "the author", and every entry of `people` is a commenter. Left out: the first of `people`.
   */
  author?: string | null;
  assignees: string[];
  reviewPr: number | null;
  asked: AskedAuthor | null;
  now: Date;
}

export interface Assignment {
  assignTo: string | null;
  /** Why, for the digest; null when nobody is proposed. */
  why: 'author offered' | 'author declined' | 'author silent 2 days' | 'no author to ask' | null;
  /** When the proposal should be reviewed again (the 2 days end); null when nothing is pending. */
  recheckAt: string | null;
  dropped: string[];
}

/**
 * (a) the author offered: the author; (b) unclear: nobody, the comment asks the author; (c) the
 * author declined, or stayed silent 2 full days after our question: the first other person who
 * offered, in thread order; (d) there is no author to ask (a bot or a deleted account opened the
 * issue): the first person who offered. A commenter is never treated as the author. Nobody when
 * someone is assigned or an open PR does the work.
 */
export function chooseAssignee(i: AssignmentInput): Assignment {
  const dropped: string[] = [];
  const none = (recheckAt: string | null = null): Assignment => ({
    assignTo: null,
    why: null,
    recheckAt,
    dropped,
  });
  const author = i.author === undefined ? (i.people[0] ?? null) : i.author;
  const others = author === null ? i.people : i.people.slice(1);
  if (i.assignees.length > 0 || i.reviewPr !== null) return none();
  if (author === null && others.length === 0) return none();
  if (author !== null && i.intent === 'offered')
    return { assignTo: author, why: 'author offered', recheckAt: null, dropped };
  const silentUntil =
    i.asked && !i.asked.replied ? Date.parse(i.asked.at) + AUTHOR_SILENCE_MS : NaN;
  const silent = !Number.isNaN(silentUntil) && i.now.getTime() >= silentUntil;
  // With an author, others come in only once the author declined or stayed silent.
  if (author !== null && i.intent !== 'declined' && !silent)
    return none(Number.isNaN(silentUntil) ? null : new Date(silentUntil).toISOString());
  const lower = (s: string) => s.toLowerCase();
  const offered = new Set(i.volunteers.map((v) => lower(v.replace(/^@/, ''))));
  for (const v of offered)
    if (!i.people.some((p) => lower(p) === v)) dropped.push('volunteer not in the thread');
  // Thread order, author excluded: the first to comment among those who offered.
  const pick = others.find((p) => offered.has(lower(p)));
  if (pick === undefined) return none();
  return {
    assignTo: pick,
    why:
      author === null
        ? 'no author to ask'
        : i.intent === 'declined'
          ? 'author declined'
          : 'author silent 2 days',
    recheckAt: null,
    dropped,
  };
}

/** The question appended when the model should ask the author but did not name them. */
export const ASK_AUTHOR = '{author}, would you like to work on this yourself?';

/**
 * Replaces `{author}` and `{commenter:N}` (N-th commenter other than the author, 1-based) with
 * @logins from GitHub. Run after sanitizeComment, which removes every `@` the model wrote. Any
 * other `{word}` or `{word:N}`, or an N out of range, rejects the whole comment.
 */
export function fillPlaceholders(
  text: string,
  people: string[],
  /** As in `AssignmentInput`: null when nobody is the author; left out, the first of `people`. */
  authorLogin?: string | null,
): { ok: true; text: string; mentions: string[] } | { ok: false } {
  const author = authorLogin === undefined ? people[0] : (authorLogin ?? undefined);
  const commenters = authorLogin === null ? people : people.slice(1);
  const mentions = new Set<string>();
  const seen = { bad: false };
  const out = text.replace(/\{([A-Za-z_]+)(?::(\d{1,3}))?\}/g, (_m, name: string, n?: string) => {
    let login: string | undefined;
    if (name === 'author' && n === undefined) login = author;
    else if (name === 'commenter' && n !== undefined) login = commenters[Number(n) - 1];
    if (login === undefined || safeLogin(login) !== login) {
      seen.bad = true;
      return '';
    }
    mentions.add(login);
    return `@${login}`;
  });
  return seen.bad ? { ok: false } : { ok: true, text: out, mentions: [...mentions] };
}
