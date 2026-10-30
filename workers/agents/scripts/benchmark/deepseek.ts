/**
 * Step 2b: the targeted DeepSeek pass. The second security voice timed out on Workers AI (HTTP 408
 * after ~235 s) with the default `reasoning_effort: high`, so it gets its own run: V4 Pro 0813 and
 * V4.1 Flash 1017, each with `low` and `high`, on the pull requests where security runs. Same prompt
 * and input as the agent's second voice. Workers AI only: no Anthropic call is possible here.
 * Records duration and timeouts next to the answer; answers are cached like run.ts.
 */
import process from 'node:process';
import { parseStructured, readCompletion } from '@custodes/llm';
import { reviewerMessage } from '../../src/agents/cheatsheet-review/input.js';
import { reviewerPrompt } from '../../src/agents/cheatsheet-review/prompts.js';
import { ReviewerReport } from '../../src/agents/cheatsheet-review/types.js';
import { BUDGET_USD, dataPath, exists, limiter, readJson, spent, writeJson } from './common.js';
import { snapshotOf } from './snapshot.js';
import type { FrozenPull, Stratum } from './select.js';

// The generated Worker types describe process.env as the Worker's bindings; here it is the shell's.
const env = process.env as unknown as Record<string, string | undefined>;
const token = env['AI_GATEWAY_TOKEN'];
const cfToken = env['CF_WORKERS_AI_EVAL_TOKEN'];
if (!token || !cfToken)
  throw new Error('AI_GATEWAY_TOKEN and CF_WORKERS_AI_EVAL_TOKEN must be set');

export const VARIANTS = [
  {
    key: 'deepseekPro-low',
    model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    effort: 'low',
    price: [1.32, 3.96],
  },
  {
    key: 'deepseekPro-high',
    model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    effort: 'high',
    price: [1.32, 3.96],
  },
  {
    key: 'deepseekFlash-low',
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    effort: 'low',
    price: [0.3, 1.2],
  },
  {
    key: 'deepseekFlash-high',
    model: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    effort: 'high',
    price: [0.3, 1.2],
  },
] as const;

/** Separate cap for this pass, inside the overall budget. */
const PASS_CAP_USD = 5;
const TIMEOUT_MS = 250_000;
const limit = limiter(10);
const start = spent().usd;

async function one(pull: number, user: string, v: (typeof VARIANTS)[number]) {
  const file = dataPath('outputs', String(pull), `security-second-voice.${v.key}.json`);
  if (exists(file)) return;
  if (spent().usd - start >= PASS_CAP_USD || spent().usd >= BUDGET_USD) return;
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
  }, TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://gateway.ai.cloudflare.com/v1/5f62912564df344533c9563904c77662/custodes/workers-ai/${v.model}`,
      {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfToken ?? ''}`,
          'cf-aig-authorization': `Bearer ${token ?? ''}`,
          'cf-aig-metadata': JSON.stringify({
            agentId: 'benchmark',
            runId: 'cheatsheet-review-2026-10',
            subAgent: `deepseek:${v.key}:${pull}`,
          }),
        },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: reviewerPrompt('security-second-voice') },
            { role: 'user', content: user },
          ],
          max_tokens: 24_000,
          reasoning_effort: v.effort,
        }),
      },
    );
    const status = res.status;
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.log(`#${pull} ${v.key}: HTTP ${status} after ${Math.round(ms / 1000)}s`);
      writeJson(file, {
        pull,
        role: 'security-second-voice',
        model: v.key,
        ok: false,
        error: `HTTP ${status}`,
        ms,
        usd: 0,
      });
      return;
    }
    const body = await res.json<{ result?: unknown }>();
    const { out } = readCompletion(body.result ?? body, v.model);
    const usd = out.usage
      ? (out.usage.input_tokens * v.price[0] + out.usage.output_tokens * v.price[1]) / 1e6
      : 0;
    const now = spent();
    writeJson(dataPath('ledger.json'), { usd: now.usd + usd, calls: now.calls + 1 });
    let answer: ReviewerReport | undefined;
    try {
      answer = parseStructured(ReviewerReport, out.text);
    } catch {
      answer = undefined;
    }
    writeJson(file, {
      pull,
      role: 'security-second-voice',
      model: v.key,
      ok: answer !== undefined,
      ...(answer ? { answer } : { error: 'unparsable' }),
      ms,
      usd,
      tokens: out.usage,
    });
    console.log(
      `#${pull} ${v.key}: ${answer ? 'ok' : 'unparsable'} ${Math.round(ms / 1000)}s $${usd.toFixed(3)}`,
    );
  } catch (err) {
    const ms = Date.now() - t0;
    const why = ac.signal.aborted ? 'timeout' : err instanceof Error ? err.name : 'error';
    console.log(`#${pull} ${v.key}: ${why} after ${Math.round(ms / 1000)}s`);
    writeJson(file, {
      pull,
      role: 'security-second-voice',
      model: v.key,
      ok: false,
      error: why,
      ms,
      usd: 0,
    });
  } finally {
    clearTimeout(timer);
  }
}

const sample = readJson<{ pull: number; stratum: Stratum }[]>(dataPath('sample.json'));
const jobs: Promise<void>[] = [];
for (const { pull } of sample) {
  const scope = readJson<{ class: string }>(dataPath('outputs', String(pull), 'scope.json'));
  if (scope.class !== 'content' && scope.class !== 'code') continue;
  const user = reviewerMessage(
    snapshotOf(readJson<FrozenPull>(dataPath('snapshots', `${pull}.json`))),
    { withRelated: false },
  );
  for (const v of VARIANTS) jobs.push(limit(() => one(pull, user, v)));
}
await Promise.all(jobs);
console.log(
  `DeepSeek pass: $${(spent().usd - start).toFixed(2)} (total $${spent().usd.toFixed(2)})`,
);
