/**
 * The assignment rule and comment placeholders for proposal-review (ADR 0019, #108). The model
 * only reports what people said (author's intent, who offered); who gets assigned, and when the
 * 2-day wait is over, is decided here from GitHub-set fields: logins, associations, timestamps.
 */
import { safeLogin } from '../triage/prompt.js';
import type { IssueComment, PublicIssue } from '../triage/github.js';

/** How long the author has to answer our question before someone else who offered is proposed. */
export const AUTHOR_SILENCE_MS = 48 * 3_600_000;

/** Associations GitHub sets for people with write access to the repository. */
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

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

/** Our latest question to the author, from the comments read, or null if we never asked. */
export function askedAuthor(issue: PublicIssue, comments: IssueComment[]): AskedAuthor | null {
  const author = issue.user?.login.toLowerCase();
  let at: string | null = null;
  for (const c of comments)
    if (
      MAINTAINER_ASSOCIATIONS.has(c.author_association ?? '') &&
      (c.body ?? '').includes(OUR_TRAILER) &&
      (at === null || c.created_at > at)
    )
      at = c.created_at;
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
  /** The issue author and every commenter, author first (GitHub-set). */
  people: string[];
  assignees: string[];
  reviewPr: number | null;
  asked: AskedAuthor | null;
  now: Date;
}

export interface Assignment {
  assignTo: string | null;
  /** Why, for the digest; null when nobody is proposed. */
  why: 'author offered' | 'author declined' | 'author silent 2 days' | null;
  /** When the proposal should be reviewed again (the 2 days end); null when nothing is pending. */
  recheckAt: string | null;
  dropped: string[];
}

/**
 * (a) the author offered: the author; (b) unclear: nobody, the comment asks the author; (c) the
 * author declined, or stayed silent 2 full days after our question: the first other person who
 * offered, in thread order. Nobody when someone is assigned or an open PR does the work.
 */
export function chooseAssignee(i: AssignmentInput): Assignment {
  const dropped: string[] = [];
  const none = (recheckAt: string | null = null): Assignment => ({
    assignTo: null,
    why: null,
    recheckAt,
    dropped,
  });
  const author = i.people[0];
  if (i.assignees.length > 0 || i.reviewPr !== null || author === undefined) return none();
  if (i.intent === 'offered')
    return { assignTo: author, why: 'author offered', recheckAt: null, dropped };
  const silentUntil =
    i.asked && !i.asked.replied ? Date.parse(i.asked.at) + AUTHOR_SILENCE_MS : NaN;
  const silent = !Number.isNaN(silentUntil) && i.now.getTime() >= silentUntil;
  if (i.intent !== 'declined' && !silent)
    return none(Number.isNaN(silentUntil) ? null : new Date(silentUntil).toISOString());
  const lower = (s: string) => s.toLowerCase();
  const offered = new Set(i.volunteers.map((v) => lower(v.replace(/^@/, ''))));
  for (const v of offered)
    if (!i.people.some((p) => lower(p) === v)) dropped.push('volunteer not in the thread');
  // Thread order, author excluded: the first to comment among those who offered.
  const pick = i.people.slice(1).find((p) => offered.has(lower(p)));
  if (pick === undefined) return none();
  return {
    assignTo: pick,
    why: i.intent === 'declined' ? 'author declined' : 'author silent 2 days',
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
): { ok: true; text: string; mentions: string[] } | { ok: false } {
  const author = people[0];
  const commenters = people.slice(1);
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
