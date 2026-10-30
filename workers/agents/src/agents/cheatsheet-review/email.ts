/**
 * E-mails to the operator (ADR 0017): a recommendation to close a low-quality pull request and
 * unassign its author, and a partial review when the multi-model invariant failed and nothing was
 * published. They recommend; they never act. Model and author text is inert (no links, one line,
 * HTML-escaped); the only links are GitHub URLs code builds from numbers. Pure.
 */
import { inertNoLinks } from '../triage/assess.js';
import { esc } from '../triage/digest-html.js';
import type { IssueFacts } from './input.js';
import { modelLine } from './render.js';
import type { RoleOutcome } from './lineup.js';
import type { ReviewDecision } from './types.js';

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

const pullUrl = (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`;
const issueUrl = (repo: string, n: number) => `https://github.com/${repo}/issues/${n}`;

function html(paragraphs: readonly (string | { href: string; label: string })[][]): string {
  const p = paragraphs
    .map(
      (parts) =>
        `<p style="margin:0 0 12px;">${parts
          .map((x) =>
            typeof x === 'string'
              ? esc(x).replace(/\n/g, '<br>')
              : `<a href="${esc(x.href)}" style="color:#0b57d0;">${esc(x.label)}</a>`,
          )
          .join('')}</p>`,
    )
    .join('');
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1f2328;max-width:680px;">${p}</div>`;
}

export function lowQualityMail(input: {
  repo: string;
  pull: number;
  author: string;
  title: string;
  decision: ReviewDecision;
  reviewUrl: string | undefined;
  issues: readonly IssueFacts[];
}): Mail {
  const { repo, pull, decision: d } = input;
  const author = inertNoLinks(input.author, 40);
  const reasons = (d.closeReasons.length ? d.closeReasons : [d.rationale]).map(
    (r) => `- ${inertNoLinks(r, 400)}`,
  );
  const assigned = input.issues.filter((i) => i.authorAssigned);
  const issueLines = input.issues.length
    ? input.issues.map(
        (i) =>
          `- #${i.number}: ${i.authorAssigned ? `${author} is assigned; consider unassigning them` : `${author} is not assigned; nothing to unassign`}`,
      )
    : ['- No linked issue found in the description or timeline.'];
  const reply = d.replyToAuthor ? inertNoLinks(d.replyToAuthor, 1_200) : '';
  const subject = `[custodes] cheatsheet-review: consider closing ${repo}#${pull}`;
  const text = [
    `The multi-model review rated ${repo}#${pull} as low quality (verdict ${d.verdict}).`,
    `Pull request: ${pullUrl(repo, pull)} by ${author}`,
    input.reviewUrl ? `Review: ${input.reviewUrl}` : 'The review was not posted.',
    '',
    'Reasons (model output, treat as untrusted):',
    ...reasons,
    '',
    'Recommendation: close the pull request' +
      (assigned.length ? ' and unassign the author from the issue.' : '.'),
    ...issueLines,
    ...(reply ? ['', 'Suggested comment to paste:', reply] : []),
    '',
    'Custodes did not close anything or change any assignment.',
  ].join('\n');
  return {
    subject,
    text,
    html: html([
      [
        `The multi-model review rated `,
        { href: pullUrl(repo, pull), label: `${repo}#${pull}` },
        ` by ${author} as low quality (verdict ${d.verdict}).`,
      ],
      ...(input.reviewUrl?.startsWith('https://github.com/')
        ? [[{ href: input.reviewUrl, label: 'Open the review' }]]
        : []),
      ['Reasons (model output, treat as untrusted):\n' + reasons.join('\n')],
      [
        'Recommendation: close the pull request' +
          (assigned.length ? ' and unassign the author from the issue.' : '.'),
      ],
      ...input.issues.map((i) => [
        { href: issueUrl(repo, i.number), label: `#${i.number}` },
        i.authorAssigned
          ? `: ${author} is assigned; consider unassigning them`
          : `: ${author} is not assigned`,
      ]),
      ...(reply ? [['Suggested comment to paste:\n' + reply]] : []),
      ['Custodes did not close anything or change any assignment.'],
    ]),
  };
}

export function partialReviewMail(input: {
  repo: string;
  pull: number;
  why: string;
  outcomes: readonly RoleOutcome[];
  decision: ReviewDecision | undefined;
}): Mail {
  const { repo, pull, decision: d } = input;
  const subject = `[custodes] cheatsheet-review: not posted for ${repo}#${pull}`;
  const findings = d
    ? [...d.mustFix, ...d.shouldFix].map(
        (i) =>
          `- [${i.severity}] ${inertNoLinks(i.file, 120)}${i.line ? `:${i.line}` : ''}: ${inertNoLinks(i.text, 300)}`,
      )
    : [];
  const models = input.outcomes.map((o) => `- ${inertNoLinks(modelLine(o), 200)}`);
  const text = [
    `The review of ${repo}#${pull} was not posted: ${input.why}.`,
    `Pull request: ${pullUrl(repo, pull)}`,
    'The trigger label stays on the pull request; remove and add it again to retry.',
    '',
    'Models:',
    ...models,
    ...(d
      ? ['', `Partial verdict: ${d.verdict}`, inertNoLinks(d.rationale, 800), ...findings]
      : []),
  ].join('\n');
  return {
    subject,
    text,
    html: html([
      [
        `The review of `,
        { href: pullUrl(repo, pull), label: `${repo}#${pull}` },
        ` was not posted: ${input.why}.`,
      ],
      ['The trigger label stays on the pull request; remove and add it again to retry.'],
      ['Models:\n' + models.join('\n')],
      ...(d
        ? [
            [
              `Partial verdict: ${d.verdict}\n${inertNoLinks(d.rationale, 800)}\n${findings.join('\n')}`,
            ],
          ]
        : []),
    ]),
  };
}

/**
 * The review is ready and waits for the operator's approval (ADR 0017 amendment). The link opens
 * the full review behind Access and posts it on a click; the e-mail itself carries only facts code
 * computed, so nothing in it is model text. `link` is built by the agent from the configured base
 * and the broker's token; it is the only link besides the pull request.
 */
export function approvalMail(input: {
  repo: string;
  pull: number;
  link: string;
  verdict: ReviewDecision['verdict'];
  event: 'COMMENT' | 'REQUEST_CHANGES';
  suggestions: number;
  expiresAt: string;
}): Mail {
  const { repo, pull } = input;
  const facts = `Verdict ${input.verdict}, posted as ${input.event}, ${input.suggestions} inline suggestion(s).`;
  const subject = `[custodes] cheatsheet-review: approve the review of ${repo}#${pull}`;
  return {
    subject,
    text: [
      `The review of ${repo}#${pull} is ready and is not posted yet.`,
      facts,
      '',
      `Open it, read it, and approve or reject: ${input.link}`,
      `Pull request: ${pullUrl(repo, pull)}`,
      '',
      `The link works once, only for you (Cloudflare Access), until ${input.expiresAt}. Opening it posts nothing; only the Approve button does.`,
    ].join('\n'),
    html: html([
      [
        `The review of `,
        { href: pullUrl(repo, pull), label: `${repo}#${pull}` },
        ` is ready and is not posted yet.`,
      ],
      [facts],
      [{ href: input.link, label: 'Open the review to approve or reject it' }],
      [
        `The link works once, only for you (Cloudflare Access), until ${input.expiresAt}. Opening it posts nothing; only the Approve button does.`,
      ],
    ]),
  };
}
