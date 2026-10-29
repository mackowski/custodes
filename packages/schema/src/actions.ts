import { z } from 'zod';
import { GitHubRepo } from './agent.js';

const issueRef = { repo: GitHubRepo, issue: z.number().int().positive() };
const pullRef = { repo: GitHubRepo, pull: z.number().int().positive() };
// `.` and `..` would be collapsed by URL parsing: `/labels/.` becomes "remove every label".
const label = z
  .string()
  .min(1)
  .max(50)
  .refine((l) => l !== '.' && l !== '..', 'not a label name');
const body = z.string().min(1).max(60_000);
/** A full commit SHA, so a review is pinned to the exact commit the agent read. */
export const CommitSha = z.string().regex(/^[0-9a-f]{40}$/);
/** A repository file path: no leading slash, no `.` or `..` segments. */
const repoPath = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/)
  .refine((p) => !p.split('/').some((seg) => seg === '.' || seg === '..'), 'no dot segments');

/** One inline review comment on the new side of the diff; `startLine` makes it multi-line. */
export const InlineReviewComment = z
  .object({
    path: repoPath,
    line: z.number().int().positive().max(100_000),
    startLine: z.number().int().positive().max(100_000).optional(),
    side: z.literal('RIGHT'),
    body: z.string().min(1).max(4_000),
  })
  .refine((c) => c.startLine === undefined || c.startLine < c.line, {
    message: 'startLine must be before line',
  });
export type InlineReviewComment = z.infer<typeof InlineReviewComment>;

/** Every GitHub side effect an agent may request. Add here first, then to the policy. */
export const BrokerAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('issue.comment'), ...issueRef, body }),
  z.object({
    type: z.literal('issue.label.add'),
    ...issueRef,
    labels: z.array(label).min(1).max(10),
  }),
  z.object({
    type: z.literal('issue.label.remove'),
    ...issueRef,
    labels: z.array(label).min(1).max(10),
  }),
  z.object({ type: z.literal('pr.comment'), ...pullRef, body }),
  z.object({
    type: z.literal('pr.review'),
    ...pullRef,
    event: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
    body,
  }),
  /**
   * A review with inline comments (e.g. `suggestion` blocks), pinned to `commitId`. Never APPROVE:
   * an agent may comment or ask for changes, but approving stays with people.
   */
  z.object({
    type: z.literal('pr.review.inline'),
    ...pullRef,
    commitId: CommitSha,
    event: z.enum(['COMMENT', 'REQUEST_CHANGES']),
    body,
    comments: z.array(InlineReviewComment).max(20),
  }),
  /** Posts the (signed) reason as a comment, then closes the pull request. Never merges. */
  z.object({ type: z.literal('pr.close'), ...pullRef, body }),
]);
export type BrokerAction = z.infer<typeof BrokerAction>;

export const BrokerActionType = z.enum(
  BrokerAction.options.map((o) => o.shape.type.value) as [
    BrokerAction['type'],
    ...BrokerAction['type'][],
  ],
);
export type BrokerActionType = z.infer<typeof BrokerActionType>;

export function actionRepo(action: BrokerAction): string {
  return action.repo;
}
