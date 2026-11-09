// Writes the wrangler config for one phase of moving PrGateAgent from custodes-agents to
// custodes-pr-gate (ADR 0018, docs/runbooks/pr-gate-cutover.md). Each phase is derived from the
// committed configs, so there is no second copy to drift:
//
//   target-expecting   workers/pr-gate: PrGateAgent `expecting-transfer` from custodes-agents, no
//                      PrGateAgent binding, no crons, no queue consumer (nothing may touch it yet).
//   source-transferred workers/agents: PrGateAgent `transferred` to custodes-pr-gate, its binding
//                      removed (the class code may stay; index.ts skips pr-gate without it).
//   target-final       workers/pr-gate as committed (binding, crons, queue).
//
// Usage: node --experimental-strip-types scripts/pr-gate-cutover-config.ts <phase>
// Prints the path of the written file. The file sits next to the source config, because wrangler
// resolves `main` relative to the config file. It is git-ignored (.cutover.*.json).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'custodes-agents';
const TARGET = 'custodes-pr-gate';

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

/** wrangler.jsonc without full-line comments or trailing commas (the repo's configs use only those). */
function readJsonc(path: string): WranglerConfig {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => (/^\s*\/\//.test(l) ? '' : l))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(text) as WranglerConfig;
}

function withoutBinding(config: WranglerConfig, className: string): WranglerConfig {
  const bindings = (config.durable_objects?.bindings ?? []).filter(
    (b) => b.class_name !== className,
  );
  return { ...config, durable_objects: { ...config.durable_objects, bindings } };
}

function check(config: WranglerConfig, name: string): void {
  if (config.name !== name) throw new Error(`expected ${name}, found ${config.name ?? '(none)'}`);
  if (config.migrations) throw new Error(`${name} still uses migrations; exports are required`);
  if (!config.exports?.PrGateAgent) throw new Error(`${name} has no exports.PrGateAgent`);
}

const phases: Record<string, () => { dir: string; config: WranglerConfig }> = {
  'target-expecting': () => {
    const dir = join(root, 'workers/pr-gate');
    const config = readJsonc(join(dir, 'wrangler.jsonc'));
    check(config, TARGET);
    const { triggers: _t, queues: _q, ...rest } = withoutBinding(config, 'PrGateAgent');
    return {
      dir,
      config: {
        ...rest,
        exports: {
          ...config.exports,
          PrGateAgent: {
            type: 'durable-object',
            state: 'expecting-transfer',
            storage: 'sqlite',
            transfer_from: SOURCE,
          },
        },
      },
    };
  },
  'source-transferred': () => {
    const dir = join(root, 'workers/agents');
    const config = readJsonc(join(dir, 'wrangler.jsonc'));
    check(config, SOURCE);
    return {
      dir,
      config: {
        ...withoutBinding(config, 'PrGateAgent'),
        exports: {
          ...config.exports,
          PrGateAgent: { type: 'durable-object', state: 'transferred', transferred_to: TARGET },
        },
      },
    };
  },
  'target-final': () => {
    const dir = join(root, 'workers/pr-gate');
    const config = readJsonc(join(dir, 'wrangler.jsonc'));
    check(config, TARGET);
    if (!config.durable_objects?.bindings?.some((b) => b.class_name === 'PrGateAgent'))
      throw new Error('the committed pr-gate config must bind PrGateAgent');
    return { dir, config };
  },
};

const phase = process.argv[2] ?? '';
const build = Object.hasOwn(phases, phase) ? phases[phase] : undefined;
if (!build) {
  console.error(`usage: pr-gate-cutover-config.ts <${Object.keys(phases).join('|')}>`);
  process.exit(2);
}
const { dir, config } = build();
const out = join(dir, `.cutover.${phase}.json`);
writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`);
console.log(out);
