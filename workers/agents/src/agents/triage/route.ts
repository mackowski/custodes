import { z } from 'zod';
import type { SpecialistJob } from '../specialists/agent.js';
import { labelAppliedAt } from '../specialists/implementation.js';
import { describeError } from './errors.js';
import type { ProposalReview } from '../specialists/proposal.js';
import { issueLabels, type BrokerGitHubReader, type PublicIssue } from './github.js';

/** Maintainers accept an issue by applying this label. */
export const ACK_LABEL = 'ACK_OBTAINED';
/** An accepted issue older than this (since the label was applied) gets an implementation check. */
export const ACK_STALE_MS = 7 * 86_400_000;
/** Timeline reads per poll for issues whose acceptance date is not known yet. */
export const MAX_ACK_LOOKUPS = 40;

export function hasAck(labels: readonly string[]): boolean {
  return labels.includes(ACK_LABEL);
}

/**
 * Issues waiting for the next digest that go to proposal review: not accepted (ACK_OBTAINED), not
 * spam, at the version triage assessed.
 */
export function pendingProposalJobs(
  pending: { issue: number; issueUpdatedAt: string; kind: string | null }[],
  accepted: ReadonlySet<number>,
): SpecialistJob[] {
  return pending
    .filter((p) => !accepted.has(p.issue) && p.kind !== null && p.kind !== 'spam')
    .map((p) => ({ issue: p.issue, issueUpdatedAt: p.issueUpdatedAt }));
}

export interface AckSweep {
  /** Every open accepted issue and when it was accepted (`created_at` when the timeline is silent). */
  acks: Map<number, string>;
  /** Accepted issues old enough for an implementation check. */
  staleJobs: SpecialistJob[];
  lookups: number;
}

/**
 * Finds accepted issues and their acceptance dates. Dates already known are reused; new ones come
 * from the issue timeline, bounded per poll.
 */
export async function sweepAcks(
  repo: string,
  known: ReadonlyMap<number, string>,
  reader: Pick<BrokerGitHubReader, 'listOpenIssuesWithLabel' | 'listTimeline'>,
  now: Date,
): Promise<AckSweep> {
  const issues: PublicIssue[] = await reader.listOpenIssuesWithLabel(repo, ACK_LABEL);
  const acks = new Map<number, string>();
  const staleJobs: SpecialistJob[] = [];
  let lookups = 0;
  for (const issue of issues) {
    let at = known.get(issue.number);
    if (at === undefined) {
      if (lookups >= MAX_ACK_LOOKUPS) continue; // next poll
      lookups++;
      at =
        labelAppliedAt(await reader.listTimeline(repo, issue.number), ACK_LABEL) ??
        issue.created_at;
    }
    acks.set(issue.number, at);
    if (now.getTime() - Date.parse(at) >= ACK_STALE_MS)
      staleJobs.push({ issue: issue.number, issueUpdatedAt: issue.updated_at });
  }
  return { acks, staleJobs, lookups };
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
  assignees: string[];
  updatedAt: string;
}

/**
 * Issues that changed since we first saw any pending item open (minus slack for a change during a
 * poll), as they are now. Issues not in the map have not changed since. Fails open: on error the
 * map is empty, nothing is dropped or changed, and the error is reported.
 */
export async function currentSince(
  reader: Pick<BrokerGitHubReader, 'listIssuesUpdatedSince'>,
  repo: string,
  seenOpenAt: readonly string[],
  errors: string[],
): Promise<Map<number, CurrentIssue>> {
  const first = earliest(seenOpenAt);
  const out = new Map<number, CurrentIssue>();
  if (first === null) return out;
  // A poll lists issues, then spends minutes on model calls before recording assessed_at; a change
  // in between has an earlier updated_at. Polls run every 4 h, so 6 h of slack covers it.
  const since = new Date(Date.parse(first) - CLOSE_SLACK_MS).toISOString();
  try {
    const { issues, truncated } = await reader.listIssuesUpdatedSince(repo, since);
    if (truncated)
      errors.push('issue-state check truncated at 300; some items may not reflect recent changes');
    for (const i of issues)
      out.set(i.number, {
        state: i.state ?? 'open',
        labels: issueLabels(i),
        assignees: (i.assignees ?? []).map((a) => a.login),
        updatedAt: i.updated_at,
      });
  } catch (err) {
    errors.push(`issue-state check: ${describeError(err)}`);
  }
  return out;
}

export function closedIn(current: ReadonlyMap<number, CurrentIssue>): Set<number> {
  return new Set([...current].filter(([, c]) => c.state === 'closed').map(([n]) => n));
}

/**
 * Brings a stored proposal review in line with the issue as it is now. Returns 'accepted' when a
 * maintainer accepted the issue after the review (it leaves the digest, like other accepted
 * issues). Otherwise drops recommendations that were already carried out (labels added or
 * removed, someone assigned) and marks the review if the issue changed after it.
 */
export function reconcileProposal(
  review: ProposalReview,
  reviewedVersion: string,
  current: CurrentIssue | undefined,
): ProposalReview | 'accepted' {
  if (!current) return review;
  if (hasAck(current.labels)) return 'accepted';
  const has = new Set(current.labels.map((l) => l.toLowerCase()));
  const assigned = current.assignees.length > 0;
  const addLabels = review.addLabels.filter(
    (l) => !has.has(l.toLowerCase()) && !(assigned && l.toLowerCase() === 'help_wanted'),
  );
  return {
    ...review,
    addLabels,
    removeLabels: review.removeLabels.filter((l) => has.has(l.toLowerCase())),
    assignTo: assigned ? null : review.assignTo,
    helpWanted: review.helpWanted && !assigned,
    assignees: assigned ? current.assignees : review.assignees,
    changedSinceReview: Date.parse(current.updatedAt) > Date.parse(reviewedVersion),
  };
}
