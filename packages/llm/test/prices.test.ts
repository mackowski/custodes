import { describe, expect, it } from 'vitest';
import { costOf, PRICES_USD_PER_MTOK } from '../src/prices.js';

describe('costOf', () => {
  it('prices input and output tokens per million', () => {
    expect(costOf('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 100_000 })).toBe(
      3,
    );
    expect(costOf('claude-opus-5-5', { input_tokens: 10_000, output_tokens: 1_000 })).toBeCloseTo(
      0.06,
    );
  });
  it('refuses a model without a price instead of counting it as free', () => {
    expect(() => costOf('openai/gpt-6-luna', { input_tokens: 1, output_tokens: 1 })).toThrow(
      /no price/,
    );
    expect(() => costOf('constructor', { input_tokens: 1, output_tokens: 1 })).toThrow(/no price/);
  });
  it('has a price for every Anthropic model in it', () => {
    for (const p of Object.values(PRICES_USD_PER_MTOK)) {
      expect(p.input).toBeGreaterThan(0);
      expect(p.output).toBeGreaterThan(p.input);
    }
  });
});
