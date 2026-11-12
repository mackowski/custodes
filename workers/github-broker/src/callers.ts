import { SIGNATURE_WINDOW_MS, verifyRequestSignature } from '@custodes/core';
import {
  type AgentKeys,
  CALLER_AGENTS,
  type CallerName,
  PINNED_AGENT_KEYS,
  type Policy,
} from '@custodes/schema';
import type { BrokerEnv } from './env.js';
import { policy } from './policy.js';
import { NonceStore } from './store.js';

/** The committed pinned keys (packages/schema/src/agent-keys.json); a malformed file fails fast. */
export const agentKeys: AgentKeys = PINNED_AGENT_KEYS;
export { CALLER_AGENTS };

/** Broker entrypoint class name → the one agent Worker allowed to bind it. */
export const CALLER_ENTRYPOINTS = {
  PrGateBroker: 'custodes-pr-gate',
  CheatsheetReviewBroker: 'custodes-cheatsheet-review',
  TriageBroker: 'custodes-triage',
  TriageApplyBroker: 'custodes-triage-apply',
} as const satisfies Record<string, CallerName>;

/** An agent moved to its own Worker: the default entrypoint must refuse it. */
export function isIsolated(agentId: string, p: Policy = policy): boolean {
  return (
    (Object.hasOwn(p.agents, agentId) && p.agents[agentId]?.isolated === true) ||
    (Object.hasOwn(p.reads, agentId) && p.reads[agentId]?.isolated === true)
  );
}

/** What a verified request carries forward into the audit record. */
export interface VerifiedCall {
  caller: CallerName;
  kid: string;
  signature: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
  /** When the request was admitted: the audit record's time, so it stays inside the window. */
  admittedAt: number;
}

export type CallerAuth = { ok: true; call: VerifiedCall } | { ok: false; reason: string };

/**
 * Authenticates one request on a caller entrypoint: a valid signature by a key pinned for that
 * caller, a fresh timestamp, and a nonce not seen before. The body must be the exact bytes sent.
 */
export async function authenticateCaller(
  env: BrokerEnv,
  caller: CallerName,
  req: Request,
  body: string,
  keys: AgentKeys = agentKeys,
  now: number = Date.now(),
): Promise<CallerAuth> {
  const check = await verifyRequestSignature(
    keys.callers[caller] ?? [],
    req.headers,
    { method: req.method, path: new URL(req.url).pathname, body },
    now,
  );
  let reason: string | null = check.ok ? null : check.reason;
  if (
    check.ok &&
    !(await new NonceStore(env.AUDIT).claim(check.nonce, caller, now, NONCE_RETENTION_MS))
  )
    reason = 'replayed';
  if (reason === null && check.ok)
    return {
      ok: true,
      call: {
        caller,
        kid: check.keyId,
        signature: check.signature,
        timestamp: check.timestamp,
        nonce: check.nonce,
        bodySha256: check.bodySha256,
        admittedAt: now,
      },
    };
  // Ids only. `unknown_key` after a lost or rotated key is what the operator needs to see.
  const refusedFor = reason ?? 'replayed';
  console.warn(JSON.stringify({ event: 'broker.caller.refused', caller, reason: refusedFor }));
  return { ok: false, reason: refusedFor };
}

/**
 * A request can be replayed for up to twice the window (signed at +window, replayed at -window).
 * Kept one minute longer, so clock skew between broker isolates cannot delete a nonce early.
 */
export const NONCE_RETENTION_MS = 2 * SIGNATURE_WINDOW_MS + 60_000;
