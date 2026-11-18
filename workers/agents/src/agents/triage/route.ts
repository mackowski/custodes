import { z } from 'zod';
import type { SpecialistJob } from '../specialists/agent.js';
import { describeError } from './errors.js';
import type { ProposalReview } from '../specialists/proposal.js';
import { issueLabels, type BrokerGitHubReader, type PublicIssue } from './github.js';

/** Maintainers accept an issue by applying this label. */
export const ACK_LABEL = 'ACK_OBTAINED';
/** The issue templates apply this label to every new proposal. */
export const ACK_WAITING_LABEL = 'ACK_WAITING';

export function hasAck(labels: readonly string[]): boolean {
  return labels.includes(ACK_LABEL);
}

/**
 * A new issue, the only kind triage works on: nobody is assigned and it waits for a maintainer's
 * decision (ACK_WAITING, or no ACK_* label at all when the template was bypassed). Accepted and
 * assigned issues are the backlog (#132).
 */
export function isNewIssue(labels: readonly string[], assignees: number): boolean {
  if (assignees > 0 || hasAck(labels)) return false;
  return labels.includes(ACK_WAITING_LABEL) || !labels.some((l) => l.startsWith('ACK_'));
}

export function isNewPublicIssue(issue: PublicIssue): boolean {
  return isNewIssue(issueLabels(issue), issue.assignees?.length ?? 0);
}

/**
 * Issues waiting for the next digest that go to proposal review: not spam, at the assessed version,
 * and still new as far as `current` knows (an issue taken since costs no review). An issue missing
 * from `current` has not changed since it was seen, or the read failed: it is sent.
 */
export function pendingProposalJobs(
  pending: { issue: number; issueUpdatedAt: string; kind: string | null }[],
  current: ReadonlyMap<number, CurrentIssue>,
): SpecialistJob[] {
  return pending
    .filter((p) => p.kind !== null && p.kind !== 'spam' && !isTaken(current.get(p.issue)))
    .map((p) => ({ issue: p.issue, issueUpdatedAt: p.issueUpdatedAt }));
}

/** Accepted or assigned according to the issue as it is now; unknown counts as not taken. */
export function isTaken(current: CurrentIssue | undefined): boolean {
  return current !== undefined && !isNewIssue(current.labels, current.assigned);
}

/**
 * Triage items of issues taken since triage saw them leave the digest (counted), unless triage
 * flagged them: a possible injection or a call for a maintainer is never dropped.
 */
export function withoutTaken<
  T extends { issue: number; assessment: { needsMaintainer: boolean; injectionDetected: boolean } },
>(items: T[], current: ReadonlyMap<number, CurrentIssue>): { kept: T[]; taken: number } {
  const kept = items.filter(
    (i) =>
      !isTaken(current.get(i.issue)) ||
      i.assessment.needsMaintainer ||
      i.assessment.injectionDetected,
  );
  return { kept, taken: items.length - kept.length };
}

/**
 * Polls only see open issues, so an issue closed after it was assessed keeps its stored
 * assessment and specialist results. The digest drops everything about issues closed since.
 */
export function withoutClosed<T extends { issue: number }>(
  list: T[],
  closed: ReadonlySet<number>,
): { kept: T[]; dropped: number } {
  const kept = list.filter((x) => !closed.has(x.issue));
  return { kept, dropped: list.length - kept.length };
}

/** The earliest of the given datetimes (only values the broker's `since` accepts). */
export function earliest(times: readonly string[]): string | null {
  let min: string | null = null;
  for (const t of times) {
    // Only values the broker's `since` accepts; anything else would fail the whole check.
    if (!ISO.safeParse(t).success) continue;
    if (min === null || Date.parse(t) < Date.parse(min)) min = t;
  }
  return min;
}

const ISO = z.iso.datetime();

export const CLOSE_SLACK_MS = 6 * 3_600_000;

/** An issue as it is now, for checking stored assessments and reviews against it. */
export interface CurrentIssue {
  state: string;
  labels: string[];
  /** How many people are assigned (any login, so a bot assignee counts too). */
  assigned: number;
  updatedAt: string;
}

/**
 * Issues that changed since we first saw any pending item open (minus slack for a change during a
 * poll), as they are now. Issues not in the map have not changed since. Fails open: on error the
 * map is empty, nothing is dropped or changed, and the error is reported. `status.complete` is false
 * after an error or truncation, so callers can stop trusting stored thread state.
 */
export async function currentSince(
  reader: Pick<BrokerGitHubReader, 'listIssuesUpdatedSince'>,
  repo: string,
  seenOpenAt: readonly string[],
  errors: string[],
  status: { complete: boolean } = { complete: true },
): Promise<Map<number, CurrentIssue>> {
  const first = earliest(seenOpenAt);
  const out = new Map<number, CurrentIssue>();
  if (first === null) return out;
  // A poll lists issues, then spends minutes on model calls before recording assessed_at; a change
  // in between has an earlier updated_at. Polls run every 4 h, so 6 h of slack covers it.
  const since = new Date(Date.parse(first) - CLOSE_SLACK_MS).toISOString();
  try {
    const { issues, truncated } = await reader.listIssuesUpdatedSince(repo, since);
    if (truncated) status.complete = false;
    if (truncated)
      errors.push('issue-state check truncated at 300; some items may not reflect recent changes');
    for (const i of issues)
      out.set(i.number, {
        state: i.state ?? 'open',
        labels: issueLabels(i),
        assigned: (i.assignees ?? []).length,
        updatedAt: i.updated_at,
      });
  } catch (err) {
    status.complete = false;
    errors.push(`issue-state check: ${describeError(err)}`);
  }
  return out;
}

export function closedIn(current: ReadonlyMap<number, CurrentIssue>): Set<number> {
  return new Set([...current].filter(([, c]) => c.state === 'closed').map(([n]) => n));
}

/**
 * Brings a stored proposal review in line with the issue as it is now. Returns 'taken' when the
 * issue is no longer new (a maintainer accepted it or someone was assigned since the review): it
 * leaves the digest. Otherwise drops label changes already carried out and marks the review if
 * the issue changed after it.
 */
export function reconcileProposal(
  review: ProposalReview,
  reviewedVersion: string,
  current: CurrentIssue | undefined,
): ProposalReview | 'taken' {
  if (!current) return review;
  if (isTaken(current)) return 'taken';
  const has = new Set(current.labels.map((l) => l.toLowerCase()));
  return {
    ...review,
    addLabels: review.addLabels.filter((l) => !has.has(l.toLowerCase())),
    removeLabels: review.removeLabels.filter((l) => has.has(l.toLowerCase())),
    changedSinceReview: Date.parse(current.updatedAt) > Date.parse(reviewedVersion),
  };
}

/**
 * Reconciles every pending proposal review. Reviews of issues taken since leave the digest
 * (counted), unless the review saw a possible injection: that signal is never dropped.
 */
export function reconcileProposals(
  pending: { issue: number; result: ProposalReview; issueUpdatedAt: string }[],
  current: ReadonlyMap<number, CurrentIssue>,
): { kept: { issue: number; result: ProposalReview }[]; taken: number } {
  const kept: { issue: number; result: ProposalReview }[] = [];
  let taken = 0;
  for (const p of pending) {
    const r = reconcileProposal(p.result, p.issueUpdatedAt, current.get(p.issue));
    if (r === 'taken' && !p.result.injectionDetected) taken++;
    else kept.push({ issue: p.issue, result: r === 'taken' ? p.result : r });
  }
  return { kept, taken };
}
