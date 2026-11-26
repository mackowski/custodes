import { z } from 'zod';
import { GitHubLogin } from './actions.js';

/**
 * An issue as triage-apply saw it when it asked for an approval (ADR 0019). The broker reads the
 * issue again before running a bundle and refuses it if any field differs.
 */
const issueSnapshotShape = {
  state: z.enum(['open', 'closed']),
  /** Sorted. */
  labels: z.array(z.string().min(1).max(50)).max(100),
  /** Sorted. */
  assignees: z.array(GitHubLogin).max(10),
  comments: z.number().int().min(0).max(100_000),
  /** The issue's `updated_at`: catches title and body edits. */
  updatedAt: z.iso.datetime({ offset: true }),
  /**
   * sha256 of the canonical JSON of every comment's `[id, updated_at]`, in thread order: catches an
   * edited comment, and one deleted while another was added.
   */
  commentsDigest: z.string().regex(/^[0-9a-f]{64}$/),
};
/** Strict, so a pull request snapshot can never be read as an issue snapshot. */
export const IssueSnapshot = z.strictObject(issueSnapshotShape);
export type IssueSnapshot = z.infer<typeof IssueSnapshot>;

/**
 * A pull request as the agent saw it (ADR 0024): the issue fields (GitHub serves a pull request's
 * conversation as an issue) plus the head commit and the reviews. A push or a new review between
 * the proposal and the click turns the approval into a no-op.
 */
export const PullSnapshot = z.strictObject({
  ...issueSnapshotShape,
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** sha256 of the canonical JSON of every review's `[id, state, submitted_at]`, in order. */
  reviewsDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type PullSnapshot = z.infer<typeof PullSnapshot>;
