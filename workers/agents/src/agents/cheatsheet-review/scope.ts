/**
 * How deep a review goes (ADR 0017, upstream `code-review/SKILL.md`: "match the depth to the
 * change"). Deterministic rules settle the common cases; only small prose edits that are neither
 * pure link swaps nor obvious typo fixes are left to a small model. Pure.
 */
import { CONTENT_PATH } from '../pr-gate/rules.js';
import type { PullFile } from '../triage/github.js';
import { addedLines, removedLines, type Hunk } from './diff.js';

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

function withoutUrls(s: string): string {
  return s.replace(URL_IN_TEXT, ']()').trim();
}

/** Line numbers inside ``` or ~~~ fences (fence lines included) of a Markdown file. */
export function fencedLines(markdown: string): Set<number> {
  const out = new Set<number>();
  let fence: string | null = null;
  markdown.split('\n').forEach((line, i) => {
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
  const sheets = files.filter((f) => CONTENT_PATH.test(f.file.filename));
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
  )
    return { kind: 'decided', class: 'minor-prose', why: 'small edits to existing lines' };
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
