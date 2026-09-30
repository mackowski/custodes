/**
 * Anthropic Messages API through Cloudflare AI Gateway.
 *
 * - BYOK: the Anthropic key lives in AI Gateway, not in the Worker. We only send the gateway
 *   token (`cf-aig-authorization`).
 * - Every request carries `cf-aig-metadata` (agentId, runId) for attribution and spend limits.
 * - Guardrails / DLP are configured on the gateway itself (see infra/terraform/modules/ai-gateway).
 */
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

export class AnthropicGateway {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GatewayConfig) {
    this.url = `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayId}/anthropic/v1/messages`;
    // Never store the global fetch as a method: calling it with `this` bound throws
    // "Illegal invocation" in Workers. Wrap it in a function instead.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async messages(req: MessagesRequest): Promise<MessagesResponse> {
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
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new GatewayError(res.status, text.slice(0, 500), errorTypeOf(text));
    }
    const out = await res.json<MessagesResponse>();
    // A refusal or a cut-off answer has no usable text; say so instead of failing later in parsing.
    if (out.stop_reason === 'refusal') throw new ModelOutputError('refusal');
    if (out.stop_reason === 'max_tokens') throw new ModelOutputError('max_tokens');
    return out;
  }

  /** Convenience: the concatenated text blocks of a response (thinking blocks are skipped). */
  static text(res: MessagesResponse): string {
    return res.content
      .map((c) => (c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join('');
  }
}
