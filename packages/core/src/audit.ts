import type { AuditDecision, AuditRecord, BrokerRequest } from '@custodes/schema';
import { canonicalJson, sha256Hex } from './canonical.js';

export interface AuditInput {
  request: BrokerRequest;
  decision: AuditDecision;
  reason?: string;
  githubUrl?: string;
  now?: Date;
  id?: string;
}

/** Builds the audit record for a broker request. Pure apart from time and id generation. */
export async function buildAuditRecord(input: AuditInput): Promise<AuditRecord> {
  const { request } = input;
  const record: AuditRecord = {
    id: input.id ?? crypto.randomUUID(),
    ts: (input.now ?? new Date()).toISOString(),
    agentId: request.agentId,
    agentVersion: request.agentVersion,
    runId: request.runId,
    triggeredBy: request.triggeredBy,
    action: request.action,
    actionHash: await sha256Hex(canonicalJson(request.action)),
    decision: input.decision,
  };
  if (request.onBehalfOf !== undefined) record.onBehalfOf = request.onBehalfOf;
  if (request.approvalId !== undefined) record.approvalId = request.approvalId;
  if (input.reason !== undefined) record.reason = input.reason;
  if (input.githubUrl !== undefined) record.githubUrl = input.githubUrl;
  return record;
}
