import { describe, expect, it, vi } from 'vitest';
import { GatewayError, ModelOutputError, type MessagesRequest } from '../src/gateway.js';
import {
  fromChatCompletion,
  isProviderOutage,
  OpenRouterMessages,
  toChatCompletions,
  withFallback,
} from '../src/openrouter-messages.js';

const req: MessagesRequest = {
  model: 'claude-sonnet-5-5',
  system: 'You review issues.',
  max_tokens: 1000,
  metadata: { agentId: 'backlog-review', runId: 'r1' },
  tools: [{ name: 'issue', description: 'Read one issue.', input_schema: { type: 'object' } }],
  messages: [
    { role: 'user', content: 'Assess issue #7.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 't1', name: 'issue', input: { repo: 'o/r', number: 7 } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: '<untrusted>…</untrusted>' }],
    },
  ],
};

describe('toChatCompletions', () => {
  it('maps system, tool calls, tool results and tools to Chat Completions', () => {
    const { messages, tools } = toChatCompletions(req);
    expect(messages).toEqual([
      { role: 'system', content: 'You review issues.' },
      { role: 'user', content: 'Assess issue #7.' },
      {
        role: 'assistant',
        content: 'Reading it.',
        tool_calls: [
          {
            id: 't1',
            type: 'function',
            function: { name: 'issue', arguments: '{"repo":"o/r","number":7}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: '<untrusted>…</untrusted>' },
    ]);
    expect(tools).toEqual([
      {
        type: 'function',
        function: { name: 'issue', description: 'Read one issue.', parameters: { type: 'object' } },
      },
    ]);
  });
});

describe('fromChatCompletion', () => {
  const usage = { prompt_tokens: 100, completion_tokens: 20 };

  it('maps tool calls to tool_use blocks and names the model asked for', () => {
    const r = fromChatCompletion(
      {
        id: 'c1',
        model: 'openai/gpt-6.2-sol-20261101',
        usage,
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{ id: 'x', function: { name: 'issue', arguments: '{"number":7}' } }],
            },
          },
        ],
      },
      'openai/gpt-6.2-sol',
    );
    expect(r).toEqual({
      id: 'c1',
      model: 'openai/gpt-6.2-sol',
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'x', name: 'issue', input: { number: 7 } }],
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  it('gives arguments that are not JSON as null, so the tool schema refuses them', () => {
    const r = fromChatCompletion(
      {
        usage,
        choices: [
          { message: { tool_calls: [{ id: 'x', function: { name: 'issue', arguments: '{' } }] } },
        ],
      },
      'm',
    );
    expect(r.content).toEqual([{ type: 'tool_use', id: 'x', name: 'issue', input: null }]);
  });

  it('turns a cut-off or filtered answer into ModelOutputError with its paid usage', () => {
    for (const [finish, reason] of [
      ['length', 'max_tokens'],
      ['content_filter', 'refusal'],
    ] as const) {
      const run = () =>
        fromChatCompletion({ usage, choices: [{ finish_reason: finish, message: {} }] }, 'm');
      expect(run).toThrow(ModelOutputError);
      try {
        run();
      } catch (e) {
        expect(e).toMatchObject({ reason, usage: { input_tokens: 100, output_tokens: 20 } });
      }
    }
  });

  it('names the answering model on an unusable answer, so it is priced as itself, and reads refusals', () => {
    try {
      fromChatCompletion(
        { usage, choices: [{ finish_reason: 'stop', message: { refusal: 'No.' } }] },
        'openai/gpt-6.2-sol',
      );
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ reason: 'refusal', model: 'openai/gpt-6.2-sol' });
    }
  });

  it('answers end_turn with the text when there is no tool call', () => {
    const r = fromChatCompletion(
      { usage, choices: [{ finish_reason: 'stop', message: { content: '{"proposals":[]}' } }] },
      'm',
    );
    expect(r).toMatchObject({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"proposals":[]}' }],
    });
  });
});

describe('OpenRouterMessages', () => {
  it('posts to the gateway openrouter route with the token, no provider key, and data collection denied', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) =>
      Promise.resolve(
        Response.json({
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      ),
    );
    const m = new OpenRouterMessages({
      accountId: 'a',
      gatewayId: 'g',
      gatewayToken: 'tok',
      fetchImpl,
    });
    await m.messages({ ...req, model: 'openai/gpt-6.2-sol' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/a/g/openrouter/v1/chat/completions');
    const headers = init?.headers as Record<string, string>;
    expect(headers['cf-aig-authorization']).toBe('Bearer tok');
    expect(headers['authorization']).toBeUndefined();
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'openai/gpt-6.2-sol',
      provider: { data_collection: 'deny', require_parameters: true },
      reasoning: { effort: 'medium' },
    });
  });

  it('throws GatewayError on a failed call', async () => {
    const fetchImpl = () =>
      Promise.resolve(new Response('{"error":{"code":429}}', { status: 429 }));
    const m = new OpenRouterMessages({
      accountId: 'a',
      gatewayId: 'g',
      gatewayToken: 't',
      fetchImpl,
    });
    await expect(m.messages(req)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('withFallback', () => {
  const ok = (model: string) => ({
    id: 'r',
    model,
    stop_reason: 'end_turn',
    content: [],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  it('answers with the primary and names the model asked for', async () => {
    const fallback = vi.fn();
    const send = withFallback(
      () => Promise.resolve(ok('claude-sonnet-5-5-20261001')),
      fallback,
      'f',
    );
    expect((await send(req)).model).toBe('claude-sonnet-5-5');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('sends the same request to the fallback model when the primary fails', async () => {
    const seen: string[] = [];
    const onFallback = vi.fn();
    const send = withFallback(
      () => Promise.reject(new GatewayError(400, 'credit balance is too low')),
      (r) => {
        seen.push(r.model);
        return Promise.resolve(ok(r.model));
      },
      'openai/gpt-6.2-sol',
      onFallback,
    );
    expect((await send(req)).model).toBe('openai/gpt-6.2-sol');
    expect(seen).toEqual(['openai/gpt-6.2-sol']);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('falls back only on a provider outage, never on a request the provider refuses', () => {
    expect(isProviderOutage(new GatewayError(529, 'overloaded'))).toBe(true);
    expect(isProviderOutage(new GatewayError(503, 'x'))).toBe(true);
    expect(isProviderOutage(new GatewayError(429, 'x'))).toBe(true);
    expect(isProviderOutage(new GatewayError(400, 'Your credit balance is too low'))).toBe(true);
    expect(isProviderOutage(new Error('network'))).toBe(true);
    // Issue text can make a prompt too long: that must not pick the model.
    expect(
      isProviderOutage(new GatewayError(400, 'prompt is too long', 'invalid_request_error')),
    ).toBe(false);
    expect(isProviderOutage(new GatewayError(401, 'x'))).toBe(false);
    expect(isProviderOutage(new ModelOutputError('refusal'))).toBe(false);
  });

  it('does not fall back on an unusable answer (the model answered)', async () => {
    const fallback = vi.fn();
    const send = withFallback(
      () => Promise.reject(new ModelOutputError('refusal')),
      fallback,
      'openai/gpt-6.2-sol',
    );
    await expect(send(req)).rejects.toBeInstanceOf(ModelOutputError);
    expect(fallback).not.toHaveBeenCalled();
  });
});
