// Property-based (fuzz) tests: random and hostile inputs against the invariants the agents rely on.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseStructured, StructuredOutputError } from '../src/structured.js';
import { clip, inertText, untrusted } from '../src/untrusted.js';

/** Fragments that matter to these parsers, mixed with arbitrary Unicode. */
const hostile = fc.oneof(
  fc
    .array(
      fc.constantFrom(
        '<',
        '>',
        '/',
        ' ',
        '\n',
        '\t',
        'untrusted',
        'UNTRUSTED',
        '</untrusted>',
        '\u0000',
        '‮',
        '​',
        '```',
        'json',
        '{',
        '}',
        '"',
        '\\',
        'a',
      ),
      { maxLength: 80 },
    )
    .map((parts) => parts.join('')),
  fc.string({ unit: 'binary', maxLength: 400 }),
);

const INVISIBLE = /[\p{Cc}\p{Cf}]/u;

describe('untrusted() properties', () => {
  it('always yields exactly one envelope, whatever the content', () => {
    fc.assert(
      fc.property(hostile, hostile, (source, content) => {
        const out = untrusted(source, content);
        expect(out.match(/<[\s/]*untrusted/gi)).toHaveLength(2);
        expect(out.match(/<\/untrusted>/gi)).toHaveLength(1);
        expect(out.endsWith('\n</untrusted>')).toBe(true);
        expect(out).not.toContain('\u0000');
      }),
      { numRuns: 2000 },
    );
  });
});

describe('inertText() and clip() properties', () => {
  it('inertText leaves one bounded line without hidden characters', () => {
    fc.assert(
      fc.property(hostile, fc.integer({ min: 0, max: 300 }), (s, max) => {
        const out = inertText(s, max);
        expect(out.length).toBeLessThanOrEqual(max);
        expect(INVISIBLE.test(out)).toBe(false);
        expect(out).not.toMatch(/\s{2}/);
      }),
    );
  });

  it('clip keeps short input unchanged and bounds long input', () => {
    fc.assert(
      fc.property(hostile, fc.integer({ min: 0, max: 300 }), (s, max) => {
        const out = clip(s, max);
        if (s.length <= max) expect(out).toBe(s);
        else expect(out.startsWith(s.slice(0, max))).toBe(true);
      }),
    );
  });
});

describe('parseStructured() properties', () => {
  const schema = z.object({ labels: z.array(z.string()).max(3), confidence: z.number() });
  const value = fc.record({
    labels: fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }),
    confidence: fc.double({ noNaN: true, noDefaultInfinity: true }),
  });
  const prose = fc.string({ maxLength: 60 }).filter((s) => !/[{}`]/.test(s));

  it('recovers a valid object wrapped in prose or a fence', () => {
    fc.assert(
      fc.property(value, prose, fc.boolean(), (v, before, fenced) => {
        const json = JSON.stringify(v);
        const text = fenced ? `${before}\n\`\`\`json\n${json}\n\`\`\`` : `${before} ${json}`;
        expect(parseStructured(schema, text)).toEqual(JSON.parse(json));
      }),
    );
  });

  it('either returns schema-valid data or throws StructuredOutputError, never anything else', () => {
    fc.assert(
      fc.property(hostile, (text) => {
        try {
          expect(schema.safeParse(parseStructured(schema, text)).success).toBe(true);
        } catch (err) {
          expect(err).toBeInstanceOf(StructuredOutputError);
        }
      }),
    );
  });
});
