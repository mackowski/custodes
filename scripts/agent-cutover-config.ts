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

/** Every planned move. A class appears in one move only. */
export const MOVES: Readonly<Record<string, Move>> = {
  'pr-gate': {
    target: 'custodes-pr-gate',
    dir: 'workers/pr-gate',
    classes: ['PrGateAgent'],
    agentIds: ['pr-gate'],
    secrets: ['AI_GATEWAY_TOKEN', 'OPENROUTER_API_KEY'],
  },
  'cheatsheet-review': {
    target: 'custodes-cheatsheet-review',
    dir: 'workers/cheatsheet-review',
    classes: ['CheatsheetReviewAgent'],
    agentIds: ['cheatsheet-review'],
    secrets: ['AI_GATEWAY_TOKEN'],
  },
};

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
