import { z } from 'zod';
import raw from './agent-keys.json';

/**
 * The agent Workers that call the broker (ADR 0018). Each one binds its own broker entrypoint and
 * signs with a key only it holds; the broker maps the entrypoint to these names in code.
 */
export const CallerName = z.enum([
  'custodes-pr-gate',
  'custodes-cheatsheet-review',
  'custodes-triage',
]);
export type CallerName = z.infer<typeof CallerName>;

/**
 * Which agent ids each agent Worker may act as (ADR 0018). The broker admits only these on the
 * Worker's entrypoint, and /verify refuses an agent signature for any other agent id.
 */
export const CALLER_AGENTS: Readonly<Record<CallerName, readonly string[]>> = {
  'custodes-pr-gate': ['pr-gate'],
  'custodes-cheatsheet-review': ['cheatsheet-review'],
  'custodes-triage': ['triage', 'implementation-check', 'proposal-review'],
};

const P = (1n << 255n) - 19n;
/**
 * The y-coordinates of the eight small-order points of edwards25519: 1 (identity), p-1 (order 2),
 * 0 (order 4) and the two order-8 values. A public key on one of them lets anyone forge signatures
 * that many verifiers accept, so such a key must never be pinned (libsodium blocklist).
 */
const SMALL_ORDER_Y = new Set<bigint>([
  0n,
  1n,
  P - 1n,
  0x05fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826n,
  0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7n,
]);

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * True when the raw Ed25519 public key `x` (base64url, 32 bytes) is unsafe to trust: wrong length,
 * a non-canonical y (y >= p), or one of the small-order points.
 */
export function isWeakEd25519PublicKey(x: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(x);
  } catch {
    return true;
  }
  if (bytes.length !== 32) return true;
  let y = 0n;
  for (let i = 31; i >= 0; i--)
    y = (y << 8n) | BigInt(i === 31 ? (bytes[i] ?? 0) & 0x7f : (bytes[i] ?? 0));
  return y >= P || SMALL_ORDER_Y.has(y);
}

/**
 * One pinned public key: the raw Ed25519 `x` (base64url, 32 bytes) and its id. `kid` as in JWK;
 * the field is not called `keyId` because secret scanners flag `key…: "<value>"` lines.
 */
export const PinnedAgentKey = z.object({
  kid: z.string().regex(/^[a-z0-9][a-z0-9-]{7,79}$/),
  x: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .refine(
      (x) => !isWeakEd25519PublicKey(x),
      'weak Ed25519 public key (small order or non-canonical)',
    ),
  /** When the operator pinned it (from the PR); informational. */
  addedAt: z.iso.date(),
});
export type PinnedAgentKey = z.infer<typeof PinnedAgentKey>;

/**
 * `packages/schema/src/agent-keys.json`. Changed only by a reviewed pull request. At most
 * two keys per caller: the current one and, during a rotation, the next one.
 */
export const AgentKeys = z
  .object({
    version: z.literal(1),
    callers: z.partialRecord(CallerName, z.array(PinnedAgentKey).max(2)),
    /**
     * Keys rotated out: never accepted for new requests, kept so `/verify` can still check the
     * agent signatures in older audit records. A rotated key moves here; a compromised key is
     * deleted instead, or it would keep vouching for forged records.
     */
    retired: z.partialRecord(CallerName, z.array(PinnedAgentKey)).default({}),
  })
  .refine(
    (k) => {
      // Unique across active and retired: a repeated kid would make old records unverifiable.
      const kids = [...Object.values(k.callers), ...Object.values(k.retired)]
        .flat()
        .map((x) => x.kid);
      return new Set(kids).size === kids.length;
    },
    { message: 'duplicate kid', path: ['callers'] },
  )
  .refine(
    (k) => {
      // One public key, one Worker: the same key under two callers lets one sign as the other.
      const xs = [...Object.values(k.callers), ...Object.values(k.retired)].flat().map((x) => x.x);
      return new Set(xs).size === xs.length;
    },
    { message: 'the same public key is pinned twice', path: ['callers'] },
  );
export type AgentKeys = z.infer<typeof AgentKeys>;

/** Active and retired keys of one caller: what an audit record's agent signature is checked against. */
export function verificationKeys(keys: AgentKeys, caller: CallerName): PinnedAgentKey[] {
  return [...(keys.callers[caller] ?? []), ...(keys.retired[caller] ?? [])];
}

/**
 * The committed pinned keys, parsed once. The broker authenticates with them, and the gateway's
 * /verify uses this build-time copy, never keys served by the broker (which R1 does not trust).
 */
export const PINNED_AGENT_KEYS: AgentKeys = AgentKeys.parse(raw);
