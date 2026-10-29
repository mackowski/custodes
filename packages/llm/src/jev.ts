/**
 * TypeSafe Jev through OpenRouter's Decisions API (`POST /api/alpha/decisions`).
 *
 * Jev answers typed questions about a `state` with probabilities. It writes no text, so its output
 * can never carry instructions; it is still steered by the state, so the state is untrusted input
 * and must be enveloped. Thresholds belong to the caller (see `@custodes/core` ladder).
 *
 * Two transports:
 * - `gateway`: Cloudflare AI Gateway's OpenRouter provider with the key stored in the gateway (BYOK).
 *   We send only the gateway token, never `Authorization`, so the stored key is used.
 * - `direct`: OpenRouter with an API key held by the Worker (ADR 0011 fallback).
 *
 * Inside a turn, each call is a `chat` span (ADR 0016).
 */
import { z } from 'zod';
import { chat, type OperationSpan, type Turn } from '@custodes/core';
import { GatewayError } from './gateway.js';
import { clip, untrusted } from './untrusted.js';

/** Above ~32 KB Jev switches to a slower, less accurate long-context mode; stay below it. */
export const JEV_STATE_MAX_CHARS = 30_000;

export type JevTransport =
  | {
      kind: 'gateway';
      accountId: string;
      gatewayId: string;
      gatewayToken: string;
      /** Path under the gateway's `openrouter` provider that reaches `/api/alpha/decisions`. */
      path?: string;
    }
  | { kind: 'direct'; apiKey: string };

export interface JevConfig {
  transport: JevTransport;
  fetchImpl?: typeof fetch;
}

/** Path under `…/openrouter/` that AI Gateway forwards to OpenRouter's Decisions endpoint. */
export const JEV_GATEWAY_PATH = 'api/alpha/decisions';

declare const untrustedState: unique symbol;
/** A state string that has been enveloped and clipped. Build it with `jevState()` only. */
export type JevState = string & { readonly [untrustedState]: true };

/** Envelopes and clips untrusted text for use as a Jev `state`. */
export function jevState(source: string, content: string): JevState {
  return untrusted(source, clip(content, JEV_STATE_MAX_CHARS)) as JevState;
}

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface JevRequest<Q extends Record<string, JevQuestion>> {
  model: string;
  state: JevState;
  questions: Q;
  metadata: { agentId: string; runId: string };
}

const Probability = z.number().min(0).max(1);

export const JevNoulAnswer = z.object({ type: z.literal('noul'), noul: Probability });
export const JevChoiceAnswer = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: Probability,
  probabilities: z.record(z.string(), Probability),
});
export const JevScoreAnswer = z.object({
  type: z.literal('score'),
  score: z.number(),
  confidence: Probability,
  probabilities: z.record(z.string(), Probability),
  legend: z.record(z.string(), z.string()).optional(),
});
export const JevAnswer = z.discriminatedUnion('type', [
  JevNoulAnswer,
  JevChoiceAnswer,
  JevScoreAnswer,
]);
export type JevAnswer = z.infer<typeof JevAnswer>;

export const JevResponse = z.object({
  id: z.string(),
  model: z.string(),
  answers: z.record(z.string(), JevAnswer),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cost: z.number().optional(),
    })
    .optional(),
});

type AnswerFor<Q extends JevQuestion> = Q['type'] extends 'noul'
  ? z.infer<typeof JevNoulAnswer>
  : Q['type'] extends 'choice'
    ? z.infer<typeof JevChoiceAnswer>
    : z.infer<typeof JevScoreAnswer>;

export interface JevResult<Q extends Record<string, JevQuestion>> {
  id: string;
  model: string;
  answers: { [K in keyof Q]: AnswerFor<Q[K]> };
  usage?: { input_tokens: number; output_tokens: number; cost?: number };
}

/** The response did not answer every question with the type that was asked. */
export class JevOutputError extends Error {
  constructor(readonly question: string) {
    super(`jev answer missing or mistyped: ${question}`);
    this.name = 'JevOutputError';
  }
}

/** OpenRouter's error code, without keeping any message text. */
function openRouterCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const c = (parsed as { error?: { code?: unknown } }).error?.code;
    if (typeof c === 'number') return String(c);
    return typeof c === 'string' && /^[a-z0-9_]{1,60}$/i.test(c) ? c : undefined;
  } catch {
    return undefined;
  }
}

export class JevClient {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: JevConfig) {
    const t = cfg.transport;
    this.url =
      t.kind === 'gateway'
        ? `https://gateway.ai.cloudflare.com/v1/${t.accountId}/${t.gatewayId}/openrouter/${t.path ?? JEV_GATEWAY_PATH}`
        : 'https://openrouter.ai/api/alpha/decisions';
    // Unbound wrapper: a stored global fetch throws "Illegal invocation" in Workers.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async decide<Q extends Record<string, JevQuestion>>(
    req: JevRequest<Q>,
    turn?: Turn,
  ): Promise<JevResult<Q>> {
    const t = this.cfg.transport;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const body: Record<string, unknown> = {
      model: req.model,
      state: req.state,
      questions: req.questions,
    };
    if (t.kind === 'gateway') {
      headers['cf-aig-authorization'] = `Bearer ${t.gatewayToken}`;
      headers['cf-aig-metadata'] = JSON.stringify(req.metadata);
    } else {
      headers['authorization'] = `Bearer ${t.apiKey}`;
      body['trace'] = { trace_id: req.metadata.runId, trace_name: req.metadata.agentId };
    }
    return chat(turn, { provider: 'openrouter', model: req.model }, async (span) => {
      span.payload('gen_ai.input.messages', decisionInput(req));
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new GatewayError(res.status, text.slice(0, 300), openRouterCode(text));
      }
      const parsed = JevResponse.safeParse(await res.json());
      if (!parsed.success) throw new JevOutputError('(response)');
      decisionOutput(span, parsed.data);
      for (const [name, q] of Object.entries(req.questions)) {
        if (parsed.data.answers[name]?.type !== q.type) throw new JevOutputError(name);
      }
      return parsed.data as JevResult<Q>;
    });
  }
}

/** The `gen_ai.input.messages` payload of a Jev or Clef call: the state and the questions. */
export function decisionInput(req: { state: string; questions: Record<string, JevQuestion> }) {
  return [
    {
      role: 'user',
      parts: [
        { type: 'text', content: JSON.stringify({ state: req.state, questions: req.questions }) },
      ],
    },
  ];
}

/** Response attributes of a Jev or Clef call: model, tokens and (as payload) the answers. */
export function decisionOutput(
  span: OperationSpan,
  res: {
    id?: string;
    model: string;
    answers: Record<string, JevAnswer>;
    usage?: { input_tokens: number; output_tokens: number } | undefined;
  },
): void {
  span.set('gen_ai.response.id', res.id);
  span.set('gen_ai.response.model', res.model);
  span.set('gen_ai.usage.input_tokens', res.usage?.input_tokens);
  span.set('gen_ai.usage.output_tokens', res.usage?.output_tokens);
  span.payload('gen_ai.output.messages', [
    {
      role: 'assistant',
      parts: [{ type: 'text', content: JSON.stringify(res.answers) }],
      finish_reason: 'stop',
    },
  ]);
}
