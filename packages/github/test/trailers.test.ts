import { describe, expect, it } from 'vitest';
import { appendTrailers, parseTrailers } from '../src/trailers.js';

describe('trailers', () => {
  it('appends and parses back', () => {
    const body = appendTrailers('Thanks for the report.', {
      agentId: 'triage',
      agentVersion: '0.1.0',
      attestationId: '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      onBehalfOf: 'jakub',
    });
    expect(body).toContain('Custodes-Agent: triage@0.1.0');
    expect(parseTrailers(body)).toEqual({
      'Custodes-Agent': 'triage@0.1.0',
      'Custodes-Attestation': '9d7c1e9e-2b1a-4b6e-9a2e-1f7d1c2b3a44',
      'On-Behalf-Of': '@jakub',
    });
  });
});

// Regression for CodeQL js/polynomial-redos: hostile input must stay linear.
const fast = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('parseTrailers (hostile input)', () => {
  it('is linear on many unterminated comment openers', () => {
    expect(fast(() => parseTrailers('<!--\na'.repeat(50_000)))).toBeLessThan(200);
    expect(parseTrailers('<!--\na'.repeat(10))).toEqual({});
  });
});
