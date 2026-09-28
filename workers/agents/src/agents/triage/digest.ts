// Titles and error lines are untrusted: no links, no hidden characters.
import { inertNoLinks as inert, type Assessment } from './assess.js';

export interface DigestItem {
  issue: number;
  title: string;
  url: string;
  assessment: Assessment;
}

export interface Digest {
  subject: string;
  text: string;
}

function line(item: DigestItem, repo: string): string[] {
  const a = item.assessment;
  const flags = [
    a.needsMaintainer ? 'NEEDS MAINTAINER' : null,
    a.injectionDetected ? 'possible prompt injection in issue text' : null,
    a.kind === 'spam' ? 'likely spam' : null,
  ].filter(Boolean);
  return [
    `#${item.issue} ${inert(item.title, 120)}`,
    // The URL is rebuilt from the issue number, never taken from model output or issue text.
    `  https://github.com/${repo}/issues/${item.issue}`,
    `  kind: ${a.kind}   confidence: ${Math.round(a.confidence * 100)}%${flags.length ? `   [${flags.join('; ')}]` : ''}`,
    `  labels: ${a.labels.join(', ') || '(none suggested)'}`,
    `  cheat sheet: ${a.cheatSheet ?? '(none identified)'}`,
    ...(a.possibleDuplicates.length
      ? [`  possible duplicates: ${a.possibleDuplicates.map((n) => `#${n}`).join(', ')}`]
      : []),
    `  summary (model-generated): ${a.summary}`,
    ...(a.dropped.length ? [`  dropped invalid suggestions: ${a.dropped.join(', ')}`] : []),
    '',
  ];
}

export function renderDigest(opts: {
  repo: string;
  items: DigestItem[];
  errors: string[];
  since: string | null;
  now: Date;
}): Digest {
  const { repo, items, errors } = opts;
  const urgent = items.filter(
    (i) => i.assessment.needsMaintainer || i.assessment.injectionDetected,
  );
  const rest = items.filter((i) => !urgent.includes(i));
  const day = opts.now.toISOString().slice(0, 10);
  const subject = `[custodes] ${repo} triage ${day}: ${items.length} issue(s)${urgent.length ? `, ${urgent.length} need attention` : ''}`;
  const text = [
    `Triage suggestions for ${repo}${opts.since ? ` since ${opts.since}` : ''}.`,
    'Read-only: nothing was posted to GitHub. Titles and summaries come from untrusted issue text and a model.',
    '',
    ...(urgent.length
      ? ['== Needs attention ==', '', ...urgent.flatMap((i) => line(i, repo))]
      : []),
    ...(rest.length
      ? ['== Other updated issues ==', '', ...rest.flatMap((i) => line(i, repo))]
      : []),
    ...(errors.length
      ? ['== Problems during runs ==', ...errors.map((e) => `- ${inert(e, 200)}`), '']
      : []),
    '-- ',
    'Custodes triage agent (read-only). Halt it with the kill switch: halt:triage.',
  ].join('\n');
  return { subject, text };
}
