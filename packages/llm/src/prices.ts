import type { MessagesResponse } from './gateway.js';

/**
 * USD per million tokens, Anthropic first-party standard rates (checked 2026-11-25 against the
 * claude-api reference, cached 2026-11-03). Only the models the runtime may run (ADR 0023). A model
 * missing here has no price, and `costOf` refuses it: a run must never treat spend as zero.
 * Kept out of `models.ts`, which every eval suite depends on.
 */
export const PRICES_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
  // Up to 100K prompt tokens; above that $0.50 / $2.50. Runtime prompts stay far below.
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  // TODO(#140): OpenRouter and Workers AI models when the runtime is allowed to use them.
};

/** USD for one response of `model`. Throws for a model without a price. */
export function costOf(model: string, usage: MessagesResponse['usage']): number {
  const price = Object.hasOwn(PRICES_USD_PER_MTOK, model) ? PRICES_USD_PER_MTOK[model] : undefined;
  if (!price) throw new Error(`no price for model ${model}`);
  return (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1_000_000;
}
