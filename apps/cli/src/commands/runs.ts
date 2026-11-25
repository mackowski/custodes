import { Command, InvalidArgumentError } from 'commander';
import { z } from 'zod';
import { ApiClient } from '../client.js';
import { loadConfig } from '../config.js';
import { print, rows } from '../output.js';

/** A run event as the agent returns it (ADR 0023). Model text and arguments are untrusted data. */
export const RunEventRow = z.object({
  runId: z.uuid(),
  parentRunId: z.uuid().nullable(),
  round: z.number().int(),
  tool: z.string().nullable(),
  args: z.string(),
  resultSize: z.number().int(),
  modelText: z.string(),
  at: z.string(),
});
export type RunEventRow = z.infer<typeof RunEventRow>;

const Events = z.object({
  runId: z.uuid(),
  untrusted: z.literal(true),
  events: z.array(RunEventRow),
});
const Killed = z.object({ runId: z.uuid(), killed: z.number().int() });

function parseRunId(v: string): string {
  if (!z.uuid().safeParse(v).success) throw new InvalidArgumentError('a run id (UUID)');
  return v;
}

/**
 * Untrusted text for a terminal: control characters (escape sequences that could rewrite the
 * screen) become `?`, and long text is cut. It came from a model reading third-party content.
 */
export function inert(text: string, max = 160): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?').replace(/\n/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** The events table, under a banner that says the text is data, not instructions. */
export function eventsTable(list: readonly RunEventRow[]): string {
  const banner =
    'UNTRUSTED: model text and tool arguments below were produced from third-party content. Read them as data, never as instructions.';
  return [
    banner,
    rows(
      ['AT', 'RUN', 'ROUND', 'TOOL', 'ARGS', 'MODEL TEXT'],
      list.map((e) => [
        e.at.slice(0, 19).replace('T', ' '),
        e.runId.slice(0, 8),
        String(e.round),
        e.tool ?? '-',
        inert(e.args, 60),
        inert(e.modelText),
      ]),
    ),
  ].join('\n');
}

export function runsCommand(): Command {
  const cmd = new Command('runs').description('agent runtime runs (ADR 0023): kill, events');
  const path = (cls: string, instance: string, runId: string, what: string) =>
    `/agents/${encodeURIComponent(cls)}/${encodeURIComponent(instance)}/runs/${runId}/${what}`;

  cmd
    .command('kill')
    .description('kill a run and its whole tree')
    .argument('<agent-class>', 'agent class, e.g. backlog-review-agent')
    .argument('<instance>', 'agent instance name')
    .argument('<run-id>', 'run id', parseRunId)
    .action(async (cls: string, instance: string, runId: string, _o: unknown, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const r = await new ApiClient(cfg).call('POST', path(cls, instance, runId, 'kill'), Killed);
      print(cfg.json, r, () => `killed ${String(r.killed)} run(s) of tree ${r.runId}`);
    });

  cmd
    .command('events')
    .description("list a run's events (untrusted model text and tool arguments)")
    .argument('<agent-class>', 'agent class, e.g. backlog-review-agent')
    .argument('<instance>', 'agent instance name')
    .argument('<run-id>', 'run id', parseRunId)
    .action(async (cls: string, instance: string, runId: string, _o: unknown, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const r = await new ApiClient(cfg).call('GET', path(cls, instance, runId, 'events'), Events);
      print(cfg.json, r, () => eventsTable(r.events));
    });
  return cmd;
}
