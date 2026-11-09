import { z } from 'zod';
import { AgentId, SemVer } from './agent.js';
import { BrokerAction } from './actions.js';
import { Trigger } from './broker.js';
import { CallerName } from './callers.js';

export const AuditDecision = z.enum(['allowed', 'denied', 'halted']);
export type AuditDecision = z.infer<typeof AuditDecision>;

/**
 * The agent Worker's own signature over the request it sent (ADR 0018). The body it signed is the
 * canonical JSON of the request fields in the record, so `/verify` can recompute `bodySha256` and
 * the broker cannot attach a real signature to a request the agent did not send.
 */
export const CallerSignature = z.object({
  caller: CallerName,
  kid: z.string().min(1).max(80),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  timestamp: z.string().regex(/^\d{13}$/),
  nonce: z.uuid(),
  method: z.literal('POST'),
  path: z.literal('/v1/act'),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CallerSignature = z.infer<typeof CallerSignature>;

/** The record the broker writes for every requested side effect, allowed or not. */
export const AuditRecord = z.object({
  id: z.uuid(),
  ts: z.iso.datetime(),
  agentId: AgentId,
  agentVersion: SemVer,
  runId: z.uuid(),
  triggeredBy: Trigger,
  onBehalfOf: z.string().optional(),
  approvalId: z.uuid().optional(),
  action: BrokerAction,
  /** sha256 (hex) of the canonical JSON of `action`; lets you verify a comment body later. */
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: AuditDecision,
  reason: z.string().optional(),
  githubUrl: z.url().optional(),
  /** Set when the request came from a per-agent Worker (ADR 0018); absent on the shared Worker. */
  callerSignature: CallerSignature.optional(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

/** An audit record signed with the agent's Ed25519 key held by the broker. */
export const Attestation = z.object({
  record: AuditRecord,
  /** Identifies the signing key, e.g. `triage-2026-09`. */
  keyId: z.string().min(1).max(64),
  /** base64url Ed25519 signature over canonicalJson(record). */
  signature: z.string().min(1),
});
export type Attestation = z.infer<typeof Attestation>;

export const PublicKeyEntry = z.object({
  keyId: z.string(),
  agentId: AgentId,
  /** JWK, OKP/Ed25519, public part only. */
  jwk: z.object({ kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string() }),
  createdAt: z.iso.datetime(),
  /** Set when rotated out. Retired keys stay published so old attestations remain verifiable. */
  retiredAt: z.iso.datetime().optional(),
});
export type PublicKeyEntry = z.infer<typeof PublicKeyEntry>;
