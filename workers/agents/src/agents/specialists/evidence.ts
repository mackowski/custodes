import { z } from 'zod';
import { inertNoLinks } from '../triage/assess.js';

/** What a model may claim as evidence: a file it was shown and a line copied from it. */
export const RawEvidence = z.object({
  file: z.string().max(150),
  quote: z.string().max(400),
});
export type RawEvidence = z.infer<typeof RawEvidence>;

/** Evidence that was found verbatim in the file; everything shown to the operator is rebuilt here. */
export const VerifiedEvidence = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  quote: z.string(),
  url: z
    .url()
    .refine((u) =>
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/HEAD\/cheatsheets\//.test(u),
    ),
});
export type VerifiedEvidence = z.infer<typeof VerifiedEvidence>;

const INVISIBLE = new RegExp('[\\p{Cc}\\p{Cf}]', 'gu');
const MIN_QUOTE = 12;
const MAX_QUOTE = 200;

function normalize(s: string): string {
  return s.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
}

/** Link to a line of a cheat sheet on the default branch, built from validated parts only. */
export function cheatSheetLineUrl(repo: string, file: string, line: number): string {
  return `https://github.com/${repo}/blob/HEAD/cheatsheets/${encodeURIComponent(file)}#L${line}`;
}

/**
 * Keeps only quotes that occur in a single line of a file the model was actually given, and
 * returns the line number so the operator can check it. The quote shown is the file's own text,
 * not the model's, and links are never taken from model output.
 */
export function verifyEvidence(
  repo: string,
  claims: RawEvidence[],
  files: ReadonlyMap<string, string>,
  dropped: string[],
): VerifiedEvidence[] {
  const out: VerifiedEvidence[] = [];
  for (const c of claims) {
    const content = files.get(c.file);
    const quote = normalize(c.quote);
    if (content === undefined || quote.length < MIN_QUOTE || quote.length > MAX_QUOTE) {
      dropped.push(`evidence in "${inertNoLinks(c.file, 60)}"`);
      continue;
    }
    const lines = content.split('\n');
    const idx = lines.findIndex((l) => normalize(l).includes(quote));
    if (idx < 0) {
      dropped.push(`unverifiable quote in ${inertNoLinks(c.file, 60)}`);
      continue;
    }
    if (out.some((e) => e.file === c.file && e.line === idx + 1)) continue;
    out.push({
      file: c.file,
      line: idx + 1,
      quote: stripLinks(quote),
      url: cheatSheetLineUrl(repo, c.file, idx + 1),
    });
  }
  return out.slice(0, 5);
}

/** Plain URLs, protocol-relative URLs and bare `domain.tld/path` (mail clients auto-link those). */
function stripLinks(s: string): string {
  return (
    s
      .replace(/https?:\/\/\S*/gi, '[link removed]')
      .replace(/www\.\S*/gi, '[link removed]')
      // Protocol-relative `//host` (and any leftover `//`).
      .replace(/\/\/\S*/g, '[link removed]')
      .replace(/[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,10}\/\S*/gi, '[link removed]')
  );
}

/** Markdown and HTML link forms that GitHub renders as live links or remote images. */
function stripMarkup(input: string): string {
  // Remove innermost tags until none are left, so `<scr<x>ipt>` cannot reassemble into a tag,
  // then drop any stray angle bracket.
  let s = input;
  let prev: string;
  do {
    prev = s;
    s = s.replace(/<[^<>]*>/g, '');
  } while (s !== prev);
  return s
    .replace(/[<>]/g, '')
    .replace(/^\s*\[[^\]]*\]:\s*\S+.*$/, '')
    .replace(/\]\([^)]*\)/g, ']');
}

/**
 * A model-written comment the operator may paste into GitHub. Multi-line Markdown is kept, but
 * links, @-mentions and hidden characters are removed and the size is bounded; links the operator
 * can trust are appended separately from verified evidence.
 */
export function sanitizeComment(s: string): string {
  return (
    s
      // Link destinations may span lines (`[x](\nhost)`), so this runs on the whole text.
      .replace(/\]\([^)]*\)/g, ']')
      .split(/\r?\n/)
      .map((l) =>
        stripLinks(stripMarkup(l))
          .replace(INVISIBLE, ' ')
          .replace(/@/g, '')
          .replace(/[ \t]+/g, ' ')
          .trimEnd(),
      )
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .split('\n')
      .slice(0, 20)
      .join('\n')
      .slice(0, 1500)
  );
}
