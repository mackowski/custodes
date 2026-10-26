import { Command, InvalidArgumentError } from 'commander';
import { z } from 'zod';
import { ApiClient } from '../client.js';
import { loadConfig } from '../config.js';
import { print, rows } from '../output.js';

/** One Jev vs Clef row (ADR 0015): ids and numbers only. */
export const ComparisonRow = z.object({
  id: z.number(),
  pr: z.number(),
  head_sha: z.string(),
  state_sha256: z.string(),
  question: z.string(),
  jev_model: z.string().nullable(),
  jev_p: z.number().nullable(),
  jev_choice: z.string().nullable(),
  jev_ms: z.number(),
  jev_tokens: z.number().nullable(),
  jev_error: z.string().nullable(),
  clef_model: z.string().nullable(),
  clef_p: z.number().nullable(),
  clef_choice: z.string().nullable(),
  clef_ms: z.number(),
  clef_tokens: z.number().nullable(),
  clef_error: z.string().nullable(),
  outcome: z.string().nullable(),
  human_verdict: z.string().nullable(),
  decided_at: z.string(),
});
export type ComparisonRow = z.infer<typeof ComparisonRow>;

const COLUMNS = Object.keys(ComparisonRow.shape) as (keyof ComparisonRow)[];

/** RFC 4180 CSV. Every value is an id, a number or a short code, but quote anyway. */
export function toCsv(list: readonly ComparisonRow[]): string {
  const cell = (v: string | number | null) => {
    const raw = v === null ? '' : String(v);
    // A cell a spreadsheet would run as a formula is kept as text.
    const s = /^[=+\-@\t\r]/.test(raw) && typeof v === 'string' ? `'${raw}` : raw;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [COLUMNS.join(','), ...list.map((r) => COLUMNS.map((c) => cell(r[c])).join(','))].join(
    '\n',
  );
}

function parseQuestion(v: string): 'minor' | 'approval' {
  if (v !== 'minor' && v !== 'approval') throw new InvalidArgumentError('minor or approval');
  return v;
}

function parseAnswer(v: string): 'yes' | 'no' {
  if (v !== 'yes' && v !== 'no') throw new InvalidArgumentError('yes or no');
  return v;
}

function parsePr(v: string): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new InvalidArgumentError('a pull request number');
  return n;
}

const p = (v: number | null) => (v === null ? '-' : v.toFixed(2));

export function prGateCommand(): Command {
  const cmd = new Command('pr-gate').description('pr-gate: Jev vs Clef comparison (ADR 0015)');

  cmd
    .command('compare')
    .description('list Jev vs Clef answers, newest first')
    .option('--instance <name>', 'instance name', 'owasp-cheatsheetseries')
    .option('--since <iso>', 'only rows decided at or after this time')
    .option('--csv', 'print CSV for a spreadsheet or sqlite3')
    .action(async (o: { instance: string; since?: string; csv?: boolean }, c: Command) => {
      const cfg = loadConfig(c.optsWithGlobals());
      const q = o.since ? `?since=${encodeURIComponent(o.since)}` : '';
      const list = await new ApiClient(cfg).call(
        'GET',
        `/agents/pr-gate-agent/${encodeURIComponent(o.instance)}/comparisons${q}`,
        z.array(ComparisonRow),
      );
      if (o.csv) {
        process.stdout.write(`${toCsv(list)}\n`);
        return;
      }
      print(cfg.json, list, () =>
        rows(
          ['PR', 'QUESTION', 'JEV P', 'CLEF P', 'JEV', 'CLEF', 'OUTCOME', 'VERDICT', 'AT'],
          list.map((r) => [
            `#${r.pr}`,
            r.question,
            p(r.jev_p),
            p(r.clef_p),
            r.jev_error ?? r.jev_choice ?? '-',
            r.clef_error ?? r.clef_choice ?? '-',
            r.outcome ?? '-',
            r.human_verdict ?? '-',
            r.decided_at.slice(0, 16).replace('T', ' '),
          ]),
        ),
      );
    });

  cmd
    .command('verdict <pr>')
    .description(
      'record the right answer to one question about a PR (people only, not service tokens)',
    )
    .requiredOption('--question <q>', 'minor or approval', parseQuestion)
    .requiredOption('--answer <a>', 'yes or no', parseAnswer)
    .option('--instance <name>', 'instance name', 'owasp-cheatsheetseries')
    .action(
      async (
        pr: string,
        o: { question: 'minor' | 'approval'; answer: 'yes' | 'no'; instance: string },
        c: Command,
      ) => {
        const cfg = loadConfig(c.optsWithGlobals());
        print(
          cfg.json,
          await new ApiClient(cfg).call(
            'POST',
            `/agents/pr-gate-agent/${encodeURIComponent(o.instance)}/verdict`,
            z.unknown(),
            { pr: parsePr(pr), question: o.question, answer: o.answer },
          ),
        );
      },
    );

  return cmd;
}
