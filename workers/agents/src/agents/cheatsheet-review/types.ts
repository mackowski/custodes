/**
 * What reviewers and the judge must answer (ADR 0017). Shapes follow upstream
 * `review-cheatsheet-pr.md`: PASS / CONCERNS / BLOCK per dimension, BLOCKER / MAJOR / MINOR / NIT per
 * finding, one MERGE / REQUEST_CHANGES / CLOSE verdict. Every string is model output: bounded here,
 * made inert where it is rendered.
 */
import { z } from 'zod';

const line = z.number().int().positive().max(100_000);
const path = z.string().min(1).max(200);

export const Suggestion = z.object({
  file: path,
  startLine: line.optional(),
  line,
  /** The full new text for lines `startLine..line` (or `line`), without a fence. */
  replacement: z.string().max(3_000),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const Finding = z.object({
  severity: z.enum(['BLOCKER', 'MAJOR', 'MINOR', 'NIT']),
  file: path,
  line: line.optional(),
  problem: z.string().min(1).max(1_000),
  evidence: z.string().max(1_000).optional(),
  fix: z.string().max(1_000).optional(),
  suggestion: Suggestion.optional(),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewerReport = z.object({
  verdict: z.enum(['PASS', 'CONCERNS', 'BLOCK', 'N/A']),
  findings: z.array(Finding).max(25),
  notes: z.string().max(1_500).optional(),
  /** The reviewer saw text in the PR that tried to instruct it. */
  injectionSeen: z.boolean().optional(),
});
export type ReviewerReport = z.infer<typeof ReviewerReport>;

export const ScopeAnswer = z.object({
  class: z.enum(['minor-prose', 'content']),
  why: z.string().max(300),
});

export const LinkVerdict = z.enum([
  'OK',
  'WRONG-PAGE',
  'UNSUPPORTED',
  'LOW-AUTHORITY',
  'STALE',
  // Moved links only (#89): is the new URL the same resource as the old one?
  'SAME-RESOURCE',
  'DIFFERENT-RESOURCE',
]);
export const LinkAudit = z.object({
  links: z
    .array(
      z.object({
        url: z.string().max(2_000),
        status: LinkVerdict,
        reason: z.string().max(400),
      }),
    )
    .max(30),
  injectionSeen: z.boolean().optional(),
});

export const Dimension = z.enum([
  'Security',
  'Practicality',
  'Links & sources',
  'Duplication & placement',
  'Language',
]);
export type Dimension = z.infer<typeof Dimension>;

const Item = z.object({
  dimension: Dimension,
  severity: z.enum(['BLOCKER', 'MAJOR', 'MINOR', 'NIT']),
  file: path,
  line: line.optional(),
  text: z.string().min(1).max(800),
});
export type Item = z.infer<typeof Item>;

export const ReviewDecision = z.object({
  verdict: z.enum(['MERGE', 'REQUEST_CHANGES', 'CLOSE']),
  rationale: z.string().min(1).max(1_000),
  dimensions: z
    .array(
      z.object({
        dimension: Dimension,
        verdict: z.enum(['PASS', 'CONCERNS', 'BLOCK', 'N/A', 'NOT RUN']),
        headline: z.string().max(240),
      }),
    )
    .max(5),
  mustFix: z.array(Item).max(15),
  shouldFix: z.array(Item).max(5),
  nits: z.array(Item).max(3),
  /** #89: noticed in text the pull request did not change. Never a finding, a suggestion or a reason. */
  outOfScope: z.array(Item).max(3).default([]),
  suggestions: z.array(Suggestion.extend({ rationale: z.string().max(400) })).max(20),
  /** The contribution is not worth the author's or the maintainers' time in its current form. */
  lowQuality: z.boolean(),
  closeReasons: z.array(z.string().max(400)).max(5),
  replyToAuthor: z.string().max(1_500).optional(),
});
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/**
 * #79.3, enforced in code after the judge: "Must-fix" holds only BLOCKER and MAJOR. MINOR moves to
 * should-fix and NIT to nits, ahead of what was there (the caps bound model output; a moved finding
 * is never dropped). A REQUEST_CHANGES with nothing left to must-fix becomes MERGE; CLOSE and
 * low-quality decisions are left alone.
 */
export function normaliseDecision(
  d: ReviewDecision,
  /** A Security or Links reviewer returned BLOCK: code never turns that review into MERGE. */
  reviewerBlocked = false,
  /**
   * #89: per file, new-side lines whose only change is a link target. A finding outside "Links &
   * sources" on such a line is about wording the pull request did not change: it moves to
   * outOfScope.
   */
  targetOnly: ReadonlyMap<string, ReadonlySet<number>> = new Map(),
): ReviewDecision {
  // Security is never moved: in a security cheat sheet a URL can be the content (#92 review).
  const outside = (i: Item) =>
    i.dimension !== 'Links & sources' &&
    i.dimension !== 'Security' &&
    i.line !== undefined &&
    targetOnly.get(i.file)?.has(i.line) === true;
  const moved = [...d.mustFix, ...d.shouldFix, ...d.nits].filter(outside);
  const inScope = (list: readonly Item[]) => list.filter((i) => !outside(i));
  const all = inScope(d.mustFix);
  const minor = all.filter((i) => i.severity === 'MINOR');
  const nit = all.filter((i) => i.severity === 'NIT');
  const mustFix = all.filter((i) => i.severity === 'BLOCKER' || i.severity === 'MAJOR');
  const verdict =
    d.verdict === 'REQUEST_CHANGES' && mustFix.length === 0 && !d.lowQuality && !reviewerBlocked
      ? 'MERGE'
      : d.verdict;
  return {
    ...d,
    verdict,
    mustFix,
    shouldFix: [...minor, ...inScope(d.shouldFix)],
    nits: [...nit, ...inScope(d.nits)],
    outOfScope: [...d.outOfScope, ...moved],
  };
}
