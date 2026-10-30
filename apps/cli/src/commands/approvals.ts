import { Command } from 'commander';
import { z } from 'zod';
import { ApprovalRequest } from '@custodes/schema';
import { ApiClient } from '../client.js';
import { loadConfig } from '../config.js';
import { print, rows } from '../output.js';

export function approvalsCommand(): Command {
  const cmd = new Command('approvals').description('human-in-the-loop decisions');

  cmd
    .command('list')
    .description('pending approval requests')
    .action(async (_o, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const list = await new ApiClient(cfg).call(
        'GET',
        '/admin/approvals',
        z.array(ApprovalRequest),
      );
      print(cfg.json, list, () =>
        rows(
          ['ID', 'AGENT', 'ACTION', 'REPO', 'EXPIRES'],
          list.map((a) => [a.id, a.agentId, a.action.type, a.action.repo, a.expiresAt]),
        ),
      );
    });

  // Approving happens on the page behind the e-mailed link, which shows exactly what will be
  // posted (ADR 0017 amendment); by id the CLI can only reject.
  cmd
    .command('reject <id>')
    .description('reject a pending request (approve through the e-mailed link)')
    .action(async (id: string, _o, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      print(
        cfg.json,
        await new ApiClient(cfg).call(
          'POST',
          `/admin/approvals/${encodeURIComponent(id)}/reject`,
          z.unknown(),
        ),
      );
    });
  return cmd;
}
