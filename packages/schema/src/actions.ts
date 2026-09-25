import { z } from 'zod';
import { GitHubRepo } from './agent.js';

const issueRef = { repo: GitHubRepo, issue: z.number().int().positive() };
const pullRef = { repo: GitHubRepo, pull: z.number().int().positive() };
const label = z.string().min(1).max(50);
const body = z.string().min(1).max(60_000);

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
