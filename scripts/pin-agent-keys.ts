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
const X = /^[A-Za-z0-9_-]{43}$/;
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

for (const row of rows) {
  if (!CALLER.test(row.caller)) throw new Error('unexpected caller name in the gateway answer');
  if (!row.bound || row.error) continue;
  const active = file.callers[row.caller] ?? [];
  const retired = file.retired[row.caller] ?? [];
  for (const k of row.keys) {
    if (!KID.test(k.kid) || !X.test(k.x)) throw new Error(`malformed key for ${row.caller}`);
    if (k.pin === 'pinned, different key')
      throw new Error(
        `${row.caller}: pinned ${k.kid} differs from the held key; investigate, do not pin`,
      );
    if (k.pin === 'not pinned' && !active.some((p) => p.kid === k.kid)) {
      active.push({ kid: k.kid, x: k.x, addedAt: today });
      changes.push(`pin ${row.caller} ${k.state} ${k.kid}`);
    }
  }
  const held = new Set(row.keys.map((k) => k.kid));
  const activeHeld = row.keys.find((k) => k.state === 'active');
  if (activeHeld && active.some((p) => p.kid === activeHeld.kid)) {
    for (const p of active.filter((q) => !held.has(q.kid))) {
      retired.push(p);
      changes.push(`retire ${row.caller} ${p.kid}`);
    }
  }
  const keep = active.filter((p) => held.has(p.kid));
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
