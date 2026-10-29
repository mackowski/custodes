import { invokeAgent, invokeSubAgent } from '@custodes/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicChat,
  ChatTimeoutError,
  OpenRouterGateway,
  readCompletion,
  WorkersAiChat,
  type ChatRequest,
} from '../src/chat.js';
import type { AiRunner } from '../src/clef.js';
import { AnthropicGateway, GatewayError, ModelOutputError } from '../src/gateway.js';
import { RecordingTracer, turnOf } from './helpers/recording-tracer.js';

const GW = 'CANARY-GW-c41e';
const req: ChatRequest = {
  model: 'openai/gpt-6.1-sol',
  system: 'SYSTEM-TEXT',
  user: 'USER-TEXT',
  max_tokens: 500,
  schema: { name: 'review', schema: { type: 'object' } },
  metadata: { agentId: 'cheatsheet-review', runId: 'run-1', subAgent: 'judge' },
};
const completion = (over: Record<string, unknown> = {}) => ({
  model: 'openai/gpt-6.1-sol-20261001',
  choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 3 },
  ...over,
});
const openRouter = (fetchImpl: typeof fetch, timeoutMs?: number) =>
  new OpenRouterGateway({
    accountId: 'acc',
    gatewayId: 'gw',
    gatewayToken: GW,
    fetchImpl,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

describe('OpenRouterGateway', () => {
  it('posts an OpenAI-style request to the gateway with BYOK-only headers and the schema', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) =>
      Promise.resolve(Response.json(completion())),
    );
    const out = await openRouter(fetchImpl).complete(req);
    expect(out).toEqual({
      text: '{"ok":true}',
      model: 'openai/gpt-6.1-sol-20261001',
      usage: { input_tokens: 10, output_tokens: 3 },
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://gateway.ai.cloudflare.com/v1/acc/gw/openrouter/v1/chat/completions');
    const headers = init?.headers as Record<string, string>;
    expect(headers['cf-aig-authorization']).toBe(`Bearer ${GW}`);
    expect(headers['cf-aig-no-wholesale']).toBe('true');
    expect(JSON.parse(headers['cf-aig-metadata'] ?? '')).toEqual(req.metadata);
    // The stored key is used: the Worker never sends a provider key.
    expect(headers['authorization']).toBeUndefined();
    expect(JSON.parse(init?.body as string)).toEqual({
      model: 'openai/gpt-6.1-sol',
      messages: [
        { role: 'system', content: 'SYSTEM-TEXT' },
        { role: 'user', content: 'USER-TEXT' },
      ],
      max_tokens: 500,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'review', strict: true, schema: { type: 'object' } },
      },
      provider: { require_parameters: true },
    });
  });

  it('turns HTTP errors into GatewayError with the provider error type', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { type: 'invalid_request_error' } }), { status: 400 }),
      )) as unknown as typeof fetch;
    const p = openRouter(fetchImpl).complete(req);
    await expect(p).rejects.toBeInstanceOf(GatewayError);
    await expect(p).rejects.toMatchObject({ status: 400, errorType: 'invalid_request_error' });
  });

  it('times out instead of hanging', async () => {
    const fetchImpl = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
    await expect(openRouter(fetchImpl, 20).complete(req)).rejects.toBeInstanceOf(ChatTimeoutError);
  });
});

describe('readCompletion', () => {
  it('reports a refusal or a cut-off answer instead of returning partial text', () => {
    expect(() =>
      readCompletion(
        completion({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }),
        'm',
      ),
    ).toThrow(new ModelOutputError('max_tokens'));
    expect(() =>
      readCompletion(
        completion({
          choices: [{ message: { content: '', refusal: 'no' }, finish_reason: 'stop' }],
        }),
        'm',
      ),
    ).toThrow(new ModelOutputError('refusal'));
    expect(() =>
      readCompletion(
        completion({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }),
        'm',
      ),
    ).toThrow(new ModelOutputError('refusal'));
  });

  it('reads the Workers AI `response` shape, string or object, and tolerates missing fields', () => {
    expect(readCompletion({ response: 'hi' }, 'm').out).toEqual({ text: 'hi', model: 'm' });
    expect(readCompletion({ response: { a: 1 } }, 'm').out.text).toBe('{"a":1}');
    expect(
      readCompletion({ response: 'x', usage: { prompt_tokens: 1, completion_tokens: 2 } }, 'm').out
        .usage,
    ).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(readCompletion(null, 'm').out).toEqual({ text: '', model: 'm' });
    expect(readCompletion({ choices: [{}] }, 'm').out.text).toBe('');
  });
});

describe('WorkersAiChat', () => {
  it('always names the gateway, and refuses to be built without one', async () => {
    const run = vi.fn<AiRunner['run']>(() => Promise.resolve(completion()));
    const out = await new WorkersAiChat({ ai: { run }, gatewayId: 'gw' }).complete({
      ...req,
      model: '@cf/deepseek-ai/deepseek-v4-pro-0813',
    });
    expect(out.text).toBe('{"ok":true}');
    const [model, inputs, options] = run.mock.calls[0]!;
    expect(model).toBe('@cf/deepseek-ai/deepseek-v4-pro-0813');
    expect(inputs).toMatchObject({
      max_tokens: 500,
      response_format: { type: 'json_schema', json_schema: { type: 'object' } },
    });
    expect(options.gateway).toEqual({ id: 'gw', metadata: req.metadata });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(() => new WorkersAiChat({ ai: { run }, gatewayId: ' ' })).toThrow(/AI Gateway id/);
  });
});

describe('AnthropicChat', () => {
  it('maps the request onto the Messages API and returns the text', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) =>
      Promise.resolve(
        Response.json({
          id: 'msg_1',
          model: 'claude-opus-5-5-20261001',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ANSWER' }],
          usage: { input_tokens: 4, output_tokens: 5 },
        }),
      ),
    );
    const gw = new AnthropicGateway({
      accountId: 'a',
      gatewayId: 'g',
      gatewayToken: GW,
      fetchImpl,
    });
    const out = await new AnthropicChat(gw).complete({ ...req, model: 'claude-opus-5-5' });
    expect(out).toEqual({
      text: 'ANSWER',
      model: 'claude-opus-5-5-20261001',
      usage: { input_tokens: 4, output_tokens: 5 },
    });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      model: 'claude-opus-5-5',
      system: 'SYSTEM-TEXT',
      messages: [{ role: 'user', content: 'USER-TEXT' }],
      max_tokens: 500,
    });
  });
});

describe('chat spans for review sub-agents', () => {
  it('a sub-agent model call nests under invoke_agent <role>, with payloads only when allowed and no credentials', async () => {
    for (const payloads of [false, true]) {
      const t = new RecordingTracer();
      const turn = turnOf(t, payloads);
      const fetchImpl = (() =>
        Promise.resolve(Response.json(completion()))) as unknown as typeof fetch;
      await invokeAgent(turn, () =>
        invokeSubAgent(turn, 'judge', (sub) => openRouter(fetchImpl).complete(req, sub)),
      );
      const judge = t.roots[0]!.children[0]!;
      expect(judge.name).toBe('invoke_agent judge');
      const [span] = judge.children;
      expect(span?.name).toBe('chat openai/gpt-6.1-sol');
      expect(span?.attributes).toMatchObject({
        'gen_ai.agent.name': 'judge',
        'gen_ai.provider.name': 'openrouter',
        'gen_ai.request.model': 'openai/gpt-6.1-sol',
        'gen_ai.response.model': 'openai/gpt-6.1-sol-20261001',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 3,
      });
      const values = t.allValues().join('|');
      expect(values.includes('USER-TEXT')).toBe(payloads);
      expect(values).not.toContain(GW);
    }
  });
});
