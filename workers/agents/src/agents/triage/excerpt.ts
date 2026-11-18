import { z } from 'zod';
import { inertNoLinks, inertNoLinksWords } from './assess.js';
import { issueLabels, type PublicIssue } from './github.js';
import { isSafeName, safeLogin } from './prompt.js';

/** Characters kept per template section, and of a body without sections. */
export const SECTION_CHARS = 300;
export const BODY_CHARS = 600;
export const MAX_SECTIONS = 4;

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

const HEADING = /^#{1,6}[ \t]+(.+?)[ \t#]*$/;

/**
 * The author's answers to the issue template ("What is missing...", "How should this be
 * resolved?"), or the start of the body when it has no headings. Empty sections are skipped.
 */
export function authorExcerpt(body: string | null | undefined): ExcerptPart[] {
  const text = withoutComments(body ?? '');
  const parts: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  for (const line of text.split('\n')) {
    const h = HEADING.exec(line.trim());
    if (h?.[1]) parts.push({ heading: h[1], lines: [] });
    else parts.at(-1)?.lines.push(line);
  }
  const sections = parts.length > 1;
  return parts
    .map((p) => ({ heading: p.heading, text: p.lines.join('\n').trim() }))
    .filter((p) => p.text.length > 0)
    .slice(0, MAX_SECTIONS)
    .map((p) => ({
      heading: p.heading === null ? null : inertNoLinks(p.heading, 80),
      text: inertNoLinksWords(p.text, sections ? SECTION_CHARS : BODY_CHARS),
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
