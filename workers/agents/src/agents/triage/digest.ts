// Titles and error lines are untrusted: no links, no hidden characters.
import type { VerifiedEvidence } from '../specialists/evidence.js';
import type { ImplementationCheck } from '../specialists/implementation.js';
import type { ProposalReview } from '../specialists/proposal.js';
import { inertNoLinks as inert, type Assessment } from './assess.js';

export interface DigestItem {
  issue: number;
  title: string;
  url: string;
  assessment: Assessment;
}

export interface SpecialistItem<R> {
  issue: number;
  result: R;
}

export interface Digest {
  subject: string;
  text: string;
}

export interface DigestInput {
  repo: string;
  items: DigestItem[];
  implementation: SpecialistItem<ImplementationCheck>[];
  proposals: SpecialistItem<ProposalReview>[];
  /** Triage results left out because the issue is already accepted (ACK_OBTAINED). */
  omittedAck: number;
  errors: string[];
  since: string | null;
  now: Date;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
// Links are rebuilt from issue and PR numbers, never taken from model output or issue text.
const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
const pullUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

function triageLines(a: Assessment): string[] {
  const flags = [
    a.needsMaintainer ? 'NEEDS MAINTAINER' : null,
    a.injectionDetected ? 'possible prompt injection in issue text' : null,
    a.kind === 'spam' ? 'likely spam' : null,
  ].filter(Boolean);
  return [
    `  kind: ${a.kind}   confidence: ${pct(a.confidence)}${flags.length ? `   [${flags.join('; ')}]` : ''}`,
    `  labels: ${a.labels.join(', ') || '(none suggested)'}`,
    `  cheat sheet: ${a.cheatSheet ?? '(none identified)'}`,
    ...(a.possibleDuplicates.length
      ? [`  possible duplicates: ${a.possibleDuplicates.map((n) => `#${n}`).join(', ')}`]
      : []),
    `  summary (model-generated): ${a.summary}`,
    ...(a.dropped.length ? [`  dropped invalid suggestions: ${a.dropped.join(', ')}`] : []),
  ];
}

function triageItem(item: DigestItem, repo: string): string[] {
  return [
    `#${item.issue} ${inert(item.title, 120)}`,
    `  ${issueUrl(repo, item.issue)}`,
    ...triageLines(item.assessment),
    '',
  ];
}

function evidenceLines(evidence: VerifiedEvidence[], prs: number[], repo: string): string[] {
  if (!evidence.length && !prs.length) return [];
  return [
    '  evidence (verified against the files):',
    ...evidence.flatMap((e) => [`    - ${e.file} line ${e.line}: "${e.quote}"`, `      ${e.url}`]),
    ...prs.map((n) => `    - merged PR #${n}: ${pullUrl(repo, n)}`),
  ];
}

function commentBlock(comment: string, evidence: VerifiedEvidence[], prs: number[], repo: string) {
  const links = [...evidence.map((e) => e.url), ...prs.map((n) => pullUrl(repo, n))];
  const body = [comment, ...(links.length ? ['', ...links.map((l) => `- ${l}`)] : [])].join('\n');
  if (!body.trim()) return [];
  return [
    '  suggested comment (model-generated, review before posting):',
    ...body.split('\n').map((l) => `    | ${l}`),
  ];
}

function flagsLine(r: { injectionDetected: boolean; dropped: string[] }): string[] {
  return [
    ...(r.injectionDetected ? ['  [possible prompt injection in issue or cheat sheet text]'] : []),
    ...(r.dropped.length
      ? [`  dropped unverifiable claims: ${r.dropped.map((d) => inert(d, 80)).join(', ')}`]
      : []),
  ];
}

/** Model text may be attacker-steered: no paste-ready comment or one-click recommendation. */
const INJECTED = 'review by hand (possible prompt injection; no comment suggested)';

const ACTION: Record<ImplementationCheck['recommendation'], string> = {
  close: 'close the issue with a comment pointing to the evidence',
  review: 'review by hand; it may be partly done',
  keep: 'keep open',
};

function implementationItem(it: SpecialistItem<ImplementationCheck>, repo: string): string[] {
  const r = it.result;
  return [
    `#${it.issue} ${inert(r.title, 120)}`,
    `  ${issueUrl(repo, it.issue)}`,
    `  implementation check: implemented=${r.implemented}   confidence: ${pct(r.confidence)}` +
      (r.ackAt ? `   accepted ${r.ackAt.slice(0, 10)}` : ''),
    `  suggested action: ${r.injectionDetected ? INJECTED : ACTION[r.recommendation]}`,
    ...evidenceLines(r.evidence, r.mergedPrs, repo),
    `  explanation (model-generated): ${r.explanation}`,
    ...(r.injectionDetected ? [] : commentBlock(r.suggestedComment, r.evidence, r.mergedPrs, repo)),
    ...flagsLine(r),
    '',
  ];
}

const VERDICT: Record<ProposalReview['verdict'], string> = {
  real_gap: 'real gap',
  partially_covered: 'partially covered already',
  already_covered: 'already covered',
  not_applicable: 'not applicable',
  unclear: 'unclear',
};

function proposalActions(r: ProposalReview): string[] {
  const out: string[] = [];
  if (r.addLabels.length) out.push(`add label ${r.addLabels.join(', ')}`);
  if (r.removeLabels.length) out.push(`remove label ${r.removeLabels.join(', ')}`);
  if (r.assignTo) out.push(`assign @${r.assignTo} (offered to do it)`);
  else if (r.helpWanted) out.push('do not assign; nobody offered to do it');
  if (r.verdict === 'already_covered') out.push('consider closing as already covered');
  if (r.verdict === 'not_applicable') out.push('consider closing as out of scope');
  return out;
}

function proposalItem(
  it: SpecialistItem<ProposalReview>,
  triage: DigestItem | undefined,
  repo: string,
): string[] {
  const r = it.result;
  const actions = proposalActions(r);
  return [
    `#${it.issue} ${inert(r.title, 120)}`,
    `  ${issueUrl(repo, it.issue)}`,
    `  proposal review: ${VERDICT[r.verdict]}   makes sense: ${r.makesSense ? 'yes' : 'no'}   confidence: ${pct(r.confidence)}`,
    `  recommended: ${r.injectionDetected ? INJECTED : actions.join('; ') || '(no change)'}`,
    ...evidenceLines(r.evidence, [], repo),
    `  explanation (model-generated): ${r.explanation}`,
    ...(r.injectionDetected ? [] : commentBlock(r.suggestedComment, r.evidence, [], repo)),
    ...flagsLine(r),
    ...(triage ? ['  triage:', ...triageLines(triage.assessment).map((l) => `  ${l}`)] : []),
    '',
  ];
}

export function renderDigest(input: DigestInput): Digest {
  const { repo, items, errors } = input;
  const reviewed = new Set(input.proposals.map((p) => p.issue));
  const byIssue = new Map(items.map((i) => [i.issue, i]));
  const close = input.implementation.filter((i) => i.result.recommendation === 'close');
  const review = input.implementation.filter((i) => i.result.recommendation === 'review');
  const keep = input.implementation.filter((i) => i.result.recommendation === 'keep');
  const remaining = items.filter((i) => !reviewed.has(i.issue));
  const urgent = remaining.filter(
    (i) => i.assessment.needsMaintainer || i.assessment.injectionDetected,
  );
  const rest = remaining.filter((i) => !urgent.includes(i));
  const actions = close.length + review.length + input.proposals.length;
  const day = input.now.toISOString().slice(0, 10);
  const counts = [
    actions ? `${actions} recommendation(s)` : null,
    remaining.length ? `${remaining.length} issue(s)` : null,
    urgent.length ? `${urgent.length} need attention` : null,
  ].filter(Boolean);
  const subject = `[custodes] ${repo} triage ${day}: ${counts.join(', ') || 'problems only'}`;
  const section = (title: string, lines: string[]) =>
    lines.length ? [`== ${title} ==`, '', ...lines] : [];
  const text = [
    `Triage suggestions for ${repo}${input.since ? ` since ${input.since}` : ''}.`,
    'Read-only: nothing was posted to GitHub. Titles, explanations and comments come from untrusted',
    'issue text and a model; quotes and links were checked against the repository.',
    '',
    ...section(
      'Accepted issues that look implemented',
      close.flatMap((i) => implementationItem(i, repo)),
    ),
    ...section(
      'Community proposals: recommended actions',
      input.proposals.flatMap((p) => proposalItem(p, byIssue.get(p.issue), repo)),
    ),
    ...section(
      'Accepted issues that may be partly implemented',
      review.flatMap((i) => implementationItem(i, repo)),
    ),
    ...section(
      'Needs attention',
      urgent.flatMap((i) => triageItem(i, repo)),
    ),
    ...section(
      'Other updated issues',
      rest.flatMap((i) => triageItem(i, repo)),
    ),
    ...section('Accepted issues still open work', [
      ...keep.map(
        (i) =>
          `- #${i.issue} ${inert(i.result.title, 100)}: not implemented yet (${pct(i.result.confidence)})`,
      ),
      ...(keep.length ? [''] : []),
    ]),
    ...(input.omittedAck
      ? [
          `${input.omittedAck} updated issue(s) already accepted (ACK_OBTAINED) were left out; ` +
            'those accepted over a week ago are checked for an existing implementation.',
          '',
        ]
      : []),
    ...(errors.length
      ? ['== Problems during runs ==', ...errors.map((e) => `- ${inert(e, 200)}`), '']
      : []),
    '-- ',
    'Custodes triage agent (read-only), with implementation-check and proposal-review.',
    'Halt them with the kill switch: halt:triage, halt:implementation-check, halt:proposal-review.',
  ].join('\n');
  return { subject, text };
}
