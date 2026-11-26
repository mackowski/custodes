import { isNewPublicIssue } from '../triage/route.js';
import type { PublicIssue } from '../triage/github.js';

/** Issues one run reviews at most (threat model backlog-review, D1). */
export const MAX_ISSUES_PER_RUN = 20;
/** A verdict older than this is reviewed again even if the issue did not change (#132). */
export const VERDICT_MAX_AGE_MS = 72 * 3_600_000;

/** The last verdict stored for an issue: the `updated_at` it saw and when it was made. */
export interface LastVerdict {
  issueUpdatedAt: string;
  at: string;
}

/**
 * The issues the next run reviews, chosen by code (no model, #132 v1): open issues outside triage's
 * new-issue stream that changed since their last verdict or whose verdict is at least 72 hours
 * old. Never-reviewed issues first, then the oldest verdict, then the lowest number; at most
 * MAX_ISSUES_PER_RUN, so a burst of changes on many issues cannot take the whole budget in one run.
 */
export function selectIssues(
  open: readonly PublicIssue[],
  last: ReadonlyMap<number, LastVerdict>,
  now: Date,
  max = MAX_ISSUES_PER_RUN,
): number[] {
  const due = open.filter((i) => {
    // GitHub lists pull requests on the issues endpoint; v1 reviews issues only.
    if (i.pull_request !== undefined && i.pull_request !== null) return false;
    if (isNewPublicIssue(i)) return false;
    const v = last.get(i.number);
    if (!v) return true;
    return (
      v.issueUpdatedAt !== i.updated_at || now.getTime() - Date.parse(v.at) >= VERDICT_MAX_AGE_MS
    );
  });
  const age = (n: number) => {
    const v = last.get(n);
    return v ? Date.parse(v.at) : -Infinity;
  };
  return due
    .map((i) => i.number)
    .sort((a, b) => age(a) - age(b) || a - b)
    .slice(0, max);
}
