/**
 * How deep a review goes (ADR 0017, upstream `code-review/SKILL.md`: "match the depth to the
 * change"). Deterministic rules settle the common cases; only small prose edits that are neither
 * pure link swaps nor obvious typo fixes are left to a small model. Pure.
 */
import { CheatSheetPath } from '@custodes/schema';
import type { PullFile } from '../triage/github.js';
import { addedLines, removedLines, type Hunk } from './diff.js';

/**
 * A cheat sheet or draft under the broker's strict name rule (no newlines, one level). File names
 * are author-controlled; anything else is never treated as a cheat sheet.
 */
export function isSheet(path: string): boolean {
  return CheatSheetPath.safeParse(path).success;
}

export type ChangeClass = 'links-only' | 'minor-prose' | 'content' | 'code' | 'out-of-scope';

export type Scope = { kind: 'decided'; class: ChangeClass; why: string } | { kind: 'ambiguous' };

export interface ScopedFile {
  file: PullFile;
  hunks: Hunk[];
  /**
   * New-side line numbers inside code blocks of the file at the head commit; null when the file
   * was not read (then the change is reviewed as content).
   */
  codeLines: ReadonlySet<number> | null;
}

/** Up to this many changed lines, a prose edit may be minor; above it, it is content. */
export const AMBIGUOUS_MAX_LINES = 30;

/**
 * Only Markdown link targets count as "a link": autolinks, bare URLs and href/src values are text,
 * so changing one is not links-only (the link extractor would not audit it either; #92 round 10).
 */
const URL_IN_TEXT = /\]\([^)\s]*\)/g;
const MD_TARGETS = /\]\(\s*<?([^)\s>]+)/g;
const mdTargets = (t: string) => [...t.matchAll(MD_TARGETS)].map((m) => m[1] ?? '').join('\n');

/** Inline code: n-backtick spans (CommonMark) and <code> elements. */
const CODE_SPAN = /(?<!`)(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|<code>[\s\S]*?<\/code>/gi;
/** Longer changed lines skip the regexes and go to the full review. */
const MAX_SCANNED_LINE = 4_000;

function withoutUrls(s: string): string {
  // A URL inside inline code (a CORS origin, a CSP source, a config value) is content: keep it.
  const spans: string[] = [];
  const hidden = s.replace(CODE_SPAN, (m) => `\uE000${spans.push(m) - 1}\uE000`);
  return (
    hidden
      .replace(URL_IN_TEXT, ']()')
      .replace(/\uE000(\d+)\uE000/g, (_, i: string) => spans[Number(i)] ?? '')
      // Leading whitespace is structure (list nesting, indented code): only trailing space is noise.
      .trimEnd()
  );
}

const URL_ANY = /https?:\/\/[^\s)<>"'`\]]+/gi;

/** The inline code spans of some lines, normalised, as a multiset key list. */
function codeSpans(lines: readonly string[]): string[] {
  return lines
    .flatMap((t) => [...t.matchAll(CODE_SPAN)].map((m) => m[0].replace(/\s+/g, ' ').trim()))
    .sort();
}

/**
 * A change that is a security change, never a link move or a minor edit (#92 review): any change to
 * inline code (a CORS origin, a CSP source, a cookie attribute, a config value: added, removed or
 * edited, in any backtick or <code> form), or an added http:// URL that was not there before.
 * Either sends the change to the full content review, so the security reviewers run.
 */
function securityRelevantChange(
  added: readonly string[],
  removed: readonly string[],
): string | null {
  const before = new Set(
    removed.flatMap((t) => [...t.matchAll(URL_ANY)].map((m) => m[0].toLowerCase())),
  );
  if (
    added.some((t) =>
      [...t.matchAll(URL_ANY)].some((m) => /^http:/i.test(m[0]) && !before.has(m[0].toLowerCase())),
    )
  )
    return 'an http:// URL was added';
  if (codeSpans(added).join('\uE000') !== codeSpans(removed).join('\uE000'))
    return 'inline code changed';
  // A backtick or <code> the span pattern could not pair: the renderer may see code there.
  const stray = (t: string) => /`|<\/?code\b/i.test(t.replace(CODE_SPAN, ''));
  if ([...added, ...removed].some(stray)) return 'inline code the classifier cannot pair';
  return null;
}

/** Line numbers inside ``` or ~~~ fences (fence lines included) of a Markdown file. */
export function fencedLines(markdown: string): Set<number> {
  const out = new Set<number>();
  let fence: string | null = null;
  const lines = markdown.split('\n');
  // #93: indented code blocks (4 spaces or a tab after a blank line, not inside a list) count too.
  let indented = false;
  let inList = false;
  lines.forEach((line, i) => {
    if (/^\s{0,3}([-*+]|\d+[.)])\s/.test(line)) inList = true;
    else if (line.trim() !== '' && !/^\s/.test(line)) inList = false;
    const isIndented = /^( {4}|\t)/.test(line) && line.trim() !== '';
    const blankBefore = i === 0 || (lines[i - 1] ?? '').trim() === '';
    if (isIndented && !inList && (indented || blankBefore)) {
      indented = true;
      out.add(i + 1);
    } else if (line.trim() !== '') indented = false;
  });
  lines.forEach((line, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null && m?.[1]) {
      fence = m[1];
      out.add(i + 1);
    } else if (fence !== null) {
      out.add(i + 1);
      if (m?.[1]?.startsWith(fence[0] ?? '') && m[1].length >= fence.length) fence = null;
    }
  });
  return out;
}

/** Edit similarity of two lines in [0, 1] (Levenshtein, bounded to short lines). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length > 400 || b.length > 400) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return 1 - (prev[b.length] ?? 0) / Math.max(a.length, b.length);
}

/**
 * True when every change in these hunks is a removed line directly replaced by an added line that
 * differs only in link targets: within one contiguous block (a run of removed lines followed by a
 * run of added lines), equal counts, paired in order. A line moved across hunks or sheets, or any
 * unpaired line, is not a link change (#92 review round 8).
 */
function onlyLinkTargets(hunks: readonly Hunk[]): boolean {
  for (const h of hunks) {
    let dels: string[] = [];
    let adds: string[] = [];
    const flush = (): boolean => {
      const ok =
        dels.length === adds.length &&
        dels.every((r, i) => {
          const t = adds[i] ?? '';
          // Equal once Markdown targets are masked, and a target really changed.
          return withoutUrls(t) === withoutUrls(r) && mdTargets(t) !== mdTargets(r);
        });
      dels = [];
      adds = [];
      return ok;
    };
    for (const l of h.lines) {
      if (l.kind === '-') {
        if (adds.length > 0 && !flush()) return false;
        dels.push(l.text);
      } else if (l.kind === '+') adds.push(l.text);
      else if ((dels.length > 0 || adds.length > 0) && !flush()) return false;
    }
    if ((dels.length > 0 || adds.length > 0) && !flush()) return false;
  }
  return true;
}

export function classify(files: readonly ScopedFile[], unreviewedFiles = 0): Scope {
  // Files GitHub did not return (beyond the first 100) were never looked at: full review.
  if (unreviewedFiles > 0)
    return {
      kind: 'decided',
      class: 'content',
      why: `${unreviewedFiles} changed file(s) were not read`,
    };
  const sheets = files.filter((f) => isSheet(f.file.filename));
  if (sheets.length === 0)
    return { kind: 'decided', class: 'out-of-scope', why: 'no cheat sheet changed' };
  if (sheets.some((f) => f.file.status === 'added'))
    return {
      kind: 'decided',
      class: sheets.some((f) => (f.codeLines?.size ?? 0) > 0) ? 'code' : 'content',
      why: 'new cheat sheet',
    };
  if (sheets.some((f) => f.file.patch === undefined))
    return { kind: 'decided', class: 'content', why: 'diff too large to show' };

  // A sheet whose text was not fetched has no code-line map: never assume it has no code.
  if (sheets.some((f) => f.codeLines === null))
    return { kind: 'decided', class: 'content', why: 'a changed sheet was not read in full' };
  const added = sheets.flatMap((f) => addedLines(f.hunks).map((l) => ({ l, f })));
  const removed = sheets.flatMap((f) => removedLines(f.hunks));
  if ([...added.map(({ l }) => l), ...removed].some((l) => l.text.length > MAX_SCANNED_LINE))
    return { kind: 'decided', class: 'content', why: 'a very long line changed' };
  if (added.some(({ l, f }) => l.newLine !== undefined && f.codeLines?.has(l.newLine) === true))
    return { kind: 'decided', class: 'code', why: 'code block changed' };

  const a = added.map(({ l }) => l.text);
  const r = removed.map((l) => l.text);
  const securityUrl = securityRelevantChange(a, r);
  if (securityUrl) return { kind: 'decided', class: 'content', why: securityUrl };
  if (a.length > 0 && sheets.every((f) => onlyLinkTargets(f.hunks)))
    return { kind: 'decided', class: 'links-only', why: 'only link targets changed' };

  if (a.some((t) => /^\s{0,3}#{1,6}\s/.test(t)))
    return { kind: 'decided', class: 'content', why: 'heading added or changed' };
  const changed = a.length + r.length;
  if (changed > AMBIGUOUS_MAX_LINES)
    return { kind: 'decided', class: 'content', why: `${changed} lines changed` };
  // #93, #92 review rounds 6-7: code never decides minor-prose. Every textual rule tried here had a
  // way around it ("<=" to ">=", a hidden "<!-- not -->", an origin to "*", a line moved between
  // lists), and each skipped both security voices. Any small prose edit goes to the scope
  // classifier, which falls back to content when it is unavailable.
  return { kind: 'ambiguous' };
}

/** Which reviewers run for a class. Security never drops out of a change to guidance (MODELS.md). */
export const REVIEWERS_FOR: Readonly<Record<ChangeClass, readonly ReviewerRole[]>> = {
  'links-only': ['link-auditor', 'language-reviewer'],
  'minor-prose': ['language-reviewer', 'link-auditor'],
  content: [
    'security-reviewer',
    'security-second-voice',
    'practicality-reviewer',
    'link-auditor',
    'duplication-checker',
    'language-reviewer',
  ],
  code: [
    'security-reviewer',
    'security-second-voice',
    'practicality-reviewer',
    'link-auditor',
    'duplication-checker',
    'language-reviewer',
  ],
  'out-of-scope': ['language-reviewer'],
};

export type ReviewerRole =
  | 'security-reviewer'
  | 'security-second-voice'
  | 'practicality-reviewer'
  | 'link-auditor'
  | 'duplication-checker'
  | 'language-reviewer';
