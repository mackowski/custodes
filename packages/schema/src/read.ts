import { z } from 'zod';
import { AgentId, GitHubRepo } from './agent.js';

/**
 * The only GitHub resources an agent may read through the broker. The broker builds the URL from
 * these fields; callers can never supply a path.
 */
export const ReadResource = z.enum([
  'issues',
  'labels',
  'cheatsheets',
  /** One issue (needs `number`). */
  'issue',
  /** Issue timeline: label events and cross-referenced PRs (needs `number`). */
  'timeline',
  /** Issue comments (needs `number`). */
  'comments',
  /** Files changed by a pull request (needs `number`). */
  'pull_files',
  /** One cheat sheet's content (needs `file`). */
  'cheatsheet',
]);
export type ReadResource = z.infer<typeof ReadResource>;

/** Resources addressed by an issue or PR number. */
export const NUMBERED_RESOURCES: readonly ReadResource[] = [
  'issue',
  'timeline',
  'comments',
  'pull_files',
];

/** A cheat sheet file name, e.g. `Password_Storage_Cheat_Sheet.md`. No path separators. */
export const CheatSheetFile = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}\.md$/);

export const ReadQuery = z
  .object({
    state: z.enum(['open', 'closed', 'all']).optional(),
    sort: z.enum(['created', 'updated', 'comments']).optional(),
    direction: z.enum(['asc', 'desc']).optional(),
    since: z.iso.datetime().optional(),
    per_page: z.number().int().min(1).max(100).optional(),
    page: z.number().int().min(1).max(10).optional(),
    /** One label name; GitHub treats commas as a list, so they are not allowed. */
    labels: z
      .string()
      .regex(/^[A-Za-z0-9 _.:()&+-]{1,50}$/)
      .optional(),
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
    number: z.number().int().positive().max(1_000_000).optional(),
    file: CheatSheetFile.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const numbered = NUMBERED_RESOURCES.includes(r.resource);
    if (numbered !== (r.number !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: `number is required for, and only for, ${NUMBERED_RESOURCES.join(', ')}`,
      });
    if ((r.resource === 'cheatsheet') !== (r.file !== undefined))
      ctx.addIssue({ code: 'custom', message: 'file is required for, and only for, cheatsheet' });
  });
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
