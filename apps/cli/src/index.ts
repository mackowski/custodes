import { Command } from 'commander';
import { agentsCommand } from './commands/agents.js';
import { approvalsCommand } from './commands/approvals.js';
import { auditCommand } from './commands/audit.js';
import { keysCommand } from './commands/keys.js';
import { logsCommand } from './commands/logs.js';

const program = new Command('custodes')
  .description('Operate the Custodes agent fleet. Authenticates through Cloudflare Access.')
  .version('0.0.0')
  .option('--json', 'machine-readable output')
  .option('--api-url <url>', 'gateway URL (default: $CUSTODES_API_URL)')
  .addCommand(agentsCommand())
  .addCommand(approvalsCommand())
  .addCommand(auditCommand())
  .addCommand(keysCommand())
  .addCommand(logsCommand());

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
