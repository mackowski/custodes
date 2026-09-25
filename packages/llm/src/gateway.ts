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

export interface MessagesRequest {
  model: string;
  system: string;
  messages: MessageParam[];
  max_tokens: number;
  temperature?: number;
  metadata: { agentId: string; runId: string; [k: string]: string };
}

export interface MessagesResponse {
  id: string;
  model: string;
  stop_reason: string | null;
  content: { type: 'text'; text: string }[];
  usage: { input_tokens: number; output_tokens: number };
}

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`AI Gateway ${status}: ${detail}`);
    this.name = 'GatewayError';
  }
}

export class AnthropicGateway {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GatewayConfig) {
    this.url = `https://gateway.ai.cloudflare.com/v1/${cfg.accountId}/${cfg.gatewayId}/anthropic/v1/messages`;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async messages(req: MessagesRequest): Promise<MessagesResponse> {
    const { metadata, ...body } = req;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'cf-aig-authorization': `Bearer ${this.cfg.gatewayToken}`,
      'cf-aig-metadata': JSON.stringify(metadata),
    };
    if (this.cfg.anthropicApiKey) headers['x-api-key'] = this.cfg.anthropicApiKey;
    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new GatewayError(res.status, (await res.text()).slice(0, 500));
    return res.json<MessagesResponse>();
  }

  /** Convenience: the concatenated text of a response. */
  static text(res: MessagesResponse): string {
    return res.content.map((c) => c.text).join('');
  }
}
