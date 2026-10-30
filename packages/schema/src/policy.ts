import { z } from 'zod';
import { AgentId, AgentMode, GitHubRepo } from './agent.js';
import { BrokerActionType } from './actions.js';
import { ReadResource } from './read.js';

export const AgentPolicy = z
  .object({
    /** Name of the Secrets Store binding that holds this agent's GitHub PAT. */
    tokenBinding: z.string().regex(/^PAT_[A-Z0-9_]+$/),
    mode: AgentMode,
    repos: z.array(GitHubRepo).min(1),
    actions: z.array(BrokerActionType).min(1),
    /** Subset of `actions` that always needs an approval id, even for hotl agents. */
    requiresApproval: z.array(BrokerActionType).default([]),
    /**
     * Per repository: actions that need an approval id there, on top of `requiresApproval`. A repo
     * may be listed before it is in `repos`, so a later widening already comes with its approval
     * (ADR 0017 amendment: cheatsheet-review publishes on OWASP only after the operator's click).
     */
    requiresApprovalOn: z.record(GitHubRepo, z.array(BrokerActionType).min(1)).default({}),
    /**
     * Max side effects per rolling hour **per repository**; the broker denies above this. Each repo
     * in `repos` gets its own budget, so adding a repo widens the agent's total (ADR 0012).
     */
    rateLimitPerHour: z.number().int().positive().default(60),
    /**
     * When set, `issue.label.add` and `issue.label.remove` may only name these labels. Without it,
     * a label grant covers every label in the repository.
     */
    labels: z.array(z.string().min(1).max(50)).min(1).optional(),
  })
  .refine(
    (a) =>
      a.labels !== undefined ||
      !a.actions.some((t) => t === 'issue.label.add' || t === 'issue.label.remove'),
    { message: 'a label action needs a labels allow-list', path: ['labels'] },
  )
  .refine(
    (a) =>
      Object.values(a.requiresApprovalOn).every((list) => list.every((t) => a.actions.includes(t))),
    {
      message: 'requiresApprovalOn may only name actions the agent has',
      path: ['requiresApprovalOn'],
    },
  );
export type AgentPolicy = z.infer<typeof AgentPolicy>;

/** Read access through the broker: GET-only, allow-listed resources, with a read-only token. */
export const ReadPolicy = z.object({
  /** Secrets Store binding holding a PAT limited to public repositories, read-only. */
  tokenBinding: z.string().regex(/^PAT_[A-Z0-9_]+$/),
  repos: z.array(GitHubRepo).min(1),
  /** The only resources this agent may read. Explicit, so a new resource is never granted by default. */
  resources: z.array(ReadResource).min(1),
});
export type ReadPolicy = z.infer<typeof ReadPolicy>;

export const Policy = z.object({
  version: z.literal(1),
  agents: z.record(AgentId, AgentPolicy),
  reads: z.record(AgentId, ReadPolicy).default({}),
});
export type Policy = z.infer<typeof Policy>;
