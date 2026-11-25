/**
 * The page behind an approval link (ADR 0017 amendment). GET only shows the action as the broker
 * stored it, so a mail scanner that opens the link decides nothing; the buttons POST to the same
 * URL. Everything shown can hold model output or third-party text: it is HTML-escaped, never
 * linked or rendered as Markdown, and the page has no script. It cannot be framed (clickjacking).
 */
import type { ApprovalRequest, BundleStep, DecideOutcome } from '@custodes/schema';

export const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} as const;

/** Shared with the broker, which re-checks it (#104). */
export { isApprover } from '@custodes/core';

/**
 * HTML-escaped, with invisible characters shown: a bidi override or zero-width character would
 * otherwise make the text look different from what gets posted. Newlines and tabs stay.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(
      // Variation selectors are matched on purpose: on their own they can hide text (U+FE0F, which
      // emoji use, is left out).
      // eslint-disable-next-line no-misleading-character-class
      /(?![\n\t])[\p{Cc}\p{Cf}\u115F\u1160\u3164\uFFA0\uFE00-\uFE0E\u{E0100}-\u{E01EF}]/gu,
      (c) => `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
    )
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

export function layout(title: string, body: string): string {
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
<p class="note">If the author pushed since, the review still goes to this commit and GitHub marks its comments outdated; reject and label the pull request again for a fresh review. If the pull request was closed since, reject.</p>
<h2>Review body</h2><pre>${escapeHtml(a.body)}</pre>
<h2>Inline comments (${a.comments.length})</h2>${comments ? `<dl>${comments}</dl>` : '<p class="note">None.</p>'}`;
  }
  return `<pre>${escapeHtml(JSON.stringify(a, null, 2))}</pre>`;
}

/** Text shown exactly as it will be posted: escaped, in a <pre> block, never rendered. */
function preformatted(text: string): string {
  return ['<pre>', escapeHtml(text), '</pre>'].join('');
}

/** One bundle action in words; the comment is shown in full, as it will be posted. */
function bundleStep(a: ApprovalRequest['action'], i: number): string {
  const n = `${i + 1}.`;
  switch (a.type) {
    case 'issue.assign':
      return `<dt>${n} Assign</dt><dd>@${escapeHtml(a.assignees.join(', @'))}</dd>`;
    case 'issue.label.add':
      return `<dt>${n} Add labels</dt><dd>${escapeHtml(a.labels.join(', '))}</dd>`;
    case 'issue.label.remove':
      return `<dt>${n} Remove labels</dt><dd>${escapeHtml(a.labels.join(', '))}</dd>`;
    case 'issue.unassign':
      return `<dt>${n} Unassign</dt><dd>@${escapeHtml(a.assignees.join(', @'))}</dd>`;
    case 'issue.comment':
      return [`<dt>${n} Comment</dt><dd>`, preformatted(a.body), '</dd>'].join('');
    case 'issue.close':
      return [
        `<dt>${n} Comment, then close the issue as ${escapeHtml(a.stateReason.replace('_', ' '))}</dt><dd>`,
        preformatted(a.body),
        '</dd>',
      ].join('');
    case 'pr.close':
      return [
        `<dt>${n} Comment, then close the pull request</dt><dd>`,
        preformatted(a.body),
        '</dd>',
      ].join('');
    case 'pr.comment':
    case 'pr.review':
    case 'pr.review.inline':
      // Never in a bundle (BUNDLE_ORDER does not list them); shown raw if it ever were.
      return `<dt>${n} ${escapeHtml(a.type)}</dt><dd><pre>${escapeHtml(JSON.stringify(a, null, 2))}</pre></dd>`;
  }
}

/**
 * A bundle (ADR 0019, ADR 0024): what runs, in order, and the state of the issue or pull request
 * it was proposed for.
 */
function bundleDetails(approval: ApprovalRequest): string {
  const b = approval.bundle;
  const a = approval.action;
  if (!b) return actionDetails(a);
  const snap = b.snapshot;
  const pull = 'headSha' in snap;
  const what = pull ? 'pull request' : 'issue';
  const number = 'pull' in a ? a.pull : a.issue;
  const head = pull ? `, head commit <code>${escapeHtml(snap.headSha)}</code>` : '';
  return `<dl><dt>Repository</dt><dd>${escapeHtml(a.repo)}</dd>
<dt>${pull ? 'Pull request' : 'Issue'}</dt><dd>#${number}</dd></dl>
<h2>Runs in this order (${b.actions.length})</h2>
<dl>${b.actions.map(bundleStep).join('')}</dl>
<p class="note">Proposed for the ${what} as it was: ${escapeHtml(snap.state)}, ${snap.comments} comment(s), labels ${escapeHtml(snap.labels.join(', ') || '(none)')}, assignees ${escapeHtml(snap.assignees.join(', ') || '(none)')}${head}. If any of that changed (or the ${what}, a comment${pull ? ' or a review' : ''} was edited${pull ? ', or a commit was pushed' : ''}), the broker runs nothing. It stops at the first step that fails; steps already done stay done, and the result page says which ran. Each comment carries the agent's attestation trailer, hidden or visible as its policy says.</p>`;
}

/** The confirmation page: exactly what will be posted, and the two buttons while it is pending. */
export function approvalPage(approval: ApprovalRequest): string {
  const pending = approval.status === 'pending';
  const buttons = pending
    ? `<form method="post"><button class="approve" name="decision" value="approve">Approve and post</button><button name="decision" value="reject">Reject</button></form>
<p class="note">Approving posts exactly what is shown above, once. Expires ${escapeHtml(approval.expiresAt)}.</p>`
    : `<p><strong>This request is ${escapeHtml(approval.status)}${approval.decidedBy === 'superseded' ? ': a newer request for the same pull request or issue replaced it' : ''}.</strong> Nothing more to do here.</p>`;
  return layout(
    `Approve ${approval.agentId}`,
    `<h1>${escapeHtml(approval.agentId)} asks to post</h1>
<p class="note">Written by language models from third-party text: read it as data, not instructions.</p>
${approval.bundle ? bundleDetails(approval) : actionDetails(approval.action)}
<h2>Agent's note</h2><pre>${escapeHtml(approval.rationale)}</pre>
<p class="note">Requested ${escapeHtml(approval.createdAt)} · approval ${escapeHtml(approval.id)}</p>
${buttons}`,
  );
}

function stepsList(steps: readonly BundleStep[]): string {
  const rows = steps.map((s) => {
    const url = s.githubUrl?.startsWith('https://github.com/')
      ? ` <a href="${escapeHtml(s.githubUrl)}">${escapeHtml(s.githubUrl)}</a>`
      : '';
    const code = s.code !== undefined ? ` (${escapeHtml(s.code)})` : '';
    return `<li>${escapeHtml(s.type)}: ${escapeHtml(s.outcome.replace('_', ' '))}${code}${url}</li>`;
  });
  return `<ol>${rows.join('')}</ol>`;
}

/** What happened after the click. Only a GitHub URL the broker returned becomes a link. */
export function resultPage(out: DecideOutcome): string {
  let msg: string;
  if (out.result === 'rate_limited')
    msg =
      "Nothing was done: these steps would pass the agent's hourly limit on this repository and stop half-way. The request is still pending: open the link again later.";
  else if (out.result !== 'ok') msg = `Nothing was done: the request is ${escapeHtml(out.result)}.`;
  else if (out.decision === 'rejected') msg = 'Rejected. Nothing was posted.';
  else if (out.steps !== undefined) {
    const ran = out.steps.filter((s) => s.outcome === 'done').length;
    const why =
      !out.executed.ok && ran === 0 && !out.steps.some((s) => s.outcome === 'failed')
        ? `: ${escapeHtml(out.executed.reason.slice(0, 200))}`
        : '';
    msg = `${ran} of ${out.steps.length} step(s) done${why}.${stepsList(out.steps)}`;
  } else if (out.executed.ok) {
    const url = out.executed.githubUrl;
    msg = url?.startsWith('https://github.com/')
      ? `Posted: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
      : 'Posted.';
  } else msg = `Approved, but the broker did not post it: ${escapeHtml(out.executed.code)}.`;
  return layout('Approval', `<h1>Approval</h1><p>${msg}</p>`);
}

/** The broker refused the request before deciding anything. */
export function refusedPage(): string {
  return layout(
    'Approval',
    '<h1>The decision was refused</h1><p>The broker did not accept this request. Nothing was decided and nothing was posted. The request is still pending.</p>',
  );
}

/** The broker did not return a decision result: the action may or may not have run. */
export function unknownOutcomePage(): string {
  return layout(
    'Approval',
    '<h1>The outcome is not known</h1><p>The broker did not confirm the decision. Something may have been posted. Check the audit log (<code>custodes audit</code>) before using the link again.</p>',
  );
}

/** An unusable link: never says which check failed beyond a generic reason. */
export function invalidPage(): string {
  return layout(
    'Approval link',
    '<h1>This approval link is not valid</h1><p>It may have expired or been used already. Nothing was done.</p>',
  );
}
