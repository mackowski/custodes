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
