import type { SpecialistJob } from '../specialists/agent.js';
import { labelAppliedAt } from '../specialists/implementation.js';
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

/** The earliest time anything pending was produced; closures before it cannot matter. */
export function earliest(times: readonly string[]): string | null {
  let min: string | null = null;
  for (const t of times) if (!Number.isNaN(Date.parse(t)) && (min === null || t < min)) min = t;
  return min;
}
