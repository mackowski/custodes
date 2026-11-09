import { SIGNATURE_WINDOW_MS, verifyRequestSignature } from '@custodes/core';
import { AgentKeys, type CallerName, type Policy } from '@custodes/schema';
import raw from '../policy/agent-keys.json';
import type { BrokerEnv } from './env.js';
import { policy } from './policy.js';
import { NonceStore } from './store.js';

/** Parsed once per isolate; a malformed file fails the Worker fast. */
export const agentKeys: AgentKeys = AgentKeys.parse(raw);

/**
 * Which agent ids each agent Worker may act as (ADR 0018). Fixed in code, next to the entrypoint
 * that only that Worker binds, so neither a request field nor a config value can widen it.
 */
export const CALLER_AGENTS: Readonly<Record<CallerName, readonly string[]>> = {
  'custodes-pr-gate': ['pr-gate'],
  'custodes-cheatsheet-review': ['cheatsheet-review'],
  'custodes-triage': ['triage', 'implementation-check', 'proposal-review'],
};

/** Broker entrypoint class name → the one agent Worker allowed to bind it. */
export const CALLER_ENTRYPOINTS = {
  PrGateBroker: 'custodes-pr-gate',
  CheatsheetReviewBroker: 'custodes-cheatsheet-review',
  TriageBroker: 'custodes-triage',
} as const satisfies Record<string, CallerName>;

/** An agent moved to its own Worker: the default entrypoint must refuse it. */
export function isIsolated(agentId: string, p: Policy = policy): boolean {
  return (
    (Object.hasOwn(p.agents, agentId) && p.agents[agentId]?.isolated === true) ||
    (Object.hasOwn(p.reads, agentId) && p.reads[agentId]?.isolated === true)
  );
}

export type CallerAuth = { ok: true } | { ok: false; reason: string };

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
  if (reason === null) return { ok: true };
  // Ids only. `unknown_key` after a lost or rotated key is what the operator needs to see.
  console.warn(JSON.stringify({ event: 'broker.caller.refused', caller, reason }));
  return { ok: false, reason };
}

/** Kept for twice the window: an older nonce is refused as stale before it is looked up. */
export const NONCE_RETENTION_MS = 2 * SIGNATURE_WINDOW_MS;
