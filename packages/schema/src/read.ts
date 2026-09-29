import { z } from 'zod';
import { AgentId, GitHubRepo } from './agent.js';

/**
 * The only GitHub resources an agent may read through the broker. The broker builds the URL from
 * these fields; callers can never supply a path.
 */
export const ReadResource = z.enum(['issues', 'labels', 'cheatsheets']);
export type ReadResource = z.infer<typeof ReadResource>;

export const ReadQuery = z
  .object({
    state: z.enum(['open', 'closed', 'all']).optional(),
    sort: z.enum(['created', 'updated', 'comments']).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    since: z.iso.datetime().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type ReadQuery = z.infer<typeof ReadQuery>;

export const BrokerReadRequest = z
  .object({
    agentId: AgentId,
    runId: z.uuid(),
    repo: GitHubRepo,
    resource: ReadResource,
    query: ReadQuery.default({}),
  })
  .strict();
export type BrokerReadRequest = z.infer<typeof BrokerReadRequest>;

export const BrokerReadResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(['invalid', 'unknown_agent', 'policy_denied', 'halted', 'github_error']),
    reason: z.string(),
    status: z.number().int().optional(),
    rateLimited: z.boolean().optional(),
  }),
]);
export type BrokerReadResponse = z.infer<typeof BrokerReadResponse>;
