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

/** How a review model is reached; every transport goes through the one AI Gateway (ADR 0015). */
export type ReviewTransport = 'anthropic' | 'openrouter' | 'workers-ai';

export interface ReviewModel {
  id: string;
  transport: ReviewTransport;
  /** Who trained it: the multi-model invariant counts vendors, not hosts (ADR 0017). */
  vendor: 'anthropic' | 'openai' | 'meta' | 'deepseek';
  /**
   * OpenRouter only: the upstream hosts allowed to serve it, with no fallback to others. For open
   * weights served by many hosts at different quantizations (ADR 0017).
   */
  hosts?: readonly string[];
}

/** Every model cheatsheet-review may call, primaries and fallbacks (ADR 0017). */
export const REVIEW_MODELS = {
  claudeHaiku: { id: 'claude-haiku-5-5', transport: 'anthropic', vendor: 'anthropic' },
  claudeSonnet: { id: 'claude-sonnet-5-5', transport: 'anthropic', vendor: 'anthropic' },
  claudeOpus: { id: 'claude-opus-5-5', transport: 'anthropic', vendor: 'anthropic' },
  gptLuna: { id: 'openai/gpt-6-luna', transport: 'openrouter', vendor: 'openai' },
  gptSol: { id: 'openai/gpt-6.1-sol', transport: 'openrouter', vendor: 'openai' },
  gptAstra: { id: 'openai/gpt-6-astra', transport: 'openrouter', vendor: 'openai' },
  gptOss20b: { id: '@cf/openai/gpt-oss-20b', transport: 'workers-ai', vendor: 'openai' },
  museSpark: { id: 'meta/muse-spark-1.3', transport: 'openrouter', vendor: 'meta' },
  deepseekFlash: {
    id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
    transport: 'workers-ai',
    vendor: 'deepseek',
  },
  /**
   * The same weights as `deepseekFlash`, for when Workers AI fails. Many OpenRouter hosts serve it
   * at fp4; these endpoints serve it at fp8. `data_collection: deny` still applies on top.
   */
  deepseekFlashOpenRouter: {
    id: 'deepseek/deepseek-v4.1-flash-1017',
    transport: 'openrouter',
    vendor: 'deepseek',
    hosts: ['nebius/fp8', 'parasail/fp8', 'crusoe/fp8'],
  },
} as const satisfies Record<string, ReviewModel>;
export type ReviewModelName = keyof typeof REVIEW_MODELS;
