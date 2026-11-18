// Titles and error lines are untrusted: no links, no hidden characters.
import type { VerifiedEvidence } from '../specialists/evidence.js';
import type { ProposalReview } from '../specialists/proposal.js';
import { inertNoLinks as inert, type Assessment } from './assess.js';
import type { IssueContext } from './excerpt.js';

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
  html: string;
}

/**
 * triage-apply's answer for one proposal (ADR 0019): the approval link, or why there is none. The
 * URL is built by triage from a token whose format was checked; never from model or issue text.
 */
export type ApplyLink = { url: string; expiresAt: string; actions: string[] } | { reason: string };

export interface DigestInput {
  repo: string;
  items: DigestItem[];
  proposals: SpecialistItem<ProposalReview>[];
  /** GitHub facts and the author's inert text per issue (absent for rows stored before them). */
  contexts?: ReadonlyMap<number, IssueContext>;
  /** One-click approval links per issue (absent until triage-apply is bound). */
  applyLinks?: ReadonlyMap<number, ApplyLink>;
  /** Proposals over the link limit for this digest or the pending-approval limit. */
  withoutLink?: number;
  /** Items left out because the issue was accepted or assigned since triage saw it. */
  omittedTaken: number;
  /** Items left out because the issue was closed after it was assessed. */
  omittedClosed?: number;
  errors: string[];
  since: string | null;
  now: Date;
}

export const pct = (n: number) => `${Math.round(n * 100)}%`;
// Links are rebuilt from issue and PR numbers, never taken from model output or issue text.
export const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;
export const pullUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;

function triageLines(a: Assessment, withSummary = true): string[] {
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
    ...(withSummary ? [`  summary (model-generated): ${a.summary}`] : []),
    ...(a.dropped.length ? [`  dropped invalid suggestions: ${a.dropped.join(', ')}`] : []),
  ];
}

const DAY_MS = 86_400_000;

/** One line of GitHub facts: who opened it, when, how busy it is and how it is labelled now. */
export function factsLine(c: IssueContext, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - Date.parse(c.openedAt)) / DAY_MS));
  return (
    `opened by @${c.author} on ${c.openedAt.slice(0, 10)} (${days === 0 ? 'today' : `${days} day(s) ago`}), ` +
    `${c.comments} comment(s), labels: ${c.labels.join(', ') || '(none)'}`
  );
}

export const NO_EXCERPT = '(no text stored; open the issue)';
export const EXCERPT_LABEL = "author's text (untrusted, unchecked, links removed)";

/** The context block: facts, then the author's own words, each section on its own line. */
function contextLines(c: IssueContext | undefined, now: Date): string[] {
  if (!c) return [`  ${EXCERPT_LABEL}: ${NO_EXCERPT}`];
  return [
    `  ${factsLine(c, now)}`,
    `  ${EXCERPT_LABEL}:`,
    ...(c.excerpt.length
      ? c.excerpt.map((p) => `    > ${p.heading ? `[${p.heading}] ` : ''}${p.text}`)
      : ['    > (empty)']),
  ];
}

function triageItem(item: DigestItem, repo: string, c: IssueContext | undefined, now: Date) {
  return [
    `#${item.issue} ${inert(item.title, 120)}`,
    `  ${issueUrl(repo, item.issue)}`,
    ...contextLines(c, now),
    ...triageLines(item.assessment),
    '',
  ];
}

function evidenceLines(evidence: VerifiedEvidence[]): string[] {
  if (!evidence.length) return [];
  return [
    '  evidence (verified against the files):',
    ...evidence.flatMap((e) => [`    - ${e.file} line ${e.line}: "${e.quote}"`, `      ${e.url}`]),
  ];
}

function commentBlock(comment: string, evidence: VerifiedEvidence[]) {
  const links = evidence.map((e) => e.url);
  const body = [comment, ...(links.length ? ['', ...links.map((l) => `- ${l}`)] : [])].join('\n');
  if (!body.trim()) return [];
  return [
    '  suggested comment (model-generated, review before posting):',
    ...body.split('\n').map((l) => `    | ${l}`),
  ];
}

function flagsLine(r: { injectionDetected: boolean; dropped: string[] }): string[] {
  return [
    ...(r.injectionDetected
      ? ['  [possible prompt injection in issue, comment, PR title or cheat sheet text]']
      : []),
    ...(r.dropped.length
      ? [`  dropped unverifiable claims: ${r.dropped.map((d) => inert(d, 80)).join(', ')}`]
      : []),
  ];
}

/** Model text may be attacker-steered: no paste-ready comment or one-click recommendation. */
export const INJECTED = 'review by hand (possible prompt injection; no comment suggested)';

/** A maintainer comment newer than this means the author has the next step. */
export const WAIT_MS = 14 * 86_400_000;

const recent = (at: string, now: Date) => now.getTime() - Date.parse(at) < WAIT_MS;

export const VERDICT: Record<ProposalReview['verdict'], string> = {
  real_gap: 'real gap',
  partially_covered: 'partially covered already',
  already_covered: 'already covered',
  not_applicable: 'not applicable',
  unclear: 'unclear',
};

/**
 * A proposal where a maintainer spoke last within WAIT_MS and nothing is left to do: the author
 * has the next step. Decided by code from GitHub-set data; a flagged review is never collapsed.
 */
export function proposalWaiting(r: ProposalReview, now: Date): boolean {
  // The stored thread is stale once the issue changed after the review (a reply may be waiting).
  if (r.changedSinceReview) return false;
  const t = r.thread;
  if (r.injectionDetected || !t?.lastByMaintainer || !recent(t.lastCommentAt, now)) return false;
  const closing = r.verdict === 'already_covered' || r.verdict === 'not_applicable';
  return (
    !closing &&
    r.reviewPr === null &&
    r.assignTo === null &&
    r.addLabels.length === 0 &&
    r.removeLabels.length === 0
  );
}

/**
 * Why an assignee was proposed, worded so the operator checks it: intent is the model's reading
 * of the thread (an injection can fake it); only the 2-day silence is measured by code.
 */
export function assignWhyText(why: NonNullable<ProposalReview['assignWhy']>): string {
  switch (why) {
    case 'author offered':
      return 'the model reads the author as offering to do it';
    case 'author declined':
      return 'the model reads the author as declining; the first other volunteer';
    case 'author silent 2 days':
      return 'no reply from the author 2 days after our question; the first volunteer';
    case 'no author to ask':
      return 'a bot or a deleted account opened the issue; the first volunteer';
  }
}

export function proposalActions(r: ProposalReview): string[] {
  const out: string[] = [];
  if (r.thread && !r.thread.lastByMaintainer)
    out.push(
      `answer the latest comment (by @${r.thread.lastCommentBy} on ${r.thread.lastCommentAt.slice(0, 10)})`,
    );
  // The model's reading, not a check: anyone can open a PR that mentions an issue.
  if (r.reviewPr) {
    const by = r.linkedPrs.find((p) => p.number === r.reviewPr)?.author;
    const author = by && by !== 'unknown' ? ` by @${by}` : '';
    out.push(`review the open PR #${r.reviewPr}${author} (the model reads it as doing this work)`);
  }
  if (r.addLabels.length) out.push(`add label ${r.addLabels.join(', ')}`);
  if (r.removeLabels.length) out.push(`remove label ${r.removeLabels.join(', ')}`);
  if (r.assignTo)
    out.push(
      `assign @${r.assignTo} (${r.assignWhy ? assignWhyText(r.assignWhy) : 'offered to do it'})`,
    );
  else if (r.askedAuthorAt && r.recheckAt)
    out.push(
      `wait for the author until ${r.recheckAt.slice(0, 16).replace('T', ' ')} UTC (asked ${r.askedAuthorAt.slice(0, 10)})`,
    );
  else if (r.assignees.length)
    out.push(`already assigned to ${r.assignees.map((a) => `@${a}`).join(', ')}`);
  else if (r.helpWanted) out.push('do not assign; nobody offered to do it');
  if (r.verdict === 'already_covered') out.push('consider closing as already covered');
  if (r.verdict === 'not_applicable') out.push('consider closing as out of scope');
  return out;
}

/** The one-click line for a proposal, when triage-apply answered for it. */
export function applyLine(a: ApplyLink | undefined): string[] {
  if (!a) return [];
  return 'url' in a
    ? [
        `  apply in one click (${a.actions.join(', ')}; expires ${a.expiresAt.slice(0, 10)}): ${a.url}`,
      ]
    : [`  no one-click link: ${inert(a.reason, 160)}`];
}

/**
 * A proposal card: what to decide first (recommended actions and the one-click link), then what
 * the author asks for in their own words, then the review that supports the recommendation.
 */
function proposalItem(
  it: SpecialistItem<ProposalReview>,
  triage: DigestItem | undefined,
  repo: string,
  c: IssueContext | undefined,
  now: Date,
  apply?: ApplyLink,
): string[] {
  const r = it.result;
  const actions = proposalActions(r);
  return [
    `#${it.issue} ${inert(r.title, 120)}`,
    `  ${issueUrl(repo, it.issue)}`,
    `  recommended: ${r.injectionDetected ? INJECTED : actions.join('; ') || '(no change)'}`,
    ...applyLine(apply),
    ...contextLines(c, now),
    `  proposal review: ${VERDICT[r.verdict]}   makes sense: ${r.makesSense ? 'yes' : 'no'}   confidence: ${pct(r.confidence)}`,
    ...(r.priorDecision
      ? [
          `  follows a maintainer decision in #${r.priorDecision.issue} (${issueUrl(repo, r.priorDecision.issue)}), referenced by ${r.priorDecision.via ?? 'unknown'}: ${r.priorDecision.summary}`,
        ]
      : []),
    ...(r.linkedPrs.length
      ? [
          `  linked PRs: ${r.linkedPrs.map((p) => `#${p.number} ${p.state} by @${p.author} ${pullUrl(repo, p.number)}`).join(', ')}`,
        ]
      : []),
    ...(r.changedSinceReview
      ? ['  note: the issue changed after this review (comments, labels or assignees)']
      : []),
    ...evidenceLines(r.evidence),
    `  explanation (model-generated): ${r.explanation}`,
    ...(r.injectionDetected ? [] : commentBlock(r.suggestedComment, r.evidence)),
    ...flagsLine(r),
    // The explanation above already says what the summary would.
    ...(triage ? ['  triage:', ...triageLines(triage.assessment, false).map((l) => `  ${l}`)] : []),
    '',
  ];
}

export function proposalWaitReason(r: ProposalReview): string {
  return r.thread
    ? `last comment by maintainer @${r.thread.lastCommentBy} on ${r.thread.lastCommentAt.slice(0, 10)}`
    : 'waiting on the author';
}

/** Which item goes in which section, shared by the text and HTML renderings. */
export interface DigestPlan {
  proposals: SpecialistItem<ProposalReview>[];
  /** Proposals where the author has the next step (one line each). */
  waitingProposals: SpecialistItem<ProposalReview>[];
  triageFor: (issue: number) => DigestItem | undefined;
  contextFor: (issue: number) => IssueContext | undefined;
  /** Issues without a proposal review that need a maintainer or were flagged. */
  urgent: DigestItem[];
  rest: DigestItem[];
  subject: string;
}

const flaggedTriage = (a: Assessment) => a.needsMaintainer || a.injectionDetected;

export function planDigest(input: DigestInput): DigestPlan {
  const { repo, items } = input;
  const reviewed = new Set(input.proposals.map((p) => p.issue));
  const byIssue = new Map(items.map((i) => [i.issue, i]));
  const remaining = items.filter((i) => !reviewed.has(i.issue));
  const urgent = remaining.filter((i) => flaggedTriage(i.assessment));
  const rest = remaining.filter((i) => !urgent.includes(i));
  const waitingProposals = input.proposals.filter((p) => proposalWaiting(p.result, input.now));
  const proposals = input.proposals.filter((p) => !waitingProposals.includes(p));
  const oneClick = proposals.filter((p) => {
    const a = input.applyLinks?.get(p.issue);
    return a !== undefined && 'url' in a;
  }).length;
  const attention =
    urgent.length +
    proposals.filter((p) => {
      const t = byIssue.get(p.issue);
      return p.result.injectionDetected || (t !== undefined && flaggedTriage(t.assessment));
    }).length;
  // Proposals waiting on the author need no decision, so they are not counted.
  const issues = proposals.length + remaining.length;
  const day = input.now.toISOString().slice(0, 10);
  const counts = [
    issues ? `${issues} new issue(s)` : null,
    oneClick ? `${oneClick} with one-click` : null,
    attention ? `${attention} need attention` : null,
  ].filter(Boolean);
  return {
    proposals,
    waitingProposals,
    triageFor: (issue) => byIssue.get(issue),
    contextFor: (issue) => input.contexts?.get(issue),
    urgent,
    rest,
    subject: `[custodes] ${repo} triage ${day}: ${counts.join(', ') || 'problems only'}`,
  };
}

/** Plain-text rendering (the e-mail's text part; also what clients without HTML show). */
export function renderDigest(input: DigestInput): Omit<Digest, 'html'> {
  const { repo, errors, now } = input;
  const plan = planDigest(input);
  const { urgent, rest, subject } = plan;
  const section = (title: string, lines: string[]) =>
    lines.length ? [`== ${title} ==`, '', ...lines] : [];
  const text = [
    `New issues in ${repo}${input.since ? ` since ${input.since}` : ''}.`,
    'Read-only: nothing was posted to GitHub. Titles, author text, explanations and comments come',
    'from untrusted issue text and a model; quotes and links were checked against the repository.',
    '',
    ...section('Community proposals: recommended actions', [
      ...plan.proposals.flatMap((p) =>
        proposalItem(
          p,
          plan.triageFor(p.issue),
          repo,
          plan.contextFor(p.issue),
          now,
          input.applyLinks?.get(p.issue),
        ),
      ),
      ...(input.withoutLink
        ? [
            `${input.withoutLink} more proposal(s) without a one-click link (limit reached); apply them by hand.`,
            '',
          ]
        : []),
    ]),
    ...section(
      'Needs attention',
      urgent.flatMap((i) => triageItem(i, repo, plan.contextFor(i.issue), now)),
    ),
    ...section(
      'Other new issues',
      rest.flatMap((i) => triageItem(i, repo, plan.contextFor(i.issue), now)),
    ),
    ...section('Community proposals waiting on the author (nothing to do)', [
      ...plan.waitingProposals.map(
        (p) => `- #${p.issue} ${inert(p.result.title, 100)}: ${proposalWaitReason(p.result)}`,
      ),
      ...(plan.waitingProposals.length ? [''] : []),
    ]),
    ...(input.omittedTaken
      ? [
          `${input.omittedTaken} issue(s) accepted or assigned since triage saw them were left out.`,
          '',
        ]
      : []),
    ...(input.omittedClosed
      ? [
          `${input.omittedClosed} item(s) about issues closed since they were assessed were left out.`,
          '',
        ]
      : []),
    ...(errors.length
      ? ['== Problems during runs ==', ...errors.map((e) => `- ${inert(e, 200)}`), '']
      : []),
    '-- ',
    'Custodes triage agent (read-only), with proposal-review. New issues only: open, unassigned,',
    'ACK_WAITING or no ACK_* label. Halt them with the kill switch: halt:triage, halt:proposal-review.',
  ].join('\n');
  return { subject, text };
}
