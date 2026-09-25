import { z } from 'zod';
import { AgentId, SemVer } from './agent.js';
import { BrokerAction } from './actions.js';
import { Trigger } from './broker.js';

export const AuditDecision = z.enum(['allowed', 'denied', 'halted']);
export type AuditDecision = z.infer<typeof AuditDecision>;

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
