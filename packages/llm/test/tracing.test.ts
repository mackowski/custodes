import { invokeAgent, type Turn } from '@custodes/core';
import { describe, expect, it, vi } from 'vitest';
import { ClefClient, ClefTimeoutError, type AiRunner } from '../src/clef.js';
import {
  AnthropicGateway,
  GatewayError,
  type MessagesRequest,
  type MessagesResponse,
} from '../src/gateway.js';
import { JevClient, jevState, type JevQuestion } from '../src/jev.js';
import { IDENTITY, RecordingTracer, turnOf } from './helpers/recording-tracer.js';

const GW = 'CANARY-GW-7f3a';
const OR = 'CANARY-OR-91bc';
const ANT = 'CANARY-ANT-5d20';
const canaries = [GW, OR, ANT];

const identityKeys = {
  'gen_ai.agent.name': IDENTITY.agentName,
  'gen_ai.agent.id': IDENTITY.agentId,
  'gen_ai.conversation.id': IDENTITY.conversationId,
  'custodes.run_id': IDENTITY.runId,
};
const PAYLOAD_KEYS = [
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
];

const questions = {
  minor: { type: 'noul', instructions: 'q', criteria: { true: 'a', false: 'b' } },
} as const satisfies Record<string, JevQuestion>;

const msgReq: MessagesRequest = {
  model: 'claude-sonnet-5',
  system: 'SYSTEM-TEXT',
  messages: [{ role: 'user', content: 'USER-TEXT' }],
  max_tokens: 99,
  metadata: { agentId: 'triage', runId: 'run-1' },
};
const msgRes = (over: Partial<MessagesResponse> = {}) => ({
  id: 'msg_1',
  model: 'claude-sonnet-5-20260101',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'ANSWER-TEXT' }],
  usage: { input_tokens: 11, output_tokens: 22 },
  ...over,
});
const gateway = (fetchImpl: typeof fetch, withKey = true) =>
  new AnthropicGateway({
    accountId: 'acc',
    gatewayId: 'gw',
    gatewayToken: GW,
    ...(withKey ? { anthropicApiKey: ANT } : {}),
    fetchImpl,
  });
const ok = (body: unknown) =>
  (() => Promise.resolve(Response.json(body))) as unknown as typeof fetch;

const jevReq = {
  model: 'typesafe/jev-1.14',
  state: jevState('pr-diff', 'DIFF-TEXT'),
  questions,
  metadata: { agentId: 'pr-gate', runId: 'run-1' },
};
const jevBody = {
  id: 'd1',
  model: 'typesafe/jev-1.14',
  answers: { minor: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 5, output_tokens: 1 },
};
const clefReq = { ...jevReq, model: '@cf/cloudflare/clef' };
const clefBody = {
  model: 'clef',
  answers: jevBody.answers,
  usage: { input_tokens: 7, output_tokens: 0 },
};
const clef = (run: AiRunner['run']) =>
  new ClefClient({ ai: { run }, gatewayId: 'gw', timeoutMs: 50 });

/** Runs `fn` inside an invoke_agent span of a fresh recording tracer. */
async function inTurn<T>(
  payloads: boolean,
  fn: (turn: Turn) => Promise<T>,
  tracer = new RecordingTracer(),
) {
  const turn = turnOf(tracer, payloads);
  const result = await invokeAgent(turn, () => fn(turn)).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { tracer, result };
}

describe('chat spans', () => {
  it('Anthropic call is a child of invoke_agent with identity, provider, model and usage', async () => {
    const { tracer } = await inTurn(false, (t) => gateway(ok(msgRes())).messages(msgReq, t));
    const root = tracer.roots[0]!;
    expect(root.name).toBe('invoke_agent triage');
    const [span] = root.children;
    expect(span?.name).toBe('chat claude-sonnet-5');
    expect(span?.parent).toBe(root);
    expect(span?.attributes).toMatchObject({
      ...identityKeys,
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-5',
      'gen_ai.request.max_tokens': 99,
      'gen_ai.response.id': 'msg_1',
      'gen_ai.response.model': 'claude-sonnet-5-20260101',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 22,
    });
  });

  it('Jev call (gateway and direct) is a chat span with provider openrouter and usage', async () => {
    for (const transport of [
      { kind: 'gateway', accountId: 'a', gatewayId: 'g', gatewayToken: GW } as const,
      { kind: 'direct', apiKey: OR } as const,
    ]) {
      const { tracer } = await inTurn(false, (t) =>
        new JevClient({ transport, fetchImpl: ok(jevBody) }).decide(jevReq, t),
      );
      const span = tracer.roots[0]!.children[0]!;
      expect(span.parent).toBe(tracer.roots[0]);
      expect(span.attributes).toMatchObject({
        ...identityKeys,
        'gen_ai.provider.name': 'openrouter',
        'gen_ai.request.model': 'typesafe/jev-1.14',
        'gen_ai.response.id': 'd1',
        'gen_ai.usage.input_tokens': 5,
        'gen_ai.usage.output_tokens': 1,
      });
    }
  });

  it('Clef call is a chat span with provider cloudflare.workers_ai and usage', async () => {
    const { tracer } = await inTurn(false, (t) =>
      clef(() => Promise.resolve(clefBody)).decide(clefReq, t),
    );
    const span = tracer.roots[0]!.children[0]!;
    expect(span.parent).toBe(tracer.roots[0]);
    expect(span.attributes).toMatchObject({
      ...identityKeys,
      'gen_ai.provider.name': 'cloudflare.workers_ai',
      'gen_ai.request.model': '@cf/cloudflare/clef',
      'gen_ai.usage.input_tokens': 7,
      'gen_ai.usage.output_tokens': 0,
    });
    expect('gen_ai.response.id' in span.attributes).toBe(false);
  });
});

describe('no turn, no spans', () => {
  it('clients called without a turn create none and still work', async () => {
    const tracer = new RecordingTracer();
    const res = await gateway(ok(msgRes())).messages(msgReq);
    const j = await new JevClient({
      transport: { kind: 'direct', apiKey: OR },
      fetchImpl: ok(jevBody),
    }).decide(jevReq);
    const c = await clef(() => Promise.resolve(clefBody)).decide(clefReq);
    expect(AnthropicGateway.text(res)).toBe('ANSWER-TEXT');
    expect(j.answers.minor.noul).toBe(0.9);
    expect(c.answers.minor.noul).toBe(0.9);
    expect(tracer.spans).toHaveLength(0);
  });
});

describe('payloads', () => {
  // Sequential: the recording tracer nests by awaited callbacks.
  const callAll = async (t: Turn) => {
    await gateway(ok(msgRes())).messages(msgReq, t);
    await new JevClient({
      transport: { kind: 'direct', apiKey: OR },
      fetchImpl: ok(jevBody),
    }).decide(jevReq, t);
    await clef(() => Promise.resolve(clefBody)).decide(clefReq, t);
  };

  it('are absent from every span when payloads are off', async () => {
    const { tracer } = await inTurn(false, callAll);
    expect(tracer.named('chat')).toHaveLength(3);
    for (const s of tracer.spans)
      for (const k of PAYLOAD_KEYS) expect(s.attributes, `${s.name} ${k}`).not.toHaveProperty(k);
    const all = tracer.allValues().join('|');
    for (const text of ['SYSTEM-TEXT', 'USER-TEXT', 'ANSWER-TEXT', 'DIFF-TEXT'])
      expect(all).not.toContain(text);
  });

  it('are JSON in OTel shape (role and parts) when payloads are on', async () => {
    const { tracer } = await inTurn(true, callAll);
    const [anthropic, jev, clefSpan] = tracer
      .named('chat')
      .sort((a, b) => 0 * a.name.length - 0 * b.name.length);
    const parse = (v: unknown) => JSON.parse(v as string) as { role: string; parts: unknown[] }[];

    const aIn = parse(anthropic?.attributes['gen_ai.input.messages']);
    expect(aIn).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'USER-TEXT' }] }]);
    expect(JSON.parse(anthropic?.attributes['gen_ai.system_instructions'] as string)).toEqual([
      { type: 'text', content: 'SYSTEM-TEXT' },
    ]);
    expect(parse(anthropic?.attributes['gen_ai.output.messages'])).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'ANSWER-TEXT' }],
        finish_reason: 'end_turn',
      },
    ]);
    for (const s of [jev, clefSpan]) {
      const input = parse(s?.attributes['gen_ai.input.messages']);
      expect(input[0]?.role).toBe('user');
      expect(JSON.stringify(input[0]?.parts)).toContain('DIFF-TEXT');
      const out = parse(s?.attributes['gen_ai.output.messages']);
      expect(out[0]?.role).toBe('assistant');
      expect(out[0]).toMatchObject({ finish_reason: 'stop' });
    }
  });

  it('never contain a credential, with payloads on', async () => {
    const { tracer } = await inTurn(true, callAll);
    expect(tracer.spans.length).toBeGreaterThan(3);
    const all = tracer.allValues().join('|') + JSON.stringify(tracer.spans.map((s) => s.name));
    for (const c of canaries) expect(all).not.toContain(c);
  });

  it('never contain a credential for the gateway Jev transport either', async () => {
    const { tracer } = await inTurn(true, (t) =>
      new JevClient({
        transport: { kind: 'gateway', accountId: 'a', gatewayId: 'g', gatewayToken: GW },
        fetchImpl: ok(jevBody),
      }).decide(jevReq, t),
    );
    for (const c of canaries) expect(tracer.allValues().join('|')).not.toContain(c);
  });
});

describe('errors', () => {
  const failing = (status: number, body: string) =>
    (() => Promise.resolve(new Response(body, { status }))) as unknown as typeof fetch;

  it('Anthropic GatewayError records class and status, never the body', async () => {
    const body = JSON.stringify({ error: { type: 'api_error', message: 'SECRET-BODY' } });
    const { tracer, result } = await inTurn(true, (t) =>
      gateway(failing(500, body)).messages(msgReq, t),
    );
    expect((result as { error: unknown }).error).toBeInstanceOf(GatewayError);
    const chatSpan = tracer.named('chat')[0]!;
    expect(chatSpan.status).toBe('error');
    expect(chatSpan.attributes['error.type']).toBe('GatewayError 500 api_error');
    expect(tracer.named('invoke_agent')[0]!.status).toBe('error');
    expect(tracer.allValues().join('|')).not.toContain('SECRET-BODY');
  });

  it('plain-text error body is not recorded', async () => {
    const { tracer } = await inTurn(true, (t) =>
      gateway(failing(500, 'SECRET-BODY')).messages(msgReq, t),
    );
    expect(tracer.named('chat')[0]!.attributes['error.type']).toBe('GatewayError 500');
    expect(tracer.allValues().join('|')).not.toContain('SECRET-BODY');
  });

  it('Jev error records class and status only', async () => {
    const { tracer } = await inTurn(true, (t) =>
      new JevClient({
        transport: { kind: 'direct', apiKey: OR },
        fetchImpl: failing(502, 'SECRET-BODY'),
      }).decide(jevReq, t),
    );
    const s = tracer.named('chat')[0]!;
    expect(s.status).toBe('error');
    expect(s.attributes['error.type']).toBe('GatewayError 502');
    expect(tracer.allValues().join('|')).not.toContain('SECRET-BODY');
  });

  it('Clef timeout records ClefTimeoutError only', async () => {
    const { tracer, result } = await inTurn(true, (t) =>
      clef(() => new Promise(() => undefined)).decide(clefReq, t),
    );
    expect((result as { error: unknown }).error).toBeInstanceOf(ClefTimeoutError);
    const s = tracer.named('chat')[0]!;
    expect(s.status).toBe('error');
    expect(s.attributes['error.type']).toBe('ClefTimeoutError');
  });

  it('a refusal keeps usage and records ModelOutputError refusal, with no model text', async () => {
    const { tracer } = await inTurn(true, (t) =>
      gateway(ok(msgRes({ stop_reason: 'refusal', content: [] }))).messages(msgReq, t),
    );
    const s = tracer.named('chat')[0]!;
    expect(s.status).toBe('error');
    expect(s.attributes['error.type']).toBe('ModelOutputError refusal');
    expect(s.attributes['gen_ai.usage.output_tokens']).toBe(22);
  });
});

describe('fail-safe spans', () => {
  it('a throwing setAttribute/setStatus changes neither the result nor the thrown error', async () => {
    const faulty = () => new RecordingTracer({ attribute: true, status: true });
    const okRun = await inTurn(true, (t) => gateway(ok(msgRes())).messages(msgReq, t), faulty());
    expect(AnthropicGateway.text((okRun.result as { value: MessagesResponse }).value)).toBe(
      'ANSWER-TEXT',
    );

    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('SECRET-BODY', { status: 500 })),
    ) as unknown as typeof fetch;
    const bad = await inTurn(true, (t) => gateway(fetchImpl).messages(msgReq, t), faulty());
    const err = (bad.result as { error: GatewayError }).error;
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.status).toBe(500);

    const refused = await inTurn(
      true,
      (t) => gateway(ok(msgRes({ stop_reason: 'refusal' }))).messages(msgReq, t),
      faulty(),
    );
    expect((refused.result as { error: Error }).error.name).toBe('ModelOutputError');
  });
});

describe('response shapes', () => {
  it('returns a response without usage instead of failing on the span, with or without a turn', async () => {
    const res = { ...msgRes() } as Partial<MessagesResponse>;
    delete res.usage;
    const g = gateway(ok(res));
    await expect(g.messages(msgReq)).resolves.toMatchObject({ id: 'msg_1' });
    const tracer = new RecordingTracer();
    await expect(g.messages(msgReq, turnOf(tracer, true))).resolves.toMatchObject({ id: 'msg_1' });
    expect(tracer.named('chat')[0]?.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
  });
});
