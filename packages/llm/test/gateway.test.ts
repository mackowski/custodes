import { describe, expect, it, vi } from 'vitest';
import { AnthropicGateway } from '../src/gateway.js';

describe('AnthropicGateway', () => {
  it('authenticates to the gateway, sends no provider key, and forbids Unified Billing fallback', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) =>
      Promise.resolve(
        Response.json({
          id: 'm',
          model: 'x',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
    );
    const gw = new AnthropicGateway({
      accountId: 'acc',
      gatewayId: 'custodes',
      gatewayToken: 'tok',
      fetchImpl,
    });
    const res = await gw.messages({
      model: 'claude-sonnet-5',
      system: 's',
      messages: [{ role: 'user', content: 'u' }],
      max_tokens: 10,
      metadata: { agentId: 'triage', runId: 'r' },
    });
    expect(AnthropicGateway.text(res)).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/acc/custodes/anthropic/v1/messages');
    const h = init?.headers as Record<string, string>;
    expect(h['cf-aig-authorization']).toBe('Bearer tok');
    expect(h['cf-aig-no-wholesale']).toBe('true');
    expect(h['x-api-key']).toBeUndefined();
    expect(JSON.parse(init?.body as string)).not.toHaveProperty('metadata');
  });
});

describe('AnthropicGateway default fetch', () => {
  it('calls the global fetch unbound (a bound call throws "Illegal invocation" in Workers)', async () => {
    let receiver: unknown = 'not called';
    vi.stubGlobal('fetch', function (this: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- the receiver is what this test inspects
      receiver = this;
      return Promise.resolve(
        Response.json({
          id: 'm',
          model: 'x',
          stop_reason: null,
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        }),
      );
    });
    try {
      const gw = new AnthropicGateway({ accountId: 'a', gatewayId: 'g', gatewayToken: 't' });
      await gw.messages({
        model: 'm',
        system: 's',
        messages: [],
        max_tokens: 1,
        metadata: { agentId: 'x', runId: 'r' },
      });
      expect(receiver).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
