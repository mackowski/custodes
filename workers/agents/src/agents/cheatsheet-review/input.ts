/**
 * The frozen snapshot every reviewer sees (MODELS.md: same SHA, same diff, same files for all), and
 * the messages built from it. Process facts are established by code; everything written by the
 * author or fetched from the web goes in an `untrusted()` envelope. Pure.
 */
import { clip, untrusted } from '@custodes/llm';
import type { Disclosure } from '../pr-gate/rules.js';
import { numberedDiff } from './diff.js';
import type { ScopedFile } from './scope.js';
import type { ReviewerReport } from './types.js';

export interface IssueFacts {
  number: number;
  state: string;
  labels: string[];
  assignees: string[];
  authorAssigned: boolean;
}

export interface Snapshot {
  repo: string;
  pull: number;
  headSha: string;
  author: string;
  title: string;
  body: string;
  files: ScopedFile[];
  /** Full text of changed cheat sheets at the head commit, by path. */
  contents: ReadonlyMap<string, string>;
  disclosure: Disclosure;
  issues: IssueFacts[];
  /** File names under `cheatsheets/` on the default branch. */
  sheetNames: string[];
  /** Up to two existing sheets that look most related, by file name. */
  related: ReadonlyMap<string, string>;
  /** Changed files GitHub reports beyond the 100 the broker returns: not reviewed. */
  unreviewedFiles: number;
}

const BODY_CHARS = 8_000;
const FILE_CHARS = 60_000;
const RELATED_CHARS = 20_000;

export function processFacts(s: Snapshot): string {
  const net = s.files.reduce((n, f) => n + f.file.additions - f.file.deletions, 0);
  const issues = s.issues.length
    ? s.issues
        .map(
          (i) =>
            `#${i.number} (${i.state}; labels: ${i.labels.join(', ') || 'none'}; author assigned: ${i.authorAssigned ? 'yes' : 'no'})`,
        )
        .join('; ')
    : 'none linked';
  return [
    'Process facts (established by code, not by the author):',
    `- Repository: ${s.repo}, pull request #${s.pull}, head commit ${s.headSha}`,
    `- Files changed: ${s.files.length + s.unreviewedFiles}; net added lines in the reviewed files: ${net}`,
    ...(s.unreviewedFiles > 0
      ? [
          `- Only the first ${s.files.length} files were reviewed; ${s.unreviewedFiles} more were not read.`,
        ]
      : []),
    `- AI Tool Usage Disclosure section: ${s.disclosure}`,
    `- Linked issues: ${issues}`,
    `- Upstream limits: at most 3 files, and 1500 net added lines without a linked issue.`,
  ].join('\n');
}

function diffs(s: Snapshot): string {
  return s.files
    .map((f) =>
      untrusted(
        `pr-diff:${f.file.filename}`,
        clip(
          f.file.patch === undefined
            ? `--- ${f.file.filename}\n(no textual diff)`
            : numberedDiff(f.file.filename, f.hunks),
          FILE_CHARS,
        ),
      ),
    )
    .join('\n\n');
}

function authorText(s: Snapshot): string {
  return [untrusted('pr-title', s.title), untrusted('pr-body', clip(s.body, BODY_CHARS))].join(
    '\n',
  );
}

function fullFiles(s: Snapshot): string {
  return [...s.contents]
    .map(([path, text]) =>
      untrusted(`cheatsheet:${path}@${s.headSha.slice(0, 7)}`, clip(text, FILE_CHARS)),
    )
    .join('\n\n');
}

export function reviewerMessage(s: Snapshot, opts: { withRelated: boolean }): string {
  const parts = [
    processFacts(s),
    'Pull request title and description:',
    authorText(s),
    'Numbered diff (new-side line numbers on the left):',
    diffs(s),
    'Full text of each changed cheat sheet at the head commit:',
    fullFiles(s),
  ];
  if (opts.withRelated) {
    parts.push(`Existing cheat sheets: ${s.sheetNames.join(', ')}`);
    for (const [name, text] of s.related)
      parts.push(untrusted(`existing:${name}`, clip(text, RELATED_CHARS)));
  }
  return parts.join('\n\n');
}

export function scopeMessage(s: Snapshot): string {
  return ['Numbered diff:', diffs(s)].join('\n\n');
}

export interface LinkInput {
  url: string;
  file: string;
  line: number;
  context: string;
  title: string;
  excerpt: string;
}

export function linkMessage(links: readonly LinkInput[]): string {
  return links
    .map((l, i) =>
      [
        `Link ${i + 1}:`,
        untrusted(
          'pr-claim',
          `URL: ${l.url}\nCited in: ${l.file} line ${l.line}\nSentence: ${l.context}`,
        ),
        untrusted(`page:${new URL(l.url).hostname}`, `Title: ${l.title}\n${l.excerpt}`),
      ].join('\n'),
    )
    .join('\n\n');
}

export function judgeMessage(
  s: Snapshot,
  reports: readonly { role: string; report: ReviewerReport }[],
  notRun: readonly string[],
): string {
  return [
    processFacts(s),
    'Numbered diff (new-side line numbers on the left):',
    diffs(s),
    `Reviewers that did not run: ${notRun.join(', ') || 'none'}`,
    'Reviewer reports:',
    untrusted('reviewer-reports', JSON.stringify(reports)),
  ].join('\n\n');
}

/** Up to two existing sheets whose names share the most words with the changed ones. */
export function relatedSheets(changed: readonly string[], all: readonly string[]): string[] {
  const words = (n: string) =>
    new Set(
      n
        .replace(/_Cheat_Sheet\.md$|\.md$/, '')
        .toLowerCase()
        .split(/[_-]+/)
        .filter((w) => w.length > 2),
    );
  const mine = new Set(changed.flatMap((c) => [...words(c.split('/').pop() ?? c)]));
  const names = new Set(changed.map((c) => c.split('/').pop()));
  return all
    .filter((n) => !names.has(n))
    .map((n) => ({ n, score: [...words(n)].filter((w) => mine.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.n.localeCompare(b.n))
    .slice(0, 2)
    .map((x) => x.n);
}
