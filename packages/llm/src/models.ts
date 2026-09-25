/** Central place for model ids so upgrades are one-line changes reviewed in one PR. */
export const MODELS = {
  /** Cheap, fast: classification, labelling, summaries. */
  fast: 'claude-sonnet-5',
  /** Deep reasoning: PR review, security analysis. */
  reasoning: 'claude-opus-5-5',
} as const;
export type ModelTier = keyof typeof MODELS;
