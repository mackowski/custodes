import type { MessagesResponse } from './gateway.js';

/**
 * USD per million tokens, Anthropic first-party standard rates (checked 2026-11-25 against the
 * claude-api reference, cached 2026-11-03). Only the model the runtime runs today (ADR 0023: #132
 * v1 uses Claude Sonnet 5.5); add a row with the model that needs it. A model missing here has no
 * price, and `costOf` refuses it: a run must never treat spend as zero. Kept out of `models.ts`,
 * which every eval suite depends on.
 */
export const PRICES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

/** USD for one response of `model`. Throws for a model without a price. */
export function costOf(model: string, usage: MessagesResponse['usage']): number {
  const price = Object.hasOwn(PRICES_USD_PER_MTOK, model) ? PRICES_USD_PER_MTOK[model] : undefined;
  if (!price) throw new Error(`no price for model ${model}`);
  const cost = (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000;
  // The gateway does not validate `usage`: a missing count is NaN, and `NaN >= cap` is false.
  if (!Number.isFinite(cost) || cost < 0) throw new Error('response usage is not a token count');
  return cost;
}
