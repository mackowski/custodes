import { spawn } from 'node:child_process';
import { Command } from 'commander';

/** Deployed Worker names, by the short name operators use (each agent is its own Worker, ADR 0018). */
export const WORKERS: Readonly<Record<string, string>> = {
  gateway: 'custodes-gateway',
  broker: 'custodes-github-broker',
  triage: 'custodes-triage',
  'triage-apply': 'custodes-triage-apply',
  'backlog-review': 'custodes-backlog-review',
  'pr-gate': 'custodes-pr-gate',
  'cheatsheet-review': 'custodes-cheatsheet-review',
};

/**
 * Live logs come from Workers Logs via `wrangler tail`, with the wrangler version this repository
 * pins (never one from the PATH or `npx`, which would run outside the lockfile on a machine with
 * a Cloudflare login). Run it from a checkout of the repository.
 */
export function logsCommand(): Command {
  return new Command('logs')
    .description("tail a Worker's logs (wraps `wrangler tail`)")
    .argument('<worker>', Object.keys(WORKERS).join(' | '))
    .action((worker: string) => {
      const name = Object.hasOwn(WORKERS, worker) ? WORKERS[worker] : undefined;
      if (!name) throw new Error(`worker must be one of: ${Object.keys(WORKERS).join(', ')}`);
      const child = spawn(
        'pnpm',
        [
          '--filter',
          './workers/github-broker',
          'exec',
          'wrangler',
          'tail',
          name,
          '--format',
          'pretty',
        ],
        { stdio: 'inherit' },
      );
      child.on('error', () => {
        console.error('could not start pnpm: run this from a checkout of the repository');
        process.exit(1);
      });
      child.on('exit', (code) => process.exit(code ?? 0));
    });
}
