import { Command, InvalidArgumentError } from 'commander';
import type { RunEvent } from '@custodes/schema';
import { RunEventsResponse, RunKilledResponse } from '@custodes/schema';
import { z } from 'zod';
import { ApiClient } from '../client.js';
import { loadConfig } from '../config.js';
import { print, rows } from '../output.js';

/** A run event as the agent returns it (ADR 0023); the wire format lives in @custodes/schema. */
export type RunEventRow = RunEvent;

function parseRunId(v: string): string {
  if (!z.uuid().safeParse(v).success) throw new InvalidArgumentError('a run id (UUID)');
  // The agent's run route matches lower case only.
  return v.toLowerCase();
}

/**
 * Untrusted text for a terminal: control characters (escape sequences that could rewrite the
 * screen) become `?`, and long text is cut. It came from a model reading third-party content.
 */
export function inert(text: string, max = 160): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '?')
    // Bidi and zero-width controls could reorder or hide text in the table.
    .replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, '?')
    .replace(/\n/g, ' ');
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
        inert(e.at.slice(0, 19).replace('T', ' ')),
        e.runId.slice(0, 8),
        String(e.round),
        inert(e.tool ?? '-'),
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
      const r = await new ApiClient(cfg).call(
        'POST',
        path(cls, instance, runId, 'kill'),
        RunKilledResponse,
      );
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
      const r = await new ApiClient(cfg).call(
        'GET',
        path(cls, instance, runId, 'events'),
        RunEventsResponse,
      );
      print(cfg.json, r, () => eventsTable(r.events));
    });
  return cmd;
}
