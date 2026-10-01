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
