import { z } from 'zod';

/**
 * One Jev vs Clef row (ADR 0015), as pr-gate serves it to the operator's CLI: ids, numbers and
 * short codes only. One definition for the agent that stores the rows and the CLI that reads them.
 */
export const ComparisonRow = z.object({
  id: z.number(),
  pr: z.number(),
  head_sha: z.string(),
  state_sha256: z.string(),
  question: z.string(),
  jev_model: z.string().nullable(),
  jev_p: z.number().nullable(),
  jev_choice: z.string().nullable(),
  jev_ms: z.number(),
  jev_tokens: z.number().nullable(),
  jev_error: z.string().nullable(),
  clef_model: z.string().nullable(),
  clef_p: z.number().nullable(),
  clef_choice: z.string().nullable(),
  clef_ms: z.number(),
  clef_tokens: z.number().nullable(),
  clef_error: z.string().nullable(),
  outcome: z.string().nullable(),
  human_verdict: z.string().nullable(),
  decided_at: z.string(),
});
export type ComparisonRow = z.infer<typeof ComparisonRow>;

/** The operator's answer to one question about one PR (ADR 0015). */
export const VerdictRequest = z
  .object({
    pr: z.number().int().positive().max(1_000_000),
    question: z.enum(['minor', 'approval']),
    answer: z.enum(['yes', 'no']),
  })
  .strict();
export type VerdictRequest = z.infer<typeof VerdictRequest>;
