import { z } from 'zod';
import { AgentId, AgentMode, GitHubRepo } from './agent.js';
import { BrokerActionType } from './actions.js';

export const AgentPolicy = z.object({
  /** Name of the Secrets Store binding that holds this agent's GitHub PAT. */
  tokenBinding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  mode: AgentMode,
  repos: z.array(GitHubRepo).min(1),
  actions: z.array(BrokerActionType).min(1),
  /** Subset of `actions` that always needs an approval id, even for hotl agents. */
  requiresApproval: z.array(BrokerActionType).default([]),
  /** Max side effects per rolling hour; the broker denies above this. */
  rateLimitPerHour: z.number().int().positive().default(60),
});
export type AgentPolicy = z.infer<typeof AgentPolicy>;

/** Read access through the broker: GET-only, allow-listed resources, with a read-only token. */
export const ReadPolicy = z.object({
  /** Secrets Store binding holding a PAT limited to public repositories, read-only. */
  tokenBinding: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  repos: z.array(GitHubRepo).min(1),
});
export type ReadPolicy = z.infer<typeof ReadPolicy>;

export const Policy = z.object({
  version: z.literal(1),
  agents: z.record(AgentId, AgentPolicy),
  reads: z.record(AgentId, ReadPolicy).default({}),
});
export type Policy = z.infer<typeof Policy>;
