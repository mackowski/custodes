/**
 * Earlier maintainer requests on a pull request, and the size of each changed cheat sheet before
 * and after (#91, ADR 0017 amendment). Who counts as a maintainer comes from GitHub's
 * `author_association` (OWNER, MEMBER, COLLABORATOR), the filter of ADR 0013; bots and this
 * agent's own posted reviews are left out. The bodies stay untrusted. Pure.
 */
import { AGENT_TRAILER, MAINTAINER_ASSOCIATIONS } from '../pr-gate/rules.js';
import { safeLogin } from '../triage/prompt.js';
import type { IssueComment, PullReview } from '../triage/github.js';

/** The marker every review this agent posts starts with (render.ts). */
export const OWN_REVIEW_MARKER = 'Automated LLM review (multi-model)';
/** Requests shown to the judge: the newest ones. */
export const MAX_REQUESTS = 10;

export interface MaintainerRequest {
  /** Login in GitHub's charset (safeLogin). */
  by: string;
  at: string;
  kind: 'review' | 'comment';
  body: string;
}

interface Authored {
  user?: { login: string; type?: string | undefined } | null;
  author_association?: string | undefined;
  body?: string | null | undefined;
}

/** Lines of a body that are not Markdown quotes (a maintainer quoting the bot keeps their own words). */
function unquoted(body: string): string {
  return body
    .split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/)
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
}

function counts(x: Authored, prAuthor: string): boolean {
  const login = x.user?.login ?? '';
  const body = x.body ?? '';
  const own = unquoted(body);
  return (
    MAINTAINER_ASSOCIATIONS.has(x.author_association ?? '') &&
    x.user?.type !== 'Bot' &&
    !login.endsWith('[bot]') &&
    // The PR author is never their own maintainer (as in pr-gate's maintainerComments, ADR 0013).
    login.toLowerCase() !== prAuthor.toLowerCase() &&
    body.trim() !== '' &&
    // Anything an agent posted: the broker trailer (cannot be left out) or this agent's notice.
    !AGENT_TRAILER.test(own) &&
    !own.includes(OWN_REVIEW_MARKER)
  );
}

/** Maintainers' review summaries and conversation comments, oldest first, the newest MAX kept. */
export function maintainerRequests(
  comments: readonly IssueComment[],
  reviews: readonly PullReview[],
  prAuthor = '',
): MaintainerRequest[] {
  const all: MaintainerRequest[] = [
    ...comments
      .filter((c) => counts(c, prAuthor))
      .map((c) => ({
        by: safeLogin(c.user?.login),
        at: c.created_at,
        kind: 'comment' as const,
        // Only the maintainer's own words: a quote-reply carries someone else's text.
        body: unquoted(c.body ?? '').trim(),
      })),
    ...reviews
      // A pending review is not posted; a dismissed one was withdrawn.
      .filter((r) => counts(r, prAuthor) && r.state !== 'PENDING' && r.state !== 'DISMISSED')
      .map((r) => ({
        by: safeLogin(r.user?.login),
        at: r.submitted_at ?? '',
        kind: 'review' as const,
        body: unquoted(r.body ?? '').trim(),
      })),
  ].filter((r) => r.by !== 'unknown' && r.body !== '');
  return all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_REQUESTS);
}

export interface SheetSize {
  words: number;
  lines: number;
  codeBlocks: number;
}

/**
 * Words, lines and fenced code blocks of a Markdown file. Lines count every line, blank ones too,
 * as the diff and editors do (a final newline does not start another line; `wc -l` counts one fewer
 * when the file has no final newline): a maintainer compares this fact with the diff (OWASP PR 3004 showed 59 → 66 for a 96 → 107 line file).
 */
export function sheetSize(markdown: string): SheetSize {
  const lines = markdown === '' ? 0 : markdown.replace(/\r?\n$/, '').split(/\r?\n/).length;
  return {
    words: words(markdown),
    lines,
    codeBlocks: Math.floor(fences(markdown) / 2),
  };
}

const fences = (text: string) => (text.match(/^\s{0,3}(`{3,}|~{3,})/gm) ?? []).length;
const words = (text: string) => (text.match(/\S+/g) ?? []).length;

/**
 * The sheet before this pull request, from its head content and the diff (#155): head minus added
 * lines plus removed lines. The default branch is not the base: once it moves on, its size no longer
 * matches the diff (OWASP PRs 2902 → 2925 → 2927 chained 596 → 506 → 416). Undefined when the patch
 * does not account for every changed line (GitHub leaves `patch` out of large diffs).
 */
export function sizeBefore(
  head: string,
  added: readonly string[],
  removed: readonly string[],
  counts: { additions: number; deletions: number },
): SheetSize | undefined {
  if (added.length !== counts.additions || removed.length !== counts.deletions) return undefined;
  const h = sheetSize(head);
  const join = (l: readonly string[]) => l.join('\n');
  return {
    words: h.words - words(join(added)) + words(join(removed)),
    lines: h.lines - added.length + removed.length,
    codeBlocks: Math.floor((fences(head) - fences(join(added)) + fences(join(removed))) / 2),
  };
}
