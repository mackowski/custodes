import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClefClient, ClefTimeoutError, type AiRunner } from '../src/clef.js';
import { JevOutputError, jevState, type JevQuestion } from '../src/jev.js';

const questions = {
  minor: { type: 'noul', instructions: 'q', criteria: { true: 'a', false: 'b' } },
  kind: { type: 'choice', instructions: 'q', criteria: { typo: 'a', other: 'b' } },
} as const satisfies Record<string, JevQuestion>;

const goodBody = {
  model: 'clef',
  answers: {
    minor: { type: 'noul', noul: 0.8 },
    kind: { type: 'choice', choice: 'typo', confidence: 0.7, probabilities: { typo: 0.7 } },
  },
  usage: { input_tokens: 5, output_tokens: 0 },
};

const req = {
  model: '@cf/cloudflare/clef',
  state: jevState('pr-diff', 'diff'),
  questions,
  metadata: { agentId: 'pr-gate', runId: 'run-1' },
};

const runner = (out: unknown) => {
  const run = vi.fn<AiRunner['run']>(() => Promise.resolve(out));
  return { ai: { run }, run };
};

describe('ClefClient', () => {
  it('runs the model through the named gateway with the Jev-shaped input', async () => {
    const { ai, run } = runner(goodBody);
    const res = await new ClefClient({ ai, gatewayId: 'custodes' }).decide(req);
    expect(res.answers.minor.noul).toBe(0.8);
    expect(res.answers.kind.choice).toBe('typo');
    const [model, inputs, options] = run.mock.calls[0] ?? [];
    expect(model).toBe('@cf/cloudflare/clef');
    expect(inputs).toEqual({ model: 'clef', state: req.state, questions });
    expect(options?.gateway).toEqual({
      id: 'custodes',
      metadata: { agentId: 'pr-gate', runId: 'run-1' },
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('refuses to exist without a gateway', () => {
    const { ai } = runner(goodBody);
    expect(() => new ClefClient({ ai, gatewayId: '' })).toThrow(/Gateway/);
    expect(() => new ClefClient({ ai, gatewayId: '  ' })).toThrow(/Gateway/);
  });

  it('refuses a model that is not Clef', async () => {
    const { ai, run } = runner(goodBody);
    await expect(
      new ClefClient({ ai, gatewayId: 'custodes' }).decide({ ...req, model: 'typesafe/jev-1.14' }),
    ).rejects.toThrow(/not a Clef model/);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a missing or mistyped answer', async () => {
    const mistyped = {
      ...goodBody,
      answers: { ...goodBody.answers, minor: goodBody.answers.kind },
    };
    for (const body of [{ model: 'clef' }, mistyped]) {
      const { ai } = runner(body);
      await expect(new ClefClient({ ai, gatewayId: 'custodes' }).decide(req)).rejects.toThrow(
        JevOutputError,
      );
    }
  });

  it('gives up after the timeout and aborts the call', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const run = vi.fn<AiRunner['run']>((_m, _i, o) => {
        signal = o.signal;
        return new Promise(() => undefined);
      });
      const p = new ClefClient({ ai: { run }, gatewayId: 'custodes', timeoutMs: 50 }).decide(req);
      const done = expect(p).rejects.toThrow(ClefTimeoutError);
      await vi.advanceTimersByTimeAsync(50);
      await done;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('one AI Gateway (ADR 0015)', () => {
  it('reaches no model endpoint outside AI Gateway except Jev direct', () => {
    // Every https URL in the model adapters must be the gateway, except JevClient's direct
    // fallback (ADR 0011). A new provider that calls out directly fails here.
    const dir = join(import.meta.dirname, '../src');
    const outside: string[] = [];
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' });
    for (const f of files.filter((n) => n.endsWith('.ts'))) {
      for (const url of readFileSync(join(dir, f), 'utf8').match(/https?:\/\/[^\s'"`]+/g) ?? []) {
        if (url.startsWith('https://gateway.ai.cloudflare.com/')) continue;
        outside.push(`${f}: ${url}`);
      }
    }
    expect(outside).toEqual(['jev.ts: https://openrouter.ai/api/alpha/decisions']);
  });
});
