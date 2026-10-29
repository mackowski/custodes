/**
 * Anthropic Messages API through Cloudflare AI Gateway.
 *
 * - BYOK: the Anthropic key lives in AI Gateway, not in the Worker. We only send the gateway
 *   token (`cf-aig-authorization`).
 * - Every request carries `cf-aig-metadata` (agentId, runId) for attribution and spend limits.
 * - Guardrails / DLP are configured on the gateway itself (see infra/terraform/modules/ai-gateway).
 * - The stored key is found, not configured: the gateway looks for alias `default`, and when it
 *   answers that there is none but exactly one other alias exists, that alias is used (and
 *   remembered per isolate). With several aliases the call fails rather than guess between keys.
 * - Inside a turn, each call is a `chat` span (ADR 0016).
 */
import { chat, type Turn } from '@custodes/core';

export interface GatewayConfig {
  accountId: string;
  gatewayId: string;
  /** Token for an authenticated gateway. */
  gatewayToken: string;
  /** Only for local development against a non-BYOK gateway. Never set in production. */
  anthropicApiKey?: string;
  fetchImpl?: typeof fetch;
}

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Deliberately no `temperature`, `top_p` or `top_k`: current Claude models (Sonnet 5, Opus 5.x,
 * Fable) reject them with HTTP 400 ("`temperature` is deprecated for this model"). Determinism
 * comes from a strict output schema and validation, not sampling parameters.
 */
export interface MessagesRequest {
  model: string;
  system: string;
  messages: MessageParam[];
  max_tokens: number;
  /**
   * Adaptive thinking spends output tokens before the answer and counts against `max_tokens`.
   * Short classification calls disable it so a small budget cannot be consumed by thinking.
   */
  thinking?: { type: 'disabled' } | { type: 'adaptive' };
  metadata: { agentId: string; runId: string; [k: string]: string };
}

export type ContentBlock = { type: 'text'; text: string } | { type: string; [k: string]: unknown };

export interface MessagesResponse {
  id: string;
  model: string;
  stop_reason: string | null;
  content: ContentBlock[];
  usage: { input_tokens: number; output_tokens: number };
}

/** Transport or API failure. `errorType` is the provider's error class (e.g. invalid_request_error). */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly errorType?: string,
  ) {
    super(`AI Gateway ${status}${errorType ? ` ${errorType}` : ''}: ${detail}`);
    this.name = 'GatewayError';
  }
}

/** The model answered but the answer is unusable for this input (refused or cut off). */
export class ModelOutputError extends Error {
  constructor(readonly reason: 'refusal' | 'max_tokens') {
    super(`model output unusable: ${reason}`);
    this.name = 'ModelOutputError';
  }
}

/** Extracts the provider error class from an error body without keeping any message text. */
export function errorTypeOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const t = (parsed as { error?: { type?: unknown } }).error?.type;
    return typeof t === 'string' && /^[a-z_]{1,60}$/.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** AI Gateway's error for a BYOK alias the provider does not have. */
const BYOK_ALIAS_MISSING = 2040;
const BYOK_ALIAS = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * When `body` is AI Gateway's "no BYOK credential named …" error, the aliases it says are
 * configured; otherwise undefined. A malformed name makes the list empty, so it is never used.
 */
export function byokAliasesOf(body: string): string[] | undefined {
  try {
    const parsed = JSON.parse(body) as { internalCode?: unknown; message?: unknown };
    if (parsed.internalCode !== BYOK_ALIAS_MISSING || typeof parsed.message !== 'string')
      return undefined;
    const list = /Configured aliases: (.*)$/.exec(parsed.message)?.[1] ?? '';
    const aliases = [...list.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
    return aliases.every((a) => BYOK_ALIAS.test(a)) ? aliases : [];
  } catch {
    return undefined;
  }
}

/** BYOK alias found per gateway URL, for this isolate. A renamed key is found again on its 2040. */
const discoveredAliases = new Map<string, string>();

export class AnthropicGateway {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GatewayConfig) {
    this.url = `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayId}/anthropic/v1/messages`;
    // Never store the global fetch as a method: calling it with `this` bound throws
    // "Illegal invocation" in Workers. Wrap it in a function instead.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async messages(req: MessagesRequest, turn?: Turn): Promise<MessagesResponse> {
    const { metadata, ...body } = req;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'cf-aig-authorization': `Bearer ${this.cfg.gatewayToken}`,
      'cf-aig-metadata': JSON.stringify(metadata),
      // Use only our stored (BYOK) key; if it is missing, fail instead of silently falling back
      // to Cloudflare Unified Billing credentials.
      'cf-aig-no-wholesale': 'true',
    };
    if (this.cfg.anthropicApiKey) headers['x-api-key'] = this.cfg.anthropicApiKey;
    return chat(turn, { provider: 'anthropic', model: req.model }, async (span) => {
      span.set('gen_ai.request.max_tokens', req.max_tokens);
      span.payload('gen_ai.system_instructions', [{ type: 'text', content: req.system }]);
      span.payload(
        'gen_ai.input.messages',
        req.messages.map((m) => ({ role: m.role, parts: [{ type: 'text', content: m.content }] })),
      );
      const send = (alias: string | undefined) =>
        this.fetchImpl(this.url, {
          method: 'POST',
          headers: alias !== undefined ? { ...headers, 'cf-aig-byok-alias': alias } : headers,
          body: JSON.stringify(body),
        });
      const known = discoveredAliases.get(this.url);
      let res = await send(known);
      if (!res.ok) {
        let text = await res.text();
        const aliases = byokAliasesOf(text);
        if (aliases) {
          discoveredAliases.delete(this.url);
          const only = aliases.length === 1 ? aliases[0] : undefined;
          if (only !== undefined && only !== known) {
            discoveredAliases.set(this.url, only);
            span.set('custodes.byok_alias_discovered', true);
            res = await send(only);
            if (!res.ok) text = await res.text();
          }
        }
        if (!res.ok)
          throw new GatewayError(
            res.status,
            text.slice(0, 500),
            byokAliasesOf(text) ? 'byok_alias_missing' : errorTypeOf(text),
          );
      }
      const out = await res.json<MessagesResponse>();
      span.set('gen_ai.response.id', out.id);
      span.set('gen_ai.response.model', out.model);
      // Unvalidated JSON: a 200 without usage must not fail the call because of a span.
      const usage = out.usage as MessagesResponse['usage'] | undefined;
      span.set('gen_ai.usage.input_tokens', usage?.input_tokens);
      span.set('gen_ai.usage.output_tokens', usage?.output_tokens);
      span.payload('gen_ai.output.messages', [
        {
          role: 'assistant',
          parts: [{ type: 'text', content: AnthropicGateway.text(out) }],
          finish_reason: out.stop_reason ?? 'unknown',
        },
      ]);
      // A refusal or a cut-off answer has no usable text; say so instead of failing later in parsing.
      if (out.stop_reason === 'refusal') throw new ModelOutputError('refusal');
      if (out.stop_reason === 'max_tokens') throw new ModelOutputError('max_tokens');
      return out;
    });
  }

  /** Convenience: the concatenated text blocks of a response (thinking blocks are skipped). */
  static text(res: MessagesResponse): string {
    return res.content
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join('');
  }
}
