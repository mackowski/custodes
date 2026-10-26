// Daily operator e-mail: what pr-gate closed, would have closed, and left for a human. Titles are
// untrusted and made inert; the only links are built by code from validated PR numbers.
import { inertText } from '@custodes/llm';
import { inertNoLinks } from '../triage/assess.js';
import { esc } from '../triage/digest-html.js';
import { pullUrl } from '../triage/digest.js';

export type SummaryOutcome = 'close' | 'would_close' | 'flag' | 'error' | 'minor';

export interface SummaryRow {
  pr: number;
  title: string;
  outcome: SummaryOutcome;
  /** Rule (close, would_close), reason (flag) or error class (error). */
  why: string;
  /** Which rung decided: rule, jev or human. */
  rung: string;
  /** Jev's probability that the diff is a minor fix, when Jev was asked. */
  p?: number;
  decidedAt: string;
  /** Issues behind the decision (the approved issue for author_has_approved_issue). */
  issues?: number[];
  githubUrl?: string;
  attestationId?: string;
}

export interface SummaryInput {
  repo: string;
  rows: SummaryRow[];
  skipped: number;
  enforcing: boolean;
  verifyUrl: string;
  errors: string[];
  now: Date;
  /** Jev vs Clef since the last summary (ADR 0015); absent when Clef was not asked. */
  shadow?: ShadowCounts;
}

export interface ShadowCounts {
  agree: number;
  /** PRs where the two models disagreed (validated numbers, at most 10 listed). */
  disagree: number[];
  clefErrors: number;
}

/** One line, counts and PR numbers only. */
export function shadowLine(s: ShadowCounts): string {
  const prs = s.disagree.filter((n) => Number.isSafeInteger(n) && n > 0);
  const list = prs.length
    ? ` (${prs
        .slice(0, 10)
        .map((n) => `#${n}`)
        .join(', ')})`
    : '';
  return `Jev vs Clef: ${s.agree} agree, ${prs.length} disagree${list}, ${s.clefErrors} Clef error(s).`;
}

const SECTIONS: { outcome: SummaryOutcome; heading: string }[] = [
  { outcome: 'close', heading: 'Closed' },
  { outcome: 'would_close', heading: 'Would close (not enforcing, or daily cap reached)' },
  { outcome: 'flag', heading: 'Needs a maintainer' },
  { outcome: 'error', heading: 'Could not decide (retried next poll)' },
  {
    outcome: 'minor',
    heading: 'Skipped by Jev as minor fixes or agreed by a maintainer (look if the score is low)',
  },
];

/** " #2770, #2771" from validated numbers only. */
function refs(r: SummaryRow): string {
  const ns = (r.issues ?? []).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 5);
  return ns.length ? ` ${ns.map((n) => `#${n}`).join(', ')}` : '';
}

function line(repo: string, r: SummaryRow): string {
  const parts = [
    `#${r.pr} ${inertNoLinks(r.title, 120)}`,
    `${r.why}${refs(r)} (${r.rung}${r.p !== undefined ? `, p=${r.p}` : ''})`,
    pullUrl(repo, r.pr),
  ];
  return `- ${parts.join(' — ')}`;
}

export function renderSummary(input: SummaryInput): {
  subject: string;
  text: string;
  html: string;
} {
  const { repo, rows } = input;
  const count = (o: SummaryOutcome) => rows.filter((r) => r.outcome === o).length;
  const subject = `[custodes] pr-gate ${repo}: ${count('close')} closed, ${count('would_close')} would close, ${count('flag')} for you`;
  const text: string[] = [
    `pr-gate summary for ${repo} (${input.enforcing ? 'enforcing' : 'NOT enforcing: dry run'})`,
    `${input.skipped} pull request(s) followed the guide or were exempt (bots, drafts, maintainers).`,
    '',
  ];
  const html: string[] = [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2328;max-width:720px;">`,
    `<p><b>pr-gate</b> summary for ${esc(repo)} (${input.enforcing ? 'enforcing' : '<b>not enforcing</b>: dry run'}).<br>${input.skipped} pull request(s) followed the guide or were exempt.</p>`,
  ];
  for (const s of SECTIONS) {
    const list = rows.filter((r) => r.outcome === s.outcome);
    if (!list.length) continue;
    text.push(`${s.heading}:`, ...list.map((r) => line(repo, r)), '');
    html.push(`<h3 style="margin:16px 0 6px;font-size:15px;">${esc(s.heading)}</h3><ul>`);
    for (const r of list) {
      const verify =
        r.attestationId && /^[0-9a-f-]{36}$/.test(r.attestationId)
          ? ` · <a href="${esc(`${input.verifyUrl}/${r.attestationId}`)}">verify</a>`
          : '';
      html.push(
        `<li><a href="${esc(pullUrl(repo, r.pr))}">#${r.pr}</a> ${esc(inertNoLinks(r.title, 120))}<br><span style="color:#59636e;">${esc(r.why + refs(r))} (${esc(r.rung)}${r.p !== undefined ? `, p=${r.p}` : ''}) · ${esc(r.decidedAt.slice(0, 16).replace('T', ' '))} UTC${verify}</span></li>`,
      );
    }
    html.push('</ul>');
  }
  if (input.errors.length) {
    text.push('Problems:', ...input.errors.map((e) => `- ${inertText(e, 300)}`), '');
    html.push(
      `<h3 style="margin:16px 0 6px;font-size:15px;">Problems</h3><ul>${input.errors.map((e) => `<li>${esc(inertText(e, 300))}</li>`).join('')}</ul>`,
    );
  }
  if (input.shadow) {
    const l = shadowLine(input.shadow);
    text.push(l, '');
    html.push(`<p style="color:#59636e;">${esc(l)}</p>`);
  }
  text.push('Halt the agent with: custodes agents halt pr-gate --reason "..."');
  html.push(
    `<p style="color:#59636e;">Halt the agent with <code>custodes agents halt pr-gate --reason "..."</code>.</p></div>`,
  );
  return { subject, text: text.join('\n'), html: html.join('\n') };
}
