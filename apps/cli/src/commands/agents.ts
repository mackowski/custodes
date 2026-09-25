import { Command } from 'commander';
import { z } from 'zod';
import { AgentManifest, KillSwitchState } from '@custodes/schema';
import { ApiClient } from '../client.js';
import { loadConfig } from '../config.js';
import { print, rows } from '../output.js';

const Registry = z.array(AgentManifest);
const Status = z.object({
  manifest: AgentManifest,
  state: z.unknown(),
  killSwitch: KillSwitchState,
});

export function agentsCommand(): Command {
  const cmd = new Command('agents').description('list, inspect, run, halt and resume agents');

  cmd
    .command('list')
    .description('list deployed agents')
    .action(async (_o, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const list = await new ApiClient(cfg).call('GET', '/admin/agents', Registry);
      print(cfg.json, list, () =>
        rows(
          ['ID', 'VERSION', 'MODE', 'REPOS'],
          list.map((m) => [m.id, m.version, m.mode, m.repos.join(',')]),
        ),
      );
    });

  cmd
    .command('status <agent>')
    .description('show an agent instance (default instance unless --instance)')
    .option('--instance <name>', 'instance name', 'default')
    .action(async (agent: string, o: { instance: string }, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const s = await new ApiClient(cfg).call(
        'GET',
        `/agents/${toKebab(agent)}/${o.instance}`,
        Status,
      );
      print(cfg.json, s);
    });

  cmd
    .command('run <agent>')
    .description('trigger one run of an agent instance now')
    .option('--instance <name>', 'instance name', 'default')
    .action(async (agent: string, o: { instance: string }, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      print(
        cfg.json,
        await new ApiClient(cfg).call(
          'POST',
          `/agents/${toKebab(agent)}/${o.instance}/run`,
          z.unknown(),
        ),
      );
    });

  cmd
    .command('halt <agent>')
    .description(
      'kill switch: stop an agent (or "*" for the whole fleet) before its next side effect',
    )
    .requiredOption('--reason <text>', 'why (recorded in the audit trail)')
    .action(async (agent: string, o: { reason: string }, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      print(
        cfg.json,
        await new ApiClient(cfg).call(
          'POST',
          `/admin/agents/${encodeURIComponent(agent)}/halt`,
          z.unknown(),
          { reason: o.reason },
        ),
      );
    });

  cmd
    .command('resume <agent>')
    .description('clear the kill switch for an agent or "*"')
    .action(async (agent: string, _o, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      print(
        cfg.json,
        await new ApiClient(cfg).call(
          'POST',
          `/admin/agents/${encodeURIComponent(agent)}/resume`,
          z.unknown(),
        ),
      );
    });

  return cmd;
}

/** `hello` → `hello-agent`, matching the Agents SDK kebab-case class routing. */
export function toKebab(agentId: string): string {
  return agentId.endsWith('-agent') ? agentId : `${agentId}-agent`;
}
