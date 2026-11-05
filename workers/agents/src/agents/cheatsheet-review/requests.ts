/**
 * Earlier maintainer requests on a pull request, and the size of each changed cheat sheet before
 * and after (#91, ADR 0017 amendment). Who counts as a maintainer comes from GitHub's
 * `author_association` (OWNER, MEMBER, COLLABORATOR), the filter of ADR 0013; bots and this
 * agent's own posted reviews are left out. The bodies stay untrusted. Pure.
 */
import { safeLogin } from '../triage/prompt.js';
import type { IssueComment, PullReview } from '../triage/github.js';

/** The marker every review this agent posts starts with (render.ts). */
export const OWN_REVIEW_MARKER = 'Automated LLM review (multi-model)';
/** Requests shown to the judge: the newest ones. */
export const MAX_REQUESTS = 10;

const MAINTAINER = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface MaintainerRequest {
  /** Login in GitHub's charset (safeLogin). */
  by: string;
  at: string;
  kind: 'review' | 'comment';
  body: string;
}

interface Authored {
  user?: { login: string; type?: string | undefined } | null;
  author_association?: string | undefined;
  body?: string | null | undefined;
}

function counts(x: Authored): boolean {
  const login = x.user?.login ?? '';
  return (
    MAINTAINER.has(x.author_association ?? '') &&
    x.user?.type !== 'Bot' &&
    !login.endsWith('[bot]') &&
    (x.body ?? '').trim() !== '' &&
    !(x.body ?? '').includes(OWN_REVIEW_MARKER)
  );
}

/** Maintainers' review summaries and conversation comments, oldest first, the newest MAX kept. */
export function maintainerRequests(
  comments: readonly IssueComment[],
  reviews: readonly PullReview[],
): MaintainerRequest[] {
  const all: MaintainerRequest[] = [
    ...comments.filter(counts).map((c) => ({
      by: safeLogin(c.user?.login),
      at: c.created_at,
      kind: 'comment' as const,
      body: c.body ?? '',
    })),
    ...reviews
      .filter((r) => counts(r) && r.state !== 'PENDING')
      .map((r) => ({
        by: safeLogin(r.user?.login),
        at: r.submitted_at ?? '',
        kind: 'review' as const,
        body: r.body ?? '',
      })),
  ].filter((r) => r.by !== 'unknown');
  return all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_REQUESTS);
}

export interface SheetSize {
  words: number;
  lines: number;
  codeBlocks: number;
}

/** Words, non-empty lines and fenced code blocks of a Markdown file. */
export function sheetSize(markdown: string): SheetSize {
  const fences = (markdown.match(/^\s{0,3}(`{3,}|~{3,})/gm) ?? []).length;
  return {
    words: (markdown.match(/\S+/g) ?? []).length,
    lines: markdown.split('\n').filter((l) => l.trim() !== '').length,
    codeBlocks: Math.floor(fences / 2),
  };
}
