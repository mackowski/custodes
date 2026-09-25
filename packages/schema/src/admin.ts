import { z } from 'zod';
import { AgentId, AgentManifest, KillSwitchState } from './agent.js';
import { BrokerAction } from './actions.js';

export const AgentSummary = z.object({
  manifest: AgentManifest,
  killSwitch: KillSwitchState,
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);

export const ApprovalRequest = z.object({
  id: z.uuid(),
  agentId: AgentId,
  runId: z.uuid(),
  action: BrokerAction,
  /** Human-readable rationale produced by the agent. Untrusted: may contain model output. */
  rationale: z.string().max(4000),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  status: ApprovalStatus,
  decidedBy: z.string().optional(),
  decidedAt: z.iso.datetime().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const HaltRequest = z.object({ reason: z.string().min(3).max(500) });

export const AdminActor = z.object({
  /** Email from the Cloudflare Access JWT, or `service:<token-name>` for service tokens. */
  subject: z.string(),
  via: z.enum(['access-user', 'access-service-token']),
});
export type AdminActor = z.infer<typeof AdminActor>;
