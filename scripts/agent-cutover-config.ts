// Moving agents' Durable Object classes, with their data, from custodes-agents into their own
// Workers (ADR 0018, docs/runbooks/agent-cutover.md).
//
//   agent-cutover-config.ts <agent> plan
//       Writes the move's facts to $GITHUB_OUTPUT (or prints them): target Worker, classes,
//       agent ids to be halted, secrets the target needs.
//   agent-cutover-config.ts <agent> <phase>
//       Writes the wrangler config for one phase, derived from the committed configs (no copies):
//         target-expecting   the agent's Worker: its classes `expecting-transfer` from custodes-agents,
//                            no class bindings, no crons, no queue consumer (nothing may touch them);
//         source-transferred custodes-agents: those classes `transferred`, their bindings removed;
//         target-final       the agent's Worker as committed.
//       Prints the path of the written file (next to the source config, git-ignored).
//   agent-cutover-config.ts classes
//       Prints every class that has a move, comma-separated (for the deploy guard).
//   agent-cutover-config.ts moved
//       Prints `<Classes> <dir> <Worker>` for each move already done (its classes `transferred`
//       in custodes-agents): the deploy guard checks each target still owns them.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
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

const SOURCE = 'custodes-agents';

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

function withoutBindings(config: WranglerConfig, classes: string[]): WranglerConfig {
  const bindings = (config.durable_objects?.bindings ?? []).filter(
    (b) => !classes.includes(b.class_name),
  );
  return { ...config, durable_objects: { ...config.durable_objects, bindings } };
}

function check(config: WranglerConfig, name: string, classes: string[]): void {
  if (config.name !== name) throw new Error(`expected ${name}, found ${config.name ?? '(none)'}`);
  if (config.migrations) throw new Error(`${name} still uses migrations; exports are required`);
  for (const c of classes) if (!config.exports?.[c]) throw new Error(`${name} has no exports.${c}`);
}

function phaseConfig(move: Move, phase: string): { dir: string; config: WranglerConfig } {
  const targetDir = join(root, move.dir);
  const sourceDir = join(root, 'workers/agents');
  if (phase === 'target-expecting') {
    const config = readJsonc(join(targetDir, 'wrangler.jsonc'));
    check(config, move.target, move.classes);
    const { triggers: _t, queues: _q, ...rest } = withoutBindings(config, move.classes);
    const exportsOut = { ...config.exports };
    for (const c of move.classes)
      exportsOut[c] = {
        type: 'durable-object',
        state: 'expecting-transfer',
        storage: 'sqlite',
        transfer_from: SOURCE,
      };
    return { dir: targetDir, config: { ...rest, exports: exportsOut } };
  }
  if (phase === 'source-transferred') {
    const config = readJsonc(join(sourceDir, 'wrangler.jsonc'));
    check(config, SOURCE, move.classes);
    const exportsOut = { ...config.exports };
    for (const c of move.classes)
      exportsOut[c] = { type: 'durable-object', state: 'transferred', transferred_to: move.target };
    return {
      dir: sourceDir,
      config: { ...withoutBindings(config, move.classes), exports: exportsOut },
    };
  }
  if (phase === 'target-final') {
    const config = readJsonc(join(targetDir, 'wrangler.jsonc'));
    check(config, move.target, move.classes);
    for (const c of move.classes)
      if (!config.durable_objects?.bindings?.some((b) => b.class_name === c))
        throw new Error(`the committed ${move.target} config must bind ${c}`);
    return { dir: targetDir, config };
  }
  throw new Error(`unknown phase ${phase}`);
}

const [agent = '', what = ''] = process.argv.slice(2);
if (agent === 'moved') {
  // Moves whose classes are all `transferred` in custodes-agents: one line each,
  // `<Class,Class> <dir> <Worker>`, for the deploy guard (the target must still own them).
  const shared = readJsonc(join(root, 'workers/agents/wrangler.jsonc'));
  for (const m of Object.values(MOVES)) {
    const done = m.classes.every((c) => {
      const e = shared.exports?.[c] as { state?: string } | undefined;
      return e?.state === 'transferred';
    });
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
const move = Object.hasOwn(MOVES, agent) ? MOVES[agent] : undefined;
if (!move || !what) {
  console.error(
    `usage: agent-cutover-config.ts <${Object.keys(MOVES).join('|')}> <plan|target-expecting|source-transferred|target-final>`,
  );
  process.exit(2);
}
if (what === 'plan') {
  if (move.classes.length === 0 || move.agentIds.length === 0)
    throw new Error(`the move for ${agent} names no classes or no agent ids`);
  const lines = [
    `target=${move.target}`,
    `dir=${move.dir}`,
    `classes=${move.classes.join(',')}`,
    `agent_ids=${move.agentIds.join(',')}`,
    `secrets=${move.secrets.join(',')}`,
  ];
  const out = process.env['GITHUB_OUTPUT'];
  if (out) appendFileSync(out, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
} else {
  const { dir, config } = phaseConfig(move, what);
  const path = join(dir, `.cutover.${what}.json`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  console.log(path);
}
