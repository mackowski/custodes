/** Central place for model ids so upgrades are one-line changes reviewed in one PR. */
export const MODELS = {
  /** Cheap, fast: classification, labelling, summaries. */
  fast: 'claude-sonnet-5',
  /** Deep reasoning: PR review, security analysis. */
  reasoning: 'claude-opus-5-5',
  /**
   * TypeSafe Jev via OpenRouter's Decisions API: typed answers with probabilities, no text.
   * Pinned (not `~typesafe/jev-latest`) because callers' thresholds are tuned per version.
   */
  decision: 'typesafe/jev-1.14',
  /**
   * Cloudflare Clef on Workers AI, asked the same questions as `decision` but never deciding
   * (ADR 0015). Unversioned upstream, so every answer is stored with the model the response names.
   */
  decisionShadow: '@cf/cloudflare/clef',
} as const;
export type ModelTier = keyof typeof MODELS;
