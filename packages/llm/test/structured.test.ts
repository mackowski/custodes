import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseStructured, StructuredOutputError } from '../src/structured.js';

const schema = z.object({
  labels: z.array(z.string()).max(3),
  confidence: z.number().min(0).max(1),
});

describe('parseStructured', () => {
  it('parses fenced and bare JSON', () => {
    expect(
      parseStructured(schema, 'Here:\n```json\n{"labels":["bug"],"confidence":0.9}\n```'),
    ).toEqual({ labels: ['bug'], confidence: 0.9 });
    expect(parseStructured(schema, 'x {"labels":[],"confidence":0.1} y {"other":1}')).toEqual({
      labels: [],
      confidence: 0.1,
    });
  });
  it('rejects schema violations and non-JSON', () => {
    expect(() => parseStructured(schema, '{"labels":["a","b","c","d"],"confidence":2}')).toThrow(
      StructuredOutputError,
    );
    expect(() => parseStructured(schema, 'no json here')).toThrow(/no JSON/);
  });
});

// Regression for CodeQL js/polynomial-redos: hostile input must stay linear.
const fast = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('parseStructured (hostile input)', () => {
  it('reads fenced, json-fenced and bare objects', () => {
    const ok = '{"labels": [], "confidence": 0.5}';
    expect(parseStructured(schema, '```json\n' + ok + '\n```')).toEqual({
      labels: [],
      confidence: 0.5,
    });
    expect(parseStructured(schema, '```' + ok + '```')).toEqual({ labels: [], confidence: 0.5 });
    expect(parseStructured(schema, 'Sure: ' + ok)).toEqual({ labels: [], confidence: 0.5 });
  });

  it('is linear on an unterminated fence with many spaces', () => {
    expect(
      fast(() => {
        try {
          parseStructured(schema, '```' + ' '.repeat(100_000));
        } catch {
          // expected: no object
        }
      }),
    ).toBeLessThan(200);
  });
});
