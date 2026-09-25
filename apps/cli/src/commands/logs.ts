import { spawn } from 'node:child_process';
import { Command } from 'commander';

/**
 * Live logs come from Workers Logs via `wrangler tail`, which needs a Cloudflare API token with
 * Workers read scope. This command is a thin wrapper so operators do not need to remember names.
 */
export function logsCommand(): Command {
  return new Command('logs')
    .description('tail Worker logs (wraps `wrangler tail`)')
    .argument('<worker>', 'gateway | agents | broker')
    .action((worker: string) => {
      const dir = {
        gateway: 'workers/gateway',
        agents: 'workers/agents',
        broker: 'workers/github-broker',
      }[worker];
      if (!dir) throw new Error('worker must be gateway, agents or broker');
      const child = spawn(
        'pnpm',
        ['--filter', `./${dir}`, 'exec', 'wrangler', 'tail', '--format', 'pretty'],
        { stdio: 'inherit' },
      );
      child.on('exit', (code) => process.exit(code ?? 0));
    });
}
