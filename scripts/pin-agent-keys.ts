// Updates packages/schema/src/agent-keys.json from what the agent Workers' Keyholders hold, as the
// gateway's /admin/agent-keys reports it (ADR 0018). Used by .github/workflows/agent-key-pin.yml; the
// result goes into a branch the operator turns into a pull request and reviews.
//
// Usage: node --experimental-strip-types scripts/pin-agent-keys.ts <agent-keys-response.json>
//
// Rules, per caller reachable from the gateway:
//   - a held key (active or next) that is not pinned is added to `callers` (at most two);
//   - a pinned key the Keyholder no longer holds moves to `retired` once the active key is pinned
//     (it was rotated out; old audit records still verify with it);
//   - a pinned kid whose public key differs from the held one stops everything: that is not a
//     rotation, and nothing is written.
// The gateway's answer is not trusted beyond its shape: ids and keys are checked by pattern here,
// and the schema (weak-key refusal included) runs in CI on the result.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Pinned {
  kid: string;
  x: string;
  addedAt: string;
}
interface KeysFile {
  $comment?: string;
  version: 1;
  callers: Record<string, Pinned[] | undefined>;
  retired: Record<string, Pinned[] | undefined>;
}
interface Row {
  caller: string;
  bound: boolean;
  error?: string;
  keys: { kid: string; x: string; state: string; pin: string }[];
  pinnedNotHeld: string[];
}

const KID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const X = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CALLER = /^custodes-[a-z-]+$/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'packages/schema/src/agent-keys.json');
const input = process.argv[2];
if (!input) {
  console.error('usage: pin-agent-keys.ts <agent-keys-response.json>');
  process.exit(2);
}
const rows = JSON.parse(readFileSync(input, 'utf8')) as Row[];
const file = JSON.parse(readFileSync(path, 'utf8')) as KeysFile;
const today = new Date().toISOString().slice(0, 10);
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
      [...Object.values(file.callers), ...Object.values(file.retired)]
        .flat()
        .some((p) => p?.x === k.x)
    )
      throw new Error(
        `${row.caller}: ${k.kid} has a public key already pinned for another kid; refusing`,
      );
    if (known && retired.some((p) => p.kid === k.kid))
      console.error(`${row.caller}: ${k.kid} is held but retired; the broker refuses it (rotate)`);
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

if (changes.length === 0) {
  console.log('nothing to change');
  process.exit(0);
}
writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
for (const c of changes) console.log(c);
