import { describe, expect, it, vi } from 'vitest';
import { climb, decided, undecided, verdict, type LadderStep } from '../src/ladder.js';

describe('climb', () => {
  it('stops at the first rung that decides and does not run later rungs', async () => {
    const later = vi.fn(() => decided('late'));
    const steps: LadderStep<string>[] = [
      { rung: 'rule', run: () => undecided({ why: 'x' }) },
      { rung: 'jev', run: () => decided('yes', { p: 0.9 }) },
      { rung: 'llm', run: later },
    ];
    const out = await climb(steps);
    expect(out).toEqual({
      decided: true,
      value: 'yes',
      rung: 'jev',
      trace: [
        { rung: 'rule', outcome: 'undecided', detail: { why: 'x' } },
        { rung: 'jev', outcome: 'decided', detail: { p: 0.9 } },
      ],
    });
    expect(later).not.toHaveBeenCalled();
  });

  it('records a thrown error by class name only and continues up the ladder', async () => {
    class GatewayError extends Error {
      override name = 'GatewayError';
    }
    const out = await climb<string>([
      {
        rung: 'jev',
        run: () => {
          throw new GatewayError('secret provider message');
        },
      },
      { rung: 'llm', run: () => Promise.resolve(decided('ok')) },
    ]);
    expect(out.decided && out.rung).toBe('llm');
    expect(out.trace[0]).toEqual({ rung: 'jev', outcome: 'error', error: 'GatewayError' });
    expect(JSON.stringify(out.trace)).not.toContain('secret');
  });

  it('records rejected promises as errors too', async () => {
    const out = await climb<string>([
      { rung: 'jev', run: () => Promise.reject(new TypeError('x')) },
    ]);
    expect(out.trace[0]).toEqual({ rung: 'jev', outcome: 'error', error: 'TypeError' });
  });

  it('falls back to a generic name for odd characters and long names, and uses typeof for non-errors', async () => {
    const odd = new Error('m');
    odd.name = 'Bad Name <script>';
    const long = new Error('m');
    long.name = 'A'.repeat(61);
    const out = await climb<string>([
      {
        rung: 'rule',
        run: () => {
          throw odd;
        },
      },
      {
        rung: 'rule',
        run: () => {
          throw long;
        },
      },
      {
        rung: 'jev',
        run: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- non-Error throws are the case under test
          throw 'a string with secrets';
        },
      },
    ]);
    expect(out.trace.slice(0, 3).map((t) => t.error)).toEqual(['Error', 'Error', 'string']);
    expect(JSON.stringify(out.trace)).not.toContain('secrets');
  });

  it('hands over to a human when no rung decides', async () => {
    const out = await climb<string>([
      { rung: 'rule', run: () => undecided() },
      {
        rung: 'jev',
        run: () => {
          throw new Error('down');
        },
      },
    ]);
    expect(out.decided).toBe(false);
    expect(out.rung).toBe('human');
    expect(out.trace).toEqual([
      { rung: 'rule', outcome: 'undecided' },
      { rung: 'jev', outcome: 'error', error: 'Error' },
      { rung: 'human', outcome: 'undecided' },
    ]);
  });

  it('hands over to a human when there are no steps', async () => {
    expect(await climb([])).toEqual({
      decided: false,
      rung: 'human',
      trace: [{ rung: 'human', outcome: 'undecided' }],
    });
  });
});

describe('verdict', () => {
  const band = { yes: 0.85, no: 0.15 };
  it('maps probabilities to yes, no and unsure, inclusive at the edges', () => {
    expect(verdict(0.85, band)).toBe('yes');
    expect(verdict(1, band)).toBe('yes');
    expect(verdict(0.15, band)).toBe('no');
    expect(verdict(0, band)).toBe('no');
    expect(verdict(0.5, band)).toBe('unsure');
    expect(verdict(0.8499, band)).toBe('unsure');
  });
  it('treats NaN as unsure', () => {
    expect(verdict(Number.NaN, band)).toBe('unsure');
  });
  it('throws on an invalid band', () => {
    expect(() => verdict(0.5, { yes: 0.2, no: 0.8 })).toThrow(RangeError);
    expect(() => verdict(0.5, { yes: 0.5, no: 0.5 })).toThrow(RangeError);
  });
});
