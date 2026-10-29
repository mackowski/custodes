/**
 * Unified-diff hunks of one changed file, as GitHub returns them in `pull_files[].patch`. Pure.
 *
 * Inline review comments may only sit on new-side (RIGHT) lines inside a hunk, and a multi-line
 * comment must stay inside one hunk; these helpers are the only judge of that (ADR 0017).
 */

export interface DiffLine {
  kind: '+' | '-' | ' ';
  /** Line number in the new file; absent for removed lines. */
  newLine?: number;
  text: string;
}

export interface Hunk {
  newStart: number;
  newEnd: number;
  lines: DiffLine[];
}

const HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parsePatch(patch: string | undefined): Hunk[] {
  if (!patch) return [];
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let next = 0;
  for (const raw of patch.split('\n')) {
    const h = HEADER.exec(raw);
    if (h) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      current = { newStart: start, newEnd: start + Math.max(count, 1) - 1, lines: [] };
      hunks.push(current);
      next = start;
      continue;
    }
    if (!current) continue;
    const kind = raw[0];
    const text = raw.slice(1);
    if (kind === '+' || kind === ' ') {
      current.lines.push({ kind, newLine: next, text });
      next++;
    } else if (kind === '-') {
      current.lines.push({ kind, text });
    }
    // `\ No newline at end of file` and anything else is not a line.
  }
  return hunks;
}

/** True when lines `start..end` of the new file are all inside one hunk. */
export function inOneHunk(hunks: readonly Hunk[], start: number, end: number): boolean {
  return hunks.some((h) => start >= h.newStart && end <= h.newEnd && start <= end);
}

export function addedLines(hunks: readonly Hunk[]): DiffLine[] {
  return hunks.flatMap((h) => h.lines.filter((l) => l.kind === '+'));
}

export function removedLines(hunks: readonly Hunk[]): DiffLine[] {
  return hunks.flatMap((h) => h.lines.filter((l) => l.kind === '-'));
}

const TAG: Record<DiffLine['kind'], string> = { '+': 'ADD', '-': 'DEL', ' ': '   ' };

/**
 * The diff as reviewers see it: new-side line numbers on added and context lines, so a finding or
 * a suggestion can name a line that really exists. Words, not `+`/`-`: a `-` marker reads as a
 * Markdown list item (the scope eval misread a typo fix that way). Format in `DIFF_FORMAT`.
 */
export function numberedDiff(file: string, hunks: readonly Hunk[]): string {
  const out = [`--- ${file}`];
  for (const h of hunks) {
    out.push(`@@ new lines ${h.newStart}-${h.newEnd} @@`);
    for (const l of h.lines)
      out.push(
        `${l.newLine === undefined ? '     ' : String(l.newLine).padStart(5)} ${TAG[l.kind]} | ${l.text}`,
      );
  }
  return out.join('\n');
}
