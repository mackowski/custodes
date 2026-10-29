/** Findings of one pull request from the cached outputs, and the grader's answer shape. No side effects. */
import { z } from 'zod';
import type { ReviewDecision, ReviewerReport } from '../../src/agents/cheatsheet-review/types.js';
import { dataPath, exists, readJson } from './common.js';
import type { Output } from './run.js';

export interface Finding {
  id: string;
  /** role:model, or judge:model; hidden from the grader. */
  source: string;
  severity: string;
  file: string;
  line?: number;
  text: string;
}

export const Grade = z.object({
  notes: z.array(z.object({ id: z.string(), isProblem: z.boolean() })),
  matches: z.array(z.object({ finding: z.string(), note: z.string().nullable() })),
});
export type Grade = z.infer<typeof Grade>;

export function findingsOf(pull: number): Finding[] {
  const dir = dataPath('outputs', String(pull), 'x');
  const out: Finding[] = [];
  const read = <T>(role: string, model: string) => {
    const f = new URL(`${role}.${model}.json`, dir);
    return exists(f) ? readJson<Output<T>>(f) : null;
  };
  let n = 0;
  const add = (
    source: string,
    severity: string,
    file: string,
    line: number | undefined,
    text: string,
  ) =>
    out.push({
      id: `f${++n}`,
      source,
      severity,
      file,
      ...(line ? { line } : {}),
      text: text.slice(0, 800),
    });
  for (const [role, models] of [
    ['security-reviewer', ['opus']],
    ['security-second-voice', ['deepseekPro', 'deepseekFlash', 'museWonder']],
    ['practicality-reviewer', ['museSpark', 'museWonder', 'sonnet']],
    ['duplication-checker', ['museSpark']],
    ['language-reviewer', ['luna']],
  ] as const)
    for (const m of models) {
      const o = read<ReviewerReport>(role, m);
      for (const f of o?.answer?.findings ?? [])
        add(`${role}:${m}`, f.severity, f.file, f.line, `${f.problem} ${f.fix ?? ''}`);
    }
  for (const m of ['sol', 'astra']) {
    const o = read<ReviewDecision>('judge', m);
    const d = o?.answer;
    for (const i of [...(d?.mustFix ?? []), ...(d?.shouldFix ?? []), ...(d?.nits ?? [])])
      add(`judge:${m}`, i.severity, i.file, i.line, i.text);
  }
  return out;
}
