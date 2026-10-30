/**
 * Step 2: run the baseline lineup and the candidates on every frozen snapshot (grill-plan).
 *
 * Inputs and prompts are the agent's own (`reviewerMessage`, `reviewerPrompt`, `judgeMessage`,
 * `JUDGE_PROMPT`, `parseStructured`). Roles run only where the agent would run them
 * (`classify` + `REVIEWERS_FOR`; ambiguous counts as content). The link auditor is left out: the
 * pages have changed since. Both judges get the same baseline reports. Every answer is cached in
 * `.bench/cheatsheet-review/outputs/`, so a run can stop (budget, error) and resume.
 */
import process from 'node:process';
import { parseStructured } from '@custodes/llm';
import { judgeMessage, reviewerMessage } from '../../src/agents/cheatsheet-review/input.js';
import { JUDGE_PROMPT, reviewerPrompt } from '../../src/agents/cheatsheet-review/prompts.js';
import {
  classify,
  REVIEWERS_FOR,
  type ReviewerRole,
} from '../../src/agents/cheatsheet-review/scope.js';
import { ReviewDecision, ReviewerReport } from '../../src/agents/cheatsheet-review/types.js';
import {
  BudgetExceeded,
  limiter,
  call,
  clients,
  dataPath,
  exists,
  readJson,
  spent,
  writeJson,
  type ModelName,
} from './common.js';
import type { FrozenPull, Stratum } from './select.js';
import { snapshotOf } from './snapshot.js';

type PromptRole = Exclude<ReviewerRole, 'link-auditor'>;

/** Who plays which role: baseline first (ADR 0017 lineup), then candidates. */
const CAST: Record<
  PromptRole,
  { baseline: ModelName; candidates: ModelName[]; prompt: PromptRole }[]
> = {
  'security-reviewer': [{ baseline: 'opus', candidates: [], prompt: 'security-reviewer' }],
  'security-second-voice': [
    // Second voice: V4 Pro (baseline) vs V4.1 Flash; third voice candidate: Muse Wonder.
    {
      baseline: 'deepseekPro',
      candidates: ['deepseekFlash', 'museWonder'],
      prompt: 'security-second-voice',
    },
  ],
  'practicality-reviewer': [
    {
      baseline: 'museSpark',
      candidates: ['museWonder', 'sonnet'],
      prompt: 'practicality-reviewer',
    },
  ],
  'duplication-checker': [{ baseline: 'museSpark', candidates: [], prompt: 'duplication-checker' }],
  'language-reviewer': [{ baseline: 'luna', candidates: [], prompt: 'language-reviewer' }],
};
const JUDGES: ModelName[] = ['sol', 'astra'];
/** BENCH_SKIP=deepseekPro,deepseekFlash leaves models out of this pass (they get their own). */
const SKIP = new Set((process.env['BENCH_SKIP'] ?? '').split(',').filter(Boolean));
/** Pull requests reviewed at once; model calls stay capped by `limit`. */
const PARALLEL_PRS = 3;

export interface Output<T> {
  pull: number;
  role: string;
  model: ModelName;
  ok: boolean;
  answer?: T;
  error?: string;
  usd: number;
}

const c = clients();
const limit = limiter(6);

async function ask<T>(
  pull: number,
  role: string,
  model: ModelName,
  schema: Parameters<typeof parseStructured>[0],
  system: string,
  user: string,
  max_tokens: number,
): Promise<Output<T>> {
  const file = dataPath('outputs', String(pull), `${role}.${model}.json`);
  if (exists(file)) return readJson<Output<T>>(file);
  const tag = `${role}:${model}:${pull}`;
  let out: Output<T>;
  try {
    const first = await limit(() => call(c, model, { system, user, max_tokens }, tag));
    let usd = first.usd;
    let answer: T;
    try {
      answer = parseStructured(schema, first.result.text) as T;
    } catch {
      // One repair, as the agent does.
      const again = await limit(() =>
        call(
          c,
          model,
          {
            system,
            user: `${user}\n\nYour previous answer could not be parsed as the JSON object described above. Answer again with that JSON object only, nothing else.`,
            max_tokens,
          },
          tag,
        ),
      );
      usd += again.usd;
      answer = parseStructured(schema, again.result.text) as T;
    }
    out = { pull, role, model, ok: true, answer, usd };
  } catch (err) {
    if (err instanceof BudgetExceeded) throw err;
    // Not cached: the next run tries again.
    return {
      pull,
      role,
      model,
      ok: false,
      error: err instanceof Error ? err.name : 'error',
      usd: 0,
    };
  }
  writeJson(file, out);
  return out;
}

const sample = readJson<{ pull: number; stratum: Stratum }[]>(dataPath('sample.json'));
async function review(pull: number): Promise<void> {
  const frozen = readJson<FrozenPull>(dataPath('snapshots', `${pull}.json`));
  const snap = snapshotOf(frozen);
  const scope = classify(snap.files);
  const cls = scope.kind === 'decided' ? scope.class : 'content';
  const roles = REVIEWERS_FOR[cls].filter((r): r is PromptRole => r !== 'link-auditor');
  writeJson(dataPath('outputs', String(pull), 'scope.json'), {
    class: cls,
    why: scope.kind === 'decided' ? scope.why : 'ambiguous, counted as content',
  });

  const jobs: Promise<Output<unknown>>[] = [];
  const baseline: Promise<Output<unknown>>[] = [];
  for (const role of roles)
    for (const cast of CAST[role]) {
      const system = reviewerPrompt(cast.prompt);
      const user = reviewerMessage(snap, { withRelated: role === 'duplication-checker' });
      const mt = role.startsWith('security') ? 16_000 : 8_000;
      if (!SKIP.has(cast.baseline)) {
        const b = ask(pull, role, cast.baseline, ReviewerReport, system, user, mt);
        baseline.push(b);
        jobs.push(b);
      }
      for (const cand of cast.candidates.filter((m) => !SKIP.has(m)))
        jobs.push(ask(pull, role, cand, ReviewerReport, system, user, mt));
    }
  const base = await Promise.all(baseline);
  const reports = base
    .filter((o) => o.ok)
    .map((o) => ({ role: o.role, report: o.answer as ReviewerReport }));
  const notRun = roles.filter((r) => !reports.some((x) => x.role === r));
  for (const j of JUDGES)
    jobs.push(
      ask(
        pull,
        'judge',
        j,
        ReviewDecision,
        JUDGE_PROMPT,
        judgeMessage(snap, reports, notRun),
        16_000,
      ),
    );
  const all = await Promise.all(jobs);
  console.log(
    `#${pull} ${cls}: ${all.filter((o) => o.ok).length}/${all.length} ok, total $${spent().usd.toFixed(2)}`,
  );
}

try {
  const queue = sample.map((x) => x.pull);
  await Promise.all(
    Array.from({ length: PARALLEL_PRS }, async () => {
      for (let pull = queue.shift(); pull !== undefined; pull = queue.shift()) await review(pull);
    }),
  );
} catch (err) {
  if (err instanceof BudgetExceeded) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
console.log(`done: $${spent().usd.toFixed(2)} in ${spent().calls} calls`);
