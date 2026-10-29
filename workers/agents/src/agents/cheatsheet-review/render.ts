/**
 * The review GitHub shows (ADR 0017). Code writes the structure and the LLM notice; model text is
 * made inert: one line, no HTML, no images, no clickable links except pages the link auditor
 * fetched, and no @mentions. Suggestions are checked against the diff before they become inline
 * comments; the rest stay in the body as text. Pure.
 */
import { inertText } from '@custodes/llm';
import { inOneHunk, type Hunk } from './diff.js';
import { LINEUP, model, type Role, type RoleOutcome } from './lineup.js';
import type { ChangeClass } from './scope.js';
import type { Item, ReviewDecision } from './types.js';

export const DOCS_URL =
  'https://github.com/mackowski/custodes/blob/main/docs/agents/cheatsheet-review.md';

/** Upper bound for the review body: the broker allows 60 000 and appends a trailer. */
const BODY_LIMIT = 55_000;

/**
 * Markdown-safe single line of model text. URLs stay clickable only if `allowed` has them; others
 * become code spans. `@name` becomes a code span so nobody is notified.
 */
export function inertMarkdown(s: string, allowed: ReadonlySet<string>, max = 800): string {
  const one = inertText(s, max * 2)
    .replace(/!\[/g, '[')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const linked = one.replace(/https?:\/\/[^\s)`\]]+/gi, (url) =>
    allowed.has(url) ? url : `\`${url.replace(/`/g, '')}\``,
  );
  return linked.replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g, '$1`@$2`').slice(0, max);
}

export interface InlineComment {
  path: string;
  line: number;
  startLine?: number;
  side: 'RIGHT';
  body: string;
}

export interface CheckedSuggestions {
  comments: InlineComment[];
  /** Suggestions that could not be placed on the diff, rendered in the body instead. */
  rejected: { file: string; line: number; why: string }[];
}

/** The current text of new-side lines `start..end`, when the hunks show all of them. */
function currentText(hunks: readonly Hunk[], start: number, end: number): string | undefined {
  const lines = hunks
    .flatMap((h) => h.lines)
    .filter((l) => l.newLine !== undefined && l.newLine >= start && l.newLine <= end);
  return lines.length === end - start + 1 ? lines.map((l) => l.text).join('\n') : undefined;
}

export function checkSuggestions(
  suggestions: ReviewDecision['suggestions'],
  hunksByFile: ReadonlyMap<string, Hunk[]>,
  allowed: ReadonlySet<string>,
): CheckedSuggestions {
  const out: CheckedSuggestions = { comments: [], rejected: [] };
  const taken = new Set<string>();
  for (const s of suggestions) {
    const hunks = hunksByFile.get(s.file);
    const start = s.startLine ?? s.line;
    const reject = (why: string) => out.rejected.push({ file: s.file, line: s.line, why });
    if (!hunks) {
      reject('file not in this pull request');
      continue;
    }
    if (!inOneHunk(hunks, start, s.line)) {
      reject('lines outside the changed hunks');
      continue;
    }
    if (s.replacement.includes('````')) {
      reject('replacement contains a four-backtick fence');
      continue;
    }
    if (currentText(hunks, start, s.line) === s.replacement) {
      reject('replacement equals the current text');
      continue;
    }
    const key = `${s.file}:${start}-${s.line}`;
    if (taken.has(key)) {
      reject('another suggestion covers these lines');
      continue;
    }
    taken.add(key);
    out.comments.push({
      path: s.file,
      line: s.line,
      ...(s.startLine !== undefined && s.startLine < s.line ? { startLine: s.startLine } : {}),
      side: 'RIGHT',
      body: `${inertMarkdown(s.rationale, allowed, 400)}\n\n\`\`\`\`suggestion\n${s.replacement}\n\`\`\`\``,
    });
    if (out.comments.length === 20) break;
  }
  return out;
}

const ROLE_LABEL: Record<Role, string> = {
  'scope-classifier': 'scope',
  'security-reviewer': 'security',
  'security-second-voice': 'security (second voice)',
  'practicality-reviewer': 'practicality',
  'duplication-checker': 'duplication & placement',
  'link-auditor': 'links & sources',
  'language-reviewer': 'language',
  judge: 'decision',
};

export function modelLine(o: RoleOutcome): string {
  const label = ROLE_LABEL[o.role];
  switch (o.status) {
    case 'ran':
      return `${label}: ${model(o.model).id}`;
    case 'fallback':
      return `${label}: ~~${model(o.failed).id}~~ (unavailable: ${o.why.slice(0, 60)}) → ${model(o.model).id}`;
    case 'unavailable':
      return `${label}: unavailable (${LINEUP[o.role].primary}, ${LINEUP[o.role].fallback})`;
  }
}

/** Whether to ask for changes: only for a security or links BLOCKER, never on one's own PR. */
export function reviewEvent(d: ReviewDecision, ownPull: boolean): 'COMMENT' | 'REQUEST_CHANGES' {
  const blocker = d.mustFix.some(
    (i) =>
      i.severity === 'BLOCKER' && (i.dimension === 'Security' || i.dimension === 'Links & sources'),
  );
  return blocker && d.verdict !== 'MERGE' && !ownPull ? 'REQUEST_CHANGES' : 'COMMENT';
}

export interface ReviewBodyInput {
  decision: ReviewDecision;
  outcomes: readonly RoleOutcome[];
  changeClass: ChangeClass;
  classWhy: string;
  facts: string;
  rejected: CheckedSuggestions['rejected'];
  linkNotes: readonly string[];
  allowed: ReadonlySet<string>;
}

function items(title: string, list: readonly Item[], allowed: ReadonlySet<string>): string[] {
  if (list.length === 0) return [];
  return [
    `### ${title}`,
    '',
    ...list.map(
      (i, n) =>
        `${n + 1}. **${i.severity}** \`${inertText(i.file, 200).replace(/`/g, '')}${i.line ? `:${i.line}` : ''}\` (${i.dimension}): ${inertMarkdown(i.text, allowed)}`,
    ),
    '',
  ];
}

export function reviewBody(r: ReviewBodyInput): string {
  const d = r.decision;
  const a = r.allowed;
  const lines = [
    '> [!NOTE]',
    '> 🤖 **Automated LLM review (multi-model).** This review was written by language models and may be wrong. Please double-check every point; you do not have to agree with it. Inline suggestions are optional. It was started by a maintainer of this repository.',
    '>',
    `> Models: ${r.outcomes.map(modelLine).join(' · ')}`,
    '',
    `**Verdict: ${d.verdict}**`,
    '',
    inertMarkdown(d.rationale, a, 1_000),
    '',
    `Review depth: **${r.changeClass}** (${inertText(r.classWhy, 120)}).`,
    '',
    '### Scope & process',
    '',
    r.facts,
    '',
  ];
  if (d.dimensions.length > 0) {
    lines.push(
      '### Dimension verdicts',
      '',
      '| Dimension | Verdict | Headline |',
      '| --- | --- | --- |',
    );
    for (const x of d.dimensions)
      lines.push(
        `| ${x.dimension} | ${x.verdict} | ${inertMarkdown(x.headline, a, 240).replace(/\|/g, '\\|')} |`,
      );
    lines.push('');
  }
  if (d.verdict === 'CLOSE' && d.closeReasons.length > 0) {
    lines.push(
      '### Reasons for closing',
      '',
      ...d.closeReasons.map((c) => `- ${inertMarkdown(c, a, 400)}`),
      '',
    );
  }
  lines.push(...items('Must-fix before merge', d.mustFix, a));
  if (d.verdict !== 'CLOSE') {
    lines.push(...items('Should-fix', d.shouldFix, a), ...items('Nits', d.nits, a));
  }
  if (r.linkNotes.length > 0)
    lines.push('### Links to verify manually', '', ...r.linkNotes.map((n) => `- ${n}`), '');
  if (r.rejected.length > 0) {
    lines.push(
      '### Suggestions not placed inline',
      '',
      ...r.rejected.map(
        (x) => `- \`${inertText(x.file, 200).replace(/`/g, '')}:${x.line}\`: ${x.why}`,
      ),
      '',
    );
  }
  lines.push('---', `<sub>[How this review works](${DOCS_URL}) · Custodes cheatsheet-review</sub>`);
  const body = lines.join('\n');
  const note = '\n\n…(truncated)';
  return body.length > BODY_LIMIT ? `${body.slice(0, BODY_LIMIT - note.length)}${note}` : body;
}
