import { z } from 'zod';
import { AgentId, SemVer } from './agent.js';
import { BrokerAction } from './actions.js';
import { IssueSnapshot, PullSnapshot } from './snapshots.js';

export const Trigger = z.object({
  kind: z.enum(['schedule', 'webhook', 'email', 'cli', 'manual']),
  /** Free-form reference: cron name, delivery id, message id, CLI user. */
  ref: z.string().max(200).optional(),
});
export type Trigger = z.infer<typeof Trigger>;

export const BrokerRequest = z.object({
  agentId: AgentId,
  agentVersion: SemVer,
  /** One id per agent run; groups several actions in the audit log. */
  runId: z.uuid(),
  triggeredBy: Trigger,
  /** Approval id for actions that policy marks as requiring approval. */
  approvalId: z.uuid().optional(),
  action: BrokerAction,
  /**
   * The target as the agent read it, for a runtime write (ADR 0023): the broker reads it again and
   * refuses the action if anything changed, closing the gap between the read and the write. Signed
   * with the request and kept in its audit record.
   */
  snapshot: z.union([PullSnapshot, IssueSnapshot]).optional(),
});
export type BrokerRequest = z.infer<typeof BrokerRequest>;

/**
 * Every code the broker answers an action with. `unauthenticated` (signature refused, 401) and
 * `refused` (an entrypoint that serves no agent, 403) come from before any execution: an agent that
 * cannot parse them would have to treat a definite refusal as an unknown outcome.
 */
export const BrokerDenialCode = z.enum([
  'invalid',
  'unauthenticated',
  'refused',
  'unknown_agent',
  'policy_denied',
  'halted',
  'approval_required',
  'approval_invalid',
  'github_error',
]);
export type BrokerDenialCode = z.infer<typeof BrokerDenialCode>;

export const BrokerResponse = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), attestationId: z.uuid(), githubUrl: z.url().optional() }),
  z.object({
    ok: z.literal(false),
    code: BrokerDenialCode,
    reason: z.string(),
    attestationId: z.uuid().optional(),
  }),
]);
export type BrokerResponse = z.infer<typeof BrokerResponse>;
