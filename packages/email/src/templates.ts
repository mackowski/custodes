import type { ApprovalRequest } from '@custodes/schema';

export interface RenderedEmail {
  subject: string;
  text: string;
}

function escapeText(s: string): string {
  // Emails are plain text; strip control characters that could confuse mail clients.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

export function digestEmail(agentId: string, lines: string[], since: string): RenderedEmail {
  return {
    subject: `[custodes] ${agentId} digest: ${lines.length} action(s) since ${since}`,
    text: escapeText(lines.length ? lines.map((l) => `- ${l}`).join('\n') : 'No actions.'),
  };
}

export function summariseAction(req: ApprovalRequest): string {
  const a = req.action;
  switch (a.type) {
    case 'issue.comment':
      return `comment on ${a.repo}#${a.issue}`;
    case 'pr.comment':
      return `comment on ${a.repo}#${a.pull}`;
    case 'issue.label.add':
      return `add labels [${a.labels.join(', ')}] to ${a.repo}#${a.issue}`;
    case 'issue.label.remove':
      return `remove labels [${a.labels.join(', ')}] from ${a.repo}#${a.issue}`;
    case 'pr.review':
      return `${a.event} review on ${a.repo}#${a.pull}`;
    case 'pr.review.inline':
      return `${a.event} review with ${a.comments.length} inline comment(s) on ${a.repo}#${a.pull}`;
    case 'pr.close':
      return `comment on and close ${a.repo}#${a.pull}`;
  }
}
