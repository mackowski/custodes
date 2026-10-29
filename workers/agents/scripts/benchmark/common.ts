/**
 * Shared pieces of the one-off cheatsheet-review model benchmark (see README.md). Runs locally
 * through `scripts/with-secrets.sh`, never in CI. Read-only: public GitHub reads and model calls
 * through the one AI Gateway; no broker, no GitHub writes. Data stays outside the repository in
 * `.bench/cheatsheet-review/` (git-ignored); only the aggregated REPORT.md is committed.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import process from 'node:process';
import {
  AnthropicChat,
  AnthropicGateway,
  OpenRouterGateway,
  WorkersAiChat,
  type AiRunner,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
} from '@custodes/llm';

// The generated Worker types describe process.env as the Worker's bindings; here it is the shell's.
const env = process.env as unknown as Record<string, string | undefined>;

/** Run from `workers/agents` (README.md): bundled scripts live in /tmp, so paths follow the cwd. */
export const ROOT = new URL('../../', `file://${process.cwd()}/`);
export const DATA = new URL('.bench/cheatsheet-review/', ROOT);
export const REPO = 'OWASP/CheatSheetSeries';
/** Hard budget (grill-plan Q6). */
export const BUDGET_USD = 50;

export function dataPath(...parts: string[]): URL {
  const url = new URL(parts.join('/'), DATA);
  mkdirSync(new URL('.', url), { recursive: true });
  return url;
}
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the file's shape
export const readJson = <T>(u: URL): T => JSON.parse(readFileSync(u, 'utf8')) as T;
export const writeJson = (u: URL, v: unknown) => {
  writeFileSync(u, `${JSON.stringify(v, null, 2)}\n`);
};
export const exists = (u: URL) => existsSync(u);

// ---------- GitHub (public reads) ----------

/** Public GitHub REST read; a token (GITHUB_TOKEN) only raises the rate limit. */
export async function gh<T>(path: string): Promise<T> {
  const token = env['GITHUB_TOKEN'];
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'custodes-benchmark',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path.split('?')[0] ?? ''}`);
  return res.json<T>();
}

export async function ghAll<T>(path: string, pages = 10): Promise<T[]> {
  const out: T[] = [];
  const sep = path.includes('?') ? '&' : '?';
  for (let p = 1; p <= pages; p++) {
    const batch = await gh<T[]>(`${path}${sep}per_page=100&page=${p}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export function decodeContent(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

// ---------- models ----------

export type Transport = 'anthropic' | 'openrouter' | 'workers-ai';

export interface BenchModel {
  id: string;
  transport: Transport;
  /** USD per million tokens, input / output (list prices, ADR 0017 research and OpenRouter). */
  price: [number, number];
}

export const MODELS = {
  opus: { id: 'claude-opus-5-5', transport: 'anthropic', price: [4, 20] },
  sonnet: { id: 'claude-sonnet-5-5', transport: 'anthropic', price: [2, 10] },
  deepseekPro: {
    id: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    transport: 'workers-ai',
    price: [1.32, 3.96],
  },
  deepseekFlash: {
    id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    transport: 'workers-ai',
    price: [0.3, 1.2],
  },
  museSpark: { id: 'meta/muse-spark-1.3', transport: 'openrouter', price: [1.25, 4.25] },
  museWonder: { id: 'meta/muse-wonder', transport: 'openrouter', price: [4, 20] },
  luna: { id: 'openai/gpt-6-luna', transport: 'openrouter', price: [0.1, 0.5] },
  sol: { id: 'openai/gpt-6.1-sol', transport: 'openrouter', price: [2, 10] },
  astra: { id: 'openai/gpt-6-astra', transport: 'openrouter', price: [10, 50] },
  /** The grader: in no candidate role, so it never grades itself (grill-plan Q2). */
  terra: { id: 'openai/gpt-6.1-terra', transport: 'openrouter', price: [1, 5] },
} as const satisfies Record<string, BenchModel>;
export type ModelName = keyof typeof MODELS;

const accountId = env['AI_GATEWAY_ACCOUNT_ID'] ?? '5f62912564df344533c9563904c77662';
const gatewayId = env['AI_GATEWAY_ID'] ?? 'custodes';

/** Workers AI through the gateway's REST route, as the Diagnose smoke test does (no binding here). */
function restRunner(token: string, cfToken: string): AiRunner {
  return {
    async run(model, inputs, options) {
      const res = await fetch(
        `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/workers-ai/${model}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfToken}`,
            'cf-aig-authorization': `Bearer ${token}`,
            'cf-aig-metadata': JSON.stringify(options.gateway.metadata ?? {}),
          },
          body: JSON.stringify(inputs),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (!res.ok)
        throw Object.assign(new Error('workers ai'), {
          name: 'WorkersAiError',
          status: res.status,
        });
      const body = await res.json<{ result?: unknown }>();
      return body.result ?? body;
    },
  };
}

export function clients(): Record<Transport, ChatModel> {
  const token = env['AI_GATEWAY_TOKEN'];
  const cfToken = env['CF_WORKERS_AI_EVAL_TOKEN'];
  if (!token || !cfToken)
    throw new Error(
      'AI_GATEWAY_TOKEN and CF_WORKERS_AI_EVAL_TOKEN must be set (scripts/with-secrets.sh)',
    );
  return {
    anthropic: new AnthropicChat(
      new AnthropicGateway({ accountId, gatewayId, gatewayToken: token }),
    ),
    openrouter: new OpenRouterGateway({
      accountId,
      gatewayId,
      gatewayToken: token,
      timeoutMs: 300_000,
    }),
    'workers-ai': new WorkersAiChat({
      ai: restRunner(token, cfToken),
      gatewayId,
      timeoutMs: 300_000,
    }),
  };
}

// ---------- cost ----------

interface Ledger {
  usd: number;
  calls: number;
}
const LEDGER = () => dataPath('ledger.json');

export function spent(): Ledger {
  return exists(LEDGER()) ? readJson<Ledger>(LEDGER()) : { usd: 0, calls: 0 };
}

export function costOf(m: BenchModel, r: ChatResult): number {
  const u = r.usage;
  return u ? (u.input_tokens * m.price[0] + u.output_tokens * m.price[1]) / 1_000_000 : 0;
}

export class BudgetExceeded extends Error {
  constructor(usd: number) {
    super(`budget of $${BUDGET_USD} reached ($${usd.toFixed(2)} spent)`);
    this.name = 'BudgetExceeded';
  }
}

/** One model call, charged to the ledger; refuses to start once the budget is spent. */
export async function call(
  c: Record<Transport, ChatModel>,
  name: ModelName,
  req: Omit<ChatRequest, 'model' | 'metadata'>,
  tag: string,
): Promise<{ result: ChatResult; usd: number }> {
  const before = spent();
  if (before.usd >= BUDGET_USD) throw new BudgetExceeded(before.usd);
  const m = MODELS[name];
  const result = await c[m.transport].complete({
    ...req,
    model: m.id,
    metadata: { agentId: 'benchmark', runId: 'cheatsheet-review-2026-10', subAgent: tag },
  });
  const usd = costOf(m, result);
  const now = spent();
  writeJson(LEDGER(), { usd: now.usd + usd, calls: now.calls + 1 });
  return { result, usd };
}
