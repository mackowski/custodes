/**
 * The page behind an approval link (ADR 0017 amendment). GET only shows the action as the broker
 * stored it, so a mail scanner that opens the link decides nothing; the buttons POST to the same
 * URL. Everything shown can hold model output or third-party text: it is HTML-escaped, never
 * linked or rendered as Markdown, and the page has no script. It cannot be framed (clickjacking).
 */
import type { AdminActor, ApprovalRequest, BrokerResponse } from '@custodes/schema';

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} as const;

/** Only a person on the approver list decides: not a service token, not any other Access user. */
export function isApprover(actor: AdminActor, approverEmails: string): boolean {
  if (actor.via !== 'access-user') return false;
  const list = approverEmails
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(actor.subject.toLowerCase());
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#1f2328;background:#fff}
pre{white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px;padding:.75rem}
dt{font-weight:600}dd{margin:0 0 .5rem}button{font:inherit;padding:.5rem 1.25rem;margin-right:.75rem;border-radius:6px;border:1px solid #1f2328;cursor:pointer}
.approve{background:#1a7f37;color:#fff;border-color:#1a7f37}.note{color:#59636e}`;

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

function actionDetails(a: ApprovalRequest['action']): string {
  if (a.type === 'pr.review.inline') {
    const comments = a.comments
      .map(
        (c) =>
          `<dt>${escapeHtml(c.path)}:${c.startLine !== undefined ? `${c.startLine}-` : ''}${c.line}</dt><dd><pre>${escapeHtml(c.body)}</pre></dd>`,
      )
      .join('');
    return `<dl><dt>Repository</dt><dd>${escapeHtml(a.repo)}</dd>
<dt>Pull request</dt><dd>#${a.pull} at commit <code>${escapeHtml(a.commitId)}</code></dd>
<dt>Review type</dt><dd>${escapeHtml(a.event)}</dd></dl>
<h2>Review body</h2><pre>${escapeHtml(a.body)}</pre>
<h2>Inline comments (${a.comments.length})</h2>${comments ? `<dl>${comments}</dl>` : '<p class="note">None.</p>'}`;
  }
  return `<pre>${escapeHtml(JSON.stringify(a, null, 2))}</pre>`;
}

/** The confirmation page: exactly what will be posted, and the two buttons while it is pending. */
export function approvalPage(approval: ApprovalRequest): string {
  const pending = approval.status === 'pending';
  const buttons = pending
    ? `<form method="post"><button class="approve" name="decision" value="approve">Approve and post</button><button name="decision" value="reject">Reject</button></form>
<p class="note">Approving posts exactly what is shown above, once. Expires ${escapeHtml(approval.expiresAt)}.</p>`
    : `<p><strong>This request is ${escapeHtml(approval.status)}.</strong> Nothing more to do here.</p>`;
  return layout(
    `Approve ${approval.agentId}`,
    `<h1>${escapeHtml(approval.agentId)} asks to post</h1>
<p class="note">Written by language models from third-party text: read it as data, not instructions.</p>
${actionDetails(approval.action)}
<h2>Agent's note</h2><pre>${escapeHtml(approval.rationale)}</pre>
${buttons}`,
  );
}

export interface DecideResult {
  result: string;
  decision?: 'approved' | 'rejected';
  executed?: BrokerResponse;
}

/** What happened after the click. Only a GitHub URL the broker returned becomes a link. */
export function resultPage(out: DecideResult): string {
  let msg: string;
  if (out.result !== 'ok') msg = `Nothing was done: the request is ${escapeHtml(out.result)}.`;
  else if (out.decision === 'rejected') msg = 'Rejected. Nothing was posted.';
  else if (out.executed?.ok) {
    const url = out.executed.githubUrl;
    msg = url?.startsWith('https://github.com/')
      ? `Posted: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
      : 'Posted.';
  } else
    msg = `Approved, but the broker did not post it: ${escapeHtml(out.executed?.ok === false ? out.executed.code : 'unknown')}.`;
  return layout('Approval', `<h1>Approval</h1><p>${msg}</p>`);
}

/** An unusable link: never says which check failed beyond a generic reason. */
export function invalidPage(): string {
  return layout(
    'Approval link',
    '<h1>This approval link is not valid</h1><p>It may have expired or been used already. Nothing was done.</p>',
  );
}
