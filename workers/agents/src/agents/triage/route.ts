import { z } from 'zod';
import type { SpecialistJob } from '../specialists/agent.js';
import { labelAppliedAt } from '../specialists/implementation.js';
import { describeError } from './errors.js';
import type { BrokerGitHubReader, PublicIssue } from './github.js';
import type { AssessedIssue } from './run.js';

/** Maintainers accept an issue by applying this label. */
export const ACK_LABEL = 'ACK_OBTAINED';
/** An accepted issue older than this (since the label was applied) gets an implementation check. */
export const ACK_STALE_MS = 7 * 86_400_000;
/** Timeline reads per poll for issues whose acceptance date is not known yet. */
export const MAX_ACK_LOOKUPS = 40;

export function hasAck(labels: readonly string[]): boolean {
  return labels.includes(ACK_LABEL);
}

/** Community issues not accepted yet go to proposal review; spam does not. */
export function proposalJobs(assessed: AssessedIssue[]): SpecialistJob[] {
  return assessed
    .filter((a) => !hasAck(a.labels) && a.kind !== 'spam')
    .map((a) => ({ issue: a.number, issueUpdatedAt: a.updatedAt }));
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

/** Issues closed since we first saw any pending item open. Fails open: on error nothing is dropped. */
export async function closedSince(
  reader: Pick<BrokerGitHubReader, 'listClosedIssueNumbersSince'>,
  repo: string,
  seenOpenAt: readonly string[],
  errors: string[],
): Promise<Set<number>> {
  const first = earliest(seenOpenAt);
  if (first === null) return new Set();
  // A poll lists issues, then spends minutes on model calls before recording assessed_at; a close
  // in between has an earlier updated_at. Polls run every 4 h, so 6 h of slack covers it.
  const since = new Date(Date.parse(first) - CLOSE_SLACK_MS).toISOString();
  try {
    const { closed, truncated } = await reader.listClosedIssueNumbersSince(repo, since);
    if (truncated)
      errors.push('closed-issue check truncated at 300; some closed issues may still be listed');
    return closed;
  } catch (err) {
    errors.push(`closed-issue check: ${describeError(err)}`);
    return new Set();
  }
}
