import { z } from 'zod';
import { inertNoLinks, inertNoLinksWords } from './assess.js';
import { issueLabels, type PublicIssue } from './github.js';
import { isSafeName, safeLogin } from './prompt.js';

/** Characters kept per template section, and of a body without sections. */
export const SECTION_CHARS = 300;
export const BODY_CHARS = 600;
export const MAX_SECTIONS = 4;
/** Shown instead of the author's text when triage reads the issue as likely spam. */
export const SPAM_EXCERPT = '(not shown: likely spam)';
/** Raw characters read: bounds every regex below on any issue body (GitHub allows 65,536). */
export const MAX_INPUT = 20_000;
/** Raw characters of one section passed on to the link and character cleaning. */
const SECTION_INPUT = 1_500;

/**
 * What the digest shows about a new issue so the operator can decide without opening it: GitHub
 * facts and the author's own text. The text is untrusted and already inert (no links, no hidden
 * characters, bounded); it is never sent to a model from here.
 */
export const IssueContext = z.object({
  author: z.string(),
  openedAt: z.string(),
  comments: z.number().int().nonnegative(),
  /** The issue version the excerpt was read from (GitHub `updated_at`). */
  readAt: z.string(),
  /** HTML comments removed from the text: GitHub hides them too, and injections like to sit there. */
  hiddenComments: z.number().int().nonnegative().default(0),
  /** Set at send time when the issue changed after the excerpt was read. */
  stale: z.boolean().optional(),
  labels: z.array(z.string()),
  excerpt: z.array(z.object({ heading: z.string().nullable(), text: z.string() })),
});
export type IssueContext = z.infer<typeof IssueContext>;
export type ExcerptPart = IssueContext['excerpt'][number];

/** Removes HTML comments (the templates' hints), including one left open at the end. */
/** How many HTML comments the (bounded) body holds, the templates' own hints included. */
export function countComments(s: string): number {
  let n = 0;
  for (let at = s.indexOf('<!--'); at !== -1; at = s.indexOf('<!--', at + 4)) n++;
  return n;
}

function withoutComments(s: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const open = s.indexOf('<!--', at);
    if (open === -1) return out + s.slice(at);
    out += s.slice(at, open);
    const close = s.indexOf('-->', open + 4);
    if (close === -1) return out;
    at = close + 3;
  }
}

/**
 * An ATX heading's text, or null. A plain scan, no regex: a backtracking pattern over a long line
 * of spaces could run for minutes inside a poll (security review 2026-11-18).
 */
function headingText(line: string): string | null {
  const t = line.trim();
  let i = 0;
  while (i < t.length && i < 7 && t[i] === '#') i++;
  if (i < 1 || i > 6 || (t[i] !== ' ' && t[i] !== '\t')) return null;
  let end = Math.min(t.length, 200);
  while (end > i && (t[end - 1] === '#' || t[end - 1] === ' ' || t[end - 1] === '\t')) end--;
  const text = t.slice(i, end).trim();
  return text.length ? text : null;
}

/**
 * Defangs what mail clients turn into links even without a scheme: bare domains (`evil.example`,
 * `Node.js` stays readable as `Node[.]js`), including non-ASCII labels, combining marks and the
 * ideographic and fullwidth dots, and e-mail addresses. Input is already bounded.
 */
export function defang(s: string): string {
  return s
    .replace(/@/g, '[at]')
    .replace(
      /[\p{L}\p{N}\p{M}-]+(?:[.\u2024\u3002\uFE52\uFF0E\uFF61][\p{L}\p{N}\p{M}-]+)+/gu,
      (m) => m.replace(/[.\u2024\u3002\uFE52\uFF0E\uFF61]/g, '[.]'),
    );
}

/** Untrusted author text for the digest: defanged, then no links or hidden characters, bounded. */
function clean(s: string, maxChars: number): string {
  return inertNoLinksWords(defang(s.slice(0, SECTION_INPUT)), maxChars);
}

/**
 * The author's answers to the issue template ("What is missing...", "How should this be
 * resolved?"), or the start of the body when it has no headings. Empty sections are skipped.
 */
export function authorExcerpt(body: string | null | undefined): ExcerptPart[] {
  const text = withoutComments((body ?? '').slice(0, MAX_INPUT));
  const parts: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  for (const line of text.split('\n')) {
    const h = headingText(line);
    if (h !== null) parts.push({ heading: h, lines: [] });
    else parts.at(-1)?.lines.push(line);
  }
  const sections = parts.length > 1;
  return parts
    .map((p) => ({ heading: p.heading, text: p.lines.join('\n').trim() }))
    .filter((p) => p.text.length > 0)
    .slice(0, MAX_SECTIONS)
    .map((p) => ({
      heading: p.heading === null ? null : inertNoLinks(defang(p.heading), 80),
      text: clean(p.text, sections ? SECTION_CHARS : BODY_CHARS),
    }))
    .filter((p) => p.text.length > 0);
}

/**
 * The card context of every issue in a digest: the stored facts and author text, with labels as
 * they are now when the issue changed since, and no author text for likely spam (scam text such as
 * phone numbers or "contact me at" stays out of the inbox; the facts stay).
 */
export function digestContexts(
  items: { issue: number; assessment: { kind: string } }[],
  proposals: { issue: number }[],
  stored: (issue: number) => IssueContext | undefined,
  current: ReadonlyMap<number, { labels: string[]; updatedAt: string }>,
): Map<number, IssueContext> {
  const spam = new Set(items.filter((i) => i.assessment.kind === 'spam').map((i) => i.issue));
  const out = new Map<number, IssueContext>();
  for (const n of new Set([...items.map((i) => i.issue), ...proposals.map((p) => p.issue)])) {
    const ctx = stored(n);
    if (!ctx) continue;
    const now = current.get(n);
    out.set(n, {
      ...ctx,
      ...(now ? { labels: now.labels.filter(isSafeName) } : {}),
      // A newer version may have edited the text (or removed something pasted by mistake).
      ...(now && Date.parse(now.updatedAt) > Date.parse(ctx.readAt) ? { stale: true } : {}),
      ...(spam.has(n) ? { excerpt: [{ heading: null, text: SPAM_EXCERPT }] } : {}),
    });
  }
  return out;
}

export function issueContext(issue: PublicIssue): IssueContext {
  return {
    author: safeLogin(issue.user?.login),
    openedAt: issue.created_at,
    comments: issue.comments,
    readAt: issue.updated_at,
    hiddenComments: countComments((issue.body ?? '').slice(0, MAX_INPUT)),
    labels: issueLabels(issue).filter(isSafeName),
    excerpt: authorExcerpt(issue.body),
  };
}
