// HTML part of the digest e-mail, for Gmail (web and mobile). Every piece of issue or model text is
// HTML-escaped, and the only links are ones code builds from validated numbers and file names.
import type { VerifiedEvidence } from '../specialists/evidence.js';
import type { ImplementationCheck } from '../specialists/implementation.js';
import type { ProposalReview } from '../specialists/proposal.js';
import { inertNoLinks as inert, type Assessment } from './assess.js';
import {
  ACTION,
  INJECTED,
  issueUrl,
  pct,
  planDigest,
  proposalActions,
  pullUrl,
  VERDICT,
  type DigestInput,
  type DigestItem,
  type SpecialistItem,
} from './digest.js';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML element content and attribute values. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Only links to github.com that code built; anything else is rendered as plain text. */
function link(url: string, label: string, style = ''): string {
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.\-/#%]+$/.test(url)) return esc(label);
  return `<a href="${esc(url)}" style="color:#0b57d0;text-decoration:none;${style}">${esc(label)}</a>`;
}

const C = {
  text: '#1f2328',
  muted: '#59636e',
  border: '#d1d9e0',
  card: '#ffffff',
  page: '#f6f8fa',
  quote: '#f6f8fa',
};

type Tone = 'green' | 'red' | 'amber' | 'blue' | 'gray';
const TONES: Record<Tone, [string, string]> = {
  green: ['#dafbe1', '#116329'],
  red: ['#ffebe9', '#a40e26'],
  amber: ['#fff8c5', '#7d4e00'],
  blue: ['#ddf4ff', '#0550ae'],
  gray: ['#eaeef2', '#424a53'],
};

function badge(label: string, tone: Tone): string {
  const [bg, fg] = TONES[tone];
  return `<span style="display:inline-block;margin:0 6px 6px 0;padding:2px 8px;border-radius:12px;background:${bg};color:${fg};font-size:12px;font-weight:600;line-height:18px;">${esc(label)}</span>`;
}

function button(url: string, label: string): string {
  return link(
    url,
    label,
    'display:inline-block;padding:8px 14px;border-radius:6px;background:#1f6feb;color:#ffffff;font-weight:600;font-size:14px;',
  );
}

function label(text: string): string {
  return `<div style="margin:12px 0 4px;color:${C.muted};font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">${esc(text)}</div>`;
}

function para(text: string): string {
  return `<p style="margin:0;color:${C.text};font-size:14px;line-height:21px;">${esc(text)}</p>`;
}

function list(items: string[]): string {
  if (!items.length) return '';
  return `<ul style="margin:0;padding-left:20px;color:${C.text};font-size:14px;line-height:21px;">${items
    .map((i) => `<li style="margin:2px 0;">${i}</li>`)
    .join('')}</ul>`;
}

function evidence(items: VerifiedEvidence[], prs: number[], repo: string): string {
  if (!items.length && !prs.length) return '';
  const rows = [
    ...items.map(
      (e) =>
        `${link(e.url, `${e.file} line ${e.line}`)}<div style="margin:4px 0 8px;padding:6px 10px;border-left:3px solid ${C.border};background:${C.quote};color:${C.text};font-size:13px;line-height:19px;">${esc(e.quote)}</div>`,
    ),
    ...prs.map((n) => `Merged ${link(pullUrl(repo, n), `PR #${n}`)}`),
  ];
  return label('Evidence (checked against the repository)') + list(rows);
}

/** The comment to paste, then the evidence links code appends; white-space keeps its lines. */
function comment(text: string, links: string[]): string {
  const body = [text, ...(links.length ? ['', ...links.map((l) => `- ${l}`)] : [])].join('\n');
  if (!body.trim()) return '';
  return (
    label('Suggested comment (model-generated, review before posting)') +
    `<div style="padding:10px 12px;border:1px dashed ${C.border};border-radius:6px;background:${C.quote};color:${C.text};font-size:14px;line-height:21px;white-space:pre-wrap;word-break:break-word;">${esc(body)}</div>`
  );
}

function flags(r: { injectionDetected: boolean; dropped: string[] }): string {
  return [
    r.injectionDetected
      ? `<div style="margin-top:10px;">${badge('Possible prompt injection', 'red')}</div>`
      : '',
    r.dropped.length
      ? `<div style="margin-top:8px;color:${C.muted};font-size:12px;">Dropped unverifiable claims: ${esc(
          r.dropped.map((d) => inert(d, 80)).join(', '),
        )}</div>`
      : '',
  ].join('');
}

function card(issue: number, title: string, repo: string, inner: string): string {
  return `<div style="margin:0 0 14px;padding:14px 16px;background:${C.card};border:1px solid ${C.border};border-radius:8px;">
<div style="margin:0 0 8px;font-size:16px;line-height:22px;font-weight:600;color:${C.text};">${link(issueUrl(repo, issue), `#${issue}`)} ${esc(inert(title, 160))}</div>
${inner}
<div style="margin-top:14px;">${button(issueUrl(repo, issue), 'Open issue')}</div>
</div>`;
}

function triageDetails(a: Assessment): string {
  const meta = [
    `kind ${a.kind}`,
    `confidence ${pct(a.confidence)}`,
    a.labels.length ? `labels ${a.labels.join(', ')}` : null,
    a.cheatSheet ? `cheat sheet ${a.cheatSheet}` : null,
    a.possibleDuplicates.length
      ? `possible duplicates ${a.possibleDuplicates.map((n) => `#${n}`).join(', ')}`
      : null,
  ].filter(Boolean) as string[];
  return (
    `<div>${[
      a.needsMaintainer ? badge('Needs maintainer', 'red') : '',
      a.injectionDetected ? badge('Possible prompt injection', 'red') : '',
      a.kind === 'spam' ? badge('Likely spam', 'amber') : '',
    ].join('')}</div>` +
    `<div style="color:${C.muted};font-size:13px;line-height:19px;">${esc(meta.join(' · '))}</div>` +
    label('Summary (model-generated)') +
    para(a.summary)
  );
}

const IMPLEMENTED_TONE: Record<ImplementationCheck['implemented'], Tone> = {
  yes: 'green',
  partially: 'amber',
  no: 'gray',
  unclear: 'gray',
};

function implementationCard(it: SpecialistItem<ImplementationCheck>, repo: string): string {
  const r = it.result;
  const links = [...r.evidence.map((e) => e.url), ...r.mergedPrs.map((n) => pullUrl(repo, n))];
  return card(
    it.issue,
    r.title,
    repo,
    `<div>${badge(`Implemented: ${r.implemented}`, IMPLEMENTED_TONE[r.implemented])}${badge(
      `Confidence ${pct(r.confidence)}`,
      'gray',
    )}${r.ackAt ? badge(`Accepted ${r.ackAt.slice(0, 10)}`, 'blue') : ''}</div>` +
      label('Suggested action') +
      para(r.injectionDetected ? INJECTED : ACTION[r.recommendation]) +
      evidence(r.evidence, r.mergedPrs, repo) +
      label('Explanation (model-generated)') +
      para(r.explanation) +
      (r.injectionDetected ? '' : comment(r.suggestedComment, links)) +
      flags(r),
  );
}

const VERDICT_TONE: Record<ProposalReview['verdict'], Tone> = {
  real_gap: 'green',
  partially_covered: 'amber',
  already_covered: 'blue',
  not_applicable: 'gray',
  unclear: 'gray',
};

function proposalCard(
  it: SpecialistItem<ProposalReview>,
  triage: DigestItem | undefined,
  repo: string,
): string {
  const r = it.result;
  const actions = proposalActions(r);
  return card(
    it.issue,
    r.title,
    repo,
    `<div>${badge(VERDICT[r.verdict], VERDICT_TONE[r.verdict])}${badge(
      r.makesSense ? 'Makes sense' : 'Does not make sense',
      r.makesSense ? 'green' : 'red',
    )}${badge(`Confidence ${pct(r.confidence)}`, 'gray')}</div>` +
      label('Recommended') +
      (r.injectionDetected
        ? para(INJECTED)
        : actions.length
          ? list(actions.map(esc))
          : para('No change')) +
      evidence(r.evidence, [], repo) +
      label('Explanation (model-generated)') +
      para(r.explanation) +
      (r.injectionDetected
        ? ''
        : comment(
            r.suggestedComment,
            r.evidence.map((e) => e.url),
          )) +
      flags(r) +
      (triage
        ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid ${C.border};">${label('Triage')}${triageDetails(triage.assessment)}</div>`
        : ''),
  );
}

function triageCard(item: DigestItem, repo: string): string {
  return card(item.issue, item.title, repo, triageDetails(item.assessment));
}

function section(title: string, cards: string[]): string {
  if (!cards.length) return '';
  return `<h2 style="margin:22px 0 10px;font-size:15px;line-height:20px;color:${C.text};">${esc(title)} <span style="color:${C.muted};font-weight:400;">(${cards.length})</span></h2>${cards.join('')}`;
}

function note(text: string): string {
  return `<p style="margin:10px 0;color:${C.muted};font-size:13px;line-height:19px;">${esc(text)}</p>`;
}

export function renderDigestHtml(input: DigestInput): string {
  const { repo } = input;
  const plan = planDigest(input);
  const summary = plan.subject.replace(/^\[custodes\] /, '');
  const body = [
    section(
      'Accepted issues that look implemented',
      plan.close.map((i) => implementationCard(i, repo)),
    ),
    section(
      'Community proposals: recommended actions',
      plan.proposals.map((p) => proposalCard(p, plan.triageFor(p.issue), repo)),
    ),
    section(
      'Accepted issues that may be partly implemented',
      plan.review.map((i) => implementationCard(i, repo)),
    ),
    section(
      'Needs attention',
      plan.urgent.map((i) => triageCard(i, repo)),
    ),
    section(
      'Other updated issues',
      plan.rest.map((i) => triageCard(i, repo)),
    ),
    plan.keep.length
      ? `<h2 style="margin:22px 0 10px;font-size:15px;color:${C.text};">Accepted issues still open work</h2>` +
        list(
          plan.keep.map(
            (i) =>
              `${link(issueUrl(repo, i.issue), `#${i.issue}`)} ${esc(inert(i.result.title, 100))}: not implemented yet (${pct(i.result.confidence)})`,
          ),
        )
      : '',
    input.omittedAck
      ? note(
          `${input.omittedAck} updated issue(s) already accepted (ACK_OBTAINED) were left out; those accepted over a week ago are checked for an existing implementation.`,
        )
      : '',
    input.omittedClosed
      ? note(
          `${input.omittedClosed} item(s) about issues closed since they were assessed were left out.`,
        )
      : '',
    input.errors.length
      ? `<h2 style="margin:22px 0 10px;font-size:15px;color:${C.text};">Problems during runs</h2>` +
        list(input.errors.map((e) => esc(inert(e, 200))))
      : '',
  ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(plan.subject)}</title></head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(summary)}</div>
<div style="max-width:640px;margin:0 auto;padding:16px 12px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.text};">
<div style="color:${C.muted};font-size:12px;">Custodes · ${esc(repo)}</div>
<h1 style="margin:4px 0 6px;font-size:20px;line-height:26px;">Triage ${esc(input.now.toISOString().slice(0, 10))}</h1>
<div style="color:${C.muted};font-size:13px;line-height:19px;">${esc(summary.replace(/^.*?: /, ''))}${input.since ? ` · since ${esc(input.since.slice(0, 16).replace('T', ' '))} UTC` : ''}</div>
<p style="margin:12px 0 0;padding:8px 10px;border-radius:6px;background:${TONES.amber[0]};color:${TONES.amber[1]};font-size:12px;line-height:18px;">Read-only: nothing was posted to GitHub. Titles, explanations and comments come from untrusted issue text and a model; quotes and links were checked against the repository.</p>
${body}
<p style="margin:24px 0 0;color:${C.muted};font-size:12px;line-height:18px;">Custodes triage agent (read-only), with implementation-check and proposal-review. Halt them with the kill switch: halt:triage, halt:implementation-check, halt:proposal-review.</p>
</div></body></html>`;
}
