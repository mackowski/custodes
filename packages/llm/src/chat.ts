/**
 * One chat interface over every model family an agent may ask for free text (ADR 0017): Anthropic
 * through `AnthropicGateway`, OpenAI and Meta models through AI Gateway's OpenRouter provider, and
 * Workers AI models through the `AI` binding. All of them go through the one AI Gateway (ADR 0015).
 *
 * - BYOK only: the OpenRouter key lives in the gateway; we send the gateway token and
 *   `cf-aig-no-wholesale`, so a missing key fails instead of falling back to Unified Billing.
 * - A schema, when given, is passed to providers that can enforce it. The caller still parses with
 *   `parseStructured()`: enforcement differs per provider and is never trusted on its own.
 * - Inside a turn, each call is a `chat` span (ADR 0016) with the same attributes as
 *   `AnthropicGateway`, so all providers read the same in the dashboard.
 */
import { chat, type OperationSpan, type Turn } from '@custodes/core';
import type { AiRunner } from './clef.js';
import {
  AnthropicGateway,
  errorTypeOf,
  GatewayError,
  ModelOutputError,
  type MessagesRequest,
} from './gateway.js';

export interface ChatRequest {
  model: string;
  system: string;
  user: string;
  max_tokens: number;
  /** JSON Schema of the expected answer, for providers that can enforce one. */
  schema?: { name: string; schema: Record<string, unknown> };
  /** Sent as `cf-aig-metadata`: ids only (agentId, runId, subAgent). At most 5 entries. */
  metadata: { agentId: string; runId: string; [k: string]: string };
}

export interface ChatResult {
  text: string;
  /** The model the provider says answered (may differ from the requested alias). */
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export interface ChatModel {
  /** OpenTelemetry `gen_ai.provider.name`. */
  readonly provider: string;
  complete(req: ChatRequest, turn?: Turn): Promise<ChatResult>;
}

/** The call did not answer in time. */
export class ChatTimeoutError extends Error {
  constructor() {
    super('model call timed out');
    this.name = 'ChatTimeoutError';
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;

function requestPayloads(span: OperationSpan, req: ChatRequest) {
  span.set('gen_ai.request.max_tokens', req.max_tokens);
  span.payload('gen_ai.system_instructions', [{ type: 'text', content: req.system }]);
  span.payload('gen_ai.input.messages', [
    { role: 'user', parts: [{ type: 'text', content: req.user }] },
  ]);
}

function resultAttributes(span: OperationSpan, out: ChatResult, finish: string) {
  span.set('gen_ai.response.model', out.model);
  span.set('gen_ai.usage.input_tokens', out.usage?.input_tokens);
  span.set('gen_ai.usage.output_tokens', out.usage?.output_tokens);
  span.payload('gen_ai.output.messages', [
    { role: 'assistant', parts: [{ type: 'text', content: out.text }], finish_reason: finish },
  ]);
}

/** Runs `work` with an abort signal and rejects with `ChatTimeoutError` after `ms`. */
async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: aborting can make the work reject synchronously and win the race.
      reject(new ChatTimeoutError());
      ac.abort();
    }, ms);
  });
  try {
    return await Promise.race([work(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads an OpenAI-style chat completion (`choices[0].message`) or a Workers AI `{response}` answer.
 * Unvalidated JSON from a provider: every field is checked before use.
 */
export function readCompletion(
  raw: unknown,
  requested: string,
): { out: ChatResult; finish: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const usage = readUsage(r['usage']);
  const model = typeof r['model'] === 'string' ? r['model'] : requested;
  const choice = Array.isArray(r['choices'])
    ? ((r['choices'][0] ?? {}) as Record<string, unknown>)
    : undefined;
  if (choice) {
    const message = (choice['message'] ?? {}) as Record<string, unknown>;
    const finish =
      typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : 'unknown';
    if (typeof message['refusal'] === 'string' && message['refusal'])
      throw new ModelOutputError('refusal');
    if (finish === 'content_filter') throw new ModelOutputError('refusal');
    if (finish === 'length') throw new ModelOutputError('max_tokens');
    const text = typeof message['content'] === 'string' ? message['content'] : '';
    return { out: { text, model, ...(usage ? { usage } : {}) }, finish };
  }
  const response = r['response'];
  const text =
    typeof response === 'string'
      ? response
      : response !== undefined && response !== null
        ? JSON.stringify(response)
        : '';
  return { out: { text, model, ...(usage ? { usage } : {}) }, finish: 'stop' };
}

function readUsage(u: unknown): ChatResult['usage'] {
  if (typeof u !== 'object' || u === null) return undefined;
  const o = u as Record<string, unknown>;
  const input = o['prompt_tokens'] ?? o['input_tokens'];
  const output = o['completion_tokens'] ?? o['output_tokens'];
  return typeof input === 'number' && typeof output === 'number'
    ? { input_tokens: input, output_tokens: output }
    : undefined;
}

export interface OpenRouterGatewayConfig {
  accountId: string;
  gatewayId: string;
  gatewayToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** OpenAI-compatible chat completions on OpenRouter, through AI Gateway with the stored key. */
export class OpenRouterGateway implements ChatModel {
  readonly provider = 'openrouter';
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OpenRouterGatewayConfig) {
    this.url = `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayId}/openrouter/v1/chat/completions`;
    // Unbound wrapper: a stored global fetch throws "Illegal invocation" in Workers.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  complete(req: ChatRequest, turn?: Turn): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.max_tokens,
    };
    if (req.schema) {
      body['response_format'] = {
        type: 'json_schema',
        json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema },
      };
      // Route only to providers that honour response_format, instead of silently ignoring it.
      body['provider'] = { require_parameters: true };
    }
    return chat(turn, { provider: this.provider, model: req.model }, async (span) => {
      requestPayloads(span, req);
      const res = await withTimeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
        this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'cf-aig-authorization': `Bearer ${this.cfg.gatewayToken}`,
            'cf-aig-metadata': JSON.stringify(req.metadata),
            'cf-aig-no-wholesale': 'true',
          },
          body: JSON.stringify(body),
          signal,
        }),
      );
      if (!res.ok) {
        const text = await res.text();
        throw new GatewayError(res.status, text.slice(0, 500), errorTypeOf(text));
      }
      const { out, finish } = readCompletion(await res.json(), req.model);
      resultAttributes(span, out, finish);
      return out;
    });
  }
}

export interface WorkersAiChatConfig {
  ai: AiRunner;
  /** AI Gateway id. Required: a blank id throws, so a call can never skip the gateway. */
  gatewayId: string;
  timeoutMs?: number;
}

/** Text generation on Workers AI through the `AI` binding, always naming the gateway. */
export class WorkersAiChat implements ChatModel {
  readonly provider = 'cloudflare.workers_ai';

  constructor(private readonly cfg: WorkersAiChatConfig) {
    if (!cfg.gatewayId.trim()) throw new Error('WorkersAiChat needs an AI Gateway id');
  }

  complete(req: ChatRequest, turn?: Turn): Promise<ChatResult> {
    const inputs: Record<string, unknown> = {
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      max_tokens: req.max_tokens,
    };
    if (req.schema)
      inputs['response_format'] = { type: 'json_schema', json_schema: req.schema.schema };
    return chat(turn, { provider: this.provider, model: req.model }, async (span) => {
      requestPayloads(span, req);
      const raw = await withTimeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
        this.cfg.ai.run(req.model, inputs, {
          gateway: { id: this.cfg.gatewayId, metadata: { ...req.metadata } },
          signal,
        }),
      );
      const { out, finish } = readCompletion(raw, req.model);
      resultAttributes(span, out, finish);
      return out;
    });
  }
}

/** `AnthropicGateway` behind the same interface; the `chat` span is the gateway's own. */
export class AnthropicChat implements ChatModel {
  readonly provider = 'anthropic';

  constructor(
    private readonly gateway: AnthropicGateway,
    /** Omitted by default: Opus 5.5 rejects `disabled`, and the model's default applies. */
    private readonly thinking?: MessagesRequest['thinking'],
  ) {}

  async complete(req: ChatRequest, turn?: Turn): Promise<ChatResult> {
    const res = await this.gateway.messages(
      {
        model: req.model,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        max_tokens: req.max_tokens,
        ...(this.thinking ? { thinking: this.thinking } : {}),
        metadata: req.metadata,
      },
      turn,
    );
    return { text: AnthropicGateway.text(res), model: res.model, usage: res.usage };
  }
}
