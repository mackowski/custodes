/* eslint-disable @typescript-eslint/require-await -- span callbacks are async by contract */
import { describe, expect, it } from 'vitest';
import {
  chat,
  conversationOf,
  errorType,
  executeTool,
  invokeAgent,
  type Turn,
} from '../src/tracing.js';
import { IDENTITY, RecordingTracer, turnOf } from './helpers/recording-tracer.js';

class StatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errorType?: string,
  ) {
    super(message);
    this.name = 'StatusError';
  }
}

describe('errorType', () => {
  it('uses class, status and provider type, never the message', () => {
    expect(errorType(new StatusError(500, 'SECRET-BODY', 'api_error'))).toBe(
      'StatusError 500 api_error',
    );
    expect(errorType(new StatusError(500, 'SECRET-BODY'))).toBe('StatusError 500');
  });

  it('reads a reason for model output errors', () => {
    const e = Object.assign(new Error('SECRET'), { name: 'ModelOutputError', reason: 'refusal' });
    expect(errorType(e)).toBe('ModelOutputError refusal');
  });

  it('drops parts that are not low-cardinality identifiers', () => {
    const e = Object.assign(new Error('x'), { name: 'Bad Name!', errorType: 'a b c' });
    expect(errorType(e)).toBe('error');
    const long = Object.assign(new Error('x'), { errorType: 'x'.repeat(61) });
    expect(errorType(long)).toBe('Error');
  });

  it('does not describe non-errors', () => {
    expect(errorType('SECRET-BODY')).toBe('error');
    expect(errorType({ status: 500 })).toBe('error');
  });
});

describe('conversationOf', () => {
  it('joins repo and number', () => {
    expect(conversationOf('OWASP/CheatSheetSeries', 7)).toBe('OWASP/CheatSheetSeries#7');
  });
});

describe('invokeAgent, chat, executeTool', () => {
  it('nests chat and tool spans under invoke_agent and gives each the identity', async () => {
    const t = new RecordingTracer();
    const turn = turnOf(t, false);
    await invokeAgent(turn, async () => {
      await chat(turn, { provider: 'anthropic', model: 'm' }, async () => 1);
      await executeTool(turn, 'pr.close', async () => 2);
    });
    expect(t.roots).toHaveLength(1);
    const root = t.roots[0]!;
    expect(root.name).toBe('invoke_agent triage');
    expect(root.children.map((c) => c.name)).toEqual(['chat m', 'execute_tool pr.close']);
    for (const s of [root, root.children[0]!]) {
      expect(s.attributes).toMatchObject({
        'gen_ai.agent.name': IDENTITY.agentName,
        'gen_ai.agent.id': IDENTITY.agentId,
        'gen_ai.conversation.id': IDENTITY.conversationId,
        'custodes.run_id': IDENTITY.runId,
      });
    }
    expect(root.attributes['gen_ai.operation.name']).toBe('invoke_agent');
    expect(root.children[0]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'm',
    });
    expect(root.children[1]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'pr.close',
    });
  });

  it('creates no spans and still runs without a turn', async () => {
    const t = new RecordingTracer();
    const span = { seen: [] as string[] };
    const r = await invokeAgent(undefined, async (s) => {
      s.set('k', 'v');
      s.payload('p', 'x');
      span.seen.push('a');
      return chat(undefined, { provider: 'p', model: 'm' }, () =>
        executeTool(undefined, 't', async () => 'done'),
      );
    });
    expect(r).toBe('done');
    expect(t.spans).toHaveLength(0);
  });

  it('records error.type and error status only, and rethrows the same error', async () => {
    const t = new RecordingTracer();
    const err = new StatusError(500, 'SECRET-BODY', 'api_error');
    await expect(
      invokeAgent(turnOf(t, true), async (s) => {
        s.set('custodes.x', 'visible');
        throw err;
      }),
    ).rejects.toBe(err);
    const span = t.spans[0]!;
    expect(span.status).toBe('error');
    expect(span.attributes['error.type']).toBe('StatusError 500 api_error');
    expect(t.allValues().join('|')).not.toContain('SECRET-BODY');
  });

  it('marks the child and the parent as failed when the error propagates', async () => {
    const t = new RecordingTracer();
    const turn = turnOf(t, false);
    await expect(
      invokeAgent(turn, () =>
        chat(turn, { provider: 'p', model: 'm' }, async () => {
          throw new StatusError(429, 'SECRET');
        }),
      ),
    ).rejects.toThrow('SECRET');
    expect(t.spans.map((s) => [s.name, s.status])).toEqual([
      ['invoke_agent triage', 'error'],
      ['chat m', 'error'],
    ]);
  });

  it('skips undefined metadata values', async () => {
    const t = new RecordingTracer();
    await invokeAgent(turnOf(t, false), async (s) => {
      s.set('a', undefined);
      s.set('b', 0);
      s.set('c', false);
    });
    expect(t.spans[0]!.attributes).toMatchObject({ b: 0, c: false });
    expect('a' in t.spans[0]!.attributes).toBe(false);
  });

  describe('payloads', () => {
    it('are dropped when the turn does not allow them', async () => {
      const t = new RecordingTracer();
      await invokeAgent(turnOf(t, false), async (s) => {
        s.payload('gen_ai.input.messages', [{ role: 'user' }]);
      });
      expect('gen_ai.input.messages' in t.spans[0]!.attributes).toBe(false);
    });

    it('are recorded as strings, or JSON for other values, when allowed', async () => {
      const t = new RecordingTracer();
      await invokeAgent(turnOf(t, true), async (s) => {
        s.payload('s', 'plain');
        s.payload('o', { a: [1] });
      });
      expect(t.spans[0]!.attributes['s']).toBe('plain');
      expect(t.spans[0]!.attributes['o']).toBe('{"a":[1]}');
    });
  });

  describe('fail-safety', () => {
    it('ignores a span whose setAttribute and setStatus throw, on success', async () => {
      const t = new RecordingTracer({ attribute: true, status: true });
      const turn = turnOf(t, true);
      const r = await invokeAgent(turn, async (s) => {
        s.set('k', 'v');
        s.payload('p', { a: 1 });
        return chat(turn, { provider: 'p', model: 'm' }, async () => 'result');
      });
      expect(r).toBe('result');
    });

    it('rethrows the original error when the span cannot record it', async () => {
      const t = new RecordingTracer({ attribute: true, status: true });
      const err = new StatusError(500, 'original');
      await expect(
        invokeAgent(turnOf(t, true), async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    });

    it('ignores a span that lacks the methods entirely', async () => {
      const turn: Turn = {
        identity: IDENTITY,
        payloads: true,
        tracer: { enterSpan: (_n, cb) => cb({} as never) },
      };
      const err = new Error('original');
      expect(await invokeAgent(turn, async (s) => (s.set('a', 'b'), 5))).toBe(5);
      await expect(
        invokeAgent(turn, async () => {
          throw err;
        }),
      ).rejects.toBe(err);
    });
  });
});

describe('the tracer itself', () => {
  it('runs the work untraced when enterSpan throws before its callback', async () => {
    const broken = {
      enterSpan: () => {
        throw new Error('no tracing here');
      },
    };
    let runs = 0;
    const out = await invokeAgent(turnOf(broken, true), async (span) => {
      span.set('a', 1);
      return ++runs;
    });
    expect(out).toBe(1);
    expect(runs).toBe(1);
  });

  it('never runs the work twice when the tracer fails after its callback', async () => {
    let runs = 0;
    const late = {
      enterSpan: <T>(_n: string, cb: (s: never) => T): T => {
        void cb({ setAttribute: () => undefined, setStatus: () => undefined } as never);
        throw new Error('late failure');
      },
    };
    await expect(invokeAgent(turnOf(late, false), async () => ++runs)).rejects.toThrow(
      'late failure',
    );
    expect(runs).toBe(1);
  });

  it('never lets an error cross enterSpan, so the runtime cannot record its message', async () => {
    const settled: unknown[] = [];
    const watching = {
      enterSpan: <T>(_n: string, cb: (s: never) => T): T => {
        const r = cb({ setAttribute: () => undefined, setStatus: () => undefined } as never);
        // The runtime would record a rejection here; the callback must resolve instead.
        void Promise.resolve(r).then(
          (v) => settled.push(v),
          () => settled.push('REJECTED'),
        );
        return r;
      },
    };
    const err = new StatusError(500, 'SECRET-BODY');
    await expect(
      invokeAgent(turnOf(watching, false), async () => Promise.reject(err)),
    ).rejects.toBe(err);
    expect(settled).not.toContain('REJECTED');
    expect(JSON.stringify(settled)).not.toContain('SECRET-BODY');
  });
});
