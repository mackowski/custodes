import { describe, expect, it, vi } from 'vitest';
import {
  AnthropicGateway,
  byokAliasesOf,
  GatewayError,
  ModelOutputError,
  type MessagesRequest,
} from '../src/gateway.js';

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

describe('AnthropicGateway request and error handling', () => {
  const ok = (over: Record<string, unknown> = {}) =>
    Response.json({
      id: 'm',
      model: 'x',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      ...over,
    });
  const req: MessagesRequest = {
    model: 'claude-sonnet-5',
    system: 's',
    messages: [],
    max_tokens: 10,
    metadata: { agentId: 'triage', runId: 'r' },
  };
  const gw = (fetchImpl: typeof fetch) =>
    new AnthropicGateway({ accountId: 'a', gatewayId: 'g', gatewayToken: 't', fetchImpl });

  it('never sends sampling parameters and forwards thinking control', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) => Promise.resolve(ok()));
    await gw(fetchImpl).messages({ ...req, thinking: { type: 'disabled' } });
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
    expect(body['thinking']).toEqual({ type: 'disabled' });
  });

  it('reports HTTP status and provider error type, but keeps the message out of the type field', async () => {
    const body = JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: '`temperature` is deprecated for this model.',
      },
    });
    const err = await gw(() => Promise.resolve(new Response(body, { status: 400 })))
      .messages(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err).toMatchObject({ status: 400, errorType: 'invalid_request_error' });
  });

  it('surfaces refusals and truncation as ModelOutputError', async () => {
    for (const reason of ['refusal', 'max_tokens'] as const) {
      const err = await gw(() => Promise.resolve(ok({ stop_reason: reason, content: [] })))
        .messages(req)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ModelOutputError);
      expect(err).toMatchObject({ reason });
    }
  });

  it('text() skips thinking blocks', () => {
    const res = {
      id: 'm',
      model: 'x',
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: '{"a":1}' },
      ],
    };
    expect(AnthropicGateway.text(res)).toBe('{"a":1}');
  });
});

/** AI Gateway's answer when the provider has no key with the requested (or default) alias. */
const aliasMissing = (asked: string, aliases: string[]) =>
  Response.json(
    {
      success: false,
      result: [],
      messages: [],
      error: [{ code: 2040, message: 'x' }],
      name: 'AiGatewayError',
      httpCode: 400,
      internalCode: 2040,
      message: `Provider 'anthropic' has no BYOK credential named '${asked}'. Configured aliases: ${aliases.map((a) => `'${a}'`).join(', ')}`,
    },
    { status: 400 },
  );
const answer = () =>
  Response.json({
    id: 'm',
    model: 'x',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
const request = {
  model: 'claude-sonnet-5',
  system: 's',
  messages: [{ role: 'user' as const, content: 'u' }],
  max_tokens: 10,
  metadata: { agentId: 'triage', runId: 'r' },
};
const aliasOf = (init: RequestInit | undefined) =>
  (init?.headers as Record<string, string>)['cf-aig-byok-alias'];

describe('byokAliasesOf', () => {
  it('reads the configured aliases from the 2040 error only', async () => {
    expect(byokAliasesOf(await aliasMissing('default', ['cf-custodes-2']).text())).toEqual([
      'cf-custodes-2',
    ]);
    expect(byokAliasesOf(await aliasMissing('default', ['a', 'b_2']).text())).toEqual(['a', 'b_2']);
    expect(byokAliasesOf('{"error":{"type":"rate_limit_error"}}')).toBeUndefined();
    expect(byokAliasesOf('not json')).toBeUndefined();
  });

  it('never returns a malformed alias name', async () => {
    expect(
      byokAliasesOf(await aliasMissing('default', ['ok', 'x\r\nset-cookie: a']).text()),
    ).toEqual([]);
  });
});

describe('AnthropicGateway BYOK alias discovery', () => {
  // Each test uses its own gateway id: discovered aliases are remembered per gateway URL.
  const gateway = (gatewayId: string, fetchImpl: typeof fetch) =>
    new AnthropicGateway({ accountId: 'acc', gatewayId, gatewayToken: 'tok', fetchImpl });

  it('sends no alias while the default key works', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) => Promise.resolve(answer()));
    await gateway('g-default', fetchImpl).messages(request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(aliasOf(fetchImpl.mock.calls[0]?.[1])).toBeUndefined();
  });

  it('uses the only configured alias, and remembers it for later calls', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, i?: RequestInit) =>
      Promise.resolve(
        aliasOf(i) === 'cf-custodes-2' ? answer() : aliasMissing('default', ['cf-custodes-2']),
      ),
    );
    const gw = gateway('g-one', fetchImpl);
    expect(AnthropicGateway.text(await gw.messages(request))).toBe('ok');
    await gw.messages(request);
    expect(fetchImpl.mock.calls.map((c) => aliasOf(c[1]))).toEqual([
      undefined,
      'cf-custodes-2',
      'cf-custodes-2',
    ]);
  });

  it('finds the key again after it is renamed', async () => {
    let current = 'old';
    const fetchImpl = vi.fn((_u: RequestInfo | URL, i?: RequestInit) =>
      Promise.resolve(
        aliasOf(i) === current ? answer() : aliasMissing(aliasOf(i) ?? 'default', [current]),
      ),
    );
    const gw = gateway('g-rename', fetchImpl);
    await gw.messages(request);
    current = 'new';
    await gw.messages(request);
    expect(fetchImpl.mock.calls.map((c) => aliasOf(c[1]))).toEqual([
      undefined,
      'old',
      'old',
      'new',
    ]);
  });

  it('does not guess between several keys', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) =>
      Promise.resolve(aliasMissing('default', ['prod', 'testing'])),
    );
    const err = await gateway('g-many', fetchImpl)
      .messages(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).errorType).toBe('byok_alias_missing');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry other errors', async () => {
    const fetchImpl = vi.fn((_u: RequestInfo | URL, _i?: RequestInit) =>
      Promise.resolve(
        Response.json({ error: { type: 'rate_limit_error', message: 'm' } }, { status: 429 }),
      ),
    );
    const err = await gateway('g-429', fetchImpl)
      .messages(request)
      .catch((e: unknown) => e);
    expect((err as GatewayError).errorType).toBe('rate_limit_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
