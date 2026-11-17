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

interface DoBinding {
  name: string;
  class_name: string;
}
interface WranglerConfig {
  name?: string;
  migrations?: unknown;
  exports?: Record<string, unknown>;
  durable_objects?: { bindings?: DoBinding[] };
  triggers?: unknown;
  queues?: unknown;
  [key: string]: unknown;
}

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

/** Whether a config runs the class itself: an `exports` entry without a `state`, or a binding. */
function liveIn(config: WranglerConfig, className: string): boolean {
  const e = config.exports?.[className] as { state?: string } | undefined;
  return (
    (e !== undefined && e.state === undefined) ||
    (config.durable_objects?.bindings ?? []).some((b) => b.class_name === className)
  );
}

const [agent = ''] = process.argv.slice(2);
if (agent === 'moved') {
  // Moves none of whose classes custodes-agents still declares live (an `exports` entry without a
  // `state`, or a binding): one line each, `<Class,Class> <dir> <Worker>`, for the deploy guard
  // (the target must still own them). Since the tombstones were dropped, every move counts as done.
  const shared = readJsonc(join(root, 'workers/agents/wrangler.jsonc'));
  for (const m of Object.values(MOVES)) {
    const done = m.classes.every((c) => !liveIn(shared, c));
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
