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
import { pinKeys, type KeysFile, type Row } from './pin-agent-keys-rules.ts';

// Runs whenever the file is executed, with no condition: a guard on the script's name would pin
// nothing, without a word, if the file were ever run under another name.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(root, 'packages/schema/src/agent-keys.json');
const input = process.argv[2];
if (!input) {
  console.error('usage: pin-agent-keys.ts <agent-keys-response.json>');
  process.exit(2);
}
const rows = JSON.parse(readFileSync(input, 'utf8')) as Row[];
const file = JSON.parse(readFileSync(path, 'utf8')) as KeysFile;
const changes = pinKeys(file, rows, new Date().toISOString().slice(0, 10));
if (changes.length === 0) {
  console.log('nothing to change');
  process.exit(0);
}
writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
for (const c of changes) console.log(c);
