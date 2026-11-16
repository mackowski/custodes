// Which third-party packages each deployed Worker actually bundles (#105). Builds every Worker with
// `wrangler deploy --dry-run --metafile` (nothing is uploaded), reads esbuild's inputs and writes
// `docs/security/worker-bundles.json`: per Worker, the packages as name@version, sorted.
//
//   node --experimental-strip-types scripts/bundle-manifest.ts           # rewrite the file
//   node --experimental-strip-types scripts/bundle-manifest.ts --check   # CI: fail if it changed
//
// A new or updated dependency inside a Worker then shows in the pull request's diff, Worker by
// Worker, instead of only in the lockfile: the reviewer sees which Worker (and so which keys and
// grants) it reaches.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs/security/worker-bundles.json');

/** Every deployed Worker: where wrangler runs and which config it reads. */
const WORKERS: readonly { name: string; cwd: string; config: string }[] = [
  { name: 'custodes-github-broker', cwd: 'workers/github-broker', config: 'wrangler.jsonc' },
  { name: 'custodes-gateway', cwd: 'workers/gateway', config: 'wrangler.jsonc' },
  { name: 'custodes-agents', cwd: 'workers/agents', config: 'wrangler.jsonc' },
  { name: 'custodes-triage', cwd: 'workers/agents', config: '../triage/wrangler.jsonc' },
  {
    name: 'custodes-triage-apply',
    cwd: 'workers/agents',
    config: '../triage-apply/wrangler.jsonc',
  },
  { name: 'custodes-pr-gate', cwd: 'workers/agents', config: '../pr-gate/wrangler.jsonc' },
  {
    name: 'custodes-cheatsheet-review',
    cwd: 'workers/agents',
    config: '../cheatsheet-review/wrangler.jsonc',
  },
];

/** `name@version` for a pnpm store path (`.pnpm/@scope+name@1.2.3_peer…/node_modules/…`). */
export function packageOf(input: string): string | null {
  const m = /node_modules\/\.pnpm\/((?:@[^/+]+\+)?[^/@]+)@([^/_(]+)/.exec(input);
  return m ? `${(m[1] ?? '').replace('+', '/')}@${m[2] ?? ''}` : null;
}

/** The sorted third-party packages and workspace packages among esbuild's inputs. */
export function packagesOf(inputs: readonly string[]): {
  thirdParty: string[];
  workspace: string[];
} {
  const third = new Set<string>();
  const workspace = new Set<string>();
  for (const i of inputs) {
    const p = packageOf(i);
    if (p) third.add(p);
    const w = /(?:^|\/)packages\/([a-z-]+)\/src\//.exec(i);
    if (w && !i.includes('node_modules')) workspace.add(`@custodes/${w[1] ?? ''}`);
  }
  return { thirdParty: [...third].sort(), workspace: [...workspace].sort() };
}

function bundle(w: (typeof WORKERS)[number]): { thirdParty: string[]; workspace: string[] } {
  const out = mkdtempSync(join(tmpdir(), 'bundle-'));
  try {
    execFileSync(
      'pnpm',
      ['exec', 'wrangler', 'deploy', '--dry-run', '-c', w.config, '--outdir', out, '--metafile'],
      { cwd: join(root, w.cwd), stdio: ['ignore', 'ignore', 'inherit'] },
    );
    const meta = JSON.parse(readFileSync(join(out, 'bundle-meta.json'), 'utf8')) as {
      inputs: Record<string, unknown>;
    };
    return packagesOf(Object.keys(meta.inputs));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('bundle-manifest.ts')) {
  const manifest: Record<string, { thirdParty: string[]; workspace: string[] }> = {};
  for (const w of WORKERS) manifest[w.name] = bundle(w);
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    const committed = readFileSync(OUT, 'utf8');
    if (committed !== text) {
      const was = JSON.parse(committed) as typeof manifest;
      for (const [name, now] of Object.entries(manifest)) {
        const before = new Set(was[name]?.thirdParty ?? []);
        const after = new Set(now.thirdParty);
        for (const p of after) if (!before.has(p)) console.log(`::error::${name}: + ${p}`);
        for (const p of before) if (!after.has(p)) console.log(`::error::${name}: - ${p}`);
      }
      console.log(
        'Worker bundles changed: run `pnpm bundle:manifest` and commit docs/security/worker-bundles.json.',
      );
      process.exit(1);
    }
    console.log('Worker bundles match docs/security/worker-bundles.json.');
  } else {
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT}`);
  }
}
