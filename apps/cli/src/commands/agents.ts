import { Command, InvalidArgumentError } from 'commander';
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

const Report = z.object({ subject: z.string(), text: z.string(), html: z.string() });

const STEPS = ['run', 'digest', 'summary'] as const;
type Step = (typeof STEPS)[number];
export function parseStep(v: string): Step {
  if (!(STEPS as readonly string[]).includes(v))
    throw new InvalidArgumentError(`must be one of ${STEPS.join(', ')}`);
  return v as Step;
}

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
        `/agents/${toKebab(agent)}/${encodeURIComponent(o.instance)}`,
        Status,
      );
      print(cfg.json, s);
    });

  cmd
    .command('run <agent>')
    .description(
      'trigger one run of an agent instance now (sandbox instances only for triage and pr-gate)',
    )
    .option('--instance <name>', 'instance name', 'default')
    .option(
      '--step <step>',
      'run (poll), digest (triage e-mail) or summary (pr-gate e-mail)',
      parseStep,
      'run',
    )
    .action(async (agent: string, o: { instance: string; step: Step }, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      print(
        cfg.json,
        await new ApiClient(cfg).call(
          'POST',
          `/agents/${toKebab(agent)}/${encodeURIComponent(o.instance)}/${o.step}`,
          z.unknown(),
        ),
      );
    });

  cmd
    .command('report <agent>')
    .description('show the e-mail an agent would send now, without sending it (pr-gate)')
    .option('--instance <name>', 'instance name', 'default')
    .action(async (agent: string, o: { instance: string }, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const r = await new ApiClient(cfg).call(
        'GET',
        `/agents/${toKebab(agent)}/${encodeURIComponent(o.instance)}/report`,
        Report,
      );
      print(cfg.json, r, () => `${r.subject}\n\n${r.text}`);
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
