import { z } from 'zod';
import { AgentId, SemVer } from './agent.js';
import { BrokerAction } from './actions.js';

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
  /** GitHub login of the human this action is done for, when there is one. */
  onBehalfOf: z.string().max(39).optional(),
  /** Approval id for actions that policy marks as requiring approval. */
  approvalId: z.uuid().optional(),
  action: BrokerAction,
});
export type BrokerRequest = z.infer<typeof BrokerRequest>;

export const BrokerDenialCode = z.enum([
  'invalid',
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
