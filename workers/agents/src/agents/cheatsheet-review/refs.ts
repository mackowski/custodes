/**
 * Issue references in a pull request body for cheat sheet reviews (#79.7). Wider than pr-gate's
 * parser, which stays as it is because pr-gate closes pull requests: besides `#123` and links to
 * this repository's issues, it accepts "issue 123" and "issue #123" (PR #2860 wrote "This PR fixes
 * issue 2815"). A bare number without the word "issue" is never a reference. Code blocks and code
 * spans are ignored. Pure.
 */
import { linkedIssueNumbers } from '../pr-gate/rules.js';

/** References read per pull request. */
export const MAX_REVIEW_REFS = 3;

export function reviewIssueRefs(body: string | null | undefined, repo: string): number[] {
  const out = [...linkedIssueNumbers(body, repo)];
  const text = (body ?? '')
    .slice(0, 20_000)
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  for (const m of text.matchAll(/\bissues?[ \t]+#?(\d{1,7})\b/gi)) {
    const n = Number(m[1]);
    if (n > 0 && !out.includes(n)) out.push(n);
  }
  return out.slice(0, MAX_REVIEW_REFS);
}
