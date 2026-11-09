import { z } from 'zod';

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

/** One pinned public key: the raw Ed25519 `x` (base64url, 32 bytes) and where it came from. */
export const PinnedAgentKey = z.object({
  keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{7,79}$/),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** When the operator pinned it (from the PR); informational. */
  addedAt: z.iso.date(),
});
export type PinnedAgentKey = z.infer<typeof PinnedAgentKey>;

/**
 * `workers/github-broker/policy/agent-keys.json`. Changed only by a reviewed pull request. At most
 * two keys per caller: the current one and, during a rotation, the next one.
 */
export const AgentKeys = z
  .object({
    version: z.literal(1),
    callers: z.partialRecord(CallerName, z.array(PinnedAgentKey).max(2)),
  })
  .refine(
    (k) =>
      Object.values(k.callers).every(
        (keys) => new Set(keys.map((x) => x.keyId)).size === keys.length,
      ),
    { message: 'duplicate keyId for a caller', path: ['callers'] },
  );
export type AgentKeys = z.infer<typeof AgentKeys>;
