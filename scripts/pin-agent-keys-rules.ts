// The rules of pin-agent-keys.ts, apart from the script so a test can import them.

interface Pinned {
  kid: string;
  x: string;
  addedAt: string;
}
export interface KeysFile {
  $comment?: string;
  version: 1;
  callers: Record<string, Pinned[] | undefined>;
  retired: Record<string, Pinned[] | undefined>;
}
export interface Row {
  caller: string;
  bound: boolean;
  error?: string;
  keys: { kid: string; x: string; state: string; pin: string }[];
  pinnedNotHeld: string[];
}

const KID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const X = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CALLER = /^custodes-[a-z-]+$/;

/**
 * Applies the rules above to `file` (changed in place) for the gateway's `rows`. Returns one line
 * per change; throws, changing nothing that is written, on anything that is not a plain pin or
 * rotation. Exported for the test: this decides which keys the broker accepts.
 */
export function pinKeys(file: KeysFile, rows: Row[], today: string): string[] {
  const changes: string[] = [];
  const seenCallers = new Set<string>();
  for (const row of rows) {
    if (!CALLER.test(row.caller)) throw new Error('unexpected caller name in the gateway answer');
    // One row per caller: a repeated row would let a second pass treat the first one's pins as
    // "pinned before this run" and retire the old key in the same change.
    if (seenCallers.has(row.caller))
      throw new Error(`${row.caller} appears twice in the gateway answer`);
    seenCallers.add(row.caller);
    if (!row.bound || row.error) continue;
    // As read from the file, before this run: what the repository already vouches for.
    const pinnedBefore = file.callers[row.caller] ?? [];
    const retired = file.retired[row.caller] ?? [];
    const active = [...pinnedBefore];
    for (const k of row.keys) {
      if (!KID.test(k.kid) || !X.test(k.x)) throw new Error(`malformed key for ${row.caller}`);
      if (k.state !== 'active' && k.state !== 'next')
        throw new Error(`unexpected key state for ${row.caller}`);
      // Checked here, not taken from the gateway's own label: a pinned kid with another key is an
      // alarm, never a rotation.
      const known = [...pinnedBefore, ...retired].find((p) => p.kid === k.kid);
      if (known && known.x !== k.x)
        throw new Error(
          `${row.caller}: pinned ${k.kid} differs from the held key; investigate, do not pin`,
        );
      if (
        !known &&
        // Also the keys added earlier in this run: `file.callers` is only updated per caller.
        [...Object.values(file.callers), ...Object.values(file.retired), active]
          .flat()
          .some((p) => p?.x === k.x)
      )
        throw new Error(
          `${row.caller}: ${k.kid} has a public key already pinned for another kid; refusing`,
        );
      if (known && retired.some((p) => p.kid === k.kid))
        console.error(
          `${row.caller}: ${k.kid} is held but retired; the broker refuses it (rotate)`,
        );
      if (!known) {
        active.push({ kid: k.kid, x: k.x, addedAt: today });
        changes.push(`pin ${row.caller} ${k.state} ${k.kid} x=${k.x}`);
      }
    }
    // Retire pinned keys the Keyholder no longer holds, but only once its active key was already
    // pinned before this run: a single answer can never both pin a new key and drop the old one.
    const held = new Set(row.keys.map((k) => k.kid));
    const activeHeld = row.keys.find((k) => k.state === 'active');
    let keep = active;
    if (activeHeld && pinnedBefore.some((p) => p.kid === activeHeld.kid)) {
      const gone = active.filter((q) => !held.has(q.kid));
      for (const p of gone) {
        retired.push(p);
        changes.push(`retire ${row.caller} ${p.kid}`);
      }
      keep = active.filter((q) => held.has(q.kid));
    }
    if (keep.length > 2) throw new Error(`${row.caller}: more than two keys to pin`);
    file.callers[row.caller] = keep;
    if (retired.length) file.retired[row.caller] = retired;
  }
  return changes;
}
