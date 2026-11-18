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
  labels: z.array(z.string()),
  excerpt: z.array(z.object({ heading: z.string().nullable(), text: z.string() })),
});
export type IssueContext = z.infer<typeof IssueContext>;
export type ExcerptPart = IssueContext['excerpt'][number];

/** Removes HTML comments (the templates' hints), including one left open at the end. */
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
 * `Node.js` stays readable as `Node[.]js`) and e-mail addresses. Input is already bounded.
 */
export function defang(s: string): string {
  return s
    .replace(/@/g, '[at]')
    .replace(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, (m) => m.replace(/\./g, '[.]'));
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

export function issueContext(issue: PublicIssue): IssueContext {
  return {
    author: safeLogin(issue.user?.login),
    openedAt: issue.created_at,
    comments: issue.comments,
    labels: issueLabels(issue).filter(isSafeName),
    excerpt: authorExcerpt(issue.body),
  };
}
