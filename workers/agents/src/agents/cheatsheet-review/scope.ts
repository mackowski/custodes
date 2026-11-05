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
  /** New-side line numbers inside fenced code blocks of the file at the head commit. */
  codeLines: ReadonlySet<number>;
}

/** Up to this many changed lines, a prose edit may be minor; above it, it is content. */
export const AMBIGUOUS_MAX_LINES = 30;

const URL_IN_TEXT = /\]\([^)\s]*\)|<https?:\/\/[^>\s]*>|https?:\/\/[^\s)>\]]+/g;

/** Inline code: n-backtick spans (CommonMark) and <code> elements. */
const CODE_SPAN = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|<code>[\s\S]*?<\/code>/gi;

function withoutUrls(s: string): string {
  // A URL inside inline code (a CORS origin, a CSP source, a config value) is content: keep it.
  const spans: string[] = [];
  const hidden = s.replace(CODE_SPAN, (m) => `\uE000${spans.push(m) - 1}\uE000`);
  return hidden
    .replace(URL_IN_TEXT, ']()')
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => spans[Number(i)] ?? '')
    .trim();
}

const URL_ANY = /https?:\/\/[^\s)<>"'`\]]+/gi;

/** The inline code spans of some lines, normalised, as a multiset key list. */
function codeSpans(lines: readonly string[]): string[] {
  return lines
    .flatMap((t) =>
      [...t.matchAll(CODE_SPAN)].map((m) => m[0].toLowerCase().replace(/\s+/g, ' ').trim()),
    )
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
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
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

/** Words whose addition or removal can turn advice into its opposite (#93). */
const GUIDANCE_WORDS = new Set([
  'always',
  'never',
  'not',
  'no',
  "don't",
  'do',
  'must',
  'should',
  'may',
  'can',
  'cannot',
  'avoid',
  'prefer',
  'disable',
  'enable',
  'disabled',
  'enabled',
  'allow',
  'deny',
  'allowed',
  'denied',
  'only',
  'unless',
  'required',
  'optional',
  'safe',
  'unsafe',
  'secure',
  'insecure',
  'recommended',
  'discouraged',
  'deprecated',
  'sufficient',
  'insufficient',
  'strong',
  'weak',
]);

/** True when the words that differ between two lines include a guidance word. */
export function flipsGuidance(before: string, after: string): boolean {
  const words = (t: string) => t.toLowerCase().match(/[a-z']+/g) ?? [];
  const count = (ws: string[]) =>
    ws.reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>());
  const b = count(words(before));
  const a = count(words(after));
  for (const w of new Set([...b.keys(), ...a.keys()]))
    if ((b.get(w) ?? 0) !== (a.get(w) ?? 0) && GUIDANCE_WORDS.has(w)) return true;
  return false;
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

export function classify(files: readonly ScopedFile[]): Scope {
  const sheets = files.filter((f) => isSheet(f.file.filename));
  if (sheets.length === 0)
    return { kind: 'decided', class: 'out-of-scope', why: 'no cheat sheet changed' };
  if (sheets.some((f) => f.file.status === 'added'))
    return {
      kind: 'decided',
      class: sheets.some((f) => f.codeLines.size > 0) ? 'code' : 'content',
      why: 'new cheat sheet',
    };
  if (sheets.some((f) => f.file.patch === undefined))
    return { kind: 'decided', class: 'content', why: 'diff too large to show' };

  const added = sheets.flatMap((f) => addedLines(f.hunks).map((l) => ({ l, f })));
  const removed = sheets.flatMap((f) => removedLines(f.hunks));
  if (added.some(({ l, f }) => l.newLine !== undefined && f.codeLines.has(l.newLine)))
    return { kind: 'decided', class: 'code', why: 'code block changed' };

  const a = added.map(({ l }) => l.text);
  const r = removed.map((l) => l.text);
  const securityUrl = securityRelevantChange(a, r);
  if (securityUrl) return { kind: 'decided', class: 'content', why: securityUrl };
  if (
    a.length > 0 &&
    a.length === r.length &&
    a.every((t, i) => t !== r[i] && withoutUrls(t) === withoutUrls(r[i] ?? ''))
  )
    return { kind: 'decided', class: 'links-only', why: 'only link targets changed' };

  if (a.some((t) => /^\s{0,3}#{1,6}\s/.test(t)))
    return { kind: 'decided', class: 'content', why: 'heading added or changed' };
  const changed = a.length + r.length;
  if (changed > AMBIGUOUS_MAX_LINES)
    return { kind: 'decided', class: 'content', why: `${changed} lines changed` };
  if (
    a.length === r.length &&
    a.every((t, i) => similarity(withoutUrls(t), withoutUrls(r[i] ?? '')) >= 0.85)
  ) {
    // #93: a small edit can flip guidance ("Always" to "Never"); let the classifier decide.
    if (a.some((t, i) => flipsGuidance(r[i] ?? '', t))) return { kind: 'ambiguous' };
    return { kind: 'decided', class: 'minor-prose', why: 'small edits to existing lines' };
  }
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
