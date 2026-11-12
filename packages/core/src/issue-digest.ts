import { canonicalJson, sha256Hex } from './canonical.js';

/**
 * The fingerprint of an issue's comments for a triage-apply snapshot (ADR 0019): sha256 of the
 * canonical JSON of each comment's `[id, updated_at]`, in thread order. An edit, or a comment
 * deleted while another was added, changes it. triage-apply and the broker both use this one
 * function, so their snapshots can never disagree by construction.
 */
export function commentsDigest(comments: readonly unknown[]): Promise<string> {
  return sha256Hex(
    canonicalJson(
      comments.map((c) => {
        const v = (c ?? {}) as { id?: unknown; updated_at?: unknown };
        return [v.id ?? null, v.updated_at ?? null];
      }),
    ),
  );
}
