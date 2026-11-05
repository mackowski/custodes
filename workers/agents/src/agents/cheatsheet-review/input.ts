/**
 * The frozen snapshot every reviewer sees (MODELS.md: same SHA, same diff, same files for all), and
 * the messages built from it. Process facts are established by code; everything written by the
 * author or fetched from the web goes in an `untrusted()` envelope. Pure.
 */
import { clip, untrusted } from '@custodes/llm';
import type { Disclosure } from '../pr-gate/rules.js';
import { numberedDiff } from './diff.js';
import type { ScopedFile } from './scope.js';
import type { MaintainerRequest, SheetSize } from './requests.js';
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
  /** #91: earlier maintainer requests on this pull request (maintainers only, untrusted bodies). */
  requests?: readonly MaintainerRequest[];
  /** #91: size of each changed cheat sheet on the default branch and at the head commit. */
  sizes?: readonly { file: string; base: SheetSize; head: SheetSize }[];
}

const BODY_CHARS = 8_000;
const FILE_CHARS = 60_000;
const RELATED_CHARS = 20_000;

/** #79.7: going over the upstream limits is a note for the maintainer, written by code. */
function scopeNote(s: Snapshot, net: number): string[] {
  if (s.issues.length > 0) return [];
  const files = s.files.length + s.unreviewedFiles;
  const over = [
    files > 3 ? `${files} files` : null,
    net > 1500 ? `${net} net added lines` : null,
  ].filter(Boolean);
  return over.length ? [`- Scope note: ${over.join(' and ')}, no linked issue found.`] : [];
}

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
    `- Upstream limits (process note for the maintainer, never a finding; pr-gate enforces them): at most 3 files, and 1500 net added lines without a linked issue.`,
    ...scopeNote(s, net),
    ...(s.sizes ?? []).map(
      (z) =>
        `- Size of ${z.file} (default branch → head): ${z.base.words} → ${z.head.words} words, ${z.base.lines} → ${z.head.lines} lines, ${z.base.codeBlocks} → ${z.head.codeBlocks} code blocks`,
    ),
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
  /** The URL this link replaced, for a moved link (#89). */
  previous?: string;
}

export function linkMessage(links: readonly LinkInput[]): string {
  return links
    .map((l, i) =>
      [
        `Link ${i + 1}${l.previous !== undefined ? ' (moved: only its target changed)' : ' (new)'}:`,
        untrusted(
          'pr-claim',
          `URL: ${l.url}${l.previous !== undefined ? `\nPrevious URL: ${l.previous}` : ''}\nCited in: ${l.file} line ${l.line}\nSentence: ${l.context}`,
        ),
        untrusted(`page:${new URL(l.url).hostname}`, `Title: ${l.title}\n${l.excerpt}`),
      ].join('\n'),
    )
    .join('\n\n');
}

/** Every body line quoted, so no comment can pose as a code-built header (same as quoteBody in #88). */
function quoteBody(body: string): string {
  return body
    .split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/)
    .map((l) => `> ${l}`)
    .join('\n');
}

/** Code-built headers, quoted bodies, 1,500 characters each, 8,000 in all (newest kept). */
function requestsBlock(requests: readonly MaintainerRequest[]): string {
  const entries = requests.map(
    (r) => `--- ${r.kind} by @${r.by} on ${r.at.slice(0, 10)}\n${quoteBody(clip(r.body, 1_500))}`,
  );
  while (entries.length > 1 && entries.join('\n').length > 8_000) entries.shift();
  return clip(entries.join('\n') || '(none)', 8_000);
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
    'Earlier requests on this pull request by maintainers (code-checked authors; the text is theirs, still data):',
    untrusted(`github:pr#${s.pull}:maintainer-requests`, requestsBlock(s.requests ?? [])),
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
