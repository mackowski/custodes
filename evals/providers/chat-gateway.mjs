// promptfoo custom provider: chat completions through AI Gateway, as OpenRouterGateway and
// WorkersAiChat in packages/llm/src/chat.ts send them (ADR 0017).
// - transport "openrouter": the gateway's openrouter provider with the stored (BYOK) key; gateway
//   token only, no Unified Billing fallback, upstream hosts that keep no prompts.
// - transport "workers-ai": the gateway's workers-ai route with CF_WORKERS_AI_EVAL_TOKEN (the agent
//   uses the AI binding with the same gateway id; CI has no binding).
// Config (per suite): transport, model, max_tokens, runId, optional reasoning_effort. Vars: system,
// user.
// Output: the JSON the agent would parse (extract.mjs mirrors parseStructured).

import { extractJson } from './extract.mjs';

/** @typedef {{ transport: 'openrouter' | 'workers-ai', model: string, max_tokens: number, runId: string, reasoning_effort?: string }} ChatConfig */

export default class ChatGatewayProvider {
  /** @param {{ id?: string, config: ChatConfig }} options */
  constructor(options) {
    this.config = options.config;
    this.providerId = options.id ?? 'chat-gateway';
  }

  id() {
    return this.providerId;
  }

  /**
   * @param {string} _prompt
   * @param {{ vars: Record<string, unknown> }} context
   */
  async callApi(_prompt, context) {
    const env = process.env;
    const c = this.config;
    const base = `https://gateway.ai.cloudflare.com/v1/${env['AI_GATEWAY_ACCOUNT_ID'] ?? ''}/${env['AI_GATEWAY_ID'] ?? ''}`;
    const system = context.vars['system'];
    const user = context.vars['user'];
    const messages = [
      { role: 'system', content: typeof system === 'string' ? system : '' },
      { role: 'user', content: typeof user === 'string' ? user : '' },
    ];
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      'cf-aig-authorization': `Bearer ${env['AI_GATEWAY_TOKEN'] ?? ''}`,
      'cf-aig-metadata': JSON.stringify({ agentId: 'evals', runId: c.runId }),
    };
    let url;
    let body;
    if (c.transport === 'openrouter') {
      url = `${base}/openrouter/v1/chat/completions`;
      headers['cf-aig-no-wholesale'] = 'true';
      body = {
        model: c.model,
        messages,
        max_tokens: c.max_tokens,
        provider: { data_collection: 'deny' },
        ...(c.reasoning_effort ? { reasoning: { effort: c.reasoning_effort } } : {}),
      };
    } else {
      const token = env['CF_WORKERS_AI_EVAL_TOKEN'];
      if (!token) return { error: 'CF_WORKERS_AI_EVAL_TOKEN is not set' };
      url = `${base}/workers-ai/${c.model}`;
      headers['authorization'] = `Bearer ${token}`;
      body = {
        messages,
        max_tokens: c.max_tokens,
        ...(c.reasoning_effort ? { reasoning_effort: c.reasoning_effort } : {}),
      };
    }
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    // Status only: response bodies can quote the prompt.
    if (!res.ok) return { error: `HTTP ${String(res.status)}` };
    /** @type {unknown} */
    const raw = await res.json();
    const r = /** @type {Record<string, unknown>} */ (raw);
    const payload = /** @type {Record<string, unknown>} */ (
      c.transport === 'workers-ai' && r['result'] ? r['result'] : r
    );
    const choices =
      /** @type {{ message?: { content?: unknown }, finish_reason?: unknown }[] | undefined} */ (
        payload['choices']
      );
    const response = payload['response'];
    const text = Array.isArray(choices)
      ? typeof choices[0]?.message?.content === 'string'
        ? choices[0].message.content
        : ''
      : typeof response === 'string'
        ? response
        : JSON.stringify(response ?? '');
    const usage =
      /** @type {{ prompt_tokens?: number, completion_tokens?: number } | undefined} */ (
        payload['usage']
      );
    const prompt = usage?.prompt_tokens ?? 0;
    const completion = usage?.completion_tokens ?? 0;
    return {
      output: extractJson(text),
      tokenUsage: { prompt, completion, total: prompt + completion },
    };
  }
}
