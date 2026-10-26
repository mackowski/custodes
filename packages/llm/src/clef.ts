/**
 * Cloudflare Clef on Workers AI (ADR 0015): a decision model with Jev's API (typed questions,
 * answers with probabilities, no free text), reached through the Worker's `AI` binding.
 *
 * Every call names an AI Gateway, and there is no way to call it without one: all agent model
 * traffic goes through one gateway (ADR 0015). The state is the same enveloped `JevState` that Jev
 * gets, so both models see byte-identical input.
 */
import { z } from 'zod';
import {
  JevAnswer,
  JevOutputError,
  type JevQuestion,
  type JevResult,
  type JevState,
} from './jev.js';

/** The slice of the Workers AI binding this client uses. */
export interface AiRunner {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: {
      gateway: { id: string; metadata?: Record<string, string> };
      signal?: AbortSignal;
    },
  ): Promise<unknown>;
}

export interface ClefConfig {
  ai: AiRunner;
  /** AI Gateway id. Required: a blank id throws, so a call can never skip the gateway. */
  gatewayId: string;
  /** Default 10 s; a shadow call must never hold up the decision for long. */
  timeoutMs?: number;
}

/** Workers AI model id, and the `model` selector its input schema requires. */
const SELECTOR: Record<string, string> = {
  '@cf/cloudflare/clef': 'clef',
  '@cf/cloudflare/clef-flash': 'clef-flash',
};

export const ClefResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), JevAnswer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export interface ClefRequest<Q extends Record<string, JevQuestion>> {
  /** `@cf/cloudflare/clef` or `@cf/cloudflare/clef-flash`. */
  model: string;
  state: JevState;
  questions: Q;
  metadata: { agentId: string; runId: string };
}

export type ClefResult<Q extends Record<string, JevQuestion>> = Omit<JevResult<Q>, 'id'>;

/** The call did not answer within `timeoutMs`. */
export class ClefTimeoutError extends Error {
  constructor() {
    super('clef timed out');
    this.name = 'ClefTimeoutError';
  }
}

export class ClefClient {
  private readonly timeoutMs: number;

  constructor(private readonly cfg: ClefConfig) {
    if (!cfg.gatewayId.trim()) throw new Error('ClefClient needs an AI Gateway id');
    this.timeoutMs = cfg.timeoutMs ?? 10_000;
  }

  async decide<Q extends Record<string, JevQuestion>>(req: ClefRequest<Q>): Promise<ClefResult<Q>> {
    const selector = SELECTOR[req.model];
    if (!selector) throw new Error(`not a Clef model: ${req.model}`);
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ac.abort();
        reject(new ClefTimeoutError());
      }, this.timeoutMs);
    });
    let raw: unknown;
    try {
      raw = await Promise.race([
        this.cfg.ai.run(
          req.model,
          { model: selector, state: req.state, questions: req.questions },
          {
            gateway: { id: this.cfg.gatewayId, metadata: { ...req.metadata } },
            signal: ac.signal,
          },
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
    const parsed = ClefResponse.safeParse(raw);
    if (!parsed.success) throw new JevOutputError('(response)');
    for (const [name, q] of Object.entries(req.questions)) {
      if (parsed.data.answers[name]?.type !== q.type) throw new JevOutputError(name);
    }
    return parsed.data as ClefResult<Q>;
  }
}
