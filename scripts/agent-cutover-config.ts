// The agents' Durable Object classes that moved, with their data, from custodes-agents into their
// own Workers (ADR 0018, docs/runbooks/agent-cutover.md). The moves are done; what is left is what
// the deploy guard reads on every deploy (deploy-workers.yml):
//
//   agent-cutover-config.ts classes
//       Prints every class that has a move, comma-separated.
//   agent-cutover-config.ts moved
//       Prints `<Classes> <dir> <Worker>` for each move already done (none of its classes is live
//       in custodes-agents): the guard checks each target still owns them.
//
// The cutover workflow and the code that wrote its per-phase wrangler configs were removed once
// the last move had finished; they are in the repository history.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLive, type WranglerConfig } from './do-namespace-rules.ts';

interface Move {
  target: string;
  dir: string;
  classes: string[];
  /** Kill-switch ids that must all be halted while the classes move. */
  agentIds: string[];
  /** Worker secrets the target needs; set in the first deploy. */
  secrets: string[];
}

/** A move as the file must hold it; anything else stops the script (fail closed). */
function asMove(name: string, v: unknown): Move {
  const m = v as Partial<Record<keyof Move, unknown>> | null;
  const names = (x: unknown, re: RegExp) =>
    Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === 'string' && re.test(s));
  if (
    m === null ||
    typeof m !== 'object' ||
    typeof m.target !== 'string' ||
    !/^custodes-[a-z-]+$/.test(m.target) ||
    typeof m.dir !== 'string' ||
    !/^workers\/[a-z-]+$/.test(m.dir) ||
    !names(m.classes, /^[A-Z][A-Za-z]+$/) ||
    !names(m.agentIds, /^[a-z][a-z0-9-]{1,30}$/) ||
    !names(m.secrets, /^[A-Z][A-Z0-9_]+$/)
  )
    throw new Error(`scripts/agent-moves.json: malformed move "${name}"`);
  return m as Move;
}

/** Every planned move (scripts/agent-moves.json). A class appears in one move only. */
export const MOVES: Readonly<Record<string, Move>> = Object.fromEntries(
  Object.entries(
    JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent-moves.json'), 'utf8'),
    ) as Record<string, unknown>,
  )
    .filter(([name]) => !name.startsWith('$'))
    .map(([name, v]) => [name, asMove(name, v)]),
);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** wrangler.jsonc without full-line comments or trailing commas (the repo's configs use only those). */
function readJsonc(path: string): WranglerConfig {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text) as WranglerConfig;
}

const [agent = ''] = process.argv.slice(2);
if (agent === 'moved') {
  // Moves none of whose classes custodes-agents still declares live (`isLive`, the deploy guard's
  // own rule in do-namespace-rules.ts, so the two cannot disagree): one line each,
  // `<Class,Class> <dir> <Worker>`, for the deploy guard (the target must still own them).
  // Since the tombstones were dropped, every move counts as done.
  const shared = readJsonc(join(root, 'workers/agents/wrangler.jsonc'));
  for (const m of Object.values(MOVES)) {
    const done = m.classes.every((c) => !isLive(shared, c));
    if (done) console.log(`${m.classes.join(',')} ${m.dir} ${m.target}`);
  }
  process.exit(0);
}
if (agent === 'classes') {
  console.log(
    Object.values(MOVES)
      .flatMap((m) => m.classes)
      .join(','),
  );
  process.exit(0);
}
console.error('usage: agent-cutover-config.ts <classes|moved>');
process.exit(2);
