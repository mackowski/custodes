/**
 * The agent runtime's Messages protocol (ADR 0023) on an OpenAI model through OpenRouter, via AI
 * Gateway with the stored key: the fallback when Anthropic fails (#132, operator decision
 * 2026-11-26). Translates the request (system, tool_use and tool_result blocks, tools) to Chat
 * Completions with function tools, and the answer back, so the loop, its caps and its checks are
 * the same whichever model answered.
 */
import {
  errorTypeOf,
  GatewayError,
  ModelOutputError,
  openRouterCode,
  type MessagesRequest,
  type MessagesResponse,
} from './gateway.js';
import { gatewayMetadata } from './metadata.js';
import { withTimeout } from './timeout.js';

const TIMEOUT_MS = 180_000;

export interface OpenRouterMessagesConfig {
  accountId: string;
  gatewayId: string;
  gatewayToken: string;
  /** e.g. `low` | `medium` | `high`; default `medium` (OpenAI's own default for agents). */
  reasoningEffort?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** The Messages request as Chat Completions messages and function tools. */
export function toChatCompletions(req: MessagesRequest): {
  messages: ChatMessage[];
  tools?: unknown[];
} {
  const messages: ChatMessage[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function' as const,
                function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
              },
            ]
          : [],
      );
      messages.push({
        role: 'assistant',
        content: text === '' ? null : text,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    // A user turn: tool results become `tool` messages, any text one user message after them.
    for (const b of m.content)
      if (b.type === 'tool_result')
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
    const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    if (text !== '') messages.push({ role: 'user', content: text });
  }
  const tools = req.tools?.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
  return { messages, ...(tools && tools.length > 0 ? { tools } : {}) };
}

/**
 * A Chat Completions answer as a Messages response. The model id is the one asked for, so the
 * caller prices it with its own row. Tool arguments that are not JSON become `null`, which the
 * tool's zod schema refuses (the loop stops with `invalid_args`).
 */
export function fromChatCompletion(raw: unknown, model: string): MessagesResponse {
  const r = (raw ?? {}) as {
    id?: unknown;
    choices?: {
      finish_reason?: unknown;
      message?: {
        content?: unknown;
        refusal?: unknown;
        tool_calls?: { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[];
      };
    }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const choice = r.choices?.[0];
  const usage = {
    input_tokens: Number(r.usage?.prompt_tokens),
    output_tokens: Number(r.usage?.completion_tokens),
  };
  const finish = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  if (finish === 'length') throw new ModelOutputError('max_tokens', usage, model);
  if (finish === 'content_filter' || typeof choice?.message?.refusal === 'string')
    throw new ModelOutputError('refusal', usage, model);
  const content: MessagesResponse['content'] = [];
  const text = choice?.message?.content;
  if (typeof text === 'string' && text !== '') content.push({ type: 'text', text });
  for (const c of choice?.message?.tool_calls ?? []) {
    let input: unknown;
    try {
      input = typeof c.function?.arguments === 'string' ? JSON.parse(c.function.arguments) : null;
    } catch {
      input = null;
    }
    content.push({
      type: 'tool_use',
      id: typeof c.id === 'string' ? c.id : crypto.randomUUID(),
      name: typeof c.function?.name === 'string' ? c.function.name : '',
      input,
    });
  }
  const toolCalls = content.some((b) => b.type === 'tool_use');
  return {
    id: typeof r.id === 'string' ? r.id : crypto.randomUUID(),
    model,
    stop_reason: toolCalls ? 'tool_use' : 'end_turn',
    content,
    usage,
  };
}

/** `send` for the runtime on an OpenAI model through OpenRouter (AI Gateway, stored key). */
export class OpenRouterMessages {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OpenRouterMessagesConfig) {
    this.url = `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayId}/openrouter/v1/chat/completions`;
    // Unbound wrapper: a stored global fetch throws "Illegal invocation" in Workers.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async messages(req: MessagesRequest): Promise<MessagesResponse> {
    const { messages, tools } = toChatCompletions(req);
    const body = {
      model: req.model,
      messages,
      ...(tools ? { tools } : {}),
      max_tokens: req.max_tokens,
      reasoning: { effort: this.cfg.reasoningEffort ?? 'medium' },
      // Only upstream hosts that neither keep nor train on prompts, and that honour tools.
      provider: { data_collection: 'deny', require_parameters: true },
    };
    const res = await withTimeout(this.cfg.timeoutMs ?? TIMEOUT_MS, async (signal) => {
      const r = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'cf-aig-authorization': `Bearer ${this.cfg.gatewayToken}`,
          'cf-aig-metadata': JSON.stringify(gatewayMetadata(req.metadata)),
          'cf-aig-no-wholesale': 'true',
        },
        body: JSON.stringify(body),
        signal,
      });
      return { ok: r.ok, status: r.status, text: await r.text() };
    });
    if (!res.ok)
      throw new GatewayError(
        res.status,
        res.text.slice(0, 500),
        errorTypeOf(res.text) ?? openRouterCode(res.text),
      );
    return fromChatCompletion(JSON.parse(res.text) as unknown, req.model);
  }
}

/**
 * `send` with a fallback: the primary model, and on a transport or API failure (not an unusable
 * answer, which is the model's own) the same request on `fallbackModel`. The response names the
 * model that answered, so the run prices it at that model's rates.
 */
export function withFallback(
  primary: (req: MessagesRequest) => Promise<MessagesResponse>,
  fallback: (req: MessagesRequest) => Promise<MessagesResponse>,
  fallbackModel: string,
  onFallback?: (err: unknown) => void,
): (req: MessagesRequest) => Promise<MessagesResponse> {
  return async (req) => {
    try {
      const res = await primary(req);
      return { ...res, model: req.model };
    } catch (err) {
      if (!isProviderOutage(err)) throw err;
      onFallback?.(err);
      return fallback({ ...req, model: fallbackModel });
    }
  };
}

/**
 * Whether a primary failure is the provider's, not the request's: a timeout or network error,
 * 429, 5xx (529 overloaded), or a 400 for the credit balance. A request the provider refuses for
 * itself (another 4xx, e.g. a prompt too long) does not fall back, so issue text cannot pick the
 * model (security review of the fallback, #168 M1).
 */
export function isProviderOutage(err: unknown): boolean {
  if (err instanceof ModelOutputError) return false;
  if (!(err instanceof GatewayError)) return true;
  if (err.status === 429 || err.status >= 500) return true;
  return err.status === 400 && /credit balance/i.test(err.message);
}
