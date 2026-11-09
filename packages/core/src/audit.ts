import type {
  AuditDecision,
  AuditRecord,
  BrokerRequest,
  CallerSignature,
  PinnedAgentKey,
} from '@custodes/schema';
import { canonicalJson, sha256Hex } from './canonical.js';
import { verifyRecordedCallerSignature } from './request-signature.js';

export interface AuditInput {
  request: BrokerRequest;
  decision: AuditDecision;
  reason?: string;
  githubUrl?: string;
  now?: Date;
  id?: string;
  /** The agent Worker's signature over `request`, when it came through a per-agent entrypoint. */
  callerSignature?: CallerSignature;
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
  if (input.callerSignature !== undefined) record.callerSignature = input.callerSignature;
  return record;
}

/** The request an agent sent, rebuilt from its audit record: the body it signed was its canonical JSON. */
export function signedRequestOf(record: AuditRecord): BrokerRequest {
  return {
    agentId: record.agentId,
    agentVersion: record.agentVersion,
    runId: record.runId,
    triggeredBy: record.triggeredBy,
    ...(record.onBehalfOf !== undefined ? { onBehalfOf: record.onBehalfOf } : {}),
    ...(record.approvalId !== undefined ? { approvalId: record.approvalId } : {}),
    action: record.action,
  };
}

export type CallerIntent =
  | { status: 'none' }
  | { status: 'valid'; caller: CallerSignature['caller']; kid: string }
  | { status: 'invalid'; reason: 'unknown_key' | 'bad_signature' | 'body_mismatch' };

/**
 * Checks the agent's own signature in an audit record (ADR 0018): that the pinned key of that
 * Worker signed it, and that what it signed is exactly the request the record describes. `none`
 * for records from the shared Worker or from approvals, which carry no agent signature.
 */
export async function verifyCallerIntent(
  record: AuditRecord,
  pinnedFor: (caller: CallerSignature['caller']) => readonly PinnedAgentKey[],
): Promise<CallerIntent> {
  const sig = record.callerSignature;
  if (!sig) return { status: 'none' };
  const pinned = pinnedFor(sig.caller);
  if (!pinned.some((k) => k.kid === sig.kid)) return { status: 'invalid', reason: 'unknown_key' };
  if (!(await verifyRecordedCallerSignature(pinned, sig)))
    return { status: 'invalid', reason: 'bad_signature' };
  if ((await sha256Hex(canonicalJson(signedRequestOf(record)))) !== sig.bodySha256)
    return { status: 'invalid', reason: 'body_mismatch' };
  return { status: 'valid', caller: sig.caller, kid: sig.kid };
}
